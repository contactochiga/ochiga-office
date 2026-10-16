// Real-browser acceptance test for the Settings intelligence providers UI (S5): headless Chrome over the DevTools protocol against the real Office server (file store, fixtures only).
// Skips (exit 0) when Chrome is not installed. Writes screenshots to OFFICE_ST_SHOTS if set.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { launchChrome, wrapSend } = require("./lib/browser-harness");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { validators } = require("../src/lead-agents/settings-registry");

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const SECTION_KEYS = ["overview", "organization", "people", "intelligence", "integrations", "communications", "automation", "buildings", "crm", "finance", "security", "infrastructure", "audit", "system-health"];
const SECRET = "st-bridge-secret-value";

let deliverySent = 0;
function limiter(max) { return new MemoryRateLimiter({ windowMs: 60000, maxRequests: max }); }
function makeServer({ config, store, extras }) {
  const adapter = { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: (b) => b.events || [], isConfigured: () => true, sendTextMessage: async () => { deliverySent++; return { delivered: true }; }, sendTemplateMessage: async () => ({ delivered: false }), listApprovedTemplates: async () => [] };
  return buildServer({ config, store, rateLimiter: limiter(5000), publicRateLimiter: limiter(5000), officeRateLimiter: limiter(5000), loginRateLimiter: limiter(100), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }), settingsRegistryExtras: extras });
}

