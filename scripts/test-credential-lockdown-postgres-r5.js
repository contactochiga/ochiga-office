// S7 R5: H1 reproduction and remediation proof against DISPOSABLE Postgres + PostgREST only (never a real project). Credential VALUES are never printed:
// checks record status codes, row counts and booleans. Reuses the frozen certification harness read-only (no corpus file is modified).
// Phase 1 reproduces H1 on the schema WITHOUT the R5 migration; phase 2 applies it and proves denial + service-role preservation + idempotence + no data change.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const L = require("./final-cert/C/lib");
const T = require("./final-cert/C/dbtools");

const LOCK = "20261027_credential_tables_lockdown.sql";
const TABLES = ["admin_users", "admin_invites", "password_reset_tokens", "audit_events"];
const s = new L.Suite("credential-lockdown-r5", "R5");
const SUTDIR = process.env.SUT_DIR || path.resolve(__dirname, "..");
const auditSql = fs.readFileSync(path.join(SUTDIR, "scripts/sql/production-credential-exposure-audit.sql"), "utf8");
const rows = (r) => (Array.isArray(r.json) ? r.json.length : 0);
const leaks = (r) => r.status === 200 && Array.isArray(r.json) && (r.json.length > 0 || (r.json[0] && r.json[0].count > 0));
const denied = (r) => !(r.status >= 200 && r.status < 300 && ((Array.isArray(r.json) && r.json.length > 0) || r.status === 201));
const zeroSections = (out) => (out.match(/\(0 rows\)/g) || []).length;

function seed(st) {
  const u = L.uuidv4();
  const email = `r5-${L.randomHex(3)}@fixture.test`;
  const r = st.run(`insert into admin_users (id, email, password_hash, role, status) values ('${u}', '${email}', '${L.scryptHash("R5!Passw0rd1")}', 'super_admin', 'active');
insert into admin_invites (admin_user_id, email, token_hash, expires_at) values ('${u}', '${email}', '${L.randomHex(32)}', now() + interval '1 day');
insert into password_reset_tokens (admin_user_id, email, token_hash, expires_at) values ('${u}', '${email}', '${L.randomHex(32)}', now() + interval '1 hour');
insert into audit_events (actor_email, action, target_type) values ('r5@fixture.test', 'r5.fixture', 'test');`);
  if (r.status !== 0) throw new Error("seed failed: " + r.out.slice(0, 300));
  return u;
}

async function exposure(st, role) {
  const o = {};
  o.rowsAll = rows(await st.rest(role, "GET", "/admin_users?select=*&limit=5"));
  const hash = await st.rest(role, "GET", "/admin_users?select=email,password_hash&limit=5");
  o.hashColumn = hash.status === 200 && Array.isArray(hash.json) && hash.json.some((x) => typeof x.password_hash === "string" && x.password_hash.length > 0);
  o.hashStatus = hash.status;
  const col = await st.rest(role, "GET", "/admin_users?select=password_hash&limit=1");
  o.colOnly = col.status === 200 && rows(col) > 0;
  const cnt = await st.rest(role, "GET", "/admin_users?select=count"); o.count = leaks(cnt);
  const head = await st.rest(role, "HEAD", "/admin_users", { headers: { Prefer: "count=exact" } }); const cr = head.headers && head.headers.get("content-range"); o.head = !!(head.status === 200 && cr && !/\/(0|\*)$/.test(cr));
  for (const t of TABLES.slice(1)) o[t] = rows(await st.rest(role, "GET", `/${t}?select=*&limit=5`));
  const w = await st.rest(role, "PATCH", "/admin_users?email=like.*", { body: { display_name: "x" }, headers: { Prefer: "return=representation" } }); o.patchRows = rows(w);
  const ins = await st.rest(role, "POST", "/admin_users", { body: { email: `r5-ins-${L.randomHex(3)}@fixture.test`, password_hash: "x" }, headers: { Prefer: "return=minimal" } }); o.insertStatus = ins.status;
  const del = await st.rest(role, "DELETE", "/admin_invites?email=like.*", { headers: { Prefer: "return=representation" } }); o.deleteRows = rows(del);
  return o;
}

