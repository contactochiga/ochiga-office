const assert = require("node:assert/strict");
const http = require("node:http");
const { rm } = require("node:fs/promises");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { CHANNELS, readChannelAutonomySetting, evaluateChannelAutonomy } = require("../src/lead-agents/channel-autonomy");

const KEY = "unified-autonomy-fixture-key";
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const close = (server) => new Promise((resolve) => server.close(resolve));

async function main() {
  const { store, tempDir } = await createTempStore();
  const servers = [];
  try {
    await store.ensureAdminUser({ email: "admin@example.test", password_hash: hashPassword("fixture-admin-123"), role: "super_admin", status: "active" });
    await store.ensureAdminUser({ email: "viewer@example.test", password_hash: hashPassword("fixture-viewer-123"), role: "resident", status: "active" });
    const backend = http.createServer((_req, res) => { res.statusCode = 503; res.end("{}"); });
    await listen(backend); servers.push(backend);
    const config = { ...createConfig(), authMode: "required_api_key", apiKeys: [KEY], allowedOrigins: [],
      facebookPageId: "111", instagramBusinessAccountId: "222", facebookPageAccessToken: "fixture-only",
      metaSocialGraphVersion: "v26.0", metaSocialInboundEnabled: true, metaSocialInboundChannels: ["facebook", "instagram"],
      metaSocialOutboundEnabled: true, metaSocialOutboundChannels: ["facebook", "instagram"],
      metaSocialAiChannels: ["facebook", "instagram"], metaSocialOperatorIds: [],
      officeBackendBaseUrl: `http://127.0.0.1:${backend.address().port}`, officeBackendApiKey: KEY };
    const start = async (serverConfig = config) => {
      const limiter = () => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 100 });
      const server = buildServer({ config: serverConfig, store, rateLimiter: limiter(), publicRateLimiter: limiter(), officeRateLimiter: limiter(), loginRateLimiter: limiter(),
        whatsappAdapter: { isConfigured: () => true, extractEvents: () => [], verifySignature: () => ({ ok: true }), sendTextMessage: async () => ({ delivered: true }) },
        metaSocialReplyAdapter: {}, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config: serverConfig, log: () => {}, webhooks: new WebhookDispatcher({ config: serverConfig }) }) });
      await listen(server); servers.push(server);
      return `http://127.0.0.1:${server.address().port}`;
    };
    const base = await start();
    const login = async (email, password) => {
      const response = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie").split(";")[0];
    };
    const adminCookie = await login("admin@example.test", "fixture-admin-123");
    const viewerCookie = await login("viewer@example.test", "fixture-viewer-123");
    const get = async (cookie) => fetch(`${base}/api/lead-agents/admin/settings/channel-autonomy`, { headers: cookie ? { cookie } : {} });
    const put = async (cookie, channel, enabled) => fetch(`${base}/api/lead-agents/admin/settings/channel-autonomy`, {
      method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ channel, enabled }),
    });

    assert.deepEqual(Object.keys(CHANNELS), ["whatsapp", "facebook", "instagram"]);
    const defaults = await (await get(adminCookie)).json();
    for (const channel of Object.keys(CHANNELS)) {
      assert.equal(defaults.channels[channel].enabled, false, `${channel} defaults OFF`);
      assert.equal(defaults.channels[channel].effective, false, `${channel} is not active by default`);
    }
    assert.equal(defaults.channels.facebook.inbound_enabled, true, "AI setting does not disable inbound");
    assert.equal(defaults.channels.instagram.manual_staff_handling, true, "AI setting does not disable staff replies");
    assert.equal((await get(null)).status, 401, "read requires an authenticated session");
    assert.equal((await put(viewerCookie, "facebook", true)).status, 403, "write requires integration management permission");

    let saved = await put(adminCookie, "facebook", true);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).channel.effective, true);
    let current = (await (await get(adminCookie)).json()).channels;
    assert.equal(current.facebook.enabled, true);
    assert.equal(current.instagram.enabled, false, "Facebook enablement does not enable Instagram");
    assert.equal(current.whatsapp.enabled, false, "social setting does not modify WhatsApp");

    saved = await put(adminCookie, "instagram", true);
    assert.equal(saved.status, 200);
    assert.equal((await (await get(adminCookie)).json()).channels.instagram.effective, true);
    assert.equal((await put(adminCookie, "facebook", false)).status, 200);
    current = (await (await get(adminCookie)).json()).channels;
    assert.equal(current.facebook.enabled, false);
    assert.equal(current.instagram.enabled, true, "disabling Facebook leaves Instagram enabled");

    const originalSet = store.setRuntimeSetting.bind(store);
    const originalAudit = store.appendAuditEvent.bind(store);
    const originalGet = store.getRuntimeSetting.bind(store);
    const savedState = async (response, expectedStatus, expectedEnabled, expectedAudit) => {
      assert.equal(response.status, expectedStatus);
      const body = await response.json();
      assert.equal(body.channel?.enabled, expectedEnabled);
      assert.equal(body.audit_recorded, expectedAudit);
      return body;
    };

    // The API reports the committed setting and audit outcome, never a generic
    // failure that could leave the UI showing a stale switch value.
    store.setRuntimeSetting = (...args) => originalSet(...args);
    store.appendAuditEvent = (...args) => originalAudit(...args);
    await savedState(await put(adminCookie, "facebook", true), 200, true, undefined);
    assert.ok(store.state.audit_events.some((row) => row.action === "channel_autonomy_setting_changed" && row.resource_id === CHANNELS.facebook.key && row.status === "success"),
      "successful setting persistence has its corresponding success audit");

    store.setRuntimeSetting = async () => { throw new Error("fixture save failed"); };
    let outcome = await (await put(adminCookie, "facebook", false)).json();
    assert.equal(outcome.setting_saved, "unknown");
    assert.equal(outcome.actual.enabled, true, "failed write reads back the unchanged persisted value");

    store.setRuntimeSetting = async (...args) => { await originalSet(...args); throw new Error("lost write response"); };
    outcome = await (await put(adminCookie, "facebook", false)).json();
    assert.equal(outcome.setting_saved, "unknown", "ambiguous write is not called a definite failure");
    assert.equal(outcome.actual.enabled, false, "ambiguous write returns actual persisted state");

    store.setRuntimeSetting = (...args) => originalSet(...args);
    store.appendAuditEvent = async () => { throw new Error("fixture audit failure"); };
    outcome = await (await put(adminCookie, "facebook", true)).json();
    assert.equal(outcome.error, "setting_saved_audit_failed");
    assert.equal(outcome.setting_saved, true);
    assert.equal(outcome.audit_recorded, false);
    assert.equal(outcome.channel.enabled, true, "audit failure reports saved backend state");

    store.appendAuditEvent = (...args) => originalAudit(...args);
    store.getRuntimeSetting = async () => { throw new Error("fixture readback failure"); };
    outcome = await (await put(adminCookie, "facebook", false)).json();
    assert.equal(outcome.error, "setting_readback_mismatch");
    assert.equal(outcome.setting_saved, "unknown");
    assert.equal(outcome.audit_recorded, true);

    store.setRuntimeSetting = async () => { throw new Error("ambiguous write"); };
    outcome = await (await put(adminCookie, "facebook", false)).json();
    assert.equal(outcome.error, "setting_state_unverified");
    assert.equal(outcome.setting_saved, "unknown");
    assert.equal(outcome.actual, null, "unreadable state is not guessed");

    store.setRuntimeSetting = originalSet;
    store.appendAuditEvent = originalAudit;
    store.getRuntimeSetting = originalGet;

    await store.setRuntimeSetting(CHANNELS.instagram.key, "true", "fixture-corruption");
    const malformed = await readChannelAutonomySetting(store, "instagram");
    assert.equal(malformed.known, false);
    assert.equal(malformed.enabled, false);
    assert.equal((await evaluateChannelAutonomy(store, "instagram", { configured: true })).allowed, false);
    await store.setRuntimeSetting(CHANNELS.instagram.key, false, "admin@example.test");

    const gated = { ...config, metaSocialAiChannels: [] };
    const gatedBase = await start(gated);
    const gatedResponse = await fetch(`${gatedBase}/api/lead-agents/admin/settings/channel-autonomy`, {
      method: "PUT", headers: { "content-type": "application/json", cookie: adminCookie }, body: JSON.stringify({ channel: "instagram", enabled: true }),
    });
    assert.equal(gatedResponse.status, 409, "social AI cannot be switched on without explicit deployment gates");
    assert.equal((await store.getRuntimeSetting(CHANNELS.instagram.key)).value, false, "rejected enable does not persist a latent ON value");

    const originalRead = store.getRuntimeSetting.bind(store);
    store.getRuntimeSetting = async () => { throw new Error("fixture unavailable"); };
    const unreadable = await (await get(adminCookie)).json();
    for (const channel of Object.keys(CHANNELS)) {
      assert.equal(unreadable.channels[channel].enabled, false);
      assert.equal(unreadable.channels[channel].effective, false);
      assert.equal(unreadable.channels[channel].state, "unknown_fail_closed");
    }
    store.getRuntimeSetting = originalRead;
    console.log(JSON.stringify({ status: "PASS", suite: "channel-autonomy-settings", channels: 3 }));
  } finally {
    for (const server of servers) await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
