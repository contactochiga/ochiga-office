"use strict";
// AREA B / B2: TOTP verification at sign-in: window, replay, malformed codes, persisted lock (incl. correct code refused while locked), concurrency, session claims.
const H = require("./lib/harness");
const { Forge, decodePayload } = require("./lib/forge");
const { A, Client, U } = H;

H.runSuite("b2-totp", async (c) => {
  const srv = await H.makeServer();
  c.defer(async () => { await srv.stop(); H.rmrf(srv.dir); });
  const forge = new Forge(srv);
  const admin = await H.adminLogin(srv);
  const stripId = (b) => { const x = JSON.parse(JSON.stringify(b)); delete x.request_id; return x; };
  const challengeFor = async (p, client = new Client(srv)) => (await p.loginRaw(client)).body.challenge_token;
  const verify = (token, code, client = new Client(srv), method = "totp") => client.post(`${A}/session/mfa/verify`, { challenge_token: token, method, code });
  const userRow = (p) => srv.readStore().admin_users.find((u) => u.id === p.id);

  // a user that will be used for the past-window positive control at the end of the file (needs the clock to move on)
  const pastUser = await H.newPerson(admin, {});

  // ------------------------------------------------------------ T1: positive control and session claims
  const t1 = await H.newPerson(admin, {});
  const s = await t1.signIn();
  c.status("T1.1", "positive control: correct TOTP completes sign-in", s.res, 200);
  c.ok("T1.2", "sign-in answer is a normal session answer (ok, admin summary) with mfa.verified=true and method totp", s.res.body.ok === true && s.res.body.admin && s.res.body.admin.email === t1.email && s.res.body.mfa && s.res.body.mfa.verified === true && s.res.body.mfa.method === "totp", s.res.body);
  const sc = s.res.setCookie[0] || "";
  c.ok("T1.3", "session cookie is HttpOnly, SameSite and has a Max-Age", /HttpOnly/i.test(sc) && /SameSite=(Lax|Strict)/i.test(sc) && /Max-Age=\d+/i.test(sc), sc.replace(/=[^;]+/, "=<token>"));
  const tok = s.client.cookie; const claims = decodePayload(tok) || {};
  c.ok("T1.4", "session token carries MFA proof (mf=1, mft recent), generation, password binding and a session id", claims.mf === 1 && Math.abs(Date.now() - claims.mft) < 120000 && Number.isInteger(claims.sg) && typeof claims.pf === "string" && typeof claims.sid === "string", Object.keys(claims));
  const maxAge = Number((sc.match(/Max-Age=(\d+)/) || [])[1]);
  c.ok("T1.5", "token expiry equals the cookie Max-Age (one effective duration)", Math.abs((claims.exp - Date.now()) / 1000 - maxAge) < 60, { exp_in: (claims.exp - Date.now()) / 1000, maxAge });
  const me = await s.client.get(`${A}/session/me`);
  c.ok("T1.6", "/session/me reports mfa.verified for the signed-in session", me.status === 200 && me.body.mfa && me.body.mfa.verified === true, me.body);
  c.ok("T1.7", "responses never contain the password hash or the TOTP secret", !/password_hash/.test(s.res.text + me.text) && !s.res.text.includes(t1.secret), null);
  const mfaStatus = await s.client.get(`${A}/session/mfa`);
  c.ok("T1.8", "GET /session/mfa lists factors without secret material (no ciphertext, nonce, key id, secret)", mfaStatus.status === 200 && !/secret|ciphertext|nonce|key_id|code_hmac|public_key/i.test(mfaStatus.text), mfaStatus.text.slice(0, 300));

  // ------------------------------------------------------------ T2: replay
  const t2 = await H.newPerson(admin, {});
  const first = await t2.signIn();
  c.status("T2.1", "positive control: first use of a code succeeds", first.res, 200);
  const usedCode = U.totpAtStep(t2.secret, t2.lastStep);
  const replay = await verify(await challengeFor(t2), usedCode);
  c.status("T2.2", "replaying the same code on a fresh challenge is refused", replay, 401);
  c.ok("T2.3", "replay gives no cookie", replay.setCookie.length === 0);
  const wrongNow = await verify(await challengeFor(t2), "000000");
  c.eq("T2.4", "replay answer is identical to a wrong-code answer (no oracle between replay and wrong code)", stripId(replay.body), stripId(wrongNow.body));
  // an older step than the last consumed one must also be refused
  const older = await verify(await challengeFor(t2), U.totpAtStep(t2.secret, t2.lastStep - 1));
  c.status("T2.5", "an older time step than the last accepted one is refused", older, 401);
  const sameChallenge = await challengeFor(t2);
  const nx = await U.nextTotp(t2.secret, t2.lastStep);
  const ok1 = await verify(sameChallenge, nx.code);
  t2.lastStep = ok1.status === 200 ? nx.step : t2.lastStep;
  c.status("T2.6", "positive control: a newer step is accepted", ok1, 200);
  const ok2 = await verify(sameChallenge, nx.code);
  c.status("T2.7", "the same challenge presented again with the now-consumed code is refused", ok2, 401);
  const replayFromOtherIp = await verify(await challengeFor(t2, new Client(srv)), nx.code, new Client(srv));
  c.status("T2.8", "replay from a different client address is refused", replayFromOtherIp, 401);

  // enrolment confirmation code cannot be replayed at sign-in
  const t3 = await H.createUser(admin, {}); await t3.loginRaw(); const en = await t3.enrollTotp(t3.client);
  c.ok("T2.9", "setup: enrolment succeeded", en.ok);
  const confirmCode = U.totpAtStep(t3.secret, t3.lastStep);
  const replayConfirm = await verify(await challengeFor(t3), confirmCode);
  c.status("T2.10", "the code that confirmed enrolment cannot be replayed at sign-in", replayConfirm, 401);

  // ------------------------------------------------------------ T3: malformed codes (several accounts so the persisted failure counter never reaches its first lock)
  const mal = await H.newPerson(admin, {});
  const malformed = [["empty", ""], ["short", "12345"], ["long", "1234567"], ["letters", "abcdef"], ["mixed", "12a456"], ["arabic-indic digits", "١٢٣٤٥٦"], ["fullwidth digits", "１２３４５６"], ["null byte", "12345\u0000"], ["sql", "1' OR '1'='1"], ["newline", "123456\n123456"], ["huge", "1".repeat(100000)], ["number", 123456], ["null", null], ["array", ["123456"]], ["object", { code: "123456" }], ["boolean", true]];
  let batch = 0;
  for (const [idx, [label, value]] of malformed.entries()) {
    if (batch >= 3) { // keep failures under the lock threshold: reset the counter with a valid sign-in
      const ok = await mal.signIn(); c.ok(`T3.r${idx}`, "counter reset by a valid sign-in", ok.res.status === 200); batch = 0;
    }
    const r = await verify(await challengeFor(mal), value);
    batch += 1;
    c.ok(`T3.${idx + 1}`, `malformed code (${label}) is refused without a session or server error`, [400, 401, 413].includes(r.status) && r.setCookie.length === 0, { status: r.status, body: typeof r.body === "string" ? r.body.slice(0, 120) : r.body });
  }
  const spaced = await H.newPerson(admin, {});
  const sp = await U.nextTotp(spaced.secret, spaced.lastStep);
  const spacedRes = await verify(await challengeFor(spaced), `${sp.code.slice(0, 3)} ${sp.code.slice(3)}`);
  c.info(`code with an inner space accepted=${spacedRes.status === 200} (contract allows spaces/hyphens to be ignored)`);
  c.ok("T3.20", "a code entered with a space is not a server error", [200, 401].includes(spacedRes.status), spacedRes.status);

  // ------------------------------------------------------------ T4: window (+-1 step accepted, +-2 refused) with a stability guard against a step rollover mid-test
  let windowDone = false;
  for (let attempt = 0; attempt < 4 && !windowDone; attempt += 1) {
    const w = await H.newPerson(admin, {});
    // enrol consumed step w.lastStep (cur or cur+1); the test needs lastStep < cur, so wait one step if needed
    const base = U.stepNow();
    if (w.lastStep >= base) await U.waitForStep(w.lastStep + 1);
    const cur = U.stepNow();
    const farPast = await verify(await challengeFor(w), U.totpAtStep(w.secret, cur - 2));
    const farFuture = await verify(await challengeFor(w), U.totpAtStep(w.secret, cur + 2));
    if (U.stepNow() !== cur) continue; // the clock rolled during the probes: retry on a fresh account
    c.status("T4.1", "a code two steps in the past (60-90 s old) is refused", farPast, 401);
    c.status("T4.2", "a code two steps in the future is refused", farFuture, 401);
    const future1 = await verify(await challengeFor(w), U.totpAtStep(w.secret, cur + 1));
    c.status("T4.3", "a code one step in the future (clock skew tolerance) is accepted", future1, 200);
    const afterFuture = await verify(await challengeFor(w), U.totpAtStep(w.secret, cur));
    c.status("T4.4", "after a later step was accepted, the current (older) step is refused (monotonic)", afterFuture, 401);
    windowDone = true;
  }
  c.ok("T4.0", "window probes ran against a stable clock step", windowDone);

  // ------------------------------------------------------------ T5: persisted lock
  const L = await H.newPerson(admin, {});
  const ipA = new Client(srv); const ipB = new Client(srv);
  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(await verify(await challengeFor(L, ipA), String(100000 + i * 7), ipA));
  c.ok("T5.1", "the first four wrong codes answer 401 (generic)", results.slice(0, 4).every((r) => r.status === 401), results.map((r) => r.status));
  c.status("T5.2", "the fifth consecutive wrong code locks the account (429 mfa_locked)", results[4], 429);
  c.ok("T5.3", "lock answer says how long to wait (retry_after_seconds, Retry-After) and not more than 60 s at this level", results[4].body.error === "mfa_locked" && results[4].body.retry_after_seconds > 0 && results[4].body.retry_after_seconds <= 61 && Number(results[4].headers.get("retry-after")) > 0, results[4].body);
  const good = await U.nextTotp(L.secret, L.lastStep);
  const lockedGood = await verify(await challengeFor(L, ipA), good.code, ipA);
  c.status("T5.4", "a CORRECT code is refused while the account is locked", lockedGood, 429);
  c.ok("T5.5", "locked + correct code gives no cookie", lockedGood.setCookie.length === 0);
  const lockedOtherIp = await verify(await challengeFor(L, ipB), good.code, ipB);
  c.status("T5.6", "the lock follows the account, not the client address (other address, correct code, still refused)", lockedOtherIp, 429);
  const spoof = await verify(await challengeFor(L, new Client(srv, { ip: "203.0.113.77" })), good.code, new Client(srv, { ip: "203.0.113.78" }));
  c.status("T5.7", "rotating X-Forwarded-For cannot bypass the account lock", spoof, 429);
  const before = userRow(L).mfa_failed_attempts;
  for (let i = 0; i < 6; i += 1) await verify(await challengeFor(L, ipA), "000000", ipA);
  const after = userRow(L).mfa_failed_attempts;
  c.eq("T5.8", "attempts made while locked are not counted (an attacker cannot extend the victim's lock)", after, before);
  const lockedUntil = Date.parse(userRow(L).mfa_locked_until);
  c.ok("T5.9", "persisted lock is time limited (about 60 s, never permanent)", lockedUntil - Date.now() <= 61000 && lockedUntil > Date.now(), userRow(L).mfa_locked_until);
  const other = await H.newPerson(admin, {});
  const otherOk = await other.signIn();
  c.status("T5.10", "another account is unaffected by the first account's lock", otherOk.res, 200);
  const lockedRecovery = await verify(await challengeFor(L, ipA), L.recovery[0], ipA, "recovery_code");
  c.status("T5.11", "a correct RECOVERY code is also refused while the account is locked", lockedRecovery, 429);
  c.ok("T5.12", "the unused recovery code is still unused after a refused attempt (not burned by the lock)", (srv.readStore().admin_mfa_recovery_codes || []).filter((r) => r.admin_user_id === L.id && !r.used_at).length === 10);
  // expiry: poll until the lock ends (explicit condition), then the correct code works and the counter is cleared
  const lockEnd = Date.now() + 100000; let unlocked = null;
  while (Date.now() < lockEnd) {
    const nc = await U.nextTotp(L.secret, L.lastStep);
    const r = await verify(await challengeFor(L, ipA), nc.code, ipA);
    if (r.status === 200) { unlocked = r; L.lastStep = nc.step; break; }
    if (r.status !== 429) { unlocked = r; break; }
    await U.sleep(2000);
  }
  c.ok("T5.13", "positive control: once the lock has expired the correct code signs in", unlocked && unlocked.status === 200, unlocked && unlocked.body);
  c.eq("T5.14", "a successful verification clears the failure counter and the lock", [userRow(L).mfa_failed_attempts, userRow(L).mfa_locked_until], [0, null]);

  // counter semantics: failures then success resets
  const R = await H.newPerson(admin, {});
  for (let i = 0; i < 3; i += 1) await verify(await challengeFor(R), "111111");
  c.eq("T5.15", "three wrong codes are counted", userRow(R).mfa_failed_attempts, 3);
  const rs = await R.signIn(); c.status("T5.16", "a correct code after three failures still works (below the lock threshold)", rs.res, 200);
  c.eq("T5.17", "and resets the counter to zero", userRow(R).mfa_failed_attempts, 0);

  // lock progression 10 -> 15 min and 20 -> 60 min, driven by editing the private store while the server is stopped
  const P = await H.newPerson(admin, {});
  await srv.stop();
  const store = srv.readStore(); const pr = store.admin_users.find((u) => u.id === P.id); pr.mfa_failed_attempts = 9; pr.mfa_locked_until = null;
  const pr2 = store; require("fs").writeFileSync(srv.storeFile(), JSON.stringify(pr2));
  await srv.start();
  const p10 = await verify((await P.loginRaw(new Client(srv))).body.challenge_token, "222222");
  c.ok("T5.18", "the tenth consecutive failure locks for about 15 minutes (not forever, not 1 minute)", p10.status === 429 && p10.body.retry_after_seconds > 600 && p10.body.retry_after_seconds <= 901, p10.body);
  await srv.stop();
  const store2 = srv.readStore(); const pr3 = store2.admin_users.find((u) => u.id === P.id); pr3.mfa_failed_attempts = 19; pr3.mfa_locked_until = null; require("fs").writeFileSync(srv.storeFile(), JSON.stringify(store2));
  await srv.start();
  const p20 = await verify((await P.loginRaw(new Client(srv))).body.challenge_token, "333333");
  c.ok("T5.19", "the twentieth consecutive failure locks for about an hour, and never beyond", p20.status === 429 && p20.body.retry_after_seconds > 900 && p20.body.retry_after_seconds <= 3601, p20.body);
  const pLockedGood = await verify((await P.loginRaw(new Client(srv))).body.challenge_token, (await U.nextTotp(P.secret, P.lastStep)).code);
  c.status("T5.20", "a correct code during the long lock is refused", pLockedGood, 429);

  // ------------------------------------------------------------ T6: concurrency
  const C = await H.newPerson(admin, {});
  const code = await U.nextTotp(C.secret, C.lastStep);
  const tokens = await Promise.all(Array.from({ length: 12 }, () => challengeFor(C)));
  const par = await Promise.all(tokens.map((t) => verify(t, code.code)));
  C.lastStep = code.step;
  c.eq("T6.1", "12 parallel verifications of one TOTP code (separate challenges) yield exactly one session", par.filter((r) => r.status === 200).length, 1);
  // NOTE (author's correction before any release of this corpus): the first draft required 401 for every loser, which contradicts the written lock rule (5 consecutive failures lock the account, 429).
  c.ok("T6.2", "all others are refused (generic 401, or 429 once the failure counter locks the account) and none gets a cookie", par.filter((r) => r.status !== 200).every((r) => [401, 429].includes(r.status) && r.setCookie.length === 0), par.map((r) => r.status));
  const C2 = await H.newPerson(admin, {});
  const code2 = await U.nextTotp(C2.secret, C2.lastStep);
  const one = await challengeFor(C2);
  const par2 = await Promise.all(Array.from({ length: 12 }, () => verify(one, code2.code)));
  C2.lastStep = code2.step;
  c.eq("T6.3", "12 parallel verifications of one code on ONE challenge yield exactly one session", par2.filter((r) => r.status === 200).length, 1);

  // ------------------------------------------------------------ T7: session forgery against the second-factor requirement
  const F = await H.newPerson(admin, {});
  const noMf = forge.session(F.email, {});
  const r1 = await new Client(srv).get(`${A}/session/me`, { cookie: noMf });
  c.status("T7.1", "a correctly signed password-only session token of an enrolled account is refused (mfa_required)", r1, 401);
  c.ok("T7.2", "the refusal says mfa_required", JSON.stringify(r1.body).includes("mfa_required"), r1.body);
  const r2 = await new Client(srv).get(`${A}/users`, { cookie: noMf });
  c.status("T7.3", "same token is refused on a protected route", r2, 401);
  const withMf = forge.session(F.email, { mf: true });
  const r3 = await new Client(srv).get(`${A}/session/me`, { cookie: withMf });
  c.status("T7.4", "(model control) a token with the MFA claim signed by the legitimate secret is accepted - proving the claim is what is checked", r3, 200);
  const tampered = noMf.replace(/^[^.]+/, (p) => Buffer.from(JSON.stringify({ ...decodePayload(p), mf: 1, mft: Date.now() })).toString("base64url"));
  const r4 = await new Client(srv).get(`${A}/session/me`, { cookie: tampered });
  c.status("T7.5", "adding mf=1 to a password-only token without the secret is refused", r4, 401);
  const r5 = await new Client(srv).get(`${A}/session/me`, { cookie: forge.session(F.email, { mf: true, sg: 77 }) });
  c.status("T7.6", "a token with the MFA claim but a stale generation is refused", r5, 401);
  const r6 = await new Client(srv).get(`${A}/session/me`, { cookie: forge.session(F.email, { mf: true, pf: "b".repeat(32) }) });
  c.status("T7.7", "a token with the MFA claim but a stale password binding is refused", r6, 401);
  const r7 = await new Client(srv).get(`${A}/session/me`, { cookie: forge.session(F.email, { mf: true, exp: Date.now() - 1000 }) });
  c.status("T7.8", "an expired token is refused", r7, 401);
  const r8 = await new Client(srv).get(`${A}/session/me`, { cookie: forge.session(F.email, { mf: true, role: "super_admin" }) });
  c.ok("T7.9", "a token claiming a higher role does not grant it (role is read from the live account)", r8.status === 200 && r8.body.admin.role === F.role, r8.body.admin);

  // pre-enrolment sessions die at enrolment
  const E = await H.createUser(admin, {});
  const e1 = new Client(srv); const e2 = new Client(srv);
  await E.loginRaw(e1); await E.loginRaw(e2);
  const enr = await E.enrollTotp(e1);
  c.ok("T7.10", "setup: enrolment on one browser", enr.ok);
  c.status("T7.11", "the enrolling browser stays signed in (re-issued with MFA proof)", await e1.get(`${A}/session/me`), 200);
  c.status("T7.12", "a pre-enrolment password-only session of the same account is ended by enrolment", await e2.get(`${A}/session/me`), 401);

  // ------------------------------------------------------------ T8: audit
  const failures = await srv.audit((x) => x.action === "mfa_failed" && x.target_id === t2.id);
  c.ok("T8.1", "failed verifications are audited with a reason category (e.g. replay)", failures.length >= 2 && failures.some((x) => x.metadata && x.metadata.failure_reason === "replay"), failures.map((x) => x.metadata && x.metadata.failure_reason));
  const verified = await srv.audit((x) => x.action === "mfa_verified" && x.target_id === t1.id);
  c.ok("T8.2", "successful verification is audited with the method", verified.length >= 1 && verified[0].metadata.method === "totp", verified[0] && verified[0].metadata);
  const locked = await srv.audit((x) => x.action === "mfa_locked" && x.target_id === L.id);
  c.ok("T8.3", "a lock is audited", locked.length >= 1, locked.length);
  const blob = JSON.stringify(srv.allAudit());
  c.ok("T8.4", "audit records contain no TOTP code, secret, challenge token or cookie", !blob.includes(t1.secret) && !blob.includes(L.secret) && !blob.includes(good.code) && !blob.includes(tok) && !blob.includes(tok.split(".")[0]));
  const storeText = JSON.stringify(srv.readStore());
  c.ok("T8.5", "the store never contains a TOTP secret in the clear (base32 or hex)", ![t1, t2, L, C, E, F].some((p) => p.secret && (storeText.includes(p.secret) || storeText.includes(U.b32decode(p.secret).toString("hex")) || storeText.includes(U.b32decode(p.secret).toString("base64")))));
  const logs = srv.logs();
  c.ok("T8.6", "server logs contain no TOTP secret, session token or MFA key", ![t1, L].some((p) => logs.includes(p.secret)) && !logs.includes(tok) && !logs.includes(srv.env.LEAD_AGENTS_MFA_KEY));

  // ------------------------------------------------------------ T9: past-window positive control (needs the clock to have moved on since enrolment)
  await U.waitForStep(pastUser.lastStep + 2);
  const curNow = U.stepNow();
  let pastRes;
  for (let k = 0; k < 3; k += 1) {
    const cn = U.stepNow();
    pastRes = await verify(await challengeFor(pastUser), U.totpAtStep(pastUser.secret, cn - 1));
    if (U.stepNow() === cn || pastRes.status === 200) break;
  }
  c.status("T9.1", "a code one step in the past (clock skew tolerance) is accepted when newer than the last accepted step", pastRes, 200);
  const tooOld = await verify(await challengeFor(pastUser), U.totpAtStep(pastUser.secret, U.stepNow() - 2));
  c.status("T9.2", "a code two steps in the past is refused", tooOld, 401);
});
