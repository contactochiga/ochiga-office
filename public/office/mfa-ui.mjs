// Settings S7.5.8: the complete two-step verification interface. Contract: docs/settings-domain/35_S7_5_8_MFA_USER_INTERFACE_CONTRACT.md
// Lazy-loaded by office.js. It only DRIVES the existing S7.5.0-S7.5.7 endpoints: it never decides who is signed in, never authorizes anything itself, and never shows a success the server did not confirm.
// Secrets (challenge tokens, enrolment tokens, TOTP secrets, recovery codes, step-up grants) live in closure variables and DOM text only: never localStorage, sessionStorage, IndexedDB, cookies, URLs or logs.

const A = "/api/lead-agents/admin/session";
const MFA = `${A}/mfa`;
const KIND_LABEL = { totp: "Authenticator app", webauthn: "Security key or passkey" };
const CHECK_TEXT = {
  mfa_machinery: ["Two-step verification is switched on and its key is ready", "Set the deployment's MFA key and mode first."],
  schema_ready: ["The database supports factor management", "Apply the MFA database migrations first."],
  actor_enrolled: ["You have set up two-step verification yourself", "Enrol your own account first."],
  actor_recovery_codes: ["You hold unused recovery codes", "Regenerate your recovery codes."],
  recovery_path: ["Someone else can recover accounts (a second enrolled administrator or an approved recovery procedure)", "Enrol a second super administrator or have the owner approve the recovery procedure."],
  mailbox_delivery: ["Setup codes can be e-mailed to people", "Configure the e-mail provider; people who must enrol need a mailbox code."],
  fleet_attested: ["The owner confirmed every server runs this release", "The deployment owner must confirm that no older server is running."],
  api_key_fallback_off: ["The API-key password sign-in is off", "Turn the API-key password sign-in off."],
};
const LEVELS = [
  ["off", "Off", "Nobody has to use two-step verification. People who set it up are still asked for it."],
  ["optional", "Optional", "Available to everyone and encouraged; nobody is blocked."],
  ["privileged", "Privileged accounts", "Accounts that manage the team, settings or staff must use it (14 days to set up)."],
  ["all", "Everyone", "Every account must use it (14 days to set up)."],
];

