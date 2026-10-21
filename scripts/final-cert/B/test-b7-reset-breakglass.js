"use strict";
// AREA B / B7: administrator MFA reset (every refusal and the success effects, self-reset, last recoverable administrator, audit, notification, re-enrolment)
// and the deployment-owner break-glass (disabled by default, misconfiguration, applied once per identifier across restarts, password preserved, never an HTTP route, health status).
const H = require("./lib/harness");
const { Forge } = require("./lib/forge");
const { A, Client, U } = H;

H.runSuite("b7-reset-breakglass", async (c) => {
  const mail = await H.startMailCapture();
  c.defer(() => mail.close());
  const srv = await H.makeServer({ mail });
  c.defer(async () => { await srv.stop(); H.rmrf(srv.dir); });
  const forge = new Forge(srv);
  const admin = await H.adminLogin(srv);
  const hdr = (t) => ({ "x-step-up-token": t });
  const waitMail = async (to, pred, ms = 4000) => { const end = Date.now() + ms; for (;;) { const m = mail.to(to).filter(pred); if (m.length || Date.now() > end) return m; await U.sleep(100); } };
  const rows = (p) => (srv.readStore().admin_mfa_credentials || []).filter((x) => x.admin_user_id === p.id);
  const unused = (p) => (srv.readStore().admin_mfa_recovery_codes || []).filter((x) => x.admin_user_id === p.id && !x.used_at).length;
  const userRow = (p) => srv.readStore().admin_users.find((u) => u.id === p.id);
  const body = (t, o = {}) => ({ reason: "lost device, verified by phone", confirm: true, confirm_email: t.email, ...o });
  const reset = (client, t, b, token) => client.post(`${A}/users/${t.id}/mfa/reset`, b === undefined ? body(t) : b, token ? { headers: hdr(token) } : {});

  // actors: two enrolled super administrators; an enrolled ochiga_admin and staff; a super administrator without a factor
  const a1 = await H.newPerson(admin, { role: "super_admin" });
  const a2 = await H.newPerson(admin, { role: "super_admin" });
  const a1s = await a1.signIn(); const actor = a1s.client;       // a1 signed in with TOTP: fresh proof
  const grant = async () => a1.stepUp(actor, "mfa_management");  // fresh TOTP each time (waits for the next step when needed)
  const target = async (opts = {}) => H.newPerson(admin, { role: "ochiga_staff", ...opts });

  // ------------------------------------------------------------ X1: refusals (every category)
  const t0 = await target();
  c.status("X1.1", "no session: 401", await new Client(srv).post(`${A}/users/${t0.id}/mfa/reset`, body(t0)), 401);
  c.status("X1.2", "API key: refused (actor identity required)", await new Client(srv).post(`${A}/users/${t0.id}/mfa/reset`, body(t0), { headers: { authorization: `Bearer ${H.API_KEY}` } }), 403);
  c.status("X1.3", "edge token: refused", await new Client(srv).post(`${A}/users/${t0.id}/mfa/reset`, body(t0), { headers: { authorization: `Bearer ${H.EDGE}` } }), 403);
  c.status("X1.4", "API key together with a stolen grant: refused", await new Client(srv).post(`${A}/users/${t0.id}/mfa/reset`, body(t0), { headers: { authorization: `Bearer ${H.API_KEY}`, ...hdr((await grant()).body.step_up.token) } }), 403);
  const staffActor = await H.newPerson(admin, { role: "ochiga_staff" }); const sc = (await staffActor.signIn()).client;
  c.status("X1.5", "a non-super-administrator (staff) cannot reset another account's factors", await reset(sc, t0, undefined, (await staffActor.stepUp(sc, "mfa_management")).body.step_up.token), 403);
  const oa = await H.newPerson(admin, { role: "ochiga_admin" }); const oac = (await oa.signIn()).client;
  c.status("X1.6", "an ochiga_admin (no team.manage) cannot reset", await reset(oac, t0, undefined, (await oa.stepUp(oac, "mfa_management")).body.step_up.token), 403);
  c.status("X1.7", "no step-up grant: 403 step_up_required", await reset(actor, t0), 403);
  const gWrongPurpose = await a1.stepUp(actor, "session_revocation");
  c.status("X1.8", "a grant of another purpose (session_revocation) is refused", await reset(actor, t0, undefined, gWrongPurpose.body.step_up.token), 403);
  const gPw = forge.grant(a1.email, actor.cookie, { purpose: "mfa_management", mf: false });
  const rNoMf = await reset(actor, t0, undefined, gPw);
  c.ok("X1.9", "a password-only grant is refused (a reset always needs the actor's own fresh second factor)", rNoMf.status === 403 && /mfa_required/.test(JSON.stringify(rNoMf.body)), rNoMf.body);
  c.status("X1.10", "an expired grant is refused", await reset(actor, t0, undefined, forge.grant(a1.email, actor.cookie, { purpose: "mfa_management", mf: true, iat: Date.now() - 700000, exp: Date.now() - 1000 })), 403);
  c.status("X1.11", "a grant of another administrator is refused", await reset(actor, t0, undefined, (await a2.stepUp((await a2.signIn()).client, "mfa_management")).body.step_up.token), 403);
  const unenrolledAdmin = await H.newPerson(admin, { role: "super_admin", enroll: false });
  const ug = await unenrolledAdmin.stepUp(unenrolledAdmin.client, "mfa_management", { mfa: null });
  const rUnenrolled = await reset(unenrolledAdmin.client, t0, undefined, ug.body.step_up.token);
  c.ok("X1.12", "a super administrator without a factor cannot reset anyone's factors (no second-factor proof)", rUnenrolled.status === 403 && /mfa_required|second_factor/.test(JSON.stringify(rUnenrolled.body)), rUnenrolled.body);
  const g = await grant(); const tk = g.body.step_up.token;
  for (const [i, b] of [["no reason", { confirm: true, confirm_email: t0.email }], ["empty reason", body(t0, { reason: "" })], ["2-char reason", body(t0, { reason: "ab" })], ["501-char reason", body(t0, { reason: "x".repeat(501) })], ["numeric reason", body(t0, { reason: 12345 })], ["blank reason", body(t0, { reason: "    " })], ["control-char-only reason", body(t0, { reason: "\u0001\u0002\u0003\u0004" })]].entries()) {
    const r = await reset(actor, t0, b[1], tk);
    c.status(`X1.20.${i}`, `${b[0]}: refused (400 reason_required)`, r, 400);
  }
  for (const [i, b] of [["no confirm", { reason: "valid reason", confirm_email: t0.email }], ["confirm false", body(t0, { confirm: false })], ["confirm string true", body(t0, { confirm: "true" })], ["confirm 1", body(t0, { confirm: 1 })]].entries()) c.status(`X1.21.${i}`, `${b[0]}: refused (400)`, await reset(actor, t0, b[1], tk), 400);
  for (const [i, b] of [["no confirm_email", body(t0, { confirm_email: undefined })], ["other e-mail", body(t0, { confirm_email: a2.email })], ["empty e-mail", body(t0, { confirm_email: "" })], ["partial e-mail", body(t0, { confirm_email: t0.email.slice(0, 8) })]].entries()) c.status(`X1.22.${i}`, `${b[0]}: refused (400 confirmation_mismatch)`, await reset(actor, t0, b[1], tk), 400);
  c.status("X1.23", "invalid JSON body: refused", await actor.raw("POST", `${A}/users/${t0.id}/mfa/reset`, { rawBody: "{{{", headers: hdr(tk) }), 400);
  c.status("X1.24", "self target: refused (use self service)", await reset(actor, a1, body(a1), tk), 400);
  c.status("X1.25", "unknown target: 404", await actor.post(`${A}/users/00000000-0000-4000-8000-000000000000/mfa/reset`, body(t0), { headers: hdr(tk) }), 404);
  for (const [i, id] of ["..%2F..%2Fadmin", "%00", "x".repeat(300), "1 OR 1=1"].entries()) { const r = await actor.post(`${A}/users/${id}/mfa/reset`, body(t0), { headers: hdr(tk) }); c.ok(`X1.26.${i}`, `odd target id #${i} does not reset anything and is not a server error`, [400, 404].includes(r.status), r.status); }
  const dead = await target(); await admin.client.patch(`${A}/users/${dead.id}`, { status: "inactive" });
  c.status("X1.27", "inactive target: refused (409 target_inactive)", await reset(actor, dead, body(dead), tk), 409);
  c.eq("X1.28", "none of the refusals changed the target's factor", [rows(t0).filter((x) => x.status === "active").length, unused(t0)], [1, 10]);
  c.ok("X1.29", "refusals are audited with a category", (await srv.audit((e) => e.action === "mfa_reset_denied")).length >= 10, (await srv.audit((e) => e.action === "mfa_reset_denied")).length);

  // ------------------------------------------------------------ X2: super administrators: recoverability is never lost through the API
  const iso = await H.makeServer({ mail });
  c.defer(async () => { await iso.stop(); H.rmrf(iso.dir); });
  const isoRoot = await H.adminLogin(iso);                       // bootstrap super administrator, never enrolled
  const isoA = await H.newPerson(isoRoot, { role: "super_admin" });
  const isoB = await H.newPerson(isoRoot, { role: "super_admin" });
  const isoRows = (p) => (iso.readStore().admin_mfa_credentials || []).filter((x) => x.admin_user_id === p.id && x.status === "active").length;
  const isoAc = (await isoA.signIn()).client; const isoBc = (await isoB.signIn()).client;
  const rootGrant = await isoRoot.stepUp(isoRoot.client, "mfa_management", { mfa: null });
  const rootTry = await isoRoot.client.post(`${A}/users/${isoA.id}/mfa/reset`, { reason: "attempt by an unenrolled administrator", confirm: true, confirm_email: isoA.email }, { headers: hdr(rootGrant.body.step_up.token) });
  c.status("X2.1", "an unenrolled super administrator cannot reset an enrolled one (no second factor)", rootTry, 403);
  c.eq("X2.2", "...and the target keeps its factor", isoRows(isoA), 1);
  const rB = await isoAc.post(`${A}/users/${isoB.id}/mfa/reset`, { reason: "peer lost device", confirm: true, confirm_email: isoB.email }, { headers: hdr((await isoA.stepUp(isoAc, "mfa_management")).body.step_up.token) });
  c.status("X2.3", "an enrolled super administrator may reset another super administrator while it remains able to recover", rB, 200);
  c.eq("X2.4", "the peer's factor is gone", isoRows(isoB), 0);
  const bGrant = await isoB.stepUp(isoBc, "mfa_management", { mfa: null });
  const bTry = await isoBc.post(`${A}/users/${isoA.id}/mfa/reset`, { reason: "peer without factor tries to reset", confirm: true, confirm_email: isoA.email }, { headers: hdr((bGrant.body && bGrant.body.step_up && bGrant.body.step_up.token) || "none") });
  c.ok("X2.5", "the reset peer (no factor, old session dead) cannot in turn reset the only remaining enrolled super administrator", [401, 403].includes(bTry.status), bTry.body);
  c.eq("X2.6", "the only enrolled super administrator keeps its factor (nobody can strip the last recoverable administrator through the API)", isoRows(isoA), 1);
  const rSelf = await isoAc.post(`${A}/users/${isoA.id}/mfa/reset`, { reason: "self reset attempt", confirm: true, confirm_email: isoA.email }, { headers: hdr((await isoA.stepUp(isoAc, "mfa_management")).body.step_up.token) });
  c.status("X2.7", "self reset is refused even for the last recoverable administrator", rSelf, 400);
  c.eq("X2.8", "...and nothing changed", isoRows(isoA), 1);
  const staffReset = await H.newPerson(isoRoot, { role: "ochiga_staff" }); const sRc = (await staffReset.signIn()).client;
  const sTry = await sRc.post(`${A}/users/${isoA.id}/mfa/reset`, { reason: "staff tries to reset the administrator", confirm: true, confirm_email: isoA.email }, { headers: hdr((await staffReset.stepUp(sRc, "mfa_management")).body.step_up.token) });
  c.status("X2.9", "a non-super-administrator cannot reset the last recoverable administrator", sTry, 403);
  c.eq("X2.10", "...and it keeps its factor", isoRows(isoA), 1);

  // ------------------------------------------------------------ X3: success effects
  const T = await H.newPerson(admin, { role: "ochiga_staff" });
  const tSess1 = (await T.signIn()).client; const tSess2 = (await T.signIn()).client;
  const tWa = await H.registerWebauthn(T, tSess1, srv, {});
  c.ok("X3.0", "setup: target has TOTP + a security key + sessions", tWa.ok);
  const staleChal = (await T.loginRaw(new Client(srv))).body.challenge_token;
  // lock the target first: failures must be cleared by the reset
  for (let i = 0; i < 2; i += 1) await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: staleChal, method: "totp", code: "12345" + i });
  const before = userRow(T);
  c.ok("X3.0b", "setup: target has failure counters set", before.mfa_failed_attempts === 2, before.mfa_failed_attempts);
  const gOk = await grant();
  const ok = await reset(actor, T, body(T), gOk.body.step_up.token);
  c.status("X3.1", "positive control: reset succeeds", ok, 200);
  c.ok("X3.2", "answer reports revoked credentials (2), deleted recovery codes, new generation, re-enrolment required", ok.body.credentials_revoked === 2 && ok.body.recovery_codes_deleted >= 0 && ok.body.re_enrollment_required === true && Number.isInteger(ok.body.session_generation), ok.body);
  c.eq("X3.3", "no active credential remains", rows(T).filter((x) => x.status === "active" || x.status === "pending").length, 0);
  c.eq("X3.4", "unused recovery codes are deleted", unused(T), 0);
  c.status("X3.5", "target session 1 is dead", await tSess1.get(`${A}/session/me`), 401);
  c.status("X3.6", "target session 2 is dead", await tSess2.get(`${A}/session/me`), 401);
  c.status("X3.7", "the actor's own session is unaffected", await actor.get(`${A}/session/me`), 200);
  const staleVerify = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: staleChal, method: "totp", code: U.totpAtStep(T.secret, U.stepNow() + 1) });
  c.status("X3.8", "a challenge issued before the reset is dead", staleVerify, 401);
  c.eq("X3.9", "failure counters were cleared", [userRow(T).mfa_failed_attempts, userRow(T).mfa_locked_until], [0, null]);
  c.ok("X3.10", "a per-account requirement (mfa_required_after) is set to now", userRow(T).mfa_required_after && Math.abs(Date.parse(userRow(T).mfa_required_after) - Date.now()) < 120000, userRow(T).mfa_required_after);
  const lg = await T.loginRaw(new Client(srv));
  c.ok("X3.11", "the target's PASSWORD still works (preserved) but yields an enrolment challenge, not a session", lg.status === 200 && lg.body.mfa_enrollment_required === true && !!lg.body.challenge_token && lg.setCookie.length === 0, lg.body);
  const wrongPwLogin = await T.loginRaw(new Client(srv), "wrong-password-1234");
  c.status("X3.12", "a wrong password still gets the ordinary 401 (no enrolment hint without the password)", wrongPwLogin, 401);
  const asLogin = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: lg.body.challenge_token, method: "totp", code: "000000" });
  c.status("X3.13", "the enrolment challenge cannot be used to sign in (purpose isolation)", asLogin, 401);
  const asCookie = await new Client(srv).get(`${A}/session/me`, { cookie: lg.body.challenge_token });
  c.status("X3.14", "the enrolment challenge is not a session", asCookie, 401);
  c.ok("X3.15", "reset is audited with actor, target, reason and request id (no secrets)", (await srv.audit((e) => e.action === "mfa_reset_by_admin" && e.target_id === T.id && e.metadata.reason && e.metadata.request_id && e.metadata.target_email === T.email)).length === 1);
  const note = await waitMail(T.email, (m) => /reset|removed|turned off|changed/i.test((m.subject || "") + (m.text || "")));
  c.ok("X3.16", "the target is notified by e-mail", note.length >= 1, mail.to(T.email).map((m) => m.subject));
  c.ok("X3.17", "notification names no secret, code or token", note.every((m) => !(m.text + m.html).includes(T.secret) && !T.recovery.some((r) => (m.text + m.html).includes(r)) && !/eyJ/.test(m.text + m.html)));
  c.ok("X3.18", "notification delivery status is recorded truthfully", (await srv.audit((e) => e.action === "mfa_notification" && e.target_id === T.id && e.metadata.event === "reset_by_admin" && e.metadata.delivery === "sent")).length === 1);
  // re-enrolment through the mailbox gate, then a normal MFA sign-in
  const anon = new Client(srv);
  await anon.post(`${A}/session/mfa/enroll/email-code`, { challenge_token: lg.body.challenge_token });
  const codeMail = await waitMail(T.email, (m) => /\b\d{8}\b/.test((m.text || "") + (m.html || "")));
  const mcode = (((codeMail[codeMail.length - 1] || {}).text || "").match(/\b(\d{8})\b/) || [])[1];
  c.ok("X3.20", "the mailbox code reaches the target's address", !!mcode && codeMail.every((m) => String(m.to).toLowerCase() === T.email.toLowerCase()), codeMail.map((m) => m.to));
  const ev = await anon.post(`${A}/session/mfa/enroll/email-verify`, { challenge_token: lg.body.challenge_token, email_code: mcode });
  c.status("X3.21", "mailbox code accepted", ev, 200);
  const fb = await anon.post(`${A}/session/mfa/enroll/forced/begin`, { enrollment_token: ev.body.enrollment_token });
  const tf = await U.nextTotp(fb.body.secret_base32, 0);
  const fc = await anon.post(`${A}/session/mfa/enroll/forced/confirm`, { enrollment_token: ev.body.enrollment_token, credential_id: fb.body.credential_id, code: tf.code });
  c.status("X3.22", "forced re-enrolment completes", fc, 200);
  T.secret = fb.body.secret_base32; T.lastStep = tf.step; T.recovery = fc.body.recovery_codes || [];
  c.eq("X3.23", "the per-account requirement is cleared by enrolment", userRow(T).mfa_required_after || null, null);
  const again = await T.signIn();
  c.status("X3.24", "after re-enrolment the account signs in with its new factor", again.res, 200);
  const oldSecretCode = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: (await T.loginRaw(new Client(srv))).body.challenge_token, method: "totp", code: "000000" });
  c.status("X3.25", "(control) wrong codes are still refused after re-enrolment", oldSecretCode, 401);

  // reset of an account that is currently locked / concurrent resets
  const L = await H.newPerson(admin, { role: "ochiga_staff" });
  const lchal = async () => (await L.loginRaw(new Client(srv))).body.challenge_token;
  for (let i = 0; i < 5; i += 1) await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: await lchal(), method: "totp", code: "99999" + i });
  c.ok("X3.30", "setup: target is locked", Date.parse(userRow(L).mfa_locked_until) > Date.now());
  const gl = await grant();
  const rl = await reset(actor, L, body(L), gl.body.step_up.token);
  c.status("X3.31", "a locked account can be reset", rl, 200);
  c.eq("X3.32", "and the lock is gone", userRow(L).mfa_locked_until || null, null);
  const P = await H.newPerson(admin, { role: "ochiga_staff" });
  const gp = await grant();
  const par = await Promise.all([reset(actor.clone(), P, body(P), gp.body.step_up.token), reset(actor.clone(), P, body(P), gp.body.step_up.token), reset(actor.clone(), P, body(P), gp.body.step_up.token)]);
  c.ok("X3.33", "concurrent resets of one target never produce a server error and leave a consistent state", par.every((r) => [200, 404, 409].includes(r.status)) && rows(P).filter((x) => x.status === "active").length === 0 && unused(P) === 0, par.map((r) => r.status));
  c.status("X3.34", "resetting an account that has no factor is not an error", await reset(actor, P, body(P), (await grant()).body.step_up.token), 200);
  const logs = srv.logs() + JSON.stringify(srv.allAudit());
  c.ok("X3.35", "no secret, recovery code or token appears in logs or audit after the reset flows", !logs.includes(T.secret) && !logs.includes(mcode) && !logs.includes(ev.body.enrollment_token) && !(fc.body.recovery_codes || []).some((r) => logs.includes(r)));

  // ------------------------------------------------------------ X4: break-glass
  const bgA = await H.newPerson(admin, { role: "ochiga_staff" });           // target of break-glass
  const bgB = await H.newPerson(admin, { role: "ochiga_staff" });           // bystander (must stay enrolled)
  const bgSess = (await bgA.signIn()).client;
  const healthz = async () => (await fetch(srv.base + "/healthz")).json();
  const hz0 = await healthz();
  c.eq("X4.1", "break-glass is disabled by default (health status)", hz0.mfa.recovery.status, "disabled");
  c.ok("X4.2", "health reports no lingering flag and no e-mail / id", hz0.mfa.recovery.lingering === false && !JSON.stringify(hz0).includes(bgA.email));
  const stateOf = (p) => ({ active: rows(p).filter((x) => x.status === "active").length, codes: unused(p), gen: userRow(p).session_generation || 0 });
  const stA0 = stateOf(bgA);

  // e-mail / id configured but the switch is off
  await srv.restart({ LEAD_AGENTS_MFA_RECOVERY_EMAIL: bgA.email, LEAD_AGENTS_MFA_RECOVERY_ID: "ticket-0001" });
  c.eq("X4.3", "with the switch off, e-mail and id alone do nothing", [stateOf(bgA), (await healthz()).mfa.recovery.status], [stA0, "disabled"]);
  // misconfigurations
  const miscs = [["no e-mail", { LEAD_AGENTS_MFA_RECOVERY: "true", LEAD_AGENTS_MFA_RECOVERY_EMAIL: "", LEAD_AGENTS_MFA_RECOVERY_ID: "ticket-0002" }], ["no id", { LEAD_AGENTS_MFA_RECOVERY: "true", LEAD_AGENTS_MFA_RECOVERY_EMAIL: bgA.email, LEAD_AGENTS_MFA_RECOVERY_ID: "" }], ["too-short id", { LEAD_AGENTS_MFA_RECOVERY: "true", LEAD_AGENTS_MFA_RECOVERY_EMAIL: bgA.email, LEAD_AGENTS_MFA_RECOVERY_ID: "ab" }], ["id with spaces", { LEAD_AGENTS_MFA_RECOVERY: "true", LEAD_AGENTS_MFA_RECOVERY_EMAIL: bgA.email, LEAD_AGENTS_MFA_RECOVERY_ID: "bad id here" }], ["e-mail without @", { LEAD_AGENTS_MFA_RECOVERY: "true", LEAD_AGENTS_MFA_RECOVERY_EMAIL: "not-an-address", LEAD_AGENTS_MFA_RECOVERY_ID: "ticket-0003" }], ["switch not exactly true", { LEAD_AGENTS_MFA_RECOVERY: "yes", LEAD_AGENTS_MFA_RECOVERY_EMAIL: bgA.email, LEAD_AGENTS_MFA_RECOVERY_ID: "ticket-0004" }], ["switch TRUE (upper case)", { LEAD_AGENTS_MFA_RECOVERY: "TRUE", LEAD_AGENTS_MFA_RECOVERY_EMAIL: bgA.email, LEAD_AGENTS_MFA_RECOVERY_ID: "ticket-0005" }]];
  for (const [i, [label, env]] of miscs.entries()) {
    await srv.restart(env);
    const hz = await healthz();
    c.ok(`X4.4.${i}`, `misconfiguration (${label}) applies nothing and is visible in health`, JSON.stringify(stateOf(bgA)) === JSON.stringify(stA0) && ["misconfigured", "disabled"].includes(hz.mfa.recovery.status), { state: stateOf(bgA), status: hz.mfa.recovery });
  }
  // MFA off + switch on = inactive, nothing
  await srv.restart({ LEAD_AGENTS_MFA: "off", LEAD_AGENTS_MFA_RECOVERY: "true", LEAD_AGENTS_MFA_RECOVERY_EMAIL: bgA.email, LEAD_AGENTS_MFA_RECOVERY_ID: "ticket-0006" });
  c.ok("X4.5", "with MFA off the break-glass does nothing (inactive)", JSON.stringify(stateOf(bgA)) === JSON.stringify(stA0) && (await healthz()).mfa.recovery.status === "inactive", (await healthz()).mfa.recovery);
  // unknown / inactive account
  await srv.restart({ LEAD_AGENTS_MFA: "on", LEAD_AGENTS_MFA_RECOVERY: "true", LEAD_AGENTS_MFA_RECOVERY_EMAIL: "nobody@fixture.test", LEAD_AGENTS_MFA_RECOVERY_ID: "ticket-0007" });
  c.eq("X4.6", "an unknown address applies nothing (no_account)", [(await healthz()).mfa.recovery.status, JSON.stringify(stateOf(bgA)) === JSON.stringify(stA0)], ["no_account", true]);
  await srv.restart({ LEAD_AGENTS_MFA_RECOVERY_EMAIL: dead.email, LEAD_AGENTS_MFA_RECOVERY_ID: "ticket-0008" });
  c.eq("X4.7", "an inactive account is not recovered (no_account)", (await healthz()).mfa.recovery.status, "no_account");
  // the real thing: normalisation of the address
  await srv.restart({ LEAD_AGENTS_MFA_RECOVERY: "true", LEAD_AGENTS_MFA_RECOVERY_EMAIL: `  ${bgA.email.toUpperCase()}  `, LEAD_AGENTS_MFA_RECOVERY_ID: "ticket-1001" });
  const hz1 = await healthz();
  c.eq("X4.8", "valid configuration applies at process start", hz1.mfa.recovery.status, "applied");
  c.ok("X4.9", "health flags the lingering switch", hz1.mfa.recovery.lingering === true && hz1.mfa.recovery.enabled === true, hz1.mfa.recovery);
  c.ok("X4.10", "health reveals neither the address nor the id", !JSON.stringify(hz1).includes(bgA.email) && !JSON.stringify(hz1).includes("ticket-1001"));
  c.eq("X4.11", "target's factors and recovery codes are cleared", [rows(bgA).filter((x) => x.status === "active" || x.status === "pending").length, unused(bgA)], [0, 0]);
  c.ok("X4.12", "target's session generation was bumped (old sessions dead)", (userRow(bgA).session_generation || 0) > stA0.gen);
  c.status("X4.13", "target's pre-existing session is dead", await bgSess.get(`${A}/session/me`), 401);
  const bgLogin = await bgA.loginRaw(new Client(srv));
  c.ok("X4.14", "target's PASSWORD is preserved (login works) and routes the person into re-enrolment", bgLogin.status === 200 && bgLogin.body.mfa_enrollment_required === true, bgLogin.body);
  c.ok("X4.15", "bystander's factor is untouched", stateOf(bgB).active === 1 && stateOf(bgB).codes === 10);
  c.status("X4.16", "bystander still signs in with its factor", (await bgB.signIn()).res, 200);
  c.ok("X4.17", "the application is audited with the id and address, never a secret", (await srv.audit((e) => e.action === "mfa_recovery_applied" && e.metadata.recovery_id === "ticket-1001")).length === 1);
  c.ok("X4.18", "a warning is logged without secrets", /mfa_recovery_status/.test(srv.logs()) && !srv.logs().includes(bgA.password));
  // once per id: re-enrol, restart with the SAME flags -> must not wipe again
  const reA = await bgA.client.post(`${A}/session/login`, { email: bgA.email, password: bgA.password });
  const anon2 = new Client(srv);
  await anon2.post(`${A}/session/mfa/enroll/email-code`, { challenge_token: reA.body.challenge_token });
  const cm = await waitMail(bgA.email, (m) => /\b\d{8}\b/.test((m.text || "") + (m.html || "")));
  const code8 = (((cm[cm.length - 1] || {}).text || "").match(/\b(\d{8})\b/) || [])[1];
  const ev2 = await anon2.post(`${A}/session/mfa/enroll/email-verify`, { challenge_token: reA.body.challenge_token, email_code: code8 });
  const fb2 = await anon2.post(`${A}/session/mfa/enroll/forced/begin`, { enrollment_token: ev2.body.enrollment_token });
  const t8 = await U.nextTotp(fb2.body.secret_base32, 0);
  const fc2 = await anon2.post(`${A}/session/mfa/enroll/forced/confirm`, { enrollment_token: ev2.body.enrollment_token, credential_id: fb2.body.credential_id, code: t8.code });
  c.status("X4.19", "setup: the recovered account re-enrols", fc2, 200);
  bgA.secret = fb2.body.secret_base32; bgA.lastStep = t8.step; bgA.recovery = fc2.body.recovery_codes;
  const stAfterEnrol = stateOf(bgA);
  await srv.restart({});   // identical environment (the switch is still set)
  c.eq("X4.20", "restarting with the same switch, address and id does NOT apply again", [(await healthz()).mfa.recovery.status, JSON.stringify(stateOf(bgA)) === JSON.stringify(stAfterEnrol)], ["already_applied", true]);
  c.ok("X4.21", "...and the recovered account can still sign in with its new factor", (await bgA.signIn()).res.status === 200);
  await srv.restart({});
  c.eq("X4.22", "a second restart is also a no-op", (await healthz()).mfa.recovery.status, "already_applied");
  c.ok("X4.23", "health keeps flagging the lingering switch", (await healthz()).mfa.recovery.lingering === true);
  // a NEW id applies again; an old id never applies again even after a newer one
  await srv.restart({ LEAD_AGENTS_MFA_RECOVERY_ID: "ticket-1002" });
  c.eq("X4.24", "a new identifier applies again", [(await healthz()).mfa.recovery.status, rows(bgA).filter((x) => x.status === "active").length], ["applied", 0]);
  const reB = await bgA.loginRaw(new Client(srv));
  c.ok("X4.25", "...with the password preserved again", reB.body.mfa_enrollment_required === true, reB.body);
  await srv.restart({ LEAD_AGENTS_MFA_RECOVERY_ID: "ticket-1001" });
  c.eq("X4.26", "an earlier identifier never applies again", (await healthz()).mfa.recovery.status, "already_applied");
  await srv.restart({ LEAD_AGENTS_MFA_RECOVERY: undefined, LEAD_AGENTS_MFA_RECOVERY_EMAIL: undefined, LEAD_AGENTS_MFA_RECOVERY_ID: undefined });
  c.eq("X4.27", "removing the switch returns health to disabled", (await healthz()).mfa.recovery.status, "disabled");
  // never an HTTP route
  const probes = ["/api/lead-agents/admin/mfa/recovery", "/api/lead-agents/admin/session/mfa/recovery", "/api/lead-agents/admin/mfa/break-glass", "/api/lead-agents/admin/session/mfa/break-glass", "/api/lead-agents/admin/mfa/reset", "/api/lead-agents/admin/session/mfa/reset", "/healthz?mfa_recovery=true", "/admin/mfa/recovery"];
  const beforeProbes = JSON.stringify([stateOf(bgA), stateOf(bgB)]);
  const probeRes = [];
  for (const pth of probes) for (const m of ["GET", "POST", "PUT"]) {
    const r = await new Client(srv).req(m, pth, { body: m === "GET" ? undefined : { email: bgA.email, id: "ticket-9999", confirm: true }, headers: { authorization: `Bearer ${H.API_KEY}`, "x-mfa-recovery": "true" } });
    probeRes.push(`${m} ${pth} ${r.status}`);
  }
  c.ok("X4.28", "no HTTP route triggers a break-glass (probed with an API key too): nothing changed", JSON.stringify([stateOf(bgA), stateOf(bgB)]) === beforeProbes, probeRes);
  c.ok("X4.29", "probe answers are 4xx (or the plain health answer), never a success that did something", probeRes.every((s) => /\s(400|401|403|404|405|200|503)$/.test(s)), probeRes);
});
