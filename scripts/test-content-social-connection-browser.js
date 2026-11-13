// Real-browser acceptance for the Content → Posts & Comments connection states, desktop and phone: disconnected (the production
// default: no Page/Instagram credentials, every flag off), demonstration (sample data only) and connected. Headless Chrome over the
// DevTools protocol against the real Office server (file store, synthetic data). Every Graph call is a counting stub that must stay at
// zero, and every browser request is intercepted (local passes, anything else blocked). Fails with BLOCKED when Chrome is missing.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { createHmac } = require("node:crypto");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { createMetaSocialModerationAdapter } = require("../src/lead-agents/meta-social-moderation");
const { createMetaSocialPostsAdapter } = require("../src/lead-agents/meta-social-posts");

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const PAGE = "910000000000001", SECRET = "synthetic-secret";
let checks = 0;
const ok = (cond, text) => { assert.ok(cond, text); checks += 1; console.log(`PASS ${text}`); };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });

async function main() {
  if (!CHROME) throw new Error("BLOCKED: Chrome is not installed (this suite fails rather than skipping)");
  const { store, tempDir } = await createTempStore();
  await store.ensureAdminUser({ email: "reviewer@synthetic.invalid", password_hash: hashPassword("synthetic-pass-123"), role: "ochiga_staff", display_name: "Synthetic Reviewer", status: "active" });
  const graphCalls = [];
  const stub = (kind) => async (url) => { graphCalls.push({ kind, url }); throw new Error("graph call attempted"); };
  const mk = () => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5000 });
  const noCreds = { facebookPageId: "", facebookPageAccessToken: "", instagramBusinessAccountId: "", instagramAccessToken: "", metaSocialGraphVersion: "" };
  const modes = {
    disconnected: { ...noCreds },
    demonstration: { ...noCreds, contentSocialDemoEnabled: true, metaSocialCommentsModerationEnabled: true, metaSocialPostsSyncEnabled: true },
    connected: { facebookPageId: PAGE, facebookPageAccessToken: "synthetic-token", instagramBusinessAccountId: "", instagramAccessToken: "", metaSocialGraphVersion: "v23.0",
      metaSocialCommentsInboundEnabled: true, metaSocialCommentsModerationEnabled: true, contentSocialDemoEnabled: true },
  };
  const servers = {};
  for (const [name, overrides] of Object.entries(modes)) {
    const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["synthetic-api"], allowedOrigins: [], metaAppSecret: SECRET, metaSocialVerifyToken: "v", officeBackendBaseUrl: "",
      metaSocialCommentsInboundEnabled: false, metaSocialPostsSyncEnabled: false, metaSocialCommentsModerationEnabled: false, contentSocialDemoEnabled: false, ...overrides };
    const server = buildServer({ config, store, rateLimiter: mk(), publicRateLimiter: mk(), officeRateLimiter: mk(), loginRateLimiter: mk(), whatsappAdapter: { isConfigured: () => false },
      metaSocialModerationAdapter: createMetaSocialModerationAdapter(config, { post: stub("post"), get: stub("get") }), metaSocialPostsAdapter: createMetaSocialPostsAdapter(config, stub("get")), openaiClient: {}, toolExecutor: {} });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    servers[name] = { server, base: `http://127.0.0.1:${server.address().port}` };
  }
  // one stored post with a comment, received while connected
  const t = Math.floor(Date.now() / 1000) - 900;
  const raw = JSON.stringify({ object: "page", entry: [{ id: PAGE, time: t, changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: `${PAGE}_c1`, post_id: `${PAGE}_p1`, from: { id: "920000000000002", name: "Bo Synthetic" }, message: "Is the gate open on Sundays? (fixture)", created_time: t } }] }] });
  await fetch(`${servers.connected.base}/webhooks/meta-social`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex") }, body: raw });
  const storedPostId = store.state.office_social_posts[0].id;
  const login = async (base) => { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "reviewer@synthetic.invalid", password: "synthetic-pass-123" }) }); return r.headers.get("set-cookie").split(";")[0]; };
  const cookies = {}; for (const name of Object.keys(servers)) cookies[name] = await login(servers[name].base);
  const api = (name, p, init = {}) => fetch(`${servers[name].base}/api/lead-agents/admin/content/${p}`, { ...init, headers: { cookie: cookies[name], "content-type": "application/json", ...(init.headers || {}) } });

  // ---- API: states, demo isolation, nothing outbound
  const dis = await (await api("disconnected", "social-posts")).json();
  const demo = await (await api("demonstration", "social-posts")).json();
  const con = await (await api("connected", "social-posts")).json();
  ok(dis.connection.state === "disconnected" && con.connection.state === "connected" && demo.connection.state === "demonstration" && con.connection.channels.facebook && !con.connection.channels.instagram,
    "API: disconnected without credentials, demonstration only while nothing is connected, connected when the Page is configured (demo flag ignored)");
  ok(dis.posts.length === 1 && dis.posts[0].id === storedPostId && demo.posts.length === 3 && demo.posts.every((p) => p.demo && !p.permalink_url && !p.media_preview_url) && !con.posts.some((p) => p.demo),
    "API: demonstration serves only marked sample posts (no links or images) and never mixes them with stored posts; connected never shows samples");
  ok([dis, demo, con].every((r) => r.connection.replies === false && r.connection.publishing === false) && demo.connection.moderation === false && demo.connection.post_sync === false && dis.connection.moderation === false,
    "API: replies and publishing are reported off everywhere; demonstration reports sync and moderation off even with their flags on");
  const sample = demo.posts[0];
  const sampleDetail = await (await api("demonstration", `social-posts/${sample.id}`)).json();
  const sampleComment = sampleDetail.comments.find((c) => !c.author_is_page);
  const modOnSample = await api("demonstration", `social-posts/${sample.id}/comments/${sampleComment.id}/moderation`, { method: "POST", body: JSON.stringify({ action: "hide", reason: "fixture reason", client_request_id: "req_demo_000000000001" }) });
  const syncInDemo = await api("demonstration", "social-posts/sync", { method: "POST", body: "{}" });
  const sampleViaConnected = await api("connected", `social-posts/${sample.id}`);
  ok(sampleDetail.moderation_enabled === false && sampleDetail.comments.every((c) => c.actionable === false) && modOnSample.status === 404 && syncInDemo.status === 403 && sampleViaConnected.status === 404 && store.state.office_social_posts.length === 1 && (store.state.office_social_comment_actions || []).length === 0,
    "API: sample posts cannot be moderated or synced, are not served once connected, and nothing about them is stored");

  const PORT = await freePort();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "content-connection-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--disable-features=BackForwardCache", "about:blank"], { stdio: "ignore" });
  const blocked = [];
  let ws;
  try {
    let targets;
    for (let i = 0; i < 100 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await new Promise((r) => setTimeout(r, 200)); } }
    assert.ok(targets, "Chrome DevTools is reachable");
    ws = new WebSocket(targets.find((x) => x.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    let id = 0; const pending = new Map();
    const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
    ws.addEventListener("message", (e) => {
      const d = JSON.parse(e.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
      if (d.method === "Fetch.requestPaused") {
        const { requestId, request } = d.params; const host = new URL(request.url).hostname;
        if (host === "127.0.0.1") send("Fetch.continueRequest", { requestId });
        else { blocked.push(host); send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }); }
      }
    });
    const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
    const waitFor = async (expr, label) => { for (let i = 0; i < 150; i++) { if (await evalJs(expr)) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`timeout: ${label}`); };
    const shot = async (name) => { if (!process.env.OFFICE_CONTENT_SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(process.env.OFFICE_CONTENT_SHOTS, name), Buffer.from(r.result.data, "base64")); };
    const viewport = (width, height, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    const noOverflow = () => evalJs("document.documentElement.scrollWidth <= document.documentElement.clientWidth");
    const open = async (name, hash, ready, label) => {
      await send("Network.clearBrowserCookies");
      await send("Network.setCookie", { name: cookies[name].split("=")[0], value: cookies[name].split("=").slice(1).join("="), url: servers[name].base });
      await send("Page.navigate", { url: `${servers[name].base}/office#/${hash}` }); await evalJs("window.__old = true"); await send("Page.reload"); await waitFor(`!window.__old && (${ready})`, label);
    };
    const chip = "document.querySelector('#contentSocialBar .content-connection')";
    await send("Page.enable"); await send("Runtime.enable"); await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await viewport(1440, 900);

    // ---- disconnected (production default)
    await open("disconnected", "content", `!!${chip}`, "disconnected list");
    ok(await evalJs(`${chip}.dataset.connection === 'disconnected' && /Not connected/.test(${chip}.textContent) && !document.querySelector('#contentSocialSync') && !!document.querySelector('#contentSourceFilter') && !document.querySelector('.content-demo-notice')`),
      "disconnected: Posts shows a Not connected status, the source filter and no sync button");
    ok(await evalJs("[...document.querySelectorAll('.content-row-social')].length === 1 && !/Sample/.test(document.querySelector('#contentList').textContent)"), "disconnected: previously stored posts stay visible read-only; no sample data");
    await shot("connection-desktop-disconnected.png");
    // before the C1-C3 tables exist (production today): the status still renders, nothing breaks
    const realList = store.listSocialPosts.bind(store);
    store.listSocialPosts = async () => { throw new Error("relation office_social_posts does not exist (fixture)"); };
    const premig = await (await api("disconnected", "social-posts")).json();
    await open("disconnected", "content", `!!${chip}`, "pre-migration list");
    ok(premig.posts_unavailable === true && premig.connection.state === "disconnected" && premig.sync_enabled === false && await evalJs(`${chip}.dataset.connection === 'disconnected' && !!document.querySelector('[data-posts-unavailable]') && !!document.querySelector('#contentSourceFilter')`),
      "before the migration: the Content list still loads with Not connected and a 'could not be loaded' note instead of failing");
    store.listSocialPosts = realList;
    await open("disconnected", "content/comments", "!!document.querySelector('.content-comments, .content-not-connected')", "disconnected comments");
    ok(await evalJs("!document.querySelector('.content-tab-soon[title*=\"Comments\"]') && !!document.querySelector('[data-content-tab=comments]') && document.querySelectorAll('.content-moderation-toggle').length === 0"), "disconnected: the Comments tab is open (not Soon) and offers no moderation");

    // ---- demonstration
    await open("demonstration", "content", `!!${chip}`, "demo list");
    ok(await evalJs(`${chip}.dataset.connection === 'demonstration' && /Demonstration/.test(${chip}.textContent) && /not from your Facebook Page or Instagram/.test(${chip}.textContent) && !document.querySelector('#contentSocialSync')`),
      "demonstration: the status says Demonstration, not from your Page, and there is no sync button");
    ok(await evalJs("(() => { const rows = [...document.querySelectorAll('.content-row-social')]; return rows.length === 3 && rows.every((r) => /Sample/.test(r.textContent)); })()"), "demonstration: three sample posts, each badged Sample");
    await shot("connection-desktop-demo-list.png");
    await open("demonstration", `content/social:${sample.id}`, "!!document.querySelector('.content-social-view .content-comment')", "demo post");
    ok(await evalJs("!!document.querySelector('.content-social-view .content-demo-notice') && !document.querySelector('.content-social-readonly') && /Sample post/.test(document.querySelector('.content-social-head').textContent) && document.querySelectorAll('.content-moderation-toggle, .content-moderation-check, .content-social-refresh').length === 0 && !document.querySelector('.content-social-links a')"),
      "demonstration: a sample post carries the Demonstration notice and has no Hide, Refresh or Open-on-platform controls");
    await shot("connection-desktop-demo-post.png");
    await open("demonstration", "content/comments", "!!document.querySelector('.content-comments-list .content-comment')", "demo comments");
    ok(await evalJs("!!document.querySelector('.content-demo-notice') && /sample post/.test(document.querySelector('.content-comments-head').textContent) && document.querySelectorAll('.content-moderation-toggle').length === 0"), "demonstration: the Comments tab is marked Demonstration and is read-only");
    await viewport(390, 844, true);
    await open("demonstration", `content/social:${sample.id}`, "!!document.querySelector('.content-social-view .content-demo-notice')", "phone demo post");
    ok(await noOverflow(), "phone: the demonstration post and notice fit with no horizontal overflow");
    await shot("connection-phone-demo-post.png");
    await open("demonstration", "content", `!!${chip}`, "phone demo list");
    ok(await noOverflow() && await evalJs(`${chip}.getBoundingClientRect().right <= window.innerWidth`), "phone: the connection status wraps inside the list with no overflow");
    await viewport(1440, 900);

    // ---- connected
    await open("connected", "content", `!!${chip}`, "connected list");
    ok(await evalJs(`${chip}.dataset.connection === 'connected' && /Connected/.test(${chip}.textContent) && /Facebook Page/.test(${chip}.textContent) && /Replies and publishing are not enabled/.test(${chip}.textContent) && !/Sample/.test(document.querySelector('#contentList').textContent)`),
      "connected: the status names the connected Page, says replies and publishing are off, and no sample data appears");
    await open("connected", `content/social:${storedPostId}`, "!!document.querySelector('.content-social-view .content-comment')", "connected post");
    ok(await evalJs("document.querySelectorAll('.content-moderation-toggle').length === 1 && !document.querySelector('.content-demo-notice')"), "connected: the real post offers Hide to a reviewer (moderation flag on) without any demonstration notice");
    await shot("connection-desktop-connected.png");

    ok(graphCalls.length === 0, "no Graph request of any kind was made in any state");
    ok(blocked.length === 0, "no request left the machine (nothing external attempted)");
  } finally {
    try { ws?.close(); } catch { /* closed */ }
    chrome.kill("SIGKILL");
    for (const { server } of Object.values(servers)) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log(`\nContent social connection states browser (disconnected / demonstration / connected, desktop + phone): ${checks} checks PASS`);
}

main().catch((error) => { console.error(String(error && error.stack || error)); process.exit(1); });
