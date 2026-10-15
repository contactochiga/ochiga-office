// Settings S5: read-only AI provider status. Covers permission boundaries, unknown states, credential redaction, approval/budget accuracy, unavailable Backend,
// activation never available, zero provider API calls, no cross-provider transfer, no secrets in responses or logs.
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { buildProviderStatusResponse, normalizeProvider, PROVIDERS, activationReadiness } = require("../src/lead-agents/intelligence-providers");

const OFFICE_BRIDGE_KEY = "office-bridge-secret-AAA111", OPENAI_KEY = "sk-office-assistant-SENTINEL-BBB222";
const S1 = "sk-live-SENTINELBACKEND0001", S2 = "AIzaSySENTINELGEMINI000000001", S3 = "Bearer SENTINELBEARERTOKEN123", S4 = "vault://secret/openai-project-key", S5 = "QWxhZGRpbjpvcGVuIHNlc2FtZVF3ZXJ0eTEyMzQ1Njc4OTA=";
const SENTINELS = [OFFICE_BRIDGE_KEY, OPENAI_KEY, S1, S2, S3, S4, S5, "SENTINEL-AUTH-HEADER"];
const limiter = (n) => new MemoryRateLimiter({ windowMs: 60000, maxRequests: n });
const listen = (s) => new Promise((res, rej) => { s.once("error", rej); s.listen(0, "127.0.0.1", () => res(s.address().port)); });

