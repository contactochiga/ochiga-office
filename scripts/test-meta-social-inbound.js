const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { rm } = require("node:fs/promises");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { createTempStore } = require("../src/lead-agents/testing");
const { FileLeadAgentsStore } = require("../src/lead-agents/store-file");
const { SupabaseLeadAgentsStore } = require("../src/lead-agents/store-supabase");
const { createStore } = require("../src/lead-agents/store-factory");
const { hashPassword } = require("../src/lead-agents/auth");
const { createMetaSocialReplyAdapter } = require("../src/lead-agents/meta-social-replies");
const { reconcileManualSends, resolveManualSend } = require("../src/lead-agents/manual-whatsapp-send");

const secret = "local-social-fixture-secret";
const page = "111";
const instagram = "222";
const sender = "333";
const path = "/webhooks/meta-social";
const event = (asset, overrides = {}) => ({
  sender: { id: sender }, recipient: { id: asset }, timestamp: Date.now(),
  message: { mid: "m_shared", text: "Fixture inquiry" }, ...overrides,
});
const batch = (object, asset, ...messaging) => ({ object, entry: [{ id: asset, messaging }] });

async function main() {
  const graphError = (data) => createMetaSocialReplyAdapter({}, async () => {
    throw Object.assign(new Error("fixture"), { response: { status: 403, data } });
  });
  const graphRequest = { channel: "facebook", to: "333", body: "Fixture" };
  const known = { type: "OAuthException", code: 190, message: "Invalid token", fbtrace_id: "fixture-trace" };
  assert.deepEqual(await graphError({ error: known }).sendTextMessage(graphRequest), { rejected: true, response_code: 403 });
  for (const data of [null, { error: { ...known, is_transient: true } }, { error: { ...known, code: 999 } }, { error: { ...known, fbtrace_id: "" } }]) {
    await assert.rejects(graphError(data).sendTextMessage(graphRequest), /meta_provider_outcome_unconfirmed/);
  }
  assert.throws(() => createStore({ metaSocialOutboundEnabled: true, storeDriver: "file" }), /Supabase dispatch fence/);
  const supabase = Object.create(SupabaseLeadAgentsStore.prototype);
  const queries = [];
  supabase.client = { get: async (path) => {
    queries.push(new URL(path, "https://fixture.invalid").searchParams);
    return { data: [] };
  } };
  await supabase.listSocialManualSends("lead-x", "facebook", { limit: 200, offset: 200 });
  await supabase.listSocialManualSends("lead-x", "facebook", { unresolved: true });
  await supabase.listSocialManualSends("lead-x", "facebook", { repair: true });
  assert.equal(queries[0].get("offset"), "200");
  for (const query of queries) {
    assert.equal(query.get("order"), "created_at.desc,id.desc");
    assert.equal(query.get("channel"), "eq.facebook");
    assert.equal(query.get("lead_id"), "eq.lead-x");
  }
  assert.equal(queries[1].get("status"), "in.(pending,outcome_unknown)");
  assert.equal(queries[2].get("conversation_recorded_at"), "is.null");
  const { store, tempDir, filePath } = await createTempStore();
  await store.ensureAdminUser({ email: "social@ochiga.local", password_hash: hashPassword("fixture-pass-123"), role: "super_admin", display_name: "Fixture", status: "active" });
  await store.ensureAdminUser({ email: "resident@ochiga.local", password_hash: hashPassword("fixture-pass-123"), role: "resident", display_name: "Fixture", status: "active" });
  await store.ensureAdminUser({ email: "unapproved@ochiga.local", password_hash: hashPassword("fixture-pass-123"), role: "super_admin", display_name: "Fixture", status: "active" });
  const operator = await store.getAdminUserByEmail("social@ochiga.local");
  const originalLead = await store.createLead({ name: "Existing", whatsapp_phone: sender, source: "whatsapp", primary_channel: "whatsapp" });
  const servers = [];
  const sent = [];
  let providerMode = "accept";
  let providerBarrier;
  const mk = () => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 });
  const noCalls = () => { assert.fail("social intake must not call WhatsApp"); };
  const start = async (overrides = {}, db = store) => {
    const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["fixture-api"], allowedOrigins: [],
      metaAppSecret: secret, metaSocialVerifyToken: "fixture-verify", facebookPageId: page, instagramBusinessAccountId: instagram,
      officeBackendBaseUrl: "", facebookPageAccessToken: "fixture-page-token", metaSocialGraphVersion: "v26.0", metaSocialOperatorIds: [operator.id], metaSocialInboundChannels: ["facebook", "instagram"], ...overrides };
    const metaSocialReplyAdapter = createMetaSocialReplyAdapter(config, async (url, body, options) => {
      sent.push({ url, body, options });
      if (providerBarrier) await providerBarrier();
      if (providerMode === "timeout") throw Object.assign(new Error("mock timeout"), { code: "ETIMEDOUT" });
      if (providerMode === "reject") throw Object.assign(new Error("mock refusal"), {
        response: { status: 403, data: { error: { type: "OAuthException", code: 200, message: "Permission denied", fbtrace_id: "fixture-trace" } } },
      });
      if (providerMode === "ambiguous") throw Object.assign(new Error("mock gateway"), { response: { status: 403 } });
      return { status: 200, data: { recipient_id: body.recipient.id, message_id: providerMode === "accept" ? "out_shared" : "out_ordered" } };
    });
    const server = buildServer({ config, store: db, rateLimiter: mk(), publicRateLimiter: mk(), officeRateLimiter: mk(),
      loginRateLimiter: mk(), whatsappAdapter: { extractEvents: noCalls, verifySignature: noCalls, sendTextMessage: noCalls, isConfigured: () => false }, metaSocialReplyAdapter, openaiClient: {}, toolExecutor: {} });
    servers.push(server);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return `http://127.0.0.1:${server.address().port}`;
  };
  const post = async (base, body, signingSecret = secret) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    return fetch(base + path, { method: "POST", headers: { "content-type": "application/json",
      ...(signingSecret ? { "x-hub-signature-256": `sha256=${createHmac("sha256", signingSecret).update(raw).digest("hex")}` } : {}) }, body: raw });
  };
  const payload = batch("page", page, event(page));
  try {
    assert.equal((await post(await start({ metaSocialInboundEnabled: false }), payload)).status, 404);
    const base = await start({ metaSocialInboundEnabled: true });
    const challenge = `${base}${path}?hub.mode=subscribe&hub.challenge=98765&hub.verify_token=`;
    assert.equal((await fetch(challenge + "wrong")).status, 403);
    assert.equal(await (await fetch(challenge + "fixture-verify")).text(), "98765");
    assert.equal((await post(await start({ metaSocialInboundEnabled: true, metaAppSecret: "" }), payload)).status, 503);
    assert.equal((await post(await start({ metaSocialInboundEnabled: true, facebookPageId: "", instagramBusinessAccountId: "" }), payload)).status, 503);
    const pageOnly = await start({ metaSocialInboundEnabled: true, instagramBusinessAccountId: "" });
    assert.equal((await post(pageOnly, batch("instagram", instagram, event(instagram)))).status, 503);
    assert.equal((await post(base, payload, null)).status, 403);
    assert.equal((await post(base, payload, "bad")).status, 403);
    assert.equal((await post(base, "not json")).status, 400);
    assert.equal((await post(base, { object: "instagram", entry: {} })).status, 400);
    assert.equal((await post(base, { object: "whatsapp_business_account", entry: [] })).status, 400);
    assert.equal((await post(base, batch("page", instagram, event(instagram)))).status, 200);
    assert.equal(store.state.conversations.length, 0);

    const mixed = batch("page", page,
      null, event(instagram), event(page, { sender: { id: page } }),
      event(page, { message: { mid: "echo", text: "Do not store", is_echo: true } }),
      event(page, { message: { mid: "media", attachments: [{ type: "image" }] } }),
      event(page, { message: { text: "No provider id" } }),
      event(page, { message: { mid: "long", text: "x".repeat(4001) } }), event(page));
    mixed.entry.unshift({ id: instagram, messaging: [event(instagram)] });
    assert.deepEqual(await (await post(base, mixed)).json(), { ok: true, accepted: 1, duplicate: 0, skipped: 8, failed: 0 });
    const repeat = await Promise.all(Array.from({ length: 6 }, () => post(base, payload)));
    for (const res of repeat) assert.equal((await res.json()).duplicate, 1);
    assert.equal((await (await post(base, batch("instagram", instagram, event(instagram)))).json()).accepted, 1);
    const fb = store.state.leads.find((lead) => lead.source === "facebook");
    const ig = store.state.leads.find((lead) => lead.source === "instagram");
    assert.notEqual(fb.id, ig.id);
    assert.notEqual(fb.id, originalLead.id);
    assert.ok(!fb.whatsapp_phone && !ig.phone && !ig.email);
    assert.equal(store.state.inbound_events.length, 0);
    assert.equal(store.state.communication_delivery_outbox.length, 0);
    assert.equal(await store.getRuntimeSetting("whatsapp_autonomous_responses_enabled"), null);

    const original = store.recordMetaSocialMessage.bind(store);
    store.recordMetaSocialMessage = async (message) => { if (message.text === "Retry fixture") throw new Error("private diagnostic"); return original(message); };
    const retryable = batch("page", page, event(page, { message: { mid: "retry", text: "Retry fixture" } }), event(page));
    const failed = await post(base, retryable);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { ok: false, accepted: 0, duplicate: 1, skipped: 0, failed: 1 });
    store.recordMetaSocialMessage = original;
    assert.deepEqual(await (await post(base, retryable)).json(), { ok: true, accepted: 1, duplicate: 1, skipped: 0, failed: 0 });

    const restored = new FileLeadAgentsStore(filePath);
    await restored.init();
    const restarted = await start({ metaSocialInboundEnabled: true }, restored);
    assert.equal((await (await post(restarted, payload)).json()).duplicate, 1);
    const inbox = restarted + "/api/lead-agents/admin/crm/relationships";
    assert.equal((await fetch(inbox)).status, 401);
    const staffHeaders = async (email) => {
      const login = await fetch(restarted + "/api/lead-agents/admin/session/login", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "fixture-pass-123" }) });
      assert.equal(login.status, 200);
      return { cookie: login.headers.get("set-cookie").split(";")[0] };
    };
    assert.equal((await fetch(inbox + "/" + ig.id, { headers: await staffHeaders("resident@ochiga.local") })).status, 403);
    const headers = await staffHeaders("social@ochiga.local");
    const list = await (await fetch(inbox + "?filter=unread", { headers })).json();
    assert.deepEqual(new Set(list.relationships.map((item) => item.lead_id)), new Set([fb.id, ig.id]));
    const detail = await (await fetch(inbox + "/" + ig.id, { headers })).json();
    assert.equal(detail.communication.inbound_only_channel, "instagram");
    assert.equal(detail.communication.whatsapp_reply.available, false);
    assert.equal(detail.thread.entries.find((entry) => entry.kind === "message").channel, "instagram");
    assert.equal(restored.state.conversations.length, 3);
    const reply = (url, lead, channel, request, extra = {}, auth = headers) => fetch(`${url}/api/lead-agents/admin/leads/${lead.id}/${channel}/reply`, {
      method: "POST", headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ body: "Fixture response", client_request_id: "fixture-request-" + request, ...extra }),
    });
    assert.equal((await reply(restarted, fb, "facebook", "off")).status, 403);
    const enabled = await start({ metaSocialInboundEnabled: true, metaSocialOutboundEnabled: true }, restored);
    const unapproved = await staffHeaders("unapproved@ochiga.local");
    assert.equal((await (await reply(enabled, fb, "facebook", "no-pilot", {}, unapproved)).json()).error, "social_operator_required");
    const noOperators = await start({ metaSocialInboundEnabled: true, metaSocialOutboundEnabled: true, metaSocialOperatorIds: [] }, restored);
    assert.equal((await (await reply(noOperators, fb, "facebook", "empty-pilot")).json()).error, "social_operator_required");
    assert.equal((await reply(enabled, fb, "facebook", "key", {}, { "x-api-key": "fixture-api" })).status, 403);
    assert.equal((await reply(enabled, fb, "instagram", "wrong")).status, 409);
    assert.equal((await reply(enabled, originalLead, "facebook", "wrong")).status, 409);
    assert.equal((await reply(enabled, fb, "facebook", "forged", { recipient: "444" })).status, 400);
    assert.equal(sent.length, 0);
    const duplicate = await Promise.all([reply(enabled, fb, "facebook", "first"), reply(enabled, fb, "facebook", "first")]);
    assert.deepEqual(duplicate.map((r) => r.status).sort(), [200, 409]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://graph.facebook.com/v26.0/111/messages");
    assert.equal(sent[0].body.recipient.id, sender);
    assert.equal(sent[0].body.messaging_type, "RESPONSE");
    assert.equal(sent[0].options.maxRedirects, 0);
    assert.equal((await reply(enabled, ig, "instagram", "first")).status, 200);
    assert.equal(sent[1].url, sent[0].url);
    assert.equal(sent[1].body.messaging_type, undefined);
    const thread = async (lead) => (await (await fetch(`${enabled}/api/lead-agents/admin/crm/relationships/${lead.id}`, { headers })).json()).thread.entries;
    const outbound = async (lead) => (await thread(lead)).find((entry) => entry.direction === "outbound");
    assert.equal((await outbound(fb)).delivery.state, "sent");
    const receipt = (object, asset, eventData, peer = sender) => batch(object, asset, { sender: { id: peer }, recipient: { id: asset }, ...eventData });
    await post(enabled, receipt("page", page, { read: { watermark: Date.now() } }));
    await post(enabled, receipt("page", page, { delivery: { watermark: Date.now() } }));
    await post(enabled, receipt("instagram", instagram, { read: { watermark: Date.now() } }));
    await post(enabled, batch("page", page, { sender: { id: page }, recipient: { id: sender }, delivery: { mids: ["out_shared"] } }));
    await post(enabled, receipt("instagram", instagram, { delivery: { mids: ["out_shared"] } }));
    assert.equal((await outbound(fb)).delivery.state, "sent");
    assert.equal((await outbound(ig)).delivery.state, "sent");
    await post(enabled, receipt("page", page, { delivery: { mids: ["out_shared"] } }, "444"));
    assert.equal((await outbound(fb)).delivery.state, "sent");
    await post(enabled, receipt("page", page, { delivery: { mids: ["out_shared"] } }));
    await post(enabled, receipt("page", page, { delivery: { mids: ["out_shared"] } }));
    assert.equal((await outbound(fb)).delivery.state, "delivered");
    assert.equal((await outbound(ig)).delivery.state, "sent");
    await post(enabled, receipt("instagram", instagram, { read: { mid: "out_shared" } }));
    assert.equal((await outbound(ig)).delivery.state, "read");
    providerMode = "reject";
    assert.equal((await reply(enabled, fb, "facebook", "reject")).status, 502);
    assert.equal((await reply(enabled, fb, "facebook", "reject")).status, 409);
    assert.equal(sent.length, 3);
    providerMode = "ambiguous";
    const timeout = await reply(enabled, fb, "facebook", "timeout");
    assert.equal(timeout.status, 202);
    assert.equal((await timeout.json()).state, "outcome_unknown");
    const blocked = await reply(enabled, fb, "facebook", "new-request");
    assert.equal((await blocked.json()).error, "unresolved_send");
    assert.equal(sent.length, 4);
    const uncertain = restored.state.whatsapp_manual_sends.find((item) => item.channel === "facebook" && item.status === "outcome_unknown");
    const resolve = (channel) => fetch(`${enabled}/api/lead-agents/admin/leads/${fb.id}/${channel}/manual-sends/${uncertain.id}/resolve`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ resolution: "confirmed_not_sent" }),
    });
    assert.equal((await resolve("whatsapp")).status, 404);
    assert.equal((await resolve("instagram")).status, 404);
    const decisions = await Promise.all([resolve("facebook"), resolve("facebook")]);
    assert.deepEqual(decisions.map((r) => r.status), [409, 409]);
    for (const decision of decisions) assert.equal((await decision.json()).error, "dispatch_outcome_unverified");
    assert.equal(sent.length, 4);
    providerMode = "accept";
    assert.equal((await (await reply(enabled, fb, "facebook", "explicit-retry")).json()).error, "unresolved_send");
    assert.equal(sent.length, 4);
    for (let i = 0; i < 205; i++) {
      restored.state.whatsapp_manual_sends.push({ id: `history-${i}`, lead_id: fb.id, channel: "facebook",
        status: "provider_rejected", created_at: new Date(Date.now() + 1000 + i).toISOString() });
    }
    restored.state.whatsapp_manual_sends.push({ id: "foreign-ledger", lead_id: fb.id, channel: "instagram", status: "outcome_unknown", created_at: new Date().toISOString() });
    const ledgerPage = await restored.listSocialManualSends(fb.id, "facebook", { limit: 2, offset: 200 });
    assert.deepEqual(ledgerPage.map((row) => row.id), ["history-4", "history-3"]);
    const pagedUrl = `${enabled}/api/lead-agents/admin/crm/relationships/${fb.id}?limit=1`;
    const page1 = await (await fetch(pagedUrl, { headers })).json();
    assert.equal(page1.thread.has_more, true);
    const page2 = await (await fetch(pagedUrl + "&before=" + encodeURIComponent(page1.thread.next_before), { headers })).json();
    assert.notEqual(page1.thread.entries[0].id, page2.thread.entries[0].id);
    for (const page of [page1, page2]) {
      assert.deepEqual(page.unresolved_sends.map((s) => s.id), [uncertain.id]);
      assert.equal(page.communication.social_reply.available, false);
    }
    assert.equal((await fetch(pagedUrl, { headers: await staffHeaders("resident@ochiga.local") })).status, 403);
    const igInternal = await restored.getMetaSocialReplyLead(ig.id);
    igInternal.meta_social_last_inbound_at = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    assert.equal((await (await reply(enabled, ig, "instagram", "expired")).json()).error, "social_window_closed");
    await post(enabled, batch("instagram", instagram, event(instagram, { message: { mid: "stop", text: "STOP" } })));
    await post(enabled, batch("instagram", instagram, event(instagram, { message: { mid: "after-stop", text: "Hello" } })));
    assert.equal((await (await reply(enabled, ig, "instagram", "opted")).json()).error, "social_opted_out");
    assert.equal(sent.length, 4);
    const newLead = async (peer) => {
      await post(enabled, batch("page", page, event(page, { sender: { id: peer }, message: { mid: "in_" + peer, text: "Hello" } })));
      return restored.state.leads.find((row) => row.meta_social_sender_id === peer);
    };
    const deferred = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };
    const delayed = await newLead("901");
    const lookup = restored.getMetaSocialReplyLead.bind(restored);
    const pause = deferred();
    const entered = deferred();
    let reads = 0;
    restored.getMetaSocialReplyLead = async (id) => {
      if (id === delayed.id && ++reads === 2) { entered.release(); await pause.promise; }
      return lookup(id);
    };
    const old = reply(enabled, delayed, "facebook", "delay");
    await entered.promise;
    const oldIntent = restored.state.whatsapp_manual_sends.find((row) => row.lead_id === delayed.id);
    assert.equal(oldIntent.status, "pending");
    assert.equal(oldIntent.social_dispatch_at, undefined);
    const later = { now: Date.now() + 121_000, channel: "facebook" };
    await Promise.all([reconcileManualSends(restored, delayed.id, later), reconcileManualSends(restored, delayed.id, later)]);
    assert.equal(oldIntent.status, "not_sent");
    assert.equal((await resolveManualSend(restored, oldIntent.id, { resolution: "confirmed_not_sent" })).httpStatus, 409);
    pause.release();
    const expired = await old;
    assert.equal(expired.status, 409);
    assert.equal((await expired.json()).error, "social_claim_expired");
    assert.equal(sent.length, 4);
    restored.getMetaSocialReplyLead = lookup;
    const restartedLedger = new FileLeadAgentsStore(filePath);
    await restartedLedger.init();
    assert.equal(await restartedLedger.fenceMetaSocialDispatch(oldIntent.id, "facebook", delayed.idempotency_key), "social_dispatch_claim_lost");

    for (const [peer, reason, mutate] of [
      ["902", "social_opted_out", (row) => { row.meta_social_opted_out = true; }],
      ["903", "social_window_closed", (row) => { row.meta_social_last_inbound_at = "2020-01-01T00:00:00Z"; }],
      ["904", "social_recipient_unverified", (row) => { row.meta_social_sender_id = null; }],
    ]) {
      const lead = await newLead(peer);
      let calls = 0;
      restored.getMetaSocialReplyLead = async (id) => {
        const row = await lookup(id);
        if (id === lead.id && ++calls === 2) mutate(row);
        return row;
      };
      const refused = await reply(enabled, lead, "facebook", "policy-" + peer);
      assert.equal(refused.status, 409);
      assert.equal((await refused.json()).error, reason);
      const attempt = restored.state.whatsapp_manual_sends.find((row) => row.lead_id === lead.id);
      assert.equal(attempt.failure_reason, reason);
      assert.equal(attempt.status, "not_sent");
      assert.equal(restored.state.audit_events.some((row) => row.metadata?.failure_reason === reason), true);
    }
    restored.getMetaSocialReplyLead = lookup;
    assert.equal(sent.length, 4);

    const ordering = await newLead("905");
    const crossed = deferred();
    const release = deferred();
    providerMode = "ordered";
    providerBarrier = async () => { crossed.release(); await release.promise; };
    const active = reply(enabled, ordering, "facebook", "ordered");
    await crossed.promise;
    const activeIntent = restored.state.whatsapp_manual_sends.find((row) => row.lead_id === ordering.id);
    assert.ok(activeIntent.social_dispatch_at);
    const callback = receipt("page", page, { delivery: { mids: ["out_ordered"] } }, "905");
    assert.equal((await post(enabled, callback)).status, 200);
    assert.equal((await resolveManualSend(restored, activeIntent.id, { resolution: "confirmed_not_sent" })).httpStatus, 409);
    release.release();
    assert.equal((await active).status, 200);
    assert.equal((await post(enabled, callback)).status, 200);
    assert.equal((await post(enabled, callback)).status, 200);
    assert.equal((await outbound(ordering)).delivery.state, "delivered");
    const crossedLead = await newLead("906");
    const { socialReplyAttempts } = await import("../public/office/social-reply-attempt.mjs");
    const browserStorage = new Map();
    const browser = () => socialReplyAttempts({
      storage: { getItem: (k) => browserStorage.get(k), setItem: (k, v) => browserStorage.set(k, v), removeItem: (k) => browserStorage.delete(k) },
      locks: { request: async (_k, fn) => fn() }, digest: async (s) => createHmac("sha256", "fixture").update(s).digest("hex"),
      createId: () => "fixture-request-inflight",
    });
    const browserKey = "fixture:operator:facebook";
    assert.equal(await browser().prepare(browserKey, "Fixture response"), "fixture-request-inflight");
    const dispatched = deferred();
    const finish = deferred();
    providerBarrier = async () => { dispatched.release(); await finish.promise; };
    const inflight = reply(enabled, crossedLead, "facebook", "inflight");
    await dispatched.promise;
    const crossedIntent = restored.state.whatsapp_manual_sends.find((row) => row.lead_id === crossedLead.id);
    const early = receipt("page", page, { delivery: { mids: ["out_ordered"] } }, "906");
    assert.equal((await post(enabled, early)).status, 200);
    const receiptRestart = new FileLeadAgentsStore(filePath);
    await receiptRestart.init();
    assert.equal(receiptRestart.state.meta_social_pending_receipts[JSON.stringify(["facebook", "111:906", "out_ordered"])], "delivered");
    await Promise.all([
      reconcileManualSends(restored, crossedLead.id, { ...later, now: Date.now() + 121_000 }),
      resolveManualSend(restored, crossedIntent.id, { resolution: "confirmed_not_sent" }),
    ]);
    assert.equal(crossedIntent.status, "outcome_unknown");
    assert.equal((await resolveManualSend(restored, crossedIntent.id, { resolution: "confirmed_not_sent" })).body.error, "dispatch_outcome_unverified");
    assert.equal((await (await reply(enabled, crossedLead, "facebook", "cannot-retry")).json()).error, "unresolved_send");
    finish.release();
    assert.equal((await inflight).status, 200);
    assert.equal(crossedIntent.status, "provider_accepted");
    assert.equal(crossedIntent.provider_message_id, "out_ordered");
    assert.equal(crossedIntent.social_delivery_state, "delivered");
    // Discard the Office response and recreate the browser controller with only its persistent storage.
    const reloadedBrowser = browser();
    assert.equal(reloadedBrowser.read(browserKey).id, "fixture-request-inflight");
    await assert.rejects(reloadedBrowser.prepare(browserKey, "Different response"), /original reply text/);
    assert.equal(await reloadedBrowser.prepare(browserKey, "Fixture response"), "fixture-request-inflight");
    const statusPath = `/api/lead-agents/admin/leads/${crossedLead.id}/facebook/reply/fixture-request-inflight`;
    const authoritative = (await (await fetch(enabled + statusPath, { headers })).json()).state;
    assert.equal(authoritative, "provider_accepted");
    assert.equal((await fetch(enabled + statusPath, { headers: unapproved })).status, 403);
    assert.equal((await reply(enabled, crossedLead, "facebook", "inflight")).status, 409);
    const oldKey = reloadedBrowser.read(browserKey).id;
    await reloadedBrowser.settle(browserKey, oldKey, authoritative);
    assert.equal(reloadedBrowser.read(browserKey), null);
    await assert.rejects(reloadedBrowser.prepare(browserKey, "Fixture response", oldKey), /previous attempt changed/);
    providerBarrier = null;
    assert.equal(sent.length, 6);
    assert.equal(await restored.getRuntimeSetting("whatsapp_autonomous_responses_enabled"), null);
    console.log("Meta social inbound HTTP, CRM, replay and isolation: PASS");
  } finally {
    for (const server of servers) await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    await rm(tempDir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
