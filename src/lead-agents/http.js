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
  const allowAll = allowedOrigins.length === 0;
  const allowOrigin = sameHost
    ? requestOrigin
    : allowAll
    ? requestOrigin || "*"
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
  res.setHeader("access-control-allow-credentials", "true");
  return true;
}

function createRequestContext(req) {
  return {
    requestId: req.headers["x-request-id"] || crypto.randomUUID(),
    startedAtMs: Date.now(),
  };
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
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

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    err.statusCode = 400;
    err.message = "Invalid JSON body";
    throw err;
  }
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
  createRequestContext,
  getPathname,
  json,
  methodNotAllowed,
  notFound,
  readJsonBody,
  serveFile,
  serveBuffer,
  setCorsHeaders,
};
