const crypto = require("crypto");
const { normalizeEmail, normalizePhone, normalizeText } = require("./normalize-lead");
const { createCorporateRecord, listCorporateRecords, upsertContactIdentity } = require("./office-operating-system");

const BUSINESS_UNITS = new Set([
  "development",
  "technology",
  "private",
  "partnerships",
  "corporate",
]);

// Inquiry-type vocabulary shared with the Backend's corporate intelligence
// contract (src/contracts/corporateIntelligence.ts CorporateInquiryType in
// Ochiga-backend) so business_unit/inquiry_type mean the same thing
// everywhere a website enquiry can end up — Office CRM, Oyi Core, and the
// website's own lead payload.
const PARTNERSHIP_RELATIONSHIP_TYPES = {
  land_jv: "landowner_jv",
  landowner_jv: "landowner_jv",
  capital_partner: "capital_partner",
  buyer_offtake: "buyer_offtake",
  delivery_professional: "delivery_professional",
  integrator_interest: "technology_integrator",
  technology_partnership: "technology_integrator",
  strategic_partner: "strategic_partner",
};

function normalizeBusinessUnit(value) {
  const normalized = normalizeText(value).toLowerCase();
  return BUSINESS_UNITS.has(normalized) ? normalized : "corporate";
}

function canonicalRequestId(value) {
  const normalized = normalizeText(value);
  return normalized || crypto.randomUUID();
}

function canonicalIdempotencyKey(envelope) {
  const explicit = normalizeText(envelope.idempotency_key || envelope.idempotencyKey);
  if (explicit) return explicit;
  const contact = envelope.contact && typeof envelope.contact === "object" ? envelope.contact : {};
  const basis = [
    envelope.source_site || envelope.sourceSite || "",
    envelope.source_form || envelope.sourceForm || "",
    normalizeEmail(contact.email),
    normalizePhone(contact.phone),
    normalizeText(envelope.inquiry_type || envelope.inquiryType),
  ].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex");
}

function normalizeOfficeIntakeEnvelope(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const error = new Error("intake envelope must be an object");
    error.statusCode = 400;
    throw error;
  }
  const contact = input.contact && typeof input.contact === "object" ? input.contact : {};
  const organization = input.organization && typeof input.organization === "object" ? input.organization : {};
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const businessUnit = normalizeBusinessUnit(input.business_unit || input.businessUnit || payload.business_unit);
  const inquiryType = normalizeText(input.inquiry_type || input.inquiryType || payload.inquiry_type || payload.requirement || "general_enquiry");
  const requestId = canonicalRequestId(input.request_id || input.requestId);
  const idempotencyKey = canonicalIdempotencyKey({ ...input, request_id: requestId });

  const name = normalizeText(contact.name || input.name || payload.name);
  const email = normalizeEmail(contact.email || input.email || payload.email);
  const phone = normalizePhone(contact.phone || input.phone || payload.phone);

  if (!name && !email && !phone) {
    const error = new Error("contact name, email or phone is required");
    error.statusCode = 400;
    throw error;
  }

  return {
    request_id: requestId,
    idempotency_key: idempotencyKey,
    submitted_at: input.submitted_at || input.submittedAt || new Date().toISOString(),
    source_channel: normalizeText(input.source_channel || input.sourceChannel || "website"),
    source_site: normalizeText(input.source_site || input.sourceSite || "unknown_site"),
    source_page: normalizeText(input.source_page || input.sourcePage || ""),
    source_form: normalizeText(input.source_form || input.sourceForm || ""),
    business_unit: businessUnit,
    inquiry_type: inquiryType,
    contact: {
      name,
      email,
      phone,
      role: normalizeText(contact.role || payload.role || input.role),
      preferred_channel: normalizeText(contact.preferred_channel || contact.preferredChannel || payload.preferred_contact_method),
    },
    organization: {
      name: normalizeText(organization.name || organization.company || input.company || payload.organisation || payload.organization),
      type: normalizeText(organization.type || payload.role_type || payload.organization_type),
      location: normalizeText(organization.location || payload.location || input.location),
      unit_count: payload.number_of_units || payload.unit_count || payload.approx_size || null,
    },
    payload,
    metadata,
    consent: input.consent && typeof input.consent === "object" ? input.consent : {},
    campaign: input.campaign && typeof input.campaign === "object" ? input.campaign : {},
  };
}

