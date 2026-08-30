const crypto = require("crypto");
const { BUSINESS_UNITS, CORPORATE_COLLECTIONS, createCorporateRecord, listCorporateRecords } = require("./office-operating-system");
const { normalizeText } = require("./normalize-lead");
const { hasPermission } = require("./permissions");
const { chooseStaffForHandoff } = require("./communications-handoff");

const FIELD_POLICY = Object.freeze({
  tasks: ["title", "description", "owner", "assignee", "priority", "due_at", "status", "lead_id", "opportunity_id", "project_id", "portfolio_id", "support_case_id", "private_relationship_id", "partnership_relationship_id", "business_unit"],
  support: ["title", "owner", "assigned_staff", "priority", "severity", "category", "status", "resolution_notes", "portfolio_id", "backend_incident_ref", "business_unit"],
  projects: ["name", "owner", "business_unit", "stage", "status", "location", "metadata", "linked_opportunity_id", "lead_id", "organization_id", "contact_id", "portfolio_id", "oyi_deployment_status"],
  portfolio: ["owner", "relationship_type", "status", "support_status", "oyi_deployment_status", "health_summary", "project_id", "business_unit", "metadata"],
  meetings: ["title", "scheduled_at", "owner", "participants", "notes", "outcome", "status", "follow_up_task_id", "related_type", "related_id", "business_unit"],
  private: ["relationship_type", "relationship_manager", "owner", "status", "review_status", "notes", "business_unit", "contact_id", "organization_id", "opportunity_id"],
  partnerships: ["relationship_type", "relationship_manager", "owner", "status", "review_status", "notes", "business_unit", "contact_id", "organization_id", "opportunity_id"],
});

const STATUS_TRANSITIONS = Object.freeze({
  tasks: {
    open: ["in_progress", "completed", "cancelled"],
    in_progress: ["open", "completed", "cancelled"],
    completed: [],
    cancelled: [],
  },
  support: {
    open: ["in_progress", "waiting_customer", "waiting_internal", "resolved", "closed"],
    in_progress: ["waiting_customer", "waiting_internal", "resolved", "closed"],
    waiting_customer: ["in_progress", "resolved", "closed"],
    waiting_internal: ["in_progress", "resolved", "closed"],
    resolved: ["in_progress", "closed"],
    closed: [],
  },
  projects: {
    planned: ["active", "on_hold", "cancelled"],
    prospective: ["planned", "active", "on_hold", "cancelled"],
    active: ["on_hold", "completed", "cancelled"],
    on_hold: ["active", "cancelled"],
    completed: [],
    cancelled: [],
  },
  portfolio: {
    active: ["on_hold", "completed", "cancelled"],
    normal: ["attention", "on_hold"],
    attention: ["normal", "on_hold"],
    on_hold: ["active", "normal", "cancelled"],
    completed: [],
    cancelled: [],
  },
  meetings: {
    scheduled: ["completed", "cancelled"],
    active: ["scheduled", "completed", "cancelled"],
    completed: [],
    cancelled: [],
  },
  private: {
    requested: ["under_review", "declined"],
    under_review: ["approved", "declined"],
    approved: ["active", "inactive"],
    active: ["inactive"],
    inactive: ["under_review"],
    declined: [],
  },
  partnerships: {
    new: ["under_review", "active", "declined"],
    under_review: ["active", "declined"],
    active: ["paused", "closed"],
    paused: ["active", "closed"],
    closed: [],
    declined: [],
  },
});

const RELATED_TYPES = Object.freeze({
  lead: { collection: "leads", permission: "crm.read" },
  contact: { collection: "contacts", permission: "crm.read" },
  organization: { collection: "organizations", permission: "crm.read" },
  opportunity: { collection: "opportunities", permission: "crm.read" },
  project: { collection: "projects", permission: "projects.read" },
  portfolio: { collection: "portfolio", permission: "portfolio.read" },
  support_case: { collection: "support", permission: "support.read" },
  private_relationship: { collection: "private", permission: "private.read" },
  partnership_relationship: { collection: "partnerships", permission: "partnerships.read" },
  meeting: { collection: "meetings", permission: "meetings.read" },
  proposal: { collection: "proposals", permission: "crm.read" },
  document: { collection: "documents", permission: "documents.generate" },
  report: { collection: "reports", permission: "reports.write" },
});

