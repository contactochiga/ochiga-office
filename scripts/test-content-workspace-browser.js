// Real-browser acceptance test for the Content Workspace (Content Modernization, Slice 2): headless Google Chrome driven over the DevTools protocol
// against the real Office server (temporary file store, in-memory Sanity fake, fixture posts only). Skips (exit 0) when Chrome is not installed.
// Writes screenshots to OFFICE_CONTENT_SHOTS if set. Covers layout (desktop, tablet, phone), deep links, search and filters, editor functions,
// unsaved-changes protection, every workflow outcome (approval withdrawal, stale approval, failed publish + retry, schedule validation, stale
// review), permissions, Overview / Calendar / Table views, and that no engagement numbers are shown for unconnected channels. Edit / Preview / History are
// checked by what is actually rendered at every width, the writer of a post is not offered Approve on it, the header names the creator (Office has no
// last-editor record), a legacy image link is flagged, and no Content control sits under the floating Oyi orb.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { setSanityClientFactoryForTests } = require("../src/lead-agents/sanity-adapter");

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const PORT = 9361;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
let checks = 0;
const ok = (cond, name) => { assert.ok(cond, name); checks += 1; console.log("PASS " + name); };

// In-memory @sanity/client stand-in (same shape as the content-integrity suite's).
function createFakeSanity() {
  const docs = new Map();
  const hooks = { failDraftSave: false };
  let rev = 0;
  return {
    hooks,
    client: {
      fetch: async () => null,
      assets: { upload: async () => ({ _id: "image-asset" }) },
      async createOrReplace(doc) {
        if (hooks.failDraftSave && String(doc._id).startsWith("drafts.")) throw new Error("sanity unavailable");
        const stored = { ...doc, _rev: `rev-${++rev}` };
        docs.set(doc._id, stored);
        return stored;
      },
      async getDocument(id) { return docs.has(id) ? { ...docs.get(id) } : undefined; },
      async delete(id) { docs.delete(id); },
      async createIfNotExists(doc) { if (!docs.has(doc._id)) docs.set(doc._id, { ...doc, _rev: `rev-${++rev}` }); return docs.get(doc._id); },
    },
  };
}

