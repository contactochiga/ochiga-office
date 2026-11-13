// Initializes a FRESH Office database in the order listed in db/migration-order.txt (security baseline first,
// schema, dated migrations, Track B in its documented order, baseline again, then the verification gate).
//   node scripts/init-office-database.js --db-url <postgres url> --fresh      fresh database, all files
//   node scripts/init-office-database.js --db-url <postgres url> --reassert   re-apply the baseline, then verify
//   node scripts/init-office-database.js --db-url <postgres url> --verify     verification gate only (read-only)
// Must connect as postgres (the migration owner). Local hosts only by default. A remote host must be named with
// --allow-remote-host, and is refused unless OFFICE_DB_PROTECTED_REFS (comma-separated production project refs,
// kept outside the repository) is set and none of them appears in the URL. The URL is never printed.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const DB_DIR = path.join(__dirname, "..", "db");
const BASELINE = "security/office-security-baseline.sql";
const VERIFY = "security/office-security-verify.sql";

function migrationOrder() {
  return fs.readFileSync(path.join(DB_DIR, "migration-order.txt"), "utf8")
    .split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function parseArgs(argv) {
  const args = { mode: null, url: "", allowRemoteHost: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db-url") args.url = argv[++i] || "";
    else if (argv[i] === "--allow-remote-host") args.allowRemoteHost = argv[++i] || "";
    else if (["--fresh", "--reassert", "--verify"].includes(argv[i])) args.mode = argv[i].slice(2);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.mode || !args.url) throw new Error("usage: --db-url <url> (--fresh | --reassert | --verify) [--allow-remote-host <host>]");
  return args;
}

function assertTarget(url, allowRemoteHost, protectedRefs = process.env.OFFICE_DB_PROTECTED_REFS) {
  const refs = String(protectedRefs || "").split(",").map((ref) => ref.trim()).filter(Boolean);
  if (refs.some((ref) => url.includes(ref))) throw new Error("refused: protected project");
  let host;
  try { host = new URL(url).hostname; } catch { throw new Error("refused: invalid database url"); }
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || !host.includes(".");
  if (!local && host !== allowRemoteHost) throw new Error("refused: remote host (name it with --allow-remote-host)");
  if (!local && !refs.length) throw new Error("refused: remote host without OFFICE_DB_PROTECTED_REFS");
}

async function run({ url, mode, allowRemoteHost, log = (line) => console.log(JSON.stringify(line)) }) {
  assertTarget(url, allowRemoteHost);
  const files = mode === "fresh" ? migrationOrder() : mode === "reassert" ? [BASELINE, VERIFY] : [VERIFY];
  for (const file of files) if (!fs.existsSync(path.join(DB_DIR, file))) throw new Error(`missing ${file}`);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows: [who] } = await client.query("select current_user as role, (select count(*)::int from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','p')) as tables");
    if (who.role !== "postgres") throw new Error(`refused: connected as ${who.role}, not postgres`);
    if (mode === "fresh" && who.tables > 0) throw new Error(`refused: not a fresh database (${who.tables} tables in public)`);
    for (const file of files) {
      const started = Date.now();
      try {
        await client.query(fs.readFileSync(path.join(DB_DIR, file), "utf8"));
      } catch (error) {
        log({ file, ok: false, error: String(error.message).slice(0, 2000) });
        throw new Error(`failed at ${file}`);
      }
      log({ file, ok: true, ms: Date.now() - started });
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  run(args).then(() => process.exit(0), (error) => { console.error(error.message); process.exit(1); });
}

module.exports = { migrationOrder, assertTarget, run };
