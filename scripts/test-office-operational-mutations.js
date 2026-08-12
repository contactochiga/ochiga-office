const assert = require("assert/strict");
const { FileLeadAgentsStore } = require("../src/lead-agents/store-file");
const {
  createCorporateRecord,
  listCorporateRecords,
  buildOfficeHomeProjection,
} = require("../src/lead-agents/office-operating-system");
const {
  canCreateActivityForRelatedObject,
  createOrUpdateHandoff,
  createRelatedActivity,
  listHandoffQueue,
  listRelatedActivities,
  updateHandoff,
  updateOperationalRecord,
  validateOperationalRelationships,
  validateRelatedObject,
} = require("../src/lead-agents/office-operational-workflows");
const { createTempStore } = require("../src/lead-agents/testing");

const admin = {
  type: "session",
  role: "ochiga_staff",
  email: "staff@example.com",
  userId: "staff-1",
  permissions: [
    "office.read",
    "office.manage",
    "crm.read",
    "crm.manage",
    "tasks.read",
    "tasks.manage",
    "support.read",
    "support.assign",
    "projects.read",
    "projects.manage",
    "portfolio.read",
    "portfolio.manage",
    "meetings.read",
    "meetings.manage",
    "private.read",
    "private.manage",
    "partnerships.read",
    "partnerships.manage",
  ],
};

const supportReader = {
  type: "session",
  role: "guest",
  email: "support@example.com",
  userId: "support-1",
  permissionScopes: ["support.read"],
  permissions: ["support.read"],
};

const unauthorized = {
  type: "session",
  role: "guest",
  email: "guest@example.com",
  userId: "guest-1",
  permissions: [],
};

async function assertRejectsStatus(fn, statusCode, message) {
  await assert.rejects(fn, (error) => error.statusCode === statusCode && (!message || error.message === message));
}

