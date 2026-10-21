"use strict";
// Independent helper code for AREA B tests: RFC 4648 base32, RFC 6238 TOTP, CBOR encoder, software WebAuthn authenticator (ES256, attestation "none").
// Nothing here imports anything from the system under test.
const crypto = require("crypto");

// ---------------------------------------------------------------- base32 (RFC 4648)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32encode(buf) {
  let bits = 0, val = 0, out = "";
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(text) {
  const s = String(text).toUpperCase().replace(/=+$/, "").replace(/[\s-]/g, "");
  let bits = 0, val = 0; const out = [];
  for (const ch of s) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error("bad base32");
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------- HOTP / TOTP (RFC 4226 / 6238, SHA-1, 6 digits, 30 s)
function hotp(secret, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", secret).update(msg).digest();
  const o = mac[mac.length - 1] & 15;
  const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 1000000).padStart(6, "0");
}
const stepNow = (ms = Date.now()) => Math.floor(ms / 30000);
function totpAtStep(secretB32, step) { return hotp(b32decode(secretB32), step); }
// RFC 6238 Appendix B vector self-check (SHA-1, secret "12345678901234567890", T=59 -> 94287082 (8 digits); 6-digit tail 287082)
function selfTest() { return hotp(Buffer.from("12345678901234567890"), Math.floor(59 / 30)) === "287082"; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Waits (polling the clock) until the TOTP step is >= `step`. Explicit readiness condition, not a fixed delay. */
async function waitForStep(step, maxMs = 70000) {
  const end = Date.now() + maxMs;
  while (stepNow() < step) { if (Date.now() > end) throw new Error("timeout waiting for TOTP step"); await sleep(250); }
}
/**
 * A code that is valid now and for the next ~30-60 s: step cur if cur > lastStep, else cur+1 if > lastStep, else waits for the clock to roll.
 * Returns { code, step }.
 */
async function nextTotp(secretB32, lastStep = 0) {
  let cur = stepNow();
  if (lastStep >= cur + 1) { await waitForStep(lastStep); cur = stepNow(); }
  const step = cur > lastStep ? cur : cur + 1;
  return { code: totpAtStep(secretB32, step), step };
}

// ---------------------------------------------------------------- CBOR (RFC 8949) subset
function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v) {
  if (typeof v === "number") return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === "string") { const t = Buffer.from(v, "utf8"); return Buffer.concat([cborHead(3, t.length), t]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([cborHead(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([cborHead(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported");
}

const b64u = (b) => Buffer.from(b).toString("base64url");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();

// ---------------------------------------------------------------- software WebAuthn authenticator (ES256, attestation none)
const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 };
class SoftAuthenticator {
  constructor({ rpId = "localhost", origin, counter = 0, zero = false, uv = true, up = true, backupEligible = false } = {}) {
    this.zero = zero;
    const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.priv = kp.privateKey; this.pub = kp.publicKey;
    this.credId = crypto.randomBytes(32);
    this.rpId = rpId; this.origin = origin; this.counter = counter; this.uv = uv; this.up = up; this.backupEligible = backupEligible;
    this.aaguid = Buffer.alloc(16);
  }
  get id() { return b64u(this.credId); }
  coseKey() {
    const jwk = this.pub.export({ format: "jwk" });
    return cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
  }
  flags({ up, uv, at } = {}) {
    let f = 0;
    if (up === undefined ? this.up : up) f |= FLAG.UP;
    if (uv === undefined ? this.uv : uv) f |= FLAG.UV;
    if (this.backupEligible) f |= FLAG.BE;
    if (at) f |= FLAG.AT;
    return f;
  }
  authData({ rpId, up, uv, counter, attested } = {}) {
    const rp = sha256(Buffer.from(rpId === undefined ? this.rpId : rpId));
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(counter === undefined ? this.counter : counter);
    const parts = [rp, Buffer.from([this.flags({ up, uv, at: attested })]), cnt];
    if (attested) {
      const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.credId.length);
      parts.push(this.aaguid, idLen, this.credId, this.coseKey());
    }
    return Buffer.concat(parts);
  }
  clientData(type, challenge, origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: origin === undefined ? this.origin : origin, crossOrigin: false }));
  }
  /** options: the `options` object returned by register/options. Overrides allow bad responses. */
  register(options, o = {}) {
    const challenge = o.challenge === undefined ? options.challenge : o.challenge;
    const cd = this.clientData(o.type || "webauthn.create", challenge, o.origin);
    const authData = this.authData({ rpId: o.rpId, up: o.up, uv: o.uv, counter: o.counter, attested: true });
    const att = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(cd), attestationObject: b64u(att), transports: o.transports || ["internal"] },
    };
  }
  /** Produces an assertion. By default the counter is incremented first (a normal authenticator) unless `zero` (a synced passkey that always reports 0) or `counter` overrides. */
  assert(options, o = {}) {
    if (o.counter === undefined && !this.zero && !o.noIncrement) this.counter += 1;
    const counter = o.counter === undefined ? this.counter : o.counter;
    const challenge = o.challenge === undefined ? options.challenge : o.challenge;
    const cd = this.clientData(o.type || "webauthn.get", challenge, o.origin);
    const ad = this.authData({ rpId: o.rpId, up: o.up, uv: o.uv, counter });
    const signedData = Buffer.concat([ad, sha256(cd)]);
    const key = o.signWith || this.priv;
    let sig = crypto.sign("sha256", signedData, key);
    if (o.corruptSignature) { sig = Buffer.from(sig); sig[sig.length - 1] ^= 0xff; }
    return {
      id: o.id === undefined ? this.id : o.id, rawId: o.id === undefined ? this.id : o.id, type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: o.userHandle },
    };
  }
}

function randomPassword() { return `Zx${crypto.randomBytes(9).toString("hex")}Qv!7`; }
function randomKeyB64() { return crypto.randomBytes(32).toString("base64"); }
function randomSecret() { return crypto.randomBytes(24).toString("hex"); }

module.exports = { b32encode, b32decode, hotp, stepNow, totpAtStep, selfTest, sleep, waitForStep, nextTotp, cbor, b64u, sha256, SoftAuthenticator, FLAG, randomPassword, randomKeyB64, randomSecret };