// ---------------------------------------------------------------- small helpers (no markup is built from server data)
const b64uToBuf = (s) => { const p = String(s).replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i); return out.buffer; };
const bufToB64u = (buf) => { const bytes = new Uint8Array(buf); let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
export const webauthnSupported = () => typeof window !== "undefined" && Boolean(window.PublicKeyCredential) && Boolean(navigator.credentials);
const creationOptions = (o) => ({ ...o, challenge: b64uToBuf(o.challenge), user: { ...o.user, id: b64uToBuf(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) });
const requestOptions = (o) => ({ ...o, challenge: b64uToBuf(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) });
const registrationJson = (c) => ({ id: c.id, rawId: bufToB64u(c.rawId), type: c.type, response: { clientDataJSON: bufToB64u(c.response.clientDataJSON), attestationObject: bufToB64u(c.response.attestationObject), transports: typeof c.response.getTransports === "function" ? c.response.getTransports() : [] }, clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {}, authenticatorAttachment: c.authenticatorAttachment || undefined });
const assertionJson = (c) => ({ id: c.id, rawId: bufToB64u(c.rawId), type: c.type, response: { clientDataJSON: bufToB64u(c.response.clientDataJSON), authenticatorData: bufToB64u(c.response.authenticatorData), signature: bufToB64u(c.response.signature), userHandle: c.response.userHandle ? bufToB64u(c.response.userHandle) : null }, clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {}, authenticatorAttachment: c.authenticatorAttachment || undefined });
const keyErrorText = (err) => err && err.name === "NotAllowedError" ? "The security key request was cancelled or timed out." : err && err.name === "InvalidStateError" ? "That security key is already registered." : err && err.name === "NotSupportedError" ? "This browser or key does not support that." : "The security key could not be used.";

export function createMfaUi(host) {
  const { api, el, escapeHtml, hasPermission, state, fmtDateTime } = host;
  const text = (node, value) => { node.textContent = value; return node; };
  const minutes = (seconds) => Math.max(1, Math.ceil(Number(seconds) / 60));

  // One mapping of server answers to words. Nothing here reveals more than the server said, and no failure ever reads as success.
  function describe(err, { context = "verify" } = {}) {
    const d = (err && err.data) || {}; const status = err && err.status;
    if (d.error === "mfa_challenge_expired") return { kind: "expired", message: "This sign-in expired. Sign in again." };
    if (d.error === "mfa_locked") return { kind: "locked", message: `Too many incorrect codes. Try again in ${minutes(d.retry_after_seconds)} minute${minutes(d.retry_after_seconds) === 1 ? "" : "s"}.`, seconds: d.retry_after_seconds };
    if (status === 429) return { kind: "rate", message: "Too many attempts. Please wait a few minutes and try again." };
    if (status === 503) return { kind: "unavailable", message: context === "login" ? "Two-step verification is temporarily unavailable. You have not been signed in." : "Two-step verification is temporarily unavailable. Nothing was changed." };
    if (status === 401 && (d.error === "mfa_failed" || d.error === "step_up_failed")) return { kind: "wrong", message: context === "login" ? "That didn’t work. Check the code and try again, or use another method." : "That could not be verified. Check the code (a code you just used to sign in can only be used once; wait for the next one) and try again." };
    if (status === 401) return { kind: "wrong", message: "That could not be verified." };
    if (status === 403) return { kind: "denied", message: "You don’t have permission to do this. Nothing was changed." };
    if (status === 409) return { kind: "conflict", message: d.error === "last_factor" ? "This is the last two-step method on an account that must have one, so it can’t be removed." : d.error === "mfa_credential_limit" ? "You have reached the limit for security keys." : `Not done (${String(d.error || "conflict").replace(/_/g, " ")}). Nothing was changed.` };
    return { kind: "error", message: (err && err.message) || "The request failed. Nothing was changed." };
  }

  // ---------------------------------------------------------------- generic accessible dialog (focus trapped, restored; Esc only when dismissible; only the topmost of stacked dialogs reacts to keys)
  function dialog({ title, build, dismissible = true, wide = false }) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const backdrop = el(`<div class="st-modal-backdrop mfa-backdrop"><div class="st-modal mfa-modal${wide ? " mfa-modal-wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="mfaDialogTitle" tabindex="-1"><h3 id="mfaDialogTitle"></h3><div class="mfa-dialog-body"></div></div></div>`);
      const box = backdrop.querySelector(".mfa-modal"); text(box.querySelector("h3"), title);
      const focusables = () => [...box.querySelectorAll("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")].filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null);
      let closed = false;
      const close = (value) => { if (closed) return; closed = true; document.removeEventListener("keydown", onKey, true); backdrop.remove(); if (previous && previous.focus) { try { previous.focus(); } catch { /* element gone */ } } resolve(value); };
      function onKey(e) {
        const backdrops = document.querySelectorAll(".st-modal-backdrop"); if (backdrops[backdrops.length - 1] !== backdrop) return; // a dialog opened above this one (ours or the step-up/confirm dialogs) owns the keyboard
        if (e.key === "Escape" && dismissible) { e.preventDefault(); close(null); return; }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return; } // not dismissible (recovery codes): swallow
        if (e.key === "Tab") { const f = focusables(); if (!f.length) { e.preventDefault(); return; } const i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus(); }
      }
      if (dismissible) backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(null); });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(backdrop);
      build(box.querySelector(".mfa-dialog-body"), close);
      const first = focusables().find((n) => n.matches("input, select, textarea")) || focusables()[0] || box; first.focus();
    });
  }

  // ---------------------------------------------------------------- QR (computed locally; the SVG is built from booleans, no markup from the library or the secret)
  async function qrSvg(value) {
    const { qrcode } = await import("/office/vendor/qrcode-generator.mjs");
    const qr = qrcode(0, "M"); qr.addData(value); qr.make();
    const n = qr.getModuleCount(); const quiet = 4; const size = n + quiet * 2; const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg"); svg.setAttribute("viewBox", `0 0 ${size} ${size}`); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "QR code for your authenticator app. If you cannot scan it, use the setup key below."); svg.setAttribute("class", "mfa-qr"); svg.setAttribute("shape-rendering", "crispEdges");
    const bg = document.createElementNS(ns, "rect"); bg.setAttribute("width", String(size)); bg.setAttribute("height", String(size)); bg.setAttribute("fill", "#ffffff"); svg.appendChild(bg);
    let d = ""; for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    const path = document.createElementNS(ns, "path"); path.setAttribute("d", d); path.setAttribute("fill", "#000000"); svg.appendChild(path);
    return svg;
  }
  const groupKey = (key) => String(key).replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();

  // ---------------------------------------------------------------- recovery codes: shown once, in memory, with copy / download / print and an acknowledgement
  function showRecoveryCodes(codesIn, { title = "Save your recovery codes", lead = "Each code works once if you lose your device. We show them only now and cannot show them again." } = {}) {
    const codes = [...codesIn];
    return dialog({ title, dismissible: false, wide: true, build(body, close) {
      body.appendChild(el(`<p class="mfa-lead"></p>`)); text(body.firstChild, lead);
      const list = el(`<ol class="mfa-codes" aria-label="Recovery codes"></ol>`); for (const c of codes) { const li = document.createElement("li"); const code = document.createElement("code"); code.textContent = c; li.appendChild(code); list.appendChild(li); }
      body.appendChild(list);
      const tools = el(`<div class="mfa-tools"><button type="button" class="btn btn-ghost btn-sm" data-act="copy">Copy</button><button type="button" class="btn btn-ghost btn-sm" data-act="download">Download</button><button type="button" class="btn btn-ghost btn-sm" data-act="print">Print</button></div>`);
      const status = el(`<p class="st-note mfa-status" role="status" aria-live="polite"></p>`);
      tools.querySelector('[data-act="copy"]').addEventListener("click", async () => { try { await navigator.clipboard.writeText(codes.join("\n")); status.textContent = "Copied to the clipboard. Paste them somewhere safe, then clear the clipboard."; } catch { status.textContent = "Copy was blocked by the browser. Select the codes and copy them, or download them."; } });
      tools.querySelector('[data-act="download"]').addEventListener("click", () => { const blob = new Blob([`Ochiga Office recovery codes\nEach code works once.\n\n${codes.join("\n")}\n`], { type: "text/plain" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "ochiga-office-recovery-codes.txt"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); status.textContent = "Downloaded. Keep the file somewhere only you can open."; });
      tools.querySelector('[data-act="print"]').addEventListener("click", () => {
        const frame = document.createElement("iframe"); frame.setAttribute("aria-hidden", "true"); frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
        document.body.appendChild(frame); const doc = frame.contentDocument; doc.open(); doc.write("<!doctype html><title>Recovery codes</title><body></body>"); doc.close();
        const h = doc.createElement("h1"); h.textContent = "Ochiga Office recovery codes"; const p = doc.createElement("p"); p.textContent = "Each code works once. Keep this page somewhere safe."; const ul = doc.createElement("ol"); for (const c of codes) { const li = doc.createElement("li"); li.style.cssText = "font:16px monospace;margin:6px 0"; li.textContent = c; ul.appendChild(li); }
        doc.body.append(h, p, ul); const cleanup = () => { setTimeout(() => frame.remove(), 500); }; frame.contentWindow.addEventListener("afterprint", cleanup); frame.contentWindow.focus(); frame.contentWindow.print(); setTimeout(cleanup, 60_000); status.textContent = "Sent to the print dialog.";
      });
      body.appendChild(tools); body.appendChild(status);
      const ack = el(`<label class="mfa-ack"><input type="checkbox" name="ack" /> <span>I have saved these recovery codes somewhere safe.</span></label>`);
      const done = el(`<div class="st-modal-actions"><button type="button" class="btn btn-sm st-btn-primary" data-act="done" disabled>Done</button></div>`);
      ack.querySelector("input").addEventListener("change", (e) => { done.firstChild.disabled = !e.target.checked; });
      const warn = (e) => { e.preventDefault(); e.returnValue = ""; }; window.addEventListener("beforeunload", warn);
      done.firstChild.addEventListener("click", () => { window.removeEventListener("beforeunload", warn); codes.length = 0; list.replaceChildren(); status.textContent = ""; close(true); });
      body.appendChild(ack); body.appendChild(done);
    } });
  }

  // ---------------------------------------------------------------- authenticator setup (shared by voluntary and forced enrolment)
  // `begin()` -> { credential_id, secret_base32, otpauth_uri, replaces_credential_id? }; `confirm(credentialId, code)` -> the server's confirmation (or throws). Resolves the confirmation, or null if cancelled.
  function authenticatorSetup({ title = "Set up an authenticator app", begin, confirm, replacing = false }) {
    return dialog({ title, wide: true, build(body, close) {
      const status = el(`<p class="st-note mfa-status" role="status" aria-live="polite">Preparing…</p>`); body.appendChild(status);
      let setup = null; let secret = "";
      const wipe = () => { secret = ""; setup = null; };
      (async () => {
        try { setup = await begin(); } catch (err) { status.textContent = describe(err, { context: "enroll" }).message; body.appendChild(el(`<div class="st-modal-actions"><button type="button" class="btn btn-ghost btn-sm" data-act="x">Close</button></div>`)).querySelector("button"); body.querySelector('[data-act="x"]').addEventListener("click", () => close(null)); body.querySelector('[data-act="x"]').focus(); return; }
        secret = setup.secret_base32; status.remove();
        body.appendChild(el(`<p class="mfa-lead">${replacing ? "This replaces your current authenticator once you confirm. " : ""}Scan the code with an authenticator app (for example Google Authenticator, Microsoft Authenticator, 1Password or Authy), then enter the 6-digit code it shows.</p>`));
        const qrBox = el(`<div class="mfa-qr-box" aria-live="polite"></div>`); body.appendChild(qrBox);
        qrSvg(setup.otpauth_uri).then((svg) => qrBox.appendChild(svg)).catch(() => qrBox.appendChild(el(`<p class="st-note">The code could not be drawn here. Use the setup key below.</p>`)));
        const keyRow = el(`<div class="mfa-keyrow"><div><span class="mfa-key-label" id="mfaKeyLabel">Setup key</span><code class="mfa-key" aria-labelledby="mfaKeyLabel"></code></div><button type="button" class="btn btn-ghost btn-sm" data-act="copykey">Copy key</button></div>`);
        text(keyRow.querySelector(".mfa-key"), groupKey(secret));
        const keyStatus = el(`<p class="st-note mfa-status" role="status" aria-live="polite"></p>`);
        keyRow.querySelector("button").addEventListener("click", async () => { try { await navigator.clipboard.writeText(secret); keyStatus.textContent = "Setup key copied."; } catch { keyStatus.textContent = "Copy was blocked. Select the key and copy it."; } });
        body.appendChild(keyRow); body.appendChild(keyStatus);
        const form = el(`<form class="mfa-form" novalidate><label class="st-field"><span>6-digit code from the app</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" aria-describedby="mfaSetupErr" /></label><small class="st-field-error" id="mfaSetupErr" role="alert"></small><div class="st-modal-actions"><button type="button" class="btn btn-ghost btn-sm" data-act="cancel">Cancel</button><button type="submit" class="btn btn-sm st-btn-primary">Confirm</button></div></form>`);
        const err = form.querySelector(".st-field-error"), input = form.elements.code, submit = form.querySelector('button[type="submit"]');
        form.querySelector('[data-act="cancel"]').addEventListener("click", () => { wipe(); close(null); });
        form.addEventListener("submit", async (event) => {
          event.preventDefault(); err.textContent = "";
          if (!/^\s*\d[\d\s-]{4,9}$/.test(input.value)) { err.textContent = "Enter the 6-digit code shown in your app."; input.focus(); return; }
          submit.disabled = true; submit.textContent = "Confirming…";
          try { const result = await confirm(setup.credential_id, input.value); wipe(); input.value = ""; close(result || {}); }
          catch (e) { const m = describe(e, { context: "enroll" }); err.textContent = m.kind === "wrong" ? "That code didn’t match. Check the time on your phone and try the next code." : m.message; input.value = ""; submit.disabled = false; submit.textContent = "Confirm"; input.focus(); }
        });
        body.appendChild(form); input.focus();
      })();
    } });
  }

  // ---------------------------------------------------------------- step-up with a second factor (used by the extended password dialog in office.js)
  async function fetchStatus() { try { return await api(`${MFA}`); } catch { return null; } }
  async function assertionFor(optionsPath, optionsBody) {
    const o = await api(optionsPath, { method: "POST", body: optionsBody || {} });
    const cred = await navigator.credentials.get({ publicKey: requestOptions(o.options) });
    return { challenge_id: o.challenge_id, response: cred.toJSON ? cred.toJSON() : assertionJson(cred) };
  }
  // Mounts the factor controls into `container`. status === null means "could not tell": an optional code field is offered and the server decides.
  function mountStepUpFactor(container, status) {
    const enrolled = Boolean(status && status.mode === "on" && status.enrolled);
    if (status && !enrolled) return { required: false, async collect() { return null; } };
    const hasKey = Boolean(status && status.webauthn && status.webauthn.registered > 0 && status.webauthn.available && webauthnSupported());
    const hasTotp = !status || (status.credentials || []).some((c) => c.type === "totp" && c.status === "active");
    const wrap = el(`<fieldset class="mfa-stepup"><legend>Second factor${enrolled ? "" : " (if you use two-step verification)"}</legend><div class="mfa-methods" role="group" aria-label="Second factor method"></div><label class="st-field mfa-totp"><span>Authenticator code</span><input name="mfa_code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" /></label><p class="st-note mfa-key-note" hidden>You will be asked to use your security key when you confirm.</p></fieldset>`);
    const methods = wrap.querySelector(".mfa-methods"); let method = hasTotp ? "totp" : "webauthn";
    const totpField = wrap.querySelector(".mfa-totp"), keyNote = wrap.querySelector(".mfa-key-note");
    const apply = () => { totpField.hidden = method !== "totp"; keyNote.hidden = method !== "webauthn"; for (const b of methods.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.m === method)); };
    if (hasTotp && hasKey) for (const [m, label] of [["totp", "Authenticator code"], ["webauthn", "Security key"]]) { const b = document.createElement("button"); b.type = "button"; b.dataset.m = m; b.className = "btn btn-ghost btn-sm mfa-method"; b.textContent = label; b.addEventListener("click", () => { method = m; apply(); (m === "totp" ? wrap.querySelector("input") : b).focus(); }); methods.appendChild(b); } else methods.hidden = true;
    apply(); container.appendChild(wrap);
    return {
      required: enrolled,
      async collect() {
        if (method === "webauthn") { const a = await assertionFor(`${MFA}/webauthn/step-up-options`, {}); return { method: "webauthn", ...a }; }
        const code = wrap.querySelector("input").value.trim();
        if (!code) { if (enrolled) { const e = new Error("code_required"); e.local = true; throw e; } return null; }
        return { method: "totp", code };
      },
      clear() { wrap.querySelector("input").value = ""; },
      focus() { wrap.querySelector("input").focus(); },
    };
  }

  // ---------------------------------------------------------------- login: the second-factor challenge and the forced enrolment (inside the existing login card)
  function runLoginChallenge({ form, challenge, onSignedIn, onBack, setTitle }) {
    let token = challenge.challenge_token; const methods = (challenge.methods || []).filter((m) => m !== "webauthn" || webauthnSupported());
    const expiresAt = Date.parse(challenge.expires_at) || Date.now() + 5 * 60_000;
    setTitle("Two-step verification", "Enter the second factor for your account.");
    const root = el(`<div id="mfaChallenge" class="mfa-challenge"><div class="mfa-methods" role="group" aria-label="Verification method"></div><div class="mfa-panels"></div><div class="form-error mfa-error" role="alert"></div><p class="st-note mfa-status" role="status" aria-live="polite"></p><button type="button" class="login-link" data-act="back">Back to sign in</button></div>`);
    const errBox = root.querySelector(".mfa-error"), status = root.querySelector(".mfa-status"), mbar = root.querySelector(".mfa-methods"), panels = root.querySelector(".mfa-panels");
    const meta = { totp: ["Authenticator app", "6-digit code"], webauthn: ["Security key", ""], recovery_code: ["Recovery code", "Recovery code"] };
    let current = null; let lockTimer = null; let expiryTimer = null; let busy = false;
    const showError = (m) => { errBox.textContent = m; errBox.classList.toggle("visible", Boolean(m)); };
    const finish = () => { token = null; clearTimeout(lockTimer); clearTimeout(expiryTimer); root.querySelectorAll("input").forEach((i) => { i.value = ""; }); root.remove(); };
    const setBusy = (b) => { busy = b; root.querySelectorAll("button[type=submit], .mfa-key-btn").forEach((x) => { x.disabled = b; }); };
    const verify = async (body) => {
      if (busy || !token) return; showError(""); setBusy(true); status.textContent = "Verifying…";
      try {
        const data = await api(`${MFA}/verify`, { method: "POST", body: { challenge_token: token, ...body } });
        if (!data || !data.admin) throw Object.assign(new Error("Sign-in could not be completed."), { status: 502, data: {} }); // never treat an unconfirmed answer as signed in
        status.textContent = ""; finish(); onSignedIn(data);
      } catch (err) {
        const m = describe(err, { context: "login" }); status.textContent = "";
        showError(m.message);
        if (m.kind === "expired") { setBusy(true); token = null; return; }
        setBusy(false);
        if (m.kind === "locked") { setBusy(true); clearTimeout(lockTimer); lockTimer = setTimeout(() => { setBusy(false); showError(""); }, Math.min(Number(m.seconds) || 60, 3600) * 1000); }
        const input = panels.querySelector(`[data-panel="${current}"] input`); if (input) { input.value = ""; input.focus(); }
      }
    };
    const select = (m) => { current = m; showError(""); for (const b of mbar.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.m === m)); for (const p of panels.children) p.hidden = p.dataset.panel !== m; const i = panels.querySelector(`[data-panel="${m}"] input, [data-panel="${m}"] button`); if (i) i.focus(); };
    for (const m of ["totp", "webauthn", "recovery_code"]) {
      if (!methods.includes(m)) continue;
      const b = document.createElement("button"); b.type = "button"; b.dataset.m = m; b.className = "btn btn-ghost btn-sm mfa-method"; b.textContent = meta[m][0]; b.setAttribute("aria-pressed", "false"); b.addEventListener("click", () => select(m)); mbar.appendChild(b);
      let panel;
      if (m === "webauthn") {
        panel = el(`<div data-panel="webauthn" hidden><p class="mfa-lead">Use your security key, fingerprint, face or device PIN when your browser asks.</p><button type="button" class="btn btn-primary mfa-key-btn">Use security key or passkey</button></div>`);
        panel.querySelector("button").addEventListener("click", async () => {
          if (busy || !token) return; showError(""); setBusy(true); status.textContent = "Waiting for your security key…";
          try { const o = await api(`${MFA}/webauthn/auth/options`, { method: "POST", body: { challenge_token: token } }); const cred = await navigator.credentials.get({ publicKey: requestOptions(o.options) }); setBusy(false); await verify({ method: "webauthn", webauthn: { challenge_id: o.challenge_id, response: cred.toJSON ? cred.toJSON() : assertionJson(cred) } }); }
          catch (err) { status.textContent = ""; setBusy(false); showError(err && err.status ? describe(err, { context: "login" }).message : keyErrorText(err)); }
        });
      } else {
        panel = el(`<form data-panel="${m}" hidden novalidate><label class="st-field"><span>${m === "totp" ? "6-digit code from your authenticator app" : "Recovery code"}</span><input name="code" ${m === "totp" ? 'inputmode="numeric" autocomplete="one-time-code" maxlength="10"' : 'autocomplete="off" spellcheck="false" autocapitalize="characters" maxlength="24"'} /></label>${m === "recovery_code" ? '<p class="st-note">Each recovery code works once. Using one signs you out of your other devices.</p>' : ""}<button type="submit" class="btn btn-primary">Verify</button></form>`);
        panel.addEventListener("submit", (e) => { e.preventDefault(); const v = panel.elements.code.value.trim(); if (!v) { showError(m === "totp" ? "Enter the 6-digit code." : "Enter a recovery code."); panel.elements.code.focus(); return; } verify({ method: m, code: v }); });
      }
      panels.appendChild(panel);
    }
    form.appendChild(root);
    root.querySelector('[data-act="back"]').addEventListener("click", () => { finish(); onBack(); });
    if (!methods.length) { showError("No sign-in method is available for this account. Contact your administrator."); } else select(methods.includes("totp") ? "totp" : methods[0]);
    expiryTimer = setTimeout(() => { token = null; setBusy(true); showError("This sign-in expired. Sign in again."); }, Math.max(1000, expiresAt - Date.now()));
    return { cancel: finish };
  }

  function runForcedEnrollment({ form, challenge, onBack, setTitle }) {
    let token = challenge.challenge_token; let enrollmentToken = null;
    setTitle("Set up two-step verification", "Your organisation requires it before you can sign in.");
    const root = el(`<div id="mfaForced" class="mfa-challenge"><div class="mfa-step"></div><div class="form-error mfa-error" role="alert"></div><p class="st-note mfa-status" role="status" aria-live="polite"></p><button type="button" class="login-link" data-act="back">Back to sign in</button></div>`);
    const stepBox = root.querySelector(".mfa-step"), errBox = root.querySelector(".mfa-error"), status = root.querySelector(".mfa-status");
    const showError = (m) => { errBox.textContent = m; errBox.classList.toggle("visible", Boolean(m)); };
    const finish = () => { token = null; enrollmentToken = null; root.remove(); };
    const stepSend = () => {
      stepBox.replaceChildren(el(`<div><p class="mfa-lead">First we confirm this is your mailbox. We will send an 8-digit code to your account’s email address.</p><button type="button" class="btn btn-primary" data-act="send">Send the code</button></div>`));
      stepBox.querySelector("button").addEventListener("click", async () => { const b = stepBox.querySelector("button"); b.disabled = true; showError(""); status.textContent = "Sending…"; try { await api(`${MFA}/enroll/email-code`, { method: "POST", body: { challenge_token: token } }); status.textContent = ""; stepCode(); } catch (err) { status.textContent = ""; b.disabled = false; showError(describe(err, { context: "enroll" }).message); } });
      stepBox.querySelector("button").focus();
    };
    const stepCode = () => {
      stepBox.replaceChildren(el(`<form novalidate><p class="mfa-lead">If the sign-in is valid, a code was sent to your mailbox. It expires in a few minutes.</p><label class="st-field"><span>8-digit code from your email</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" /></label><button type="submit" class="btn btn-primary">Continue</button></form>`));
      const f = stepBox.querySelector("form"); f.elements.code.focus();
      f.addEventListener("submit", async (e) => { e.preventDefault(); showError(""); const v = f.elements.code.value.trim(); if (!v) { showError("Enter the code from your email."); return; } const b = f.querySelector("button"); b.disabled = true; status.textContent = "Checking…"; try { const r = await api(`${MFA}/enroll/email-verify`, { method: "POST", body: { challenge_token: token, email_code: v } }); enrollmentToken = r.enrollment_token; status.textContent = ""; await stepSetup(); } catch (err) { status.textContent = ""; b.disabled = false; f.elements.code.value = ""; const m = describe(err, { context: "enroll" }); showError(m.kind === "wrong" ? "That code didn’t work. Check your email and try again." : m.message); } });
    };
    const stepSetup = async () => {
      stepBox.replaceChildren(); status.textContent = "";
      const result = await authenticatorSetup({
        begin: () => api(`${MFA}/enroll/forced/begin`, { method: "POST", body: { enrollment_token: enrollmentToken } }),
        confirm: (credentialId, code) => api(`${MFA}/enroll/forced/confirm`, { method: "POST", body: { enrollment_token: enrollmentToken, credential_id: credentialId, code } }),
      });
      if (!result) { stepSetup2Cancelled(); return; }
      if (Array.isArray(result.recovery_codes)) await showRecoveryCodes(result.recovery_codes);
      finish(); onBack({ message: "Two-step verification is set up. Sign in again to continue." });
    };
    const stepSetup2Cancelled = () => { showError("Setup was cancelled. You can try again."); stepBox.replaceChildren(el(`<button type="button" class="btn btn-primary">Try again</button>`)); stepBox.querySelector("button").addEventListener("click", () => { showError(""); stepSetup(); }); };
    form.appendChild(root); root.querySelector('[data-act="back"]').addEventListener("click", () => { finish(); onBack(); });
    stepSend();
    return { cancel: finish };
  }

  // ---------------------------------------------------------------- step-up helper for management actions (purpose mfa_management)
  async function withStepUp(purpose, { title, body }, fn) {
    let token = host.stepUp.token(purpose);
    if (!token) { const grant = await host.stepUp.dialog({ purpose, title, body }); if (!grant) return { cancelled: true }; token = grant.token; }
    try { return { value: await fn(token) }; }
    catch (err) { if (err && err.data && err.data.error === "step_up_required") host.stepUp.clear(purpose); throw err; }
  }
  const fmt = (v) => (v ? fmtDateTime(v) : "—");

  // ---------------------------------------------------------------- the two-step verification card (People & Access, and the panel for everyone)
  async function renderSecurityCard({ card, retry, afterSignOut }) {
    const body = card.querySelector(".st-card-body"); body.replaceChildren(el(`<p class="st-note" role="status">Loading…</p>`));
    let s;
    try { s = await api(MFA); } catch (err) { body.replaceChildren(host.errorWithRetry(describe(err, { context: "load" }).message, retry || (() => renderSecurityCard({ card, retry, afterSignOut })))); return; }
    body.replaceChildren();
    const refresh = () => renderSecurityCard({ card, retry, afterSignOut });
    if (s.mode === "off") { body.appendChild(el(`<p class="st-note" id="mfaOff">Two-step verification isn’t switched on for this server, so there is nothing to set up yet.</p>`)); return; }
    if (s.mode !== "on") { body.appendChild(el(`<p class="st-note" id="mfaInvalid">Two-step verification is configured but not ready on this server. Ask the deployment owner. Nothing can be changed here.</p>`)); return; }
    const facts = [["Status", s.enrolled ? "Turned on for your account" : "Not set up"], ["Required for your account", s.required ? "Yes" : "No"], ["Recovery codes left", s.enrolled ? String(s.recovery_codes_remaining) : "—"], ["This sign-in used two-step verification", s.session && s.session.mfa_verified ? "Yes" : "No"]];
    const dl = el(`<dl class="st-facts mfa-facts">${facts.map(() => "<div><dt></dt><dd></dd></div>").join("")}</dl>`); [...dl.children].forEach((d, i) => { text(d.querySelector("dt"), facts[i][0]); text(d.querySelector("dd"), facts[i][1]); }); body.appendChild(dl);
    if (s.enrollment) { const n = el(`<p class="st-note mfa-grace" role="note"></p>`); n.textContent = s.enrollment.expired ? "Two-step verification is required and the set-up period has ended." : `Two-step verification is required for your account by ${fmt(s.enrollment.grace_ends_at)} (${s.enrollment.days_left} day${s.enrollment.days_left === 1 ? "" : "s"} left).`; body.appendChild(n); }
    const status = el(`<p class="st-note mfa-status" role="status" aria-live="polite"></p>`);
    const creds = (s.credentials || []).filter((c) => c.status === "active");
    if (creds.length) {
      const table = el(`<div class="st-table-wrap"><table class="st-table mfa-table"><caption class="st-sr">Your two-step verification methods</caption><thead><tr><th scope="col">Method</th><th scope="col">Name</th><th scope="col">Added</th><th scope="col">Last used</th><th scope="col"><span class="st-sr">Actions</span></th></tr></thead><tbody></tbody></table></div>`);
      const tbody = table.querySelector("tbody");
      for (const c of creds) {
        const tr = document.createElement("tr"); tr.dataset.credential = c.id;
        for (const v of [KIND_LABEL[c.type] || c.type, c.label || "—", fmt(c.created_at || c.activated_at), fmt(c.last_used_at)]) { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); }
        const act = document.createElement("td"); const rm = document.createElement("button"); rm.type = "button"; rm.className = "btn btn-ghost btn-sm"; rm.textContent = "Remove"; rm.setAttribute("aria-label", `Remove ${KIND_LABEL[c.type] || c.type} ${c.label || ""}`.trim());
        rm.addEventListener("click", async () => {
          const yes = await host.confirm({ title: "Remove this method?", body: s.required ? "Your account must keep two-step verification, so the last method can’t be removed. Other methods stay." : "You will be signed out everywhere, and if this is your last method two-step verification turns off and your recovery codes are deleted.", confirmLabel: "Remove" });
          if (!yes) { status.textContent = "Cancelled. Nothing changed."; return; }
          rm.disabled = true;
          try {
            const r = await withStepUp("mfa_management", { title: "Confirm to remove a method", body: "Enter your password and a code from your authenticator." }, (token) => api(`${MFA}/credentials/${encodeURIComponent(c.id)}/remove`, { method: "POST", headers: { "x-step-up-token": token }, body: {} }));
            if (r.cancelled) { status.textContent = "Confirmation cancelled. Nothing changed."; rm.disabled = false; return; }
            host.stepUp.clear(); host.toast("Method removed. You were signed out of your other sessions.");
            await refresh();
          } catch (err) { status.textContent = `Not removed — ${describe(err, { context: "manage" }).message}`; rm.disabled = false; }
        });
        act.appendChild(rm); tr.appendChild(act); tbody.appendChild(tr);
      }
      body.appendChild(table);
    } else if (s.enrolled === false) body.appendChild(el(`<p class="st-note">You haven’t added a method yet.</p>`));
    const row = el(`<div class="mfa-actions"></div>`);
    const btn = (label, id, cb, kind = "ghost") => { const b = document.createElement("button"); b.type = "button"; b.id = id; b.className = kind === "primary" ? "btn btn-sm st-btn-primary" : "btn btn-ghost btn-sm"; b.textContent = label; b.addEventListener("click", async () => { b.disabled = true; try { await cb(); } finally { b.disabled = false; } }); row.appendChild(b); return b; };
    const afterChange = async (result, { stayedSignedIn = true } = {}) => {
      host.stepUp.clear();
      if (result && Array.isArray(result.recovery_codes)) await showRecoveryCodes(result.recovery_codes);
      if (result && result.session_reissued === false) { host.toast("Sign in again to continue."); await afterSignOut(); return; }
      await refresh();
    };
    const hasTotp = creds.some((c) => c.type === "totp");
    btn(hasTotp ? "Replace authenticator app" : "Add authenticator app", "mfaAddTotp", async () => {
      status.textContent = "";
      const grant = await withStepUp("mfa_management", { title: hasTotp ? "Confirm to replace your authenticator" : "Confirm to set up two-step verification", body: s.enrolled ? "Enter your password and a code from your current method." : "Enter your current password to continue." }, async (token) => token).catch((err) => { status.textContent = describe(err, { context: "manage" }).message; return { error: true }; });
      if (!grant || grant.cancelled || grant.error) { if (grant && grant.cancelled) status.textContent = "Confirmation cancelled. Nothing changed."; return; }
      const token = grant.value;
      const result = await authenticatorSetup({ replacing: hasTotp, begin: () => api(`${MFA}/enroll/totp/begin`, { method: "POST", headers: { "x-step-up-token": token }, body: {} }), confirm: (credentialId, code) => api(`${MFA}/enroll/totp/confirm`, { method: "POST", headers: { "x-step-up-token": token }, body: { credential_id: credentialId, code } }) });
      if (!result) { status.textContent = "Set-up cancelled. Nothing changed."; host.stepUp.clear("mfa_management"); return; }
      await afterChange(result);
    }, creds.length ? "ghost" : "primary");
    if (s.webauthn && s.webauthn.available && webauthnSupported()) btn("Add security key or passkey", "mfaAddKey", async () => {
      status.textContent = "";
      if (s.webauthn.registered >= s.webauthn.limit) { status.textContent = `You have reached the limit of ${s.webauthn.limit} security keys.`; return; }
      const label = await nameKeyDialog(); if (label === null) { status.textContent = "Cancelled. Nothing changed."; return; }
      try {
        const r = await withStepUp("mfa_management", { title: "Confirm to add a security key", body: s.enrolled ? "Enter your password and a code from your current method." : "Enter your current password to continue." }, async (token) => {
          const o = await api(`${MFA}/webauthn/register/options`, { method: "POST", headers: { "x-step-up-token": token }, body: {} });
          let cred; try { cred = await navigator.credentials.create({ publicKey: creationOptions(o.options) }); } catch (e) { const x = new Error(keyErrorText(e)); x.local = true; throw x; }
          return api(`${MFA}/webauthn/register/verify`, { method: "POST", headers: { "x-step-up-token": token }, body: { challenge_id: o.challenge_id, response: cred.toJSON ? cred.toJSON() : registrationJson(cred), label } });
        });
        if (r.cancelled) { status.textContent = "Confirmation cancelled. Nothing changed."; return; }
        await afterChange(r.value);
      } catch (err) { status.textContent = `Not added — ${err && err.local ? err.message : describe(err, { context: "manage" }).message}`; }
    });
    if (s.enrolled) btn("Regenerate recovery codes", "mfaRegen", async () => {
      status.textContent = "";
      const yes = await host.confirm({ title: "Regenerate recovery codes?", body: "Your old codes stop working immediately. New codes are shown once.", confirmLabel: "Regenerate" }); if (!yes) { status.textContent = "Cancelled. Nothing changed."; return; }
      try {
        const r = await withStepUp("mfa_management", { title: "Confirm to regenerate recovery codes", body: "Enter your password and a code from your authenticator." }, (token) => api(`${MFA}/recovery-codes/regenerate`, { method: "POST", headers: { "x-step-up-token": token }, body: {} }));
        if (r.cancelled) { status.textContent = "Confirmation cancelled. Nothing changed."; return; }
        host.stepUp.clear("mfa_management"); await showRecoveryCodes(r.value.recovery_codes, { title: "Your new recovery codes" }); await refresh();
      } catch (err) { status.textContent = `Not regenerated — ${describe(err, { context: "manage" }).message}`; }
    });
    body.appendChild(row); body.appendChild(status);
  }
  function nameKeyDialog() {
    return dialog({ title: "Name this security key", build(body, close) {
      const form = el(`<form novalidate><label class="st-field"><span>Name (so you can tell your keys apart)</span><input name="label" maxlength="60" placeholder="For example: Office YubiKey" /></label><div class="st-modal-actions"><button type="button" class="btn btn-ghost btn-sm" data-act="cancel">Cancel</button><button type="submit" class="btn btn-sm st-btn-primary">Continue</button></div></form>`);
      form.querySelector('[data-act="cancel"]').addEventListener("click", () => close(null)); form.addEventListener("submit", (e) => { e.preventDefault(); close(form.elements.label.value.trim().slice(0, 60) || "Security key"); }); body.appendChild(form);
    } });
  }

  // ---------------------------------------------------------------- administrator reset (super_admin + team.manage)
  async function renderResetCard({ card, retry }) {
    const body = card.querySelector(".st-card-body");
    let users;
    try { users = (await host.listUsers()).users || []; } catch (err) { body.replaceChildren(host.errorWithRetry((err && err.message) || "Could not load people.", retry)); return; }
    const me = (state.admin && state.admin.id) || "";
    const list = users.filter((u) => u.id !== me && u.status === "active");
    const form = el(`<form class="st-reg-editor mfa-reset" novalidate aria-label="Reset two-step verification"><label class="st-field"><span>Person</span><select name="user"><option value="">Choose a person…</option></select></label><label class="st-field"><span>Reason (kept in the audit log)</span><input name="reason" maxlength="500" autocomplete="off" /></label><label class="st-field"><span>Type their email address to confirm</span><input name="email" type="email" autocomplete="off" /></label><label class="mfa-ack"><input type="checkbox" name="confirm" /> <span>I understand this removes their two-step methods and recovery codes, signs them out everywhere, and makes them set it up again. Their password does not change.</span></label><small class="st-field-error" role="alert"></small><button type="submit" class="btn btn-sm st-btn-primary" disabled>Reset two-step verification</button><span class="st-form-status" role="status" aria-live="polite"></span></form>`);
    const select = form.elements.user; for (const u of list) { const o = document.createElement("option"); o.value = u.id; o.textContent = `${u.display_name || u.email} — ${u.email}`; select.appendChild(o); }
    const submit = form.querySelector('button[type="submit"]'), status = form.querySelector(".st-form-status"), errEl = form.querySelector(".st-field-error");
    const ready = () => { submit.disabled = !(select.value && form.elements.reason.value.trim().length >= 3 && form.elements.email.value.trim() && form.elements.confirm.checked); };
    form.addEventListener("input", () => { status.textContent = ""; errEl.textContent = ""; ready(); }); form.addEventListener("change", ready);
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); const target = list.find((u) => u.id === select.value); if (!target) return;
      if (form.elements.email.value.trim().toLowerCase() !== String(target.email).toLowerCase()) { errEl.textContent = "That email address doesn’t match the selected person."; form.elements.email.focus(); return; }
      const yes = await host.confirm({ title: `Reset two-step verification for ${target.display_name || target.email}?`, body: "They will be signed out everywhere and must set it up again before they can sign in.", confirmLabel: "Reset" }); if (!yes) { status.textContent = "Cancelled. Nothing changed."; return; }
      submit.disabled = true; errEl.textContent = "";
      try {
        const r = await withStepUp("mfa_management", { title: "Confirm to reset someone’s two-step verification", body: "Enter your password and a fresh code from your own authenticator." }, (token) => api(`/api/lead-agents/admin/users/${encodeURIComponent(target.id)}/mfa/reset`, { method: "POST", headers: { "x-step-up-token": token }, body: { reason: form.elements.reason.value.trim(), confirm: true, confirm_email: form.elements.email.value.trim() } }));
        if (r.cancelled) { status.textContent = "Confirmation cancelled. Nothing changed."; ready(); return; }
        const d = r.value; host.stepUp.clear("mfa_management");
        status.textContent = `Done. The server confirms ${target.display_name || target.email}’s two-step verification was reset: ${d.credentials_revoked} method${d.credentials_revoked === 1 ? "" : "s"} removed, ${d.recovery_codes_deleted} recovery code${d.recovery_codes_deleted === 1 ? "" : "s"} deleted, signed out everywhere. They must set it up again. Email notice: ${({ sent: "sent", not_configured: "not sent (no email provider)", no_recipient: "not sent (no address)", failed: "failed" })[d.notification] || "unknown"}.`;
        form.elements.reason.value = ""; form.elements.email.value = ""; form.elements.confirm.checked = false; select.value = "";
      } catch (err) {
        const dd = (err && err.data) || {};
        const named = { use_self_service: "Use your own security settings for your own account.", last_recoverable_super_admin: "This is the last super administrator who can recover others, so it can’t be reset.", confirmation_mismatch: "The email address doesn’t match.", reason_required: "Give a reason of 3 to 500 characters.", target_inactive: "That account is inactive.", user_not_found: "That person no longer exists.", mfa_unavailable: "Two-step verification isn’t available on this server." };
        if (dd.error === "step_up_required") { host.stepUp.clear("mfa_management"); errEl.textContent = dd.reason === "mfa_required" ? "A fresh second factor is required, so your own account must have two-step verification set up. Nothing changed." : "Your confirmation expired or is not valid. Nothing changed — try again."; }
        else errEl.textContent = `Not reset — ${named[dd.error] || describe(err, { context: "manage" }).message} Nothing changed.`;
      }
      ready();
    });
    body.replaceChildren(form);
  }

  // ---------------------------------------------------------------- enforcement policy (registry-governed; preflight first)
  async function renderEnforcementCard({ card, retry }) {
    const body = card.querySelector(".st-card-body"); body.replaceChildren(el(`<p class="st-note" role="status">Loading…</p>`));
    let setting, pre;
    try { setting = (await api("/api/lead-agents/admin/settings/office_mfa_enforcement")).setting; pre = await api(`${MFA}/enforcement/preflight`); }
    catch (err) { body.replaceChildren(err && err.status === 403 ? el(`<div class="st-denied">Requires <code>staff.manage</code>.</div>`) : host.errorWithRetry(describe(err, { context: "load" }).message, retry)); return; }
    const canWrite = Boolean(setting.editable) && state.admin && state.admin.role === "super_admin";
    body.replaceChildren();
    const cur = pre.current || {}; const inactive = cur.active === false;
    const dl = el(`<dl class="st-facts mfa-facts"><div><dt>Current requirement</dt><dd id="mfaEnfCurrent"></dd></div><div><dt>In force</dt><dd id="mfaEnfActive"></dd></div><div><dt>Version</dt><dd id="mfaEnfVersion"></dd></div><div><dt>Set-up period</dt><dd id="mfaEnfGrace"></dd></div></dl>`);
    text(dl.querySelector("#mfaEnfCurrent"), (LEVELS.find((l) => l[0] === setting.value) || [])[1] || String(setting.value)); text(dl.querySelector("#mfaEnfActive"), inactive ? "No — two-step verification is not switched on for the server, so this setting does nothing yet" : "Yes");
    text(dl.querySelector("#mfaEnfVersion"), `${setting.version ?? "—"}${setting.updated_by ? ` · changed by ${setting.updated_by}` : ""}`); text(dl.querySelector("#mfaEnfGrace"), `${pre.grace ? pre.grace.days : 14} days from the day a requirement starts${cur.effective_since && setting.value !== "off" && setting.value !== "optional" ? ` (started ${fmt(cur.effective_since)})` : ""}`);
    body.appendChild(dl);
    const rec = pre.recovery || {}; const recText = { disabled: "Break-glass recovery: off (normal)", ready: "Break-glass recovery: configured, waiting for the next start", applied: "Break-glass recovery: was applied — remove the setting", already_applied: "Break-glass recovery: already applied — remove the setting", misconfigured: "Break-glass recovery: misconfigured", inactive: "Break-glass recovery: inactive", no_account: "Break-glass recovery: account not found", error: "Break-glass recovery: error" };
    body.appendChild(el(`<p class="st-note" id="mfaRecoveryState"></p>`)).textContent = (recText[rec.status] || "Break-glass recovery: unknown") + (rec.lingering ? " (still switched on)" : "");
    const chooser = el(`<fieldset class="mfa-levels"><legend>Who must use two-step verification</legend></fieldset>`);
    for (const [value, label, help] of LEVELS) { const id = `mfaLevel_${value}`; const row = el(`<label class="mfa-level" for="${id}"><input type="radio" name="level" id="${id}" value="${value}" /><span><strong></strong><small></small></span></label>`); text(row.querySelector("strong"), label); text(row.querySelector("small"), help); row.querySelector("input").checked = value === setting.value; chooser.appendChild(row); }
    body.appendChild(chooser);
    const result = el(`<div class="mfa-preflight" aria-live="polite"></div>`); body.appendChild(result);
    const form = el(`<form class="mfa-apply" novalidate><label class="mfa-ack"><input type="checkbox" name="confirm" /> <span>I confirm this change.</span></label><small class="st-field-error" role="alert"></small><button type="submit" class="btn btn-sm st-btn-primary" disabled>Apply</button><span class="st-form-status" role="status" aria-live="polite"></span></form>`);
    const apply = form.querySelector('button[type="submit"]'), status = form.querySelector(".st-form-status"), errEl = form.querySelector(".st-field-error");
    if (!canWrite) { form.hidden = true; body.appendChild(el(`<p class="st-note">${setting.editable ? "Only a super administrator can change this." : "Read-only for your role. Changing it needs the team.manage permission (super administrator)."}</p>`)); }
    body.appendChild(form);
    let checked = { level: setting.value, ok: false };
    const refreshApply = () => { apply.disabled = !(canWrite && checked.level !== setting.value && checked.ok && form.elements.confirm.checked); };
    async function runPreflight(level) {
      result.replaceChildren(el(`<p class="st-note">Checking…</p>`)); checked = { level, ok: false }; refreshApply();
      let p; try { p = await api(`${MFA}/enforcement/preflight?level=${encodeURIComponent(level)}`); } catch (err) { result.replaceChildren(el(`<p class="st-error" role="alert"></p>`)); result.firstChild.textContent = `The check could not run (${describe(err, { context: "load" }).message}). Nothing can be applied.`; return; }
      const strict = level === "privileged" || level === "all"; const raising = level !== setting.value && (LEVELS.findIndex((l) => l[0] === level) > LEVELS.findIndex((l) => l[0] === setting.value));
      const wrap = el(`<div></div>`);
      const heading = el(`<h4 class="mfa-sub"></h4>`); text(heading, level === setting.value ? "Current state" : raising ? "Readiness checks" : "Lowering the requirement is never blocked"); wrap.appendChild(heading);
      const ul = el(`<ul class="mfa-checks"></ul>`);
      for (const c of p.checks) { if (!raising && level !== setting.value) break; const li = document.createElement("li"); li.dataset.check = c.id; li.dataset.state = c.ok ? "ok" : c.required ? "fail" : "info"; const [label, fix] = CHECK_TEXT[c.id] || [c.id, ""]; const mark = document.createElement("span"); mark.className = "mfa-mark"; mark.setAttribute("aria-hidden", "true"); mark.textContent = c.ok ? "✓" : c.required ? "✕" : "–"; const t = document.createElement("span"); t.textContent = `${label}${c.ok ? "" : c.required ? ` — not ready. ${fix}` : " — not needed for this level"}`; const sr = document.createElement("span"); sr.className = "st-sr"; sr.textContent = c.ok ? " (ready)" : c.required ? " (not ready)" : " (not needed)"; li.append(mark, t, sr); ul.appendChild(li); }
      if (ul.children.length) wrap.appendChild(ul);
      const c = p.counts || {}; const counts = el(`<dl class="st-facts mfa-facts" id="mfaCounts"><div><dt>Active accounts</dt><dd></dd></div><div><dt>Covered by this level</dt><dd></dd></div><div><dt>Already set up</dt><dd></dd></div><div><dt>Still to set up</dt><dd></dd></div></dl>`);
      [c.active_accounts, c.covered, c.enrolled, c.unenrolled].forEach((v, i) => text(counts.querySelectorAll("dd")[i], v === null || v === undefined ? "Unknown" : String(v))); wrap.appendChild(counts);
      if (p.accounts && p.accounts.length) {
        const tbl = el(`<div class="st-table-wrap"><table class="st-table mfa-deadlines"><caption>${level === setting.value ? "Set-up deadlines" : "Set-up deadlines if applied now"}</caption><thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Deadline</th></tr></thead><tbody></tbody></table></div>`);
        for (const a of p.accounts.slice(0, 50)) { const tr = document.createElement("tr"); for (const v of [`${a.display_name || a.email}`, titleCaseSafe(a.role), `${fmt(a.deadline)}${a.expired ? " — passed" : ""}`]) { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); } tbl.querySelector("tbody").appendChild(tr); }
        wrap.appendChild(tbl); if (p.accounts_total > 50) wrap.appendChild(el(`<p class="st-note">Showing 50 of ${p.accounts_total}.</p>`));
      }
      const unsafe = raising && !p.ok;
      if (unsafe) wrap.appendChild(el(`<p class="st-error mfa-blocked" role="alert">This change is blocked until every required check above is ready. Nothing was changed.</p>`));
      result.replaceChildren(wrap); checked = { level, ok: level !== setting.value && !unsafe }; refreshApply();
    }
    chooser.addEventListener("change", (e) => { if (e.target.name === "level") { status.textContent = ""; errEl.textContent = ""; form.elements.confirm.checked = false; runPreflight(e.target.value); } });
    form.addEventListener("change", refreshApply);
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); errEl.textContent = ""; if (apply.disabled) return; apply.disabled = true; status.textContent = "Saving…";
      try {
        const grant = host.stepUp.token("security_policy_write") ? { token: host.stepUp.token("security_policy_write") } : await host.stepUp.dialog({ purpose: "security_policy_write", title: "Confirm to change the two-step requirement", body: "This is a security setting. Enter your password and a code from your authenticator." });
        if (!grant) { status.textContent = "Confirmation cancelled. Nothing was saved."; refreshApply(); return; }
        const r = await api("/api/lead-agents/admin/settings/office_mfa_enforcement", { method: "PUT", headers: { "x-step-up-token": grant.token }, body: { value: checked.level, expected_version: setting.version, confirm: true } });
        host.stepUp.clear("security_policy_write"); host.toast("Two-step requirement updated."); status.textContent = ""; await renderEnforcementCard({ card, retry }); card.querySelector("#mfaEnfCurrent") && (card.querySelector(".st-card-body").insertAdjacentHTML("beforeend", "")); const note = card.querySelector(".st-card-body"); const ok = el(`<p class="st-note" role="status"></p>`); ok.textContent = `Saved. The server confirms the requirement is now “${(LEVELS.find((l) => l[0] === r.setting.value) || [])[1] || r.setting.value}” (version ${r.setting.version}).`; note.appendChild(ok);
      } catch (err) {
        const d = (err && err.data) || {}; status.textContent = "";
        if (err.status === 412 && d.error === "preflight_failed") { errEl.textContent = `Blocked by the server’s checks: ${(d.failed_checks || []).map((id) => (CHECK_TEXT[id] || [id])[0]).join("; ")}. Nothing changed.`; runPreflight(checked.level); }
        else if (err.status === 409 && d.error === "version_conflict") { errEl.textContent = "This setting changed since you loaded it. Reload and review."; }
        else if (err.status === 409 && d.error === "enforcement_unchanged") { errEl.textContent = "That is already the current requirement."; }
        else if (err.status === 403 && d.error === "step_up_required") { host.stepUp.clear("security_policy_write"); errEl.textContent = d.reason === "mfa_required" ? "A fresh second factor is required. Nothing was saved." : "Your confirmation expired or is not valid. Nothing was saved — try again."; }
        else if (err.status === 403) errEl.textContent = "You don’t have permission to change this. Nothing was saved.";
        else errEl.textContent = `Not saved — ${describe(err, { context: "manage" }).message}`;
        refreshApply();
      }
    });
  }
  const titleCaseSafe = (v) => (host.titleCase ? host.titleCase(v) : String(v));

  // ---------------------------------------------------------------- grace banner and the panel everyone can open
  function showGraceBanner(notice, onSetup) {
    document.getElementById("mfaGraceBanner")?.remove();
    if (!notice || !notice.required) return;
    const bar = el(`<div id="mfaGraceBanner" class="mfa-banner" role="status"><span class="mfa-banner-text"></span><button type="button" class="btn btn-sm st-btn-primary" data-act="setup">Set up now</button><button type="button" class="btn btn-ghost btn-sm" data-act="dismiss">Dismiss</button></div>`);
    text(bar.querySelector(".mfa-banner-text"), notice.expired ? "Two-step verification is required for your account." : `Two-step verification is required for your account by ${fmt(notice.grace_ends_at)} (${notice.days_left} day${notice.days_left === 1 ? "" : "s"} left).`);
    bar.querySelector('[data-act="setup"]').addEventListener("click", onSetup); bar.querySelector('[data-act="dismiss"]').addEventListener("click", () => bar.remove());
    const shell = document.querySelector(".main-column") || document.body; shell.insertBefore(bar, shell.firstChild);
  }
  function openSecurityPanel({ afterSignOut }) {
    return dialog({ title: "Two-step verification", wide: true, build(body, close) {
      const card = el(`<section class="st-card mfa-panel-card"><div class="st-card-body"></div></section>`); body.appendChild(card);
      renderSecurityCard({ card, afterSignOut: async () => { close(null); await afterSignOut(); } });
      const actions = el(`<div class="st-modal-actions"><button type="button" class="btn btn-ghost btn-sm" data-act="close">Close</button></div>`); actions.querySelector("button").addEventListener("click", () => close(null)); body.appendChild(actions);
    } });
  }

  return { runLoginChallenge, runForcedEnrollment, renderSecurityCard, renderResetCard, renderEnforcementCard, openSecurityPanel, showGraceBanner, mountStepUpFactor, fetchStatus, showRecoveryCodes, authenticatorSetup, describe, webauthnSupported };
}
