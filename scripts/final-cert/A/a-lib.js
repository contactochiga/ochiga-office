"use strict";
// Area A test library (independent, written from the brief; imports nothing from the system under test).
// - Suite: named checks, JSON summary line, exit codes (0 pass, 1 failed checks, 2 infrastructure).
// - startServer: runs the SUT as a child process from a private symlink copy (the SUT is never written), ephemeral port, private store.
// - Client: HTTP helper with cookie handling; rawHttp for malformed requests.
// - TOTP / base32, token minting helpers (HMAC), secret scanning.

const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");

const SUT = process.env.SUT_DIR || path.resolve(__dirname, "../../..");
const SUT_OLD = process.env.SUT_OLD_DIR || null;
const COOKIE_NAME = "lead_agents_admin";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n = 6) => crypto.randomBytes(n).toString("hex");
const short = (v) => { try { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 400 ? s.slice(0, 400) + "..." : s; } catch { return String(v); } };

class Blocked extends Error { constructor(m) { super(m); this.blocked = true; } }

// ------------------------------------------------------------------ suite
function createSuite(name, area = "A") {
  let checks = 0; const failures = []; const cleanups = [];
  const suite = {
    name, area,
    check(id, desc, cond, detail) {
      checks++;
      if (!cond) { const label = `${id} ${desc}`; failures.push(label); console.log(`FAIL ${label}${detail !== undefined ? " :: " + short(detail) : ""}`); }
      return Boolean(cond);
    },
    eq(id, desc, actual, expected) {
      return suite.check(id, desc, actual === expected, { expected, actual });
    },
    status(id, desc, res, expected) {
      const ok = Array.isArray(expected) ? expected.includes(res.status) : res.status === expected;
      return suite.check(id, desc, ok, { expected, actual: res.status, body: res.text && res.text.slice(0, 200) });
    },
    onCleanup(fn) { cleanups.push(fn); },
    // a section that throws is a FAILED check (never a silent pass); a Blocked error is an infrastructure problem.
    async section(title, fn) {
      try { await fn(); }
      catch (e) {
        if (e && e.blocked) throw e;
        checks++; const label = `SECTION-ABORT ${title}: ${e && e.message}`; failures.push(label); console.log(`FAIL ${label}\n${e && e.stack}`);
      }
    },
    async run(main) {
      let code = 0;
      try { await main(suite); }
      catch (e) {
        if (e && e.blocked) { console.log(`BLOCKED: ${e.message}`); code = 2; }
        else { checks++; failures.push(`UNCAUGHT ${e && e.message}`); console.log(`FAIL UNCAUGHT ${e && e.stack}`); }
      } finally {
        for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort */ } }
      }
      const summary = { suite: name, area, checks, failed: failures.length, failures };
      console.log(JSON.stringify(summary));
      process.exit(code === 2 ? 2 : failures.length ? 1 : 0);
    },
  };
  const bail = (sig) => () => { Promise.allSettled(cleanups.map((f) => f())).finally(() => process.exit(sig === "SIGINT" ? 130 : 143)); };
  process.on("SIGINT", bail("SIGINT")); process.on("SIGTERM", bail("SIGTERM"));
  return suite;
}

// ------------------------------------------------------------------ server launcher
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function linkedCopy(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a-sut-"));
  for (const entry of fs.readdirSync(src)) {
    if (entry === "data" || entry.startsWith(".env")) continue;
    fs.symlinkSync(path.join(src, entry), path.join(dir, entry));
  }
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  return dir;
}

