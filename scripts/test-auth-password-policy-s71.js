// Settings S7.1: governed password policy. Contract: docs/settings-domain/20_S7_1_PASSWORD_POLICY_CONTRACT.md
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer, bootstrapAdminUser } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword, verifyPassword } = require("../src/lead-agents/auth");
const { validatePassword } = require("../src/lead-agents/password-policy");

const SECRET = "s7-1-dedicated-session-secret-0123456789abcdef";
const OLD_SHORT = "old-pw-7"; // a legacy password that predates the policy
const STRONG = "orange river lantern 42";
const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed += 1; };
const listen = (s) => new Promise((r, j) => { s.once("error", j); s.listen(0, "127.0.0.1", () => r(s.address().port)); });

async function boot() {
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["k-s71-api-key"], allowedOrigins: [], sessionSecret: SECRET, sessionSecretEphemeral: false };
  const { store } = await createTempStore();
  const mk = (email, password, role, extra = {}) => store.ensureAdminUser({ email, password_hash: hashPassword(password), role, display_name: email, status: "active", ...extra });
  await mk("super@x.test", "super-pass-phrase-1", "super_admin");
  await mk("legacy@x.test", OLD_SHORT, "viewer");
  await mk("viewer@x.test", "viewer-pass-phrase-1", "viewer");
  const logs = [];
  const server = buildServer({
    config, store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }), publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }), loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] }, openaiClient: {},
    toolExecutor: new ToolExecutor({ store, config, log: (...a) => logs.push(JSON.stringify(a)), webhooks: new WebhookDispatcher({ config }) }),
  });
  const base = `http://127.0.0.1:${await listen(server)}`;
  const post = (path, body, cookie) => fetch(`${base}/api/lead-agents${path}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const patch = (path, body, cookie) => fetch(`${base}/api/lead-agents${path}`, { method: "PATCH", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const login = async (email, password) => { const r = await post("/admin/session/login", { email, password }); return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
  return { config, store, base, post, patch, login, logs, mk, close: () => new Promise((r) => server.close(r)) };
}

async function main() {
  // ---- unit: policy matrix
  const v = (p) => validatePassword(p);
  eq(v("").code, "password_required", "empty"); eq(v(undefined).code, "password_required", "undefined"); eq(v(123456789012).code, "password_required", "non-string");
  eq(v("a1b2c3d4e5f").code, "password_too_short", "11 chars"); ok(v("a1b2c3d4e5f6").valid, "12 chars valid");
  const exact128 = "violet harbour ".repeat(10).slice(0, 127) + "q"; eq([...exact128].length, 128); ok(v(exact128).valid, "128 chars valid");
  eq(v(exact128 + "x").code, "password_too_long", "129 chars");
  eq(v("日本語のパスフレーズです長い").valid, true, "Unicode passphrase (14 code points)");
  eq(v("パスワード十一文字です").code, "password_too_short", "11 code points of CJK counted as characters");
  ok(v("🙂🌍🚀🎲🧩🔭🪐🌵🍋🎻🛶🧭").valid, "12 emoji (24 UTF-16 units) valid by code points");
  eq(v("🙂🌍🚀🎲🧩🔭🪐🌵🍋🎻🛶").code, "password_too_short", "11 emoji short (22 UTF-16 units must not pass)");
  eq(v("correct horse battery staple").valid, true, "plain lowercase passphrase needs no composition");
  eq(v("alllowercasewords here").valid, true, "no uppercase/number/special requirement");
  for (const bad of ["bad\u0000password-12", "line\nbreak-passphrase", "tab\there-passphrase", "esc\u001bpassphrase-12", "del\u007fpassphrase-12", "lone\ud800surrogate-pw"]) eq(v(bad).code, "password_invalid_characters", `control/unsafe rejected: ${JSON.stringify(bad)}`);
  eq(v("              ").code, "password_blank", "blank");
  for (const common of ["password1234", "Password123456", "123456789012", "qwertyuiop12", "aaaaaaaaaaaa", "abababababab", "abcdefghijkl", "Password2024!!!", "iloveyouiloveyou", "Ochiga123456", "P@ssw0rd1234"]) eq(v(common).code, "password_too_common", `common rejected: ${common}`);
  eq(v("fjord-tangerine-quiet-91").valid, true, "unpredictable passphrase accepted");
  ok(!JSON.stringify(v("password1234")).includes("password1234"), "result never echoes the password");

  const t = await boot();
  const sup = await t.login("super@x.test", "super-pass-phrase-1"); eq(sup.status, 200, "super logs in");
  const viewer = await t.login("viewer@x.test", "viewer-pass-phrase-1");

  // ---- compatibility: pre-policy password still logs in, no forced reset
  const leg = await t.login("legacy@x.test", OLD_SHORT); eq(leg.status, 200, "legacy short password still signs in");
  eq(validatePassword(OLD_SHORT).valid, false, "that password would not pass the new policy");

  const assertPolicy = async (res, code, label) => {
    const b = await res.json(); const text = JSON.stringify(b);
    eq(res.status, 400, `${label}: 400`); eq(b.error, "password_policy_violation", `${label}: error`); eq(b.code, code, `${label}: code`);
    ok(b.policy.min_length === 12 && b.policy.max_length === 128, `${label}: policy shape`);
    ok(!/hash|scrypt/i.test(text), `${label}: no hash material`);
    return JSON.stringify({ message: b.message, policy: b.policy });
  };

  // ---- 1. administrator account creation
  for (const [pw, code] of [["short", "password_too_short"], ["password1234", "password_too_common"], ["x".repeat(129).replace(/x/g, (m, i) => "ab"[i % 2]) + "q", "password_too_long"], ["ctrl\u0007char-passphrase", "password_invalid_characters"]]) {
    const text = await assertPolicy(await t.post("/admin/users", { email: "new1@x.test", password: pw, role: "ochiga_staff" }, sup.cookie), code, "create");
    ok(!text.includes(JSON.stringify(pw).slice(1, -1)), "create: password not echoed");
  }
  eq(await t.store.getAdminUserByEmail("new1@x.test"), null, "rejected create persisted nothing");
  const created = await t.post("/admin/users", { email: "new2@x.test", password: STRONG, role: "ochiga_staff" }, sup.cookie);
  ok(created.status === 200 || created.status === 201, "create with strong passphrase succeeds: " + created.status + " " + (await created.clone().text()).slice(0, 200));
  eq((await t.login("new2@x.test", STRONG)).status, 200, "created user signs in");
  eq((await t.post("/admin/users", { email: "new3@x.test", password: STRONG, role: "ochiga_staff" }, viewer.cookie)).status, 403, "viewer cannot create users");

  // ---- 2. admin sets another user's password (PATCH)
  const target = await t.store.getAdminUserByEmail("viewer@x.test");
  await assertPolicy(await t.patch(`/admin/users/${target.id}`, { password: "short" }, sup.cookie), "password_too_short", "patch");
  eq((await t.login("viewer@x.test", "viewer-pass-phrase-1")).status, 200, "rejected patch left the old password valid");
  eq((await t.patch(`/admin/users/${target.id}`, { password: "new viewer passphrase 7" }, sup.cookie)).status, 200, "patch with strong password");
  eq((await t.login("viewer@x.test", "new viewer passphrase 7")).status, 200, "patched password works");
  eq((await t.patch(`/admin/users/${target.id}`, { display_name: "Renamed" }, sup.cookie)).status, 200, "patch without password unaffected by policy");
  eq((await t.patch(`/admin/users/${target.id}`, { password: STRONG }, viewer.cookie)).status, 403, "viewer cannot set another user's password");

  // ---- 3. self-service change
  const sess = await t.login("new2@x.test", STRONG);
  eq((await t.post("/admin/session/password", { current_password: STRONG, new_password: "whatever fine pass 1" })).status, 401, "unauthenticated change refused");
  eq((await t.post("/admin/session/password", { current_password: "wrong-current-value", new_password: "another fine pass 22" }, sess.cookie)).status, 401, "wrong current password refused");
  await assertPolicy(await t.post("/admin/session/password", { current_password: STRONG, new_password: "short" }, sess.cookie), "password_too_short", "change");
  await assertPolicy(await t.post("/admin/session/password", { current_password: STRONG, new_password: "Password1234" }, sess.cookie), "password_too_common", "change");
  eq((await t.login("new2@x.test", STRONG)).status, 200, "failed change kept the old password");
  const ch = await t.post("/admin/session/password", { current_password: STRONG, new_password: "brand new pass phrase 9" }, sess.cookie);
  eq(ch.status, 200, "valid change succeeds");
  eq((await t.login("new2@x.test", "brand new pass phrase 9")).status, 200, "new password signs in");
  eq((await t.login("new2@x.test", STRONG)).status, 401, "old password no longer works");
  // wrong current password with a weak new one reveals nothing about policy (401 first)
  eq((await t.post("/admin/session/password", { current_password: "nope", new_password: "x" }, sess.cookie)).status, 401, "401 precedes policy so policy cannot be probed without the current password");

  // ---- 4. invitation acceptance
  const invUser = await t.store.ensureAdminUser({ email: "invitee@x.test", password_hash: hashPassword(crypto.randomBytes(8).toString("hex")), role: "viewer", display_name: "invitee", status: "invited" });
  const mkInvite = async (token, extra = {}) => t.store.createAdminInvite({ email: "invitee@x.test", admin_user_id: invUser.id, role: "viewer", display_name: "Invitee", token_hash: sha(token), status: "pending", invited_by: "super@x.test", expires_at: new Date(Date.now() + 3600e3).toISOString(), ...extra });
  await mkInvite("invite-token-a");
  eq((await t.post("/admin/session/invite/accept", { token: "invalid-token", password: "short" })).status, 400, "bad token + weak password: generic invalid invite");
  eq((await (await t.post("/admin/session/invite/accept", { token: "invalid-token", password: "short" })).json()).error, "invalid_or_expired_invite", "bad token never reveals policy result");
  await assertPolicy(await t.post("/admin/session/invite/accept", { token: "invite-token-a", password: "aaaaaaaaaaaa" }), "password_too_common", "invite");
  eq((await t.store.getAdminUserByEmail("invitee@x.test")).status, "invited", "rejected acceptance left the account invited");
  const acc = await t.post("/admin/session/invite/accept", { token: "invite-token-a", password: "invited person passphrase" });
  eq(acc.status, 200, "valid acceptance"); ok(acc.headers.get("set-cookie"), "acceptance issues a session");
  eq((await t.login("invitee@x.test", "invited person passphrase")).status, 200, "accepted password signs in");
  eq((await t.post("/admin/session/invite/accept", { token: "invite-token-a", password: "invited person passphrase" })).status, 400, "invite is single use");

  // ---- 5. reset confirmation + enumeration
  const rUser = await t.store.getAdminUserByEmail("legacy@x.test");
  const mkReset = (token, email = "legacy@x.test", extra = {}) => t.store.createPasswordResetToken({ admin_user_id: rUser.id, email, token_hash: sha(token), requested_by: "self_service", expires_at: new Date(Date.now() + 3600e3).toISOString(), ...extra });
  await mkReset("reset-token-a");
  eq((await (await t.post("/admin/session/reset/confirm", { token: "unknown-token", new_password: "short" })).json()).error, "invalid_or_expired_reset", "bad token + weak password: generic");
  await assertPolicy(await t.post("/admin/session/reset/confirm", { token: "reset-token-a", new_password: "qwertyuiop12" }), "password_too_common", "reset");
  eq((await t.login("legacy@x.test", OLD_SHORT)).status, 200, "rejected reset left the password unchanged and the token usable");
  const rc = await t.post("/admin/session/reset/confirm", { token: "reset-token-a", new_password: "restored passphrase 2026" });
  eq(rc.status, 200, "valid reset"); ok(!rc.headers.get("set-cookie"), "reset issues no session");
  eq((await t.login("legacy@x.test", "restored passphrase 2026")).status, 200, "reset password signs in");
  eq((await t.post("/admin/session/reset/confirm", { token: "reset-token-a", new_password: "restored passphrase 2027" })).status, 400, "reset token single use");
  await mkReset("reset-token-ghost", "ghost@x.test");
  const ghost = await t.post("/admin/session/reset/confirm", { token: "reset-token-ghost", new_password: "ghost passphrase 2026" });
  const ghostBody = await ghost.json();
  ok(ghost.status === 400 && ghostBody.error === "invalid_or_expired_reset", "valid token for a missing user is indistinguishable from an invalid token");
  const rq = async (email) => { const r = await t.post("/admin/session/reset/request", { email }); return [r.status, JSON.stringify(await r.json())]; };
  const known = await rq("super@x.test"), unknown = await rq("nobody@x.test");
  ok(known[0] === unknown[0] && known[1] === unknown[1], "reset request identical for known and unknown emails");

  // ---- 6. redaction (responses, audit, logs)
  const probe = "Zebra-Marmalade-Quasar-4471";
  await t.post("/admin/session/password", { current_password: "brand new pass phrase 9", new_password: probe }, (await t.login("new2@x.test", "brand new pass phrase 9")).cookie);
  const audit = JSON.stringify(await t.store.listAuditEvents(500));
  ok(!audit.includes(probe) && !audit.includes("brand new pass phrase 9") && !/scrypt/.test(audit), "audit holds no password or hash");
  ok(!t.logs.join("").includes(probe), "logs hold no password");
  const listing = JSON.stringify(await (await fetch(`${t.base}/api/lead-agents/admin/users`, { headers: { cookie: sup.cookie } })).json());
  ok(!/password_hash|scrypt/.test(listing), "Team listing exposes no hash");

  // ---- 7. session + S7.0 behaviour preserved
  const me = await fetch(`${t.base}/api/lead-agents/admin/session/me`, { headers: { cookie: sup.cookie } }); eq(me.status, 200, "existing session unaffected by policy");
  const lg = await t.post("/admin/session/login", { email: "legacy@x.test", password: "restored passphrase 2026" });
  ok(/Max-Age=604800/.test(lg.headers.get("set-cookie")), "seven-day session preserved");
  eq((await t.login("fresh@x.test", "k-s71-api-key")).status, 401, "API-key fallback still rejected");
  const vt = await t.store.getAdminUserByEmail("viewer@x.test");
  await t.store.updateAdminUser(vt.id, { status: "inactive" });
  eq((await fetch(`${t.base}/api/lead-agents/admin/session/me`, { headers: { cookie: viewer.cookie } })).status, 401, "deactivation revokes the session");

  // ---- 8. administrator recovery honours the policy
  const { store: rs } = await createTempStore();
  const rc0 = { adminEmail: "boss@x.test", adminRole: "super_admin", adminRecovery: true };
  await bootstrapAdminUser(rs, { ...rc0, adminPassword: "password1234" });
  eq(await rs.getAdminUserByEmail("boss@x.test"), null, "recovery refuses a common password");
  await bootstrapAdminUser(rs, { ...rc0, adminPassword: "short" });
  eq(await rs.getAdminUserByEmail("boss@x.test"), null, "recovery refuses a short password");
  await bootstrapAdminUser(rs, { ...rc0, adminPassword: "recovery passphrase 2026" });
  ok(verifyPassword("recovery passphrase 2026", (await rs.getAdminUserByEmail("boss@x.test")).password_hash), "recovery accepts a compliant password");

  await t.close();
  console.log(`S7.1 password policy: ${passed} assertions PASS`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
