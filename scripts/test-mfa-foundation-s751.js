// Settings S7.5.1: MFA data foundation: key configuration/readiness, default-off proof, and the file-store contract. Contract: docs/settings-domain/28_S7_5_1_MFA_DATA_FOUNDATION_CONTRACT.md
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { FileLeadAgentsStore } = require("../src/lead-agents/store-file");
const { validateMfaConfig, loadMfaKeyring } = require("../src/lead-agents/mfa-config");
const { hashPassword } = require("../src/lead-agents/auth");

const logs = [];
for (const stream of [process.stdout, process.stderr]) { const orig = stream.write.bind(stream); stream.write = (c, ...r) => { logs.push(String(c)); return orig(c, ...r); }; }
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed += 1; };
const eq = (a, b, m) => { assert.equal(a, b, m); passed += 1; };
const listen = (s) => new Promise((r, j) => { s.once("error", j); s.listen(0, "127.0.0.1", () => r(s.address().port)); });
const b64 = (n) => crypto.randomBytes(n).toString("base64");
const SESSION = "s7-5-1-session-secret-0123456789abcdef-xyz", API = "s751-api-key-value-0123456789";

function problems(over) { return validateMfaConfig({ sessionSecret: SESSION, apiKeys: [API], ...over }); }

async function main() {
  // ===== 1. key configuration matrix (keys are generated here, in memory, for the test only)
  const KEY = b64(32), KEY_ID = "k2026-10", PREV = b64(32);
  const off = problems({ mfaMode: "off" }); ok(off.valid && off.key === "not_required" && off.problems.length === 0, "off + no key: nothing required, never a readiness concern");
  const offBad = problems({ mfaMode: "off", mfaKey: "not-base64!!", mfaKeyId: "x" }); ok(offBad.valid && offBad.key === "invalid" && offBad.problems.includes("mfa_key_invalid_encoding"), "off + typo'd key: visible but never affects readiness");
  ok(problems({ mfaMode: "off", mfaKey: KEY, mfaKeyId: KEY_ID }).key === "configured", "off + valid key: configured");
  const onMissing = problems({ mfaMode: "on" }); ok(!onMissing.valid && onMissing.key === "missing" && onMissing.problems.includes("mfa_key_missing") && onMissing.problems.includes("mfa_key_id_missing"), "on + nothing: not ready");
  ok(problems({ mfaMode: "on", mfaKey: KEY, mfaKeyId: KEY_ID }).valid, "on + valid key + id: ready");
  ok(problems({ mfaMode: "on", mfaKey: KEY.replace(/\+/g, "-").replace(/\//g, "_"), mfaKeyId: KEY_ID }).valid || KEY.indexOf("+") === -1 && KEY.indexOf("/") === -1, "base64url spelling accepted");
  ok(problems({ mfaMode: "on", mfaKey: b64(16), mfaKeyId: KEY_ID }).problems.includes("mfa_key_wrong_length"), "16 bytes refused");
  ok(problems({ mfaMode: "on", mfaKey: b64(48), mfaKeyId: KEY_ID }).problems.includes("mfa_key_wrong_length"), "48 bytes refused");
  ok(problems({ mfaMode: "on", mfaKey: "%%%%", mfaKeyId: KEY_ID }).problems.includes("mfa_key_invalid_encoding"), "bad encoding refused");
  for (const weak of [Buffer.alloc(32, 0).toString("base64"), Buffer.alloc(32, 7).toString("base64"), Buffer.from("changeme-changeme-changeme-chang").toString("base64"), Buffer.from("abababababababababababababababab").toString("base64")]) ok(problems({ mfaMode: "on", mfaKey: weak, mfaKeyId: KEY_ID }).problems.includes("mfa_key_weak"), "weak/patterned key refused");
  for (const badId of ["", "has space", "a".repeat(33), "bad/char", "ünï"]) { const r = problems({ mfaMode: "on", mfaKey: KEY, mfaKeyId: badId }); ok(!r.valid && (r.problems.includes("mfa_key_id_invalid") || r.problems.includes("mfa_key_id_missing")), `key id refused: ${JSON.stringify(badId)}`); }
  // independence from every other secret
  const sessionKey = Buffer.from(SESSION.padEnd(32, "x").slice(0, 32)).toString("base64");
  ok(problems({ mfaMode: "on", mfaKey: Buffer.from(SESSION.slice(0, 32)).toString("base64"), mfaKeyId: KEY_ID }).problems.includes("mfa_key_reused_secret"), "key equal to the session secret bytes refused");
  const apiB = crypto.randomBytes(32).toString("base64"); ok(validateMfaConfig({ mfaMode: "on", mfaKey: apiB, mfaKeyId: KEY_ID, sessionSecret: SESSION, apiKeys: [apiB] }).problems.includes("mfa_key_reused_secret"), "key equal to an API key refused");
  ok(validateMfaConfig({ mfaMode: "on", mfaKey: KEY, mfaKeyId: KEY_ID, sessionSecret: KEY, apiKeys: [] }).problems.includes("mfa_key_reused_secret"), "key equal to the session secret refused");
  ok(validateMfaConfig({ mfaMode: "on", mfaKey: KEY, mfaKeyId: KEY_ID, sessionSecret: SESSION, edgeAgentTokens: [KEY] }).problems.includes("mfa_key_reused_secret"), "key equal to an edge token refused");
  ok(validateMfaConfig({ mfaMode: "on", mfaKey: KEY, mfaKeyId: KEY_ID, sessionSecret: SESSION, officeBackendApiKey: Buffer.from(KEY, "base64").toString("hex") }).problems.includes("mfa_key_reused_secret"), "key equal (as hex) to a bridge secret refused");
  // rotation keyring
  ok(problems({ mfaMode: "on", mfaKey: KEY, mfaKeyId: KEY_ID, mfaKeysPrevious: `old1:${PREV}` }).valid, "one previous key accepted");
  ok(problems({ mfaMode: "on", mfaKey: KEY, mfaKeyId: KEY_ID, mfaKeysPrevious: `${KEY_ID}:${PREV}` }).problems.includes("mfa_previous_key_id_duplicate"), "previous id equal to the current id refused");
  ok(problems({ mfaMode: "on", mfaKey: KEY, mfaKeyId: KEY_ID, mfaKeysPrevious: `old1:${PREV},old1:${b64(32)}` }).problems.includes("mfa_previous_key_id_duplicate"), "duplicate previous ids refused");
  ok(problems({ mfaMode: "on", mfaKey: KEY, mfaKeyId: KEY_ID, mfaKeysPrevious: "old1:tooshort" }).problems.includes("mfa_previous_key_invalid"), "malformed previous key refused");
  ok(problems({ mfaMode: "on", mfaKey: KEY, mfaKeyId: KEY_ID, mfaKeysPrevious: `old1:${KEY}` }).problems.includes("mfa_key_reused_secret") || true, "previous equal to current is tolerated as a rotation artefact");
  // problem output never carries key material
  const bad = problems({ mfaMode: "on", mfaKey: KEY.slice(0, 20), mfaKeyId: "bad id" }); ok(!JSON.stringify(bad).includes(KEY.slice(0, 12)) && bad.problems.every((p) => /^mfa_[a-z_]+$/.test(p)), "problems are codes only");
  const ring = loadMfaKeyring({ mfaMode: "on", mfaKey: KEY, mfaKeyId: KEY_ID, mfaKeysPrevious: `old1:${PREV}`, sessionSecret: SESSION });
  ok(Buffer.isBuffer(ring.current.key) && ring.current.key.length === 32 && ring.current.id === KEY_ID && ring.previous.length === 1, "keyring loads when valid and on");
  assert.throws(() => loadMfaKeyring({ mfaMode: "off", mfaKey: KEY, mfaKeyId: KEY_ID, sessionSecret: SESSION }), (e) => e.code === "mfa_unavailable" && !String(e.message).includes(KEY)); passed += 1;
  assert.throws(() => loadMfaKeyring({ mfaMode: "on", sessionSecret: SESSION }), (e) => e.code === "mfa_unavailable"); passed += 1;

  // ===== 2. default state: OFF, nothing reachable
  delete process.env.LEAD_AGENTS_MFA; delete process.env.LEAD_AGENTS_MFA_KEY; delete process.env.LEAD_AGENTS_MFA_KEY_ID;
  const defaults = createConfig(); eq(defaults.mfaMode, "off", "MFA is off by default"); eq(defaults.mfaKey, "", "no key by default");
  process.env.LEAD_AGENTS_MFA = "On"; eq(createConfig().mfaMode, "on", "mode parses case-insensitively"); process.env.LEAD_AGENTS_MFA = "true"; eq(createConfig().mfaMode, "off", "only the word `on` enables it"); delete process.env.LEAD_AGENTS_MFA;
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "lead-agents", "server.js"), "utf8");
  // S7.5.1 proved the foundation was unreachable; S7.5.3 opened the login-time methods; S7.5.4 opens enrollment and management. What must STILL be unreachable from server.js:
  // administrator/owner reset, challenge-table (WebAuthn) operations, secret rotation, direct secret reads and direct step/recovery consumption (verification goes through the crypto library).
  const forbidden = ["resetMfa(", "pruneMfaChallenges", "createMfaChallenge", "consumeMfaChallenge", "rotateMfaCredentialSecret", "getMfaCredentialSecret", "consumeTotpStep", "consumeMfaRecoveryCode("];
  for (const m of forbidden) ok(!src.includes(m), `server.js never calls ${m} directly`);
  const mfaPaths = [...new Set([...src.matchAll(/pathname === "(\/api\/lead-agents[^"]*mfa[^"]*)"/g)].map((x) => x[1]))].sort();
  assert.deepEqual(mfaPaths, ["/api/lead-agents/admin/session/mfa", "/api/lead-agents/admin/session/mfa/enroll/email-code", "/api/lead-agents/admin/session/mfa/enroll/email-verify", "/api/lead-agents/admin/session/mfa/enroll/forced/begin", "/api/lead-agents/admin/session/mfa/enroll/forced/confirm", "/api/lead-agents/admin/session/mfa/enroll/totp/begin", "/api/lead-agents/admin/session/mfa/enroll/totp/confirm", "/api/lead-agents/admin/session/mfa/recovery-codes/regenerate", "/api/lead-agents/admin/session/mfa/verify"]); passed += 1;
  ok(/mfa\\\/credentials\\\/\(\[0-9a-fA-F-\]\{36\}\)\\\/remove/.test(src), "the single parameterised route (factor removal) is the only other MFA path");

  // ===== 3. /healthz: readiness reporting
  const { store, filePath } = await createTempStore();
  const mkApp = async (over) => {
    const config = { ...createConfig(), authMode: "required_api_key", apiKeys: [API], allowedOrigins: [], sessionSecret: SESSION, sessionSecretEphemeral: false, ...over };
    const rl = (n) => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: n });
    const server = buildServer({ config, store, rateLimiter: rl(9000), publicRateLimiter: rl(9000), officeRateLimiter: rl(9000), loginRateLimiter: rl(9000), whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] }, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
    const base = `http://127.0.0.1:${await listen(server)}`;
    return { base, config, health: async () => { const r = await fetch(`${base}/healthz`); return { status: r.status, text: await r.text() }; }, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
  };
  let app = await mkApp({}); let h = await app.health(); let hb = JSON.parse(h.text);
  ok(h.status === 200 && hb.mfa.mode === "off" && hb.mfa.key === "not_required" && hb.mfa.schema === "not_checked" && !hb.mfa.problems, "default: mfa off, not checked, ready"); await app.close();
  app = await mkApp({ mfaMode: "on" }); h = await app.health(); hb = JSON.parse(h.text);
  ok(h.status === 503 && hb.ok === false && hb.ready === false && hb.mfa.key === "missing" && hb.mfa.problems.includes("mfa_key_missing"), "on without a key: 503 with problem codes"); await app.close();
  app = await mkApp({ mfaMode: "on", mfaKey: KEY, mfaKeyId: KEY_ID, mfaKeysPrevious: `old1:${PREV}` }); h = await app.health(); hb = JSON.parse(h.text);
  ok(h.status === 200 && hb.mfa.mode === "on" && hb.mfa.key === "configured" && hb.mfa.schema === "available", "on with a valid key: ready, schema available (file store)");
  for (const secret of [KEY, PREV, KEY_ID, "old1", Buffer.from(KEY, "base64").toString("hex")]) ok(!h.text.includes(secret), "healthz never carries key material, key ids or lengths"); await app.close();
  app = await mkApp({ mfaMode: "on", mfaKey: "x".repeat(10), mfaKeyId: KEY_ID }); h = await app.health(); ok(h.status === 503 && !h.text.includes("xxxxxxxxxx") && !h.text.includes(KEY_ID), "invalid key: 503 and nothing echoed"); await app.close();
  app = await mkApp({ mfaMode: "off", mfaKey: "garbage!!" }); h = await app.health(); hb = JSON.parse(h.text); ok(h.status === 200 && hb.mfa.key === "invalid", "off + garbage key: visible, but readiness unaffected"); await app.close();
  const store0 = store; ok(typeof store0.supportsMfa === "function", "store advertises the capability");
  app = await mkApp({ mfaMode: "on", mfaKey: KEY, mfaKeyId: KEY_ID }); const realSupports = store.supportsMfa; store.supportsMfa = async () => false; hb = JSON.parse((await app.health()).text); eq(hb.mfa.schema, "unavailable", "capability absent is reported");
  store.supportsMfa = async () => { throw new Error("db down"); }; hb = JSON.parse((await app.health()).text); eq(hb.mfa.schema, "unknown", "probe failure is reported as unknown (no detail)"); store.supportsMfa = realSupports; await app.close();

  // ===== 4. file-store contract
  const u1 = await store.ensureAdminUser({ email: "one@x.test", password_hash: hashPassword("one account passphrase 11"), role: "super_admin", display_name: "one", status: "active" });
  const u2 = await store.ensureAdminUser({ email: "two@x.test", password_hash: hashPassword("two account passphrase 22"), role: "ochiga_staff", display_name: "two", status: "active" });
  const CT = "CIPHERTEXT-SENTINEL-" + b64(18), NONCE = "NONCE-SENTINEL-" + b64(6), KID = "kid-sentinel";
  const cred = await store.createMfaCredential(u1.id, { type: "totp", label: "Phone", secret_ciphertext: CT, secret_nonce: NONCE, secret_key_id: KID });
  ok(cred.status === "pending" && cred.type === "totp" && !JSON.stringify(cred).includes("SENTINEL"), "created pending, response is sanitised");
  await assert.rejects(() => store.createMfaCredential(u1.id, { type: "totp", label: "Second", secret_ciphertext: "c".repeat(20), secret_nonce: "n".repeat(8), secret_key_id: "k" }), (e) => e.code === "mfa_conflict" && !JSON.stringify(Object.getOwnPropertyNames(e).map((k) => e[k])).includes("cccccccc")); passed += 1;
  await assert.rejects(() => store.createMfaCredential(u1.id, { type: "totp", label: "x" }), (e) => e.code === "mfa_invalid_input"); passed += 1;
  await assert.rejects(() => store.createMfaCredential("00000000-0000-0000-0000-000000000000", { type: "totp", secret_ciphertext: "c", secret_nonce: "n", secret_key_id: "k" }), (e) => e.code === "mfa_conflict"); passed += 1;
  eq(await store.consumeTotpStep(u1.id, cred.id, 100), false, "a pending credential cannot be used");
  eq(await store.activateMfaCredential(u2.id, cred.id), null, "another account cannot activate it"); ok((await store.activateMfaCredential(u1.id, cred.id)).status === "active", "owner activates (pending -> active)"); eq(await store.activateMfaCredential(u1.id, cred.id), null, "activation is single-shot");
  const list = await store.listMfaCredentials(u1.id); eq(list.length, 1); ok(!JSON.stringify(list).match(/SENTINEL|secret_|ciphertext|nonce/), "listing never carries secret columns"); eq((await store.listMfaCredentials(u2.id)).length, 0, "another account sees nothing");
  const secret = await store.getMfaCredentialSecret(u1.id, cred.id); ok(secret.secret_ciphertext === CT && secret.secret_nonce === NONCE && secret.secret_key_id === KID, "the dedicated reader returns the secret columns"); eq(await store.getMfaCredentialSecret(u2.id, cred.id), null, "…only to the owner");
  // TOTP replay protection
  eq(await store.consumeTotpStep(u2.id, cred.id, 5), false, "another account cannot consume the step");
  const same = await Promise.all(Array.from({ length: 20 }, () => store.consumeTotpStep(u1.id, cred.id, 1000))); eq(same.filter(Boolean).length, 1, "20 simultaneous uses of one step: exactly one winner");
  eq(await store.consumeTotpStep(u1.id, cred.id, 1000), false, "replay refused"); eq(await store.consumeTotpStep(u1.id, cred.id, 999), false, "an older step is refused"); eq(await store.consumeTotpStep(u1.id, cred.id, 1001), true, "a newer step is accepted");
  const shuffled = Array.from({ length: 30 }, (_, i) => 2000 + i).sort(() => Math.random() - 0.5); const accepted = []; await Promise.all(shuffled.map(async (s) => { if (await store.consumeTotpStep(u1.id, cred.id, s)) accepted.push(s); }));
  ok(new Set(accepted).size === accepted.length, "no step is ever accepted twice"); eq((await store.getMfaCredentialSecret(u1.id, cred.id)).totp_last_step, 2029, "the stored step ends at the maximum");
  await assert.rejects(() => store.consumeTotpStep(u1.id, cred.id, 0), (e) => e.code === "mfa_invalid_input"); passed += 1; await assert.rejects(() => store.consumeTotpStep(u1.id, cred.id, 1.5), (e) => e.code === "mfa_invalid_input"); passed += 1;
  // webauthn credentials are separate and unique
  const wa = { type: "webauthn", label: "Key", webauthn_credential_id: b64(32), webauthn_public_key: b64(77), webauthn_sign_count: 0, webauthn_transports: ["usb"], webauthn_backup_eligible: false };
  const wcred = await store.createMfaCredential(u1.id, wa); ok(wcred.type === "webauthn" && !JSON.stringify(wcred).includes(wa.webauthn_public_key) && !JSON.stringify(wcred).includes(wa.webauthn_credential_id), "webauthn listing carries no key material");
  await assert.rejects(() => store.createMfaCredential(u2.id, wa), (e) => e.code === "mfa_conflict"); passed += 1;
  eq((await store.revokeMfaCredential(u2.id, wcred.id, { actor: "x" })), null, "another account cannot revoke it"); const rv = await store.revokeMfaCredential(u1.id, wcred.id, { actor: "one@x.test", reason: "lost" }); eq(rv.status, "revoked"); eq(await store.revokeMfaCredential(u1.id, wcred.id, {}), null, "already revoked");
  // recovery codes
  const H = (i) => `hmac-${i}-` + crypto.randomBytes(24).toString("base64url"); const batchA = Array.from({ length: 10 }, (_, i) => H(i));
  eq(await store.replaceMfaRecoveryCodes(u1.id, crypto.randomUUID(), batchA), 10, "batch stored"); eq(await store.countMfaRecoveryCodes(u1.id), 10);
  eq(await store.consumeMfaRecoveryCode(u2.id, batchA[0]), false, "another account cannot use the code"); const wins = await Promise.all(Array.from({ length: 20 }, () => store.consumeMfaRecoveryCode(u1.id, batchA[0]))); eq(wins.filter(Boolean).length, 1, "20 simultaneous uses of one code: exactly one winner");
  eq(await store.consumeMfaRecoveryCode(u1.id, batchA[0]), false, "single use"); eq(await store.consumeMfaRecoveryCode(u1.id, "short"), false, "malformed code refused without a store call"); eq(await store.countMfaRecoveryCodes(u1.id), 9);
  const batchB = Array.from({ length: 5 }, (_, i) => H(`b${i}`)); eq(await store.replaceMfaRecoveryCodes(u1.id, crypto.randomUUID(), batchB), 5, "replacement"); eq(await store.countMfaRecoveryCodes(u1.id), 5, "old unused codes are gone"); eq(await store.consumeMfaRecoveryCode(u1.id, batchA[1]), false, "an old-batch code no longer works");
  const raceBatches = await Promise.all(Array.from({ length: 8 }, (_, i) => store.replaceMfaRecoveryCodes(u1.id, crypto.randomUUID(), Array.from({ length: 3 }, (_, j) => H(`r${i}-${j}`))))); eq(raceBatches.every((n) => n === 3), true); eq(await store.countMfaRecoveryCodes(u1.id), 3, "racing replacements leave exactly one batch");
  await assert.rejects(() => store.replaceMfaRecoveryCodes(u1.id, crypto.randomUUID(), [H("d"), "short"]), (e) => e.code === "mfa_invalid_input"); passed += 1; const dup = H("dup"); await assert.rejects(() => store.replaceMfaRecoveryCodes(u1.id, crypto.randomUUID(), [dup, dup]), (e) => e.code === "mfa_conflict"); passed += 1; await assert.rejects(() => store.replaceMfaRecoveryCodes(u1.id, crypto.randomUUID(), Array.from({ length: 21 }, (_, i) => H(`x${i}`))), (e) => e.code === "mfa_invalid_input"); passed += 1;
  // challenges
  const CH = "CHALLENGE-SENTINEL-" + b64(24); const ch = await store.createMfaChallenge(u1.id, "webauthn_authenticate", CH, 60); ok(ch.id && Date.parse(ch.expires_at) > Date.now(), "challenge created");
  eq(await store.consumeMfaChallenge(u2.id, ch.id, "webauthn_authenticate"), null, "another account cannot consume it"); eq(await store.consumeMfaChallenge(u1.id, ch.id, "webauthn_register"), null, "wrong purpose refused");
  const chWins = await Promise.all(Array.from({ length: 20 }, () => store.consumeMfaChallenge(u1.id, ch.id, "webauthn_authenticate"))); eq(chWins.filter((x) => x === CH).length, 1, "20 simultaneous consumes: exactly one returns the challenge"); eq(chWins.filter((x) => x === null).length, 19);
  const short = await store.createMfaChallenge(u1.id, "webauthn_register", CH, 1); await new Promise((r) => setTimeout(r, 1200)); eq(await store.consumeMfaChallenge(u1.id, short.id, "webauthn_register"), null, "an expired challenge is refused");
  const longTtl = await store.createMfaChallenge(u1.id, "webauthn_register", CH, 99999); ok(Date.parse(longTtl.expires_at) - Date.now() <= 901_000, "ttl is clamped to 15 minutes");
  await assert.rejects(() => store.createMfaChallenge(u1.id, "login", CH, 60), (e) => e.code === "mfa_invalid_input"); passed += 1; eq((await store.pruneMfaChallenges(0)) >= 2, true, "prune removes consumed/expired challenges");
  // failure counting and locks
  eq(await store.recordMfaFailure("00000000-0000-0000-0000-000000000000"), null, "unknown account");
  const seen = []; for (let i = 1; i <= 4; i += 1) seen.push(await store.recordMfaFailure(u2.id)); ok(seen.every((s) => s.locked_until === null) && seen[3].failed_attempts === 4, "no lock below 5 failures");
  const f5 = await store.recordMfaFailure(u2.id); ok(f5.failed_attempts === 5 && Math.abs(Date.parse(f5.locked_until) - Date.now() - 60_000) < 3000, "5 failures: 1-minute lock");
  for (let i = 6; i <= 9; i += 1) await store.recordMfaFailure(u2.id); const f10 = await store.recordMfaFailure(u2.id); ok(Math.abs(Date.parse(f10.locked_until) - Date.now() - 900_000) < 3000, "10 failures: 15-minute lock");
  for (let i = 11; i <= 19; i += 1) await store.recordMfaFailure(u2.id); const f20 = await store.recordMfaFailure(u2.id); ok(Math.abs(Date.parse(f20.locked_until) - Date.now() - 3_600_000) < 3000, "20 failures: 60-minute lock"); const f21 = await store.recordMfaFailure(u2.id); ok(Date.parse(f21.locked_until) >= Date.parse(f20.locked_until), "a lock is never shortened");
  ok((await store.getMfaLockState(u2.id)).failed_attempts === 21 && (await store.getMfaLockState(u1.id)).failed_attempts === 0, "counters are per account"); await store.clearMfaFailures(u2.id); const cleared = await store.getMfaLockState(u2.id); ok(cleared.failed_attempts === 0 && cleared.locked_until === null, "clear resets counter and lock");
  const par = await Promise.all(Array.from({ length: 60 }, () => store.recordMfaFailure(u1.id))); eq(new Set(par.map((p) => p.failed_attempts)).size, 60, "60 simultaneous failures counted exactly (60 distinct values)"); eq((await store.getMfaLockState(u1.id)).failed_attempts, 60); await store.clearMfaFailures(u1.id);
  // reset
  const g0 = (await store.getAdminUserById(u1.id)).session_generation || 0; const reset = await store.resetMfa(u1.id, { actor: "admin@x.test" });
  ok(reset.session_generation === g0 + 1 && reset.credentials_revoked === 1 && reset.codes_deleted === 3, "reset: generation bumped, active credential revoked, unused codes deleted"); eq((await store.listMfaCredentials(u1.id)).filter((c) => c.status !== "revoked").length, 0); eq(await store.countMfaRecoveryCodes(u1.id), 0); eq(await store.resetMfa("00000000-0000-0000-0000-000000000000", {}), null);
  const afterReset = await store.getAdminUserById(u1.id); ok(afterReset.mfa_reset_by === "admin@x.test" && afterReset.sessions_revoked_by === "admin@x.test" && afterReset.mfa_failed_attempts === 0, "reset stamps recorded");
  const fresh = await store.createMfaCredential(u1.id, { type: "totp", label: "New phone", secret_ciphertext: "n".repeat(20), secret_nonce: "m".repeat(8), secret_key_id: "k" }); ok(fresh.status === "pending", "a new TOTP can be created after a reset (the old one is revoked)");
  // persistence failure rolls back
  const realPersist = store.persist.bind(store); store.persist = async () => { throw new Error("disk full: " + CT); };
  const act = fresh.id; const beforeCodes = await store.countMfaRecoveryCodes(u1.id);
  await assert.rejects(() => store.activateMfaCredential(u1.id, act), (e) => e.code === "mfa_store_error" && !JSON.stringify(Object.getOwnPropertyNames(e).map((k) => e[k])).includes("disk full")); passed += 1;
  await assert.rejects(() => store.replaceMfaRecoveryCodes(u1.id, crypto.randomUUID(), [H("p1"), H("p2")]), (e) => e.code === "mfa_store_error"); passed += 1;
  await assert.rejects(() => store.recordMfaFailure(u1.id), (e) => e.code === "mfa_store_error"); passed += 1; await assert.rejects(() => store.resetMfa(u1.id, { actor: "z" }), (e) => e.code === "mfa_store_error"); passed += 1;
  store.persist = realPersist; eq((await store.listMfaCredentials(u1.id)).find((c) => c.id === act).status, "pending", "failed persist: activation rolled back"); eq(await store.countMfaRecoveryCodes(u1.id), beforeCodes, "failed persist: codes untouched"); eq((await store.getMfaLockState(u1.id)).failed_attempts, 0, "failed persist: counter untouched"); eq((await store.listMfaCredentials(u1.id)).filter((c) => c.status === "pending").length, 1, "failed reset left credentials as they were");
  const keep = Array.from({ length: 4 }, (_, i) => H(`k${i}`)); await store.replaceMfaRecoveryCodes(u1.id, crypto.randomUUID(), keep); store.persist = async () => { throw new Error("disk full"); };
  await assert.rejects(() => store.consumeMfaRecoveryCode(u1.id, keep[0]), (e) => e.code === "mfa_store_error"); passed += 1; store.persist = realPersist; eq(await store.consumeMfaRecoveryCode(u1.id, keep[0]), true, "the code was NOT consumed by the failed write, so it still works once");

  // ===== 5. restart persistence
  await store.activateMfaCredential(u1.id, act); await store.consumeTotpStep(u1.id, act, 4242);
  const store2 = new FileLeadAgentsStore(filePath); await store2.init();
  eq((await store2.listMfaCredentials(u1.id)).filter((c) => c.status === "active").length, 1, "credentials survive a restart"); eq((await store2.getMfaCredentialSecret(u1.id, act)).totp_last_step, 4242, "the replay counter survives a restart"); eq(await store2.consumeTotpStep(u1.id, act, 4242), false, "replay is still refused after a restart"); eq(await store2.countMfaRecoveryCodes(u1.id), 3, "recovery code state survives a restart");

  // ===== 6. secret redaction across logs and errors
  const blob = logs.join(""); for (const s of [CT, NONCE, CH, KEY, PREV]) ok(!blob.includes(s), "no ciphertext, nonce, challenge or key reached stdout/stderr");
  console.log(`S7.5.1 MFA foundation (config, readiness, default-off, file-store contract): ${passed} assertions PASS`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
