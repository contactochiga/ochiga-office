"use strict";
// Area D test harness: check recorder, server launcher, raw-CDP headless Chrome driver, RFC 6238/4648 helpers.
// No SUT module is imported. The SUT is started as a child process and spoken to over HTTP / the browser.
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");

const SUT = process.env.SUT_DIR || path.resolve(__dirname, "../../..");
const SUT_OLD = process.env.SUT_OLD_DIR || "";
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDTHS = process.env.D_WIDTHS ? process.env.D_WIDTHS.split(",").map(Number) : [1440, 1100, 900, 768, 390];
const heightFor = (w) => (w <= 500 ? 800 : w <= 900 ? 1000 : 900);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n = 8) => crypto.randomBytes(n).toString("hex");
function tmpdir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }

// ------------------------------------------------------------------------------------------------ check recorder
class Suite {
  constructor(name, area = "D") { this.name = name; this.area = area; this.checks = 0; this.failures = []; this.infos = []; this.disputed = []; this.n = 0; this.cleanups = []; }
  check(desc, cond, evidence) {
    this.checks += 1; this.n += 1;
    const id = `${this.name}.${String(this.n).padStart(3, "0")}`;
    const ok = Boolean(cond);
    if (!ok) {
      const line = `${id} ${desc}`;
      this.failures.push(line + (evidence !== undefined ? ` | evidence: ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`.slice(0, 600) : ""));
      console.log(`FAIL ${line}` + (evidence !== undefined ? `\n     evidence: ${(typeof evidence === "string" ? evidence : JSON.stringify(evidence)).slice(0, 600)}` : ""));
    }
    return ok;
  }
  /** Runs a journey; an exception becomes ONE failed check (never a silent pass) and the suite continues. */
  async guard(label, fn) { if (this.only && !this.only.some((p) => label.startsWith(p))) return undefined; try { return await fn(); } catch (err) { if (err && err.blocked) throw err; this.check(`${label} journey completed without an unexpected error`, false, String(err && (err.message + " @ " + String(err.stack || "").split("\n").filter((l) => /d[0-9]/.test(l)).slice(0, 2).join(" ")) || err).slice(0, 700)); return undefined; } }
  info(text) { this.infos.push(text); console.log(`INFO ${text}`); }
  onCleanup(fn) { this.cleanups.push(fn); }
  async cleanup() { for (const fn of this.cleanups.reverse()) { try { await fn(); } catch { /* ignore */ } } this.cleanups = []; }
  summary() { return { suite: this.name, area: this.area, checks: this.checks, failed: this.failures.length, failures: this.failures }; }
}
/** Runs `body(suite)` and always prints the final JSON line; exit codes per the brief. */
async function runSuite(name, body) {
  const suite = new Suite(name);
  let blocked = null;
  const hard = setTimeout(() => { console.log("BLOCKED: suite exceeded its 9 minute budget"); suite.cleanup().finally(() => process.exit(2)); }, 9 * 60_000);
  const onSignal = () => { suite.cleanup().finally(() => process.exit(2)); };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  try { await body(suite); }
  catch (err) {
    if (err && err.blocked) blocked = err.message;
    else { suite.check(`${name} suite aborted by an unexpected exception`, false, String(err && err.stack || err).slice(0, 800)); }
  } finally { clearTimeout(hard); await suite.cleanup(); }
  if (blocked) { console.log(`BLOCKED: ${blocked}`); process.exit(2); }
  console.log(JSON.stringify(suite.summary()));
  process.exit(suite.failures.length ? 1 : 0);
}
const blocked = (reason) => Object.assign(new Error(reason), { blocked: true });

// ------------------------------------------------------------------------------------------------ crypto helpers (own implementations)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(s) {
  const clean = String(s).replace(/[\s=-]/g, "").toUpperCase(); let bits = ""; const out = [];
  for (const ch of clean) { const v = B32.indexOf(ch); if (v < 0) throw new Error("bad base32"); bits += v.toString(2).padStart(5, "0"); }
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function base32Encode(buf) { let bits = ""; for (const b of buf) bits += b.toString(2).padStart(8, "0"); let out = ""; for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)]; return out; }
function hotp(secretBuf, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", secretBuf).update(msg).digest(); const o = h[19] & 15;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, "0");
}
let clockFn = () => Date.now();
const setClock = (fn) => { clockFn = fn; };
const stepNow = () => Math.floor(clockFn() / 30000);
/** One authenticator "device": hands out codes for strictly increasing steps within the server's +-1 window, waiting (explicit condition) if it must. */
class Totp {
  constructor(secretB32, clock) { this.secret = base32Decode(secretB32); this.b32 = secretB32.replace(/\s+/g, ""); this.last = 0; this.clock = clock || (() => clockFn()); }
  step() { return Math.floor(this.clock() / 30000); }
  codeAt(step) { return hotp(this.secret, step); }
  async next() {
    for (;;) {
      const cur = this.step(); const want = Math.max(this.last + 1, cur - 1);
      if (want <= cur + 1) { this.last = want; return hotp(this.secret, want); }
      await sleep(250); // wait for the clock to reach the next step (a readiness condition, not a fixed delay)
    }
  }
  /** A code for a step far outside the window (+-1): must be refused. */
  stale() { return hotp(this.secret, this.step() - 6); }
  /** A wrong code that is not the current/adjacent code. */
  wrong() { const ok = new Set([this.step() - 1, this.step(), this.step() + 1].map((s) => hotp(this.secret, s))); for (let i = 0; i < 1000; i += 1) { const c = String(100000 + Math.floor(Math.random() * 899999)); if (!ok.has(c)) return c; } return "000000"; }
}

