// S7 R8: the remaining Medium findings of docs/settings-domain/47. Negative and concurrency controls over HTTP; no external services. Matrix: docs/settings-domain/51_S7_R8_*.md
"use strict";
const L = require("./cert/cert-lib");
const { A, boot, seed, forgeSession, recorder } = L;
const R = recorder("medium-findings-r8"); const { check, eq } = R;
const WRONG = "definitely wrong passphrase 123";
const login = (sys, email, password, headers) => sys.call("POST", `${A}/session/login`, { body: { email, password }, headers });
const goodClaims = (u, over = {}) => ({ email: u.email, role: u.role, user_id: u.id, permission_scopes: [], exp: Date.now() + 3600e3, ...over });

async function main() {
  // ===== M1 malformed session-token claims (signed with the real secret, so only the CLAIMS are wrong)
  { const sys = await boot({}, {}); const u = await seed(sys, "claims", "ochiga_staff");
    const me = (claims) => sys.call("GET", `${A}/session/me`, { cookie: forgeSession(sys.config, claims) });
    eq((await me(goodClaims(u))).status, 200, "M1 positive control: a well-formed signed token is accepted");
    for (const [name, over] of [["string expiry", { exp: String(Date.now() + 3600e3) }], ["NaN-like string expiry", { exp: "NaN" }], ["object expiry", { exp: { a: 1 } }], ["array expiry", { exp: [Date.now() + 3600e3] }], ["null expiry", { exp: null }], ["past expiry", { exp: Date.now() - 1 }], ["Infinity-like expiry", { exp: 1e999 }], ["missing user id", { user_id: undefined }], ["empty user id", { user_id: "" }], ["numeric user id", { user_id: 7 }], ["string generation", { sg: "1" }], ["float generation", { sg: 1.5 }], ["non-string role", { role: { admin: true } }], ["non-array scopes", { permission_scopes: "settings.manage" }], ["non-string email", { email: ["a@b.c"] }]]) {
      const r = await me(goodClaims(u, over)); check(r.status === 401 || r.status === 403, `M1 ${name}: refused (${r.status})`);
    }
    const idOnlyEmail = await me({ email: u.email, role: u.role, exp: Date.now() + 3600e3 }); eq(idOnlyEmail.status, 401, "M1 a token with the right e-mail but no account id is refused (identity is bound to the account id)");
    const wrongId = await me(goodClaims(u, { user_id: "00000000-0000-4000-8000-000000000000" })); check(wrongId.status === 401 || wrongId.status === 403, "M1 a token whose account id belongs to nobody else but is not this account's is not accepted as this account (" + wrongId.status + ")");
    await sys.close(); }

  // ===== M2 cookie header parsing is total and order-independent
  { const sys = await boot({}, {}); const u = await seed(sys, "cookie", "ochiga_staff"); const s = await login(sys, u.email, u.password); const name = sys.config.sessionCookieName; const val = s.cookie.split("=").slice(1).join("=");
    const raw = (h) => sys.call("GET", `${A}/session/me`, { headers: { cookie: h } });
    for (const [n, h] of [["malformed percent escape", `${name}=%E0%A4%A`], ["lone percent", `${name}=%`], ["percent non-hex", `${name}=%zz`], ["empty", `${name}=`], ["no equals", name], ["semicolons", ";;;"]]) { const r = await raw(h); check(r.status === 401, `M2 ${n}: 401, never 5xx (${r.status})`); }
    eq((await raw(`${name}=${val}`)).status, 200, "M2 positive control: the genuine cookie authenticates");
    eq((await raw(`${name} =${val}`)).status, 401, "M2 whitespace inside the cookie NAME does not authenticate");
    const a = (await raw(`${name}=garbage; ${name}=${val}`)).status, b = (await raw(`${name}=${val}; ${name}=garbage`)).status; check(a === 401 && b === 401, `M2 duplicate cookie names are refused whichever order they arrive (${a}/${b})`);
    await sys.close(); }

  // ===== M3 human-session-only routes: an edge token/API key cannot act as a human account that shares its identity
  { const sys = await boot({}, {}); const twin = await seed(sys, "twin", "ochiga_staff", {}); await sys.store.updateAdminUser(twin.id, { email: "edge-agent@oyi.local" });
    const edge = sys.config.edgeAgentTokens[0]; const key = sys.config.apiKeys[0];
    for (const [route, method, body] of [["profile", "PATCH", { phone: "+2349999999" }], ["photo", "POST", { photo_data_url: "data:image/png;base64,iVBORw0KGgo=" }], ["password", "POST", { current_password: "x", new_password: "A brand new long passphrase 5821!" }]]) {
      const e = await sys.call(method, `${A}/session/${route}`, { edge, body }); check(e.status === 401 || e.status === 403, `M3 edge token on /session/${route}: refused (${e.status})`);
      const k = await sys.call(method, `${A}/session/${route}`, { apiKey: key, body }); check(k.status === 401 || k.status === 403, `M3 API key on /session/${route}: refused (${k.status})`);
      const n = await sys.call(method, `${A}/session/${route}`, { body }); check(n.status === 401 || n.status === 403, `M3 anonymous on /session/${route}: refused, never a 500 (${n.status})`);
    }
    check((await sys.store.getAdminUserByEmail("edge-agent@oyi.local")).phone !== "+2349999999", "M3 the twin account's profile was not changed through the edge token");
    await sys.close(); }

  // ===== M4 CORS and error redaction
  { const sys = await boot({ allowedOrigins: [] }, {}); const u = await seed(sys, "cors", "ochiga_staff");
    const r = await sys.call("POST", `${A}/session/login`, { body: { email: u.email, password: u.password }, headers: { origin: "https://evil.example" } });
    check(r.headers.get("access-control-allow-origin") !== "https://evil.example", "M4 no allow-list: a foreign origin is not echoed");
    check(r.headers.get("access-control-allow-credentials") !== "true", "M4 no allow-list: a foreign origin never receives credentialed access");
    await sys.close(); }
  { const sys = await boot({ allowedOrigins: ["https://office.example"] }, {}); const u = await seed(sys, "cors2", "ochiga_staff");
    const ok = await sys.call("POST", `${A}/session/login`, { body: { email: u.email, password: u.password }, headers: { origin: "https://office.example" } });
    eq(ok.headers.get("access-control-allow-origin"), "https://office.example", "M4 an approved origin is allowed"); eq(ok.headers.get("access-control-allow-credentials"), "true", "M4 …with credentials");
    const bad = await sys.call("POST", `${A}/session/login`, { body: { email: u.email, password: u.password }, headers: { origin: "https://evil.example" } });
    check(bad.status === 403 || !bad.headers.get("access-control-allow-origin"), "M4 an unapproved origin is refused when an allow-list exists"); await sys.close(); }
  { const sys = await boot({}, {}); const u = await seed(sys, "err", "ochiga_staff"); const s = await login(sys, u.email, u.password);
    for (const body of ["null", "[]", "7", '"x"', "{"]) { const r = await sys.call("POST", `${A}/session/reset/request`, { body }); check(r.status < 500 && !/Cannot read|undefined|at \S+ \(/.test(r.text) && (body === "[]" || r.status >= 400), `M4 body ${body}: no 5xx and no internal text; null/scalars/invalid JSON are 4xx (${r.status})`); }
    const o = await sys.call("POST", `${A}/session/login`, { body: { email: u.email, password: { toString: "x" } } }); check(o.status === 401 || o.status === 400, `M4 an object as a password is a client error, not a 500 (${o.status})`);
    const crash = await sys.call("POST", `${A}/session/login`, { body: { email: u.email, password: u.password + "\u0000" } }); eq(crash.status, 401, "M4/NUL a password with a trailing NUL is NOT the same password (scrypt ignores everything after a NUL)");
    const pre = await login(sys, u.email, u.password); eq(pre.status, 200, "M4/NUL positive control: the real password still signs in");
    const e2 = require("../src/lead-agents/http").externalErrorBody;
    for (const err of [Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" }), Object.assign(new Error("Request failed with status code 503"), { isAxiosError: true, response: { status: 503, data: { host: "pg" } } }), new TypeError("Cannot read properties of null (reading 'email')"), Object.assign(new Error("EACCES: permission denied, open '/var/data/store.json'"), { code: "EACCES" })]) {
      const x = e2(err, "rid"); check(x.statusCode >= 500 && !/ECONN|10\.0|status code|Cannot read|EACCES|\/var\//.test(JSON.stringify(x.body)), `M4 externalErrorBody hides "${String(err.message).slice(0, 30)}…" (${x.statusCode} ${x.body.error})`);
    }
    check(e2(Object.assign(new Error("forbidden"), { statusCode: 403 }), "r").body.error === "forbidden" && e2(Object.assign(new Error("session_verification_unavailable"), { statusCode: 503 }), "r").body.error === "session_verification_unavailable", "M4 intentional 4xx messages and 5xx codes survive");
    await sys.close(); }

  // ===== M5 no-store on credential-bearing responses; response hardening headers
  { const sys = await boot({}, { loginMax: 5 }); const u = await seed(sys, "nostore", "super_admin"); const s = await login(sys, u.email, u.password);
    const noStore = (r) => /no-store/.test(r.headers.get("cache-control") || "");
    check(noStore(s), "M5 successful login: no-store"); check(noStore(await login(sys, u.email, WRONG)), "M5 failed login: no-store");
    check(noStore(await sys.call("GET", `${A}/session/me`, { cookie: s.cookie })), "M5 /session/me: no-store");
    const reset = await sys.call("POST", `${A}/users/${u.id}/reset`, { cookie: s.cookie, body: {} }); check(noStore(reset), "M5 an issued reset token: no-store");
    check(!/token_hash/.test(reset.text) && !!(reset.json && reset.json.reset_token), "M5 the reset response carries the one-time token for the admin but NEVER the stored digest");
    const lim = []; for (let i = 0; i < 8; i++) lim.push(await login(sys, u.email, WRONG)); const thr = lim.find((x) => x.status === 429); check(thr && noStore(thr), "M5 a throttled login: no-store");
    const page = await sys.call("GET", "/office", {}); eq(page.headers.get("x-content-type-options"), "nosniff", "M5 nosniff"); check(!!page.headers.get("referrer-policy"), "M5 referrer policy"); check(/frame-ancestors/.test(page.headers.get("content-security-policy") || "") && !!page.headers.get("x-frame-options"), "M5 framing restricted");
    await sys.close(); }

  // ===== M6 reset/invite lifetime and token types
  { const sys = await boot({}, {}); const a = await seed(sys, "life", "super_admin"); const t = await seed(sys, "target", "ochiga_staff"); const s = await login(sys, a.email, a.password);
    for (const v of ["abc", "1e12", -5, 0, 0.001, 99999, [], {}, true]) { const r = await sys.call("POST", `${A}/users/${t.id}/reset`, { cookie: s.cookie, body: { expires_in_hours: v } }); check(r.status === 400, `M6 expires_in_hours=${JSON.stringify(v)}: 400 (${r.status})`); }
    check((await sys.call("POST", `${A}/users/${t.id}/reset`, { cookie: s.cookie, body: { expires_in_hours: 24 } })).status === 201, "M6 positive control: a sane lifetime is issued");
    const tok = (await sys.call("POST", `${A}/users/${t.id}/reset`, { cookie: s.cookie, body: {} })).json.reset_token;
    for (const bad of [[tok], { a: tok }, 12345]) { const r = await sys.call("POST", `${A}/session/reset/confirm`, { body: { token: bad, new_password: "A brand new long passphrase 5821!" } }); eq(r.status, 400, `M6 a non-string reset token (${JSON.stringify(bad).slice(0, 20)}) is a 400`); }
    eq((await sys.call("POST", `${A}/session/reset/confirm`, { body: { token: tok, new_password: "A brand new long passphrase 5821!" } })).status, 200, "M6 …and the genuine string token still works afterwards (the array did not consume it)");
    await sys.close(); }

  // ===== M7 link origin is not attacker-controlled
  { const mails = []; const realFetch = global.fetch; global.fetch = async (url, init) => { if (String(url).startsWith("https://api.resend.com")) { mails.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: "m" }), { status: 200 }); } return realFetch(url, init); };
    const sys = await boot({ officeAppUrl: "", resendApiKey: "re_test", officeEmailProvider: "resend", officeEmailFrom: "o@example.test" }, {}); const a = await seed(sys, "link", "super_admin"); const t = await seed(sys, "linkt", "ochiga_staff"); const s = await login(sys, a.email, a.password);
    const r = await sys.call("POST", `${A}/users/${t.id}/reset`, { cookie: s.cookie, body: {}, headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", host: "evil.example" } });
    check(r.status === 201 && !/evil\.example/.test(r.json.reset_url || ""), "M7 an attacker's X-Forwarded-Host / Host never reaches the link (" + String(r.json && r.json.reset_url).slice(0, 40) + ")");
    check(!mails.some((m) => /evil\.example/.test(JSON.stringify(m))), "M7 …nor the e-mail sent to the account"); global.fetch = realFetch; await sys.close(); }

  // ===== M8 audit failure on sign-in fails closed and honestly
  { const sys = await boot({}, {}); const u = await seed(sys, "aud", "ochiga_staff"); const real = sys.store.appendAuditEvent.bind(sys.store);
    sys.store.appendAuditEvent = async () => { throw new Error("EACCES: permission denied, open '/secret/path/store.json'"); };
    const r = await login(sys, u.email, u.password); check(r.status === 503 && !r.cookie && !/EACCES|secret/.test(r.text), `M8 audit write fails: 503, no session, no internal text (${r.status})`);
    sys.store.appendAuditEvent = real; eq((await login(sys, u.email, u.password)).status, 200, "M8 once the audit sink is back, sign-in works again"); await sys.close(); }

  // ===== M9 permanent deletion removes factor material, codes, challenges, invitations and reset tokens (file store; the database cascades)
  { const sys = await boot({}, {}); const a = await seed(sys, "del", "super_admin"); const v = await seed(sys, "victim", "ochiga_staff"); const bystander = await seed(sys, "bystander", "ochiga_staff");
    const st = sys.store.state; st.admin_mfa_credentials.push({ id: "c1", admin_user_id: v.id, type: "totp", status: "active" }); st.admin_mfa_recovery_codes.push({ id: "r1", admin_user_id: v.id, code_hmac: "x" }); st.admin_mfa_challenges.push({ id: "h1", admin_user_id: v.id }); st.admin_mfa_credentials.push({ id: "c2", admin_user_id: bystander.id, type: "totp", status: "active" });
    const s = await login(sys, a.email, a.password); await sys.call("POST", `${A}/users/${v.id}/remove`, { cookie: s.cookie, body: {} });
    const del = await Promise.all([sys.call("DELETE", `${A}/users/${v.id}/permanent`, { cookie: s.cookie, body: {} }), sys.call("DELETE", `${A}/users/${v.id}/permanent`, { cookie: s.cookie, body: {} })]);
    check(del.some((x) => x.status === 200) && del.every((x) => x.status < 500), `M9 concurrent permanent deletes: one succeeds, none crashes (${del.map((x) => x.status)})`);
    check(!st.admin_mfa_credentials.some((x) => x.admin_user_id === v.id) && !st.admin_mfa_recovery_codes.some((x) => x.admin_user_id === v.id) && !st.admin_mfa_challenges.some((x) => x.admin_user_id === v.id), "M9 no orphaned factor, code or challenge rows remain");
    check(st.admin_mfa_credentials.some((x) => x.admin_user_id === bystander.id), "M9 another account's factor rows are untouched"); await sys.close(); }

  // ===== M10 step-up answers do not reveal which part was wrong; the wrong-password ceiling is independent of the sign-in budget
  { const sys = await boot({}, { loginMax: 100000 }); const u = await seed(sys, "su", "super_admin"); const s = await login(sys, u.email, u.password); const out = [];
    for (let i = 0; i < 14; i++) out.push(await sys.call("POST", `${A}/session/step-up`, { cookie: s.cookie, body: { password: WRONG + i, purpose: "security_policy_write" } }));
    check(out.slice(0, 10).every((r) => r.status === 401) && out.slice(10).every((r) => r.status === 429), "M10 ten wrong step-up passwords then 429, although the sign-in budget is 100000");
    eq(new Set(out.slice(0, 10).map((r) => r.text.replace(/"request_id":"[^"]*"/, ""))).size, 1, "M10 every wrong-password answer is identical"); await sys.close(); }

  // ===== M11 password spraying from one trusted address (many accounts, one password) is bounded; with no trusted proxy the control is off by design
  { const sys = await boot({ trustedProxyHops: 1, loginAddressFailureMax: 12 }, { loginMax: 100000 }); const out = [];
    for (let i = 0; i < 20; i++) out.push((await login(sys, `ghost${i}@spray.test`, "Summer2026!x", { "x-forwarded-for": "198.51.100.77" })).status);
    check(out.slice(0, 12).every((s) => s === 401) && out.slice(12).every((s) => s === 429), `M11 behind a trusted proxy one address spraying 20 accounts is stopped after 12 failures (${out.join(",")})`);
    const other = await login(sys, "ghost99@spray.test", "x", { "x-forwarded-for": "198.51.100.78" }); eq(other.status, 401, "M11 a different address is unaffected");
    await sys.close(); }
  { const sys = await boot({}, { loginMax: 100000 }); const out = []; for (let i = 0; i < 20; i++) out.push((await login(sys, `ghost${i}@spray.test`, "Summer2026!x")).status);
    check(out.every((s) => s === 401), "M11 without a trusted proxy the address-wide ceiling is OFF (all clients would share the proxy's address): no global lock-out lever"); await sys.close(); }

  // ===== M12 /healthz: posture public, business data and deployment inventory not
  { const sys = await boot({}, {}); const u = await seed(sys, "hz", "super_admin"); const s = await login(sys, u.email, u.password);
    const anon = await sys.call("GET", "/healthz", {}); check(anon.json && anon.json.stats === undefined && anon.json.tier1 === undefined, "M12 anonymous /healthz carries no business statistics and no deployment inventory");
    check(anon.json && anon.json.auth_config && anon.json.rate_limit && anon.json.session_revocation, "M12 …but still carries the readiness and security-posture codes");
    const authed = await sys.call("GET", "/healthz", { cookie: s.cookie }); check(authed.json && authed.json.stats && authed.json.tier1, "M12 a signed-in caller still gets the full operator view");
    const withKey = await sys.call("GET", "/healthz", { apiKey: sys.config.apiKeys[0] }); check(withKey.json && withKey.json.stats, "M12 an API key still gets the full operator view");
    const bad = await sys.call("GET", "/healthz", { cookie: "lead_agents_admin=garbage" }); check(bad.status === 200 && bad.json.stats === undefined, "M12 a bad cookie gets the anonymous view, not an error"); await sys.close(); }

  const failed = R.done(); process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
