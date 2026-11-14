// Content → Posts & Comments, slice C1: signed ingestion of public Facebook Page and Instagram comments, attached to the post
// they were left on, and read-only Content API. Synthetic fixtures only; no Meta, Graph, Backend or production access.
// Proves: separate switch from DMs; signature and asset checks; deduplication; ordering, edits, hide/unhide and final deletion
// with text redaction; threads; no CRM lead, DM conversation, WhatsApp or Graph side effects; Content permissions; commenter
// platform ids never returned or logged; and the service-role-only SQL function on a real Postgres engine (PGlite).
"use strict";
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { rm } = require("node:fs/promises");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { parseComments } = require("../src/lead-agents/meta-social-inbound");

const SECRET = "synthetic-comments-secret";
const PAGE = "910000000000001", IG = "910000000000002";
const nowSec = () => Math.floor(Date.now() / 1000);
let checks = 0;
const pass = (text) => { checks += 1; console.log(`PASS ${text}`); };

const feed = (verb, { comment = "910000000000001_c1", post = "910000000000001_p1", parent = null, from = { id: "920000000000001", name: "Synthetic Commenter" }, message = "Synthetic comment text", time = nowSec(), asset = PAGE } = {}) =>
  ({ object: "page", entry: [{ id: asset, time, changes: [{ field: "feed", value: { item: "comment", verb, comment_id: comment, post_id: post, parent_id: parent || post, from, message, created_time: time } }] }] });
const igComment = ({ id = "17900000000000001", media = "17800000000000001", parent = null, text = "Synthetic Instagram comment", from = { id: "930000000000001", username: "synthetic_user" }, time = nowSec() } = {}) =>
  ({ object: "instagram", entry: [{ id: IG, time, changes: [{ field: "comments", value: { id, text, from, media: { id: media, media_product_type: "FEED" }, ...(parent ? { parent_id: parent } : {}) } }] }] });

