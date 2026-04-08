#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }

    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

function toYamlScalar(value) {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  const normalized = String(value ?? "");
  if (!normalized) {
    return "\"\"";
  }

  return JSON.stringify(normalized);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readWorkspaceIdFromResources(rootDirectory) {
  const resourcesPath = path.join(rootDirectory, ".postman", "resources.yaml");
  if (!fs.existsSync(resourcesPath)) {
    return "";
  }

  const contents = fs.readFileSync(resourcesPath, "utf8");
  const match = contents.match(/^workspace:\s*\n\s*id:\s*([^\n]+)$/m);
  return match ? match[1].trim() : "";
}

function ensureDirectory(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function buildEnvironmentYaml(envEntries) {
  if (envEntries.length === 0) {
    return "";
  }

  return envEntries
    .map(
      ([key, value]) =>
        `            - name: ${key}\n              value: ${JSON.stringify(String(value ?? ""))}`
    )
    .join("\n");
}

function buildServiceManifest({ serviceName, namespace, port, image, envEntries }) {
  const environmentBlock = buildEnvironmentYaml(envEntries);

  return `apiVersion: v1
kind: Service
metadata:
  name: ${serviceName}
  namespace: ${namespace}
spec:
  selector:
    app: ${serviceName}
  ports:
    - name: http
      port: ${port}
      targetPort: ${port}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${serviceName}
  namespace: ${namespace}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${serviceName}
  template:
    metadata:
      labels:
        app: ${serviceName}
    spec:
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      containers:
        - name: app
          image: ${image}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: ${port}
              hostPort: ${port}
          env:
${environmentBlock}
          readinessProbe:
            httpGet:
              path: /health
              port: ${port}
            initialDelaySeconds: 3
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: ${port}
            initialDelaySeconds: 10
            periodSeconds: 10
          resources:
            requests:
              cpu: 50m
              memory: 96Mi
            limits:
              cpu: 250m
              memory: 256Mi
`;
}

function buildTrafficScript(targetUrl, traffic) {
  const requestsPerRun = Number(traffic.requests_per_run || 20);
  const encodedBody = traffic.body ? JSON.stringify(traffic.body).replace(/'/g, "'\"'\"'") : "";
  const method = (traffic.method || "GET").toUpperCase();

  const lines = [
    `TARGET_URL='${targetUrl}'`,
    `REQUESTS_PER_RUN='${requestsPerRun}'`,
    "for i in $(seq 1 \"$REQUESTS_PER_RUN\"); do",
    "  TRACE_ID=$(cat /dev/urandom | tr -dc 'a-f0-9' | head -c 32)",
    "  SPAN_ID=$(cat /dev/urandom | tr -dc 'a-f0-9' | head -c 16)",
    "  TRACEPARENT=\"00-${TRACE_ID}-${SPAN_ID}-01\""
  ];

  if (method === "POST") {
    lines.push(
      "  wget -q -O /dev/null \\",
      "    --header=\"Content-Type: application/json\" \\",
      "    --header=\"traceparent: ${TRACEPARENT}\" \\",
      `    --post-data='${encodedBody}' \\`,
      "    \"$TARGET_URL\""
    );
  } else {
    lines.push(
      "  wget -q -O /dev/null \\",
      "    --header=\"traceparent: ${TRACEPARENT}\" \\",
      "    \"$TARGET_URL\""
    );
  }

  lines.push("done");
  return lines.map((line) => `                  ${line}`).join("\n");
}

function buildTrafficManifest({ serviceName, namespace, port, traffic }) {
  const pathSuffix = traffic.path || "/health";
  const schedule = traffic.schedule || "*/2 * * * *";
  const targetUrl = `http://${serviceName}.${namespace}.svc.cluster.local:${port}${pathSuffix}`;
  const script = buildTrafficScript(targetUrl, traffic);

  return `apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${serviceName}-graph-traffic
  namespace: ${namespace}
spec:
  schedule: ${toYamlScalar(schedule)}
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: traffic
              image: busybox:1.36
              command:
                - /bin/sh
                - -c
                - |
${script}
`;
}

function buildAgentManifest({ namespace, clusterName, workspaceId, systemEnv }) {
  const optionalAgentEnv = [];
  if (workspaceId) {
    optionalAgentEnv.push(
      `            - name: POSTMAN_INSIGHTS_WORKSPACE_ID\n              value: ${toYamlScalar(workspaceId)}`
    );
  }

  if (systemEnv) {
    optionalAgentEnv.push(
      `            - name: POSTMAN_INSIGHTS_SYSTEM_ENV\n              value: ${toYamlScalar(systemEnv)}`
    );
  }

  const optionalEnvBlock = optionalAgentEnv.length > 0 ? `\n${optionalAgentEnv.join("\n")}` : "";

  return `apiVersion: v1
kind: Namespace
metadata:
  name: postman-insights-namespace
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: postman-insights-agent
  namespace: postman-insights-namespace
spec:
  selector:
    matchLabels:
      app: postman-insights-agent
  template:
    metadata:
      labels:
        app: postman-insights-agent
        name: postman-insights-agent
    spec:
      hostNetwork: true
      hostPID: true
      dnsPolicy: ClusterFirstWithHostNet
      tolerations:
        - operator: Exists
          effect: NoSchedule
      containers:
        - name: agent
          image: public.ecr.aws/postman/postman-insights-agent:latest
          args:
            - kube
            - run
            - --discovery-mode
            - --repro-mode
            - --debug
            - --include-namespaces=${namespace}
          env:
            - name: POSTMAN_INSIGHTS_CLUSTER_NAME
              value: ${toYamlScalar(clusterName)}
            - name: POSTMAN_INSIGHTS_API_KEY
              valueFrom:
                secretKeyRef:
                  name: postman-agent-secrets
                  key: postman-api-key${optionalEnvBlock}
            - name: POSTMAN_INSIGHTS_K8S_NODE
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: POSTMAN_INSIGHTS_CRI_ENDPOINT
              value: /var/run/containerd/containerd.sock
          securityContext:
            privileged: false
            capabilities:
              add:
                - NET_RAW
                - SYS_ADMIN
                - SYS_PTRACE
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 1Gi
          volumeMounts:
            - name: proc
              mountPath: /host/proc
              readOnly: true
            - name: netns
              mountPath: /host/var/run/netns
              readOnly: true
      volumes:
        - name: proc
          hostPath:
            path: /proc
        - name: netns
          hostPath:
            path: /var/run/netns
`;
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(repoRoot, args.manifest || "postman-services.json");
const manifest = readJson(manifestPath);
const service =
  manifest.services.find((entry) => entry.service_key === args.service) || manifest.services[0];

if (!service) {
  throw new Error(`No services found in ${manifestPath}`);
}

const graph = service.graph || {};
const namespace = args.namespace || graph.namespace || "postman-api-graph";
const clusterName = args["cluster-name"] || graph.cluster_name || service.cluster_name || "postman-api-graph-k3d";
const port = Number(args.port || graph.port || 8080);
const image = args.image || graph.image || `${service.service_key}:dev`;
const workspaceId =
  args["workspace-id"] || service.workspace_id || readWorkspaceIdFromResources(repoRoot);
const systemEnvMap = args["system-env-map"]
  ? JSON.parse(args["system-env-map"])
  : service.system_env_map || {};
const systemEnv = args["system-env"] || systemEnvMap.prod || systemEnvMap.stage || "";
const outputDirectory = path.resolve(repoRoot, args["output-dir"] || path.join("k8s", "rendered"));
const includeAgent =
  String(args["include-agent"] || graph.insights_agent_owner || "false").toLowerCase() === "true";
const traffic = graph.traffic_generator || null;

ensureDirectory(outputDirectory);

const envEntries = [
  ["PORT", port],
  ["SERVICE_NAME", service.service_key],
  ...Object.entries(graph.env || {})
];

if (workspaceId) {
  envEntries.push(["POSTMAN_INSIGHTS_WORKSPACE_ID", workspaceId]);
}

if (systemEnv) {
  envEntries.push(["POSTMAN_INSIGHTS_SYSTEM_ENV", systemEnv]);
}

const outputs = [];

const serviceManifestPath = path.join(outputDirectory, `${service.service_key}.service.yaml`);
fs.writeFileSync(
  serviceManifestPath,
  buildServiceManifest({
    serviceName: service.service_key,
    namespace,
    port,
    image,
    envEntries
  })
);
outputs.push(serviceManifestPath);

if (traffic?.enabled) {
  const trafficManifestPath = path.join(outputDirectory, `${service.service_key}.traffic.yaml`);
  fs.writeFileSync(
    trafficManifestPath,
    buildTrafficManifest({
      serviceName: service.service_key,
      namespace,
      port,
      traffic
    })
  );
  outputs.push(trafficManifestPath);
}

if (includeAgent) {
  const agentManifestPath = path.join(outputDirectory, "postman-insights-agent.yaml");
  fs.writeFileSync(
    agentManifestPath,
    buildAgentManifest({
      namespace,
      clusterName,
      workspaceId,
      systemEnv
    })
  );
  outputs.push(agentManifestPath);
}

const summaryPath = path.join(outputDirectory, `${service.service_key}.runtime-summary.json`);
fs.writeFileSync(
  summaryPath,
  JSON.stringify(
    {
      service_key: service.service_key,
      namespace,
      port,
      image,
      workspace_id: workspaceId,
      system_env: systemEnv,
      outputs
    },
    null,
    2
  )
);
outputs.push(summaryPath);

console.log(
  JSON.stringify(
    {
      service_key: service.service_key,
      outputs
    },
    null,
    2
  )
);
