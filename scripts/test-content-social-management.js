"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { createMetaSocialPublishingAdapter, normalizePublished } = require("../src/lead-agents/meta-social-publishing");
const { createMetaSocialCommentReplyAdapter } = require("../src/lead-agents/meta-social-comment-replies");
const { createMetaSocialAnalyticsAdapter } = require("../src/lead-agents/meta-social-analytics");
const media = require("../src/lead-agents/content-social-media");
const { normalizeSocialContent } = require("../src/lead-agents/social-content");
const { createTempStore } = require("../src/lead-agents/testing");

let checks = 0;
function pass(label) { checks++; console.log(`PASS ${label}`); }
const TOKEN = "synthetic-social-token";
const CFG = { facebookPageId: "910000000000001", instagramBusinessAccountId: "910000000000002", facebookPageAccessToken: TOKEN,
  instagramAccessToken: "", metaSocialGraphVersion: "v27.0" };

async function adapterChecks() {
  const calls = [];
  let photoResponse = { id: "photo-1", post_id: "page-post-1" };
  const post = async (url, body, opts) => {
    calls.push({ method: "POST", url, body, opts });
    if (url.endsWith("/photos")) return { data: photoResponse };
    if (url.endsWith("/media")) return { data: { id: "container-1" } };
    if (url.endsWith("/media_publish")) return { data: { id: "ig-post-1", permalink: "https://www.instagram.com/p/fixture/" } };
    if (url.includes("/comments") || url.includes("/replies")) return { data: { id: "reply-1" } };
    return { data: { id: "910000000000001_123", permalink_url: "https://www.facebook.com/fixture/posts/123" } };
  };
  const get = async (url, opts) => {
    calls.push({ method: "GET", url, opts });
    if (opts.params?.fields === "status_code") return { data: { status_code: "FINISHED" } };
    const metric = opts.params.metric;
    return { data: { data: metric === "post_clicks" ? [] : [{ name: metric, values: [{ value: metric === "post_reactions_like_total" ? 0 : 9 }] }] } };
  };
  const publish = createMetaSocialPublishingAdapter(CFG, { post, get, sleep: async () => {} });
  assert.equal((await publish.publish("facebook", { caption: "Fixture", mediaUrl: null, mediaType: "none" })).status, "published");
  assert.match(calls.at(-1).url, /\/910000000000001\/feed$/);
  const image = "https://office.ochiga.com.ng/media/test.png";
  assert.equal((await publish.publish("facebook", { caption: "Fixture image", mediaUrl: image, mediaType: "image" })).status, "published");
  assert.match(calls.at(-1).url, /\/photos$/);
  assert.equal((await publish.publish("facebook", { caption: "Fixture image", mediaUrl: image, mediaType: "image" })).providerPostId, "page-post-1");
  assert.equal((await publish.publish("facebook", { caption: "Fixture image", mediaUrl: image, mediaType: "image" })).providerMediaId, "photo-1");
  photoResponse = { post_id: "page-post-only" };
  assert.equal((await publish.publish("facebook", { caption: "Fixture image", mediaUrl: image, mediaType: "image" })).providerPostId, "page-post-only");
  photoResponse = { id: "photo-only" };
  const photoOnly = await publish.publish("facebook", { caption: "Fixture image", mediaUrl: image, mediaType: "image" });
  assert.equal(photoOnly.status, "unknown"); assert.equal(photoOnly.providerPostId, undefined); assert.equal(photoOnly.providerMediaId, "photo-only");
  photoResponse = { id: "photo-1", post_id: "page-post-1" };
  assert.equal(normalizePublished({ id: "photo-only" }, { pagePhoto: true }).status, "unknown");
  assert.equal((await publish.publish("instagram", { caption: "Fixture image", mediaUrl: image, mediaType: "image" })).status, "published");
  assert.deepEqual(calls.slice(-2).map((c) => c.url.split("/").at(-1)), ["media", "media_publish"]);
  await publish.publish("instagram", { caption: "Fixture reel", mediaUrl: image, mediaType: "video" });
  assert.ok(calls.some((c) => c.method === "GET" && c.opts.params.fields === "status_code"));
  assert.ok(calls.every((c) => c.opts.headers.Authorization === `Bearer ${TOKEN}`));
  assert.ok(calls.every((c) => !c.url.includes(TOKEN) && !JSON.stringify(c.opts.params || {}).includes(TOKEN)));
  const denied = createMetaSocialPublishingAdapter(CFG, { post: async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); } });
  assert.equal((await denied.publish("facebook", { caption: "x", mediaUrl: null, mediaType: "none" })).status, "unknown");
  pass("Facebook photo response IDs prefer the canonical post id, retain media id, and never confirm from photo id alone; text/reel contracts remain intact");

  const replies = createMetaSocialCommentReplyAdapter(CFG, { post });
  assert.equal((await replies.reply("facebook", "comment-1", "Reply")).status, "published");
  assert.match(calls.at(-1).url, /comment-1\/comments$/);
  assert.equal((await replies.reply("instagram", "comment-2", "Reply")).status, "published");
  assert.match(calls.at(-1).url, /comment-2\/replies$/);
  pass("Facebook and Instagram public comment reply edges remain channel-specific");

  const analytics = createMetaSocialAnalyticsAdapter(CFG, { get });
  const result = await analytics.read("facebook", "post-1", "PHOTO");
  assert.equal(result.metrics.post_reactions_like_total, 0, "zero remains a real metric value");
  assert.ok(result.unavailable.includes("post_clicks"), "missing metric is unavailable, not zero");
  pass("analytics preserve zero versus unavailable metrics");
}

