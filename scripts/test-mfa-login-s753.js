// Settings S7.5.3: MFA login challenge and verification. Contract: docs/settings-domain/30_S7_5_3_MFA_LOGIN_CHALLENGE_CONTRACT.md
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { FileLeadAgentsStore } = require("../src/lead-agents/store-file");
const { hashPassword } = require("../src/lead-agents/auth");
const m = require("../src/lead-agents/mfa-crypto");

const logs = [];
for (const stream of [process.stdout, process.stderr]) { const orig = stream.write.bind(stream); stream.write = (c, ...r) => { logs.push(String(c)); return orig(c, ...r); }; }
let passed = 0;
const ok = (c, msg) => { assert.ok(c, msg); passed += 1; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); passed += 1; };
const deq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed += 1; };
const listen = (s) => new Promise((r, j) => { s.once("error", j); s.listen(0, "127.0.0.1", () => r(s.address().port)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (n) => crypto.randomBytes(n).toString("base64");
const SESSION = "s7-5-3-session-secret-0123456789abcdef-abcdefghij";
const K1 = b64(32), K2 = b64(32);
const PW = (n) => `${n} account passphrase number 7`;
const claimsOf = (cookie) => JSON.parse(Buffer.from(decodeURIComponent(cookie.split("=")[1]).split(".")[0], "base64url").toString());
const responses = []; // every response body, scanned for leaks at the end

function mfaCfg(over = {}) { return { mfaMode: "on", mfaKey: K1, mfaKeyId: "k1", mfaKeysPrevious: "", ...over }; }

async function main() {
  const { store, filePath } = await createTempStore();
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["s753-api-key-0123456789"], allowedOrigins: [], sessionSecret: SESSION, sessionSecretEphemeral: false, ...mfaCfg() };
  const A = "/api/lead-agents/admin";
  let counter = 0;
  const mkUser = async (label, role = "super_admin") => { counter += 1; return store.ensureAdminUser({ email: `${label}${counter}@x.test`, password_hash: hashPassword(PW(`${label}${counter}`)), role, display_name: label, status: "active" }); };
  const pwOf = (u) => PW(u.email.split("@")[0]);
  const lib = () => m.createMfaCrypto(config); // always built from the CURRENT config object, as the server does
  async function enrol(user, { recovery = true, keyId } = {}) {
    const id = crypto.randomUUID(); const secret = m.generateTotpSecret(); const L = lib();
    await store.createMfaCredential(user.id, { id, type: "totp", label: "Phone", ...L.encryptTotpSecret(secret, { userId: user.id, credentialId: id }) }); await store.activateMfaCredential(user.id, id);
    let batch = null; if (recovery) { batch = L.newRecoveryBatch(user.id); await store.replaceMfaRecoveryCodes(user.id, crypto.randomUUID(), batch.hmacs, { keyId: batch.key_id }); }
    return { id, secret, batch };
  }
  const code = (secret, offset = 0) => m.hotp(secret, m.totpCounter(Date.now()) + offset);

  async function startApp(loginMax = 500, cfg = config, st = store) {
    const rl = (n) => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: n });
    const server = buildServer({ config: cfg, store: st, rateLimiter: rl(9000), publicRateLimiter: rl(9000), officeRateLimiter: rl(9000), loginRateLimiter: rl(loginMax), whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] }, openaiClient: {}, toolExecutor: new ToolExecutor({ store: st, config: cfg, log: () => {}, webhooks: new WebhookDispatcher({ config: cfg }) }) });
    const base = `http://127.0.0.1:${await listen(server)}`;
    const call = async (method, p, { cookie, body, apiKey, bearer } = {}) => { const r = await fetch(`${base}${p}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(apiKey ? { "x-api-key": apiKey } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); responses.push(text); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text, headers: r.headers, cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
    return {
      server, base, call, cfg,
      login: (email, password) => call("POST", `${A}/session/login`, { body: { email, password } }),
      verify: (body) => call("POST", `${A}/session/mfa/verify`, { body }),
      me: (cookie) => call("GET", `${A}/session/me`, { cookie }),
      protectedRoute: (cookie) => call("GET", `${A}/users`, { cookie }),
      health: () => call("GET", "/healthz"),
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    };
  }
  let app = await startApp();
  const challengeFor = async (u) => { const r = await app.login(u.email, pwOf(u)); eq(r.status, 200, `password step for ${u.email}`); ok(r.json.mfa_required === true && typeof r.json.challenge_token === "string", "a challenge was issued"); return r.json.challenge_token; };
  const fullLogin = async (u, secret, offset = 0) => { const t = await challengeFor(u); const r = await app.verify({ challenge_token: t, method: "totp", code: code(secret, offset) }); eq(r.status, 200, "second factor accepted"); return r; };

  // ===== 1. the flow: correct password + correct MFA; session claims; unenrolled accounts unchanged
  const u1 = await mkUser("boss"); const e1 = await enrol(u1); const plain = await mkUser("plain");
  const step1 = await app.login(u1.email, pwOf(u1));
  ok(step1.status === 200 && step1.json.ok === false && step1.json.mfa_required === true && !step1.cookie && !step1.headers.get("set-cookie"), "password alone yields a challenge and NO cookie");
  ok(!("admin" in step1.json) && !JSON.stringify(step1.json).includes(u1.email) && !step1.json.session && step1.json.methods.join() === "totp,recovery_code" && Date.parse(step1.json.expires_at) - Date.now() <= 300_000 && Date.parse(step1.json.expires_at) > Date.now(), "no account data or authority in the challenge response; 5-minute lifetime");
  eq(step1.headers.get("cache-control"), "no-store", "challenge responses are not cacheable");
  const ch = step1.json.challenge_token;
  eq((await app.me(`${config.sessionCookieName}=${encodeURIComponent(ch)}`)).status, 401, "the challenge presented as a session cookie is refused (/session/me)"); eq((await app.protectedRoute(`${config.sessionCookieName}=${encodeURIComponent(ch)}`)).status, 401, "…and on every protected route");
  eq((await app.call("GET", `${A}/users`, { bearer: ch })).status, 401, "…as a Bearer token"); eq((await app.call("GET", `${A}/users`, { apiKey: ch })).status, 401, "…as an API key");
  const done = await app.verify({ challenge_token: ch, method: "totp", code: code(e1.secret) }); ok(done.status === 200 && done.json.ok === true && done.cookie && done.json.admin.email === u1.email && done.json.mfa.verified === true && done.json.mfa.method === "totp", "correct password + correct TOTP: governed session");
  const sc = claimsOf(done.cookie); ok(sc.mf === 1 && Math.abs(sc.mft - Date.now()) < 5000 && sc.sg === 0 && typeof sc.pf === "string" && sc.pf.length === 32 && sc.email === u1.email, "session claims: mf, mft, sg and pf are all present");
  const maxAge = Number((done.headers.get("set-cookie").match(/Max-Age=(\d+)/) || [])[1]); ok(Math.abs(maxAge * 1000 - 604_800_000) < 1500 && Math.abs(sc.exp - Date.now() - 604_800_000) < 5000 && /HttpOnly/.test(done.headers.get("set-cookie")) && /SameSite=Lax/.test(done.headers.get("set-cookie")), "S7.3 default duration and cookie protections preserved");
  eq((await app.protectedRoute(done.cookie)).status, 200, "the session works"); const me = await app.me(done.cookie); ok(me.status === 200 && me.json.mfa.verified === true, "/session/me reports MFA verified");
  await store.writeRuntimeSetting("office_session_ttl_hours", 48, "test", { expectedVersion: 0, requestId: "t" }); const dur = await fullLogin(u1, e1.secret, 1); const dsc = claimsOf(dur.cookie); ok(Math.abs(Number(dur.headers.get("set-cookie").match(/Max-Age=(\d+)/)[1]) * 1000 - 48 * 3_600_000) < 1500 && Math.abs(dsc.exp - Date.now() - 48 * 3_600_000) < 5000, "the governed S7.3 duration setting is honoured and token expiry equals cookie Max-Age");
  const uProd = await mkUser("prod"); const eProd = await enrol(uProd, { recovery: false }); const prod = await startApp(500, { ...config, environment: "production" }); const prodStep = await prod.login(uProd.email, pwOf(uProd)); const prodDone = await prod.verify({ challenge_token: prodStep.json.challenge_token, method: "totp", code: code(eProd.secret) }); ok(prodDone.status === 200 && /Secure/.test(prodDone.headers.get("set-cookie")), "production cookies are Secure"); await prod.close();
  const pl = await app.login(plain.email, pwOf(plain)); ok(pl.status === 200 && pl.cookie && pl.json.admin.email === plain.email && !("mfa_required" in pl.json), "an account without a factor signs in exactly as before"); const plc = claimsOf(pl.cookie); ok(!("mf" in plc) && (await app.me(pl.cookie)).json.mfa.verified === false, "…with a password-only session (no mf claim)");
  eq((await app.protectedRoute(pl.cookie)).status, 200, "and it keeps working");

  // ===== 2. account enumeration: failures before the password is proven are unchanged and identical
  const wrongPw = await app.login(u1.email, "definitely wrong passphrase 1"), unknown = await app.login("nobody@x.test", "definitely wrong passphrase 1"), plainWrong = await app.login(plain.email, "definitely wrong passphrase 1");
  ok(wrongPw.status === 401 && unknown.status === 401 && plainWrong.status === 401 && wrongPw.text === unknown.text && unknown.text === plainWrong.text, "enrolled, unknown and unenrolled accounts give the identical 401 for a wrong password");
  const forged = await app.verify({ challenge_token: `${Buffer.from(JSON.stringify({ uid: u1.id })).toString("base64url")}.${"0".repeat(64)}`, method: "totp", code: "123456" }), garbage = await app.verify({ challenge_token: "garbage", method: "totp", code: "123456" }), unknownSubject = await app.verify({ challenge_token: `${Buffer.from(JSON.stringify({ uid: "00000000-0000-4000-8000-000000000000" })).toString("base64url")}.${"0".repeat(64)}`, method: "totp", code: "123456" });
  ok(forged.status === 401 && garbage.status === 401 && unknownSubject.status === 401 && forged.text === garbage.text && garbage.text === unknownSubject.text, "a forged token for a real account, garbage, and a token for an unknown account are indistinguishable"); eq(forged.json.error, "mfa_failed");
  eq((await app.verify({})).status, 401, "empty body: generic failure"); eq((await app.verify({ challenge_token: 12345, method: "totp", code: "1" })).status, 401, "non-string challenge");

  // ===== 3. wrong factor, persisted counter and lockout
  const u2 = await mkUser("wrong"); const e2 = await enrol(u2); let t2 = await challengeFor(u2);
  for (let i = 1; i <= 4; i += 1) { const r = await app.verify({ challenge_token: t2, method: "totp", code: "000000" }); ok(r.status === 401 && r.json.error === "mfa_failed" && !r.cookie, `wrong code ${i}: generic failure, no session`); }
  eq((await store.getMfaLockState(u2.id)).failed_attempts, 4, "the failures are persisted per account");
  const r5 = await app.verify({ challenge_token: t2, method: "totp", code: "000000" }); ok(r5.status === 429 && r5.json.error === "mfa_locked" && r5.json.retry_after_seconds > 50 && r5.json.retry_after_seconds <= 60 && r5.headers.get("retry-after"), "the 5th failure locks the account for ~1 minute");
  const lockedGood = await app.verify({ challenge_token: t2, method: "totp", code: code(e2.secret) }); ok(lockedGood.status === 429 && !lockedGood.cookie, "even the CORRECT code is refused while locked"); eq((await store.getMfaLockState(u2.id)).failed_attempts, 5, "attempts made while locked are not counted (no lock-extension by hammering)"); eq((await store.getMfaCredentialSecret(u2.id, e2.id)).totp_last_step, 0, "and the locked attempt did not consume the step");
  await store.updateAdminUser(u2.id, { mfa_locked_until: new Date(Date.now() - 1000).toISOString() });
  for (let i = 0; i < 5; i += 1) await app.verify({ challenge_token: t2, method: "totp", code: "000000" }); const l10 = await store.getMfaLockState(u2.id); ok(l10.failed_attempts >= 6 && l10.failed_attempts <= 10, "failures after a lock expires keep accumulating");
  await store.updateAdminUser(u2.id, { mfa_failed_attempts: 9, mfa_locked_until: null }); const r10 = await app.verify({ challenge_token: t2, method: "totp", code: "000000" }); ok(r10.status === 429 && r10.json.retry_after_seconds > 800, "the 10th failure locks for ~15 minutes");
  await store.updateAdminUser(u2.id, { mfa_locked_until: new Date(Date.now() - 1000).toISOString() }); const good2 = await app.verify({ challenge_token: t2, method: "totp", code: code(e2.secret) }); ok(good2.status === 200 && good2.cookie, "after the lock expires the right code works"); deq(await store.getMfaLockState(u2.id), { failed_attempts: 0, locked_until: null }, "success clears the counter and lock");

  // ===== 4. replay protection
  const u3 = await mkUser("replay"); const e3 = await enrol(u3); const c3 = code(e3.secret); const t3a = await challengeFor(u3); eq((await app.verify({ challenge_token: t3a, method: "totp", code: c3 })).status, 200, "first use accepted");
  const t3b = await challengeFor(u3); const rep = await app.verify({ challenge_token: t3b, method: "totp", code: c3 }); ok(rep.status === 401 && rep.json.error === "mfa_failed" && !rep.cookie, "the same code on a fresh challenge is a replay and is refused"); const c3b = code(e3.secret, 1); eq((await app.verify({ challenge_token: t3b, method: "totp", code: c3b })).status, 200, "the next step's code works");
  ok((await store.listMfaCredentials(u3.id)).length === 1 && (await store.getMfaCredentialSecret(u3.id, e3.id)).totp_last_step === m.totpCounter(Date.now()) + 1, "replay state lives in the S7.5.1 store counter");
  const u4 = await mkUser("race"); const e4 = await enrol(u4); const t4 = await challengeFor(u4); const c4 = code(e4.secret); const burst = await Promise.all(Array.from({ length: 12 }, () => app.verify({ challenge_token: t4, method: "totp", code: c4 })));
  eq(burst.filter((r) => r.status === 200).length, 1, "12 simultaneous submissions of one code: exactly ONE session"); ok(burst.filter((r) => r.status === 200 && r.cookie).length === 1 && burst.filter((r) => r.status !== 200).every((r) => [401, 429].includes(r.status) && !r.cookie), "everything else is refused without a cookie");

  // ===== 5. recovery codes
  const u5 = await mkUser("recover"); const e5 = await enrol(u5); const first = await fullLogin(u5, e5.secret); const older = first.cookie; ok((await app.protectedRoute(older)).status === 200, "an MFA session exists before the recovery code is used");
  const rcTyped = e5.batch.codes[0].toLowerCase().replace("-", " "); const rcStep = await challengeFor(u5); const rc = await app.verify({ challenge_token: rcStep, method: "recovery_code", code: rcTyped });
  ok(rc.status === 200 && rc.cookie && rc.json.mfa.method === "recovery_code" && rc.json.mfa.recovery_codes_remaining === 9 && claimsOf(rc.cookie).mf === 1, "a recovery code (typed loosely) signs in with MFA claims and reports how many remain");
  eq((await app.protectedRoute(older)).status, 401, "using a recovery code ends every OTHER session (generation bump)"); eq((await app.protectedRoute(rc.cookie)).status, 200, "the new session is valid at the new generation"); eq(claimsOf(rc.cookie).sg, 1);
  const rc2 = await app.verify({ challenge_token: await challengeFor(u5), method: "recovery_code", code: e5.batch.codes[0] }); ok(rc2.status === 401 && rc2.json.error === "mfa_failed" && !rc2.cookie, "a recovery code works once");
  const t5 = await challengeFor(u5); const codeBurst = await Promise.all(Array.from({ length: 10 }, () => app.verify({ challenge_token: t5, method: "recovery_code", code: e5.batch.codes[1] }))); eq(codeBurst.filter((r) => r.status === 200).length, 1, "10 simultaneous uses of one recovery code: exactly one session");
  await store.clearMfaFailures(u5.id); // the burst legitimately locked the account (9 refused attempts)
  eq((await app.verify({ challenge_token: await challengeFor(u5), method: "recovery_code", code: "not a real code" })).status, 401, "malformed recovery code: generic failure");
  const events = await store.listAuditEvents(9000); for (const a of ["mfa_challenge_issued", "mfa_verified", "mfa_failed", "mfa_locked", "mfa_recovery_code_used", "sessions_revoked_mfa_recovery_code"]) ok(events.some((e) => e.action === a), `audit action recorded: ${a}`);
  const recAudit = events.find((e) => e.action === "mfa_recovery_code_used"); ok(recAudit.metadata.request_id && recAudit.metadata.recovery_codes_remaining !== undefined && JSON.stringify(recAudit).includes(u5.email), "recovery-code audit: actor, request id, remaining count");

  // ===== 6. challenge failures
  const u6 = await mkUser("chal"); const e6 = await enrol(u6, { recovery: false }); const L = lib(); const live = await store.getAdminUserById(u6.id); const send = (token, over = {}) => app.verify({ challenge_token: token, method: "totp", code: code(e6.secret, 1), ...over });
  const old = L.issueChallengeToken({ user: live, purpose: "login", nowMs: Date.now() - 600_000 }); const expired = await send(old.token); ok(expired.status === 401 && expired.json.error === "mfa_challenge_expired" && !expired.cookie, "an expired challenge is refused (and says to sign in again)");
  const fresh6 = L.issueChallengeToken({ user: live, purpose: "login" }).token; const [pl6, sg6] = fresh6.split("."); const cl = JSON.parse(Buffer.from(pl6, "base64url")); const re = (c) => Buffer.from(JSON.stringify(c)).toString("base64url");
  for (const [label, token] of [["extended expiry", `${re({ ...cl, exp: cl.exp + 9e8 })}.${sg6}`], ["tampered signature", `${pl6}.${sg6.replace(/.$/, sg6.endsWith("0") ? "1" : "0")}`], ["signed with the raw session secret", `${pl6}.${crypto.createHmac("sha256", SESSION).update(pl6).digest("hex")}`], ["signed with the MFA key", `${pl6}.${crypto.createHmac("sha256", Buffer.from(K1, "base64")).update(pl6).digest("hex")}`], ["unsigned", pl6], ["extra segment", `${fresh6}.x`], ["enroll-purpose token", L.issueChallengeToken({ user: live, purpose: "enroll" }).token], ["token for another account", `${re({ ...cl, uid: u1.id })}.${sg6}`]]) { const r = await send(token); ok(r.status === 401 && r.json.error === "mfa_failed" && !r.cookie, `refused: ${label}`); }
  eq((await store.getMfaLockState(u6.id)).failed_attempts, 0, "forged or invalid challenges are NOT counted against the real person's lock (an attacker cannot lock a victim out)");
  const staleStep = await send(L.issueChallengeToken({ user: live, purpose: "login" }).token); eq(staleStep.status, 200, "a good challenge works"); // consumes step+1
  const pwChallenge = L.issueChallengeToken({ user: await store.getAdminUserById(u6.id), purpose: "login" }).token; await store.updateAdminUser(u6.id, { password_hash: hashPassword("changed afterwards passphrase 99") }); const pwChanged = await send(pwChallenge, { code: code(e6.secret, 1) }); ok(pwChanged.status === 401 && pwChanged.json.error === "mfa_challenge_expired", "a password change kills pending challenges");
  const u6b = await mkUser("revoke"); const e6b = await enrol(u6b); const rvT = await challengeFor(u6b); await store.revokeAdminSessions(u6b.id, { actor: "t" }); const rv = await app.verify({ challenge_token: rvT, method: "totp", code: code(e6b.secret) }); ok(rv.status === 401 && rv.json.error === "mfa_challenge_expired" && !rv.cookie, "a session revocation kills pending challenges");
  const u6c = await mkUser("inactive"); const e6c = await enrol(u6c); const inT = await challengeFor(u6c); await store.updateAdminUser(u6c.id, { status: "inactive" }); eq((await app.verify({ challenge_token: inT, method: "totp", code: code(e6c.secret) })).status, 401, "a deactivated account cannot complete a challenge");
  const u6d = await mkUser("deleted"); const e6d = await enrol(u6d); const dT = await challengeFor(u6d); await store.deleteAdminUser(u6d.id); eq((await app.verify({ challenge_token: dT, method: "totp", code: code(e6d.secret) })).status, 401, "a deleted account cannot complete a challenge");
  const u6e = await mkUser("badreq"); const e6e = await enrol(u6e); const brT = await challengeFor(u6e);
  for (const [label, body] of [["no method", { code: "123456" }], ["unknown method", { method: "sms", code: "123456" }], ["no code", { method: "totp" }], ["numeric code", { method: "totp", code: 123456 }], ["oversized code", { method: "totp", code: "1".repeat(200) }]]) { const r = await app.verify({ challenge_token: brT, ...body }); ok(r.status === 401 && !r.cookie, `refused: ${label}`); }
  const wa = await app.verify({ challenge_token: brT, method: "webauthn", code: "x" }); ok(wa.status === 401 && wa.json.error === "mfa_failed" && !wa.cookie, "a WebAuthn attempt without an assertion payload is a generic refusal (the ceremony itself is covered by S7.5.5)");
  const u7 = await mkUser("other"); const e7 = await enrol(u7); const crossT = await challengeFor(u6e); const cross = await app.verify({ challenge_token: crossT, method: "totp", code: code(e7.secret) }); ok(cross.status === 401 && !cross.cookie, "another account's valid code does not complete this account's challenge"); await store.clearMfaFailures(u6e.id);

  // ===== 7. password-only bypass attempts
  const u8 = await mkUser("bypass"); const preCookie = (await app.login(u8.email, pwOf(u8))).cookie; ok(preCookie, "(setup) a password-only session exists before enrolment"); eq((await app.protectedRoute(preCookie)).status, 200); const e8 = await enrol(u8);
  const stale = await app.protectedRoute(preCookie); ok(stale.status === 401 && stale.json.error === "mfa_required", "once the account has a factor, its password-only (mf=0) cookie is refused on protected routes"); const staleMe = await app.me(preCookie); ok(staleMe.status === 401 && staleMe.json.error === "mfa_required", "…and on /session/me (same verifier)");
  const good8 = await fullLogin(u8, e8.secret); eq((await app.protectedRoute(good8.cookie)).status, 200, "the MFA session passes the same check");
  const cfgSessions = { ...createConfig(), sessionSecret: SESSION, sessionSecretEphemeral: false }; const forgedClaims = { ...claimsOf(preCookie), mf: 1, mft: Date.now() }; const forgedPayload = Buffer.from(JSON.stringify(forgedClaims)).toString("base64url"); const origSig = decodeURIComponent(preCookie.split("=")[1]).split(".")[1];
  eq((await app.protectedRoute(`${config.sessionCookieName}=${encodeURIComponent(`${forgedPayload}.${origSig}`)}`)).status, 401, "adding mf=1 to a real cookie breaks its signature");
  eq((await app.protectedRoute(`${config.sessionCookieName}=${encodeURIComponent(`${forgedPayload}.${crypto.createHmac("sha256", "wrong-secret").update(forgedPayload).digest("hex")}`)}`)).status, 401, "a self-signed mf=1 cookie is refused");
  const apiFallback = await startApp(500, { ...config, allowApiKeyPasswordLogin: true }); const fb = await apiFallback.login("minted@x.test", config.apiKeys[0]); eq(fb.status, 401, "with MFA on the API-key-as-password login is refused (it would mint a session without a second factor)"); eq(await store.getAdminUserByEmail("minted@x.test"), null, "and no account is created"); const fbHealth = await apiFallback.health(); ok(fbHealth.status === 503 && fbHealth.json.mfa.problems.includes("mfa_enabled_with_api_key_login"), "readiness reports the conflict"); await apiFallback.close();
  eq((await app.call("POST", `${A}/session/step-up`, { body: { password: pwOf(u8), purpose: "security_policy_write" } })).status, 401, "protected endpoints do not accept a bare password");

  // ===== 8. rate limiting
  const lim = await startApp(4); const u9 = await mkUser("limit"); const e9 = await enrol(u9); const limT = (await lim.login(u9.email, pwOf(u9))).json.challenge_token; const l1 = L.issueChallengeToken({ user: await store.getAdminUserById(u9.id), purpose: "login" }).token;
  const limitResults = []; for (let i = 0; i < 6; i += 1) limitResults.push((await lim.verify({ challenge_token: i % 2 ? limT : l1, method: "totp", code: "000000" })).status);
  ok(limitResults.slice(0, 4).every((s) => s === 401) && limitResults.slice(4).every((s) => s === 429), `the shared login limiter applies to verification (${limitResults.join(",")})`); const strict = await lim.verify({ challenge_token: limT, method: "totp", code: code(e9.secret) }); ok(strict.status === 429 && strict.json.error === "login_rate_limit_exceeded" && !strict.cookie, "once limited, even the right code is refused until the window passes"); await lim.close();

  // ===== 9. database outages and key faults fail closed
  const u10 = await mkUser("outage"); const e10 = await enrol(u10); const sess10 = await fullLogin(u10, e10.secret);
  const stub = (obj, name, impl) => { const orig = obj[name]; obj[name] = impl; return () => { obj[name] = orig; }; };
  let restore = stub(store, "hasActiveMfa", async () => { throw new Error("db down password=hunter2"); });
  const outLogin = await app.login(u10.email, pwOf(u10)); ok(outLogin.status === 503 && outLogin.json.error === "mfa_verification_unavailable" && !outLogin.cookie && !outLogin.text.includes("hunter2"), "login: cannot tell whether MFA applies -> 503, never password-only");
  const outPlain = await app.login(plain.email, pwOf(plain)); eq(outPlain.status, 503, "…for every account while MFA is on (it cannot be ruled out)"); const outSession = await app.protectedRoute(sess10.cookie); eq(outSession.status, 503, "a live session cannot be verified either: 503, not accepted"); eq((await app.me(sess10.cookie)).status, 503); restore();
  const realByEmail = store.getAdminUserByEmail.bind(store); store.getAdminUserByEmail = async () => { throw new Error("connect ECONNREFUSED db-internal.example:5432 password=hunter2"); };
  const accountDown = await app.login(u10.email, pwOf(u10)); ok(accountDown.status === 503 && accountDown.json.error === "sign_in_unavailable" && !accountDown.cookie && !/ECONNREFUSED|db-internal|hunter2/.test(accountDown.text), "the account store failing at the password step: generic 503, no internal address, never a session"); store.getAdminUserByEmail = realByEmail;
  eq((await app.protectedRoute(sess10.cookie)).status, 200, "service recovers when the store does"); const t10 = await challengeFor(u10);
  for (const [name, impl] of [["getMfaLockState", async () => { throw new Error("db down"); }], ["getActiveTotpCredential", async () => { throw new Error("db down"); }], ["consumeTotpStep", async () => { throw Object.assign(new Error("mfa_store_error"), { code: "mfa_store_error" }); }], ["getMfaCredentialSecret", async () => { throw Object.assign(new Error("mfa_store_unreachable"), { code: "mfa_store_unreachable" }); }]]) { restore = stub(store, name, impl); const r = await app.verify({ challenge_token: t10, method: "totp", code: code(e10.secret, 1) }); ok(r.status === 503 && !r.cookie && !r.text.includes("db down"), `${name} failing -> 503, no session, no detail`); restore(); }
  const before10 = (await store.getMfaLockState(u10.id)).failed_attempts; restore = stub(store, "recordMfaFailure", async () => { throw new Error("db down"); }); const rf = await app.verify({ challenge_token: t10, method: "totp", code: "000000" }); ok(rf.status === 503 && !rf.cookie, "a failure that cannot be recorded is not silently accepted"); restore(); eq((await store.getMfaLockState(u10.id)).failed_attempts, before10, "(nothing recorded)");
  restore = stub(store, "getAdminUserById", async () => { throw new Error("db down"); }); eq((await app.verify({ challenge_token: t10, method: "totp", code: "000000" })).status, 503, "account lookup failing -> 503"); restore();
  const tamper = store.state.admin_mfa_credentials.find((c) => c.id === e10.id); const goodCt = tamper.secret_ciphertext; tamper.secret_ciphertext = Buffer.from(goodCt, "base64").map((b, i) => (i === 3 ? b ^ 1 : b)).toString("base64");
  const bad10 = await app.verify({ challenge_token: t10, method: "totp", code: code(e10.secret, 1) }); ok(bad10.status === 503 && bad10.json.error === "mfa_unavailable" && !bad10.cookie, "a stored secret that no longer decrypts fails closed (503), it does not fall back to password-only"); eq((await store.getMfaLockState(u10.id)).failed_attempts, before10, "and is a server fault, not counted against the person"); tamper.secret_ciphertext = goodCt;
  const badKey = await startApp(500, { ...config, mfaKey: b64(16) }); const bk = await badKey.login(u10.email, pwOf(u10)); ok(bk.status === 503 && bk.json.error === "mfa_unavailable" && !bk.cookie && !bk.json.challenge_token, "MFA on with an invalid key: an enrolled account cannot sign in at all (no challenge, no password-only)"); eq((await badKey.login(plain.email, pwOf(plain))).status, 200, "accounts without a factor are unaffected"); eq((await badKey.health()).status, 503, "and /healthz is not ready"); const bkVerify = await badKey.verify({ challenge_token: t10, method: "totp", code: "123456" }); eq(bkVerify.status, 503); await badKey.close();
  restore = stub(store, "supportsMfa", async () => false); const noSchema = await app.health(); ok(noSchema.status === 503 && noSchema.json.mfa.schema === "unavailable", "MFA on but the schema unavailable: not ready"); restore();

  // ===== 10. key rotation
  const u11 = await mkUser("rotate"); const e11 = await enrol(u11); // TOTP + recovery codes under k1
  const cfgK2 = { ...config, ...mfaCfg({ mfaKey: K2, mfaKeyId: "k2", mfaKeysPrevious: `k1:${K1}` }) }; const rot = await startApp(500, cfgK2);
  const rotChallenge = (await rot.login(u11.email, pwOf(u11))).json.challenge_token; eq((await rot.verify({ challenge_token: rotChallenge, method: "totp", code: code(e11.secret) })).status, 200, "after the key is rotated, a TOTP secret still under the previous key verifies");
  ok(JSON.stringify(await store.listMfaRecoveryKeyIds(u11.id)) === JSON.stringify(["k1"]), "recovery codes record the key they were hashed under"); const rotLib = m.createMfaCrypto(cfgK2); const blocking0 = await rotLib.recoveryCodesBlockingRetirement({ store }); ok(blocking0 >= 10, "the count is store-wide (a key can be retired only when NO account depends on it) and includes this account's 10 codes");
  eq((await rot.verify({ challenge_token: (await rot.login(u11.email, pwOf(u11))).json.challenge_token, method: "recovery_code", code: e11.batch.codes[0] })).status, 200, "a recovery code hashed under the previous key works while it is kept"); eq(await rotLib.recoveryCodesBlockingRetirement({ store }), blocking0 - 1, "using a code reduces the count");
  const rotated = await rotLib.rotateCredentialSecrets({ store }); ok(rotated.rotated === rotated.scanned && rotated.rotated >= 1 && rotated.failed === 0 && rotated.skipped === 0, `every enrolled TOTP secret is re-encrypted under the new key (${rotated.rotated} credentials, counts only)`);
  const regen = rotLib.newRecoveryBatch(u11.id); await store.replaceMfaRecoveryCodes(u11.id, crypto.randomUUID(), regen.hmacs, { keyId: regen.key_id }); eq(await rotLib.recoveryCodesBlockingRetirement({ store }), blocking0 - 1 - 9, "regenerating this account's codes under the new key removes its dependence on the old one (other accounts must do the same before the old key can be dropped)");
  const retired = await startApp(500, { ...config, ...mfaCfg({ mfaKey: K2, mfaKeyId: "k2" }) }); eq((await retired.verify({ challenge_token: (await retired.login(u11.email, pwOf(u11))).json.challenge_token, method: "totp", code: code(e11.secret, 1) })).status, 200, "the old key can now be dropped: TOTP still verifies"); eq((await retired.verify({ challenge_token: (await retired.login(u11.email, pwOf(u11))).json.challenge_token, method: "recovery_code", code: regen.codes[0] })).status, 200, "and the regenerated recovery codes work under the new key alone"); await retired.close();
  const u12 = await mkUser("orphan"); const e12 = await enrol(u12, { recovery: false }); const orphan = await startApp(500, { ...config, ...mfaCfg({ mfaKey: K2, mfaKeyId: "k2" }) }); const orT = (await orphan.login(u12.email, pwOf(u12))).json.challenge_token; const orV = await orphan.verify({ challenge_token: orT, method: "totp", code: code(e12.secret) }); ok(orV.status === 503 && orV.json.error === "mfa_unavailable" && !orV.cookie, "a key retired too early (secret not rotated): fail closed with 503, never password-only"); await orphan.close(); await rot.close();

  // ===== 11. sessions keep their MFA proof when re-issued
  const u13 = await mkUser("reissue"); const e13 = await enrol(u13, { recovery: false }); const s13 = await fullLogin(u13, e13.secret);
  const keep = await app.call("POST", `${A}/session/revoke-all`, { cookie: s13.cookie, body: { keep_current: true } }); ok(keep.status === 200 && claimsOf(keep.cookie).mf === 1 && Math.abs(claimsOf(keep.cookie).mft - claimsOf(s13.cookie).mft) < 1000, "revoke-all keep_current carries the MFA proof over"); eq((await app.protectedRoute(keep.cookie)).status, 200); eq((await app.protectedRoute(s13.cookie)).status, 401);
  const chg = await app.call("POST", `${A}/session/password`, { cookie: keep.cookie, body: { current_password: pwOf(u13), new_password: "brand new passphrase for reissue 55" } }); ok(chg.status === 200 && claimsOf(chg.cookie).mf === 1, "a password change re-issues the browser's session with MFA proof intact"); eq((await app.protectedRoute(chg.cookie)).status, 200, "and it is accepted (not bounced to mfa_required)");
  const out = await app.call("POST", `${A}/session/revoke-all`, { cookie: chg.cookie, body: {} }); eq(out.status, 200); eq((await app.login(u13.email, "brand new passphrase for reissue 55")).json.mfa_required, true, "after signing out everywhere the next sign-in needs the second factor again");

  // ===== 12. mode off, readiness, restart
  const offCfg = { ...config, mfaMode: "off" }; const off = await startApp(500, offCfg); const offLogin = await off.login(u1.email, pwOf(u1)); ok(offLogin.status === 200 && offLogin.cookie && !offLogin.json.mfa_required, "MFA off (default): password-only login works for everyone (declared downgrade)"); const offHealth = await off.health(); ok(offHealth.status === 200 && offHealth.json.mfa.mode === "off" && offHealth.json.mfa.enrolled_accounts >= 8, "…and /healthz shows how many enrolled accounts that ignores"); eq((await off.verify({ challenge_token: ch, method: "totp", code: code(e1.secret) })).status, 503, "the verify endpoint does not exist in effect when MFA is off"); eq((await off.protectedRoute(offLogin.cookie)).status, 200, "a password-only session is accepted while MFA is off"); await off.close();
  const onHealth = await app.health(); ok(onHealth.status === 200 && onHealth.json.mfa.mode === "on" && onHealth.json.mfa.schema === "available" && onHealth.json.mfa.enrolled_accounts >= 8, "ready with MFA on");
  const replayCode = c3b; await app.close(); const store2 = new FileLeadAgentsStore(filePath); await store2.init(); app = await startApp(500, cfgK2, store2); // (every TOTP secret was rotated to k2 in section 10, so the restarted server runs the rotated key ring)
  const t3c = (await app.login(u3.email, pwOf(u3))).json.challenge_token; const afterRestart = await app.verify({ challenge_token: t3c, method: "totp", code: replayCode }); ok(afterRestart.status === 401 && !afterRestart.cookie, `after a restart a consumed code is still refused: replay state is persistent (got ${afterRestart.status} ${afterRestart.text.slice(0, 120)})`);
  eq((await store2.getMfaLockState(u2.id)).failed_attempts, 0); ok((await store2.listMfaCredentials(u1.id)).length === 1, "credentials survive the restart");

  // ===== 13. redaction
  const secrets = [K1, K2, SESSION, e1.secret.toString("base64"), m.base32Encode(e1.secret), e5.batch.codes[0], e5.batch.codes[0].replace("-", ""), e5.batch.hmacs[0], ch, rcStep, goodCt, ...e1.batch.codes.slice(0, 2)];
  const everything = responses.join("\n") + logs.join("\n") + JSON.stringify(await store2.listAuditEvents(20000));
  for (const s of secrets) ok(!everything.includes(s) || s === ch /* the challenge is returned ONCE to its owner by design */ || s === rcStep, `not leaked: ${String(s).slice(0, 8)}…`);
  const challengeEchoes = (JSON.stringify(await store2.listAuditEvents(20000)) + logs.join("")).includes(ch); ok(!challengeEchoes, "challenge tokens never reach the audit log or server logs");
  ok(!/scrypt/.test(JSON.stringify(await store2.listAuditEvents(20000))), "no password hash in audit");
  await app.close();
  console.log(`S7.5.3 MFA login challenge and verification: ${passed} assertions PASS`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