const ACTIVITY_MANAGE_PERMISSIONS = Object.freeze({
  lead: "crm.manage",
  contact: "crm.manage",
  organization: "crm.manage",
  opportunity: "crm.manage",
  project: "projects.manage",
  portfolio: "portfolio.manage",
  support_case: "support.assign",
  private_relationship: "private.manage",
  partnership_relationship: "partnerships.manage",
  meeting: "meetings.manage",
  proposal: "crm.manage",
  document: "documents.generate",
  report: "reports.write",
});

function text(value, fallback = "") {
  return normalizeText(value) || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function errorWithStatus(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sparsePatch(input = {}, allowed = []) {
  const patch = {};
  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      patch[field] = input[field];
    }
  }
  return patch;
}

function normalizeStatus(collection, value) {
  return text(value).toLowerCase();
}

function assertTransition(collection, currentStatus, nextStatus) {
  if (!nextStatus || nextStatus === currentStatus) return;
  const transitions = STATUS_TRANSITIONS[collection] || {};
  const allowed = transitions[currentStatus] || [];
  if (!allowed.includes(nextStatus)) {
    throw errorWithStatus(`invalid_${collection}_status_transition`, 400);
  }
}

function sanitizePatch(collection, input = {}, current = {}) {
  const patch = sparsePatch(input, FIELD_POLICY[collection] || []);
  if (Object.prototype.hasOwnProperty.call(patch, "business_unit")) {
    const unit = text(patch.business_unit || current.business_unit || "corporate").toLowerCase();
    if (!BUSINESS_UNITS.includes(unit)) throw errorWithStatus("invalid_business_unit", 400);
    patch.business_unit = unit;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "participants")) {
    if (!Array.isArray(patch.participants)) throw errorWithStatus("invalid_participants", 400);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "metadata")) {
    if (!patch.metadata || typeof patch.metadata !== "object" || Array.isArray(patch.metadata)) {
      throw errorWithStatus("invalid_metadata", 400);
    }
    patch.metadata = { ...(current.metadata || {}), ...patch.metadata };
  }
  for (const field of ["title", "description", "owner", "assignee", "priority", "due_at", "name", "stage", "status", "review_status", "location", "notes", "outcome", "resolution_notes", "assigned_staff", "category", "severity", "relationship_type", "relationship_manager", "support_status", "oyi_deployment_status", "health_summary"]) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) patch[field] = text(patch[field]);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    patch.status = normalizeStatus(collection, patch.status);
    assertTransition(collection, normalizeStatus(collection, current.status || defaultStatus(collection)), patch.status);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "review_status")) {
    patch.review_status = normalizeStatus(collection, patch.review_status);
    assertTransition(collection, normalizeStatus(collection, current.review_status || current.status || defaultReviewStatus(collection)), patch.review_status);
  }
  if (collection === "tasks" && patch.status === "completed" && !current.completed_at) {
    patch.completed_at = nowIso();
  }
  if (collection === "support" && patch.status === "resolved") {
    const resolution = text(patch.resolution_notes || current.resolution_notes);
    if (!resolution) throw errorWithStatus("resolution_notes_required", 400);
    patch.resolution_notes = resolution;
    patch.resolved_at = current.resolved_at || nowIso();
  }
  // A meeting's "scheduled" status is meant to mean "has a confirmed
  // date/time" — without this guard, the generic Mark-{status} action
  // let a meeting sit as status: "scheduled" with scheduled_at: null
  // forever, since assertTransition only validates the status graph and
  // never cross-checks scheduled_at. Same pattern as resolution_notes
  // above: the field the status implies must actually be present.
  if (collection === "meetings" && patch.status === "scheduled") {
    const scheduledAt = text(patch.scheduled_at || current.scheduled_at);
    if (!scheduledAt) throw errorWithStatus("scheduled_at_required", 400);
  }
  if (collection === "meetings" && ["completed", "cancelled"].includes(patch.status)) {
    patch.completed_at = patch.status === "completed" ? current.completed_at || nowIso() : current.completed_at || null;
    patch.cancelled_at = patch.status === "cancelled" ? current.cancelled_at || nowIso() : current.cancelled_at || null;
  }
  if (Object.keys(patch).length === 0) throw errorWithStatus("empty_patch", 400);
  return patch;
}

