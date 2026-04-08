const crypto = require("node:crypto");
const http = require("node:http");

const {
  matchRoute,
  parseUrl,
  readJson,
  requestJson,
  sendJson
} = require("./http");
const {
  createChildTraceparent,
  extractOrCreateTraceparent
} = require("./trace");

const serviceName = process.env.SERVICE_NAME || "transfers-api";
const port = Number(process.env.PORT || 8080);
const accountsApiUrl =
  process.env.ACCOUNTS_API_URL ||
  "http://accounts-api.postman-api-graph.svc.cluster.local:8081";

const state = {
  transfers: [
    {
      id: "tx-seed-001",
      fromAccountId: "acct-checking-001",
      toAccountId: "acct-savings-002",
      amount: 75.5,
      currency: "USD",
      reference: "seed-transfer",
      status: "completed",
      createdAt: "2026-04-07T00:00:00.000Z",
      completedAt: "2026-04-07T00:00:01.000Z",
      holdId: "hold-seed-001",
      ledgerEntryId: "entry-seed-001"
    }
  ]
};

function log(message, metadata = {}) {
  console.log(
    JSON.stringify({
      service: serviceName,
      message,
      ...metadata
    })
  );
}

function getTransferById(transferId) {
  return state.transfers.find((transfer) => transfer.id === transferId);
}

function listTransfers(searchParams) {
  const status = searchParams.get("status");
  const limit = Number(searchParams.get("limit") || 20);
  const filteredTransfers = status
    ? state.transfers.filter((transfer) => transfer.status === status)
    : state.transfers;

  return {
    data: filteredTransfers.slice(0, limit),
    meta: {
      total: filteredTransfers.length,
      limit,
      offset: 0
    }
  };
}

function validateTransferRequest(payload) {
  const requiredFields = ["fromAccountId", "toAccountId", "amount", "currency"];
  const missingField = requiredFields.find((field) => payload[field] === undefined || payload[field] === "");

  if (missingField) {
    return `Missing required field: ${missingField}`;
  }

  if (Number(payload.amount) <= 0) {
    return "amount must be greater than 0";
  }

  return null;
}

async function authorizeTransfer(traceparent, payload) {
  const transferId = crypto.randomUUID();
  const accountUrl = `${accountsApiUrl}/accounts/${encodeURIComponent(
    payload.fromAccountId
  )}/debits/authorize`;

  const response = await requestJson(accountUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      traceparent: createChildTraceparent(traceparent)
    },
    body: JSON.stringify({
      transferId,
      amount: Number(payload.amount),
      currency: payload.currency,
      beneficiaryAccountId: payload.toAccountId,
      reference: payload.reference || ""
    })
  });

  if (!response.ok) {
    const error = new Error("accounts-api authorization failed");
    error.statusCode = 502;
    error.details = response.data;
    throw error;
  }

  const now = new Date().toISOString();
  const transfer = {
    id: transferId,
    fromAccountId: payload.fromAccountId,
    toAccountId: payload.toAccountId,
    amount: Number(payload.amount),
    currency: payload.currency,
    reference: payload.reference || "",
    status: "completed",
    createdAt: now,
    completedAt: now,
    holdId: response.data?.holdId || "",
    ledgerEntryId: response.data?.ledgerEntryId || "",
    authorization: response.data || {}
  };

  state.transfers.unshift(transfer);
  return transfer;
}

async function cancelTransfer(traceparent, transfer) {
  const releaseUrl = `${accountsApiUrl}/accounts/${encodeURIComponent(
    transfer.fromAccountId
  )}/debits/release`;

  const response = await requestJson(releaseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      traceparent: createChildTraceparent(traceparent)
    },
    body: JSON.stringify({
      transferId: transfer.id,
      holdId: transfer.holdId,
      amount: transfer.amount,
      currency: transfer.currency
    })
  });

  if (!response.ok) {
    const error = new Error("accounts-api release failed");
    error.statusCode = 502;
    error.details = response.data;
    throw error;
  }

  transfer.status = "cancelled";
  transfer.completedAt = new Date().toISOString();
  transfer.release = response.data || {};

  return transfer;
}

const server = http.createServer(async (req, res) => {
  const traceparent = extractOrCreateTraceparent(req.headers);
  res.setHeader("traceparent", traceparent);

  try {
    const url = parseUrl(req);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, {
        status: "ok",
        service: serviceName,
        workspaceId: process.env.POSTMAN_INSIGHTS_WORKSPACE_ID || "",
        systemEnv: process.env.POSTMAN_INSIGHTS_SYSTEM_ENV || "",
        downstreams: {
          accountsApiUrl
        }
      });
      return;
    }

    if (req.method === "GET" && pathname === "/transfers") {
      sendJson(res, 200, listTransfers(url.searchParams));
      return;
    }

    if (req.method === "POST" && pathname === "/transfers") {
      const payload = await readJson(req);
      const validationError = validateTransferRequest(payload);

      if (validationError) {
        sendJson(res, 400, {
          error: "validation_error",
          message: validationError,
          statusCode: 400
        });
        return;
      }

      const transfer = await authorizeTransfer(traceparent, payload);
      log("transfer_authorized", {
        traceparent,
        transferId: transfer.id,
        downstream: "accounts-api"
      });
      sendJson(res, 201, transfer);
      return;
    }

    const transferMatch = matchRoute(pathname, "/transfers/:transferId");
    if (transferMatch && req.method === "GET") {
      const transfer = getTransferById(transferMatch.transferId);

      if (!transfer) {
        sendJson(res, 404, {
          error: "not_found",
          message: `Transfer ${transferMatch.transferId} was not found`,
          statusCode: 404
        });
        return;
      }

      sendJson(res, 200, transfer);
      return;
    }

    const cancelMatch = matchRoute(pathname, "/transfers/:transferId/cancel");
    if (cancelMatch && req.method === "POST") {
      const transfer = getTransferById(cancelMatch.transferId);

      if (!transfer) {
        sendJson(res, 404, {
          error: "not_found",
          message: `Transfer ${cancelMatch.transferId} was not found`,
          statusCode: 404
        });
        return;
      }

      if (transfer.status === "cancelled") {
        sendJson(res, 409, {
          error: "conflict",
          message: `Transfer ${cancelMatch.transferId} is already cancelled`,
          statusCode: 409
        });
        return;
      }

      const updatedTransfer = await cancelTransfer(traceparent, transfer);
      log("transfer_cancelled", {
        traceparent,
        transferId: updatedTransfer.id,
        downstream: "accounts-api"
      });
      sendJson(res, 200, updatedTransfer);
      return;
    }

    sendJson(res, 404, {
      error: "not_found",
      message: `No route for ${req.method} ${pathname}`,
      statusCode: 404
    });
  } catch (error) {
    log("request_failed", {
      traceparent,
      error: error.message,
      details: error.details || null
    });
    sendJson(res, error.statusCode || 500, {
      error: "internal_error",
      message: error.message,
      details: error.details || null,
      statusCode: error.statusCode || 500
    });
  }
});

server.listen(port, () => {
  log("service_started", {
    port,
    accountsApiUrl
  });
});