s.main(async () => {
  const st = await L.DbStack.create({ kind: "supabase17", tag: "r5", postgrest: true, suite: s });
  st.applyBase();
  const mig = st.applyMigrations(L.dbFiles().filter((f) => f !== LOCK));
  s.check("R5-000", "all pre-R5 migrations apply", mig.every((m) => m.status === 0), mig.filter((m) => m.status).map((m) => m.file));
  let uid = seed(st);
  await st.settle(async () => (await st.rpc("service_role", "office_mfa_schema_version")).json === 1);
  // ---- phase 1: reproduce H1 (without the R5 migration)
  await s.section("R5-1", async () => {
    for (const role of ["anon", "authenticated"]) {
      const o = await exposure(st, role);
      s.check(`R5-101-${role}`, `H1 REPRODUCED: ${role} reads admin_users rows through the Data API (pre-R5)`, o.rowsAll > 0, { rows: o.rowsAll });
      s.check(`R5-102-${role}`, `H1 REPRODUCED: ${role} receives a non-empty password_hash column value (value not recorded)`, o.hashColumn, { status: o.hashStatus });
      s.check(`R5-103-${role}`, `H1 REPRODUCED: ${role} can select the password_hash column alone`, o.colOnly);
      s.check(`R5-104-${role}`, `H1 REPRODUCED: ${role} reads invite/reset/audit rows (pre-R5)`, o.admin_invites > 0 && o.password_reset_tokens > 0 && o.audit_events > 0, { invites: o.admin_invites, resets: o.password_reset_tokens, audit: o.audit_events });
      s.check(`R5-105-${role}`, `H1 REPRODUCED (write side): ${role} can modify and delete credential rows (pre-R5)`, o.patchRows > 0 && o.deleteRows > 0 && o.insertStatus < 300, { patched: o.patchRows, deleted: o.deleteRows, insert: o.insertStatus });
      uid = seed(st); // the reproduction above modified/deleted rows in the DISPOSABLE database; start the next role from a fresh row set
    }
    const audit = st.run(auditSql, { onErrorStop: false });
    s.check("R5-110", "the read-only production audit script detects the exposure on the pre-R5 schema (sections 1-5a are not all empty)", zeroSections(audit.out) < 5, { zeroSections: zeroSections(audit.out) });
  });

  // ---- phase 2: apply remediation
  const digestBefore = T.digests(st, TABLES);
  const apply1 = st.applyFile(path.join(SUTDIR, "db", LOCK));
  s.check("R5-200", "the R5 migration applies cleanly", apply1.status === 0, apply1.out.slice(0, 200));
  const apply2 = st.applyFile(path.join(SUTDIR, "db", LOCK));
  s.check("R5-201", "the R5 migration is idempotent (second application is clean)", apply2.status === 0, apply2.out.slice(0, 200));
  await st.reloadSchema(async () => (await st.rest("anon", "GET", "/admin_users?select=id&limit=1")).status !== 200).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  s.check("R5-202", "no account, invite, reset or audit row was changed, added or removed", JSON.stringify(T.digests(st, TABLES)) === JSON.stringify(digestBefore));

  await s.section("R5-3", async () => {
    for (const role of ["anon", "authenticated"]) {
      const o = await exposure(st, role);
      s.check(`R5-301-${role}`, `${role} reads no admin_users row`, o.rowsAll === 0, { rows: o.rowsAll });
      s.check(`R5-302-${role}`, `${role} cannot read the password_hash column (full select)`, !o.hashColumn, { status: o.hashStatus });
      s.check(`R5-303-${role}`, `${role} cannot select the password_hash column alone (column-level access)`, !o.colOnly);
      s.check(`R5-304-${role}`, `${role} learns no row count (count / HEAD)`, !o.count && !o.head);
      s.check(`R5-305-${role}`, `${role} reads no invite, reset-token or audit row`, o.admin_invites === 0 && o.password_reset_tokens === 0 && o.audit_events === 0);
      s.check(`R5-306-${role}`, `${role} cannot update, insert or delete credential rows`, o.patchRows === 0 && o.insertStatus >= 400 && o.deleteRows === 0, { insert: o.insertStatus });
      const named = await st.rest(role, "GET", `/admin_users?id=eq.${uid}&select=password_hash,qr_credential`);
      s.check(`R5-307-${role}`, `${role} cannot fetch one known account's hash by id`, denied(named));
      const emb = await st.rest(role, "GET", "/admin_invites?select=*,admin_users(*)");
      s.check(`R5-308-${role}`, `${role} cannot reach accounts by embedding`, denied(emb));
      for (const t of TABLES) {
        const cs = st.one(`select has_table_privilege('${role}', 'public.${t}', 'select,insert,update,delete,truncate,references,trigger') or (select bool_or(has_column_privilege('${role}', 'public.${t}', attname, 'select,insert,update,references')) from pg_attribute where attrelid = 'public.${t}'::regclass and attnum > 0 and not attisdropped)`);
        s.check(`R5-309-${role}-${t}`, `${role} holds no table or column privilege on ${t} (catalog)`, cs.out === "f", cs.out);
      }
      const fn = await st.rpc(role, "office_revoke_admin_sessions", { p_user_id: uid, p_actor: "r5", p_reason: "x" });
      s.check(`R5-310-${role}`, `${role} cannot execute the credential functions`, fn.status >= 400);
    }
    const anonNoToken = await st.rest(null, "GET", "/admin_users?select=email,password_hash");
    s.check("R5-311", "a request with no token reads nothing", denied(anonNoToken), anonNoToken.status);
    const forged = await st.rest(null, "GET", "/admin_users?select=id", { token: "not.a.jwt" });
    s.check("R5-312", "a malformed token reads nothing", denied(forged), forged.status);

    // service_role preservation
    const sr = await st.rest("service_role", "GET", `/admin_users?id=eq.${uid}&select=id,email,status`);
    s.check("R5-320", "service_role still reads accounts", sr.status === 200 && rows(sr) === 1);
    const up = await st.rest("service_role", "PATCH", `/admin_users?id=eq.${uid}`, { body: { display_name: "R5 updated" }, headers: { Prefer: "return=representation" } });
    s.check("R5-321", "service_role still updates accounts", up.status === 200 && rows(up) === 1);
    const ins = await st.rest("service_role", "POST", "/admin_invites", { body: { email: `r5-svc-${L.randomHex(3)}@fixture.test`, token_hash: L.randomHex(32), expires_at: new Date(Date.now() + 3600e3).toISOString() }, headers: { Prefer: "return=representation" } });
    s.check("R5-322", "service_role still inserts invites", ins.status === 201 && rows(ins) === 1, ins.status);
    const rt = await st.rest("service_role", "GET", "/password_reset_tokens?select=id&limit=1");
    s.check("R5-323", "service_role still reads reset tokens", rt.status === 200 && rows(rt) === 1);
    const del = await st.rest("service_role", "DELETE", `/admin_invites?id=eq.${ins.json && ins.json[0] && ins.json[0].id}`, { headers: { Prefer: "return=representation" } });
    s.check("R5-324", "service_role still deletes invites", del.status === 200 && rows(del) === 1);
    const au = await st.rest("service_role", "POST", "/audit_events", { body: { actor_email: "r5@fixture.test", action: "r5.after", target_type: "test" }, headers: { Prefer: "return=minimal" } });
    s.check("R5-325", "service_role still writes the audit trail", au.status === 201, au.status);
    const rpc = await st.rpc("service_role", "office_revoke_admin_sessions", { p_user_id: uid, p_actor: "r5", p_reason: "x" });
    s.check("R5-326", "service_role still runs the session-revocation function (SECURITY INVOKER, atomic update on admin_users)", rpc.status === 200, rpc.status);
    const rpc2 = await st.rpc("service_role", "office_mfa_schema_version");
    s.check("R5-327", "service_role still runs the MFA functions", rpc2.status === 200 && rpc2.json === 1);

    // table-owner (direct connection deployment) is unaffected
    const own = st.one("select count(*) from admin_users");
    s.check("R5-330", "the owning role (direct-connection deployments) still reads admin_users", own.status === 0 && Number(own.out) >= 1, own.err);
  });

  await s.section("R5-4", async () => {
    const audit = st.run(auditSql, { onErrorStop: false });
    s.check("R5-401", "the read-only production audit reports zero exposure rows in sections 1-5a after remediation", zeroSections(audit.out) >= 5 && !/ERROR/.test(audit.out), { zeroSections: zeroSections(audit.out), err: /ERROR/.test(audit.out), shape: audit.out.split('\n').filter((l) => /^(\d|\()|rows\)/.test(l)).slice(0, 40) });
    const f = st.one("select string_agg(p.oid::regprocedure::text, ',') from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'office\\_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))");
    s.check("R5-402", "no office_* function is executable by anon or authenticated", f.out === "" , f.out);
    const rb = st.applyFile(path.join(SUTDIR, "db/rollback/20261027_credential_tables_lockdown.down.sql"));
    const after = await exposure(st, "anon");
    s.check("R5-410", "the rollback file is a no-op and does NOT re-open the tables", rb.status === 0 && after.rowsAll === 0 && after.admin_invites === 0);
    const reseedOk = st.applyFile(path.join(SUTDIR, "db", LOCK));
    s.check("R5-411", "re-applying after the rollback no-op is still clean", reseedOk.status === 0);
  });

  // ---- migration guards on plain Postgres 16 (no Supabase roles) and on an empty database
  await s.section("R5-5", async () => {
    const pl = await L.DbStack.create({ kind: "plain16", tag: "r5p", suite: s });
    const empty = pl.applyFile(path.join(SUTDIR, "db", LOCK), { onErrorStop: true });
    s.check("R5-501", "on a database without the base schema the migration refuses with a clear message and changes nothing", empty.status !== 0 && /apply db\/lead-agents-schema\.sql/.test(empty.out));
    pl.applyBase(); pl.applyMigrations(L.dbFiles());
    const rls = pl.one("select string_agg(relname, ',' order by relname) from pg_class where relnamespace='public'::regnamespace and relname in ('admin_users','admin_invites','password_reset_tokens','audit_events') and relrowsecurity");
    s.check("R5-502", "plain Postgres (no anon/authenticated/service_role roles): applies and enables RLS on all four tables", rls.out === "admin_invites,admin_users,audit_events,password_reset_tokens", rls.out + rls.err);
    const again = pl.applyFile(path.join(SUTDIR, "db", LOCK));
    s.check("R5-503", "plain Postgres: idempotent", again.status === 0);
  });
});
