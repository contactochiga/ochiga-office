// Initializes a FRESH, LOCAL Office database in the order listed in db/migration-order.txt (security baseline first,
// schema, dated migrations, Track B in its documented order, baseline again, then the verification gate).
//   node scripts/init-office-database.js --db-url <postgres url> --fresh      empty local database, all files
//   node scripts/init-office-database.js --db-url <postgres url> --reassert   re-apply the baseline, then verify
//   node scripts/init-office-database.js --db-url <postgres url> --verify     verification gate only (read-only)
// Local only; there is no remote mode. The target is checked as pg will actually use it (query parameters such as
// ?host= included). URLs with query parameters, several hosts or a socket path are refused; every address the host
// resolves to must be loopback or private, and the connection goes to that checked address with only host, port,
// user, password and database (no options, service files or environment overrides). Hosted Supabase hosts and any
// ref listed in OFFICE_DB_PROTECTED_REFS are refused. --fresh refuses a non-empty database and records a marker
// bound to the cluster's system identifier and the database OID; --reassert refuses a database whose marker is
// missing or was copied from another cluster or database. The marker is a workflow check, not authentication:
// the target guard is the safety boundary. Must connect as postgres. The URL is never printed.
"use strict";

const dns = require("node:dns").promises;
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { Client } = require("pg");
const { parse } = require("pg-connection-string");

const DB_DIR = path.join(__dirname, "..", "db");
const BASELINE = "security/office-security-baseline.sql";
const VERIFY = "security/office-security-verify.sql";
const MARKER_SCHEMA = "office_local_init";
const HOSTED = /(^|\.)(supabase\.co|supabase\.com|supabase\.net|pooler\.supabase\.com)$/i;

function migrationOrder() {
  return fs.readFileSync(path.join(DB_DIR, "migration-order.txt"), "utf8")
    .split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function parseArgs(argv) {
  const args = { mode: null, url: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db-url") args.url = argv[++i] || "";
    else if (["--fresh", "--reassert", "--verify"].includes(argv[i])) args.mode = argv[i].slice(2);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.mode || !args.url) throw new Error("usage: --db-url <url> (--fresh | --reassert | --verify)");
  return args;
}

function privateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith("::ffff:")) return privateAddress(v6.slice(7));
  return v6 === "::1" || /^f[cd][0-9a-f]{2}:/.test(v6);
}

// Returns the exact pg config that will be used; throws unless it targets a local or private address.
async function resolveLocalTarget(url, protectedRefs = process.env.OFFICE_DB_PROTECTED_REFS, lookup = (host) => dns.lookup(host, { all: true })) {
  const refs = String(protectedRefs || "").split(",").map((ref) => ref.trim()).filter(Boolean);
  if (refs.some((ref) => url.includes(ref))) throw new Error("refused: protected project");
  let config;
  try { config = parse(url); } catch { throw new Error("refused: invalid database url"); }
  let search = "";
  try { const u = new URL(url); search = u.search + u.hash; } catch { throw new Error("refused: invalid database url"); }
  if (search) throw new Error("refused: query parameters are not accepted");
  const host = String(config.host || "");
  if (host.includes(",")) throw new Error("refused: several hosts");
  if (!host || host.startsWith("/")) throw new Error("refused: target host must be explicit (no socket or empty host)");
  if (HOSTED.test(host) || /supabase/i.test(url)) throw new Error("refused: hosted Supabase target");
  if (!(host === "localhost" || net.isIP(host) || !host.includes("."))) throw new Error("refused: remote host");
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host).catch(() => []);
  if (!addresses.length || !addresses.every(({ address }) => privateAddress(address))) {
    throw new Error("refused: target does not resolve only to loopback or private addresses");
  }
  // Connect to the address that was checked, with nothing else from the URL or the environment.
  return { host: addresses[0].address, port: Number(config.port) || 5432, user: config.user, password: config.password,
    database: config.database, ssl: false };
}

async function run({ url, mode, log = (line) => console.log(JSON.stringify(line)), lookup }) {
  const config = await resolveLocalTarget(url, undefined, lookup);
  const files = mode === "fresh" ? migrationOrder() : mode === "reassert" ? [BASELINE, VERIFY] : [VERIFY];
  for (const file of files) if (!fs.existsSync(path.join(DB_DIR, file))) throw new Error(`missing ${file}`);
  const client = new Client(config);
  await client.connect();
  try {
    const { rows: [who] } = await client.query(`select current_user as role,
      (select count(*)::int from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','p')) as tables,
      obj_description((select oid from pg_namespace where nspname = $1), 'pg_namespace') as marker,
      (select system_identifier::text from pg_control_system()) || ':' || (select oid::text from pg_database where datname = current_database()) as identity`, [MARKER_SCHEMA]);
    const expectedMarker = `office-local-init:${who.identity}`;
    if (who.role !== "postgres") throw new Error(`refused: connected as ${who.role}, not postgres`);
    if (mode === "fresh" && (who.tables > 0 || who.marker !== null)) throw new Error(`refused: not a fresh database (${who.tables} tables in public)`);
    if (mode === "reassert" && who.marker !== expectedMarker) throw new Error("refused: database was not initialized by this tool on this cluster");
    if (mode === "fresh") {
      await client.query(`create schema ${MARKER_SCHEMA}; revoke all on schema ${MARKER_SCHEMA} from public;
        comment on schema ${MARKER_SCHEMA} is '${expectedMarker}'`);
    }
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

module.exports = { migrationOrder, resolveLocalTarget, privateAddress, run };
