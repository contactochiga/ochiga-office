const assert = require("node:assert/strict");
const http = require("node:http");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
// Emergency rollback build: WhatsApp keeps receiving into the CRM, nothing is sent autonomously, even with a Backend that is replying and even for template/goal sends.
(async () => {
  let coreCalls = 0;
  const backend = http.createServer((req, res) => { let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => { res.setHeader("content-type", "application/json"); if (req.url.includes("conversation")) coreCalls++; res.end(JSON.stringify({ ok: true, answer: "Hello", goal_active: false })); }); });
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["k"], allowedOrigins: [], officeBackendBaseUrl: `http://127.0.0.1:${backend.address().port}`, officeBackendApiKey: "bridge" };
  const { store } = await createTempStore();
  const sent = [];
  const adapter = { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: (b) => b.events, isConfigured: () => true, sendTextMessage: async (m) => (sent.push(m), { delivered: true, external_message_id: "w" }), sendTemplateMessage: async (m) => (sent.push(m), { delivered: true, external_message_id: "w" }), listApprovedTemplates: async () => [] };
  const mk = (n) => new MemoryRateLimiter({ windowMs: 60000, maxRequests: n });
  const server = buildServer({ config, store, rateLimiter: mk(500), publicRateLimiter: mk(500), officeRateLimiter: mk(500), loginRateLimiter: mk(50), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ kind: "message", from: "2348011111111", message_id: "wamid.rb.1", message_type: "text", timestamp: String(Math.floor(Date.now() / 1000)), text: "Hello", raw: {}, metadata: {}, contacts: [] }] }) });
    const out = (await res.json()).results[0];
    assert.equal(out.suppressed, true); assert.equal(sent.length, 0, "rollback build never replies autonomously");
    assert.equal(coreCalls, 0, "Oyi Core is not asked to draft a reply");
    assert.ok(store.state.leads.some((l) => l.whatsapp_phone === "2348011111111"), "the enquiry still reaches the CRM");
    assert.ok(store.state.inbound_events.some((e) => e.external_event_id === "wamid.rb.1"), "the inbound event is stored");
    for (const payload of [{ to: "+2348011111111", body: "goal" }, { to: "+2348011111111", template_name: "hello_world", lead_id: "x" }, { to: "+2348011111111", body: "claims staff", send_origin: "staff_confirmed" }]) {
      const r = await (await fetch(`${base}/api/lead-agents/admin/communications/whatsapp/send`, { method: "POST", headers: { "content-type": "application/json", "x-office-api-key": "bridge" }, body: JSON.stringify(payload) })).json();
      assert.equal(r.delivered, false); assert.equal(r.failure_reason, "autonomous_whatsapp_disabled");
    }
    assert.equal(sent.length, 0);
    console.log(JSON.stringify({ status: "PASS", suite: "whatsapp-hard-off-rollback" }));
  } finally { server.close(); backend.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
