// Website catalogue package context vs leads.interest_package (production Office regression). interest_package is the commercial
// tier vocabulary (recommendPackage / proposal tier_name: "Oyi Core", "Oyi Operations", ...); a catalogue reference
// (slug@vN:SIZE) must never land there. It is kept only as catalogue_package evidence on the opportunity and the intake timeline.
// Temporary file store only; no network, no database.
"use strict";
const assert = require("assert");
const { createTempStore } = require("../src/lead-agents/testing");
const { fileIntakeSubmission, leadInputFromIntake, normalizeOfficeIntakeEnvelope } = require("../src/lead-agents/office-intake");
const { OYI_PACKAGES, buildDeploymentFromLead, qualifyLead, recommendPackage } = require("../src/lead-agents/commercial-ops");
const { buildProposal, selectPackage } = require("../src/lead-agents/commercial");

let checks = 0;
const ok = (cond, name) => { assert.ok(cond, name); checks += 1; console.log("PASS " + name); };
const REF = { slug: "oyi-smart-living", version: 3, size: "SL-APT" };
const envelopeFor = (n, metadata, over = {}) => normalizeOfficeIntakeEnvelope({
  request_id: `req-pkg-${n}`, idempotency_key: `idem-pkg-${n}`, source_channel: "website", source_site: "getoyi.com", source_page: "/solutions",
  source_form: "oyi_deployment", business_unit: "technology", inquiry_type: "oyi_deployment",
  contact: { name: `Synthetic ${n}`, email: `pkg-${n}@example.com`, phone: `+23480000000${String(n).padStart(2, "0")}`, role: "Facility Manager" },
  organization: { name: `Synthetic Estate ${n}`, location: "Lagos", type: "estate", unit_count: 40 },
  payload: { requirement: "Access control and cameras for the estate", expected_timeline: "Q1" }, consent: { marketing: true },
  ...(metadata === undefined ? {} : { metadata }), ...over,
});
const tierNames = new Set(OYI_PACKAGES.map((p) => (typeof p === "string" ? p : p.name)));