// ------------------------------------------------------------------------------------------------ server launcher
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on("error", reject); }); }
function randomB64Key() { for (;;) { const k = crypto.randomBytes(32); if (new Set(k).size >= 20) return k.toString("base64"); } }

async function startServer(suite, opts = {}) {
  const port = opts.port || await freePort();
  const dir = opts.dir || tmpdir("d-srv");
  const mailFile = path.join(dir, "mail.jsonl"); fs.writeFileSync(mailFile, "");
  const adminEmail = opts.adminEmail || "root@example.test";
  const adminPassword = opts.adminPassword || `Root-${rand(6)}-Passw0rd!`;
  const origin = `http://localhost:${port}`;
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir,
    OPENAI_API_KEY: "sk-stub-not-real", LEAD_AGENTS_HOST: "127.0.0.1", LEAD_AGENTS_PORT: String(port),
    LEAD_AGENTS_STORE_DRIVER: "file", LEAD_AGENTS_STORE_PATH: path.join(dir, "store.json"),
    LEAD_AGENTS_AUTH_MODE: "required_api_key", LEAD_AGENTS_API_KEYS: opts.apiKey || `apikey-${rand(12)}`,
    LEAD_AGENTS_ADMIN_EMAIL: adminEmail, LEAD_AGENTS_ADMIN_PASSWORD: adminPassword, LEAD_AGENTS_ADMIN_ROLE: "super_admin",
    LEAD_AGENTS_SESSION_SECRET: opts.sessionSecret || `sess-${rand(24)}`,
    LEAD_AGENTS_MFA: "on", LEAD_AGENTS_MFA_KEY: randomB64Key(), LEAD_AGENTS_MFA_KEY_ID: "k1",
    LEAD_AGENTS_WEBAUTHN_RP_ID: "localhost", LEAD_AGENTS_WEBAUTHN_ORIGINS: origin,
    LEAD_AGENTS_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: String(opts.loginMax || 1000), LEAD_AGENTS_LOGIN_RATE_LIMIT_WINDOW_MS: String(opts.loginWindow || 900000),
    LEAD_AGENTS_RATE_LIMIT_MAX_REQUESTS: "100000", LEAD_AGENTS_OFFICE_RATE_LIMIT_MAX_REQUESTS: "100000",
    OFFICE_APP_URL: origin, OFFICE_EMAIL_PROVIDER: "resend", RESEND_API_KEY: `re_stub_${rand(8)}`,
    MAIL_CAPTURE_FILE: mailFile, NODE_OPTIONS: `--require ${path.join(__dirname, "mailstub.cjs")} --require ${path.join(__dirname, "clockshift.cjs")}`, CLOCK_OFFSET_FILE: path.join(dir, "clock-offset"),
    ...(opts.env || {}),
  };
  for (const k of Object.keys(env)) if (env[k] === undefined || env[k] === null) delete env[k];
  const proc = spawn(process.execPath, ["lead-agents-server.js"], { cwd: opts.cwd || SUT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const log = { out: "", err: "" };
  proc.stdout.on("data", (d) => { log.out += d; }); proc.stderr.on("data", (d) => { log.err += d; });
  let exited = false; proc.on("exit", () => { exited = true; });
  const srv = {
    port, dir, env, origin, proc, log, adminEmail, adminPassword, mailFile, apiKey: env.LEAD_AGENTS_API_KEYS,
    get exited() { return exited; },
    url: (p) => `http://127.0.0.1:${port}${p}`,
    offsetMs: 0, now: () => Date.now() + srv.offsetMs,
    /** Move the SERVER clock forward by `ms` more (cumulative). The harness TOTP clock follows. */
    shiftClock(ms) { srv.offsetMs += ms; fs.writeFileSync(path.join(dir, "clock-offset"), String(srv.offsetMs)); return sleep(60); },
    mails() { return fs.readFileSync(mailFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); },
    async stop() { if (!exited) { try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch { /* gone */ } } } await sleep(100); },
    cleanDir() { rmrf(dir); },
  };
  suite.onCleanup(async () => { await srv.stop(); if (!opts.keepDir) rmrf(dir); });
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (exited) throw blocked(`server exited during start: ${(log.err || log.out).slice(0, 400)}`);
    try { const r = await fetch(srv.url("/healthz")); if (r.status === 200 || r.status === 503) { const j = await r.json().catch(() => null); if (j && (j.ready || opts.allowNotReady)) break; } } catch { /* not yet */ }
    if (Date.now() > deadline) throw blocked(`server not ready: ${(log.err || log.out).slice(0, 400)}`);
    await sleep(100);
  }
  return srv;
}

