// Settings S7.5.0: authentication prerequisite hardening. Contract: docs/settings-domain/27_S7_5_0_AUTH_PREREQUISITE_HARDENING_CONTRACT.md
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer, bootstrapAdminUser } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { FileLeadAgentsStore } = require("../src/lead-agents/store-file");
const { hashPassword, createAdminSessionToken } = require("../src/lead-agents/auth");

const SECRET = "s7-5-0-dedicated-session-secret-0123456789abcdef", API_KEY = "s750-api-key", EDGE = "s750-edge-token";
const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed += 1; };
const listen = (s) => new Promise((r, j) => { s.once("error", j); s.listen(0, "127.0.0.1", () => r(s.address().port)); });
const logs = [];
for (const stream of [process.stdout, process.stderr]) { const orig = stream.write.bind(stream); stream.write = (c, ...r) => { logs.push(String(c)); return orig(c, ...r); }; }

async function client(store, config) {
  const rl = (n) => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: n });
  const server = buildServer({ config, store, rateLimiter: rl(9000), publicRateLimiter: rl(9000), officeRateLimiter: rl(9000), loginRateLimiter: rl(9000), whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] }, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const base = `http://127.0.0.1:${await listen(server)}`; const A = "/api/lead-agents/admin";
  const call = (method, p, { cookie, body, apiKey, edge, token } = {}) => fetch(`${base}${p}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(apiKey ? { "x-api-key": apiKey } : {}), ...(edge ? { "x-edge-token": edge } : {}), ...(token ? { "x-step-up-token": token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const login = (email, password) => call("POST", `${A}/session/login`, { body: { email, password } });
  const session = async (email, password) => { const r = await login(email, password); eq(r.status, 200, `login ${email}`); return r.headers.get("set-cookie").split(";")[0]; };
  const me = async (cookie) => (await call("GET", `${A}/session/me`, { cookie })).status;
  const protectedRoute = async (cookie) => (await call("GET", `${A}/users`, { cookie })).status; // any enforceAuth-protected route
  return { server, base, A, call, login, session, me, protectedRoute, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

async function main() {
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: [API_KEY], edgeAgentTokens: [EDGE], allowedOrigins: [], sessionSecret: SECRET, sessionSecretEphemeral: false };
  const { store, filePath } = await createTempStore();
  const mk = (email, pw, role) => store.ensureAdminUser({ email, password_hash: hashPassword(pw), role, display_name: email, status: "active" });
  const PW = { boss: "boss admin passphrase number 11", u: "regular user passphrase number 22", v: "victim user passphrase number 33" };
  const boss = await mk("boss@x.test", PW.boss, "super_admin"); const regular = await mk("u@x.test", PW.u, "ochiga_staff"); const victim = await mk("v@x.test", PW.v, "ochiga_staff");
  let app = await client(store, config); const A = app.A;
  const gen = async (email) => (await store.getAdminUserByEmail(email)).session_generation || 0;
  const bossCookie = await app.session("boss@x.test", PW.boss);

  // ===== 1. unified session verification: structural inventory
  const src = (f) => fs.readFileSync(path.join(__dirname, "..", "src", "lead-agents", f), "utf8");
  const callers = []; for (const f of fs.readdirSync(path.join(__dirname, "..", "src", "lead-agents")).filter((x) => x.endsWith(".js"))) { const t = src(f); const n = (t.match(/readAdminSession\(/g) || []).length; if (n) callers.push([f, n]); }
  assert.deepEqual(callers, [["auth.js", 2]]); passed += 1;                                   // the definition and the single call inside authenticateSessionCookie
  ok(/function authenticateSessionCookie[\s\S]{0,200}readAdminSession\(req, config\)/.test(src("auth.js")), "the only call is inside authenticateSessionCookie");
  ok(!/parseCookies\(/.test(src("server.js")) && !/headers\.cookie/.test(src("server.js")), "server.js never reads the cookie itself");
  const server = src("server.js"); const meStart = server.indexOf('pathname === "/api/lead-agents/admin/session/me") {'); const meBlock = server.slice(meStart, meStart + 1800);
  ok(/authenticateSessionCookie\(req, config\)/.test(meBlock) && /enrichAuthContext\(meContext, store, config\)/.test(meBlock), "/session/me uses the shared reader and the shared live-state check");
  ok((server.match(/enrichAuthContext\(/g) || []).length === 3, "enrichAuthContext has exactly one definition and two call sites (protected routes, /session/me)");
  // every writer of human-account tables is a classified call site: adding one without review fails here.
  // updateAdminUser (15; S7.5.7 added three, each writing ONLY mfa_required_after: cleared when a factor is activated (TOTP confirm, WebAuthn register verify; both behind a step-up grant or the mailbox gate) and set by the guarded administrator MFA reset route). Earlier twelve: applyCredentialChange fallback, env recovery x2, login last_login_at, MFA verify last_login_at (S7.5.3, challenge-gated), self photo, self profile, invite accept (token-gated), invite route (guarded), admin PATCH x2 (guarded), admin photo (guarded).
  // ensureAdminUser (5): env recovery create, env bootstrap, API-key fallback login (flag-gated, transitional), admin create (guarded), invite route (guarded). updateAdminInvite (1): invite route (guarded).
  const counts = Object.fromEntries(["updateAdminUser", "ensureAdminUser", "deleteAdminUser", "createAdminInvite", "updateAdminInvite", "createPasswordResetToken", "updatePasswordResetToken", "claimPasswordResetToken", "claimAdminInvite", "updateAdminUserRevokingSessions"].map((m) => [m, (server.match(new RegExp(`store\\.${m}\\(`, "g")) || []).length]));
  assert.deepEqual(counts, { updateAdminUser: 15, ensureAdminUser: 5, deleteAdminUser: 1, createAdminInvite: 1, updateAdminInvite: 1, createPasswordResetToken: 2, updatePasswordResetToken: 0, claimPasswordResetToken: 1, claimAdminInvite: 1, updateAdminUserRevokingSessions: 1 }, "UNCLASSIFIED human-account write added or removed: review it against the S7.5.0 route audit and update this inventory"); passed += 1;
  for (const marker of ["admin_user_create", "admin_user_invite", "admin_user_update", "admin_user_photo", "admin_user_reset", "admin_user_remove", "admin_user_restore", "admin_user_permanent_delete"]) ok(server.includes(`category: "${marker}"`), `human-account route guarded: ${marker}`);

  // ===== 2. unified verification: behavioural parity between /session/me and a protected route
  const parity = async (label, cookie, expected) => { const a = await app.me(cookie), b = await app.protectedRoute(cookie); eq(a, expected, `${label}: /session/me`); eq(b, expected, `${label}: protected route (same decision)`); };
  await parity("valid session", bossCookie, 200);
  const rv = await mk("rv@x.test", "revoked user passphrase 44", "super_admin"); const rvCookie = await app.session("rv@x.test", "revoked user passphrase 44"); await store.revokeAdminSessions(rv.id, { actor: "t" }); await parity("revoked generation", rvCookie, 401);
  const gh = await mk("gh@x.test", "ghost user passphrase number 55", "super_admin"); const ghCookie = await app.session("gh@x.test", "ghost user passphrase number 55"); await store.deleteAdminUser(gh.id); await mk("gh@x.test", "ghost user passphrase number 66", "super_admin"); await parity("deleted and recreated account", ghCookie, 401);
  const pc = await mk("pc@x.test", "password changed passphrase 77", "super_admin"); const pcCookie = await app.session("pc@x.test", "password changed passphrase 77"); await store.updateAdminUser(pc.id, { password_hash: hashPassword("changed behind the back phrase 88") }); await parity("password hash changed with no revocation write at all", pcCookie, 401);
  const dx = await mk("dx@x.test", "deactivated user passphrase 99", "super_admin"); const dxCookie = await app.session("dx@x.test", "deactivated user passphrase 99"); await store.updateAdminUser(dx.id, { status: "inactive" }); await parity("deactivated", dxCookie, 401);
  const lg = await mk("lg@x.test", "legacy token user passphrase 10", "super_admin"); const legacyTok = createAdminSessionToken(lg, { ...config, sessionRevocationEnabled: false }); const legacyCookie = `${config.sessionCookieName}=${encodeURIComponent(legacyTok)}`;
  await parity("legacy token accepted by default", legacyCookie, 200); config.rejectLegacySessions = true; await parity("legacy token once rejected", legacyCookie, 401); config.rejectLegacySessions = false;
  const realByEmail = store.getAdminUserByEmail.bind(store); store.getAdminUserByEmail = async () => { throw new Error("db password=hunter2"); }; await parity("store unavailable fails closed", bossCookie, 503); store.getAdminUserByEmail = realByEmail;
  await parity("recovers", bossCookie, 200);

  // ===== 3. password-state binding
  const claims = (c) => JSON.parse(Buffer.from(decodeURIComponent(c.split("=")[1]).split(".")[0], "base64url").toString());
  ok(typeof claims(bossCookie).pf === "string" && claims(bossCookie).pf.length === 32 && !JSON.stringify(claims(bossCookie)).includes("scrypt"), "token carries a 128-bit password fingerprint, never the hash");
  eq(await app.me(legacyCookie), 200, "tokens without pf stay valid (transition) until rejection is switched on");
  // password changed between credential verification and signing (the verified hash, not a re-read, is what the token binds to)
  const racer = await mk("racer@x.test", "racer old passphrase number 11", "ochiga_staff"); const realById = store.getAdminUserById.bind(store); let swapped = false;
  store.getAdminUserById = async (id) => { if (id === racer.id && !swapped) { swapped = true; await store.updateAdminUser(id, { password_hash: hashPassword("racer new passphrase number 22") }); } return realById(id); };
  const raced = await app.login("racer@x.test", "racer old passphrase number 11"); store.getAdminUserById = realById; eq(raced.status, 200, "login completes"); eq(await app.me(raced.headers.get("set-cookie").split(";")[0]), 401, "a password changed between verification and signing leaves a dead token");

  // ===== 4. THE DEMONSTRATED FAILURE: sign-in with the old password during the password-update window
  const setPw = (cookie, id, password) => app.call("PATCH", `${A}/users/${id}`, { cookie, body: { password } });
  const attack = async (label, prepare) => {
    const u = await mk(`${label}@x.test`, "old compromised passphrase 11", "ochiga_staff"); const restore = prepare ? prepare() : () => {};
    const realUpdate = store.updateAdminUser.bind(store); let attacker = null;
    if (prepare) store.updateAdminUser = async (id, patch) => { if (id === u.id && patch.password_hash && !attacker) { const r = await app.login(`${label}@x.test`, "old compromised passphrase 11"); attacker = r.headers.get("set-cookie").split(";")[0]; await sleep(5); } return realUpdate(id, patch); };
    const burst = Array.from({ length: 24 }, () => app.login(`${label}@x.test`, "old compromised passphrase 11").then((r) => (r.status === 200 ? r.headers.get("set-cookie").split(";")[0] : null)));
    const change = setPw(bossCookie, u.id, "freshly chosen passphrase 22");
    const [r, ...cookies] = await Promise.all([change, ...burst]); store.updateAdminUser = realUpdate; restore();
    eq(r.status, 200, `${label}: password set`); const held = cookies.filter(Boolean); if (attacker) held.push(attacker);
    for (const c of held) eq(await app.me(c), 401, `${label}: a cookie obtained with the OLD password is dead after the change`);
    ok(held.length > 0 || label === "atomic", `${label}: attacker sessions were obtained during the race (${held.length})`);
    eq((await app.login(`${label}@x.test`, "old compromised passphrase 11")).status, 401, `${label}: old password refused`); eq((await app.login(`${label}@x.test`, "freshly chosen passphrase 22")).status, 200, `${label}: new password works`);
  };
  await attack("atomic");                                                                                                               // atomic path, with a 24-way login burst racing the change
  const realAtomicSupport = store.supportsAtomicCredentialUpdate.bind(store);
  await attack("twostep", () => { store.supportsAtomicCredentialUpdate = async () => false; return () => { store.supportsAtomicCredentialUpdate = realAtomicSupport; }; }); // old two-step order with the window forced open: password binding closes it

  // ===== 5. THE DEMONSTRATED FAILURE: API keys on human-account routes
  const denied = async (label, r) => { eq(r.status, 403, `${label}: refused`); eq((await r.json()).error, "actor_identity_required", `${label}: reason`); };
  for (const [who, creds] of [["API key", { apiKey: API_KEY }], ["edge token", { edge: EDGE }]]) {
    await denied(`${who} create super_admin`, await app.call("POST", `${A}/users`, { ...creds, body: { email: "planted@x.test", password: "attacker chosen passphrase 44", role: "super_admin" } }));
    await denied(`${who} set administrator password`, await app.call("PATCH", `${A}/users/${boss.id}`, { ...creds, body: { password: "attacker reset passphrase 55" } }));
    await denied(`${who} change role`, await app.call("PATCH", `${A}/users/${regular.id}`, { ...creds, body: { role: "super_admin" } }));
    await denied(`${who} deactivate`, await app.call("PATCH", `${A}/users/${regular.id}`, { ...creds, body: { status: "inactive" } }));
    await denied(`${who} invite`, await app.call("POST", `${A}/users/invite`, { ...creds, body: { email: "invited@x.test", role: "super_admin" } }));
    await denied(`${who} reset link`, await app.call("POST", `${A}/users/${regular.id}/reset`, { ...creds, body: {} }));
    await denied(`${who} photo`, await app.call("POST", `${A}/users/${regular.id}/photo`, { ...creds, body: {} }));
    await denied(`${who} remove`, await app.call("POST", `${A}/users/${regular.id}/remove`, { ...creds, body: {} }));
    await denied(`${who} restore`, await app.call("POST", `${A}/users/${regular.id}/restore`, { ...creds, body: {} }));
    await denied(`${who} permanent delete`, await app.call("DELETE", `${A}/users/${regular.id}/permanent`, { ...creds }));
  }
  eq(await store.getAdminUserByEmail("planted@x.test"), null, "no account was planted"); eq((await store.getAdminUserByEmail("invited@x.test")), null, "no invite account");
  eq((await store.getAdminUserByEmail("u@x.test")).role, "ochiga_staff", "role untouched"); eq((await store.getAdminUserByEmail("u@x.test")).status, "active", "status untouched");
  eq((await app.login("boss@x.test", "attacker reset passphrase 55")).status, 401, "the administrator's password was not changed"); eq((await app.login("boss@x.test", PW.boss)).status, 200);
  eq((await app.call("GET", `${A}/users`, { apiKey: API_KEY })).status, 200, "reads stay available to API keys (existing integrations)");
  for (const [m, p] of [["POST", `${A}/session/password`], ["POST", `${A}/session/profile`], ["POST", `${A}/session/photo`], ["PATCH", `${A}/session/profile`]]) { const r = await app.call(m, p, { apiKey: API_KEY, body: { current_password: "x", new_password: "y" } }); ok(r.status >= 400, `self-service route ${m} ${p.split("/").pop()} is not usable by an API key (${r.status})`); }
  const deniedEvents = (await store.listAuditEvents(5000)).filter((e) => e.action === "human_account_change_denied"); ok(deniedEvents.length >= 20, "every refusal is audited"); ok(deniedEvents.every((e) => (e.metadata || {}).failure_reason === "api_key_not_allowed" && (e.metadata || {}).route_category && !JSON.stringify(e).match(/attacker|passphrase|scrypt/)), "refusals audited by category without payloads");

  // ===== 6. positive controls: an authorized human session still manages accounts
  const created = await app.call("POST", `${A}/users`, { cookie: bossCookie, body: { email: "newhire@x.test", password: "new hire passphrase number 11", role: "ochiga_staff" } }); eq(created.status, 201, "super_admin session creates a user");
  const nh = await store.getAdminUserByEmail("newhire@x.test"); const nhCookie = await app.session("newhire@x.test", "new hire passphrase number 11");
  eq((await app.call("PATCH", `${A}/users/${nh.id}`, { cookie: bossCookie, body: { display_name: "New Hire", role: "ochiga_staff" } })).status, 200, "profile edit by session");
  eq(await app.me(nhCookie), 200, "a non-credential edit does not sign the user out");
  eq((await setPw(bossCookie, nh.id, "reset by the administrator 22")).status, 200, "password set by session"); eq(await app.me(nhCookie), 401, "and it ends the user's old sessions (atomically)");
  const nh2 = await app.session("newhire@x.test", "reset by the administrator 22");
  eq((await app.call("PATCH", `${A}/users/${nh.id}`, { cookie: bossCookie, body: { display_name: "Renamed Hire", status: "inactive" } })).status, 200, "combined credential + profile edit"); eq((await store.getAdminUserByEmail("newhire@x.test")).display_name, "Renamed Hire"); eq(await app.me(nh2), 401);
  eq((await app.call("PATCH", `${A}/users/${nh.id}`, { cookie: bossCookie, body: { status: "active" } })).status, 200); eq((await app.call("POST", `${A}/users/${nh.id}/remove`, { cookie: bossCookie, body: {} })).status, 200); eq((await app.call("POST", `${A}/users/${nh.id}/restore`, { cookie: bossCookie, body: {} })).status, 200, "remove and restore by session");
  eq((await app.call("POST", `${A}/users/invite`, { cookie: bossCookie, body: { email: "inv2@x.test", role: "ochiga_staff" } })).status < 300, true, "invite by session");
  const afterAdmin = JSON.stringify(await store.listAuditEvents(5000)); ok(!/scrypt/.test(afterAdmin) && afterAdmin.includes("password_set"), "admin password set is audited as a fact, never as a hash");

  // ===== 7. atomic operation (file store)
  const at = await mk("at@x.test", "atomic target passphrase number 11", "ochiga_staff"); const g0 = await gen("at@x.test");
  const r1 = await store.updateAdminUserRevokingSessions(at.id, { password_hash: "salt:new", password_changed_at: "2026-10-16T00:00:00Z", status: "active", role: "super_admin", email: "evil@x.test" }, { actor: "tester" });
  ok(r1.session_generation === g0 + 1 && r1.user.password_hash === "salt:new" && r1.user.role === "ochiga_staff" && r1.user.email === "at@x.test" && r1.user.sessions_revoked_by === "tester", "one step: credentials written, generation bumped, non-credential fields ignored");
  eq(await store.updateAdminUserRevokingSessions("00000000-0000-0000-0000-000000000000", { status: "active" }, {}), null, "unknown account -> null");
  const many = await Promise.all(Array.from({ length: 30 }, (_, i) => store.updateAdminUserRevokingSessions(at.id, { password_hash: `salt:h${i}` }, { actor: `c${i}` }))); const gens = many.map((m) => m.session_generation).sort((a, b) => a - b);
  assert.deepEqual(gens, Array.from({ length: 30 }, (_, i) => g0 + 2 + i)); passed += 1;
  const realPersist = store.persist.bind(store); const snapshot = await store.getAdminUserById(at.id); const hashBefore = snapshot.password_hash, genBefore = snapshot.session_generation; store.persist = async () => { throw new Error("disk full"); };
  await assert.rejects(() => store.updateAdminUserRevokingSessions(at.id, { password_hash: "salt:never" }, {}), /disk full/); passed += 1; store.persist = realPersist;
  const afterFail = await store.getAdminUserById(at.id); ok(afterFail.password_hash === hashBefore && afterFail.session_generation === genBefore, "a failed write rolls back BOTH the hash and the generation");

  // ===== 8. reset confirmation: claims, atomic revocation, fallback, failure release
  const mkReset = async (email, token) => { const u = await store.getAdminUserByEmail(email); await store.createPasswordResetToken({ admin_user_id: u.id, email, token_hash: sha(token), requested_by: "self_service", expires_at: new Date(Date.now() + 3600e3).toISOString() }); };
  const confirm = (token, pw) => app.call("POST", `${A}/session/reset/confirm`, { body: { token, new_password: pw } });
  const rs = await mk("rs@x.test", "reset subject old passphrase 11", "ochiga_staff"); const rsCookie = await app.session("rs@x.test", "reset subject old passphrase 11"); await mkReset("rs@x.test", "tok-1");
  const rc = await confirm("tok-1", "reset subject new passphrase 22"); eq(rc.status, 200, "reset confirmed"); ok(!rc.headers.get("set-cookie"), "no session issued by a reset"); eq(await app.me(rsCookie), 401, "existing sessions die on reset");
  eq((await confirm("tok-1", "reset subject third passphrase 33")).status, 400, "the token is single use");
  ok((await store.listAuditEvents(5000)).some((e) => e.action === "sessions_revoked_password_reset" && (e.metadata || {}).atomic === true), "audited as an atomic revocation");
  await mkReset("rs@x.test", "tok-race"); const raceResults = await Promise.all(Array.from({ length: 10 }, (_, i) => confirm("tok-race", `race winner passphrase ${i} number`)));
  eq(raceResults.filter((r) => r.status === 200).length, 1, "ten simultaneous confirmations: exactly one wins"); eq(raceResults.filter((r) => r.status === 400).length, 9, "the others are refused");
  await mkReset("rs@x.test", "tok-fail"); const realAtomic = store.updateAdminUserRevokingSessions.bind(store); store.updateAdminUserRevokingSessions = async () => { throw new Error("write failed"); };
  const failed = await confirm("tok-fail", "never applied passphrase number 99"); eq(failed.status, 503, "a failed write is reported"); store.updateAdminUserRevokingSessions = realAtomic;
  eq((await confirm("tok-fail", "now applied passphrase number 100")).status, 200, "the claim was released: the same token still works after the failure");
  await mkReset("rs@x.test", "tok-fallback"); store.supportsAtomicCredentialUpdate = async () => false; const rsCookie2 = await app.session("rs@x.test", "now applied passphrase number 100");
  eq((await confirm("tok-fallback", "fallback path passphrase number 7")).status, 200, "reset works on the two-step fallback"); eq(await app.me(rsCookie2), 401, "and still revokes"); ok((await store.listAuditEvents(5000)).some((e) => e.action === "sessions_revoked_password_reset" && (e.metadata || {}).atomic === false), "fallback audited as non-atomic");
  const realRevoke = store.revokeAdminSessions.bind(store); store.revokeAdminSessions = async () => { throw new Error("write failed"); }; await mkReset("rs@x.test", "tok-closed");
  eq((await confirm("tok-closed", "must not apply passphrase number 8")).status, 503, "fallback path fails closed when the revocation cannot be written"); eq((await app.login("rs@x.test", "fallback path passphrase number 7")).status, 200, "password unchanged"); store.revokeAdminSessions = realRevoke; store.supportsAtomicCredentialUpdate = realAtomicSupport;

  // ===== 9. invitations: single use under concurrency, release on failure
  const invUser = await store.ensureAdminUser({ email: "invitee@x.test", password_hash: hashPassword(crypto.randomBytes(8).toString("hex")), role: "ochiga_staff", display_name: "invitee", status: "invited" });
  const mkInvite = (token) => store.createAdminInvite({ email: "invitee@x.test", admin_user_id: invUser.id, role: "ochiga_staff", display_name: "Invitee", token_hash: sha(token), status: "pending", invited_by: "boss@x.test", expires_at: new Date(Date.now() + 3600e3).toISOString() });
  const accept = (token, pw) => app.call("POST", `${A}/session/invite/accept`, { body: { token, password: pw } });
  await mkInvite("inv-a"); const realUpdate2 = store.updateAdminUser.bind(store); store.updateAdminUser = async () => { throw new Error("write failed"); };
  const failAccept = await accept("inv-a", "invited person passphrase 11"); ok(failAccept.status >= 500, "failed activation reported"); store.updateAdminUser = realUpdate2;
  const accepts = await Promise.all(Array.from({ length: 6 }, (_, i) => accept("inv-a", `invited person passphrase ${i} ok`))); eq(accepts.filter((r) => r.status === 200).length, 1, "the released invite works exactly once under 6 simultaneous accepts");

  // ===== 10. self password change keeps the current browser; recovery preserved
  const sc = await mk("sc@x.test", "self change old passphrase number 1", "ochiga_staff"); const scA = await app.session("sc@x.test", "self change old passphrase number 1"), scB = await app.session("sc@x.test", "self change old passphrase number 1");
  const chg = await app.call("POST", `${A}/session/password`, { cookie: scA, body: { current_password: "self change old passphrase number 1", new_password: "self change new passphrase number 2" } }); eq(chg.status, 200);
  const scNew = chg.headers.get("set-cookie").split(";")[0]; eq(await app.me(scNew), 200, "the current browser stays signed in"); eq(await app.me(scA), 401); eq(await app.me(scB), 401, "other sessions end");
  ok(!/scrypt|password_hash/.test(JSON.stringify(await chg.clone().json().catch(() => ({})))), "response carries no hash");
  const rec = await mk("rec@x.test", "recovery old passphrase number 11", "ochiga_staff"); const recCookie = await app.session("rec@x.test", "recovery old passphrase number 11");
  await store.updateAdminUser(rec.id, { status: "inactive", role: "viewer" });
  await bootstrapAdminUser(store, { adminEmail: "rec@x.test", adminPassword: "recovery new passphrase number 22", adminRole: "super_admin", adminRecovery: true, sessionRevocationEnabled: true });
  const recovered = await store.getAdminUserByEmail("rec@x.test"); ok(recovered.status === "active" && recovered.role === "super_admin", "recovery reactivates and restores the role"); eq(await app.me(recCookie), 401, "recovery ends the old sessions"); eq((await app.login("rec@x.test", "recovery new passphrase number 22")).status, 200, "recovered account signs in");
  store.updateAdminUserRevokingSessions = async () => { throw new Error("write failed"); }; await store.updateAdminUser(rec.id, { status: "inactive" });
  await bootstrapAdminUser(store, { adminEmail: "rec@x.test", adminPassword: "recovery again passphrase number 33", adminRole: "super_admin", adminRecovery: true, sessionRevocationEnabled: true }); store.updateAdminUserRevokingSessions = realAtomic;
  eq((await app.login("rec@x.test", "recovery again passphrase number 33")).status, 200, "recovery still succeeds when the revocation write fails (it must stay usable)");

  // ===== 10b. audit redaction as defence in depth (the pre-fix code wrote an admin-set password HASH into audit metadata)
  const { appendAuditRecord } = require("../src/lead-agents/audit");
  await appendAuditRecord({ store, authContext: { email: "boss@x.test" }, action: "redaction_probe", resourceType: "probe", resourceId: "p", metadata: { password_hash: "salt:leaked", nested: { Password: "pw", step_up_token: "t", keep: "visible", password_set: true }, list: [{ token: "x" }] } });
  const probe = (await store.listAuditEvents(9000)).find((e) => e.action === "redaction_probe");
  ok(probe.metadata.password_hash === "[redacted]" && probe.metadata.nested.Password === "[redacted]" && probe.metadata.nested.step_up_token === "[redacted]" && probe.metadata.list[0].token === "[redacted]" && probe.metadata.nested.keep === "visible" && probe.metadata.nested.password_set === true, "credential-bearing keys are redacted at the audit boundary; facts like password_set stay");

  // ===== 11. restart persistence and redaction
  const gKnown = await gen("at@x.test"); await app.close(); const store2 = new FileLeadAgentsStore(filePath); await store2.init();
  eq((await store2.getAdminUserByEmail("at@x.test")).session_generation, gKnown, "atomic updates survive a restart");
  app = await client(store2, config); eq(await app.me(scA), 401, "a revoked cookie stays dead after the restart");
  const blob = JSON.stringify(await store2.listAuditEvents(9000)) + logs.join("");
  for (const secret of [SECRET, API_KEY, EDGE, "scrypt", "hunter2"]) ok(!blob.includes(secret), "audit and logs hold no secret, key or hash");
  await app.close();
  console.log(`S7.5.0 prerequisite hardening: ${passed} assertions PASS`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
