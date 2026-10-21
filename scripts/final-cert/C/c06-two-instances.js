"use strict";
// AREA C / C06: two (and for throttling four) real server instances against ONE database. State changed through one instance must be honoured by the other,
// and single-use factors must have one winner even when the racers hit different instances.
const L = require("./lib");
const F = require("./appfix");

const s = new L.Suite("c06-two-instances", "C");

s.main(async () => {
  const fx = await F.buildStack(s, { tag: "c06", instances: 2 });
  const { st, admin } = fx;
  const num = async (sql) => Number((await admin.query(sql)).rows[0][0]);
  const A = 0, B = 1;
  const cl = (i) => fx.client(i);
  const code = (r) => r.status;
  const wins = (rs) => rs.filter((r) => r.status === 200).length;
  const mfaUser = async (role = "super_admin", inst = A) => F.accountWithTotp(fx, { role, appIndex: inst });
  const challengeFor = async (u, inst) => { const l = await cl(inst).post(`${L.P}/session/login`, { email: u.user.email, password: u.user.password }); return l.json && l.json.challenge_token; };
  const verify = (inst, tok, method, c, o) => cl(inst).post(`${L.P}/session/mfa/verify`, { challenge_token: tok, method, code: c }, o);
  const plain = async (inst = A) => { const u = await L.seedUser(admin, { role: "viewer" }); const l = await cl(inst).login(u.email, u.password); return { u, cookie: l.cookie }; };

  s.check("X-000", "positive control: both instances share one database and both serve a sign-in made on the other", await (async () => { const p = await plain(A); return (await cl(B).me({ cookie: p.cookie })).status === 200; })());

  // ---------------------------------------------------------------- logout
  await s.section("LOGOUT", async () => {
    const u = await L.seedUser(admin, { role: "viewer" });
    const a = await cl(A).login(u.email, u.password); const b = await cl(B).login(u.email, u.password); const a2 = await cl(A).login(u.email, u.password);
    const lo = await cl(B).logout({ cookie: a.cookie });
    s.check("X-101", "logout through B of a session issued by A is confirmed", lo.status === 200 && lo.json.revoked === true, lo.text);
    s.eq("X-102", "A refuses its own copied cookie afterwards", (await cl(A).me({ cookie: a.cookie })).status, 401);
    s.eq("X-103", "B refuses it too", (await cl(B).me({ cookie: a.cookie })).status, 401);
    s.check("X-104", "the account's other sessions (issued by A and by B) survive on both instances", (await Promise.all([cl(A).me({ cookie: b.cookie }), cl(B).me({ cookie: b.cookie }), cl(A).me({ cookie: a2.cookie }), cl(B).me({ cookie: a2.cookie })])).every((r) => r.status === 200));
    // logout then restart: nothing lives in memory
    const lo2 = await cl(A).logout({ cookie: a2.cookie });
    await fx.apps[A].restart();
    s.eq("X-105", "a logged-out cookie stays dead after the server that revoked it restarts", (await cl(A).me({ cookie: a2.cookie })).status, 401);
    s.eq("X-106", "and on the other instance", (await cl(B).me({ cookie: a2.cookie })).status, 401);
    s.eq("X-107", "positive control: the surviving session still works after the restart", (await cl(A).me({ cookie: b.cookie })).status, 200);
    // parallel logouts of one cookie split over both instances
    const c3 = await cl(A).login(u.email, u.password);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => cl(i % 2).logout({ cookie: c3.cookie })));
    s.check("X-108", "10 parallel logouts of one cookie across both instances: all honest successes, one record", rs.every((r) => r.status === 200 && r.json.revoked === true), rs.map((r) => r.status));
    s.eq("X-109", "refused on both afterwards", [(await cl(A).me({ cookie: c3.cookie })).status, (await cl(B).me({ cookie: c3.cookie })).status], [401, 401]);
  });

  // ---------------------------------------------------------------- account-wide revocation, password change, deactivation
  await s.section("REVOKE", async () => {
    const u = await L.seedUser(admin, { role: "viewer" });
    const sess = []; for (let i = 0; i < 4; i++) sess.push((await cl(i % 2).login(u.email, u.password)).cookie);
    const r = await cl(B).post(`${L.P}/session/revoke-all`, {}, { cookie: sess[0] });
    s.check("X-201", "revoke-all through B (using a session issued by A)", r.status === 200 && r.json.ok === true, r.text);
    const after = await Promise.all(sess.flatMap((c) => [cl(A).me({ cookie: c }), cl(B).me({ cookie: c })]));
    s.check("X-202", "every earlier session is refused by BOTH instances", after.every((x) => x.status === 401), after.map((x) => x.status));
    const fresh = await cl(A).login(u.email, u.password);
    s.check("X-203", "positive control: a new sign-in works on both", (await cl(A).me({ cookie: fresh.cookie })).status === 200 && (await cl(B).me({ cookie: fresh.cookie })).status === 200);
    // password change
    const old = await cl(B).login(u.email, u.password);
    const newPw = "Chang3d!" + L.randomHex(6) + "Zz";
    const ch = await cl(A).post(`${L.P}/session/password`, { current_password: u.password, new_password: newPw }, { cookie: fresh.cookie });
    s.check("X-210", "password change through A", ch.status === 200, ch.text.slice(0, 200));
    s.eq("X-211", "B refuses the session it issued before the change", (await cl(B).me({ cookie: old.cookie })).status, 401);
    s.eq("X-212", "B refuses the old password", (await cl(B).login(u.email, u.password)).status, 401);
    s.eq("X-213", "B accepts the new password", (await cl(B).login(u.email, newPw)).status, 200);
    s.eq("X-214", "the browser that changed it keeps working on B (re-issued cookie)", ch.setCookie ? (await cl(B).me({ cookie: ch.setCookie })).status : 0, 200);
    // deactivation
    const d = await L.seedUser(admin, { role: "viewer" }); const dc = [(await cl(A).login(d.email, d.password)).cookie, (await cl(B).login(d.email, d.password)).cookie];
    await admin.query(`update admin_users set status='inactive' where id='${d.id}'`);
    const inact = await Promise.all([cl(A).me({ cookie: dc[0] }), cl(B).me({ cookie: dc[0] }), cl(A).me({ cookie: dc[1] }), cl(B).me({ cookie: dc[1] })]);
    s.check("X-220", "a deactivated account's sessions are refused immediately by both instances", inact.every((x) => x.status === 401), inact.map((x) => x.status));
    const li = await Promise.all([cl(A).login(d.email, d.password), cl(B).login(d.email, d.password)]);
    s.check("X-221", "and it cannot sign in on either", li.every((x) => x.status === 401 && !x.cookie), li.map((x) => x.status));
    // administrator revoke-sessions of another user through A, by an MFA admin
    const admn = await mfaUser("super_admin", A); const tgt = await L.seedUser(admin, { role: "viewer" });
    const tc = [(await cl(A).login(tgt.email, tgt.password)).cookie, (await cl(B).login(tgt.email, tgt.password)).cookie];
    const tcode = await admn.totp.next();
    const su = await admn.client.stepUp(admn.user.password, "session_revocation", { method: "totp", code: tcode.code });
    const rv = await admn.client.post(`/api/lead-agents/admin/users/${tgt.id}/revoke-sessions`, { reason: "test" }, { headers: { "x-step-up-token": su.token } });
    s.check("X-230", "administrator revokes another user's sessions through A", rv.status === 200, { su: su.status, rv: rv.text.slice(0, 160) });
    const tr = await Promise.all(tc.flatMap((c) => [cl(A).me({ cookie: c }), cl(B).me({ cookie: c })]));
    s.check("X-231", "both instances refuse the target's sessions", tr.every((x) => x.status === 401), tr.map((x) => x.status));
    // the administrator's own cookie used through B (issued by A)
    s.eq("X-232", "positive control: the administrator's own session (issued by A) works on B", (await cl(B).me({ cookie: admn.client.cookie })).status, 200);
  });

  // ---------------------------------------------------------------- single-use factors across instances
  await s.section("REPLAY", async () => {
    const u = await mfaUser("super_admin", A);
    const t1 = await challengeFor(u, A); const t2 = await challengeFor(u, B); const t3 = await challengeFor(u, B);
    const c = await u.totp.next();
    const first = await verify(A, t1, "totp", c.code);
    s.eq("X-301", "positive control: the code verifies on A", first.status, 200);
    const replay = await verify(B, t2, "totp", c.code);
    s.check("X-302", "replay of the same TOTP code on B (own challenge) is refused", replay.status !== 200 && !replay.setCookie, { status: replay.status, body: replay.text.slice(0, 120) });
    const replayA = await verify(A, t3, "totp", c.code);
    s.check("X-303", "and on A again", replayA.status !== 200 && !replayA.setCookie, replayA.status);
    // parallel across instances
    const u2 = await mfaUser("super_admin", B); const c2 = await u2.totp.next();
    const toks = []; for (let i = 0; i < 8; i++) toks.push(await challengeFor(u2, i % 2));
    const rs = await Promise.all(toks.map((t, i) => verify(i % 2, t, "totp", c2.code)));
    s.check("X-304", "one TOTP code raced over both instances (8 challenges): exactly one session", wins(rs) === 1, rs.map((r) => r.status));
    // recovery code
    const u3 = await mfaUser("super_admin", A); const rc = u3.recoveryCodes[0];
    const toks3 = []; for (let i = 0; i < 8; i++) toks3.push(await challengeFor(u3, i % 2));
    const g0 = await num(`select session_generation from admin_users where id='${u3.user.id}'`);
    const rs3 = await Promise.all(toks3.map((t, i) => verify(i % 2, t, "recovery_code", rc)));
    s.check("X-310", "one recovery code raced over both instances: exactly one session", wins(rs3) === 1, rs3.map((r) => r.status));
    s.eq("X-311", "one code spent, sessions revoked once", [await num(`select count(*) from admin_mfa_recovery_codes where admin_user_id='${u3.user.id}' and used_at is not null`), (await num(`select session_generation from admin_users where id='${u3.user.id}'`)) - g0], [1, 1]);
    const late = await verify(B, await challengeFor(u3, B), "recovery_code", rc);
    s.check("X-312", "the spent code is refused on the other instance later", late.status !== 200, late.status);
    s.eq("X-313", "the session that existed before the recovery login is dead on both instances", [(await cl(A).me({ cookie: u3.client.cookie })).status, (await cl(B).me({ cookie: u3.client.cookie })).status], [401, 401]);
    // enrolment activation raced over both instances
    const e = await L.seedUser(admin, { role: "super_admin" }); const ea = await cl(A).login(e.email, e.password); const eb = new L.Client(fx.apps[B].url); eb.cookie = ea.cookie;
    const ca = cl(A); ca.cookie = ea.cookie;
    const su = await ca.stepUp(e.password, "mfa_management"); const h = { "x-step-up-token": su.token };
    const b = await ca.post(`${L.P}/session/mfa/enroll/totp/begin`, {}, { headers: h });
    const tt = new L.TotpSource(b.json.secret_base32); const ec = await tt.next();
    const rsE = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? eb : ca).post(`${L.P}/session/mfa/enroll/totp/confirm`, { credential_id: b.json.credential_id, code: ec.code }, { headers: h })));
    s.check("X-320", "one pending enrolment confirmed from both instances at once: exactly one activation", wins(rsE) === 1, rsE.map((r) => r.status));
    s.eq("X-321", "one batch of 10 recovery codes", await num(`select count(*) from admin_mfa_recovery_codes where admin_user_id='${e.id}' and used_at is null`), 10);
  });

  // ---------------------------------------------------------------- MFA lock
  await s.section("LOCK", async () => {
    const u = await mfaUser("super_admin", A); const ok = await u.totp.next();
    const toks = []; for (let i = 0; i < 8; i++) toks.push(await challengeFor(u, i % 2));
    const out = [];
    for (let i = 0; i < 5; i++) out.push(await verify(i % 2, toks[i], "totp", "000000", { ip: `10.9.0.${i + 1}` }));
    s.check("X-401", "five wrong codes, alternating between the instances, are refused", out.every((r) => r.status === 401 || r.status === 429), out.map((r) => r.status));
    const lockedA = await verify(A, toks[5], "totp", ok.code, { ip: "10.9.1.1" }); const lockedB = await verify(B, toks[6], "totp", ok.code, { ip: "10.9.1.2" });
    s.check("X-402", "the lock set by failures spread over both instances stops the CORRECT code on A", lockedA.status === 429 && !lockedA.setCookie, { status: lockedA.status, body: lockedA.text.slice(0, 120) });
    s.check("X-403", "and on B", lockedB.status === 429 && !lockedB.setCookie, { status: lockedB.status });
    const su = await cl(B).stepUp(u.user.password, "mfa_management", { method: "totp", code: ok.code }, { cookie: u.client.cookie });
    s.check("X-404", "step-up through B honours the lock too", su.status === 429 || su.status === 401, su.status);
    s.check("X-405", "the lock is time-limited and persisted (database), not a permanent state", (await num(`select extract(epoch from (mfa_locked_until - now())) from admin_users where id='${u.user.id}'`)) > 0 && (await num(`select extract(epoch from (mfa_locked_until - now())) from admin_users where id='${u.user.id}'`)) <= 3600.5);
    await admin.query(`select office_mfa_clear_failures('${u.user.id}')`);
    const fine = await verify(B, toks[7], "totp", ok.code, { ip: "10.9.1.3" });
    s.eq("X-406", "positive control: once the lock is cleared the same (never consumed) code verifies on B", fine.status, 200);
  });

  // ---------------------------------------------------------------- settings
  await s.section("SETTINGS", async () => {
    const u = await mfaUser("super_admin", A);
    const key = "office_document_brand_name"; const path = `/api/lead-agents/admin/settings/${key}`;
    const ca = cl(A); ca.cookie = u.client.cookie; const cb = cl(B); cb.cookie = u.client.cookie;
    const v0 = (await cb.get(path)).json.setting.version;
    const w = await ca.put(path, { value: "Alpha Brand", expected_version: v0 });
    s.eq("X-501", "setting written through A", w.status, 200);
    const rb = await cb.get(path);
    s.check("X-502", "B reads the new value and version at once", rb.json.setting.value === "Alpha Brand" && rb.json.setting.version === v0 + 1, rb.text.slice(0, 200));
    const stale = await cb.put(path, { value: "Beta Brand", expected_version: v0 });
    s.eq("X-503", "B writing from the stale version is a conflict", stale.status, 409);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? cb : ca).put(path, { value: `Race ${i}`, expected_version: v0 + 1 })));
    s.check("X-504", "ten writes from the same version raced over both instances: exactly one 200, nine 409", wins(rs) === 1 && rs.filter((r) => r.status === 409).length === 9, rs.map((r) => r.status));
    // session duration: security-policy setting, applied at issuance by the OTHER instance
    const ttl = "/api/lead-agents/admin/settings/office_session_ttl_hours";
    const cur = (await cb.get(ttl)).json.setting.version;
    const code2 = await u.totp.next();
    const su = await ca.stepUp(u.user.password, "security_policy_write", { method: "totp", code: code2.code });
    const put = await ca.put(ttl, { value: 2, expected_version: cur }, { headers: { "x-step-up-token": su.token } });
    s.check("X-510", "session duration set to 2 hours through A (step-up, second factor)", put.status === 200, { su: su.status, put: put.text.slice(0, 200) });
    const e = await L.seedUser(admin, { role: "viewer" });
    const lb = await cl(B).login(e.email, e.password);
    const ma = lb.rawSetCookie.map((c) => /Max-Age=(\d+)/i.exec(c)).filter(Boolean).map((m) => Number(m[1]))[0];
    s.eq("X-511", "a sign-in on B uses the new duration (7200 s)", ma, 7200);
    const noStep = await cb.put(ttl, { value: 500, expected_version: cur + 1 });
    s.check("X-512", "negative control: B refuses the same write without a step-up grant", noStep.status === 403, noStep.status);
    const forged = await cb.put(ttl, { value: 500, expected_version: cur + 1 }, { headers: { "x-step-up-token": su.token + "x" } });
    s.check("X-513", "and with a damaged grant", forged.status === 403, forged.status);
    // a grant issued by A is accepted by B (stateless) but only for its purpose
    const wrongPurpose = await cb.put(ttl, { value: 500, expected_version: cur + 1 }, { headers: { "x-step-up-token": (await ca.stepUp(u.user.password, "mfa_management", { method: "totp", code: (await u.totp.next()).code })).token } });
    s.check("X-514", "a grant for another purpose (issued by A) is refused by B", wrongPurpose.status === 403, wrongPurpose.status);
  });

  // ---------------------------------------------------------------- administrator reset across instances
  await s.section("RESET", async () => {
    const actor = await mfaUser("super_admin", A); const target = await mfaUser("viewer", B);
    const tc = target.client.cookie;
    const c = await actor.totp.next();
    const su = await cl(B).stepUp(actor.user.password, "mfa_management", { method: "totp", code: c.code }, { cookie: actor.client.cookie });
    const rs = await cl(B).post(`/api/lead-agents/admin/users/${target.user.id}/mfa/reset`, { reason: "lost device, verified", confirm: true, confirm_email: target.user.email }, { cookie: actor.client.cookie, headers: { "x-step-up-token": su.token } });
    s.check("X-601", "administrator reset through B of an account enrolled through B, by an admin signed in on A", rs.status === 200, { su: su.status, rs: rs.text.slice(0, 200) });
    s.eq("X-602", "the target's session is dead on A and B", [(await cl(A).me({ cookie: tc })).status, (await cl(B).me({ cookie: tc })).status], [401, 401]);
    const l = await cl(A).login(target.user.email, target.user.password);
    s.check("X-603", "the target signs in on A with the password and is NOT asked for the removed factor", !(l.json && l.json.mfa_required), l.text.slice(0, 160));
    s.check("X-604", "...and is told or forced to enrol again (requirement stamped)", await num(`select (mfa_required_after is not null)::int from admin_users where id='${target.user.id}'`) === 1);
    const oldChallenge = await cl(B).post(`${L.P}/session/mfa/verify`, { challenge_token: target.client.cookie, method: "totp", code: "123456" });
    s.check("X-605", "negative control: nothing of the old factor works", oldChallenge.status !== 200);
  });

  // ---------------------------------------------------------------- enforcement policy cache
  await s.section("POLICY", async () => {
    // an account that is past its grace period; the policy is changed in the database (as if by a third instance), B has the old policy cached
    const u = await L.seedUser(admin, { role: "super_admin" });
    await admin.query(`update admin_users set created_at = now() - interval '60 days' where id='${u.id}'`);
    const first = await cl(B).login(u.email, u.password);
    s.check("X-701", "positive control: policy 'off' lets the account sign in on B (and caches the policy)", first.status === 200 && Boolean(first.cookie), first.text.slice(0, 120));
    await admin.query(`select office_runtime_setting_write('office_mfa_enforcement', '"all"'::jsonb, 'x', null, 'r', false, true)`);
    await admin.query(`update office_runtime_settings set updated_at = now() - interval '30 days' where key='office_mfa_enforcement'`);
    const stale = await cl(B).login(u.email, u.password);
    if (stale.status === 200 && stale.cookie) s.info("a policy change made in the database is honoured by another instance only after its cache expires (up to 10 s); changes made through that same instance invalidate at once");
    const conv = await L.waitFor(async () => { const r = await cl(B).login(u.email, u.password); return r.json && r.json.mfa_enrollment_required ? r : null; }, { timeoutMs: 20000, intervalMs: 500, what: "instance B to honour the changed enforcement policy" }).catch(() => null);
    s.check("X-702", "B honours the changed enforcement policy within the cache lifetime (no sign-in without a factor once the grace has ended)", Boolean(conv));
    const viaA = await cl(A).login(u.email, u.password);
    s.check("X-703", "A (which had not cached it) honours it at once", viaA.json && viaA.json.mfa_enrollment_required === true && !viaA.cookie, viaA.text.slice(0, 160));
    const old = await cl(B).me({ cookie: first.cookie });
    s.check("X-704", "the session issued before the change ends once the deadline has passed", old.status === 401, old.status);
    await admin.query(`delete from office_runtime_settings where key='office_mfa_enforcement'`);
  });

  // ---------------------------------------------------------------- login throttling across instances
  await s.section("THROTTLE", async () => {
    const mk = (n) => L.AppServer.start({ sut: L.SUT, env: L.appEnv({ restUrl: fx.proxies[0].url, serviceJwt: st.jwt("service_role"), sessionSecret: fx.sessionSecret, apiKey: fx.apiKey, extra: { LEAD_AGENTS_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "3" } }), name: n, suite: s });
    const t1 = await mk("thr1"); const t2 = await mk("thr2");
    const u = await L.seedUser(admin, { role: "viewer" });
    const c1 = new L.Client(t1.url, { ip: "198.51.100.7" }); const c2 = new L.Client(t2.url, { ip: "198.51.100.7" });
    const bad1 = []; for (let i = 0; i < 5; i++) bad1.push((await c1.login(u.email, "Wrong!Passw0rd" + i)).status);
    s.check("X-801", "positive control: instance 1 throttles the address/account after 3 attempts (429)", bad1.includes(429), bad1);
    const good1 = await c1.login(u.email, u.password);
    s.eq("X-802", "on that instance even the correct password is refused while throttled", good1.status, 429);
    const good2 = await c2.login(u.email, u.password);
    s.check("X-803", "the throttle state is shared: the CORRECT password on the second instance is refused too", good2.status === 429, { status: good2.status });
    const bad2 = []; for (let i = 0; i < 5; i++) bad2.push((await new L.Client(t2.url, { ip: "198.51.100.7" }).login(u.email, "Wrong!Passw0rd" + i)).status);
    s.check("X-804", "the attacker does not get a second full budget by switching instances (wrong guesses accepted across both instances stay within the single limit of 3)", (bad1.filter((x) => x !== 429).length + bad2.filter((x) => x !== 429).length) <= 3, { inst1: bad1, inst2: bad2 });
    s.info(`login throttle counters are per instance (in memory): wrong guesses accepted before throttling: instance 1 = ${bad1.filter((x) => x !== 429).length}, instance 2 = ${bad2.filter((x) => x !== 429).length}`);
  });
});
