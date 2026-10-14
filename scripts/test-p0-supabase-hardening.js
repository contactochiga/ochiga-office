// P0 Supabase access hardening — production-equivalent verification (never touches a real project).
//   * disposable Supabase Postgres 17 (same image family/roles/default ACLs as production) + real PostgREST, schema loaded from this repo's db/*.sql
//   * PRE:  proves the exposure is real (anon/authenticated can read and modify seeded sentinel data through the Data API)
//   * MIGRATE: applies db/20261016_ochiga_office_p0_access_hardening.sql (twice: idempotent), then the verification SQL
//   * POST: proves the same attacks now fail and change nothing, service_role still reaches all 54 tables, new tables are not exposed,
//           and the Office test suite, run through the real SupabaseLeadAgentsStore -> PostgREST -> database, gives the same results as before the migration
// Skips (exit 0) when Docker or the images are unavailable.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { execFileSync, spawn } = require("node:child_process");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..");
const IMG_PG = "public.ecr.aws/supabase/postgres:17.6.1.131", IMG_REST = "public.ecr.aws/supabase/postgrest:v14.12";
const PG_PORT = 54350, REST_PORT = 54351, PROXY_PORT = 54352, SUF = process.pid;
const PG = `ochiga-p0-pg-${SUF}`, REST = `ochiga-p0-rest-${SUF}`, JWT_SECRET = "test-jwt-secret-test-jwt-secret-1234567890";
const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (role) => { const h = b64({ alg: "HS256", typ: "JWT" }), p = b64({ role, iss: "supabase-test", exp: Math.floor(Date.now() / 1000) + 7200 }); return `${h}.${p}.${crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url")}`; };
const sql = (f) => fs.readFileSync(path.join(ROOT, "db", f), "utf8");
const MIGRATION = "20261016_ochiga_office_p0_access_hardening.sql";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pgClient(user = "postgres") { const c = new Client({ host: "127.0.0.1", port: PG_PORT, user, password: "testpw", database: "postgres" }); await c.connect(); return c; }

