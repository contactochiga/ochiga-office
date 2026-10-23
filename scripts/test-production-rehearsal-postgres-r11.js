// S7 R11: PRODUCTION RECONCILIATION REHEARSAL, on DISPOSABLE Postgres + PostgREST only (never a real project).
// 1. Builds a fixture that is shaped like the Office production database: the repository chain through 20261018 plus the VERBATIM production migration
//    `ochiga_office_p0_access_hardening` (read from the production migration history; stored under docs/settings-domain/evidence/r11-production-catalog).
// 2. Proves the fixture equals the measured production catalog (tables, columns, indexes, constraints, triggers, functions, RLS, privileges, default privileges, schema ACL).
// 3. Rehearses the S7 rollout stage by stage with the real application against PostgREST: the service keeps working at every stage, every capability turns on exactly when its
//    migration lands, and the Data API stays closed throughout.
// 4. Classifies 20261027 against the production state (redundant / partially applicable) by comparing privilege snapshots before and after.
// Reuses the frozen certification harness read-only. Credential VALUES are never printed.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const L = require("./final-cert/C/lib");

const SUTDIR = process.env.SUT_DIR || path.resolve(__dirname, "..");
const SNAP = path.join(SUTDIR, "docs/settings-domain/evidence/r11-production-catalog");
const snap = (n) => JSON.parse(fs.readFileSync(path.join(SNAP, n + ".json"), "utf8"));
const F = (f) => path.join(SUTDIR, "db", f);
const OBSERVE = process.env.R11_OBSERVE === "1";
const s = new L.Suite("production-rehearsal-r11", "R11");

const CATALOG = {
  tables: "select c.relname, c.relkind, c.relrowsecurity as rls from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','v','m') order by 1",
  columns: "select c.table_name, c.column_name, c.ordinal_position, c.data_type, c.udt_name, c.is_nullable, c.column_default is not null as has_default, c.character_maximum_length from information_schema.columns c join pg_class k on k.relname=c.table_name and k.relnamespace='public'::regnamespace and k.relkind='r' where c.table_schema='public' order by 1,3",
  indexes: "select tablename, indexname, regexp_replace(indexdef,'^CREATE (UNIQUE )?INDEX \\S+ ON public\\.','\\1 ') as def from pg_indexes where schemaname='public' order by 1,2",
  constraints: "select conrelid::regclass::text tbl, conname, contype, pg_get_constraintdef(oid) def from pg_constraint where connamespace='public'::regnamespace order by 1,2",
  functions: "select p.oid::regprocedure::text fn, pg_get_userbyid(p.proowner) owner, p.prosecdef secdef, p.proconfig, has_function_privilege('anon',p.oid,'execute') anon, has_function_privilege('authenticated',p.oid,'execute') authenticated, has_function_privilege('service_role',p.oid,'execute') service_role, exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee=0) public_grant, p.prokind from pg_proc p where p.pronamespace='public'::regnamespace order by 1",
  triggers: "select tg.tgname||' on '||c.relname as name from pg_trigger tg join pg_class c on c.oid=tg.tgrelid where c.relnamespace='public'::regnamespace and not tg.tgisinternal order by 1",
  default_acl: "select pg_get_userbyid(d.defaclrole) owner_role, coalesce(n.nspname,'(all schemas)') schema, d.defaclobjtype, d.defaclacl::text from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace order by 1,2,3",
  schema_acl: "select nspname, nspacl::text from pg_namespace where nspname in ('public')",
  // every effective privilege the Data API roles hold on any public relation, column, sequence or function
  exposure: "select 'rel' k, c.relname o, r.r g, p.p x from pg_class c, (values ('anon'),('authenticated')) r(r), (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(p) where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','v','m','f') and has_table_privilege(r.r, c.oid, p.p) union all select 'col', c.relname||'.'||a.attname, r.r, 'ANY' from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped, (values ('anon'),('authenticated')) r(r) where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','v','m','f') and (has_column_privilege(r.r, c.oid, a.attnum, 'SELECT') or has_column_privilege(r.r, c.oid, a.attnum, 'INSERT') or has_column_privilege(r.r, c.oid, a.attnum, 'UPDATE')) union all select 'fn', p.oid::regprocedure::text, r.r, 'EXECUTE' from pg_proc p, (values ('anon'),('authenticated')) r(r) where p.pronamespace='public'::regnamespace and has_function_privilege(r.r, p.oid, 'EXECUTE') union all select 'schema', 'public', r.r, 'USAGE' from (values ('anon'),('authenticated')) r(r) where has_schema_privilege(r.r, 'public', 'USAGE') union all select 'seq', c.relname, r.r, 'ANY' from pg_class c, (values ('anon'),('authenticated')) r(r) where c.relnamespace='public'::regnamespace and c.relkind='S' and (has_sequence_privilege(r.r, c.oid, 'USAGE') or has_sequence_privilege(r.r, c.oid, 'SELECT'))",
};
// everything privilege-relevant that a migration can change, as one digest (relation ACLs, column ACLs, RLS flags, function ACLs, schema ACL, default ACLs)
const ACL_BODY = `
 select 'r:' || c.relname || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity || ':' || coalesce(c.relacl::text, '<default>') as l from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','S','v','m')
 union all select 'a:' || c.relname || '.' || a.attname || ':' || a.attacl::text from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and a.attacl is not null where c.relnamespace='public'::regnamespace
 union all select 'f:' || p.oid::regprocedure::text || ':' || coalesce(p.proacl::text, '<default>') from pg_proc p where p.pronamespace='public'::regnamespace
 union all select 'n:' || (select string_agg(x::text, ',' order by x::text) from unnest(nspacl) x) from pg_namespace where nspname='public'
 union all select 'd:' || pg_get_userbyid(d.defaclrole) || ':' || d.defaclnamespace::regnamespace::text || ':' || d.defaclobjtype::text || ':' || d.defaclacl::text from pg_default_acl d`;
const ACL_DIGEST = `select md5(coalesce(string_agg(l, E'\\n' order by l), '')) from (${ACL_BODY}) s`;
const ACL_LINES = `select l from (${ACL_BODY}) s order by l`;
const SHAPE_DIGEST = `select md5(coalesce(string_agg(l, E'\\n' order by l), '')) from (
 select 'f:' || p.oid::regprocedure::text || ':' || md5(p.prosrc) as l from pg_proc p where p.pronamespace='public'::regnamespace
 union all select 'c:' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where c.relnamespace='public'::regnamespace and c.relkind='r'
 union all select 'i:' || indexdef from pg_indexes where schemaname='public'
 union all select 'k:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace
 union all select 't:' || tgname || ':' || tgrelid::regclass::text from pg_trigger where not tgisinternal) s`;

