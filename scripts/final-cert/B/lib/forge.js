"use strict";
// Token forging for negative tests. The test knows the session secret it configured, so it can mint correctly signed tokens with chosen claims (expired, wrong purpose, ...)
// and thereby test that the SERVER's checks (not just its signature check) refuse them. Derivations follow the written contracts (docs 21, 24, 27, 29, 30); no SUT module is imported.
const crypto = require("crypto");

const hmacHex = (key, data) => crypto.createHmac("sha256", key).update(data).digest("hex");
const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

function hkdf(secret, purpose) {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("ochiga-office/mfa/v1"), Buffer.from(`ochiga-office/mfa/v1/${purpose}`), 32));
}

class Forge {
  constructor(srv) { this.srv = srv; this.secret = srv.env.LEAD_AGENTS_SESSION_SECRET; }
  user(idOrEmail) {
    const s = this.srv.readStore(); const list = (s && s.admin_users) || [];
    return list.find((u) => u.id === idOrEmail || u.email === String(idOrEmail).toLowerCase());
  }
  gen(u) { return Number.isInteger(u.session_generation) && u.session_generation >= 0 ? u.session_generation : 0; }
  // ---- MFA challenge token (login | enroll | enroll_verified)
  challenge(u, { purpose = "login", ttlMs = 300000, iat = Date.now(), exp, sg, pf, uid, signWith } = {}) {
    u = typeof u === "string" ? this.user(u) : u;
    const binding = hmacHex(hkdf(this.secret, "mfa-challenge-binding"), String(u.password_hash || "")).slice(0, 32);
    const payload = b64u({ v: 1, uid: uid || String(u.id), purpose, pf: pf || binding, sg: sg === undefined ? this.gen(u) : sg, iat, exp: exp === undefined ? iat + ttlMs : exp, jti: crypto.randomBytes(12).toString("hex") });
    return `${payload}.${hmacHex(signWith || hkdf(this.secret, "mfa-challenge-signing"), payload)}`;
  }
  // ---- session cookie value
  session(u, { mf = false, mft, exp = Date.now() + 3600000, sg, pf, sid, role, scopes, email, userId, extra = {} } = {}) {
    u = typeof u === "string" ? this.user(u) : u;
    const key = crypto.createHmac("sha256", this.secret).update("ochiga-office/session-pf/v1").digest();
    const payloadObj = {
      email: email || u.email, role: role || u.role, user_id: userId || u.id, permission_scopes: scopes || u.permission_scopes || [], exp,
      sg: sg === undefined ? this.gen(u) : sg, ...(mf ? { mf: 1, mft: mft === undefined ? Date.now() : mft } : {}), ...(sid ? { sid } : {}),
      pf: pf || hmacHex(key, String(u.password_hash || "")).slice(0, 32), ...extra,
    };
    const payload = b64u(payloadObj);
    return `${payload}.${hmacHex(this.secret, payload)}`;
  }
  // ---- step-up grant bound to a given session cookie value
  grant(u, cookieValue, { purpose = "mfa_management", mf = false, mfat, iat = Date.now(), exp, sg, pwf, sid, sub, email } = {}) {
    u = typeof u === "string" ? this.user(u) : u;
    const key = crypto.createHmac("sha256", this.secret).update("ochiga-office/step-up/v1").digest();
    const keyed = (label, value) => hmacHex(key, `${label}:${String(value || "")}`).slice(0, 32);
    const binding = crypto.createHash("sha256").update(String(cookieValue)).digest("hex");
    const claims = { v: 1, purpose, sub: sub || u.id, email: email || u.email, sg: sg === undefined ? this.gen(u) : sg, ...(mf ? { mf: true, mfat: mfat === undefined ? iat : mfat } : {}), sid: sid || keyed("sid", binding), pwf: pwf || keyed("pwf", u.password_hash), iat, exp: exp === undefined ? iat + 300000 : exp, jti: crypto.randomBytes(12).toString("hex") };
    const payload = b64u(claims);
    return `${payload}.${hmacHex(key, payload)}`;
  }
}

const decodePayload = (token) => { try { return JSON.parse(Buffer.from(String(token).split(".")[0], "base64url").toString("utf8")); } catch { return null; } };
function flip(token) { const parts = token.split("."); const sig = parts[parts.length - 1]; parts[parts.length - 1] = (sig[0] === "0" ? "1" : "0") + sig.slice(1); return parts.join("."); }
function retamper(token, mutate) { const claims = decodePayload(token); mutate(claims); return `${b64u(claims)}.${token.split(".")[1]}`; }

module.exports = { Forge, decodePayload, flip, retamper, b64u };
