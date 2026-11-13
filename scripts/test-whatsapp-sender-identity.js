// WhatsApp sender identity, Phase 1 (Office). Real HTTP webhook, the real WhatsAppCloudAdapter extraction on Meta-documented payloads (contacts[].user_id,
// messages[].from_user_id, entry[].id), real file store, autonomy ON and a stubbed Backend. Proves:
//   * OFF by default, and OFF never touches identity storage;
//   * phone-based lead matching, replies, the Office -> Backend payload, opt-outs, goal deferral and duplicate handling are unchanged with capture ON;
//   * a BSUID arriving with a phone is linked to the phone-matched lead, once, also under duplicate and concurrent delivery;
//   * conflicting associations are never merged, overwritten or reassigned -- recorded once for human review;
//   * BSUID-only messages, invalid / parent / inconsistent ids and a missing business account are never linked; a BSUID is never used as a phone;
//   * a storage failure never affects intake; the status endpoint is admin-only and shows counts only.
// No network beyond 127.0.0.1, no Meta, nothing sent to any BSUID.
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { WhatsAppCloudAdapter } = require("../src/lead-agents/whatsapp");
const identity = require("../src/lead-agents/whatsapp-sender-identity");

let checks = 0;
const ok = (cond, name) => { assert.ok(cond, name); checks += 1; console.log("PASS " + name); };
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const close = (server) => new Promise((resolve) => server.close(resolve));

const WABA = "102290129340398";
const ts = () => String(Math.floor(Date.now() / 1000));
// Meta-documented shapes: contacts[].user_id + wa_id, messages[].from_user_id; wa_id / from omitted for BSUID-only senders
const msg = ({ id, phone, bsuid, contactBsuid, body = "Hello", type = "text", waba = WABA, parent }) => ({
  object: "whatsapp_business_account",
  entry: [{ id: waba, changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "pnid", display_phone_number: "2348000000000" },
    contacts: [{ profile: { name: "Ada" }, ...(phone ? { wa_id: phone } : {}), ...(contactBsuid !== undefined ? { user_id: contactBsuid } : bsuid ? { user_id: bsuid } : {}), ...(parent ? { parent_user_id: parent } : {}) }],
    messages: [{ ...(phone ? { from: phone } : {}), ...(bsuid ? { from_user_id: bsuid } : {}), ...(parent ? { from_parent_user_id: parent } : {}), id, timestamp: ts(), type, ...(type === "text" ? { text: { body } } : {}) }],
  } }] }],
});

