"use strict";

// Settings S7.5.2: MFA cryptographic foundation. Contract: docs/settings-domain/29_S7_5_2_MFA_CRYPTOGRAPHIC_FOUNDATION_CONTRACT.md
// Library code only: nothing imports this from server.js, no route exists, and every KEYED operation throws `mfa_unavailable` unless MFA is on and the S7.5.1 key configuration is
// valid. Errors carry a code only (never a key, plaintext, code or ciphertext). Replay protection is the S7.5.1 atomic store operation; there is no second replay store.

const crypto = require("crypto");
const util = require("util");
const { loadMfaKeyring } = require("./mfa-config");
const { effectiveGeneration } = require("./session-generation");

// ---------------------------------------------------------------- errors
function cryptoError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// ---------------------------------------------------------------- HKDF (purpose separated)
const HKDF_SALT = Buffer.from("ochiga-office/mfa/v1");
const PURPOSES = Object.freeze(["totp-secret-encryption", "recovery-code-hmac", "mfa-challenge-signing", "mfa-challenge-binding", "mfa-email-code"]);

/** HKDF-SHA256 -> 32 bytes. A subkey for one purpose never works for another; unknown purposes throw. */
function hkdfSubkey(ikm, purpose) {
  if (!PURPOSES.includes(purpose)) throw cryptoError("mfa_crypto_invalid_purpose");
  if (!Buffer.isBuffer(ikm) || ikm.length < 16) throw cryptoError("mfa_crypto_invalid_key");
  return Buffer.from(crypto.hkdfSync("sha256", ikm, HKDF_SALT, Buffer.from(`ochiga-office/mfa/v1/${purpose}`), 32));
}

const equalBytes = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const equalText = (a, b) => equalBytes(Buffer.from(String(a)), Buffer.from(String(b)));

// ---------------------------------------------------------------- HOTP / TOTP (RFC 4226 / RFC 6238)
const TOTP_DEFAULTS = Object.freeze({ algorithm: "sha1", digits: 6, period: 30, window: 1 });
const ALGORITHMS = ["sha1", "sha256", "sha512"];

