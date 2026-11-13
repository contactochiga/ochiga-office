// Office security baseline on a DISPOSABLE Supabase Postgres + PostgREST (never a real project).
// Proves a fresh database built from db/migration-order.txt reproduces the production posture verified on
// 2026-11-13 (no public-schema access, no privileges and no column grants for PUBLIC/anon/authenticated,
// no executable routines or usable sequences for them, RLS on every table, owner default privileges that
// grant only service_role), that later objects are covered (and where they are not, the verification gate
// fails until the baseline is re-applied), that PostgREST refuses anon/authenticated reads while
// service_role keeps working, and that the baseline is repeatable.
// Manifest checks always run; database checks require Docker and the images below.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawnSync } = require("child_process");
const { migrationOrder, resolveLocalTarget, run } = require("./init-office-database");

const ROOT = path.resolve(__dirname, "..");
const PG_IMAGE = process.env.PG_IMAGE || "public.ecr.aws/supabase/postgres:17.6.1.131";
const PGRST_IMAGE = process.env.PGRST_IMAGE || "public.ecr.aws/supabase/postgrest:v14.12";
const RUN = crypto.randomBytes(3).toString("hex");
const NET = `sec-net-${RUN}`, PG = `sec-pg-${RUN}`, REST = `sec-rest-${RUN}`;
const PW = `pw_${crypto.randomBytes(10).toString("hex")}`, JWT_SECRET = crypto.randomBytes(24).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0, failures = 0;
const check = (id, text, cond, detail) => { checks += 1; if (!cond) failures += 1; console.log(`${cond ? "PASS" : "FAIL"} ${id} ${text}${cond ? "" : " :: " + String(JSON.stringify(detail === undefined ? null : detail)).slice(0, 800)}`); };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });
const cleanup = [];
const psql = (sql, user = "postgres") => { const r = sh("docker", ["exec", "-i", PG, "psql", "-X", "-q", "-At", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1"], { input: sql }); return { status: r.status, out: (r.stdout || "").trim(), err: r.stderr || "" }; };
const one = (sql) => psql(sql).out;
const verify = () => psql(fs.readFileSync(path.join(ROOT, "db", "security", "office-security-verify.sql"), "utf8"));
const jwt = (role) => { const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const h = b({ alg: "HS256", typ: "JWT" }), p = b({ role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url")}`; };
// Every ACL, RLS flag and default ACL that the baseline can touch, for the repeatability check.
const SNAPSHOT = `select md5(string_agg(x, '|' order by x)) from (
  select 'n:'||nspname||':'||coalesce(nspacl::text,'') x from pg_namespace where nspname = 'public'
  union all select 'c:'||relname||':'||relkind||':'||coalesce(relacl::text,'')||':'||relrowsecurity from pg_class where relnamespace = 'public'::regnamespace
  union all select 'a:'||attrelid::regclass||'.'||attname||':'||attacl::text from pg_attribute where attacl is not null and attrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
  union all select 'p:'||oid::regprocedure||':'||coalesce(proacl::text,'') from pg_proc where pronamespace = 'public'::regnamespace
  union all select 'd:'||defaclrole::regrole||':'||defaclnamespace||':'||defaclobjtype||':'||defaclacl::text from pg_default_acl) s`;
const PROBE_TABLES = ["leads", "conversations", "lead_channel_states", "admin_users", "audit_events", "whatsapp_manual_sends", "office_meta_social_pending_receipts", "catalogue_products", "office_intake_receipts"];

async function manifestChecks() {
  const order = migrationOrder();
  const top = fs.readdirSync(path.join(ROOT, "db")).filter((f) => f.endsWith(".sql"));
  const listed = order.filter((f) => !f.startsWith("security/"));
  check("MF1", "manifest lists every top-level db/*.sql exactly once (rollback scripts excluded)",
    top.every((f) => listed.filter((x) => x === f).length === 1) && listed.length === top.length, { missing: top.filter((f) => !listed.includes(f)), extra: listed.filter((f) => !top.includes(f)) });
  const i = (f) => order.indexOf(f);
  check("MF2", "baseline first, schema second, baseline again then verify last",
    order[0] === "security/office-security-baseline.sql" && order[1] === "lead-agents-schema.sql" &&
    order.at(-2) === "security/office-security-baseline.sql" && order.at(-1) === "security/office-security-verify.sql", order);
  check("MF3", "Track B in documented order inbound -> staff_replies -> dispatch_fence (not filename order)",
    i("20261113_meta_social_inbound.sql") < i("20261113_meta_social_staff_replies.sql") && i("20261113_meta_social_staff_replies.sql") < i("20261113_meta_social_dispatch_fence.sql"));
  const dated = listed.filter((f) => /^\d/.test(f) && !f.startsWith("20261113_meta_social_"));
  check("MF4", "other dated migrations keep date order", dated.join() === [...dated].sort().join(), dated);
  // Synthetic refs and addresses: real production refs live only in the operator's environment, never in this repository.
  // DNS is injected, so nothing is resolved or contacted.
  const prod = "prodrefaaaaaaaaaaaaa";
  const dnsTable = { localhost: ["127.0.0.1"], pg: ["192.168.32.5"], db: ["203.0.113.10"], mixed: ["10.0.0.4", "198.51.100.7"], "staging.example.com": ["10.1.2.3"] };
  const lookup = async (host) => (dnsTable[host] || []).map((address) => ({ address }));
  const verdict = async (url, refs) => { try { await resolveLocalTarget(url, refs, lookup); return "accepted"; } catch (error) { return error.message; } };
  const cases = [
    ["hosted host, refs missing", `postgres://postgres:x@db.${prod}.supabase.co:5432/postgres`, undefined, false],
    ["hosted host, refs empty", `postgres://postgres:x@db.${prod}.supabase.co:5432/postgres`, "", false],
    ["hosted host, refs misconfigured", `postgres://postgres:x@db.${prod}.supabase.co:5432/postgres`, "someotherref", false],
    ["pooler host", `postgres://postgres.${prod}:x@aws-0-eu-west-2.pooler.supabase.com:6543/postgres`, "", false],
    ["localhost URL with ?host= override", `postgres://postgres:x@localhost:5432/postgres?host=db.${prod}.supabase.co`, "", false],
    ["localhost URL with ?host= public IP", "postgres://postgres:x@localhost:5432/postgres?host=203.0.113.10", "", false],
    ["empty host with ?host= override", `postgres://postgres:x@/postgres?host=db.${prod}.supabase.co`, "", false],
    ["unix socket host", "postgres://postgres:x@/postgres?host=/var/run/postgresql", "", false],
    ["libpq hostaddr override", "postgres://postgres:x@localhost:5432/postgres?hostaddr=203.0.113.10", "", false],
    ["libpq service override", "postgres://postgres:x@localhost:5432/postgres?service=prod", "", false],
    ["libpq options", "postgres://postgres:x@localhost:5432/postgres?options=-c%20role%3Dx", "", false],
    ["several hosts", "postgres://postgres:x@localhost,pg:5432/postgres", "", false],
    ["URL fragment", "postgres://postgres:x@localhost:5432/postgres#x", "", false],
    ["protected ref anywhere in URL", `postgres://postgres:x@localhost:5432/${prod}`, prod, false],
    ["remote named host (private DNS)", "postgres://postgres:x@staging.example.com:5432/postgres", "", false],
    ["public IP literal", "postgres://postgres:x@203.0.113.10:5432/postgres", "", false],
    ["dotless alias resolving to public IP", "postgres://postgres:x@db:5432/postgres", "", false],
    ["dotless alias with a public address among private ones", "postgres://postgres:x@mixed:5432/postgres", "", false],
    ["unresolvable dotless alias", "postgres://postgres:x@nowhere:5432/postgres", "", false],
    ["loopback", "postgres://postgres:x@127.0.0.1:5432/postgres", "", true],
    ["localhost", "postgres://postgres:x@localhost:5432/postgres", "", true],
    ["docker alias on a private network", "postgres://postgres:x@pg:5432/postgres", prod, true],
  ];
  const results = []; for (const [name, url, refs, allowed] of cases) results.push({ name, allowed, verdict: await verdict(url, refs) });
  const wrong = results.filter((r) => (r.verdict === "accepted") !== r.allowed);
  // The connection uses only the checked address and the five URL fields: environment overrides cannot redirect it.
  const saved = process.env.PGHOST; process.env.PGHOST = "203.0.113.10";
  const built = await resolveLocalTarget("postgres://postgres:x@pg:6543/postgres", "", lookup).catch((e) => e.message);
  const { Client } = require("pg"); const client = typeof built === "object" ? new Client(built) : null;
  if (saved === undefined) delete process.env.PGHOST; else process.env.PGHOST = saved;
  check("MF6", "connection config is exactly {host: checked address, port, user, password, database, ssl:false}; PGHOST ignored",
    typeof built === "object" && Object.keys(built).sort().join() === "database,host,password,port,ssl,user" && built.host === "192.168.32.5" && built.port === 6543 && client.host === "192.168.32.5", built);
  check("MF5", `initializer target guard: ${cases.filter((c) => !c[3]).length} hostile targets refused (incl. misconfigured refs and ?host= override), ${cases.filter((c) => c[3]).length} local targets accepted`, wrong.length === 0, wrong);
}

async function databaseChecks() {
  for (const img of [PG_IMAGE, PGRST_IMAGE]) if (sh("docker", ["image", "inspect", img]).status !== 0) { console.log(`SKIP: docker image ${img} not available`); return; }
  // PostgREST and the probe client run on an --internal network (no internet). Postgres is also published on
  // loopback only, so the initializer (run from this process) can connect.
  sh("docker", ["network", "create", "--internal", NET]); cleanup.push(() => sh("docker", ["network", "rm", NET]));
  const pgPort = await freePort();
  let r = sh("docker", ["run", "-d", "--rm", "--name", PG, "--network", "bridge", "-p", `127.0.0.1:${pgPort}:5432`, "-e", `POSTGRES_PASSWORD=${PW}`, PG_IMAGE]);
  if (r.status !== 0) throw new Error("BLOCKED: postgres container: " + r.stderr);
  cleanup.unshift(() => sh("docker", ["rm", "-f", PG]));
  sh("docker", ["network", "connect", "--alias", "pg", NET, PG]);
  let good = 0;
  for (let i = 0; i < 400 && good < 3; i += 1) { const x = sh("docker", ["exec", PG, "psql", "-X", "-At", "-U", "postgres", "-h", "127.0.0.1", "-c", "select count(*) from pg_roles where rolname in ('anon','authenticated','service_role','authenticator')"]); good = x.stdout && x.stdout.trim() === "4" ? good + 1 : 0; await sleep(300); }
  if (good < 3) throw new Error("BLOCKED: postgres not ready");
  const url = `postgres://postgres:${PW}@127.0.0.1:${pgPort}/postgres`;

  // ---- fresh initialization ----
  check("SB00", "fresh database has no public tables", one("select count(*) from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p')") === "0");
  const before = verify();
  check("SB01", "verification gate FAILS on an un-hardened Supabase database (Supabase defaults grant anon)", before.status !== 0 && /default privileges/.test(before.err), before.err.slice(0, 300));
  const log = [];
  let initError = null;
  try { await run({ url, mode: "fresh", log: (l) => log.push(l) }); } catch (error) { initError = error.message; }
  check("SB02", "fresh initialization: every manifest file applies once, in order, in a single pass (incl. lead-agents-schema.sql)",
    !initError && log.length === migrationOrder().length && log.every((l) => l.ok), { initError, failed: log.filter((l) => !l.ok) });
  check("SB03", "Track B: the dispatch-fence version of office_record_meta_social_receipt is the one installed",
    one("select prosrc ~ 'office_meta_social_pending_receipts' from pg_proc where proname='office_record_meta_social_receipt'") === "t");
  check("SB04", "verification gate passes after initialization", verify().status === 0, verify().err.slice(0, 400));

  // ---- posture ----
  check("SB05", "schema public: no USAGE/CREATE for anon, authenticated or PUBLIC; service_role has USAGE",
    one(`select bool_and(not has_schema_privilege(r, 'public', p)) from unnest(array['anon','authenticated']) r, unnest(array['USAGE','CREATE']) p`) === "t" &&
    one(`select count(*) from pg_namespace n, aclexplode(n.nspacl) x where n.nspname='public' and x.grantee=0`) === "0" &&
    one("select has_schema_privilege('service_role','public','USAGE')") === "t");
  const exposed = one(`select count(*) from pg_class c, unnest(array['anon','authenticated']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
    where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','v','m','f') and has_table_privilege(r, c.oid, p)`);
  const columns = one(`select count(*) from pg_class c, unnest(array['anon','authenticated']) r, unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) p
    where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','v','m','f') and has_any_column_privilege(r, c.oid, p)`);
  check("SB06", "table and column grants: anon/authenticated hold no table privilege and no column privilege on any relation", exposed === "0" && columns === "0", { exposed, columns });
  const fns = one(`select count(*) from pg_proc p, unnest(array['anon','authenticated']) r where p.pronamespace='public'::regnamespace and has_function_privilege(r, p.oid, 'EXECUTE')`);
  const publicFns = one(`select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) x where p.pronamespace='public'::regnamespace and x.grantee=0`);
  const seqs = one(`select count(*) from pg_class c, unnest(array['anon','authenticated']) r, unnest(array['USAGE','SELECT','UPDATE']) p where c.relnamespace='public'::regnamespace and c.relkind='S' and has_sequence_privilege(r, c.oid, p)`);
  const definers = one(`select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.prosecdef and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))`);
  check("SB07", "routines and sequences: none executable/usable by anon, authenticated or PUBLIC (incl. SECURITY DEFINER)", fns === "0" && publicFns === "0" && seqs === "0" && definers === "0", { fns, publicFns, seqs, definers });
  check("SB08", "RLS enabled on every existing table", one("select count(*) from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p') and not relrowsecurity") === "0");
  check("SB09", "required access: service_role reads every table; catalogue's deliberate restrictions kept (no TRUNCATE on catalogue tables)",
    one("select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p') and not has_table_privilege('service_role', c.oid, 'SELECT')") === "0" &&
    one("select bool_and(not has_table_privilege('service_role', c.oid, 'TRUNCATE')) from pg_class c where c.relnamespace='public'::regnamespace and c.relname like 'catalogue_%' and c.relkind='r'") === "t" &&
    one("select bool_and(has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE')) from pg_class c where c.relname in ('leads','conversations','lead_channel_states','admin_users','whatsapp_manual_sends')") === "t");

  // ---- later objects (as a future migration would create them) ----
  const later = psql(`create table public.sb_later (id bigint generated always as identity primary key, note text);
    create view public.sb_later_view as select id from public.sb_later;
    create function public.sb_later_fn() returns int language sql as 'select 1';`);
  check("SB10", "default privileges cover later objects: no anon/authenticated/PUBLIC access, service_role granted",
    later.status === 0 &&
    one(`select bool_and(not has_table_privilege(r, t, p)) from unnest(array['anon','authenticated']) r, unnest(array['public.sb_later','public.sb_later_view']) t, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p`) === "t" &&
    one(`select not has_function_privilege('anon','public.sb_later_fn()','EXECUTE') and not has_function_privilege('authenticated','public.sb_later_fn()','EXECUTE')`) === "t" &&
    one(`select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) x where p.oid='public.sb_later_fn()'::regprocedure and x.grantee=0`) === "0" &&
    one(`select not has_sequence_privilege('anon', pg_get_serial_sequence('public.sb_later','id'), 'USAGE')`) === "t" &&
    one(`select has_table_privilege('service_role','public.sb_later','SELECT,INSERT,UPDATE,DELETE') and has_function_privilege('service_role','public.sb_later_fn()','EXECUTE') and has_sequence_privilege('service_role', pg_get_serial_sequence('public.sb_later','id'), 'USAGE')`) === "t", later.err);
  const gateNew = verify();
  check("SB11", "RLS is NOT automatic for a later table: the gate fails and names it", gateNew.status !== 0 && /sb_later: RLS disabled/.test(gateNew.err), gateNew.err.slice(0, 300));
  let reassertError = null; try { await run({ url, mode: "reassert", log: () => {} }); } catch (error) { reassertError = error.message; }
  check("SB12", "re-applying the baseline enables RLS on the later table and the gate passes",
    !reassertError && one("select relrowsecurity from pg_class where oid='public.sb_later'::regclass") === "t" && verify().status === 0, reassertError);

  // ---- negative controls: drift the gate must catch and the baseline must repair ----
  const drift = psql(`grant usage on schema public to anon; grant select on public.leads to anon; grant select (email) on public.leads to authenticated;
    grant execute on function public.sb_later_fn() to public; grant usage on sequence public.catalogue_merchandising_events_id_seq to authenticated;
    alter default privileges for role postgres in schema public grant select on tables to anon; alter table public.audit_events disable row level security;`);
  const gateDrift = verify();
  const expected = ["schema public", "leads: anon", "leads.email: column grant", "sb_later_fn(): EXECUTE for PUBLIC", "catalogue_merchandising_events_id_seq: authenticated", "default privileges (postgres, public", "audit_events: RLS disabled"];
  check("SB13", "gate detects schema, table, column, routine, sequence, default-privilege and RLS drift",
    drift.status === 0 && gateDrift.status !== 0 && expected.every((e) => gateDrift.err.includes(e)), { missing: expected.filter((e) => !gateDrift.err.includes(e)), err: gateDrift.err.slice(0, 600) });
  reassertError = null; try { await run({ url, mode: "reassert", log: () => {} }); } catch (error) { reassertError = error.message; }
  check("SB14", "baseline repairs every drift item", !reassertError && verify().status === 0, reassertError);

  // ---- repeatability ----
  const s1 = one(SNAPSHOT); const errs = [];
  for (let i = 0; i < 3; i++) { try { await run({ url, mode: "reassert", log: () => {} }); } catch (error) { errs.push(error.message); } }
  check("SB15", "baseline is repeatable: three more applications, no errors, identical privilege snapshot", errs.length === 0 && one(SNAPSHOT) === s1, { errs });
  let refusedFresh = false; try { await run({ url, mode: "fresh", log: () => {} }); } catch (error) { refusedFresh = /not a fresh database/.test(error.message); }
  check("SB16", "initializer refuses --fresh on a non-empty database", refusedFresh);
  psql("alter schema office_local_init rename to office_local_init_hidden");
  let refusedUnmarked = false; try { await run({ url, mode: "reassert", log: () => {} }); } catch (error) { refusedUnmarked = /not initialized by this tool/.test(error.message); }
  psql("alter schema office_local_init_hidden rename to office_local_init");
  check("SB16b", "initializer refuses --reassert on a database it did not initialize (no marker)", refusedUnmarked);
  const marker = one("select obj_description('office_local_init'::regnamespace, 'pg_namespace')");
  psql("comment on schema office_local_init is 'office-local-init:1234567890123456789:5'");
  let refusedForged = false; try { await run({ url, mode: "reassert", log: () => {} }); } catch (error) { refusedForged = /not initialized by this tool on this cluster/.test(error.message); }
  psql(`comment on schema office_local_init is '${marker}'`);
  let acceptedOwn = true; try { await run({ url, mode: "reassert", log: () => {} }); } catch { acceptedOwn = false; }
  check("SB16c", "marker is bound to this cluster and database: a copied/forged marker is refused, the genuine one accepted",
    /^office-local-init:\d+:\d+$/.test(marker) && refusedForged && acceptedOwn, { marker: marker.replace(/\d{6,}/, "<sysid>") });
  let refusedRole = false;
  sh("docker", ["exec", PG, "psql", "-X", "-U", "supabase_admin", "-d", "postgres", "-h", "127.0.0.1", "-c", `alter role authenticator with password '${PW}'`]);
  const asAuthenticator = new URL(url); asAuthenticator.username = "authenticator";
  try { await run({ url: asAuthenticator.toString(), mode: "verify", log: () => {} }); } catch (error) { refusedRole = /not postgres/.test(error.message); }
  check("SB17", "initializer refuses a non-owner role", refusedRole);

  // ---- PostgREST (real) ----
  r = sh("docker", ["run", "-d", "--rm", "--name", REST, "--network", NET, "-e", `PGRST_DB_URI=postgres://authenticator:${PW}@pg:5432/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`, PGRST_IMAGE]);
  if (r.status !== 0) throw new Error("BLOCKED: postgrest container: " + r.stderr);
  cleanup.unshift(() => sh("docker", ["rm", "-f", REST]));
  // The test reaches PostgREST from a throwaway client on the same internal network.
  const probe = (calls) => { const out = sh("docker", ["run", "--rm", "--network", NET, "node:22-bookworm-slim", "node", "-e", `
    const calls = ${JSON.stringify(calls)}; (async () => { for (let i = 0; i < 100; i++) { try { await fetch("http://${REST}:3000/"); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
    const out = []; for (const c of calls) { const h = { "content-type": "application/json", Prefer: "return=representation" }; if (c.jwt) h.authorization = "Bearer " + c.jwt;
      const r = await fetch("http://${REST}:3000" + c.path, { method: c.method || "GET", headers: h, body: c.body ? JSON.stringify(c.body) : undefined }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
      out.push({ id: c.id, status: r.status, code: j && j.code || null, rows: Array.isArray(j) ? j.length : null, value: Array.isArray(j) ? null : (typeof j === "string" || typeof j === "boolean" ? j : null) }); }
    console.log(JSON.stringify(out)); })();`]); try { return JSON.parse(out.stdout.trim().split("\n").pop()); } catch { return [{ error: out.stderr.slice(0, 300) }]; } };
  if (sh("docker", ["image", "inspect", "node:22-bookworm-slim"]).status !== 0) { console.log("SKIP: node:22-bookworm-slim image not available for the PostgREST probe"); return; }
  psql(`insert into public.leads (name, source, status) values ('Synthetic baseline lead', 'test', 'new')`);
  const reads = [];
  for (const t of PROBE_TABLES) for (const [who, token] of [["anon", null], ["authenticated", jwt("authenticated")]]) reads.push({ id: `${who}:${t}`, path: `/${t}?select=*&limit=1`, jwt: token });
  reads.push({ id: "anon:rpc", method: "POST", path: "/rpc/office_record_meta_social_receipt", body: { p_channel: "facebook", p_binding: "1:2", p_mid: "m", p_state: "read" } });
  reads.push({ id: "authenticated:rpc", method: "POST", path: "/rpc/office_record_meta_social_receipt", jwt: jwt("authenticated"), body: { p_channel: "facebook", p_binding: "1:2", p_mid: "m", p_state: "read" } });
  const denied = probe(reads);
  check("SB18", `PostgREST refuses anon and authenticated reads of ${PROBE_TABLES.length} tables and Track B RPCs (42501, no rows)`,
    denied.length === reads.length && denied.every((x) => x.status >= 400 && x.code === "42501" && x.rows === null), denied.filter((x) => !(x.status >= 400 && x.code === "42501")));
  const svc = jwt("service_role");
  const ok = probe([
    { id: "read", path: "/leads?select=id,name&limit=5", jwt: svc },
    { id: "write", method: "POST", path: "/leads", jwt: svc, body: { name: "Synthetic service lead", source: "test", status: "new" } },
    { id: "rpc", method: "POST", path: "/rpc/office_record_meta_social_reply_target", jwt: svc, body: { p_channel: "facebook", p_sender_key: "meta-social:sender:" + "1".repeat(64), p_event_key: "meta-social:event:" + "2".repeat(64), p_text: "synthetic", p_occurred_at: new Date().toISOString(), p_asset: "111", p_sender: "333", p_opted_out: false } },
    { id: "sequence", method: "POST", path: "/sb_later", jwt: svc, body: { note: "identity column via sequence" } },
  ]);
  const by = Object.fromEntries(ok.map((x) => [x.id, x]));
  check("SB19", "PostgREST service_role keeps read, write, RPC and sequence-backed insert",
    by.read?.status === 200 && by.read.rows >= 1 && by.write?.status === 201 && by.rpc?.status === 200 && by.rpc.value === "accepted" && by.sequence?.status === 201, ok);
}

(async () => {
  await manifestChecks();
  try { await databaseChecks(); } catch (error) { check("SB--", "database checks completed", false, error.message); }
  finally { for (const fn of cleanup) fn(); }
  console.log(`\n${checks - failures}/${checks} checks passed`);
  console.log(failures ? "Office security baseline: FAIL" : "Office security baseline: PASS");
  process.exit(failures ? 1 : 0);
})();
