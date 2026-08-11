/**
 * Transitional Office intelligence registry.
 *
 * Ochiga Backend is the intended long-term owner of canonical Oyi Core
 * intelligence. This file remains in the hybrid Office/Edge repo only for
 * compatibility with existing Office workflows while backend integration is
 * completed. Do not expand this local intelligence surface with new runtime
 * ownership; route future reasoning, awareness, and execution logic toward the
 * backend-owned Oyi Core instead.
 */
const CORE_ID = "ochiga_intelligence_core";

const MEMORY_SCOPES = Object.freeze([
  "user",
  "home",
  "estate",
  "facility",
  "office",
  "lead",
  "camera",
  "edge",
  "employee",
  "team",
  "department",
  "company",
  "system",
]);

const EVENT_CATEGORIES = Object.freeze([
  "operational",
  "security",
  "maintenance",
  "visitor",
  "community",
  "marketing",
  "sales",
  "camera",
  "edge",
  "system",
]);

const MEMORY_DIRECTORY = Object.freeze([
  {
    scope: "resident",
    agents: ["oyi", "watch"],
    storage: ["resident_memory", "home_timeline", "ochiga_intelligence_events"],
    boundary: "Resident memory remains scoped to the resident and active home and is never merged into office memory.",
    visibility: "private",
  },
  {
    scope: "lead",
    agents: ["oma", "osa"],
    storage: ["lead memory", "office CRM memory", "ochiga_intelligence_events"],
    boundary: "Lead and office memory must not include resident-private home data unless explicitly permissioned.",
    visibility: "scoped",
  },
  {
    scope: "office",
    agents: ["oma", "osa"],
    storage: ["office operations memory", "conversation memory", "ochiga_intelligence_events"],
    boundary: "Office memory is commercial/workflow context and stays separate from Oyi resident memory.",
    visibility: "scoped",
  },
  {
    scope: "estate",
    agents: ["oyi", "facility", "camera", "edge"],
    storage: ["home_timeline", "device_events", "camera_events", "ochiga_intelligence_events"],
    boundary: "Estate memory is operational and permission-scoped; private home details require explicit access.",
    visibility: "scoped",
  },
  {
    scope: "facility",
    agents: ["facility"],
    storage: ["facility operations", "maintenance", "visitors", "ochiga_intelligence_events"],
    boundary: "Facility memory supports estate operations by role permission only.",
    visibility: "scoped",
  },
  {
    scope: "camera",
    agents: ["camera", "edge"],
    storage: ["camera registry", "camera AI detections", "camera_events", "ochiga_intelligence_events"],
    boundary: "Camera events must respect camera access policy and must never expose credentials or private streams.",
    visibility: "scoped",
  },
  {
    scope: "edge",
    agents: ["edge", "camera"],
    storage: ["edge runtime health", "go2rtc health", "stream health", "ochiga_intelligence_events"],
    boundary: "Edge memory is runtime-only and must not print or store DVR credentials in shared events.",
    visibility: "system",
  },
  {
    scope: "employee",
    agents: ["ochiga_executive"],
    storage: ["ochiga_organization_employees", "ochiga_agent_observability"],
    boundary: "Employee memory is organizational only and never includes resident-private memory or raw CRM notes.",
    visibility: "scoped",
  },
  {
    scope: "team",
    agents: ["ochiga_executive"],
    storage: ["ochiga_organization_teams", "ochiga_agent_collaborations"],
    boundary: "Team memory is responsibility and workflow context only.",
    visibility: "scoped",
  },
  {
    scope: "department",
    agents: ["ochiga_executive"],
    storage: ["ochiga_organization_departments", "ochiga_organization_responsibilities"],
    boundary: "Department memory coordinates work without merging home, estate, resident, or lead memory.",
    visibility: "scoped",
  },
  {
    scope: "company",
    agents: ["ochiga_executive"],
    storage: ["ochiga_intelligence_events", "ochiga_intelligence_predictions", "ochiga_agent_collaborations"],
    boundary: "Company memory is summarized cross-system intelligence only.",
    visibility: "scoped",
  },
]);

