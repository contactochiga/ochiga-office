// R3: the complete Office regression as one in-repo, sequential runner with explicit per-suite timeout budgets. Test infrastructure only.
//   node scripts/run-all-tests.js                  every scripts/test-*.js except the Postgres suites (needs Docker) and cross-repo suites
//   node scripts/run-all-tests.js --postgres       the Postgres/PostgREST suites only
//   node scripts/run-all-tests.js --cert           the independent certification suites (scripts/cert/cert-*.js, except the library)
//   node scripts/run-all-tests.js --only <text>    suites whose file name contains <text>;  --repeat N  run the selection N times
//   RUN_TIMEOUT_SCALE=2 doubles every budget (slow or constrained hosts). Exit code is 1 if ANY suite fails: a suite that fails here is a failure even if it passes alone.
// Budgets are explicit and deliberate; a timeout is reported as a timeout, never retried.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");

const SCRIPTS = __dirname;
const scale = Number(process.env.RUN_TIMEOUT_SCALE) || 1;
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const repeat = Math.max(1, Number(value("--repeat")) || 1);

// seconds. Default for a plain API suite; browser suites drive a real browser; the long ones are named because they sign in many times or start Docker databases.
const BUDGET = { default: 180, browser: 300, postgres: 900, cert: 900 };
const LONG = { "test-mfa-ui-browser-s758.js": 900, "test-s5-integration-acceptance.js": 300, "test-production-rehearsal-postgres-r11.js": 1800 };
const budgetFor = (file, kind) => (LONG[file] || (kind === "postgres" ? BUDGET.postgres : kind === "cert" ? BUDGET.cert : /browser|acceptance/.test(file) ? BUDGET.browser : BUDGET.default)) * scale;

function select() {
  const all = fs.readdirSync(SCRIPTS).filter((f) => /^test-.*\.js$/.test(f));
  const only = value("--only");
  let list;
  if (flag("--postgres")) list = all.filter((f) => /postgres/.test(f)).map((f) => ({ file: path.join(SCRIPTS, f), kind: "postgres" }));
  else if (flag("--cert")) list = fs.readdirSync(path.join(SCRIPTS, "cert")).filter((f) => /^cert-(?!lib).*\.js$/.test(f)).map((f) => ({ file: path.join(SCRIPTS, "cert", f), kind: "cert" }));
  else list = all.filter((f) => !/postgres|cross-repo/.test(f)).map((f) => ({ file: path.join(SCRIPTS, f), kind: "suite" }));
  if (only) list = list.filter((s) => path.basename(s.file).includes(only));
  return list;
}

// Browsers started by the harness use --remote-debugging-port=0 and a profile under the temp directory. Suites run one at a time, so any such process still alive after a suite is its leftover
// (for example after a timeout killed the suite before its own cleanup). Nothing else is touched: a person's own browser never carries these flags.
function sweepBrowsers() {
  let out = ""; try { out = execFileSync("pgrep", ["-f", "remote-debugging-port=0.*user-data-dir="], { encoding: "utf8" }); } catch { return 0; }
  let n = 0; for (const pid of out.split("\n").map(Number).filter(Boolean)) { if (pid === process.pid) continue; try { process.kill(-pid, "SIGKILL"); n += 1; } catch { try { process.kill(pid, "SIGKILL"); n += 1; } catch { /* gone */ } } }
  return n;
}

function runOne({ file, kind }) {
  return new Promise((resolve) => {
    const name = path.basename(file); const limit = budgetFor(name, kind); const started = Date.now();
    const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"], cwd: path.join(SCRIPTS, ".."), detached: true });
    let output = ""; const keep = (c) => { output += c; if (output.length > 200000) output = output.slice(-100000); }; child.stdout.on("data", keep); child.stderr.on("data", keep);
    let timedOut = false; const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, limit * 1000);
    child.on("close", (code) => { clearTimeout(timer); const leftovers = sweepBrowsers(); const nav = (output.match(/\[browser-harness\][^\n]*navigations=(\d+) reloads=(\d+) recoveries=(\d+) max=(\d+)ms/) || []).slice(1).map(Number); resolve({ name, kind, code, timedOut, limit, seconds: Math.round((Date.now() - started) / 1000), leftovers, nav, tail: output.split("\n").filter((l) => l && !/injected env/.test(l)).slice(-6).join("\n") }); });
  });
}

(async () => {
  const suites = select(); if (!suites.length) { console.log("no suites selected"); process.exit(1); }
  const results = []; const t0 = Date.now();
  for (let r = 1; r <= repeat; r += 1) for (const s of suites) {
    const res = await runOne(s); res.round = r; results.push(res);
    const status = res.timedOut ? `TIMEOUT after ${res.limit}s` : res.code === 0 ? "pass" : `FAIL (exit ${res.code})`;
    console.log(`${status.padEnd(22)} ${String(res.seconds).padStart(4)}s / ${String(res.limit).padStart(4)}s  ${res.name}${repeat > 1 ? `  [round ${r}]` : ""}${res.nav && res.nav.length ? `  nav=${res.nav[0]}+${res.nav[1]} recoveries=${res.nav[2]} max=${res.nav[3]}ms` : ""}${res.leftovers ? `  (swept ${res.leftovers} leftover browser process${res.leftovers === 1 ? "" : "es"})` : ""}`);
    if (res.timedOut || res.code !== 0) console.log(res.tail.split("\n").map((l) => `    ${l.slice(0, 200)}`).join("\n"));
  }
  const bad = results.filter((x) => x.timedOut || x.code !== 0);
  console.log(`\n${results.length - bad.length}/${results.length} passed in ${Math.round((Date.now() - t0) / 1000)}s${bad.length ? `; FAILED: ${bad.map((b) => `${b.name}${b.timedOut ? " (timeout)" : ""}`).join(", ")}` : ""}`);
  console.log(JSON.stringify({ suite: "run-all-tests", total: results.length, failed: bad.length, leftovers_swept: results.reduce((a, x) => a + x.leftovers, 0), recoveries: results.reduce((a, x) => a + ((x.nav && x.nav[2]) || 0), 0) }));
  process.exit(bad.length ? 1 : 0);
})();
