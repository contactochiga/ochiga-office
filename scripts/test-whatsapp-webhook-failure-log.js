// Sanitized per-event failure logging on the WhatsApp webhook (Asset Guard branch). Real HMAC-signed requests, real WhatsAppCloudAdapter, real HTTP server,
// file store with ONE injected failure, stubbed Backend, spy on outbound sends, and a capture of every log line written during each request. Proves:
//   * a failing event logs exactly: correlation id, event kind, HTTP status, allowlisted error code -- no exception text, payload, customer or provider ids,
//     URLs or credentials; unknown codes become "unclassified"; an unsafe correlation id is replaced;
//   * the Asset Guard still filters a mixed batch (foreign entry dropped, counts-only diagnostics) and still processes the valid events around a failure;
//   * signature enforcement is unchanged; autonomous replies stay OFF (nothing is sent).
// Fixture ids and secrets only.
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { WhatsAppCloudAdapter } = require("../src/lead-agents/whatsapp");
const failure = require("../src/lead-agents/whatsapp-webhook-failure");

let checks = 0;
const ok = (cond, name) => { assert.ok(cond, name); checks += 1; console.log("PASS " + name); };
const SECRET = "fixture-app-secret-for-tests-only-0123456789";
const WABA = "100000000000001", PHONE_ID = "100000000000002", FOREIGN_WABA = "100000000000099";
const FAILING_PHONE = "2348099999999", OK_PHONE = "2348011111111";
const SENSITIVE = [FAILING_PHONE, OK_PHONE, "wamid.", "supabase.co", "https://", "Bearer", "secret-token-value", "Hello there", WABA, PHONE_ID, FOREIGN_WABA];
const sign = (bytes) => `sha256=${crypto.createHmac("sha256", SECRET).update(bytes).digest("hex")}`;
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

function unitChecks() {
  const f = failure.processingFailureFields;
  const axiosLike = Object.assign(new Error(`insert failed for ${FAILING_PHONE} at https://x.supabase.co/rest/v1 Bearer secret-token-value`), { response: { status: 409, data: { code: "23505", message: `duplicate ${FAILING_PHONE}` } }, config: { url: "https://x.supabase.co/rest/v1/leads", headers: { authorization: "Bearer secret-token-value" } } });
  ok(JSON.stringify(f(axiosLike)) === JSON.stringify({ http_status: 409, error_code: "23505" }), "unit: HTTP status and an allowlisted database code; nothing else from the error");
  ok(JSON.stringify(f(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))) === JSON.stringify({ http_status: null, error_code: "ECONNRESET" }), "unit: network failure -> no status, allowlisted transport code");
  ok(f(Object.assign(new Error("x"), { code: "SECRET_INTERNAL_CODE_abc123" })).error_code === "unclassified" && f(new Error(`boom ${FAILING_PHONE}`)).error_code === "unclassified" && f(null).error_code === "unclassified", "unit: any code not on the allowlist (or no code) -> unclassified");
  ok(f({ response: { status: 9999 } }).http_status === null && f({ statusCode: 503 }).http_status === 503 && f({ response: { status: "500" } }).http_status === 500, "unit: only a real HTTP status (100-599) is kept");
  ok(failure.safeRequestId("3f53b97b-e610-4b03-b22c-11cb69f9f591") === "3f53b97b-e610-4b03-b22c-11cb69f9f591" && failure.safeRequestId("evil\n{\"injected\":1}") === "invalid" && failure.safeRequestId("x".repeat(65)) === "invalid" && failure.safeRequestId(undefined) === "invalid", "unit: correlation id kept only in a safe shape");
  const fields = failure.eventFailureLogFields({ requestId: "req-1", event: { kind: "message", from: FAILING_PHONE, message_id: "wamid.x", raw: { text: { body: "Hello there" } } }, error: axiosLike });
  ok(JSON.stringify(Object.keys(fields).sort()) === JSON.stringify(["error_code", "http_status", "kind", "request_id"]) && !SENSITIVE.some((s) => JSON.stringify(fields).includes(s)), "unit: the log record has exactly the four approved fields and no sensitive value");
  ok(failure.eventFailureLogFields({ requestId: "r", event: { kind: "<script>" }, error: null }).kind === "unknown", "unit: unknown event kinds are not echoed");
}

