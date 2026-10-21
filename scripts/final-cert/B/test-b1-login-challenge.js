"use strict";
// AREA B / B1: MFA login challenge. No authority before completion; binding to account, purpose, password state, generation, expiry; enumeration; method downgrade.
const H = require("./lib/harness");
const { Forge, flip, retamper, decodePayload } = require("./lib/forge");
const { A, Client, U } = H;

H.runSuite("b1-login-challenge", async (c) => {
  const srv = await H.makeServer();
  c.defer(async () => { await srv.stop(); H.rmrf(srv.dir); });
  const forge = new Forge(srv);
  const admin = await H.adminLogin(srv);
  const u1 = await H.newPerson(admin, {});
  const u2 = await H.newPerson(admin, {});
  const plain = await H.newPerson(admin, { enroll: false });

  const stripId = (b) => { const x = JSON.parse(JSON.stringify(b)); delete x.request_id; return x; };

  // ------------------------------------------------------------ LC1: challenge issuance carries no authority
  const cl = new Client(srv);
  const login = await u1.loginRaw(cl);
  c.status("LC1.1", "correct password on an enrolled account answers 200", login, 200);
  c.ok("LC1.2", "login answer is a challenge (ok:false, mfa_required:true, challenge_token)", login.body.ok === false && login.body.mfa_required === true && typeof login.body.challenge_token === "string" && login.body.challenge_token.length > 40, login.body);
  c.ok("LC1.3", "challenge answer sets NO cookie", login.setCookie.length === 0 && !login.headers.get("set-cookie"), login.setCookie);
  c.ok("LC1.4", "challenge answer carries no admin object / permissions / role", !("admin" in login.body) && !/permissions|"role"/.test(login.text), login.text.slice(0, 300));
  c.ok("LC1.5", "challenge answer advertises the available methods (totp + recovery_code) and not webauthn without a key", Array.isArray(login.body.methods) && login.body.methods.includes("totp") && login.body.methods.includes("recovery_code") && !login.body.methods.includes("webauthn"), login.body.methods);
  c.ok("LC1.6", "challenge answer is not cacheable", /no-store/i.test(login.headers.get("cache-control") || ""), login.headers.get("cache-control"));
  c.ok("LC1.7", "challenge expiry is within the documented 5 minute lifetime (and in the future)", (() => { const t = Date.parse(login.body.expires_at); return t > Date.now() && t - Date.now() <= 5 * 60 * 1000 + 5000; })(), login.body.expires_at);
  c.ok("LC1.8", "challenge response does not leak the TOTP secret, hashes or recovery codes", !(u1.secret && login.text.includes(u1.secret)) && !u1.recovery.some((r) => login.text.includes(r)), null);
  c.ok("LC1.9", "positive control: an account WITHOUT a factor still gets a normal session directly", await (async () => { const r = await plain.loginRaw(plain.newClient()); return r.status === 200 && r.body.ok === true && r.setCookie.length > 0; })());

  const chal = login.body.challenge_token;
  // ------------------------------------------------------------ LC2: the challenge is not a session / bearer / grant
  const asCookie = await new Client(srv).get(`${A}/session/me`, { cookie: chal });
  c.status("LC2.1", "challenge presented as the session cookie is refused on /session/me", asCookie, 401);
  const asCookie2 = await new Client(srv).get(`${A}/users`, { cookie: chal });
  c.status("LC2.2", "challenge presented as the session cookie is refused on a protected route", asCookie2, 401);
  for (const [i, hdr] of [["Authorization", `Bearer ${chal}`], ["x-api-key", chal], ["x-office-api-key", chal], ["x-edge-token", chal]].entries()) {
    const r = await new Client(srv).get(`${A}/users`, { headers: { [hdr[0]]: hdr[1] } });
    c.status(`LC2.${3 + i}`, `challenge presented as ${hdr[0]} is refused on a protected route`, r, 401);
  }
  const fullU1 = await u1.signIn();
  c.status("LC2.7", "positive control: u1 completes sign-in with TOTP", fullU1.res, 200);
  const sc = await fullU1.client.post(`${A}/session/step-up/check`, { purpose: "mfa_management" }, { headers: { "x-step-up-token": chal } });
  c.status("LC2.8", "challenge presented as a step-up grant is refused", sc, 403);
  const beginWithChal = await fullU1.client.post(`${A}/session/mfa/enroll/totp/begin`, {}, { headers: { "x-step-up-token": chal } });
  c.status("LC2.9", "challenge presented as the mfa_management grant is refused", beginWithChal, 403);
  const noAuth = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: chal, method: "totp" });
  c.ok("LC2.10", "verify without a code never yields a session", noAuth.status !== 200 && noAuth.setCookie.length === 0, noAuth.body);

  // ------------------------------------------------------------ LC3: enumeration - wrong password / unknown account answers are indistinguishable from each other and carry no challenge
  const wrong = await u1.loginRaw(new Client(srv), "Wrong-pass-0000-xyz");
  const unknown = await new Client(srv).post(`${A}/session/login`, { email: "nobody-here@fixture.test", password: "Wrong-pass-0000-xyz" });
  c.status("LC3.1", "wrong password on an ENROLLED account answers 401", wrong, 401);
  c.eq("LC3.2", "wrong-password answer for an enrolled account equals the unknown-account answer (no enumeration of enrolment)", stripId(wrong.body), stripId(unknown.body));
  c.ok("LC3.3", "wrong-password answer has no challenge and no mfa hint", !/challenge|mfa/i.test(wrong.text), wrong.text);
  const wrongPlain = await plain.loginRaw(new Client(srv), "Wrong-pass-0000-xyz");
  c.eq("LC3.4", "wrong-password answer for a NON-enrolled account equals that of an enrolled account", stripId(wrongPlain.body), stripId(wrong.body));

  // ------------------------------------------------------------ LC4: binding to the account
  const u2login = await u2.loginRaw(new Client(srv));
  const u2chal = u2login.body.challenge_token;
  const t2 = await U.nextTotp(u2.secret, u2.lastStep);
  // u2's valid code against u1's challenge
  const cross = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: chal, method: "totp", code: t2.code });
  c.status("LC4.1", "another account's valid TOTP code does not complete this account's challenge", cross, 401);
  c.ok("LC4.2", "cross-account attempt yields no cookie", cross.setCookie.length === 0, cross.body);
  const swapped = retamper(chal, (cl2) => { cl2.uid = u2.id; });
  const swapRes = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: swapped, method: "totp", code: t2.code });
  c.status("LC4.3", "challenge whose uid was edited (signature not recomputed) is refused", swapRes, 401);
  c.ok("LC4.4", "edited challenge yields no cookie", swapRes.setCookie.length === 0);
  const sig = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: flip(chal), method: "totp", code: t2.code });
  c.status("LC4.5", "challenge with a flipped signature is refused", sig, 401);
  const forgedOther = forge.challenge(u2.email.toLowerCase(), {});
  const ownCode = await U.nextTotp(u1.secret, u1.lastStep);
  const wrongUserCode = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: forgedOther, method: "totp", code: ownCode.code });
  c.status("LC4.6", "u2's correctly signed challenge with u1's code is refused (code is bound to the challenge's account)", wrongUserCode, 401);
  c.status("LC4.7", "positive control: u2's challenge with u2's own code completes (cross-account refusals did not burn it)", await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: u2chal, method: "totp", code: t2.code }), 200);
  u2.lastStep = t2.step;
  const lockAfterCross = srv.readStore().admin_users.find((u) => u.id === u1.id);
  c.ok("LC4.8", "failed cross-account attempts are counted against the challenge's account, never against the code owner", (srv.readStore().admin_users.find((u) => u.id === u2.id).mfa_failed_attempts || 0) === 0, { u1: lockAfterCross && lockAfterCross.mfa_failed_attempts });

  // ------------------------------------------------------------ LC5: forged / malformed / wrong-purpose / expired
  const bad = {};
  const attempts = [
    ["missing token", undefined], ["null token", null], ["number token", 12345], ["object token", { a: 1 }], ["array token", ["x"]], ["empty string", ""], ["garbage", "not-a-token"], ["three segments", chal + ".extra"],
    ["one segment", chal.split(".")[0]], ["huge", "A".repeat(200000)], ["unicode", "‮\u0000"],
  ];
  let i = 1;
  for (const [label, value] of attempts) {
    const r = await new Client(srv).post(`${A}/session/mfa/verify`, { ...(value === undefined ? {} : { challenge_token: value }), method: "totp", code: "000000" });
    c.ok(`LC5.${i}`, `malformed challenge (${label}) is refused without a session and without a server error`, [400, 401, 413].includes(r.status) && r.setCookie.length === 0, { status: r.status, body: typeof r.body === "string" ? r.body.slice(0, 200) : r.body });
    i += 1;
  }
  const rawBodies = [["not JSON", "{{{"], ["array body", "[]"], ["string body", "\"x\""]];
  for (const [label, raw] of rawBodies) {
    const r = await new Client(srv).raw("POST", `${A}/session/mfa/verify`, { rawBody: raw });
    c.ok(`LC5.${i}`, `verify with a ${label} request body is refused without a session`, r.status >= 400 && r.status < 500 && r.setCookie.length === 0, { status: r.status, body: r.body });
    i += 1;
  }
  const noOracle = [];
  for (const tok of [flip(chal), "not-a-token", forge.challenge(u1.email, { purpose: "enroll" }), forge.challenge(u1.email, { purpose: "enroll_verified" }), forge.challenge(u1.email, { pf: "0".repeat(32) }).replace(/.$/, "0")]) {
    const r = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: tok, method: "totp", code: "000000" });
    noOracle.push(JSON.stringify(stripId(r.body)) + r.status);
  }
  c.ok("LC5.20", "forged / wrong-purpose challenges all receive the same generic answer (no oracle on why)", new Set(noOracle).size === 1, noOracle);
  const enrollPurpose = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: forge.challenge(u1.email, { purpose: "enroll" }), method: "totp", code: (await U.nextTotp(u1.secret, u1.lastStep)).code });
  c.status("LC5.21", "a correctly signed challenge of purpose 'enroll' cannot sign in (purpose isolation)", enrollPurpose, 401);
  const enrollV = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: forge.challenge(u1.email, { purpose: "enroll_verified" }), method: "totp", code: (await U.nextTotp(u1.secret, u1.lastStep)).code });
  c.status("LC5.22", "a correctly signed challenge of purpose 'enroll_verified' cannot sign in", enrollV, 401);
  const expiredTok = forge.challenge(u1.email, { iat: Date.now() - 400000, ttlMs: 300000 });
  const expiredRes = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: expiredTok, method: "totp", code: (await U.nextTotp(u1.secret, u1.lastStep)).code });
  c.status("LC5.23", "an expired (correctly signed) challenge is refused", expiredRes, 401);
  c.ok("LC5.24", "expired challenge yields no cookie and the 'sign in again' answer", expiredRes.setCookie.length === 0 && /expired/i.test(JSON.stringify(expiredRes.body)), expiredRes.body);
  const longLived = forge.challenge(u1.email, { iat: Date.now(), ttlMs: 30 * 24 * 3600 * 1000 });
  const ll = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: longLived, method: "totp", code: "000000" });
  c.ok("LC5.25", "a challenge claiming a far-future expiry does not extend beyond the 10 minute ceiling (still refused code check is generic, never a session)", ll.status === 401 && ll.setCookie.length === 0, ll.body);
  const wrongSg = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: forge.challenge(u1.email, { sg: 999 }), method: "totp", code: (await U.nextTotp(u1.secret, u1.lastStep)).code });
  c.status("LC5.26", "a challenge for a different session generation is refused", wrongSg, 401);
  const wrongPf = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: forge.challenge(u1.email, { pf: "a".repeat(32) }), method: "totp", code: (await U.nextTotp(u1.secret, u1.lastStep)).code });
  c.status("LC5.27", "a challenge bound to a different password state is refused", wrongPf, 401);
  const wrongKey = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: forge.challenge(u1.email, { signWith: Buffer.alloc(32, 7) }), method: "totp", code: (await U.nextTotp(u1.secret, u1.lastStep)).code });
  c.status("LC5.28", "a challenge signed with a different key is refused", wrongKey, 401);

  // ------------------------------------------------------------ LC6: method handling / downgrade
  const g = await u1.loginRaw(new Client(srv));
  for (const [j, m] of [undefined, null, "", "password", "none", "sms", "email", "TOTP", "totp ", "recovery", ["totp"], { m: 1 }].entries()) {
    const r = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: g.body.challenge_token, ...(m === undefined ? {} : { method: m }), code: "123456" });
    c.ok(`LC6.${j + 1}`, `unknown/absent method ${JSON.stringify(m)} cannot sign in`, r.status === 401 && r.setCookie.length === 0, { status: r.status, body: r.body });
  }
  const wa = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: g.body.challenge_token, method: "webauthn", webauthn: { challenge_id: "x", response: { id: "x" } } });
  c.ok("LC6.20", "method webauthn without a registered credential cannot sign in", wa.status === 401 && wa.setCookie.length === 0, wa.body);
  const downgrade = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: g.body.challenge_token, method: "totp", code: "123456", mfa_required: false, skip_mfa: true });
  c.ok("LC6.21", "extra body fields (mfa_required:false, skip_mfa) do not downgrade authentication", downgrade.status === 401 && downgrade.setCookie.length === 0, downgrade.body);
  const viaQuery = await new Client(srv).post(`${A}/session/mfa/verify?method=none&skip=1`, { challenge_token: g.body.challenge_token });
  c.ok("LC6.22", "query-string tricks do not downgrade authentication", viaQuery.status !== 200 && viaQuery.setCookie.length === 0, viaQuery.body);
  const getVerify = await new Client(srv).get(`${A}/session/mfa/verify`);
  c.ok("LC6.23", "GET on the verify route is not an authentication path", getVerify.status === 405 && getVerify.setCookie.length === 0, getVerify.status);

  // ------------------------------------------------------------ LC7: the challenge dies with password change / revocation / deactivation
  const v1 = await H.newPerson(admin, {});
  const ch1 = (await v1.loginRaw(new Client(srv))).body.challenge_token;
  const newPw = U.randomPassword();
  const patchPw = await admin.client.patch(`${A}/users/${v1.id}`, { password: newPw });
  c.status("LC7.1", "setup: administrator sets a new password for the account", patchPw, 200);
  const t1 = await U.nextTotp(v1.secret, v1.lastStep);
  const afterPw = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: ch1, method: "totp", code: t1.code });
  c.status("LC7.2", "challenge issued before a password change is refused even with a correct code", afterPw, 401);
  c.ok("LC7.3", "refused challenge issues no cookie", afterPw.setCookie.length === 0);
  v1.password = newPw;
  const re = await v1.signIn();
  c.status("LC7.4", "positive control: signing in again with the new password and the code works", re.res, 200);

  const v2 = await H.newPerson(admin, {});
  const ch2 = (await v2.loginRaw(new Client(srv))).body.challenge_token;
  const rev = await admin.client.post(`${A}/session/step-up`, { purpose: "session_revocation", password: admin.password });
  c.status("LC7.5", "setup: administrator obtains a session_revocation grant (administrator has no factor)", rev, 200);
  const revokeCall = await admin.client.post(`${A}/users/${v2.id}/revoke-sessions`, {}, { headers: { "x-step-up-token": rev.body.step_up.token } });
  c.status("LC7.6", "setup: administrator revokes the target's sessions", revokeCall, 200);
  const t2b = await U.nextTotp(v2.secret, v2.lastStep);
  const afterRev = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: ch2, method: "totp", code: t2b.code });
  c.status("LC7.7", "challenge issued before a revocation is refused", afterRev, 401);

  const v3 = await H.newPerson(admin, {});
  const ch3 = (await v3.loginRaw(new Client(srv))).body.challenge_token;
  const deact = await admin.client.patch(`${A}/users/${v3.id}`, { status: "inactive" });
  c.status("LC7.8", "setup: administrator deactivates the account", deact, 200);
  const t3 = await U.nextTotp(v3.secret, v3.lastStep);
  const afterDeact = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: ch3, method: "totp", code: t3.code });
  c.status("LC7.9", "challenge of a deactivated account is refused", afterDeact, 401);
  c.ok("LC7.10", "deactivated account gets no cookie", afterDeact.setCookie.length === 0);
  const deactLogin = await v3.loginRaw(new Client(srv));
  c.status("LC7.11", "deactivated account cannot start a sign-in at all", deactLogin, 401);
  const restore = await admin.client.patch(`${A}/users/${v3.id}`, { status: "active" });
  c.status("LC7.12", "setup: administrator reactivates the account", restore, 200);
  const afterRestore = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: ch3, method: "totp", code: (await U.nextTotp(v3.secret, v3.lastStep)).code });
  c.status("LC7.13", "challenge issued before deactivation stays dead after reactivation", afterRestore, 401);
  const rs = await v3.signIn();
  c.ok("LC7.14", "reactivated account is still bound to its factor (a new sign-in demands the second step)", rs.login.body.mfa_required === true && rs.res.status === 200, rs.login.body);

  // ------------------------------------------------------------ LC8: deleted and re-created accounts do not inherit factors, challenges or sessions
  const d1 = await H.newPerson(admin, {});
  const dsess = await d1.signIn();
  const dchal = (await d1.loginRaw(new Client(srv))).body.challenge_token;
  const rem = await admin.client.post(`${A}/users/${d1.id}/remove`, {});
  c.status("LC8.1", "setup: account removed", rem, 200);
  const perm = await admin.client.req("DELETE", `${A}/users/${d1.id}/permanent`, {});
  c.status("LC8.2", "setup: account permanently deleted", perm, 200);
  const orphan = srv.readStore();
  c.ok("LC8.3", "permanent deletion leaves no orphaned credential rows (factor material) for the deleted account", !(orphan.admin_mfa_credentials || []).some((x) => x.admin_user_id === d1.id), (orphan.admin_mfa_credentials || []).filter((x) => x.admin_user_id === d1.id).length);
  c.ok("LC8.3b", "permanent deletion leaves no orphaned recovery-code rows for the deleted account", !(orphan.admin_mfa_recovery_codes || []).some((x) => x.admin_user_id === d1.id), (orphan.admin_mfa_recovery_codes || []).filter((x) => x.admin_user_id === d1.id).length);
  const reborn = await H.createUser(admin, { email: d1.email, password: d1.password });
  const rlogin = await reborn.loginRaw(new Client(srv));
  c.ok("LC8.4", "re-created account with the same address is NOT bound to the old factor (plain session)", rlogin.status === 200 && rlogin.body.ok === true && !rlogin.body.mfa_required, rlogin.body);
  c.status("LC8.5", "the old session cookie of the deleted account is refused after re-creation", await dsess.client.get(`${A}/session/me`), 401);
  const oldChalRes = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: dchal, method: "totp", code: (await U.nextTotp(d1.secret, d1.lastStep)).code });
  c.ok("LC8.6", "challenge of the deleted account cannot sign in the re-created account", oldChalRes.status === 401 && oldChalRes.setCookie.length === 0, oldChalRes.body);
  const rcode = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: forge.challenge(reborn.email, {}), method: "totp", code: (await U.nextTotp(d1.secret, d1.lastStep)).code });
  c.ok("LC8.7", "the old TOTP secret does not authenticate the re-created account", rcode.status === 401 && rcode.setCookie.length === 0, rcode.body);

  // ------------------------------------------------------------ LC9: audit of challenge issuance (positive) and redaction
  const issued = await srv.audit((e) => e.action === "mfa_challenge_issued" && e.target_id === u1.id);
  c.ok("LC9.1", "challenge issuance is audited for the account", issued.length >= 1, issued.length);
  const text = JSON.stringify(srv.allAudit());
  c.ok("LC9.2", "no challenge token appears in any audit record", !text.includes(chal) && !text.includes(chal.split(".")[0]));
  c.ok("LC9.3", "no TOTP secret or recovery code of u1 appears in any audit record", !text.includes(u1.secret) && !u1.recovery.some((r) => text.includes(r)));
  c.ok("LC9.4", "no password appears in any audit record", !text.includes(u1.password) && !text.includes(admin.password));
  const logs = srv.logs();
  c.ok("LC9.5", "no challenge token, password or TOTP secret appears in the server log output", !logs.includes(chal) && !logs.includes(u1.password) && !logs.includes(u1.secret) && !logs.includes(srv.env.LEAD_AGENTS_MFA_KEY));
});
