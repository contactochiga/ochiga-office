const assert = require("assert");
const { createTempStore } = require("../src/lead-agents/testing");
const {
  fileIntakeSubmission,
  findExistingIntakeLead,
  leadInputFromIntake,
  normalizeOfficeIntakeEnvelope,
} = require("../src/lead-agents/office-intake");

async function main() {
  const { store } = await createTempStore();
  const envelope = normalizeOfficeIntakeEnvelope({
    request_id: "req-website-1",
    idempotency_key: "idem-website-1",
    source_channel: "website",
    source_site: "ochiga.com.ng",
    source_page: "/technology",
    source_form: "oyi_deployment",
    business_unit: "technology",
    inquiry_type: "oyi_deployment",
    contact: { name: "Ada Okafor", email: "ada@example.com", phone: "+2348012345678", role: "Operations Manager" },
    organization: { name: "Greenview Estates", location: "Lagos", type: "estate" },
    payload: { requirement: "Smart estate deployment", expected_timeline: "Q3" },
    consent: { marketing: true },
  });
  assert.equal(envelope.business_unit, "technology");
  assert.equal(envelope.idempotency_key, "idem-website-1");

  const lead = await store.createLead(leadInputFromIntake(envelope));
  assert.equal(lead.owner, "sales_agent");
  assert.match(lead.notes, /idem-website-1/);

  const duplicate = await findExistingIntakeLead(store, "idem-website-1");
  assert.equal(duplicate.id, lead.id);

  const packageEnvelope = normalizeOfficeIntakeEnvelope({ ...envelope, metadata: {package:{slug:"synthetic-package",version:3,size:"SIZE-A",cost:999}} });
  // package context never changes the lead's interest_package (recommender, opportunity summary, proposal/deployment defaults)
  assert.equal(leadInputFromIntake(packageEnvelope).interest_package, undefined);
  assert.equal(leadInputFromIntake(envelope).interest_package, leadInputFromIntake(packageEnvelope).interest_package);
  const invalidPackage = normalizeOfficeIntakeEnvelope({ ...envelope, metadata: {package:{slug:"../private",version:3}} });
  assert.equal(leadInputFromIntake(invalidPackage).interest_package, undefined);
  // full filing path: the package reference is kept as catalogue_package evidence on the opportunity and the intake timeline, while the
  // lead's interest_package (recommender, opportunity summary, proposal/deployment defaults) is exactly what it would be without it
  const packageFiling = normalizeOfficeIntakeEnvelope({ ...envelope, idempotency_key: "idem-website-package", contact: { ...envelope.contact, email: "pkg@example.com" },
    metadata: { package: { slug: "synthetic-package", version: 3, size: "SIZE-A" } } });
  await fileIntakeSubmission(store, packageFiling, { actor: "website" });
  const state = store.state;
  const pkgLead = state.leads.find((l) => l.email === "pkg@example.com");
  const pkgOpp = state.crm_opportunities.find((o) => o.metadata && o.metadata.catalogue_package);
  const pkgEvent = state.timeline_events.find((e) => e.metadata && e.metadata.catalogue_package);
  assert.ok(pkgLead && !String(pkgLead.interest_package || "").includes("synthetic-package"), "lead interest_package untouched by package context");
  assert.deepEqual(pkgOpp && pkgOpp.metadata.catalogue_package, { slug: "synthetic-package", version: 3, size: "SIZE-A" });
  assert.deepEqual(pkgEvent && pkgEvent.metadata.catalogue_package, { slug: "synthetic-package", version: 3, size: "SIZE-A" });
  assert.ok(!String(pkgOpp.summary || pkgOpp.name || "").includes("synthetic-package@"), "opportunity summary does not carry the package reference");
  console.log("office intake contract smoke passed (including bounded package reference)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
