// Real-browser acceptance test for the S7.3 Access Policy card (session duration) with S7.2 step-up: headless Chrome over the DevTools protocol against the real Office server (file store, fixtures only).
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
const KEY = "office_session_ttl_hours", SET = `/api/lead-agents/admin/settings/${KEY}`;
const limiter = (max) => new MemoryRateLimiter({ windowMs: 60000, maxRequests: max });

async function main() {
  if (!CHROME) { console.log("SKIP: Chrome not installed"); return; }
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["sp-key"], allowedOrigins: [], sessionSecret: "s7-3-browser-session-secret-0123456789abcdef", sessionSecretEphemeral: false };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword(PW), role: "super_admin", display_name: "Super", status: "active" });
  await store.ensureAdminUser({ email: "other@ochiga.local", password_hash: hashPassword("other super pass phrase 2"), role: "super_admin", display_name: "Other", status: "active" });
  await store.ensureAdminUser({ email: "admin@ochiga.local", password_hash: hashPassword("ochiga admin pass phrase 3"), role: "ochiga_admin", display_name: "Admin", status: "active" });
  await store.ensureAdminUser({ email: "plain@ochiga.local", password_hash: hashPassword("plain staff pass phrase 4"), role: "ochiga_staff", display_name: "Plain", status: "active" });
  const adapter = { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: () => [], isConfigured: () => true, sendTextMessage: async () => ({ delivered: false }) };
  const server = buildServer({ config, store, rateLimiter: limiter(5000), publicRateLimiter: limiter(5000), officeRateLimiter: limiter(5000), loginRateLimiter: limiter(100), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const port = await listen(server), base = `http://127.0.0.1:${port}`;
  const loginCookie = async (email, password) => { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }); assert.equal(r.status, 200); const [nv] = r.headers.get("set-cookie").split(";"); const i = nv.indexOf("="); return { name: nv.slice(0, i), value: decodeURIComponent(nv.slice(i + 1)), raw: nv }; };
  const otherCookie = await loginCookie("other@ochiga.local", "other super pass phrase 2");
  const stepUpToken = async (c, password) => (await (await fetch(`${base}/api/lead-agents/admin/session/step-up`, { method: "POST", headers: { "content-type": "application/json", cookie: c.raw }, body: JSON.stringify({ password, purpose: "security_policy_write" }) })).json()).step_up.token;
  const apiPut = (c, token, value, expected) => fetch(`${base}${SET}`, { method: "PUT", headers: { "content-type": "application/json", cookie: c.raw, "x-step-up-token": token }, body: JSON.stringify({ value, expected_version: expected }) });

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9359", `--user-data-dir=${userDir}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--disable-features=BackForwardCache", "about:blank"], { stdio: "ignore" });
  let ws, id = 0; const pending = new Map(); const errors = [];
  try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch("http://127.0.0.1:9359/json")).json(); } catch { await sleep(200); } }
    assert.ok(targets, "Chrome DevTools is reachable");
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; const t = setTimeout(() => { pending.delete(n); reject(new Error(`CDP call timed out: ${method}`)); }, 30000); pending.set(n, (d) => { clearTimeout(t); resolve(d); }); ws.send(JSON.stringify({ id: n, method, params })); });
    // Page.navigate occasionally never answers in headless Chrome; one retry keeps the suite deterministic without hiding real failures.
    const navigate = async (url) => { try { return await send("Page.navigate", { url }); } catch (e) { if (!/timed out/.test(e.message)) throw e; return send("Page.navigate", { url }); } };
    const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
    const waitFor = async (expr, label, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJs(expr)) return true; } catch { /* navigating */ } await sleep(100); } throw new Error(`Timed out waiting for: ${label}`); };
    const shot = async (name) => { if (!process.env.OFFICE_ST_SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(process.env.OFFICE_ST_SHOTS, name), Buffer.from(r.result.data, "base64")); };
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
    const viewport = (width, height, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    const openPeople = async (cookie) => { await navigate("about:blank"); await send("Network.setCookie", { name: cookie.name, value: cookie.value, url: base }); await navigate(`${base}/office#settings/people`); await waitFor(`!!document.querySelector('#stTtlCurrent, .st-denied, .st-error') && !document.querySelector('#stContent .skeleton-line')`, "People & Access"); };
    const CARD = `[...document.querySelectorAll('.st-card')].find((c) => /Access policy/i.test(c.querySelector('h3, .st-card-title')?.textContent || c.innerText.slice(0, 40)))`;
    const facts = () => evalJs(`({ current: document.querySelector('#stTtlCurrent')?.textContent, source: document.querySelector('#stTtlSource')?.textContent, version: document.querySelector('#stTtlVersion')?.textContent })`);
    const setValue = (v) => evalJs(`(() => { const f = document.querySelector('.st-reg-editor'); f.elements.value.value = ${JSON.stringify(String(v))}; f.elements.value.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const save = () => evalJs(`document.querySelector('.st-reg-editor button[type=submit]').click()`);
    const status = () => evalJs(`document.querySelector('.st-reg-editor .st-form-status')?.textContent || ''`);
    const dialogType = (v) => evalJs(`(() => { const i = document.querySelector('.st-modal input[name=current_password]'); i.value = ${JSON.stringify(v)}; return true; })()`);
    const dialogSubmit = () => evalJs(`document.querySelector('.st-modal [data-act=ok]').click()`);
    const stored = async () => (await (await fetch(`${base}${SET}`, { headers: { cookie: otherCookie.raw } })).json()).setting;

    await viewport(1440, 900);
    const superCookie = await loginCookie("super@ochiga.local", PW);
    await openPeople(superCookie);
    let f = await facts();
    assert.deepEqual(f, { current: "168 hours (7 days)", source: "Default (7 days)", version: "0" });
    assert.ok(await evalJs(`/1.720 hours/.test(document.querySelector('.st-access-facts').innerText.replace(/\u2013|\u2014|–/g, '.'))`), "allowed range is shown");
    assert.ok(await evalJs(`!!document.querySelector('.st-reg-editor input[type=number]')`), "super_admin sees the editor");
    await shot("s7-3-access-policy-1440.png");
    console.log("1. super_admin: Access policy shows 168 hours (7 days), Default source, version 0, 1–720 range and an editor — PASS");

    // cancelled step-up saves nothing
    await setValue(48); await save();
    await waitFor(`!!document.querySelector('.st-modal[role=dialog]')`, "step-up dialog");
    await shot("s7-3-stepup-dialog-1440.png");
    await evalJs(`document.querySelector('.st-modal [data-act=cancel]').click(); true`);
    await waitFor(`/cancelled/i.test(document.querySelector('.st-reg-editor .st-form-status')?.textContent || '')`, "cancel status");
    assert.equal((await stored()).version, 0, "cancelled confirmation stored nothing");
    console.log("2. Save opens the step-up dialog; cancelling saves nothing — PASS");

    // wrong password, then correct
    await save(); await waitFor(`!!document.querySelector('.st-modal[role=dialog]')`, "dialog again");
    await dialogType("wrong-password-attempt-x"); await dialogSubmit();
    await waitFor(`/incorrect/.test(document.querySelector('.st-modal .st-field-error')?.textContent || '')`, "wrong password message");
    assert.equal((await stored()).version, 0, "wrong password stored nothing");
    await dialogType(PW); await dialogSubmit();
    await waitFor(`/Saved\./.test(document.querySelector('.st-reg-editor .st-form-status')?.textContent || '')`, "saved");
    f = await facts(); assert.deepEqual(f, { current: "48 hours (2 days)", source: "Set in Settings", version: "1 · changed by super@ochiga.local" });
    const srv = await stored(); assert.deepEqual([srv.value, srv.version], [48, 1], "server confirms the stored value");
    await shot("s7-3-saved-1440.png");
    console.log("3. Wrong password refused; correct password saves; card shows the server-confirmed 48 hours, version 1, source and author — PASS");

    // grant reused within its lifetime; invalid values explained
    await setValue(72); await save(); await waitFor(`/Saved\./.test(document.querySelector('.st-reg-editor .st-form-status')?.textContent || '')`, "second save");
    assert.equal(await evalJs(`!!document.querySelector('.st-modal')`), false, "a live grant is reused without prompting again");
    assert.equal((await stored()).value, 72);
    for (const [bad, text] of [["0", /between 1 and 720/], ["721", /between 1 and 720/], ["2.5", /whole number/]]) {
      await setValue(bad); await save(); await waitFor(`!!document.querySelector('.st-reg-editor .st-field-error')?.textContent`, `error for ${bad}`);
      assert.match(await evalJs(`document.querySelector('.st-reg-editor .st-field-error').textContent`), text, `message for ${bad}`);
      assert.equal((await stored()).value, 72, `invalid ${bad} stored nothing`);
    }
    await shot("s7-3-validation-1440.png");
    console.log("4. A live grant is reused; 0, 721 and 2.5 are refused with clear messages and store nothing — PASS");

    // conflict: another administrator changes the value first
    const otherTok = await stepUpToken(otherCookie, "other super pass phrase 2");
    assert.equal((await apiPut(otherCookie, otherTok, 100, (await stored()).version)).status, 200);
    await setValue(30); await save();
    await waitFor(`!!document.querySelector('.st-reg-editor .st-conflict:not([hidden])')`, "conflict panel");
    const conflictText = await evalJs(`document.querySelector('.st-reg-editor .st-conflict').innerText`);
    assert.ok(/100/.test(conflictText) && /not applied|Not saved/i.test(conflictText), `conflict explained: ${conflictText}`);
    assert.equal((await stored()).value, 100, "conflicting edit was not applied");
    await shot("s7-3-conflict-1440.png");
    await evalJs(`document.querySelector('.st-reg-editor [data-act=reload]').click(); true`);
    assert.equal(await evalJs(`document.querySelector('.st-reg-editor input').value`), "100", "reload shows the current stored value");
    console.log("5. Version conflict: current value shown, edit not applied, reload loads it — PASS");

    // invalid/expired grant → re-prompt
    await evalJs(`OfficeStepUp.state.grants.security_policy_write.token = OfficeStepUp.state.grants.security_policy_write.token.slice(0, -4) + 'dead'; true`);
    await setValue(60); await save();
    await waitFor(`/expired or is no longer valid/.test(document.querySelector('.st-reg-editor .st-form-status')?.textContent || '')`, "expired grant message");
    assert.equal((await stored()).value, 100, "an invalid grant saved nothing");
    assert.equal(await evalJs(`OfficeStepUp.active('security_policy_write')`), false, "the bad grant was discarded");
    await save(); await waitFor(`!!document.querySelector('.st-modal[role=dialog]')`, "re-prompt");
    await dialogType(PW); await dialogSubmit();
    await waitFor(`/Saved\./.test(document.querySelector('.st-reg-editor .st-form-status')?.textContent || '')`, "saved after re-confirmation");
    assert.equal((await stored()).value, 60);
    console.log("6. Expired/invalid grant: clear message, nothing saved, password asked again, then saved — PASS");

    // other roles
    await openPeople(await loginCookie("admin@ochiga.local", "ochiga admin pass phrase 3"));
    f = await facts(); assert.equal(f.current, "60 hours", "read-only role sees the value");
    assert.equal(await evalJs(`document.querySelectorAll('.st-reg-editor, #stTtlCurrent ~ form').length`), 0, "no editor for ochiga_admin");
    assert.ok(/Read-only for your role/.test(await evalJs(`document.querySelector('#stContent').innerText`)));
    await shot("s7-3-readonly-1440.png");
    await navigate("about:blank"); const plain = await loginCookie("plain@ochiga.local", "plain staff pass phrase 4");
    await send("Network.setCookie", { name: plain.name, value: plain.value, url: base }); await navigate(`${base}/office#settings/people`); await sleep(1500);
    assert.equal(await evalJs(`document.querySelectorAll('.st-reg-editor').length + document.querySelectorAll('#stTtlCurrent').length`), 0, "a role without staff.manage sees no policy controls");
    console.log("7. ochiga_admin sees read-only values; a role without staff.manage sees nothing — PASS");

    // responsive
    await viewport(390, 800, true); await openPeople(superCookie);
    const fit = await evalJs(`(() => { const c = document.querySelector('.st-access-facts').closest('.st-card').getBoundingClientRect(); const ctl = [...document.querySelectorAll('.st-reg-editor input, .st-reg-editor button')]; return { noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1, cardInside: c.right <= window.innerWidth + 1 && c.left >= -1, targets: ctl.every((n) => n.getBoundingClientRect().height >= 40) }; })()`);
    assert.deepEqual(fit, { noOverflow: true, cardInside: true, targets: true });
    await evalJs(`document.querySelector('.st-access-facts').scrollIntoView({ block: 'start' }); true`); await sleep(200); await shot("s7-3-access-policy-390.png");
    await viewport(768, 900); await openPeople(superCookie); assert.ok(await evalJs(`document.documentElement.scrollWidth <= window.innerWidth + 1`), "768px: no overflow");
    console.log("8. Responsive 768/390: no overflow, touch-sized controls — PASS");

    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
    console.log(JSON.stringify({ status: "PASS", suite: "session-policy-browser" }));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill();
    server.closeAllConnections?.(); await new Promise((r) => server.close(r));
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* chrome still flushing its profile */ }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
