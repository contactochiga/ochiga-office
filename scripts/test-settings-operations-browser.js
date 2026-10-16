// Real-browser acceptance test for the Settings operations UI (S4): headless Chrome over the DevTools protocol against the real Office server (file store, fixtures only).
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
  const backendStub = http.createServer((req, res) => { sent.push(`${req.method} ${req.url}`); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true })); });
  const backendPort = await listen(backendStub);
  const baseConfig = { ...createConfig(), authMode: "required_api_key", apiKeys: ["st-key"], allowedOrigins: [], officeBackendApiKey: SECRET, officeBackendBaseUrl: `http://127.0.0.1:${backendPort}`, officeFacilityBaseUrl: `http://127.0.0.1:${backendPort}`, officeFacilityApiKey: "facility-secret-xyz", officeConsumerBaseUrl: "", officeDigitalTwinBaseUrl: "", settingsProbeTimeoutMs: 500, settingsProbeMinIntervalMs: 0 };
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
    const send = wrapSend(send0, { label: 'test-settings-operations-browser.js' });
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
    await viewport(1440, 900);
    const storeHash = () => require("node:crypto").createHash("sha256").update(JSON.stringify((({ audit_events, ...rest }) => rest)(store.state))).digest("hex");
    const h0 = storeHash(); const sendsBefore = sent.filter((x) => !x.startsWith("GET ")).length;

    // 22. Integrations: test buttons only on the four allowlisted probed cards
    await go("settings/integrations", `!!document.querySelector('.st-provider') && !document.querySelector('#stContent .skeleton-line')`);
    const cards = await evalJs(`[...document.querySelectorAll('.st-provider')].map(c => ({ name: c.querySelector('h4').textContent, button: !!c.querySelector('.st-test button') }))`);
    assert.deepEqual(cards.filter((c) => c.button).map((c) => c.name).sort(), ["Consumer Smart Building API", "Oyi Digital Twin Binding", "Oyi Edge / Backend Control Plane", "Oyi Facility API"], "test buttons exist only on the four allowlisted probes");
    assert.ok(cards.filter((c) => /Website|Email|Storage|Map|WhatsApp|Meta|LinkedIn|Google|Webhook|App Store|Events|CRM/i.test(c.name)).every((c) => !c.button), "website and every config-only service have no test button");
    const clickTest = async (name) => { await evalJs(`[...document.querySelectorAll('.st-provider')].find(c => c.querySelector('h4').textContent === ${JSON.stringify(name)}).querySelector('.st-test button').click()`); await waitFor(`(() => { const c = [...document.querySelectorAll('.st-provider')].find(c => c.querySelector('h4').textContent === ${JSON.stringify(name)}); const t = c.querySelector('.st-test-result').innerText; return t && !/Testing/.test(t); })()`, `${name} result`); return evalJs(`[...document.querySelectorAll('.st-provider')].find(c => c.querySelector('h4').textContent === ${JSON.stringify(name)}).querySelector('.st-test-result').innerText`); };
    const backendText = await clickTest("Oyi Edge / Backend Control Plane"); assert.ok(/Reachable/.test(backendText) && /HTTP 200/.test(backendText) && /ms/.test(backendText), `backend: ${backendText}`);
    const twinText = await clickTest("Oyi Digital Twin Binding"); assert.ok(/Available in-process/.test(twinText) && /No network probe was made/.test(twinText) && !/Reachable/.test(twinText), `twin: ${twinText}`);
    const consumerText = await clickTest("Consumer Smart Building API"); assert.ok(/Not configured/.test(consumerText) && /No request was made/.test(consumerText), `consumer: ${consumerText}`);
    const realBackend = baseConfig.officeBackendBaseUrl; baseConfig.officeBackendBaseUrl = "http://127.0.0.1:1";
    const downText = await clickTest("Oyi Edge / Backend Control Plane"); assert.ok(/Not reachable/.test(downText) && /connection refused/.test(downText), `down backend: ${downText}`); baseConfig.officeBackendBaseUrl = realBackend;
    assert.ok(!(await evalJs(`document.querySelector('.st-page').innerText`)).includes("facility-secret-xyz") && !(await evalJs(`document.querySelector('.st-page').innerText`)).includes(SECRET), "no credential on the page");
    await evalJs(`document.querySelector('.st-test-result').scrollIntoView({ block: "center" })`); await sleep(200);
    await shot("settings-integrations-tests-1440.png");
    console.log("22. Integrations: Test connection only on Backend/Facility/Consumer/Twin; reachable, in-process, not configured and refused are reported truthfully — PASS");

    // 23. Communications: dry-run-only operations
    await go("settings/communications", `!!document.querySelector('.st-op') && !document.querySelector('#stContent .skeleton-line')`);
    const opButtons = await evalJs(`[...document.querySelectorAll('.st-op button')].map(b => b.textContent)`);
    assert.deepEqual(opButtons, ["Run dry-run reconcile", "Run dry-run repair"], "exactly two controls, both dry-run previews");
    const opsCardText = await evalJs(`document.querySelector('.st-op').closest('.st-card').innerText`);
    assert.ok(/available through the administrator API, not from this page/i.test(opsCardText), "the page states that applying changes is not available here");
    assert.equal(await evalJs(`[...document.querySelectorAll('#stContent button')].filter(b => /apply|replay|retry|recover|force|execute|queue now|^run reconcile/i.test(b.textContent)).length`), 0, `no apply, replay, retry or recover control anywhere on Communications: ${await evalJs("[...document.querySelectorAll('#stContent button')].map(b => b.textContent).join('|')")}`);
    await evalJs(`document.querySelectorAll('.st-op button')[0].click()`); await waitFor(`/Nothing was changed/.test(document.querySelectorAll('.st-op-result')[0].innerText)`, "reconcile preview");
    const reconText = await evalJs(`document.querySelectorAll('.st-op-result')[0].innerText`);
    assert.ok(/Dry run/i.test(reconText) && /enforced by the server/i.test(reconText) && /Would be queued/i.test(reconText) && /3/.test(reconText), `reconcile preview: ${reconText}`);
    await evalJs(`document.querySelectorAll('.st-op button')[1].click()`); await waitFor(`/Nothing was changed/.test(document.querySelectorAll('.st-op-result')[1].innerText)`, "repair preview");
    const repairText = await evalJs(`document.querySelectorAll('.st-op-result')[1].innerText`);
    assert.ok(/Missing from CRM activity/i.test(repairText) && !/PRIVATE-TEXT|2348077700055/.test(repairText) && !repairText.includes(seedLead.id), `repair preview shows counts and shortened ids only: ${repairText.slice(0, 200)}`);
    assert.equal(storeHash(), h0, "the previews changed nothing in the store");
    await evalJs(`document.querySelector('.st-op').scrollIntoView({ block: "start" })`); await sleep(200);
    await shot("settings-communications-operations-1440.png");
    // forged request from the browser context: the SERVER refuses to leave dry-run
    const forged = await evalJs(`(async () => { const out = []; for (const body of [{ dry_run: false }, { apply: true }, { dry_run: false, confirm: true, replay: true }]) { const r = await fetch('/api/lead-agents/admin/settings/operations/outbox/reconcile-preview', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); out.push(r.status); } const r2 = await fetch('/api/lead-agents/admin/settings/operations/visibility/repair-preview', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dry_run: false }) }); out.push(r2.status); return out; })()`);
    assert.deepEqual(forged, [400, 400, 400, 400], "forged non-dry-run requests sent from the page are refused by the server");
    assert.equal(storeHash(), h0, "and change nothing"); assert.equal(sent.filter((x) => !x.startsWith("GET ")).length, sendsBefore, "no non-GET request reached the Backend"); assert.equal(deliverySent, 0, "no customer message was sent");
    console.log("23. Communications: two dry-run previews, no apply/replay/retry/recover control, forged browser requests refused server-side, store untouched — PASS");

    // 24. permissions: a settings.manage user without integrations.manage gets no controls and the server agrees
    activeCookie = limitedCookie; await goAs("settings/integrations", `!!document.querySelector('.st-provider') && !document.querySelector('#stContent .skeleton-line')`, true);
    assert.equal(await evalJs(`document.querySelectorAll('.st-test button').length`), 0, "no test buttons without integrations.manage");
    await goAs("settings/communications", `!!document.querySelector('#stContent h2') && !document.querySelector('#stContent .skeleton-line')`);
    assert.equal(await evalJs(`document.querySelectorAll('.st-op button').length`), 0, "no operations controls without integrations.manage"); assert.ok(/administrators/.test(await evalJs(`document.querySelector('#stContent').innerText`)));
    const denied = await evalJs(`(async () => [(await fetch('/api/lead-agents/admin/settings/integrations/backend/test', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })).status, (await fetch('/api/lead-agents/admin/settings/operations/outbox/reconcile-preview', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })).status])()`);
    assert.deepEqual(denied, [403, 403], "the server refuses them regardless of the UI");
    console.log("24. Permission-aware: no controls without integrations.manage and the server returns 403 — PASS");

    // 25. mobile
    activeCookie = superCookie; await viewport(390, 800, true); await goAs("settings/communications", `!!document.querySelector('.st-op') && !document.querySelector('#stContent .skeleton-line')`, true);
    assert.ok(await noOverflow(), "communications operations: no overflow at 390px"); assert.ok(await evalJs(`[...document.querySelectorAll('.st-op .btn')].every(b => b.getBoundingClientRect().height >= 44)`), "preview buttons are 44px targets");
    await evalJs(`document.querySelectorAll('.st-op button')[1].click()`); await waitFor(`/Nothing was changed/.test(document.querySelectorAll('.st-op-result')[1].innerText)`, "mobile preview"); assert.ok(await noOverflow(), "preview result does not overflow");
    await evalJs(`document.querySelector('.st-op').scrollIntoView({ block: "start" })`); await sleep(200);
    await shot("settings-communications-operations-390.png");
    await goAs("settings/integrations", `!!document.querySelector('.st-test') && !document.querySelector('#stContent .skeleton-line')`);
    assert.ok(await noOverflow(), "integrations: no overflow at 390px"); assert.ok(await evalJs(`[...document.querySelectorAll('.st-test .btn')].every(b => b.getBoundingClientRect().height >= 44)`), "test buttons are 44px targets");
    await evalJs(`document.querySelector('.st-test').scrollIntoView({ block: "center" })`); await sleep(200);
    await shot("settings-integrations-tests-390.png");
    console.log("25. Mobile: no overflow, 44px targets for tests and previews — PASS");

    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
    console.log(JSON.stringify({ status: "PASS", suite: "settings-operations-browser" }));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    await chromeHandle.stop();
    for (const s of [server, backendStub]) if (s) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* chrome still flushing its profile */ }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
