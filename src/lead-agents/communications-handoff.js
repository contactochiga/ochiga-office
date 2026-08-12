const crypto = require("crypto");

const DEFAULT_CAPABILITIES = Object.freeze([
  { business_unit: "development", capability: "development.architecture", specialty: "architecture" },
  { business_unit: "development", capability: "development.engineering", specialty: "engineering" },
  { business_unit: "development", capability: "development.commercial_jv", specialty: "commercial_jv" },
  { business_unit: "technology", capability: "technology.oyi_deployment", specialty: "oyi_deployment" },
  { business_unit: "technology", capability: "technology.integration", specialty: "integration" },
  { business_unit: "technology", capability: "technology.technical", specialty: "technical" },
  { business_unit: "private", capability: "private.relationship", specialty: "relationship" },
  { business_unit: "partnerships", capability: "partnerships.routing", specialty: "partnerships" },
  { business_unit: "support", capability: "support.technical", specialty: "technical_support" },
  { business_unit: "corporate", capability: "corporate.office_desk", specialty: "office_desk" },
]);

function text(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function lower(value) {
  return text(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeStaffCapability(input = {}) {
  return {
    staff_id: text(input.staff_id || input.staffId || input.user_id || input.id),
    business_unit: lower(input.business_unit || input.businessUnit || "corporate"),
    capability: lower(input.capability || input.skill || "corporate.office_desk").replace(/[^a-z0-9_.-]+/g, "_"),
    specialty: lower(input.specialty || ""),
    availability: lower(input.availability || "offline"),
    routing_priority: Number.isFinite(Number(input.routing_priority ?? input.priority)) ? Number(input.routing_priority ?? input.priority) : 50,
    active: input.active !== false,
    active_session_count: Number.isFinite(Number(input.active_session_count)) ? Number(input.active_session_count) : 0,
    relationship_owner_for: Array.isArray(input.relationship_owner_for) ? input.relationship_owner_for.map(text).filter(Boolean) : [],
    permissions: Array.isArray(input.permissions) ? input.permissions.map(text).filter(Boolean) : [],
    last_seen_at: text(input.last_seen_at || input.lastSeenAt),
  };
}

function capabilityCatalog(extra = []) {
  return [...DEFAULT_CAPABILITIES, ...extra.map(normalizeStaffCapability).filter((item) => item.capability)];
}

function canJoinCommunications(staff) {
  return staff.active
    && staff.availability === "available"
    && (staff.permissions.includes("communications.join")
      || staff.permissions.includes("office.manage")
      || staff.permissions.includes("support.assign"));
}

function capabilityMatches(staff, request = {}) {
  const requested = lower(request.requested_capability || request.requestedCapability || "corporate.office_desk");
  const businessUnit = lower(request.business_unit || request.businessUnit || "corporate");
  return staff.business_unit === businessUnit && (staff.capability === requested || staff.capability.startsWith(`${businessUnit}.`));
}

function chooseStaffForHandoff({ staffCapabilities = [], handoff = {}, existingOwnerId = "" } = {}) {
  const normalized = staffCapabilities.map(normalizeStaffCapability).filter(canJoinCommunications);
  const matched = normalized.filter((staff) => capabilityMatches(staff, handoff));
  const ownerMatch = matched.find((staff) => existingOwnerId && staff.staff_id === existingOwnerId);
  if (ownerMatch) return { status: "matched", staff: ownerMatch, reason: "existing_relationship_owner_available" };
  const [best] = matched.sort((a, b) => {
    if (a.active_session_count !== b.active_session_count) return a.active_session_count - b.active_session_count;
    return a.routing_priority - b.routing_priority;
  });
  if (best) return { status: "matched", staff: best, reason: "capability_availability_priority" };
  return { status: "unavailable", staff: null, reason: "no_available_authorized_capability_match" };
}

function buildStaffJoinBrief({ session = {}, handoff = {}, lead = {}, summary = "" } = {}) {
  return {
    public_session_id: text(session.public_session_id || session.session_id),
    communications_session_id: text(session.communications_session_id || session.session_id),
    oyi_thread_id: text(session.oyi_thread_id || session.conversation_thread_id),
    business_unit: lower(handoff.business_unit || session.business_unit || "corporate"),
    requested_capability: lower(handoff.requested_capability || "corporate.office_desk"),
    reason: text(handoff.reason, "Human assistance requested."),
    customer_context: {
      visitor_known: Boolean(lead.id || session.crm_contact_ref),
      lead_id: text(lead.id),
      organization: text(lead.company || lead.organization),
      safe_summary: text(summary || lead.summary || lead.next_action).slice(0, 1000),
    },
    recommended_next_step: text(handoff.next_action || "Join the session, confirm context, and continue from Oyi's summary."),
  };
}

async function recordHandoffTimeline({ store, lead, session = {}, handoff = {}, eventType, staffId = "", note = "" } = {}) {
  if (!store?.appendTimelineEvent || !lead?.id) return null;
  return store.appendTimelineEvent({
    lead_id: lead.id,
    event_type: eventType,
    actor: staffId || "ochiga_intelligence",
    title: eventType.replace(/_/g, " "),
    body: text(note || handoff.reason || "Communications handoff event recorded."),
    metadata: {
      communications_session_id: text(session.communications_session_id || session.session_id),
      public_session_id: text(session.public_session_id || session.session_id),
      oyi_thread_id: text(session.oyi_thread_id || session.conversation_thread_id),
      handoff_id: text(handoff.handoff_id || handoff.id),
      business_unit: lower(handoff.business_unit || session.business_unit || "corporate"),
      requested_capability: lower(handoff.requested_capability || ""),
      staff_id: text(staffId),
    },
  });
}

async function createCallbackTask({ store, lead, handoff = {}, session = {} } = {}) {
  if (!store?.state) return null;
  const task = {
    id: crypto.randomUUID(),
    lead_id: lead?.id || "",
    title: "Callback requested from public communications session",
    status: "open",
    priority: handoff.priority || "normal",
    owner: "office_desk",
    assignee: "",
    related_type: "communications_handoff",
    related_id: handoff.handoff_id || handoff.id || "",
    due_at: null,
    metadata: {
      communications_session_id: session.communications_session_id || session.session_id || "",
      public_session_id: session.public_session_id || session.session_id || "",
      requested_capability: handoff.requested_capability || "",
      fallback_action: "request_callback",
    },
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  store.state.crm_tasks = Array.isArray(store.state.crm_tasks) ? store.state.crm_tasks : [];
  store.state.crm_tasks.push(task);
  if (store.persist) await store.persist();
  return task;
}

function canViewHandoffQueue(authContext = {}, queueSurface = "office_public") {
  const permissions = Array.isArray(authContext.permissions) ? authContext.permissions : [];
  if (queueSurface === "support") return permissions.includes("support.read") || permissions.includes("support.assign");
  return permissions.includes("office.read") || permissions.includes("office.manage");
}

module.exports = {
  DEFAULT_CAPABILITIES,
  capabilityCatalog,
  normalizeStaffCapability,
  chooseStaffForHandoff,
  buildStaffJoinBrief,
  recordHandoffTimeline,
  createCallbackTask,
  canViewHandoffQueue,
};
