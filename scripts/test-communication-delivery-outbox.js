const assert = require("node:assert/strict");
const http = require("node:http");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const outbox = require("../src/lead-agents/communication-outbox");

// Durable delivery of WhatsApp inbound evidence to Backend. Real Office server + file store; a controllable Backend stub that models the real Backend's idempotency
// (a message/status is persisted once per provider id) and a spy on every customer-facing send. Cold starts, timeouts, lost responses, auth/429/5xx failures,
// concurrent workers, worker crashes, replay semantics and reconciliation are all exercised. Fixtures only.
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

async function main() {
  const backend = { mode: "ok", sleepMs: 0, sleepRemaining: 0, calls: [], persisted: new Map(), goalActive: false, status: 200 };
  const backendServer = http.createServer((req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      backend.calls.push({ body, key: req.headers["x-api-key"], at: Date.now() });
      const key = `${body.provider_event_type}:${body.provider_message_id}:${body.status || ""}`;
      const persist = () => { const dup = backend.persisted.has(key); backend.persisted.set(key, (backend.persisted.get(key) || 0) + 1 > 1 ? backend.persisted.get(key) : 1); return dup; };
      const reply = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      if (req.headers["x-api-key"] !== "backend-key") return reply(401, { error: "unauthorized" });
      const sleep1 = backend.sleepRemaining > 0 ? (backend.sleepRemaining--, backend.sleepMs) : 0;
      switch (backend.mode) {
        case "http": return reply(backend.status, { error: "forced" });
        case "refuse": return reply(200, { ok: false, reason: "unsupported_or_missing_fields" });
        case "fail": return reply(200, { ok: false, error: "inbound_processing_failed" });
        case "commit_then_sleep": { const dup = persist(); await sleep(backend.sleepMs); return reply(200, { ok: true, duplicate: dup, goal_active: false }); }
        case "commit_then_drop": { persist(); req.socket.destroy(); return; }
        default: { if (sleep1) await sleep(sleep1); const dup = persist(); return reply(200, { ok: true, duplicate: dup, goal_active: backend.goalActive && !body.replay }); }
      }
    });
  });
  const backendPort = await listen(backendServer);
  const OUTBOX = { inlineTimeoutMs: 250, workerTimeoutMs: 1500, baseDelayMs: 40, maxDelayMs: 200, jitter: 0, maxAttempts: 4, leaseMs: 2000, tickMs: 40, batch: 10 };
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["outbox-key"], allowedOrigins: [], officeBackendBaseUrl: `http://127.0.0.1:${backendPort}`, officeBackendApiKey: "backend-key", communicationOutbox: OUTBOX, communicationOutboxWorker: false };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super", status: "active" });
  await store.ensureAdminUser({ email: "staff@ochiga.local", password_hash: hashPassword("staff-pass-123"), role: "ochiga_staff", display_name: "Staff", status: "active" });
  const sent = [];
  const adapter = { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: (b) => b.events || [], isConfigured: () => true, sendTextMessage: async (m) => { sent.push(m); return { delivered: true, external_message_id: "wamid.out.x" }; }, sendTemplateMessage: async (m) => { sent.push(m); return { delivered: false }; }, listApprovedTemplates: async () => [] };
  const servers = [];
  const start = async (s, cfg = config) => { const server = buildServer({ config: cfg, store: s, rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 9999 }), publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 9999 }), officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 9999 }), loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store: s, config: cfg, log: () => {}, webhooks: new WebhookDispatcher({ config: cfg }) }) }); servers.push(server); return `http://127.0.0.1:${await listen(server)}`; };
  const base = await start(store);
  const login = async (email, password) => { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }); assert.equal(r.status, 200); return r.headers.get("set-cookie").split(";")[0]; };
  const sup = await login("super@ochiga.local", "super-pass-123"), staff = await login("staff@ochiga.local", "staff-pass-123");
  const phone = () => `23480777${String(++seq).padStart(5, "0")}`;
  const metaTs = () => Math.floor(Date.now() / 1000);
  const deliver = async (from, text, id, ts = metaTs(), type = "message") => {
    const raw = type === "message" ? { id, from, timestamp: String(ts), type: "text", text: { body: text } } : { id, status: text, timestamp: String(ts), recipient_id: from };
    const event = type === "message" ? { kind: "message", from, message_id: id, message_type: "text", timestamp: String(ts), text, raw, metadata: { phone_number_id: "585884641275180" } } : { kind: "status", message_id: id, status: text, timestamp: String(ts), raw, metadata: {} };
    const r = await fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [event] }) }); assert.equal(r.status, 200); return (await r.json()).results[0];
  };
  const entryFor = (key) => store.state.communication_delivery_outbox.find((e) => e.delivery_key === key);
  const reset = () => { backend.mode = "ok"; backend.sleepMs = 0; backend.sleepRemaining = 0; backend.goalActive = false; backend.status = 200; };
  const callsFor = (id) => backend.calls.filter((c) => c.body.provider_message_id === id);
  const persistedCount = (id, type = "message", status = "") => backend.persisted.get(`${type}:${id}:${status}`) || 0;
  const drain = (extra = {}) => outbox.drainOutbox(store, config, { workerId: `w-${++seq}`, ...extra });
  const waitDue = async (ms = 80) => sleep(ms);

  try {
    // 1. Backend available: delivered inline, LIVE semantics (no replay flag), acknowledged only after a valid ack; goal_active honoured on the first attempt
    reset(); const p1 = phone();
    await deliver(p1, "Hello, I own land in Lekki", "wamid.ob.1");
    let e1 = entryFor("whatsapp:message:wamid.ob.1");
    assert.equal(e1.status, "delivered"); assert.equal(e1.attempts, 1); assert.ok(e1.delivered_at); assert.equal(e1.last_http_status, 200); assert.equal(e1.mode, "live");
    assert.equal(callsFor("wamid.ob.1").length, 1); assert.equal(callsFor("wamid.ob.1")[0].body.replay, undefined, "the first attempt is LIVE (no replay flag)");
    assert.equal(persistedCount("wamid.ob.1"), 1);
    backend.goalActive = true; const p1b = phone(); const r1b = await deliver(p1b, "second", "wamid.ob.1b"); assert.equal(r1b.deferred_to_goal, true, "live delivery still reports goal_active, preserving the single-responder rule"); reset();
    console.log("1. Backend available: delivered inline, live semantics, valid acknowledgement recorded — PASS");

    // 2. Backend asleep (cold start): inline attempt times out, Office keeps the message, retry succeeds with replay semantics
    reset(); backend.sleepRemaining = 1; backend.sleepMs = 700; const p2 = phone(); const sentBefore = sent.length;
    const r2 = await deliver(p2, "Cold start message", "wamid.ob.2");
    const e2 = entryFor("whatsapp:message:wamid.ob.2");
    assert.equal(e2.status, "pending"); assert.equal(e2.attempts, 1); assert.match(e2.last_error, /^ambiguous_/, "a timeout is recorded as ambiguous (possibly delivered)");
    assert.ok(store.state.inbound_events.some((e) => e.external_event_id === "wamid.ob.2"), "Office retained the event"); assert.ok(store.state.crm_activities.some((a) => a.metadata?.provider_message_id === "wamid.ob.2"), "and its CRM activity");
    await waitDue(120); const d2 = await drain(); assert.equal(d2.filter((r) => r.delivered).length >= 1, true);
    const e2b = entryFor("whatsapp:message:wamid.ob.2"); assert.equal(e2b.status, "delivered"); assert.equal(e2b.attempts, 2);
    const retryCall = callsFor("wamid.ob.2").pop(); assert.equal(retryCall.body.replay, true, "the retry uses non-sending replay semantics");
    assert.equal(retryCall.body.occurred_at, new Date(Number(store.state.inbound_events.find((e) => e.external_event_id === "wamid.ob.2").payload.timestamp) * 1000).toISOString(), "original provider timestamp");
    assert.equal(persistedCount("wamid.ob.2"), 1); assert.equal(sent.length, sentBefore, "no customer-facing message"); reset(); void r2;
    console.log("2/3. Cold start / request timeout: message retained, retried with replay semantics, delivered once — PASS");

    // 4. Backend commits but the response is lost (late response, and dropped connection): retry is a harmless duplicate
    for (const [mode, id] of [["commit_then_sleep", "wamid.ob.4a"], ["commit_then_drop", "wamid.ob.4b"]]) {
      reset(); backend.mode = mode; backend.sleepMs = 700; await deliver(phone(), `lost response ${mode}`, id);
      const pending = entryFor(`whatsapp:message:${id}`); assert.equal(pending.status, "pending", `${mode}: no acknowledgement => not marked delivered`); assert.equal(persistedCount(id), 1, `${mode}: Backend did commit`);
      reset(); await waitDue(120); await drain();
      assert.equal(entryFor(`whatsapp:message:${id}`).status, "delivered"); assert.equal(persistedCount(id), 1, `${mode}: still exactly one Backend record (idempotent)`);
      assert.ok(callsFor(id).length >= 2);
    }
    console.log("4. Backend commits but the response is lost: not marked delivered until acknowledged; retry is idempotent — PASS");

    // 5. Duplicate Meta webhook deliveries: one queue entry, one Backend event
    reset(); const p5 = phone(); await deliver(p5, "dup me", "wamid.ob.5"); await deliver(p5, "dup me", "wamid.ob.5"); await deliver(p5, "dup me", "wamid.ob.5");
    assert.equal(store.state.communication_delivery_outbox.filter((e) => e.delivery_key === "whatsapp:message:wamid.ob.5").length, 1); assert.equal(persistedCount("wamid.ob.5"), 1); assert.equal(callsFor("wamid.ob.5").length, 1, "Meta retries never even reach Backend twice");
    await deliver(p5, "delivered", "wamid.ob.5s", metaTs(), "status"); await deliver(p5, "delivered", "wamid.ob.5s", metaTs(), "status");
    assert.equal(store.state.communication_delivery_outbox.filter((e) => e.delivery_key === "whatsapp:status:wamid.ob.5s:delivered").length, 1, "a repeated status callback is one entry"); assert.equal(persistedCount("wamid.ob.5s", "status", "delivered"), 1);
    console.log("5. Duplicate Meta deliveries: one entry, one Backend event (messages and statuses) — PASS");

    // 6. Concurrent workers: a lease guarantees one forward per entry
    reset(); backend.sleepMs = 120; backend.sleepRemaining = 999; const queued = [];
    for (let i = 0; i < 6; i++) { const q = await outbox.enqueueDelivery(store, { payload: { channel: "whatsapp", provider_event_type: "message", provider_message_id: `wamid.ob.6.${i}`, from: "2348077700000", text: `c${i}`, lead_id: null, occurred_at: new Date().toISOString() }, mode: "replay" }); queued.push(q.entry); }
    const same = await Promise.all(Array.from({ length: 6 }, (_, i) => outbox.attemptDelivery(store, config, queued[0], { workerId: `race-${i}` })));
    assert.equal(same.filter((r) => !r.skipped).length, 1, "6 workers racing for ONE entry: exactly one forwards it"); assert.equal(callsFor("wamid.ob.6.0").length, 1);
    const sweepers = await Promise.all([drain(), drain(), drain()]);
    assert.equal(sweepers.flat().filter((r) => r.delivered).length, 5, "3 workers sweeping 5 remaining entries deliver each exactly once");
    for (let i = 0; i < 6; i++) { assert.equal(callsFor(`wamid.ob.6.${i}`).length, 1, `entry ${i} forwarded once`); assert.equal(persistedCount(`wamid.ob.6.${i}`), 1); }
    reset(); console.log("6. Concurrent workers: each entry forwarded exactly once — PASS");

    // 7. Backend 401 / 403: recoverable with backoff, dead-letter after the bounded retries, admin re-queue after the credential is fixed
    for (const code of [401, 403]) {
      reset(); backend.mode = "http"; backend.status = code; const id = `wamid.ob.7.${code}`;
      const q = await outbox.enqueueDelivery(store, { payload: { channel: "whatsapp", provider_event_type: "message", provider_message_id: id, from: "2348077700001", text: "auth", occurred_at: new Date().toISOString() }, mode: "live" });
      let clock = Date.now(); const clockFn = () => clock;
      for (let a = 1; a <= OUTBOX.maxAttempts; a++) { const r = await outbox.attemptDelivery(store, config, q.entry, { now: clockFn }); assert.equal(r.delivered, false); assert.equal(r.attempts, a); clock += 10_000; }
      const dead = entryFor(`whatsapp:message:${id}`); assert.equal(dead.status, "dead", `${code}: dead-lettered after ${OUTBOX.maxAttempts} attempts`); assert.equal(dead.last_error, `backend_auth_${code}`); assert.ok(dead.dead_at);
      reset(); const requeued = await fetch(`${base}/api/lead-agents/admin/communications/outbox/retry`, { method: "POST", headers: { "content-type": "application/json", cookie: sup }, body: JSON.stringify({ id: dead.id }) }); assert.equal(requeued.status, 200);
      assert.equal(entryFor(`whatsapp:message:${id}`).status, "pending"); await drain(); assert.equal(entryFor(`whatsapp:message:${id}`).status, "delivered"); assert.equal(persistedCount(id), 1);
    }
    console.log("7. Backend 401/403: retried, dead-lettered when exhausted, re-queued by an admin, delivered once — PASS");

    // 8. 429 / 500 / 503: bounded exponential backoff with jitter
    for (const code of [429, 500, 503]) {
      reset(); backend.mode = "http"; backend.status = code; const id = `wamid.ob.8.${code}`;
      const q = await outbox.enqueueDelivery(store, { payload: { channel: "whatsapp", provider_event_type: "message", provider_message_id: id, from: "2348077700002", text: "5xx", occurred_at: new Date().toISOString() }, mode: "live" });
      let clock = 1_000_000; const delays = [];
      for (let a = 1; a <= 3; a++) { const r = await outbox.attemptDelivery(store, config, q.entry, { now: () => clock, random: () => 0.5 }); assert.equal(r.dead, false); assert.equal(entryFor(`whatsapp:message:${id}`).last_error, `backend_http_${code}`); delays.push(Date.parse(r.next_attempt_at) - clock); clock = Date.parse(r.next_attempt_at) + 1; }
      assert.deepEqual(delays, [40, 80, 160], `${code}: exponential backoff 40, 80, 160 ms (cap ${OUTBOX.maxDelayMs})`);
    }
    assert.ok(outbox.backoffDelayMs(50, { ...outbox.DEFAULTS }) <= outbox.DEFAULTS.maxDelayMs * (1 + outbox.DEFAULTS.jitter), "backoff is bounded");
    const jittered = new Set(Array.from({ length: 30 }, () => outbox.backoffDelayMs(3, { baseDelayMs: 1000, maxDelayMs: 60_000, jitter: 0.2 }))); assert.ok(jittered.size > 5 && [...jittered].every((d) => d >= 3200 && d <= 4800), "jitter spreads retries within +/-20%");
    reset(); backend.mode = "refuse"; const rid = "wamid.ob.8.refuse"; const rq = await outbox.enqueueDelivery(store, { payload: { channel: "whatsapp", provider_event_type: "message", provider_message_id: rid, from: "", text: "", occurred_at: new Date().toISOString() }, mode: "live" });
    const refused = await outbox.attemptDelivery(store, config, rq.entry, {}); assert.equal(refused.dead, true, "a permanent refusal is dead-lettered immediately"); assert.equal(entryFor(`whatsapp:message:${rid}`).last_error, "backend_refused_unsupported_or_missing_fields");
    reset(); backend.mode = "fail"; const fid = "wamid.ob.8.fail"; const fq = await outbox.enqueueDelivery(store, { payload: { channel: "whatsapp", provider_event_type: "message", provider_message_id: fid, from: "2348077700003", text: "x", occurred_at: new Date().toISOString() }, mode: "live" });
    const failed = await outbox.attemptDelivery(store, config, fq.entry, {}); assert.equal(failed.dead, false, "a Backend processing failure (ok:false) is retried"); reset();
    console.log("8. 429/500/503: bounded exponential backoff + jitter; permanent refusal dead-lettered; processing failure retried — PASS");

    // 9. Worker crash during delivery: the lease protects the entry, then expires and another worker completes it
    reset(); const cq = await outbox.enqueueDelivery(store, { payload: { channel: "whatsapp", provider_event_type: "message", provider_message_id: "wamid.ob.9", from: "2348077700004", text: "crash", occurred_at: new Date().toISOString() }, mode: "live" });
    const leased = await store.leaseCommunicationDelivery(cq.entry.id, { workerId: "crashed-worker", leaseMs: OUTBOX.leaseMs, now: Date.now() }); assert.equal(leased.attempts, 1); // ...and the process dies here
    assert.equal((await outbox.attemptDelivery(store, config, cq.entry, { workerId: "other" })).reason, "lease_not_acquired", "while the lease is valid nobody else forwards it");
    assert.equal(callsFor("wamid.ob.9").length, 0);
    const later = Date.now() + OUTBOX.leaseMs + 10; const resumed = await outbox.attemptDelivery(store, config, cq.entry, { workerId: "restarted", now: () => later });
    assert.equal(resumed.delivered, true); assert.equal(resumed.attempts, 2); assert.equal(callsFor("wamid.ob.9")[0].body.replay, true, "after a crash the retry is a replay"); assert.equal(persistedCount("wamid.ob.9"), 1);
    // the real background worker also drains work left behind by a previous process
    const left = await outbox.enqueueDelivery(store, { payload: { channel: "whatsapp", provider_event_type: "message", provider_message_id: "wamid.ob.9w", from: "2348077700005", text: "left behind", occurred_at: new Date().toISOString() }, mode: "replay" });
    const worker = outbox.startOutboxWorker({ store, config: { ...config, communicationOutbox: { ...OUTBOX, tickMs: 40 } }, workerId: "bg" }); await worker.tick(); worker.stop();
    assert.equal(entryFor("whatsapp:message:wamid.ob.9w").status, "delivered"); void left;
    console.log("9. Worker crash/restart: lease protects, then expires; background worker drains leftovers — PASS");

    // 10/11/12/13. Historical replay with autonomy OFF, original timestamps, no duplicate Backend events, nothing sent
    reset(); const ph = phone(); const lead = await store.createLead({ name: "History", source: "whatsapp", whatsapp_phone: ph, status: "new" });
    const oldTs = metaTs() - 3 * 24 * 3600; const oldIds = ["wamid.ob.h1", "wamid.ob.h2"];
    for (const [i, id] of oldIds.entries()) await store.appendInboundEvent({ channel: "whatsapp", provider: "meta", event_type: "message", lead_id: lead.id, external_event_id: id, payload: { id, from: ph, timestamp: String(oldTs + i * 60), type: "text", text: { body: `historic ${i}` } } });
    await store.appendInboundEvent({ channel: "whatsapp", provider: "meta", event_type: "status:read", lead_id: null, external_event_id: "wamid.out.hist", payload: { id: "wamid.out.hist", status: "read", timestamp: String(oldTs), recipient_id: ph } });
    const sentH = sent.length; const callsH = backend.calls.length;
    const dry = await (await fetch(`${base}/api/lead-agents/admin/communications/outbox/reconcile`, { method: "POST", headers: { "content-type": "application/json", cookie: sup }, body: JSON.stringify({ window_minutes: 7 * 24 * 60 }) })).json();
    assert.equal(dry.dry_run, true, "reconcile defaults to a dry run"); assert.ok(dry.missing_deliveries >= 3); assert.equal(backend.calls.length, callsH, "a dry run sends nothing"); assert.equal(store.state.communication_delivery_outbox.some((e) => oldIds.includes(e.provider_message_id)), false);
    assert.equal((await fetch(`${base}/api/lead-agents/admin/communications/outbox/reconcile`, { method: "POST", headers: { "content-type": "application/json", cookie: staff }, body: "{}" })).status, 403, "reconcile is admin only");
    const applied = await (await fetch(`${base}/api/lead-agents/admin/communications/outbox/reconcile`, { method: "POST", headers: { "content-type": "application/json", cookie: sup }, body: JSON.stringify({ dry_run: false, window_minutes: 7 * 24 * 60 }) })).json(); assert.ok(applied.enqueued >= 3);
    assert.ok(store.state.communication_delivery_outbox.filter((e) => oldIds.includes(e.provider_message_id)).every((e) => e.mode === "replay"), "reconciled entries are replay deliveries");
    await drain();
    for (const [i, id] of oldIds.entries()) { const call = callsFor(id)[0]; assert.equal(call.body.replay, true, "historical delivery is non-sending replay"); assert.equal(call.body.occurred_at, new Date((oldTs + i * 60) * 1000).toISOString(), "original Meta timestamp preserved"); assert.equal(call.body.from, ph); assert.equal(call.body.lead_id, lead.id); assert.equal(call.body.provider_message_id, id); assert.equal(persistedCount(id), 1); }
    assert.equal(persistedCount("wamid.out.hist", "status", "read"), 1);
    assert.equal(sent.length, sentH, "no customer-facing message was generated"); assert.equal(await store.getRuntimeSetting("whatsapp_autonomous_responses_enabled"), null, "autonomy stays OFF (setting never written)");
    const again = await (await fetch(`${base}/api/lead-agents/admin/communications/outbox/reconcile`, { method: "POST", headers: { "content-type": "application/json", cookie: sup }, body: JSON.stringify({ dry_run: false, window_minutes: 7 * 24 * 60 }) })).json(); assert.equal(again.enqueued, 0, "reconciliation is idempotent");
    assert.ok([...backend.persisted.values()].every((n) => n === 1), "no duplicate Backend communication events anywhere");
    console.log("10-13. Historical replay with autonomy OFF: replay semantics, original timestamps, no duplicate Backend events, nothing sent — PASS");

    // single-event recovery (the production incident shape): a stored event that never got an outbox entry
    reset(); const pr = phone(); const rl = await store.createLead({ name: "Recover", source: "whatsapp", whatsapp_phone: pr, status: "new" }); const incidentTs = metaTs() - 1200; const incident = "wamid.ob.incident";
    const stored = await store.appendInboundEvent({ channel: "whatsapp", provider: "meta", event_type: "message", lead_id: rl.id, external_event_id: incident, payload: { id: incident, from: pr, timestamp: String(incidentTs), type: "text", text: { body: "the message that timed out" } } });
    const eventSnapshot = JSON.stringify(store.state.inbound_events.find((e) => e.id === stored.id)); const sentR = sent.length;
    const recover = (body, cookie = sup) => fetch(`${base}/api/lead-agents/admin/communications/outbox/recover`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal((await recover({ provider_message_id: incident }, staff)).status, 403);
    const rec = await recover({ provider_message_id: incident }); assert.equal(rec.status, 200); assert.equal(rec.body.delivered, true);
    assert.equal(persistedCount(incident), 1, "exactly one Backend record"); const rcall = callsFor(incident)[0].body; assert.equal(rcall.replay, true); assert.equal(rcall.occurred_at, new Date(incidentTs * 1000).toISOString()); assert.equal(rcall.from, pr); assert.equal(rcall.lead_id, rl.id); assert.equal(rcall.text, "the message that timed out");
    assert.equal(JSON.stringify(store.state.inbound_events.find((e) => e.id === stored.id)), eventSnapshot, "Office's stored event is unchanged"); assert.equal(sent.length, sentR);
    const rec2 = await recover({ provider_message_id: incident }); assert.equal(rec2.body.already_delivered, true); assert.equal(persistedCount(incident), 1);
    assert.equal((await recover({ provider_message_id: "wamid.nonexistent" })).status, 404);
    console.log("Recovery. One stored event recovered as a replay: original id/timestamp/sender/lead, exactly one Backend record, Office event unchanged — PASS");

    // diagnostics + failures that must stay observable
    const diagRes = await fetch(`${base}/api/lead-agents/admin/communications/outbox`, { headers: { cookie: sup } }); const diag = await diagRes.json(); assert.equal(diagRes.status, 200, JSON.stringify(diag).slice(0, 200));
    assert.ok(diag.outbox.counts.delivered > 5 && "dead" in diag.outbox.counts && "oldest_pending_at" in diag.outbox); assert.ok(!JSON.stringify(diag).includes("historic 0"), "diagnostics expose no message text");
    assert.equal((await fetch(`${base}/api/lead-agents/admin/communications/outbox`, {})).status, 401, "diagnostics need a signed-in user"); assert.equal((await fetch(`${base}/api/lead-agents/admin/communications/outbox`, { headers: { cookie: staff } })).status, 403, "diagnostics are admin only");
    const failingEnqueue = new Proxy(store, { get: (t, p) => (p === "enqueueCommunicationDelivery" ? async () => { throw new Error("outbox write failed"); } : typeof t[p] === "function" ? t[p].bind(t) : t[p]) });
    const failBase = await start(failingEnqueue); const pf = phone(); const callsF = backend.calls.length;
    const rf = await fetch(`${failBase}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ kind: "message", from: pf, message_id: "wamid.ob.enq", message_type: "text", timestamp: String(metaTs()), text: "enqueue fails", raw: { id: "wamid.ob.enq", from: pf, timestamp: String(metaTs()), type: "text", text: { body: "enqueue fails" } } }] }) });
    assert.equal(rf.status, 200); assert.ok(store.state.inbound_events.some((e) => e.external_event_id === "wamid.ob.enq"), "intake is not blocked by an outbox failure"); assert.equal(entryFor("whatsapp:message:wamid.ob.enq"), undefined);
    assert.equal(backend.calls.length, callsF, "nothing was forwarded without a durable entry");
    const rec3 = await (await fetch(`${base}/api/lead-agents/admin/communications/outbox/reconcile`, { method: "POST", headers: { "content-type": "application/json", cookie: sup }, body: JSON.stringify({ dry_run: false, window_minutes: 60 }) })).json(); assert.ok(rec3.enqueued >= 1, "reconciliation picks up the event whose enqueue failed"); await drain(); assert.equal(persistedCount("wamid.ob.enq"), 1);
    const noBridge = { ...config, officeBackendBaseUrl: "", officeBackendApiKey: "" }; const nb = await start(store, noBridge); const before = store.state.communication_delivery_outbox.length;
    await fetch(`${nb}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ kind: "message", from: phone(), message_id: "wamid.ob.nobridge", message_type: "text", timestamp: String(metaTs()), text: "no bridge", raw: { id: "wamid.ob.nobridge", from: "x", timestamp: String(metaTs()), type: "text", text: { body: "no bridge" } } }] }) });
    assert.equal(store.state.communication_delivery_outbox.length, before, "with no Backend bridge configured nothing is queued");
    assert.equal(sent.length, sentR, "across the whole suite not a single customer-facing message was sent");
    console.log("Observability. Enqueue failure never blocks intake and is recovered by reconciliation; diagnostics hide content — PASS");
    console.log(JSON.stringify({ status: "PASS", suite: "communication-delivery-outbox", backend_requests: backend.calls.length, customer_messages_sent: sent.length }));
  } finally {
    for (const server of servers) await close(server).catch(() => {});
    await close(backendServer).catch(() => {});
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
