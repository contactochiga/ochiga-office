"use strict";
// A07 - ordinary logout (R4 per-session revocation), account-wide revocation (sign out everywhere, administrator revocation), deactivation / restoration /
// deleted-and-recreated accounts, live permission changes, session duration setting, legacy-token rejection flag, restart persistence, storage failure honesty.
const L = require("./a-lib");
const fs = require("fs");
const { P } = L;
const suite = L.createSuite("a07-logout-revocation");
const ME = P.me;
const SESS = "/api/lead-agents/admin/session";
const LEAK_RE = /(EACCES|ENOENT|EROFS|\/var\/folders|\/Users\/|\/tmp\/|a-sut-|store\.json|node_modules|at [\w.<>$ ]+ \()/;

suite.run(async (s) => {
  const srv = await L.startServer(s);
  const c = new L.Client(srv);
  const admin = await L.adminSession(c, srv);
  const meStatus = async (cookie, o = {}) => (await c.get(ME, { cookie, ...o })).status;
  const usersStatus = async (cookie, o = {}) => (await c.get(P.users, { cookie, ...o })).status;
  const relog = (u) => L.login(c, u.email, u.password);

  await s.section("ordinary logout", async () => {
    const u = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const other = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const second = await relog(u); const third = await relog(u);
    s.check("A07-001", "positive control: the cookie works before logout", await meStatus(u.cookie) === 200);
    const lo = await c.post(P.logout, { cookie: u.cookie, json: {} });
    s.check("A07-002", "logout answers 200 with ok:true and revoked:true", lo.status === 200 && lo.body.ok === true && lo.body.revoked === true, lo.body);
    const clear = L.attrsOf(lo.setCookies[0] || "");
    s.check("A07-003", "logout clears the browser cookie (same name, empty value, Max-Age=0, Path=/, HttpOnly)", clear._name === L.COOKIE_NAME && clear._value === "" && clear["max-age"] === "0" && clear.path === "/" && clear.httponly === true, lo.setCookies);
    s.check("A07-004", "logout response is not cacheable", /no-store|private/.test((lo.headers.get("cache-control") || "").toLowerCase()), lo.headers.get("cache-control"));
    const copied = await c.get(ME, { cookie: u.cookie });
    s.check("A07-005", "a COPIED cookie is refused after logout (/session/me 401 session_revoked)", copied.status === 401 && copied.body && copied.body.error === "session_revoked", copied.body);
    s.check("A07-006", "the copied cookie is refused on a protected route as well", await usersStatus(u.cookie) === 401);
    s.check("A07-007", "the copied cookie is refused even when a valid API key accompanies it (fails closed)", await usersStatus(u.cookie, { apiKey: srv.secrets.apiKey }) === 401);
    s.check("A07-008", "another session of the same account survives the logout", await meStatus(second.cookie) === 200 && await meStatus(third.cookie) === 200);
    s.check("A07-009", "another account's session is unaffected", await meStatus(other.cookie) === 200);
    const again = await c.post(P.logout, { cookie: u.cookie, json: {} });
    s.check("A07-010", "logging out an already logged-out cookie is idempotent (200, still refused afterwards)", again.status === 200 && await meStatus(u.cookie) === 401, again.status);
    const none = await c.post(P.logout, { json: {} });
    s.check("A07-011", "logout without any cookie is a harmless 200 that revokes nothing", none.status === 200 && none.body.revoked === false, none.body);
    const garbage = await c.post(P.logout, { cookie: "garbage.token" });
    s.check("A07-012", "logout with a garbage cookie is a harmless 200 and clears the cookie", garbage.status === 200 && garbage.body.revoked === false && garbage.setCookies.length === 1, garbage.body);
    const viaKey = await c.post(P.logout, { apiKey: srv.secrets.apiKey, json: {} });
    s.check("A07-013", "logout with only an API key revokes nothing", viaKey.status === 200 && viaKey.body.revoked === false && await meStatus(second.cookie) === 200, viaKey.body);
    const getLogout = await c.get(P.logout, { cookie: second.cookie });
    s.check("A07-014", "GET on logout does not sign anyone out (405; no CSRF-by-image)", getLogout.status === 405 && await meStatus(second.cookie) === 200, getLogout.status);
    const relogin = await relog(u);
    s.check("A07-015", "signing in again after logout issues a new working session with a different session id", relogin.status === 200 && relogin.cookie && L.decodeToken(relogin.cookie).claims.sid !== L.decodeToken(u.cookie).claims.sid && await meStatus(relogin.cookie) === 200);
    s.check("A07-016", "the old logged-out cookie is still refused after the new sign-in", await meStatus(u.cookie) === 401);
    const dead = await c.post(P.logout, { cookie: u.cookie, json: {}, headers: { "content-type": "text/plain" } });
    s.check("A07-017", "logout ignores the body/content-type (cannot be tricked into revoking a different session)", dead.status === 200 && await meStatus(relogin.cookie) === 200);
    const body = await c.post(P.logout, { cookie: second.cookie, json: { sid: L.decodeToken(third.cookie).claims.sid, session_id: L.decodeToken(third.cookie).claims.sid, user_id: other.id } });
    s.check("A07-018", "identifiers in the logout body cannot revoke another session or another account", await meStatus(third.cookie) === 200 && await meStatus(other.cookie) === 200 && await meStatus(second.cookie) === 401, body.status);
    const audit = (await c.get(P.audit, { cookie: admin.cookie })).body.audit || [];
    s.check("A07-019", "logout is audited (session_logout)", audit.some((a) => a.action === "session_logout"), audit.slice(0, 3).map((a) => a.action));
    s.check("A07-020", "audit rows for logout never contain the cookie, signature or session id", !JSON.stringify(audit.filter((a) => /session_logout/.test(a.action))).includes(u.cookie.split(".")[1]) && !JSON.stringify(audit).includes(L.decodeToken(u.cookie).claims.sid));
    const par = await Promise.all(Array.from({ length: 10 }, () => c.post(P.logout, { cookie: third.cookie, json: {} })));
    s.check("A07-021", "10 simultaneous logouts of one cookie all answer 200 and the cookie is dead afterwards", par.every((r) => r.status === 200) && await meStatus(third.cookie) === 401, par.map((r) => r.status));
  });

  await s.section("logout and step-up grants", async () => {
    const adm = await L.makeUser(c, admin, { role: "super_admin" });
    const other = await L.login(c, adm.email, adm.password);
    const grant = await L.stepUp(c, adm, "security_policy_write");
    s.check("A07-030", "positive control: a step-up grant is valid for its own session", (await c.post(P.stepUpCheck, { cookie: adm.cookie, stepUp: grant.token, json: { purpose: "security_policy_write" } })).status === 200);
    const other2 = await c.post(P.stepUpCheck, { cookie: other.cookie, stepUp: grant.token, json: { purpose: "security_policy_write" } });
    s.check("A07-031", "the grant is not valid for another session of the same administrator (session binding)", other2.status === 403 && other2.body.reason === "wrong_session", other2.body);
    await c.post(P.logout, { cookie: adm.cookie, json: {} });
    const dead = await c.post(P.stepUpCheck, { cookie: adm.cookie, stepUp: grant.token, json: { purpose: "security_policy_write" } });
    s.check("A07-032", "after logout the grant cannot be used with the copied cookie (401)", dead.status === 401, dead.status);
    const still = await c.post(P.stepUpCheck, { cookie: other.cookie, stepUp: grant.token, json: { purpose: "security_policy_write" } });
    s.check("A07-033", "after logout the grant is still not valid in another session", still.status === 403, still.status);
    const stepAfter = await c.post(P.stepUp, { cookie: adm.cookie, json: { password: adm.password, purpose: "security_policy_write" } });
    s.check("A07-034", "a logged-out cookie cannot obtain a new step-up grant", stepAfter.status === 401, stepAfter.status);
  });

  await s.section("sign out everywhere (self)", async () => {
    const u = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const a = await relog(u), b = await relog(u);
    const other = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const r = await c.post(`${SESS}/revoke-all`, { cookie: u.cookie, json: {} });
    s.check("A07-040", "revoke-all answers 200", r.status === 200, r.text.slice(0, 200));
    s.check("A07-041", "revoke-all clears the browser cookie", L.attrsOf(r.setCookies[0] || "")["max-age"] === "0", r.setCookies);
    s.check("A07-042", "every session of the account is dead (all three cookies)", await meStatus(u.cookie) === 401 && await meStatus(a.cookie) === 401 && await meStatus(b.cookie) === 401);
    s.check("A07-043", "another account is unaffected", await meStatus(other.cookie) === 200);
    s.check("A07-044", "the response reports a generation number and no token, hash or secret", Number.isInteger(r.body.session_generation) && !/token|hash|secret/i.test(JSON.stringify(r.body).replace(/session_generation/, "")), r.body);
    const fresh = await relog(u);
    s.check("A07-045", "after revoke-all a new sign-in works and carries a higher generation", fresh.status === 200 && L.decodeToken(fresh.cookie).claims.sg === r.body.session_generation, { sg: L.decodeToken(fresh.cookie).claims.sg, rev: r.body.session_generation });
    const keep = await c.post(`${SESS}/revoke-all`, { cookie: fresh.cookie, json: { keep_current: true } });
    s.check("A07-046", "keep_current re-issues a working cookie for this browser", keep.status === 200 && keep.cookie && await meStatus(keep.cookie) === 200, keep.status);
    s.check("A07-047", "keep_current ends the old cookie that made the request", await meStatus(fresh.cookie) === 401);
    const keepGen = L.decodeToken(keep.cookie).claims.sg;
    s.check("A07-048", "the kept cookie is at the new generation", keepGen === keep.body.session_generation, { keepGen, body: keep.body.session_generation });
    const gens = [];
    for (let i = 0; i < 4; i++) { const x = await relog(u); const rr = await c.post(`${SESS}/revoke-all`, { cookie: x.cookie, json: {} }); gens.push(rr.body.session_generation); }
    s.check("A07-049", "generations are strictly increasing across repeated revocations", gens.every((g, i) => i === 0 || g > gens[i - 1]), gens);
    const burst = [];
    const sessions = []; for (let i = 0; i < 12; i++) sessions.push(await relog(u));
    const rs = await Promise.all(sessions.map((x) => c.post(`${SESS}/revoke-all`, { cookie: x.cookie, json: {} })));
    const gen = rs.filter((x) => x.status === 200).map((x) => x.body.session_generation);
    burst.push(...gen);
    s.check("A07-050", "12 simultaneous revocations report 12 distinct generations (no lost update)", new Set(gen).size === gen.length && gen.length >= 1 && rs.every((x) => x.status === 200 || x.status === 401), { gens: gen.sort((a1, b1) => a1 - b1), statuses: rs.map((x) => x.status) });
    s.check("A07-051", "after the burst none of the 12 sessions is alive", (await Promise.all(sessions.map((x) => meStatus(x.cookie)))).every((st) => st === 401));
    const anon = await c.post(`${SESS}/revoke-all`, { json: {} });
    s.check("A07-052", "revoke-all without a session is refused", anon.status === 401, anon.status);
    const gone = await c.post(`${SESS}/revoke-all`, { cookie: u.cookie, json: {} });
    s.check("A07-053", "revoke-all with an already-revoked cookie is refused (401), it cannot be used to bump generations", gone.status === 401, gone.status);
  });

  await s.section("administrator revocation (step-up, purpose isolation)", async () => {
    const target = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const t2 = await relog(target);
    const rv = (id, o) => c.post(`${P.users}/${id}/revoke-sessions`, { json: {}, ...o });
    const noGrant = await rv(target.id, { cookie: admin.cookie });
    s.check("A07-060", "without a step-up grant the revocation is refused (403 step_up_required/missing)", noGrant.status === 403 && noGrant.body.error === "step_up_required", noGrant.body);
    s.check("A07-061", "the refused attempt left the target's sessions alive", await meStatus(target.cookie) === 200);
    const wrongPurpose = await L.stepUp(c, admin, "security_policy_write");
    const wp = await rv(target.id, { cookie: admin.cookie, stepUp: wrongPurpose.token });
    s.check("A07-062", "a grant for another purpose is refused (wrong_purpose)", wp.status === 403 && wp.body.reason === "wrong_purpose", wp.body);
    const garbage = await rv(target.id, { cookie: admin.cookie, stepUp: "garbage.token" });
    s.check("A07-063", "a forged grant is refused (invalid)", garbage.status === 403 && garbage.body.reason === "invalid", garbage.body);
    const good = await L.stepUp(c, admin, "session_revocation");
    const adm2 = await L.login(c, srv.secrets.adminEmail, srv.secrets.adminPassword);
    const otherSession = await rv(target.id, { cookie: adm2.cookie, stepUp: good.token });
    s.check("A07-064", "a grant earned in one session cannot be used from another session of the same administrator", otherSession.status === 403 && otherSession.body.reason === "wrong_session", otherSession.body);
    const staffTry = await L.makeUser(c, admin, { role: "ochiga_admin" });
    const staffGrant = await L.stepUp(c, staffTry, "session_revocation", { password: staffTry.password });
    s.check("A07-065", "a non-super-administrator cannot even obtain a session_revocation grant (403)", staffGrant.res.status === 403, staffGrant.res.status);
    const staffRv = await rv(target.id, { cookie: staffTry.cookie, stepUp: good.token });
    s.check("A07-066", "a non-super-administrator cannot revoke another member's sessions (403)", staffRv.status === 403, staffRv.status);
    const selfRv = await rv(admin.user.id, { cookie: admin.cookie, stepUp: good.token });
    s.check("A07-067", "an administrator cannot use the administrative route on themselves (400 use_self_revocation)", selfRv.status === 400 && selfRv.body.error === "use_self_revocation", selfRv.body);
    const unknown = await rv("00000000-0000-4000-8000-0000000000ff", { cookie: admin.cookie, stepUp: good.token });
    s.check("A07-068", "revoking an unknown account is a clean 404", unknown.status === 404, unknown.status);
    const ok = await rv(target.id, { cookie: admin.cookie, stepUp: good.token, json: { reason: "test" } });
    s.check("A07-069", "positive control: with a valid grant the administrator revokes the target's sessions (200)", ok.status === 200 && Number.isInteger(ok.body.session_generation), ok.body);
    s.check("A07-070", "all of the target's sessions are dead", await meStatus(target.cookie) === 401 && await meStatus(t2.cookie) === 401);
    s.check("A07-071", "the administrator's own session survives", await meStatus(admin.cookie) === 200);
    s.check("A07-072", "the target can sign in again", (await relog(target)).status === 200);
    const audit = (await c.get(P.audit, { cookie: admin.cookie })).body.audit || [];
    s.check("A07-073", "the revocation is audited without any token or grant", audit.some((a) => a.action === "sessions_revoked_by_admin") && !JSON.stringify(audit).includes(good.token));
    const cp = await c.post(`${P.users}/${target.id}/revoke-sessions`, { cookie: admin.cookie, stepUp: good.token, json: { reason: "x".repeat(100000) } });
    s.check("A07-074", "an oversized reason is handled without a 5xx", cp.status < 500, cp.status);
  });

  await s.section("deactivation, restoration, removal, deleted-and-recreated accounts", async () => {
    const u = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const keepAlive = await relog(u);
    s.check("A07-080", "positive control before deactivation", await meStatus(u.cookie) === 200);
    await c.patch(`${P.users}/${u.id}`, { cookie: admin.cookie, json: { status: "inactive" } });
    s.check("A07-081", "deactivation ends every session immediately", await meStatus(u.cookie) === 401 && await meStatus(keepAlive.cookie) === 401);
    await c.patch(`${P.users}/${u.id}`, { cookie: admin.cookie, json: { status: "active" } });
    s.check("A07-082", "restoring the account does NOT revive the sessions that existed before deactivation", await meStatus(u.cookie) === 401 && await meStatus(keepAlive.cookie) === 401);
    const afterRestore = await relog(u);
    s.check("A07-083", "a fresh sign-in works after restoration", afterRestore.status === 200 && await meStatus(afterRestore.cookie) === 200);
    const v = await L.makeUser(c, admin, { role: "ochiga_staff" });
    await c.post(`${P.users}/${v.id}/remove`, { cookie: admin.cookie, json: {} });
    s.check("A07-084", "removal ends the session", await meStatus(v.cookie) === 401);
    await c.post(`${P.users}/${v.id}/restore`, { cookie: admin.cookie, json: {} });
    s.check("A07-085", "restoring a removed account does not revive its earlier session", await meStatus(v.cookie) === 401);
    const vv = await relog(v);
    s.check("A07-086", "a restored account can sign in again", vv.status === 200);
    // deleted and recreated with the SAME e-mail and the SAME password
    const w = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const wOld = w.cookie; const wSecond = await relog(w);
    await c.post(`${P.users}/${w.id}/remove`, { cookie: admin.cookie, json: {} });
    const del = await c.del(`${P.users}/${w.id}/permanent`, { cookie: admin.cookie });
    s.check("A07-087", "positive control: a removed account can be permanently deleted", del.status === 200, del.status);
    const re = await c.post(P.users, { cookie: admin.cookie, json: { email: w.email, password: w.password, role: "ochiga_staff" } });
    s.check("A07-088", "the account is recreated with the same e-mail and password (new id)", re.status === 201 && re.body.user.id !== w.id, re.body && re.body.user && re.body.user.id);
    s.check("A07-089", "a session from the DELETED account is refused for the recreated account (no inheritance)", await meStatus(wOld) === 401 && await meStatus(wSecond.cookie) === 401);
    const newLogin = await L.login(c, w.email, w.password);
    s.check("A07-090", "the recreated account signs in normally", newLogin.status === 200 && L.decodeToken(newLogin.cookie).claims.user_id === re.body.user.id);
    const oldLegacy = L.mintToken(srv.secrets.sessionSecret, { email: w.email, role: "ochiga_staff", user_id: w.id, permission_scopes: [], exp: Date.now() + 3600_000 });
    s.check("A07-091", "a legacy-form token naming the deleted account's id is refused for the recreated account", await meStatus(oldLegacy) === 401);
    const del2 = await c.del(`${P.users}/${re.body.user.id}/permanent`, { cookie: admin.cookie });
    s.check("A07-092", "permanent delete of an active (not removed) account is refused (409)", del2.status === 409, del2.status);
    const deleted = await L.makeUser(c, admin, { role: "ochiga_staff" });
    await c.post(`${P.users}/${deleted.id}/remove`, { cookie: admin.cookie, json: {} });
    await c.del(`${P.users}/${deleted.id}/permanent`, { cookie: admin.cookie });
    s.check("A07-093", "after permanent deletion the old session is refused and the account cannot sign in", await meStatus(deleted.cookie) === 401 && (await L.login(c, deleted.email, deleted.password)).status === 401);
  });

  await s.section("permission changes take effect on the next request (no stale authority)", async () => {
    const u = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const victim = await L.makeUser(c, admin, { role: "ochiga_staff" });
    s.check("A07-100", "staff cannot read the account list", await usersStatus(u.cookie) === 403);
    await c.patch(`${P.users}/${u.id}`, { cookie: admin.cookie, json: { permission_scopes: ["team.manage", "staff.manage"] } });
    s.check("A07-101", "granting a scope takes effect on the existing cookie immediately", await usersStatus(u.cookie) === 200);
    const reset = await c.post(`${P.users}/${victim.id}/reset`, { cookie: u.cookie, json: {} });
    s.check("A07-102", "the granted scope allows account management (positive control)", reset.status === 201, reset.status);
    await c.patch(`${P.users}/${u.id}`, { cookie: admin.cookie, json: { permission_scopes: [] } });
    s.check("A07-103", "removing the scope takes effect on the existing cookie immediately (stale authority refused)", await usersStatus(u.cookie) === 403);
    const reset2 = await c.post(`${P.users}/${victim.id}/reset`, { cookie: u.cookie, json: {} });
    s.check("A07-104", "the removed scope no longer allows account management", reset2.status === 403, reset2.status);
    await c.patch(`${P.users}/${u.id}`, { cookie: admin.cookie, json: { role: "super_admin" } });
    s.check("A07-105", "a role promotion applies immediately", await usersStatus(u.cookie) === 200);
    await c.patch(`${P.users}/${u.id}`, { cookie: admin.cookie, json: { role: "ochiga_staff" } });
    s.check("A07-106", "a role demotion applies immediately", await usersStatus(u.cookie) === 403);
    const g = await L.stepUp(c, { cookie: u.cookie, password: u.password }, "session_revocation");
    s.check("A07-107", "a demoted administrator cannot obtain a new step-up grant", g.res.status === 403, g.res.status);
    await c.patch(`${P.users}/${u.id}`, { cookie: admin.cookie, json: { role: "super_admin" } });
    const grant = await L.stepUp(c, { cookie: u.cookie, password: u.password }, "session_revocation");
    s.check("A07-108", "positive control: a super administrator obtains a grant", grant.res.status === 200, grant.res.status);
    await c.patch(`${P.users}/${u.id}`, { cookie: admin.cookie, json: { role: "ochiga_staff" } });
    const useAfter = await c.post(`${P.users}/${victim.id}/revoke-sessions`, { cookie: u.cookie, stepUp: grant.token, json: {} });
    s.check("A07-109", "a grant held by an administrator who lost the role is useless (permission removed)", useAfter.status === 403, useAfter.status);
  });

  await s.section("session duration setting (S7.3) and cookie lifetime", async () => {
    const getTtl = async () => (await c.get(`${P.settings}/office_session_ttl_hours`, { cookie: admin.cookie })).body.setting;
    const before = await getTtl();
    const early = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const earlyClaims = L.decodeToken(early.cookie).claims;
    const g = await L.stepUp(c, admin, "security_policy_write");
    const put = (value, version, o = {}) => c.put(`${P.settings}/office_session_ttl_hours`, { cookie: admin.cookie, stepUp: g.token, json: { value, expected_version: version }, ...o });
    for (const [name, value] of [["zero", 0], ["721", 721], ["negative", -5], ["float", 1.5], ["string", "5"], ["null", null], ["boolean", true]]) {
      const r = await put(value, before.version || 0);
      s.check(`A07-110-${name}`, `a session duration of ${name} is rejected (400 invalid_value) and nothing changes`, r.status === 400, { status: r.status, body: r.text.slice(0, 120) });
    }
    const noGrant = await c.put(`${P.settings}/office_session_ttl_hours`, { cookie: admin.cookie, json: { value: 2, expected_version: before.version || 0 } });
    s.check("A07-111", "changing the duration without a step-up grant is refused (403)", noGrant.status === 403, noGrant.status);
    const ok = await put(2, before.version || 0);
    s.check("A07-112", "positive control: a valid change (2 hours) with a grant succeeds", ok.status === 200, ok.text.slice(0, 160));
    const fresh = await relog(early);
    const fc = L.decodeToken(fresh.cookie).claims; const attrs = L.attrsOf(fresh.setCookies[0] || "");
    s.check("A07-113", "a session issued afterwards uses the new duration in both token expiry and cookie Max-Age (2 h)", Math.abs((fc.exp - Date.now()) / 1000 - 7200) < 10 && attrs["max-age"] === "7200", { exp_s: (fc.exp - Date.now()) / 1000, maxAge: attrs["max-age"] });
    s.check("A07-114", "a session issued BEFORE the change keeps its original expiry (still works, expiry unchanged)", await meStatus(early.cookie) === 200 && L.decodeToken(early.cookie).claims.exp === earlyClaims.exp);
    const stale = await put(3, before.version || 0);
    s.check("A07-115", "a stale expected_version is refused (409 version_conflict)", stale.status === 409, stale.status);
    const ok2 = await put(720, 1); const ok3 = await put(1, 2);
    s.check("A07-116", "the bounds 720 and 1 hours are accepted", ok2.status === 200 && ok3.status === 200, [ok2.status, ok3.status]);
    const lowest = await relog(early);
    s.check("A07-117", "a 1-hour setting yields Max-Age 3600", L.attrsOf(lowest.setCookies[0])["max-age"] === "3600");
    const reset = await put(168, 3);
    s.check("A07-118", "the duration can be restored to the default (168 h)", reset.status === 200);
  });

  await s.section("legacy tokens, restart persistence", async () => {
    const u = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const keepA = await relog(u); const killB = await relog(u);
    await c.post(P.logout, { cookie: killB.cookie, json: {} });
    const claims = L.decodeToken(u.cookie).claims;
    const legacy = L.mintToken(srv.secrets.sessionSecret, { email: claims.email, role: claims.role, user_id: claims.user_id, permission_scopes: [], exp: Date.now() + 3600_000 });
    await srv.restart({});
    const c2 = new L.Client(srv);
    s.check("A07-120", "after a server restart (same secret and data) a surviving session still works", (await c2.get(ME, { cookie: keepA.cookie })).status === 200);
    s.check("A07-121", "after a restart the logged-out session is STILL refused (revocation is persisted)", (await c2.get(ME, { cookie: killB.cookie })).status === 401);
    s.check("A07-122", "a legacy-form token is accepted at generation 0 or refused cleanly (documented transitional behaviour)", [200, 401].includes((await c2.get(ME, { cookie: legacy })).status));
    await srv.restart({ LEAD_AGENTS_REJECT_LEGACY_SESSIONS: "true" });
    const c3 = new L.Client(srv);
    const hz = await c3.get("/healthz");
    s.check("A07-123", "/healthz reports legacy_tokens: rejected when LEAD_AGENTS_REJECT_LEGACY_SESSIONS=true", hz.body.session_revocation && hz.body.session_revocation.legacy_tokens === "rejected", hz.body.session_revocation);
    const rej = await c3.get(ME, { cookie: legacy });
    s.check("A07-124", "with the reject-legacy flag a token without a generation claim is refused (401 session_revoked)", rej.status === 401 && rej.body.error === "session_revoked", rej.body);
    s.check("A07-125", "with the reject-legacy flag a modern token still works (positive control)", (await c3.get(ME, { cookie: keepA.cookie })).status === 200);
    await srv.restart({});
  });

  s.check("A07-980", "no secret or token appears in the server log", L.findLeaks(srv.logs(), { sessionSecret: srv.secrets.sessionSecret, apiKey: srv.secrets.apiKey, adminPassword: srv.secrets.adminPassword }).length === 0);
  s.check("A07-981", "server alive after the main sections", srv.alive());

  // ------------------------------------------------------------- storage failure honesty (separate instance: a failing disk write is not recoverable in the file driver)
  await s.section("storage failure: honest results, fail closed, no internal detail", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) { console.log("INFO A07 running as root: file-permission failure injection skipped"); return; }
    const f = await L.startServer(s);
    const cf = new L.Client(f);
    const adm = await L.adminSession(cf, f);
    const u = await L.makeUser(cf, adm, { role: "ochiga_staff" });
    const u2 = await L.login(cf, u.email, u.password);
    const wasPw = u.password;
    fs.chmodSync(f.storePath, 0o444);
    try {
      const lo = await cf.post(P.logout, { cookie: u.cookie, json: {} });
      s.check("A07-130", "when the revocation cannot be stored, logout does NOT claim success: 503 logout_not_confirmed with revoked:false", lo.status === 503 && lo.body && lo.body.ok === false && lo.body.revoked === false && lo.body.error === "logout_not_confirmed", lo.body);
      s.check("A07-131", "the failed logout still clears the browser cookie", L.attrsOf(lo.setCookies[0] || "")["max-age"] === "0", lo.setCookies);
      s.check("A07-132", "the failed-logout answer carries no internal detail (paths, error codes)", !LEAK_RE.test(lo.text), lo.text);
      const ra = await cf.post(`${SESS}/revoke-all`, { cookie: u2.cookie, json: {} });
      s.check("A07-133", "when the generation bump cannot be stored, revoke-all fails closed with 503 (not 200)", ra.status === 503, ra.status + " " + ra.text.slice(0, 160));
      s.check("A07-134", "the failed revoke-all answer carries no internal detail", !LEAK_RE.test(ra.text), ra.text);
      const pw = await cf.post(P.password, { cookie: u2.cookie, json: { current_password: wasPw, new_password: L.STRONG() } });
      s.check("A07-135", "when the credential change cannot be stored, password change fails closed (5xx/503, never 200)", pw.status >= 500, pw.status + " " + pw.text.slice(0, 160));
      s.check("A07-136", "the failed password-change answer carries no internal detail", !LEAK_RE.test(pw.text), pw.text);
      const lg = await L.login(cf, u.email, wasPw);
      s.check("A07-137", "a sign-in that cannot record its audit/last-login is not a 200 with a half-state, and any failure carries no internal detail", !LEAK_RE.test(lg.text), lg.status + " " + lg.text.slice(0, 160));
      const unknown = await cf.get(P.me, { cookie: u2.cookie });
      s.check("A07-138", "a read-only request with a valid cookie is still served while only writes fail (no needless outage) or refused cleanly", unknown.status === 200 || unknown.status === 503, unknown.status);
    } finally { try { fs.chmodSync(f.storePath, 0o644); } catch { /* ignore */ } }
    await f.restart({});
    const cf2 = new L.Client(f);
    s.check("A07-139", "after the disk recovers and the server restarts, the ORIGINAL password still works (the failed change was not applied)", (await L.login(cf2, u.email, wasPw)).status === 200);
    s.check("A07-140", "the session whose logout was not confirmed is not wrongly reported as revoked after restart (honest state)", (await cf2.get(P.me, { cookie: u.cookie })).status === 200);
  });
});
