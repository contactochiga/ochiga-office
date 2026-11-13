// The routine Office regression (npm run office:regression) cannot silently omit the database-backed suites:
// every Postgres suite is registered as an office:*:test script, the runner discovers all of them, the catalogue and
// intake fixtures keep the approved manifest initialization and posture gate, and each Docker suite FAILS (never
// skips) when Docker or its image is unavailable. Nothing here starts a database.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { plan, outcome, GATES, STEP_TIMEOUT_MS } = require("./run-office-regression");

const ROOT = path.join(__dirname, "..");
const scripts = require(path.join(ROOT, "package.json")).scripts;
let checks = 0, failures = 0;
const check = (id, text, cond, detail) => { checks += 1; if (!cond) failures += 1; console.log(`${cond ? "PASS" : "FAIL"} ${id} ${text}${cond ? "" : " :: " + JSON.stringify(detail === undefined ? null : detail).slice(0, 600)}`); };
const source = (file) => fs.readFileSync(path.join(ROOT, "scripts", file), "utf8");

const REQUIRED = {
  "office:catalogue-postgres:test": "node scripts/test-catalogue-postgres.js",
  "office:intake-receipts-postgres:test": "node scripts/test-intake-receipts-postgres.js",
};
check("RR1", "catalogue and intake-receipts Postgres suites are registered with their exact commands",
  Object.entries(REQUIRED).every(([name, command]) => scripts[name] === command), Object.keys(REQUIRED).map((name) => [name, scripts[name]]));

const steps = plan();
check("RR2", "the regression runner includes both suites, every *:test script (incl. office:test) and the six repository gates",
  Object.keys(REQUIRED).every((name) => steps.includes(name)) &&
  Object.keys(scripts).filter((name) => /:test$/.test(name)).every((name) => steps.includes(name)) && steps.includes("office:test") &&
  GATES.every((gate) => steps.includes(gate) && scripts[gate]) && steps.length === new Set(steps).size, steps);
check("RR3", "npm run office:regression runs the runner", scripts["office:regression"] === "node scripts/run-office-regression.js");

// Any Postgres suite file must be reachable from a registered office:*:test command.
const registered = Object.entries(scripts).filter(([name]) => /:test$/.test(name)).map(([, command]) => command).join(" && ");
const postgresSuites = fs.readdirSync(path.join(ROOT, "scripts")).filter((f) => /^test-.*postgres.*\.js$/.test(f));
const unregistered = postgresSuites.filter((f) => !registered.includes(`scripts/${f}`));
check("RR4", `every Postgres suite file (${postgresSuites.length}) is run by a registered *:test script`, unregistered.length === 0, unregistered);

