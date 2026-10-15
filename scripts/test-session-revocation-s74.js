// Settings S7.4: governed session revocation (session_generation). Contract: docs/settings-domain/24_S7_4_SESSION_REVOCATION_IMPLEMENTATION_CONTRACT.md
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer, bootstrapAdminUser } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { FileLeadAgentsStore } = require("../src/lead-agents/store-file");
const { hashPassword, createAdminSessionToken } = require("../src/lead-agents/auth");

const SECRET = "s7-4-dedicated-session-secret-0123456789abcdef";
const PW = { sup: "super admin pass phrase one 11", sup2: "second super pass phrase 22", adm: "ochiga admin pass phrase 33", u1: "target user pass phrase 44", u2: "other user pass phrase 55", solo: "solo admin pass phrase 66" };
const GOOD_NEW = "brand new passphrase for tests 77";
const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed += 1; };
const listen = (s) => new Promise((r, j) => { s.once("error", j); s.listen(0, "127.0.0.1", () => r(s.address().port)); });
const claims = (cookie) => JSON.parse(Buffer.from(decodeURIComponent(cookie.split("=")[1]).split(".")[0], "base64url").toString());
const logs = [];
for (const stream of [process.stdout, process.stderr]) { const orig = stream.write.bind(stream); stream.write = (c, ...r) => { logs.push(String(c)); return orig(c, ...r); }; }

