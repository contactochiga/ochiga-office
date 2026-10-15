const assert = require("node:assert/strict");
const http = require("node:http");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { WHATSAPP_AUTONOMY_SETTING_KEY } = require("../src/lead-agents/whatsapp-autonomy");
const visibility = require("../src/lead-agents/whatsapp-inbound-visibility");

// Every accepted inbound WhatsApp message must appear exactly once in the Unified CRM conversation, whatever Oyi / takeover / goal / failure state applies. Real server,
// real file store, controlled adapter (counts every send), stubbed Backend. Fixtures only.
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
let seq = 0;

async function main() {
  let goalActive = false, coreMode = "ok";
  const backend = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); if (req.url === "/office/communications/webhook-event") return res.end(JSON.stringify({ ok: true, goal_active: goalActive })); if (req.url === "/office/conversation/corporate") { if (coreMode === "fail") { res.statusCode = 500; return res.end("{}"); } return res.end(JSON.stringify({ ok: true, answer: "Hello from Oyi", conversation_thread_id: "t1" })); } res.statusCode = 404; res.end("{}"); }); });
  const backendPort = await listen(backend);
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["vis-key"], allowedOrigins: [], officeBackendBaseUrl: `http://127.0.0.1:${backendPort}`, officeBackendApiKey: "vis-bridge" };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super", status: "active" });
  await store.ensureAdminUser({ email: "staff@ochiga.local", password_hash: hashPassword("staff-pass-123"), role: "ochiga_staff", display_name: "Staff", status: "active" });
  const sent = [];
  const adapter = { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: (b) => b.events || [], isConfigured: () => true, sendTextMessage: async (m) => { sent.push(m); return { delivered: true, response_code: 200, external_message_id: `wamid.out.${sent.length}` }; }, sendTemplateMessage: async () => ({ delivered: false }), listApprovedTemplates: async () => [] };
  const servers = [];
  const start = async (s) => { const server = buildServer({ config, store: s, rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 9999 }), publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 9999 }), officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 9999 }), loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store: s, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) }); servers.push(server); return `http://127.0.0.1:${await listen(server)}`; };
  const base = await start(store);
  const login = async (b, email, password) => { const r = await fetch(`${b}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }); assert.equal(r.status, 200); return r.headers.get("set-cookie").split(";")[0]; };
  const sup = await login(base, "super@ochiga.local", "super-pass-123"), staff = await login(base, "staff@ochiga.local", "staff-pass-123");
  const metaMessage = (from, text, id, ts = Math.floor(Date.now() / 1000)) => ({ id, from, timestamp: String(ts), type: "text", text: { body: text } });
  const deliver = async (url, from, text, id, ts) => { const raw = metaMessage(from, text, id, ts); const r = await fetch(`${url}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ kind: "message", from, message_id: id, message_type: "text", timestamp: raw.timestamp, text, raw, metadata: { phone_number_id: "585884641275180" } }] }) }); assert.equal(r.status, 200); return (await r.json()).results[0]; };
  const leadFor = (phone) => store.state.leads.find((l) => l.whatsapp_phone === phone);
  const thread = async (leadId) => (await fetch(`${base}/api/lead-agents/admin/crm/relationships/${leadId}`, { headers: { cookie: sup } })).json();
  const inboundEntries = (t) => t.thread.entries.filter((e) => e.kind === "message" && e.direction === "inbound");
  const activitiesOf = (leadId) => store.state.crm_activities.filter((a) => a.lead_id === leadId && a.activity_type === "whatsapp_message");
  const setAutonomy = (v) => store.setRuntimeSetting(WHATSAPP_AUTONOMY_SETTING_KEY, v, "test");

  try {
    // ---- every autonomy / takeover state: the message is stored, has ONE CRM record and appears ONCE ----
    const states = [
      ["autonomy OFF (default)", async () => {}],
      ["autonomy ON, Oyi replies", async () => { await setAutonomy(true); coreMode = "ok"; }],
      ["autonomy ON, Oyi generation FAILS", async () => { await setAutonomy(true); coreMode = "fail"; }],
      ["autonomy ON, AI paused for the lead", async (lead) => { await setAutonomy(true); await store.upsertLeadChannelState(lead.id, "whatsapp", { ai_paused: true }); }],
      ["autonomy ON, human takeover active", async (lead) => { await setAutonomy(true); await store.upsertLeadChannelState(lead.id, "whatsapp", { human_status: "human_active", human_owner: "super@ochiga.local", ai_paused: true }); }],
      ["autonomy OFF, human takeover active", async (lead) => { await setAutonomy(false); await store.upsertLeadChannelState(lead.id, "whatsapp", { human_status: "human_active", ai_paused: true }); }],
      ["autonomy ON, Backend goal owns the response", async () => { await setAutonomy(true); coreMode = "ok"; goalActive = true; }],
    ];
    let phoneSeq = 0;
    for (const [name, prepare] of states) {
      const phone = `23480111${String(++phoneSeq).padStart(5, "0")}`;
      goalActive = false; coreMode = "ok"; await setAutonomy(false);
      // the first message creates the lead; the state is applied to it; the SECOND message is the one observed under that state
      await deliver(base, phone, "first message", `wamid.${phone}.0`);
      const lead = leadFor(phone); assert.ok(lead, `${name}: lead exists`);
      await prepare(lead);
      const before = sent.length;
      const result = await deliver(base, phone, "Hello, I own land in Lekki", `wamid.${phone}.1`);
      assert.ok(!result.crm_record_failed, `${name}: CRM record written`);
      const t = await thread(lead.id);
      const entries = inboundEntries(t).filter((e) => e.text === "Hello, I own land in Lekki");
      assert.equal(entries.length, 1, `${name}: the message appears exactly ONCE in the CRM conversation (got ${entries.length})`);
      assert.equal(entries[0].provider_message_id, `wamid.${phone}.1`, `${name}: original provider message id preserved`);
      assert.equal(entries[0].direction, "inbound"); assert.equal(entries[0].channel, "whatsapp");
      assert.ok(entries[0].merged_from.some((m) => m.table === "crm_activities"), `${name}: canonical CRM activity present`);
      const acts = activitiesOf(lead.id).filter((a) => a.body === "Hello, I own land in Lekki"); assert.equal(acts.length, 1, `${name}: exactly one CRM activity`);
      assert.equal(acts[0].metadata.provider_message_id, `wamid.${phone}.1`); assert.equal(acts[0].lead_id, lead.id); assert.equal(acts[0].metadata.direction, "inbound"); assert.equal(acts[0].metadata.recorded_by, "inbound_webhook");
      assert.ok(store.state.inbound_events.some((e) => e.external_event_id === `wamid.${phone}.1`), `${name}: inbound event stored`);
      // provenance: the entry timestamp is the original message timestamp
      assert.ok(Math.abs(Date.parse(entries[0].occurred_at) - Number(metaMessage(phone, "", "x").timestamp) * 1000) < 5000);
      if (/OFF|paused|takeover|goal/.test(name)) assert.equal(sent.length, before, `${name}: no autonomous reply was sent`);
      console.log(`  ${name}: visible once, one activity, original id kept — PASS`);
    }
    await setAutonomy(false); goalActive = false; coreMode = "ok";
    console.log("7. Inbound messages stay visible under every autonomy / takeover / goal / failure state — PASS");

    // ---- two distinct customer messages with identical text are two entries; a retried delivery is one ----
    const p2 = "2348022200001";
    await deliver(base, p2, "ok", "wamid.dist.1"); await deliver(base, p2, "ok", "wamid.dist.2");
    const l2 = leadFor(p2); let t2 = await thread(l2.id);
    assert.equal(inboundEntries(t2).filter((e) => e.text === "ok").length, 2, "two distinct customer messages (same text, different provider ids) are two entries");
    for (let i = 0; i < 3; i++) { const r = await fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ kind: "message", from: p2, message_id: "wamid.dist.1", message_type: "text", timestamp: String(Math.floor(Date.now() / 1000)), text: "ok", raw: metaMessage(p2, "ok", "wamid.dist.1") }] }) }); assert.equal(r.status, 200); }
    t2 = await thread(l2.id); assert.equal(inboundEntries(t2).filter((e) => e.text === "ok").length, 2, "Meta retries of an existing message create no extra entry");
    assert.equal(store.state.inbound_events.filter((e) => e.external_event_id === "wamid.dist.1").length, 1); assert.equal(activitiesOf(l2.id).filter((a) => a.metadata.provider_message_id === "wamid.dist.1").length, 1);
    // stale-claim takeover (a crashed first attempt): processed again, still one record everywhere
    store.state.whatsapp_inbound_claims["wamid.dist.2"].status = "processing"; store.state.whatsapp_inbound_claims["wamid.dist.2"].claimed_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await deliver(base, p2, "ok", "wamid.dist.2");
    assert.equal(store.state.inbound_events.filter((e) => e.external_event_id === "wamid.dist.2").length, 1); assert.equal(activitiesOf(l2.id).filter((a) => a.metadata.provider_message_id === "wamid.dist.2").length, 1);
    assert.equal(inboundEntries(await thread(l2.id)).filter((e) => e.text === "ok").length, 2);
    console.log("Dedupe. Two distinct messages = two entries; retries and stale-claim takeover = still one — PASS");

    // ---- outbound / manual replies keep working and are not disturbed ----
    const p3 = "2348033300001";
    await deliver(base, p3, "please call me", "wamid.man.1"); const l3 = leadFor(p3);
    await store.upsertLeadChannelState(l3.id, "whatsapp", { human_status: "human_active", human_owner: "super@ochiga.local", ai_paused: true });
    const before = sent.length;
    const reply = await fetch(`${base}/api/lead-agents/admin/leads/${l3.id}/whatsapp/reply`, { method: "POST", headers: { "content-type": "application/json", cookie: sup }, body: JSON.stringify({ body: "Calling you now", client_request_id: "vis-r1" }) });
    assert.equal(reply.status, 200); assert.equal(sent.length, before + 1);
    const t3 = await thread(l3.id);
    assert.equal(inboundEntries(t3).length, 1); assert.equal(t3.thread.entries.filter((e) => e.direction === "outbound" && e.text === "Calling you now").length, 1);
    assert.equal((await fetch(`${base}/api/lead-agents/admin/leads/${l3.id}/whatsapp/reply`, { method: "POST", headers: { "content-type": "application/json", cookie: staff }, body: JSON.stringify({ body: "x" }) })).status, 403);
    console.log("8. Manual replies unchanged: governed, one outbound, inbound still visible — PASS");

    // ---- CRM persistence failure is observable, never blocks intake, never sends, and is recoverable ----
    const failingActivities = new Proxy(store, { get: (t, p) => (p === "findCrmActivityByProviderMessageId" ? async () => { throw new Error("activity lookup failed"); } : typeof t[p] === "function" ? t[p].bind(t) : t[p]) });
    const failBase = await start(failingActivities); const p4 = "2348044400001"; const sentBefore = sent.length;
    const failed = await deliver(failBase, p4, "stored but crm record fails", "wamid.fail.1");
    assert.equal(failed.crm_record_failed, true, "the failure is flagged on the webhook result, not swallowed");
    const l4 = leadFor(p4); assert.ok(store.state.inbound_events.some((e) => e.external_event_id === "wamid.fail.1"), "the inbound event is stored");
    assert.ok(store.state.timeline_events.some((e) => e.lead_id === l4.id && e.event_type === "whatsapp_crm_record_failed"), "a durable, staff-visible marker records the failure");
    assert.equal(sent.length, sentBefore, "a CRM failure never triggers a send");
    assert.equal(activitiesOf(l4.id).length, 0, "no activity was written");
    const t4 = await thread(l4.id); assert.equal(inboundEntries(t4).filter((e) => e.text === "stored but crm record fails").length, 1, "yet the message is STILL visible in the conversation (read from the inbound event)");
    console.log("11. CRM write failure: flagged, marked, no send, message still visible — PASS");

    // ---- historical visibility recovery: read-model recovery, then idempotent repair ----
    const p5 = "2348055500001"; await deliver(base, p5, "seed", "wamid.hist.seed"); const l5 = leadFor(p5);
    const old = Date.now() - 3 * 24 * 3600 * 1000;
    const mkEvent = (id, text, ts, withActivity, legacyAt) => { store.state.inbound_events.push({ id: `ev-${id}`, channel: "whatsapp", provider: "meta", event_type: "message", lead_id: l5.id, external_event_id: id, payload: metaMessage(p5, text, id, Math.floor(ts / 1000)), created_at: new Date(ts + 3000).toISOString() }); if (withActivity) store.state.crm_activities.push({ id: `act-${id}`, lead_id: l5.id, activity_type: "whatsapp_message", title: "WhatsApp message", body: text, source: "whatsapp", metadata: { direction: "inbound", ai_replied: false }, occurred_at: new Date(legacyAt || ts + 3000).toISOString(), created_at: new Date(legacyAt || ts + 3000).toISOString() }); };
    mkEvent("wamid.hist.a", "Interested in land", old, true);          // legacy activity without provider id (matched one-to-one)
    mkEvent("wamid.hist.b", "Please call me", old + 60_000, false);     // takeover era: no activity at all
    mkEvent("wamid.hist.c", "ok", old + 120_000, true);                 // identical text twice, only ONE legacy activity...
    mkEvent("wamid.hist.d", "ok", old + 121_000, false);                // ...so one of the two is missing its record
    const eventsBefore = JSON.stringify(store.state.inbound_events); const sentBeforeRepair = sent.length;
    const tHist = await thread(l5.id); const histTexts = inboundEntries(tHist).filter((e) => ["Interested in land", "Please call me", "ok"].includes(e.text));
    assert.equal(histTexts.filter((e) => e.text === "Interested in land").length, 1, "a legacy activity and its event are ONE entry"); assert.equal(histTexts.filter((e) => e.text === "Please call me").length, 1, "a message with no activity is recovered from its event");
    assert.equal(histTexts.filter((e) => e.text === "ok").length, 2, "identical messages are not collapsed");
    const missing = (await visibility.findMissingInboundActivities(store)).would_create; const missingIds = missing.map((e) => e.provider_message_id).sort();
    assert.deepEqual(missingIds.filter((id) => id.startsWith("wamid.hist.")), ["wamid.hist.b", "wamid.hist.d"], "exactly the two messages without any CRM record are missing");
    const repairUrl = `${base}/api/lead-agents/admin/whatsapp/inbound-visibility/repair`;
    assert.equal((await fetch(repairUrl, { method: "POST", headers: { "content-type": "application/json", cookie: staff }, body: "{}" })).status, 403, "repair needs an integrations manager");
    const dry = await (await fetch(repairUrl, { method: "POST", headers: { "content-type": "application/json", cookie: sup }, body: "{}" })).json(); assert.equal(dry.dry_run, true, "dry run is the default"); assert.ok(dry.unique_missing_messages >= 2);
    assert.equal(activitiesOf(l5.id).filter((a) => ["wamid.hist.b", "wamid.hist.d"].includes(a.metadata.provider_message_id)).length, 0, "a dry run writes nothing");
    const applied = await (await fetch(repairUrl, { method: "POST", headers: { "content-type": "application/json", cookie: sup }, body: JSON.stringify({ dry_run: false }) })).json(); assert.equal(applied.dry_run, false); assert.ok(applied.created >= 2); assert.equal(applied.failed, 0);
    const created = activitiesOf(l5.id).filter((a) => ["wamid.hist.b", "wamid.hist.d"].includes(a.metadata.provider_message_id)); assert.equal(created.length, 2);
    for (const a of created) { const ev = store.state.inbound_events.find((e) => e.external_event_id === a.metadata.provider_message_id); assert.equal(a.occurred_at, new Date(Number(ev.payload.timestamp) * 1000).toISOString(), "original timestamp preserved"); assert.equal(a.lead_id, l5.id); }
    const again = await (await fetch(repairUrl, { method: "POST", headers: { "content-type": "application/json", cookie: sup }, body: JSON.stringify({ dry_run: false }) })).json(); assert.equal(again.created, 0, "the repair is idempotent"); assert.equal(again.unique_missing_messages, 0);
    assert.equal(JSON.stringify(store.state.inbound_events), eventsBefore, "original inbound events were not modified or deleted"); assert.equal(sent.length, sentBeforeRepair, "the repair sent nothing");
    const afterRepair = inboundEntries(await thread(l5.id)).filter((e) => ["Interested in land", "Please call me", "ok"].includes(e.text)); assert.equal(afterRepair.length, 4, "after repair every message still appears exactly once");
    assert.ok((await store.listAuditEvents(500)).some((e) => e.action === "whatsapp.inbound_visibility.repair"), "the repair is audited");
    console.log("9/10. Historical recovery: visible from events immediately; idempotent audited repair; events untouched; nothing sent — PASS");

    // ---- untouched invariants ----
    assert.equal((await store.getRuntimeSetting(WHATSAPP_AUTONOMY_SETTING_KEY)).value, false, "the test left autonomy OFF (it only toggled it inside its own temp store)");
    console.log(JSON.stringify({ status: "PASS", suite: "whatsapp-inbound-crm-visibility", states: states.length }));
  } finally {
    for (const server of servers) await close(server).catch(() => {});
    await close(backend).catch(() => {});
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
