"use strict";
// AREA B / B8: MFA enforcement policy (governed setting office_mfa_enforcement): write governance, preflight refusals, step-up requirement, version conflicts, unchanged value,
// modes (off / optional / privileged / all), privileged detection, grace before and after the deadline (store timestamps moved while the server is stopped),
// existing sessions, enrolled accounts never downgraded, fail-closed on an unreadable stored value, legacy API-key login with MFA on.
const fs = require("fs");
const H = require("./lib/harness");
const { Forge, decodePayload } = require("./lib/forge");
const { A, Client, U } = H;

const DAY = 24 * 3600 * 1000;

H.runSuite("b8-enforcement", async (c) => {
  const mail = await H.startMailCapture();
  c.defer(() => mail.close());
  const srv = await H.makeServer({ mail, extra: { LEAD_AGENTS_MFA_FLEET_ATTESTED: undefined, OFFICE_EMAIL_PROVIDER: "", RESEND_API_KEY: "" } });
  c.defer(async () => { await srv.stop(); H.rmrf(srv.dir); });
  const forge = new Forge(srv);
  const hdr = (t) => ({ "x-step-up-token": t });
  const KEY = "office_mfa_enforcement";
  const SET = `${A}/settings/${KEY}`;
  const row = (p) => srv.readStore().admin_users.find((u) => u.id === p.id);
  const stored = () => (srv.readStore().runtime_settings || {})[KEY];
  const healthz = async () => (await fetch(srv.base + "/healthz")).json();
  async function editStore(fn) { await srv.stop(); const st = srv.readStore(); fn(st); fs.writeFileSync(srv.storeFile(), JSON.stringify(st)); await srv.start(); }
  const waitMail = async (to, pred, ms = 4000) => { const end = Date.now() + ms; for (;;) { const m = mail.to(to).filter(pred); if (m.length || Date.now() > end) return m; await U.sleep(100); } };

  const root = await H.adminLogin(srv);
  const re = await root.enrollTotp(root.client);
  c.ok("N0.1", "setup: the bootstrap super administrator enrols", re.ok);
  // a client that holds a FRESH second-factor proof (real sign-in once, then re-minted proofs signed with the test's own session secret so TOTP steps are not exhausted)
  const rootSignIn = await root.signIn();
  c.status("N0.2", "setup: real sign-in with TOTP", rootSignIn.res, 200);
  const freshRoot = () => new Client(srv, { cookie: forge.session(root.email, { mf: true, mft: Date.now() }) });
  async function grantFor(client, purpose = "security_policy_write") { const g = await client.post(`${A}/session/step-up`, { purpose, password: root.password }); return g; }
  async function put(value, { version, confirm = true, extra = {}, client, token, purpose } = {}) {
    const cl = client || freshRoot();
    const g = token ? null : await grantFor(cl, purpose);
    const v = version === undefined ? (stored() ? stored().version : 0) : version;
    return cl.put(SET, { value, expected_version: v, ...(confirm === undefined ? {} : { confirm }), ...extra }, { headers: hdr(token || g.body.step_up.token) });
  }

  // ------------------------------------------------------------ N1: read and write governance
  const get0 = await freshRoot().get(SET);
  c.ok("N1.1", "the setting reads as off, version 0, for a super administrator", get0.status === 200 && get0.body.setting && get0.body.setting.value === "off" && get0.body.setting.version === 0, get0.body);
  const lowUser = await H.createUser(root, { role: "ochiga_staff" }); await lowUser.loginRaw();
  c.status("N1.2", "an account without staff.manage cannot read the setting", await lowUser.client.get(SET), 403);
  c.status("N1.3", "an API key cannot write the setting (no accountable person)", await new Client(srv).put(SET, { value: "optional", expected_version: 0, confirm: true }, { headers: { authorization: `Bearer ${H.API_KEY}` } }), 403);
  c.status("N1.4", "an edge token cannot write the setting", await new Client(srv).put(SET, { value: "optional", expected_version: 0, confirm: true }, { headers: { authorization: `Bearer ${H.EDGE}` } }), [401, 403]);
  c.status("N1.5", "no session: 401", await new Client(srv).put(SET, { value: "optional", expected_version: 0, confirm: true }), 401);
  c.status("N1.6", "a staff account cannot write", await lowUser.client.put(SET, { value: "optional", expected_version: 0, confirm: true }), 403);
  const oa = await H.createUser(root, { role: "ochiga_admin" }); await oa.loginRaw();
  c.status("N1.7", "an ochiga_admin (no team.manage) cannot write", await oa.client.put(SET, { value: "optional", expected_version: 0, confirm: true }), 403);
  const noGrant = await freshRoot().put(SET, { value: "optional", expected_version: 0, confirm: true });
  c.ok("N1.8", "no step-up grant: 403 step_up_required", noGrant.status === 403 && noGrant.body.error === "step_up_required", noGrant.body);
  const wrongPurposeToken = (await freshRoot().post(`${A}/session/step-up`, { purpose: "mfa_management", password: root.password })).body.step_up.token;
  c.status("N1.9", "a grant of another purpose is refused", await put("optional", { token: wrongPurposeToken, version: 0 }), 403);
  const pwOnly = forge.grant(root.email, rootSignIn.client.cookie, { purpose: "security_policy_write", mf: false });
  const pwOnlyRes = await rootSignIn.client.put(SET, { value: "optional", expected_version: 0, confirm: true }, { headers: hdr(pwOnly) });
  c.ok("N1.10", "an enrolled actor's password-only grant is refused (mfa_required)", pwOnlyRes.status === 403 && /mfa_required/.test(JSON.stringify(pwOnlyRes.body)), pwOnlyRes.body);
  const baseVersion = 0;
  const reqs = [["value missing", { expected_version: 0, confirm: true }, 400], ["expected_version missing", { value: "optional", confirm: true }, 400], ["expected_version string", { value: "optional", expected_version: "0", confirm: true }, 400], ["expected_version negative", { value: "optional", expected_version: -1, confirm: true }, 400], ["confirm missing", { value: "optional", expected_version: 0 }, 400], ["confirm false", { value: "optional", expected_version: 0, confirm: false }, 400], ["confirm string", { value: "optional", expected_version: 0, confirm: "true" }, 400]];
  for (const [i, [label, b, want]] of reqs.entries()) {
    const cl = freshRoot(); const g = await grantFor(cl);
    c.status(`N1.11.${i}`, `${label}: refused (${want})`, await cl.put(SET, b, { headers: hdr(g.body.step_up.token) }), want);
  }
  for (const [i, v] of ["ALL", "everyone", "", 3, null, true, ["all"], { level: "all" }, "all ", "Off"].entries()) {
    const cl = freshRoot(); const g = await grantFor(cl);
    c.status(`N1.12.${i}`, `value ${JSON.stringify(v)} is not an allowed level: refused (400)`, await cl.put(SET, { value: v, expected_version: 0, confirm: true }, { headers: hdr(g.body.step_up.token) }), 400);
  }
  c.status("N1.13", "writing the current value (off, never saved) is refused as unchanged (409) - a re-save cannot restart grace", await put("off", { version: 0 }), 409);
  c.ok("N1.14", "refused writes stored nothing", stored() === undefined || stored() === null, stored());
  c.status("N1.15", "unknown setting keys are not writable through this path (404)", await freshRoot().put(`${A}/settings/office_mfa_enforcement_x`, { value: "all", expected_version: 0, confirm: true }, { headers: hdr(wrongPurposeToken) }), [403, 404]);

  // ------------------------------------------------------------ N2: preflight (raising to a strict level)
  const sa2 = await H.createUser(root, { role: "super_admin" }); await sa2.loginRaw();
  const pre0 = await freshRoot().get(`${A}/session/mfa/enforcement/preflight?level=privileged`);
  c.status("N2.1", "preflight is readable by a super administrator", pre0, 200);
  const failed0 = (pre0.body.failed || []).slice().sort();
  c.eq("N2.2", "with no second enrolled administrator, no mail provider and no fleet attestation the strict preflight fails exactly those checks", failed0, ["fleet_attested", "mailbox_delivery", "recovery_path"], { checks: pre0.body.checks });
  c.ok("N2.3", "the actor-related checks pass (enrolled, recovery codes) and the API-key fallback is off", ["actor_enrolled", "actor_recovery_codes", "api_key_fallback_off", "mfa_machinery", "schema_ready"].every((id) => (pre0.body.checks || []).find((x) => x.id === id && x.ok)), pre0.body.checks);
  c.ok("N2.4", "counts are informational and carry no factor details", pre0.body.counts && !/credential|secret|hash/i.test(JSON.stringify(pre0.body.counts)), pre0.body.counts);
  c.status("N2.5", "preflight needs a human session (API key refused)", await new Client(srv).get(`${A}/session/mfa/enforcement/preflight?level=all`, { headers: { authorization: `Bearer ${H.API_KEY}` } }), 403);
  c.status("N2.6", "preflight without a session: 401", await new Client(srv).get(`${A}/session/mfa/enforcement/preflight?level=all`), 401);
  c.status("N2.7", "preflight for a non-privileged account: 403", await lowUser.client.get(`${A}/session/mfa/enforcement/preflight?level=all`), 403);
  c.status("N2.8", "preflight with an invalid level: 400", await freshRoot().get(`${A}/session/mfa/enforcement/preflight?level=everything`), 400);
  c.status("N2.9", "preflight with no level defaults to the current one", await freshRoot().get(`${A}/session/mfa/enforcement/preflight`), 200);
  const lightPre = await freshRoot().get(`${A}/session/mfa/enforcement/preflight?level=optional`);
  c.ok("N2.10", "raising to 'optional' needs only the machinery checks", lightPre.status === 200 && lightPre.body.ok === true, lightPre.body.failed);
  const refused = await put("privileged", { version: 0 });
  c.status("N2.11", "writing 'privileged' while the preflight fails is refused (412 preflight_failed)", refused, 412);
  c.eq("N2.12", "the refusal names the failed checks", (refused.body.failed_checks || []).slice().sort(), ["fleet_attested", "mailbox_delivery", "recovery_path"]);
  c.ok("N2.13", "nothing was stored by the refused write", !stored(), stored());
  c.ok("N2.14", "the refusal is audited (mfa_enforcement_preflight_failed)", (await srv.audit((e) => e.action === "mfa_enforcement_preflight_failed")).length >= 1);
  c.status("N2.15", "'all' is refused for the same reasons", await put("all", { version: 0 }), 412);
  // each check flips independently
  const sa2e = await sa2.enrollTotp(sa2.client);
  c.ok("N2.16", "setup: a second super administrator enrols", sa2e.ok);
  c.eq("N2.17", "recovery_path is satisfied by another ENROLLED super administrator", ((await freshRoot().get(`${A}/session/mfa/enforcement/preflight?level=privileged`)).body.failed || []).slice().sort(), ["fleet_attested", "mailbox_delivery"]);
  await srv.restart({ LEAD_AGENTS_MFA_FLEET_ATTESTED: "s7.5.6" });
  c.eq("N2.18", "a wrong fleet attestation value does not satisfy fleet_attested", ((await freshRoot().get(`${A}/session/mfa/enforcement/preflight?level=privileged`)).body.failed || []).includes("fleet_attested"), true);
  await srv.restart({ LEAD_AGENTS_MFA_FLEET_ATTESTED: "s7.5.7" });
  c.eq("N2.19", "the correct attestation satisfies fleet_attested", ((await freshRoot().get(`${A}/session/mfa/enforcement/preflight?level=privileged`)).body.failed || []).slice().sort(), ["mailbox_delivery"]);
  await srv.restart({ LEAD_AGENTS_MFA_FLEET_ATTESTED: "s7.5.7", OFFICE_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_fixture_x", OFFICE_EMAIL_FROM: "Fixture <office@fixture.test>", MAIL_CAPTURE_URL: mail.url, NODE_OPTIONS: `--require ${require("path").join(__dirname, "lib", "mail-preload.js")}` });
  c.eq("N2.20", "a configured mail provider satisfies mailbox_delivery: the strict preflight passes", (await freshRoot().get(`${A}/session/mfa/enforcement/preflight?level=privileged`)).body.ok, true);
  await srv.restart({ LEAD_AGENTS_ALLOW_API_KEY_LOGIN: "true" });
  const hzApi = await healthz();
  c.ok("N2.21", "MFA on together with the API-key-as-password login is a configuration error: /healthz is 503 with a problem code", (await fetch(srv.base + "/healthz")).status === 503 && /mfa_enabled_with_api_key_login/.test(JSON.stringify(hzApi)), hzApi.mfa);
  const legacy = await new Client(srv).post(`${A}/session/login`, { email: "api-key-user@fixture.test", password: H.API_KEY });
  c.ok("N2.22", "the API key used as a password creates no account and no session while MFA is on", legacy.status === 401 && legacy.setCookie.length === 0 && !srv.readStore().admin_users.some((u) => u.email === "api-key-user@fixture.test"), legacy.body);
  c.eq("N2.23", "the preflight reports api_key_fallback_off as failed", ((await freshRoot().get(`${A}/session/mfa/enforcement/preflight?level=privileged`)).body.failed || []).includes("api_key_fallback_off"), true);
  await srv.restart({ LEAD_AGENTS_ALLOW_API_KEY_LOGIN: undefined });

  // ------------------------------------------------------------ N3: raising, versions, concurrency, unchanged
  const v1 = await put("optional", { version: 0 });
  c.status("N3.1", "positive control: raising to 'optional' with a second-factor grant succeeds", v1, 200);
  c.ok("N3.2", "server reports what is stored (value optional, version 1, changed)", v1.body.setting && v1.body.setting.value === "optional" && v1.body.setting.version === 1 && v1.body.changed === true, v1.body);
  const audited = await srv.audit((e) => e.action === "mfa_enforcement_changed" && e.metadata.outcome === "success");
  c.ok("N3.3", "the change is audited with old and new level, version and actor, without tokens", audited.length === 1 && audited[0].metadata.old_value === "off" && audited[0].metadata.new_value === "optional" && audited[0].metadata.version === 1 && !JSON.stringify(audited).includes("eyJ"), audited[0] && audited[0].metadata);
  c.status("N3.4", "a stale expected_version is refused (409 version_conflict)", await put("privileged", { version: 0 }), 409);
  c.ok("N3.5", "the conflict answer shows the current version", (await put("privileged", { version: 0 })).body.current.version === 1);
  c.status("N3.6", "writing the unchanged value is refused (409 enforcement_unchanged)", await put("optional", { version: 1 }), 409);
  c.eq("N3.7", "...and the stored version / timestamp did not move (grace cannot be restarted)", [stored().version, stored().updated_at], [1, v1.body.setting.updated_at]);
  const hist = await freshRoot().get(`${SET}/history`);
  c.ok("N3.8", "history shows the change", hist.status === 200 && hist.body.history.some((h) => h.new_value === "optional"), hist.body);
  // concurrent writers: exactly one wins
  const mk = async (value) => { const cl = freshRoot(); const g = await grantFor(cl); return () => cl.put(SET, { value, expected_version: 1, confirm: true }, { headers: hdr(g.body.step_up.token) }); };
  const w1 = await mk("privileged"); const w2 = await mk("all"); const w3 = await mk("off");
  const par = await Promise.all([w1(), w2(), w3()]);
  c.eq("N3.9", "three concurrent writers with the same expected version: exactly one succeeds", par.filter((r) => r.status === 200).length, 1, { statuses: par.map((r) => r.status) });
  c.ok("N3.10", "the others get 409 (conflict), 412 (preflight) or 409 unchanged - never a server error", par.every((r) => [200, 409, 412].includes(r.status)), par.map((r) => r.status));
  const level = stored().value;
  c.ok("N3.11", "the stored level is the winner's", ["privileged", "all", "off"].includes(level) && stored().version === 2, stored());
  // go to a known state: optional
  if (level !== "optional") { const back = await put("optional", { version: stored().version }); c.ok("N3.12", "setup: lowering back to optional is not blocked by any preflight", back.status === 200, back.body); }

  // ------------------------------------------------------------ N4: modes and grace
  const stf = await H.createUser(root, { role: "ochiga_staff" });
  const adm = await H.createUser(root, { role: "ochiga_admin" });
  const scoped = await H.createUser(root, { role: "ochiga_staff", scopes: ["staff.manage"] });
  const login = (p, client) => p.loginRaw(client || p.client);
  const upTo = await put("privileged", { version: stored().version });
  c.status("N4.0", "setup: raise to privileged (preflight passes)", upTo, 200);
  const l1 = await login(adm); const l2 = await login(stf); const l3 = await login(scoped);
  c.ok("N4.1", "privileged level: an unenrolled ochiga_admin (holds settings.manage / staff.manage) signs in with an enrolment NOTICE", l1.status === 200 && l1.body.ok === true && l1.body.mfa_enrollment && l1.body.mfa_enrollment.required === true && l1.body.mfa_enrollment.days_left >= 13 && l1.body.mfa_enrollment.days_left <= 14, l1.body);
  c.ok("N4.2", "grace end is 14 days after the level took effect", Math.abs(Date.parse(l1.body.mfa_enrollment.grace_ends_at) - (Date.parse(stored().updated_at) + 14 * DAY)) < 5000, l1.body.mfa_enrollment);
  c.ok("N4.3", "an ordinary staff account is not covered (no notice)", l2.status === 200 && l2.body.ok === true && !l2.body.mfa_enrollment, l2.body);
  c.ok("N4.4", "an ordinary account holding a staff.manage SCOPE is covered (effective permissions, not the role label)", l3.body.mfa_enrollment && l3.body.mfa_enrollment.required === true, l3.body);
  const meNotice = await adm.client.get(`${A}/session/me`);
  c.ok("N4.5", "/session/me carries the notice for the covered account", meNotice.status === 200 && meNotice.body.mfa.enrollment && meNotice.body.mfa.enrollment.required === true, meNotice.body.mfa);
  const stMfa = await adm.client.get(`${A}/session/mfa`);
  c.ok("N4.6", "GET /session/mfa shows required + enrollment, and the enforcement block (level, status, recovery) to staff.manage holders", stMfa.body.required === true && stMfa.body.enrollment && stMfa.body.enforcement && stMfa.body.enforcement.level === "privileged", stMfa.body);
  const stfMfa = await stf.client.get(`${A}/session/mfa`);
  c.ok("N4.7", "an account without staff.manage sees no enforcement block", stfMfa.status === 200 && !stfMfa.body.enforcement && stfMfa.body.required === false, stfMfa.body);
  c.ok("N4.8", "enforced-but-in-grace accounts keep a working session", (await adm.client.get(`${A}/users`)).status === 200 || (await adm.client.get(`${A}/session/me`)).status === 200);
  const created = await H.createUser(root, { role: "ochiga_admin" });
  const lc = await login(created);
  c.ok("N4.9", "a new covered account's grace runs from its creation / the level change (whichever is later)", lc.body.mfa_enrollment && Date.parse(lc.body.mfa_enrollment.grace_ends_at) >= Date.parse(stored().updated_at) + 14 * DAY - 5000, lc.body.mfa_enrollment);
  const enrolledAdm = await H.createUser(root, { role: "ochiga_admin" }); await enrolledAdm.loginRaw(); const eaEnrol = await enrolledAdm.enrollTotp(enrolledAdm.client);
  c.ok("N4.10", "setup: a covered account enrols voluntarily during grace", eaEnrol.ok);
  const eaLogin = await enrolledAdm.loginRaw(new Client(srv));
  c.ok("N4.11", "an enrolled account is challenged and gets no notice", eaLogin.body.mfa_required === true && !eaLogin.body.mfa_enrollment, eaLogin.body);

  // just before the deadline: the effective timestamp is moved back 13.9 days (deadline in ~2.4 h)
  const sessionBefore = adm.client.cookie;
  await editStore((st) => { st.runtime_settings[KEY].updated_at = new Date(Date.now() - 13.9 * DAY).toISOString(); for (const u of st.admin_users) u.created_at = new Date(Date.now() - 40 * DAY).toISOString(); });
  const lBefore = await login(adm);
  c.ok("N4.20", "13.9 days after the level took effect the covered account still signs in (inside grace) with days_left 1", lBefore.status === 200 && lBefore.body.ok === true && lBefore.body.mfa_enrollment && lBefore.body.mfa_enrollment.days_left === 1, lBefore.body);
  c.status("N4.21", "its existing session is still accepted", await new Client(srv, { cookie: sessionBefore }).get(`${A}/session/me`), 200);
  // just after the deadline: 14.1 days
  await editStore((st) => { st.runtime_settings[KEY].updated_at = new Date(Date.now() - 14.1 * DAY).toISOString(); });
  const lAfter = await login(adm);
  c.ok("N4.22", "14.1 days after the level took effect the covered account gets NO session: an enrolment challenge instead", lAfter.status === 200 && lAfter.body.mfa_enrollment_required === true && !!lAfter.body.challenge_token && lAfter.setCookie.length === 0 && !("admin" in lAfter.body), lAfter.body);
  c.status("N4.23", "its existing session is ended (401 mfa_enrollment_required)", await new Client(srv, { cookie: sessionBefore }).get(`${A}/session/me`), 401);
  c.ok("N4.23b", "...with the reason", /mfa_enrollment_required/.test(JSON.stringify((await new Client(srv, { cookie: sessionBefore }).get(`${A}/session/me`)).body)));
  c.status("N4.24", "...and on a protected route", await new Client(srv, { cookie: sessionBefore }).get(`${A}/users`), 401);
  c.ok("N4.25", "the scoped account (privileged by permission) is blocked too", (await login(scoped)).body.mfa_enrollment_required === true);
  c.ok("N4.26", "an uncovered staff account is unaffected", (await login(stf)).body.ok === true);
  const eaAfter = await enrolledAdm.loginRaw(new Client(srv));
  c.ok("N4.27", "an enrolled covered account is still challenged for its factor, not for enrolment", eaAfter.body.mfa_required === true && !eaAfter.body.mfa_enrollment_required, eaAfter.body);
  const eaIn = await enrolledAdm.signIn();
  c.status("N4.28", "...and signs in normally", eaIn.res, 200);
  const encr = lAfter.body.challenge_token;
  c.status("N4.29", "the enrolment challenge is not a session and not a login challenge", await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: encr, method: "totp", code: "000000" }), 401);
  const brandNew = await H.createUser(root, { role: "ochiga_admin" });
  const lnew = await login(brandNew);
  c.ok("N4.30", "an account created after the deadline gets its own grace (notice, session)", lnew.body.ok === true && lnew.body.mfa_enrollment && lnew.body.mfa_enrollment.days_left >= 13, lnew.body);
  // forced enrolment from the blocked state completes and unblocks
  const anon = new Client(srv);
  await anon.post(`${A}/session/mfa/enroll/email-code`, { challenge_token: encr });
  const mm = await waitMail(adm.email, (m) => /\b\d{8}\b/.test((m.text || "") + (m.html || "")));
  const code8 = (((mm[mm.length - 1] || {}).text || "").match(/\b(\d{8})\b/) || [])[1];
  c.ok("N4.31", "the mailbox code is delivered to the blocked account's address", !!code8, mail.to(adm.email).map((m) => m.subject));
  const ev = await anon.post(`${A}/session/mfa/enroll/email-verify`, { challenge_token: encr, email_code: code8 });
  const fb = await anon.post(`${A}/session/mfa/enroll/forced/begin`, { enrollment_token: ev.body.enrollment_token });
  const tf = await U.nextTotp(fb.body.secret_base32, 0);
  const fc = await anon.post(`${A}/session/mfa/enroll/forced/confirm`, { enrollment_token: ev.body.enrollment_token, credential_id: fb.body.credential_id, code: tf.code });
  c.status("N4.32", "forced enrolment through the mailbox gate completes", fc, 200);
  c.ok("N4.33", "no session was created by it", fc.setCookie.length === 0 && fc.body.sign_in_again === true);
  adm.secret = fb.body.secret_base32; adm.lastStep = tf.step; adm.recovery = fc.body.recovery_codes || [];
  const admIn = await adm.signIn();
  c.status("N4.34", "afterwards the account signs in with its factor (requirement met)", admIn.res, 200);
  c.status("N4.35", "...and its session works on a protected route", await admIn.client.get(`${A}/session/mfa`), 200);

  // ------------------------------------------------------------ N5: lowering, revocation not revived, all, fail closed
  const revokedSession = new Client(srv, { cookie: sessionBefore });
  const rootSess = freshRoot();
  const rg = await grantFor(rootSess, "session_revocation");
  const rvk = await rootSess.post(`${A}/users/${stf.id}/revoke-sessions`, {}, { headers: hdr(rg.body.step_up.token) });
  c.status("N5.0", "setup: revoke the staff account's sessions (generation bump)", rvk, 200);
  const staleStaff = stf.client;   // pre-revocation session of stf
  c.status("N5.0b", "setup: that session is dead", await staleStaff.get(`${A}/session/me`), 401);
  const lowered = await put("off", { version: stored().version });
  c.status("N5.1", "lowering the level is allowed without preflight", lowered, 200);
  c.status("N5.2", "lowering never revives a revoked session", await staleStaff.get(`${A}/session/me`), 401);
  c.ok("N5.3", "with level off, an unenrolled previously blocked account signs in normally", (await login(scoped)).body.ok === true);
  c.ok("N5.4", "with level off, an ENROLLED account is still challenged (never downgraded)", (await enrolledAdm.loginRaw(new Client(srv))).body.mfa_required === true);
  const toAll = await put("all", { version: stored().version });
  c.status("N5.5", "raise to 'all'", toAll, 200);
  const lStaff = await login(stf);
  c.ok("N5.6", "'all' covers an ordinary staff account: notice with a fresh 14 day grace from the new level", lStaff.body.ok === true && lStaff.body.mfa_enrollment && lStaff.body.mfa_enrollment.days_left >= 13, lStaff.body);
  const effectiveBefore = stored().updated_at;
  c.status("N5.7", "re-saving 'all' is refused so it cannot extend grace", await put("all", { version: stored().version }), 409);
  c.eq("N5.8", "...and the effective time is unchanged", stored().updated_at, effectiveBefore);

  // fail closed: an unreadable stored value
  const stfSession = lStaff.setCookie.length ? stf.client.cookie : "";
  await editStore((st) => { st.runtime_settings[KEY].value = "bogus"; });
  const bogusLogin = await login(stf);
  c.ok("N5.10", "an invalid stored level never silently becomes 'off': sign-in of an unenrolled account is a 503, not a session", bogusLogin.status === 503 && bogusLogin.setCookie.length === 0, bogusLogin.body);
  const bogusSession = await new Client(srv, { cookie: stfSession }).get(`${A}/session/me`);
  c.ok("N5.11", "...and an existing session of an unenrolled account is not accepted (503), not trusted", bogusSession.status === 503, bogusSession.body);
  c.ok("N5.12", "...while an ENROLLED account is unaffected by the unreadable level", (await enrolledAdm.signIn()).res.status === 200);
  c.ok("N5.13", "the error body carries no internal detail", !/bogus|runtime_settings|office_mfa_enforcement|stack/i.test(JSON.stringify(bogusLogin.body)), bogusLogin.body);
  await editStore((st) => { st.runtime_settings[KEY].value = "all"; });
  c.ok("N5.14", "after the value is repaired sign-in works again", (await login(stf)).status === 200);

  // machinery off: the level is inactive (declared downgrade)
  await editStore((st) => { st.runtime_settings[KEY].updated_at = new Date(Date.now() - 20 * DAY).toISOString(); });
  c.ok("N5.20", "setup: with level 'all' and the grace long over, an unenrolled account is blocked", (await login(stf)).body.mfa_enrollment_required === true);
  await srv.restart({ LEAD_AGENTS_MFA: "off" });
  const offLogin = await login(stf);
  c.ok("N5.21", "with the MFA machinery OFF the stored level enforces nothing (declared downgrade)", offLogin.status === 200 && offLogin.body.ok === true && !offLogin.body.mfa_enrollment_required, offLogin.body);
  const offHz = await healthz();
  c.ok("N5.22", "health states that MFA is off and reports the number of enrolled accounts (the downgrade is visible)", offHz.mfa.mode === "off" && Number.isInteger(offHz.mfa.enrolled_accounts) && offHz.mfa.enrolled_accounts >= 3, offHz.mfa);
  c.info("with LEAD_AGENTS_MFA=off an enrolled account signs in with the password alone (documented downgrade, S7.5.3 section 1)");
  await srv.restart({ LEAD_AGENTS_MFA: "on" });

  // audit and redaction
  const blob = JSON.stringify(srv.allAudit()) + srv.logs();
  c.ok("N6.1", "no grant, challenge, enrolment token or mailbox code in audit records or logs", !blob.includes(wrongPurposeToken) && !blob.includes(encr) && !blob.includes(ev.body.enrollment_token) && !blob.includes(code8));
  c.ok("N6.2", "enforcement changes are audited for every successful change", (await srv.audit((e) => e.action === "mfa_enforcement_changed" && e.metadata.outcome === "success")).length >= 5);
});
