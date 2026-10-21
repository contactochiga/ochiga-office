"use strict";
// Shared helpers for the AREA C corpus (database, service-role boundaries, multi-instance, mixed-version, failures).
// Own code only: nothing is imported from the system under test. The SUT is started as a child process and spoken to over HTTP.
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const net = require("net");
const http = require("http");
const path = require("path");

const SUT = process.env.SUT_DIR || path.resolve(__dirname, "../../..");
const SUT_OLD = process.env.SUT_OLD_DIR || "";
const RUN_ID = crypto.randomBytes(4).toString("hex");
const PG16_IMAGE = "postgres:16-alpine";
const SB_IMAGE = "public.ecr.aws/supabase/postgres:17.6.1.131";
const PGRST_IMAGE = "public.ecr.aws/supabase/postgrest:v14.12";

// ------------------------------------------------------------------ suite harness
class Blocked extends Error {}

class Suite {
  constructor(name, area = "C") {
    this.name = name; this.area = area; this.checks = 0; this.failed = 0; this.failures = []; this.cleanups = []; this.infos = [];
    this.exitHooked = false;
  }
  short(v) { let s; try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); } if (s === undefined) s = "undefined"; return s.length > 500 ? s.slice(0, 500) + "..." : s; }
  check(id, text, ok, evidence) {
    this.checks += 1;
    if (ok) return true;
    this.failed += 1;
    const name = `${id} ${text}`;
    this.failures.push(name);
    console.log(`FAIL ${name}${evidence !== undefined ? " :: " + this.short(evidence) : ""}`);
    return false;
  }
  eq(id, text, actual, expected) {
    return this.check(id, text, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
  }
  info(msg) { this.infos.push(msg); console.log(`INFO ${msg}`); }
  blocked(reason) { throw new Blocked(reason); }
  onCleanup(fn) { this.cleanups.unshift(fn); }
  async section(id, fn) {
    try { await fn(); } catch (e) {
      if (e instanceof Blocked) throw e;
      this.check(`${id}-ERR`, `section ${id} completed without an unexpected exception`, false, String(e && e.stack || e).split("\n").slice(0, 4).join(" | "));
    }
  }
  async main(fn) {
    let code = 0;
    const hardCleanup = () => { try { sweepSync(); } catch { /* best effort */ } };
    process.on("exit", hardCleanup);
    const sig = (s) => () => { console.log(`signal ${s}`); hardCleanup(); process.exit(2); };
    process.on("SIGINT", sig("SIGINT")); process.on("SIGTERM", sig("SIGTERM"));
    process.on("unhandledRejection", (e) => { console.log("unhandledRejection " + (e && e.stack || e)); });
    try { await fn(this); }
    catch (e) {
      code = 2;
      console.log(`BLOCKED: ${e instanceof Blocked ? e.message : "unexpected infrastructure error: " + (e && e.stack || e)}`);
    } finally {
      for (const c of this.cleanups) { try { await c(); } catch (e) { console.log("cleanup error: " + (e && e.message)); } }
      try { sweepSync(); } catch { /* ignore */ }
    }
    console.log(JSON.stringify({ suite: this.name, area: this.area, checks: this.checks, failed: this.failed, failures: this.failures }));
    process.exit(code !== 0 ? code : this.failed === 0 ? 0 : 1);
  }
}

// ------------------------------------------------------------------ resource registry (containers, networks, dirs, processes)
const owned = { containers: new Set(), networks: new Set(), dirs: new Set(), pids: new Set() };
function sweepSync() {
  for (const pid of owned.pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  owned.pids.clear();
  for (const c of owned.containers) spawnSync("docker", ["rm", "-f", c], { stdio: "ignore" });
  owned.containers.clear();
  for (const n of owned.networks) spawnSync("docker", ["network", "rm", n], { stdio: "ignore" });
  owned.networks.clear();
  for (const d of owned.dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  owned.dirs.clear();
}
function tmpDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `s7c-${prefix}-`)); owned.dirs.add(d); return d; }

