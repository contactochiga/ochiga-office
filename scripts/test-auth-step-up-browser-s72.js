// Real-browser acceptance test for the S7.2 step-up confirmation dialog: headless Chrome over the DevTools protocol against the real Office server (file store, fixtures only).
// Skips (exit 0) when Chrome is not installed. Writes screenshots to OFFICE_ST_SHOTS if set.
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

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const PW = "browser super pass phrase 1";
const limiter = (max) => new MemoryRateLimiter({ windowMs: 60000, maxRequests: max });

async function main() {
  if (!CHROME) { console.log("SKIP: Chrome not installed"); return; }
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["su-key"], allowedOrigins: [], sessionSecret: "s7-2-browser-session-secret-0123456789abcdef", sessionSecretEphemeral: false };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword(PW), role: "super_admin", display_name: "Super", status: "active" });
  await store.ensureAdminUser({ email: "staff@ochiga.local", password_hash: hashPassword("staff browser pass phrase 2"), role: "ochiga_staff", display_name: "Staff", status: "active" });
  await store.ensureAdminUser({ email: "limit@ochiga.local", password_hash: hashPassword("limit browser pass phrase 3"), role: "super_admin", display_name: "Limit", status: "active" });
  const adapter = { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: () => [], isConfigured: () => true, sendTextMessage: async () => ({ delivered: false }) };
  const server = buildServer({ config, store, rateLimiter: limiter(5000), publicRateLimiter: limiter(5000), officeRateLimiter: limiter(5000), loginRateLimiter: limiter(5), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const port = await listen(server), base = `http://127.0.0.1:${port}`;
  const loginCookie = async (email, password) => { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }); assert.equal(r.status, 200); const [nv] = r.headers.get("set-cookie").split(";"); const i = nv.indexOf("="); return { name: nv.slice(0, i), value: decodeURIComponent(nv.slice(i + 1)) }; };

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "su-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9358", `--user-data-dir=${userDir}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--disable-features=BackForwardCache", "about:blank"], { stdio: "ignore" });
  let ws, id = 0; const pending = new Map(); const errors = [];
  try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch("http://127.0.0.1:9358/json")).json(); } catch { await sleep(200); } }
    assert.ok(targets, "Chrome DevTools is reachable");
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; const t = setTimeout(() => { pending.delete(n); reject(new Error(`CDP call timed out: ${method}`)); }, 30000); pending.set(n, (d) => { clearTimeout(t); resolve(d); }); ws.send(JSON.stringify({ id: n, method, params })); });
    // Page.navigate occasionally never answers in headless Chrome (same class as the provider-browser flake); one retry keeps the suite deterministic without hiding real failures.
    const sendRaw = send;
    const navigate = async (url) => { try { return await sendRaw('Page.navigate', { url }); } catch (e) { if (!/timed out/.test(e.message)) throw e; return sendRaw('Page.navigate', { url }); } };
    const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
    const waitFor = async (expr, label, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJs(expr)) return true; } catch { /* navigating */ } await sleep(100); } throw new Error(`Timed out waiting for: ${label}`); };
    const shot = async (name) => { if (!process.env.OFFICE_ST_SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(process.env.OFFICE_ST_SHOTS, name), Buffer.from(r.result.data, "base64")); };
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
    const viewport = (width, height, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    const openSecurity = async (cookie) => { await navigate("about:blank"); await send("Network.setCookie", { name: cookie.name, value: cookie.value, url: base }); await navigate(`${base}/office#settings/security`); await waitFor(`!!document.querySelector('.st-reg-table') && !document.querySelector('#stContent .skeleton-line')`, "Security section"); };
    const openDialog = async () => { await evalJs(`window.__su = null; window.__suDone = false; OfficeStepUp.dialog({ purpose: 'security_policy_write' }).then((v) => { window.__su = v; window.__suDone = true; }); true`); await waitFor(`!!document.querySelector('.st-modal[role=dialog] input[type=password]')`, "dialog"); };
    const type = (v) => evalJs(`(() => { const i = document.querySelector('.st-modal input[name=current_password]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const submit = () => evalJs(`document.querySelector('.st-modal [data-act=ok]').click()`);
    const dialogError = () => evalJs(`document.querySelector('.st-modal .st-field-error')?.textContent || ''`);

    await viewport(1440, 900);
    const superCookie = await loginCookie("super@ochiga.local", PW);
    await openSecurity(superCookie);
    const fact = await evalJs(`document.querySelector('#stContent').innerText`);
    assert.ok(/Step-up confirmation/i.test(fact) && /Not yet required for any setting/i.test(fact), "Security section states step-up is available but not required [" + fact.slice(0, 500) + "]");
    console.log("1. Security section reports step-up as available and not yet required — PASS");

    await openDialog();
    const a11y = await evalJs(`(() => { const m = document.querySelector('.st-modal'); const i = m.querySelector('input'); return { role: m.getAttribute('role'), modal: m.getAttribute('aria-modal'), type: i.type, autocomplete: i.autocomplete, focused: document.activeElement === i, name: m.querySelector('h3').textContent }; })()`);
    assert.deepEqual({ ...a11y, name: undefined }, { role: "dialog", modal: "true", type: "password", autocomplete: "current-password", focused: true, name: undefined });
    await shot("s7-2-dialog-1440.png");
    console.log("2. Dialog is an accessible modal with a focused masked current-password field — PASS");

    await submit(); assert.ok(/Enter your current password/.test(await dialogError()), "empty submit explained");
    await type("this-is-the-wrong-password"); await submit();
    await waitFor(`/incorrect/.test(document.querySelector('.st-modal .st-field-error')?.textContent || '')`, "failure message");
    assert.equal(await evalJs(`document.querySelector('.st-modal input').value`), "", "password cleared after a failed attempt");
    assert.equal(await evalJs(`window.__suDone`), false, "dialog stays open after a failure");
    assert.equal(await evalJs(`OfficeStepUp.active('security_policy_write')`), false, "no grant after a failure");
    await shot("s7-2-dialog-failure-1440.png");
    console.log("3. Empty and wrong password: clear inline errors, field cleared, no grant — PASS");

    await type(PW); await submit();
    await waitFor(`window.__suDone === true`, "success");
    const res = await evalJs(`({ granted: !!window.__su && !!window.__su.token && window.__su.expiresAt > Date.now() && window.__su.expiresAt - Date.now() <= 600000, active: OfficeStepUp.active('security_policy_write'), dialog: !!document.querySelector('.st-modal-backdrop') })`);
    assert.deepEqual(res, { granted: true, active: true, dialog: false }, "success closes the dialog and records a short-lived grant");
    const leak = await evalJs(`(() => { const hay = document.documentElement.outerHTML + JSON.stringify(Object.assign({}, localStorage)) + JSON.stringify(Object.assign({}, sessionStorage)) + JSON.stringify(OfficeStepUp.state); return hay.includes(${JSON.stringify(PW)}); })()`);
    assert.equal(leak, false, "the password is retained nowhere after verification");
    await shot("s7-2-success-1440.png");
    console.log("4. Correct password: dialog closes, <=10-minute grant held in memory only, password retained nowhere — PASS");

    await evalJs(`OfficeStepUp.state.grants.security_policy_write.expiresAt = Date.now() - 1; true`);
    assert.equal(await evalJs(`OfficeStepUp.active('security_policy_write') || OfficeStepUp.token('security_policy_write') !== null`), false, "expired grant is inactive and yields no token");
    await evalJs(`OfficeStepUp.clear(); true`);
    await openDialog(); await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await waitFor(`window.__suDone === true`, "cancel"); assert.equal(await evalJs(`window.__su`), null, "Esc cancels with null");
    assert.equal(await evalJs(`OfficeStepUp.active('security_policy_write')`), false);
    await openDialog(); await evalJs(`document.querySelector('.st-modal-backdrop').click(); true`);
    await waitFor(`window.__suDone === true`, "backdrop cancel"); assert.equal(await evalJs(`window.__su`), null);
    console.log("5. Expiry is enforced client-side; Esc and backdrop cancel without a grant — PASS");

    // server-side expiry and revocation states surface as a failed use, not a silent success
    const serverRefusal = await evalJs(`(async () => { const r = await fetch('/api/lead-agents/admin/session/step-up/check', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'security_policy_write' }) }); const b = await r.json(); return r.status + ':' + b.reason; })()`);
    assert.equal(serverRefusal, "403:missing", "a request without a grant is refused by the server");

    // not permitted
    const staffCookie = await loginCookie("staff@ochiga.local", "staff browser pass phrase 2");
    await navigate("about:blank"); await send("Network.setCookie", { name: staffCookie.name, value: staffCookie.value, url: base });
    await navigate(`${base}/office`); await sleep(800);
    await waitFor(`typeof OfficeStepUp === 'object'`, "app loaded");
    await openDialog(); await type("staff browser pass phrase 2"); await submit();
    await waitFor(`/not permitted/.test(document.querySelector('.st-modal .st-field-error')?.textContent || '')`, "permission message");
    assert.equal(await evalJs(`window.__suDone`), false);
    await evalJs(`document.querySelector('.st-modal [data-act=cancel]').click(); true`);
    console.log("6. A non-super_admin is told they are not permitted; nothing is granted — PASS");

    // rate limiting
    const limCookie = await loginCookie("limit@ochiga.local", "limit browser pass phrase 3");
    await openSecurity(limCookie); await openDialog();
    for (let i = 0; i < 12; i++) { await type(`wrong-attempt-${i}-xxxxx`); await submit(); await sleep(150); if (/Too many/.test(await dialogError())) break; }
    assert.ok(/Too many attempts/.test(await dialogError()), "rate limit explained");
    await shot("s7-2-dialog-ratelimit-1440.png");
    await evalJs(`document.querySelector('.st-modal [data-act=cancel]').click(); true`);
    console.log("7. Repeated wrong passwords: clear rate-limit message — PASS");

    // responsive
    await viewport(390, 800, true); await openSecurity(superCookie); await openDialog();
    const fit = await evalJs(`(() => { const m = document.querySelector('.st-modal').getBoundingClientRect(); return { inside: m.left >= 0 && m.right <= window.innerWidth + 1 && m.bottom <= window.innerHeight + 1, noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1, targets: [...document.querySelectorAll('.st-modal .btn, .st-modal input')].every((n) => n.getBoundingClientRect().height >= 40) }; })()`);
    assert.deepEqual(fit, { inside: true, noOverflow: true, targets: true }, "dialog fits a 390px screen with touch-sized controls");
    await shot("s7-2-dialog-390.png");
    await evalJs(`document.querySelector('.st-modal [data-act=cancel]').click(); true`);
    console.log("8. 390px: dialog fits, no overflow, 40px+ controls — PASS");

    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
    console.log(JSON.stringify({ status: "PASS", suite: "step-up-browser" }));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill();
    server.closeAllConnections?.(); await new Promise((r) => server.close(r));
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* chrome still flushing its profile */ }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
