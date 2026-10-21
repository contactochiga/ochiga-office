"use strict";
// A05 - API-key and edge-token restrictions on every route that touches human accounts, sessions, passwords, MFA, step-up, user management and settings.
// The route list was derived from the server source (route handlers under /api/lead-agents/admin/...). For each route: anonymous, invalid key, API key (3 header styles),
// edge token (2 header styles), cross-presented credentials; then state-integrity checks proving that nothing changed; positive controls with a super administrator session.
const L = require("./a-lib");
const { P } = L;
const suite = L.createSuite("a05-apikey-edge-matrix");
const SESSION = "/api/lead-agents/admin/session";
const UID = "00000000-0000-4000-8000-000000000001";

suite.run(async (s) => {
  const srv = await L.startServer(s);
  const c = new L.Client(srv);
  const admin = await L.adminSession(c, srv);
  const victim = await L.makeUser(c, admin, { role: "ochiga_staff" });
  const victimAdmin = await L.makeUser(c, admin, { role: "ochiga_admin" });
  const sacrificial = await L.makeUser(c, admin, { role: "ochiga_staff" });
  const accountsBefore = (await c.get(P.users, { cookie: admin.cookie })).body.users.length;
  const storeBefore = L.readStore(srv);

  // [name, method, path, body, mutates-human-account-state, kind]  kind: "human" (S7.5.0/S7.4 -> 403), "session" (401|403), "settings"
  const V = victim.id;
  const routes = [
    ["create user", "POST", P.users, { email: `k-${L.rand(3)}@example.test`, password: L.STRONG(), role: "super_admin" }, "human"],
    ["patch user (password+role)", "PATCH", `${P.users}/${V}`, { password: L.STRONG(), role: "super_admin", status: "inactive" }, "human"],
    ["patch super admin password", "PATCH", `${P.users}/${admin.user.id}`, { password: L.STRONG() }, "human"],
    ["user photo", "POST", `${P.users}/${V}/photo`, { passport_photo_url: "https://example.test/x.png" }, "human"],
    ["issue reset", "POST", `${P.users}/${V}/reset`, {}, "human"],
    ["issue reset (super admin)", "POST", `${P.users}/${admin.user.id}/reset`, {}, "human"],
    ["remove user", "POST", `${P.users}/${V}/remove`, {}, "human"],
    ["restore user", "POST", `${P.users}/${V}/restore`, {}, "human"],
    ["permanent delete", "DELETE", `${P.users}/${V}/permanent`, {}, "human"],
    ["invite", "POST", P.invite, { email: `inv-${L.rand(3)}@example.test`, role: "super_admin" }, "human"],
    ["revoke sessions (admin)", "POST", `${P.users}/${V}/revoke-sessions`, {}, "human"],
    ["revoke all (self)", "POST", `${SESSION}/revoke-all`, {}, "human"],
    ["mfa reset (admin)", "POST", `${P.users}/${V}/mfa/reset`, { reason: "test reason", confirm: true, confirm_email: victim.email }, "human"],
    ["step-up", "POST", P.stepUp, { password: srv.secrets.adminPassword, purpose: "security_policy_write" }, "session"],
    ["step-up (session_revocation)", "POST", P.stepUp, { password: srv.secrets.adminPassword, purpose: "session_revocation" }, "session"],
    ["step-up check", "POST", P.stepUpCheck, { purpose: "security_policy_write" }, "session"],
    ["change password", "POST", P.password, { current_password: srv.secrets.adminPassword, new_password: L.STRONG() }, "session"],
    ["self photo", "POST", `${SESSION}/photo`, { photo_data_url: "data:image/png;base64,iVBORw0KGgo=" }, "session"],
    ["self profile", "PATCH", `${SESSION}/profile`, { phone: "+2340000000" }, "session"],
    ["mfa status", "GET", P.mfa, undefined, "session"],
    ["mfa totp begin", "POST", `${SESSION}/mfa/enroll/totp/begin`, {}, "session"],
    ["mfa totp confirm", "POST", `${SESSION}/mfa/enroll/totp/confirm`, { credential_id: UID, code: "123456" }, "session"],
    ["mfa credential remove", "POST", `${SESSION}/mfa/credentials/${UID}/remove`, {}, "session"],
    ["mfa recovery regenerate", "POST", `${SESSION}/mfa/recovery-codes/regenerate`, {}, "session"],
    ["webauthn register options", "POST", `${SESSION}/mfa/webauthn/register/options`, {}, "session"],
    ["webauthn register verify", "POST", `${SESSION}/mfa/webauthn/register/verify`, { challenge_id: UID, response: {} }, "session"],
    ["webauthn step-up options", "POST", `${SESSION}/mfa/webauthn/step-up-options`, {}, "session"],
    ["mfa enforcement preflight", "GET", `${SESSION}/mfa/enforcement/preflight`, undefined, "session"],
    ["settings PUT session ttl", "PUT", `${P.settings}/office_session_ttl_hours`, { value: 1, expected_version: 0 }, "settings"],
    ["settings PUT mfa enforcement", "PUT", `${P.settings}/office_mfa_enforcement`, { value: "required_all", expected_version: 0, confirm: true }, "settings"],
  ];

  const styles = {
    "anonymous": {},
    "invalid api key": { apiKey: "not-a-key" },
    "api key (x-api-key)": { apiKey: srv.secrets.apiKey },
    "api key #2 (x-api-key)": { apiKey: srv.secrets.apiKey2 },
    "api key (bearer)": { bearer: srv.secrets.apiKey },
    "api key (x-office-api-key)": { headers: { "x-office-api-key": srv.secrets.apiKey } },
    "edge token (x-edge-token)": { edge: srv.secrets.edgeToken },
    "edge token (bearer)": { bearer: srv.secrets.edgeToken },
    "edge token (x-oyi-edge-token)": { headers: { "x-oyi-edge-token": srv.secrets.edgeToken } },
    "edge token as api key": { apiKey: srv.secrets.edgeToken },
    "api key as edge token": { edge: srv.secrets.apiKey },
    "api key + step-up header": { apiKey: srv.secrets.apiKey, stepUp: "forged.token" },
  };

  const results = {};
  await s.section("every route x every machine credential", async () => {
    let n = 0;
    for (const [name, method, path, body, kind] of routes) {
      for (const [sname, o] of Object.entries(styles)) {
        const r = await c.call(method, path, { ...o, ...(body !== undefined ? { json: body } : {}) });
        results[`${name}|${sname}`] = r.status;
        const anon = sname === "anonymous" || sname === "invalid api key" || sname === "edge token as api key" || sname === "api key as edge token";
        const allowed = anon ? [401, 403] : kind === "human" ? [403] : [401, 403];
        const exactApiKey = sname.startsWith("api key") && !sname.includes("as edge");
        // contract-pinned reasons for API keys
        let ok = allowed.includes(r.status);
        if (kind === "human" && exactApiKey) ok = r.status === 403;
        s.check(`A05-1${String(n++).padStart(3, "0")}`, `${name} [${method}] with ${sname}: refused (${allowed.join("/")}), no 2xx, no 5xx`, ok, { status: r.status, body: r.text.slice(0, 140) });
      }
    }
  });

  await s.section("contract-pinned error codes", async () => {
    const k = { apiKey: srv.secrets.apiKey };
    const e = (r) => (r.body && r.body.error) || "";
    s.check("A05-200", "API key creating an account: 403 actor_identity_required", e(await c.post(P.users, { ...k, json: { email: `q-${L.rand(3)}@example.test`, password: L.STRONG(), role: "super_admin" } })) === "actor_identity_required");
    s.check("A05-201", "API key setting a password: 403 actor_identity_required", e(await c.patch(`${P.users}/${V}`, { ...k, json: { password: L.STRONG() } })) === "actor_identity_required");
    s.check("A05-202", "API key at step-up: 403 step_up_session_required", e(await c.post(P.stepUp, { ...k, json: { password: srv.secrets.adminPassword, purpose: "security_policy_write" } })) === "step_up_session_required");
    s.check("A05-203", "API key revoking sessions: 403 actor_identity_required", e(await c.post(`${P.users}/${V}/revoke-sessions`, { ...k, json: {} })) === "actor_identity_required");
    s.check("A05-204", "API key writing a governed setting: 403 actor_identity_required", e(await c.put(`${P.settings}/office_session_ttl_hours`, { ...k, json: { value: 2, expected_version: 0 } })) === "actor_identity_required");
    const audit = await c.get(P.audit, { cookie: admin.cookie });
    const denied = (audit.body.audit || []).filter((a) => a.action === "human_account_change_denied");
    s.check("A05-205", "refused machine-credential account changes are audited (human_account_change_denied)", denied.length >= 6, denied.length);
    s.check("A05-206", "those audit rows never contain the key that was used", L.findLeaks(JSON.stringify(denied), { apiKey: srv.secrets.apiKey, apiKey2: srv.secrets.apiKey2, edge: srv.secrets.edgeToken }).length === 0);
  });

  await s.section("every governed setting rejects machine credentials", async () => {
    const list = await c.get(P.settings, { cookie: admin.cookie });
    s.check("A05-210", "settings list is readable by the super administrator (positive control)", list.status === 200 && Array.isArray(list.body.settings), list.status);
    const keys = (list.body.settings || []).map((x) => x.key);
    s.check("A05-211", "at least one governed setting exists", keys.length > 0, keys);
    const before = JSON.stringify((await c.get(P.settings, { cookie: admin.cookie })).body.settings.map((x) => [x.key, x.value, x.version]));
    for (const key of keys) {
      for (const [sname, o] of [["api key", { apiKey: srv.secrets.apiKey }], ["edge token", { edge: srv.secrets.edgeToken }], ["anonymous", {}]]) {
        const r = await c.put(`${P.settings}/${key}`, { ...o, json: { value: true, expected_version: 0, confirm: true } });
        s.check(`A05-212-${key}-${sname.replace(" ", "")}`, `setting ${key}: PUT with ${sname} is refused (401/403/404/405, never 2xx)`, [401, 403, 404, 405].includes(r.status), { status: r.status, body: r.text.slice(0, 120) });
      }
    }
    const after = JSON.stringify((await c.get(P.settings, { cookie: admin.cookie })).body.settings.map((x) => [x.key, x.value, x.version]));
    s.check("A05-213", "no governed setting changed during the machine-credential attempts", before === after);
    const wa = await c.put("/api/lead-agents/admin/settings/whatsapp-autonomy", { edge: srv.secrets.edgeToken, json: { enabled: true } });
    s.check("A05-214", "an edge token cannot change the WhatsApp autonomy switch", wa.status === 403 || wa.status === 401, wa.status);
    const hist = await c.get(`${P.settings}/office_session_ttl_hours/history`, { edge: srv.secrets.edgeToken });
    s.check("A05-215", "an edge token cannot read a security setting's history", hist.status === 403 || hist.status === 401, hist.status);
  });

  await s.section("state integrity after all machine-credential attempts", async () => {
    const users = (await c.get(P.users, { cookie: admin.cookie })).body.users;
    s.check("A05-300", "no account was created or deleted", users.length === accountsBefore, { before: accountsBefore, after: users.length });
    const v = users.find((u) => u.id === V);
    s.check("A05-301", "victim keeps role, status", v && v.role === "ochiga_staff" && v.status === "active", v);
    s.check("A05-302", "victim's password is unchanged (original password still signs in)", (await L.login(c, victim.email, victim.password)).status === 200);
    s.check("A05-303", "victim's existing session was not revoked", (await c.get(P.me, { cookie: victim.cookie })).status === 200);
    s.check("A05-304", "super administrator's password and session are intact", (await c.get(P.me, { cookie: admin.cookie })).status === 200 && (await L.login(c, srv.secrets.adminEmail, srv.secrets.adminPassword)).status === 200);
    const store = L.readStore(srv);
    s.check("A05-305", "no reset token was created", (store.password_reset_tokens || []).length === (storeBefore.password_reset_tokens || []).length, (store.password_reset_tokens || []).length);
    s.check("A05-306", "no invitation was created", (store.admin_invites || []).length === (storeBefore.admin_invites || []).length);
    s.check("A05-307", "no session generation changed for the victim", ((store.admin_users.find((u) => u.id === V) || {}).session_generation || 0) === ((storeBefore.admin_users.find((u) => u.id === V) || {}).session_generation || 0));
    s.check("A05-308", "the bootstrap administrator's role is unchanged", users.find((u) => u.id === admin.user.id).role === "super_admin");
  });

  await s.section("reads available to machine credentials expose no secrets", async () => {
    const r = await c.get(P.users, { apiKey: srv.secrets.apiKey });
    s.check("A05-310", "documented behaviour: an API key may still READ the account list (200)", r.status === 200, r.status);
    s.check("A05-311", "the account list exposes no password hash, token or session counters", !/password_hash|scrypt|session_generation|sessions_revoked|token_hash|mfa_secret/i.test(r.text), r.text.slice(0, 200));
    const edge = await c.get(P.users, { edge: srv.secrets.edgeToken });
    s.check("A05-312", "an edge token cannot read the account list (403)", edge.status === 403, edge.status);
    const perm = await c.get("/api/lead-agents/admin/permissions", { edge: srv.secrets.edgeToken });
    s.check("A05-313", "an edge token cannot read the permission catalogue", perm.status === 403, perm.status);
    const audit = await c.get(P.audit, { apiKey: srv.secrets.apiKey });
    s.check("A05-314", "audit listing read through an API key exposes no hash or secret", audit.status !== 200 || (!/[0-9a-f]{32}:[0-9a-f]{128}/.test(audit.text) && L.findLeaks(audit.text, { sessionSecret: srv.secrets.sessionSecret, adminPassword: srv.secrets.adminPassword }).length === 0));
    const auditEdge = await c.get(P.audit, { edge: srv.secrets.edgeToken });
    s.check("A05-315", "an edge token cannot read the audit log", auditEdge.status === 403, auditEdge.status);
  });

  await s.section("an edge token cannot adopt a human identity", async () => {
    // the edge principal carries the e-mail edge-agent@oyi.local; an account with that address must not be reachable through the edge token
    const twin = await L.makeUser(c, admin, { role: "ochiga_staff", email: "edge-agent@oyi.local" });
    const prof = await c.patch(`${SESSION}/profile`, { edge: srv.secrets.edgeToken, json: { phone: "+2349999999" } });
    s.check("A05-320", "an edge token cannot edit the profile of a human account that shares the edge e-mail", prof.status === 401 || prof.status === 403, { status: prof.status, body: prof.text.slice(0, 120) });
    const photo = await c.post(`${SESSION}/photo`, { edge: srv.secrets.edgeToken, json: { photo_data_url: "data:image/png;base64,iVBORw0KGgo=" } });
    s.check("A05-321", "an edge token cannot set the photo of a human account that shares the edge e-mail", photo.status === 401 || photo.status === 403, { status: photo.status, body: photo.text.slice(0, 120) });
    const pw = await c.post(P.password, { edge: srv.secrets.edgeToken, json: { current_password: twin.password, new_password: L.STRONG() } });
    s.check("A05-322", "an edge token cannot change the password of a human account that shares the edge e-mail", pw.status === 401 || pw.status === 403, pw.status);
    s.check("A05-323", "that human account still signs in with its own password", (await L.login(c, twin.email, twin.password)).status === 200);
    const su = await c.post(P.stepUp, { edge: srv.secrets.edgeToken, json: { password: twin.password, purpose: "mfa_management" } });
    s.check("A05-324", "an edge token cannot obtain a step-up grant for that account", su.status === 401 || su.status === 403, su.status);
  });

  await s.section("session credentials presented as machine credentials", async () => {
    for (const [name, o] of [["x-api-key", { apiKey: admin.cookie }], ["bearer", { bearer: admin.cookie }], ["x-edge-token", { edge: admin.cookie }]]) {
      const r = await c.get(P.users, o);
      s.check(`A05-33-${name}`, `a session token presented in ${name} is not accepted`, r.status === 401 || r.status === 403, r.status);
    }
    const cookieAsKeyHeader = await c.get(P.users, { headers: { "x-api-key": srv.secrets.apiKey + "x" } });
    s.check("A05-334", "an API key with an appended character is refused (exact comparison)", cookieAsKeyHeader.status === 401, cookieAsKeyHeader.status);
    const prefix = await c.get(P.users, { apiKey: srv.secrets.apiKey.slice(0, -1) });
    s.check("A05-335", "a truncated API key is refused", prefix.status === 401, prefix.status);
    const lower = await c.get(P.users, { apiKey: srv.secrets.apiKey.toUpperCase() });
    s.check("A05-336", "an API key in the wrong case is refused", lower.status === 401, lower.status);
    const both = await c.get(P.users, { apiKey: srv.secrets.apiKey, cookie: "garbage.cookie" });
    s.check("A05-337", "a valid API key plus a garbage cookie behaves as the API key alone (garbage cookie is ignored)", both.status === 200, both.status);
    const revokedCookie = admin.cookie;
    const staffRevoke = await c.post(`${SESSION}/revoke-all`, { cookie: sacrificial.cookie, json: {} });
    s.check("A05-338", "positive control: a user can revoke their own sessions", staffRevoke.status === 200, staffRevoke.status);
    const keyPlusRevoked = await c.get(P.users, { apiKey: srv.secrets.apiKey, cookie: sacrificial.cookie });
    s.check("A05-339", "a valid API key does not rescue a revoked session cookie presented with it (fails closed, 401)", keyPlusRevoked.status === 401, keyPlusRevoked.status);
    void revokedCookie;
  });

  await s.section("positive controls: the same routes work for an authorised human", async () => {
    const t = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const r1 = await c.patch(`${P.users}/${t.id}`, { cookie: admin.cookie, json: { display_name: "Changed Name" } });
    s.check("A05-400", "super administrator can patch a member", r1.status === 200, r1.status);
    const r2 = await c.post(`${P.users}/${t.id}/reset`, { cookie: admin.cookie, json: {} });
    s.check("A05-401", "super administrator can issue a reset", r2.status === 201, r2.status);
    const r3 = await c.post(`${P.users}/${t.id}/remove`, { cookie: admin.cookie, json: {} });
    s.check("A05-402", "super administrator can remove a member", r3.status === 200, r3.status);
    const r4 = await c.post(`${P.users}/${t.id}/restore`, { cookie: admin.cookie, json: {} });
    s.check("A05-403", "super administrator can restore a member", r4.status === 200, r4.status);
    const r5 = await c.post(`${P.users}/${t.id}/remove`, { cookie: admin.cookie, json: {} });
    const r6 = await c.del(`${P.users}/${t.id}/permanent`, { cookie: admin.cookie });
    s.check("A05-404", "super administrator can permanently delete a removed member", r5.status === 200 && r6.status === 200, [r5.status, r6.status]);
    const su = await L.stepUp(c, admin, "security_policy_write");
    s.check("A05-405", "super administrator obtains a step-up grant", su.res.status === 200 && su.token, su.res.status);
    const w = await c.put(`${P.settings}/office_session_ttl_hours`, { cookie: admin.cookie, stepUp: su.token, json: { value: 100, expected_version: 0 } });
    s.check("A05-406", "super administrator can write a governed setting with a grant", w.status === 200, w.text.slice(0, 160));
    const rev = await L.stepUp(c, admin, "session_revocation");
    const rv = await c.post(`${P.users}/${sacrificial.id}/revoke-sessions`, { cookie: admin.cookie, stepUp: rev.token, json: {} });
    s.check("A05-407", "super administrator can revoke another member's sessions with a grant", rv.status === 200, rv.text.slice(0, 160));
  });

  s.check("A05-990", "no secret or password in the server log", L.findLeaks(srv.logs(), { sessionSecret: srv.secrets.sessionSecret, apiKey: srv.secrets.apiKey, apiKey2: srv.secrets.apiKey2, edge: srv.secrets.edgeToken, adminPassword: srv.secrets.adminPassword }).length === 0);
  s.check("A05-999", "server alive at the end of the suite", srv.alive());
});
