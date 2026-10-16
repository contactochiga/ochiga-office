"use strict";

// Settings S7.5.7: governed MFA enforcement, preflight and deployment-owner break-glass.
// Contract: docs/settings-domain/34_S7_5_7_MFA_ENFORCEMENT_AND_RECOVERY_CONTRACT.md. No new authentication system: this module only DECIDES (is a factor required for this account, is the grace
// over, may the level be raised); sign-in, sessions, step-up and enrolment stay where they were. Nothing here logs or returns a secret.

const { hasPermission } = require("./permissions");
const { validateMfaConfig } = require("./mfa-config");

const ENFORCEMENT_KEY = "office_mfa_enforcement";
const RECOVERY_STATE_KEY = "office_mfa_recovery_state";
const ENFORCEMENT_LEVELS = Object.freeze(["off", "optional", "privileged", "all"]);
const LEVEL_RANK = Object.freeze({ off: 0, optional: 1, privileged: 2, all: 3 });
const PRIVILEGED_PERMISSIONS = Object.freeze(["team.manage", "settings.manage", "staff.manage"]);
const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const POLICY_CACHE_MS = 10_000;
const ENFORCEMENT_RELEASE = "s7.5.7"; // what LEAD_AGENTS_MFA_FLEET_ATTESTED must equal: the owner's statement that every serving instance runs this release

function validateEnforcementLevel(value) {
  if (typeof value !== "string" || !ENFORCEMENT_LEVELS.includes(value)) return { ok: false, error: `must_be_one_of_${ENFORCEMENT_LEVELS.join("_")}` };
  return { ok: true, value };
}

/** Effective permissions, never the role label alone (a scope grant makes an account privileged). */
function isPrivilegedAccount(user) {
  if (!user) return false;
  const ctx = { type: "session", role: user.role, permissionScopes: Array.isArray(user.permission_scopes) ? user.permission_scopes : [] };
  return PRIVILEGED_PERMISSIONS.some((permission) => hasPermission(ctx, permission));
}

const unavailable = (code) => { const e = new Error(code); e.statusCode = 503; e.code = code; return e; };
const cache = new WeakMap();
function invalidateEnforcementCache(config) { cache.delete(config); }

/**
 * The level in force. Inactive (no read at all) unless the MFA machinery is on. An unreadable or invalid stored value FAILS CLOSED (503): it never silently becomes `off`.
 * { level, active, status, version, effectiveSince (ISO|null) }
 */
async function resolveEnforcement(store, config, { now = Date.now(), force = false } = {}) {
  if (config.mfaMode !== "on") return { level: "off", active: false, status: "inactive", version: null, effectiveSince: null };
  const hit = cache.get(config);
  if (!force && hit && now - hit.at < POLICY_CACHE_MS) return hit.value;
  let row;
  try { row = await store.getRuntimeSetting(ENFORCEMENT_KEY); } catch { throw unavailable("mfa_enforcement_unavailable"); }
  let value;
  if (!row) value = { level: "off", active: true, status: "default", version: 0, effectiveSince: null };
  else {
    const checked = validateEnforcementLevel(row.value);
    if (!checked.ok) throw unavailable("mfa_enforcement_invalid");
    value = { level: checked.value, active: true, status: "stored", version: row.version ?? null, effectiveSince: row.updated_at || null };
  }
  cache.set(config, { at: now, value });
  return value;
}

const parseTime = (value) => { const t = Date.parse(value); return Number.isFinite(t) ? t : null; };

/**
 * Is a second factor required of this (unenrolled or enrolled) account, and when does its grace end?
 * { required, source: "mode"|"account"|null, deadline (ms|null), expired }
 */
function accountRequirement({ policy, user, now = Date.now() }) {
  const deadlines = []; const sources = [];
  const covers = policy && policy.active && (policy.level === "all" || (policy.level === "privileged" && isPrivilegedAccount(user)));
  if (covers) {
    // grace starts when the current level took effect, or when the account came into existence, whichever is later
    const since = Math.max(parseTime(policy.effectiveSince) || 0, parseTime(user.created_at) || 0);
    deadlines.push(since + GRACE_MS); sources.push("mode");
  }
  const own = parseTime(user && user.mfa_required_after);
  if (own !== null) { deadlines.push(own); sources.push("account"); }
  if (!deadlines.length) return { required: false, source: null, deadline: null, expired: false };
  const deadline = Math.min(...deadlines);
  return { required: true, source: sources[deadlines.indexOf(deadline)], deadline, expired: now >= deadline };
}

