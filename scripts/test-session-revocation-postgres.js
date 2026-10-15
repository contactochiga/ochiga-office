// Settings S7.4 session generations against real databases (disposable Docker containers only; never a real project):
//   A. plain Postgres 16: the migration is additive and idempotent, preserves every account, the increment is atomic under true concurrency, rollback keeps the columns
//   B. Supabase Postgres 17 + PostgREST + the real SupabaseLeadAgentsStore: code deployed before the migration, capability re-probe, concurrent increments across two clients,
//      and the Data API roles (anon/authenticated) being refused for the new function.
// Skips (exit 0) when Docker or the images are unavailable.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Client } = require("pg");
const { SupabaseLeadAgentsStore } = require("../src/lead-agents/store-supabase");

const ROOT = path.join(__dirname, "..");
const sql = (f) => fs.readFileSync(path.join(ROOT, "db", f), "utf8");
const MIG = "20261020_admin_session_generation.sql", DOWN = "rollback/20261020_admin_session_generation.down.sql";
const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLAIN_PORT = 54371, SB_PORT = 54372, REST_PORT = 54373, PROXY_PORT = 54374, SUF = process.pid;
const IMG_PLAIN = "postgres:16-alpine", IMG_PG = "public.ecr.aws/supabase/postgres:17.6.1.131", IMG_REST = "public.ecr.aws/supabase/postgrest:v14.12";
const JWT_SECRET = "test-jwt-secret-test-jwt-secret-1234567890";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (role) => { const h = b64({ alg: "HS256", typ: "JWT" }), p = b64({ role, iss: "supabase-test", exp: Math.floor(Date.now() / 1000) + 7200 }); return `${h}.${p}.${crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url")}`; };
const client = async (port, user = "postgres", password = "x") => { const c = new Client({ host: "127.0.0.1", port, user, password, database: "postgres" }); await c.connect(); return c; };
const waitClient = async (port, user, password) => { for (let i = 0; i < 90; i++) { try { return await client(port, user, password); } catch { await sleep(1000); } } throw new Error("database did not become ready"); };
const names = [];