const STRONG = () => `Qz${rand(5)}-lantern-${rand(4)}`;
function defaultEnv(over = {}) {
  const env = {
    PATH: process.env.PATH, HOME: os.tmpdir(), TMPDIR: os.tmpdir(),
    LEAD_AGENTS_HOST: "127.0.0.1",
    LEAD_AGENTS_STORE_DRIVER: "file",
    OPENAI_API_KEY: "sk-dummy-" + rand(12),
    LEAD_AGENTS_AUTH_MODE: "required_api_key",
    LEAD_AGENTS_OFFICE_RATE_LIMIT_MAX_REQUESTS: "1000000",
    LEAD_AGENTS_RATE_LIMIT_MAX_REQUESTS: "1000000",
  };
  for (const [k, v] of Object.entries(over)) { if (v === undefined || v === null) delete env[k]; else env[k] = String(v); }
  return env;
}

/**
 * Starts the SUT. opts.src (default SUT), opts.env overrides (undefined removes), opts.dir/opts.storePath to reuse data across restarts.
 * Returns { base, port, env, dir, storePath, secrets, logs(), alive(), stop(), kill(), restart(envOver) }.
 */
async function startServer(suite, opts = {}) {
  const src = opts.src || SUT;
  if (!fs.existsSync(path.join(src, "lead-agents-server.js"))) throw new Blocked(`system under test not found at ${src}`);
  const dir = opts.dir || linkedCopy(src);
  const ownsDir = !opts.dir;
  const storePath = opts.storePath || path.join(dir, "data", "store.json");
  const secrets = Object.assign({
    sessionSecret: `sess-${rand(24)}`, apiKey: `key-${rand(16)}`, apiKey2: `key2-${rand(16)}`, edgeToken: `edge-${rand(16)}`,
    adminEmail: `boot-${rand(3)}@example.test`, adminPassword: STRONG(),
  }, opts.secrets || {});
  const baseEnv = {
    LEAD_AGENTS_STORE_PATH: storePath,
    LEAD_AGENTS_SESSION_SECRET: secrets.sessionSecret,
    LEAD_AGENTS_API_KEYS: `${secrets.apiKey},${secrets.apiKey2}`,
    OYI_EDGE_AGENT_TOKENS: secrets.edgeToken,
    LEAD_AGENTS_ADMIN_EMAIL: secrets.adminEmail,
    LEAD_AGENTS_ADMIN_PASSWORD: secrets.adminPassword,
    LEAD_AGENTS_ADMIN_ROLE: "super_admin",
    ...(opts.env || {}),
  };
  const state = { proc: null, out: "", exited: null, port: 0, env: null, secrets, dir, storePath, instanceDirs: [] };

  async function launch(envOver = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const port = opts.port && attempt === 0 ? opts.port : await freePort();
      const env = defaultEnv({ ...baseEnv, ...envOver, LEAD_AGENTS_PORT: port });
      const proc = spawn(process.execPath, ["lead-agents-server.js"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      state.proc = proc; state.exited = null; state.port = port; state.env = env;
      proc.stdout.on("data", (d) => { state.out += d.toString(); });
      proc.stderr.on("data", (d) => { state.out += d.toString(); });
      const exitedP = new Promise((resolve) => proc.on("exit", (code, sig) => { state.exited = { code, sig }; resolve(); }));
      const deadline = Date.now() + 60_000;
      let ready = false;
      while (Date.now() < deadline && !state.exited) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
          await r.arrayBuffer();
          ready = true; break;
        } catch { await sleep(100); }
      }
      if (ready) return;
      await exitedP.catch(() => {});
      if (/EADDRINUSE/.test(state.out) && attempt < 3) { state.out = ""; continue; }
      if (state.exited) throw new Blocked(`server exited before ready: ${state.out.slice(0, 2500)}`);
      throw new Blocked(`server did not become ready: ${state.out.slice(0, 2500)}`);
    }
  }

  const srv = {
    get base() { return `http://127.0.0.1:${state.port}`; },
    get port() { return state.port; },
    env: () => state.env, dir, storePath, secrets,
    logs: () => state.out,
    clearLogs: () => { state.out = ""; },
    alive: () => Boolean(state.proc) && state.exited === null,
    exitInfo: () => state.exited,
    async stop() {
      if (!state.proc || state.exited) return;
      const p = state.proc; p.kill("SIGTERM");
      const t = Date.now();
      while (!state.exited && Date.now() - t < 8000) await sleep(50);
      if (!state.exited) { p.kill("SIGKILL"); const t2 = Date.now(); while (!state.exited && Date.now() - t2 < 4000) await sleep(50); }
    },
    async kill() { if (state.proc && !state.exited) { state.proc.kill("SIGKILL"); const t = Date.now(); while (!state.exited && Date.now() - t < 4000) await sleep(50); } },
    async restart(envOver = {}) { await srv.stop(); await launch(envOver); },
    async cleanup() { await srv.kill(); if (ownsDir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } },
  };
  suite.onCleanup(() => srv.cleanup());
  await launch(opts.launchEnv || {});
  return srv;
}

