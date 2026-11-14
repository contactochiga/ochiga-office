// Full Office regression: every package.json script whose name ends in ":test" (office:test and office:*:test), in
// declared order and discovered, so a registered suite cannot be left out; then the repository gates. Database-backed
// suites run against disposable local Docker containers with synthetic data and FAIL (never skip) when Docker or an
// image is missing. A step that reports SKIP
// (a missing prerequisite such as Docker, an image or Chrome) counts as a failure even if it exits 0.
// Each step is stopped after OFFICE_REGRESSION_STEP_TIMEOUT_MS (default 15 minutes) and counts as a failure.
//   npm run office:regression            run everything, exit 1 on any failure
//   npm run office:regression -- --list  print the plan only
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const GATES = ["check", "lint", "security:secrets", "build", "deployment:validate", "validate:release"];
const STEP_TIMEOUT_MS = Number(process.env.OFFICE_REGRESSION_STEP_TIMEOUT_MS) || 15 * 60_000;

function plan(scripts = require(path.join(ROOT, "package.json")).scripts) {
  return [...Object.keys(scripts).filter((name) => /:test$/.test(name)), ...GATES];
}

// Exit 0 is not enough: a suite that skipped part of itself did not prove it.
function outcome(status, output, timedOut = false) {
  if (timedOut) return { ok: false, reason: `timed out after ${Math.round(STEP_TIMEOUT_MS / 1000)} s` };
  if (status !== 0) return { ok: false, reason: `exit ${status}` };
  if (/^\s*SKIP\b/m.test(output)) return { ok: false, reason: "skipped (missing prerequisite)" };
  return { ok: true, reason: "" };
}

function main(argv) {
  const steps = plan();
  if (argv.includes("--list")) {
    console.log(steps.join("\n"));
    return 0;
  }
  const results = [];
  for (const step of steps) {
    const started = Date.now();
    const run = spawnSync("npm", ["run", "-s", step], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024,
      timeout: STEP_TIMEOUT_MS, killSignal: "SIGKILL" });
    const seconds = (Date.now() - started) / 1000;
    const { ok, reason } = outcome(run.status, String(run.stdout) + String(run.stderr), run.error?.code === "ETIMEDOUT");
    results.push({ step, ok, seconds });
    console.log(`${ok ? "PASS" : "FAIL"} ${step} (${seconds.toFixed(1)} s)${ok ? "" : ` — ${reason}`}`);
    if (!ok) console.log(String(run.stdout + run.stderr).trim().split("\n").slice(-15).map((line) => `    ${line}`).join("\n"));
  }
  const failed = results.filter((r) => !r.ok);
  const total = results.reduce((sum, r) => sum + r.seconds, 0);
  console.log(`\nOffice regression: ${results.length - failed.length}/${results.length} steps passed in ${total.toFixed(0)} s`);
  return failed.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { plan, outcome, GATES, STEP_TIMEOUT_MS };
