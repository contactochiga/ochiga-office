"use strict";

const assert = require("node:assert/strict");
const { rm } = require("node:fs/promises");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const contentIntegrity = require("../src/lead-agents/content-integrity");
const { SupabaseLeadAgentsStore } = require("../src/lead-agents/store-supabase");

async function main() {
  const { store, tempDir } = await createTempStore();
  const calls = { publish: 0, reply: 0, analytics: 0 };
  await store.ensureAdminUser({ email: "publisher@synthetic.invalid", password_hash: hashPassword("synthetic-pass-123"), role: "super_admin", display_name: "Synthetic Publisher", status: "active" });
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["synthetic-api"], allowedOrigins: [], sessionSecret: "synthetic-session-secret-longer-than-32",
    officeAppUrl: "https://office.example.test", facebookPageId: "910000000000001", instagramBusinessAccountId: "910000000000002",
    facebookPageAccessToken: "synthetic-token", metaSocialGraphVersion: "v27.0", metaSocialPublishingEnabled: true,
    metaPageConnection: { page: { id: "910000000000001", tasks: ["CREATE_CONTENT", "MODERATE", "ANALYZE"], instagram: { id: "910000000000002" } },
      grantedPermissions: ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "pages_read_user_content", "pages_manage_engagement", "read_insights", "instagram_basic", "instagram_content_publish", "instagram_manage_comments", "instagram_manage_insights"] },
    metaSocialPublishingChannels: ["facebook"], metaSocialPublishingSchedulerEnabled: false,
    metaSocialCommentRepliesEnabled: true, metaSocialCommentReplyChannels: ["facebook"],
    metaSocialAnalyticsEnabled: true, metaSocialAnalyticsChannels: ["facebook"] };
  const socialPublish = { configured: (channel) => channel === "facebook", publish: async () => { calls.publish++; return { status: "published", providerPostId: `provider-${calls.publish}`, permalink: "https://www.facebook.com/page/posts/1" }; } };
  const commentReply = { configured: (channel) => channel === "facebook", reply: async () => { calls.reply++; return { status: "published", providerReplyId: "reply-1" }; } };
  const analytics = { configured: (channel) => channel === "facebook", read: async () => { calls.analytics++; return { status: "available", metrics: { likes: 0 }, unavailable: ["reach"] }; } };
  const limiter = () => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5000 });
  const server = buildServer({ config, store, rateLimiter: limiter(), publicRateLimiter: limiter(), officeRateLimiter: limiter(), loginRateLimiter: limiter(),
    whatsappAdapter: { isConfigured: () => false }, metaSocialPublishingAdapter: socialPublish, metaSocialCommentReplyAdapter: commentReply,
    metaSocialAnalyticsAdapter: analytics, openaiClient: {}, toolExecutor: {} });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "publisher@synthetic.invalid", password: "synthetic-pass-123" }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const item = await store.createContentItem({ title: "Synthetic social launch", social_content: { facebook: { enabled: true, caption: "Synthetic approved copy", media_type: "none" } }, created_by: "writer@synthetic.invalid" });
    const approval = contentIntegrity.buildApproval(item, "reviewer@synthetic.invalid");
    await store.updateContentItem(item.id, { workflow_status: "approved", metadata: { approval } });
    const publishUrl = `${base}/api/lead-agents/admin/content/${item.id}/social-publish`;
    const send = (requestId, channels = ["facebook"], targetId = item.id) => fetch(base + "/api/lead-agents/admin/content/" + targetId + "/social-publish", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ channels, client_request_id: requestId }) });
    let response = await send("publish_request_123456789");
    assert.equal(response.status, 200); assert.equal((await response.json()).outcomes[0].status, "published");
    assert.equal(calls.publish, 1);
    assert.equal(store.state.office_social_posts[0].caption, "Synthetic approved copy");
    response = await send("publish_request_123456789");
    assert.equal((await response.json()).outcomes[0].duplicate, true); assert.equal(calls.publish, 1);
    const instagramOff = await send("publish_request_223456789", ["instagram"]);
    assert.equal((await instagramOff.json()).outcomes[0].code, "channel_not_enabled_or_configured"); assert.equal(calls.publish, 1);

    const post = store.state.office_social_posts[0];
    const commentId = "00000000-0000-4000-8000-000000000111";
    store.state.office_social_comments.push({ id: commentId, post_id: post.id, channel: "facebook", asset_id: config.facebookPageId,
      provider_comment_id: "provider-comment-1", provider_parent_id: null, author_is_page: false, deleted_at: null, body: "Fixture comment", visibility: "visible" });
    const replyUrl = `${base}/api/lead-agents/admin/content/social-posts/${post.id}/comments/${commentId}/replies`;
    response = await fetch(replyUrl, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "Thanks (fixture)", client_request_id: "comment_reply_123456789" }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).status, "published"); assert.equal(calls.reply, 1);
    assert.equal(store.state.office_social_comment_replies[0].provider_reply_id, "reply-1");
    const analyticsUrl = `${base}/api/lead-agents/admin/content/social-posts/${post.id}/analytics`;
    response = await fetch(analyticsUrl, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" });
    assert.equal(response.status, 200); assert.equal(calls.analytics, 1);
    assert.equal(store.state.office_social_post_analytics[0].metrics.likes, 0);
    await store.upsertSocialPostAnalytics({ postId: post.id, channel: "facebook", metrics: { likes: 1 }, unavailable: [], fetchedAt: new Date(Date.now() + 1000).toISOString() });
    const analyticsHistory = await fetch(analyticsUrl, { headers: { cookie } });
    const historyBody = await analyticsHistory.json();
    assert.equal(historyBody.history.length, 2); assert.equal(historyBody.history[0].metrics.likes, 1);
    const savedPermissions = config.metaPageConnection.grantedPermissions;
    config.metaPageConnection.grantedPermissions = savedPermissions.filter((permission) => permission !== "pages_manage_posts");
    const unverified = await store.createContentItem({ title: "Missing permission fixture", social_content: { facebook: { enabled: true, caption: "Must not dispatch", media_type: "none" } } });
    const unverifiedApproval = contentIntegrity.buildApproval(unverified, "reviewer@synthetic.invalid");
    await store.updateContentItem(unverified.id, { workflow_status: "approved", metadata: { approval: unverifiedApproval } });
    const blocked = await send("publish_request_323456789", ["facebook"], unverified.id);
    assert.equal((await blocked.json()).outcomes[0].code, "meta_permissions_not_verified");
    assert.equal(calls.publish, 1, "unverified permission blocks before provider dispatch");
    config.metaPageConnection.grantedPermissions = savedPermissions.filter((permission) => permission !== "pages_manage_engagement");
    const blockedCommentId = "00000000-0000-4000-8000-000000000112";
    store.state.office_social_comments.push({ id: blockedCommentId, post_id: post.id, channel: "facebook", asset_id: config.facebookPageId,
      provider_comment_id: "provider-comment-2", author_is_page: false, deleted_at: null, body: "Fixture comment 2", visibility: "visible" });
    const blockedReply = await fetch(base + "/api/lead-agents/admin/content/social-posts/" + post.id + "/comments/" + blockedCommentId + "/replies", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: "Must not dispatch", client_request_id: "comment_reply_223456789" }) });
    assert.equal(blockedReply.status, 403); assert.equal(calls.reply, 1, "unverified comment permission blocks before provider dispatch");
    config.metaPageConnection.grantedPermissions = savedPermissions.filter((permission) => permission !== "read_insights");
    const blockedAnalytics = await fetch(analyticsUrl, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" });
    assert.equal(blockedAnalytics.status, 403); assert.equal(calls.analytics, 1, "unverified insights permission blocks before provider dispatch");
    config.metaPageConnection.grantedPermissions = savedPermissions;

    const staleItem = await store.createContentItem({ title: "Stale dispatch fixture", social_content: { facebook: { enabled: true, caption: "Stale fixture", media_type: "none" } } });
    const staleApproval = contentIntegrity.buildApproval(staleItem, "reviewer@synthetic.invalid");
    await store.updateContentItem(staleItem.id, { workflow_status: "approved", metadata: { approval: staleApproval } });
    const staleAttempt = await store.startSocialPublish({ contentItemId: staleItem.id, channel: "facebook", assetId: config.facebookPageId,
      contentFingerprint: contentIntegrity.contentFingerprint(staleItem), requestId: "stale_attempt_123456789", actorId: "staff", actorEmail: "publisher@synthetic.invalid", scheduledAt: null });
    const staleTime = new Date(Date.now() - config.metaSocialPublishingRecoveryThresholdMs - 10_000).toISOString();
    const staleRow = store.state.office_social_publish_attempts.find((row) => row.id === staleAttempt.id);
    staleRow.dispatched_at = staleTime; staleRow.provider_dispatch_started_at = staleTime;
    const staleList = await fetch(`${base}/api/lead-agents/admin/content/${staleItem.id}/social-publish`, { headers: { cookie } });
    const staleBody = await staleList.json();
    assert.equal(staleBody.attempts[0].status, "unknown");
    assert.ok(staleBody.events.some((event) => event.event_type === "stale_dispatch_unknown"));
    const recoveryUrl = `${base}/api/lead-agents/admin/content/${staleItem.id}/social-publish/${staleAttempt.id}/recover`;
    const rejectedRecovery = await fetch(recoveryUrl, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ acknowledge_uncertain_outcome: false }) });
    assert.equal(rejectedRecovery.status, 400); assert.equal(calls.publish, 1, "recovery never dispatches automatically");
    const authorizedRecovery = await fetch(recoveryUrl, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ acknowledge_uncertain_outcome: true }) });
    assert.equal(authorizedRecovery.status, 200); assert.equal(calls.publish, 1, "explicit authorization only unlocks a later manual action");
    const manualRetry = await send("stale_manual_retry_123456", ["facebook"], staleItem.id);
    assert.equal((await manualRetry.json()).outcomes[0].status, "published"); assert.equal(calls.publish, 2);

    const pngData = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")}`;
    const rejectedInstagramImage = await fetch(`${base}/api/lead-agents/admin/content/social-media`, { method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ data_url: pngData, channels: ["instagram"] }) });
    assert.equal(rejectedInstagramImage.status, 415); assert.equal((await rejectedInstagramImage.json()).error, "instagram_image_must_be_jpeg");
    const acceptedFacebookImage = await fetch(`${base}/api/lead-agents/admin/content/social-media`, { method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ data_url: pngData, channels: ["facebook"] }) });
    assert.equal(acceptedFacebookImage.status, 201);
    const supabaseStore = new SupabaseLeadAgentsStore({ url: "https://supabase.example.test", serviceRoleKey: "synthetic" });
    let historyQuery = "";
    supabaseStore.client.get = async (path) => { historyQuery = path; return { data: [{ fetched_at: "2026-01-02T00:00:00.000Z" }, { fetched_at: "2026-01-01T00:00:00.000Z" }] }; };
    const pageHistory = await supabaseStore.listSocialPostAnalytics("post-fixture", 12);
    assert.equal(pageHistory.length, 2); assert.match(historyQuery, /post_id=eq\.post-fixture.*order=fetched_at\.desc.*limit=12/);
    console.log("PASS authenticated Content routes: approved publishing/idempotency, Instagram channel remains independently off, public reply ledger, analytics history, stale claim recovery and explicit retry authorization");
    console.log("PASS Instagram PNG rejected before storage/provider use; Facebook PNG remains accepted");
    console.log("PASS missing publishing, comment-reply and insights permissions block provider dispatch even when feature flags and token are configured; paginated analytics history uses newest-first Supabase reads");
    console.log("Content social routes: 18 checks passed.");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