async function main() {
  unitChecks();
  let backendCalls = 0;
  const backend = http.createServer((req, res) => { backendCalls++; req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, goal_active: false, opted_out: false, opt_out_status: "not_opted_out" })); }); });
  const backendPort = await listen(backend);
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["k"], allowedOrigins: [], officeBackendBaseUrl: `http://127.0.0.1:${backendPort}`, officeBackendApiKey: "b", metaAppSecret: SECRET, whatsappVerifyToken: "v", whatsappAccessToken: "fixture-access-token", whatsappPhoneNumberId: PHONE_ID, whatsappBusinessAccountId: WABA };
  const { store } = await createTempStore();
  // ONE injected failure: looking up the failing sender throws an error full of sensitive detail
  const failing = new Proxy(store, { get(target, prop) {
    if (prop === "findLeadByPhone") return async (phone) => { if (phone === FAILING_PHONE) throw Object.assign(new Error(`lookup failed for ${phone} at https://x.supabase.co/rest/v1/leads Bearer secret-token-value`), { response: { status: 409, data: { code: "23505", hint: `phone ${phone}` } } }); return target.findLeadByPhone(phone); };
    const v = target[prop]; return typeof v === "function" ? v.bind(target) : v;
  } });
  const real = new WhatsAppCloudAdapter(config);
  const adapter = Object.create(real);
  const sent = [];
  adapter.sendTextMessage = async (m) => { sent.push(m); return { delivered: true }; };
  const rl = () => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 9999 });
  const server = buildServer({ config, store: failing, rateLimiter: rl(), publicRateLimiter: rl(), officeRateLimiter: rl(), loginRateLimiter: rl(), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store: failing, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const base = `http://127.0.0.1:${await listen(server)}`;

  // capture every log line written while a request is handled
  async function captured(fn) {
    const lines = [];
    const o = { log: console.log, error: console.error };
    console.log = (...a) => lines.push(a.join(" "));
    console.error = (...a) => lines.push(a.join(" "));
    try { return { result: await fn(), lines }; } finally { console.log = o.log; console.error = o.error; }
  }
  const ts = () => String(Math.floor(Date.now() / 1000));
  const meta = { display_phone_number: "2349164738454", phone_number_id: PHONE_ID };
  const entry = (waba, value) => ({ id: waba, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: meta, ...value } }] });
  const batch = { object: "whatsapp_business_account", entry: [
    entry(FOREIGN_WABA, { contacts: [], messages: [{ from: OK_PHONE, id: "wamid.foreign.1", timestamp: ts(), type: "text", text: { body: "Hello there" } }] }),
    entry(WABA, { contacts: [], messages: [{ from: FAILING_PHONE, id: "wamid.fail.1", timestamp: ts(), type: "text", text: { body: "Hello there" } }] }),
    entry(WABA, { statuses: [{ id: "wamid.status.1", status: "delivered", timestamp: ts(), recipient_id: OK_PHONE }] }),
    entry(WABA, { contacts: [], messages: [{ from: OK_PHONE, id: "wamid.ok.1", timestamp: ts(), type: "text", text: { body: "Hello there" } }] }),
  ] };
  const post = (body, headers = {}) => { const bytes = Buffer.from(JSON.stringify(body)); return fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(bytes), ...headers }, body: bytes }); };

  try {
    const { result, lines } = await captured(async () => { const r = await post(batch); return { status: r.status, body: await r.json() }; });
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const failed = parsed.filter((p) => p.event === "whatsapp_webhook.event_failed");
    const guard = parsed.find((p) => p.event === "whatsapp_webhook.asset_guard");
    const summary = parsed.find((p) => p.event === "whatsapp_webhook.processing_failed");
    ok(result.status === 200 && JSON.stringify(result.body.results.map((r) => `${r.kind}${r.error ? ":error" : ""}`)) === JSON.stringify(["message:error", "status", "message"]), "mixed batch: foreign entry dropped; the failing message does not stop the status and the next valid message");
    ok(failed.length === 1 && JSON.stringify(Object.keys(failed[0]).sort()) === JSON.stringify(["error_code", "event", "http_status", "kind", "level", "request_id", "ts"]) && failed[0].kind === "message" && failed[0].http_status === 409 && failed[0].error_code === "23505" && failed[0].level === "error", "event_failed: exactly correlation id, kind, HTTP status and allowlisted code (plus timestamp, level, event name)");
    ok(!SENSITIVE.some((s) => JSON.stringify(failed[0]).includes(s)), "event_failed: no payload, phone number, message id, business ids, URL, token or exception text");
    ok(guard && JSON.stringify(Object.keys(guard).sort()) === JSON.stringify(["accepted", "event", "foreign_phone", "foreign_waba", "level", "missing_phone", "missing_waba", "ts"]) && guard.accepted === 3 && guard.foreign_waba === 1 && !SENSITIVE.some((s) => JSON.stringify(guard).includes(s)), "asset_guard: still counts-only (3 accepted, 1 foreign business account)");
    ok(summary && summary.failed === 1 && JSON.stringify(Object.keys(summary).sort()) === JSON.stringify(["event", "failed", "level", "request_id", "ts"]), "processing_failed summary: counts and correlation id only");
    ok(!lines.some((l) => /secret-token-value|supabase\.co|lookup failed/.test(l)), "no log line anywhere in the request carries the exception text, URL or credential");
    ok(sent.length === 0, "autonomous replies stay OFF: nothing sent");

    const injected = await captured(async () => (await post({ object: "whatsapp_business_account", entry: [entry(WABA, { contacts: [], messages: [{ from: FAILING_PHONE, id: "wamid.fail.2", timestamp: ts(), type: "text", text: { body: "x" } }] })] }, { "x-request-id": `{"forged":true}<script>${"a".repeat(80)}` })).status);
    const injectedLine = injected.lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((p) => p && p.event === "whatsapp_webhook.event_failed");
    ok(injected.result === 200 && injectedLine && injectedLine.request_id === "invalid", "an unsafe x-request-id is never written into the failure log");

    const bytes = Buffer.from(JSON.stringify(batch));
    const unsigned = await fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: bytes });
    const forged = await fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${"0".repeat(64)}` }, body: bytes });
    ok(unsigned.status === 401 && forged.status === 403, "signature enforcement unchanged (unsigned 401, forged 403)");
  } finally {
    await close(server); await close(backend);
  }
  console.log(JSON.stringify({ suite: "whatsapp-webhook-failure-log", checks, failed: 0 }));
}

main().catch((error) => { console.error(error); process.exit(1); });