// ------------------------------------------------------------------------------------------------ HTTP helper
async function http(srv, method, p, { body, cookie, headers = {}, raw = false, base } = {}) {
  const h = { ...headers }; if (cookie) h.cookie = cookie; let payload;
  if (body !== undefined) { h["content-type"] = h["content-type"] || "application/json"; payload = typeof body === "string" ? body : JSON.stringify(body); }
  const res = await fetch((base || srv.url("")) + p, { method, headers: h, body: payload, redirect: "manual" });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  const setCookie = res.headers.get("set-cookie") || "";
  const m = /^([^=]+)=([^;]*)/.exec(setCookie);
  return { status: res.status, json, text, headers: res.headers, setCookie, cookie: m && m[2] ? `${m[1]}=${m[2]}` : "" };
}
const SESSION = "/api/lead-agents/admin/session";
async function apiLogin(srv, email, password) { return http(srv, "POST", `${SESSION}/login`, { body: { email, password } }); }
async function apiStepUp(srv, cookie, purpose, password, mfa) { return http(srv, "POST", `${SESSION}/step-up`, { cookie, body: { purpose, password, ...(mfa ? { mfa } : {}) } }); }
/** Sign an account in over HTTP, completing the TOTP challenge when one is issued. Returns the cookie header value. */
async function mfaLoginApi(srv, acct) {
  const r = await apiLogin(srv, acct.email, acct.password); if (r.cookie) return r.cookie;
  if (!r.json || !r.json.challenge_token || !acct.totp) throw blocked(`cannot sign ${acct.email} in: ${r.status} ${r.text.slice(0, 200)}`);
  const v = await http(srv, "POST", `${SESSION}/mfa/verify`, { body: { challenge_token: r.json.challenge_token, method: "totp", code: await acct.totp.next() } });
  if (!v.cookie) throw blocked(`cannot complete the challenge for ${acct.email}: ${v.status} ${v.text.slice(0, 200)}`);
  return v.cookie;
}
async function adminCookie(srv) { return mfaLoginApi(srv, srv.root || { email: srv.adminEmail, password: srv.adminPassword }); }
/** Enrol the bootstrap super administrator (needed for resets, revocation and policy writes). */
async function enrollRoot(srv) {
  const lg = await apiLogin(srv, srv.adminEmail, srv.adminPassword);
  const e = await enrollTotpApi(srv, lg.cookie, srv.adminPassword);
  srv.root = { email: srv.adminEmail, password: srv.adminPassword, totp: e.totp, recoveryCodes: e.recoveryCodes, id: null, role: "super_admin" };
  return srv.root;
}
const ENF = "/api/lead-agents/admin/settings/office_mfa_enforcement";
async function rootGrant(srv, purpose, ck, actor) {
  const root = actor || srv.root; const cookie = ck || await mfaLoginApi(srv, root);
  const su = await apiStepUp(srv, cookie, purpose, root.password, { method: "totp", code: await root.totp.next() });
  if (su.status !== 200) throw blocked(`step-up ${purpose} for ${root.email} failed ${su.status} ${su.text.slice(0, 160)}`);
  return { cookie, token: su.json.step_up.token };
}
async function getEnforcement(srv, actor) { const ck = await mfaLoginApi(srv, actor || srv.root); return http(srv, "GET", ENF, { cookie: ck }); }
/** Governed write of the enforcement level through the API (fixture use, or as the "bypass the UI" negative control). */
async function setEnforcementApi(srv, level, { purpose = "security_policy_write", expectedVersion, actor } = {}) {
  const cur = await getEnforcement(srv, actor); const g = await rootGrant(srv, purpose, undefined, actor);
  return http(srv, "PUT", ENF, { cookie: g.cookie, headers: { "x-step-up-token": g.token }, body: { value: level, expected_version: expectedVersion === undefined ? cur.json.setting.version : expectedVersion, confirm: true } });
}
async function setStatus(srv, adminCk, id, status) { return http(srv, "PATCH", `/api/lead-agents/admin/users/${id}`, { cookie: adminCk, body: { status } }); }
async function createUser(srv, adminCk, { email, password, role = "ochiga_admin", display_name }) {
  const r = await http(srv, "POST", "/api/lead-agents/admin/users", { cookie: adminCk, body: { email, password, role, display_name: display_name || email } });
  if (r.status !== 201) throw blocked(`cannot create fixture user ${email}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.user;
}
/** Enrol a TOTP factor through the HTTP API (fixture seeding). Returns { totp, recoveryCodes, credentialId, cookie }. */
async function enrollTotpApi(srv, cookie, password, totpIn) {
  const su = await apiStepUp(srv, cookie, "mfa_management", password);
  if (su.status !== 200) throw blocked(`seed step-up failed ${su.status} ${su.text.slice(0, 200)}`);
  const hdr = { "x-step-up-token": su.json.step_up.token };
  const b = await http(srv, "POST", `${SESSION}/mfa/enroll/totp/begin`, { cookie, headers: hdr, body: {} });
  if (b.status !== 200) throw blocked(`seed enrol begin failed ${b.status} ${b.text.slice(0, 200)}`);
  const totp = totpIn || new Totp(b.json.secret_base32, srv.now);
  const c = await http(srv, "POST", `${SESSION}/mfa/enroll/totp/confirm`, { cookie, headers: hdr, body: { credential_id: b.json.credential_id, code: await totp.next() } });
  if (c.status !== 200) throw blocked(`seed enrol confirm failed ${c.status} ${c.text.slice(0, 200)}`);
  return { totp, recoveryCodes: c.json.recovery_codes || [], credentialId: b.json.credential_id, cookie: c.cookie || cookie };
}
async function freshAccount(srv, adminCk, { role = "ochiga_admin", enroll = true, tag = "u" } = {}) {
  const email = `${tag}-${rand(4)}@example.test`; const password = `Pw-${rand(8)}-Zx9!`;
  const user = await createUser(srv, adminCk, { email, password, role });
  const acct = { email, password, id: user.id, role };
  if (enroll) {
    const lg = await apiLogin(srv, email, password);
    const e = await enrollTotpApi(srv, lg.cookie, password);
    Object.assign(acct, { totp: e.totp, recoveryCodes: e.recoveryCodes, credentialId: e.credentialId });
  }
  return acct;
}

// ------------------------------------------------------------------------------------------------ CDP
class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.handlers = new Map(); this.sessions = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => { this.ws.addEventListener("open", res, { once: true }); this.ws.addEventListener("error", () => rej(new Error("ws connect failed")), { once: true }); });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id && this.pending.has(msg.id)) { const { resolve, reject, method } = this.pending.get(msg.id); this.pending.delete(msg.id); if (msg.error) reject(new Error(`${method}: ${msg.error.message}`)); else resolve(msg.result); return; }
      if (msg.method) { const hs = this.handlers.get(`${msg.sessionId || ""}|${msg.method}`) || []; for (const h of hs) { try { h(msg.params); } catch { /* handler errors must not break the pump */ } } const any = this.handlers.get(`${msg.sessionId || ""}|*`) || []; for (const h of any) { try { h(msg.method, msg.params); } catch { /* ignore */ } } }
    });
    this.ws.addEventListener("close", () => { for (const { reject, method } of this.pending.values()) reject(new Error(`${method}: connection closed`)); this.pending.clear(); });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, method }); this.ws.send(JSON.stringify(msg)); });
  }
  on(sessionId, method, fn) { const k = `${sessionId || ""}|${method}`; if (!this.handlers.has(k)) this.handlers.set(k, []); this.handlers.get(k).push(fn); }
  close() { try { this.ws.close(); } catch { /* closed */ } }
}

async function launchChrome(suite) {
  if (!fs.existsSync(CHROME)) throw blocked(`Chrome not found at ${CHROME}`);
  const profile = tmpdir("d-chrome");
  const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync",
    "--disable-component-update", "--disable-default-apps", "--mute-audio", "--password-store=basic", "--use-mock-keychain", "--disable-features=Translate,MediaRouter", "--disable-popup-blocking", "about:blank"];
  const proc = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
  let err = ""; proc.stderr.on("data", (d) => { err += d; });
  let exited = false; proc.on("exit", () => { exited = true; });
  const kill = async () => { if (!exited) { try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch { /* gone */ } } } await sleep(150); rmrf(profile); };
  suite.onCleanup(kill);
  const portFile = path.join(profile, "DevToolsActivePort"); const deadline = Date.now() + 30_000;
  while (!fs.existsSync(portFile) || fs.readFileSync(portFile, "utf8").split("\n").length < 2) {
    if (exited) throw blocked(`Chrome exited early: ${err.slice(0, 300)}`);
    if (Date.now() > deadline) throw blocked("Chrome did not publish a debugging port");
    await sleep(100);
  }
  const [port, wsPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
  const cdp = new CDP(`ws://127.0.0.1:${port}${wsPath}`); await cdp.connect();
  suite.onCleanup(async () => cdp.close());
  return { cdp, proc, profile, kill };
}

const KEYS = { Enter: [13, "Enter", "\r"], Tab: [9, "Tab", ""], Escape: [27, "Escape", ""], " ": [32, "Space", " "], ArrowDown: [40, "ArrowDown", ""], ArrowUp: [38, "ArrowUp", ""], Backspace: [8, "Backspace", ""] };

class Page {
  constructor(browser, cdp, targetId, sessionId, contextId) {
    this.browser = browser; this.cdp = cdp; this.targetId = targetId; this.sid = sessionId; this.contextId = contextId;
    this.console = []; this.exceptions = []; this.requests = []; this.responses = new Map(); this.bodies = []; this.secrets = new Set(); this.inflight = new Set(); this.dialogs = []; this.blobs = []; this.navigations = [];
  }
  send(m, p) { return this.cdp.send(m, p, this.sid); }
  async init(origin) {
    const on = (m, f) => this.cdp.on(this.sid, m, f);
    on("Runtime.consoleAPICalled", (p) => this.console.push({ type: p.type, text: (p.args || []).map((a) => a.value !== undefined ? String(a.value) : a.description || "").join(" ") }));
    on("Runtime.exceptionThrown", (p) => this.exceptions.push((p.exceptionDetails && (p.exceptionDetails.exception && p.exceptionDetails.exception.description || p.exceptionDetails.text)) || "exception"));
    on("Log.entryAdded", (p) => this.console.push({ type: `log-${p.entry.level}`, text: `${p.entry.text} ${p.entry.url || ""}` }));
    on("Network.requestWillBeSent", (p) => { this.inflight.add(p.requestId); this.requests.push({ id: p.requestId, url: p.request.url, method: p.request.method, postData: p.request.postData || "", type: p.type, headers: p.request.headers }); });
    on("Network.loadingFailed", (p) => this.inflight.delete(p.requestId));
    on("Network.responseReceived", (p) => this.responses.set(p.requestId, { url: p.response.url, status: p.response.status, type: p.type, headers: p.response.headers }));
    on("Network.loadingFinished", (p) => { this.inflight.delete(p.requestId); const r = this.responses.get(p.requestId); if (r && /\/api\//.test(r.url)) this.captureBody(p.requestId, r); });
    on("Page.javascriptDialogOpening", (p) => { this.dialogs.push({ type: p.type, message: p.message }); this.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {}); });
    on("Page.frameNavigated", (p) => { if (!p.frame.parentId) this.navigations.push(p.frame.url); });
    for (const d of ["Page", "Runtime", "Network", "Log", "DOM", "Accessibility"]) await this.send(`${d}.enable`);
    await this.send("Network.setCacheDisabled", { cacheDisabled: true });
    // test instrumentation: record Blob downloads (text) so the recovery-code download can be inspected without touching the file system
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { window.__q = (sel) => { if (sel.startsWith('top:')) { const vis = (e) => e.getClientRects().length > 0; const b = [...document.querySelectorAll('.st-modal-backdrop')].filter(vis).pop(); return b ? b.querySelector(sel.slice(4)) : null; } return document.querySelector(sel); }; window.__blobs = []; const o = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { try { if (b && b.text) b.text().then((t) => window.__blobs.push({ type: b.type, text: t })); } catch (e) {} return o(b); }; })();` });
    if (origin) await this.cdp.send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});
  }
  async captureBody(id, r) {
    try {
      const b = await this.send("Network.getResponseBody", { requestId: id }); let j; try { j = JSON.parse(b.body); } catch { return; }
      this.bodies.push({ url: r.url, status: r.status, json: j });
      const grab = (v) => { if (typeof v === "string" && v.length >= 6) this.secrets.add(v); };
      const walk = (o, key = "") => { if (!o || typeof o !== "object") return; for (const [k, v] of Object.entries(o)) {
        if (/^(challenge_token|enrollment_token|secret_base32|token|session_id|sid)$/.test(k) && typeof v === "string") grab(v);
        if (k === "recovery_codes" && Array.isArray(v)) v.forEach(grab);
        if (k === "otpauth_uri" && typeof v === "string") { grab(v); const m = /secret=([A-Z2-7]+)/.exec(v); if (m) grab(m[1]); }
        if (typeof v === "object") walk(v, k); } };
      walk(j);
    } catch { /* body unavailable */ }
  }
  async eval(expr, { await: aw = true } = {}) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: aw, userGesture: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text} in ${expr.slice(0, 120)}`);
    return r.result.value;
  }
  async goto(url, { ready = true } = {}) {
    const loaded = new Promise((res) => { const h = () => res(); this.cdp.on(this.sid, "Page.loadEventFired", h); setTimeout(res, 20000); });
    await this.send("Page.navigate", { url }); await loaded;
    if (ready) await this.waitFor(`document.getElementById('loginForm') ? document.getElementById('loginForm').dataset.wired === '1' : !!document.getElementById('root')`, { what: "Office UI wired" });
  }
  async reload() { const loaded = new Promise((res) => { this.cdp.on(this.sid, "Page.loadEventFired", () => res()); setTimeout(res, 20000); }); await this.send("Page.reload", { ignoreCache: true }); await loaded; }
  async waitFor(expr, { timeout = 20000, what = expr, interval = 40 } = {}) {
    const end = Date.now() + timeout; let last;
    for (;;) {
      try { const v = await this.eval(`(() => { try { return (${expr}); } catch (e) { return false; } })()`); if (v) return v; last = v; } catch (e) { last = e.message; }
      if (Date.now() > end) throw new Error(`timeout waiting for: ${what} (last=${JSON.stringify(last)})`);
      await sleep(interval);
    }
  }
  /** Wait until no request has been in flight for several consecutive polls (the UI has finished loading what it asked for). */
  async settle({ polls = 6, timeout = 15000 } = {}) { const end = Date.now() + timeout; let quiet = 0; while (quiet < polls) { if (this.inflight.size === 0) quiet += 1; else quiet = 0; if (Date.now() > end) return false; await sleep(50); } return true; }
  async viewport(w, h = heightFor(w)) {
    await this.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false, screenWidth: w, screenHeight: h });
    await this.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  }
  async rect(sel) { return this.eval(`(() => { const e = __q(${JSON.stringify(sel)}); if (!e) return null; let r = e.getBoundingClientRect(); if (r.right > 0 && r.left < innerWidth && (r.top < 0 || r.bottom > innerHeight)) e.scrollIntoView({ block: 'center', inline: 'nearest' }); r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`); }
  /** Real mouse click at the element's centre; fails if another element would receive it. */
  async click(sel, { allowCover = false } = {}) {
    await this.waitFor(`(() => { const e = __q(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0 })()`, { what: `visible ${sel}` });
    let r = await this.rect(sel); if (!r) throw new Error(`no element ${sel}`);
    // wait until the element is on screen and has stopped moving (CSS transitions): identical rectangle on consecutive frames
    let prev = null; const t0 = Date.now();
    for (;;) {
      const cur = await this.eval(`new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => { const e = __q(${JSON.stringify(sel)}); if (!e) return res(null); const b = e.getBoundingClientRect(); res({ x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2, on: b.right > 0 && b.left < innerWidth }); })))`);
      if (!cur) throw new Error(`no element ${sel}`);
      if (cur.on && prev && Math.abs(cur.x - prev.x) < 0.5 && Math.abs(cur.y - prev.y) < 0.5 && Math.abs(cur.w - prev.w) < 0.5) { r = cur; break; }
      prev = cur; if (Date.now() - t0 > 5000) throw new Error(`${sel} never settled on screen: ${JSON.stringify(cur)}`);
    }
    const hit = await this.eval(`(() => { const e = __q(${JSON.stringify(sel)}); const t = document.elementFromPoint(${r.cx}, ${r.cy}); return !!t && (e === t || e.contains(t) || t.contains(e)); })()`);
    if (!hit && !allowCover) { const what = await this.eval(`(() => { const t = document.elementFromPoint(${r.cx}, ${r.cy}); return t ? t.outerHTML.slice(0, 160) : null; })()`); throw new Error(`click on ${sel} would hit another element: ${what}`); }
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.cx, y: r.cy });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.cx, y: r.cy, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.cx, y: r.cy, button: "left", clickCount: 1 });
  }
  async focus(sel) { await this.eval(`__q(${JSON.stringify(sel)}).focus()`); }
  /** Types into whatever has focus, one real key event per character. */
  async typeKeys(text) { for (const ch of String(text)) await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch }).then(() => this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch })); }
  async press(key, { shift = false } = {}) {
    const k = KEYS[key] || [0, key, ""]; const modifiers = shift ? 8 : 0;
    await this.send("Input.dispatchKeyEvent", { type: k[2] ? "keyDown" : "rawKeyDown", key, code: k[1], windowsVirtualKeyCode: k[0], nativeVirtualKeyCode: k[0], modifiers, text: k[2] || undefined });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: k[1], windowsVirtualKeyCode: k[0], nativeVirtualKeyCode: k[0], modifiers });
  }
  /** Click a field, clear it, type into it (mouse path). */
  async fill(sel, text) {
    await this.click(sel); await this.eval(`(() => { const e = __q(${JSON.stringify(sel)}); e.select && e.select(); })()`);
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }); await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    if (text) await this.send("Input.insertText", { text });
  }
  active() { return this.eval(`(() => { const a = document.activeElement; if (!a) return null; return { tag: a.tagName.toLowerCase(), id: a.id || '', name: a.getAttribute('name') || '', type: a.getAttribute('type') || '', text: (a.textContent || '').trim().slice(0, 60), cls: a.className && a.className.toString ? a.className.toString() : '', inDialog: !!a.closest('[role=dialog]'), aria: a.getAttribute('aria-label') || '' }; })()`); }
  text(sel) { return this.eval(`(() => { const e = __q(${JSON.stringify(sel)}); return e ? (e.innerText || e.textContent || '') : null; })()`); }
  visible(sel) { return this.eval(`(() => { const e = __q(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; })()`); }
  async cookies() { return (await this.cdp.send("Storage.getCookies", this.contextId ? { browserContextId: this.contextId } : {})).cookies; }
  async sessionCookie(name = "lead_agents_admin") { const c = (await this.cookies()).find((x) => x.name === name); return c || null; }
  async setCookie(name, value, url) { await this.cdp.send("Storage.setCookies", { cookies: [{ name, value, url, httpOnly: true, sameSite: "Lax" }], ...(this.contextId ? { browserContextId: this.contextId } : {}) }); }
  async clearCookies() { await this.cdp.send("Storage.clearCookies", this.contextId ? { browserContextId: this.contextId } : {}); }
  async axTree() { const r = await this.send("Accessibility.getFullAXTree"); return r.nodes.filter((n) => !n.ignored).map((n) => ({ role: n.role && n.role.value, name: n.name && n.name.value || "", description: n.description && n.description.value || "", props: Object.fromEntries((n.properties || []).map((p) => [p.name, p.value && p.value.value])), backendDOMNodeId: n.backendDOMNodeId })); }
  async storageDump() {
    return this.eval(`(async () => {
      const out = { local: {}, session: {}, cookie: document.cookie, idb: [], url: location.href };
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out.local[k] = localStorage.getItem(k); } } catch (e) {}
      try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); out.session[k] = sessionStorage.getItem(k); } } catch (e) {}
      try { const dbs = indexedDB.databases ? await indexedDB.databases() : []; for (const d of dbs) { out.idb.push({ name: d.name }); } } catch (e) {}
      return out; })()`);
  }
  async close() { try { await this.cdp.send("Target.closeTarget", { targetId: this.targetId }); } catch { /* closed */ } if (this.contextId) { try { await this.cdp.send("Target.disposeBrowserContext", { browserContextId: this.contextId }); } catch { /* gone */ } } }
}

