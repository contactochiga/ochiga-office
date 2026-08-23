const axios = require("axios");
const { hasPermission } = require("./permissions");
const { listCorporateRecords } = require("./office-operating-system");
const { fetchBackendFinancialSummary } = require("./backend-financial-gateway");

function text(value) {
  return String(value ?? "").trim();
}

function recordOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// Oyi Core (Ochiga-backend) has no direct connection to Office's CRM/
// reports/development store — it's a separate Supabase project from
// Consumer/Facility's. Office computes this compact, permission-gated
// read itself (reusing its own existing store functions and the same
// hasPermission() check every CRM/Reports/Development route already
// uses) and attaches it to the outbound request; Oyi Core's office
// capability modules only ever read evidence from this snapshot. A
// null section means "actor lacks that permission or the store call
// failed" — reported honestly as unavailable, never fabricated.
const OPEN_LEAD_STATUS_EXCLUDE = /closed|won|lost|converted|declined|rejected|disqualified/i;
const OPEN_RECORD_STATUS_EXCLUDE = /closed|won|lost|declined|rejected/i;
const STALE_LEAD_DAYS = 5;
const STALE_OPPORTUNITY_DAYS = 7;
const SNAPSHOT_LIST_LIMIT = 20;

function daysSince(isoValue) {
  const parsed = isoValue ? Date.parse(isoValue) : NaN;
  if (Number.isNaN(parsed)) return null;
  return Math.floor((Date.now() - parsed) / 86_400_000);
}

function leadAttentionReason(lead) {
  const nextActionAt = lead.next_action_at ? Date.parse(lead.next_action_at) : NaN;
  if (!Number.isNaN(nextActionAt) && nextActionAt <= Date.now()) {
    return `Next action overdue since ${new Date(nextActionAt).toISOString().slice(0, 10)}`;
  }
  const since = daysSince(lead.last_contact_at || lead.updated_at);
  if (since === null) return "No recorded contact yet";
  if (since >= STALE_LEAD_DAYS) return `No activity in ${since} day${since === 1 ? "" : "s"}`;
  return null;
}

async function buildLeadsSnapshot(store) {
  const leads = Array.isArray(await store.listLeads()) ? await store.listLeads() : [];
  const open = leads.filter((lead) => !OPEN_LEAD_STATUS_EXCLUDE.test(text(lead.status)));
  const needingAttention = [];
  for (const lead of open) {
    const reason = leadAttentionReason(lead);
    if (!reason) continue;
    needingAttention.push({
      id: text(lead.id),
      name: text(lead.summary || lead.company_name || lead.next_action || `Lead ${text(lead.id)}`),
      status: text(lead.status || "new"),
      reason,
      last_activity_at: lead.last_contact_at || lead.updated_at || null,
    });
  }
  return { needing_attention: needingAttention.slice(0, SNAPSHOT_LIST_LIMIT), total_open: open.length };
}

async function buildOpportunitiesSnapshot(store) {
  const opportunities = await listCorporateRecords(store, "opportunities");
  const open = (Array.isArray(opportunities) ? opportunities : []).filter(
    (record) => !OPEN_RECORD_STATUS_EXCLUDE.test(text(record.status))
  );
  const stale = [];
  for (const record of open) {
    const since = daysSince(record.updated_at || record.created_at);
    if (since !== null && since < STALE_OPPORTUNITY_DAYS) continue;
    const metadata = recordOf(record.metadata);
    stale.push({
      id: text(record.id),
      name: text(metadata.name || metadata.title || record.inquiry_type || `Opportunity ${text(record.id)}`),
      stage: text(record.stage || record.status || "unknown"),
      days_since_activity: since,
      owner: text(record.owner) || null,
    });
  }
  return { stale: stale.slice(0, SNAPSHOT_LIST_LIMIT), total_open: open.length };
}

// Phase 4, PR 2 (Oyi Conversational Runtime Completion Programme) —
// mirrors buildOpportunitiesSnapshot's shape exactly: same
// listCorporateRecords() accessor, same "open" filtering-then-cap
// pattern, field names matching taskOyiContext() (office.js) so a task
// looks the same whether it arrived via the single-record task_context
// slot or this list snapshot.
const OPEN_TASK_STATUS_EXCLUDE = /done|completed|cancelled/i;

function taskIsOverdue(record) {
  if (!record.due_at || record.completed_at) return false;
  if (OPEN_TASK_STATUS_EXCLUDE.test(text(record.status))) return false;
  const due = Date.parse(record.due_at);
  return !Number.isNaN(due) && due < Date.now();
}

