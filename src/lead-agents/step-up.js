"use strict";

// Settings S7.2: password-based step-up authorization. Contract: docs/settings-domain/21_S7_2_STEP_UP_AUTH_CONTRACT.md
// A short-lived, signed token proving the administrator re-entered their current password. It is bound to identity, the current session, a purpose and the password
// state, signed with a key derived for this purpose only, and re-checked against live account state on every use. Nothing here logs or returns a secret.

const crypto = require("crypto");
const { validateAuthConfig } = require("./auth-config");
const { hasPermission } = require("./permissions");
const { effectiveGeneration } = require("./session-generation");

const STEP_UP_PURPOSES = Object.freeze(["security_policy_write", "session_revocation", "mfa_management"]);
const STEP_UP_MAX_TTL_MS = 10 * 60 * 1000;
const STEP_UP_DEFAULT_TTL_MS = 5 * 60 * 1000;
const STEP_UP_HEADER = "x-step-up-token";

function stepUpTtlMs(config) {
  const configured = Number(config.stepUpTtlMs);
  const ttl = Number.isFinite(configured) && configured > 0 ? configured : STEP_UP_DEFAULT_TTL_MS;
  return Math.min(ttl, STEP_UP_MAX_TTL_MS);
}

function stepUpKey(config) {
  return crypto.createHmac("sha256", String(config.sessionSecret || "")).update("ochiga-office/step-up/v1").digest();
}
const keyed = (config, label, value) => crypto.createHmac("sha256", stepUpKey(config)).update(`${label}:${String(value || "")}`).digest("hex").slice(0, 32);
const sign = (config, payload) => crypto.createHmac("sha256", stepUpKey(config)).update(payload).digest("hex");
const equal = (a, b) => { const l = Buffer.from(String(a)); const r = Buffer.from(String(b)); return l.length === r.length && crypto.timingSafeEqual(l, r); };

/** Why this context may not use step-up at all, or null. Live state only: authContext must come from enrichAuthContext. */
function stepUpEligibility(authContext, purpose) {
  if (!authContext) return "invalid";
  if (authContext.type !== "session") return "api_key_not_allowed";
  const user = authContext.user;
  if (!user || user.status !== "active") return "permission_removed";
  // S7.5.4: managing one's OWN second factors is open to any signed-in human; every other purpose stays super_admin + team.manage
  if (purpose === "mfa_management") return null;
  if (authContext.role !== "super_admin" || !hasPermission(authContext, "team.manage")) return "permission_removed";
  return null;
}

function issueStepUpToken({ config, authContext, purpose, mfa = false, now = Date.now() }) {
  if (!validateAuthConfig(config).valid) { const e = new Error("auth_configuration_invalid"); e.statusCode = 503; throw e; }
  const ttl = stepUpTtlMs(config);
  const sessionExpiry = Number(authContext.sessionExpiresAt) || now + ttl;
  const exp = Math.min(now + ttl, sessionExpiry);
  const payload = Buffer.from(JSON.stringify({
    v: 1, purpose, sub: authContext.user.id, email: authContext.user.email,
    sg: effectiveGeneration(authContext.user), ...(mfa ? { mf: true } : {}), sid: keyed(config, "sid", authContext.sessionBinding), pwf: keyed(config, "pwf", authContext.user.password_hash),
    iat: now, exp, jti: crypto.randomBytes(12).toString("hex"),
  })).toString("base64url");
  return { token: `${payload}.${sign(config, payload)}`, purpose, issued_at: new Date(now).toISOString(), expires_at: new Date(exp).toISOString(), ttl_seconds: Math.round((exp - now) / 1000) };
}

/** { ok: true, expiresAt } or { ok: false, reason } with a category only. */
function verifyStepUpToken({ config, authContext, purpose, token, now = Date.now() }) {
  const ineligible = stepUpEligibility(authContext, purpose);
  if (ineligible) return { ok: false, reason: ineligible };
  if (!validateAuthConfig(config).valid) return { ok: false, reason: "invalid" };
  if (!token || typeof token !== "string") return { ok: false, reason: "missing" };
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || !equal(sign(config, payload), signature)) return { ok: false, reason: "invalid" };
  let p;
  try { p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return { ok: false, reason: "invalid" }; }
  if (!p || p.v !== 1 || typeof p.exp !== "number" || typeof p.purpose !== "string") return { ok: false, reason: "invalid" };
  if (p.exp <= now) return { ok: false, reason: "expired" };
  if (p.purpose !== purpose || !STEP_UP_PURPOSES.includes(purpose)) return { ok: false, reason: "wrong_purpose" };
  if (p.sub !== authContext.user.id || String(p.email) !== authContext.user.email) return { ok: false, reason: "wrong_identity" };
  // S7.4: a grant earned before a revocation is dead, even for a caller that verifies without session enrichment
  if (config.sessionRevocationEnabled !== false && (!Number.isInteger(p.sg) || p.sg !== effectiveGeneration(authContext.user))) return { ok: false, reason: "session_revoked" };
  if (!equal(p.sid || "", keyed(config, "sid", authContext.sessionBinding))) return { ok: false, reason: "wrong_session" };
  if (!equal(p.pwf || "", keyed(config, "pwf", authContext.user.password_hash))) return { ok: false, reason: "password_changed" };
  return { ok: true, expiresAt: p.exp, purpose: p.purpose, mf: p.mf === true };
}

module.exports = { STEP_UP_PURPOSES, STEP_UP_MAX_TTL_MS, STEP_UP_HEADER, stepUpTtlMs, stepUpEligibility, issueStepUpToken, verifyStepUpToken };
