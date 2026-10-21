"use strict";
// Disposable Postgres (Supabase image) + PostgREST + fault-injecting proxy for the Area A database suites.
// Containers and the network are uniquely named, never touch anything else, and are removed in cleanup.
// The proxy maps /rest/v1/* to PostgREST and can inject faults (all requests or only matching ones).
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const L = require("./a-lib");

const DB_IMAGE = "public.ecr.aws/supabase/postgres:17.6.1.131";
const REST_IMAGE = "public.ecr.aws/supabase/postgrest:v14.12";

function docker(args, { input, allowFail = false, timeout = 120000 } = {}) {
  const r = spawnSync("docker", args, { input, encoding: "utf8", timeout });
  if (r.status !== 0 && !allowFail) throw new L.Blocked(`docker ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout || "").slice(0, 300)}`);
  return r;
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(secret, claims) { const h = b64({ alg: "HS256", typ: "JWT" }), p = b64(claims); return `${h}.${p}.${crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`; }

async function startPg(suite, { sutDir = L.SUT } = {}) {
  if (docker(["version", "--format", "{{.Server.Version}}"], { allowFail: true }).status !== 0) throw new L.Blocked("docker is not available");
  for (const img of [DB_IMAGE, REST_IMAGE]) if (docker(["image", "inspect", img], { allowFail: true }).status !== 0) throw new L.Blocked(`docker image missing: ${img}`);
  const id = `a-pg-${process.pid}-${L.rand(3)}`;
  const jwtSecret = L.rand(32);
  const pgPassword = L.rand(12);
  const state = { id, alive: true, restUp: true, mode: null };
  const cleanup = () => {
    if (!state.alive) return; state.alive = false;
    try { proxy.close(); } catch { /* ignore */ }
    docker(["rm", "-f", `${id}-rest`, `${id}-db`], { allowFail: true });
    docker(["network", "rm", `${id}-net`], { allowFail: true });
  };
  suite.onCleanup(cleanup);
  process.on("exit", cleanup);
  docker(["network", "create", `${id}-net`]);
  docker(["run", "-d", "--name", `${id}-db`, "--network", `${id}-net`, "-e", `POSTGRES_PASSWORD=${pgPassword}`, DB_IMAGE]);
  // readiness: two consecutive successful queries as the admin role (the image restarts its server once during initialisation)
  let okCount = 0; const dl = Date.now() + 120000;
  while (Date.now() < dl && okCount < 3) {
    const r = docker(["exec", `${id}-db`, "psql", "-U", "supabase_admin", "-d", "postgres", "-tAc", "select count(*) from pg_roles where rolname in ('anon','authenticated','service_role','authenticator')"], { allowFail: true });
    if (r.status === 0 && r.stdout.trim() === "4") okCount++; else okCount = 0;
    await L.sleep(1000);
  }
  if (okCount < 3) throw new L.Blocked("database did not become ready");
  const psqlFile = (file) => docker(["exec", "-i", `${id}-db`, "psql", "-U", "postgres", "-q", "-f", "-"], { input: fs.readFileSync(file, "utf8"), allowFail: true });
  const dbDir = path.join(sutDir, "db");
  psqlFile(path.join(dbDir, "lead-agents-schema.sql")); psqlFile(path.join(dbDir, "lead-agents-schema.sql")); // the base file has a forward reference; the second pass completes it
  for (const f of fs.readdirSync(dbDir).filter((x) => /^2026.*\.sql$/.test(x)).sort()) {
    const r = psqlFile(path.join(dbDir, f));
    if (/ERROR/.test(r.stderr || "") ) throw new L.Blocked(`migration ${f} failed: ${(r.stderr || "").slice(0, 300)}`);
  }
  docker(["exec", `${id}-db`, "psql", "-U", "supabase_admin", "-d", "postgres", "-c", `alter role authenticator with password '${pgPassword}'`]);
  const startRest = () => {
    docker(["rm", "-f", `${id}-rest`], { allowFail: true });
    docker(["run", "-d", "--name", `${id}-rest`, "--network", `${id}-net`, "-p", "127.0.0.1::3000", "-e", `PGRST_DB_URI=postgres://authenticator:${pgPassword}@${id}-db:5432/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${jwtSecret}`, "-e", "PGRST_SERVER_PORT=3000", REST_IMAGE]);
    const out = docker(["port", `${id}-rest`, "3000/tcp"]).stdout.split("\n")[0];
    state.restPort = Number(out.split(":").pop());
    state.restUp = true;
  };
  startRest();
  const key = jwt(jwtSecret, { role: "service_role", iss: "supabase", exp: 4102444800 });
  const anonKey = jwt(jwtSecret, { role: "anon", iss: "supabase", exp: 4102444800 });
  const authKey = jwt(jwtSecret, { role: "authenticated", iss: "supabase", sub: crypto.randomUUID(), exp: 4102444800 });
  const rawRest = async (p, o = {}) => fetch(`http://127.0.0.1:${state.restPort}${p}`, { ...o, signal: AbortSignal.timeout(5000) });
  const dl2 = Date.now() + 60000; let ready = false;
  while (Date.now() < dl2) { try { const r = await rawRest("/admin_users?select=id&limit=1", { headers: { apikey: key, authorization: `Bearer ${key}` } }); if (r.status === 200) { ready = true; break; } } catch { /* retry */ } await L.sleep(500); }
  if (!ready) throw new L.Blocked("PostgREST did not become ready");

  // ---- fault-injecting proxy: /rest/v1/* -> PostgREST /*
  const stats = { requests: 0, faults: 0, seen: [] };
  const agent = new http.Agent({ keepAlive: true, maxSockets: 24 });
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      stats.requests++;
      const bodyBuf = Buffer.concat(chunks);
      const url = req.url.replace(/^\/rest\/v1/, "") || "/";
      const mode = state.mode;
      const matches = !mode || !mode.match || mode.match(req.method, url, bodyBuf.toString("utf8"));
      stats.seen.push(`${req.method} ${url.split("?")[0]}`); if (stats.seen.length > 400) stats.seen.shift();
      if (mode && matches && mode.kind !== "pass") {
        stats.faults++;
        if (mode.kind === "status") { res.writeHead(mode.status, { "content-type": "application/json" }); res.end(JSON.stringify(mode.body || { message: "injected failure" })); return; }
        if (mode.kind === "drop") { req.socket.destroy(); return; }
        if (mode.kind === "hang") { setTimeout(() => { try { req.socket.destroy(); } catch { /* ignore */ } }, mode.ms || 60000); return; }
        if (mode.kind === "html") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body>Bad gateway page</body></html>"); return; }
        if (mode.kind === "garbage") { res.writeHead(200, { "content-type": "application/json" }); res.end(mode.body !== undefined ? mode.body : "not json at all"); return; }
      }
      if (!state.restUp) { req.socket.destroy(); return; }
            const forward = (attempt) => {
        const up = http.request({ agent, host: "127.0.0.1", port: state.restPort, method: req.method, path: url, headers: { ...req.headers, host: `127.0.0.1:${state.restPort}`, connection: "keep-alive" } }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
        // the container port-forward can reset a fresh connection before any byte is processed; retry those twice so harness noise is never blamed on the system under test
        up.on("error", (e) => { if (attempt < 2 && !res.headersSent && state.restUp && /ECONNRESET|socket hang up|EPIPE/.test(String(e && (e.code || e.message)))) return setTimeout(() => forward(attempt + 1), 25); try { req.socket.destroy(); } catch { /* ignore */ } });
        if (bodyBuf.length) up.write(bodyBuf);
        up.end();
      };
      forward(0);
    });
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyPort = proxy.address().port;

  return {
    id, key, anonKey, authKey, jwtSecret, pgPassword,
    url: `http://127.0.0.1:${proxyPort}`, restUrl: () => `http://127.0.0.1:${state.restPort}`,
    stats,
    /** sets a fault: { kind: "status"|"drop"|"hang"|"html"|"garbage", status?, body?, ms?, match?(method, url) } or null to heal */
    fault(mode) { state.mode = mode; },
    heal() { state.mode = null; },
    sql(statement) { const r = docker(["exec", `${id}-db`, "psql", "-U", "postgres", "-tA", "-c", statement], { allowFail: true }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: r.stderr || "" }; },
    applyMigration(name) { return psqlFile(path.join(dbDir, name)); },
    reloadSchema() { docker(["exec", `${id}-db`, "psql", "-U", "postgres", "-c", "notify pgrst, 'reload schema'"], { allowFail: true }); },
    stopRest() { docker(["stop", "-t", "1", `${id}-rest`], { allowFail: true }); state.restUp = false; },
    startRest() { startRest(); },
    async rest(p, { method = "GET", key: k = key, body, headers = {} } = {}) {
      const auth = k === null ? {} : { apikey: k, authorization: `Bearer ${k}` };
      const r = await rawRest(p, { method, headers: { ...auth, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
      return { status: r.status, text, json };
    },
    env: (extra = {}) => ({ LEAD_AGENTS_STORE_DRIVER: "supabase", SUPABASE_URL: `http://127.0.0.1:${proxyPort}`, SUPABASE_SERVICE_ROLE_KEY: key, LEAD_AGENTS_REQUEST_TIMEOUT_MS: "4000", ...extra }),
    cleanup,
  };
}

module.exports = { startPg, jwt };
