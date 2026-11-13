// The routine Office regression (npm run office:regression) cannot silently omit the database-backed suites:
// every Postgres suite is registered as an office:*:test script, the runner discovers all of them, the catalogue and
// intake fixtures keep the approved manifest initialization and posture gate, and each Docker suite FAILS (never
// skips) when Docker or its image is unavailable. Nothing here starts a database.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { plan, GATES } = require("./run-office-regression");

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
for (const file of ["test-catalogue-postgres.js", "test-intake-receipts-postgres.js", "test-office-security-baseline-postgres.js", "test-office-legacy-db-entrypoints.js"]) {
  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts", file)], { cwd: ROOT, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, PG_IMAGE: "office-regression-registry.invalid/no-such-image:0" } });
  missing[file] = { status: run.status, blocked: /BLOCKED/.test(run.stdout + run.stderr), skipped: /\bSKIP\b/.test(run.stdout + run.stderr) };
}
check("RR7", "each Docker suite exits non-zero with BLOCKED (never SKIP) when Docker or its image is unavailable",
  Object.values(missing).every((m) => m.status !== 0 && m.status !== null && m.blocked && !m.skipped), missing);

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(failures ? "Office regression registry: FAIL" : "Office regression registry: PASS");
process.exit(failures ? 1 : 0);
