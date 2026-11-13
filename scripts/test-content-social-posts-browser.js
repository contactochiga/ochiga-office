// Real-browser acceptance for Content → Posts with Facebook/Instagram posts (C2), desktop and phone. Headless Chrome over the DevTools
// protocol against the real Office server (file store, synthetic data, mock Graph adapter). Every browser request is intercepted:
// local requests pass, Meta CDN preview images are answered with a local synthetic image, and anything else external is blocked,
// so no request reaches Meta or any other service. Fails with BLOCKED (never skips) when Chrome is unavailable.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { createHmac } = require("node:crypto");
const zlib = require("node:zlib");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { createMetaSocialPostsAdapter } = require("../src/lead-agents/meta-social-posts");

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const PAGE = "910000000000001", IG = "910000000000002", SECRET = "synthetic-secret";
// 320x200 synthetic PNG (a plain gradient) served locally for every Meta CDN preview request
const PNG = (() => {
  const w = 320, h = 200, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 40 + (x * 120) / w; raw[o + 1] = 70 + (y * 90) / h; raw[o + 2] = 120; } }
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
})();
let checks = 0;
const ok = (cond, text) => { assert.ok(cond, text); checks += 1; console.log(`PASS ${text}`); };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });
const iso = (m) => new Date(Date.now() - m * 60_000).toISOString();