// ------------------------------------------------------------------ small utilities
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll an explicit readiness condition (never a bare sleep). */
async function waitFor(fn, { timeoutMs = 30000, intervalMs = 100, what = "condition" } = {}) {
  const end = Date.now() + timeoutMs; let last;
  for (;;) {
    try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}: ${last && last.message || last}`);
    await sleepMs(intervalMs);
  }
}
function randomHex(n = 16) { return crypto.randomBytes(n).toString("hex"); }
function sh(cmd, args, opts = {}) { return spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts }); }

const reservedPorts = new Set();
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer(); s.once("error", () => resolve(false));
    s.listen(port, "0.0.0.0", () => s.close(() => resolve(true)));
  });
}
/** A free docker host port in the range reserved for AREA C (55400-55499). */
async function pickDockerPort() {
  for (let i = 0; i < 400; i++) {
    const p = 55400 + crypto.randomInt(0, 100);
    if (reservedPorts.has(p)) continue;
    if (!(await portFree(p))) continue;
    // docker may already publish it (checked with docker as well, since a wildcard bind can mask)
    const ps = sh("docker", ["ps", "--format", "{{.Ports}}"]).stdout || "";
    if (ps.includes(`:${p}->`)) continue;
    reservedPorts.add(p); return p;
  }
  throw new Blocked("no free docker port in 55400-55499");
}
async function pickEphemeralPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ------------------------------------------------------------------ crypto helpers written for this corpus
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  while (out.length % 8) out += "=";
  return out;
}
function base32Decode(str) {
  const s = String(str).replace(/=+$/, "").replace(/[\s-]/g, "").toUpperCase();
  let bits = 0, value = 0; const out = [];
  for (const ch of s) { const i = B32.indexOf(ch); if (i < 0) throw new Error("bad base32"); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secret, counter, digits = 6) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", secret).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}
const totpStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / 30);
const totpAt = (secretB32, step) => hotp(base32Decode(secretB32), step);
/** Hands out TOTP codes that are strictly newer than any step already used for this secret; waits (on the clock) for the next step when the +/-1 window is exhausted. */
class TotpSource {
  constructor(secretB32, usedStep = 0) { this.secret = secretB32; this.used = usedStep; }
  async next() {
    const lo = () => Math.max(this.used + 1, totpStep() - 1);
    if (lo() > totpStep() + 1) await waitFor(() => totpStep() + 1 >= lo(), { timeoutMs: 70000, intervalMs: 250, what: "next TOTP step" });
    const step = lo(); this.used = step;
    return { code: totpAt(this.secret, step), step };
  }
  /** A code for a step already used (replay probe). */
  replay() { return totpAt(this.secret, this.used); }
}
function scryptHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString("hex")}`;
}
const b64u = (b) => Buffer.from(b).toString("base64url");
function jwtSign(secret, claims, header = { alg: "HS256", typ: "JWT" }) {
  const p = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  return `${p}.${crypto.createHmac("sha256", secret).update(p).digest("base64url")}`;
}
const nowSec = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ psql sessions (one process = one database connection)
class PsqlSession {
  constructor(container, { user = "postgres", db = "postgres" } = {}) {
    this.container = container; this.user = user; this.db = db; this.buf = ""; this.waiters = []; this.seq = 0; this.closed = false;
    this.proc = spawn("docker", ["exec", "-i", container, "sh", "-c", `exec psql -X -q -At -F '\t' -v ON_ERROR_STOP=0 -U ${user} -d ${db} 2>&1`], { stdio: ["pipe", "pipe", "ignore"] });
    owned.pids.add(this.proc.pid);
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => { this.buf += d; this.pump(); });
    this.proc.on("exit", () => { this.closed = true; owned.pids.delete(this.proc.pid); for (const w of this.waiters.splice(0)) w.reject(new Error("psql exited")); });
    this.proc.stdin.on("error", () => {});
    this.proc.stdin.write("\\set VERBOSITY verbose\n\\set SHOW_CONTEXT never\nset client_min_messages = warning;\n");
  }
  pump() {
    for (;;) {
      const w = this.waiters[0]; if (!w) return;
      const idx = this.buf.indexOf(`@@END${w.id}\n`);
      if (idx < 0) return;
      const chunk = this.buf.slice(0, idx); this.buf = this.buf.slice(idx + `@@END${w.id}\n`.length);
      this.waiters.shift(); w.resolve(chunk);
    }
  }
  /** Fire a script without waiting; returns a promise for its raw output. */
  send(sql) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiters.push({ id, resolve, reject });
      this.proc.stdin.write(`${sql}\n;\n\\echo @@END${id}\n`);
    });
  }
  static parse(raw) {
    const rows = []; let error = null; const diag = [];
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      const m = /^(ERROR|FATAL|PANIC):\s+(?:([0-9A-Z]{5}):\s+)?(.*)$/.exec(line);
      if (m) { if (!error) error = { code: m[2] || "", message: m[3] }; continue; }
      if (/^(DETAIL|HINT|LOCATION|CONTEXT|STATEMENT|WARNING|NOTICE|QUERY):/.test(line)) { diag.push(line); continue; }
      rows.push(line.split("\t"));
    }
    return { rows, error, diag, raw };
  }
  async query(sql) { return PsqlSession.parse(await this.send(sql)); }
  /** rows of a select as parsed JSON objects */
  async json(select) {
    const r = await this.query(`select coalesce(jsonb_agg(t), '[]'::jsonb) from (${select.replace(/;\s*$/, "")}) t`);
    if (r.error) throw new Error(`sql error: ${r.error.message}`);
    return JSON.parse(r.rows[0][0]);
  }
  async scalar(select) { const r = await this.query(select); if (r.error) throw new Error(`sql error: ${r.error.message}`); return r.rows[0] ? r.rows[0][0] : null; }
  async close() { if (this.closed) return; try { this.proc.stdin.end("\\q\n"); } catch { /* ignore */ } await Promise.race([new Promise((r) => this.proc.once("exit", r)), sleepMs(3000)]); try { this.proc.kill("SIGKILL"); } catch { /* ignore */ } }
}