const enrollmentNotice = (requirement, now = Date.now()) => ({ required: true, grace_ends_at: new Date(requirement.deadline).toISOString(), days_left: Math.max(0, Math.ceil((requirement.deadline - now) / 86_400_000)), expired: requirement.expired });

async function requirementForUser(store, config, user, now = Date.now()) {
  const policy = await resolveEnforcement(store, config, { now });
  return accountRequirement({ policy, user, now });
}

const mailboxDeliveryReady = (config) => String(config.officeEmailProvider || "").toLowerCase() === "resend" && Boolean(config.resendApiKey);

/**
 * Can the level be raised to `level` now? Computed from live state. Lowering is never preflighted.
 * { ok, level, checks: [{ id, ok, required }], counts }
 */
async function runPreflight({ store, config, actor, level, now = Date.now() }) {
  const strict = LEVEL_RANK[level] >= LEVEL_RANK.privileged;
  const checks = [];
  const add = (id, ok, required) => checks.push({ id, ok: Boolean(ok), required: Boolean(required) });
  const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
  add("mfa_machinery", config.mfaMode === "on" && validateMfaConfig(config).valid, true);
  const schemaReady = await safe(async () => typeof store.supportsMfaManagement === "function" && (await store.supportsMfaManagement()) === true, false);
  add("schema_ready", schemaReady, true);
  const users = await safe(() => store.listAdminUsers(), null);
  const enrolledIds = await safe(async () => new Set(await store.listMfaEnrolledUserIds()), null);
  const actorEnrolled = Boolean(actor && enrolledIds && enrolledIds.has(actor.id));
  add("actor_enrolled", actorEnrolled, strict);
  const codes = actor ? await safe(() => store.countMfaRecoveryCodes(actor.id), 0) : 0;
  add("actor_recovery_codes", codes > 0, strict);
  const secondAdmin = Boolean(users && enrolledIds && users.some((u) => u.status === "active" && u.role === "super_admin" && actor && u.id !== actor.id && enrolledIds.has(u.id)));
  add("recovery_path", secondAdmin || config.mfaRecoveryApproved === true, strict);
  add("mailbox_delivery", mailboxDeliveryReady(config), strict);
  add("fleet_attested", String(config.mfaFleetAttested || "") === ENFORCEMENT_RELEASE, strict);
  add("api_key_fallback_off", config.allowApiKeyPasswordLogin !== true, strict);
  const counts = { active_accounts: null, covered: null, enrolled: null, unenrolled: null, covered_super_admins_unenrolled: null };
  if (users && enrolledIds) {
    const hypothetical = { level, active: true, effectiveSince: new Date(now).toISOString() };
    const active = users.filter((u) => u.status === "active");
    const covered = active.filter((u) => accountRequirement({ policy: hypothetical, user: { ...u, mfa_required_after: null }, now }).required);
    counts.active_accounts = active.length; counts.covered = covered.length;
    counts.enrolled = covered.filter((u) => enrolledIds.has(u.id)).length; counts.unenrolled = covered.length - counts.enrolled;
    counts.covered_super_admins_unenrolled = covered.filter((u) => u.role === "super_admin" && !enrolledIds.has(u.id)).length;
  }
  const failed = checks.filter((c) => c.required && !c.ok).map((c) => c.id);
  return { ok: failed.length === 0 && users !== null && enrolledIds !== null, level, checks, failed, counts };
}

// ---- the registry setting's guard (called by settings-api after the generic validation and before the compare-and-set) ----
async function enforcementGuard({ authContext, store, config, next, audit }) {
  // authenticated super_admin with team.manage, on a real person's session (API keys never reach here: settings-api refuses them first)
  if (!authContext || authContext.type !== "session" || authContext.role !== "super_admin" || !hasPermission(authContext, "team.manage")) return { ok: false, status: 403, error: "forbidden", extra: { required_role: "super_admin" } };
  let current = "off";
  try {
    const row = await store.getRuntimeSetting(ENFORCEMENT_KEY);
    if (row) { const checked = validateEnforcementLevel(row.value); current = checked.ok ? checked.value : "all"; }
  } catch { return { ok: false, status: 503, error: "setting_guard_unavailable" }; }
  if (next === current) return { ok: false, status: 409, error: "enforcement_unchanged" };
  if (LEVEL_RANK[next] > LEVEL_RANK[current]) {
    const result = await runPreflight({ store, config, actor: authContext.user, level: next });
    if (!result.ok) {
      await audit("mfa_enforcement_preflight_failed", ENFORCEMENT_KEY, "failure", { from: current, to: next, failed_checks: result.failed });
      return { ok: false, status: 412, error: "preflight_failed", extra: { failed_checks: result.failed, checks: result.checks, counts: result.counts } };
    }
  }
  return { ok: true };
}
const afterEnforcementChange = (config) => invalidateEnforcementCache(config);

