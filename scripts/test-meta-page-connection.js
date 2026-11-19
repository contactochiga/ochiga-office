"use strict";

const assert = require("node:assert/strict");
const {
  createMetaPageConnection, encryptToken, decryptToken, makeState, verifyState,
  PAGE_WEBHOOK_FIELDS, STATE_COOKIE,
} = require("../src/lead-agents/meta-page-connection");

const key = Buffer.alloc(32, 17).toString("base64");
const config = () => ({
  metaAppId: "app-123", metaAppSecret: "app-secret-never-returned", metaSocialGraphVersion: "v26.0",
  metaOAuthRedirectUri: "https://office.example.test/api/lead-agents/admin/meta/oauth/callback",
  metaSocialWebhookCallbackUrl: "https://office.example.test/webhooks/meta-social",
  metaTokenEncryptionKey: key, sessionSecret: "test-session-secret", environment: "test",
  facebookPageId: "", facebookPageAccessToken: "", instagramBusinessAccountId: "ig-77",
});

function memoryStore() {
  const values = new Map();
  return {
    values,
    async getRuntimeSetting(id) { return values.has(id) ? { key: id, value: values.get(id) } : null; },
    async setRuntimeSetting(id, value, actor) { const previous = values.has(id) ? { key: id, value: values.get(id) } : null; values.set(id, value); return { previous, current: { key: id, value, updated_by: actor } }; },
  };
}