async function buildTasksSnapshot(store) {
  const tasks = await listCorporateRecords(store, "tasks");
  const open = (Array.isArray(tasks) ? tasks : []).filter(
    (record) => !OPEN_TASK_STATUS_EXCLUDE.test(text(record.status))
  );
  const rows = open.slice(0, SNAPSHOT_LIST_LIMIT).map((record) => ({
    id: text(record.id),
    title: text(record.title) || `Task ${text(record.id)}`,
    status: text(record.status || "open"),
    priority: text(record.priority) || null,
    owner: text(record.assignee) || null,
    due_at: record.due_at || null,
    overdue: taskIsOverdue(record),
  }));
  return { open: rows, total_open: open.length };
}

async function buildReportsSnapshot(store) {
  const pending = await store.listOfficeReports({ status: "submitted" });
  return {
    pending_approval: (Array.isArray(pending) ? pending : []).slice(0, SNAPSHOT_LIST_LIMIT).map((report) => ({
      id: text(report.id),
      title: text(report.title || `Report ${text(report.id)}`),
      submitted_by: text(report.author) || null,
      submitted_at: report.created_at || null,
    })),
  };
}

// Development Management has no percent/units-sold fields — only a free-
// text status plus a stage stepper (status_stages/status_active_index).
// percent_complete is honestly derived from that stepper position rather
// than fabricated; units_sold/units_total stay null since no such data
// exists in this store (Part 7/10: derive honestly or leave unsupported).
function percentFromStageStepper(project) {
  const stages = Array.isArray(project.status_stages) ? project.status_stages : [];
  const index = Number(project.status_active_index);
  if (stages.length < 2 || !Number.isFinite(index)) return null;
  return Math.round((index / (stages.length - 1)) * 100);
}

async function buildDevelopmentSnapshot(store) {
  const projects = await store.listDevelopmentProjects();
  return {
    projects: (Array.isArray(projects) ? projects : []).map((project) => ({
      id: text(project.id),
      name: text(project.name),
      status: text(project.status) || text((project.status_stages || [])[project.status_active_index]) || "unknown",
      percent_complete: percentFromStageStepper(project),
      units_sold: null,
      units_total: null,
    })),
  };
}

// Unlike leads/opportunities/reports/development (Office's own store),
// the financial section is sourced live from Ochiga-backend's canonical
// aggregation contract (GET /office/financial-summary) via the same
// backend-financial-gateway used by the Financial Summary REST route —
// there is no separate/second financial computation here.
async function buildFinancialSnapshot(config) {
  const result = await fetchBackendFinancialSummary(config || {});
  if (!result.ok) return null;
  return {
    generated_at: result.generated_at,
    period_start: result.period_start,
    period_end: result.period_end,
    portfolio: result.portfolio,
    estates: result.estates,
  };
}

// Oyi Office Conversational Runtime, Milestone 2 — five more list
// aggregates, same "compute here, forward as evidence, never let
// Backend touch Office's own store" architecture as tasks/leads/
// opportunities above. Field selection mirrors FIELD_POLICY in
// office-operational-workflows.js exactly (that file is the source of
// truth for what each collection actually stores); "open"/"active"
// filtering excludes each collection's own terminal statuses from
// STATUS_TRANSITIONS in the same file, same pattern as
// OPEN_TASK_STATUS_EXCLUDE above.
const MEETING_STATUS_EXCLUDE = /cancelled/i;
const SUPPORT_STATUS_EXCLUDE = /resolved|closed/i;
const PORTFOLIO_STATUS_EXCLUDE = /completed|cancelled/i;
const PARTNERSHIP_STATUS_EXCLUDE = /declined|closed/i;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function automationTriggerSummary(trigger) {
  const t = recordOf(trigger);
  if (t.schedule_type === "daily") return `Daily at ${text(t.local_time) || "?"}`;
  if (t.schedule_type === "weekdays") {
    const days = Array.isArray(t.weekdays) ? t.weekdays.map((d) => WEEKDAY_LABELS[d]).filter(Boolean).join(", ") : "";
    return `Weekly${days ? ` on ${days}` : ""} at ${text(t.local_time) || "?"}`;
  }
  if (t.schedule_type === "once") return `Once at ${text(t.local_datetime) || "?"}`;
  return "Custom trigger";
}

