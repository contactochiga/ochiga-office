// S5 FINAL INTEGRATION ACCEPTANCE: the real Office server (feature/settings-s1-s2) talking through its real authenticated bridge to the real Backend router
// (feature/s5-provider-status-contract, served by scripts/s5-integration-harness.mjs in the Backend repo), driven by headless Chrome.
// Env: BACKEND_REPO (default /tmp/be-s5). Screenshots go to OFFICE_ST_SHOTS. Skips (exit 0) without Chrome or the Backend repo.
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

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const BACKEND_REPO = process.env.BACKEND_REPO || "/tmp/be-s5";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (s) => new Promise((res, rej) => { s.once("error", rej); s.listen(0, "127.0.0.1", () => res(s.address().port)); });
const limiter = (n) => new MemoryRateLimiter({ windowMs: 60000, maxRequests: n });
const BRIDGE_KEY = `s5-int-bridge-key-${process.pid}-SENTINEL`, OFFICE_OPENAI = "sk-office-assistant-INTEGRATION-SENTINEL";
const LEAKS = ["sk-live-INTEGRATIONLEAK0001", "AIzaSyINTEGRATIONLEAK000000002", "INTEGRATIONLEAKTOKEN03", BRIDGE_KEY, OFFICE_OPENAI];

async function main() {
  if (!CHROME) { console.log("SKIP: Chrome not installed"); return; }
  if (!fs.existsSync(path.join(BACKEND_REPO, "dist/routes/officeExport.js"))) { console.log(`SKIP: built Backend not found at ${BACKEND_REPO} (run npm run build there, or set BACKEND_REPO)`); return; }
  // ---- the real Backend, in its own process ----
  const harness = spawn(process.execPath, ["scripts/s5-integration-harness.mjs", "0"], { cwd: BACKEND_REPO, env: { ...process.env, OFFICE_SYNC_API_KEY: BRIDGE_KEY }, stdio: ["ignore", "pipe", "pipe"] });
  let hport = 0; await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("Backend harness did not start")), 20000); harness.stdout.on("data", (d) => { const m = String(d).match(/HARNESS_READY (\d+)/); if (m) { hport = Number(m[1]); clearTimeout(t); resolve(); } }); harness.on("exit", (c) => reject(new Error(`Backend harness exited early (${c})`))); });
  const H = `http://127.0.0.1:${hport}`;
  const setMode = (mode) => fetch(`${H}/__harness/mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) }).then((r) => r.json());
  const harnessLog = () => fetch(`${H}/__harness/log`).then((r) => r.json());
  const backendDirect = (p, headers = {}) => fetch(`${H}${p}`, { headers }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

  const baseConfig = { ...createConfig(), authMode: "required_api_key", apiKeys: ["st-key"], allowedOrigins: [], officeBackendBaseUrl: H, officeBackendApiKey: BRIDGE_KEY, officeIntelligenceProvidersPath: "/office/intelligence/providers", openaiApiKey: OFFICE_OPENAI, openaiModel: "gpt-office-assistant" };
  const { store } = await createTempStore();
  for (const [email, role, pw, extra] of [["admin@ochiga.local", "super_admin", "super-pass-123", {}], ["staff@ochiga.local", "ochiga_staff", "staff-pass-123", { permission_scopes: ["settings.manage"] }]]) await store.ensureAdminUser({ email, password_hash: hashPassword(pw), role, display_name: email.split("@")[0], status: "active", ...extra });
  let officeOutbound = []; const http_ = require("node:http"); const origReq = http_.request.bind(http_); http_.request = (...a) => { const o = a[0]; officeOutbound.push(String(typeof o === "string" ? new URL(o).hostname : (o && (o.hostname || o.host)) || "")); return origReq(...a); };
  const server = buildServer({ config: baseConfig, store, rateLimiter: limiter(5000), publicRateLimiter: limiter(5000), officeRateLimiter: limiter(5000), loginRateLimiter: limiter(200), whatsappAdapter: { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: () => [], isConfigured: () => true, sendTextMessage: async () => { throw new Error("no customer message may be sent"); }, sendTemplateMessage: async () => ({ delivered: false }), listApprovedTemplates: async () => [] }, openaiClient: new Proxy({}, { get() { throw new Error("the OpenAI client must never be used by provider status"); } }), toolExecutor: new ToolExecutor({ store, config: baseConfig, log: () => {}, webhooks: new WebhookDispatcher({ config: baseConfig }) }) });
  const port = await listen(server), base = `http://127.0.0.1:${port}`;
  const loginCookie = async (email, password) => { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }); assert.equal(r.status, 200); const [n, v] = r.headers.get("set-cookie").split(";")[0].split("="); return { name: n, value: v }; };
  const superCookie = await loginCookie("admin@ochiga.local", "super-pass-123"), limitedCookie = await loginCookie("staff@ochiga.local", "staff-pass-123");
  const officeApi = (cookie, p) => fetch(`${base}${p}`, { headers: cookie ? { cookie: `${cookie.name}=${cookie.value}` } : {} }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null), text: await r.text().catch(() => "") }));
  const PROV = "/api/lead-agents/admin/intelligence/providers";

  let ws, id = 0; const pending = new Map(); const errors = [];
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "st-chrome-"));
  const chromeHandle = await launchChrome(CHROME, { userDir, flags: ["--hide-scrollbars", "--disable-features=BackForwardCache"] }); const chrome = chromeHandle.proc;
  try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${chromeHandle.port}/json`)).json(); } catch { await sleep(200); } }
    assert.ok(targets, "Chrome DevTools is reachable");
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send0 = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; const t = setTimeout(() => { pending.delete(n); reject(new Error(`CDP call timed out: ${method} ${JSON.stringify(params).slice(0, 160)}`)); }, 20000); pending.set(n, (d) => { clearTimeout(t); resolve(d); }); ws.send(JSON.stringify({ id: n, method, params })); });
    const send = wrapSend(send0, { label: 'test-s5-integration-acceptance.js' });
    const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
    const waitFor = async (expr, label, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJs(expr)) return true; } catch { /* navigating */ } await sleep(120); } throw new Error(`timeout waiting for: ${label} | page errors: ${errors.slice(-2).join(' / ').slice(0, 400)} | hash: ${await evalJs(`location.hash + " segs=" + document.title`).catch(() => "?")} | body: ${(await evalJs(`document.querySelector('#viewOutlet')?.innerText?.slice(0, 300)`).catch(() => '?'))}`); };
    const shot = async (name) => { if (!process.env.OFFICE_ST_SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(process.env.OFFICE_ST_SHOTS, name), Buffer.from(r.result.data, "base64")); };
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
    ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); });
    const useCookie = async (c, origin = base) => { await send("Page.navigate", { url: "about:blank" }); await send("Network.setCookie", { name: c.name, value: c.value, url: origin }); };
    const viewport = (width, height, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    const go = async (hash, ready) => { await evalJs(`document.querySelector('.st-page')?.setAttribute('data-stale', '1')`).catch(() => null); const same = await evalJs(`location.hash === '#/${hash}'`).catch(() => false); await send(same ? "Page.reload" : "Page.navigate", same ? {} : { url: `${base}/office#/${hash}` }); const fresh = `!document.querySelector('.st-page[data-stale]')`; await waitFor(`${fresh} && (${ready || `!!document.querySelector('.st-page') && !document.querySelector('#stContent .skeleton-line')`})`, `route ${hash}`); };
    const noOverflow = () => evalJs(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
    await useCookie(superCookie);
    await viewport(1440, 900);

    const goAs = async (hash, ready, fresh = false) => { if (fresh) await send("Page.navigate", { url: "about:blank" }); await send("Network.setCookie", { name: activeCookie.name, value: activeCookie.value, url: base }); await evalJs(`document.querySelector('.st-page')?.setAttribute('data-stale','1')`).catch(() => null); const same = await evalJs(`location.hash === '#/${hash}'`).catch(() => false); if (same) await send("Page.reload", { ignoreCache: true }); else await send("Page.navigate", { url: `${base}/office#/${hash}` }); await waitFor(`!document.querySelector('.st-page[data-stale]') && (${ready})`, `route ${hash}`); await sleep(150); };
    let activeCookie = superCookie;
    const AIQ = `document.querySelectorAll('.st-ai-provider')`;
    const intel = async (mode, path, fresh = false) => { if (mode) await setMode(mode); baseConfig.officeIntelligenceProvidersPath = path || "/office/intelligence/providers"; await goAs("settings/intelligence", `document.querySelectorAll('.st-ai-provider').length === 3 && !document.querySelector('#stContent .skeleton-line')`, fresh); };
    const cardText = (id) => evalJs(`document.querySelector('.st-ai-provider[data-provider="${id}"]').innerText`);
    const rowOf = (t, label) => (t.split("\n").join("|").match(new RegExp(`${label}\\|([^|]*)`, "i")) || [])[1] || "";
    const pageText = () => evalJs(`document.querySelector('#stContent').innerText`);
    const noControls = async () => { assert.equal(await evalJs(`document.querySelectorAll('.st-ai-provider input, .st-ai-provider button, .st-ai-provider a, .st-ai-provider select, .st-ai-provider textarea, .st-ai-provider [role=switch], .st-ai-provider [role=button]').length`), 0, "provider cards: no input, button, link, select or switch"); assert.equal(await evalJs(`document.querySelectorAll('#stContent input, #stContent textarea, #stContent select, #stContent input[type=password]').length`), 0, "the Intelligence section has no credential or any other input"); };
    const V = "/variant/office/intelligence/providers";
    await viewport(1440, 900);

    // ===== 1. real route, real ledger: every fact traces to the Backend approval ledger =====
    await intel("seed", "/office/intelligence/providers");
    const direct = await backendDirect("/office/intelligence/providers", { "x-office-api-key": BRIDGE_KEY });
    assert.equal(direct.status, 200); assert.equal(direct.json.source.record_count, 6); assert.equal(direct.json.source.rejected_count, 0);
    const oaB = direct.json.providers.find((p) => p.id === "openai");
    const officeAPI = await officeApi(superCookie, PROV); assert.equal(officeAPI.status, 200); assert.equal(officeAPI.json.available, true);
    const oaO = officeAPI.json.providers.find((p) => p.id === "openai");
    assert.deepEqual([oaO.budget.approved_maximum, oaO.budget.currency, oaO.budget.verified_credits, oaO.budget.verified_spend, oaO.budget.remaining_authorized, oaO.qualification.status, oaO.credentials.status, oaO.model.status, oaO.model.approved_model, oaO.data_processing.status, oaO.budget.enforcement, oaO.last_verified_at], [oaB.budget.approved_maximum, oaB.budget.currency, oaB.budget.verified_credits, oaB.budget.verified_spend, null, oaB.qualification.status, oaB.credentials.status, oaB.model.status, oaB.model.approved_model, oaB.data_processing.status, oaB.budget.enforcement.status, oaB.last_verified_at], "Office's normalised provider equals the Backend's, field for field (remaining is Office-computed: unknown)");
    const oa = await cardText("openai"), ge = await cardText("gemini"), cl = await cardText("anthropic");
    assert.ok(/USD 50/.test(rowOf(oa, "Approved spending ceiling")) && /approved maximum, not funded credit/.test(oa), "OpenAI: the $50 is shown as a ceiling, never as funding");
    assert.ok(/Not verified/.test(rowOf(oa, "Verified API credits")) && /Not verified/.test(rowOf(oa, "Verified actual expenditure")), "credits and expenditure Not verified"); assert.ok(/Unknown/.test(rowOf(oa, "Remaining authorized budget")), "remaining Unknown");
    assert.ok(/Preparation \(not qualified\)/.test(oa) && /None approved/.test(oa) && /gpt-5\.4-mini-2026-03-17/.test(oa) && /gpt-5\.4-2026-03-05/.test(oa), "OpenAI: preparation, two candidate snapshots, no approved model");
    assert.ok(/Unknown/.test(rowOf(oa, "Connection / configuration")), "credentials Unknown (absence in a checked scope is not 'not provisioned')"); assert.ok(/Designed, not enforced/.test(oa) && /Not reviewed/.test(rowOf(oa, "Data-processing review")) && /Offline mock only/.test(oa));
    assert.ok(/14 Oct/.test(rowOf(oa, "Last verified")), "last verified is the observation time from the ledger"); assert.ok(/Durable live budget enforcement is not implemented/.test(oa) && /No credential was found in the checked scope/.test(oa), "ledger limitations are shown");
    assert.ok(/Office assistant \(legacy path\): configured/.test(oa) && /not an Oyi Core qualification/.test(oa), "the Office-side OpenAI key is shown only as the legacy assistant");
    for (const [id, t] of [["gemini", ge], ["anthropic", cl]]) { assert.ok(/No paid-call authorization recorded/.test(rowOf(t, "Approved spending ceiling")), `${id}: no paid-call authorization`); assert.ok(/None selected/.test(t) && /Not started/.test(t) && !/USD/.test(t.replace(/Verified|approved/gi, "")) || !/USD \d/.test(t), `${id}: no model, not started, no money`); assert.ok(/No Office configuration exists/.test(t), `${id}: no Office configuration`); assert.ok(/Not verified/.test(rowOf(t, "Verified API credits")) && /Unknown/.test(rowOf(t, "Remaining authorized budget"))); }
    const p1 = await pageText();
    assert.ok(/Backend provider status/.test(p1) && /Offline Design Only/i.test(p1) && /Paid inference: disabled/.test(p1) && /Cross-provider fallback: Disabled/.test(p1) && /Approved cross-provider transfers: none/.test(p1) && /Live transport: not implemented/.test(p1), "gateway state from the ledger");
    assert.ok(/Record conflict: Gateway record gateway-approvals-iq11f-2026-10-14 states authorized spend 0; provider authorization openai-shadow-budget-authorization-2026-10-14 states a maximum of 50/.test(p1), "the 0 vs 50 conflict is shown with both record ids");
    await noControls(); await shot("01-real-ledger-1440.png"); await evalJs(`document.querySelector('.st-ai-providers').scrollIntoView({ block: "start" })`); await sleep(200); await shot("01-real-ledger-cards-1440.png");
    console.log("1. Real Office -> real Backend route: every card fact traces to the approval ledger; $50 ceiling with unknown credits/expenditure/remaining; 0-vs-50 conflict shown — PASS");

    // ===== 2. stale records =====
    await intel("stale", V);
    const st = await cardText("openai"); assert.ok(/older than its 168-hour validity/.test(st), "the stale observation is flagged on the card"); assert.ok(/Unknown/.test(rowOf(st, "Connection / configuration")) && /14 Oct/.test(rowOf(st, "Last verified")), "stale facts revert to Unknown while the observation time stays visible");
    assert.ok(/USD 50/.test(rowOf(st, "Approved spending ceiling")), "the approval record is not an observation: the ceiling is unaffected by staleness");
    await shot("02-stale-1440.png"); console.log("2. Stale evidence: flagged first, facts revert to Unknown, ceiling unaffected — PASS");

    // ===== 3. conflicting approvals =====
    await intel("conflict", V);
    const cg = await cardText("gemini"), cc = await cardText("anthropic");
    assert.ok(/Unknown/.test(rowOf(cg, "Approved spending ceiling")) && /conflicting approval records/.test(rowOf(cg, "Approved spending ceiling")) && !/No paid-call authorization recorded/.test(cg), "Gemini: disagreeing authorizations make the ceiling Unknown, not 'none' and not 20 or 35");
    assert.ok(/Unresolved: authorization records gemini-auth-a \(20\) and gemini-auth-b \(35\)/.test(cg), "the card names both conflicting records");
    assert.ok(/State unknown/.test(cc) && /Unknown/.test(rowOf(cc, "Qualification")) && !/Qualified \(not activated\)/.test(cc), "Claude: simultaneous in_progress vs qualified is Unknown, never qualified"); assert.ok(/disagree on qualification_status/.test(cc));
    await shot("03-conflict-1440.png"); await viewport(390, 800, true); await intel(null, V, true); await evalJs(`document.querySelector('.st-ai-providers').scrollIntoView({ block: "start" })`); await sleep(200); await shot("03-conflict-390.png"); await viewport(1440, 900);
    console.log("3. Conflicting approvals: ceiling Unknown (not 20/35/none), qualification Unknown (not qualified), both records named — PASS");

    // ===== 4. missing Backend records / unavailable Backend states =====
    await intel("empty", V); const em = await cardText("openai"); assert.ok(/No approval record exists for this provider/.test(em), "empty ledger: every provider states that no record exists"); for (const id of ["openai", "gemini", "anthropic"]) { const t = await cardText(id); assert.ok(/State unknown/.test(t) && /Unknown/.test(rowOf(t, "Approved spending ceiling")), `${id}: all unknown`); } assert.ok(/Gateway: Unknown/.test(await pageText()) || /Unknown/.test(await pageText()), "gateway state unknown"); await shot("04-empty-ledger-1440.png");
    await intel(null, "/office/intelligence/providers-not-built"); assert.ok(/Provider state unavailable/.test(await pageText()) && /does not exist yet/.test(await pageText()), "Backend without the endpoint (404)"); await shot("05-endpoint-absent-1440.png");
    baseConfig.officeBackendApiKey = "wrong-bridge-key"; await intel(null, "/office/intelligence/providers"); assert.ok(/Provider state unavailable/.test(await pageText()) && /refused the request/.test(await pageText()), "a bridge key the Backend rejects (401) is reported as refused, never as data"); baseConfig.officeBackendApiKey = BRIDGE_KEY;
    const savedBase = baseConfig.officeBackendBaseUrl; baseConfig.officeBackendBaseUrl = "http://127.0.0.1:1"; await intel(null, "/office/intelligence/providers"); assert.ok(/could not be reached/.test(await pageText()), "unreachable Backend"); await shot("06-backend-unreachable-1440.png"); baseConfig.officeBackendBaseUrl = ""; await intel(null, "/office/intelligence/providers"); assert.ok(/bridge is not configured/.test(await pageText()), "unconfigured Backend"); baseConfig.officeBackendBaseUrl = savedBase;
    for (const id of ["openai", "gemini", "anthropic"]) { const t = await cardText(id); assert.ok(/State unknown/.test(t) && !/USD \d/.test(t), `${id}: unavailable Backend never produces a figure`); }
    console.log("4. Missing and unavailable Backend states (empty ledger, 404, 401 bridge key, unreachable, unconfigured): everything Unknown, nothing invented — PASS");

    // ===== 5. verified amounts stay separate =====
    await intel("verified", V); const vo = await cardText("openai");
    assert.ok(/USD 50/.test(rowOf(vo, "Approved spending ceiling")) && /USD 120/.test(rowOf(vo, "Verified API credits")) && /USD 7\.50/.test(rowOf(vo, "Verified actual expenditure")) && /USD 42\.50/.test(rowOf(vo, "Remaining authorized budget")), "ceiling 50, credits 120, spend 7.50, remaining 42.50 (= ceiling - verified spend; credits do not enter it)");
    assert.ok(/Verified/.test(rowOf(vo, "Connection / configuration")), "verified credentials only from a fresh verified observation"); assert.ok(/Preparation \(not qualified\)/.test(vo), "verified credentials do not make a provider qualified"); await noControls(); await shot("07-verified-amounts-1440.png");
    console.log("5. Verified fresh observation: four budget quantities shown separately; verified credentials still not qualified or activatable — PASS");

    // ===== 6. hostile ledger / credential redaction =====
    await intel("hostile", V); const hp = await pageText(); const hostileApi = await officeApi(superCookie, PROV);
    for (const leak of LEAKS) { assert.ok(!hp.includes(leak), `${leak.slice(0, 16)}… not on the page`); assert.ok(!hostileApi.text.includes(leak), `${leak.slice(0, 16)}… not in Office's API response`); }
    assert.equal(await evalJs(`${AIQ}.length`), 3, "an unlisted provider is not rendered"); assert.ok(!/grok/i.test(hp) && !/grok/i.test(hostileApi.text), "its name does not appear either");
    assert.ok(/was not projected: unknown_provider/.test(hp) && /was not projected: invalid_limitations/.test(hp), "the Backend reports which records it refused"); assert.equal((await backendDirect(V, { "x-api-key": BRIDGE_KEY })).json.providers.find((p) => p.id === "openai").budget.approved_maximum, 50, "rejected records changed nothing");
    assert.ok(!/999/.test(await cardText("openai")), "the rejected 999 authorization never shows"); await shot("08-hostile-ledger-1440.png");
    console.log("6. Hostile ledger: secrets, unknown provider and extra fields never reach Office or the browser; refused records reported — PASS");

    // ===== 7. access control =====
    await setMode("seed"); baseConfig.officeIntelligenceProvidersPath = "/office/intelligence/providers";
    assert.equal((await officeApi(null, PROV)).status, 401, "Office: unauthenticated"); assert.equal((await officeApi(limitedCookie, PROV)).status, 403, "Office: ochiga_staff without audit.read"); assert.equal((await officeApi(superCookie, PROV)).status, 200, "Office: administrator");
    assert.equal((await backendDirect("/office/intelligence/providers")).status, 401, "Backend: no credential"); assert.equal((await backendDirect("/office/intelligence/providers", { "x-api-key": "wrong" })).status, 401, "Backend: wrong credential"); assert.equal((await backendDirect("/office/intelligence/providers", { "x-office-api-key": BRIDGE_KEY })).status, 200, "Backend: the Office bridge credential");
    activeCookie = limitedCookie; await goAs("settings/intelligence", `!!document.querySelector('.st-denied-panel')`, true); assert.ok(/audit\.read/.test(await evalJs(`document.querySelector('.st-denied-panel').textContent`)) && (await evalJs(`${AIQ}.length`)) === 0, "browser: a user without audit.read gets the denied panel and no provider data");
    for (const m of ["POST", "PUT", "DELETE"]) assert.equal((await fetch(`${base}${PROV}`, { method: m, headers: { cookie: `${superCookie.name}=${superCookie.value}` } })).status, 405, `Office: ${m} refused`);
    await shot("09-denied-1440.png"); activeCookie = superCookie;
    console.log("7. Access: Office 401/403/200 and 405 for writes; Backend 401 without or with a wrong credential — PASS");

    // ===== 8. responsive layouts (real route) =====
    for (const w of [1440, 1100, 900, 768, 390]) { await viewport(w, 900, w <= 480); await intel("seed", "/office/intelligence/providers", true); assert.ok(await noOverflow(), `${w}px: no horizontal overflow`); assert.ok(/USD 50/.test(await cardText("openai")), `${w}px: facts intact`); await evalJs(`document.querySelector('.st-ai-providers').scrollIntoView({ block: "start" })`); await sleep(200); await shot(`10-responsive-${w}.png`); }
    await viewport(1440, 900);
    console.log("8. Responsive 1440/1100/900/768/390: no overflow, facts intact — PASS");

    // ===== 9. what must stay unavailable, and what actually crossed the wire =====
    await intel("seed", "/office/intelligence/providers"); await noControls(); const fin = await pageText();
    assert.ok(/Activation is not available in Office in this release/.test(fin) && /Connected does not mean qualified/.test(fin), "activation unavailable"); assert.ok(/Paid inference: disabled/.test(fin) && /Cross-provider fallback: Disabled/.test(fin), "paid inference and fallback unavailable");
    const log = await harnessLog();
    const providerReqs = log.requests.filter((r) => /providers/.test(r.path)); assert.ok(providerReqs.length > 10, `the Backend served ${providerReqs.length} provider-status requests`);
    assert.ok(log.requests.every((r) => r.method === "GET"), "the only requests Office ever sent to the Backend were GETs"); assert.deepEqual([...new Set(log.requests.filter((r) => !/^\/(office|variant\/office)\/intelligence\/providers/.test(r.path)).map((r) => r.path))], ["/health"], "…and only to the provider-status paths plus the existing Integrations health probe (GET /health, which backs the Oyi Intelligence card)");
    assert.deepEqual(log.outbound, [], "the Backend process made no non-loopback connection (no provider traffic)"); assert.ok(officeOutbound.every((h) => h === "127.0.0.1" || h === "localhost"), `the Office process only ever connected to loopback (${[...new Set(officeOutbound)].join(", ")})`);
    assert.ok(!officeOutbound.some((h) => /openai|anthropic|google|claude|gemini/i.test(h)), "no AI-provider host contacted");
    console.log("9. Activation, paid inference, credential entry and fallback unavailable; only GETs to the provider-status path; zero non-loopback traffic from either process — PASS");

    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
    console.log(JSON.stringify({ status: "PASS", suite: "s5-integration-acceptance" }));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    await chromeHandle.stop(); harness.kill();
    server.closeAllConnections?.(); await new Promise((r) => server.close(r));
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* flushing */ }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
