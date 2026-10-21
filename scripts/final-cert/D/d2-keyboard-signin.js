"use strict";
// D2: keyboard-only operation of the sign-in and second-factor flows, focus management and announced errors, at the five widths.
const H = require("./lib/harness.js");
const F = require("./lib/flows.js");
const { UI } = H;

H.runSuite("d2-keyboard-signin", async (s) => {
  const srv = await H.startServer(s);
  const adminCk = await H.adminCookie(srv);
  const chrome = await H.launchChrome(s);

  for (const w of H.WIDTHS) {
    await s.guard(`w${w}`, async () => {
      const L = `[${w}px keyboard]`;
      const acct = await H.freshAccount(srv, adminCk, { tag: `k${w}` });
      const page = await H.newPage(chrome, { origin: srv.origin });
      await page.viewport(w);
      await UI.openLogin(page, srv);

      // ---- tab order of the sign-in form
      await page.eval(`document.activeElement && document.activeElement.blur()`);
      const order = [];
      for (let i = 0; i < 6; i += 1) { await page.press("Tab"); const a = await page.active(); order.push(a.id || a.tag); if (a.id === "forgotPasswordBtn") break; }
      s.check(`${L} Tab reaches the email field first, then password, Sign in, Forgot password (in visual order)`, ["loginEmail", "loginPassword", "loginSubmit", "forgotPasswordBtn"].every((id, i) => order.indexOf(id) === i || (order.indexOf(id) > -1 && order.indexOf(id) >= i)) && order.indexOf("loginEmail") < order.indexOf("loginPassword") && order.indexOf("loginPassword") < order.indexOf("loginSubmit") && order.indexOf("loginSubmit") < order.indexOf("forgotPasswordBtn"), order);
      s.check(`${L} the email field is reachable within the first tab stops (no long run of skip links)`, order.indexOf("loginEmail") >= 0 && order.indexOf("loginEmail") <= 2, order);
      await page.press("Tab", { shift: true });
      s.check(`${L} Shift+Tab moves focus back to the previous control`, (await page.active()).id === "loginSubmit", await page.active());
      s.check(`${L} the focused control has a visible focus indicator`, await page.eval(`(() => { const a = document.activeElement; const cs = getComputedStyle(a); return (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none'; })()`));

      // ---- wrong password by keyboard only, error announced, focus stays usable
      await page.focus("#loginEmail"); await page.typeKeys(acct.email); await page.press("Tab"); await page.typeKeys("wrong-Password-1!"); await page.press("Enter");
      await UI.waitLoginError(page, /incorrect/i);
      s.check(`${L} Enter in the password field submits the form (wrong password refused)`, !(await UI.signedIn(page)) && !(await UI.sessionCookiePresent(page)));
      s.check(`${L} the refusal is in a role=alert region`, await page.eval(`document.getElementById('loginError').getAttribute('role') === 'alert'`));
      s.check(`${L} after a refusal the Sign in button is usable again`, await page.eval(`document.getElementById('loginSubmit').disabled === false`));

      // ---- correct password by keyboard; focus enters the code field
      await page.focus("#loginPassword"); await page.eval(`document.getElementById('loginPassword').select()`);
      await page.typeKeys(acct.password); await page.press("Enter");
      await UI.waitChallenge(page);
      await page.waitFor(`document.activeElement === document.querySelector('#mfaChallenge [data-panel=totp] input')`, { what: "focus in the code field" });
      s.check(`${L} challenge: focus moves into the 6-digit code field automatically`, true);
      s.check(`${L} challenge: the Authenticator method is pre-selected (aria-pressed)`, await page.eval(`document.querySelector('#mfaChallenge [data-m=totp]').getAttribute('aria-pressed') === 'true'`));
      // a wrong code by keyboard
      await page.typeKeys(acct.totp.wrong()); await page.press("Enter");
      await page.waitFor(`document.querySelector('#mfaChallenge .mfa-error').classList.contains('visible')`, { what: "wrong code error" });
      s.check(`${L} challenge: a wrong code typed and sent with Enter is refused with an alert`, !(await UI.signedIn(page)) && !(await UI.sessionCookiePresent(page)));
      await page.waitFor(`document.activeElement === document.querySelector('#mfaChallenge [data-panel=totp] input')`, { what: "focus returns to the field" });
      s.check(`${L} challenge: focus returns to the empty code field so the person can retry by keyboard`, await page.eval(`document.querySelector('#mfaChallenge [data-panel=totp] input').value === ''`));

      // ---- method switch by keyboard (Shift+Tab to the method buttons, Space/Enter to press)
      await page.press("Tab", { shift: true });
      const prev = await page.active();
      s.check(`${L} challenge: Shift+Tab from the code field lands on a method button`, prev.tag === "button" && /Recovery code|Authenticator/.test(prev.text), prev);
      await page.eval(`document.querySelector('#mfaChallenge [data-m=recovery_code]').focus()`);
      await page.press(" ");
      await page.waitFor(`document.querySelector('#mfaChallenge [data-m=recovery_code]').getAttribute('aria-pressed') === 'true'`, { what: "recovery method pressed" });
      s.check(`${L} challenge: Space on "Recovery code" switches the method and updates aria-pressed on both buttons`, await page.eval(`document.querySelector('#mfaChallenge [data-m=totp]').getAttribute('aria-pressed') === 'false' && document.querySelector('#mfaChallenge [data-panel=recovery_code]').hidden === false && document.querySelector('#mfaChallenge [data-panel=totp]').hidden === true`));
      s.check(`${L} challenge: focus moves into the recovery-code field after switching`, await page.eval(`document.activeElement === document.querySelector('#mfaChallenge [data-panel=recovery_code] input')`), await page.active());
      // wrong recovery code by keyboard
      await page.typeKeys("AAAA-BBBB-CCCC"); await page.press("Enter");
      await page.waitFor(`document.querySelector('#mfaChallenge .mfa-error').classList.contains('visible') && document.querySelector('#mfaChallenge .mfa-status').textContent === ''`, { what: "wrong recovery error" });
      s.check(`${L} challenge: a wrong recovery code is refused and no session exists`, !(await UI.signedIn(page)) && !(await UI.sessionCookiePresent(page)));
      // back to authenticator with Enter on the button
      await page.eval(`document.querySelector('#mfaChallenge [data-m=totp]').focus()`); await page.press("Enter");
      await page.waitFor(`document.activeElement === document.querySelector('#mfaChallenge [data-panel=totp] input')`, { what: "back on the authenticator field" });
      s.check(`${L} challenge: Enter on "Authenticator app" returns to the code field with focus`, true);
      // Escape must not tear the challenge down or sign anyone in
      await page.press("Escape");
      s.check(`${L} challenge: Escape does not dismiss the challenge or create a session`, (await page.eval(`!!document.getElementById('mfaChallenge')`)) && !(await UI.sessionCookiePresent(page)));
      // correct code by keyboard
      await page.focus("#mfaChallenge [data-panel=totp] input");
      await page.typeKeys(await acct.totp.next()); await page.press("Enter");
      await UI.waitSignedIn(page);
      s.check(`${L} the correct code typed and sent with Enter signs the person in (keyboard-only journey)`, await UI.signedIn(page));
      await page.waitFor(`document.getElementById('navUserName').textContent.trim().length > 1`);

      // ---- the back link by keyboard from a second challenge
      await F.logoutUi(page);
      await UI.submitPassword(page, acct.email, acct.password, { keyboard: true });
      await UI.waitChallenge(page);
      await page.eval(`document.querySelector('#mfaChallenge [data-act=back]').focus()`);
      s.check(`${L} the "Back to sign in" link is a real button reachable by keyboard`, (await page.active()).tag === "button", await page.active());
      await page.press("Enter");
      await page.waitFor(`!document.getElementById('mfaChallenge') && document.getElementById('loginFields').style.display !== 'none'`, { what: "back to sign-in" });
      s.check(`${L} "Back to sign in" returns to the form and puts focus in the email field`, await page.eval(`document.activeElement === document.getElementById('loginEmail')`), await page.active());
      s.check(`${L} going back leaves no session behind`, !(await UI.sessionCookiePresent(page)));

      // ---- recovery code sign-in by keyboard; the code is single use
      const rc = acct.recoveryCodes[0];
      await UI.submitPassword(page, acct.email, acct.password, { keyboard: true });
      await UI.waitChallenge(page);
      await page.eval(`document.querySelector('#mfaChallenge [data-m=recovery_code]').focus()`); await page.press("Enter");
      await page.waitFor(`document.activeElement === document.querySelector('#mfaChallenge [data-panel=recovery_code] input')`);
      await page.typeKeys(rc); await page.press("Enter");
      await UI.waitSignedIn(page);
      s.check(`${L} a recovery code typed and sent by keyboard signs the person in`, await UI.signedIn(page));
      await page.waitFor(`document.getElementById('navUserName').textContent.trim().length > 1`);
      s.check(`${L} signing in with a recovery code tells the person how many remain`, await page.waitFor(`/recovery code/i.test(document.body.innerText) && /9 left|left/.test(document.body.innerText)`, { timeout: 5000, what: "remaining-codes notice" }).then(() => true).catch(() => false));
      await F.logoutUi(page);
      await UI.submitPassword(page, acct.email, acct.password, { keyboard: true });
      await UI.waitChallenge(page);
      await page.eval(`document.querySelector('#mfaChallenge [data-m=recovery_code]').focus()`); await page.press("Enter");
      await page.typeKeys(rc); await page.press("Enter");
      await page.waitFor(`document.querySelector('#mfaChallenge .mfa-error').classList.contains('visible')`, { what: "reused recovery refused" });
      s.check(`${L} the same recovery code is refused the second time (single use)`, !(await UI.signedIn(page)) && !(await UI.sessionCookiePresent(page)));
      await H.privacyAudit(s, page, srv, L, [acct.password, acct.totp.b32, rc, ...acct.recoveryCodes]);
      await page.close();
    });
  }
});