function defaultStatus(collection) {
  if (collection === "tasks") return "open";
  if (collection === "support") return "open";
  if (collection === "projects") return "prospective";
  if (collection === "meetings") return "scheduled";
  return "active";
}

function defaultReviewStatus(collection) {
  if (collection === "private") return "requested";
  if (collection === "partnerships") return "new";
  return defaultStatus(collection);
}

async function findCorporateRecord(store, collection, id) {
  if (!id) return null;
  if (collection === "leads" && store?.getLead) return store.getLead(id);
  if (collection === "proposals" && store?.getProposal) return store.getProposal(id);
  if (collection === "documents" && store?.state) {
    return (store.state.office_documents || []).find((item) => String(item.id) === String(id)) || null;
  }
  if (collection === "reports" && store?.getOfficeReportById) {
    return store.getOfficeReportById(id);
  }
  const rows = await listCorporateRecords(store, collection);
  return rows.find((item) => String(item.id) === String(id)) || null;
}

async function validateRelatedObject(store, authContext, relatedType, relatedId) {
  const type = text(relatedType).toLowerCase();
  const id = text(relatedId);
  if (!type && !id) return null;
  const config = RELATED_TYPES[type];
  if (!config || !id) throw errorWithStatus("invalid_related_object", 400);
  if (!hasPermission(authContext, config.permission)) throw errorWithStatus("forbidden_related_object", 403);
  const record = await findCorporateRecord(store, config.collection, id);
  if (!record) throw errorWithStatus("related_object_not_found", 404);
  return { related_type: type, related_id: id, record };
}

async function validatePatchRelationships(store, authContext, collection, patch) {
  if (collection === "private" || collection === "partnerships") {
    for (const field of ["contact_id", "organization_id"]) {
      if (Object.prototype.hasOwnProperty.call(patch, field) && !patch[field]) {
        throw errorWithStatus("relationship_identity_reference_required", 400);
      }
    }
  }
  const mapping = {
    lead_id: ["lead", "crm.read"],
    contact_id: ["contact", "crm.read"],
    organization_id: ["organization", "crm.read"],
    opportunity_id: ["opportunity", "crm.read"],
    linked_opportunity_id: ["opportunity", "crm.read"],
    project_id: ["project", "projects.read"],
    portfolio_id: ["portfolio", "portfolio.read"],
    support_case_id: ["support_case", "support.read"],
    private_relationship_id: ["private_relationship", "private.read"],
    partnership_relationship_id: ["partnership_relationship", "partnerships.read"],
    follow_up_task_id: ["tasks", "tasks.read"],
  };
  for (const [field, [type, permission]] of Object.entries(mapping)) {
    if (!Object.prototype.hasOwnProperty.call(patch, field) || !patch[field]) continue;
    if (!hasPermission(authContext, permission)) throw errorWithStatus("forbidden_related_object", 403);
    const targetCollection = type === "tasks" ? "tasks" : RELATED_TYPES[type]?.collection;
    const record = targetCollection ? await findCorporateRecord(store, targetCollection, patch[field]) : null;
    if (!record) throw errorWithStatus("related_object_not_found", 404);
  }
  if (collection === "meetings" && (Object.prototype.hasOwnProperty.call(patch, "related_type") || Object.prototype.hasOwnProperty.call(patch, "related_id"))) {
    await validateRelatedObject(store, authContext, patch.related_type, patch.related_id);
  }
}

async function validateOperationalRelationships(store, authContext, collection, input = {}) {
  await validatePatchRelationships(store, authContext, collection, input);
}

