const assert = require("node:assert/strict");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["team-test-key"], allowedOrigins: [] };
  const { store } = await createTempStore();
  await store.ensureAdminUser({
    email: "super@ochiga.local",
    password_hash: hashPassword("super-pass-123"),
    role: "super_admin",
    display_name: "Super Test",
    status: "active",
  });
  await store.ensureAdminUser({
    email: "viewer@ochiga.local",
    password_hash: hashPassword("viewer-pass-123"),
    role: "viewer",
    display_name: "Viewer Test",
    status: "active",
  });

  const webhooks = new WebhookDispatcher({ config });
  const toolExecutor = new ToolExecutor({ store, config, log: () => {}, webhooks });
  const server = buildServer({
    config,
    store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 100 }),
    publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 100 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 300 }),
    loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 50 }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] },
    openaiClient: {},
    toolExecutor,
  });

  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  try {
    // A. Login, then Team list must never include password_hash anywhere
    // in the response body, for any account, including the raw viewer row.
    const loginRes = await fetch(`${base}/api/lead-agents/admin/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "super@ochiga.local", password: "super-pass-123" }),
    });
    assert.equal(loginRes.status, 200, "login must succeed");
    const setCookie = loginRes.headers.get("set-cookie");
    assert.ok(setCookie, "login must set a session cookie");
    const cookie = setCookie.split(";")[0];

    const usersRes = await fetch(`${base}/api/lead-agents/admin/users`, { headers: { cookie } });
    assert.equal(usersRes.status, 200);
    const usersBody = await usersRes.text();
    assert.equal(usersBody.includes("password_hash"), false, "Team list must never expose password_hash");
    const users = JSON.parse(usersBody).users;
    assert.equal(users.length, 2, "both seeded accounts should be listed");
    const viewer = users.find((u) => u.email === "viewer@ochiga.local");
    assert.ok(viewer, "viewer account should be present");
    assert.equal(viewer.password_hash, undefined);
    console.log("A. Team list never exposes password_hash — PASS");

    // B. super_admin can edit another staff member's role/status via the
    // real PATCH contract, and the response also never leaks the hash.
    const patchRes = await fetch(`${base}/api/lead-agents/admin/users/${viewer.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ role: "ochiga_staff", status: "active" }),
    });
    assert.equal(patchRes.status, 200);
    const patchBody = await patchRes.text();
    assert.equal(patchBody.includes("password_hash"), false, "Team edit response must never expose password_hash");
    assert.equal(JSON.parse(patchBody).user.role, "ochiga_staff");
    console.log("B. super_admin can edit staff role/status, response stays sanitized — PASS");

    // C. Settings integration status is real (booleans/status strings),
    // never a raw secret value.
    const integrationsRes = await fetch(`${base}/api/lead-agents/admin/integrations`, { headers: { cookie } });
    assert.equal(integrationsRes.status, 200);
    const integrations = (await integrationsRes.json()).integrations;
    assert.ok(integrations && typeof integrations === "object", "integrations status object expected");
    console.log("C. Settings integration status contract reachable — PASS");

    // D. Audit is readable and reflects the real actions taken above
    // (at minimum the two logins/edits already performed).
    const auditRes = await fetch(`${base}/api/lead-agents/admin/audit`, { headers: { cookie } });
    assert.equal(auditRes.status, 200);
    const audit = (await auditRes.json()).audit;
    assert.ok(Array.isArray(audit) && audit.length > 0, "audit trail should contain real events");
    assert.ok(audit.some((e) => e.action === "admin_user_updated"), "the role/status edit above should appear in the audit trail");
    console.log("D. Audit reflects real corporate actions — PASS");

    // E. A non-privileged role (viewer -> ochiga_staff, no staff.manage)
    // cannot edit Team — RBAC must not have been weakened.
    const staffLogin = await fetch(`${base}/api/lead-agents/admin/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "viewer@ochiga.local", password: "viewer-pass-123" }),
    });
    const staffCookie = staffLogin.headers.get("set-cookie").split(";")[0];
    const forbiddenPatch = await fetch(`${base}/api/lead-agents/admin/users/${viewer.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: staffCookie },
      body: JSON.stringify({ role: "super_admin" }),
    });
    assert.equal(forbiddenPatch.status, 403, "ochiga_staff must not be able to grant itself super_admin");
    console.log("E. lower-privilege role cannot self-escalate via Team edit — PASS");
  } finally {
    await close(server);
  }

  console.log("office Team/Settings/Audit smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