const INTELLIGENCE_ROLES = Object.freeze([
  "resident",
  "facility_manager",
  "security_operator",
  "estate_admin",
  "ochiga_admin",
  "super_admin",
  "oma",
  "osa",
  "ochiga_executive",
]);

const ORGANIZATION_SCOPES = Object.freeze(["employee", "team", "department", "company"]);

const SUMMARY_TYPES = Object.freeze(["consumer", "facility", "office", "watch", "camera", "edge"]);

const PREDICTION_TYPES = Object.freeze([
  "device_anomaly",
  "camera_anomaly",
  "maintenance_risk",
  "security_risk",
  "visitor_pattern",
  "power_or_network_instability",
  "edge_runtime_risk",
  "operational_recommendation",
]);

const WORKFLOW_STATUSES = Object.freeze([
  "created",
  "reviewed",
  "assigned",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
  "escalated",
]);

const WORKFLOW_PRIORITIES = Object.freeze(["low", "medium", "high", "critical"]);

const WORKFLOW_TYPES = Object.freeze([
  "customer_converted",
  "proposal_accepted",
  "meeting_requested",
  "deployment_required",
  "customer_onboarding",
  "edge_required",
  "camera_runtime_required",
  "camera_validation_required",
  "security_event_detected",
  "camera_offline",
  "camera_tamper",
  "prediction_requires_attention",
  "resident_status_changed",
]);

const WORKFLOW_CONTRACTS = Object.freeze([
  { workflow_type: "customer_converted", origin_agent: "oma", responsible_agent: "osa" },
  { workflow_type: "proposal_accepted", origin_agent: "oma", responsible_agent: "osa" },
  { workflow_type: "meeting_requested", origin_agent: "oma", responsible_agent: "osa" },
  { workflow_type: "deployment_required", origin_agent: "osa", responsible_agent: "facility" },
  { workflow_type: "customer_onboarding", origin_agent: "osa", responsible_agent: "facility" },
  { workflow_type: "edge_required", origin_agent: "facility", responsible_agent: "edge" },
  { workflow_type: "camera_runtime_required", origin_agent: "facility", responsible_agent: "edge" },
  { workflow_type: "camera_validation_required", origin_agent: "facility", responsible_agent: "camera" },
  { workflow_type: "security_event_detected", origin_agent: "camera", responsible_agent: "facility" },
  { workflow_type: "camera_offline", origin_agent: "camera", responsible_agent: "facility" },
  { workflow_type: "camera_tamper", origin_agent: "camera", responsible_agent: "facility" },
  { workflow_type: "prediction_requires_attention", origin_agent: "ochiga_executive", responsible_agent: "ochiga_executive" },
  { workflow_type: "resident_status_changed", origin_agent: "watch", responsible_agent: "oyi" },
]);

const AGENT_RESPONSIBILITIES = Object.freeze([
  { agent_id: "oyi", responsibility: "Resident-facing home intelligence and approved resident guidance" },
  { agent_id: "facility", responsibility: "Estate operations, deployments, residents, maintenance, visitors, and facility review" },
  { agent_id: "oma", responsibility: "Marketing qualification, lead capture, and handoff recommendations" },
  { agent_id: "osa", responsibility: "Sales follow-up, proposal/demo workflow tracking, and deployment handoff" },
  { agent_id: "camera", responsibility: "Camera event interpretation, validation needs, and security signal handoff" },
  { agent_id: "edge", responsibility: "Local runtime, Edge health, stream health, and camera/DVR runtime support" },
  { agent_id: "watch", responsibility: "Compact resident awareness and Watch-to-Oyi status handoff" },
  { agent_id: "ochiga_executive", responsibility: "Executive summaries, workflow oversight, escalations, and recommended focus areas" },
]);