// ------------------------------------------------------------------ http client
function parseSetCookies(headers) {
  let list = [];
  if (typeof headers.getSetCookie === "function") list = headers.getSetCookie();
  else { const v = headers.get("set-cookie"); if (v) list = [v]; }
  return list;
}
function cookieValue(setCookies, name = COOKIE_NAME) {
  for (const sc of setCookies) {
    const m = sc.match(new RegExp(`^${name}=([^;]*)`));
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}
function attrsOf(setCookie) {
  const parts = String(setCookie).split(";").map((s) => s.trim());
  const out = { _name: parts[0].split("=")[0], _value: parts[0].slice(parts[0].indexOf("=") + 1) };
  for (const p of parts.slice(1)) { const i = p.indexOf("="); if (i === -1) out[p.toLowerCase()] = true; else out[p.slice(0, i).toLowerCase()] = p.slice(i + 1); }
  return out;
}

/** opts: headers, json (object -> JSON body), body (string/Buffer), cookie (raw cookie value of the session cookie), rawCookie (full Cookie header), apiKey, bearer, edge, timeout */
async function call(base, method, p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body;
  if (opts.json !== undefined) { body = JSON.stringify(opts.json); if (!headers["content-type"]) headers["content-type"] = "application/json"; }
  else if (opts.body !== undefined) body = opts.body;
  if (opts.cookie) headers.cookie = `${COOKIE_NAME}=${encodeURIComponent(opts.cookie)}`;
  if (opts.rawCookie) headers.cookie = opts.rawCookie;
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.edge) headers["x-edge-token"] = opts.edge;
  if (opts.stepUp) headers["x-step-up-token"] = opts.stepUp;
  if (opts.xff) headers["x-forwarded-for"] = opts.xff;
  const t0 = performance.now();
  let res;
  try {
    const doFetch = () => fetch(base + p, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(opts.timeout || 30_000) });
    try { res = await doFetch(); }
    catch (e0) {
      // a pooled keep-alive socket may have been closed by the server after an earlier oversize request; retry idempotent calls once on a fresh socket
      const code = (e0 && e0.cause && e0.cause.code) || ""; 
      if (["GET", "HEAD", "OPTIONS"].includes(method) && ["ECONNRESET", "UND_ERR_SOCKET", "EPIPE"].includes(code)) res = await doFetch(); else throw e0;
    }
  } catch (e) { return { status: 0, error: e, ms: performance.now() - t0, headers: new Headers(), setCookies: [], text: "", body: null, cookie: null }; }
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8");
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* not json */ }
  const setCookies = parseSetCookies(res.headers);
  return { status: res.status, headers: res.headers, setCookies, text, body: parsed, ms: performance.now() - t0, cookie: cookieValue(setCookies) };
}