// Automations live in Backend's own consumer_automations table (the
// Shared Automation Runtime, surface="office") — not Office's Supabase
// project — so this reuses the existing REST bridge
// (callOyiCoreListAutomations, already used by the admin Automations
// page) rather than a second, parallel query path. Gated on tasks.read
// to match server.js's existing permission pairing for the automations
// routes ("Automations is part of the Tasks domain, not a separate
// feature area").
async function buildAutomationsSnapshot(config) {
  // config.httpRequest is a test-only DI hook (same convention as
  // fetchBackendFinancialSummary's own (config, options) shape) --
  // production callers never set it, so this is a no-op there.
  const result = await callOyiCoreListAutomations(config, {}, { httpRequest: config && config.httpRequest });
  if (!result.ok) return null;
  const rows = Array.isArray(result.data && result.data.automations) ? result.data.automations : [];
  return {
    items: rows.slice(0, SNAPSHOT_LIST_LIMIT).map((a) => ({
      id: text(a.id),
      name: text(a.name) || `Automation ${text(a.id)}`,
      enabled: Boolean(a.enabled),
      trigger_summary: automationTriggerSummary(a.trigger),
      last_run_status: text(a.last_run_status) || null,
      last_run_at: a.last_run_at || null,
    })),
    total: rows.length,
  };
}

async function buildMeetingsSnapshot(store) {
  const meetings = await listCorporateRecords(store, "meetings");
  const active = (Array.isArray(meetings) ? meetings : []).filter((r) => !MEETING_STATUS_EXCLUDE.test(text(r.status)));
  const rows = active.slice(0, SNAPSHOT_LIST_LIMIT).map((r) => ({
    id: text(r.id),
    title: text(r.title) || `Meeting ${text(r.id)}`,
    status: text(r.status || "scheduled"),
    scheduled_at: r.scheduled_at || null,
    owner: text(r.owner) || null,
    participants: Array.isArray(r.participants) ? r.participants.map(text).filter(Boolean) : [],
  }));
  return { items: rows, total: active.length };
}

async function buildSupportSnapshot(store) {
  const cases = await listCorporateRecords(store, "support");
  const open = (Array.isArray(cases) ? cases : []).filter((r) => !SUPPORT_STATUS_EXCLUDE.test(text(r.status)));
  const rows = open.slice(0, SNAPSHOT_LIST_LIMIT).map((r) => ({
    id: text(r.id),
    title: text(r.title) || `Support case ${text(r.id)}`,
    status: text(r.status || "open"),
    priority: text(r.priority) || null,
    severity: text(r.severity) || null,
    owner: text(r.assigned_staff || r.owner) || null,
  }));
  return { items: rows, total: open.length };
}

async function buildPortfolioListSnapshot(store) {
  const items = await listCorporateRecords(store, "portfolio");
  const active = (Array.isArray(items) ? items : []).filter((r) => !PORTFOLIO_STATUS_EXCLUDE.test(text(r.status)));
  const rows = active.slice(0, SNAPSHOT_LIST_LIMIT).map((r) => ({
    id: text(r.id),
    name: text(r.name || r.relationship_type) || `Portfolio ${text(r.id)}`,
    status: text(r.status || "unknown"),
    support_status: text(r.support_status) || null,
    health_summary: text(r.health_summary) || null,
    owner: text(r.owner) || null,
  }));
  return { items: rows, total: active.length };
}

async function buildPartnershipsListSnapshot(store) {
  const items = await listCorporateRecords(store, "partnerships");
  const active = (Array.isArray(items) ? items : []).filter((r) => !PARTNERSHIP_STATUS_EXCLUDE.test(text(r.status)));
  const rows = active.slice(0, SNAPSHOT_LIST_LIMIT).map((r) => ({
    id: text(r.id),
    name: text(r.name || r.relationship_type) || `Partnership ${text(r.id)}`,
    status: text(r.status || "new"),
    review_status: text(r.review_status) || null,
    relationship_type: text(r.relationship_type) || null,
    owner: text(r.relationship_manager || r.owner) || null,
  }));
  return { items: rows, total: active.length };
}

// Documents/Content — read-only surfaces (Milestone 2): list/inspect/
// summarize/compare/status/metadata only, no generation/drafting/
// publishing/approval capability is added here or anywhere downstream.
// Both collections live in Office's own store (documents via
// store.listOfficeDocuments, content via store.listContentItems — the
// same calls the admin Documents/Content pages already make), same
// "Office computes, Backend only reads as evidence" pattern as every
// other section above.
async function buildDocumentsSnapshot(store) {
  if (typeof store.listOfficeDocuments !== "function") return null;
  const documents = await store.listOfficeDocuments();
  const rows = (Array.isArray(documents) ? documents : []).slice(0, SNAPSHOT_LIST_LIMIT).map((r) => ({
    id: text(r.id),
    title: text(r.title) || `Document ${text(r.id)}`,
    document_type: text(r.document_type) || null,
    status: text(r.status) || null,
    owner: text(r.owner) || null,
  }));
  return { items: rows, total: Array.isArray(documents) ? documents.length : rows.length };
}

