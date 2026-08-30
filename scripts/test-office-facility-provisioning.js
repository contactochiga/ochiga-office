const assert = require("node:assert/strict");
const http = require("node:http");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");

// Office->Facility provisioning lifecycle. "Portfolio -> New" is now the
// real provisioning workflow (requirement #1) -- this test proves the
// whole chain: Portfolio record created -> Backend's real /office/facility/
// provision intake called with the right fields/headers -> owner-invite
// email built from the returned token -> facility_workspaces status/
// checklist updated -> Portfolio record linked via backend_estate_id ->
// resend/revoke proxy through to Backend correctly -> RBAC enforced.
// A minimal fake Ochiga Backend stands in for the real intake/resend/
// revoke/projection routes (Ochiga-backend/src/routes/officeExport.ts) --
// this test exists to prove Office's side of the contract, not to
// re-test Backend's own RPC/migration logic (that lives in that repo).

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

function startFakeOchigaBackend() {
  const calls = [];
  let ownerActivated = false;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : {};
    calls.push({ method: req.method, url: req.url, headers: req.headers, body });

    if (req.url === "/office/facility/provision" && req.method === "POST") {
      if (!body.name || !body.admin_email) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "name_and_admin_email_required" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        estate: { id: "estate_new_1", name: body.name },
        invite: { id: "invite_1", expires_at: "2026-09-15T00:00:00.000Z" },
        activation_token: "raw-activation-token-abc",
      }));
      return;
    }
    if (req.url === "/office/facility/estates/estate_new_1/owner-invite/resend" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, invite: { id: "invite_1", expires_at: "2026-09-20T00:00:00.000Z" }, activation_token: "raw-rotated-token-xyz" }));
      return;
    }
    if (req.url === "/office/facility/estates/estate_new_1/owner-invite/revoke" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, invite: { id: "invite_1" } }));
      return;
    }
    if (req.url.startsWith("/office/portfolio/projection")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        estates: [{ id: "estate_new_1", name: "New Facility", owner_activated: ownerActivated, homes_total: 0, homes_active: 0, devices_total: 0, devices_online: 0, major_open_escalations: 0, last_activity_at: null, last_activity_label: "No recent activity recorded" }],
        buildings: [],
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  return { server, calls, setOwnerActivated: (v) => { ownerActivated = v; } };
}

