// Real-browser acceptance test for the Unified CRM Relationship Workspace: headless Google Chrome driven over the DevTools protocol against the real Office server
// (file store, fixture data only). Skips (exit 0) when Chrome is not installed. Writes screenshots to OFFICE_RW_SHOTS if set.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { launchChrome, wrapSend } = require("./lib/browser-harness");
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
  await fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ kind: "message", from: "2348033334444", message_id: "wamid.b.2", message_type: "text", timestamp: String(Math.floor(Date.now() / 1000)), text: "Please call me back about the Abuja plot.", profile_name: "Awaiting Reply" }] }) }); // an unanswered inbound => awaiting-reply indicator
  const waLead = (await store.listLeads()).find((l) => l.whatsapp_phone === "2348011112222");
  const login = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "super@ochiga.local", password: "super-pass-123" }) });
  const [cookieName, cookieValue] = login.headers.get("set-cookie").split(";")[0].split("=");

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-chrome-"));
  const chromeHandle = await launchChrome(CHROME, { userDir, flags: ["--hide-scrollbars"] }); const chrome = chromeHandle.proc;
  let ws, id = 0; const pending = new Map();
  try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${chromeHandle.port}/json`)).json(); } catch { await sleep(200); } }
    assert.ok(targets, "Chrome DevTools is reachable");
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send0 = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
    const send = wrapSend(send0, { label: 'test-relationship-workspace-browser.js' });
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

    // 2b. unknown / pending / rejected manual sends are visible and honest; unknown can be resolved by staff (no resend); no duplicate bubbles
    const mk = async (rid, body, status, extra = {}) => { const c = await store.claimManualSend({ lead_id: waLead.id, actor_email: "super@ochiga.local", client_request_id: rid, channel: "whatsapp", recipient: waLead.whatsapp_phone, body, body_hash: "h".repeat(64) }); await store.updateManualSend(c.record.id, { status, ...extra }); return c.record; };
    await mk("b-pending", "PENDING-MSG", "pending");
    const unknownSend = await mk("b-unknown", "UNKNOWN-MSG", "outcome_unknown", { failure_reason: "ECONNABORTED" });
    await mk("b-rejected", "REJECTED-MSG", "provider_rejected", { provider_response_code: 400 });
    await send("Page.reload"); await sleep(400);
    await waitFor(`document.readyState === 'complete' && !!document.querySelector('#relThreadPane') && document.querySelector('#relThreadPane').textContent.includes('UNKNOWN-MSG')`, "unknown send shown");
    const txt = await evalJs(`document.querySelector('#relThreadPane').textContent`);
    assert.ok(txt.includes("Outcome unknown") && txt.includes("Do not resend"), "unknown outcome indicator");
    assert.ok(txt.includes("Sending — not yet confirmed"), "pending indicator");
    assert.ok(txt.includes("Not sent — WhatsApp refused it"), "rejected indicator");
    assert.equal(await evalJs(`[...document.querySelectorAll('.messages-bubble')].filter((b) => b.textContent.includes('sending the brochure now')).length`), 1, "the accepted reply appears exactly once");
    assert.equal(await evalJs(`document.querySelectorAll('.rel-resolve').length`), 2, "only unresolved sends offer resolution (pending + unknown)");
    await shot("workspace-unknown-outcome-desktop.png");
    await evalJs(`[...document.querySelectorAll('.messages-bubble-row')].find((r) => r.textContent.includes('UNKNOWN-MSG')).querySelector("button[data-r='confirmed_not_sent']").click()`);
    await waitFor(`document.querySelectorAll('.rel-resolve').length === 1`, "resolution applied");
    assert.equal((await store.getManualSend(unknownSend.id)).status, "not_sent");
    assert.ok((await store.listManualSendsForLead(waLead.id)).filter((x) => x.status === "provider_accepted").length >= 1);
    console.log("2b. Pending/unknown/rejected indicators, staff resolution without resending, no duplicate bubbles — PASS");

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
    await send("Page.navigate", { url: `${base}/office#/crm/leads/table` });
    await waitFor(`!!document.querySelector('.crm-tab.active') && !!document.querySelector('.crm-table') && !document.querySelector('.rel-page')`, "classic leads table at #/crm/leads/table");
    console.log("4/16. Contact, organization, opportunity open the workspace; full record and the list view still work — PASS");

    // ---- live refresh: a NEW inbound message must appear in an already-open conversation and inbox without a manual reload ----
    {
      const livePhone = "2348066600001";
      const post = (id, text) => fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ kind: "message", from: livePhone, message_id: id, message_type: "text", timestamp: String(Math.floor(Date.now() / 1000)), text, raw: { id, from: livePhone, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } } }] }) });
      await post("wamid.live.refresh.0", "Opening message"); const liveLead = (await store.listLeads()).find((l) => l.whatsapp_phone === livePhone);
      await store.upsertLeadChannelState(liveLead.id, "whatsapp", { human_status: "human_active", human_owner: "super@ochiga.local", ai_paused: true });
      const injected = await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__RELATIONSHIP_REFRESH_MS = 2000;" }); // tests shorten the interval; the production default is 15 s
      await send("Page.navigate", { url: `${base}/office?live=1#/crm/leads/${liveLead.id}` });
      await waitFor(`!!document.querySelector('#relThreadPane') && document.querySelector('#relThreadPane').textContent.includes('Opening message')`, "live-refresh lead open");
      // a draft being typed must survive a refresh
      await waitFor(`!!document.querySelector('.rel-send textarea')`, "composer available (takeover active)");
      await evalJs(`(() => { const t = document.querySelector('.rel-send textarea'); t.value = 'half-typed reply'; t.focus(); })()`);
      await post("wamid.live.refresh.1", "A brand new inbound message");
      await waitFor(`document.querySelector('#relThreadPane').textContent.includes('A brand new inbound message')`, "the open conversation shows the new inbound message without a reload", 12000);
      await waitFor(`document.querySelector('.rel-row.active .rel-row-preview')?.textContent.includes('A brand new inbound message')`, "the inbox preview refreshed too", 8000);
      assert.equal(await evalJs(`document.querySelector('.rel-send textarea').value`), "half-typed reply", "a refresh keeps the draft the staff member is typing");
      await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected.result.identifier }); await evalJs(`window.__RELATIONSHIP_REFRESH_MS = 0`);
      console.log("12. Live refresh: a new inbound message appears in the open conversation and inbox without reload — PASS");
    }

    // ---- Leads default route: ONE click on CRM -> Leads opens the three-column workspace ----
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const api = (p) => fetch(`${base}/api/lead-agents/admin/crm/relationships${p}`, { headers: { cookie: `${cookieName}=${cookieValue}` } }).then((r) => r.json());
    const inboxNow = (await api("?limit=30")).relationships; const mostRecent = inboxNow[0];
    assert.ok(inboxNow.length >= 2, "fixture has several leads");
    await send("Page.navigate", { url: `${base}/office?fresh=1#/crm/overview` }); // a full page load: no remembered selection
    await waitFor(`[...document.querySelectorAll('.panel-link')].some((b) => /View Leads/.test(b.textContent))`, "CRM Overview rendered");
    await evalJs(`[...document.querySelectorAll('.panel-link')].find((b) => /View Leads/.test(b.textContent)).click()`);
    await waitFor(`!!document.querySelector('.rel-page .rel-bubble-head, .rel-page .rel-card')`, "overview 'View Leads' opens the workspace with a conversation");
    assert.equal(await evalJs(`document.querySelectorAll('.rel-page > div').length`), 3);
    assert.equal(await evalJs(`location.hash`), `#/crm/leads/${mostRecent.lead_id}`, "the most recently active lead is selected and named in the URL");
    assert.ok(await evalJs(`document.querySelector('#relThreadPane').textContent.includes(${JSON.stringify(mostRecent.name)})`), "the centre panel shows the selected customer's conversation");
    assert.ok(await evalJs(`document.querySelector('#relDetailsPane').textContent.includes('Identity')`), "the right panel shows the profile");
    assert.ok(await evalJs(`!document.querySelector('.crm-table')`), "no legacy table on the way");
    await shot("workspace-leads-default-desktop.png");
    // the Leads tab itself (from another CRM section)
    await send("Page.navigate", { url: `${base}/office#/crm/contacts` });
    await waitFor(`!!document.querySelector('.crm-tab[data-crm-tab="leads"]')`, "contacts list tabs");
    await evalJs(`document.querySelector('.crm-tab[data-crm-tab="leads"]').click()`);
    await waitFor(`!!document.querySelector('.rel-page .rel-bubble-head, .rel-page .rel-card')`, "Leads tab opens the workspace in one click");
    assert.equal(await evalJs(`document.querySelector('.crm-tab.active').dataset.crmTab`), "leads");
    assert.equal(await evalJs(`location.hash`), `#/crm/leads/${mostRecent.lead_id}`, "a still-valid earlier selection is kept when returning to Leads");
    // indicators preserved in the inbox rows
    const rowInfo = await evalJs(`(() => { const r = document.querySelector('.rel-row'); return { owner: !!r.querySelector('.rel-row-owner'), badges: r.querySelectorAll('.badge').length, source: !!r.querySelector('.rel-src'), dot: document.querySelectorAll('.rel-dot').length >= 0 }; })()`);
    assert.ok(rowInfo.owner && rowInfo.badges >= 1 && rowInfo.source, "owner, stage/qualification and source indicators are shown");
    assert.ok(await evalJs(`!!document.querySelector('.rel-dot')`), "an unread/awaiting-reply indicator is present for a lead with an unanswered inbound message");
    // clicking another lead changes selection in place (same page element, no table, no full re-render)
    const other = inboxNow.find((r) => r.lead_id !== mostRecent.lead_id);
    await evalJs(`window.__relMarker = document.querySelector('.rel-page'); window.__relMarker.dataset.marker = 'same-node'`);
    await evalJs(`document.querySelector('.rel-row[data-lead="${other.lead_id}"]').click()`);
    await waitFor(`location.hash === '#/crm/leads/${other.lead_id}' && document.querySelector('#relThreadPane').textContent.includes(${JSON.stringify(other.name)})`, "another lead selected");
    assert.equal(await evalJs(`document.querySelector('.rel-page').dataset.marker`), "same-node", "the workspace was not re-rendered or replaced by the table");
    assert.ok(await evalJs(`document.querySelector('.rel-row.active').dataset.lead === '${other.lead_id}'`));
    // Back / Forward
    await evalJs(`history.back()`);
    await waitFor(`location.hash === '#/crm/leads/${mostRecent.lead_id}' && document.querySelector('#relThreadPane').textContent.includes(${JSON.stringify(mostRecent.name)})`, "Back restores the previous lead");
    await evalJs(`history.forward()`);
    await waitFor(`location.hash === '#/crm/leads/${other.lead_id}' && document.querySelector('#relThreadPane').textContent.includes(${JSON.stringify(other.name)})`, "Forward restores the next lead");
    // direct route refresh keeps the deep link
    await send("Page.reload"); await sleep(400); // let the old document go away before polling the new one
    await waitFor(`document.readyState === 'complete' && !!document.querySelector('#relSearch') && location.hash === '#/crm/leads/${other.lead_id}' && !!document.querySelector('.rel-page .rel-bubble-head, .rel-page .rel-card') && document.querySelector('#relThreadPane').textContent.includes(${JSON.stringify(other.name)})`, "refresh keeps the selected lead");
    // search and filters still work
    await evalJs(`(() => { const i = document.querySelector('#relSearch'); i.value = ${JSON.stringify(other.name)}; i.dispatchEvent(new Event('input')); })()`);
    await waitFor(`document.querySelectorAll('.rel-row').length === 1`, "search narrows the inbox");
    await evalJs(`(() => { const i = document.querySelector('#relSearch'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
    await waitFor(`document.querySelectorAll('.rel-row').length >= 2`, "search cleared");
    assert.ok(await evalJs(`document.querySelectorAll('#relStageFilter option').length > 1 && document.querySelectorAll('#relUnitFilter option').length > 1`), "stage and business-unit filters are populated");
    await evalJs(`(() => { const s = document.querySelector('#relUnitFilter'); s.value = 'development'; s.dispatchEvent(new Event('change')); })()`);
    await waitFor(`[...document.querySelectorAll('.rel-row')].length >= 1 && ![...document.querySelectorAll('.rel-row-name')].some((n) => /^2348/.test(n.textContent))`, "business-unit filter applied");
    await evalJs(`(() => { const s = document.querySelector('#relUnitFilter'); s.value = ''; s.dispatchEvent(new Event('change')); })()`);
    // Table view link and the table fallback; table row opens the workspace
    await evalJs(`document.querySelector('#relTableLink').click()`);
    await waitFor(`location.hash === '#/crm/leads/table' && !!document.querySelector('.crm-table') && !document.querySelector('.rel-page')`, "Table view link opens the legacy table");
    await evalJs(`document.querySelector('.crm-row.clickable').click()`);
    await waitFor(`(location.hash.startsWith('#/crm/leads/') && location.hash.length === 48) && !!document.querySelector('.rel-page .rel-bubble-head, .rel-page .rel-card')`, "a table row opens its workspace");
    // classic record
    await send("Page.navigate", { url: `${base}/office#/crm/leads/${other.lead_id}/record` });
    await waitFor(`!!document.querySelector('.detail-section') && !document.querySelector('.rel-page')`, "classic record still at /record");
    // invalid deep link: honest not-found, list still usable, no silent switch
    await send("Page.navigate", { url: `${base}/office#/crm/leads/00000000-0000-4000-8000-000000000000` });
    await waitFor(`!!document.querySelector('.rel-page') && document.querySelector('#relThreadPane').textContent.length > 0 && !document.querySelector('#relThreadPane .rel-bubble-head')`, "invalid lead id");
    assert.equal(await evalJs(`location.hash`), "#/crm/leads/00000000-0000-4000-8000-000000000000", "the URL is not silently rewritten");
    assert.ok(await evalJs(`document.querySelectorAll('.rel-row').length >= 2`), "the lead list stays usable beside the not-found message");
    // Contacts / Organizations / Opportunities unchanged
    await send("Page.navigate", { url: `${base}/office#/crm/contacts/${crm.contact.id}` });
    await waitFor(`!!document.querySelector('.rel-page') && !document.querySelector('#relTableLink')`, "contacts keep their own workspace behaviour");
    await send("Page.navigate", { url: `${base}/office#/crm/contacts` });
    await waitFor(`!!document.querySelector('.crm-table') && !document.querySelector('.rel-page')`, "contacts list unchanged");
    // mobile: the default route shows the inbox first, a tap opens the conversation, Back returns
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
    await send("Page.navigate", { url: `${base}/office#/crm/leads` });
    await waitFor(`!!document.querySelector('.rel-row') && (location.hash.startsWith('#/crm/leads/') && location.hash.length === 48)`, "mobile default route");
    assert.ok(await evalJs(`getComputedStyle(document.querySelector('.rel-list-pane')).display !== 'none' && getComputedStyle(document.querySelector('.rel-thread-pane')).display === 'none'`), "mobile default shows the lead list first");
    await shot("workspace-leads-default-mobile.png");
    await evalJs(`document.querySelector('.rel-row').click()`);
    await waitFor(`getComputedStyle(document.querySelector('.rel-thread-pane')).display !== 'none' && getComputedStyle(document.querySelector('.rel-list-pane')).display === 'none'`, "mobile tap opens the conversation");
    await evalJs(`document.querySelector('.rel-back').click()`);
    assert.ok(await evalJs(`getComputedStyle(document.querySelector('.rel-list-pane')).display !== 'none'`));
    assert.ok(await evalJs(`document.documentElement.scrollWidth <= window.innerWidth + 1`), "no horizontal overflow");
    console.log("18. CRM -> Leads opens the workspace in one click (overview link, tab, deep link, refresh, Back/Forward, table fallback, record, invalid id, filters, mobile) — PASS");

    // ---- empty state: a database with no leads ----
    {
      const emptyStore = (await createTempStore()).store;
      await emptyStore.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super", status: "active" });
      const emptyServer = buildServer({ config, store: emptyStore, rateLimiter: new MemoryRateLimiter({ windowMs: 60000, maxRequests: 5000 }), publicRateLimiter: new MemoryRateLimiter({ windowMs: 60000, maxRequests: 5000 }), officeRateLimiter: new MemoryRateLimiter({ windowMs: 60000, maxRequests: 5000 }), loginRateLimiter: new MemoryRateLimiter({ windowMs: 60000, maxRequests: 100 }), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store: emptyStore, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
      const emptyBase = `http://127.0.0.1:${await listen(emptyServer)}`;
      try {
        const emptyLogin = await fetch(`${emptyBase}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "super@ochiga.local", password: "super-pass-123" }) });
        const [en, ev] = emptyLogin.headers.get("set-cookie").split(";")[0].split("=");
        await send("Network.setCookie", { name: en, value: ev, url: emptyBase });
        await send("Page.navigate", { url: `${emptyBase}/office?empty=1#/crm/leads` });
        await waitFor(`!!document.querySelector('.rel-page') && document.querySelector('#relThreadPane').textContent.includes('No leads yet')`, "empty state");
        assert.equal(await evalJs(`location.hash`), "#/crm/leads", "no lead to name in the URL");
        assert.ok(await evalJs(`document.querySelector('#relThreadPane button')?.textContent.includes('New Lead')`), "empty state offers New Lead to permitted staff");
        console.log("18b. Empty database shows the workspace with an empty state — PASS");
      } finally { emptyServer.closeAllConnections?.(); await new Promise((r) => emptyServer.close(r)); await send("Network.setCookie", { name: cookieName, value: cookieValue, url: base }); }
    }
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
    await chromeHandle.stop(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* chrome still flushing its profile */ }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
