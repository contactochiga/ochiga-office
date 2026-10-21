"use strict";
// A01 - password login, session issuance, cookie attributes, malformed input, API key as password.
// Expectations come from the S7.0 / S7.3 / S7.4 / S7.5.0 contracts and generic authentication requirements.
const L = require("./a-lib");
const { P } = L;
const suite = L.createSuite("a01-password-login");

const LEAK_RE = /(TypeError|ReferenceError|SyntaxError|RangeError|Cannot read propert|is not a function|is not defined|\bat [\w.<>$ ]+ \(|node_modules|\/Users\/|\/var\/folders|ECONNREFUSED|ENOENT|stack)/;
const clean = (r) => r.status > 0 && r.status < 500 && !LEAK_RE.test(r.text || "");

suite.run(async (s) => {
  const srv = await L.startServer(s);
  const c = new L.Client(srv);
  const admin = await L.adminSession(c, srv);
  const staff = await L.makeUser(c, admin, { role: "ochiga_staff" });
  const needles = { adminPassword: srv.secrets.adminPassword, staffPassword: staff.password, sessionSecret: srv.secrets.sessionSecret, apiKey: srv.secrets.apiKey, apiKey2: srv.secrets.apiKey2, edge: srv.secrets.edgeToken };

  await s.section("positive control and session issuance", async () => {
    const r = await L.login(c, staff.email, staff.password);
    s.status("A01-001", "correct credentials sign in (200)", r, 200);
    s.check("A01-002", "success body reports ok:true and the account e-mail", r.body && r.body.ok === true && r.body.admin && r.body.admin.email === staff.email, r.body);
    s.check("A01-003", "success sets exactly one session cookie", r.setCookies.length === 1 && r.cookie, r.setCookies);
    const attrs = L.attrsOf(r.setCookies[0] || "");
    s.check("A01-004", "session cookie is HttpOnly", attrs.httponly === true, r.setCookies);
    s.check("A01-005", "session cookie has SameSite Lax or Strict", /^(lax|strict)$/i.test(String(attrs.samesite || "")), r.setCookies);
    s.check("A01-006", "session cookie Path is /", attrs.path === "/", r.setCookies);
    const claims = (L.decodeToken(r.cookie) || {}).claims || {};
    const maxAge = Number(attrs["max-age"]);
    s.check("A01-007", "cookie Max-Age equals token lifetime within 5 s", Number.isFinite(maxAge) && Math.abs((claims.exp - Date.now()) / 1000 - maxAge) < 5, { maxAge, exp: claims.exp });
    s.check("A01-008", "default session lifetime is seven days (168 h)", maxAge === 604800, maxAge);
    s.check("A01-009", "development server does not set Secure (so local HTTP works) - control for the production check", !("secure" in attrs), r.setCookies);
    s.check("A01-010", "token has exactly two dot-separated segments", String(r.cookie).split(".").length === 2, r.cookie && r.cookie.length);
    s.check("A01-011", "token signature is HMAC-SHA256 of the payload under the configured session secret", L.hmacHex(srv.secrets.sessionSecret, r.cookie.split(".")[0]) === r.cookie.split(".")[1]);
    s.check("A01-012", "token is not signed with an API key or the historical public default", [srv.secrets.apiKey, `${srv.secrets.apiKey},${srv.secrets.apiKey2}`, "lead-agents-dev-session-secret"].every((k) => L.hmacHex(k, r.cookie.split(".")[0]) !== r.cookie.split(".")[1]));
    s.check("A01-013", "token claims carry e-mail, user id, expiry, generation and session id", claims.email === staff.email && claims.user_id === staff.id && Number.isFinite(claims.exp) && Number.isInteger(claims.sg) && typeof claims.sid === "string" && claims.sid.length >= 16, claims);
    const store = L.readStore(srv) || { admin_users: [] };
    const stored = store.admin_users.find((u) => u.id === staff.id) || {};
    const tokenText = Buffer.from(r.cookie.split(".")[0], "base64url").toString("utf8");
    s.check("A01-014", "token payload never contains the password hash or any of its fragments", stored.password_hash && !tokenText.includes(stored.password_hash) && !tokenText.includes(stored.password_hash.split(":")[1].slice(0, 16)), tokenText);
    s.check("A01-015", "token payload never contains the password or API key", !tokenText.includes(staff.password) && !tokenText.includes(srv.secrets.apiKey), tokenText);
    s.check("A01-016", "login response body contains no hash, no token, no secret", L.findLeaks(r.text, needles).length === 0 && !/password_hash|scrypt|"token"/i.test(r.text), r.text.slice(0, 300));
    s.check("A01-017", "login response body does not echo the cookie value", !r.text.includes(r.cookie));
    const me = await c.get(P.me, { cookie: r.cookie });
    s.status("A01-018", "the issued cookie authenticates /session/me", me, 200);
    s.check("A01-019", "/session/me reports the signed-in account", me.body && me.body.admin && me.body.admin.id === staff.id, me.body);
    s.check("A01-020", "/session/me exposes no password hash", !/password_hash|scrypt/i.test(me.text));
    const cc = (r.headers.get("cache-control") || "").toLowerCase();
    s.check("A01-021", "successful login response is marked non-cacheable (Cache-Control no-store/private)", /no-store|private/.test(cc), cc || "(none)");
    const ccMe = (me.headers.get("cache-control") || "").toLowerCase();
    s.check("A01-022", "/session/me response is marked non-cacheable", /no-store|private/.test(ccMe), ccMe || "(none)");
    s.check("A01-023", "responses carry an x-request-id", Boolean(r.headers.get("x-request-id")));
    const r2 = await L.login(c, staff.email, staff.password);
    const sid1 = claims.sid, sid2 = ((L.decodeToken(r2.cookie) || {}).claims || {}).sid;
    s.check("A01-024", "two sign-ins issue distinct tokens and session ids", r2.cookie !== r.cookie && sid1 !== sid2, { sid1, sid2 });
    const me1 = await c.get(P.me, { cookie: r.cookie });
    s.status("A01-025", "a second sign-in does not end the first session (multiple sessions allowed)", me1, 200);
  });

  await s.section("negative controls: credentials", async () => {
    const wrong = await L.login(c, staff.email, staff.password + "x");
    s.status("A01-030", "wrong password is refused with 401", wrong, 401);
    s.check("A01-031", "wrong password sets no cookie", wrong.setCookies.length === 0 && !wrong.cookie, wrong.setCookies);
    s.check("A01-032", "wrong password body is generic and carries no account data", wrong.body && wrong.body.error === "unauthorized" && !/staff|role|admin\b/i.test(JSON.stringify(wrong.body).replace(/"unauthorized"/, "")), wrong.body);
    const unknown = await L.login(c, `nobody-${L.rand(4)}@example.test`, "Whatever-password-123");
    s.status("A01-033", "unknown account is refused with 401", unknown, 401);
    s.check("A01-034", "unknown account sets no cookie", unknown.setCookies.length === 0);
    for (const [i, pw] of ["", " ", staff.password.toUpperCase(), staff.password + " ", " " + staff.password, staff.password.slice(0, -1), staff.password + "\u0000"].entries()) {
      const r = await L.login(c, staff.email, pw);
      s.check(`A01-04${i}`, `near-miss password variant #${i} is refused`, r.status === 401 && !r.cookie, { status: r.status });
    }
    const hashBefore = (L.readStore(srv).admin_users.find((u) => u.id === staff.id) || {}).password_hash;
    const asHash = await L.login(c, staff.email, hashBefore || "x");
    s.check("A01-050", "the stored password hash is not accepted as a password (no pass-the-hash)", hashBefore && asHash.status === 401 && !asHash.cookie, asHash.status);
    const hashHalf = await L.login(c, staff.email, (hashBefore || "x:y").split(":")[1]);
    s.check("A01-051", "the hash digest alone is not accepted as a password", hashHalf.status === 401 && !hashHalf.cookie);
    for (const [i, pw] of [{ "$ne": null }, ["a"], 12345, true, null, { toString: "x" }].entries()) {
      const r = await c.post(P.login, { json: { email: staff.email, password: pw } });
      s.check(`A01-06${i}`, `non-string password value #${i} (${JSON.stringify(pw)}) gives a clean 4xx with no cookie`, clean(r) && r.status >= 400 && !r.cookie, { status: r.status, text: r.text.slice(0, 160) });
    }
    for (const [i, em] of [{ "$ne": null }, ["a@b.c"], 12345, true, null, "' OR '1'='1", "a@b.c' --", staff.email + "\u0000", "*"].entries()) {
      const r = await c.post(P.login, { json: { email: em, password: staff.password } });
      s.check(`A01-07${i}`, `unusual e-mail value #${i} (${JSON.stringify(em)}) never signs in and is a clean 4xx`, clean(r) && r.status >= 400 && !r.cookie, { status: r.status, text: r.text.slice(0, 160) });
    }
    const upper = await L.login(c, staff.email.toUpperCase(), staff.password);
    s.check("A01-080", "if the upper-case form of the e-mail signs in, it is the same account (never a second account)", upper.status !== 200 || (upper.body.admin && upper.body.admin.id === staff.id), upper.status);
    const spaced = await L.login(c, ` ${staff.email} `, staff.password);
    s.check("A01-081", "if a space-padded e-mail signs in, it is the same account", spaced.status !== 200 || (spaced.body.admin && spaced.body.admin.id === staff.id), spaced.status);
    const users = await c.get(P.users, { cookie: admin.cookie });
    const count = (users.body.users || []).length;
    await L.login(c, `ghost-${L.rand(3)}@example.test`, srv.secrets.apiKey);
    await L.login(c, `ghost-${L.rand(3)}@example.test`, "Another-passphrase-123");
    const users2 = await c.get(P.users, { cookie: admin.cookie });
    s.check("A01-082", "failed logins never create an account", (users2.body.users || []).length === count, { before: count, after: (users2.body.users || []).length });
  });

  await s.section("API key as password (S7.0: disabled by default)", async () => {
    const em = `fallback-${L.rand(3)}@example.test`;
    for (const [i, key] of [srv.secrets.apiKey, srv.secrets.apiKey2, `${srv.secrets.apiKey},${srv.secrets.apiKey2}`].entries()) {
      const r = await L.login(c, em, key);
      s.check(`A01-09${i}`, `unknown e-mail + API key #${i} as password is refused with 401 and no cookie`, r.status === 401 && !r.cookie, r.status);
    }
    const users = await c.get(P.users, { cookie: admin.cookie });
    s.check("A01-093", "no account was created by the API-key-as-password attempts", !(users.body.users || []).some((u) => u.email === em));
    const r2 = await L.login(c, srv.secrets.adminEmail, srv.secrets.apiKey);
    s.check("A01-094", "existing administrator + API key as password is refused", r2.status === 401 && !r2.cookie);
    const hz = await c.get("/healthz");
    s.check("A01-095", "/healthz reports api_key_password_login disabled", hz.body && hz.body.auth_config && hz.body.auth_config.api_key_password_login === "disabled", hz.body && hz.body.auth_config);
  });

  await s.section("malformed requests", async () => {
    const cases = [
      ["empty body", { body: "", headers: { "content-type": "application/json" } }],
      ["invalid JSON", { body: "{not json", headers: { "content-type": "application/json" } }],
      ["JSON null", { body: "null", headers: { "content-type": "application/json" } }],
      ["JSON array", { body: "[]", headers: { "content-type": "application/json" } }],
      ["JSON string", { body: '"abc"', headers: { "content-type": "application/json" } }],
      ["JSON number", { body: "42", headers: { "content-type": "application/json" } }],
      ["empty object", { body: "{}", headers: { "content-type": "application/json" } }],
      ["only email", { json: { email: staff.email } }],
      ["only password", { json: { password: staff.password } }],
      ["BOM prefixed JSON", { body: "﻿{\"email\":\"a\"}", headers: { "content-type": "application/json" } }],
      ["wrong content type", { body: `email=${staff.email}&password=${staff.password}`, headers: { "content-type": "application/x-www-form-urlencoded" } }],
      ["deeply nested", { body: "[".repeat(5000) + "]".repeat(5000), headers: { "content-type": "application/json" } }],
      ["prototype pollution keys", { body: '{"__proto__":{"isAdmin":true},"email":"a@b.c","password":"x","constructor":{"prototype":{"x":1}}}', headers: { "content-type": "application/json" } }],
    ];
    for (const [i, [name, o]] of cases.entries()) {
      const r = await c.post(P.login, o);
      s.check(`A01-1${String(i).padStart(2, "0")}`, `login with ${name}: clean 4xx, no cookie, no internal detail`, clean(r) && r.status >= 400 && !r.cookie, { status: r.status, text: (r.text || "").slice(0, 200) });
    }
    const big = await c.post(P.login, { json: { email: staff.email, password: "p".repeat(2 * 1024 * 1024) } });
    s.check("A01-120", "a 2 MB request body is refused (413) or rejected cleanly, never a 5xx other than 413", big.status === 413 || (big.status >= 400 && big.status < 500), big.status);
    const longPw = await c.post(P.login, { json: { email: staff.email, password: "p".repeat(500 * 1024) } });
    s.check("A01-121", "a 500 KB password is refused cleanly and quickly (no hashing DoS beyond a few seconds)", clean(longPw) && longPw.status === 401 && longPw.ms < 8000, { status: longPw.status, ms: longPw.ms });
    for (const m of ["GET", "PUT", "DELETE", "PATCH"]) {
      const r = await c.call(m, P.login, {});
      s.check(`A01-122${m}`, `${m} on the login route is refused with 405 and no cookie`, r.status === 405 && !r.cookie, r.status);
    }
    const head = await c.call("HEAD", P.login, {});
    s.check("A01-126", "HEAD on login does not sign anyone in", head.status !== 200);
    const raw1 = await L.rawHttp(srv.port, `POST ${P.login} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 10\r\nConnection: close\r\n\r\n{"email":`);
    s.check("A01-127", "a request body shorter than its Content-Length does not crash the server or sign anyone in", raw1.status !== 200 && srv.alive(), raw1.status);
    const raw2 = await L.rawHttp(srv.port, `POST ${P.login} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\nConnection: close\r\n\r\nZZ\r\n{}\r\n0\r\n\r\n`);
    s.check("A01-128", "a malformed chunked body is refused without crashing the server", raw2.status >= 400 && srv.alive(), raw2.status);
    const dup = await L.rawHttp(srv.port, `POST ${P.login} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 40\r\nConnection: close\r\n\r\n{}`);
    s.check("A01-129", "conflicting Content-Length headers are refused (request smuggling guard)", dup.status === 400 || dup.status === 0, dup.status);
    const reqId = await c.post(P.login, { json: { email: staff.email, password: "bad-password-123" }, headers: { "x-request-id": "a".repeat(8000) } });
    s.check("A01-130", "an oversized x-request-id header does not cause a 5xx", reqId.status > 0 && reqId.status < 500, reqId.status);
    s.check("A01-131", "the server survived the whole malformed-input section", srv.alive());
    const afterOk = await L.login(c, staff.email, staff.password);
    s.check("A01-132", "after all malformed traffic the legitimate login still works (no state damage)", afterOk.status === 200 || afterOk.status === 429, afterOk.status);
  });

  await s.section("inactive and removed accounts cannot sign in", async () => {
    const inactive = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const patch = await c.patch(`${P.users}/${inactive.id}`, { cookie: admin.cookie, json: { status: "inactive" } });
    s.status("A01-140", "administrator deactivates an account (positive control)", patch, 200);
    const r = await L.login(c, inactive.email, inactive.password);
    s.check("A01-141", "deactivated account with the correct password is refused (401) and gets no cookie", r.status === 401 && !r.cookie, r.status);
    const old = await c.get(P.me, { cookie: inactive.cookie });
    s.check("A01-142", "the deactivated account's earlier session is refused immediately", old.status === 401, old.status);
    const rem = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const rm = await c.post(`${P.users}/${rem.id}/remove`, { cookie: admin.cookie, json: {} });
    s.status("A01-143", "administrator removes an account (positive control)", rm, 200);
    const r2 = await L.login(c, rem.email, rem.password);
    s.check("A01-144", "removed account with the correct password is refused", r2.status === 401 && !r2.cookie, r2.status);
    const invitedPw = L.STRONG();
    const inv = await c.post(P.invite, { cookie: admin.cookie, json: { email: `invitee-${L.rand(3)}@example.test`, role: "ochiga_staff" } });
    s.status("A01-145", "administrator invites a new member (positive control)", inv, 201);
    const r3 = await L.login(c, inv.body && inv.body.invite && inv.body.invite.email, invitedPw);
    s.check("A01-146", "an invited (not yet activated) account cannot sign in with a guessed password", r3.status === 401 && !r3.cookie, r3.status);
  });

  await s.section("concurrency", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => L.login(c, staff.email, staff.password, { xff: `198.51.100.${1 + Math.floor(Math.random() * 200)}` })));
    const ok = results.filter((r) => r.status === 200);
    s.check("A01-150", "12 concurrent correct logins all succeed or are throttled, none fail with 5xx", results.every((r) => r.status === 200 || r.status === 429), results.map((r) => r.status));
    const sids = new Set(ok.map((r) => ((L.decodeToken(r.cookie) || {}).claims || {}).sid));
    s.check("A01-151", "concurrent sign-ins never share a session id", sids.size === ok.length, { sids: sids.size, ok: ok.length });
  });

  await s.section("secrets in logs", async () => {
    const logs = srv.logs();
    const leaks = L.findLeaks(logs, needles);
    s.check("A01-160", "server log contains none of the passwords, session secret, API keys or edge token", leaks.length === 0, leaks);
    const cookies = [];
    const r = await L.login(c, staff.email, staff.password);
    cookies.push(r.cookie);
    await c.get(P.me, { cookie: r.cookie });
    s.check("A01-161", "server log never contains a session cookie value", !srv.logs().includes(r.cookie.split(".")[1]), "signature found in log");
  });

  s.check("A01-999", "server process alive at the end of the suite", srv.alive());
});