const WORKFLOW_ALLOWED_ACTIONS = Object.freeze(["create_workflows", "assign_workflows", "track_workflows", "escalate_workflows", "recommend_actions"]);
const WORKFLOW_FORBIDDEN_ACTIONS = Object.freeze(["control_devices", "approve_payments", "create_visitors", "modify_wallets", "modify_permissions", "modify_access_control"]);

const COLLABORATION_RULES = Object.freeze([
  {
    id: "oma_osa_customer_converted",
    from: "oma",
    to: "osa",
    trigger: "customer_converted",
    purpose: "OMA qualifies or converts a lead; OSA owns sales follow-up and commercial handoff.",
    enabled: true,
  },
  {
    id: "osa_facility_deployment_required",
    from: "osa",
    to: "facility",
    trigger: "deployment_required",
    purpose: "OSA identifies a customer/deployment need; Facility prepares operational onboarding context.",
    enabled: true,
  },
  {
    id: "facility_edge_camera_runtime_required",
    from: "facility",
    to: "edge",
    trigger: "camera_runtime_required",
    purpose: "Facility needs local Edge runtime support for camera/DVR streaming or health checks.",
    enabled: true,
  },
  {
    id: "camera_facility_security_event_detected",
    from: "camera",
    to: "facility",
    trigger: "security_event_detected",
    purpose: "Camera agent reports a security-relevant event; Facility reviews and decides operational response.",
    enabled: true,
  },
  {
    id: "watch_oyi_resident_status_changed",
    from: "watch",
    to: "oyi",
    trigger: "resident_status_changed",
    purpose: "Watch sends compact resident/home status change; Oyi owns resident-facing explanation.",
    enabled: true,
  },
  {
    id: "edge_camera_stream_restored",
    from: "edge",
    to: "camera",
    trigger: "stream_restored",
    purpose: "Edge reports restored stream health; Camera agent updates camera readiness context.",
    enabled: true,
  },
  {
    id: "prediction_executive_high_priority_prediction",
    from: "facility",
    to: "ochiga_executive",
    trigger: "high_priority_prediction",
    purpose: "Prediction engine exposes high-priority risk summaries to Executive Intelligence without raw private memory.",
    enabled: true,
  },
  {
    id: "camera_facility_oyi",
    from: "camera",
    to: "facility",
    trigger: "camera security/attention event",
    purpose: "Facility reviews camera events and escalates resident-visible impacts to Oyi when appropriate.",
    enabled: true,
  },
  {
    id: "oma_osa",
    from: "oma",
    to: "osa",
    trigger: "qualified marketing lead",
    purpose: "OMA qualifies inbound interest; OSA handles sales follow-up and demo/proposal workflow.",
    enabled: true,
  },
  {
    id: "facility_edge",
    from: "facility",
    to: "edge",
    trigger: "stream/device runtime issue",
    purpose: "Facility requests Edge runtime diagnostics for local camera/device problems.",
    enabled: true,
  },
  {
    id: "watch_oyi",
    from: "watch",
    to: "oyi",
    trigger: "compact wrist awareness or action",
    purpose: "Watch surfaces compact status while Oyi owns resident-facing home context.",
    enabled: true,
  },
]);

function normalizeRole(role) {
  const raw = String(role || "resident").trim().toLowerCase();
  if (INTELLIGENCE_ROLES.includes(raw)) return raw;
  if (raw === "manager") return "facility_manager";
  if (raw === "security") return "security_operator";
  if (raw === "admin" || raw === "system_admin") return "super_admin";
  if (raw === "owner") return "estate_admin";
  return "resident";
}

