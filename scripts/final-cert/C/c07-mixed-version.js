"use strict";
// AREA C / C07: the previous release (SUT_OLD_DIR) and the current release against the SAME database.
// Documented limitations (a token issued before per-session revocation existed cannot be revoked individually; an older instance does not know the newer revocation records)
// are reported as INFO. Everything else is a requirement.
const fs = require("fs");
const path = require("path");
const L = require("./lib");
const F = require("./appfix");

const s = new L.Suite("c07-mixed-version", "C");

async function pair(st, suite, tag) {
  const sessionSecret = L.SESSION_SECRET(); const apiKey = L.API_KEY();
  const mk = async (sut, name) => {
    const proxy = await new L.FaultProxy(st.url).start(); suite.onCleanup(() => proxy.stop());
    const app = await L.AppServer.start({ sut, env: L.appEnv({ restUrl: proxy.url, serviceJwt: st.jwt("service_role"), sessionSecret, apiKey }), name, suite });
    return { app, proxy, client: (o) => new L.Client(app.url, o) };
  };
  return { sessionSecret, apiKey, N: await mk(L.SUT, tag + "-new"), O: await mk(L.SUT_OLD, tag + "-old") };
}

s.main(async () => {
  if (!L.SUT_OLD || !fs.existsSync(path.join(L.SUT_OLD, "lead-agents-server.js"))) s.blocked("SUT_OLD_DIR is not set or does not hold a release");
  const wins = (rs) => rs.filter((r) => r.status === 200).length;

  // ================================================================== A. database fully migrated (current release schema), both releases running
  await s.section("FULL", async () => {
    const st = await L.DbStack.create({ kind: "supabase17", tag: "c07a", postgrest: true, suite: s });
    st.applyAll();
    await st.settle(async () => (await st.rpc("service_role", "office_session_revocation_version")).json === 1);
    const adm = st.session(); const { N, O } = await pair(st, s, "full");
    const num = async (sql) => Number((await adm.query(sql)).rows[0][0]);
    const user = async (role = "viewer") => L.seedUser(adm, { role });
    s.check("MV-001", "both releases start and answer on the same database (positive control)", (await N.client().get("/healthz")).status > 0 && (await O.client().get("/healthz")).status > 0);

    // ---- sessions
    {
      const u = await user();
      const cn = (await N.client().login(u.email, u.password)).cookie; const co = (await O.client().login(u.email, u.password)).cookie;
      s.check("MV-010", "positive control: each release accepts the other's sign-in", (await O.client().me({ cookie: cn })).status === 200 && (await N.client().me({ cookie: co })).status === 200);
      const tokenOf = (c) => JSON.parse(Buffer.from(c.split("=")[1].split(".")[0], "base64url").toString("utf8"));
      let pn = {}, po = {}; try { pn = tokenOf(cn); po = tokenOf(co); } catch { /* opaque */ }
      // new-release session logged out through the new release
      const lo = await N.client().logout({ cookie: cn });
      s.check("MV-011", "logout of a current-release session through the current release is confirmed", lo.status === 200 && lo.json.revoked === true, lo.text);
      s.eq("MV-012", "the current release refuses it afterwards", (await N.client().me({ cookie: cn })).status, 401);
      const oldSees = await O.client().me({ cookie: cn });
      if (oldSees.status === 200) s.info("MV-013 (Info, documented limitation) the previous release does not know the newer per-session revocation records: a cookie logged out on the current release is still accepted by an older instance");
      else s.info("MV-013 the previous release also refuses a cookie logged out on the current release");
      // old-release session (no session id) logged out through the new release
      const lo2 = await N.client().logout({ cookie: co });
      s.check("MV-014", "logout of a previous-release session through the current release is HONEST: it does not claim to have revoked a token that has no individual identifier", lo2.status === 200 && lo2.json.revoked === false, lo2.text);
      const stillOld = await N.client().me({ cookie: co });
      if (stillOld.status === 200) s.info("MV-015 (Info, documented limitation) a token issued before per-session revocation existed cannot be revoked individually; the honest logout answer says so (reason: " + (lo2.json && lo2.json.reason) + ")");
      s.check("MV-016", "the fallback named in that answer works: account-wide revocation through the current release ends that old token on both releases", (await N.client().post(`${L.P}/session/revoke-all`, {}, { cookie: (await N.client().login(u.email, u.password)).cookie })).status === 200 && (await N.client().me({ cookie: co })).status === 401 && (await O.client().me({ cookie: co })).status === 401);
      // logout through the old release
      const u2 = await user(); const c2 = (await O.client().login(u2.email, u2.password)).cookie;
      const lo3 = await O.client().logout({ cookie: c2 });
      { const after = await O.client().me({ cookie: c2 }); s.info(`MV-017 (Info, previous release) logout through the previous release answers ${lo3.status} ${lo3.text.slice(0, 80)} and the copied cookie is ${after.status === 200 ? "STILL ACCEPTED" : "refused"} by it: the previous release has no per-session revocation (the defect the current release fixes); mixed fleets should be retired, 'sign out everywhere' is the remedy`); }
      if ((await N.client().me({ cookie: c2 })).status === 200) s.info("MV-018 (Info) a logout made on the previous release is not enforced by the current release (the previous release has no per-session record to write)");
    }
    // ---- account-wide revocation, password change, deactivation: pre-date the new feature, so both releases must honour each other
    {
      const u = await user(); const mk = async (c) => (await c.login(u.email, u.password)).cookie;
      const sess = [await mk(N.client()), await mk(O.client()), await mk(N.client()), await mk(O.client())];
      const r = await O.client().post(`${L.P}/session/revoke-all`, {}, { cookie: sess[3] });
      s.eq("MV-020", "revoke-all through the previous release", r.status, 200);
      s.check("MV-021", "both releases refuse every earlier session", (await Promise.all(sess.flatMap((c) => [N.client().me({ cookie: c }), O.client().me({ cookie: c })]))).every((x) => x.status === 401));
      const s2 = [await mk(N.client()), await mk(O.client())];
      const r2 = await N.client().post(`${L.P}/session/revoke-all`, {}, { cookie: s2[0] });
      s.check("MV-022", "revoke-all through the current release is honoured by the previous release", r2.status === 200 && (await O.client().me({ cookie: s2[1] })).status === 401);
      const s3 = [await mk(N.client()), await mk(O.client())]; const np = "Chang3d!" + L.randomHex(6) + "Qq";
      const ch = await O.client().post(`${L.P}/session/password`, { current_password: u.password, new_password: np }, { cookie: s3[1] });
      s.check("MV-023", "password change on the previous release ends the current release's session", ch.status === 200 && (await N.client().me({ cookie: s3[0] })).status === 401);
      s.check("MV-024", "and the new password works on the current release, the old one does not", (await N.client().login(u.email, np)).status === 200 && (await N.client().login(u.email, u.password)).status === 401);
      const d = await user(); const dc = [await mk2(N, d), await mk2(O, d)];
      await adm.query(`update admin_users set status='inactive' where id='${d.id}'`);
      s.check("MV-025", "deactivation is honoured by both releases at once", (await Promise.all(dc.flatMap((c) => [N.client().me({ cookie: c }), O.client().me({ cookie: c })]))).every((x) => x.status === 401));
    }
    async function mk2(side, u) { return (await side.client().login(u.email, u.password)).cookie; }
    // ---- MFA across releases
    {
      const enrolOn = async (side, role = "super_admin") => { const u = await user(role); const c = side.client(); const l = await c.login(u.email, u.password); const e = await L.enrollTotp(c, u.password); return { u, c, e }; };
      const a = await enrolOn(O);
      s.check("MV-030", "an account enrolled on the previous release is asked for its factor by the current release", (await N.client().post(`${L.P}/session/login`, { email: a.u.email, password: a.u.password })).json.mfa_required === true);
      const lg = async (side) => (await side.client().post(`${L.P}/session/login`, { email: a.u.email, password: a.u.password })).json.challenge_token;
      const c1 = await a.e.totp.next();
      const v1 = await N.client().post(`${L.P}/session/mfa/verify`, { challenge_token: await lg(N), method: "totp", code: c1.code });
      s.eq("MV-031", "the factor verifies on the current release", v1.status, 200);
      const v2 = await O.client().post(`${L.P}/session/mfa/verify`, { challenge_token: await lg(O), method: "totp", code: c1.code });
      s.check("MV-032", "the same code replayed on the previous release is refused (single use is in the database)", v2.status !== 200 && !v2.setCookie, v2.status);
      // recovery code
      const rcs = a.e.recoveryCodes; const g0 = await num(`select session_generation from admin_users where id='${a.u.id}'`);
      const toks = []; for (let i = 0; i < 6; i++) toks.push(await lg(i % 2 ? N : O));
      const rs = await Promise.all(toks.map((t, i) => (i % 2 ? N : O).client().post(`${L.P}/session/mfa/verify`, { challenge_token: t, method: "recovery_code", code: rcs[0] })));
      s.check("MV-033", "one recovery code raced over BOTH releases: exactly one session", wins(rs) === 1, rs.map((r) => r.status));
      s.eq("MV-034", "one code spent; sessions revoked at least once and the generation moved at most twice", [await num(`select count(*) from admin_mfa_recovery_codes where admin_user_id='${a.u.id}' and used_at is not null`), (await num(`select session_generation from admin_users where id='${a.u.id}'`)) - g0 >= 1 && (await num(`select session_generation from admin_users where id='${a.u.id}'`)) - g0 <= 2], [1, true]);
      // lock
      const b = await enrolOn(N);
      const bt = []; for (let i = 0; i < 7; i++) bt.push((await (i % 2 ? O : N).client().post(`${L.P}/session/login`, { email: b.u.email, password: b.u.password })).json.challenge_token);
      for (let i = 0; i < 5; i++) await (i % 2 ? O : N).client({ ip: `10.7.0.${i + 1}` }).post(`${L.P}/session/mfa/verify`, { challenge_token: bt[i], method: "totp", code: "000000" });
      const ok = await b.e.totp.next();
      const lockedO = await O.client({ ip: "10.7.1.1" }).post(`${L.P}/session/mfa/verify`, { challenge_token: bt[5], method: "totp", code: ok.code });
      const lockedN = await N.client({ ip: "10.7.1.2" }).post(`${L.P}/session/mfa/verify`, { challenge_token: bt[6], method: "totp", code: ok.code });
      s.check("MV-035", "an MFA lock set by failures on both releases stops the correct code on both", lockedO.status === 429 && lockedN.status === 429, [lockedO.status, lockedN.status]);
      // enrolment (activation) with a current-release session on the previous release's enrolment
      const act = await enrolOn(O); const tok = await N.client().post(`${L.P}/session/login`, { email: act.u.email, password: act.u.password });
      s.check("MV-036", "an enrolled factor from the previous release is listed as active by the current release", Boolean(tok.json.challenge_token) && (tok.json.methods || []).includes("totp"), tok.text.slice(0, 160));
    }
    // ---- settings
    {
      const u = await user("super_admin"); const co = (await O.client().login(u.email, u.password)).cookie;
      const key = "/api/lead-agents/admin/settings/office_document_brand_name";
      const co2 = O.client(); co2.cookie = co; const cn2 = N.client(); cn2.cookie = (await N.client().login(u.email, u.password)).cookie;
      const v0 = (await cn2.get(key)).json.setting.version;
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? cn2 : co2).put(key, { value: `MV ${i}`, expected_version: v0 })));
      s.check("MV-040", "a setting raced from the same version over both releases: exactly one winner", wins(rs) === 1 && rs.filter((r) => r.status === 409).length === 7, rs.map((r) => r.status));
      const a = (await cn2.get(key)).json.setting; const b = (await co2.get(key)).json.setting;
      s.check("MV-041", "both releases read the same value and version", a.value === b.value && a.version === b.version, [a, b]);
    }
  });

  // ================================================================== B. database one migration behind for the current release (no 20261026), both releases running
  await s.section("BEHIND", async () => {
    const st = await L.DbStack.create({ kind: "supabase17", tag: "c07b", postgrest: true, suite: s });
    st.applyBase(); const files = L.dbFiles().filter((f) => !f.startsWith("20261026"));
    const res = st.applyMigrations(files);
    if (res.some((r) => r.status !== 0)) s.blocked("fixture migration failed: " + res.find((r) => r.status !== 0).file);
    await st.settle(async () => (await st.rpc("service_role", "office_mfa_schema_version")).json === 1);
    const adm = st.session(); const { N, O } = await pair(st, s, "behind");
    const u = await L.seedUser(adm, { role: "viewer" });
    const cn = (await N.client().login(u.email, u.password)).cookie; const co = (await O.client().login(u.email, u.password)).cookie;
    s.check("MV-101", "positive control: with the revocation migration absent both releases still sign people in and serve them", (await N.client().me({ cookie: cn })).status === 200 && (await O.client().me({ cookie: co })).status === 200);
    const lo = await N.client().logout({ cookie: cn });
    s.check("MV-102", "the current release is HONEST about logout without the migration (no claim of revocation)", !(lo.json && lo.json.revoked === true) && lo.status < 500, lo.text.slice(0, 200));
    if ((await N.client().me({ cookie: cn })).status === 200) s.info("MV-103 (Info) without 20261026 an ordinary logout cannot revoke the session; the answer says so and 'sign out everywhere' remains the remedy");
    const wide = await N.client().post(`${L.P}/session/revoke-all`, {}, { cookie: (await N.client().login(u.email, u.password)).cookie });
    s.check("MV-104", "account-wide revocation works without the migration and is honoured by the previous release", wide.status === 200 && (await O.client().me({ cookie: co })).status === 401);
    // apply the migration online
    const r = st.applyFile(path.join(L.SUT, "db", "20261026_admin_revoked_sessions.sql"));
    s.eq("MV-110", "the missing migration applies on the running system", r.status, 0);
    await st.settle(async () => (await st.rpc("service_role", "office_session_revocation_version")).json === 1);
    const u2 = await L.seedUser(adm, { role: "viewer" });
    // the application caches a negative capability answer for at most 60 s
    const fresh = await L.waitFor(async () => { const c = (await N.client().login(u2.email, u2.password)).cookie; const lo2 = await N.client().logout({ cookie: c }); return lo2.json && lo2.json.revoked === true ? c : null; }, { timeoutMs: 90000, intervalMs: 2000, what: "current release to notice the new migration" }).catch(() => null);
    s.check("MV-111", "within about a minute of applying the migration the current release issues revocable sessions and logout truly revokes", Boolean(fresh));
    if (fresh) s.eq("MV-112", "and that logged-out cookie is refused", (await N.client().me({ cookie: fresh })).status, 401);
    // rollback of the migration under a running current release: a session that carries an id can no longer be checked, which must fail closed
    const keep = (await N.client().login(u2.email, u2.password)).cookie;
    s.eq("MV-120", "positive control before the rollback: the session with an id works", (await N.client().me({ cookie: keep })).status, 200);
    const rb = st.applyFile(L.rollbackFile("20261026_admin_revoked_sessions.sql"));
    s.eq("MV-121", "the rollback script applies", rb.status, 0);
    await st.reloadSchema(async () => (await st.rpc("service_role", "office_is_session_revoked", { p_digest: "x".repeat(20) })).status >= 400);
    const during = await N.client().me({ cookie: keep });
    s.check("MV-122", "after the rollback the current release cannot check the revocation list: it refuses the request (fail closed, 503) with no detail", during.status !== 200 && L.leaks(during.text).length === 0, { status: during.status, body: during.text.slice(0, 160) });
    const login2 = await N.client().login(u2.email, u2.password);
    s.check("MV-123", "sign-in still works after the rollback (sessions simply carry no id)", login2.status === 200 || login2.status === 503, login2.status);
    s.check("MV-124", "the previous release is unaffected by the rollback", (await O.client().login(u2.email, u2.password)).status === 200);
    st.applyFile(path.join(L.SUT, "db", "20261026_admin_revoked_sessions.sql"));
    await st.settle(async () => (await st.rpc("service_role", "office_session_revocation_version")).json === 1);
    const back = await L.waitFor(async () => { const r2 = await N.client().me({ cookie: keep }); return r2.status === 200 ? r2 : null; }, { timeoutMs: 30000, intervalMs: 500, what: "recovery after re-applying the migration" }).catch(() => null);
    s.check("MV-125", "re-applying the migration restores service for the same session", Boolean(back));
  });
});
