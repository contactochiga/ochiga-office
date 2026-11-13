const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { rm } = require("node:fs/promises");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { createTempStore } = require("../src/lead-agents/testing");
const { FileLeadAgentsStore } = require("../src/lead-agents/store-file");
const { hashPassword } = require("../src/lead-agents/auth");

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
  const { store, tempDir, filePath } = await createTempStore();
  await store.ensureAdminUser({ email: "social@ochiga.local", password_hash: hashPassword("fixture-pass-123"), role: "super_admin", display_name: "Fixture", status: "active" });
  await store.ensureAdminUser({ email: "resident@ochiga.local", password_hash: hashPassword("fixture-pass-123"), role: "resident", display_name: "Fixture", status: "active" });
  const originalLead = await store.createLead({ name: "Existing", whatsapp_phone: sender, source: "whatsapp", primary_channel: "whatsapp" });
  const servers = [];
  const mk = () => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 });
  const noCalls = () => { assert.fail("social intake must not call WhatsApp"); };
  const start = async (overrides = {}, db = store) => {
    const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["fixture-api"], allowedOrigins: [],
      metaAppSecret: secret, metaSocialVerifyToken: "fixture-verify", facebookPageId: page, instagramBusinessAccountId: instagram,
      officeBackendBaseUrl: "", ...overrides };
    const server = buildServer({ config, store: db, rateLimiter: mk(), publicRateLimiter: mk(), officeRateLimiter: mk(),
      loginRateLimiter: mk(), whatsappAdapter: { extractEvents: noCalls, verifySignature: noCalls, sendTextMessage: noCalls, isConfigured: () => false }, openaiClient: {}, toolExecutor: {} });
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
    console.log("Meta social inbound HTTP, CRM, replay and isolation: PASS");
  } finally {
    for (const server of servers) await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    await rm(tempDir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
