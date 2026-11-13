"use strict";

// Sanitized description of a WhatsApp webhook event that failed during processing. It produces only an HTTP status and an ALLOWLISTED error code. It never
// returns the exception message, stack, payload, customer or provider identifiers, URLs, headers or credentials: anything not on the allowlist becomes
// "unclassified".

// Transport-level codes (Node / axios) and database codes (PostgreSQL SQLSTATE and PostgREST) that are safe and useful for diagnosis.
const ALLOWED_ERROR_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
  "ERR_NETWORK", "ERR_BAD_RESPONSE", "ERR_BAD_REQUEST", "ERR_CANCELED", "ERR_FR_TOO_MANY_REDIRECTS",
  "23505", "23503", "23502", "23514", "22P02", "22001", "42P10", "42501", "42703", "42P01", "40001", "57014", "53300", "08006",
  "PGRST116", "PGRST204", "PGRST205", "PGRST301",
]);
const EVENT_KINDS = new Set(["message", "status"]);

function processingFailureFields(error) {
  const status = Number(error?.response?.status ?? error?.statusCode);
  const candidates = [error?.response?.data?.code, error?.code].map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : ""));
  const code = candidates.find((c) => ALLOWED_ERROR_CODES.has(c));
  return { http_status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null, error_code: code || "unclassified" };
}

// The correlation id may come from an incoming x-request-id header (http.js), so only a safe shape is logged.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
function safeRequestId(requestId) {
  return typeof requestId === "string" && SAFE_REQUEST_ID.test(requestId) ? requestId : "invalid";
}

// The complete log record for one failed event: correlation id, event kind, HTTP status, allowlisted error code. Nothing else.
function eventFailureLogFields({ requestId, event, error }) {
  return { request_id: safeRequestId(requestId), kind: EVENT_KINDS.has(event?.kind) ? event.kind : "unknown", ...processingFailureFields(error) };
}

module.exports = { ALLOWED_ERROR_CODES, processingFailureFields, eventFailureLogFields, safeRequestId };
