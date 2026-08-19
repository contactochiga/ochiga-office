const assert = require("assert/strict");
const fs = require("fs");
const {
  buildOfficeHomeProjection,
  createCorporateRecord,
  listCorporateRecords,
  upsertContactIdentity,
  validateCommercialDocumentDraft,
} = require("../src/lead-agents/office-operating-system");
const { permissionsForRole, hasPermission } = require("../src/lead-agents/permissions");
const {
  buildOyiCoreOfficeInternalRequest,
  callOyiCoreOfficeInternalConversation,
} = require("../src/lead-agents/oyi-core-gateway");
const { createTempStore } = require("../src/lead-agents/testing");

function routeSegment(pathname) {
  const source = fs.readFileSync("src/lead-agents/server.js", "utf8");
  const start = source.indexOf(`pathname === "${pathname}"`);
  assert.ok(start > 0, `${pathname} route must exist`);
  return source.slice(start, start + 2200);
}

async function main() {
  const { store } = await createTempStore();
  const contactA = await upsertContactIdentity(store, {
    name: "Ada Okafor",
    email: "ada@example.com",
    role: "Director",
    business_unit: "technology",
  });
  const contactB = await upsertContactIdentity(store, {
    name: "Ada O.",
    email: "ada@example.com",
    business_unit: "private",
  });
  assert.equal(contactA.id, contactB.id, "contact identity must deduplicate by email");
  assert.equal((await listCorporateRecords(store, "contacts")).length, 1);

  const org = await createCorporateRecord(store, "organizations", {
    name: "Greenview Estates",
    account_type: "customer",
  });
  const opportunity = await createCorporateRecord(store, "opportunities", {
    contact_id: contactA.id,
    organization_id: org.id,
    business_unit: "development",
    inquiry_type: "land_jv",
    stage: "qualified",
  });
  assert.equal(opportunity.business_unit, "development");
  assert.equal(opportunity.organization_id, org.id);

  const project = await createCorporateRecord(store, "projects", {
    name: "Greenview Mixed Use",
    linked_opportunity_id: opportunity.id,
    organization_id: org.id,
    stage: "approved",
  });
  assert.equal(project.linked_opportunity_id, opportunity.id);

  const portfolio = await createCorporateRecord(store, "portfolio", {
    name: "Greenview Tower A",
    project_id: project.id,
    backend_building_id: "backend-building-1",
    relationship_type: "oyi_deployment",
    health_summary: "Deployment healthy. Operational details remain in Backend/Facility.",
    metadata: {
      safe_projection_only: true,
    },
  });
  assert.equal(portfolio.backend_building_id, "backend-building-1");
  assert.ok(!JSON.stringify(portfolio).includes("wallet_balance"));
  assert.ok(!JSON.stringify(portfolio).includes("visitor_code"));

  const support = await createCorporateRecord(store, "support", {
    title: "Facility escalation for integration issue",
    portfolio_id: portfolio.id,
    backend_incident_ref: "backend-incident-1",
    priority: "high",
    severity: "high",
  });
  assert.equal(support.backend_incident_ref, "backend-incident-1");

  await createCorporateRecord(store, "private", {
    contact_id: contactA.id,
    opportunity_id: opportunity.id,
    relationship_type: "membership",
    review_status: "pending_review",
  });
  await createCorporateRecord(store, "partnerships", {
    organization_id: org.id,
    relationship_type: "technology_integrator",
    review_status: "active",
  });
  await createCorporateRecord(store, "tasks", {
    title: "Follow up with Ada",
    opportunity_id: opportunity.id,
    due_at: "2026-08-20T09:00:00.000Z",
  });
  await createCorporateRecord(store, "meetings", {
    title: "Deployment review",
    related_type: "opportunity",
    related_id: opportunity.id,
  });

  const pricing = validateCommercialDocumentDraft({
    title: "Deployment quote",
    units: 32,
  });
  assert.equal(pricing.allowed_to_price, false);
  assert.equal(pricing.pricing_status, "requires_staff_input");
  assert.equal(validateCommercialDocumentDraft({ approved_price_ref: "pricebook-1" }).allowed_to_price, true);

  const home = await buildOfficeHomeProjection(store);
  assert.ok(home.summary.open_tasks >= 1);
  assert.ok(home.summary.open_support_cases >= 1);
  assert.equal(home.oyi_core.expected_surface, "office_internal");

  const staffPermissions = permissionsForRole("ochiga_staff");
  assert.ok(staffPermissions.includes("office.intelligence"));
  assert.ok(hasPermission({ type: "session", role: "ochiga_staff", permissionScopes: [] }, "office.intelligence"));
  assert.equal(hasPermission({ type: "session", role: "sales", permissionScopes: [] }, "devices.control"), false);

  // buildOyiCoreOfficeInternalRequest is async (it computes a real
  // permission-gated operational_snapshot from `store` — see
  // oyi-core-gateway.js) — must be awaited, and passing the real temp
  // store here exercises that snapshot computation for real instead of
  // silently getting operational_snapshot: null.
  const request = await buildOyiCoreOfficeInternalRequest({
    authContext: {
      userId: "staff-1",
      email: "staff@example.com",
      role: "ochiga_staff",
      permissions: staffPermissions,
    },
    message: "Which support cases need attention?",
    body: {
      office_session_id: "office-session-1",
      business_unit: "technology",
      support_context: { support_case_ref: support.id, safe_summary: support.title },
    },
    requestId: "req-office-1",
    store,
  });
  assert.equal(request.office_session_id, "office-session-1");
  assert.equal(request.staff.email, "staff@example.com");
  assert.equal(request.business_unit, "technology");
  assert.equal(request.support_context.support_case_ref, support.id);

  const response = await callOyiCoreOfficeInternalConversation(
    {
      officeBackendBaseUrl: "https://backend.example",
      officeBackendInternalConversationPath: "/office/conversation/internal",
      officeBackendApiKey: "test-key",
    },
    request,
    {
      httpPost: async (url, payload, config) => {
        assert.equal(url, "https://backend.example/office/conversation/internal");
        assert.equal(config.headers["x-office-api-key"], "test-key");
        assert.equal(payload.office_session_id, "office-session-1");
        return {
          status: 200,
          data: {
            ok: true,
            surface: "office_internal",
            answer: "Two support cases need attention.",
            conversation_thread_id: "oyi-office-thread-1",
            tool_proposals: [],
          },
        };
      },
    }
  );
  assert.equal(response.ok, true);
  assert.equal(response.response.surface, "office_internal");

  const chatRoute = routeSegment("/api/lead-agents/chat");
  assert.ok(chatRoute.includes("callOyiCoreOfficeInternalConversation"));
  assert.ok(!chatRoute.includes("runtime.runChat"), "authenticated Office chat must not use local reasoning runtime");
  const whatsappSource = fs.readFileSync("src/lead-agents/server.js", "utf8").match(/async function processWhatsAppEvent[\s\S]*?async function bootstrapAdminUser/)[0];
  assert.ok(whatsappSource.includes("callOyiCoreCorporateConversation"));
  assert.ok(!whatsappSource.includes("runtime.runChat"), "WhatsApp customer channel must not use local reasoning runtime");

  console.log("office operating system smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
