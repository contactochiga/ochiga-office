const { URL } = require("url");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

function json(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

// R8: what may leave the process. Intentional client errors (4xx) keep their message. Server-side failures (no status, 5xx) are reduced to a stable code: unexpected exceptions and failures of
// the data store/gateway must never put driver text, hostnames, ports or SQL in a response (the full error is in the log under the same request_id).
function externalErrorBody(err, requestId) {
  const status = Number.isInteger(err?.statusCode) ? err.statusCode : 0;
  if (status >= 400 && status < 500) return { statusCode: status, body: { error: String(err.message || "bad_request").slice(0, 300), request_id: requestId } };
  const upstream = Boolean(err?.isAxiosError || err?.response || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"].includes(err?.code) || /socket hang up|Request failed with status code/i.test(String(err?.message)));
  if (status >= 500 && /^[a-z][a-z0-9_]{2,63}$/.test(String(err.message))) return { statusCode: status, body: { error: err.message, request_id: requestId } }; // an intentional code such as session_verification_unavailable
  if (upstream) return { statusCode: 503, body: { error: "service_unavailable", request_id: requestId } };
  return { statusCode: status >= 500 ? status : 500, body: { error: "internal_server_error", request_id: requestId } };
}

function notFound(res) {
  json(res, 404, { error: "not_found" });
}

function methodNotAllowed(res, allow) {
  json(
    res,
    405,
    { error: "method_not_allowed" },
    {
      allow,
    }
  );
}

function setCorsHeaders(req, res, allowedOrigins) {
  const requestOrigin = req.headers.origin;
  if (!requestOrigin) {
    return true;
  }
  let sameHost = false;
  try {
    sameHost = new URL(requestOrigin).host === String(req.headers.host || "");
  } catch {
    sameHost = false;
  }
  // R8: with NO allow-list a foreign origin is never given credentialed access. It may still call public, unauthenticated endpoints (the chat widget) through a wildcard that
  // browsers refuse to combine with cookies; only the same host or an explicitly approved origin receives access-control-allow-credentials.
  const allowAll = allowedOrigins.length === 0;
  const allowOrigin = sameHost
    ? requestOrigin
    : allowAll
    ? "*"
    : allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : "";

  if (!allowOrigin) {
    return false;
  }

  res.setHeader("access-control-allow-origin", allowOrigin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "authorization,content-type,x-api-key,x-request-id"
  );
  if (allowOrigin !== "*") res.setHeader("access-control-allow-credentials", "true");
  return true;
}

function createRequestContext(req) {
  return {
    requestId: req.headers["x-request-id"] || crypto.randomUUID(),
    startedAtMs: Date.now(),
  };
}

// Exact request bytes (never decoded or re-serialised) -- what signature verification must hash.
async function readRawBodyBuffer(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readRawBody(req, maxBytes = 1024 * 1024) {
  return (await readRawBodyBuffer(req, maxBytes)).toString("utf8");
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const raw = await readRawBody(req, maxBytes);
  if (!raw) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    err.statusCode = 400;
    err.message = "Invalid JSON body";
    throw err;
  }
  // R8: a body that is JSON null or a bare scalar is not an object any handler can use; refuse it here instead of letting a property read throw (a 500 with internal detail).
  if (parsed === null || (typeof parsed !== "object")) {
    const error = new Error("Invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

// Signature-verified webhooks (Meta) need the EXACT raw bytes to HMAC --
// re-serializing a parsed object would not reproduce the same signature.
async function readJsonBodyWithRaw(req, maxBytes = 1024 * 1024) {
  const raw = await readRawBody(req, maxBytes);
  let json = {};
  if (raw) {
    try {
      json = JSON.parse(raw);
    } catch (err) {
      err.statusCode = 400;
      err.message = "Invalid JSON body";
      throw err;
    }
  }
  return { raw, json };
}

function getPathname(req) {
  return new URL(req.url, "http://localhost").pathname;
}

function contentTypeForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".gltf":
      return "model/gltf+json; charset=utf-8";
    case ".glb":
      return "model/gltf-binary";
    case ".bin":
      return "application/octet-stream";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

async function serveFile(res, filePath) {
  const body = await fs.readFile(filePath);
  res.writeHead(200, {
    "content-type": contentTypeForFile(filePath),
    "cache-control": "no-cache",
  });
  res.end(body);
}

// Same response shape as serveFile, for bytes that didn't come from a
// local path (e.g. storageService.getObject() reading from Supabase
// Storage) — falls back to extension-based detection via
// contentTypeForFile when the source didn't supply a content-type
// (the local-disk storage driver doesn't track one separately).
function serveBuffer(res, buffer, contentType, filenameForTypeGuess) {
  res.writeHead(200, {
    "content-type": contentType || contentTypeForFile(filenameForTypeGuess || ""),
    "cache-control": "no-cache",
  });
  res.end(buffer);
}

module.exports = {
  externalErrorBody,
  createRequestContext,
  getPathname,
  json,
  methodNotAllowed,
  notFound,
  readJsonBody,
  readJsonBodyWithRaw,
  readRawBodyBuffer,
  serveFile,
  serveBuffer,
  setCorsHeaders,
};
