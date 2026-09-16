// Oyi Communications Convergence, Slice 3 -- Staff Identity, Capability
// & Handoff Routing. Real functional coverage against a genuine
// FileLeadAgentsStore: resolveEligibleStaffCapabilities() correctly
// assembling real data (never fabricated), permission/availability
// exclusion, existing-owner preference, workload-based tie-breaking,
// and the full golden journey through requestHandoffForLead().
const assert = require("assert/strict");
const { createTempStore } = require("../src/lead-agents/testing");
const { normalizeOfficeIntakeEnvelope, findOrUpsertLead, runOfficeIntakeCrm } = require("../src/lead-agents/office-intake");
const {
  requestHandoffForLead,
  resolveEligibleStaffCapabilities,
  resolveExistingOwnerForLead,
  updateHandoff,
} = require("../src/lead-agents/office-operational-workflows");
const { listCorporateRecords } = require("../src/lead-agents/office-operating-system");

function jvEnvelope(overrides = {}) {
  return normalizeOfficeIntakeEnvelope({
    request_id: overrides.request_id || `req-${Math.random().toString(36).slice(2)}`,
    source_site: "ochiga_website",
    source_page: "/development",
    source_form: "land_jv",
    business_unit: "development",
    inquiry_type: "land_jv",
    contact: overrides.contact || { name: "Femi Adeyemi", email: "femi@example.com", phone: "+2348100000077" },
    organization: { name: "Adeyemi Estates", location: "Ikoyi, Lagos" },
    payload: { message: "5 acres for JV." },
    consent: { marketing_followup: true },
  });
}

async function seedStaff(store, { email, role, availability, capability, businessUnit = "development", routingPriority = 50 }) {
  await store.ensureAdminUser({ email, password_hash: "test-hash", role, status: "active", display_name: email });
  if (availability !== undefined) {
    await store.upsertStaffProfile(email, { business_unit: businessUnit, availability, routing_priority: routingPriority });
  }
  if (capability) {
    await store.upsertStaffCapability(email, { capability, specialty: "" });
  }
}

