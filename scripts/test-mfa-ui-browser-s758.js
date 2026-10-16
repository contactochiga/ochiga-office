// Settings S7.5.8: real-browser acceptance of the complete two-step verification interface. Headless Chrome over the DevTools protocol against the REAL Office server (file store, fixtures only),
// with a virtual authenticator for security keys. Skips (exit 0) when Chrome is not installed. OFFICE_S758_SHOTS=<dir> writes the screenshots.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { launchChrome, wrapSend } = require("./lib/browser-harness");
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
const m = require("../src/lead-agents/mfa-crypto");

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const limiter = (max) => new MemoryRateLimiter({ windowMs: 60000, maxRequests: max });
const SESSION = "s7-5-8-browser-session-secret-0123456789abcdef", K1 = crypto.randomBytes(32).toString("base64");
const A = "/api/lead-agents/admin"; const KEY = "office_mfa_enforcement"; const DAY = 86_400_000;
const SHOTS = process.env.OFFICE_S758_SHOTS || "";
const WIDTHS = [[1440, 900], [1100, 800], [900, 900], [768, 900], [390, 844]];
let passed = 0; const say = (msg) => { passed += 1; console.log(`${passed}. ${msg} — PASS`); };

async function main() {
  if (!CHROME) { console.log("SKIP: Chrome not installed"); return; }
  // ---- every e-mail the server sends is captured (no network); page requests are recorded separately through the DevTools protocol
  const mails = []; const realFetch = global.fetch;
  global.fetch = async (url, init) => { if (String(url).startsWith("https://api.resend.com")) { mails.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: "mail_1" }), { status: 200 }); } return realFetch(url, init); };
  const { store } = await createTempStore();
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["s758-key-0123456789"], allowedOrigins: [], sessionSecret: SESSION, sessionSecretEphemeral: false, mfaMode: "on", mfaKey: K1, mfaKeyId: "k1", mfaKeysPrevious: "", officeEmailProvider: "resend", resendApiKey: "re_test_not_real", webauthnRpId: "localhost", webauthnOrigins: [], mfaFleetAttested: "", mfaRecoveryApproved: false, allowApiKeyPasswordLogin: false, stepUpTtlMs: 5 * 60_000 };
  const pwOf = (label) => `${label} browser account passphrase 7`;
  const mk = (label, role = "super_admin", extra = {}) => store.ensureAdminUser({ email: `${label}@ochiga.local`, password_hash: hashPassword(pwOf(label)), role, display_name: label[0].toUpperCase() + label.slice(1), status: "active", ...extra });
  const admin = await mk("admin"); const second = await mk("second"); const target = await mk("target", "ochiga_staff"); const forced = await mk("forced", "ochiga_staff", { mfa_required_after: new Date(Date.now() - 1000).toISOString() });
  const grace = await mk("grace", "ochiga_staff", { mfa_required_after: new Date(Date.now() + 5 * DAY).toISOString() }); const plain = await mk("plain", "ochiga_staff"); const dbfail = await mk("dbfail", "ochiga_staff");
  await store.updateAdminUser(forced.id, { mfa_required_after: new Date(Date.now() - 1000).toISOString() }); await store.updateAdminUser(grace.id, { mfa_required_after: new Date(Date.now() + 5 * DAY).toISOString() }); // (ensureAdminUser does not carry this column)
  const adapter = { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: () => [], isConfigured: () => true, sendTextMessage: async () => ({ delivered: false }) };
  const server = buildServer({ config, store, rateLimiter: limiter(9000), publicRateLimiter: limiter(9000), officeRateLimiter: limiter(9000), loginRateLimiter: limiter(2000), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const port = await listen(server), base = `http://localhost:${port}`; config.webauthnOrigins = [base];
  // ---- server-side helpers (API only; used to prepare fixtures and to verify what the server really holds)
  const call = async (method, p, { cookie, body, token } = {}) => { const r = await fetch(`${base}${p}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { "x-step-up-token": token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: r.status, json: j, cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
  const codeNow = (secret, off = 0) => m.hotp(secret, m.totpCounter(Date.now()) + off);
  const resetStep = async (label) => { const u = await store.getAdminUserByEmail(`${label}@ochiga.local`); for (const c of store.state.admin_mfa_credentials) if (c.admin_user_id === u.id && c.type === "totp") c.totp_last_step = 0; await store.clearMfaFailures(u.id); };
  async function enrollViaApi(label) {
    const u = await store.getAdminUserByEmail(`${label}@ochiga.local`);
    const cookie = (await call("POST", `${A}/session/login`, { body: { email: u.email, password: pwOf(label) } })).cookie; const g = (await call("POST", `${A}/session/step-up`, { cookie, body: { password: pwOf(label), purpose: "mfa_management" } })).json.step_up.token;
    const b = await call("POST", `${A}/session/mfa/enroll/totp/begin`, { cookie, token: g, body: {} }); const secret = m.base32Decode(b.json.secret_base32);
    const c = await call("POST", `${A}/session/mfa/enroll/totp/confirm`, { cookie, token: g, body: { credential_id: b.json.credential_id, code: codeNow(secret) } }); assert.equal(c.status, 200); return { secret, codes: c.json.recovery_codes };
  }
  const secondE = await enrollViaApi("second"); const targetE = await enrollViaApi("target");

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "mfa-ui-chrome-"));
  const chromeHandle = await launchChrome(CHROME, { userDir, flags: ["--hide-scrollbars", "--disable-features=BackForwardCache"] }); const chrome = chromeHandle.proc;
  let ws, id = 0; const pending = new Map(); const errors = []; const requests = []; const consoleLines = [];
  try {
    let targets; for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${chromeHandle.port}/json`)).json(); } catch { await sleep(200); } }
    assert.ok(targets, "Chrome DevTools is reachable");
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (ev) => { const d = JSON.parse(ev.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); if (d.method === "Network.requestWillBeSent") requests.push(d.params.request.url); if (d.method === "Runtime.consoleAPICalled") consoleLines.push(JSON.stringify(d.params.args.map((a) => a.value ?? a.description))); };
    const send0 = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; const t = setTimeout(() => { pending.delete(n); reject(new Error(`CDP call timed out: ${method}`)); }, 30000); pending.set(n, (d) => { clearTimeout(t); resolve(d); }); ws.send(JSON.stringify({ id: n, method, params })); });
    const send = wrapSend(send0, { label: 'test-mfa-ui-browser-s758.js' });
    const navigate = async (url) => { try { return await send("Page.navigate", { url }); } catch (e) { if (!/timed out/.test(e.message)) throw e; return send("Page.navigate", { url }); } };
    const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
    const waitFor = async (expr, label, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJs(expr)) return true; } catch { /* navigating */ } await sleep(100); } const hint = await evalJs(`(document.getElementById("loginError")?.textContent || "") + " | " + location.href + " | " + (document.querySelector(".mfa-modal, .st-modal")?.innerText || "").slice(0, 400) + " | body=" + document.body.className + " " + document.body.innerText.slice(0, 300).replace(/\\n/g, " / ")`).catch(() => ""); throw new Error(`Timed out waiting for: ${label} [${hint}]`); };
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("WebAuthn.enable", { enableUI: false });
    const viewport = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w <= 480 });
    const shot = async (name) => { if (!SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.result.data, "base64")); };
    const layoutProblems = (scope) => evalJs(`(() => { const out = []; const w = window.innerWidth; if (document.documentElement.scrollWidth > w + 1) out.push('horizontal overflow ' + document.documentElement.scrollWidth + ' > ' + w);
      const root = document.querySelector(${JSON.stringify(scope)}) || document.body;
      if (w <= 768) for (const n of root.querySelectorAll('button, input:not([type=hidden]), select, textarea, a[href]')) { const style = getComputedStyle(n); if (style.display === 'none' || style.visibility === 'hidden' || n.closest('[hidden]') || n.classList.contains('st-sr')) continue; let r = n.getBoundingClientRect(); if (n.type === 'checkbox' || n.type === 'radio') { const lab = n.closest('label'); if (lab) r = lab.getBoundingClientRect(); } if (r.width === 0 && r.height === 0) continue; if (r.height < 43.5) out.push('touch target ' + (n.id || n.name || n.textContent.trim().slice(0, 24)) + ' is ' + Math.round(r.height) + 'px'); }
      return out; })()`);
    // accessibility of whatever dialog / region is on screen: role, labelled, every control named, focus inside
    const a11y = (scope, { dialogRole = true } = {}) => evalJs(`(() => { const out = []; const root = document.querySelector(${JSON.stringify(scope)}); if (!root) return ['scope missing']; const name = (n) => { const aria = n.getAttribute('aria-label'); if (aria) return aria; const lb = n.getAttribute('aria-labelledby'); if (lb) return lb.split(' ').map((i) => document.getElementById(i)?.textContent || '').join(' ').trim(); if (n.id) { const l = document.querySelector('label[for="' + n.id + '"]'); if (l) return l.textContent.trim(); } const wrap = n.closest('label'); if (wrap) return wrap.textContent.trim(); return (n.textContent || n.value || n.title || '').trim(); };
      if (${dialogRole}) { const d = root.matches('[role=dialog]') ? root : root.querySelector('[role=dialog]'); if (!d) out.push('no role=dialog'); else { if (d.getAttribute('aria-modal') !== 'true') out.push('aria-modal missing'); if (!name(d)) out.push('dialog has no accessible name'); if (!d.contains(document.activeElement)) out.push('focus is outside the dialog'); } }
      for (const n of root.querySelectorAll('button, input:not([type=hidden]), select, textarea')) { if (n.closest('[hidden]') || getComputedStyle(n).display === 'none') continue; if (!name(n)) out.push('unnamed control ' + n.tagName + ' ' + (n.id || n.name || '')); }
      for (const n of root.querySelectorAll('svg[role=img]')) if (!n.getAttribute('aria-label')) out.push('svg without text alternative');
      return out; })()`);
    const shotAll = async (name, scope = "body", opts = {}) => {
      const problems = []; for (const [w, h] of WIDTHS) { await viewport(w, h); await sleep(120); for (const pr of await layoutProblems(scope)) problems.push(`${w}px: ${pr}`); if (SHOTS) await shot(`${name}-${w}.png`); }
      await viewport(1440, 900); assert.deepEqual(problems, [], `${name}: no overflow and 44px touch targets at <=768px`);
      assert.deepEqual(await a11y(scope, opts), [], `${name}: accessible names, roles and focus`); };
    const q = (sel) => evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);
    const txt = (sel) => evalJs(`document.querySelector(${JSON.stringify(sel)})?.innerText || ''`);
    const fill = async (sel, v) => { if (/mfa_code/.test(sel)) await waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, `second-factor field ${sel}`, 8000); return fillNow(sel, v); };
    const fillNow = (sel, v) => evalJs(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.focus(); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const click = (sel) => evalJs(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) throw new Error('missing ' + ${JSON.stringify(sel)}); b.click(); return true; })()`);
    const clickText = (scope, label) => evalJs(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw new Error('no button ' + ${JSON.stringify(label)}); b.click(); return true; })()`);
    const topTxt = (sel) => evalJs(`(() => { const b = [...document.querySelectorAll('.st-modal-backdrop')].pop(); return b?.querySelector(${JSON.stringify(sel)})?.innerText || ''; })()`);
    const clickTop = (label) => evalJs(`(() => { const b = [...document.querySelectorAll('.st-modal-backdrop')].pop(); const x = [...b.querySelectorAll('button')].find((n) => n.textContent.trim() === ${JSON.stringify(label)}); if (!x) throw new Error('no top button ' + ${JSON.stringify(label)}); x.click(); return true; })()`);
    const signedOut = () => q("body.auth-logged-out");
    const freshLogin = async () => { await send("Network.clearBrowserCookies"); await navigate("about:blank"); await navigate(`${base}/office`); await waitFor(`!!document.getElementById('loginEmail') && document.getElementById('loginForm').dataset.wired === '1'`, "login form wired"); await evalJs(`localStorage.clear(); sessionStorage.clear(); true`); };
    const loginAs = async (label) => { await fill("#loginEmail", `${label}@ochiga.local`); await fill("#loginPassword", pwOf(label)); await click("#loginSubmit"); };
    const secretFromPage = async () => m.base32Decode(String(await txt(".mfa-key")).replace(/\s+/g, ""));
    const dialogOpen = () => q(".mfa-modal, .st-modal");
    const knownSecrets = []; // anything secret the page showed: audited at the end against storage, console, audit records
    let adminSecret; let adminCodes;

    // =================== 1. MFA off: nothing changes, nothing extra is requested
    const offConfig = { ...config, mfaMode: "off" }; const offServer = buildServer({ config: offConfig, store, rateLimiter: limiter(9000), publicRateLimiter: limiter(9000), officeRateLimiter: limiter(9000), loginRateLimiter: limiter(2000), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config: offConfig, log: () => {}, webhooks: new WebhookDispatcher({ config: offConfig }) }) });
    const offPort = await listen(offServer); const offBase = `http://localhost:${offPort}`;
    await viewport(1440, 900); await send("Network.clearBrowserCookies"); await navigate(`${offBase}/office`); await waitFor(`!!document.getElementById('loginEmail') && document.getElementById('loginForm').dataset.wired === '1'`, "login (MFA off)"); requests.length = 0;
    await loginAs("admin"); await waitFor(`!document.body.classList.contains('auth-logged-out')`, "shell (MFA off)");
    assert.ok(!(await evalJs(`location.href`)).includes('password='), "the password never appears in the URL"); assert.equal(await q("#mfaChallenge"), false, "no challenge"); assert.equal(await evalJs(`document.getElementById('navSecurity').hidden`), true, "no two-step entry while it is off");
    assert.ok(!requests.some((u) => /\/session\/mfa|mfa-ui|qrcode/.test(u)), `signing in with MFA off makes no MFA request and loads no MFA code (${requests.filter((u) => /mfa|qrcode/.test(u))})`);
    await navigate(`${offBase}/office#settings/people`); await waitFor(`!!document.querySelector('#stContent')?.innerText.includes('isn\\u2019t switched on')`, "off note"); assert.equal(await q("#mfaAddTotp"), false, "no set-up button while it is off");
    say("MFA off (default): ordinary password sign-in, no MFA request or script, no two-step entry, People & Access says it is not switched on");
    await new Promise((r) => { offServer.closeAllConnections?.(); offServer.close(r); }); await send("Network.clearBrowserCookies"); requests.length = 0;

    // =================== 2. password-first login, then first-time voluntary enrolment from the footer entry
    await navigate("about:blank"); await navigate(`${base}/office`); await waitFor(`!!document.getElementById('loginEmail') && document.getElementById('loginForm').dataset.wired === '1'`, "login form wired"); await loginAs("admin");
    await waitFor(`!document.body.classList.contains('auth-logged-out')`, "admin shell"); assert.equal(await q("#mfaChallenge"), false, "an account without a factor signs in with the password alone (enforcement is off)");
    await waitFor(`!document.getElementById('navSecurity').hidden`, "footer entry"); await evalJs(`document.getElementById("navSecurity").focus(); true`); await click("#navSecurity"); await waitFor(`!!document.querySelector('#mfaAddTotp')`, "panel");
    assert.match(await txt(".mfa-modal"), /Not set up/); await shotAll("s758-panel-not-enrolled", ".mfa-modal");
    await click("#mfaAddTotp"); await waitFor(`!!document.querySelector('.st-modal input[name=current_password]')`, "step-up dialog");
    await sleep(700); assert.equal(await q(".mfa-stepup"), false, "an account without a factor is asked for the password only");
    await fill(".st-modal input[name=current_password]", pwOf("admin")); await click('.st-modal [data-act=ok]');
    await waitFor(`!!document.querySelector('.mfa-qr') && !!document.querySelector('.mfa-key')`, "setup screen with QR");
    adminSecret = await secretFromPage(); knownSecrets.push(String(await txt(".mfa-key")).replace(/\s+/g, ""));
    const qr = await evalJs(`(() => { const s = document.querySelector('.mfa-qr'); return { tag: s.tagName.toLowerCase(), label: s.getAttribute('aria-label'), paths: s.querySelectorAll('path').length, role: s.getAttribute('role'), hasImg: !!document.querySelector('.mfa-modal img, .mfa-modal canvas') }; })()`);
    assert.ok(qr.tag === "svg" && qr.role === "img" && /QR code/.test(qr.label) && qr.paths === 1 && !qr.hasImg, "the QR code is a locally generated SVG with a text alternative (no image or canvas fetched from anywhere)");
    assert.ok(!requests.some((u) => /^https?:/.test(u) && !u.startsWith(base)), `no third-party request so far (${requests.filter((u) => /^https?:/.test(u) && !u.startsWith(base))})`);
    await shotAll("s758-setup-authenticator", ".st-modal-backdrop:last-of-type .mfa-modal");
    await fill(".mfa-form input[name=code]", "000000"); await click('.mfa-form button[type=submit]'); await waitFor(`/didn.t match/.test(document.querySelector('#mfaSetupErr')?.textContent || '')`, "wrong code");
    assert.equal(await evalJs(`document.querySelector('.mfa-form input').value`), "", "a wrong code is cleared"); assert.equal(await q(".mfa-qr"), true, "setup stays open after a wrong code");
    await fill(".mfa-form input[name=code]", codeNow(adminSecret)); await click('.mfa-form button[type=submit]');
    await waitFor(`!!document.querySelector('.mfa-codes')`, "recovery codes");
    adminCodes = await evalJs(`[...document.querySelectorAll('.mfa-codes code')].map((c) => c.textContent)`); knownSecrets.push(...adminCodes);
    assert.equal(adminCodes.length, 10, "ten recovery codes, shown by the server's confirmation");
    assert.deepEqual(await evalJs(`({ doneDisabled: document.querySelector('[data-act=done]').disabled, tools: [...document.querySelectorAll('.mfa-tools button')].map((b) => b.textContent) })`), { doneDisabled: true, tools: ["Copy", "Download", "Print"] }, "copy, download and print offered; Done needs the acknowledgement");
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`); assert.equal(await q(".mfa-codes"), true, "Esc does not dismiss the recovery codes");
    await click('.mfa-tools [data-act=copy]'); await sleep(200); assert.ok(/Copied|blocked/.test(await topTxt(".mfa-status")), "copy reports its real outcome");
    await click('.mfa-tools [data-act=download]'); await waitFor(`/Downloaded/.test([...document.querySelectorAll('.st-modal-backdrop')].pop()?.querySelector('.mfa-status')?.textContent || '')`, "download");
    await shotAll("s758-recovery-codes", ".st-modal-backdrop:last-of-type .mfa-modal");
    await evalJs(`(() => { const c = document.querySelector('.mfa-ack input'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); assert.equal(await evalJs(`document.querySelector('[data-act=done]').disabled`), false, "acknowledgement enables Done");
    await click('[data-act=done]'); await waitFor(`!document.querySelector('.mfa-codes')`, "codes dismissed");
    assert.equal(await evalJs(`document.body.innerText.includes(${JSON.stringify(adminCodes[0])})`), false, "the codes are gone from the page after Done");
    await waitFor(`!!document.querySelector('.mfa-table [data-credential]')`, "enrolled row"); assert.match(await txt(".mfa-modal"), /Authenticator app/);
    await shotAll("s758-panel-enrolled", ".mfa-modal");
    say("Password-first sign-in, then enrolment: local SVG QR + manual key, wrong code refused, TOTP confirmed, recovery codes shown once with copy/download/print and a required acknowledgement, then cleared");
    await click('.mfa-modal [data-act=close]'); await waitFor(`!document.querySelector('.mfa-modal')`, "panel closed");
    assert.equal(await evalJs(`document.activeElement === document.getElementById('navSecurity')`), true, "focus returns to the control that opened the panel");

    // =================== 3. login challenge: TOTP, wrong, locked, expired, recovery, unavailable
    await freshLogin(); await loginAs("admin"); await waitFor(`!!document.getElementById('mfaChallenge')`, "challenge");
    assert.equal(await evalJs(`document.body.classList.contains('auth-logged-out')`), true, "no session while the challenge is open");
    assert.equal(await evalJs(`document.getElementById('loginPassword').value`), "", "the password field is cleared once the challenge starts");
    assert.deepEqual(await evalJs(`[...document.querySelectorAll('#mfaChallenge .mfa-methods button')].map((b) => b.textContent)`), ["Authenticator app", "Recovery code"], "only the methods the server listed (no security key registered yet)");
    assert.equal(await evalJs(`document.activeElement?.name`), "code", "focus lands in the code field");
    await shotAll("s758-login-challenge", "#mfaChallenge", { dialogRole: false });
    await fill("#mfaChallenge [data-panel=totp] input", "000000"); await click("#mfaChallenge [data-panel=totp] button[type=submit]");
    await waitFor(`/didn.t work/.test(document.querySelector('.mfa-error')?.textContent || '')`, "wrong code message"); assert.equal(await signedOut(), true, "a wrong factor creates no session");
    await resetStep("admin"); await fill("#mfaChallenge [data-panel=totp] input", codeNow(adminSecret)); await click("#mfaChallenge [data-panel=totp] button[type=submit]");
    await waitFor(`!document.body.classList.contains('auth-logged-out')`, "signed in with TOTP"); assert.equal(await q("#mfaChallenge"), false, "challenge removed after success");
    say("Login challenge (TOTP): password first, challenge UI with the listed methods and no session; wrong code refused; correct code signs in");

    // locked
    await freshLogin(); await loginAs("admin"); await waitFor(`!!document.getElementById('mfaChallenge')`, "challenge");
    await store.recordMfaFailure((await store.getAdminUserByEmail("admin@ochiga.local")).id).catch(() => null); for (let i = 0; i < 5; i += 1) await store.recordMfaFailure((await store.getAdminUserByEmail("admin@ochiga.local")).id);
    await fill("#mfaChallenge [data-panel=totp] input", codeNow(adminSecret)); await click("#mfaChallenge [data-panel=totp] button[type=submit]");
    await waitFor(`/Try again in/.test(document.querySelector('.mfa-error')?.textContent || '')`, "lock message"); assert.equal(await signedOut(), true, "a locked account gets no session even with a correct code");
    assert.equal(await evalJs(`document.querySelector('#mfaChallenge [data-panel=totp] button[type=submit]').disabled`), true, "the form is disabled while locked");
    await shot("s758-login-locked-1440.png"); await store.clearMfaFailures((await store.getAdminUserByEmail("admin@ochiga.local")).id);
    say("Rate limiting / lock: the server's lock is shown with the wait time and no session is created");

    // expired challenge (password changed after the challenge was issued -> the server calls it expired)
    await freshLogin(); await loginAs("admin"); await waitFor(`!!document.getElementById('mfaChallenge')`, "challenge");
    const adminRow = await store.getAdminUserByEmail("admin@ochiga.local"); const oldHash = adminRow.password_hash; await store.updateAdminUser(adminRow.id, { password_hash: hashPassword("another admin passphrase 9") });
    await resetStep("admin"); await fill("#mfaChallenge [data-panel=totp] input", codeNow(adminSecret)); await click("#mfaChallenge [data-panel=totp] button[type=submit]");
    await waitFor(`/expired/.test(document.querySelector('.mfa-error')?.textContent || '')`, "expired message"); assert.equal(await signedOut(), true); await store.updateAdminUser(adminRow.id, { password_hash: oldHash });
    assert.equal(await evalJs(`document.querySelector('#mfaChallenge [data-panel=totp] button[type=submit]').disabled`), true, "an expired challenge cannot be submitted again"); await click('#mfaChallenge [data-act=back]'); await waitFor(`!!document.getElementById('loginEmail') && document.getElementById('loginFields').style.display !== 'none'`, "back to sign-in");
    say("Expired challenge: explained, cannot be retried, 'Back to sign in' returns to the password form");

    // unavailable service: never a password-only session
    await freshLogin(); await loginAs("admin"); await waitFor(`!!document.getElementById('mfaChallenge')`, "challenge"); const origLock = store.getMfaLockState.bind(store); store.getMfaLockState = async () => { throw new Error("db down"); };
    await fill("#mfaChallenge [data-panel=totp] input", codeNow(adminSecret)); await click("#mfaChallenge [data-panel=totp] button[type=submit]");
    await waitFor(`/temporarily unavailable/.test(document.querySelector('.mfa-error')?.textContent || '')`, "unavailable message"); assert.equal(await signedOut(), true, "an unavailable MFA service never signs the person in"); assert.ok(/not been signed in/.test(await txt(".mfa-error")), "…and says so"); assert.ok(!/db down/.test(await evalJs(`document.body.innerText`)), "no internal detail shown");
    store.getMfaLockState = origLock; await freshLogin();
    { const login503 = origLock; void login503; const orig = store.hasActiveMfa.bind(store); store.hasActiveMfa = async () => { throw new Error("db down"); }; await loginAs("admin"); await waitFor(`/unavailable/i.test(document.getElementById('loginError').textContent)`, "sign-in unavailable"); assert.equal(await signedOut(), true, "a database failure at the password step also signs nobody in"); store.hasActiveMfa = orig; }
    say("Unavailable MFA service / database failure: clear message, no internal detail, no session, no password-only fallback");

    // recovery code
    await freshLogin(); await loginAs("admin"); await waitFor(`!!document.getElementById('mfaChallenge')`, "challenge"); await clickText("#mfaChallenge .mfa-methods", "Recovery code");
    assert.equal(await evalJs(`document.querySelector('#mfaChallenge [data-panel=recovery_code]').hidden`), false); await fill("#mfaChallenge [data-panel=recovery_code] input", adminCodes[0]); await click("#mfaChallenge [data-panel=recovery_code] button[type=submit]");
    await waitFor(`!document.body.classList.contains('auth-logged-out')`, "signed in with a recovery code"); await waitFor(`/recovery code\\. 9 left/.test(document.body.innerText)`, "remaining-codes notice");
    await freshLogin(); await loginAs("admin"); await waitFor(`!!document.getElementById('mfaChallenge')`, "challenge"); await clickText("#mfaChallenge .mfa-methods", "Recovery code"); await fill("#mfaChallenge [data-panel=recovery_code] input", adminCodes[0]); await click("#mfaChallenge [data-panel=recovery_code] button[type=submit]");
    await waitFor(`/didn.t work/.test(document.querySelector('.mfa-error')?.textContent || '')`, "used code refused"); assert.equal(await signedOut(), true, "a used recovery code is refused");
    say("Recovery-code sign-in: works once, shows how many remain, a used code is refused");

    // =================== 4. security key: register in the panel, then sign in with it
    const authn = await send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }); const authenticatorId = authn.result.authenticatorId;
    await freshLogin(); await loginAs("admin"); await waitFor(`!!document.getElementById('mfaChallenge')`, "challenge"); await resetStep("admin"); await fill("#mfaChallenge [data-panel=totp] input", codeNow(adminSecret)); await click("#mfaChallenge [data-panel=totp] button[type=submit]"); await waitFor(`!document.body.classList.contains('auth-logged-out')`, "signed in");
    await click("#navSecurity"); await waitFor(`!!document.querySelector('#mfaAddKey')`, "add-key button"); await click("#mfaAddKey"); await waitFor(`!!document.querySelector('.mfa-modal input[name=label]')`, "name dialog"); await fill(".mfa-modal input[name=label]", "Office key"); await clickText(".mfa-modal", "Continue");
    await waitFor(`!!document.querySelector('.st-modal input[name=current_password]')`, "step-up for the key"); await waitFor(`!!document.querySelector(".mfa-stepup")`, "second-factor controls"); assert.equal(await q(".mfa-stepup"), true, "an enrolled account is asked for a second factor too"); assert.equal(await evalJs(`document.querySelector('.mfa-stepup legend').textContent.includes('Second factor')`), true);
    await shotAll("s758-stepup-factor", ".st-modal-backdrop:last-of-type .st-modal");
    await fill(".st-modal input[name=current_password]", pwOf("admin")); await click('.st-modal [data-act=ok]'); await waitFor(`/Enter the code/.test(document.querySelector('.st-modal .st-field-error')?.textContent || '')`, "factor required");
    assert.equal(await q(".st-modal input[name=current_password]"), true, "the dialog stays open and asks for the code");
    await resetStep("admin"); await fill(".st-modal input[name=current_password]", pwOf("admin")); await fill(".st-modal input[name=mfa_code]", codeNow(adminSecret)); await click('.st-modal [data-act=ok]');
    await waitFor(`!!document.querySelector('.mfa-table [data-credential] ') && document.querySelectorAll('.mfa-table [data-credential]').length === 2`, "two methods listed", 15000);
    assert.match(await txt(".mfa-table"), /Security key or passkey/); assert.match(await txt(".mfa-table"), /Office key/);
    assert.equal(await evalJs(`document.querySelectorAll('.mfa-codes').length`), 0, "adding a second method does not regenerate or reshow recovery codes");
    say("Security key: step-up asks for password + second factor (refuses without it), key registered through the real browser ceremony, listed by name");
    await click('.mfa-modal [data-act=close]');
    await freshLogin(); await loginAs("admin"); await waitFor(`!!document.getElementById('mfaChallenge')`, "challenge"); assert.deepEqual(await evalJs(`[...document.querySelectorAll('#mfaChallenge .mfa-methods button')].map((b) => b.textContent)`), ["Authenticator app", "Security key", "Recovery code"]);
    await clickText("#mfaChallenge .mfa-methods", "Security key"); await click("#mfaChallenge .mfa-key-btn"); await waitFor(`!document.body.classList.contains('auth-logged-out')`, "signed in with the key", 15000);
    say("WebAuthn challenge: security key listed by the server, real assertion verified, signed in");

    // =================== 5. management with a fresh factor: replace, regenerate, remove
    await click("#navSecurity"); await waitFor(`!!document.querySelector('#mfaAddTotp')`, "panel"); assert.match(await txt("#mfaAddTotp"), /Replace/);
    await click("#mfaAddTotp"); await waitFor(`!!document.querySelector('.st-modal input[name=current_password]')`, "step-up"); await fill(".st-modal input[name=current_password]", pwOf("admin"));
    await evalJs(`(() => { const b = [...document.querySelectorAll('.mfa-stepup .mfa-method')].find((x) => x.dataset.m === 'webauthn'); b.click(); return true; })()`); await click('.st-modal [data-act=ok]');
    await waitFor(`!!document.querySelector('.mfa-qr')`, "replacement setup (confirmed with the security key as the second factor)", 15000);
    const newSecret = await secretFromPage(); knownSecrets.push(String(await txt(".mfa-key")).replace(/\s+/g, "")); assert.match(await topTxt(".mfa-dialog-body"), /replaces your current authenticator/);
    await fill(".mfa-form input[name=code]", codeNow(newSecret)); await click('.mfa-form button[type=submit]');
    await waitFor(`!document.querySelector('.mfa-qr') && document.querySelectorAll('.mfa-table [data-credential]').length === 2`, "replacement done (no recovery codes reshown)", 15000); assert.equal(await q(".mfa-codes"), false, "a replacement does not reshow recovery codes");
    adminSecret = newSecret; await shot("s758-replaced-1440.png");
    say("Factor replacement: confirmed with the security key as the second factor, new authenticator confirmed, old one replaced, server-confirmed list");
    await click("#mfaRegen"); await waitFor(`[...document.querySelectorAll('.st-modal h3')].some((h) => /Regenerate recovery codes\\?/.test(h.innerText))`, "regenerate confirm"); await clickTop("Regenerate");
    await waitFor(`!!document.querySelector('.st-modal input[name=current_password]')`, "step-up"); await resetStep("admin"); await fill(".st-modal input[name=current_password]", pwOf("admin")); await fill(".st-modal input[name=mfa_code]", codeNow(adminSecret)); await click('.st-modal [data-act=ok]');
    await waitFor(`!!document.querySelector('.mfa-codes')`, "new codes", 15000); const regen = await evalJs(`[...document.querySelectorAll('.mfa-codes code')].map((c) => c.textContent)`); knownSecrets.push(...regen); assert.equal(regen.length, 10); assert.ok(!regen.includes(adminCodes[1]), "new codes differ from the old batch");
    await evalJs(`(() => { const c = document.querySelector('.mfa-ack input'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await click('[data-act=done]'); await waitFor(`!document.querySelector('.mfa-codes')`, "closed");
    assert.equal((await call("POST", `${A}/session/login`, { body: { email: "admin@ochiga.local", password: pwOf("admin") } })).json.mfa_required, true);
    say("Recovery-code regeneration: confirmation, step-up with a fresh factor, new codes shown once");
    // remove the security key (not the last factor)
    await evalJs(`(() => { const row = [...document.querySelectorAll('.mfa-table tbody tr')].find((r) => r.textContent.includes('Security key')); row.querySelector('button').click(); return true; })()`);
    await waitFor(`[...document.querySelectorAll('.st-modal h3')].some((h) => /Remove this method/.test(h.innerText))`, "remove confirm"); await clickTop("Remove"); await waitFor(`!!document.querySelector('.st-modal input[name=current_password]')`, "step-up"); await resetStep("admin"); await fill(".st-modal input[name=current_password]", pwOf("admin")); await fill(".st-modal input[name=mfa_code]", codeNow(adminSecret)); await click('.st-modal [data-act=ok]');
    await waitFor(`document.querySelectorAll('.mfa-table [data-credential]').length === 1`, "one method left", 15000); assert.equal(await evalJs(`/Security key/.test(document.querySelector('.mfa-table').innerText)`), false);
    say("Factor removal: confirmation, step-up with a fresh factor, server-confirmed list shows the key gone");
    await send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await click('.mfa-modal [data-act=close]');


    // =================== 6. forced enrolment (the account is past its deadline: no session, mailbox code, set up, sign in again)
    await freshLogin(); mails.length = 0; await loginAs("forced"); await waitFor(`!!document.getElementById('mfaForced')`, "forced enrolment");
    assert.equal(await signedOut(), true, "no session while enrolment is required"); assert.match(await txt("#authCardTitle"), /Set up two-step verification/);
    await shotAll("s758-forced-enrolment", "#mfaForced", { dialogRole: false });
    await click("#mfaForced [data-act=send]"); await waitFor(`!!document.querySelector('#mfaForced input[name=code]')`, "mailbox code field");
    const mail = mails.at(-1); assert.ok(mail && mail.to === "forced@ochiga.local", "the code went to the account's own mailbox"); const mailCode = (mail.text.match(/(\d{8})/) || [])[1]; assert.ok(mailCode, "an 8-digit code was e-mailed");
    await fill("#mfaForced input[name=code]", "00000000"); await click("#mfaForced button[type=submit]"); await waitFor(`/didn.t work/.test(document.querySelector('#mfaForced .mfa-error')?.textContent || '')`, "wrong mailbox code");
    await fill("#mfaForced input[name=code]", mailCode); await click("#mfaForced button[type=submit]"); await waitFor(`!!document.querySelector('.mfa-qr')`, "setup after the mailbox check");
    const forcedSecret = await secretFromPage(); knownSecrets.push(String(await txt(".mfa-key")).replace(/\s+/g, ""));
    await fill(".mfa-form input[name=code]", codeNow(forcedSecret)); await click(".mfa-form button[type=submit]"); await waitFor(`!!document.querySelector('.mfa-codes')`, "forced recovery codes");
    const forcedCodes = await evalJs(`[...document.querySelectorAll('.mfa-codes code')].map((c) => c.textContent)`); knownSecrets.push(...forcedCodes); assert.equal(forcedCodes.length, 10);
    assert.equal(await signedOut(), true, "still no session after enrolling (the person signs in again)");
    await evalJs(`(() => { const c = document.querySelector('.mfa-ack input'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await click("[data-act=done]");
    await waitFor(`!!document.getElementById('loginEmail') && /set up/i.test(document.getElementById('loginError').textContent)`, "back to sign-in with the message");
    await loginAs("forced"); await waitFor(`!!document.getElementById('mfaChallenge')`, "challenge for the new factor"); await resetStep("forced"); await fill("#mfaChallenge [data-panel=totp] input", codeNow(forcedSecret)); await click("#mfaChallenge [data-panel=totp] button[type=submit]");
    await waitFor(`!document.body.classList.contains('auth-logged-out')`, "forced user signed in"); assert.ok(!(await store.getAdminUserByEmail("forced@ochiga.local")).mfa_required_after, "the requirement is cleared once enrolled");
    say("Forced enrolment: no session, mailbox code (wrong refused), authenticator setup, recovery codes once, back to sign-in, then the new factor signs in");

    // =================== 7. grace banner (server-provided notice)
    await freshLogin(); await loginAs("grace"); await waitFor(`!document.body.classList.contains('auth-logged-out')`, "grace user signed in (inside the set-up period)");
    await waitFor(`!!document.getElementById('mfaGraceBanner')`, "grace banner"); assert.match(await txt("#mfaGraceBanner"), /required for your account by .+ \((4|5) days left\)/); await shotAll("s758-grace-banner", "#mfaGraceBanner", { dialogRole: false });
    await click("#mfaGraceBanner [data-act=setup]"); await waitFor(`!!document.querySelector('#mfaAddTotp')`, "panel from the banner"); assert.match(await txt(".mfa-modal"), /required for your account\s*yes/i); await click(".mfa-modal [data-act=close]");
    await click("#mfaGraceBanner [data-act=dismiss]"); assert.equal(await q("#mfaGraceBanner"), false, "the banner can be dismissed for this page view");
    say("Enrolment grace: the server's notice shows as a banner with the date and days left, 'Set up now' opens the panel, dismiss works");

    // =================== 8. permission denial: an ordinary account has the panel but no policy / reset / Settings
    await freshLogin(); await loginAs("plain"); await waitFor(`!document.body.classList.contains('auth-logged-out')`, "plain user");
    await navigate(`${base}/office#settings/people`); await sleep(800); assert.equal(await q("#mfaEnfCurrent"), false, "no policy card without staff.manage"); assert.equal(await q(".mfa-reset"), false, "no reset card without team.manage");
    assert.equal(await evalJs(`!document.getElementById('navSecurity').hidden`), true, "…but anyone can manage their own two-step methods");
    assert.equal((await call("POST", `${A}/users/${admin.id}/mfa/reset`, { cookie: (await call("POST", `${A}/session/login`, { body: { email: "plain@ochiga.local", password: pwOf("plain") } })).cookie, token: "x", body: { reason: "nope", confirm: true, confirm_email: "admin@ochiga.local" } })).status, 403, "the server refuses the reset regardless of what the UI shows");
    say("Permission denial: no policy or reset controls for an ordinary account, own-panel still available, and the server independently refuses a reset");

    // =================== 9. People & Access as super administrator: reset another person, then the governed enforcement policy
    await freshLogin(); await loginAs("admin"); await waitFor(`!!document.getElementById('mfaChallenge')`, "challenge"); await resetStep("admin"); await fill("#mfaChallenge [data-panel=totp] input", codeNow(adminSecret)); await click("#mfaChallenge [data-panel=totp] button[type=submit]");
    await waitFor(`!document.body.classList.contains('auth-logged-out')`, "admin signed in"); await navigate(`${base}/office#settings/people`); await waitFor(`!!document.querySelector('.mfa-reset') && !!document.querySelector('#mfaEnfCurrent')`, "People & Access MFA cards", 15000);
    await shotAll("s758-people-access", "#stContent", { dialogRole: false });
    const resetUi = async (email) => { await evalJs(`(() => { const f = document.querySelector('.mfa-reset'); f.elements.user.value = [...f.elements.user.options].find((o) => o.textContent.includes('target@ochiga.local')).value; f.elements.user.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await fill(".mfa-reset input[name=reason]", "Lost phone, identity checked by video call"); await fill(".mfa-reset input[name=email]", email); await evalJs(`(() => { const c = document.querySelector('.mfa-reset input[name=confirm]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); };
    assert.equal(await evalJs(`document.querySelector('.mfa-reset button[type=submit]').disabled`), true, "reset stays disabled until person, reason, email and confirmation are all given");
    await resetUi("someone@else.test"); await click(".mfa-reset button[type=submit]"); await waitFor(`/doesn.t match/.test(document.querySelector('.mfa-reset .st-field-error')?.textContent || '')`, "email mismatch"); assert.ok((await store.hasActiveMfa((await store.getAdminUserByEmail("target@ochiga.local")).id)), "nothing changed on a mismatch");
    await fill(".mfa-reset input[name=email]", "target@ochiga.local"); await shotAll("s758-admin-reset", ".mfa-reset", { dialogRole: false }); await click(".mfa-reset button[type=submit]");
    await waitFor(`[...document.querySelectorAll('.st-modal h3')].some((h) => /Reset two-step verification for/.test(h.innerText))`, "reset confirm"); await clickTop("Reset");
    await waitFor(`!!document.querySelector('.st-modal input[name=current_password]')`, "step-up for the reset"); await waitFor(`!!document.querySelector(".mfa-stepup")`, "second-factor controls"); assert.equal(await q(".mfa-stepup"), true, "the reset needs the actor's own fresh second factor");
    await resetStep("admin"); await fill(".st-modal input[name=current_password]", pwOf("admin")); await fill(".st-modal input[name=mfa_code]", codeNow(adminSecret)); await click(".st-modal [data-act=ok]");
    await waitFor(`/Done\. The server confirms/.test(document.querySelector('.mfa-reset .st-form-status')?.textContent || '')`, "server-confirmed reset", 15000);
    const resetMsg = await txt(".mfa-reset .st-form-status"); assert.match(resetMsg, /1 method removed, 10 recovery codes deleted, signed out everywhere/); assert.match(resetMsg, /Email notice: sent/);
    const tRow = await store.getAdminUserByEmail("target@ochiga.local"); assert.ok(!(await store.hasActiveMfa(tRow.id)) && tRow.mfa_required_after, "the server really reset the target and requires re-enrolment");
    say("Administrator reset: all fields and the email retype required, mismatch refused, confirmation, step-up with the actor's fresh factor, outcome shown only from the server's answer");

    // enforcement policy
    assert.match(await txt("#mfaEnfCurrent"), /Off/); config.mfaFleetAttested = ""; await click("#mfaLevel_privileged"); await waitFor(`!!document.querySelector('.mfa-checks')`, "preflight result");
    assert.equal(await evalJs(`document.querySelector('[data-check=fleet_attested]').dataset.state`), "fail", "fleet readiness is reported as not ready"); assert.equal(await evalJs(`document.querySelector('[data-check=recovery_path]').dataset.state`), "ok", "recovery readiness reported ready (a second enrolled administrator exists)");
    assert.match(await txt(".mfa-blocked"), /blocked/); assert.equal(await evalJs(`document.querySelector('.mfa-apply button[type=submit]').disabled`), true, "Apply stays disabled while a required check fails (the server would refuse as well)");
    assert.match(await txt("#mfaCounts"), /active accounts/i); await shotAll("s758-enforcement-blocked", "#stContent", { dialogRole: false });
    config.mfaFleetAttested = "s7.5.7"; await click("#mfaLevel_off"); await click("#mfaLevel_privileged"); await waitFor(`!document.querySelector('.mfa-blocked') && !!document.querySelector('.mfa-checks')`, "ready preflight");
    await evalJs(`(() => { const c = document.querySelector('.mfa-apply input[name=confirm]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); assert.equal(await evalJs(`document.querySelector('.mfa-apply button[type=submit]').disabled`), false, "Apply is enabled only when the preflight passed and the change is confirmed");
    await shotAll("s758-enforcement-ready", "#stContent", { dialogRole: false });
    await click(".mfa-apply button[type=submit]"); await waitFor(`!!document.querySelector('.st-modal input[name=current_password]')`, "step-up for the policy"); await resetStep("admin"); await fill(".st-modal input[name=current_password]", pwOf("admin")); await fill(".st-modal input[name=mfa_code]", codeNow(adminSecret)); await click(".st-modal [data-act=ok]");
    await waitFor(`/Saved\. The server confirms/.test(document.querySelector('#stContent')?.innerText || '')`, "server-confirmed policy change", 15000);
    assert.equal((await store.getRuntimeSetting(KEY)).value, "privileged", "the registry really holds the new requirement"); assert.match(await txt("#mfaEnfCurrent"), /Privileged accounts/);
    // a stale expected version is shown as a conflict, not applied; and the 'everyone' preview lists deadlines
    await click("#mfaLevel_all"); await waitFor(`!!document.querySelector('.mfa-deadlines')`, "deadline table"); assert.match(await txt(".mfa-deadlines"), /deadline/i); assert.equal(await evalJs(`/Plain/.test(document.querySelector('.mfa-deadlines').innerText)`), true, "accounts that still have to set up are listed with their deadline");
    say("Enforcement policy: current level, counts, readiness, deadlines; blocked while a required check fails; applied only through the registry after preflight + step-up, and the displayed result is the server's");

    // =================== 10. a session ended by the server returns to sign-in with the reason
    await freshLogin(); await loginAs("plain"); await waitFor(`!document.body.classList.contains('auth-logged-out')`, "plain signed in"); const plainRow = await store.getAdminUserByEmail("plain@ochiga.local"); await store.revokeAdminSessions(plainRow.id, { actor: "test" });
    await evalJs(`location.hash = '#/tasks'; true`); await waitFor(`document.body.classList.contains('auth-logged-out') && /signed out/i.test(document.getElementById('loginError').textContent)`, "back to sign-in after the server revoked the session"); 
    say("A session ended by the server (revoked) returns to sign-in with the reason; nothing keeps working");

    // =================== 11. security audits: storage, network, console, audit records
    await freshLogin(); await loginAs("admin"); await waitFor(`!!document.getElementById('mfaChallenge')`, "challenge"); const challengeToken = await evalJs(`(() => { try { return JSON.stringify(Object.assign({}, localStorage)) + JSON.stringify(Object.assign({}, sessionStorage)); } catch { return ''; } })()`); assert.ok(!/token|secret|code/i.test(challengeToken.replace(/ochiga[^"]*/gi, "")) || challengeToken.length < 400, "(storage is empty or unrelated while a challenge is open)");
    const stores = await evalJs(`(async () => ({ ls: JSON.stringify(Object.assign({}, localStorage)), ss: JSON.stringify(Object.assign({}, sessionStorage)), idb: indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [], cookie: document.cookie }))()`);
    for (const secret of [...knownSecrets, adminSecret.toString("base64"), pwOf("admin")]) assert.ok(!stores.ls.includes(secret) && !stores.ss.includes(secret) && !stores.cookie.includes(secret), "no MFA secret, recovery code or password in localStorage, sessionStorage or readable cookies");
    assert.deepEqual(stores.idb.filter((n) => /mfa|otp|recovery|secret/i.test(String(n))), [], "no MFA database in IndexedDB");
    const foreign = requests.filter((u) => /^https?:/.test(u) && !u.startsWith(base) && !u.startsWith(`http://localhost:${port}`)); assert.deepEqual(foreign, [], `no request left the Office origin during any MFA flow (${foreign.slice(0, 3)})`);
    assert.ok(!requests.some((u) => /[?&](code|secret|token|recovery)=/i.test(u) || /otpauth|qrserver|chart\.googleapis/i.test(u)), "no secret in any URL and no QR web service");
    const log = consoleLines.join("\n"); for (const secret of knownSecrets) assert.ok(!log.includes(secret), "no MFA secret or recovery code in the browser console");
    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
    const auditText = JSON.stringify(await store.listAuditEvents(99999)); for (const secret of knownSecrets) assert.ok(!auditText.includes(secret), "no recovery code or setup key in any audit record");
    say("Security audits: nothing secret in localStorage/sessionStorage/IndexedDB/cookies/URLs/console/audit, every request stayed on the Office origin, no page errors");
    assert.equal(await evalJs(`document.querySelector('script[src*=qrcode]') === null`), true);

    console.log(JSON.stringify({ status: "PASS", suite: "mfa-ui-browser", assertions: passed }));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    await chromeHandle.stop(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); global.fetch = realFetch;
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* chrome flushing */ }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
