// Settings S7.5.4 against real databases (disposable Docker containers only; never a real project):
//   A. plain Postgres 16: migration 20261024 (order guard, additive, idempotent, index replacement, access control), the atomic activation / revocation / recovery-consumption functions under true
//      concurrency, rollback of a failing operation as a WHOLE, and the non-destructive down migration.
//   B. Supabase Postgres 17 + PostgREST + the real SupabaseLeadAgentsStore driving the REAL Office server: enrollment (begin/confirm), replacement, removal, recovery-code regeneration, the atomic
//      recovery sign-in across two server instances, code-before-migration compatibility, Data API isolation of the new functions, and fail-closed behaviour when the database goes away.
// Skips (exit 0) without Docker.
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
const MIG = "20261020_admin_session_generation.sql", MFA = "20261022_admin_mfa_foundation.sql", MFA_DOWN = "rollback/20261022_admin_mfa_foundation.down.sql", KEYID = "20261023_admin_mfa_recovery_code_key_id.sql", MGMT = "20261024_admin_mfa_management.sql", MGMT_DOWN = "rollback/20261024_admin_mfa_management.down.sql";
const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLAIN_PORT = 54411, SB_PORT = 54412, REST_PORT = 54413, PROXY_PORT = 54414, SUF = process.pid;
const IMG_PLAIN = "postgres:16-alpine", IMG_PG = "public.ecr.aws/supabase/postgres:17.6.1.131", IMG_REST = "public.ecr.aws/supabase/postgrest:v14.12";
const JWT_SECRET = "test-jwt-secret-test-jwt-secret-1234567890";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (role) => { const h = b64({ alg: "HS256", typ: "JWT" }), p = b64({ role, iss: "supabase-test", exp: Math.floor(Date.now() / 1000) + 7200 }); return `${h}.${p}.${crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url")}`; };
const client = async (port, user = "postgres", password = "x", database = "postgres") => { const c = new Client({ host: "127.0.0.1", port, user, password, database }); await c.connect(); return c; };
const waitClient = async (port, user, password) => { for (let i = 0; i < 90; i++) { try { return await client(port, user, password); } catch { await sleep(1000); } } throw new Error("database did not become ready"); };
const names = [];
const TABLE = `create table if not exists admin_users (id uuid primary key default gen_random_uuid(), email text not null unique, password_hash text not null, role text not null default 'admin', status text not null default 'active', display_name text, permission_scopes text[] not null default '{}'::text[], password_changed_at timestamptz, removed_at timestamptz, removed_by text, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
const CLAIM_TABLES = `create table if not exists password_reset_tokens (id uuid primary key default gen_random_uuid(), admin_user_id uuid, email text, token_hash text, status text not null default 'pending', used_at timestamptz, expires_at timestamptz, requested_by text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists admin_invites (id uuid primary key default gen_random_uuid(), admin_user_id uuid, email text, token_hash text, status text not null default 'pending', accepted_at timestamptz, expires_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());`;
const SNAP = "select id, email, password_hash, role, status, display_name, permission_scopes from admin_users order by email";
const snapHash = async (c) => crypto.createHash("sha256").update(JSON.stringify((await c.query(SNAP)).rows)).digest("hex");
const seed = (c) => c.query("insert into admin_users (email, password_hash, role, status, display_name, permission_scopes) values ('boss@ochiga.test','salt:hash-1','super_admin','active','Boss','{}'), ('staff@ochiga.test','salt:hash-2','ochiga_staff','active','Staff','{crm.read}'), ('gone@ochiga.test','salt:hash-3','ochiga_staff','inactive','Gone','{}')");
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
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { hashPassword } = require("../src/lead-agents/auth");
const m = require("../src/lead-agents/mfa-crypto");
const randomB64 = (n) => crypto.randomBytes(n).toString("base64");
const H = (tag) => `hmac-${tag}-${crypto.randomBytes(24).toString("base64url")}`;
const SESSION = "s7-5-4-pg-session-secret-0123456789abcdef-xyz", K1 = randomB64(32);
const FUNCS = ["office_mfa_management_version()", "office_mfa_activate_credential(uuid,uuid,text,uuid,bigint,text[],text)", "office_mfa_revoke_credential(uuid,uuid,text,text,boolean)", "office_mfa_consume_recovery_code_revoking(uuid,text,text)"];

async function partA() {
  const name = `ochiga-s754-plain-${SUF}`; names.push(name);
  docker("run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=x", "-p", `${PLAIN_PORT}:5432`, IMG_PLAIN);
  const admin = await waitClient(PLAIN_PORT);
  await admin.query("create database early"); const ea = await client(PLAIN_PORT, "postgres", "x", "early"); await ea.query(TABLE); await ea.query(sql(MIG)); await ea.query(sql(MFA));
  await assert.rejects(() => ea.query(sql(MGMT)), /apply 20261023_admin_mfa_recovery_code_key_id\.sql/, "refuses to apply before 20261023"); await ea.end();
  console.log("A0. Order guard: 20261024 refuses to apply without 20261023 — PASS");
  for (const r of ["anon", "authenticated", "service_role"]) await admin.query(`create role ${r} nologin`);
  await admin.query(TABLE); await admin.query(sql(MIG)); await admin.query(sql(MFA)); await admin.query(sql(KEYID)); await seed(admin); await admin.query("grant all on admin_users to service_role");
  const boss = (await admin.query("select id from admin_users where email='boss@ochiga.test'")).rows[0].id, staff = (await admin.query("select id from admin_users where email='staff@ochiga.test'")).rows[0].id;
  const totp = async (user, status = "pending") => (await admin.query("insert into admin_mfa_credentials (admin_user_id, type, status, secret_ciphertext, secret_nonce, secret_key_id) values ($1,'totp',$2,'ct-'||gen_random_uuid()::text,'nonce','k1') returning id", [user, status])).rows[0].id;
  const oldActive = await totp(boss, "active"); await assert.rejects(() => totp(boss, "pending").then(() => totp(boss, "pending")), (e) => e.code === "23505", "(old index) one pending-or-active per account");
  await admin.query("delete from admin_mfa_credentials"); const before = await snapHash(admin);
  const cat = async () => (await admin.query("select (select count(*) from pg_proc where proname like 'office_mfa%') fn, (select string_agg(indexname, ',' order by indexname) from pg_indexes where tablename='admin_mfa_credentials') idx")).rows[0];
  await admin.query(sql(MGMT)); assert.equal(await snapHash(admin), before, "accounts untouched"); const c1 = await cat(); await admin.query(sql(MGMT)); await admin.query(sql(MGMT)); assert.deepEqual(await cat(), c1, "idempotent"); assert.ok(c1.idx.includes("admin_mfa_one_active_totp_per_user") && c1.idx.includes("admin_mfa_one_pending_totp_per_user") && !c1.idx.includes("admin_mfa_one_totp_per_user"), "the single index was replaced by one-active + one-pending");
  const a = await totp(boss, "active"); const p = await totp(boss, "pending"); await assert.rejects(() => totp(boss, "pending"), (e) => e.code === "23505", "still at most one pending"); await assert.rejects(() => totp(boss, "active"), (e) => e.code === "23505", "and at most one active"); assert.ok(a && p, "an active and a pending TOTP can coexist (replacement)"); await admin.query("delete from admin_mfa_credentials");
  for (const role of ["anon", "authenticated"]) { for (const f of FUNCS) assert.equal((await admin.query("select has_function_privilege($1,$2,'EXECUTE') v", [role, f])).rows[0].v, false, `${role} cannot execute ${f}`); } assert.ok((await Promise.all(FUNCS.map(async (f) => (await admin.query("select has_function_privilege('service_role',$1,'EXECUTE') v", [f])).rows[0].v))).every(Boolean), "service_role executes all"); assert.equal((await admin.query("select count(*) c from information_schema.routine_privileges where routine_name in ('office_mfa_activate_credential','office_mfa_revoke_credential','office_mfa_consume_recovery_code_revoking','office_mfa_management_version') and grantee='PUBLIC'")).rows[0].c, "0", "nothing granted to PUBLIC");
  for (const role of ["anon", "authenticated"]) { const c = await client(PLAIN_PORT); await c.query(`set role ${role}`); for (const q of ["select * from office_mfa_activate_credential(gen_random_uuid(), gen_random_uuid(), 'x')", "select * from office_mfa_revoke_credential(gen_random_uuid(), gen_random_uuid(), 'x')", "select * from office_mfa_consume_recovery_code_revoking(gen_random_uuid(), 'x', 'x')"]) await assert.rejects(() => c.query(q), (e) => e.code === "42501", `${role}: ${q.slice(0, 40)} refused`); await c.end(); }
  console.log("A1. 20261024: additive and idempotent; one-active + one-pending TOTP; functions service-role only — PASS");

  const gen = async (id) => Number((await admin.query("select session_generation g from admin_users where id=$1", [id])).rows[0].g);
  const act = async (c, uid, cred, o = {}) => (await c.query("select * from office_mfa_activate_credential($1::uuid,$2::uuid,$3,$4::uuid,$5::bigint,$6::text[],$7)", [uid, cred, o.actor || "t", o.replace ?? null, o.step ?? null, o.codes ?? null, o.keyId ?? null])).rows;
  const g0 = await gen(boss); const pending1 = await totp(boss, "pending"); const hm = Array.from({ length: 10 }, (_, i) => H(`c${i}`));
  assert.deepEqual(await act(admin, boss, crypto.randomUUID()), [], "an unknown/not-pending credential: no row, nothing changed"); assert.deepEqual(await act(admin, staff, pending1), [], "another account's pending credential: no row"); assert.equal(await gen(boss), g0);
  let r = (await act(admin, boss, pending1, { step: 777, codes: hm, keyId: "k1" }))[0]; assert.deepEqual([r.session_generation, r.replaced, r.recovery_codes], [g0 + 1, false, 10], "first factor: activated, 10 codes stored, generation bumped — one call");
  const cr = (await admin.query("select status, totp_last_step s, activated_at from admin_mfa_credentials where id=$1", [pending1])).rows[0]; assert.ok(cr.status === "active" && Number(cr.s) === 777 && cr.activated_at, "the confirmation step is recorded (cannot be replayed)"); assert.deepEqual((await admin.query("select distinct key_id k, count(*) c from admin_mfa_recovery_codes where admin_user_id=$1 and used_at is null group by 1", [boss])).rows, [{ k: "k1", c: "10" }], "codes stored with their key id");
  assert.equal((await admin.query("select office_mfa_consume_totp_step($1,777) v", [pending1])).rows[0].v, false, "the recorded step is a replay");
  // atomic failure: a replacement whose target is not the active credential rolls back EVERYTHING
  const pending2 = await totp(boss, "pending"); const snap = async () => JSON.stringify([(await admin.query("select id, status, totp_last_step from admin_mfa_credentials order by id")).rows, (await admin.query("select count(*) c from admin_mfa_recovery_codes")).rows, await gen(boss)]); const s0 = await snap();
  await assert.rejects(() => act(admin, boss, pending2, { replace: crypto.randomUUID(), codes: [H("never")] }), (e) => e.code === "P0001", "a bogus replacement target raises"); assert.equal(await snap(), s0, "…and the failed call changed nothing at all (credential still pending, codes untouched, generation unchanged)");
  const dupH = H("dup"); await assert.rejects(() => act(admin, boss, pending2, { replace: pending1, codes: [dupH, dupH] }), (e) => e.code === "23505", "a failure while storing codes (duplicate hash)"); assert.equal(await snap(), s0, "…rolls back the revocation of the old factor and the activation of the new one too");
  r = (await act(admin, boss, pending2, { replace: pending1, step: 900 }))[0]; assert.deepEqual([r.replaced, r.recovery_codes, r.session_generation], [true, 0, g0 + 2], "replacement: old revoked, new active, codes untouched, one bump"); assert.deepEqual((await admin.query("select id, status, revoked_reason from admin_mfa_credentials order by status, id")).rows.map((x) => [x.status, x.revoked_reason]).sort(), [["active", null], ["revoked", "replaced"]]);
  // concurrency: 10 connections confirm the SAME pending credential
  const conns = await Promise.all(Array.from({ length: 10 }, () => client(PLAIN_PORT))); const par = async (n, fn) => (await Promise.all(Array.from({ length: 10 }, async (_, lane) => { const out = []; for (let i = lane; i < n; i += 10) out.push([i, await fn(conns[lane], i)]); return out; }))).flat().sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  const u3 = (await admin.query("insert into admin_users (email, password_hash) values ('race@ochiga.test','salt:x') returning id")).rows[0].id; const pend3 = await totp(u3, "pending"); const g3 = await gen(u3);
  const raced = await par(20, (c) => act(c, u3, pend3, { codes: [H(`r${Math.random()}`)] }).then((rows) => rows.length)); assert.equal(raced.filter((n) => n === 1).length, 1, "20 simultaneous activations of one pending credential: exactly one succeeds"); assert.equal(await gen(u3), g3 + 1, "one bump"); assert.equal(Number((await admin.query("select count(*) c from admin_mfa_recovery_codes where admin_user_id=$1", [u3])).rows[0].c), 1);
  console.log("A2. Activation: first factor + codes + step + bump in one call; failures roll back as a whole; 20-way race has one winner; replacement revokes the old factor atomically — PASS");

  const rev = async (c, uid, cred, o = {}) => (await c.query("select * from office_mfa_revoke_credential($1::uuid,$2::uuid,$3,$4,$5)", [uid, cred, o.actor || "t", o.reason ?? "removed", o.keep ?? false])).rows;
  const u4 = (await admin.query("insert into admin_users (email, password_hash) values ('rev@ochiga.test','salt:x') returning id")).rows[0].id; const act4 = await totp(u4, "pending"); await act(admin, u4, act4, { codes: [H("a"), H("b")], keyId: "k1" }); const g4 = await gen(u4); const s4 = async () => JSON.stringify([(await admin.query("select status from admin_mfa_credentials where admin_user_id=$1", [u4])).rows, (await admin.query("select count(*) c from admin_mfa_recovery_codes where admin_user_id=$1 and used_at is null", [u4])).rows, await gen(u4)]); const before4 = await s4();
  await assert.rejects(() => rev(admin, u4, act4, { keep: true }), (e) => e.code === "P0001" && /last_active_factor/.test(e.message), "the last active factor with keep_last: refused"); assert.equal(await s4(), before4, "…and everything rolled back (credential still active, codes intact, no bump)");
  assert.deepEqual(await rev(admin, staff, act4), [], "another account cannot revoke it"); assert.deepEqual(await rev(admin, u4, crypto.randomUUID()), [], "unknown credential: no row");
  const pend4 = await totp(u4, "pending"); const rp = (await rev(admin, u4, pend4))[0]; assert.deepEqual([rp.was_active, rp.session_generation, rp.codes_deleted], [false, g4, 0], "revoking a PENDING credential: no bump, no code deletion");
  const rr = (await rev(admin, u4, act4))[0]; assert.deepEqual([rr.was_active, rr.remaining_active, rr.codes_deleted, rr.session_generation], [true, 0, 2, g4 + 1], "revoking the last active factor (allowed): unused codes deleted, generation bumped, one call"); assert.deepEqual(await rev(admin, u4, act4), [], "already revoked: no row");
  const u5 = (await admin.query("insert into admin_users (email, password_hash) values ('two@ochiga.test','salt:x') returning id")).rows[0].id; await admin.query("insert into admin_mfa_credentials (admin_user_id, type, status, webauthn_credential_id, webauthn_public_key) values ($1,'webauthn','active','\\x0102','\\x0a')", [u5]); const t5 = await totp(u5, "active"); await admin.query("insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac) values ($1, gen_random_uuid(), $2)", [u5, H("keep")]); const k = (await rev(admin, u5, t5, { keep: true }))[0]; assert.deepEqual([k.remaining_active, k.codes_deleted], [1, 0], "with another active factor remaining, keep_last allows removal and keeps the codes");
  console.log("A3. Revocation: last-factor guard rolls back completely; pending removal changes no session; last removal deletes codes and bumps once — PASS");

  const u6 = (await admin.query("insert into admin_users (email, password_hash) values ('rc@ochiga.test','salt:x') returning id")).rows[0].id; const codes6 = Array.from({ length: 12 }, (_, i) => H(`k${i}`)); await admin.query("select office_mfa_replace_recovery_codes($1,gen_random_uuid(),$2::text[],'k1')", [u6, codes6]); const g6 = await gen(u6);
  const crr = async (c, uid, h) => (await c.query("select * from office_mfa_consume_recovery_code_revoking($1::uuid,$2,$3)", [uid, h, "actor"])).rows;
  assert.deepEqual(await crr(admin, staff, codes6[0]), [], "another account's code: nothing consumed, no bump"); assert.deepEqual(await crr(admin, u6, "nope-not-a-real-hash-000000"), [], "unknown hash: no row"); assert.equal(await gen(u6), g6, "no bump for a refused code");
  const wins = await par(30, (c) => crr(c, u6, codes6[0]).then((x) => x.length)); assert.equal(wins.filter((n) => n === 1).length, 1, "30 simultaneous uses of one recovery code over 10 connections: exactly ONE succeeds"); assert.equal(await gen(u6), g6 + 1, "…and the generation moved exactly once");
  const distinct = await par(10, (c, i) => crr(c, u6, codes6[1 + i]).then((x) => x[0].session_generation)); assert.deepEqual([...distinct].sort((x, y) => x - y), Array.from({ length: 10 }, (_, i) => g6 + 2 + i), "ten different codes at once: ten consumptions, ten distinct consecutive generations (no lost update)");
  assert.equal(Number((await admin.query("select count(*) c from admin_mfa_recovery_codes where admin_user_id=$1 and used_at is null", [u6])).rows[0].c), 1);
  const stuck = await client(PLAIN_PORT); await stuck.query("begin"); await stuck.query("select * from admin_users where id=$1 for update", [u6]); const blocked = crr(admin, u6, codes6[11]).then(() => "finished"); await sleep(300); assert.equal(await Promise.race([blocked, sleep(200).then(() => "waiting")]), "waiting", "(setup) the call waits on the account row lock"); await stuck.query("rollback"); await stuck.end(); assert.equal(await blocked, "finished");
  await Promise.all(conns.map((c) => c.end()));
  console.log("A4. Recovery consumption + generation bump is ONE step: 30-way race one winner, bumped once; ten codes -> ten consecutive generations; refused codes change nothing — PASS");

  const rows0 = (await admin.query("select (select count(*) from admin_mfa_credentials) c, (select count(*) from admin_mfa_recovery_codes) r, (select md5(string_agg(id::text || status, ',' order by id)) from admin_mfa_credentials) m")).rows[0];
  const both = (await admin.query("insert into admin_users (email, password_hash) values ('both@ochiga.test','salt:x') returning id")).rows[0].id; const bA = await totp(both, "active"); const bP = await totp(both, "pending");
  await admin.query(sql(MGMT_DOWN)); assert.equal((await admin.query("select count(*) c from pg_proc where proname in ('office_mfa_activate_credential','office_mfa_revoke_credential','office_mfa_consume_recovery_code_revoking','office_mfa_management_version')")).rows[0].c, "0", "functions removed");
  assert.equal((await admin.query("select status from admin_mfa_credentials where id=$1", [bP])).rows[0].status, "revoked", "a pending TOTP next to an active one is revoked so the old single index can be restored (never deleted)"); assert.equal((await admin.query("select status from admin_mfa_credentials where id=$1", [bA])).rows[0].status, "active", "the active one is untouched");
  assert.ok((await admin.query("select indexname from pg_indexes where tablename='admin_mfa_credentials'")).rows.some((x) => x.indexname === "admin_mfa_one_totp_per_user"), "the original index is back"); assert.equal(Number((await admin.query("select count(*) c from admin_mfa_credentials")).rows[0].c), Number(rows0.c) + 2, "no credential row was deleted");
  await admin.query(sql(MGMT)); assert.equal((await admin.query("select office_mfa_management_version() v")).rows[0].v, 1, "re-applied");
  console.log("A5. Rollback: functions dropped, every row kept, an obsolete pending TOTP revoked not deleted, old index restored; re-apply works — PASS");
  await admin.end();
}

async function partB() {
  const pg = `ochiga-s754-sbpg-${SUF}`, pr = `ochiga-s754-rest-${SUF}`; names.push(pg, pr);
  docker("run", "-d", "--rm", "--name", pg, "-e", "POSTGRES_PASSWORD=testpw", "-p", `${SB_PORT}:5432`, IMG_PG);
  let admin = await waitClient(SB_PORT, "postgres", "testpw");
  await admin.end(); const sa = await waitClient(SB_PORT, "supabase_admin", "testpw"); await sa.query("alter role authenticator with password 'testpw'"); await sa.end(); admin = await client(SB_PORT, "postgres", "testpw");
  await admin.query(TABLE); await admin.query("alter table admin_users add column if not exists last_login_at timestamptz, add column if not exists office_position text, add column if not exists phone text, add column if not exists passport_photo_url text, add column if not exists qr_credential text");
  await admin.query("create table if not exists audit_events (id uuid primary key default gen_random_uuid(), actor_user_id uuid references admin_users(id) on delete set null, actor_email text, actor_role text, action text not null, target_type text not null, target_id text, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now())");
  for (const t of ["admin_users", "audit_events"]) await admin.query(`alter table ${t} enable row level security`); await admin.query("revoke all on admin_users, audit_events from anon, authenticated");
  // R3: since S7.5.7 sign-in reads the MFA enforcement setting (fail-closed). Its table is an S3 prerequisite of any real deployment, so the fixture applies it like production does.
  for (const base of ["20261014_office_runtime_settings.sql", "20261019_office_runtime_settings_versioning.sql"]) await admin.query(sql(base));
  await admin.query(sql(MIG)); await admin.query(sql(MFA)); await admin.query(sql(KEYID));
  docker("run", "-d", "--rm", "--name", pr, "-p", `${REST_PORT}:3000`, "-e", `PGRST_DB_URI=postgres://authenticator:testpw@host.docker.internal:${SB_PORT}/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`, "-e", "PGRST_DB_POOL=10", IMG_REST);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${REST_PORT}/`, { headers: { apikey: jwt("service_role") } })).status < 500) break; } catch { /* starting */ } await sleep(1000); }
  await admin.query("notify pgrst, 'reload schema'"); await sleep(2500); let proxy = await startProxy();
  const mkStore = () => new SupabaseLeadAgentsStore({ url: `http://127.0.0.1:${PROXY_PORT}`, serviceRoleKey: jwt("service_role"), requestTimeoutMs: 15000 });
  const sA = mkStore(), sB = mkStore();
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["pg-api-key-0123456789"], allowedOrigins: [], sessionSecret: SESSION, sessionSecretEphemeral: false, mfaMode: "on", mfaKey: K1, mfaKeyId: "k1", mfaKeysPrevious: "", officeEmailProvider: "" };
  const lib = m.createMfaCrypto(config); const A = "/api/lead-agents/admin"; const responses = [];
  const startApp = async (st) => { const rl = (n) => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: n }); const server = buildServer({ config, store: st, rateLimiter: rl(9000), publicRateLimiter: rl(9000), officeRateLimiter: rl(9000), loginRateLimiter: rl(9000), whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] }, openaiClient: {}, toolExecutor: new ToolExecutor({ store: st, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
    const base = `http://127.0.0.1:${await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)))}`; const call = async (method, p, { cookie, body, token } = {}) => { const r = await fetch(`${base}${p}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { "x-step-up-token": token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); responses.push(text); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text, cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
    return { call, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) }; };
  const appA = await startApp(sA), appB = await startApp(sB);
  const mkUser = async (label) => { const id = (await admin.query("insert into admin_users (email, password_hash, role, status, display_name) values ($1,$2,'super_admin','active',$3) returning id", [`${label}@ochiga.test`, hashPassword(`${label} account passphrase number 7`), label])).rows[0].id; return { id, email: `${label}@ochiga.test`, pw: `${label} account passphrase number 7` }; };
  const login = (app, u) => app.call("POST", `${A}/session/login`, { body: { email: u.email, password: u.pw } });
  const stepUp = async (app, cookie, u, mfa) => (await app.call("POST", `${A}/session/step-up`, { cookie, body: { password: u.pw, purpose: "mfa_management", ...(mfa ? { mfa } : {}) } })).json?.step_up?.token;
  const code = (secret, off = 0) => m.hotp(secret, m.totpCounter(Date.now()) + off); const claims = (c) => JSON.parse(Buffer.from(decodeURIComponent(c.split("=")[1]).split(".")[0], "base64url").toString());
  const mf = (app, p, o) => app.call("POST", `${A}/session/mfa${p}`, o);
  const enroll = async (app, u) => { const cookie = (await login(app, u)).cookie; const g = await stepUp(app, cookie, u); const b = await mf(app, "/enroll/totp/begin", { cookie, token: g, body: {} }); const secret = m.base32Decode(b.json.secret_base32); const c = await mf(app, "/enroll/totp/confirm", { cookie, token: g, body: { credential_id: b.json.credential_id, code: code(secret) } }); return { begin: b, confirm: c, secret, cookie: c.cookie, codes: c.json.recovery_codes, credentialId: b.json.credential_id }; };
  try {
    // B1: code deployed BEFORE 20261024
    const early = await mkUser("early"); const eCookie = (await login(appA, early)).cookie; const eGrant = await stepUp(appA, eCookie, early); const eBegin = await mf(appA, "/enroll/totp/begin", { cookie: eCookie, token: eGrant, body: {} }); assert.ok(eBegin.status === 503 && eBegin.json.error === "mfa_unavailable", "before 20261024 the management routes are unavailable (never half-working)"); assert.equal(await sA.supportsMfaManagement(), false);
    const legacyUser = await mkUser("legacy"); const lid = crypto.randomUUID(); const lsec = m.generateTotpSecret(); await sA.createMfaCredential(legacyUser.id, { id: lid, type: "totp", label: "Phone", ...lib.encryptTotpSecret(lsec, { userId: legacyUser.id, credentialId: lid }) }); await sA.activateMfaCredential(legacyUser.id, lid); const lb = lib.newRecoveryBatch(legacyUser.id); await sA.replaceMfaRecoveryCodes(legacyUser.id, crypto.randomUUID(), lb.hmacs, { keyId: lb.key_id });
    const old = await appA.call("POST", `${A}/session/mfa/verify`, { body: { challenge_token: (await login(appA, legacyUser)).json.challenge_token, method: "recovery_code", code: lb.codes[0] } }); assert.ok(old.status === 200 && old.cookie, "the S7.5.3 recovery sign-in still works on the older database (two-step fallback)"); assert.ok(JSON.stringify((await admin.query("select metadata from audit_events where action='sessions_revoked_mfa_recovery_code'")).rows).includes('"atomic":false'), "…and is audited as non-atomic");
    console.log("B1. Code before 20261024: management refuses (503), recovery sign-in keeps working through the audited two-step fallback — PASS");

    await admin.query(sql(MGMT)); await admin.query("notify pgrst, 'reload schema'"); await sleep(2500); sA.mfaManagementCheckedAt = 0; sB.mfaManagementCheckedAt = 0; assert.equal(await sA.supportsMfaManagement(), true);
    // B2: enrollment through the real server and database
    const u1 = await mkUser("boss"); const e1 = await enroll(appA, u1); assert.ok(e1.begin.status === 200 && e1.confirm.status === 200 && e1.codes.length === 10 && e1.confirm.json.session_reissued === true, "begin -> confirm through PostgREST: activated, 10 codes, session re-issued");
    const row = (await admin.query("select status, secret_ciphertext c, totp_last_step s, key_id from admin_mfa_credentials join admin_mfa_recovery_codes using (admin_user_id) where admin_user_id=$1 limit 1", [u1.id])).rows[0]; assert.ok(row.status === "active" && Number(row.s) === m.totpCounter(Date.now()) && row.key_id === "k1" && !row.c.includes(e1.begin.json.secret_base32), "stored active, step recorded atomically, codes keyed, secret only as ciphertext");
    const sc = claims(e1.cookie); assert.ok(sc.mf === 1 && sc.sg === 1, "the re-issued session: mf=1 at the bumped generation"); assert.equal((await appB.call("GET", `${A}/users`, { cookie: e1.cookie })).status, 200, "accepted by a second instance");
    const reuse = await appB.call("POST", `${A}/session/mfa/verify`, { body: { challenge_token: (await login(appB, u1)).json.challenge_token, method: "totp", code: code(e1.secret) } }); assert.equal(reuse.status, 401, "the confirmation code cannot be replayed at sign-in");
    const u2 = await mkUser("race"); const c2 = (await login(appA, u2)).cookie; const g2 = await stepUp(appA, c2, u2); const b2 = await mf(appA, "/enroll/totp/begin", { cookie: c2, token: g2, body: {} }); const s2 = m.base32Decode(b2.json.secret_base32); const cc = code(s2); const raced = await Promise.all(Array.from({ length: 12 }, (_, i) => mf(i % 2 ? appA : appB, "/enroll/totp/confirm", { cookie: c2, token: g2, body: { credential_id: b2.json.credential_id, code: cc } })));
    assert.equal(raced.filter((r) => r.status === 200).length, 1, "12 simultaneous confirmations across two server instances: exactly one activation"); assert.equal(Number((await admin.query("select count(*) c from admin_mfa_credentials where admin_user_id=$1 and status='active'", [u2.id])).rows[0].c), 1); assert.equal(Number((await admin.query("select session_generation g from admin_users where id=$1", [u2.id])).rows[0].g), 1, "one bump");
    console.log("B2. Enrollment through the real server and database: atomic activation, recorded step, keyed codes, one winner across two instances — PASS");

    // B3: replacement, regeneration, removal, last-factor guard
    const g1 = await stepUp(appA, e1.cookie, u1); const rb = await mf(appA, "/enroll/totp/begin", { cookie: e1.cookie, token: g1, body: {} }); assert.equal(rb.json.replaces_credential_id, e1.credentialId); const newSecret = m.base32Decode(rb.json.secret_base32);
    assert.equal(Number((await admin.query("select count(*) c from admin_mfa_credentials where admin_user_id=$1 and status in ('active','pending')", [u1.id])).rows[0].c), 2, "old active and new pending coexist in the database");
    const swap = await mf(appB, "/enroll/totp/confirm", { cookie: e1.cookie, token: g1, body: { credential_id: rb.json.credential_id, code: code(newSecret) } }); assert.ok(swap.status === 200 && swap.json.replaced === true && !("recovery_codes" in swap.json), "replacement through the Data API"); assert.equal((await admin.query("select status, revoked_reason from admin_mfa_credentials where id=$1", [e1.credentialId])).rows[0].revoked_reason, "replaced");
    const g1b = await stepUp(appA, swap.cookie, u1); const regen = await mf(appA, "/recovery-codes/regenerate", { cookie: swap.cookie, token: g1b, body: {} }); assert.ok(regen.status === 200 && regen.json.recovery_codes.length === 10, "regeneration"); assert.equal(Number((await admin.query("select count(*) c from admin_mfa_recovery_codes where admin_user_id=$1 and used_at is null", [u1.id])).rows[0].c), 10, "exactly one unused batch"); assert.equal((await appA.call("POST", `${A}/session/mfa/verify`, { body: { challenge_token: (await login(appA, u1)).json.challenge_token, method: "recovery_code", code: e1.codes[0] } })).status, 401, "the old batch is dead");
    config.mfaRequiredRoles = ["super_admin"]; const g1c = await stepUp(appA, swap.cookie, u1); const guard = await mf(appA, `/credentials/${rb.json.credential_id}/remove`, { cookie: swap.cookie, token: g1c, body: {} }); assert.ok(guard.status === 409 && guard.json.error === "last_factor", "the last-factor guard through the database function"); assert.equal((await admin.query("select status from admin_mfa_credentials where id=$1", [rb.json.credential_id])).rows[0].status, "active", "nothing changed"); config.mfaRequiredRoles = [];
    const rem = await mf(appA, `/credentials/${rb.json.credential_id}/remove`, { cookie: swap.cookie, token: g1c, body: {} }); assert.ok(rem.status === 200 && rem.json.remaining_active === 0 && rem.json.recovery_codes_deleted === 10, "removal: factor revoked and its recovery codes deleted in one transaction"); assert.equal((await login(appA, u1)).json.mfa_required, undefined, "the account signs in password-only again");
    console.log("B3. Replacement, regeneration, removal and the last-factor guard through the real database — PASS");

    // B4: atomic recovery sign-in across two instances
    const u3 = await mkUser("recover"); const e3 = await enroll(appA, u3); const gBefore = Number((await admin.query("select session_generation g from admin_users where id=$1", [u3.id])).rows[0].g);
    const tok = (await login(appA, u3)).json.challenge_token; const wins = await Promise.all(Array.from({ length: 14 }, (_, i) => (i % 2 ? appA : appB).call("POST", `${A}/session/mfa/verify`, { body: { challenge_token: tok, method: "recovery_code", code: e3.codes[0] } }))); assert.equal(wins.filter((r) => r.status === 200).length, 1, "14 simultaneous uses of one recovery code through two server instances: exactly one session");
    assert.equal(Number((await admin.query("select session_generation g from admin_users where id=$1", [u3.id])).rows[0].g), gBefore + 1, "the generation moved exactly once"); const ev = JSON.stringify((await admin.query("select action, metadata from audit_events where target_id=$1", [u3.id])).rows); assert.ok(ev.includes("mfa_recovery_code_used") && ev.includes("\"atomic\":true"), "audited as an atomic consumption");
    await sA.clearMfaFailures(u3.id); // (the burst legitimately locked the account)
    const rcStore = sA.consumeMfaRecoveryCodeRevokingSessions.bind(sA); sA.consumeMfaRecoveryCodeRevokingSessions = async () => { throw Object.assign(new Error("mfa_store_error"), { code: "mfa_store_error" }); }; const unusedBefore = await sA.countMfaRecoveryCodes(u3.id); const inj = await appA.call("POST", `${A}/session/mfa/verify`, { body: { challenge_token: (await login(appA, u3)).json.challenge_token, method: "recovery_code", code: e3.codes[1] } }); sA.consumeMfaRecoveryCodeRevokingSessions = rcStore; assert.ok(inj.status === 503 && !inj.cookie && (await sA.countMfaRecoveryCodes(u3.id)) === unusedBefore, "a failure injected into the atomic step consumes nothing and ends nothing");
    console.log("B4. Atomic recovery sign-in over the real database: one winner across two instances, generation bumped once, injected failure leaves no partial state — PASS");

    // B5: Data API isolation of the new functions, redaction, outage
    const before = async () => (await admin.query("select (select count(*) from admin_mfa_credentials) c, (select count(*) from admin_mfa_recovery_codes) r, (select md5(string_agg(email || session_generation::text, ',' order by email)) from admin_users) u")).rows[0]; const snap = await before();
    for (const role of ["anon", "authenticated"]) for (const [fn, args] of [["office_mfa_management_version", {}], ["office_mfa_activate_credential", { p_user_id: u3.id, p_credential_id: crypto.randomUUID(), p_actor: "pwn" }], ["office_mfa_revoke_credential", { p_user_id: u3.id, p_credential_id: crypto.randomUUID(), p_actor: "pwn" }], ["office_mfa_consume_recovery_code_revoking", { p_user_id: u3.id, p_code_hmac: "x".repeat(20), p_actor: "pwn" }]]) { const r = await rest(role, "POST", `/rpc/${fn}`, args); assert.ok([401, 403, 404].includes(r.status), `${role} ${fn} refused (${r.status})`); }
    assert.deepEqual(await before(), snap, "refused Data API calls changed nothing");
    const audit = JSON.stringify((await admin.query("select action, metadata from audit_events")).rows); const stored = JSON.stringify((await admin.query("select secret_ciphertext, code_hmac from admin_mfa_credentials full join admin_mfa_recovery_codes on false")).rows);
    for (const secret of [K1, SESSION, e1.begin.json.secret_base32, e3.begin.json.secret_base32, ...e1.codes, ...e3.codes.slice(0, 3), ...regen.json.recovery_codes.slice(0, 3)]) assert.ok(!audit.includes(secret) && !stored.includes(secret), "no secret, plain code or key in the audit table or in stored columns");
    const u4 = await mkUser("outage"); const e4 = await enroll(appA, u4); const g4 = await stepUp(appA, e4.cookie, u4); const before4 = await before(); proxy.close(); await sleep(300);
    const down = await mf(appA, "/recovery-codes/regenerate", { cookie: e4.cookie, token: g4, body: {} }); assert.ok(down.status >= 500 && !("recovery_codes" in (down.json || {})) && !/127\.0\.0\.1|ECONN|axios/i.test(down.text), "the database going away mid-management: an error, no codes shown, no detail"); proxy = await startProxy(); await sleep(300); assert.deepEqual(await before(), before4, "nothing changed while it was down"); assert.equal((await mf(appA, "/recovery-codes/regenerate", { cookie: e4.cookie, token: g4, body: {} })).status, 200, "and it works again when the database returns");
    console.log("B5. Data API roles refused for the new functions; nothing secret in audit or storage; a database outage fails closed with no partial change — PASS");
  } finally { await appA.close(); await appB.close(); try { proxy.close(); } catch { /* closed */ } await admin.end().catch(() => {}); }
}

async function main() {
  try { for (const i of [IMG_PLAIN, IMG_PG, IMG_REST]) docker("image", "inspect", i); } catch { console.log("SKIP: Docker or the required images are unavailable"); return; }
  try { await partA(); await partB(); console.log(JSON.stringify({ status: "PASS", suite: "mfa-management-postgres" })); }
  finally { for (const n of names) { try { docker("rm", "-f", n); } catch { /* already gone */ } } }
}
main().catch((e) => { console.error(e); process.exit(1); });