async function persistCorporateRecord(store, collection, record) {
  const config = CORPORATE_COLLECTIONS[collection];
  if (store?.state) {
    if (!Array.isArray(store.state[config.state])) store.state[config.state] = [];
    const index = store.state[config.state].findIndex((item) => String(item.id) === String(record.id));
    if (index < 0) throw errorWithStatus("record_not_found", 404);
    store.state[config.state][index] = record;
    if (store.persist) await store.persist();
    return record;
  }
  if (store?.client) {
    const response = await store.client.patch(`/${config.table}?id=eq.${encodeURIComponent(record.id)}`, record, {
      headers: store.selectHeaders ? store.selectHeaders() : undefined,
    });
    return response.data?.[0] || record;
  }
  return record;
}

// Governed Portfolio delete -- the first hard-delete this codebase
// performs on a corporate record. Deliberately scoped: callers must gate
// which collections are allowed to reach this (Portfolio only, today),
// not a generic "delete any corporate collection" capability.
async function deleteCorporateRecord(store, collection, id) {
  const config = CORPORATE_COLLECTIONS[collection];
  if (store?.state) {
    if (!Array.isArray(store.state[config.state])) store.state[config.state] = [];
    const index = store.state[config.state].findIndex((item) => String(item.id) === String(id));
    if (index < 0) return false;
    store.state[config.state].splice(index, 1);
    if (store.persist) await store.persist();
    return true;
  }
  if (store?.client) {
    await store.client.delete(`/${config.table}?id=eq.${encodeURIComponent(id)}`, {
      headers: store.selectHeaders ? store.selectHeaders() : undefined,
    });
    return true;
  }
  return false;
}

function activityForMutation(collection, before, after, patch, actorEmail) {
  const statusChanged = before.status !== after.status || before.review_status !== after.review_status;
  const assignmentChanged = (before.assignee || before.assigned_staff || before.relationship_manager || before.owner || "") !== (after.assignee || after.assigned_staff || after.relationship_manager || after.owner || "");
  const type = statusChanged ? `${collection}_status_changed` : assignmentChanged ? `${collection}_assignment_changed` : `${collection}_updated`;
  const relatedType = collection === "support"
    ? "support_case"
    : collection === "tasks"
      ? "task"
      : collection === "private"
        ? "private_relationship"
        : collection === "partnerships"
          ? "partnership_relationship"
          : collection.slice(0, -1);
  const previousStatus = before.review_status || before.status || null;
  const nextStatus = after.review_status || after.status || null;
  return {
    activity_type: type,
    title: `${collection} ${statusChanged ? "status changed" : assignmentChanged ? "assignment changed" : "updated"}`,
    body: statusChanged ? `${previousStatus || "unknown"} → ${nextStatus}` : `${collection} updated.`,
    business_unit: after.business_unit,
    related_type: relatedType,
    related_id: after.id,
    actor: actorEmail,
    metadata: {
      changed_fields: Object.keys(patch),
      previous_status: previousStatus,
      next_status: nextStatus,
    },
  };
}

async function updateOperationalRecord(store, collection, id, input = {}, context = {}) {
  if (!FIELD_POLICY[collection]) throw errorWithStatus("unsupported_mutation_collection", 404);
  const current = await findCorporateRecord(store, collection, id);
  if (!current) throw errorWithStatus("record_not_found", 404);
  const patch = sanitizePatch(collection, input, current);
  await validatePatchRelationships(store, context.authContext, collection, patch);
  const next = { ...current, ...patch, updated_at: nowIso() };
  const record = await persistCorporateRecord(store, collection, next);
  const activity = await createCorporateRecord(store, "activities", activityForMutation(collection, current, record, patch, context.actorEmail || "office"), { actorEmail: context.actorEmail || "office" });
  return {
    record,
    activity,
    allowed_actions: allowedActions(collection, record),
    allowed_status_transitions: allowedStatusTransitions(collection, record),
  };
}

function allowedActions(collection, record) {
  const transitions = allowedStatusTransitions(collection, record);
  const current = normalizeStatus(collection, record.review_status || record.status);
  return {
    can_update: transitions.length > 0 || !["completed", "cancelled", "closed", "declined"].includes(current),
    can_transition: transitions.length > 0,
    can_add_activity: true,
    transitions,
  };
}

