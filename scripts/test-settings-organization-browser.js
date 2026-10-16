// Real-browser acceptance test for the Settings Organization UI (S6.1): headless Chrome over the DevTools protocol against the real Office server (file store, fixtures only).
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
    const send = wrapSend(send0, { label: 'test-settings-organization-browser.js' });
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
    const KEY = "office_document_brand_name", SET = `/api/lead-agents/admin/settings/${KEY}`;
    const apiAs = (cookie, method, p, body) => fetch(`${base}${p}`, { method, headers: { "content-type": "application/json", cookie: `${cookie.name}=${cookie.value}` }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null), text: "" }));
    const ORG_READY = `!!document.querySelector('.st-brand-preview') && !!document.querySelector('.st-form input[name=tagline]') && !document.querySelector('#stContent .skeleton-line')`;
    const editorSel = `document.querySelector('.st-reg-editor')`;
    const typeBrand = (v) => evalJs(`(() => { const f = ${editorSel}; f.elements.value.value = ${JSON.stringify(v)}; f.elements.value.dispatchEvent(new Event('input', { bubbles: true })); return !f.querySelector('button[type=submit]').disabled; })()`);
    await viewport(1440, 900);

    // 32. Organization: Company profile card above the Letterhead, default state
    await goAs("settings/organization", ORG_READY);
    const order = await evalJs(`[...document.querySelectorAll('#stContent .st-card-head h3')].map(h => h.textContent)`); assert.deepEqual(order.slice(0, 3), ["Company profile", "Document locale", "Corporate Letterhead"], "Company profile, then Document locale, then the Letterhead");
    assert.equal(await evalJs(`document.querySelector('#stBrandCurrent').textContent`), "OCHIGA OFFICE", "current value = configured default"); assert.ok(/0 · default/.test(await evalJs(`document.querySelector('#stBrandVersion').textContent`)), "never saved: version 0, default");
    assert.equal(await evalJs(`document.querySelector('.st-brand-name').textContent`), "OCHIGA OFFICE", "preview shows the current name"); assert.equal(await evalJs(`document.querySelectorAll('.st-reg-editor').length`), 2, "two governed editors on the page: the brand name (this card) and the document locale (S6.2, beneath it)");
    assert.ok(/not a legal entity name/.test(await evalJs(`document.querySelector('#stContent').innerText`)), "scope is explained: display name, not legal entity");
    assert.equal(await evalJs(`${editorSel}.querySelector('button[type=submit]').disabled`), true, "Save disabled until the value changes");
    // live preview + client-side validation (server stays authoritative)
    assert.equal(await typeBrand("Ochiga & Sons (Nigeria)"), true); assert.equal(await evalJs(`document.querySelector('.st-brand-name').textContent`), "Ochiga & Sons (Nigeria)", "preview follows typing (rendered as text)");
    assert.equal(await typeBrand("<b>Bad</b>"), false, "Save disabled for an invalid value"); assert.ok(/Use letters, numbers, spaces/.test(await evalJs(`${editorSel}.querySelector('.st-field-error').textContent`)), "inline validation message"); assert.equal(await evalJs(`document.querySelector('.st-brand-name').innerHTML`), "&lt;b&gt;Bad&lt;/b&gt;", "the preview escapes what it shows");
    assert.equal(await typeBrand("x".repeat(61)), false); assert.ok(/60 characters/.test(await evalJs(`${editorSel}.querySelector('.st-field-error').textContent`))); assert.equal(await typeBrand("   "), false);
    assert.equal((await apiAs(superCookie, "GET", SET)).json.setting.version, 0, "nothing reached the server");
    await shot("s6-1-organization-invalid-1440.png");
    console.log("32. Organization: Company profile above Letterhead; default state; live escaped preview; inline validation disables Save; server untouched — PASS");

    // 33. save: server-confirmed result, persistence across reload, document round trip
    await typeBrand("Ochiga & Sons (Nigeria)"); await evalJs(`${editorSel}.requestSubmit()`);
    await waitFor(`/Saved\./.test(${editorSel}.querySelector('.st-form-status').textContent)`, "save confirmed");
    const st = await evalJs(`${editorSel}.querySelector('.st-form-status').textContent`); assert.ok(/“Ochiga & Sons \(Nigeria\)”/.test(st) && /version 1/.test(st), `the message reports the server-confirmed value and version: ${st}`);
    assert.equal(await evalJs(`document.querySelector('#stBrandCurrent').textContent`), "Ochiga & Sons (Nigeria)"); assert.ok(/^1 · changed by super@ochiga.local/.test(await evalJs(`document.querySelector('#stBrandVersion').textContent`)));
    const stored = (await apiAs(superCookie, "GET", SET)).json.setting; assert.deepEqual([stored.value, stored.version, stored.updated_by], ["Ochiga & Sons (Nigeria)", 1, "super@ochiga.local"]);
    await goAs("settings/organization", ORG_READY); assert.equal(await evalJs(`document.querySelector('#stBrandCurrent').textContent`), "Ochiga & Sons (Nigeria)", "persisted across a page reload"); assert.equal(await evalJs(`document.querySelector('.st-brand-name').textContent`), "Ochiga & Sons (Nigeria)");
    const gen = await apiAs(superCookie, "POST", "/api/lead-agents/admin/documents/generate", { title: "UI round trip", document_type: "proposal", recipient: "Client", body: "Hi" }); assert.equal(gen.status, 201);
    const html = await fetch(gen.json.document.share_url.replace(/^https?:\/\/[^/]+/, base)).then((r) => r.text()); assert.ok(html.includes('<div class="brand">Ochiga &amp; Sons (Nigeria)</div>'), "a document generated after the UI save carries the new, escaped brand");
    await evalJs(`document.querySelector('#stContent').scrollIntoView()`); await shot("s6-1-organization-saved-1440.png");
    console.log("33. Save: server-confirmed value/version, persisted across reload, new document carries the escaped brand — PASS");

    // 34. version conflict from a second operator
    assert.equal((await apiAs(limitedCookie, "PUT", SET, { value: "Ochiga Group", expected_version: 1 })).status, 200, "a second operator saves first");
    await typeBrand("Ochiga Holdings"); await evalJs(`${editorSel}.requestSubmit()`); await waitFor(`!${editorSel}.querySelector('.st-conflict').hidden`, "conflict panel");
    const ct = await evalJs(`${editorSel}.querySelector('.st-conflict').textContent`); assert.ok(/Not saved/.test(ct) && /Ochiga Group/.test(ct) && /version 2/.test(ct) && /limited@ochiga.local/.test(ct), `conflict panel: ${ct}`);
    assert.equal((await apiAs(superCookie, "GET", SET)).json.setting.value, "Ochiga Group", "the stale edit did not overwrite");
    await evalJs(`${editorSel}.querySelector('[data-act=reload]').click()`); await sleep(100); assert.equal(await evalJs(`${editorSel}.elements.value.value`), "Ochiga Group"); assert.equal(await evalJs(`document.querySelector('.st-brand-name').textContent`), "Ochiga Group", "reload refreshes the field and the preview");
    await typeBrand("Ochiga Holdings"); await evalJs(`${editorSel}.requestSubmit()`); await waitFor(`/version 3/.test(${editorSel}.querySelector('.st-form-status').textContent)`, "save after reload");
    console.log("34. Version conflict: 409 panel names the other operator and current value; stale edit not applied; reload then save succeeds — PASS");

    // 35. server rejects an invalid value even if the client check is bypassed
    const forced = await evalJs(`(async () => { const r = await fetch('${SET}', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: '<img src=x onerror=alert(1)>', expected_version: 3 }) }); return [r.status, (await r.json()).error]; })()`);
    assert.deepEqual(forced, [400, "invalid_value"], "a forged request from the page is refused by the server"); assert.equal((await apiAs(superCookie, "GET", SET)).json.setting.value, "Ochiga Holdings");
    console.log("35. Server-side validation holds when the client check is bypassed — PASS");

    // 36. Security registry: read-only presentation with a link, no second editor
    await goAs("settings/security", `!!document.querySelector('.st-reg-table') && !document.querySelector('#stContent .skeleton-line')`);
    const row = await evalJs(`document.querySelector('tr[data-key="${KEY}"]').innerText`); assert.ok(/Editable in\s+Organization/.test(row) && /Ochiga Holdings/.test(row) && /Document brand name/.test(row), `registry row: ${row}`);
    assert.equal(await evalJs(`document.querySelectorAll('tr[data-key="${KEY}"] input, tr[data-key="${KEY}"] select, tr[data-key="${KEY}"] textarea').length + document.querySelectorAll('tr[data-key="${KEY}"] + tr .st-reg-editor').length`), 0, "no second editor in the Security registry");
    assert.equal(await evalJs(`document.querySelector('tr[data-key="${KEY}"] a.st-link').getAttribute('href')`), "#/settings/organization"); assert.equal(await evalJs(`document.querySelectorAll('.st-reg-editor').length`), 0, "the Security registry offers no editor for any production setting");
    await shot("s6-1-security-registry-1440.png");
    await evalJs(`document.querySelector('tr[data-key="${KEY}"] a.st-link').click()`); await waitFor(`document.querySelector('.st-page')?.dataset.section === 'organization' && !!document.querySelector('.st-brand-preview')`, "link opens Organization");
    // history drill-down shows who changed what
    await goAs("settings/security", `!!document.querySelector('.st-reg-table') && !document.querySelector('#stContent .skeleton-line')`); await evalJs(`document.querySelector('tr[data-key="${KEY}"] [data-act=history]').click()`); await waitFor(`!!document.querySelector('tr[data-key="${KEY}"] + tr .st-history table')`, "history");
    const ht = await evalJs(`document.querySelector('tr[data-key="${KEY}"] + tr .st-history').innerText`); assert.ok(/Success/i.test(ht) && /Conflict/i.test(ht) && /super@ochiga.local/.test(ht) && /limited@ochiga.local/.test(ht), "history shows both operators, successes and the conflict");
    console.log("36. Security registry: read-only row with an Organization link, no second editor, history drill-down — PASS");

    // 37. Overview activity
    await goAs("settings", `document.querySelectorAll('.st-tile').length === 5 && !document.querySelector('#stContent .skeleton-line')`);
    const act = await evalJs(`document.querySelector('.st-activity')?.innerText || ''`); assert.ok(/Document brand name changed/.test(act) && /Ochiga Group/.test(act) && /Ochiga Holdings/.test(act), `Recent Activity: ${act.slice(0, 300)}`);
    console.log("37. Recent Activity shows 'Document brand name changed' with the old and new value — PASS");

    // 38. mobile
    await viewport(390, 800, true); await goAs("settings/organization", ORG_READY, true); assert.ok(await noOverflow(), "no overflow at 390px"); assert.ok(await evalJs(`[...document.querySelectorAll('.st-reg-editor input[type=text], .st-reg-editor .btn')].every(e => e.getBoundingClientRect().height >= 44)`), "editor controls are 44px targets");
    assert.ok(await evalJs(`document.querySelector('.st-brand-preview').getBoundingClientRect().width > 200`), "preview visible"); await typeBrand("Mobile Check"); assert.ok(await noOverflow()); await evalJs(`document.querySelector('.st-brand-preview').scrollIntoView({ block: "center" })`); await sleep(200); await shot("s6-1-organization-390.png");
    for (const w of [1100, 900, 768]) { await viewport(w, 900); await goAs("settings/organization", ORG_READY, true); assert.ok(await noOverflow(), `${w}px: no overflow`); }
    console.log("38. Responsive 1100/900/768/390: no overflow, 44px editor targets — PASS");

    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
    console.log(JSON.stringify({ status: "PASS", suite: "settings-organization-browser" }));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    await chromeHandle.stop();
    for (const s of [server, backendStub]) if (s) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* chrome still flushing its profile */ }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
