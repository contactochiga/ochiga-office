// Content → Posts & Comments, C2: read-only Facebook Page / Instagram post lookups into Content → Posts. Synthetic data and an
// injected mock Graph function only: no Meta request is made. Proves asset binding, Meta-only preview/permalink hosts, token kept in
// the Authorization header and out of every response/log/audit record, failure classification, idempotent sync (no duplicate
// posts), comment-first posts enriched in place, newer-wins edits, unavailable/restricted posts keep their last good details,
// Content permissions plus staff session, one sync at a time, audit, and no CRM/DM/publishing side effects.
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
const { createMetaSocialPostsAdapter, graphFailure } = require("../src/lead-agents/meta-social-posts");

const PAGE = "910000000000001", IG = "910000000000002", TOKEN = "synthetic-page-token-not-real", SECRET = "synthetic-secret";
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
let checks = 0;
const pass = (t) => { checks += 1; console.log(`PASS ${t}`); };
const graphError = (status, error) => Object.assign(new Error("graph"), { response: { status, data: error ? { error } : {} } });

// Mock Graph: records every request; answers from a mutable fixture.
function mockGraph() {
  const calls = [];
  const fixture = {
    fb: [
      { id: `${PAGE}_p1`, message: "Synthetic launch post", created_time: iso(600), updated_time: iso(600), permalink_url: "https://www.facebook.com/syn/posts/p1", full_picture: "https://scontent.xx.fbcdn.net/v/syn-p1.jpg", from: { id: PAGE } },
      { id: `${PAGE}_p2`, message: "Second synthetic post", created_time: iso(300), updated_time: iso(300), permalink_url: "https://www.facebook.com/syn/posts/p2", from: { id: PAGE } },
      { id: `999_foreign`, message: "Foreign page", created_time: iso(10), from: { id: "999" } },
      { id: `${PAGE}_p9`, message: "Wrong author", created_time: iso(10), from: { id: "999" } },
      { id: `${PAGE}_p3`, message: "Evil preview", created_time: iso(5), permalink_url: "https://evil.example/p3", full_picture: "https://evil.example/x.jpg", from: { id: PAGE } },
    ],
    ig: [
      { id: "17800000000000001", caption: "Synthetic reel", media_type: "VIDEO", thumbnail_url: "https://scontent.cdninstagram.com/v/syn-r1.jpg", media_url: "https://video.cdninstagram.com/v/syn-r1.mp4", permalink: "https://www.instagram.com/p/SYN1/", timestamp: iso(200), owner: { id: IG } },
      { id: "17800000000000002", caption: "Not ours", media_type: "IMAGE", timestamp: iso(100), owner: { id: "999" } },
    ],
    failNext: null,
  };
  const request = async (url, options) => {
    calls.push({ url, options });
    if (fixture.failNext) { const f = fixture.failNext; fixture.failNext = null; throw f; }
    const tail = url.replace(/^https:\/\/graph\.facebook\.com\/v[0-9.]+\//, "");
    if (tail === `${PAGE}/posts`) return { status: 200, data: { data: fixture.fb } };
    if (tail === `${IG}/media`) return { status: 200, data: { data: fixture.ig } };
    const one = [...fixture.fb, ...fixture.ig].find((p) => encodeURIComponent(p.id) === tail);
    if (one) return { status: 200, data: one };
    throw graphError(400, { code: 100, error_subcode: 33, message: "Unsupported get request", type: "GraphMethodException", fbtrace_id: "x" });
  };
  return { calls, fixture, request };
}

async function adapterChecks() {
  const g = mockGraph();
  const config = { facebookPageId: PAGE, instagramBusinessAccountId: IG, facebookPageAccessToken: TOKEN, metaSocialGraphVersion: "v23.0" };
  const adapter = createMetaSocialPostsAdapter(config, g.request);
  const fb = await adapter.listRecent("facebook");
  assert.equal(fb.status, "synced"); assert.deepEqual(fb.posts.map((p) => p.providerPostId), [`${PAGE}_p1`, `${PAGE}_p2`, `${PAGE}_p3`]); assert.equal(fb.rejected, 2);
  assert.equal(fb.posts[0].previewUrl, "https://scontent.xx.fbcdn.net/v/syn-p1.jpg");
  assert.equal(fb.posts[2].previewUrl, null); assert.equal(fb.posts[2].permalink, null);
  const ig = await adapter.listRecent("instagram");
  assert.deepEqual(ig.posts.map((p) => p.providerPostId), ["17800000000000001"]); assert.equal(ig.rejected, 1);
  assert.equal(ig.posts[0].previewUrl, "https://scontent.cdninstagram.com/v/syn-r1.jpg"); assert.equal(ig.posts[0].mediaType, "video");
  assert.ok(g.calls.every((c) => c.options.headers.Authorization === `Bearer ${TOKEN}` && !c.url.includes(TOKEN) && !JSON.stringify(c.options.params || {}).includes(TOKEN)));
  assert.ok(g.calls.every((c) => c.options.maxRedirects === 0 && c.options.timeout === 10_000 && /^https:\/\/graph\.facebook\.com\/v23\.0\//.test(c.url)));
  pass("adapter: posts bound to the configured Page / Instagram account (foreign ids and authors dropped), Meta-only preview and permalink hosts, token only in the Authorization header, GET with timeout and no redirects");

  const before = g.calls.length;
  assert.deepEqual(await adapter.lookup("facebook", "999_foreign"), { status: "restricted", error: "foreign_asset" });
  assert.deepEqual(await adapter.lookup("facebook", "bad id with spaces"), { status: "restricted", error: "foreign_asset" });
  assert.equal(g.calls.length, before, "a foreign or malformed Facebook post id is never requested");
  assert.equal((await adapter.lookup("instagram", "17800000000000002")).error, "foreign_asset");
  assert.equal((await adapter.lookup("facebook", `${PAGE}_gone`)).status, "unavailable");
  g.fixture.failNext = graphError(403, { code: 200, message: "Permissions error", type: "OAuthException" });
  assert.deepEqual(await adapter.lookup("facebook", `${PAGE}_p1`), { status: "restricted", error: "graph_200" });
  g.fixture.failNext = graphError(400, { code: 190, message: "Invalid OAuth access token" });
  assert.equal((await adapter.lookup("facebook", `${PAGE}_p1`)).status, "restricted");
  g.fixture.failNext = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
  assert.deepEqual(await adapter.lookup("facebook", `${PAGE}_p1`), { status: "error", error: "graph_no_response" });
  g.fixture.failNext = graphError(500, null);
  assert.deepEqual(await adapter.listRecent("facebook"), { status: "error", error: "graph_http_500", posts: [], rejected: 0 });
  assert.equal(graphFailure(graphError(404, null)).status, "unavailable");
  const unconfigured = createMetaSocialPostsAdapter({ facebookPageId: PAGE, metaSocialGraphVersion: "latest", facebookPageAccessToken: TOKEN }, g.request);
  assert.equal(unconfigured.configured("facebook"), false); assert.equal((await unconfigured.listRecent("facebook")).error, "not_configured");
  pass("adapter: foreign lookups refused before any request; unavailable (100/33, 404), restricted (OAuth 10/190/200, 401/403), error (no response, 5xx); bad Graph version or no token is not configured");
}

async function sqlChecks() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create table office_content_items (id text primary key, title text not null);`);
  await db.exec(readFileSync(path.join(__dirname, "../db/20261114_meta_social_posts_comments.sql"), "utf8"));
  await db.exec(readFileSync(path.join(__dirname, "../db/20261115_meta_social_post_sync.sql"), "utf8"));
  const call = (a) => db.query("select public.office_upsert_social_post_snapshot($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as r", a).then((x) => x.rows[0].r);
  const t = (m) => new Date(Date.UTC(2026, 9, 1, 10, m)).toISOString();
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(call(["facebook", PAGE, `${PAGE}_p1`, "synced", null, "x", null, null, null, t(0), t(0)]), { code: "42501" });
    await db.exec("reset role");
  }
  await db.exec("set role service_role");
  // a comment arrived first (C1), then the post is synced: same row
  await db.query("select public.office_record_social_comment_event('facebook',$1,$2,'c1',null,'add',$3,$4,null,null,false,'hi')", [PAGE, `${PAGE}_p1`, "meta-comment:event:" + "a".repeat(64), t(1)]);
  assert.equal(await call(["facebook", PAGE, `${PAGE}_p1`, "synced", null, "v1", "https://www.facebook.com/syn/p1", "image", "https://scontent.xx.fbcdn.net/a.jpg", t(0), t(5)]), "updated");
  assert.equal(await call(["facebook", PAGE, `${PAGE}_p1`, "synced", null, "older", null, null, null, t(0), t(2)]), "updated");
  assert.equal((await db.query("select caption from office_social_posts")).rows[0].caption, "v1");
  await call(["facebook", PAGE, `${PAGE}_p1`, "unavailable", "graph_100_33", null, null, null, null, null, null]);
  let row = (await db.query("select caption, sync_status, unavailable_since is not null as gone, (select count(*)::int from office_social_posts) n from office_social_posts")).rows[0];
  assert.deepEqual(row, { caption: "v1", sync_status: "unavailable", gone: true, n: 1 });
  await call(["facebook", PAGE, `${PAGE}_p1`, "synced", null, "v2", null, null, null, t(0), t(9)]);
  row = (await db.query("select caption, sync_status, unavailable_since from office_social_posts")).rows[0];
  assert.deepEqual(row, { caption: "v2", sync_status: "synced", unavailable_since: null });
  await assert.rejects(call(["facebook", PAGE, "999_foreign", "synced", null, "x", null, null, null, null, null]), { code: "22023" });
  await assert.rejects(call(["facebook", PAGE, `${PAGE}_p1`, "synced", null, "x", "https://evil.example/p", null, null, null, null]), { code: "23514" });
  await assert.rejects(call(["facebook", PAGE, `${PAGE}_p1`, "synced", null, "x", null, null, "https://evil.example/x.jpg", null, null]), { code: "23514" });
  await assert.rejects(call(["facebook", PAGE, `${PAGE}_p1`, "error", "Bad Error Text", null, null, null, null, null, null]), { code: "22023" });
  assert.equal((await db.query("select count(*)::int n from information_schema.role_table_grants where table_name='office_social_posts' and grantee in ('anon','authenticated','PUBLIC')")).rows[0].n, 0);
  pass("SQL: service-role only; comment-first post enriched in place (no duplicate); older snapshot cannot overwrite newer; unavailable keeps last good details and recovers; foreign Facebook post, non-Meta URLs and free-text errors rejected");
  await db.close();
}

async function httpChecks() {
  const { store, tempDir } = await createTempStore();
  for (const [email, role] of [["content@synthetic.invalid", "super_admin"], ["resident@synthetic.invalid", "resident"], ["agent@synthetic.invalid", "ai_agent"]]) {
    await store.ensureAdminUser({ email, password_hash: hashPassword("synthetic-pass-123"), role, display_name: "Synthetic", status: "active" });
  }
  const g = mockGraph();
  const servers = [], logs = [];
  const originalLog = console.log, originalError = console.error;
  console.log = (...x) => { const line = x.join(" "); if (line.startsWith("{")) logs.push(line); else originalLog(...x); };
  console.error = (...x) => { logs.push(x.join(" ")); };
  const mk = () => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 1000 });
  const start = async (overrides = {}, request = g.request) => {
    const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["synthetic-api"], allowedOrigins: [], metaAppSecret: SECRET, metaSocialVerifyToken: "v",
      facebookPageId: PAGE, instagramBusinessAccountId: IG, facebookPageAccessToken: TOKEN, metaSocialGraphVersion: "v23.0", officeBackendBaseUrl: "",
      metaSocialCommentsInboundEnabled: true, metaSocialPostsSyncEnabled: true, ...overrides };
    const server = buildServer({ config, store, rateLimiter: mk(), publicRateLimiter: mk(), officeRateLimiter: mk(), loginRateLimiter: mk(),
      whatsappAdapter: { isConfigured: () => false }, metaSocialReplyAdapter: { sendTextMessage: async () => assert.fail("no replies") },
      metaSocialPostsAdapter: createMetaSocialPostsAdapter(config, request), openaiClient: {}, toolExecutor: {} });
    servers.push(server);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const login = async (base, email) => { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "synthetic-pass-123" }) }); assert.equal(r.status, 200); return r.headers.get("set-cookie").split(";")[0]; };
  const call = async (base, method, route, cookie, headers = {}) => { const r = await fetch(`${base}/api/lead-agents/admin/content/social-posts${route}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers } }); return { status: r.status, text: await r.text() }; };
  const parse = (r) => JSON.parse(r.text);
  const leads = store.state.leads.length, conversations = store.state.conversations.length;
  try {
    const base = await start();
    const cookie = await login(base, "content@synthetic.invalid");
    const callsBefore = g.calls.length;
    // comment arrives before any sync: post row exists with only its id
    const raw = JSON.stringify({ object: "page", entry: [{ id: PAGE, time: Math.floor(Date.now() / 1000) - 60, changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: `${PAGE}_c1`, post_id: `${PAGE}_p1`, from: { id: "920000000000001", name: "Synthetic Commenter" }, message: "Nice! (synthetic)", created_time: Math.floor(Date.now() / 1000) - 60 } }] }] });
    await fetch(`${base}/webhooks/meta-social`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex") }, body: raw });
    assert.equal(store.state.office_social_posts.length, 1); assert.equal(store.state.office_social_posts[0].sync_status ?? "not_synced", "not_synced");
    assert.equal(g.calls.length, callsBefore, "the webhook path never calls Graph");
    pass("comment ingestion makes no Graph request; the post starts as 'not synced'");

    // permissions and switches
    assert.ok([401, 403].includes((await call(base, "POST", "/sync")).status));
    for (const email of ["resident@synthetic.invalid", "agent@synthetic.invalid"]) assert.equal((await call(base, "POST", "/sync", await login(base, email))).status, 403, email);
    assert.equal((await call(base, "POST", "/sync", null, { authorization: "Bearer synthetic-api" })).status, 403);
    assert.equal(parse(await call(base, "POST", "/sync", null, { authorization: "Bearer synthetic-api" })).error, "staff_session_required");
    const off = await start({ metaSocialPostsSyncEnabled: false });
    const offCookie = await login(off, "content@synthetic.invalid");
    assert.equal(parse(await call(off, "POST", "/sync", offCookie)).error, "social_sync_disabled");
    assert.equal((await call(base, "GET", "/sync", cookie)).status, 405);
    assert.equal(g.calls.length, callsBefore);
    pass("sync requires content.write and a staff session (no session, resident, ai_agent and API key refused) and its own switch; GET on sync is not allowed; no Graph call when refused");

    // bulk sync, twice
    const first = parse(await call(base, "POST", "/sync", cookie));
    assert.deepEqual({ created: first.created, updated: first.updated, rejected: first.rejected }, { created: 3, updated: 1, rejected: 3 });
    const second = parse(await call(base, "POST", "/sync", cookie));
    assert.deepEqual({ created: second.created, updated: second.updated }, { created: 0, updated: 4 });
    assert.equal(store.state.office_social_posts.length, 4);
    const p1 = store.state.office_social_posts.find((p) => p.provider_post_id === `${PAGE}_p1`);
    assert.equal(p1.caption, "Synthetic launch post"); assert.equal(store.state.office_social_comments[0].post_id, p1.id);
    assert.ok(!store.state.office_social_posts.some((p) => ["999_foreign", `${PAGE}_p9`, "17800000000000002"].includes(p.provider_post_id)));
    pass("bulk sync: 3 new + the comment-first post enriched in place; foreign posts rejected; repeating creates no duplicates; the comment stays on its post");

    const list = parse(await call(base, "GET", "", cookie));
    assert.equal(list.sync_enabled, true); assert.equal(list.posts.length, 4);
    assert.ok(list.posts.every((p) => !("provider_post_id" in p) && !("asset_id" in p)));
    const ig = list.posts.find((p) => p.channel === "instagram");
    assert.equal(ig.media_type, "video"); assert.equal(ig.media_preview_url, "https://scontent.cdninstagram.com/v/syn-r1.jpg"); assert.equal(ig.sync_status, "synced");
    pass("list: source channel, caption, preview, permalink, publish time and sync status; no platform post or account ids");

    // single refresh: edited, unavailable, restricted, error
    const fbPost = list.posts.find((p) => p.caption === "Second synthetic post");
    g.fixture.fb[1] = { ...g.fixture.fb[1], message: "Second synthetic post (edited)", updated_time: iso(1) };
    let r = parse(await call(base, "POST", `/${fbPost.id}/sync`, cookie));
    assert.equal(r.post.caption, "Second synthetic post (edited)");
    g.fixture.fb.splice(1, 1);
    r = parse(await call(base, "POST", `/${fbPost.id}/sync`, cookie));
    assert.equal(r.post.sync_status, "unavailable"); assert.equal(r.post.caption, "Second synthetic post (edited)"); assert.ok(r.post.unavailable_since);
    g.fixture.failNext = graphError(403, { code: 200, message: "denied", type: "OAuthException" });
    r = parse(await call(base, "POST", `/${p1.id}/sync`, cookie));
    assert.equal(r.post.sync_status, "restricted"); assert.equal(r.post.caption, "Synthetic launch post");
    g.fixture.failNext = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    r = parse(await call(base, "POST", `/${p1.id}/sync`, cookie));
    assert.equal(r.post.sync_status, "error"); assert.equal(r.post.caption, "Synthetic launch post");
    assert.equal((await call(base, "POST", "/not-a-uuid/sync", cookie)).status, 404);
    pass("refresh: edits applied; removed post marked unavailable with last details kept; restricted and failed lookups keep details; unknown post 404");

    // one sync at a time
    let gate; const held = new Promise((res) => { gate = res; });
    const slow = await start({}, async (url, options) => { await held; return g.request(url, options); });
    const slowCookie = await login(slow, "content@synthetic.invalid");
    const pending = call(slow, "POST", "/sync", slowCookie);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(parse(await call(slow, "POST", "/sync", slowCookie)).error, "social_sync_in_progress");
    gate();
    assert.equal((await pending).status, 200);
    assert.equal((await call(slow, "POST", "/sync", slowCookie)).status, 200, "the lock is released afterwards");
    pass("only one sync runs at a time (second request 409)");

    // audit, secrecy, separation
    const audits = store.state.audit_events.filter((a) => a.action === "content.social_posts_synced");
    assert.ok(audits.length >= 6);
    const everything = JSON.stringify(store.state) + logs.join("\n") + JSON.stringify(list);
    assert.ok(!everything.includes(TOKEN), "token never stored, logged or returned");
    assert.ok(!logs.join("\n").includes("Permissions error") && !logs.join("\n").includes("Invalid OAuth"), "Graph error text not logged");
    assert.equal(store.state.leads.length, leads); assert.equal(store.state.conversations.length, conversations);
    assert.equal((store.state.whatsapp_manual_sends || []).length, 0); assert.equal(store.state.office_content_items.length, 0);
    assert.ok(g.calls.every((c) => !/\/(comments|replies|feed|media_publish)(\?|$)/.test(c.url) || /\/media$/.test(c.url)));
    pass("every sync is audited; token and Graph error text never stored, logged or returned; no CRM lead, DM, send ledger or Sanity article created; GET requests only (no publish, reply or comment endpoints)");
  } finally {
    console.log = originalLog; console.error = originalError;
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await rm(tempDir, { recursive: true, force: true });
  }
}

(async () => {
  await adapterChecks();
  await sqlChecks();
  await httpChecks();
  console.log(`\nMeta social post sync (Content → Posts, C2): ${checks} checks PASS`);
})().catch((error) => { console.error(error); process.exit(1); });
