"use strict";
// D7 (part: d7b-grace-guard): governed apply of the enforcement policy through the UI, stale-version conflict, lowering; the enrolment grace banner; forced enrolment with a mailbox code once the
// grace period has ended; the last-factor guard for a required role. A second server is used on which the fleet is attested and the recovery procedure approved.
const H = require("./lib/harness.js");
const F = require("./lib/flows.js");
const { UI } = H;

async function gotoPeople(page) {
  await page.eval(`location.hash = '#/settings/people'`);
  await page.waitFor(`!!document.getElementById('mfaEnfCurrent') && !!document.querySelector('.mfa-reset, .st-denied')`, { what: "People & Access cards", timeout: 25000 });
  await page.settle();
}
const lastMailCode = (srv, to) => { const m = srv.mails().filter((x) => x.to === to && /verification code/i.test(x.subject || "")).pop(); const r = m && /is:\s*(\d+)/.exec(m.text || ""); return r ? r[1] : null; };
const enfApi = async (srv, actor) => (await H.getEnforcement(srv, actor)).json.setting;

H.runSuite("d7b-grace-guard", async (s) => {
  s.only = ["grace","last-factor"];
  const srv = await H.startServer(s, { env: { LEAD_AGENTS_MFA_FLEET_ATTESTED: "s7.5.7", LEAD_AGENTS_MFA_RECOVERY_APPROVED: "true", LEAD_AGENTS_MFA_REQUIRED_ROLES: "ochiga_staff" } });
  const root = await H.enrollRoot(srv);
  const adminCk = await H.adminCookie(srv);
  const chrome = await H.launchChrome(s);
  const grace = {}; const forced = {};
  for (const w of H.WIDTHS) { grace[w] = await H.freshAccount(srv, adminCk, { enroll: false, tag: `g${w}`, role: "ochiga_admin" }); forced[w] = await H.freshAccount(srv, adminCk, { enroll: false, tag: `f${w}`, role: "ochiga_admin" }); }
  const guarded = await H.freshAccount(srv, adminCk, { tag: "req", role: "ochiga_staff" });
  const sa1 = await H.freshAccount(srv, adminCk, { tag: "pol1", role: "super_admin" });
  const sa2 = await H.freshAccount(srv, adminCk, { tag: "pol2", role: "super_admin" });

  // ================================================================ governed apply through the UI (1440 and 390)
  for (const w of [1440, 390]) {
    await s.guard(`apply-${w}`, async () => {
      const L = `[${w}px apply]`;
      const actor = w === 1440 ? sa1 : sa2;
      const before = await enfApi(srv, actor);
      // make sure every run starts from "off" so that raising is a real change
      if (before.value !== "off") { const r = await H.setEnforcementApi(srv, "off", { actor }); s.check(`${L} fixture: lowering to off through the API works`, r.status === 200, r.text.slice(0, 160)); }
      const cur = await enfApi(srv, actor);
      const page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w);
      await F.signInTotp(page, srv, actor);
      await gotoPeople(page);
      await page.click("#mfaLevel_privileged");
      await page.waitFor(`document.querySelectorAll('.mfa-checks li').length >= 6`, { what: "preflight" });
      const checks = await page.eval(`[...document.querySelectorAll('.mfa-checks li')].map((li) => [li.dataset.check, li.dataset.state])`);
      s.check(`${L} with fleet attested and recovery approved, no required check fails`, checks.every(([, st]) => st !== "fail"), checks);
      s.check(`${L} an allowed change shows no "blocked" alert`, !(await page.eval(`!!document.querySelector('.mfa-blocked')`)));
      const rows = await page.eval(`[...document.querySelectorAll('.mfa-deadlines tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent.trim()))`);
      s.check(`${L} the preflight lists the unenrolled people the level would cover, with a deadline`, rows.length >= 1 && rows.every((r) => r.length === 3 && r[2].length > 5), rows.slice(0, 3));
      s.check(`${L} the deadlines table has a caption and column headers`, await page.eval(`(() => { const t = document.querySelector('.mfa-deadlines'); return !!t && !!t.querySelector('caption') && t.querySelectorAll('th[scope=col]').length === 3; })()`));
      s.check(`${L} Apply is disabled until the person ticks the confirmation`, await page.eval(`document.querySelector('.mfa-apply button[type=submit]').disabled === true`));
      await page.click(".mfa-apply input[name=confirm]");
      s.check(`${L} after the confirmation tick, Apply becomes available`, await page.eval(`document.querySelector('.mfa-apply button[type=submit]').disabled === false`));
      await page.click(".mfa-apply button[type=submit]");
      await page.waitFor(`!!document.getElementById('stStepUpTitle') && !!document.querySelector('.mfa-stepup input')`, { what: "policy step-up with factor" });
      s.check(`${L} the policy write asks for the password and a fresh authenticator code (security_policy_write step-up)`, /two-step requirement/i.test(await page.text("top:h3")), await page.text("top:h3"));
      await page.fill(`top:input[name=current_password]`, actor.password); await page.fill(`.mfa-stepup input`, actor.totp.wrong()); await page.click(`top:[data-act=ok]`);
      await page.waitFor(`__q('top:.st-field-error').textContent.trim().length > 0 && !__q('top:[data-act=ok]').disabled`, { what: "wrong factor refused" });
      s.check(`${L} a wrong code at the policy step-up is refused and nothing is saved (server value unchanged)`, (await enfApi(srv, actor)).value === "off");
      await page.fill(`top:input[name=current_password]`, actor.password); await page.fill(`.mfa-stepup input`, await actor.totp.next()); await page.click(`top:[data-act=ok]`);
      await page.waitFor(`/Privileged/.test(document.getElementById('mfaEnfCurrent') ? document.getElementById('mfaEnfCurrent').textContent : '')`, { what: "card re-rendered with the new level", timeout: 20000 });
      const after = await enfApi(srv, actor);
      s.check(`${L} the server stored the new level and bumped the version`, after.value === "privileged" && after.version === cur.version + 1, { before: cur.version, after });
      s.check(`${L} the card shows the server-confirmed level`, /Privileged/.test(await page.text("#mfaEnfCurrent")), await page.text("#mfaEnfCurrent"));
      s.check(`${L} the version shown matches the stored version`, (await page.text("#mfaEnfVersion")).startsWith(String(after.version)), await page.text("#mfaEnfVersion"));
      const la = await H.layoutAudit(page, { scope: ".st-card" });
      s.check(`${L} after applying, no horizontal overflow`, !H.hasHScroll(la), la);

      // ---- stale version: another administrator changes the level behind the open page
      const lower = await H.setEnforcementApi(srv, "optional", { actor: w === 1440 ? sa2 : sa1 });
      s.check(`${L} control: another administrator lowers the level (version moves on)`, lower.status === 200, lower.text.slice(0, 160));
      await page.click("#mfaLevel_all");
      await page.waitFor(`document.querySelectorAll('.mfa-checks li').length >= 6 || document.querySelector('.mfa-counts, #mfaCounts')`, { what: "preflight for all" });
      await page.click(".mfa-apply input[name=confirm]");
      await page.click(".mfa-apply button[type=submit]");
      await page.waitFor(`!!document.getElementById('stStepUpTitle')`);
      await page.fill(`top:input[name=current_password]`, actor.password); await page.fill(`.mfa-stepup input`, await actor.totp.next()); await page.click(`top:[data-act=ok]`);
      await page.waitFor(`document.querySelector('.mfa-apply .st-field-error').textContent.trim().length > 0`, { what: "conflict message", timeout: 20000 });
      s.check(`${L} a stale page cannot overwrite: the conflict is reported ("changed since you loaded")`, /changed since you loaded/i.test(await page.text(".mfa-apply .st-field-error")), await page.text(".mfa-apply .st-field-error"));
      s.check(`${L} the conflict was not applied (server still "optional")`, (await enfApi(srv, actor)).value === "optional");
      s.check(`${L} the conflict message is in a role=alert region`, await page.eval(`document.querySelector('.mfa-apply .st-field-error').getAttribute('role') === 'alert'`));

      // ---- lowering from the UI is never blocked
      await page.reload(); await page.waitFor(`document.getElementById('navUserName') && document.getElementById('navUserName').textContent.trim().length > 1`);
      await gotoPeople(page);
      s.check(`${L} after a reload the card shows the level the server holds ("Optional")`, /Optional/.test(await page.text("#mfaEnfCurrent")), await page.text("#mfaEnfCurrent"));
      await page.click("#mfaLevel_off");
      await page.waitFor(`/never blocked/i.test(document.querySelector('.mfa-preflight h4') ? document.querySelector('.mfa-preflight h4').textContent : '')`, { what: "lowering heading" });
      s.check(`${L} choosing a lower level says lowering is never blocked and lists no failing check`, !(await page.eval(`!!document.querySelector('.mfa-blocked')`)));
      await page.click(".mfa-apply input[name=confirm]"); await page.click(".mfa-apply button[type=submit]");
      await page.waitFor(`!!document.getElementById('stStepUpTitle')`);
      await page.fill(`top:input[name=current_password]`, actor.password); await page.fill(`.mfa-stepup input`, await actor.totp.next()); await page.click(`top:[data-act=ok]`);
      await page.waitFor(`/Off/.test(document.getElementById('mfaEnfCurrent') ? document.getElementById('mfaEnfCurrent').textContent : '')`, { what: "lowered to off", timeout: 20000 });
      s.check(`${L} lowering to Off through the UI is accepted and stored`, (await enfApi(srv, actor)).value === "off");
      await H.privacyAudit(s, page, srv, L, [actor.password, actor.totp.b32, ...(actor.recoveryCodes || [])]);
      await page.close();
    });
  }

  // raise to privileged for the rest of the file (fixture, through the governed API)
  const raised = await H.setEnforcementApi(srv, "privileged", { actor: sa1 });
  s.check("D7 fixture: the requirement is raised to privileged through the governed API", raised.status === 200, raised.text.slice(0, 200));

  // ================================================================ the grace banner
  for (const w of H.WIDTHS) {
    await s.guard(`grace-${w}`, async () => {
      const L = `[${w}px grace]`;
      const acct = grace[w];
      const page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w);
      await F.signInPasswordOnly(page, srv, acct);
      s.check(`${L} within the set-up period a password alone still signs the person in`, await UI.signedIn(page));
      await page.waitFor(`!!document.getElementById('mfaGraceBanner')`, { what: "grace banner", timeout: 15000 });
      const txt = await page.text("#mfaGraceBanner .mfa-banner-text");
      s.check(`${L} the banner states the deadline and the days left`, /required for your account by .+\(\d+ days? left\)/.test(txt), txt);
      s.check(`${L} the days left are 14 or 13 right after the requirement started`, /\((13|14) days? left\)/.test(txt), txt);
      s.check(`${L} the banner is a status region with a Set up now and a Dismiss button`, await page.eval(`(() => { const b = document.getElementById('mfaGraceBanner'); return b.getAttribute('role') === 'status' && !!b.querySelector('[data-act=setup]') && !!b.querySelector('[data-act=dismiss]'); })()`));
      const la = await H.layoutAudit(page, { scope: "#mfaGraceBanner" });
      s.check(`${L} the banner has no horizontal overflow and stays in the viewport`, !H.hasHScroll(la) && la.overflowing.length === 0, la);
      if (w <= 768) s.check(`${L} the banner buttons are at least 44px`, la.small.length === 0, la.small);
      const ax = await page.axTree();
      s.check(`${L} the banner text and both buttons are in the accessibility tree`, ax.some((n) => n.role === "button" && /Set up now/.test(n.name)) && ax.some((n) => n.role === "button" && /Dismiss/.test(n.name)), ax.filter((n) => n.role === "button").map((n) => n.name).slice(0, 12));
      await page.click("#mfaGraceBanner [data-act=dismiss]");
      s.check(`${L} Dismiss removes the banner`, !(await page.eval(`!!document.getElementById('mfaGraceBanner')`)));
      await page.reload(); await page.waitFor(`document.getElementById('navUserName') && document.getElementById('navUserName').textContent.trim().length > 1`);
      await page.waitFor(`!!document.getElementById('mfaGraceBanner')`, { what: "banner returns after reload", timeout: 15000 });
      s.check(`${L} the dismissal lasts only for the page view (the banner is back after a reload)`, true);
      await page.click("#mfaGraceBanner [data-act=setup]");
      await page.waitFor(`!!document.querySelector('.mfa-modal .mfa-facts')`, { what: "panel opened from the banner" });
      const facts = await page.text(".mfa-modal .mfa-facts");
      s.check(`${L} "Set up now" opens the two-step panel which says the account is required to set it up`, /Required for your account\s*Yes/i.test(facts) && /Not set up/.test(facts), facts);
      s.check(`${L} the panel names the deadline for the person`, /Two-step verification is required for your account by/.test(await page.text(".mfa-modal .mfa-grace")), await page.text(".mfa-modal .mfa-grace"));
      await H.privacyAudit(s, page, srv, L, [acct.password]);
      await page.close();
    });
  }

  // ================================================================ last-factor guard for a required role
  await s.guard("last-factor", async () => {
    const L = "[required role]";
    const page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(1100);
    await F.signInTotp(page, srv, guarded);
    await F.openSecurityPanel(page);
    const facts = await page.text(".mfa-facts");
    s.check(`${L} the panel says two-step verification is required for this account`, /Required for your account\s*Yes/i.test(facts), facts);
    await page.eval(`(() => { const b = document.querySelector("button[aria-label^='Remove']"); const w = b.closest('.st-table-wrap'); if (w) w.scrollLeft = w.scrollWidth; })()`);
    await page.click("button[aria-label^='Remove']");
    await page.waitFor(`!!document.getElementById('stModalTitle')`);
    s.check(`${L} the confirmation says the last method cannot be removed`, /can.t be removed|last method/i.test(await page.text("top:p")), await page.text("top:p"));
    await page.click("top:[data-act=ok]");
    await F.stepUpDialog(page, guarded.password, await guarded.totp.next());
    await page.waitFor(`/Not removed/.test(document.querySelector('.mfa-modal .mfa-status').textContent)`, { what: "refusal", timeout: 20000 });
    s.check(`${L} removal of the last method is refused with an explanation`, /last two-step method/i.test(await page.text(".mfa-modal .mfa-status")), await page.text(".mfa-modal .mfa-status"));
    s.check(`${L} the method is still active on the server`, await page.eval(`fetch('/api/lead-agents/admin/session/mfa').then(r => r.json()).then(j => j.enrolled === true && j.credentials.filter(c => c.status === 'active').length === 1)`));
    const cookie = await page.sessionCookie();
    s.check(`${L} the refusal did not end the session`, (await H.http(srv, "GET", `${H.SESSION}/me`, { cookie: `${cookie.name}=${cookie.value}` })).status === 200);
    // the API says the same
    const ck = await H.mfaLoginApi(srv, guarded);
    const su = await H.apiStepUp(srv, ck, "mfa_management", guarded.password, { method: "totp", code: await guarded.totp.next() });
    const info = await H.http(srv, "GET", `${H.SESSION}/mfa`, { cookie: ck });
    const id = info.json.credentials.find((c) => c.status === "active").id;
    const rm = await H.http(srv, "POST", `${H.SESSION}/mfa/credentials/${id}/remove`, { cookie: ck, headers: { "x-step-up-token": su.json.step_up.token }, body: {} });
    s.check(`${L} the API refuses it as well (409 last_factor)`, rm.status === 409 && rm.json && rm.json.error === "last_factor", { status: rm.status, body: rm.json });
    await page.close();
  });

  // ================================================================ forced enrolment (the set-up period has ended): every width
  if (s.only.some((p) => p.startsWith("forced")) ) await srv.shiftClock(15 * 24 * 3600 * 1000); // past the 14-day set-up period (and past the 7-day sessions: everyone signs in again)
  for (const w of H.WIDTHS) {
    await s.guard(`forced-${w}`, async () => {
      const L = `[${w}px forced]`;
      const acct = forced[w];
      const page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w);
      await UI.openLogin(page, srv);
      await UI.submitPassword(page, acct.email, acct.password);
      await page.waitFor(`!!document.getElementById('mfaForced')`, { what: "forced enrolment screen", timeout: 15000 });
      s.check(`${L} after the set-up period, a correct password does NOT sign in: forced enrolment is shown`, !(await UI.signedIn(page)) && !(await UI.sessionCookiePresent(page)));
      s.check(`${L} forced enrolment: title and explanation are shown`, /Set up two-step verification/.test(await page.text("#authCardTitle")) && /mailbox/.test(await page.text("#mfaForced")), await page.text("#authCardTitle"));
      s.check(`${L} forced enrolment: focus is on the "Send the code" button`, await page.eval(`document.activeElement && document.activeElement.getAttribute('data-act') === 'send'`), await page.active());
      s.check(`${L} forced enrolment: only an authenticator app is offered (no security-key ceremony)`, !(await page.eval(`/security key/i.test(document.getElementById('mfaForced').textContent)`)));
      s.check(`${L} forced enrolment: a protected API call is still refused`, (await page.eval(`fetch('/api/lead-agents/admin/session/me').then(r => r.status)`)) === 401);
      let la = await H.layoutAudit(page, { scope: "#loginScreen" });
      s.check(`${L} forced enrolment (send step): no horizontal overflow`, !H.hasHScroll(la), la);
      if (w <= 768) s.check(`${L} forced enrolment (send step): controls are at least 44px`, la.small.length === 0, la.small);
      await page.click("#mfaForced [data-act=send]");
      await page.waitFor(`!!document.querySelector('#mfaForced input[name=code]')`, { what: "mailbox code field" });
      s.check(`${L} forced enrolment: the code step says the response is neutral ("If the sign-in is valid, a code was sent")`, /If the sign-in is valid/.test(await page.text("#mfaForced")), await page.text("#mfaForced"));
      s.check(`${L} forced enrolment: focus moves into the code field`, (await page.active()).name === "code", await page.active());
      const mailCode = lastMailCode(srv, acct.email);
      s.check(`${L} the mailbox code reached the (stubbed) mailbox and is numeric`, !!mailCode && /^\d+$/.test(mailCode), mailCode);
      const stated = /(\d+)-digit code from your email/.exec(await page.text("#mfaForced"));
      s.check(`${L} the length the page announces matches the code actually e-mailed`, !!stated && !!mailCode && Number(stated[1]) === mailCode.length, { page: stated && stated[1], mail: mailCode && mailCode.length });
      const mail = srv.mails().filter((m) => m.to === acct.email).pop();
      s.check(`${L} the mail carries no password, session or challenge token`, mail && !mail.text.includes(acct.password) && !/eyJ[A-Za-z0-9_-]{20,}/.test(mail.text), "");
      // wrong code first
      await page.fill("#mfaForced input[name=code]", mailCode === "00000000" ? "11111111" : "00000000");
      await page.click("#mfaForced button[type=submit]");
      await page.waitFor(`document.querySelector('#mfaForced .mfa-error').classList.contains('visible') && document.querySelector('#mfaForced .mfa-status').textContent === ''`, { what: "wrong mailbox code" });
      s.check(`${L} a wrong mailbox code is refused with an announced message and no session`, !(await UI.sessionCookiePresent(page)) && (await page.text("#mfaForced .mfa-error")).trim().length > 0, await page.text("#mfaForced .mfa-error"));
      // reload mid-way: nothing is signed in, restart works
      if (w === 1100) {
        await page.reload(); await page.waitFor(`document.getElementById('loginForm').dataset.wired === '1'`);
        s.check(`${L} reload in the middle of forced enrolment returns to plain sign-in without a session`, await page.eval(`document.body.classList.contains('auth-logged-out') && !document.getElementById('mfaForced')`) && !(await UI.sessionCookiePresent(page)));
        await UI.submitPassword(page, acct.email, acct.password);
        await page.waitFor(`!!document.getElementById('mfaForced')`);
        await page.click("#mfaForced [data-act=send]");
        await page.waitFor(`!!document.querySelector('#mfaForced input[name=code]')`);
      }
      const code2 = lastMailCode(srv, acct.email);
      await page.fill("#mfaForced input[name=code]", code2);
      await page.click("#mfaForced button[type=submit]");
      await page.waitFor(`!!document.querySelector('.mfa-qr-box svg') && document.querySelector('.mfa-key').textContent.trim().length > 10`, { what: "authenticator setup in forced mode", timeout: 20000 });
      s.check(`${L} the right mailbox code leads to the authenticator setup (QR drawn locally)`, true);
      s.check(`${L} still no session while the setup is in progress`, !(await UI.sessionCookiePresent(page)) && !(await UI.signedIn(page)));
      const secret = (await page.text(".mfa-key")).replace(/\s+/g, "");
      const totp = new H.Totp(secret, srv.now);
      la = await H.layoutAudit(page, { scope: "top:.st-modal" });
      s.check(`${L} forced setup dialog: no horizontal overflow`, !H.hasHScroll(la), la);
      await page.fill(".mfa-form input[name=code]", await totp.next()); await page.click(".mfa-form button[type=submit]");
      const codes = await F.readRecoveryDialog(page);
      s.check(`${L} forced enrolment ends with ten recovery codes shown once`, codes.length === 10, codes.length);
      s.check(`${L} the recovery codes are shown before any session exists`, !(await UI.sessionCookiePresent(page)));
      await F.ackRecoveryDialog(page);
      await page.waitFor(`document.getElementById('loginError').classList.contains('visible')`, { what: "back-to-sign-in message", timeout: 10000 });
      s.check(`${L} afterwards the person is sent back to sign in with a confirmation ("set up. Sign in again")`, /set up\. Sign in again/i.test(await UI.loginError(page)) && !(await UI.signedIn(page)), await UI.loginError(page));
      s.check(`${L} the recovery codes are gone from the page`, !(await page.eval(`document.documentElement.outerHTML`)).includes(codes[0]));
      acct.totp = totp; acct.recoveryCodes = codes;
      await UI.submitPassword(page, acct.email, acct.password); await UI.waitChallenge(page);
      await page.fill("#mfaChallenge [data-panel=totp] input", await totp.next()); await page.click("#mfaChallenge [data-panel=totp] button[type=submit]");
      await UI.waitSignedIn(page);
      s.check(`${L} signing in with the new authenticator works (positive control)`, await UI.signedIn(page));
      s.check(`${L} the grace banner is gone once enrolled`, !(await page.eval(`!!document.getElementById('mfaGraceBanner')`)));
      // the mailbox code is single use: it cannot start a second enrolment
      const again = await H.apiLogin(srv, acct.email, acct.password);
      s.check(`${L} an enrolled account no longer gets a forced-enrolment answer`, !!again.json && again.json.mfa_required === true && !again.json.mfa_enrollment_required, again.json && Object.keys(again.json));
      await H.privacyAudit(s, page, srv, L, [acct.password, secret, mailCode, code2, ...codes]);
      await page.close();
    });
  }

  // ================================================================ expired mailbox code
  await s.guard("mail-expiry", async () => {
    const L = "[mailbox code expiry]";
    const acct = await H.freshAccount(srv, adminCk, { enroll: false, tag: "mx", role: "ochiga_admin" });
    const page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(900);
    await UI.openLogin(page, srv); await UI.submitPassword(page, acct.email, acct.password);
    await page.waitFor(`!!document.getElementById('mfaForced')`, { timeout: 15000 });
    await page.click("#mfaForced [data-act=send]");
    await page.waitFor(`!!document.querySelector('#mfaForced input[name=code]')`);
    const code = lastMailCode(srv, acct.email);
    await srv.shiftClock(20 * 60_000);
    await page.fill("#mfaForced input[name=code]", code); await page.click("#mfaForced button[type=submit]");
    await page.waitFor(`document.querySelector('#mfaForced .mfa-error').classList.contains('visible') && document.querySelector('#mfaForced .mfa-status').textContent === ''`, { what: "expired mailbox code message", timeout: 15000 });
    s.check(`${L} an expired sign-in/mailbox code is refused (no authenticator setup, no session)`, !(await page.eval(`!!document.querySelector('.mfa-qr-box')`)) && !(await UI.sessionCookiePresent(page)), await page.text("#mfaForced .mfa-error"));
    s.check(`${L} the message tells the person what to do next`, /expired|sign in again|try again/i.test(await page.text("#mfaForced .mfa-error")), await page.text("#mfaForced .mfa-error"));
    await page.close();
  });
});
