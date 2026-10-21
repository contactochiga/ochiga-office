"use strict";
// Reusable UI flows (everything goes through the real Office UI with real mouse/keyboard events).
const H = require("./harness.js");
const { UI, sleep } = H;

async function openNav(page) {
  await page.settle();
  for (let i = 0; i < 6; i += 1) {
    const state = await page.eval(`(() => { const e = document.getElementById('navLogout'); if (!e) return 'none'; const r = e.getBoundingClientRect(); return r.right > 0 && r.left < innerWidth && r.width > 0 ? 'on' : 'off'; })()`);
    if (state === "on" || state === "none") return;
    const open = await page.eval(`document.body.classList.contains('nav-open')`);
    if (!open) await page.click("#navToggle");
    try { await page.waitFor(`(() => { const r = document.getElementById('navLogout').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`, { timeout: 2500, what: "drawer slid in" }); return; } catch { /* the drawer may have been auto-closed by a route render: try again */ }
  }
  throw new Error("could not open the navigation drawer");
}
async function closeNav(page) {
  const open = await page.eval(`document.body.classList.contains('nav-open')`);
  if (open) { await page.eval(`document.getElementById('navScrim') && document.getElementById('navScrim').click()`); await page.waitFor(`!document.body.classList.contains('nav-open')`, { what: "drawer closed" }); }
}
/** Password step then TOTP step through the UI. Returns once the shell is visible. */
async function signInTotp(page, srv, acct, { keyboard = false } = {}) {
  await UI.openLogin(page, srv);
  await UI.submitPassword(page, acct.email, acct.password, { keyboard });
  await UI.waitChallenge(page);
  await page.waitFor(`document.querySelector('#mfaChallenge [data-panel=totp] input') && document.activeElement === document.querySelector('#mfaChallenge [data-panel=totp] input')`, { what: "focus in the code field" });
  const code = await acct.totp.next();
  if (keyboard) { await page.typeKeys(code); await page.press("Enter"); }
  else { await page.fill("#mfaChallenge [data-panel=totp] input", code); await page.click("#mfaChallenge [data-panel=totp] button[type=submit]"); }
  await UI.waitSignedIn(page);
  await page.waitFor(`document.getElementById('navUserName') && document.getElementById('navUserName').textContent.trim().length > 1`, { what: "profile loaded" });
}
async function signInPasswordOnly(page, srv, acct) {
  await UI.openLogin(page, srv); await UI.submitPassword(page, acct.email, acct.password); await UI.waitSignedIn(page);
}
async function logoutUi(page) {
  await openNav(page); await page.click("#navLogout");
  await page.waitFor(`document.body.classList.contains('auth-logged-out')`, { what: "back at sign-in after logout" });
}
async function openSecurityPanel(page) {
  await openNav(page); await page.waitFor(`!document.getElementById('navSecurity').hidden`, { what: "two-step entry visible" });
  await page.click("#navSecurity");
  await page.waitFor(`!!document.querySelector('.mfa-modal [role=status], .mfa-modal .mfa-facts, .mfa-modal .st-note')`, { what: "security panel content" });
  await page.waitFor(`!!document.querySelector('.mfa-modal .mfa-facts')`, { what: "security panel facts loaded" });
}
async function closeTopDialog(page) { await page.press("Escape"); }
const dialogOpen = (page) => page.eval(`[...document.querySelectorAll('[role=dialog]')].some((e) => e.getClientRects().length > 0)`);
const waitDialogClosed = (page) => page.waitFor(`![...document.querySelectorAll('[role=dialog]')].some((e) => e.getClientRects().length > 0)`, { what: "dialog closed" });
/** Fill and submit the shared step-up dialog (password + optional TOTP). */
async function stepUpDialog(page, password, code) {
  await page.waitFor(`!!document.querySelector('#stStepUpTitle')`, { what: "step-up dialog" });
  if (code !== undefined) await page.waitFor(`!!document.querySelector('.mfa-stepup input')`, { what: "second-factor field mounted" });
  await page.fill(`top:input[name=current_password]`, password);
  if (code !== undefined && code !== null) await page.fill(`.mfa-stepup input`, code);
  await page.click(`top:[data-act=ok]`);
}
async function dismissToasts(page) { await page.eval(`document.querySelectorAll('.toast, [class*=toast]').forEach(()=>{})`); }
/** Wait for server-side TOTP availability then return a code. */
const nextCode = (acct) => acct.totp.next();
/** Wait for the recovery-codes dialog; return the codes shown. */
async function readRecoveryDialog(page) {
  await page.waitFor(`!!document.querySelector('.mfa-codes li code')`, { what: "recovery codes shown" });
  return page.eval(`[...document.querySelectorAll('.mfa-codes li code')].map(c => c.textContent)`);
}
async function ackRecoveryDialog(page) {
  await page.click(`.mfa-ack input[type=checkbox]`);
  await page.waitFor(`!document.querySelector('[data-act=done]').disabled`, { what: "Done enabled after acknowledgement" });
  await page.click(`[data-act=done]`);
  await page.waitFor(`!document.querySelector('.mfa-codes')`, { what: "recovery dialog closed" });
}

module.exports = { openNav, closeNav, signInTotp, signInPasswordOnly, logoutUi, openSecurityPanel, closeTopDialog, dialogOpen, waitDialogClosed, stepUpDialog, nextCode, readRecoveryDialog, ackRecoveryDialog, sleep };
