// S7 remediation R1: login limiter, account-existence normalisation, timing work, strict session-token structure. Contract: docs/settings-domain/38_S7_R1_LOGIN_AND_SESSION_REMEDIATION_CONTRACT.md
// Phrased independently of the frozen certification corpus (which is run unchanged alongside): positive and negative controls over HTTP.
"use strict";
const L = require("./cert/cert-lib");
const { A, boot, seed, loginPlain, stepUp, enrollTotp, signInTotp, totp, forgeSession, decodeCookie, recorder } = L;
const R = recorder("login-hardening-r1"); const { check, eq } = R;
const mails = []; const realFetch = global.fetch;
global.fetch = async (url, init) => { if (String(url).startsWith("https://api.resend.com")) { mails.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: "m" }), { status: 200 }); } return realFetch(url, init); };
const WRONG = "definitely wrong passphrase 123";
const login = (sys, email, password, headers) => sys.call("POST", `${A}/session/login`, { body: { email, password }, headers });
const tokenFromMail = () => decodeURIComponent((mails.at(-1).text.match(/token=([^\s"'&<>)]+)/) || [])[1] || "");
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  // ===== F-1: once limited, EVERY attempt is refused, identically
  { const sys = await boot({}, { loginMax: 5 }); const u = await seed(sys, "locked", "ochiga_staff"); const first = []; for (let i = 0; i < 5; i += 1) first.push((await login(sys, u.email, WRONG)).status);
    check(first.every((s) => s === 401), `F1 the first five wrong attempts are processed (${first})`);
    const wrongNow = await login(sys, u.email, WRONG); const rightNow = await login(sys, u.email, u.password);
    eq(wrongNow.status, 429, "F1 a wrong password during lockout is refused"); eq(rightNow.status, 429, "F1 the CORRECT password during lockout is refused");
    eq(rightNow.text, wrongNow.text, "F1 the two refusals are byte-identical (no success oracle)"); check(!rightNow.cookie && !wrongNow.cookie && !/admin/.test(rightNow.text), "F1 no session and no account data while limited");
    check(!!rightNow.headers.get("x-login-ratelimit-reset"), "F1 the refusal says when the window ends");
    const unknownNow = await login(sys, "nobody@cert.test", WRONG); const unknownSame = await login(sys, u.email, WRONG); void unknownNow; eq(unknownSame.status, 429, "F1 it stays refused for the rest of the window");
    const other = await seed(sys, "bystander", "ochiga_staff", {}); eq((await login(sys, other.email, other.password)).status, 200, "F1 another account on the same address is unaffected until its own budget is spent (negative control)"); await sys.close(); }
  // success resets only the per-address counter
  { const sys = await boot({}, { loginMax: 5 }); const u = await seed(sys, "typo", "ochiga_staff"); for (let i = 0; i < 3; i += 1) await login(sys, u.email, WRONG); eq((await login(sys, u.email, u.password)).status, 200, "F1 a correct password under the limit signs in");
    const after = []; for (let i = 0; i < 4; i += 1) after.push((await login(sys, u.email, WRONG)).status); check(after.every((s) => s === 401), `F1 the per-address counter was cleared by the success (${after})`); await sys.close(); }
  // address rotation cannot beat the per-account ceiling (5 x 5 = 25 failures)
  { /* R6: the forwarded address is honoured only behind a TRUSTED proxy hop; this scenario models one trusted proxy so each address has its own budget and the per-account ceiling is what stops rotation (rotation WITHOUT a trusted proxy is covered by the R6 suite). */ const sys = await boot({ trustedProxyHops: 1 }, { loginMax: 5 }); const u = await seed(sys, "rotating", "ochiga_staff"); const bystander = await seed(sys, "calm", "ochiga_staff"); let processed = 0; for (let i = 0; i < 25; i += 1) { const r = await login(sys, u.email, WRONG, { "x-forwarded-for": `10.9.${i}.1` }); if (r.status === 401) processed += 1; }
    eq(processed, 25, "F1 rotating the forwarded address, 25 failures are processed (each address has its own budget)"); const r26 = await login(sys, u.email, WRONG, { "x-forwarded-for": "10.9.200.1" }); eq(r26.status, 429, "F1 the 26th failure from a brand-new address is refused (per-account ceiling)");
    const rightFresh = await login(sys, u.email, u.password, { "x-forwarded-for": "10.9.201.1" }); eq(rightFresh.status, 429, "F1 even the correct password from a fresh address is refused while the account ceiling holds"); check(!rightFresh.cookie, "F1 …and creates no session");
    eq((await login(sys, bystander.email, bystander.password, { "x-forwarded-for": "10.9.202.1" })).status, 200, "F1 the ceiling is per account: a different account still signs in (negative control)"); await sys.close(); }
  // a client cannot dodge the per-address budget by using unknown-account noise to hide the target: unknown e-mails are counted by the same rules
  { const sys = await boot({}, { loginMax: 3 }); const codes = []; for (let i = 0; i < 6; i += 1) codes.push((await login(sys, "ghost@cert.test", WRONG)).status); check(codes.slice(0, 3).every((s) => s === 401) && codes.slice(3).every((s) => s === 429), `F1 an unknown address is limited exactly like a real one (${codes})`); await sys.close(); }
  // concurrency, one instance
  { const sys = await boot({}, { loginMax: 10 }); const u = await seed(sys, "burst", "ochiga_staff"); const burst = await Promise.all(Array.from({ length: 30 }, () => login(sys, u.email, WRONG))); eq(burst.filter((r) => r.status === 401).length, 10, "F1 30 simultaneous wrong attempts: exactly the limit (10) is processed"); eq(burst.filter((r) => r.status === 429).length, 20, "F1 …and the other 20 are refused");
    const mixed = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? login(sys, u.email, u.password) : login(sys, u.email, WRONG)))); check(mixed.every((r) => r.status === 429 && !r.cookie), "F1 30 simultaneous attempts (one in three with the CORRECT password) after the limit: all refused, no session"); await sys.close(); }
  { const sys = await boot({}, { loginMax: 6 }); const u = await seed(sys, "race", "ochiga_staff"); const mix = await Promise.all(Array.from({ length: 24 }, (_, i) => login(sys, u.email, i === 12 ? u.password : WRONG))); const processed = mix.filter((r) => r.status !== 429); eq(processed.length, 6, "F1 24 simultaneous attempts incl. one correct: exactly six are processed in total"); check(mix.filter((r) => r.status === 200).length <= 1, "F1 at most one session can result"); await sys.close(); }
  // multiple instances (separate processes' limiters; same account store): each enforces its own budget; the documented bound is instances x limit
  { const first = await boot({}, { loginMax: 4 }); const second = await boot({}, { loginMax: 4, store: first.store }); const u = await seed(first, "twin", "ochiga_staff"); const a = []; const b = []; for (let i = 0; i < 6; i += 1) { a.push((await login(first, u.email, WRONG)).status); b.push((await login(second, u.email, WRONG)).status); }
    check(a.filter((s) => s === 401).length === 4 && b.filter((s) => s === 401).length === 4, `F1 each instance enforces its own budget (${a} | ${b}): total processed = instances x limit (documented bound)`); eq((await login(first, u.email, u.password)).status, 429, "F1 a limited instance refuses the correct password"); eq((await login(second, u.email, u.password)).status, 429, "F1 so does the other"); await first.close(); await second.close(); }

  // ===== F-2: one failure answer
  { const sys = await boot({}); const real = await seed(sys, "real", "ochiga_staff"); const dormant = await seed(sys, "dormant", "ochiga_staff"); await sys.store.updateAdminUser(dormant.id, { status: "inactive" });
    const cases = { unknown: await login(sys, "nobody@cert.test", WRONG), wrong: await login(sys, real.email, WRONG), inactiveWrong: await login(sys, dormant.email, WRONG), inactiveRight: await login(sys, dormant.email, dormant.password) };
    for (const [name, r] of Object.entries(cases)) check(r.status === 401 && !r.cookie && r.text === cases.unknown.text, `F2 ${name}: 401 with the same body as an unknown account (${r.status} ${r.text.slice(0, 60)})`);
    check(!/inactive|deactivat|disabled/i.test(Object.values(cases).map((r) => r.text).join(" ")), "F2 no response mentions that an account is inactive");
    check((await sys.store.listAuditEvents(999)).some((e) => e.action === "session_login_denied_inactive" && e.target_id === dormant.id && !JSON.stringify(e).match(/password|hash|passphrase/i)), "F2 the denied inactive sign-in is audited by category, without password data");
    const live = await login(sys, real.email, real.password); eq(live.status, 200, "F2 an active account is unaffected (positive control)");
    // deactivation is still enforced end to end
    const boss = await seed(sys, "boss", "super_admin"); await enrollTotp(sys, boss); const bossC = await signInTotp(sys, boss); const victim = await seed(sys, "leaver", "ochiga_staff"); const vc = (await login(sys, victim.email, victim.password)).cookie;
    eq((await sys.call("PATCH", `${A}/users/${victim.id}`, { cookie: bossC, body: { status: "inactive" } })).status, 200, "F2 (setup) an administrator deactivates an account"); eq((await sys.call("GET", `${A}/session/me`, { cookie: vc })).status, 401, "F2 the deactivated account's session ends"); check(!(await login(sys, victim.email, victim.password)).cookie, "F2 the deactivated account cannot sign in");
    eq((await sys.call("PATCH", `${A}/users/${victim.id}`, { cookie: bossC, body: { status: "active" } })).status, 200, "F2 (setup) reactivation"); eq((await login(sys, victim.email, victim.password)).status, 200, "F2 a reactivated account signs in again (negative control)"); eq((await sys.call("GET", `${A}/session/me`, { cookie: vc })).status, 401, "F2 …and the old session stays dead");
    // the second factor behaviour is unchanged
    const wrongForEnrolled = await login(sys, boss.email, WRONG); check(!wrongForEnrolled.json?.mfa_required && wrongForEnrolled.status === 401, "F2 no MFA challenge without the right password"); const ch = await login(sys, boss.email, boss.password); check(ch.json.mfa_required === true && !ch.cookie, "F2 the right password still yields only a challenge for an enrolled account");
    await sys.close(); }

  // ===== F-3: the hashing work is the same; measured, not claimed perfect
  { const sys = await boot({}); const real = await seed(sys, "timed", "ochiga_staff"); const t = async (fn) => { const s = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - s) / 1e6; }; const unknown = []; const known = [];
    for (let i = 0; i < 6; i += 1) { await login(sys, `warm${i}@cert.test`, WRONG); await login(sys, real.email, WRONG); }
    for (let i = 0; i < 40; i += 1) { unknown.push(await t(() => login(sys, `ghost${i}@cert.test`, WRONG))); known.push(await t(() => login(sys, real.email, WRONG))); }
    const mu = median(unknown), mk = median(known); console.log(`  timing (ms): unknown median ${mu.toFixed(2)}, existing median ${mk.toFixed(2)}, ratio ${(mk / mu).toFixed(2)}`);
    check(mu > 10, `F3 an unknown account now performs the password hashing work (median ${mu.toFixed(1)} ms; was ~0.5 ms)`); check(mk / mu < 1.25 && mk / mu > 0.8, `F3 existing and unknown accounts are within 25% of each other (ratio ${(mk / mu).toFixed(2)})`); await sys.close(); }

  // ===== F-4: strict token structure, existing sessions preserved
  { const sys = await boot({}); const { config } = sys; const u = await seed(sys, "tok", "ochiga_staff"); const ok = (await login(sys, u.email, u.password)).cookie; const me = (c) => sys.call("GET", `${A}/session/me`, { cookie: c }); eq((await me(ok)).status, 200, "F4 a normally issued session works (positive control)");
    const raw = decodeCookie(ok).raw; const [pl, sg] = raw.split("."); const named = (value) => `${config.sessionCookieName}=${encodeURIComponent(value)}`;
    for (const [name, v] of [["trailing segment", `${pl}.${sg}.x`], ["trailing empty segment", `${pl}.${sg}.`], ["two trailing segments", `${pl}.${sg}.a.b`], ["leading empty segment", `.${pl}.${sg}`], ["empty payload", `.${sg}`], ["empty signature", `${pl}.`], ["no separator", pl], ["only separator", "."], ["duplicate payload", `${pl}.${pl}`], ["signature in uppercase", `${pl}.${sg.toUpperCase()}`]]) eq((await me(named(v))).status, 401, `F4 refused: ${name}`);
    const claims = decodeCookie(ok).claims; for (const [name, c] of [["wrong secret", forgeSession(config, claims, { secret: "an attacker chosen secret 0123456789abcdef" })], ["role elevated, old signature", `${config.sessionCookieName}=${encodeURIComponent(`${Buffer.from(JSON.stringify({ ...claims, role: "super_admin" })).toString("base64url")}.${sg}`)}`], ["expired", forgeSession(config, { ...claims, exp: Date.now() - 1000 })]]) eq((await me(c)).status, 401, `F4 forgery refused: ${name}`);
    const legacyClaims = { email: u.email, role: "ochiga_staff", user_id: u.id, permission_scopes: [], exp: Date.now() + 3_600_000 }; eq((await me(forgeSession(config, legacyClaims))).status, 200, "F4 a valid legacy token (no generation, no fingerprint) is still accepted (compatibility)");
    eq((await me(`${forgeSession(config, legacyClaims)}`.replace(/(=[^;]*)$/, "$1" + encodeURIComponent(".x")))).status, 401, "F4 …but a legacy token with a trailing segment is refused");
    await sys.store.revokeAdminSessions(u.id, { actor: "r1" }); eq((await me(ok)).status, 401, "F4 generation checking still ends a revoked session"); eq((await me(forgeSession(config, legacyClaims))).status, 401, "F4 …and a legacy token after any revocation");
    // step-up, MFA and session binding are not weakened
    const boss = await seed(sys, "stepper", "super_admin"); await enrollTotp(sys, boss); const bc = await signInTotp(sys, boss); await L.freshStep(sys, boss); const g = await stepUp(sys, bc, boss, "security_policy_write", { method: "totp", code: totp(boss.secret) }); eq(g.status, 200, "F4 step-up with a second factor still works"); const tok = g.json.step_up.token; eq((await sys.call("POST", `${A}/session/step-up/check`, { cookie: bc, token: tok, body: { purpose: "security_policy_write" } })).status, 200, "F4 the grant verifies in its own session");
    eq((await sys.call("POST", `${A}/session/step-up/check`, { cookie: bc, token: `${tok}.x`, body: { purpose: "security_policy_write" } })).json?.valid === true, false, "F4 a grant with a trailing segment is still refused"); eq((await sys.call("GET", `${A}/session/me`, { cookie: forgeSession(config, { ...decodeCookie(bc).claims, mf: 0 }) })).status, 401, "F4 a hand-built token without the MFA proof of an enrolled account is refused"); await sys.close(); }

  // ===== password reset and invitation acceptance are unchanged
  { const sys = await boot({ officeEmailProvider: "resend", resendApiKey: "re_r1_not_real" }); const u = await seed(sys, "resetter", "ochiga_staff"); mails.length = 0; const known = await sys.call("POST", `${A}/session/reset/request`, { body: { email: u.email } }); const unknown = await sys.call("POST", `${A}/session/reset/request`, { body: { email: "nobody@cert.test" } }); eq(known.text, unknown.text, "R reset request answers identically for known and unknown"); check(mails.length === 1, "R only the real account is mailed");
    const t = tokenFromMail(); const pw = "r1 reset passphrase number 71!"; eq((await sys.call("POST", `${A}/session/reset/confirm`, { body: { token: t, new_password: pw } })).status, 200, "R the reset completes"); eq((await sys.call("POST", `${A}/session/reset/confirm`, { body: { token: t, new_password: "another r1 passphrase 72!" } })).status, 400, "R a reset token is single-use"); eq((await login(sys, u.email, pw)).status, 200, "R the new password signs in through the hardened login");
    const boss = await seed(sys, "inviter", "super_admin"); await enrollTotp(sys, boss); const bc = await signInTotp(sys, boss); mails.length = 0; const inv = await sys.call("POST", `${A}/users/invite`, { cookie: bc, body: { email: "invitee-r1@cert.test", role: "ochiga_staff", display_name: "Invitee" } }); check([200, 201].includes(inv.status), `R an administrator can invite (${inv.status})`);
    const it = tokenFromMail(); eq((await sys.call("POST", `${A}/session/invite/accept`, { body: { token: it, password: "invitee r1 passphrase 73!" } })).status, 200, "R the invitation is accepted"); eq((await login(sys, "invitee-r1@cert.test", "invitee r1 passphrase 73!")).status, 200, "R the invited account signs in"); await sys.close(); }

  global.fetch = realFetch; const failed = R.done(); process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