async function buildContentSnapshot(store) {
  if (typeof store.listContentItems !== "function") return null;
  const items = await store.listContentItems({});
  const rows = (Array.isArray(items) ? items : []).slice(0, SNAPSHOT_LIST_LIMIT).map((r) => ({
    id: text(r.id),
    title: text(r.title) || `Content ${text(r.id)}`,
    workflow_status: text(r.workflow_status) || null,
    category: text(r.category) || null,
    author: text(r.author) || null,
  }));
  return { items: rows, total: Array.isArray(items) ? items.length : rows.length };
}

async function buildOperationalSnapshot({ authContext, store, config } = {}) {
  if (!store) return null;
  const snapshot = {
    generated_at: new Date().toISOString(),
    leads: null,
    opportunities: null,
    tasks: null,
    reports: null,
    development: null,
    financial: null,
    automations: null,
    meetings: null,
    support: null,
    portfolio: null,
    partnerships: null,
    documents: null,
    content: null,
  };
  try {
    if (hasPermission(authContext, "crm.read")) {
      if (typeof store.listLeads === "function") snapshot.leads = await buildLeadsSnapshot(store);
      snapshot.opportunities = await buildOpportunitiesSnapshot(store);
    }
  } catch {
    // Leave leads/opportunities null — reported honestly as unavailable.
  }
  try {
    if (hasPermission(authContext, "tasks.read")) {
      snapshot.tasks = await buildTasksSnapshot(store);
      snapshot.automations = await buildAutomationsSnapshot(config);
    }
  } catch {
    // Leave tasks/automations null.
  }
  try {
    if (hasPermission(authContext, "reports.write") && typeof store.listOfficeReports === "function") {
      snapshot.reports = await buildReportsSnapshot(store);
    }
  } catch {
    // Leave reports null.
  }
  try {
    if (hasPermission(authContext, "development.manage") && typeof store.listDevelopmentProjects === "function") {
      snapshot.development = await buildDevelopmentSnapshot(store);
    }
  } catch {
    // Leave development null.
  }
  try {
    if (hasPermission(authContext, "financial.read")) {
      snapshot.financial = await buildFinancialSnapshot(config);
    }
  } catch {
    // Leave financial null.
  }
  try {
    if (hasPermission(authContext, "meetings.read")) {
      snapshot.meetings = await buildMeetingsSnapshot(store);
    }
  } catch {
    // Leave meetings null.
  }
  try {
    if (hasPermission(authContext, "support.read")) {
      snapshot.support = await buildSupportSnapshot(store);
    }
  } catch {
    // Leave support null.
  }
  try {
    if (hasPermission(authContext, "portfolio.read")) {
      snapshot.portfolio = await buildPortfolioListSnapshot(store);
    }
  } catch {
    // Leave portfolio null.
  }
  try {
    if (hasPermission(authContext, "partnerships.read")) {
      snapshot.partnerships = await buildPartnershipsListSnapshot(store);
    }
  } catch {
    // Leave partnerships null.
  }
  try {
    if (hasPermission(authContext, "documents.generate")) {
      snapshot.documents = await buildDocumentsSnapshot(store);
    }
  } catch {
    // Leave documents null.
  }
  try {
    if (hasPermission(authContext, "content.write")) {
      snapshot.content = await buildContentSnapshot(store);
    }
  } catch {
    // Leave content null.
  }
  return snapshot;
}

