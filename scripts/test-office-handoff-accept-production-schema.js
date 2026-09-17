// Production Handoff Acceptance Failure -- regression test.
//
// Root cause: office-operational-workflows.js's updateHandoff() has
// always set accepted_at/declined_at/decline_reason/callback_requested_at
// on the office_handoffs PATCH payload, but production Supabase's
// office_handoffs table never had those columns -- PostgREST correctly
// rejects a PATCH referencing an unknown column with 400, and every
// prior Slice 2/3/4 test only ever exercised updateHandoff() against
// FileLeadAgentsStore (a schema-less JS object store), so this never
// surfaced until a real accept ran against production Supabase.
//
// This test reproduces the EXACT production condition without a live
// Postgres connection: it parses db/lead-agents-schema.sql for the
// real, canonical office_handoffs column set (so it can never silently
// drift again) and asserts every field updateHandoff() ever writes is a
// column that schema genuinely declares -- the same check PostgREST
// itself performs on every PATCH.
//
// It also reproduces the second defect found during the same trace:
// accept's old `input.staff_id || authContext.userId || authContext.email`
// precedence meant authContext.userId (a UUID, always truthy for any
// authenticated session) silently won over the real staff email --
// corrupting office_handoffs.assigned_staff_id and, because
// upsertLeadChannelState() runs BEFORE the (failing) PATCH,
// lead_channel_states.human_owner too -- even on a request that then
// failed with 400. This is proven against the exact accepting identity
// from the real production incident (a UUID userId alongside a real
// email), not a synthetic happy path.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const {
  requestHandoffForLead,
  updateHandoff,
} = require("../src/lead-agents/office-operational-workflows");
const { normalizeOfficeIntakeEnvelope, findOrUpsertLead } = require("../src/lead-agents/office-intake");

// Real parse of the schema file's office_handoffs section -- not a
// hand-maintained duplicate list that could itself drift from the
// actual migration.
function officeHandoffsColumnsFromSchema() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "lead-agents-schema.sql"), "utf8");
  const columns = new Set();

  const createMatch = sql.match(/create table if not exists office_handoffs \(([\s\S]*?)\n\);/);
  assert.ok(createMatch, "office_handoffs CREATE TABLE block must exist in the schema file");
  for (const line of createMatch[1].split("\n")) {
    const columnMatch = line.trim().match(/^([a-z_][a-z0-9_]*)\s+\S/i);
    if (columnMatch) columns.add(columnMatch[1]);
  }

  const alterPattern = /alter table office_handoffs add column if not exists\s+([a-z_][a-z0-9_]*)\s/gi;
  let alterMatch;
  while ((alterMatch = alterPattern.exec(sql))) {
    columns.add(alterMatch[1]);
  }

  return columns;
}

async function seedStaff(store, { email, role, availability, capability, businessUnit = "development", routingPriority = 50 }) {
  await store.ensureAdminUser({ email, password_hash: hashPassword("test-pass-123"), role, status: "active", display_name: email });
  await store.upsertStaffProfile(email, { business_unit: businessUnit, availability, routing_priority: routingPriority });
  await store.upsertStaffCapability(email, { capability, specialty: "" });
}

