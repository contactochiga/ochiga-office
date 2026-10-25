// Real-browser acceptance test for the Office Products workspace (Phase 2 stage 1-2 UI: persistent catalogue table + product editor):
// headless Google Chrome over the DevTools protocol against the real Office server (file store, fixture users and fixture products only).
// Walks the catalogue workflow as different staff members and checks browsing (statistics, search, filters, sorting, pagination),
// in-place selection, permissions and mobile layout. Skips (exit 0) when Chrome is not installed. Screenshots to OFFICE_CAT_SHOTS if set.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
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
const PORT = 9300 + Math.floor(Math.random() * 80);

async function main() {
  if (!CHROME) { console.log("SKIP: Chrome not installed"); return; }
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["cat-browser-key"], allowedOrigins: [], officeBackendBaseUrl: "http://127.0.0.1:1", officeBackendApiKey: "cat-bridge" };
  const { store } = await createTempStore();
  const people = {
    writer: { role: "ochiga_staff", scopes: ["catalogue.write"] },
    staff: { role: "ochiga_staff", scopes: [] },
    editor: { role: "ochiga_staff", scopes: ["catalogue.write", "catalogue.review"] },
    reviewer: { role: "ochiga_staff", scopes: ["catalogue.review"] },
    publisher: { role: "ochiga_staff", scopes: ["catalogue.publish"] },
    pricer: { role: "ochiga_staff", scopes: ["catalogue.price.approve"] },
    finance: { role: "ochiga_staff", scopes: ["catalogue.cost.read", "catalogue.cost.manage"] },
  };
  for (const [name, p] of Object.entries(people)) await store.ensureAdminUser({ email: `${name}@ochiga.local`, password_hash: hashPassword(`${name}-pass-123`), role: p.role, display_name: name, status: "active", permission_scopes: p.scopes });
  const limiter = () => new MemoryRateLimiter({ windowMs: 60000, maxRequests: 50000 });
  const adapter = { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: () => [], isConfigured: () => false, sendTextMessage: async () => ({ delivered: false }), sendTemplateMessage: async () => ({ delivered: false }), listApprovedTemplates: async () => [] };
  const server = buildServer({ config, store, rateLimiter: limiter(), publicRateLimiter: limiter(), officeRateLimiter: limiter(), loginRateLimiter: limiter(), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const inflight = new Map(); let reqSeq = 0;
  server.on("request", (req, res) => { const n = ++reqSeq; inflight.set(n, `${req.method} ${req.url.split("?")[0]}`); res.on("close", () => inflight.delete(n)); });
  const base = `http://127.0.0.1:${await listen(server)}`;
  const cookies = {};
  for (const name of Object.keys(people)) {
    const login = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${name}@ochiga.local`, password: `${name}-pass-123` }) });
    cookies[name] = login.headers.get("set-cookie").split(";")[0].split("=");
  }
  const apiAs = async (name, method, p, body) => { const r = await fetch(`${base}/api/lead-agents/admin/catalogue${p}`, { method, headers: { "content-type": "application/json", cookie: cookies[name].join("="), origin: base }, body: body === undefined ? undefined : JSON.stringify(body) }); return r.json(); };
  const moduleFile = await fetch(`${base}/office/catalogue/catalogue.mjs`);
  assert.equal(moduleFile.status, 200, "the screens module is served (static shell asset)");

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-chrome-"));
  // Chrome's back/forward cache keeps left pages (and their Office realtime streams) alive; with HTTP/1.1's 6-connection limit that stalls the harness
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--disable-features=BackForwardCache", "about:blank"], { stdio: "ignore" });
  let ws, id = 0; const pending = new Map();
  try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await sleep(200); } }
    assert.ok(targets, "Chrome DevTools is reachable");
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
    const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
    const waitFor = async (expr, label, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJs(expr)) return true; } catch { /* navigating */ } await sleep(150); } throw new Error(`timeout waiting for: ${label} (in-flight: ${[...inflight.values()].join(", ")})`); };
    const shot = async (name) => { if (!process.env.OFFICE_CAT_SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(process.env.OFFICE_CAT_SHOTS, name), Buffer.from(r.result.data, "base64")); };
    const as = async (name, hash) => { await send("Network.setCookie", { name: cookies[name][0], value: cookies[name][1], url: base }); await send("Page.navigate", { url: `${base}/office?u=${name}&t=${Date.now()}#/${hash}` }); await sleep(300); };
    const barButtons = () => evalJs(`[...document.querySelectorAll('.cat-actionbar button')].filter((b) => !b.disabled).map((b) => b.textContent.trim())`);
    const fillDialog = (values) => evalJs(`(() => { const f = document.querySelector('.dialog-card'); ${Object.entries(values).map(([k, v]) => `f.querySelector('[name="${k}"]').value = ${JSON.stringify(v)};`).join(" ")} f.requestSubmit(); return true; })()`);
    const click = (selector, text) => evalJs(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.textContent.trim().includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);
    const edTitle = `document.querySelector('.cat-ed-title h2')?.textContent`;
    await send("Page.enable"); await send("Runtime.enable");
    const errors = []; ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); });
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    // 1. writer: empty workspace, Add product dialog -> split view with the new product selected in the table and open in the editor
    await as("writer", "catalogue");
    await waitFor(`!!document.querySelector('.cat-split .cat-empty') && document.querySelectorAll('.cat-stat').length === 4`, "empty workspace with 4 statistics cards");
    assert.ok(await click("button", "Add product"));
    await waitFor(`!!document.querySelector('.dialog-card [name="slug"]')`, "add product dialog");
    await fillDialog({ name: "Oyi Smart Lock", slug: "oyi-smart-lock", model: "SL-100", sku: "SL-100-BLK", variant_name: "Black" });
    await waitFor(`${edTitle} === 'Oyi Smart Lock' && !!document.querySelector('.cat-tr.selected')`, "split view: product selected in table and open in editor");
    const productId = (await evalJs(`location.hash`)).split("/").pop();
    const ratio = await evalJs(`(() => { const l = document.querySelector('.cat-left').getBoundingClientRect().width, r = document.querySelector('.cat-right').getBoundingClientRect().width; return Math.round(100 * l / (l + r)); })()`);
    assert.ok(ratio >= 52 && ratio <= 58, `table/editor proportion about 55/45 (got ${ratio}/${100 - ratio})`);
    assert.deepEqual(await barButtons(), ["Submit for review"], "writer: one primary action (Submit for review); Preview disabled until stage 4");
    console.log(`1. Add product -> persistent table + editor (${ratio}/${100 - ratio}), new draft selected — PASS`);

    // 2. edit through Overview and Specifications, save as a new version
    assert.ok(await click(".cat-card-head button", "Edit"));
    await evalJs(`(() => { const t = document.querySelector('.catalogue-editor [name="description"]'); t.value = 'Fingerprint and PIN smart lock for Oyi homes.'; t.dispatchEvent(new Event('input')); const s = document.querySelector('.catalogue-editor [name="summary"]'); s.value = 'Smart door lock with fingerprint and PIN'; s.dispatchEvent(new Event('input')); return true; })()`);
    assert.ok(await click(".cat-ed-tab", "Specifications"));
    await waitFor(`!!document.querySelector('[data-add-spec]')`, "specifications in edit mode");
    await evalJs(`document.querySelector('[data-add-spec]').click()`);
    await evalJs(`(() => { const rows = document.querySelectorAll('[data-specs] .cat-row'); const row = rows[rows.length - 1]; const set = (sel, v) => { const i = row.querySelector(sel); i.value = v; i.dispatchEvent(new Event('input')); }; set('[data-k]', 'Battery'); set('[data-v]', '4 x AA'); return true; })()`);
    assert.ok(await click(".cat-actionbar button", "Save draft"));
    await waitFor(`/v2/.test(document.querySelector('.cat-ed-title p')?.textContent || '') && document.querySelector('[data-specs] [data-k]')?.value === 'Battery'`, "saved as v2 with the specification");
    await waitFor(`document.querySelector('.cat-tr.selected .cat-prod-text span')?.textContent === 'Smart door lock with fingerprint and PIN'`, "table row refreshed with the new summary");
    console.log("2. Edit (Overview + Specifications) -> Save draft -> v2; table row refreshed — PASS");

    // 3. submit; an author who also reviews is not offered review actions; another reviewer approves; publisher publishes
    assert.ok(await click(".cat-actionbar button", "Submit for review"));
    await waitFor(`/In review/.test(document.querySelector('.cat-ed-title')?.textContent || '')`, "in review");
    const cats = (await apiAs("editor", "GET", "/categories")).categories;
    await apiAs("editor", "POST", "/products", { slug: "editor-own", content: { category_id: cats[0].id, name: "Editor Own Product", variants: [{ sku: "EO-1", name: "x" }] } });
    const own = (await apiAs("editor", "GET", "/products?view=cards&q=EO-1")).products[0];
    await apiAs("editor", "POST", `/products/${own.id}/submit`, { expected_row_version: own.row_version });
    await as("editor", `catalogue/products/${own.id}`);
    await waitFor(`${edTitle} === 'Editor Own Product' && !!document.querySelector('.catalogue-own-change')`, "own-change note");
    assert.ok(!(await barButtons()).includes("Approve"), "an author holding review sees no Approve on their own change");
    await as("reviewer", `catalogue/products/${productId}`);
    await waitFor(`${edTitle} === 'Oyi Smart Lock' && [...document.querySelectorAll('.cat-actionbar button')].some((b) => b.textContent.includes('Approve'))`, "reviewer view");
    assert.ok(await click(".cat-actionbar button", "Approve"));
    await waitFor(`/Approved/.test(document.querySelector('.cat-ed-title')?.textContent || '')`, "approved");
    await as("publisher", `catalogue/products/${productId}`);
    await waitFor(`[...document.querySelectorAll('.cat-actionbar button')].some((b) => b.textContent.includes('Publish (internal)'))`, "publish button");
    assert.ok(await click(".cat-actionbar button", "Publish (internal)"));
    await waitFor(`/Published/.test(document.querySelector('.cat-ed-title')?.textContent || '') && /Published/.test(document.querySelector('.cat-tr.selected')?.textContent || '')`, "published in editor and table");
    console.log("3. Submit -> own-change guard -> reviewer approves -> publisher publishes; table pill updates — PASS");

    // 4. prices through the Pricing & Inventory tab and the approval queue
    await as("writer", `catalogue/products/${productId}`);
    await waitFor(`${edTitle} === 'Oyi Smart Lock'`, "writer product");
    assert.ok(await click(".cat-ed-tab", "Pricing"));
    await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Request price')`, "pricing tab");
    assert.ok(await click("button", "Request price"));
    await waitFor(`!!document.querySelector('.dialog-card [name="price"]')`, "price dialog");
    await fillDialog({ price: "185,000.50", note: "Launch price" });
    await waitFor(`!document.querySelector('.dialog-card')`, "price dialog closed");
    await as("pricer", "catalogue/prices");
    await waitFor(`/₦185,000\\.50/.test(document.querySelector('.catalogue-host')?.textContent || '')`, "price queue");
    assert.ok(await click(".catalogue-host button", "Approve"));
    await waitFor(`![...document.querySelectorAll('.catalogue-host button')].some((b) => b.textContent.trim() === 'Approve')`, "price approved", 15000);
    await as("publisher", "catalogue/prices");
    await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Publish price')`, "publish price", 15000);
    assert.ok(await click("button", "Publish price"));
    await waitFor(`/Published/.test(document.querySelector('.catalogue-host')?.textContent || '')`, "price published");
    console.log("4. Price request -> approval -> publication — PASS");

    // 5. browsing: seed fixture products (clearly fixtures), then statistics, search, filters, sorting, pagination
    for (let i = 1; i <= 13; i += 1) {
      await apiAs("writer", "POST", "/products", { slug: `fixture-product-${String(i).padStart(2, "0")}`, content: { category_id: cats[i % cats.length].id, name: `Fixture Product ${String(i).padStart(2, "0")}`, model: `FX-${i}`, summary: `Fixture item ${i} for list testing`, variants: [{ sku: `FX-${String(i).padStart(3, "0")}`, name: "Standard" }] } });
    }
    await as("writer", "catalogue");
    await waitFor(`document.querySelectorAll('.cat-tr[data-id]').length === 12`, "first page of 12");
    const stats = await evalJs(`[...document.querySelectorAll('.cat-stat b')].map((b) => Number(b.textContent))`);
    assert.deepEqual(stats, [15, 13, 1, 1], `statistics over the whole catalogue: total 15, drafts 13 (fixtures), in review 1 (editor's), published 1 (got ${stats})`);
    assert.ok(/Showing 1–12 of 15 products/.test(await evalJs(`document.querySelector('[data-showing]').textContent`)), "pager text");
    await evalJs(`document.querySelector('.cat-page[data-page="2"]').click()`);
    await waitFor(`document.querySelectorAll('.cat-tr[data-id]').length === 3 && /Showing 13–15 of 15/.test(document.querySelector('[data-showing]').textContent)`, "page 2");
    await evalJs(`(() => { const q = document.querySelector('[data-q]'); q.value = 'FX-007'; q.dispatchEvent(new Event('input')); return true; })()`);
    await waitFor(`document.querySelectorAll('.cat-tr[data-id]').length === 1 && /Fixture Product 07/.test(document.querySelector('.cat-tr[data-id]').textContent)`, "search by SKU");
    await evalJs(`document.querySelector('[data-clear]').click()`);
    await waitFor(`document.querySelectorAll('.cat-tr[data-id]').length === 12`, "cleared");
    await evalJs(`(() => { const s = document.querySelector('[data-f="status"]'); s.value = 'published'; s.dispatchEvent(new Event('change')); return true; })()`);
    await waitFor(`document.querySelectorAll('.cat-tr[data-id]').length === 1 && /Oyi Smart Lock/.test(document.querySelector('.cat-tr[data-id]').textContent)`, "status filter");
    await evalJs(`document.querySelector('[data-clear]').click()`);
    await waitFor(`document.querySelectorAll('.cat-tr[data-id]').length === 12`, "cleared again");
    await evalJs(`document.querySelector('[data-sort="name"]').click()`);
    await waitFor(`/Editor Own Product/.test(document.querySelector('.cat-tr[data-id] .cat-prod-text b')?.textContent || '')`, "sorted by name ascending");
    await evalJs(`document.querySelector('[data-stat="draft"]').click()`);
    await waitFor(`document.querySelectorAll('.cat-tr[data-id]').length === 12 && [...document.querySelectorAll('.cat-tr[data-id]')].every((r) => /Draft/.test(r.textContent))`, "drafts card filters the table");
    await evalJs(`document.querySelector('[data-clear]').click()`);
    console.log("5. Statistics, pagination, search by SKU, status filter, sorting, statistic-card filter — PASS");

    // 6. in-place selection: the table is not re-rendered; the address follows
    await evalJs(`(() => { const q = document.querySelector('[data-q]'); q.value = 'smart'; q.dispatchEvent(new Event('input')); return true; })()`);
    await waitFor(`document.querySelectorAll('.cat-tr[data-id]').length === 1 && /Oyi Smart Lock/.test(document.querySelector('.cat-tr[data-id]').textContent)`, "smart lock found by name");
    await evalJs(`document.querySelector('[data-clear]').click()`);
    await waitFor(`document.querySelectorAll('.cat-tr[data-id]').length === 12`, "list restored");
    await evalJs(`document.querySelector('[data-sort="name"]').click()`); // name descending puts the smart lock on page 1
    await waitFor(`[...document.querySelectorAll('.cat-tr[data-id]')].some((r) => /Oyi Smart Lock/.test(r.textContent))`, "smart lock on the first page");
    await evalJs(`document.querySelector('.cat-left').dataset.marker = 'same'`);
    await evalJs(`[...document.querySelectorAll('.cat-tr[data-id]')].find((r) => /Oyi Smart Lock/.test(r.textContent)).click()`);
    await waitFor(`${edTitle} === 'Oyi Smart Lock' && location.hash === '#/catalogue/products/${productId}'`, "select row in place");
    assert.equal(await evalJs(`document.querySelector('.cat-left').dataset.marker`), "same", "the table stays (no full re-render)");
    await sleep(5500); // let the success toasts clear before the screenshot
    await shot("products-desktop.png");
    console.log("6. Row selection updates editor and address in place — PASS");

    // 7. archive from the editor menu -> Archived is the primary status, read-only
    await as("publisher", `catalogue/products/${productId}`);
    await waitFor(`${edTitle} === 'Oyi Smart Lock'`, "publisher product");
    await evalJs(`window.confirm = () => true; document.querySelector('[data-more]').click()`);
    await waitFor(`!!document.querySelector('.cat-menu')`, "more menu");
    assert.ok(await click(".cat-menu button", "Archive"));
    await waitFor(`document.querySelector('.cat-ed-title .cat-pill')?.textContent === 'Archived' && /Archived — read-only/.test(document.querySelector('.cat-actionbar').textContent)`, "archived as primary status");
    console.log("7. Archive -> 'Archived' primary status, editor read-only — PASS");

    // 8. general staff: read-only
    await as("staff", "catalogue");
    await waitFor(`document.querySelectorAll('.cat-tr[data-id]').length > 0`, "staff list");
    assert.ok(!(await evalJs(`!!document.querySelector('[data-add-product]')`)), "no Add product for general staff");
    await evalJs(`document.querySelector('.cat-tr[data-id]').click()`);
    await waitFor(`!!document.querySelector('.cat-ed-title h2')`, "staff editor");
    assert.ok(await evalJs(`[...document.querySelectorAll('.catalogue-editor input, .catalogue-editor select, .catalogue-editor textarea')].every((i) => i.disabled) && !document.querySelector('[data-edit]')`), "fields read-only, no Edit");
    assert.deepEqual(await barButtons(), [], "no actions for general staff");
    assert.ok(!(await evalJs(`[...document.querySelectorAll('.catalogue-tabs button')].some((b) => /Suppliers/.test(b.textContent))`)), "suppliers hidden");
    console.log("8. General staff: read-only workspace — PASS");

    // 9. finance: suppliers
    await as("finance", "catalogue/suppliers");
    await waitFor(`document.querySelector('.view-heading h1')?.textContent === 'Suppliers'`, "suppliers view");
    assert.ok(await click("button", "Add supplier"));
    await waitFor(`!!document.querySelector('.dialog-card [name="name"]')`, "supplier dialog");
    await fillDialog({ name: "Lagos Locks Ltd", country: "NG" });
    await waitFor(`/Lagos Locks Ltd/.test(document.querySelector('.catalogue-host')?.textContent || '')`, "supplier listed");
    console.log("9. Finance: suppliers — PASS");

    // 10. mobile: list first; tapping opens the editor full width with a back button; no horizontal overflow
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await as("writer", "catalogue");
    await waitFor(`document.querySelectorAll('.cat-tr[data-id]').length > 0 && getComputedStyle(document.querySelector('.cat-right')).display === 'none'`, "mobile list", 15000);
    await shot("products-mobile-list.png");
    const o1 = await evalJs(`document.documentElement.scrollWidth - window.innerWidth`);
    await evalJs(`document.querySelector('.cat-tr[data-id]').click()`);
    await waitFor(`!!document.querySelector('.cat-ed-title h2') && getComputedStyle(document.querySelector('.cat-left')).display === 'none'`, "mobile editor");
    await shot("products-mobile-editor.png");
    const o2 = await evalJs(`document.documentElement.scrollWidth - window.innerWidth`);
    await evalJs(`document.querySelector('.cat-back').click()`);
    await waitFor(`getComputedStyle(document.querySelector('.cat-left')).display !== 'none'`, "mobile back to list");
    assert.ok(o1 <= 1 && o2 <= 1, `no horizontal overflow on mobile (list ${o1}px, editor ${o2}px)`);
    console.log("10. Mobile: list -> editor -> back, no overflow — PASS");

    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
    console.log(JSON.stringify({ status: "PASS", suite: "catalogue-browser", proportion: `${ratio}/${100 - ratio}` }));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* profile flushing */ }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
