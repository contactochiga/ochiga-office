const assert = require("node:assert/strict");
const http = require("node:http");
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

// A minimal stand-in for Ochiga Backend's real GET /office/portfolio/
// projection (Ochiga-backend/src/routes/officeExport.ts). It returns the
// same SAFE, pre-aggregated shape the real route computes server-side —
// this test exists to prove Office's Portfolio route consumes that
// contract correctly and never falls back to any raw local data source,
// not to re-test Ochiga Backend's own aggregation logic (that lives in
// the Ochiga-backend repo).
function startFakeOchigaBackend(expectedApiKey) {
  let receivedAuthHeader = null;
  const server = http.createServer((req, res) => {
    receivedAuthHeader = req.headers["x-office-api-key"];
    if (req.url.startsWith("/office/portfolio/projection")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        source: "oyi-os",
        generated_at: "2026-08-13T00:00:00.000Z",
        estates: [
          { id: "estate_1", name: "Test Estate", homes_total: 40, homes_active: 30, devices_total: 15, devices_online: 12, major_open_escalations: 1, last_activity_at: "2026-08-12T00:00:00.000Z", last_activity_label: "Device activity recorded" },
        ],
        buildings: [
          { id: "building_1", estate_id: "estate_1", name: "Block A", homes_total: 20, homes_active: 15, devices_total: 6, devices_online: 5, major_open_escalations: 0, last_activity_at: "2026-08-11T00:00:00.000Z", last_activity_label: "Home activity recorded" },
        ],
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  return { server, getReceivedAuthHeader: () => receivedAuthHeader };
}

async function main() {
  const { server: fakeBackend, getReceivedAuthHeader } = startFakeOchigaBackend();
  const backendPort = await listen(fakeBackend);

  const config = {
    ...createConfig(),
    authMode: "required_api_key",
    apiKeys: ["portfolio-test-key"],
    allowedOrigins: [],
    officeBackendBaseUrl: `http://127.0.0.1:${backendPort}`,
    officeBackendApiKey: "backend-projection-test-key",
  };
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

    // A. Office authenticates to Ochiga Backend using the x-office-api-key
    // header, matching Ochiga-backend's officeCredential middleware.
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
    assert.equal(getReceivedAuthHeader(), "backend-projection-test-key", "Office must call Ochiga Backend with x-office-api-key");
    console.log("A. Office calls Ochiga Backend's projection contract with the correct credential header — PASS");

    const listBody = await listRes.text();
    assert.equal(listBody.includes("wallet_balance"), false, "Portfolio response must never expose wallet_balance");
    assert.equal(listBody.includes("live_cameras"), false, "Portfolio response must never expose live_cameras");
    assert.equal(listBody.includes("resident_count"), false, "Portfolio response must never expose resident_count");
    assert.equal(listBody.includes("permitted_users"), false, "Portfolio response must never expose permitted_users");
    console.log("B. Portfolio response never leaks raw Facility fields — PASS");

    const collection = JSON.parse(listBody).collection;
    const linked = collection.find((p) => p.id === linkedId);
    assert.ok(linked.operational_projection.linked, "linked entry should resolve a projection");
    assert.equal(linked.operational_projection.homes_total, 20, "homes_total should come from the matched building, not the estate");
    assert.equal(linked.operational_projection.homes_active, 15);
    assert.equal(linked.operational_projection.devices_total, 6);
    assert.equal(linked.operational_projection.devices_online, 5);
    assert.equal(linked.operational_projection.major_open_escalations, 0);
    assert.ok(linked.operational_projection.last_activity_at, "last_activity_at should be populated");
    console.log("C. Linked Portfolio entry consumes the backend's pre-aggregated building-level counts — PASS");

    const unlinked = collection.find((p) => p.name === "Unlinked Building");
    assert.equal(unlinked.operational_projection.linked, false, "unlinked entry must not fabricate a projection");
    assert.equal(unlinked.operational_projection.homes_total, null);
    console.log("D. Unlinked Portfolio entry honestly reports no Oyi deployment reference — PASS");

    // E. When Ochiga Backend is unreachable, Portfolio reports the
    // projection as unavailable rather than silently falling back to any
    // local/stale data source.
    await close(fakeBackend);
    const outageRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio`, { headers: { cookie } });
    const outageCollection = (await outageRes.json()).collection;
    const outageLinked = outageCollection.find((p) => p.id === linkedId);
    assert.equal(outageLinked.operational_projection.linked, false);
    assert.equal(outageLinked.operational_projection.available, false, "must honestly report unavailable, not a stale cached value");
    console.log("E. Ochiga Backend outage is reported honestly, no silent fallback — PASS");
  } finally {
    await close(server);
  }

  console.log("office Portfolio operational projection smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