const TABLE = `create table if not exists admin_users (id uuid primary key default gen_random_uuid(), email text not null unique, password_hash text not null, role text not null default 'admin', status text not null default 'active', display_name text, permission_scopes text[] not null default '{}'::text[], created_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
const SNAP = "select id, email, password_hash, role, status, display_name, permission_scopes from admin_users order by email";
const snapHash = async (c) => crypto.createHash("sha256").update(JSON.stringify((await c.query(SNAP)).rows)).digest("hex");
const seed = (c) => c.query("insert into admin_users (email, password_hash, role, status, display_name, permission_scopes) values ('boss@ochiga.test','salt:hash-1','super_admin','active','Boss','{}'), ('staff@ochiga.test','salt:hash-2','ochiga_staff','active','Staff','{crm.read}'), ('gone@ochiga.test','salt:hash-3','ochiga_staff','inactive','Gone','{}')");

async function partA() {
  const name = `ochiga-s74-plain-${SUF}`; names.push(name);
  docker("run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=x", "-p", `${PLAIN_PORT}:5432`, IMG_PLAIN);
  const admin = await waitClient(PLAIN_PORT);
  await admin.query(TABLE); await seed(admin);
  const before = await snapHash(admin);

  await admin.query(sql(MIG));
  assert.equal(await snapHash(admin), before, "ids, emails, password hashes, roles, statuses, names and scopes are untouched by the migration");
  assert.deepEqual((await admin.query("select session_generation g, sessions_revoked_at a, sessions_revoked_by b from admin_users")).rows.map((r) => [r.g, r.a, r.b]), [[0, null, null], [0, null, null], [0, null, null]], "every existing account starts at generation 0, never revoked");
  await admin.query(sql(MIG)); assert.equal(await snapHash(admin), before, "re-applying is idempotent");
  await assert.rejects(() => admin.query("update admin_users set session_generation = -1 where email = 'boss@ochiga.test'"), (e) => e.code === "23514", "the check constraint refuses a negative generation");
  console.log("A1. Migration additive and idempotent: accounts unchanged, generation 0, negative generation refused — PASS");

  const boss = (await admin.query("select id from admin_users where email='boss@ochiga.test'")).rows[0].id;
  const rev = async (c, id, actor = "tester") => (await c.query("select * from office_revoke_admin_sessions($1::uuid,$2,$3)", [id, actor, "test"])).rows;
  let r = await rev(admin, boss, "alice"); assert.deepEqual([r.length, r[0].session_generation], [1, 1]); assert.ok(r[0].sessions_revoked_at);
  assert.equal((await admin.query("select sessions_revoked_by b from admin_users where id=$1", [boss])).rows[0].b, "alice", "actor recorded");
  assert.deepEqual(await rev(admin, "00000000-0000-0000-0000-000000000000"), [], "an unknown account matches nothing");
  const conns = await Promise.all(Array.from({ length: 10 }, () => client(PLAIN_PORT)));
  const burst = (await Promise.all(conns.map(async (c, ci) => { const out = []; for (let k = 0; k < 5; k += 1) out.push((await rev(c, boss, `c${ci}-${k}`))[0].session_generation); return out; }))).flat().sort((a, b) => a - b);
  assert.deepEqual(burst, Array.from({ length: 50 }, (_, i) => i + 2), "50 simultaneous revocations over 10 connections yield 50 distinct, consecutive generations (no lost update)");
  assert.equal((await admin.query("select session_generation g from admin_users where id=$1", [boss])).rows[0].g, 51);
  await Promise.all(conns.map((c) => c.end()));
  console.log("A2. Atomic increment: 50 concurrent revocations -> 50 distinct consecutive generations; unknown id matches nothing — PASS");

  // rollback is non-destructive: the function goes, the columns and every generation stay (dropping them would resurrect revoked sessions)
  await admin.query(sql(DOWN));
  assert.equal(Number((await admin.query("select count(*) c from pg_proc where proname='office_revoke_admin_sessions'")).rows[0].c), 0, "function removed");
  assert.equal((await admin.query("select session_generation g from admin_users where id=$1", [boss])).rows[0].g, 51, "generation preserved by the rollback");
  assert.equal(await snapHash(admin), before, "accounts still untouched after the rollback");
  await admin.query(sql(MIG)); assert.equal((await admin.query("select session_generation g from admin_users where id=$1", [boss])).rows[0].g, 51, "re-applying after a rollback keeps the generation (it is never reset to 0)");
  assert.equal((await rev(admin, boss))[0].session_generation, 52, "and the function works again");
  console.log("A3. Rollback keeps columns and generations; re-apply never resets a generation — PASS");

  // a deleted and recreated account is a different row: new id, generation 0 (the application compares the token's user id as well)
  await admin.query("delete from admin_users where id=$1", [boss]);
  const again = (await admin.query("insert into admin_users (email, password_hash, role) values ('boss@ochiga.test','salt:new','super_admin') returning id, session_generation g")).rows[0];
  assert.ok(again.id !== boss && again.g === 0, "recreated account: new id, generation 0");
  console.log("A4. Recreated account is a new row (new id, generation 0) — PASS");
  await admin.end();
}

function startProxy() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = []; req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const preq = http.request({ hostname: "127.0.0.1", port: REST_PORT, path: req.url.replace(/^\/rest\/v1/, "") || "/", method: req.method, headers: { ...req.headers, host: `127.0.0.1:${REST_PORT}` } }, (pres) => { res.writeHead(pres.statusCode, pres.headers); pres.pipe(res); });
        preq.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
        preq.end(Buffer.concat(chunks));
      });
    });
    server.listen(PROXY_PORT, "127.0.0.1", () => resolve(server));
  });
}
const rest = async (role, method, p, body) => { const r = await fetch(`http://127.0.0.1:${REST_PORT}${p}`, { method, headers: { apikey: jwt(role), authorization: `Bearer ${jwt(role)}`, "content-type": "application/json", prefer: "return=representation" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, text: await r.text() }; };


