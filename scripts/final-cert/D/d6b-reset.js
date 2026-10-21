"use strict";
// D6 (part: d6b-reset): the administrator screens in Settings -> People & Access: enforcement policy (preflight, blocked apply, bypass attempt), layout at five widths,
// and the administrator reset of someone else's two-step verification (confirmation, step-up with a fresh factor, effects on the target).
const H = require("./lib/harness.js");
const F = require("./lib/flows.js");
const { UI } = H;

async function gotoPeople(page) {
  await page.eval(`location.hash = '#/settings/people'`);
  await page.waitFor(`!!document.getElementById('mfaEnfCurrent') && !!document.querySelector('.mfa-reset, .st-denied')`, { what: "People & Access cards", timeout: 25000 });
  await page.settle();
}
async function markMfaCards(page) {
  await page.eval(`[...document.querySelectorAll('.st-card')].forEach((c) => { if (/Two-step verification|Reset someone/.test((c.querySelector('h3') || {}).textContent || '')) c.setAttribute('data-d-audit', '1'); })`);
}
const checkText = (page) => page.eval(`[...document.querySelectorAll('.mfa-checks li')].map((li) => ({ id: li.dataset.check, state: li.dataset.state, text: li.textContent.trim() }))`);

H.runSuite("d6b-reset", async (s) => {
  s.only = ["reset"];
  const srv = await H.startServer(s); // no fleet attestation, no recovery approval: raising the requirement must be blocked
  const root = await H.enrollRoot(srv);
  const adminCk = await H.adminCookie(srv);
  const chrome = await H.launchChrome(s);
  const target = await H.freshAccount(srv, adminCk, { tag: "tgt", role: "ochiga_admin" });
  const staff = await H.freshAccount(srv, adminCk, { tag: "stf", role: "ochiga_staff", enroll: false });

  // ================================================================ enforcement screens at five widths
  for (const w of H.WIDTHS) {
    await s.guard(`enf-${w}`, async () => {
      const L = `[${w}px policy]`;
      const first = w === H.WIDTHS[0];
      const actor = first ? root : await H.freshAccount(srv, adminCk, { tag: `sa${w}`, role: "super_admin" });
      const page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w);
      await F.signInTotp(page, srv, actor);
      await gotoPeople(page);
      await markMfaCards(page);
      s.check(`${L} the three cards (own methods, requirement, reset) are shown to a super administrator`, await page.eval(`document.querySelectorAll('[data-d-audit]').length >= 3`), await page.eval(`[...document.querySelectorAll('.st-card h3')].map(h => h.textContent)`));
      let la = await H.layoutAudit(page, { scope: "[data-d-audit]" });
      s.check(`${L} policy page: no horizontal overflow`, !H.hasHScroll(la), la);
      if (w <= 768) s.check(`${L} policy page: every control in the three cards is at least 44px`, la.small.length === 0, la.small);
      s.check(`${L} policy page: no control of the cards is placed outside the viewport`, la.overflowing.length === 0, la.overflowing);
      s.check(`${L} the current requirement is shown ("Off") with its version`, /Off/.test(await page.text("#mfaEnfCurrent")) && /\d/.test(await page.text("#mfaEnfVersion")), [await page.text("#mfaEnfCurrent"), await page.text("#mfaEnfVersion")]);
      s.check(`${L} the break-glass recovery state is shown truthfully ("off (normal)")`, /off \(normal\)/i.test(await page.text("#mfaRecoveryState")), await page.text("#mfaRecoveryState"));
      s.check(`${L} the four levels are offered as a labelled radio group`, await page.eval(`(() => { const f = document.querySelector('.mfa-levels'); return !!f && f.tagName === 'FIELDSET' && !!f.querySelector('legend') && f.querySelectorAll('input[type=radio]').length === 4 && [...f.querySelectorAll('input')].every((i) => !!i.closest('label')); })()`));
      s.check(`${L} the reset card hides the signed-in administrator from its choices`, await page.eval(`![...document.querySelectorAll('.mfa-reset select option')].some((o) => o.textContent.includes(${JSON.stringify(actor.email)}))`));
      const ax = await page.axTree();
      s.check(`${L} radios expose role radio with their level names`, ["Off", "Optional", "Privileged accounts", "Everyone"].every((n) => ax.some((x) => x.role === "radio" && x.name.includes(n))), ax.filter((x) => x.role === "radio").map((x) => x.name));
      s.check(`${L} the reset form fields have accessible names`, ["Person", "Reason", "email"].every((n) => ax.some((x) => (x.role === "combobox" || x.role === "textbox" || x.role === "listbox" || x.role === "menu") && new RegExp(n, "i").test(x.name))), ax.filter((x) => /combobox|textbox|listbox/.test(x.role)).map((x) => x.name));

      // ---- choose a level that the server will refuse: the preflight explains, Apply stays off
      await page.click("#mfaLevel_privileged");
      await page.waitFor(`document.querySelectorAll('.mfa-checks li').length >= 6`, { what: "preflight checks" });
      const checks = await checkText(page);
      const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
      s.check(`${L} preflight lists every readiness check with a state and plain words`, ["mfa_machinery", "schema_ready", "actor_enrolled", "actor_recovery_codes", "recovery_path", "mailbox_delivery", "fleet_attested", "api_key_fallback_off"].every((id) => byId[id] && byId[id].text.length > 15), checks.map((c) => c.id));
      s.check(`${L} preflight: the administrator's own enrolment and recovery codes are ready (positive controls)`, byId.actor_enrolled.state === "ok" && byId.actor_recovery_codes.state === "ok" && byId.mfa_machinery.state === "ok", checks);
      s.check(`${L} preflight: fleet attestation is NOT ready and the page says what to do`, byId.fleet_attested.state === "fail" && /owner/i.test(byId.fleet_attested.text), byId.fleet_attested);
      if (first) s.check(`${L} preflight: while no second administrator is enrolled and nothing is approved, the recovery path is NOT ready`, byId.recovery_path.state === "fail", byId.recovery_path);
      else s.check(`${L} preflight: once another super administrator is enrolled the recovery path becomes ready (state flips)`, byId.recovery_path.state === "ok", byId.recovery_path);
      s.check(`${L} status is not conveyed by colour alone (each check has a text mark and wording)`, await page.eval(`[...document.querySelectorAll('.mfa-checks li')].every((li) => !!li.querySelector('.mfa-mark') && li.querySelector('.mfa-mark').textContent.trim().length === 1 && li.textContent.trim().length > 15)`));
      s.check(`${L} a blocked change shows a role=alert explanation`, await page.eval(`(() => { const b = document.querySelector('.mfa-blocked'); return !!b && b.getAttribute('role') === 'alert' && /blocked/i.test(b.textContent); })()`));
      s.check(`${L} the counts show who would be covered`, /\d/.test(await page.text("#mfaCounts")), await page.text("#mfaCounts"));
      await page.click(".mfa-apply input[name=confirm]");
      s.check(`${L} even with "I confirm" ticked, Apply stays disabled while the change is blocked`, await page.eval(`document.querySelector('.mfa-apply button[type=submit]').disabled === true`));
      await page.click("#mfaLevel_all");
      await page.waitFor(`document.querySelector('.mfa-blocked')`, { what: "everyone is blocked too" });
      s.check(`${L} "Everyone" is blocked for the same reasons`, (await checkText(page)).some((c) => c.id === "fleet_attested" && c.state === "fail"));
      await page.click("#mfaLevel_optional");
      await page.waitFor(`/never blocked/i.test(document.querySelector('.mfa-preflight h4') ? document.querySelector('.mfa-preflight h4').textContent : '')`, { what: "lowering heading", timeout: 8000 }).catch(() => {});
      la = await H.layoutAudit(page, { scope: "[data-d-audit]" });
      s.check(`${L} after the preflight is shown the page still has no horizontal overflow`, !H.hasHScroll(la), la);
      // keyboard: arrow keys move through the radios and each change runs the check
      await page.focus("#mfaLevel_optional");
      await page.press("ArrowDown");
      await page.waitFor(`document.getElementById('mfaLevel_privileged').checked`, { what: "radio moved by keyboard" });
      s.check(`${L} ArrowDown moves the selection to the next level and runs its preflight (keyboard operation)`, await page.eval(`document.getElementById('mfaLevel_privileged').checked`));

      // ---- the UI is not the control: the same write over the API is refused with the server's own preflight
      if (w === 1440 || w === 390) {
        const cur = await H.getEnforcement(srv, actor);
        const attempt = await H.setEnforcementApi(srv, "privileged", { actor });
        s.check(`${L} bypass attempt: the API refuses to raise the requirement (412 preflight_failed)`, attempt.status === 412 && attempt.json && attempt.json.error === "preflight_failed", { status: attempt.status, body: attempt.json });
        s.check(`${L} bypass attempt: the failed checks are named (fleet_attested)`, attempt.json && (attempt.json.failed_checks || []).includes("fleet_attested"), attempt.json);
        const afterVer = await H.getEnforcement(srv, actor);
        s.check(`${L} bypass attempt: the stored requirement and version are unchanged`, afterVer.json.setting.value === cur.json.setting.value && afterVer.json.setting.version === cur.json.setting.version, afterVer.json.setting);
        const wrongPurpose = await H.setEnforcementApi(srv, "optional", { purpose: "mfa_management", actor });
        s.check(`${L} purpose isolation: a step-up grant for mfa_management cannot write the policy`, wrongPurpose.status === 403 && wrongPurpose.json && wrongPurpose.json.error === "step_up_required", { status: wrongPurpose.status, body: wrongPurpose.json });
        const noConfirm = await H.rootGrant(srv, "security_policy_write", undefined, actor).then((g) => H.http(srv, "PUT", H.ENF, { cookie: g.cookie, headers: { "x-step-up-token": g.token }, body: { value: "optional", expected_version: cur.json.setting.version } }));
        s.check(`${L} the policy write without the explicit confirm flag is refused`, noConfirm.status >= 400 && noConfirm.status < 500, noConfirm.status);
        const viaApiKey = await H.http(srv, "PUT", H.ENF, { headers: { "x-api-key": srv.apiKey }, body: { value: "optional", expected_version: cur.json.setting.version, confirm: true } });
        s.check(`${L} an API key cannot change the policy (human session required)`, viaApiKey.status === 401 || viaApiKey.status === 403, viaApiKey.status);
      }
      await H.privacyAudit(s, page, srv, L, [actor.password, actor.totp.b32, ...(actor.recoveryCodes || [])]);
      await page.close();
    });
  }

  // ================================================================ administrator reset (1440 and 390)
  for (const w of [1440, 390]) {
    await s.guard(`reset-${w}`, async () => {
      const L = `[${w}px reset]`;
      const actor = await H.freshAccount(srv, adminCk, { tag: `ra${w}`, role: "super_admin" });
      const victim = await H.freshAccount(srv, adminCk, { tag: `v${w}`, role: "ochiga_admin" });
      const victimSession = await H.mfaLoginApi(srv, victim);
      s.check(`${L} control: the person to be reset has a live session and enrolled factors`, (await H.http(srv, "GET", `${H.SESSION}/me`, { cookie: victimSession })).status === 200);
      const page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w);
      await F.signInTotp(page, srv, actor);
      await gotoPeople(page); await markMfaCards(page);
      const submitSel = ".mfa-reset button[type=submit]";
      s.check(`${L} Reset is disabled until a person, a reason, their email and the confirmation are given`, await page.eval(`document.querySelector('${submitSel}').disabled === true`));
      await page.eval(`(() => { const sel = document.querySelector('.mfa-reset select[name=user]'); sel.value = ${JSON.stringify(victim.id)}; sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await page.fill(".mfa-reset input[name=reason]", "ab");
      await page.fill(".mfa-reset input[name=email]", victim.email);
      await page.click(".mfa-reset input[name=confirm]");
      s.check(`${L} a two-character reason keeps Reset disabled (3 to 500 characters required)`, await page.eval(`document.querySelector('${submitSel}').disabled === true`));
      await page.fill(".mfa-reset input[name=reason]", "Lost phone, ticket 4711");
      await page.fill(".mfa-reset input[name=email]", "someone-else@example.test");
      await page.click(submitSel);
      await page.waitFor(`document.querySelector('.mfa-reset .st-field-error').textContent.trim().length > 0`, { what: "mismatch message" });
      s.check(`${L} a mistyped confirmation email is refused locally ("doesn't match") before any dialog opens`, /match/i.test(await page.text(".mfa-reset .st-field-error")) && !(await F.dialogOpen(page)), await page.text(".mfa-reset .st-field-error"));
      s.check(`${L} the mismatch message is announced (role=alert)`, await page.eval(`document.querySelector('.mfa-reset .st-field-error').getAttribute('role') === 'alert'`));
      await page.fill(".mfa-reset input[name=email]", victim.email.toUpperCase());
      await page.click(submitSel);
      await page.waitFor(`!!document.getElementById('stModalTitle')`, { what: "confirmation dialog" });
      s.check(`${L} a confirmation dialog names the person and the consequences`, /Reset two-step verification for/.test(await page.text("top:h3")) && /signed out everywhere/.test(await page.text("top:p")), await page.text("top:h3"));
      s.check(`${L} the confirmation's safe choice (Cancel) has the initial focus`, (await page.active()).text === "Cancel", await page.active());
      await page.click("top:[data-act=cancel]");
      await page.waitFor(`/Cancelled/.test(document.querySelector('.mfa-reset .st-form-status').textContent)`, { what: "cancel status" });
      s.check(`${L} cancelling changes nothing (the person's methods are still active)`, (await H.http(srv, "GET", `${H.SESSION}/me`, { cookie: victimSession })).status === 200);
      // do it: step-up must carry a fresh second factor of the ADMINISTRATOR
      await page.click(submitSel);
      await page.waitFor(`!!document.getElementById('stModalTitle')`);
      await page.click("top:[data-act=ok]");
      await page.waitFor(`!!document.getElementById('stStepUpTitle') && !!document.querySelector('.mfa-stepup input')`, { what: "step-up with a factor" });
      await page.fill(`top:input[name=current_password]`, actor.password);
      await page.fill(`.mfa-stepup input`, actor.totp.wrong());
      await page.click(`top:[data-act=ok]`);
      await page.waitFor(`__q('top:.st-field-error').textContent.trim().length > 0 && !__q('top:[data-act=ok]').disabled`, { what: "wrong factor refused" });
      s.check(`${L} a wrong authenticator code in the step-up is refused and nothing is reset`, (await H.http(srv, "GET", `${H.SESSION}/me`, { cookie: victimSession })).status === 200);
      await page.fill(`top:input[name=current_password]`, actor.password);
      await page.fill(`.mfa-stepup input`, await actor.totp.next());
      await page.click(`top:[data-act=ok]`);
      await page.waitFor(`/Done\\./.test(document.querySelector('.mfa-reset .st-form-status').textContent)`, { what: "reset confirmed by the server", timeout: 20000 });
      const status = await page.text(".mfa-reset .st-form-status");
      s.check(`${L} the page reports only what the server confirmed (methods removed, recovery codes deleted, signed out everywhere, must re-enrol)`, /1 method removed/.test(status) && /10 recovery codes deleted/.test(status) && /signed out everywhere/.test(status) && /set it up again/.test(status), status);
      s.check(`${L} the form is cleared after success (no reason/email left in the fields)`, await page.eval(`document.querySelector('.mfa-reset input[name=reason]').value === '' && document.querySelector('.mfa-reset input[name=email]').value === '' && !document.querySelector('.mfa-reset input[name=confirm]').checked`));
      s.check(`${L} the status is a polite live region`, await page.eval(`document.querySelector('.mfa-reset .st-form-status').getAttribute('role') === 'status' && document.querySelector('.mfa-reset .st-form-status').getAttribute('aria-live') === 'polite'`));
      const la = await H.layoutAudit(page, { scope: "[data-d-audit]" }).catch(() => ({ scrollW: 0, w: 1, bodyScrollW: 0, small: [], overflowing: [] }));
      s.check(`${L} the result message keeps the page free of horizontal overflow`, !H.hasHScroll(la), la);
      // effects on the target
      s.check(`${L} effect: the person's existing session is ended`, (await H.http(srv, "GET", `${H.SESSION}/me`, { cookie: victimSession })).status === 401);
      const lg = await H.apiLogin(srv, victim.email, victim.password);
      s.check(`${L} effect: the person's password still works (reset does not touch it) but yields no session`, lg.status === 200 && !lg.cookie && lg.json && (lg.json.mfa_enrollment_required || lg.json.mfa_required), { status: lg.status, body: lg.json && Object.keys(lg.json) });
      s.check(`${L} effect: the person must re-enrol before signing in (forced enrolment answer)`, !!(lg.json && lg.json.mfa_enrollment_required), lg.json && Object.keys(lg.json));
      const oldRc = await H.http(srv, "POST", `${H.SESSION}/mfa/verify`, { body: { challenge_token: lg.json && lg.json.challenge_token, method: "recovery_code", code: victim.recoveryCodes[0] } });
      s.check(`${L} effect: the person's old recovery code no longer works`, oldRc.status !== 200 && !oldRc.cookie, oldRc.status);
      const oldTotp = await H.http(srv, "POST", `${H.SESSION}/mfa/verify`, { body: { challenge_token: lg.json && lg.json.challenge_token, method: "totp", code: await victim.totp.next() } });
      s.check(`${L} effect: the person's old authenticator no longer works`, oldTotp.status !== 200 && !oldTotp.cookie, oldTotp.status);
      const mails = srv.mails().filter((m) => m.to === victim.email);
      s.check(`${L} the person is notified by e-mail without any secret in it`, mails.length >= 1 && mails.every((m) => !(m.text || "").includes(victim.password) && !/[A-Z2-7]{16,}/.test(m.text || "")), mails.map((m) => m.subject));
      // a non-super-admin cannot even see the reset card, and the endpoint refuses them
      const normal = await H.freshAccount(srv, adminCk, { tag: "nrm", role: "ochiga_admin" });
      const ncookie = await H.mfaLoginApi(srv, normal);
      const g = await H.apiStepUp(srv, ncookie, "mfa_management", normal.password, { method: "totp", code: await normal.totp.next() });
      const deny = await H.http(srv, "POST", `/api/lead-agents/admin/users/${target.id}/mfa/reset`, { cookie: ncookie, headers: { "x-step-up-token": g.json.step_up.token }, body: { reason: "attack", confirm: true, confirm_email: target.email } });
      s.check(`${L} a non-super administrator cannot reset someone's factors (403)`, deny.status === 403, { status: deny.status, body: deny.json });
      s.check(`${L} an API key cannot reset anyone's factors`, [401, 403].includes((await H.http(srv, "POST", `/api/lead-agents/admin/users/${target.id}/mfa/reset`, { headers: { "x-api-key": srv.apiKey }, body: { reason: "attack", confirm: true, confirm_email: target.email } })).status));
      await H.privacyAudit(s, page, srv, L, [actor.password, actor.totp.b32]);
      await page.close();
    });
  }

  // ================================================================ a non-administrator sees none of the administrator cards
  await s.guard("plain-user", async () => {
    const L = "[plain user]";
    const page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(1100);
    await F.signInPasswordOnly(page, srv, staff);
    await page.eval(`location.hash = '#/settings/people'`);
    await page.settle();
    s.check(`${L} a staff member does not get the requirement or reset cards`, !(await page.eval(`!!document.getElementById('mfaEnfCurrent') || !!document.querySelector('.mfa-reset')`)));
    const pre = await page.eval(`fetch('/api/lead-agents/admin/session/mfa/enforcement/preflight').then(r => r.status)`);
    s.check(`${L} the preflight endpoint refuses a staff member`, pre === 403, pre);
    await F.openSecurityPanel(page);
    s.check(`${L} but their own two-step panel is available (self-management is open to everyone)`, await page.visible("#mfaAddTotp"));
    await page.close();
  });
});
