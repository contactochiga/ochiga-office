// Real-browser acceptance test for the Settings domain (S1-S2): headless Chrome over the DevTools protocol against the real Office server (file store, fixtures only).
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
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9351", `--user-data-dir=${userDir}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--disable-features=BackForwardCache", "about:blank"], { stdio: "ignore" });
  let ws, id = 0; const pending = new Map(); let deadServer = null; const errors = [];
  try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch("http://127.0.0.1:9351/json")).json(); } catch { await sleep(200); } }
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

    // 1. Overview: three-column composition, 14 domains, tiles, quick actions, real activity
    await go("settings");
    assert.equal(await evalJs(`!!document.querySelector('.sidebar, nav.nav, #sidebar, aside')`), true, "existing application navigation is still present");
    assert.equal(await evalJs(`document.querySelectorAll('.st-nav-item').length`), 14, "all 14 approved domains in the Settings sidebar");
    assert.deepEqual(await evalJs(`[...document.querySelectorAll('.st-nav-item')].map(a => a.getAttribute('href').replace('#/settings/',''))`), SECTION_KEYS, "approved domain set and order");
    assert.equal(await evalJs(`getComputedStyle(document.querySelector('.st-shell')).gridTemplateColumns.split(' ').length`), 2, "settings sidebar + content columns (third column is the app navigation)");
    assert.equal(await evalJs(`document.querySelectorAll('.st-tile').length`), 5, "five system-status tiles");
    assert.equal(await evalJs(`document.querySelectorAll('.st-action').length`), 4, "four quick actions for a super admin");
    assert.ok(await evalJs(`document.querySelector('.st-nav-item.active .st-nav-label').textContent === 'Overview'`), "overview active");
    const overviewText = await evalJs(`document.querySelector('.st-page').innerText`);
    assert.ok(!/operational/i.test(overviewText), "never claims 'operational' (not verifiable from Office)");
    assert.ok(!/12 connected|v1\.0\.0|Contact Support/i.test(overviewText), "no fabricated figures or support links from the reference image");
    assert.ok(/Oyi Intelligence[\s\S]*Reachable/.test(overviewText), "Oyi tile reflects the real Backend health probe (stub answered)");
    assert.ok(/WhatsApp autonomous replies changed/.test(overviewText) && /super@ochiga\.local/.test(overviewText), "Recent Activity shows the genuine audit record");
    const activityText = await evalJs(`document.querySelector('.st-activity').innerText`);
    assert.ok(!/log\s?in|log\s?out|permission\.denied/i.test(activityText), "ordinary login events are excluded from configuration activity");
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(activityText), "no raw internal record ids in activity labels");
    assert.ok((await (await api(superCookie, "/api/lead-agents/admin/audit")).json()).audit.some((e) => /login/i.test(e.action)), "the complete audit trail still contains the login events");
    assert.ok(/Autonomy OFF/.test(overviewText), "autonomy state comes from the server");
    assert.ok(!overviewText.includes(SECRET), "no secret value in the page");
    await shot("settings-overview-desktop.png");
    console.log("1. Overview: sidebar of 14 domains, 5 verified tiles, 4 quick actions, real activity, no fabricated data — PASS");

    // 2. Every domain renders without errors, overflow or secrets
    for (const key of SECTION_KEYS) {
      await go(`settings/${key}`, `document.querySelector('.st-page')?.dataset.section === '${key}' && !document.querySelector('#stContent .skeleton-line')`);
      assert.ok(await evalJs(`document.querySelector('.st-nav-item.active')?.getAttribute('href') === '#/settings/${key}'`), `${key} active in sidebar`);
      assert.ok(await evalJs(`document.querySelector('#stContent h2')?.textContent.length > 0`), `${key} has a heading: ${await evalJs(`document.querySelector('#stContent').innerText.slice(0, 300)`)}`);
      assert.ok(await noOverflow(), `${key}: no horizontal overflow`);
      assert.ok(!(await evalJs(`document.querySelector('.st-page').innerText`)).includes(SECRET), `${key}: no secret`);
    }
    console.log("2. All 14 sections render, are active in the sidebar, and leak no secret — PASS");

    // 3. Unavailable sections are honest and non-interactive
    for (const key of ["automation", "crm", "finance"]) {
      await go(`settings/${key}`, `document.querySelector('.st-page')?.dataset.section === '${key}' && !!document.querySelector('.st-unavailable')`);
      assert.equal(await evalJs(`document.querySelectorAll('#stContent input, #stContent select, #stContent textarea, #stContent button[type=submit]').length`), 0, `${key}: no fake controls`);
    }
    console.log("3. Automation / CRM / Finance are clearly Unavailable with no fake controls — PASS");

    // 4. AI providers: three status cards, no activation, no key entry
    await go("settings/intelligence");
    assert.equal(await evalJs(`document.querySelectorAll('.st-provider').length`), 3, "OpenAI, Gemini, Claude");
    const ai = await evalJs(`document.querySelector('#stContent').innerText`);
    assert.ok(/OpenAI/.test(ai) && /Google Gemini/.test(ai) && /Anthropic Claude/.test(ai) && /USD 0/.test(ai) && /Not qualified/i.test(ai), "provider entries show unqualified state and zero authorised spend");
    assert.equal(await evalJs(`document.querySelectorAll('.st-provider input, .st-provider button, .st-provider a').length`), 0, "provider cards offer no key entry, enable or activation control");
    await shot("settings-intelligence.png");
    console.log("4. AI provider cards: OpenAI/Gemini/Claude shown unqualified, no activation or key entry — PASS");

    // 5. Communications keeps the existing WhatsApp autonomy panel and Backend contract
    await go("settings/communications", `!!document.querySelector('#waAutonomyBanner') && !document.querySelector('#stContent .skeleton-line')`);
    assert.ok(/OFF/.test(await evalJs(`document.querySelector('#waAutonomyBanner').textContent`)), "autonomy banner reports stored OFF");
    assert.ok(await evalJs(`!!document.querySelector('#waAutonomyToggle')`), "admin can still see the autonomy toggle");
    assert.ok(/enforce|report/i.test(await evalJs(`document.querySelector('#stContent').innerText`)), "webhook signature mode shown from the server");
    assert.ok(/Delivery outbox/.test(await evalJs(`document.querySelector('#stContent').innerText`)), "outbox diagnostics visible to an administrator");
    console.log("5. Communications: autonomy panel, signature mode and outbox preserved — PASS");

    // 6. Organization: existing Letterhead contract, validation, server-confirmed save
    await go("settings/organization", `!!document.querySelector('.st-form input[name=tagline]')`);
    assert.ok(await evalJs(`document.querySelector('.st-form button[type=submit]').disabled`), "Save disabled until a change is made");
    await evalJs(`(() => { const f = document.querySelector('.st-form'); const i = f.elements.email; i.value = 'not-an-email'; i.dispatchEvent(new Event('input', {bubbles:true})); f.requestSubmit(); })()`);
    assert.ok(/valid email/.test(await evalJs(`document.querySelector('.st-field-error[data-for=email]').textContent`)), "invalid email is rejected inline");
    assert.equal((await (await api(superCookie, "/api/lead-agents/admin/letterhead-config")).json()).config.email || "", "", "nothing was saved for the invalid value");
    await evalJs(`(() => { const f = document.querySelector('.st-form'); f.elements.email.value = 'hello@ochiga.example'; f.elements.tagline.value = 'Settings S1 test'; f.elements.tagline.dispatchEvent(new Event('input', {bubbles:true})); f.requestSubmit(); })()`);
    await waitFor(`document.querySelector('.st-form-status').textContent === 'Saved.'`, "save confirmed");
    const saved = (await (await api(superCookie, "/api/lead-agents/admin/letterhead-config")).json()).config;
    assert.equal(saved.tagline, "Settings S1 test"); assert.equal(saved.email, "hello@ochiga.example");
    assert.ok(/Settings S1 test/.test(await evalJs(`document.querySelector('.st-preview').innerText`)), "preview reflects values");
    console.log("6. Letterhead: dirty-gated save, inline validation, same PATCH contract, persisted — PASS");

    // 7. Integrations: honest states, no config values, sync dialog
    await go("settings/integrations");
    const integ = await evalJs(`document.querySelector('#stContent').innerText`);
    assert.ok(/Reachable/.test(integ) && /Not configured|Configured, not verified/.test(integ), "mix of probe-backed and configuration-only states");
    assert.ok(!/Operational|Connected\b/.test(integ), "no unverifiable 'Connected/Operational' claim");
    assert.ok(!integ.includes(SECRET) && !/sk-|Bearer /.test(integ), "no credential material");
    await evalJs(`[...document.querySelectorAll('#stContent button')].find(b => b.textContent === 'Sync All').click()`);
    await waitFor(`!!document.querySelector('.st-modal[role=dialog]')`, "confirm dialog opens");
    assert.ok(await evalJs(`document.activeElement.dataset.act === 'cancel'`), "focus moves into the dialog");
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`);
    await waitFor(`!document.querySelector('.st-modal')`, "Escape closes the dialog");
    assert.equal(sent.filter((s) => /sync/i.test(s)).length, 0, "cancelling the dialog triggers no sync");
    console.log("7. Integrations: probe vs configured states, no credentials, accessible confirm dialog — PASS");

    // 8. Search filters domains
    await go("settings");
    await evalJs(`(() => { const i = document.querySelector('#stSearch'); i.value = 'whats'; i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    assert.deepEqual(await evalJs(`[...document.querySelectorAll('.st-nav-item .st-nav-label')].map(n => n.textContent)`), ["Communications"], "search narrows to the matching domain");
    await evalJs(`(() => { const i = document.querySelector('#stSearch'); i.value = 'zzzz'; i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    assert.ok(/No settings match/.test(await evalJs(`document.querySelector('#stNavList').innerText`)), "empty search state");
    console.log("8. Sidebar search filters domains with an empty state — PASS");

    // 9. Permission-aware navigation
    await useCookie(limitedCookie);
    await go("settings");
    const limitedKeys = await evalJs(`[...document.querySelectorAll('.st-nav-item')].map(a => a.getAttribute('href').replace('#/settings/',''))`);
    assert.deepEqual(limitedKeys, ["overview", "organization", "integrations", "communications", "automation", "buildings", "crm", "security", "infrastructure", "system-health"], "domains the user lacks permission for are hidden");
    await go("settings/people", `!!document.querySelector('.st-denied')`);
    assert.ok(/staff\.manage/.test(await evalJs(`document.querySelector('.st-denied').textContent`)), "deep link to a hidden domain shows a denied state naming the permission");
    await go("settings/communications", `!!document.querySelector('#stContent h2') && !document.querySelector('#stContent .skeleton-line')`);
    assert.ok(!(await evalJs(`!!document.querySelector('#waAutonomyToggle')`)), "non-admin gets no autonomy toggle");
    assert.ok(/administrators/.test(await evalJs(`document.querySelector('#stContent').innerText`)), "outbox shows an administrators-only note");
    await useCookie(plainCookie);
    await send("Page.navigate", { url: `${base}/office#/settings` });
    await waitFor(`!!document.querySelector('.state-panel.error')`, "forbidden view for staff without settings.manage");
    assert.equal(await evalJs(`!!document.querySelector('.st-page')`), false, "no Settings UI for users without settings.manage");
    console.log("9. Permission-aware sidebar, denied deep link, non-admin autonomy, no access without settings.manage — PASS");

    // 10. Responsive: tablet and mobile
    await useCookie(superCookie);
    await viewport(900, 900);
    await go("settings");
    assert.equal(await evalJs(`getComputedStyle(document.querySelector('#stNavList')).flexDirection`), "row", "tablet: sidebar becomes a tab strip");
    assert.ok(await noOverflow(), "tablet: no horizontal overflow");
    await shot("settings-overview-tablet.png");
    await viewport(390, 800, true);
    await go("settings", `!!document.querySelector('.st-page')`);
    assert.equal(await evalJs(`getComputedStyle(document.querySelector('.st-main')).display`), "none", "mobile landing shows the section list");
    assert.ok(await evalJs(`document.querySelector('.st-nav-item').getBoundingClientRect().height >= 44`), "touch targets >= 44px");
    assert.ok(await noOverflow(), "mobile landing: no horizontal overflow");
    await shot("settings-landing-mobile.png");
    await evalJs(`document.querySelector('.st-nav-item[href="#/settings/integrations"]').click()`);
    await waitFor(`document.querySelector('.st-page')?.dataset.section === 'integrations' && !document.querySelector('#stContent .skeleton-line')`, "mobile section view");
    assert.equal(await evalJs(`getComputedStyle(document.querySelector('.st-side')).display`), "none", "mobile section view hides the list");
    assert.notEqual(await evalJs(`getComputedStyle(document.querySelector('.st-back')).display`), "none", "back control visible");
    assert.ok(await noOverflow(), "mobile section: no horizontal overflow");
    await shot("settings-integrations-mobile.png");
    await evalJs(`document.querySelector('.st-back').click()`);
    await waitFor(`document.querySelector('.st-page')?.dataset.landing === '1'`, "back to landing");
    await go("settings/organization", `!!document.querySelector('.st-form input[name=tagline]')`);
    assert.ok(await noOverflow(), "mobile letterhead form: no horizontal overflow");
    console.log("10. Tablet tab strip, mobile list/push navigation, 44px targets, no overflow — PASS");

    // 11. Unreachable Backend is reported as such, never as reachable
    const deadConfig = { ...baseConfig, officeBackendBaseUrl: "http://127.0.0.1:1" };
    deadServer = makeServer({ config: deadConfig, store });
    const deadPort = await listen(deadServer), deadBase = `http://127.0.0.1:${deadPort}`;
    const deadCookie = await loginCookie(deadBase, "super@ochiga.local", "super-pass-123");
    await viewport(1440, 900);
    await send("Network.setCookie", { name: deadCookie.name, value: deadCookie.value, url: deadBase });
    await send("Page.navigate", { url: `${deadBase}/office#/settings` });
    await waitFor(`!!document.querySelector('.st-tile') && !document.querySelector('#stContent .skeleton-line')`, "overview against dead backend");
    const deadText = await evalJs(`document.querySelector('.st-page').innerText`);
    assert.ok(/Oyi Intelligence[\s\S]{0,40}Not reachable/.test(deadText), "unreachable Backend shown as Not reachable");
    // the dead server has no injected descriptors, i.e. it is production-shaped: the registry lists the nine governed entries and no editor exists
    await send("Page.navigate", { url: `${deadBase}/office#/settings/security` });
    await waitFor(`!!document.querySelector('.st-reg-table') && !document.querySelector('#stContent .skeleton-line')`, "production-shaped registry card");
    assert.equal(await evalJs(`document.querySelectorAll('.st-reg-editor').length`), 0, "production registry exposes no editable setting yet");
    assert.ok(/9 entries/.test(await evalJs(`document.querySelector('.st-reg-table').closest('.st-card-body').innerText`)), "production registry lists the nine governed entries");
    assert.ok(!/Oyi Intelligence[\s\S]{0,40}Reachable\n/.test(deadText.replace(/Not reachable/g, "")), "never shown as reachable");
    console.log("11. Dead Backend reports Not reachable (no fabricated healthy state) — PASS");

    // 12. G1 tablet tab strip: single-line labels, visible scroll affordances, all sections reachable
    await useCookie(superCookie);
    for (const w of [1100, 900]) {
      await viewport(w, 900); await go("settings");
      assert.ok(await evalJs(`[...document.querySelectorAll('.st-nav-label')].every(l => l.getBoundingClientRect().height < 22)`), `${w}px: no multi-line tab labels`);
      assert.equal(await evalJs(`new Set([...document.querySelectorAll('.st-nav-item')].map(i => Math.round(i.getBoundingClientRect().height))).size`), 1, `${w}px: uniform tab height`);
      assert.equal(await evalJs(`document.querySelector('.st-side').dataset.moreRight`), "1", `${w}px: right scroll affordance shown while sections are off-screen`);
      assert.ok(await evalJs(`getComputedStyle(document.querySelector('.st-scroll-r')).display !== 'none'`), `${w}px: scroll button visible`);
      assert.ok(await noOverflow(), `${w}px: no page overflow`);
    }
    await evalJs(`document.querySelector('.st-scroll-r').click()`);
    await waitFor(`document.querySelector('.st-side').dataset.moreLeft === '1'`, "left affordance after scrolling right");
    await evalJs(`(() => { const l = document.querySelector('#stNavList'); l.scrollLeft = l.scrollWidth; l.dispatchEvent(new Event('scroll')); })()`);
    await waitFor(`document.querySelector('.st-side').dataset.moreRight === '0'`, "right affordance hides at the end");
    await evalJs(`document.querySelector('.st-nav-item[href="#/settings/system-health"]').click()`);
    await waitFor(`document.querySelector('.st-page')?.dataset.section === 'system-health' && !document.querySelector('#stContent .skeleton-line')`, "last section reachable from the strip");
    assert.ok(await evalJs(`(() => { const a = document.querySelector('.st-nav-item.active').getBoundingClientRect(), l = document.querySelector('#stNavList').getBoundingClientRect(); return a.left >= l.left - 1 && a.right <= l.right + 1; })()`), "active tab is scrolled into view");
    console.log("12. Tablet tab strip: single-line labels, scroll affordances, all sections reachable — PASS");

    // 13. G4 denied panel
    await useCookie(limitedCookie); await viewport(1440); await go("settings/people", `!!document.querySelector('.st-denied-panel')`);
    assert.ok(await evalJs(`document.querySelector('.st-denied-panel h2').textContent.includes('access') && document.activeElement.id === 'stDeniedTitle'`), "denied panel has a heading and receives focus");
    assert.ok(await evalJs(`document.querySelector('.st-denied-panel').getAttribute('role') === 'region' && document.querySelector('.st-denied-panel').getAttribute('aria-labelledby') === 'stDeniedTitle'`), "labelled region");
    assert.equal(await evalJs(`document.querySelector('.st-denied-back').getAttribute('href')`), "#/settings", "return navigation");
    assert.ok(await evalJs(`document.querySelector('.st-denied-back').getBoundingClientRect().height >= 44`), "return link is a 44px target");
    assert.ok(/staff\.manage/.test(await evalJs(`document.querySelector('.st-denied-panel').textContent`)), "names the required permission");
    assert.equal(await evalJs(`document.querySelectorAll('#stContent .st-card').length`), 0, "no section data rendered for the denied section");
    assert.equal((await api(limitedCookie, "/api/lead-agents/admin/permissions")).status, 403, "server-side authorization still denies the underlying API");
    await go("settings/not-a-section", `!!document.querySelector('.st-denied-panel')`);
    assert.ok(/not found/i.test(await evalJs(`document.querySelector('.st-denied-panel h2').textContent`)), "unknown section is reported as not found");
    console.log("13. Denied panel: heading, focus, return navigation, server still enforces — PASS");

    // 14. G3 truthful twin status, G6 tile + selected nav, G5 back target, G7 button
    await useCookie(superCookie); await viewport(1440); await go("settings/integrations");
    const twin = await evalJs(`[...document.querySelectorAll('.st-provider')].find(c => /Digital Twin/.test(c.textContent))?.innerText || ''`);
    assert.ok(/Available in-process/.test(twin) && /no network probe/i.test(twin) && !/Reachable/i.test(twin), "same-origin twin is never called reachable");
    const backend = await evalJs(`[...document.querySelectorAll('.st-provider')].find(c => /Backend Control Plane/.test(c.textContent))?.innerText || ''`);
    assert.ok(/Reachable/.test(backend) && /HTTP 200/.test(backend), "a genuine network probe still reads Reachable with its HTTP status");
    await go("settings");
    assert.ok(await evalJs(`[...document.querySelectorAll('.st-tile')].every(t => { const i = t.querySelector('.st-tile-ico').getBoundingClientRect(), n = t.querySelector('.st-tile-name').getBoundingClientRect(); return Math.abs((i.top + i.height / 2) - (n.top + n.height / 2)) < 6 && n.left > i.right - 1; })`), "tile icons sit beside their labels");
    assert.ok(/rgb\(179, 36, 27\)/.test(await evalJs(`getComputedStyle(document.querySelector('.st-nav-item.active')).backgroundImage`)), "selected nav uses the existing Ochiga red token");
    assert.ok(await evalJs(`getComputedStyle(document.querySelector('.st-nav-item.active')).boxShadow.includes('rgb(211, 55, 44)')`), "selected nav keeps the bright-red rule");
    for (const w of [1440, 1100, 900, 768]) { await viewport(w); await go("settings"); assert.ok(await evalJs(`[...document.querySelectorAll('.st-tile-name')].every(n => { const t = n.closest('.st-tile').getBoundingClientRect(), r = n.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(n); const tr = range.getBoundingClientRect(); return n.scrollWidth <= n.clientWidth + 1 && tr.right <= t.right - 4; })`), `${w}px: no tile label overflows its tile or breaks mid-word`); }
    await viewport(1440); await go("settings");
    assert.ok(await evalJs(`[...document.querySelectorAll('.st-tile-name')].every(n => !/\\s$/.test(n.textContent) && Math.round(n.getBoundingClientRect().height) <= 36)`), "tile labels wrap by whole words at most");
    await viewport(390, 800, true); await go("settings/organization", `!!document.querySelector('.st-form')`);
    assert.ok(await evalJs(`(() => { const r = document.querySelector('.st-back').getBoundingClientRect(); return r.height >= 44 && r.width >= 44; })()`), "back link is a 44px target");
    assert.ok(await evalJs(`[...document.querySelectorAll('.st-form-bar .btn, .st-field input')].every(e => e.getBoundingClientRect().height >= 44)`), "form buttons and inputs are 44px targets on mobile");
    await go("settings/integrations");
    assert.ok(await evalJs(`[...document.querySelectorAll('#stContent .btn')].every(e => e.getBoundingClientRect().height >= 44)`), "sync buttons are 44px targets on mobile");
    await go("settings/communications", `!!document.querySelector('#waAutonomyToggle')`);
    assert.ok(await evalJs(`document.querySelector('#waAutonomyToggle').getBoundingClientRect().height >= 44`), "autonomy button is a 44px target on mobile");
    assert.ok(await evalJs(`getComputedStyle(document.querySelector('#waAutonomyToggle')).backgroundColor !== 'rgb(239, 239, 239)'`), "autonomy button no longer renders as the pale default block");
    assert.ok(await noOverflow(), "no overflow");
    console.log("14. Truthful twin status, tile alignment, selected nav, 44px targets, autonomy button styling — PASS");

    assert.equal(sent.filter((s) => !s.startsWith("GET ")).length, 0, "Settings made only read (GET health) calls to the Backend: nothing that could reach customers");
    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
    console.log(JSON.stringify({ status: "PASS", suite: "settings-domain-browser" }));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill();
    for (const s of [server, deadServer, backendStub]) if (s) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* chrome still flushing its profile */ }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
