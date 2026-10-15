const assert = require("node:assert/strict");
const { createTempStore } = require("../src/lead-agents/testing");
const visibility = require("../src/lead-agents/whatsapp-inbound-visibility");

// Store-level contract of the inbound visibility helpers, written against the store API only so it runs identically on the file store and (in the P0 hardening harness) the
// real SupabaseLeadAgentsStore -> PostgREST -> hardened PostgreSQL.
async function main() {
  const { store } = await createTempStore();
  const lead = await store.createLead({ name: "Visibility Store", source: "whatsapp", whatsapp_phone: "2348077700001", status: "new" });
  const meta = (id, text, ts) => ({ id, from: "2348077700001", timestamp: String(ts), type: "text", text: { body: text } });
  const now = Math.floor(Date.now() / 1000);
  const eventFor = async (id, text, ts) => store.appendInboundEvent({ channel: "whatsapp", provider: "meta", event_type: "message", lead_id: lead.id, external_event_id: id, payload: meta(id, text, ts) });

  // intake: one canonical record, idempotent on the provider message id
  const e1 = await eventFor("wamid.store.1", "Hello from the store test", now - 600);
  const r1 = await visibility.recordInboundActivity(store, { lead, event: { message_id: "wamid.store.1", from: "2348077700001" }, inboundEvent: e1, requestId: "req-1" });
  assert.equal(r1.ok, true); assert.equal(r1.created, true);
  const r1b = await visibility.recordInboundActivity(store, { lead, event: { message_id: "wamid.store.1" }, inboundEvent: e1, requestId: "req-1b" });
  assert.equal(r1b.ok, true); assert.equal(r1b.created, false, "a second attempt finds the existing record instead of creating another");
  const found = await store.findCrmActivityByProviderMessageId("wamid.store.1");
  assert.ok(found && found.id); assert.equal(found.lead_id, lead.id); assert.equal(found.body, "Hello from the store test"); assert.equal(found.metadata.provider_message_id, "wamid.store.1"); assert.equal(found.metadata.direction, "inbound"); assert.equal(found.metadata.source_event_id, e1.id);
  assert.equal(new Date(found.occurred_at).toISOString(), new Date((now - 600) * 1000).toISOString(), "original provider timestamp preserved");
  assert.equal(await store.findCrmActivityByProviderMessageId("wamid.store.unknown"), null);
  console.log("Store. Idempotent canonical record with provider id, lead, original timestamp — PASS");

  // annotation merges metadata and never creates a second record
  assert.equal(await visibility.annotateInboundActivity(store, { lead, event: { message_id: "wamid.store.1" }, inboundEvent: e1, requestId: "req-2", patch: { suppressed_reason: "ai_paused", ai_replied: false } }), true);
  const annotated = await store.findCrmActivityByProviderMessageId("wamid.store.1"); assert.equal(annotated.metadata.suppressed_reason, "ai_paused"); assert.equal(annotated.metadata.provider_message_id, "wamid.store.1", "existing metadata is kept");
  assert.equal((await store.listCrmActivitiesForWhatsApp()).filter((a) => a.lead_id === lead.id).length, 1);
  console.log("Store. Annotation merges metadata, no second record — PASS");

  // events without any activity are found and repaired idempotently; originals never change
  await eventFor("wamid.store.2", "Please call me", now - 500); await eventFor("wamid.store.3", "Second identical", now - 400); await eventFor("wamid.store.4", "Second identical", now - 399);
  const listed = await store.listInboundMessageEvents({ leadId: lead.id, limit: 100 }); assert.equal(listed.length, 4); assert.deepEqual(listed.map((e) => e.external_event_id), ["wamid.store.1", "wamid.store.2", "wamid.store.3", "wamid.store.4"], "ordered oldest to newest");
  const eventsBefore = JSON.stringify(listed.map((e) => [e.id, e.external_event_id, e.payload]));
  const missing = (await visibility.findMissingInboundActivities(store)).would_create; assert.deepEqual(missing.filter((e) => e.lead_id === lead.id).map((e) => e.provider_message_id).sort(), ["wamid.store.2", "wamid.store.3", "wamid.store.4"]);
  const dry = await visibility.repairInboundVisibility(store, { dryRun: true }); assert.equal(dry.dry_run, true); assert.ok(dry.unique_missing_messages >= 3); assert.equal((await store.listCrmActivitiesForWhatsApp()).filter((a) => a.lead_id === lead.id).length, 1, "a dry run writes nothing");
  const applied = await visibility.repairInboundVisibility(store, { dryRun: false }); assert.equal(applied.failed, 0); assert.ok(applied.created >= 3);
  const activities = (await store.listCrmActivitiesForWhatsApp()).filter((a) => a.lead_id === lead.id); assert.equal(activities.length, 4, "exactly one activity per message, identical texts included");
  assert.deepEqual(activities.map((a) => a.metadata.provider_message_id).sort(), ["wamid.store.1", "wamid.store.2", "wamid.store.3", "wamid.store.4"]);
  const again = await visibility.repairInboundVisibility(store, { dryRun: false }); assert.equal(again.created, 0); assert.equal(again.missing, 0, "a second run finds nothing");
  assert.equal(JSON.stringify((await store.listInboundMessageEvents({ leadId: lead.id, limit: 100 })).map((e) => [e.id, e.external_event_id, e.payload])), eventsBefore, "original inbound events untouched");
  console.log("Store. Missing records found and repaired idempotently; events untouched — PASS");
  console.log(JSON.stringify({ status: "PASS", suite: "whatsapp-inbound-visibility-store" }));
}
main().catch((error) => { console.error(error); process.exit(1); });