async function main() {
  const { store, filePath } = await createTempStore();
  const lead = await store.createLead({ name: "Ada", email: "ada@example.com", source: "office" });
  const contact = await createCorporateRecord(store, "contacts", { name: "Ada", email: "ada@example.com" });
  const org = await createCorporateRecord(store, "organizations", { name: "Greenview Estates" });
  const opportunity = await createCorporateRecord(store, "opportunities", {
    lead_id: lead.id,
    contact_id: contact.id,
    organization_id: org.id,
    business_unit: "development",
  });
  const project = await createCorporateRecord(store, "projects", {
    name: "Greenview Project",
    status: "planned",
    linked_opportunity_id: opportunity.id,
    organization_id: org.id,
  });
  const portfolio = await createCorporateRecord(store, "portfolio", {
    name: "Greenview Portfolio",
    project_id: project.id,
    backend_building_id: "building-1",
    facility_os_status: "healthy",
  });
  const support = await createCorporateRecord(store, "support", {
    title: "Oyi deployment issue",
    status: "open",
    portfolio_id: portfolio.id,
    backend_incident_ref: "backend-incident-1",
  });
  // Creation-time default must land on the STATUS_TRANSITIONS entry
  // state, not "active" — "active" only transitions to "inactive",
  // which would silently skip the governed request/review/approve
  // pipeline for every relationship created without an explicit
  // review_status (i.e. every relationship created from the UI).
  const privateDefaulted = await createCorporateRecord(store, "private", { contact_id: contact.id });
  assert.equal(privateDefaulted.review_status, "requested");
  const partnershipDefaulted = await createCorporateRecord(store, "partnerships", { contact_id: contact.id });
  assert.equal(partnershipDefaulted.review_status, "new");

  const privateRelationship = await createCorporateRecord(store, "private", {
    contact_id: contact.id,
    organization_id: org.id,
    opportunity_id: opportunity.id,
    relationship_type: "membership",
    review_status: "requested",
    relationship_manager: "private-lead",
    notes: "Original Private notes.",
    business_unit: "private",
  });
  const partnership = await createCorporateRecord(store, "partnerships", {
    contact_id: contact.id,
    organization_id: org.id,
    opportunity_id: opportunity.id,
    relationship_type: "Technology / Custom Integrator",
    review_status: "new",
    relationship_manager: "partner-lead",
    notes: "Original Partnership notes.",
    business_unit: "partnerships",
  });

  const task = await createCorporateRecord(store, "tasks", {
    title: "Prepare proposal",
    status: "open",
    opportunity_id: opportunity.id,
    project_id: project.id,
    due_at: "2026-08-20T09:00:00.000Z",
    metadata: { untouched: true },
  });
  const taskUpdated = await updateOperationalRecord(store, "tasks", task.id, { priority: "high", due_at: "2026-08-21T09:00:00.000Z" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(taskUpdated.record.title, "Prepare proposal");
  assert.equal(taskUpdated.record.priority, "high");
  assert.equal(taskUpdated.record.metadata.untouched, true);
  assert.equal(taskUpdated.record.opportunity_id, opportunity.id);
  const taskStarted = await updateOperationalRecord(store, "tasks", task.id, { status: "in_progress" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(taskStarted.record.status, "in_progress");
  const taskCompleted = await updateOperationalRecord(store, "tasks", task.id, { status: "completed" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(taskCompleted.record.status, "completed");
  assert.ok(taskCompleted.record.completed_at);
  await assertRejectsStatus(() => updateOperationalRecord(store, "tasks", task.id, { status: "open" }, { authContext: admin }), 400, "invalid_tasks_status_transition");
  await assertRejectsStatus(() => updateOperationalRecord(store, "tasks", task.id, { project_id: "missing-project" }, { authContext: admin }), 404, "related_object_not_found");
  await assertRejectsStatus(() => validateOperationalRelationships(store, unauthorized, "tasks", { private_relationship_id: privateRelationship.id }), 403, "forbidden_related_object");
  await assertRejectsStatus(() => validateOperationalRelationships(store, unauthorized, "tasks", { partnership_relationship_id: partnership.id }), 403, "forbidden_related_object");

  const privateTask = await createCorporateRecord(store, "tasks", {
    title: "Review Private profile",
    status: "open",
    private_relationship_id: privateRelationship.id,
    business_unit: "private",
  });
  const partnershipTask = await createCorporateRecord(store, "tasks", {
    title: "Prepare partner briefing",
    status: "open",
    partnership_relationship_id: partnership.id,
    business_unit: "partnerships",
  });
  await validateOperationalRelationships(store, admin, "tasks", { private_relationship_id: privateRelationship.id });
  await validateOperationalRelationships(store, admin, "tasks", { partnership_relationship_id: partnership.id });
  const privateTaskPatched = await updateOperationalRecord(store, "tasks", privateTask.id, { priority: "high" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(privateTaskPatched.record.private_relationship_id, privateRelationship.id);
  const partnershipTaskPatched = await updateOperationalRecord(store, "tasks", partnershipTask.id, { due_at: "2026-08-22T09:00:00.000Z" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(partnershipTaskPatched.record.partnership_relationship_id, partnership.id);

  const supportAssigned = await updateOperationalRecord(store, "support", support.id, { assigned_staff: "support-agent", status: "in_progress" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(supportAssigned.record.assigned_staff, "support-agent");
  assert.equal(supportAssigned.record.backend_incident_ref, "backend-incident-1");
  await assertRejectsStatus(() => updateOperationalRecord(store, "support", support.id, { status: "resolved" }, { authContext: admin }), 400, "resolution_notes_required");
  const supportResolved = await updateOperationalRecord(store, "support", support.id, { status: "resolved", resolution_notes: "Resolved by staff." }, { authContext: admin, actorEmail: admin.email });
  assert.ok(supportResolved.record.resolved_at);
  const supportReopened = await updateOperationalRecord(store, "support", support.id, { status: "in_progress" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(supportReopened.record.status, "in_progress");
  await assertRejectsStatus(() => validateRelatedObject(store, unauthorized, "support_case", support.id), 403, "forbidden_related_object");

  const privateReview = await updateOperationalRecord(store, "private", privateRelationship.id, { review_status: "under_review", relationship_manager: "private-manager" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(privateReview.record.review_status, "under_review");
  assert.equal(privateReview.record.relationship_manager, "private-manager");
  assert.equal(privateReview.record.contact_id, contact.id);
  assert.equal(privateReview.record.organization_id, org.id);
  assert.equal(privateReview.record.opportunity_id, opportunity.id);
  assert.equal(privateReview.record.notes, "Original Private notes.");
  const privateApproved = await updateOperationalRecord(store, "private", privateRelationship.id, { review_status: "approved" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(privateApproved.record.review_status, "approved");
  const privateActive = await updateOperationalRecord(store, "private", privateRelationship.id, { review_status: "active" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(privateActive.record.review_status, "active");
  const privateNotesCleared = await updateOperationalRecord(store, "private", privateRelationship.id, { notes: null }, { authContext: admin, actorEmail: admin.email });
  assert.equal(privateNotesCleared.record.notes, "");
  await assertRejectsStatus(() => updateOperationalRecord(store, "private", privateRelationship.id, { contact_id: null }, { authContext: admin }), 400, "relationship_identity_reference_required");
  await assertRejectsStatus(() => updateOperationalRecord(store, "private", privateRelationship.id, { review_status: "requested" }, { authContext: admin }), 400, "invalid_private_status_transition");
  await assertRejectsStatus(() => validateRelatedObject(store, unauthorized, "private_relationship", privateRelationship.id), 403, "forbidden_related_object");

  const partnershipReview = await updateOperationalRecord(store, "partnerships", partnership.id, { review_status: "under_review", relationship_manager: "partnership-manager" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(partnershipReview.record.review_status, "under_review");
  assert.equal(partnershipReview.record.relationship_type, "Technology / Custom Integrator");
  assert.equal(partnershipReview.record.relationship_manager, "partnership-manager");
  assert.equal(partnershipReview.record.contact_id, contact.id);
  const partnershipActive = await updateOperationalRecord(store, "partnerships", partnership.id, { review_status: "active" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(partnershipActive.record.review_status, "active");
  const partnershipPaused = await updateOperationalRecord(store, "partnerships", partnership.id, { review_status: "paused" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(partnershipPaused.record.review_status, "paused");
  await assertRejectsStatus(() => updateOperationalRecord(store, "partnerships", partnership.id, { organization_id: null }, { authContext: admin }), 400, "relationship_identity_reference_required");
  await assertRejectsStatus(() => updateOperationalRecord(store, "partnerships", partnership.id, { review_status: "new" }, { authContext: admin }), 400, "invalid_partnerships_status_transition");
  await assertRejectsStatus(() => validateRelatedObject(store, unauthorized, "partnership_relationship", partnership.id), 403, "forbidden_related_object");

  const projectActive = await updateOperationalRecord(store, "projects", project.id, { status: "active", owner: "pm-1", stage: "active_delivery" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(projectActive.record.owner, "pm-1");
  assert.equal(projectActive.record.linked_opportunity_id, opportunity.id);
  assert.equal(projectActive.record.portfolio_id || null, null);
  const projectDone = await updateOperationalRecord(store, "projects", project.id, { status: "completed" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(projectDone.record.status, "completed");
  await assertRejectsStatus(() => updateOperationalRecord(store, "projects", project.id, { status: "active" }, { authContext: admin }), 400, "invalid_projects_status_transition");

  const portfolioPatched = await updateOperationalRecord(store, "portfolio", portfolio.id, { support_status: "attention", owner: "relationship-manager", backend_building_id: "malicious-change" }, { authContext: admin, actorEmail: admin.email });
  assert.equal(portfolioPatched.record.support_status, "attention");
  assert.equal(portfolioPatched.record.owner, "relationship-manager");
  assert.equal(portfolioPatched.record.backend_building_id, "building-1", "Portfolio PATCH must not mutate Facility/Backend operational identifiers");

  const meeting = await createCorporateRecord(store, "meetings", {
    title: "Deployment kickoff",
    status: "scheduled",
    related_type: "project",
    related_id: project.id,
    scheduled_at: "2026-08-24T10:00:00.000Z",
  });
  const rescheduled = await updateOperationalRecord(store, "meetings", meeting.id, { scheduled_at: "2026-08-25T10:00:00.000Z", notes: "Moved by request." }, { authContext: admin, actorEmail: admin.email });
  assert.equal(rescheduled.record.related_id, project.id);
  const completedMeeting = await updateOperationalRecord(store, "meetings", meeting.id, { status: "completed", outcome: "Proceed to proposal.", follow_up_task_id: task.id }, { authContext: admin, actorEmail: admin.email });
  assert.ok(completedMeeting.record.completed_at);
  assert.equal(completedMeeting.record.follow_up_task_id, task.id);
  const cancelledMeeting = await createCorporateRecord(store, "meetings", { title: "Cancel me", status: "scheduled" });
  const cancelled = await updateOperationalRecord(store, "meetings", cancelledMeeting.id, { status: "cancelled" }, { authContext: admin, actorEmail: admin.email });
  assert.ok(cancelled.record.cancelled_at);

  const projectNote = await createRelatedActivity(store, { related_type: "project", related_id: project.id, title: "Project note", body: "Important project update." }, { authContext: admin, actorEmail: admin.email });
  const portfolioNote = await createRelatedActivity(store, { related_type: "portfolio", related_id: portfolio.id, title: "Portfolio note", body: "Corporate relationship update." }, { authContext: admin, actorEmail: admin.email });
  const supportNote = await createRelatedActivity(store, { related_type: "support_case", related_id: support.id, title: "Support note", body: "Support update." }, { authContext: admin, actorEmail: admin.email });
  assert.equal(projectNote.project_id, project.id);
  assert.equal(portfolioNote.portfolio_id, portfolio.id);
  assert.equal(supportNote.support_case_id, support.id);
  assert.equal((await listRelatedActivities(store, admin, "project", project.id)).some((item) => item.id === projectNote.id), true);
  await assertRejectsStatus(() => createRelatedActivity(store, { related_type: "portfolio", related_id: "missing", title: "Bad" }, { authContext: admin }), 404, "related_object_not_found");
  assert.equal(canCreateActivityForRelatedObject({ type: "session", role: "guest", permissionScopes: ["projects.manage"], permissions: ["projects.manage"] }, "project"), true);
  assert.equal(canCreateActivityForRelatedObject({ type: "session", role: "guest", permissionScopes: ["support.read"], permissions: ["support.read"] }, "support_case"), false);
  const home = await buildOfficeHomeProjection(store);
  assert.ok(home.recent_activity.some((item) => item.related_object_type === "project"));
  assert.ok(home.attention_items.some((item) => item.related_object_type === "private_relationship" && item.related_object_id === privateRelationship.id));
  assert.ok(home.attention_items.some((item) => item.related_object_type === "partnership_relationship" && item.related_object_id === partnership.id));
  assert.equal(home.attention_items.filter((item) => item.related_object_id === privateRelationship.id).length, 1);

  const handoff = await createOrUpdateHandoff(store, {
    handoff_id: "handoff-1",
    communications_session_id: "comm-1",
    public_session_id: "public-1",
    oyi_thread_id: "oyi-1",
    business_unit: "technology",
    requested_capability: "technology.technical",
    media_mode: "video",
    reason: "Visitor needs a technical specialist.",
    safe_visitor_context: { organization: "Greenview" },
    metadata: { raw_sdp: "must-not-leak", turn_token: "must-not-leak" },
  });
  assert.equal(handoff.media_mode, "video");
  const visible = await listHandoffQueue(store, admin, { status: "requested" });
  assert.equal(visible.length, 1);
  assert.equal(JSON.stringify(visible).includes("raw_sdp"), false);
  assert.equal((await listHandoffQueue(store, supportReader, { status: "requested" })).length, 0);
  const assigned = await updateHandoff(store, admin, "handoff-1", "assign", {
    staff_capabilities: [{
      staff_id: "tech-1",
      business_unit: "technology",
      capability: "technology.technical",
      availability: "available",
      permissions: ["communications.join"],
    }],
  });
  assert.equal(assigned.assigned_staff_id, "tech-1");
  const accepted = await updateHandoff(store, admin, "handoff-1", "accept", { staff_id: "tech-1" });
  assert.equal(accepted.status, "accepted");
  const declined = await createOrUpdateHandoff(store, { handoff_id: "handoff-2", business_unit: "technology", requested_capability: "technology.technical" });
  assert.equal((await updateHandoff(store, admin, declined.handoff_id, "decline", { reason: "Busy" })).status, "declined");
  const callback = await createOrUpdateHandoff(store, { handoff_id: "handoff-3", business_unit: "support", requested_capability: "support.technical" });
  assert.equal((await updateHandoff(store, admin, callback.handoff_id, "callback", {})).status, "callback_requested");

  const activities = await listCorporateRecords(store, "activities");
  assert.ok(activities.some((item) => item.activity_type === "tasks_status_changed"));
  assert.ok(activities.some((item) => item.activity_type === "support_status_changed"));
  assert.ok(activities.some((item) => item.activity_type === "projects_status_changed"));
  assert.ok(activities.some((item) => item.activity_type === "meetings_status_changed"));
  assert.ok(activities.some((item) => item.activity_type === "private_status_changed" && item.related_type === "private_relationship"));
  assert.ok(activities.some((item) => item.activity_type === "partnerships_status_changed" && item.related_type === "partnership_relationship"));

  await store.persist();
  const reloadedStore = new FileLeadAgentsStore(filePath);
  await reloadedStore.init();
  assert.equal((await listCorporateRecords(reloadedStore, "tasks")).filter((item) => item.id === task.id).length, 1);
  assert.equal((await listCorporateRecords(reloadedStore, "tasks")).find((item) => item.id === task.id).status, "completed");
  assert.equal((await listCorporateRecords(reloadedStore, "projects")).find((item) => item.id === project.id).linked_opportunity_id, opportunity.id);
  assert.equal((await listCorporateRecords(reloadedStore, "support")).find((item) => item.id === support.id).backend_incident_ref, "backend-incident-1");
  assert.equal((await listCorporateRecords(reloadedStore, "meetings")).find((item) => item.id === meeting.id).related_id, project.id);
  assert.equal((await listCorporateRecords(reloadedStore, "tasks")).find((item) => item.id === privateTask.id).private_relationship_id, privateRelationship.id);
  assert.equal((await listCorporateRecords(reloadedStore, "tasks")).find((item) => item.id === partnershipTask.id).partnership_relationship_id, partnership.id);
  assert.equal((await listCorporateRecords(reloadedStore, "private")).find((item) => item.id === privateRelationship.id).review_status, "active");
  assert.equal((await listCorporateRecords(reloadedStore, "partnerships")).find((item) => item.id === partnership.id).review_status, "paused");
  assert.equal((await listRelatedActivities(reloadedStore, admin, "support_case", support.id)).some((item) => item.id === supportNote.id), true);
  assert.equal((await listHandoffQueue(reloadedStore, admin, {})).find((item) => item.handoff_id === "handoff-1").status, "accepted");

  console.log("office operational mutation smoke passed");
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
