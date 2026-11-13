// Content → Posts & Comments, C3: hide/unhide moderation of public Facebook and Instagram comments. Synthetic data and mocked Graph
// POST/GET functions only; no Meta request is made. Proves: both channel adapters; success only after a read-back shows the
// requested state; refusal / throttling / timeout / ambiguous handling; reconciliation; duplicate requests and simultaneous staff
// actions; content.review + staff session + switch; cross-asset rejection; deleted and Page-authored comments not actionable; the
// ledger rules in Postgres; audit; no token leakage; no deletion, replies, CRM or DM side effects.
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
const { createMetaSocialModerationAdapter, decide } = require("../src/lead-agents/meta-social-moderation");

const PAGE = "910000000000001", IG = "910000000000002", TOKEN = "synthetic-token-not-real", SECRET = "synthetic-secret";
let checks = 0;
const pass = (t) => { checks += 1; console.log(`PASS ${t}`); };
const graphError = (status, error) => Object.assign(new Error("graph"), { response: { status, data: error ? { error } : {} } });
const rid = () => `req_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`.padEnd(20, "0");

// Mock Meta: holds each comment's real visibility; scripted responses per call.
function mockMeta() {
  const visible = new Map(); // provider comment id -> hidden boolean
  const media = new Map();   // ig comment id -> media id
  const calls = [];
  const plan = { post: [], get: [] };
  const take = (kind) => plan[kind].shift();
  const post = async (url, body, options) => {
    calls.push({ kind: "post", url, params: options.params, auth: options.headers.Authorization, body });
    const step = take("post") || { mode: "ok" };
    if (step.wait) await step.wait;
    const id = decodeURIComponent(url.split("/").pop());
    const hidden = "is_hidden" in options.params ? options.params.is_hidden : options.params.hide;
    if (step.mode === "ok") { visible.set(id, hidden); return { status: 200, data: { success: true } }; }
    if (step.mode === "ok_not_applied") return { status: 200, data: { success: true } };
    if (step.mode === "malformed_applied") { visible.set(id, hidden); return { status: 200, data: {} }; }
    if (step.mode === "timeout_applied") { visible.set(id, hidden); throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); }
    if (step.mode === "timeout") throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    if (step.mode === "throttled") throw graphError(429, { code: 4, message: "Application request limit reached" });
    if (step.mode === "token") throw graphError(400, { code: 190, message: "Error validating access token: Session has expired" });
    if (step.mode === "permission") throw graphError(403, { code: 200, message: "Permissions error" });
    if (step.mode === "gone") throw graphError(400, { code: 100, error_subcode: 33, message: "Object does not exist" });
    throw new Error("unplanned");
  };
  const get = async (url, options) => {
    calls.push({ kind: "get", url, params: options.params, auth: options.headers.Authorization });
    const step = take("get") || { mode: "ok" };
    const id = decodeURIComponent(url.split("/").pop());
    if (step.mode === "fail") throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    if (step.mode === "gone") throw graphError(400, { code: 100, error_subcode: 33 });
    if (step.mode === "foreign") return { status: 200, data: { id, hidden: Boolean(visible.get(id)), media: { id: "17899999999999999" } } };
    if (options.params.fields.includes("media")) return { status: 200, data: { id, hidden: Boolean(visible.get(id)), media: { id: media.get(id) } } };
    return { status: 200, data: { id, is_hidden: Boolean(visible.get(id)) } };
  };
  return { visible, media, calls, plan, post, get };
}