const PNG_1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function main() {
  if (!CHROME) { console.log("SKIP: Chrome not installed"); return; }
  const sanity = createFakeSanity();
  const savedEnv = { SANITY_PROJECT_ID: process.env.SANITY_PROJECT_ID, SANITY_DATASET: process.env.SANITY_DATASET, SANITY_API_WRITE_TOKEN: process.env.SANITY_API_WRITE_TOKEN, OFFICE_CONTENT_SCHEDULER_ENABLED: process.env.OFFICE_CONTENT_SCHEDULER_ENABLED };
  Object.assign(process.env, { SANITY_PROJECT_ID: "test-project", SANITY_DATASET: "test", SANITY_API_WRITE_TOKEN: "test-token-not-a-secret" });
  delete process.env.OFFICE_CONTENT_SCHEDULER_ENABLED;
  setSanityClientFactoryForTests(() => sanity.client);

  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "content-ws-storage-"));
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["content-ws-key"], allowedOrigins: [], officeStorageDriver: "local", officeStorageDir: storageDir, officeEmailProvider: "", resendApiKey: "" };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Publisher", status: "active" });
  await store.ensureAdminUser({ email: "writer@ochiga.local", password_hash: hashPassword("writer-pass-123"), role: "ochiga_staff", display_name: "Writer", status: "active" });
  await store.ensureAdminUser({ email: "reviewer@ochiga.local", password_hash: hashPassword("reviewer-pass-123"), role: "ochiga_staff", display_name: "Reviewer", status: "active" });
  const webhooks = new WebhookDispatcher({ config });
  const server = buildServer({
    config, store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60000, maxRequests: 5000 }), publicRateLimiter: new MemoryRateLimiter({ windowMs: 60000, maxRequests: 5000 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60000, maxRequests: 5000 }), loginRateLimiter: new MemoryRateLimiter({ windowMs: 60000, maxRequests: 100 }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] }, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks }),
  });
  const base = `http://127.0.0.1:${await listen(server)}`;

  const cookies = {};
  for (const [who, pass] of [["super", "super-pass-123"], ["writer", "writer-pass-123"], ["reviewer", "reviewer-pass-123"]]) {
    const res = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${who}@ochiga.local`, password: pass }) });
    assert.equal(res.status, 200, `login ${who}`);
    cookies[who] = res.headers.get("set-cookie").split(";")[0];
  }
  const api = async (who, method, p, body) => {
    const res = await fetch(`${base}/api/lead-agents/admin${p}`, { method, headers: { "content-type": "application/json", cookie: cookies[who] }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const create = async (title, extra = {}) => (await api("writer", "POST", "/content", { title, body: `${title} body`, author: "Writer", category: "Oyi", ...extra })).data.item.id;
  const approve = async (id) => {
    await api("writer", "POST", `/content/${id}/submit-review`, {});
    const shown = await api("reviewer", "GET", `/content/${id}`);
    assert.equal((await api("reviewer", "POST", `/content/${id}/approve`, { content_fingerprint: shown.data.item.content_fingerprint })).status, 200);
  };

  // fixtures (created oldest first; the newest is selected by default)
  const image = (await api("writer", "POST", "/storage", { data_url: PNG_1x1, purpose: "content_featured_image", filename: "cover.png", mime_type: "image/png" })).data.file.url;
  const pPublished = await create("Alpha published post");
  await approve(pPublished);
  assert.equal((await api("super", "POST", `/content/${pPublished}/publish`, {})).status, 200);
  const pLegacyPublished = await create("Legacy published post");
  await store.updateContentItem(pLegacyPublished, { workflow_status: "published", sanity_live_url: "https://ochiga.com.ng/insights/legacy" }); // published before publish dates were recorded
  const pScheduled = await create("Gamma scheduled post");
  await approve(pScheduled);
  const scheduledAt = new Date(Date.now() + 2 * 86400000);
  scheduledAt.setHours(10, 0, 0, 0);
  assert.equal((await api("super", "POST", `/content/${pScheduled}/schedule`, { scheduled_publish_at: scheduledAt.toISOString() })).status, 200);
  const pReview = await create("Delta in review");
  await api("writer", "POST", `/content/${pReview}/submit-review`, {});
  const pApprovedEdit = await create("Epsilon approved, to be edited");
  await approve(pApprovedEdit);
  const pStale = await create("Zeta stale approval");
  await approve(pStale);
  const pFail = await create("Eta publish will fail");
  await approve(pFail);
  const pSchedule = await create("Theta to schedule");
  await approve(pSchedule);
  const pOwnReview = await create("Kappa writer's own post in review");
  await api("writer", "POST", `/content/${pOwnReview}/submit-review`, {});
  const pLegacyLink = (await store.createContentItem({ title: "Lambda legacy image link", body: "Lambda body", slug: "lambda", featured_image_url: "/legacy/old-cover.jpg", created_by: "writer@ochiga.local" })).id; // saved before uploads were required
  const LONG_TITLE = "Nu: a deliberately long article title about integrated smart-building operating systems, estate security, energy monitoring and resident services across Lagos";
  const pLongTitle = await create(LONG_TITLE);
  // published before warnings were dated (the live article's case): the old draft-sync warnings, no time or step recorded
  await store.updateContentItem(pLegacyPublished, { metadata: { sanity_warnings: ["No matching Sanity author named \"Writer\" — publish without one, or create it in Sanity Studio first.", "Featured image could not be uploaded to Sanity — publishing without a cover image."] } });
  const pDraft = await create("Iota newest draft", { featured_image_url: image, excerpt: "Newest draft excerpt" });
  const TOTAL = 12;

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "content-ws-chrome-"));
  // No back/forward cache: each user switch leaves the previous Office page cached with its notification stream (EventSource) still open, and after
  // six switches Chrome's HTTP/1.1 per-host connection limit (the local test server is not HTTP/2) queues the next request forever.
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--disable-features=BackForwardCache", "about:blank"], { stdio: "ignore" });
  let ws;
  let id = 0;
  const pending = new Map();
  try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await sleep(200); } }
    assert.ok(targets, "Chrome DevTools is reachable");
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
    const errors = [];
    const dialogs = [];
    let dialogAnswer = false;
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
      if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
      if (d.method === "Page.javascriptDialogOpening") { dialogs.push(d.params.message); send("Page.handleJavaScriptDialog", { accept: dialogAnswer }); }
    };
    const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
    const waitFor = async (expr, label, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJs(expr)) return true; } catch { /* navigating */ } await sleep(120); } throw new Error(`timeout waiting for: ${label}`); };
    const shot = async (name) => { if (!process.env.OFFICE_CONTENT_SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(process.env.OFFICE_CONTENT_SHOTS, name), Buffer.from(r.result.data, "base64")); };
    const viewport = (width, height, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    // a new session needs a full page load (a hash-only navigation would keep the previous user's Office session in memory)
    const asUser = async (who) => {
      await send("Network.setCookie", { name: cookies[who].split("=")[0], value: cookies[who].split("=").slice(1).join("="), url: base });
      await send("Page.navigate", { url: "about:blank" });
      await sleep(150);
    };
    const open = async (hash, ready, label) => { await send("Page.navigate", { url: `${base}/office#/${hash}` }); await waitFor(ready, label); };
    const text = (sel) => evalJs(`(document.querySelector(${JSON.stringify(sel)})?.textContent || "").replace(/\\s+/g, " ").trim()`);
    const setField = (name, value) => evalJs(`(() => { const f = document.querySelector('.content-form [name="${name}"]'); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    const clickPrimary = () => evalJs(`document.querySelector('.content-primary-action').click()`);
    const openMenuItem = async (label) => {
      await evalJs(`document.querySelector('.content-actionbar .portfolio-overflow-trigger').click()`);
      await waitFor(`[...document.querySelectorAll('.portfolio-overflow-item')].some((b) => b.textContent.trim() === ${JSON.stringify(label)} && b.offsetParent)`, `menu item ${label}`);
      await evalJs(`[...document.querySelectorAll('.portfolio-overflow-item')].find((b) => b.textContent.trim() === ${JSON.stringify(label)} && b.offsetParent).click()`);
    };
    const notice = () => text(".content-notice:not([data-notice-key])");
    // what is on screen, not the hidden attribute: rendered (display not none, a box) and the topmost element at its centre inside it
    const rendered = (sel) => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0; })()`);
    const modeCheck = async (label) => {
      for (const mode of ["preview", "history", "edit"]) {
        await evalJs(`document.querySelector('.content-mode[data-mode=${mode}]').click()`);
        await sleep(150);
        const shown = { edit: await rendered(".content-form"), preview: await rendered(".content-preview-pane"), history: await rendered(".content-history-pane") };
        const atCentre = await evalJs(`(() => { const s = document.querySelector('.content-scroll').getBoundingClientRect(); const e = document.elementFromPoint(s.left + s.width / 2, s.top + 40); return e?.closest('[data-panel]')?.dataset.panel || (e?.closest('.content-scroll') ? 'scroll' : 'outside'); })()`);
        ok(Object.entries(shown).every(([m, v]) => v === (m === mode)) && (atCentre === mode || (mode !== "edit" && atCentre === "scroll")), `${label}: ${mode} shows only the ${mode} panel on screen (${JSON.stringify(shown)}, at centre: ${atCentre})`);
        const bar = await evalJs(`({ save: !!document.querySelector('.content-save-btn'), saveState: (() => { const e = document.querySelector('.content-save-state'); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; })(), editNote: [...document.querySelectorAll('.content-actionbar-note')].some((n) => /not republished/.test(n.textContent)), back: !!document.querySelector('.content-back-to-edit'), dirty: document.querySelector('.content-save-state')?.classList.contains('content-dirty') || !!document.querySelector('.content-unsaved-note'), menu: !!document.querySelector('.content-actionbar .portfolio-overflow-trigger') })`);
        const barOk = mode === "edit" ? bar.save && bar.menu && !bar.back : !bar.save && !bar.saveState && !bar.editNote && bar.menu && bar.back === bar.dirty;
        ok(barOk, `${label}: the ${mode} action bar ${mode === "edit" ? "has Save" : "has no Save or editing notes" + (bar.dirty ? ", and offers Back to Edit for the unsaved changes" : "")} (${JSON.stringify(bar)})`);
      }
    };
    // controls the floating Oyi orb covers (the details pane scrolled to its end, where its last controls are)
    const underOrb = async () => {
      const hits = [];
      for (const where of ["top", "end"]) {
        await evalJs(`(() => { const d = document.querySelector('.content-details-pane'); if (d) d.scrollTop = ${where === "top" ? 0 : "d.scrollHeight"}; })()`);
        await sleep(100);
        hits.push(...(await underOrbNow()).map((h) => `${where}: ${h}`));
      }
      return hits;
    };
    // also any text in the details pane (workflow information), not only controls
    const underOrbNow = () => evalJs(`(() => { const orb = document.getElementById('oyiBar'); if (!orb || !orb.offsetParent) return ['orb not shown']; const o = orb.getBoundingClientRect();
        const visible = (e) => { const r = e.getBoundingClientRect(); const clip = e.closest('.content-details-pane, .content-list, .content-scroll'); const c = clip ? clip.getBoundingClientRect() : { top: -1e9, bottom: 1e9 }; return { left: r.left, right: r.right, top: Math.max(r.top, c.top), bottom: Math.min(r.bottom, c.bottom), w: r.width }; };
        return [...document.querySelectorAll('.content-page button, .content-page a, .content-page summary, .content-page select, .content-page input:not([type=hidden])')].filter((e) => { const r = visible(e); return e.offsetParent && r.w && r.bottom > r.top && getComputedStyle(e).visibility !== 'hidden' && r.left < o.right && r.right > o.left && r.top < o.bottom && r.bottom > o.top && e.closest('.content-actionbar, .content-details-pane, .content-hero-actions, .content-list'); }).map((e) => e.textContent.trim().slice(0, 30) || e.className)
          .concat([...document.querySelectorAll('.content-details-pane .rel-fact, .content-details-pane .content-history-item, .content-details-pane .content-dest, .content-details-pane .content-warning, .content-details-pane summary')].filter((e) => { const r = e.getBoundingClientRect(); const d = document.querySelector('.content-details-pane').getBoundingClientRect(); const top = Math.max(r.top, d.top), bottom = Math.min(r.bottom, d.bottom); return e.offsetParent && bottom > top && r.left < o.right && r.right > o.left && top < o.bottom && bottom > o.top; }).map((e) => 'info: ' + e.textContent.trim().slice(0, 30))); })()`);
    const select = async (postId) => { await evalJs(`location.hash = '#/content/${postId}'`); await waitFor(`document.querySelector('.content-form [name=title]') && document.querySelector('.content-row.active')?.dataset.contentId === '${postId}'`, `post ${postId} selected`); };

    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
    await asUser("super");
    await viewport(1440, 900);

    // 1. Posts workspace: tabs, three panes, list, default selection, honest publishing/engagement panels
    await open("content", `!!document.querySelector('.content-page .content-form')`, "posts workspace");
    ok(await evalJs(`[...document.querySelectorAll('.content-tabs .crm-tab')].map((t) => t.textContent.replace(/\\s+/g, ' ').trim()).join('|')`) === "Overview|Posts|Calendar|Comments|Analytics Soon", "tabs: Overview | Posts | Calendar | Comments (shows its connection state) | Analytics (soon)");
    ok(await evalJs(`document.querySelector('.content-tabs .crm-tab.active').textContent.trim() === 'Posts' && [...document.querySelectorAll('.content-tab-soon')].every((t) => t.disabled) && !!document.querySelector('[data-content-tab=comments]')`), "Posts is active; Comments is available and Analytics is disabled");
    ok(await evalJs(`!!document.querySelector('.content-new-post') && document.querySelector('.content-new-post').textContent.trim() === 'New Post'`), "a simple New Post button");
    ok(await evalJs(`['.content-list-pane', '.content-main-pane', '.content-details-pane'].every((s) => document.querySelector(s).getBoundingClientRect().width > 200)`), "three visible panes at desktop width");
    ok(await evalJs(`document.querySelectorAll('.content-row').length`) === TOTAL && (await text("#contentCount")) === `(${TOTAL})`, "every post is listed, with the count");
    ok(await evalJs(`document.querySelector('.content-row.active').dataset.contentId`) === pDraft && (await evalJs(`document.querySelector('.content-form [name=title]').value`)) === "Iota newest draft", "without a post in the URL the most recently updated post is selected");
    ok(await evalJs(`document.querySelector('.content-row[data-content-id="${pDraft}"] img.content-thumb')?.naturalWidth === 1 && !!document.querySelector('.content-row[data-content-id="${pPublished}"] .content-thumb-empty')`), "real featured-image thumbnails; a placeholder when a post has none");
    ok(await evalJs(`!!document.querySelector('.content-row[data-content-id="${pPublished}"] .content-web-live') && !!document.querySelector('.content-row[data-content-id="${pScheduled}"] .content-web-pending') && !document.querySelector('.content-row[data-content-id="${pDraft}"] .content-web')`), "website state icon only for live / scheduled posts");
    const destinations = await evalJs(`[...document.querySelectorAll('#contentDetails .content-dest')].map((d) => d.textContent.replace(/\\s+/g, ' ').trim())`);
    ok(destinations.length === 4 && /Website/.test(destinations[0]) && ["Instagram", "Facebook Page", "LinkedIn"].every((n, i) => destinations[i + 1].includes(n) && destinations[i + 1].includes("Not connected")), "Publish to: Website, then Instagram, Facebook Page and LinkedIn as not connected");
    ok(await evalJs(`[...document.querySelectorAll('#contentDetails .content-dest-disabled')].every((d) => d.getAttribute('aria-disabled') === 'true' && !d.querySelector('input,button'))`), "unconnected channels are disabled and offer no controls");
    ok(await evalJs(`[...document.querySelectorAll('[data-panel-kind]')].every((p) => !/\\d/.test(p.textContent) && /Not connected/.test(p.textContent))`), "performance and comments panels show 'Not connected' and no numbers");
    await waitFor(`document.querySelectorAll('#contentDetails .content-history-item').length > 0`, "recent activity");
    ok(/Created/.test(await text("#contentDetails .content-activity")), "compact recent activity in the details pane");
    await shot("content-posts-desktop.png");
    ok(await evalJs(`(() => { const s = getComputedStyle(document.querySelector('#contentStatusFilter')), q = getComputedStyle(document.querySelector('#contentSearch')), t = getComputedStyle(document.querySelector('#contentTimeFilter')); return s.appearance === 'none' && t.appearance === 'none' && s.borderRadius === q.borderRadius && s.backgroundColor === q.backgroundColor && s.fontSize === q.fontSize && s.backgroundImage.includes('svg'); })()`), "status and time dropdowns use the Office field style (search field surface, radius and size, drawn chevron)");
    const coveredDesktop = await underOrb();
    ok(coveredDesktop.length === 0, `desktop: no Content control is under the Oyi orb (${JSON.stringify(coveredDesktop)})`);

    // 2. Search and filters
    await evalJs(`(() => { const s = document.querySelector('#contentSearch'); s.value = 'gamma'; s.dispatchEvent(new Event('input')); })()`);
    await waitFor(`document.querySelectorAll('.content-row').length === 1`, "search");
    ok((await text("#contentCount")) === `(1 of ${TOTAL})` && (await text(".content-row-title")) === "Gamma scheduled post", "search narrows the list and the count shows 'n of total'");
    await evalJs(`(() => { const s = document.querySelector('#contentSearch'); s.value = ''; s.dispatchEvent(new Event('input')); const f = document.querySelector('#contentStatusFilter'); f.value = 'approved'; f.dispatchEvent(new Event('change')); })()`);
    await waitFor(`document.querySelectorAll('.content-row').length === 4`, "status filter");
    ok(await evalJs(`[...document.querySelectorAll('.content-row .badge')].every((b) => b.textContent.trim() === 'Approved')`), "status filter shows only that status");
    await evalJs(`(() => { const f = document.querySelector('#contentStatusFilter'); f.value = ''; f.dispatchEvent(new Event('change')); const t = document.querySelector('#contentTimeFilter'); t.value = '7d'; t.dispatchEvent(new Event('change')); })()`);
    await waitFor(`document.querySelectorAll('.content-row').length === ${TOTAL}`, "time filter (all recent)");
    ok(true, "time filter keeps posts updated within the period");
    await evalJs(`(() => { const t = document.querySelector('#contentTimeFilter'); t.value = ''; t.dispatchEvent(new Event('change')); })()`);

    // 3. Deep link + in-place selection; editor functions
    await open(`content/${pReview}`, `document.querySelector('.content-form [name=title]')?.value === 'Delta in review'`, "deep link");
    ok(await evalJs(`document.querySelector('.content-row.active').dataset.contentId`) === pReview && (await text(".content-head-badge")) === "In Review", "a deep link #/content/:id opens that post (existing links keep working)");
    await evalJs(`window.__marker = 1`);
    await select(pDraft);
    ok(await evalJs(`window.__marker === 1 && !!document.querySelector('.content-page')`), "selecting another post updates in place (no page reload)");
    await evalJs(`(() => { const ta = document.querySelector('textarea[name=body]'); ta.focus(); ta.selectionStart = ta.selectionEnd = 0; const s = document.querySelector('.content-style-select'); s.value = '# '; s.dispatchEvent(new Event('change')); })()`);
    ok((await evalJs(`document.querySelector('textarea[name=body]').value`)).startsWith("# Iota newest draft body"), "paragraph style 'Heading' writes the '# ' marker Sanity converts to h2");
    ok(await evalJs(`[...document.querySelectorAll('.content-style-select option')].map((o) => o.textContent).join('|')`) === "Normal|Heading|Subheading|Minor heading" && (await evalJs(`[...document.querySelectorAll('.content-tool')].map((b) => b.title).join('|')`)) === "Bold|Italic|Bullet list|Full screen", "only formatting that survives the Sanity conversion is offered");
    await evalJs(`(() => { const ta = document.querySelector('textarea[name=body]'); ta.selectionStart = 2; ta.selectionEnd = 6; document.querySelector('.content-tool-bold').click(); })()`);
    ok((await evalJs(`document.querySelector('textarea[name=body]').value`)).startsWith("# **Iota** newest"), "Bold wraps the selection");
    ok((await text(".content-save-state")) === "Unsaved changes" && (await evalJs(`document.querySelector('.content-primary-action').disabled && !document.querySelector('.content-save-btn').disabled`)), "an edit marks unsaved changes; workflow actions wait for Save");
    await evalJs(`document.querySelector('.content-mode[data-mode=preview]').click()`);
    ok(await evalJs(`!!document.querySelector('.content-preview-pane h2 strong')`) && !(await rendered(".content-form")) && (await rendered(".content-preview-pane")), "Preview renders the unsaved editor content, and the form is not on screen");
    ok(await evalJs(`!document.querySelector('.content-save-btn') && !!document.querySelector('.content-back-to-edit') && /Unsaved changes/.test(document.querySelector('.content-actionbar').textContent) && document.querySelector('.content-primary-action').disabled`), "with unsaved edits, Preview offers Back to Edit (no Save) and workflow actions stay blocked");
    await evalJs(`document.querySelector('.content-back-to-edit').click()`);
    ok(await rendered(".content-form") && (await evalJs(`!!document.querySelector('.content-save-btn') && !document.querySelector('.content-save-btn').disabled`)), "Back to Edit returns to the form with Save available, edits intact");
    await evalJs(`document.querySelector('.content-mode[data-mode=preview]').click()`);
    await modeCheck("desktop");
    await evalJs(`document.querySelector('.content-tool-full').click()`);
    ok(await evalJs(`document.querySelector('.content-page').classList.contains('content-focus') && getComputedStyle(document.querySelector('.content-list-pane')).display === 'none'`), "Full screen hides the list and details");
    await evalJs(`document.querySelector('.content-tool-full').click()`);

    // 4. Unsaved changes: leaving asks; Cancel keeps the post; Save clears it
    dialogAnswer = false;
    await evalJs(`document.querySelector('.content-row[data-content-id="${pReview}"]').click()`);
    await sleep(500);
    ok(dialogs.length === 1 && /unsaved changes/.test(dialogs[0]) && (await evalJs(`location.hash`)) === `#/content/${pDraft}` && (await evalJs(`document.querySelector('.content-form [name=title]').value`)) === "Iota newest draft", "leaving with unsaved changes asks; Cancel keeps the post and its URL");
    await evalJs(`document.querySelector('.content-tabs [data-content-tab=overview]').click()`);
    await sleep(300);
    ok(dialogs.length === 2 && !!(await evalJs(`document.querySelector('.content-page')`)), "switching tabs with unsaved changes asks too");
    await evalJs(`document.querySelector('.content-save-btn').click()`);
    await waitFor(`/Saved/.test(document.querySelector('.content-save-state').textContent)`, "saved");
    ok((await store.getContentItemById(pDraft)).body.startsWith("# **Iota**") && (await evalJs(`!document.querySelector('.content-primary-action').disabled`)), "Save persists the edit and re-enables workflow actions");

    // 5. Featured image Replace / Remove
    ok(await evalJs(`!document.querySelector('.content-hero-img').hidden && document.querySelector('.content-hero-replace').textContent === 'Replace' && !document.querySelector('.content-hero-remove').hidden`), "a large featured image with Replace and Remove");
    await evalJs(`document.querySelector('.content-hero-remove').click()`);
    ok(await evalJs(`document.querySelector('.content-hero-img').hidden && document.querySelector('.content-form [name=featured_image_url]').value === '' && document.querySelector('.content-hero-replace').textContent === 'Add image'`) && (await text(".content-save-state")) === "Unsaved changes", "Remove clears the image and marks the post unsaved");
    await evalJs(`document.querySelector('.content-save-btn').click()`);
    await waitFor(`/Saved/.test(document.querySelector('.content-save-state').textContent)`, "saved removal");
    ok((await store.getContentItemById(pDraft)).featured_image_url === "", "the removal is saved");

    // 5b. A legacy image link is flagged where the image is shown
    await select(pLegacyLink);
    ok(/not an Office upload, so it is not sent to the website/.test(await text(".content-hero-legacy")) && (await rendered(".content-hero-legacy")), "a cover saved as a link says it is not sent to the website and to upload it");
    ok(/^Created by writer@ochiga\.local · last updated /.test(await text(".content-head-sub")), "the header names the creator as 'Created by' (no last-editor attribution is claimed)");

    // 5c. Long titles wrap beside the badge; the list row keeps two lines
    await select(pLongTitle);
    const head = await evalJs(`(() => { const t = document.querySelector('.content-head-title'), b = document.querySelector('.content-head-badge'), h = document.querySelector('.content-head'); const lh = parseFloat(getComputedStyle(t).lineHeight); return { lines: Math.round(t.getBoundingClientRect().height / lh), badgeInside: b.getBoundingClientRect().right <= h.getBoundingClientRect().right + 1 && b.getBoundingClientRect().width > 0, overflow: h.scrollWidth > h.clientWidth + 1, tip: t.title }; })()`);
    ok(head.lines >= 2 && head.lines <= 3 && head.badgeInside && !head.overflow && head.tip === LONG_TITLE, `a long title wraps (at most three lines, full title on hover) with the badge beside it (${JSON.stringify(head)})`);
    const rowLines = await evalJs(`(() => { const t = document.querySelector('.content-row[data-content-id="${pLongTitle}"] .content-row-title'); return Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight)); })()`);
    ok(rowLines === 2, `the list row shows a long title on two lines (${rowLines})`);

    // 5d. Warnings recorded at an earlier sync are labelled as such; "Check Sanity now" reports the current state, read-only
    await select(pLegacyPublished);
    ok(/before 12 Nov 2026/.test(await text("#contentDetails .content-sanity-when")) && /before this version was published/.test(await text("#contentDetails .content-sanity-when")) && /Earlier image method, replaced 12 Nov 2026/.test(await text("#contentDetails .content-warning-retired")), "an undated warning on a published post is labelled as recorded at an earlier sync, before publishing; the retired image message is marked");
    await evalJs(`document.querySelector('.content-sanity-check').click()`);
    await waitFor(`/Read-only/.test(document.querySelector('.content-sanity-current')?.textContent || '')`, "sanity check");
    ok(/No live article was found in Sanity/.test(await text(".content-sanity-current")) && /Author "Writer" does not exist in Sanity/.test(await text(".content-sanity-current")), "Check Sanity now lists what Sanity holds now (here: no live document, no such author)");

    // 6. Edit after approval: withdrawal notice now and after a reload
    await select(pApprovedEdit);
    ok((await evalJs(`document.querySelector('.content-primary-action').textContent`)) === "Publish now", "an approved post's primary action is Publish now (publisher)");
    await setField("body", "Edited after approval");
    await evalJs(`document.querySelector('.content-save-btn').click()`);
    await waitFor(`/approval was withdrawn/.test(document.querySelector('.content-notices').textContent)`, "withdrawal notice");
    ok((await text(".content-head-badge")) === "Draft" && (await evalJs(`!!document.querySelector('[data-notice-key=withdrawal]')`)) && (await evalJs(`/Needs re-approval/.test(document.querySelector('.content-row.active').textContent)`)), "saving an approved post says the approval was withdrawn, shows Draft and marks the row");
    await shot("content-approval-withdrawn.png");
    await evalJs(`window.__beforeReload = 1`);
    await send("Page.reload");
    await waitFor(`!window.__beforeReload && document.readyState === 'complete' && !!document.querySelector('[data-notice-key=withdrawal]')`, "withdrawal note after reload");
    ok(/Approval withdrawn when it was saved/.test(await text("[data-notice-key=withdrawal]")) && /edited after it was approved/.test(await text("[data-notice-key=withdrawal]")), "the withdrawal is still explained after a reload (metadata.last_approval_withdrawal)");
    await evalJs(`document.querySelector('.content-mode[data-mode=history]').click()`);
    await waitFor(`document.querySelectorAll('.content-history-pane .content-history-item').length >= 4`, "history tab");
    ok(/Approval withdrawn/.test(await text(".content-history-pane")) && /Approved/.test(await text(".content-history-pane")) && /Created/.test(await text(".content-history-pane")), "the History tab lists this post's workflow from the history API");

    // 7. Stale approval refused at publish -> returned to review, explained
    await store.updateContentItem(pStale, { body: "changed outside the editor" });
    await select(pStale);
    await clickPrimary();
    await waitFor(`/returned to review/.test(document.querySelector('.content-notices').textContent)`, "stale refusal notice");
    ok((await text(".content-head-badge")) === "In Review" && (await evalJs(`!!document.querySelector('[data-notice-key=withdrawal]')`)), "a stale approval is refused, the post shows In Review and why");

    // 8. Failed publish: nothing changed, Try again works
    await select(pFail);
    sanity.hooks.failDraftSave = true;
    await clickPrimary();
    await waitFor(`!!document.querySelector('.content-notice-error')`, "publish failure notice");
    ok(/Publishing failed, so nothing changed on the website/.test(await notice()) && (await text(".content-head-badge")) === "Approved", "a failed publish says nothing changed; the post stays Approved");
    await shot("content-publish-failed.png");
    sanity.hooks.failDraftSave = false;
    await evalJs(`[...document.querySelectorAll('.content-notice-error button')].find((b) => b.textContent === 'Try again').click()`);
    await waitFor(`document.querySelector('.content-head-badge').textContent.trim() === 'Published'`, "retry publishes");
    ok(/Published to the website/.test(await notice()) && /Live/.test(await text("#contentDetails .content-dest")), "Try again publishes; the website destination shows Live");

    // 9. Schedule: a date the server refuses stays in the dialog; a valid one schedules
    await select(pSchedule);
    await openMenuItem("Schedule…");
    await waitFor(`!!document.querySelector('.dialog-card input[name=scheduled_publish_at]')`, "schedule dialog");
    ok(await evalJs(`!!document.querySelector('.dialog-card input[name=scheduled_publish_at]').min`), "the date picker cannot go into the past");
    const far = new Date(Date.now() + 400 * 86400000);
    const local = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T10:00`;
    await evalJs(`(() => { document.querySelector('.dialog-card input[name=scheduled_publish_at]').value = '${local(far)}'; document.querySelector('.dialog-card').requestSubmit(); })()`);
    await waitFor(`/within one year/.test(document.querySelector('.dialog-error')?.textContent || '')`, "server date refusal in dialog");
    ok((await text(".content-head-badge")) === "Approved", "a refused date keeps the dialog open with the server's reason; nothing changes");
    const soon = new Date(Date.now() + 3 * 86400000);
    await evalJs(`(() => { document.querySelector('.dialog-card input[name=scheduled_publish_at]').value = '${local(soon)}'; document.querySelector('.dialog-card').requestSubmit(); })()`);
    await waitFor(`!document.querySelector('.dialog-card') && document.querySelector('.content-head-badge').textContent.trim() === 'Scheduled'`, "scheduled");
    ok(/Scheduled to publish/.test(await notice()) && /scheduled for/.test(await text(".content-head-sub")), "a valid time schedules the post and says when");

    // 10. Approve a version the reviewer never saw -> refused; Reload shows the current one; then approve
    await asUser("reviewer");
    await open(`content/${pReview}`, `document.querySelector('.content-primary-action')?.textContent === 'Approve'`, "reviewer view");
    await api("writer", "PATCH", `/content/${pReview}`, { body: "Writer changed this while it was in review" });
    await clickPrimary();
    await waitFor(`/changed while you were reviewing/.test(document.querySelector('.content-notices').textContent)`, "stale review notice");
    ok((await text(".content-head-badge")) === "In Review", "approving an outdated on-screen version is refused");
    await evalJs(`[...document.querySelectorAll('.content-notice button')].find((b) => b.textContent === 'Reload current version').click()`);
    await waitFor(`document.querySelector('textarea[name=body]').value === 'Writer changed this while it was in review'`, "reloaded");
    await clickPrimary();
    await waitFor(`document.querySelector('.content-head-badge').textContent.trim() === 'Approved'`, "approved after reload");
    ok(/Approved/.test(await notice()), "after reloading the current version it can be approved");

    // 11. Permissions: staff without content.publish see no publish/schedule; review actions only for in-review posts
    await asUser("writer");
    await open(`content/${pReview}`, `document.querySelector('.content-head-badge')?.textContent.trim() === 'Approved'`, "writer view");
    ok(!(await evalJs(`document.querySelector('.content-primary-action')`)), "a writer without content.publish gets no Publish action on an approved post");
    await evalJs(`document.querySelector('.content-actionbar .portfolio-overflow-trigger').click()`);
    ok(!(await evalJs(`[...document.querySelectorAll('.portfolio-overflow-item')].some((b) => /Schedule|Unpublish|Publish/.test(b.textContent) && b.offsetParent)`)), "nor Schedule or Unpublish in the menu");
    await evalJs(`document.body.click()`);
    await select(pOwnReview);
    ok(!(await evalJs(`document.querySelector('.content-primary-action')`)) && /Another reviewer must approve your post/.test(await text(".content-actionbar")), "the writer (a reviewer too) is not offered Approve on their own post, and is told why");
    await evalJs(`document.querySelector('.content-actionbar .portfolio-overflow-trigger').click()`);
    ok(!(await evalJs(`[...document.querySelectorAll('.portfolio-overflow-item')].some((b) => /Request changes/.test(b.textContent) && b.offsetParent)`)), "nor Request changes on their own post");
    await evalJs(`document.body.click()`);
    await asUser("reviewer");
    await open(`content/${pOwnReview}`, `document.querySelector('.content-primary-action')?.textContent === 'Approve'`, "another reviewer sees Approve");
    ok(true, "another reviewer is offered Approve on it");
    await asUser("super");
    const superOwn = (await api("super", "POST", "/content", { title: "Mu publisher's own post", body: "Mu body" })).data.item.id;
    await api("super", "POST", `/content/${superOwn}/submit-review`, {});
    await open(`content/${superOwn}`, `document.querySelector('.content-head-badge')?.textContent.trim() === 'In Review'`, "publisher's own post");
    ok((await evalJs(`document.querySelector('.content-primary-action')?.textContent`)) === "Approve", "a writer who also holds content.publish keeps Approve on their own post (the server allows it)");
    await asUser("writer");
    await open("content", `!!document.querySelector('.content-page .content-form')`, "writer posts");
    await select(pDraft);
    ok((await evalJs(`document.querySelector('.content-primary-action').textContent`)) === "Submit for review", "a draft's primary action is Submit for review");
    await asUser("super");

    // 12. Overview: real counts, attention, channels, no engagement numbers
    await open("content/overview", `!!document.querySelector('.kpi-grid')`, "overview");
    const kpis = await evalJs(`Object.fromEntries([...document.querySelectorAll('.kpi-card')].map((c) => [c.querySelector('.kpi-label').textContent.trim(), c.querySelector('.kpi-value').textContent.trim()]))`);
    const all = await store.listContentItems();
    const count = (s) => String(all.filter((i) => i.workflow_status === s).length);
    ok(kpis["Drafts"] === count("draft") && kpis["Awaiting Review"] === count("in_review") && kpis["Ready to Publish"] === count("approved") && kpis["Scheduled"] === count("scheduled") && kpis["Live on Website"] === count("published"), `overview KPIs equal the real counts (${JSON.stringify(kpis)})`);
    ok(kpis["Published This Week"] === "2 / 2", "published this week counts only posts with a recorded publish date (the legacy post is not guessed)");
    ok(/Needs re-approval/.test(await text(".content-overview-grid")) && /Awaiting review|Approved, not yet published/.test(await text(".content-overview-grid")), "Needs Attention lists real workflow items");
    ok(await evalJs(`[...document.querySelectorAll('.content-overview-grid .content-dest-disabled')].length === 3 && /Not connected/.test(document.querySelector('[data-panel-kind=engagement]').textContent) && !/\\d/.test(document.querySelector('[data-panel-kind=engagement]').textContent)`), "channels: website connected, three not connected; engagement shows no numbers");
    await shot("content-overview.png");

    // 13. Calendar: real dates only
    await open("content/calendar", `!!document.querySelector('.content-cal-grid')`, "calendar");
    const inMonth = scheduledAt.getMonth() === new Date().getMonth();
    if (!inMonth) { await evalJs(`document.querySelector('[data-cal=next]').click()`); await sleep(100); }
    ok(await evalJs(`[...document.querySelectorAll('.content-cal-grid .content-cal-scheduled')].some((e) => /Gamma scheduled post/.test(e.textContent))`), "the scheduled post is on its scheduled day");
    if (!inMonth) await evalJs(`document.querySelector('[data-cal=today]').click()`);
    ok(/1 published post has no recorded publish date/.test(await text(".content-cal-note")), "posts without a recorded publish date are counted, not placed on a guessed day");
    await shot("content-calendar.png");

    // 14. Table view (the previous list) still available
    await open("content/table", `!!document.querySelector('.crm-table, table, .data-table')`, "table view");
    ok(/Alpha published post/.test(await text("#viewOutlet")), "the table view lists posts");

    // 15. Tablet: details become a slide-over; phone: list first, then the editor with a back button
    await viewport(1000, 800);
    await open(`content/${pPublished}`, `!!document.querySelector('.content-form')`, "tablet");
    ok(await evalJs(`getComputedStyle(document.querySelector('.content-details-pane')).display === 'none' && getComputedStyle(document.querySelector('.content-details-toggle')).display !== 'none'`), "at 1000px the details pane is hidden behind a Details button");
    await evalJs(`document.querySelector('.content-details-toggle').click()`);
    ok(await evalJs(`getComputedStyle(document.querySelector('.content-details-pane')).position === 'absolute'`), "Details opens as a slide-over");
    await shot("content-tablet-details.png");
    const coveredSlideOver = await underOrb();
    ok(coveredSlideOver.length === 0, `tablet: no control in the details slide-over is under the Oyi orb (${JSON.stringify(coveredSlideOver)})`);
    await evalJs(`document.querySelector('.content-details-close').click()`);
    ok(await evalJs(`getComputedStyle(document.querySelector('.content-details-pane')).display === 'none' && document.querySelector('.content-details-toggle').getAttribute('aria-expanded') === 'false'`), "the slide-over has its own Close (it covers the Details button)");
    const coveredTablet = await underOrb();
    ok(coveredTablet.length === 0, `tablet: no action-bar control is under the Oyi orb (${JSON.stringify(coveredTablet)})`);
    await modeCheck("tablet");
    await viewport(390, 844, true);
    await open("content", `!!document.querySelector('.content-list-pane')`, "phone list");
    ok(await evalJs(`getComputedStyle(document.querySelector('.content-main-pane')).display === 'none' && document.querySelector('.content-list-pane').getBoundingClientRect().width >= 350`), "on a phone the list is shown first, full width");
    const coveredPhoneList = await evalJs(`(() => { const orb = document.getElementById('oyiBar'); const o = orb.getBoundingClientRect(); const list = document.querySelector('.content-list').getBoundingClientRect(); return [...document.querySelectorAll('.content-list .content-row, .content-list button')].filter((e) => { const r = e.getBoundingClientRect(); const top = Math.max(r.top, list.top), bottom = Math.min(r.bottom, list.bottom); return bottom > top && r.left < o.right && r.right > o.left && top < o.bottom && bottom > o.top; }).map((e) => e.textContent.trim().slice(0, 30)); })()`);
    ok(coveredPhoneList.length === 0, `phone: no list row or control is under the Oyi orb (${JSON.stringify(coveredPhoneList)})`);
    await shot("content-phone-list.png");
    await evalJs(`document.querySelector('.content-row[data-content-id="${pScheduled}"]').click()`);
    await waitFor(`getComputedStyle(document.querySelector('.content-main-pane')).display !== 'none' && document.querySelector('.content-form [name=title]')?.value === 'Gamma scheduled post'`, "phone editor");
    ok(await evalJs(`getComputedStyle(document.querySelector('.content-list-pane')).display === 'none' && getComputedStyle(document.querySelector('.content-head .rel-back')).display !== 'none'`), "choosing a post opens the editor alone, with a back button");
    ok(await evalJs(`document.documentElement.scrollWidth <= window.innerWidth + 1`), "no horizontal page scroll on a phone");
    const coveredPhone = await underOrb();
    ok(coveredPhone.length === 0, `phone: no action-bar control is under the Oyi orb (${JSON.stringify(coveredPhone)})`);
    await modeCheck("phone");
    await shot("content-phone-editor.png");
    await evalJs(`document.querySelector('.content-head .rel-back').click()`);
    await waitFor(`getComputedStyle(document.querySelector('.content-list-pane')).display !== 'none'`, "back to list");
    ok(true, "Back returns to the list");

    ok(errors.length === 0, `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
  } finally {
    try { ws?.close(); } catch {}
    chrome.kill("SIGKILL");
    await new Promise((resolve) => server.close(resolve));
    setSanityClientFactoryForTests(null);
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  console.log(JSON.stringify({ suite: "content-workspace-browser", checks, failed: 0 }));
}

main().catch((error) => { console.error(error); process.exit(1); });
