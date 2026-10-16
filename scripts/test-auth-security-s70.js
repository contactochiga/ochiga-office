// Settings S7.0: authentication security hardening. Contract: docs/settings-domain/19_S7_0_AUTH_SECURITY_CONTRACT.md
const assert = require("node:assert/strict");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer, bootstrapAdminUser } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword, createAdminSessionToken, readAdminSession } = require("../src/lead-agents/auth");
const { resolveSessionSecret, validateAuthConfig } = require("../src/lead-agents/auth-config");
const crypto = require("node:crypto");

const GOOD = "s7-0-dedicated-session-secret-0123456789abcdef";
const listen = (s) => new Promise((r, j) => { s.once("error", j); s.listen(0, "127.0.0.1", () => r(s.address().port)); });
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed += 1; };

async function boot(overrides = {}, seed = async () => {}, loginMax = 500) {
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["legacy-api-key-value"], allowedOrigins: [], sessionSecret: GOOD, sessionSecretEphemeral: false, ...overrides };
  const { store } = await createTempStore();
  await seed(store);
  const server = buildServer({
    config, store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: loginMax }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] }, openaiClient: {},
    toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }),
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const login = (email, password) => fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { config, store, server, base, login, close: () => new Promise((r) => server.close(r)) };
}
const seedAdmin = (email, password, role = "admin", extra = {}) => (store) => store.ensureAdminUser({ email, password_hash: hashPassword(password), role, display_name: email, status: "active", ...extra });