let xffCounter = 0;
class Client {
  // rotate (default true): every request carries a unique client address in X-Forwarded-For so the per-address login budget of one test step never affects another.
  // Throttle tests construct the client with { rotate: false }.
  constructor(srv, { rotate = true } = {}) { this.srv = srv; this.rotate = rotate; }
  get base() { return this.srv.base; }
  call(method, p, opts = {}) {
    if (this.rotate && !opts.xff && !(opts.headers && opts.headers["x-forwarded-for"])) {
      xffCounter++; opts = { ...opts, xff: `10.${(xffCounter >> 16) & 255}.${(xffCounter >> 8) & 255}.${xffCounter & 255}` };
    }
    return call(this.base, method, p, opts);
  }
  get(p, o) { return this.call("GET", p, o); }
  post(p, o) { return this.call("POST", p, o); }
  patch(p, o) { return this.call("PATCH", p, o); }
  put(p, o) { return this.call("PUT", p, o); }
  del(p, o) { return this.call("DELETE", p, o); }
}

/** Sends exact bytes on a TCP socket; returns { status, headersText, body, raw } (reads until the connection closes or the idle timer fires). */
function rawHttp(port, text, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1"); const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer); sock.destroy();
      const raw = Buffer.concat(chunks).toString("latin1"); const idx = raw.indexOf("\r\n\r\n");
      const headersText = idx === -1 ? raw : raw.slice(0, idx); const m = headersText.match(/^HTTP\/1\.\d (\d{3})/);
      resolve({ status: m ? Number(m[1]) : 0, headersText, body: idx === -1 ? "" : raw.slice(idx + 4), raw });
    };
    const timer = setTimeout(finish, timeout);
    sock.on("connect", () => sock.write(typeof text === "string" ? Buffer.from(text, "latin1") : text));
    sock.on("data", (d) => { chunks.push(d); const raw = Buffer.concat(chunks).toString("latin1"); if (/\r\n\r\n/.test(raw) && /connection: close/i.test(raw) === false) { const cl = raw.match(/content-length: (\d+)/i); const idx = raw.indexOf("\r\n\r\n"); if (cl && raw.length >= idx + 4 + Number(cl[1])) setTimeout(finish, 20); } });
    sock.on("end", finish); sock.on("close", finish); sock.on("error", finish);
  });
}

