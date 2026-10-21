"use strict";
// D1: password-first sign-in, wrong password, authenticator-code challenge, wrong code, recovery code, reload behaviour and logout,
// driven through the real Office UI at 1440 / 1100 / 900 / 768 / 390 px.
const H = require("./lib/harness.js");
const F = require("./lib/flows.js");
const { UI } = H;

H.runSuite("d1-signin-widths", async (s) => {
  const srv = await H.startServer(s);
  const adminCk = await H.adminCookie(srv);
  const chrome = await H.launchChrome(s);
  const plain = await H.freshAccount(srv, adminCk, { enroll: false, tag: "plain" });
  const inactive = await H.freshAccount(srv, adminCk, { enroll: false, tag: "gone" });
  s.check("D1 fixture: the account was deactivated by an administrator", (await H.setStatus(srv, adminCk, inactive.id, "inactive")).status === 200);

  for (const w of H.WIDTHS) {
    await s.guard(`w${w}`, async () => {
      const acct = await H.freshAccount(srv, adminCk, { tag: `e${w}` });
      const page = await H.newPage(chrome, { origin: srv.origin });
      const L = `[${w}px]`;
      await page.viewport(w);

      // ---------- the sign-in screen
      await UI.openLogin(page, srv);
      let la = await H.layoutAudit(page, { scope: "#loginScreen" });
      s.check(`${L} sign-in screen has no horizontal overflow`, !H.hasHScroll(la), la);
      if (w <= 768) s.check(`${L} sign-in controls are at least 44px tall/wide`, la.small.length === 0, la.small);
      s.check(`${L} sign-in controls stay inside the viewport`, la.overflowing.length === 0, la.overflowing);
      let ax = await page.axTree();
      s.check(`${L} email field exposes role textbox named "Email"`, H.axFind(ax, "textbox", /^email$/i).length >= 1, ax.filter((n) => n.role === "textbox").map((n) => n.name));
      s.check(`${L} password field is exposed with name "Password"`, ax.some((n) => n.role === "textbox" && /^password$/i.test(n.name)), ax.map((n) => `${n.role}:${n.name}`).slice(0, 30));
      s.check(`${L} sign-in button is exposed as a button named "Sign in"`, H.axFind(ax, "button", /^Sign in$/).length === 1);
      s.check(`${L} the error region is declared as an alert (live) container before any error`, await page.eval(`document.getElementById('loginError').getAttribute('role') === 'alert'`));
      s.check(`${L} password field is of type password (masked)`, await page.eval(`document.getElementById('loginPassword').type === 'password'`));
      s.check(`${L} no session cookie before any sign-in`, !(await UI.sessionCookiePresent(page)));

      // ---------- wrong password (negative control) and unknown account (enumeration at the UI level)
      await UI.submitPassword(page, acct.email, "definitely-not-the-password-1!");
      await UI.waitLoginError(page, /incorrect/i);
      const wrongText = (await UI.loginError(page)).trim();
      ax = await page.axTree();
      s.check(`${L} the visible wrong-password error is present in the accessibility tree as an alert with text`, ax.some((n) => n.role === "alert" && /incorrect/i.test(n.name + " " + (n.description || ""))) || (await page.eval(`(() => { const e = document.getElementById('loginError'); return e.getAttribute('role') === 'alert' && /incorrect/i.test(e.textContent) && !e.hidden && e.getClientRects().length > 0; })()`)) && ax.some((n) => n.role === "alert"), ax.filter((n) => n.role === "alert"));
      s.check(`${L} wrong password shows an error that is announced (role alert, visible)`, await page.eval(`(() => { const e = document.getElementById('loginError'); return e.getAttribute('role') === 'alert' && e.classList.contains('visible') && e.getClientRects().length > 0; })()`));
      s.check(`${L} wrong password keeps the user on the sign-in screen`, await page.eval(`document.body.classList.contains('auth-logged-out')`));
      s.check(`${L} wrong password creates no session cookie`, !(await UI.sessionCookiePresent(page)));
      s.check(`${L} wrong password does not show a second-factor challenge (no oracle that the password was close)`, !(await page.eval(`!!document.getElementById('mfaChallenge')`)));
      s.check(`${L} the URL carries no credentials after a failed attempt`, !(await page.eval("location.href")).match(/password|email|@/i), await page.eval("location.href"));
      await UI.submitPassword(page, `nobody-${H.rand(3)}@example.test`, "definitely-not-the-password-1!");
      await page.waitFor(`/incorrect/i.test(document.getElementById('loginError').textContent) && document.getElementById('loginSubmit').disabled === false`, { what: "second error shown" });
      s.check(`${L} unknown account gets exactly the same words as a wrong password (no enumeration)`, (await UI.loginError(page)).trim() === wrongText, [wrongText, await UI.loginError(page)]);

      // ---------- an unenrolled account: password alone signs in (positive control for the password step)
      if (w === 1440 || w === 390) {
        const p2 = await H.newPage(chrome, { origin: srv.origin }); await p2.viewport(w);
        await F.signInPasswordOnly(p2, srv, plain);
        s.check(`${L} an account without a second factor signs in with its password (positive control)`, await UI.signedIn(p2));
        s.check(`${L} the session cookie exists and is HttpOnly`, (await p2.sessionCookie()) && (await p2.sessionCookie()).httpOnly === true);
        s.check(`${L} two-step verification entry is offered to the signed-in person`, await p2.eval(`!document.getElementById('navSecurity').hidden`));
        await p2.close();
        const p3 = await H.newPage(chrome, { origin: srv.origin }); await p3.viewport(w);
        await UI.openLogin(p3, srv); await UI.submitPassword(p3, inactive.email, inactive.password);
        await UI.waitLoginError(p3, /incorrect/i);
        s.check(`${L} a deactivated account cannot sign in and gets the generic message`, (await UI.loginError(p3)).trim() === wrongText && !(await UI.sessionCookiePresent(p3)));
        await p3.close();
      }

      // ---------- the enrolled account: challenge has no authority; reload fails safe
      await UI.submitPassword(page, acct.email, acct.password);
      await UI.waitChallenge(page);
      s.check(`${L} correct password for an enrolled account shows the second-factor challenge`, true);
      s.check(`${L} no session cookie exists while the challenge is pending`, !(await UI.sessionCookiePresent(page)));
      s.check(`${L} the application shell is not visible while the challenge is pending`, await page.eval(`document.body.classList.contains('auth-logged-out')`));
      s.check(`${L} the password field was cleared once the password was accepted`, (await page.eval(`document.getElementById('loginPassword').value`)) === "");
      s.check(`${L} protected API refuses the page while challenged`, (await page.eval(`fetch('/api/lead-agents/admin/session/me').then(r => r.status)`)) === 401);
      s.check(`${L} challenge title is announced to the person`, /Two-step verification/.test(await page.text("#authCardTitle")));
      s.check(`${L} focus is inside the code field after the challenge appears`, await page.eval(`document.activeElement === document.querySelector('#mfaChallenge [data-panel=totp] input')`), await page.active());
      s.check(`${L} the code field is numeric and one-time-code`, await page.eval(`(() => { const i = document.querySelector('#mfaChallenge [data-panel=totp] input'); return i.inputMode === 'numeric' && i.autocomplete === 'one-time-code'; })()`));
      la = await H.layoutAudit(page, { scope: "#loginScreen" });
      s.check(`${L} challenge screen has no horizontal overflow`, !H.hasHScroll(la), la);
      if (w <= 768) s.check(`${L} challenge controls are at least 44px`, la.small.length === 0, la.small);
      ax = await page.axTree();
      s.check(`${L} challenge: the code field has an accessible name`, H.axFind(ax, "textbox", /6-digit code/).length >= 1, ax.filter((n) => n.role === "textbox").map((n) => n.name));
      s.check(`${L} challenge: method buttons are labelled and expose pressed state`, ax.filter((n) => n.role === "button" && /Authenticator app|Recovery code/.test(n.name) && n.props.pressed !== undefined).length === 2, ax.filter((n) => n.role === "button").map((n) => `${n.name}:${JSON.stringify(n.props)}`));
      s.check(`${L} challenge: the method group is labelled`, ax.some((n) => n.role === "group" && /Verification method/.test(n.name)));
      s.check(`${L} challenge: an alert region and a polite status region are declared`, await page.eval(`!!document.querySelector('#mfaChallenge .mfa-error[role=alert]') && !!document.querySelector('#mfaChallenge .mfa-status[role=status][aria-live=polite]')`));

      // reload while challenged: must be back at plain sign-in, still without authority
      await page.reload(); await page.waitFor(`document.getElementById('loginForm').dataset.wired === '1'`);
      s.check(`${L} reload during the challenge returns to the sign-in screen`, await page.eval(`document.body.classList.contains('auth-logged-out') && !document.getElementById('mfaChallenge')`));
      s.check(`${L} reload during the challenge leaves no session`, !(await UI.sessionCookiePresent(page)));
      await UI.submitPassword(page, acct.email, acct.password);
      await UI.waitChallenge(page);

      // ---------- wrong code
      await page.fill("#mfaChallenge [data-panel=totp] input", acct.totp.wrong());
      await page.click("#mfaChallenge [data-panel=totp] button[type=submit]");
      await page.waitFor(`document.querySelector('#mfaChallenge .mfa-error').textContent.trim().length > 0`, { what: "wrong-code error" });
      const wrongCodeMsg = await page.text("#mfaChallenge .mfa-error");
      s.check(`${L} wrong code: an error is shown in the alert region`, await page.eval(`(() => { const e = document.querySelector('#mfaChallenge .mfa-error'); return e.getAttribute('role') === 'alert' && e.classList.contains('visible'); })()`), wrongCodeMsg);
      s.check(`${L} wrong code: still no session cookie and no shell`, !(await UI.sessionCookiePresent(page)) && (await page.eval(`document.body.classList.contains('auth-logged-out')`)));
      s.check(`${L} wrong code: the field is emptied and focused for a retry`, await page.eval(`(() => { const i = document.querySelector('#mfaChallenge [data-panel=totp] input'); return i.value === '' && document.activeElement === i; })()`));
      s.check(`${L} wrong code: the message does not reveal the expected code or account state`, !/[0-9]{6}/.test(wrongCodeMsg) && !/locked|expired/i.test(wrongCodeMsg), wrongCodeMsg);
      // an out-of-window (stale) code is also refused
      await page.fill("#mfaChallenge [data-panel=totp] input", acct.totp.stale());
      await page.click("#mfaChallenge [data-panel=totp] button[type=submit]");
      await page.waitFor(`document.querySelector('#mfaChallenge .mfa-error').classList.contains('visible') && document.querySelector('#mfaChallenge button[type=submit]').disabled === false`, { what: "stale-code error" });
      s.check(`${L} a stale (out-of-window) code is refused and grants nothing`, !(await UI.sessionCookiePresent(page)) && (await page.eval(`document.body.classList.contains('auth-logged-out')`)));
      // empty submission is refused locally with an instruction
      await page.click("#mfaChallenge [data-panel=totp] button[type=submit]");
      await page.waitFor(`/Enter the 6-digit code/.test(document.querySelector('#mfaChallenge .mfa-error').textContent)`, { what: "empty-code instruction" });
      s.check(`${L} an empty code is refused with an instruction, no request needed`, true);

      // ---------- correct code (positive control) and the signed-in state
      const code = await acct.totp.next();
      await page.fill("#mfaChallenge [data-panel=totp] input", code);
      await page.click("#mfaChallenge [data-panel=totp] button[type=submit]");
      await UI.waitSignedIn(page);
      await page.waitFor(`document.getElementById('navUserName').textContent.trim().length > 1`);
      s.check(`${L} the correct code signs the person in and shows the shell`, await UI.signedIn(page));
      const sc = await page.sessionCookie();
      s.check(`${L} the session cookie is set, HttpOnly and SameSite`, !!sc && sc.httpOnly === true && /Lax|Strict/.test(sc.sameSite || ""), sc && { httpOnly: sc.httpOnly, sameSite: sc.sameSite });
      s.check(`${L} the challenge UI is gone from the DOM after sign-in`, !(await page.eval(`!!document.getElementById('mfaChallenge')`)));
      s.check(`${L} the code that was typed is gone from every input`, await page.eval(`[...document.querySelectorAll('input')].every(i => i.type === 'checkbox' || i.type === 'radio' || i.type === 'file' || !/^[0-9]{6}$/.test(i.value))`));
      s.check(`${L} the server confirms the session (/session/me 200)`, (await page.eval(`fetch('/api/lead-agents/admin/session/me').then(r => r.status)`)) === 200);
      s.check(`${L} the signed-in person is shown in the shell`, (await page.text("#navUserName")).toLowerCase().includes(acct.email.split("@")[0].slice(0, 4)) || (await page.text("#navUserName")).length > 1, await page.text("#navUserName"));
      la = await H.layoutAudit(page, { scope: "body", ignore: "#navAvatarInput" });
      s.check(`${L} the signed-in shell has no horizontal overflow`, !H.hasHScroll(la), la);

      if (w <= 768) {
        await F.openNav(page);
        await page.waitFor(`(() => { const b = document.getElementById('navLogout').getBoundingClientRect(); return b.left >= 0; })()`);
        const nf = await H.layoutAudit(page, { scope: "#navFooter", ignore: "#navAvatarInput" });
        s.check(`${L} account controls in the drawer (Sign out, Two-step verification, Edit profile) are at least 44px`, nf.small.length === 0, nf.small);
        await F.closeNav(page);
      }

      // ---------- code replay: the same code cannot start a second sign-in (single use)
      const replay = await H.apiLogin(srv, acct.email, acct.password);
      const rv = await H.http(srv, "POST", `${H.SESSION}/mfa/verify`, { body: { challenge_token: replay.json.challenge_token, method: "totp", code } });
      s.check(`${L} the just-used authenticator code is refused when replayed`, rv.status === 401 && !rv.cookie, { status: rv.status });

      // ---------- reload keeps the session
      await page.reload(); await page.waitFor(`document.getElementById('navUserName') && document.getElementById('navUserName').textContent.trim().length > 1`, { what: "session survives reload" });
      s.check(`${L} reload keeps the signed-in session`, await UI.signedIn(page));

      // ---------- logout via the UI; a copied cookie must be dead afterwards
      const copied = await page.sessionCookie();
      await F.logoutUi(page);
      s.check(`${L} Sign out returns to the sign-in screen`, await page.eval(`document.body.classList.contains('auth-logged-out')`));
      s.check(`${L} Sign out clears the session cookie in the browser`, !(await UI.sessionCookiePresent(page)));
      await page.setCookie(copied.name, copied.value, srv.origin);
      s.check(`${L} a copy of the pre-logout cookie is refused by the UI's own API`, (await page.eval(`fetch('/api/lead-agents/admin/session/me').then(r => r.status)`)) === 401);
      await page.reload(); await page.waitFor(`document.getElementById('loginForm').dataset.wired === '1'`);
      await page.waitFor(`document.body.classList.contains('auth-logged-out')`, { what: "copied cookie leaves the UI signed out" });
      s.check(`${L} reloading with the copied cookie still shows the sign-in screen`, true);
      await page.clearCookies();
      await H.privacyAudit(s, page, srv, L, [acct.password, acct.totp.b32, code, copied.value]);
      await page.close();
    });
  }
  // the previous cookie / token never needs to be re-used: nothing else to do
});
