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
const { evaluateAutonomousWhatsAppPolicy, WHATSAPP_AUTONOMY_SETTING_KEY, signStaffConfirmation, verifyStaffConfirmedSend } = require("../src/lead-agents/whatsapp-autonomy");

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
  // a genuine staff-confirmation attestation, built exactly as Backend's WhatsAppAdapter builds it (shared key, no new secret)
  const attested = (payload, overrides = {}) => {
    const attestation = { confirmed_by: "staff-user-1", confirmation_id: `conf-${payload.communication_id}`, confirmed_at: new Date().toISOString(), ...overrides };
    attestation.signature = overrides.signature || signStaffConfirmation(payload, attestation, KEY);
    return { ...payload, send_origin: "staff_confirmed", staff_confirmation: attestation };
  };
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
    const manualBridge = await bridge(attested({ to: "+2348011111111", body: "Staff confirmed message", lead_id: lead1.id, communication_id: "c3" }));
    assert.equal(manualBridge.body.delivered, true); assert.equal(sent.length, 1);
    // governed Office manual reply: needs permission and an active takeover
    const noTakeover = await fetch(`${base}/api/lead-agents/admin/leads/${lead1.id}/whatsapp/reply`, { method: "POST", headers: { "content-type": "application/json", cookie: superCookie }, body: JSON.stringify({ body: "Hi from staff" }) });
    assert.equal(noTakeover.status, 409, "manual reply requires the human to own the conversation");
    await store.upsertLeadChannelState(lead1.id, "whatsapp", { ai_paused: true });
    const pausedOnly = await fetch(`${base}/api/lead-agents/admin/leads/${lead1.id}/whatsapp/reply`, { method: "POST", headers: { "content-type": "application/json", cookie: superCookie }, body: JSON.stringify({ body: "x" }) });
    assert.equal(pausedOnly.status, 409, "an AI pause alone is not a human takeover");
    await store.upsertLeadChannelState(lead1.id, "whatsapp", { ai_paused: false });
    const staffNoPerm = await fetch(`${base}/api/lead-agents/admin/leads/${lead1.id}/whatsapp/reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "x" }) });
    assert.ok([401, 403].includes(staffNoPerm.status), "unauthenticated manual reply is refused");
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
    const racedLead = await leadFor("2348044444444");
    const racedTimeline = store.state.timeline_events.filter((e) => e.lead_id === racedLead.id);
    assert.ok(racedTimeline.some((e) => e.event_type === "whatsapp_autonomous_reply_suppressed" && e.metadata?.stage === "before_send"));
    assert.ok(!racedTimeline.some((e) => e.event_type === "oyi_core_whatsapp_turn"), "a blocked reply is never recorded as an Oyi turn that was delivered");
    console.log("9. Concurrent inbound cannot bypass OFF; a switch-off during generation blocks the send — PASS");

    // ---- Negative controls (switch OFF unless stated) ----
    assert.equal((await getSwitch(superCookie)).enabled, false);
    sent.length = 0;
    // A. missing lead_id   B. autonomous template (also unlabelled)   D. Backend automation   E. unresolved CRM identity (unknown recipient, no lead)
    const nA = await bridge({ to: "+2348099999991", body: "x", communication_id: "nA", send_origin: "autonomous" });
    const nB = await bridge({ to: "+2348099999992", template_name: "hello_world", template_language: "en_US", communication_id: "nB" });
    const nD = await bridge({ to: "+2348099999993", body: "automation follow-up", communication_id: "nD", send_origin: "autonomous", lead_id: "lead-from-automation" });
    const nE = await bridge({ to: "+2348099999994", body: "who is this", communication_id: "nE" });
    for (const [name, r] of [["A", nA], ["B", nB], ["D", nD], ["E", nE]]) { assert.equal(r.body.delivered, false, `negative control ${name}`); assert.equal(r.body.failure_reason, "autonomous_whatsapp_disabled", `negative control ${name}`); }
    // C. forged staff_confirmed origin: bare label, wrong signature, tampered content, tampered recipient, stale, from the future, missing fields, wrong key
    const forged = [
      ["bare label", { to: "+2348099999995", body: "x", communication_id: "nC1", send_origin: "staff_confirmed" }],
      ["empty attestation", { to: "+2348099999995", body: "x", communication_id: "nC2", send_origin: "staff_confirmed", staff_confirmation: {} }],
      ["wrong signature", attested({ to: "+2348099999995", body: "x", communication_id: "nC3" }, { signature: "00".repeat(32) })],
      ["not hex", attested({ to: "+2348099999995", body: "x", communication_id: "nC4" }, { signature: "zz" })],
      ["stale", attested({ to: "+2348099999995", body: "x", communication_id: "nC5" }, { confirmed_at: new Date(Date.now() - 3600_000).toISOString() })],
      ["future", attested({ to: "+2348099999995", body: "x", communication_id: "nC6" }, { confirmed_at: new Date(Date.now() + 3600_000).toISOString() })],
      ["missing confirmed_by", attested({ to: "+2348099999995", body: "x", communication_id: "nC7" }, { confirmed_by: "" })],
      ["missing communication_id", attested({ to: "+2348099999995", body: "x", communication_id: "" })],
    ];
    for (const [name, payload] of forged) { const r = await bridge(payload); assert.equal(r.body.delivered, false, `forged origin (${name}) must not bypass OFF`); assert.equal(r.body.failure_reason, "autonomous_whatsapp_disabled", name); }
    const good = attested({ to: "+2348099999995", body: "approved text", communication_id: "nC9" });
    const tamperedBody = { ...good, body: "different text the human never approved" };
    const tamperedTo = { ...good, to: "+2348099999000" };
    const tamperedTemplate = { ...good, body: undefined, template_name: "other_template" };
    for (const [name, payload] of [["tampered body", tamperedBody], ["tampered recipient", tamperedTo], ["swapped to template", tamperedTemplate]]) { const r = await bridge(payload); assert.equal(r.body.failure_reason, "autonomous_whatsapp_disabled", name); }
    const wrongKey = attested({ to: "+2348099999995", body: "x", communication_id: "nC10" }); wrongKey.staff_confirmation.signature = signStaffConfirmation({ to: "+2348099999995", body: "x", communication_id: "nC10" }, wrongKey.staff_confirmation, "some-other-key");
    assert.equal((await bridge(wrongKey)).body.failure_reason, "autonomous_whatsapp_disabled", "signed with the wrong key");
    assert.equal(sent.length, 0, "no forged or autonomous bridge send reached Meta");
    assert.ok(store.state.audit_events.some((e) => e.action === "communication.whatsapp.origin_rejected"), "rejected origins are audited");
    // cross-repo contract vector (the same constants are asserted by Ochiga-backend's whatsapp-send-origin smoke)
    assert.equal(signStaffConfirmation({ communication_id: "comm-1", to: "+2348012345678", body: "Hello from staff" }, { confirmed_by: "user-1", confirmation_id: "conf-1", confirmed_at: "2026-10-14T12:00:00.000Z" }, "contract-key"), "ac5d8e89cb402019cb4fcc924ee5813615b12350fdc42506671cfaee146bda56");
    assert.equal(signStaffConfirmation({ communication_id: "comm-2", to: "+2348012345678", template_name: "hello_world", template_language: "en_US" }, { confirmed_by: "user-1", confirmation_id: "conf-2", confirmed_at: "2026-10-14T12:00:00.000Z" }, "contract-key"), "6b827a44ad27b83ce00fb102feec0c7d37a0190383a42b2b400ddbf4528c8ff6");
    assert.equal(verifyStaffConfirmedSend(good, KEY).confirmed, true); assert.equal(verifyStaffConfirmedSend(good, KEY).confirmed_by, "staff-user-1");
    // a genuine attested send still goes through while OFF, and carries the confirming staff identity into the audit trail
    const genuine = await bridge(good); assert.equal(genuine.body.delivered, true); assert.equal(sent.length, 1);
    assert.ok(store.state.audit_events.some((e) => e.action === "communication.whatsapp.sent" && e.metadata?.confirmed_by === "staff-user-1" && e.metadata?.send_origin === "staff_confirmed"));
    // template variant of a genuine confirmation
    const tplGood = attested({ to: "+2348099999996", template_name: "hello_world", template_language: "en_US", communication_id: "nC11" });
    assert.equal((await bridge(tplGood)).body.delivered, true);
    sent.length = 0;
    // J. switch turned OFF between draft and send: the message was prepared while ON, dispatched after OFF
    assert.equal((await setSwitch(superCookie, true)).status, 200);
    const draft = { to: "+2348099999997", body: "prepared while ON", communication_id: "nJ", send_origin: "autonomous", lead_id: lead1.id };
    assert.equal((await setSwitch(superCookie, false)).status, 200);
    const afterOff = await bridge(draft);
    assert.equal(afterOff.body.delivered, false); assert.equal(afterOff.body.failure_reason, "autonomous_whatsapp_disabled"); assert.equal(sent.length, 0, "a send prepared while ON is blocked by the final check after OFF");
    // F/G (global ON + per-lead pause / takeover) are proven above (steps 6/7). H. concurrent duplicate deliveries of ONE provider message id
    assert.equal((await setSwitch(superCookie, true)).status, 200);
    sent.length = 0; coreCalls = 0;
    const dupResults = await Promise.all(Array.from({ length: 6 }, () => inbound("2348066666666", "same message delivered six times", "wamid.concurrent.1")));
    assert.equal(sent.length, 1, "six concurrent deliveries of one message id produce exactly one reply");
    assert.equal(dupResults.filter((r) => r.outbound?.delivered).length, 1); assert.equal(dupResults.filter((r) => r.duplicate).length, 5);
    assert.equal(store.state.inbound_events.filter((e) => e.external_event_id === "wamid.concurrent.1" && e.event_type === "message").length, 1, "stored exactly once");
    assert.equal((await store.listLeads()).filter((l) => l.whatsapp_phone === "2348066666666").length, 1, "concurrent first-contact deliveries of one message id create exactly one lead");
    // idempotency edge cases (switch ON): no provider id, a late retry of a message processed long ago, stale-claim takeover with and without a reply already sent
    const rawEvent = (from, id, text) => fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ kind: "message", from, message_id: id, message_type: "text", timestamp: String(Math.floor(Date.now() / 1000)), text, raw: {}, metadata: {}, contacts: [] }] }) }).then(async (r) => (await r.json()).results[0]);
    sent.length = 0;
    const noId = await rawEvent("2348077777777", undefined, "message without a provider id");
    assert.equal(noId.suppressed, true); assert.equal(noId.reason, "no_provider_message_id"); assert.equal(sent.length, 0, "no autonomous reply can be made idempotent without a provider id");
    assert.ok(await leadFor("2348077777777"), "...but the message is still captured in the CRM");
    await store.claimInboundMessage({ providerMessageId: "wamid.historical.1" }); await store.updateInboundClaim("wamid.historical.1", { status: "completed", reply_sent_at: new Date().toISOString() });
    const leadsBefore = (await store.listLeads()).length;
    const lateRetry = await rawEvent("2348088888888", "wamid.historical.1", "a retry of a message answered long ago");
    assert.equal(lateRetry.duplicate, true); assert.equal(sent.length, 0); assert.equal((await store.listLeads()).length, leadsBefore, "a late retry creates no lead and no reply");
    await store.claimInboundMessage({ providerMessageId: "wamid.stale.sent" }); await store.updateInboundClaim("wamid.stale.sent", { reply_sent_at: new Date().toISOString() });
    store.state.whatsapp_inbound_claims["wamid.stale.sent"].claimed_at = new Date(Date.now() - 3600_000).toISOString();
    const staleSent = await rawEvent("2348099900001", "wamid.stale.sent", "crashed after replying");
    assert.equal(staleSent.suppressed, true); assert.equal(staleSent.reason, "reply_already_sent"); assert.equal(sent.length, 0, "a takeover never sends a second reply");
    await store.claimInboundMessage({ providerMessageId: "wamid.stale.unsent" });
    store.state.whatsapp_inbound_claims["wamid.stale.unsent"].claimed_at = new Date(Date.now() - 3600_000).toISOString();
    const staleUnsent = await rawEvent("2348099900002", "wamid.stale.unsent", "crashed before replying");
    assert.equal(staleUnsent.outbound?.delivered, true); assert.equal(sent.length, 1, "a stale unfinished claim is completed exactly once");
    assert.equal(store.state.whatsapp_inbound_claims["wamid.stale.unsent"].status, "completed");
    assert.equal((await rawEvent("2348099900002", "wamid.stale.unsent", "again")).duplicate, true);
    assert.equal((await setSwitch(superCookie, false)).status, 200);
    console.log("A-E,J,H negative controls (missing lead, template, forged/tampered/stale origin, automation, unresolved identity, OFF between draft and send, concurrent duplicates) — PASS");

    const raw = JSON.stringify(await (await fetch(`${base}/api/lead-agents/admin/settings/whatsapp-autonomy`, { headers: { cookie: superCookie } })).json());
    for (const secret of [config.officeBackendApiKey, config.whatsappAccessToken, config.whatsappVerifyToken, config.metaAppSecret].filter(Boolean)) assert.ok(!raw.includes(secret), "the settings response never contains credentials");
    assert.match(raw, /\+234 800 000 0000/, "the official number is display-only config");
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
    // database claim unavailable (switch ON): the message is kept, no autonomous reply
    assert.equal((await restarted2.getRuntimeSetting(WHATSAPP_AUTONOMY_SETTING_KEY)).value, true);
    const noClaim = new Proxy(restarted2, { get: (t, p) => (p === "claimInboundMessage" ? async () => { throw new Error("claims table unavailable"); } : typeof t[p] === "function" ? t[p].bind(t) : t[p]) });
    await close(server); server = buildFor(noClaim); base = `http://127.0.0.1:${await listen(server)}`;
    sent.length = 0;
    const claimDown = await inbound("2348012300000", "claims database is down");
    assert.equal(claimDown.suppressed, true); assert.equal(claimDown.reason, "claim_unavailable"); assert.equal(sent.length, 0);
    assert.ok(restarted2.state.leads.some((l) => l.whatsapp_phone === "2348012300000"), "the enquiry still reaches the CRM");
    await close(server); server = buildFor(brokenStore); base = `http://127.0.0.1:${await listen(server)}`;
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