function unitChecks() {
  const prev = process.env.OFFICE_WHATSAPP_SENDER_ID_CAPTURE_ENABLED;
  delete process.env.OFFICE_WHATSAPP_SENDER_ID_CAPTURE_ENABLED;
  ok(createConfig().whatsappSenderIdCaptureEnabled === false && !identity.captureEnabled(createConfig()), "switch: OFF by default");
  if (prev !== undefined) process.env.OFFICE_WHATSAPP_SENDER_ID_CAPTURE_ENABLED = prev;
  const id = (message, contacts, account = WABA) => identity.senderIdentityFromMessage({ message, contacts, businessAccountId: account });
  ok(id({ from: "2348011111111", from_user_id: "US.13491208655302741918" }, []).business_scoped_user_id === "US.13491208655302741918", "fields: messages[].from_user_id");
  ok(id({ from: "2348011111111" }, [{ wa_id: "2348011111111", user_id: "NG.1234567890" }]).business_scoped_user_id === "NG.1234567890", "fields: contacts[].user_id for this sender (wa_id match)");
  ok(id({}, [{ user_id: "NG.1234567890" }]).business_scoped_user_id === "NG.1234567890", "fields: the only contact's user_id when there is no phone");
  ok(id({ from_user_id: "NG.111" }, [{ user_id: "NG.222" }]).reason === "inconsistent_user_ids", "fields: message and contact disagree -> nothing used");
  ok(["US.ENT.11815799212886844830", "us.123", "2348011111111", "NG.", "NG.12-34", `NG.${"1".repeat(129)}`, 12345].every((v) => id({ from_user_id: v }, []).business_scoped_user_id === null), "format: parent BSUIDs, lowercase, phone numbers, empty, punctuation, over-long and non-strings are rejected");
  ok(id({ from_user_id: "NG.123" }, [], "waba").reason === "missing_business_account" && id({ from_user_id: "NG.123" }, [], null).reason === "missing_business_account", "scope: no business account id -> nothing used");
  ok(id({ from: "2348011111111" }, []).reason === "absent", "phone-only sender: no identity");
  ok(identity.looksLikeBusinessScopedId("US.13491208655302741918") && identity.looksLikeBusinessScopedId("US.ENT.1") && !identity.looksLikeBusinessScopedId("2348011111111") && !identity.looksLikeBusinessScopedId("+234 801"), "guard: BSUID-shaped values are recognised, phone numbers are not");
  const adapter = new WhatsAppCloudAdapter({ whatsappAccessToken: "x", whatsappPhoneNumberId: "p" });
  const [e] = adapter.extractEvents({ entry: [{ id: WABA, changes: [{ value: { contacts: [], messages: [{ from: "US.13491208655302741918", id: "w1", type: "text", text: { body: "x" } }] } }] }] });
  ok(e.from === "" && e.from !== "13491208655302741918", "guard: a BSUID in `from` is never normalized into digits and used as a phone");
  const [s] = adapter.extractEvents({ entry: [{ id: WABA, changes: [{ value: { statuses: [{ id: "w2", recipient_id: "US.13491208655302741918", status: "delivered" }] } }] }] });
  ok(s.recipient_id === "", "guard: same for a status recipient");
}