async function contractChecks() {
  const image = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  assert.equal(media.validateSocialMedia(image, "image/jpeg").extension, ".jpg");
  assert.equal(media.validateSocialMedia(image, "image/jpeg", { channels: ["instagram"] }).extension, ".jpg");
  assert.throws(() => media.validateSocialMedia(Buffer.alloc(8 * 1024 * 1024 + 1, 0xff), "image/jpeg", { channels: ["instagram"] }), /instagram_image_too_large/);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.throws(() => media.validateSocialMedia(png, "image/png", { channels: ["instagram"] }), /instagram_image_must_be_jpeg/);
  assert.throws(() => media.validateSocialMedia(Buffer.from("RIFFxxxxWEBP"), "image/webp", { channels: ["instagram"] }), /instagram_image_must_be_jpeg/);
  assert.throws(() => media.validateSocialMedia(image, "image/gif", { channels: ["facebook"] }), /unsupported_media_type/);
  assert.equal(media.validateSocialMedia(png, "image/png", { channels: ["facebook"] }).extension, ".png");
  assert.equal(media.validateSocialMedia(Buffer.from("RIFFxxxxWEBP"), "image/webp", { channels: ["facebook"] }).extension, ".webp");
  assert.equal(normalizeSocialContent({ instagram: { enabled: true, caption: "caption", media_type: "none" } }).ok, false);
  assert.equal(normalizeSocialContent({ facebook: { enabled: true, caption: "Text only", media_type: "none" } }).ok, true);
  assert.equal(normalizeSocialContent({ instagram: { enabled: true, caption: "caption", media_type: "image", media_filename: "content_social_media_a_0123456789ab.png" } }).error, "instagram_image_must_be_jpeg");
  const grant = media.createSocialMediaGrant("content_social_media_a_0123456789ab.jpg", "synthetic-secret", Date.now());
  assert.equal(media.verifySocialMediaGrant("content_social_media_a_0123456789ab.jpg", grant.expires, grant.signature, "synthetic-secret"), true);
  assert.equal(media.verifySocialMediaGrant("content_social_media_a_0123456789ab.jpg", grant.expires, "0".repeat(64), "synthetic-secret"), false);
  pass("media validation, Instagram requires media, Facebook text works, signed media grant rejects tampering");
}