async function newPage(chrome, { isolated = true, origin } = {}) {
  const { cdp } = chrome; let contextId;
  if (isolated) contextId = (await cdp.send("Target.createBrowserContext", { disposeOnDetach: true })).browserContextId;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", ...(contextId ? { browserContextId: contextId } : {}) });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(chrome, cdp, targetId, sessionId, contextId); await page.init(origin);
  return page;
}

// ------------------------------------------------------------------------------------------------ virtual authenticator
async function addAuthenticator(page, opts = {}) {
  await page.send("WebAuthn.enable", { enableUI: false });
  const r = await page.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, ...opts } });
  return r.authenticatorId;
}
const getCredentials = (page, authenticatorId) => page.send("WebAuthn.getCredentials", { authenticatorId }).then((r) => r.credentials);

// ------------------------------------------------------------------------------------------------ the UI journeys' primitives
const UI = {
  async openLogin(page, srv) { await page.goto(`${srv.origin}/office`); await page.waitFor(`document.body.classList.contains('auth-logged-out') && document.getElementById('loginEmail') && document.getElementById('loginEmail').getClientRects().length > 0`, { what: "sign-in form visible" }); },
  async submitPassword(page, email, password, { keyboard = false } = {}) {
    if (keyboard) { await page.focus("#loginEmail"); await page.eval(`document.getElementById('loginEmail').select()`); await page.typeKeys(email); await page.press("Tab"); await page.eval(`document.getElementById('loginPassword').select()`); await page.typeKeys(password); await page.press("Enter"); }
    else { await page.fill("#loginEmail", email); await page.fill("#loginPassword", password); await page.click("#loginSubmit"); }
  },
  signedIn: (page) => page.eval(`!document.body.classList.contains('auth-logged-out')`),
  async waitSignedIn(page) { await page.waitFor(`!document.body.classList.contains('auth-logged-out')`, { what: "shell visible" }); },
  async waitChallenge(page) {
    try { await page.waitFor(`!!document.getElementById('mfaChallenge')`, { what: "second-factor challenge", timeout: 15000 }); }
    catch (e) { const st = await page.eval(`JSON.stringify({ err: document.getElementById('loginError').textContent, vis: document.getElementById('loginError').classList.contains('visible'), btn: document.getElementById('loginSubmit').textContent, dis: document.getElementById('loginSubmit').disabled, email: document.getElementById('loginEmail').value, pwlen: document.getElementById('loginPassword').value.length })`).catch(() => "?"); const lg = page.responses.size ? [...page.responses.values()].filter((r) => /session\/login/.test(r.url)).map((r) => r.status) : []; throw new Error(`${e.message} | state=${st} loginStatuses=${lg}`); }
  },
  loginError: (page) => page.text("#loginError"),
  async waitLoginError(page, re) { await page.waitFor(`(() => { const e = document.getElementById('loginError'); return !!e && e.classList.contains('visible') && ${re.toString()}.test(e.textContent) })()`, { what: `login error ${re}` }); },
  async sessionCookiePresent(page) { return Boolean(await page.sessionCookie()); },
};

