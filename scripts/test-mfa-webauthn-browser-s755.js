// Real-browser acceptance test for the S7.5.5 WebAuthn interoperability: a REAL browser (Chrome with its virtual authenticator) registers a credential and signs in with it against the real server: headless Chrome over the DevTools protocol against the real Office server (file store, fixtures only).
// Skips (exit 0) when Chrome is not installed. Writes screenshots to OFFICE_ST_SHOTS if set.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { launchChrome, wrapSend } = require("./lib/browser-harness");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const PW = "browser super pass phrase 1";
const limiter = (max) => new MemoryRateLimiter({ windowMs: 60000, maxRequests: max });

async function main() {
  if (!CHROME) { console.log("SKIP: Chrome not installed"); return; }
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["wb-key-0123456789"], allowedOrigins: [], sessionSecret: "s7-5-5-browser-session-secret-0123456789abcdef", sessionSecretEphemeral: false, mfaMode: "on", mfaKey: crypto.randomBytes(32).toString("base64"), mfaKeyId: "k1", mfaKeysPrevious: "", officeEmailProvider: "", webauthnRpId: "localhost", webauthnOrigins: [] };
  const { store } = await createTempStore();
  const user = await store.ensureAdminUser({ email: "browser@ochiga.local", password_hash: hashPassword("browser passphrase number seven 7"), role: "super_admin", display_name: "Browser", status: "active" });
  const adapter = { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: () => [], isConfigured: () => true, sendTextMessage: async () => ({ delivered: false }) };
  const server = buildServer({ config, store, rateLimiter: limiter(5000), publicRateLimiter: limiter(5000), officeRateLimiter: limiter(5000), loginRateLimiter: limiter(500), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const port = await listen(server); const origin = `http://localhost:${port}`; config.webauthnOrigins = [origin]; // an isolated local origin: never a production domain
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-chrome-"));
  const chromeHandle = await launchChrome(CHROME, { userDir, flags: ["--disable-features=BackForwardCache"] }); const chrome = chromeHandle.proc;
  let ws, id = 0; const pending = new Map(); const errors = [];
  try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${chromeHandle.port}/json`)).json(); } catch { await sleep(200); } }
    assert.ok(targets, "Chrome DevTools is reachable");
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); };
    const send0 = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; const t = setTimeout(() => { pending.delete(n); reject(new Error(`CDP call timed out: ${method}`)); }, 30000); pending.set(n, (d) => { clearTimeout(t); resolve(d); }); ws.send(JSON.stringify({ id: n, method, params })); });
    const send = wrapSend(send0, { label: 'test-mfa-webauthn-browser-s755.js' });
    const navigate = async (url) => { try { return await send("Page.navigate", { url }); } catch (e) { if (!/timed out/.test(e.message)) throw e; return send("Page.navigate", { url }); } };
    const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
    await send("Page.enable"); await send("Runtime.enable");
    await navigate(`${origin}/healthz`); await sleep(500);
    assert.equal(await evalJs("window.isSecureContext && typeof PublicKeyCredential !== 'undefined' && typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function'"), true, "a secure context with the WebAuthn JSON helpers");
    await send("WebAuthn.enable", { enableUI: false });
    const authn = await send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    const authenticatorId = authn.result.authenticatorId; assert.ok(authenticatorId, "a virtual authenticator is attached");
    // all API calls run INSIDE the page (same origin, cookies kept by the browser)
    const page = (body) => evalJs(`(async () => { const A = '/api/lead-agents/admin'; const j = async (p, o = {}) => { const r = await fetch(A + p, { method: o.method || 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(o.token ? { 'x-step-up-token': o.token } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) }); const t = await r.text(); let json = null; try { json = JSON.parse(t); } catch {} return { status: r.status, json }; }; ${body} })()`);
    const login1 = await page(`const r = await j('/session/login', { body: { email: 'browser@ochiga.local', password: 'browser passphrase number seven 7' } }); return r.status;`); assert.equal(login1, 200, "password sign-in in the browser (no factor yet)");
    const registration = await page(`
      const su = await j('/session/step-up', { body: { password: 'browser passphrase number seven 7', purpose: 'mfa_management' } });
      const token = su.json.step_up.token;
      const opts = await j('/session/mfa/webauthn/register/options', { token, body: {} });
      if (opts.status !== 200) return { stage: 'options', status: opts.status, json: opts.json };
      let credential;
      try { credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(opts.json.options) }); } catch (e) { return { stage: 'create', error: String(e && e.name) + ': ' + String(e && e.message) }; }
      const verify = await j('/session/mfa/webauthn/register/verify', { token, body: { challenge_id: opts.json.challenge_id, response: credential.toJSON(), label: 'Chrome virtual authenticator' } });
      return { stage: 'verify', status: verify.status, codes: verify.json && verify.json.recovery_codes && verify.json.recovery_codes.length, credential: verify.json && verify.json.credential, error: verify.json && verify.json.error };`);
    assert.equal(registration.status, 200, `a real browser attestation verifies: ${JSON.stringify(registration)}`); assert.equal(registration.codes, 10); assert.equal(registration.credential.type, "webauthn");
    const credentials = await send("WebAuthn.getCredentials", { authenticatorId }); assert.equal(credentials.result.credentials.length, 1, "the authenticator holds the new credential");
    const row = store.state.admin_mfa_credentials.find((c) => c.admin_user_id === user.id && c.type === "webauthn"); assert.ok(row.status === "active" && row.webauthn_public_key && Buffer.from(row.webauthn_credential_id, "base64").toString("base64url") === credentials.result.credentials[0].credentialId.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), "the stored credential id is the one the browser created");
    console.log("1. Chrome (virtual authenticator) registers a credential: real attestation verified by the server library, credential and recovery codes stored — PASS");
    // sign out, then sign in with the credential
    const signin = await page(`
      await j('/session/logout', { body: {} });
      const l = await j('/session/login', { body: { email: 'browser@ochiga.local', password: 'browser passphrase number seven 7' } });
      if (!l.json.mfa_required) return { stage: 'login', json: l.json };
      const methods = l.json.methods;
      const opts = await j('/session/mfa/webauthn/auth/options', { body: { challenge_token: l.json.challenge_token } });
      if (opts.status !== 200) return { stage: 'options', status: opts.status };
      let assertion;
      try { assertion = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(opts.json.options) }); } catch (e) { return { stage: 'get', error: String(e && e.name) + ': ' + String(e && e.message) }; }
      const v = await j('/session/mfa/verify', { body: { challenge_token: l.json.challenge_token, method: 'webauthn', webauthn: { challenge_id: opts.json.challenge_id, response: assertion.toJSON() } } });
      const me = await j('/session/me', { method: 'GET' });
      return { stage: 'done', methods, status: v.status, method: v.json && v.json.mfa && v.json.mfa.method, meStatus: me.status, meMfa: me.json && me.json.mfa && me.json.mfa.verified };`);
    assert.deepEqual([signin.stage, signin.status, signin.method, signin.meStatus, signin.meMfa], ["done", 200, "webauthn", 200, true], `a real browser assertion verifies and signs in: ${JSON.stringify(signin)}`); assert.deepEqual(signin.methods, ["webauthn", "recovery_code"]);
    const counter1 = (await store.listWebauthnCredentialsForAuth(user.id))[0].sign_count;
    console.log("2. Chrome signs in with the credential: real assertion verified (origin, RP ID, user verification, signature, counter), session carries MFA proof — PASS");
    // second sign-in: the counter must not go backwards, and a captured assertion must not replay
    const again = await page(`
      await j('/session/logout', { body: {} });
      const l = await j('/session/login', { body: { email: 'browser@ochiga.local', password: 'browser passphrase number seven 7' } });
      const opts = await j('/session/mfa/webauthn/auth/options', { body: { challenge_token: l.json.challenge_token } });
      const assertion = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(opts.json.options) });
      const body = { challenge_token: l.json.challenge_token, method: 'webauthn', webauthn: { challenge_id: opts.json.challenge_id, response: assertion.toJSON() } };
      const first = await j('/session/mfa/verify', { body });
      const replay = await j('/session/mfa/verify', { body });
      return { first: first.status, replay: replay.status };`);
    assert.deepEqual(again, { first: 200, replay: 401 }, "a second sign-in works and replaying the captured assertion is refused");
    const counter2 = (await store.listWebauthnCredentialsForAuth(user.id))[0].sign_count; assert.ok(counter2 >= counter1, "the counter never went backwards");
    console.log("3. A captured browser assertion cannot be replayed; the counter is monotonic — PASS");
    const cleanup = await send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }); assert.ok(cleanup);
    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join(" | ").slice(0, 300)})`);
    console.log(JSON.stringify({ status: "PASS", suite: "webauthn-browser-interop" }));
  } finally {
    try { ws && ws.close(); } catch { /* closed */ }
    await chromeHandle.stop();
    server.closeAllConnections?.(); await new Promise((r) => server.close(r));
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* chrome still flushing its profile */ }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
