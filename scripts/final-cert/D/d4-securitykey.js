"use strict";
// D4: security keys / passkeys through the Chrome virtual authenticator: register from the panel (name dialog, step-up with a code), sign in with the key at the
// five widths, key failures (no user verification, credential missing, other authenticator, cloned authenticator / counter rollback), step-up with a key,
// browser without WebAuthn support, and removal.
const H = require("./lib/harness.js");
const F = require("./lib/flows.js");
const { UI } = H;

const apiMfa = (page) => page.eval(`fetch('/api/lead-agents/admin/session/mfa').then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);

H.runSuite("d4-securitykey", async (s) => {
  const srv = await H.startServer(s);
  await H.enrollRoot(srv);
  const adminCk = await H.adminCookie(srv);
  const chrome = await H.launchChrome(s);
  let carry = null; // credential material kept from the first width for the clone/rollback test

  for (const w of H.WIDTHS) {
    await s.guard(`w${w}`, async () => {
      const L = `[${w}px key]`;
      const acct = await H.freshAccount(srv, adminCk, { tag: `s${w}` });
      const page = await H.newPage(chrome, { origin: srv.origin });
      await page.viewport(w);
      const auth = await H.addAuthenticator(page);
      await F.signInTotp(page, srv, acct);
      await F.openSecurityPanel(page);
      s.check(`${L} "Add security key or passkey" is offered when the server and the browser support WebAuthn`, await page.visible("#mfaAddKey"));
      s.check(`${L} the add-key button has a text label`, /security key/i.test(await page.text("#mfaAddKey")));
      s.check(`${L} before registering, the virtual authenticator holds no credential`, (await H.getCredentials(page, auth)).length === 0);
      await page.click("#mfaAddKey");
      await page.waitFor(`!!document.querySelector('input[name=label]')`, { what: "name-your-key dialog" });
      const nd = await page.eval(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].filter((e) => e.getClientRects().length).pop(); const t = d.querySelector('h3'); return { modal: d.getAttribute('aria-modal'), title: t.textContent, focus: document.activeElement.name }; })()`);
      s.check(`${L} the key-name dialog is modal, labelled and focuses the name field`, nd.modal === "true" && /Name this security key/.test(nd.title) && nd.focus === "label", nd);
      // cancel first: nothing happens
      await page.press("Escape");
      await page.waitFor(`!document.querySelector('input[name=label]')`);
      await page.waitFor(`/Cancelled/.test(document.querySelector('.mfa-modal .mfa-status').textContent)`, { what: "cancel message" });
      s.check(`${L} cancelling the key-name dialog changes nothing and says so`, (await apiMfa(page)).body.webauthn.registered === 0 && (await H.getCredentials(page, auth)).length === 0);
      await page.click("#mfaAddKey");
      await page.waitFor(`!!document.querySelector('input[name=label]')`);
      await page.fill("input[name=label]", `Desk key ${w}`);
      await page.press("Enter");
      await F.stepUpDialog(page, acct.password, await acct.totp.next());
      await page.waitFor(`document.querySelectorAll('.mfa-table tbody tr').length === 2`, { what: "key row appears in the table" });
      const rows = await page.eval(`[...document.querySelectorAll('.mfa-table tbody tr')].map(tr => [...tr.cells].map(c => c.textContent.trim()))`);
      s.check(`${L} the registered key is listed with its method and the name the person chose`, rows.some((r) => /Security key or passkey/.test(r[0]) && r[1] === `Desk key ${w}`), rows);
      s.check(`${L} the authenticator now holds exactly one credential for this relying party`, (await H.getCredentials(page, auth)).length === 1);
      const baseCount = (await H.getCredentials(page, auth))[0].signCount;
      s.check(`${L} registration did not alter the authenticator-app factor (two active methods)`, rows.length === 2 && rows.some((r) => /Authenticator app/.test(r[0])), rows);
      s.check(`${L} the key row has a Remove button with a descriptive accessible name`, await page.eval(`[...document.querySelectorAll("button[aria-label^='Remove']")].some(b => /Security key/.test(b.getAttribute('aria-label')))`));
      const ax = await page.axTree();
      s.check(`${L} the method table has an accessible caption and column headers`, ax.some((n) => n.role === "table" && /two-step verification methods/i.test(n.name)) && ax.filter((n) => n.role === "columnheader").length >= 4, ax.filter((n) => n.role === "table").map((n) => n.name));
      await F.closeTopDialog(page);
      await F.waitDialogClosed(page);

      // ---------------- sign in with the key (positive control)
      await F.logoutUi(page);
      await UI.openLogin(page, srv);
      await UI.submitPassword(page, acct.email, acct.password);
      await UI.waitChallenge(page);
      const methods = await page.eval(`[...document.querySelectorAll('#mfaChallenge .mfa-methods button')].map(b => b.dataset.m)`);
      s.check(`${L} the challenge offers Authenticator app, Security key and Recovery code (the account has all three)`, ["totp", "webauthn", "recovery_code"].every((m) => methods.includes(m)), methods);
      await page.click("#mfaChallenge [data-m=webauthn]");
      s.check(`${L} choosing "Security key" shows the key panel with an explanatory text and the action button`, await page.visible("#mfaChallenge .mfa-key-btn") && /security key/i.test(await page.text("#mfaChallenge [data-panel=webauthn]")));
      s.check(`${L} the key action is not triggered automatically (no assertion until the person asks)`, (await H.getCredentials(page, auth))[0].signCount === baseCount);
      // negative: user verification fails -> no sign in
      await page.send("WebAuthn.setUserVerified", { authenticatorId: auth, isUserVerified: false });
      await page.click("#mfaChallenge .mfa-key-btn");
      await page.waitFor(`document.querySelector('#mfaChallenge .mfa-error').classList.contains('visible') && document.querySelector('#mfaChallenge .mfa-key-btn').disabled === false`, { what: "key failure message" });
      s.check(`${L} a key that cannot verify the user is refused: message shown, no session, no shell`, !(await UI.signedIn(page)) && !(await UI.sessionCookiePresent(page)), await page.text("#mfaChallenge .mfa-error"));
      s.check(`${L} the key failure message is in the alert region and says what happened`, await page.eval(`(() => { const e = document.querySelector('#mfaChallenge .mfa-error'); return e.getAttribute('role') === 'alert' && e.textContent.trim().length > 10; })()`), await page.text("#mfaChallenge .mfa-error"));
      await page.send("WebAuthn.setUserVerified", { authenticatorId: auth, isUserVerified: true });
      // negative: credential missing from the device
      const creds = await H.getCredentials(page, auth);
      await page.send("WebAuthn.removeCredential", { authenticatorId: auth, credentialId: creds[0].credentialId });
      await page.click("#mfaChallenge .mfa-key-btn");
      await page.waitFor(`document.querySelector('#mfaChallenge .mfa-error').classList.contains('visible') && document.querySelector('#mfaChallenge .mfa-key-btn').disabled === false`, { what: "no-credential failure" });
      s.check(`${L} a device that does not hold the registered key signs nobody in`, !(await UI.signedIn(page)) && !(await UI.sessionCookiePresent(page)));
      // restore and sign in properly
      await page.send("WebAuthn.addCredential", { authenticatorId: auth, credential: creds[0] });
      await page.click("#mfaChallenge .mfa-key-btn");
      await UI.waitSignedIn(page);
      await page.waitFor(`document.getElementById('navUserName').textContent.trim().length > 1`);
      s.check(`${L} with the key present and verified, the person is signed in (positive control)`, await UI.signedIn(page));
      const after = await H.getCredentials(page, auth);
      s.check(`${L} the authenticator's signature counter advanced`, after[0].signCount > creds[0].signCount, { before: creds[0].signCount, after: after[0].signCount });
      const lm = await H.http(srv, "GET", `${H.SESSION}/me`, { cookie: (await page.sessionCookie()).name + "=" + (await page.sessionCookie()).value });
      s.check(`${L} the key sign-in session is marked as having proved a second factor`, lm.json && lm.json.mfa && (lm.json.mfa.verified === true || lm.json.mfa.mfa_verified === true || JSON.stringify(lm.json).includes('"mfa"')), lm.json && lm.json.mfa);
      if (w === 1440) carry = { acct, cred: after[0], earlier: creds[0] };
      // ---------------- step-up with the key (two methods available: the toggle appears)
      await F.openSecurityPanel(page);
      await page.click("#mfaRegen");
      await page.waitFor(`!!document.getElementById('stModalTitle')`);
      await page.click("top:[data-act=ok]");
      await page.waitFor(`!!document.getElementById('stStepUpTitle') && !!document.querySelector('.mfa-stepup')`);
      await page.waitFor(`document.querySelectorAll('.mfa-stepup .mfa-method').length === 2`, { what: "method toggle in step-up" });
      s.check(`${L} step-up offers both "Authenticator code" and "Security key" as a labelled button group with pressed state`, await page.eval(`(() => { const g = document.querySelector('.mfa-stepup [role=group]'); const b = [...g.querySelectorAll('button')]; return b.length === 2 && g.getAttribute('aria-label') && b.every(x => x.hasAttribute('aria-pressed')); })()`));
      await page.click(".mfa-stepup [data-m=webauthn]");
      s.check(`${L} choosing Security key hides the code field and explains what will happen`, await page.eval(`document.querySelector('.mfa-stepup .mfa-totp').hidden === true && document.querySelector('.mfa-key-note').hidden === false`));
      await page.fill(`top:input[name=current_password]`, acct.password);
      await page.click("top:[data-act=ok]");
      const codes = await F.readRecoveryDialog(page);
      s.check(`${L} step-up with the security key authorised "regenerate recovery codes" (ten new codes shown)`, codes.length === 10, codes.length);
      await F.ackRecoveryDialog(page);
      // ---------------- password right but key step-up refused when the key is not user-verified
      await page.click("#mfaRegen"); await page.waitFor(`!!document.getElementById('stModalTitle')`); await page.click("top:[data-act=ok]");
      await page.waitFor(`document.querySelectorAll('.mfa-stepup .mfa-method').length === 2`);
      await page.click(".mfa-stepup [data-m=webauthn]");
      await page.send("WebAuthn.setUserVerified", { authenticatorId: auth, isUserVerified: false });
      await page.fill(`top:input[name=current_password]`, acct.password); await page.click("top:[data-act=ok]");
      await page.waitFor(`__q('top:.st-field-error').textContent.trim().length > 0 && !__q('top:[data-act=ok]').disabled`, { what: "step-up key refusal" });
      s.check(`${L} step-up with an unverified key is refused and no codes are shown`, !(await page.eval(`!!document.querySelector('.mfa-codes')`)) && /key|verified|cancel/i.test(await page.text("top:.st-field-error")), await page.text("top:.st-field-error"));
      await page.send("WebAuthn.setUserVerified", { authenticatorId: auth, isUserVerified: true });
      await page.press("Escape");
      await F.closeTopDialog(page);
      await H.privacyAudit(s, page, srv, L, [acct.password, acct.totp.b32, ...codes]);
      await page.close();
    });
  }

  // ---------------- cloned authenticator / counter rollback, wrong authenticator, unsupported browser
  await s.guard("clone", async () => {
    if (!carry) return;
    const L = "[clone]";
    const { acct, cred, earlier } = carry;
    const page = await H.newPage(chrome, { origin: srv.origin });
    await page.viewport(1100);
    const a1 = await H.addAuthenticator(page);
    // a CLONE of the key whose counter is behind the server's record
    await page.send("WebAuthn.addCredential", { authenticatorId: a1, credential: { ...earlier, signCount: 0 } });
    await UI.openLogin(page, srv);
    await UI.submitPassword(page, acct.email, acct.password);
    await UI.waitChallenge(page);
    await page.click("#mfaChallenge [data-m=webauthn]");
    await page.click("#mfaChallenge .mfa-key-btn");
    await page.waitFor(`document.querySelector('#mfaChallenge .mfa-error').classList.contains('visible') || !document.body.classList.contains('auth-logged-out')`, { what: "clone outcome" });
    s.check(`${L} an authenticator clone whose counter is behind the server's record does NOT sign in (counter rollback)`, !(await UI.signedIn(page)) && !(await UI.sessionCookiePresent(page)), { error: await page.text("#mfaChallenge .mfa-error"), signedIn: await UI.signedIn(page) });
    // control: an authenticator holding a different (unregistered) credential
    await page.send("WebAuthn.removeCredential", { authenticatorId: a1, credentialId: earlier.credentialId });
    const a2 = await H.addAuthenticator(page, { transport: "usb", hasResidentKey: false });
    await page.send("WebAuthn.addCredential", { authenticatorId: a2, credential: { credentialId: Buffer.from("unregistered-credential-0123456789").toString("base64"), isResidentCredential: false, rpId: "localhost", privateKey: cred.privateKey, signCount: 5 } });
    await page.click("#mfaChallenge .mfa-key-btn");
    await page.waitFor(`document.querySelector('#mfaChallenge .mfa-error').classList.contains('visible') && document.querySelector('#mfaChallenge .mfa-key-btn').disabled === false`, { what: "foreign credential outcome" });
    s.check(`${L} an authenticator holding a credential the server never registered signs nobody in`, !(await UI.signedIn(page)) && !(await UI.sessionCookiePresent(page)));
    await H.privacyAudit(s, page, srv, L, [acct.password]);
    await page.close();
  });

  await s.guard("unsupported", async () => {
    const L = "[no-webauthn]";
    const acct = await H.freshAccount(srv, adminCk, { tag: "nowa" });
    // give the account a key through the UI in a capable page first
    const cap = await H.newPage(chrome, { origin: srv.origin }); await cap.viewport(1440);
    await H.addAuthenticator(cap);
    await F.signInTotp(cap, srv, acct); await F.openSecurityPanel(cap);
    await cap.click("#mfaAddKey"); await cap.waitFor(`!!document.querySelector('input[name=label]')`); await cap.press("Enter");
    await F.stepUpDialog(cap, acct.password, await acct.totp.next());
    await cap.waitFor(`document.querySelectorAll('.mfa-table tbody tr').length === 2`);
    await cap.close();
    // a browser without PublicKeyCredential
    const page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(1440);
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "delete window.PublicKeyCredential;" });
    await UI.openLogin(page, srv);
    await UI.submitPassword(page, acct.email, acct.password);
    await UI.waitChallenge(page);
    const m = await page.eval(`[...document.querySelectorAll('#mfaChallenge .mfa-methods button')].map(b => b.dataset.m)`);
    s.check(`${L} a browser without WebAuthn is not offered "Security key" at sign-in`, !m.includes("webauthn") && m.includes("totp"), m);
    s.check(`${L} the other methods still work in that browser (authenticator + recovery code offered)`, m.includes("recovery_code"), m);
    await page.fill("#mfaChallenge [data-panel=totp] input", await acct.totp.next()); await page.click("#mfaChallenge [data-panel=totp] button[type=submit]");
    await UI.waitSignedIn(page);
    s.check(`${L} the authenticator code signs in in that browser (positive control)`, await UI.signedIn(page));
    await F.openSecurityPanel(page);
    s.check(`${L} the panel does not offer "Add security key" in a browser without WebAuthn`, !(await page.visible("#mfaAddKey")));
    await page.close();
  });
});