async function sqlChecks() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table office_content_items (id text primary key, title text not null);`);
  await db.exec(readFileSync(path.join(__dirname, "../db/20261114_meta_social_posts_comments.sql"), "utf8"));
  const call = (args) => db.query("select public.office_record_social_comment_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as r", args).then((x) => x.rows[0].r);
  const key = (n) => "meta-comment:event:" + String(n).repeat(64).slice(0, 64);
  const t = (s) => new Date(Date.UTC(2026, 9, 1, 10, 0, s)).toISOString();
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(call(["facebook", PAGE, "p", "c", null, "add", key(1), t(0), null, null, false, "x"]), { code: "42501" });
    await db.exec("reset role");
  }
  await db.exec("set role service_role");
  assert.equal(await call(["facebook", PAGE, "p", "c", null, "add", key(1), t(0), "920000000000001", "A", false, "first"]), "accepted");
  assert.equal(await call(["facebook", PAGE, "p", "c", null, "add", key(1), t(0), "920000000000001", "A", false, "first"]), "duplicate");
  assert.equal(await call(["facebook", PAGE, "p", "c", null, "edited", key(2), t(5), null, null, false, "second"]), "accepted");
  assert.equal(await call(["facebook", PAGE, "p", "c", null, "edited", key(3), t(2), null, null, false, "older"]), "stale");
  assert.equal(await call(["facebook", PAGE, "p", "c", null, "hide", key(4), t(6), null, null, false, null]), "accepted");
  assert.equal(await call(["facebook", PAGE, "p", "c", null, "remove", key(5), t(7), null, null, false, null]), "accepted");
  assert.equal(await call(["facebook", PAGE, "p", "c", null, "unhide", key(6), t(9), null, null, false, null]), "stale");
  const row = (await db.query("select body, visibility, deleted_at is not null as deleted from office_social_comments where provider_comment_id='c'")).rows[0];
  assert.deepEqual(row, { body: null, visibility: "hidden", deleted: true });
  assert.equal((await db.query("select count(*)::int n from office_social_comment_events")).rows[0].n, 6);
  await assert.rejects(call(["facebook", PAGE, "p", "c2", null, "add", "bad-key", t(1), null, null, false, "x"]), { code: "22023" });
  await assert.rejects(call(["facebook", PAGE, "other-post", "c", null, "add", key(7), t(10), null, null, false, "x"]), { code: "23505" });
  const grants = (await db.query(`select count(*)::int n from information_schema.role_table_grants where table_name like 'office_social_%' and grantee in ('anon','authenticated','PUBLIC')`)).rows[0].n;
  const rls = (await db.query(`select bool_and(relrowsecurity) ok from pg_class where relname like 'office_social_%' and relkind='r'`)).rows[0].ok;
  assert.equal(grants, 0); assert.equal(rls, true);
  pass("SQL: service-role-only function; dedupe, stale ordering, hide, final deletion with redaction, invalid key and post conflict rejected; RLS on, no anon/authenticated grants");
  await db.close();
}

async function main() {
  await sqlChecks();

  // parser unit checks
  const config = { facebookPageId: PAGE, instagramBusinessAccountId: IG };
  let parsed = parseComments(feed("add"), config);
  assert.equal(parsed.comments.length, 1); assert.equal(parsed.comments[0].parent, null); assert.match(parsed.comments[0].eventKey, /^meta-comment:event:[0-9a-f]{64}$/);
  assert.equal(parseComments(feed("add"), config).comments[0].eventKey, parsed.comments[0].eventKey);
  parsed = parseComments({ object: "page", entry: [{ id: PAGE, time: nowSec(), changes: [{ field: "feed", value: { item: "reaction", verb: "add", post_id: "p" } }, { field: "feed", value: { item: "post", verb: "add", post_id: "p" } }] }] }, config);
  assert.deepEqual([parsed.comments.length, parsed.skipped], [0, 2]);
  parsed = parseComments(feed("add", { comment: "bad id with spaces" }), config); assert.deepEqual([parsed.comments.length, parsed.skipped], [0, 1]);
  parsed = parseComments(feed("add", { message: "x".repeat(8001) }), config); assert.equal(parsed.comments.length, 0);
  parsed = parseComments(feed("add", { time: nowSec() + 3600 }), config); assert.equal(parsed.comments.length, 0);
  parsed = parseComments(feed("add", { asset: "999" }), config); assert.deepEqual([parsed.comments.length, parsed.skipped], [0, 1]);
  parsed = parseComments(feed("add", { from: { id: PAGE, name: "Our Page" } }), config); assert.equal(parsed.comments[0].authorIsPage, true);
  pass("parser: comment items only, invalid id / oversize / future time / foreign asset skipped, stable event keys, Page-authored flagged");

  const { store, tempDir } = await createTempStore();
  await store.ensureAdminUser({ email: "content@synthetic.invalid", password_hash: hashPassword("synthetic-pass-123"), role: "super_admin", display_name: "Synthetic", status: "active" });
  await store.ensureAdminUser({ email: "resident@synthetic.invalid", password_hash: hashPassword("synthetic-pass-123"), role: "resident", display_name: "Synthetic", status: "active" });
  await store.ensureAdminUser({ email: "agent@synthetic.invalid", password_hash: hashPassword("synthetic-pass-123"), role: "ai_agent", display_name: "Synthetic", status: "active" });
  const servers = [], logs = [], graphCalls = [];
  const mk = () => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 1000 });
  const noCalls = () => assert.fail("comment ingestion must not call WhatsApp");
  const start = async (overrides = {}) => {
    const cfg = { ...createConfig(), authMode: "required_api_key", apiKeys: ["synthetic-api"], allowedOrigins: [], metaAppSecret: SECRET, metaSocialVerifyToken: "synthetic-verify",
      facebookPageId: PAGE, instagramBusinessAccountId: IG, officeBackendBaseUrl: "", metaSocialInboundEnabled: false, metaSocialInboundChannels: ["facebook", "instagram"], metaSocialCommentsInboundEnabled: false, ...overrides };
    const server = buildServer({ config: cfg, store, rateLimiter: mk(), publicRateLimiter: mk(), officeRateLimiter: mk(), loginRateLimiter: mk(),
      whatsappAdapter: { extractEvents: noCalls, verifySignature: noCalls, sendTextMessage: noCalls, isConfigured: () => false },
      metaSocialReplyAdapter: { sendTextMessage: async () => { graphCalls.push(1); assert.fail("comment ingestion must not call Graph"); } }, openaiClient: {}, toolExecutor: {} });
    servers.push(server);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return `http://127.0.0.1:${server.address().port}`;
  };
  // One global capture: server log lines (JSON) are recorded for the privacy check; the test's own lines still print.
  const originalLog = console.log;
  console.log = (...x) => { const line = x.join(" "); if (line.startsWith("{")) logs.push(line); else originalLog(...x); };
  const post = async (base, body, secret = SECRET) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const r = await fetch(base + "/webhooks/meta-social", { method: "POST", headers: { "content-type": "application/json",
      ...(secret ? { "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` } : {}) }, body: raw });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const login = async (base, email) => {
    const r = await fetch(base + "/api/lead-agents/admin/session/login", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email, password: "synthetic-pass-123" }) });
    assert.equal(r.status, 200, email);
    return r.headers.get("set-cookie").split(";")[0];
  };
  const get = async (base, route, cookie) => { const r = await fetch(base + route, { headers: cookie ? { cookie } : {} }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const leadsBefore = store.state.leads.length, convBefore = store.state.conversations.length;

  try {
    // switches
    const off = await start();
    assert.equal((await post(off, feed("add"))).status, 404);
    const dmOnly = await start({ metaSocialInboundEnabled: true });
    const dmResponse = await post(dmOnly, feed("add"));
    assert.equal(dmResponse.status, 200); assert.deepEqual(Object.keys(dmResponse.json).sort(), ["accepted", "duplicate", "failed", "ok", "skipped"]);
    assert.equal(dmResponse.json.skipped, 1); assert.equal(store.state.office_social_comments.length, 0);
    pass("both switches off -> 404; DMs on, comments off -> comment changes skipped, nothing stored, DM response shape unchanged");

    const base = await start({ metaSocialCommentsInboundEnabled: true });
    const dmMessage = { object: "page", entry: [{ id: PAGE, time: Date.now(), messaging: [{ sender: { id: "940000000000001" }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: "m_syn", text: "hello" } }] }] };
    const dmSkipped = await post(base, dmMessage);
    assert.equal(dmSkipped.status, 200); assert.equal(dmSkipped.json.skipped, 1); assert.equal(store.state.leads.length, leadsBefore);
    assert.equal((await post(base, feed("add"), null)).status, 403);
    assert.equal((await post(base, feed("add"), "wrong-secret")).status, 403);
    assert.equal(store.state.office_social_comments.length, 0);
    pass("comments on, DMs off -> DM entries skipped (no lead); unsigned and forged callbacks refused, nothing stored");

    // ingestion + dedupe
    const first = feed("add");
    const results = await Promise.all(Array.from({ length: 8 }, () => post(base, first)));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(results.reduce((n, r) => n + r.json.comments_accepted, 0), 1);
    assert.equal(results.reduce((n, r) => n + r.json.comments_duplicate, 0), 7);
    assert.equal(store.state.office_social_posts.length, 1); assert.equal(store.state.office_social_comments.length, 1);
    pass("same comment event delivered 8x concurrently -> 1 post, 1 comment, 1 event (7 duplicates)");

    const t0 = nowSec();
    await post(base, feed("add", { comment: "910000000000001_c2", parent: "910000000000001_c1", message: "Synthetic reply", time: t0 }));
    await post(base, feed("add", { comment: "910000000000001_c3", from: { id: PAGE, name: "Synthetic Page" }, message: "Thanks from the Page", time: t0 }));
    await post(base, feed("edited", { message: "Edited synthetic text", time: t0 + 2 }));
    const stale = await post(base, feed("edited", { message: "Older edit", time: t0 - 30 }));
    assert.equal(stale.json.comments_stale, 1);
    await post(base, feed("hide", { message: undefined, time: t0 + 3 }));
    await post(base, feed("unhide", { message: undefined, time: t0 + 4 }));
    await post(base, feed("add", { comment: "910000000000001_c4", message: "To be removed", time: t0 }));
    await post(base, feed("remove", { comment: "910000000000001_c4", message: undefined, time: t0 + 5 }));
    const revived = await post(base, feed("edited", { comment: "910000000000001_c4", message: "revived?", time: t0 + 9 }));
    assert.equal(revived.json.comments_stale, 1);
    const c1 = store.state.office_social_comments.find((c) => c.provider_comment_id === "910000000000001_c1");
    const c4 = store.state.office_social_comments.find((c) => c.provider_comment_id === "910000000000001_c4");
    assert.equal(c1.body, "Edited synthetic text"); assert.equal(c1.visibility, "visible");
    assert.equal(c4.body, null); assert.ok(c4.deleted_at);
    pass("edits, older edit ignored (stale), hide then unhide, removal is final and redacts the stored text");

    await post(base, igComment());
    await post(base, igComment({ id: "17900000000000002", parent: "17900000000000001", text: "Synthetic IG reply" }));
    assert.equal(store.state.office_social_posts.filter((p) => p.channel === "instagram").length, 1);
    assert.equal(store.state.office_social_comments.filter((c) => c.channel === "instagram").length, 2);
    pass("Instagram comment and threaded reply recorded on the Instagram media, separate from the Facebook post");

    // separation
    assert.equal(store.state.leads.length, leadsBefore); assert.equal(store.state.conversations.length, convBefore);
    assert.equal((store.state.lead_channel_states || []).length, 0); assert.equal((store.state.whatsapp_manual_sends || []).length, 0);
    assert.equal(graphCalls.length, 0);
    pass("no CRM lead, DM conversation, channel state or send ledger created; no Graph call");

    // Content API + permissions
    assert.ok([401, 403].includes((await get(base, "/api/lead-agents/admin/content/social-posts")).status));
    for (const email of ["resident@synthetic.invalid", "agent@synthetic.invalid"]) {
      assert.equal((await get(base, "/api/lead-agents/admin/content/social-posts", await login(base, email))).status, 403, email);
    }
    const cookie = await login(base, "content@synthetic.invalid");
    const list = await get(base, "/api/lead-agents/admin/content/social-posts", cookie);
    assert.equal(list.status, 200); assert.equal(list.json.enabled, true); assert.equal(list.json.posts.length, 2);
    const fbPost = list.json.posts.find((p) => p.channel === "facebook");
    assert.deepEqual(fbPost.comment_counts, { total: 4, visible: 3, hidden: 0, deleted: 1 });
    const detail = await get(base, `/api/lead-agents/admin/content/social-posts/${fbPost.id}`, cookie);
    assert.equal(detail.status, 200); assert.equal(detail.json.comments.length, 4);
    assert.ok(detail.json.comments.every((c) => !("author_provider_id" in c)));
    assert.equal(detail.json.comments.find((c) => c.provider_comment_id === "910000000000001_c3").author_is_page, true);
    assert.equal(detail.json.comments.find((c) => c.provider_comment_id === "910000000000001_c2").provider_parent_id, "910000000000001_c1");
    assert.equal(detail.json.comments.find((c) => c.provider_comment_id === "910000000000001_c4").body, null);
    assert.equal((await get(base, "/api/lead-agents/admin/content/social-posts/not-a-uuid", cookie)).status, 404);
    assert.equal((await fetch(base + "/api/lead-agents/admin/content/social-posts", { method: "POST", headers: { cookie } })).status, 405);
    const offView = await get(off, "/api/lead-agents/admin/content/social-posts", await login(off, "content@synthetic.invalid"));
    assert.equal(offView.json.enabled, false);
    pass("Content API: content.write required (no session, resident and ai_agent refused); posts with counts, threaded comments, Page flag, deleted text withheld, no commenter platform ids; read-only");

    // privacy of logs
    const joined = logs.join("\n");
    assert.ok(logs.some((l) => l.includes("meta_social_webhook.batch")), "webhook batch log lines were captured");
    for (const needle of ["Synthetic comment text", "Edited synthetic text", "920000000000001", "910000000000001_c1", "synthetic_user"]) assert.ok(!joined.includes(needle), needle);
    pass("webhook logs carry counts only: no comment text, commenter ids or comment ids");
  } finally {
    console.log = originalLog;
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    await rm(tempDir, { recursive: true, force: true });
  }
  console.log(`\nMeta social comments (Content → Posts & Comments, C1): ${checks} checks PASS`);
}

main().catch((error) => { console.error(error); process.exit(1); });
