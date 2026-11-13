// WhatsApp sender identity (Phase 1) on DISPOSABLE Postgres (Supabase image) + PostgREST, driven through the real SupabaseLeadAgentsStore. Never a real project.
// Proves: the migration is additive and idempotent and changes no existing table, RLS or policy; its constraints; true concurrency (one link per business
// account + BSUID and per business account + lead; conflicts recorded once, never reassigned); scope per business account; lead deletion; anon/authenticated
// denied; non-destructive rollback tiers (no-op file; Tier 2 renames, never deletes; restorable).
// Requires Docker and public.ecr.aws/supabase/postgres:17.6.1.131 + public.ecr.aws/supabase/postgrest:v14.12 (SKIP otherwise).
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawnSync } = require("child_process");
const { SupabaseLeadAgentsStore } = require("../src/lead-agents/store-supabase");
const identity = require("../src/lead-agents/whatsapp-sender-identity");

const ROOT = path.resolve(__dirname, "..");
const PG_IMAGE = process.env.PG_IMAGE || "public.ecr.aws/supabase/postgres:17.6.1.131";
const PGRST_IMAGE = process.env.PGRST_IMAGE || "public.ecr.aws/supabase/postgrest:v14.12";
const RUN = crypto.randomBytes(3).toString("hex");
const NET = `ident-net-${RUN}`, PG = `ident-pg-${RUN}`, REST = `ident-rest-${RUN}`;
const PW = `pw_${crypto.randomBytes(10).toString("hex")}`, JWT_SECRET = crypto.randomBytes(24).toString("hex");
const MIGRATION = path.join(ROOT, "db", "20261113_whatsapp_sender_identities.sql");
const ROLLBACK = path.join(ROOT, "db", "rollback", "20261113_whatsapp_sender_identities.down.sql");
const TIER2 = path.join(ROOT, "db", "rollback", "20261113_whatsapp_sender_identities.tier2_archive.sql");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0, failures = 0;
const check = (id, text, cond, detail) => { checks += 1; if (!cond) failures += 1; console.log(`${cond ? "PASS" : "FAIL"} ${id} ${text}${cond ? "" : " :: " + String(JSON.stringify(detail === undefined ? null : detail)).slice(0, 500)}`); };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });
const cleanup = [];
function psql(sql, { stop = true } = {}) {
  const r = sh("docker", ["exec", "-i", PG, "psql", "-X", "-q", "-At", "-U", "postgres", "-d", "postgres", "-v", `ON_ERROR_STOP=${stop ? 1 : 0}`], { input: sql });
  return { status: r.status, out: (r.stdout || "").trim(), err: r.stderr || "" };
}
const one = (sql) => psql(sql).out;
const applyFile = (file, opts) => psql(fs.readFileSync(file, "utf8"), opts);
function jwt(role) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b({ alg: "HS256", typ: "JWT" }), body = b({ role, iss: "identity-test", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7200 });
  return `${head}.${body}.${crypto.createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`;
}