function oyiCoreConversationUrl(config = {}) {
  const base = text(config.officeBackendBaseUrl).replace(/\/+$/g, "");
  const path = text(config.officeBackendConversationPath || "/office/conversation/corporate");
  if (!base || !path) return "";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function buildOyiCoreCorporateConversationRequest({ session, message, lead, body, requestId } = {}) {
  const safeSession = recordOf(session);
  const safeLead = recordOf(lead);
  const safeBody = recordOf(body);
  const source = recordOf(safeSession.source);

  return {
    request_id: text(requestId || safeBody.request_id),
    message: text(message || safeBody.message),
    public_session_id: text(safeSession.session_id || safeBody.public_session_id || safeBody.session_id),
    conversation_thread_id: text(
      safeSession.conversation_thread_id || safeBody.conversation_thread_id || safeBody.thread_id
    ),
    public_identity: text(safeSession.public_identity || "ochiga_intelligence"),
    agent_role: text(safeSession.active_agent_role || "oma"),
    business_unit: text(safeSession.business_unit || "corporate"),
    inquiry_type: text(safeSession.inquiry_type || "general_enquiry"),
    source: {
      source_site: text(source.source_site || safeBody.source_site || safeBody.source || "ochiga_website"),
      source_page: text(source.source_page || safeBody.source_page || safeBody.page),
      source_channel: text(source.source_channel || safeBody.source_channel || "website"),
      source_form: text(source.source_form || safeBody.source_form),
      campaign: recordOf(source.campaign || safeBody.campaign),
    },
    visitor_state: safeLead.id ? "known" : "anonymous",
    crm_context: safeLead.id
      ? {
          lead_ref: text(safeLead.id),
          contact_ref: text(safeSession.crm_contact_ref),
          opportunity_ref: text(safeSession.crm_opportunity_ref),
          safe_summary: text(safeLead.summary || safeLead.next_action),
          stage: text(safeLead.commercial_stage || safeLead.stage || safeLead.status),
        }
      : null,
    form_context_ref: text(safeSession.secure_form_context_ref || safeBody.form_context_ref),
    engagement_mode: text(safeSession.engagement_mode || safeBody.mode || "text_conversation"),
    handoff_state: text(safeSession.handoff_state || "none"),
    requested_capability: text(safeBody.requested_capability || "public_question_answer"),
    knowledge_context: Array.isArray(safeBody.knowledge_context) ? safeBody.knowledge_context : [],
    metadata: {
      crm_source_of_truth: "ochiga-office",
      intelligence_authority: "ochiga-backend",
      profile_present: Boolean(safeBody.profile && Object.keys(recordOf(safeBody.profile)).length),
      voice_state: text(safeSession.voice_state),
      proactive_prompt_state: text(safeSession.proactive_prompt_state),
    },
  };
}

async function buildOyiCoreOfficeInternalRequest({ authContext, message, body, requestId, store, config } = {}) {
  const safeBody = recordOf(body);
  const page = recordOf(safeBody.page_context);
  const staff = recordOf(safeBody.staff);
  const operationalSnapshot = await buildOperationalSnapshot({ authContext, store, config });
  return {
    request_id: text(requestId || safeBody.request_id),
    message: text(message || safeBody.message),
    office_session_id: text(safeBody.office_session_id || safeBody.session_id || `office_session_${requestId || Date.now()}`),
    conversation_thread_id: text(safeBody.conversation_thread_id || safeBody.thread_id),
    staff: {
      staff_id: text(staff.staff_id || staff.id || authContext?.userId),
      email: text(staff.email || authContext?.email),
      role: text(staff.role || authContext?.role || "ochiga_staff"),
      permissions: Array.isArray(staff.permissions)
        ? staff.permissions
        : Array.isArray(authContext?.permissions)
        ? authContext.permissions
        : [],
    },
    page_context: {
      page: text(page.page || safeBody.page),
      selected_type: text(page.selected_type || safeBody.selected_type),
      selected_id: text(page.selected_id || safeBody.selected_id),
    },
    business_unit: text(safeBody.business_unit || "corporate"),
    capability_context: Array.isArray(safeBody.capability_context) ? safeBody.capability_context : [],
    crm_context: recordOf(safeBody.crm_context),
    portfolio_context: recordOf(safeBody.portfolio_context),
    support_context: recordOf(safeBody.support_context),
    project_context: recordOf(safeBody.project_context),
    task_context: recordOf(safeBody.task_context),
    // Phase 4, PR 4/PR 5 (Oyi Conversational Runtime Completion
    // Programme) -- these were added to the wire contract and to
    // Backend's normalizer/context passthrough, but this proxy function
    // never forwarded them, so a batch confirm's VERIFY turn always
    // arrived at Backend with task_batch_context silently missing (and
    // any client-side PATCH failure report along with it). Found live in
    // production: batch verification reported 0/N success even though
    // every PATCH call had actually succeeded.
    task_batch_context: Array.isArray(safeBody.task_batch_context) ? safeBody.task_batch_context : null,
    execution_failed: Boolean(safeBody.execution_failed),
    execution_failure_reason: text(safeBody.execution_failure_reason) || null,
    automation_context: recordOf(safeBody.automation_context),
    meeting_context: recordOf(safeBody.meeting_context),
    partnership_context: recordOf(safeBody.partnership_context),
    document_context: recordOf(safeBody.document_context),
    content_context: recordOf(safeBody.content_context),
    // Oyi Office Intelligence Interaction Repositioning -- a photo or
    // file attached to this turn (mutually exclusive; the camera sheet
    // and Share file each only ever set one). Backend performs the
    // real analysis and folds it into the same message before
    // orchestration -- this proxy only needs to forward the raw data.
    image_data_url: text(safeBody.image_data_url) || undefined,
    document_data_url: text(safeBody.document_data_url) || undefined,
    document_filename: text(safeBody.document_filename) || undefined,
    requested_capability: text(safeBody.requested_capability || "office_internal_conversation"),
    knowledge_context: Array.isArray(safeBody.knowledge_context) ? safeBody.knowledge_context : [],
    metadata: {
      crm_source_of_truth: "ochiga-office",
      intelligence_authority: "ochiga-backend",
      surface: "office_internal",
      mode: text(safeBody.mode || "text_conversation"),
    },
    operational_snapshot: operationalSnapshot,
  };
}

async function callOyiCoreCorporateConversation(config = {}, payload = {}, options = {}) {
  const url = oyiCoreConversationUrl(config);
  if (!url) {
    return { ok: false, unavailable: true, reason: "not_configured", status: 0 };
  }

  const headers = {
    "content-type": "application/json",
    "x-request-id": text(payload.request_id),
    "x-public-session-id": text(payload.public_session_id),
  };
  if (config.officeBackendApiKey) headers["x-office-api-key"] = config.officeBackendApiKey;
  if (config.officeBackendBearerToken) headers.authorization = `Bearer ${config.officeBackendBearerToken}`;

  const post = options.httpPost || ((targetUrl, body, requestConfig) => axios.post(targetUrl, body, requestConfig));
  try {
    const response = await post(url, payload, {
      timeout: config.officeBackendEventTimeoutMs || 10_000,
      headers,
      validateStatus: () => true,
    });
    const status = Number(response && response.status) || 0;
    const body = recordOf(response && response.data);
    if (status >= 200 && status < 300 && body.ok !== false) {
      return { ok: true, unavailable: false, status, response: body };
    }
    return {
      ok: false,
      unavailable: true,
      status,
      reason: text(body.error || body.reason || "backend_rejected"),
      response: body,
    };
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      status: 0,
      reason: "network_error",
      error: error && error.code ? String(error.code) : "request_failed",
    };
  }
}

