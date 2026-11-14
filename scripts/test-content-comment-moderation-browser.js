// Real-browser acceptance for comment moderation (C3) in Content → Posts and Content → Comments, desktop and phone. Headless Chrome
// over the DevTools protocol against the real Office server (file store, synthetic data, mocked Graph POST/GET). Every browser request
// is intercepted (local passes, Meta CDN answered locally, anything else blocked), so nothing reaches Meta. Fails with BLOCKED (never
// skips) when Chrome is unavailable. Also checks the Posts source filter has its own full-width row (no truncated label).
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");
const { createHmac } = require("node:crypto");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { createMetaSocialModerationAdapter } = require("../src/lead-agents/meta-social-moderation");

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const PAGE = "910000000000001", SECRET = "synthetic-secret";
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

async function main() {
  if (!CHROME) throw new Error("BLOCKED: Chrome is not installed (this suite fails rather than skipping)");
  const { store, tempDir } = await createTempStore();
  await store.ensureAdminUser({ email: "reviewer@synthetic.invalid", password_hash: hashPassword("synthetic-pass-123"), role: "ochiga_staff", display_name: "Synthetic Reviewer", status: "active" });
  await store.ensureAdminUser({ email: "writer@synthetic.invalid", password_hash: hashPassword("synthetic-pass-123"), role: "resident", display_name: "Synthetic Writer", status: "active", permission_scopes: ["content.write"] });
  // mocked Meta: real visibility per comment, scripted next POST outcome
  const hiddenState = new Map(); const next = [];
  const post = async (url, body, options) => {
    const id = decodeURIComponent(url.split("/").pop()); const mode = next.shift() || "ok";
    if (mode === "ok") { hiddenState.set(id, options.params.is_hidden); return { status: 200, data: { success: true } }; }
    if (mode === "not_applied") return { status: 200, data: { success: true } };
    if (mode === "token") throw Object.assign(new Error("graph"), { response: { status: 400, data: { error: { code: 190 } } } });
    throw new Error("unplanned");
  };
  const get = async (url) => { const id = decodeURIComponent(url.split("/").pop()); return { status: 200, data: { id, is_hidden: Boolean(hiddenState.get(id)) } }; };
  const mk = () => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5000 });
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["synthetic-api"], allowedOrigins: [], metaAppSecret: SECRET, metaSocialVerifyToken: "v",
    facebookPageId: PAGE, facebookPageAccessToken: "synthetic-token", metaSocialGraphVersion: "v23.0", officeBackendBaseUrl: "",
    metaSocialCommentsInboundEnabled: true, metaSocialPostsSyncEnabled: true, metaSocialCommentsModerationEnabled: true };
  const server = buildServer({ config, store, rateLimiter: mk(), publicRateLimiter: mk(), officeRateLimiter: mk(), loginRateLimiter: mk(), whatsappAdapter: { isConfigured: () => false },
    metaSocialModerationAdapter: createMetaSocialModerationAdapter(config, { post, get }), metaSocialPostsAdapter: { configured: () => false }, openaiClient: {}, toolExecutor: {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const t = Math.floor(Date.now() / 1000) - 900;
  const hook = (comment, message, from = { id: "920000000000001", name: "Ada Synthetic" }, offset = 0) => { const raw = JSON.stringify({ object: "page", entry: [{ id: PAGE, time: t + offset, changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: comment, post_id: `${PAGE}_p1`, from, message, created_time: t + offset } }] }] }); return fetch(`${base}/webhooks/meta-social`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex") }, body: raw }); };
  await hook(`${PAGE}_c1`, "Buy cheap followers here (fixture)", { id: "920000000000002", name: "Bo Synthetic" }, 0);
  await hook(`${PAGE}_c2`, "Another spam link (fixture)", { id: "920000000000003", name: "Cy Synthetic" }, 60);
  await hook(`${PAGE}_c3`, "Thanks for the question! (fixture)", { id: PAGE, name: "Synthetic Page" }, 120);
  const postId = store.state.office_social_posts[0].id;
  const cookieFor = async (email) => { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "synthetic-pass-123" }) }); return r.headers.get("set-cookie").split(";")[0]; };
  const reviewer = await cookieFor("reviewer@synthetic.invalid"), writer = await cookieFor("writer@synthetic.invalid");

  const PORT = await freePort();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "content-moderation-chrome-"));
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
        else if (/(\.|^)(fbcdn\.net|cdninstagram\.com)$/.test(host)) send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "image/png" }], body: PNG });
        else { blocked.push(host); send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }); }
      }
    });
    const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
    const waitFor = async (expr, label) => { for (let i = 0; i < 150; i++) { if (await evalJs(expr)) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`timeout: ${label}`); };
    const shot = async (name) => { if (!process.env.OFFICE_CONTENT_SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(process.env.OFFICE_CONTENT_SHOTS, name), Buffer.from(r.result.data, "base64")); };
    const viewport = (width, height, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    const noOverflow = () => evalJs("document.documentElement.scrollWidth <= document.documentElement.clientWidth");
    const as = async (cookie) => { await send("Network.clearBrowserCookies"); await send("Network.setCookie", { name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: base }); };
    const fresh = async (hash, ready, label) => { await send("Page.navigate", { url: `${base}/office#/${hash}` }); await evalJs("window.__old = true"); await send("Page.reload"); await waitFor(`!window.__old && (${ready})`, label); };
    const comment = (pid) => `document.querySelector('[data-comment]') && [...document.querySelectorAll('.content-comment')].find((n) => n.textContent.includes('${pid}'))`;
    await send("Page.enable"); await send("Runtime.enable"); await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });

    // ---- desktop, reviewer
    await viewport(1440, 900); await as(reviewer);
    await fresh("content", "!!document.querySelector('#contentSourceFilter')", "posts list");
    ok(await evalJs("(() => { const f = document.querySelector('#contentList').parentElement.querySelector('.rel-facets'); const s = document.querySelector('#contentSourceFilter'); return s.offsetWidth >= f.clientWidth * 0.9 && s.offsetTop > f.querySelector('select').offsetTop; })()"), "desktop: the source filter has its own full-width row (label no longer truncated); other filters unchanged");
    await shot("moderation-desktop-list.png");
    await fresh(`content/social:${postId}`, "!!document.querySelector('.content-social-view .content-comment')", "post view");
    ok(await evalJs("document.querySelectorAll('.content-moderation-toggle').length === 2 && ![...document.querySelectorAll('.content-comment')].find((n) => /Your Page/.test(n.textContent)).querySelector('.content-moderation-toggle')"), "desktop: Hide is offered on the two public comments, not on the Page's own reply");
    await evalJs(`(${comment("cheap followers")}).querySelector('.content-moderation-toggle').click()`);
    await waitFor("!!document.querySelector('.content-moderation-form')", "reason form");
    ok(await evalJs("/hidden from the public on Facebook Page/.test(document.querySelector('.content-moderation-label').textContent)"), "desktop: hiding asks for a reason and states the public effect");
    await evalJs("document.querySelector('.content-moderation-form').requestSubmit()");
    ok(await evalJs("/at least 3 characters/.test(document.querySelector('.content-moderation-error').textContent) || document.querySelector('.content-moderation-reason').validity.valueMissing"), "desktop: an empty reason is refused before anything is sent");
    await evalJs("document.querySelector('.content-moderation-reason').value = 'Spam link (fixture)'; document.querySelector('.content-moderation-form').requestSubmit()");
    await waitFor(`(${comment("cheap followers")})?.querySelector('.content-moderation-toggle')?.dataset.moderationAction === 'unhide'`, "hidden");
    ok(await evalJs(`/Hidden/.test((${comment("cheap followers")}).querySelector('.content-comment-meta').textContent) && (${comment("cheap followers")}).classList.contains('is-hidden')`), "desktop: after a confirmed hide the comment shows Hidden and offers Unhide");
    next.push("not_applied");
    await evalJs(`(${comment("Another spam")}).querySelector('.content-moderation-toggle').click()`);
    await waitFor("!!document.querySelector('.content-moderation-form')", "form 2");
    await evalJs("document.querySelector('.content-moderation-reason').value = 'Spam (fixture)'; document.querySelector('.content-moderation-form').requestSubmit()");
    await waitFor(`!!(${comment("Another spam")})?.querySelector('[data-moderation-state=unknown]')`, "unknown");
    ok(await evalJs(`(() => { const n = ${comment("Another spam")}; return /Couldn't confirm the hide yet/.test(n.textContent) && !n.classList.contains('is-hidden') && n.querySelector('.content-moderation-toggle').disabled && !!n.querySelector('.content-moderation-check'); })()`), "desktop: an unconfirmed outcome is shown as such (not Hidden), blocks further actions and offers Check again");
    await shot("moderation-desktop-unknown.png");
    hiddenState.set(`${PAGE}_c2`, true);
    await evalJs(`(${comment("Another spam")}).querySelector('.content-moderation-check').click()`);
    await waitFor(`(${comment("Another spam")})?.classList.contains('is-hidden')`, "reconciled");
    ok(await evalJs(`!(${comment("Another spam")}).querySelector('[data-moderation-state]')`), "desktop: Check again confirms the hide from the platform's read-back");
    next.push("token");
    await evalJs(`(${comment("cheap followers")}).querySelector('.content-moderation-toggle').click()`);
    await waitFor("!!document.querySelector('.content-moderation-form')", "form 3");
    await evalJs("document.querySelector('.content-moderation-reason').value = 'Restore after review (fixture)'; document.querySelector('.content-moderation-form').requestSubmit()");
    await waitFor(`!!(${comment("cheap followers")})?.querySelector('[data-moderation-state=failed]')`, "failed");
    ok(await evalJs(`/The unhide failed. Office's access token has expired or was revoked/.test((${comment("cheap followers")}).textContent) && (${comment("cheap followers")}).classList.contains('is-hidden')`), "desktop: an expired token is reported as a failure and the comment stays hidden");
    ok(await noOverflow(), "desktop: no horizontal overflow");
    await shot("moderation-desktop-post.png");
    await fresh(`content/comments/${postId}`, "!!document.querySelector('.content-comments-list .content-comment')", "comments tab");
    ok(await evalJs("document.querySelectorAll('.content-comments-list .content-moderation-toggle').length === 2 && /hide or unhide/.test(document.querySelector('.content-comments-readonly').textContent)"), "desktop: the Comments tab offers the same moderation inside the post's thread");

    // ---- desktop, staff without content.review
    await as(writer);
    await fresh(`content/social:${postId}`, "!!document.querySelector('.content-social-view .content-comment')", "writer view");
    ok(await evalJs("document.querySelectorAll('.content-moderation-toggle, .content-moderation-check').length === 0"), "desktop: staff without content.review see the comments but no moderation controls");

    // ---- phone, reviewer
    await viewport(390, 844, true); await as(reviewer);
    await fresh(`content/social:${postId}`, "!!document.querySelector('.content-social-view .content-comment')", "phone post");
    await evalJs(`(${comment("Another spam")}).querySelector('.content-moderation-toggle').click()`);
    await waitFor("!!document.querySelector('.content-moderation-form')", "phone form");
    ok(await noOverflow() && await evalJs("document.querySelector('.content-moderation-reason').getBoundingClientRect().right <= window.innerWidth"), "phone: moderation controls and the reason form fit with no horizontal overflow");
    await shot("moderation-phone-form.png");
    await evalJs("document.querySelector('.content-moderation-reason').value = 'Reviewed, not spam (fixture)'; document.querySelector('.content-moderation-form').requestSubmit()");
    await waitFor(`!(${comment("Another spam")})?.classList.contains('is-hidden')`, "phone unhide");
    ok(true, "phone: unhide confirmed and shown");
    ok(blocked.length === 0, "no request left the machine (nothing external attempted)");
  } finally {
    try { ws?.close(); } catch { /* closed */ }
    chrome.kill("SIGKILL");
    server.closeAllConnections?.(); await new Promise((r) => server.close(r));
    fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log(`\nContent comment moderation browser (C3, desktop + phone): ${checks} checks PASS`);
}

main().catch((error) => { console.error(String(error && error.stack || error)); process.exit(1); });
