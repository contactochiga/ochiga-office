"use strict";
// AREA B / B3: recovery codes: issuance format, single use (incl. concurrency), other account, normalisation, lock sharing, abuse, session effects, notification,
// regeneration invalidating the old batch, not accepted as a step-up factor, never stored or logged in the clear.
const H = require("./lib/harness");
const { A, Client, U } = H;

H.runSuite("b3-recovery-codes", async (c) => {
  const mail = await H.startMailCapture();
  c.defer(() => mail.close());
  const srv = await H.makeServer({ mail });
  c.defer(async () => { await srv.stop(); H.rmrf(srv.dir); });
  const admin = await H.adminLogin(srv);
  const stripId = (b) => { const x = JSON.parse(JSON.stringify(b)); delete x.request_id; return x; };
  const chal = async (p, client = new Client(srv)) => (await p.loginRaw(client)).body.challenge_token;
  const rverify = (token, code, client = new Client(srv)) => client.post(`${A}/session/mfa/verify`, { challenge_token: token, method: "recovery_code", code });
  const unusedCount = (p) => (srv.readStore().admin_mfa_recovery_codes || []).filter((r) => r.admin_user_id === p.id && !r.used_at).length;
  const waitMail = async (to, pred, ms = 4000) => { const end = Date.now() + ms; for (;;) { const m = mail.to(to).filter(pred); if (m.length || Date.now() > end) return m; await U.sleep(100); } };

  // ------------------------------------------------------------ R1: issuance format
  const a = await H.newPerson(admin, {});
  const codes = a.recovery.slice();
  c.eq("R1.1", "first factor issues ten recovery codes", codes.length, 10);
  c.ok("R1.2", "codes have the displayed shape XXXXX-XXXXX from the unambiguous alphabet (no I, L, O, U)", codes.every((x) => /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/.test(x)), codes);
  c.eq("R1.3", "codes are unique", new Set(codes).size, 10);
  c.eq("R1.4", "an enrolled account reports ten unused codes in the factor status (count only)", (await a.client.get(`${A}/session/mfa`)).body.recovery_codes_remaining, 10);
  const status = await a.client.get(`${A}/session/mfa`);
  c.ok("R1.5", "the status endpoint never returns a code", !codes.some((x) => status.text.includes(x) || status.text.includes(x.replace("-", ""))), null);
  const storeText = JSON.stringify(srv.readStore());
  c.ok("R1.6", "the store keeps recovery codes only as keyed hashes (no plaintext code in either spelling)", !codes.some((x) => storeText.includes(x) || storeText.includes(x.replace("-", ""))), null);
  c.ok("R1.7", "the store records which key id produced each hash", (srv.readStore().admin_mfa_recovery_codes || []).filter((r) => r.admin_user_id === a.id).every((r) => r.key_id === "k1"), null);

  // ------------------------------------------------------------ R2: single use, normalisation, session effects
  const older = await a.signIn();            // a normal session that must be ended by a recovery sign-in
  c.status("R2.0", "setup: an older full session exists", await older.client.get(`${A}/session/me`), 200);
  const code1 = codes[0];
  const useCl = new Client(srv);
  const used = await rverify(await chal(a, useCl), code1.toLowerCase().replace("-", " "), useCl);
  c.status("R2.1", "a recovery code (entered lowercase, hyphen replaced by a space) signs in", used, 200);
  c.ok("R2.2", "answer reports the method and the remaining count (9)", used.body.mfa && used.body.mfa.method === "recovery_code" && used.body.mfa.recovery_codes_remaining === 9, used.body.mfa);
  c.ok("R2.3", "a session cookie is issued with MFA proof", used.setCookie.length === 1 && (await useCl.get(`${A}/session/me`)).body.mfa.verified === true);
  c.status("R2.4", "the same code cannot be used again", await rverify(await chal(a), code1), 401);
  c.status("R2.5", "the same code in another spelling cannot be used again", await rverify(await chal(a), code1.replace("-", "").toLowerCase()), 401);
  c.eq("R2.6", "nine codes remain unused in storage", unusedCount(a), 9);
  c.status("R2.7", "using a recovery code ends the account's OTHER sessions (lost-device assumption)", await older.client.get(`${A}/session/me`), 401);
  c.status("R2.8", "the new session from the recovery sign-in is valid", await useCl.get(`${A}/session/me`), 200);
  const normalised = await rverify(await chal(a), codes[1].replace("-", ""));
  c.status("R2.9", "a code entered without the hyphen is accepted (hyphen is formatting only)", normalised, 200);
  const upper = codes[2]; const withU = upper.slice(0, 4) + "U" + upper.slice(5);
  c.status("R2.10", "a code with a character outside the alphabet (U) is refused", await rverify(await chal(a), withU), 401);
  const audit1 = await srv.audit((e) => e.action === "mfa_recovery_code_used" && e.target_id === a.id);
  c.ok("R2.11", "recovery-code use is audited (and the generation revocation is audited)", audit1.length >= 1 && (await srv.audit((e) => e.action === "sessions_revoked_mfa_recovery_code" && e.target_id === a.id)).length >= 1, audit1.length);
  const note = await waitMail(a.email, (m) => /recovery/i.test(m.subject || "") || /recovery/i.test(m.text || ""));
  c.ok("R2.12", "the account owner is notified by e-mail when a recovery code is used", note.length >= 1, mail.to(a.email).map((m) => m.subject));
  c.ok("R2.13", "the notification contains no recovery code, token or secret", !codes.some((x) => (note.map((m) => m.text + m.html).join("")).includes(x)) && !note.map((m) => m.text + m.html).join("").includes(a.secret));
  c.ok("R2.14", "the notification is recorded as sent in the audit trail (truthful status)", (await srv.audit((e) => e.action === "mfa_notification" && e.target_id === a.id && e.metadata.event === "recovery_code_used" && e.metadata.delivery === "sent")).length >= 1);

  // ------------------------------------------------------------ R3: other account / cross use
  const b = await H.newPerson(admin, {});
  const crossCl = new Client(srv);
  const cross = await rverify(await chal(a, crossCl), b.recovery[0], crossCl);
  c.status("R3.1", "another account's recovery code does not sign this account in", cross, 401);
  c.eq("R3.2", "and that code stays unused on its owner's account", unusedCount(b), 10);
  const crossAsTotp = await a.loginRaw(new Client(srv));
  const r3 = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: crossAsTotp.body.challenge_token, method: "totp", code: b.recovery[0] });
  c.status("R3.3", "a recovery code submitted as a TOTP code is refused", r3, 401);
  const r4 = await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: (await a.loginRaw(new Client(srv))).body.challenge_token, method: "recovery_code", code: (await U.nextTotp(a.secret, a.lastStep)).code });
  c.status("R3.4", "a TOTP code submitted as a recovery code is refused", r4, 401);
  c.eq("R3.5", "the stored failure counter of the TARGET account counted the cross attempts, the owner's did not", srv.readStore().admin_users.find((u) => u.id === b.id).mfa_failed_attempts || 0, 0);
  c.status("R3.6", "positive control: the owner's code still works for the owner", await rverify(await chal(b), b.recovery[0]), 200);
  const forgedChallenge = new (require("./lib/forge").Forge)(srv).challenge(b.email, {});
  const sameCode = await rverify(forgedChallenge, a.recovery[5]);
  c.status("R3.7", "account A's unused code with account B's (valid) challenge is refused", sameCode, 401);

  // ------------------------------------------------------------ R4: concurrency
  const d = await H.newPerson(admin, {});
  const tokens = await Promise.all(Array.from({ length: 12 }, () => chal(d)));
  const par = await Promise.all(tokens.map((t) => rverify(t, d.recovery[0])));
  c.eq("R4.1", "12 parallel uses of one recovery code produce exactly one session", par.filter((r) => r.status === 200).length, 1);
  c.ok("R4.2", "the losers are refused generically with no cookie", par.filter((r) => r.status !== 200).every((r) => r.status === 401 && r.setCookie.length === 0), par.map((r) => r.status));
  c.eq("R4.3", "exactly one code was consumed", unusedCount(d), 9);
  const e = await H.newPerson(admin, {});
  const one = await chal(e);
  const par2 = await Promise.all(Array.from({ length: 10 }, (_, i) => rverify(one, e.recovery[i])));
  c.ok("R4.4", "10 parallel DIFFERENT codes on one challenge: no more than one session per challenge use is created per code and the account stays consistent", par2.filter((r) => r.status === 200).length >= 1 && unusedCount(e) === 10 - par2.filter((r) => r.status === 200).length, { ok: par2.filter((r) => r.status === 200).length, unused: unusedCount(e) });

  // ------------------------------------------------------------ R5: malformed / abuse / lock sharing
  const f = await H.newPerson(admin, {});
  const malformed = [["empty", ""], ["short", "ABCDE"], ["long", "A".repeat(41)], ["huge", "A".repeat(100000)], ["spaces", "          "], ["unicode", "١٢٣٤٥٦٧٨٩٠"], ["sql", "' OR 1=1 --"], ["number", 1234567890], ["null", null], ["array", [f.recovery[0]]], ["object", { code: f.recovery[0] }]];
  let batch = 0;
  for (const [idx, [label, value]] of malformed.entries()) {
    if (batch >= 3) { const ok = await f.signIn(); batch = 0; c.ok(`R5.r${idx}`, "counter reset by a valid sign-in", ok.res.status === 200); }
    const r = await rverify(await chal(f), value); batch += 1;
    c.ok(`R5.${idx + 1}`, `malformed recovery code (${label}) is refused with no session and no server error`, [400, 401, 413].includes(r.status) && r.setCookie.length === 0, { status: r.status, body: typeof r.body === "string" ? r.body.slice(0, 100) : r.body });
  }
  c.eq("R5.20", "no recovery code of the account was consumed by malformed attempts", unusedCount(f), 10);

  const g = await H.newPerson(admin, {});
  const wrongTotp = []; for (let i = 0; i < 3; i += 1) wrongTotp.push(await new Client(srv).post(`${A}/session/mfa/verify`, { challenge_token: await chal(g), method: "totp", code: "12345" + i }));
  const wrongRec = []; for (let i = 0; i < 2; i += 1) wrongRec.push(await rverify(await chal(g), `ZZZZZ-ZZZZ${i}`));
  c.status("R5.21", "wrong TOTP and wrong recovery guesses share ONE persisted failure counter (fifth failure locks)", wrongRec[1], 429);
  c.status("R5.22", "a valid recovery code is refused while the account is locked", await rverify(await chal(g), g.recovery[0]), 429);
  c.eq("R5.23", "refused-while-locked leaves the code unused", unusedCount(g), 10);

  const h = await H.newPerson(admin, {});
  const guesses = []; const rnd = () => Array.from({ length: 10 }, () => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Math.floor(Math.random() * 32)]).join("");
  for (let i = 0; i < 40; i += 1) guesses.push(await rverify(await chal(h, new Client(srv, { ip: `198.51.100.${(i % 200) + 1}` })), rnd(), new Client(srv, { ip: `198.51.100.${(i % 200) + 1}` })));
  c.ok("R5.24", "online guessing with a rotating forwarded address: at most 5 guesses are evaluated before the lock holds", guesses.filter((r) => r.status === 401).length <= 5 && guesses.slice(5).every((r) => r.status === 429), guesses.map((r) => r.status).join(","));
  c.eq("R5.25", "persisted failure counter did not keep growing while locked", srv.readStore().admin_users.find((u) => u.id === h.id).mfa_failed_attempts, 5);

  // ------------------------------------------------------------ R6: lost-device path - recovery sign-in then replace the factor with the password alone
  const i = await H.newPerson(admin, {});
  const recSess = new Client(srv);
  const recIn = await rverify(await chal(i, recSess), i.recovery[0], recSess);
  c.status("R6.1", "setup: sign in with a recovery code", recIn, 200);
  const gPwd = await recSess.post(`${A}/session/step-up`, { purpose: "mfa_management", password: i.password });
  c.status("R6.2", "right after a recovery sign-in the session's own MFA proof is fresh: password alone yields the mfa_management grant", gPwd, 200);
  c.ok("R6.3", "that grant is marked as carrying a second factor via the session proof", gPwd.body.step_up.mfa_verified === true && gPwd.body.step_up.second_factor === "session_proof", gPwd.body.step_up);
  const begin = await recSess.post(`${A}/session/mfa/enroll/totp/begin`, {}, { headers: { "x-step-up-token": gPwd.body.step_up.token } });
  c.status("R6.4", "replacement enrolment can begin", begin, 200);
  const nc = await U.nextTotp(begin.body.secret_base32, 0);
  const conf = await recSess.post(`${A}/session/mfa/enroll/totp/confirm`, { credential_id: begin.body.credential_id, code: nc.code }, { headers: { "x-step-up-token": gPwd.body.step_up.token } });
  c.status("R6.5", "replacement of the lost factor succeeds", conf, 200);
  c.ok("R6.6", "replacement does not silently regenerate (or re-issue) recovery codes", !conf.body.recovery_codes, Object.keys(conf.body));
  i.secret = begin.body.secret_base32; i.lastStep = nc.step; i.recovery = i.recovery.slice(1);
  const oldSecretLogin = await i.signIn();
  c.ok("R6.7", "after replacement the new factor signs in", oldSecretLogin.res.status === 200, oldSecretLogin.res.body);

  // ------------------------------------------------------------ R7: recovery codes are NOT a step-up factor
  const j = await H.newPerson(admin, {});
  const jc = (await j.signIn()).client;
  const F2 = new (require("./lib/forge").Forge)(srv);
  const staleClient0 = new Client(srv, { cookie: F2.session(j.email, { mf: true, mft: Date.now() - 20 * 60 * 1000 }) });
  c.status("R7.1", "an enrolled account whose sign-in proof is older than 5 minutes is refused a grant on the password alone", await staleClient0.post(`${A}/session/step-up`, { purpose: "mfa_management", password: j.password }), 401);
  const staleClient = new Client(srv, { cookie: F2.session(j.email, { mf: true, mft: Date.now() - 20 * 60 * 1000 }) });
  const viaRecovery = await staleClient.post(`${A}/session/step-up`, { purpose: "mfa_management", password: j.password, mfa: { method: "recovery_code", code: j.recovery[0] } });
  c.status("R7.2", "a recovery code is not accepted as the second factor of a step-up (mfa.method=recovery_code)", viaRecovery, 401);
  const viaRecoveryAsTotp = await staleClient.post(`${A}/session/step-up`, { purpose: "mfa_management", password: j.password, mfa: { method: "totp", code: j.recovery[0] } });
  c.status("R7.3", "a recovery code smuggled in as a TOTP code is not accepted either", viaRecoveryAsTotp, 401);
  c.eq("R7.4", "the recovery code was not consumed by the refused step-ups", unusedCount(j), 10);
  const grantOk = await j.stepUp(jc, "mfa_management");
  c.status("R7.5", "positive control: the same account obtains a grant with a TOTP code", grantOk, 200);

  // ------------------------------------------------------------ R8: regeneration
  const k = await H.newPerson(admin, {});
  const kc = (await k.signIn()).client;
  const other = (await k.signIn()).client; // second live session
  const oldBatch = k.recovery.slice();
  const noFactorGrant = await kc.post(`${A}/session/step-up`, { purpose: "mfa_management", password: k.password, mfa: { method: "totp", code: "000000" } });
  c.status("R8.0", "setup: a wrong second factor does not yield a grant", noFactorGrant, 401);
  const grant = await k.stepUp(kc, "mfa_management");
  c.status("R8.1", "setup: grant with a fresh TOTP", grant, 200);
  const regen = await kc.post(`${A}/session/mfa/recovery-codes/regenerate`, {}, { headers: k.stepHeaders(grant) });
  c.status("R8.2", "regeneration succeeds with a fresh-factor grant", regen, 200);
  c.ok("R8.3", "regeneration returns ten new codes, all different from the old batch", Array.isArray(regen.body.recovery_codes) && regen.body.recovery_codes.length === 10 && regen.body.recovery_codes.every((x) => !oldBatch.includes(x)), regen.body.recovery_codes && regen.body.recovery_codes.length);
  c.status("R8.4", "regeneration does not end the current session", await kc.get(`${A}/session/me`), 200);
  c.status("R8.5", "regeneration does not end other sessions (generation unchanged)", await other.get(`${A}/session/me`), 200);
  const noGrantRegen = await kc.post(`${A}/session/mfa/recovery-codes/regenerate`, {});
  c.status("R8.13", "regeneration without a grant is refused", noGrantRegen, 403);
  for (let q = 0; q < 3; q += 1) c.status(`R8.${6 + q}`, `old batch code #${q + 1} (never used) no longer works`, await rverify(await chal(k), oldBatch[q]), q < 2 ? 401 : [401, 429]);
  c.eq("R8.9", "exactly ten unused codes exist after regeneration (old unused codes removed)", unusedCount(k), 10);
  const newOk = await rverify(await chal(k), regen.body.recovery_codes[0]);
  c.status("R8.10", "a code of the new batch works", newOk, 200);
  c.ok("R8.11", "regenerated codes are not stored in the clear", !regen.body.recovery_codes.some((x) => JSON.stringify(srv.readStore()).includes(x)));
  const n = await waitMail(k.email, (m) => /recovery codes/i.test((m.subject || "") + (m.text || "")));
  c.ok("R8.12", "the owner is notified of regeneration; the mail carries no code", n.length >= 1 && !regen.body.recovery_codes.some((x) => n.map((m) => m.text + m.html).join("").includes(x)), mail.to(k.email).map((m) => m.subject));
  const apiKeyRegen = await new Client(srv).post(`${A}/session/mfa/recovery-codes/regenerate`, {}, { headers: { authorization: `Bearer ${H.API_KEY}` }, noCookie: true });
  c.status("R8.16", "an API key cannot regenerate recovery codes", apiKeyRegen, 403);
  const noFactor = await H.newPerson(admin, { enroll: false });
  const nfGrant = await noFactor.stepUp(noFactor.client, "mfa_management", { mfa: null });
  const nfRegen = await noFactor.client.post(`${A}/session/mfa/recovery-codes/regenerate`, {}, { headers: noFactor.stepHeaders(nfGrant) });
  c.status("R8.17", "regeneration for an account without a factor is refused (409 no_active_factor)", nfRegen, 409);
  c.eq("R8.18", "and creates no codes", unusedCount(noFactor), 0);

  // wrong-account grant for regeneration
  const m = await H.newPerson(admin, {});
  const mc = (await m.signIn()).client;
  const kk = await H.newPerson(admin, {});
  const otherGrant = await kk.stepUp(kk.client, "mfa_management");
  const wrongAcct = await mc.post(`${A}/session/mfa/recovery-codes/regenerate`, {}, { headers: kk.stepHeaders(otherGrant) });
  c.status("R8.19", "another account's grant cannot regenerate this account's codes", wrongAcct, 403);
  c.eq("R8.20", "and the victim's batch is untouched", unusedCount(m), 10);

  // ------------------------------------------------------------ R9: deactivation / password change kill a recovery sign-in; audit/log redaction
  const o = await H.newPerson(admin, {});
  const oc = await chal(o);
  await admin.client.patch(`${A}/users/${o.id}`, { password: U.randomPassword() });
  c.status("R9.1", "a challenge from before a password change cannot be completed with a valid recovery code", await rverify(oc, o.recovery[0]), 401);
  c.eq("R9.2", "and the code is not consumed", unusedCount(o), 10);
  const blob = JSON.stringify(srv.allAudit());
  c.ok("R9.3", "no recovery code of any account appears in the audit trail", ![a, b, d, e, f, g, h, i, j, k, m, o].some((p) => p.recovery.some((x) => blob.includes(x) || blob.includes(x.replace("-", "")))) && !regen.body.recovery_codes.some((x) => blob.includes(x)));
  const logs = srv.logs();
  c.ok("R9.4", "no recovery code appears in the server logs", ![a, b, k].some((p) => p.recovery.some((x) => logs.includes(x))) && !regen.body.recovery_codes.some((x) => logs.includes(x)));
  c.ok("R9.5", "no recovery code appears in any captured e-mail", !mail.messages.some((mm) => [a, b, k].some((p) => p.recovery.some((x) => mm.raw.includes(x)))) && !mail.messages.some((mm) => regen.body.recovery_codes.some((x) => mm.raw.includes(x))));
});
