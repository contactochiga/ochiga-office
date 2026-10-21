"use strict";
// D8: focus management of the dialogs: focus enters the dialog, is trapped, and returns to the opener when it closes (Escape and button), at three widths.
const H = require("./lib/harness.js");
const F = require("./lib/flows.js");

H.runSuite("d8-focus-dialogs", async (s) => {
  const srv = await H.startServer(s);
  await H.enrollRoot(srv);
  const adminCk = await H.adminCookie(srv);
  const chrome = await H.launchChrome(s);
  for (const w of [1440, 768, 390]) {
    await s.guard(`w${w}`, async () => {
      const L = `[${w}px focus]`;
      const acct = await H.freshAccount(srv, adminCk, { tag: `fo${w}` });
      const page = await H.newPage(chrome, { origin: srv.origin }); await page.viewport(w);
      await F.signInTotp(page, srv, acct);
      await F.openNav(page);
      await page.waitFor(`!document.getElementById('navSecurity').hidden`);
      await page.focus("#navSecurity");
      await page.press("Enter");
      await page.waitFor(`!!document.querySelector('.mfa-modal .mfa-facts')`, { what: "panel" });
      s.check(`${L} Enter on the footer button opens the panel (keyboard operation) and focus is inside it`, (await page.active()).inDialog === true, await page.active());
      await page.press("Escape");
      await F.waitDialogClosed(page);
      s.check(`${L} closing the panel with Escape returns focus to the button that opened it`, (await page.active()).id === "navSecurity", await page.active());
      await page.press("Enter");
      await page.waitFor(`!!document.querySelector('.mfa-modal .mfa-facts')`);
      await page.click(".mfa-modal [data-act=close]");
      await F.waitDialogClosed(page);
      s.check(`${L} closing the panel with its Close button returns focus to the opener`, (await page.active()).id === "navSecurity", await page.active());
      // confirm dialog opened from the panel
      await F.openSecurityPanel(page);
      await page.focus("#mfaRegen");
      await page.press("Enter");
      await page.waitFor(`!!document.getElementById('stModalTitle')`, { what: "confirm dialog" });
      s.check(`${L} confirm dialog: focus is inside it (on the safe button)`, (await page.active()).inDialog === true && (await page.active()).text === "Cancel", await page.active());
      await page.press("Tab"); await page.press("Tab"); await page.press("Tab");
      s.check(`${L} confirm dialog: Tab cycles inside the dialog`, (await page.active()).inDialog === true, await page.active());
      await page.press("Escape");
      await page.waitFor(`!document.getElementById('stModalTitle')`);
      s.check(`${L} confirm dialog: Escape returns focus to the Regenerate button`, (await page.active()).id === "mfaRegen", await page.active());
      s.check(`${L} the panel underneath is still open after closing the confirm dialog`, await F.dialogOpen(page));
      await page.click("#mfaRegen");
      await page.waitFor(`!!document.getElementById('stModalTitle')`);
      await page.click("top:[data-act=ok]");
      await page.waitFor(`!!document.getElementById('stStepUpTitle')`);
      s.check(`${L} step-up dialog: focus starts in the password field`, (await page.active()).name === "current_password", await page.active());
      await page.press("Escape");
      await page.waitFor(`!document.getElementById('stStepUpTitle')`);
      const a = await page.active();
      s.check(`${L} step-up dialog: after Escape focus is not lost to the page body (stays within the panel)`, a.tag !== "body" && a.inDialog === true, a);
      await page.press("Escape");
      await F.waitDialogClosed(page);
      await H.privacyAudit(s, page, srv, L, [acct.password, acct.totp.b32]);
      await page.close();
    });
  }
});