// ------------------------------------------------------------------------------------------------ generic audits
const DESKTOP_ONLY = new Set();
async function layoutAudit(page, { touchMin = 44, scope = "body", ignore = "" } = {}) {
  return page.eval(`(() => {
    const w = innerWidth; const out = { w, scrollW: document.documentElement.scrollWidth, bodyScrollW: document.body.scrollWidth, small: [], overflowing: [] };
    const roots = ${JSON.stringify(scope)}.startsWith('top:') ? [__q(${JSON.stringify(scope)})].filter(Boolean) : [...document.querySelectorAll(${JSON.stringify(scope)})]; if (!roots.length) roots.push(document.body);
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    for (const e of roots.flatMap((r) => [...r.querySelectorAll('button, input:not([type=hidden]), select, textarea, a[href], [role=button]')])) {
      if (!vis(e)) continue; if (e.closest('[hidden]')) continue; ${ignore ? `if (e.matches(${JSON.stringify(ignore)})) continue;` : ""}
      const r = e.getBoundingClientRect(); const isCheck = e.type === 'checkbox' || e.type === 'radio';
      const label = e.closest('label'); const rr = isCheck && label ? label.getBoundingClientRect() : r;
      if (rr.height < ${touchMin} - 0.5 || (rr.width < ${touchMin} - 0.5 && !(e.tagName === 'A'))) out.small.push({ tag: e.tagName.toLowerCase(), id: e.id, text: (e.textContent || e.value || e.getAttribute('aria-label') || '').trim().slice(0, 40), w: Math.round(rr.width), h: Math.round(rr.height) });
      if (r.right > w + 1 || r.left < -1) out.overflowing.push({ tag: e.tagName.toLowerCase(), id: e.id, right: Math.round(r.right) });
    }
    return out; })()`);
}
const hasHScroll = (la) => la.scrollW > la.w + 1 || la.bodyScrollW > la.w + 1;