async function sqlChecks() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table public.office_content_items(id text primary key, title text not null);
    create table public.office_social_posts(id uuid primary key default gen_random_uuid(), channel text not null, asset_id text not null,
      provider_post_id text not null, content_item_id text references public.office_content_items(id), origin text not null default 'external',
      caption text, permalink_url text, media_type text, published_at timestamptz, sync_status text not null default 'not_synced', synced_at timestamptz,
      unique(channel,asset_id,provider_post_id));
    create table public.office_social_comments(id uuid primary key default gen_random_uuid(), post_id uuid not null references public.office_social_posts(id),
      channel text not null, asset_id text not null, provider_comment_id text not null, deleted_at timestamptz, author_is_page boolean not null default false);
    grant select, insert, update, delete on public.office_content_items, public.office_social_posts, public.office_social_comments to service_role;
  `);
  await db.exec(readFileSync(path.join(__dirname, "../db/20261119_content_social_management.sql"), "utf8"));
  await db.exec("set role service_role");
  await db.query("insert into public.office_content_items(id,title) values('item-1','Synthetic')");
  await db.query("update public.office_content_items set social_content='{" + '"facebook":{"enabled":true,"caption":"Approved post","media_type":"none"}' + "}'::jsonb where id='item-1'");
  const fp = "a".repeat(64), requestId = "request_123456789012345";
  const start = async (overrides = {}) => (await db.query(`select public.office_start_social_publish($1,$2,$3,$4,$5,$6,$7,$8) as row`,
    [overrides.contentItemId || "item-1", overrides.channel || "facebook", overrides.assetId || CFG.facebookPageId, overrides.fingerprint || fp,
      overrides.requestId || requestId, "staff-1", "staff@example.test", null])).rows[0].row;
  const first = await start();
  assert.equal(first.status, "publishing");
  const duplicate = await start();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.id, first.id);
  await assert.rejects(start({ contentItemId: "other-item" }), (error) => error.code === "22023");
  assert.equal((await db.query("select public.office_mark_social_publish_dispatch($1,$2,'staff-1','staff@example.test') as ok", [first.id, first.dispatch_token])).rows[0].ok, true);
  const settled = await db.query(`select public.office_settle_social_publish($1,$2,'published','post-1',null,'https://www.facebook.com/page/posts/1',null) as ok`, [first.id, first.dispatch_token]);
  assert.equal(settled.rows[0].ok, true);
  const savedPost = (await db.query("select content_item_id,origin,caption,media_type from public.office_social_posts where provider_post_id='post-1'")).rows[0];
  assert.equal(savedPost.origin, "office"); assert.equal(savedPost.caption, "Approved post"); assert.equal(savedPost.media_type, "none");
  assert.equal((await db.query("select provider_media_id from public.office_social_posts where provider_post_id='post-1'")).rows[0].provider_media_id, null);

  const schedule = async (item, channel, req, asset) => (await db.query(
    "select public.office_start_social_publish($1,$2,$3,$4,$5,'staff-1','staff@example.test',now()+interval '1 minute') as row",
    [item, channel, asset, fp, req])).rows[0].row;
  const claim = async (item) => (await db.query("select * from public.office_claim_due_social_publishes(now()+interval '2 minutes',20)")).rows.find((row) => row.content_item_id === item);
  await db.query("insert into public.office_content_items(id,title) values('item-2','Synthetic 2'),('item-3','Synthetic 3'),('item-4','Synthetic 4'),('item-5','Synthetic 5')");
  await schedule("item-2", "facebook", "request_active_12345678", CFG.facebookPageId);
  const active = await claim("item-2");
  assert.equal(active.status, "publishing");
  assert.equal((await db.query("select count(*)::int as n from public.office_recover_stale_social_publishes(now()-interval '1 minute',100)")).rows[0].n, 0, "a fresh claim remains active");

  await schedule("item-3", "instagram", "request_predispatch_1234", CFG.instagramBusinessAccountId);
  const preDispatch = await claim("item-3");
  const preRecovered = await db.query("select * from public.office_recover_stale_social_publishes(now()+interval '1 day',100)");
  const failedBeforeDispatch = preRecovered.rows.find((row) => row.id === preDispatch.id);
  assert.equal(failedBeforeDispatch.status, "failed");
  assert.equal(failedBeforeDispatch.failure_code, "dispatch_not_started");
  assert.equal((await db.query("select event_type from public.office_social_publish_events where publish_attempt_id=$1 order by created_at desc limit 1", [preDispatch.id])).rows[0].event_type, "stale_pre_dispatch_failed");

  await schedule("item-4", "facebook", "request_uncertain_123456", CFG.facebookPageId);
  const uncertain = await claim("item-4");
  assert.equal((await db.query("select public.office_mark_social_publish_dispatch($1,$2,'staff-1','staff@example.test') as ok", [uncertain.id, uncertain.dispatch_token])).rows[0].ok, true);
  assert.equal((await db.query("select public.office_mark_social_publish_dispatch($1,$2,'staff-1','staff@example.test') as ok", [uncertain.id, uncertain.dispatch_token])).rows[0].ok, false, "dispatch boundary is one-shot");
  const recoveryRace = await Promise.all([
    db.query("select * from public.office_recover_stale_social_publishes(now()+interval '1 day',100)"),
    db.query("select * from public.office_recover_stale_social_publishes(now()+interval '1 day',100)"),
  ]);
  assert.equal(recoveryRace.flatMap((result) => result.rows).filter((row) => row.id === uncertain.id).length, 1, "competing recoveries record exactly one transition");
  const unknown = (await db.query("select * from public.office_social_publish_attempts where id=$1", [uncertain.id])).rows[0];
  assert.equal(unknown.status, "unknown"); assert.equal(unknown.failure_code, "stale_dispatch_unknown");
  assert.equal((await db.query("select event_type from public.office_social_publish_events where publish_attempt_id=$1 order by created_at desc limit 1", [uncertain.id])).rows[0].event_type, "stale_dispatch_unknown");
  const blockedRetry = (await db.query(`select public.office_start_social_publish('item-4','facebook',$1,$2,'request_retry_123456789','staff-1','staff@example.test',null) as row`, [CFG.facebookPageId, fp])).rows[0].row;
  assert.equal(blockedRetry.status, "unknown", "unknown cannot be automatically republished"); assert.equal(blockedRetry.duplicate, true);
  await assert.rejects(db.query("select public.office_authorize_social_publish_retry($1,'staff-1','staff@example.test',false)", [uncertain.id]), { code: "22023" });
  assert.equal((await db.query("select public.office_authorize_social_publish_retry($1,'staff-1','staff@example.test',true) as ok", [uncertain.id])).rows[0].ok, true);
  assert.equal((await db.query("select public.office_authorize_social_publish_retry($1,'staff-1','staff@example.test',true) as ok", [uncertain.id])).rows[0].ok, false, "already reconciled authorization is one-shot");
  const authorizedRetry = (await db.query(`select public.office_start_social_publish('item-4','facebook',$1,$2,'request_retry_223456789012345','staff-1','staff@example.test',null) as row`, [CFG.facebookPageId, fp])).rows[0].row;
  assert.equal(authorizedRetry.status, "publishing"); assert.notEqual(authorizedRetry.id, uncertain.id);
  assert.equal((await db.query("select count(*)::int as n from public.office_social_publish_events where publish_attempt_id=$1 and event_type='manual_retry_authorized'", [uncertain.id])).rows[0].n, 1);

  await schedule("item-5", "facebook", "request_completed_123456", CFG.facebookPageId);
  const completed = await claim("item-5");
  assert.equal((await db.query("select public.office_mark_social_publish_dispatch($1,$2,'staff-1','staff@example.test') as ok", [completed.id, completed.dispatch_token])).rows[0].ok, true);
  assert.equal((await db.query(`select public.office_settle_social_publish($1,$2,'published','verified-post',null,'https://www.facebook.com/page/posts/verified',null) as ok`, [completed.id, completed.dispatch_token])).rows[0].ok, true);
  const afterReconcile = await db.query("select * from public.office_recover_stale_social_publishes(now()+interval '1 day',100)");
  assert.equal(afterReconcile.rows.some((row) => row.id === completed.id), false, "already reconciled success remains terminal");

  const post = await db.query(`insert into public.office_social_posts(channel,asset_id,provider_post_id) values('facebook',$1,'p-c') returning id`, [CFG.facebookPageId]);
  const comment = await db.query(`insert into public.office_social_comments(post_id,channel,asset_id,provider_comment_id) values($1,'facebook',$2,'c-1') returning id`, [post.rows[0].id, CFG.facebookPageId]);
  const reply = await db.query(`select public.office_start_social_comment_reply($1,'facebook',$2,'reply_request_1234567','staff-1','staff@example.test','hello') as row`, [comment.rows[0].id, CFG.facebookPageId]);
  assert.equal(reply.rows[0].row.status, "publishing");
  const duplicateReply = await db.query(`select public.office_start_social_comment_reply($1,'facebook',$2,'reply_request_1234567','staff-1','staff@example.test','hello') as row`, [comment.rows[0].id, CFG.facebookPageId]);
  assert.equal(duplicateReply.rows[0].row.duplicate, true);
  const blockedReply = await db.query(`select public.office_start_social_comment_reply($1,'facebook',$2,'reply_request_2234567','staff-2','staff2@example.test','again') as row`, [comment.rows[0].id, CFG.facebookPageId]);
  assert.equal(blockedReply.rows[0].row.status, "blocked");
  const replySettled = await db.query(`select public.office_settle_social_comment_reply($1,$2,'unknown',null,'provider_outcome_unknown') as ok`, [reply.rows[0].row.id, reply.rows[0].row.dispatch_token]);
  assert.equal(replySettled.rows[0].ok, true);
  await db.query(`select public.office_upsert_social_post_analytics($1,'facebook','{"likes":0}'::jsonb,array['reach'],now())`, [post.rows[0].id]);
  const analytics = await db.query("select metrics,unavailable_metrics from public.office_social_post_analytics where post_id=$1", [post.rows[0].id]);
  assert.equal(analytics.rows[0].metrics.likes, 0); assert.deepEqual(analytics.rows[0].unavailable_metrics, ["reach"]);
  await db.exec("reset role; set role anon");
  await assert.rejects(db.query("select * from public.office_social_publish_attempts"), { code: "42501" });
  await db.exec("reset role");
  pass("migration: stale pre-dispatch failure, post-dispatch UNKNOWN, atomic recovery/audit, one-shot dispatch, explicit retry authorization, terminal reconciliation, RLS and service-role isolation");
}

async function fileStoreChecks() {
  const { store, tempDir } = await createTempStore();
  try {
    const scheduledAt = new Date(Date.now() + 60_000).toISOString();
    const scheduled = await store.startSocialPublish({ contentItemId: "content-1", channel: "facebook", assetId: CFG.facebookPageId,
      contentFingerprint: "b".repeat(64), requestId: "file_req_1234567890123", actorId: "staff-1", actorEmail: "staff@example.test", scheduledAt });
    assert.equal(scheduled.content_item_id, "content-1"); assert.equal(scheduled.request_id, "file_req_1234567890123"); assert.equal(scheduled.scheduled_at, scheduledAt);
    assert.equal((await store.startSocialPublish({ contentItemId: "content-1", channel: "facebook", assetId: CFG.facebookPageId,
      contentFingerprint: "b".repeat(64), requestId: "file_req_1234567890123", scheduledAt })).duplicate, true);
    const [claimed] = await store.claimDueSocialPublishes(new Date(Date.now() + 120_000));
    assert.equal(claimed.status, "publishing"); assert.ok(claimed.dispatch_token);
  assert.equal(await store.markSocialPublishDispatch({ id: claimed.id, dispatchToken: claimed.dispatch_token, actorId: "staff-1", actorEmail: "staff@example.test" }), true);
  assert.equal(await store.settleSocialPublish({ id: claimed.id, dispatchToken: claimed.dispatch_token, status: "published", providerPostId: "p-1", providerMediaId: "photo-1" }), true);
    assert.equal((await store.listSocialPublishAttempts("content-1"))[0].provider_post_id, "p-1");
  assert.equal((await store.listSocialPublishAttempts("content-1"))[0].provider_media_id, "photo-1");
    const replyInput = { commentId: "comment-1", channel: "instagram", assetId: CFG.instagramBusinessAccountId,
      requestId: "file_reply_123456789", actorId: "staff-1", actorEmail: "staff@example.test", body: "A public reply" };
    const reply = await store.startSocialCommentReply(replyInput);
    assert.equal(reply.comment_id, "comment-1"); assert.equal((await store.startSocialCommentReply(replyInput)).duplicate, true);
    assert.equal(await store.settleSocialCommentReply({ id: reply.id, dispatchToken: reply.dispatch_token, status: "unknown", failureCode: "provider_outcome_unknown" }), true);
    await store.upsertSocialPostAnalytics({ postId: "post-1", channel: "facebook", metrics: { likes: 0 }, unavailable: ["reach"], fetchedAt: new Date().toISOString() });
    const snapshot = await store.getSocialPostAnalytics("post-1");
    assert.equal(snapshot.metrics.likes, 0); assert.deepEqual(snapshot.unavailable_metrics, ["reach"]);
    const uncertainInput = { contentItemId: "content-2", channel: "instagram", assetId: CFG.instagramBusinessAccountId,
      contentFingerprint: "c".repeat(64), requestId: "file_uncertain_12345678", actorId: "staff-1", actorEmail: "staff@example.test", scheduledAt: null };
    const uncertain = await store.startSocialPublish(uncertainInput);
    assert.equal(await store.markSocialPublishDispatch({ id: uncertain.id, dispatchToken: uncertain.dispatch_token, actorId: "staff-1", actorEmail: "staff@example.test" }), true);
    const staleAt = new Date(Date.now() - 600_000).toISOString();
    const fileRow = store.state.office_social_publish_attempts.find((row) => row.id === uncertain.id);
    fileRow.dispatched_at = staleAt; fileRow.provider_dispatch_started_at = staleAt;
    const competingRecoveries = await Promise.all([store.recoverStaleSocialPublishes(new Date()), store.recoverStaleSocialPublishes(new Date())]);
    assert.equal(competingRecoveries.flat().filter((row) => row.id === uncertain.id).length, 1);
    assert.equal((await store.getSocialPublishAttempt(uncertain.id, "content-2")).status, "unknown");
    assert.equal((await store.startSocialPublish({ ...uncertainInput, requestId: "file_retry_12345678901" })).duplicate, true);
    assert.equal(await store.authorizeSocialPublishRetry({ id: uncertain.id, actorId: "staff-1", actorEmail: "staff@example.test", acknowledgeUncertainty: true }), true);
    const explicitRetry = await store.startSocialPublish({ ...uncertainInput, requestId: "file_retry_22345678901" });
    assert.equal(explicitRetry.status, "publishing"); assert.notEqual(explicitRetry.id, uncertain.id);
    assert.equal((await store.listSocialPublishEvents([uncertain.id])).filter((event) => event.event_type === "manual_retry_authorized").length, 1);
  } finally {
    const fs = require("node:fs/promises"); await fs.rm(tempDir, { recursive: true, force: true });
  }
  pass("file store preserves the snake-case ledger contract, scheduled claims, duplicate fence, reply outcomes and analytics snapshots");
}

async function main() {
  await contractChecks();
  await adapterChecks();
  await sqlChecks();
  await fileStoreChecks();
  console.log(`Content social management: ${checks} checks passed.`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