async function setup() {
  for (const img of [PG_IMAGE, PGRST_IMAGE]) if (sh("docker", ["image", "inspect", img]).status !== 0) return null;
  sh("docker", ["network", "create", NET]); cleanup.push(() => sh("docker", ["network", "rm", NET]));
  let r = sh("docker", ["run", "-d", "--rm", "--name", PG, "--network", NET, "--network-alias", "pg", "-e", `POSTGRES_PASSWORD=${PW}`, PG_IMAGE]);
  if (r.status !== 0) throw new Error("postgres container: " + r.stderr);
  cleanup.unshift(() => sh("docker", ["rm", "-f", PG]));
  let good = 0;
  for (let i = 0; i < 400 && good < 3; i += 1) { const x = sh("docker", ["exec", PG, "psql", "-X", "-At", "-U", "postgres", "-h", "127.0.0.1", "-c", "select count(*) from pg_roles where rolname in ('anon','authenticated','service_role','authenticator')"]); good = x.stdout && x.stdout.trim() === "4" ? good + 1 : 0; await sleep(300); }
  if (good < 3) throw new Error("postgres not ready");
  psql(fs.readFileSync(path.join(ROOT, "db", "lead-agents-schema.sql"), "utf8"), { stop: false });
  psql(fs.readFileSync(path.join(ROOT, "db", "lead-agents-schema.sql"), "utf8"), { stop: false });
  const dated = fs.readdirSync(path.join(ROOT, "db")).filter((f) => /^2026\d+.*\.sql$/.test(f) && f !== path.basename(MIGRATION)).sort();
  const failedMigs = dated.map((f) => ({ f, r: applyFile(path.join(ROOT, "db", f)) })).filter((x) => x.r.status !== 0);
  check("M00", "every pre-existing dated migration applies", failedMigs.length === 0, failedMigs.map((x) => x.f + ": " + x.r.err.slice(0, 200)));
  // the production hardening state (RLS on every table, nothing for PUBLIC/anon/authenticated)
  const p0 = psql(`
    revoke all on all tables in schema public from public, anon, authenticated;
    do $$ declare r record; begin for r in select c.oid::regclass as rel from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') loop execute format('alter table %s enable row level security', r.rel); end loop; end $$;
    grant usage on schema public to service_role, authenticator, postgres;
    alter default privileges in schema public revoke all on tables from anon, authenticated;`);
  check("M01", "production hardening state applied to the fixture", p0.status === 0, p0.err.slice(0, 300));
  sh("docker", ["exec", PG, "psql", "-X", "-U", "supabase_admin", "-d", "postgres", "-h", "127.0.0.1", "-c", `alter role authenticator with password '${PW}'`]);
  const restPort = await freePort();
  r = sh("docker", ["run", "-d", "--rm", "--name", REST, "--network", NET, "-p", `127.0.0.1:${restPort}:3000`, "-e", `PGRST_DB_URI=postgres://authenticator:${PW}@pg:5432/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`, "-e", "PGRST_SERVER_PORT=3000", PGRST_IMAGE]);
  if (r.status !== 0) throw new Error("postgrest container: " + r.stderr);
  cleanup.unshift(() => sh("docker", ["rm", "-f", REST]));
  const restUrl = `http://127.0.0.1:${restPort}`;
  for (let i = 0; i < 200; i += 1) { const x = await fetch(restUrl + "/", { headers: { authorization: `Bearer ${jwt("service_role")}` } }).catch(() => null); if (x && x.status === 200) break; await sleep(300); }
  const gwPort = await freePort();
  const gw = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "connection", "content-length"].includes(k)));
    try {
      const up = await fetch(restUrl + req.url.replace(/^\/rest\/v1/, ""), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !["content-encoding", "transfer-encoding", "content-length"].includes(k)))); res.end(buf);
    } catch { res.writeHead(502); res.end(); }
  });
  await new Promise((r2) => gw.listen(gwPort, "127.0.0.1", r2)); cleanup.unshift(() => gw.close());
  return { restUrl, gatewayUrl: `http://127.0.0.1:${gwPort}` };
}
async function reloadSchema(restUrl) {
  psql("notify pgrst, 'reload schema'");
  for (let i = 0; i < 60; i += 1) { await sleep(250); const r = await fetch(restUrl + "/whatsapp_sender_identities?limit=0&select=state", { headers: { authorization: `Bearer ${jwt("service_role")}` } }).catch(() => null); if (r && r.status === 200) break; }
  await sleep(500);
}