// ---- break-glass (deployment owner) ----
const recoveryStatus = new WeakMap();
const setRecoveryStatus = (config, status) => { recoveryStatus.set(config, status); return status; };
function recoverySummary(config) {
  const flagged = config.mfaRecovery === true;
  const status = recoveryStatus.get(config) || (config.mfaMode !== "on" ? (flagged ? "inactive" : "disabled") : !flagged ? "disabled" : (config.mfaRecoveryEmail && config.mfaRecoveryId) ? "ready" : "misconfigured");
  return { status, enabled: flagged, lingering: flagged && (status === "applied" || status === "already_applied") };
}

/**
 * Applies the owner's break-glass reset at process start, at most once per LEAD_AGENTS_MFA_RECOVERY_ID. Not reachable over HTTP. Never changes the password.
 * Returns the status string (also kept for /healthz).
 */
async function applyBreakGlass({ store, config, audit, log = () => {}, now = Date.now() }) {
  const done = (status, extra) => { setRecoveryStatus(config, status); if (status !== "disabled") log("warn", "mfa_recovery_status", { status, ...(extra || {}) }); return status; };
  if (config.mfaRecovery !== true) return done("disabled");
  if (config.mfaMode !== "on") return done("inactive");
  const email = String(config.mfaRecoveryEmail || "").trim().toLowerCase(); const id = String(config.mfaRecoveryId || "").trim();
  if (!email || !email.includes("@") || !/^[A-Za-z0-9._:-]{4,64}$/.test(id)) return done("misconfigured");
  const skipped = async (category) => { try { await audit("mfa_recovery_skipped", { category, recovery_id: id, email }, "failure"); } catch { /* the status is still reported */ } return done(category); };
  try {
    if (!validateMfaConfig(config).valid || typeof store.supportsMfaManagement !== "function" || !(await store.supportsMfaManagement())) return skipped("error");
    const marker = await store.getRuntimeSetting(RECOVERY_STATE_KEY);
    const ids = marker && marker.value && Array.isArray(marker.value.ids) ? marker.value.ids : [];
    if (ids.includes(id)) return done("already_applied");
    const user = await store.getAdminUserByEmail(email);
    if (!user || user.status !== "active") return skipped("no_account");
    // the marker is written FIRST, by compare-and-set: at most once per id even if two instances start together or the rest fails
    const written = await store.writeRuntimeSetting(RECOVERY_STATE_KEY, { ids: [...ids, id].slice(-20), last: { id, at: new Date(now).toISOString(), status: "applied" } }, "break-glass", { expectedVersion: marker ? (marker.version ?? 0) : 0, requestId: "", history: false });
    if (!written || written.status === "conflict") return done("already_applied");
    await store.updateAdminUser(user.id, { mfa_required_after: new Date(now).toISOString() });
    await store.resetMfa(user.id, { actor: "break-glass" });
    try { await store.clearMfaFailures(user.id); } catch { /* reset already cleared them */ }
    invalidateEnforcementCache(config);
    await audit("mfa_recovery_applied", { recovery_id: id, email, target_user_id: user.id }, "success").catch(() => {});
    return done("applied", { recovery_id: id });
  } catch (error) {
    if (error && error.code === "versioning_unavailable") return skipped("error");
    try { await audit("mfa_recovery_skipped", { category: "error", recovery_id: id, email }, "failure"); } catch { /* reported by status */ }
    return done("error");
  }
}

module.exports = {
  ENFORCEMENT_KEY, RECOVERY_STATE_KEY, ENFORCEMENT_LEVELS, LEVEL_RANK, PRIVILEGED_PERMISSIONS, GRACE_MS, POLICY_CACHE_MS, ENFORCEMENT_RELEASE,
  validateEnforcementLevel, isPrivilegedAccount, resolveEnforcement, invalidateEnforcementCache, accountRequirement, enrollmentNotice, requirementForUser, runPreflight,
  mailboxDeliveryReady, enforcementGuard, afterEnforcementChange, applyBreakGlass, recoverySummary,
};