async function main() {
  const knownColumns = officeHandoffsColumnsFromSchema();
  // Sanity: the columns this exact incident was missing must actually
  // be declared now, or this test would pass for the wrong reason.
  for (const required of ["accepted_at", "declined_at", "decline_reason", "callback_requested_at"]) {
    assert.ok(knownColumns.has(required), `schema must declare ${required} (the exact production gap)`);
  }
  console.log(`A. Parsed ${knownColumns.size} real office_handoffs columns from db/lead-agents-schema.sql — PASS`);

  const { store } = await createTempStore();
  await seedStaff(store, { email: "staff@ochiga.local", role: "ochiga_staff", availability: "available", capability: "development.commercial_jv" });
  const envelope = normalizeOfficeIntakeEnvelope({
    request_id: "req-handoff-accept-prod-fix",
    source_site: "ochiga_website",
    source_form: "land_jv",
    business_unit: "development",
    inquiry_type: "land_jv",
    contact: { name: "Accept Fix Lead", email: "accept-fix@example.com", phone: "+2348100000066" },
    organization: { name: "Accept Fix Estates", location: "Lagos" },
    payload: { message: "test" },
    consent: { marketing_followup: true },
  });
  const { lead } = await findOrUpsertLead(store, envelope);
  const { handoff } = await requestHandoffForLead(store, { leadId: lead.id, businessUnit: "development", requestedCapability: "development.commercial_jv", reason: "test" });
  assert.equal(handoff.assigned_staff_id, "staff@ochiga.local");
  assert.equal(handoff.status, "offered");

  // The exact real-world accepting identity: an authenticated session
  // carries BOTH a real admin_users.id (UUID) and the staff's real
  // email -- exactly how authContext looks in production.
  const authContext = { userId: "d626f5ed-4f50-43a8-a140-a26f47c8d7ed", email: "staff@ochiga.local", role: "ochiga_staff" };

  const accepted = await updateHandoff(store, authContext, handoff.handoff_id, "accept", {});
  assert.equal(accepted.status, "accepted");

  // B. Schema-contract proof: safeHandoffProjection() only ever returns
  // a fixed, already-safe field set to callers -- the real bug lived in
  // the RAW row object updateHandoff() builds and would PATCH to
  // Supabase (`next = {...rows[index], ...patch}`), which for
  // FileLeadAgentsStore is exactly what lands in store.state.office_handoffs.
  // This is the same set of keys store.client.patch() would have sent
  // to PostgREST in production.
  const rawRow = store.state.office_handoffs.find((row) => row.handoff_id === handoff.handoff_id);
  assert.ok(rawRow, "the raw handoff row must exist in the store");
  for (const field of Object.keys(rawRow)) {
    assert.ok(knownColumns.has(field), `office_handoffs.${field} is not declared in db/lead-agents-schema.sql -- PostgREST would reject this exact PATCH with 400, reproducing the production incident`);
  }
  console.log("B. The raw PATCH payload's fields are all real, declared office_handoffs columns (would not 400 against production Supabase) — PASS");

  // C. Identity proof: assigned_staff_id must be the real email, never
  // the UUID -- reproduces and proves the fix for the second defect
  // found in the same incident.
  assert.equal(accepted.assigned_staff_id, "staff@ochiga.local", "assigned_staff_id must be the canonical staff email, never authContext.userId's UUID");

  const channelState = await store.getLeadChannelState(lead.id, "whatsapp");
  assert.equal(channelState.human_status, "human_active");
  assert.equal(channelState.human_owner, "staff@ochiga.local", "human_owner must be the canonical staff email, never a UUID -- matches assigned_staff_id exactly");
  console.log("C. accept() resolves the real staff email as assigned_staff_id/human_owner, never authContext.userId's UUID — PASS");

  // D. No-partial-transition proof on a genuine failure path: a
  // forbidden accept attempt must leave BOTH office_handoffs and
  // lead_channel_states completely untouched (the exact property the
  // production incident violated for lead_channel_states specifically).
  const { lead: lead2 } = await findOrUpsertLead(store, {
    ...envelope,
    request_id: "req-handoff-accept-prod-fix-2",
    contact: { ...envelope.contact, email: "accept-fix-2@example.com", phone: "+2348100000077" },
  });
  assert.notEqual(lead2.id, lead.id, "the second synthetic lead must be genuinely independent (distinct email AND phone), not deduped onto the first");
  const { handoff: handoff2 } = await requestHandoffForLead(store, {
    leadId: lead2.id,
    businessUnit: "development",
    requestedCapability: "development.commercial_jv",
    reason: "test 2",
  });
  assert.notEqual(handoff2.handoff_id, handoff.handoff_id, "the second handoff must be a genuinely separate row");
  assert.equal(handoff2.status, "offered");
  // ai_agent can SEE the handoff (holds office.read) but cannot accept
  // it (holds neither office.manage nor support.assign) -- exercises
  // the accept-specific permission check itself, not the earlier
  // visibility gate.
  const unauthorizedContext = { userId: "unrelated-uuid", email: "unrelated@ochiga.local", role: "ai_agent" };
  await assert.rejects(() => updateHandoff(store, unauthorizedContext, handoff2.handoff_id, "accept", {}), /forbidden_handoff_accept/);
  const stillOffered = store.state.office_handoffs.find((h) => h.handoff_id === handoff2.handoff_id);
  assert.equal(stillOffered.status, "offered", "a rejected accept must never partially transition office_handoffs");
  const untouchedChannelState = await store.getLeadChannelState(handoff2.lead_id, "whatsapp");
  assert.notEqual(untouchedChannelState.human_status, "human_active", "a rejected accept must never set lead_channel_states to human_active");
  console.log("D. Forbidden accept leaves office_handoffs and lead_channel_states fully untouched — PASS");

  console.log("office handoff accept production-schema fix smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