function getRolePolicy(roleInput) {
  const role = normalizeRole(roleInput);
  if (role === "super_admin" || role === "ochiga_admin") {
    return { role, categories: EVENT_CATEGORIES, agents: AGENTS.map((agent) => agent.id), scope: role === "super_admin" ? "system" : "office" };
  }
  if (role === "oma") return { role, categories: ["marketing", "sales", "system"], agents: ["oma", "osa"], scope: "office" };
  if (role === "osa") return { role, categories: ["sales", "marketing", "system"], agents: ["osa", "oma"], scope: "office" };
  if (role === "security_operator") return { role, categories: ["security", "visitor", "camera", "edge", "system"], agents: ["facility", "edge", "camera"], scope: "estate" };
  if (role === "facility_manager" || role === "estate_admin") {
    return { role, categories: ["operational", "security", "maintenance", "visitor", "community", "camera", "edge", "system"], agents: ["oyi", "facility", "edge", "camera", "watch", "ochiga_executive"], scope: "estate" };
  }
  return { role: "resident", categories: ["operational", "security", "maintenance", "visitor", "community", "system"], agents: ["oyi", "watch"], scope: "home" };
}

function createHealthSnapshot() {
  const checks = [
    AGENTS.length >= 7,
    TOOL_REGISTRY.length > 0,
    MEMORY_DIRECTORY.length >= 7,
    EVENT_CATEGORIES.length >= 10,
    COLLABORATION_RULES.every((rule) => rule.enabled),
    WORKFLOW_CONTRACTS.length >= 10,
  ];
  const readiness = Math.round((checks.filter(Boolean).length / checks.length) * 100);
  return {
    ok: readiness >= 80,
    core_id: CORE_ID,
    readiness_score: readiness,
    agents: AGENTS.length,
    tools: TOOL_REGISTRY.length,
    memory_directory: MEMORY_DIRECTORY.length,
    collaboration_rules: COLLABORATION_RULES.length,
    prediction_contracts: PREDICTION_TYPES.length,
    workflow_contracts: WORKFLOW_CONTRACTS.length,
  };
}

const AGENTS = Object.freeze([
  {
    id: "oyi",
    name: "Oyi Intelligence",
    domain: "resident home and estate operations",
    allowed_surfaces: ["consumer", "watch", "api"],
    tools: ["oyi:*"],
    memory_scope: ["user", "home", "estate"],
    risk_level: "medium",
    default_response_tone: "calm resident-facing home assistant",
  },
  {
    id: "oma",
    name: "Ochiga Marketing Agent",
    domain: "marketing qualification and lead capture",
    allowed_surfaces: ["office", "website", "widget", "whatsapp", "api"],
    tools: ["office:create_lead", "office:get_solution_fit", "office:notify_founder"],
    memory_scope: ["office", "lead"],
    risk_level: "medium",
    default_response_tone: "commercial, helpful, non-overclaiming",
  },
  {
    id: "osa",
    name: "Ochiga Sales Agent",
    domain: "sales follow-up, demos, proposals, and handoff",
    allowed_surfaces: ["office", "website", "widget", "whatsapp", "api"],
    tools: ["office:update_lead_status", "office:schedule_demo", "office:notify_founder"],
    memory_scope: ["office", "lead"],
    risk_level: "medium",
    default_response_tone: "commercial, precise, conversion-aware",
  },
  {
    id: "facility",
    name: "Facility Intelligence",
    domain: "estate and facility operations",
    allowed_surfaces: ["facility", "api"],
    tools: ["oyi:read", "facility:*", "camera:read"],
    memory_scope: ["facility", "estate", "system"],
    risk_level: "high",
    default_response_tone: "operational, concise, permission-aware",
  },
  {
    id: "edge",
    name: "Edge Intelligence",
    domain: "local runtime, physical devices, and camera edge health",
    allowed_surfaces: ["edge", "api"],
    tools: ["edge:health", "edge:camera_registry", "edge:stream_health"],
    memory_scope: ["edge", "camera", "system"],
    risk_level: "high",
    default_response_tone: "diagnostic, safe, local-runtime aware",
  },
  {
    id: "camera",
    name: "Camera Intelligence",
    domain: "camera events, stream health, and future detections",
    allowed_surfaces: ["facility", "camera", "edge", "api"],
    tools: ["camera:read", "camera:event_ingest", "camera:profile"],
    memory_scope: ["camera", "estate", "facility"],
    risk_level: "high",
    default_response_tone: "security-aware, factual, no fabricated detections",
  },
  {
    id: "watch",
    name: "Watch Intelligence",
    domain: "wrist awareness, quick actions, and home status",
    allowed_surfaces: ["watch", "consumer", "api"],
    tools: ["watch:summary", "watch:quick_actions", "oyi:scene"],
    memory_scope: ["user", "home"],
    risk_level: "medium",
    default_response_tone: "glanceable, compact, resident-safe",
  },
  {
    id: "ochiga_executive",
    name: "Ochiga Executive Intelligence",
    domain: "cross-system executive awareness and agent orchestration",
    allowed_surfaces: ["office", "api"],
    tools: ["intelligence:summary", "intelligence:predictions", "intelligence:collaboration", "intelligence:observability"],
    memory_scope: ["company", "department", "team", "system"],
    risk_level: "high",
    default_response_tone: "executive, concise, cross-functional, boundary-aware",
  },
  {
    id: "twin",
    name: "Digital Twin Intelligence",
    domain: "future digital twin understanding",
    allowed_surfaces: ["facility", "office", "api"],
    tools: [],
    memory_scope: ["estate", "facility", "system"],
    risk_level: "high",
    default_response_tone: "spatial, operational, evidence-based",
  },
  {
    id: "plan_studio",
    name: "Plan Studio Intelligence",
    domain: "future planning and design workflows",
    allowed_surfaces: ["office", "api"],
    tools: [],
    memory_scope: ["office", "system"],
    risk_level: "medium",
    default_response_tone: "planning-focused and structured",
  },
]);

