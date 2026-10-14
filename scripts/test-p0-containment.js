// Tests the emergency containment (db/emergency/20261016_p0_containment_revoke_only.sql) on a disposable Supabase Postgres, separately from the full migration.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Client } = require("pg");
const ROOT = path.join(__dirname, "..");
const IMG = "public.ecr.aws/supabase/postgres:17.6.1.131", PORT = 54360, NAME = `ochiga-p0-contain-${process.pid}`;
const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = async (user = "postgres") => { const c = new Client({ host: "127.0.0.1", port: PORT, user, password: "testpw", database: "postgres" }); await c.connect(); return c; };
(async () => {
  try { docker("image", "inspect", IMG); } catch { console.log("SKIP: image unavailable"); return; }
  let admin;
  try {
    docker("run", "-d", "--rm", "--name", NAME, "-e", "POSTGRES_PASSWORD=testpw", "-p", `${PORT}:5432`, IMG);
    for (let i = 0; i < 90 && !admin; i++) { try { admin = await client(); } catch { await sleep(1000); } }
    const psql = (text) => execFileSync("docker", ["exec", "-i", NAME, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=0"], { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    const files = ["lead-agents-schema.sql", "lead-agents-schema.sql", ...fs.readdirSync(path.join(ROOT, "db")).filter((f) => /^2\d{7,}.*\.sql$/.test(f) && !/p0_access_hardening/.test(f)).sort()];
    for (const f of files) psql(fs.readFileSync(path.join(ROOT, "db", f), "utf8"));
    await admin.query(`create view public.zz_view as select id from public.leads; create function public.zz_definer() returns bigint language sql security definer as $f$ select count(*) from public.leads $f$; grant select (id) on public.leads to anon; insert into public.leads (source) values ('contain-seed')`);
    const probe = async () => (await admin.query(`select
      (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join (values ('anon'),('authenticated')) r(x) cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(y) where n.nspname='public' and c.relkind in ('r','v','m') and has_table_privilege(r.x,c.oid,p.y)) table_privs,
      (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','v') and (has_any_column_privilege('anon',c.oid,'SELECT') or has_any_column_privilege('authenticated',c.oid,'SELECT'))) column_privs,
      (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','v','m','S') and exists (select 1 from aclexplode(c.relacl) a where a.grantee=0)) public_grants,
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))) fn_exec,
      (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity) tables_without_rls,
      (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not (has_table_privilege('service_role',c.oid,'SELECT') and has_table_privilege('service_role',c.oid,'INSERT') and has_table_privilege('service_role',c.oid,'UPDATE') and has_table_privilege('service_role',c.oid,'DELETE'))) svc_missing,
      has_function_privilege('service_role','public.zz_definer()','EXECUTE') svc_fn,
      has_table_privilege('anon','public.zz_view','SELECT') view_anon`)).rows[0];
    const before = await probe(); assert.ok(Number(before.table_privs) > 0 && before.view_anon);
    await admin.query(fs.readFileSync(path.join(ROOT, "db", "emergency", "20261016_p0_containment_revoke_only.sql"), "utf8"));
    await admin.query(fs.readFileSync(path.join(ROOT, "db", "emergency", "20261016_p0_containment_revoke_only.sql"), "utf8")); // idempotent
    const after = await probe();
    console.log("BEFORE", JSON.stringify(before)); console.log("AFTER ", JSON.stringify(after));
    assert.equal(Number(after.table_privs), 0, "no anon/authenticated table privileges"); assert.equal(Number(after.column_privs), 0, "no column privileges");
    assert.equal(Number(after.public_grants), 0); assert.equal(Number(after.svc_missing), 0, "service_role intact"); assert.equal(after.svc_fn, true, "service_role keeps function EXECUTE"); assert.equal(after.view_anon, false);
    console.log(`INFO functions still executable by anon/authenticated after containment (PUBLIC EXECUTE): ${after.fn_exec}; tables without RLS after containment: ${after.tables_without_rls} (containment does not enable RLS)`);
    for (const role of ["anon", "authenticated"]) for (const stmt of ["select * from public.admin_users", "select * from public.zz_view", "delete from public.leads", "truncate public.leads"]) {
      const c = await client(); await c.query(`set role ${role}`); await assert.rejects(() => c.query(stmt), (e) => e.code === "42501", `${role}: ${stmt}`); await c.end();
    }
    const s = await client(); await s.query("set role service_role"); assert.equal((await s.query("select count(*)::int c from public.leads where source='contain-seed'")).rows[0].c, 1); await s.query("insert into public.leads (source) values ('svc')"); await s.query("delete from public.leads where source='svc'"); await s.end();
    console.log(JSON.stringify({ status: "PASS", suite: "p0-containment" }));
  } finally { try { if (admin) await admin.end(); } catch {} try { docker("rm", "-f", NAME); } catch {} }
})().catch((e) => { console.error(e); process.exit(1); });
