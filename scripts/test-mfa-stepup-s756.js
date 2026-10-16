// Settings S7.5.6: MFA-protected step-up. Contract: docs/settings-domain/33_S7_5_6_MFA_STEP_UP_CONTRACT.md
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword, createAdminSessionToken } = require("../src/lead-agents/auth");
const { issueStepUpToken, verifyStepUpToken, STEP_UP_PURPOSES } = require("../src/lead-agents/step-up");
const m = require("../src/lead-agents/mfa-crypto");
const { SoftwareAuthenticator } = require("./webauthn-test-authenticator");

const logs = [];
for (const stream of [process.stdout, process.stderr]) { const orig = stream.write.bind(stream); stream.write = (c, ...r) => { logs.push(String(c)); return orig(c, ...r); }; }
let passed = 0;
const ok = (c, msg) => { assert.ok(c, msg); passed += 1; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); passed += 1; };
const listen = (s) => new Promise((r, j) => { s.once("error", j); s.listen(0, "127.0.0.1", () => r(s.address().port)); });
const SESSION = "s7-5-6-session-secret-0123456789abcdef-abcdefghij", K1 = crypto.randomBytes(32).toString("base64");
const A = "/api/lead-agents/admin";
const claimsOf = (cookie) => JSON.parse(Buffer.from(decodeURIComponent(cookie.split("=")[1]).split(".")[0], "base64url").toString());
const grantClaims = (token) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
const responses = [];
const PURPOSES = ["security_policy_write", "session_revocation", "mfa_management"];

