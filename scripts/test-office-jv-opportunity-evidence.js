// Production Communications Fix -- structured JV evidence ownership.
// PERSON/RELATIONSHIP != INDIVIDUAL OPPORTUNITY: a returning Lead's
// repeat Development/JV submission must produce a fresh, independent
// Opportunity whose OWN evidence (office-intake.js's
// buildOpportunityDevelopmentEvidence()) is what the material event
// reports -- never a blend with, or overwrite of, an earlier open
// Opportunity's own facts, even though the shared Lead row (name,
// contact info, business_unit, location, contactability) is correctly
// reused/patched across submissions. Historical Lead status must never
// be silently cleared by a new Opportunity arriving.
const assert = require("node:assert/strict");
const { createTempStore } = require("../src/lead-agents/testing");
const { normalizeOfficeIntakeEnvelope, findOrUpsertLead, runOfficeIntakeCrm } = require("../src/lead-agents/office-intake");
const { buildMaterialCrmEvent } = require("../src/lead-agents/backend-events");

function jvEnvelope({ requestId, location, message }) {
  return normalizeOfficeIntakeEnvelope({
    request_id: requestId,
    source_site: "ochiga_website",
    source_form: "land_jv",
    business_unit: "development",
    inquiry_type: "land_jv",
    contact: { name: "Returning Person", email: "returning-jv@example.com", phone: "+2348100000055" },
    organization: { name: "", location },
    payload: { message },
    consent: { marketing_followup: true },
  });
}

async function main() {
  const { store } = await createTempStore();

  // A. buildDevelopmentEvidence is module-private; buildMaterialCrmEvent
  // is the only public surface it's exercised through (below).
  assert.equal(require("../src/lead-agents/backend-events").buildDevelopmentEvidence, undefined);
  console.log("A. buildDevelopmentEvidence stays module-private, exercised only via buildMaterialCrmEvent — PASS");

  // B. Golden journey: same returning Lead, two Development/JV
  // submissions with materially different evidence (Epe first, then
  // Victoria Island) -- prove Opportunity 1's own evidence survives
  // Opportunity 2's later, unrelated submission untouched.
  const env1 = jvEnvelope({ requestId: "req-jv-epe", location: "Epe, Lagos", message: "5,000 sqm land in Epe, exploring a JV." });
  const { lead: leadAfterFirst, created } = await findOrUpsertLead(store, env1);
  assert.equal(created, true, "first submission creates the Lead");
  const crm1 = await runOfficeIntakeCrm(store, env1, leadAfterFirst, { actorEmail: env1.source_site });
  assert.ok(crm1.opportunity, "first submission creates a real Opportunity");
  assert.equal(crm1.opportunity.metadata.development.location, "Epe, Lagos", "Opportunity 1's own evidence captures its own submission's location");

  // Simulate this person's relationship having since been marked
  // disqualified (e.g. an earlier human review) -- this must never be
  // silently cleared by what follows.
  await store.updateLead(leadAfterFirst.id, { status: "disqualified", commercial_stage: "", qualification_status: "" });

  const env2 = jvEnvelope({ requestId: "req-jv-vi", location: "Victoria Island, Lagos", message: "3,000 sqm in Victoria Island, title documents available, JV process please." });
  const { lead: leadAfterSecond, created: created2 } = await findOrUpsertLead(store, env2);
  assert.equal(created2, false, "second submission folds into the SAME Lead (matched by email), not a new one");
  assert.equal(leadAfterSecond.id, leadAfterFirst.id);
  assert.equal(leadAfterSecond.status, "disqualified", "a new Opportunity arriving must never silently clear the Lead's historical status");

  const crm2 = await runOfficeIntakeCrm(store, env2, leadAfterSecond, { actorEmail: env2.source_site });
  assert.ok(crm2.opportunity, "second submission creates its OWN, separate Opportunity");
  assert.notEqual(crm2.opportunity.id, crm1.opportunity.id, "two submissions from the same person produce two distinct Opportunities, not one shared/overwritten record");
  assert.equal(crm2.opportunity.metadata.development.location, "Victoria Island, Lagos", "Opportunity 2's own evidence is its own submission's location");

  // The Lead's own (shared, person-level) location field is legitimately
  // allowed to move on to the latest submission's value -- that is the
  // "compatibility projection" the ownership rule explicitly permits.
  const leadRow = await store.getLead(leadAfterSecond.id);
  assert.equal(leadRow.location, "Victoria Island, Lagos", "the shared Lead row's own location field reflects the latest submission (compatibility projection, not opportunity truth)");

  // The material event built for submission 2, passed its OWN
  // Opportunity, must report submission 2's evidence.
  const event2 = buildMaterialCrmEvent({ lead: leadRow, envelope: env2, timelineEvent: { id: "tl-2" }, requestId: "req-jv-vi", opportunity: crm2.opportunity });
  assert.equal(event2.event_type, "development_enquiry_received");
  assert.equal(event2.crm.opportunity_id, crm2.opportunity.id, "the event names the specific Opportunity its evidence belongs to");
  assert.equal(event2.crm.status, "disqualified", "the Lead's historical relationship status still travels informationally -- untouched, never used to gate assessment");
  assert.equal(event2.metadata.development.location, "Victoria Island, Lagos", "the emitted event reports submission 2's OWN opportunity evidence");

  // Critical isolation proof: re-deriving the event for Opportunity 1
  // (as Backend would if it ever needed to re-assess the EARLIER,
  // still-open Epe opportunity) must still report Epe -- proving
  // Opportunity 2's later submission never contaminated Opportunity 1's
  // own stored evidence, even though the shared Lead row's location
  // field has since moved on.
  const event1Replayed = buildMaterialCrmEvent({ lead: leadRow, envelope: env1, timelineEvent: { id: "tl-1" }, requestId: "req-jv-epe", opportunity: crm1.opportunity });
  assert.equal(event1Replayed.metadata.development.location, "Epe, Lagos", "Opportunity 1's own evidence is untouched by Opportunity 2's later, unrelated submission -- no cross-opportunity contamination");

  // Compatibility fallback: a caller with NO opportunity (older code
  // paths, or a lead-only flow) still gets the Lead's own fields, same
  // as before this fix -- zero regression for existing callers.
  const eventNoOpportunity = buildMaterialCrmEvent({ lead: leadRow, envelope: env2, timelineEvent: { id: "tl-3" }, requestId: "req-jv-vi" });
  assert.equal(eventNoOpportunity.metadata.development.location, "Victoria Island, Lagos", "with no opportunity passed, the Lead's own (compatibility) fields are still used, unchanged from prior behaviour");
  assert.equal(eventNoOpportunity.crm.opportunity_id, null, "no opportunity passed -> honestly null, never fabricated");

  console.log("B. Returning Lead, two Opportunities, isolated evidence, historical status preserved — PASS");

  console.log("office jv opportunity evidence isolation smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
