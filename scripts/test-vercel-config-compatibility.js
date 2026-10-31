"use strict";
// Synthetic values and explicit temporary paths only. Never read the user's
// Vercel config, request an OIDC token or contact a provider.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { isDeepStrictEqual } = require("node:util");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const cfg = require("@vercel/cli-config");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "office-config-compat-"));
let count = 0;
const check = (ok, label) => { assert.ok(ok, label); count++; console.log("PASS " + label); };
try {
  check(require("zod/package.json").version === "4.6.6", "exact patched Zod resolution");
  check(JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve("@vercel/functions")), "package.json"))).version === "3.10.4", "Vercel functions unchanged");
  const globalInput = { credStorage: "file", currentTeam: "synthetic-team", usedBefore: false, telemetry: { enabled: false, extra: true }, guidance: { enabled: true }, updates: { auto: false }, futureSetting: "synthetic" };
  const authInput = { token: "synthetic-not-a-key", refreshToken: "synthetic-not-a-key", expiresAt: 1, tokenSource: "env", cachedUser: { id: "synthetic", username: "synthetic" }, futureSetting: true };
  check(isDeepStrictEqual(cfg.parseGlobalConfig(globalInput), globalInput), "global fields and passthrough preserved");
  check(isDeepStrictEqual(cfg.parseAuthConfig(authInput), authInput), "auth fields and passthrough preserved");
  const fileAuth = cfg.parseAuthFileConfig(authInput);
  check(!("tokenSource" in fileAuth) && fileAuth.token === authInput.token, "file parsing removes transient token source");
  for (const value of ["auto", "file", "keyring"]) check(cfg.parseGlobalConfig({ credStorage: value }).credStorage === value, "storage enum " + value);
  for (const value of [{ credStorage: "invalid" }, { telemetry: { enabled: "yes" } }, { currentTeam: [] }]) {
    let rejected = false; try { cfg.parseGlobalConfig(value); } catch { rejected = true; }
    check(rejected, "malformed global configuration rejected");
  }
  for (const value of [{ token: 5 }, { expiresAt: "soon" }, { tokenSource: "invalid" }, { cachedUser: { id: "missing-name" } }]) {
    let rejected = false; try { cfg.parseAuthConfig(value); } catch { rejected = true; }
    check(rejected, "malformed auth configuration rejected");
  }
  const globalFile = path.join(dir, "config.json"), authFile = path.join(dir, "auth.json");
  cfg.writeGlobalConfigFile(globalFile, globalInput);
  check(isDeepStrictEqual(cfg.readGlobalConfigFile(globalFile), globalInput), "global encode/write/read round trip");
  cfg.writeAuthConfigFile(authFile, authInput);
  check(isDeepStrictEqual(cfg.readAuthConfigFile(authFile), authInput), "auth encode/write/read round trip");
  fs.writeFileSync(globalFile, "\uFEFF" + JSON.stringify(globalInput));
  check(cfg.readGlobalConfigFile(globalFile).currentTeam === globalInput.currentTeam, "BOM file compatibility");
  // Bounded process proves an oversized constrained collection is rejected before
  // accumulating 100,000 element errors; no unbounded stress on the host process.
  const child = spawnSync(process.execPath, ["--max-old-space-size=64", "-e", 'const z=require("zod");const r=z.array(z.string()).max(5).safeParse(Array(100000).fill(123));process.exit(!r.success && r.error.issues.length===1 && r.error.issues[0].code==="too_big" ? 0 : 1);'], { cwd: path.resolve(__dirname, ".."), timeout: 5000, encoding: "utf8" });
  check(child.status === 0 && !child.error, "oversized constrained collection rejected under bounded heap/time");
  console.log(JSON.stringify({ suite: "vercel-config-compatibility", passed: count, failed: 0 }));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
