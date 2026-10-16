"use strict";

// Settings S7.5.1: MFA encryption-key configuration and its readiness check. Contract: docs/settings-domain/28_S7_5_1_MFA_DATA_FOUNDATION_CONTRACT.md
// No key is generated, stored in the repository or the database, or exposed here. The checker reports problem CODES only: never a key, a length, a key id or a fingerprint.
// MFA is OFF by default; in this slice `on` only enables validation and readiness reporting.

const { sharedSecrets } = require("./auth-config");

const KEY_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const MIN_DISTINCT_BYTES = 12; // a real random 32-byte key has ~30 distinct byte values; repeated/patterned placeholders do not

function mfaMode(env = process.env) {
  return String(env.LEAD_AGENTS_MFA || "off").trim().toLowerCase() === "on" ? "on" : "off";
}

function decodeKey(text) {
  const raw = String(text || "").trim();
  if (!raw) return { error: "missing" };
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return { error: "encoding" };
  const bytes = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes.length !== KEY_BYTES) return { error: "length" };
  if (new Set(bytes).size < MIN_DISTINCT_BYTES) return { error: "weak" };
  return { bytes, raw };
}

/** Parses `id:base64,id2:base64`. Returns { entries: [{ id, bytes }], problems: [codes] }. */
function parsePreviousKeys(value) {
  const problems = []; const entries = [];
  for (const part of String(value || "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    const id = i > 0 ? part.slice(0, i) : ""; const decoded = decodeKey(i > 0 ? part.slice(i + 1) : "");
    if (!KEY_ID_PATTERN.test(id) || decoded.error) { problems.push("mfa_previous_key_invalid"); continue; }
    entries.push({ id, bytes: decoded.bytes, raw: decoded.raw });
  }
  return { entries, problems };
}

/**
 * Live validation of the MFA key configuration. Required only when MFA is on; when off, an absent key is simply "not_required" and nothing is reported as a problem
 * (a key that IS present while off is still checked, so a typo is visible before the feature is switched on, but it never affects readiness).
 * Returns { mode, valid, key: not_required|configured|missing|invalid, problems: [codes] }.
 */
function validateMfaConfig(config = {}) {
  const mode = config.mfaMode === "on" ? "on" : "off";
  const present = Boolean(String(config.mfaKey || "").trim());
  const problems = [];
  let keyBytes = null;
  if (mode === "on" || present) {
    const decoded = decodeKey(config.mfaKey);
    if (decoded.error === "missing") { if (mode === "on") problems.push("mfa_key_missing"); }
    else if (decoded.error === "encoding") problems.push("mfa_key_invalid_encoding");
    else if (decoded.error === "length") problems.push("mfa_key_wrong_length");
    else if (decoded.error === "weak") problems.push("mfa_key_weak");
    else keyBytes = decoded;
    const id = String(config.mfaKeyId || "").trim();
    if (mode === "on" || id || present) {
      if (!id) { if (mode === "on") problems.push("mfa_key_id_missing"); }
      else if (!KEY_ID_PATTERN.test(id)) problems.push("mfa_key_id_invalid");
    }
  }
  const previous = parsePreviousKeys(config.mfaKeysPrevious);
  problems.push(...previous.problems);
  const ids = [String(config.mfaKeyId || "").trim(), ...previous.entries.map((e) => e.id)].filter(Boolean);
  if (new Set(ids).size !== ids.length) problems.push("mfa_previous_key_id_duplicate");
  // independence: the MFA key must not be, or contain, any other secret in configuration (rotating the session secret is the S7.4 break-glass and must never touch MFA)
  const others = [config.sessionSecret, ...sharedSecrets(config)].filter((v) => typeof v === "string" && v);
  for (const candidate of [keyBytes, ...previous.entries]) {
    if (!candidate) continue;
    const asText = candidate.raw; const asBytes = candidate.bytes;
    const asUtf8 = asBytes.toString("utf8");
    // equal to another secret in any common spelling, or the first 32 characters of one (a typical "derive a key from the secret" shortcut)
    if (others.some((o) => o === asText || o === asBytes.toString("base64") || o === asBytes.toString("hex") || o === asUtf8 || (!asUtf8.includes("\uFFFD") && o.startsWith(asUtf8)))) { problems.push("mfa_key_reused_secret"); break; }
  }
  const unique = [...new Set(problems)];
  const key = !present ? (mode === "on" ? "missing" : "not_required") : unique.length ? "invalid" : "configured";
  const requiredProblems = mode === "on" ? unique : [];
  return { mode, valid: requiredProblems.length === 0, key, problems: unique };
}

/** For later slices: the parsed keyring. Throws a code-only error unless MFA is on and the configuration is valid. */
function loadMfaKeyring(config) {
  const status = validateMfaConfig(config);
  if (status.mode !== "on" || !status.valid || status.key !== "configured") { const e = new Error("mfa_unavailable"); e.code = "mfa_unavailable"; throw e; }
  const current = decodeKey(config.mfaKey);
  return { current: { id: String(config.mfaKeyId).trim(), key: current.bytes }, previous: parsePreviousKeys(config.mfaKeysPrevious).entries.map((e) => ({ id: e.id, key: e.bytes })) };
}

module.exports = { KEY_BYTES, mfaMode, validateMfaConfig, loadMfaKeyring };
