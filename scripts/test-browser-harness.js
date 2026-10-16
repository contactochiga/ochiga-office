// R3: tests of the shared browser harness itself (scripts/lib/browser-harness.js). Skips (exit 0) when Chrome is not installed.
// It proves: isolated browsers on free ports (parallel launches never collide), full cleanup, navigations settle (including the about:blank -> fragment-neighbour sequence that used to stall),
// reloads settle, and a navigation that can never complete fails in bounded time with exactly one recovery attempt (no infinite wait, no silent retry loop).
"use strict";
process.env.BROWSER_HARNESS_NAV_MS = "1500";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { launchChrome, wrapSend, sleep } = require("./lib/browser-harness");
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed += 1; };

async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const raw = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; const t = setTimeout(() => { pending.delete(n); reject(new Error(`CDP call timed out: ${method}`)); }, 20000); pending.set(n, (d) => { clearTimeout(t); resolve(d); }); ws.send(JSON.stringify({ id: n, method, params })); });
  return { ws, raw };
}
const alive = (dir) => { try { return execFileSync("pgrep", ["-f", `user-data-dir=${dir}`], { encoding: "utf8" }).trim().length > 0; } catch { return false; } };

async function main() {
  if (!CHROME) { console.log("SKIP: Chrome not installed"); return; }
  const pages = http.createServer((req, res) => {
    if (req.url.startsWith("/hang")) return; // accepts the connection and never answers
    if (req.url.startsWith("/events")) { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); res.write("retry: 100\n\n"); return; } // a long-lived stream, like the Office shell's
    res.writeHead(200, { "content-type": "text/html" }); res.end(`<!doctype html><title>t</title><body>page ${req.url}<script>const e = new EventSource('/events'); window.__page = ${JSON.stringify(req.url)};</script>`);
  });
  await new Promise((r) => pages.listen(0, "127.0.0.1", r)); const base = `http://127.0.0.1:${pages.address().port}`;

  // 1. parallel isolated browsers on distinct free ports
  const handles = await Promise.all([launchChrome(CHROME), launchChrome(CHROME), launchChrome(CHROME)]);
  ok(new Set(handles.map((h) => h.port)).size === 3 && handles.every((h) => h.port > 1023), `three simultaneous browsers get three distinct free debugging ports (${handles.map((h) => h.port)})`);
  ok(handles.every((h) => alive(h.userDir)), "each is running while open");
  const results = await Promise.all(handles.map((h) => h.stop())); ok(results.every((r) => r.exited && r.groupGone && r.userDirRemoved), "stop() ends every browser and its helper processes and removes every profile");
  await sleep(300); ok(handles.every((h) => !alive(h.userDir)), "no browser or helper process survives stop() (process group ended)");

  // 2. navigation settles; the old failure sequence runs clean, many times, in strict mode
  const h = await launchChrome(CHROME, { flags: ["--disable-features=BackForwardCache"] }); const { ws, raw } = await connect(h.port); const send = wrapSend(raw, { label: "harness-test" }); await send("Page.enable"); await send("Runtime.enable");
  const here = async () => (await raw("Runtime.evaluate", { expression: "location.href", returnByValue: true })).result.result.value;
  await send("Page.navigate", { url: `${base}/one#/settings/communications` }); ok((await here()) === `${base}/one#/settings/communications`, "navigate resolves only after the page is there");
  let sequences = 0;
  for (let i = 0; i < 40; i += 1) { await send("Page.navigate", { url: "about:blank" }); ok((await here()) === "about:blank", `about:blank committed before the call returned (${i})`); await send("Page.navigate", { url: `${base}/one#/settings` }); const href = await here(); ok(href === `${base}/one#/settings`, `the next navigation committed (${i})`); await send("Page.navigate", { url: `${base}/one#/settings/communications` }); sequences += 1; }
  ok(sequences === 40 && send.stats.retries === 0, `40 about:blank -> fragment-neighbour sequences with the long-lived EventSource page: zero recoveries (${send.stats.retries})`);
  // same-document (fragment-only) navigation also settles
  await send("Page.navigate", { url: `${base}/one#/a` }); await send("Page.navigate", { url: `${base}/one#/b` }); ok((await here()) === `${base}/one#/b`, "a fragment-only navigation resolves when applied");
  // reload settles on a NEW document
  await raw("Runtime.evaluate", { expression: "window.__before = 1" }); await send("Page.reload"); ok((await raw("Runtime.evaluate", { expression: "String(window.__before)", returnByValue: true })).result.result.value === "undefined", "reload resolves only after a new document is loaded");
  ok(send.stats.retries === 0, "no recoveries so far");

  // 3. a navigation that can never complete: bounded, one recovery, then a clear failure
  const started = Date.now(); let failure = null; try { await send("Page.navigate", { url: `${base}/hang` }); } catch (e) { failure = e; }
  const took = Date.now() - started; ok(failure && /did not settle after one recovery/.test(failure.message), `a navigation that never commits fails with a clear message (${failure && failure.message.slice(0, 80)})`);
  ok(took > 2500 && took < 15000, `…in bounded time (${took} ms: two 1.5 s attempts plus settle checks)`); ok(send.stats.retries === 1, "…after exactly one counted recovery");
  // the browser is still usable afterwards
  await send("Page.stopLoading").catch(() => null); await send("Page.navigate", { url: "about:blank" }); ok((await here()) === "about:blank", "the browser recovers for the next navigation");
  ws.close(); const last = await h.stop(); ok(last.exited && last.groupGone && last.userDirRemoved, "final cleanup (browser, helpers and profile)"); await new Promise((r) => { pages.closeAllConnections?.(); pages.close(r); });
  console.log(`R3 browser harness: ${passed} assertions PASS`);
}
main().catch((e) => { console.error(e); process.exit(1); });