function hotp(secret, counter, { digits = 6, algorithm = "sha1" } = {}) {
  if (!Buffer.isBuffer(secret) || secret.length < 1) throw cryptoError("mfa_crypto_invalid_secret");
  if (!ALGORITHMS.includes(algorithm) || !Number.isInteger(digits) || digits < 6 || digits > 10) throw cryptoError("mfa_crypto_invalid_parameters");
  let value;
  try { value = BigInt(counter); } catch { throw cryptoError("mfa_crypto_invalid_parameters"); }
  if (value < 0n || value > 0xffffffffffffffffn) throw cryptoError("mfa_crypto_invalid_parameters");
  const message = Buffer.alloc(8); message.writeBigUInt64BE(value);
  const mac = crypto.createHmac(algorithm, secret).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

const totpCounter = (timeMs, period = 30) => Math.floor(Math.floor(Number(timeMs) / 1000) / period);
const totpAt = (secret, timeMs, { digits = 6, algorithm = "sha1", period = 30 } = {}) => hotp(secret, totpCounter(timeMs, period), { digits, algorithm });

/**
 * Checks a user-supplied code against the window around `nowMs`. Format first (exactly `digits` ASCII digits after removing spaces/hyphens, else invalid without computing).
 * Candidates for EVERY window step are always computed and compared in constant time, so timing reveals neither the matching step nor how close a wrong code was.
 * Returns { ok: true, step } (the highest matching step) or { ok: false, reason: "invalid" }.
 */
function verifyTotpCode({ secret, code, nowMs = Date.now(), digits = 6, algorithm = "sha1", period = 30, window = 1 }) {
  if (typeof code !== "string") return { ok: false, reason: "invalid" };
  const cleaned = code.replace(/[ -]/g, "");
  if (!new RegExp(`^[0-9]{${digits}}$`).test(cleaned)) return { ok: false, reason: "invalid" };
  const span = Math.max(0, Math.min(2, Math.floor(Number(window))));
  const current = totpCounter(nowMs, period);
  const given = Buffer.from(cleaned);
  let matched = null;
  for (let offset = -span; offset <= span; offset += 1) {
    const step = current + offset;
    if (step < 1) continue;
    const expected = Buffer.from(hotp(secret, step, { digits, algorithm }));
    if (equalBytes(expected, given)) matched = matched === null || step > matched ? step : matched;
  }
  return matched === null ? { ok: false, reason: "invalid" } : { ok: true, step: matched };
}

// ---------------------------------------------------------------- Base32 (RFC 4648) and otpauth URI
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(bytes) {
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const index = B32.indexOf(ch);
    if (index === -1) throw cryptoError("mfa_crypto_invalid_encoding");
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateTotpSecret = () => crypto.randomBytes(20);

function buildOtpauthUri({ issuer = "Ochiga Office", account, secretBase32 }) {
  const label = String(account || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!label || !/^[A-Z2-7]{16,}$/.test(String(secretBase32 || ""))) throw cryptoError("mfa_crypto_invalid_parameters");
  const iss = encodeURIComponent(issuer);
  return `otpauth://totp/${iss}:${encodeURIComponent(label)}?secret=${secretBase32}&issuer=${iss}&algorithm=SHA1&digits=6&period=30`;
}

// ---------------------------------------------------------------- recovery codes
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I, L, O, U
const RECOVERY_CODE_LENGTH = 10; // 10 x 5 bits = 50 bits

function oneRecoveryCode() {
  let acc = 0n;
  for (const byte of crypto.randomBytes(7)) acc = (acc << 8n) | BigInt(byte);
  acc >>= 6n; // 56 random bits -> 50
  let out = "";
  for (let i = RECOVERY_CODE_LENGTH - 1; i >= 0; i -= 1) out += CROCKFORD[Number((acc >> (5n * BigInt(i))) & 31n)];
  return out;
}
const formatRecoveryCode = (raw) => `${raw.slice(0, 5)}-${raw.slice(5)}`;

/** A batch of unique codes, displayed as XXXXX-XXXXX. Plain codes exist only in the returned array. */
function generateRecoveryCodes(count = 10) {
  if (!Number.isInteger(count) || count < 1 || count > 20) throw cryptoError("mfa_crypto_invalid_parameters");
  const set = new Set();
  while (set.size < count) set.add(oneRecoveryCode());
  return [...set].map(formatRecoveryCode);
}

/** Case-insensitive; spaces/hyphens ignored; O->0, I/L->1; anything else (including U) is invalid. Returns the 10-character canonical form or null. */
function normalizeRecoveryCode(input) {
  if (typeof input !== "string" || input.length > 40) return null;
  const canonical = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(canonical) ? canonical : null;
}

// ---------------------------------------------------------------- keyring (keys are unreachable from outside this module)
const keyStore = new WeakMap();
class MfaKeyring {
  constructor(raw) {
    keyStore.set(this, { current: { id: raw.current.id, key: Buffer.from(raw.current.key) }, previous: raw.previous.map((p) => ({ id: p.id, key: Buffer.from(p.key) })), derived: new Map() });
  }
  get currentKeyId() { return keyStore.get(this).current.id; }
  hasKey(id) { const s = keyStore.get(this); return s.current.id === id || s.previous.some((p) => p.id === id); }
  toJSON() { return "[MfaKeyring]"; }
  [util.inspect.custom]() { return "[MfaKeyring]"; }
  toString() { return "[MfaKeyring]"; }
}
function masterFor(ring, id) {
  const s = keyStore.get(ring);
  if (s.current.id === id) return s.current.key;
  const hit = s.previous.find((p) => p.id === id);
  if (!hit) throw cryptoError("mfa_key_unavailable");
  return hit.key;
}
function derived(ring, id, purpose) {
  const s = keyStore.get(ring); const slot = `${id}\u0000${purpose}`;
  if (!s.derived.has(slot)) s.derived.set(slot, hkdfSubkey(masterFor(ring, id), purpose));
  return s.derived.get(slot);
}

/** The UNVERIFIED subject (account id) named by a challenge token, used only to decide which live account to load before verifying it. Returns null for anything malformed. */
function challengeSubject(token) {
  if (typeof token !== "string") return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
    return claims && typeof claims.uid === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(claims.uid) ? claims.uid : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- the keyed API
const GCM_TAG_BYTES = 16, GCM_NONCE_BYTES = 12;
const ID_TEXT = /^[A-Za-z0-9._:-]{1,80}$/;
const aadFor = (userId, credentialId, keyId) => Buffer.from(`ochiga-office/mfa/totp/v1|${userId}|${credentialId}|${keyId}`, "utf8");
const b64urlEncode = (buffer) => buffer.toString("base64url");

function createMfaCrypto(config) {
  const ring = new MfaKeyring(loadMfaKeyring(config)); // throws mfa_unavailable unless MFA is on and the key configuration is valid
  if (typeof config.sessionSecret !== "string" || !config.sessionSecret) throw cryptoError("mfa_unavailable");
  const sessionIkm = Buffer.from(config.sessionSecret, "utf8");
  const challengeKey = (purpose) => hkdfSubkey(sessionIkm, purpose);

  function checkIds(ctx) {
    if (!ctx || !ID_TEXT.test(String(ctx.userId || "")) || !ID_TEXT.test(String(ctx.credentialId || ""))) throw cryptoError("mfa_crypto_invalid_parameters");
  }

  /** AES-256-GCM under the CURRENT key. AAD binds the account, the credential and the key id. Returns the three S7.5.1 columns. */
  function encryptTotpSecret(plaintext, ctx) {
    checkIds(ctx);
    if (!Buffer.isBuffer(plaintext) || plaintext.length < 1 || plaintext.length > 256) throw cryptoError("mfa_crypto_invalid_secret");
    const keyId = ring.currentKeyId; const nonce = crypto.randomBytes(GCM_NONCE_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", derived(ring, keyId, "totp-secret-encryption"), nonce, { authTagLength: GCM_TAG_BYTES });
    cipher.setAAD(aadFor(ctx.userId, ctx.credentialId, keyId));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { secret_ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"), secret_nonce: nonce.toString("base64"), secret_key_id: keyId };
  }

  /** Returns the plaintext Buffer (the caller should .fill(0) it). Any tamper, wrong AAD, wrong key or truncation is the same `mfa_decrypt_failed`. */
  function decryptTotpSecret(record, ctx) {
    checkIds(ctx);
    const keyId = record && record.secret_key_id;
    if (typeof keyId !== "string" || !ring.hasKey(keyId)) throw cryptoError("mfa_key_unavailable");
    try {
      const nonce = Buffer.from(String(record.secret_nonce), "base64"); const blob = Buffer.from(String(record.secret_ciphertext), "base64");
      if (nonce.length !== GCM_NONCE_BYTES || blob.length <= GCM_TAG_BYTES) throw new Error("shape");
      const decipher = crypto.createDecipheriv("aes-256-gcm", derived(ring, keyId, "totp-secret-encryption"), nonce, { authTagLength: GCM_TAG_BYTES });
      decipher.setAAD(aadFor(ctx.userId, ctx.credentialId, keyId));
      decipher.setAuthTag(blob.subarray(blob.length - GCM_TAG_BYTES));
      return Buffer.concat([decipher.update(blob.subarray(0, blob.length - GCM_TAG_BYTES)), decipher.final()]);
    } catch {
      throw cryptoError("mfa_decrypt_failed");
    }
  }

  const needsRotation = (record) => Boolean(record) && record.secret_key_id !== ring.currentKeyId;

  /** Decrypt then re-encrypt under the current key with a fresh nonce. */
  function rotateSecretRecord(record, ctx) {
    const plain = decryptTotpSecret(record, ctx);
    try { return encryptTotpSecret(plain, ctx); } finally { plain.fill(0); }
  }

  // ---- TOTP with the S7.5.1 atomic replay protection
  async function checkTotp({ store, userId, credentialId, code, nowMs = Date.now() }) {
    const record = await store.getMfaCredentialSecret(userId, credentialId);
    if (!record) return { ok: false, reason: "invalid" };
    const secret = decryptTotpSecret(record, { userId, credentialId });
    try {
      const result = verifyTotpCode({ secret, code, nowMs });
      return result.ok ? { ok: true, step: result.step, status: record.status } : { ok: false, reason: "invalid" };
    } finally { secret.fill(0); }
  }

  /** ACTIVE credentials only. The code is accepted at most once: the matched step is consumed by store.consumeTotpStep (single-statement compare-and-set). */
  async function verifyAndConsumeTotp({ store, userId, credentialId, code, nowMs = Date.now() }) {
    const checked = await checkTotp({ store, userId, credentialId, code, nowMs });
    if (!checked.ok) return checked;
    if (checked.status !== "active") return { ok: false, reason: "invalid" };
    return (await store.consumeTotpStep(userId, credentialId, checked.step)) ? { ok: true, step: checked.step } : { ok: false, reason: "replay" };
  }

  // ---- recovery codes
  const recoveryHash = (keyId, userId, normalized) => crypto.createHmac("sha256", derived(ring, keyId, "recovery-code-hmac")).update(`ochiga-office/mfa/recovery/v1|${userId}|${normalized}`).digest("base64url");
  function recoveryHashCandidates(userId, code) {
    const normalized = normalizeRecoveryCode(code);
    if (!normalized || !ID_TEXT.test(String(userId || ""))) return [];
    const s = keyStore.get(ring);
    return [s.current.id, ...s.previous.map((p) => p.id)].map((id) => recoveryHash(id, userId, normalized));
  }
  /** A fresh batch: the plain codes (to show once), their keyed hashes and the key id (store all hashes with it through replaceMfaRecoveryCodes). Nothing is persisted or logged here. */
  function newRecoveryBatch(userId, count = 10) {
    if (!ID_TEXT.test(String(userId || ""))) throw cryptoError("mfa_crypto_invalid_parameters");
    const codes = generateRecoveryCodes(count);
    return { codes, hmacs: codes.map((c) => recoveryHash(ring.currentKeyId, userId, normalizeRecoveryCode(c))), key_id: ring.currentKeyId };
  }
  /** Candidates only for the keys the account's unused codes were actually hashed under (unknown/legacy rows -> every key in the ring). Falls back to every key before the 20261023 migration. */
  async function verifyAndConsumeRecoveryCode({ store, userId, code }) {
    const normalized = normalizeRecoveryCode(code);
    if (!normalized || !ID_TEXT.test(String(userId || ""))) return { ok: false, reason: "invalid_format" };
    const s = keyStore.get(ring); const allIds = [s.current.id, ...s.previous.map((p) => p.id)];
    let keyIds = null;
    if (typeof store.listMfaRecoveryKeyIds === "function") {
      try { keyIds = await store.listMfaRecoveryKeyIds(userId); } catch (error) { if (error && error.code !== "mfa_schema_outdated") throw error; }
    }
    if (Array.isArray(keyIds) && keyIds.length === 0) return { ok: false, reason: "invalid" };
    const wanted = keyIds === null ? allIds : [...new Set(keyIds.flatMap((id) => (id === null ? allIds : ring.hasKey(id) ? [id] : [])))];
    for (const id of wanted) if (await store.consumeMfaRecoveryCode(userId, recoveryHash(id, userId, normalized))) return { ok: true };
    return { ok: false, reason: "invalid" };
  }
  /** How many unused recovery codes are NOT hashed under the current key (older keys and legacy rows). A previous key may be retired only when this is 0. */
  async function recoveryCodesBlockingRetirement({ store }) { return store.countUnusedRecoveryCodesNotUsingKey(ring.currentKeyId); }

  /** S7.5.4: the key ids whose hashes the account's unused codes use (null = every key: legacy rows, or the column is not there yet). */
  async function recoveryKeyIdsFor(store, userId) {
    const s = keyStore.get(ring); const allIds = [s.current.id, ...s.previous.map((p) => p.id)];
    let keyIds = null;
    if (typeof store.listMfaRecoveryKeyIds === "function") { try { keyIds = await store.listMfaRecoveryKeyIds(userId); } catch (error) { if (error && error.code !== "mfa_schema_outdated") throw error; } }
    if (Array.isArray(keyIds) && keyIds.length === 0) return [];
    return keyIds === null ? allIds : [...new Set(keyIds.flatMap((id) => (id === null ? allIds : ring.hasKey(id) ? [id] : [])))];
  }
  /**
   * S7.5.4: consume a recovery code AND end the account's other sessions in ONE database step (closes the S7.5.3 two-step gap). Returns
   * { ok: true, atomic: true, generation } | { ok: true, atomic: false } (the database predates 20261024: the caller must revoke itself) | { ok: false, reason }.
   */
  async function verifyAndConsumeRecoveryCodeRevoking({ store, userId, code, actor = "" }) {
    const normalized = normalizeRecoveryCode(code);
    if (!normalized || !ID_TEXT.test(String(userId || ""))) return { ok: false, reason: "invalid_format" };
    const ids = await recoveryKeyIdsFor(store, userId);
    if (!ids.length) return { ok: false, reason: "invalid" };
    for (const id of ids) {
      const hash = recoveryHash(id, userId, normalized);
      let revoked;
      try { revoked = await store.consumeMfaRecoveryCodeRevokingSessions(userId, hash, { actor }); }
      catch (error) {
        if (error && error.code === "mfa_unavailable") { for (const fallbackId of ids) if (await store.consumeMfaRecoveryCode(userId, recoveryHash(fallbackId, userId, normalized))) return { ok: true, atomic: false }; return { ok: false, reason: "invalid" }; }
        throw error;
      }
      if (revoked) return { ok: true, atomic: true, generation: revoked.session_generation };
    }
    return { ok: false, reason: "invalid" };
  }

  // ---- TOTP enrollment material (S7.5.4): a fresh secret, encrypted with the credential id as authenticated metadata. The plaintext secret leaves only as Base32 for the one-time display.
  function prepareTotpEnrollment({ userId, credentialId, account }) {
    const secret = generateTotpSecret();
    try {
      const secretBase32 = base32Encode(secret);
      return { credentialId, secretBase32, otpauthUri: buildOtpauthUri({ account, secretBase32 }), record: encryptTotpSecret(secret, { userId, credentialId }) };
    } finally { secret.fill(0); }
  }

  // ---- mailbox gate for forced enrollment: an 8-digit code derived from the enrollment challenge (valid exactly as long as it), delivered to the account's mailbox only
  const mailboxKey = () => challengeKey("mfa-email-code");
  function mailboxCodeFor(claims) {
    const mac = crypto.createHmac("sha256", mailboxKey()).update(`ochiga-office/mfa/mailbox/v1|${claims.jti}|${claims.uid}`).digest();
    return String(mac.readUInt32BE(0) % 100000000).padStart(8, "0");
  }
  function verifyMailboxCode(claims, code) {
    if (typeof code !== "string" || !/^[0-9]{8}$/.test(code.replace(/[ -]/g, ""))) return false;
    return equalText(mailboxCodeFor(claims), code.replace(/[ -]/g, ""));
  }

  // ---- challenge tokens
  const CHALLENGE_PURPOSES = ["login", "enroll", "enroll_verified"], CHALLENGE_DEFAULT_TTL_MS = 5 * 60_000, CHALLENGE_MAX_TTL_MS = 10 * 60_000;
  const bindingFor = (user) => crypto.createHmac("sha256", challengeKey("mfa-challenge-binding")).update(String(user.password_hash || "")).digest("hex").slice(0, 32);
  const signChallenge = (payload) => crypto.createHmac("sha256", challengeKey("mfa-challenge-signing")).update(payload).digest("hex");

  function issueChallengeToken({ user, purpose, ttlMs = CHALLENGE_DEFAULT_TTL_MS, nowMs = Date.now() }) {
    if (!user || !ID_TEXT.test(String(user.id || "")) || !CHALLENGE_PURPOSES.includes(purpose)) throw cryptoError("mfa_crypto_invalid_parameters");
    const ttl = Math.max(1000, Math.min(CHALLENGE_MAX_TTL_MS, Number.isFinite(Number(ttlMs)) ? Number(ttlMs) : CHALLENGE_DEFAULT_TTL_MS));
    const payload = b64urlEncode(Buffer.from(JSON.stringify({ v: 1, uid: String(user.id), purpose, pf: bindingFor(user), sg: effectiveGeneration(user), iat: nowMs, exp: nowMs + ttl, jti: crypto.randomBytes(12).toString("hex") })));
    return { token: `${payload}.${signChallenge(payload)}`, expires_at: new Date(nowMs + ttl).toISOString(), ttl_seconds: Math.round(ttl / 1000) };
  }

  /** `user` is the LIVE account. Reasons are categories only. */
  function verifyChallengeToken({ token, user, purpose, nowMs = Date.now() }) {
    if (typeof token !== "string" || !token) return { ok: false, reason: "missing" };
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined || !equalText(signChallenge(payload), signature)) return { ok: false, reason: "invalid" };
    let claims;
    try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return { ok: false, reason: "invalid" }; }
    if (!claims || claims.v !== 1 || typeof claims.exp !== "number" || typeof claims.uid !== "string") return { ok: false, reason: "invalid" };
    if (claims.exp <= nowMs) return { ok: false, reason: "expired" };
    if (!CHALLENGE_PURPOSES.includes(purpose) || claims.purpose !== purpose) return { ok: false, reason: "wrong_purpose" };
    if (!user || String(user.id) !== claims.uid) return { ok: false, reason: "wrong_user" };
    if (!equalText(claims.pf || "", bindingFor(user))) return { ok: false, reason: "password_changed" };
    if (claims.sg !== effectiveGeneration(user)) return { ok: false, reason: "revoked" };
    return { ok: true, claims: { uid: claims.uid, purpose: claims.purpose, iat: claims.iat, exp: claims.exp, jti: claims.jti } };
  }

  // ---- controlled rotation: re-encrypt credentials that still use an older key. Counts only; failures never name a credential's content.
  async function rotateCredentialSecrets({ store, limit = 100 }) {
    const pending = await store.listMfaCredentialsNotUsingKey(ring.currentKeyId, limit);
    const report = { scanned: pending.length, rotated: 0, skipped: 0, failed: 0 };
    for (const item of pending) {
      const record = await store.getMfaCredentialSecret(item.admin_user_id, item.id);
      if (!record || !needsRotation(record)) { report.skipped += 1; continue; }
      let next;
      try { next = rotateSecretRecord(record, { userId: item.admin_user_id, credentialId: item.id }); } catch { report.failed += 1; continue; }
      const swapped = await store.rotateMfaCredentialSecret(item.admin_user_id, item.id, { expected: { key_id: record.secret_key_id, nonce: record.secret_nonce }, next });
      if (swapped) report.rotated += 1; else report.skipped += 1;
    }
    return report;
  }

  return Object.freeze({
    keyring: ring, encryptTotpSecret, decryptTotpSecret, needsRotation, rotateSecretRecord, rotateCredentialSecrets,
    checkTotp, verifyAndConsumeTotp, recoveryHashCandidates, newRecoveryBatch, verifyAndConsumeRecoveryCode, verifyAndConsumeRecoveryCodeRevoking, recoveryCodesBlockingRetirement, prepareTotpEnrollment, mailboxCodeFor, verifyMailboxCode, issueChallengeToken, verifyChallengeToken,
  });
}

module.exports = {
  PURPOSES, TOTP_DEFAULTS, hkdfSubkey, hotp, totpCounter, totpAt, verifyTotpCode, base32Encode, base32Decode, generateTotpSecret, buildOtpauthUri,
  generateRecoveryCodes, normalizeRecoveryCode, challengeSubject, createMfaCrypto,
};