// ------------------------------------------------------------------ database stack (plain Postgres 16 or Supabase Postgres 17 + PostgREST)
const BASE_SCHEMA = () => path.join(SUT, "db", "lead-agents-schema.sql");
const dbFiles = () => fs.readdirSync(path.join(SUT, "db")).filter((f) => /^2026\d+.*\.sql$/.test(f)).sort();
const AUTH_MIGRATIONS = ["20261014_office_runtime_settings.sql", "20261019_office_runtime_settings_versioning.sql", "20261020_admin_session_generation.sql", "20261021_admin_atomic_account_updates.sql", "20261022_admin_mfa_foundation.sql", "20261023_admin_mfa_recovery_code_key_id.sql", "20261024_admin_mfa_management.sql", "20261025_admin_mfa_webauthn.sql", "20261026_admin_revoked_sessions.sql"];
const rollbackFile = (mig) => path.join(SUT, "db", "rollback", mig.replace(/\.sql$/, ".down.sql"));

function dockerOk() {
  const r = sh("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 30000 });
  return r.status === 0 && r.stdout.trim();
}
function requireImages(...images) {
  if (!dockerOk()) throw new Blocked("docker is not available");
  for (const i of images) if (sh("docker", ["image", "inspect", i]).status !== 0) throw new Blocked(`docker image missing: ${i}`);
}

class DbStack {
  constructor(opts) { Object.assign(this, opts); this.sessions = []; this.counter = 0; }
  static async create({ kind = "supabase17", tag = "db", postgrest = false, suite } = {}) {
    const image = kind === "plain16" ? PG16_IMAGE : SB_IMAGE;
    requireImages(image, ...(postgrest ? [PGRST_IMAGE] : []));
    const s = new DbStack({ kind, tag, image, suite });
    s.id = `${tag}-${RUN_ID}-${randomHex(2)}`;
    s.net = `s7c-net-${s.id}`; s.container = `s7c-pg-${s.id}`; s.password = `pw_${randomHex(12)}`;
    s.jwtSecret = randomHex(24); // 48 characters
    let r = sh("docker", ["network", "create", s.net]); if (r.status !== 0) throw new Blocked("cannot create docker network: " + r.stderr);
    owned.networks.add(s.net);
    r = sh("docker", ["run", "-d", "--rm", "--name", s.container, "--label", `s7c-run=${RUN_ID}`, "--network", s.net, "--network-alias", "pg", "-e", `POSTGRES_PASSWORD=${s.password}`, image]);
    if (r.status !== 0) throw new Blocked("cannot start postgres container: " + r.stderr);
    owned.containers.add(s.container);
    suite && suite.onCleanup(() => s.destroy());
    await s.waitReady();
    if (postgrest) await s.startPostgrest();
    return s;
  }
  async waitReady() {
    let good = 0;
    await waitFor(() => {
      const r = sh("docker", ["exec", this.container, "psql", "-X", "-At", "-U", "postgres", "-d", "postgres", "-h", "127.0.0.1", "-c", this.kind === "supabase17" ? "select count(*) from pg_roles where rolname in ('anon','authenticated','service_role','authenticator')" : "select 1"]);
      const ok = r.status === 0 && r.stdout.trim() === (this.kind === "supabase17" ? "4" : "1");
      good = ok ? good + 1 : 0; return good >= 3;
    }, { timeoutMs: 120000, intervalMs: 300, what: "postgres readiness" });
  }
  session(opts) { const s = new PsqlSession(this.container, opts); this.sessions.push(s); return s; }
  /** Run SQL text through psql once (stdin). Returns {status, out}. onErrorStop false = keep going past errors. */
  run(sql, { user = "postgres", db = "postgres", onErrorStop = true } = {}) {
    const r = sh("docker", ["exec", "-i", this.container, "psql", "-X", "-q", "-U", user, "-d", db, "-v", `ON_ERROR_STOP=${onErrorStop ? 1 : 0}`], { input: sql });
    return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), stderr: r.stderr || "", stdout: r.stdout || "" };
  }
  applyFile(file, opts) { return this.run(fs.readFileSync(file, "utf8"), opts); }
  /** scalar query in a given database through a one-shot psql */
  one(sql, { user = "postgres", db = "postgres" } = {}) {
    const r = sh("docker", ["exec", this.container, "psql", "-X", "-At", "-U", user, "-d", db, "-c", sql]);
    return { status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
  }
  /** The bootstrap schema contains a forward reference on an empty database (see README), so it is applied twice; the second pass must be clean. */
  applyBase(opts = {}) {
    const first = this.applyFile(BASE_SCHEMA(), { onErrorStop: false, ...opts });
    const second = this.applyFile(BASE_SCHEMA(), { onErrorStop: false, ...opts });
    return { first, second, firstErrors: (first.out.match(/ERROR:/g) || []).length, secondErrors: (second.out.match(/ERROR:/g) || []).length };
  }
  applyMigrations(list = dbFiles(), opts = {}) {
    const results = [];
    for (const f of list) { const r = this.applyFile(path.join(SUT, "db", f), opts); results.push({ file: f, status: r.status, out: r.out }); if (r.status !== 0) break; }
    return results;
  }
  /** Full fixture: base schema (two passes) then every dated migration in order. */
  applyAll() {
    const base = this.applyBase(); const migs = this.applyMigrations(dbFiles());
    const bad = migs.find((m) => m.status !== 0);
    if (bad) throw new Blocked(`fixture migration failed: ${bad.file}: ${bad.out.slice(0, 300)}`);
    return { base, migs };
  }
  applyRollback(mig, opts) { return this.applyFile(rollbackFile(mig), opts); }
  async startPostgrest() {
    // the image creates the role without a usable password for TCP; the fixture sets one (a disposable container)
    const pr = sh("docker", ["exec", this.container, "psql", "-X", "-At", "-U", "supabase_admin", "-d", "postgres", "-h", "127.0.0.1", "-c", `alter role authenticator with password '${this.password}'`]);
    if (pr.status !== 0) throw new Blocked("cannot set the authenticator password: " + pr.stderr);
    const port = await pickDockerPort();
    this.pgrstPort = port; this.pgrstName = `s7c-rest-${this.id}`;
    const env = ["-e", `PGRST_DB_URI=postgres://authenticator:${this.password}@pg:5432/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${this.jwtSecret}`, "-e", "PGRST_SERVER_HOST=0.0.0.0", "-e", "PGRST_SERVER_PORT=3000", "-e", "PGRST_DB_POOL=10"];
    const r = sh("docker", ["run", "-d", "--rm", "--name", this.pgrstName, "--label", `s7c-run=${RUN_ID}`, "--network", this.net, "-p", `127.0.0.1:${port}:3000`, ...env, PGRST_IMAGE]);
    if (r.status !== 0) throw new Blocked("cannot start postgrest: " + r.stderr);
    owned.containers.add(this.pgrstName);
    this.url = `http://127.0.0.1:${port}`;
    await waitFor(async () => { const res = await fetch(this.url + "/", { headers: { authorization: `Bearer ${this.jwt("service_role")}` } }).catch(() => null); return res && res.status === 200; }, { timeoutMs: 60000, intervalMs: 300, what: "postgrest readiness" });
  }
  stopPostgrest() { sh("docker", ["rm", "-f", this.pgrstName]); owned.containers.delete(this.pgrstName); }
  jwt(role, extra = {}) { return jwtSign(this.jwtSecret, { role, iss: "s7c", iat: nowSec(), exp: nowSec() + 7200, ...extra }); }
  /** After DDL: notify PostgREST and wait until its schema cache answers consistently (three consecutive good probes). */
  async settle(extraProbe) {
    const c = this.session(); await c.query("notify pgrst, 'reload schema'"); await c.close();
    let good = 0;
    await waitFor(async () => {
      const r = await this.rest("service_role", "GET", "/admin_users?limit=0");
      let ok = r.status === 200;
      if (ok && extraProbe) ok = Boolean(await extraProbe());
      good = ok ? good + 1 : 0; return good >= 3;
    }, { timeoutMs: 60000, intervalMs: 250, what: "postgrest schema cache to settle" });
  }
  /** Ask PostgREST to reload its schema cache and wait until probe() is true. */
  async reloadSchema(probe) {
    const c = this.session(); await c.query("notify pgrst, 'reload schema'"); await c.close();
    if (probe) await waitFor(probe, { timeoutMs: 30000, intervalMs: 200, what: "postgrest schema cache reload" });
  }
  /** REST helper against PostgREST. */
  async rest(role, method, pathAndQuery, { body, headers = {}, token } = {}) {
    const h = { "content-type": "application/json", ...headers };
    const t = token !== undefined ? token : role ? this.jwt(role) : null;
    if (t) h.authorization = `Bearer ${t}`;
    let res;
    try { res = await fetch(this.url + pathAndQuery, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }); }
    catch (e) { return { status: 0, error: String(e), json: null, text: "" }; }
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  rpc(role, name, args = {}, opts = {}) { return this.rest(role, "POST", `/rpc/${name}`, { body: args, ...opts }); }
  logs() { const r = sh("docker", ["logs", this.container]); return (r.stdout || "") + (r.stderr || ""); }
  async destroy() {
    for (const s of this.sessions) await s.close().catch(() => {});
    if (this.pgrstName) { sh("docker", ["rm", "-f", this.pgrstName]); owned.containers.delete(this.pgrstName); }
    sh("docker", ["rm", "-f", this.container]); owned.containers.delete(this.container);
    sh("docker", ["network", "rm", this.net]); owned.networks.delete(this.net);
  }
}

