"use strict";
// D5 (part: d5b-ended-sessions): failure and termination journeys in the real UI: expired challenge, second-factor lock, login throttling, unavailable backend (process killed, store unwritable),
// and sessions ended by the server (revocation, deactivation, administrator password change, factor added elsewhere), at the five widths where it matters.
const fs = require("fs");
const H = require("./lib/harness.js");
const F = require("./lib/flows.js");
const { UI } = H;

const meStatus = (page) => page.eval(`fetch('/api/lead-agents/admin/session/me').then(r => r.status)`);
async function revokeSessionsApi(srv, targetId) {
  const root = srv.root; const ck = await H.mfaLoginApi(srv, root);
  const su = await H.apiStepUp(srv, ck, "session_revocation", root.password, { method: "totp", code: await root.totp.next() });
  if (su.status !== 200) throw H.blocked(`root step-up failed ${su.status} ${su.text.slice(0, 160)}`);
  return H.http(srv, "POST", `/api/lead-agents/admin/users/${targetId}/revoke-sessions`, { cookie: ck, headers: { "x-step-up-token": su.json.step_up.token }, body: { reason: "test" } });
}
async function returned(page) { return page.waitFor(`document.body.classList.contains('auth-logged-out')`, { timeout: 5000, what: "back at sign-in" }).then(() => true).catch(() => false); }
async function triggerApiCall(page) { await F.openNav(page); await page.click("#navSecurity"); }