/** Everything in the page's observable output must be free of the secrets the page itself was given. */
async function privacyAudit(suite, page, srv, label, extraSecrets = []) {
  const secrets = [...page.secrets, ...extraSecrets].filter((s) => typeof s === "string" && s.length >= 6);
  const dump = await page.storageDump();
  const blob = JSON.stringify({ local: dump.local, session: dump.session, cookie: dump.cookie, idb: dump.idb });
  const leaked = secrets.filter((s) => blob.includes(s));
  suite.check(`${label}: no secret/token/code in localStorage, sessionStorage, IndexedDB names or readable cookies`, leaked.length === 0, leaked.map((s) => s.slice(0, 4) + "..."));
  suite.check(`${label}: localStorage/sessionStorage hold no password-like or token-like key`, ![...Object.keys(dump.local), ...Object.keys(dump.session)].some((k) => /pass|token|secret|recovery|session|challenge|otp|totp|grant/i.test(k)), Object.keys({ ...dump.local, ...dump.session }));
  suite.check(`${label}: no IndexedDB database exists`, dump.idb.length === 0, dump.idb);
  const urls = [...page.navigations, dump.url, ...page.requests.map((r) => r.url)];
  const urlLeak = secrets.filter((s) => urls.some((u) => u.includes(s) || u.includes(encodeURIComponent(s))));
  suite.check(`${label}: no secret in any URL (navigations or requests)`, urlLeak.length === 0, urlLeak.map((s) => s.slice(0, 4) + "..."));
  const logTxt = page.console.map((c) => c.text).join("\n");
  const logLeak = secrets.filter((s) => logTxt.includes(s));
  suite.check(`${label}: no secret in console output`, logLeak.length === 0, logLeak.map((s) => s.slice(0, 4) + "..."));
  const foreign = page.requests.filter((r) => { try { const u = new URL(r.url); if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return false; return u.host !== `localhost:${srv.port}` && u.host !== `127.0.0.1:${srv.port}`; } catch { return true; } });
  suite.check(`${label}: every request goes to the Office server only`, foreign.length === 0, foreign.map((r) => r.url));
  suite.check(`${label}: no uncaught page error`, page.exceptions.length === 0, page.exceptions);
  const sc = await page.sessionCookie();
  if (sc) suite.check(`${label}: session cookie is HttpOnly and not visible to scripts`, sc.httpOnly === true && !dump.cookie.includes(sc.value), { httpOnly: sc.httpOnly });
}

const axFind = (nodes, role, re) => nodes.filter((n) => (!role || n.role === role) && (!re || re.test(n.name)));
module.exports = { axFind, ENF, rootGrant, getEnforcement, setEnforcementApi, mfaLoginApi, enrollRoot, setStatus, SUT, SUT_OLD, WIDTHS, heightFor, sleep, rand, tmpdir, rmrf, Suite, runSuite, blocked, base32Decode, base32Encode, hotp, stepNow, Totp, freePort,
  startServer, setClock, http, SESSION, apiLogin, apiStepUp, adminCookie, createUser, enrollTotpApi, freshAccount, launchChrome, newPage, addAuthenticator, getCredentials, UI, layoutAudit, hasHScroll, privacyAudit, CDP, Page };