/** Run `perSession(i)` (a SQL script) in n separate connections, started together behind an advisory-lock barrier. Returns the parsed result of each. */
async function barrierRun(stack, n, perSession, { user = "postgres", key = 700000 + crypto.randomInt(0, 90000) } = {}) {
  const ctl = stack.session({ user });
  await ctl.scalar(`select pg_advisory_lock(${key})`);
  const workers = await Promise.all(Array.from({ length: n }, async () => { const w = stack.session({ user }); await w.query("select 1"); return w; }));
  const pending = workers.map((w, i) => w.send(`select pg_advisory_lock_shared(${key});\n\\echo @@GO\n${perSession(i)}\n;\nselect pg_advisory_unlock_shared(${key});`));
  await waitFor(async () => Number(await ctl.scalar(`select count(*) from pg_locks where locktype='advisory' and not granted and objid=${key}`)) >= n, { timeoutMs: 60000, intervalMs: 50, what: "all workers waiting on the barrier" });
  await ctl.query(`select pg_advisory_unlock(${key})`);
  const raws = await Promise.all(pending);
  await Promise.all(workers.map((w) => w.close())); await ctl.close();
  return raws.map((raw) => PsqlSession.parse(raw.slice(raw.indexOf("@@GO\n") + 5)));
}

// ------------------------------------------------------------------ controllable HTTP fault proxy placed between the application and PostgREST
class FaultProxy {
  constructor(targetUrl) { this.target = new URL(targetUrl); this.mode = "pass"; this.rules = []; this.captured = []; this.sockets = new Set(); this.hung = new Set(); this.port = 0; this.server = null; this.capture = true; }
  async start() { this.port = this.port || await pickEphemeralPort(); await this.listen(); return this; }
  listen() {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this.handle(req, res));
      srv.on("connection", (s) => { this.sockets.add(s); s.on("close", () => this.sockets.delete(s)); });
      srv.once("error", reject);
      srv.listen(this.port, "127.0.0.1", () => { this.server = srv; resolve(); });
    });
  }
  get url() { return `http://127.0.0.1:${this.port}`; }
  async setMode(mode) {
    const prev = this.mode; this.mode = mode;
    if (mode === "down") await this.closeListener();
    else if (prev === "down") await waitFor(async () => { try { await this.listen(); return true; } catch { return false; } }, { timeoutMs: 10000, intervalMs: 100, what: "proxy relisten" });
  }
  closeListener() {
    return new Promise((resolve) => {
      for (const s of this.sockets) s.destroy();
      for (const r of this.hung) { try { r.destroy(); } catch { /* ignore */ } }
      if (!this.server) return resolve();
      const srv = this.server; this.server = null; srv.close(() => resolve());
    });
  }
  async stop() { await this.closeListener(); }
  handle(req, res) {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const rec = { method: req.method, url: req.url, headers: req.headers, body: body.toString("utf8"), at: Date.now() };
      if (this.capture) this.captured.push(rec);
      let action = this.mode; let fn = null;
      for (const rule of this.rules) { if (rule.match(rec)) { action = rule.action; fn = rule.fn; if (rule.times !== undefined && --rule.times <= 0) this.rules.splice(this.rules.indexOf(rule), 1); break; } }
      this.act(action, fn, req, res, body, rec);
    });
  }
  act(action, fn, req, res, body, rec) {
    if (typeof action === "function") return action(req, res, rec);
    if (action === "reset") return req.socket.destroy();
    if (action === "hang") { this.hung.add(res); res.on("close", () => this.hung.delete(res)); return; }
    if (action === "500leak") { res.writeHead(500, { "content-type": "application/json" }); return res.end(JSON.stringify({ code: "XX000", message: 'connection to server at "pg" (172.20.0.2), port 5432 failed: FATAL: password authentication failed for user "authenticator"', details: "postgres://authenticator:SECRETPW@pg:5432/postgres" })); }
    if (action === "502") { res.writeHead(502, { "content-type": "text/html" }); return res.end("<html>Bad Gateway nginx/1.25 upstream 10.0.0.5:3000</html>"); }
    if (action === "garbage") { res.writeHead(200, { "content-type": "application/json" }); return res.end("<<<not json>>>"); }
    if (action === "emptyobj") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
    if (action === "emptylist") { res.writeHead(200, { "content-type": "application/json" }); return res.end("[]"); }
    if (action === "missing") { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ code: "PGRST202", details: null, hint: null, message: "Could not find the function in the schema cache" })); }
    if (action === "missing-table") { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ code: "PGRST205", details: null, hint: null, message: "Could not find the table in the schema cache" })); }
    if (action === "forbidden") { res.writeHead(403, { "content-type": "application/json" }); return res.end(JSON.stringify({ code: "42501", message: "permission denied for function" })); }
    if (action === "noauth") { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ code: "PGRST301", message: "JWT expired" })); }
    // default: forward
    // the proxy plays the part of the Supabase gateway: it strips the /rest/v1 prefix before PostgREST
    const up = http.request({ host: this.target.hostname, port: this.target.port, method: req.method, path: req.url.replace(/^\/rest\/v1/, ""), headers: { ...req.headers, host: this.target.host } }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers); ur.pipe(res);
    });
    up.on("error", () => { try { res.writeHead(502); res.end("upstream error"); } catch { /* ignore */ } });
    up.end(body);
  }
  rule(match, action, times) { const r = { match, action, times }; this.rules.push(r); return r; }
  clearRules() { this.rules.length = 0; }
  clearCaptured() { this.captured.length = 0; }
  count(pred) { return this.captured.filter(pred).length; }
}