function leadInputFromIntake(envelope) {
  const summary = [
    `Business unit: ${envelope.business_unit}`,
    `Inquiry type: ${envelope.inquiry_type}`,
    envelope.organization.name ? `Organization: ${envelope.organization.name}` : "",
    envelope.organization.location ? `Location: ${envelope.organization.location}` : "",
  ].filter(Boolean).join(" | ");
  return {
    name: envelope.contact.name,
    company: envelope.organization.name,
    role: envelope.contact.role,
    email: envelope.contact.email,
    phone: envelope.contact.phone,
    primary_channel: envelope.contact.preferred_channel || envelope.source_channel,
    source: `${envelope.source_site}:${envelope.source_form || envelope.source_channel}`,
    source_channel: envelope.source_channel,
    location: envelope.organization.location,
    unit_count: Number.isFinite(Number(envelope.organization.unit_count)) ? Number(envelope.organization.unit_count) : undefined,
    project_type: envelope.inquiry_type,
    property_type: envelope.organization.type,
    pain_points: normalizeText(envelope.payload.message || envelope.payload.notes || envelope.payload.requirement),
    timeline: normalizeText(envelope.payload.expected_timeline || envelope.payload.timeline),
    business_unit: envelope.business_unit,
    inquiry_type: envelope.inquiry_type,
    status: "new",
    owner: envelope.business_unit === "technology" ? "sales_agent" : "office_triage",
    commercial_stage: "intake_received",
    summary,
    next_action: "Review canonical website intake and route to the correct business workflow.",
    notes: JSON.stringify({
      request_id: envelope.request_id,
      idempotency_key: envelope.idempotency_key,
      business_unit: envelope.business_unit,
      inquiry_type: envelope.inquiry_type,
      source_page: envelope.source_page,
      source_form: envelope.source_form,
    }),
  };
}

async function findExistingIntakeLead(store, idempotencyKey) {
  const leads = await store.listLeads();
  return leads.find((lead) => String(lead.notes || "").includes(`"idempotency_key":"${idempotencyKey}"`)) || null;
}

// Strips falsy fields entirely (not just `undefined`-valued ones) so a
// sparse identity update can never blank out an existing value with an
// empty string from a follow-up submission that simply didn't repeat it.
// This is deliberately stricter than store.updateLead's own sparse-patch
// check (which only looks at whether the key was present, not whether its
// normalized value is non-empty) — see findOrUpsertLead below.
function sparseNonEmpty(input = {}) {
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    result[key] = value;
  }
  return result;
}

// Finds an existing Lead by email then phone (same precedence as
// runtime.js's ensureLead, used by the conversational lead capture path)
// and folds a new submission into it as a sparse update + summary note,
// instead of creating an unbounded number of duplicate Lead rows for the
// same person. Only reached once the idempotency-key retry-guard in
// server.js has already ruled out this being a literal duplicate request.
async function findOrUpsertLead(store, envelope) {
  const email = envelope.contact.email;
  const phone = envelope.contact.phone;
  const existing =
    (email && store.findLeadByEmail ? await store.findLeadByEmail(email) : null) ||
    (phone && store.findLeadByPhone ? await store.findLeadByPhone(phone) : null);

  if (!existing) {
    return { lead: await store.createLead(leadInputFromIntake(envelope)), created: true };
  }

  const patch = sparseNonEmpty({
    name: envelope.contact.name,
    company: envelope.organization.name,
    role: envelope.contact.role,
    email,
    phone,
    location: envelope.organization.location,
    business_unit: envelope.business_unit,
    inquiry_type: envelope.inquiry_type,
    next_action: "Repeat website intake received — review the new enquiry alongside prior history.",
  });
  const lead = (await store.updateLead(existing.id, patch)) || existing;
  return { lead, created: false };
}