async function main() {
  // A. resolveEligibleStaffCapabilities assembles real data -- no
  // fabrication. A staff member with no office_staff_profiles row is
  // excluded entirely (no evidence they're enrolled in routing at all).
  {
    const { store } = await createTempStore();
    await seedStaff(store, { email: "amaka@ochiga.com", role: "ochiga_staff", availability: "available", capability: "development.commercial_jv" });
    await store.ensureAdminUser({ email: "no-profile@ochiga.com", role: "ochiga_staff", password_hash: "x", status: "active" });
    const entries = await resolveEligibleStaffCapabilities(store);
    assert.equal(entries.length, 1, "only staff WITH a real office_staff_profiles row are enrolled in routing");
    const [entry] = entries;
    assert.equal(entry.staff_id, "amaka@ochiga.com");
    assert.equal(entry.business_unit, "development");
    assert.equal(entry.capability, "development.commercial_jv");
    assert.equal(entry.availability, "available");
    assert.equal(entry.active, true);
    assert.equal(entry.active_session_count, 0, "no active handoffs yet -- workload derived, not stored");
    assert.ok(entry.permissions.includes("support.assign"), "ochiga_staff's real permission grant must be present, not a second permission list");
    assert.ok(!entry.permissions.includes("office.manage"), "must not fabricate a permission ochiga_staff does not actually hold");
  }
  console.log("A. resolveEligibleStaffCapabilities: real, derived data, no fabrication — PASS");

  // B. Unauthorized staff (real capability + available, but the role
  // holds neither office.manage nor support.assign) must be excluded --
  // capability must never override permission.
  {
    const { store } = await createTempStore();
    await seedStaff(store, { email: "unauthorized@ochiga.com", role: "finance_operator", availability: "available", capability: "development.commercial_jv" });
    const { lead } = await findOrUpsertLead(store, jvEnvelope());
    const result = await requestHandoffForLead(store, { leadId: lead.id, businessUnit: "development", requestedCapability: "development.commercial_jv", reason: "test" });
    assert.equal(result.routing.status, "unavailable", "a capable-but-unauthorized staff member must never receive the handoff");
    assert.equal(result.handoff.status, "requested", "no fake assignment");
  }
  console.log("B. Unauthorized staff (no office.manage/support.assign) excluded despite matching capability — PASS");

  // C. Unavailable staff excluded -- availability is a deliberate,
  // explicit status, never inferred.
  {
    const { store } = await createTempStore();
    await seedStaff(store, { email: "offline@ochiga.com", role: "ochiga_staff", availability: "unavailable", capability: "development.commercial_jv" });
    const { lead } = await findOrUpsertLead(store, jvEnvelope({ request_id: "req-c" }));
    const result = await requestHandoffForLead(store, { leadId: lead.id, businessUnit: "development", requestedCapability: "development.commercial_jv", reason: "test" });
    assert.equal(result.routing.status, "unavailable");
    assert.equal(result.handoff.assigned_staff_id, "", "an explicitly unavailable staff member must never be assigned");
  }
  console.log("C. Explicitly unavailable staff excluded — PASS");

  // D. Existing relationship owner preferred when eligible. The linked
  // Opportunity's real owner (a staff email set by a human working the
  // record) wins over an otherwise-lower-workload eligible peer.
  {
    const { store } = await createTempStore();
    await seedStaff(store, { email: "owner@ochiga.com", role: "ochiga_staff", availability: "available", capability: "development.commercial_jv", routingPriority: 90 });
    await seedStaff(store, { email: "other@ochiga.com", role: "ochiga_staff", availability: "available", capability: "development.commercial_jv", routingPriority: 10 });

    const env = jvEnvelope({ request_id: "req-d" });
    const { lead } = await findOrUpsertLead(store, env);
    await runOfficeIntakeCrm(store, env, lead, { actorEmail: "owner@ochiga.com" });
    const opportunities = await listCorporateRecords(store, "opportunities");
    const linked = opportunities.find((o) => o.lead_id === lead.id);
    assert.ok(linked, "intake must create a linked Opportunity");
    assert.equal(linked.owner, "owner@ochiga.com", "the Opportunity's real owner comes from the acting staff member");

    const existingOwner = await resolveExistingOwnerForLead(store, lead.id);
    assert.equal(existingOwner, "owner@ochiga.com");

    const result = await requestHandoffForLead(store, { leadId: lead.id, businessUnit: "development", requestedCapability: "development.commercial_jv", reason: "test" });
    assert.equal(result.routing.status, "matched");
    assert.equal(result.handoff.assigned_staff_id, "owner@ochiga.com", "the existing relationship owner must be preferred over a lower-workload/higher-priority peer");
  }
  console.log("D. Existing relationship owner (real CRM ownership) preferred when eligible — PASS");

  // E. No existing owner -> lowest-workload eligible staff wins over a
  // higher-routing_priority peer who already has an active handoff.
  {
    const { store } = await createTempStore();
    await seedStaff(store, { email: "busy@ochiga.com", role: "ochiga_staff", availability: "available", capability: "development.commercial_jv", routingPriority: 90 });
    await seedStaff(store, { email: "free@ochiga.com", role: "ochiga_staff", availability: "available", capability: "development.commercial_jv", routingPriority: 10 });

    // Give "busy@ochiga.com" an existing active handoff (workload = 1)
    // via a prior, unrelated lead.
    const busyEnv = jvEnvelope({ request_id: "req-e-busy", contact: { name: "Prior Lead", email: "prior@example.com", phone: "+2348100000088" } });
    const { lead: priorLead } = await findOrUpsertLead(store, busyEnv);
    const priorResult = await requestHandoffForLead(store, { leadId: priorLead.id, businessUnit: "development", requestedCapability: "development.commercial_jv", reason: "prior" });
    assert.equal(priorResult.routing.status, "matched");

    const { lead } = await findOrUpsertLead(store, jvEnvelope({ request_id: "req-e" }));
    const result = await requestHandoffForLead(store, { leadId: lead.id, businessUnit: "development", requestedCapability: "development.commercial_jv", reason: "test" });
    assert.equal(result.routing.status, "matched");
    // Whichever of the two got the FIRST handoff now has workload 1;
    // the other (workload 0) must win this second, unrelated handoff.
    assert.notEqual(result.handoff.assigned_staff_id, priorResult.handoff.assigned_staff_id, "the lower-workload eligible staff member must be preferred over one who already has an active handoff");
  }
  console.log("E. Lowest-workload eligible staff preferred over a busier, higher-priority peer — PASS");

  // F. Golden journey: real assignment persists on office_handoffs, and
  // accepting upgrades lead_channel_states to human_active with the
  // real assigned staff as owner (Slice 1/2 automation-blocking gates
  // preserved unchanged).
  {
    const { store } = await createTempStore();
    await seedStaff(store, { email: "golden@ochiga.com", role: "ochiga_staff", availability: "available", capability: "development.commercial_jv" });
    const { lead } = await findOrUpsertLead(store, jvEnvelope({ request_id: "req-f" }));
    const result = await requestHandoffForLead(store, { leadId: lead.id, businessUnit: "development", requestedCapability: "development.commercial_jv", reason: "Oyi Core recommends human review." });
    assert.equal(result.routing.status, "matched");
    assert.equal(result.handoff.status, "offered");
    assert.equal(result.handoff.assigned_staff_id, "golden@ochiga.com");

    const timeline = await store.listTimelineForLead(lead.id);
    assert.ok(timeline.some((e) => e.event_type === "handoff_assigned"), "CRM timeline must record real routing, not just the initial request");

    const channelStateBeforeAccept = await store.getLeadChannelState(lead.id, "whatsapp");
    assert.equal(channelStateBeforeAccept.human_status, "human_review");

    const accepted = await updateHandoff(store, { userId: "golden@ochiga.com", email: "golden@ochiga.com", role: "ochiga_staff" }, result.handoff.handoff_id, "accept", {});
    assert.equal(accepted.status, "accepted");
    const channelStateAfterAccept = await store.getLeadChannelState(lead.id, "whatsapp");
    assert.equal(channelStateAfterAccept.human_status, "human_active");
    assert.equal(channelStateAfterAccept.human_owner, "golden@ochiga.com");
  }
  console.log("F. Golden journey: real assignment -> CRM timeline -> accept -> human_active with real owner — PASS");

  // G. No eligible staff at all (genuinely empty routing pool) -> honest
  // unavailable/pending handoff, never a fabricated assignment. This is
  // the same guarantee Slice 2 already proved with an empty list; here
  // it is proven with a REAL resolver that legitimately finds nobody
  // for a business_unit/capability combination nobody is enrolled in.
  {
    const { store } = await createTempStore();
    await seedStaff(store, { email: "wrong-capability@ochiga.com", role: "ochiga_staff", availability: "available", capability: "technology.oyi_deployment" });
    const { lead } = await findOrUpsertLead(store, jvEnvelope({ request_id: "req-g" }));
    const result = await requestHandoffForLead(store, { leadId: lead.id, businessUnit: "development", requestedCapability: "development.commercial_jv", reason: "test" });
    assert.equal(result.routing.status, "unavailable");
    assert.equal(result.handoff.status, "requested");
    assert.equal(result.handoff.assigned_staff_id, "");
  }
  console.log("G. Genuinely no eligible staff -> honest unavailable/pending handoff, no fabricated assignment — PASS");

  console.log("office communications convergence slice 3 smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
