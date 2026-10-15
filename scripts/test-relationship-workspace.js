const assert = require("node:assert/strict");
const http = require("node:http");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { findOrUpsertLead, normalizeOfficeIntakeEnvelope, runOfficeIntakeCrm } = require("../src/lead-agents/office-intake");
const { createCorporateRecord } = require("../src/lead-agents/office-operating-system");
const rw = require("../src/lead-agents/relationship-workspace");

// Unified CRM Relationship Workspace: real HTTP surface + real file store + stubbed Meta adapter. Read model only; nothing here deploys or touches production.
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const close = (server) => new Promise((resolve) => server.close(resolve));

async function main() {
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["rw-test-key"], allowedOrigins: [], officeBackendBaseUrl: "http://127.0.0.1:1", officeBackendApiKey: "rw-bridge" };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super", status: "active" });
  await store.ensureAdminUser({ email: "staff@ochiga.local", password_hash: hashPassword("staff-pass-123"), role: "ochiga_staff", display_name: "Staff", status: "active" });
  await store.ensureAdminUser({ email: "resident@ochiga.local", password_hash: hashPassword("resident-pass-123"), role: "resident", display_name: "Resident", status: "active" });
  const sent = [];
  const adapter = {
    verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: (b) => b.events || [], isConfigured: () => true,
    sendTextMessage: async (m) => { sent.push(m); return { delivered: true, response_code: 200, external_message_id: `wamid.out.${sent.length}` }; },
    sendTemplateMessage: async () => ({ delivered: false }), listApprovedTemplates: async () => [],
  };
  const server = buildServer({
    config, store, rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5000 }), publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5000 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5000 }), loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 100 }),
    whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }),
  });
  const base = `http://127.0.0.1:${await listen(server)}`;
  const login = async (email, password) => { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }); assert.equal(r.status, 200); return r.headers.get("set-cookie").split(";")[0]; };
  const get = (path, cookie) => fetch(`${base}/api/lead-agents/admin/crm/relationships${path}`, { headers: cookie ? { cookie } : {} });
  const json = async (path, cookie) => { const r = await get(path, cookie); assert.equal(r.status, 200, `GET ${path}`); return r.json(); };
  let seq = 0;
  const inbound = async (from, text, id) => {
    const message_id = id || `wamid.in.${++seq}`;
    const r = await fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ kind: "message", from, message_id, message_type: "text", timestamp: String(Math.floor(Date.now() / 1000)), text, profile_name: "Wa Customer" }] }) });
    assert.equal(r.status, 200); return message_id;
  };

  try {
    const sup = await login("super@ochiga.local", "super-pass-123"), staff = await login("staff@ochiga.local", "staff-pass-123"), resident = await login("resident@ochiga.local", "resident-pass-123");

    // access control
    assert.equal((await get("")).status, 401, "unauthenticated is refused");
    assert.equal((await get("", resident)).status, 403, "a role without crm.read is refused");
    assert.equal((await get("/00000000-0000-0000-0000-000000000000", sup)).status, 404);
    console.log("15. Unauthenticated and unauthorised access refused — PASS");

    // website form submission -> form_submission entry, source vs delivery channel preserved
    const env = normalizeOfficeIntakeEnvelope({ request_id: "rq-1", source_site: "ochiga_website", source_page: "/development", source_form: "land_jv", business_unit: "development", inquiry_type: "land_jv", contact: { name: "Daniel", email: "daniel@example.com", phone: "+2348099990001" }, organization: { name: "Daniel Holdings", location: "Abuja" }, payload: { message: "I would like to explore a joint venture.", land_size: "5,000 sqm" } });
    const { lead: formLead } = await findOrUpsertLead(store, env);
    const crm = await runOfficeIntakeCrm(store, env, formLead, { actorEmail: "test" });
    const formThread = await json(`/${formLead.id}`, sup);
    const formEntry = formThread.thread.entries.find((e) => e.kind === "form_submission");
    assert.ok(formEntry, "the form submission is a conversation entry"); assert.equal(formEntry.direction, "inbound"); assert.ok(formEntry.text.length > 0);
    assert.equal(formEntry.provenance.table, "crm_activities");
    assert.equal(formThread.source.original_source.kind, "ochiga_website"); assert.notEqual(formThread.source.original_source.kind, "whatsapp", "no fabricated provider");
    assert.equal(formThread.integrations.email.inbound_sync, "not_connected"); assert.equal(formThread.integrations.linkedin.messaging, "not_connected");
    console.log("5/7. Website form renders as an entry; source icons come from real metadata only — PASS");

    // WhatsApp: chronological, deduplicated across tables, duplicate provider event handled, suppressed reply shown honestly
    const m1 = await inbound("2348011112222", "Hello, I own land in Lekki");
    await new Promise((r) => setTimeout(r, 15)); await inbound("2348011112222", "Can you call me tomorrow?");
    await inbound("2348011112222", "Hello, I own land in Lekki", m1); // Meta retry of the same provider message id
    const waLead = (await store.listLeads()).find((l) => l.whatsapp_phone === "2348011112222");
    assert.ok(waLead, "whatsapp lead exists");
    const waThread = await json(`/${waLead.id}`, sup);
    const msgs = waThread.thread.entries.filter((e) => e.kind === "message");
    assert.equal(msgs.filter((e) => e.text === "Hello, I own land in Lekki").length, 1, "retry of the same provider message produced ONE entry");
    assert.equal(msgs.length, 2, `two distinct inbound messages, activity twins merged (got ${msgs.length})`);
    assert.ok(msgs.every((e) => e.direction === "inbound" && e.channel === "whatsapp"));
    assert.ok(msgs.every((e) => e.provenance.table === "crm_activities" && e.correlation === "single_source"), "with autonomy OFF the CRM activity is the only record of the inbound text and is shown as such");
    assert.equal(waThread.thread.entries.filter((e) => e.event_type === "whatsapp_autonomous_reply_suppressed").length, 0, "the suppression fact is shown once, inline");
    // Evidence-safe correlation (unit level, synthetic rows): records merge ONLY on an authoritative shared identifier.
    const withId = rw.buildThread({ lead: { id: "L" }, conversations: [{ id: "c1", message_role: "user", channel: "whatsapp", external_message_id: "wamid.x", content: "Same text", created_at: "2026-01-01T10:00:00Z" }], activities: [{ id: "a1", activity_type: "whatsapp_message", body: "Same   text", metadata: { direction: "inbound", provider_message_id: "wamid.x" }, occurred_at: "2026-01-01T10:00:02Z" }] });
    assert.equal(withId.entries.length, 1, "exact provider message id => ONE entry"); assert.deepEqual(withId.entries[0].merged_from, [{ table: "crm_activities", id: "a1" }], "provenance of the merged source is kept");
    const noId = rw.buildThread({ lead: { id: "L" }, conversations: [{ id: "c1", message_role: "user", channel: "whatsapp", content: "Same text", created_at: "2026-01-01T10:00:00Z" }], activities: [{ id: "a1", activity_type: "whatsapp_message", body: "Same text", metadata: { direction: "inbound" }, occurred_at: "2026-01-01T10:00:02Z" }] });
    assert.equal(noId.entries.length, 2, "similar text + nearby time WITHOUT shared evidence is NOT merged");
    assert.equal(noId.entries.find((e) => e.provenance.table === "crm_activities").correlation, "uncertain", "the relationship is flagged uncertain, not fabricated");
    const repeated = rw.buildThread({ lead: { id: "L" }, conversations: [{ id: "c1", message_role: "user", channel: "whatsapp", external_message_id: "wamid.1", content: "ok", created_at: "2026-01-01T10:00:00Z" }, { id: "c2", message_role: "user", channel: "whatsapp", external_message_id: "wamid.2", content: "ok", created_at: "2026-01-01T10:00:01Z" }] });
    assert.equal(repeated.entries.length, 2, "two legitimate identical customer messages (different provider ids) stay distinct");
    const sameProviderTwice = rw.buildThread({ lead: { id: "L" }, conversations: [{ id: "c1", message_role: "user", channel: "whatsapp", external_message_id: "wamid.1", content: "ok", created_at: "2026-01-01T10:00:00Z" }, { id: "c2", message_role: "user", channel: "whatsapp", external_message_id: "wamid.1", content: "ok", created_at: "2026-01-01T10:00:09Z" }] });
    assert.equal(sameProviderTwice.entries.length, 1, "one provider event stored twice is one entry"); assert.equal(sameProviderTwice.entries[0].merged_from.length, 1);
    const wrongDirection = rw.buildThread({ lead: { id: "L" }, conversations: [{ id: "c1", message_role: "assistant", channel: "whatsapp", external_message_id: "wamid.1", agent_name: "oyi", content: "ok", created_at: "2026-01-01T10:00:00Z" }], activities: [{ id: "a1", activity_type: "whatsapp_message", body: "ok", metadata: { direction: "inbound", provider_message_id: "wamid.1" }, occurred_at: "2026-01-01T10:00:01Z" }] });
    assert.equal(wrongDirection.entries.length, 2, "an id match across opposite directions is not merged");
    const times = waThread.thread.entries.map((e) => Date.parse(e.occurred_at)); assert.deepEqual(times, [...times].sort((a, b) => a - b), "chronological");
    assert.equal(waThread.source.original_source.kind, "whatsapp");
    assert.equal(waThread.communication.global_autonomous_responses, "off"); assert.equal(waThread.communication.mode, "autonomous_off");
    assert.equal(sent.length, 0, "Global OFF: nothing was sent");
    console.log("6/8/12. WhatsApp thread chronological, duplicates merged, OFF respected, no reply claimed — PASS");

    // inbox: previews, source, unread, search, pagination, filters
    const inbox = await json("?limit=10", sup);
    assert.ok(inbox.relationships.length >= 2); const waRow = inbox.relationships.find((r) => r.lead_id === waLead.id);
    assert.equal(waRow.preview, "Can you call me tomorrow?"); assert.equal(waRow.original_source.kind, "whatsapp"); assert.equal(waRow.unread, true);
    assert.equal((await json("?q=lekki", sup)).relationships.length, 0, "search is over lead fields, not message bodies not held on the lead");
    assert.equal((await json("?q=daniel", sup)).relationships.length, 1);
    assert.equal((await json("?limit=1&offset=1", sup)).relationships.length, 1);
    console.log("7. Inbox list: preview, source, unread, search, offset pagination — PASS");

    // inbox facets and stage / business-unit filters (used by the Leads workspace)
    const facetData = await json("?limit=100", sup);
    assert.ok(facetData.facets.stages.length >= 1 && facetData.facets.business_units.includes("development"), "facets describe the scope");
    const devOnly = await json("?limit=100&business_unit=development", sup); assert.ok(devOnly.relationships.length >= 1 && devOnly.relationships.every((r) => r.business_unit === "development"));
    assert.equal((await json("?limit=100&business_unit=nonexistent", sup)).relationships.length, 0);
    assert.equal((await json("?limit=100&business_unit=development", sup)).facets.business_units.includes("development"), true, "facets stay complete while filtered");
    const stage = facetData.facets.stages[0]; assert.ok((await json(`?limit=100&stage=${encodeURIComponent(stage)}`, sup)).relationships.every((r) => String(r.stage).toLowerCase() === stage.toLowerCase()));
    assert.equal((await json("?limit=100", sup)).relationships[0].last_activity_at >= (await json("?limit=100", sup)).relationships[1].last_activity_at, true, "inbox is ordered by most recent activity (the Leads default selection)");
    console.log("19. Inbox facets, stage / business-unit filters, recency ordering — PASS");

    // contact / organization / opportunity scopes with explicit links only
    const byContact = await json(`?contact_id=${crm.contact.id}`, sup); assert.deepEqual(byContact.relationships.map((r) => r.lead_id), [formLead.id]);
    const otherContact = await createCorporateRecord(store, "contacts", { name: "Unrelated", email: "nobody@example.com" }, { actorEmail: "t" });
    assert.equal((await json(`?contact_id=${otherContact.id}`, sup)).relationships.length, 0, "an unrelated contact never matches by fuzzy name");
    assert.deepEqual((await json(`?organization_id=${crm.organization.id}`, sup)).relationships.map((r) => r.lead_id).sort(), [formLead.id].sort());
    assert.deepEqual((await json(`?opportunity_id=${crm.opportunity.id}`, sup)).relationships.map((r) => r.lead_id), [formLead.id]);
    assert.equal((await get(`?contact_id=${crm.contact.id}`, resident)).status, 403, "scoped views keep the permission gate");
    console.log("2/3. Contact and organization scopes use explicit links only; permission gate kept — PASS");

    // multiple opportunities for one contact stay separate
    const oppB = await createCorporateRecord(store, "opportunities", { contact_id: crm.contact.id, lead_id: formLead.id, business_unit: "technology", inquiry_type: "building_automation", pipeline: "technology", stage: "intake_received" }, { actorEmail: "t" });
    await createCorporateRecord(store, "activities", { lead_id: formLead.id, contact_id: crm.contact.id, opportunity_id: oppB.id, related_type: "opportunity", related_id: oppB.id, activity_type: "note", title: "Automation note", body: "Building automation brief", actor: "staff@ochiga.local" }, { actorEmail: "t" });
    const both = await json(`/${formLead.id}`, sup); assert.equal(both.opportunities.length, 2);
    const onlyB = await json(`/${formLead.id}?opportunity_id=${oppB.id}`, sup);
    assert.ok(onlyB.thread.entries.length === 1 && onlyB.thread.entries[0].text === "Building automation brief", "opportunity B shows only B's evidence");
    const onlyA = await json(`/${formLead.id}?opportunity_id=${crm.opportunity.id}`, sup);
    assert.ok(onlyA.thread.entries.every((e) => e.opportunity_id === crm.opportunity.id) && !onlyA.thread.entries.some((e) => e.text === "Building automation brief"), "A's view does not contain B's evidence");
    assert.ok(onlyA.thread.unlinked_count >= 0);
    console.log("4/15. Opportunity filtering; two opportunities for one contact stay separate — PASS");

    // human takeover + governed manual reply, honest delivery, duplicate guard, permissions
    const noTakeover = await fetch(`${base}/api/lead-agents/admin/leads/${waLead.id}/whatsapp/reply`, { method: "POST", headers: { "content-type": "application/json", cookie: sup }, body: JSON.stringify({ body: "Hi, calling you tomorrow", client_request_id: "r1" }) });
    assert.equal(noTakeover.status, 409); assert.equal(waThread.communication.whatsapp_reply.available, false); assert.equal(waThread.communication.whatsapp_reply.takeover_required, true);
    const afterBlocked = await json(`/${waLead.id}`, sup); assert.equal(afterBlocked.thread.entries.filter((e) => e.direction === "outbound").length, 0, "a refused reply is never shown as sent");
    const takeover = await fetch(`${base}/api/lead-agents/leads/${waLead.id}/channel-state/whatsapp`, { method: "PATCH", headers: { "content-type": "application/json", cookie: sup }, body: JSON.stringify({ human_status: "human_active", human_owner: "super@ochiga.local", ai_paused: true }) });
    assert.equal(takeover.status, 200);
    const tk = await json(`/${waLead.id}`, sup); assert.equal(tk.communication.takeover_active, true); assert.equal(tk.communication.mode, "human"); assert.equal(tk.communication.whatsapp_reply.available, true);
    assert.equal((await json(`/${waLead.id}`, staff)).communication.whatsapp_reply.available, false, "a role without manage_takeover cannot reply");
    const noPerm = await fetch(`${base}/api/lead-agents/admin/leads/${waLead.id}/whatsapp/reply`, { method: "POST", headers: { "content-type": "application/json", cookie: staff }, body: JSON.stringify({ body: "x" }) }); assert.equal(noPerm.status, 403);
    const reply = await fetch(`${base}/api/lead-agents/admin/leads/${waLead.id}/whatsapp/reply`, { method: "POST", headers: { "content-type": "application/json", cookie: sup }, body: JSON.stringify({ body: "Hi, calling you tomorrow", client_request_id: "r2" }) });
    assert.equal(reply.status, 200); assert.equal(sent.length, 1);
    const dup = await fetch(`${base}/api/lead-agents/admin/leads/${waLead.id}/whatsapp/reply`, { method: "POST", headers: { "content-type": "application/json", cookie: sup }, body: JSON.stringify({ body: "Hi, calling you tomorrow", client_request_id: "r2" }) });
    assert.equal(dup.status, 409); assert.equal(sent.length, 1, "duplicate submission was not sent twice");
    const sentThread = await json(`/${waLead.id}`, sup); const out = sentThread.thread.entries.find((e) => e.direction === "outbound");
    assert.ok(out && out.text === "Hi, calling you tomorrow" && out.origin === "human" && out.sender === "super@ochiga.local");
    assert.equal(out.delivery.state, "unverified", "provider acceptance is not delivery: no verified status yet"); assert.equal(out.delivery.verified, false);
    await store.appendInboundEvent({ channel: "whatsapp", provider: "meta", event_type: "status:delivered", external_event_id: "wamid.out.1", payload: {} });
    const delivered = (await json(`/${waLead.id}`, sup)).thread.entries.find((e) => e.direction === "outbound"); assert.equal(delivered.delivery.state, "delivered"); assert.equal(delivered.delivery.verified, true);
    assert.ok((await store.listAuditEvents(500)).some((e) => e.action === "communication.whatsapp.manual_reply"), "manual reply audited");
    console.log("13/14/9. Takeover, manual-reply permissions, duplicate guard, honest delivery state, audit — PASS");

    // staff messages are isolated
    const staffConversation = await store.createStaffConversation({ type: "direct", title: "private", createdBy: "super@ochiga.local", participantEmails: ["super@ochiga.local", "staff@ochiga.local"] });
    await store.createStaffMessage({ conversationId: staffConversation.id, senderEmail: "super@ochiga.local", body: "PRIVATE-STAFF-ONLY-TEXT", attachments: [] });
    const everything = JSON.stringify([await json("?limit=100", sup), await json(`/${waLead.id}`, sup), await json(`/${formLead.id}`, sup)]);
    assert.ok(!everything.includes("PRIVATE-STAFF-ONLY-TEXT"), "staff-only messages never appear in the relationship workspace");
    console.log("10. Staff Messages remain isolated — PASS");

    // attachments: authorization + no public URLs
    await store.createOfficeDocument({ id: "doc-rel-1", title: "Company Profile", document_type: "profile", status: "draft", owner: "super@ochiga.local", related_type: "lead", related_id: formLead.id, file_url: "https://private.example/secret.pdf", html_url: "https://private.example/secret.html", share_token: "SECRET-SHARE-TOKEN" });
    const withDoc = await json(`/${formLead.id}`, sup); const att = withDoc.thread.entries.find((e) => e.kind === "attachment");
    assert.ok(att && att.attachments[0].open_route === "documents/doc-rel-1"); const raw = JSON.stringify(withDoc);
    assert.ok(!raw.includes("private.example") && !raw.includes("SECRET-SHARE-TOKEN"), "no public file URL or share token is exposed");
    console.log("11. Attachments listed without public URLs; opened through the authenticated Documents workspace — PASS");

    // pagination of a large thread
    for (let i = 0; i < 120; i++) await store.appendConversation({ lead_id: formLead.id, agent_name: "oyi", message_role: i % 2 ? "assistant" : "user", channel: "website", content: `bulk ${String(i).padStart(3, "0")}` });
    const p1 = (await json(`/${formLead.id}?limit=50`, sup)).thread; assert.equal(p1.entries.length, 50); assert.equal(p1.has_more, true);
    const p2 = (await json(`/${formLead.id}?limit=50&before=${encodeURIComponent(p1.next_before)}`, sup)).thread;
    const ids1 = new Set(p1.entries.map((e) => e.id)); assert.ok(p2.entries.every((e) => !ids1.has(e.id)), "pages do not overlap");
    assert.ok(Date.parse(p2.entries[p2.entries.length - 1].occurred_at) <= Date.parse(p1.entries[0].occurred_at), "the second page is older");
    assert.equal(p1.entries.length + p2.entries.length <= p1.total, true);
    const search = (await json(`/${formLead.id}?q=bulk%20007`, sup)).thread; assert.equal(search.entries.length, 1, "a conversation message is shown once (its timeline mirror is not duplicated)");
    console.log("17. Large threads paginate by cursor without overlap; thread search works — PASS");

    // read-model unit checks
    assert.equal(rw.classifySource("linkedin").kind, "linkedin"); assert.equal(rw.classifySource("").kind, "unknown"); assert.equal(rw.classifySource("totally_new").kind, "other");
    assert.equal(rw.leadSourceInfo({ source: "ochiga_website:general_contact", primary_channel: "whatsapp" }).original_source.kind, "ochiga_website", "original source and delivery channel are kept apart");
    assert.equal(rw.leadSourceInfo({ source: "ochiga_website:general_contact", primary_channel: "whatsapp" }).delivery_channel.kind, "whatsapp");
    console.log("7. Source classification never invents providers; source and channel are separate — PASS");
    console.log(JSON.stringify({ status: "PASS", suite: "relationship-workspace" }));
  } finally {
    await close(server);
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
