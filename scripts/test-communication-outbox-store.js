const assert = require("node:assert/strict");
const { createTempStore } = require("../src/lead-agents/testing");

// Store-level contract of the communication outbox, written against the store API only so it runs identically on the file store and, in the P0 hardening harness, against the
// real SupabaseLeadAgentsStore -> PostgREST -> hardened PostgreSQL (where the lease must arbitrate between genuinely separate client connections).
async function main() {
  const { store } = await createTempStore();
  const { store: other } = await createTempStore(); // a second client/worker on the same data (a second file store would be separate memory: only used on the Supabase run)
  const shared = process.env.OFFICE_TEST_SUPABASE_URL ? other : store;
  const entry = (n, over = {}) => ({ delivery_key: `whatsapp:message:wamid.store.${n}`, event_type: "message", provider_message_id: `wamid.store.${n}`, source_event_id: null, lead_id: null, payload: { channel: "whatsapp", provider_event_type: "message", provider_message_id: `wamid.store.${n}`, from: "2348077700001", text: `m${n}`, occurred_at: "2026-10-15T12:13:08.000Z" }, mode: "live", ...over });

  // identity: one entry per delivery_key
  const a = await store.enqueueCommunicationDelivery(entry(1)); assert.equal(a.created, true); assert.equal(a.entry.status, "pending"); assert.equal(a.entry.attempts, 0); assert.equal(a.entry.mode, "live");
  const dup = await shared.enqueueCommunicationDelivery(entry(1)); assert.equal(dup.created, false); assert.equal(dup.entry.id, a.entry.id, "a duplicate delivery_key returns the existing entry (no second pending record)");
  const raced = await Promise.all(Array.from({ length: 6 }, () => shared.enqueueCommunicationDelivery(entry(2)))); assert.equal(raced.filter((r) => r.created).length, 1, "6 concurrent enqueues of one key create exactly one row");
  const found = await store.findCommunicationDeliveriesByKeys(["whatsapp:message:wamid.store.1", "whatsapp:message:wamid.store.2", "whatsapp:message:wamid.store.nope"]); assert.equal(found.length, 2);
  console.log("Store. Unique delivery identity, concurrent enqueue creates one row — PASS");

  // lease: compare-and-set, exactly one winner among concurrent workers
  const now = Date.now();
  const leasers = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? shared : store).leaseCommunicationDelivery(a.entry.id, { workerId: `w${i}`, leaseMs: 5000, now })));
  const winners = leasers.filter(Boolean); assert.equal(winners.length, 1, "exactly one of 8 concurrent workers wins the lease"); assert.equal(winners[0].attempts, 1); assert.ok(winners[0].lease_until);
  assert.equal(await store.leaseCommunicationDelivery(a.entry.id, { workerId: "late", leaseMs: 5000, now: now + 1000 }), null, "a valid lease blocks everyone else");
  const due = await store.listDueCommunicationDeliveries({ now: now + 1000, limit: 10 }); assert.ok(!due.some((e) => e.id === a.entry.id), "an in-flight entry is not due");
  const expired = await store.leaseCommunicationDelivery(a.entry.id, { workerId: "after-crash", leaseMs: 5000, now: now + 6000 }); assert.ok(expired && expired.attempts === 2, "an expired lease (crashed worker) can be taken over");
  console.log("Store. Lease: exactly one winner, blocks others, expires after a crash — PASS");

  // outcomes
  await store.completeCommunicationDelivery(a.entry.id, { status: "pending", next_attempt_at: new Date(now + 60_000).toISOString(), last_error: "backend_http_503", last_http_status: 503, lease_until: null, leased_by: null });
  assert.ok(!(await store.listDueCommunicationDeliveries({ now: now + 1000, limit: 10 })).some((e) => e.id === a.entry.id), "backoff keeps it out of the due list");
  assert.ok((await store.listDueCommunicationDeliveries({ now: now + 61_000, limit: 10 })).some((e) => e.id === a.entry.id), "and brings it back when due");
  await store.completeCommunicationDelivery(a.entry.id, { status: "delivered", delivered_at: new Date().toISOString(), last_error: null, last_http_status: 200 });
  assert.equal(await store.leaseCommunicationDelivery(a.entry.id, { workerId: "x", leaseMs: 1000, now: now + 999_999 }), null, "a delivered entry is never leased again");
  const b = (await store.findCommunicationDeliveriesByKeys(["whatsapp:message:wamid.store.2"]))[0]; await store.completeCommunicationDelivery(b.id, { status: "dead", dead_at: new Date().toISOString(), last_error: "backend_auth_401" });
  const requeued = await store.requeueCommunicationDelivery(b.id, { mode: "replay", now }); assert.equal(requeued.status, "pending"); assert.equal(requeued.mode, "replay"); assert.equal(requeued.dead_at, null);
  assert.equal((await store.requeueCommunicationDelivery(a.entry.id, { mode: "replay", now })).status, "delivered", "a delivered entry cannot be re-queued");
  const summary = await store.communicationDeliverySummary({ now: now + 100_000 }); assert.equal(summary.counts.delivered, 1); assert.equal(summary.counts.pending, 1); assert.equal(summary.counts.dead, 0); assert.equal(summary.due_now, 1);
  console.log("Store. Backoff scheduling, delivered/dead/requeue transitions, summary — PASS");

  // events for reconciliation / single-event recovery
  const lead = await store.createLead({ name: "Outbox Store", source: "whatsapp", whatsapp_phone: "2348077700009", status: "new" });
  const e1 = await store.appendInboundEvent({ channel: "whatsapp", provider: "meta", event_type: "message", lead_id: lead.id, external_event_id: "wamid.store.ev1", payload: { id: "wamid.store.ev1", from: "2348077700009", timestamp: "1792066388", type: "text", text: { body: "hi" } } });
  await store.appendInboundEvent({ channel: "whatsapp", provider: "meta", event_type: "status:delivered", lead_id: null, external_event_id: "wamid.store.out1", payload: { id: "wamid.store.out1", status: "delivered", timestamp: "1792066390", recipient_id: "2348077700009" } });
  const since = new Date(Date.now() - 3600_000).toISOString();
  const events = await store.listInboundEventsForOutbox({ since, limit: 100 }); assert.ok(events.some((e) => e.id === e1.id) && events.some((e) => e.event_type === "status:delivered"), "messages and status events are listed for reconciliation");
  const byId = await store.findInboundEventsByExternalId("wamid.store.ev1"); assert.equal(byId.length, 1); assert.equal(byId[0].lead_id, lead.id);
  console.log("Store. Events listed for reconciliation and found by provider id — PASS");
  console.log(JSON.stringify({ status: "PASS", suite: "communication-outbox-store" }));
}
main().catch((error) => { console.error(error); process.exit(1); });
