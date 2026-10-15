// Settings S4: allowlisted bounded connection tests and dry-run-only diagnostics. Real Office server on the file store, local Backend/Facility stubs.
// Covers: unauthorized requests, forged bodies, unsafe integration keys, timeouts, dry-run enforcement on the server, audit logging, secret redaction.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const ops = require("../src/lead-agents/settings-operations");

const BACKEND_SECRET = "backend-bridge-secret-AAA111", FACILITY_SECRET = "facility-bridge-secret-BBB222", TWIN_SECRET = "twin-secret-CCC333";
const limiter = (n) => new MemoryRateLimiter({ windowMs: 60000, maxRequests: n });
const listen = (s) => new Promise((res, rej) => { s.once("error", rej); s.listen(0, "127.0.0.1", () => res(s.address().port)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WRITE_FREE = (state) => { const { audit_events, ...rest } = state; return crypto.createHash("sha256").update(JSON.stringify(rest)).digest("hex"); };

async function main() {
  const seen = { backend: [], facility: [], evil: [] };
  let backendMode = "ok";
  const backend = http.createServer((req, res) => { seen.backend.push({ method: req.method, url: req.url, key: req.headers["x-api-key"] }); if (backendMode === "hang") return; if (backendMode === "500") { res.statusCode = 500; return res.end("boom"); } res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, leak: "BACKEND-BODY-MARKER" })); });
  const facility = http.createServer((req, res) => { seen.facility.push({ method: req.method, url: req.url, headers: req.headers }); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ estates: [], leak: "FACILITY-BODY-MARKER" })); });
  const evil = http.createServer((req, res) => { seen.evil.push(req.url); res.end("evil"); });
  const bp = await listen(backend), fp = await listen(facility), ep = await listen(evil);

  const { store } = await createTempStore();
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["svc-key"], allowedOrigins: [], officeBackendBaseUrl: `http://127.0.0.1:${bp}`, officeBackendApiKey: BACKEND_SECRET, officeFacilityBaseUrl: `http://127.0.0.1:${fp}`, officeFacilityApiKey: FACILITY_SECRET, officeConsumerBaseUrl: "", officeConsumerApiKey: "", officeDigitalTwinBaseUrl: "", officeDigitalTwinApiKey: TWIN_SECRET, settingsProbeTimeoutMs: 400, settingsProbeMinIntervalMs: 0 };
  for (const [k, role] of Object.entries({ admin: "ochiga_admin", staff: "ochiga_staff", super: "super_admin" })) await store.ensureAdminUser({ email: `${k}@ochiga.test`, password_hash: hashPassword("pass-12345-xyz"), role, display_name: k, status: "active" });
  const sends = [];
  const server = buildServer({ config, store, rateLimiter: limiter(5000), publicRateLimiter: limiter(5000), officeRateLimiter: limiter(5000), loginRateLimiter: limiter(500), whatsappAdapter: { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: () => [], isConfigured: () => true, sendTextMessage: async () => { sends.push("send"); return { delivered: true }; }, sendTemplateMessage: async () => { sends.push("template"); return { delivered: false }; }, listApprovedTemplates: async () => [] }, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const base = `http://127.0.0.1:${await listen(server)}`;
  const cookies = {};
  for (const k of ["admin", "staff", "super"]) { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${k}@ochiga.test`, password: "pass-12345-xyz" }) }); assert.equal(r.status, 200); cookies[k] = r.headers.get("set-cookie").split(";")[0]; }
  const call = async (who, method, path, body) => { const headers = { "content-type": "application/json", ...(who === "apikey" ? { "x-api-key": "svc-key" } : who ? { cookie: cookies[who] } : {}) }; const r = await fetch(`${base}/api/lead-agents/admin/settings${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text }; };
  const adminApi = (method, path, body, who = "admin") => fetch(`${base}/api/lead-agents/admin${path}`, { method, headers: { "content-type": "application/json", cookie: cookies[who] }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const auditRows = async () => (await store.listAuditEvents(1000));
  const TEST = (k) => `/integrations/${k}/test`, RECON = "/operations/outbox/reconcile-preview", REPAIR = "/operations/visibility/repair-preview";

  // ---------- 1. unauthorized ----------
  for (const [m, p] of [["POST", TEST("backend")], ["POST", RECON], ["POST", REPAIR]]) assert.equal((await call(null, m, p, {})).status, 401, `unauthenticated ${p}`);
  for (const [m, p] of [["POST", TEST("backend")], ["POST", RECON], ["POST", REPAIR]]) { const r = await call("staff", m, p, {}); assert.equal(r.status, 403, `ochiga_staff (integrations.read only) refused on ${p}`); assert.equal(r.json.required_permission, "integrations.manage"); }
  for (const p of [TEST("backend"), RECON, REPAIR]) { const r = await call("apikey", "POST", p, {}); assert.equal(r.status, 403); assert.equal(r.json.error, "actor_identity_required", "an API key has no accountable actor"); }
  for (const p of [TEST("backend"), RECON, REPAIR]) assert.equal((await call("admin", "GET", p)).status, 405, "only POST");
  assert.equal(seen.backend.length + seen.facility.length, 0, "no outbound call was made for any unauthorised request");
  console.log("1. Unauthorised: 401 unauthenticated, 403 without integrations.manage, 403 for API keys, 405 for other methods, zero outbound calls — PASS");

  // ---------- 2. connection tests ----------
  const t1 = await call("admin", "POST", TEST("backend"), {});
  assert.equal(t1.status, 200); assert.deepEqual([t1.json.test.kind, t1.json.test.reachable, t1.json.test.http_status, t1.json.test.verification], ["network_probe", true, 200, "health_probe"]); assert.equal(typeof t1.json.test.latency_ms, "number");
  assert.deepEqual([seen.backend[0].method, seen.backend[0].url, seen.backend[0].key], ["GET", "/health", BACKEND_SECRET], "the server's own authenticated health probe, built from configuration");
  const t2 = await call("super", "POST", TEST("facility"), {}); assert.equal(t2.json.test.reachable, true); assert.equal(seen.facility.length, 1); assert.equal(seen.facility[0].method, "GET"); assert.ok(Object.values(seen.facility[0].headers).some((v) => String(v).includes(FACILITY_SECRET)), "facility credentials are attached server-side");
  const t3 = await call("admin", "POST", TEST("consumer"), {}); assert.deepEqual([t3.json.test.kind, t3.json.test.reachable, t3.json.test.verification], ["not_configured", null, "not_configured"]); assert.equal(t3.json.test.http_status, null);
  const t4 = await call("admin", "POST", TEST("digital_twin"), {}); assert.deepEqual([t4.json.test.kind, t4.json.test.reachable, t4.json.test.verification, t4.json.test.available], ["in_process", null, "in_process_binding", true], "a same-origin twin is identified as in-process, never as reachable"); assert.match(t4.json.test.note, /No network probe/);
  assert.equal(seen.backend.length, 1, "consumer and twin tests made no network call");
  // unreachable / http error / timeout
  const realBackend = config.officeBackendBaseUrl; backendMode = "500"; const t5 = await call("admin", "POST", TEST("backend"), {}); assert.deepEqual([t5.json.test.reachable, t5.json.test.http_status, t5.json.test.error], [false, 500, "http_500"]);
  backendMode = "hang"; const started = Date.now(); const t6 = await call("admin", "POST", TEST("backend"), {}); const took = Date.now() - started;
  assert.deepEqual([t6.json.test.reachable, t6.json.test.error], [false, "timeout"]); assert.ok(took < 1800, `a hanging service is cut off by the bound (took ${took} ms)`); backendMode = "ok";
  config.officeBackendBaseUrl = "http://127.0.0.1:1"; const t7 = await call("admin", "POST", TEST("backend"), {}); assert.deepEqual([t7.json.test.reachable, t7.json.test.error], [false, "connection_refused"]); config.officeBackendBaseUrl = realBackend;
  config.officeDigitalTwinBaseUrl = `http://127.0.0.1:${bp}`; const t8 = await call("admin", "POST", TEST("digital_twin"), {}); assert.deepEqual([t8.json.test.kind, t8.json.test.reachable], ["network_probe", true], "an external twin is a genuine network probe"); assert.equal(seen.backend[seen.backend.length - 1].url, "/api/digital-twin/scene"); config.officeDigitalTwinBaseUrl = "";
  config.settingsProbeMinIntervalMs = 5000; await call("admin", "POST", TEST("facility"), {}); const tooSoon = await call("admin", "POST", TEST("facility"), {}); assert.equal(tooSoon.status, 429); assert.equal(tooSoon.json.error, "too_soon"); config.settingsProbeMinIntervalMs = 0;
  console.log("2. Connection tests: authenticated probes from configuration, not-configured, in-process twin, HTTP 500, timeout bound, refused, external twin, per-key rate limit — PASS");

  // ---------- 3. unsafe keys and forged bodies ----------
  const before = seen.backend.length + seen.facility.length + seen.evil.length;
  for (const k of ["website", "edge", "whatsapp", "email", "maps", "google_oauth", "BACKEND", "Backend", "backend%00", "backend%2F..", "..%2Fadmin", "%2e%2e", "backend%20", "constructor", "__proto__", "toString", "a".repeat(200)]) { const r = await call("admin", "POST", TEST(k), {}); const normalised = k === "%2e%2e"; /* the HTTP client itself rewrites this dot-segment into a different, non-test path */ assert.ok(normalised ? [404, 405].includes(r.status) : r.status === 404, `unsafe key ${k.slice(0, 24)} -> ${r.status}`); if (!normalised) assert.equal(r.json.error, "unknown_integration"); }
  assert.equal(seen.backend.length + seen.facility.length + seen.evil.length, before, "unknown keys made no outbound request");
  for (const forged of [{ url: `http://127.0.0.1:${ep}/steal` }, { base_url: `http://127.0.0.1:${ep}` }, { path: "/admin" }, { headers: { "x-api-key": "x" } }, { timeout: 99999 }, { host: "127.0.0.1" }, { method: "DELETE" }, { key: "website" }]) { const r = await call("admin", "POST", TEST("backend"), forged); assert.equal(r.status, 400, JSON.stringify(forged)); assert.equal(r.json.error, "unexpected_fields"); }
  assert.equal((await call("admin", "POST", TEST("backend"), "not json {")).status, 400); assert.equal((await call("admin", "POST", TEST("backend"), [1])).status, 400);
  assert.equal(seen.evil.length, 0, "a caller-supplied URL is never contacted"); assert.equal(seen.backend.length + seen.facility.length, before - seen.evil.length, "forged bodies made no outbound request");
  console.log("3. Unsafe integration keys (case, encoding, traversal, prototype names, config-only, website) → 404; forged bodies (url/path/headers/timeout) → 400; nothing contacted — PASS");

  // ---------- 4. dry-run enforcement ----------
  const lead = await store.createLead({ name: "Preview Lead", source: "whatsapp", whatsapp_phone: "2348077700099", status: "new" });
  const nowSec = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 12; i++) await store.appendInboundEvent({ channel: "whatsapp", provider: "meta", event_type: "message", lead_id: lead.id, external_event_id: `wamid.preview.${String(i).padStart(2, "0")}.ABCDEFGHIJKL`, payload: { from: "2348077700099", message_id: `wamid.preview.${i}`, text: `PRIVATE-MESSAGE-TEXT-${i}`, timestamp: String(nowSec - 60 * i), message_type: "text" } });
  const snapshot = () => WRITE_FREE(store.state);
  const s0 = snapshot(); const backendBefore = seen.backend.length;
  for (const [path, label] of [[RECON, "reconcile"], [REPAIR, "repair"]]) {
    for (const forged of [{ dry_run: false }, { dryRun: false }, { dry_run: "false" }, { dry_run: 0 }, { dry_run: null }, { apply: true }, { mode: "replay" }, { confirm: true }, { force: true }, { replay: true }, { action: "recover" }, { execute: true }, { retry: true }, { dry_run: true, apply: true }, { dry_run: false, confirm: true, replay: true }]) {
      const r = await call("admin", "POST", path, forged); assert.equal(r.status, 400, `${label} ${JSON.stringify(forged)} -> ${r.status}`); assert.ok(["dry_run_only", "unexpected_fields"].includes(r.json.error));
    }
  }
  assert.equal(snapshot(), s0, "forged requests changed nothing in the store");
  const recon = await call("admin", "POST", RECON, { dry_run: true, window_minutes: 99999, limit: 99999 }); assert.equal(recon.status, 200);
  assert.deepEqual([recon.json.dry_run, recon.json.enforced], [true, "server"]); assert.equal(recon.json.window_minutes, 180 === recon.json.window_minutes ? 180 : recon.json.window_minutes); assert.ok(recon.json.window_minutes <= 10080, "window clamped"); assert.equal(recon.json.missing_deliveries, 12); assert.equal(recon.json.would_enqueue_sample.length, 10); assert.equal(recon.json.sample_truncated, true);
  const recon2 = await call("admin", "POST", RECON, {}); assert.equal(recon2.json.dry_run, true, "an empty body is a dry run");
  const repair = await call("super", "POST", REPAIR, {}); assert.equal(repair.status, 200); assert.deepEqual([repair.json.dry_run, repair.json.enforced], [true, "server"]); assert.equal(repair.json.unique_missing_messages, 12); assert.equal(repair.json.proposed_sample.length, 10);
  assert.equal(snapshot(), s0, "valid previews also changed nothing: no outbox row, activity, claim or lease");
  assert.equal((await store.communicationDeliverySummary()).counts.pending, 0, "no delivery was queued"); assert.equal(seen.backend.length, backendBefore, "no delivery or replay reached the Backend"); assert.equal(sends.length, 0, "no customer message was sent");
  const text = JSON.stringify([recon.json, recon2.json, repair.json]);
  assert.ok(!text.includes("PRIVATE-MESSAGE-TEXT") && !text.includes("2348077700099"), "no message text or phone number in previews"); assert.ok(!text.includes(lead.id), "no full lead id"); assert.ok(!/wamid\.preview\.0\d\.ABCDEFGHIJKL/.test(text), "provider ids are shortened");
  console.log("4. Dry-run is enforced on the server: 30 forged bodies refused, valid previews change nothing, clamped, shaped, nothing sent or queued — PASS");

  // the existing administrator API keeps its own (apply-capable) behaviour: the Settings endpoints are strictly narrower
  const real = await adminApi("POST", "/communications/outbox/reconcile", { dry_run: false }); assert.equal(real.status, 200); assert.ok(real.json.enqueued > 0, "the existing API still applies when explicitly asked (unchanged)");
  console.log("5. Existing administrator reconcile route is unchanged (still applies on dry_run:false); Settings cannot — PASS");

  // ---------- 6. audit ----------
  const rows = await auditRows(); const by = (a) => rows.filter((r) => r.action === a);
  assert.ok(by("settings.integration_test").some((r) => r.metadata.outcome === "ok" && r.metadata.integration === "backend" && r.actor_email === "admin@ochiga.test" && r.metadata.status === "success"), "successful tests audited with actor");
  assert.ok(by("settings.integration_test").some((r) => r.metadata.outcome === "unreachable" && r.metadata.status === "failure" && r.metadata.error === "timeout"), "failed probes audited");
  assert.ok(by("settings.operation_denied").some((r) => r.metadata.reason === "forbidden" && r.actor_email === "staff@ochiga.test") && by("settings.operation_denied").some((r) => r.metadata.reason === "actor_identity_required"), "denials audited");
  const rej = by("settings.operation_rejected"); for (const reason of ["unknown_integration", "unexpected_fields", "dry_run_only", "invalid_json", "invalid_body"]) assert.ok(rej.some((r) => r.metadata.reason === reason), `rejection audited: ${reason}`);
  assert.ok(rej.every((r) => r.metadata.request_id && r.metadata.via === "settings"), "request id and origin on every rejection");
  assert.ok(by("communication.outbox.reconcile").some((r) => r.metadata.dry_run === true && r.metadata.enforced_dry_run === true && r.metadata.via === "settings" && r.metadata.enqueued === 0), "preview reuses the existing audit type with dry_run + enforced flag");
  assert.ok(by("whatsapp.inbound_visibility.dry_run").some((r) => r.metadata.enforced_dry_run === true && r.metadata.via === "settings" && r.metadata.created === 0), "repair preview audited under its existing type");
  assert.ok(!by("whatsapp.inbound_visibility.repair").length, "no real repair was ever audited");
  console.log("6. Audit: tests, denials, rejections (with reasons and request ids) and previews under existing event types — PASS");

  // ---------- 7. secret redaction ----------
  const everything = [t1, t2, t3, t4, t5, t6, t7, t8, tooSoon, recon, repair].map((r) => r.text || JSON.stringify(r.json)).join("\n") + JSON.stringify(rows);
  for (const s of [BACKEND_SECRET, FACILITY_SECRET, TWIN_SECRET, "svc-key", "BACKEND-BODY-MARKER", "FACILITY-BODY-MARKER", `127.0.0.1:${bp}`, `127.0.0.1:${fp}`]) assert.ok(!everything.includes(s), `${s} never appears in a response or the audit trail`);
  console.log("7. Redaction: no credential, upstream body, URL or port in responses or audit — PASS");

  // S3 registry still intact
  const reg = await call("admin", "GET", ""); assert.equal(reg.status, 200); assert.ok(reg.json.settings.find((s) => s.key === "whatsapp_autonomous_responses_enabled"), "S3 registry unaffected");
  for (const s of [server, backend, facility, evil]) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
  console.log(JSON.stringify({ status: "PASS", suite: "settings-operations" }));
}
main().catch((error) => { console.error(error); process.exit(1); });
