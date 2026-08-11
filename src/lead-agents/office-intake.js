const crypto = require("crypto");
const { normalizeEmail, normalizePhone, normalizeText } = require("./normalize-lead");

const BUSINESS_UNITS = new Set([
  "development",
  "technology",
  "private",
  "partnerships",
  "corporate",
]);

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

module.exports = {
  BUSINESS_UNITS,
  findExistingIntakeLead,
  leadInputFromIntake,
  normalizeOfficeIntakeEnvelope,
};
