"use strict";
// Shared harness for AREA B: check registry + report line, server process management (private symlink copy of the SUT, private data dir), HTTP client with cookie jar,
// e-mail capture endpoint, account/MFA helpers. Talks to the system under test only over HTTP.
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const U = require("./util");

const SUT = process.env.SUT_DIR || path.resolve(__dirname, "../../../..");
const SUT_OLD = process.env.SUT_OLD_DIR || "";

// ---------------------------------------------------------------- checks
class Checks {
  constructor(suite, area = "B") { this.suite = suite; this.area = area; this.total = 0; this.failures = []; this.infos = []; this.blocked = null; }
  _rec(name, ok, evidence) {
    this.total += 1;
    if (!ok) {
      this.failures.push(name);
      let ev = ""; try { ev = evidence === undefined ? "" : (typeof evidence === "string" ? evidence : JSON.stringify(evidence)); } catch { ev = String(evidence); }
      if (ev.length > 700) ev = ev.slice(0, 700) + "...";
      console.log(`FAIL ${name}${ev ? `\n     evidence: ${ev}` : ""}`);
    }
    return ok;
  }
  ok(id, text, cond, evidence) { return this._rec(`${id} ${text}`, Boolean(cond), evidence); }
  eq(id, text, actual, expected, evidence) { return this._rec(`${id} ${text}`, JSON.stringify(actual) === JSON.stringify(expected), evidence === undefined ? { actual, expected } : { actual, expected, ...evidence }); }
  status(id, text, res, expected, evidence) {
    const list = Array.isArray(expected) ? expected : [expected];
    return this._rec(`${id} ${text}`, list.includes(res && res.status), { status: res && res.status, expected: list, body: res && res.body, ...(evidence || {}) });
  }
  info(text) { this.infos.push(text); console.log(`INFO ${text}`); }
  block(reason) { this.blocked = reason; }
  finish() {
    console.log(JSON.stringify({ suite: this.suite, area: this.area, checks: this.total, failed: this.failures.length, failures: this.failures }));
    process.exitCode = this.failures.length === 0 ? 0 : 1;
  }
}

async function runSuite(name, fn) {
  const c = new Checks(name);
  const cleanups = [];
  c.defer = (f) => cleanups.push(f);
  let timer = setTimeout(() => { console.log(`BLOCKED: suite ${name} exceeded 9 minutes`); finalize(2); }, 9 * 60 * 1000);
  let done = false;
  async function cleanup() { for (const f of cleanups.reverse()) { try { await f(); } catch {} } }
  async function finalize(code) { if (done) return; done = true; clearTimeout(timer); await cleanup(); if (code === 2) { console.log(JSON.stringify({ suite: name, area: "B", checks: c.total, failed: c.failures.length, failures: c.failures, blocked: true })); process.exit(2); } }
  try {
    await fn(c);
  } catch (e) {
    await cleanup(); done = true; clearTimeout(timer);
    console.log(`BLOCKED: ${e && e.stack || e}`);
    console.log(JSON.stringify({ suite: name, area: "B", checks: c.total, failed: c.failures.length, failures: c.failures, blocked: true }));
    process.exit(2);
  }
  await cleanup(); done = true; clearTimeout(timer);
  c.finish();
  process.exit(process.exitCode || 0);
}

// ---------------------------------------------------------------- ports / dirs
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

/** Private symlink copy of a SUT tree so the SUT is never written (the server writes ./data under its cwd). */
function symlinkCopy(root, sutDir) {
  fs.mkdirSync(root, { recursive: true });
  for (const entry of fs.readdirSync(sutDir)) {
    if (entry === "data") continue;
    fs.symlinkSync(path.join(sutDir, entry), path.join(root, entry));
  }
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
}

// ---------------------------------------------------------------- mail capture
function startMailCapture() {
  const messages = []; let mode = "ok";
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => { body += d; });
    req.on("end", () => {
      let parsed = null; try { parsed = JSON.parse(body); } catch {}
      if (mode === "fail") { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "provider down" })); return; }
      messages.push({ at: Date.now(), headers: req.headers, raw: body, ...(parsed || {}) });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "fixture-" + messages.length }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    resolve({ url: `http://127.0.0.1:${port}/emails`, messages, setMode: (m) => { mode = m; }, close: () => new Promise((r) => server.close(() => r())), to: (addr) => messages.filter((m) => String(m.to).toLowerCase() === String(addr).toLowerCase()) });
  }));
}

