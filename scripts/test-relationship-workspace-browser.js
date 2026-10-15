// Real-browser acceptance test for the Unified CRM Relationship Workspace: headless Google Chrome driven over the DevTools protocol against the real Office server
// (file store, fixture data only). Skips (exit 0) when Chrome is not installed. Writes screenshots to OFFICE_RW_SHOTS if set.
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
const { findOrUpsertLead, normalizeOfficeIntakeEnvelope, runOfficeIntakeCrm } = require("../src/lead-agents/office-intake");
const { createCorporateRecord } = require("../src/lead-agents/office-operating-system");

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });

async function main() {
  if (!CHROME) { console.log("SKIP: Chrome not installed"); return; }
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["rw-browser-key"], allowedOrigins: [], officeBackendBaseUrl: "http://127.0.0.1:1", officeBackendApiKey: "rw-bridge" };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super", status: "active" });
  const adapter = { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: (b) => b.events || [], isConfigured: () => true, sendTextMessage: async () => ({ delivered: true, external_message_id: "wamid.out.1" }), sendTemplateMessage: async () => ({ delivered: false }), listApprovedTemplates: async () => [] };
  const server = buildServer({ config, store, rateLimiter: new MemoryRateLimiter({ windowMs: 60000, maxRequests: 5000 }), publicRateLimiter: new MemoryRateLimiter({ windowMs: 60000, maxRequests: 5000 }), officeRateLimiter: new MemoryRateLimiter({ windowMs: 60000, maxRequests: 5000 }), loginRateLimiter: new MemoryRateLimiter({ windowMs: 60000, maxRequests: 100 }), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const port = await listen(server), base = `http://127.0.0.1:${port}`;

  // fixtures: a website JV enquiry (form + two opportunities) and a WhatsApp relationship
  const env = normalizeOfficeIntakeEnvelope({ request_id: "rq-b1", source_site: "ochiga_website", source_page: "/development", source_form: "land_jv", business_unit: "development", inquiry_type: "land_jv", contact: { name: "Daniel Tan", email: "daniel@example.com", phone: "+2348099990001" }, organization: { name: "Tan Holdings", location: "Abuja" }, payload: { message: "I would like to explore a joint venture on 5,000 sqm in Abuja." } });
  const { lead: formLead } = await findOrUpsertLead(store, env);
  const crm = await runOfficeIntakeCrm(store, env, formLead, { actorEmail: "fixture" });
  const oppB = await createCorporateRecord(store, "opportunities", { contact_id: crm.contact.id, lead_id: formLead.id, business_unit: "technology", inquiry_type: "building_automation", pipeline: "technology", stage: "intake_received" }, { actorEmail: "fixture" });
  await createCorporateRecord(store, "activities", { lead_id: formLead.id, contact_id: crm.contact.id, opportunity_id: oppB.id, related_type: "opportunity", related_id: oppB.id, activity_type: "note", title: "Automation brief", body: "Customer also wants to automate a building.", actor: "super@ochiga.local" }, { actorEmail: "fixture" });
  await fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ kind: "message", from: "2348011112222", message_id: "wamid.b.1", message_type: "text", timestamp: String(Math.floor(Date.now() / 1000)), text: "Hi, I'm interested in a 5000 sqm land JV opportunity in Batam.", profile_name: "Rizal Ahmad" }] }) });
  const waLead = (await store.listLeads()).find((l) => l.whatsapp_phone === "2348011112222");
  const login = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "super@ochiga.local", password: "super-pass-123" }) });
  const [cookieName, cookieValue] = login.headers.get("set-cookie").split(";")[0].split("=");

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9347", `--user-data-dir=${userDir}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let ws, id = 0; const pending = new Map();
  try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch("http://127.0.0.1:9347/json")).json(); } catch { await sleep(200); } }
    assert.ok(targets, "Chrome DevTools is reachable");
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
    const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
    const waitFor = async (expr, label, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJs(expr)) return true; } catch { /* page navigating */ } await sleep(150); } throw new Error(`timeout waiting for: ${label}`); };
    const shot = async (name) => { if (!process.env.OFFICE_RW_SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(process.env.OFFICE_RW_SHOTS, name), Buffer.from(r.result.data, "base64")); };
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
    const errors = []; ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); });
    await send("Network.setCookie", { name: cookieName, value: cookieValue, url: base });
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // 1. A WhatsApp lead opens the three-column workspace
    await send("Page.navigate", { url: `${base}/office#/crm/leads/${waLead.id}` });
    await waitFor(`!!document.querySelector('.rel-page .rel-bubble-head')`, "WhatsApp thread rendered");
    assert.equal(await evalJs(`document.querySelectorAll('.rel-page > div').length`), 3, "three columns");
    assert.ok(await evalJs(`document.querySelector('#relThreadPane').textContent.includes("interested in a 5000 sqm land JV")`), "the customer's WhatsApp message is in the centre thread");
    assert.ok(await evalJs(`!!document.querySelector('.rel-src-wa')`), "WhatsApp source icon from real metadata");
    assert.ok(await evalJs(`document.querySelector('#relDetailsPane').textContent.includes("Identity")`), "profile column present");
    assert.ok(await evalJs(`document.querySelector('.rel-modeline').textContent.includes("OFF")`), "global OFF status is visible");
    assert.ok(await evalJs(`/Take over/.test(document.querySelector('.rel-locked')?.textContent || "")`), "reply is locked until a human takes over");
    assert.equal(await evalJs(`document.querySelectorAll('.rel-send').length`), 0, "no composer before takeover");
    assert.ok(await evalJs(`document.querySelectorAll('.rel-row').length >= 2`), "inbox lists the other relationships");
    await shot("workspace-whatsapp-desktop.png");
    console.log("1. Lead opens the three-column workspace; WhatsApp message, source icon, OFF status, locked composer — PASS");

    // 2. takeover from the UI enables the composer; send is accepted and shown honestly
    await evalJs(`document.querySelector('.rel-locked button').click()`);
    await waitFor(`!!document.querySelector('.rel-send textarea')`, "composer after takeover");
    await evalJs(`(() => { const ta = document.querySelector('.rel-send textarea'); ta.value = 'Hello Rizal, sending the brochure now.'; document.querySelector('.rel-send').requestSubmit(); })()`);
    await waitFor(`document.querySelector('#relThreadPane').textContent.includes('sending the brochure now')`, "outbound message in thread");
    assert.ok(await evalJs(`document.querySelector('#relThreadPane').textContent.includes('delivery not confirmed')`), "provider acceptance is not displayed as delivered");
    assert.ok(await evalJs(`/Human conversation/.test(document.querySelector('.rel-modeline').textContent)`), "mode switches to human");
    await sleep(5500); // let the toasts clear before measuring/capturing
    const geometry = await evalJs(`(() => { const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; }; return { vh: window.innerHeight, page: r('.rel-page'), composer: r('.rel-composer'), send: r('.rel-send button') }; })()`);
    assert.ok(geometry.composer.bottom <= geometry.vh && geometry.send.bottom <= geometry.vh, `composer fully inside the viewport (${JSON.stringify(geometry)})`);
    assert.ok(await evalJs(`document.querySelector('.rel-send textarea').getBoundingClientRect().width > 150`), "the reply box is actually visible and usable");
    await shot("workspace-takeover-desktop.png");
    console.log("2. Takeover enables the composer; reply shown as 'delivery not confirmed' — PASS");

    // 3. Website form lead: form card, two opportunities, opportunity filter keeps them separate
    await send("Page.navigate", { url: `${base}/office#/crm/leads/${formLead.id}` });
    await waitFor(`!!document.querySelector('.rel-card-form')`, "form card");
    assert.ok(await evalJs(`document.querySelector('.rel-card-form').textContent.includes('joint venture on 5,000 sqm')`), "actual submitted values shown");
    assert.ok(await evalJs(`!!document.querySelector('.rel-src-web')`));
    assert.equal(await evalJs(`document.querySelectorAll('.rel-oppchip').length`), 3, "whole relationship + two opportunities");
    await evalJs(`[...document.querySelectorAll('.rel-oppchip')].find((b) => /Technology/.test(b.textContent)).click()`);
    await waitFor(`document.querySelector('#relThreadPane').textContent.includes('Automation brief')`, "technology opportunity evidence");
    assert.ok(await evalJs(`!document.querySelector('#relThreadPane').textContent.includes('joint venture on 5,000 sqm')`), "the other opportunity's form is not shown under this opportunity");
    await shot("workspace-form-opportunities-desktop.png");
    console.log("3. Website form card; two opportunities stay separate — PASS");

    // 4. Contact, organization and opportunity records open the workspace; full record is still reachable; staff Messages untouched
    await send("Page.navigate", { url: `${base}/office#/crm/contacts/${crm.contact.id}` });
    await waitFor(`!!document.querySelector('.rel-page')`, "contact workspace");
    await send("Page.navigate", { url: `${base}/office#/crm/organizations/${crm.organization.id}` });
    await waitFor(`!!document.querySelector('.rel-page .rel-card-form')`, "organization workspace");
    await send("Page.navigate", { url: `${base}/office#/crm/opportunities/${crm.opportunity.id}` });
    await waitFor(`!!document.querySelector('.rel-page')`, "opportunity workspace");
    await send("Page.navigate", { url: `${base}/office#/crm/leads/${formLead.id}/record` });
    await waitFor(`!!document.querySelector('.detail-section') && !document.querySelector('.rel-page')`, "classic full record view");
    await send("Page.navigate", { url: `${base}/office#/crm/leads` });
    await waitFor(`!!document.querySelector('.crm-tab.active') && !document.querySelector('.rel-page')`, "classic leads list still works");
    console.log("4/16. Contact, organization, opportunity open the workspace; full record and the list view still work — PASS");

    // 5. mobile layout
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
    await send("Page.navigate", { url: `${base}/office#/crm/leads/${waLead.id}` });
    await waitFor(`!!document.querySelector('.rel-page .rel-bubble-head')`, "mobile thread");
    assert.ok(await evalJs(`getComputedStyle(document.querySelector('.rel-list-pane')).display === 'none'`), "mobile shows the thread, list hidden");
    assert.ok(await evalJs(`getComputedStyle(document.querySelector('.rel-back')).display !== 'none'`), "back control available");
    assert.ok(await evalJs(`document.documentElement.scrollWidth <= window.innerWidth + 1`), "no horizontal page overflow on mobile");
    await shot("workspace-thread-mobile.png");
    await evalJs(`document.querySelector('.rel-back').click()`);
    assert.ok(await evalJs(`getComputedStyle(document.querySelector('.rel-list-pane')).display !== 'none'`), "back returns to the inbox");
    await shot("workspace-inbox-mobile.png");
    console.log("17. Mobile: thread view, back to inbox, no horizontal overflow — PASS");

    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
    console.log(JSON.stringify({ status: "PASS", suite: "relationship-workspace-browser" }));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill(); await new Promise((r) => server.close(r)); try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* chrome still flushing its profile */ }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