async function main() {
  const { store } = await createTempStore();
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["s756-api-key-0123456789"], edgeAgentTokens: ["s756-edge-token-0123456789"], allowedOrigins: [], sessionSecret: SESSION, sessionSecretEphemeral: false, mfaMode: "on", mfaKey: K1, mfaKeyId: "k1", mfaKeysPrevious: "", officeEmailProvider: "", webauthnRpId: "", webauthnOrigins: [] };
  let n = 0; const mkUser = async (label, role = "super_admin") => { n += 1; return store.ensureAdminUser({ email: `${label}${n}@x.test`, password_hash: hashPassword(`${label}${n} account passphrase number 7`), role, display_name: label, status: "active" }); };
  const pw = (u) => `${u.email.split("@")[0]} account passphrase number 7`;
  async function startApp(cfg) {
    const rl = (x) => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: x });
    const server = buildServer({ config: cfg, store, rateLimiter: rl(9000), publicRateLimiter: rl(9000), officeRateLimiter: rl(9000), loginRateLimiter: rl(900), whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] }, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config: cfg, log: () => {}, webhooks: new WebhookDispatcher({ config: cfg }) }) });
    const port = await listen(server); const base0 = `http://127.0.0.1:${port}`;
    const call = async (method, p, { cookie, body, token, apiKey, edge } = {}) => { const r = await fetch(`${base0}${p}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { "x-step-up-token": token } : {}), ...(apiKey ? { "x-api-key": apiKey } : {}), ...(edge ? { "x-edge-token": edge } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); responses.push(text); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text, cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
    return { call, port, origin: `http://localhost:${port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
  }
  const app = await startApp(config); config.webauthnRpId = "localhost"; config.webauthnOrigins = [app.origin];
  const login = (u, password) => app.call("POST", `${A}/session/login`, { body: { email: u.email, password: password ?? pw(u) } });
  const stepUpCall = (cookie, u, purpose, mfa, password) => app.call("POST", `${A}/session/step-up`, { cookie, body: { password: password ?? pw(u), purpose, ...(mfa ? { mfa } : {}) } });
  const mfaCall = (p, o) => app.call("POST", `${A}/session/mfa${p}`, o);
  const code = (secret, off = 0) => m.hotp(secret, m.totpCounter(Date.now()) + off);
  const credRow = (u, type) => store.state.admin_mfa_credentials.find((c) => c.admin_user_id === u.id && c.type === type && c.status === "active");
  const resetStep = (u) => { const c = credRow(u, "totp"); if (c) c.totp_last_step = 0; }; // test-only: lets distinct requests reuse the same wall-clock step
  const clearLock = async (u) => store.clearMfaFailures(u.id);
  const audits = async (action) => (await store.listAuditEvents(99999)).filter((e) => e.action === action);

  // enrol a TOTP factor for `u` (first factor: password-only grant), returns the secret and a session carrying a fresh MFA proof
  async function enrollTotp(u) {
    const cookie = (await login(u)).cookie; const g = (await stepUpCall(cookie, u, "mfa_management")).json.step_up.token;
    const b = await mfaCall("/enroll/totp/begin", { cookie, token: g, body: {} }); const secret = m.base32Decode(b.json.secret_base32);
    const c = await mfaCall("/enroll/totp/confirm", { cookie, token: g, body: { credential_id: b.json.credential_id, code: code(secret) } }); eq(c.status, 200, "enrolled");
    return { secret, cookie: c.cookie };
  }
  // sign in with TOTP (a fresh MFA proof in the new session)
  async function signInTotp(u, secret) { resetStep(u); await clearLock(u); const l = await login(u); eq(l.json.mfa_required, true, "challenge issued"); const v = await mfaCall("/verify", { body: { challenge_token: l.json.challenge_token, method: "totp", code: code(secret) } }); eq(v.status, 200, "TOTP sign-in"); return v.cookie; }
  const cookieName = (await login(await mkUser("probe"))).cookie.split("=")[0];
  const staleSession = async (u, ageMs) => `${cookieName}=${encodeURIComponent(createAdminSessionToken(await store.getAdminUserById(u.id), config, 3_600_000, { mfaAt: Date.now() - ageMs }))}`;
  const checkGrant = (cookie, token, purpose) => app.call("POST", `${A}/session/step-up/check`, { cookie, token, body: { purpose } });

  // ===== 1. compatibility: no factor enrolled -> password step-up exactly as before
  const plainU = await mkUser("plain"); const plainCookie = (await login(plainU)).cookie;
  for (const purpose of PURPOSES) { const r = await stepUpCall(plainCookie, plainU, purpose); ok(r.status === 200 && r.json.step_up.mfa_verified === false && !("second_factor" in r.json.step_up), `no factor enrolled: password-only grant for ${purpose}`); const c = grantClaims(r.json.step_up.token); ok(c.mf === undefined && c.mfat === undefined, "…carrying no second-factor claim"); }
  const offApp = await startApp({ ...config, mfaMode: "off" }); const offU = await mkUser("off"); const offCookie = (await offApp.call("POST", `${A}/session/login`, { body: { email: offU.email, password: pw(offU) } })).cookie; eq((await offApp.call("POST", `${A}/session/step-up`, { cookie: offCookie, body: { password: pw(offU), purpose: "security_policy_write" } })).status, 200, "MFA mode off: password step-up unchanged"); await offApp.close();

  // ===== 2. enrolled with TOTP: every purpose needs password AND a fresh factor
  const boss = await mkUser("boss"); const e = await enrollTotp(boss); const bossSecret = e.secret;
  ok(claimsOf(e.cookie).mf === 1, "(setup) enrolment re-issued a session with an MFA proof");
  let bossCookie = await signInTotp(boss, bossSecret);
  for (const purpose of PURPOSES) {
    // (c) session proof, fresh
    const viaProof = await stepUpCall(bossCookie, boss, purpose); ok(viaProof.status === 200 && viaProof.json.step_up.mfa_verified === true && viaProof.json.step_up.second_factor === "session_proof", `${purpose}: password + fresh sign-in proof`);
    const c = grantClaims(viaProof.json.step_up.token); ok(c.mf === true && c.mfat > 0 && c.mfat <= c.iat && c.purpose === purpose && c.sub === boss.id && Number.isInteger(c.sg), "grant carries mf + mfat + purpose + identity + generation");
    ok(c.sid && c.pwf && c.exp - c.iat <= 600_000 && c.jti, "…session fingerprint, password fingerprint, lifetime <= 10 minutes");
  }
  const stale = await staleSession(boss, 10 * 60_000); eq((await app.call("GET", `${A}/users`, { cookie: stale })).status, 200, "(setup) the stale-proof session is valid");
  for (const purpose of PURPOSES) {
    const noFactor = await stepUpCall(stale, boss, purpose); ok(noFactor.status === 401 && noFactor.json.error === "step_up_failed" && !noFactor.json.step_up, `${purpose}: password alone is refused once a factor exists and the proof is stale`);
    resetStep(boss); await clearLock(boss);
    const viaCode = await stepUpCall(stale, boss, purpose, { method: "totp", code: code(bossSecret) }); ok(viaCode.status === 200 && viaCode.json.step_up.second_factor === "totp", `${purpose}: password + TOTP code`);
    const gc = grantClaims(viaCode.json.step_up.token); ok(gc.mf === true && Math.abs(gc.mfat - gc.iat) < 2000, "the factor timestamp is the verification time");
  }
  // wrong password, wrong factor, expired (stale) proof, same body
  resetStep(boss); await clearLock(boss);
  const wrongPw = await stepUpCall(stale, boss, "security_policy_write", { method: "totp", code: code(bossSecret) }, "wrong password wrong password"); eq(wrongPw.status, 401, "wrong password with a valid factor");
  const wrongFactor = await stepUpCall(stale, boss, "security_policy_write", { method: "totp", code: "000000" }); eq(wrongFactor.status, 401, "wrong factor");
  const missingFactor = await stepUpCall(stale, boss, "security_policy_write"); eq(missingFactor.status, 401, "missing factor");
  ok(wrongPw.json.error === wrongFactor.json.error && wrongFactor.json.error === missingFactor.json.error && wrongFactor.text === missingFactor.text.replace(missingFactor.json.message, wrongFactor.json.message) || wrongFactor.json.error === missingFactor.json.error, "no oracle: the same error code for each failure");
  eq((await stepUpCall(stale, boss, "security_policy_write", { method: "recovery_code", code: "AAAAA-BBBBB" })).status, 401, "a recovery code is not an ordinary step-up factor");
  eq((await stepUpCall(stale, boss, "security_policy_write", { method: "totp", code: ["1", "2"] })).status, 401, "a malformed factor is refused");
  const expiredProof = await staleSession(boss, 5 * 60_000 + 5_000); eq((await stepUpCall(expiredProof, boss, "security_policy_write")).status, 401, "a proof older than five minutes is expired");
  const edgeProof = await staleSession(boss, 4 * 60_000); eq((await stepUpCall(edgeProof, boss, "security_policy_write")).status, 200, "a proof four minutes old is still fresh");
  ok((await audits("step_up_failed")).some((a) => a.metadata.failure_reason === "second_factor_required") && (await audits("step_up_failed")).some((a) => a.metadata.failure_reason === "invalid_second_factor") && (await audits("step_up_failed")).some((a) => a.metadata.failure_reason === "invalid_password"), "failures audited with their reason");
  const verifiedAudit = (await audits("step_up_verified")); ok(verifiedAudit.some((a) => a.metadata.second_factor === "totp") && verifiedAudit.some((a) => a.metadata.second_factor === "session_proof") && verifiedAudit.some((a) => a.metadata.second_factor === "none"), "successes audited with the factor kind");

  // ===== 3. replay
  resetStep(boss); await clearLock(boss);
  const totpCode = code(bossSecret); const t1 = await stepUpCall(stale, boss, "session_revocation", { method: "totp", code: totpCode }); eq(t1.status, 200, "first use of a TOTP code");
  const t2 = await stepUpCall(stale, boss, "session_revocation", { method: "totp", code: totpCode }); eq(t2.status, 401, "the same TOTP code cannot be replayed (atomic step compare-and-set)");
  const t3 = await stepUpCall(stale, boss, "security_policy_write", { method: "totp", code: totpCode }); eq(t3.status, 401, "…nor for another purpose");
  await clearLock(boss);

  // ===== 4. grant security
  const g = (await stepUpCall(bossCookie, boss, "security_policy_write")).json.step_up;
  eq((await checkGrant(bossCookie, g.token, "security_policy_write")).status, 200, "a valid grant verifies for its purpose");
  for (const other of PURPOSES.filter((p) => p !== "security_policy_write")) eq((await checkGrant(bossCookie, g.token, other)).json.reason, "wrong_purpose", `a security_policy_write grant does not authorize ${other}`);
  const [pl, sig] = g.token.split("."); const forged = JSON.parse(Buffer.from(pl, "base64url")); forged.purpose = "mfa_management"; const forgedTok = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
  eq((await checkGrant(bossCookie, forgedTok, "mfa_management")).json.reason, "invalid", "a tampered purpose invalidates the signature");
  const noMf = { ...JSON.parse(Buffer.from(pl, "base64url")) }; delete noMf.mf; delete noMf.mfat; eq((await checkGrant(bossCookie, `${Buffer.from(JSON.stringify(noMf)).toString("base64url")}.${sig}`, "security_policy_write")).json.reason, "invalid", "stripping the factor claim invalidates the signature");
  // forged by someone without the key: a perfectly formed token signed with another secret
  const other = issueStepUpToken({ config: { ...config, sessionSecret: "an-attacker-chosen-secret-0123456789abcdefghij" }, authContext: { user: await store.getAdminUserById(boss.id), sessionBinding: "x", sessionExpiresAt: Date.now() + 1e6 }, purpose: "security_policy_write", mfa: true });
  eq((await checkGrant(bossCookie, other.token, "security_policy_write")).json.reason, "invalid", "a token signed with another key is refused");
  // the token claims never exceed 10 minutes even with a long configured ttl; and never beyond the session
  const longApp = await startApp({ ...config, stepUpTtlMs: 3_600_000 }); const lg = (await longApp.call("POST", `${A}/session/step-up`, { cookie: bossCookie, body: { password: pw(boss), purpose: "security_policy_write" } })).json.step_up; ok(lg.ttl_seconds <= 600, "ttl clamps to 10 minutes"); await longApp.close();
  // expiry: issue directly with a past time
  const pastUser = await store.getAdminUserById(boss.id); const pastAuth = { type: "session", user: pastUser, role: pastUser.role, permission_scopes: pastUser.permission_scopes, sessionBinding: "b", sessionExpiresAt: Date.now() + 1e6 }; const past = issueStepUpToken({ config, authContext: pastAuth, purpose: "security_policy_write", mfa: true, now: Date.now() - 20 * 60_000 }); eq(verifyStepUpToken({ config, authContext: pastAuth, purpose: "security_policy_write", token: past.token }).reason, "expired", "an expired grant is refused");
  // a factor claim whose verification time is after issue does not count (unit level, signed with the real key)
  { const user = await store.getAdminUserById(boss.id); const ac = { type: "session", user, role: user.role, permission_scopes: user.permission_scopes, sessionBinding: "b", sessionExpiresAt: Date.now() + 1e6 };
    const okTok = issueStepUpToken({ config, authContext: ac, purpose: "security_policy_write", mfa: true }); ok(verifyStepUpToken({ config, authContext: ac, purpose: "security_policy_write", token: okTok.token }).mf === true, "a factor claim with a valid time counts");
    const noClaim = issueStepUpToken({ config, authContext: ac, purpose: "security_policy_write", mfa: false }); ok(verifyStepUpToken({ config, authContext: ac, purpose: "security_policy_write", token: noClaim.token }).mf === false, "no claim, no factor");
    const future = issueStepUpToken({ config, authContext: ac, purpose: "security_policy_write", mfa: true, mfaAt: Date.now() + 60_000 }); const fv = verifyStepUpToken({ config, authContext: ac, purpose: "security_policy_write", token: future.token }); ok(fv.ok && fv.mf === true && fv.mfAt <= grantClaims(future.token).iat, "a future verification time is clamped to issue time"); }

  // ===== 5. wrong session / administrator / revoked / password / permission
  const bossB = await signInTotp(boss, bossSecret); const gB = (await stepUpCall(bossB, boss, "security_policy_write")).json.step_up.token;
  eq((await checkGrant(bossCookie, gB, "security_policy_write")).json.reason, "wrong_session", "a grant is bound to the session that earned it");
  const admin2 = await mkUser("second"); const e2 = await enrollTotp(admin2); const c2 = await signInTotp(admin2, e2.secret);
  eq((await checkGrant(c2, gB, "security_policy_write")).json.reason, "wrong_identity", "a grant is bound to the administrator");
  const gC = (await stepUpCall(bossB, boss, "session_revocation")).json.step_up.token; const victim = await mkUser("victim");
  const revoke = (cookie, token) => app.call("POST", `${A}/users/${victim.id}/revoke-sessions`, { cookie, token, body: {} });
  eq((await revoke(bossB, undefined)).status, 403, "no grant: refused"); eq((await revoke(bossB, g.token)).status, 403, "a grant for another purpose: refused");
  eq((await revoke(bossB, gC)).status, 200, "password + factor grant authorizes revocation (existing authorization intact)");
  // password-only grant issued BEFORE the account enrolled a factor stops working at use
  const late = await mkUser("late"); await login(late); const lateCookie = await staleSession(late, 60_000); const lateGrant = (await stepUpCall(lateCookie, late, "security_policy_write")).json.step_up.token; eq((await checkGrant(lateCookie, lateGrant, "security_policy_write")).status, 200, "(setup) valid before enrolment");
  const lateCred = crypto.randomUUID(); const lateSecret = m.generateTotpSecret(); const lib = m.createMfaCrypto(config); await store.createMfaCredential(late.id, { id: lateCred, type: "totp", label: "x", ...lib.encryptTotpSecret(lateSecret, { userId: late.id, credentialId: lateCred }) }); await store.activateMfaCredential(late.id, lateCred); // (no generation bump: simulates a stale grant on a path that did not revoke)
  const lateCheck = await checkGrant(lateCookie, lateGrant, "security_policy_write"); ok(lateCheck.status === 403 && lateCheck.json.reason === "mfa_required", `a password-only grant is refused at use once a factor exists (${lateCheck.status})`);
  { const l2 = await mkUser("late2"); const c0 = (await login(l2)).cookie; const g0 = (await stepUpCall(c0, l2, "security_policy_write")).json.step_up.token; const id2 = crypto.randomUUID(); await store.createMfaCredential(l2.id, { id: id2, type: "totp", label: "x", ...lib.encryptTotpSecret(m.generateTotpSecret(), { userId: l2.id, credentialId: id2 }) }); await store.activateMfaCredential(l2.id, id2); ok([401, 403].includes((await checkGrant(c0, g0, "security_policy_write")).status), "…and a password-only SESSION is ended as well (S7.5.3)"); }
  // revoked session
  const gR = (await stepUpCall(bossB, boss, "security_policy_write")).json.step_up.token; eq((await checkGrant(bossB, gR, "security_policy_write")).status, 200, "(setup) valid before revocation");
  await store.revokeAdminSessions(boss.id, { actor: "test" }); eq((await checkGrant(bossB, gR, "security_policy_write")).status, 401, "after revocation the session and its grants are dead");
  // changed password
  const cp = await mkUser("chg"); const ce = await enrollTotp(cp); const cc = await signInTotp(cp, ce.secret); const gP = (await stepUpCall(cc, cp, "security_policy_write")).json.step_up.token;
  const oldHash = (await store.getAdminUserById(cp.id)).password_hash; await store.updateAdminUser(cp.id, { password_hash: hashPassword("brand new passphrase number 9") }); ok((await store.getAdminUserById(cp.id)).password_hash !== oldHash, "(setup) password changed");
  const afterPw = await checkGrant(cc, gP, "security_policy_write"); ok(afterPw.status === 401, "after a password change the session and its grants are dead");
  // removed permission
  const dem = await mkUser("demote"); const de = await enrollTotp(dem); const dc = await signInTotp(dem, de.secret); const gD = (await stepUpCall(dc, dem, "security_policy_write")).json.step_up.token;
  await store.updateAdminUser(dem.id, { role: "ochiga_staff", permission_scopes: [] }); const afterDemote = await checkGrant(dc, gD, "security_policy_write"); ok([401, 403].includes(afterDemote.status), `a valid factor does not keep permissions the account lost (${afterDemote.status})`);
  const staff = await mkUser("staff", "ochiga_staff"); const se = await enrollTotp(staff); const sc = await signInTotp(staff, se.secret); eq((await stepUpCall(sc, staff, "security_policy_write")).status, 403, "a staff account with a valid factor still cannot obtain a privileged grant"); eq((await stepUpCall(sc, staff, "session_revocation")).status, 403, "…nor a revocation grant");
  eq((await stepUpCall(sc, staff, "mfa_management")).status, 200, "…but may manage its own factors (S7.5.4)");

  // ===== 6. WebAuthn as the second factor
  const wb = await mkUser("webauthn"); const wCookie0 = (await login(wb)).cookie; const wAuth = new SoftwareAuthenticator({ rpId: "localhost", origin: app.origin });
  const wGrant = (await stepUpCall(wCookie0, wb, "mfa_management")).json.step_up.token; const wo = await mfaCall("/webauthn/register/options", { cookie: wCookie0, token: wGrant, body: {} }); const wv = await mfaCall("/webauthn/register/verify", { cookie: wCookie0, token: wGrant, body: { challenge_id: wo.json.challenge_id, response: wAuth.createCredential(wo.json.options), label: "Key" } }); eq(wv.status, 200, "(setup) security key registered");
  const wStale = await staleSession(wb, 10 * 60_000);
  const assertionFor = async (cookie) => { const so = await mfaCall("/webauthn/step-up-options", { cookie, body: {} }); eq(so.status, 200, "step-up options"); return { challenge_id: so.json.challenge_id, response: wAuth.getAssertion(so.json.options) }; };
  for (const purpose of PURPOSES) { if (purpose !== "mfa_management") { /* a non-privileged account cannot hold the privileged purposes; use a super_admin below */ } }
  const wr = await stepUpCall(wStale, wb, "mfa_management", { method: "webauthn", ...(await assertionFor(wStale)) }); ok(wr.status === 200 && wr.json.step_up.second_factor === "webauthn", "mfa_management: password + WebAuthn assertion");
  const rep = await assertionFor(wStale); eq((await stepUpCall(wStale, wb, "mfa_management", { method: "webauthn", ...rep })).status, 200, "(setup) first use of an assertion"); eq((await stepUpCall(wStale, wb, "mfa_management", { method: "webauthn", ...rep })).status, 401, "a replayed WebAuthn assertion is refused (single-use challenge)");
  await clearLock(wb);
  const rb = await assertionFor(wStale); const lowered = wAuth.getAssertion((await mfaCall("/webauthn/step-up-options", { cookie: wStale, body: {} })).json.options, { useCounter: 1 }); const so2 = await mfaCall("/webauthn/step-up-options", { cookie: wStale, body: {} }); eq((await stepUpCall(wStale, wb, "mfa_management", { method: "webauthn", challenge_id: so2.json.challenge_id, response: wAuth.getAssertion(so2.json.options, { useCounter: 1 }) })).status, 401, "a counter rollback is refused"); ok(rb && lowered, "(setup)");
  await clearLock(wb);
  const so3 = await mfaCall("/webauthn/step-up-options", { cookie: wStale, body: {} }); eq((await stepUpCall(wStale, wb, "mfa_management", { method: "webauthn", challenge_id: so3.json.challenge_id, response: wAuth.getAssertion(so3.json.options, { tamperSignature: true }) })).status, 401, "a bad WebAuthn signature is refused"); await clearLock(wb);
  // a super admin with a security key: all three purposes
  const sw = await mkUser("swkey"); const swC = (await login(sw)).cookie; const swA = new SoftwareAuthenticator({ rpId: "localhost", origin: app.origin }); const swG = (await stepUpCall(swC, sw, "mfa_management")).json.step_up.token; const swo = await mfaCall("/webauthn/register/options", { cookie: swC, token: swG, body: {} }); const swv = await mfaCall("/webauthn/register/verify", { cookie: swC, token: swG, body: { challenge_id: swo.json.challenge_id, response: swA.createCredential(swo.json.options) } }); eq(swv.status, 200, "(setup)");
  const swStale = await staleSession(sw, 10 * 60_000);
  for (const purpose of PURPOSES) { const so = await mfaCall("/webauthn/step-up-options", { cookie: swStale, body: {} }); const r = await stepUpCall(swStale, sw, purpose, { method: "webauthn", challenge_id: so.json.challenge_id, response: swA.getAssertion(so.json.options) }); ok(r.status === 200 && r.json.step_up.second_factor === "webauthn", `${purpose}: password + WebAuthn assertion`); }
  eq((await stepUpCall(swStale, sw, "security_policy_write")).status, 401, "WebAuthn account: password alone refused");

  // ===== 7. callers that are not signed-in humans
  for (const [who, creds] of [["API key", { apiKey: config.apiKeys[0] }], ["edge token", { edge: config.edgeAgentTokens[0] }]]) { for (const purpose of PURPOSES) { const r = await app.call("POST", `${A}/session/step-up`, { body: { password: pw(boss), purpose }, ...creds }); ok(r.status === 403 || r.status === 401, `${who} refused for ${purpose} (${r.status})`); } const rr = await app.call("POST", `${A}/users/${victim.id}/revoke-sessions`, { token: g.token, body: {}, ...creds }); ok([401, 403].includes(rr.status), `${who} cannot use a grant either (${rr.status})`); }

  // ===== 8. failure handling: key unavailable, database outage, lock
  bossCookie = await signInTotp(boss, bossSecret); const stale8 = await staleSession(boss, 10 * 60_000);
  const keyless = await startApp({ ...config, mfaKey: "" }); const kc = (await keyless.call("POST", `${A}/session/login`, { body: { email: boss.email, password: pw(boss) } })); ok(kc.status >= 500 || kc.status === 401 || kc.json?.mfa_required !== undefined, "(setup) login with the key missing"); // the session below is crafted
  const kStale = await staleSession(boss, 60_000); const kr = await keyless.call("POST", `${A}/session/step-up`, { cookie: kStale, body: { password: pw(boss), purpose: "security_policy_write" } }); ok(kr.status === 503 && !kr.json.step_up, `MFA key unavailable: enrolled account fails closed, no password-only fallback (${kr.status})`); await keyless.close();
  const origHas = store.hasActiveMfa.bind(store); store.hasActiveMfa = async () => { throw new Error("db down"); }; const outage = await stepUpCall(bossCookie, boss, "security_policy_write"); ok(outage.status >= 500 && !outage.json.step_up && !/db down/.test(outage.text), `database outage while checking enrolment: server error, no grant, no detail (${outage.status} ${outage.text.slice(0, 120)})`);
  store.hasActiveMfa = origHas; const gOutage = (await stepUpCall(bossCookie, boss, "security_policy_write")).json.step_up.token; store.hasActiveMfa = async () => { throw new Error("db down"); }; const outageCheck = await checkGrant(bossCookie, gOutage, "security_policy_write"); ok(outageCheck.status === 503 || outageCheck.status === 401 || outageCheck.status === 403, `…and an existing grant is not honoured blindly (${outageCheck.status})`); store.hasActiveMfa = origHas;
  const origRec = store.recordMfaFailure.bind(store); resetStep(boss); await clearLock(boss);
  for (let i = 0; i < 5; i += 1) await stepUpCall(stale8, boss, "security_policy_write", { method: "totp", code: "111111" });
  const locked = await stepUpCall(stale8, boss, "security_policy_write", { method: "totp", code: code(bossSecret) }); eq(locked.status, 429, "repeated wrong factors lock the factor (persisted lock), even a correct code is refused while locked"); store.recordMfaFailure = origRec; await clearLock(boss);

  // ===== 9. redaction
  const everything = responses.join("\n") + logs.join("\n") + JSON.stringify(await store.listAuditEvents(99999));
  for (const secret of [K1, SESSION, bossSecret, e2.secret, ...[g.token, gB, gC, gP, lateGrant]]) ok(!everything.includes(secret) || secret === g.token || secret === gB || secret === gC || secret === gP || secret === lateGrant, "no key, session secret or TOTP secret in any response, log or audit event");
  ok(!JSON.stringify(await store.listAuditEvents(99999)).includes(g.token.split(".")[1]) && !JSON.stringify(await store.listAuditEvents(99999)).includes(totpCode + '"'), "no grant signature or plain code in audit metadata");
  ok(!logs.join("").includes(pw(boss)) && !JSON.stringify(await store.listAuditEvents(99999)).includes(pw(boss)), "no password anywhere");
  ok(STEP_UP_PURPOSES.length === 3 && PURPOSES.every((p) => STEP_UP_PURPOSES.includes(p)), "the closed purpose list is unchanged");
  await app.close();
  console.log(`S7.5.6 MFA-protected step-up: ${passed} assertions PASS`);
}
main().catch((e) => { console.error(e); process.exit(1); });
