// Real-browser acceptance test for the Settings registry UI (S3): headless Chrome over the DevTools protocol against the real Office server (file store, fixtures only).
// Skips (exit 0) when Chrome is not installed. Writes screenshots to OFFICE_ST_SHOTS if set.
const assert = require("node:assert/strict");
const fs = require("node:fs");
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

const UI_EXTRAS = [
  { key: "office.test_threshold", label: "Test threshold", type: "integer", default: 10, owner: "office", mode: "generic", storage: "runtime_settings", read_permission: "office.read", write_permission: "settings.manage", validator: validators.integer({ min: 1, max: 100 }), audit_action: "office_test_threshold_changed" },
  { key: "office.test_banner", label: "Test banner", type: "string", default: "", owner: "office", mode: "generic", storage: "runtime_settings", read_permission: "settings.manage", write_permission: "settings.manage", validator: validators.string({ max: 40 }), requires_confirmation: true, audit_action: "office_test_banner_changed" },
  { key: "office.test_mode", label: "Test mode", type: "enum", choices: ["standard", "strict"], default: "standard", owner: "office", mode: "generic", storage: "runtime_settings", read_permission: "office.read", write_permission: "team.manage", validator: validators.enum(["standard", "strict"]), audit_action: "office_test_mode_changed" },
];
function limiter(max) { return new MemoryRateLimiter({ windowMs: 60000, maxRequests: max }); }
function makeServer({ config, store, extras }) {
  const adapter = { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: (b) => b.events || [], isConfigured: () => true, sendTextMessage: async () => ({ delivered: true }), sendTemplateMessage: async () => ({ delivered: false }), listApprovedTemplates: async () => [] };
  return buildServer({ config, store, rateLimiter: limiter(5000), publicRateLimiter: limiter(5000), officeRateLimiter: limiter(5000), loginRateLimiter: limiter(100), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }), settingsRegistryExtras: extras });
}

