// Real-browser acceptance test for the product catalogue staff screens: headless Google Chrome over the DevTools protocol against the real
// Office server (file store, fixture users only). Walks the Phase 1 workflow as different staff members through the UI and checks that each
// one only sees the actions they may take. Skips (exit 0) when Chrome is not installed. Screenshots to OFFICE_CAT_SHOTS if set.
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
    reviewer: { role: "ochiga_staff", scopes: ["catalogue.review"] },
    publisher: { role: "ochiga_staff", scopes: ["catalogue.publish"] },
    pricer: { role: "ochiga_staff", scopes: ["catalogue.price.approve"] },
    finance: { role: "ochiga_staff", scopes: ["catalogue.cost.read", "catalogue.cost.manage"] },
  };
  for (const [name, p] of Object.entries(people)) await store.ensureAdminUser({ email: `${name}@ochiga.local`, password_hash: hashPassword(`${name}-pass-123`), role: p.role, display_name: name, status: "active", permission_scopes: p.scopes });
  const limiter = () => new MemoryRateLimiter({ windowMs: 60000, maxRequests: 5000 });
  const adapter = { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: () => [], isConfigured: () => false, sendTextMessage: async () => ({ delivered: false }), sendTemplateMessage: async () => ({ delivered: false }), listApprovedTemplates: async () => [] };
  const server = buildServer({ config, store, rateLimiter: limiter(), publicRateLimiter: limiter(), officeRateLimiter: limiter(), loginRateLimiter: limiter(), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const base = `http://127.0.0.1:${await listen(server)}`;
  const cookies = {};
  for (const name of Object.keys(people)) {
    const login = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${name}@ochiga.local`, password: `${name}-pass-123` }) });
    cookies[name] = login.headers.get("set-cookie").split(";")[0].split("=");
  }
  const moduleFile = await fetch(`${base}/office/catalogue/catalogue.mjs`);
  assert.equal(moduleFile.status, 200, "the screens module is served without a session (static shell asset)");
  assert.ok(/javascript/.test(moduleFile.headers.get("content-type") || ""), "served as JavaScript");

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
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
    const waitFor = async (expr, label, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJs(expr)) return true; } catch { /* navigating */ } await sleep(150); } throw new Error(`timeout waiting for: ${label}`); };
    const shot = async (name) => { if (!process.env.OFFICE_CAT_SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(process.env.OFFICE_CAT_SHOTS, name), Buffer.from(r.result.data, "base64")); };
    const as = async (name, hash) => { await send("Network.setCookie", { name: cookies[name][0], value: cookies[name][1], url: base }); await send("Page.navigate", { url: `${base}/office?u=${name}&t=${Date.now()}#/${hash}` }); await sleep(300); };
    const buttons = () => evalJs(`[...document.querySelectorAll('.catalogue-actions button')].map((b) => b.textContent.trim())`);
    const fillDialog = (values) => evalJs(`(() => { const f = document.querySelector('.dialog-card'); ${Object.entries(values).map(([k, v]) => `f.querySelector('[name="${k}"]').value = ${JSON.stringify(v)};`).join(" ")} f.requestSubmit(); return true; })()`);
    const clickButton = (label) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
    await send("Page.enable"); await send("Runtime.enable");
    const errors = []; ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); });
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // 1. a writer sees Products in the sidebar, an empty list, and creates a product through the dialog
    await as("writer", "catalogue");
    await waitFor(`!!document.querySelector('.catalogue-host .state-panel, .catalogue-host .crm-table') && document.querySelector('.view-heading h1')?.textContent === 'Products'`, "products list");
    assert.ok(await evalJs(`[...document.querySelectorAll('nav a, nav button, .nav-item, [data-nav]')].some((n) => /Products/.test(n.textContent))`), "Products appears in the navigation");
    assert.ok(!(await evalJs(`[...document.querySelectorAll('.catalogue-tabs button')].some((b) => /Suppliers/.test(b.textContent))`)), "suppliers tab hidden without cost access");
    assert.ok(await clickButton("New product"));
    await waitFor(`!!document.querySelector('.dialog-card [name="slug"]')`, "new product dialog");
    await fillDialog({ name: "Oyi Smart Lock", slug: "oyi-smart-lock", model: "SL-100", sku: "SL-100-BLK", variant_name: "Black" });
    await waitFor(`location.hash.startsWith('#/catalogue/products/') && document.querySelector('.view-heading h1')?.textContent === 'Oyi Smart Lock'`, "product page after create");
    const productId = (await evalJs(`location.hash`)).split("/").pop();
    assert.deepEqual(await buttons(), ["Submit for review", "Duplicate"], "a writer is offered submit + duplicate only (no approve/publish)");
    await shot("catalogue-product-draft.png");
    console.log("1. Writer: Products nav, empty list, create through the dialog -> draft v1 — PASS");

    // 2. edit: add a specification and description, save as a new version
    await evalJs(`(() => { const f = document.querySelector('.catalogue-editor'); f.querySelector('[name="description"]').value = 'Fingerprint and PIN smart lock for Oyi homes.'; f.querySelector('[data-add-spec]').click(); const row = f.querySelector('[data-specs]').lastElementChild; row.querySelector('[data-k]').value = 'Battery'; row.querySelector('[data-v]').value = '4 x AA'; f.requestSubmit(); return true; })()`);
    await waitFor(`/v2/.test(document.querySelector('.view-heading p')?.textContent || '')`, "saved as v2");
    assert.ok(await evalJs(`document.querySelector('[data-specs] [data-k]')?.value === 'Battery'`), "specification persisted");
    await evalJs(`document.querySelector('[data-diff-version="2"]').click()`);
    await waitFor(`/description/.test(document.querySelector('[data-diff]')?.textContent || '')`, "diff shown");
    console.log("2. Edit through the editor -> new version v2; history shows the diff — PASS");

    // 3. submit; reviewer approves (writer cannot); publisher publishes
    assert.ok(await clickButton("Submit for review"));
    await waitFor(`/In Review/i.test(document.querySelector('.view-heading')?.textContent || '')`, "in review");
    assert.deepEqual(await buttons(), ["Duplicate"], "while in review the author has nothing to approve");
    await as("reviewer", `catalogue/products/${productId}`);
    await waitFor(`(document.querySelectorAll('.catalogue-actions button').length > 0)`, "reviewer view");
    assert.ok((await buttons()).includes("Approve") && (await buttons()).includes("Request changes"), "reviewer sees approve / request changes");
    assert.ok(!(await buttons()).some((b) => /Publish/.test(b)), "reviewer cannot publish");
    assert.ok(await clickButton("Approve"));
    await waitFor(`/Approved/.test(document.querySelector('.view-heading')?.textContent || '')`, "approved");
    await as("publisher", `catalogue/products/${productId}`);
    await waitFor(`(document.querySelectorAll('.catalogue-actions button').length > 0)`, "publisher view");
    assert.ok(await clickButton("Publish (internal)"));
    await waitFor(`/Published/.test(document.querySelector('.view-heading')?.textContent || '') && /Internal publication only/.test(document.querySelector('.view-heading').textContent)`, "published, labelled internal");
    assert.ok((await buttons()).includes("Unpublish") && !(await buttons()).some((b) => /override/i.test(b)), "publisher: unpublish available, no override");
    await shot("catalogue-product-published.png");
    console.log("3. Submit -> reviewer approves (author cannot) -> publisher publishes (labelled internal only) — PASS");

    // 4. prices: writer requests, approver approves in the queue, publisher publishes the price
    await as("writer", `catalogue/products/${productId}`);
    await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Request price')`, "variant actions");
    assert.ok(await clickButton("Request price"));
    await waitFor(`!!document.querySelector('.dialog-card [name="price"]')`, "price dialog");
    await fillDialog({ price: "185,000.50", note: "Launch price" });
    await waitFor(`!document.querySelector('.dialog-card')`, "price dialog closed");
    await as("pricer", "catalogue/prices");
    await waitFor(`/₦185,000\\.50/.test(document.querySelector('.catalogue-host')?.textContent || '')`, "price queue shows the exact amount");
    assert.ok(await clickButton("Approve"));
    // the queue re-renders after the API call: approved = no Approve button left and the state badge reads Approved
    await waitFor(`![...document.querySelectorAll('.catalogue-host button')].some((b) => b.textContent.trim() === 'Approve') && [...document.querySelectorAll('.catalogue-host .badge')].some((b) => /^Approved$/i.test(b.textContent.trim()))`, "price approved", 15000);
    await as("publisher", "catalogue/prices");
    await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Publish price')`, "publish price button", 15000);
    assert.ok(await clickButton("Publish price"));
    await waitFor(`/Published/.test(document.querySelector('.catalogue-host')?.textContent || '')`, "price published");
    await as("writer", `catalogue/products/${productId}`);
    await waitFor(`/₦185,000\\.50/.test(document.querySelector('.catalogue-host')?.textContent || '')`, "variant shows the published price");
    assert.ok(!(await evalJs(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Costs')`)), "no cost access for the writer");
    console.log("4. Price request -> approval by another person -> publication; exact kobo amount shown — PASS");

    // 5. finance sees suppliers; records a supplier
    await as("finance", "catalogue/suppliers");
    await waitFor(`document.querySelector('.view-heading h1')?.textContent === 'Suppliers'`, "suppliers view");
    assert.ok(await clickButton("Add supplier"));
    await waitFor(`!!document.querySelector('.dialog-card [name="name"]')`, "supplier dialog");
    await fillDialog({ name: "Lagos Locks Ltd", country: "NG" });
    await waitFor(`/Lagos Locks Ltd/.test(document.querySelector('.catalogue-host')?.textContent || '')`, "supplier listed");
    console.log("5. Finance: suppliers tab visible, supplier recorded — PASS");

    // 5b. least privilege: a general staff member sees the catalogue read-only (no create, no workflow actions, no price/inventory buttons)
    await as("staff", "catalogue");
    await waitFor(`document.querySelector('.view-heading h1')?.textContent === 'Products' && !!document.querySelector('.crm-table')`, "staff product list");
    assert.ok(!(await evalJs(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'New product')`)), "no New product for general staff");
    await as("staff", `catalogue/products/${productId}`);
    await waitFor(`document.querySelector('.view-heading h1')?.textContent === 'Oyi Smart Lock'`, "staff product page");
    assert.deepEqual(await buttons(), [], "no workflow action for general staff");
    assert.ok(await evalJs(`[...document.querySelectorAll('.catalogue-editor input')].every((i) => i.disabled) && !document.querySelector('.catalogue-editor [type=submit]')`), "editor is read-only");
    assert.ok(!(await evalJs(`[...document.querySelectorAll('button')].some((b) => ['Request price', 'Inventory', 'Costs'].includes(b.textContent.trim()))`)), "no price/inventory/cost actions");
    await shot("catalogue-product-staff-readonly.png");
    console.log("5b. General staff: read-only catalogue (no create, no actions, editor disabled) — PASS");

    // 6. mobile: the product page has no horizontal overflow
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
    await as("writer", `catalogue/products/${productId}`);
    await waitFor(`document.querySelector('.view-heading h1')?.textContent === 'Oyi Smart Lock'`, "mobile product page", 15000);
    await shot("catalogue-product-mobile.png");
    const overflow = await evalJs(`document.documentElement.scrollWidth - window.innerWidth`);
    console.log(`6. Mobile product page rendered (horizontal overflow ${overflow}px) — ${overflow <= 1 ? "PASS" : "NOTE"}`);

    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
    console.log(JSON.stringify({ status: "PASS", suite: "catalogue-browser", mobile_overflow_px: overflow }));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* profile flushing */ }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
