// Shadow envelope observation on the production webhook (based on f823eaa). Real HMAC-signed requests, real WhatsAppCloudAdapter, real HTTP server, file
// stores, stubbed Backend, spy on outbound sends, capture of every log line. Proves:
//   * off by default; on only inside a bounded window (expired / too far ahead / malformed = off); per-process line cap with an explicit truncation line;
//   * counts per actual event type (message / status) of business-account and phone-number id match | mismatch | missing | invalid_type;
//   * no id, phone number, message id, text, display number, header or error text in any observation line;
//   * only SIGNED callbacks are observed (a report-mode unsigned request is not);
//   * webhook processing is identical with observation on and off (results, stored events, Backend forwards, replies). Fixture ids and secrets only.
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
const obs = require("../src/lead-agents/whatsapp-envelope-observation");

let checks = 0;
const ok = (cond, name) => { assert.ok(cond, name); checks += 1; console.log("PASS " + name); };
const SECRET = "fixture-app-secret-for-tests-only-0123456789";
const WABA = "100000000000001", PHONE = "100000000000002", FOREIGN_WABA = "100000000000099", FOREIGN_PHONE = "100000000000098";
const SENDERS = ["2348011112221", "2348011112222", "2348011112223"];
const SENSITIVE = [WABA, PHONE, FOREIGN_WABA, FOREIGN_PHONE, ...SENDERS, "wamid.", "Hello observer", "2349164738454", "x-hub", "sha256="];
const sign = (bytes) => `sha256=${crypto.createHmac("sha256", SECRET).update(bytes).digest("hex")}`;
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
const future = (ms = 3600_000) => new Date(Date.now() + ms).toISOString();

function unitChecks() {
  ok(obs.classify(undefined, "1") === "missing" && obs.classify("", "1") === "missing" && obs.classify(null, "1") === "missing" && obs.classify(1, "1") === "invalid_type" && obs.classify("1", "1") === "match" && obs.classify("2", "1") === "mismatch", "classify: missing / invalid_type / match / mismatch");
  ok(!obs.windowOpen(createConfig(), Date.now()) && !obs.windowOpen({ whatsappEnvelopeObservationUntil: "garbage" }, Date.now()) && !obs.windowOpen({ whatsappEnvelopeObservationUntil: new Date(Date.now() - 1000).toISOString() }, Date.now()) && !obs.windowOpen({ whatsappEnvelopeObservationUntil: future(8 * 86400_000) }, Date.now()) && obs.windowOpen({ whatsappEnvelopeObservationUntil: future() }, Date.now()), "window: off by default, off when malformed, expired or more than 7 days ahead; on inside a bounded window");
  const lines = [];
  const log = (level, event, fields) => lines.push({ level, event, ...fields });
  const cfg = { whatsappEnvelopeObservationUntil: future(), whatsappBusinessAccountId: WABA, whatsappPhoneNumberId: PHONE };
  const one = { object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE }, messages: [{ id: "wamid.u" }] } }] }] };
  obs._resetForTests();
  ok(obs.observe(one, { ...cfg, whatsappEnvelopeObservationUntil: "" }, { log }).reason === "window_closed" && obs.observe(one, { ...cfg, whatsappBusinessAccountId: "" }, { log }).reason === "expected_ids_unconfigured" && lines.length === 0, "disabled or unconfigured: nothing logged");
  // expiry while running: open now, closed a moment later
  const until = Date.now() + 50;
  ok(obs.observe(one, { ...cfg, whatsappEnvelopeObservationUntil: new Date(until).toISOString() }, { log, now: () => until - 10 }).observed && obs.observe(one, { ...cfg, whatsappEnvelopeObservationUntil: new Date(until).toISOString() }, { log, now: () => until + 1 }).reason === "window_closed", "expiry: observation stops by itself when the window ends");
  // cap: the last allowed line carries sequence = cap; then exactly one explicit truncation line; then silence
  obs._resetForTests(); lines.length = 0;
  obs.state.lines = obs.LINE_CAP - 1;
  obs.observe(one, cfg, { log }); obs.observe(one, cfg, { log }); obs.observe(one, cfg, { log }); obs.observe(one, cfg, { log });
  ok(lines.length === 2 && lines[0].event === obs.EVENT && lines[0].sequence === obs.LINE_CAP && lines[1].event === obs.CAP_EVENT && lines[1].evidence_truncated === true && obs.state.skippedAfterCap === 3, "cap: last line numbered at the cap, then ONE explicit 'evidence truncated' line, then nothing");
  obs._resetForTests(); lines.length = 0;
  ok(obs.observe({ object: "whatsapp_business_account", entry: [] }, cfg, { log }).reason === "no_events" && obs.observe("not an object", cfg, { log }).observed === false && obs.observe({ entry: [{ id: WABA, changes: [null, { value: null }, { value: { messages: "x" } }] }] }, cfg, { log }).observed === false && lines.length === 0, "malformed or empty bodies: never throw, nothing logged");
}

