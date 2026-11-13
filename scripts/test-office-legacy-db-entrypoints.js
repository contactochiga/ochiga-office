// Legacy Office database entry points cannot bypass the security baseline or overwrite the Track B dispatch fence.
// Static checks always run; database checks use a DISPOSABLE Supabase Postgres (never a real project) published on loopback.
// - crm:apply-schema (scripts/apply-supabase-schema.js) refuses fresh databases, is a read-only dry run by default,
//   applies only with an exact --confirm-target, rejects URL overrides, and rolls back if it would add a violation.
// - no script applies db/*.sql in filename order; test fixtures use the approved manifest (scripts/office-db-fixture.js).
// - filename order really does replace the fenced receipt function; the manifest keeps it.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawnSync } = require("child_process");
const legacy = require("./apply-supabase-schema");
const { run: init } = require("./init-office-database");
const { fixtureFiles } = require("./office-db-fixture");

const ROOT = path.resolve(__dirname, "..");
const PG_IMAGE = process.env.PG_IMAGE || "public.ecr.aws/supabase/postgres:17.6.1.131";
const PG = `legacy-pg-${crypto.randomBytes(3).toString("hex")}`;
const PW = `pw_${crypto.randomBytes(10).toString("hex")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0, failures = 0;
const check = (id, text, cond, detail) => { checks += 1; if (!cond) failures += 1; console.log(`${cond ? "PASS" : "FAIL"} ${id} ${text}${cond ? "" : " :: " + String(JSON.stringify(detail === undefined ? null : detail)).slice(0, 800)}`); };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });
const psql = (sql, db = "postgres") => { const r = sh("docker", ["exec", "-i", PG, "psql", "-X", "-q", "-At", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1"], { input: sql }); return { status: r.status, out: (r.stdout || "").trim(), err: r.stderr || "" }; };
const one = (sql, db) => psql(sql, db).out;
const SNAPSHOT = `select md5(string_agg(x, '|' order by x)) from (
  select 'c:'||relname||':'||relkind||':'||coalesce(relacl::text,'')||':'||relrowsecurity x from pg_class where relnamespace = 'public'::regnamespace
  union all select 'p:'||oid::regprocedure||':'||coalesce(proacl::text,'')||':'||md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace
  union all select 'd:'||defaclrole::regrole||':'||defaclnamespace||':'||defaclobjtype||':'||defaclacl::text from pg_default_acl
  union all select 'n:'||coalesce(nspacl::text,'') from pg_namespace where nspname = 'public') s`;
const FENCED = "select prosrc ~ 'office_meta_social_pending_receipts' from pg_proc where proname = 'office_record_meta_social_receipt'";
const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error: error.message }; } };

function staticChecks() {
  const scripts = fs.readdirSync(path.join(ROOT, "scripts")).filter((f) => /\.(c|m)?js$/.test(f) && f !== path.basename(__filename));
  const filenameOrder = scripts.filter((f) => /\^2026\\d\+\.\*\\\.sql\$/.test(fs.readFileSync(path.join(ROOT, "scripts", f), "utf8")));
  check("LG1", "no script selects every dated db/*.sql by filename pattern (the order that overwrote the dispatch fence)", filenameOrder.length === 0, filenameOrder);
  const dirListers = scripts.filter((f) => /readdirSync\(path\.join\((ROOT|__dirname, "\.\."), "db"\)\)/.test(fs.readFileSync(path.join(ROOT, "scripts", f), "utf8")));
  const allowed = {
    "test-office-security-baseline-postgres.js": /readdirSync\(path\.join\(ROOT, "db"\)\)\.filter\(\(f\) => f\.endsWith\("\.sql"\)\)/, // manifest completeness check only
    "test-catalogue-postgres.js": /_catalogue_\.\*\\\.sql\$\/\.test\(f\)\)\.sort\(\)/, // catalogue follow-ups only (no Track B)
  };
  const unexpected = dirListers.filter((f) => !(allowed[f] && allowed[f].test(fs.readFileSync(path.join(ROOT, "scripts", f), "utf8"))));
  check("LG2", "the only db/ directory listings are the manifest completeness check and the catalogue-only follow-up list", unexpected.length === 0, { dirListers, unexpected });
  const fixturesUseManifest = ["test-catalogue-postgres.js", "test-intake-receipts-postgres.js"].every((f) => /fixtureFiles\(/.test(fs.readFileSync(path.join(ROOT, "scripts", f), "utf8")));
  const plan = fixtureFiles(["20261101_office_intake_receipts.sql"]);
  const i = (f) => plan.indexOf(f);
  let unknownRefused = false; try { fixtureFiles(["20991231_not_a_migration.sql"]); } catch { unknownRefused = true; }
  check("LG3", "Postgres fixtures initialize from the manifest: baseline first, Track B inbound -> staff_replies -> dispatch_fence, baseline again, gate last",
    fixturesUseManifest && plan[0] === "security/office-security-baseline.sql" && plan.at(-2) === "security/office-security-baseline.sql" && plan.at(-1) === "security/office-security-verify.sql" &&
    i("20261113_meta_social_inbound.sql") < i("20261113_meta_social_staff_replies.sql") && i("20261113_meta_social_staff_replies.sql") < i("20261113_meta_social_dispatch_fence.sql") &&
    !plan.includes("20261101_office_intake_receipts.sql") && unknownRefused);
  const scriptsJson = require(path.join(ROOT, "package.json")).scripts;
  check("LG4", "crm:apply-schema still points at the (now guarded) maintenance script", scriptsJson["crm:apply-schema"] === "node scripts/apply-supabase-schema.js");
  const refused = (url) => { try { legacy.maintenanceTarget(url); return false; } catch { return true; } };
  const base = "postgres://postgres:x@db.example.internal:5432/postgres";
  check("LG5", "crm:apply-schema refuses URL overrides, several hosts and sockets; accepts only ?sslmode=",
    ["?host=203.0.113.10", "?hostaddr=203.0.113.10", "?service=prod", "?options=-c%20role%3Dx", "#x"].every((q) => refused(base + q)) &&
    refused("postgres://postgres:x@a.example,b.example:5432/postgres") && refused("postgres://postgres:x@/postgres?host=/var/run/postgresql") && refused("") &&
    !refused(base) && !refused(base + "?sslmode=require") && legacy.maintenanceTarget(base + "?sslmode=require").host === "db.example.internal");
}

async function databaseChecks() {
  if (sh("docker", ["image", "inspect", PG_IMAGE]).status !== 0) { console.log(`SKIP: docker image ${PG_IMAGE} not available`); return; }
  const port = await freePort();
  const r = sh("docker", ["run", "-d", "--rm", "--name", PG, "-p", `127.0.0.1:${port}:5432`, "-e", `POSTGRES_PASSWORD=${PW}`, PG_IMAGE]);
  if (r.status !== 0) throw new Error("BLOCKED: postgres container: " + r.stderr);
  let good = 0;
  for (let i = 0; i < 400 && good < 3; i += 1) { const x = sh("docker", ["exec", PG, "psql", "-X", "-At", "-U", "postgres", "-h", "127.0.0.1", "-c", "select count(*) from pg_roles where rolname in ('anon','authenticated','service_role','authenticator')"]); good = x.stdout && x.stdout.trim() === "4" ? good + 1 : 0; await sleep(300); }
  if (good < 3) throw new Error("BLOCKED: postgres not ready");
  const url = `postgres://postgres:${PW}@127.0.0.1:${port}/postgres`;
  const legacyRun = (argv) => attempt(() => legacy.run({ url, argv, ssl: false, log: () => {} }));
  const tables = () => one("select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','p')");

  // ---- fresh database: the legacy path must not create an unhardened schema ----
  const dry = await legacyRun([]);
  const applyFresh = await legacyRun(["--apply", "--confirm-target", "127.0.0.1"]);
  check("LG6", "crm:apply-schema refuses a FRESH database (dry run and --apply); nothing is created", !dry.ok && !applyFresh.ok && /fresh database/.test(applyFresh.error) && tables() === "0", { dry, applyFresh, tables: tables() });

  // ---- initialized database ----
  const initialized = await attempt(() => init({ url, mode: "fresh", log: () => {} }));
  check("LG7", "fresh initialization through the approved initializer succeeds", initialized.ok, initialized.error);
  const s0 = one(SNAPSHOT);
  const noConfirm = await legacyRun(["--apply"]);
  const wrongConfirm = await legacyRun(["--apply", "--confirm-target", "db.example.internal"]);
  check("LG8", "--apply without, or with a different, --confirm-target is refused before connecting; nothing changes",
    !noConfirm.ok && !wrongConfirm.ok && /confirm-target/.test(noConfirm.error) && /confirm-target/.test(wrongConfirm.error) && one(SNAPSHOT) === s0);
  const dryRun = await legacyRun([]);
  check("LG9", "default is a read-only dry run: reports 0 security violations and changes nothing", dryRun.ok && dryRun.value.mode === "dry-run" && dryRun.value.before.length === 0 && one(SNAPSHOT) === s0, dryRun);
  sh("docker", ["exec", PG, "psql", "-X", "-U", "supabase_admin", "-d", "postgres", "-h", "127.0.0.1", "-c", `alter role authenticator with password '${PW}'`]);
  const asAuth = new URL(url); asAuth.username = "authenticator";
  const nonOwner = await attempt(() => legacy.run({ url: asAuth.toString(), argv: ["--apply", "--confirm-target", "127.0.0.1"], ssl: false, log: () => {} }));
  check("LG10", "--apply as a non-owner role is refused", !nonOwner.ok && /not postgres/.test(nonOwner.error), nonOwner);
  const applied = await legacyRun(["--apply", "--confirm-target", "127.0.0.1"]);
  check("LG11", "maintenance --apply on an initialized database: schema re-applied, 0 violations, privileges and the dispatch fence unchanged",
    applied.ok && applied.value.after.length === 0 && one(SNAPSHOT) === s0 && one(FENCED) === "t" && psql(fs.readFileSync(path.join(ROOT, "db", "security", "office-security-verify.sql"), "utf8")).status === 0, applied);

  // ---- a table the schema re-creates is secured; anything else that would add a violation is rolled back ----
  psql("drop table public.ochiga_workflow_links");
  const recreated = await legacyRun(["--apply", "--confirm-target", "127.0.0.1"]);
  check("LG12", "an apply that creates a table secures only that table (RLS on, no anon/authenticated/PUBLIC) and keeps 0 violations",
    recreated.ok && recreated.value.securedNewTables === 1 && recreated.value.after.length === 0 &&
    one("select relrowsecurity and not has_table_privilege('anon', oid, 'SELECT') and has_table_privilege('service_role', oid, 'SELECT') from pg_class where oid = 'public.ochiga_workflow_links'::regclass") === "t", recreated);
  psql("alter default privileges for role postgres in schema public grant select on tables to anon");
  const before = one(SNAPSHOT);
  const unsafe = await attempt(() => legacy.run({ url, argv: ["--apply", "--confirm-target", "127.0.0.1"], ssl: false, log: () => {},
    schemaSql: "grant select on public.leads to anon; create table public.lg_exposed (id int)" }));
  check("LG13", "an apply that would add a violation is rolled back entirely; the pre-existing violation is only reported",
    !unsafe.ok && /rolled back/.test(unsafe.error) && one("select to_regclass('public.lg_exposed') is null and not has_table_privilege('anon','public.leads','SELECT')") === "t" && one(SNAPSHOT) === before, unsafe);
  const repaired = await attempt(() => init({ url, mode: "reassert", log: () => {} }));
  check("LG13b", "the baseline repairs the pre-existing drift; maintenance apply then reports 0 violations", repaired.ok && (await legacyRun(["--apply", "--confirm-target", "127.0.0.1"])).value?.after.length === 0, repaired);

  // ---- the hazard the manifest removes ----
  psql("create database legacy_order", "postgres");
  const top = fs.readdirSync(path.join(ROOT, "db")).filter((f) => /^\d.*\.sql$/.test(f)).sort();
  const order = ["lead-agents-schema.sql", ...top];
  const failed = order.map((f) => ({ f, r: psql(fs.readFileSync(path.join(ROOT, "db", f), "utf8"), "legacy_order") })).filter((x) => x.r.status !== 0);
  check("LG14", "filename order (the removed legacy fixture path) replaces the fenced receipt function; the manifest keeps it",
    failed.length === 0 && one(FENCED, "legacy_order") === "f" && one(FENCED) === "t", failed.map((x) => x.f));
}

(async () => {
  staticChecks();
  try { await databaseChecks(); } catch (error) { check("LG--", "database checks completed", false, error.message); }
  finally { sh("docker", ["rm", "-f", PG]); }
  console.log(`\n${checks - failures}/${checks} checks passed`);
  console.log(failures ? "Office legacy database entry points: FAIL" : "Office legacy database entry points: PASS");
  process.exit(failures ? 1 : 0);
})();
