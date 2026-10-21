"use strict";
// AREA B / B5: factor management: TOTP enrolment (begin/confirm), replacement, removal, last-factor guard, pending expiry, concurrency, cross-account, notifications,
// forced enrolment through the mailbox gate (e-mail captured via a loopback provider endpoint), no session from an enrolment challenge.
const fs = require("fs");
const H = require("./lib/harness");
const { Forge } = require("./lib/forge");
const { A, Client, U } = H;

H.runSuite("b5-factor-management", async (c) => {
  const mail = await H.startMailCapture();
  c.defer(() => mail.close());
  const srv = await H.makeServer({ mail, extra: { LEAD_AGENTS_MFA_REQUIRED_ROLES: "estate_admin" } });
  c.defer(async () => { await srv.stop(); H.rmrf(srv.dir); });
  const forge = new Forge(srv);
  const admin = await H.adminLogin(srv);
  const hdr = (g) => ({ "x-step-up-token": g.body.step_up.token });
  const rows = (p) => (srv.readStore().admin_mfa_credentials || []).filter((x) => x.admin_user_id === p.id);
  const unused = (p) => (srv.readStore().admin_mfa_recovery_codes || []).filter((x) => x.admin_user_id === p.id && !x.used_at).length;
  const waitMail = async (to, pred, ms = 4000) => { const end = Date.now() + ms; for (;;) { const m = mail.to(to).filter(pred); if (m.length || Date.now() > end) return m; await U.sleep(100); } };
  const begin = (p, client, g) => client.post(`${A}/session/mfa/enroll/totp/begin`, {}, { headers: hdr(g) });
  const confirm = (client, g, cred, code) => client.post(`${A}/session/mfa/enroll/totp/confirm`, { credential_id: cred, code }, { headers: hdr(g) });

  // ------------------------------------------------------------ F1: enrolment authorisation
  const p = await H.createUser(admin, {}); await p.loginRaw();
  c.status("F1.1", "begin without a session is refused", await new Client(srv).post(`${A}/session/mfa/enroll/totp/begin`, {}), 401);
  c.status("F1.2", "begin with an API key is refused (403 actor identity required)", await new Client(srv).post(`${A}/session/mfa/enroll/totp/begin`, {}, { headers: { authorization: `Bearer ${H.API_KEY}` } }), 403);
  c.status("F1.3", "begin with an edge token is refused", await new Client(srv).post(`${A}/session/mfa/enroll/totp/begin`, {}, { headers: { authorization: `Bearer ${H.EDGE}` } }), 403);
  c.status("F1.4", "begin with a session but no step-up grant is refused", await p.client.post(`${A}/session/mfa/enroll/totp/begin`, {}), 403);
  c.status("F1.5", "begin with a garbage grant is refused", await p.client.post(`${A}/session/mfa/enroll/totp/begin`, {}, { headers: { "x-step-up-token": "x.y" } }), 403);
  const adminGrantWrong = await admin.stepUp(admin.client, "security_policy_write", { mfa: null });
  c.status("F1.6", "setup: administrator obtains a grant for a different purpose", adminGrantWrong, 200);
  c.status("F1.7", "begin with a grant of another purpose is refused", await admin.client.post(`${A}/session/mfa/enroll/totp/begin`, {}, { headers: hdr(adminGrantWrong) }), 403);
  const g1 = await p.stepUp(p.client, "mfa_management", { mfa: null });
  c.status("F1.8", "positive control: password-only grant for an account with no factor", g1, 200);
  const other = await H.createUser(admin, {}); await other.loginRaw();
  c.status("F1.9", "another account's grant is refused for begin", await other.client.post(`${A}/session/mfa/enroll/totp/begin`, {}, { headers: hdr(g1) }), 403);
  for (const m of ["GET", "PUT", "DELETE"]) c.ok(`F1.10${m}`, `${m} on enrolment begin is not accepted`, [405, 404].includes((await p.client.req(m, `${A}/session/mfa/enroll/totp/begin`, {})).status));

  // ------------------------------------------------------------ F2: begin / confirm
  const b1 = await begin(p, p.client, g1);
  c.status("F2.1", "begin creates a pending credential", b1, 200);
  c.ok("F2.2", "secret is returned once as Base32 (>=16 chars) with an otpauth URI that names the issuer and the account", /^[A-Z2-7]{16,}$/.test(b1.body.secret_base32) && /^otpauth:\/\/totp\//.test(b1.body.otpauth_uri) && b1.body.otpauth_uri.includes(b1.body.secret_base32) && b1.body.otpauth_uri.includes(encodeURIComponent(p.email)), b1.body);
  c.ok("F2.3", "secret has at least 128 bits (>=16 bytes)", U.b32decode(b1.body.secret_base32).length >= 16);
  c.ok("F2.4", "pending lifetime is stated and at most 15 minutes", Date.parse(b1.body.expires_at) - Date.now() <= 15 * 60 * 1000 + 3000 && Date.parse(b1.body.expires_at) > Date.now(), b1.body.expires_at);
  const st = await p.client.get(`${A}/session/mfa`);
  c.ok("F2.5", "the status endpoint never shows the pending secret", !st.text.includes(b1.body.secret_base32), st.text.slice(0, 300));
  c.ok("F2.6", "stored secret is ciphertext under a key id (no plaintext, no hex, no base64 of the secret)", (() => { const t = JSON.stringify(srv.readStore()); const raw = U.b32decode(b1.body.secret_base32); return !t.includes(b1.body.secret_base32) && !t.includes(raw.toString("hex")) && !t.includes(raw.toString("base64")); })());
  const pending = rows(p).find((x) => x.id === b1.body.credential_id) || {};
  c.ok("F2.7", "pending row stores ciphertext + nonce + key id", pending.secret_ciphertext && pending.secret_nonce && pending.secret_key_id === "k1", Object.keys(pending));
  const bad = await confirm(p.client, g1, b1.body.credential_id, "000000");
  c.status("F2.8", "confirm with a wrong code is refused", bad, 401);
  c.eq("F2.9", "and the credential stays pending (not active)", rows(p).find((x) => x.id === b1.body.credential_id).status, "pending");
  const b2 = await begin(p, p.client, g1);
  c.status("F2.10", "a second begin supersedes the first pending credential", b2, 200);
  const t1 = await U.nextTotp(b1.body.secret_base32, 0);
  const oldPending = await confirm(p.client, g1, b1.body.credential_id, t1.code);
  c.status("F2.11", "the superseded pending credential can no longer be confirmed (409)", oldPending, 409);
  c.eq("F2.12", "the superseded pending credential is revoked", rows(p).find((x) => x.id === b1.body.credential_id).status, "revoked");
  const crossConfirm = await confirm(other.client, await other.stepUp(other.client, "mfa_management", { mfa: null }), b2.body.credential_id, (await U.nextTotp(b2.body.secret_base32, 0)).code);
  c.status("F2.13", "another account cannot confirm this account's pending credential", crossConfirm, 409);
  c.eq("F2.14", "which stays pending for its owner", rows(p).find((x) => x.id === b2.body.credential_id).status, "pending");
  for (const [i, body] of [[1, {}], [2, { credential_id: 5, code: "123456" }], [3, { credential_id: b2.body.credential_id }], [4, { credential_id: b2.body.credential_id, code: "1".repeat(40) }], [5, { credential_id: b2.body.credential_id, code: null }], [6, { credential_id: "not-a-uuid", code: "123456" }]]) {
    const r = await p.client.post(`${A}/session/mfa/enroll/totp/confirm`, body, { headers: hdr(g1) });
    c.ok(`F2.15.${i}`, `confirm with malformed body #${i} is refused without a server error`, [400, 401, 409].includes(r.status), { status: r.status, body: r.body });
  }
  const t2 = await U.nextTotp(b2.body.secret_base32, 0);
  const par = await Promise.all(Array.from({ length: 8 }, () => p.client.clone().post(`${A}/session/mfa/enroll/totp/confirm`, { credential_id: b2.body.credential_id, code: t2.code }, { headers: hdr(g1) })));
  c.eq("F2.16", "8 parallel confirmations of one pending credential activate it exactly once", par.filter((r) => r.status === 200).length, 1);
  c.ok("F2.17", "exactly one set of ten recovery codes exists afterwards", unused(p) === 10, unused(p));
  c.ok("F2.18", "exactly one active TOTP credential exists", rows(p).filter((x) => x.type === "totp" && x.status === "active").length === 1);
  const win = par.find((r) => r.status === 200) || { body: {} };
  c.ok("F2.19", "the confirming response returns the recovery codes once and says the session was re-issued", Array.isArray(win.body.recovery_codes) && win.body.recovery_codes.length === 10 && win.body.session_reissued === true, Object.keys(win.body));
  p.secret = b2.body.secret_base32; p.lastStep = t2.step; p.recovery = win.body.recovery_codes || [];
  { const m = (win.setCookie && win.setCookie[0] || "").match(/^lead_agents_admin=([^;]*)/); if (m) p.client.cookie = decodeURIComponent(m[1]); } // adopt the re-issued session of the winning request
  const nEnr = await waitMail(p.email, (m) => /turned on|two-step/i.test(m.subject || ""));
  c.ok("F2.20", "the owner is notified that two-step verification was turned on", nEnr.length >= 1, mail.to(p.email).map((m) => m.subject));
  c.ok("F2.21", "the notification contains no secret, code, token or hash", nEnr.every((m) => !(m.text + m.html).includes(p.secret) && !p.recovery.some((r) => (m.text + m.html).includes(r)) && !/[0-9a-f]{40,}/.test(m.text || "")), null);
  c.ok("F2.22", "enrolment and its notification are audited truthfully", (await srv.audit((e) => e.action === "mfa_enrolled" && e.target_id === p.id)).length === 1 && (await srv.audit((e) => e.action === "mfa_notification" && e.target_id === p.id && e.metadata.event === "enrolled" && e.metadata.delivery === "sent")).length === 1);
  const afterG = await p.client.get(`${A}/session/me`);
  c.status("F2.23", "the enrolling browser stays signed in", afterG, 200);
  c.status("F2.24", "the grant used for enrolment died with the generation bump (password-only grant refused on a protected management call)", await p.client.post(`${A}/session/mfa/recovery-codes/regenerate`, {}, { headers: hdr(g1) }), 403);

  // ------------------------------------------------------------ F3: begin/confirm when a factor exists (replacement) needs a fresh second factor
  const cl2 = (await p.signIn()).client;
  const passwordOnly = await cl2.post(`${A}/session/step-up`, { purpose: "mfa_management", password: p.password, mfa: { method: "totp", code: "000000" } });
  c.status("F3.1", "replacement: a wrong second factor yields no grant", passwordOnly, 401);
  const gR = await p.stepUp(cl2, "mfa_management");
  c.status("F3.2", "replacement: grant with a fresh TOTP", gR, 200);
  const other2 = await p.signIn();
  const bR = await begin(p, cl2, gR);
  c.status("F3.3", "begin a replacement (a pending credential coexists with the active one)", bR, 200);
  c.eq("F3.4", "one active and one pending TOTP exist", [rows(p).filter((x) => x.type === "totp" && x.status === "active").length, rows(p).filter((x) => x.type === "totp" && x.status === "pending").length], [1, 1]);
  const tR = await U.nextTotp(bR.body.secret_base32, 0);
  const cR = await confirm(cl2, gR, bR.body.credential_id, tR.code);
  c.status("F3.5", "confirm replaces the factor", cR, 200);
  c.ok("F3.6", "replacement does not re-issue recovery codes (existing batch kept)", !cR.body.recovery_codes && unused(p) === 10, Object.keys(cR.body));
  c.status("F3.7", "other sessions of the account are ended by replacement", await other2.client.get(`${A}/session/me`), 401);
  c.status("F3.8", "this browser stays signed in with MFA proof", await cl2.get(`${A}/session/me`), 200);
  const oldSecret = p.secret; p.secret = bR.body.secret_base32; p.lastStep = tR.step;
  const oldLogin = await p.loginRaw(new Client(srv));
  const oldCode = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: oldLogin.body.challenge_token, method: "totp", code: U.totpAtStep(oldSecret, U.stepNow() + 1) });
  c.status("F3.9", "the replaced (old) secret no longer signs in", oldCode, 401);
  const newLogin = await p.signIn();
  c.status("F3.10", "the new secret signs in", newLogin.res, 200);
  c.eq("F3.11", "exactly one active TOTP credential after replacement; the old one is revoked", [rows(p).filter((x) => x.type === "totp" && x.status === "active").length, rows(p).filter((x) => x.type === "totp" && x.status === "revoked").length >= 1], [1, true]);
  const nRep = await waitMail(p.email, (m) => /replaced|changed/i.test((m.subject || "") + (m.text || "")));
  c.ok("F3.12", "the owner is notified of the replacement", nRep.length >= 1, mail.to(p.email).map((m) => m.subject));
  c.ok("F3.13", "the old grant (issued before the replacement) is dead", (await cl2.post(`${A}/session/mfa/recovery-codes/regenerate`, {}, { headers: hdr(gR) })).status === 403);

  // ------------------------------------------------------------ F4: pending expiry (stored timestamp moved back while the server is stopped)
  const q = await H.createUser(admin, {}); await q.loginRaw();
  const gq = await q.stepUp(q.client, "mfa_management", { mfa: null });
  const bq = await begin(q, q.client, gq);
  const tq = await U.nextTotp(bq.body.secret_base32, 0);
  await srv.stop();
  const store = srv.readStore(); const pr = store.admin_mfa_credentials.find((x) => x.id === bq.body.credential_id); pr.created_at = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  fs.writeFileSync(srv.storeFile(), JSON.stringify(store));
  await srv.start();
  // the cookie and grant survive a restart: same session secret
  const cq = await confirm(q.client, gq, bq.body.credential_id, tq.code);
  c.status("F4.1", "a pending credential older than 15 minutes cannot be confirmed (410)", cq, 410);
  c.eq("F4.2", "and is revoked", rows(q).find((x) => x.id === bq.body.credential_id).status, "revoked");
  c.eq("F4.3", "the account is not enrolled", rows(q).filter((x) => x.status === "active").length, 0);

  // ------------------------------------------------------------ F5: password change mid-enrolment
  const r = await H.createUser(admin, {}); await r.loginRaw();
  const gr = await r.stepUp(r.client, "mfa_management", { mfa: null });
  const br = await begin(r, r.client, gr);
  const tr = await U.nextTotp(br.body.secret_base32, 0);
  await admin.client.patch(`${A}/users/${r.id}`, { password: U.randomPassword() });
  const cr = await confirm(r.client, gr, br.body.credential_id, tr.code);
  c.ok("F5.1", "a password change by the administrator mid-enrolment kills the session and grant (confirm refused)", cr.status === 401 || cr.status === 403, { status: cr.status, body: cr.body });
  c.eq("F5.2", "no factor was activated", rows(r).filter((x) => x.status === "active").length, 0);

  // ------------------------------------------------------------ F6: removal, last-factor guard
  const s = await H.newPerson(admin, {});
  const sc = (await s.signIn()).client;
  const sOther = (await s.signIn()).client;
  const gs = await s.stepUp(sc, "mfa_management");
  const activeId = rows(s).find((x) => x.status === "active").id;
  c.status("F6.1", "removal without a grant is refused", await sc.post(`${A}/session/mfa/credentials/${activeId}/remove`, {}), 403);
  c.status("F6.2", "removal with an API key is refused", await new Client(srv).post(`${A}/session/mfa/credentials/${activeId}/remove`, {}, { headers: { authorization: `Bearer ${H.API_KEY}` } }), 403);
  c.status("F6.3", "removal with an invalid credential id is 404", await sc.post(`${A}/session/mfa/credentials/00000000-0000-4000-8000-000000000000/remove`, {}, { headers: hdr(gs) }), 404);
  c.status("F6.4", "removal of another account's credential id is 404", await sc.post(`${A}/session/mfa/credentials/${rows(p).find((x) => x.status === "active").id}/remove`, {}, { headers: hdr(gs) }), 404);
  c.eq("F6.5", "and the other account's credential is untouched", rows(p).find((x) => x.status === "active").status, "active");
  c.status("F6.6", "a non-UUID credential id does not match the route", await sc.post(`${A}/session/mfa/credentials/not-a-uuid/remove`, {}, { headers: hdr(gs) }), 404);
  const rm = await sc.post(`${A}/session/mfa/credentials/${activeId}/remove`, {}, { headers: hdr(gs) });
  c.status("F6.7", "removal of the only factor of a non-required account succeeds", rm, 200);
  c.ok("F6.8", "removal reports no remaining factor and the unused recovery codes deleted", rm.body.remaining_active === 0 && rm.body.recovery_codes_deleted === 10, rm.body);
  c.eq("F6.9", "no unused recovery codes remain", unused(s), 0);
  c.status("F6.10", "the other session is ended", await sOther.get(`${A}/session/me`), 401);
  c.ok("F6.11", "this browser is re-issued a password-only session (the account has no factor now)", (await sc.get(`${A}/session/me`)).body.mfa.verified === false);
  const noMoreCodes = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: forge.challenge(s.email, {}), method: "recovery_code", code: s.recovery[0] });
  c.status("F6.12", "old recovery codes are dead after the last factor was removed", noMoreCodes, 401);
  const plainLogin = await s.loginRaw(new Client(srv));
  c.ok("F6.13", "the account now signs in with the password alone (declared consequence of removal)", plainLogin.status === 200 && plainLogin.body.ok === true, plainLogin.body);
  c.ok("F6.14", "removal is audited and the owner notified", (await srv.audit((e) => e.action === "mfa_factor_removed" && e.target_id === s.id)).length === 1 && (await waitMail(s.email, (m) => /removed/i.test((m.subject || "") + (m.text || "")))).length >= 1);

  // last-factor guard (role listed in LEAD_AGENTS_MFA_REQUIRED_ROLES)
  const g = await H.newPerson(admin, { role: "estate_admin" });
  const gc = (await g.signIn()).client;
  const gg = await g.stepUp(gc, "mfa_management");
  const gid = rows(g).find((x) => x.status === "active").id;
  const guard = await gc.post(`${A}/session/mfa/credentials/${gid}/remove`, {}, { headers: hdr(gg) });
  c.status("F6.20", "removing the LAST factor of an account whose role requires MFA is refused (409 last_factor)", guard, 409);
  c.eq("F6.21", "and the credential stays active", rows(g).find((x) => x.id === gid).status, "active");
  c.eq("F6.22", "and the recovery codes stay", unused(g), 10);
  c.status("F6.23", "the session is unaffected by the refused removal", await gc.get(`${A}/session/me`), 200);
  // with two factors the guard allows removing one
  const gwa = await H.registerWebauthn(g, gc, srv, {});
  c.ok("F6.24", "setup: a second factor (security key) is added", gwa.ok, gwa.ver && gwa.ver.body);
  if (gwa.ok) {
    const gc2 = (await g.signIn()).client; const gg2 = await g.stepUp(gc2, "mfa_management");
    const rmOne = await gc2.post(`${A}/session/mfa/credentials/${gid}/remove`, {}, { headers: hdr(gg2) });
    c.status("F6.25", "with two active factors, removing one is allowed even for a required role", rmOne, 200);
    c.eq("F6.26", "one factor remains", rmOne.body.remaining_active, 1);
    const gc3 = new Client(srv); const l3 = await g.loginRaw(gc3);
    const sA = await gc3.post(`${A}/session/mfa/webauthn/auth/options`, { challenge_token: l3.body.challenge_token });
    const last = gwa.auth.assert(sA.body.options);
    const fin = await gc3.post(`${A}/session/mfa/verify`, { challenge_token: l3.body.challenge_token, method: "webauthn", webauthn: { challenge_id: sA.body.challenge_id, response: last } });
    c.status("F6.27", "the remaining security key signs in", fin, 200);
    const gg3 = await g.stepUp(gc3, "mfa_management", { mfa: null });
    const keyRow = rows(g).find((x) => x.type === "webauthn" && x.status === "active");
    const lastRm = await gc3.post(`${A}/session/mfa/credentials/${keyRow.id}/remove`, {}, { headers: hdr(gg3) });
    c.status("F6.28", "removing the last factor (now a security key) is also refused: the guard counts all factor types", lastRm, 409);
  }
  // removal of a pending credential
  const pe = await H.newPerson(admin, {});
  const pec = (await pe.signIn()).client; const gpe = await pe.stepUp(pec, "mfa_management");
  const bpe = await begin(pe, pec, gpe);
  const sessionBefore = await pec.get(`${A}/session/me`);
  const rmPending = await pec.post(`${A}/session/mfa/credentials/${bpe.body.credential_id}/remove`, {}, { headers: hdr(gpe) });
  c.status("F6.30", "a pending credential can be cancelled", rmPending, 200);
  c.ok("F6.31", "cancelling a pending credential does not end sessions (no active factor was removed)", sessionBefore.status === 200 && (await pec.get(`${A}/session/me`)).status === 200);

  // ------------------------------------------------------------ F7: forced enrolment through the mailbox gate
  const f = await H.createUser(admin, {}); await f.loginRaw();
  const enrollChallenge = forge.challenge(f.email, { purpose: "enroll" });
  const anon = new Client(srv);
  const before = mail.messages.length;
  const sent = await anon.post(`${A}/session/mfa/enroll/email-code`, { challenge_token: enrollChallenge });
  c.status("F7.1", "the mailbox code is requested with an enrolment challenge", sent, 200);
  const codeMail = await waitMail(f.email, (m) => /\b\d{8}\b/.test((m.text || "") + (m.html || "")));
  c.ok("F7.2", "an e-mail with an 8-digit code is delivered to the account address", codeMail.length === 1, mail.messages.length - before);
  const codeValue = (((codeMail[0] || {}).text || "").match(/\b(\d{8})\b/) || [])[1];
  const generic = [];
  for (const tok of ["garbage", forge.challenge(f.email, { purpose: "login" }), forge.challenge(f.email, { purpose: "enroll", iat: Date.now() - 900000 }), forge.challenge(f.email, { purpose: "enroll" }).replace(/.$/, "0")]) {
    const r2 = await anon.post(`${A}/session/mfa/enroll/email-code`, { challenge_token: tok });
    generic.push(JSON.stringify({ s: r2.status, b: { ...r2.body, request_id: undefined } }));
  }
  c.ok("F7.3", "garbage / wrong-purpose / expired / forged challenges get the same answer as a valid one", new Set([...generic, JSON.stringify({ s: sent.status, b: { ...sent.body, request_id: undefined } })]).size === 1, generic);
  c.eq("F7.4", "...and no further e-mail was sent for them", mail.to(f.email).length, 1);
  const wrongV = await anon.post(`${A}/session/mfa/enroll/email-verify`, { challenge_token: enrollChallenge, email_code: codeValue === "00000000" ? "11111111" : "00000000" });
  c.status("F7.5", "a wrong mailbox code is refused", wrongV, 401);
  const noCode = await anon.post(`${A}/session/mfa/enroll/email-verify`, { challenge_token: enrollChallenge });
  c.status("F7.6", "a missing mailbox code is refused", noCode, 401);
  const otherChal = forge.challenge(f.email, { purpose: "enroll" });
  c.status("F7.7", "the mailbox code of one challenge does not verify another challenge (code bound to the challenge)", await anon.post(`${A}/session/mfa/enroll/email-verify`, { challenge_token: otherChal, email_code: codeValue }), 401);
  c.status("F7.8", "a login challenge cannot be used at the mailbox gate", await anon.post(`${A}/session/mfa/enroll/email-verify`, { challenge_token: forge.challenge(f.email, { purpose: "login" }), email_code: codeValue }), 401);
  c.status("F7.9", "an expired enrolment challenge cannot pass the mailbox gate even with its code", await anon.post(`${A}/session/mfa/enroll/email-verify`, { challenge_token: forge.challenge(f.email, { purpose: "enroll", iat: Date.now() - 900000 }), email_code: "12345678" }), 401);
  const verified = await anon.post(`${A}/session/mfa/enroll/email-verify`, { challenge_token: enrollChallenge, email_code: codeValue });
  c.status("F7.10", "positive control: the correct mailbox code yields an enrolment token", verified, 200);
  c.ok("F7.11", "the enrolment token is short lived (<= 10 min) and differs from the challenge", verified.body.enrollment_token && verified.body.enrollment_token !== enrollChallenge && Date.parse(verified.body.expires_at) - Date.now() <= 10 * 60 * 1000 + 3000, verified.body);
  c.status("F7.12", "forced begin with the UNVERIFIED enrolment challenge (skipping the mailbox gate) is refused", await anon.post(`${A}/session/mfa/enroll/forced/begin`, { enrollment_token: enrollChallenge }), 401);
  c.status("F7.13", "forced begin with a login challenge is refused", await anon.post(`${A}/session/mfa/enroll/forced/begin`, { enrollment_token: forge.challenge(f.email, { purpose: "login" }) }), 401);
  const fb = await anon.post(`${A}/session/mfa/enroll/forced/begin`, { enrollment_token: verified.body.enrollment_token });
  c.status("F7.14", "forced begin with the verified token returns a TOTP secret", fb, 200);
  const tf = await U.nextTotp(fb.body.secret_base32, 0);
  c.status("F7.15", "forced confirm with a wrong code is refused", await anon.post(`${A}/session/mfa/enroll/forced/confirm`, { enrollment_token: verified.body.enrollment_token, credential_id: fb.body.credential_id, code: "000000" }), 401);
  const fc = await anon.post(`${A}/session/mfa/enroll/forced/confirm`, { enrollment_token: verified.body.enrollment_token, credential_id: fb.body.credential_id, code: tf.code });
  c.status("F7.16", "forced confirm with the right code activates the factor", fc, 200);
  c.ok("F7.17", "NO session is created by forced enrolment (no cookie; the person signs in again)", fc.setCookie.length === 0 && fc.body.sign_in_again === true && fc.body.session_reissued === false, { cookies: fc.setCookie, body: fc.body });
  c.ok("F7.18", "recovery codes are issued with the first factor", Array.isArray(fc.body.recovery_codes) && fc.body.recovery_codes.length === 10);
  f.secret = fb.body.secret_base32; f.lastStep = tf.step; f.recovery = fc.body.recovery_codes;
  c.status("F7.19", "the account must now sign in with the factor (challenge issued)", { status: (await f.loginRaw(new Client(srv))).body.mfa_required === true ? 200 : 500 }, 200);
  const again = await anon.post(`${A}/session/mfa/enroll/forced/begin`, { enrollment_token: verified.body.enrollment_token });
  // Author's correction: the first draft demanded exactly 409 (what the route's code path returns); the written contract only requires that enrolment kills the token (generation bump) and that no second enrolment starts, so 401 (token dead) and 409 (conflict) are both correct.
  c.ok("F7.20", "the enrolment token cannot be used to start a second enrolment after a factor exists (401 token dead or 409 conflict) and no pending credential is created", [401, 409].includes(again.status) && !rows(f).some((x) => x.status === "pending"), { status: again.status, body: again.body });
  const bypass = await anon.post(`${A}/session/mfa/enroll/forced/confirm`, { enrollment_token: verified.body.enrollment_token, credential_id: fb.body.credential_id, code: (await U.nextTotp(f.secret, f.lastStep)).code });
  c.ok("F7.21", "the enrolment token cannot be used to replace or re-confirm after enrolment", bypass.status !== 200, { status: bypass.status, body: bypass.body });
  const secondMail = await anon.post(`${A}/session/mfa/enroll/email-code`, { challenge_token: forge.challenge(f.email, { purpose: "enroll" }) });
  c.ok("F7.22", "a fresh enrolment challenge for an already enrolled account cannot add or replace a factor", [401, 409].includes((await anon.post(`${A}/session/mfa/enroll/forced/begin`, { enrollment_token: forge.challenge(f.email, { purpose: "enroll_verified" }) })).status) && secondMail.status === 200);
  void secondMail;
  // mailbox code brute force: the persisted failure counter must limit guesses even when the forwarded address rotates
  const bf = await H.createUser(admin, {}); await bf.loginRaw();
  const bfChal = forge.challenge(bf.email, { purpose: "enroll" });
  const answers = [];
  for (let i = 0; i < 25; i += 1) answers.push((await new Client(srv, { ip: `192.0.2.${i + 1}` }).post(`${A}/session/mfa/enroll/email-verify`, { challenge_token: bfChal, email_code: String(10000000 + i * 37) })).status);
  const bfRow = srv.readStore().admin_users.find((u) => u.id === bf.id);
  c.ok("F7.30", "guessing the mailbox code with a rotating forwarded address is stopped by a persisted failure counter / lock (contract: brute-force limited by the shared limiter AND the persisted failure counter)", answers.includes(429) || (bfRow.mfa_failed_attempts || 0) >= 5, { statuses: answers.join(","), counter: bfRow.mfa_failed_attempts, locked_until: bfRow.mfa_locked_until });

  // ------------------------------------------------------------ F8: audit / logs / mail redaction
  const blob = JSON.stringify(srv.allAudit());
  c.ok("F8.1", "no enrolment secret, mailbox code, enrolment token or recovery code in the audit trail", ![b1, b2, bR, bq, fb].some((x) => blob.includes(x.body.secret_base32)) && !blob.includes(codeValue) && !blob.includes(verified.body.enrollment_token) && !(fc.body.recovery_codes || []).some((x) => blob.includes(x)));
  const logs = srv.logs();
  c.ok("F8.2", "no enrolment secret, mailbox code or token in the server logs", ![b1, b2, bR, fb].some((x) => logs.includes(x.body.secret_base32)) && !logs.includes(codeValue) && !logs.includes(verified.body.enrollment_token));
  c.ok("F8.3", "no TOTP secret or recovery code in any e-mail", !mail.messages.some((m) => [b2, bR, fb].some((x) => m.raw.includes(x.body.secret_base32)) || (fc.body.recovery_codes || []).some((x) => m.raw.includes(x))));
  const failed = await srv.audit((e) => e.action === "mfa_enrollment_failed");
  c.ok("F8.4", "failed enrolment steps are audited with a reason category", failed.length >= 3 && failed.every((e) => e.metadata && typeof e.metadata.failure_reason === "string"), failed.length);
});
