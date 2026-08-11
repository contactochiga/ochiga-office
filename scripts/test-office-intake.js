const assert = require("assert");
const { createTempStore } = require("../src/lead-agents/testing");
const {
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

  console.log("office intake contract smoke passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
