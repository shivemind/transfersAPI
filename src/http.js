const { URL } = require("node:url");

function jsonHeaders(extraHeaders = {}) {
  return {
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders
  };
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, jsonHeaders(extraHeaders));
  res.end(body);
}

async function readJson(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const rawBody = await response.text();

  let data = null;
  if (rawBody) {
    try {
      data = JSON.parse(rawBody);
    } catch (_error) {
      data = { rawBody };
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
    headers: Object.fromEntries(response.headers.entries())
  };
}

function normalizePathname(pathname) {
  if (!pathname || pathname === "/") {
    return "/";
  }

  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function matchRoute(pathname, template) {
  const actual = normalizePathname(pathname).split("/").filter(Boolean);
  const expected = normalizePathname(template).split("/").filter(Boolean);

  if (actual.length !== expected.length) {
    return null;
  }

  const params = {};
  for (let index = 0; index < expected.length; index += 1) {
    const currentTemplatePart = expected[index];
    const currentPathPart = actual[index];

    if (currentTemplatePart.startsWith(":")) {
      params[currentTemplatePart.slice(1)] = decodeURIComponent(currentPathPart);
      continue;
    }

    if (currentTemplatePart !== currentPathPart) {
      return null;
    }
  }

  return params;
}

function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host || "localhost"}`);
}

module.exports = {
  matchRoute,
  normalizePathname,
  parseUrl,
  readJson,
  requestJson,
  sendJson
};