async function main() {
  const { server: fakeBackend, calls } = startFakeOchigaBackend();
  const backendPort = await listen(fakeBackend);

  const config = {
    ...createConfig(),
    authMode: "required_api_key",
    apiKeys: ["provisioning-test-key"],
    allowedOrigins: [],
    officeBackendBaseUrl: `http://127.0.0.1:${backendPort}`,
    officeBackendApiKey: "backend-provisioning-test-key",
    officeFacilityBaseUrl: "https://facility.example.oyi",
  };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super Test", status: "active" });
  await store.ensureAdminUser({ email: "reader@ochiga.local", password_hash: hashPassword("reader-pass-123"), role: "ochiga_staff", display_name: "Reader Test", status: "active" });

  const webhooks = new WebhookDispatcher({ config });
  const toolExecutor = new ToolExecutor({ store, config, log: () => {}, webhooks });
  const server = buildServer({
    config,
    store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 200 }),
    publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 200 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 300 }),
    loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 50 }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] },
    openaiClient: {},
    toolExecutor,
  });

  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  async function login(email, password) {
    const res = await fetch(`${base}/api/lead-agents/admin/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 200, `login must succeed for ${email}`);
    return res.headers.get("set-cookie").split(";")[0];
  }

  try {
    const cookie = await login("super@ochiga.local", "super-pass-123");
    const readerCookie = await login("reader@ochiga.local", "reader-pass-123");

    // A. A staffer without manage_commercial (crm.manage) can still create
    // Portfolio records (portfolio.manage) but must be denied at the actual
    // provisioning step -- Backend-callable provisioning stays behind the
    // same senior-tier permission the pre-existing lead-anchored route
    // already required, not the broader portfolio.manage grant.
    const portfolioForDenyRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: readerCookie },
      body: JSON.stringify({ name: "Denied Attempt" }),
    });
    assert.equal(portfolioForDenyRes.status, 201, "ochiga_staff has portfolio.manage and may still create the Portfolio record itself");
    const deniedPortfolioId = (await portfolioForDenyRes.json()).record.id;

    const provisionDenyRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio/${deniedPortfolioId}/provision-facility`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: readerCookie },
      body: JSON.stringify({ estate_name: "Denied Attempt", facility_admin_email: "denied@example.com" }),
    });
    assert.equal(provisionDenyRes.status, 403, "ochiga_staff lacks crm.manage and must be denied at the provisioning step");
    console.log("A. Non-authorized Office role can create a Portfolio record but cannot provision a Facility — PASS");

    // B. Portfolio -> New: create the Portfolio record, then provision.
    const portfolioRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "New Facility", client_account: "Acme Co", location: "Lagos", relationship_type: "customer_building", business_unit: "technology" }),
    });
    assert.equal(portfolioRes.status, 201);
    const portfolioId = (await portfolioRes.json()).record.id;

    const provisionRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio/${portfolioId}/provision-facility`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ estate_name: "New Facility", facility_type: "estate", address: "1 Oyi Way", timezone: "Africa/Lagos", facility_admin_email: "owner@example.com", facility_admin_full_name: "Jane Owner", facility_admin_phone: "+2340000000" }),
    });
    assert.equal(provisionRes.status, 201);
    const provisionBody = await provisionRes.json();
    assert.equal(provisionBody.provisioning.ok, true);
    assert.equal(provisionBody.workspace.status, "invitation_sent");
    assert.ok(provisionBody.workspace.activation_link.includes("raw-activation-token-abc"), "activation link must carry the token Backend returned");

    const provisionCall = calls.find((c) => c.url === "/office/facility/provision");
    assert.equal(provisionCall.headers["x-office-api-key"], "backend-provisioning-test-key", "provisioning must authenticate with x-office-api-key");
    assert.equal(provisionCall.body.timezone, "Africa/Lagos", "timezone must reach Backend");
    assert.equal(provisionCall.body.admin_email, "owner@example.com");
    assert.equal(provisionBody.workspace.portfolio_id, portfolioId, "workspace must be linked to the Portfolio record, not orphaned");
    console.log("B. Portfolio -> New provisions the Facility and links the workspace — PASS");

    // C. The Portfolio record itself is now linked to the real backend
    // estate (backend_estate_id), and the list response surfaces the live
    // owner_activated signal plus the workspace status -- both signals,
    // no fabrication.
    const listRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio`, { headers: { cookie } });
    const listBody = await listRes.json();
    const linkedRecord = listBody.collection.find((p) => p.id === portfolioId);
    assert.equal(linkedRecord.backend_estate_id, "estate_new_1");
    assert.equal(linkedRecord.operational_projection.owner_activated, false, "owner has not activated yet -- must not be fabricated as true");
    assert.equal(linkedRecord.facility_workspace.status, "invitation_sent");
    console.log("C. Portfolio record reflects real linkage + honest owner_activated status — PASS");

    // D. Resend rotates the token via Backend and updates the workspace;
    // revoke marks it revoked. Neither duplicates Backend's own SQL --
    // both are thin proxies, proven by the fake Backend receiving the
    // exact estate-scoped call.
    const resendRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio/${portfolioId}/facility-invite/resend`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
    });
    assert.equal(resendRes.status, 200);
    const resendCall = calls.find((c) => c.url === "/office/facility/estates/estate_new_1/owner-invite/resend");
    assert.ok(resendCall, "resend must call Backend scoped to the linked estate_id, never a raw invite id");

    const revokeRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio/${portfolioId}/facility-invite/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
    });
    assert.equal(revokeRes.status, 200);
    const revokeCall = calls.find((c) => c.url === "/office/facility/estates/estate_new_1/owner-invite/revoke");
    assert.ok(revokeCall, "revoke must call Backend scoped to the linked estate_id, never a raw invite id");

    const afterRevokeList = await (await fetch(`${base}/api/lead-agents/admin/office/portfolio`, { headers: { cookie } })).json();
    assert.equal(afterRevokeList.collection.find((p) => p.id === portfolioId).facility_workspace.status, "invite_revoked");
    console.log("D. Resend/Revoke proxy correctly to Backend, scoped by estate_id — PASS");

    // E. A Portfolio record with no linked Facility provisioning honestly
    // reports that, never a fabricated workspace/status.
    const bareRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Never Provisioned" }),
    });
    const bareId = (await bareRes.json()).record.id;
    const finalList = await (await fetch(`${base}/api/lead-agents/admin/office/portfolio`, { headers: { cookie } })).json();
    const bareRecord = finalList.collection.find((p) => p.id === bareId);
    assert.equal(bareRecord.facility_workspace, null, "an un-provisioned Portfolio record must not have a fabricated workspace");
    console.log("E. Un-provisioned Portfolio record reports honestly, no fabricated workspace — PASS");
  } finally {
    await close(server);
    await close(fakeBackend);
  }

  console.log("office Facility provisioning lifecycle smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