async function main() {
  if (!CHROME) { console.log("SKIP: Chrome not installed"); return; }
  const sent = [];
  let providerMode = "absent"; const providerHits = []; const outboundHosts = [];
  for (const mod of [http, require("node:https")]) { const orig = mod.request.bind(mod); mod.request = (...a) => { const o = a[0]; outboundHosts.push(String(typeof o === "string" ? new URL(o).hostname : (o && (o.hostname || o.host)) || "")); return orig(...a); }; }
  const S_KEY = "sk-live-SENTINELBROWSER0001", S_REF = "vault://secret/openai-key";
  const truthful = () => ({ ok: true, schema_version: 1, generated_at: new Date().toISOString(), gateway: { status: "offline_design_only", live_transport_implemented: false, paid_inference_enabled: false, cross_provider_fallback: "disabled", approved_cross_provider_transfers: [], api_key: S_KEY }, providers: [
    { id: "openai", adapter: { registered: true, version: "iq11f-1", protocol: "responses", mode: "offline_mock_only" }, credentials: { status: "unknown", reference: S_REF }, model: { candidates: ["gpt-5.4-mini-2026-03-17", "gpt-5.4-2026-03-05"], status: "candidate" }, qualification: { status: "preparation", scope: "shadow, synthetic only" }, operating_mode: "offline_mock_only", budget: { currency: "USD", approved_maximum: 50, enforcement: { status: "designed" } }, data_processing: { status: "not_reviewed" }, activation: { contract_available: false }, last_verified_at: "2026-10-14T06:25:52Z", limitations: ["No funded project verified", `leaked ${S_KEY}`] },
    { id: "gemini", adapter: { registered: true, protocol: "generateContent-compatibility-profile", mode: "offline_mock_only" }, credentials: { status: "not_provisioned" }, model: { status: "none_selected" }, qualification: { status: "not_started" }, operating_mode: "offline_mock_only", budget: { currency: "USD", enforcement: { status: "none" } }, data_processing: { status: "not_reviewed" } },
    { id: "anthropic", adapter: { registered: true, protocol: "messages", mode: "offline_mock_only" }, credentials: { status: "not_provisioned" }, model: { status: "none_selected" }, qualification: { status: "not_started" }, operating_mode: "offline_mock_only", budget: { currency: "USD" }, data_processing: { status: "not_reviewed" } },
    { id: "grok", qualification: { status: "qualified" } }], provenance: [{ group: "openai.budget", source_record: "iq11f approvals", recorded_at: "2026-10-14T07:28:31Z", conflicts: ["gateway approvals record authorized spend 0; later OpenAI authorization records a 50 USD maximum"] }, { group: "gemini.budget", source_record: "gateway-approvals", recorded_at: "2026-10-14T07:02:50Z", conflicts: [] }, { group: "anthropic.budget", source_record: "gateway-approvals", recorded_at: "2026-10-14T07:02:50Z", conflicts: [] }] });
  const backendStub = http.createServer((req, res) => { sent.push(`${req.method} ${req.url}`); res.setHeader("content-type", "application/json"); if (req.url.startsWith("/office/intelligence/providers")) { providerHits.push(providerMode); if (providerMode === "absent") { res.statusCode = 404; return res.end("{}"); } const b = truthful(); if (providerMode === "spend") b.providers[0].budget = { currency: "USD", approved_maximum: 50, verified_credits: 200, verified_spend: 12.345, enforcement: { status: "verified" } }; if (providerMode === "qualified") b.providers[0] = { ...b.providers[0], credentials: { status: "verified", verified_at: "2026-10-15T00:00:00Z" }, model: { approved_model: "gpt-5.4-mini-2026-03-17", status: "approved" }, qualification: { status: "qualified" }, data_processing: { status: "approved" }, operating_mode: "live", activation: { contract_available: true }, budget: { currency: "USD", approved_maximum: 50, verified_spend: 60, enforcement: { status: "verified" } } }; return res.end(JSON.stringify(b)); } res.end(JSON.stringify({ ok: true })); });
  const backendPort = await listen(backendStub);
  const baseConfig = { ...createConfig(), authMode: "required_api_key", apiKeys: ["st-key"], allowedOrigins: [], officeBackendApiKey: SECRET, officeBackendBaseUrl: `http://127.0.0.1:${backendPort}`, openaiApiKey: "sk-office-assistant-SENTINEL-OA", openaiModel: "gpt-office-assistant", officeConsumerBaseUrl: "", officeDigitalTwinBaseUrl: "", settingsProbeTimeoutMs: 500, settingsProbeMinIntervalMs: 0 };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super", status: "active" });
  await store.ensureAdminUser({ email: "limited@ochiga.local", password_hash: hashPassword("limited-pass-123"), role: "ochiga_staff", display_name: "Limited", status: "active", permission_scopes: ["settings.manage"] });
  await store.ensureAdminUser({ email: "plain@ochiga.local", password_hash: hashPassword("plain-pass-123"), role: "ochiga_staff", display_name: "Plain", status: "active" });
  const seedLead = await store.createLead({ name: "Preview Lead", source: "whatsapp", whatsapp_phone: "2348077700055", status: "new" });
  for (let i = 0; i < 3; i++) await store.appendInboundEvent({ channel: "whatsapp", provider: "meta", event_type: "message", lead_id: seedLead.id, external_event_id: `wamid.browser.${i}.ZZZZZZZZ`, payload: { from: "2348077700055", message_id: `wamid.browser.${i}`, text: "PRIVATE-TEXT", timestamp: String(Math.floor(Date.now() / 1000) - i * 60), message_type: "text" } });
  const server = makeServer({ config: baseConfig, store });
  const port = await listen(server), base = `http://127.0.0.1:${port}`;
  const loginCookie = async (origin, email, password) => { const r = await fetch(`${origin}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }); assert.equal(r.status, 200, `login ${email}`); const [n, v] = r.headers.get("set-cookie").split(";")[0].split("="); return { name: n, value: v }; };
  const superCookie = await loginCookie(base, "super@ochiga.local", "super-pass-123");
  const limitedCookie = await loginCookie(base, "limited@ochiga.local", "limited-pass-123");
  const plainCookie = await loginCookie(base, "plain@ochiga.local", "plain-pass-123");
  const api = (cookie, p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { "content-type": "application/json", cookie: `${cookie.name}=${cookie.value}`, ...(init.headers || {}) } });
  // a real configuration change so Recent Activity has a genuine audit record to show
  assert.equal((await api(superCookie, "/api/lead-agents/admin/settings/whatsapp-autonomy", { method: "PUT", body: JSON.stringify({ enabled: false }) })).status, 200);

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "st-chrome-"));
  const chromeHandle = await launchChrome(CHROME, { userDir, flags: ["--hide-scrollbars", "--disable-features=BackForwardCache"] }); const chrome = chromeHandle.proc;
  let ws, id = 0; const pending = new Map(); let deadServer = null; const errors = [];
  try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${chromeHandle.port}/json`)).json(); } catch { await sleep(200); } }
    assert.ok(targets, "Chrome DevTools is reachable");
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send0 = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; const t = setTimeout(() => { pending.delete(n); reject(new Error(`CDP call timed out: ${method} ${JSON.stringify(params).slice(0, 160)}`)); }, 20000); pending.set(n, (d) => { clearTimeout(t); resolve(d); }); ws.send(JSON.stringify({ id: n, method, params })); });
    const send = wrapSend(send0, { label: 'test-settings-providers-browser.js' });
    const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
    const waitFor = async (expr, label, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJs(expr)) return true; } catch { /* navigating */ } await sleep(120); } { const conns = await new Promise((r) => server.getConnections((e, n) => r(n))); throw new Error(`DIAG timeout waiting for: ${label} | officeConnections=${conns} | inflight=${JSON.stringify([...inflightReq.values()])} | failed=${JSON.stringify(failedReq.slice(-5))} | state=${await evalJs(`JSON.stringify({ rs: document.readyState, hash: location.hash, page: !!document.querySelector('.st-page'), stale: !!document.querySelector('.st-page[data-stale]'), cards: document.querySelectorAll('.st-ai-provider').length, skeleton: !!document.querySelector('#stContent .skeleton-line'), content: (document.querySelector('#stContent')?.innerText || '').slice(0, 120) })`).catch((e) => 'eval failed: ' + e.message)}`); } };
    const shot = async (name) => { if (!process.env.OFFICE_ST_SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(process.env.OFFICE_ST_SHOTS, name), Buffer.from(r.result.data, "base64")); };
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); const inflightReq = new Map(); const failedReq = []; ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.method === "Network.requestWillBeSent") inflightReq.set(d.params.requestId, d.params.request.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 70)); else if (d.method === "Network.loadingFinished") inflightReq.delete(d.params.requestId); else if (d.method === "Network.loadingFailed") { failedReq.push(`${inflightReq.get(d.params.requestId) || "?"}: ${d.params.errorText}`); inflightReq.delete(d.params.requestId); } });
    ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); });
    const useCookie = async (c, origin = base) => { await send("Page.navigate", { url: "about:blank" }); await send("Network.setCookie", { name: c.name, value: c.value, url: origin }); };
    const viewport = (width, height, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    const go = async (hash, ready) => { await evalJs(`document.querySelector('.st-page')?.setAttribute('data-stale', '1')`).catch(() => null); const same = await evalJs(`location.hash === '#/${hash}'`).catch(() => false); await send(same ? "Page.reload" : "Page.navigate", same ? {} : { url: `${base}/office#/${hash}` }); const fresh = `!document.querySelector('.st-page[data-stale]')`; await waitFor(`${fresh} && (${ready || `!!document.querySelector('.st-page') && !document.querySelector('#stContent .skeleton-line')`})`, `route ${hash}`); };
    const noOverflow = () => evalJs(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
    await useCookie(superCookie);
    await viewport(1440, 900);

    const goAs = async (hash, ready, fresh = false) => { if (fresh) await send("Page.navigate", { url: "about:blank" }); await send("Network.setCookie", { name: activeCookie.name, value: activeCookie.value, url: base }); await evalJs(`document.querySelector('.st-page')?.setAttribute('data-stale','1')`).catch(() => null); const same = await evalJs(`location.hash === '#/${hash}'`).catch(() => false); if (same) await send("Page.reload", { ignoreCache: true }); else await send("Page.navigate", { url: `${base}/office#/${hash}` }); await waitFor(`!document.querySelector('.st-page[data-stale]') && (${ready})`, `route ${hash}`); await sleep(150); };
    let activeCookie = superCookie;
    const AI = `document.querySelectorAll('.st-ai-provider')`;
    const intel = (mode, fresh = false) => { providerMode = mode; return goAs("settings/intelligence", `document.querySelectorAll('.st-ai-provider').length === 3 && !document.querySelector('#stContent .skeleton-line')`, fresh); };
    const cardText = (id) => evalJs(`document.querySelector('.st-ai-provider[data-provider="${id}"]').innerText`);
    const noControls = async () => assert.equal(await evalJs(`document.querySelectorAll('.st-ai-provider input, .st-ai-provider button, .st-ai-provider a, .st-ai-provider select, .st-ai-provider textarea, .st-ai-provider [role=switch], .st-ai-provider [role=button]').length`), 0, "provider cards contain no input, button, link, select or switch");
    await viewport(1440, 900);

    // 26. Backend status unavailable
    await intel("absent");
    const off = await evalJs(`document.querySelector('#stContent').innerText`);
    assert.ok(/Provider state unavailable/.test(off) && /does not exist yet/.test(off), "banner says the Backend endpoint is unavailable");
    const rowOf = (t, label) => (t.split("\n").join("|").match(new RegExp(`${label}\\|([^|]*)`, "i")) || [])[1] || "";
    for (const id of ["openai", "gemini", "anthropic"]) { const t = await cardText(id); assert.ok(/State unknown/.test(t), `${id}: state unknown`); for (const label of ["Qualification", "Operating mode", "Approved spending ceiling", "Remaining authorized budget", "Data-processing review", "Approved model"]) assert.ok(/Unknown/.test(rowOf(t, label)), `${id}: ${label} is Unknown (got "${rowOf(t, label)}")`); for (const label of ["Verified API credits", "Verified actual expenditure", "Last verified"]) assert.ok(/Not verified/.test(rowOf(t, label)), `${id}: ${label} is Not verified`); assert.ok(!/USD/.test(t), `${id}: no money figure is invented`); }
    const oaOff = await cardText("openai"); assert.ok(/Office assistant \(legacy path\): configured/.test(oaOff) && /gpt-office-assistant/.test(oaOff) && /not an Oyi Core qualification/.test(oaOff), "the only local fact is shown as legacy assistant configuration, not as qualification");
    assert.ok(/No Office configuration exists/.test(await cardText("gemini")) && /No Office configuration exists/.test(await cardText("anthropic")));
    assert.ok(/Activation is not available in Office/.test(oaOff)); await noControls();
    assert.ok(!(await evalJs(`document.querySelector('.st-page').innerText`)).includes("sk-office-assistant"), "the Office assistant key is never shown");
    await shot("settings-intelligence-unavailable-1440.png");
    console.log("26. Backend status unavailable: all providers Unknown / Not verified, Office-configured shown only as legacy assistant, no controls — PASS");

    // 27. truthful Backend data
    await intel("truthful");
    const oa = await cardText("openai"), ge = await cardText("gemini"), an = await cardText("anthropic");
    assert.ok(/Preparation \(not qualified\)/.test(oa) && /Offline mock only/.test(oa) && /None approved/.test(oa) && /gpt-5\.4-mini-2026-03-17/.test(oa), `OpenAI: candidates are not an approved model: ${oa.slice(0, 200)}`);
    assert.ok(/USD 50/i.test(oa) && /approved maximum, not funded credit/i.test(oa), "the ceiling is labelled as a ceiling, not funding");
    const row = rowOf;
    assert.ok(/Not verified/.test(row(oa, "Verified API credits")) && /Not verified/.test(row(oa, "Verified actual expenditure")) && /Unknown/.test(row(oa, "Remaining authorized budget")), "credits and expenditure are Not verified; remaining is Unknown");
    assert.ok(/No paid-call authorization recorded/.test(ge) && /No paid-call authorization recorded/.test(an), "Gemini and Claude have no paid-call authorization");
    assert.ok(/Review not|Not reviewed/i.test(oa), "data-processing review: not reviewed");
    assert.equal(await evalJs(`${AI}.length`), 3, "an unlisted provider (grok) from the Backend is ignored");
    const pageText = await evalJs(`document.querySelector('#stContent').innerText`);
    assert.ok(/Record conflict: gateway approvals record authorized spend 0/.test(pageText), "recorded conflicts between approval records are shown");
    assert.ok(/Paid inference: disabled/.test(pageText) && /Approved cross-provider transfers: none/.test(pageText) && /Cross-provider fallback: Disabled/.test(pageText));
    for (const s of [S_KEY, S_REF, "sk-office-assistant"]) assert.ok(!pageText.includes(s), `${s.slice(0, 16)}… never reaches the page`);
    await noControls(); await shot("settings-intelligence-1440.png"); await evalJs(`document.querySelector('.st-ai-providers').scrollIntoView({ block: "start" })`); await sleep(200); await shot("settings-intelligence-cards-1440.png");
    console.log("27. Truthful state: ceiling ≠ credits ≠ spend, candidates ≠ approved model, conflicts surfaced, secrets dropped, unlisted provider ignored — PASS");

    // 28. budget arithmetic and 29. fully qualified still cannot be activated
    await intel("spend"); assert.ok(/USD 37\.65/.test(row(await cardText("openai"), "Remaining authorized budget")) && /USD 12\.35/.test(row(await cardText("openai"), "Verified actual expenditure")) && /USD 200/.test(row(await cardText("openai"), "Verified API credits")), "remaining = approved maximum − verified expenditure; credits do not enter the calculation");
    await intel("qualified"); const qo = await cardText("openai");
    assert.ok(/Qualified \(not activated\)/.test(qo) && /gpt-5\.4-mini-2026-03-17/.test(qo) && /Live/.test(qo), "a qualified provider is shown as qualified, not activated"); assert.ok(/USD 0(?!\.[1-9])/.test(row(qo, "Remaining authorized budget")), "overspend never shows a negative remaining budget");
    assert.ok(/Activation is not available in Office in this release/.test(qo) && /Connected does not mean qualified/.test(qo)); await noControls();
    assert.equal(await evalJs(`document.querySelectorAll('.st-ai-provider .st-ready-met').length >= 5`), true, "readiness reflects the reported state"); assert.ok(/Explicit confirmation[\s\S]*Not met/.test(qo), "confirmation and audit remain unmet");
    await shot("settings-intelligence-qualified-1440.png");
    console.log("28-29. Remaining budget computed only from verified inputs; a qualified provider with an activation contract is still not activatable, no controls — PASS");

    // 30. permissions
    const denyStatus = async () => evalJs(`(async () => (await fetch('/api/lead-agents/admin/intelligence/providers', { credentials: 'same-origin' })).status)()`);
    activeCookie = limitedCookie; providerMode = "truthful"; await goAs("settings/intelligence", `!!document.querySelector('.st-denied-panel')`, true);
    assert.ok(/audit\.read/.test(await evalJs(`document.querySelector('.st-denied-panel').textContent`)), "deep link without audit.read is denied"); assert.equal(await denyStatus(), 403, "the server refuses the data too");
    assert.equal(await evalJs(`document.querySelectorAll('.st-ai-provider').length`), 0, "no provider data rendered");
    console.log("30. Permissions: no audit.read -> denied panel and 403 from the server — PASS");

    // 31. responsive + no provider traffic
    activeCookie = superCookie; providerMode = "truthful";
    for (const w of [1100, 900, 768, 390]) { await viewport(w, 900, w <= 480); await goAs("settings/intelligence", `document.querySelectorAll('.st-ai-provider').length === 3 && !document.querySelector('#stContent .skeleton-line')`, w === 1100); assert.ok(await noOverflow(), `${w}px: no horizontal overflow`); if (w === 900 || w === 390) { await evalJs(`document.querySelector('.st-ai-providers').scrollIntoView({ block: "start" })`); await sleep(200); await shot(`settings-intelligence-${w}.png`); } }
    assert.ok(!outboundHosts.some((h) => /openai|anthropic|googleapis|generativelanguage|claude|gemini/i.test(h)), `no outbound request to any AI provider (${[...new Set(outboundHosts)].join(", ")})`);
    assert.ok(sent.every((x) => x.startsWith("GET ")), "the Backend only ever received GET requests"); assert.equal(deliverySent, 0, "no customer message");
    console.log("31. Responsive 1100/900/768/390 without overflow; zero AI-provider traffic; only GETs to the Backend — PASS");

    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
    console.log(JSON.stringify({ status: "PASS", suite: "settings-providers-browser" }));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    await chromeHandle.stop();
    for (const s of [server, backendStub]) if (s) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* chrome still flushing its profile */ }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
