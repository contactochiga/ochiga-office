// Full Office regression: every package.json script whose name ends in ":test" (office:test and office:*:test), in
// declared order and discovered, so a registered suite cannot be left out; then the repository gates. Database-backed suites run against disposable local Docker
// containers with synthetic data and FAIL (never skip) when Docker or an image is missing.
//   npm run office:regression            run everything, exit 1 on any failure
//   npm run office:regression -- --list  print the plan only
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const GATES = ["check", "lint", "security:secrets", "build", "deployment:validate", "validate:release"];

function plan(scripts = require(path.join(ROOT, "package.json")).scripts) {
  return [...Object.keys(scripts).filter((name) => /:test$/.test(name)), ...GATES];
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
    const run = spawnSync("npm", ["run", "-s", step], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
    const seconds = (Date.now() - started) / 1000;
    const ok = run.status === 0;
    results.push({ step, ok, seconds });
    console.log(`${ok ? "PASS" : "FAIL"} ${step} (${seconds.toFixed(1)} s)`);
    if (!ok) console.log(String(run.stdout + run.stderr).trim().split("\n").slice(-15).map((line) => `    ${line}`).join("\n"));
  }
  const failed = results.filter((r) => !r.ok);
  const total = results.reduce((sum, r) => sum + r.seconds, 0);
  console.log(`\nOffice regression: ${results.length - failed.length}/${results.length} steps passed in ${total.toFixed(0)} s`);
  return failed.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { plan, GATES };
