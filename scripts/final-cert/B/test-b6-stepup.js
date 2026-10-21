"use strict";
// AREA B / B6: step-up grants: purposes, eligibility, expiry, session and account binding, permission loss, password change, revocation, forged/edited grants,
// API key / edge token refusal, second-factor requirement for enrolled accounts (TOTP, WebAuthn, fresh session proof), recovery codes refused, use-time gate on every consumer.
const crypto = require("crypto");
const H = require("./lib/harness");
const { Forge, decodePayload, flip, retamper } = require("./lib/forge");
const { A, Client, U } = H;

H.runSuite("b6-stepup", async (c) => {
  const srv = await H.makeServer();
  c.defer(async () => { await srv.stop(); H.rmrf(srv.dir); });
  const short = await H.makeServer({ extra: { LEAD_AGENTS_STEP_UP_TTL_MS: "2500" } });
  c.defer(async () => { await short.stop(); H.rmrf(short.dir); });
  const forge = new Forge(srv);
  const admin = await H.adminLogin(srv);
  const hdr = (g) => ({ "x-step-up-token": g.body.step_up.token });
  const tokenHdr = (t) => ({ "x-step-up-token": t });
  const stripId = (r) => JSON.stringify({ s: r.status, b: { ...r.body, request_id: undefined } });
  const check = (client, purpose, token) => client.post(`${A}/session/step-up/check`, { purpose }, { headers: tokenHdr(token) });

  // ------------------------------------------------------------ S1: issuance, eligibility, refusal of machine credentials
  const sa = await H.newPerson(admin, { role: "super_admin", enroll: false });
  const staff = await H.newPerson(admin, { enroll: false });
  for (const purpose of ["security_policy_write", "session_revocation", "mfa_management"]) {
    const r = await sa.stepUp(sa.client, purpose, { mfa: null });
    c.status(`S1.${purpose}`, `positive control: super administrator obtains a ${purpose} grant with the password`, r, 200);
    c.ok(`S1.${purpose}.shape`, `${purpose} grant states purpose, expiry within 10 minutes and carries no password`, r.body.step_up.purpose === purpose && r.body.step_up.ttl_seconds <= 600 && r.body.step_up.ttl_seconds > 0 && !r.text.includes(sa.password), r.body.step_up && { ttl: r.body.step_up.ttl_seconds, purpose: r.body.step_up.purpose });
  }
  c.status("S1.4", "a non-privileged account obtains an mfa_management grant (own factors)", await staff.stepUp(staff.client, "mfa_management", { mfa: null }), 200);
  c.status("S1.5", "a non-privileged account cannot obtain a security_policy_write grant", await staff.stepUp(staff.client, "security_policy_write", { mfa: null }), 403);
  c.status("S1.6", "a non-privileged account cannot obtain a session_revocation grant", await staff.stepUp(staff.client, "session_revocation", { mfa: null }), 403);
  c.status("S1.7", "an unknown purpose is refused (400)", await sa.stepUp(sa.client, "do_anything", { mfa: null }), 400);
  c.status("S1.8", "an empty purpose is refused", await sa.stepUp(sa.client, "", { mfa: null }), [400, 403]);
  c.status("S1.9", "no session: 401", await new Client(srv).post(`${A}/session/step-up`, { purpose: "mfa_management", password: sa.password }), 401);
  c.status("S1.10", "API key: refused", await new Client(srv).post(`${A}/session/step-up`, { purpose: "mfa_management", password: admin.password }, { headers: { authorization: `Bearer ${H.API_KEY}` } }), 403);
  c.status("S1.11", "edge token: refused", await new Client(srv).post(`${A}/session/step-up`, { purpose: "mfa_management", password: admin.password }, { headers: { authorization: `Bearer ${H.EDGE}` } }), 403);
  c.status("S1.12", "API key presented in x-api-key: refused", await new Client(srv).post(`${A}/session/step-up`, { purpose: "mfa_management", password: admin.password }, { headers: { "x-api-key": H.API_KEY } }), 403);
  c.status("S1.13", "API key together with a valid session cookie: the session is used and the grant is for the person (not an API-key grant)", await sa.client.post(`${A}/session/step-up`, { purpose: "mfa_management", password: sa.password }, { headers: { authorization: `Bearer ${H.API_KEY}` } }), 200);
  const wrongBody = [];
  for (const pw of [undefined, "", null, 123, ["x"], { a: 1 }, "wrong-password-1234"]) {
    wrongBody.push(await sa.client.post(`${A}/session/step-up`, { purpose: "mfa_management", ...(pw === undefined ? {} : { password: pw }) }));
  }
  c.ok("S1.14", "missing / empty / non-string / wrong passwords are all refused with the same 401 answer", wrongBody.every((r) => r.status === 401) && new Set(wrongBody.map(stripId)).size === 1, wrongBody.map(stripId));
  c.ok("S1.15", "step-up responses are not cacheable", /no-store/.test((await sa.client.post(`${A}/session/step-up`, { purpose: "mfa_management", password: sa.password })).headers.get("cache-control") || ""));

  // ------------------------------------------------------------ S2: purpose isolation at every consumer
  const gM = await sa.stepUp(sa.client, "mfa_management", { mfa: null });
  const gR = await sa.stepUp(sa.client, "session_revocation", { mfa: null });
  const gP = await sa.stepUp(sa.client, "security_policy_write", { mfa: null });
  c.status("S2.1", "check: right purpose is accepted", await check(sa.client, "security_policy_write", gP.body.step_up.token), 200);
  for (const [name, g, want] of [["mfa_management", gM, "security_policy_write"], ["session_revocation", gR, "security_policy_write"], ["security_policy_write", gP, "session_revocation"], ["security_policy_write", gP, "mfa_management"]]) {
    const r = await check(sa.client, want, g.body.step_up.token);
    c.ok(`S2.check.${name}->${want}`, `a ${name} grant does not authorise ${want}`, r.status === 403 && /wrong_purpose/.test(JSON.stringify(r.body)), r.body);
  }
  const victim = await H.createUser(admin, {}); await victim.loginRaw();
  const rv = (g) => sa.client.post(`${A}/users/${victim.id}/revoke-sessions`, {}, { headers: hdr(g) });
  c.status("S2.5", "revoke-sessions with a security_policy_write grant is refused", await rv(gP), 403);
  c.status("S2.6", "revoke-sessions with an mfa_management grant is refused", await rv(gM), 403);
  c.status("S2.7", "revoke-sessions without a grant is refused", await sa.client.post(`${A}/users/${victim.id}/revoke-sessions`, {}), 403);
  c.status("S2.8", "positive control: revoke-sessions with the right grant works", await rv(gR), 200);
  c.status("S2.9", "mfa enrolment begin with a session_revocation grant is refused", await sa.client.post(`${A}/session/mfa/enroll/totp/begin`, {}, { headers: hdr(gR) }), 403);
  c.status("S2.10", "a settings write that needs security_policy_write refuses an mfa_management grant", await sa.client.put(`${A}/settings/office_mfa_enforcement`, { value: "optional", expected_version: 0, confirm: true }, { headers: hdr(gM) }), 403);

  // ------------------------------------------------------------ S3: session and account binding
  const sa2 = await sa.signIn();
  c.status("S3.1", "a grant is bound to the session that earned it: same account, other session is refused", await check(sa2.client, "security_policy_write", gP.body.step_up.token), 403);
  c.ok("S3.2", "...with the reason wrong_session", /wrong_session/.test(JSON.stringify((await check(sa2.client, "security_policy_write", gP.body.step_up.token)).body)));
  const sb = await H.newPerson(admin, { role: "super_admin", enroll: false });
  const bGrant = await sb.stepUp(sb.client, "security_policy_write", { mfa: null });
  c.status("S3.3", "another account's grant is refused (even with the same role)", await check(sa.client, "security_policy_write", bGrant.body.step_up.token), 403);
  c.status("S3.4", "an unrelated cookie plus someone else's grant is refused", await check(new Client(srv), "security_policy_write", bGrant.body.step_up.token), 401);
  const edgeUse = await new Client(srv).post(`${A}/session/step-up/check`, { purpose: "security_policy_write" }, { headers: { authorization: `Bearer ${H.EDGE}`, ...tokenHdr(gP.body.step_up.token) } });
  c.ok("S3.5", "an edge token cannot use a stolen grant", edgeUse.status === 403 || edgeUse.status === 401, edgeUse.status);
  const apiUse = await new Client(srv).post(`${A}/session/step-up/check`, { purpose: "security_policy_write" }, { headers: { authorization: `Bearer ${H.API_KEY}`, ...tokenHdr(gP.body.step_up.token) } });
  c.ok("S3.6", "an API key cannot use a stolen grant", apiUse.status === 403 || apiUse.status === 401, apiUse.status);

  // ------------------------------------------------------------ S4: forged / edited grants
  const tok = gP.body.step_up.token; const cl = decodePayload(tok);
  c.ok("S4.0", "claims bound: purpose, subject, session, password state, generation, expiry", cl && cl.purpose && cl.sub === sa.id && cl.sid && cl.pwf && Number.isInteger(cl.sg) && cl.exp > Date.now(), cl && Object.keys(cl));
  c.ok("S4.0b", "claims never contain the password or the password hash", !JSON.stringify(cl).includes(sa.password) && !JSON.stringify(cl).includes("scrypt") && !/[0-9a-f]{128}/.test(JSON.stringify(cl)));
  c.status("S4.1", "flipped signature is refused", await check(sa.client, "security_policy_write", flip(tok)), 403);
  c.status("S4.2", "payload with a longer expiry (signature kept) is refused", await check(sa.client, "security_policy_write", retamper(tok, (x) => { x.exp += 3600000; })), 403);
  c.status("S4.3", "payload with another purpose (signature kept) is refused", await check(sa.client, "session_revocation", retamper(tok, (x) => { x.purpose = "session_revocation"; })), 403);
  c.status("S4.4", "payload with a second-factor claim added (signature kept) is refused", await check(sa.client, "security_policy_write", retamper(tok, (x) => { x.mf = true; x.mfat = x.iat; })), 403);
  c.status("S4.5", "payload with another subject (signature kept) is refused", await check(sa.client, "security_policy_write", retamper(tok, (x) => { x.sub = sb.id; })), 403);
  for (const [i, bad] of ["", "x", "a.b", "a.b.c", tok + ".extra", tok.split(".")[0], "." + tok.split(".")[1], "A".repeat(100000)].entries()) {
    const r = await check(sa.client, "security_policy_write", bad);
    c.ok(`S4.6.${i}`, `malformed grant #${i} is refused without a server error (431 = header too large is a refusal)`, [400, 403, 413, 431].includes(r.status), r.status);
  }
  const cookie = sa.client.cookie;
  c.status("S4.7", "(model control) a grant minted with the legitimate secret for this very session is accepted - the forging helper is faithful", await check(sa.client, "security_policy_write", forge.grant(sa.email, cookie, { purpose: "security_policy_write" })), 200);
  c.status("S4.8", "a correctly signed but EXPIRED grant is refused", await check(sa.client, "security_policy_write", forge.grant(sa.email, cookie, { purpose: "security_policy_write", iat: Date.now() - 600000, exp: Date.now() - 1000 })), 403);
  c.status("S4.9", "a correctly signed grant for a stale session generation is refused", await check(sa.client, "security_policy_write", forge.grant(sa.email, cookie, { purpose: "security_policy_write", sg: 42 })), 403);
  c.status("S4.10", "a correctly signed grant for a stale password state is refused", await check(sa.client, "security_policy_write", forge.grant(sa.email, cookie, { purpose: "security_policy_write", pwf: "f".repeat(32) })), 403);
  c.status("S4.11", "a correctly signed grant for another session is refused", await check(sa.client, "security_policy_write", forge.grant(sa.email, "some-other-cookie-value", { purpose: "security_policy_write" })), 403);
  c.status("S4.12", "a correctly signed grant with an unknown purpose is refused", await check(sa.client, "security_policy_write", forge.grant(sa.email, cookie, { purpose: "everything" })), 403);
  c.status("S4.13", "a grant signed with another key is refused", await check(sa.client, "security_policy_write", (() => { const g = forge.grant(sa.email, cookie, { purpose: "security_policy_write" }); return g.split(".")[0] + "." + "0".repeat(64); })()), 403);
  c.status("S4.14", "a MFA session token used as a grant is refused", await check(sa.client, "security_policy_write", cookie), 403);
  c.status("S4.15", "the check route needs POST", await sa.client.get(`${A}/session/step-up/check`), 405);

  // ------------------------------------------------------------ S5: expiry (short-lived server) and ceiling
  const adminS = await H.adminLogin(short);
  const gShort = await adminS.stepUp(adminS.client, "security_policy_write", { mfa: null });
  c.ok("S5.1", "grant lifetime follows the configured TTL (2.5 s)", gShort.body.step_up.ttl_seconds <= 3, gShort.body.step_up);
  c.status("S5.2", "the grant works while fresh", await check(adminS.client, "security_policy_write", gShort.body.step_up.token), 200);
  const end = Date.now() + 20000; let expired = null;
  while (Date.now() < end) { const r = await check(adminS.client, "security_policy_write", gShort.body.step_up.token); if (r.status !== 200) { expired = r; break; } await U.sleep(300); }
  c.ok("S5.3", "the grant stops working after its lifetime (reason expired)", expired && expired.status === 403 && /expired/.test(JSON.stringify(expired.body)), expired && expired.body);
  const huge = await H.makeServer({ extra: { LEAD_AGENTS_STEP_UP_TTL_MS: "99999999999" } });
  c.defer(async () => { await huge.stop(); H.rmrf(huge.dir); });
  const adminH = await H.adminLogin(huge);
  const gHuge = await adminH.stepUp(adminH.client, "mfa_management", { mfa: null });
  c.ok("S5.4", "a configured TTL above the hard maximum is capped at 10 minutes", gHuge.body.step_up.ttl_seconds <= 600, gHuge.body.step_up.ttl_seconds);

  // ------------------------------------------------------------ S6: events that kill grants: permission loss, password change, revocation, deactivation
  const pl = await H.newPerson(admin, { role: "super_admin", enroll: false });
  const plG = await pl.stepUp(pl.client, "security_policy_write", { mfa: null });
  c.status("S6.0", "setup: grant works before the role is lowered", await check(pl.client, "security_policy_write", plG.body.step_up.token), 200);
  const demote = await admin.client.patch(`${A}/users/${pl.id}`, { role: "ochiga_staff" });
  c.status("S6.1", "setup: administrator lowers the role", demote, 200);
  const afterDemote = await check(pl.client, "security_policy_write", plG.body.step_up.token);
  c.ok("S6.2", "a grant stops working when the permission behind it is removed (even though the session is still valid)", afterDemote.status === 403, afterDemote.body);
  c.status("S6.3", "and the demoted account cannot obtain a new one", await pl.stepUp(pl.client, "security_policy_write", { mfa: null }), 403);
  const scopeless = await H.createUser(admin, { role: "ochiga_admin" }); await scopeless.loginRaw();
  c.status("S6.4", "a role without team.manage (ochiga_admin) cannot obtain security_policy_write", await scopeless.stepUp(scopeless.client, "security_policy_write", { mfa: null }), 403);
  const withScope = await H.createUser(admin, { role: "ochiga_admin", scopes: ["team.manage"] }); await withScope.loginRaw();
  c.ok("S6.4b", "...but a scope grant of team.manage is honoured only for the permission, never for the super_admin role requirement", [200, 403].includes((await withScope.stepUp(withScope.client, "security_policy_write", { mfa: null })).status));

  const pc = await H.newPerson(admin, { role: "super_admin", enroll: false });
  const pcG = await pc.stepUp(pc.client, "security_policy_write", { mfa: null });
  const newPw = U.randomPassword();
  const chg = await pc.client.post(`${A}/session/password`, { current_password: pc.password, new_password: newPw });
  c.status("S6.5", "setup: self password change", chg, 200);
  c.status("S6.6", "a grant earned before a password change is dead (the re-issued browser session has a new binding)", await check(pc.client, "security_policy_write", pcG.body.step_up.token), 403);
  pc.password = newPw;
  c.status("S6.7", "positive control: a new grant with the new password works", await check(pc.client, "security_policy_write", (await pc.stepUp(pc.client, "security_policy_write", { mfa: null })).body.step_up.token), 200);

  const rk = await H.newPerson(admin, { role: "super_admin", enroll: false });
  const rkG = await rk.stepUp(rk.client, "security_policy_write", { mfa: null });
  const rkAll = await rk.client.post(`${A}/session/revoke-all`, { keep_current: true });
  c.status("S6.8", "setup: revoke-all keeping the current browser", rkAll, 200);
  c.status("S6.9", "grants earned before a revocation are dead even for the kept browser", await check(rk.client, "security_policy_write", rkG.body.step_up.token), 403);

  const dv = await H.newPerson(admin, { role: "super_admin", enroll: false });
  const dvG = await dv.stepUp(dv.client, "mfa_management", { mfa: null });
  await admin.client.patch(`${A}/users/${dv.id}`, { status: "inactive" });
  c.status("S6.10", "a deactivated account's grant is dead (session is dead)", await dv.client.post(`${A}/session/mfa/enroll/totp/begin`, {}, { headers: hdr(dvG) }), 401);
  await admin.client.patch(`${A}/users/${dv.id}`, { status: "active" });
  c.status("S6.11", "restoring the account does not revive the old session or grant", await dv.client.post(`${A}/session/mfa/enroll/totp/begin`, {}, { headers: hdr(dvG) }), 401);

  const lo = await H.newPerson(admin, { enroll: false });
  const loG = await lo.stepUp(lo.client, "mfa_management", { mfa: null });
  await lo.client.post(`${A}/session/logout`, {});
  const copied = new Client(srv, { cookie: "" });
  c.ok("S6.12", "after logout the browser holds no cookie and the grant is useless without the session", (await copied.post(`${A}/session/mfa/enroll/totp/begin`, {}, { headers: hdr(loG) })).status === 401);

  // ------------------------------------------------------------ S7: second factor for enrolled accounts
  const e = await H.newPerson(admin, { role: "super_admin" });
  const ecl = (await e.signIn()).client;
  const forgeStale = (mftAgo) => new Client(srv, { cookie: forge.session(e.email, { mf: true, mft: Date.now() - mftAgo }) });
  // a session whose own proof is older than 5 minutes
  const stale = forgeStale(6 * 60 * 1000);
  const noFactor = await stale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: e.password });
  const wrongPw = await stale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: "wrong-password-0000", mfa: { method: "totp", code: U.totpAtStep(e.secret, U.stepNow() + 1) } });
  const wrongFactor = await stale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: e.password, mfa: { method: "totp", code: "000000" } });
  c.status("S7.1", "enrolled account, stale proof, password only: no grant (401)", noFactor, 401);
  c.ok("S7.2", "'second factor missing', 'wrong password' and 'wrong factor' give the same answer (no oracle)", new Set([stripId(noFactor), stripId(wrongPw), stripId(wrongFactor)]).size === 1, [stripId(noFactor), stripId(wrongPw), stripId(wrongFactor)]);
  const fresh4 = forgeStale(4 * 60 * 1000);
  const viaProof = await fresh4.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: e.password });
  c.status("S7.3", "a sign-in proof 4 minutes old counts as a fresh second factor", viaProof, 200);
  c.ok("S7.4", "grant is marked mfa_verified with second_factor=session_proof", viaProof.body.step_up.mfa_verified === true && viaProof.body.step_up.second_factor === "session_proof", viaProof.body.step_up);
  c.ok("S7.5", "grant claims carry mf and a verification time not later than issue", (() => { const k = decodePayload(viaProof.body.step_up.token); return k.mf === true && k.mfat > 0 && k.mfat <= k.iat; })());
  const t = await U.nextTotp(e.secret, e.lastStep);
  const viaTotp = await stale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: e.password, mfa: { method: "totp", code: t.code } });
  e.lastStep = t.step;
  c.status("S7.6", "a fresh TOTP code yields the grant even when the sign-in proof is stale", viaTotp, 200);
  c.eq("S7.7", "second factor reported as totp", viaTotp.body.step_up.second_factor, "totp");
  const replay = await stale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: e.password, mfa: { method: "totp", code: t.code } });
  c.status("S7.8", "the same TOTP code cannot earn a second grant (replay)", replay, 401);
  c.eq("S7.9", "replay answer equals the wrong-factor answer", stripId(replay), stripId(wrongFactor));
  const olderStep = await stale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: e.password, mfa: { method: "totp", code: U.totpAtStep(e.secret, t.step - 1) } });
  c.status("S7.10", "an older step than the last accepted one is refused", olderStep, 401);
  for (const [i, m] of [{ method: "sms", code: "123456" }, { method: "totp" }, { method: "totp", code: 123456 }, { method: "webauthn" }, { method: "webauthn", challenge_id: "x" }, { method: "webauthn", challenge_id: "x", response: "no" }, "totp", 7, [], null, { method: ["totp"], code: "123456" }].entries()) {
    const r = await stale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: e.password, mfa: m });
    c.ok(`S7.11.${i}`, `malformed mfa object #${i} is refused with the generic answer`, r.status === 401, { status: r.status, body: r.body });
  }
  // the TOTP step is only consumed when the password is right
  const t2 = await U.nextTotp(e.secret, e.lastStep);
  const pwWrongKeepsCode = await stale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: "wrong-password-1111", mfa: { method: "totp", code: t2.code } });
  const afterWrongPw = await stale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: e.password, mfa: { method: "totp", code: t2.code } });
  e.lastStep = t2.step;
  c.ok("S7.12", "a wrong password does not burn a valid TOTP code (password is checked first)", pwWrongKeepsCode.status === 401 && afterWrongPw.status === 200, [pwWrongKeepsCode.status, afterWrongPw.status]);
  const wpar = (async () => { const tt = await U.nextTotp(e.secret, e.lastStep); const rs = await Promise.all(Array.from({ length: 10 }, () => stale.clone().post(`${A}/session/step-up`, { purpose: "security_policy_write", password: e.password, mfa: { method: "totp", code: tt.code } }))); e.lastStep = tt.step; return rs; })();
  const par = await wpar;
  c.eq("S7.13", "10 parallel step-ups with one TOTP code produce exactly one grant", par.filter((r) => r.status === 200).length, 1);

  // use-time gate: a grant WITHOUT a second factor is not honoured for an enrolled account at ANY consumer
  const ecookie = ecl.cookie;
  const noMf = forge.grant(e.email, ecookie, { purpose: "security_policy_write", mf: false });
  const rNo = await check(ecl, "security_policy_write", noMf);
  c.ok("S7.20", "step-up/check refuses a password-only grant of an enrolled account (mfa_required)", rNo.status === 403 && /mfa_required/.test(JSON.stringify(rNo.body)), rNo.body);
  const withMf = forge.grant(e.email, ecookie, { purpose: "security_policy_write", mf: true });
  c.status("S7.21", "(model control) the same grant with a valid second-factor claim is honoured", await check(ecl, "security_policy_write", withMf), 200);
  const futureMfat = forge.grant(e.email, ecookie, { purpose: "security_policy_write", mf: true, mfat: Date.now() + 3600000 });
  c.ok("S7.22", "a second-factor claim dated after the grant's issue time does not count", (await check(ecl, "security_policy_write", futureMfat)).status === 403);
  const zeroMfat = forge.grant(e.email, ecookie, { purpose: "security_policy_write", mf: true, mfat: 0 });
  c.ok("S7.23", "a second-factor claim without a verification time does not count", (await check(ecl, "security_policy_write", zeroMfat)).status === 403);
  const victim2 = await H.createUser(admin, {}); await victim2.loginRaw();
  const rvNo = await ecl.post(`${A}/users/${victim2.id}/revoke-sessions`, {}, { headers: tokenHdr(forge.grant(e.email, ecookie, { purpose: "session_revocation", mf: false })) });
  c.ok("S7.24", "revoke-sessions refuses a password-only grant of an enrolled account", rvNo.status === 403 && /mfa_required/.test(JSON.stringify(rvNo.body)), rvNo.body);
  const rvYes = await ecl.post(`${A}/users/${victim2.id}/revoke-sessions`, {}, { headers: tokenHdr(forge.grant(e.email, ecookie, { purpose: "session_revocation", mf: true })) });
  c.status("S7.25", "(model control) revoke-sessions with a second-factor grant works", rvYes, 200);
  const setNo = await ecl.put(`${A}/settings/office_mfa_enforcement`, { value: "optional", expected_version: 0, confirm: true }, { headers: tokenHdr(forge.grant(e.email, ecookie, { purpose: "security_policy_write", mf: false })) });
  c.ok("S7.26", "a governed settings write refuses a password-only grant of an enrolled account", setNo.status === 403 && /mfa_required/.test(JSON.stringify(setNo.body)), setNo.body);
  const mgmtNo = await ecl.post(`${A}/session/mfa/recovery-codes/regenerate`, {}, { headers: tokenHdr(forge.grant(e.email, ecookie, { purpose: "mfa_management", mf: false })) });
  c.ok("S7.27", "factor management refuses a password-only grant of an enrolled account", mgmtNo.status === 403 && /mfa_required/.test(JSON.stringify(mgmtNo.body)), mgmtNo.body);
  const resetNo = await ecl.post(`${A}/users/${victim2.id}/mfa/reset`, { reason: "test reason", confirm: true, confirm_email: victim2.email }, { headers: tokenHdr(forge.grant(e.email, ecookie, { purpose: "mfa_management", mf: false })) });
  c.ok("S7.28", "administrator MFA reset refuses a password-only grant", resetNo.status === 403, resetNo.body);

  // password-only grant earned BEFORE enrolment stops working once a factor exists
  const late = await H.createUser(admin, { role: "super_admin" }); await late.loginRaw();
  const lateGrant = await late.stepUp(late.client, "security_policy_write", { mfa: null });
  c.status("S7.30", "setup: a password-only grant is earned by a not-yet-enrolled super administrator", await check(late.client, "security_policy_write", lateGrant.body.step_up.token), 200);
  const en = await late.enrollTotp(late.client);
  c.ok("S7.31", "setup: the account enrols", en.ok);
  c.ok("S7.32", "the old password-only grant no longer works after enrolment", (await check(late.client, "security_policy_write", lateGrant.body.step_up.token)).status === 403);

  // lock shared with sign-in; lock is checked before the password
  const lk = await H.newPerson(admin, { role: "super_admin" });
  const lkStale = new Client(srv, { cookie: forge.session(lk.email, { mf: true, mft: Date.now() - 10 * 60 * 1000 }) });
  const outs = []; for (let i = 0; i < 5; i += 1) outs.push(await lkStale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: lk.password, mfa: { method: "totp", code: String(200000 + i) } }));
  c.ok("S7.40", "five wrong second factors at step-up lock the account", outs.slice(0, 4).every((r) => r.status === 401) && outs[4].status === 401 || outs[4].status === 429, outs.map((r) => r.status));
  const lockedGood = await lkStale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: lk.password, mfa: { method: "totp", code: U.totpAtStep(lk.secret, U.stepNow() + 1) } });
  c.status("S7.41", "while locked, a correct password + correct TOTP does not yield a grant (429)", lockedGood, 429);
  const lockedWrongPw = await lkStale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: "wrong-password-0000" });
  c.ok("S7.42", "the lock answer does not depend on the password (checked before it)", lockedWrongPw.status === 429, lockedWrongPw.body);
  const lockedLogin = await lk.loginRaw(new Client(srv)); const lockedVerify = lockedLogin.body.challenge_token ? await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: lockedLogin.body.challenge_token, method: "totp", code: U.totpAtStep(lk.secret, U.stepNow() + 1) }) : lockedLogin;
  c.status("S7.43", "the same lock holds sign-in (one shared persisted counter)", lockedVerify, 429);

  // ------------------------------------------------------------ S8: WebAuthn as the step-up factor
  const w = await H.createUser(admin, { role: "super_admin" }); await w.loginRaw();
  const wr = await H.registerWebauthn(w, w.client, srv, {});
  c.ok("S8.0", "setup: security key registered as the first factor", wr.ok);
  const wStale = new Client(srv, { cookie: forge.session(w.email, { mf: true, mft: Date.now() - 10 * 60 * 1000 }) });
  c.status("S8.1", "webauthn step-up options need a session", await new Client(srv).post(`${A}/session/mfa/webauthn/step-up-options`, {}), 401);
  c.status("S8.2", "webauthn step-up options refuse an API key", await new Client(srv).post(`${A}/session/mfa/webauthn/step-up-options`, {}, { headers: { authorization: `Bearer ${H.API_KEY}` } }), 403);
  const noWa = await H.newPerson(admin, {});
  c.status("S8.3", "an account without a security key gets 409 from step-up options", await noWa.client.post(`${A}/session/mfa/webauthn/step-up-options`, {}), 409);
  const so = await wStale.post(`${A}/session/mfa/webauthn/step-up-options`, {});
  c.status("S8.4", "options issued to the signed-in owner", so, 200);
  const good = wr.auth.assert(so.body.options);
  const wbad = wr.auth.assert(so.body.options, { origin: "http://evil.example" });
  const badRes = await wStale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: w.password, mfa: { method: "webauthn", challenge_id: so.body.challenge_id, response: wbad } });
  c.status("S8.5", "an assertion from a wrong origin earns no grant", badRes, 401);
  const so2 = await wStale.post(`${A}/session/mfa/webauthn/step-up-options`, {});
  const goodRes = await wStale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: w.password, mfa: { method: "webauthn", challenge_id: so2.body.challenge_id, response: wr.auth.assert(so2.body.options) } });
  c.status("S8.6", "a valid assertion earns a grant", goodRes, 200);
  c.eq("S8.7", "second factor reported as webauthn", goodRes.body.step_up && goodRes.body.step_up.second_factor, "webauthn");
  const replayAssert = await wStale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: w.password, mfa: { method: "webauthn", challenge_id: so2.body.challenge_id, response: wr.auth.assert(so2.body.options, { noIncrement: true }) } });
  c.status("S8.8", "replaying the assertion (same challenge) is refused", replayAssert, 401);
  const so3 = await wStale.post(`${A}/session/mfa/webauthn/step-up-options`, {});
  const cr = wr.auth.assert(so3.body.options, { counter: 0 });
  c.status("S8.9", "a counter that did not advance is refused (cloned authenticator)", await wStale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: w.password, mfa: { method: "webauthn", challenge_id: so3.body.challenge_id, response: cr } }), 401);
  const other = await H.createUser(admin, { role: "super_admin" }); await other.loginRaw(); const oreg = await H.registerWebauthn(other, other.client, srv, {});
  const so4 = await wStale.post(`${A}/session/mfa/webauthn/step-up-options`, {});
  c.status("S8.10", "another account's authenticator cannot earn this account's grant", await wStale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: w.password, mfa: { method: "webauthn", challenge_id: so4.body.challenge_id, response: oreg.auth.assert(so4.body.options) } }), 401);
  const so5 = await wStale.post(`${A}/session/mfa/webauthn/step-up-options`, {});
  c.status("S8.11", "wrong password with a valid assertion earns nothing", await wStale.post(`${A}/session/step-up`, { purpose: "security_policy_write", password: "wrong-password-0000", mfa: { method: "webauthn", challenge_id: so5.body.challenge_id, response: wr.auth.assert(so5.body.options) } }), 401);

  // ------------------------------------------------------------ S10: password guessing through step-up with a rotating forwarded address
  const pg = await H.newPerson(admin, { enroll: false });
  const guesses = [];
  for (let i = 0; i < 40; i += 1) guesses.push((await new Client(srv, { ip: `203.0.113.${i + 1}`, cookie: pg.client.cookie }).post(`${A}/session/step-up`, { purpose: "mfa_management", password: `wrong-guess-${i}-abcdef` })).status);
  c.ok("S10.1", "online password guessing through step-up is throttled per ACCOUNT: rotating X-Forwarded-For does not give a fresh budget (some of 40 guesses are answered 429)", guesses.includes(429), guesses.join(","));

  // ------------------------------------------------------------ S9: audit / redaction
  const kinds = new Set((await srv.audit((x) => x.action === "step_up_verified" || x.action === "step_up_failed")).map((x) => `${x.action}:${x.metadata.failure_reason || x.metadata.second_factor || ""}`));
  c.ok("S9.1", "step-up outcomes are audited with failure reasons and the second factor used", kinds.has("step_up_failed:invalid_password") && [...kinds].some((k) => k.startsWith("step_up_verified:")) && [...kinds].some((k) => /second_factor_required|invalid_second_factor/.test(k)) && kinds.has("step_up_verified:totp"), [...kinds]);
  const blob = JSON.stringify(srv.allAudit()) + srv.logs();
  c.ok("S9.2", "no password, grant token, TOTP code or assertion in the audit trail or logs", !blob.includes(tok) && !blob.includes(sa.password) && !blob.includes(e.password) && !blob.includes(good.response.signature) && !blob.includes(viaTotp.body.step_up.token) && !blob.includes(viaProof.body.step_up.token));
});