// Resolves (and dedupes) the Organization referenced by an intake
// envelope, matching case-insensitively on name against existing
// organizations rather than creating a new row for every submission
// from the same company. Returns null when the visitor gave no
// organization/company information — Part 3 explicitly says not to
// fabricate an Organization from nothing.
async function resolveOrganization(store, envelope, context) {
  const name = envelope.organization.name;
  if (!name) return null;
  const organizations = await listCorporateRecords(store, "organizations");
  const existing = organizations.find((org) => normalizeText(org.name).toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  return createCorporateRecord(
    store,
    "organizations",
    sparseNonEmpty({
      name,
      account_type: "prospect",
      city: envelope.organization.location,
      business_unit: envelope.business_unit,
    }),
    context
  );
}

// A generic corporate contact-form message ("corporate" business unit,
// i.e. GENERAL_CONTACT) is not a sales opportunity — everything else
// (development/technology/partnerships/private) genuinely represents a
// customer wanting something from a specific Ochiga business line, which
// is exactly what the Opportunity pipeline exists to track.
function shouldCreateOpportunity(envelope) {
  return envelope.business_unit !== "corporate";
}

function partnershipRelationshipType(inquiryType) {
  return PARTNERSHIP_RELATIONSHIP_TYPES[normalizeText(inquiryType).toLowerCase()] || "strategic_partner";
}

function intakeSummaryText(envelope) {
  return normalizeText(envelope.payload.message || envelope.payload.notes || envelope.payload.requirement) ||
    `${envelope.business_unit} ${envelope.inquiry_type} enquiry from ${envelope.source_site}.`;
}

// Runs the full canonical-CRM side of a website intake: Contact identity
// (deduped by email), Organization when real company info was given,
// Opportunity when the business logic actually justifies one, a
// Private/Partnership relationship when the business unit calls for it,
// and one Activity tying it all together for the timeline. Every step is
// additive — this never mutates or removes what the legacy Lead flow
// already recorded; the two are independent, deliberately overlapping
// views over the same intake so both "CRM -> Leads" and "CRM -> Contacts"
// style Office UI surfaces have something real to show.
async function runOfficeIntakeCrm(store, envelope, lead, context) {
  const organization = await resolveOrganization(store, envelope, context);

  const contact = await upsertContactIdentity(
    store,
    sparseNonEmpty({
      name: envelope.contact.name,
      email: envelope.contact.email,
      phone: envelope.contact.phone,
      role: envelope.contact.role,
      organization_id: organization ? organization.id : undefined,
      business_unit: envelope.business_unit,
      source: envelope.source_site,
    }),
    context
  );

  let opportunity = null;
  if (shouldCreateOpportunity(envelope)) {
    opportunity = await createCorporateRecord(
      store,
      "opportunities",
      sparseNonEmpty({
        contact_id: contact.id,
        organization_id: organization ? organization.id : undefined,
        lead_id: lead ? lead.id : undefined,
        business_unit: envelope.business_unit,
        inquiry_type: envelope.inquiry_type,
        pipeline: envelope.business_unit,
        stage: "intake_received",
        source: envelope.source_site,
      }),
      context
    );
  }

  let relationship = null;
  let relationshipCollection = null;
  if (envelope.business_unit === "private") {
    relationshipCollection = "private";
    relationship = await createCorporateRecord(
      store,
      "private",
      sparseNonEmpty({
        contact_id: contact.id,
        organization_id: organization ? organization.id : undefined,
        opportunity_id: opportunity ? opportunity.id : undefined,
        business_unit: "private",
        relationship_type: "membership",
        notes: intakeSummaryText(envelope),
      }),
      context
    );
  } else if (envelope.business_unit === "partnerships") {
    relationshipCollection = "partnerships";
    relationship = await createCorporateRecord(
      store,
      "partnerships",
      sparseNonEmpty({
        contact_id: contact.id,
        organization_id: organization ? organization.id : undefined,
        opportunity_id: opportunity ? opportunity.id : undefined,
        business_unit: "partnerships",
        relationship_type: partnershipRelationshipType(envelope.inquiry_type),
        notes: intakeSummaryText(envelope),
      }),
      context
    );
  }

  const relatedType =
    relationshipCollection === "private" ? "private_relationship" :
    relationshipCollection === "partnerships" ? "partnership_relationship" :
    opportunity ? "opportunity" : "contact";
  const relatedId = relationship ? relationship.id : opportunity ? opportunity.id : contact.id;

  const activity = await createCorporateRecord(
    store,
    "activities",
    {
      contact_id: contact.id,
      organization_id: organization ? organization.id : null,
      opportunity_id: opportunity ? opportunity.id : null,
      lead_id: lead ? lead.id : null,
      related_type: relatedType,
      related_id: relatedId,
      activity_type: "website_intake_received",
      title: `Website ${envelope.business_unit} enquiry received`,
      body: intakeSummaryText(envelope),
      business_unit: envelope.business_unit,
      source: envelope.source_site,
      actor: envelope.source_site,
    },
    context
  );

  return { contact, organization, opportunity, relationship, relationship_collection: relationshipCollection, activity };
}

module.exports = {
  BUSINESS_UNITS,
  findExistingIntakeLead,
  findOrUpsertLead,
  leadInputFromIntake,
  normalizeOfficeIntakeEnvelope,
  runOfficeIntakeCrm,
};
