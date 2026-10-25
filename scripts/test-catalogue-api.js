// Product catalogue (Phase 1) over HTTP against the real Office server with a temporary FILE store: the shared acceptance scenarios
// (scripts/catalogue-scenarios.js), persistence across a restart, and no secret in any log. The Postgres twin of this suite is
// scripts/test-catalogue-postgres.js.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { hashPassword } = require("../src/lead-agents/auth");
const { runCatalogueScenarios, testUsers } = require("./catalogue-scenarios");

const ROOT = path.resolve(__dirname, "..");
const FULL_KEY = `full_${crypto.randomBytes(12).toString("hex")}`;
const SITE_KEY = `oyi_${crypto.randomBytes(24).toString("hex")}`;
const SESSION_SECRET = crypto.randomBytes(24).toString("hex");
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
let checks = 0, failures = 0;
const check = (id, text, cond, detail) => { checks += 1; if (!cond) failures += 1; console.log(`${cond ? "PASS" : "FAIL"} ${id} ${text}${cond ? "" : " :: " + String(JSON.stringify(detail === undefined ? null : detail)).slice(0, 600)}`); };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });

async function startServer(dir) {
  const port = await freePort();
  const env = {
    PATH: process.env.PATH, HOME: dir, NODE_ENV: "test", LEAD_AGENTS_HOST: "127.0.0.1", LEAD_AGENTS_PORT: String(port),
    LEAD_AGENTS_STORE_PATH: path.join(dir, "store.json"), OFFICE_STORAGE_DIR: path.join(dir, "storage"),
    LEAD_AGENTS_AUTH_MODE: "required_api_key", LEAD_AGENTS_API_KEYS: FULL_KEY, LEAD_AGENTS_SESSION_SECRET: SESSION_SECRET,
    LEAD_AGENTS_SCOPED_API_KEYS: JSON.stringify([{ client: "getoyi", key_sha256: sha(SITE_KEY), scopes: ["intake.submit"] }]),
    OPENAI_API_KEY: "sk-fixture-not-real", OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
    LEAD_AGENTS_RATE_LIMIT_MAX_REQUESTS: "100000", LEAD_AGENTS_OFFICE_RATE_LIMIT_MAX_REQUESTS: "100000", LEAD_AGENTS_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "1000",
  };
  const proc = spawn(process.execPath, ["lead-agents-server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = []; proc.stdout.on("data", (d) => logs.push(String(d))); proc.stderr.on("data", (d) => logs.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i += 1) {
    if (await fetch(url + "/healthz").catch(() => null)) return { url, logs, stop: () => new Promise((res) => { if (proc.exitCode !== null) return res(); proc.once("exit", res); proc.kill("SIGTERM"); }) };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start: " + logs.join("").slice(-800));
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-api-"));
  const users = testUsers();
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, "store.json"), JSON.stringify({
    admin_users: Object.values(users).map((u) => ({ id: crypto.randomUUID(), email: u.email, password_hash: hashPassword(u.password), role: u.role, status: "active", display_name: u.email, permission_scopes: u.scopes, created_at: now, updated_at: now })),
  }));
  let srv = await startServer(dir);
  const allLogs = [srv.logs];
  let result;
  try {
    result = await runCatalogueScenarios({ base: srv.url, users, fullKey: FULL_KEY, scopedKey: SITE_KEY, check, storageDir: path.join(dir, "storage") });
  } finally {
    await srv.stop();
  }
  // persistence: the catalogue state survives a restart of the file store
  srv = await startServer(dir);
  allLogs.push(srv.logs);
  try {
    const login = await fetch(`${srv.url}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: users.writerA.email, password: users.writerA.password }) });
    const cookie = ((login.headers.getSetCookie ? login.headers.getSetCookie() : []).find((x) => /^lead_agents_admin=/.test(x)) || "").split(";")[0];
    const detail = await fetch(`${srv.url}/api/lead-agents/admin/catalogue/products/${result.productId}`, { headers: { cookie } }).then((r) => r.json());
    check("FS1", "the catalogue (products, versions, events) survives a file-store restart", detail.product && detail.versions.length >= 8 && detail.publication_events.length >= 4, detail.product);
  } finally {
    await srv.stop();
  }
  const logs = allLogs.map((l) => l.join("")).join("\n");
  check("AT80", "no API key, its digest, session secret or user password appears in any log", ![FULL_KEY, SITE_KEY, sha(SITE_KEY), SESSION_SECRET, ...Object.values(users).map((u) => u.password)].some((s) => logs.includes(s)));
  console.log(JSON.stringify({ suite: "catalogue-api (file store)", checks, failed: failures }));
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(2); });
