// R3: shared, deterministic browser-test infrastructure (headless Chrome over the DevTools protocol). Test infrastructure only: nothing here is loaded by the application.
//
// Root cause it removes (docs/settings-domain/41_S7_R3_BROWSER_RELIABILITY_BASELINE.md): suites issued `Page.navigate` for the next URL while their previous `about:blank` navigation had
// not COMMITTED yet. A URL that differs from the still-committed document only by its fragment is then treated as a same-document navigation; when `about:blank` commits a moment later the
// fragment navigation is dropped and its CDP call never answers (the "CDP call timed out: Page.navigate" failure). A page holding long-lived EventSource requests unloads slowly and widens
// the window. A longer timeout cannot fix that; waiting for the navigation to settle can.
//
// What it provides:
//   launchChrome(chromePath, { userDir, flags })  isolated browser on a Chrome-chosen free debugging port (no fixed ports, no cross-suite collisions), whole process group stopped on stop()
//   wrapSend(rawSend, { label })                  drop-in replacement for a suite's `send`: Page.navigate / Page.reload resolve only once the navigation has settled; everything else passes through
//   Bounded recovery: ONE `Page.stopLoading` + re-issue per navigation, always counted and printed; BROWSER_HARNESS_STRICT=1 turns any recovery into a failure (used by the stability runs).
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STRICT = process.env.BROWSER_HARNESS_STRICT === "1";
const SETTLE_MS = Number(process.env.BROWSER_HARNESS_NAV_MS) || 15000;

async function launchChrome(chromePath, { userDir, flags = [] } = {}) {
  const dir = userDir || fs.mkdtempSync(path.join(os.tmpdir(), "office-chrome-"));
  const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--disable-gpu", ...flags.filter((f) => !/^--(remote-debugging-port|user-data-dir|headless)/.test(f)), "about:blank"];
  // its own process group, so stop() can end the browser AND its helper processes
  const proc = spawn(chromePath, args, { stdio: "ignore", detached: true });
  let exited = false; proc.once("exit", () => { exited = true; });
  let port = 0;
  for (let i = 0; i < 100 && !port; i += 1) {
    try { const text = fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8"); port = Number(text.split("\n")[0]); } catch { /* not written yet */ }
    if (!port) await sleep(100);
  }
  if (!port) { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } throw new Error("Chrome did not publish its DevTools port"); }
  const stop = async () => {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      if (!exited) { try { process.kill(-proc.pid, signal); } catch { /* group already gone */ } }
      for (let i = 0; i < 40 && !exited; i += 1) await sleep(100); // up to 4 s per signal
      if (exited) break;
    }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); } catch { /* the OS will reclaim the temp dir */ }
    return { exited, userDirRemoved: !fs.existsSync(dir) };
  };
  return { proc, port, userDir: dir, stop };
}

const stripHash = (u) => String(u).split("#")[0];
const sameTarget = (current, target) => {
  if (!current) return false;
  if (target === "about:blank") return current === "about:blank";
  try { const a = new URL(current), b = new URL(target); return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search && a.hash === b.hash; } catch { return current === target; }
};

