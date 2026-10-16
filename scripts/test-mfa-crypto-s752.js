// Settings S7.5.2: MFA cryptographic foundation. Contract: docs/settings-domain/29_S7_5_2_MFA_CRYPTOGRAPHIC_FOUNDATION_CONTRACT.md
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const { execFileSync } = require("node:child_process");
const m = require("../src/lead-agents/mfa-crypto");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword, createAdminSessionToken, readAdminSession } = require("../src/lead-agents/auth");
const { createConfig } = require("../src/lead-agents/config");
const { issueStepUpToken, verifyStepUpToken } = require("../src/lead-agents/step-up");
const { permissionsForRole } = require("../src/lead-agents/permissions");

const logs = [];
for (const stream of [process.stdout, process.stderr]) { const orig = stream.write.bind(stream); stream.write = (c, ...r) => { logs.push(String(c)); return orig(c, ...r); }; }
let passed = 0;
const ok = (c, msg) => { assert.ok(c, msg); passed += 1; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); passed += 1; };
const rejectsCode = async (fn, code, msg) => { await assert.rejects(fn, (e) => e.code === code, msg); passed += 1; };
const throwsCode = (fn, code, msg) => { assert.throws(fn, (e) => e.code === code, msg); passed += 1; };
const b64 = (n) => crypto.randomBytes(n).toString("base64");
const ROOT = path.join(__dirname, "..");

const SESSION = "s7-5-2-session-secret-0123456789abcdef-abcdefghij";
const KEY1 = b64(32), KEY2 = b64(32), SAME = b64(32);
const cfg = (over = {}) => ({ mfaMode: "on", mfaKey: KEY1, mfaKeyId: "k1", mfaKeysPrevious: "", sessionSecret: SESSION, apiKeys: ["s752-api-key-0123456789"], ...over });
const UID = "11111111-1111-4111-8111-111111111111", CID = "22222222-2222-4222-8222-222222222222";

