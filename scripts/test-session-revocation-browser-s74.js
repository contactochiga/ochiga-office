// Real-browser acceptance test for the S7.4 session revocation controls (sign out everywhere, super_admin user revocation with S7.2 step-up): headless Chrome over the DevTools protocol against the real Office server (file store, fixtures only).
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
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["rv-key"], allowedOrigins: [], sessionSecret: "s7-4-browser-session-secret-0123456789abcdef", sessionSecretEphemeral: false };
  const { store } = await createTempStore();
  const mk = (email, pw, role, name) => store.ensureAdminUser({ email, password_hash: hashPassword(pw), role, display_name: name, status: "active" });
  const PWS = "browser super pass phrase 1", PWT = "target person pass phrase 2", PWA = "ochiga admin pass phrase 3", PWT2 = "second target pass phrase 4";
  const sup = await mk("super@ochiga.local", PWS, "super_admin", "Super");
  await mk("target@ochiga.local", PWT, "ochiga_staff", "Target Person"); await mk("target2@ochiga.local", PWT2, "ochiga_staff", "Second Target"); await mk("admin@ochiga.local", PWA, "ochiga_admin", "Plain Admin");
  const adapter = { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: () => [], isConfigured: () => true, sendTextMessage: async () => ({ delivered: false }) };
  const server = buildServer({ config, store, rateLimiter: limiter(5000), publicRateLimiter: limiter(5000), officeRateLimiter: limiter(5000), loginRateLimiter: limiter(500), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const port = await listen(server), base = `http://127.0.0.1:${port}`;
  const loginCookie = async (email, password) => { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }); assert.equal(r.status, 200); const [nv] = r.headers.get("set-cookie").split(";"); const i = nv.indexOf("="); return { name: nv.slice(0, i), value: decodeURIComponent(nv.slice(i + 1)), raw: nv }; };
  const meStatus = async (c) => (await fetch(`${base}/api/lead-agents/admin/session/me`, { headers: { cookie: c.raw } })).status;
  const gen = async (email) => (await store.getAdminUserByEmail(email)).session_generation || 0;

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9360", `--user-data-dir=${userDir}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--disable-features=BackForwardCache", "about:blank"], { stdio: "ignore" });
  let ws, id = 0; const pending = new Map(); const errors = [];
  try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch("http://127.0.0.1:9360/json")).json(); } catch { await sleep(200); } }
    assert.ok(targets, "Chrome DevTools is reachable");
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; const t = setTimeout(() => { pending.delete(n); reject(new Error(`CDP call timed out: ${method}`)); }, 30000); pending.set(n, (d) => { clearTimeout(t); resolve(d); }); ws.send(JSON.stringify({ id: n, method, params })); });
    const navigate = async (url) => { try { return await send("Page.navigate", { url }); } catch (e) { if (!/timed out/.test(e.message)) throw e; return send("Page.navigate", { url }); } };
    const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
    const waitFor = async (expr, label, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJs(expr)) return true; } catch { /* navigating */ } await sleep(100); } throw new Error(`Timed out waiting for: ${label}`); };
    const shot = async (name) => { if (!process.env.OFFICE_ST_SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(process.env.OFFICE_ST_SHOTS, name), Buffer.from(r.result.data, "base64")); };
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
    const viewport = (width, height, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    const openPeople = async (cookie) => { await navigate("about:blank"); await send("Network.setCookie", { name: cookie.name, value: cookie.value, url: base }); await navigate(`${base}/office#settings/people`); await waitFor(`!!document.querySelector('#stSignOutEverywhere, #stRevokeUnavailable') && !document.querySelector('#stContent .skeleton-line')`, "People & Access"); };
    const clickConfirm = () => evalJs(`document.querySelector('div.st-modal [data-act=ok]').click()`);
    const confirmOpen = () => waitFor(`!!document.querySelector('div.st-modal[role=dialog] [data-act=ok]')`, "confirm dialog");
    const stepUpOpen = () => waitFor(`!!document.querySelector('form.st-modal input[name=current_password]')`, "step-up dialog");
    const stepUpType = (v) => evalJs(`(() => { document.querySelector('form.st-modal input[name=current_password]').value = ${JSON.stringify(v)}; return true; })()`);
    const stepUpSubmit = () => evalJs(`document.querySelector('form.st-modal [data-act=ok]').click()`);
    const pickUser = (email) => evalJs(`(() => { const f = document.querySelector('.st-revoke-user'); const o = [...f.elements.user.options].find((x) => x.textContent.includes(${JSON.stringify(email)})); f.elements.user.value = o.value; f.elements.user.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const userStatus = () => evalJs(`document.querySelector('.st-revoke-user .st-form-status')?.textContent || ''`);

    await viewport(1440, 900);
    let superCookie = await loginCookie("super@ochiga.local", PWS);
    await openPeople(superCookie);
    assert.ok(await evalJs(`!!document.querySelector('#stSignOutEverywhere') && !!document.querySelector('.st-revoke-user')`), "both cards for a super_admin");
    const options = await evalJs(`[...document.querySelector('.st-revoke-user select').options].map((o) => o.textContent).join('|')`);
    assert.ok(/Target Person/.test(options) && /Second Target/.test(options) && !/Super/.test(options), `the list offers other active users, never yourself: ${options}`);
    assert.equal(await evalJs(`document.querySelector('.st-revoke-user button[type=submit]').disabled`), true, "no action until a user is chosen");
    await shot("s7-4-people-1440.png");
    console.log("1. super_admin sees Your sessions and Sign a user out; the list excludes themself; action disabled until a user is chosen — PASS");

    // admin revokes a user: confirm -> step-up (wrong, then right) -> server-confirmed
    const targetCookie = await loginCookie("target@ochiga.local", PWT); assert.equal(await meStatus(targetCookie), 200);
    const target2Cookie = await loginCookie("target2@ochiga.local", PWT2);
    await pickUser("target@ochiga.local"); await evalJs(`document.querySelector('.st-revoke-user input[name=reason]').value = 'lost laptop'; true`);
    await evalJs(`document.querySelector('.st-revoke-user button[type=submit]').click()`);
    await confirmOpen(); await shot("s7-4-confirm-user-1440.png"); await evalJs(`document.querySelector('div.st-modal [data-act=cancel]').click()`);
    await waitFor(`/Cancelled/.test(document.querySelector('.st-revoke-user .st-form-status')?.textContent || '')`, "cancel status");
    assert.equal(await meStatus(targetCookie), 200, "cancelling the confirmation changed nothing");
    await evalJs(`document.querySelector('.st-revoke-user button[type=submit]').click()`); await confirmOpen(); await clickConfirm(); await stepUpOpen();
    await stepUpType("not-my-password-xxxxx"); await stepUpSubmit(); await waitFor(`/incorrect/.test(document.querySelector('form.st-modal .st-field-error')?.textContent || '')`, "wrong password");
    assert.equal(await meStatus(targetCookie), 200, "a wrong password revoked nothing");
    await stepUpType(PWS); await stepUpSubmit();
    await waitFor(`/Done\./.test(document.querySelector('.st-revoke-user .st-form-status')?.textContent || '')`, "server-confirmed result");
    const done = await userStatus(); assert.ok(/Target Person/.test(done) && /generation 1/.test(done) && /every server running this version/.test(done), `confirmed result: ${done}`);
    assert.equal(await meStatus(targetCookie), 401, "the target's session is dead"); assert.equal(await meStatus(target2Cookie), 200, "other users are untouched"); assert.equal(await gen("target@ochiga.local"), 1);
    await evalJs(`document.querySelector('.st-revoke-user').scrollIntoView({ block: 'center' }); true`); await sleep(200); await shot("s7-4-user-revoked-1440.png");
    console.log("2. Confirm -> step-up (wrong password refused, right one accepted) -> server-confirmed result; only that user is signed out — PASS");

    // grant reused within its lifetime: a second revoke still asks for confirmation but not the password
    await pickUser("target2@ochiga.local"); await evalJs(`document.querySelector('.st-revoke-user button[type=submit]').click()`); await confirmOpen(); await clickConfirm();
    await waitFor(`/Done\./.test(document.querySelector('.st-revoke-user .st-form-status')?.textContent || '') && /Second Target/.test(document.querySelector('.st-revoke-user .st-form-status').textContent)`, "second revoke");
    assert.equal(await evalJs(`!!document.querySelector('form.st-modal')`), false, "a live grant is reused"); assert.equal(await meStatus(target2Cookie), 401);

    // a grant for the wrong purpose, or an invalid one, is refused and re-prompts
    const t3 = await loginCookie("target@ochiga.local", PWT); await evalJs(`OfficeStepUp.state.grants.session_revocation.token = OfficeStepUp.state.grants.session_revocation.token.slice(0, -4) + 'dead'; true`);
    await pickUser("target@ochiga.local"); await evalJs(`document.querySelector('.st-revoke-user button[type=submit]').click()`); await confirmOpen(); await clickConfirm();
    await waitFor(`/expired or is no longer valid/.test(document.querySelector('.st-revoke-user .st-form-status')?.textContent || '')`, "invalid grant message");
    assert.equal(await meStatus(t3), 200, "an invalid grant revoked nothing"); assert.equal(await evalJs(`OfficeStepUp.active('session_revocation')`), false, "bad grant discarded");
    console.log("3. A live grant is reused; a tampered/expired grant is refused with a clear message and asks for the password again — PASS");

    // failure state
    const realRevoke = store.revokeAdminSessions.bind(store); store.revokeAdminSessions = async () => { throw new Error("write failed"); };
    await evalJs(`document.querySelector('.st-revoke-user button[type=submit]').click()`); await confirmOpen(); await clickConfirm(); await stepUpOpen(); await stepUpType(PWS); await stepUpSubmit();
    await waitFor(`/Nothing was changed/.test(document.querySelector('.st-revoke-user .st-form-status')?.textContent || '')`, "failure message");
    assert.equal(await meStatus(t3), 200, "a failed write changed nothing"); store.revokeAdminSessions = realRevoke;
    console.log("4. A failed server write is reported as 'Nothing was changed' — PASS");

    // other roles
    const adminCookie = await loginCookie("admin@ochiga.local", PWA); await openPeople(adminCookie);
    assert.ok(await evalJs(`!!document.querySelector('#stSignOutEverywhere')`) && !(await evalJs(`!!document.querySelector('.st-revoke-user')`)), "an ochiga_admin may sign themself out but sees no user-revocation controls");
    await shot("s7-4-people-admin-1440.png");
    console.log("5. ochiga_admin sees only Your sessions — PASS");

    // capability unavailable
    const realSupports = store.supportsSessionRevocation.bind(store); store.supportsSessionRevocation = async () => false; await openPeople(superCookie = await loginCookie("super@ochiga.local", PWS));
    assert.ok(await evalJs(`!!document.querySelector('#stRevokeUnavailable') && !document.querySelector('#stSignOutEverywhere') && !document.querySelector('.st-revoke-user')`), "controls are hidden when the server lacks the migration");
    await shot("s7-4-unavailable-1440.png"); store.supportsSessionRevocation = realSupports;
    console.log("6. Migration absent: the controls are replaced by an explanation — PASS");

    // sign out everywhere: cancel, then confirm
    superCookie = await loginCookie("super@ochiga.local", PWS); const copy = { ...superCookie }; const gBefore = await gen("super@ochiga.local");
    await openPeople(superCookie);
    await evalJs(`document.querySelector('#stSignOutEverywhere').click()`); await confirmOpen(); await shot("s7-4-confirm-self-1440.png"); await evalJs(`document.querySelector('div.st-modal [data-act=cancel]').click()`);
    await waitFor(`/Cancelled/.test(document.querySelector('.st-revoke-status')?.textContent || '')`, "self cancel"); assert.equal(await meStatus(copy), 200, "cancel keeps the session");
    await evalJs(`document.querySelector('#stSignOutEverywhere').click()`); await confirmOpen(); await clickConfirm();
    await waitFor(`document.body.classList.contains('auth-logged-out') && getComputedStyle(document.querySelector('#loginScreen')).display !== 'none'`, "login screen");
    assert.equal(await meStatus(copy), 401, "a copied cookie is dead everywhere"); assert.equal(await gen("super@ochiga.local"), gBefore + 1);
    await shot("s7-4-signed-out-1440.png");
    console.log("7. Sign out everywhere: cancel keeps the session; confirm signs out, shows the login screen, and a copied cookie stops working — PASS");

    // responsive
    superCookie = await loginCookie("super@ochiga.local", PWS); await viewport(390, 800, true); await openPeople(superCookie);
    const fit = await evalJs(`(() => ({ noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1, targets: [...document.querySelectorAll('#stSignOutEverywhere, .st-revoke-user select, .st-revoke-user button')].every((n) => n.getBoundingClientRect().height >= 40) }))()`);
    assert.deepEqual(fit, { noOverflow: true, targets: true });
    await evalJs(`document.querySelector('#stSignOutEverywhere').scrollIntoView({ block: 'start' }); true`); await sleep(200); await shot("s7-4-people-390.png");
    await viewport(768, 900); await openPeople(superCookie); assert.ok(await evalJs(`document.documentElement.scrollWidth <= window.innerWidth + 1`), "768px: no overflow");
    console.log("8. Responsive 768/390: no overflow, touch-sized controls — PASS");

    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
    console.log(JSON.stringify({ status: "PASS", suite: "session-revocation-browser" }));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    chrome.kill();
    server.closeAllConnections?.(); await new Promise((r) => server.close(r));
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* chrome still flushing its profile */ }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