async function run() {
  const encrypted = encryptToken("page-secret", config());
  assert.equal(decryptToken(encrypted, config()), "page-secret");
  assert.equal(JSON.stringify(encrypted).includes("page-secret"), false);
  assert.throws(() => decryptToken({ ...encrypted, tag: Buffer.alloc(16).toString("base64url") }, config()), /decryption_failed/);
  assert.throws(() => encryptToken("token", { metaTokenEncryptionKey: "bad" }), /encryption_not_configured/);

  const cfg = config();
  const store = memoryStore();
  let now = 1_800_000_000_000;
  const graphCalls = [];
  let pageFields = ["messages"];
  const http = async (request) => {
    graphCalls.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/oauth/access_token") && request.params.code) return { status: 200, data: { access_token: "short-lived-user-token" } };
    if (path.endsWith("/oauth/access_token") && request.params.grant_type) return { status: 200, data: { access_token: "long-lived-user-token" } };
    if (path.endsWith("/me/permissions")) return { status: 200, data: { data: [
      { permission: "pages_show_list", status: "granted" }, { permission: "pages_manage_metadata", status: "granted" },
      { permission: "pages_messaging", status: "granted" }, { permission: "instagram_basic", status: "granted" },
      { permission: "instagram_manage_messages", status: "granted" },
    ] } };
    if (path.endsWith("/me/accounts")) return { status: 200, data: { data: [
      { id: "12345", name: "Ochiga", access_token: "page-token-secret", tasks: ["MESSAGING", "MANAGE"], instagram_business_account: { id: "ig-77", username: "ochigaglobal" } },
    ] } };
    if (path.endsWith("/12345/subscribed_apps") && request.method === "POST") { pageFields = request.params.subscribed_fields.split(","); return { status: 200, data: { success: true } }; }
    if (path.endsWith("/12345/subscribed_apps")) return { status: 200, data: { data: [{ id: "app-123", name: "Ochiga Systems", subscribed_fields: pageFields }] } };
    if (path.endsWith("/app-123/subscriptions")) return { status: 200, data: { data: [
      { object: "page", callback_url: cfg.metaSocialWebhookCallbackUrl, fields: PAGE_WEBHOOK_FIELDS.map((name) => ({ name })) },
      { object: "instagram", callback_url: cfg.metaSocialWebhookCallbackUrl, fields: [{ name: "messages" }] },
      { object: "whatsapp_business_account", callback_url: "https://office.example.test/webhooks/whatsapp", fields: [{ name: "messages" }] },
    ] } };
    throw new Error(`unexpected_graph_request:${path}`);
  };
  const integration = createMetaPageConnection({ config: cfg, store, http, now: () => now });
  const started = await integration.begin("admin-user-1");
  const authUrl = new URL(started.url);
  assert.equal(authUrl.searchParams.get("redirect_uri"), cfg.metaOAuthRedirectUri);
  const requestedScopes = authUrl.searchParams.get("scope").split(",");
  assert.ok(requestedScopes.includes("pages_show_list"));
  assert.ok(["pages_manage_posts", "pages_read_engagement", "pages_read_user_content", "pages_manage_engagement", "read_insights", "instagram_content_publish", "instagram_manage_comments", "instagram_manage_insights"].every((scope) => requestedScopes.includes(scope)), "OAuth requests the Meta permissions needed for publishing, public comment replies and analytics");
  assert.ok(started.cookie.includes("HttpOnly") && started.cookie.includes("SameSite=Lax"));
  const state = authUrl.searchParams.get("state");
  assert.ok(verifyState(state, state, cfg, "admin-user-1", now));
  assert.equal(verifyState(state, state, cfg, "different-user", now), null);
  assert.equal(verifyState(state, `${state}x`, cfg, "admin-user-1", now), null);
  assert.equal(verifyState(state, state, cfg, "admin-user-1", now + 600_001), null);
  await assert.rejects(integration.complete({ code: "oauth-code", state, cookie: `${state}wrong`, actorId: "admin-user-1" }), /state_invalid/);

  const completed = await integration.complete({ code: "oauth-code", state, cookie: state, actorId: "admin-user-1" });
  assert.equal(completed.pageCount, 1);
  const candidates = await integration.listCandidates("admin-user-1", completed.reference);
  assert.equal(candidates.pages[0].id, "12345");
  assert.equal(candidates.pages[0].connected_instagram, true);
  assert.equal(JSON.stringify(candidates).includes("page-token-secret"), false);
  assert.equal(JSON.stringify(store.values).includes("page-token-secret"), false);
  assert.equal((await integration.listCandidates("other-admin", completed.reference)).pages.length, 0);
  const mismatchedConfig = config();
  mismatchedConfig.facebookPageId = "99999";
  const mismatch = createMetaPageConnection({ config: mismatchedConfig, store, http, now: () => now });
  await assert.rejects(mismatch.selectPage("admin-user-1", "12345", completed.reference), /differs_from_active_page/);
  const connection = await integration.selectPage("admin-user-1", "12345", completed.reference);
  assert.equal(connection.facebook.status, "oauth_saved");
  assert.equal(connection.facebook.page_name, "Ochiga");
  assert.equal(connection.instagram.status, "linked_to_page");
  assert.equal(cfg.facebookPageAccessToken, "page-token-secret");
  assert.equal(cfg.facebookPageId, "12345");
  assert.equal(JSON.stringify(connection).includes("page-token-secret"), false);

  const webhook = await integration.webhookStatus();
  assert.equal(webhook.page.complete, true);
  assert.equal(webhook.repair_allowed, true);
  assert.equal(webhook.repair_needed, true);
  assert.equal(webhook.instagram.messages_field_present, true);
  assert.equal(webhook.whatsapp.app_subscription_configured, true);
  const repaired = await integration.repairPageWebhook();
  assert.equal(repaired.page.complete, true);
  assert.equal(repaired.repair_needed, false);
  assert.ok(graphCalls.some((call) => call.method === "POST" && call.params.subscribed_fields === PAGE_WEBHOOK_FIELDS.join(",")));
  const deniedConfig = { ...cfg, metaSocialWebhookCallbackUrl: "https://wrong.example/webhooks/meta-social" };
  const deniedRepair = createMetaPageConnection({ config: deniedConfig, store, http, now: () => now });
  const writesBeforeDeniedRepair = graphCalls.filter((call) => call.method === "POST").length;
  assert.equal((await deniedRepair.webhookStatus()).repair_allowed, false);
  await assert.rejects(deniedRepair.repairPageWebhook(), /meta_app_webhook_not_ready/);
  assert.equal(graphCalls.filter((call) => call.method === "POST").length, writesBeforeDeniedRepair, "repair refuses before Graph mutation if callback does not match");
  assert.equal(Object.values(started).join("").includes("app-secret-never-returned"), false);

  const badRedirect = config();
  badRedirect.metaOAuthRedirectUri = "https://evil.example/callback";
  await assert.rejects(createMetaPageConnection({ config: badRedirect, store, http }).begin("admin-user-1"), /redirect_path_invalid/);
  assert.equal(STATE_COOKIE, "office_meta_oauth_state");
  console.log("Meta Page connection tests passed: OAuth state, encrypted token storage, Page discovery/selection, Page binding and webhook repair.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
