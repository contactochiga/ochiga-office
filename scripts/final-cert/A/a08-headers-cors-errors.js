"use strict";
// A08 - CORS, cache and security headers on authentication surfaces, error handling and information leakage, path / method oddities, malformed bodies on every
// authenticated mutation route, public-route boundary.
const L = require("./a-lib");
const { P } = L;
const suite = L.createSuite("a08-headers-cors-errors");
const SESS = "/api/lead-agents/admin/session";
const LEAK_RE = /(TypeError|ReferenceError|RangeError|SyntaxError|URIError|Cannot read propert|is not a function|is not defined|Invalid time value|URI malformed|\bat [\w.<>$ ]+ \(|node_modules|\/Users\/|\/var\/folders|ECONN|ENOENT|EACCES|stack)/;
const noStore = (r) => /no-store/.test((r.headers.get("cache-control") || "").toLowerCase());

suite.run(async (s) => {
  const ORIGIN = "https://office.example.test";
  const srv = await L.startServer(s, { env: { LEAD_AGENTS_ALLOWED_ORIGINS: ORIGIN } });
  const c = new L.Client(srv);
  const admin = await L.adminSession(c, srv);
  const staff = await L.makeUser(c, admin, { role: "ochiga_staff" });

  await s.section("CORS with a configured allow-list", async () => {
    const pre = await c.call("OPTIONS", P.login, { headers: { origin: ORIGIN, "access-control-request-method": "POST" } });
    s.check("A08-001", "preflight from the allowed origin is 204", pre.status === 204, pre.status);
    s.check("A08-002", "preflight echoes exactly the allowed origin (never *) with credentials allowed", pre.headers.get("access-control-allow-origin") === ORIGIN && pre.headers.get("access-control-allow-credentials") === "true", Object.fromEntries(pre.headers));
    s.check("A08-003", "responses vary on Origin", /origin/i.test(pre.headers.get("vary") || ""), pre.headers.get("vary"));
    const evil = ["https://evil.example", "null", "http://office.example.test", "https://office.example.test:8443", "https://office.example.test.evil.example", "https://evil.example/https://office.example.test", "https://OFFICE.example.test", "https://office.example.test@evil.example", "file://", "https://office.example.test.", ""];
    let n = 0;
    for (const o of evil) {
      if (o === "") continue;
      const login = await c.post(P.login, { json: { email: staff.email, password: staff.password }, headers: { origin: o } });
      s.check(`A08-01${n}a`, `login from disallowed Origin "${o}" is refused (403) and signs nobody in`, login.status === 403 && !login.cookie && !login.headers.get("access-control-allow-origin"), { status: login.status, acao: login.headers.get("access-control-allow-origin") });
      const pf = await c.call("OPTIONS", P.login, { headers: { origin: o, "access-control-request-method": "POST" } });
      s.check(`A08-01${n}b`, `preflight from disallowed Origin "${o}" is refused (403) without CORS grant headers`, pf.status === 403 && !pf.headers.get("access-control-allow-origin"), { status: pf.status, acao: pf.headers.get("access-control-allow-origin") });
      n++;
    }
    const me = await c.get(P.me, { cookie: staff.cookie, headers: { origin: "https://evil.example" } });
    s.check("A08-030", "an authenticated read from a disallowed origin is refused before any data is returned", me.status === 403 && !/staff|email/.test(me.text), me.status);
    const mutation = await c.post(`${SESS}/revoke-all`, { cookie: staff.cookie, json: {}, headers: { origin: "https://evil.example" } });
    s.check("A08-031", "a state-changing request from a disallowed origin does not execute (session still valid)", mutation.status === 403 && (await c.get(P.me, { cookie: staff.cookie })).status === 200, mutation.status);
    const noOrigin = await L.login(c, staff.email, staff.password);
    s.check("A08-032", "positive control: a request without an Origin header (same-origin tools) is served", noOrigin.status === 200);
    const allowed = await c.post(P.login, { json: { email: staff.email, password: staff.password }, headers: { origin: ORIGIN } });
    s.check("A08-033", "positive control: login from the allowed origin works and gets matching CORS headers", allowed.status === 200 && allowed.headers.get("access-control-allow-origin") === ORIGIN);
    const methods = pre.headers.get("access-control-allow-methods") || "";
    s.check("A08-034", "CORS allowed methods do not include TRACE/CONNECT/PUT-all wildcard", !/\*|TRACE|CONNECT/i.test(methods), methods);
    const hdrs = (pre.headers.get("access-control-allow-headers") || "").toLowerCase();
    s.check("A08-035", "CORS allowed headers are an explicit list (no wildcard)", hdrs && !hdrs.includes("*"), hdrs);
    s.check("A08-036", "an Origin that matches the Host header (same-origin) is accepted for the request", (await c.get(P.me, { cookie: staff.cookie, headers: { origin: srv.base } })).status === 200);
  });

  await s.section("CORS with NO allow-list configured (default)", async () => {
    const d = await L.startServer(s, { env: { LEAD_AGENTS_ALLOWED_ORIGINS: undefined } });
    const cd = new L.Client(d); const adm = await L.adminSession(cd, d);
    const r = await cd.post(P.login, { json: { email: d.secrets.adminEmail, password: d.secrets.adminPassword }, headers: { origin: "https://evil.example" } });
    const acao = r.headers.get("access-control-allow-origin"); const acac = r.headers.get("access-control-allow-credentials");
    s.check("A08-040", "with no allow-list, a foreign origin does not receive credentialed CORS access to the sign-in API (no ACAO echo together with allow-credentials)", !(acao === "https://evil.example" && acac === "true"), { acao, acac });
    s.check("A08-041", "with no allow-list, ACAO is never a wildcard together with credentials", !(acao === "*" && acac === "true"), { acao, acac });
    const me = await cd.get(P.me, { cookie: adm.cookie, headers: { origin: "https://evil.example" } });
    s.check("A08-042", "with no allow-list, an authenticated JSON read is not exposed cross-origin with credentials", !(me.headers.get("access-control-allow-origin") === "https://evil.example" && me.headers.get("access-control-allow-credentials") === "true"), Object.fromEntries(me.headers));
  });

  await s.section("cache and security headers on authentication responses", async () => {
    const lg = await L.login(c, staff.email, staff.password);
    const bad = await L.login(c, staff.email, "Wrong-passphrase-7777");
    const me = await c.get(P.me, { cookie: lg.cookie });
    const reset = await c.post(`${P.users}/${staff.id}/reset`, { cookie: admin.cookie, json: {} });
    const invite = await c.post(P.invite, { cookie: admin.cookie, json: { email: `h-${L.rand(3)}@example.test`, role: "ochiga_staff" } });
    const pw = await c.post(P.password, { cookie: lg.cookie, json: { current_password: staff.password, new_password: L.STRONG() } });
    const su = await c.post(P.stepUp, { cookie: admin.cookie, json: { password: admin.password, purpose: "security_policy_write" } });
    const acc = await c.post(P.inviteAccept, { json: { token: new URL(invite.body.invite_url).searchParams.get("token"), password: L.STRONG() } });
    const users = await c.get(P.users, { cookie: admin.cookie });
    const resetReq = await c.post(P.resetRequest, { json: { email: staff.email } });
    const lim = []; for (let i = 0; i < 12; i++) lim.push(await L.login(c, `lim-${L.rand(3)}@example.test`, "x", { xff: "203.0.113.250" }));
    const throttled = lim.find((r) => r.status === 429);
    const rows = [["successful login", lg], ["failed login", bad], ["/session/me", me], ["admin reset (returns a token)", reset], ["admin invite (returns a token)", invite], ["password change (re-issues a cookie)", pw], ["step-up grant", su], ["invitation accept (issues a cookie)", acc], ["reset request", resetReq], ["throttled login", throttled || { headers: new Headers() }], ["account list (personal data)", users]];
    rows.forEach(([name, r], i) => s.check(`A08-05${String(i).padStart(2, "0")}`, `${name}: response is Cache-Control no-store`, noStore(r), r.headers.get("cache-control") || "(none)"));
    const html = await c.get("/office");
    s.check("A08-070", "the sign-in page is served (positive control)", html.status === 200 && /html/i.test(html.headers.get("content-type") || ""));
    s.check("A08-071", "the sign-in page cannot be framed by another site (X-Frame-Options or CSP frame-ancestors)", /deny|sameorigin/i.test(html.headers.get("x-frame-options") || "") || /frame-ancestors/i.test(html.headers.get("content-security-policy") || ""), { xfo: html.headers.get("x-frame-options"), csp: html.headers.get("content-security-policy") });
    s.check("A08-072", "the sign-in page sends a Content-Security-Policy", Boolean(html.headers.get("content-security-policy")));
    s.check("A08-073", "the sign-in page sends X-Content-Type-Options: nosniff", /nosniff/i.test(html.headers.get("x-content-type-options") || ""));
    s.check("A08-074", "JSON API responses send X-Content-Type-Options: nosniff", /nosniff/i.test(lg.headers.get("x-content-type-options") || ""));
    s.check("A08-075", "responses send a Referrer-Policy", Boolean(html.headers.get("referrer-policy")));
    s.check("A08-076", "login response does not disclose the server technology (no X-Powered-By / Server version)", !lg.headers.get("x-powered-by") && !/express|node/i.test(lg.headers.get("server") || ""), { powered: lg.headers.get("x-powered-by"), server: lg.headers.get("server") });
    s.check("A08-077", "login JSON declares an explicit content type (application/json; charset)", /application\/json/i.test(lg.headers.get("content-type") || ""));
  });

  await s.section("unknown routes, methods and path oddities never bypass authentication", async () => {
    const anon = async (p, m = "GET") => c.call(m, p, {});
    const protectedPaths = [
      "/api/lead-agents/admin/users", "/api/lead-agents/admin/users/", "//api/lead-agents/admin/users", "/api/lead-agents/admin/users?x=1", "/api/lead-agents/admin/users#frag",
      "/api/lead-agents/admin/session/login/../users", "/api/lead-agents/admin/session/me/../../users", "/api/lead-agents/admin/%75sers", "/api/lead-agents/admin/users%00",
      "/api/lead-agents/admin/users%2f", "/api/lead-agents/admin/users;x", "/API/LEAD-AGENTS/ADMIN/USERS", "/api/lead-agents/admin/users/%2e%2e/users", "/healthz/../api/lead-agents/admin/users",
      "/api/lead-agents/admin/session/step-up/", "/api/lead-agents/admin/session//step-up", "/api/lead-agents/admin/audit", "/api/lead-agents/admin/settings", "/api/lead-agents/admin/permissions",
      "/api/lead-agents/admin/session/revoke-all/", "/api/lead-agents/admin/session/mfa", "/api/lead-agents/admin/users/qr",
    ];
    let n = 0;
    for (const p of protectedPaths) {
      const r = await anon(p);
      s.check(`A08-08${String(n++).padStart(2, "0")}`, `anonymous GET ${p.slice(0, 70)} is never served as data (401/403/404) and never a 5xx`, [401, 403, 404, 405].includes(r.status) && !LEAK_RE.test(r.text), { status: r.status, text: r.text.slice(0, 100) });
    }
    const huge = await anon("/" + "a".repeat(20000));
    s.check("A08-110", "a 20 KB path is refused cleanly", huge.status === 404 || huge.status === 414 || huge.status === 431 || huge.status === 401 || huge.status === 0, huge.status);
    const weird = await L.rawHttp(srv.port, "GET /api/lead-agents/admin/users HTTP/1.1\r\nHost: a\r\nX-Forwarded-For: \u0000\r\nConnection: close\r\n\r\n");
    s.check("A08-111", "a NUL byte in a header is refused or ignored without a crash", weird.status !== 200 && srv.alive(), weird.status);
    const traversal = await L.rawHttp(srv.port, "GET /office/../../etc/passwd HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n");
    s.check("A08-112", "path traversal on the static surface does not return files outside the public directory", !/root:|daemon:/.test(traversal.body) && srv.alive(), traversal.status);
    const enc = await L.rawHttp(srv.port, "GET /office/%2e%2e/%2e%2e/package.json HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n");
    s.check("A08-113", "encoded traversal does not return the package manifest", !/"name"\s*:/.test(enc.body), enc.status);
    const unknown = await c.get("/api/lead-agents/admin/does-not-exist", { cookie: admin.cookie });
    s.check("A08-114", "an authenticated unknown route is a clean 404 without framework detail", unknown.status === 404 && !LEAK_RE.test(unknown.text), unknown.text.slice(0, 100));
    const unknownAnon = await anon("/api/lead-agents/admin/does-not-exist");
    s.check("A08-115", "an anonymous unknown admin route answers 401 (existence of routes is not revealed)", unknownAnon.status === 401, unknownAnon.status);
    for (const m of ["TRACE", "CONNECT", "PROPFIND", "PURGE", "FOO"]) {
      const r = await L.rawHttp(srv.port, `${m} ${P.login} HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      s.check(`A08-116-${m}`, `method ${m} on the sign-in route does not sign anyone in or reveal data`, r.status !== 200 && !/set-cookie/i.test(r.headersText) && srv.alive(), r.status);
    }
    const http10 = await L.rawHttp(srv.port, `GET ${P.me} HTTP/1.0\r\n\r\n`);
    s.check("A08-117", "an HTTP/1.0 request without Host is handled cleanly", http10.status === 401 || http10.status === 400, http10.status);
    s.check("A08-118", "server survived the oddities", srv.alive());
  });

  await s.section("malformed bodies on authenticated mutation routes: no 5xx, no internal detail", async () => {
    const V = (await L.makeUser(c, admin, { role: "ochiga_staff" })).id;
    const actor = await L.makeUser(c, admin, { role: "super_admin" });
    const routes = [
      ["POST", P.users], ["POST", P.invite], ["PATCH", `${P.users}/${V}`], ["POST", `${P.users}/${V}/photo`], ["POST", `${P.users}/${V}/reset`], ["POST", `${P.users}/${V}/remove`],
      ["POST", `${P.users}/${V}/restore`], ["POST", `${P.users}/${V}/revoke-sessions`], ["POST", `${P.users}/${V}/mfa/reset`], ["POST", P.password], ["POST", `${SESS}/photo`], ["PATCH", `${SESS}/profile`],
      ["POST", P.stepUp], ["POST", P.stepUpCheck], ["POST", `${SESS}/revoke-all`], ["PUT", `${P.settings}/office_session_ttl_hours`], ["PUT", "/api/lead-agents/admin/settings/whatsapp-autonomy"],
      ["POST", `${SESS}/mfa/enroll/totp/begin`], ["POST", `${SESS}/mfa/enroll/totp/confirm`], ["POST", `${SESS}/mfa/recovery-codes/regenerate`], ["POST", P.mfaVerify],
      ["POST", P.resetConfirm], ["POST", P.inviteAccept], ["POST", P.resetRequest], ["POST", P.logout],
    ];
    const bodies = { "invalid JSON": "{oops", "JSON null": "null", "JSON array": "[1,2]", "JSON string": '"x"', "JSON number": "7", "empty": "", "nested object fields": JSON.stringify({ email: { a: 1 }, password: { b: 2 }, token: [1], role: {}, status: [], value: {}, purpose: {}, new_password: {}, current_password: [], code: {}, challenge_token: {}, method: {}, reason: {}, confirm_email: {} }) };
    let n = 0; const bad = [];
    for (const [m, p] of routes) {
      for (const [bn, b] of Object.entries(bodies)) {
        // a fresh session for every call: some of these routes (logout, revoke-all) legitimately end the caller's own session
        const sess = await L.login(c, actor.email, actor.password);
        const r = await c.call(m, p, { cookie: sess.cookie, body: b, headers: { "content-type": "application/json" } });
        // a clean 503 with a short code (feature unavailable) is an honest answer; a 500, any other 5xx, or any internal text is not
        const ok = r.status > 0 && (r.status < 500 || (r.status === 503 && r.text.length < 200)) && !LEAK_RE.test(r.text);
        if (!ok) bad.push(`${m} ${p.replace(V, ":id")} [${bn}] -> ${r.status} ${r.text.slice(0, 90)}`);
        n++;
      }
    }
    s.check("A08-130", `no authenticated route answers a malformed body (${n} combinations) with a 5xx or internal detail`, bad.length === 0, bad.slice(0, 8));
    s.check("A08-132", "the bootstrap administrator session still works after the malformed traffic", (await c.get(P.me, { cookie: admin.cookie })).status === 200 && srv.alive());
  });

  await s.section("public-route boundary", async () => {
    const bridge = ["/api/lead-agents/admin/communications/whatsapp/send", "/api/lead-agents/admin/communications/whatsapp/templates", "/api/lead-agents/admin/recipients/resolve", "/api/lead-agents/admin/communications/activity", "/api/lead-agents/admin/communications/create-task", "/api/lead-agents/admin/communications/handoff-request", "/api/lead-agents/admin/knowledge-pack"];
    for (const [i, p] of bridge.entries()) {
      const m = p.endsWith("knowledge-pack") ? "GET" : "POST";
      const body = m === "POST" ? { json: {} } : {};
      const anon = await c.call(m, p, { ...body });
      const withKey = await c.call(m, p, { apiKey: srv.secrets.apiKey, ...body });
      const withSession = await c.call(m, p, { cookie: admin.cookie, ...body });
      s.check(`A08-14${i}`, `backend-bridge route ${p.split("/").slice(-2).join("/")}: refused (401) for anonymous, for a normal API key and for an administrator session`, anon.status === 401 && withKey.status === 401 && withSession.status === 401, [anon.status, withKey.status, withSession.status]);
    }
    const hz = await c.get("/healthz");
    s.check("A08-150", "/healthz is public and exposes no secret, hash, key or token value", hz.status === 200 && L.findLeaks(hz.text, { sessionSecret: srv.secrets.sessionSecret, apiKey: srv.secrets.apiKey, apiKey2: srv.secrets.apiKey2, edge: srv.secrets.edgeToken, adminPassword: srv.secrets.adminPassword }).length === 0 && !/OPENAI|sk-dummy/.test(hz.text), hz.text.slice(0, 120));
    s.check("A08-151", "/healthz exposes no account e-mail addresses", !hz.text.includes("@example.test") && !hz.text.includes(srv.secrets.adminEmail));
    s.check("A08-152", "/healthz is not served for POST", (await c.post("/healthz", { json: {} })).status === 405);
    const me = await c.get(P.me);
    s.check("A08-153", "/session/me without a cookie is a bare 401 (no account hints)", me.status === 401 && !/email|role/.test(me.text), me.text);
    const bearerMe = await c.get(P.me, { bearer: admin.cookie });
    s.check("A08-154", "/session/me ignores a session token supplied as a Bearer credential", bearerMe.status === 401);
  });

  s.check("A08-980", "no secret or password in the server log after header and error traffic", L.findLeaks(srv.logs(), { sessionSecret: srv.secrets.sessionSecret, apiKey: srv.secrets.apiKey, adminPassword: srv.secrets.adminPassword, staffPassword: staff.password }).length === 0);
  s.check("A08-999", "server alive at the end of the suite", srv.alive());
});
