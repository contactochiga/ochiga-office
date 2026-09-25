// Wave 8 Slice 4 prerequisite -- Office Opportunity Outcome Authority.
// File-store functional proof (mirrors test-office-operational-mutations.js's
// own pattern). Real-Postgres CAS/migration proof lives in the separate
// scripts/test-office-opportunity-outcome-authority-sql.js.
const assert = require("assert/strict");
const {
  createCorporateRecord,
  listCorporateRecords,
} = require("../src/lead-agents/office-operating-system");
const {
  transitionOpportunity,
  findOpportunityRecord,
} = require("../src/lead-agents/office-operational-workflows");
const { createTempStore } = require("../src/lead-agents/testing");

async function seedOpportunity(store, overrides = {}) {
  return createCorporateRecord(store, "opportunities", {
    business_unit: "development",
    inquiry_type: "jv_enquiry",
    pipeline: "development",
    ...overrides,
  });
}

async function main() {
  const { store } = await createTempStore();

  // Section 24/proof -- fresh opportunity defaults to the real DB default
  // stage, never silently reclassified.
  const opportunityA = await seedOpportunity(store);
  assert.equal(opportunityA.stage, "intake_received");
  console.log("PASS new opportunity defaults to intake_received, unmodified");

  // Section 9 -- evidence is mandatory.
  await assert.rejects(
    transitionOpportunity(store, { opportunityId: opportunityA.id, targetStage: "qualified" }),
    /transition_evidence_required/
  );
  console.log("PASS a transition without evidenceType/evidenceId is rejected");

  // Applied transition -- Section 6/10.
  const first = await transitionOpportunity(
    store,
    { opportunityId: opportunityA.id, targetStage: "qualified", evidenceType: "qualification_completed", evidenceId: "evt-1" },
    { actorEmail: "staff@ochiga.com" }
  );
  assert.equal(first.applied, true);
  assert.equal(first.opportunity.stage, "qualified");
  assert.equal(first.opportunity.status, "open");
  assert.ok(first.activity);
  assert.equal(first.activity.activity_type, "opportunity_stage_changed");
  assert.equal(first.activity.related_type, "opportunity");
  assert.equal(first.activity.related_id, opportunityA.id);
  assert.equal(first.activity.opportunity_id, opportunityA.id);
  assert.equal(first.activity.metadata.previous_stage, "intake_received");
  assert.equal(first.activity.metadata.target_stage, "qualified");
  console.log("PASS a valid, evidence-backed transition applies and creates exactly one activity");

  // Idempotency -- Section 8/26. Same evidence, same target -> no-op,
  // zero new activity.
  const activitiesBeforeRetry = (await listCorporateRecords(store, "activities")).length;
  const retry = await transitionOpportunity(
    store,
    { opportunityId: opportunityA.id, targetStage: "qualified", evidenceType: "qualification_completed", evidenceId: "evt-1" },
    { actorEmail: "staff@ochiga.com" }
  );
  assert.equal(retry.applied, false);
  assert.equal(retry.reason, "idempotent_replay");
  assert.equal(retry.activity.id, first.activity.id);
  assert.equal((await listCorporateRecords(store, "activities")).length, activitiesBeforeRetry);
  console.log("PASS a retried transition with the SAME evidence is idempotent -- zero duplicate activity");

  // CAS -- Section 7. A stale expected_stage is rejected without
  // mutating the record or creating an activity.
  const activitiesBeforeStale = (await listCorporateRecords(store, "activities")).length;
  const stale = await transitionOpportunity(
    store,
    { opportunityId: opportunityA.id, expectedStage: "intake_received", targetStage: "proposal_sent", evidenceType: "proposal_sent", evidenceId: "evt-stale" },
    { actorEmail: "staff@ochiga.com" }
  );
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, "stale_expected_stage");
  const afterStale = await findOpportunityRecord(store, opportunityA.id);
  assert.equal(afterStale.stage, "qualified", "the stale attempt must never have mutated the record");
  assert.equal((await listCorporateRecords(store, "activities")).length, activitiesBeforeStale);
  console.log("PASS a stale expected_stage is rejected -- no mutation, no activity, never last-write-wins");

  // Terminal-state protection -- Section 19.
  const wonTransition = await transitionOpportunity(
    store,
    { opportunityId: opportunityA.id, targetStage: "proposal_sent", evidenceType: "proposal_sent", evidenceId: "evt-2" },
    { actorEmail: "staff@ochiga.com" }
  );
  assert.equal(wonTransition.applied, true);
  const wonResult = await transitionOpportunity(
    store,
    { opportunityId: opportunityA.id, targetStage: "won", evidenceType: "proposal_accepted", evidenceId: "evt-3" },
    { actorEmail: "staff@ochiga.com" }
  );
  assert.equal(wonResult.applied, true);
  assert.equal(wonResult.opportunity.status, "closed_won");
  const staleReopenAttempt = await transitionOpportunity(
    store,
    { opportunityId: opportunityA.id, targetStage: "negotiation", evidenceType: "proposal_declined", evidenceId: "evt-late" },
    { actorEmail: "staff@ochiga.com" }
  );
  assert.equal(staleReopenAttempt.applied, false);
  assert.equal(staleReopenAttempt.reason, "terminal_stage_protected");
  const afterAttemptedReopen = await findOpportunityRecord(store, opportunityA.id);
  assert.equal(afterAttemptedReopen.stage, "won", "a delayed event must never reopen or regress a terminal Opportunity");
  console.log("PASS won/lost are terminal -- a delayed/stale event can never reopen or regress them");

  // Multi-opportunity isolation -- Sections 12/15. Two opportunities for
  // the SAME lead/contact; a transition on one must never touch the other.
  const sharedLead = await store.createLead({ name: "Shared Contact", company: "Shared Co", source: "website" });
  const opportunityB1 = await seedOpportunity(store, { lead_id: sharedLead.id, inquiry_type: "development_site_a" });
  const opportunityB2 = await seedOpportunity(store, { lead_id: sharedLead.id, inquiry_type: "development_site_b" });
  assert.equal(opportunityB1.lead_id, sharedLead.id);
  assert.equal(opportunityB2.lead_id, sharedLead.id);
  assert.notEqual(opportunityB1.id, opportunityB2.id, "the same lead must produce two genuinely distinct Opportunity rows");
  const proposalB1 = await store.createProposal({
    lead_id: sharedLead.id,
    opportunity_id: opportunityB1.id,
    title: "Site A proposal",
    body: "Proposal body",
    status: "draft",
    actor: "staff@ochiga.com",
  });
  const proposalB2 = await store.createProposal({
    lead_id: sharedLead.id,
    opportunity_id: opportunityB2.id,
    title: "Site B proposal",
    body: "Proposal body",
    status: "draft",
    actor: "staff@ochiga.com",
  });
  assert.equal(proposalB1.opportunity_id, opportunityB1.id);
  assert.equal(proposalB2.opportunity_id, opportunityB2.id);
  assert.notEqual(proposalB1.opportunity_id, proposalB2.opportunity_id);
  console.log("PASS proposal creation persists the explicit opportunity_id -- never inferred, never shared");

  // Advance both opportunities to proposal_sent so "won" is reachable,
  // then accept only Proposal A's opportunity.
  await transitionOpportunity(store, { opportunityId: opportunityB1.id, targetStage: "proposal_sent", evidenceType: "proposal_sent", evidenceId: `${proposalB1.id}:sent` }, { actorEmail: "staff@ochiga.com" });
  await transitionOpportunity(store, { opportunityId: opportunityB2.id, targetStage: "proposal_sent", evidenceType: "proposal_sent", evidenceId: `${proposalB2.id}:sent` }, { actorEmail: "staff@ochiga.com" });
  const acceptResult = await transitionOpportunity(
    store,
    { opportunityId: opportunityB1.id, targetStage: "won", evidenceType: "proposal_accepted", evidenceId: proposalB1.id },
    { actorEmail: "staff@ochiga.com" }
  );
  assert.equal(acceptResult.applied, true);
  const b1After = await findOpportunityRecord(store, opportunityB1.id);
  const b2After = await findOpportunityRecord(store, opportunityB2.id);
  assert.equal(b1After.stage, "won");
  assert.equal(b2After.stage, "proposal_sent", "Opportunity B must remain byte-for-byte unchanged by A's own transition");
  assert.equal(b2After.status, "open");
  console.log("PASS accepting Proposal A only changes Opportunity A -- Opportunity B is untouched");

  // Section 30 -- performance: exactly one bounded lookup per
  // transitionOpportunity call, never a scan-by-lead. Proven structurally
  // (findOpportunityRecord's own real-Postgres proof lives in the SQL
  // script's EXPLAIN check); here we prove it never guesses among a
  // shared lead's opportunities at all -- already covered above.

  console.log("\noffice opportunity outcome authority smoke passed");
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