// ---------------------------------------------------------------- server process
const WA_ORIGIN_PORT_PLACEHOLDER = "{PORT}";
function baseEnv({ port, dir, mailUrl, extra = {} }) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    OPENAI_API_KEY: "sk-fixture-not-real-0000", LEAD_AGENTS_HOST: "127.0.0.1", LEAD_AGENTS_PORT: String(port),
    LEAD_AGENTS_STORE_DRIVER: "file", LEAD_AGENTS_STORE_PATH: path.join(dir, "store.json"), OFFICE_STORAGE_DIR: path.join(dir, "office-storage"),
    LEAD_AGENTS_AUTH_MODE: "required_api_key", LEAD_AGENTS_API_KEYS: "apikey-fixture-0123456789abcdef", OYI_EDGE_AGENT_TOKENS: "edge-fixture-0123456789abcdef",
    LEAD_AGENTS_SESSION_SECRET: "sess-" + crypto.randomBytes(24).toString("hex"),
    LEAD_AGENTS_ADMIN_EMAIL: "root@fixture.test", LEAD_AGENTS_ADMIN_PASSWORD: "Rt-" + crypto.randomBytes(9).toString("hex") + "!Z", LEAD_AGENTS_ADMIN_ROLE: "super_admin",
    LEAD_AGENTS_MFA: "on", LEAD_AGENTS_MFA_KEY: U.randomKeyB64(), LEAD_AGENTS_MFA_KEY_ID: "k1",
    LEAD_AGENTS_WEBAUTHN_RP_ID: "localhost", LEAD_AGENTS_WEBAUTHN_ORIGINS: `http://localhost:${port}`, LEAD_AGENTS_WEBAUTHN_RP_NAME: "Fixture Office",
    LEAD_AGENTS_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "100000", LEAD_AGENTS_OFFICE_RATE_LIMIT_MAX_REQUESTS: "1000000", LEAD_AGENTS_RATE_LIMIT_MAX_REQUESTS: "1000000",
    LEAD_AGENTS_STEP_UP_TTL_MS: "300000", OFFICE_APP_URL: `http://127.0.0.1:${port}`,
    ...(mailUrl ? { OFFICE_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_fixture_" + crypto.randomBytes(8).toString("hex"), OFFICE_EMAIL_FROM: "Fixture <office@fixture.test>", MAIL_CAPTURE_URL: mailUrl, NODE_OPTIONS: `--require ${path.join(__dirname, "mail-preload.js")}` } : {}),
    ...extra,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined || env[k] === null) delete env[k];
  return env;
}

class Server {
  constructor({ sutDir, dir, env, port }) { this.sutDir = sutDir; this.dir = dir; this.env = env; this.port = port; this.base = `http://127.0.0.1:${port}`; this.proc = null; this.out = []; this.exited = null; }
  async start() {
    this.runRoot = path.join(this.dir, "root");
    if (!fs.existsSync(this.runRoot)) symlinkCopy(this.runRoot, this.sutDir);
    this.exited = null;
    this.proc = spawn(process.execPath, ["lead-agents-server.js"], { cwd: this.runRoot, env: this.env, stdio: ["ignore", "pipe", "pipe"] });
    const sink = (d) => { this.out.push(String(d)); };
    this.proc.stdout.on("data", sink); this.proc.stderr.on("data", sink);
    this.proc.on("exit", (code, sig) => { this.exited = { code, sig }; });
    const end = Date.now() + 40000;
    for (;;) {
      if (this.exited) throw new Error(`server exited early (${JSON.stringify(this.exited)}): ${this.out.join("").slice(-800)}`);
      try { const r = await fetch(this.base + "/healthz"); await r.text(); if (r.status) break; } catch {}
      if (Date.now() > end) throw new Error("server did not become ready");
      await U.sleep(100);
    }
    return this;
  }
  logs() { return this.out.join(""); }
  async stop() {
    if (!this.proc || this.exited) return;
    const p = this.proc;
    await new Promise((resolve) => { p.once("exit", resolve); p.kill("SIGTERM"); setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 4000).unref(); });
  }
  async restart(envOverrides = {}) { await this.stop(); this.env = { ...this.env, ...envOverrides }; for (const k of Object.keys(this.env)) if (this.env[k] === undefined) delete this.env[k]; return this.start(); }
  storeFile() { return this.env.LEAD_AGENTS_STORE_PATH; }
  readStore() { try { return JSON.parse(fs.readFileSync(this.storeFile(), "utf8")); } catch { return null; } }
  /** Audit events persisted by the file store (poll until `pred` is satisfied or timeout). */
  async audit(pred = () => true, { waitMs = 3000 } = {}) {
    const end = Date.now() + waitMs;
    for (;;) { const s = this.readStore(); const list = (s && s.audit_events || []).filter(pred); if (list.length || Date.now() > end) return list; await U.sleep(100); }
  }
  allAudit() { const s = this.readStore(); return (s && s.audit_events) || []; }
}