check("RR5", "catalogue and intake fixtures initialize from the approved manifest and keep the posture gate",
  ["test-catalogue-postgres.js", "test-intake-receipts-postgres.js"].every((f) => /fixtureFiles\(/.test(source(f)) && /verification gate passes/.test(source(f)) && !source(f).includes("/^2026\\d+.*\\.sql$/")));
// Hosted hostnames may appear only as targets a test expects to be refused; no suite reads connection settings
// from the environment or .env files (the security suite's PGHOST override test only sets and restores it), and
// each starts its own container.
check("RR6", "the Docker suites use disposable local containers only (no hosted or environment-supplied database)",
  ["test-catalogue-postgres.js", "test-intake-receipts-postgres.js", "test-office-security-baseline-postgres.js", "test-office-legacy-db-entrypoints.js"]
    .every((f) => !/process\.env\.(SUPABASE|DATABASE_URL|PG(HOST|PASSWORD|USER|DATABASE)\b)|dotenv|\.env\.lead-agents/.test(source(f).replace(/^.*\bsaved\b.*process\.env\.PGHOST.*$/gm, "")) && /docker", \["run"/.test(source(f))));

// A missing image (or no Docker) must fail the suite, not skip it. The bogus image name never reaches a registry:
// each suite checks `docker image inspect` before running anything.
const missing = {};
for (const file of ["test-catalogue-postgres.js", "test-intake-receipts-postgres.js", "test-office-security-baseline-postgres.js", "test-office-legacy-db-entrypoints.js", "test-meta-social-concurrency.js"]) {
  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts", file)], { cwd: ROOT, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, PG_IMAGE: "office-regression-registry.invalid/no-such-image:0" } });
  missing[file] = { status: run.status, blocked: /BLOCKED/.test(run.stdout + run.stderr), skipped: /\bSKIP\b/.test(run.stdout + run.stderr) };
}
check("RR7", "each Docker suite (incl. Meta social concurrency) exits non-zero with BLOCKED (never SKIP) when Docker or its image is unavailable",
  Object.values(missing).every((m) => m.status !== 0 && m.status !== null && m.blocked && !m.skipped), missing);

// The parent npm script chains the three Meta social suites with &&, so the concurrency failure must reach it.
const parent = spawnSync("npm", ["run", "-s", "office:meta-social-inbound:test"], { cwd: ROOT, encoding: "utf8", timeout: 300_000,
  env: { ...process.env, PG_IMAGE: "office-regression-registry.invalid/no-such-image:0" } });
check("RR8", "office:meta-social-inbound:test fails (non-zero, BLOCKED) when the concurrency suite's database image is unavailable",
  parent.status !== 0 && parent.status !== null && /BLOCKED/.test(parent.stdout + parent.stderr) && !/^\s*SKIP\b/m.test(parent.stdout + parent.stderr),
  { status: parent.status, tail: String(parent.stdout + parent.stderr).slice(-300) });

// Suites not changed here (WhatsApp inbound claims on Postgres, the two Chrome browser suites) still print SKIP and exit 0
// when Docker/Chrome is missing; the regression runner counts any SKIP line as a failure.
const skipping = ["test-whatsapp-inbound-claims-postgres.js", "test-relationship-workspace-browser.js", "test-content-workspace-browser.js"]
  .filter((f) => /SKIP/.test(source(f)));
check("RR9", `the runner fails a step that exits 0 but reports SKIP (covers ${skipping.length} suites that can still skip standalone)`,
  outcome(0, "SKIP: Chrome not installed").ok === false && outcome(0, "x\n  SKIP: docker or postgres:16-alpine unavailable\n").ok === false &&
  outcome(0, "PASS all\nskipped 2 echoes").ok === true && outcome(1, "").ok === false && outcome(0, "ok").ok === true, skipping);

// A hung suite must fail, not hold the run open: every step has a deadline.
const hung = spawnSync(process.execPath, [path.join(ROOT, "scripts", "run-office-regression.js"), "--list"], { encoding: "utf8" });
check("RR10", `each step has a deadline (${Math.round(STEP_TIMEOUT_MS / 60000)} min default) and a timeout counts as a failure`,
  STEP_TIMEOUT_MS > 0 && STEP_TIMEOUT_MS <= 30 * 60_000 && outcome(null, "", true).ok === false && outcome(0, "ok", true).ok === false &&
  /timeout: STEP_TIMEOUT_MS/.test(source("run-office-regression.js")) && hung.status === 0);

// The proposed workflow stays inert and least-privileged.
const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "office-regression.yml"), "utf8");
check("RR11", "the proposed CI workflow is dormant, read-only, secret-free, SHA-pinned and runs npm run office:regression",
  /^on:\n  pull_request:\n/m.test(wf) && !/pull_request_target|workflow_run|secrets\.|upload-artifact|deploy/i.test(wf.replace(/^#.*$/gm, "")) &&
  /^permissions:\n  contents: read$/m.test(wf) && !/write/.test(wf.replace(/^#.*$/gm, "")) &&
  /if: vars\.OFFICE_CI_ENABLED == 'true'/.test(wf) && /persist-credentials: false/.test(wf) &&
  (wf.match(/uses: [^\n]+/g) || []).every((u) => /@[0-9a-f]{40}\b/.test(u)) &&
  /npm ci --ignore-scripts/.test(wf) && /run: npm run office:regression$/m.test(wf) &&
  ["public.ecr.aws/supabase/postgres", "public.ecr.aws/supabase/postgrest", "node sha256", "postgres sha256"].every((image) => wf.includes(image)));

// Portability: registered suites read only repository files (no ~/Downloads, home-directory or machine paths), and the
// committed synthetic ingestion workbooks are exactly what the generator produces.
const suiteFiles = [...new Set(Object.entries(scripts).filter(([name]) => /:test$/.test(name))
  .flatMap(([, command]) => [...command.matchAll(/scripts\/[\w.-]+\.(?:c|m)?js/g)].map((m) => m[0])))];
const local = suiteFiles.filter((file) => file !== "scripts/" + path.basename(__filename)).filter((file) => /Downloads|\/Users\/[A-Za-z]|homedir\(\)/.test(fs.readFileSync(path.join(ROOT, file), "utf8")));
check("RR12", `no registered suite (${suiteFiles.length} files) reads a machine-specific path such as ~/Downloads`, local.length === 0, local);
const generated = spawnSync(process.execPath, [path.join(ROOT, "scripts", "fixtures", "build-ingestion-fixtures.js"), "--check"], { encoding: "utf8" });
check("RR13", "the committed synthetic ingestion workbooks match their deterministic generator", generated.status === 0, generated.stderr || generated.stdout);

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(failures ? "Office regression registry: FAIL" : "Office regression registry: PASS");
process.exit(failures ? 1 : 0);
