const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");

// Historical Vercel alias: retained only as an adversarial proxy-header value
// proving it can no longer influence any user-facing identity URL.
const LEGACY_HOST = "ochiga-office.vercel.app";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function main() {
  const serverSource = fs.readFileSync(require.resolve("../src/lead-agents/server"), "utf8");
  const currentShellSource = fs.readFileSync(require.resolve("../public/office/office.js"), "utf8");
  assert.equal(serverSource.includes('absoluteUrl(req, "/dashboard?mode='), false, "identity links never target the legacy dashboard shell");
  assert.ok(currentShellSource.includes("/api/lead-agents/admin/session/reset/confirm"), "current shell handles recovery tokens");
  assert.ok(currentShellSource.includes("/api/lead-agents/admin/session/invite/accept"), "current shell handles invite tokens");
  const config = {
    ...createConfig(),
    environment: "production",
    officeAppUrl: "https://office.ochiga.com.ng",
    authMode: "required_api_key",
    apiKeys: [],
    allowedOrigins: [],
    officeEmailProvider: "resend",
    resendApiKey: "test-resend-key",
  };
  const { store } = await createTempStore();
  await store.ensureAdminUser({
    email: "owner@ochiga.local",
    password_hash: hashPassword("owner-pass-123"),
    role: "super_admin",
    display_name: "Owner",
    status: "active",
  });
  await store.ensureAdminUser({
    email: "viewer@ochiga.local",
    password_hash: hashPassword("viewer-pass-123"),
    role: "viewer",
    display_name: "Viewer",
    status: "active",
  });
  const webhooks = new WebhookDispatcher({ config });
  const server = buildServer({
    config,
    store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 100 }),
    publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 100 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 300 }),
    loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 50 }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] },
    openaiClient: {},
    toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks }),
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const realFetch = global.fetch;
  const sentEmails = [];
  global.fetch = async (url, options) => {
    if (String(url) === "https://api.resend.com/emails") {
      sentEmails.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ id: `email-${sentEmails.length}` }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(url, options);
  };
  const login = async (email, password) => {
    const response = await fetch(`${base}/api/lead-agents/admin/session/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
    });
    return { response, cookie: response.headers.get("set-cookie")?.split(";")[0] || "" };
  };
  const invite = (cookie, body) => fetch(`${base}/api/lead-agents/admin/users/invite`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      "x-forwarded-host": LEGACY_HOST,
      "x-forwarded-proto": "https",
    },
    body: JSON.stringify(body),
  });

  try {
    const owner = await login("owner@ochiga.local", "owner-pass-123");
    assert.equal(owner.response.status, 200);
    const viewer = await login("viewer@ochiga.local", "viewer-pass-123");
    const forbidden = await invite(viewer.cookie, { email: "blocked@example.com" });
    assert.equal(forbidden.status, 403, "ordinary staff cannot invite");

    const details = {
      email: "new.staff@example.com",
      display_name: "New Staff",
      phone: "+2348012345678",
      office_position: "Operations Lead",
      role: "ochiga_staff",
    };
    const invitedResponse = await invite(owner.cookie, details);
    assert.equal(invitedResponse.status, 201);
    const invited = await invitedResponse.json();
    assert.equal(invited.invite.email, details.email, "recipient is dynamic and correct");
    assert.equal(invited.invite.token_hash, undefined, "token hash is never exposed");
    assert.ok(invited.invite_url.startsWith("https://office.ochiga.com.ng/office?"));
    assert.equal(invited.invite_url.includes(LEGACY_HOST), false, "proxy/legacy host cannot control redirects");
    const staffBefore = await store.getAdminUserByEmail(details.email);
    assert.equal(staffBefore.status, "invited");
    assert.equal(staffBefore.role, details.role);
    assert.equal(staffBefore.phone, details.phone);
    assert.equal(staffBefore.office_position, details.office_position);
    assert.equal(invited.invite.admin_user_id, staffBefore.id, "invite links to the durable staff record");

    const resendResponse = await invite(owner.cookie, details);
    assert.equal(resendResponse.status, 201, "pending invitation can be resent deterministically");
    const resend = await resendResponse.json();
    const invites = await store.listAdminInvites();
    assert.equal(invites.filter((row) => row.email === details.email && row.status === "pending").length, 1);
    assert.equal(invites.filter((row) => row.email === details.email && row.status === "superseded").length, 1);

    const token = new URL(resend.invite_url).searchParams.get("token");
    const acceptedResponse = await fetch(`${base}/api/lead-agents/admin/session/invite/accept`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "new-staff-pass-123" }),
    });
    assert.equal(acceptedResponse.status, 200);
    assert.ok(acceptedResponse.headers.get("set-cookie"), "activation establishes Office session");
    const activated = await store.getAdminUserByEmail(details.email);
    assert.equal(activated.id, staffBefore.id, "activation updates, rather than duplicates, the staff identity");
    assert.equal(activated.status, "active");
    assert.equal(activated.role, details.role);
    assert.equal(activated.phone, details.phone);
    assert.equal(activated.office_position, details.office_position);

    const reused = await fetch(`${base}/api/lead-agents/admin/session/invite/accept`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "another-pass" }),
    });
    assert.equal(reused.status, 400, "an invitation is single-use");
    const invalid = await fetch(`${base}/api/lead-agents/admin/session/invite/accept`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "invalid", password: "another-pass" }),
    });
    assert.equal(invalid.status, 400);

    const forgot = await fetch(`${base}/api/lead-agents/admin/session/reset/request`, {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-host": LEGACY_HOST },
      body: JSON.stringify({ email: "viewer@ochiga.local" }),
    });
    assert.equal(forgot.status, 202);
    assert.equal((await forgot.json()).invite_url, undefined, "self-service reset does not expose tokens");
    const resetEmail = sentEmails.find((message) => message.to === "viewer@ochiga.local");
    assert.ok(resetEmail, "forgot-password sends the recovery email to the account");
    const resetUrl = resetEmail.text.match(/https:\/\/[^\s]+/)?.[0];
    assert.ok(resetUrl?.startsWith("https://office.ochiga.com.ng/office?mode=reset"));
    assert.equal(resetUrl.includes(LEGACY_HOST), false);
    const resetToken = new URL(resetUrl).searchParams.get("token");
    const resetConfirm = await fetch(`${base}/api/lead-agents/admin/session/reset/confirm`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: resetToken, new_password: "viewer-reset-pass-456" }),
    });
    assert.equal(resetConfirm.status, 200, "current-shell recovery token updates the password");
    assert.equal((await login("viewer@ochiga.local", "viewer-reset-pass-456")).response.status, 200, "reset password works with existing login");
    const expiredRaw = "expired-reset-proof";
    await store.createPasswordResetToken({ email: "viewer@ochiga.local", token_hash: crypto.createHash("sha256").update(expiredRaw).digest("hex"), status: "pending", expires_at: new Date(Date.now() - 1000).toISOString() });
    const expired = await fetch(`${base}/api/lead-agents/admin/session/reset/confirm`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: expiredRaw, new_password: "unused" }),
    });
    assert.equal(expired.status, 400, "expired recovery token is rejected cleanly");
    const duplicate = await invite(owner.cookie, details);
    assert.equal(duplicate.status, 409, "active account duplicate is rejected");

    const staffLogin = await login(details.email, "new-staff-pass-123");
    assert.equal(staffLogin.response.status, 200, "activated staff can log in");
    assert.ok((await store.getAdminUserByEmail(details.email)).last_login_at, "successful login records real activity");
    console.log("staff onboarding lifecycle, security, canonical URL and login regression — PASS");
  } finally {
    global.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