// ------------------------------------------------------------------ the application under test, as a child process
const SYMLINK_SKIP = new Set(["data", "node_modules_cache"]);
class AppServer {
  /** env: extra environment. sut: directory of the release to run. */
  static async start({ sut = SUT, env = {}, name = "app", suite, port } = {}) {
    const a = new AppServer(); a.name = name; a.sut = sut; a.env = env; a.logs = []; a.suite = suite;
    a.dir = tmpDir(name);
    for (const e of fs.readdirSync(sut)) {
      if (e.startsWith(".") || SYMLINK_SKIP.has(e)) continue;
      fs.symlinkSync(path.join(sut, e), path.join(a.dir, e));
    }
    a.port = port || await pickEphemeralPort(); a.url = `http://127.0.0.1:${a.port}`;
    suite && suite.onCleanup(() => a.stop());
    await a.spawn();
    return a;
  }
  async spawn() {
    const full = {
      PATH: process.env.PATH, HOME: this.dir, TMPDIR: this.dir,
      OPENAI_API_KEY: "sk-fixture-not-real", OPENAI_BASE_URL: "http://127.0.0.1:9/v1", LEAD_AGENTS_HOST: "127.0.0.1", LEAD_AGENTS_PORT: String(this.port),
      LEAD_AGENTS_STORE_PATH: path.join(this.dir, "store.json"), OFFICE_STORAGE_DIR: path.join(this.dir, "storage"),
      LEAD_AGENTS_RATE_LIMIT_MAX_REQUESTS: "100000", LEAD_AGENTS_OFFICE_RATE_LIMIT_MAX_REQUESTS: "100000", LEAD_AGENTS_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "1000",
      LEAD_AGENTS_ALLOWED_ORIGINS: "http://localhost:3000", LEAD_AGENTS_REQUEST_TIMEOUT_MS: "8000",
      ...this.env,
    };
    this.proc = spawn(process.execPath, ["lead-agents-server.js"], { cwd: this.dir, env: full, stdio: ["ignore", "pipe", "pipe"] });
    owned.pids.add(this.proc.pid);
    this.exited = new Promise((r) => this.proc.on("exit", (c, s) => { this.exitCode = c; this.exitSignal = s; owned.pids.delete(this.proc.pid); r(); }));
    const onData = (d) => { for (const l of String(d).split("\n")) if (l) this.logs.push(l); };
    this.proc.stdout.on("data", onData); this.proc.stderr.on("data", onData);
    await waitFor(async () => { if (this.exitCode !== undefined) throw new Blocked(`${this.name} exited during start (code ${this.exitCode}): ${this.logs.slice(-5).join(" | ")}`); const r = await fetch(this.url + "/healthz").catch(() => null); return r && r.status > 0; }, { timeoutMs: 60000, intervalMs: 150, what: `${this.name} to listen` });
  }
  async stop() {
    if (!this.proc || this.exitCode !== undefined || this.exitSignal) return;
    this.proc.kill("SIGTERM");
    await Promise.race([this.exited, sleepMs(5000)]);
    if (this.exitCode === undefined && !this.exitSignal) { try { this.proc.kill("SIGKILL"); } catch { /* ignore */ } await Promise.race([this.exited, sleepMs(2000)]); }
  }
  async restart() { await this.stop(); this.logs.length = 0; this.exitCode = undefined; this.exitSignal = undefined; await this.spawn(); }
  logText() { return this.logs.join("\n"); }
}

