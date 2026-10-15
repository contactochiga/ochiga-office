// Settings S7.2: governed step-up authentication. Contract: docs/settings-domain/21_S7_2_STEP_UP_AUTH_CONTRACT.md
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword, createAdminSessionToken } = require("../src/lead-agents/auth");
const { verifyStepUpToken, issueStepUpToken, STEP_UP_MAX_TTL_MS } = require("../src/lead-agents/step-up");

const SECRET = "s7-2-dedicated-session-secret-0123456789abcdef";
const API_KEY = "s72-api-key-value";
const PW = "super admin pass phrase 1";
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (s) => new Promise((r, j) => { s.once("error", j); s.listen(0, "127.0.0.1", () => r(s.address().port)); });

async function main() {
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: [API_KEY], allowedOrigins: [], sessionSecret: SECRET, sessionSecretEphemeral: false, stepUpTtlMs: 5 * 60 * 1000 };
  const { store } = await createTempStore();
  const mk = (email, password, role, extra = {}) => store.ensureAdminUser({ email, password_hash: hashPassword(password), role, display_name: email, status: "active", ...extra });
  await mk("super@x.test", PW, "super_admin");
  await mk("super2@x.test", "second super pass phrase 2", "super_admin");
  await mk("admin@x.test", "ochiga admin pass phrase 3", "ochiga_admin");
  await mk("demote@x.test", "demote me pass phrase 44", "super_admin");
  await mk("deact@x.test", "deactivate pass phrase 55", "super_admin");
  await mk("chg@x.test", "change me pass phrase 66", "super_admin");
  const logs = [];
  const server = buildServer({
    config, store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }), publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }), loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 6 }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] }, openaiClient: {},
    toolExecutor: new ToolExecutor({ store, config, log: (...a) => logs.push(JSON.stringify(a)), webhooks: new WebhookDispatcher({ config }) }),
  });
  const base = `http://127.0.0.1:${await listen(server)}`;
  const call = (path, body, { cookie, token, apiKey } = {}) => fetch(`${base}/api/lead-agents/admin/session/${path}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { "x-step-up-token": token } : {}), ...(apiKey ? { "x-api-key": apiKey } : {}) }, body: JSON.stringify(body) });
  const login = async (email, password) => { const r = await call("login", { email, password }); eq(r.status, 200, `login ${email}`); return r.headers.get("set-cookie").split(";")[0]; };
  const stepUp = (cookie, password = PW, purpose = "security_policy_write") => call("step-up", { password, purpose }, { cookie });
  const check = (cookie, token, purpose = "security_policy_write") => call("step-up/check", { purpose }, { cookie, token });
  const grant = async (cookie, password) => (await (await stepUp(cookie, password)).json()).step_up;

  const sup = await login("super@x.test", PW);

  // ---- correct password
  const r1 = await stepUp(sup); eq(r1.status, 200, "correct password issues a grant");
  const g = (await r1.json()).step_up;
  ok(g.token && g.purpose === "security_policy_write" && g.ttl_seconds <= 600 && g.ttl_seconds > 0, "grant carries token, purpose and a ttl <= 10 min");
  ok(Date.parse(g.expires_at) - Date.parse(g.issued_at) <= STEP_UP_MAX_TTL_MS, "expiry within the 10-minute ceiling");
  eq(r1.headers.get("cache-control"), "no-store", "grant is not cacheable");
  const ck = await check(sup, g.token); eq(ck.status, 200, "valid grant verifies"); ok((await ck.json()).valid === true);

  // ---- incorrect password / purpose
  const bad = await stepUp(sup, "definitely-not-the-password"); eq(bad.status, 401, "wrong password rejected");
  const badBody = await bad.json(); eq(badBody.error, "step_up_failed"); ok(!badBody.token && !badBody.step_up, "no grant on failure");
  eq((await call("step-up", { password: PW }, { cookie: sup })).status, 400, "missing purpose rejected");
  eq((await call("step-up", { password: PW, purpose: "delete_everything" }, { cookie: sup })).status, 400, "unknown purpose rejected");
  eq((await call("step-up", { password: 12345, purpose: "security_policy_write" }, { cookie: sup })).status, 401, "non-string password rejected");

  // ---- missing / forged / tampered
  eq((await (await check(sup, undefined)).json()).reason, "missing", "no token");
  eq((await (await check(sup, "garbage")).json()).reason, "invalid", "garbage token");
  const [pl, sig] = g.token.split(".");
  const tamperedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pl, "base64url")), exp: Date.now() + 3.6e6 })).toString("base64url");
  eq((await (await check(sup, `${tamperedPayload}.${sig}`)).json()).reason, "invalid", "extended expiry is rejected");
  eq((await (await check(sup, `${pl}.${sig.replace(/.$/, sig.endsWith("0") ? "1" : "0")}`)).json()).reason, "invalid", "tampered signature");
  const claims = JSON.parse(Buffer.from(pl, "base64url"));
  const forgeWith = (key) => { const p = Buffer.from(JSON.stringify(claims)).toString("base64url"); return `${p}.${crypto.createHmac("sha256", key).update(p).digest("hex")}`; };
  eq((await (await check(sup, forgeWith(SECRET))).json()).reason, "invalid", "token signed with the raw session secret");
  eq((await (await check(sup, forgeWith(API_KEY))).json()).reason, "invalid", "token signed with an API key");
  eq((await (await check(sup, sup.split("=")[1])).json()).reason, "invalid", "session cookie is not a step-up token");
  const userObj = await store.getAdminUserByEmail("super@x.test");
  const sessionLike = createAdminSessionToken(userObj, config);
  eq((await (await check(sup, sessionLike)).json()).reason, "invalid", "a freshly minted session token is not a step-up token");
  eq((await (await check(sup, `${g.token}.extra`)).json()).reason, "invalid", "malformed token with extra segment");
  // a step-up token is not a session
  const asCookie = await fetch(`${base}/api/lead-agents/admin/session/me`, { headers: { cookie: `${config.sessionCookieName}=${encodeURIComponent(g.token)}` } });
  eq(asCookie.status, 401, "a step-up token cannot act as a session cookie");

  // ---- wrong purpose
  eq((await (await check(sup, g.token, "something_else")).json()).reason, "wrong_purpose", "wrong purpose");

  // ---- expiry (route + clock)
  const nowFuture = Date.now() + 11 * 60 * 1000;
  const live = await store.getAdminUserByEmail("super@x.test");
  const ctxFor = (u, binding) => ({ type: "session", email: u.email, role: u.role, user: u, permissionScopes: [], permissions: require("../src/lead-agents/permissions").permissionsForRole(u.role, []), sessionBinding: binding, sessionExpiresAt: Date.now() + 1e7 });
  const issued = issueStepUpToken({ config, authContext: ctxFor(live, "b1"), purpose: "security_policy_write" });
  eq(verifyStepUpToken({ config, authContext: ctxFor(live, "b1"), purpose: "security_policy_write", token: issued.token, now: nowFuture }).reason, "expired", "expired after the ceiling");
  ok(verifyStepUpToken({ config, authContext: ctxFor(live, "b1"), purpose: "security_policy_write", token: issued.token }).ok, "valid before expiry");
  const long = issueStepUpToken({ config: { ...config, stepUpTtlMs: 3_600_000 }, authContext: ctxFor(live, "b1"), purpose: "security_policy_write" });
  ok(long.ttl_seconds <= 600, "configured TTL above 10 minutes is clamped");
  const capped = issueStepUpToken({ config, authContext: { ...ctxFor(live, "b1"), sessionExpiresAt: Date.now() + 30_000 }, purpose: "security_policy_write" });
  ok(capped.ttl_seconds <= 30, "grant never outlives its session");
  config.stepUpTtlMs = 40; const shortGrant = await grant(sup, PW); await sleep(80);
  eq((await (await check(sup, shortGrant.token)).json()).reason, "expired", "expired grant rejected over HTTP");
  config.stepUpTtlMs = 5 * 60 * 1000;

  // ---- wrong administrator / wrong session
  const sup2 = await login("super2@x.test", "second super pass phrase 2");
  eq((await (await check(sup2, g.token)).json()).reason, "wrong_identity", "another administrator cannot use the grant");
  await sleep(5);
  const supAgain = await login("super@x.test", PW);
  ok(supAgain !== sup, "a new login is a different session");
  eq((await (await check(supAgain, g.token)).json()).reason, "wrong_session", "grant is bound to the session that earned it");
  eq((await check(sup, g.token)).status, 200, "original session still valid with its grant");

  // ---- permission removed / not permitted / deactivated / password change
  const adm = await login("admin@x.test", "ochiga admin pass phrase 3");
  eq((await call("step-up", { password: "ochiga admin pass phrase 3", purpose: "security_policy_write" }, { cookie: adm })).status, 403, "ochiga_admin (no team.manage) cannot step up");
  const dem = await login("demote@x.test", "demote me pass phrase 44"); const demGrant = await grant(dem, "demote me pass phrase 44");
  eq((await check(dem, demGrant.token)).status, 200, "grant works before demotion");
  const demUser = await store.getAdminUserByEmail("demote@x.test"); await store.updateAdminUser(demUser.id, { role: "ochiga_admin" });
  eq((await (await check(dem, demGrant.token)).json()).reason, "permission_removed", "grant dies when the permission is removed");
  const dea = await login("deact@x.test", "deactivate pass phrase 55"); const deaGrant = await grant(dea, "deactivate pass phrase 55");
  const deaUser = await store.getAdminUserByEmail("deact@x.test"); await store.updateAdminUser(deaUser.id, { status: "inactive" });
  eq((await check(dea, deaGrant.token)).status, 401, "deactivated account: session and grant refused");
  eq((await call("step-up", { password: "deactivate pass phrase 55", purpose: "security_policy_write" }, { cookie: dea })).status, 401, "deactivated account cannot step up");
  const chg = await login("chg@x.test", "change me pass phrase 66"); const chgGrant = await grant(chg, "change me pass phrase 66");
  const changed = await call("password", { current_password: "change me pass phrase 66", new_password: "brand new changed phrase 77" }, { cookie: chg }); eq(changed.status, 200, "password changed");
  // S7.4: a password change also revokes the session generation. The old cookie is dead outright, and the grant cannot be carried onto the re-issued session either.
  eq((await check(chg, chgGrant.token)).status, 401, "old session is revoked by the password change, so its grant dies with it");
  const chgReissued = changed.headers.get("set-cookie").split(";")[0];
  eq((await (await check(chgReissued, chgGrant.token)).json()).reason, "session_revoked", "grant dies on password change even on the re-issued session");
  const admChg = await store.getAdminUserByEmail("chg@x.test"); await store.updateAdminUser(admChg.id, { password_hash: hashPassword("reset by admin phrase 88") });
  const chg2 = await login("chg@x.test", "reset by admin phrase 88"); const chg2Grant = await grant(chg2, "reset by admin phrase 88");
  await store.updateAdminUser(admChg.id, { password_hash: hashPassword("reset again by admin 99x") });
  // S7.5.0: the session itself is now bound to the password hash, so a hash changed behind the application's back ends the SESSION (401) before the grant is even read.
  eq((await check(chg2, chg2Grant.token)).status, 401, "any password-hash change ends the session, and with it the grant");
  // the grant's own password-state binding still stands for a caller that verifies without session enrichment
  const liveChg = await store.getAdminUserByEmail("chg@x.test");
  eq(verifyStepUpToken({ config, authContext: { ...ctxFor(liveChg, "bx"), user: liveChg }, purpose: "security_policy_write", token: chg2Grant.token }).ok, false, "unenriched verification also refuses a grant from the old password state");

  // ---- API key caller
  const ak = await call("step-up", { password: PW, purpose: "security_policy_write" }, { apiKey: API_KEY });
  eq(ak.status, 403, "API-key caller refused"); eq((await ak.json()).error, "step_up_session_required");
  eq((await (await check(undefined, g.token, "security_policy_write").catch(() => ({ json: async () => ({}) }))).json()).error !== undefined, true, "no credentials at all refused");
  const akCheck = await call("step-up/check", { purpose: "security_policy_write" }, { apiKey: API_KEY, token: g.token });
  eq(akCheck.status, 403, "API-key caller cannot use a grant"); eq((await akCheck.json()).reason, "api_key_not_allowed");
  eq((await call("step-up", { password: PW, purpose: "security_policy_write" })).status, 401, "unauthenticated caller refused");

  // ---- rate limiting (limiter allows 6 attempts per window, shared instance, step-up has its own key)
  const rl = await login("super2@x.test", "second super pass phrase 2"); let last;
  for (let i = 0; i < 8; i += 1) last = await stepUp(rl, "wrong-wrong-wrong-1", "security_policy_write");
  eq(last.status, 429, "step-up attempts are rate limited"); eq((await last.json()).error, "step_up_rate_limit_exceeded");
  eq((await call("login", { email: "super2@x.test", password: "second super pass phrase 2" })).status, 200, "step-up throttling does not lock out normal login");
  const sup3 = await login("super@x.test", PW);
  for (let i = 0; i < 3; i += 1) await stepUp(sup3, "wrong-wrong-wrong-2");
  eq((await stepUp(sup3, PW)).status, 200, "success below the limit resets the counter");
  for (let i = 0; i < 3; i += 1) await stepUp(sup3, "wrong-wrong-wrong-3");
  eq((await stepUp(sup3, PW)).status, 200, "counter really was reset");

  // ---- audit + redaction
  const events = await store.listAuditEvents(1000);
  const su = events.filter((e) => /^step_up_/.test(e.action));
  ok(su.some((e) => e.action === "step_up_verified") && su.some((e) => e.action === "step_up_failed"), "both outcomes audited");
  const failed = su.filter((e) => e.action === "step_up_failed");
  const reasons = new Set(failed.map((e) => (e.metadata || e.details || {}).failure_reason));
  for (const r of ["invalid_password", "invalid_purpose", "forbidden", "api_key_not_allowed", "rate_limited"]) ok(reasons.has(r), `failure category audited: ${r}`);
  const sample = su.find((e) => e.action === "step_up_verified");
  const meta = sample.metadata || sample.details || {};
  ok(meta.request_id && meta.purpose === "security_policy_write" && meta.outcome === "verified" && meta.at, "audit holds request id, purpose, outcome, time");
  ok(JSON.stringify(sample).includes("super@x.test"), "audit holds the actor");
  const blob = JSON.stringify(events) + logs.join("");
  for (const secret of [g.token, g.token.split(".")[0], g.token.split(".")[1], PW, "definitely-not-the-password", "wrong-wrong-wrong-1", "second super pass phrase 2", "scrypt"]) ok(!blob.includes(secret), "audit/logs never hold a token, password or hash fragment");
  ok(!blob.includes(live.password_hash), "no stored hash in audit/logs");

  // ---- unrelated operations unchanged (no step-up demanded anywhere else)
  eq((await fetch(`${base}/api/lead-agents/admin/session/me`, { headers: { cookie: sup } })).status, 200, "session read needs no step-up");
  eq((await call("password", { current_password: PW, new_password: "unrelated change still works 1" }, { cookie: await login("super2@x.test", "second super pass phrase 2").then(() => sup2) })).status, 401, "unrelated route behaves as before (wrong current password)");

  // ---- invalid auth configuration
  assert.throws(() => issueStepUpToken({ config: { ...config, sessionSecret: "" }, authContext: ctxFor(live, "b1"), purpose: "security_policy_write" }), (e) => e.statusCode === 503); passed += 1;
  eq(verifyStepUpToken({ config: { ...config, sessionSecret: "" }, authContext: ctxFor(live, "b1"), purpose: "security_policy_write", token: issued.token }).ok, false, "invalid auth config accepts no grant");

  await new Promise((r) => server.close(r));
  console.log(`S7.2 step-up: ${passed} assertions PASS`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
