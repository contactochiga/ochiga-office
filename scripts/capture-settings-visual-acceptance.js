// Evidence tool (not runtime code): runs the real Office server with fixture data, drives headless Chrome, captures labelled screenshots and
// records objective accessibility / permission / function checks to docs/settings-domain/visual-acceptance/results.json.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
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

const OUT = path.join(__dirname, "..", "docs", "settings-domain", "visual-acceptance");
const SHOTS = path.join(OUT, "shots");
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (s) => new Promise((res, rej) => { s.once("error", rej); s.listen(0, "127.0.0.1", () => res(s.address().port)); });
const limiter = (n) => new MemoryRateLimiter({ windowMs: 60000, maxRequests: n });
const WIDTHS = [1440, 1100, 900, 768, 390];
const SECTIONS = [["overview", "settings"], ["intelligence", "settings/intelligence"], ["integrations", "settings/integrations"], ["communications", "settings/communications"], ["organization", "settings/organization"], ["security", "settings/security"]];
const ALL = ["overview", "organization", "people", "intelligence", "integrations", "communications", "automation", "buildings", "crm", "finance", "security", "infrastructure", "audit", "system-health"];
const PERM = { overview: "settings.manage", organization: "settings.manage", people: "staff.manage", intelligence: "audit.read", integrations: "integrations.read", communications: "integrations.read", automation: "tasks.read", buildings: "estates.read", crm: "crm.read", finance: "financial.read", security: "settings.manage", infrastructure: "settings.manage", audit: "audit.read", "system-health": "settings.manage" };

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const sent = [];
  const backendStub = http.createServer((req, res) => { sent.push(`${req.method} ${req.url}`); res.setHeader("content-type", "application/json"); res.end("{\"ok\":true}"); });
  const bp = await listen(backendStub);
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["k"], allowedOrigins: [], officeBackendApiKey: "visual-bridge-key", officeBackendBaseUrl: `http://127.0.0.1:${bp}` };
  const { store } = await createTempStore();
  const mk = (email, role, extra = {}) => store.ensureAdminUser({ email, password_hash: hashPassword("test-pass-12345"), role, display_name: email.split("@")[0], status: "active", ...extra });
  await mk("super@ochiga.test", "super_admin"); await mk("admin@ochiga.test", "ochiga_admin"); await mk("limited@ochiga.test", "ochiga_staff", { permission_scopes: ["settings.manage"] }); await mk("plain@ochiga.test", "ochiga_staff");
  const adapter = { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: () => [], isConfigured: () => true, sendTextMessage: async () => { sent.push("WHATSAPP SEND"); return { delivered: true }; }, sendTemplateMessage: async () => ({ delivered: false }), listApprovedTemplates: async () => [] };
  const server = buildServer({ config, store, rateLimiter: limiter(5000), publicRateLimiter: limiter(5000), officeRateLimiter: limiter(5000), loginRateLimiter: limiter(200), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const port = await listen(server), base = `http://127.0.0.1:${port}`;
  const login = async (email) => { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "test-pass-12345" }) }); assert.equal(r.status, 200); const [n, v] = r.headers.get("set-cookie").split(";")[0].split("="); const me = await (await fetch(`${base}/api/lead-agents/admin/session/me`, { headers: { cookie: `${n}=${v}` } })).json(); return { name: n, value: v, permissions: me.admin.permissions }; };
  const users = { super: await login("super@ochiga.test"), admin: await login("admin@ochiga.test"), limited: await login("limited@ochiga.test"), plain: await login("plain@ochiga.test") };
  const call = (u, p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { "content-type": "application/json", cookie: `${users[u].name}=${users[u].value}`, ...(init.headers || {}) } });
  // genuine audit records for the Recent Activity panel: real autonomy writes + a real letterhead change
  await call("super", "/api/lead-agents/admin/settings/whatsapp-autonomy", { method: "PUT", body: JSON.stringify({ enabled: false }) });
  await call("super", "/api/lead-agents/admin/letterhead-config", { method: "PATCH", body: JSON.stringify({ tagline: "Visual acceptance fixture", email: "office@ochiga.test" }) });

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "stv-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9353", `--user-data-dir=${userDir}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--disable-features=BackForwardCache", "about:blank"], { stdio: "ignore" });
  let ws, id = 0; const pending = new Map(); const results = { captured: [], permission_matrix: {}, accessibility: {}, function: {}, overflow: {}, console_errors: [] };
  try {
    let targets; for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch("http://127.0.0.1:9353/json")).json(); } catch { await sleep(200); } }
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
    const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
    const waitFor = async (expr, label, ms = 9000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await ev(expr)) return; } catch { /* navigating */ } await sleep(120); } throw new Error(`timeout: ${label}`); };
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
    ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.method === "Runtime.exceptionThrown") results.console_errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); });
    const as = async (u) => { await send("Page.navigate", { url: "about:blank" }); await send("Network.setCookie", { name: users[u].name, value: users[u].value, url: base }); };
    const viewport = (w, h = 900) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w <= 480 });
    const go = async (hash, ready) => { const same = await ev(`location.hash === '#/${hash}'`).catch(() => false); await ev(`document.querySelector('.st-page')?.setAttribute('data-stale','1')`).catch(() => null); await send(same ? "Page.reload" : "Page.navigate", same ? {} : { url: `${base}/office#/${hash}` }); await waitFor(`!document.querySelector('.st-page[data-stale]') && (${ready || `!!document.querySelector('.st-page') && !document.querySelector('#stContent .skeleton-line')`})`, hash); await sleep(250); };
    const snap = async (name, label, fullPage = true) => {
      let params = { format: "png" };
      if (fullPage) { const h = await ev(`Math.max(document.querySelector('.view-outlet')?.scrollHeight || 0, document.documentElement.scrollHeight)`); const w = await ev(`window.innerWidth`); const tm = await send("Page.getLayoutMetrics"); void tm; await send("Emulation.setDeviceMetricsOverride", { width: w, height: Math.min(Math.max(h + 70, 600), 2400), deviceScaleFactor: 1, mobile: w <= 480 }); await sleep(250); }
      const r = await send("Page.captureScreenshot", params); fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, "base64")); results.captured.push({ file: `shots/${name}.png`, label });
    };

    // ---- gallery: 7 views x 5 widths (super admin) ----
    await as("super");
    for (const w of WIDTHS) {
      for (const [key, hash] of SECTIONS) {
        await viewport(w); await go(hash);
        results.overflow[`${key}@${w}`] = await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
        await snap(`${key}-${w}`, `${key} — ${w}px`);
      }
      // mobile/tablet landing list
      if (w <= 900) { await viewport(w); await go("settings"); await snap(`landing-${w}`, `Settings landing (list) — ${w}px`); }
    }
    // permission-denied states
    await as("limited");
    for (const w of [1440, 390]) { await viewport(w); await go("settings/people", `!!document.querySelector('.st-denied')`); await snap(`denied-section-${w}`, `Denied deep link (settings/people, user lacks staff.manage) — ${w}px`); }
    await viewport(1440); await go("settings"); await snap("limited-overview-1440", "Limited user (settings.manage only): sidebar shows only permitted domains — 1440px");
    await as("plain"); await viewport(1440); await send("Page.navigate", { url: `${base}/office#/settings` }); await waitFor(`!!document.querySelector('.state-panel.error')`, "forbidden"); await sleep(250); await snap("denied-page-1440", "No settings.manage: Settings forbidden view — 1440px", false);
    await viewport(390); await send("Page.reload"); await waitFor(`!!document.querySelector('.state-panel.error')`, "forbidden mobile"); await sleep(250); await snap("denied-page-390", "No settings.manage: Settings forbidden view — 390px", false);

    // ---- permission gating matrix: each user's DOM sidebar vs the permission the section requires ----
    for (const u of ["super", "admin", "limited"]) {
      await as(u); await viewport(1440); await go("settings");
      const shown = await ev(`[...document.querySelectorAll('.st-nav-item')].map(a => a.getAttribute('href').replace('#/settings/',''))`);
      const expected = ALL.filter((k) => users[u].permissions.includes(PERM[k]));
      results.permission_matrix[u] = { shown, expected, match: JSON.stringify(shown) === JSON.stringify(expected) };
      // direct deep link to every hidden section must be denied (no data)
      const denied = [];
      for (const k of ALL.filter((x) => !expected.includes(x))) { await go(`settings/${k}`, `!!document.querySelector('.st-denied')`); denied.push(k); }
      results.permission_matrix[u].denied_deep_links_checked = denied;
    }

    // ---- accessibility (objective DOM checks, desktop + mobile) ----
    await as("super");
    for (const w of [1440, 390]) {
      await viewport(w); await go("settings/organization", `!!document.querySelector('.st-form')`);
      results.accessibility[w] = await ev(`(() => {
        const q = (s) => [...document.querySelectorAll(s)];
        const lum = (rgb) => { const [r,g,b] = rgb.match(/\\d+(\\.\\d+)?/g).slice(0,3).map(Number).map(v => { v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }); return 0.2126*r + 0.7152*g + 0.0722*b; };
        const bgOf = (el) => { let e = el; while (e) { const c = getComputedStyle(e).backgroundColor; const m = c && c.match(/rgba?\\(([^)]+)\\)/); const a = m ? (m[1].split(',')[3] === undefined ? 1 : Number(m[1].split(',')[3])) : 0; if (c && a >= 0.5) return c; e = e.parentElement; } return 'rgb(5,5,5)'; };
        const ratio = (el) => { const f = lum(getComputedStyle(el).color), b = lum(bgOf(el)); const [hi, lo] = f > b ? [f, b] : [b, f]; return (hi + 0.05) / (lo + 0.05); };
        const sample = (sel) => { const el = document.querySelector(sel); return el ? Math.round(ratio(el) * 100) / 100 : null; };
        const inputs = q('.st-page input');
        const focusables = q('.st-page a[href], .st-page button, .st-page input');
        const small = focusables.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 24 || r.width < 24); }).map(e => e.textContent.trim().slice(0, 30) || e.name);
        const focusOutline = null;
        return {
          landmarks: { nav_labelled: !!document.querySelector('nav[aria-label="Settings sections"]'), main: !!document.querySelector('main#stMain'), h1: q('.st-page h1').length, h2: q('#stContent h2').length },
          active_nav_aria_current: q('.st-nav-item[aria-current="page"]').length,
          inputs_without_label: inputs.filter(i => !(i.closest('label') || i.getAttribute('aria-label'))).length,
          buttons_without_name: q('.st-page button').filter(b => !(b.textContent.trim() || b.getAttribute('aria-label'))).length,
          images_without_alt: q('.st-page img').filter(i => !i.hasAttribute('alt')).length,
          status_live_regions: q('.st-page [aria-live]').length,
          focus_outline_on_nav_item: focusOutline,
          targets_under_24px: small,
          contrast: { title: sample('.st-title h2'), nav_label: sample('.st-nav-item:not(.active) .st-nav-label'), nav_sub: sample('.st-nav-item:not(.active) .st-nav-sub'), card_subtitle: sample('.st-card-head p'), field_label: sample('.st-field span'), note: sample('.st-note'), nav_tag: sample('.st-nav-item:not(.active) .st-nav-tag') },
          reduced_motion_rule_present: [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => r.conditionText && /prefers-reduced-motion/.test(r.conditionText) && /st-tile/.test(r.cssText)); } catch { return false; } }),
        };
      })()`);
    }
    // real keyboard focus: Tab from the search box into the sidebar and read the computed focus ring
    await viewport(1440); await go("settings"); await ev(`document.querySelector('#stSearch').focus()`);
    const key = (type, k) => send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: 9 });
    await key("keyDown", "Tab"); await key("keyUp", "Tab");
    results.accessibility.keyboard_focus = await ev(`(() => { const e = document.activeElement; const c = getComputedStyle(e); return { element: e.className, text: (e.textContent || '').trim().slice(0, 30), outline_style: c.outlineStyle, outline_width: c.outlineWidth, outline_color: c.outlineColor, matches_focus_visible: e.matches(':focus-visible') }; })()`);
    await snap("keyboard-focus-1440", "Keyboard focus ring on first sidebar item (real Tab key) — 1440px", false);
    // keyboard-only: Tab order moves through the sidebar items in DOM order
    results.accessibility.tab_order = await ev(`(() => { const items = [...document.querySelectorAll('.st-nav-item')]; return items.length === 14 && items.every(i => i.tabIndex === 0); })()`);

    // ---- correction-slice checks (G1-G8) ----
    results.corrections = { tablet_tabs: {}, touch_targets_390: {}, orb_overlap: {} };
    await as("super");
    for (const w of [1100, 900]) {
      await viewport(w); await go("settings");
      results.corrections.tablet_tabs[w] = await ev(`(() => { const labels = [...document.querySelectorAll('.st-nav-label')]; const l = document.querySelector('#stNavList'); const side = document.querySelector('.st-side'); return { sections: labels.length, max_label_height: Math.max(...labels.map(x => Math.round(x.getBoundingClientRect().height))), more_right: side.dataset.moreRight, scroll_button_visible: getComputedStyle(document.querySelector('.st-scroll-r')).display !== 'none', scrollable: l.scrollWidth > l.clientWidth }; })()`);
      await ev(`document.querySelector('.st-scroll-r').click()`); await sleep(500);
      await snap(`tabs-scrolled-${w}`, `Tablet tab strip after scrolling right (left affordance visible) — ${w}px`, false);
    }
    await viewport(390);
    for (const [name, hash] of [["landing", "settings"], ["organization", "settings/organization"], ["communications", "settings/communications"], ["integrations", "settings/integrations"]]) {
      await go(hash);
      results.corrections.touch_targets_390[name] = await ev(`[...document.querySelectorAll('.st-page a[href], .st-page button, .st-page input, .st-page [role=button]')].filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !e.closest('p, small, dd, li.st-nav-empty') && r.height < 44; }).map(e => ({ tag: e.tagName.toLowerCase(), text: (e.textContent || e.name || '').trim().slice(0, 28), h: Math.round(e.getBoundingClientRect().height) }))`);
    }
    for (const w of WIDTHS) {
      await viewport(w); await go("settings");
      results.corrections.orb_overlap[w] = await ev(`(() => { const orb = document.querySelector('.oyi-orb'); if (!orb) return { present: false }; const o = orb.getBoundingClientRect(); const hits = [...document.querySelectorAll('.st-card, .st-tile, .st-action, .st-nav-item, .st-activity li')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.height && !(r.right < o.left || r.left > o.right || r.bottom < o.top || r.top > o.bottom); }).map(e => e.className.split(' ')[0]); return { present: true, fixed: getComputedStyle(orb.closest('.oyi-control') || orb).position, draggable_control: !!document.querySelector('.oyi-control'), overlaps: [...new Set(hits)] }; })()`);
    }
    await viewport(1440); await go("settings");
    const act = await ev(`document.querySelector('.st-activity')?.innerText || ''`);
    results.corrections.activity = { rows: (act.match(/\n/g) || []).length, has_login: /log\s?in|log\s?out/i.test(act), has_uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(act), text: act.replace(/\n+/g, " | ").slice(0, 400) };
    await go("settings/integrations");
    results.corrections.twin_card = await ev(`[...document.querySelectorAll('.st-provider')].find(c => /Digital Twin/.test(c.textContent))?.innerText.replace(/\\n+/g, ' | ')`);
    results.corrections.backend_card = await ev(`[...document.querySelectorAll('.st-provider')].find(c => /Backend Control Plane/.test(c.textContent))?.innerText.replace(/\\n+/g, ' | ')`);
    await go("settings");
    results.corrections.tiles_icon_beside_label = await ev(`[...document.querySelectorAll('.st-tile')].every(t => { const i = t.querySelector('.st-tile-ico').getBoundingClientRect(), n = t.querySelector('.st-tile-name').getBoundingClientRect(); return Math.abs((i.top + i.height / 2) - (n.top + n.height / 2)) < 6 && n.left > i.right - 1; })`);
    results.corrections.selected_nav = await ev(`(() => { const c = getComputedStyle(document.querySelector('.st-nav-item.active')); return { background: c.backgroundImage.slice(0, 80), rule: c.boxShadow.slice(0, 40) }; })()`);
    await as("limited"); await viewport(1440); await go("settings/people", `!!document.querySelector('.st-denied-panel')`);
    results.corrections.denied = await ev(`({ heading: document.querySelector('.st-denied-panel h2').textContent, focused: document.activeElement.id, back_href: document.querySelector('.st-denied-back').getAttribute('href'), back_height: Math.round(document.querySelector('.st-denied-back').getBoundingClientRect().height) })`);
    await snap("denied-section-1440", "Denied deep link (settings/people, user lacks staff.manage) — 1440px", false);
    await viewport(390); await go("settings/people", `!!document.querySelector('.st-denied-panel')`); await snap("denied-section-390", "Denied deep link — 390px", false);

    await as("super");
    // ---- function: autonomy toggle + letterhead, via the real UI against the real server ----
    await viewport(1440); await go("settings/communications", `!!document.querySelector('#waAutonomyToggle')`);
    const before = (await (await call("super", "/api/lead-agents/admin/settings/whatsapp-autonomy")).json()).whatsapp_autonomy.enabled;
    await ev(`window.confirm = () => true; document.querySelector('#waAutonomyToggle').click()`);
    await waitFor(`/ON/.test(document.querySelector('#waAutonomyBanner')?.textContent || '') && document.querySelector('#waAutonomyToggle')?.textContent === 'Turn OFF'`, "autonomy ON");
    const on = (await (await call("super", "/api/lead-agents/admin/settings/whatsapp-autonomy")).json()).whatsapp_autonomy.enabled;
    await snap("communications-autonomy-on-1440", "Communications with autonomy ON (test data only; restored immediately) — 1440px");
    await ev(`document.querySelector('#waAutonomyToggle').click()`);
    await waitFor(`/OFF/.test(document.querySelector('#waAutonomyBanner')?.textContent || '') && document.querySelector('#waAutonomyToggle')?.textContent === 'Turn ON'`, "autonomy OFF");
    const off = (await (await call("super", "/api/lead-agents/admin/settings/whatsapp-autonomy")).json()).whatsapp_autonomy.enabled;
    results.function.autonomy = { before, after_on: on, after_off: off, ok: before === false && on === true && off === false };
    await go("settings/organization", `!!document.querySelector('.st-form input[name=tagline]')`);
    await ev(`(() => { const f = document.querySelector('.st-form'); f.elements.tagline.value = 'Acceptance tagline'; f.elements.tagline.dispatchEvent(new Event('input', {bubbles:true})); f.requestSubmit(); })()`);
    await waitFor(`document.querySelector('.st-form-status').textContent === 'Saved.'`, "letterhead saved");
    const lh = (await (await call("super", "/api/lead-agents/admin/letterhead-config")).json()).config;
    results.function.letterhead = { saved_tagline: lh.tagline, ok: lh.tagline === "Acceptance tagline" };
    results.function.customer_messages_sent = sent.filter((s) => s === "WHATSAPP SEND").length;
    results.function.backend_non_get_requests = sent.filter((s) => !s.startsWith("GET ") && s !== "WHATSAPP SEND").length;
    results.console_errors = [...new Set(results.console_errors)];
    fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ captured: results.captured.length, permission_matrix: Object.fromEntries(Object.entries(results.permission_matrix).map(([k, v]) => [k, v.match])), function: results.function, console_errors: results.console_errors.length, overflow_failures: Object.entries(results.overflow).filter(([, v]) => !v).map(([k]) => k) }, null, 1));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill(); for (const s of [server, backendStub]) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* flushing */ }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
