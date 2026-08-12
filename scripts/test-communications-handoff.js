const assert = require("assert/strict");
const {
  chooseStaffForHandoff,
  buildStaffJoinBrief,
  recordHandoffTimeline,
  createCallbackTask,
  canViewHandoffQueue,
  capabilityCatalog,
} = require("../src/lead-agents/communications-handoff");
const { createTempStore } = require("../src/lead-agents/testing");

(async () => {
  const catalog = capabilityCatalog();
  assert.ok(catalog.some((item) => item.capability === "development.architecture"));
  assert.ok(catalog.some((item) => item.capability === "technology.oyi_deployment"));

  const staffCapabilities = [
    {
      staff_id: "architect-owner",
      business_unit: "development",
      capability: "development.architecture",
      availability: "available",
      routing_priority: 20,
      active_session_count: 2,
      permissions: ["communications.join"],
    },
    {
      staff_id: "architect-busy",
      business_unit: "development",
      capability: "development.architecture",
      availability: "busy",
      routing_priority: 1,
      active_session_count: 0,
      permissions: ["communications.join"],
    },
    {
      staff_id: "architect-best",
      business_unit: "development",
      capability: "development.architecture",
      availability: "available",
      routing_priority: 5,
      active_session_count: 0,
      permissions: ["communications.join"],
    },
  ];

  const ownerRoute = chooseStaffForHandoff({
    staffCapabilities,
    existingOwnerId: "architect-owner",
    handoff: { business_unit: "development", requested_capability: "development.architecture" },
  });
  assert.equal(ownerRoute.status, "matched");
  assert.equal(ownerRoute.staff.staff_id, "architect-owner");
  assert.equal(ownerRoute.reason, "existing_relationship_owner_available");

  const bestRoute = chooseStaffForHandoff({
    staffCapabilities,
    handoff: { business_unit: "development", requested_capability: "development.architecture" },
  });
  assert.equal(bestRoute.staff.staff_id, "architect-best");

  const unavailable = chooseStaffForHandoff({
    staffCapabilities,
    handoff: { business_unit: "technology", requested_capability: "technology.integration" },
  });
  assert.equal(unavailable.status, "unavailable");

  const brief = buildStaffJoinBrief({
    session: {
      session_id: "comm-1",
      public_session_id: "pub-1",
      oyi_thread_id: "oyi-thread-1",
      business_unit: "development",
    },
    handoff: {
      requested_capability: "development.architecture",
      reason: "Visitor is showing a site.",
    },
    lead: {
      id: "lead-1",
      company: "Six Buildings Ltd",
      summary: "Wants Oyi in an existing apartment portfolio.",
    },
  });
  assert.equal(brief.public_session_id, "pub-1");
  assert.equal(brief.oyi_thread_id, "oyi-thread-1");
  assert.equal(brief.customer_context.visitor_known, true);
  assert.ok(!JSON.stringify(brief).includes("chain-of-thought"));

  const { store } = await createTempStore();
  const lead = await store.createLead({
    name: "Ada",
    email: "ada@example.com",
    company: "Six Buildings Ltd",
    source: "website_chat",
  });
  const timeline = await recordHandoffTimeline({
    store,
    lead,
    session: { session_id: "comm-1", public_session_id: "pub-1", oyi_thread_id: "oyi-thread-1" },
    handoff: { handoff_id: "handoff-1", business_unit: "development", requested_capability: "development.architecture" },
    eventType: "staff_joined",
    staffId: "architect-owner",
  });
  assert.equal(timeline.event_type, "staff_joined");
  assert.equal(timeline.metadata.communications_session_id, "comm-1");

  const task = await createCallbackTask({
    store,
    lead,
    session: { session_id: "comm-1", public_session_id: "pub-1" },
    handoff: { handoff_id: "handoff-2", requested_capability: "technology.integration", priority: "high" },
  });
  assert.equal(task.related_type, "communications_handoff");
  assert.equal(task.metadata.fallback_action, "request_callback");
  assert.ok(store.state.tasks.some((item) => item.id === task.id));

  assert.equal(canViewHandoffQueue({ permissions: ["office.read"] }, "office_public"), true);
  assert.equal(canViewHandoffQueue({ permissions: ["support.read"] }, "support"), true);
  assert.equal(canViewHandoffQueue({ permissions: ["crm.read"] }, "office_public"), false);
  assert.equal(canViewHandoffQueue({ permissions: ["office.read"] }, "support"), false);

  console.log("office communications handoff smoke passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