async function main() {
  const env = await setup();
  if (!env) { console.log("SKIP: docker or the Supabase Postgres / PostgREST images are unavailable"); return; }
  const { restUrl, gatewayUrl } = env;
  const leadsBefore = one("select string_agg(column_name || ':' || data_type, ',' order by column_name) from information_schema.columns where table_name = 'leads'");
  const rlsBefore = one("select string_agg(relname || '=' || relrowsecurity::text, ',' order by relname) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'");
  const policiesBefore = one("select count(*) from pg_policies");

  const m1 = applyFile(MIGRATION), m2 = applyFile(MIGRATION);
  check("M02", "migration applies, and applies again cleanly (idempotent)", m1.status === 0 && m2.status === 0, (m1.err + m2.err).slice(0, 400));
  const rlsAfter = one("select string_agg(relname || '=' || relrowsecurity::text, ',' order by relname) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname <> 'whatsapp_sender_identities'");
  check("M03", "no existing table, column, RLS setting or policy changes (leads untouched)", one("select string_agg(column_name || ':' || data_type, ',' order by column_name) from information_schema.columns where table_name = 'leads'") === leadsBefore && rlsAfter === rlsBefore && one("select count(*) from pg_policies") === policiesBefore);
  check("M04", "the new table is server-only (RLS on, no policies)", one("select relrowsecurity::text from pg_class where oid = 'whatsapp_sender_identities'::regclass") === "true" && one("select count(*) from pg_policies where tablename = 'whatsapp_sender_identities'") === "0");
  await reloadSchema(restUrl);
  const store = new SupabaseLeadAgentsStore({ url: gatewayUrl, serviceRoleKey: jwt("service_role"), requestTimeoutMs: 15000 });
  const fresh = () => new SupabaseLeadAgentsStore({ url: gatewayUrl, serviceRoleKey: jwt("service_role"), requestTimeoutMs: 15000 });
  const leads = [];
  for (let i = 0; i < 22; i += 1) leads.push((await store.createLead({ phone: `23480900000${String(i).padStart(2, "0")}`, whatsapp_phone: `23480900000${String(i).padStart(2, "0")}`, source: "whatsapp", status: "new" })).id);
  const W = "102290129340398";
  const ins = (sql) => psql(sql);
  const badFormat = ins(`insert into whatsapp_sender_identities (business_account_id, business_scoped_user_id, lead_id, state) values ('${W}', '2348090000000', '${leads[0]}', 'linked')`);
  const badAccount = ins(`insert into whatsapp_sender_identities (business_account_id, business_scoped_user_id, lead_id, state) values ('waba', 'NG.1', '${leads[0]}', 'linked')`);
  const badConflict = ins(`insert into whatsapp_sender_identities (business_account_id, business_scoped_user_id, lead_id, state) values ('${W}', 'NG.1', '${leads[0]}', 'conflict')`);
  const linkedWithReason = ins(`insert into whatsapp_sender_identities (business_account_id, business_scoped_user_id, lead_id, state, conflict_reason) values ('${W}', 'NG.1', '${leads[0]}', 'linked', 'user_id_linked_to_other_lead')`);
  const parent = ins(`insert into whatsapp_sender_identities (business_account_id, business_scoped_user_id, lead_id, state) values ('${W}', 'US.ENT.123', '${leads[0]}', 'linked')`);
  check("M05", "constraints: a phone number, a parent BSUID, a non-numeric business account, a conflict without a reason and a link with a reason are all rejected", [badFormat, badAccount, badConflict, linkedWithReason, parent].every((r) => r.status !== 0 && /violates check constraint/.test(r.err)));

  // concurrency 1: the same sender (same lead) from 20 connections at once -> exactly one link
  const same = await Promise.all(Array.from({ length: 20 }, () => identity.associate(fresh(), { businessAccountId: W, businessScopedUserId: "NG.1000000001", leadId: leads[1], providerMessageId: "wamid.x" })));
  check("C01", "20 concurrent associations of one sender to its lead -> one link, the rest already linked", same.filter((r) => r.outcome === "linked").length === 1 && same.every((r) => ["linked", "already_linked"].includes(r.outcome)) && one(`select count(*) from whatsapp_sender_identities where business_scoped_user_id = 'NG.1000000001'`) === "1", same.map((r) => r.outcome));
  // concurrency 2: one BSUID, 20 DIFFERENT leads at once -> one link; every other lead gets a conflict; nothing reassigned
  const many = await Promise.all(leads.slice(2, 22).map((leadId) => identity.associate(fresh(), { businessAccountId: W, businessScopedUserId: "NG.2000000002", leadId, providerMessageId: "wamid.y" })));
  const winner = one(`select lead_id from whatsapp_sender_identities where business_scoped_user_id = 'NG.2000000002' and state = 'linked'`);
  check("C02", "one BSUID claimed by 20 different leads at once -> exactly one link; 19 conflicts naming the linked lead", many.filter((r) => r.outcome === "linked").length === 1 && many.filter((r) => r.outcome === "conflict").length === 19 && one(`select count(*) from whatsapp_sender_identities where business_scoped_user_id = 'NG.2000000002' and state = 'conflict' and conflict_reason = 'user_id_linked_to_other_lead' and conflicting_lead_id = '${winner}'`) === "19", many.map((r) => r.outcome));
  // concurrency 3: one lead, 10 different BSUIDs at once -> one link; 9 conflicts
  const perLead = await Promise.all(Array.from({ length: 10 }, (_, i) => identity.associate(fresh(), { businessAccountId: W, businessScopedUserId: `NG.30000000${i}`, leadId: leads[0], providerMessageId: "wamid.z" })));
  check("C03", "one lead with 10 different BSUIDs at once -> one link; 9 conflicts", perLead.filter((r) => r.outcome === "linked").length === 1 && one(`select count(*) from whatsapp_sender_identities where lead_id = '${leads[0]}' and state = 'linked'`) === "1" && one(`select count(*) from whatsapp_sender_identities where lead_id = '${leads[0]}' and state = 'conflict' and conflict_reason = 'lead_linked_to_other_user_id'`) === "9", perLead.map((r) => r.outcome));
  const loser = leads.slice(2, 22).find((id) => id !== winner);
  const conflictRowsBefore = one("select count(*) from whatsapp_sender_identities where state = 'conflict'");
  const repeat = await identity.associate(store, { businessAccountId: W, businessScopedUserId: "NG.2000000002", leadId: loser, providerMessageId: "wamid.again" });
  check("C04", "a repeated conflicting message records nothing new and never reassigns", repeat.outcome === "conflict" && repeat.created === false && one("select count(*) from whatsapp_sender_identities where state = 'conflict'") === conflictRowsBefore && one(`select lead_id from whatsapp_sender_identities where business_scoped_user_id = 'NG.2000000002' and state = 'linked'`) === winner, repeat);
  const otherAccount = await identity.associate(store, { businessAccountId: "987654321", businessScopedUserId: "NG.2000000002", leadId: leads[3], providerMessageId: "wamid.w" });
  check("C05", "scope: the same BSUID under another business account links independently", otherAccount.outcome === "linked");
  const summary = await store.whatsAppSenderIdentitySummary();
  check("C06", "summary through PostgREST: counts only", summary.linked === 4 && summary.conflicts === 28 && !/NG\.|[0-9a-f]{8}-[0-9a-f]{4}-/.test(JSON.stringify(summary)), summary);

  // lead deletion: its identity rows go with it; a conflict naming it keeps the row but drops the reference
  psql(`delete from leads where id = '${winner}'`);
  check("D01", "deleting a lead removes its identity rows and clears references to it", one(`select count(*) from whatsapp_sender_identities where lead_id = '${winner}'`) === "0" && one(`select count(*) from whatsapp_sender_identities where conflicting_lead_id = '${winner}'`) === "0" && one(`select count(*) from whatsapp_sender_identities where business_scoped_user_id = 'NG.2000000002' and state = 'conflict'`) === "19");

  // anon / authenticated cannot read or write through PostgREST
  const probe = async (role, method, p, body) => (await fetch(restUrl + p, { method, headers: { "content-type": "application/json", authorization: `Bearer ${jwt(role)}` }, body: body ? JSON.stringify(body) : undefined })).status;
  const a1 = await probe("anon", "GET", "/whatsapp_sender_identities"), a2 = await probe("authenticated", "GET", "/whatsapp_sender_identities"), a3 = await probe("anon", "POST", "/whatsapp_sender_identities", { business_account_id: W, business_scoped_user_id: "NG.9", lead_id: leads[0], state: "linked" });
  check("P01", "anon and authenticated roles cannot read or write sender identities", a1 >= 400 && a2 >= 400 && a3 >= 400, { a1, a2, a3 });

  // rollback tiers
  const snap = () => one("select count(*) || ':' || md5(coalesce(string_agg(row_to_json(t)::text, '|' order by id), '')) from whatsapp_sender_identities t");
  const before = snap();
  const down = applyFile(ROLLBACK);
  check("R01", "Tier 0/1 rollback file changes nothing (read-only check only)", down.status === 0 && snap() === before, down.err.slice(0, 200));
  const rows = Number(one("select count(*) from whatsapp_sender_identities"));
  const t2 = applyFile(TIER2);
  check("R02", "Tier 2 renames the table: no row deleted, constraints and RLS kept", t2.status === 0 && to_regclass_is_null("whatsapp_sender_identities") && Number(one("select count(*) from whatsapp_sender_identities_archive")) === rows && one("select relrowsecurity::text from pg_class where oid = 'whatsapp_sender_identities_archive'::regclass") === "true", t2.err.slice(0, 300));
  const t2again = applyFile(TIER2);
  check("R03", "Tier 2 refuses to run twice (never overwrites an archive)", t2again.status !== 0 && /does not exist|already exists/.test(t2again.err));
  const reapply = applyFile(MIGRATION);
  check("R04", "the migration re-applies next to the archive (empty new table)", reapply.status === 0 && one("select count(*) from whatsapp_sender_identities") === "0", reapply.err.slice(0, 300));
  const restore = psql("begin; drop table whatsapp_sender_identities; alter table whatsapp_sender_identities_archive rename to whatsapp_sender_identities; alter index uq_whatsapp_sender_identities_archive_user rename to uq_whatsapp_sender_identities_user; alter index uq_whatsapp_sender_identities_archive_lead rename to uq_whatsapp_sender_identities_lead; alter index whatsapp_sender_identities_archive_conflicts_idx rename to whatsapp_sender_identities_conflicts_idx; alter index whatsapp_sender_identities_archive_pkey rename to whatsapp_sender_identities_pkey; alter index whatsapp_sender_identities_archive_pair_key rename to whatsapp_sender_identities_pair_key; commit;");
  await reloadSchema(restUrl);
  const afterRestore = await identity.associate(store, { businessAccountId: W, businessScopedUserId: "NG.1000000001", leadId: leads[1], providerMessageId: "wamid.r" });
  check("R05", "restore (rename back) returns every row and the rules still hold", restore.status === 0 && Number(one("select count(*) from whatsapp_sender_identities")) === rows && afterRestore.outcome === "already_linked" && applyFile(MIGRATION).status === 0, restore.err.slice(0, 300));

  console.log(JSON.stringify({ suite: "whatsapp-sender-identity-postgres", checks, failures }));
  if (failures) process.exitCode = 1;
}
function to_regclass_is_null(name) { return one(`select (to_regclass('public.${name}') is null)::text`) === "true"; }

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { for (const fn of cleanup) { try { await fn(); } catch { /* best effort */ } } });
