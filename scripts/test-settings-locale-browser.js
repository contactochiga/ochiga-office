// Real-browser acceptance test for the Settings document locale UI (S6.2): headless Chrome over the DevTools protocol against the real Office server (file store, fixtures only).
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
    const send = wrapSend(send0, { label: 'test-settings-locale-browser.js' });
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

    const LKEY = "office_document_locale", LSET = `/api/lead-agents/admin/settings/${LKEY}`;
    const localeCard = `[...document.querySelectorAll('#stContent .st-card')].find(c => c.querySelector('h3').textContent === 'Document locale')`;
    const lForm = `${localeCard}.querySelector('.st-reg-editor')`;
    const pickLocale = (v) => evalJs(`(() => { const f = ${lForm}; f.elements.value.value = ${JSON.stringify(v)}; f.elements.value.dispatchEvent(new Event('change', { bubbles: true })); return !f.querySelector('button[type=submit]').disabled; })()`);
    const sample = () => evalJs(`({ short: ${localeCard}.querySelector('.st-locale-short').textContent, long: ${localeCard}.querySelector('.st-locale-long').textContent })`);
    const intl = (loc) => evalJs(`({ short: new Date().toLocaleDateString(${JSON.stringify(loc)}), long: new Date().toLocaleDateString(${JSON.stringify(loc)}, { day: 'numeric', month: 'long', year: 'numeric' }) })`);
    const genVia = async (over = {}) => { const r = await apiAs(superCookie, "POST", "/api/lead-agents/admin/documents/generate", { title: "Locale UI", document_type: "proposal", recipient: "Client", body: "Hi", ...over }); assert.equal(r.status, 201); const html = await fetch(r.json.document.share_url.replace(/^https?:\/\/[^/]+/, base)).then((x) => x.text()); return { doc: r.json.document, html }; };
    await viewport(1440, 900);

    // 39. placement, default state, supported choices
    await goAs("settings/organization", ORG_READY);
    const order = await evalJs(`[...document.querySelectorAll('#stContent .st-card-head h3')].map(h => h.textContent)`); assert.deepEqual(order.slice(0, 3), ["Company profile", "Document locale", "Corporate Letterhead"], "Document locale sits beneath Company profile");
    assert.equal(await evalJs(`document.querySelector('#stLocaleCurrent').textContent`), "en-NG", "default en-NG"); assert.ok(/0 · default/.test(await evalJs(`document.querySelector('#stLocaleVersion').textContent`)));
    assert.deepEqual(await evalJs(`[...${lForm}.elements.value.options].map(o => o.value)`), ["en-NG", "en-GB", "en-US"], "exactly the three supported locales are selectable"); assert.equal(await evalJs(`${lForm}.elements.value.value`), "en-NG");
    assert.equal(await evalJs(`${lForm}.querySelector('button[type=submit]').disabled`), true, "Save disabled until the selection changes");
    const ng = await intl("en-NG"); assert.deepEqual(await sample(), ng, "the preview shows today's date in the current locale"); assert.ok(/does not change the letterhead|not affected/.test(await evalJs(`${localeCard}.innerText`)), "scope explained: timestamps, scheduling, currency unaffected");
    assert.equal(await evalJs(`document.querySelector('#stBrandCurrent').textContent`), "OCHIGA OFFICE", "the S6.1 brand card still works beside it");
    console.log("39. Organization: Document locale beneath Company profile; default en-NG; exactly three choices; preview in the current locale — PASS");

    // 40. live preview for each locale, Save gating
    const before = await genVia({ template_id: "memo" });
    for (const loc of ["en-US", "en-GB", "en-NG"]) { const dirty = await pickLocale(loc); assert.equal(dirty, loc !== "en-NG", `Save enabled only when ${loc} differs from the saved locale`); assert.deepEqual(await sample(), await intl(loc), `${loc}: preview follows the selection`); }
    assert.ok(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test((await (async () => { await pickLocale("en-US"); return sample(); })()).long), "en-US long date reads 'Month D, YYYY'"); await shot("s6-2-locale-preview-en-US-1440.png");
    console.log("40. Live preview follows each locale and Save is gated on change — PASS");

    // 41. save: server-confirmed, persisted, document round trip, older document unchanged
    await evalJs(`${lForm}.requestSubmit()`); await waitFor(`/Saved\./.test(${lForm}.querySelector('.st-form-status').textContent)`, "locale save confirmed");
    const st = await evalJs(`${lForm}.querySelector('.st-form-status').textContent`); assert.ok(/“en-US”/.test(st) && /version 1/.test(st), `server-confirmed message: ${st}`);
    assert.equal(await evalJs(`document.querySelector('#stLocaleCurrent').textContent`), "en-US"); const stored = (await apiAs(superCookie, "GET", LSET)).json.setting; assert.deepEqual([stored.value, stored.version, stored.updated_by], ["en-US", 1, "super@ochiga.local"]);
    await goAs("settings/organization", ORG_READY); assert.equal(await evalJs(`document.querySelector('#stLocaleCurrent').textContent`), "en-US", "persisted across reload"); assert.equal(await evalJs(`${lForm}.elements.value.value`), "en-US");
    const after = await genVia({ template_id: "memo" }); const usLong = await intl("en-US"); assert.ok(after.html.includes(usLong.long) || /October \d{1,2}, \d{4}|[A-Z][a-z]+ \d{1,2}, \d{4}/.test(after.html), "a document generated after the save carries the en-US date"); assert.deepEqual([after.doc.metadata.document_locale, after.doc.metadata.document_locale_source, after.doc.metadata.document_locale_version], ["en-US", "stored", 1]);
    assert.equal(await fetch(before.doc.share_url.replace(/^https?:\/\/[^/]+/, base)).then((x) => x.text()), before.html, "the document created before the change is byte-identical"); assert.ok(before.html.includes((await intl("en-NG")).long), "…and still carries its en-NG date");
    await evalJs(`${localeCard}.scrollIntoView({ block: "center" })`); await sleep(200); await shot("s6-2-locale-saved-1440.png");
    console.log("41. Save: server-confirmed value and version, persists across reload, new documents carry the en-US date with provenance, older documents unchanged — PASS");

    // 42. version conflict
    assert.equal((await apiAs(limitedCookie, "PUT", LSET, { value: "en-GB", expected_version: 1 })).status, 200, "a second operator saves first");
    await pickLocale("en-NG"); await evalJs(`${lForm}.requestSubmit()`); await waitFor(`!${lForm}.querySelector('.st-conflict').hidden`, "conflict panel");
    const ct = await evalJs(`${lForm}.querySelector('.st-conflict').textContent`); assert.ok(/Not saved/.test(ct) && /en-GB/.test(ct) && /version 2/.test(ct) && /limited@ochiga.local/.test(ct), `conflict panel: ${ct}`); assert.equal((await apiAs(superCookie, "GET", LSET)).json.setting.value, "en-GB", "the stale choice did not overwrite");
    await evalJs(`${lForm}.querySelector('[data-act=reload]').click()`); await sleep(100); assert.equal(await evalJs(`${lForm}.elements.value.value`), "en-GB"); assert.deepEqual(await sample(), await intl("en-GB"), "reload refreshes the selection and the preview");
    await pickLocale("en-NG"); await evalJs(`${lForm}.requestSubmit()`); await waitFor(`/version 3/.test(${lForm}.querySelector('.st-form-status').textContent)`, "save after reload");
    console.log("42. Version conflict: panel names the other operator and current value, stale choice not applied, reload then save succeeds — PASS");

    // 42b. Recent Activity (before the forged attempts below crowd the five-row feed)
    await goAs("settings", `document.querySelectorAll('.st-tile').length === 5 && !document.querySelector('#stContent .skeleton-line')`); const act = await evalJs(`document.querySelector('.st-activity')?.innerText || ''`); assert.ok(/Document locale changed/.test(act) && /en-GB/.test(act) && /en-NG/.test(act), `Recent Activity: ${act.replace(/\n+/g, " | ").slice(0, 400)}`);

    // 43. server rejects what the select can never offer
    const forced = await evalJs(`(async () => { const out = []; for (const value of ['fr-FR', 'EN-US', 'en_US', 'en-US ', '<script>']) { const r = await fetch('${LSET}', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value, expected_version: 3 }) }); out.push([r.status, (await r.json()).error]); } return out; })()`);
    assert.ok(forced.every(([s, e]) => s === 400 && e === "invalid_value"), `forged unsupported locales are refused by the server: ${JSON.stringify(forced)}`); assert.equal((await apiAs(superCookie, "GET", LSET)).json.setting.value, "en-NG");
    await goAs("settings", `document.querySelectorAll('.st-tile').length === 5 && !document.querySelector('#stContent .skeleton-line')`); const actF = await evalJs(`document.querySelector('.st-activity')?.innerText || ''`); const locLines = actF.split("\n").filter((l) => /Document locale/.test(l)); assert.ok(locLines.length >= 1 && locLines.every((l) => /^Not applied: Document locale changed$/.test(l)), `refused attempts are labelled as not applied, never as a change: ${actF.replace(/\n+/g, " | ").slice(0, 300)}`);
    console.log("43. Forged unsupported locales refused server-side; stored value unchanged; the feed words them as 'not applied' — PASS");

    // 44. Security registry read-only row and Recent Activity
    await goAs("settings/security", `!!document.querySelector('.st-reg-table') && !document.querySelector('#stContent .skeleton-line')`);
    const row = await evalJs(`document.querySelector('tr[data-key="${LKEY}"]').innerText`); assert.ok(/Editable in\s+Organization/.test(row) && /Document locale/.test(row) && /en-NG/.test(row), `registry row: ${row}`);
    assert.equal(await evalJs(`document.querySelectorAll('tr[data-key="${LKEY}"] input, tr[data-key="${LKEY}"] select, tr[data-key="${LKEY}"] + tr .st-reg-editor').length`), 0, "no second editor in the Security registry"); assert.equal(await evalJs(`document.querySelector('tr[data-key="${LKEY}"] a.st-link').getAttribute('href')`), "#/settings/organization");
    await shot("s6-2-security-registry-1440.png");
    console.log("44. Security registry: read-only row with an Organization link, no second editor; Recent Activity shows 'Document locale changed' old -> new — PASS");

    // 45. responsive
    for (const w of [1100, 900, 768]) { await viewport(w, 900); await goAs("settings/organization", ORG_READY, true); assert.ok(await noOverflow(), `${w}px: no overflow`); assert.ok((await sample()).short.length > 0); }
    await viewport(390, 800, true); await goAs("settings/organization", ORG_READY, true); assert.ok(await noOverflow(), "390px: no overflow"); assert.ok(await evalJs(`[...${lForm}.querySelectorAll('select, .btn')].every(e => e.getBoundingClientRect().height >= 44)`), "locale select and Save are 44px targets"); await pickLocale("en-US"); assert.ok(await noOverflow());
    await evalJs(`${localeCard}.scrollIntoView({ block: "start" })`); await sleep(200); await shot("s6-2-locale-390.png");
    console.log("45. Responsive 1100/900/768/390: no overflow, 44px targets — PASS");

    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
    console.log(JSON.stringify({ status: "PASS", suite: "settings-locale-browser" }));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    await chromeHandle.stop();
    for (const s of [server, backendStub]) if (s) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* chrome still flushing its profile */ }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
