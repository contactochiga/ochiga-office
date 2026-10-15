"use strict";

// Settings S7.3: governed session duration. Contract: docs/settings-domain/22_S7_3_SESSION_DURATION_POLICY_CONTRACT.md
// The effective duration is resolved at the moment a session is issued, from the S3 registry setting `office_session_ttl_hours`, falling back to the environment duration.
// One resolved value feeds both the signed token expiry and the cookie Max-Age. Issued sessions are stateless and keep the expiry already signed into them.

const SESSION_TTL_KEY = "office_session_ttl_hours";
const SESSION_TTL_DEFAULT_HOURS = 168;
const SESSION_TTL_MIN_HOURS = 1;
const SESSION_TTL_MAX_HOURS = 720;
const HOUR_MS = 3_600_000;

function validateSessionTtlHours(value) {
  if (typeof value !== "number" || !Number.isInteger(value)) return { ok: false, error: "must_be_integer" };
  if (value < SESSION_TTL_MIN_HOURS || value > SESSION_TTL_MAX_HOURS) return { ok: false, error: `must_be_between_${SESSION_TTL_MIN_HOURS}_and_${SESSION_TTL_MAX_HOURS}` };
  return { ok: true, value };
}

function environmentTtlMs(config) {
  const ms = Number(config.sessionTtlMs);
  return Number.isFinite(ms) && ms > 0 ? ms : SESSION_TTL_DEFAULT_HOURS * HOUR_MS;
}

/** The duration for a session issued now. Never throws; never invents or writes a stored value. */
async function resolveSessionTtl(store, config, { log } = {}) {
  const envMs = environmentTtlMs(config);
  const fallback = (reason) => {
    if (typeof log === "function") log("warn", "session_ttl_fallback", { reason });
    return { ttlMs: Math.min(envMs, SESSION_TTL_MAX_HOURS * HOUR_MS), hours: null, source: "environment_fallback", reason, version: null };
  };
  let row;
  try {
    row = await store.getRuntimeSetting(SESSION_TTL_KEY);
  } catch {
    return fallback("setting_unavailable");
  }
  if (!row) {
    return { ttlMs: envMs, hours: envMs / HOUR_MS, source: envMs === SESSION_TTL_DEFAULT_HOURS * HOUR_MS ? "default" : "environment", reason: null, version: 0 };
  }
  const checked = validateSessionTtlHours(row.value);
  if (!checked.ok) return fallback("stored_value_invalid");
  return { ttlMs: checked.value * HOUR_MS, hours: checked.value, source: "stored", reason: null, version: row.version ?? null };
}

module.exports = { SESSION_TTL_KEY, SESSION_TTL_DEFAULT_HOURS, SESSION_TTL_MIN_HOURS, SESSION_TTL_MAX_HOURS, validateSessionTtlHours, resolveSessionTtl };