async function unitChecks() {
  const meta = mockMeta();
  const adapter = createMetaSocialModerationAdapter({ facebookPageAccessToken: TOKEN, metaSocialGraphVersion: "v23.0" }, { post: meta.post, get: meta.get });
  assert.deepEqual(await adapter.setHidden("facebook", "c_fb", true), { kind: "accepted", failure: null, code: 200 });
  assert.equal(meta.calls[0].url, "https://graph.facebook.com/v23.0/c_fb"); assert.deepEqual(meta.calls[0].params, { is_hidden: true }); assert.equal(meta.calls[0].auth, `Bearer ${TOKEN}`);
  meta.media.set("c_ig", "m1");
  await adapter.setHidden("instagram", "c_ig", true); assert.deepEqual(meta.calls[1].params, { hide: true });
  assert.deepEqual(await adapter.readBack("facebook", "c_fb", "p"), { visibility: "hidden" });
  assert.deepEqual(await adapter.readBack("instagram", "c_ig", "m1"), { visibility: "hidden" });
  assert.deepEqual(await adapter.readBack("instagram", "c_ig", "m_other"), { failure: "foreign_post" });
  for (const [mode, expected] of [["token", "token_invalid"], ["permission", "permission_denied"], ["gone", "comment_unavailable"]]) {
    meta.plan.post.push({ mode }); const r = await adapter.setHidden("facebook", "c_fb", true); assert.equal(r.kind, "refused"); assert.equal(r.failure, expected);
  }
  meta.plan.post.push({ mode: "throttled" }); assert.deepEqual(await adapter.setHidden("facebook", "c_fb", true), { kind: "uncertain", failure: "throttled", code: 429 });
  meta.plan.post.push({ mode: "timeout" }); assert.equal((await adapter.setHidden("facebook", "c_fb", true)).failure, "graph_no_response");
  meta.plan.post.push({ mode: "malformed_applied" }); assert.equal((await adapter.setHidden("facebook", "c_fb", true)).kind, "uncertain");
  assert.ok(meta.calls.every((c) => !c.url.includes(TOKEN) && !JSON.stringify(c.params || {}).includes(TOKEN)));
  assert.equal(createMetaSocialModerationAdapter({ metaSocialGraphVersion: "v23.0" }).configured("facebook"), false);
  pass("adapters: Facebook is_hidden / Instagram hide on POST /{comment}, token only in the Authorization header; read-back of is_hidden / hidden; Instagram comment must belong to the stored post; token, permission and missing-comment refusals; throttling, timeout and malformed replies uncertain");

  assert.equal(decide("hide", { visibility: "hidden" }, { requestKind: "uncertain" }).status, "confirmed");
  for (const requestKind of ["accepted", "uncertain"]) {
    assert.deepEqual(decide("hide", { visibility: "visible" }, { requestKind }), { status: "unknown", observed: "visible", failure: "not_yet_applied" });
    assert.deepEqual(decide("unhide", { visibility: "hidden" }, { requestKind }), { status: "unknown", observed: "hidden", failure: "not_yet_applied" });
  }
  assert.equal(decide("hide", { visibility: "visible" }, { requestKind: "refused" }).status, "failed");
  assert.equal(decide("hide", { failure: "graph_no_response" }, { requestKind: "accepted" }).status, "unknown");
  assert.equal(decide("hide", { failure: "comment_unavailable" }, { requestKind: "uncertain" }).status, "failed");
  assert.equal(decide("unhide", { failure: "foreign_post" }, { requestKind: "accepted" }).status, "failed");
  pass("decision: confirmed only when the read-back shows the requested state; an unchanged read-back after an accepted or uncertain request stays unknown regardless of elapsed time; only refusals and a missing comment fail; no read-back stays unknown");
}

