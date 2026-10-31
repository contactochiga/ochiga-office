// Solutions & Packages (SP1/SP3) over HTTP against the real Office server with a temporary FILE store: the shared package scenarios
// (scripts/package-scenarios.js) and no secret in any log. The Postgres run is part of
// scripts/test-catalogue-postgres.js.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { hashPassword } = require("../src/lead-agents/auth");
const { startRevalidator, testUsers } = require("./catalogue-scenarios");
const { runPackageScenarios } = require("./package-scenarios");

const ROOT = path.resolve(__dirname, "..");
const PREVIOUS = process.env.PACKAGE_STAGING_RESUME && JSON.parse(fs.readFileSync(path.join(process.env.PACKAGE_STAGING_DIR, "connection.json")));
if (PREVIOUS && !PREVIOUS.url.startsWith("http://127.0.0.1:")) throw new Error("staging resume requires loopback Office");
const FULL_KEY = `full_${crypto.randomBytes(12).toString("hex")}`;
const CATALOGUE_KEY = PREVIOUS ? PREVIOUS.catalogueKey : `oyicat_${crypto.randomBytes(24).toString("hex")}`, REVALIDATE_SECRET = crypto.randomBytes(24).toString("hex");
const SITE_KEY = PREVIOUS ? PREVIOUS.intakeKey : `oyi_${crypto.randomBytes(24).toString("hex")}`;
const SESSION_SECRET = crypto.randomBytes(24).toString("hex");
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
let checks = 0, failures = 0;
const check = (id, text, cond, detail) => { checks += 1; if (!cond) failures += 1; console.log(`${cond ? "PASS" : "FAIL"} ${id} ${text}${cond ? "" : " :: " + String(JSON.stringify(detail === undefined ? null : detail)).slice(0, 600)}`); };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });

async function startServer(dir) {
  const port = PREVIOUS ? Number(new URL(PREVIOUS.url).port) : await freePort();
  const env = {
    PATH: process.env.PATH, HOME: dir, NODE_ENV: "test", LEAD_AGENTS_HOST: "127.0.0.1", LEAD_AGENTS_PORT: String(port),
    LEAD_AGENTS_STORE_PATH: path.join(dir, "store.json"), OFFICE_STORAGE_DIR: path.join(dir, "storage"),
    LEAD_AGENTS_AUTH_MODE: "required_api_key", LEAD_AGENTS_API_KEYS: FULL_KEY, LEAD_AGENTS_SESSION_SECRET: SESSION_SECRET,
    LEAD_AGENTS_SCOPED_API_KEYS: JSON.stringify([{ client: "getoyi", key_sha256: sha(SITE_KEY), scopes: ["intake.submit"] }, { client: "getoyi-catalogue", key_sha256: sha(CATALOGUE_KEY), scopes: ["catalogue.public.read"] }]),
      GETOYI_REVALIDATE_URL: process.env.__REVALIDATE_URL || "", GETOYI_REVALIDATE_SECRET: REVALIDATE_SECRET, GETOYI_PUBLIC_BASE_URL: "https://getoyi.example",
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
  const previous = PREVIOUS;
  const dir = previous ? previous.dir : fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-packages-"));
  const users = previous ? previous.users : testUsers();
  const now = new Date().toISOString();
  if (!previous) fs.writeFileSync(path.join(dir, "store.json"), JSON.stringify({
    admin_users: Object.values(users).map((u) => ({ id: crypto.randomUUID(), email: u.email, password_hash: hashPassword(u.password), role: u.role, status: "active", display_name: u.email, permission_scopes: u.scopes, created_at: now, updated_at: now })),
  }));
  const revalidator = await startRevalidator(REVALIDATE_SECRET);
  process.env.__REVALIDATE_URL = revalidator.url;
  let srv = await startServer(dir);
  const allLogs = [srv.logs];
  try {
    const asset = await fetch(srv.url + "/office/catalogue/packages.mjs");
    check("PK-UI-ASSET", "package ES module is served by the real Office router", asset.status === 200 && (await asset.text()).includes("export async function renderPackages"));
    if (!previous) await runPackageScenarios({ base: srv.url, users, fullKey: FULL_KEY, check, catalogueKey: CATALOGUE_KEY, revalidator });
    if (process.env.PACKAGE_STAGING_DIR && failures === 0) {
      const out = path.resolve(process.env.PACKAGE_STAGING_DIR);
      fs.mkdirSync(out, {recursive:true, mode:0o700});
      fs.writeFileSync(path.join(out,"connection.json"), JSON.stringify({url:srv.url, catalogueKey:CATALOGUE_KEY, intakeKey:SITE_KEY, users, dir}), {mode:0o600});
      console.log("Synthetic package staging ready at " + srv.url + "/office/#/catalogue/packages");
      await new Promise(resolve => { process.once("SIGTERM",resolve); process.once("SIGINT",resolve); });
    }
  } finally {
    await srv.stop();
  }
  const logs = allLogs.map((l) => l.join("")).join("\n");
  check("AT80", "no API key, its digest, session secret or user password appears in any log", ![FULL_KEY, SITE_KEY, sha(SITE_KEY), CATALOGUE_KEY, sha(CATALOGUE_KEY), REVALIDATE_SECRET, SESSION_SECRET, ...Object.values(users).map((u) => u.password)].some((s) => logs.includes(s)));
  console.log(JSON.stringify({ suite: "catalogue-packages (file store)", checks, failed: failures }));
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(2); });
