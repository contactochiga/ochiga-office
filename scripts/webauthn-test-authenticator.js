"use strict";

// TEST-ONLY software authenticator for the S7.5.5 suites. It BUILDS registration and assertion messages (using the CBOR encoder that ships with the vetted server library) with
// switches for every fault the tests need (wrong origin, wrong RP, missing user verification/presence, bad signature, counter control). The server's verification is done entirely by
// @simplewebauthn/server; nothing here verifies anything. Not imported by any production module.

const crypto = require("node:crypto");
const { encodeCBOR } = require("@levischuck/tiny-cbor");

const b64u = (buffer) => Buffer.from(buffer).toString("base64url");
const sha256 = (data) => crypto.createHash("sha256").update(data).digest();
const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 };

class SoftwareAuthenticator {
  constructor({ rpId = "localhost", origin, counter = 0, backupEligible = false, aaguid = crypto.randomBytes(16), credentialId } = {}) {
    this.rpId = rpId; this.origin = origin; this.counter = counter; this.backupEligible = backupEligible; this.aaguid = aaguid;
    this.credentialId = credentialId ? Buffer.from(credentialId) : crypto.randomBytes(32);
    const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }); this.privateKey = pair.privateKey; this.publicKey = pair.publicKey; this.jwk = pair.publicKey.export({ format: "jwk" });
  }
  get id() { return b64u(this.credentialId); }
  coseKey() { return Buffer.from(encodeCBOR(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.jwk.x, "base64url")], [-3, Buffer.from(this.jwk.y, "base64url")]]))); }
  flags({ uv = true, up = true, attested = false } = {}) { return (up ? FLAG.UP : 0) | (uv ? FLAG.UV : 0) | (attested ? FLAG.AT : 0) | (this.backupEligible ? FLAG.BE : 0); }
  authData({ rpId = this.rpId, uv, up, counter, attested }) {
    const head = Buffer.alloc(37); sha256(rpId).copy(head, 0); head[32] = this.flags({ uv, up, attested }); head.writeUInt32BE(counter >>> 0, 33);
    if (!attested) return head;
    const idLength = Buffer.alloc(2); idLength.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([head, this.aaguid, idLength, this.credentialId, this.coseKey()]);
  }
  clientData({ type, challenge, origin = this.origin }) { return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })); }

  /** `options`: the PublicKeyCredentialCreationOptionsJSON the server returned. Returns a RegistrationResponseJSON. */
  createCredential(options, { origin, rpId, uv = true, up = true, type = "webauthn.create", challenge, transports = ["internal"], counter = this.counter } = {}) {
    const clientDataJSON = this.clientData({ type, challenge: challenge ?? options.challenge, origin });
    const attestationObject = Buffer.from(encodeCBOR(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData({ rpId, uv, up, counter, attested: true })]])));
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports }, clientExtensionResults: {}, authenticatorAttachment: "platform" };
  }
  /** `options`: the PublicKeyCredentialRequestOptionsJSON the server returned. `useCounter`: explicit counter (else the authenticator increments its own). */
  getAssertion(options, { origin, rpId, uv = true, up = true, type = "webauthn.get", challenge, useCounter, signWith, tamperSignature = false } = {}) {
    if (useCounter === undefined) { this.counter += 1; }
    const counter = useCounter === undefined ? this.counter : useCounter;
    const clientDataJSON = this.clientData({ type, challenge: challenge ?? options.challenge, origin });
    const authenticatorData = this.authData({ rpId, uv, up, counter, attested: false });
    let signature = crypto.sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), signWith || this.privateKey);
    if (tamperSignature) { signature = Buffer.from(signature); signature[signature.length - 1] ^= 1; }
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature), userHandle: null }, clientExtensionResults: {}, authenticatorAttachment: "platform" };
  }
}

module.exports = { SoftwareAuthenticator };
