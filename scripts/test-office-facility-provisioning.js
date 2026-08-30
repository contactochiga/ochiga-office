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
  // Deletion eligibility for each fake estate -- controllable per test
  // section so both the "safe to delete" and "blocked" paths are proven
  // against the real Office delete route, not just assumed.
  const deletable = new Set(["estate_new_1"]);
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
      const estateId = body.name === "Blocked Facility" ? "estate_blocked_1" : "estate_new_1";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        estate: { id: estateId, name: body.name },
        invite: { id: `invite_${estateId}`, expires_at: "2026-09-15T00:00:00.000Z" },
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
    const deleteMatch = req.url.match(/^\/office\/facility\/estates\/([^/]+)$/);
    if (deleteMatch && req.method === "DELETE") {
      const estateId = deleteMatch[1];
      if (deletable.has(estateId)) {
        deletable.delete(estateId);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, deleted: true, estate_id: estateId, invites_removed: 1 }));
        return;
      }
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "facility_has_operational_dependencies", blocking: ["Facility has Homes"] }));
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
    // Office->Backend's own facility-export API surface -- unrelated to
    // the activation link, kept here only to prove it's never consulted
    // for that purpose (facilityAppUrl below is the real frontend).
    officeFacilityBaseUrl: "https://wrong-host-office-to-backend-export-api.example",
    facilityAppUrl: "https://facility.example.oyi",
    // Deterministic, not ambient-env-dependent: no real email provider
    // configured, so sendOfficeEmail always resolves to
    // "not delivered, not configured" -- exactly the honest
    // invitation_undelivered path this test proves, not the real Resend
    // API (that integration is Resend's/Backend's concern, not this
    // provisioning-logic test's).
    officeEmailProvider: "",
    resendApiKey: "",
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
    assert.equal(provisionBody.provisioning.ok, true, "Backend estate/invite creation must succeed independent of email delivery");
    // No email provider is configured in this test -- the invite/token
    // was genuinely created and is valid, but must not be labeled the
    // same as an actually-delivered invitation (production incident:
    // "Invitation Sent" was shown even when the owner email never
    // arrived).
    assert.equal(provisionBody.workspace.status, "invitation_undelivered", "an undelivered email must produce a distinct, honest status from a delivered one");
    assert.equal(provisionBody.workspace.checklist.onboarding_email, "not_delivered");
    assert.match(provisionBody.workspace.notes || "", /email was not delivered/i, "the real, non-secret failure reason must be recorded, not silently dropped");
    assert.equal(
      provisionBody.workspace.activation_link,
      "https://facility.example.oyi/facility-invite?token=raw-activation-token-abc",
      "activation link must point at facilityAppUrl (never officeFacilityBaseUrl) and carry the exact token, even though email delivery is unconfigured in this test"
    );

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
    assert.equal(linkedRecord.facility_workspace.status, "invitation_undelivered", "the list projection must not misreport an undelivered invitation as sent");
    console.log("C. Portfolio record reflects real linkage + honest owner_activated status — PASS");

    // D. Resend rotates the token via Backend and updates the workspace;
    // revoke marks it revoked. Neither duplicates Backend's own SQL --
    // both are thin proxies, proven by the fake Backend receiving the
    // exact estate-scoped call. The response must also honestly report
    // that the (still undelivered, no provider configured) email failed
    // again, with a real reason -- not silently claim success.
    const resendRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio/${portfolioId}/facility-invite/resend`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
    });
    assert.equal(resendRes.status, 200);
    const resendBody = await resendRes.json();
    assert.equal(resendBody.email_delivered, false);
    assert.ok(resendBody.email_delivery_reason, "a resend response must carry the real reason when email delivery fails, not just a bare false");
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

    // F. Cross-tenant/unauthorized Office caller cannot delete a Portfolio
    // record -- same crm.manage gate as provisioning, checked before
    // anything is touched.
    const deleteDenyRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio/${bareId}`, {
      method: "DELETE",
      headers: { cookie: readerCookie },
    });
    assert.equal(deleteDenyRes.status, 403, "ochiga_staff lacks crm.manage and must be denied at delete");
    const stillThereRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio`, { headers: { cookie } });
    assert.ok((await stillThereRes.json()).collection.some((p) => p.id === bareId), "an unauthorized delete attempt must not remove anything");
    console.log("F. Non-authorized Office role cannot delete a Portfolio record — PASS");

    // G. Deleting a never-provisioned Portfolio record (no linked Facility
    // at all) succeeds immediately -- no Backend call needed or made.
    const callsBeforeBareDelete = calls.length;
    const deleteBareRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio/${bareId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(deleteBareRes.status, 200);
    const deleteBareBody = await deleteBareRes.json();
    assert.equal(deleteBareBody.deleted, true);
    assert.equal(calls.length, callsBeforeBareDelete, "deleting a Portfolio record with no linked Facility must never call Backend");
    const afterBareDeleteList = await (await fetch(`${base}/api/lead-agents/admin/office/portfolio`, { headers: { cookie } })).json();
    assert.ok(!afterBareDeleteList.collection.some((p) => p.id === bareId), "the deleted Portfolio record must actually be gone");
    console.log("G. Un-provisioned Portfolio record deletes immediately, no Backend call — PASS");

    // H. Deleting a Portfolio record linked to a real (eligible-for-
    // deletion) Facility calls Backend's delete, and removes both the
    // Portfolio record and its local facility_workspace bookkeeping.
    const deleteLinkedRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio/${portfolioId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(deleteLinkedRes.status, 200);
    assert.equal((await deleteLinkedRes.json()).deleted, true);
    const deleteCall = calls.find((c) => c.method === "DELETE" && c.url === "/office/facility/estates/estate_new_1");
    assert.ok(deleteCall, "delete must call Backend's DELETE /office/facility/estates/:estateId, scoped by the linked estate_id");
    const afterLinkedDeleteList = await (await fetch(`${base}/api/lead-agents/admin/office/portfolio`, { headers: { cookie } })).json();
    assert.ok(!afterLinkedDeleteList.collection.some((p) => p.id === portfolioId), "the Portfolio record must be removed once Backend confirms the Facility is safe to delete");
    console.log("H. Portfolio record linked to an eligible Facility deletes via Backend, both records removed — PASS");

    // I. Repeated delete on the now-gone Portfolio record is idempotent --
    // not an error, not a dangerous re-attempt.
    const repeatDeleteRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio/${portfolioId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(repeatDeleteRes.status, 200);
    assert.equal((await repeatDeleteRes.json()).already_deleted, true);
    console.log("I. Repeated delete on an already-gone Portfolio record is safe and idempotent — PASS");

    // J. A Facility with real operational dependencies blocks the whole
    // delete -- the Portfolio record and its workspace both survive, and
    // the blocking reason from Backend is surfaced, not swallowed.
    const blockedPortfolioRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Blocked Facility" }),
    });
    const blockedPortfolioId = (await blockedPortfolioRes.json()).record.id;
    await fetch(`${base}/api/lead-agents/admin/office/portfolio/${blockedPortfolioId}/provision-facility`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ estate_name: "Blocked Facility", facility_admin_email: "blocked-owner@example.com" }),
    });
    const deleteBlockedRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio/${blockedPortfolioId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(deleteBlockedRes.status, 409, "a Facility with operational dependencies must block the delete");
    const deleteBlockedBody = await deleteBlockedRes.json();
    assert.ok(Array.isArray(deleteBlockedBody.blocking) && deleteBlockedBody.blocking.length, "the block response must surface Backend's real blocking reasons");
    const afterBlockedList = await (await fetch(`${base}/api/lead-agents/admin/office/portfolio`, { headers: { cookie } })).json();
    const blockedRecord = afterBlockedList.collection.find((p) => p.id === blockedPortfolioId);
    assert.ok(blockedRecord, "a blocked delete must never remove the Portfolio record");
    assert.ok(blockedRecord.facility_workspace, "a blocked delete must never remove the linked facility_workspace either");
    console.log("J. Facility with operational dependencies blocks delete, nothing removed — PASS");
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
