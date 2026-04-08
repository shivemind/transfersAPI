const crypto = require("node:crypto");

const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function parseTraceparent(value) {
  const normalized = String(value || "").trim();
  const match = TRACEPARENT_PATTERN.exec(normalized);

  if (!match) {
    return null;
  }

  return {
    version: match[1].toLowerCase(),
    traceId: match[2].toLowerCase(),
    parentId: match[3].toLowerCase(),
    flags: match[4].toLowerCase()
  };
}

function createRootTraceparent() {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

function extractOrCreateTraceparent(headers = {}) {
  const traceparent = headers.traceparent || headers.Traceparent || "";
  return parseTraceparent(traceparent) ? traceparent : createRootTraceparent();
}

function createChildTraceparent(traceparent) {
  const parsed = parseTraceparent(traceparent);
  if (!parsed) {
    return createRootTraceparent();
  }

  return `${parsed.version}-${parsed.traceId}-${randomHex(8)}-${parsed.flags}`;
}

module.exports = {
  createChildTraceparent,
  createRootTraceparent,
  extractOrCreateTraceparent,
  parseTraceparent
};