async function main() {
  // capture every log line and every outbound connection attempt
  const logs = []; const origWrite = process.stdout.write.bind(process.stdout); process.stdout.write = (chunk, ...rest) => { logs.push(String(chunk)); return origWrite(chunk, ...rest); };
  const outbound = []; for (const mod of [http, https]) { const orig = mod.request.bind(mod); mod.request = (...args) => { const o = args[0]; const host = typeof o === "string" ? new URL(o).hostname : (o && (o.hostname || o.host)) || ""; outbound.push(String(host)); return orig(...args); }; }
  let providersCalls = 0; let mode = "absent"; const backendHits = [];
  const TRUTHFUL = () => ({
    ok: true, schema_version: 1, generated_at: "2026-10-15T10:00:00Z",
    gateway: { status: "offline_design_only", live_transport_implemented: false, paid_inference_enabled: false, cross_provider_fallback: "disabled", approved_cross_provider_transfers: [], api_key: S1 },
    providers: [
      { id: "openai", adapter: { registered: true, version: "iq11f-1", protocol: "responses", mode: "offline_mock_only" }, credentials: { status: "unknown", verified_at: null, reference: S4, reference_recorded: false, api_key: S1 }, model: { approved_model: null, candidates: ["gpt-5.4-mini-2026-03-17", "gpt-5.4-2026-03-05"], status: "candidate" }, qualification: { status: "preparation", scope: "shadow, synthetic only", evidence_ref: "intelligence-quality-v1-iq11f-openai-shadow-authorization" }, operating_mode: "offline_mock_only", budget: { currency: "USD", approved_maximum: 50, approval_ref: "ecc53e7", approved_at: "2026-10-14T07:28:31Z", verified_credits: null, verified_spend: null, enforcement: { status: "designed" }, remaining_authorized: 9999 }, data_processing: { status: "not_reviewed" }, activation: { contract_available: false, activated: false }, last_verified_at: "2026-10-14T06:25:52Z", limitations: ["No funded project verified", `leaked ${S1}`] },
      { id: "gemini", adapter: { registered: true, protocol: "generateContent-compatibility-profile", mode: "offline_mock_only" }, credentials: { status: "not_provisioned" }, model: { status: "none_selected", candidates: [] }, qualification: { status: "not_started" }, operating_mode: "offline_mock_only", budget: { currency: "USD", approved_maximum: null, enforcement: { status: "none" } }, data_processing: { status: "not_reviewed" }, activation: { contract_available: false }, limitations: [S2, "Gemini API profile unqualified"] },
      { id: "anthropic", adapter: { registered: true, protocol: "messages", mode: "offline_mock_only" }, credentials: { status: "approved-ish" }, model: { status: "none_selected" }, qualification: { status: "not_started", evidence_ref: S5 }, operating_mode: "wide-open", budget: { currency: "USD" }, data_processing: { status: "not_reviewed" }, headers: { authorization: "SENTINEL-AUTH-HEADER" }, limitations: [S3] },
      { id: "grok", adapter: { registered: true }, qualification: { status: "qualified" }, operating_mode: "live" },
    ],
    provenance: [{ group: "budget", source_record: "iq11f-gateway-approvals + openai-shadow-authorization", recorded_at: "2026-10-14T07:28:31Z", conflicts: ["gateway approvals record authorized spend 0; later OpenAI authorization records a 50 USD maximum"] }],
  });
  const backend = http.createServer((req, res) => {
    backendHits.push({ method: req.method, url: req.url, key: req.headers["x-office-api-key"] });
    if (!req.url.startsWith("/office/intelligence/providers") && !req.url.startsWith("/custom/providers")) { res.statusCode = 404; return res.end("{}"); }
    providersCalls++; res.setHeader("content-type", "application/json");
    if (mode === "absent") { res.statusCode = 404; return res.end(JSON.stringify({ error: "not_found" })); }
    if (mode === "error") { res.statusCode = 500; return res.end(JSON.stringify({ error: "boom" })); }
    if (mode === "truthful") return res.end(JSON.stringify(TRUTHFUL()));
    if (mode === "spend") { const b = TRUTHFUL(); b.providers[0].budget = { currency: "USD", approved_maximum: 50, verified_credits: 200, verified_spend: 12.345, enforcement: { status: "verified" } }; return res.end(JSON.stringify(b)); }
    if (mode === "qualified") { const b = TRUTHFUL(); b.providers[0] = { ...b.providers[0], credentials: { status: "verified", verified_at: "2026-10-15T00:00:00Z" }, model: { approved_model: "gpt-5.4-mini-2026-03-17", status: "approved" }, qualification: { status: "qualified" }, data_processing: { status: "approved" }, operating_mode: "live", activation: { contract_available: true, activated: false }, budget: { currency: "USD", approved_maximum: 50, verified_spend: 60, enforcement: { status: "verified" } } }; return res.end(JSON.stringify(b)); }
    res.end(JSON.stringify({ ok: true }));
  });
  const bp = await listen(backend);
  const { store } = await createTempStore();
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["svc-key"], allowedOrigins: [], officeBackendBaseUrl: `http://127.0.0.1:${bp}`, officeBackendApiKey: OFFICE_BRIDGE_KEY, openaiApiKey: OPENAI_KEY, openaiModel: "gpt-office-assistant" };
  for (const [k, role] of Object.entries({ admin: "ochiga_admin", staff: "ochiga_staff", estate: "estate_admin" })) await store.ensureAdminUser({ email: `${k}@ochiga.test`, password_hash: hashPassword("pass-12345-xyz"), role, display_name: k, status: "active" });
  const server = buildServer({ config, store, rateLimiter: limiter(5000), publicRateLimiter: limiter(5000), officeRateLimiter: limiter(5000), loginRateLimiter: limiter(500), whatsappAdapter: { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: () => [], isConfigured: () => true, sendTextMessage: async () => ({ delivered: false }), sendTemplateMessage: async () => ({ delivered: false }), listApprovedTemplates: async () => [] }, openaiClient: new Proxy({}, { get() { throw new Error("the OpenAI client must never be touched by provider status"); } }), toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const base = `http://127.0.0.1:${await listen(server)}`;
  const cookies = {};
  for (const k of ["admin", "staff", "estate"]) { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${k}@ochiga.test`, password: "pass-12345-xyz" }) }); assert.equal(r.status, 200); cookies[k] = r.headers.get("set-cookie").split(";")[0]; }
  const get = async (who, path = "/api/lead-agents/admin/intelligence/providers", method = "GET") => { const headers = who === "apikey" ? { "x-api-key": "svc-key" } : who ? { cookie: cookies[who] } : {}; const r = await fetch(`${base}${path}`, { method, headers }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text }; };
  const prov = (r, id) => r.json.providers.find((p) => p.id === id);

  // ---- 1. permission boundaries ----
  assert.equal((await get(null)).status, 401, "unauthenticated refused");
  assert.equal((await get("staff")).status, 403, "ochiga_staff (no audit.read) refused"); assert.equal((await get("estate")).status, 403, "estate_admin refused");
  assert.equal((await get("admin", undefined, "POST")).status, 405, "read-only: POST refused"); assert.equal((await get("admin", undefined, "PUT")).status, 405); assert.equal((await get("admin", undefined, "DELETE")).status, 405);
  assert.equal((await get("admin")).status, 200); assert.equal((await get("apikey")).status, 200, "the shared service key reads like other intelligence routes");
  assert.equal(backendHits.filter((h) => /providers/.test(h.url)).length, 2, "refused requests never reached the Backend");
  console.log("1. Permissions: 401 unauthenticated, 403 without audit.read, 405 for any write method, no Backend call for refused requests — PASS");

  // ---- 2. Backend endpoint absent: everything Unknown ----
  mode = "absent"; const absent = await get("admin");
  assert.deepEqual([absent.json.available, absent.json.reason, absent.json.ok], [false, "endpoint_not_available", false]);
  assert.equal(absent.json.providers.length, 3, "the three providers are always listed"); assert.deepEqual(absent.json.providers.map((p) => p.id), PROVIDERS.map((p) => p.id));
  for (const p of absent.json.providers) {
    assert.equal(p.reported, false); assert.deepEqual([p.qualification.status, p.operating_mode, p.credentials.status, p.model.status, p.data_processing.status, p.adapter.mode, p.budget.enforcement], Array(7).fill("unknown"), `${p.id}: every state is unknown`);
    assert.deepEqual([p.budget.approved_maximum, p.budget.verified_credits, p.budget.verified_spend, p.budget.remaining_authorized, p.model.approved_model, p.last_verified_at], Array(6).fill(null), `${p.id}: no budget, model or timestamp is invented`);
    assert.ok(p.readiness.filter((r) => r.status === "unknown").length >= 4, `${p.id}: readiness is unknown, not met`); assert.ok(!p.readiness.some((r) => r.status === "met"));
  }
  assert.equal(absent.json.activation.available, false);
  assert.deepEqual([absent.json.office_local.openai.assistant_configured, absent.json.office_local.openai.assistant_model], [true, "gpt-office-assistant"], "the only locally verified fact: Office assistant OpenAI configuration (presence and model name)");
  assert.match(absent.json.office_local.openai.note, /not an Oyi Core interpretation qualification/); assert.equal(absent.json.office_local.gemini.assistant_configured, false); assert.equal(absent.json.office_local.anthropic.assistant_configured, false);
  assert.equal(prov(absent, "openai").qualification.status, "unknown", "an Office-configured provider is NOT presented as qualified");
  mode = "error"; const broken = await get("admin"); assert.equal(broken.status, 200); assert.equal(broken.json.available, false); assert.ok(["backend_rejected", "unavailable", "backend_error"].includes(broken.json.reason) || typeof broken.json.reason === "string"); assert.ok(broken.json.providers.every((p) => p.qualification.status === "unknown"));
  const savedBase = config.officeBackendBaseUrl; config.officeBackendBaseUrl = "http://127.0.0.1:1"; const down = await get("admin"); assert.equal(down.json.available, false); assert.equal(down.json.reason, "network_error"); config.officeBackendBaseUrl = ""; const unconf = await get("admin"); assert.equal(unconf.json.reason, "not_configured"); config.officeBackendBaseUrl = savedBase;
  console.log("2. Unavailable Backend (404, 500, refused, not configured): all three providers listed with every state Unknown, no invented budget/model/time, Office-configured is not qualified — PASS");

  // ---- 3. truthful Backend data: approval-state and budget-state accuracy ----
  mode = "truthful"; const t = await get("admin"); assert.equal(t.json.available, true);
  const oa = prov(t, "openai");
  assert.deepEqual([oa.adapter.registered, oa.adapter.protocol, oa.adapter.mode, oa.operating_mode], [true, "responses", "offline_mock_only", "offline_mock_only"]);
  assert.deepEqual([oa.credentials.status, oa.model.status, oa.model.approved_model, oa.qualification.status, oa.data_processing.status], ["unknown", "candidate", null, "preparation", "not_reviewed"], "OpenAI: candidate models are not an approved model; credentials unverified");
  assert.deepEqual(oa.model.candidates, ["gpt-5.4-mini-2026-03-17", "gpt-5.4-2026-03-05"]);
  assert.deepEqual([oa.budget.currency, oa.budget.approved_maximum, oa.budget.verified_credits, oa.budget.verified_spend, oa.budget.remaining_authorized, oa.budget.enforcement], ["USD", 50, null, null, null, "designed"], "the 50 USD ceiling is a ceiling only: credits and spend unverified, remaining unknown, Backend-supplied remaining (9999) ignored");
  const ge = prov(t, "gemini"), an = prov(t, "anthropic");
  assert.deepEqual([ge.budget.approved_maximum, ge.qualification.status, ge.model.status, ge.credentials.status], [null, "not_started", "none_selected", "not_provisioned"], "Gemini has no paid-call authorization recorded");
  assert.deepEqual([an.budget.approved_maximum, an.credentials.status, an.operating_mode, an.qualification.status], [null, "unknown", "unknown", "not_started"], "unrecognised enum values become unknown, never approved");
  assert.ok(!t.json.providers.some((p) => p.id === "grok"), "an unlisted provider (and its claimed qualification) is ignored: no cross-provider adoption");
  assert.deepEqual([t.json.gateway.status, t.json.gateway.paid_inference_enabled, t.json.gateway.live_transport_implemented, t.json.gateway.cross_provider_fallback, t.json.gateway.approved_cross_provider_transfers], ["offline_design_only", false, false, "disabled", []]);
  assert.ok(t.json.provenance[0].conflicts[0].includes("authorized spend 0"), "recorded conflicts between approval records are surfaced, not resolved");
  assert.ok(t.json.redaction_applied === 4, `secret-shaped values were dropped (${t.json.redaction_applied})`);
  mode = "spend"; const sp = prov(await get("admin"), "openai"); assert.deepEqual([sp.budget.approved_maximum, sp.budget.verified_credits, sp.budget.verified_spend, sp.budget.remaining_authorized, sp.budget.remaining_basis], [50, 200, 12.35, 37.65, "approved_maximum_minus_verified_spend"], "remaining = approved maximum − verified spend; credits never change it");
  mode = "qualified"; const q = await get("admin"); const qo = prov(q, "openai");
  assert.equal(qo.budget.remaining_authorized, 0, "overspend never yields a negative remaining figure");
  assert.deepEqual(qo.readiness.map((r) => [r.key, r.status]), [["activation_contract", "met"], ["qualified_model", "met"], ["data_processing", "met"], ["credentials", "met"], ["budget_enforcement", "met"], ["administrator_authority", "deferred"], ["audit_logging", "not_met"], ["explicit_confirmation", "not_met"]], "readiness follows the reported state; audit and confirmation remain unmet");
  assert.equal(q.json.activation.available, false, "even a fully qualified provider with an activation contract cannot be activated from Office");
  assert.ok(!JSON.stringify(q.json).includes('"activate"'), "no activation route or action is advertised");
  const bad = buildProviderStatusResponse({ ok: true, data: { providers: [{ id: "openai", budget: { approved_maximum: 50, verified_spend: 1 } }, { id: "gemini", budget: { currency: "USD", approved_maximum: -5, verified_spend: Number.NaN, verified_credits: "lots" } }] } }, {});
  assert.deepEqual([bad.providers[0].budget.approved_maximum, bad.providers[0].budget.verified_spend, bad.providers[0].budget.remaining_authorized], [null, null, null], "money without a currency is unknown");
  assert.deepEqual([bad.providers[1].budget.approved_maximum, bad.providers[1].budget.verified_spend, bad.providers[1].budget.verified_credits], [null, null, null], "negative, NaN and non-numeric amounts are unknown");
  console.log("3. Approval and budget accuracy: ceiling ≠ credits ≠ spend; remaining computed only from verified inputs; unknown enums stay unknown; unlisted providers ignored; conflicts surfaced — PASS");

  // ---- 4. no secrets, no provider calls, no cross-provider transfer ----
  mode = "truthful"; const all = [(await get("admin")).text, absent.text, t.text, q.text, JSON.stringify(await store.listAuditEvents(500)), logs.join("")].join("\n");
  for (const s of SENTINELS) assert.ok(!all.includes(s), `secret sentinel ${s.slice(0, 18)}… never appears in a response, the audit trail or the logs`);
  assert.ok(!/"api_key"|"authorization"|"credential_reference"|vault:\/\//i.test(t.text), "no credential field survives normalisation");
  assert.equal(oa.credentials.reference_recorded, false); assert.ok(!("reference" in oa.credentials), "a credential reference is reduced to a boolean");
  const providerHosts = /openai|anthropic|googleapis|generativelanguage|claude|gemini/i; assert.ok(!outbound.some((h) => providerHosts.test(h)), `no outbound request to any AI provider (${[...new Set(outbound)].join(", ")})`); assert.ok(outbound.every((h) => h === "127.0.0.1" || h === "localhost"), "every outbound connection was the local Backend stub");
  assert.ok(backendHits.every((h) => h.method === "GET" && h.key === OFFICE_BRIDGE_KEY), "the only Backend traffic is GET through the existing bridge key"); assert.ok(backendHits.filter((h) => h.url.startsWith("/office/intelligence/providers")).length === providersCalls);
  const pre = providersCalls; config.officeIntelligenceProvidersPath = "/custom/providers"; await get("admin"); assert.ok(providersCalls > pre, "the Backend path is configurable"); delete config.officeIntelligenceProvidersPath;
  assert.ok(!PROVIDERS.some((p) => /grok/.test(p.id)), "provider identity list is closed");
  process.stdout.write = origWrite;
  console.log("4. Security: no secret in responses/audit/logs, no outbound call to any AI provider, only GET via the bridge key, closed provider list — PASS");
  server.closeAllConnections?.(); await new Promise((r) => server.close(r)); backend.closeAllConnections?.(); await new Promise((r) => backend.close(r));
  console.log(JSON.stringify({ status: "PASS", suite: "settings-intelligence-providers" }));
}
main().catch((error) => { console.error(error); process.exit(1); });
