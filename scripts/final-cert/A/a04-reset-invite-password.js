"use strict";
// A04 - password reset, invitations, password change / administrator password set: single use, expiry, tampering, concurrency,
// no session from reset, effects on existing sessions, privilege boundaries, link origin, secrets in storage / audit / logs.
const L = require("./a-lib");
const { P } = L;
const suite = L.createSuite("a04-reset-invite-password");

const HASH_RE = /[0-9a-f]{32}:[0-9a-f]{128}/;
const cleanStatus = (r) => r.status > 0 && r.status < 500 && !/TypeError|RangeError|Cannot read|Invalid time|\bat .*\(/.test(r.text);

suite.run(async (s) => {
  const OFFICE = "https://office.example.test";
  const srv = await L.startServer(s, { env: { OFFICE_APP_URL: OFFICE } });
  const c = new L.Client(srv);
  const admin = await L.adminSession(c, srv);
  const issueReset = async (user, hours) => (await c.post(`${P.users}/${user.id}/reset`, { cookie: admin.cookie, json: hours === undefined ? {} : { expires_in_hours: hours } }));
  const confirm = (token, pw, o = {}) => c.post(P.resetConfirm, { json: { token, new_password: pw }, ...o });

  await s.section("administrator-issued reset: positive control and effects", async () => {
    const u = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const other = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const second = await L.login(c, u.email, u.password);
    const iss = await issueReset(u);
    s.check("A04-001", "administrator can issue a reset (201) and receives a token and a link", iss.status === 201 && iss.body.reset_token && iss.body.reset_url, iss.text.slice(0, 200));
    const url = new URL(iss.body.reset_url);
    s.check("A04-002", "the reset link points at the configured canonical Office origin", url.origin === OFFICE && url.searchParams.get("token") === iss.body.reset_token, iss.body.reset_url);
    s.check("A04-003", "the reset issuance response does not return the token hash or other stored secrets", !/token_hash/.test(JSON.stringify(iss.body.reset || {})) && !HASH_RE.test(iss.text), JSON.stringify(iss.body.reset));
    const store1 = L.readStore(srv);
    s.check("A04-004", "the raw reset token is not stored (only a digest is persisted)", !JSON.stringify(store1).includes(iss.body.reset_token));
    const newPw = L.STRONG();
    const r = await confirm(iss.body.reset_token, newPw);
    s.check("A04-005", "confirming the token with a policy-compliant password succeeds (200 ok:true)", r.status === 200 && r.body && r.body.ok === true, r.text);
    s.check("A04-006", "a reset confirmation NEVER creates a session: no Set-Cookie header", r.setCookies.length === 0 && !r.cookie, r.setCookies);
    s.check("A04-007", "the reset confirmation body carries no admin object, token or hash", !/admin|token|password_hash|scrypt/i.test(r.text), r.text);
    const meAfter = await c.get(P.me);
    s.check("A04-008", "after a reset confirmation, the caller is still anonymous", meAfter.status === 401, meAfter.status);
    const oldLogin = await L.login(c, u.email, u.password);
    s.check("A04-009", "the old password no longer signs in", oldLogin.status === 401, oldLogin.status);
    const newLogin = await L.login(c, u.email, newPw);
    s.check("A04-010", "the new password signs in", newLogin.status === 200 && newLogin.cookie, newLogin.status);
    s.check("A04-011", "the user's existing sessions end when the password is reset", (await c.get(P.me, { cookie: u.cookie })).status === 401 && (await c.get(P.me, { cookie: second.cookie })).status === 401);
    s.check("A04-012", "another account's session is unaffected by the reset", (await c.get(P.me, { cookie: other.cookie })).status === 200);
    const reuse = await confirm(iss.body.reset_token, L.STRONG());
    s.check("A04-013", "the token is single use: a second confirmation is refused (400 invalid_or_expired_reset)", reuse.status === 400 && /invalid_or_expired_reset/.test(reuse.text), reuse.text);
    const stillNew = await L.login(c, u.email, newPw);
    s.check("A04-014", "the refused reuse did not change the password", stillNew.status === 200, stillNew.status);
    s.check("A04-015", "the digest in storage is marked used after confirmation", (L.readStore(srv).password_reset_tokens || []).filter((t) => t.email === u.email && t.status === "used").length >= 1);
  });

  await s.section("expiry, tampering and malformed tokens", async () => {
    const u = await L.makeUser(c, admin, { role: "ochiga_staff", signIn: false });
    const expired = await issueReset(u, -1);
    s.check("A04-020", "issuing a reset that is already expired still returns a token (test fixture)", expired.status === 201 || expired.status === 400, expired.status);
    if (expired.status === 201) {
      const r = await confirm(expired.body.reset_token, L.STRONG());
      s.check("A04-021", "an expired token is refused (400 generic)", r.status === 400 && /invalid_or_expired_reset/.test(r.text), r.text);
    }
    const nan = await issueReset(u, "abc");
    s.check("A04-022", "a non-numeric expires_in_hours is a clean client error (no 500 with internal text)", cleanStatus(nan) && nan.status !== 201, { status: nan.status, text: nan.text.slice(0, 160) });
    const huge = await issueReset(u, 1e12);
    s.check("A04-023", "an absurd expires_in_hours (1e12) is clamped or refused, not a 500", cleanStatus(huge), { status: huge.status, text: huge.text.slice(0, 160) });
    if (huge.status === 201) {
      const exp = Date.parse(huge.body.reset.expires_at);
      s.check("A04-024", "a reset token cannot be issued with a lifetime beyond 30 days", exp - Date.now() <= 30 * 24 * 3600 * 1000, huge.body.reset.expires_at);
    }
    const good = await issueReset(u, 1);
    const t = good.body.reset_token;
    const pw = L.STRONG();
    const variants = {
      "last char changed": t.slice(0, -1) + (t.slice(-1) === "a" ? "b" : "a"),
      "first char changed": (t[0] === "a" ? "b" : "a") + t.slice(1),
      truncated: t.slice(0, t.length - 4),
      extended: t + "00",
      "upper-cased": t.toUpperCase(),
      "space padded": ` ${t} `,
      "url-encoded suffix": t + "%00",
      doubled: t + t,
      "with newline": t + "\n",
      "empty": "",
    };
    let i = 0;
    for (const [name, tok] of Object.entries(variants)) {
      const r = await confirm(tok, pw);
      s.check(`A04-03${i++}`, `tampered token (${name}) is refused`, r.status >= 400 && r.status < 500 && !/ok":true/.test(r.text), { status: r.status, text: r.text.slice(0, 120) });
    }
    const throwaway = await issueReset(await L.makeUser(c, admin, { role: "ochiga_staff", signIn: false }), 1);
    const t2 = throwaway.body.reset_token;
    for (const [n, tok] of [["array", [t2]], ["object", { a: t2 }], ["number", 12345], ["null", null], ["boolean", true]]) {
      const r = await c.post(P.resetConfirm, { json: { token: tok, new_password: pw } });
      s.check(`A04-04${i++}`, `non-string token (${n}) gives a clean 4xx`, cleanStatus(r) && r.status >= 400, { status: r.status, text: r.text.slice(0, 120) });
    }
    const stillValid = await confirm(t, pw);
    s.check("A04-060", "the genuine token still works after all the failed attempts (they did not consume it)", stillValid.status === 200, stillValid.text);
    const nullBody = await c.post(P.resetConfirm, { body: "null", headers: { "content-type": "application/json" } });
    s.check("A04-061", "reset confirm with a JSON null body is a clean 4xx", cleanStatus(nullBody) && nullBody.status >= 400, nullBody.text.slice(0, 160));
  });

  await s.section("password policy ordering does not consume the token", async () => {
    const u = await L.makeUser(c, admin, { role: "ochiga_staff", signIn: false });
    const iss = await issueReset(u, 1);
    const weak = await confirm(iss.body.reset_token, "short");
    s.check("A04-070", "a weak new password is rejected with 400 password_policy_violation", weak.status === 400 && /password_policy_violation/.test(weak.text), weak.text);
    s.check("A04-071", "the policy rejection does not echo the password", !weak.text.includes('"short"'));
    const ok = await confirm(iss.body.reset_token, L.STRONG());
    s.check("A04-072", "the same token then succeeds with a compliant password (rejection did not consume it)", ok.status === 200, ok.text);
  });

  await s.section("concurrent confirmation of one token", async () => {
    const u = await L.makeUser(c, admin, { role: "ochiga_staff", signIn: false });
    const iss = await issueReset(u, 1);
    const pws = Array.from({ length: 10 }, () => L.STRONG());
    const results = await Promise.all(pws.map((p) => confirm(iss.body.reset_token, p)));
    const winners = results.map((r, i) => (r.status === 200 ? i : -1)).filter((i) => i >= 0);
    s.check("A04-080", "10 simultaneous confirmations of one token produce exactly one success", winners.length === 1, results.map((r) => r.status));
    s.check("A04-081", "the losers are refused with the generic 400 (no 5xx)", results.every((r) => r.status === 200 || (r.status === 400 && /invalid_or_expired_reset/.test(r.text))), results.map((r) => r.status));
    const logins = await Promise.all(pws.map((p) => L.login(c, u.email, p)));
    const okLogins = logins.map((r, i) => (r.status === 200 ? i : -1)).filter((i) => i >= 0);
    s.check("A04-082", "exactly one of the ten candidate passwords works and it is the winner's", okLogins.length === 1 && okLogins[0] === winners[0], { winners, okLogins });
  });

  await s.section("reset and deactivation interplay", async () => {
    const u = await L.makeUser(c, admin, { role: "ochiga_staff", signIn: false });
    const iss = await issueReset(u, 1);
    await c.patch(`${P.users}/${u.id}`, { cookie: admin.cookie, json: { status: "inactive" } });
    const pw = L.STRONG();
    const r = await confirm(iss.body.reset_token, pw);
    const login = await L.login(c, u.email, pw);
    s.check("A04-090", "a reset token cannot reactivate a deactivated account: the account still cannot sign in", login.status === 401 && !login.cookie, { confirm: r.status, login: login.status });
    const rm = await L.makeUser(c, admin, { role: "ochiga_staff", signIn: false });
    const iss2 = await issueReset(rm, 1);
    await c.post(`${P.users}/${rm.id}/remove`, { cookie: admin.cookie, json: {} });
    const pw2 = L.STRONG();
    await confirm(iss2.body.reset_token, pw2);
    const login2 = await L.login(c, rm.email, pw2);
    s.check("A04-091", "a reset token cannot restore a removed account", login2.status === 401 && !login2.cookie, login2.status);
    const nonexistent = await c.post(`${P.users}/00000000-0000-0000-0000-000000000000/reset`, { cookie: admin.cookie, json: {} });
    s.check("A04-092", "issuing a reset for a non-existent account is a clean 404", nonexistent.status === 404, nonexistent.status);
  });

  await s.section("invitations", async () => {
    const email = `invitee-${L.rand(4)}@example.test`;
    const inv1 = await c.post(P.invite, { cookie: admin.cookie, json: { email, role: "ochiga_staff" } });
    s.check("A04-100", "administrator can invite a new member (201) and receives a link", inv1.status === 201 && inv1.body.invite_url, inv1.text.slice(0, 200));
    s.check("A04-101", "the invitation link points at the configured canonical origin", new URL(inv1.body.invite_url).origin === OFFICE, inv1.body.invite_url);
    s.check("A04-102", "the invitation response contains no token hash", !/token_hash/.test(inv1.text), inv1.text.slice(0, 300));
    const tok1 = new URL(inv1.body.invite_url).searchParams.get("token");
    const inv2 = await c.post(P.invite, { cookie: admin.cookie, json: { email, role: "ochiga_staff" } });
    const tok2 = new URL(inv2.body.invite_url).searchParams.get("token");
    const old = await c.post(P.inviteAccept, { json: { token: tok1, password: L.STRONG() } });
    s.check("A04-103", "a newer invitation supersedes the older one (old token refused)", old.status === 400, old.text);
    const weak = await c.post(P.inviteAccept, { json: { token: tok2, password: "short" } });
    s.check("A04-104", "a weak password is rejected without consuming the invitation", weak.status === 400 && /password_policy_violation/.test(weak.text), weak.text);
    const pw = L.STRONG();
    const acc = await c.post(P.inviteAccept, { json: { token: tok2, password: pw, role: "super_admin", display_name: "Invited Person" } });
    s.check("A04-105", "accepting a valid invitation with a compliant password succeeds and issues a session", acc.status === 200 && acc.cookie, acc.text);
    s.check("A04-106", "the role comes from the invitation, not from the request body (no privilege escalation)", acc.body && acc.body.admin && acc.body.admin.role === "ochiga_staff", acc.body && acc.body.admin);
    const attrs = L.attrsOf(acc.setCookies[0] || "");
    s.check("A04-107", "the invitation session cookie has the same protective attributes as a login cookie", attrs.httponly === true && /lax|strict/i.test(attrs.samesite || "") && attrs.path === "/", acc.setCookies);
    s.check("A04-108", "the new session works", (await c.get(P.me, { cookie: acc.cookie })).status === 200);
    const reuse = await c.post(P.inviteAccept, { json: { token: tok2, password: L.STRONG() } });
    s.check("A04-109", "an invitation token is single use", reuse.status === 400 && /invalid_or_expired_invite/.test(reuse.text), reuse.text);
    s.check("A04-110", "the invited member can sign in with the chosen password", (await L.login(c, email, pw)).status === 200);

    const email2 = `invitee-${L.rand(4)}@example.test`;
    const inv3 = await c.post(P.invite, { cookie: admin.cookie, json: { email: email2, role: "ochiga_staff", expires_in_hours: -1 } });
    if (inv3.status === 201) {
      const t3 = new URL(inv3.body.invite_url).searchParams.get("token");
      const exp = await c.post(P.inviteAccept, { json: { token: t3, password: L.STRONG() } });
      s.check("A04-111", "an expired invitation is refused", exp.status === 400 && !exp.cookie, exp.text);
    }
    const bad = await c.post(P.invite, { cookie: admin.cookie, json: { email: `x-${L.rand(3)}@example.test`, role: "nonexistent_role" } });
    s.check("A04-112", "inviting with an unknown role is a clean 4xx", cleanStatus(bad) && bad.status >= 400, { status: bad.status, text: bad.text.slice(0, 120) });
    const dupe = await c.post(P.invite, { cookie: admin.cookie, json: { email, role: "ochiga_staff" } });
    s.check("A04-113", "inviting an already-active member is refused (409)", dupe.status === 409, dupe.status);
    const email3 = `invitee-${L.rand(4)}@example.test`;
    const inv4 = await c.post(P.invite, { cookie: admin.cookie, json: { email: email3, role: "ochiga_staff" } });
    const t4 = new URL(inv4.body.invite_url).searchParams.get("token");
    const users = (await c.get(P.users, { cookie: admin.cookie })).body.users;
    const invitedUser = users.find((u) => u.email === email3);
    await c.post(`${P.users}/${invitedUser.id}/remove`, { cookie: admin.cookie, json: {} });
    const afterRemove = await c.post(P.inviteAccept, { json: { token: t4, password: L.STRONG() } });
    s.check("A04-114", "an invitation cannot resurrect an account that an administrator removed (no session, not activated)", afterRemove.status >= 400 && !afterRemove.cookie, afterRemove.text);
    const email4 = `invitee-${L.rand(4)}@example.test`;
    const inv5 = await c.post(P.invite, { cookie: admin.cookie, json: { email: email4, role: "ochiga_staff" } });
    const t5 = new URL(inv5.body.invite_url).searchParams.get("token");
    const rs = await Promise.all(Array.from({ length: 8 }, () => c.post(P.inviteAccept, { json: { token: t5, password: L.STRONG() } })));
    s.check("A04-115", "8 simultaneous acceptances of one invitation yield exactly one session", rs.filter((r) => r.status === 200).length === 1 && rs.every((r) => r.status === 200 || r.status === 400 || r.status === 409), rs.map((r) => r.status));
    const nul = await c.post(P.inviteAccept, { body: "null", headers: { "content-type": "application/json" } });
    s.check("A04-116", "invitation accept with a JSON null body is a clean 4xx", cleanStatus(nul) && nul.status >= 400, nul.text.slice(0, 160));
  });

  await s.section("privilege boundaries on account management", async () => {
    const adm2 = await L.makeUser(c, admin, { role: "ochiga_admin" });
    const staff = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const victim = await L.makeUser(c, admin, { role: "ochiga_staff" });
    for (const [who, label] of [[adm2, "ochiga_admin"], [staff, "ochiga_staff"]]) {
      const reset = await c.post(`${P.users}/${victim.id}/reset`, { cookie: who.cookie, json: {} });
      s.check(`A04-120-${label}`, `${label} cannot issue a password reset for another account (403)`, reset.status === 403, reset.status);
      const patch = await c.patch(`${P.users}/${victim.id}`, { cookie: who.cookie, json: { password: L.STRONG() } });
      s.check(`A04-121-${label}`, `${label} cannot set another account's password (403)`, patch.status === 403, patch.status);
      const role = await c.patch(`${P.users}/${victim.id}`, { cookie: who.cookie, json: { role: "super_admin" } });
      s.check(`A04-122-${label}`, `${label} cannot change a role (403)`, role.status === 403, role.status);
      const invite = await c.post(P.invite, { cookie: who.cookie, json: { email: `z-${L.rand(3)}@example.test`, role: "super_admin" } });
      s.check(`A04-123-${label}`, `${label} cannot invite members (403)`, invite.status === 403, invite.status);
      const create = await c.post(P.users, { cookie: who.cookie, json: { email: `z-${L.rand(3)}@example.test`, password: L.STRONG(), role: "super_admin" } });
      s.check(`A04-124-${label}`, `${label} cannot create accounts (403)`, create.status === 403, create.status);
      const remove = await c.post(`${P.users}/${victim.id}/remove`, { cookie: who.cookie, json: {} });
      s.check(`A04-125-${label}`, `${label} cannot remove accounts (403)`, remove.status === 403, remove.status);
    }
    const stillOk = await L.login(c, victim.email, victim.password);
    s.check("A04-126", "the victim's password was not changed by any refused attempt", stillOk.status === 200);
    const scoped = await L.makeUser(c, admin, { role: "ochiga_staff", scopes: ["team.manage"] });
    const viaScope = await c.post(`${P.users}/${victim.id}/reset`, { cookie: scoped.cookie, json: {} });
    s.check("A04-127", "positive control: an explicit team.manage scope grants the reset right (scopes are honoured)", viaScope.status === 201, viaScope.status);
    const anon = await c.post(`${P.users}/${victim.id}/reset`, { json: {} });
    s.check("A04-128", "an anonymous caller cannot issue a reset (401)", anon.status === 401, anon.status);
  });

  await s.section("self-service password change", async () => {
    const u = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const second = await L.login(c, u.email, u.password);
    const bystander = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const noAuth = await c.post(P.password, { json: { current_password: u.password, new_password: L.STRONG() } });
    s.check("A04-130", "password change without a session is refused (401)", noAuth.status === 401, noAuth.status);
    const wrong = await c.post(P.password, { cookie: u.cookie, json: { current_password: "not-the-password-1234", new_password: L.STRONG() } });
    s.check("A04-131", "password change with a wrong current password is refused (401)", wrong.status === 401, wrong.status);
    s.check("A04-132", "the session survives a refused change", (await c.get(P.me, { cookie: u.cookie })).status === 200);
    const weak = await c.post(P.password, { cookie: u.cookie, json: { current_password: u.password, new_password: "short" } });
    s.check("A04-133", "a weak new password is rejected (400 password_policy_violation)", weak.status === 400 && /password_policy_violation/.test(weak.text), weak.text);
    const missing = await c.post(P.password, { cookie: u.cookie, json: { current_password: u.password } });
    s.check("A04-134", "a missing new password is a clean 400", missing.status === 400, missing.status);
    const np = L.STRONG();
    const ok = await c.post(P.password, { cookie: u.cookie, json: { current_password: u.password, new_password: np } });
    s.check("A04-135", "a correct change succeeds (200)", ok.status === 200 && ok.body.ok === true, ok.text.slice(0, 200));
    s.check("A04-136", "the success body never contains the password hash", !/password_hash|scrypt/.test(ok.text) && !HASH_RE.test(ok.text), ok.text.slice(0, 300));
    s.check("A04-137", "the changing browser is re-issued a cookie that works", ok.cookie && (await c.get(P.me, { cookie: ok.cookie })).status === 200, !!ok.cookie);
    s.check("A04-138", "the cookie used for the change is dead afterwards (generation bumped)", (await c.get(P.me, { cookie: u.cookie })).status === 401);
    s.check("A04-139", "every other session of the account is signed out by the change", (await c.get(P.me, { cookie: second.cookie })).status === 401);
    s.check("A04-140", "other accounts' sessions are unaffected", (await c.get(P.me, { cookie: bystander.cookie })).status === 200);
    s.check("A04-141", "old password refused, new password accepted", (await L.login(c, u.email, u.password)).status === 401 && (await L.login(c, u.email, np)).status === 200);
    const viaKey = await c.post(P.password, { apiKey: srv.secrets.apiKey, json: { current_password: np, new_password: L.STRONG() } });
    s.check("A04-142", "an API key cannot change a human password (not 200)", viaKey.status === 401 || viaKey.status === 403, viaKey.status);
    const viaEdge = await c.post(P.password, { edge: srv.secrets.edgeToken, json: { current_password: np, new_password: L.STRONG() } });
    s.check("A04-143", "an edge token cannot change a human password (not 200)", viaEdge.status === 401 || viaEdge.status === 403, viaEdge.status);
    const same = await c.post(P.password, { cookie: ok.cookie, json: { current_password: np, new_password: np } });
    s.check("A04-144", "re-using the current password as the new one is a clean answer (no 5xx)", same.status < 500, same.status);
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => c.post(P.password, { cookie: ok.cookie, json: { current_password: np, new_password: L.STRONG() } })));
    s.check("A04-145", "concurrent password changes from one session do not produce 5xx", concurrent.every((r) => r.status < 500), concurrent.map((r) => r.status));
  });

  await s.section("administrator sets another member's password", async () => {
    const u = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const np = L.STRONG();
    const r = await c.patch(`${P.users}/${u.id}`, { cookie: admin.cookie, json: { password: np } });
    s.check("A04-150", "administrator can set a member's password (200)", r.status === 200, r.status);
    s.check("A04-151", "the response contains no hash", !/password_hash|scrypt/.test(r.text) && !HASH_RE.test(r.text), r.text.slice(0, 200));
    s.check("A04-152", "the member's existing session ends", (await c.get(P.me, { cookie: u.cookie })).status === 401);
    s.check("A04-153", "the administrator's own session is unaffected", (await c.get(P.me, { cookie: admin.cookie })).status === 200);
    s.check("A04-154", "old password refused, new accepted", (await L.login(c, u.email, u.password)).status === 401 && (await L.login(c, u.email, np)).status === 200);
    const weak = await c.patch(`${P.users}/${u.id}`, { cookie: admin.cookie, json: { password: "abc" } });
    s.check("A04-155", "a weak administrator-set password is rejected (400)", weak.status === 400, weak.status);
    const viaKey = await c.patch(`${P.users}/${u.id}`, { apiKey: srv.secrets.apiKey, json: { password: L.STRONG() } });
    s.check("A04-156", "an API key cannot set a member's password (403)", viaKey.status === 403, viaKey.status);
    s.check("A04-157", "the refused API-key attempt did not change the password", (await L.login(c, u.email, np)).status === 200);
  });

  await s.section("secrets in audit records, storage and logs", async () => {
    const audit = await c.get(P.audit, { cookie: admin.cookie });
    s.check("A04-160", "audit listing is available to the super administrator (positive control)", audit.status === 200 && Array.isArray(audit.body.audit), audit.status);
    const text = audit.text;
    s.check("A04-161", "audit records contain no password hash", !HASH_RE.test(text) && !/scrypt/i.test(text));
    s.check("A04-162", "audit records contain no password, API key, session secret or edge token", L.findLeaks(text, { apiKey: srv.secrets.apiKey, apiKey2: srv.secrets.apiKey2, sessionSecret: srv.secrets.sessionSecret, edge: srv.secrets.edgeToken, adminPassword: srv.secrets.adminPassword }).length === 0);
    const store = L.readStore(srv);
    const auditStored = JSON.stringify(store.audit_events || []);
    s.check("A04-163", "stored audit events contain no password hash", !HASH_RE.test(auditStored));
    s.check("A04-164", "stored audit events contain no reset or invitation token", !/reset_token|"token":/.test(auditStored));
    const tokens = (store.password_reset_tokens || []).map((t) => JSON.stringify(t)).join("");
    s.check("A04-165", "stored reset records hold no raw token", !/"reset_token"/.test(tokens));
    const logs = srv.logs();
    s.check("A04-166", "server log contains no password, secret, hash or token", L.findLeaks(logs, { apiKey: srv.secrets.apiKey, sessionSecret: srv.secrets.sessionSecret, adminPassword: srv.secrets.adminPassword }).length === 0 && !HASH_RE.test(logs));
  });

  await s.section("link origin is not attacker controlled when a canonical origin is configured", async () => {
    const u = await L.makeUser(c, admin, { role: "ochiga_staff", signIn: false });
    const r = await c.post(`${P.users}/${u.id}/reset`, { cookie: admin.cookie, json: {}, headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", host: "evil.example" } });
    s.check("A04-170", "forged Host / X-Forwarded-Host / X-Forwarded-Proto do not change the reset link origin", r.status === 201 && new URL(r.body.reset_url).origin === OFFICE, r.body && r.body.reset_url);
    const inv = await c.post(P.invite, { cookie: admin.cookie, json: { email: `h-${L.rand(3)}@example.test`, role: "ochiga_staff" }, headers: { "x-forwarded-host": "evil.example" } });
    s.check("A04-171", "forged X-Forwarded-Host does not change the invitation link origin", inv.status === 201 && new URL(inv.body.invite_url).origin === OFFICE, inv.body && inv.body.invite_url);
  });

  s.check("A04-999", "server alive at the end of the suite", srv.alive());
});
