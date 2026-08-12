const assert = require("assert/strict");
const fs = require("fs");
const {
  buildOfficeHomeProjection,
  createCorporateRecord,
} = require("../src/lead-agents/office-operating-system");
const { normalizeLeadPatch } = require("../src/lead-agents/normalize-lead");
const { createTempStore } = require("../src/lead-agents/testing");

function read(path) {
  return fs.readFileSync(path, "utf8");
}

async function main() {
  const { store } = await createTempStore();
  const lead = await store.createLead({
    name: "Ada Okafor",
    company: "Lekki Gardens Estate",
    role: "Director",
    email: "ada@example.com",
    phone: "+234 800 000 0000",
    whatsapp_phone: "+234 800 000 0001",
    primary_channel: "website",
    source_channel: "website",
    source: "ochiga_website",
    business_unit: "technology",
    inquiry_type: "oyi_deployment_request",
    location: "Lekki",
    city: "Lagos",
    country: "Nigeria",
    unit_count: 240,
    project_type: "estate",
    property_type: "residential",
    property_size: "large",
    number_of_units: 240,
    pain_points: "Access control",
    budget_range: "enterprise",
    timeline: "Q4",
    decision_maker_status: "decision_maker",
    interest_package: "pro",
    lead_score: 82,
    qualification_status: "qualified",
    stage: "qualified",
    status: "sales",
    owner: "sales_agent",
    commercial_stage: "proposal",
    lost_reason: "",
    score: 82,
    summary: "Technology deployment prospect.",
    next_action: "Prepare proposal",
    next_action_at: "2026-08-20T09:00:00.000Z",
    last_contact_at: "2026-08-10T09:00:00.000Z",
    notes: "Priority account.",
  });

  const before = await store.getLead(lead.id);
  const updated = await store.updateLead(lead.id, { next_action: "Confirm deployment date" });
  assert.equal(updated.next_action, "Confirm deployment date");
  for (const field of [
    "name", "company", "role", "email", "phone", "whatsapp_phone", "primary_channel", "source_channel",
    "source", "business_unit", "inquiry_type", "location", "city", "country", "unit_count", "project_type",
    "property_type", "property_size", "number_of_units", "pain_points", "budget_range", "timeline",
    "decision_maker_status", "interest_package", "lead_score", "qualification_status", "stage", "status",
    "owner", "commercial_stage", "lost_reason", "score", "summary", "next_action_at", "last_contact_at", "notes",
  ]) {
    assert.deepEqual(updated[field], before[field], `partial PATCH must preserve ${field}`);
  }

  const cleared = await store.updateLead(lead.id, { summary: null });
  assert.equal(cleared.summary, "", "explicit null clears nullable text fields through existing empty-string convention");
  const numericNull = await store.updateLead(lead.id, { score: null });
  assert.equal(numericNull.score, 82, "explicit null does not clear numeric fields without a nullable numeric contract");
  const omitted = normalizeLeadPatch({ next_action: "Only this" });
  assert.deepEqual(Object.keys(omitted), ["next_action"]);
  assert.throws(() => normalizeLeadPatch({ score: "not-a-number" }), /invalid_score/);

  const sequentialA = await store.updateLead(lead.id, { owner: "sales_agent_2" });
  const sequentialB = await store.updateLead(lead.id, { status: "qualified" });
  assert.equal(sequentialB.owner, "sales_agent_2", "sequential sparse patches must preserve prior update");
  assert.equal(sequentialA.next_action, "Confirm deployment date");
  assert.equal(sequentialB.status, "qualified");

  const detail = await store.getLead(lead.id);
  const list = await store.listLeads();
  assert.equal(detail.business_unit, "technology");
  assert.equal(detail.inquiry_type, "oyi_deployment_request");
  assert.equal(list.find((item) => item.id === lead.id).business_unit, "technology");
  assert.equal(list.find((item) => item.id === lead.id).inquiry_type, "oyi_deployment_request");
  store.state.leads.push({ id: "legacy-lead", name: "Legacy", created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" });
  assert.equal((await store.getLead("legacy-lead")).business_unit ?? null, null);

  await createCorporateRecord(store, "activities", {
    id: "activity-old",
    title: "Old activity",
    body: "Older CRM activity.",
    activity_type: "note",
    business_unit: "corporate",
    occurred_at: "2026-08-01T10:00:00.000Z",
    metadata: { private_payload: "must_not_project" },
  });
  await createCorporateRecord(store, "activities", {
    id: "activity-new",
    title: "New proposal activity",
    body: "Proposal moved forward.",
    activity_type: "proposal",
    business_unit: "technology",
    lead_id: lead.id,
    occurred_at: "2026-08-12T10:00:00.000Z",
    metadata: { private_payload: "must_not_project" },
  });
  const home = await buildOfficeHomeProjection(store);
  assert.equal(home.recent_activity.length >= 2, true);
  assert.equal(home.recent_activity[0].id, "activity-new");
  assert.equal(home.recent_activity[0].related_object_type, "lead");
  assert.equal(home.recent_activity[0].business_unit, "technology");
  assert.equal(JSON.stringify(home.recent_activity).includes("private_payload"), false);
  assert.ok(home.recent_activity.length <= 12);
  const restrictedHome = await buildOfficeHomeProjection(store, { includeRecentActivity: false });
  assert.deepEqual(restrictedHome.recent_activity, [], "Home projection must omit CRM activity when caller lacks crm.read visibility");

  const serverSource = read("src/lead-agents/server.js");
  assert.match(serverSource, /const widgetRateLimiter = publicRateLimiter \|\| rateLimiter/);
  assert.match(serverSource, /const officeInternalRateLimiter = rateLimiter/);
  assert.match(serverSource, /officeInternalRateLimiter\.check\(req\)/);
  assert.match(serverSource, /widgetRateLimiter\.check\(req\)/);
  assert.doesNotMatch(
    serverSource.match(/authContext = await enrichAuthContext[\s\S]*?if \(pathname === "\/healthz"/)[0],
    /widgetRateLimiter\.check\(req\)/,
    "authenticated Office routes must not consume the public widget limiter"
  );

  const routeSource = serverSource.match(/const leadMatch = pathname\.match[\s\S]*?methodNotAllowed\(res, "GET,PATCH"\);/)[0];
  assert.match(routeSource, /sparseLeadPatchFromBody\(body\)/);
  assert.doesNotMatch(routeSource, /name: body\.name[\s\S]*notes: body\.notes/);

  console.log("office contract hardening smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
