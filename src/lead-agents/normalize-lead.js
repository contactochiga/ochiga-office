function normalizeText(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (["unknown", "n/a", "na", "none", "null", "undefined"].includes(text.toLowerCase())) {
    return "";
  }
  return text.replace(/\s+/g, " ");
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizePhone(value) {
  return normalizeText(value).replace(/[^\d+\-() ]/g, "");
}

function normalizeScore(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const score = Number(value);
  if (!Number.isFinite(score)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function normalizeSource(value, fallback) {
  const normalized = normalizeText(value);
  return normalized || normalizeText(fallback);
}

// Oyi Communications Convergence, Slice 2 -- enforced at the write
// boundary so the column can never hold anything but the tri-state
// Backend's own conservative validateMaterialEvent() already expects.
// Deliberately NOT routed through normalizeText: that helper strips the
// literal word "unknown" to "", which would defeat the point here.
// Callers must never include this key in an update patch unless they
// have genuine new evidence -- see office-intake.js's findOrUpsertLead,
// which only ever writes contactability_status once, on the first
// upgrade to "allowed", never re-including the key on later repeat
// submissions that carry no new consent.
function normalizeContactabilityStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === "allowed" || normalized === "denied" ? normalized : "unknown";
}

function normalizeContactabilityChannels(value) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(["email", "phone", "whatsapp"]);
  return [...new Set(value.filter((item) => allowed.has(item)))];
}

// next_action_at/last_contact_at are `timestamptz` columns — unlike the
// text columns normalizeText backs, an empty string is not a valid value
// for them (Postgres/PostgREST reject "" with a 400: invalid input syntax
// for type timestamp with time zone). Missing/blank input must become
// undefined (dropped from the JSON payload), never "".
function normalizeTimestamp(value) {
  const text = normalizeText(value);
  return text || undefined;
}

function normalizeLeadInput(input, fallbackSource) {
  return {
    name: normalizeText(input.name),
    company: normalizeText(input.company),
    role: normalizeText(input.role),
    email: normalizeEmail(input.email),
    phone: normalizePhone(input.phone),
    whatsapp_phone: normalizePhone(input.whatsapp_phone),
    primary_channel: normalizeText(input.primary_channel),
    source_channel: normalizeText(input.source_channel),
    source: normalizeSource(input.source, fallbackSource),
    business_unit: normalizeText(input.business_unit),
    inquiry_type: normalizeText(input.inquiry_type),
    location: normalizeText(input.location),
    city: normalizeText(input.city),
    country: normalizeText(input.country),
    unit_count:
      input.unit_count === undefined || input.unit_count === null || input.unit_count === ""
        ? undefined
        : Math.max(0, Math.round(Number(input.unit_count) || 0)),
    project_type: normalizeText(input.project_type),
    property_type: normalizeText(input.property_type),
    property_size: normalizeText(input.property_size),
    number_of_units:
      input.number_of_units === undefined || input.number_of_units === null || input.number_of_units === ""
        ? undefined
        : Math.max(0, Math.round(Number(input.number_of_units) || 0)),
    pain_points: normalizeText(input.pain_points),
    budget_range: normalizeText(input.budget_range),
    timeline: normalizeText(input.timeline),
    decision_maker_status: normalizeText(input.decision_maker_status),
    interest_package: normalizeText(input.interest_package),
    lead_score: normalizeScore(input.lead_score),
    qualification_status: normalizeText(input.qualification_status),
    stage: normalizeText(input.stage),
    status: normalizeText(input.status),
    owner: normalizeText(input.owner),
    commercial_stage: normalizeText(input.commercial_stage),
    lost_reason: normalizeText(input.lost_reason),
    score: normalizeScore(input.score),
    summary: normalizeText(input.summary),
    next_action: normalizeText(input.next_action),
    next_action_at: normalizeTimestamp(input.next_action_at),
    last_contact_at: normalizeTimestamp(input.last_contact_at),
    notes: normalizeText(input.notes),
    contactability_status: normalizeContactabilityStatus(input.contactability_status),
    contactability_channels: normalizeContactabilityChannels(input.contactability_channels),
    consent_source: normalizeText(input.consent_source),
    consent_recorded_at: normalizeTimestamp(input.consent_recorded_at),
  };
}

const PATCH_FIELDS = [
  "name",
  "company",
  "role",
  "email",
  "phone",
  "whatsapp_phone",
  "primary_channel",
  "source_channel",
  "source",
  "business_unit",
  "inquiry_type",
  "location",
  "city",
  "country",
  "unit_count",
  "project_type",
  "property_type",
  "property_size",
  "number_of_units",
  "pain_points",
  "budget_range",
  "timeline",
  "decision_maker_status",
  "interest_package",
  "lead_score",
  "qualification_status",
  "stage",
  "status",
  "owner",
  "commercial_stage",
  "lost_reason",
  "score",
  "summary",
  "next_action",
  "next_action_at",
  "last_contact_at",
  "notes",
  "contactability_status",
  "contactability_channels",
  "consent_source",
  "consent_recorded_at",
];

function normalizeLeadPatch(patch) {
  const sparse = {};
  for (const field of PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      sparse[field] = patch[field];
    }
  }
  for (const field of ["unit_count", "number_of_units", "lead_score", "score"]) {
    if (Object.prototype.hasOwnProperty.call(sparse, field) && sparse[field] !== null && sparse[field] !== undefined && sparse[field] !== "") {
      const numeric = Number(sparse[field]);
      if (!Number.isFinite(numeric)) {
        const error = new Error(`invalid_${field}`);
        error.statusCode = 400;
        throw error;
      }
    }
  }
  return Object.fromEntries(
    Object.entries(normalizeLeadInput(sparse, "")).filter(
      ([key, value]) => Object.prototype.hasOwnProperty.call(sparse, key) && value !== undefined
    )
  );
}

module.exports = {
  normalizeEmail,
  normalizeLeadInput,
  normalizeLeadPatch,
  PATCH_FIELDS,
  normalizePhone,
  normalizeScore,
  normalizeSource,
  normalizeText,
  normalizeContactabilityStatus,
  normalizeContactabilityChannels,
};