// ------------------------------------------------------------------ HTTP client with a tiny cookie jar
const COOKIE = "lead_agents_admin";
class Client {
  constructor(baseUrl, { ip } = {}) { this.base = baseUrl; this.ip = ip; this.cookie = ""; }
  static cookieFrom(res) {
    const sc = res.headers && res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) { const m = new RegExp(`^${COOKIE}=([^;]*)`).exec(c); if (m) return m[1] === "" ? "" : `${COOKIE}=${m[1]}`; }
    return null;
  }
  async req(method, p, { json, headers = {}, cookie, raw, ip, timeoutMs = 30000 } = {}) {
    const h = { ...headers };
    const ck = cookie !== undefined ? cookie : this.cookie;
    if (ck) h.cookie = ck;
    const xip = ip || this.ip; if (xip) h["x-forwarded-for"] = xip;
    let body; if (json !== undefined) { body = JSON.stringify(json); h["content-type"] = "application/json"; } else if (raw !== undefined) body = raw;
    const started = Date.now();
    let res;
    try { res = await fetch(this.base + p, { method, headers: h, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { return { status: 0, error: String(e), json: null, text: "", ms: Date.now() - started, headers: new Headers(), setCookie: null }; }
    const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json: j, text, headers: res.headers, setCookie: Client.cookieFrom(res), ms: Date.now() - started, rawSetCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [] };
  }
  get(p, o) { return this.req("GET", p, o); }
  post(p, json, o) { return this.req("POST", p, { json: json === undefined ? {} : json, ...o }); }
  put(p, json, o) { return this.req("PUT", p, { json, ...o }); }
  /** Sign in; on success stores and returns the cookie. */
  async login(email, password, o = {}) {
    const r = await this.post("/api/lead-agents/admin/session/login", { email, password }, o);
    if (r.status === 200 && r.json && r.json.ok === true && r.setCookie) { if (!o.keep) this.cookie = r.setCookie; r.cookie = r.setCookie; }
    return r;
  }
  me(o) { return this.get("/api/lead-agents/admin/session/me", o); }
  logout(o) { return this.post("/api/lead-agents/admin/session/logout", {}, o); }
  async stepUp(password, purpose = "mfa_management", mfa, o = {}) {
    const r = await this.post("/api/lead-agents/admin/session/step-up", { purpose, password, ...(mfa ? { mfa } : {}) }, o);
    r.token = r.json && r.json.step_up && r.json.step_up.token; return r;
  }
}
const P = "/api/lead-agents/admin";

// ------------------------------------------------------------------ account fixtures
let userSeq = 0;
function uuidv4() { return crypto.randomUUID(); }
/** Insert an account directly (service/superuser) with a scrypt hash this corpus computed. Returns {id,email,password}. */
async function seedUser(sess, { email, password, role = "viewer", status = "active", scopes = [], id } = {}) {
  userSeq += 1;
  const e = email || `u${userSeq}-${randomHex(3)}@fixture.test`; const pw = password || `Pw!${randomHex(8)}Aa1`; const uid = id || uuidv4();
  const scopeSql = scopes.length ? `array[${scopes.map((s) => `'${s}'`).join(",")}]::text[]` : "'{}'::text[]";
  const r = await sess.query(`insert into admin_users (id, email, password_hash, role, status, display_name, permission_scopes) values ('${uid}', '${e}', '${scryptHash(pw)}', '${role}', '${status}', 'Fixture ${userSeq}', ${scopeSql})`);
  if (r.error) throw new Error("seedUser: " + r.error.message);
  return { id: uid, email: e, password: pw, role };
}

const MFA_KEY_A = crypto.randomBytes(32).toString("base64");
const MFA_KEY_B = crypto.randomBytes(32).toString("base64");
const SESSION_SECRET = () => `sess_${randomHex(24)}`;
const API_KEY = () => `apikey_${randomHex(16)}`;
/** Environment for an application instance talking to a Supabase-style REST URL. */
function appEnv({ restUrl, serviceJwt, sessionSecret, mfa = true, mfaKey = MFA_KEY_A, apiKey, bootstrap, extra = {} }) {
  return {
    LEAD_AGENTS_STORE_DRIVER: "supabase", SUPABASE_URL: restUrl, SUPABASE_SERVICE_ROLE_KEY: serviceJwt,
    LEAD_AGENTS_AUTH_MODE: "required_api_key", LEAD_AGENTS_API_KEYS: apiKey || API_KEY(), LEAD_AGENTS_SESSION_SECRET: sessionSecret,
    ...(bootstrap ? { LEAD_AGENTS_ADMIN_EMAIL: bootstrap.email, LEAD_AGENTS_ADMIN_PASSWORD: bootstrap.password, LEAD_AGENTS_ADMIN_ROLE: bootstrap.role || "super_admin" } : {}),
    ...(mfa ? { LEAD_AGENTS_MFA: "on", LEAD_AGENTS_MFA_KEY: mfaKey, LEAD_AGENTS_MFA_KEY_ID: "k1" } : {}),
    OFFICE_APP_URL: "http://localhost:3000",
    ...extra,
  };
}

/** Enrol a TOTP factor through the real routes. client must hold a session cookie. Returns { secret, credentialId, recoveryCodes, totp, cookie }. */
async function enrollTotp(client, password) {
  const su = await client.stepUp(password, "mfa_management");
  if (su.status !== 200) throw new Error("enrol step-up failed: " + su.status + " " + su.text);
  const h = { "x-step-up-token": su.token };
  const b = await client.post(`${P}/session/mfa/enroll/totp/begin`, {}, { headers: h });
  if (b.status !== 200) throw new Error("enrol begin failed: " + b.status + " " + b.text);
  const totp = new TotpSource(b.json.secret_base32);
  const { code } = await totp.next();
  const c = await client.post(`${P}/session/mfa/enroll/totp/confirm`, { credential_id: b.json.credential_id, code }, { headers: h });
  if (c.status !== 200) throw new Error("enrol confirm failed: " + c.status + " " + c.text);
  if (c.setCookie) client.cookie = c.setCookie;
  return { secret: b.json.secret_base32, credentialId: b.json.credential_id, recoveryCodes: c.json.recovery_codes || [], totp, confirm: c };
}
/** Full MFA sign-in (password then TOTP). Returns { login, verify, cookie }. */
async function loginMfa(client, email, password, totp, o = {}) {
  const l = await client.post(`${P}/session/login`, { email, password }, o);
  if (!(l.json && l.json.mfa_required)) return { login: l, verify: null, cookie: l.setCookie };
  const { code } = await totp.next();
  const v = await client.post(`${P}/session/mfa/verify`, { challenge_token: l.json.challenge_token, method: "totp", code }, o);
  if (v.status === 200 && v.setCookie && !o.keep) client.cookie = v.setCookie;
  return { login: l, verify: v, cookie: v.setCookie };
}

/** Does any text contain internal detail that must never reach a client? */
const LEAK_PATTERNS = [/ECONNREFUSED/i, /ECONNRESET/i, /ETIMEDOUT/i, /ENOTFOUND/i, /EAI_AGAIN/i, /socket hang up/i, /\b127\.0\.0\.1\b/, /localhost:\d{2,5}/i, /\b\d{1,3}(\.\d{1,3}){3}:\d{2,5}\b/, /postgres(ql)?:\/\//i, /PGRST\d+/, /axios/i, /Request failed with status code/i, /rest\/v1/i, /supabase/i, /\bat\s+\S+\s+\(.*:\d+:\d+\)/, /node_modules/, /SQLSTATE|syntax error at|relation ".*" does not exist|violates .* constraint|permission denied for/i, /password authentication failed/i];
function leaks(text) { const t = String(text || ""); return LEAK_PATTERNS.filter((re) => re.test(t)).map(String); }

/** The ERROR/DETAIL lines of psql output (for evidence). */
function errLines(out) { return String(out || "").split("\n").filter((l) => /^(ERROR|DETAIL|FATAL):/.test(l)).join(" | ").slice(0, 400); }

module.exports = {
  errLines,
  SUT, SUT_OLD, RUN_ID, Suite, Blocked, owned, sweepSync, tmpDir, sleepMs, waitFor, randomHex, sh, pickDockerPort, pickEphemeralPort,
  base32Encode, base32Decode, hotp, totpStep, totpAt, TotpSource, scryptHash, jwtSign, nowSec,
  PsqlSession, DbStack, barrierRun, FaultProxy, AppServer, Client, P, COOKIE,
  seedUser, appEnv, SESSION_SECRET, API_KEY, MFA_KEY_A, MFA_KEY_B, enrollTotp, loginMfa, leaks, LEAK_PATTERNS,
  AUTH_MIGRATIONS, dbFiles, rollbackFile, BASE_SCHEMA, requireImages, dockerOk, PG16_IMAGE, SB_IMAGE, PGRST_IMAGE, uuidv4,
};
