const assert = require("node:assert/strict");
const http = require("node:http");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { FileLeadAgentsStore } = require("../src/lead-agents/store-file");
const { hashPassword } = require("../src/lead-agents/auth");
const { evaluateAutonomousWhatsAppPolicy, WHATSAPP_AUTONOMY_SETTING_KEY } = require("../src/lead-agents/whatsapp-autonomy");

// Global WhatsApp autonomous-response switch: real HTTP surface, real file store, stubbed Meta adapter and stubbed Backend (Oyi Core + communication forward).
const KEY = "autonomy-bridge-key";
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const close = (server) => new Promise((resolve) => server.close(resolve));

async function main() {
  let goalActive = false, coreCalls = 0, coreDelayMs = 0;
  const backend = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", async () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/office/communications/webhook-event") return res.end(JSON.stringify({ ok: true, goal_active: goalActive }));
      if (req.url === "/office/conversation/corporate") { coreCalls++; if (coreDelayMs) await new Promise((r) => setTimeout(r, coreDelayMs)); return res.end(JSON.stringify({ ok: true, answer: "Hello from Oyi", conversation_thread_id: "oyi-thread-1" })); }
      res.statusCode = 404; res.end("{}");
    });
  });
  const backendPort = await listen(backend);

  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["autonomy-test-key"], allowedOrigins: [], officeBackendBaseUrl: `http://127.0.0.1:${backendPort}`, officeBackendApiKey: KEY, whatsappDisplayNumber: "+234 800 000 0000" };
  const { store, filePath } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super", status: "active" });
  await store.ensureAdminUser({ email: "staff@ochiga.local", password_hash: hashPassword("staff-pass-123"), role: "ochiga_staff", display_name: "Staff", status: "active" });

  const sent = [];
  let storeForServer = store;
  const adapter = {
    verifyWebhook: () => null,
    verifySignature: () => ({ ok: true, reason: null }),
    extractEvents: (body) => body.events || [],
    isConfigured: () => true,
    sendTextMessage: async (m) => { sent.push({ kind: "text", ...m }); return { delivered: true, response_code: 200, external_message_id: `wamid.out.${sent.length}` }; },
    sendTemplateMessage: async (m) => { sent.push({ kind: "template", ...m }); return { delivered: true, response_code: 200, external_message_id: `wamid.tpl.${sent.length}` }; },
    listApprovedTemplates: async () => [],
  };
  const buildFor = (s) => buildServer({
    config, store: s,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }), publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }), loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 50 }),
    whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store: s, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }),
  });
  let server = buildFor(storeForServer);
  let base = `http://127.0.0.1:${await listen(server)}`;

  const login = async (email, password) => {
    const res = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    assert.equal(res.status, 200); return res.headers.get("set-cookie").split(";")[0];
  };
  let msgSeq = 0;
  const inbound = async (from, text, id) => {
    const message_id = id || `wamid.in.${++msgSeq}`;
    const res = await fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ kind: "message", from, message_id, message_type: "text", timestamp: String(Math.floor(Date.now() / 1000)), text, raw: { id: message_id }, metadata: {}, contacts: [] }] }) });
    assert.equal(res.status, 200); return (await res.json()).results[0];
  };
  const bridge = (payload, headers = {}) => fetch(`${base}/api/lead-agents/admin/communications/whatsapp/send`, { method: "POST", headers: { "content-type": "application/json", "x-office-api-key": KEY, ...headers }, body: JSON.stringify(payload) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const setSwitch = (cookie, enabled) => fetch(`${base}/api/lead-agents/admin/settings/whatsapp-autonomy`, { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ enabled }) });
  const getSwitch = async (cookie) => (await (await fetch(`${base}/api/lead-agents/admin/settings/whatsapp-autonomy`, { headers: { cookie } })).json()).whatsapp_autonomy;
  const leadFor = async (phone) => (await store.listLeads()).find((l) => l.whatsapp_phone === phone);

  try {
    const superCookie = await login("super@ochiga.local", "super-pass-123");
    const staffCookie = await login("staff@ochiga.local", "staff-pass-123");

    // 1. Default OFF: inbound creates the lead and CRM records; nothing is sent; Oyi Core is not asked to draft a reply.
    assert.equal((await getSwitch(superCookie)).enabled, false, "default is OFF");
    assert.equal((await getSwitch(superCookie)).source, "default");
    const r1 = await inbound("2348011111111", "Hello, I own land in Lekki");
    assert.equal(r1.suppressed, true); assert.equal(r1.reason, "autonomous_whatsapp_disabled");
    assert.equal(sent.length, 0, "default OFF: no autonomous outbound");
    assert.equal(coreCalls, 0, "OFF: no reply is generated");
    const lead1 = await leadFor("2348011111111");
    assert.ok(lead1, "the inbound message still creates the lead");
    assert.ok((await store.listInboundEvents?.({ channel: "whatsapp" }) ?? store.state.inbound_events).some((e) => e.external_event_id === "wamid.in.1"), "inbound event stored");
    const timeline1 = store.state.timeline_events.filter((e) => e.lead_id === lead1.id);
    assert.ok(timeline1.some((e) => e.event_type === "whatsapp_autonomous_reply_suppressed"), "the suppression is recorded on the lead");
    console.log("1. Default OFF: lead + inbound + CRM record kept, no autonomous outbound — PASS");

    // 2/3. OFF blocks the Backend (goal/automation/unlabelled) bridge send; a staff-confirmed bridge send is governed manual communication and is allowed.
    const blockedGoal = await bridge({ to: "+2348011111111", body: "follow up", lead_id: lead1.id, communication_id: "c1", send_origin: "autonomous" });
    assert.equal(blockedGoal.body.delivered, false); assert.equal(blockedGoal.body.failure_reason, "autonomous_whatsapp_disabled");
    const blockedUnlabelled = await bridge({ to: "+2348011111111", body: "follow up", lead_id: lead1.id, communication_id: "c2" });
    assert.equal(blockedUnlabelled.body.failure_reason, "autonomous_whatsapp_disabled", "an unlabelled bridge send is autonomous (fail closed)");
    const blockedTemplate = await bridge({ to: "+2348011111111", template_name: "hello_world", lead_id: lead1.id, communication_id: "c2t", send_origin: "autonomous" });
    assert.equal(blockedTemplate.body.failure_reason, "autonomous_whatsapp_disabled");
    assert.equal(sent.length, 0);
    console.log("2/3. OFF blocks Office direct reply and every autonomous/unlabelled Backend bridge send — PASS");

    // 4. OFF does not block authorised manual communication.
    const manualBridge = await bridge({ to: "+2348011111111", body: "Staff confirmed message", lead_id: lead1.id, communication_id: "c3", send_origin: "staff_confirmed" });
    assert.equal(manualBridge.body.delivered, true); assert.equal(sent.length, 1);
    // governed Office manual reply: needs permission and an active takeover
    const noTakeover = await fetch(`${base}/api/lead-agents/admin/leads/${lead1.id}/whatsapp/reply`, { method: "POST", headers: { "content-type": "application/json", cookie: superCookie }, body: JSON.stringify({ body: "Hi from staff" }) });
    assert.equal(noTakeover.status, 409, "manual reply requires the human to own the conversation");
    await store.upsertLeadChannelState(lead1.id, "whatsapp", { human_status: "human_active", human_owner: "super@ochiga.local" });
    const manual = await fetch(`${base}/api/lead-agents/admin/leads/${lead1.id}/whatsapp/reply`, { method: "POST", headers: { "content-type": "application/json", cookie: superCookie }, body: JSON.stringify({ body: "Hi from staff" }) });
    assert.equal(manual.status, 200); assert.equal((await manual.json()).delivered, true); assert.equal(sent.length, 2, "manual reply sent while the switch is OFF");
    assert.ok(store.state.audit_events.some((e) => e.action === "communication.whatsapp.manual_reply" && e.actor_email === "super@ochiga.local"), "manual reply audited with the operator");
    await store.upsertLeadChannelState(lead1.id, "whatsapp", { human_status: "auto" });
    console.log("4. OFF does not block governed manual replies (staff-confirmed bridge, Office manual route) — PASS");

    // Authority: ordinary staff cannot change the switch; the failed attempt changes nothing.
    const forbidden = await setSwitch(staffCookie, true);
    assert.equal(forbidden.status, 403); assert.equal((await getSwitch(superCookie)).enabled, false);

    // 5. ON permits eligible autonomous replies; nothing suppressed earlier is replayed.
    sent.length = 0; const suppressedBefore = coreCalls;
    const on = await setSwitch(superCookie, true);
    assert.equal(on.status, 200); const onBody = await on.json();
    assert.equal(onBody.whatsapp_autonomy.enabled, true); assert.equal(onBody.whatsapp_autonomy.updated_by, "super@ochiga.local");
    assert.equal(sent.length, 0, "switching ON sends nothing by itself (no replay of suppressed replies)");
    assert.equal(coreCalls, suppressedBefore);
    const r5 = await inbound("2348011111111", "Are you still there?");
    assert.equal(r5.outbound?.delivered, true); assert.equal(sent.length, 1); assert.equal(sent[0].body, "Hello from Oyi");
    const allowedBridge = await bridge({ to: "+2348011111111", body: "goal follow up", lead_id: lead1.id, communication_id: "c4", send_origin: "autonomous" });
    assert.equal(allowedBridge.body.delivered, true);
    console.log("5. ON permits eligible replies and bridge sends; no replay when switching ON — PASS");

    // 11. duplicate delivery of the same inbound message id is acknowledged without a second reply.
    sent.length = 0;
    const first = await inbound("2348022222222", "Hi", "wamid.dup.1");
    assert.equal(first.outbound?.delivered, true);
    const dup = await inbound("2348022222222", "Hi", "wamid.dup.1");
    assert.equal(dup.duplicate, true); assert.equal(sent.length, 1, "no duplicate reply for a retried delivery");
    const lead2 = await leadFor("2348022222222");

    // 6. Per-lead pause overrides global ON.
    sent.length = 0;
    await store.upsertLeadChannelState(lead2.id, "whatsapp", { ai_paused: true });
    const paused = await inbound("2348022222222", "Anyone there?");
    assert.equal(paused.paused, true); assert.equal(sent.length, 0);
    await store.upsertLeadChannelState(lead2.id, "whatsapp", { ai_paused: false });

    // 7. Human takeover survives a new incoming message (and blocks the reply).
    await store.upsertLeadChannelState(lead2.id, "whatsapp", { human_status: "human_active", human_owner: "super@ochiga.local", takeover_reason: "test" });
    const takeover = await inbound("2348022222222", "Hello again");
    assert.equal(takeover.paused, true); assert.equal(sent.length, 0);
    const stateAfter = await store.getLeadChannelState(lead2.id, "whatsapp");
    assert.equal(stateAfter.human_status, "human_active", "an inbound message must not reset an active takeover");
    assert.equal(stateAfter.human_owner, "super@ochiga.local");
    // the bridge also honours takeover for autonomous sends
    const bridgeTakeover = await bridge({ to: "+2348022222222", body: "x", lead_id: lead2.id, communication_id: "c5", send_origin: "autonomous" });
    assert.equal(bridgeTakeover.body.failure_reason, "human_takeover_active");
    await store.upsertLeadChannelState(lead2.id, "whatsapp", { human_status: "auto" });
    console.log("6/7. Per-lead pause and human takeover override global ON; takeover survives inbound — PASS");

    // 9. Simultaneous inbound messages cannot bypass OFF (and a toggle during generation wins at send time).
    sent.length = 0; coreCalls = 0;
    assert.equal((await setSwitch(superCookie, false)).status, 200);
    const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => inbound(`23480333333${String(i).padStart(2, "0")}`, "burst")));
    assert.ok(burst.every((r) => r.suppressed === true)); assert.equal(sent.length, 0); assert.equal(coreCalls, 0);
    assert.equal((await setSwitch(superCookie, true)).status, 200);
    coreDelayMs = 250; sent.length = 0;
    const racing = inbound("2348044444444", "slow reply please");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await setSwitch(superCookie, false)).status, 200); // switched OFF while the reply is being generated
    const racedResult = await racing; coreDelayMs = 0;
    assert.equal(racedResult.suppressed, true); assert.equal(racedResult.reason, "autonomous_whatsapp_disabled"); assert.equal(sent.length, 0, "OFF during generation: the pre-send re-check blocks the send");
    console.log("9. Concurrent inbound cannot bypass OFF; a switch-off during generation blocks the send — PASS");

    // 8. The setting survives a restart (new store instance on the same file, new server).
    await close(server);
    const restarted = new FileLeadAgentsStore(filePath); await restarted.init();
    storeForServer = restarted; server = buildFor(restarted); base = `http://127.0.0.1:${await listen(server)}`;
    const cookie2 = await login("super@ochiga.local", "super-pass-123");
    const afterRestart = await getSwitch(cookie2);
    assert.equal(afterRestart.enabled, false); assert.equal(afterRestart.source, "stored"); assert.equal(afterRestart.updated_by, "super@ochiga.local");
    assert.equal((await setSwitch(cookie2, true)).status, 200);
    await close(server);
    const restarted2 = new FileLeadAgentsStore(filePath); await restarted2.init();
    assert.equal((await restarted2.getRuntimeSetting(WHATSAPP_AUTONOMY_SETTING_KEY)).value, true, "ON also survives a restart");
    server = buildFor(restarted2); base = `http://127.0.0.1:${await listen(server)}`;
    const cookie3 = await login("super@ochiga.local", "super-pass-123");
    console.log("8. Setting persists across restarts — PASS");

    // 10. Read failure fails closed: policy, webhook and bridge all refuse; the UI-facing status reports unknown, never ON.
    const brokenStore = new Proxy(restarted2, { get: (t, p) => (p === "getRuntimeSetting" ? async () => { throw new Error("db down"); } : typeof t[p] === "function" ? t[p].bind(t) : t[p]) });
    assert.deepEqual((await evaluateAutonomousWhatsAppPolicy(brokenStore)).allowed, false);
    assert.equal((await evaluateAutonomousWhatsAppPolicy(brokenStore)).reason, "setting_unreadable");
    await close(server);
    server = buildFor(brokenStore); base = `http://127.0.0.1:${await listen(server)}`;
    const cookie4 = await login("super@ochiga.local", "super-pass-123");
    sent.length = 0;
    const failClosed = await inbound("2348055555555", "while db is down");
    assert.equal(failClosed.suppressed, true); assert.equal(failClosed.reason, "setting_unreadable"); assert.equal(sent.length, 0);
    const failBridge = await bridge({ to: "+2348055555555", body: "x", communication_id: "c6", send_origin: "autonomous" });
    assert.equal(failBridge.body.failure_reason, "autonomy_setting_unreadable");
    const status = await getSwitch(cookie4);
    assert.equal(status.enabled, false); assert.equal(status.state, "unknown_fail_closed");
    // a failed save must not look like success
    const brokenWrite = new Proxy(restarted2, { get: (t, p) => (p === "setRuntimeSetting" ? async () => { throw new Error("write failed"); } : typeof t[p] === "function" ? t[p].bind(t) : t[p]) });
    await close(server);
    server = buildFor(brokenWrite); base = `http://127.0.0.1:${await listen(server)}`;
    const cookie5 = await login("super@ochiga.local", "super-pass-123");
    const failedSave = await setSwitch(cookie5, false);
    assert.equal(failedSave.status, 503); assert.equal((await failedSave.json()).error, "setting_not_saved");
    assert.equal((await restarted2.getRuntimeSetting(WHATSAPP_AUTONOMY_SETTING_KEY)).value, true, "a failed save changes nothing");
    console.log("10. Unreadable setting fails closed; failed save reports failure and changes nothing — PASS");

    // 12. Audit: operator, old and new value recorded for every change.
    const changes = restarted2.state.audit_events.filter((e) => e.action === "whatsapp_autonomy_setting_changed" && e.metadata?.new_value !== undefined);
    assert.ok(changes.length >= 4);
    const firstChange = changes[0];
    assert.equal(firstChange.actor_email, "super@ochiga.local"); assert.equal(firstChange.metadata.old_value, null); assert.equal(firstChange.metadata.new_value, true);
    assert.ok(changes.some((c) => c.metadata.old_value === true && c.metadata.new_value === false));
    assert.ok(restarted2.state.audit_events.some((e) => e.action === "whatsapp_autonomy_setting_changed" && e.status === "failure"), "failed save audited");
    console.log("12. Audit records operator, timestamp, old and new value — PASS");
    void cookie3;
  } finally {
    await close(server).catch(() => {}); await close(backend).catch(() => {});
  }
  console.log(JSON.stringify({ status: "PASS", suite: "whatsapp-autonomy-control" }));
}
main().catch((error) => { console.error(error); process.exit(1); });
