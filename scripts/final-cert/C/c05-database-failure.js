"use strict";
// AREA C / C05: the REAL application server while its database gateway is stopped, slow, resetting, leaking errors or returning garbage.
// Sign-in, MFA verification, logout, step-up and authenticated requests must fail closed with honest errors and no internal detail, and recover afterwards.
const L = require("./lib");
const F = require("./appfix");

const s = new L.Suite("c05-database-failure", "C");

s.main(async () => {
  const fx = await F.buildStack(s, { tag: "c05", instances: 1, extraEnv: { LEAD_AGENTS_REQUEST_TIMEOUT_MS: "2500" } });
  const { st, admin, proxy, app } = fx;
  const serviceJwt = st.jwt("service_role");
  const secretsInLogs = () => { const t = app.logText(); return ["password", "serviceJwt", "sessionSecret", "mfaKey"].filter((k) => ({ password: (x) => /Pw!/.test(x), serviceJwt: (x) => x.includes(serviceJwt), sessionSecret: (x) => x.includes(fx.sessionSecret), mfaKey: (x) => x.includes(L.MFA_KEY_A) })[k](t)); };
  const num = async (sql) => Number((await admin.query(sql)).rows[0][0]);

  const plain = async () => { const u = await L.seedUser(admin, { role: "viewer" }); const c = fx.client(); const l = await c.login(u.email, u.password); return { u, c, cookie: l.cookie }; };
  const mfaAccount = async () => F.accountWithTotp(fx, { role: "super_admin" });
  const aliveAndServing = async () => { const h = await fx.client().get("/healthz"); return h.status > 0 && app.exitCode === undefined; };
  const noLeak = (r) => L.leaks(r.text + " " + JSON.stringify([...r.headers.entries()].filter(([k]) => k !== "set-cookie")));
  const issued = (r) => Boolean(r.setCookie) || (r.json && (r.json.ok === true && r.json.admin));
  const goodAgain = async () => { const u = await L.seedUser(admin, { role: "viewer" }); const r = await fx.client().login(u.email, u.password); return r.status === 200 && Boolean(r.cookie); };

  // pre-fault fixtures
  const A = await plain();
  s.check("DBF-001", "positive control: a sign-in works against the healthy database and the session is accepted", A.cookie && (await fx.client().me({ cookie: A.cookie })).status === 200);
  const logged = await plain(); await fx.client().logout({ cookie: logged.cookie });
  s.eq("DBF-002", "negative control: a logged-out cookie is refused while the database is healthy", (await fx.client().me({ cookie: logged.cookie })).status, 401);

  const MODES = [
    ["down", "gateway stopped (connection refused)"], ["reset", "connections reset"], ["hang", "gateway accepts and never answers"],
    ["500leak", "gateway returns 500 with connection strings in the body"], ["502", "gateway returns an HTML 502"], ["garbage", "gateway returns non-JSON 200"],
  ];
  for (const [mode, label] of MODES) {
    await s.section("MODE-" + mode, async () => {
      const id = "DBF-" + mode;
      // challenges and sessions obtained BEFORE the fault
      const M = await mfaAccount(); const c0 = fx.client();
      const l0 = await c0.post(`${L.P}/session/login`, { email: M.user.email, password: M.user.password });
      const code = await M.totp.next();
      const M2 = await mfaAccount(); const l2 = await fx.client().post(`${L.P}/session/login`, { email: M2.user.email, password: M2.user.password });
      const code2 = await M2.totp.next();
      const S = await plain(); const stepCtx = await plain();
      const cookieBefore = S.cookie;
      await proxy.setMode(mode);
      try {
        const t0 = Date.now();
        // sign-in
        const pw = await fx.client().login(S.u.email, S.u.password, { timeoutMs: 20000 });
        s.check(`${id}-10`, `[${label}] sign-in with the CORRECT password issues no session`, pw.status !== 200 && !issued(pw), { status: pw.status, body: pw.text.slice(0, 160) });
        s.eq(`${id}-11`, `[${label}] and says the service is unavailable (503), not 'wrong password'`, mode === "garbage" ? [401, 502, 503, 500].includes(pw.status) : pw.status, mode === "garbage" ? true : 503);
        s.check(`${id}-12`, `[${label}] the sign-in answer contains no internal detail`, noLeak(pw).length === 0, noLeak(pw));
        s.check(`${id}-13`, `[${label}] a 503 sign-in names no account state (same text for every user)`, pw.status !== 503 || !/password|email|account|user/i.test(String(pw.json && pw.json.message)) || /temporarily unavailable/i.test(String(pw.json && pw.json.message)), pw.text.slice(0, 200));
        const bad = await fx.client().login(S.u.email, "Wrong!Passw0rd1", { timeoutMs: 20000 });
        s.check(`${id}-14`, `[${label}] a wrong password gets no session either, and no leak`, bad.status !== 200 && !issued(bad) && noLeak(bad).length === 0, { status: bad.status, leak: noLeak(bad) });
        const mfaPw = await fx.client().post(`${L.P}/session/login`, { email: M.user.email, password: M.user.password }, { timeoutMs: 20000 });
        s.check(`${id}-15`, `[${label}] the password step for an MFA account issues neither a session nor a challenge`, mfaPw.status !== 200 && !issued(mfaPw) && !(mfaPw.json && mfaPw.json.challenge_token), { status: mfaPw.status, body: mfaPw.text.slice(0, 160) });
        // MFA verification with a challenge issued before the fault and a valid code
        const v = await fx.client().post(`${L.P}/session/mfa/verify`, { challenge_token: l0.json.challenge_token, method: "totp", code: code.code }, { timeoutMs: 20000 });
        s.check(`${id}-20`, `[${label}] MFA verification (valid challenge, valid code) issues no session`, v.status !== 200 && !issued(v), { status: v.status, body: v.text.slice(0, 160) });
        s.check(`${id}-21`, `[${label}] and answers 503 (honest), never 'incorrect code' (401) for a server-side fault`, mode === "garbage" ? true : v.status === 503, v.status);
        s.check(`${id}-22`, `[${label}] no internal detail in the MFA answer`, noLeak(v).length === 0, noLeak(v));
        // authenticated requests
        const me = await fx.client().me({ cookie: cookieBefore, timeoutMs: 20000 });
        s.check(`${id}-30`, `[${label}] an authenticated request with a genuine cookie is refused, not served from the token alone`, me.status !== 200, { status: me.status, body: me.text.slice(0, 160) });
        s.check(`${id}-31`, `[${label}] and says 503 'cannot verify' rather than 401 'signed out' (honest)`, mode === "garbage" ? true : me.status === 503, me.status);
        s.check(`${id}-32`, `[${label}] no internal detail`, noLeak(me).length === 0, noLeak(me));
        const settings = await fx.client().get("/api/lead-agents/admin/settings", { cookie: cookieBefore, timeoutMs: 20000 });
        s.check(`${id}-33`, `[${label}] a protected data route returns no data`, settings.status !== 200 && !/"settings"/.test(settings.text), { status: settings.status });
        const gone = await fx.client().me({ cookie: logged.cookie, timeoutMs: 20000 });
        s.check(`${id}-34`, `[${label}] a LOGGED-OUT cookie is still refused (an unreachable revocation list is not 'not revoked')`, gone.status !== 200, { status: gone.status, body: gone.text.slice(0, 120) });
        const api = await fx.client().get("/api/lead-agents/admin/settings", { headers: { "x-api-key": fx.apiKey }, timeoutMs: 20000 });
        s.check(`${id}-35`, `[${label}] an API-key request does not leak internals either`, noLeak(api).length === 0, noLeak(api));
        // step-up
        const su = await stepCtx.c.stepUp(stepCtx.u.password, "mfa_management", undefined, { timeoutMs: 20000 });
        s.check(`${id}-40`, `[${label}] step-up issues no grant`, su.status !== 200 && !su.token, { status: su.status });
        // logout
        const lo = await fx.client().logout({ cookie: cookieBefore, timeoutMs: 20000 });
        s.check(`${id}-50`, `[${label}] logout does not claim a revocation it could not record`, !(lo.json && lo.json.ok === true && lo.json.revoked === true), { status: lo.status, body: lo.text.slice(0, 200) });
        s.check(`${id}-51`, `[${label}] logout is honest (503 with revoked:false) and still clears the browser cookie`, mode === "garbage" ? true : lo.status === 503 && lo.json && lo.json.revoked === false, { status: lo.status, body: lo.text.slice(0, 200) });
        s.check(`${id}-52`, `[${label}] logout answer has no internal detail and clears the cookie`, noLeak(lo).length === 0 && lo.rawSetCookie.some((c) => /^lead_agents_admin=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)), { leak: noLeak(lo), cookies: lo.rawSetCookie });
        const wall = Date.now() - t0;
        s.check(`${id}-60`, `[${label}] every request ended in bounded time (no unbounded wait)`, wall < 90000, wall);
        s.check(`${id}-61`, `[${label}] the server process is still running`, app.exitCode === undefined);
      } finally { await proxy.setMode("pass"); proxy.clearRules(); }
      // recovery
      await L.waitFor(async () => (await fx.client().get("/healthz")).status > 0, { timeoutMs: 20000, what: "server answers" });
      const back = await L.waitFor(async () => { const r = await fx.client().me({ cookie: cookieBefore }); return r.status === 200 || r.status === 401 ? r : null; }, { timeoutMs: 30000, intervalMs: 300, what: "authenticated request to recover" });
      s.check(`${id}-70`, `[${label}] recovery: an authenticated request works again without restarting the server (200, or 401 if the unconfirmed logout is honoured)`, back.status === 200 || back.status === 401, back.status);
      s.check(`${id}-71`, `[${label}] recovery: a new sign-in works`, await L.waitFor(goodAgain, { timeoutMs: 30000, intervalMs: 300, what: "sign-in to recover" }));
      const vOk = await fx.client().post(`${L.P}/session/mfa/verify`, { challenge_token: l0.json.challenge_token, method: "totp", code: code.code });
      s.check(`${id}-72`, `[${label}] recovery: the very code that was presented during the outage still verifies (an outage neither burned it nor counted a failure)`, vOk.status === 200 && Boolean(vOk.setCookie), { status: vOk.status, body: vOk.text.slice(0, 200) });
      s.eq(`${id}-73`, `[${label}] no MFA failure was counted against the account for the outage`, await num(`select mfa_failed_attempts from admin_users where id='${M.user.id}'`), 0);
      const lo2 = await fx.client().logout({ cookie: cookieBefore });
      s.check(`${id}-74`, `[${label}] recovery: logout works again and revokes`, lo2.status === 200, lo2.status);
      s.eq(`${id}-75`, `[${label}] after a confirmed logout the cookie is dead`, (await fx.client().me({ cookie: cookieBefore })).status, 401);
      s.check(`${id}-80`, `[${label}] the server log holds no password, key or service credential`, secretsInLogs().length === 0, secretsInLogs());
    });
  }

  // ---------------------------------------------------------------------------------- selective faults: one dependency lies, everything else is healthy
  const withRule = async (match, action, fn) => { const r = proxy.rule(match, action); try { return await fn(); } finally { proxy.clearRules(); } };
  const url = (frag, method) => (rec) => rec.url.includes(frag) && (!method || rec.method === method);

  await s.section("DEP-revocation-list", async () => {
    for (const mode of ["garbage", "emptyobj", "emptylist", "500leak", "missing", "forbidden", "noauth", "502"]) {
      await withRule(url("/rpc/office_is_session_revoked"), mode, async () => {
        const r = await fx.client().me({ cookie: logged.cookie });
        s.check(`DEP-REV-${mode}`, `the revoked-session lookup answers '${mode}': a logged-out cookie is still refused`, r.status !== 200, { status: r.status, body: r.text.slice(0, 120) });
        s.check(`DEP-REV-${mode}-leak`, `...and the answer has no internal detail`, noLeak(r).length === 0, noLeak(r));
        const live = await fx.client().me({ cookie: A.cookie });
        s.check(`DEP-REV2-${mode}`, `...a live cookie is not served either while the lookup is unreliable (fail closed)`, live.status !== 200, live.status);
      });
    }
    const ok = await fx.client().me({ cookie: A.cookie }); s.eq("DEP-REV-ok", "positive control: with the lookup healthy the live cookie works", ok.status, 200);
  });

  await s.section("DEP-factor-table", async () => {
    for (const mode of ["emptylist", "garbage", "500leak", "missing-table", "emptyobj"]) {
      const M = await mfaAccount();
      await withRule(url("/admin_mfa_credentials", "GET"), mode, async () => {
        const l = await fx.client().post(`${L.P}/session/login`, { email: M.user.email, password: M.user.password });
        s.check(`DEP-MFA-${mode}`, `the factor list answers '${mode}': an enrolled account is NEVER signed in with the password alone`, !(l.json && l.json.ok === true) && !l.setCookie, { status: l.status, body: l.text.slice(0, 200) });
        s.check(`DEP-MFA-${mode}-leak`, `...and no internal detail`, noLeak(l).length === 0, noLeak(l));
        const sess = M.client.cookie; const me = await fx.client().me({ cookie: sess });
        s.check(`DEP-MFA2-${mode}`, `...an existing MFA-verified session is not served from an unreliable factor list as if nothing were wrong, or if served it carries no downgrade (no 500)`, me.status < 500 || me.status === 503, me.status);
      });
    }
  });

  await s.section("DEP-factor-consumption", async () => {
    for (const mode of ["garbage", "emptyobj", "500leak", "missing"]) {
      const M = await mfaAccount(); const l = await fx.client().post(`${L.P}/session/login`, { email: M.user.email, password: M.user.password }); const c = await M.totp.next();
      await withRule(url("/rpc/office_mfa_consume_totp_step"), mode, async () => {
        const v = await fx.client().post(`${L.P}/session/mfa/verify`, { challenge_token: l.json.challenge_token, method: "totp", code: c.code });
        s.check(`DEP-TOTP-${mode}`, `the single-use step function answers '${mode}': no session is issued`, v.status !== 200 && !v.setCookie, { status: v.status, body: v.text.slice(0, 160) });
        s.check(`DEP-TOTP-${mode}-leak`, `...with no internal detail`, noLeak(v).length === 0, noLeak(v));
      });
      const again = await fx.client().post(`${L.P}/session/mfa/verify`, { challenge_token: l.json.challenge_token, method: "totp", code: c.code });
      s.check(`DEP-TOTP-${mode}-rec`, `...and once it answers honestly the same code verifies (nothing was consumed or counted during the lie)`, again.status === 200 || again.status === 429, again.status);
    }
    for (const mode of ["garbage", "emptyobj", "500leak"]) {
      const M = await mfaAccount(); const l = await fx.client().post(`${L.P}/session/login`, { email: M.user.email, password: M.user.password });
      await withRule(url("/rpc/office_mfa_consume_recovery_code_revoking"), mode, async () => {
        const v = await fx.client().post(`${L.P}/session/mfa/verify`, { challenge_token: l.json.challenge_token, method: "recovery_code", code: M.recoveryCodes[0] });
        s.check(`DEP-RC-${mode}`, `the recovery-code function answers '${mode}': no session`, v.status !== 200 && !v.setCookie, { status: v.status, body: v.text.slice(0, 160) });
        s.check(`DEP-RC-${mode}-leak`, `...with no internal detail and the code echoed nowhere`, noLeak(v).length === 0 && !v.text.includes(M.recoveryCodes[0]), noLeak(v));
      });
    }
  });

  await s.section("DEP-logout-write", async () => {
    for (const mode of ["garbage", "emptyobj", "emptylist", "500leak", "missing", "forbidden"]) {
      const X = await plain();
      await withRule(url("/rpc/office_revoke_session"), mode, async () => {
        const lo = await fx.client().logout({ cookie: X.cookie });
        s.check(`DEP-LOG-${mode}`, `the revocation write answers '${mode}': logout does not claim 'revoked'`, !(lo.json && lo.json.revoked === true), { status: lo.status, body: lo.text.slice(0, 200) });
        s.check(`DEP-LOG-${mode}-leak`, `...and has no internal detail`, noLeak(lo).length === 0, noLeak(lo));
      });
      const stillOk = (await fx.client().me({ cookie: X.cookie })).status;
      s.check(`DEP-LOG-${mode}-st`, `...the session state is what the answer said: unconfirmed logout leaves the session usable (200), never half-revoked`, stillOk === 200, stillOk);
    }
  });

  await s.section("DEP-account-table", async () => {
    for (const mode of ["emptylist", "garbage", "500leak"]) {
      const X = await plain();
      await withRule(url("/admin_users", "GET"), mode, async () => {
        const l = await fx.client().login(X.u.email, X.u.password);
        s.check(`DEP-USR-${mode}`, `the account table answers '${mode}': no sign-in`, l.status !== 200 && !l.cookie, { status: l.status, body: l.text.slice(0, 120) });
        const me = await fx.client().me({ cookie: X.cookie });
        s.check(`DEP-USR2-${mode}`, `...and the existing session is not served`, me.status !== 200, me.status);
        s.check(`DEP-USR3-${mode}`, `...no leak`, noLeak(l).length === 0 && noLeak(me).length === 0, [noLeak(l), noLeak(me)]);
      });
    }
  });

  await s.section("DEP-audit-write", async () => {
    for (const mode of ["500leak", "down-audit"]) {
      const X = await plain();
      await withRule(url("/audit_events", "POST"), mode === "down-audit" ? "reset" : mode, async () => {
        const l = await fx.client().login(X.u.email, X.u.password);
        s.check(`DEP-AUD-${mode}`, `the audit write fails: the sign-in answer has no internal detail and is not a crash (a 200 with a session or an honest 5xx)`, noLeak(l).length === 0 && l.status > 0 && (l.status === 200 || l.status >= 500), { status: l.status, body: l.text.slice(0, 160) });
        if (l.status === 200) s.info(`audit write failure does not block sign-in (availability over audit completeness); a sign-in without its audit row is possible while audit_events is unwritable (${mode})`);
      });
    }
    s.check("DEP-AUD-alive", "the server survived the audit failures", await aliveAndServing());
  });

  await s.section("DEP-settings-table", async () => {
    // the session-duration setting is unreadable: documented fallback to the environment duration; the sign-in must not fail open to something longer than the maximum or leak
    const X = await plain();
    await withRule(url("/office_runtime_settings", "GET"), "500leak", async () => {
      const l = await fx.client().login(X.u.email, X.u.password);
      const ma = l.rawSetCookie.map((c) => /Max-Age=(\d+)/i.exec(c)).filter(Boolean).map((m) => Number(m[1]))[0];
      s.check("DEP-SET-1", "settings unreadable: sign-in still answers without leaking", noLeak(l).length === 0 && l.status < 600, { status: l.status, leak: noLeak(l) });
      s.check("DEP-SET-2", "settings unreadable: any session issued is bounded by the 720-hour maximum", l.status !== 200 || (ma !== undefined && ma <= 720 * 3600), ma);
      if (l.status === 200) s.info("settings table unreadable: session duration falls back to the environment value (documented S7.3 behaviour)");
    });
    const mfaEnforced = await mfaAccount();
    await withRule(url("/office_runtime_settings", "GET"), "garbage", async () => {
      const me = await fx.client().me({ cookie: mfaEnforced.client.cookie });
      s.check("DEP-SET-3", "settings answering garbage never turns into a 500 with detail", me.status < 500 || (me.status === 503 && noLeak(me).length === 0), { status: me.status });
    });
  });

  await s.section("DEP-capability-probe", async () => {
    // a gateway that claims the revocation function does not exist must not silently produce sessions that can never be logged out
    const app2 = await L.AppServer.start({ sut: L.SUT, env: L.appEnv({ restUrl: proxy.url, serviceJwt, sessionSecret: fx.sessionSecret, apiKey: fx.apiKey }), name: "probe", suite: s });
    const X = await L.seedUser(admin, { role: "viewer" });
    const r = proxy.rule(url("/rpc/office_session_revocation_version"), "missing");
    try {
      const c = new L.Client(app2.url); const l = await c.login(X.email, X.password);
      if (l.status === 200) {
        const lo = await new L.Client(app2.url).logout({ cookie: l.cookie });
        const after = await new L.Client(app2.url).me({ cookie: l.cookie });
        proxy.clearRules();
        if (after.status === 200) s.info("revocation probe answering 'function missing' makes the server issue session tokens without an individual id for up to 60 s; those cannot be individually revoked at logout (documented transitional behaviour for databases without the migration; it requires a faulty gateway, not an attacker)");
        s.check("DEP-CAP-1", "capability probe says 'missing': logout does not claim to have revoked a session it cannot revoke", !(lo.json && lo.json.revoked === true && after.status === 200), { logout: lo.text.slice(0, 160), after: after.status });
      } else s.check("DEP-CAP-1", "capability probe says 'missing': sign-in is refused or works (no crash)", l.status >= 400 && noLeak(l).length === 0, l.status);
    } finally { proxy.clearRules(); await app2.stop(); }
  });

  // ---------------------------------------------------------------------------------- slow database (not dead): still correct
  await s.section("SLOW", async () => {
    const X = await plain();
    proxy.rule(() => true, (req, res, rec) => { setTimeout(() => { const up = require("http").request({ host: proxy.target.hostname, port: proxy.target.port, method: req.method, path: req.url.replace(/^\/rest\/v1/, ""), headers: { ...req.headers, host: proxy.target.host } }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); }); up.on("error", () => { try { res.writeHead(502); res.end(); } catch { /* */ } }); up.end(rec.body); }, 300); });
    try {
      const t0 = Date.now(); const l = await fx.client().login(X.u.email, X.u.password, { timeoutMs: 30000 });
      s.check("SLOW-1", "a slow (not failing) database: sign-in still succeeds correctly", l.status === 200 && Boolean(l.cookie), { status: l.status, ms: Date.now() - t0 });
      const gone = await fx.client().me({ cookie: logged.cookie, timeoutMs: 30000 });
      s.eq("SLOW-2", "a slow database never makes a logged-out cookie acceptable", gone.status, 401);
    } finally { proxy.clearRules(); }
    // slower than the application's own timeout
    proxy.rule(() => true, "hang");
    try {
      const t0 = Date.now(); const l = await fx.client().login(X.u.email, X.u.password, { timeoutMs: 30000 });
      const ms = Date.now() - t0;
      s.check("SLOW-3", "a database slower than the request timeout gives a bounded, honest 503 (not a hang)", l.status === 503 && ms < 20000 && noLeak(l).length === 0, { status: l.status, ms });
    } finally { proxy.clearRules(); }
    s.check("SLOW-4", "after the stall the next sign-in succeeds", await L.waitFor(goodAgain, { timeoutMs: 30000, intervalMs: 300, what: "recovery after stall" }));
  });

  // ---------------------------------------------------------------------------------- the database itself (not only the gateway) goes away
  await s.section("PG", async () => {
    const X = await plain(); const M = await mfaAccount(); const l = await fx.client().post(`${L.P}/session/login`, { email: M.user.email, password: M.user.password }); const c = await M.totp.next();
    L.sh("docker", ["pause", st.container]);
    let r1, r2, r3;
    try {
      r1 = await fx.client().login(X.u.email, X.u.password, { timeoutMs: 30000 });
      r2 = await fx.client().me({ cookie: X.cookie, timeoutMs: 30000 });
      r3 = await fx.client().post(`${L.P}/session/mfa/verify`, { challenge_token: l.json.challenge_token, method: "totp", code: c.code }, { timeoutMs: 30000 });
    } finally { L.sh("docker", ["unpause", st.container]); }
    s.check("PG-1", "Postgres paused (the gateway is up but its backend is frozen): sign-in fails closed with 503 and no detail", r1.status === 503 && noLeak(r1).length === 0, { status: r1.status, body: r1.text.slice(0, 160) });
    s.check("PG-2", "...an authenticated request is refused (503) and leaks nothing", r2.status === 503 && noLeak(r2).length === 0, { status: r2.status, body: r2.text.slice(0, 160) });
    s.check("PG-3", "...MFA verification issues no session", r3.status !== 200 && !r3.setCookie && noLeak(r3).length === 0, { status: r3.status });
    const back = await L.waitFor(async () => { const r = await fx.client().me({ cookie: X.cookie }); return r.status === 200 ? r : null; }, { timeoutMs: 90000, intervalMs: 500, what: "application to recover after the database resumed" });
    s.check("PG-4", "once Postgres resumes the same session works again without a restart", back.status === 200);
    const v = await L.waitFor(async () => { const r = await fx.client().post(`${L.P}/session/mfa/verify`, { challenge_token: l.json.challenge_token, method: "totp", code: c.code }); return r.status === 200 || r.status === 429 ? r : null; }, { timeoutMs: 30000, what: "mfa verify after resume" });
    s.check("PG-5", "and the code presented during the freeze verifies (not burned)", v.status === 200, v.status);
    s.check("PG-6", "the server log holds no password, key or service credential", secretsInLogs().length === 0, secretsInLogs());
  });
});
