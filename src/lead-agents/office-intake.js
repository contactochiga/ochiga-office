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

// Oyi Communications Convergence, Slice 2 -- the website's own lead
// forms already require an explicit, named consent checkbox
// (lib/leads/schemas.ts's `consent` field, mapped by
// lib/office/intakeClient.ts's sendOfficeIntake() into
// consent.marketing_followup). This was previously accepted onto the
// intake envelope (normalizeOfficeIntakeEnvelope, above) and then
// silently dropped before the Lead was created -- this function is
// what actually turns that real evidence into structured contactability
// instead of discarding it. Only "marketing_followup === true" (an
// explicit, required checkbox on every current form) counts as
// evidence; anything else stays "unknown" and channels stay empty --
// never inferred as allowed from the mere presence of a phone/email.
function deriveContactability(envelope) {
  const hasMarketingConsent = Boolean(envelope.consent && envelope.consent.marketing_followup === true);
  if (!hasMarketingConsent) {
    return { contactability_status: "unknown", contactability_channels: [], consent_source: "", consent_recorded_at: "" };
  }
  const channels = [];
  if (envelope.contact.email) channels.push("email");
  // The form collects one phone field; whatsapp_phone is not populated
  // at website-intake time (see backend-events.js) but Slice 1's own
  // preferredSupportedChannel() already treats `phone` as a valid
  // WhatsApp-reachable fallback -- this reuses that same assumption
  // rather than introducing a stricter or looser one here.
  if (envelope.contact.phone) {
    channels.push("phone");
    channels.push("whatsapp");
  }
  return {
    contactability_status: "allowed",
    contactability_channels: channels,
    consent_source: `${envelope.source_form || envelope.source_site || "website"}_form_consent`,
    consent_recorded_at: envelope.submitted_at || new Date().toISOString(),
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
    ...deriveContactability(envelope),
  };
}

