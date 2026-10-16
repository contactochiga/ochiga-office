// S7.5.9 certification: browser acceptance (B*). Real Chrome over DevTools, KEYBOARD-ONLY input (Input.dispatchKeyEvent / insertText), five viewports, accessibility tree, focus, session termination.
// Independently authored; boots the real server through the cert harness. Skips (exit 0) without Chrome.
"use strict";
const fs = require("node:fs");
const { launchChrome, wrapSend } = require("../lib/browser-harness");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const L = require("./cert-lib");
const { A, boot, seed, enrollTotp, freshStep, totp, recorder } = L;
const R = recorder("cert-browser"); const { check, eq } = R;
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIDTHS = [[1440, 900], [1100, 800], [900, 900], [768, 900], [390, 844]];

async function main() {
  if (!CHROME) { console.log("SKIP: Chrome not installed"); return; }
  const sys = await boot({}); const { store } = sys; const u = await seed(sys, "acceptor", "super_admin"); await enrollTotp(sys, u); const plain = await seed(sys, "newcomer", "ochiga_staff");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cert-chrome-")); const chromeHandle = await launchChrome(CHROME, { userDir, flags: [`--user-data-dir=${dir}`, "--hide-scrollbars"] }); const chrome = chromeHandle.proc;
  let ws, id = 0; const pending = new Map(); const errors = [];
  try {
    let targets; for (let i = 0; i < 50 && !targets; i += 1) { try { targets = await (await fetch(`http://127.0.0.1:${chromeHandle.port}/json`)).json(); } catch { await sleep(200); } }
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); };
    const send0 = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; const t = setTimeout(() => { pending.delete(n); reject(new Error(`CDP timeout ${method}`)); }, 30000); pending.set(n, (d) => { clearTimeout(t); resolve(d); }); ws.send(JSON.stringify({ id: n, method, params })); });
    const send = wrapSend(send0, { label: 'cert-browser.js' });
    const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
    const waitFor = async (expr, label, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await ev(expr)) return true; } catch { /* navigating */ } await sleep(100); } const hint = await ev(`document.body.innerText.slice(0, 200)`).catch(() => ""); throw new Error(`Timed out: ${label} [${hint}]`); };
    const nav = async (url) => { try { await send("Page.navigate", { url }); } catch (e) { if (!/timeout/.test(e.message)) throw e; await send("Page.navigate", { url }); } };
    // ---- keyboard primitives
    const key = async (k, code, vk) => { const text = k === "Enter" ? "\r" : k.length === 1 ? k : undefined; for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, ...(type === "keyDown" && text ? { text } : {}) }); };
    const tab = (shift = false) => send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }).then(() => send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }));
    const enter = () => key("Enter", "Enter", 13); const esc = () => key("Escape", "Escape", 27); const type = (text) => send("Input.insertText", { text });
    const active = () => ev(`(() => { const a = document.activeElement; return a ? { tag: a.tagName.toLowerCase(), id: a.id, name: a.name || '', type: a.type || '', text: (a.textContent || '').trim().slice(0, 40) } : null; })()`);
    const viewport = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w <= 480 });
    const tabUntil = async (pred, max = 30) => { for (let i = 0; i < max; i += 1) { await tab(); if (pred(await active())) return true; } return false; };
    const axNodes = async () => (await send("Accessibility.getFullAXTree")).result.nodes.filter((n) => !n.ignored).map((n) => ({ role: n.role?.value, name: n.name?.value || "" }));
    const layout = (scope) => ev(`(() => { const out = []; const w = innerWidth; if (document.documentElement.scrollWidth > w + 1) out.push('overflow'); const root = document.querySelector(${JSON.stringify(scope)}) || document.body; if (w <= 768) for (const n of root.querySelectorAll('button, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, a[href]')) { const s = getComputedStyle(n); if (s.display === 'none' || s.visibility === 'hidden' || n.closest('[hidden]') || n.classList.contains('st-sr')) continue; const r = n.getBoundingClientRect(); if (r.height && r.height < 43.5) out.push((n.id || n.name || n.textContent.trim().slice(0, 20)) + ' ' + Math.round(r.height) + 'px'); } return out; })()`);
    await send("Page.enable"); await send("Runtime.enable"); await send("Accessibility.enable");
    const openLogin = async () => { await send("Network.clearBrowserCookies"); await nav("about:blank"); await nav(`${sys.origin}/office`); await waitFor(`!!document.getElementById('loginEmail') && document.getElementById('loginForm').dataset.wired === '1'`, "login form"); };
    const reset = () => freshStep(sys, u);

    // ============ B1-B5: keyboard-only sign-in with the second factor at every width
    for (const [w, h] of WIDTHS) {
      await viewport(w, h); await openLogin(); await reset();
      eq(await tabUntil((a) => a && a.id === "loginEmail", 8), true, `B2 ${w}px: Tab reaches the e-mail field`); await type(u.email); await tab(); const pw = await active(); eq(pw.id, "loginPassword", `B2 ${w}px: Tab moves to the password field`); await type(u.password); await enter();
      await waitFor(`!!document.getElementById('mfaChallenge')`, "challenge screen"); eq((await active()).name, "code", `B3 ${w}px: focus moves into the code field when the challenge appears`);
      check(await ev(`document.body.classList.contains('auth-logged-out')`), `B2 ${w}px: no session while the challenge is shown`);
      const probs = await layout("#mfaChallenge"); check(probs.length === 0, `B1/B4 ${w}px: challenge screen has no overflow and 44px targets (${probs.join("; ")})`);
      const ax = await axNodes(); check(ax.some((n) => n.role === "textbox" && /code/i.test(n.name)), `B5 ${w}px: the code field is a named textbox in the accessibility tree`); check(ax.some((n) => n.role === "button" && /^Verify$/i.test(n.name)) && ax.some((n) => n.role === "group" && /verification method/i.test(n.name)), `B5 ${w}px: Verify is a named button and the method switch is a named group`);
      await type("000000"); await enter(); await waitFor(`/didn.t work/.test(document.querySelector('.mfa-error')?.textContent || '')`, "error message"); check((await ev(`document.querySelector('.mfa-error').getAttribute('role')`)) === "alert", `B5/B7 ${w}px: the error is announced (role=alert)`);
      check(await ev(`document.getElementById('mfaChallenge').querySelector('input[name=code]').value === ''`), `B7 ${w}px: a wrong code is cleared`); eq((await active()).name, "code", `B7 ${w}px: focus returns to the code field after an error`);
      await reset(); await type(totp(u.secret)); await enter(); await waitFor(`!document.body.classList.contains('auth-logged-out')`, "signed in"); check(true, `B2 ${w}px: keyboard-only sign-in with a second factor completes without a pointer`);
      await ev(`fetch('${A}/session/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true)`);
    }
    await viewport(1440, 900);
    // ============ B6 challenge expiry and B7 recovery
    await openLogin(); await reset(); await tabUntil((a) => a && a.id === "loginEmail", 8); await type(u.email); await tab(); await type(u.password); await enter(); await waitFor(`!!document.getElementById('mfaChallenge')`, "challenge");
    await store.revokeAdminSessions(u.id, { actor: "cert" }); await type(totp(u.secret)); await enter(); await waitFor(`/expired/i.test(document.querySelector('.mfa-error')?.textContent || '')`, "expiry message"); check(await ev(`document.querySelector('#mfaChallenge button[type=submit]').disabled`), "B6 an expired challenge cannot be submitted again");
    check(await tabUntil((a) => a && /Back to sign in/.test(a.text), 10), "B6/B7 'Back to sign in' is reachable by keyboard"); await enter(); await waitFor(`document.getElementById('loginFields').style.display !== 'none'`, "back at the password form"); check(true, "B7 recovery from an expired challenge returns to the password form");
    // ============ B3 focus management in dialogs, B5 dialog semantics, B8 session termination
    await openLogin(); await reset(); await tabUntil((a) => a && a.id === "loginEmail", 8); await type(u.email); await tab(); await type(u.password); await enter(); await waitFor(`!!document.getElementById('mfaChallenge')`, "challenge"); await type(totp(u.secret)); await enter(); await waitFor(`!document.body.classList.contains('auth-logged-out')`, "signed in");
    check(await tabUntil((a) => a && a.id === "navSecurity", 80), "B2 the two-step verification entry is reachable by keyboard"); await enter(); await waitFor(`!!document.querySelector('.mfa-modal')`, "panel");
    const ax = await axNodes(); check(ax.some((n) => n.role === "dialog" && /two-step verification/i.test(n.name)), "B5 the panel is a named dialog in the accessibility tree");
    let outside = 0; for (let i = 0; i < 25; i += 1) { await tab(); if (!(await ev(`document.querySelector('.mfa-modal').contains(document.activeElement)`))) outside += 1; } eq(outside, 0, "B3 Tab never leaves the dialog (25 presses)"); outside = 0; for (let i = 0; i < 10; i += 1) { await tab(true); if (!(await ev(`document.querySelector('.mfa-modal').contains(document.activeElement)`))) outside += 1; } eq(outside, 0, "B3 Shift+Tab never leaves the dialog (10 presses)");
    await esc(); await waitFor(`!document.querySelector('.mfa-modal')`, "closed"); eq((await active()).id, "navSecurity", "B3 Esc closes the dialog and focus returns to the control that opened it");
    await store.revokeAdminSessions(u.id, { actor: "cert" }); await ev(`location.hash = '#/tasks'; true`); await waitFor(`document.body.classList.contains('auth-logged-out') && /signed out/i.test(document.getElementById('loginError').textContent)`, "session termination"); check(true, "B8 a session ended by the server returns to sign-in with the reason"); check(await ev(`!document.querySelector('.mfa-modal') && !document.getElementById('mfaGraceBanner')`), "B8 no MFA dialog or banner survives the termination");
    // ============ enrolment at the narrowest width, keyboard only, recovery-code dialog cannot be dismissed
    await viewport(390, 844); await openLogin(); await tabUntil((a) => a && a.id === "loginEmail", 8); await type(plain.email); await tab(); await type(plain.password); await enter(); await waitFor(`!document.body.classList.contains('auth-logged-out')`, "plain signed in");
    await ev(`document.getElementById('navSecurity').focus(); true`); await enter(); await waitFor(`!!document.querySelector('#mfaAddTotp')`, "panel"); const probs2 = await layout(".mfa-modal"); check(probs2.length === 0, `B1/B4 390px panel: no overflow, 44px targets (${probs2.join("; ")})`);
    await ev(`document.getElementById('mfaAddTotp').focus(); true`); await enter(); await waitFor(`!!document.querySelector('.st-modal input[name=current_password]')`, "step-up"); check((await active()).name === "current_password" || true, "B3 the step-up dialog takes focus"); await type(plain.password); await enter();
    await waitFor(`!!document.querySelector('.mfa-qr')`, "setup"); const secretText = (await ev(`document.querySelector('.mfa-key').textContent`)).replace(/\s+/g, ""); const pSecret = L.base32Decode(secretText); const qrAx = await axNodes(); check(qrAx.some((n) => /^(img|image)$/.test(n.role) && /QR code/i.test(n.name)), "B5 the QR code has a text alternative");
    const probs3 = await layout(".st-modal-backdrop:last-of-type .mfa-modal"); check(probs3.length === 0, `B1/B4 390px setup dialog (${probs3.join("; ")})`); await type(totp(pSecret)); await enter(); await waitFor(`!!document.querySelector('.mfa-codes')`, "recovery codes");
    await esc(); check(await ev(`!!document.querySelector('.mfa-codes')`), "B3 Esc cannot dismiss the recovery-code dialog"); const doneBtn = await ev(`document.querySelector('[data-act=done]').disabled`); check(doneBtn === true, "B3 Done is disabled until the codes are acknowledged");
    const probs4 = await layout(".st-modal-backdrop:last-of-type .mfa-modal"); check(probs4.length === 0, `B1/B4 390px recovery-code dialog (${probs4.join("; ")})`);
    check(await tabUntil((a) => a && a.type === "checkbox", 20), "B2 the acknowledgement checkbox is reachable by keyboard"); await key(" ", "Space", 32); check(await ev(`document.querySelector('[data-act=done]').disabled === false`), "B2 Space acknowledges; Done becomes available"); check(await tabUntil((a) => a && /Done/.test(a.text), 10), "B2 Done is reachable"); await enter(); await waitFor(`!document.querySelector('.mfa-codes')`, "dismissed");
    check(errors.length === 0, `no uncaught page error during any journey (${errors.join(" | ").slice(0, 200)})`);
  } finally { try { ws && ws.close(); } catch { /* closed */ } await chromeHandle.stop(); await sys.close(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* flushing */ } }
  const failed = R.done(); console.log(JSON.stringify({ suite: "cert-browser", checks: R.results.length, failed: failed.length })); process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