function wrapSend(rawSend, { label = "browser" } = {}) {
  const stats = { label, navigations: 0, reloads: 0, retries: 0, maxMs: 0, totalMs: 0, slow: [] };
  const quick = async (expression, ms = 1500) => {
    try {
      const r = await Promise.race([rawSend("Runtime.evaluate", { expression, returnByValue: true }), sleep(ms).then(() => null)]);
      return r && r.result && !r.result.exceptionDetails ? r.result.result.value : undefined;
    } catch { return undefined; }
  };
  const state = () => quick("({ href: location.href, ready: document.readyState, marker: window.__harnessNav || null })");
  // Wait until the page is not in the middle of loading something (the previous navigation really finished)
  const settleBefore = async () => {
    const end = Date.now() + 10000;
    while (Date.now() < end) { const s = await state(); if (s && s.ready === "complete") return true; await sleep(60); }
    await rawSend("Page.stopLoading").catch(() => null); // bounded: never wait forever for a page that will not finish
    return false;
  };
  async function navigate(url) {
    const started = Date.now(); stats.navigations += 1;
    await settleBefore();
    const attempt = async (budget) => {
      const token = `nav${stats.navigations}_${Math.random().toString(36).slice(2, 8)}`;
      const before = await state();
      const sameDocument = before && before.href && url !== "about:blank" && stripHash(before.href) === stripHash(url);
      if (!sameDocument) await quick(`window.__harnessNav = ${JSON.stringify(token)}; true`);
      let answer = null; let errorText = null;
      rawSend("Page.navigate", { url }).then((a) => { answer = a; errorText = a && a.result && a.result.errorText; }).catch(() => null); // may never answer in the race; its own timer rejects later (handled)
      const end = Date.now() + budget;
      while (Date.now() < end) {
        if (errorText) return { ok: true, errorPage: true };
        const s = await state();
        if (s && sameTarget(s.href, url) && s.ready === "complete" && (sameDocument || s.marker !== token)) return { ok: true };
        await sleep(50);
      }
      return { ok: false };
    };
    let outcome = await attempt(SETTLE_MS);
    if (!outcome.ok) {
      stats.retries += 1;
      const s = await state();
      process.stderr.write(`[browser-harness] ${label}: navigation to ${url.slice(0, 90)} did not settle in ${SETTLE_MS} ms (page: ${JSON.stringify(s)}); one bounded recovery\n`);
      if (STRICT) throw new Error(`navigation did not settle (strict mode): ${url}`);
      await rawSend("Page.stopLoading").catch(() => null);
      outcome = await attempt(SETTLE_MS);
      if (!outcome.ok) throw new Error(`navigation did not settle after one recovery: ${url} (page: ${JSON.stringify(await state())})`);
    }
    const ms = Date.now() - started; stats.totalMs += ms; if (ms > stats.maxMs) stats.maxMs = ms; if (ms > 3000) stats.slow.push(`${url.slice(-40)} ${ms}ms`);
    return { result: { frameId: null } };
  }
  async function reload() {
    const started = Date.now(); stats.reloads += 1;
    await settleBefore();
    const token = `rl${stats.reloads}_${Math.random().toString(36).slice(2, 8)}`;
    await quick(`window.__harnessNav = ${JSON.stringify(token)}; true`);
    rawSend("Page.reload", {}).catch(() => null);
    const end = Date.now() + SETTLE_MS;
    while (Date.now() < end) { const s = await state(); if (s && s.ready === "complete" && s.marker !== token) { stats.totalMs += Date.now() - started; return { result: {} }; } await sleep(50); }
    stats.retries += 1; process.stderr.write(`[browser-harness] ${label}: reload did not settle in ${SETTLE_MS} ms; one bounded recovery\n`);
    if (STRICT) throw new Error("reload did not settle (strict mode)");
    await rawSend("Page.stopLoading").catch(() => null); await rawSend("Page.reload", {}).catch(() => null);
    const end2 = Date.now() + SETTLE_MS;
    while (Date.now() < end2) { const s = await state(); if (s && s.ready === "complete" && s.marker !== token) return { result: {} }; await sleep(50); }
    throw new Error("reload did not settle after one recovery");
  }
  const send = (method, params = {}) => (method === "Page.navigate" ? navigate(String(params.url)) : method === "Page.reload" ? reload() : rawSend(method, params));
  send.stats = stats;
  process.once("exit", () => { process.stderr.write(`[browser-harness] ${label}: navigations=${stats.navigations} reloads=${stats.reloads} recoveries=${stats.retries} max=${stats.maxMs}ms total=${stats.totalMs}ms${stats.slow.length ? ` slow=${stats.slow.join(" | ")}` : ""}\n`); });
  return send;
}

module.exports = { launchChrome, wrapSend, sleep };