const jsonRows = (st, q) => { const r = st.one(`select coalesce(json_agg(t),'[]'::json) from (${q}) t`); if (r.status !== 0) throw new Error("catalog query failed: " + r.err); return JSON.parse(r.out || "[]"); };
const digest = (st, q) => { const r = st.one(q.replace(/\s+/g, " ")); if (r.status !== 0) throw new Error("digest failed: " + r.err); return r.out; };
const key = (o, ks) => ks.map((k) => String(o[k])).join("|");
function diffSets(prod, fix, ks, vs) {
  const P = new Map(prod.map((r) => [key(r, ks), vs ? key(r, vs) : ""])), Fm = new Map(fix.map((r) => [key(r, ks), vs ? key(r, vs) : ""]));
  return { onlyProd: [...P.keys()].filter((k) => !Fm.has(k)), onlyFixture: [...Fm.keys()].filter((k) => !P.has(k)), differ: [...P.keys()].filter((k) => Fm.has(k) && P.get(k) !== Fm.get(k)) };
}

const GATES_SQL = () => fs.readFileSync(path.join(SUTDIR, "scripts/sql/production-rollout-gates.sql"), "utf8").trim().replace(/;\s*$/, "");
const gates = (st) => { const rows = jsonRows(st, GATES_SQL()); const by = (re) => rows.find((r) => re.test(r.gate)); return { rows, verdict: by(/^VERDICT/).status, stage: (id) => (by(new RegExp("^STAGE " + id)) || {}).status, baselineFails: rows.filter((r) => /^B\d/.test(r.gate) && r.status !== "PASS") }; };
/** repository chain through 20261018, the production-only index, and the VERBATIM production hardening migration */
function buildProductionShape(st) {
  const base = st.applyBase();
  const dated = L.dbFiles().filter((f) => f.slice(0, 8) <= "20261018");
  const mig = st.applyMigrations(dated);
  const failed = mig.filter((m) => m.status !== 0).map((m) => m.file);
  // present in production, recorded in no repository migration (an index on the invite -> account foreign key)
  const idx = st.run("create index if not exists admin_invites_admin_user_id_idx on public.admin_invites using btree (admin_user_id)");
  const p0 = st.applyFile(path.join(SNAP, "ochiga_office_p0_access_hardening.sql"), { onErrorStop: true });
  return { base, failed, idx, p0 };
}

async function seedAndApp(st, label, mfa = false) {
  if (!st.gw) { st.gw = await new L.FaultProxy(st.url).start(); s.onCleanup(() => st.gw.stop()); } // plays the Supabase gateway: strips /rest/v1 before PostgREST
  const sess = st.session();
  const admin = await L.seedUser(sess, { role: "super_admin", scopes: [] });
  const viewer = await L.seedUser(sess, { role: "viewer" });
  const sessionSecret = L.SESSION_SECRET();
  const env = L.appEnv({ restUrl: st.gw.url, serviceJwt: st.jwt("service_role"), sessionSecret, mfa, extra: { LEAD_AGENTS_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "1000" } });
  const app = await L.AppServer.start({ env, name: label, suite: s });
  return { sess, admin, viewer, app, env };
}

async function smoke(st, ctx, tag) {
  const { app, admin } = ctx;
  const c1 = new L.Client(app.url, { ip: "198.51.100.10" }), c2 = new L.Client(app.url, { ip: "198.51.100.11" });
  const o = {};
  const l1 = await c1.login(admin.email, admin.password); o.login = l1.status;
  const l2 = await c2.login(admin.email, admin.password); o.login2 = l2.status;
  const meR = await c1.me(); o.me = meR.status;
  const ul = await c1.get("/api/lead-agents/admin/users"); const firstUser = (ul.json && (ul.json.users || ul.json.items || (Array.isArray(ul.json) ? ul.json : [])) || [])[0] || {};
  o.userKeys = Object.keys(firstUser).sort(); o.meUserKeys = Object.keys((meR.json && (meR.json.user || meR.json)) || {}).sort();
  o.reads = {}; for (const r of ["proposals", "partners", "notifications", "users"]) o.reads[r] = (await c1.get(`/api/lead-agents/admin/${r}`)).status;
  const sl = await c1.get("/api/lead-agents/admin/settings"); o.settingsList = sl.status; o.settingKeys = (sl.json && sl.json.settings || []).map((x) => x.key);
  o.settingsDetail = (sl.json && sl.json.settings || []).slice(0, 40).map((x) => ({ key: x.key, writable: x.writable, version: x.version, can_write: x.can_write, delegated: x.delegated }));
  const h = await fetch(app.url + "/healthz", { headers: { cookie: c1.cookie } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) })).catch(() => ({ status: 0 }));
  o.health = { status: h.status, rate_limit_scope: h.json && h.json.rate_limit && h.json.rate_limit.scope, revocation: h.json && h.json.session_revocation && h.json.session_revocation.capability, mfa: h.json && h.json.mfa && { mode: h.json.mfa.mode, schema: h.json.mfa.schema, evidence: h.json.mfa.evidence } };
  // governed setting write (optimistic version + history): needs 20261019
  const sw = await c1.req("PUT", "/api/lead-agents/admin/settings/office_document_brand_name", { json: { value: `Rehearsal Office ${tag}`, expected_version: ((sl.json && sl.json.settings || []).find((x) => x.key === "office_document_brand_name") || {}).version || 0 } }); o.settingWrite = sw.status; o.settingWriteError = sw.json && (sw.json.error || null);
  const sh = await c1.get("/api/lead-agents/admin/settings/office_document_brand_name/history"); o.settingHistory = sh.status;
  // account-wide sign-out of the OTHER browser
  const ra = await c1.post("/api/lead-agents/admin/session/revoke-all", { keep_current: true }); o.revokeAll = ra.status; if (ra.setCookie) c1.cookie = ra.setCookie;
  o.otherSessionAfterRevokeAll = (await c2.me()).status;
  // password change (the atomic credential update path)
  const newPw = `Chg!${L.randomHex(8)}Zz9`;
  const pc = await c1.post("/api/lead-agents/admin/session/password", { current_password: admin.password, new_password: newPw }); o.passwordChange = pc.status; o.passwordChangeSignedOutOthers = pc.json && pc.json.other_sessions_signed_out;
  if (pc.status === 200) admin.password = newPw;
  const c3 = new L.Client(app.url, { ip: "198.51.100.12" }); o.reloginAfterChange = (await c3.login(admin.email, admin.password)).status;
  // ordinary logout: is the stolen cookie dead afterwards?
  const stolen = c3.cookie; const lo = await c3.logout(); o.logout = lo.status;
  o.stolenCookieAfterLogout = (await c3.me({ cookie: stolen })).status;
  // Data API as the public roles (anon key / authenticated JWT)
  const probes = {};
  for (const role of ["anon", "authenticated"]) {
    for (const t of ["admin_users", "leads", "audit_events", "office_runtime_settings", "conversations"]) { const r = await st.rest(role, "GET", `/${t}?select=*&limit=1`); probes[`${role}:${t}`] = r.status + (Array.isArray(r.json) && r.json.length ? ":ROWS" : ""); }
    const w = await st.rest(role, "POST", "/leads", { body: { name: "x" }, headers: { Prefer: "return=minimal" } }); probes[`${role}:insert`] = w.status;
    for (const fn of ["office_session_revocation_version", "office_rate_limit_version", "office_mfa_schema_version", "set_updated_at"]) { const r = await st.rpc(role, fn); probes[`${role}:rpc:${fn}`] = r.status; }
  }
  o.dataApi = probes;
  if (o.login !== 200) o.appLogTail = app.logText().slice(-600);
  if (OBSERVE) console.log(`OBS ${tag} ${JSON.stringify(o)}`);
  return o;
}
const denied = (code) => /^(401|403|404)$/.test(String(code).split(":")[0]) && !String(code).includes("ROWS");
const dataApiClosed = (o) => Object.values(o.dataApi).every(denied);

