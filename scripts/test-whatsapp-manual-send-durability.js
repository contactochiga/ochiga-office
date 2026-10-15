const assert = require("node:assert/strict");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { FileLeadAgentsStore } = require("../src/lead-agents/store-file");
const { hashPassword } = require("../src/lead-agents/auth");
const { reconcileManualSends } = require("../src/lead-agents/manual-whatsapp-send");

// Durable manual WhatsApp send lifecycle: idempotency across duplicates, concurrency, restarts and instances; provider outcomes (accepted / rejected / unknown);
// persistence failures; governed reconciliation; no automatic retransmission. Controlled adapter, no real customers, no production.
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const close = (server) => new Promise((resolve) => server.close(resolve));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["dur-test-key"], allowedOrigins: [], officeBackendBaseUrl: "http://127.0.0.1:1", officeBackendApiKey: "dur-bridge" };
  const info = await createTempStore();
  const { store } = info;
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super", status: "active" });
  await store.ensureAdminUser({ email: "staff@ochiga.local", password_hash: hashPassword("staff-pass-123"), role: "ochiga_staff", display_name: "Staff", status: "active" });
  // a second store handle onto the SAME durable data = a second server instance (Supabase mode: a separate client; file mode: the same handle, since the file store is single-process)
  const reopen = async () => (info.filePath ? (async () => { const s = new FileLeadAgentsStore(info.filePath); await s.init(); return s; })() : (await createTempStore()).store);

  const adapterState = { mode: "accept", calls: [], delayMs: 0 };
  const adapter = {
    verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: (b) => b.events || [], isConfigured: () => true,
    sendTextMessage: async (m) => {
      adapterState.calls.push(m);
      if (adapterState.delayMs) await sleep(adapterState.delayMs);
      if (adapterState.mode === "reject") { const e = new Error("Request failed with status code 400"); e.response = { status: 400, data: { error: { code: 131047, type: "OAuthException" } } }; throw e; }
      if (adapterState.mode === "timeout") { const e = new Error("timeout of 15000ms exceeded"); e.code = "ECONNABORTED"; throw e; }
      if (adapterState.mode === "server_error") { const e = new Error("Request failed with status code 503"); e.response = { status: 503, data: {} }; throw e; }
      return { delivered: true, response_code: 200, external_message_id: `wamid.out.${adapterState.calls.length}` };
    },
    sendTemplateMessage: async () => ({ delivered: false }), listApprovedTemplates: async () => [],
  };
  const servers = [];
  const startServer = async (s) => {
    const server = buildServer({ config, store: s, rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 9999 }), publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 9999 }), officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 9999 }), loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store: s, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
    const port = await listen(server); servers.push(server); return `http://127.0.0.1:${port}`;
  };
  const login = async (base, email, password) => { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }); assert.equal(r.status, 200); return r.headers.get("set-cookie").split(";")[0]; };
  const reply = (base, cookie, leadId, body) => fetch(`${base}/api/lead-agents/admin/leads/${leadId}/whatsapp/reply`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const thread = async (base, cookie, leadId) => { const r = await fetch(`${base}/api/lead-agents/admin/crm/relationships/${leadId}`, { headers: { cookie } }); assert.equal(r.status, 200); return r.json(); };
  const outbound = (t) => t.thread.entries.filter((e) => e.direction === "outbound" && e.kind === "message");
  const newLead = async (suffix) => {
    const lead = await store.createLead({ name: `Durable ${suffix}`, source: "whatsapp", whatsapp_phone: `23480000${suffix}`, status: "new" });
    await store.upsertLeadChannelState(lead.id, "whatsapp", { human_status: "human_active", human_owner: "super@ochiga.local", ai_paused: true });
    return lead;
  };

  const baseA = await startServer(store);
  const storeB = info.filePath ? store : await reopen(); // file store is single-process by design: a second "instance" shares the handle; Supabase mode uses a separate client
  const baseB = await startServer(storeB);
  const sup = await login(baseA, "super@ochiga.local", "super-pass-123");
  const supB = await login(baseB, "super@ochiga.local", "super-pass-123");
  const staff = await login(baseA, "staff@ochiga.local", "staff-pass-123");
  const calls = () => adapterState.calls.length;

  try {
    // O/P. Global autonomy is OFF by default (no setting row); an authorised manual send still works. E. accepted + persisted.
    const lead = await newLead("0001");
    assert.equal((await thread(baseA, sup, lead.id)).communication.global_autonomous_responses, "off");
    const r1 = await reply(baseA, sup, lead.id, { body: "Hello, here is the brochure", client_request_id: "req-1" });
    assert.equal(r1.status, 200); assert.equal(r1.body.state, "provider_accepted"); assert.equal(r1.body.recorded, true); assert.equal(calls(), 1);
    const ledger = await store.listManualSendsForLead(lead.id); assert.equal(ledger.length, 1);
    assert.equal(ledger[0].status, "provider_accepted"); assert.ok(ledger[0].conversation_recorded_at); assert.equal(ledger[0].provider_message_id, "wamid.out.1"); assert.equal(ledger[0].actor_email, "super@ochiga.local");
    assert.equal(ledger[0].body_hash.length, 64); assert.equal(ledger[0].recipient, lead.whatsapp_phone);
    let t = await thread(baseA, sup, lead.id); assert.equal(outbound(t).length, 1, "one outbound entry (ledger row merged into its conversation record)");
    assert.equal(outbound(t)[0].delivery.state, "unverified", "provider acceptance is not delivery"); assert.equal(outbound(t)[0].manual_send.status, "provider_accepted");
    console.log("E/O/P. Authorised manual send works with autonomy OFF; intent persisted; accepted != delivered — PASS");

    // A. duplicate in one process
    const dup = await reply(baseA, sup, lead.id, { body: "Hello, here is the brochure", client_request_id: "req-1" });
    assert.equal(dup.status, 409); assert.equal(dup.body.error, "duplicate_request"); assert.equal(dup.body.state, "provider_accepted"); assert.equal(calls(), 1, "no second provider call");
    console.log("A. Duplicate request in one process refused, state reported — PASS");

    // B. restart: a brand new server + store handle on the same durable data
    const restartedStore = await reopen(); const baseR = await startServer(restartedStore); const supR = await login(baseR, "super@ochiga.local", "super-pass-123");
    const dupAfterRestart = await reply(baseR, supR, lead.id, { body: "Hello, here is the brochure", client_request_id: "req-1" });
    assert.equal(dupAfterRestart.status, 409); assert.equal(calls(), 1, "a restart does not reset idempotency");
    console.log("B. Duplicate after restart refused — PASS");

    // C. concurrent duplicates across two instances; slow provider widens the race
    adapterState.delayMs = 60;
    const conc = await Promise.all([...Array(4)].flatMap((_, i) => [reply(baseA, sup, lead.id, { body: "Concurrent", client_request_id: "req-conc" }), reply(baseB, supB, lead.id, { body: "Concurrent", client_request_id: "req-conc" })]));
    adapterState.delayMs = 0;
    assert.equal(conc.filter((r) => r.status === 200).length, 1, "exactly one request wins the claim"); assert.equal(conc.filter((r) => r.status === 409).length, 7);
    assert.equal(adapterState.calls.filter((c) => c.body === "Concurrent").length, 1, "one outbound provider attempt for 8 concurrent requests");
    console.log("C. 8 concurrent duplicates across 2 instances => 1 provider attempt — PASS");

    // D. same id, altered content
    const altered = await reply(baseA, sup, lead.id, { body: "Different text entirely", client_request_id: "req-1" });
    assert.equal(altered.status, 409); assert.equal(altered.body.error, "request_id_reused"); assert.equal(calls(), 2, "no send");
    console.log("D. Same request id with altered content rejected — PASS");

    // G. provider rejected (definitive 4xx)
    adapterState.mode = "reject";
    const rej = await reply(baseA, sup, lead.id, { body: "Will be refused", client_request_id: "req-rej" });
    assert.equal(rej.status, 502); assert.equal(rej.body.state, "provider_rejected"); const callsAfterReject = calls();
    const rejRetry = await reply(baseA, sup, lead.id, { body: "Will be refused", client_request_id: "req-rej" });
    assert.equal(rejRetry.status, 409); assert.equal(rejRetry.body.state, "provider_rejected"); assert.equal(calls(), callsAfterReject, "a known outcome is never re-sent under the same id");
    t = await thread(baseA, sup, lead.id); const rejected = outbound(t).find((e) => e.text === "Will be refused");
    assert.ok(rejected && rejected.delivery.state === "rejected" && rejected.delivery.verified === false, "the refused send is shown honestly as not sent");
    console.log("G. Provider rejection recorded, shown as not sent, never re-sent — PASS");

    // H. timeout / unknown (no response) and 5xx; I. no automatic retransmission and governed reconciliation; J. no duplicate during reconciliation
    adapterState.mode = "timeout";
    const unk = await reply(baseA, sup, lead.id, { body: "Maybe sent", client_request_id: "req-unk" });
    assert.equal(unk.status, 202); assert.equal(unk.body.state, "outcome_unknown"); const callsAfterUnknown = calls();
    adapterState.mode = "server_error";
    const unk5 = await reply(baseA, sup, lead.id, { body: "Maybe sent 5xx", client_request_id: "req-unk5" }); assert.equal(unk5.body.state, "outcome_unknown");
    adapterState.mode = "accept";
    const unkRetry = await reply(baseA, sup, lead.id, { body: "Maybe sent", client_request_id: "req-unk" });
    assert.equal(unkRetry.status, 409); assert.equal(unkRetry.body.state, "outcome_unknown"); assert.equal(calls(), callsAfterUnknown + 1, "the retry of an unknown outcome did not send again (only the separate 5xx probe did)");
    await Promise.all([reconcileManualSends(store, lead.id), reconcileManualSends(storeB, lead.id), thread(baseA, sup, lead.id), thread(baseB, supB, lead.id)]);
    assert.equal(calls(), callsAfterUnknown + 1, "reconciliation never calls the provider");
    t = await thread(baseA, sup, lead.id); const unknownEntry = outbound(t).find((e) => e.text === "Maybe sent");
    assert.equal(unknownEntry.delivery.state, "outcome_unknown"); assert.equal(unknownEntry.manual_send.resolvable, true); assert.notEqual(unknownEntry.delivery.state, "delivered");
    console.log("H/J. Timeout and 5xx => unknown; same id never re-sent; reconciliation makes no provider call — PASS");

    const unknownSend = (await store.listManualSendsForLead(lead.id)).find((s) => s.client_request_id === "req-unk");
    const resolve = (cookie, sendId, body) => fetch(`${baseA}/api/lead-agents/admin/leads/${lead.id}/whatsapp/manual-sends/${sendId}/resolve`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal((await resolve(staff, unknownSend.id, { resolution: "confirmed_sent" })).status, 403, "resolution needs manage_takeover");
    const confirmedSent = await resolve(sup, unknownSend.id, { resolution: "confirmed_sent", provider_message_id: "wamid.checked.1", note: "seen in WhatsApp" });
    assert.equal(confirmedSent.status, 200); assert.equal(confirmedSent.body.state, "provider_accepted"); assert.equal(confirmedSent.body.recorded, true);
    assert.equal((await resolve(sup, unknownSend.id, { resolution: "confirmed_not_sent" })).status, 409, "a resolved send cannot be flipped");
    const unknown5 = (await store.listManualSendsForLead(lead.id)).find((s) => s.client_request_id === "req-unk5");
    const notSent = await resolve(sup, unknown5.id, { resolution: "confirmed_not_sent" }); assert.equal(notSent.body.state, "not_sent");
    assert.equal(calls(), callsAfterUnknown + 1, "resolving never sends");
    t = await thread(baseA, sup, lead.id);
    assert.equal(outbound(t).filter((e) => e.text === "Maybe sent").length, 1); assert.equal(outbound(t).find((e) => e.text === "Maybe sent").manual_send.status, "provider_accepted");
    assert.equal(outbound(t).find((e) => e.text === "Maybe sent 5xx").delivery.state, "not_sent");
    assert.ok((await store.listAuditEvents(500)).some((e) => e.action === "communication.whatsapp.manual_send_resolved" && e.actor_email === "super@ochiga.local"), "resolution audited with the operator");
    console.log("I. Governed reconciliation (permission, audit, no resend, no flip-flop) — PASS");

    // stale pending (process died between claim and provider response): becomes unknown, never re-sent
    const lead2 = await newLead("0002");
    const claim = await store.claimManualSend({ lead_id: lead2.id, actor_email: "super@ochiga.local", client_request_id: "req-crash", channel: "whatsapp", recipient: lead2.whatsapp_phone, body: "Crashed mid-send", body_hash: "x".repeat(64) });
    assert.equal(claim.claimed, true);
    t = await thread(baseA, sup, lead2.id); assert.equal(outbound(t)[0].delivery.state, "pending", "fresh pending is shown as pending");
    await store.updateManualSend(claim.record.id, {}); const before = calls();
    const stale = await reconcileManualSends(store, lead2.id, { now: Date.now() + 10 * 60 * 1000 }); assert.equal(stale.marked_unknown, 1); assert.equal(calls(), before);
    assert.equal(outbound(await thread(baseA, sup, lead2.id))[0].delivery.state, "outcome_unknown");
    console.log("H2. A send interrupted before the provider answered becomes 'outcome unknown' (no resend) — PASS");

    // F. provider accepted, local conversation persistence FAILS: surfaced, durable, repaired later without a second send
    const lead3 = await newLead("0003");
    const failingConversation = new Proxy(store, { get: (t2, p) => (p === "appendConversation" ? async () => { throw new Error("conversation write failed"); } : typeof t2[p] === "function" ? t2[p].bind(t2) : t2[p]) });
    const baseF = await startServer(failingConversation); const supF = await login(baseF, "super@ochiga.local", "super-pass-123");
    const accNoRecord = await reply(baseF, supF, lead3.id, { body: "Accepted but not recorded", client_request_id: "req-f" });
    assert.equal(accNoRecord.status, 200); assert.equal(accNoRecord.body.state, "provider_accepted"); assert.equal(accNoRecord.body.recorded, false, "the failure is reported, not swallowed");
    let sendRow = (await store.listManualSendsForLead(lead3.id))[0]; assert.equal(sendRow.status, "provider_accepted"); assert.equal(sendRow.conversation_recorded_at, null);
    assert.equal((await store.listAuditEvents(500)).filter((e) => e.action === "communication.whatsapp.manual_reply" && e.metadata?.send_id === sendRow.id)[0].metadata.conversation_recorded, false);
    const callsBeforeRepair = calls();
    t = await thread(baseF, supF, lead3.id); assert.equal(outbound(t).filter((e) => e.text === "Accepted but not recorded").length, 1, "still shown once from the durable ledger while the record is unwritable");
    await thread(baseA, sup, lead3.id); await thread(baseB, supB, lead3.id); await thread(baseA, sup, lead3.id); // repaired by a healthy instance, repeatedly
    assert.equal(calls(), callsBeforeRepair, "repair never re-sends");
    assert.equal((await store.listConversationsForLead(lead3.id)).filter((c) => c.content === "Accepted but not recorded").length, 1, "exactly one conversation record after repeated repairs");
    sendRow = (await store.listManualSendsForLead(lead3.id))[0]; assert.ok(sendRow.conversation_recorded_at);
    assert.equal(outbound(await thread(baseA, sup, lead3.id)).length, 1);
    console.log("F. Provider accepted + local persistence failure: reported, durable, repaired once, no resend — PASS");

    // F2. outcome row cannot be updated after acceptance: reported; stays pending -> unknown, resolved by staff with the provider id
    const lead4 = await newLead("0004");
    const failingUpdate = new Proxy(store, { get: (t2, p) => (p === "updateManualSend" ? async () => { throw new Error("db write failed"); } : typeof t2[p] === "function" ? t2[p].bind(t2) : t2[p]) });
    const baseU = await startServer(failingUpdate); const supU = await login(baseU, "super@ochiga.local", "super-pass-123");
    const accNoState = await reply(baseU, supU, lead4.id, { body: "Accepted, state lost", client_request_id: "req-f2" });
    assert.equal(accNoState.status, 200); assert.equal(accNoState.body.state_recorded, false); assert.equal(accNoState.body.recorded, false);
    const lost = (await store.listManualSendsForLead(lead4.id))[0]; assert.equal(lost.status, "pending");
    assert.ok((await store.listAuditEvents(500)).some((e) => e.action === "communication.whatsapp.manual_reply" && e.metadata?.send_id === lost.id && e.metadata.state_recorded === false && e.metadata.external_message_id), "the provider message id survives in the audit trail");
    await reconcileManualSends(store, lead4.id, { now: Date.now() + 10 * 60 * 1000 }); assert.equal((await store.listManualSendsForLead(lead4.id))[0].status, "outcome_unknown");
    console.log("F2. State write failure after acceptance: surfaced; id kept in audit; handled as unknown — PASS");

    // database unavailable: no unsafe send
    const lead5 = await newLead("0005"); const noDb = new Proxy(store, { get: (t2, p) => (p === "claimManualSend" ? async () => { throw new Error("database unavailable"); } : typeof t2[p] === "function" ? t2[p].bind(t2) : t2[p]) });
    const baseD = await startServer(noDb); const supD = await login(baseD, "super@ochiga.local", "super-pass-123"); const callsBeforeDb = calls();
    const dbDown = await reply(baseD, supD, lead5.id, { body: "No db", client_request_id: "req-db" }); assert.equal(dbDown.status, 503); assert.equal(dbDown.body.error, "send_state_unavailable"); assert.equal(calls(), callsBeforeDb, "nothing sent when the intent cannot be persisted");
    console.log("DB. Durable state unavailable => no send — PASS");

    // N/Q + forged actor. Takeover, permissions, authentication
    const lead6 = await store.createLead({ name: "No takeover", source: "whatsapp", whatsapp_phone: "2348000000006", status: "new" });
    const noTakeover = await reply(baseA, sup, lead6.id, { body: "x", client_request_id: "req-nt" }); assert.equal(noTakeover.status, 409); assert.equal(noTakeover.body.error, "takeover_required");
    assert.equal((await store.listManualSendsForLead(lead6.id)).length, 0, "no takeover => not even an intent is recorded"); 
    await store.upsertLeadChannelState(lead6.id, "whatsapp", { human_status: "human_active", ai_paused: true });
    assert.equal((await reply(baseA, staff, lead6.id, { body: "x", client_request_id: "req-p" })).status, 403, "staff without manage_takeover cannot send");
    assert.equal((await reply(baseA, null, lead6.id, { body: "x", client_request_id: "req-u" })).status, 401);
    const forged = await reply(baseA, sup, lead6.id, { body: "x", client_request_id: "req-forged", actor_email: "someone.else@ochiga.local" }); assert.equal(forged.status, 400); assert.equal(forged.body.error, "forged_actor");
    assert.equal((await store.listManualSendsForLead(lead6.id)).length, 0); const sameActorOk = await reply(baseA, sup, lead6.id, { body: "fine", client_request_id: "req-ok", actor_email: "super@ochiga.local" }); assert.equal(sameActorOk.status, 200);
    // the same request id used by a different actor is a different key: two operators cannot suppress each other, and each attempt is attributed
    assert.equal((await store.listManualSendsForLead(lead6.id))[0].actor_email, "super@ochiga.local");
    console.log("N/Q. Takeover required; unauthorised, unauthenticated and forged-actor requests refused — PASS");

    // autonomy setting is untouched by all of this
    assert.equal(await store.getRuntimeSetting("whatsapp_autonomous_responses_enabled"), null, "the autonomy setting was never written");
    console.log(JSON.stringify({ status: "PASS", suite: "whatsapp-manual-send-durability", provider_calls: calls() }));
  } finally {
    for (const server of servers) await close(server).catch(() => {});
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
