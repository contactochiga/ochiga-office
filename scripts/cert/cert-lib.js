// S7.5.9 certification harness. INDEPENDENT of the implementation's MFA code: it has its own RFC 6238 TOTP, RFC 4648 base32, a minimal CBOR encoder and a software WebAuthn authenticator.
// It may import only what is needed to BOOT the system under test (server, config, store, password hasher to seed accounts). Everything else is observed over HTTP.
"use strict";
const crypto = require("node:crypto");
const { createConfig } = require("../../src/lead-agents/config");
const { buildServer } = require("../../src/lead-agents/server");
const { MemoryRateLimiter } = require("../../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../../src/lead-agents/tools");
const { WebhookDispatcher } = require("../../src/lead-agents/webhooks");
const { createTempStore } = require("../../src/lead-agents/testing");
const { hashPassword } = require("../../src/lead-agents/auth");

const A = "/api/lead-agents/admin";
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const b64u = (b) => Buffer.from(b).toString("base64url");

// ---- own RFC 4648 base32 and RFC 6238 TOTP (SHA-1, 6 digits, 30 s)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(text) { let bits = 0, value = 0; const out = []; for (const ch of String(text).replace(/[\s=-]/g, "").toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) throw new Error("bad base32"); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function totp(secret, { at = Date.now(), step = 0 } = {}) {
  const counter = Math.floor(at / 30000) + step; const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", secret).update(msg).digest(); const o = h[19] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]; return String(bin % 1_000_000).padStart(6, "0");
}

// ---- minimal CBOR encoder (maps with int/text keys, ints, bytes, text) for the attestation object and COSE key
function cbor(v) {
  const head = (major, n) => { if (n < 24) return Buffer.from([(major << 5) | n]); if (n < 256) return Buffer.from([(major << 5) | 24, n]); if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]); throw new Error("too large"); };
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "string") { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("unsupported cbor value");
}

// ---- software WebAuthn authenticator (ES256, attestation "none")
class Authenticator {
  constructor({ origin, rpId = "localhost" }) { this.origin = origin; this.rpId = rpId; this.credentialId = crypto.randomBytes(32); this.counter = 0; const k = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }); this.privateKey = k.privateKey; this.jwk = k.publicKey.export({ format: "jwk" }); }
  get id() { return b64u(this.credentialId); }
  flags({ uv = true, up = true, at = false }) { return (up ? 1 : 0) | (uv ? 4 : 0) | (at ? 0x40 : 0); }
  create(options, o = {}) {
    const rpIdHash = sha256(o.rpId || this.rpId); const counter = Buffer.alloc(4); counter.writeUInt32BE(o.counter ?? this.counter);
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.jwk.x, "base64url")], [-3, Buffer.from(this.jwk.y, "base64url")]]));
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([rpIdHash, Buffer.from([this.flags({ ...o, at: true })]), counter, Buffer.alloc(16), len, this.credentialId, cose]);
    const clientData = Buffer.from(JSON.stringify({ type: o.type || "webauthn.create", challenge: o.challenge || options.challenge, origin: o.origin || this.origin, crossOrigin: false }));
    const att = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ["internal"] }, clientExtensionResults: {} };
  }
  assert(options, o = {}) {
    if (o.counter === undefined) this.counter += 1; const c = o.counter ?? this.counter; const counter = Buffer.alloc(4); counter.writeUInt32BE(c);
    const authData = Buffer.concat([sha256(o.rpId || this.rpId), Buffer.from([this.flags(o)]), counter]);
    const clientData = Buffer.from(JSON.stringify({ type: o.type || "webauthn.get", challenge: o.challenge || options.challenge, origin: o.origin || this.origin, crossOrigin: false }));
    let sig = crypto.sign("sha256", Buffer.concat([authData, sha256(clientData)]), o.signWith || this.privateKey); if (o.tamper) { sig = Buffer.from(sig); sig[sig.length - 1] ^= 1; }
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: null }, clientExtensionResults: {} };
  }
}

// ---- forging: the session token is payload.hex(HMAC-SHA256(secret, payload)); certification may forge with the deployment secret to test what the VERIFIER does with odd tokens
function forgeSession(config, claims, { secret } = {}) { const payload = Buffer.from(JSON.stringify(claims)).toString("base64url"); const sig = crypto.createHmac("sha256", secret ?? config.sessionSecret).update(payload).digest("hex"); return `${config.sessionCookieName}=${encodeURIComponent(`${payload}.${sig}`)}`; }
function decodeCookie(cookie) { const raw = decodeURIComponent(cookie.split("=").slice(1).join("=")); return { raw, claims: JSON.parse(Buffer.from(raw.split(".")[0], "base64url").toString()) }; }

