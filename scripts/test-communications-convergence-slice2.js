// Oyi Communications Convergence, Slice 2 -- Office-side coverage.
// Real functional test of: (A) structured contactability evidence
// derived from the website's own real consent checkbox instead of being
// silently dropped; (B) findOrUpsertLead never downgrading an existing
// lead's real "allowed" back to "unknown" on a repeat submission with no
// new consent evidence; (C) requestHandoffForLead()'s idempotency (same
// lead resolves to the same active handoff, never a duplicate row);
// (D) the human_review/human_active lead_channel_states transitions
// requestHandoffForLead()/updateHandoff("accept") produce, reusing
// Slice 1's already-proven takeover-blocking check with zero new gating
// code; (E) honest "no staff available" routing (never a fake
// assignment); (F) structural proof of the new Backend->Office bridge
// route's wiring (shared-key check before calling requestHandoffForLead,
// same established source-text-assertion convention as Slice 1's
// coverage for wiring that has no clean module boundary to import live).
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { createTempStore } = require("../src/lead-agents/testing");
const { buildMaterialCrmEvent } = require("../src/lead-agents/backend-events");
const { normalizeOfficeIntakeEnvelope, findOrUpsertLead } = require("../src/lead-agents/office-intake");
const { requestHandoffForLead, findActiveHandoffForLead, updateHandoff } = require("../src/lead-agents/office-operational-workflows");

const root = path.resolve(__dirname, "..");

function jvEnvelope(overrides = {}) {
  return normalizeOfficeIntakeEnvelope({
    request_id: overrides.request_id || `req-${Math.random().toString(36).slice(2)}`,
    source_site: "ochiga_website",
    source_page: "/development",
    source_form: "land_jv",
    business_unit: "development",
    inquiry_type: "land_jv",
    contact: overrides.contact || { name: "Chidi Okafor", email: "chidi@example.com", phone: "+2348100000055" },
    organization: { name: "Okafor Land Holdings", location: "Ikoyi, Lagos" },
    payload: { message: "3 acres for JV." },
    consent: overrides.consent !== undefined ? overrides.consent : { marketing_followup: true },
  });
}