async function sqlChecks() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create table office_content_items (id text primary key, title text not null);`);
  for (const f of ["20261114_meta_social_posts_comments.sql", "20261115_meta_social_post_sync.sql", "20261116_meta_social_comment_moderation.sql"]) await db.exec(readFileSync(path.join(__dirname, "../db", f), "utf8"));
  await db.exec("set role service_role");
  const t = new Date(Date.now() - 3600_000).toISOString();
  const ev = (n, comment, verb, page = false) => db.query("select public.office_record_social_comment_event('facebook',$1,$2,$3,null,$4,$5,$6,null,null,$7,'x')", [PAGE, `${PAGE}_p`, comment, verb, "meta-comment:event:" + String(n).repeat(64).slice(0, 64), t, page]);
  await ev(1, "c1", "add"); await ev(2, "c2", "add"); await ev(3, "c3", "add", true); await ev(4, "c4", "add"); await ev(5, "c4", "remove");
  const id = async (p) => (await db.query("select id from office_social_comments where provider_comment_id=$1", [p])).rows[0].id;
  const claim = (c, action, actor, req) => db.query("select public.office_claim_comment_moderation($1,$2,$3,$4,$5,'synthetic reason') as r", [c, action, actor, `${actor}@x.invalid`, req]).then((x) => x.rows[0].r);
  const settle = (a, status, observed) => db.query("select public.office_settle_comment_moderation($1,$2,$3,200,null,'readback') as r", [a, status, observed]).then((x) => x.rows[0].r);
  const c1 = await id("c1");
  const first = await claim(c1, "hide", "u1", "request_aaaaaaaaaaaa1");
  assert.equal(first.outcome, "claimed");
  assert.equal((await claim(c1, "hide", "u1", "request_aaaaaaaaaaaa1")).outcome, "duplicate");
  assert.equal((await claim(c1, "unhide", "u1", "request_aaaaaaaaaaaa1")).outcome, "request_reused");
  assert.equal((await claim(c1, "hide", "u2", "request_bbbbbbbbbbbb2")).outcome, "blocked");
  assert.equal((await claim(await id("c3"), "hide", "u1", "request_cccccccccccc3")).outcome, "not_actionable");
  assert.equal((await claim(await id("c4"), "hide", "u1", "request_dddddddddddd4")).outcome, "not_actionable");
  assert.equal((await db.query("select public.office_mark_comment_moderation_dispatched($1) as r", [first.id])).rows[0].r, true);
  assert.equal((await db.query("select public.office_mark_comment_moderation_dispatched($1) as r", [first.id])).rows[0].r, false);
  await assert.rejects(settle(first.id, "confirmed", "visible"), { code: "22023" });
  assert.equal((await settle(first.id, "unknown", "visible")).status, "unknown");
  assert.equal((await db.query("select visibility from office_social_comments where id=$1", [c1])).rows[0].visibility, "visible");
  assert.equal((await settle(first.id, "confirmed", "hidden")).status, "confirmed");
  assert.equal((await db.query("select visibility from office_social_comments where id=$1", [c1])).rows[0].visibility, "hidden");
  assert.equal((await settle(first.id, "failed", null)).outcome, "already_settled");
  assert.equal((await claim(c1, "unhide", "u2", "request_eeeeeeeeeeee5")).outcome, "claimed");
  await db.exec("reset role");
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(claim(await (async () => { await db.exec("reset role"); const x = await id("c2"); await db.exec(`set role ${role}`); return x; })(), "hide", "u9", "request_ffffffffffff6"), { code: "42501" });
    await db.exec("reset role");
  }
  assert.equal((await db.query("select count(*)::int n from information_schema.role_table_grants where table_name='office_social_comment_actions' and grantee in ('anon','authenticated','PUBLIC')")).rows[0].n, 0);
  pass("SQL ledger: claim / duplicate / reused request id / one open action per comment / deleted and Page-authored not actionable; dispatch marked once; 'confirmed' requires the observed requested state and updates the comment; unknown and failed never change it; settled is final; service role only");
  await db.close();
}

async function httpChecks() {
  const { store, tempDir } = await createTempStore();
  const users = [["reviewer@synthetic.invalid", "ochiga_staff", []], ["reviewer2@synthetic.invalid", "ochiga_admin", []], ["writer@synthetic.invalid", "resident", ["content.write"]], ["agent@synthetic.invalid", "ai_agent", []]];
  for (const [email, role, scopes] of users) await store.ensureAdminUser({ email, password_hash: hashPassword("synthetic-pass-123"), role, display_name: "Synthetic", status: "active", permission_scopes: scopes });
  const meta = mockMeta();
  const servers = [], logs = [];
  const originalLog = console.log, originalError = console.error;
  console.log = (...x) => { const l = x.join(" "); if (l.startsWith("{")) logs.push(l); else originalLog(...x); };
  console.error = (...x) => logs.push(x.join(" "));
  const mk = () => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5000 });
  const start = async (overrides = {}) => {
    const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["synthetic-api"], allowedOrigins: [], metaAppSecret: SECRET, metaSocialVerifyToken: "v",
      facebookPageId: PAGE, instagramBusinessAccountId: IG, facebookPageAccessToken: TOKEN, metaSocialGraphVersion: "v23.0", officeBackendBaseUrl: "",
      metaSocialCommentsInboundEnabled: true, metaSocialCommentsModerationEnabled: true, ...overrides };
    const server = buildServer({ config, store, rateLimiter: mk(), publicRateLimiter: mk(), officeRateLimiter: mk(), loginRateLimiter: mk(), whatsappAdapter: { isConfigured: () => false },
      metaSocialReplyAdapter: { sendTextMessage: async () => assert.fail("no replies") }, metaSocialModerationAdapter: createMetaSocialModerationAdapter(config, { post: meta.post, get: meta.get }), openaiClient: {}, toolExecutor: {} });
    servers.push(server); await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const hook = (base, body) => { const raw = JSON.stringify(body); return fetch(`${base}/webhooks/meta-social`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex") }, body: raw }); };
  const fb = (comment, verb = "add", extra = {}) => ({ object: "page", entry: [{ id: PAGE, time: extra.time || Math.floor(Date.now() / 1000) - 600, changes: [{ field: "feed", value: { item: "comment", verb, comment_id: comment, post_id: `${PAGE}_p1`, from: extra.from || { id: "920000000000001", name: "Synthetic Commenter" }, message: extra.message ?? "Synthetic comment", created_time: extra.time || Math.floor(Date.now() / 1000) - 600 } }] }] });
  const login = async (base, email) => { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "synthetic-pass-123" }) }); assert.equal(r.status, 200, email); return r.headers.get("set-cookie").split(";")[0]; };
  const leads = store.state.leads.length, conversations = store.state.conversations.length;
  try {
    const base = await start();
    for (const c of ["c1", "c2", "c5", "c6", "c7", "c8"]) await hook(base, fb(`${PAGE}_${c}`));
    await hook(base, fb(`${PAGE}_c3`, "add", { from: { id: PAGE, name: "Synthetic Page" } }));
    await hook(base, fb(`${PAGE}_c4`)); await hook(base, fb(`${PAGE}_c4`, "remove", { time: Math.floor(Date.now() / 1000) - 300 }));
    await hook(base, { object: "instagram", entry: [{ id: IG, time: Math.floor(Date.now() / 1000) - 600, changes: [{ field: "comments", value: { id: "17900000000000001", text: "Synthetic IG comment", from: { id: "930000000000001", username: "synthetic_user" }, media: { id: "17800000000000001" } } }] }] });
    meta.media.set("17900000000000001", "17800000000000001");
    const fbPost = store.state.office_social_posts.find((p) => p.channel === "facebook"), igPost = store.state.office_social_posts.find((p) => p.channel === "instagram");
    const cid = (p) => store.state.office_social_comments.find((c) => c.provider_comment_id === p).id;
    const url = (post, comment, tail = "") => `${base}/api/lead-agents/admin/content/social-posts/${post}/comments/${comment}/moderation${tail}`;
    const moderate = async (cookie, post, comment, action, extra = {}) => { const r = await fetch(url(post, comment), { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ action, reason: "Synthetic spam link", client_request_id: rid(), ...extra }) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const reviewer = await login(base, "reviewer@synthetic.invalid"), reviewer2 = await login(base, "reviewer2@synthetic.invalid");

    // authorization and switches
    const callsAtStart = meta.calls.length;
    assert.ok([401, 403].includes((await moderate(null, fbPost.id, cid(`${PAGE}_c1`), "hide")).status));
    assert.equal((await moderate(await login(base, "writer@synthetic.invalid"), fbPost.id, cid(`${PAGE}_c1`), "hide")).status, 403);
    assert.equal((await moderate(await login(base, "agent@synthetic.invalid"), fbPost.id, cid(`${PAGE}_c1`), "hide")).status, 403);
    const apiKey = await fetch(url(fbPost.id, cid(`${PAGE}_c1`)), { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-api" }, body: JSON.stringify({ action: "hide", reason: "x x x", client_request_id: rid() }) });
    assert.equal(apiKey.status, 403);
    const off = await start({ metaSocialCommentsModerationEnabled: false });
    assert.equal((await fetch(`${off}/api/lead-agents/admin/content/social-posts/${fbPost.id}/comments/${cid(`${PAGE}_c1`)}/moderation`, { method: "POST", headers: { "content-type": "application/json", cookie: await login(off, "reviewer@synthetic.invalid") }, body: JSON.stringify({ action: "hide", reason: "Synthetic", client_request_id: rid() }) }).then((r) => r.json())).error, "moderation_disabled");
    assert.equal((await moderate(reviewer, fbPost.id, cid(`${PAGE}_c1`), "hide", { reason: "" })).status, 400);
    assert.equal((await moderate(reviewer, fbPost.id, cid(`${PAGE}_c1`), "delete")).status, 400);
    assert.equal((await moderate(reviewer, fbPost.id, cid(`${PAGE}_c1`), "hide", { actor: "someone" })).status, 400);
    assert.equal(meta.calls.length, callsAtStart);
    pass("authorization: content.review + staff session + switch required (no session, content.write only, ai_agent and API key refused); invalid, extra-field and delete requests refused; no Graph call");

    // cross-asset, deleted, page-authored
    assert.equal((await moderate(reviewer, igPost.id, cid(`${PAGE}_c1`), "hide")).status, 404);
    const foreignPost = { ...fbPost, id: "00000000-0000-4000-8000-000000000001", asset_id: "999", provider_post_id: "999_p" };
    store.state.office_social_posts.push(foreignPost);
    store.state.office_social_comments.push({ ...store.state.office_social_comments.find((c) => c.provider_comment_id === `${PAGE}_c2`), id: "00000000-0000-4000-8000-000000000002", post_id: foreignPost.id, asset_id: "999", provider_comment_id: "999_c" });
    assert.equal((await moderate(reviewer, foreignPost.id, "00000000-0000-4000-8000-000000000002", "hide")).body.error, "foreign_asset");
    assert.equal((await moderate(reviewer, fbPost.id, cid(`${PAGE}_c4`), "hide")).body.error, "comment_not_actionable");
    assert.equal((await moderate(reviewer, fbPost.id, cid(`${PAGE}_c3`), "hide")).body.error, "comment_not_actionable");
    assert.equal(meta.calls.length, callsAtStart);
    pass("cross-asset: comment from another post 404, comment of another Page 403 foreign_asset; deleted and Page-authored comments not actionable; no Graph call");

    // happy path FB: success only after read-back
    let r = await moderate(reviewer, fbPost.id, cid(`${PAGE}_c1`), "hide");
    assert.equal(r.status, 200); assert.equal(r.body.state, "confirmed"); assert.equal(r.body.visibility, "hidden");
    assert.equal(store.state.office_social_comments.find((c) => c.id === cid(`${PAGE}_c1`)).visibility, "hidden");
    assert.deepEqual(meta.calls.slice(-2).map((c) => c.kind), ["post", "get"]);
    let ledger = store.state.office_social_comment_actions.find((a) => a.id === r.body.action_id);
    assert.equal(ledger.status, "confirmed"); assert.equal(ledger.resolved_by, "readback"); assert.ok(ledger.dispatch_at); assert.equal(ledger.reason, "Synthetic spam link");
    pass("Facebook hide: one POST then a read-back; confirmed only because the read-back shows it hidden; ledger records reason, dispatch and read-back");

    // accepted but not applied -> unknown, then reconcile
    meta.plan.post.push({ mode: "ok_not_applied" });
    r = await moderate(reviewer, fbPost.id, cid(`${PAGE}_c2`), "hide");
    assert.equal(r.status, 202); assert.equal(r.body.state, "unknown"); assert.equal(r.body.failure_reason, "not_yet_applied");
    assert.equal(store.state.office_social_comments.find((c) => c.id === cid(`${PAGE}_c2`)).visibility, "visible");
    assert.equal((await moderate(reviewer2, fbPost.id, cid(`${PAGE}_c2`), "hide")).body.error, "moderation_in_progress");
    const unknownId = r.body.action_id;
    let rec = await fetch(url(fbPost.id, cid(`${PAGE}_c2`), `/${unknownId}/reconcile`), { method: "POST", headers: { cookie: reviewer } }).then((x) => x.json());
    assert.equal(rec.state, "unknown");
    store.state.office_social_comment_actions.find((a) => a.id === unknownId).dispatch_at = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    rec = await fetch(url(fbPost.id, cid(`${PAGE}_c2`), `/${unknownId}/reconcile`), { method: "POST", headers: { cookie: reviewer } }).then((x) => x.json());
    assert.equal(rec.state, "unknown", "an unchanged read-back a day later is still not proof of failure"); assert.equal(rec.failure_reason, "not_yet_applied");
    r = await moderate(reviewer, fbPost.id, cid(`${PAGE}_c2`), "hide");
    assert.equal(r.status, 409); assert.equal(r.body.error, "moderation_in_progress", "a new request id cannot re-send while the first is unconfirmed");
    assert.equal((await moderate(reviewer2, fbPost.id, cid(`${PAGE}_c2`), "unhide")).body.error, "moderation_in_progress");
    assert.equal(meta.calls.filter((c) => c.kind === "post").length, 2, "reconcile never sends and the fence blocks re-sends");
    meta.visible.set(`${PAGE}_c2`, true); // Meta applies the original request late
    rec = await fetch(url(fbPost.id, cid(`${PAGE}_c2`), `/${unknownId}/reconcile`), { method: "POST", headers: { cookie: reviewer } }).then((x) => x.json());
    assert.equal(rec.state, "confirmed");
    assert.equal(store.state.office_social_comments.find((c) => c.id === cid(`${PAGE}_c2`)).visibility, "hidden");
    assert.equal(meta.calls.filter((c) => c.kind === "post").length, 2);
    pass("a submitted request is never success: accepted-but-unchanged stays unknown, even a day later, and stays fenced (no re-send, no other action); reconcile is read-only and confirms when Meta applies it late");

    // timeout applied -> confirmed; timeout + read-back failure -> unknown -> reconcile confirmed
    meta.plan.post.push({ mode: "timeout_applied" });
    assert.equal((await moderate(reviewer, fbPost.id, cid(`${PAGE}_c5`), "hide")).body.state, "confirmed");
    meta.plan.post.push({ mode: "timeout_applied" }); meta.plan.get.push({ mode: "fail" });
    r = await moderate(reviewer, fbPost.id, cid(`${PAGE}_c6`), "hide");
    assert.equal(r.body.state, "unknown");
    rec = await fetch(url(fbPost.id, cid(`${PAGE}_c6`), `/${r.body.action_id}/reconcile`), { method: "POST", headers: { cookie: reviewer } }).then((x) => x.json());
    assert.equal(rec.state, "confirmed");
    meta.plan.post.push({ mode: "malformed_applied" });
    assert.equal((await moderate(reviewer, fbPost.id, cid(`${PAGE}_c7`), "hide")).body.state, "confirmed");
    pass("timeout that applied -> confirmed by read-back; timeout with read-back unavailable -> unknown, then reconcile confirms; malformed reply decided by read-back");

    // refusals and throttling
    meta.plan.post.push({ mode: "token" });
    const before = meta.calls.length;
    r = await moderate(reviewer, fbPost.id, cid(`${PAGE}_c8`), "hide");
    assert.equal(r.status, 409); assert.equal(r.body.state, "failed"); assert.equal(r.body.failure_reason, "token_invalid");
    assert.equal(meta.calls.length - before, 1, "no read-back after a definitive refusal");
    meta.plan.post.push({ mode: "permission" });
    assert.equal((await moderate(reviewer, fbPost.id, cid(`${PAGE}_c8`), "hide")).body.failure_reason, "permission_denied");
    meta.plan.post.push({ mode: "throttled" });
    r = await moderate(reviewer, fbPost.id, cid(`${PAGE}_c8`), "hide");
    assert.equal(r.body.state, "unknown");
    store.state.office_social_comment_actions.find((a) => a.id === r.body.action_id).dispatch_at = new Date(Date.now() - 3600 * 1000).toISOString();
    rec = await fetch(url(fbPost.id, cid(`${PAGE}_c8`), `/${r.body.action_id}/reconcile`), { method: "POST", headers: { cookie: reviewer } }).then((x) => x.json());
    assert.equal(rec.state, "unknown", "throttled and still unchanged an hour later stays unknown");
    meta.plan.get.push({ mode: "gone" });
    rec = await fetch(url(fbPost.id, cid(`${PAGE}_c8`), `/${r.body.action_id}/reconcile`), { method: "POST", headers: { cookie: reviewer } }).then((x) => x.json());
    assert.equal(rec.state, "failed"); assert.equal(rec.failure_reason, "comment_unavailable");
    meta.plan.post.push({ mode: "gone" }); meta.plan.get.push({ mode: "gone" });
    r = await moderate(reviewer, fbPost.id, cid(`${PAGE}_c8`), "hide");
    assert.equal(r.body.failure_reason, "comment_unavailable");
    assert.equal(store.state.office_social_comments.find((c) => c.id === cid(`${PAGE}_c8`)).visibility, "visible");
    pass("expired token and revoked permission fail with no change and no read-back; throttling stays unknown (not failed) until a read-back proves the outcome; a comment gone from Facebook fails");

    // duplicates and simultaneous staff
    const dupId = rid();
    const d1 = await moderate(reviewer, fbPost.id, cid(`${PAGE}_c1`), "unhide", { client_request_id: dupId });
    const postsBefore = meta.calls.filter((c) => c.kind === "post").length;
    const d2 = await moderate(reviewer, fbPost.id, cid(`${PAGE}_c1`), "unhide", { client_request_id: dupId });
    assert.equal(d1.body.state, "confirmed"); assert.equal(d2.body.duplicate, true); assert.equal(d2.body.state, "confirmed");
    assert.equal(meta.calls.filter((c) => c.kind === "post").length, postsBefore, "a duplicate request id sends nothing");
    assert.equal((await moderate(reviewer, fbPost.id, cid(`${PAGE}_c1`), "hide", { client_request_id: dupId })).body.error, "request_id_reused");
    let gate; const held = new Promise((res) => { gate = res; });
    meta.plan.post.push({ mode: "ok", wait: held });
    const racers = [moderate(reviewer, fbPost.id, cid(`${PAGE}_c1`), "hide"), moderate(reviewer2, fbPost.id, cid(`${PAGE}_c1`), "hide"), moderate(reviewer2, fbPost.id, cid(`${PAGE}_c1`), "hide")];
    await new Promise((res) => setTimeout(res, 150)); gate();
    const results = await Promise.all(racers);
    assert.equal(results.filter((x) => x.body.state === "confirmed").length, 1);
    assert.equal(results.filter((x) => x.body.error === "moderation_in_progress").length, 2);
    pass("duplicate request id returns the recorded outcome without a second request; a reused id with another action is refused; three simultaneous staff actions -> exactly one runs, two refused");

    // Instagram
    r = await moderate(reviewer, igPost.id, cid("17900000000000001"), "hide");
    assert.equal(r.body.state, "confirmed"); assert.deepEqual(meta.calls.filter((c) => c.kind === "post").at(-1).params, { hide: true });
    r = await moderate(reviewer, igPost.id, cid("17900000000000001"), "unhide");
    assert.equal(r.body.state, "confirmed"); assert.equal(store.state.office_social_comments.find((c) => c.id === cid("17900000000000001")).visibility, "visible");
    meta.plan.get.push({ mode: "foreign" });
    r = await moderate(reviewer, igPost.id, cid("17900000000000001"), "hide");
    assert.equal(r.body.state, "failed"); assert.equal(r.body.failure_reason, "foreign_post");
    pass("Instagram hide and unhide confirmed by read-back; a read-back placing the comment on another media fails as foreign_post");

    // webhook ordering, detail view, audit, secrecy, separation
    await hook(base, fb(`${PAGE}_c5`, "unhide", { time: Math.floor(Date.now() / 1000) - 200 }));
    assert.equal(store.state.office_social_comments.find((c) => c.id === cid(`${PAGE}_c5`)).visibility, "hidden", "an older webhook cannot undo a confirmed moderation");
    const detail = await fetch(`${base}/api/lead-agents/admin/content/social-posts/${fbPost.id}`, { headers: { cookie: reviewer } }).then((x) => x.json());
    assert.equal(detail.moderation_enabled, true);
    const c2 = detail.comments.find((c) => c.provider_comment_id === `${PAGE}_c2`);
    assert.equal(c2.moderation.state, "confirmed"); assert.equal(c2.actionable, true);
    assert.equal(detail.comments.find((c) => c.provider_comment_id === `${PAGE}_c3`).actionable, false);
    assert.equal(detail.comments.find((c) => c.provider_comment_id === `${PAGE}_c4`).actionable, false);
    const audits = store.state.audit_events.filter((a) => /^content\.social_comment_moderation_/.test(a.action));
    assert.ok(audits.some((a) => a.action.endsWith("_requested")) && audits.some((a) => a.action.endsWith("_confirmed")) && audits.some((a) => a.action.endsWith("_failed")) && audits.some((a) => a.action.endsWith("_reconciled_failed")));
    assert.ok(!JSON.stringify(audits).includes("Synthetic comment"), "audit records never contain comment text");
    const everything = JSON.stringify(store.state) + logs.join("\n");
    assert.ok(!everything.includes(TOKEN)); assert.ok(!logs.join("\n").includes("Session has expired"));
    assert.equal(store.state.leads.length, leads); assert.equal(store.state.conversations.length, conversations);
    assert.ok(meta.calls.every((c) => !/\/(comments|replies)$/.test(c.url)), "no reply endpoints"); assert.ok(meta.calls.every((c) => c.kind === "post" || c.kind === "get"), "no DELETE");
    pass("an older webhook cannot undo a confirmed moderation; detail shows moderation state and actionability; requests and outcomes audited without comment text; token and Graph messages never stored or logged; no CRM, DM, reply or delete calls");
  } finally {
    console.log = originalLog; console.error = originalError;
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await rm(tempDir, { recursive: true, force: true });
  }
}

(async () => {
  await unitChecks();
  await sqlChecks();
  await httpChecks();
  console.log(`\nMeta social comment moderation (Content → Comments, C3): ${checks} checks PASS`);
})().catch((error) => { console.error(error); process.exit(1); });
