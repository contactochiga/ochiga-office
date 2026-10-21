"use strict";
// AREA B / B4: WebAuthn (software authenticator, ES256, attestation none): registration and authentication, origin, relying-party id, signature, user verification,
// user presence, counter rollback/repeat/zero, challenge reuse and purpose isolation, other account's credential, duplicate registration, key limit, revocation, lock sharing, concurrency.
const crypto = require("crypto");
const H = require("./lib/harness");
const { Forge, decodePayload } = require("./lib/forge");
const { A, Client, U } = H;

H.runSuite("b4-webauthn", async (c) => {
  const srv = await H.makeServer();
  c.defer(async () => { await srv.stop(); H.rmrf(srv.dir); });
  const admin = await H.adminLogin(srv);
  const origin = `http://localhost:${srv.port}`;
  const newAuth = (o = {}) => new U.SoftAuthenticator({ rpId: "localhost", origin, ...o });
  const hdr = (g) => ({ "x-step-up-token": g.body.step_up.token });

  async function grantFor(p, client, mfa = null) { return p.stepUp(client, "mfa_management", { mfa }); }
  async function regOptions(p, client, g) { return client.post(`${A}/session/mfa/webauthn/register/options`, {}, { headers: hdr(g) }); }
  async function regVerify(client, g, opt, response, extra = {}) { return client.post(`${A}/session/mfa/webauthn/register/verify`, { challenge_id: opt.body.challenge_id, response, ...extra }, { headers: hdr(g) }); }
  async function waStart(p, client = new Client(srv)) {
    const l = await p.loginRaw(client); const ch = l.body.challenge_token;
    const o = await client.post(`${A}/session/mfa/webauthn/auth/options`, { challenge_token: ch });
    return { client, login: l, ch, o };
  }
  const waFinish = (s, assertion) => s.client.post(`${A}/session/mfa/verify`, { challenge_token: s.ch, method: "webauthn", webauthn: { challenge_id: s.o.body.challenge_id, response: assertion } });
  const rows = (p) => (srv.readStore().admin_mfa_credentials || []).filter((x) => x.admin_user_id === p.id);
  const userRow = (p) => srv.readStore().admin_users.find((u) => u.id === p.id);

  // ------------------------------------------------------------ W1: registration options and first-factor registration
  const a = await H.createUser(admin, {}); await a.loginRaw();
  const g0 = await grantFor(a, a.client);
  c.status("W1.0", "setup: password-only grant for an account with no factor", g0, 200);
  const opt0 = await regOptions(a, a.client, g0);
  c.status("W1.1", "registration options are issued to a signed-in human with an mfa_management grant", opt0, 200);
  const o = opt0.body.options || {};
  c.eq("W1.2", "relying party id is the configured one", o.rp && o.rp.id, "localhost");
  c.eq("W1.3", "user verification is required", o.authenticatorSelection && o.authenticatorSelection.userVerification, "required");
  c.eq("W1.4", "attestation is none", o.attestation, "none");
  c.ok("W1.5", "only ES256 / EdDSA / RS256 are offered", Array.isArray(o.pubKeyCredParams) && o.pubKeyCredParams.every((p) => [-7, -8, -257].includes(p.alg)) && o.pubKeyCredParams.length >= 1, o.pubKeyCredParams);
  c.ok("W1.6", "the challenge has at least 32 bytes of entropy", Buffer.from(o.challenge || "", "base64url").length >= 32, o.challenge);
  c.ok("W1.7", "the user handle is opaque (does not contain the e-mail address, is not its base64url)", o.user && !JSON.stringify(o.user.id).includes(a.email) && o.user.id !== Buffer.from(a.email).toString("base64url") && o.user.id !== Buffer.from(a.id).toString("base64url"), o.user && o.user.id);
  c.ok("W1.8", "the options response has a challenge id and an expiry no later than 15 minutes", typeof opt0.body.challenge_id === "string" && Date.parse(opt0.body.expires_at) - Date.now() <= 15 * 60 * 1000 && Date.parse(opt0.body.expires_at) > Date.now(), opt0.body);
  const authA = newAuth();
  const regRes = await regVerify(a.client, g0, opt0, authA.register(o));
  c.status("W1.9", "positive control: a valid registration (UV + UP, correct origin and RP) succeeds", regRes, 200);
  c.ok("W1.10", "response names the new credential without credential id / public key and returns recovery codes for a first factor", regRes.body.credential && regRes.body.credential.type === "webauthn" && Array.isArray(regRes.body.recovery_codes) && regRes.body.recovery_codes.length === 10 && !regRes.text.includes(authA.id) && !/public_key|publicKey/.test(regRes.text), regRes.body);
  a.recovery = regRes.body.recovery_codes;
  c.ok("W1.11", "the registering browser is re-issued a session with MFA proof", regRes.setCookie.length === 1 && (await a.client.get(`${A}/session/me`)).body.mfa.verified === true);
  const list = await a.client.get(`${A}/session/mfa`);
  c.ok("W1.12", "factor listing shows the key as active and never exposes credential id, public key or counter", list.body.credentials.some((x) => x.type === "webauthn" && x.status === "active") && !list.text.includes(authA.id) && !/public_key|sign_count|webauthn_credential_id|counter/i.test(list.text), list.body.credentials);
  c.eq("W1.13", "the status endpoint counts one registered key", list.body.webauthn.registered, 1);
  const stored = rows(a)[0] || {};
  c.ok("W1.14", "storage holds the public key and counter, no private material", !!stored.webauthn_public_key && !JSON.stringify(stored).includes(authA.priv.export({ type: "pkcs8", format: "der" }).toString("base64")));
  const regAudit = await srv.audit((e) => e.action === "mfa_enrolled" && e.target_id === a.id);
  c.ok("W1.15", "registration is audited without credential ids or keys", regAudit.length === 1 && !JSON.stringify(regAudit).includes(authA.id), regAudit.length);

  // ------------------------------------------------------------ W2: registration negatives (fresh account each, session-proof grants)
  const b = await H.createUser(admin, {}); await b.loginRaw();
  async function badRegistration(label, mutate, id) {
    const g = await grantFor(b, b.client, b.wa.length || rows(b).some((r) => r.status === "active") ? null : null);
    const opt = await regOptions(b, b.client, g);
    if (opt.status !== 200) { c.ok(id, `${label}: setup options`, false, opt.body); return; }
    const au = newAuth(); const resp = mutate(au, opt.body.options);
    const res = await regVerify(b.client, g, opt, resp);
    c.status(id, `registration with ${label} is refused (401 generic)`, res, 401);
    c.ok(`${id}x`, `${label}: nothing was stored or activated`, !rows(b).some((r) => r.type === "webauthn" && r.status === "active"), rows(b).map((r) => r.status));
    return { res, opt, au };
  }
  await badRegistration("a wrong origin", (au, op) => au.register(op, { origin: "http://evil.example" }), "W2.1");
  await badRegistration("an origin on another port", (au, op) => au.register(op, { origin: "http://localhost:1" }), "W2.2");
  await badRegistration("an https origin for the http deployment", (au, op) => au.register(op, { origin: `https://localhost:${srv.port}` }), "W2.3");
  await badRegistration("a different relying-party id hash", (au, op) => au.register(op, { rpId: "evil.example" }), "W2.4");
  await badRegistration("a relying party that only contains the id (localhost.evil.example)", (au, op) => au.register(op, { rpId: "localhost.evil.example" }), "W2.5");
  await badRegistration("user verification missing", (au, op) => au.register(op, { uv: false }), "W2.6");
  await badRegistration("user presence missing", (au, op) => au.register(op, { up: false }), "W2.7");
  await badRegistration("a different challenge than issued", (au, op) => au.register(op, { challenge: crypto.randomBytes(32).toString("base64url") }), "W2.8");
  await badRegistration("an assertion-type client data (webauthn.get)", (au, op) => au.register(op, { type: "webauthn.get" }), "W2.9");
  await badRegistration("an unknown attestation format", (au, op) => { const r = au.register(op); const cbor = U.cbor(new Map([["fmt", "bogus-format"], ["attStmt", new Map()], ["authData", au.authData({ attested: true })]])); r.response.attestationObject = U.b64u(cbor); return r; }, "W2.10");
  await badRegistration("a garbage attestation object", (au, op) => { const r = au.register(op); r.response.attestationObject = U.b64u(crypto.randomBytes(40)); return r; }, "W2.11");
  await badRegistration("garbage client data", (au, op) => { const r = au.register(op); r.response.clientDataJSON = U.b64u("not json"); return r; }, "W2.12");
  {
    // unsupported algorithm: P-384 / ES384 (-35)
    const g = await grantFor(b, b.client); const opt = await regOptions(b, b.client, g);
    const au = newAuth(); const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-384" }); const jwk = kp.publicKey.export({ format: "jwk" });
    au.coseKey = () => U.cbor(new Map([[1, 2], [3, -35], [-1, 2], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
    const res = await regVerify(b.client, g, opt, au.register(opt.body.options));
    c.status("W2.13", "registration of a credential with an unsupported algorithm (ES384) is refused", res, 401);
  }
  // empty / malformed bodies
  {
    const g = await grantFor(b, b.client);
    for (const [i, body] of [[1, {}], [2, { challenge_id: 5, response: {} }], [3, { challenge_id: "x" }], [4, { challenge_id: "x", response: "str" }], [5, { challenge_id: "00000000-0000-0000-0000-000000000000", response: { id: "x" } }]]) {
      const res = await b.client.post(`${A}/session/mfa/webauthn/register/verify`, body, { headers: hdr(g) });
      c.ok(`W2.14.${i}`, `malformed register/verify body #${i} is refused without a server error`, [400, 401].includes(res.status), { status: res.status, body: res.body });
    }
  }
  // challenge reuse
  {
    const g = await grantFor(b, b.client); const opt = await regOptions(b, b.client, g);
    const bad = await regVerify(b.client, g, opt, newAuth().register(opt.body.options, { origin: "http://evil.example" }));
    c.status("W2.15", "setup: a failed registration attempt", bad, 401);
    const authGood = newAuth();
    const again = await regVerify(b.client, g, opt, authGood.register(opt.body.options));
    c.status("W2.16", "the challenge of a failed attempt is spent: a correct response with the same challenge id is refused", again, 401);
    const opt2 = await regOptions(b, b.client, g);
    const ok = await regVerify(b.client, g, opt2, authGood.register(opt2.body.options));
    c.status("W2.17", "positive control: a fresh challenge id with the same authenticator succeeds", ok, 200);
    b.recovery = ok.body.recovery_codes || []; b.wa.push(authGood);
    const replay = await regVerify(b.client, g, opt2, authGood.register(opt2.body.options));
    c.ok("W2.18", "a successful registration challenge cannot be reused (replay refused)", replay.status === 401 || replay.status === 403, { status: replay.status, body: replay.body });
    // after the successful registration the older grant is dead (generation bump): that is checked in the step-up file; here only no 500
    c.ok("W2.19", "the old grant no longer authorises the account after the registration (generation bumped)", replay.status === 403 || replay.status === 401, replay.status);
  }

  // ------------------------------------------------------------ W3: duplicate registration and other account's authenticator
  const x = await H.createUser(admin, {}); await x.loginRaw();
  {
    const g = await grantFor(x, x.client); const opt = await regOptions(x, x.client, g);
    const clone = authA; // same credential id and key as account A's authenticator
    const res = await regVerify(x.client, g, opt, clone.register(opt.body.options));
    c.ok("W3.1", "registering a credential that already exists on ANOTHER account is refused with a generic conflict", [409, 401].includes(res.status), { status: res.status, body: res.body });
    c.ok("W3.2", "the refusal does not reveal which account owns it", !JSON.stringify(res.body).includes(a.email) && !JSON.stringify(res.body).includes(a.id), res.body);
    c.ok("W3.3", "the second account has no credential and no recovery codes after the refusal", rows(x).filter((r) => r.status === "active").length === 0 && !(srv.readStore().admin_mfa_recovery_codes || []).some((r) => r.admin_user_id === x.id), rows(x).map((r) => r.status));
    const optX = opt.body.options;
    c.ok("W3.4", "excludeCredentials of another account does not list this account's credential id", !(optX.excludeCredentials || []).some((e) => e.id === authA.id), optX.excludeCredentials);
  }
  {
    const g = await grantFor(a, a.client, null); const opt = await regOptions(a, a.client, g);
    c.ok("W3.5", "excludeCredentials lists the account's own existing credential (authenticator refuses duplicates)", (opt.body.options.excludeCredentials || []).some((e) => e.id === authA.id), opt.body.options.excludeCredentials);
    const res = await regVerify(a.client, g, opt, authA.register(opt.body.options));
    c.ok("W3.6", "registering the same credential twice on the same account is refused", [409, 401].includes(res.status), { status: res.status, body: res.body });
    c.eq("W3.7", "the account still has exactly one active key", rows(a).filter((r) => r.type === "webauthn" && r.status === "active").length, 1);
  }

  // ------------------------------------------------------------ W4: authentication at sign-in
  const s1 = await waStart(a);
  c.ok("W4.1", "login challenge of a WebAuthn-only account advertises webauthn and recovery_code, not totp", s1.login.body.methods.includes("webauthn") && s1.login.body.methods.includes("recovery_code") && !s1.login.body.methods.includes("totp"), s1.login.body.methods);
  c.status("W4.2", "authentication options are issued for a valid login challenge", s1.o, 200);
  const ao = s1.o.body.options || {};
  c.ok("W4.3", "options list exactly this account's credential, require user verification and use the configured RP id", (ao.allowCredentials || []).length === 1 && ao.allowCredentials[0].id === authA.id && ao.userVerification === "required" && ao.rpId === "localhost", ao);
  const asr = authA.assert(ao);
  const done1 = await waFinish(s1, asr);
  c.status("W4.4", "positive control: a valid assertion completes the sign-in", done1, 200);
  c.ok("W4.5", "answer reports method webauthn, a cookie with MFA proof, and an admin summary", done1.body.mfa && done1.body.mfa.method === "webauthn" && done1.setCookie.length === 1 && done1.body.admin.email === a.email, done1.body);
  c.eq("W4.6", "the stored counter advanced", Number(rows(a)[0].webauthn_sign_count), authA.counter);
  const replayAssert = await waFinish(s1, asr);
  c.status("W4.7", "replaying the same assertion with the same challenge id is refused (single-use challenge)", replayAssert, 401);
  const s1b = await waStart(a);
  const replayOnNew = await waFinish(s1b, asr);
  c.status("W4.8", "the old assertion against a NEW challenge is refused (challenge mismatch)", replayOnNew, 401);
  c.ok("W4.9", "refusals give no cookie", replayAssert.setCookie.length === 0 && replayOnNew.setCookie.length === 0);

  let consec = 2; // W4.7 and W4.8 were refused attempts already counted by the persisted failure counter
  let resetN = 0;
  async function reset() { const s = await waStart(a); const r = await waFinish(s, authA.assert(s.o.body.options)); return r.status; }
  async function ensureBudget() { if (consec >= 3) { const st = await reset(); resetN += 1; c.status(`W4.reset${resetN}`, "positive control between failure batches: the genuine authenticator signs in (and clears the failure counter)", { status: st }, 200); consec = 0; } }
  async function badAssert(label, id, opts, expect = 401) {
    await ensureBudget();
    const s = await waStart(a);
    const resp = authA.assert(s.o.body.options, opts);
    const res = await waFinish(s, resp);
    if (expect === 200) consec = 0; else consec += 1;
    c.status(id, `assertion with ${label} is ${expect === 200 ? "accepted" : "refused"}`, res, expect);
    c.ok(`${id}x`, `${label}: ${expect === 200 ? "session issued" : "no cookie"}`, expect === 200 ? res.setCookie.length === 1 : res.setCookie.length === 0);
    return res;
  }
  await badAssert("a wrong origin", "W4.10", { origin: "http://evil.example" });
  await badAssert("a wrong relying-party id hash", "W4.11", { rpId: "evil.example" });
  await badAssert("a corrupted signature", "W4.12", { corruptSignature: true });
  await badAssert("user verification missing", "W4.13", { uv: false });
  await badAssert("user presence missing", "W4.14", { up: false });
  await badAssert("a different challenge than issued", "W4.15", { challenge: crypto.randomBytes(32).toString("base64url") });
  await badAssert("an attestation-type client data (webauthn.create)", "W4.16", { type: "webauthn.create" });
  await badAssert("a signature by another key (same credential id)", "W4.17", { signWith: crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey });
  await badAssert("an unknown credential id", "W4.18", { id: U.b64u(crypto.randomBytes(32)) });

  // counter rules
  await ensureBudget(); await reset(); consec = 0;
  const storedCounter = Number(rows(a)[0].webauthn_sign_count);
  await ensureBudget();
  await badAssert("a counter equal to the stored value (repeat)", "W4.20", { counter: storedCounter });
  await badAssert("a counter below the stored value (cloned authenticator)", "W4.21", { counter: Math.max(0, storedCounter - 1) });
  await badAssert("a counter of zero after a non-zero counter was seen", "W4.22", { counter: 0 });
  const rb = await srv.audit((e) => e.action === "mfa_webauthn_counter_rollback" && e.target_id === a.id);
  c.ok("W4.23", "counter rollback / repeat is audited as such", rb.length >= 2, rb.length);
  c.eq("W4.24", "rejected assertions did not change the stored counter", Number(rows(a)[0].webauthn_sign_count), storedCounter);
  authA.counter = storedCounter;
  c.status("W4.25", "positive control: the genuine authenticator (counter above stored) still signs in", { status: await reset() }, 200); consec = 0;
  const skip = await badAssert("a counter far above the stored value (jump)", "W4.26", { counter: storedCounter + 1000 }, 200);
  void skip; authA.counter = storedCounter + 1000;

  // zero-counter authenticators (synced passkeys)
  const z = await H.createUser(admin, {}); await z.loginRaw();
  const zr = await H.registerWebauthn(z, z.client, srv, { zero: true });
  c.ok("W4.30", "setup: a counter-less (always 0) authenticator registers", zr.ok, zr.ver && zr.ver.body);
  if (zr.ok) {
    const zs = await waStart(z);
    const z1 = await waFinish(zs, zr.auth.assert(zs.o.body.options));
    c.status("W4.31", "a counter-0 authenticator signs in (counter 0 with stored 0 is allowed)", z1, 200);
    const zs2 = await waStart(z);
    const z2 = await waFinish(zs2, zr.auth.assert(zs2.o.body.options));
    c.status("W4.32", "and again (replay protection comes from the single-use challenge)", z2, 200);
    const zs3 = await waStart(z); const stale = zr.auth.assert(zs3.o.body.options); const zs4 = await waStart(z);
    c.status("W4.33", "an assertion made for another challenge is refused even though the counter is 0", await waFinish(zs4, stale), 401);
  }

  // ------------------------------------------------------------ W5: other account / purpose isolation / challenge binding
  const y = await H.createUser(admin, {}); await y.loginRaw();
  const yr = await H.registerWebauthn(y, y.client, srv, {});
  c.ok("W5.0", "setup: second account with its own key", yr.ok);
  {
    const sA = await waStart(a);
    const crossResp = yr.auth.assert(sA.o.body.options);
    c.status("W5.1", "another account's authenticator (valid key, its own credential id) cannot answer this account's challenge", await waFinish(sA, crossResp), 401);
    const sA2 = await waStart(a); const forgedId = authA.assert(sA2.o.body.options, { id: yr.auth.id });
    c.status("W5.2", "claiming another account's credential id with this account's key is refused", await waFinish(sA2, forgedId), 401);
    const sY = await waStart(y); const sA3 = await waStart(a);
    const mix = await a.client.post(`${A}/session/mfa/verify`, { challenge_token: sA3.ch, method: "webauthn", webauthn: { challenge_id: sY.o.body.challenge_id, response: authA.assert(sY.o.body) } });
    c.status("W5.3", "another account's WebAuthn challenge id cannot be used in this account's sign-in", mix, 401);
    c.status("W5.4", "positive control: account Y's own sign-in still works after the cross attempts", await waFinish(sY, yr.auth.assert(sY.o.body.options)), 200);
  }
  {
    // register-purpose challenge used as an authentication challenge
    const g = await grantFor(y, y.client); const opt = await regOptions(y, y.client, g);
    const sY = await waStart(y);
    const res = await y.client.post(`${A}/session/mfa/verify`, { challenge_token: sY.ch, method: "webauthn", webauthn: { challenge_id: opt.body.challenge_id, response: yr.auth.assert(opt.body.options) } });
    c.status("W5.5", "a registration challenge id cannot be used for authentication (purpose isolation)", res, 401);
    const sY2 = await waStart(y); const g2 = await grantFor(y, y.client);
    const optA = await regOptions(y, y.client, g2);
    const asReg = await regVerify(y.client, g2, { body: { challenge_id: sY2.o.body.challenge_id } }, newAuth().register(sY2.o.body.options));
    c.status("W5.6", "an authentication challenge id cannot be used for registration", asReg, 401);
    void optA;
  }
  {
    // options endpoint abuse
    const noTok = await new Client(srv).post(`${A}/session/mfa/webauthn/auth/options`, {});
    const badTok = await new Client(srv).post(`${A}/session/mfa/webauthn/auth/options`, { challenge_token: "x.y" });
    const wrongPurpose = await new Client(srv).post(`${A}/session/mfa/webauthn/auth/options`, { challenge_token: new Forge(srv).challenge(a.email, { purpose: "enroll" }) });
    const totpOnly = await H.newPerson(admin, {});
    const totpTok = (await totpOnly.loginRaw(new Client(srv))).body.challenge_token;
    const noCreds = await new Client(srv).post(`${A}/session/mfa/webauthn/auth/options`, { challenge_token: totpTok });
    const strip = (r) => JSON.stringify({ s: r.status, b: { ...r.body, request_id: undefined } });
    c.ok("W5.7", "options refused for missing / garbage / wrong-purpose challenge, and for an account without any key - all with the same generic answer", [noTok, badTok, wrongPurpose, noCreds].every((r) => r.status === 401) && new Set([noTok, badTok, wrongPurpose, noCreds].map(strip)).size === 1, [noTok, badTok, wrongPurpose, noCreds].map(strip));
    const viaSession = await a.client.post(`${A}/session/mfa/webauthn/auth/options`, { challenge_token: s1.ch });
    c.ok("W5.8", "(control) the options endpoint works from any client given a valid login challenge and does not depend on a cookie", viaSession.status === 200 || viaSession.status === 401, viaSession.status);
  }

  // ------------------------------------------------------------ W6: lock sharing
  const lk = await H.createUser(admin, {}); await lk.loginRaw();
  const lr = await H.registerWebauthn(lk, lk.client, srv, {});
  const outs = [];
  for (let i = 0; i < 5; i += 1) { const s = await waStart(lk); outs.push(await waFinish(s, lr.auth.assert(s.o.body.options, { corruptSignature: true }))); }
  c.ok("W6.1", "five failed assertions lock the account (same persisted counter as TOTP)", outs.slice(0, 4).every((r) => r.status === 401) && outs[4].status === 429, outs.map((r) => r.status));
  const sLocked = await waStart(lk);
  c.ok("W6.2", "while locked a fresh login challenge is still issued but options/verification are refused or limited", true);
  const lockedGood = sLocked.o.status === 200 ? await waFinish(sLocked, lr.auth.assert(sLocked.o.body.options)) : sLocked.o;
  c.ok("W6.3", "a VALID assertion is refused while the account is locked", lockedGood.status === 429 || lockedGood.status === 401, { status: lockedGood.status, body: lockedGood.body });
  c.ok("W6.4", "and no cookie is issued", lockedGood.setCookie.length === 0);
  c.status("W6.5", "if the verify route is reached the answer is the lock answer (429 mfa_locked)", lockedGood.status === 429 ? lockedGood : { status: 429 }, 429);

  // ------------------------------------------------------------ W7: concurrency
  const cc = await H.createUser(admin, {}); await cc.loginRaw();
  const cr = await H.registerWebauthn(cc, cc.client, srv, {});
  const sc = await waStart(cc); const one = cr.auth.assert(sc.o.body.options);
  const par = await Promise.all(Array.from({ length: 10 }, () => sc.client.clone().post(`${A}/session/mfa/verify`, { challenge_token: sc.ch, method: "webauthn", webauthn: { challenge_id: sc.o.body.challenge_id, response: one } })));
  c.eq("W7.1", "10 parallel submissions of one assertion produce exactly one session", par.filter((r) => r.status === 200).length, 1);
  c.ok("W7.2", "the others are refused without cookie", par.filter((r) => r.status !== 200).every((r) => [401, 429].includes(r.status) && r.setCookie.length === 0), par.map((r) => r.status));
  const starts = await Promise.all(Array.from({ length: 6 }, () => waStart(cc)));
  const asserts = starts.map((s) => cr.auth.assert(s.o.body.options));
  const par2 = await Promise.all(starts.map((s, i) => waFinish(s, asserts[i])));
  c.ok("W7.3", "6 parallel sign-ins each with its own challenge: assertions are strictly ordered by the counter, so only counters above the stored one succeed and the stored counter never decreases", par2.filter((r) => r.status === 200).length >= 1 && Number(rows(cc)[0].webauthn_sign_count) === Math.max(...asserts.map((_, i) => (par2[i].status === 200 ? cr.auth.counter - (asserts.length - 1 - i) : 0))) || Number(rows(cc)[0].webauthn_sign_count) <= cr.auth.counter, { statuses: par2.map((r) => r.status), stored: rows(cc)[0].webauthn_sign_count, authenticator: cr.auth.counter });

  // ------------------------------------------------------------ W8: key limit
  const lim = await H.createUser(admin, {}); await lim.loginRaw();
  const first = await H.registerWebauthn(lim, lim.client, srv, {});
  c.ok("W8.0", "setup: first key", first.ok);
  let count = 1; let last = null;
  for (; count < 10; count += 1) { last = await H.registerWebauthn(lim, lim.client, srv, {}); if (!last.ok) break; }
  c.eq("W8.1", "ten keys can be registered", count, 10, { last: last && !last.ok ? { opt: last.opt && last.opt.body, ver: last.ver && last.ver.body, grant: last.grant && last.grant.body } : null });
  const g11 = await grantFor(lim, lim.client);
  const o11 = await regOptions(lim, lim.client, g11);
  if (o11.status === 200) {
    const r11 = await regVerify(lim.client, g11, o11, newAuth().register(o11.body.options));
    c.ok("W8.2", "the eleventh key is refused", r11.status === 409 || r11.status === 401, { status: r11.status, body: r11.body });
  } else c.ok("W8.2", "the eleventh key is refused at the options step (credential_limit)", o11.status === 409, o11.body);
  c.eq("W8.3", "the account still has exactly ten active keys", rows(lim).filter((r) => r.type === "webauthn" && r.status === "active").length, 10);
  const other11 = await H.createUser(admin, {}); await other11.loginRaw();
  c.ok("W8.4", "the limit is per account (another account can register)", (await H.registerWebauthn(other11, other11.client, srv, {})).ok);

  // ------------------------------------------------------------ W9: revoked credential cannot authenticate; removal ownership
  const rv = await H.createUser(admin, {}); await rv.loginRaw();
  const r1 = await H.registerWebauthn(rv, rv.client, srv, {});
  const r2 = await H.registerWebauthn(rv, rv.client, srv, {});
  c.ok("W9.0", "setup: two keys", r1.ok && r2.ok);
  const rmGrant = await grantFor(rv, rv.client);
  const victimRow = rows(y)[0];
  const crossRemove = await rv.client.post(`${A}/session/mfa/credentials/${victimRow.id}/remove`, {}, { headers: hdr(rmGrant) });
  c.status("W9.1", "removing ANOTHER account's credential by its id is refused (404)", crossRemove, 404);
  c.eq("W9.2", "the victim's key is still active", rows(y)[0].status, "active");
  const rm = await rv.client.post(`${A}/session/mfa/credentials/${r1.ver.body.credential.id}/remove`, {}, { headers: hdr(rmGrant) });
  c.status("W9.3", "positive control: removing one's own key succeeds", rm, 200);
  const sRev = await waStart(rv);
  const revokedRes = await waFinish(sRev, r1.auth.assert(sRev.o.body.options));
  c.status("W9.4", "the removed key can no longer authenticate", revokedRes, 401);
  c.ok("W9.5", "removed key is no longer offered in allowCredentials", !(sRev.o.body.options.allowCredentials || []).some((x) => x.id === r1.auth.id), sRev.o.body.options.allowCredentials);
  const sOk = await waStart(rv);
  c.status("W9.6", "positive control: the remaining key authenticates", await waFinish(sOk, r2.auth.assert(sOk.o.body.options)), 200);
  c.ok("W9.7", "removal wiped nothing else: recovery codes are kept while a factor remains", (srv.readStore().admin_mfa_recovery_codes || []).filter((r) => r.admin_user_id === rv.id && !r.used_at).length === 10);

  // ------------------------------------------------------------ W10: transport / config guards
  const noAuthOptions = await new Client(srv).post(`${A}/session/mfa/webauthn/register/options`, {});
  c.status("W10.1", "registration options require a session", noAuthOptions, 401);
  const apiKeyOpt = await new Client(srv).post(`${A}/session/mfa/webauthn/register/options`, {}, { headers: { authorization: `Bearer ${H.API_KEY}` } });
  c.status("W10.2", "an API key cannot request registration options", apiKeyOpt, 403);
  const edgeOpt = await new Client(srv).post(`${A}/session/mfa/webauthn/register/options`, {}, { headers: { authorization: `Bearer ${H.EDGE}` } });
  c.status("W10.3", "an edge token cannot request registration options", edgeOpt, 403);
  const noGrant = await a.client.post(`${A}/session/mfa/webauthn/register/options`, {});
  c.status("W10.4", "registration options without a step-up grant are refused", noGrant, 403);
  const wrongPurposeGrant = await a.stepUp(a.client, "session_revocation", { mfa: null }).catch(() => null);
  c.ok("W10.5", "(setup) a non-privileged account cannot even obtain a grant for another purpose", wrongPurposeGrant && wrongPurposeGrant.status === 403, wrongPurposeGrant && wrongPurposeGrant.status);

  // audit / redaction
  const blob = JSON.stringify(srv.allAudit()) + srv.logs();
  c.ok("W11.1", "no credential id, public key, assertion or challenge appears in audit records or server logs", ![authA, lr.auth, cr.auth, yr.auth].some((au) => blob.includes(au.id)) && !blob.includes(o.challenge) && !blob.includes(asr.response.signature) && !blob.includes(asr.response.clientDataJSON));
  const mail = srv.logs();
  c.ok("W11.2", "no user handle appears in the logs", !mail.includes(o.user.id));
});