function allowedStatusTransitions(collection, record = {}) {
  const current = normalizeStatus(collection, record.review_status || record.status || defaultReviewStatus(collection));
  return STATUS_TRANSITIONS[collection]?.[current] || [];
}

async function createRelatedActivity(store, input = {}, context = {}) {
  const related = await validateRelatedObject(store, context.authContext, input.related_type, input.related_id);
  const type = related?.related_type;
  const record = await createCorporateRecord(store, "activities", {
    ...input,
    activity_type: text(input.activity_type, "note"),
    title: text(input.title, "Note"),
    body: text(input.body || input.summary),
    related_type: type,
    related_id: related?.related_id,
    project_id: type === "project" ? related.related_id : input.project_id,
    portfolio_id: type === "portfolio" ? related.related_id : input.portfolio_id,
    support_case_id: type === "support_case" ? related.related_id : input.support_case_id,
    meeting_id: type === "meeting" ? related.related_id : input.meeting_id,
  }, { actorEmail: context.actorEmail || "office" });
  return record;
}

function canCreateActivityForRelatedObject(authContext, relatedType) {
  const type = text(relatedType).toLowerCase();
  return hasPermission(authContext, ACTIVITY_MANAGE_PERMISSIONS[type]) || hasPermission(authContext, "crm.manage");
}

async function listRelatedActivities(store, authContext, relatedType, relatedId) {
  const related = await validateRelatedObject(store, authContext, relatedType, relatedId);
  const rows = await listCorporateRecords(store, "activities");
  return rows.filter((activity) => {
    if (activity.related_type === related.related_type && String(activity.related_id) === String(related.related_id)) return true;
    if (related.related_type === "project" && String(activity.project_id || "") === String(related.related_id)) return true;
    if (related.related_type === "portfolio" && String(activity.portfolio_id || "") === String(related.related_id)) return true;
    if (related.related_type === "support_case" && String(activity.support_case_id || "") === String(related.related_id)) return true;
    return false;
  });
}

function ensureHandoffState(store) {
  if (store?.state && !Array.isArray(store.state.office_handoffs)) store.state.office_handoffs = [];
  return store?.state?.office_handoffs || [];
}

async function readHandoffs(store) {
  if (store?.state) return ensureHandoffState(store);
  if (store?.safeGet) return store.safeGet("/office_handoffs?order=created_at.asc");
  return [];
}

function safeHandoffProjection(handoff = {}) {
  return {
    handoff_id: text(handoff.handoff_id || handoff.id),
    communications_session_id: text(handoff.communications_session_id),
    public_session_id: text(handoff.public_session_id),
    oyi_thread_id: text(handoff.oyi_thread_id),
    business_unit: text(handoff.business_unit, "corporate").toLowerCase(),
    requested_capability: text(handoff.requested_capability, "corporate.office_desk").toLowerCase(),
    media_mode: text(handoff.media_mode, "chat").toLowerCase(),
    reason: text(handoff.reason, "Human assistance requested.").slice(0, 600),
    status: text(handoff.status, "requested").toLowerCase(),
    priority: text(handoff.priority, "normal").toLowerCase(),
    assigned_staff_id: text(handoff.assigned_staff_id),
    crm_contact_ref: text(handoff.crm_contact_ref || handoff.contact_id),
    crm_opportunity_ref: text(handoff.crm_opportunity_ref || handoff.opportunity_id),
    safe_visitor_context: typeof handoff.safe_visitor_context === "object" && handoff.safe_visitor_context ? handoff.safe_visitor_context : {},
    created_at: text(handoff.created_at, nowIso()),
    updated_at: text(handoff.updated_at, handoff.created_at || nowIso()),
  };
}

function canSeeHandoff(authContext = {}, handoff = {}) {
  if (hasPermission(authContext, "office.manage") || hasPermission(authContext, "support.assign")) return true;
  if (!hasPermission(authContext, "office.read") && !hasPermission(authContext, "support.read")) return false;
  const permissions = Array.isArray(authContext.permissions) ? authContext.permissions : [];
  const unit = text(handoff.business_unit).toLowerCase();
  const capability = text(handoff.requested_capability).toLowerCase();
  return permissions.includes(`${unit}.handoff`) || permissions.includes(capability) || hasPermission(authContext, `${unit}.read`) || hasPermission(authContext, "office.read");
}