async function callOyiCoreOfficeInternalConversation(config = {}, payload = {}, options = {}) {
  const path = config.officeBackendInternalConversationPath || "/office/conversation/internal";
  return callOyiCoreCorporateConversation(
    { ...config, officeBackendConversationPath: path },
    payload,
    options
  );
}

// Voice Chat's speech-out leg -- reuses the exact same authenticated
// POST convention as every other Backend call in this file (shared
// office key, same base URL), just against a different path.
async function callOyiCoreSpeechSynthesis(config = {}, speechText = "", options = {}) {
  const baseUrl = String(config.officeBackendBaseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) return { ok: false, unavailable: true, reason: "not_configured" };
  const headers = { "content-type": "application/json" };
  if (config.officeBackendApiKey) headers["x-office-api-key"] = config.officeBackendApiKey;
  if (config.officeBackendBearerToken) headers.authorization = `Bearer ${config.officeBackendBearerToken}`;
  const post = options.httpPost || ((targetUrl, body, requestConfig) => axios.post(targetUrl, body, requestConfig));
  try {
    const response = await post(`${baseUrl}/office/conversation/speech`, { text: speechText }, {
      timeout: Math.max(config.officeBackendEventTimeoutMs || 10_000, 30_000),
      headers,
      validateStatus: () => true,
    });
    const status = Number(response && response.status) || 0;
    const body = recordOf(response && response.data);
    if (status >= 200 && status < 300 && body.ok !== false) {
      return { ok: true, audio_data_url: body.audio_data_url, mime_type: body.mime_type };
    }
    return { ok: false, unavailable: true, status, reason: text(body.error || "backend_rejected") };
  } catch (error) {
    return { ok: false, unavailable: true, status: 0, reason: "network_error", error: error && error.code ? String(error.code) : "request_failed" };
  }
}