async function main() {
  // ---- 1. secret resolution matrix
  const a = resolveSessionSecret({ LEAD_AGENTS_API_KEYS: "k1,k2" }, "development");
  ok(a.ephemeral && a.secret.length >= 32 && a.secret !== "k1,k2" && a.secret !== "lead-agents-dev-session-secret", "dev: ephemeral random, never API keys or constant");
  ok(resolveSessionSecret({}, "development").secret !== a.secret, "ephemeral differs per resolution");
  ok(resolveSessionSecret({ LEAD_AGENTS_API_KEYS: "k1" }, "production").secret === "", "prod: API keys are never a secret source");
  eq(resolveSessionSecret({ LEAD_AGENTS_SESSION_SECRET: GOOD }, "production").secret, GOOD, "prod: dedicated secret used");

  // ---- 2. validation matrix (codes only)
  const prod = (o) => validateAuthConfig({ environment: "production", apiKeys: ["legacy-api-key-value"], ...o });
  ok(prod({ sessionSecret: GOOD }).valid, "good production secret valid");
  ok(prod({ sessionSecret: "" }).problems.includes("session_secret_missing"), "missing");
  ok(prod({ sessionSecret: "short-secret" }).problems.includes("session_secret_too_short"), "short");
  ok(prod({ sessionSecret: "change-me" }).problems.includes("session_secret_placeholder"), "placeholder");
  ok(prod({ sessionSecret: "lead-agents-dev-session-secret" }).problems.includes("session_secret_placeholder"), "historic constant");
  const longKey = "k".repeat(40);
  ok(prod({ sessionSecret: longKey, apiKeys: [longKey] }).problems.includes("session_secret_shared_with_api_key"), "equals API key");
  ok(prod({ sessionSecret: `${longKey},${longKey}2`, apiKeys: [longKey, `${longKey}2`] }).problems.includes("session_secret_shared_with_api_key"), "equals joined API key list");
  ok(prod({ sessionSecret: GOOD, officeBackendApiKey: GOOD }).problems.includes("session_secret_reused_bridge_secret"), "reused bridge secret");
  ok(prod({ sessionSecret: GOOD, edgeAgentTokens: [GOOD] }).problems.includes("session_secret_reused_bridge_secret"), "reused edge token");
  ok(!JSON.stringify(prod({ sessionSecret: "short-secret" })).includes("short-secret"), "result never echoes the secret");
  ok(validateAuthConfig({ environment: "development", sessionSecret: "x", apiKeys: ["x"] }).valid, "non-production tolerant of short ephemeral/dev secrets");

  // ---- 3. session signing
  const user = { id: "u1", email: "a@x.test", role: "admin", permission_scopes: ["a"] };
  const cfg = { ...createConfig(), sessionSecret: GOOD, sessionSecretEphemeral: false, environment: "production" };
  const tok = createAdminSessionToken(user, cfg);
  const reqWith = (t, c = cfg) => ({ headers: { cookie: `${c.sessionCookieName}=${encodeURIComponent(t)}` } });
  ok(readAdminSession(reqWith(tok), cfg)?.email === "a@x.test", "valid token reads back");
  eq(readAdminSession(reqWith(tok), { ...cfg, sessionSecret: GOOD + "x" }), null, "wrong secret rejected");
  const [p, sig] = tok.split(".");
  eq(readAdminSession(reqWith(`${p}.${sig.replace(/.$/, sig.endsWith("0") ? "1" : "0")}`), cfg), null, "tampered signature rejected");
  const forged = Buffer.from(JSON.stringify({ email: "evil@x.test", role: "super_admin", exp: Date.now() + 1e6 })).toString("base64url");
  eq(readAdminSession(reqWith(`${forged}.${crypto.createHmac("sha256", "legacy-api-key-value").update(forged).digest("hex")}`), cfg), null, "token signed with an API key rejected");
  eq(readAdminSession(reqWith(`${forged}.${crypto.createHmac("sha256", "lead-agents-dev-session-secret").update(forged).digest("hex")}`), cfg), null, "token signed with the old constant rejected");
  const expired = createAdminSessionToken(user, { ...cfg, sessionTtlMs: -1000 });
  eq(readAdminSession(reqWith(expired), cfg), null, "expired token rejected");
  const bad = { ...cfg, sessionSecret: "" };
  assert.throws(() => createAdminSessionToken(user, bad), (e) => e.code === "auth_configuration_invalid" && e.statusCode === 503); passed += 1;
  eq(readAdminSession(reqWith(tok, bad), bad), null, "invalid config accepts no cookie");
  eq(createConfig().sessionTtlMs, 7 * 24 * 3600 * 1000, "seven-day session duration preserved");

  // ---- 4. production readiness + safe failure
  {
    const t = await boot({ environment: "production", sessionSecret: "" }, seedAdmin("op@x.test", "op-pass-1234567"));
    const h = await fetch(`${t.base}/healthz`); const hb = await h.json();
    eq(h.status, 503, "invalid prod config: healthz 503");
    ok(hb.ready === false && hb.auth_config.session_secret === "invalid" && hb.auth_config.problems.includes("session_secret_missing"), "healthz reports problem code");
    const l = await t.login("op@x.test", "op-pass-1234567");
    eq(l.status, 503, "login 503 while invalid"); eq((await l.json()).error, "auth_configuration_invalid");
    ok(!l.headers.get("set-cookie"), "no cookie while invalid");
    const inv = await fetch(`${t.base}/api/lead-agents/admin/session/invite/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "x", password: "y" }) });
    eq(inv.status, 503, "invite accept 503 while invalid");
    await t.close();
  }
  {
    const t = await boot({ environment: "production", sessionSecret: "k".repeat(40), apiKeys: ["k".repeat(40)] });
    const hb = await (await fetch(`${t.base}/healthz`)).json();
    ok(hb.auth_config.problems.includes("session_secret_shared_with_api_key") && !JSON.stringify(hb).includes("k".repeat(40)), "healthz never echoes secrets");
    await t.close();
  }
  {
    const t = await boot({ environment: "production" }, seedAdmin("ok@x.test", "ok-pass-1234567"));
    const h = await fetch(`${t.base}/healthz`); const hb = await h.json();
    eq(h.status, 200, "valid prod config: healthz 200");
    ok(hb.ready === true && hb.auth_config.session_secret === "configured" && hb.auth_config.api_key_password_login === "disabled" && hb.auth_config.admin_recovery === "disabled", "healthz reports modes");
    const l = await t.login("ok@x.test", "ok-pass-1234567"); eq(l.status, 200, "valid login in production");
    const sc = l.headers.get("set-cookie"); ok(/HttpOnly/.test(sc) && /Secure/.test(sc) && /Max-Age=604800/.test(sc), "cookie flags + 7-day Max-Age");
    await t.close();
  }

  // ---- 5. unauthorized login + fallback rejection + limiter
  {
    const t = await boot({}, seedAdmin("real@x.test", "real-pass-1234567"));
    eq((await t.login("real@x.test", "wrong")).status, 401, "wrong password 401");
    eq((await t.login("nobody@x.test", "whatever")).status, 401, "unknown email 401");
    const f = await t.login("newbie@x.test", "legacy-api-key-value");
    eq(f.status, 401, "API-key password rejected by default"); ok(!f.headers.get("set-cookie"), "no cookie on rejection");
    eq(await t.store.getAdminUserByEmail("newbie@x.test"), null, "no account minted");
    eq((await t.login("real@x.test", "legacy-api-key-value")).status, 401, "API key is not an existing admin's password");
    ok(!(JSON.stringify(await t.store.listAuditEvents(200))).includes("session_login_api_key_fallback"), "no fallback audit when disabled");
    await t.close();
  }
  {
    // explicit transitional mode, audited
    const t = await boot({ allowApiKeyPasswordLogin: true });
    const f = await t.login("legacy@x.test", "legacy-api-key-value");
    eq(f.status, 200, "transitional mode accepts API-key password"); ok(f.headers.get("set-cookie"), "cookie issued in transitional mode");
    const audit = JSON.stringify(await t.store.listAuditEvents(200));
    ok(audit.includes("session_login_api_key_fallback") && !audit.includes("legacy-api-key-value"), "fallback audited without the key");
    eq((await (await fetch(`${t.base}/healthz`)).json()).auth_config.api_key_password_login, "enabled_deprecated", "healthz flags deprecated mode");
    await t.close();
  }
  {
    // limiter still applies to failed attempts
    const t = await boot({}, seedAdmin("lim@x.test", "lim-pass-1234567"), 10);
    let last; for (let i = 0; i < 12; i += 1) last = await t.login("lim@x.test", "bad-" + i);
    eq(last.status, 429, "login limiter still throttles");
    // R1 (certification finding F-1): this line used to assert that the CORRECT password still succeeds while throttled. That was the defect (a guesser could tell success from failure and was never slowed); it is now refused too.
    const rightWhileLimited = await t.login("lim@x.test", "lim-pass-1234567"); eq(rightWhileLimited.status, 429, "the correct password is refused while throttled (R1: the limiter cannot be bypassed)"); ok(!rightWhileLimited.headers.get("set-cookie"), "…and no session is created");
    await t.close();
  }

  // ---- 6. recovery
  {
    const { store } = await createTempStore();
    await store.ensureAdminUser({ email: "boss@x.test", password_hash: hashPassword("lost-old-password"), role: "viewer", display_name: "b", status: "inactive" });
    const base = { adminEmail: "boss@x.test", adminPassword: "recovered-pass-12345", adminRole: "super_admin" };
    await bootstrapAdminUser(store, { ...base, adminRecovery: false });
    let u = await store.getAdminUserByEmail("boss@x.test");
    ok(u.status === "inactive" && u.role === "viewer", "recovery off: existing account untouched");
    await store.ensureAdminUser({ email: "other@x.test", password_hash: hashPassword("other-pass-123456"), role: "viewer", display_name: "o", status: "active" });
    const otherBefore = (await store.getAdminUserByEmail("other@x.test")).password_hash;
    await bootstrapAdminUser(store, { ...base, adminPassword: "short", adminRecovery: true });
    u = await store.getAdminUserByEmail("boss@x.test");
    ok(u.status === "inactive", "weak recovery password refused");
    await bootstrapAdminUser(store, { ...base, adminRecovery: true });
    u = await store.getAdminUserByEmail("boss@x.test");
    const { verifyPassword } = require("../src/lead-agents/auth");
    ok(u.status === "active" && u.role === "super_admin" && verifyPassword("recovered-pass-12345", u.password_hash), "recovery resets password, reactivates, restores role");
    eq((await store.getAdminUserByEmail("other@x.test")).password_hash, otherBefore, "recovery touches no other account");
    const audit = JSON.stringify(await store.listAuditEvents(200));
    ok(audit.includes("admin_recovery_applied") && !audit.includes("recovered-pass-12345"), "recovery audited without the password");
  }

  // ---- 7. existing sessions, role/scope revocation, deactivation
  {
    const t = await boot({}, seedAdmin("sup@x.test", "sup-pass-1234567", "super_admin"));
    const l = await t.login("sup@x.test", "sup-pass-1234567"); const cookie = l.headers.get("set-cookie").split(";")[0];
    const me = () => fetch(`${t.base}/api/lead-agents/admin/session/me`, { headers: { cookie } });
    eq((await me()).status, 200, "existing session valid");
    const u = await t.store.getAdminUserByEmail("sup@x.test");
    await t.store.updateAdminUser(u.id, { role: "viewer" });
    const body = await (await me()).json();
    ok(JSON.stringify(body).includes("viewer"), "role change visible on the next request");
    await t.store.updateAdminUser(u.id, { status: "inactive" });
    eq((await me()).status, 401, "deactivated user's session revoked");
    // R1 (certification finding F-2): was 403 account_inactive, which let anyone learn that an address is a deactivated account. It is now the same generic 401 as an unknown address or a wrong password; no session is issued.
    { const denied = await t.login("sup@x.test", "sup-pass-1234567"); eq(denied.status, 401, "deactivated user cannot sign in (generic failure, not a distinct answer)"); ok(!denied.headers.get("set-cookie"), "…and no session is created"); }
    await t.close();
  }
  console.log(`S7.0 auth security: ${passed} assertions PASS`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
