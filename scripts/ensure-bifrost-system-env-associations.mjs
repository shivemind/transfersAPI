#!/usr/bin/env node

import fs from "node:fs";

const BIFROST_BASE = "https://bifrost-premium-https-v4.gw.postman.com/ws/proxy";

function readRequiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readJsonEnv(name, fallback) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Unable to parse ${name} as JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  fs.appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
}

function dedupeStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function normalizeWorkspaceEntries(workspaces) {
  const merged = new Map();

  for (const workspace of workspaces) {
    const workspaceId = String(workspace?.workspaceId || "").trim();
    if (!workspaceId) {
      continue;
    }

    const envIds = dedupeStrings(
      (workspace?.associations || []).map((association) =>
        String(association?.postmanEnvironmentId || "")
      )
    );

    if (envIds.length === 0) {
      continue;
    }

    merged.set(workspaceId, dedupeStrings([...(merged.get(workspaceId) || []), ...envIds]));
  }

  return Array.from(merged.entries()).map(([workspaceId, postmanEnvironmentIds]) => ({
    workspaceId,
    postmanEnvironmentIds
  }));
}

function replaceWorkspaceEntry(existingEntries, workspaceId, nextEnvUids) {
  const normalizedWorkspaceId = String(workspaceId || "").trim();
  const normalizedEnvUids = dedupeStrings(nextEnvUids);
  const result = [];
  let replaced = false;

  for (const entry of existingEntries) {
    if (entry.workspaceId !== normalizedWorkspaceId) {
      result.push({
        workspaceId: entry.workspaceId,
        postmanEnvironmentIds: dedupeStrings(entry.postmanEnvironmentIds || [])
      });
      continue;
    }

    replaced = true;
    if (normalizedEnvUids.length > 0) {
      result.push({
        workspaceId: normalizedWorkspaceId,
        postmanEnvironmentIds: normalizedEnvUids
      });
    }
  }

  if (!replaced && normalizedEnvUids.length > 0) {
    result.push({
      workspaceId: normalizedWorkspaceId,
      postmanEnvironmentIds: normalizedEnvUids
    });
  }

  return result;
}

function bifrostHeaders(accessToken, teamId) {
  const headers = {
    "Content-Type": "application/json",
    "x-access-token": accessToken
  };

  if (teamId) {
    headers["x-entity-team-id"] = teamId;
  }

  return headers;
}

async function bifrostRequest(payload, accessToken, teamId) {
  const response = await fetch(BIFROST_BASE, {
    method: "POST",
    headers: bifrostHeaders(accessToken, teamId),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw new Error(
      `Bifrost request failed (${response.status}): ${responseText || response.statusText || "Unknown error"}`
    );
  }

  return response.json();
}

async function getSystemEnvAssociations(systemEnvironmentId, accessToken, teamId) {
  const payload = {
    service: "api-catalog",
    method: "GET",
    path: "/api/system-envs/associations",
    query: { systemEnvironmentId },
    body: {}
  };

  const response = await bifrostRequest(payload, accessToken, teamId);
  return normalizeWorkspaceEntries(response?.data?.workspaces || []);
}

async function putSystemEnvAssociations(systemEnvironmentId, workspaceEntries, accessToken, teamId) {
  const payload = {
    service: "api-catalog",
    method: "PUT",
    path: "/api/system-envs/associations",
    body: {
      systemEnvironmentId,
      workspaceEntries
    }
  };

  await bifrostRequest(payload, accessToken, teamId);
}

async function associateSystemEnvironmentBatch(workspaceId, associations, accessToken, teamId) {
  const grouped = new Map();

  for (const association of associations) {
    const systemEnvId = String(association.systemEnvId || "").trim();
    const envUid = String(association.envUid || "").trim();
    if (!systemEnvId || !envUid) {
      continue;
    }
    grouped.set(systemEnvId, [...(grouped.get(systemEnvId) || []), envUid]);
  }

  for (const [systemEnvId, envUids] of grouped.entries()) {
    const existing = await getSystemEnvAssociations(systemEnvId, accessToken, teamId);
    const currentEnvUids =
      existing.find((entry) => entry.workspaceId === workspaceId)?.postmanEnvironmentIds || [];
    const merged = replaceWorkspaceEntry(existing, workspaceId, [...currentEnvUids, ...envUids]);

    try {
      await putSystemEnvAssociations(systemEnvId, merged, accessToken, teamId);
    } catch {
      const fresh = replaceWorkspaceEntry([], workspaceId, envUids);
      await putSystemEnvAssociations(systemEnvId, fresh, accessToken, teamId);
    }
  }
}

async function main() {
  const workspaceId = readRequiredEnv("WORKSPACE_ID");
  const accessToken = readRequiredEnv("POSTMAN_ACCESS_TOKEN");
  const teamId = readRequiredEnv("POSTMAN_TEAM_ID");
  const environmentUids = readJsonEnv("ENVIRONMENT_UIDS_JSON", {});
  const systemEnvMap = readJsonEnv("SYSTEM_ENV_MAP_JSON", {});

  const mappedEnvironmentNames = Object.keys(systemEnvMap).filter((name) =>
    String(systemEnvMap[name] || "").trim()
  );

  if (mappedEnvironmentNames.length === 0) {
    console.log("No system environment mappings configured. Skipping explicit Bifrost association.");
    setOutput("status", "skipped");
    setOutput("association-count", "0");
    return;
  }

  const missingEnvironmentUids = mappedEnvironmentNames.filter(
    (name) => !String(environmentUids[name] || "").trim()
  );

  if (missingEnvironmentUids.length > 0) {
    throw new Error(
      `Missing Postman environment IDs for mapped environments: ${missingEnvironmentUids.join(", ")}`
    );
  }

  const associations = mappedEnvironmentNames.map((name) => ({
    envName: name,
    envUid: String(environmentUids[name]).trim(),
    systemEnvId: String(systemEnvMap[name]).trim()
  }));

  await associateSystemEnvironmentBatch(workspaceId, associations, accessToken, teamId);

  const summary = {
    workspaceId,
    teamId,
    associations: associations.map(({ envName, envUid, systemEnvId }) => ({
      envName,
      envUid,
      systemEnvId
    }))
  };

  console.log(`Associated ${associations.length} Postman environment(s) to system environment(s) through Bifrost.`);
  console.log(JSON.stringify(summary, null, 2));

  setOutput("status", "success");
  setOutput("association-count", String(associations.length));
  setOutput("summary-json", JSON.stringify(summary));
}

main().catch((error) => {
  setOutput("status", "failed");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