async function main() {
  if (!CHROME) { console.log("SKIP: Chrome not installed"); return; }
  const sent = [];
  const backendStub = http.createServer((req, res) => { sent.push(`${req.method} ${req.url}`); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true })); });
  const backendPort = await listen(backendStub);
  const baseConfig = { ...createConfig(), authMode: "required_api_key", apiKeys: ["st-key"], allowedOrigins: [], officeBackendApiKey: SECRET, officeBackendBaseUrl: `http://127.0.0.1:${backendPort}` };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super", status: "active" });
  await store.ensureAdminUser({ email: "limited@ochiga.local", password_hash: hashPassword("limited-pass-123"), role: "ochiga_staff", display_name: "Limited", status: "active", permission_scopes: ["settings.manage"] });
  await store.ensureAdminUser({ email: "plain@ochiga.local", password_hash: hashPassword("plain-pass-123"), role: "ochiga_staff", display_name: "Plain", status: "active" });
  const server = makeServer({ config: baseConfig, store, extras: UI_EXTRAS });
  const port = await listen(server), base = `http://127.0.0.1:${port}`;
  const loginCookie = async (origin, email, password) => { const r = await fetch(`${origin}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }); assert.equal(r.status, 200, `login ${email}`); const [n, v] = r.headers.get("set-cookie").split(";")[0].split("="); return { name: n, value: v }; };
  const superCookie = await loginCookie(base, "super@ochiga.local", "super-pass-123");
  const limitedCookie = await loginCookie(base, "limited@ochiga.local", "limited-pass-123");
  const plainCookie = await loginCookie(base, "plain@ochiga.local", "plain-pass-123");
  const api = (cookie, p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { "content-type": "application/json", cookie: `${cookie.name}=${cookie.value}`, ...(init.headers || {}) } });
  // a real configuration change so Recent Activity has a genuine audit record to show
  assert.equal((await api(superCookie, "/api/lead-agents/admin/settings/whatsapp-autonomy", { method: "PUT", body: JSON.stringify({ enabled: false }) })).status, 200);

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "st-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9352", `--user-data-dir=${userDir}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--disable-features=BackForwardCache", "about:blank"], { stdio: "ignore" });
  let ws, id = 0; const pending = new Map(); let deadServer = null; const errors = [];
  try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch("http://127.0.0.1:9352/json")).json(); } catch { await sleep(200); } }
    assert.ok(targets, "Chrome DevTools is reachable");
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; const t = setTimeout(() => { pending.delete(n); reject(new Error(`CDP call timed out: ${method} ${JSON.stringify(params).slice(0, 160)}`)); }, 20000); pending.set(n, (d) => { clearTimeout(t); resolve(d); }); ws.send(JSON.stringify({ id: n, method, params })); });
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

    // 15-21. S3 registry UI (generic editors exist only when a generic descriptor exists: production ships none, so a test server injects three)
    const regBase = base;
    const regCall = (cookie, method, p, body) => fetch(`${regBase}/api/lead-agents/admin/settings${p}`, { method, headers: { "content-type": "application/json", cookie: `${cookie.name}=${cookie.value}` }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    const goReg = async (hash, ready) => { await send("Network.setCookie", { name: activeCookie.name, value: activeCookie.value, url: regBase }); await evalJs(`document.querySelector('.st-page')?.setAttribute('data-stale','1')`).catch(() => null); const same = await evalJs(`location.hash === '#/${hash}'`).catch(() => false); if (same) await send("Page.reload", { ignoreCache: true }); else await send("Page.navigate", { url: `${regBase}/office#/${hash}` }); await waitFor(ready || `!!document.querySelector('.st-reg-table') && !document.querySelector('#stContent .skeleton-line') && !document.querySelector('.st-page[data-stale]')`, `registry ${hash}`); await sleep(150); };
    let activeCookie = superCookie;
    await viewport(1440, 900);
    assert.equal((await regCall(superCookie, "PUT", "/whatsapp_autonomous_responses_enabled", { value: true, expected_version: 0, confirm: true })).status, 405, "autonomy still cannot be written through the registry");
    await goReg("settings/security");
    const regKeys = await evalJs(`[...document.querySelectorAll('.st-reg-table tbody tr[data-key]')].map(r => r.dataset.key)`);
    for (const k of ["whatsapp_autonomous_responses_enabled", "office_letterhead_config", "whatsapp_webhook_signature_mode", "mirror.backend.bridge", "mirror.facility.bridge", "mirror.consumer.bridge", "mirror.edge.agents", "office.test_threshold", "office.test_banner", "office.test_mode"]) assert.ok(regKeys.includes(k), `registry card lists ${k}`);
    assert.equal(await evalJs(`document.querySelectorAll('.st-reg-editor').length`), 3, "editors exist only for the three generic, writable entries");
    assert.equal(await evalJs(`document.querySelectorAll('tr[data-key^="mirror."] input, tr[data-key^="mirror."] select, tr[data-key="whatsapp_autonomous_responses_enabled"] input, tr[data-key="office_letterhead_config"] input').length`), 0, "no control for mirrors or delegated entries");
    const autonomyRow = await evalJs(`document.querySelector('tr[data-key="whatsapp_autonomous_responses_enabled"]').innerText`);
    assert.ok(/Dedicated endpoint/.test(autonomyRow) && /Communications/.test(autonomyRow) && /OFF/.test(autonomyRow), "autonomy row points to its dedicated section and shows the stored value");
    assert.equal(await evalJs(`document.querySelector('tr[data-key="mirror.backend.bridge"] a, tr[data-key="mirror.backend.bridge"] button') === null || /History/.test(document.querySelector('tr[data-key="mirror.backend.bridge"] button')?.textContent || '') === false`), true, "mirror rows offer no actions");
    assert.ok(!(await evalJs(`document.querySelector('.st-page').innerText`)).includes(SECRET), "no secret on the registry card");
    await shot("settings-registry-1440.png");
    console.log("15. Registry card: governed list with owners/modes, editors only for generic entries, delegated rows point to their own section — PASS");

    const editor = (k) => `document.querySelector('tr[data-key="${k}"] + tr .st-reg-editor')`;
    const setVal = (k, v) => evalJs(`(() => { const f = ${editor(k)}; f.elements.value.value = ${JSON.stringify(String(v))}; f.elements.value.dispatchEvent(new Event('input', {bubbles:true})); return !f.querySelector('button[type=submit]').disabled; })()`);
    const submit = (k) => evalJs(`${editor(k)}.requestSubmit()`);
    assert.equal(await evalJs(`${editor("office.test_threshold")}.querySelector('button[type=submit]').disabled`), true, "Save is disabled until the value changes");
    assert.equal(await setVal("office.test_threshold", 500), true); await submit("office.test_threshold");
    await waitFor(`/Invalid value/.test(${editor("office.test_threshold")}.querySelector('.st-field-error').textContent)`, "server validation error shown");
    assert.equal((await regCall(superCookie, "GET", "/office.test_threshold")).json.setting.value, 10, "invalid value not stored");
    await setVal("office.test_threshold", 42); await submit("office.test_threshold");
    await waitFor(`/Saved\./.test(${editor("office.test_threshold")}.querySelector('.st-form-status').textContent)`, "save confirmed");
    assert.ok(/“42”/.test(await evalJs(`${editor("office.test_threshold")}.querySelector('.st-form-status').textContent`)) && /version 1/.test(await evalJs(`${editor("office.test_threshold")}.querySelector('.st-form-status').textContent`)), "the message reports the server-confirmed value and version");
    assert.equal((await regCall(superCookie, "GET", "/office.test_threshold")).json.setting.value, 42); assert.equal(await evalJs(`document.querySelector('tr[data-key="office.test_threshold"] .st-reg-value').textContent`), "42", "row shows the confirmed value");
    console.log("16. Editor: Save gated on change, server validation error shown and nothing stored, confirmed save reports value + version — PASS");

    // version conflict: another operator changes the value after this page loaded
    assert.equal((await regCall(limitedCookie, "PUT", "/office.test_threshold", { value: 50, expected_version: 1 })).status, 200, "a second operator saves first");
    await setVal("office.test_threshold", 60); await submit("office.test_threshold");
    await waitFor(`!${editor("office.test_threshold")}.querySelector('.st-conflict').hidden`, "conflict panel");
    const conflictText = await evalJs(`${editor("office.test_threshold")}.querySelector('.st-conflict').textContent`);
    assert.ok(/Not saved/.test(conflictText) && /“50”/.test(conflictText) && /version 2/.test(conflictText), "conflict panel names the current stored value and version");
    assert.equal((await regCall(superCookie, "GET", "/office.test_threshold")).json.setting.value, 50, "the stale edit did not overwrite");
    await evalJs(`${editor("office.test_threshold")}.querySelector('[data-act=reload]').click()`);
    assert.equal(await evalJs(`${editor("office.test_threshold")}.elements.value.value`), "50", "Load current value refreshes the form");
    assert.equal(await evalJs(`${editor("office.test_threshold")}.querySelector('button[type=submit]').disabled`), true);
    await setVal("office.test_threshold", 61); await submit("office.test_threshold"); await waitFor(`/version 3/.test(${editor("office.test_threshold")}.querySelector('.st-form-status').textContent)`, "save after reload");
    console.log("17. Version conflict: 409 panel with the current value, stale edit not applied, reload then save succeeds — PASS");

    // confirmation
    await setVal("office.test_banner", "hello"); await submit("office.test_banner");
    assert.ok(/confirmation/i.test(await evalJs(`${editor("office.test_banner")}.querySelector('.st-field-error').textContent`)), "unconfirmed change is blocked in the UI");
    assert.equal((await regCall(superCookie, "GET", "/office.test_banner")).json.setting.version, 0, "and nothing reached the server");
    await evalJs(`${editor("office.test_banner")}.elements.confirm.click()`); await submit("office.test_banner"); await waitFor(`/Saved\./.test(${editor("office.test_banner")}.querySelector('.st-form-status').textContent)`, "confirmed save");
    assert.equal((await regCall(superCookie, "GET", "/office.test_banner")).json.setting.value, "hello");
    console.log("18. Confirmation required for flagged settings (UI guard and server guard) — PASS");

    // history drill-down
    await evalJs(`document.querySelector('tr[data-key="office.test_threshold"] [data-act=history]').click()`);
    await waitFor(`!!document.querySelector('tr[data-key="office.test_threshold"] + tr .st-history table')`, "history table");
    const histText = await evalJs(`document.querySelector('tr[data-key="office.test_threshold"] + tr .st-history').innerText`);
    assert.ok(/success/i.test(histText) && /conflict/i.test(histText) && /super@ochiga\.local/.test(histText), "history shows successes, the conflict and who acted");
    await evalJs(`document.querySelector('tr[data-key="whatsapp_autonomous_responses_enabled"] [data-act=history]').click()`);
    await waitFor(`!!document.querySelector('tr[data-key="whatsapp_autonomous_responses_enabled"] + tr .st-history')`, "autonomy history panel");
    console.log("19. History drill-down shows outcomes, versions and actors — PASS");

    // permission-aware editors
    activeCookie = limitedCookie; await goReg("settings/security");
    assert.deepEqual(await evalJs(`[...document.querySelectorAll('.st-reg-editor')].map(f => f.closest('tr').previousElementSibling.dataset.key).sort()`), ["office.test_banner", "office.test_threshold"], "a settings.manage user gets editors only for entries it may write");
    assert.ok(/Read-only for your role/.test(await evalJs(`document.querySelector('tr[data-key="office.test_mode"]').innerText`)), "the team.manage-gated entry is read-only for them");
    assert.equal((await regCall(limitedCookie, "PUT", "/office.test_mode", { value: "strict", expected_version: 0 })).status, 403, "and the server agrees");
    console.log("20. Permission-aware editors: UI hides what the server would refuse — PASS");

    // mobile
    activeCookie = superCookie; await viewport(390, 800, true); await goReg("settings/security");
    assert.ok(await noOverflow(), "registry card does not overflow the page at 390px");
    assert.ok(await evalJs(`[...document.querySelectorAll('.st-reg-editor select, .st-reg-editor input[type=text], .st-reg-editor input[type=number], .st-reg-editor .btn')].every(e => e.getBoundingClientRect().height >= 44)`), "editor controls are 44px targets on mobile");
    await shot("settings-registry-390.png");
    console.log("21. Registry card is overflow-free with 44px controls on mobile — PASS");

    assert.equal(sent.filter((s) => !s.startsWith("GET ")).length, 0, "Settings made only read (GET health) calls to the Backend: nothing that could reach customers");
    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
    console.log(JSON.stringify({ status: "PASS", suite: "settings-registry-browser" }));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill();
    for (const s of [server, deadServer, backendStub]) if (s) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* chrome still flushing its profile */ }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
