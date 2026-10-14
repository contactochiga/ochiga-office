// Optional cross-repo contract test (not part of `npm test`): the compiled Ochiga-backend WhatsAppAdapter posting to this repo's real bridge route.
// Needs a built Backend (npm run build in Ochiga-backend); set OCHIGA_BACKEND_DIR if it is not at ../Documents/Ochiga-backend. Skips when absent.
const fsx = require("node:fs"), pathx = require("node:path");
const backendDir = process.env.OCHIGA_BACKEND_DIR || pathx.join(__dirname, "..", "..", "Documents", "Ochiga-backend");
if (!fsx.existsSync(pathx.join(backendDir, "dist", "services", "communicationRuntime", "adapters", "WhatsAppAdapter.js"))) { console.log("SKIP: built Ochiga-backend not found"); process.exit(0); }
const assert = require("node:assert/strict");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
process.env.OFFICE_SYNC_API_KEY = "e2e-shared-key";
(async () => {
  const sent = [];
  const adapter = { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: () => [], isConfigured: () => true, sendTextMessage: async (m) => { sent.push(m); return { delivered: true, response_code: 200, external_message_id: "wamid.e2e" }; }, sendTemplateMessage: async (m) => { sent.push(m); return { delivered: true, response_code: 200, external_message_id: "wamid.e2e" }; }, listApprovedTemplates: async () => [] };
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["k"], allowedOrigins: [], officeBackendApiKey: "e2e-shared-key" };
  const { store } = await createTempStore();
  const mk = (n) => new MemoryRateLimiter({ windowMs: 60000, maxRequests: n });
  const server = buildServer({ config, store, rateLimiter: mk(500), publicRateLimiter: mk(500), officeRateLimiter: mk(500), loginRateLimiter: mk(50), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.OFFICE_APP_URL = `http://127.0.0.1:${server.address().port}`;
  const { WhatsAppAdapter } = require("" + (process.env.OCHIGA_BACKEND_DIR || require("path").join(__dirname, "..", "..", "Documents", "Ochiga-backend")) + "/dist/services/communicationRuntime/adapters/WhatsAppAdapter.js");
  const backend = new WhatsAppAdapter();
  const rec = (over) => ({ communication_id: "e2e-1", body: "Hi", template_id: null, reply_to_message_id: null, recipient: { whatsapp_phone: "+2348012345678", lead_id: null }, actor_id: "staff-1", source: "conversation", governance: { requires_confirmation: true, confirmation_id: "e2e-1" }, ...over });
  const run = async (label, record, expectDelivered) => { sent.length = 0; const r = await backend.send(record); console.log(label, r.status, r.failure_reason || ""); assert.equal(r.status === "sent", expectDelivered, label); assert.equal(sent.length, expectDelivered ? 1 : 0, label); };
  // switch is OFF by default
  await run("OFF + goal (automation)", rec({ source: "automation", governance: { requires_confirmation: false, confirmation_id: null } }), false);
  await run("OFF + staff-confirmed conversation", rec({}), true);
  await run("OFF + staff-confirmed template", rec({ template_id: "hello_world@en_US", body: "" }), true);
  await run("OFF + conversation without confirmation evidence", rec({ governance: { requires_confirmation: true, confirmation_id: null } }), false);
  await store.setRuntimeSetting("whatsapp_autonomous_responses_enabled", true, "e2e");
  await run("ON + goal (automation)", rec({ source: "automation", governance: { requires_confirmation: false, confirmation_id: null } }), true);
  server.close(); console.log("E2E PASS");
})().catch((e) => { console.error(e); process.exit(1); });