async function partB() {
  const pg = `ochiga-s74-sbpg-${SUF}`, pr = `ochiga-s74-rest-${SUF}`; names.push(pg, pr);
  docker("run", "-d", "--rm", "--name", pg, "-e", "POSTGRES_PASSWORD=testpw", "-p", `${SB_PORT}:5432`, IMG_PG);
  let admin = await waitClient(SB_PORT, "postgres", "testpw");
  await admin.end(); const sa = await waitClient(SB_PORT, "supabase_admin", "testpw"); await sa.query("alter role authenticator with password 'testpw'"); await sa.end(); admin = await client(SB_PORT, "postgres", "testpw");
  await admin.query(TABLE); await admin.query("alter table admin_users enable row level security"); await admin.query("revoke all on admin_users from anon, authenticated"); await seed(admin);
  docker("run", "-d", "--rm", "--name", pr, "-p", `${REST_PORT}:3000`, "-e", `PGRST_DB_URI=postgres://authenticator:testpw@host.docker.internal:${SB_PORT}/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`, "-e", "PGRST_DB_POOL=10", IMG_REST);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${REST_PORT}/`, { headers: { apikey: jwt("service_role") } })).status < 500) break; } catch { /* starting */ } await sleep(1000); }
  const proxy = await startProxy();
  const mkStore = () => new SupabaseLeadAgentsStore({ url: `http://127.0.0.1:${PROXY_PORT}`, serviceRoleKey: jwt("service_role"), requestTimeoutMs: 15000 });
  const s1 = mkStore(), s2 = mkStore();
  try {
    // B1: code deployed BEFORE the migration
    const u = await s1.getAdminUserByEmail("boss@ochiga.test"); assert.ok(u && u.session_generation === undefined, "before the migration the column does not exist: the application reads it as absent (generation 0)");
    assert.equal(await s1.supportsSessionRevocation(), false, "capability reported unavailable");
    await assert.rejects(() => s1.revokeAdminSessions(u.id, { actor: "a" }), (e) => e.code === "revocation_unavailable", "revocation refuses loudly, nothing is written");
    console.log("B1. Code before migration: column absent reads as generation 0, capability unavailable, revocation refuses — PASS");

    // B2: migration applied under a running store
    await admin.query(sql(MIG)); await admin.query("notify pgrst, 'reload schema'"); await sleep(2500);
    s1.sessionRevocationCheckedAt = 0; s2.sessionRevocationCheckedAt = 0;
    assert.equal(await s1.supportsSessionRevocation(), true, "re-probe finds the function");
    const fresh = await s1.getAdminUserByEmail("boss@ochiga.test"); assert.strictEqual(fresh.session_generation, 0, "existing account reads generation 0 as a number through PostgREST"); assert.equal(fresh.password_hash, "salt:hash-1", "password hash preserved");
    const one = await s1.revokeAdminSessions(u.id, { actor: "alice", reason: "test" }); assert.equal(one.session_generation, 1); assert.ok(one.sessions_revoked_at);
    assert.equal((await s2.getAdminUserByEmail("boss@ochiga.test")).session_generation, 1, "the second client sees the new generation immediately");
    const gens = (await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? s1 : s2).revokeAdminSessions(u.id, { actor: `r${i}` })))).map((x) => x.session_generation).sort((a, b) => a - b);
    assert.deepEqual(gens, Array.from({ length: 16 }, (_, i) => i + 2), "16 concurrent revocations through PostgREST and two clients: distinct and consecutive");
    assert.equal(await s1.revokeAdminSessions("00000000-0000-0000-0000-000000000000", { actor: "x" }), null, "unknown account -> null");
    await s1.updateAdminUser(u.id, { display_name: "Boss Renamed" }); assert.equal((await s2.getAdminUserByEmail("boss@ochiga.test")).session_generation, 17, "ordinary updates leave the generation alone");
    console.log("B2. Migration under a running store: capability re-probe, atomic increments across two clients, ordinary updates untouched — PASS");

    // B3: Data API roles cannot call it or read the columns
    const state = async () => (await admin.query("select md5(string_agg(email || session_generation::text, ',' order by email)) h from admin_users")).rows[0].h;
    const before = await state();
    for (const role of ["anon", "authenticated"]) {
      for (const [m, p, b] of [["POST", "/rpc/office_revoke_admin_sessions", { p_user_id: u.id, p_actor: "pwn" }], ["GET", "/admin_users?select=email,session_generation", undefined], ["PATCH", `/admin_users?id=eq.${u.id}`, { session_generation: 0 }]]) {
        const r = await rest(role, m, p, b); assert.ok([401, 403, 404].includes(r.status), `${role} ${m} ${p} refused (got ${r.status})`);
      }
    }
    assert.equal(await state(), before, "refused Data API calls changed nothing");
    const priv = (await admin.query("select has_function_privilege('anon','office_revoke_admin_sessions(uuid,text,text)','EXECUTE') a, has_function_privilege('authenticated','office_revoke_admin_sessions(uuid,text,text)','EXECUTE') u, has_function_privilege('service_role','office_revoke_admin_sessions(uuid,text,text)','EXECUTE') s")).rows[0];
    assert.deepEqual(priv, { a: false, u: false, s: true }, "only service_role may execute the function");
    console.log("B3. anon/authenticated refused for the function and the table; only service_role executes — PASS");
  } finally { proxy.close(); await admin.end().catch(() => {}); }
}

async function main() {
  try { for (const i of [IMG_PLAIN, IMG_PG, IMG_REST]) docker("image", "inspect", i); } catch { console.log("SKIP: Docker or the required images are unavailable"); return; }
  try { await partA(); await partB(); console.log(JSON.stringify({ status: "PASS", suite: "session-revocation-postgres" })); }
  finally { for (const n of names) { try { docker("rm", "-f", n); } catch { /* already gone */ } } }
}
main().catch((e) => { console.error(e); process.exit(1); });