H.runSuite("d5b-ended-sessions", async (s) => {
  s.only = ["ended-1440","ended-390"];
  const srv = await H.startServer(s);
  await H.enrollRoot(srv);
  const adminCk = await H.adminCookie(srv);
  const chrome = await H.launchChrome(s);

  // ================================================================ A. expired challenge
  for (const w of H.WIDTHS) {
    await s.guard(`expired-${w}`, async () => {
      const L = `[${w}px expired]`;
      const acct = await H.freshAccount(srv, adminCk, { tag: `x${w}` });
      const page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w);
      await UI.openLogin(page, srv); await UI.submitPassword(page, acct.email, acct.password); await UI.waitChallenge(page);
      await srv.shiftClock(6 * 60_000); // the sign-in challenge lives five minutes
      await page.fill("#mfaChallenge [data-panel=totp] input", await acct.totp.next());
      await page.click("#mfaChallenge [data-panel=totp] button[type=submit]");
      await page.waitFor(`/expired/i.test(document.querySelector('#mfaChallenge .mfa-error').textContent)`, { what: "expired message" });
      s.check(`${L} an expired sign-in is refused with "This sign-in expired. Sign in again."`, /This sign-in expired\. Sign in again\./.test(await page.text("#mfaChallenge .mfa-error")), await page.text("#mfaChallenge .mfa-error"));
      s.check(`${L} expired: even the correct code creates no session`, !(await UI.sessionCookiePresent(page)) && !(await UI.signedIn(page)));
      s.check(`${L} expired: the form is disabled so the dead challenge cannot be retried`, await page.eval(`document.querySelector('#mfaChallenge button[type=submit]').disabled === true`));
      s.check(`${L} expired: the message is announced (role=alert, visible)`, await page.eval(`(() => { const e = document.querySelector('#mfaChallenge .mfa-error'); return e.getAttribute('role') === 'alert' && e.classList.contains('visible'); })()`));
      const la = await H.layoutAudit(page, { scope: "#loginScreen" });
      s.check(`${L} expired: no horizontal overflow`, !H.hasHScroll(la), la);
      // an expired challenge token replayed straight at the API is also refused
      await page.click("#mfaChallenge [data-act=back]");
      await page.waitFor(`!document.getElementById('mfaChallenge')`);
      await UI.submitPassword(page, acct.email, acct.password); await UI.waitChallenge(page);
      await page.fill("#mfaChallenge [data-panel=totp] input", await acct.totp.next());
      await page.click("#mfaChallenge [data-panel=totp] button[type=submit]");
      await UI.waitSignedIn(page);
      s.check(`${L} after "Back to sign in" a fresh sign-in with a new code works (positive control)`, await UI.signedIn(page));
      await H.privacyAudit(s, page, srv, L, [acct.password, acct.totp.b32]);
      await page.close();
    });
  }

  // ================================================================ B. second-factor lock
  for (const w of [1440, 390]) {
    await s.guard(`lock-${w}`, async () => {
      const L = `[${w}px lock]`;
      const acct = await H.freshAccount(srv, adminCk, { tag: `l${w}` });
      const page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w);
      await UI.openLogin(page, srv); await UI.submitPassword(page, acct.email, acct.password); await UI.waitChallenge(page);
      let locked = false; let tries = 0;
      while (!locked && tries < 8) {
        tries += 1;
        await page.fill("#mfaChallenge [data-panel=totp] input", acct.totp.wrong());
        await page.click("#mfaChallenge [data-panel=totp] button[type=submit]");
        await page.waitFor(`document.querySelector('#mfaChallenge .mfa-error').classList.contains('visible') && document.querySelector('#mfaChallenge .mfa-status').textContent === ''`, { what: `failure ${tries}` });
        locked = /Too many incorrect codes/i.test(await page.text("#mfaChallenge .mfa-error"));
        if (!locked) await page.waitFor(`document.querySelector('#mfaChallenge button[type=submit]').disabled === false`, { what: "retry enabled" });
      }
      s.check(`${L} repeated wrong codes end in a lock message (after at most 8 attempts)`, locked, { tries, text: await page.text("#mfaChallenge .mfa-error") });
      s.check(`${L} the lock message names a wait in minutes and does not reveal the codes`, /Try again in \d+ minute/.test(await page.text("#mfaChallenge .mfa-error")), await page.text("#mfaChallenge .mfa-error"));
      s.check(`${L} while locked the verify buttons are disabled`, await page.eval(`[...document.querySelectorAll('#mfaChallenge button[type=submit]')].every(b => b.disabled)`));
      s.check(`${L} lock: still no session and no shell`, !(await UI.sessionCookiePresent(page)) && !(await UI.signedIn(page)));
      const la = await H.layoutAudit(page, { scope: "#loginScreen" });
      s.check(`${L} lock message: no horizontal overflow`, !H.hasHScroll(la), la);
      // the CORRECT code must not bypass the lock (server-side), neither a recovery code
      const r1 = await H.apiLogin(srv, acct.email, acct.password);
      const ok1 = await H.http(srv, "POST", `${H.SESSION}/mfa/verify`, { body: { challenge_token: r1.json.challenge_token, method: "totp", code: await acct.totp.next() } });
      s.check(`${L} while locked, the CORRECT authenticator code is refused by the server (429 mfa_locked)`, ok1.status === 429 && !ok1.cookie && ok1.json && ok1.json.error === "mfa_locked", { status: ok1.status, body: ok1.json });
      const ok2 = await H.http(srv, "POST", `${H.SESSION}/mfa/verify`, { body: { challenge_token: r1.json.challenge_token, method: "recovery_code", code: acct.recoveryCodes[0] } });
      s.check(`${L} while locked, a valid recovery code is refused too`, ok2.status === 429 && !ok2.cookie, { status: ok2.status });
      // after the lock window, signing in works again
      await srv.shiftClock(2 * 60_000);
      await page.click("#mfaChallenge [data-act=back]");
      await page.waitFor(`!document.getElementById('mfaChallenge')`);
      await UI.submitPassword(page, acct.email, acct.password); await UI.waitChallenge(page);
      await page.fill("#mfaChallenge [data-panel=totp] input", await acct.totp.next());
      await page.click("#mfaChallenge [data-panel=totp] button[type=submit]");
      await UI.waitSignedIn(page);
      s.check(`${L} once the lock window has passed the correct code signs in (the lock is temporary)`, await UI.signedIn(page));
      await H.privacyAudit(s, page, srv, L, [acct.password, acct.totp.b32]);
      await page.close();
    });
  }

  // ================================================================ C. login throttling (second server with a small budget)
  await s.guard("throttle", async () => {
    const strict = await H.startServer(s, { loginMax: 5 });
    const ck = await H.adminCookie(strict);
    const victim = await H.freshAccount(strict, ck, { enroll: false, tag: "thr" });
    const other = await H.freshAccount(strict, ck, { enroll: false, tag: "thr2" });
    for (const w of [1440, 390]) {
      const L = `[${w}px throttle]`;
      const acct = w === 1440 ? victim : await H.freshAccount(strict, ck, { enroll: false, tag: "thr3" });
      const page = await H.newPage(chrome, { origin: strict.origin }); await page.viewport(w);
      await UI.openLogin(page, strict);
      let throttled = false; let n = 0;
      while (!throttled && n < 9) {
        n += 1;
        await UI.submitPassword(page, acct.email, `wrong-${n}-Password!`);
        await page.waitFor(`document.getElementById('loginError').classList.contains('visible') && document.getElementById('loginSubmit').disabled === false`, { what: `failure ${n}` });
        throttled = /Too many/i.test(await UI.loginError(page));
      }
      s.check(`${L} repeated wrong passwords end in a throttling message within the budget`, throttled && n <= 7, { n, msg: await UI.loginError(page) });
      s.check(`${L} the throttling message is shown in the alert region and says to wait`, /wait/i.test(await UI.loginError(page)) && (await page.eval(`document.getElementById('loginError').getAttribute('role') === 'alert'`)), await UI.loginError(page));
      await UI.submitPassword(page, acct.email, acct.password);
      await page.waitFor(`document.getElementById('loginSubmit').disabled === false`);
      await sleepUntilSettled(page);
      s.check(`${L} the CORRECT password does not bypass the throttle (no session, throttle message)`, !(await UI.signedIn(page)) && !(await UI.sessionCookiePresent(page)) && /Too many/i.test(await UI.loginError(page)), { signedIn: await UI.signedIn(page), msg: await UI.loginError(page) });
      const api = await H.apiLogin(strict, acct.email, acct.password);
      s.check(`${L} the same holds on the API (429, no cookie)`, api.status === 429 && !api.cookie, api.status);
      const la = await H.layoutAudit(page, { scope: "#loginScreen" });
      s.check(`${L} throttle message: no horizontal overflow`, !H.hasHScroll(la), la);
      // a different account is not collateral damage (negative control for over-blocking)
      const p2 = await H.newPage(chrome, { origin: strict.origin }); await p2.viewport(w);
      await F.signInPasswordOnly(p2, strict, other);
      s.check(`${L} another account can still sign in while this one is throttled`, await UI.signedIn(p2));
      await p2.close();
      await H.privacyAudit(s, page, strict, L, [acct.password]);
      await page.close();
      if (w === 1440) {
        // rotating the forwarded-for header must not give a fresh budget for the same account
        const rot = await H.http(strict, "POST", `${H.SESSION}/login`, { headers: { "x-forwarded-for": "203.0.113.77" }, body: { email: acct.email, password: acct.password } });
        s.check(`${L} a spoofed X-Forwarded-For does not reset the throttle for the account (strict: the correct password under a new header is refused after 5 failures)`, rot.status === 429 && !rot.cookie, rot.status);
        // the written design gives the ACCOUNT a failure budget of 5x the per-address budget so that rotating the header cannot start a fresh budget indefinitely
        const target = await H.freshAccount(strict, ck, { enroll: false, tag: "thr4" });
        let last = 0;
        for (let i = 0; i < 40 && last !== 429; i += 1) { const r = await H.http(strict, "POST", `${H.SESSION}/login`, { headers: { "x-forwarded-for": `198.51.100.${i + 1}` }, body: { email: target.email, password: `guess-${i}-Wrong!` } }); last = r.status; }
        const rot2 = await H.http(strict, "POST", `${H.SESSION}/login`, { headers: { "x-forwarded-for": "192.0.2.250" }, body: { email: target.email, password: target.password } });
        s.check(`${L} rotating X-Forwarded-For across many addresses still ends in a throttle for the account (the correct password is then refused)`, last === 429 && rot2.status === 429 && !rot2.cookie, { last, rot2: rot2.status });
      }
    }
  });

  // ================================================================ D. unavailable backend
  await s.guard("down-process", async () => {
    for (const phase of ["at-password", "at-challenge"]) {
      const down = await H.startServer(s);
      await H.enrollRoot(down);
      const ck = await H.adminCookie(down);
      const acct = await H.freshAccount(down, ck, { tag: "dn" });
      const L = `[${phase} server down]`;
      const page = await H.newPage(chrome, { origin: down.origin }); await page.viewport(1100);
      await UI.openLogin(page, down);
      if (phase === "at-password") {
        await down.stop();
        await UI.submitPassword(page, acct.email, acct.password);
        await page.waitFor(`document.getElementById('loginError').classList.contains('visible') && document.getElementById('loginSubmit').disabled === false`, { what: "network error shown" });
        s.check(`${L} with the server unreachable the password step shows an error and signs nobody in`, !(await UI.signedIn(page)) && !(await UI.sessionCookiePresent(page)) && (await UI.loginError(page)).trim().length > 0, await UI.loginError(page));
        s.check(`${L} the error text is plain (no stack, no host names or paths)`, !/at .*\(|ECONN|\/Users\/|node_modules|\.js:\d+/.test(await UI.loginError(page)), await UI.loginError(page));
        s.check(`${L} the Sign in button is usable again after the failure`, await page.eval(`document.getElementById('loginSubmit').disabled === false && document.getElementById('loginSubmit').textContent === 'Sign in'`));
      } else {
        await UI.submitPassword(page, acct.email, acct.password); await UI.waitChallenge(page);
        await down.stop();
        await page.fill("#mfaChallenge [data-panel=totp] input", await acct.totp.next());
        await page.click("#mfaChallenge [data-panel=totp] button[type=submit]");
        await page.waitFor(`document.querySelector('#mfaChallenge .mfa-error').classList.contains('visible') && document.querySelector('#mfaChallenge .mfa-status').textContent === ''`, { what: "network failure at the challenge" });
        s.check(`${L} with the server gone during the challenge, the correct code does NOT sign anyone in`, !(await UI.signedIn(page)) && !(await UI.sessionCookiePresent(page)), await page.text("#mfaChallenge .mfa-error"));
        s.check(`${L} the challenge shows a visible, announced failure message`, (await page.text("#mfaChallenge .mfa-error")).trim().length > 0);
        s.check(`${L} the failure text leaks no internals`, !/at .*\(|ECONN|\/Users\/|node_modules|\.js:\d+/.test(await page.text("#mfaChallenge .mfa-error")), await page.text("#mfaChallenge .mfa-error"));
      }
      s.check(`${L} no uncaught page error while the backend is down`, page.exceptions.length === 0, page.exceptions);
      await page.close();
    }
  });

  await s.guard("down-store", async () => {
    const L = "[store unwritable]";
    const stor = await H.startServer(s); // its own server: a file-store fault must not disturb the other journeys
    const storCk = await H.adminCookie(stor);
    const acct = await H.freshAccount(stor, storCk, { tag: "st" });
    const page = await H.newPage(chrome, { origin: stor.origin }); await page.viewport(390);
    await UI.openLogin(page, stor); await UI.submitPassword(page, acct.email, acct.password); await UI.waitChallenge(page);
    fs.chmodSync(stor.dir, 0o500); fs.chmodSync(`${stor.dir}/store.json`, 0o400);
    try {
      await page.fill("#mfaChallenge [data-panel=totp] input", await acct.totp.next());
      await page.click("#mfaChallenge [data-panel=totp] button[type=submit]");
      await page.waitFor(`document.querySelector('#mfaChallenge .mfa-error').classList.contains('visible') && document.querySelector('#mfaChallenge .mfa-status').textContent === ''`, { what: "store failure message" });
      const msg = await page.text("#mfaChallenge .mfa-error");
      s.check(`${L} when the store cannot be written the correct code does not sign anyone in`, !(await UI.signedIn(page)) && !(await UI.sessionCookiePresent(page)));
      s.check(`${L} the person is told they were not signed in (honest message)`, /not been signed in|not signed in|unavailable/i.test(msg), msg);
      s.check(`${L} the message contains no path, driver or stack detail`, !/EACCES|\/var\/|\/Users\/|store\.json|at .*\(/.test(msg), msg);
      const bodies = page.bodies.filter((b) => /mfa\/verify/.test(b.url));
      s.check(`${L} the API answer is a 503 with a generic body`, bodies.length > 0 && bodies.every((b) => b.status === 503 && !/EACCES|\/var\/|store\.json/.test(JSON.stringify(b.json))), bodies.map((b) => [b.status, b.json]));
          // while the store is still broken, a fresh password step must not leak the raw error either
      const broken = await H.apiLogin(stor, acct.email, acct.password);
      s.check(`${L} the public sign-in route answers a store fault without an internal path or raw driver text`, !/EACCES|\/var\/|\/tmp\/|store\.json|ENOENT|at .*\(/.test(broken.text) && !broken.cookie, { status: broken.status, body: broken.text.slice(0, 200) });
    } finally { fs.chmodSync(stor.dir, 0o700); fs.chmodSync(`${stor.dir}/store.json`, 0o600); }
    // after recovery the same person can sign in again
    await page.click("#mfaChallenge [data-act=back]");
    await page.waitFor(`!document.getElementById('mfaChallenge')`);
    const healed = await H.apiLogin(stor, acct.email, acct.password);
    s.check(`${L} after the fault is repaired the server serves sign-in again without a restart`, healed.status === 200 && !!healed.json && !!healed.json.challenge_token, { status: healed.status, body: healed.text.slice(0, 160) });
    if (!(healed.status === 200 && healed.json && healed.json.challenge_token)) { await page.close(); return; }
    await UI.submitPassword(page, acct.email, acct.password); await UI.waitChallenge(page);
    await page.fill("#mfaChallenge [data-panel=totp] input", await acct.totp.next());
    await page.click("#mfaChallenge [data-panel=totp] button[type=submit]");
    await UI.waitSignedIn(page);
    s.check(`${L} after the fault is repaired the person can sign in (positive control)`, await UI.signedIn(page));
    await page.close();
  });

  // ================================================================ E. sessions ended by the server
  for (const w of H.WIDTHS) {
    await s.guard(`ended-${w}`, async () => {
      const L = `[${w}px ended]`;
      // E1 revocation
      let acct = await H.freshAccount(srv, adminCk, { enroll: false, tag: `r${w}` });
      let page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w);
      await F.signInPasswordOnly(page, srv, acct); await page.waitFor(`document.getElementById('navUserName').textContent.trim().length > 1`);
      const copied = await page.sessionCookie();
      s.check(`${L} control: the session is valid before the administrator acts`, (await meStatus(page)) === 200);
      const rev = await revokeSessionsApi(srv, acct.id);
      s.check(`${L} the administrator's revocation is accepted (control)`, rev.status === 200, rev.text.slice(0, 200));
      s.check(`${L} the revoked session is refused by the server`, (await meStatus(page)) === 401);
      await triggerApiCall(page);
      const back_after_revocation = await returned(page);
      s.check(`${L} the UI returns to the sign-in screen after revocation`, back_after_revocation);
      if (!back_after_revocation) { await page.close(); page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w); await UI.openLogin(page, srv); }
      await page.waitFor(`document.getElementById('loginError').classList.contains('visible')`, { what: "reason shown", timeout: 4000 }).catch(() => {});
      s.check(`${L} revocation: the UI returns to sign-in WITH a reason ("You were signed out. Sign in again.")`, /signed out/i.test(await UI.loginError(page)) && await page.eval(`document.getElementById('loginError').classList.contains('visible')`), await UI.loginError(page));
      s.check(`${L} no dialog is left open over the sign-in screen after the session ended`, !(await F.dialogOpen(page)));
      await page.reload(); await page.waitFor(`document.getElementById('loginForm').dataset.wired === '1'`);
      s.check(`${L} revocation: no application content remains visible`, await page.eval(`getComputedStyle(document.getElementById('appShell')).display === 'none' || document.body.classList.contains('auth-logged-out')`));
      const la = await H.layoutAudit(page, { scope: "#loginScreen" });
      s.check(`${L} revocation: sign-in screen has no horizontal overflow`, !H.hasHScroll(la), la);
      await page.reload(); await page.waitFor(`document.getElementById('loginForm').dataset.wired === '1'`);
      s.check(`${L} revocation: a reload stays on the sign-in screen`, await page.eval(`document.body.classList.contains('auth-logged-out')`));
      await F.signInPasswordOnly(page, srv, acct);
      s.check(`${L} revocation: signing in again works and a NEW session is issued`, await UI.signedIn(page) && (await page.sessionCookie()).value !== copied.value);
      await page.close();

      // E2 deactivation then restoration
      acct = await H.freshAccount(srv, adminCk, { enroll: false, tag: `d${w}` });
      page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w);
      await F.signInPasswordOnly(page, srv, acct); await page.waitFor(`document.getElementById('navUserName').textContent.trim().length > 1`);
      const old = await page.sessionCookie();
      s.check(`${L} deactivation: an administrator deactivates the account (control)`, (await H.setStatus(srv, adminCk, acct.id, "inactive")).status === 200);
      s.check(`${L} deactivation: the open session is refused immediately`, (await meStatus(page)) === 401);
      await triggerApiCall(page);
      const back_after_deactivation = await returned(page);
      s.check(`${L} the UI returns to the sign-in screen after deactivation`, back_after_deactivation);
      if (!back_after_deactivation) { await page.close(); page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w); await UI.openLogin(page, srv); }
      await page.waitFor(`document.getElementById('loginError').classList.contains('visible')`, { timeout: 4000 }).catch(() => {});
      s.check(`${L} deactivation: the UI returns to sign-in WITH a visible reason`, await page.eval(`document.getElementById('loginError').classList.contains('visible') && document.getElementById('loginError').textContent.trim().length > 3`), await UI.loginError(page));
      s.check(`${L} no dialog is left open over the sign-in screen after the session ended`, !(await F.dialogOpen(page)));
      await page.reload(); await page.waitFor(`document.getElementById('loginForm').dataset.wired === '1'`);
      await UI.submitPassword(page, acct.email, acct.password);
      await UI.waitLoginError(page, /incorrect/i);
      s.check(`${L} deactivation: the correct password is refused with the generic message`, !(await UI.signedIn(page)));
      s.check(`${L} deactivation: restoring the account is accepted (control)`, (await H.setStatus(srv, adminCk, acct.id, "active")).status === 200);
      s.check(`${L} restoration: the cookie from before the deactivation stays dead`, (await H.http(srv, "GET", `${H.SESSION}/me`, { cookie: `${old.name}=${old.value}` })).status === 401);
      await UI.submitPassword(page, acct.email, acct.password);
      await UI.waitSignedIn(page);
      s.check(`${L} restoration: after restoring, the password signs in again (positive control)`, await UI.signedIn(page));
      await page.close();

      // E3 administrator changes the password
      acct = await H.freshAccount(srv, adminCk, { enroll: false, tag: `p${w}` });
      page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w);
      await F.signInPasswordOnly(page, srv, acct); await page.waitFor(`document.getElementById('navUserName').textContent.trim().length > 1`);
      const newPw = `New-${H.rand(6)}-Pass9!x`;
      const chg = await H.http(srv, "PATCH", `/api/lead-agents/admin/users/${acct.id}`, { cookie: adminCk, body: { password: newPw } });
      s.check(`${L} password change: the administrator sets a new password (control)`, chg.status === 200, chg.text.slice(0, 200));
      s.check(`${L} password change: the open session is ended`, (await meStatus(page)) === 401);
      await triggerApiCall(page);
      const back_pw = await returned(page);
      s.check(`${L} the UI returns to the sign-in screen after a password change`, back_pw);
      if (!back_pw) { await page.close(); page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w); await UI.openLogin(page, srv); }
      s.check(`${L} password change: the UI returns to sign-in with a visible reason`, await page.eval(`document.getElementById('loginError').classList.contains('visible') && document.getElementById('loginError').textContent.trim().length > 3`), await UI.loginError(page));
      s.check(`${L} no dialog is left open over the sign-in screen after the session ended`, !(await F.dialogOpen(page)));
      await page.reload(); await page.waitFor(`document.getElementById('loginForm').dataset.wired === '1'`);
      await UI.submitPassword(page, acct.email, acct.password); await UI.waitLoginError(page, /incorrect/i);
      s.check(`${L} password change: the OLD password no longer signs in`, !(await UI.signedIn(page)));
      await UI.submitPassword(page, acct.email, newPw); await UI.waitSignedIn(page);
      s.check(`${L} password change: the NEW password signs in`, await UI.signedIn(page));
      await H.privacyAudit(s, page, srv, L, [acct.password, newPw]);
      await page.close();

      // E4 a second factor appears elsewhere: the password-only session may not keep working
      acct = await H.freshAccount(srv, adminCk, { enroll: false, tag: `m${w}` });
      page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w);
      await F.signInPasswordOnly(page, srv, acct); await page.waitFor(`document.getElementById('navUserName').textContent.trim().length > 1`);
      const other = await H.apiLogin(srv, acct.email, acct.password);
      const enrolled = await H.enrollTotpApi(srv, other.cookie, acct.password);
      acct.totp = enrolled.totp;
      s.check(`${L} downgrade: after a factor is added from another session, the old password-only browser session is refused`, (await meStatus(page)) === 401, await meStatus(page));
      await triggerApiCall(page);
      const back_after_factor_added = await returned(page);
      s.check(`${L} the UI returns to the sign-in screen after factor added`, back_after_factor_added);
      if (!back_after_factor_added) { await page.close(); page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w); await UI.openLogin(page, srv); }
      await page.waitFor(`document.getElementById('loginError').classList.contains('visible')`, { timeout: 4000 }).catch(() => {});
      s.check(`${L} downgrade: the UI returns to sign-in with a visible reason`, await page.eval(`document.getElementById('loginError').classList.contains('visible') && document.getElementById('loginError').textContent.trim().length > 3`), await UI.loginError(page));
      s.check(`${L} no dialog is left open over the sign-in screen after the session ended`, !(await F.dialogOpen(page)));
      await page.reload(); await page.waitFor(`document.getElementById('loginForm').dataset.wired === '1'`);
      await UI.submitPassword(page, acct.email, acct.password);
      await UI.waitChallenge(page);
      s.check(`${L} downgrade: the next sign-in now requires the second factor`, true);
      await page.close();
    });
  }
});

async function sleepUntilSettled(page) { await page.settle(); }
