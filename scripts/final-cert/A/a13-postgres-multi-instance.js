"use strict";
// A13 - real database (Postgres + PostgREST in disposable containers): several instances and two releases sharing one database, atomic revocation and single-use
// claims across instances, honest and fail-closed behaviour under injected database failures, no internal detail or secret in answers / logs, migration-absent mode,
// direct data-API access by anonymous / authenticated roles.
const L = require("./a-lib");
const { startPg } = require("./a-pg");
const { P } = L;
const suite = L.createSuite("a13-postgres-multi-instance");
const SESS = "/api/lead-agents/admin/session";
const INTERNAL_RE = /(status code|axios|ECONN|ETIMEDOUT|ENOTFOUND|postgres|PGRST|supabase|rest\/v1|authenticator|password authentication|172\.\d+\.|127\.0\.0\.1|localhost|timeout of|socket hang up|at [\w.<>$]+ \(|node_modules|\/Users\/|service_role|apikey|Bearer )/i;

suite.run(async (s) => {
  const pg = await startPg(s);
  const secrets = { sessionSecret: `sess-${L.rand(24)}`, apiKey: `key-${L.rand(16)}`, apiKey2: `key2-${L.rand(16)}`, edgeToken: `edge-${L.rand(16)}`, adminEmail: `boot-${L.rand(3)}@example.test`, adminPassword: L.STRONG() };
  const env = pg.env({ NODE_ENV: "production" });
  const n1 = await L.startServer(s, { secrets, env });
  const n2 = await L.startServer(s, { secrets, env });
  const hasOld = Boolean(L.SUT_OLD);
  const o1 = hasOld ? await L.startServer(s, { src: L.SUT_OLD, secrets, env }) : null;
  const c1 = new L.Client(n1), c2 = new L.Client(n2), co = o1 ? new L.Client(o1) : null;
  const admin = await L.adminSession(c1, n1);
  const me = (client, cookie) => client.get(P.me, { cookie });
  const allNeedles = () => ({ serviceKey: pg.key, jwtSecret: pg.jwtSecret, pgPassword: pg.pgPassword, sessionSecret: secrets.sessionSecret, apiKey: secrets.apiKey, adminPassword: secrets.adminPassword });

  await s.section("fixture sanity", async () => {
    for (const [n, sv] of [["instance 1", n1], ["instance 2", n2], ...(o1 ? [["previous release", o1]] : [])]) {
      const hz = await new L.Client(sv).get("/healthz");
      s.check(`A13-00-${n}`, `${n} is ready against the database (healthz 200, revocation capability available)`, hz.status === 200 && hz.body.session_revocation.capability === "available", hz.body && hz.body.session_revocation);
    }
  });

  await s.section("sessions across instances sharing one database", async () => {
    const u = await L.makeUser(c1, admin, { role: "ochiga_staff" });
    const onN2 = await L.login(c2, u.email, u.password);
    s.check("A13-010", "an account created and signed in on instance 1 signs in on instance 2", onN2.status === 200);
    s.check("A13-011", "a cookie issued by instance 1 works on instance 2 and on the previous release", (await me(c2, u.cookie)).status === 200 && (!co || (await me(co, u.cookie)).status === 200));
    const lo = await c1.post(P.logout, { cookie: u.cookie, json: {} });
    s.check("A13-012", "logout on instance 1 revokes durably (revoked:true)", lo.body.revoked === true, lo.body);
    s.check("A13-013", "the copied cookie is refused on instance 1 AND on instance 2 (revocation lives in the database)", (await me(c1, u.cookie)).status === 401 && (await me(c2, u.cookie)).status === 401);
    s.check("A13-014", "another session of the same account survives on both instances", (await me(c1, onN2.cookie)).status === 200 && (await me(c2, onN2.cookie)).status === 200);
    if (co) console.log(`INFO A13 the previous release does not consult per-session revocation records: the logged-out cookie is ${(await me(co, u.cookie)).status === 200 ? "STILL ACCEPTED" : "refused"} there (documented mixed-version limitation)`);
    const ra = await c2.post(`${SESS}/revoke-all`, { cookie: onN2.cookie, json: {} });
    s.check("A13-015", "revoke-all on instance 2 succeeds", ra.status === 200, ra.text.slice(0, 120));
    const fresh = await L.login(c1, u.email, u.password);
    s.check("A13-016", "after revoke-all on instance 2, instance 1 issues sessions at the new generation and refuses the old one", fresh.status === 200 && (await me(c1, onN2.cookie)).status === 401 && L.decodeToken(fresh.cookie).claims.sg === ra.body.session_generation);
    if (co) s.check("A13-017", "the previous release enforces account-wide revocation from the shared database (generation), so it refuses the revoked cookie", (await me(co, onN2.cookie)).status === 401);
    const pwOld = u.password; const np = L.STRONG();
    const ch = await c2.post(P.password, { cookie: fresh.cookie, json: { current_password: pwOld, new_password: np } });
    s.check("A13-018", "password change on instance 2 succeeds and re-issues a cookie", ch.status === 200 && ch.cookie);
    s.check("A13-019", "the cookie used for the change is dead on instance 1 (and on the previous release)", (await me(c1, fresh.cookie)).status === 401 && (!co || (await me(co, fresh.cookie)).status === 401));
    s.check("A13-020", "the re-issued cookie works on instance 1", (await me(c1, ch.cookie)).status === 200);
    const d = await c1.patch(`${P.users}/${u.id}`, { cookie: admin.cookie, json: { status: "inactive" } });
    s.check("A13-021", "deactivating on instance 1 ends the session on instance 2 and the previous release at once", d.status === 200 && (await me(c2, ch.cookie)).status === 401 && (!co || (await me(co, ch.cookie)).status === 401));
    await c1.patch(`${P.users}/${u.id}`, { cookie: admin.cookie, json: { status: "active" } });
    s.check("A13-022", "restoring does not revive the old session on any instance", (await me(c2, ch.cookie)).status === 401 && (!co || (await me(co, ch.cookie)).status === 401));
    if (co) {
      const old = await L.login(co, u.email, np);
      const loOld = await c1.post(P.logout, { cookie: old.cookie, json: {} });
      s.check("A13-023", "a session issued by the previous release (no session id) is answered honestly at logout on the new release (revoked:false, not_individually_revocable)", loOld.body.revoked === false && loOld.body.reason === "not_individually_revocable", loOld.body);
    }
  });

  await s.section("single-use tokens and atomicity across instances", async () => {
    const u = await L.makeUser(c1, admin, { role: "ochiga_staff", signIn: false });
    const iss = await c1.post(`${P.users}/${u.id}/reset`, { cookie: admin.cookie, json: {} });
    const pws = Array.from({ length: 12 }, () => L.STRONG());
    const results = await Promise.all(pws.map((p, i) => (i % 2 ? c1 : c2).post(P.resetConfirm, { json: { token: iss.body.reset_token, new_password: p } })));
    const winners = results.map((r, i) => (r.status === 200 ? i : -1)).filter((i) => i >= 0);
    s.check("A13-030", "12 simultaneous confirmations of one reset token spread over two instances yield exactly one success", winners.length === 1 && results.every((r) => r.status === 200 || r.status === 400), results.map((r) => r.status));
    const logins = await Promise.all(pws.map((p) => L.login(c1, u.email, p)));
    s.check("A13-031", "exactly the winner's password works", logins.filter((r) => r.status === 200).length === 1 && logins[winners[0]].status === 200);
    const email = `inv-${L.rand(3)}@example.test`;
    const inv = await c1.post(P.invite, { cookie: admin.cookie, json: { email, role: "ochiga_staff" } });
    const tok = new URL(inv.body.invite_url).searchParams.get("token");
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? c1 : c2).post(P.inviteAccept, { json: { token: tok, password: L.STRONG() } })));
    s.check("A13-032", "10 simultaneous acceptances of one invitation across two instances yield exactly one session", rs.filter((r) => r.status === 200).length === 1, rs.map((r) => r.status));
    const target = await L.makeUser(c1, admin, { role: "ochiga_staff" });
    const sessions = []; for (let i = 0; i < 8; i++) sessions.push(await L.login(i % 2 ? c1 : c2, target.email, target.password));
    const revs = await Promise.all(sessions.map((x, i) => (i % 2 ? c2 : c1).post(`${SESS}/revoke-all`, { cookie: x.cookie, json: {} })));
    const gens = revs.filter((r) => r.status === 200).map((r) => r.body.session_generation);
    s.check("A13-033", "8 simultaneous revocations over two instances produce distinct generations (no lost update in the database)", new Set(gens).size === gens.length && gens.length >= 1, { gens: gens.sort((a, b) => a - b), statuses: revs.map((r) => r.status) });
    const racer = await L.makeUser(c1, admin, { role: "ochiga_staff" });
    const newPws = Array.from({ length: 6 }, () => L.STRONG());
    const sess = []; for (let i = 0; i < 6; i++) sess.push(await L.login(i % 2 ? c1 : c2, racer.email, racer.password));
    const changes = await Promise.all(sess.map((x, i) => (i % 2 ? c2 : c1).post(P.password, { cookie: x.cookie, json: { current_password: racer.password, new_password: newPws[i] } })));
    const okIdx = changes.map((r, i) => (r.status === 200 ? i : -1)).filter((i) => i >= 0);
    const works = await Promise.all(newPws.map((p) => L.login(c1, racer.email, p)));
    const oldWorks = await L.login(c1, racer.email, racer.password);
    s.check("A13-034", "racing password changes leave exactly ONE valid password (never two, never the old one) and no 5xx", works.filter((r) => r.status === 200).length === 1 && oldWorks.status === 401 && changes.every((r) => r.status < 500), { ok: okIdx, statuses: changes.map((r) => r.status), valid: works.map((r) => r.status) });
    const survivors = (await Promise.all(sess.map((x) => me(c2, x.cookie)))).filter((r) => r.status === 200).length;
    s.check("A13-035", "after racing password changes none of the pre-change cookies survives", survivors === 0, { survivors, winners: okIdx.length });
  });

  await s.section("direct data-API access with the public roles", async () => {
    const tables = ["admin_users", "admin_invites", "password_reset_tokens", "audit_events", "admin_revoked_sessions", "admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_mfa_challenges", "office_runtime_settings"];
    for (const t of tables) {
      for (const [name, key] of [["no key", null], ["anon", pg.anonKey], ["authenticated", pg.authKey]]) {
        const r = await pg.rest(`/${t}?select=*&limit=5`, { key });
        const leaked = r.status === 200 && Array.isArray(r.json) && r.json.length > 0;
        s.check(`A13-04-${t}-${name.replace(" ", "")}`, `${name} role reading ${t} through the data API gets no rows`, !leaked, { status: r.status, rows: Array.isArray(r.json) ? r.json.length : r.text.slice(0, 80) });
      }
    }
    for (const [fn, args] of [["office_revoke_admin_sessions", { p_user_id: admin.user.id, p_actor: "x", p_reason: null }], ["office_is_session_revoked", { p_digest: "x".repeat(32) }], ["office_revoke_session", { p_digest: "y".repeat(32), p_user_id: admin.user.id, p_expires_at: "2099-01-01" }], ["office_admin_update_revoking_sessions", { p_user_id: admin.user.id, p_actor: "x", p_patch: { status: "inactive" } }]]) {
      const r = await pg.rest(`/rpc/${fn}`, { method: "POST", key: pg.anonKey, body: args });
      s.check(`A13-05-${fn}`, `anon role cannot execute ${fn} (denied)`, r.status === 401 || r.status === 403 || r.status === 404, { status: r.status, body: r.text.slice(0, 100) });
    }
    for (const [name, key] of [["anon", pg.anonKey], ["authenticated", pg.authKey]]) {
      const planted = `planted-${L.rand(3)}@example.test`;
      const patch = await pg.rest(`/admin_users?id=eq.${admin.user.id}`, { method: "PATCH", key, body: { status: "inactive", role: "viewer" }, headers: { Prefer: "return=representation" } });
      const ins = await pg.rest(`/admin_users`, { method: "POST", key, body: { email: planted, password_hash: "00:00", role: "super_admin", status: "active" }, headers: { Prefer: "return=representation" } });
      const delAudit = await pg.rest(`/audit_events?id=not.is.null`, { method: "DELETE", key, headers: { Prefer: "return=representation" } });
      const delTok = await pg.rest(`/password_reset_tokens?id=not.is.null`, { method: "DELETE", key, headers: { Prefer: "return=representation" } });
      const after = await pg.rest(`/admin_users?id=eq.${admin.user.id}&select=status,role`);
      const plantedRow = await pg.rest(`/admin_users?email=eq.${planted}&select=id`);
      const wrote = (r) => r.status >= 200 && r.status < 300 && Array.isArray(r.json) && r.json.length > 0;
      s.check(`A13-057-${name}`, `${name} role cannot modify the administrator account through the data API`, !wrote(patch) && after.json && after.json[0] && after.json[0].status === "active" && after.json[0].role === "super_admin", { patch: patch.status, after: after.json });
      s.check(`A13-058-${name}`, `${name} role cannot insert an administrator account through the data API`, !wrote(ins) && Array.isArray(plantedRow.json) && plantedRow.json.length === 0, { ins: ins.status, rows: plantedRow.json });
      s.check(`A13-059-${name}`, `${name} role cannot delete audit rows or reset-token rows through the data API`, !wrote(delAudit) && !wrote(delTok), { audit: delAudit.status, tokens: delTok.status });
      // repair the disposable database so the remaining sections still test what they intend (done with the service key; the failed checks above stay failed)
      await pg.rest(`/admin_users?id=eq.${admin.user.id}`, { method: "PATCH", body: { status: "active", role: "super_admin" } });
      await pg.rest(`/admin_users?email=eq.${planted}`, { method: "DELETE" });
    }
    s.check("A13-056", "the administrator was not deactivated or revoked by the anonymous RPC attempts", (await me(c1, admin.cookie)).status === 200);
  });

  await s.section("injected database failures: fail closed, honest, no internal detail", async () => {
    const u = await L.makeUser(c1, admin, { role: "ochiga_staff" });
    const su = await L.makeUser(c1, admin, { role: "super_admin" });
    const modes = {
      "503 with Postgres detail": { kind: "status", status: 503, body: { code: "PGRST000", message: "Database connection error", details: `connection to server at "a-pg-db" (172.21.0.2), port 5432 failed: FATAL: password authentication failed for user "authenticator"` } },
      "500 with SQL error": { kind: "status", status: 500, body: { code: "42P01", message: 'relation "public.admin_users" does not exist', details: "service_role", hint: null } },
      "connection dropped": { kind: "drop" },
      "HTML error page": { kind: "html" },
      "garbage body": { kind: "garbage" },
      "401 from the data API": { kind: "status", status: 401, body: { message: "JWT expired", code: "PGRST303" } },
    };
    let n = 0;
    for (const [name, mode] of Object.entries(modes)) {
      const tag = `A13-06${n++}`;
      pg.fault(mode);
      const meR = await me(c1, u.cookie);
      const users = await c1.get(P.users, { cookie: su.cookie });
      const login = await L.login(c1, u.email, u.password);
      const keyRoute = await c1.get(P.users, { apiKey: secrets.apiKey });
      const reset = await c1.post(P.resetRequest, { json: { email: u.email } });
      const revokeAll = await c1.post(`${SESS}/revoke-all`, { cookie: u.cookie, json: {} });
      const logout = await c1.post(P.logout, { cookie: u.cookie, json: {} });
      const pw = await c1.post(P.password, { cookie: u.cookie, json: { current_password: u.password, new_password: L.STRONG() } });
      pg.heal();
      s.check(`${tag}a`, `[${name}] a valid cookie is NOT accepted while the account cannot be verified (503 session_verification_unavailable, never 200)`, meR.status === 503 && /session_verification_unavailable/.test(meR.text), meR.status + " " + meR.text.slice(0, 100));
      s.check(`${tag}b`, `[${name}] a protected route with a valid cookie answers 503/401, never data`, users.status === 503 || users.status === 401, users.status);
      s.check(`${tag}c`, `[${name}] sign-in fails closed with a generic 503 and no cookie`, login.status === 503 && !login.cookie && !INTERNAL_RE.test(login.text), login.status + " " + login.text.slice(0, 120));
      s.check(`${tag}d`, `[${name}] the password-reset request stays neutral or fails generically, with no internal detail`, (reset.status === 202 || reset.status >= 500) && !INTERNAL_RE.test(reset.text), reset.status + " " + reset.text.slice(0, 120));
      s.check(`${tag}e`, `[${name}] revoke-all fails closed (never 200) without internal detail`, revokeAll.status >= 500 || revokeAll.status === 401, revokeAll.status + " " + revokeAll.text.slice(0, 120));
      s.check(`${tag}f`, `[${name}] the failure answers of logout, revoke-all, password change and API routes carry no internal detail`, ![logout, revokeAll, pw, users, keyRoute, meR].some((r) => INTERNAL_RE.test(r.text)), [logout, revokeAll, pw, users, keyRoute, meR].filter((r) => INTERNAL_RE.test(r.text)).map((r) => r.text.slice(0, 160)));
      s.check(`${tag}g`, `[${name}] logout does not claim a revocation it could not make (never {revoked:true})`, !(logout.body && logout.body.revoked === true), logout.body);
      s.check(`${tag}h`, `[${name}] a password change that cannot be verified or stored is not reported as success`, pw.status !== 200, pw.status);
      s.check(`${tag}i`, `[${name}] the server stays up and recovers when the database returns (cookie works again without restart)`, n1.alive() && (await me(c1, u.cookie)).status === 200);
      s.check(`${tag}j`, `[${name}] after recovery the ORIGINAL password still works (no half-applied change)`, (await L.login(c1, u.email, u.password)).status === 200);
    }
    s.check("A13-070", "no key, secret or database credential appears in either instance's log after the failures", L.findLeaks(n1.logs(), allNeedles()).length === 0 && L.findLeaks(n2.logs(), allNeedles()).length === 0, L.findLeaks(n1.logs(), allNeedles()));
    s.check("A13-071", "the log contains no database host names / addresses from the injected errors", !/172\.21\.0\.2|a-pg-db|authenticator/.test(n1.logs()), (n1.logs().match(/.{40}(172\.21\.0\.2|a-pg-db|authenticator).{20}/) || [""])[0]);
  });

  await s.section("selective failures of single store operations", async () => {
    const u = await L.makeUser(c1, admin, { role: "ochiga_staff" });
    const fail = (re, kind = "status", extra = {}) => ({ kind, status: 503, match: (m, url) => re.test(`${m} ${url.split("?")[0]}`), ...extra });
    // the per-session revocation lookup
    pg.fault(fail(/POST \/rpc\/office_is_session_revoked/));
    const lookup = await me(c1, u.cookie);
    pg.heal();
    s.check("A13-080", "if the session-revocation lookup fails, a session that carries a session id is refused with 503 (an unanswerable lookup is never 'not revoked')", lookup.status === 503, lookup.status + " " + lookup.text.slice(0, 100));
    // logout write fails
    pg.fault(fail(/POST \/rpc\/office_revoke_session$/));
    const lo = await c1.post(P.logout, { cookie: u.cookie, json: {} });
    pg.heal();
    s.check("A13-081", "if the logout write fails: 503 logout_not_confirmed, revoked:false, cookie cleared, no internal detail", lo.status === 503 && lo.body.revoked === false && lo.body.error === "logout_not_confirmed" && L.attrsOf(lo.setCookies[0] || "")["max-age"] === "0" && !INTERNAL_RE.test(lo.text), lo.status + " " + lo.text.slice(0, 160));
    s.check("A13-082", "after the failed logout the copied cookie is (honestly) still valid, and a retry of logout then revokes it", (await me(c1, u.cookie)).status === 200 && (await c1.post(P.logout, { cookie: u.cookie, json: {} })).body.revoked === true && (await me(c1, u.cookie)).status === 401);
    // credential update RPC fails: password change must fail closed, reset token must be released
    const v = await L.makeUser(c1, admin, { role: "ochiga_staff" });
    const iss = await c1.post(`${P.users}/${v.id}/reset`, { cookie: admin.cookie, json: {} });
    pg.fault({ kind: "status", status: 503, match: (m, url, body) => /POST \/rpc\/office_admin_update_revoking_sessions/.test(`${m} ${url.split("?")[0]}`) && !body.includes("00000000-0000-0000-0000-000000000000") });
    const np = L.STRONG();
    const rc = await c1.post(P.resetConfirm, { json: { token: iss.body.reset_token, new_password: np } });
    const pc = await c1.post(P.password, { cookie: v.cookie, json: { current_password: v.password, new_password: L.STRONG() } });
    pg.heal();
    s.check("A13-083", "if the atomic credential update fails, reset confirmation fails closed (not 200) without internal detail", rc.status >= 500 && !INTERNAL_RE.test(rc.text), rc.status + " " + rc.text.slice(0, 140));
    s.check("A13-084", "if the atomic credential update fails, password change fails closed (not 200) without internal detail", pc.status >= 500 && !INTERNAL_RE.test(pc.text), pc.status + " " + pc.text.slice(0, 140));
    s.check("A13-085", "the old password is still the only valid one and the user's session survives", (await L.login(c1, v.email, v.password)).status === 200 && (await me(c1, v.cookie)).status === 200);
    const retry = await c1.post(P.resetConfirm, { json: { token: iss.body.reset_token, new_password: np } });
    s.check("A13-086", "the reset token was released after the failed write: the same token works once the database is back", retry.status === 200, retry.status + " " + retry.text.slice(0, 100));
    // audit sink failure
    pg.fault(fail(/POST \/audit_events/));
    const lg = await L.login(c1, v.email, np);
    pg.heal();
    s.check("A13-087", "if the audit sink is down, sign-in either fails closed or succeeds, but never with internal detail in the answer", !INTERNAL_RE.test(lg.text), lg.status + " " + lg.text.slice(0, 160));
    console.log(`INFO A13 audit sink down: sign-in answered ${lg.status} (${lg.status === 200 ? "session issued without a durable login audit row" : "refused"})`);
    // bootstrap read of the account fails only for the lookup by e-mail
    pg.fault(fail(/GET \/admin_users$/));
    const lgf = await L.login(c1, v.email, np);
    pg.heal();
    s.check("A13-088", "if only the account lookup fails, sign-in answers a generic 503 (sign_in_unavailable)", lgf.status === 503 && /sign_in_unavailable/.test(lgf.text), lgf.status + " " + lgf.text.slice(0, 100));
  });

  await s.section("timeouts and hard outage", async () => {
    const u = await L.makeUser(c1, admin, { role: "ochiga_staff" });
    pg.fault({ kind: "hang", ms: 30000 });
    const t0 = Date.now();
    const lg = await L.login(c1, u.email, u.password);
    const took = Date.now() - t0;
    pg.heal();
    s.check("A13-090", "a hanging database does not hang sign-in indefinitely: a generic 503 within the configured request timeout (4 s) plus slack", lg.status === 503 && took < 15000 && !INTERNAL_RE.test(lg.text), { status: lg.status, took });
    pg.fault({ kind: "hang", ms: 30000 });
    const t1 = Date.now();
    const m = await me(c1, u.cookie);
    pg.heal();
    s.check("A13-091", "a hanging database makes a valid cookie unverifiable: 503 within the timeout, never 200", m.status === 503 && Date.now() - t1 < 15000, { status: m.status, took: Date.now() - t1 });
    pg.stopRest();
    const down = await me(c1, u.cookie); const dl = await L.login(c1, u.email, u.password); const dk = await c1.get(P.users, { apiKey: secrets.apiKey });
    s.check("A13-092", "with the data API down (connection refused) cookies and logins fail closed (503) and answers carry no internal detail", down.status === 503 && dl.status === 503 && !INTERNAL_RE.test(down.text + dl.text + dk.text), [down.status, dl.status, dk.status, (down.text + dl.text + dk.text).slice(0, 200)]);
    const hz = await new L.Client(n1).get("/healthz");
    s.check("A13-093", "/healthz during the outage does not expose database internals", !INTERNAL_RE.test(hz.text) || hz.status >= 500, hz.status + " " + hz.text.slice(0, 160));
    pg.startRest();
    let back = false; const deadline = Date.now() + 60000;
    while (Date.now() < deadline) { try { if ((await me(c1, u.cookie)).status === 200) { back = true; break; } } catch { /* retry */ } await L.sleep(500); }
    s.check("A13-094", "after the database returns, the same cookie works again without restarting the server", back);
    s.check("A13-095", "no secret or key in the logs after the outage", L.findLeaks(n1.logs(), allNeedles()).length === 0);
    s.check("A13-096", "all instances survived the failures", n1.alive() && n2.alive() && (!o1 || o1.alive()));
  });

  await s.section("per-session revocation migration absent (capability probe), then applied", async () => {
    const r = pg.sql("drop function if exists office_session_revocation_version(); drop function if exists office_revoke_session(text, uuid, timestamptz); drop function if exists office_is_session_revoked(text);");
    for (let i = 0; i < 60; i++) { pg.reloadSchema(); const probe = await pg.rest("/rpc/office_session_revocation_version", { method: "POST", body: {} }); if (probe.status === 404) break; await L.sleep(500); }
    s.check("A13-100", "fixture: the logout-revocation functions can be removed to simulate a missing migration", r.ok, r.err);
    const n3 = await L.startServer(s, { secrets, env });
    const c3 = new L.Client(n3);
    const admin3 = await L.adminSession(c3, n3);
    const u = await L.makeUser(c3, admin3, { role: "ochiga_staff" });
    const claims = L.decodeToken(u.cookie).claims;
    s.check("A13-101", "without the migration, new sessions carry no session id (token exactly as before)", claims.sid === undefined, claims);
    const lo = await c3.post(P.logout, { cookie: u.cookie, json: {} });
    s.check("A13-102", "without the migration, logout is honest: revoked:false, reason not_individually_revocable (never a false success)", lo.status === 200 && lo.body.revoked === false && lo.body.reason === "not_individually_revocable", lo.body);
    s.check("A13-103", "without the migration, account-wide sign-out still works", (await c3.post(`${SESS}/revoke-all`, { cookie: u.cookie, json: {} })).status === 200 && (await me(c3, u.cookie)).status === 401);
    const mig = pg.applyMigration("20261026_admin_revoked_sessions.sql");
    // harness readiness: wait until the data API's schema cache knows the function again (explicit condition, not a fixed sleep)
    for (let i = 0; i < 60; i++) { pg.reloadSchema(); const probe = await pg.rest("/rpc/office_session_revocation_version", { method: "POST", body: {} }); if (probe.status === 200) break; await L.sleep(1000); }
    s.check("A13-104", "fixture: the migration re-applies cleanly", !/ERROR/.test(mig.stderr || ""), mig.stderr);
    let sid = false; const dl = Date.now() + 90000;
    while (Date.now() < dl) { const x = await L.login(c3, u.email, u.password); if (x.cookie && L.decodeToken(x.cookie).claims.sid) { sid = true; u.cookie2 = x.cookie; break; } await L.sleep(2000); }
    s.check("A13-105", "once the migration is applied, the running instance starts issuing revocable sessions (within its 60 s probe cache)", sid);
    if (sid) {
      const lo2 = await c3.post(P.logout, { cookie: u.cookie2, json: {} });
      s.check("A13-106", "and logout then revokes durably", lo2.body.revoked === true && (await me(c3, u.cookie2)).status === 401 && (await me(c1, u.cookie2)).status === 401, lo2.body);
    }
  });

  s.check("A13-990", "no database credential appears in any instance log", [n1, n2, ...(o1 ? [o1] : [])].every((x) => L.findLeaks(x.logs(), allNeedles()).length === 0));
  s.check("A13-999", "instances alive at the end", n1.alive() && n2.alive(), { n1: n1.exitInfo(), n2: n2.exitInfo(), tail1: n1.alive() ? "" : n1.logs().slice(-700), tail2: n2.alive() ? "" : n2.logs().slice(-700) });
});