async function main() {
  unitChecks();
  const forwards = { off: 0, on: 0 };
  let target = "off";
  const backend = http.createServer((req, res) => { if (req.url === "/office/communications/webhook-event") forwards[target]++; req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, goal_active: false, opted_out: false, opt_out_status: "not_opted_out" })); }); });
  const backendPort = await listen(backend);
  const ts = () => String(Math.floor(Date.now() / 1000));
  const meta = (phone) => (phone === undefined ? {} : { metadata: { display_phone_number: "2349164738454", phone_number_id: phone } });
  const batch = { object: "whatsapp_business_account", entry: [
    { id: WABA, changes: [{ field: "messages", value: { messaging_product: "whatsapp", ...meta(PHONE), contacts: [], messages: [{ from: SENDERS[0], id: "wamid.obs.1", timestamp: ts(), type: "text", text: { body: "Hello observer" } }], statuses: [{ id: "wamid.obs.s1", status: "delivered", timestamp: ts(), recipient_id: SENDERS[0] }] } }] },
    { id: FOREIGN_WABA, changes: [{ field: "messages", value: { messaging_product: "whatsapp", ...meta(PHONE), contacts: [], messages: [{ from: SENDERS[1], id: "wamid.obs.2", timestamp: ts(), type: "text", text: { body: "Hello observer" } }] } }] },
    { id: Number(WABA), changes: [{ field: "messages", value: { messaging_product: "whatsapp", contacts: [], messages: [{ from: SENDERS[2], id: "wamid.obs.3", timestamp: ts(), type: "text", text: { body: "Hello observer" } }] } }] },
    { id: WABA, changes: [{ field: "messages", value: { messaging_product: "whatsapp", ...meta(FOREIGN_PHONE), statuses: [{ id: "wamid.obs.s2", status: "read", timestamp: ts(), recipient_id: SENDERS[1] }] } }] },
  ] };

  async function run(observing, { signatureMode = "enforce", badSignature = false } = {}) {
    obs._resetForTests();
    const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["k"], allowedOrigins: [], officeBackendBaseUrl: `http://127.0.0.1:${backendPort}`, officeBackendApiKey: "b", metaAppSecret: SECRET, whatsappVerifyToken: "v", whatsappAccessToken: "fixture-access-token", whatsappPhoneNumberId: PHONE, whatsappBusinessAccountId: WABA, whatsappWebhookSignatureMode: signatureMode, whatsappEnvelopeObservationUntil: observing ? future() : "" };
    const { store } = await createTempStore();
    const adapter = Object.create(new WhatsAppCloudAdapter(config));
    const sent = [];
    adapter.sendTextMessage = async (m) => { sent.push(m); return { delivered: true }; };
    const rl = () => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 9999 });
    const server = buildServer({ config, store, rateLimiter: rl(), publicRateLimiter: rl(), officeRateLimiter: rl(), loginRateLimiter: rl(), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
    const base = `http://127.0.0.1:${await listen(server)}`;
    const lines = [];
    const o = { log: console.log, error: console.error };
    console.log = (...a) => lines.push(a.join(" ")); console.error = (...a) => lines.push(a.join(" "));
    let status, results;
    try {
      const bytes = Buffer.from(JSON.stringify(batch));
      const r = await fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": badSignature ? `sha256=${"0".repeat(64)}` : sign(bytes) }, body: bytes });
      status = r.status; results = (await r.json()).results;
    } finally { console.log = o.log; console.error = o.error; await close(server); }
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return { status, results, sent, lines, parsed, inbound: store.state.inbound_events.length, leads: (await store.listLeads()).length };
  }

  try {
    target = "off"; const off = await run(false);
    target = "on"; const on = await run(true);
    const shape = (rs) => JSON.stringify((rs || []).map((r) => ({ ...r, lead_id: r && r.lead_id ? "<lead>" : undefined })));
    ok(off.status === 200 && on.status === 200 && shape(off.results) === shape(on.results) && off.inbound > 0 && off.inbound === on.inbound && off.leads === on.leads && forwards.off > 0 && forwards.off === forwards.on && off.sent.length === on.sent.length, "processing identical with observation on and off: results, stored events, leads, Backend forwards, replies");
    ok(off.sent.length === 0 && on.sent.length === 0, "autonomous replies stay OFF: nothing sent");
    ok(!off.parsed.some((p) => p.event === obs.EVENT), "observation off by default: no observation line");
    const line = on.parsed.filter((p) => p.event === obs.EVENT);
    ok(line.length === 1 && line[0].sequence === 1 && line[0].cap === obs.LINE_CAP, "one observation line per signed callback, numbered");
    const m = line[0].message, s = line[0].status;
    ok(m.events === 3 && m.waba_match === 1 && m.waba_mismatch === 1 && m.waba_invalid_type === 1 && m.waba_missing === 0 && m.phone_match === 2 && m.phone_missing === 1 && m.phone_mismatch === 0, "message callbacks: business-account match/mismatch/invalid type and phone match/missing counted per event");
    ok(s.events === 2 && s.waba_match === 2 && s.phone_match === 1 && s.phone_mismatch === 1, "status callbacks counted separately: business account matched, one phone-number mismatch");
    ok(!SENSITIVE.some((v) => JSON.stringify(line[0]).includes(v)) && JSON.stringify(Object.keys(line[0]).sort()) === JSON.stringify(["cap", "event", "level", "message", "sequence", "status", "ts"]), "privacy: no ids, phone numbers, message ids, text, display numbers or headers in the observation line");
    const report = await run(true, { signatureMode: "report", badSignature: true });
    ok(report.status === 200 && !report.parsed.some((p) => p.event === obs.EVENT), "only SIGNED callbacks are observed (a report-mode unsigned callback is processed as before but not observed)");
    const enforced = await run(true, { badSignature: true });
    ok(enforced.status === 403 && !enforced.parsed.some((p) => p.event === obs.EVENT), "enforce mode: a forged callback is refused before observation");
  } finally {
    await close(backend);
  }
  console.log(JSON.stringify({ suite: "whatsapp-envelope-observation", checks, failed: 0 }));
}

main().catch((error) => { console.error(error); process.exit(1); });
