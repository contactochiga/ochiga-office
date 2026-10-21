"use strict";
// A11 - authentication downgrade attempts against an account that must use a second factor. MFA enrolment is used here only to build fixtures.
// Password-only access, challenge misuse, omitted / altered claims, legacy token forms, MFA switched off and on again, session carry-over, secrets in logs.
const crypto = require("crypto");
const L = require("./a-lib");
const { P } = L;
const suite = L.createSuite("a11-mfa-downgrade");
const SESS = "/api/lead-agents/admin/session";
const sleep = L.sleep;

async function waitForStep(step) { for (;;) { if (L.totpStep() >= step) return; await sleep(250); } }

suite.run(async (s) => {
  const MFA_KEY = crypto.randomBytes(32).toString("base64");
  const env = { LEAD_AGENTS_MFA: "on", LEAD_AGENTS_MFA_KEY: MFA_KEY, LEAD_AGENTS_MFA_KEY_ID: "k1" };
  const srv = await L.startServer(s, { env });
  const c = new L.Client(srv);
  const SECRET = srv.secrets.sessionSecret;
  const admin = await L.adminSession(c, srv);
  const hz = await c.get("/healthz");
  s.check("A11-001", "MFA is on and ready (fixture precondition)", hz.status === 200 && hz.body.mfa.mode === "on" && hz.body.mfa.schema === "available", hz.body && hz.body.mfa);

  // ---- fixtures -------------------------------------------------------------------------------------------------------------------------------------------------
  const enrol = async (role = "ochiga_staff") => {
    const u = await L.makeUser(c, admin, { role });
    const g = await L.stepUp(c, u, "mfa_management");
    const b = await c.post(`${SESS}/mfa/enroll/totp/begin`, { cookie: u.cookie, stepUp: g.token, json: {} });
    if (b.status !== 200) throw new L.Blocked(`cannot begin TOTP enrolment: ${b.status} ${b.text.slice(0, 160)}`);
    await L.waitForTotpWindow(6000);
    const used = L.totpStep();
    const cf = await c.post(`${SESS}/mfa/enroll/totp/confirm`, { cookie: u.cookie, stepUp: g.token, json: { credential_id: b.body.credential_id, code: L.totp(b.body.secret_base32) } });
    if (cf.status !== 200) throw new L.Blocked(`cannot confirm TOTP enrolment: ${cf.status} ${cf.text.slice(0, 160)}`);
    return { ...u, totpSecret: b.body.secret_base32, credentialId: b.body.credential_id, recovery: cf.body.recovery_codes, mfaCookie: cf.cookie, lastStep: used, preEnrolCookie: u.cookie };
  };
  const [e1, e2, e3, plain] = [await enrol(), await enrol(), await enrol(), await L.makeUser(c, admin, { role: "ochiga_staff" })];
  const verify = (challenge, method, code, o = {}) => c.post(P.mfaVerify, { json: { challenge_token: challenge, method, code }, ...o });
  const challengeFor = async (u, o = {}) => { const r = await L.login(c, u.email, u.password, o); return { r, token: r.body && r.body.challenge_token }; };
  const totpLogin = async (u) => { await waitForStep(u.lastStep + 1); const ch = await challengeFor(u); const code = L.totp(u.totpSecret); const v = await verify(ch.token, "totp", code); u.lastStep = L.totpStep(); return { ch, v, code }; };

  await s.section("password alone never yields authority for an enrolled account", async () => {
    const ch = await challengeFor(e1);
    s.check("A11-010", "correct password for an enrolled account answers 200 mfa_required:true with a challenge", ch.r.status === 200 && ch.r.body.ok === false && ch.r.body.mfa_required === true && ch.token, ch.r.text.slice(0, 200));
    s.check("A11-011", "the challenge answer sets NO cookie", ch.r.setCookies.length === 0 && !ch.r.cookie, ch.r.setCookies);
    s.check("A11-012", "the challenge answer contains no admin object, role, permissions or session fields", !/"admin"|permissions|"role"|session_generation|email/.test(JSON.stringify({ ...ch.r.body, challenge_token: "x" })), Object.keys(ch.r.body));
    s.check("A11-013", "the challenge answer is not cacheable", /no-store/.test(ch.r.headers.get("cache-control") || ""), ch.r.headers.get("cache-control"));
    const wrong = await L.login(c, e1.email, e1.password + "x");
    s.check("A11-014", "a WRONG password for an enrolled account is the ordinary 401 (no challenge, no hint that MFA exists)", wrong.status === 401 && !wrong.body.mfa_required && !wrong.body.challenge_token, wrong.text);
    const unknown = await L.login(c, `ghost-${L.rand(3)}@example.test`, "Whatever-passphrase-1");
    s.check("A11-015", "unknown account and wrong-password answers are byte-identical with MFA on", unknown.text === wrong.text && unknown.status === wrong.status, { unknown: unknown.text, wrong: wrong.text });
    const pl = await L.login(c, plain.email, plain.password);
    s.check("A11-016", "positive control: an account WITHOUT a factor still signs in normally (enrolment is not enforced by default)", pl.status === 200 && pl.cookie, pl.status);
    const plMe = await c.get(P.me, { cookie: pl.cookie });
    s.check("A11-017", "/session/me for the unenrolled account reports mfa enabled but not verified", plMe.body.mfa && plMe.body.mfa.enabled === true && plMe.body.mfa.verified === false, plMe.body && plMe.body.mfa);
    const viaKey = await L.login(c, `fb-${L.rand(3)}@example.test`, srv.secrets.apiKey);
    s.check("A11-018", "API key as password stays refused with MFA on", viaKey.status === 401);
    // the pre-enrolment cookie (password-only) is dead
    s.check("A11-019", "the cookie obtained BEFORE enrolment is refused after enrolment", (await c.get(P.me, { cookie: e1.preEnrolCookie })).status === 401);
    s.check("A11-020", "the cookie re-issued at enrolment (mf=1) works", (await c.get(P.me, { cookie: e1.mfaCookie })).status === 200);
  });

  await s.section("the challenge token is not a credential", async () => {
    const { token } = await challengeFor(e2);
    const targets = [P.me, P.users, P.stepUp, P.password, `${SESS}/mfa`, P.audit, P.settings];
    let n = 0;
    for (const t of targets) {
      const asCookie = await c.call(t === P.stepUp || t === P.password ? "POST" : "GET", t, { cookie: token, ...(t === P.stepUp || t === P.password ? { json: {} } : {}) });
      s.check(`A11-03${n}a`, `challenge token as the session cookie is refused on ${t.split("/").slice(-2).join("/")}`, asCookie.status === 401, asCookie.status);
      const asBearer = await c.call(t === P.stepUp || t === P.password ? "POST" : "GET", t, { bearer: token, ...(t === P.stepUp || t === P.password ? { json: {} } : {}) });
      s.check(`A11-03${n}b`, `challenge token as a Bearer credential is refused on ${t.split("/").slice(-2).join("/")}`, asBearer.status === 401 || asBearer.status === 403, asBearer.status);
      n++;
    }
    const asKey = await c.get(P.users, { apiKey: token });
    s.check("A11-040", "challenge token as an API key is refused", asKey.status === 401);
    const asEdge = await c.get(P.users, { edge: token });
    s.check("A11-041", "challenge token as an edge token is refused", asEdge.status === 401);
    const asStep = await c.post(P.stepUpCheck, { cookie: e2.mfaCookie, stepUp: token, json: { purpose: "mfa_management" } });
    s.check("A11-042", "challenge token as a step-up grant is refused", asStep.status === 403, asStep.status);
    const qs = await c.get(`${P.me}?challenge_token=${token}&token=${token}`);
    s.check("A11-043", "challenge token in a query string grants nothing", qs.status === 401);
    const bodyAuth = await c.post(P.users, { json: { challenge_token: token, email: `z-${L.rand(3)}@example.test`, password: L.STRONG(), role: "super_admin" } });
    s.check("A11-044", "challenge token in a request body authenticates nothing", bodyAuth.status === 401);
  });

  await s.section("verification endpoint: refusals", async () => {
    // every case gets its own freshly enrolled subject, so the per-account failure counter and lock of one case never influence another
    const bad = (r) => r.status === 401 || r.status === 429 || r.status === 400;
    const cases = {
      "wrong code": (u, ch) => verify(ch, "totp", "000000"),
      "code of another account": (u, ch, o) => verify(ch, "totp", L.totp(o.totpSecret)),
      "challenge of another account with this account's code": (u, ch, o, och) => verify(och, "totp", L.totp(u.totpSecret)),
      "missing method": (u, ch) => c.post(P.mfaVerify, { json: { challenge_token: ch, code: L.totp(u.totpSecret) } }),
      "unknown method": (u, ch) => verify(ch, "sms", L.totp(u.totpSecret)),
      "webauthn method with no assertion": (u, ch) => verify(ch, "webauthn", "x"),
      "code as number": (u, ch) => c.post(P.mfaVerify, { json: { challenge_token: ch, method: "totp", code: 123456 } }),
      "code as array": (u, ch) => c.post(P.mfaVerify, { json: { challenge_token: ch, method: "totp", code: ["123456"] } }),
      "code as object": (u, ch) => c.post(P.mfaVerify, { json: { challenge_token: ch, method: "totp", code: { a: 1 } } }),
      "empty code": (u, ch) => verify(ch, "totp", ""),
      "9-digit code": (u, ch) => verify(ch, "totp", "123456789"),
      "recovery code of another account": (u, ch, o) => verify(ch, "recovery_code", o.recovery[0]),
      "garbage recovery code": (u, ch) => verify(ch, "recovery_code", "AAAAA-BBBBB"),
      "empty challenge": (u) => verify("", "totp", L.totp(u.totpSecret)),
      "truncated challenge": (u, ch) => verify(ch.slice(0, ch.length - 6), "totp", L.totp(u.totpSecret)),
      "tampered challenge (payload)": (u, ch) => verify(ch.replace(/^./, (x) => (x === "e" ? "f" : "e")), "totp", L.totp(u.totpSecret)),
      "tampered challenge (signature)": (u, ch) => verify(ch.slice(0, -2) + (ch.endsWith("aa") ? "bb" : "aa"), "totp", L.totp(u.totpSecret)),
      "challenge with extra segment": (u, ch) => verify(ch + ".x", "totp", L.totp(u.totpSecret)),
      "a session cookie as the challenge": (u) => verify(u.mfaCookie, "totp", L.totp(u.totpSecret)),
      "null body": () => c.post(P.mfaVerify, { body: "null", headers: { "content-type": "application/json" } }),
    };
    let n = 0; const answers = [];
    for (const [name, fn] of Object.entries(cases)) {
      const u = await enrol(); const o = await enrol();
      const ch = (await challengeFor(u)).token; const och = (await challengeFor(o)).token;
      const r = await fn(u, ch, o, och);
      answers.push([name, r.status, r.text]);
      s.check(`A11-05${String(n++).padStart(2, "0")}`, `verify with ${name}: refused, no cookie, no 5xx`, bad(r) && !r.cookie && r.setCookies.length === 0, { status: r.status, text: r.text.slice(0, 120) });
    }
    const generic = answers.filter(([n]) => /wrong code|code of another account|challenge of another account|garbage recovery|recovery code of another|truncated|tampered|extra segment|session cookie as/.test(n));
    const uniq = new Set(generic.map(([, st, t]) => `${st}|${t.replace(/"retry_after_seconds":\d+/, "")}`));
    s.check("A11-080", "forged / wrong / foreign / truncated inputs all receive the SAME refusal (no oracle on which part was wrong)", uniq.size === 1, [...uniq]);
  });

  await s.section("full sign-in with a real factor: positive controls", async () => {
    const r = await totpLogin(e1);
    s.check("A11-090", "TOTP completes sign-in (200 ok:true) and sets the cookie", r.v.status === 200 && r.v.body.ok === true && r.v.cookie, r.v.text.slice(0, 200));
    const claims = (L.decodeToken(r.v.cookie) || {}).claims || {};
    s.check("A11-091", "the session carries mf=1 and a verification time (mft) and the usual generation / session id / password fingerprint", claims.mf === 1 && Number.isFinite(claims.mft) && Number.isInteger(claims.sg) && claims.sid && claims.pf, claims);
    const attrs = L.attrsOf(r.v.setCookies[0] || "");
    s.check("A11-092", "cookie attributes are unchanged (HttpOnly, SameSite, Path, Max-Age 168 h)", attrs.httponly === true && /lax|strict/i.test(attrs.samesite || "") && attrs.path === "/" && attrs["max-age"] === "604800", r.v.setCookies);
    s.check("A11-093", "the session works and /session/me reports mfa verified", (await c.get(P.me, { cookie: r.v.cookie })).body.mfa.verified === true);
    s.check("A11-094", "the verified-sign-in response carries no challenge token and no secrets", !/challenge_token|secret|hash/i.test(r.v.text));
    const replay = await verify(r.ch.token, "totp", r.code);
    s.check("A11-095", "the same TOTP code is refused when replayed with the same challenge (replay)", replay.status === 401 && !replay.cookie, replay.status);
    const ch2 = await challengeFor(e1);
    const replay2 = await verify(ch2.token, "totp", r.code);
    s.check("A11-096", "the same TOTP code is refused with a FRESH challenge too (single use per time step)", replay2.status === 401 && !replay2.cookie, replay2.status);
    e1.sessionCookie = r.v.cookie;
  });

  await s.section("claims omitted or altered (secret-holder forgeries prove the policy is enforced in one place)", async () => {
    const base = L.decodeToken(e2.mfaCookie).claims;
    const mint = (over, drop = []) => { const o = { ...base, exp: Date.now() + 3600_000, ...over }; for (const d of drop) delete o[d]; return L.mintToken(SECRET, o); };
    const me = async (t) => c.get(P.me, { cookie: t });
    s.check("A11-100", "harness control: re-signed genuine MFA claims are accepted", (await me(mint({}))).status === 200);
    const noMf = await me(mint({}, ["mf", "mft"]));
    s.check("A11-101", "omitting mf/mft (password-only form) is refused for an enrolled account (401 mfa_required)", noMf.status === 401 && noMf.body.error === "mfa_required", noMf.body);
    for (const [name, over] of [["mf=0", { mf: 0 }], ["mf=true", { mf: true }], ['mf="1"', { mf: "1" }], ["mf=2", { mf: 2 }], ["mf=-1", { mf: -1 }], ["mf=1 without mft", {}], ["mf=1, mft string", { mft: "now" }], ["mf=1, mft null", { mft: null }], ["mf as array", { mf: [1] }], ["mf as object", { mf: { a: 1 } }]]) {
      const tok = name === "mf=1 without mft" ? mint({ mf: 1 }, ["mft"]) : mint(over);
      const r = await me(tok);
      s.check(`A11-102-${name.replace(/\W+/g, "_")}`, `claim form ${name} does not count as a verified second factor`, r.status === 401, r.status);
    }
    const legacy = L.mintToken(SECRET, { email: base.email, role: base.role, user_id: base.user_id, permission_scopes: [], exp: Date.now() + 3600_000 });
    const lr = await me(legacy);
    s.check("A11-110", "a legacy-form token (no sg, pf, sid, mf) is refused for an enrolled account", lr.status === 401, lr.body);
    const legacyUsers = await c.get(P.users, { cookie: legacy });
    s.check("A11-111", "that legacy token reaches no protected route", legacyUsers.status === 401);
    const oldGen = L.mintToken(SECRET, { ...base, sg: 0, exp: Date.now() + 3600_000 });
    s.check("A11-112", "an MFA-claiming token with an older generation is refused", (await me(oldGen)).status === 401);
    const edited = L.tamperPayload(e2.mfaCookie, (c0) => ({ ...c0, mf: 1, mft: Date.now() + 1e6 }));
    s.check("A11-113", "an edited (not re-signed) MFA token is refused", (await me(edited)).status === 401);
    const noPf = await me(mint({}, ["pf"]));
    console.log(`INFO A11 MFA token without pf (password fingerprint) accepted: ${noPf.status === 200}`);
    const plainClaims = L.decodeToken((await L.login(c, plain.email, plain.password)).cookie).claims;
    const forgedForPlain = L.mintToken(SECRET, { ...plainClaims, mf: 1, mft: Date.now(), exp: Date.now() + 3600_000 });
    const fp = await me(forgedForPlain);
    s.check("A11-114", "an mf claim on an account that has no factor grants nothing beyond the ordinary session (live role)", fp.status === 200 && (await c.get(P.users, { cookie: forgedForPlain })).status === 403);
  });

  await s.section("challenge lifetime: password change and revocation kill it", async () => {
    const pw = await L.makeUser(c, admin, { role: "ochiga_staff" });
    // enrol quickly
    const g = await L.stepUp(c, pw, "mfa_management");
    const b = await c.post(`${SESS}/mfa/enroll/totp/begin`, { cookie: pw.cookie, stepUp: g.token, json: {} });
    await L.waitForTotpWindow(6000);
    const cf = await c.post(`${SESS}/mfa/enroll/totp/confirm`, { cookie: pw.cookie, stepUp: g.token, json: { credential_id: b.body.credential_id, code: L.totp(b.body.secret_base32) } });
    pw.mfaCookie = cf.cookie; pw.recovery = cf.body.recovery_codes; pw.totpSecret = b.body.secret_base32; pw.lastStep = L.totpStep();
    const ch = await challengeFor(pw);
    // an administrator resets the password: the pending challenge must die
    const newPw = L.STRONG();
    const setPw = await c.patch(`${P.users}/${pw.id}`, { cookie: admin.cookie, json: { password: newPw } });
    s.check("A11-120", "administrator sets the enrolled member's password (fixture)", setPw.status === 200, setPw.status);
    await waitForStep(pw.lastStep + 1);
    const afterPw = await verify(ch.token, "totp", L.totp(pw.totpSecret));
    s.check("A11-121", "a challenge issued before a password change is refused (mfa_challenge_expired)", afterPw.status === 401 && !afterPw.cookie, afterPw.text);
    pw.password = newPw;
    const ch2 = await challengeFor(pw);
    const fresh = await verify(ch2.token, "recovery_code", pw.recovery[0]);
    s.check("A11-122", "a recovery code completes sign-in (fixture)", fresh.status === 200 && fresh.cookie, fresh.text.slice(0, 160));
    s.check("A11-123", "using a recovery code reports how many remain and never echoes the code", fresh.body.mfa && fresh.body.mfa.recovery_codes_remaining === 9 && !fresh.text.includes(pw.recovery[0]), fresh.body.mfa);
    const reuse = await verify((await challengeFor(pw)).token, "recovery_code", pw.recovery[0]);
    s.check("A11-124", "a recovery code is single use (second use refused)", reuse.status === 401 && !reuse.cookie, reuse.status);
    const ch4 = await challengeFor(pw);
    const second = await verify(ch4.token, "recovery_code", pw.recovery[1]);
    s.check("A11-128", "using a recovery code ends the member's other sessions (the earlier recovery-code session is dead, the new one works)", second.status === 200 && (await c.get(P.me, { cookie: fresh.cookie })).status === 401 && (await c.get(P.me, { cookie: second.cookie })).status === 200);
    const ch3 = await challengeFor(pw);
    const rev = await c.post(`${SESS}/revoke-all`, { cookie: second.cookie, json: {} });
    s.check("A11-125", "the member signs out everywhere (fixture)", rev.status === 200, rev.status);
    const afterRevoke = await verify(ch3.token, "recovery_code", pw.recovery[2]);
    s.check("A11-126", "a challenge issued before a revocation is refused", afterRevoke.status === 401 && !afterRevoke.cookie, afterRevoke.text);
    const cNew = await challengeFor(pw);
    const ok = await verify(cNew.token, "recovery_code", pw.recovery[2]);
    s.check("A11-127", "a fresh challenge after the revocation works with an unused recovery code", ok.status === 200 && ok.cookie, ok.status);
    pw.sessionCookie = ok.cookie;
  });

  await s.section("session continuity keeps the second-factor proof; logout works", async () => {
    const r = await totpLogin(e3);
    const cookie = r.v.cookie;
    const np = L.STRONG();
    const chg = await c.post(P.password, { cookie, json: { current_password: e3.password, new_password: np } });
    s.check("A11-130", "password change from a verified session succeeds", chg.status === 200 && chg.cookie, chg.text.slice(0, 160));
    const cl = (L.decodeToken(chg.cookie) || {}).claims || {};
    s.check("A11-131", "the re-issued cookie keeps mf=1 (no silent downgrade, no re-challenge needed)", cl.mf === 1 && Number.isFinite(cl.mft), cl);
    s.check("A11-132", "the re-issued cookie works", (await c.get(P.me, { cookie: chg.cookie })).status === 200);
    e3.password = np;
    const keep = await c.post(`${SESS}/revoke-all`, { cookie: chg.cookie, json: { keep_current: true } });
    const kc = (L.decodeToken(keep.cookie) || {}).claims || {};
    s.check("A11-133", "revoke-all with keep_current keeps mf=1 on the re-issued cookie", keep.status === 200 && kc.mf === 1, kc);
    const lo = await c.post(P.logout, { cookie: keep.cookie, json: {} });
    s.check("A11-134", "logout of an MFA session revokes it (copied cookie refused)", lo.body.revoked === true && (await c.get(P.me, { cookie: keep.cookie })).status === 401, lo.body);
    const ch = await challengeFor(e3);
    s.check("A11-135", "after the password change the account still requires the second factor", ch.r.body && ch.r.body.mfa_required === true);
    const reset = await c.post(`${P.users}/${e3.id}/reset`, { cookie: admin.cookie, json: {} });
    const rp = L.STRONG();
    await c.post(P.resetConfirm, { json: { token: reset.body.reset_token, new_password: rp } });
    const afterReset = await L.login(c, e3.email, rp);
    s.check("A11-136", "a password reset does not remove the second-factor requirement (login still answers with a challenge)", afterReset.body && afterReset.body.mfa_required === true && !afterReset.cookie, afterReset.text.slice(0, 120));
    const ghost = await c.post(P.resetConfirm, { json: { token: reset.body.reset_token, new_password: rp } });
    s.check("A11-137", "a reset token cannot be reused on an MFA account", ghost.status === 400);
  });

  await s.section("throttling still applies to the second step", async () => {
    const t = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const g = await L.stepUp(c, t, "mfa_management");
    const b = await c.post(`${SESS}/mfa/enroll/totp/begin`, { cookie: t.cookie, stepUp: g.token, json: {} });
    await L.waitForTotpWindow(6000);
    await c.post(`${SESS}/mfa/enroll/totp/confirm`, { cookie: t.cookie, stepUp: g.token, json: { credential_id: b.body.credential_id, code: L.totp(b.body.secret_base32) } });
    const nr = new L.Client(srv, { rotate: false });
    const ch = await L.login(nr, t.email, t.password, { xff: "198.51.100.77" });
    const sts = [];
    for (let i = 0; i < 12; i++) sts.push((await verify(ch.body.challenge_token, "totp", "000000", { xff: "198.51.100.77" })).status);
    s.check("A11-140", "repeated wrong second-factor codes are throttled (a 429 appears within 12 attempts)", sts.includes(429), sts.join(","));
    const stsRot = [];
    const t2 = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const g2 = await L.stepUp(c, t2, "mfa_management");
    const b2 = await c.post(`${SESS}/mfa/enroll/totp/begin`, { cookie: t2.cookie, stepUp: g2.token, json: {} });
    await L.waitForTotpWindow(6000);
    await c.post(`${SESS}/mfa/enroll/totp/confirm`, { cookie: t2.cookie, stepUp: g2.token, json: { credential_id: b2.body.credential_id, code: L.totp(b2.body.secret_base32) } });
    const ch2 = await L.login(nr, t2.email, t2.password, { xff: "198.51.100.78" });
    for (let i = 0; i < 25; i++) stsRot.push((await verify(ch2.body.challenge_token, "totp", "000000", { xff: `203.0.113.${i + 1}` })).status);
    s.check("A11-141", "rotating forged addresses does not allow unlimited wrong codes (account-level lock engages within 25 attempts)", stsRot.includes(429), stsRot.join(","));
    const lockedGood = await verify(ch2.body.challenge_token, "totp", L.totp(b2.body.secret_base32), { xff: "203.0.113.200" });
    s.check("A11-142", "while the account is locked even the CORRECT code is refused (429)", lockedGood.status === 429 && !lockedGood.cookie, lockedGood.status);
    const lockedPw = await L.login(nr, t2.email, t2.password, { xff: "198.51.100.79" });
    s.check("A11-143", "the lock does not leak through the password step (password step still answers a challenge or 429, never a session)", !lockedPw.cookie, lockedPw.status);
  });

  await s.section("MFA switched off and on again (declared downgrade, visibility, no retained downgrade session)", async () => {
    const victim = e2;
    await srv.restart({ LEAD_AGENTS_MFA: "off" });
    const c2 = new L.Client(srv);
    const hzOff = await c2.get("/healthz");
    s.check("A11-150", "with MFA off, /healthz reports the number of enrolled accounts so ignored factors are visible", hzOff.body.mfa.mode === "off" && hzOff.body.mfa.enrolled_accounts >= 3, hzOff.body.mfa);
    const pwOnly = await L.login(c2, victim.email, victim.password);
    console.log(`INFO A11 with MFA off an enrolled account signs in with the password alone (declared downgrade): ${pwOnly.status === 200}`);
    await srv.restart({});
    const c3 = new L.Client(srv);
    const back = await c3.get(P.me, { cookie: pwOnly.cookie });
    s.check("A11-151", "a password-only session obtained while MFA was off is refused once MFA is back on (401 mfa_required)", pwOnly.status !== 200 || (back.status === 401 && back.body.error === "mfa_required"), back.body);
    const again = await L.login(c3, victim.email, victim.password);
    s.check("A11-152", "after MFA is back on the account is challenged again", again.body && again.body.mfa_required === true && !again.cookie);
    await srv.restart({ LEAD_AGENTS_ALLOW_API_KEY_LOGIN: "true" });
    const hzBad = await new L.Client(srv).get("/healthz");
    s.check("A11-154", "MFA on together with the legacy API-key login is a configuration error: /healthz 503 with mfa_enabled_with_api_key_login", hzBad.status === 503 && JSON.stringify(hzBad.body.mfa.problems || []).includes("mfa_enabled_with_api_key_login"), hzBad.body && hzBad.body.mfa);
    const fb = await L.login(new L.Client(srv), `fb-${L.rand(3)}@example.test`, srv.secrets.apiKey);
    s.check("A11-155", "in that state the API-key-as-password path still cannot mint a session (no second-factor bypass)", fb.status !== 200 && !fb.cookie, fb.status);
    await srv.restart({});
  });

  await s.section("invalid MFA configuration fails closed for enrolled accounts", async () => {
    await srv.restart({ LEAD_AGENTS_MFA_KEY: crypto.randomBytes(32).toString("base64") });
    const c4 = new L.Client(srv);
    const hz4 = await c4.get("/healthz");
    const lg = await L.login(c4, e2.email, e2.password);
    s.check("A11-160", "with a different MFA key the enrolled account is NOT signed in with the password alone (503 or challenge, never a session)", !lg.cookie, { health: hz4.status, login: lg.status, body: lg.text.slice(0, 120) });
    await srv.restart({ LEAD_AGENTS_MFA_KEY: "short" });
    const c5 = new L.Client(srv);
    const hz5 = await c5.get("/healthz");
    s.check("A11-161", "an invalid MFA key makes /healthz 503", hz5.status === 503 && hz5.body.mfa.key === "invalid", hz5.body && hz5.body.mfa);
    const lg5 = await L.login(c5, e2.email, e2.password);
    s.check("A11-162", "with an invalid MFA key the enrolled account gets 503 (fail closed), never a password-only session", lg5.status === 503 && !lg5.cookie, lg5.status + " " + lg5.text.slice(0, 120));
    const lgPlain = await L.login(c5, plain.email, plain.password);
    console.log(`INFO A11 with an invalid MFA key an unenrolled account signs in: ${lgPlain.status === 200}`);
    await srv.restart({ LEAD_AGENTS_MFA_KEY: undefined });
    const c6 = new L.Client(srv);
    const lg6 = await L.login(c6, e2.email, e2.password);
    s.check("A11-164", "with the MFA key missing the enrolled account is not signed in by password alone", !lg6.cookie, lg6.status);
    await srv.restart({});
  });

  await s.section("secrets", async () => {
    const adminAudit = (await c.get(P.audit, { cookie: (await L.adminSession(c, srv)).cookie })).text;
    const needles = { mfaKey: MFA_KEY, totp1: e1.totpSecret, totp2: e2.totpSecret, totp3: e3.totpSecret, sessionSecret: SECRET, rec1: e1.recovery[0], rec2: e2.recovery[3], rec3: e3.recovery[5] };
    s.check("A11-170", "audit records contain no MFA key, TOTP secret or recovery code", L.findLeaks(adminAudit, needles).length === 0, L.findLeaks(adminAudit, needles));
    s.check("A11-171", "the server log contains no MFA key, TOTP secret, recovery code, challenge or session secret", L.findLeaks(srv.logs(), needles).length === 0, L.findLeaks(srv.logs(), needles));
    const store = L.readStore(srv);
    const dump = JSON.stringify(store.admin_mfa_credentials || []) + JSON.stringify(store.admin_mfa_recovery_codes || []);
    s.check("A11-172", "stored MFA records hold no plaintext TOTP secret and no plaintext recovery code", L.findLeaks(dump, { totp1: e1.totpSecret, totp2: e2.totpSecret, rec1: e1.recovery[0], rec2: e2.recovery[3], rec3: e3.recovery[5] }).length === 0);
    s.check("A11-173", "stored MFA records do not contain the MFA key", !dump.includes(MFA_KEY));
    const users = (await c.get(P.users, { apiKey: srv.secrets.apiKey })).text;
    s.check("A11-174", "the account list exposes no MFA material", !/secret_base32|totp_secret|recovery_code|otpauth|key_id|password_hash/i.test(users) && !/"mfa_(secret|credential|key|recovery)/i.test(users), (users.match(/.{20}(secret_base32|totp_secret|recovery_code|otpauth|key_id|password_hash|"mfa_\w+).{20}/i) || [""])[0]);
    const mfaStatus = await c.get(`${SESS}/mfa`, { cookie: (await L.login(c, plain.email, plain.password)).cookie });
    s.check("A11-175", "the MFA status endpoint exposes no secret material", !/secret_base32|otpauth|recovery_codes"/.test(mfaStatus.text), mfaStatus.text.slice(0, 160));
  });


  await s.section("step-up does not accept recovery codes", async () => {
    const u = await enrol();
    const r = await c.post(P.stepUp, { cookie: u.mfaCookie, json: { password: u.password, purpose: "mfa_management", mfa: { method: "recovery_code", code: u.recovery[0] } } });
    s.check("A11-180", "a recovery code is never recorded as the second factor of a step-up grant (a fresh MFA session may still earn one by session proof)", !(r.body && r.body.step_up && r.body.step_up.second_factor === "recovery_code"), r.status + " " + r.text.slice(0, 120));
    const w = await c.post(P.stepUp, { cookie: u.mfaCookie, json: { password: u.password, purpose: "mfa_management", mfa: { method: "recovery_code", code: u.recovery[1] } }, xff: "10.1.1.1" });
    s.check("A11-181", "the recovery codes are still unused afterwards (not consumed by the refused step-up)", true === (await verify((await challengeFor(u)).token, "recovery_code", u.recovery[0])).body.ok);
    void w;
  });

  s.check("A11-999", "server alive at the end of the suite", srv.alive());
});
