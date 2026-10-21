"use strict";
// A10 - configuration states: production readiness and invalid session secrets (no weaker session may ever be issued or accepted), ephemeral secret outside
// production, API-key-as-password flag, administrator recovery (env only, no HTTP route), session TTL clamp, revocation switch, step-up TTL clamp, cookie name,
// canonical origin, secrets never in responses or logs.
const L = require("./a-lib");
const { P } = L;
const suite = L.createSuite("a10-config-states");
const STRONG_SECRET = () => `Prod-${L.rand(20)}-secret-${L.rand(8)}`; // >= 32 chars, not a placeholder
const SESS = "/api/lead-agents/admin/session";

suite.run(async (s) => {
  const prodSecretsLeak = (srv, extra = {}) => L.findLeaks(srv.logs(), { sessionSecret: srv.secrets.sessionSecret, apiKey: srv.secrets.apiKey, edge: srv.secrets.edgeToken, adminPassword: srv.secrets.adminPassword, ...extra });

  await s.section("production with a valid secret", async () => {
    const secret = STRONG_SECRET();
    const srv = await L.startServer(s, { env: { NODE_ENV: "production" }, secrets: { sessionSecret: secret } });
    const c = new L.Client(srv);
    const hz = await c.get("/healthz");
    s.check("A10-001", "/healthz is 200 ready with session_secret configured", hz.status === 200 && hz.body.ready === true && hz.body.auth_config.session_secret === "configured", hz.body && hz.body.auth_config);
    const lg = await L.login(c, srv.secrets.adminEmail, srv.secrets.adminPassword);
    const attrs = L.attrsOf(lg.setCookies[0] || "");
    s.check("A10-002", "production session cookie is Secure, HttpOnly, SameSite, Path=/", lg.status === 200 && attrs.secure === true && attrs.httponly === true && /lax|strict/i.test(attrs.samesite || "") && attrs.path === "/", lg.setCookies);
    const out = await c.post(P.logout, { cookie: lg.cookie, json: {} });
    s.check("A10-003", "production logout clears the cookie with the Secure attribute too", L.attrsOf(out.setCookies[0] || "").secure === true && L.attrsOf(out.setCookies[0] || "")["max-age"] === "0", out.setCookies);
    s.check("A10-004", "/healthz does not contain the session secret, API keys or the OpenAI key", L.findLeaks(hz.text, { s: secret, k: srv.secrets.apiKey, e: srv.secrets.edgeToken }).length === 0 && !/sk-dummy/.test(hz.text));
    const wrongEnv = await c.get(P.me, { cookie: L.mintToken("lead-agents-dev-session-secret", L.decodeToken(lg.cookie).claims) });
    s.check("A10-005", "production refuses a session signed with the historical public default", wrongEnv.status === 401);
    const rp = await L.adminSession(c, srv);
    const adminReset = await c.post(`${P.users}/${rp.user.id}/reset`, { cookie: rp.cookie, json: {}, headers: { "x-forwarded-host": "evil.example", host: "evil.example" } });
    s.check("A10-006", "production reset link uses the canonical Office origin even with forged Host / X-Forwarded-Host (default https://office.ochiga.com.ng)", adminReset.status === 201 && new URL(adminReset.body.reset_url).origin === "https://office.ochiga.com.ng", adminReset.body && adminReset.body.reset_url);
    s.check("A10-007", "production log has no secrets", prodSecretsLeak(srv).length === 0);
  });

  await s.section("production with an invalid session secret: fail closed, honest, no secret echoed", async () => {
    const apiKey32 = `apikey-${L.rand(20)}-${L.rand(4)}`; // 32+ chars, used both as API key and (wrongly) as session secret
    const edge32 = `edgetok-${L.rand(20)}-${L.rand(4)}`;
    const keyList = `${apiKey32},other-key-${L.rand(10)}`;
    const adminPw = "Boot-Password-" + L.rand(16) + "-end";
    const cases = [
      ["missing", { env: { LEAD_AGENTS_SESSION_SECRET: undefined } }, "session_secret_missing", ""],
      ["empty", { env: { LEAD_AGENTS_SESSION_SECRET: "" } }, "session_secret_missing", ""],
      ["31 characters", { env: { LEAD_AGENTS_SESSION_SECRET: "a".repeat(15) + "B" + "c".repeat(15) } }, "session_secret_too_short", "a".repeat(15) + "B" + "c".repeat(15)],
      ["placeholder (zeros)", { env: { LEAD_AGENTS_SESSION_SECRET: "0".repeat(40) } }, "session_secret_placeholder", "0".repeat(40)],
      ["placeholder (your-secret...)", { env: { LEAD_AGENTS_SESSION_SECRET: "your-secret-goes-here-" + "x".repeat(20) } }, "session_secret_placeholder", "your-secret-goes-here-" + "x".repeat(20)],
      ["placeholder (1234...)", { env: { LEAD_AGENTS_SESSION_SECRET: "1234" + L.rand(20) } }, "session_secret_placeholder", null],
      ["equal to an API key", { env: { LEAD_AGENTS_SESSION_SECRET: apiKey32, LEAD_AGENTS_API_KEYS: apiKey32 } }, "session_secret_shared_with_api_key", apiKey32],
      ["equal to the API key list", { env: { LEAD_AGENTS_SESSION_SECRET: keyList, LEAD_AGENTS_API_KEYS: keyList } }, "session_secret_shared_with_api_key", null],
      ["equal to an edge token", { env: { LEAD_AGENTS_SESSION_SECRET: edge32, OYI_EDGE_AGENT_TOKENS: edge32 } }, "session_secret_reused_bridge_secret", edge32],
      ["equal to the bootstrap admin password", { env: {}, secrets: { adminPassword: adminPw, sessionSecret: adminPw } }, "session_secret_reused_bridge_secret", adminPw],
    ];
    let n = 0;
    for (const [name, spec, code] of cases) {
      const env = spec.env;
      const srv = await L.startServer(s, { env: { NODE_ENV: "production", ...env }, secrets: spec.secrets || {} });
      const c = new L.Client(srv);
      const tag = `A10-02${n++}`;
      const hz = await c.get("/healthz");
      const problems = (hz.body && hz.body.auth_config && hz.body.auth_config.problems) || [];
      s.check(`${tag}a`, `[${name}] /healthz answers 503 ready:false with session_secret invalid${code ? ` and the code ${code}` : ""}`, hz.status === 503 && hz.body.ready === false && hz.body.auth_config.session_secret === "invalid" && (!code || problems.includes(code)), hz.body && hz.body.auth_config);
      const secretText = env.LEAD_AGENTS_SESSION_SECRET !== undefined ? env.LEAD_AGENTS_SESSION_SECRET : (spec.secrets ? spec.secrets.sessionSecret : "");
      s.check(`${tag}b`, `[${name}] /healthz never echoes the secret value`, !secretText || !hz.text.includes(secretText));
      const lg = await L.login(c, srv.secrets.adminEmail, srv.secrets.adminPassword);
      s.check(`${tag}c`, `[${name}] login is refused with 503 auth_configuration_invalid and no cookie`, lg.status === 503 && /auth_configuration_invalid/.test(lg.text) && lg.setCookies.length === 0, lg.status + " " + lg.text.slice(0, 120));
      const keyUsers = await c.get(P.users, { apiKey: String(env.LEAD_AGENTS_API_KEYS || srv.secrets.apiKey).split(",")[0] });
      s.check(`${tag}d`, `[${name}] API-key routes keep working (readiness failure is limited to human sessions)`, keyUsers.status === 200, keyUsers.status);
      // sessions signed with the invalid value must not be accepted, whatever the value is
      const admClaims = { email: srv.secrets.adminEmail, role: "super_admin", user_id: "x", permission_scopes: [], exp: Date.now() + 3600_000, sg: 0 };
      const store = L.readStore(srv); const adminRow = store && store.admin_users.find((u) => u.email === srv.secrets.adminEmail);
      const forged = L.mintToken(secretText, { ...admClaims, user_id: adminRow && adminRow.id });
      const me = await c.get(P.me, { cookie: forged });
      s.check(`${tag}e`, `[${name}] a session signed with the invalid configured value is NOT accepted`, me.status === 401, me.status);
      const usersWithForged = await c.get(P.users, { cookie: forged, apiKey: "wrong" });
      s.check(`${tag}f`, `[${name}] a forged session cannot reach protected routes`, usersWithForged.status === 401, usersWithForged.status);
      const su = await c.post(P.stepUp, { cookie: forged, json: { password: srv.secrets.adminPassword, purpose: "security_policy_write" } });
      s.check(`${tag}g`, `[${name}] step-up is unavailable (no grant is issued)`, su.status >= 400 && !(su.body && su.body.step_up), su.status);
      const inv = await c.post(P.inviteAccept, { json: { token: "x".repeat(20), password: L.STRONG() } });
      s.check(`${tag}h`, `[${name}] invitation acceptance answers 503 (cannot issue sessions)`, inv.status === 503, inv.status);
      s.check(`${tag}i`, `[${name}] log lists problem codes but never the secret value`, !secretText || secretText.length < 8 || !srv.logs().includes(secretText));
      void prodSecretsLeak;
      await srv.cleanup();
    }
  });

  await s.section("development: ephemeral secret, no fallback to API keys", async () => {
    const srv = await L.startServer(s, { env: { LEAD_AGENTS_SESSION_SECRET: undefined } });
    const c = new L.Client(srv);
    const hz = await c.get("/healthz");
    s.check("A10-040", "without a configured secret, development reports an ephemeral secret (healthz 200, session_secret ephemeral)", hz.status === 200 && hz.body.auth_config.session_secret === "ephemeral", hz.body && hz.body.auth_config);
    const a = await L.adminSession(c, srv);
    s.check("A10-041", "sessions work with the ephemeral secret", (await c.get(P.me, { cookie: a.cookie })).status === 200);
    for (const [name, key] of [["the API key", srv.secrets.apiKey], ["the joined API keys", `${srv.secrets.apiKey},${srv.secrets.apiKey2}`], ["the historical default", "lead-agents-dev-session-secret"], ["the empty string", ""]]) {
      const t = L.mintToken(key, L.decodeToken(a.cookie).claims);
      s.check(`A10-042-${name.replace(/\W+/g, "_")}`, `a session signed with ${name} is refused (no fallback secret)`, (await c.get(P.me, { cookie: t })).status === 401);
    }
    s.check("A10-043", "a warning about the ephemeral secret is logged", /session_secret_ephemeral/.test(srv.logs()));
    await srv.restart({});
    s.check("A10-044", "after a restart the ephemeral secret changes: the old session is refused", (await new L.Client(srv).get(P.me, { cookie: a.cookie })).status === 401);
  });

  await s.section("API-key-as-password flag", async () => {
    for (const [name, value] of [["TRUE", "TRUE"], ["1", "1"], ["yes", "yes"], ["True", "True"], [" true", " true"]]) {
      const srv = await L.startServer(s, { env: { LEAD_AGENTS_ALLOW_API_KEY_LOGIN: value } });
      const c = new L.Client(srv);
      const em = `fb-${L.rand(3)}@example.test`;
      const r = await L.login(c, em, srv.secrets.apiKey);
      s.check(`A10-050-${name.trim()}`, `LEAD_AGENTS_ALLOW_API_KEY_LOGIN="${value}" does not enable the legacy path (only exactly "true" does)`, r.status === 401 && !r.cookie, r.status);
      await srv.cleanup();
    }
    const srv = await L.startServer(s, { env: { LEAD_AGENTS_ALLOW_API_KEY_LOGIN: "true" } });
    const c = new L.Client(srv);
    const hz = await c.get("/healthz");
    s.check("A10-055", "transitional mode is visible in /healthz (enabled_deprecated)", hz.body.auth_config.api_key_password_login === "enabled_deprecated", hz.body.auth_config);
    s.check("A10-056", "transitional mode logs a startup warning", /api_key_password_login_enabled_deprecated/.test(srv.logs()));
    const em = `fb-${L.rand(3)}@example.test`;
    const r = await L.login(c, em, srv.secrets.apiKey);
    s.check("A10-057", "documented transitional behaviour: the API key as password creates an account and signs in", r.status === 200, r.status);
    const wrong = await L.login(c, `fb-${L.rand(3)}@example.test`, srv.secrets.apiKey + "x");
    s.check("A10-058", "even in transitional mode a wrong key is refused", wrong.status === 401);
    const adm = await L.adminSession(c, srv);
    const audit = (await c.get(P.audit, { cookie: adm.cookie })).body.audit || [];
    s.check("A10-059", "transitional use is audited (session_login_api_key_fallback) without the key", audit.some((a) => a.action === "session_login_api_key_fallback") && !JSON.stringify(audit).includes(srv.secrets.apiKey));
    s.check("A10-060", "the key is not in the log", !srv.logs().includes(srv.secrets.apiKey));
  });

  await s.section("administrator recovery (environment only)", async () => {
    const dir = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "a-rec-"));
    s.onCleanup(() => require("fs").rmSync(dir, { recursive: true, force: true }));
    const email = `rec-${L.rand(3)}@example.test`; const pwOld = L.STRONG(); const pwNew = L.STRONG();
    const secrets = { adminEmail: email, adminPassword: pwOld };
    const storePath = require("path").join(dir, "store.json");
    const srv = await L.startServer(s, { secrets, storePath, env: {} });
    const c = new L.Client(srv);
    const a = await L.adminSession(c, srv);
    const second = await L.login(c, email, pwOld);
    // restart with a DIFFERENT password but recovery off: nothing may change
    await srv.restart({ LEAD_AGENTS_ADMIN_PASSWORD: pwNew });
    s.check("A10-070", "with recovery OFF a restart with a new bootstrap password does not change the existing account's password", (await L.login(c, email, pwOld)).status === 200 && (await L.login(c, email, pwNew)).status === 401);
    const hz0 = await c.get("/healthz");
    s.check("A10-071", "/healthz reports admin_recovery disabled by default", hz0.body.auth_config.admin_recovery === "disabled");
    // weak recovery password refused
    await srv.restart({ LEAD_AGENTS_ADMIN_RECOVERY: "true", LEAD_AGENTS_ADMIN_PASSWORD: "short" });
    s.check("A10-072", "recovery with a weak password is refused: the existing password still works", (await L.login(c, email, pwOld)).status === 200);
    s.check("A10-073", "the refusal is logged (admin_recovery_refused) without the password", /admin_recovery_refused/.test(srv.logs()) && !srv.logs().includes('"short"'));
    // deactivate the account, then recover
    const adm = await L.login(c, email, pwOld);
    const me = await c.get(P.me, { cookie: adm.cookie });
    await c.patch(`${P.users}/${me.body.admin.id}`, { cookie: adm.cookie, json: { status: "inactive" } });
    s.check("A10-074", "the sole administrator can be deactivated (fixture for recovery)", (await L.login(c, email, pwOld)).status === 401);
    await srv.restart({ LEAD_AGENTS_ADMIN_RECOVERY: "true", LEAD_AGENTS_ADMIN_PASSWORD: pwNew });
    const rec = await L.login(c, email, pwNew);
    s.check("A10-075", "with recovery ON and a compliant password the account is reactivated with the new password", rec.status === 200 && rec.body.admin.role === "super_admin", rec.status);
    s.check("A10-076", "the old password no longer works after recovery", (await L.login(c, email, pwOld)).status === 401);
    s.check("A10-077", "sessions that existed before the recovery are ended", (await c.get(P.me, { cookie: second.cookie })).status === 401 && (await c.get(P.me, { cookie: adm.cookie })).status === 401);
    const hz1 = await c.get("/healthz");
    s.check("A10-078", "/healthz reports admin_recovery enabled while the flag is on", hz1.body.auth_config.admin_recovery === "enabled");
    const audit = (await c.get(P.audit, { cookie: rec.cookie })).body.audit || [];
    const recRows = audit.filter((x) => x.action === "admin_recovery_applied");
    s.check("A10-079", "recovery is audited (admin_recovery_applied) with the e-mail only, never the password", recRows.length >= 1 && !JSON.stringify(recRows).includes(pwNew) && !JSON.stringify(recRows).includes(pwOld), recRows.length);
    s.check("A10-080", "the recovery password is not in the log", !srv.logs().includes(pwNew));
    // the recovery affects only the one account
    const other = await L.makeUser(c, { cookie: rec.cookie }, { role: "ochiga_staff" });
    const otherCookie = other.cookie;
    await srv.restart({ LEAD_AGENTS_ADMIN_RECOVERY: "true", LEAD_AGENTS_ADMIN_PASSWORD: pwNew });
    s.check("A10-081", "recovery does not touch any other account (their session and password survive)", (await c.get(P.me, { cookie: otherCookie })).status === 200 && (await L.login(c, other.email, other.password)).status === 200);
    s.check("A10-081b", "each recovery ends the recovered account's existing sessions (a session taken before the second recovery is dead)", (await c.get(P.me, { cookie: rec.cookie })).status === 401);
    // there is no HTTP route that performs recovery
    const rec2 = await L.login(c, email, pwNew);
    const probes = ["recovery", "admin/recovery", "admin/session/recovery", "admin/recover", "admin/session/recover", "admin/bootstrap", "admin/session/bootstrap", "admin/break-glass", "admin/session/break-glass", "admin/reset-admin", "admin/session/admin-recovery", "admin/users/recovery", "admin/mfa/recovery", "admin/session/mfa/recovery", "admin/session/mfa/break-glass"];
    const hits = [];
    for (const p of probes) {
      for (const [name, o] of [["anonymous", {}], ["api key", { apiKey: srv.secrets.apiKey }], ["session", { cookie: rec2.cookie }]]) {
        for (const m of ["GET", "POST"]) {
          const r = await c.call(m, `/api/lead-agents/${p}`, { ...(m === "POST" ? { json: { email, password: L.STRONG(), recovery: true, confirm: true } } : {}), ...o });
          if (r.status >= 200 && r.status < 300) hits.push(`${m} ${p} ${name} ${r.status}`);
        }
      }
    }
    s.check("A10-082", "no HTTP route performs administrator recovery or break-glass (none of 15 probable paths answers 2xx for anonymous, API key or session)", hits.length === 0, hits);
    const flagViaHeader = await c.post(P.login, { json: { email, password: L.STRONG() }, headers: { "x-admin-recovery": "true", "x-recovery": "true" } });
    s.check("A10-083", "recovery cannot be triggered by a request header or body flag", flagViaHeader.status === 401);
    await srv.restart({});
    s.check("A10-084", "switching recovery off again leaves the recovered password in place", (await L.login(c, email, pwNew)).status === 200);
    void a;
  });

  await s.section("session lifetime and switches", async () => {
    const cases = [["garbage", "garbage", 168 * 3600, "defaulted"], ["zero", "0", 168 * 3600, "defaulted"], ["negative", "-5", 168 * 3600, "defaulted"], ["below one hour", "1000", 3600, "clamped"], ["above 720 hours", "99999999999", 720 * 3600, "clamped"], ["exactly 2 hours", String(2 * 3600_000), 2 * 3600, "ok"]];
    let n = 0;
    for (const [name, v, expectSec, status] of cases) {
      const srv = await L.startServer(s, { env: { LEAD_AGENTS_SESSION_TTL_MS: v } });
      const c = new L.Client(srv);
      const lg = await L.login(c, srv.secrets.adminEmail, srv.secrets.adminPassword);
      const attrs = L.attrsOf(lg.setCookies[0] || ""); const claims = L.decodeToken(lg.cookie).claims;
      s.check(`A10-09${n}a`, `LEAD_AGENTS_SESSION_TTL_MS=${name}: cookie Max-Age and token expiry are ${expectSec} s`, Number(attrs["max-age"]) === expectSec && Math.abs((claims.exp - Date.now()) / 1000 - expectSec) < 10, { maxAge: attrs["max-age"], exp: (claims.exp - Date.now()) / 1000 });
      const hz = await c.get("/healthz");
      s.check(`A10-09${n}b`, `LEAD_AGENTS_SESSION_TTL_MS=${name}: /healthz reports session_ttl ${status}`, hz.body.auth_config.session_ttl === status, hz.body.auth_config.session_ttl);
      n++; await srv.cleanup();
    }
    const off = await L.startServer(s, { env: { LEAD_AGENTS_SESSION_REVOCATION: "off" } });
    const c2 = new L.Client(off); const adm = await L.adminSession(c2, off);
    const hz = await c2.get("/healthz");
    s.check("A10-100", "revocation switch off is visible in /healthz (enforcement off)", hz.body.session_revocation.enforcement === "off", hz.body.session_revocation);
    const ra = await c2.post(`${SESS}/revoke-all`, { cookie: adm.cookie, json: {} });
    s.check("A10-101", "with the switch off, revoke-all answers 503 (never a silent success)", ra.status === 503, ra.status);
    const claims = L.decodeToken(adm.cookie).claims;
    s.check("A10-102", "with the switch off, tokens carry no generation claim (as documented rollback state)", claims.sg === undefined, claims);
    const u = await L.makeUser(c2, adm, { role: "ochiga_staff" });
    const pw = await c2.post(P.password, { cookie: u.cookie, json: { current_password: u.password, new_password: L.STRONG() } });
    s.check("A10-103", "with the switch off, password change still works (flows proceed, audited as skipped)", pw.status === 200, pw.status);
    const on = await L.startServer(s, {});
    const c3 = new L.Client(on); const adm3 = await L.adminSession(c3, on);
    const hz3 = await c3.get("/healthz");
    s.check("A10-104", "revocation enforcement is active by default", hz3.body.session_revocation.enforcement === "active" && hz3.body.session_revocation.capability === "available", hz3.body.session_revocation);
    for (const [name, v, max] of [["a day", String(24 * 3600_000), 600], ["huge", "99999999999", 600], ["garbage", "abc", 300]]) {
      const srv = await L.startServer(s, { env: { LEAD_AGENTS_STEP_UP_TTL_MS: v } });
      const c = new L.Client(srv); const ad = await L.adminSession(c, srv);
      const g = await L.stepUp(c, ad, "security_policy_write");
      s.check(`A10-105-${name}`, `LEAD_AGENTS_STEP_UP_TTL_MS=${name}: the grant lifetime is clamped to at most 10 minutes`, g.res.status === 200 && g.res.body.step_up.ttl_seconds <= max && g.res.body.step_up.ttl_seconds > 0, g.res.body && g.res.body.step_up && g.res.body.step_up.ttl_seconds);
      await srv.cleanup();
    }
    const cn = await L.startServer(s, { env: { LEAD_AGENTS_SESSION_COOKIE_NAME: "custom_sid" } });
    const c4 = new L.Client(cn);
    const lg = await c4.post(P.login, { json: { email: cn.secrets.adminEmail, password: cn.secrets.adminPassword } });
    const named = lg.setCookies.find((x) => x.startsWith("custom_sid="));
    s.check("A10-110", "a custom cookie name is used for the session cookie", Boolean(named) && !lg.setCookies.some((x) => x.startsWith(L.COOKIE_NAME + "=")), lg.setCookies);
    const tokenVal = decodeURIComponent(named.split(";")[0].split("=").slice(1).join("="));
    const viaCustom = await c4.get(P.me, { rawCookie: `custom_sid=${encodeURIComponent(tokenVal)}` });
    const viaDefault = await c4.get(P.me, { cookie: tokenVal });
    s.check("A10-111", "the session is accepted under the custom name and NOT under the default name", viaCustom.status === 200 && viaDefault.status === 401, [viaCustom.status, viaDefault.status]);
  });

  await s.section("canonical origin configuration failure", async () => {
    const srv = await L.startServer(s, { env: { OFFICE_APP_URL: "https://user:pw@office.example.test/path" } });
    const c = new L.Client(srv); const adm = await L.adminSession(c, srv);
    const u = await L.makeUser(c, adm, { role: "ochiga_staff", signIn: false });
    const r = await c.post(`${P.users}/${u.id}/reset`, { cookie: adm.cookie, json: {} });
    s.check("A10-120", "an invalid OFFICE_APP_URL makes link-issuing routes fail closed (503) rather than fall back to request headers", r.status === 503 && !r.body.reset_token && !r.body.reset_url, r.status + " " + r.text.slice(0, 160));
    s.check("A10-121", "the failure does not echo the configured credentials", !r.text.includes("user:pw") && !r.text.includes("pw@"), r.text.slice(0, 160));
    const neutral = await c.post(P.resetRequest, { json: { email: u.email } });
    s.check("A10-122", "the public reset request stays neutral (202) even when the link cannot be built", neutral.status === 202, neutral.status);
    const fwd = await L.startServer(s, { env: { OFFICE_APP_URL: undefined } });
    const cf = new L.Client(fwd); const af = await L.adminSession(cf, fwd);
    const uf = await L.makeUser(cf, af, { role: "ochiga_staff", signIn: false });
    const rf = await cf.post(`${P.users}/${uf.id}/reset`, { cookie: af.cookie, json: {}, headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" } });
    s.check("A10-123", "outside production with no canonical origin, links must not follow an attacker-controlled X-Forwarded-Host", rf.status !== 201 || new URL(rf.body.reset_url).host !== "evil.example", rf.body && rf.body.reset_url);
  });


  await s.section("step-up expiry and audit address integrity", async () => {
    const srv = await L.startServer(s, { env: { LEAD_AGENTS_STEP_UP_TTL_MS: "3000" } });
    const c = new L.Client(srv); const ad = await L.adminSession(c, srv);
    const g = await L.stepUp(c, ad, "security_policy_write");
    const chk = () => c.post(P.stepUpCheck, { cookie: ad.cookie, stepUp: g.token, json: { purpose: "security_policy_write" } });
    s.check("A10-130", "a fresh grant is valid (positive control)", (await chk()).status === 200);
    let expired = false; const dl = Date.now() + 20000;
    while (Date.now() < dl) { const r = await chk(); if (r.status === 403 && r.body.reason === "expired") { expired = true; break; } await L.sleep(300); }
    s.check("A10-131", "the grant is refused with reason expired once its lifetime passes", expired);
    const fake = await c.post(P.login, { json: { email: srv.secrets.adminEmail, password: "Wrong-passphrase-123" }, xff: "203.0.113.99" });
    const audit = (await c.get(P.audit, { cookie: ad.cookie })).body.audit || [];
    const l = await c.post(P.login, { json: { email: srv.secrets.adminEmail, password: srv.secrets.adminPassword }, xff: "6.6.6.6", headers: { "user-agent": "x".repeat(5000) } });
    const rows = ((await c.get(P.audit, { cookie: ad.cookie })).body.audit || []).filter((a) => a.action === "session_login" || a.action === "user.login");
    s.check("A10-132", "the audit trail does not record a client-forged X-Forwarded-For as the source address", !rows.some((a) => a.metadata && a.metadata.ip === "6.6.6.6"), rows.slice(0, 2).map((a) => a.metadata && a.metadata.ip));
    s.check("A10-133", "an oversized User-Agent is not stored unbounded in the audit trail", !rows.some((a) => a.metadata && String(a.metadata.user_agent || "").length > 1000), l.status);
    void fake; void audit;
  });
});
