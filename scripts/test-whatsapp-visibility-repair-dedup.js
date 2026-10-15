const assert = require("node:assert/strict");
const { createTempStore } = require("../src/lead-agents/testing");
const { createCorporateRecord } = require("../src/lead-agents/office-operating-system");
const visibility = require("../src/lead-agents/whatsapp-inbound-visibility");

// Historical inbound-visibility repair: it must work on DISTINCT provider message ids (duplicated delivery rows exist in production), pick a deterministic canonical row,
// refuse conflicting lead identities, keep the strict legacy match, create at most one activity per id, be idempotent and concurrency-safe, and never touch the events.
// Store API only, so it also runs against the real Supabase store in the hardened replica.
async function main() {
  const { store } = await createTempStore();
  const mkLead = (n) => store.createLead({ name: `Dedup ${n}`, source: "whatsapp", whatsapp_phone: `23480999000${n}`, status: "new" });
  const [L1, L2, L3] = [await mkLead(1), await mkLead(2), await mkLead(3)];
  const base = Math.floor(Date.now() / 1000) - 5 * 24 * 3600;
  const meta = (id, text, ts) => ({ id, from: "2348099900001", timestamp: String(ts), type: "text", text: { body: text } });
  const addEvent = (leadId, id, text, ts, createdAtMs) => store.appendInboundEvent({ channel: "whatsapp", provider: "meta", event_type: "message", lead_id: leadId, external_event_id: id, payload: meta(id, text, ts), ...(createdAtMs ? { created_at: new Date(createdAtMs).toISOString() } : {}) });
  const addActivity = (leadId, body, atSeconds, providerId) => createCorporateRecord(store, "activities", { lead_id: leadId, related_type: "lead", related_id: leadId, activity_type: "whatsapp_message", title: "WhatsApp message", body, source: "whatsapp", occurred_at: new Date(atSeconds * 1000).toISOString(), metadata: { direction: "inbound", ...(providerId ? { provider_message_id: providerId } : {}) } }, { actorEmail: "whatsapp" });

  // ---- production-shaped fixture: 18 distinct missing ids, 6 of them delivered twice => 24 raw rows / 6 duplicate rows ----
  const missingIds = [];
  for (let i = 1; i <= 18; i++) {
    const id = `wamid.dedup.${String(i).padStart(2, "0")}`; missingIds.push(id);
    const lead = [L1, L2, L3][i % 3]; const ts = base + i * 600;
    await addEvent(lead.id, id, `message number ${i}`, ts);
    if (i <= 6) await addEvent(lead.id, id, `message number ${i}`, ts); // duplicate delivery row of the same provider message
  }
  // already represented messages (must NOT be proposed): one by provider id (with a duplicate row), one by the strict legacy match, one legacy match with a duplicate row
  await addEvent(L1.id, "wamid.rep.id", "has an activity by id", base + 20000); await addEvent(L1.id, "wamid.rep.id", "has an activity by id", base + 20000); await addActivity(L1.id, "has an activity by id", base + 20000, "wamid.rep.id");
  await addEvent(L2.id, "wamid.rep.legacy", "legacy activity text", base + 21000); await addActivity(L2.id, "legacy activity text", base + 21001);
  await addEvent(L3.id, "wamid.rep.legacy.dup", "legacy with duplicate row", base + 22000); await addEvent(L3.id, "wamid.rep.legacy.dup", "legacy with duplicate row", base + 22000); await addActivity(L3.id, "legacy with duplicate row", base + 22002);
  const eventsBefore = JSON.stringify((await store.listInboundMessageEvents({ limit: 1000 })).map((e) => [e.id, e.lead_id, e.external_event_id, e.payload]));

  const dry = await visibility.repairInboundVisibility(store, { dryRun: true });
  assert.equal(dry.raw_missing_event_rows, 24, "24 raw missing event rows"); assert.equal(dry.unique_missing_messages, 18, "18 distinct missing provider message ids");
  assert.equal(dry.duplicate_event_rows, 6, "6 additional duplicate event rows"); assert.equal(dry.invalid_records, 0); assert.equal(dry.conflicting_lead_groups, 0);
  assert.equal(dry.proposed_activities, 18, "at most one proposed activity per provider message id"); assert.equal(dry.already_represented_messages, 3, "messages already represented (by id, by legacy match, legacy match with duplicate row) are excluded");
  assert.deepEqual(dry.would_create_for.map((c) => c.provider_message_id).sort(), missingIds);
  assert.equal(new Set(dry.would_create_for.map((c) => c.provider_message_id)).size, 18);
  const sample = dry.would_create_for.find((c) => c.provider_message_id === "wamid.dedup.03"); assert.equal(sample.duplicate_event_ids.length, 1, "the duplicate row is reported, not proposed"); assert.equal(sample.occurred_at, new Date((base + 3 * 600) * 1000).toISOString(), "original provider timestamp");
  assert.equal(sample.lead_id, [L1, L2, L3][3 % 3].id, "the original lead association is kept");
  assert.equal((await store.listCrmActivitiesForWhatsApp()).filter((a) => String(a.metadata?.provider_message_id || "").startsWith("wamid.dedup.")).length, 0, "a dry run writes nothing");
  const dry2 = await visibility.repairInboundVisibility(store, { dryRun: true }); assert.deepEqual(JSON.stringify(dry2.would_create_for), JSON.stringify(dry.would_create_for), "the dry run is deterministic");
  console.log("Dry run. 24 raw rows / 18 distinct ids / 6 duplicate rows / 0 invalid; 18 proposals; represented messages excluded — PASS");

  // ---- deterministic canonical row: earliest created_at, then smallest id (independent of insertion order) ----
  const rows = [{ id: "z-2", created_at: "2026-01-02T00:00:00Z", external_event_id: "wamid.det", lead_id: "L", payload: { timestamp: "1767225600" } }, { id: "a-9", created_at: "2026-01-02T00:00:00Z", external_event_id: "wamid.det", lead_id: "L", payload: { timestamp: "1767225600" } }, { id: "m-1", created_at: "2026-01-01T00:00:00Z", external_event_id: "wamid.det", lead_id: "L", payload: { timestamp: "1767225600" } }];
  for (const arrangement of [rows, [...rows].reverse(), [rows[1], rows[2], rows[0]]]) { const plan = visibility.planInboundVisibilityRepair(arrangement, []); assert.equal(plan.would_create.length, 1); assert.equal(plan.would_create[0].canonical_event_id, "m-1"); assert.deepEqual(plan.would_create[0].duplicate_event_ids, ["a-9", "z-2"]); }
  const tie = visibility.planInboundVisibilityRepair([rows[0], rows[1]], []); assert.equal(tie.would_create[0].canonical_event_id, "a-9", "equal created_at: smallest id wins");
  console.log("Determinism. Canonical row = earliest created_at then smallest id, whatever the order — PASS");

  // ---- conflicting lead identities are reported, never merged; a missing lead on one row is not a conflict; no lead at all is invalid ----
  const plan = visibility.planInboundVisibilityRepair([
    { id: "c1", created_at: "2026-01-01T00:00:00Z", external_event_id: "wamid.conflict", lead_id: "LEAD-A", payload: { timestamp: "1767225600" } },
    { id: "c2", created_at: "2026-01-01T00:00:01Z", external_event_id: "wamid.conflict", lead_id: "LEAD-B", payload: { timestamp: "1767225600" } },
    { id: "n1", created_at: "2026-01-01T00:00:00Z", external_event_id: "wamid.partial", lead_id: null, payload: { timestamp: "1767225600" } },
    { id: "n2", created_at: "2026-01-01T00:00:01Z", external_event_id: "wamid.partial", lead_id: "LEAD-C", payload: { timestamp: "1767225600" } },
    { id: "i1", created_at: "2026-01-01T00:00:00Z", external_event_id: "wamid.invalid", lead_id: null, payload: { timestamp: "1767225600" } },
  ], []);
  assert.equal(plan.conflicting_lead_groups.length, 1); assert.deepEqual(plan.conflicting_lead_groups[0].lead_ids.sort(), ["LEAD-A", "LEAD-B"]); assert.ok(!plan.would_create.some((c) => c.provider_message_id === "wamid.conflict"), "a conflicting identity is never auto-merged or created");
  assert.equal(plan.would_create.find((c) => c.provider_message_id === "wamid.partial").lead_id, "LEAD-C", "a row without a lead does not conflict with the row that has one");
  assert.equal(plan.invalid_records.length, 1); assert.equal(plan.invalid_records[0].provider_message_id, "wamid.invalid"); assert.equal(plan.unique_missing_messages, 3); assert.equal(plan.raw_missing_event_rows, 5);
  // the same through the store: a conflicting group is not written
  const cLeadA = await mkLead(4), cLeadB = await mkLead(5);
  await addEvent(cLeadA.id, "wamid.store.conflict", "who sent this", base + 30000); await addEvent(cLeadB.id, "wamid.store.conflict", "who sent this", base + 30000);
  const dryC = await visibility.repairInboundVisibility(store, { dryRun: true }); assert.equal(dryC.conflicting_lead_groups, 1); assert.equal(dryC.conflicts[0].provider_message_id, "wamid.store.conflict"); assert.equal(dryC.proposed_activities, 18, "the conflict does not change the 18 proposals");
  console.log("Identity. Conflicting lead ids reported and skipped; missing lead tolerated; no-lead invalid — PASS");

  // ---- apply: at most one activity per distinct id; originals untouched; nothing deleted ----
  const applied = await visibility.repairInboundVisibility(store, { dryRun: false });
  assert.equal(applied.created, 18); assert.equal(applied.failed, 0); assert.equal(applied.skipped_existing, 0); assert.equal(applied.conflicting_lead_groups, 1);
  const activities = await store.listCrmActivitiesForWhatsApp();
  for (const id of missingIds) { const found = activities.filter((a) => a.metadata?.provider_message_id === id); assert.equal(found.length, 1, `exactly one activity for ${id}`); assert.equal(found[0].metadata.direction, "inbound"); assert.equal(found[0].metadata.recorded_by, "visibility_repair"); }
  const dup3 = activities.find((a) => a.metadata.provider_message_id === "wamid.dedup.03"); assert.equal(dup3.metadata.duplicate_event_ids.length, 1, "the duplicate row is recorded as provenance"); assert.equal(new Date(dup3.occurred_at).toISOString(), new Date((base + 3 * 600) * 1000).toISOString());
  assert.equal(activities.filter((a) => a.metadata?.provider_message_id === "wamid.store.conflict").length, 0, "the conflicting identity was not written");
  const originalRows = JSON.parse(eventsBefore); const rowsNow = (await store.listInboundMessageEvents({ limit: 1000 })).map((e) => [e.id, e.lead_id, e.external_event_id, e.payload]);
  assert.deepEqual(originalRows.map((r) => JSON.stringify(r)).filter((r) => !rowsNow.map((x) => JSON.stringify(x)).includes(r)), [], "every original inbound event is byte-for-byte unchanged");
  const eventsNow = await store.listInboundMessageEvents({ limit: 1000 }); assert.ok(JSON.parse(eventsBefore).every(([id]) => eventsNow.some((e) => e.id === id)), "no original event was deleted");
  console.log("Apply. One activity per distinct id (18), provenance of duplicates kept, events untouched — PASS");

  // ---- repeat execution ----
  const again = await visibility.repairInboundVisibility(store, { dryRun: false }); assert.equal(again.created, 0); assert.equal(again.proposed_activities, 0, "nothing left to propose"); assert.equal(again.conflicting_lead_groups, 1, "only the unresolved conflicting identity remains, still reported and never merged"); assert.equal(again.unique_missing_messages, 1); assert.equal(again.raw_missing_event_rows, 2);
  assert.equal((await store.listCrmActivitiesForWhatsApp()).filter((a) => String(a.metadata?.provider_message_id || "").startsWith("wamid.dedup.")).length, 18, "still exactly 18");
  console.log("Repeat. A second run creates nothing and finds nothing missing — PASS");

  // ---- concurrent repair attempts: a fresh dataset, four runs at once ----
  const cl = await mkLead(6); const concurrentIds = [];
  for (let i = 1; i <= 10; i++) { const id = `wamid.conc.${String(i).padStart(2, "0")}`; concurrentIds.push(id); await addEvent(cl.id, id, `concurrent ${i}`, base + 40000 + i); if (i % 2 === 0) await addEvent(cl.id, id, `concurrent ${i}`, base + 40000 + i); }
  const runs = await Promise.all([1, 2, 3, 4].map(() => visibility.repairInboundVisibility(store, { dryRun: false })));
  assert.equal(runs.reduce((n, r) => n + r.created, 0), 10, "across 4 concurrent runs exactly 10 records were created");
  assert.equal(runs.reduce((n, r) => n + r.failed, 0), 0);
  const afterConc = await store.listCrmActivitiesForWhatsApp(); for (const id of concurrentIds) assert.equal(afterConc.filter((a) => a.metadata?.provider_message_id === id).length, 1, `no duplicate activity for ${id}`);
  assert.equal((await visibility.repairInboundVisibility(store, { dryRun: false })).created, 0);
  console.log("Concurrency. 4 simultaneous repairs create exactly one activity per message id — PASS");

  // ---- strict legacy matching preserved: identical text twice, only one legacy activity => exactly one of the two is proposed ----
  const ll = await mkLead(7);
  await addEvent(ll.id, "wamid.legacy.twin.1", "ok", base + 50000); await addEvent(ll.id, "wamid.legacy.twin.2", "ok", base + 50001); await addActivity(ll.id, "ok", base + 50001);
  const legacyDry = await visibility.repairInboundVisibility(store, { dryRun: true }); const twins = legacyDry.would_create_for.filter((c) => c.provider_message_id.startsWith("wamid.legacy.twin."));
  assert.equal(twins.length, 1, "one legacy activity covers one of two identical messages; the other is proposed (one-to-one, never collapsed)");
  console.log("Legacy. Strict one-to-one matching preserved — PASS");
  console.log(JSON.stringify({ status: "PASS", suite: "whatsapp-visibility-repair-dedup" }));
}
main().catch((error) => { console.error(error); process.exit(1); });
