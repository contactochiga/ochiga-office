"use strict";
// A06 - session token verification: forged / edited / truncated / extra-segment tokens, wrong signing keys, claim handling, legacy forms, expiry, cookie parsing.
// The harness knows the session secret it configured, so it can mint correctly signed tokens to test how the server treats their CLAIMS.
const L = require("./a-lib");
const { P } = L;
const suite = L.createSuite("a06-session-tokens");
const LEAK_RE = /(TypeError|ReferenceError|URIError|SyntaxError|Cannot read propert|\bat [\w.<>$ ]+ \(|node_modules|\/Users\/|URI malformed)/;

suite.run(async (s) => {
  const srv = await L.startServer(s);
  const c = new L.Client(srv);
  const SECRET = srv.secrets.sessionSecret;
  const admin = await L.adminSession(c, srv);
  const staff = await L.makeUser(c, admin, { role: "ochiga_staff" });
  const staff2 = await L.makeUser(c, admin, { role: "ochiga_staff" });
  const real = L.decodeToken(staff.cookie).claims;
  const adminClaims = L.decodeToken(admin.cookie).claims;
  const probe = async (token) => ({ me: (await c.get(P.me, { cookie: token })).status, users: (await c.get(P.users, { cookie: token })).status });
  const meOnly = async (token, o = {}) => c.get(P.me, { cookie: token, ...o });

  await s.section("positive controls for the minting harness", async () => {
    const same = L.mintToken(SECRET, real);
    s.check("A06-001", "re-signing the genuine claims with the configured secret yields an accepted token (harness control)", (await meOnly(same)).status === 200);
    s.check("A06-002", "the genuine staff cookie is accepted", (await meOnly(staff.cookie)).status === 200);
    const fresh = L.mintToken(SECRET, { ...real, exp: Date.now() + 3600_000 });
    s.check("A06-003", "a re-signed token with a different (valid) expiry is accepted", (await meOnly(fresh)).status === 200);
  });

  await s.section("signature forgery", async () => {
    const [payload, sig] = staff.cookie.split(".");
    const flip = (str, i) => str.slice(0, i) + (str[i] === "a" ? "b" : "a") + str.slice(i + 1);
    let n = 0;
    const bad = {
      "first signature char changed": `${payload}.${flip(sig, 0)}`,
      "middle signature char changed": `${payload}.${flip(sig, 31)}`,
      "last signature char changed": `${payload}.${flip(sig, sig.length - 1)}`,
      "signature truncated by one": `${payload}.${sig.slice(0, -1)}`,
      "signature truncated to 8": `${payload}.${sig.slice(0, 8)}`,
      "signature extended": `${payload}.${sig}00`,
      "signature upper-cased": `${payload}.${sig.toUpperCase()}`,
      "signature empty": `${payload}.`,
      "payload only": payload,
      "signature only": `.${sig}`,
      "swapped segments": `${sig}.${payload}`,
      "extra third segment": `${payload}.${sig}.extra`,
      "extra empty third segment": `${payload}.${sig}.`,
      "extra leading segment": `x.${payload}.${sig}`,
      "jwt style alg none": `${L.b64u(JSON.stringify({ alg: "none", typ: "JWT" }))}.${payload}.`,
      "doubled token": `${payload}.${sig}.${payload}.${sig}`,
      "payload with padding": `${payload}=.${sig}`,
      "payload re-encoded standard base64": `${Buffer.from(payload, "base64url").toString("base64")}.${sig}`,
      "whitespace around": ` ${payload}.${sig} `,
      "newline appended": `${payload}.${sig}\n`,
      "null byte appended": `${payload}.${sig}\u0000`,
      "empty string": "",
      "single dot": ".",
      "only garbage": "garbage",
      "signature of another payload": `${payload}.${L.hmacHex(SECRET, "something else")}`,
    };
    for (const [name, tok] of Object.entries(bad)) {
      const r = await probe(tok);
      s.check(`A06-01${String(n++).padStart(2, "0")}`, `token "${name}" is refused on /session/me and on a protected route (401)`, r.me === 401 && r.users === 401, r);
    }
    // every prefix and every single-character edit at a spread of positions
    let prefixOk = true, editOk = true; const failures = [];
    for (let len = 1; len < staff.cookie.length; len += 7) { const r = await meOnly(staff.cookie.slice(0, len)); if (r.status !== 401) { prefixOk = false; failures.push(["prefix", len, r.status]); } }
    s.check("A06-040", "every 7th truncation of a genuine token is refused with 401 (no 500)", prefixOk, failures.slice(0, 3));
    for (let i = 0; i < sig.length; i += 5) { const r = await meOnly(`${payload}.${flip(sig, i)}`); if (r.status !== 401) { editOk = false; failures.push(["sigedit", i, r.status]); } }
    for (let i = 0; i < payload.length; i += 9) { const r = await meOnly(`${flip(payload, i)}.${sig}`); if (r.status !== 401) { editOk = false; failures.push(["payloadedit", i, r.status]); } }
    s.check("A06-041", "single-character edits across the signature and payload are all refused", editOk, failures.slice(0, 3));
  });

  await s.section("claims edited without re-signing (tamper)", async () => {
    const [, sig] = staff.cookie.split(".");
    const edits = {
      "role to super_admin": (c0) => ({ ...c0, role: "super_admin" }),
      "e-mail to the administrator": (c0) => ({ ...c0, email: admin.email }),
      "user id to the administrator": (c0) => ({ ...c0, user_id: adminClaims.user_id }),
      "expiry extended": (c0) => ({ ...c0, exp: c0.exp + 10 * 365 * 24 * 3600 * 1000 }),
      "scopes escalated": (c0) => ({ ...c0, permission_scopes: ["team.manage", "settings.manage"] }),
      "generation changed": (c0) => ({ ...c0, sg: (c0.sg || 0) + 1 }),
      "session id removed (strip individual revocation)": (c0) => { const { sid, ...rest } = c0; return rest; },
      "password fingerprint removed": (c0) => { const { pf, ...rest } = c0; return rest; },
      "mfa claim added": (c0) => ({ ...c0, mf: 1, mft: Date.now() }),
      "generation removed (legacy form)": (c0) => { const { sg, ...rest } = c0; return rest; },
    };
    let n = 0;
    for (const [name, mut] of Object.entries(edits)) {
      const tok = L.tamperPayload(staff.cookie, mut);
      const r = await probe(tok);
      s.check(`A06-05${n++}`, `edited claim "${name}" with the old signature is refused`, r.me === 401 && r.users === 401, r);
    }
    void sig;
  });

  await s.section("signed with the wrong key", async () => {
    const keys = {
      "an API key": srv.secrets.apiKey,
      "both API keys joined": `${srv.secrets.apiKey},${srv.secrets.apiKey2}`,
      "the historical public default": "lead-agents-dev-session-secret",
      "the empty string": "",
      "the edge token": srv.secrets.edgeToken,
      "the administrator password": srv.secrets.adminPassword,
      "a random key": L.rand(24),
      "the secret with a trailing space": SECRET + " ",
      "the secret upper-cased": SECRET.toUpperCase(),
      "the step-up derived key purpose string": "ochiga-office/step-up/v1",
    };
    let n = 0;
    for (const [name, key] of Object.entries(keys)) {
      const tok = L.mintToken(key, { ...adminClaims, exp: Date.now() + 3600_000 });
      const r = await probe(tok);
      s.check(`A06-06${n++}`, `a super-administrator token signed with ${name} is refused`, r.me === 401 && r.users === 401, r);
    }
    const hmacSha1 = (() => { const crypto = require("crypto"); const p = L.b64u(JSON.stringify({ ...adminClaims, exp: Date.now() + 3600_000 })); return `${p}.${crypto.createHmac("sha1", SECRET).update(p).digest("hex")}`; })();
    s.check("A06-070", "a token with an HMAC-SHA1 signature under the right key is refused", (await meOnly(hmacSha1)).status === 401);
    const b64sig = (() => { const crypto = require("crypto"); const p = L.b64u(JSON.stringify({ ...adminClaims, exp: Date.now() + 3600_000 })); return `${p}.${crypto.createHmac("sha256", SECRET).update(p).digest("base64url")}`; })();
    s.check("A06-071", "a token with the right HMAC encoded as base64url instead of hex is refused", (await meOnly(b64sig)).status === 401);
    const step = require("crypto").createHmac("sha256", SECRET).update("ochiga-office/step-up/v1").digest();
    const p = L.b64u(JSON.stringify({ ...adminClaims, exp: Date.now() + 3600_000 }));
    const viaStepUpKey = `${p}.${require("crypto").createHmac("sha256", step).update(p).digest("hex")}`;
    s.check("A06-072", "a token signed with the step-up derived key is not a session (key separation)", (await meOnly(viaStepUpKey)).status === 401);
    const su = await L.stepUp(c, admin, "security_policy_write");
    s.check("A06-073", "a genuine step-up grant is not accepted as a session cookie", su.token && (await meOnly(su.token)).status === 401);
    s.check("A06-074", "a session cookie is not accepted as a step-up grant", (await c.post(P.stepUpCheck, { cookie: admin.cookie, stepUp: admin.cookie, json: { purpose: "security_policy_write" } })).status === 403);
  });

  await s.section("correctly signed tokens: claim handling", async () => {
    const base = { ...real, exp: Date.now() + 3600_000 };
    const mint = (over, drop = []) => { const o = { ...base, ...over }; for (const d of drop) delete o[d]; return L.mintToken(SECRET, o); };
    s.check("A06-080", "expired token (exp in the past) is refused", (await meOnly(mint({ exp: Date.now() - 1000 }))).status === 401);
    s.check("A06-081", "expiry as a string is refused", (await meOnly(mint({ exp: String(Date.now() + 3600_000) }))).status === 401);
    for (const [name, exp] of [["null", null], ["zero", 0], ["negative", -1], ["NaN-like string", "NaN"], ["object", {}], ["array", []], ["boolean true", true]]) {
      s.check(`A06-082-${name}`, `exp = ${name} is refused`, (await meOnly(mint({ exp }))).status === 401);
    }
    s.check("A06-083", "missing exp is refused", (await meOnly(mint({}, ["exp"]))).status === 401);
    s.check("A06-084", "missing e-mail is refused", (await meOnly(mint({}, ["email"]))).status === 401);
    s.check("A06-085", "an unknown e-mail (no such account) is refused", (await meOnly(mint({ email: `nobody-${L.rand(3)}@example.test` }))).status === 401);
    s.check("A06-086", "e-mail of account A with user id of account B is refused (identity mismatch)", (await meOnly(mint({ email: staff2.email, user_id: staff.id }))).status === 401);
    s.check("A06-087", "a random user id for the right e-mail is refused", (await meOnly(mint({ user_id: "00000000-0000-4000-8000-0000000000aa" }))).status === 401);
    const noUserId = await meOnly(mint({}, ["user_id"]));
    s.check("A06-088", "a token with the right e-mail but WITHOUT a user id claim is refused (identity must be bound to the account id)", noUserId.status === 401, noUserId.status);
    const roleClaim = await probe(mint({ role: "super_admin" }));
    s.check("A06-089", "a signed role claim above the live role does not elevate (live role wins): /admin/users stays forbidden for staff", roleClaim.me === 200 && roleClaim.users === 403, roleClaim);
    const me = await meOnly(mint({ role: "super_admin", permission_scopes: ["team.manage"] }));
    s.check("A06-090", "/session/me reports the LIVE role, not the claimed one", me.body && me.body.admin && me.body.admin.role === "ochiga_staff", me.body && me.body.admin);
    const scoped = await probe(mint({ permission_scopes: ["team.manage", "staff.manage", "audit.read"] }));
    s.check("A06-091", "signed scope claims do not grant permissions (scopes are read live)", scoped.users === 403, scoped);
    s.check("A06-092", "e-mail claim in upper case maps to the same account (normalised) or is refused, never another account", await (async () => { const r = await meOnly(mint({ email: staff.email.toUpperCase() })); return r.status === 401 || (r.status === 200 && r.body.admin.id === staff.id); })());
    s.check("A06-093", "a wrong generation (sg too high) is refused", (await meOnly(mint({ sg: (real.sg || 0) + 5 }))).status === 401);
    s.check("A06-094", "a negative generation is refused", (await meOnly(mint({ sg: -1 }))).status === 401);
    s.check("A06-095", "a non-integer generation (string) is refused", (await meOnly(mint({ sg: "0" }))).status === 401);
    s.check("A06-096", "a wrong password fingerprint (pf) is refused", (await meOnly(mint({ pf: "0".repeat(32) }))).status === 401);
    s.check("A06-097", "an MFA claim on an account without a factor and with MFA off grants nothing extra (still just the live role)", await (async () => { const r = await probe(mint({ mf: 1, mft: Date.now() })); return r.me === 200 && r.users === 403; })());
    s.check("A06-098", "an oversized session id claim (not matching the allowed pattern) does not crash the server", (await meOnly(mint({ sid: "x".repeat(5000) }))).status < 500);
    for (const [name, payloadText] of [["a JSON array", "[]"], ["JSON null", "null"], ["a JSON string", '"abc"'], ["a number", "42"], ["not JSON", "{{{"], ["empty", ""], ["a huge object", JSON.stringify({ a: "x".repeat(8000) })]]) {
      const p = L.b64u(payloadText); const tok = `${p}.${L.hmacHex(SECRET, p)}`;
      const r = await meOnly(tok);
      s.check(`A06-099-${name}`, `a correctly signed payload that is ${name} is refused cleanly (401, no 5xx)`, r.status === 401 || r.status === 431, r.status);
    }
  });

  await s.section("legacy-style tokens (documented transitional behaviour) and downgrade directions", async () => {
    const base = { email: real.email, role: real.role, user_id: real.user_id, permission_scopes: [], exp: Date.now() + 3600_000 };
    const legacy = L.mintToken(SECRET, base);
    const legacyStatus = (await meOnly(legacy)).status;
    console.log(`INFO A06 legacy token without sg/pf/sid accepted while the account is at generation 0: ${legacyStatus === 200} (documented transitional behaviour)`);
    s.check("A06-100", "a legacy token (no sg, no pf, no sid) is either accepted as generation 0 or refused cleanly; never a 5xx", legacyStatus === 200 || legacyStatus === 401, legacyStatus);
    // after a revocation the legacy form must die
    const victim = await L.makeUser(c, admin, { role: "ochiga_staff" });
    const vClaims = L.decodeToken(victim.cookie).claims;
    const vLegacy = L.mintToken(SECRET, { email: vClaims.email, role: vClaims.role, user_id: vClaims.user_id, permission_scopes: [], exp: Date.now() + 3600_000 });
    const before = (await meOnly(vLegacy)).status;
    const rev = await c.post("/api/lead-agents/admin/session/revoke-all", { cookie: victim.cookie, json: {} });
    s.check("A06-101", "positive control: the owner can sign out everywhere", rev.status === 200, rev.status);
    s.check("A06-102", "after a revocation, a legacy-form token for that account is refused (a revoked account cannot be re-entered with an older token form)", (await meOnly(vLegacy)).status === 401, { before });
    const vFresh = await L.login(c, victim.email, victim.password);
    const fc = L.decodeToken(vFresh.cookie).claims;
    s.check("A06-103", "after a revocation the new sign-in carries a higher generation", fc.sg > vClaims.sg, { old: vClaims.sg, new: fc.sg });
    const stripped = L.mintToken(SECRET, (({ sg, ...rest }) => rest)(fc));
    s.check("A06-104", "removing the generation claim from a post-revocation token (re-signed) does not revive older-generation validity", (await meOnly(stripped)).status === 401);
    const oldGen = L.mintToken(SECRET, { ...fc, sg: vClaims.sg, pf: vClaims.pf });
    s.check("A06-105", "a token claiming the pre-revocation generation is refused", (await meOnly(oldGen)).status === 401);
    const noSid = L.mintToken(SECRET, (({ sid, ...rest }) => rest)(fc));
    console.log(`INFO A06 token without sid (cannot be individually revoked) accepted: ${(await meOnly(noSid)).status === 200}`);
  });

  await s.section("short-lived token boundary (explicit wait on the condition)", async () => {
    const tok = L.mintToken(SECRET, { ...real, exp: Date.now() + 2500 });
    s.check("A06-110", "a token expiring in 2.5 s is accepted now", (await meOnly(tok)).status === 200);
    let expired = false; const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if ((await meOnly(tok)).status === 401) { expired = true; break; } await L.sleep(250); }
    s.check("A06-111", "the same token is refused once its expiry passes", expired);
  });

  await s.section("cookie header parsing", async () => {
    const NAME = L.COOKIE_NAME;
    const raw = async (cookieHeader) => c.get(P.me, { rawCookie: cookieHeader });
    const cases = {
      "malformed percent escape": `${NAME}=%E0%A4%A`,
      "lone percent": `${NAME}=%`,
      "percent then non-hex": `${NAME}=%zz`,
      "valid percent-encoded token": `${NAME}=${encodeURIComponent(staff.cookie)}`,
      "empty value": `${NAME}=`,
      "no equals sign": `${NAME}`,
      "quoted value": `${NAME}="${staff.cookie}"`,
      "many cookies": Array.from({ length: 150 }, (_, i) => `c${i}=v${i}`).join("; ") + `; ${NAME}=garbage`,
      "semicolon only": ";;;",
      "key with spaces": `${NAME} =${staff.cookie}`,
      "unicode value": `${NAME}=%F0%9F%98%80`,
      "very long value": `${NAME}=${"a".repeat(7000)}`,
      "duplicate name garbage first": `${NAME}=garbage; ${NAME}=${encodeURIComponent(staff.cookie)}`,
      "duplicate name valid first": `${NAME}=${encodeURIComponent(staff.cookie)}; ${NAME}=garbage`,
    };
    let n = 0;
    for (const [name, h] of Object.entries(cases)) {
      const r = await raw(h);
      const isValid = name === "valid percent-encoded token";
      s.check(`A06-12${n}a`, `cookie header "${name}": no 5xx and no internal detail`, r.status > 0 && r.status < 500 && !LEAK_RE.test(r.text), { status: r.status, text: r.text.slice(0, 160) });
      if (isValid) s.check(`A06-12${n}b`, "positive control: a percent-encoded genuine cookie authenticates", r.status === 200, r.status);
      else if (!/duplicate/.test(name)) s.check(`A06-12${n}b`, `cookie header "${name}" does not authenticate`, r.status === 401, r.status);
      n++;
    }
    const dupGood = await raw(`${NAME}=garbage; ${NAME}=${encodeURIComponent(staff.cookie)}`);
    const dupBad = await raw(`${NAME}=${encodeURIComponent(staff.cookie)}; ${NAME}=garbage`);
    s.check("A06-140", "with duplicate cookie names the outcome is the same whichever order they arrive (no order-dependent authentication)", dupGood.status === dupBad.status, { garbageFirst: dupGood.status, validFirst: dupBad.status });
    const q = await c.get(`${P.me}?${NAME}=${encodeURIComponent(staff.cookie)}`);
    s.check("A06-141", "a session token in the query string is not accepted", q.status === 401);
    const qb = await c.post(P.logout, { json: { [NAME]: staff.cookie } });
    s.check("A06-142", "a session token in a request body is not accepted as the session", (await meOnly(staff.cookie)).status === 200);
    void qb;
    const rawReq = await L.rawHttp(srv.port, `GET ${P.me} HTTP/1.1\r\nHost: x\r\nCookie: ${NAME}=${staff.cookie}\r\nCookie: ${NAME}=garbage\r\nConnection: close\r\n\r\n`);
    s.check("A06-143", "two Cookie headers in one request are handled without a 5xx", rawReq.status > 0 && rawReq.status < 500, rawReq.status);
    const bigHeader = await L.rawHttp(srv.port, `GET ${P.me} HTTP/1.1\r\nHost: x\r\nCookie: ${NAME}=${"a".repeat(70000)}\r\nConnection: close\r\n\r\n`);
    s.check("A06-144", "a 70 KB cookie header is refused (431) or ignored, never a 5xx other than 431", bigHeader.status === 431 || bigHeader.status === 401 || bigHeader.status === 0, bigHeader.status);
    s.check("A06-145", "the server survived the malformed cookie traffic", srv.alive());
  });

  await s.section("logs", async () => {
    const logs = srv.logs();
    s.check("A06-150", "no token, signature, secret or password appears in the server log", !logs.includes(staff.cookie.split(".")[1]) && L.findLeaks(logs, { sessionSecret: SECRET, apiKey: srv.secrets.apiKey, adminPassword: srv.secrets.adminPassword, staffPw: staff.password }).length === 0);
  });

  s.check("A06-999", "server alive at the end of the suite", srv.alive());
});
