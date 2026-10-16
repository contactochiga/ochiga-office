"use strict";

// Settings S7.5.5: thin, code-only wrapper around the vetted @simplewebauthn/server library. ALL CBOR/COSE/attestation/assertion parsing and signature verification happens inside the
// library; this file only (1) pins the policy (user verification required, no attestation trust, ES256/EdDSA/RS256 only), (2) converts between the library's base64url/Uint8Array
// values and the base64 strings the stores keep, and (3) turns every failure into a code-only error that never carries a response, key, challenge or library message.

const crypto = require("crypto");
const sw = require("@simplewebauthn/server");
const { validateWebauthnConfig } = require("./webauthn-config");

const ALGORITHMS = Object.freeze([-7, -8, -257]); // ES256, EdDSA, RS256 (no post-quantum, no legacy algorithms)
const TRANSPORTS = new Set(["usb", "nfc", "ble", "internal", "hybrid", "smart-card", "cable"]);
const MAX_CREDENTIALS = 10;
const CATEGORIES = Object.freeze(["challenge", "origin", "rp_id", "user_presence", "user_verification", "signature", "counter", "format", "unknown"]);

function failure(code, category) {
  const error = new Error(code);
  error.code = code;
  error.category = CATEGORIES.includes(category) ? category : "unknown";
  return error;
}

// library error messages are matched ONLY to choose an audit category; the message itself is dropped
function categorize(error) {
  const text = String(error && error.message || "").toLowerCase();
  if (text.includes("user verification")) return "user_verification";
  if (text.includes("user presence") || text.includes("user not present")) return "user_presence";
  if (text.includes("challenge")) return "challenge";
  if (text.includes("origin")) return "origin";
  if (text.includes("rp id") || text.includes("rpid")) return "rp_id";
  if (text.includes("signature")) return "signature";
  if (text.includes("counter")) return "counter";
  return "format";
}

const b64ToUrl = (b64) => Buffer.from(String(b64), "base64").toString("base64url");
const urlToB64 = (url) => Buffer.from(String(url), "base64url").toString("base64");
const cleanTransports = (list) => (Array.isArray(list) ? list.filter((t) => TRANSPORTS.has(t)).slice(0, 8) : []);
const userHandle = (userId) => crypto.createHash("sha256").update(`ochiga-office/webauthn-user/v1|${userId}`).digest(); // opaque, stable, not derived from the e-mail

function createWebauthn(config) {
  const status = validateWebauthnConfig(config);
  if (!status.available) throw failure("webauthn_unavailable", "unknown");
  const { rpId, rpName, origins } = status;

  return Object.freeze({
    rpId,
    /** `existing`: the account's WebAuthn credentials ([{ credential_id (base64), transports }]) so the authenticator refuses to register the same one twice. */
    async registrationOptions({ user, existing = [], challenge }) {
      return sw.generateRegistrationOptions({
        rpName, rpID: rpId, userName: user.email, userDisplayName: user.display_name || user.email, userID: userHandle(user.id), challenge,
        attestationType: "none", timeout: 120_000, supportedAlgorithmIDs: [...ALGORITHMS],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        excludeCredentials: existing.map((c) => ({ id: b64ToUrl(c.credential_id), transports: cleanTransports(c.transports) })),
      });
    },
    /** `expectedChallenge`: the base64url challenge consumed from the store. Returns the material to persist, or throws a code-only error. */
    async verifyRegistration({ response, expectedChallenge }) {
      let result;
      try {
        result = await sw.verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origins, expectedRPID: rpId, requireUserVerification: true, supportedAlgorithmIDs: [...ALGORITHMS] });
      } catch (error) { throw failure("webauthn_verification_failed", categorize(error)); }
      if (!result || !result.verified || !result.registrationInfo || !result.registrationInfo.credential) throw failure("webauthn_verification_failed", "format");
      const info = result.registrationInfo;
      return {
        credential_id: urlToB64(info.credential.id), public_key: Buffer.from(info.credential.publicKey).toString("base64"),
        sign_count: Number.isSafeInteger(info.credential.counter) ? info.credential.counter : 0, transports: cleanTransports(info.credential.transports || (response.response && response.response.transports)),
        aaguid: typeof info.aaguid === "string" ? info.aaguid : null, backup_eligible: info.credentialDeviceType === "multiDevice",
      };
    },
    async authenticationOptions({ allow, challenge }) {
      return sw.generateAuthenticationOptions({ rpID: rpId, challenge, timeout: 120_000, userVerification: "required", allowCredentials: allow.map((c) => ({ id: b64ToUrl(c.credential_id), transports: cleanTransports(c.transports) })) });
    },
    /** `credential`: the stored row ({ credential_id, public_key, sign_count, transports }). Returns { newCounter } or throws a code-only error. */
    async verifyAuthentication({ response, expectedChallenge, credential }) {
      let result;
      try {
        result = await sw.verifyAuthenticationResponse({
          response, expectedChallenge, expectedOrigin: origins, expectedRPID: rpId, requireUserVerification: true,
          credential: { id: b64ToUrl(credential.credential_id), publicKey: new Uint8Array(Buffer.from(credential.public_key, "base64")), counter: Number(credential.sign_count) || 0, transports: cleanTransports(credential.transports) },
        });
      } catch (error) { throw failure("webauthn_verification_failed", categorize(error)); }
      if (!result || !result.verified || !result.authenticationInfo) throw failure("webauthn_verification_failed", "signature");
      return { newCounter: Number.isSafeInteger(result.authenticationInfo.newCounter) ? result.authenticationInfo.newCounter : 0 };
    },
  });
}

module.exports = { createWebauthn, MAX_CREDENTIALS, ALGORITHMS, b64ToUrl, urlToB64 };