// ---- boot
async function boot(over = {}, opts = {}) {
  const { store } = opts.store ? { store: opts.store } : await createTempStore();
  const secret = over.sessionSecret || `cert-session-secret-${crypto.randomBytes(24).toString("hex")}`;
  const mfaKey = over.mfaKey ?? crypto.randomBytes(32).toString("base64");
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["cert-api-key-0123456789abcdef"], edgeAgentTokens: ["cert-edge-token-0123456789abcdef"], allowedOrigins: [], sessionSecret: secret, sessionSecretEphemeral: false, mfaMode: "on", mfaKey, mfaKeyId: "k1", mfaKeysPrevious: "", officeEmailProvider: "", resendApiKey: "", webauthnRpId: "localhost", webauthnOrigins: [], mfaFleetAttested: "", mfaRecoveryApproved: false, allowApiKeyPasswordLogin: false, stepUpTtlMs: 5 * 60_000, ...over };
  const rl = (n) => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: n });
  const server = buildServer({ config, store, rateLimiter: rl(100000), publicRateLimiter: rl(100000), officeRateLimiter: rl(100000), loginRateLimiter: rl(opts.loginMax || 100000), whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] }, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const port = await new Promise((r, j) => { server.once("error", j); server.listen(0, "127.0.0.1", () => r(server.address().port)); });
  const origin = `http://localhost:${port}`; config.webauthnOrigins = [origin];
  const seen = [];
  async function call(method, path, { cookie, body, token, apiKey, edge, headers } = {}) {
    const r = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { "x-step-up-token": token } : {}), ...(apiKey ? { "x-api-key": apiKey } : {}), ...(edge ? { "x-edge-token": edge } : {}), ...(headers || {}) }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await r.text(); seen.push(text); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } const sc = r.headers.get("set-cookie") || "";
    return { status: r.status, json, text, headers: r.headers, setCookie: sc, cookie: sc.split(";")[0].includes("=") && sc.split(";")[0].split("=")[1] ? sc.split(";")[0] : "" };
  }
  return { store, config, server, origin, port, call, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

// ---- accounts and flows (all over HTTP)
let counter = 0;
async function seed(sys, label, role = "super_admin", extra = {}) { counter += 1; const email = `${label}${counter}@cert.test`; const password = `${label}${counter} cert passphrase number 7!`; const user = await sys.store.ensureAdminUser({ email, password_hash: hashPassword(password), role, display_name: label, status: "active", ...extra }); return { id: user.id, email, password, role }; }
const loginBody = (u, password) => ({ email: u.email, password: password ?? u.password });
async function loginPlain(sys, u) { const r = await sys.call("POST", `${A}/session/login`, { body: loginBody(u) }); return r; }
async function stepUp(sys, cookie, u, purpose, mfa) { return sys.call("POST", `${A}/session/step-up`, { cookie, body: { password: u.password, purpose, ...(mfa ? { mfa } : {}) } }); }
// forget the replay marker so a test can sign in again within the same 30 s step (test infrastructure; replay itself is tested WITHOUT calling this)
async function freshStep(sys, u) { if (sys.resetStep) return sys.resetStep(u); for (const c of sys.store.state.admin_mfa_credentials) if (c.admin_user_id === u.id && c.type === "totp") c.totp_last_step = 0; await sys.store.clearMfaFailures(u.id); }
async function enrollTotp(sys, u) {
  const cookie = (await loginPlain(sys, u)).cookie; const g = (await stepUp(sys, cookie, u, "mfa_management")).json.step_up.token;
  const b = await sys.call("POST", `${A}/session/mfa/enroll/totp/begin`, { cookie, token: g, body: {} }); const secret = base32Decode(b.json.secret_base32);
  const c = await sys.call("POST", `${A}/session/mfa/enroll/totp/confirm`, { cookie, token: g, body: { credential_id: b.json.credential_id, code: totp(secret) } });
  if (c.status !== 200) throw new Error(`enrol failed ${c.status} ${c.text.slice(0, 120)}`); u.secret = secret; u.codes = c.json.recovery_codes; return { secret, codes: c.json.recovery_codes, cookie: c.cookie, begin: b.json };
}
async function signInTotp(sys, u) { await freshStep(sys, u); const l = await loginPlain(sys, u); if (!l.json.mfa_required) throw new Error("no challenge"); const v = await sys.call("POST", `${A}/session/mfa/verify`, { body: { challenge_token: l.json.challenge_token, method: "totp", code: totp(u.secret) } }); if (v.status !== 200) throw new Error(`mfa sign-in failed ${v.status}`); return v.cookie; }
async function setLevel(sys, level) { const row = await sys.store.getRuntimeSetting("office_mfa_enforcement"); await sys.store.writeRuntimeSetting("office_mfa_enforcement", level, "cert", { expectedVersion: row ? row.version : 0 }); }

// ---- tiny assertion recorder: every check is named and counted
function recorder(title) { const results = []; let n = 0; const check = (cond, name) => { n += 1; results.push({ ok: Boolean(cond), name }); if (!cond) console.log(`  FAIL: ${name}`); return Boolean(cond); }; const eq = (a, b, name) => check(a === b, `${name} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`); const done = () => { const failed = results.filter((r) => !r.ok); console.log(`${title}: ${n - failed.length}/${n} checks passed${failed.length ? `, ${failed.length} FAILED` : ""}`); return failed; }; return { check, eq, done, results }; }

module.exports = { A, boot, seed, loginBody, loginPlain, stepUp, enrollTotp, signInTotp, freshStep, setLevel, totp, base32Decode, Authenticator, forgeSession, decodeCookie, recorder, sha256, b64u, crypto, hashPassword };