const OFFICE_TOOLS = Object.freeze([
  {
    id: "office:create_lead",
    source: "office",
    description: "Create or update a lead record from a marketing conversation.",
    categories: ["write", "marketing", "external"],
    required_permissions: ["crm.manage"],
    confirmation_required: false,
    enabled: true,
    risk_level: "medium",
    allowed_agents: ["oma"],
  },
  {
    id: "office:update_lead_status",
    source: "office",
    description: "Update lead routing, status, score, and next action.",
    categories: ["write", "sales"],
    required_permissions: ["crm.manage"],
    confirmation_required: false,
    enabled: true,
    risk_level: "medium",
    allowed_agents: ["oma", "osa"],
  },
  {
    id: "office:get_solution_fit",
    source: "office",
    description: "Score fit for Ochiga/Oyi solutions from lead context.",
    categories: ["read", "marketing", "sales"],
    required_permissions: ["office.read"],
    confirmation_required: false,
    enabled: true,
    risk_level: "low",
    allowed_agents: ["oma", "osa"],
  },
  {
    id: "office:schedule_demo",
    source: "office",
    description: "Record a requested demo and prepare calendar links.",
    categories: ["write", "sales", "external"],
    required_permissions: ["crm.manage"],
    confirmation_required: false,
    enabled: true,
    risk_level: "medium",
    allowed_agents: ["osa"],
  },
  {
    id: "office:notify_founder",
    source: "office",
    description: "Escalate a commercial lead to the founder/human owner.",
    categories: ["action", "sales", "external"],
    required_permissions: ["office.manage"],
    confirmation_required: false,
    enabled: true,
    risk_level: "medium",
    allowed_agents: ["oma", "osa"],
  },
]);

const EDGE_TOOLS = Object.freeze([
  {
    id: "edge:health",
    source: "edge",
    description: "Read Edge runtime, backend, and go2rtc health.",
    categories: ["read", "edge"],
    required_permissions: ["devices.read"],
    confirmation_required: false,
    enabled: true,
    risk_level: "low",
    allowed_agents: ["edge", "camera"],
  },
  {
    id: "edge:camera_registry",
    source: "edge",
    description: "Read camera registry contracts and generated stream mappings.",
    categories: ["read", "edge", "camera"],
    required_permissions: ["cameras.view"],
    confirmation_required: false,
    enabled: true,
    risk_level: "low",
    allowed_agents: ["edge", "camera"],
  },
  {
    id: "camera:event_ingest",
    source: "edge",
    description: "Submit verified camera events from Edge to backend camera event ingestion.",
    categories: ["write", "camera", "edge"],
    required_permissions: ["cameras.view"],
    confirmation_required: false,
    enabled: true,
    risk_level: "high",
    allowed_agents: ["edge", "camera"],
  },
]);

