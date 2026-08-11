const crypto = require("crypto");

const CONTRACT_VERSION = "corporate-intelligence.2026-08-11";

const BUSINESS_UNITS = Object.freeze([
  "development",
  "technology",
  "private",
  "partnerships",
  "corporate",
]);

const PUBLIC_IDENTITY = "ochiga_intelligence";

const ALLOWED_CAPABILITIES = Object.freeze([
  "corporate_knowledge_read",
  "public_question_answer",
  "crm_intake_create",
  "crm_journey_update",
  "conversation_continue",
  "voice_session_prepare",
  "human_handoff_request",
  "proactive_prompt_decide",
  "office_material_event_publish",
]);

const BLOCKED_OPERATIONAL_DOMAINS = Object.freeze([
  "devices",
  "access",
  "security",
  "visitors",
  "maintenance_private",
  "wallet",
  "utilities_private",
  "community_private",
  "facility_admin",
  "resident_private",
]);

const BLOCKED_ACTIONS = Object.freeze([
  "device_control",
  "lock_unlock",
  "visitor_credential_display",
  "access_approval",
  "payment",
  "wallet_funding",
  "facility_admin_action",
  "private_record_read",
]);

function text(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function snake(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function publicContextRef(seed) {
  const basis = text(seed) || crypto.randomUUID();
  return `pubctx_${crypto.createHash("sha256").update(basis).digest("hex").slice(0, 24)}`;
}

function publicSessionId(seed) {
  const basis = text(seed) || crypto.randomUUID();
  return `pubsess_${crypto.createHash("sha256").update(basis).digest("hex").slice(0, 24)}`;
}

function routeBusinessContext(input = {}) {
  const haystack = normalize([
    input.source_page,
    input.source_form,
    input.lead_type,
    input.inquiry_type,
    input.message,
    input.payload ? Object.values(input.payload).join(" ") : "",
    input.metadata ? Object.values(input.metadata).join(" ") : "",
  ].filter(Boolean).join(" "));

  if (/\b(oyi|technology|deployment|integrator|smart building|facility os|edge)\b/.test(haystack)) {
    return { business_unit: "technology", inquiry_type: /integrator/.test(haystack) ? "integrator_interest" : "oyi_deployment_request", confidence: "high", reason: "technology_or_oyi_signal" };
  }
  if (/\b(private|membership|member|investor|investment circle)\b/.test(haystack)) {
    return { business_unit: "private", inquiry_type: /request|apply|application/.test(haystack) ? "membership_request" : "membership_interest", confidence: "high", reason: "private_membership_signal" };
  }
  if (/\b(development|land|jv|joint venture|offtake|project sales|site)\b/.test(haystack)) {
    return { business_unit: "development", inquiry_type: /offtake|buyer|sales/.test(haystack) ? "sales_offtake" : "land_jv", confidence: "high", reason: "development_or_land_signal" };
  }
  if (/\b(partner|partnership|capital|consultant|supplier|professional|strategic)\b/.test(haystack)) {
    return { business_unit: "partnerships", inquiry_type: /capital/.test(haystack) ? "capital_partner" : "strategic_partner", confidence: "medium", reason: "partnership_signal" };
  }
  if (/\b(media|press)\b/.test(haystack)) {
    return { business_unit: "corporate", inquiry_type: "media", confidence: "medium", reason: "media_signal" };
  }
  return { business_unit: "corporate", inquiry_type: "general_enquiry", confidence: "low", reason: "default_corporate_triage" };
}

function selectAgentRole(input = {}) {
  const message = normalize(input.message);
  const leadStage = input.lead_stage || "exploring";
  const salesSignal = leadStage === "qualified"
    || leadStage === "handoff_requested"
    || /\b(price|pricing|proposal|demo|meeting|install|deployment|buildings?|portfolio|quote|timeline|budget|procurement)\b/.test(message);
  if (salesSignal) {
    return {
      agent_role: "osa",
      runtime_agent: "sales",
      lead_stage: leadStage === "exploring" ? "interested" : leadStage,
      reason: "commercial_or_sales_ready_signal",
    };
  }
  return {
    agent_role: "oma",
    runtime_agent: "marketing",
    lead_stage: leadStage,
    reason: "marketing_acquisition_context",
  };
}

function detectBlockedPublicOperationalRequest(input = {}) {
  const haystack = normalize(`${input.domain || ""} ${input.action || ""} ${input.message || ""}`);
  const blockedPatterns = [
    ["devices", /\b(turn on|turn off|switch|device|light|ac|air conditioner)\b/],
    ["access", /\b(unlock|lock|gate code|pin|access code|visitor code|approve visitor|revoke access)\b/],
    ["wallet", /\b(wallet|fund wallet|pay|payment|buy electricity|card)\b/],
    ["security", /\b(camera stream|security camera|private camera|alarm|door lock)\b/],
    ["resident_private", /\b(my home|resident|another resident|visitor list|community messages)\b/],
  ];
  const match = blockedPatterns.find(([, pattern]) => pattern.test(haystack));
  if (!match) return { blocked: false, domain: "", action: "", reason: "" };
  return {
    blocked: true,
    domain: match[0],
    action: haystack.includes("unlock") || haystack.includes("lock") ? "lock_unlock" : "private_record_read",
    reason: "public_surface_operational_capability_blocked",
  };
}

function buildPublicIntelligenceSession(input = {}) {
  const now = input.now || new Date().toISOString();
  const source = {
    source_site: text(input.source_site || input.source || "ochiga_website"),
    source_page: text(input.source_page || input.page || ""),
    source_form: text(input.source_form || ""),
    source_channel: text(input.source_channel || input.channel || "website"),
    campaign: input.campaign && typeof input.campaign === "object" ? input.campaign : {},
  };
  const routing = routeBusinessContext(input);
  const agent = selectAgentRole({
    business_unit: routing.business_unit,
    inquiry_type: routing.inquiry_type,
    lead_stage: input.lead_stage || "exploring",
    message: input.message,
  });
  const seed = input.session_id || input.public_session_id || input.lead_id || input.form_context_ref || `${source.source_site}|${source.source_page}|${input.message || ""}`;
  const mode = input.mode || (source.source_channel === "voice" ? "voice_conversation" : "text_conversation");

  return {
    contract_version: CONTRACT_VERSION,
    session_id: input.session_id || publicSessionId(seed),
    anonymous: !input.lead_id && !input.contact_ref,
    known_contact: Boolean(input.lead_id || input.contact_ref),
    source,
    business_unit: routing.business_unit,
    inquiry_type: routing.inquiry_type,
    routing_reason: routing.reason,
    conversation_thread_id: input.conversation_thread_id || null,
    crm_contact_ref: input.contact_ref || null,
    crm_opportunity_ref: input.opportunity_ref || null,
    secure_form_context_ref: input.form_context_ref || null,
    active_agent_role: agent.agent_role,
    runtime_agent: agent.runtime_agent,
    lead_stage: agent.lead_stage,
    agent_reason: agent.reason,
    engagement_mode: mode,
    handoff_state: input.handoff_state || "none",
    voice_state: mode === "voice_conversation" ? "ready" : "none",
    proactive_prompt_state: input.proactive_prompt_state || "eligible",
    consent: {
      analytics: Boolean(input.consent && input.consent.analytics),
      marketing_followup: Boolean(input.consent && input.consent.marketing_followup),
      voice_transcription: Boolean(input.consent && input.consent.voice_transcription),
    },
    public_identity: PUBLIC_IDENTITY,
    oyi_core_authority: "ochiga-backend",
    crm_source_of_truth: "ochiga-office",
    created_at: input.created_at || now,
    last_activity_at: now,
  };
}

function buildOyiCoreCorporateRequest(session, message) {
  return {
    surface: "public_corporate",
    public_identity: PUBLIC_IDENTITY,
    agent_role: session.active_agent_role,
    business_unit: session.business_unit,
    inquiry_type: session.inquiry_type,
    conversation_thread_id: session.conversation_thread_id,
    public_session_id: session.session_id,
    message: text(message),
    capability_allowlist: ALLOWED_CAPABILITIES,
    blocked_operational_domains: BLOCKED_OPERATIONAL_DOMAINS,
  };
}

function createFormContinuationContext(envelope = {}, lead = {}) {
  const requestId = text(envelope.request_id || envelope.requestId || crypto.randomUUID());
  const key = text(envelope.idempotency_key || envelope.idempotencyKey || requestId);
  return {
    public_context_ref: publicContextRef(`${key}|${lead.id || ""}`),
    request_id: requestId,
    business_unit: snake(envelope.business_unit || "corporate") || "corporate",
    inquiry_type: snake(envelope.inquiry_type || "general_enquiry") || "general_enquiry",
    lead_ref_available_to_office_only: Boolean(lead.id),
    suggested_prompt: "I have received your request. Would you like me to explain what happens next?",
  };
}

function createHumanHandoffTask(input = {}) {
  const session = input.session || {};
  return {
    type: "human_handoff_requested",
    status: "task_created",
    business_unit: session.business_unit || "corporate",
    inquiry_type: session.inquiry_type || "general_enquiry",
    public_session_id: session.session_id || "",
    lead_id: input.lead_id || "",
    title: input.title || "Public intelligence handoff requested",
    next_action: input.next_action || "Assign an Office owner and continue from the existing customer context.",
    metadata: {
      agent_role: session.active_agent_role || "oma",
      source_site: session.source && session.source.source_site,
      source_page: session.source && session.source.source_page,
    },
  };
}

function decideProactiveEngagement(input = {}) {
  if (input.dismissed || input.previous_dismissal_at) {
    return { eligible: false, state: "cooldown", reason: "visitor_dismissed_recently", prompt: "" };
  }
  const depth = Number(input.interaction_depth || 0);
  const duration = Number(input.session_duration_ms || 0);
  const routing = routeBusinessContext(input);
  if (depth >= 2 || duration >= 90_000 || input.form_state === "paused") {
    return {
      eligible: true,
      state: "eligible",
      reason: input.form_state === "paused" ? "paused_form" : "meaningful_session_signal",
      business_unit: routing.business_unit,
      prompt: "Would you like help choosing the right Ochiga path for this?",
    };
  }
  return { eligible: false, state: "disabled", reason: "insufficient_session_signal", prompt: "" };
}

module.exports = {
  ALLOWED_CAPABILITIES,
  BLOCKED_ACTIONS,
  BLOCKED_OPERATIONAL_DOMAINS,
  BUSINESS_UNITS,
  CONTRACT_VERSION,
  PUBLIC_IDENTITY,
  buildOyiCoreCorporateRequest,
  buildPublicIntelligenceSession,
  createFormContinuationContext,
  createHumanHandoffTask,
  decideProactiveEngagement,
  detectBlockedPublicOperationalRequest,
  publicContextRef,
  publicSessionId,
  routeBusinessContext,
  selectAgentRole,
};