async function main() {
  const { store } = await createTempStore();

  // 1. mapping: valid, missing, null and invalid package context never set interest_package
  const cases = [
    ["valid", { package: REF }, REF],
    ["valid without size", { package: { slug: "oyi-smart-living", version: 3 } }, { slug: "oyi-smart-living", version: 3, size: "" }],
    ["invalid size dropped", { package: { ...REF, size: "../x" } }, { ...REF, size: "" }],
    ["no metadata", undefined, null],
    ["null package", { package: null }, null],
    ["slug not a string", { package: { slug: 7, version: 3 } }, null],
    ["unsafe slug", { package: { slug: "../private", version: 3 } }, null],
    ["version 0", { package: { slug: "oyi-smart-living", version: 0 } }, null],
    ["version as string", { package: { slug: "oyi-smart-living", version: "3" } }, null],
  ];
  const withoutContext = leadInputFromIntake(envelopeFor(0));
  for (const [label, metadata] of cases) {
    const input = leadInputFromIntake(envelopeFor(1, metadata));
    ok(input.interest_package === undefined && JSON.stringify(input) === JSON.stringify({ ...withoutContext, ...pick(input, withoutContext) }), `lead input ignores package context (${label}): no interest_package, otherwise identical`);
  }

  // 2. full filing path: lead / opportunity / timeline (and the stored lead record)
  for (const [i, [label, metadata, expected]] of cases.entries()) {
    const env = envelopeFor(10 + i, metadata);
    await fileIntakeSubmission(store, env, { actor: "website" });
    const s = store.state;
    const lead = s.leads.find((l) => l.email === `pkg-${10 + i}@example.com`);
    const opp = s.crm_opportunities.find((o) => o.lead_id === lead.id);
    const events = s.timeline_events.filter((e) => e.metadata && e.metadata.catalogue_package);
    const event = events.find((e) => JSON.stringify(e).includes(env.request_id) || (opp && JSON.stringify(e).includes(opp.id)));
    ok(lead && (lead.interest_package || "") === "", `stored lead interest_package is empty, as without context (${label})`);
    if (expected) {
      ok(opp && JSON.stringify(opp.metadata.catalogue_package) === JSON.stringify(expected), `opportunity keeps catalogue_package evidence (${label})`);
      ok(event && JSON.stringify(event.metadata.catalogue_package) === JSON.stringify(expected), `intake timeline keeps catalogue_package evidence (${label})`);
    } else {
      ok(!opp || !opp.metadata || !opp.metadata.catalogue_package, `no catalogue_package recorded for absent/invalid context (${label})`);
    }
  }

  // 3. downstream defaults: recommendation, opportunity summary, proposal tier/pricing and deployment package come from the commercial
  //    recommender, exactly as for the same enquiry without package context
  const filed = store.state.leads.find((l) => l.email === "pkg-10@example.com");
  const plain = { ...filed, interest_package: "" };
  const q = qualifyLead(filed);
  ok(q.recommended_package === recommendPackage(filed) && tierNames.has(q.recommended_package), `qualification recommends a commercial tier (${q.recommended_package})`);
  ok(!/@v\d|oyi-smart-living/.test(q.summary) && JSON.stringify(q) === JSON.stringify(qualifyLead(plain)), "opportunity summary carries no catalogue reference and equals the no-context result");
  const proposal = buildProposal({ unitCount: filed.unit_count, projectType: filed.project_type, leadName: filed.name, company: filed.company, packageName: filed.interest_package, painPoints: filed.pain_points, timeline: filed.timeline });
  const expectedTier = selectPackage({ project_type: filed.project_type, unit_count: filed.unit_count, pain_points: filed.pain_points });
  ok(JSON.stringify(proposal) === JSON.stringify(buildProposal({ unitCount: filed.unit_count, projectType: filed.project_type, leadName: filed.name, company: filed.company, packageName: "", painPoints: filed.pain_points, timeline: filed.timeline })), "proposal default (tier and pricing) equals the no-context proposal");
  const firstTier = proposal.metadata.pricing.packages[0];
  const oldTier = selectPackage({ packageName: "oyi-smart-living@v3:SL-APT", project_type: filed.project_type, unit_count: filed.unit_count, pain_points: filed.pain_points });
  ok(oldTier === firstTier && expectedTier.name === q.recommended_package && expectedTier !== firstTier,
    `old failure mode pinned: a catalogue reference as package name silently priced the proposal at the first tier (${firstTier.name}) instead of the recommended ${expectedTier.name}`);
  ok(buildDeploymentFromLead(filed).package_name === recommendPackage(filed), "deployment package_name default is the recommended tier, not a catalogue reference");

  // 4. backward compatibility: an existing lead's tier survives a later package enquiry (repeat-submission update path) and explicit
  //    proposal/deployment package names still win
  const existing = await store.createLead({ name: "Existing", email: "existing@example.com", phone: "+2348000009999", interest_package: "Oyi Operations", status: "qualified" });
  await fileIntakeSubmission(store, envelopeFor(99, { package: REF }, { contact: { name: "Existing", email: "existing@example.com", phone: "+2348000009999", role: "Owner" } }), { actor: "website" });
  const after = store.state.leads.find((l) => l.id === existing.id);
  ok(after.interest_package === "Oyi Operations", "an existing lead's interest_package is unchanged by a later package enquiry");
  ok(store.state.leads.filter((l) => l.email === "existing@example.com").length === 1, "repeat enquiry updates the existing lead (no duplicate)");
  ok(qualifyLead(after).recommended_package === "Oyi Operations", "an existing explicit tier still drives qualification");
  ok(buildDeploymentFromLead(after, { package_name: "Oyi Infrastructure" }).package_name === "Oyi Infrastructure" && buildDeploymentFromLead(after).package_name === "Oyi Operations", "explicit deployment package_name wins; otherwise the stored tier is used");
  ok(selectPackage({ packageName: "Oyi Command Center" }).name === "Oyi Command Center", "explicit proposal tier is still selected");

  console.log(JSON.stringify({ suite: "office-intake-package-mapping", checks, failed: 0 }));
}

// fields that legitimately differ between two envelopes (identity, request ids) are taken from the compared input
function pick(input, base) {
  const out = {};
  for (const k of ["name", "company", "email", "phone", "source", "summary", "notes"]) if (k in input || k in base) out[k] = input[k];
  return out;
}

main().catch((error) => { console.error(error); process.exit(1); });
