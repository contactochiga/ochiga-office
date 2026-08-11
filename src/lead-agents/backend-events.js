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

function buildMaterialCrmEvent({ lead, envelope, timelineEvent, requestId } = {}) {
  const safeLead = recordOf(lead);
  const safeEnvelope = recordOf(envelope);
  const safeTimelineEvent = recordOf(timelineEvent);
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
    },
    metadata: {
      timeline_event_id: text(safeTimelineEvent.id),
      campaign_present: Object.keys(recordOf(safeEnvelope.campaign)).length > 0,
      consent_present: Object.keys(recordOf(safeEnvelope.consent)).length > 0,
    },
  };
}

function backendEventUrl(config) {
  const base = text(config.officeBackendBaseUrl).replace(/\/+$/g, "");
  const path = text(config.officeBackendEventPath || "/office/events/material");
  if (!base || !path) return "";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

async function publishBackendMaterialEvent(config, event, options = {}) {
  if (!config.officeBackendEventsEnabled) {
    return { ok: false, skipped: true, reason: "disabled" };
  }
  const url = backendEventUrl(config);
  if (!url) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  const headers = {
    "content-type": "application/json",
    "x-office-event-id": event.event_id,
    "x-idempotency-key": event.idempotency_key,
  };
  if (config.officeBackendApiKey) headers["x-office-api-key"] = config.officeBackendApiKey;
  if (config.officeBackendBearerToken) headers.authorization = `Bearer ${config.officeBackendBearerToken}`;

  const post = options.httpPost || ((targetUrl, payload, requestConfig) => axios.post(targetUrl, payload, requestConfig));
  try {
    const response = await post(url, event, {
      timeout: config.officeBackendEventTimeoutMs || 10_000,
      headers,
      validateStatus: () => true,
    });
    const status = Number(response && response.status) || 0;
    if (status >= 200 && status < 300) return { ok: true, skipped: false, status };
    return { ok: false, skipped: false, status, reason: "backend_rejected" };
  } catch (error) {
    return { ok: false, skipped: false, status: 0, reason: "network_error", error: error && error.code ? String(error.code) : "request_failed" };
  }
}

module.exports = {
  backendEventUrl,
  buildMaterialCrmEvent,
  materialEventTypeForLead,
  publishBackendMaterialEvent,
};