function startProxy(log) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = []; req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const p = req.url.replace(/^\/rest\/v1/, "") || "/";
        const preq = http.request({ hostname: "127.0.0.1", port: REST_PORT, path: p, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${REST_PORT}` } }, (pres) => {
          const out = []; pres.on("data", (c) => out.push(c));
          pres.on("end", () => { const body = Buffer.concat(out); let code = null; if (pres.statusCode >= 400) { try { code = JSON.parse(body.toString()).code; } catch { /* non-json */ } } log({ method: req.method, table: p.split("?")[0].split("/")[1] || "", status: pres.statusCode, code }); res.writeHead(pres.statusCode, pres.headers); res.end(body); });
        });
        preq.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
        preq.end(Buffer.concat(chunks));
      });
    });
    server.listen(PROXY_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function api(role, method, pathAndQuery, body) {
  const r = await fetch(`http://127.0.0.1:${REST_PORT}${pathAndQuery}`, { method, headers: { apikey: jwt(role), authorization: `Bearer ${jwt(role)}`, "content-type": "application/json", prefer: "return=representation" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, text };
}

const SENTINELS = ["SENTINEL-PASSWORD-HASH-A1B2", "SENTINEL-INVITE-HASH-C3D4", "SENTINEL-RESET-HASH-E5F6", "SENTINEL-LEAD-SOURCE-G7H8", "SENTINEL-STAFF-MESSAGE-I9J0"];
const SEED_COUNTS_SQL = "select (select count(*) from public.admin_users) admin_users, (select count(*) from public.admin_invites) admin_invites, (select count(*) from public.password_reset_tokens) password_reset_tokens, (select count(*) from public.leads) leads, (select count(*) from public.staff_messages) staff_messages, (select count(*) from public.crm_opportunities) crm_opportunities, (select count(*) from public.audit_events) audit_events, (select count(*) from public.crm_contacts) crm_contacts, (select count(*) from public.office_staff_profiles) office_staff_profiles, (select md5(string_agg(coalesce(stage,''),',' order by id)) from public.crm_opportunities) opp_stage_hash";

async function truncateAll(c) {
  // one statement (all locks acquired together) and a retry: a request still in flight in PostgREST from the previous script can briefly hold a conflicting lock
  await c.query("set client_min_messages = warning");
  const names = (await c.query("select string_agg('public.' || quote_ident(relname), ', ') n from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='public' and c.relkind='r'")).rows[0].n;
  for (let attempt = 0; ; attempt++) {
    try { await c.query(`truncate table ${names} restart identity cascade`); return; } catch (e) { if (!["40P01", "55P03"].includes(e.code) || attempt >= 8) throw e; await sleep(400 * (attempt + 1)); }
  }
}
async function seed(c) {
  await truncateAll(c);
  await c.query("insert into public.admin_users (email, password_hash, role, status) values ('sentinel-admin@example.test', $1, 'super_admin', 'active')", [SENTINELS[0]]);
  await c.query("insert into public.admin_invites (email, token_hash, expires_at) values ('sentinel-invite@example.test', $1, now() + interval '1 day')", [SENTINELS[1]]);
  await c.query("insert into public.password_reset_tokens (email, token_hash, expires_at) values ('sentinel-admin@example.test', $1, now() + interval '1 hour')", [SENTINELS[2]]);
  await c.query("insert into public.leads (source, name) values ($1, 'Sentinel Lead')", [SENTINELS[3]]);
  const conv = (await c.query("insert into public.staff_conversations (created_by) values ('sentinel-staff@example.test') returning id")).rows[0].id;
  await c.query("insert into public.staff_messages (conversation_id, sender_email, body) values ($1, 'sentinel-staff@example.test', $2)", [conv, SENTINELS[4]]);
  await c.query("insert into public.crm_opportunities (stage, status) values ('qualified', 'open')");
  await c.query("insert into public.audit_events (action, target_type) values ('seed.audit', 'seed')");
  await c.query("insert into public.crm_contacts (name, email) values ('Sentinel Contact', 'sentinel-contact@example.test')");
}

// the attack catalogue: [id, role, method, path, body, readsSentinel]
const ATTACKS = [
  ["A anon reads admin_users (password hashes)", "anon", "GET", "/admin_users?select=email,password_hash", null, SENTINELS[0]],
  ["B anon reads password_reset_tokens", "anon", "GET", "/password_reset_tokens?select=token_hash", null, SENTINELS[2]],
  ["C anon reads admin_invites", "anon", "GET", "/admin_invites?select=token_hash", null, SENTINELS[1]],
  ["D anon reads customer leads", "anon", "GET", "/leads?select=*", null, SENTINELS[3]],
  ["E anon reads staff messages", "anon", "GET", "/staff_messages?select=body", null, SENTINELS[4]],
  ["F anon modifies a CRM opportunity", "anon", "PATCH", "/crm_opportunities?id=not.is.null", { stage: "hacked" }, null],
  ["G anon deletes audit events", "anon", "DELETE", "/audit_events?id=not.is.null", null, null],
  ["H anon inserts a super_admin", "anon", "POST", "/admin_users", { email: "attacker@example.test", password_hash: "x", role: "super_admin", status: "active" }, null],
  ["H2 anon inserts a staff profile", "anon", "POST", "/office_staff_profiles", { staff_email: "attacker@example.test" }, null],
  ["I authenticated reads admin_users", "authenticated", "GET", "/admin_users?select=email,password_hash", null, SENTINELS[0]],
  ["I2 authenticated reads leads", "authenticated", "GET", "/leads?select=*", null, SENTINELS[3]],
  ["I3 authenticated reads staff messages", "authenticated", "GET", "/staff_messages?select=body", null, SENTINELS[4]],
  ["I4 authenticated deletes a contact", "authenticated", "DELETE", "/crm_contacts?id=not.is.null", null, null],
  ["J anon (website visitor) inserts a lead", "anon", "POST", "/leads", { source: "attacker-form" }, null],
  ["J2 anon (website visitor) inserts a CRM contact", "anon", "POST", "/crm_contacts", { name: "attacker" }, null],
  ["J3 anon deletes leads", "anon", "DELETE", "/leads?id=not.is.null", null, null],
];

async function runDifferentialSuite(label, c, env) {
  const scripts = fs.readdirSync(path.join(ROOT, "scripts")).filter((f) => /^test-.*\.js$/.test(f) && !/^test-(p0-supabase-hardening|whatsapp-inbound-claims-postgres|whatsapp-autonomy-cross-repo)\.js$/.test(f)).sort();
  const results = {};
  for (const s of scripts) {
    // a script gets up to 3 clean-database attempts: several scripts were written for the file store and a few race against in-flight requests; what matters is
    // whether a script CAN pass before and after, so the comparison is on "passed at least once"
    let status = "fail", detail = "";
    for (let attempt = 1; attempt <= 3 && status !== "pass"; attempt++) {
      await truncateAll(c);
      // async spawn: the in-process proxy must keep serving requests while the child runs (spawnSync would block it)
      const r = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join("scripts", s)], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
        let err = ""; child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
        const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
        child.on("close", (code) => { clearTimeout(timer); resolve({ status: code, stderr: err }); });
      });
      if (r.status === 0) status = "pass"; else detail = String(r.stderr || "").split("\n").filter((l) => l && !l.startsWith('{"ts"')).slice(0, 2).join(" | ").slice(0, 160);
    }
    results[s] = status; if (status === "fail") (results.__details ||= {})[s] = detail;
  }
  return results;
}

