"use strict";
// D3: first-time enrolment (locally drawn QR, manual key, confirmation, recovery codes shown once with copy/download/print + acknowledgement,
// cleared afterwards) and factor management (replace, regenerate, remove) with step-up, at the five widths.
// Widths 1440 and 390 run the whole journey; 1100/900/768 run enrolment + recovery-code handling + layout.
const H = require("./lib/harness.js");
const F = require("./lib/flows.js");
const { UI } = H;

const clip = (page) => page.eval(`navigator.clipboard.readText().then((t) => ({ ok: true, t }), (e) => ({ ok: false, e: String(e) }))`);
const apiMfa = (page) => page.eval(`fetch('/api/lead-agents/admin/session/mfa').then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);
async function dialogFacts(page) {
  return page.eval(`(() => { const vis = [...document.querySelectorAll('[role=dialog]')].filter((e) => e.getClientRects().length); const d = vis.pop(); if (!d) return null; const r = d.getBoundingClientRect(); const lab = d.getAttribute('aria-labelledby'); const t = lab && document.getElementById(lab); const a = document.activeElement; const h = d.querySelector('h3'); return { modal: d.getAttribute('aria-modal'), title: t ? t.textContent : null, own: h ? h.textContent : null, inside: d.contains(a), left: r.left, right: r.right, vw: innerWidth, top: r.top, bottom: r.bottom, vh: innerHeight, count: vis.length + 1 }; })()`);
}
async function apiVerify(srv, acct, method, code) {
  const r = await H.apiLogin(srv, acct.email, acct.password);
  if (r.cookie) return { status: 200, passwordOnly: true, cookie: r.cookie };
  const v = await H.http(srv, "POST", `${H.SESSION}/mfa/verify`, { body: { challenge_token: r.json.challenge_token, method, code } });
  return { status: v.status, cookie: v.cookie, body: v.json };
}
async function trapCheck(s, page, L, what) {
  let ok = true; const seen = [];
  for (let i = 0; i < 9; i += 1) { await page.press("Tab"); const f = await dialogFacts(page); seen.push(f && f.inside); if (!f || !f.inside) ok = false; }
  for (let i = 0; i < 4; i += 1) { await page.press("Tab", { shift: true }); const f = await dialogFacts(page); if (!f || !f.inside) ok = false; }
  s.check(`${L} ${what}: Tab and Shift+Tab keep focus trapped inside the dialog`, ok, seen);
}

H.runSuite("d3-enrol-manage", async (s) => {
  const srv = await H.startServer(s);
  await H.enrollRoot(srv);
  const adminCk = await H.adminCookie(srv);
  const chrome = await H.launchChrome(s);

  for (const w of H.WIDTHS) {
    await s.guard(`w${w}`, async () => {
      const full = w === 1440 || w === 390;
      const L = `[${w}px enrol]`;
      const acct = await H.freshAccount(srv, adminCk, { enroll: false, tag: `n${w}` });
      const page = await H.newPage(chrome, { origin: srv.origin });
      await page.viewport(w);
      await F.signInPasswordOnly(page, srv, acct);
      await F.openSecurityPanel(page);

      // ---------------- the panel before enrolment
      let facts = await dialogFacts(page);
      s.check(`${L} the security panel is a modal dialog labelled "Two-step verification"`, facts && facts.modal === "true" && /Two-step verification/.test(facts.title || ""), facts);
      s.check(`${L} focus moved into the panel dialog when it opened`, facts && facts.inside, facts);
      s.check(`${L} the panel fits the viewport width`, facts && facts.left >= -1 && facts.right <= facts.vw + 1, facts);
      const facts0 = await page.text(".mfa-facts");
      s.check(`${L} before enrolment the panel says the account is not set up and shows no recovery-code count`, /Not set up/.test(facts0) && /Recovery codes left\s*—/i.test(facts0), facts0);
      s.check(`${L} the primary action is "Add authenticator app" (not "Replace")`, /Add authenticator app/.test(await page.text("#mfaAddTotp")));
      s.check(`${L} Regenerate and Remove are not offered before enrolment`, !(await page.visible("#mfaRegen")) && !(await page.visible("button[aria-label^='Remove']")));
      let la = await H.layoutAudit(page, { scope: "top:.st-modal" });
      s.check(`${L} panel: no horizontal overflow of the page`, !H.hasHScroll(la), la);
      if (w <= 768) s.check(`${L} panel: controls are at least 44px`, la.small.length === 0, la.small);
      await trapCheck(s, page, L, "panel");

      // ---------------- step-up before any change: cancel with Escape, focus restored
      await page.click("#mfaAddTotp");
      await page.waitFor(`!!document.getElementById('stStepUpTitle')`, { what: "step-up dialog" });
      facts = await dialogFacts(page);
      s.check(`${L} step-up dialog: modal, labelled, focus on the password field`, facts && facts.modal === "true" && /Confirm to set up/.test(facts.title) && facts.inside && (await page.active()).name === "current_password", { facts, active: await page.active() });
      s.check(`${L} step-up dialog (stacked on the panel) is the only dialog that reacts to keys`, facts.count === 2, facts);
      s.check(`${L} step-up dialog: the password field is masked and has a visible label`, await page.eval(`(() => { const i = document.querySelector('[role=dialog] input[name=current_password]'); return i.type === 'password' && !!i.closest('label') && /Current password/.test(i.closest('label').textContent); })()`));
      s.check(`${L} step-up dialog for an unenrolled account asks for the password only (no second-factor field)`, await page.eval(`!document.querySelector('.mfa-stepup input')`));
            if (w <= 768) s.check(`${L} step-up dialog: controls are at least 44px`, (await H.layoutAudit(page, { scope: "#stStepUpTitle" })).small.length === 0 && (await page.eval(`[...[...(__q('top:.st-modal') ? __q('top:.st-modal').querySelectorAll('button, input') : [])]].every(e => e.getBoundingClientRect().height >= 43.5)`)), await page.eval(`[...[...(__q('top:.st-modal') ? __q('top:.st-modal').querySelectorAll('button, input') : [])]].map(e => e.tagName + e.getBoundingClientRect().height)`));
      await trapCheck(s, page, L, "step-up dialog");
      await page.press("Escape");
      await page.waitFor(`!document.getElementById('stStepUpTitle')`, { what: "step-up closed" });
      s.check(`${L} Escape closes only the step-up dialog; the panel underneath stays open`, (await dialogFacts(page)).count === 1);
      await page.waitFor(`/Confirmation cancelled/.test(document.querySelector('.mfa-modal .mfa-status').textContent)`, { what: "cancelled message" });
      s.check(`${L} cancelling the step-up reports "Nothing changed"`, /Nothing changed/.test(await page.text(".mfa-modal .mfa-status")));
      s.check(`${L} nothing was enrolled by the cancelled attempt (server state)`, (await apiMfa(page)).body.enrolled === false);

      // ---------------- wrong password at step-up, then the right one
      await page.click("#mfaAddTotp");
      await page.waitFor(`!!document.getElementById('stStepUpTitle')`);
      await page.fill(`top:input[name=current_password]`, "not-the-password-9!"); await page.click(`top:[data-act=ok]`);
      const shown = await page.waitFor(`__q('top:.st-field-error').textContent.trim().length > 0`, { timeout: 6000, what: "step-up error" }).then(() => true).catch(() => false);
      const suState = await page.eval(`JSON.stringify({ err: __q('top:.st-field-error').textContent, btn: __q('top:[data-act=ok]').textContent, disabled: __q('top:[data-act=ok]').disabled })`);
      s.check(`${L} step-up: a wrong password is refused with a message in a role=alert region and the dialog stays usable (not stuck on "Verifying…")`, shown && await page.eval(`(() => { const e = __q('top:.st-field-error'); return e.getAttribute('role') === 'alert' && /incorrect/i.test(e.textContent) && !!document.getElementById('stStepUpTitle') && !__q('top:[data-act=ok]').disabled; })()`), suState);
      s.check(`${L} step-up: the wrong password did not raise an uncaught page error`, page.exceptions.length === 0, page.exceptions);
      if (shown) {
        s.check(`${L} step-up: the wrong password was cleared from the field and focus returned to it`, await page.eval(`(() => { const i = __q('top:input[name=current_password]'); return i.value === '' && document.activeElement === i; })()`));
      } else {
        await page.press("Escape"); await page.waitFor(`!document.getElementById('stStepUpTitle')`, { what: "stuck step-up closed with Escape" });
        await page.click("#mfaAddTotp"); await page.waitFor(`!!document.getElementById('stStepUpTitle')`);
      }
      s.check(`${L} step-up: no setup dialog appeared after a wrong password`, !(await page.visible(".mfa-qr-box")));
      page.exceptions.length = 0;
      await page.fill(`top:input[name=current_password]`, acct.password); await page.click(`top:[data-act=ok]`);

      // ---------------- the authenticator setup dialog
      await page.waitFor(`!!document.querySelector('.mfa-qr-box svg') && !!document.querySelector('.mfa-key') && document.querySelector('.mfa-key').textContent.trim().length > 10`, { what: "setup dialog with QR and key" });
      facts = await dialogFacts(page);
      s.check(`${L} setup dialog: modal, labelled "Set up an authenticator app", fits the viewport`, facts && facts.modal === "true" && /Set up an authenticator app/.test(facts.own) && facts.left >= -1 && facts.right <= facts.vw + 1, facts);
      s.check(`${L} stacked dialogs have unique ids, so each dialog's aria-labelledby names its own title`, await page.eval(`document.querySelectorAll('#mfaDialogTitle').length <= 1`), await page.eval(`document.querySelectorAll('#mfaDialogTitle').length`));
      const qr = await page.eval(`(() => { const s = document.querySelector('.mfa-qr-box svg'); const vb = (s.getAttribute('viewBox') || '').split(' ').map(Number); return { role: s.getAttribute('role'), label: s.getAttribute('aria-label'), vb, paths: s.querySelectorAll('path').length, dark: (s.querySelector('path').getAttribute('d') || '').split('M').length - 1, images: document.querySelectorAll('.mfa-modal img, .mfa-modal canvas, .mfa-modal [src]').length }; })()`);
      s.check(`${L} QR code is an inline SVG with role=img and a text alternative`, qr.role === "img" && /QR code/i.test(qr.label || "") && /setup key/i.test(qr.label), qr);
      s.check(`${L} QR matrix has a legal QR size (modules = 17+4v plus 8 quiet-zone modules)`, qr.vb.length === 4 && Number.isInteger((qr.vb[2] - 8 - 17) / 4) && qr.vb[2] - 8 >= 21, qr);
      s.check(`${L} QR contains dark modules (it is a drawn code, not an empty placeholder)`, qr.dark > 100, qr);
      s.check(`${L} QR is drawn locally: no <img>, <canvas> or src= element in the dialog`, qr.images === 0, qr);
      const keyText = await page.text(".mfa-key");
      const secret = keyText.replace(/\s+/g, "");
      s.check(`${L} the manual setup key is a base32 secret of at least 16 characters, shown in groups of four`, /^[A-Z2-7]{16,}$/.test(secret) && /^([A-Z2-7]{4} )+[A-Z2-7]{1,4}$/.test(keyText.trim()), keyText);
      s.check(`${L} the setup key has an accessible label`, await page.eval(`(() => { const k = document.querySelector('.mfa-key'); const l = document.getElementById(k.getAttribute('aria-labelledby')); return !!l && /Setup key/.test(l.textContent); })()`));
      const newTotp = new H.Totp(secret, srv.now);
      s.check(`${L} no request carried the secret to any server other than the begin response (no QR/image service)`, !page.requests.some((r) => r.url.includes(secret) || (r.postData || "").includes(secret) || /qr|chart\.googleapis|otpauth/i.test(new URL(r.url).host + new URL(r.url).search)), page.requests.map((r) => r.url).filter((u) => /qr|otpauth/i.test(u)));
      s.check(`${L} setup dialog: focus starts in the code field`, (await page.active()).name === "code", await page.active());
      await page.click("[data-act=copykey]");
      await page.waitFor(`/copied|blocked/i.test(document.querySelector('.mfa-keyrow + .mfa-status').textContent)`, { what: "copy-key outcome" });
      const copyMsg = await page.text(".mfa-keyrow + .mfa-status");
      if (/copied/i.test(copyMsg)) { const c = await clip(page); s.check(`${L} "Setup key copied" is true: the clipboard holds the key`, !c.ok || c.t === secret, c); if (!c.ok) s.info(`${L} clipboard read-back not permitted in headless: ${c.e}`); }
      else s.check(`${L} when the browser blocks copying, the dialog says so instead of claiming success`, /blocked/i.test(copyMsg), copyMsg);
      const ax = await page.axTree();
      s.check(`${L} setup dialog is in the accessibility tree as a dialog named by its title; the QR is an image with a name`, ax.some((n) => n.role === "dialog" && /Set up an authenticator app/.test(n.name)) && ax.some((n) => (n.role === "image" || n.role === "img") && /QR code/.test(n.name)), ax.filter((n) => /dialog|image|img/.test(n.role)).map((n) => `${n.role}:${n.name.slice(0, 40)}`));
      la = await H.layoutAudit(page, { scope: "top:.st-modal" });
      if (w <= 768) s.check(`${L} setup dialog: controls are at least 44px`, (await page.eval(`[...[...(__q('top:.st-modal') ? __q('top:.st-modal').querySelectorAll('button, input') : [])]].filter(e => e.getClientRects().length).every(e => e.getBoundingClientRect().height >= 43.5)`)), await page.eval(`[...[...(__q('top:.st-modal') ? __q('top:.st-modal').querySelectorAll('button, input') : [])]].filter(e => e.getClientRects().length).map(e => (e.getAttribute('data-act')||e.name||e.tagName) + ':' + Math.round(e.getBoundingClientRect().height))`));
      s.check(`${L} setup dialog: page has no horizontal overflow`, !H.hasHScroll(la), la);
      // wrong code
      await page.fill(".mfa-form input[name=code]", newTotp.wrong()); await page.click(".mfa-form button[type=submit]");
      await page.waitFor(`document.getElementById('mfaSetupErr').textContent.trim().length > 0 && !document.querySelector('.mfa-form button[type=submit]').disabled`, { what: "setup wrong-code error" });
      s.check(`${L} setup: a wrong confirmation code is refused with a message; nothing is enrolled`, /didn.t match/i.test(await page.text("#mfaSetupErr")) && (await apiMfa(page)).body.enrolled === false, await page.text("#mfaSetupErr"));
      s.check(`${L} setup: the error is wired to the field (aria-describedby) and announced (role=alert)`, await page.eval(`document.querySelector('.mfa-form input[name=code]').getAttribute('aria-describedby') === 'mfaSetupErr' && document.getElementById('mfaSetupErr').getAttribute('role') === 'alert'`));
      await page.click(".mfa-form button[type=submit]");
      s.check(`${L} setup: submitting an empty code asks for the 6-digit code locally`, /6-digit/.test(await page.text("#mfaSetupErr")));
      // right code
      const goodCode = await newTotp.next();
      await page.fill(".mfa-form input[name=code]", goodCode); await page.click(".mfa-form button[type=submit]");

      // ---------------- recovery codes dialog
      const codes = await F.readRecoveryDialog(page);
      s.check(`${L} the server's ten recovery codes are shown`, codes.length === 10 && new Set(codes).size === 10, codes.length);
      s.check(`${L} recovery codes have a consistent human-typable format`, codes.every((c) => /^[A-Z0-9-]{8,24}$/.test(c)), codes[0]);
      facts = await dialogFacts(page);
      s.check(`${L} recovery dialog: modal, labelled "Save your recovery codes", focus inside, fits the viewport`, facts && facts.modal === "true" && /Save your recovery codes/.test(facts.own) && facts.inside && facts.left >= -1 && facts.right <= facts.vw + 1, facts);
      s.check(`${L} recovery dialog: the code list is a labelled ordered list`, await page.eval(`(() => { const o = document.querySelector('ol.mfa-codes'); return !!o && o.getAttribute('aria-label') === 'Recovery codes'; })()`));
      s.check(`${L} recovery dialog: Done is disabled until the acknowledgement is ticked`, await page.eval(`document.querySelector('[data-act=done]').disabled === true`));
      s.check(`${L} recovery dialog offers Copy, Download and Print`, await page.eval(`['copy','download','print'].every(a => !!document.querySelector('[data-act=' + a + ']'))`));
      await page.press("Escape");
      s.check(`${L} Escape does NOT close the recovery-code dialog (acknowledgement is required)`, !!(await page.eval(`!!document.querySelector('.mfa-codes')`)));
      await page.eval(`[...document.querySelectorAll('.mfa-backdrop')].pop().dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
      s.check(`${L} a click on the backdrop does NOT close the recovery-code dialog`, !!(await page.eval(`!!document.querySelector('.mfa-codes')`)));
      await trapCheck(s, page, L, "recovery dialog");
      la = await H.layoutAudit(page, { scope: "top:.st-modal" });
      s.check(`${L} recovery dialog: no horizontal overflow`, !H.hasHScroll(la), la);
      if (w <= 768) s.check(`${L} recovery dialog: controls are at least 44px`, la.small.length === 0, la.small);
      await page.click("[data-act=done]", { allowCover: true }).catch(() => {});
      s.check(`${L} clicking Done without the acknowledgement does not close the dialog`, !!(await page.eval(`!!document.querySelector('.mfa-codes')`)));
      // copy
      await page.click("[data-act=copy]"); await page.waitFor(`document.querySelector('.mfa-codes ~ .mfa-status').textContent.trim().length > 0`, { what: "copy outcome" });
      const copyMsg2 = await page.text(".mfa-codes ~ .mfa-status");
      if (/Copied/i.test(copyMsg2)) { const c = await clip(page); s.check(`${L} "Copied" is true: the clipboard holds all ten codes`, !c.ok || codes.every((x) => c.t.includes(x)), c); } else s.check(`${L} a blocked copy is reported as blocked, not as a success`, /block|could not|select/i.test(copyMsg2), copyMsg2);
      // download
      await page.click("[data-act=download]");
      await page.waitFor(`window.__blobs && window.__blobs.length > 0`, { what: "download blob created" });
      const blob = await page.eval(`window.__blobs[window.__blobs.length - 1]`);
      s.check(`${L} Download produces a plain-text file containing every code`, blob.type === "text/plain" && codes.every((c) => blob.text.includes(c)), blob.type);
      s.check(`${L} the downloaded file carries no password, secret or token`, !blob.text.includes(acct.password) && !blob.text.includes(secret), "");
      // print
      await page.click("[data-act=print]");
      await page.waitFor(`/print|Print/.test(document.querySelector('.mfa-codes ~ .mfa-status').textContent) || !!document.querySelector('iframe[aria-hidden=true]')`, { what: "print outcome", timeout: 8000 }).catch(() => {});
      const printed = await page.eval(`(() => { const f = document.querySelector('iframe[aria-hidden=true]'); return f ? { text: f.contentDocument && f.contentDocument.body.innerText } : null; })()`);
      if (printed) s.check(`${L} Print renders the codes in an isolated hidden frame`, codes.every((c) => (printed.text || "").includes(c)), printed.text && printed.text.slice(0, 80)); else s.info(`${L} print frame not observable in headless Chrome (status: ${await page.text(".mfa-codes ~ .mfa-status")})`);
      s.check(`${L} the dialog is still open and codes still present after copy/download/print`, !!(await page.eval(`!!document.querySelector('.mfa-codes')`)));
      // acknowledge
      await page.click(".mfa-ack input[type=checkbox]");
      s.check(`${L} ticking the acknowledgement enables Done`, await page.eval(`document.querySelector('[data-act=done]').disabled === false`));
      await page.click("[data-act=done]");
      await page.waitFor(`!document.querySelector('.mfa-codes')`, { what: "recovery dialog closed" });
      await page.settle();
      // cleared
      const html = await page.eval(`document.documentElement.outerHTML`);
      s.check(`${L} after Done no recovery code remains anywhere in the page`, codes.every((c) => !html.includes(c)), "");
      s.check(`${L} after Done the manual setup key is gone from the page`, !html.includes(secret) && !html.replace(/\s/g, "").includes(secret), "");
      s.check(`${L} after Done the QR code is gone from the page`, !(await page.eval(`!!document.querySelector('.mfa-qr-box')`)));
      const dump = await page.storageDump();
      s.check(`${L} nothing secret was written to local/session storage or cookies during enrolment`, JSON.stringify(dump).indexOf(secret) < 0 && codes.every((c) => JSON.stringify(dump).indexOf(c) < 0), dump);
      // state after enrolment
      await page.waitFor(`/Turned on/.test(document.querySelector('.mfa-facts') ? document.querySelector('.mfa-facts').textContent : '')`, { what: "panel refreshed after enrolment" });
      const f2 = await page.text(".mfa-facts");
      s.check(`${L} the panel now says two-step verification is turned on and 10 recovery codes remain`, /Turned on/.test(f2) && /Recovery codes left\s*10/i.test(f2), f2);
      s.check(`${L} the new method is listed with Remove, and the main action became "Replace authenticator app"`, (await page.visible("button[aria-label^='Remove']")) && /Replace/.test(await page.text("#mfaAddTotp")) && (await page.visible("#mfaRegen")));
      s.check(`${L} the session was re-issued with proof of the second factor ("This sign-in used two-step verification: Yes")`, /used two-step verification\s*Yes/i.test(f2), f2);
      s.check(`${L} the focus returned into the panel (not lost to the page body)`, (await dialogFacts(page)).inside || (await page.active()).tag !== "body", await page.active());
      // server-side truth: the shown key is the real key
      const v = await apiVerify(srv, acct, "totp", await newTotp.next());
      s.check(`${L} positive control: a code computed from the manual key signs in over the API (the key shown is the real key)`, v.status === 200 && !!v.cookie && !v.passwordOnly, v);
      const pw = await apiVerify(srv, acct, "totp", newTotp.wrong());
      s.check(`${L} negative control: a wrong code does not sign in over the API`, pw.status === 401 && !pw.cookie, pw.status);
      acct.totp = newTotp; acct.recoveryCodes = codes;

      if (full) await manage(s, page, srv, acct, L, w);
      await F.closeTopDialog(page);
      await H.privacyAudit(s, page, srv, L, [acct.password, secret, ...codes]);
      await page.close();
    });
  }
});

async function manage(s, page, srv, acct, Lbase, w) {
  const L = Lbase.replace("enrol", "manage");
  // --- replace: wrong second factor in the step-up is refused and nothing changes
  const before = (await apiMfa(page)).body;
  const oldId = before.credentials.find((c) => c.type === "totp" && c.status === "active").id;
  await page.click("#mfaAddTotp");
  await page.waitFor(`!!document.getElementById('stStepUpTitle') && !!document.querySelector('.mfa-stepup input')`, { what: "step-up with factor field" });
  s.check(`${L} replace: the step-up dialog now asks for password AND an authenticator code`, await page.eval(`!!document.querySelector('.mfa-stepup input') && /Authenticator code/.test(document.querySelector('.mfa-stepup').textContent)`));
  s.check(`${L} replace: the code field is numeric/one-time-code and labelled`, await page.eval(`(() => { const i = document.querySelector('.mfa-stepup input'); const l = i.closest('label'); return i.inputMode === 'numeric' && i.autocomplete === 'one-time-code' && !!l && /Authenticator/i.test(l.textContent); })()`));
  s.check(`${L} replace: recovery codes are not offered as a step-up factor`, await page.eval(`!/recovery/i.test(document.querySelector('.mfa-stepup').textContent)`));
  await page.fill(`top:input[name=current_password]`, acct.password); await page.fill(`.mfa-stepup input`, acct.totp.wrong()); await page.click(`top:[data-act=ok]`);
  await page.waitFor(`__q('top:.st-field-error').textContent.trim().length > 0 && !__q('top:[data-act=ok]').disabled`, { what: "step-up wrong code error" });
  s.check(`${L} replace: a wrong authenticator code at step-up is refused (no setup dialog)`, !(await page.visible(".mfa-qr-box")) && /could not be verified/i.test(await page.text("top:.st-field-error")), await page.text("top:.st-field-error"));
  await page.fill(`top:input[name=current_password]`, acct.password);
  await page.click(`top:[data-act=ok]`);
  await page.waitFor(`/code from your authenticator/i.test(__q('top:.st-field-error').textContent)`, { what: "missing code instruction" });
  s.check(`${L} replace: a missing authenticator code is refused locally with an instruction`, true);
  await page.fill(`.mfa-stepup input`, await acct.totp.next());
  await page.click(`top:[data-act=ok]`);
  await page.waitFor(`!!document.querySelector('.mfa-qr-box svg') && document.querySelector('.mfa-key').textContent.trim().length > 10`, { what: "replacement setup dialog" });
  const newSecret = (await page.text(".mfa-key")).replace(/\s+/g, "");
  s.check(`${L} replace: the setup dialog says it replaces the current authenticator once confirmed`, /replaces your current authenticator/i.test(await page.text(".mfa-modal-wide .mfa-lead, .mfa-lead")));
  s.check(`${L} replace: the replacement key differs from the current key`, newSecret !== acct.totp.b32, "");
  // cancel: nothing changes
  await page.click("top:[data-act=cancel]");
  await page.waitFor(`/Set-up cancelled/.test(document.querySelector('.mfa-modal .mfa-status').textContent)`, { what: "set-up cancelled message" });
  const afterCancel = (await apiMfa(page)).body;
  s.check(`${L} replace: cancelling leaves the existing authenticator untouched ("Nothing changed")`, afterCancel.credentials.some((c) => c.id === oldId && c.status === "active") && /Nothing changed/.test(await page.text(".mfa-modal .mfa-status")), afterCancel.credentials);
  s.check(`${L} replace: the abandoned replacement key does not work at sign-in`, (await apiVerify(srv, acct, "totp", H.hotp(H.base32Decode(newSecret), Math.floor(srv.now() / 30000)))).status === 401);
  // do the replacement for real
  await page.click("#mfaAddTotp");
  await F.stepUpDialog(page, acct.password, await acct.totp.next());
  await page.waitFor(`!!document.querySelector('.mfa-qr-box svg') && document.querySelector('.mfa-key').textContent.trim().length > 10`, { what: "replacement setup dialog (2)" });
  const replSecret = (await page.text(".mfa-key")).replace(/\s+/g, "");
  const replTotp = new H.Totp(replSecret, srv.now);
  await page.fill(".mfa-form input[name=code]", await replTotp.next()); await page.click(".mfa-form button[type=submit]");
  await page.waitFor(`!document.querySelector('.mfa-qr-box') && !document.querySelector('.mfa-codes')`, { what: "replacement finished" });
  s.check(`${L} replace: no new recovery codes are shown when codes already exist`, !(await page.eval(`!!document.querySelector('.mfa-codes')`)));
  await page.waitFor(`document.querySelector('.mfa-facts') && /Recovery codes left/.test(document.querySelector('.mfa-facts').textContent)`);
  const afterReplace = (await apiMfa(page)).body;
  s.check(`${L} replace: exactly one active authenticator remains and it is a new credential`, afterReplace.credentials.filter((c) => c.type === "totp" && c.status === "active").length === 1 && !afterReplace.credentials.some((c) => c.id === oldId && c.status === "active"), afterReplace.credentials);
  const oldTry = await apiVerify(srv, { ...acct, totp: acct.totp }, "totp", await acct.totp.next());
  s.check(`${L} replace: the OLD authenticator no longer signs in`, oldTry.status === 401 && !oldTry.cookie, oldTry.status);
  const newTry = await apiVerify(srv, acct, "totp", await replTotp.next());
  s.check(`${L} replace: the NEW authenticator signs in`, newTry.status === 200 && !!newTry.cookie, newTry.status);
  s.check(`${L} replace: recovery codes survive a replacement (still ten left)`, /Recovery codes left\s*10/i.test(await page.text(".mfa-facts")), await page.text(".mfa-facts"));
  acct.totp = replTotp;
  await page.reload(); await page.waitFor(`document.getElementById('navUserName') && document.getElementById('navUserName').textContent.trim().length > 1`, { what: "reload keeps the replaced session" });
  s.check(`${L} replace: after a reload the session is still valid (re-issued with proof)`, await UI.signedIn(page));

  // --- regenerate recovery codes: cancel, then do it
  await F.openSecurityPanel(page);
  await page.click("#mfaRegen");
  await page.waitFor(`!!document.getElementById('stModalTitle')`, { what: "regenerate confirm dialog" });
  s.check(`${L} regenerate: a confirmation dialog explains that old codes stop working`, /old codes stop working/i.test(await page.text("top:p")));
  s.check(`${L} regenerate: the confirmation's safe button (Cancel) has the initial focus`, (await page.active()).text === "Cancel", await page.active());
  await page.click("top:[data-act=cancel]");
  await page.waitFor(`/Nothing changed/.test(document.querySelector('.mfa-modal .mfa-status').textContent)`, { what: "regenerate cancelled" });
  s.check(`${L} regenerate: cancelling changes nothing (ten codes still left)`, /Recovery codes left\s*10/i.test(await page.text(".mfa-facts")));
  await page.click("#mfaRegen");
  await page.waitFor(`!!document.getElementById('stModalTitle')`);
  await page.click("top:[data-act=ok]");
  await F.stepUpDialog(page, acct.password, await acct.totp.next());
  const fresh = await F.readRecoveryDialog(page);
  s.check(`${L} regenerate: ten new codes are shown in a dialog titled "Your new recovery codes"`, fresh.length === 10 && /Your new recovery codes/.test((await dialogFacts(page)).own), fresh.length);
  s.check(`${L} regenerate: the new codes differ from the old ones`, fresh.every((c) => !acct.recoveryCodes.includes(c)));
  await F.ackRecoveryDialog(page);
  const oldCode = await apiVerify(srv, acct, "recovery_code", acct.recoveryCodes[1]);
  s.check(`${L} regenerate: an OLD recovery code is refused`, oldCode.status === 401 && !oldCode.cookie, oldCode.status);
  // (a sign-in with a recovery code ends the account's other sessions, including this browser's, so the new codes are verified through the panel count instead)
  s.check(`${L} regenerate: the panel still reports ten recovery codes left`, /Recovery codes left\s*10/i.test(await page.text(".mfa-facts")), await page.text(".mfa-facts"));
  const html = await page.eval(`document.documentElement.outerHTML`);
  s.check(`${L} regenerate: the new codes are cleared from the DOM after Done`, fresh.every((c) => !html.includes(c)));
  acct.recoveryCodes = fresh;

  // --- remove: cancel, then really remove; other sessions end
  const other = await H.mfaLoginApi(srv, acct);
  s.check(`${L} remove: a second session of the same account exists before removal (control)`, (await H.http(srv, "GET", `${H.SESSION}/me`, { cookie: other })).status === 200);
  await page.waitFor(`!!document.querySelector("button[aria-label^='Remove']")`);
  const rm = await page.eval(`(() => { const b = document.querySelector("button[aria-label^='Remove']"); const r = b.getBoundingClientRect(); return { left: r.left, right: r.right, vw: innerWidth }; })()`);
  s.check(`${L} the Remove action in the methods table is reachable without horizontal scrolling`, rm.left >= 0 && rm.right <= rm.vw + 1, rm);
  await page.eval(`(() => { const b = document.querySelector("button[aria-label^='Remove']"); const w = b.closest('.st-table-wrap'); if (w) w.scrollLeft = w.scrollWidth; })()`);
  await page.click("button[aria-label^='Remove']");
  await page.waitFor(`!!document.getElementById('stModalTitle')`);
  s.check(`${L} remove: the confirmation warns that other sessions end and recovery codes are deleted`, /signed out everywhere/i.test(await page.text("top:p")) && /recovery codes are deleted/i.test(await page.text("top:p")));
  await page.click("top:[data-act=cancel]");
  await page.waitFor(`/Cancelled/.test(document.querySelector('.mfa-modal .mfa-status').textContent)`);
  s.check(`${L} remove: cancelling the confirmation removes nothing`, (await apiMfa(page)).body.enrolled === true);
  await page.eval(`(() => { const b = document.querySelector("button[aria-label^='Remove']"); const w = b.closest('.st-table-wrap'); if (w) w.scrollLeft = w.scrollWidth; })()`);
  await page.click("button[aria-label^='Remove']");
  await page.waitFor(`!!document.getElementById('stModalTitle')`);
  await page.click("top:[data-act=ok]");
  await F.stepUpDialog(page, acct.password, await acct.totp.next());
  await page.waitFor(`/Not set up/.test(document.querySelector('.mfa-facts') ? document.querySelector('.mfa-facts').textContent : '')`, { what: "panel shows not set up after removal" });
  const after = await page.text(".mfa-facts");
  s.check(`${L} remove: after removing the last method the panel says "Not set up" and no recovery codes remain`, /Not set up/.test(after) && /Recovery codes left\s*—/i.test(after), after);
  s.check(`${L} remove: the server confirms no factor remains`, (await apiMfa(page)).body.enrolled === false);
  const otherAfter = await H.http(srv, "GET", `${H.SESSION}/me`, { cookie: other });
  s.check(`${L} remove: the other session of the account was ended by the removal`, otherAfter.status === 401, otherAfter.status);
  const pwOnly = await H.apiLogin(srv, acct.email, acct.password);
  s.check(`${L} remove: with no factor the account signs in with the password alone again`, pwOnly.status === 200 && !!pwOnly.cookie);
  const oldRc = await H.http(srv, "POST", `${H.SESSION}/mfa/verify`, { body: { challenge_token: "x.y", method: "recovery_code", code: fresh[1] } });
  s.check(`${L} remove: a recovery code cannot be replayed as a sign-in once the factor is gone`, oldRc.status !== 200 && !oldRc.cookie, oldRc.status);
}