async function main() {
  if (!CHROME) throw new Error("BLOCKED: Chrome is not installed (this suite fails rather than skipping)");
  const { store, tempDir } = await createTempStore();
  await store.ensureAdminUser({ email: "content@synthetic.invalid", password_hash: hashPassword("synthetic-pass-123"), role: "super_admin", display_name: "Synthetic Editor", status: "active" });
  const graph = async (url) => {
    const tail = url.replace(/^https:\/\/graph\.facebook\.com\/v[0-9.]+\//, "");
    const fb = [{ id: `${PAGE}_p1`, message: "Synthetic smart-lock installation day (fixture)", created_time: iso(90), updated_time: iso(90), permalink_url: "https://www.facebook.com/synthetic/posts/p1", full_picture: "https://scontent.xx.fbcdn.net/v/synthetic-p1.png", from: { id: PAGE } },
      { id: `${PAGE}_p2`, message: "A text-only synthetic update", created_time: iso(240), updated_time: iso(240), permalink_url: "https://www.facebook.com/synthetic/posts/p2", from: { id: PAGE } }];
    const ig = [{ id: "17800000000000001", caption: "Synthetic estate gate reel (fixture)", media_type: "VIDEO", thumbnail_url: "https://scontent.cdninstagram.com/v/synthetic-r1.png", permalink: "https://www.instagram.com/p/SYNTHETIC1/", timestamp: iso(30), owner: { id: IG } }];
    if (tail === `${PAGE}/posts`) return { status: 200, data: { data: fb } };
    if (tail === `${IG}/media`) return { status: 200, data: { data: ig } };
    const one = [...fb, ...ig].find((p) => encodeURIComponent(p.id) === tail);
    if (one) return { status: 200, data: one };
    throw Object.assign(new Error("gone"), { response: { status: 400, data: { error: { code: 100, error_subcode: 33 } } } });
  };
  const mk = () => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5000 });
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["synthetic-api"], allowedOrigins: [], metaAppSecret: SECRET, metaSocialVerifyToken: "v",
    facebookPageId: PAGE, instagramBusinessAccountId: IG, facebookPageAccessToken: "synthetic-token", metaSocialGraphVersion: "v23.0", officeBackendBaseUrl: "",
    metaSocialCommentsInboundEnabled: true, metaSocialPostsSyncEnabled: true };
  const server = buildServer({ config, store, rateLimiter: mk(), publicRateLimiter: mk(), officeRateLimiter: mk(), loginRateLimiter: mk(),
    whatsappAdapter: { isConfigured: () => false }, metaSocialPostsAdapter: createMetaSocialPostsAdapter(config, graph), openaiClient: {}, toolExecutor: {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "content@synthetic.invalid", password: "synthetic-pass-123" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const created = await fetch(`${base}/api/lead-agents/admin/content`, { method: "POST", headers: { "content-type": "application/json", cookie, origin: base }, body: JSON.stringify({ title: "Synthetic website article", body: "Article body (fixture).", category: "Insights" }) });
  assert.equal(created.status, 201, "website article fixture created");
  const raw = JSON.stringify({ object: "page", entry: [{ id: PAGE, time: Math.floor(Date.now() / 1000) - 120, changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: `${PAGE}_c1`, post_id: `${PAGE}_p1`, from: { id: "920000000000001", name: "Ada Synthetic" }, message: "When is the next install slot? (fixture)", created_time: Math.floor(Date.now() / 1000) - 120 } }] }] });
  await fetch(`${base}/webhooks/meta-social`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex") }, body: raw });

  const PORT = await freePort();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "content-social-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--disable-features=BackForwardCache", "about:blank"], { stdio: "ignore" });
  const blocked = [], served = [];
  let ws;
  try {
    let targets;
    for (let i = 0; i < 100 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await new Promise((r) => setTimeout(r, 200)); } }
    assert.ok(targets, "Chrome DevTools is reachable");
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    let id = 0; const pending = new Map();
    const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
    ws.addEventListener("message", (e) => {
      const d = JSON.parse(e.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
      if (d.method === "Fetch.requestPaused") {
        const { requestId, request } = d.params; const host = new URL(request.url).hostname;
        if (host === "127.0.0.1") send("Fetch.continueRequest", { requestId });
        else if (/(\.|^)(fbcdn\.net|cdninstagram\.com)$/.test(host)) { served.push(host); send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "image/png" }], body: PNG }); }
        else { blocked.push(host); send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }); }
      }
    });
    const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
    const waitFor = async (expr, label) => { for (let i = 0; i < 150; i++) { if (await evalJs(expr)) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`timeout: ${label}`); };
    const shot = async (name) => { if (!process.env.OFFICE_CONTENT_SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(process.env.OFFICE_CONTENT_SHOTS, name), Buffer.from(r.result.data, "base64")); };
    const viewport = (width, height, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    const noOverflow = () => evalJs("document.documentElement.scrollWidth <= document.documentElement.clientWidth");
    await send("Page.enable"); await send("Runtime.enable"); await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await send("Network.setCookie", { name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: base });

    // ---- desktop
    await viewport(1440, 900);
    await send("Page.navigate", { url: `${base}/office#/content` });
    await waitFor("!!document.querySelector('.content-row')", "posts list");
    ok(await evalJs("document.querySelectorAll('.content-row-social').length === 1 && !!document.querySelector('.content-list-group')"), "desktop: Posts shows website articles first, then a Facebook & Instagram group (1 comment-first post before sync)");
    ok(await evalJs("!!document.querySelector('#contentSourceFilter') && !!document.querySelector('#contentSocialSync')"), "desktop: source filter and Sync button are shown");
    await evalJs("document.querySelector('#contentSocialSync').click()");
    await waitFor("/new/.test(document.querySelector('.content-social-status')?.textContent || '')", "sync result");
    ok(await evalJs("/2 new · 1 updated/.test(document.querySelector('.content-social-status').textContent) && document.querySelectorAll('.content-row-social').length === 3"), "desktop: sync reports 2 new and 1 updated (the comment-first post enriched in place); 3 social posts listed, no duplicates");
    ok(await evalJs("[...document.querySelectorAll('.content-row-social')].every((r) => r.querySelector('[data-source-chip]') && /Synced/.test(r.textContent)) && [...document.querySelectorAll('.content-row:not(.content-row-social)')].every((r) => !r.querySelector('[data-source-chip]'))"), "desktop: social rows carry a Facebook/Instagram source chip and a Synced badge; website rows do not");
    await evalJs("(() => { const s = document.querySelector('#contentSourceFilter'); s.value = 'instagram'; s.dispatchEvent(new Event('change')); })()");
    ok(await evalJs("document.querySelectorAll('.content-row').length === 1 && document.querySelector('.content-row').dataset.source === 'instagram'"), "desktop: source filter Instagram shows only the Instagram post");
    await evalJs("(() => { const s = document.querySelector('#contentSourceFilter'); s.value = 'website'; s.dispatchEvent(new Event('change')); })()");
    ok(await evalJs("document.querySelectorAll('.content-row-social').length === 0 && document.querySelectorAll('.content-row').length === 1"), "desktop: source filter Website shows only website articles");
    await evalJs("(() => { const s = document.querySelector('#contentSourceFilter'); s.value = ''; s.dispatchEvent(new Event('change')); })()");
    await shot("social-desktop-list.png");
    await evalJs("[...document.querySelectorAll('.content-row-social')].find((r) => /installation day/.test(r.textContent)).click()");
    await waitFor("!!document.querySelector('.content-social-view .content-comment')", "social post view");
    await waitFor("document.querySelector('.content-social-preview')?.complete && document.querySelector('.content-social-preview').naturalWidth > 0", "preview image");
    ok(await evalJs("/installation day/.test(document.querySelector('.content-social-caption').textContent) && /Read-only/.test(document.querySelector('.content-social-readonly').textContent) && !document.querySelector('.content-social-view textarea, .content-social-view [contenteditable], .content-social-view input')"), "desktop: social post opens read-only (caption, read-only note, no editor fields)");
    ok(await evalJs("document.querySelector('.content-social-links a').href === 'https://www.facebook.com/synthetic/posts/p1' && document.querySelector('.content-social-links a').rel.includes('noopener') && document.querySelector('.content-social-preview').referrerPolicy === 'no-referrer'"), "desktop: permalink opens on Facebook (noopener); preview loads with no referrer");
    ok(await evalJs("/When is the next install slot/.test(document.querySelector('.content-social-comments').textContent) && /Ada Synthetic/.test(document.querySelector('.content-social-comments').textContent)"), "desktop: the comment that arrived before sync is attached to this post");
    ok(await evalJs("/Facebook Page/.test(document.querySelector('#contentDetails').textContent) && /Synced/.test(document.querySelector('#contentDetails').textContent)"), "desktop: details pane shows source and sync state");
    ok(!/\b910000000000001\b|920000000000001/.test(await evalJs("document.body.innerText")), "desktop: no platform account, post or commenter id is shown");
    await evalJs("document.querySelector('.content-social-refresh').click()");
    await waitFor("!!document.querySelector('.content-social-view .content-comment') && !document.querySelector('.content-social-refresh')?.disabled", "refresh");
    ok(await noOverflow(), "desktop: no horizontal overflow");
    await shot("social-desktop-post.png");
    await evalJs("[...document.querySelectorAll('.content-row:not(.content-row-social)')][0].click()");
    await waitFor("!!document.querySelector('.content-head-title') && /Synthetic website article/.test(document.querySelector('.content-head-title').textContent)", "website editor");
    ok(true, "desktop: website articles still open in the existing editor");

    // ---- phone
    await viewport(390, 844, true);
    await send("Page.navigate", { url: `${base}/office#/content` });
    await evalJs("window.__beforeReload = true");
    await send("Page.reload"); // a fresh load at phone width, so no desktop layout state carries over
    await waitFor("!window.__beforeReload && document.querySelectorAll('.content-row-social').length === 3", "phone list after a fresh load");
    ok(await noOverflow(), "phone: Posts list (articles and social posts) has no horizontal overflow");
    await shot("social-phone-list.png");
    await evalJs("document.querySelector('.content-row-social[data-source=instagram]').click()");
    await waitFor("!!document.querySelector('.content-social-view') && /reel/.test(document.querySelector('.content-social-caption')?.textContent || '')", "phone instagram post");
    ok(await evalJs("document.querySelector('.content-social-view').getBoundingClientRect().width > 300") && await noOverflow(), "phone: Instagram post opens full width with no horizontal overflow");
    await shot("social-phone-post.png");

    ok(served.length > 0 && served.every((h) => /fbcdn\.net|cdninstagram\.com/.test(h)), `no request reached Meta: ${served.length} preview image request(s) were answered locally`);
    console.log(`(blocked non-local requests: ${blocked.length ? [...new Set(blocked)].join(", ") : "none"})`);
  } finally {
    try { ws?.close(); } catch { /* closed */ }
    chrome.kill("SIGKILL");
    server.closeAllConnections?.(); await new Promise((r) => server.close(r));
    fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log(`\nContent social posts browser (C2, desktop + phone): ${checks} checks PASS`);
}

main().catch((error) => { console.error(String(error && error.stack || error)); process.exit(1); });