async function main() {
  unitChecks();

  const bodies = [];
  let optedOutPhones = new Set(), goalActive = false;
  const backend = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/office/communications/webhook-event") {
        const b = JSON.parse(raw); bodies.push(b);
        if (!b.from) return res.end(JSON.stringify({ ok: false, reason: "missing_sender" })); // production Backend behaviour
        const out = optedOutPhones.has(b.from);
        return res.end(JSON.stringify({ ok: true, goal_active: goalActive, opted_out: out, opt_out_status: out ? "opted_out" : "not_opted_out" }));
      }
      if (req.url === "/office/conversation/corporate") return res.end(JSON.stringify({ ok: true, answer: "Thanks.", conversation_thread_id: "t" }));
      res.statusCode = 404; res.end("{}");
    });
  });
  const backendPort = await listen(backend);

  async function boot(enabled, storeOverride) {
    const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["identity-test-key"], allowedOrigins: [], officeBackendBaseUrl: `http://127.0.0.1:${backendPort}`, officeBackendApiKey: "k", whatsappAccessToken: "test-token-not-real", whatsappPhoneNumberId: "pnid", whatsappVerifyToken: "verify", metaAppSecret: "", whatsappSenderIdCaptureEnabled: enabled };
    const { store } = await createTempStore();
    const effective = storeOverride ? storeOverride(store) : store;
    await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super", status: "active" });
    await store.ensureAdminUser({ email: "staff@ochiga.local", password_hash: hashPassword("staff-pass-123"), role: "ochiga_staff", display_name: "Staff", status: "active" });
    const adapter = new WhatsAppCloudAdapter(config);
    const sent = [];
    adapter.verifySignature = () => ({ ok: true, reason: null });
    adapter.sendTextMessage = async (m) => { sent.push(m); return { delivered: true, response_code: 200, external_message_id: `wamid.out.${sent.length}` }; };
    const server = buildServer({
      config, store: effective,
      rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }), publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
      officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }), loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 50 }),
      whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store: effective, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }),
    });
    const base = `http://127.0.0.1:${await listen(server)}`;
    const login = async (email, password) => (await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) })).headers.get("set-cookie").split(";")[0];
    const superCookie = await login("super@ochiga.local", "super-pass-123");
    const staffCookie = await login("staff@ochiga.local", "staff-pass-123");
    assert.equal((await fetch(`${base}/api/lead-agents/admin/settings/whatsapp-autonomy`, { method: "PUT", headers: { "content-type": "application/json", cookie: superCookie }, body: JSON.stringify({ enabled: true }) })).status, 200);
    const post = async (body) => { const r = await fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); assert.equal(r.status, 200); return (await r.json()).results; };
    const leadByPhone = async (phone) => (await store.listLeads()).find((l) => l.whatsapp_phone === phone);
    return { store, server, base, sent, superCookie, staffCookie, post, deliver: async (o) => (await post(msg(o)))[0], leadByPhone, rows: () => store.state.whatsapp_sender_identities };
  }
  const shape = (b) => JSON.stringify(Object.keys(b).sort()) + `|from=${b.from}|text=${b.text}|type=${b.message_type}`;

  // ---- OFF (default): identity storage never touched; behaviour identical
  const calls = [];
  const off = await boot(false, (store) => new Proxy(store, { get(target, prop) { if (String(prop).includes("WhatsAppSenderIdentit")) return (...a) => { calls.push(prop); return target[prop](...a); }; const v = target[prop]; return typeof v === "function" ? v.bind(target) : v; } }));
  let offShape;
  try {
    const r = await off.deliver({ id: "wamid.off.1", phone: "2348010000001", bsuid: "NG.1000000001" });
    offShape = shape(bodies.at(-1));
    ok(calls.length === 0 && off.rows().length === 0 && r.outbound && off.sent.length === 1 && off.sent[0].to === "2348010000001", "OFF: no identity reads or writes; the message is matched by phone and answered to the phone, as before");
  } finally { await close(off.server); }

  // ---- ON
  const on = await boot(true);
  try {
    // phone-only sender: unchanged, nothing recorded
    const p1 = await on.deliver({ id: "wamid.p.1", phone: "2348020000001" });
    ok(p1.outbound && on.rows().length === 0 && on.sent.at(-1).to === "2348020000001", "phone-only sender: matched and answered exactly as before; nothing recorded");

    // phone + BSUID: linked to the phone-matched lead
    const l1 = await on.deliver({ id: "wamid.l.1", phone: "2348020000002", bsuid: "NG.2000000002" });
    const leadA = await on.leadByPhone("2348020000002");
    ok(l1.outbound && l1.lead_id === leadA.id && on.rows().length === 1 && on.rows()[0].state === "linked" && on.rows()[0].lead_id === leadA.id && on.rows()[0].business_account_id === WABA && on.rows()[0].business_scoped_user_id === "NG.2000000002", "phone + BSUID: linked to the lead the phone matched, scoped to the business account");
    ok(on.sent.at(-1).to === "2348020000002" && shape(bodies.at(-1)) === offShape.replace("2348010000001", "2348020000002"), "phone + BSUID: reply goes to the phone; the Office -> Backend payload is identical to capture OFF (no new field)");
    const leads = await on.store.listLeads();
    ok(leads.every((l) => !/NG\.|US\./.test(`${l.phone}|${l.whatsapp_phone}`)), "no BSUID is ever written to a phone field");

    // repeat, duplicate and concurrent delivery: still exactly one link
    await on.deliver({ id: "wamid.l.2", phone: "2348020000002", bsuid: "NG.2000000002" });
    const dupe = msg({ id: "wamid.l.3", phone: "2348020000002", bsuid: "NG.2000000002" });
    const [, d2] = await on.post({ ...dupe, entry: [{ ...dupe.entry[0], changes: [{ ...dupe.entry[0].changes[0], value: { ...dupe.entry[0].changes[0].value, messages: [dupe.entry[0].changes[0].value.messages[0], dupe.entry[0].changes[0].value.messages[0]] } }] }] });
    await Promise.all(Array.from({ length: 6 }, (_, i) => on.deliver({ id: `wamid.l.c${i}`, phone: "2348020000003", bsuid: "NG.2000000003" })));
    ok(d2.duplicate && on.rows().filter((r) => r.business_scoped_user_id === "NG.2000000002").length === 1 && on.rows().filter((r) => r.business_scoped_user_id === "NG.2000000003" && r.state === "linked").length === 1, "duplicates and 6 concurrent messages: one link per sender");

    // conflict A: the BSUID is already linked to lead A; a message from ANOTHER phone carries it -> recorded for review on lead B, nothing reassigned
    const cA1 = await on.deliver({ id: "wamid.cA.1", phone: "2348020000009", bsuid: "NG.2000000002" });
    const leadB = await on.leadByPhone("2348020000009");
    const conflictA = on.rows().filter((r) => r.state === "conflict" && r.lead_id === leadB.id);
    ok(cA1.lead_id === leadB.id && cA1.outbound && on.sent.at(-1).to === "2348020000009", "conflict (BSUID linked elsewhere): the message still belongs to and is answered for the phone-matched lead");
    ok(conflictA.length === 1 && conflictA[0].conflict_reason === "user_id_linked_to_other_lead" && conflictA[0].conflicting_lead_id === leadA.id && on.rows().find((r) => r.state === "linked" && r.business_scoped_user_id === "NG.2000000002").lead_id === leadA.id, "conflict recorded for review; the existing link to lead A is not overwritten or reassigned");
    await on.deliver({ id: "wamid.cA.2", phone: "2348020000009", bsuid: "NG.2000000002" });
    const timelineB = (await on.store.listTimelineForLead(leadB.id)).filter((t) => t.event_type === "whatsapp_identity_conflict");
    ok(on.rows().filter((r) => r.state === "conflict" && r.lead_id === leadB.id).length === 1 && timelineB.length === 1 && !/NG\.|US\./.test(JSON.stringify(timelineB)), "conflict: recorded once (no repeat note), and the review note contains no business-scoped id");
    ok((await on.leadByPhone("2348020000002")).id === leadA.id && (await on.store.listLeads()).filter((l) => ["2348020000002", "2348020000009"].includes(l.whatsapp_phone)).length === 2, "conflict: no lead merged or changed");

    // conflict B: lead A already linked to one BSUID; the same phone arrives with a different BSUID
    await on.deliver({ id: "wamid.cB.1", phone: "2348020000002", bsuid: "NG.2999999999" });
    const conflictB = on.rows().filter((r) => r.state === "conflict" && r.business_scoped_user_id === "NG.2999999999");
    ok(conflictB.length === 1 && conflictB[0].lead_id === leadA.id && conflictB[0].conflict_reason === "lead_linked_to_other_user_id" && on.rows().filter((r) => r.state === "linked" && r.lead_id === leadA.id).map((r) => r.business_scoped_user_id).join() === "NG.2000000002", "conflict (lead linked to another BSUID): recorded; the lead keeps its original link");

    // BSUID-only sender (no phone): behaviour exactly as before Phase 1 -- not linked, nothing sent to the BSUID
    const before = { rows: on.rows().length, sent: on.sent.length };
    const b1 = await on.deliver({ id: "wamid.b.1", bsuid: "NG.3000000003" });
    ok(b1.reason === "opt_out_unverified" && bodies.at(-1).from === "" && on.rows().length === before.rows && on.sent.length === before.sent, "BSUID-only sender: not linked; Backend still refuses it (missing_sender); no reply and nothing sent to the BSUID -- unchanged");

    // invalid / parent / inconsistent ids, wrong or missing business account: never linked; message handled as before
    await on.deliver({ id: "wamid.i.1", phone: "2348020000004", bsuid: "us.lower" });
    await on.deliver({ id: "wamid.i.2", phone: "2348020000005", bsuid: "NG.4000000005", waba: "not-a-waba-id" });
    await on.deliver({ id: "wamid.i.3", phone: "2348020000006", bsuid: "NG.4000000006", contactBsuid: "NG.4999999999" });
    const parentOnly = msg({ id: "wamid.i.4", phone: "2348020000007", parent: "NG.ENT.123456" });
    await on.post(parentOnly);
    ok(on.rows().length === before.rows && ["2348020000004", "2348020000005", "2348020000006", "2348020000007"].every((p) => on.sent.some((s) => s.to === p)), "invalid, parent-only, inconsistent ids and an invalid business account: never linked; messages answered as before");

    // the same BSUID under a DIFFERENT business account is a different scope (Meta: unique per portfolio-user pair)
    await on.deliver({ id: "wamid.s.1", phone: "2348020000008", bsuid: "NG.2000000002", waba: "987654321" });
    ok(on.rows().some((r) => r.state === "linked" && r.business_account_id === "987654321" && r.business_scoped_user_id === "NG.2000000002"), "scope: uniqueness is per business account, not global");

    // opt-out and goal behaviour preserved
    const stop = await on.deliver({ id: "wamid.o.1", phone: "2348020000002", bsuid: "NG.2000000002", body: "STOP" });
    optedOutPhones = new Set(["2348020000002"]);
    const after = await on.deliver({ id: "wamid.o.2", phone: "2348020000002", bsuid: "NG.2000000002", body: "hello again" });
    optedOutPhones = new Set();
    goalActive = true;
    const goal = await on.deliver({ id: "wamid.g.1", phone: "2348020000002", bsuid: "NG.2000000002", body: "about the plot" });
    goalActive = false;
    ok(stop.reason === "opt_out_requested" && after.reason === "opted_out" && goal.deferred_to_goal === true, "opt-out (STOP and Backend opted_out) and goal deferral unchanged for a linked sender");

    // status endpoint
    const unauth = await fetch(`${on.base}/api/lead-agents/admin/whatsapp-identity/status`);
    const staff = await fetch(`${on.base}/api/lead-agents/admin/whatsapp-identity/status`, { headers: { cookie: on.staffCookie } });
    const admin = await fetch(`${on.base}/api/lead-agents/admin/whatsapp-identity/status`, { headers: { cookie: on.superCookie } });
    const body = await admin.json();
    const text = JSON.stringify(body);
    ok(unauth.status === 401 && staff.status === 403 && admin.status === 200, "status endpoint: anonymous 401, ordinary staff 403, administrator 200");
    ok(body.whatsapp_sender_identity.capture_enabled === true && body.whatsapp_sender_identity.identifier_only_messaging === "not_enabled" && body.whatsapp_sender_identity.conflicts === 2 && body.whatsapp_sender_identity.conflicts_by_reason.user_id_linked_to_other_lead === 1 && body.whatsapp_sender_identity.health.not_linked_without_phone >= 1, "status endpoint: counts and health");
    ok(!/NG\.|US\.|2348020|[0-9a-f]{8}-[0-9a-f]{4}-/.test(text), "status endpoint: no business-scoped ids, phone numbers or lead ids");
  } finally { await close(on.server); }

  // ---- identity storage failure never affects intake or the reply
  const failing = await boot(true, (store) => new Proxy(store, { get(target, prop) { if (prop === "findWhatsAppSenderIdentities") return async () => { throw new Error("connect ECONNREFUSED https://db.example"); }; const v = target[prop]; return typeof v === "function" ? v.bind(target) : v; } }));
  try {
    const failuresBefore = identity.health.failures;
    const r = await failing.deliver({ id: "wamid.f.1", phone: "2348030000001", bsuid: "NG.5000000001" });
    ok(r.outbound && failing.sent.at(-1).to === "2348030000001" && identity.health.failures === failuresBefore + 1, "storage failure: message matched, recorded and answered as before; failure counted");
  } finally { await close(failing.server); }

  await close(backend);
  console.log(JSON.stringify({ suite: "whatsapp-sender-identity", checks, failed: 0 }));
}

main().catch((error) => { console.error(error); process.exit(1); });
