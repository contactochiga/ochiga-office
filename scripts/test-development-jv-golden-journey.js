// Office Intelligence Convergence, Wave 3B -- golden journey for the
// live Development/JV conversation path this wave connected end to end:
//   Office evidence builder (office.js) -> Oyi Core (Backend, tested via
//   the real compiled corporateOfficeInternalPolicy.js) -> JV capability
//   -> structured known/missing/inferred response + governed handoff.
//
// office.js has no module boundary (browser-only script, no
// module.exports) -- following the SAME established pattern
// scripts/test-oyi-interaction-repositioning.js already uses for this
// exact file (source-text assertions), PLUS a real functional
// extraction-and-execution of the specific evidence-building functions
// this wave added, so the evidence SHAPE is proven correct, not just
// present in the source.
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const officeSource = fs.readFileSync(path.join(root, "public/office/office.js"), "utf8");

// --- Structural proof the bridge is wired (established repo convention) ---
assert.ok(officeSource.includes("function isDevelopmentLead(lead)"), "isDevelopmentLead() must exist");
assert.ok(officeSource.includes("function developmentOyiContext(lead, id)"), "developmentOyiContext() must exist");
assert.ok(officeSource.includes("function leadOyiContext(lead, id)"), "leadOyiContext() must exist");
assert.ok(officeSource.includes("oyiContext: leadOyiContext(record, id)"), "the Lead detail page must attach leadOyiContext()");
assert.ok(
  /selected\.type === "lead" \|\| selected\.type === "opportunity"[\s\S]{0,300}development_context/.test(officeSource),
  "currentSelectedObjectContext() must forward development_context for a lead/opportunity selection"
);
// Never hardcodes Ochiga's strategy into Office -- only structured
// evidence fields, no target-area/structure-preference literals.
assert.ok(!/Ikoyi|Katampe|Asokoro|Guzape/.test(officeSource), "Office must never hardcode Ochiga's development strategy -- that lives only in Backend's developmentJv.ts");

// --- Real functional extraction: execute the actual evidence-building
// functions (not just check they exist), proving the evidence SHAPE
// Backend's developmentJv.ts capability will receive.
function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`function not found: ${signature}`);
  let depth = 0;
  let i = source.indexOf("{", start);
  const bodyStart = i;
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

