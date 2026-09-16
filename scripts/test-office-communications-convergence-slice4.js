const assert = require("node:assert/strict");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { normalizeOfficeIntakeEnvelope, findOrUpsertLead } = require("../src/lead-agents/office-intake");
const { requestHandoffForLead } = require("../src/lead-agents/office-operational-workflows");

// Oyi Communications Convergence, Slice 4 -- real HTTP-surface coverage
// for the two new user-facing capabilities: Team routing settings
// (office_staff_profiles/office_staff_capabilities, team.manage-gated)
// and the existing office_handoffs queue/action routes now reachable
// from a real UI. No new handoff business logic -- accept/decline/
// assign/callback are the SAME routes Slice 2/3 already proved.

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
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["slice4-test-key"], allowedOrigins: [] };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super Test", status: "active" });
  await store.ensureAdminUser({ email: "staff@ochiga.local", password_hash: hashPassword("staff-pass-123"), role: "ochiga_staff", display_name: "Staff Test", status: "active" });
  await store.ensureAdminUser({ email: "amaka@ochiga.local", password_hash: hashPassword("amaka-pass-123"), role: "ochiga_staff", display_name: "Amaka Test", status: "active" });

  const webhooks = new WebhookDispatcher({ config });
  const toolExecutor = new ToolExecutor({ store, config, log: () => {}, webhooks });
  const server = buildServer({
    config,
    store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
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
    const superCookie = await login("super@ochiga.local", "super-pass-123");
    const staffCookie = await login("staff@ochiga.local", "staff-pass-123");

    // A. Capability catalog: team.manage required; returns the SAME
    // DEFAULT_CAPABILITIES chooseStaffForHandoff() already matches
    // against -- never a second hardcoded copy.
    const catalogForbidden = await fetch(`${base}/api/lead-agents/admin/staff/capability-catalog`, { headers: { cookie: staffCookie } });
    assert.equal(catalogForbidden.status, 403, "ordinary staff must not read the capability catalog (team.manage only)");
    const catalogRes = await fetch(`${base}/api/lead-agents/admin/staff/capability-catalog`, { headers: { cookie: superCookie } });
    assert.equal(catalogRes.status, 200);
    const catalog = (await catalogRes.json()).catalog;
    assert.ok(catalog.some((c) => c.capability === "development.commercial_jv"), "catalog must be the real, existing DEFAULT_CAPABILITIES vocabulary");
    console.log("A. Capability catalog: team.manage-gated, real vocabulary, no duplicate taxonomy — PASS");

    // B. Routing profile: team.manage required for both read and write;
    // round-trips business_unit/availability/routing_priority/capabilities.
    const profileForbidden = await fetch(`${base}/api/lead-agents/admin/staff/${encodeURIComponent("amaka@ochiga.local")}/routing-profile`, { headers: { cookie: staffCookie } });
    assert.equal(profileForbidden.status, 403, "ordinary staff must not read/configure another staff member's routing profile");

    const emptyProfileRes = await fetch(`${base}/api/lead-agents/admin/staff/${encodeURIComponent("amaka@ochiga.local")}/routing-profile`, { headers: { cookie: superCookie } });
    assert.equal(emptyProfileRes.status, 200);
    const emptyProfile = await emptyProfileRes.json();
    assert.equal(emptyProfile.profile, null, "a staff member with no configuration yet must show no fabricated profile");
    assert.deepEqual(emptyProfile.capabilities, []);

    const patchRes = await fetch(`${base}/api/lead-agents/admin/staff/${encodeURIComponent("amaka@ochiga.local")}/routing-profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: superCookie },
      body: JSON.stringify({
        business_unit: "development",
        availability: "available",
        routing_priority: 40,
        capabilities: [{ capability: "development.commercial_jv", specialty: "land_jv" }, { capability: "development.architecture", specialty: "" }],
      }),
    });
    assert.equal(patchRes.status, 200);
    const patched = await patchRes.json();
    assert.equal(patched.profile.business_unit, "development");
    assert.equal(patched.profile.availability, "available");
    assert.equal(Number(patched.profile.routing_priority), 40);
    assert.equal(patched.capabilities.length, 2);

    // Diff-based capability replace: dropping one, keeping one.
    const patch2Res = await fetch(`${base}/api/lead-agents/admin/staff/${encodeURIComponent("amaka@ochiga.local")}/routing-profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: superCookie },
      body: JSON.stringify({
        business_unit: "development",
        availability: "unavailable",
        routing_priority: 40,
        capabilities: [{ capability: "development.commercial_jv", specialty: "land_jv" }],
      }),
    });
    const patched2 = await patch2Res.json();
    assert.equal(patched2.capabilities.length, 1, "removed capabilities must actually be removed, not just left stale");
    assert.equal(patched2.profile.availability, "unavailable");
    console.log("B. Routing profile: team.manage-gated read/write, real round-trip, diff-based capability replace — PASS");

    // C. Golden journey over real HTTP: a staff member configured as
    // available now gets a real HANDOFF routed and visible in the
    // EXISTING office_handoffs queue route; accepting through the
    // EXISTING action route flips lead_channel_states to human_active
    // with the real staff email as owner.
    await fetch(`${base}/api/lead-agents/admin/staff/${encodeURIComponent("amaka@ochiga.local")}/routing-profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: superCookie },
      body: JSON.stringify({ business_unit: "development", availability: "available", routing_priority: 50, capabilities: [{ capability: "development.commercial_jv", specialty: "" }] }),
    });

    const envelope = normalizeOfficeIntakeEnvelope({
      request_id: "req-slice4-golden",
      source_site: "ochiga_website",
      source_form: "land_jv",
      business_unit: "development",
      inquiry_type: "land_jv",
      contact: { name: "Golden Journey Lead", email: "golden4@example.com", phone: "+2348100000099" },
      organization: { name: "Golden Estates", location: "Ikoyi, Lagos" },
      payload: { message: "4 acres for JV." },
      consent: { marketing_followup: true },
    });
    const { lead } = await findOrUpsertLead(store, envelope);
    const routed = await requestHandoffForLead(store, { leadId: lead.id, businessUnit: "development", requestedCapability: "development.commercial_jv", reason: "Oyi Core recommends human review." });
    assert.equal(routed.routing.status, "matched");
    assert.equal(routed.handoff.assigned_staff_id, "amaka@ochiga.local");

    // Visible in the existing queue route (the Slice 4 Handoff Queue
    // page's real data source).
    const queueRes = await fetch(`${base}/api/lead-agents/admin/office/handoffs`, { headers: { cookie: superCookie } });
    assert.equal(queueRes.status, 200);
    const queue = (await queueRes.json()).queue;
    const queued = queue.find((h) => h.handoff_id === routed.handoff.handoff_id);
    assert.ok(queued, "the routed handoff must be visible through the existing queue route");
    assert.equal(queued.lead_id, lead.id, "the queue entry must carry the real lead_id for CRM linkage");
    assert.equal(queued.assigned_staff_id, "amaka@ochiga.local");
    assert.equal(queued.status, "offered");

    // Accept via the EXISTING action route (no new business logic).
    const acceptRes = await fetch(`${base}/api/lead-agents/admin/office/handoffs/${encodeURIComponent(routed.handoff.handoff_id)}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: superCookie },
      body: JSON.stringify({}),
    });
    assert.equal(acceptRes.status, 200);
    const accepted = (await acceptRes.json()).handoff;
    assert.equal(accepted.status, "accepted");

    const channelState = await store.getLeadChannelState(lead.id, "whatsapp");
    assert.equal(channelState.human_status, "human_active");
    assert.ok(channelState.human_owner, "human_owner must be set to a real staff identity");
    console.log("C. Golden journey over real HTTP: configured staff -> routed -> visible in existing queue route -> accept via existing action route -> human_active — PASS");

    // D. Unassigned handoff remains visible, honestly, when nobody is
    // eligible -- no fabricated assignment.
    const envelope2 = normalizeOfficeIntakeEnvelope({
      request_id: "req-slice4-unassigned",
      source_site: "ochiga_website",
      source_form: "land_jv",
      business_unit: "development",
      inquiry_type: "land_jv",
      contact: { name: "Unassigned Lead", email: "unassigned4@example.com", phone: "+2348100000098" },
      organization: { name: "Unassigned Estates", location: "Ikoyi, Lagos" },
      payload: { message: "2 acres for JV." },
      consent: { marketing_followup: true },
    });
    const { lead: lead2 } = await findOrUpsertLead(store, envelope2);
    const routed2 = await requestHandoffForLead(store, { leadId: lead2.id, businessUnit: "technology", requestedCapability: "technology.oyi_deployment", reason: "test" });
    assert.equal(routed2.routing.status, "unavailable");
    const queueRes2 = await fetch(`${base}/api/lead-agents/admin/office/handoffs`, { headers: { cookie: superCookie } });
    const queue2 = (await queueRes2.json()).queue;
    const unassigned = queue2.find((h) => h.handoff_id === routed2.handoff.handoff_id);
    assert.ok(unassigned, "an unmatched handoff must remain visible in the queue, never disappear");
    assert.equal(unassigned.status, "requested");
    assert.equal(unassigned.assigned_staff_id, "");
    console.log("D. Unassigned handoff (no eligible staff) remains visible, honestly, in the existing queue route — PASS");
  } finally {
    await close(server);
  }

  console.log("office communications convergence slice 4 smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