async function makeServer({ extra = {}, mail = null, sutDir = SUT, keepDir = null } = {}) {
  const port = await freePort();
  const dir = keepDir || tmpDir("b-sut-");
  const env = baseEnv({ port, dir, mailUrl: mail && mail.url, extra: typeof extra === "function" ? extra({ port, dir }) : extra });
  const s = new Server({ sutDir, dir, env, port });
  await s.start();
  return s;
}

// ---------------------------------------------------------------- HTTP client with cookie jar
let ipCounter = Math.floor(Math.random() * 200) + 20;
function uniqueIp() { ipCounter += 1; return `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.${Math.floor(Math.random() * 200) + 1}`; }

class Client {
  constructor(srv, { ip, cookie, name } = {}) { this.srv = srv; this.ip = ip || uniqueIp(); this.cookie = cookie || ""; this.name = name || ""; this.cookieName = "lead_agents_admin"; }
  clone({ keepCookie = true } = {}) { return new Client(this.srv, { ip: this.ip, cookie: keepCookie ? this.cookie : "", name: this.name }); }
  async raw(method, p, { body, headers = {}, cookie, noCookie = false, noIp = false, rawBody } = {}) {
    const h = { ...(noIp ? {} : { "x-forwarded-for": this.ip }), ...headers };
    const ck = noCookie ? "" : (cookie !== undefined ? cookie : this.cookie);
    if (ck) h.cookie = `${this.cookieName}=${ck}`;
    let payload;
    if (rawBody !== undefined) { payload = rawBody; if (!h["content-type"]) h["content-type"] = "application/json"; }
    else if (body !== undefined) { payload = JSON.stringify(body); h["content-type"] = "application/json"; }
    const res = await fetch(this.srv.base + p, { method, headers: h, body: payload, redirect: "manual" });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, body: json !== null ? json : text, text, setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [] };
  }
  async req(method, p, opts = {}) {
    const r = await this.raw(method, p, opts);
    if (!opts.noJar) for (const sc of r.setCookie) {
      const m = sc.match(/^lead_agents_admin=([^;]*)/);
      if (m) { const val = decodeURIComponent(m[1]); const cleared = /Max-Age=0/i.test(sc) || val === ""; this.cookie = cleared ? "" : val; }
    }
    return r;
  }
  get(p, o) { return this.req("GET", p, o); }
  post(p, body, o = {}) { return this.req("POST", p, { ...o, body: body === undefined ? {} : body }); }
  put(p, body, o = {}) { return this.req("PUT", p, { ...o, body }); }
  patch(p, body, o = {}) { return this.req("PATCH", p, { ...o, body }); }
}

const A = "/api/lead-agents/admin";
const API_KEY = "apikey-fixture-0123456789abcdef";
const EDGE = "edge-fixture-0123456789abcdef";

// ---------------------------------------------------------------- people and MFA helpers
class Person {
  constructor(srv, { email, password, id, role = "viewer" }) { this.srv = srv; this.email = email; this.password = password; this.id = id; this.role = role; this.secret = null; this.lastStep = 0; this.recovery = []; this.wa = []; this.client = new Client(srv, { name: email }); }
  newClient() { return new Client(this.srv, { name: this.email }); }
  async loginRaw(client = this.client, password = this.password) { return client.post(`${A}/session/login`, { email: this.email, password }); }
  /** Full sign-in with TOTP. Returns { client, res (verify response), login (first response) }. */
  async signIn({ client = this.newClient(), method = "totp", code, password = this.password } = {}) {
    const login = await this.loginRaw(client, password);
    if (login.body && login.body.ok === true) return { client, login, res: login };
    if (!login.body || !login.body.challenge_token) return { client, login, res: login };
    let res;
    if (method === "totp") {
      const t = code ? { code, step: 0 } : await U.nextTotp(this.secret, this.lastStep);
      res = await client.post(`${A}/session/mfa/verify`, { challenge_token: login.body.challenge_token, method: "totp", code: t.code });
      if (res.status === 200 && !code) this.lastStep = t.step;
    } else if (method === "recovery_code") {
      res = await client.post(`${A}/session/mfa/verify`, { challenge_token: login.body.challenge_token, method: "recovery_code", code: code || this.recovery.shift() });
    } else throw new Error("unsupported method " + method);
    return { client, login, res };
  }
  /** Step-up grant for a purpose. mfa: "auto" (TOTP, a fresh code is generated) | object | null. */
  async stepUp(client, purpose, { password = this.password, mfa = "auto", extraBody = {}, headers = {} } = {}) {
    const body = { purpose, password, ...extraBody };
    if (mfa === "auto" && this.secret) { const t = await U.nextTotp(this.secret, this.lastStep); body.mfa = { method: "totp", code: t.code }; var step = t.step; }
    else if (mfa && mfa !== "auto") body.mfa = mfa;
    const res = await client.post(`${A}/session/step-up`, body, { headers });
    if (res.status === 200 && step) this.lastStep = step;
    return res;
  }
  /** Voluntary TOTP enrolment through the HTTP API. Returns { ok, secret, recovery, credentialId, begin, confirm, grant }. */
  async enrollTotp(client = this.client) {
    const grant = await this.stepUp(client, "mfa_management", { mfa: this.secret ? "auto" : null });
    if (grant.status !== 200) return { ok: false, grant };
    const token = grant.body.step_up.token;
    const begin = await client.post(`${A}/session/mfa/enroll/totp/begin`, {}, { headers: { "x-step-up-token": token } });
    if (begin.status !== 200) return { ok: false, grant, begin };
    const secret = begin.body.secret_base32;
    const t = await U.nextTotp(secret, 0);
    const confirm = await client.post(`${A}/session/mfa/enroll/totp/confirm`, { credential_id: begin.body.credential_id, code: t.code }, { headers: { "x-step-up-token": token } });
    if (confirm.status !== 200) return { ok: false, grant, begin, confirm };
    this.secret = secret; this.lastStep = t.step;
    if (confirm.body.recovery_codes) this.recovery = confirm.body.recovery_codes.slice();
    return { ok: true, secret, recovery: confirm.body.recovery_codes, credentialId: begin.body.credential_id, begin, confirm, grant };
  }
  stepHeaders(grant) { return { "x-step-up-token": grant.body.step_up.token }; }
}