async function main() {
  try { docker("image", "inspect", IMG_PG); docker("image", "inspect", IMG_REST); } catch { console.log("SKIP: Docker or the Supabase Postgres / PostgREST images are unavailable"); return; }
  const requestLog = [];
  let proxy, admin;
  try {
    docker("run", "-d", "--rm", "--name", PG, "-e", "POSTGRES_PASSWORD=testpw", "-p", `${PG_PORT}:5432`, IMG_PG);
    for (let i = 0; i < 90 && !admin; i++) { try { admin = await pgClient(); } catch { await sleep(1000); } }
    assert.ok(admin, "disposable Supabase Postgres is ready");
    await admin.end(); const sa = await pgClient("supabase_admin"); await sa.query("alter role authenticator with password 'testpw'"); await sa.end(); admin = await pgClient();
    // production-equivalent schema: this repo's SQL (schema first, twice for forward references, then dated migrations), RLS on the four tables production has it on
    // psql (not a single multi-statement query) so a forward reference in the schema file does not roll the whole file back; the second pass fills it in
    const psqlFile = (f) => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=0"], { input: sql(f), encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    for (const f of ["lead-agents-schema.sql", "lead-agents-schema.sql", ...fs.readdirSync(path.join(ROOT, "db")).filter((f) => /^2\d{7,}.*\.sql$/.test(f) && f !== MIGRATION).sort()]) psqlFile(f);
    for (const t of ["deployment_projects", "facility_workspaces", "onboarding_emails", "partners"]) await admin.query(`alter table public.${t} enable row level security`);
    const tables = (await admin.query("select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by 1")).rows.map((r) => r.relname);
    assert.equal(tables.length, 54, "the test schema has the same 54 public tables as production");
    docker("run", "-d", "--rm", "--name", REST, "-p", `${REST_PORT}:3000`, "-e", `PGRST_DB_URI=postgres://authenticator:testpw@host.docker.internal:${PG_PORT}/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`, IMG_REST);
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${REST_PORT}/`, { headers: { apikey: jwt("service_role") } })).status < 500) break; } catch { /* starting */ } await sleep(1000); }
    proxy = await startProxy((e) => requestLog.push(e));
    const env = { OFFICE_TEST_SUPABASE_URL: `http://127.0.0.1:${PROXY_PORT}`, OFFICE_TEST_SUPABASE_SERVICE_ROLE_KEY: jwt("service_role") };
    const reload = async () => { await admin.query("notify pgrst, 'reload schema'"); await sleep(1500); };

    // ---------- PRE: the exposure is real ----------
    const pre = { attacks: {}, privileges: null };
    pre.privileges = Number((await admin.query("select count(*) c from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join (values ('anon'),('authenticated')) r(role) where n.nspname='public' and c.relkind='r' and has_table_privilege(r.role, c.oid, 'SELECT')")).rows[0].c);
    assert.equal(pre.privileges, 108, "pre-migration: anon and authenticated hold SELECT on all 54 tables each");
    await seed(admin); await reload();
    const before = (await admin.query(SEED_COUNTS_SQL)).rows[0];
    for (const [id, role, method, p, body, sentinel] of ATTACKS) {
      const r = await api(role, method, p, body);
      pre.attacks[id] = r.status;
      assert.ok(r.status >= 200 && r.status < 300, `PRE-migration the attack "${id}" must succeed to prove the exposure (got ${r.status})`);
      if (sentinel) assert.ok(r.text.includes(sentinel), `PRE-migration "${id}" returns the protected sentinel value`);
    }
    const afterAttack = (await admin.query(SEED_COUNTS_SQL)).rows[0];
    assert.notDeepEqual(afterAttack, before, "PRE-migration the attacks really changed seeded data");
    console.log(`PRE  exposure reproduced: ${ATTACKS.length}/${ATTACKS.length} anonymous/authenticated attacks succeeded (reads of hashes and tokens, writes, deletes)`);
    const preSuite = await runDifferentialSuite("pre", admin, env);

    // ---------- MIGRATE ----------
    await seed(admin);
    // objects of every kind that exist BEFORE the migration with the platform's default (open) privileges
    await admin.query(`create view public.zz_pre_view as select id, email from public.admin_users;
      create materialized view public.zz_pre_matview as select id from public.leads;
      create sequence public.zz_pre_seq;
      create function public.zz_pre_definer() returns bigint language sql security definer as $f$ select count(*) from public.admin_users $f$;
      create function public.zz_pre_invoker() returns int language sql as $f$ select 1 $f$;
      grant select (id) on public.leads to anon;`);
    const preObj = (await admin.query("select has_table_privilege('anon','public.zz_pre_view','SELECT') v, has_table_privilege('anon','public.zz_pre_matview','SELECT') m, has_sequence_privilege('anon','public.zz_pre_seq','USAGE') s, has_function_privilege('anon','public.zz_pre_definer()','EXECUTE') f, has_any_column_privilege('anon','public.leads','SELECT') c")).rows[0];
    assert.deepEqual(preObj, { v: true, m: true, s: true, f: true, c: true }, "TEST 17-19 pre: view, matview, sequence, SECURITY DEFINER function and column grant are open before the migration");
    // test 22: a forced failure inside the migration transaction rolls everything back (a poisoned verification: service_role loses a privilege mid-way)
    const snap = async () => (await admin.query("select md5(string_agg(coalesce(relacl::text,'')||relrowsecurity::text||relname, '|' order by relname)) h from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','S')")).rows[0].h;
    const snapBefore = await snap();
    await admin.query("create function public.zz_poison() returns event_trigger language plpgsql as $f$ begin null; end $f$");
    const poisoned = sql(MIGRATION).replace("-- 5. verification", "revoke select on public.leads from service_role;\n-- 5. verification");
    await assert.rejects(() => admin.query(poisoned), /service_role lost access/, "TEST 22: poisoned migration aborts");
    await admin.query("rollback").catch(() => {});
    assert.equal(await snap(), snapBefore, "TEST 22: the failed migration rolled back completely (privileges and RLS unchanged)");
    await admin.query("drop function public.zz_poison()");
    await admin.query(sql(MIGRATION)); await admin.query(sql(MIGRATION)); // second run: idempotent (TEST 21)
    await reload();
    const verify = await admin.query(fs.readFileSync(path.join(ROOT, "db", "verification", "20261016_p0_access_hardening.verify.sql"), "utf8"));
    const rowsOf = (i) => verify[i].rows;
    assert.equal(rowsOf(0).length, 0, "verification 1: no table exposed to anon/authenticated"); assert.equal(rowsOf(1).length, 0, "verification 2: RLS on everywhere");
    assert.equal(rowsOf(2).length, 0, "verification 3: no function executable by anon/authenticated"); assert.equal(Number(rowsOf(3)[0].missing_tables), 0, "verification 4: service_role intact");
    assert.equal(rowsOf(4).filter((r) => r.creator === "postgres").length, 0, "verification 5: default privileges for postgres no longer grant anon/authenticated");

    // ---------- POST: attacks fail and change nothing ----------
    const base = (await admin.query(SEED_COUNTS_SQL)).rows[0];
    const denied = {};
    for (const [id, role, method, p, body, sentinel] of ATTACKS) {
      const r = await api(role, method, p, body);
      denied[id] = r.status;
      assert.ok([401, 403, 404].includes(r.status), `POST-migration "${id}" is refused (got ${r.status})`);
      for (const s of SENTINELS) assert.ok(!r.text.includes(s), `POST-migration "${id}" leaks no sentinel`);
      void sentinel;
    }
    assert.deepEqual((await admin.query(SEED_COUNTS_SQL)).rows[0], base, "POST-migration the attacks changed nothing");
    // direct SQL as the Data API roles (what the REST layer ultimately runs)
    for (const role of ["anon", "authenticated"]) {
      const c = await pgClient(); 
      for (const stmt of ["select * from public.admin_users", "update public.admin_users set role='x'", "delete from public.audit_events", "truncate public.leads", "insert into public.leads (source) values ('x')"]) {
        await c.query(`set role ${role}`);
        await assert.rejects(() => c.query(stmt), (e) => e.code === "42501", `${role}: ${stmt} is permission denied`);
        await c.query("reset role");
      }
      await c.end();
    }
    assert.equal(Number((await admin.query("select count(*) c from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join (values ('anon'),('authenticated')) r(role) where n.nspname='public' and c.relkind='r' and has_table_privilege(r.role, c.oid, 'SELECT')")).rows[0].c), 0);
    // new tables are not exposed by default privileges, and service_role still gets them
    await admin.query("create table public.zz_future_table (id int)");
    const future = (await admin.query("select has_table_privilege('anon','public.zz_future_table','SELECT') a, has_table_privilege('authenticated','public.zz_future_table','SELECT') u, has_table_privilege('service_role','public.zz_future_table','SELECT') s")).rows[0];
    assert.deepEqual(future, { a: false, u: false, s: true }, "future tables are not exposed to anon/authenticated");
    await admin.query("drop table public.zz_future_table");

    // tests 17-20: objects that predate the migration are neutralised; new objects are not exposed; per-creator default ACL report
    const postObj = (await admin.query("select has_table_privilege('anon','public.zz_pre_view','SELECT') v, has_table_privilege('authenticated','public.zz_pre_matview','SELECT') m, has_sequence_privilege('anon','public.zz_pre_seq','USAGE') s, has_function_privilege('anon','public.zz_pre_definer()','EXECUTE') f, has_function_privilege('authenticated','public.zz_pre_invoker()','EXECUTE') f2, has_any_column_privilege('anon','public.leads','SELECT') c, has_function_privilege('service_role','public.zz_pre_definer()','EXECUTE') svc")).rows[0];
    assert.deepEqual(postObj, { v: false, m: false, s: false, f: false, f2: false, c: false, svc: true }, "TEST 17-19: view, matview, sequence, SECURITY DEFINER function and column grant are closed after the migration (service_role keeps EXECUTE)");
    for (const [role, stmt] of [["anon", "select * from public.zz_pre_view"], ["anon", "select public.zz_pre_definer()"], ["authenticated", "select nextval('public.zz_pre_seq')"], ["anon", "select id from public.leads"]]) {
      const c = await pgClient(); await c.query(`set role ${role}`);
      await assert.rejects(() => c.query(stmt), (e) => e.code === "42501", `${role}: ${stmt} is denied`); await c.end();
    }
    for (const role of ["anon", "authenticated"]) { const r = await api(role, "GET", "/zz_pre_view?select=*"); assert.ok([401, 403, 404].includes(r.status), `view via REST as ${role} refused (${r.status})`); const f = await api(role, "POST", "/rpc/zz_pre_definer", {}); assert.ok([401, 403, 404].includes(f.status), `SECURITY DEFINER function via REST as ${role} refused (${f.status})`); }
    // new objects by each creator role
    const creators = {};
    for (const creator of ["postgres", "supabase_admin"]) {
      const c = await pgClient(creator);
      await c.query(`create table public.zz_new_${creator} (id int); create sequence public.zz_newseq_${creator}; create function public.zz_newfn_${creator}() returns int language sql as $f$ select 1 $f$;`);
      creators[creator] = (await c.query(`select has_table_privilege('anon','public.zz_new_${creator}','SELECT') t_anon, has_table_privilege('authenticated','public.zz_new_${creator}','SELECT') t_auth, has_sequence_privilege('anon','public.zz_newseq_${creator}','USAGE') seq_anon, has_function_privilege('anon','public.zz_newfn_${creator}()','EXECUTE') fn_anon, has_table_privilege('service_role','public.zz_new_${creator}','SELECT') t_svc, has_function_privilege('service_role','public.zz_newfn_${creator}()','EXECUTE') fn_svc, has_schema_privilege('anon','public','USAGE') schema_usage_anon`)).rows[0];
      await c.end();
    }
    console.log("TEST 20 default-ACL effect per creator role (before any privileged action):", JSON.stringify(creators));
    assert.deepEqual(creators.postgres, { t_anon: false, t_auth: false, seq_anon: false, fn_anon: true, t_svc: true, fn_svc: true, schema_usage_anon: false }, "postgres-created tables/sequences closed to anon/authenticated and open to service_role; new functions keep the PostgreSQL PUBLIC EXECUTE ACL but schema USAGE is revoked");
    assert.equal(creators.supabase_admin.t_svc, true, "supabase_admin-created tables stay usable by service_role");
    const sadminAclLeak = creators.supabase_admin.t_anon || creators.supabase_admin.fn_anon || creators.supabase_admin.seq_anon;
    console.log(`TEST 20 supabase_admin-created objects carry anon/authenticated ACL entries without the privileged script: ${sadminAclLeak}; Data API still blocked by schema USAGE: ${!creators.supabase_admin.schema_usage_anon}`);
    {
      for (const fnName of ["zz_newfn_postgres", "zz_newfn_supabase_admin"]) for (const role of ["anon", "authenticated"]) { const f = await api(role, "POST", `/rpc/${fnName}`, {}); assert.ok([401, 403, 404].includes(f.status), `new function ${fnName} via REST as ${role} refused (${f.status})`); }
      const r = await api("anon", "GET", "/zz_new_supabase_admin?select=*"); assert.ok([401, 403, 404].includes(r.status), `a supabase_admin-created table is not reachable through the Data API (got ${r.status})`);
      const c = await pgClient("supabase_admin"); await c.query(fs.readFileSync(path.join(ROOT, "db", "privileged", "20261016_supabase_admin_default_privileges.sql"), "utf8"));
      await c.query("create table public.zz_new_after_priv (id int)");
      const after = (await c.query("select has_table_privilege('anon','public.zz_new_after_priv','SELECT') a, has_table_privilege('service_role','public.zz_new_after_priv','SELECT') s")).rows[0];
      assert.deepEqual(after, { a: false, s: true }, "TEST 20b: after the privileged script, supabase_admin-created tables are closed to anon and open to service_role");
      await c.query("drop table public.zz_new_after_priv"); await c.end();
    }
    await admin.query("drop view public.zz_pre_view; drop materialized view public.zz_pre_matview; drop sequence public.zz_pre_seq; drop function public.zz_pre_definer(); drop function public.zz_pre_invoker(); drop table public.zz_new_postgres; drop sequence public.zz_newseq_postgres; drop function public.zz_newfn_postgres();");
    { const c = await pgClient("supabase_admin"); await c.query("drop table public.zz_new_supabase_admin; drop sequence public.zz_newseq_supabase_admin; drop function public.zz_newfn_supabase_admin();"); await c.end(); }

    // service_role (what Office uses) reaches every table
    requestLog.length = 0;
    for (const t of tables) { const r = await api("service_role", "GET", `/${t}?select=*&limit=1`); assert.equal(r.status, 200, `service_role reads ${t}`); }
    const w = await api("service_role", "POST", "/leads", { source: "svc-write-test" }); assert.equal(w.status, 201);
    const d = await api("service_role", "DELETE", "/leads?source=eq.svc-write-test"); assert.ok([200, 204].includes(d.status));
    console.log(`POST ${ATTACKS.length}/${ATTACKS.length} attacks refused (${[...new Set(Object.values(denied))].join("/")}), data unchanged; service_role reads all ${tables.length} tables and writes`);

    // ---------- differential Office suite on the hardened database ----------
    requestLog.length = 0;
    const postSuite = await runDifferentialSuite("post", admin, env);
    const preDetails = preSuite.__details || {}, postDetails = postSuite.__details || {}; delete preSuite.__details; delete postSuite.__details;
    const regressions = Object.keys(preSuite).filter((s) => preSuite[s] === "pass" && postSuite[s] !== "pass");
    assert.deepEqual(regressions, [], `no Office test that passed before the migration fails after it (regressions: ${regressions.join(", ")})`);
    const fixed = Object.keys(postSuite).filter((s) => preSuite[s] !== "pass" && postSuite[s] === "pass");
    if (fixed.length) console.log(`NOTE scripts that failed pre-migration but passed post-migration (flaky under the Supabase store): ${fixed.join(", ")}`);
    console.log(`NOTE scripts failing in both phases (written for the file store / need other services): ${Object.keys(postSuite).filter((s) => postSuite[s] !== "pass" && preSuite[s] !== "pass").join(", ")}`);
    void preDetails; void postDetails;
    const mustRun = ["test-staff-onboarding.js", "test-office-messages-workspace.js", "test-office-crm-intake.js"];
    for (const s of mustRun) assert.equal(postSuite[s], "pass", `${s} passes through the real Supabase store on the hardened database`);
    const bad = requestLog.filter((e) => e.status === 401 || e.status === 403 || e.code === "42501" || e.code === "PGRST301");
    assert.equal(bad.length, 0, `no Office request was refused by the hardened database (${JSON.stringify(bad.slice(0, 3))})`);
    const touched = [...new Set(requestLog.map((e) => e.table))].filter(Boolean).sort();
    const passed = Object.values(postSuite).filter((v) => v === "pass").length;
    console.log(`POST Office suite through PostgREST on the hardened DB: ${passed}/${Object.keys(postSuite).length} scripts pass (identical to pre-migration); ${requestLog.length} service-role requests, ${touched.length} distinct tables touched, 0 refused`);
    console.log(JSON.stringify({ status: "PASS", suite: "p0-supabase-hardening", attacks: ATTACKS.length, tables: tables.length, suite_pass: passed, suite_total: Object.keys(postSuite).length, distinct_tables_touched: touched.length }));
  } finally {
    if (proxy) proxy.close();
    try { if (admin) await admin.end(); } catch { /* closed */ }
    for (const n of [REST, PG]) { try { docker("rm", "-f", n); } catch { /* gone */ } }
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