const TOOL_REGISTRY = Object.freeze([...OFFICE_TOOLS, ...EDGE_TOOLS]);

function getAgent(id) {
  return AGENTS.find((agent) => agent.id === id) || null;
}

function getToolsForAgent(agentId) {
  return TOOL_REGISTRY.filter((tool) => tool.allowed_agents.includes(agentId));
}

function normalizeEvent(input = {}) {
  const category = String(input.category || "operational").toLowerCase();
  return {
    id: input.id || undefined,
    actor_id: input.actor_id || input.actorId || null,
    agent_id: input.agent_id || input.agentId || "edge",
    surface: input.surface || "edge",
    estate_id: input.estate_id || input.estateId || null,
    home_id: input.home_id || input.homeId || null,
    office_id: input.office_id || input.officeId || null,
    camera_id: input.camera_id || input.cameraId || null,
    event_type: input.event_type || input.eventType || "intelligence.event",
    category: EVENT_CATEGORIES.includes(category) ? category : "operational",
    title: String(input.title || "Intelligence update").slice(0, 180),
    summary: String(input.summary || input.title || "Intelligence update").slice(0, 500),
    confidence: input.confidence || "confirmed",
    source: input.source || input.agent_id || "edge",
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
    occurred_at: input.occurred_at || input.occurredAt || new Date().toISOString(),
  };
}

function createAdapter(agentId) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Unknown intelligence agent: ${agentId}`);
  return {
    agent,
    getContext(input = {}) {
      return {
        core_id: CORE_ID,
        agent_id: agent.id,
        surface: input.surface || agent.allowed_surfaces[0] || "api",
        actor_id: input.actor_id || null,
        user_id: input.user_id || null,
        estate_id: input.estate_id || null,
        home_id: input.home_id || null,
        office_id: input.office_id || null,
        lead_id: input.lead_id || null,
        camera_id: input.camera_id || null,
        edge_node_id: input.edge_node_id || null,
        permissions: Array.isArray(input.permissions) ? input.permissions : [],
        metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
      };
    },
    getAllowedTools(context = {}) {
      const permissions = new Set(context.permissions || []);
      return getToolsForAgent(agent.id).filter((tool) =>
        tool.required_permissions.every((permission) => permissions.has(permission))
      );
    },
    writeMemory() {
      return { ok: false, skipped: true, reason: "phase1_contract_only_memory_adapter" };
    },
    writeTimelineEvent(_context, event) {
      return { ok: true, event: normalizeEvent({ ...event, agent_id: agent.id }) };
    },
    formatResponse(_context, response = {}) {
      return {
        message: response.message || "",
        ...response,
        metadata: {
          ...(response.metadata || {}),
          core_id: CORE_ID,
          agent_id: agent.id,
        },
      };
    },
  };
}

module.exports = {
  CORE_ID,
  MEMORY_SCOPES,
  ORGANIZATION_SCOPES,
  EVENT_CATEGORIES,
  MEMORY_DIRECTORY,
  INTELLIGENCE_ROLES,
  SUMMARY_TYPES,
  PREDICTION_TYPES,
  WORKFLOW_STATUSES,
  WORKFLOW_PRIORITIES,
  WORKFLOW_TYPES,
  WORKFLOW_CONTRACTS,
  AGENT_RESPONSIBILITIES,
  WORKFLOW_ALLOWED_ACTIONS,
  WORKFLOW_FORBIDDEN_ACTIONS,
  COLLABORATION_RULES,
  AGENTS,
  OFFICE_TOOLS,
  EDGE_TOOLS,
  TOOL_REGISTRY,
  createAdapter,
  getAgent,
  getToolsForAgent,
  normalizeRole,
  getRolePolicy,
  createHealthSnapshot,
  normalizeEvent,
};