/** Bootstrap admin session (super_admin). MFA is on but the admin has no factor yet, so a normal login works. */
async function adminLogin(srv) {
  const p = new Person(srv, { email: srv.env.LEAD_AGENTS_ADMIN_EMAIL, password: srv.env.LEAD_AGENTS_ADMIN_PASSWORD, role: "super_admin" });
  const r = await p.loginRaw(); if (r.status !== 200 || !r.body.ok) throw new Error("admin login failed: " + JSON.stringify(r.body));
  p.id = r.body.admin.id; return p;
}

async function createUser(admin, { role = "ochiga_staff", email, password, scopes = [], status } = {}) {
  const pw = password || U.randomPassword();
  const em = email || `u${crypto.randomBytes(5).toString("hex")}@fixture.test`;
  const r = await admin.client.post(`${A}/users`, { email: em, password: pw, role, display_name: em, permission_scopes: scopes, ...(status ? { status } : {}) });
  if (r.status !== 201) throw new Error("create user failed: " + JSON.stringify(r.body));
  return new Person(admin.srv, { email: r.body.user.email, password: pw, id: r.body.user.id, role });
}

/** A new account with a signed-in session and (optionally) an enrolled TOTP factor. */
async function newPerson(admin, { role = "ochiga_staff", enroll = true, scopes = [] } = {}) {
  const p = await createUser(admin, { role, scopes });
  const r = await p.loginRaw(); if (r.status !== 200 || !r.body.ok) throw new Error("login failed: " + JSON.stringify(r.body));
  if (enroll) { const e = await p.enrollTotp(p.client); if (!e.ok) throw new Error("enrol failed: " + JSON.stringify(e)); }
  return p;
}

/** Register a software authenticator on a signed-in session of `p` (needs a fresh grant). */
async function registerWebauthn(p, client, srv, { counter = 0, zero = false, uv = true, label } = {}) {
  const auth = new SoftAuthenticator2(srv, { counter, zero, uv });
  const grant = await p.stepUp(client, "mfa_management");
  if (grant.status !== 200) return { ok: false, grant };
  const h = { "x-step-up-token": grant.body.step_up.token };
  const opt = await client.post(`${A}/session/mfa/webauthn/register/options`, {}, { headers: h });
  if (opt.status !== 200) return { ok: false, grant, opt };
  const resp = auth.register(opt.body.options);
  const ver = await client.post(`${A}/session/mfa/webauthn/register/verify`, { challenge_id: opt.body.challenge_id, response: resp, ...(label ? { label } : {}) }, { headers: h });
  if (ver.status !== 200) return { ok: false, grant, opt, ver, auth };
  auth.credentialRowId = ver.body.credential.id;
  p.wa.push(auth);
  if (ver.body.recovery_codes) p.recovery = ver.body.recovery_codes.slice();
  return { ok: true, auth, grant, opt, ver };
}
function SoftAuthenticator2(srv, o) { return new U.SoftAuthenticator({ rpId: "localhost", origin: `http://localhost:${srv.port}`, ...o }); }

module.exports = { SUT, SUT_OLD, Checks, runSuite, freePort, tmpDir, rmrf, startMailCapture, makeServer, baseEnv, Server, Client, uniqueIp, A, API_KEY, EDGE, Person, adminLogin, createUser, newPerson, registerWebauthn, SoftAuthenticator2, U };
