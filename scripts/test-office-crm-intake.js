const assert = require("assert");
const { createTempStore } = require("../src/lead-agents/testing");
const {
  findOrUpsertLead,
  normalizeOfficeIntakeEnvelope,
  runOfficeIntakeCrm,
} = require("../src/lead-agents/office-intake");
const { listCorporateRecords } = require("../src/lead-agents/office-operating-system");

function envelope(overrides = {}) {
  return normalizeOfficeIntakeEnvelope({
    request_id: overrides.request_id || `req-${Math.random().toString(36).slice(2)}`,
    source_site: "ochiga_website",
    source_page: overrides.source_page || "/development",
    source_form: overrides.source_form || "land_jv",
    business_unit: overrides.business_unit || "development",
    inquiry_type: overrides.inquiry_type || "land_jv",
    contact: overrides.contact || { name: "Ada Okafor", email: "ada@example.com", phone: "+2348012345678" },
    organization: overrides.organization || { name: "Greenview Estates", location: "Lagos" },
    payload: overrides.payload || { message: "We have 3 acres in Lekki for a JV." },
  });
}

async function main() {
  // A. Development enquiry: Contact, Organization, Opportunity, Activity —
  // no Private/Partnership relationship for this business unit.
  {
    const { store } = await createTempStore();
    const env = envelope();
    const { lead, created } = await findOrUpsertLead(store, env);
    assert.equal(created, true, "first submission should create a new lead");
    assert.equal(lead.business_unit, "development");

    const crm = await runOfficeIntakeCrm(store, env, lead, { actorEmail: "test" });
    assert.ok(crm.contact?.id, "contact should be created");
    assert.equal(crm.contact.email, "ada@example.com");
    assert.ok(crm.organization?.id, "organization should be created when company info is present");
    assert.equal(crm.organization.name, "Greenview Estates");
    assert.ok(crm.opportunity?.id, "development is a commercial business unit — opportunity expected");
    assert.equal(crm.opportunity.business_unit, "development");
    assert.equal(crm.opportunity.inquiry_type, "land_jv");
    assert.equal(crm.relationship, null, "development has no private/partnership relationship");
    assert.ok(crm.activity?.id, "activity should be recorded");
    assert.equal(crm.activity.related_type, "opportunity");
    console.log("A. development enquiry: contact/org/opportunity/activity created — PASS");
  }

  // B. Generic contact form (corporate) must NOT fabricate an Opportunity.
  {
    const { store } = await createTempStore();
    const env = envelope({
      business_unit: "corporate",
      inquiry_type: "general_enquiry",
      source_form: "general_contact",
      contact: { name: "Femi", email: "femi@example.com" },
      organization: {},
      payload: { message: "Just saying hello." },
    });
    const { lead } = await findOrUpsertLead(store, env);
    const crm = await runOfficeIntakeCrm(store, env, lead, { actorEmail: "test" });
    assert.ok(crm.contact?.id, "contact should still be created for a generic enquiry");
    assert.equal(crm.organization, null, "no organization info was given — must not fabricate one");
    assert.equal(crm.opportunity, null, "generic contact-form enquiries must not become fake opportunities");
    assert.equal(crm.activity.related_type, "contact");
    console.log("B. generic contact form: no fabricated opportunity/organization — PASS");
  }

  // C. Technology/Oyi enquiry business_unit routing.
  {
    const { store } = await createTempStore();
    const env = envelope({
      business_unit: "technology",
      inquiry_type: "oyi_deployment_request",
      source_form: "oyi_deployment",
      contact: { name: "Chidi", email: "chidi@example.com", phone: "+2348011111111" },
    });
    const { lead } = await findOrUpsertLead(store, env);
    assert.equal(lead.business_unit, "technology");
    const crm = await runOfficeIntakeCrm(store, env, lead, { actorEmail: "test" });
    assert.equal(crm.opportunity.business_unit, "technology");
    assert.equal(crm.opportunity.inquiry_type, "oyi_deployment_request");
    console.log("C. technology enquiry: business_unit=technology — PASS");
  }

  // D. Private membership request: Contact + office_private_relationships.
  {
    const { store } = await createTempStore();
    const env = envelope({
      business_unit: "private",
      inquiry_type: "membership_request",
      source_form: "private_membership",
      source_page: "/private",
      contact: { name: "Ngozi", email: "ngozi@example.com" },
      organization: {},
      payload: { message: "Interested in Ochiga Private membership." },
    });
    const { lead } = await findOrUpsertLead(store, env);
    const crm = await runOfficeIntakeCrm(store, env, lead, { actorEmail: "test" });
    assert.equal(crm.relationship_collection, "private");
    assert.ok(crm.relationship?.id, "private relationship should be created");
    assert.equal(crm.relationship.relationship_type, "membership");
    assert.equal(crm.relationship.review_status, "requested", "private relationships must enter the governed request/review pipeline, not start active");
    assert.equal(crm.relationship.contact_id, crm.contact.id);
    console.log("D. private request: Contact + private relationship (requested) — PASS");
  }

  // E. Partnership request: Contact/Organization + office_partnership_relationships,
  // relationship_type derived from inquiry_type.
  {
    const { store } = await createTempStore();
    const env = envelope({
      business_unit: "partnerships",
      inquiry_type: "capital_partner",
      source_form: "strategic_partner",
      source_page: "/partnerships",
      contact: { name: "Tunde", email: "tunde@example.com" },
      organization: { name: "Tunde Capital Partners" },
      payload: { message: "We invest in real estate developments." },
    });
    const { lead } = await findOrUpsertLead(store, env);
    const crm = await runOfficeIntakeCrm(store, env, lead, { actorEmail: "test" });
    assert.equal(crm.relationship_collection, "partnerships");
    assert.equal(crm.relationship.relationship_type, "capital_partner");
    assert.equal(crm.relationship.review_status, "new");
    assert.ok(crm.organization?.id);
    console.log("E. partnership request: Contact/Organization + partnership relationship — PASS");
  }

  // F. Repeat submission: same email must dedupe the Lead and the Contact,
  // not create duplicates, and must not blank out fields the second
  // submission simply didn't repeat.
  {
    const { store } = await createTempStore();
    const first = envelope({
      contact: { name: "Ada Okafor", email: "ada2@example.com", phone: "+2348022222222" },
      organization: { name: "Greenview Estates", location: "Lagos" },
    });
    const firstResult = await findOrUpsertLead(store, first);
    assert.equal(firstResult.created, true);
    const firstCrm = await runOfficeIntakeCrm(store, first, firstResult.lead, { actorEmail: "test" });

    const second = envelope({
      request_id: "req-different-request-id",
      contact: { name: "Ada Okafor", email: "ada2@example.com" }, // no phone this time
      organization: {}, // no org repeated this time
      payload: { message: "Following up on my earlier enquiry." },
    });
    const secondResult = await findOrUpsertLead(store, second);
    assert.equal(secondResult.created, false, "repeat submission by email must update the existing lead, not create a new one");
    assert.equal(secondResult.lead.id, firstResult.lead.id);
    assert.equal(secondResult.lead.phone, "+2348022222222", "omitting phone on the second submission must not blank out the first submission's phone");

    const secondCrm = await runOfficeIntakeCrm(store, second, secondResult.lead, { actorEmail: "test" });
    assert.equal(secondCrm.contact.id, firstCrm.contact.id, "same email must resolve to the same Contact, not a duplicate");
    assert.equal(secondCrm.contact.phone, "+2348022222222", "contact upsert must not blank out the phone the second submission omitted");
    assert.notEqual(secondCrm.activity.id, firstCrm.activity.id, "a repeat enquiry must still add a new activity/timeline entry");

    const contacts = await listCorporateRecords(store, "contacts");
    const matching = contacts.filter((c) => c.email === "ada2@example.com");
    assert.equal(matching.length, 1, "exactly one contact should exist for this email after two submissions");

    const leads = await store.listLeads();
    const matchingLeads = leads.filter((l) => l.email === "ada2@example.com");
    assert.equal(matchingLeads.length, 1, "exactly one lead should exist for this email after two submissions");

    console.log("F. repeat submission: lead/contact deduped, no overwrite of omitted fields, new activity retained — PASS");
  }

  console.log("office CRM intake smoke passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