async function listHandoffQueue(store, authContext, filter = {}) {
  const rows = (await readHandoffs(store)).map(safeHandoffProjection);
  return rows
    .filter((item) => canSeeHandoff(authContext, item))
    .filter((item) => !filter.status || item.status === filter.status)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

async function createOrUpdateHandoff(store, input = {}) {
  const now = nowIso();
  const item = safeHandoffProjection({
    id: input.handoff_id || input.id || `handoff_${crypto.randomUUID()}`,
    created_at: input.created_at || now,
    updated_at: now,
    ...input,
  });
  if (store?.client) {
    const response = await store.client.post("/office_handoffs", item, {
      headers: {
        ...(store.selectHeaders ? store.selectHeaders() : {}),
        Prefer: "resolution=merge-duplicates,return=representation",
      },
    });
    return safeHandoffProjection(response.data?.[0] || item);
  }
  const rows = ensureHandoffState(store);
  const index = rows.findIndex((row) => String(row.handoff_id || row.id) === String(item.handoff_id));
  if (index >= 0) rows[index] = { ...rows[index], ...item };
  else rows.push(item);
  if (store?.persist) await store.persist();
  return item;
}

async function updateHandoff(store, authContext, handoffId, action, input = {}) {
  const rows = await readHandoffs(store);
  const index = rows.findIndex((row) => String(row.handoff_id || row.id) === String(handoffId));
  if (index < 0) throw errorWithStatus("handoff_not_found", 404);
  const current = safeHandoffProjection(rows[index]);
  if (!canSeeHandoff(authContext, current)) throw errorWithStatus("forbidden_handoff", 403);
  const patch = { updated_at: nowIso() };
  if (action === "accept") {
    if (!hasPermission(authContext, "office.manage") && !hasPermission(authContext, "support.assign")) throw errorWithStatus("forbidden_handoff_accept", 403);
    patch.status = "accepted";
    patch.assigned_staff_id = text(input.staff_id || authContext.userId || authContext.email);
    patch.accepted_at = nowIso();
  } else if (action === "decline") {
    patch.status = "declined";
    patch.declined_at = nowIso();
    patch.decline_reason = text(input.reason);
  } else if (action === "assign") {
    if (!hasPermission(authContext, "office.manage") && !hasPermission(authContext, "support.assign")) throw errorWithStatus("forbidden_handoff_assign", 403);
    const route = chooseStaffForHandoff({ staffCapabilities: input.staff_capabilities || [], handoff: current, existingOwnerId: input.staff_id });
    if (route.status !== "matched" && !input.staff_id) throw errorWithStatus("no_available_staff", 409);
    patch.status = "offered";
    patch.assigned_staff_id = text(input.staff_id || route.staff?.staff_id);
  } else if (action === "callback") {
    patch.status = "callback_requested";
    patch.callback_requested_at = nowIso();
  } else {
    throw errorWithStatus("unsupported_handoff_action", 404);
  }
  const next = { ...rows[index], ...patch };
  if (store?.client) {
    const response = await store.client.patch(`/office_handoffs?handoff_id=eq.${encodeURIComponent(handoffId)}`, next, {
      headers: store.selectHeaders ? store.selectHeaders() : undefined,
    });
    return safeHandoffProjection(response.data?.[0] || next);
  }
  rows[index] = next;
  if (store?.persist) await store.persist();
  return safeHandoffProjection(next);
}

module.exports = {
  FIELD_POLICY,
  STATUS_TRANSITIONS,
  canCreateActivityForRelatedObject,
  createOrUpdateHandoff,
  createRelatedActivity,
  deleteCorporateRecord,
  findCorporateRecord,
  listHandoffQueue,
  listRelatedActivities,
  persistCorporateRecord,
  safeHandoffProjection,
  updateHandoff,
  updateOperationalRecord,
  validateOperationalRelationships,
  validateRelatedObject,
};
