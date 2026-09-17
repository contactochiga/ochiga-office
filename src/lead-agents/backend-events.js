const crypto = require("crypto");
const axios = require("axios");

function text(value) {
  return String(value ?? "").trim();
}

function recordOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeKey(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function materialEventTypeForLead(lead = {}, envelope = {}) {
  const businessUnit = normalizeKey(envelope.business_unit || lead.business_unit || "");
  const inquiryType = normalizeKey(envelope.inquiry_type || lead.project_type || "");
  if (businessUnit === "technology" || /oyi|deployment|technology|integrator/.test(inquiryType)) return "technology_deployment_requested";
  if (businessUnit === "development" || /development|land|jv|offtake|project/.test(inquiryType)) return "development_enquiry_received";
  if (businessUnit === "private" || /membership|member|investor/.test(inquiryType)) return "membership_requested";
  if (businessUnit === "partnerships" || /partner|partnership|supplier|consultant|capital/.test(inquiryType)) return "partnership_enquiry_received";
  return "lead_created";
}

function leadPublicLabel(lead = {}, envelope = {}) {
  const organization = recordOf(envelope.organization);
  return text(lead.company || organization.name || envelope.source_site || "Office lead");
}

// Office Intelligence Convergence, Wave 3 -- best-effort JV evidence for
// Backend's Development/JV capability. Office has no dedicated JV schema
// yet (no jv_structure_offered/landowner_expectation/title_document_status
// columns), so those are honestly omitted rather than guessed from free
// text -- Backend's JV capability reports an omitted field as
// missing_information, never fabricates it.
//
// Production activation, PERSON/RELATIONSHIP != INDIVIDUAL OPPORTUNITY --
// evidence belonging to a SPECIFIC opportunity (office-intake.js's
// buildOpportunityDevelopmentEvidence(), written once at that
// Opportunity's own creation) always wins over the Lead's own fields.
// The Lead fields remain a compatibility fallback only -- for callers
// that never pass an opportunity, or for whichever fields a given
// opportunity's own metadata happens not to carry -- so a later,
// unrelated submission from the same person (a second Opportunity, a
// different property) can never silently overwrite what this event
// reports for THIS Opportunity.
function buildDevelopmentEvidence(lead = {}, opportunity = null) {
  const fromOpportunity = recordOf(recordOf(opportunity).metadata).development;
  const opp = recordOf(fromOpportunity);
  const location = text(opp.location) || text(lead.location) || [text(lead.city), text(lead.country)].filter(Boolean).join(", ");
  const evidence = {
    opportunity_type: text(opp.opportunity_type) || text(lead.project_type || lead.property_type) || undefined,
    location: location || undefined,
    land_size: text(opp.land_size) || text(lead.property_size) || undefined,
    commercial_terms: text(opp.commercial_terms) || text(lead.budget_range) || undefined,
    timeline: text(opp.timeline) || text(lead.timeline) || undefined,
    scale_units: Number.isFinite(Number(opp.scale_units)) && Number(opp.scale_units) > 0
      ? Number(opp.scale_units)
      : (Number.isFinite(Number(lead.unit_count)) && Number(lead.unit_count) > 0
          ? Number(lead.unit_count)
          : (Number.isFinite(Number(lead.number_of_units)) && Number(lead.number_of_units) > 0 ? Number(lead.number_of_units) : undefined)),
    source_channel: text(opp.source_channel) || text(lead.source_channel || lead.primary_channel) || undefined,
    decision_maker_status: text(opp.decision_maker_status) || text(lead.decision_maker_status) || undefined,
  };
  return Object.fromEntries(Object.entries(evidence).filter(([, value]) => value !== undefined));
}

function buildMaterialCrmEvent({ lead, envelope, timelineEvent, requestId, opportunity } = {}) {
  const safeLead = recordOf(lead);
  const safeEnvelope = recordOf(envelope);
  const safeTimelineEvent = recordOf(timelineEvent);
  const safeOpportunity = recordOf(opportunity);
  const eventType = materialEventTypeForLead(safeLead, safeEnvelope);
  const sourceSite = text(safeEnvelope.source_site || safeLead.source);
  const idempotencyKey = text(safeEnvelope.idempotency_key)
    || text(safeTimelineEvent.metadata && safeTimelineEvent.metadata.idempotency_key)
    || crypto.createHash("sha256").update([safeLead.id, eventType, requestId].filter(Boolean).join("|")).digest("hex");
  const eventId = `office:${safeLead.id || "lead"}:${eventType}:${idempotencyKey}`;

  return {
    event_id: eventId,
    idempotency_key: idempotencyKey,
    event_type: eventType,
    source_system: "ochiga-office",
    occurred_at: text(safeTimelineEvent.created_at || safeEnvelope.submitted_at) || new Date().toISOString(),
    request_id: text(requestId || safeEnvelope.request_id),
    subject: {
      type: "lead",
      id: text(safeLead.id),
      label: leadPublicLabel(safeLead, safeEnvelope),
    },
    business_unit: normalizeKey(safeEnvelope.business_unit || "corporate"),
    inquiry_type: normalizeKey(safeEnvelope.inquiry_type || safeLead.project_type || "general_enquiry"),
    source: {
      channel: text(safeEnvelope.source_channel || "website"),
      site: sourceSite,
      page: text(safeEnvelope.source_page),
      form: text(safeEnvelope.source_form),
    },
    crm: {
      lead_id: text(safeLead.id),
      status: text(safeLead.status),
      stage: text(safeLead.commercial_stage),
      owner: text(safeLead.owner),
      // The Lead's own status/stage above describe the PERSON's overall
      // relationship history and are never re-derived per opportunity;
      // opportunity_id names the specific, independent Opportunity this
      // event's evidence actually belongs to (see buildDevelopmentEvidence
      // below) so Backend/observability never conflates the two.
      opportunity_id: text(safeOpportunity.id) || null,
    },
    // Oyi Communications Convergence, Slice 1 -- this was previously
    // captured and persisted on the Lead (primary_channel/phone/email/
    // whatsapp_phone) but silently dropped exactly at this hop (the
    // Slice 1 audit's finding).
    //
    // Slice 2 -- contactability now reads the Lead's real, structured
    // consent evidence (office-intake.js's deriveContactability(),
    // built from the explicit consent checkbox every website form
    // already requires). Historical leads created before that column
    // existed have no value here and correctly read back as "unknown" --
    // never silently upgraded. The literal-string check is defense in
    // depth: normalize-lead.js's normalizeContactabilityStatus already
    // guarantees the column can only ever hold allowed/denied/unknown,
    // and Backend's own validateMaterialEvent() re-applies the same
    // conservative guard independently on receipt.
    communication_context: {
      primary_channel: text(safeLead.primary_channel) || null,
      email: text(safeLead.email) || null,
      phone: text(safeLead.phone) || null,
      whatsapp_phone: text(safeLead.whatsapp_phone) || null,
      contactability: ["allowed", "denied"].includes(text(safeLead.contactability_status))
        ? safeLead.contactability_status
        : "unknown",
    },
    metadata: {
      timeline_event_id: text(safeTimelineEvent.id),
      campaign_present: Object.keys(recordOf(safeEnvelope.campaign)).length > 0,
      consent_present: Object.keys(recordOf(safeEnvelope.consent)).length > 0,
      ...(eventType === "development_enquiry_received" ? { development: buildDevelopmentEvidence(safeLead, safeOpportunity) } : {}),
    },
  };
}

function backendEventUrl(config) {
  const base = text(config.officeBackendBaseUrl).replace(/\/+$/g, "");
  const path = text(config.officeBackendEventPath || "/office/events/material");
  if (!base || !path) return "";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function eventMaxAttempts(config) {
  const value = Number(config.officeBackendEventMaxAttempts);
  if (!Number.isFinite(value)) return 2;
  return Math.max(1, Math.min(5, Math.floor(value)));
}

function isRetryableStatus(status) {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

async function publishBackendMaterialEvent(config, event, options = {}) {
  if (!config.officeBackendEventsEnabled) {
    return { ok: false, skipped: true, reason: "disabled", attempts: 0 };
  }
  const url = backendEventUrl(config);
  if (!url) {
    return { ok: false, skipped: true, reason: "not_configured", attempts: 0 };
  }
  const headers = {
    "content-type": "application/json",
    "x-office-event-id": event.event_id,
    "x-idempotency-key": event.idempotency_key,
  };
  if (config.officeBackendApiKey) headers["x-office-api-key"] = config.officeBackendApiKey;
  if (config.officeBackendBearerToken) headers.authorization = `Bearer ${config.officeBackendBearerToken}`;

  const post = options.httpPost || ((targetUrl, payload, requestConfig) => axios.post(targetUrl, payload, requestConfig));
  const maxAttempts = eventMaxAttempts(config);
  let lastFailure = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      const response = await post(url, event, {
        timeout: config.officeBackendEventTimeoutMs || 10_000,
        headers,
        validateStatus: () => true,
      });
      const status = Number(response && response.status) || 0;
      if (status >= 200 && status < 300) return { ok: true, skipped: false, status, attempts: attempt };
      lastFailure = { status, reason: "backend_rejected" };
      if (!isRetryableStatus(status)) break;
    } catch (error) {
      lastFailure = {
        status: 0,
        reason: "network_error",
        error: error && error.code ? String(error.code) : "request_failed",
      };
    }
  }

  return {
    ok: false,
    skipped: false,
    status: lastFailure ? lastFailure.status : 0,
    reason: lastFailure ? lastFailure.reason : "request_failed",
    error: lastFailure && lastFailure.error ? lastFailure.error : undefined,
    attempts,
    dead_letter_required: true,
  };
}

module.exports = {
  backendEventUrl,
  buildMaterialCrmEvent,
  materialEventTypeForLead,
  publishBackendMaterialEvent,
};