// Every intake (first or repeat, from any contact) records its idempotency key in the metadata of its "office_intake_received" timeline
// event, so that is where a retried submission is recognised first. The original Lead.notes scan stays as the fallback (it only ever
// matched a contact's FIRST submission, which is why a retried repeat enquiry used to be filed twice).
async function findExistingIntakeLead(store, idempotencyKey) {
  if (typeof store.findIntakeTimelineEvent === "function") {
    const event = await store.findIntakeTimelineEvent(idempotencyKey);
    if (event && event.lead_id) {
      const lead = await store.getLead(event.lead_id);
      if (lead) return lead;
    }
  }
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
  // Oyi Communications Convergence, Slice 2 -- only ever included when
  // THIS submission carries real new consent evidence. A repeat
  // submission with no consent evidence must never re-include these
  // keys: normalizeContactabilityStatus always resolves to a concrete
  // value ("unknown" included), so including the key at all would
  // overwrite an existing lead's real "allowed" back to "unknown".
  // sparseNonEmpty's own filtering is not enough to prevent that (a
  // real "unknown" string is not falsy) -- the guard has to be here.
  const contactability = deriveContactability(envelope);
  if (contactability.contactability_status === "allowed") {
    Object.assign(patch, contactability);
  }
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

// Oyi Communications Convergence, production activation -- PERSON/
// RELATIONSHIP != INDIVIDUAL OPPORTUNITY. The Lead row is one person's
// relationship record and is correctly reused/patched across repeat
// submissions (findOrUpsertLead, above); it must never become the
// permanent storage for a SPECIFIC property's evidence, or a later,
// unrelated submission from the same person would silently overwrite
// an earlier open Opportunity's own facts. Each Development/JV
// Opportunity instead carries its own evidence in its own metadata,
// scoped to the one submission that created it -- only fields this
// intake envelope genuinely carries are included (never invented from
// prose); everything else stays honestly absent, same discipline as
// backend-events.js's buildDevelopmentEvidence().
function buildOpportunityDevelopmentEvidence(envelope) {
  const payload = envelope.payload || {};
  const evidence = {
    opportunity_type: normalizeText(envelope.inquiry_type || envelope.organization.type) || undefined,
    location: normalizeText(envelope.organization.location) || undefined,
    land_size: normalizeText(payload.approx_land_size || payload.property_size || payload.land_size) || undefined,
    commercial_terms: normalizeText(payload.premium_expectation || payload.commercial_terms || payload.budget_range) || undefined,
    timeline: normalizeText(payload.expected_timeline || payload.timeline) || undefined,
    scale_units: Number.isFinite(Number(envelope.organization.unit_count)) && Number(envelope.organization.unit_count) > 0
      ? Number(envelope.organization.unit_count)
      : undefined,
    source_channel: normalizeText(envelope.source_channel) || undefined,
    decision_maker_status: normalizeText(payload.decision_maker_status) || undefined,
  };
  return Object.fromEntries(Object.entries(evidence).filter(([, value]) => value !== undefined));
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
// A CRM write the store could not persist comes back flagged instead of throwing (createCorporateRecord answers HTTP 400/404/406 with
// sync_status "schema_pending"). For intake that is a FAILED write: it must stay retryable, never count as filed.
function assertPersisted(record, collection) {
  if (!record || record.sync_status === "schema_pending") {
    const error = new Error(`crm_write_not_persisted:${collection}`);
    error.code = "crm_write_not_persisted";
    throw error;
  }
  return record;
}

// Creates a CRM record at most once per intake key and step. The marker travels inside the record's own metadata (written by the same
// insert), so a retry after a partial failure finds what the earlier attempt already created instead of creating it again.
async function createOnceForIntake(store, collection, step, input, context, intakeKey) {
  if (!intakeKey) return assertPersisted(await createCorporateRecord(store, collection, input, context), collection);
  const rows = await listCorporateRecords(store, collection);
  const existing = rows.find((row) => row && row.metadata && row.metadata.intake_key === intakeKey && row.metadata.intake_step === step);
  if (existing) return existing;
  const metadata = { ...(input.metadata || {}), intake_key: intakeKey, intake_step: step };
  return assertPersisted(await createCorporateRecord(store, collection, { ...input, metadata }, context), collection);
}

async function runOfficeIntakeCrm(store, envelope, lead, context, { intakeKey } = {}) {
  const organization = await resolveOrganization(store, envelope, context);
  if (organization) assertPersisted(organization, "organizations");

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
  assertPersisted(contact, "contacts");

  let opportunity = null;
  if (shouldCreateOpportunity(envelope)) {
    opportunity = await createOnceForIntake(
      store,
      "opportunities",
      "opportunity",
      sparseNonEmpty({
        contact_id: contact.id,
        organization_id: organization ? organization.id : undefined,
        lead_id: lead ? lead.id : undefined,
        business_unit: envelope.business_unit,
        inquiry_type: envelope.inquiry_type,
        pipeline: envelope.business_unit,
        stage: "intake_received",
        source: envelope.source_site,
        // This Opportunity's OWN evidence, scoped to this one submission
        // — never the person's Lead record, which a later, unrelated
        // submission from the same person would otherwise overwrite.
        metadata: envelope.business_unit === "development"
          ? { development: buildOpportunityDevelopmentEvidence(envelope) }
          : undefined,
      }),
      context,
      intakeKey
    );
  }

  let relationship = null;
  let relationshipCollection = null;
  if (envelope.business_unit === "private") {
    relationshipCollection = "private";
    relationship = await createOnceForIntake(
      store,
      "private",
      "private_relationship",
      sparseNonEmpty({
        contact_id: contact.id,
        organization_id: organization ? organization.id : undefined,
        opportunity_id: opportunity ? opportunity.id : undefined,
        business_unit: "private",
        relationship_type: "membership",
        notes: intakeSummaryText(envelope),
      }),
      context,
      intakeKey
    );
  } else if (envelope.business_unit === "partnerships") {
    relationshipCollection = "partnerships";
    relationship = await createOnceForIntake(
      store,
      "partnerships",
      "partnership_relationship",
      sparseNonEmpty({
        contact_id: contact.id,
        organization_id: organization ? organization.id : undefined,
        opportunity_id: opportunity ? opportunity.id : undefined,
        business_unit: "partnerships",
        relationship_type: partnershipRelationshipType(envelope.inquiry_type),
        notes: intakeSummaryText(envelope),
      }),
      context,
      intakeKey
    );
  }

  const relatedType =
    relationshipCollection === "private" ? "private_relationship" :
    relationshipCollection === "partnerships" ? "partnership_relationship" :
    opportunity ? "opportunity" : "contact";
  const relatedId = relationship ? relationship.id : opportunity ? opportunity.id : contact.id;

  const activity = await createOnceForIntake(
    store,
    "activities",
    "activity",
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
    context,
    intakeKey
  );

  return { contact, organization, opportunity, relationship, relationship_collection: relationshipCollection, activity };
}

// ---------------------------------------------------------------- intake receipts (exactly-once filing, retryable CRM failure)

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

// What makes two requests "the same submission": the content the visitor sent, never the per-request id, timestamps or delivery metadata.
function intakeDigest(envelope) {
  const material = {
    source_site: envelope.source_site, source_form: envelope.source_form, business_unit: envelope.business_unit, inquiry_type: envelope.inquiry_type,
    contact: envelope.contact, organization: envelope.organization, payload: envelope.payload, consent: envelope.consent,
  };
  return crypto.createHash("sha256").update(canonicalJson(material)).digest("hex");
}

const INTAKE_LEASE_SECONDS = 60;

function errorCategory(error) {
  const text = String((error && (error.code || error.message)) || "unknown");
  return text.replace(/[^a-z0-9_:.-]+/gi, "_").slice(0, 120);
}

/**
 * Files one intake submission at most once per idempotency key.
 * Outcomes: "filed" (lead + CRM + timeline written), "duplicate" (already filed), "in_progress" (another request holds the key),
 * "conflict" (key re-used for different content), "crm_failed" (lead filed, CRM incomplete -- retryable, NOT recorded as filed),
 * "unavailable" (nothing could be filed -- retryable).
 * Without the receipts migration the Phase 0 behaviour is kept (timeline-based recognition, no atomic claim), reported as receipts:false.
 */
async function fileIntakeSubmission(store, envelope, { client = "", actor, log = () => {}, timelineMetadata = () => ({}) } = {}) {
  const key = envelope.idempotency_key;
  const digest = intakeDigest(envelope);
  let receipts = false;
  try {
    receipts = typeof store.supportsIntakeReceipts === "function" && (await store.supportsIntakeReceipts()) === true;
  } catch (error) {
    log("warn", "office_intake.receipts_probe_failed", { reason: errorCategory(error) });
    return { outcome: "unavailable", receipts: false, error: "receipts_store_error" };
  }

  let attempt = 0;
  if (receipts) {
    let claim;
    try {
      claim = await store.claimIntakeReceipt({ key, client, requestId: envelope.request_id, digest, leaseSeconds: INTAKE_LEASE_SECONDS });
    } catch (error) {
      log("warn", "office_intake.claim_failed", { reason: errorCategory(error) });
      return { outcome: "unavailable", receipts, error: "receipt_claim_failed" };
    }
    if (claim.outcome === "conflict") return { outcome: "conflict", receipts };
    if (claim.outcome === "in_progress") return { outcome: "in_progress", receipts };
    if (claim.outcome === "duplicate") {
      const lead = claim.leadId ? await store.getLead(claim.leadId) : null;
      return { outcome: "duplicate", receipts, lead, leadId: claim.leadId };
    }
    attempt = claim.attempts;
    if (claim.outcome === "claimed") {
      // submissions filed before receipts existed: recognise them once and record them as completed
      const legacy = await findExistingIntakeLead(store, key);
      if (legacy) {
        await store.completeIntakeReceipt({ key, attempt, leadId: legacy.id });
        return { outcome: "duplicate", receipts, lead: legacy, leadId: legacy.id, legacy: true };
      }
    }
  } else {
    const legacy = await findExistingIntakeLead(store, key);
    if (legacy) return { outcome: "duplicate", receipts, lead: legacy, leadId: legacy.id, legacy: true };
  }

  const fail = async (stage, error, leadId) => {
    const category = `${stage}:${errorCategory(error)}`;
    log("warn", "office_intake.write_failed", { stage, reason: category, attempt });
    if (receipts) {
      try { await store.failIntakeReceipt({ key, attempt, leadId: leadId || null, error: category }); } catch { /* the lease expires on its own; the key stays retryable */ }
    }
    return category;
  };

  let lead;
  let leadCreated = false;
  try {
    ({ lead, created: leadCreated } = await findOrUpsertLead(store, envelope));
  } catch (error) {
    await fail("lead", error);
    return { outcome: "unavailable", receipts, error: "lead_write_failed" };
  }

  let crm;
  try {
    crm = await runOfficeIntakeCrm(store, envelope, lead, { actorEmail: actor || envelope.source_site }, { intakeKey: key });
  } catch (error) {
    const category = await fail("crm", error, lead.id);
    return { outcome: "crm_failed", receipts, lead, leadCreated, error: category };
  }

  let timelineEvent;
  try {
    timelineEvent = (typeof store.findIntakeTimelineEvent === "function" && (await store.findIntakeTimelineEvent(key))) || (await store.appendTimelineEvent({
      lead_id: lead.id,
      event_type: "office_intake_received",
      actor: envelope.source_site,
      title: leadCreated ? "Office intake received" : "Repeat office intake received",
      body: `${envelope.business_unit} ${envelope.inquiry_type} intake received from ${envelope.source_site}.`,
      metadata: {
        request_id: envelope.request_id,
        idempotency_key: key,
        source_channel: envelope.source_channel,
        source_site: envelope.source_site,
        source_page: envelope.source_page,
        source_form: envelope.source_form,
        business_unit: envelope.business_unit,
        inquiry_type: envelope.inquiry_type,
        campaign: envelope.campaign,
        consent: envelope.consent,
        ...timelineMetadata(lead),
        crm_contact_id: crm?.contact?.id || null,
      },
    }));
  } catch (error) {
    const category = await fail("timeline", error, lead.id);
    return { outcome: "crm_failed", receipts, lead, leadCreated, crm, error: category };
  }

  if (receipts) {
    const completed = await store.completeIntakeReceipt({ key, attempt, leadId: lead.id }).catch(() => false);
    // a false here means a newer attempt took the key over after this one's lease expired; the work above is idempotent, so both are consistent
    if (!completed) log("warn", "office_intake.complete_superseded", { attempt });
  }
  return { outcome: "filed", receipts, lead, leadCreated, crm, timelineEvent };
}

// ---------------------------------------------------------------- recovery codes (website could not reach Office)
// A website that could not deliver a submission emails staff a code: "v1.<base64url JSON {envelope, issued_at}>.<base64url HMAC-SHA256>".
// The HMAC key is the hex SHA-256 digest of that website's scoped API key -- the value Office already holds in LEAD_AGENTS_SCOPED_API_KEYS --
// so no extra secret exists and the website never holds a privileged credential. Only a signed-in staff member can redeem a code.
const RECOVERY_CODE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function verifyRecoveryCode(code, scopedApiKeys = [], { now = Date.now() } = {}) {
  const parts = String(code || "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || parts[1].length > 24000) return { ok: false, reason: "malformed" };
  const [, body, signature] = parts;
  const entry = (scopedApiKeys || []).filter((item) => (item.scopes || []).includes("intake.submit")).find((item) => {
    const expected = crypto.createHmac("sha256", item.keySha256).update(`v1.${body}`).digest("base64url");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!entry) return { ok: false, reason: "bad_signature" };
  let decoded;
  try { decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return { ok: false, reason: "malformed" }; }
  const issuedAt = Date.parse(decoded && decoded.issued_at);
  if (!Number.isFinite(issuedAt) || issuedAt > now + 5 * 60 * 1000 || now - issuedAt > RECOVERY_CODE_MAX_AGE_MS) return { ok: false, reason: "expired" };
  if (!decoded.envelope || typeof decoded.envelope !== "object") return { ok: false, reason: "malformed" };
  return { ok: true, client: entry.client, envelope: decoded.envelope, issuedAt: new Date(issuedAt).toISOString() };
}

module.exports = {
  BUSINESS_UNITS,
  fileIntakeSubmission,
  intakeDigest,
  verifyRecoveryCode,
  findExistingIntakeLead,
  findOrUpsertLead,
  leadInputFromIntake,
  normalizeOfficeIntakeEnvelope,
  runOfficeIntakeCrm,
};