const sandboxSource = [
  extractFunction(officeSource, "function titleCase(value)"),
  extractFunction(officeSource, "function isDevelopmentLead(lead)"),
  extractFunction(officeSource, "function developmentOyiSafeSummary(lead)"),
  extractFunction(officeSource, "function developmentOyiContext(lead, id)"),
  extractFunction(officeSource, "function leadOyiContext(lead, id)"),
].join("\n\n");

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${sandboxSource}\nthis.isDevelopmentLead = isDevelopmentLead;\nthis.leadOyiContext = leadOyiContext;\nthis.developmentOyiContext = developmentOyiContext;`, sandbox);

// A non-development lead (e.g. a technology enquiry) must keep the
// existing thin shape -- no development_context ever attached when
// there's no real evidence for it.
const techLead = { business_unit: "technology", project_type: "oyi_deployment_request", summary: "Wants a demo." };
assert.equal(sandbox.isDevelopmentLead(techLead), false);
const techContext = sandbox.leadOyiContext(techLead, "lead-tech-1");
assert.equal(techContext.lead_ref, "lead-tech-1");
assert.ok(!("development_context" in techContext), "a non-development lead must never carry development_context");

// A real JV/development lead -- the exact evidence a staff member
// opening this lead's detail page would send to Oyi Core.
const jvLead = {
  business_unit: "development",
  project_type: "land_jv",
  location: "Ikoyi",
  city: "Lagos",
  property_size: "2.5 acres",
  budget_range: "70/30 proposed, negotiable",
  timeline: "6 months",
  unit_count: 0,
  number_of_units: 0,
  source_channel: "website_chat",
  decision_maker_status: "confirmed_owner",
  summary: "Landowner enquiry for a JV.",
};
assert.equal(sandbox.isDevelopmentLead(jvLead), true);
const jvContext = sandbox.leadOyiContext(jvLead, "lead-jv-1");
assert.ok(jvContext.crm_context, "a development lead must still carry the existing crm_context");
assert.equal(jvContext.crm_context.lead_ref, "lead-jv-1");
assert.ok(jvContext.development_context, "a development lead must carry development_context");
assert.equal(jvContext.development_context.opportunity_ref, "lead-jv-1");
assert.equal(jvContext.development_context.opportunity_type, "land_jv");
assert.equal(jvContext.development_context.location, "Ikoyi");
assert.equal(jvContext.development_context.land_size, "2.5 acres");
assert.equal(jvContext.development_context.commercial_terms, "70/30 proposed, negotiable");
// Fields Office has no schema for yet are honestly absent, never guessed.
assert.equal("structure_offered" in jvContext.development_context, false);
assert.equal("landowner_expectation" in jvContext.development_context, false);
assert.equal("title_document_status" in jvContext.development_context, false);

console.log("office development/JV context golden journey (evidence-building half): PASS");

// --- Backend half: the SAME evidence, run through the real, compiled
// reasoning + response-composition code. Requires a prior `npm run
// build` in Ochiga-backend (not this repo) -- skipped gracefully with a
// clear message if the sibling repo/build isn't available, since this
// script's primary job (this repo's own regression) must not fail on an
// external dependency.
async function runBackendHalf() {
  const backendRoot = path.resolve(root, "..", "Documents", "Ochiga-backend");
  const distPolicy = path.join(backendRoot, "dist/oyi-core/policy/corporateOfficeInternalPolicy.js");
  if (!fs.existsSync(distPolicy)) {
    console.log("office development/JV context golden journey (Backend half): SKIPPED (sibling Ochiga-backend build not found at " + distPolicy + ")");
    return;
  }
  const { buildOfficeInternalResponse } = require(distPolicy);

  const officeInternalRequest = {
    request_id: "req-golden-1",
    message: "What do you make of this JV opportunity?",
    office_session_id: "office-session-golden-1",
    conversation_thread_id: "thread-golden-1",
    staff: { staff_id: "staff-1", email: "staff@example.com", role: "ochiga_staff", permissions: ["office.read", "office.intelligence", "crm.read"] },
    page_context: { page: "/office/crm", selected_type: "lead", selected_id: "lead-jv-1" },
    business_unit: "development",
    capability_context: ["crm"],
    crm_context: jvContext.crm_context,
    portfolio_context: null,
    support_context: null,
    project_context: null,
    task_context: null,
    task_batch_context: null,
    execution_failed: false,
    execution_failure_reason: null,
    automation_context: null,
    meeting_context: null,
    partnership_context: null,
    document_context: null,
    content_context: null,
    development_context: jvContext.development_context,
    requested_capability: null,
    knowledge_context: [],
    metadata: {},
  };
  // Simulates a degraded/unresolved canonical turn -- exactly the real
  // case today, since no capability module is registered for
  // development/JV yet (by design, per this wave's scope: the policy
  // layer carries this, not a new capability module).
  const degradedCanonical = { message: "I can help with CRM, Tasks. Ask me about any of these directly and I'll pull the current data.", thread_id: "thread-golden-1", confirmations: [], cards: [] };

  const response = buildOfficeInternalResponse(officeInternalRequest, degradedCanonical, null);

  assert.equal(response.ok, true);
  assert.ok(response.answer && response.answer.length > 20, "the conversational answer must be real, substantive text, not empty");
  assert.ok(/ikoyi/i.test(response.answer), "the answer must reflect the REAL supplied location, not a generic reply");
  assert.ok(!/^I can help with|^I don't have an enabled capability/i.test(response.answer), "the JV rescue must replace the generic degraded-answer text");

  const assessment = response.safe_metadata.jv_assessment;
  assert.ok(assessment, "safe_metadata.jv_assessment must be present for a development lead");
  // Known / missing / inferred separation survives the full round trip.
  assert.equal(assessment.known_facts.location, "Ikoyi");
  assert.equal(assessment.known_facts.opportunity_type, "land_jv");
  assert.ok(assessment.missing_information.includes("jv_structure_offered"));
  assert.ok(assessment.missing_information.includes("title_document_status"));
  // Strategy was supplied as configuration/evidence, not hardcoded --
  // the alignment decision references the real target-area comparison.
  assert.equal(assessment.strategic_alignment.status, "aligned");
  assert.equal(assessment.strategic_alignment.matchedArea.area, "Ikoyi");
  assert.ok(assessment.strategy_reference.target_area_count > 0);
  // No fabricated property/title/economic facts anywhere in the answer
  // or the structured assessment.
  const serialized = `${response.answer} ${JSON.stringify(assessment)}`.toLowerCase();
  for (const forbidden of ["feasibility_score", "estimated_value", "valuation", "land_value_ngn", "credit_score"]) {
    assert.ok(!serialized.includes(forbidden), `must never fabricate "${forbidden}"`);
  }
  // Handoff stays governed: only proposed via the existing whitelisted
  // tool, only when the assessment actually recommends human review.
  const jvProposals = response.tool_proposals.filter((p) => (p.proposal_id || "").startsWith("office_jv_handoff_"));
  if (assessment.recommended_next_step === "route_for_human_review") {
    assert.equal(jvProposals.length, 1);
    assert.equal(jvProposals[0].tool, "office.request_handoff");
    assert.equal(jvProposals[0].governance, "office_validates_before_execution");
  } else {
    assert.equal(jvProposals.length, 0, "no handoff proposal unless the assessment actually recommends one");
  }
  // No CRM mutation of any kind is present anywhere in this response --
  // Core only ever proposes; it never executes.
  assert.ok(!response.tool_proposals.some((p) => p.tool === "crm.create_or_update_lead" || p.tool === "crm.qualify_opportunity" || p.tool === "crm.create_opportunity"), "the JV path must never itself propose a CRM write");

  // Unavailable/failed Core execution reporting must not corrupt this
  // response either -- simulate Office reporting a client-side
  // execution failure from a PRIOR turn and confirm the response is
  // still well-formed.
  const afterFailure = buildOfficeInternalResponse({ ...officeInternalRequest, execution_failed: true, execution_failure_reason: "network_error" }, degradedCanonical, null);
  assert.equal(afterFailure.ok, true);
  assert.ok(afterFailure.safe_metadata.jv_assessment, "a reported execution failure on a prior turn must not corrupt this turn's JV assessment");

  console.log("office development/JV context golden journey (Backend half): PASS");
}

runBackendHalf().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