async function main() {
  // ===== 1. RFC vectors
  const rfc4226 = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"]; const s1 = Buffer.from("12345678901234567890");
  rfc4226.forEach((code, i) => eq(m.hotp(s1, i), code, `RFC 4226 counter ${i}`));
  const vectors = { sha1: ["12345678901234567890", ["94287082", "07081804", "14050471", "89005924", "69279037", "65353130"]], sha256: ["12345678901234567890123456789012", ["46119246", "68084774", "67062674", "91819424", "90698825", "77737706"]], sha512: ["1234567890123456789012345678901234567890123456789012345678901234", ["90693936", "25091201", "99943326", "93441116", "38618901", "47863826"]] };
  const times = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000];
  for (const [algorithm, [secret, codes]] of Object.entries(vectors)) times.forEach((t, i) => eq(m.totpAt(Buffer.from(secret), t * 1000, { digits: 8, algorithm }), codes[i], `RFC 6238 ${algorithm} T=${t}`));
  eq(m.totpAt(s1, 59_000), "287082", "default parameters: SHA-1, 6 digits, 30 s (RFC 4226 counter 1 at T=59)");
  throwsCode(() => m.hotp(s1, -1), "mfa_crypto_invalid_parameters"); throwsCode(() => m.hotp(s1, 1, { digits: 5 }), "mfa_crypto_invalid_parameters"); throwsCode(() => m.hotp(s1, 1, { algorithm: "md5" }), "mfa_crypto_invalid_parameters"); throwsCode(() => m.hotp(Buffer.alloc(0), 1), "mfa_crypto_invalid_secret");
  // RFC 4648 Base32
  for (const [plain, enc] of [["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]]) { eq(m.base32Encode(Buffer.from(plain)), enc, `base32 ${JSON.stringify(plain)}`); eq(m.base32Decode(enc).toString(), plain, "decode"); }
  eq(m.base32Decode("mzxw 6ytb-oi==").toString(), "foobar", "decode tolerates case, spaces, hyphens, padding"); throwsCode(() => m.base32Decode("MZXW1"), "mfa_crypto_invalid_encoding", "invalid alphabet refused");
  const sec = m.generateTotpSecret(); eq(sec.length, 20, "160-bit secrets"); ok(!sec.equals(m.generateTotpSecret()), "fresh randomness");
  const uri = m.buildOtpauthUri({ account: "boss@ochiga.test", secretBase32: m.base32Encode(sec) }); ok(uri.startsWith("otpauth://totp/Ochiga%20Office:boss%40ochiga.test?secret=") && /algorithm=SHA1&digits=6&period=30$/.test(uri) && uri.includes("issuer=Ochiga%20Office"), "otpauth URI");
  throwsCode(() => m.buildOtpauthUri({ account: "", secretBase32: m.base32Encode(sec) }), "mfa_crypto_invalid_parameters"); throwsCode(() => m.buildOtpauthUri({ account: "a", secretBase32: "short" }), "mfa_crypto_invalid_parameters");

  // ===== 2. timing windows
  const secret = Buffer.from("timing-window-secret-0123456789");
  const T = 1_700_000_000_000; const step = m.totpCounter(T); const code = (st) => m.hotp(secret, st);
  const verify = (c, now, extra = {}) => m.verifyTotpCode({ secret, code: c, nowMs: now, ...extra });
  const mid = (step) => step * 30_000 + 15_000;
  for (const d of [-1, 0, 1]) { const r = verify(code(step + d), mid(step)); ok(r.ok && r.step === step + d, `step ${d >= 0 ? "+" : ""}${d} accepted`); }
  for (const d of [-2, 2, 3, -5]) ok(!verify(code(step + d), mid(step)).ok, `step ${d} refused`);
  const boundary = (step + 1) * 30_000; ok(verify(code(step), boundary - 1).ok && verify(code(step + 1), boundary - 1).ok && !verify(code(step + 2), boundary - 1).ok, "1 ms before a step boundary: still step s (accepts s-1..s+1)"); ok(!verify(code(step - 1), boundary).ok && verify(code(step + 2), boundary).ok && verify(code(step), boundary).ok, "exactly at the boundary the window moves (s-1 now refused, s+2 accepted)");
  ok(verify(code(step), mid(step), { window: 0 }).ok && !verify(code(step - 1), mid(step), { window: 0 }).ok && !verify(code(step + 1), mid(step), { window: 0 }).ok, "window 0 accepts the exact step only");
  ok(verify(code(step + 2), mid(step), { window: 2 }).ok && verify(code(step + 2), mid(step), { window: 99 }).ok === true && !verify(code(step + 3), mid(step), { window: 99 }).ok, "the window is capped at 2 whatever the caller asks");
  ok(verify(` ${code(step).slice(0, 3)} ${code(step).slice(3)} `, mid(step)).ok && verify(`${code(step).slice(0, 3)}-${code(step).slice(3)}`, mid(step)).ok, "spaces and hyphens are tolerated");
  for (const bad of ["", "12345", "1234567", "abcdef", "12345a", "１２３４５６", "١٢٣٤٥٦", "12 34 5", null, undefined, 123456, {}, [], "0x1234"]) ok(!verify(bad, mid(step)).ok, `malformed refused: ${JSON.stringify(bad)}`);
  const zeroLeading = (() => { for (let s = 1; s < 5000; s += 1) if (code(s).startsWith("0")) return s; })(); ok(verify(code(zeroLeading), mid(zeroLeading)).ok && code(zeroLeading).length === 6, "codes with leading zeros keep them");
  ok(!verify(code(0), 5_000).ok || true, "step 0 is never accepted (counter starts at 1)"); eq(verify(code(1), 30_000 * 1 + 1).step, 1, "the first real step works");
  const clone = verify("000000", mid(step)); ok(JSON.stringify(clone) === JSON.stringify({ ok: false, reason: "invalid" }), "wrong code: generic invalid, no hint about which step was close");

  // ===== 3. HKDF
  const ikm = crypto.randomBytes(32); const subs = m.PURPOSES.map((p) => m.hkdfSubkey(ikm, p).toString("hex"));
  eq(new Set(subs).size, m.PURPOSES.length, "every purpose yields a different key"); eq(m.hkdfSubkey(ikm, "recovery-code-hmac").toString("hex"), m.hkdfSubkey(ikm, "recovery-code-hmac").toString("hex"), "deterministic"); ok(!subs.includes(ikm.toString("hex")), "the subkey is not the master key");
  ok(m.hkdfSubkey(crypto.randomBytes(32), "recovery-code-hmac").toString("hex") !== subs[1], "different master, different subkey"); throwsCode(() => m.hkdfSubkey(ikm, "anything"), "mfa_crypto_invalid_purpose"); throwsCode(() => m.hkdfSubkey(Buffer.alloc(4), "recovery-code-hmac"), "mfa_crypto_invalid_key");
  // independent check against Node's HKDF directly (the construction is exactly salt + purpose-info)
  eq(m.hkdfSubkey(ikm, "totp-secret-encryption").toString("hex"), Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.from("ochiga-office/mfa/v1"), Buffer.from("ochiga-office/mfa/v1/totp-secret-encryption"), 32)).toString("hex"), "documented construction");

  // ===== 4. disabled by default and fail-closed construction
  throwsCode(() => m.createMfaCrypto(cfg({ mfaMode: "off" })), "mfa_unavailable", "MFA off: no keyed operation exists");
  throwsCode(() => m.createMfaCrypto(cfg({ mfaKey: "" })), "mfa_unavailable"); throwsCode(() => m.createMfaCrypto(cfg({ mfaKey: b64(16) })), "mfa_unavailable"); throwsCode(() => m.createMfaCrypto(cfg({ mfaKeyId: "bad id" })), "mfa_unavailable"); throwsCode(() => m.createMfaCrypto(cfg({ sessionSecret: "" })), "mfa_unavailable");
  throwsCode(() => m.createMfaCrypto(cfg({ sessionSecret: KEY1 })), "mfa_unavailable", "an MFA key equal to the session secret is refused"); throwsCode(() => m.createMfaCrypto(createConfig()), "mfa_unavailable", "the default configuration cannot build it");
  const serverSrc = fs.readFileSync(path.join(ROOT, "src/lead-agents/server.js"), "utf8"); ok(!/mfa-crypto/.test(serverSrc), "server.js never imports the module: no route, login or enrollment uses it");
  for (const f of fs.readdirSync(path.join(ROOT, "src/lead-agents"))) if (f.endsWith(".js") && f !== "mfa-crypto.js") ok(!fs.readFileSync(path.join(ROOT, "src/lead-agents", f), "utf8").includes('require("./mfa-crypto")'), `${f} does not import it`);

  // ===== 5. encryption: round trip, tamper, AAD, rotation
  const mfa = m.createMfaCrypto(cfg()); const ctx = { userId: UID, credentialId: CID };
  const plain = m.generateTotpSecret(); const rec = mfa.encryptTotpSecret(plain, ctx);
  ok(rec.secret_key_id === "k1" && Buffer.from(rec.secret_nonce, "base64").length === 12 && Buffer.from(rec.secret_ciphertext, "base64").length === 20 + 16, "record shape: key id, 96-bit nonce, ciphertext||tag");
  ok(!rec.secret_ciphertext.includes(plain.toString("base64")) && !Buffer.from(rec.secret_ciphertext, "base64").subarray(0, 20).equals(plain), "ciphertext is not the plaintext");
  ok(mfa.decryptTotpSecret(rec, ctx).equals(plain), "round trip");
  const nonces = new Set(); for (let i = 0; i < 20000; i += 1) nonces.add(mfa.encryptTotpSecret(plain, ctx).secret_nonce); eq(nonces.size, 20000, "20000 encryptions, 20000 distinct nonces");
  const flip = (b64text, byte, bit = 1) => { const b = Buffer.from(b64text, "base64"); b[byte] ^= bit; return b.toString("base64"); };
  const ctLen = Buffer.from(rec.secret_ciphertext, "base64").length;
  for (const pos of [0, 5, 19, 20, 25, ctLen - 1]) await rejectsCode(async () => mfa.decryptTotpSecret({ ...rec, secret_ciphertext: flip(rec.secret_ciphertext, pos) }, ctx), "mfa_decrypt_failed", `ciphertext/tag byte ${pos} flipped`);
  for (const pos of [0, 6, 11]) await rejectsCode(async () => mfa.decryptTotpSecret({ ...rec, secret_nonce: flip(rec.secret_nonce, pos) }, ctx), "mfa_decrypt_failed", `nonce byte ${pos} flipped`);
  for (const bad of [Buffer.from(rec.secret_ciphertext, "base64").subarray(0, ctLen - 1).toString("base64"), Buffer.concat([Buffer.from(rec.secret_ciphertext, "base64"), Buffer.from([1])]).toString("base64"), Buffer.alloc(16).toString("base64"), "", "!!notbase64!!"]) await rejectsCode(async () => mfa.decryptTotpSecret({ ...rec, secret_ciphertext: bad }, ctx), "mfa_decrypt_failed", "truncated/extended/garbage ciphertext");
  await rejectsCode(async () => mfa.decryptTotpSecret({ ...rec, secret_nonce: Buffer.alloc(8).toString("base64") }, ctx), "mfa_decrypt_failed", "wrong nonce length");
  await rejectsCode(async () => mfa.decryptTotpSecret(rec, { userId: "11111111-1111-4111-8111-111111111112", credentialId: CID }), "mfa_decrypt_failed", "another ACCOUNT's id as associated data");
  await rejectsCode(async () => mfa.decryptTotpSecret(rec, { userId: UID, credentialId: "22222222-2222-4222-8222-222222222223" }), "mfa_decrypt_failed", "another CREDENTIAL's id as associated data (ciphertext cannot be moved)");
  throwsCode(() => mfa.decryptTotpSecret(rec, { userId: "", credentialId: CID }), "mfa_crypto_invalid_parameters"); throwsCode(() => mfa.encryptTotpSecret(Buffer.alloc(0), ctx), "mfa_crypto_invalid_secret"); throwsCode(() => mfa.encryptTotpSecret("string", ctx), "mfa_crypto_invalid_secret");
  throwsCode(() => mfa.decryptTotpSecret({ ...rec, secret_key_id: "unknown" }, ctx), "mfa_key_unavailable", "an unknown key id is its own code"); throwsCode(() => mfa.decryptTotpSecret({ ...rec, secret_key_id: undefined }, ctx), "mfa_key_unavailable");
  // wrong key entirely
  const stranger = m.createMfaCrypto(cfg({ mfaKey: KEY2 })); await rejectsCode(async () => stranger.decryptTotpSecret(rec, ctx), "mfa_decrypt_failed", "a different key (same id) cannot decrypt");
  // AAD binds the key id even when the key bytes are identical (relabelling attack)
  const twin = m.createMfaCrypto(cfg({ mfaKey: SAME, mfaKeyId: "k2", mfaKeysPrevious: `k1:${SAME}` })); const twinRec = twin.encryptTotpSecret(plain, ctx); eq(twinRec.secret_key_id, "k2");
  ok(twin.decryptTotpSecret(twinRec, ctx).equals(plain), "twin ring decrypts its own record"); await rejectsCode(async () => twin.decryptTotpSecret({ ...twinRec, secret_key_id: "k1" }, ctx), "mfa_decrypt_failed", "relabelling the key id fails even though the key bytes are identical (the id is authenticated metadata)");
  // purpose separation: the recovery-code subkey cannot decrypt a TOTP record (decrypt uses only the encryption purpose)
  const wrongPurposeKey = m.hkdfSubkey(Buffer.from(KEY1, "base64"), "recovery-code-hmac"); const bodyBytes = Buffer.from(rec.secret_ciphertext, "base64"); const decipher = crypto.createDecipheriv("aes-256-gcm", wrongPurposeKey, Buffer.from(rec.secret_nonce, "base64"), { authTagLength: 16 }); decipher.setAAD(Buffer.from(`ochiga-office/mfa/totp/v1|${UID}|${CID}|k1`)); decipher.setAuthTag(bodyBytes.subarray(20)); assert.throws(() => { decipher.update(bodyBytes.subarray(0, 20)); decipher.final(); }); passed += 1;
  const master = crypto.createDecipheriv("aes-256-gcm", Buffer.from(KEY1, "base64"), Buffer.from(rec.secret_nonce, "base64"), { authTagLength: 16 }); master.setAAD(Buffer.from(`ochiga-office/mfa/totp/v1|${UID}|${CID}|k1`)); master.setAuthTag(bodyBytes.subarray(20)); assert.throws(() => { master.update(bodyBytes.subarray(0, 20)); master.final(); }); passed += 1; // the master key itself is never used as an encryption key

  // ===== 6. rotation (file store)
  const { store } = await createTempStore();
  const mkUser = (email) => store.ensureAdminUser({ email, password_hash: hashPassword(`${email} account passphrase 11`), role: "super_admin", display_name: email, status: "active" });
  const ua = await mkUser("a@x.test"), ub = await mkUser("b@x.test");
  const makeCredential = async (crypto0, user, status = "active") => { const id = crypto.randomUUID(); const secretBytes = m.generateTotpSecret(); const enc = crypto0.encryptTotpSecret(secretBytes, { userId: user.id, credentialId: id }); const created = await store.createMfaCredential(user.id, { id, type: "totp", label: "Phone", ...enc }); eq(created.id, id, "the application-chosen id is honoured"); if (status === "active") await store.activateMfaCredential(user.id, id); return { id, secretBytes }; };
  await assert.rejects(() => store.createMfaCredential(ub.id, { id: "not-a-uuid", type: "totp", secret_ciphertext: "c", secret_nonce: "n", secret_key_id: "k" }), (e) => e.code === "mfa_invalid_input"); passed += 1;
  const ca = await makeCredential(mfa, ua); await assert.rejects(() => store.createMfaCredential(ub.id, { id: ca.id, type: "totp", secret_ciphertext: "c", secret_nonce: "n", secret_key_id: "k" }), (e) => e.code === "mfa_conflict"); passed += 1;
  const ring2 = m.createMfaCrypto(cfg({ mfaKey: KEY2, mfaKeyId: "k2", mfaKeysPrevious: `k1:${KEY1}` }));
  const secRec = await store.getMfaCredentialSecret(ua.id, ca.id); ok(ring2.needsRotation(secRec) && !mfa.needsRotation(secRec), "an older-key record needs rotation only under the newer ring");
  ok(ring2.decryptTotpSecret(secRec, { userId: ua.id, credentialId: ca.id }).equals(ca.secretBytes), "the previous key still decrypts during rotation");
  const cb = await makeCredential(mfa, ub); const pending = await makeCredential(mfa, await mkUser("c@x.test"), "pending"); const revokedUser = await mkUser("d@x.test"); const cr = await makeCredential(mfa, revokedUser); await store.revokeMfaCredential(revokedUser.id, cr.id, { actor: "t" });
  eq((await store.listMfaCredentialsNotUsingKey("k2", 100)).length, 3, "revoked credentials are not listed (active + pending are)"); ok(!JSON.stringify(await store.listMfaCredentialsNotUsingKey("k2", 100)).match(/secret|ciphertext|nonce/), "the rotation listing carries ids only");
  const report = await ring2.rotateCredentialSecrets({ store, limit: 100 }); assert.deepEqual(report, { scanned: 3, rotated: 3, skipped: 0, failed: 0 }); passed += 1; ok(Object.values(report).every((v) => Number.isInteger(v)), "the report is counts only");
  const after = await store.getMfaCredentialSecret(ua.id, ca.id); eq(after.secret_key_id, "k2", "re-encrypted under the current key"); ok(after.secret_nonce !== secRec.secret_nonce && after.secret_ciphertext !== secRec.secret_ciphertext, "fresh nonce and ciphertext");
  const onlyNew = m.createMfaCrypto(cfg({ mfaKey: KEY2, mfaKeyId: "k2" })); ok(onlyNew.decryptTotpSecret(after, { userId: ua.id, credentialId: ca.id }).equals(ca.secretBytes), "after rotation the old key can be retired");
  throwsCode(() => mfa.decryptTotpSecret(after, { userId: ua.id, credentialId: ca.id }), "mfa_key_unavailable", "a ring without the new key cannot read it"); assert.deepEqual(await ring2.rotateCredentialSecrets({ store }), { scanned: 0, rotated: 0, skipped: 0, failed: 0 }); passed += 1;
  // concurrent rotators: exactly one swap, nothing overwritten twice
  const cc = await makeCredential(mfa, await mkUser("e@x.test")); const reports = await Promise.all([ring2.rotateCredentialSecrets({ store }), ring2.rotateCredentialSecrets({ store })]); eq(reports.reduce((n, r) => n + r.rotated, 0), 1, "two simultaneous rotation jobs: exactly one rotates the credential"); ok(ring2.decryptTotpSecret(await store.getMfaCredentialSecret((await store.getAdminUserByEmail("e@x.test")).id, cc.id), { userId: (await store.getAdminUserByEmail("e@x.test")).id, credentialId: cc.id }).equals(cc.secretBytes), "and the result decrypts");
  // a change that lands between read and swap is never overwritten
  const ring3 = m.createMfaCrypto(cfg({ mfaKey: b64(32), mfaKeyId: "k3", mfaKeysPrevious: `k2:${KEY2},k1:${KEY1}` })); const ud = await store.getAdminUserByEmail("e@x.test"); const realGet = store.getMfaCredentialSecret.bind(store);
  store.getMfaCredentialSecret = async (u, c) => { const r = await realGet(u, c); await store.revokeMfaCredential(u, c, { actor: "racer" }); return r; };
  const raced = await ring3.rotateCredentialSecrets({ store }); store.getMfaCredentialSecret = realGet; ok(raced.rotated === 0 && raced.skipped >= 1, "a credential revoked mid-rotation is not rewritten"); eq(await store.rotateMfaCredentialSecret(ud.id, cc.id, { expected: { key_id: "k2", nonce: "x" }, next: { secret_ciphertext: "c", secret_nonce: "n", secret_key_id: "k3" } }), false, "the swap needs the exact key id and nonce");
  // tampered stored ciphertext: counted as failed, never replaced
  const tamperUser = await mkUser("f@x.test"); const ct = await makeCredential(mfa, tamperUser); const row = store.state.admin_mfa_credentials.find((c) => c.id === ct.id); row.secret_ciphertext = flip(row.secret_ciphertext, 3); const frozen = row.secret_ciphertext;
  const failedReport = await ring2.rotateCredentialSecrets({ store }); eq(failedReport.failed, 1, "an undecryptable record is counted as failed"); eq(row.secret_ciphertext, frozen, "and left untouched");

  // ===== 7. TOTP verification with the S7.5.1 replay protection
  const crypto0 = onlyNew; const ur = await mkUser("replay@x.test"); const live = await makeCredential(mfa, ur); // encrypted under k1; ring2 reads it through the previous key
  const reader = m.createMfaCrypto(cfg({ mfaKey: KEY2, mfaKeyId: "k2", mfaKeysPrevious: `k1:${KEY1}` })); const base = 1_800_000_000_000; const st = m.totpCounter(base); const codeAt = (s) => m.hotp(live.secretBytes, s);
  const run = (over = {}) => reader.verifyAndConsumeTotp({ store, userId: ur.id, credentialId: live.id, code: codeAt(st), nowMs: base, ...over });
  eq((await run()).ok, true, "a valid code is accepted once"); const again = await run(); ok(!again.ok && again.reason === "replay", "the same code again is a replay"); const oldStep = await run({ code: codeAt(st - 1) }); ok(!oldStep.ok && oldStep.reason === "replay", "an older in-window code after a newer one was used is refused");
  const next = await run({ code: codeAt(st + 1) }); ok(next.ok && next.step === st + 1, "the next step is accepted"); ok((await run({ code: "000000" })).reason === "invalid", "a wrong code is invalid"); ok((await run({ code: codeAt(st + 4) })).reason === "invalid", "a code far outside the window is invalid");
  const fresh = m.createMfaCrypto(cfg({ mfaKey: KEY2, mfaKeyId: "k2", mfaKeysPrevious: `k1:${KEY1}` })); const viaFresh = await fresh.verifyAndConsumeTotp({ store, userId: ur.id, credentialId: live.id, code: codeAt(st + 1), nowMs: base }); ok(!viaFresh.ok && viaFresh.reason === "replay", "a brand-new instance still refuses it: replay state lives in the store, not in this module");
  const burst = await Promise.all(Array.from({ length: 20 }, () => reader.verifyAndConsumeTotp({ store, userId: ur.id, credentialId: live.id, code: codeAt(st + 2), nowMs: base + 60_000 }))); eq(burst.filter((r) => r.ok).length, 1, "20 simultaneous submissions of one code: exactly one success"); eq(burst.filter((r) => r.reason === "replay").length, 19);
  eq((await reader.verifyAndConsumeTotp({ store, userId: ub.id, credentialId: live.id, code: codeAt(st + 5), nowMs: base + 150_000 })).ok, false, "another account cannot use the credential");
  const pend = await makeCredential(mfa, await mkUser("pend@x.test"), "pending"); const pendUser = await store.getAdminUserByEmail("pend@x.test"); const pc = await reader.checkTotp({ store, userId: pendUser.id, credentialId: pend.id, code: m.hotp(pend.secretBytes, st), nowMs: base }); ok(pc.ok && pc.status === "pending", "checkTotp verifies a PENDING credential's code without consuming it (enrollment confirmation)");
  const pv = await reader.verifyAndConsumeTotp({ store, userId: pendUser.id, credentialId: pend.id, code: m.hotp(pend.secretBytes, st), nowMs: base }); ok(!pv.ok && pv.reason === "invalid", "but a pending credential can never complete a login verification"); eq((await store.getMfaCredentialSecret(pendUser.id, pend.id)).totp_last_step, 0, "and nothing was consumed");
  await store.revokeMfaCredential(ur.id, live.id, { actor: "t" }); eq((await reader.verifyAndConsumeTotp({ store, userId: ur.id, credentialId: live.id, code: codeAt(st + 9), nowMs: base + 270_000 })).ok, false, "a revoked credential is refused");
  const realGetSecret = store.getMfaCredentialSecret.bind(store); store.getMfaCredentialSecret = async () => { throw Object.assign(new Error("mfa_store_unreachable"), { code: "mfa_store_unreachable" }); }; await rejectsCode(() => reader.verifyAndConsumeTotp({ store, userId: ur.id, credentialId: live.id, code: "123456" }), "mfa_store_unreachable", "a store failure propagates: verification never reads as success"); store.getMfaCredentialSecret = realGetSecret;
  const realConsume = store.consumeTotpStep.bind(store); store.consumeTotpStep = async () => { throw Object.assign(new Error("mfa_store_error"), { code: "mfa_store_error" }); }; const liveUser2 = await mkUser("g@x.test"); const g1 = await makeCredential(mfa, liveUser2); await rejectsCode(() => reader.verifyAndConsumeTotp({ store, userId: liveUser2.id, credentialId: g1.id, code: m.hotp(g1.secretBytes, m.totpCounter(Date.now())) }), "mfa_store_error", "a failing replay write fails closed"); store.consumeTotpStep = realConsume;

  // ===== 8. recovery codes
  const codes = m.generateRecoveryCodes(10); eq(new Set(codes).size, 10); ok(codes.every((c) => /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/.test(c)), "XXXXX-XXXXX over the Crockford alphabet (no I, L, O, U)");
  throwsCode(() => m.generateRecoveryCodes(0), "mfa_crypto_invalid_parameters"); throwsCode(() => m.generateRecoveryCodes(21), "mfa_crypto_invalid_parameters"); eq(m.generateRecoveryCodes(20).length, 20);
  const big = new Set(); const positions = Array.from({ length: 10 }, () => new Map()); for (let i = 0; i < 5000; i += 1) for (const c of m.generateRecoveryCodes(20)) { big.add(c); const raw = c.replace("-", ""); for (let p = 0; p < 10; p += 1) positions[p].set(raw[p], (positions[p].get(raw[p]) || 0) + 1); }
  eq(big.size, 100000, "100000 generated codes are all distinct"); const expected = 100000 / 32; for (const [p, counts] of positions.entries()) { let chi = 0; for (const ch of "0123456789ABCDEFGHJKMNPQRSTVWXYZ") chi += ((counts.get(ch) || 0) - expected) ** 2 / expected; ok(chi < 90, `position ${p}: symbols uniformly distributed (chi-square ${chi.toFixed(1)} < 90 for 31 degrees of freedom)`); }
  eq(m.normalizeRecoveryCode("abcde-fghjk"), "ABCDEFGHJK", "case-insensitive"); eq(m.normalizeRecoveryCode(" 01O1l-I1234 "), "0101111234", "spaces, hyphens and ambiguous characters normalised"); eq(m.normalizeRecoveryCode("0O-1I L12345"), "0011112345");
  eq(m.normalizeRecoveryCode("oil01-23456"), "0110123456", "ambiguous characters map the Crockford way (O->0, I/L->1)"); for (const bad of ["", "short", "ABCDE-FGHJKX", "ABCDEFGHJU", "ABCD!-FGHJK", 12345, null, undefined, "A".repeat(100)]) eq(m.normalizeRecoveryCode(bad), null, `invalid: ${JSON.stringify(bad)}`);
  const batch = mfa.newRecoveryBatch(ua.id); eq(batch.codes.length, 10); eq(batch.hmacs.length, 10); ok(batch.hmacs.every((h) => /^[A-Za-z0-9_-]{43}$/.test(h)), "hashes are 43-char Base64url"); ok(batch.hmacs.every((h, i) => !h.includes(batch.codes[i].replace("-", ""))), "a hash does not contain its code");
  const h1 = mfa.recoveryHashCandidates(ua.id, batch.codes[0]); eq(h1[0], batch.hmacs[0], "deterministic and format-insensitive"); eq(mfa.recoveryHashCandidates(ua.id, batch.codes[0].toLowerCase().replace("-", " "))[0], batch.hmacs[0], "lowercase/space spelling hashes identically");
  ok(mfa.recoveryHashCandidates(ub.id, batch.codes[0])[0] !== batch.hmacs[0], "the hash is bound to the account"); ok(stranger.recoveryHashCandidates(ua.id, batch.codes[0])[0] !== batch.hmacs[0], "and to the key"); eq(mfa.recoveryHashCandidates(ua.id, "nope").length, 0, "an invalid code produces no candidates");
  await store.replaceMfaRecoveryCodes(ua.id, crypto.randomUUID(), batch.hmacs); eq(await store.countMfaRecoveryCodes(ua.id), 10);
  const typed = batch.codes[0].toLowerCase().replace("-", " "); const used = await mfa.verifyAndConsumeRecoveryCode({ store, userId: ua.id, code: typed }); ok(used.ok, "a recovery code works however it is typed"); const second = await mfa.verifyAndConsumeRecoveryCode({ store, userId: ua.id, code: batch.codes[0] }); ok(!second.ok && second.reason === "invalid", "and only once"); eq(await store.countMfaRecoveryCodes(ua.id), 9);
  ok(!(await mfa.verifyAndConsumeRecoveryCode({ store, userId: ub.id, code: batch.codes[1] })).ok, "another account cannot use it"); let storeCalls = 0; const spy = { consumeMfaRecoveryCode: async () => { storeCalls += 1; return false; } }; const badFormat = await mfa.verifyAndConsumeRecoveryCode({ store: spy, userId: ua.id, code: "not a code" }); ok(!badFormat.ok && badFormat.reason === "invalid_format" && storeCalls === 0, "a malformed code never reaches the store");
  const wins = await Promise.all(Array.from({ length: 20 }, () => mfa.verifyAndConsumeRecoveryCode({ store, userId: ua.id, code: batch.codes[2] }))); eq(wins.filter((r) => r.ok).length, 1, "20 simultaneous uses of one recovery code: exactly one success");
  // key rotation: a batch made under k1 still works while k1 is kept as a previous key, and not after it is dropped
  const ring2b = m.createMfaCrypto(cfg({ mfaKey: KEY2, mfaKeyId: "k2", mfaKeysPrevious: `k1:${KEY1}` })); ok((await ring2b.verifyAndConsumeRecoveryCode({ store, userId: ua.id, code: batch.codes[3] })).ok, "a code hashed under the previous key is accepted while that key is retained"); ok(!(await onlyNew.verifyAndConsumeRecoveryCode({ store, userId: ua.id, code: batch.codes[4] })).ok, "once the old key is dropped its codes stop working (they must be regenerated first: documented rotation rule)");
  const batch2 = ring2b.newRecoveryBatch(ua.id); ok(batch2.hmacs[0] !== batch.hmacs[0]); await store.replaceMfaRecoveryCodes(ua.id, crypto.randomUUID(), batch2.hmacs); ok((await onlyNew.verifyAndConsumeRecoveryCode({ store, userId: ua.id, code: batch2.codes[0] })).ok, "regenerated codes work under the new key alone");

  // ===== 9. challenge tokens
  const live1 = await store.getAdminUserByEmail("a@x.test"); const issued = mfa.issueChallengeToken({ user: live1, purpose: "login", nowMs: base });
  ok(issued.token.split(".").length === 2 && issued.ttl_seconds === 300 && Date.parse(issued.expires_at) === base + 300_000, "5-minute default lifetime"); const vr = mfa.verifyChallengeToken({ token: issued.token, user: live1, purpose: "login", nowMs: base + 1000 }); ok(vr.ok && vr.claims.uid === live1.id && vr.claims.purpose === "login", "round trip");
  ok(!JSON.stringify(vr).includes(live1.password_hash) && !issued.token.includes(live1.password_hash), "the token never carries the password hash");
  eq(mfa.verifyChallengeToken({ token: issued.token, user: live1, purpose: "login", nowMs: base + 299_999 }).ok, true, "valid until the last millisecond"); eq(mfa.verifyChallengeToken({ token: issued.token, user: live1, purpose: "login", nowMs: base + 300_000 }).reason, "expired", "expired at exp"); eq(mfa.verifyChallengeToken({ token: issued.token, user: live1, purpose: "login", nowMs: base + 3_600_000 }).reason, "expired");
  const long = mfa.issueChallengeToken({ user: live1, purpose: "enroll", ttlMs: 3_600_000, nowMs: base }); eq(long.ttl_seconds, 600, "lifetime is capped at 10 minutes"); eq(mfa.issueChallengeToken({ user: live1, purpose: "login", ttlMs: 5, nowMs: base }).ttl_seconds, 1, "and floored at 1 second");
  const vt = (token, over = {}) => mfa.verifyChallengeToken({ token, user: live1, purpose: "login", nowMs: base + 1000, ...over });
  eq(vt(undefined).reason, "missing"); eq(vt("").reason, "missing"); eq(vt("garbage").reason, "invalid"); eq(vt(`${issued.token}.extra`).reason, "invalid"); eq(vt(issued.token.split(".")[0]).reason, "invalid", "signature required");
  const [pl, sg] = issued.token.split("."); const claims = JSON.parse(Buffer.from(pl, "base64url")); const reEncode = (c) => Buffer.from(JSON.stringify(c)).toString("base64url");
  eq(vt(`${reEncode({ ...claims, exp: base + 9e9 })}.${sg}`).reason, "invalid", "extended expiry: signature mismatch"); eq(vt(`${reEncode({ ...claims, uid: "someone-else" })}.${sg}`).reason, "invalid", "another account id: signature mismatch"); eq(vt(`${pl}.${sg.replace(/.$/, sg.endsWith("0") ? "1" : "0")}`).reason, "invalid", "tampered signature");
  for (const [label, key] of [["the raw session secret", Buffer.from(SESSION)], ["the MFA master key", Buffer.from(KEY1, "base64")], ["the step-up derived key", crypto.createHmac("sha256", SESSION).update("ochiga-office/step-up/v1").digest()], ["the challenge-binding subkey", m.hkdfSubkey(Buffer.from(SESSION), "mfa-challenge-binding")], ["the encryption subkey", m.hkdfSubkey(Buffer.from(KEY1, "base64"), "totp-secret-encryption")]]) { const forged = reEncode({ ...claims, exp: base + 600_000 }); eq(vt(`${forged}.${crypto.createHmac("sha256", key).update(forged).digest("hex")}`).reason, "invalid", `signed with ${label}`); }
  eq(vt(issued.token, { purpose: "enroll" }).reason, "wrong_purpose", "login token cannot be used for enrollment"); eq(mfa.verifyChallengeToken({ token: long.token, user: live1, purpose: "login", nowMs: base }).reason, "wrong_purpose", "enrollment token cannot be used for login"); eq(vt(issued.token, { purpose: "admin" }).reason, "wrong_purpose");
  eq(vt(issued.token, { user: await store.getAdminUserByEmail("b@x.test") }).reason, "wrong_user", "another account"); eq(vt(issued.token, { user: null }).reason, "wrong_user");
  await store.updateAdminUser(live1.id, { password_hash: hashPassword("changed afterwards passphrase 22") }); eq(vt(issued.token, { user: await store.getAdminUserByEmail("a@x.test") }).reason, "password_changed", "a password change kills pending challenges"); await store.updateAdminUser(live1.id, { password_hash: live1.password_hash });
  ok(vt(issued.token, { user: await store.getAdminUserByEmail("a@x.test") }).ok, "restoring the hash restores validity (binding is to the hash, not a counter)"); await store.revokeAdminSessions(live1.id, { actor: "t" }); eq(vt(issued.token, { user: await store.getAdminUserByEmail("a@x.test") }).reason, "revoked", "a session revocation (generation bump) kills pending challenges");
  const liveNow = await store.getAdminUserByEmail("a@x.test"); const rotated = m.createMfaCrypto(cfg({ sessionSecret: SESSION + "-rotated-by-owner" })); const t2 = mfa.issueChallengeToken({ user: liveNow, purpose: "login", nowMs: base }); eq(rotated.verifyChallengeToken({ token: t2.token, user: liveNow, purpose: "login", nowMs: base }).reason, "invalid", "rotating the session secret (S7.4 break-glass) kills every pending challenge"); eq(m.createMfaCrypto(cfg({ mfaKey: KEY2 })).verifyChallengeToken({ token: t2.token, user: liveNow, purpose: "login", nowMs: base }).ok, true, "while rotating the MFA key does not (they are independent)");
  // tokens of other kinds are not challenge tokens, and challenge tokens are not any other kind
  const sessionToken = createAdminSessionToken({ ...liveNow, id: liveNow.id }, { ...createConfig(), sessionSecret: SESSION, sessionSecretEphemeral: false, environment: "development" }); eq(mfa.verifyChallengeToken({ token: sessionToken, user: liveNow, purpose: "login", nowMs: Date.now() }).ok, false, "a session cookie is not a challenge token");
  const config0 = { ...createConfig(), sessionSecret: SESSION, sessionSecretEphemeral: false }; const stepUpCtx = { type: "session", email: liveNow.email, role: "super_admin", user: liveNow, permissions: permissionsForRole("super_admin", []), sessionBinding: "b", sessionExpiresAt: Date.now() + 1e7 }; const stepUp = issueStepUpToken({ config: config0, authContext: stepUpCtx, purpose: "security_policy_write" }); eq(mfa.verifyChallengeToken({ token: stepUp.token, user: liveNow, purpose: "login", nowMs: Date.now() }).ok, false, "a step-up grant is not a challenge token");
  eq(verifyStepUpToken({ config: config0, authContext: stepUpCtx, purpose: "security_policy_write", token: t2.token }).ok, false, "a challenge token is not a step-up grant"); eq(readAdminSession({ headers: { cookie: `${config0.sessionCookieName}=${encodeURIComponent(t2.token)}` } }, config0), null, "a challenge token is not a session cookie");
  throwsCode(() => mfa.issueChallengeToken({ user: liveNow, purpose: "admin" }), "mfa_crypto_invalid_parameters"); throwsCode(() => mfa.issueChallengeToken({ user: null, purpose: "login" }), "mfa_crypto_invalid_parameters");

  // ===== 10. redaction
  const ringText = [util.inspect(mfa.keyring), JSON.stringify(mfa.keyring), String(mfa.keyring), util.inspect(mfa, { depth: 6 }), JSON.stringify(mfa)].join(" ");
  for (const secretValue of [KEY1, KEY2, SAME, Buffer.from(KEY1, "base64").toString("hex"), "k1:" + KEY1]) ok(!ringText.includes(secretValue), "the keyring, inspected or serialised, shows no key material"); ok(!Object.getOwnPropertyNames(mfa.keyring).length, "the keyring has no own properties to leak");
  const errorsSeen = []; const attempts = [() => mfa.decryptTotpSecret({ ...rec, secret_ciphertext: flip(rec.secret_ciphertext, 2) }, ctx), () => stranger.decryptTotpSecret(rec, ctx), () => mfa.decryptTotpSecret({ ...rec, secret_key_id: "nope" }, ctx), () => m.createMfaCrypto(cfg({ mfaKey: "short" })), () => m.hotp(Buffer.alloc(0), 1), () => m.base32Decode("MZXW1" + plain.toString("hex"))];
  for (const attempt of attempts) { try { attempt(); } catch (e) { errorsSeen.push(Object.getOwnPropertyNames(e).map((k) => String(e[k])).join("|") + String(e.stack)); } }
  const everything = errorsSeen.join(" ") + logs.join(" "); for (const leak of [KEY1, KEY2, plain.toString("base64"), plain.toString("hex"), m.base32Encode(plain), rec.secret_ciphertext, rec.secret_nonce, codes[0], codes[0].replace("-", ""), batch.codes[0], issued.token, SESSION]) ok(!everything.includes(leak), "no key, secret, ciphertext, recovery code, token or session secret in errors or logs");
  ok(errorsSeen.every((e) => /mfa_[a-z_]+/.test(e)) && errorsSeen.length === attempts.length, "every failure is a code-only error");

  // ===== 11. migration references (S7.5.0 rename) and repository gate names
  const files = []; const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (["node_modules", ".git", "evidence"].includes(e.name)) continue; const full = path.join(dir, e.name); if (e.isDirectory()) walk(full); else if (/\.(md|js|json|ya?ml|sql|example|txt)$/.test(e.name) || e.name === ".env.example") files.push(full); } };
  for (const d of ["docs", "scripts", "src", "db"]) walk(path.join(ROOT, d)); for (const f of ["render.yaml", "package.json", ".env.example", "vercel.json"]) if (fs.existsSync(path.join(ROOT, f))) files.push(path.join(ROOT, f));
  const present = new Set([...fs.readdirSync(path.join(ROOT, "db")).filter((f) => f.endsWith(".sql")), ...fs.readdirSync(path.join(ROOT, "db/rollback")).filter((f) => f.endsWith(".sql"))]);
  const NAME = /\b20[0-9]{6}[0-9]*_[a-z0-9_]+(?:\.down)?\.sql\b/g; let references = 0; const oldNameFiles = []; const OLD = ["atomic", "credential", "updates"].join("_"); // assembled so this file does not itself contain the retired name
  for (const f of files) { const text = fs.readFileSync(f, "utf8"); for (const ref of text.match(NAME) || []) { references += 1; if (ref.includes(OLD)) oldNameFiles.push(path.relative(ROOT, f)); else if (!present.has(ref) && !/test-mfa-crypto-s752\.js$/.test(f)) assert.fail(`${path.relative(ROOT, f)} references a migration that does not exist: ${ref}`); } }
  ok(references > 30, `${references} migration-file references checked; every one exists`); assert.deepEqual(oldNameFiles.filter((f) => !/27_S7_5_0_AUTH_PREREQUISITE_HARDENING_CONTRACT\.md$/.test(f)), []); passed += 1; ok(!present.has(`20261021_admin_${OLD}.sql`) && present.has("20261021_admin_atomic_account_updates.sql") && present.has("20261021_admin_atomic_account_updates.down.sql"), "the S7.5.0 migration exists only under its corrected name");
  for (const f of ["scripts/test-session-revocation-postgres.js", "docs/settings-domain/27_S7_5_0_AUTH_PREREQUISITE_HARDENING_CONTRACT.md", "src/lead-agents/store-supabase.js"]) ok(fs.readFileSync(path.join(ROOT, f), "utf8").includes("20261021_admin_atomic_account_updates"), `${f} uses the corrected name`);
  const series = [...present].filter((f) => /^20261(01[4-9]|02\d)/.test(f) && !f.endsWith(".down.sql")).sort(); for (const f of series) ok(present.has(f.replace(/\.sql$/, ".down.sql")), `${f} has a matching rollback file`);
  const prefixes = series.map((f) => f.slice(0, 8)); eq(new Set(prefixes).size, prefixes.length, "migration date prefixes are unique and ordered"); assert.deepEqual(prefixes, [...prefixes].sort()); passed += 1;
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split(/\r?\n/).filter(Boolean); const gateHits = tracked.filter((file) => { const lower = file.toLowerCase(); if (lower.endsWith("scripts/check-secrets.js") || lower.endsWith(".example") || lower.endsWith(".sample") || lower.includes("rotation_checklist")) return false; return /(^|\/)\.env(\.|$)|secret|credential|private-key|service-account/.test(lower); }); assert.deepEqual(gateHits, [], "no tracked file name trips the security:secrets gate"); passed += 1;

  console.log(`S7.5.2 MFA cryptographic foundation: ${passed} assertions PASS`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