// ------------------------------------------------------------------ crypto helpers
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(s) {
  const clean = String(s).replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) { const i = B32.indexOf(ch); if (i === -1) throw new Error("bad base32"); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function totp(secretBase32, timeMs = Date.now(), { digits = 6, period = 30 } = {}) {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(timeMs / 1000 / period);
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(buf).digest();
  const off = h[h.length - 1] & 15;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}
function totpStep(timeMs = Date.now()) { return Math.floor(timeMs / 30000); }
/** waits until at least `ms` remain in the current 30-second step so a code computed now is still valid when the request lands */
async function waitForTotpWindow(ms = 6000) { for (;;) { const rem = 30000 - (Date.now() % 30000); if (rem > ms) return; await sleep(rem + 50); } }

function scryptHash(password) { const salt = crypto.randomBytes(16).toString("hex"); return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString("hex")}`; }

const b64u = (b) => Buffer.from(b).toString("base64url");
function hmacHex(secret, payload) { return crypto.createHmac("sha256", String(secret)).update(payload).digest("hex"); }
/** Signs an arbitrary session-style payload with `secret` (the test harness knows the secret it configured). */
function mintToken(secret, claims) { const payload = b64u(JSON.stringify(claims)); return `${payload}.${hmacHex(secret, payload)}`; }
function decodeToken(token) {
  const [p, s] = String(token).split(".");
  try { return { claims: JSON.parse(Buffer.from(p, "base64url").toString("utf8")), signature: s }; } catch { return null; }
}
/** flips one character in the payload segment (keeps the old signature) */
function tamperPayload(token, mutate) {
  const d = decodeToken(token); const claims = mutate({ ...d.claims });
  return `${b64u(JSON.stringify(claims))}.${d.signature}`;
}

// ------------------------------------------------------------------ fixtures
const LOGIN = "/api/lead-agents/admin/session/login";
const P = {
  login: LOGIN,
  me: "/api/lead-agents/admin/session/me",
  logout: "/api/lead-agents/admin/session/logout",
  revokeAll: "/api/lead-agents/admin/session/revoke-all",
  password: "/api/lead-agents/admin/session/password",
  stepUp: "/api/lead-agents/admin/session/step-up",
  stepUpCheck: "/api/lead-agents/admin/session/step-up/check",
  resetRequest: "/api/lead-agents/admin/session/reset/request",
  resetConfirm: "/api/lead-agents/admin/session/reset/confirm",
  inviteAccept: "/api/lead-agents/admin/session/invite/accept",
  users: "/api/lead-agents/admin/users",
  invite: "/api/lead-agents/admin/users/invite",
  audit: "/api/lead-agents/admin/audit",
  settings: "/api/lead-agents/admin/settings",
  mfa: "/api/lead-agents/admin/session/mfa",
  mfaVerify: "/api/lead-agents/admin/session/mfa/verify",
};

async function login(client, email, password, opts = {}) {
  return client.post(LOGIN, { json: { email, password }, ...opts });
}

/** Signs in the bootstrap administrator. Returns { cookie, user, email, password }. */
async function adminSession(client, srv) {
  const r = await login(client, srv.secrets.adminEmail, srv.secrets.adminPassword);
  if (r.status !== 200 || !r.cookie) throw new Blocked(`cannot sign in the bootstrap administrator: ${r.status} ${r.text.slice(0, 200)}`);
  return { cookie: r.cookie, user: r.body.admin, email: srv.secrets.adminEmail, password: srv.secrets.adminPassword };
}

/** Creates an account through the administrator API and signs it in. Returns { id, email, password, role, cookie, res }. */
async function makeUser(client, admin, { role = "ochiga_staff", status = "active", email, password, signIn = true, scopes } = {}) {
  const em = email || `u-${rand(4)}@example.test`; const pw = password || STRONG();
  const r = await client.post(P.users, { cookie: admin.cookie, json: { email: em, password: pw, role, status, ...(scopes ? { permission_scopes: scopes } : {}) } });
  if (r.status !== 201) throw new Blocked(`cannot create fixture user: ${r.status} ${r.text.slice(0, 200)}`);
  const user = { id: r.body.user.id, email: em, password: pw, role, res: r };
  if (signIn && status === "active") {
    const l = await login(client, em, pw);
    if (l.status !== 200) throw new Blocked(`cannot sign in fixture user: ${l.status} ${l.text.slice(0, 200)}`);
    user.cookie = l.cookie; user.loginRes = l;
  }
  return user;
}

/** Obtains a step-up grant for the signed-in super administrator (password only; MFA accounts need `mfa`). */
async function stepUp(client, session, purpose, { password, mfa, cookie } = {}) {
  const r = await client.post(P.stepUp, { cookie: cookie || session.cookie, json: { password: password || session.password, purpose, ...(mfa ? { mfa } : {}) } });
  return { res: r, token: r.body && r.body.step_up && r.body.step_up.token };
}

// ------------------------------------------------------------------ scanning
function findLeaks(text, needles) {
  const found = [];
  for (const [label, needle] of Object.entries(needles)) { if (needle && String(needle).length >= 6 && String(text).includes(String(needle))) found.push(label); }
  return found;
}

/** reads the persisted store of a (stopped or running) instance */
function readStore(srv) { try { return JSON.parse(fs.readFileSync(srv.storePath, "utf8")); } catch { return null; } }

module.exports = {
  SUT, SUT_OLD, COOKIE_NAME, P, Blocked, sleep, rand, short, STRONG,
  createSuite, startServer, freePort, Client, call, rawHttp, parseSetCookies, cookieValue, attrsOf,
  base32Decode, base32Encode, totp, totpStep, waitForTotpWindow, scryptHash,
  mintToken, decodeToken, tamperPayload, hmacHex, b64u,
  login, adminSession, makeUser, stepUp, findLeaks, readStore,
};