s.main(async () => {
  // ====================================================== A. the fixture equals production
  const A = await L.DbStack.create({ kind: "supabase17", tag: "R11A", postgrest: true, suite: s });
  const built = buildProductionShape(A);
  s.check("R11-A01", "the repository chain through 20261018 applies to an empty database in one pass", built.failed.length === 0 && built.base.firstErrors === 0, { failed: built.failed, firstErrors: built.base.firstErrors });
  s.check("R11-A02", "the VERBATIM production hardening migration applies (its own verification block passes)", built.p0.status === 0, L.errLines(built.p0.out));
  const fx = Object.fromEntries(Object.entries(CATALOG).map(([k, q]) => [k, jsonRows(A, q)]));
  const prodTables = snap("tables");
  let d = diffSets(prodTables, fx.tables, ["relname", "relkind", "rls"]);
  s.check("R11-A10", "tables: the same 58 relations, all ordinary, all with row level security", prodTables.length === 58 && d.onlyProd.length === 0 && d.onlyFixture.length === 0 && d.differ.length === 0, d);
  d = diffSets(snap("columns"), fx.columns, ["table_name", "column_name"], ["data_type", "udt_name", "is_nullable", "has_default", "character_maximum_length"]);
  const orderOf = (rows) => { const m = {}; for (const r of rows) (m[r.table_name] ||= []).push([r.ordinal_position, r.column_name]); return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(",")])); };
  const po = orderOf(snap("columns")), fo = orderOf(fx.columns);
  s.info(`column POSITION differs from the repository chain in ${Object.keys(po).filter((k) => po[k] !== fo[k]).length} of 58 tables (production added those columns later than the bootstrap places them): ${Object.keys(po).filter((k) => po[k] !== fo[k]).join(", ")}`);
  s.check("R11-A11", "columns: names, types, nullability and default presence are identical for all 783 columns", snap("columns").length === 783 && d.onlyProd.length + d.onlyFixture.length + d.differ.length === 0, d);
  d = diffSets(snap("indexes"), fx.indexes, ["tablename", "indexname"], ["def"]);
  s.check("R11-A12", "indexes: identical (128), including the one production index no repository migration records", snap("indexes").length === 128 && d.onlyProd.length + d.onlyFixture.length + d.differ.length === 0, d);
  d = diffSets(snap("constraints"), fx.constraints, ["tbl", "conname"], ["contype", "def"]);
  s.check("R11-A13", "constraints: identical (131)", snap("constraints").length === 131 && d.onlyProd.length + d.onlyFixture.length + d.differ.length === 0, d);
  const prodTriggers = snap("triggers").map((r) => ({ name: r.name }));
  d = diffSets(prodTriggers, fx.triggers, ["name"]);
  s.check("R11-A14", "triggers: identical (set_updated_at triggers only)", d.onlyProd.length + d.onlyFixture.length === 0, d);
  d = diffSets(snap("functions"), fx.functions, ["fn"], ["owner", "secdef", "anon", "authenticated", "service_role"]);
  s.check("R11-A15", "functions: production has exactly one public function, set_updated_at(), with the same owner and no Data API execute right", snap("functions").length === 1 && d.onlyProd.length + d.onlyFixture.length + d.differ.length === 0, d);
  const prodDef = snap("default_acl").filter((r) => r.schema === "public" && r.owner_role === "postgres");
  const fixDef = fx.default_acl.filter((r) => r.schema === "public" && r.owner_role === "postgres");
  d = diffSets(prodDef, fixDef, ["owner_role", "schema", "defaclobjtype"], ["defaclacl"]);
  s.check("R11-A16", "default privileges for objects `postgres` creates in public: identical (service_role only; no anon/authenticated)", prodDef.length === 3 && d.onlyProd.length + d.onlyFixture.length + d.differ.length === 0, d);
  const prodSa = snap("default_acl").filter((r) => r.owner_role === "supabase_admin" && r.schema === "public");
  const fixSa = fx.default_acl.filter((r) => r.owner_role === "supabase_admin" && r.schema === "public");
  d = diffSets(prodSa, fixSa, ["owner_role", "schema", "defaclobjtype"], ["defaclacl"]);
  s.info(`supabase_admin default privileges in public (unchanged by the production migration, which warned that it could not alter them): ${d.differ.length + d.onlyProd.length + d.onlyFixture.length === 0 ? "identical in fixture and production" : "DIFFER " + JSON.stringify(d)}`);
  s.check("R11-A17", "…and the supabase_admin entries equal production too (they still name anon/authenticated: the reason schema USAGE matters)", d.onlyProd.length + d.onlyFixture.length + d.differ.length === 0 && /anon/.test(prodSa.map((r) => r.defaclacl).join()), d);
  const prodSchemaAcl = snap("public_schema_acl")[0].nspacl.replace(/cli_login_postgres=U\/pg_database_owner,?/, "").replace(/,\}/, "}");
  const fixSchemaAcl = (fx.schema_acl[0].nspacl || "");
  const roleSet = (acl) => new Set(acl.replace(/[{}]/g, "").split(",").map((x) => x.split("=")[0]).filter(Boolean));
  const ps = roleSet(prodSchemaAcl), fs_ = roleSet(fixSchemaAcl);
  s.check("R11-A18", "schema public: anon and authenticated hold no USAGE; every role that holds it in the fixture holds it in production", !ps.has("anon") && !ps.has("authenticated") && !fs_.has("anon") && !fs_.has("authenticated") && [...fs_].every((r) => ps.has(r)), { prodOnly: [...ps].filter((r) => !fs_.has(r)), fixtureOnly: [...fs_].filter((r) => !ps.has(r)) });
  s.check("R11-A19", "Data API exposure on the fixture is empty at every level (relation, column, sequence, function, schema) — as measured on production", fx.exposure.length === 0, fx.exposure.slice(0, 5));
  await A.settle();
  const shapeDigest0 = digest(A, SHAPE_DIGEST), aclDigest0 = digest(A, ACL_DIGEST);

  // the bootstrap schema is what an operator re-runs by hand (scripts/apply-supabase-schema.js): on this state it must change no privilege
  const reboot = A.applyFile(path.join(SUTDIR, "db", "lead-agents-schema.sql"), { onErrorStop: false });
  s.check("R11-A20", "re-applying the bootstrap schema to the production-shaped database is clean…", !/ERROR:/.test(reboot.out), L.errLines(reboot.out));
  s.check("R11-A21", "…and changes no privilege, RLS flag or default privilege (hardening survives a re-run)", digest(A, ACL_DIGEST) === aclDigest0 && digest(A, SHAPE_DIGEST) === shapeDigest0);

  // ====================================================== B. 20261027 against the production state
  const B = await L.DbStack.create({ kind: "supabase17", tag: "R11B", postgrest: false, suite: s });
  buildProductionShape(B);
  const b0 = digest(B, ACL_DIGEST);
  const lock = B.applyFile(F("20261027_data_api_lockdown.sql"));
  s.check("R11-B01", "20261027 applies cleanly to the production-shaped database", lock.status === 0, L.errLines(lock.out));
  s.check("R11-B02", "…and changes NOTHING there: relation ACLs, column ACLs, RLS flags, function ACLs, schema ACL and default ACLs are byte-identical (the migration is redundant on today's production)", digest(B, ACL_DIGEST) === b0);
  s.check("R11-B03", "…and no row-level security flag is FORCEd by it", B.one("select count(*) from pg_class where relnamespace='public'::regnamespace and relforcerowsecurity").out === "0");
  // …but it is NOT redundant for objects that later migrations create: apply 19..26 and compare with and without a trailing re-application
  const mid = ["20261019_office_runtime_settings_versioning.sql", "20261020_admin_session_generation.sql", "20261021_admin_atomic_account_updates.sql", "20261022_admin_mfa_foundation.sql", "20261023_admin_mfa_recovery_code_key_id.sql", "20261024_admin_mfa_management.sql", "20261025_admin_mfa_webauthn.sql", "20261026_admin_revoked_sessions.sql"];
  const beforeNarrow = mid.map((f) => B.applyFile(F(f)));
  s.check("R11-B10", "19-26 apply after an early 20261027 (it was applied first, out of order)", beforeNarrow.every((r) => r.status === 0), beforeNarrow.map((r, i) => r.status ? mid[i] + ": " + L.errLines(r.out) : null).filter(Boolean));
  const svcPrivs = (st) => st.one("select string_agg(c.relname||':'||p.p, ',' order by c.relname, p.p) from pg_class c, (values ('DELETE'),('TRUNCATE'),('UPDATE'),('REFERENCES'),('TRIGGER')) p(p) where c.relnamespace='public'::regnamespace and c.relname in ('admin_mfa_credentials','admin_mfa_recovery_codes','admin_mfa_challenges','office_runtime_setting_history') and has_table_privilege('service_role', c.oid, p.p)").out;
  const svcBefore = svcPrivs(B);
  B.applyFile(F("20261027_data_api_lockdown.sql"));
  const svcAfter = svcPrivs(B);
  s.check("R11-B11", "an EARLY 20261027 does not narrow service_role on tables created later: the tables 19/22 create carry broader service_role rights until 20261027 runs again", svcBefore !== svcAfter && (svcBefore || "").length > (svcAfter || "").length, { svcBefore, svcAfter });
  s.check("R11-B12", "…so 20261027 must run AFTER 20261022 (and be re-run after any later table it covers); the section that matters on production is its last one", /admin_mfa_credentials:TRUNCATE/.test(svcBefore || "") && !/admin_mfa_credentials:(TRUNCATE|DELETE)/.test(svcAfter || ""), { svcBefore, svcAfter });

  // ====================================================== C. the numeric order, to compare with the staged rollout
  const C = await L.DbStack.create({ kind: "supabase17", tag: "R11C", postgrest: false, suite: s });
  buildProductionShape(C);
  const numeric = L.dbFiles().filter((f) => f.slice(0, 8) > "20261018");
  const cr = numeric.map((f) => ({ f, ...C.applyFile(F(f)) }));
  s.check("R11-C01", "the whole pending chain 20261019-20261031 applies in numeric order to the production-shaped database", cr.every((r) => r.status === 0), cr.filter((r) => r.status).map((r) => r.f + ": " + L.errLines(r.out)));
  const cr2 = numeric.map((f) => ({ f, ...C.applyFile(F(f)) }));
  s.check("R11-C02", "…and a second pass of the whole chain is clean (idempotent)", cr2.every((r) => r.status === 0), cr2.filter((r) => r.status).map((r) => r.f));
  const finalNumericAcl = digest(C, ACL_DIGEST), finalNumericShape = digest(C, SHAPE_DIGEST);
  s.check("R11-C03", "after the chain the Data API still reaches nothing in public (no relation, column, sequence, function or schema right)", jsonRows(C, CATALOG.exposure).length === 0, jsonRows(C, CATALOG.exposure).slice(0, 5));
  s.check("R11-C04", "…every public table still has row level security and no policy", C.one("select count(*) from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p') and not relrowsecurity").out === "0" && C.one("select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid where c.relnamespace='public'::regnamespace").out === "0");
  const fnRows = jsonRows(C, CATALOG.functions);
  s.check("R11-C05", "…every function the chain adds is executable by service_role only (anon/authenticated/PUBLIC hold nothing)", fnRows.length > 20 && fnRows.every((f) => !f.anon && !f.authenticated && f.service_role === true && f.public_grant === false), fnRows.filter((f) => f.anon || f.authenticated || f.public_grant || !f.service_role).map((f) => f.fn));
  const audit = C.run(fs.readFileSync(path.join(SUTDIR, "scripts/sql/production-data-api-exposure-audit.sql"), "utf8").replace(/^\\echo.*$/gm, ""), { onErrorStop: false });
  s.check("R11-C06", "the owner's read-only exposure audit script runs on it without error", !/ERROR:/.test(audit.out), L.errLines(audit.out));

  // ====================================================== D. the staged, production-specific rollout with the real application
  const STAGES = [
    { id: "S0", title: "today's production (no pending migration)", files: [] },
    { id: "S1", title: "settings versioning, session generations, atomic account updates", files: ["20261019_office_runtime_settings_versioning.sql", "20261020_admin_session_generation.sql", "20261021_admin_atomic_account_updates.sql"] },
    { id: "S2", title: "durable single-session revocation (ordinary logout)", files: ["20261026_admin_revoked_sessions.sql"] },
    { id: "S3", title: "shared rate limits", files: ["20261028_shared_rate_limits.sql"] },
    { id: "S4", title: "MFA data layer (MFA stays OFF)", files: ["20261022_admin_mfa_foundation.sql", "20261023_admin_mfa_recovery_code_key_id.sql", "20261024_admin_mfa_management.sql", "20261025_admin_mfa_webauthn.sql", "20261029_mfa_lock_order.sql", "20261030_mfa_active_factor_evidence.sql", "20261031_mfa_mailbox_attempts.sql"] },
    { id: "S5", title: "20261027 credential/privilege lockdown re-assertion (last)", files: ["20261027_data_api_lockdown.sql"] },
  ];
  // what the application must report once the stage's migrations are in (MFA is off throughout, so the MFA schema is never a readiness concern)
  const EXPECT = {
    S0: { revocation: "unavailable", scope: "process", stolenAfterLogout: 200, settingWrite: 503, revokeAll: 503, othersOut: false },
    S1: { revocation: "available", scope: "process", stolenAfterLogout: 200, settingWrite: 200, revokeAll: 200, othersOut: true },
    S2: { settingWrite: 200, revokeAll: 200, othersOut: true, revocation: "available", scope: "process", stolenAfterLogout: 401 },
    S3: { settingWrite: 200, revokeAll: 200, othersOut: true, revocation: "available", scope: "shared", stolenAfterLogout: 401 },
    S4: { settingWrite: 200, revokeAll: 200, othersOut: true, revocation: "available", scope: "shared", stolenAfterLogout: 401 },
    S5: { settingWrite: 200, revokeAll: 200, othersOut: true, revocation: "available", scope: "shared", stolenAfterLogout: 401 },
  };
  const GATE_EXPECT = {
    S0: { stages: { S1: "ABSENT", S2: "ABSENT", S3: "ABSENT", S4: "ABSENT", S5: "NOT_APPLICABLE" }, verdict: "GO" },
    S1: { stages: { S1: "APPLIED", S2: "ABSENT", S3: "ABSENT", S4: "ABSENT", S5: "ABSENT" }, verdict: "GO-WITH-REVIEW" },
    S2: { stages: { S1: "APPLIED", S2: "APPLIED", S3: "ABSENT", S4: "ABSENT", S5: "ABSENT" }, verdict: "GO-WITH-REVIEW" },
    S3: { stages: { S1: "APPLIED", S2: "APPLIED", S3: "APPLIED", S4: "ABSENT", S5: "ABSENT" }, verdict: "GO-WITH-REVIEW" },
    S4: { stages: { S1: "APPLIED", S2: "APPLIED", S3: "APPLIED", S4: "APPLIED", S5: "ABSENT" }, verdict: "GO-WITH-REVIEW" },
    S5: { stages: { S1: "APPLIED", S2: "APPLIED", S3: "APPLIED", S4: "APPLIED", S5: "APPLIED" }, verdict: "GO" },
  };
  const results = {}; const inventory = {};
  let aclBefore = aclDigest0;
  for (const stage of STAGES) {
    await s.section(stage.id, async () => {
      const inv = (st) => new Set(jsonRows(st, "select 'fn:' || p.oid::regprocedure::text as o from pg_proc p where p.pronamespace='public'::regnamespace union all select 'table:' || relname from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p') union all select 'column:' || table_name || '.' || column_name from information_schema.columns where table_schema='public' union all select 'trigger:' || tgname || ' on ' || tgrelid::regclass::text from pg_trigger where not tgisinternal and tgrelid::regclass::text !~ 'set_updated_at'").map((r) => r.o));
      const invBefore = inv(A);
      if (stage.files.length) {
        const rs = stage.files.map((f) => ({ f, ...A.applyFile(F(f)) }));
        s.check(`R11-${stage.id}-00`, `${stage.id} (${stage.title}): migrations apply`, rs.every((r) => r.status === 0), rs.filter((r) => r.status).map((r) => r.f + ": " + L.errLines(r.out)));
        await A.settle();
      }
      const invAfter = inv(A); inventory[stage.id] = [...invAfter].filter((x) => !invBefore.has(x)).sort();
      // a fresh deploy of the S7 application against this stage
      const g = gates(A); const ge = GATE_EXPECT[stage.id];
      s.check(`R11-${stage.id}-G1`, `${stage.id}: the owner's read-only gate script reports stages ${JSON.stringify(ge.stages)} and verdict ${ge.verdict}`, ["S1", "S2", "S3", "S4", "S5"].every((k) => g.stage(k) === ge.stages[k]) && g.verdict === ge.verdict && g.baselineFails.length === 0, { stages: ["S1", "S2", "S3", "S4", "S5"].map((k) => k + "=" + g.stage(k)), verdict: g.verdict, baselineFails: g.baselineFails, rows: g.rows.filter((r) => /^STAGE|^FOLLOW|^VERDICT/.test(r.gate)).map((r) => r.gate.slice(0, 14) + ":" + r.status) });
      const ctx = await seedAndApp(A, `app-${stage.id}`);
      const o = await smoke(A, ctx, stage.id); results[stage.id] = o;
      const e = EXPECT[stage.id];
      s.check(`R11-${stage.id}-01`, `${stage.id}: the service works — sign-in, session, reads of RLS-protected tables (proposals, partners, notifications, users), settings list`, o.login === 200 && o.me === 200 && Object.values(o.reads).every((x) => x === 200) && o.settingsList === 200, { login: o.login, me: o.me, reads: o.reads, settings: o.settingsList });
      // qr_credential is the staff ID-badge payload (id, email, role): displayed, never accepted by any authentication path (it exists on today's production schema and is returned today)
      const SECRET_KEY = /hash|secret|cipher|nonce|token|hmac|(?<!^qr_)credential|recovery|private/i;
      s.check(`R11-${stage.id}-11`, `${stage.id}: staff API user objects carry no secret-bearing field (keys: ${o.userKeys.filter((k) => /^(session|mfa)/.test(k) || k === "sessions_revoked_by").join(", ") || "no session/mfa columns yet"})`, o.userKeys.length > 5 && !o.userKeys.some((k) => SECRET_KEY.test(k)) && !o.meUserKeys.some((k) => SECRET_KEY.test(k)), { users: o.userKeys.filter((k) => SECRET_KEY.test(k)), me: o.meUserKeys.filter((k) => SECRET_KEY.test(k)) });
      s.check(`R11-${stage.id}-02`, `${stage.id}: /healthz is ready (200) with MFA off`, o.health.status === 200, o.health);
      s.check(`R11-${stage.id}-03`, `${stage.id}: session-revocation capability reports "${e.revocation}"`, o.health.revocation === e.revocation, o.health);
      s.check(`R11-${stage.id}-04`, `${stage.id}: sign-in counters live in scope "${e.scope}"`, o.health.rate_limit_scope === e.scope, o.health);
      s.check(`R11-${stage.id}-05`, `${stage.id}: a signed-out cookie answers ${e.stolenAfterLogout} (durable revocation ${e.stolenAfterLogout === 401 ? "present" : "absent until 20261026"})`, o.stolenCookieAfterLogout === e.stolenAfterLogout, o.stolenCookieAfterLogout);
      s.check(`R11-${stage.id}-06`, `${stage.id}: password change works and the new password signs in`, o.passwordChange === 200 && o.reloginAfterChange === 200, { change: o.passwordChange, relogin: o.reloginAfterChange });
      s.check(`R11-${stage.id}-08`, `${stage.id}: governed setting write ${e.settingWrite === 200 ? "succeeds (versioned)" : "is refused with a safe 503 (settings_versioning_unavailable) and nothing is written"}`, o.settingWrite === e.settingWrite && (e.settingWrite === 200 || o.settingWriteError === "settings_versioning_unavailable") && o.settingHistory === (e.settingWrite === 200 ? 200 : o.settingHistory), { write: o.settingWrite, error: o.settingWriteError, history: o.settingHistory });
      s.check(`R11-${stage.id}-09`, `${stage.id}: revoke-all ${e.revokeAll === 200 ? "works and signs the other browser out" : "is refused (503), the other browser stays signed in"}; password change ${e.othersOut ? "signs the other browsers out" : "does NOT sign other browsers out"}`, o.revokeAll === e.revokeAll && (o.otherSessionAfterRevokeAll === (e.othersOut ? 401 : 200)) && o.passwordChangeSignedOutOthers === e.othersOut, { revokeAll: o.revokeAll, other: o.otherSessionAfterRevokeAll, pwOthersOut: o.passwordChangeSignedOutOthers });
      s.check(`R11-${stage.id}-07`, `${stage.id}: the Data API stays closed (anon and authenticated: reads, insert and every function denied; no row ever returned)`, dataApiClosed(o) && jsonRows(A, CATALOG.exposure).length === 0, o.dataApi);
      const acl = digest(A, ACL_DIGEST);
      aclBefore = acl;
      await ctx.app.stop();
    });
  }
  const stagedShape = digest(A, SHAPE_DIGEST), stagedAcl = digest(A, ACL_DIGEST);
  if (process.env.R11_INVENTORY_OUT) fs.writeFileSync(process.env.R11_INVENTORY_OUT, JSON.stringify(inventory, null, 1));
  s.check("R11-D91", "the staged production order (19-21, 26, 28, 22-25 + 29-31, then 27) reaches the SAME catalog shape as the numeric order", stagedShape === finalNumericShape);
  const lines = (st) => new Set(st.one(ACL_LINES.replace(/\s+/g, " ")).out.split("\n"));
  const la = lines(A), lc = lines(C);
  s.check("R11-D92", "…and the same privilege state as the numeric order", stagedAcl === finalNumericAcl, { onlyStaged: [...la].filter((x) => !lc.has(x)), onlyNumeric: [...lc].filter((x) => !la.has(x)) });

  // ====================================================== H. rolling the whole rollout back (reverse order) on the production-shaped database
  await s.section("H", async () => {
    const dataBefore = jsonRows(A, "select (select count(*) from admin_users) users, (select count(*) from office_runtime_setting_history) history, (select count(*) from admin_mfa_credentials) creds");
    const order = ["20261027", "20261031", "20261030", "20261029", "20261025", "20261024", "20261023", "20261022", "20261028", "20261026", "20261021", "20261020", "20261019"];
    const downs = order.map((m) => { const f = L.dbFiles().find((x) => x.startsWith(m)); return { m, ...A.applyFile(L.rollbackFile(f)) }; });
    s.check("R11-H01", "every rollback script of the staged rollout runs without error, newest first", downs.every((d) => d.status === 0), downs.filter((d) => d.status).map((d) => d.m + ": " + L.errLines(d.out)));
    const left = jsonRows(A, CATALOG.functions).map((f) => f.fn).sort();
    s.info(`functions left in public after the full rollback: ${left.join(", ")}`);
    s.check("R11-H02", "…no authentication function is left callable half-configured (only set_updated_at() and the kept append-only trigger function remain)", left.every((f) => /^(set_updated_at|office_runtime_setting_history_immutable)\(\)$/.test(f)), left);
    const dataAfter = jsonRows(A, "select (select count(*) from admin_users) users, (select count(*) from office_runtime_setting_history) history, (select count(*) from admin_mfa_credentials) creds");
    s.check("R11-H03", "…no account, settings-history or credential row was lost", JSON.stringify(dataBefore) === JSON.stringify(dataAfter), { dataBefore, dataAfter });
    const gb = gates(A);
    s.check("R11-H04", "…every BASELINE protection still holds (RLS, no Data API privilege, schema closed)", gb.baselineFails.length === 0, gb.baselineFails);
    s.check("R11-H05", "…and the gate script reports the stages that keep durable tables as PARTIAL and the ephemeral rate-limit stage as ABSENT (verdict NO-GO for any further rollout until the stages are re-applied: idempotent forward re-application)", ["S1", "S2", "S4"].every((k) => gb.stage(k) === "PARTIAL") && gb.stage("S3") === "ABSENT" && gb.verdict === "NO-GO", { stages: ["S1", "S2", "S3", "S4"].map((k) => k + "=" + gb.stage(k)), verdict: gb.verdict });
    await A.settle();
    const rctx = await seedAndApp(A, "app-after-rollback");
    const ro = await smoke(A, rctx, "after-rollback");
    s.check("R11-H06", "the application still works after the full rollback (sign-in, reads, settings list, password change) and reports the capabilities unavailable again", ro.login === 200 && ro.me === 200 && Object.values(ro.reads).every((x) => x === 200) && ro.settingsList === 200 && ro.passwordChange === 200 && ro.health.revocation === "unavailable" && ro.health.rate_limit_scope === "process", { login: ro.login, reads: ro.reads, health: ro.health, pw: ro.passwordChange });
    s.check("R11-H07", "…and the Data API is still closed", dataApiClosed(ro) && jsonRows(A, CATALOG.exposure).length === 0, ro.dataApi);
    await rctx.app.stop();
    // forward again: the staged rollout is repeatable
    const again = STAGES.flatMap((st_) => st_.files).map((f) => ({ f, ...A.applyFile(F(f)) }));
    s.check("R11-H08", "re-applying every migration of the rollout after a full rollback succeeds", again.every((r) => r.status === 0), again.filter((r) => r.status).map((r) => r.f + ": " + L.errLines(r.out)));
    const ga = gates(A);
    s.check("R11-H09", "…and the gate script is back to all stages APPLIED with verdict GO", ["S1", "S2", "S3", "S4", "S5"].every((k) => ga.stage(k) === "APPLIED") && ga.verdict === "GO", { verdict: ga.verdict, stages: ["S1", "S2", "S3", "S4", "S5"].map((k) => k + "=" + ga.stage(k)) });
  });

  // ====================================================== E. a migration landing while the application is running (no restart)
  const D = await L.DbStack.create({ kind: "supabase17", tag: "R11D", postgrest: true, suite: s });
  buildProductionShape(D); await D.settle();
  for (const f of ["20261019_office_runtime_settings_versioning.sql", "20261020_admin_session_generation.sql", "20261021_admin_atomic_account_updates.sql"]) D.applyFile(F(f));
  await D.settle();
  const live = await seedAndApp(D, "app-live");
  const before = await fetch(live.app.url + "/healthz").then((r) => r.json());
  s.check("R11-E01", "before 20261028 a running application counts sign-ins per process", before.rate_limit && before.rate_limit.scope === "process", before.rate_limit);
  D.applyFile(F("20261028_shared_rate_limits.sql")); await D.settle();
  let scope = "process"; const t0 = Date.now();
  while (Date.now() - t0 < 90000) { const h = await fetch(live.app.url + "/healthz").then((r) => r.json()).catch(() => null); scope = h && h.rate_limit && h.rate_limit.scope; if (scope === "shared") break; await L.sleepMs(3000); }
  s.check("R11-E02", "…and, once 20261028 lands, the SAME running process switches to the shared limiter within a minute (deploy order does not matter)", scope === "shared", { scope, seconds: Math.round((Date.now() - t0) / 1000) });
  // negative control: the closed-API checks can fail. Grant the public roles access on purpose and see the same probes light up.
  D.run("grant usage on schema public to anon; grant select on public.proposals to anon");
  const gNeg = gates(D);
  s.check("R11-E12", "negative control: with anon deliberately granted access the owner's gate script says NO-GO and names B1/B3", gNeg.verdict === "NO-GO" && gNeg.baselineFails.some((r) => /^B1/.test(r.gate)) && gNeg.baselineFails.some((r) => /^B3/.test(r.gate)), { verdict: gNeg.verdict, fails: gNeg.baselineFails.map((r) => r.gate.slice(0, 3)) });
  const nx = jsonRows(D, CATALOG.exposure); const nr = await D.rest("anon", "GET", "/proposals?select=id&limit=1");
  s.check("R11-E10", "negative control: after deliberately granting anon USAGE + SELECT the exposure query reports it and the Data API answers 200", nx.length >= 2 && nr.status === 200, { exposure: nx.length, status: nr.status });
  D.run("revoke select on public.proposals from anon; revoke usage on schema public from anon");
  s.check("R11-E11", "…and revoking restores the closed state (exposure empty, Data API denies)", jsonRows(D, CATALOG.exposure).length === 0 && (await D.rest("anon", "GET", "/proposals?select=id&limit=1")).status >= 400);
  s.check("R11-E13", "…and after the grants are revoked the gate script is back to a baseline with no failure", gates(D).baselineFails.length === 0);
  const cl = new L.Client(live.app.url); const lg = await cl.login(live.admin.email, live.admin.password);
  s.check("R11-E03", "…and sign-in keeps working across the switch", lg.status === 200, lg.status);

  // ====================================================== F. an interrupted stage is detected
  const Fx = await L.DbStack.create({ kind: "supabase17", tag: "R11F", postgrest: false, suite: s });
  buildProductionShape(Fx);
  Fx.applyFile(F("20261019_office_runtime_settings_versioning.sql")); Fx.applyFile(F("20261020_admin_session_generation.sql"));
  const gp = gates(Fx);
  s.check("R11-F01", "gate script: stage S1 applied only up to 20261020 is reported PARTIAL and the verdict is NO-GO (an interrupted or hand-applied stage must stop the rollout)", gp.stage("S1") === "PARTIAL" && gp.verdict === "NO-GO", { s1: gp.stage("S1"), verdict: gp.verdict });
  Fx.applyFile(F("20261021_admin_atomic_account_updates.sql"));
  const gq = gates(Fx);
  s.check("R11-F02", "…and applying the missing migration makes S1 APPLIED (verdict GO-WITH-REVIEW until 20261027 narrows the history table)", gq.stage("S1") === "APPLIED" && gq.verdict === "GO-WITH-REVIEW", { s1: gq.stage("S1"), verdict: gq.verdict });
  // the three migrations that production ALREADY carries are no-ops there
  for (const f of ["20261014_office_runtime_settings.sql", "20261015_whatsapp_inbound_claims.sql", "20261017_whatsapp_manual_sends.sql", "20261018_communication_delivery_outbox.sql"]) {
    const X = await L.DbStack.create({ kind: "supabase17", tag: "R11X", postgrest: false, suite: s });
    buildProductionShape(X);
    const a0 = digest(X, ACL_DIGEST), s0 = digest(X, SHAPE_DIGEST);
    const r = X.applyFile(F(f));
    s.check(`R11-X-${f.slice(0, 8)}`, `${f} applies cleanly to the production-shaped database and changes nothing (shape, indexes, constraints, triggers, privileges): redundant there`, r.status === 0 && digest(X, ACL_DIGEST) === a0 && digest(X, SHAPE_DIGEST) === s0, L.errLines(r.out));
    await X.destroy();
  }
  // ====================================================== G. staff who are signed in during the rollout
  const G = await L.DbStack.create({ kind: "supabase17", tag: "R11G", postgrest: true, suite: s });
  buildProductionShape(G); await G.settle();
  const gctx = await seedAndApp(G, "app-continuity");
  const cA = new L.Client(gctx.app.url, { ip: "198.51.100.40" });
  await cA.login(gctx.admin.email, gctx.admin.password);
  const legacyCookie = cA.cookie;
  const tokenOf = (ck) => { try { return JSON.parse(Buffer.from(String(ck).split("=")[1].split(".")[0], "base64url").toString("utf8")); } catch { return null; } };
  const tok0 = tokenOf(legacyCookie);
  s.info(`session token issued on today's production schema carries fields: ${tok0 ? Object.keys(tok0).sort().join(",") : "(opaque)"}`);
  for (const f of ["20261019_office_runtime_settings_versioning.sql", "20261020_admin_session_generation.sql", "20261021_admin_atomic_account_updates.sql"]) G.applyFile(F(f));
  await G.settle(); await gctx.app.restart();
  s.check("R11-G01", "a staff session opened BEFORE stage S1 is still valid after S1 and an application restart (no forced sign-out)", (await new L.Client(gctx.app.url).me({ cookie: legacyCookie })).status === 200);
  G.applyFile(F("20261026_admin_revoked_sessions.sql")); await G.settle(); await gctx.app.restart();
  s.check("R11-G02", "…and after S2", (await new L.Client(gctx.app.url).me({ cookie: legacyCookie })).status === 200);
  const cB = new L.Client(gctx.app.url, { ip: "198.51.100.41" }); await cB.login(gctx.admin.email, gctx.admin.password);
  const newCookie = cB.cookie;
  const lo2 = await cB.logout();
  s.check("R11-G03", "a session opened AFTER S2 is revoked durably by logout (a copied cookie is dead)", lo2.status === 200 && (await new L.Client(gctx.app.url).me({ cookie: newCookie })).status === 401);
  const lo0 = await new L.Client(gctx.app.url).logout({ cookie: legacyCookie });
  const stillAlive = (await new L.Client(gctx.app.url).me({ cookie: legacyCookie })).status;
  s.info(`a session opened before S2: logout answers ${lo0.status}; the copied cookie then answers ${stillAlive}`);
  s.check("R11-G04", "…while a session opened before S2 cannot be revoked one-by-one (documented residual: it ends at its expiry, at revoke-all, a password change, or when the session secret is rotated)", stillAlive === 200);
  const ra = await new L.Client(gctx.app.url).post("/api/lead-agents/admin/session/revoke-all", {}, { cookie: legacyCookie });
  s.check("R11-G05", "revoke-all (available since S1) ends every older session, including the pre-S2 one", (ra.status === 200 || ra.status === 401) && (await new L.Client(gctx.app.url).me({ cookie: legacyCookie })).status === 401, ra.status);
  // ====================================================== I. the code that is probably in production today (the WhatsApp release branch, an ancestor of this branch) against the new schema
  const OLD = process.env.R11_OLD_RELEASE_DIR || "/Users/ochigaidoko/ochiga-office";
  if (!fs.existsSync(path.join(OLD, "lead-agents-server.js")) || !fs.existsSync(path.join(OLD, "node_modules"))) {
    s.info(`SKIPPED section I: no older release checkout with node_modules at ${OLD} (set R11_OLD_RELEASE_DIR)`);
  } else {
    await s.section("I", async () => {
      const oldSha = L.sh("git", ["-C", OLD, "rev-parse", "--short", "HEAD"]).stdout.trim();
      s.info(`older release under test: ${oldSha} (${L.sh("git", ["-C", OLD, "branch", "--show-current"]).stdout.trim()})`);
      const I = await L.DbStack.create({ kind: "supabase17", tag: "R11I", postgrest: true, suite: s });
      buildProductionShape(I); await I.settle();
      I.gw = await new L.FaultProxy(I.url).start(); s.onCleanup(() => I.gw.stop());
      const sess = I.session(); const admin = await L.seedUser(sess, { role: "super_admin" });
      const env = L.appEnv({ restUrl: I.gw.url, serviceJwt: I.jwt("service_role"), sessionSecret: L.SESSION_SECRET(), mfa: false });
      const old = await L.AppServer.start({ sut: OLD, env, name: "app-old-release", suite: s });
      const oldSmoke = async (tag) => {
        const c = new L.Client(old.url, { ip: "198.51.100.60" });
        const o = { login: (await c.login(admin.email, admin.password)).status };
        o.me = (await c.me()).status; o.reads = {};
        for (const r of ["proposals", "partners", "notifications", "users"]) o.reads[r] = (await c.get(`/api/lead-agents/admin/${r}`)).status;
        const ck = c.cookie; o.logout = (await c.logout()).status;
        if (OBSERVE) console.log(`OBS-OLD ${tag} ${JSON.stringify(o)}`);
        return o;
      };
      const okOld = (o) => o.login === 200 && o.me === 200 && Object.values(o.reads).every((x) => x === 200) && o.logout === 200;
      const o0 = await oldSmoke("before");
      s.check("R11-I01", "the older release works on today's production-shaped schema (control for the next checks)", okOld(o0), o0);
      const rs = L.dbFiles().filter((f) => f.slice(0, 8) > "20261018").map((f) => ({ f, ...I.applyFile(F(f)) }));
      s.check("R11-I02", "the whole pending migration chain applies while that release is running", rs.every((r) => r.status === 0), rs.filter((r) => r.status).map((r) => r.f));
      await I.settle();
      const o1 = await oldSmoke("during");
      s.check("R11-I03", "…the SAME running older process keeps working after the migrations land (migrations-first is safe for it: sign-in, session, reads, logout)", okOld(o1), o1);
      await old.restart();
      const o2 = await oldSmoke("restarted");
      s.check("R11-I04", "…and after a restart on the migrated schema", okOld(o2), o2);
      s.check("R11-I05", "…and the Data API is still closed", jsonRows(I, CATALOG.exposure).length === 0 && gates(I).baselineFails.length === 0);
      await old.stop();
    });
  }
});
