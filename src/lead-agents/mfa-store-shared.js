"use strict";

// Settings S7.5.1: pieces shared by the file and Supabase MFA store contracts. Contract: docs/settings-domain/28_S7_5_1_MFA_DATA_FOUNDATION_CONTRACT.md
// Nothing here interprets a credential: secrets are opaque ciphertext/hashes/challenges. Errors carry a CODE (and an HTTP status) only; never a request body, a value, or a key.

const CHALLENGE_PURPOSES = Object.freeze(["webauthn_register", "webauthn_authenticate"]);
const CREDENTIAL_TYPES = Object.freeze(["totp", "webauthn"]);
const MAX_CHALLENGE_TTL_SECONDS = 900;
const MAX_RECOVERY_CODES = 20;

/** Failure counter -> lock duration in ms (progressive, time-limited, never permanent). */
function lockDurationMs(attempts) {
  if (attempts >= 20) return 60 * 60_000;
  if (attempts >= 10) return 15 * 60_000;
  if (attempts >= 5) return 60_000;
  return 0;
}

function mfaError(code, extra = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/** Turns any transport/database failure into a code-only error. The original error (which can carry the request body) is dropped on purpose. */
function sanitizeStoreError(error, operation) {
  const status = Number(error?.response?.status) || 0;
  const pg = String(error?.response?.data?.code || "");
  let code = "mfa_store_error";
  if (error && typeof error.code === "string" && error.code.startsWith("mfa_")) code = error.code;
  else if (status === 404 && (pg === "PGRST202" || pg === "PGRST205" || pg === "42P01")) code = "mfa_unavailable";
  else if (status === 409 || pg === "23505" || pg === "23503") code = "mfa_conflict";
  else if (status === 400 && (pg === "22P02" || pg === "23514" || pg === "22023")) code = "mfa_invalid_input";
  else if (!status) code = "mfa_store_unreachable";
  return mfaError(code, { operation, ...(status ? { status } : {}) });
}

/** Listing shape: everything a UI/audit needs and NOTHING secret (no ciphertext, nonce, key id, public key or credential id). */
function sanitizeCredential(row) {
  if (!row) return null;
  return {
    id: row.id, admin_user_id: row.admin_user_id, type: row.type, label: row.label, status: row.status,
    created_at: row.created_at, activated_at: row.activated_at || null, last_used_at: row.last_used_at || null, revoked_at: row.revoked_at || null,
    ...(row.type === "webauthn" ? { webauthn_transports: row.webauthn_transports || [], webauthn_backup_eligible: row.webauthn_backup_eligible ?? null } : {}),
  };
}

function requireText(value, name, { min = 1, max = 500 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) throw mfaError("mfa_invalid_input", { field: name });
  return value;
}

function validateCredentialInput(input) {
  const type = input && input.type;
  if (!CREDENTIAL_TYPES.includes(type)) throw mfaError("mfa_invalid_input", { field: "type" });
  const label = typeof input.label === "string" ? input.label.slice(0, 80) : "";
  if (type === "totp") {
    requireText(input.secret_ciphertext, "secret_ciphertext", { max: 2000 }); requireText(input.secret_nonce, "secret_nonce", { max: 100 }); requireText(input.secret_key_id, "secret_key_id", { max: 64 });
    return { type, label, secret_ciphertext: input.secret_ciphertext, secret_nonce: input.secret_nonce, secret_key_id: input.secret_key_id };
  }
  requireText(input.webauthn_credential_id, "webauthn_credential_id", { max: 1400 }); requireText(input.webauthn_public_key, "webauthn_public_key", { max: 4000 });
  return {
    type, label, webauthn_credential_id: input.webauthn_credential_id, webauthn_public_key: input.webauthn_public_key,
    webauthn_sign_count: Number.isInteger(input.webauthn_sign_count) && input.webauthn_sign_count >= 0 ? input.webauthn_sign_count : 0,
    webauthn_transports: Array.isArray(input.webauthn_transports) ? input.webauthn_transports.map(String).slice(0, 8) : [],
    webauthn_aaguid: typeof input.webauthn_aaguid === "string" ? input.webauthn_aaguid : null,
    webauthn_backup_eligible: typeof input.webauthn_backup_eligible === "boolean" ? input.webauthn_backup_eligible : null,
  };
}

function validateRecoveryHmacs(hmacs) {
  if (!Array.isArray(hmacs) || hmacs.length < 1 || hmacs.length > MAX_RECOVERY_CODES) throw mfaError("mfa_invalid_input", { field: "hmacs" });
  for (const h of hmacs) if (typeof h !== "string" || !/^[A-Za-z0-9+/_=-]{16,128}$/.test(h)) throw mfaError("mfa_invalid_input", { field: "hmacs" });
  if (new Set(hmacs).size !== hmacs.length) throw mfaError("mfa_conflict");
  return hmacs;
}

function validateChallengeInput(purpose, challengeB64, ttlSeconds) {
  if (!CHALLENGE_PURPOSES.includes(purpose)) throw mfaError("mfa_invalid_input", { field: "purpose" });
  requireText(challengeB64, "challenge", { min: 16, max: 2000 });
  const ttl = Number.isFinite(Number(ttlSeconds)) ? Math.max(1, Math.min(MAX_CHALLENGE_TTL_SECONDS, Math.floor(Number(ttlSeconds)))) : 300;
  return { purpose, challengeB64, ttl };
}

module.exports = { CHALLENGE_PURPOSES, CREDENTIAL_TYPES, MAX_CHALLENGE_TTL_SECONDS, MAX_RECOVERY_CODES, lockDurationMs, mfaError, sanitizeStoreError, sanitizeCredential, validateCredentialInput, validateRecoveryHmacs, validateChallengeInput };
