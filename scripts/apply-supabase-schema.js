// Maintenance for an EXISTING Office database: re-applies db/lead-agents-schema.sql (idempotent DDL).
//   npm run crm:apply-schema                                       read-only dry run (default): target state and security gate
//   npm run crm:apply-schema -- --apply --confirm-target <host>    apply, in one transaction
// The database comes from SUPABASE_DB_URL in .env.lead-agents.local (never printed).
// Safeguards:
// - A fresh database (no tables in public) is refused: initialize it with scripts/init-office-database.js --fresh, which
//   applies the security baseline first and the approved migration order. This script never creates an unhardened schema.
// - --apply requires --confirm-target equal to the host the connection really uses. URL overrides (?host=, hostaddr,
//   service, options), several hosts and socket paths are refused; only ?sslmode= is accepted.
// - Must run as postgres (the migration owner), so later objects are covered by its default privileges.
// - Tables and routines that the schema CREATES in this run get the baseline treatment (RLS on; nothing for PUBLIC, anon
//   or authenticated). Existing objects are not touched.
// - The security gate (db/security/office-security-verify.sql) runs before and after inside the same transaction. If the
//   apply would still introduce any violation that was not already present, the transaction is rolled back. Existing
//   violations are reported, not repaired: re-applying the baseline to an existing database is a separate decision.
"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { parse } = require("pg-connection-string");

const SCHEMA = path.join(__dirname, "..", "db", "lead-agents-schema.sql");
const VERIFY = path.join(__dirname, "..", "db", "security", "office-security-verify.sql");

function parseArgs(argv) {
  const args = { apply: false, confirmTarget: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--confirm-target") args.confirmTarget = argv[++i] || "";
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

// The pg config that will actually be used, from the URL only.
function maintenanceTarget(url) {
  if (!url) throw new Error("Missing SUPABASE_DB_URL in .env.lead-agents.local");
  let parsed, query;
  try {
    parsed = parse(url);
    const u = new URL(url);
    query = [...u.searchParams.keys()];
    if (u.hash) query.push("#");
  } catch {
    throw new Error("refused: invalid database url");
  }
  const unexpected = query.filter((key) => key !== "sslmode");
  if (unexpected.length) throw new Error(`refused: URL parameters are not accepted (${unexpected.join(", ")})`);
  const host = String(parsed.host || "");
  if (!host || host.startsWith("/") || host.includes(",")) throw new Error("refused: target host must be a single explicit host");
  return { host, port: Number(parsed.port) || 5432, user: parsed.user, password: parsed.password, database: parsed.database,
    ssl: { rejectUnauthorized: false } };
}

// Runs the read-only verification gate inside the current transaction; returns the list of violations.
async function gate(client) {
  await client.query("savepoint office_gate");
  try {
    await client.query(fs.readFileSync(VERIFY, "utf8"));
    await client.query("release savepoint office_gate");
    return [];
  } catch (error) {
    await client.query("rollback to savepoint office_gate");
    const match = /violated \(\d+ finding\(s\)\): ([\s\S]*)$/.exec(String(error.message));
    if (!match) throw error;
    return match[1].split("; ");
  }
}

const OBJECTS = `select array(select oid::text from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','p')) as tables,
  array(select oid::text from pg_proc where pronamespace = 'public'::regnamespace) as routines`;

// schemaSql is for tests only; the command always applies db/lead-agents-schema.sql.
async function run({ url = process.env.SUPABASE_DB_URL, argv = process.argv.slice(2), log = (line) => console.log(JSON.stringify(line)), ssl, schemaSql } = {}) {
  const args = parseArgs(argv);
  const config = maintenanceTarget(url);
  if (ssl !== undefined) config.ssl = ssl;
  if (args.apply && args.confirmTarget !== config.host) {
    throw new Error("refused: --apply requires --confirm-target <host> matching the database host");
  }
  const client = new Client(config);
  await client.connect();
  try {
    await client.query(args.apply ? "begin" : "begin transaction read only");
    const { rows: [state] } = await client.query(`select current_user as role,
      (select count(*)::int from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','p')) as tables`);
    if (state.tables === 0) {
      throw new Error("refused: fresh database. Initialize it with scripts/init-office-database.js --fresh (security baseline first)");
    }
    const before = await gate(client);
    if (!args.apply) {
      await client.query("rollback");
      log({ mode: "dry-run", role: state.role, tables: state.tables, security_violations: before.length, violations: before });
      return { mode: "dry-run", before };
    }
    if (state.role !== "postgres") throw new Error(`refused: connected as ${state.role}, not postgres`);
    const { rows: [existing] } = await client.query(OBJECTS);
    await client.query(schemaSql === undefined ? fs.readFileSync(SCHEMA, "utf8") : schemaSql);
    const { rows: [now] } = await client.query(OBJECTS);
    const newTables = now.tables.filter((oid) => !existing.tables.includes(oid));
    const newRoutines = now.routines.filter((oid) => !existing.routines.includes(oid));
    for (const oid of newTables) {
      const { rows: [t] } = await client.query("select $1::oid::regclass::text as name", [oid]);
      await client.query(`alter table ${t.name} enable row level security; revoke all on ${t.name} from public, anon, authenticated`);
    }
    for (const oid of newRoutines) {
      const { rows: [p] } = await client.query("select $1::oid::regprocedure::text as name", [oid]);
      await client.query(`revoke all on routine ${p.name} from public, anon, authenticated`);
    }
    const after = await gate(client);
    const introduced = after.filter((item) => !before.includes(item));
    if (introduced.length) {
      await client.query("rollback");
      log({ mode: "apply", applied: false, rolled_back: true, introduced });
      throw new Error(`rolled back: the schema would introduce ${introduced.length} security violation(s)`);
    }
    await client.query("commit");
    log({ mode: "apply", applied: true, tables_before: state.tables, secured_new_tables: newTables.length, secured_new_routines: newRoutines.length, security_violations: after.length, violations: after });
    return { mode: "apply", before, after, securedNewTables: newTables.length, securedNewRoutines: newRoutines.length };
  } catch (error) {
    await client.query("rollback").catch(() => null);
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  require("dotenv").config({ path: ".env.lead-agents.local", override: true });
  run().then(() => process.exit(0), (error) => { console.error(error.message); process.exit(1); });
}

module.exports = { run, maintenanceTarget };