async function main() {
  // A. New submission with real consent evidence -> allowed + channels
  // + a real consent_source/consent_recorded_at, never inferred from
  // mere field presence (no-consent case stays unknown, empty channels).
  {
    const { store } = await createTempStore();
    const { lead: allowedLead } = await findOrUpsertLead(store, jvEnvelope());
    assert.equal(allowedLead.contactability_status, "allowed");
    assert.deepEqual(allowedLead.contactability_channels.sort(), ["email", "phone", "whatsapp"]);
    assert.ok(allowedLead.consent_source.includes("land_jv"), "consent_source must reflect the real originating form");
    assert.ok(allowedLead.consent_recorded_at);

    const { store: store2 } = await createTempStore();
    const { lead: unknownLead } = await findOrUpsertLead(store2, jvEnvelope({ consent: {}, contact: { name: "No Consent", email: "noconsent@example.com", phone: "+2348100000066" } }));
    assert.equal(unknownLead.contactability_status, "unknown");
    assert.deepEqual(unknownLead.contactability_channels, []);
  }
  console.log("A. deriveContactability: real consent evidence -> allowed+channels, no evidence -> unknown — PASS");

  // B. A repeat submission with NO new consent evidence must never
  // downgrade an existing lead's real "allowed" back to "unknown".
  {
    const { store } = await createTempStore();
    const env = jvEnvelope();
    const { lead: first } = await findOrUpsertLead(store, env);
    assert.equal(first.contactability_status, "allowed");
    const { lead: second, created } = await findOrUpsertLead(store, jvEnvelope({ request_id: "req-repeat", consent: {}, contact: env.contact }));
    assert.equal(created, false, "same email must be deduped to the same lead");
    assert.equal(second.contactability_status, "allowed", "a repeat submission with no consent evidence must never overwrite existing real consent");
  }
  console.log("B. findOrUpsertLead never downgrades existing allowed contactability on a consent-less repeat — PASS");

  // C. buildMaterialCrmEvent reads the real, structured value instead of
  // always "unknown" (Slice 1's prior hardcoded behavior).
  {
    const { store } = await createTempStore();
    const { lead } = await findOrUpsertLead(store, jvEnvelope());
    const event = buildMaterialCrmEvent({ lead, envelope: { business_unit: "development" }, timelineEvent: {}, requestId: "req-1" });
    assert.equal(event.communication_context.contactability, "allowed");

    const bareEvent = buildMaterialCrmEvent({ lead: { id: "lead-x", contactability_status: "something_invalid" }, envelope: {}, timelineEvent: {}, requestId: "req-2" });
    assert.equal(bareEvent.communication_context.contactability, "unknown", "an invalid/unrecognized stored value must still fall back to unknown, never pass through raw");
  }
  console.log("C. buildMaterialCrmEvent reads real contactability, defends against any non-allowed/denied value — PASS");

  // D. requestHandoffForLead(): idempotency. Same lead resolves to the
  // SAME active handoff on a second call -- never a duplicate row.
  // Honest "no staff available" routing (Office has no real staff
  // capability/availability data source yet -- see office-operational-
  // workflows.js's requestHandoffForLead comment) -- never a fake match.
  {
    const { store } = await createTempStore();
    const { lead } = await findOrUpsertLead(store, jvEnvelope());
    const first = await requestHandoffForLead(store, {
      leadId: lead.id,
      businessUnit: "development",
      requestedCapability: "development.commercial_jv",
      reason: "Oyi Core recommends human review.",
    });
    assert.equal(first.created, true);
    assert.equal(first.handoff.status, "requested", "no staff available today -> stays requested, never fake-assigned");
    assert.equal(first.routing.status, "unavailable");

    const second = await requestHandoffForLead(store, {
      leadId: lead.id,
      businessUnit: "development",
      requestedCapability: "development.commercial_jv",
      reason: "Oyi Core recommends human review (repeated qualification).",
    });
    assert.equal(second.created, false, "a second HANDOFF decision for the same lead must resolve to the existing active handoff");
    assert.equal(second.handoff.handoff_id, first.handoff.handoff_id);

    const activeLookup = await findActiveHandoffForLead(store, lead.id);
    assert.equal(activeLookup.handoff_id, first.handoff.handoff_id);
  }
  console.log("D. requestHandoffForLead: idempotent (repeated qualification resolves to the same handoff), honest unavailable routing — PASS");

  // E. requestHandoffForLead() pauses automation via the EXISTING
  // human_status check (Slice 1's already-proven takeover gate) -- no
  // new flag. updateHandoff("accept") then upgrades to human_active
  // with a real owner, distinct from the pending "human_review" state.
  {
    const { store } = await createTempStore();
    const { lead } = await findOrUpsertLead(store, jvEnvelope());
    const result = await requestHandoffForLead(store, { leadId: lead.id, businessUnit: "development", requestedCapability: "development.commercial_jv", reason: "test" });
    const channelState = await store.getLeadChannelState(lead.id, "whatsapp");
    assert.equal(channelState.human_status, "human_review");
    // Reuses the exact check Slice 1 already wired at both the WhatsApp
    // send bridge and processWhatsAppEvent -- this is the load-bearing
    // proof that a HANDOFF request blocks automation with zero new code.
    assert.ok(["human_active", "human_review"].includes(channelState.human_status));

    const accepted = await updateHandoff(
      store,
      { userId: "staff-1", email: "staff@ochiga.com", role: "super_admin" },
      result.handoff.handoff_id,
      "accept",
      {}
    );
    assert.equal(accepted.status, "accepted");
    const afterAccept = await store.getLeadChannelState(lead.id, "whatsapp");
    assert.equal(afterAccept.human_status, "human_active");
    // Production fix -- human_owner (and office_handoffs.assigned_staff_id)
    // must be the canonical staff email, never authContext.userId's UUID
    // ("staff-1" here). Every other cross-cutting staff concern in this
    // system already keys on email (office_staff_profiles, CRM ownership,
    // audit_events.actor_email) -- accept() must match.
    assert.equal(afterAccept.human_owner, "staff@ochiga.com");
  }
  console.log("E. requestHandoffForLead sets human_review (reuses Slice 1's takeover gate); accept upgrades to human_active with a real owner — PASS");

  // F. Historical/declined handoffs are preserved, not resurrected --
  // a NEW handoff is created if the only prior one for this lead was
  // declined, and findActiveHandoffForLead correctly skips the declined
  // row rather than treating it as still active.
  {
    const { store } = await createTempStore();
    const { lead } = await findOrUpsertLead(store, jvEnvelope());
    const first = await requestHandoffForLead(store, { leadId: lead.id, businessUnit: "development", requestedCapability: "development.commercial_jv", reason: "first" });
    await updateHandoff(store, { userId: "staff-1", email: "staff@ochiga.com", role: "super_admin" }, first.handoff.handoff_id, "decline", { reason: "not a fit" });

    const afterDecline = await findActiveHandoffForLead(store, lead.id);
    assert.equal(afterDecline, null, "a declined handoff must not be treated as still active");

    const second = await requestHandoffForLead(store, { leadId: lead.id, businessUnit: "development", requestedCapability: "development.commercial_jv", reason: "second, after decline" });
    assert.equal(second.created, true, "a new handoff must be created once the prior one was declined, not silently reused");
    assert.notEqual(second.handoff.handoff_id, first.handoff.handoff_id);

    const rows = store.state.office_handoffs;
    assert.equal(rows.length, 2, "the declined handoff must be preserved as history, not overwritten");
  }
  console.log("F. declined handoffs are preserved as history; repeated HANDOFF after a decline creates a genuinely new handoff — PASS");

  // G. Structural: the new bridge route checks the shared secret before
  // calling requestHandoffForLead, and is listed in isBackendBridgePath
  // (same source-text-assertion convention as Slice 1's server.js
  // wiring proofs, since this route has no clean module boundary).
  const serverSource = fs.readFileSync(path.join(root, "src/lead-agents/server.js"), "utf8");
  assert.ok(serverSource.includes('pathname === "/api/lead-agents/admin/communications/handoff-request"'), "the new route must be registered as a backend bridge path");
  const handlerIdx = serverSource.indexOf('pathname === "/api/lead-agents/admin/communications/handoff-request") {');
  assert.ok(handlerIdx > 0, "the handoff-request handler must exist");
  const keyCheckIdx = serverSource.indexOf("secureCompare(providedKey, expectedKey)");
  assert.ok(keyCheckIdx > 0 && keyCheckIdx < handlerIdx, "the shared-secret check must run before the handoff-request handler, same trust boundary as every other bridge route");
  assert.ok(serverSource.includes("requestHandoffForLead(store,"), "the handler must call the real requestHandoffForLead orchestrator, not a bespoke duplicate");
  console.log("G. server.js handoff-request bridge route wiring (shared-secret gate, real orchestrator reuse) — PASS");

  console.log("office communications convergence slice 2 smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