function makeApp(store, config) {
  const rl = (n) => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: n });
  return buildServer({ config, store, rateLimiter: rl(5000), publicRateLimiter: rl(5000), officeRateLimiter: rl(5000), loginRateLimiter: rl(5000), whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] }, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
}
async function client(store, config) {
  const server = makeApp(store, config);
  const base = `http://127.0.0.1:${await listen(server)}`;
  const A = "/api/lead-agents/admin";
  const call = (method, path, { cookie, body, token, apiKey } = {}) => fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { "x-step-up-token": token } : {}), ...(apiKey ? { "x-api-key": apiKey } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const login = async (email, password) => { const r = await call("POST", `${A}/session/login`, { body: { email, password } }); return r; };
  const session = async (email, password) => { const r = await login(email, password); eq(r.status, 200, `login ${email}`); return r.headers.get("set-cookie").split(";")[0]; };
  const me = async (cookie) => (await call("GET", `${A}/session/me`, { cookie })).status;
  const grant = async (cookie, password, purpose) => { const r = await call("POST", `${A}/session/step-up`, { cookie, body: { password, purpose } }); eq(r.status, 200, `grant ${purpose}`); return (await r.json()).step_up.token; };
  return { server, base, A, call, login, session, me, grant, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

async function main() {
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["s74-api-key"], allowedOrigins: [], sessionSecret: SECRET, sessionSecretEphemeral: false };
  const { store, filePath } = await createTempStore();
  const mk = (email, pw, role) => store.ensureAdminUser({ email, password_hash: hashPassword(pw), role, display_name: email, status: "active" });
  const sup = await mk("sup@x.test", PW.sup, "super_admin"); await mk("sup2@x.test", PW.sup2, "super_admin"); await mk("adm@x.test", PW.adm, "ochiga_admin");
  const u1 = await mk("u1@x.test", PW.u1, "ochiga_staff"); await mk("u2@x.test", PW.u2, "ochiga_staff");
  const gen = async (email) => (await store.getAdminUserByEmail(email)).session_generation || 0;
  let app = await client(store, config); const A = app.A;

  // ---- 0. environment duration validation (prerequisite)
  const withEnv = (v) => { const old = process.env.LEAD_AGENTS_SESSION_TTL_MS; if (v === undefined) delete process.env.LEAD_AGENTS_SESSION_TTL_MS; else process.env.LEAD_AGENTS_SESSION_TTL_MS = v; const c = createConfig(); if (old === undefined) delete process.env.LEAD_AGENTS_SESSION_TTL_MS; else process.env.LEAD_AGENTS_SESSION_TTL_MS = old; return c; };
  for (const [raw, hours, status] of [[undefined, 168, "ok"], ["", 168, "ok"], ["0", 168, "defaulted"], ["-5", 168, "defaulted"], ["abc", 168, "defaulted"], ["1", 1, "clamped"], ["1000", 1, "clamped"], ["3600000", 1, "ok"], ["2592000000", 720, "ok"], ["99999999999", 720, "clamped"]]) {
    const c = withEnv(raw); ok(c.sessionTtlMs / 3_600_000 === hours && c.sessionTtlStatus === status, `env ${JSON.stringify(raw)} -> ${hours}h ${status}`);
  }
  eq((await (await app.call("GET", "/healthz")).json()).auth_config.session_ttl, "ok", "healthz reports the environment duration status");

  // ---- 1. tokens carry the generation; copied cookies
  const c1 = await app.session("u1@x.test", PW.u1);
  eq(claims(c1).sg, 0, "new tokens carry sg = 0 at generation 0");
  const copied = c1; // an attacker's copy of the exact cookie
  const other = await app.session("u1@x.test", PW.u1);
  eq(await app.me(copied), 200, "copied cookie works before revocation");
  const rv = await app.call("POST", `${A}/session/revoke-all`, { cookie: c1, body: {} });
  eq(rv.status, 200, "sign out everywhere"); const rvb = await rv.json();
  ok(rvb.session_generation === 1 && rvb.revoked_at && !/token|scrypt|[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}/.test(JSON.stringify(rvb)), "response: generation, time, no token");
  ok(/Max-Age=0/.test(rv.headers.get("set-cookie")), "cookie cleared by sign-out");
  eq(await app.me(copied), 401, "copied cookie refused after revocation"); eq(await app.me(other), 401, "other device refused");
  eq((await (await app.call("GET", `${A}/session/me`, { cookie: copied })).json()).error, "session_revoked", "reason code");
  const fresh = await app.session("u1@x.test", PW.u1); eq(claims(fresh).sg, 1, "sign-in after revocation gets the new generation"); eq(await app.me(fresh), 200);

  // ---- 2. logout is not revocation (documented limitation)
  await app.call("POST", `${A}/session/logout`, { cookie: fresh }); eq(await app.me(fresh), 200, "logout alone only clears the browser cookie; revoke-all is the revocation");

  // ---- 3. keep_current + monotonic increments
  const kA = await app.session("u2@x.test", PW.u2), kB = await app.session("u2@x.test", PW.u2);
  const kr = await app.call("POST", `${A}/session/revoke-all`, { cookie: kA, body: { keep_current: true } }); eq(kr.status, 200);
  const kept = kr.headers.get("set-cookie").split(";")[0]; ok(!/Max-Age=0/.test(kr.headers.get("set-cookie")) && (await kr.json()).kept_current === true, "keep_current re-issues a cookie");
  eq(await app.me(kept), 200, "re-issued cookie works"); eq(await app.me(kA), 401, "old cookie dead"); eq(await app.me(kB), 401, "other device dead"); eq(claims(kept).sg, 1);
  const seq = []; for (let i = 0; i < 5; i += 1) { const r = await app.call("POST", `${A}/session/revoke-all`, { cookie: await app.session("u2@x.test", PW.u2), body: {} }); seq.push((await r.json()).session_generation); }
  assert.deepEqual(seq, [2, 3, 4, 5, 6]); passed += 1;

  // ---- 4. password change
  const pA = await app.session("adm@x.test", PW.adm), pB = await app.session("adm@x.test", PW.adm);
  const before = await gen("adm@x.test");
  eq((await app.call("POST", `${A}/session/password`, { cookie: pA, body: { current_password: PW.adm, new_password: "short" } })).status, 400, "policy failure");
  eq(await gen("adm@x.test"), before, "a rejected change revokes nothing"); eq(await app.me(pB), 200);
  const pc = await app.call("POST", `${A}/session/password`, { cookie: pA, body: { current_password: PW.adm, new_password: GOOD_NEW } }); eq(pc.status, 200, "password changed");
  const pcb = await pc.json(); ok(!("password_hash" in (pcb.user || {})) && !JSON.stringify(pcb).includes("scrypt") && pcb.other_sessions_signed_out === true, "response never carries the hash");
  const pNew = pc.headers.get("set-cookie").split(";")[0]; eq(await app.me(pNew), 200, "current browser stays signed in via the re-issued cookie"); eq(await app.me(pA), 401, "old cookie of this browser retired"); eq(await app.me(pB), 401, "other sessions signed out");
  eq(await gen("adm@x.test"), before + 1, "one generation per change");

  // ---- 5. password reset: revokes, issues no session
  const rUser = await store.getAdminUserByEmail("sup2@x.test"); const s2 = await app.session("sup2@x.test", PW.sup2);
  await store.createPasswordResetToken({ admin_user_id: rUser.id, email: "sup2@x.test", token_hash: sha("reset-1"), requested_by: "self_service", expires_at: new Date(Date.now() + 3600e3).toISOString() });
  const rc = await app.call("POST", `${A}/session/reset/confirm`, { body: { token: "reset-1", new_password: "reset passphrase for sup two 88" } }); eq(rc.status, 200); ok(!rc.headers.get("set-cookie"), "reset issues no session");
  eq(await app.me(s2), 401, "existing sessions die on a password reset"); eq((await app.login("sup2@x.test", "reset passphrase for sup two 88")).status, 200, "new password signs in");
  PW.sup2 = "reset passphrase for sup two 88";

  // ---- 6. admin-set password and status changes
  const supCookie = await app.session("sup@x.test", PW.sup);
  const t1 = await app.session("u1@x.test", PW.u1);
  const patch = (id, body, cookie = supCookie) => app.call("PATCH", `${A}/users/${id}`, { cookie, body });
  eq((await patch(u1.id, { display_name: "Renamed" })).status, 200); eq(await app.me(t1), 200, "a non-password, non-status edit does not revoke");
  eq((await patch(u1.id, { role: "ochiga_admin" })).status, 200); eq(await app.me(t1), 200, "role change does not bump (it is live per request)"); await patch(u1.id, { role: "ochiga_staff" });
  eq((await patch(u1.id, { password: "admin chosen passphrase for u1 99" })).status, 200); eq(await app.me(t1), 401, "admin-set password ends the target's sessions"); PW.u1 = "admin chosen passphrase for u1 99";
  const t2 = await app.session("u1@x.test", PW.u1);
  eq((await patch(u1.id, { status: "inactive" })).status, 200); eq(await app.me(t2), 401, "deactivated");
  eq((await patch(u1.id, { status: "active" })).status, 200); eq(await app.me(t2), 401, "REACTIVATION no longer resurrects the old cookie");
  const t3 = await app.session("u1@x.test", PW.u1);
  eq((await app.call("POST", `${A}/users/${u1.id}/remove`, { cookie: supCookie })).status, 200); eq(await app.me(t3), 401);
  eq((await app.call("POST", `${A}/users/${u1.id}/restore`, { cookie: supCookie })).status, 200); eq(await app.me(t3), 401, "remove -> restore does not resurrect either");
  eq((await app.login("u1@x.test", PW.u1)).status, 200, "fresh sign-in works after restore");

  // ---- 7. deleted and recreated accounts
  const ghost = await mk("ghost@x.test", "ghost passphrase number one 1", "ochiga_staff"); const gc = await app.session("ghost@x.test", "ghost passphrase number one 1");
  await store.deleteAdminUser(ghost.id); const ghost2 = await mk("ghost@x.test", "ghost passphrase number two 2", "ochiga_staff");
  ok(ghost2.id !== ghost.id && (await gen("ghost@x.test")) === claims(gc).sg, "recreated account has a new id and the SAME generation");
  eq(await app.me(gc), 401, "old cookie is refused: a recreated account does not inherit session validity");
  eq((await (await app.call("GET", `${A}/session/me`, { cookie: gc })).json()).error, "session_revoked");

  // ---- 8. admin revocation of another user: step-up purpose, permissions, API key
  const target = await store.getAdminUserByEmail("u2@x.test"); const tc = await app.session("u2@x.test", PW.u2);
  const adminRevoke = (cookie, id, { token, body, apiKey } = {}) => app.call("POST", `${A}/users/${id}/revoke-sessions`, { cookie, token, body: body || {}, apiKey });
  const noGrant = await adminRevoke(supCookie, target.id); eq(noGrant.status, 403, "no step-up"); eq((await noGrant.json()).reason, "missing");
  const policyGrant = await app.grant(supCookie, PW.sup, "security_policy_write");
  const wrongPurpose = await adminRevoke(supCookie, target.id, { token: policyGrant }); eq(wrongPurpose.status, 403, "a security_policy_write grant cannot revoke sessions"); eq((await wrongPurpose.json()).reason, "wrong_purpose");
  eq(await app.me(tc), 200, "refused attempts revoked nothing");
  const revGrant = await app.grant(supCookie, PW.sup, "session_revocation");
  eq((await app.call("PUT", `${A}/settings/office_session_ttl_hours`, { cookie: supCookie, token: revGrant, body: { value: 24, expected_version: 0 } })).status, 403, "and a session_revocation grant cannot write policy");
  eq((await adminRevoke(await app.session("adm@x.test", GOOD_NEW), target.id, { token: revGrant })).status, 403, "ochiga_admin (no team.manage) refused");
  const apiKeyTry = await adminRevoke(undefined, target.id, { token: revGrant, apiKey: "s74-api-key" }); eq(apiKeyTry.status, 403, "API-key caller refused"); eq((await apiKeyTry.json()).error, "actor_identity_required");
  eq((await app.call("POST", `${A}/session/revoke-all`, { apiKey: "s74-api-key", body: {} })).status, 403, "API key cannot sign out everywhere");
  eq((await adminRevoke(supCookie, "00000000-0000-0000-0000-000000000000", { token: revGrant })).status, 404, "unknown target");
  const selfTry = await adminRevoke(supCookie, sup.id, { token: revGrant }); eq(selfTry.status, 400, "self target"); eq((await selfTry.json()).error, "use_self_revocation");
  const gBefore = await gen("u2@x.test");
  const done = await adminRevoke(supCookie, target.id, { token: revGrant, body: { reason: "lost laptop" } }); eq(done.status, 200, "revocation by a super_admin with step-up");
  const doneBody = await done.json(); ok(doneBody.session_generation === gBefore + 1 && doneBody.scope === "every_server_running_this_version" && !JSON.stringify(doneBody).match(/token|hash/i), "result: generation, honest scope, no secrets");
  eq(await app.me(tc), 401, "target's session dead"); eq(await app.me(supCookie), 200, "the administrator's own session is untouched");
  const expiredGrantCfg = (config.stepUpTtlMs = 40); const shortGrant = await app.grant(supCookie, PW.sup, "session_revocation"); await sleep(80); config.stepUpTtlMs = 300000;
  eq((await (await adminRevoke(supCookie, target.id, { token: shortGrant })).json()).reason, "expired", "expired grant");
  // a revoked session invalidates the grants bound to it
  const g2 = await app.grant(supCookie, PW.sup, "session_revocation");
  const keepSup = await app.call("POST", `${A}/session/revoke-all`, { cookie: supCookie, body: { keep_current: true } }); const supNew = keepSup.headers.get("set-cookie").split(";")[0];
  eq((await adminRevoke(supCookie, target.id, { token: g2 })).status, 401, "old session cookie is dead");
  eq((await (await adminRevoke(supNew, target.id, { token: g2 })).json()).reason, "session_revoked", "its step-up grant is dead too, even on the re-issued session");
  eq((await app.call("POST", `${A}/session/step-up/check`, { cookie: supNew, token: g2, body: { purpose: "session_revocation" } })).status, 403);
  const revokedAdmin = await app.session("sup@x.test", PW.sup);
  // demotion kills grants as before
  const dmGrant = await app.grant(revokedAdmin, PW.sup, "session_revocation");
  await store.updateAdminUser(sup.id, { role: "ochiga_admin" }); eq((await adminRevoke(revokedAdmin, target.id, { token: dmGrant })).status, 403, "demoted administrator cannot revoke"); await store.updateAdminUser(sup.id, { role: "super_admin" });

  // ---- 9. concurrency: issue vs revoke
  const racer = await mk("racer@x.test", "racer passphrase number one 1", "ochiga_staff"); const racerPw = "racer passphrase number one 1";
  const realById = store.getAdminUserById.bind(store); let revokeInside = true;
  store.getAdminUserById = async (id) => { const u = await realById(id); if (id === racer.id && revokeInside) { revokeInside = false; await store.revokeAdminSessions(racer.id, { actor: "race" }); } return u; };
  const racedLogin = await app.login("racer@x.test", racerPw); eq(racedLogin.status, 200, "login completes");
  const racedCookie = racedLogin.headers.get("set-cookie").split(";")[0]; store.getAdminUserById = realById;
  ok(claims(racedCookie).sg < (await gen("racer@x.test")), "a revoke between the generation read and signing leaves the token behind"); eq(await app.me(racedCookie), 401, "that token is refused on first use (fail-closed)");
  const lateCookie = await app.session("racer@x.test", racerPw); eq(await app.me(lateCookie), 200, "a login after the revoke is valid");
  const results = await Promise.all([...Array.from({ length: 24 }, () => app.login("racer@x.test", racerPw)), ...Array.from({ length: 6 }, () => app.call("POST", `${A}/session/revoke-all`, { cookie: lateCookie, body: {} }))]);
  const issued = results.filter((r) => r.headers.get("set-cookie") && !/Max-Age=0/.test(r.headers.get("set-cookie"))).map((r) => r.headers.get("set-cookie").split(";")[0]);
  const finalGen = await gen("racer@x.test"); let valid = 0;
  for (const c of issued) { const st = await app.me(c); eq(st, claims(c).sg === finalGen ? 200 : 401, "every token is valid iff it carries the final generation"); if (st === 200) valid += 1; }
  ok(finalGen >= 1 + 1, "revocations applied"); ok(issued.length === 24, "all concurrent logins completed");
  const bumps = new Set(); const burst = await Promise.all(Array.from({ length: 12 }, () => store.revokeAdminSessions(racer.id, { actor: "burst" }))); burst.forEach((b) => bumps.add(b.session_generation));
  eq(bumps.size, 12, "12 simultaneous increments yield 12 distinct generations"); eq(Math.max(...bumps) - Math.min(...bumps), 11, "strictly consecutive");

  // ---- 10. legacy tokens
  const legUser = await mk("legacy@x.test", "legacy passphrase number one 1", "ochiga_staff");
  const legacyConfig = { ...config, sessionRevocationEnabled: false }; // what a pre-S7.4 instance signs: no sg
  const legacyToken = createAdminSessionToken(legUser, legacyConfig); const legacyCookie = `${config.sessionCookieName}=${encodeURIComponent(legacyToken)}`;
  ok(!("sg" in JSON.parse(Buffer.from(legacyToken.split(".")[0], "base64url"))), "legacy token has no sg");
  eq(await app.me(legacyCookie), 200, "legacy token valid at generation 0 (transition period)");
  const hz = await (await app.call("GET", "/healthz")).json(); ok(hz.session_revocation.enforcement === "active" && hz.session_revocation.legacy_tokens === "accepted" && hz.session_revocation.capability === "available", "healthz reports enforcement, legacy policy, capability");
  config.rejectLegacySessions = true; eq(await app.me(legacyCookie), 401, "legacy tokens refused once the owner rejects them"); eq(await app.me(await app.session("legacy@x.test", "legacy passphrase number one 1")), 200, "new tokens unaffected");
  eq((await (await app.call("GET", "/healthz")).json()).session_revocation.legacy_tokens, "rejected"); config.rejectLegacySessions = false;
  eq(await app.me(legacyCookie), 200, "back to accepted"); await store.revokeAdminSessions(legUser.id, { actor: "t" }); eq(await app.me(legacyCookie), 401, "any revocation kills a legacy token");
  ok((await (await app.call("GET", "/healthz")).json()).session_revocation.rejected_requests.revoked > 0, "rejections are counted by category");

  // ---- 11. rolling deployment: an instance without enforcement still accepts a revoked token
  const oldConfig = { ...config, sessionRevocationEnabled: false }; const oldApp = await client(store, oldConfig);
  const rollUser = await mk("roll@x.test", "rolling passphrase number one 1", "ochiga_staff"); const rollCookie = await app.session("roll@x.test", "rolling passphrase number one 1");
  await app.call("POST", `${A}/session/revoke-all`, { cookie: rollCookie, body: {} });
  eq(await app.me(rollCookie), 401, "an S7.4 instance refuses the revoked token"); eq(await oldApp.me(rollCookie), 200, "a pre-S7.4 instance STILL accepts it: global revocation is not effective until every instance is upgraded (or the session secret rotates)");
  eq((await (await oldApp.call("GET", "/healthz")).json()).session_revocation.enforcement, "off", "that instance reports enforcement off, so operators can see it");
  const oldIssued = await oldApp.session("roll@x.test", "rolling passphrase number one 1"); ok(!("sg" in claims(oldIssued)), "a pre-S7.4 instance issues legacy tokens"); eq(await app.me(oldIssued), 401, "which an S7.4 instance refuses once the account has been revoked (generation > 0)");
  eq((await oldApp.call("POST", `${A}/session/revoke-all`, { cookie: oldIssued, body: {} })).status, 503, "with enforcement off the revocation routes answer 503");
  await oldApp.close();

  // ---- 12. database outage and capability handling
  const realByEmail = store.getAdminUserByEmail.bind(store); const okCookie = await app.session("u1@x.test", PW.u1);
  store.getAdminUserByEmail = async () => { throw new Error("connection to db-internal.example:5432 refused password=hunter2"); };
  const down = await app.call("GET", `${A}/session/me`, { cookie: okCookie }); eq(down.status, 503, "account cannot be loaded -> 503, never 200"); const downText = await down.text();
  ok(downText.includes("session_verification_unavailable") && !/hunter2|db-internal|refused/.test(downText), "no store detail leaks");
  store.getAdminUserByEmail = realByEmail; eq(await app.me(okCookie), 200, "recovers when the store returns");
  const realById2 = store.getAdminUserById.bind(store); store.getAdminUserById = async () => { throw new Error("boom"); };
  eq((await app.login("u1@x.test", PW.u1)).status, 503, "issuance fails closed when the generation cannot be read"); store.getAdminUserById = realById2;
  const realRevoke = store.revokeAdminSessions.bind(store); const realAtomic = store.updateAdminUserRevokingSessions.bind(store); store.revokeAdminSessions = async () => { throw new Error("write failed"); }; store.updateAdminUserRevokingSessions = async () => { throw new Error("write failed"); };
  const g0 = await gen("u1@x.test"); const selfFail = await app.call("POST", `${A}/session/revoke-all`, { cookie: okCookie, body: {} }); eq(selfFail.status, 503, "failed revocation write -> 503"); eq((await selfFail.json()).error, "session_revocation_unavailable"); eq(await gen("u1@x.test"), g0, "nothing changed"); eq(await app.me(okCookie), 200);
  const pwFail = await app.call("POST", `${A}/session/password`, { cookie: okCookie, body: { current_password: PW.u1, new_password: "should never be applied 11" } }); eq(pwFail.status, 503, "password change fails closed when the bump fails");
  eq((await app.login("u1@x.test", PW.u1)).status, 200, "password unchanged"); store.revokeAdminSessions = realRevoke; store.updateAdminUserRevokingSessions = realAtomic;
  const realSupports = store.supportsSessionRevocation.bind(store); const realSupportsAtomic = store.supportsAtomicCredentialUpdate.bind(store); store.supportsSessionRevocation = async () => false; store.supportsAtomicCredentialUpdate = async () => false; // migration not applied
  eq((await app.call("POST", `${A}/session/revoke-all`, { cookie: okCookie, body: {} })).status, 503, "migration absent: revoke-all 503"); const supAbsent = await app.session("sup@x.test", PW.sup); eq((await adminRevoke(supAbsent, target.id, { token: await app.grant(supAbsent, PW.sup, "session_revocation") })).status, 503, "migration absent: admin revoke 503");
  const absentPw = await app.call("POST", `${A}/session/password`, { cookie: okCookie, body: { current_password: PW.u1, new_password: "password change before migration 22" } }); eq(absentPw.status, 200, "password flows still work before the migration"); PW.u1 = "password change before migration 22";
  eq((await (await app.call("GET", "/healthz")).json()).session_revocation.capability, "unavailable", "healthz shows the capability gap"); eq((await app.login("u1@x.test", PW.u1)).status, 200, "sign-in unaffected");
  ok(JSON.stringify(await store.listAuditEvents(2000)).includes("sessions_revocation_skipped"), "skipped revocation is audited"); store.supportsSessionRevocation = realSupports; store.supportsAtomicCredentialUpdate = realSupportsAtomic;

  // ---- 13. persistence: restart and failed disk write
  const gKnown = await gen("racer@x.test"); const stale = claims(racedCookie).sg; await app.close();
  const store2 = new FileLeadAgentsStore(filePath); await store2.init(); app = await client(store2, config);
  eq((await store2.getAdminUserByEmail("racer@x.test")).session_generation, gKnown, "generation survives a restart"); eq(await app.me(racedCookie), 401, "a revoked cookie stays dead after a restart"); ok(stale < gKnown);
  const realPersist = store2.persist.bind(store2); store2.persist = async () => { throw new Error("disk full"); };
  await assert.rejects(() => store2.revokeAdminSessions(racer.id, { actor: "t" }), /disk full/); passed += 1;
  eq((await store2.getAdminUserByEmail("racer@x.test")).session_generation, gKnown, "failed write rolled back in memory"); store2.persist = realPersist;
  const store3 = new FileLeadAgentsStore(filePath); await store3.init(); eq((await store3.getAdminUserByEmail("racer@x.test")).session_generation, gKnown, "and nothing reached disk");

  // ---- 14. administrator recovery and lockout
  const solo = await store2.ensureAdminUser({ email: "solo@x.test", password_hash: hashPassword(PW.solo), role: "super_admin", display_name: "solo", status: "active" });
  const soloCookie = await app.session("solo@x.test", PW.solo);
  eq((await app.call("POST", `${A}/session/revoke-all`, { cookie: soloCookie, body: {} })).status, 200, "the only super_admin signs out everywhere"); eq(await app.me(soloCookie), 401);
  eq((await app.login("solo@x.test", PW.solo)).status, 200, "and can sign straight back in: no lockout");
  const soloCookie2 = await app.session("solo@x.test", PW.solo);
  await bootstrapAdminUser(store2, { adminEmail: "solo@x.test", adminPassword: "recovery passphrase for solo 2026", adminRole: "super_admin", adminRecovery: true, sessionRevocationEnabled: true });
  eq(await app.me(soloCookie2), 401, "recovery ends the account's existing sessions"); eq((await app.login("solo@x.test", "recovery passphrase for solo 2026")).status, 200, "recovered password works");
  ok(JSON.stringify(await store2.listAuditEvents(2000)).includes("sessions_revoked_admin_recovery"), "recovery revocation audited");

  // ---- 15. audit and redaction
  const events = await store2.listAuditEvents(5000); const byAction = (a) => events.filter((e) => e.action === a);
  for (const a of ["sessions_revoked_self", "sessions_revoked_by_admin", "sessions_revoked_password_change", "sessions_revoked_password_reset", "sessions_revoked_admin_password_set", "sessions_revoked_status_change", "session_revocation_denied"]) ok(byAction(a).length > 0, `audit action present: ${a}`);
  const sample = byAction("sessions_revoked_by_admin")[0]; const m = sample.metadata || {};
  ok(m.request_id && m.target_user_id && m.outcome === "revoked" && Number.isInteger(m.generation_before) && m.generation_after === m.generation_before + 1 && m.at && m.reason === "lost laptop" && JSON.stringify(sample).includes("sup@x.test"), "audit: actor, target, request id, outcome, generation transition, time");
  const reasons = new Set(byAction("session_revocation_denied").map((e) => (e.metadata || {}).failure_reason)); for (const r of ["api_key_not_allowed", "forbidden", "step_up_wrong_purpose", "step_up_missing", "target_not_found", "self_target"]) ok(reasons.has(r), `denial category audited: ${r}`);
  const blob = JSON.stringify(events) + logs.join("");
  for (const secret of [SECRET, revGrant, policyGrant, g2, supCookie.split("=")[1], okCookie.split("=")[1], PW.sup, GOOD_NEW, "scrypt"]) ok(!blob.includes(secret), "audit/logs hold no session token, grant, secret, password or hash");

  await app.close();
  console.log(`S7.4 session revocation: ${passed} assertions PASS`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