// Oyi Cross-Surface Observability Closure — Backend's new safe,
// cross-surface read endpoint (Consumer/Facility/Website-Oyi-widget
// conversation, voice, vision and device-execution activity). Same
// credential/timeout convention as the conversation calls above.
async function callOyiCoreObservabilityEvents(config = {}, options = {}) {
  const baseUrl = String(config.officeBackendBaseUrl || "").replace(/\/+$/, "");
  const path = config.officeObservabilityEventsPath || "/office/observability/events";
  if (!baseUrl) {
    return { ok: false, unavailable: true, reason: "not_configured", events: [] };
  }
  const headers = {};
  if (config.officeBackendApiKey) headers["x-office-api-key"] = config.officeBackendApiKey;
  if (config.officeBackendBearerToken) headers.authorization = `Bearer ${config.officeBackendBearerToken}`;

  const get = options.httpGet || ((targetUrl, requestConfig) => axios.get(targetUrl, requestConfig));
  try {
    const response = await get(`${baseUrl}${path}`, {
      timeout: config.officeBackendEventTimeoutMs || 10_000,
      headers,
      params: options.limit ? { limit: options.limit } : undefined,
      validateStatus: () => true,
    });
    const status = Number(response && response.status) || 0;
    const body = response && response.data && typeof response.data === "object" ? response.data : {};
    if (status >= 200 && status < 300 && body.ok !== false) {
      return { ok: true, unavailable: false, status, events: Array.isArray(body.events) ? body.events : [] };
    }
    return { ok: false, unavailable: true, status, reason: text(body.error || "backend_rejected"), events: [] };
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      status: 0,
      reason: "network_error",
      error: error && error.code ? String(error.code) : "request_failed",
      events: [],
    };
  }
}

// Oyi Runtime Contract, Domain 3 (Task) — Backend's additive
// office-backend-intelligence-events projection into ochiga_workflows.
// Same credential/timeout convention as every other Backend call here.
// Never throws — a failed bridge call must never fail the real Office
// operation (lead update, proposal accept, demo booking, deployment
// creation) it was triggered from.
function officeWorkflowHeaders(config) {
  const headers = { "content-type": "application/json" };
  if (config.officeBackendApiKey) headers["x-office-api-key"] = config.officeBackendApiKey;
  if (config.officeBackendBearerToken) headers.authorization = `Bearer ${config.officeBackendBearerToken}`;
  return headers;
}

async function callOyiCoreCreateWorkflow(config = {}, payload = {}, options = {}) {
  const baseUrl = String(config.officeBackendBaseUrl || "").replace(/\/+$/, "");
  const path = config.officeWorkflowsPath || "/office/workflows";
  if (!baseUrl) return { ok: false, unavailable: true, reason: "not_configured" };
  const post = options.httpPost || ((targetUrl, body, requestConfig) => axios.post(targetUrl, body, requestConfig));
  try {
    const response = await post(`${baseUrl}${path}`, payload, {
      timeout: config.officeBackendEventTimeoutMs || 10_000,
      headers: officeWorkflowHeaders(config),
      validateStatus: () => true,
    });
    const status = Number(response && response.status) || 0;
    const body = response && response.data && typeof response.data === "object" ? response.data : {};
    if (status >= 200 && status < 300 && body.ok !== false) {
      return { ok: true, workflow: body.workflow || null };
    }
    return { ok: false, unavailable: true, status, reason: text(body.error || "backend_rejected") };
  } catch (error) {
    return { ok: false, unavailable: true, status: 0, reason: "network_error", error: error && error.code ? String(error.code) : "request_failed" };
  }
}

async function callOyiCoreTransitionWorkflow(config = {}, workflowId, payload = {}, options = {}) {
  const baseUrl = String(config.officeBackendBaseUrl || "").replace(/\/+$/, "");
  const path = `${config.officeWorkflowsPath || "/office/workflows"}/${encodeURIComponent(workflowId)}`;
  if (!baseUrl) return { ok: false, unavailable: true, reason: "not_configured" };
  const patch = options.httpPatch || ((targetUrl, body, requestConfig) => axios.patch(targetUrl, body, requestConfig));
  try {
    const response = await patch(`${baseUrl}${path}`, payload, {
      timeout: config.officeBackendEventTimeoutMs || 10_000,
      headers: officeWorkflowHeaders(config),
      validateStatus: () => true,
    });
    const status = Number(response && response.status) || 0;
    const body = response && response.data && typeof response.data === "object" ? response.data : {};
    if (status >= 200 && status < 300 && body.ok !== false) {
      return { ok: true, workflow: body.workflow || null };
    }
    return { ok: false, unavailable: true, status, reason: text(body.error || "backend_rejected") };
  } catch (error) {
    return { ok: false, unavailable: true, status: 0, reason: "network_error", error: error && error.code ? String(error.code) : "request_failed" };
  }
}

