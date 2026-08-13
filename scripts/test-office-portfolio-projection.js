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
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["portfolio-test-key"], allowedOrigins: [] };
  const { store } = await createTempStore();
  await store.ensureAdminUser({
    email: "super@ochiga.local",
    password_hash: hashPassword("super-pass-123"),
    role: "super_admin",
    display_name: "Super Test",
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
    const loginRes = await fetch(`${base}/api/lead-agents/admin/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "super@ochiga.local", password: "super-pass-123" }),
    });
    assert.equal(loginRes.status, 200, "login must succeed");
    const cookie = loginRes.headers.get("set-cookie").split(";")[0];

    // A. Seed a fake Facility/Consumer sync snapshot via the real import
    // contract (mirrors what officeSync.syncFacility/syncConsumer would
    // have produced), including sensitive fields the projection must
    // never re-expose (wallet_balance, live_cameras, resident_count).
    const importRes = await fetch(`${base}/api/lead-agents/admin/office/import`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        source: "facility",
        payload: {
          collections: {
            estates: [{
              id: "estate_1", name: "Test Estate", homes_count: 40, devices_count: 120,
              wallet_balance: 500000, resident_count: 88, updated_at: "2026-08-01T00:00:00.000Z",
            }],
            buildings: [{
              id: "building_1", estate_id: "estate_1", name: "Block A", homes_count: 20,
              devices_count: 60, live_cameras: 12, permitted_users: 44, occupancy_pct: 90,
              updated_at: "2026-08-02T00:00:00.000Z",
            }],
            homes: [],
            devices: [
              { id: "device_1", estate_id: "estate_1", building_id: "building_1", home_id: "home_1", name: "Gate", category: "access", status: "online" },
              { id: "device_2", estate_id: "estate_1", building_id: "building_1", home_id: "home_2", name: "Meter", category: "utility", status: "offline" },
            ],
          },
        },
      }),
    });
    assert.equal(importRes.status, 200, "office import must succeed");
    console.log("A. Seeded Facility sync snapshot via real import contract — PASS");

    // B. A Portfolio entry linked via backend_building_id gets a safe
    // aggregate operational_projection: correct counts, never the raw
    // sensitive fields.
    const createRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Linked Building", backend_building_id: "building_1" }),
    });
    assert.equal(createRes.status, 201);
    const linkedId = (await createRes.json()).record.id;

    const unlinkedRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Unlinked Building" }),
    });
    assert.equal(unlinkedRes.status, 201);

    const listRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio`, { headers: { cookie } });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.text();
    assert.equal(listBody.includes("wallet_balance"), false, "Portfolio response must never expose wallet_balance");
    assert.equal(listBody.includes("live_cameras"), false, "Portfolio response must never expose live_cameras");
    assert.equal(listBody.includes("resident_count"), false, "Portfolio response must never expose resident_count");
    assert.equal(listBody.includes("permitted_users"), false, "Portfolio response must never expose permitted_users");
    console.log("B. Portfolio response never leaks raw Facility fields — PASS");

    const collection = JSON.parse(listBody).collection;
    const linked = collection.find((p) => p.id === linkedId);
    assert.ok(linked.operational_projection.linked, "linked entry should resolve a projection");
    assert.equal(linked.operational_projection.homes_total, 20, "homes_total should come from the matched building");
    assert.equal(linked.operational_projection.devices_total, 2, "devices_total should come from matched devices");
    assert.equal(linked.operational_projection.devices_online, 1, "devices_online should count only status=online");
    assert.ok(linked.operational_projection.last_synced_at, "last_synced_at should be populated");
    console.log("C. Linked Portfolio entry computes correct safe aggregate counts — PASS");

    const unlinked = collection.find((p) => p.name === "Unlinked Building");
    assert.equal(unlinked.operational_projection.linked, false, "unlinked entry must not fabricate a projection");
    assert.equal(unlinked.operational_projection.homes_total, null);
    console.log("D. Unlinked Portfolio entry honestly reports no Oyi deployment reference — PASS");
  } finally {
    await close(server);
  }

  console.log("office Portfolio operational projection smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
