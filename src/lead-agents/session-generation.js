"use strict";

// Settings S7.4: session generations. Contract: docs/settings-domain/24_S7_4_SESSION_REVOCATION_IMPLEMENTATION_CONTRACT.md
// A session token carries `sg`, the account's generation when it was issued. It is valid only while that equals the account's CURRENT generation; revocation is one atomic
// increment. No clock is involved. A token without `sg` (issued before this feature) counts as generation 0.

function effectiveGeneration(user) {
  const value = user && user.session_generation;
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function revocationEnabled(config) { return config.sessionRevocationEnabled !== false; }

/**
 * Decides whether a session token may be used for the live account. `reason` is a category only.
 * Rules: the token's user id must be this account (a deleted-and-recreated account has a new id), the generation must match, and legacy tokens (no `sg`) are refused
 * only when LEAD_AGENTS_REJECT_LEGACY_SESSIONS is set.
 */
function checkSessionGeneration({ authContext, user, config }) {
  if (!revocationEnabled(config)) return { ok: true };
  if (authContext.userId && user.id && String(authContext.userId) !== String(user.id)) return { ok: false, reason: "account_replaced" };
  const tokenGeneration = Number.isInteger(authContext.sessionGeneration) ? authContext.sessionGeneration : null;
  if (tokenGeneration === null) {
    if (config.rejectLegacySessions === true) return { ok: false, reason: "legacy_session" };
    return effectiveGeneration(user) === 0 ? { ok: true } : { ok: false, reason: "revoked" };
  }
  return tokenGeneration === effectiveGeneration(user) ? { ok: true } : { ok: false, reason: "revoked" };
}

module.exports = { effectiveGeneration, revocationEnabled, checkSessionGeneration };