// Tasks Domain UI — Office's own bridge into the Shared Automation
// Runtime's additive Office-facing routes (Ochiga-backend
// src/routes/officeExport.ts: /office/automations*, /office/workflows/:id).
// These are synchronous, admin-initiated calls (list/create/update/
// delete/run automations, fetch a workflow's detail) — unlike the
// fire-and-forget workflow bridge above, a failure here must be
// surfaced to the admin, not swallowed. Shape is uniform:
// { ok, status, data, error } — data is the parsed backend body on
// success, error is a human-readable message on failure.
function automationHeaders(config) {
  return officeWorkflowHeaders(config);
}

async function callBackendJson(config, method, path, payload, options = {}) {
  const baseUrl = String(config.officeBackendBaseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) return { ok: false, status: 0, error: "Office backend base URL is not configured." };
  const request = options.httpRequest || ((requestConfig) => axios(requestConfig));
  try {
    const response = await request({
      method,
      url: `${baseUrl}${path}`,
      data: payload,
      timeout: config.officeBackendEventTimeoutMs || 10_000,
      headers: automationHeaders(config),
      validateStatus: () => true,
    });
    const status = Number(response && response.status) || 0;
    const body = response && response.data && typeof response.data === "object" ? response.data : {};
    if (status >= 200 && status < 300 && body.ok !== false) {
      return { ok: true, status, data: body };
    }
    return { ok: false, status, error: text(body.error || `Backend request failed (${status || "network error"}).`) };
  } catch (error) {
    return { ok: false, status: 0, error: text(error && error.message) || "Unable to reach the Backend service." };
  }
}

function automationsBase(config) {
  return config.officeAutomationsPath || "/office/automations";
}

async function callOyiCoreListAutomations(config = {}, params = {}, options = {}) {
  const query = params.status ? `?status=${encodeURIComponent(params.status)}` : "";
  return callBackendJson(config, "get", `${automationsBase(config)}${query}`, undefined, options);
}
async function callOyiCoreGetAutomation(config = {}, id) {
  return callBackendJson(config, "get", `${automationsBase(config)}/${encodeURIComponent(id)}`, undefined);
}
async function callOyiCoreCreateAutomation(config = {}, payload = {}) {
  return callBackendJson(config, "post", automationsBase(config), payload);
}
async function callOyiCoreUpdateAutomation(config = {}, id, payload = {}) {
  return callBackendJson(config, "patch", `${automationsBase(config)}/${encodeURIComponent(id)}`, payload);
}
async function callOyiCoreDeleteAutomation(config = {}, id) {
  return callBackendJson(config, "delete", `${automationsBase(config)}/${encodeURIComponent(id)}`, undefined);
}
async function callOyiCoreListAutomationRuns(config = {}, id) {
  return callBackendJson(config, "get", `${automationsBase(config)}/${encodeURIComponent(id)}/runs`, undefined);
}
async function callOyiCoreTestAutomation(config = {}, id) {
  return callBackendJson(config, "post", `${automationsBase(config)}/${encodeURIComponent(id)}/test`, undefined);
}
async function callOyiCoreGetWorkflow(config = {}, workflowId) {
  const path = `${config.officeWorkflowsPath || "/office/workflows"}/${encodeURIComponent(workflowId)}`;
  return callBackendJson(config, "get", path, undefined);
}
// Overview's honest "workflow completion rate" metric needs the list
// route — GET /office/workflows already existed and is already live
// (Oyi Runtime Contract Task-domain bridge), just never had an Office
// server proxy in front of it before now.
async function callOyiCoreListWorkflows(config = {}, params = {}) {
  const query = params.limit ? `?limit=${encodeURIComponent(params.limit)}` : "";
  const path = `${config.officeWorkflowsPath || "/office/workflows"}${query}`;
  return callBackendJson(config, "get", path, undefined);
}

module.exports = {
  buildOyiCoreCorporateConversationRequest,
  buildOyiCoreOfficeInternalRequest,
  callOyiCoreCorporateConversation,
  callOyiCoreOfficeInternalConversation,
  callOyiCoreSpeechSynthesis,
  callOyiCoreObservabilityEvents,
  callOyiCoreCreateWorkflow,
  callOyiCoreTransitionWorkflow,
  callOyiCoreListAutomations,
  callOyiCoreGetAutomation,
  callOyiCoreCreateAutomation,
  callOyiCoreUpdateAutomation,
  callOyiCoreDeleteAutomation,
  callOyiCoreListAutomationRuns,
  callOyiCoreTestAutomation,
  callOyiCoreGetWorkflow,
  callOyiCoreListWorkflows,
  oyiCoreConversationUrl,
};
