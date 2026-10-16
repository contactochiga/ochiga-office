// Settings S7.5.1 MFA data foundation against real databases (disposable Docker containers only; never a real project):
//   A. plain Postgres 16: migration order guard, additive + idempotent, constraints, access control matrix, atomic functions under true concurrency, atomicity of failures, rollback
//   B. Supabase Postgres 17 + PostgREST + the real SupabaseLeadAgentsStore: code before migration, capability probe, every store contract through the Data API, credential isolation
//      (anon/authenticated refused at REST and SQL level), concurrency across two clients, database/transport failure handling, rollback under a running store, secret redaction.
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
const MIG = "20261020_admin_session_generation.sql", MFA = "20261022_admin_mfa_foundation.sql", MFA_DOWN = "rollback/20261022_admin_mfa_foundation.down.sql";
const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLAIN_PORT = 54381, SB_PORT = 54382, REST_PORT = 54383, PROXY_PORT = 54384, SUF = process.pid;
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


const randomB64 = (n) => crypto.randomBytes(n).toString("base64");
const H = (tag) => `hmac-${tag}-${crypto.randomBytes(24).toString("base64url")}`;
const totpRow = (c, user, extra = {}) => c.query("insert into admin_mfa_credentials (admin_user_id, type, label, status, secret_ciphertext, secret_nonce, secret_key_id) values ($1,'totp','Phone',$2,'ct-'||gen_random_uuid()::text,'nonce-1','kid-1') returning id", [user, extra.status || "active"]).then((x) => x.rows[0].id);
const privs = async (c, role) => {
  const tables = ["admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_mfa_challenges"]; const out = {};
  for (const t of tables) for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) out[`${t}:${p}`] = (await c.query("select has_table_privilege($1,$2,$3) v", [role, t, p])).rows[0].v;
  return out;
};
const FUNCS = ["office_mfa_schema_version()", "office_mfa_consume_totp_step(uuid,bigint)", "office_mfa_consume_recovery_code(uuid,text)", "office_mfa_replace_recovery_codes(uuid,uuid,text[])", "office_mfa_create_challenge(uuid,text,text,integer)", "office_mfa_consume_challenge(uuid,uuid,text)", "office_mfa_record_failure(uuid)", "office_mfa_clear_failures(uuid)", "office_mfa_reset(uuid,text)", "office_mfa_prune_challenges(interval)"];
const funcPrivs = async (c, role) => Object.fromEntries(await Promise.all(FUNCS.map(async (f) => [f, (await c.query("select has_function_privilege($1,$2,'EXECUTE') v", [role, f])).rows[0].v])));

async function partA() {
  const name = `ochiga-s751-plain-${SUF}`; names.push(name);
  docker("run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=x", "-p", `${PLAIN_PORT}:5432`, IMG_PLAIN);
  const admin = await waitClient(PLAIN_PORT);

  // A0: migration order guard (the MFA file needs the session-generation column, because office_mfa_reset bumps it)
  await admin.query("create database nogen"); const ng = await client(PLAIN_PORT, "postgres", "x", "nogen"); await ng.query(TABLE);
  await assert.rejects(() => ng.query(sql(MFA)), /apply 20261020_admin_session_generation\.sql/, "refuses to apply before the session-generation migration"); await ng.end();
  console.log("A0. Migration order guard: refuses to apply without the session-generation column — PASS");

  // fixtures emulate Supabase's roles so the guarded grant/revoke blocks run
  for (const r of ["anon", "authenticated", "service_role"]) await admin.query(`create role ${r} nologin`);
  await admin.query(TABLE); await admin.query(sql(MIG)); await seed(admin); await admin.query("grant all on admin_users to service_role"); await admin.query("grant select, update on admin_users to anon, authenticated");
  const before = await snapHash(admin);
  const catalog = async () => (await admin.query("select (select count(*) from pg_indexes where tablename like 'admin_mfa%') idx, (select count(*) from pg_constraint where conrelid::regclass::text like 'admin_mfa%') con, (select count(*) from information_schema.columns where table_name = 'admin_users') cols, (select count(*) from pg_proc where proname like 'office_mfa%') fns")).rows[0];

  await admin.query(sql(MFA));
  assert.equal(await snapHash(admin), before, "ids, emails, password hashes, roles, statuses, names and scopes are untouched");
  assert.deepEqual((await admin.query("select mfa_required_after a, mfa_failed_attempts f, mfa_locked_until l, mfa_reset_at r, mfa_reset_by b from admin_users")).rows.map((r) => [r.a, r.f, r.l, r.r, r.b]), [[null, 0, null, null, null], [null, 0, null, null, null], [null, 0, null, null, null]], "existing accounts start with no MFA state and no failures");
  const cat1 = await catalog(); await admin.query(sql(MFA)); await admin.query(sql(MFA)); assert.deepEqual(await catalog(), cat1, "re-applying changes no index, constraint, column or function"); assert.equal(await snapHash(admin), before);
  assert.equal(Number((await admin.query("select count(*) c from admin_mfa_credentials")).rows[0].c), 0, "no credential rows are created by the migration");
  console.log("A1. Migration additive and idempotent: accounts untouched, no MFA state, catalog unchanged on re-apply — PASS");

  const boss = (await admin.query("select id from admin_users where email='boss@ochiga.test'")).rows[0].id, staff = (await admin.query("select id from admin_users where email='staff@ochiga.test'")).rows[0].id;
  // constraints
  const bad = async (q, args, code) => assert.rejects(() => admin.query(q, args), (e) => e.code === code, `${q.slice(0, 70)} -> ${code}`);
  await bad("insert into admin_mfa_credentials (admin_user_id, type, label) values ($1,'totp','x')", [boss], "23514");                                  // totp without secret material
  await bad("insert into admin_mfa_credentials (admin_user_id, type, label, secret_ciphertext, secret_nonce, secret_key_id) values ($1,'sms','x','c','n','k')", [boss], "23514");
  await bad("insert into admin_mfa_credentials (admin_user_id, type, status, secret_ciphertext, secret_nonce, secret_key_id) values ($1,'totp','paused','c','n','k')", [boss], "23514");
  await bad("insert into admin_mfa_credentials (admin_user_id, type) values ($1,'webauthn')", [boss], "23514");
  const t1 = await totpRow(admin, boss, { status: "pending" }); await bad("insert into admin_mfa_credentials (admin_user_id, type, secret_ciphertext, secret_nonce, secret_key_id) values ($1,'totp','c','n','k')", [boss], "23505");   // one pending/active TOTP
  await admin.query("update admin_mfa_credentials set status='revoked' where id=$1", [t1]); await totpRow(admin, boss, { status: "pending" }); // a revoked one frees the slot
  await admin.query("insert into admin_mfa_credentials (admin_user_id, type, webauthn_credential_id, webauthn_public_key) values ($1,'webauthn','\\x0102','\\x0a0b')", [boss]); await bad("insert into admin_mfa_credentials (admin_user_id, type, webauthn_credential_id, webauthn_public_key) values ($1,'webauthn','\\x0102','\\x0a0b')", [staff], "23505");
  await bad("update admin_mfa_credentials set totp_last_step = -1 where admin_user_id = $1 and type='totp'", [boss], "23514"); await bad("update admin_users set mfa_failed_attempts = -1 where id=$1", [boss], "23514");
  const hm = H("u"); await admin.query("insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac) values ($1,gen_random_uuid(),$2)", [boss, hm]); await bad("insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac) values ($1,gen_random_uuid(),$2)", [staff, hm], "23505");
  await bad("insert into admin_mfa_challenges (admin_user_id, purpose, challenge, expires_at) values ($1,'login','\\x01',now())", [boss], "23514");
  await bad("insert into admin_mfa_credentials (admin_user_id, type, secret_ciphertext, secret_nonce, secret_key_id) values (gen_random_uuid(),'totp','c','n','k')", [], "23503");
  const throwaway = (await admin.query("insert into admin_users (email, password_hash) values ('cascade@ochiga.test','salt:x') returning id")).rows[0].id; await totpRow(admin, throwaway); await admin.query("insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac) values ($1,gen_random_uuid(),$2)", [throwaway, H("c")]); await admin.query("delete from admin_users where id=$1", [throwaway]);
  assert.equal(Number((await admin.query("select (select count(*) from admin_mfa_credentials where admin_user_id=$1) + (select count(*) from admin_mfa_recovery_codes where admin_user_id=$1) c", [throwaway])).rows[0].c), 0, "deleting an account deletes its credentials (a recreated account inherits nothing)");
  await admin.query("delete from admin_mfa_credentials"); await admin.query("delete from admin_mfa_recovery_codes");
  console.log("A2. Constraints: material per type, status/type/purpose checks, one TOTP per account, unique credential id and code hash, non-negative counters, FK cascade — PASS");

  // access control matrix
  const rls = (await admin.query("select relname, relrowsecurity from pg_class where relname in ('admin_mfa_credentials','admin_mfa_recovery_codes','admin_mfa_challenges') order by relname")).rows;
  assert.deepEqual(rls.map((r) => r.relrowsecurity), [true, true, true], "RLS is on for every MFA table"); assert.equal(Number((await admin.query("select count(*) c from pg_policies where tablename like 'admin_mfa%'")).rows[0].c), 0, "and there are no policies at all");
  for (const role of ["public", "anon", "authenticated"]) { if (role === "public") continue; assert.ok(Object.values(await privs(admin, role)).every((v) => v === false), `${role} holds no privilege on any MFA table`); assert.ok(Object.values(await funcPrivs(admin, role)).every((v) => v === false), `${role} cannot execute any MFA function`); }
  assert.deepEqual(await privs(admin, "service_role"), { "admin_mfa_credentials:SELECT": true, "admin_mfa_credentials:INSERT": true, "admin_mfa_credentials:UPDATE": true, "admin_mfa_credentials:DELETE": false, "admin_mfa_recovery_codes:SELECT": true, "admin_mfa_recovery_codes:INSERT": true, "admin_mfa_recovery_codes:UPDATE": true, "admin_mfa_recovery_codes:DELETE": true, "admin_mfa_challenges:SELECT": true, "admin_mfa_challenges:INSERT": true, "admin_mfa_challenges:UPDATE": true, "admin_mfa_challenges:DELETE": true }, "service_role: exactly the privileges the contract lists");
  assert.ok(Object.values(await funcPrivs(admin, "service_role")).every(Boolean), "service_role executes every function");
  assert.ok((await admin.query("select count(*) c from information_schema.routine_privileges where routine_name like 'office_mfa%' and grantee = 'PUBLIC'")).rows[0].c == 0, "nothing is granted to PUBLIC");
  for (const role of ["anon", "authenticated"]) {
    const c = await client(PLAIN_PORT); await c.query(`set role ${role}`);
    for (const q of ["select * from admin_mfa_credentials", "insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac) values (gen_random_uuid(), gen_random_uuid(), 'x')", "update admin_mfa_challenges set consumed_at = now()", "delete from admin_mfa_recovery_codes", "select office_mfa_consume_totp_step(gen_random_uuid(), 1)", "select * from office_mfa_record_failure(gen_random_uuid())", "select * from office_mfa_reset(gen_random_uuid(), 'x')"]) await assert.rejects(() => c.query(q), (e) => e.code === "42501", `${role}: ${q.slice(0, 50)} refused`);
    await c.end();
  }
  const sr = await client(PLAIN_PORT); await sr.query("set role service_role"); assert.equal((await sr.query("select office_mfa_schema_version() v")).rows[0].v, 1, "service_role can call the probe"); await sr.query("select * from admin_mfa_credentials"); await assert.rejects(() => sr.query("delete from admin_mfa_credentials"), (e) => e.code === "42501", "…but not delete credentials directly"); await sr.end();
  console.log("A3. Access control: RLS everywhere with no policies, anon/authenticated/PUBLIC hold nothing, service_role exactly as contracted, SQL-level refusals — PASS");

  // functions + concurrency over 10 real connections
  const conns = await Promise.all(Array.from({ length: 10 }, () => client(PLAIN_PORT)));
  // n operations spread over 10 real connections: each connection runs its share one after another, the 10 lanes run truly in parallel
  const par = async (n, fn) => (await Promise.all(Array.from({ length: 10 }, async (_, lane) => { const out = []; for (let i = lane; i < n; i += 10) out.push([i, await fn(conns[lane], i)]); return out; }))).flat().sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const one = async (q, args, c = admin) => (await c.query(q, args)).rows;
  const cred = await totpRow(admin, boss); const credPending = await totpRow(admin, staff, { status: "pending" });
  assert.equal((await one("select office_mfa_consume_totp_step($1,$2) v", [credPending, 5]))[0].v, false, "a pending credential cannot consume a step"); assert.equal((await one("select office_mfa_consume_totp_step(gen_random_uuid(), 5) v"))[0].v, false);
  const same = await par(50, (c) => c.query("select office_mfa_consume_totp_step($1,100) v", [cred]).then((r) => r.rows[0].v)); assert.equal(same.filter(Boolean).length, 1, "50 attempts at one step over 10 parallel connections: exactly one winner");
  assert.equal((await one("select office_mfa_consume_totp_step($1,100) v", [cred]))[0].v, false, "replay refused"); assert.equal((await one("select office_mfa_consume_totp_step($1,99) v", [cred]))[0].v, false, "older step refused");
  const steps = Array.from({ length: 60 }, (_, i) => 200 + i).sort(() => Math.random() - 0.5); const acc = []; await par(60, async (c, i) => { if ((await c.query("select office_mfa_consume_totp_step($1,$2) v", [cred, steps[i]])).rows[0].v) acc.push(steps[i]); });
  assert.ok(new Set(acc).size === acc.length && acc.length >= 1, "no step accepted twice under random order"); assert.equal(Number((await one("select totp_last_step s from admin_mfa_credentials where id=$1", [cred]))[0].s), 259, "the stored step ends at the maximum (monotonic)");
  await admin.query("update admin_mfa_credentials set status='revoked' where id=$1", [cred]); assert.equal((await one("select office_mfa_consume_totp_step($1,9999) v", [cred]))[0].v, false, "a revoked credential cannot be used");
  console.log("A4. TOTP replay protection: one winner under 50-way contention, monotonic under random order, revoked/pending refused — PASS");

  const codes = Array.from({ length: 10 }, (_, i) => H(i)); assert.equal((await one("select office_mfa_replace_recovery_codes($1,gen_random_uuid(),$2::text[]) n", [boss, codes]))[0].n, 10);
  assert.equal((await one("select office_mfa_consume_recovery_code($1,$2) v", [staff, codes[0]]))[0].v, false, "another account cannot use the code");
  const cw = await par(50, (c) => c.query("select office_mfa_consume_recovery_code($1,$2) v", [boss, codes[0]]).then((r) => r.rows[0].v)); assert.equal(cw.filter(Boolean).length, 1, "50 attempts at one recovery code over 10 parallel connections: exactly one winner");
  const cw2 = await par(30, (c, i) => c.query("select office_mfa_consume_recovery_code($1,$2) v", [boss, codes[1 + (i % 9)]]).then((r) => r.rows[0].v)); assert.equal(cw2.filter(Boolean).length, 9, "each of the other 9 codes is consumed exactly once");
  const raced = await par(10, (c, i) => c.query("select office_mfa_replace_recovery_codes($1,gen_random_uuid(),$2::text[]) n", [boss, Array.from({ length: 4 }, (_, j) => H(`r${i}-${j}`))]).then((r) => r.rows[0].n)); assert.ok(raced.every((n) => n === 4));
  assert.equal(Number((await one("select count(*) c from admin_mfa_recovery_codes where admin_user_id=$1 and used_at is null", [boss]))[0].c), 4, "10 racing replacements leave exactly one unused batch of 4"); assert.equal(Number((await one("select count(*) c from admin_mfa_recovery_codes where admin_user_id=$1 and used_at is not null", [boss]))[0].c), 10, "used codes stay as history");
  const keepBatch = (await one("select code_hmac h from admin_mfa_recovery_codes where admin_user_id=$1 and used_at is null order by code_hmac", [boss])).map((r) => r.h);
  const dupH = H("dup"); await assert.rejects(() => admin.query("select office_mfa_replace_recovery_codes($1,gen_random_uuid(),$2::text[])", [boss, [dupH, H("ok2"), dupH]]), (e) => e.code === "23505");
  assert.deepEqual((await one("select code_hmac h from admin_mfa_recovery_codes where admin_user_id=$1 and used_at is null order by code_hmac", [boss])).map((r) => r.h), keepBatch, "a failing replacement (duplicate in the batch) rolls back COMPLETELY: the old unused codes are still there");
  console.log("A5. Recovery codes: single use under 50-way contention, per-account scope, atomic replacement under racing writers and under failure — PASS");

  const ch = (await one("select * from office_mfa_create_challenge($1,'webauthn_authenticate',$2,60)", [boss, randomB64(32)]))[0]; assert.ok(ch.id && Date.parse(ch.expires_at) > Date.now());
  assert.equal((await one("select office_mfa_consume_challenge($1,$2,'webauthn_authenticate') v", [ch.id, staff]))[0].v, null, "another account refused"); assert.equal((await one("select office_mfa_consume_challenge($1,$2,'webauthn_register') v", [ch.id, boss]))[0].v, null, "another purpose refused");
  const chb64 = randomB64(32); const ch2 = (await one("select * from office_mfa_create_challenge($1,'webauthn_register',$2,60)", [boss, chb64]))[0]; const cc = await par(50, (c) => c.query("select office_mfa_consume_challenge($1,$2,'webauthn_register') v", [ch2.id, boss]).then((r) => r.rows[0].v)); assert.equal(cc.filter((v) => v === chb64).length, 1, "50 attempts over 10 parallel connections: exactly one returns the exact challenge bytes"); assert.equal(cc.filter((v) => v === null).length, 49);
  const exp = (await one("select * from office_mfa_create_challenge($1,'webauthn_register',$2,1)", [boss, chb64]))[0]; await sleep(1300); assert.equal((await one("select office_mfa_consume_challenge($1,$2,'webauthn_register') v", [exp.id, boss]))[0].v, null, "an expired challenge is refused");
  const clamp = (await one("select extract(epoch from (expires_at - now())) s from office_mfa_create_challenge($1,'webauthn_register',$2,999999)", [boss, chb64]))[0].s; assert.ok(Number(clamp) <= 900 && Number(clamp) > 880, "ttl is clamped to 15 minutes");
  assert.ok((await one("select office_mfa_prune_challenges(interval '0 seconds') n"))[0].n >= 2, "prune removes consumed and expired challenges");
  console.log("A6. Challenges: single use under 50-way contention, account- and purpose-bound, expiry and ttl clamp, prune — PASS");

  assert.deepEqual(await one("select * from office_mfa_record_failure(gen_random_uuid())"), [], "unknown account: no rows");
  for (let i = 1; i <= 4; i += 1) { const r = (await one("select * from office_mfa_record_failure($1)", [staff]))[0]; assert.ok(r.failed_attempts === i && r.locked_until === null, "below 5: no lock"); }
  const lockIn = async (id, target) => Math.round((Date.parse((await one("select mfa_locked_until l from admin_users where id=$1", [id]))[0].l) - Date.now()) / 1000);
  await one("select * from office_mfa_record_failure($1)", [staff]); assert.ok(Math.abs((await lockIn(staff)) - 60) < 5, "5 failures: 1-minute lock");
  for (let i = 6; i <= 10; i += 1) await one("select * from office_mfa_record_failure($1)", [staff]); assert.ok(Math.abs((await lockIn(staff)) - 900) < 5, "10 failures: 15-minute lock");
  for (let i = 11; i <= 20; i += 1) await one("select * from office_mfa_record_failure($1)", [staff]); assert.ok(Math.abs((await lockIn(staff)) - 3600) < 5, "20 failures: 60-minute lock"); const l20 = await lockIn(staff); await one("select * from office_mfa_record_failure($1)", [staff]); assert.ok((await lockIn(staff)) >= l20 - 2, "a lock is never shortened");
  await one("select office_mfa_clear_failures($1)", [staff]); assert.deepEqual((await one("select mfa_failed_attempts f, mfa_locked_until l from admin_users where id=$1", [staff]))[0], { f: 0, l: null }, "clear resets counter and lock");
  const fr = await par(60, (c) => c.query("select * from office_mfa_record_failure($1)", [boss]).then((r) => r.rows[0].failed_attempts)); assert.equal(new Set(fr).size, 60, "60 failures over 10 parallel connections: 60 distinct counts (no lost update)"); assert.equal((await one("select mfa_failed_attempts f from admin_users where id=$1", [boss]))[0].f, 60); assert.ok(Math.abs((await lockIn(boss)) - 3600) < 5);
  assert.equal((await one("select mfa_failed_attempts f from admin_users where id=$1", [staff]))[0].f, 0, "counters are per account");
  console.log("A7. Failure counting: atomic under 60-way contention, progressive time-limited locks (1/15/60 min), never shortened, per account — PASS");

  // reset
  const rc1 = await totpRow(admin, boss); await one("select office_mfa_replace_recovery_codes($1,gen_random_uuid(),$2::text[]) n", [boss, [H("z1"), H("z2")]]);
  const g0 = (await one("select session_generation g from admin_users where id=$1", [boss]))[0].g; const rr = (await one("select * from office_mfa_reset($1,'admin@x')", [boss]))[0];
  assert.deepEqual([rr.session_generation, rr.credentials_revoked, rr.codes_deleted], [g0 + 1, 1, 2], "reset: generation bumped, credential revoked, unused codes deleted"); const st = (await one("select mfa_reset_by r, sessions_revoked_by s, mfa_failed_attempts f, mfa_locked_until l from admin_users where id=$1", [boss]))[0]; assert.deepEqual(st, { r: "admin@x", s: "admin@x", f: 0, l: null });
  assert.equal((await one("select status from admin_mfa_credentials where id=$1", [rc1]))[0].status, "revoked"); assert.deepEqual(await one("select * from office_mfa_reset(gen_random_uuid(),'x')"), [], "unknown account: no rows, nothing changed");
  console.log("A8. Reset: one transaction revokes credentials, deletes unused codes, clears failures, stamps and bumps the generation — PASS");
  await Promise.all(conns.map((c) => c.end()));

  // rollback is non-destructive
  const rowsBefore = (await one("select (select count(*) from admin_mfa_credentials) c, (select count(*) from admin_mfa_recovery_codes) r, (select md5(string_agg(id::text || status, ',' order by id)) from admin_mfa_credentials) m"))[0];
  await admin.query(sql(MFA_DOWN)); assert.equal(Number((await one("select count(*) c from pg_proc where proname like 'office_mfa%'"))[0].c), 0, "every function removed");
  assert.deepEqual((await one("select (select count(*) from admin_mfa_credentials) c, (select count(*) from admin_mfa_recovery_codes) r, (select md5(string_agg(id::text || status, ',' order by id)) from admin_mfa_credentials) m"))[0], rowsBefore, "every credential and code row is kept by the rollback");
  assert.equal((await one("select mfa_failed_attempts f from admin_users where id=$1", [boss]))[0].f, 0); assert.equal(await snapHash(admin), before, "accounts untouched by the rollback");
  await admin.query(sql(MFA)); assert.deepEqual((await one("select (select count(*) from admin_mfa_credentials) c, (select count(*) from admin_mfa_recovery_codes) r"))[0], { c: rowsBefore.c, r: rowsBefore.r }, "re-applying after a rollback keeps all data"); assert.equal((await one("select office_mfa_schema_version() v"))[0].v, 1);
  console.log("A9. Rollback drops only functions; credentials, codes and accounts are kept; re-apply restores service — PASS");
  await admin.end();
}

async function partB() {
  const pg = `ochiga-s751-sbpg-${SUF}`, pr = `ochiga-s751-rest-${SUF}`; names.push(pg, pr);
  docker("run", "-d", "--rm", "--name", pg, "-e", "POSTGRES_PASSWORD=testpw", "-p", `${SB_PORT}:5432`, IMG_PG);
  let admin = await waitClient(SB_PORT, "postgres", "testpw");
  await admin.end(); const sa = await waitClient(SB_PORT, "supabase_admin", "testpw"); await sa.query("alter role authenticator with password 'testpw'"); await sa.end(); admin = await client(SB_PORT, "postgres", "testpw");
  await admin.query(TABLE); await admin.query("alter table admin_users enable row level security"); await admin.query("revoke all on admin_users from anon, authenticated"); await seed(admin); await admin.query(sql(MIG));
  docker("run", "-d", "--rm", "--name", pr, "-p", `${REST_PORT}:3000`, "-e", `PGRST_DB_URI=postgres://authenticator:testpw@host.docker.internal:${SB_PORT}/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`, "-e", "PGRST_DB_POOL=10", IMG_REST);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${REST_PORT}/`, { headers: { apikey: jwt("service_role") } })).status < 500) break; } catch { /* starting */ } await sleep(1000); }
  await admin.query("notify pgrst, 'reload schema'"); await sleep(1500);
  let proxy = await startProxy();
  const mkStore = (url = `http://127.0.0.1:${PROXY_PORT}`, timeout = 15000) => new SupabaseLeadAgentsStore({ url, serviceRoleKey: jwt("service_role"), requestTimeoutMs: timeout });
  const s1 = mkStore(), s2 = mkStore();
  const boss = (await admin.query("select id from admin_users where email='boss@ochiga.test'")).rows[0].id, staff = (await admin.query("select id from admin_users where email='staff@ochiga.test'")).rows[0].id;
  const secretShape = (e, ...needles) => { const dump = JSON.stringify(Object.getOwnPropertyNames(e).map((k) => String(e[k]))) + String(e.stack); return needles.every((n) => !dump.includes(n)); };
  try {
    // B1: code deployed before the MFA migration
    assert.equal(await s1.supportsMfa(), false, "capability unavailable before the migration");
    for (const [label, fn] of [["create", () => s1.createMfaCredential(boss, { type: "totp", secret_ciphertext: "c", secret_nonce: "n", secret_key_id: "k" })], ["consumeTotp", () => s1.consumeTotpStep(boss, crypto.randomUUID(), 5)], ["recovery", () => s1.consumeMfaRecoveryCode(boss, H("x"))], ["challenge", () => s1.createMfaChallenge(boss, "webauthn_register", randomB64(32), 60)], ["failure", () => s1.recordMfaFailure(boss)], ["lock", () => s1.getMfaLockState(boss)]]) await assert.rejects(fn, (e) => e.code === "mfa_unavailable", `${label} refuses loudly (never a silent success)`);
    console.log("B1. Code before migration: capability unavailable, every operation refuses with mfa_unavailable — PASS");

    // B2: apply under a running store
    await admin.query(sql(MFA)); await admin.query("notify pgrst, 'reload schema'"); await sleep(2500); s1.mfaSchemaCheckedAt = 0; s2.mfaSchemaCheckedAt = 0;
    assert.equal(await s1.supportsMfa(), true, "re-probe finds the schema");
    const CT = "CIPHERTEXT-SENTINEL-" + randomB64(18), NONCE = "NONCE-SENTINEL-" + randomB64(6);
    const cred = await s1.createMfaCredential(boss, { type: "totp", label: "Phone", secret_ciphertext: CT, secret_nonce: NONCE, secret_key_id: "kid-1" });
    assert.ok(cred.status === "pending" && !JSON.stringify(cred).includes("SENTINEL"), "created pending; response sanitised");
    await assert.rejects(() => s2.createMfaCredential(boss, { type: "totp", label: "Dup", secret_ciphertext: CT, secret_nonce: NONCE, secret_key_id: "kid-1" }), (e) => e.code === "mfa_conflict" && secretShape(e, "SENTINEL", "23505", "duplicate key"), "a second TOTP conflicts, and the error carries no body");
    assert.equal(await s1.consumeTotpStep(boss, cred.id, 7), false, "pending credentials cannot be used"); assert.equal(await s1.activateMfaCredential(staff, cred.id), null, "another account cannot activate"); assert.equal((await s1.activateMfaCredential(boss, cred.id)).status, "active"); assert.equal(await s2.activateMfaCredential(boss, cred.id), null, "activation is single-shot");
    const list = await s2.listMfaCredentials(boss); assert.equal(list.length, 1); assert.ok(!JSON.stringify(list).match(/SENTINEL|secret_|ciphertext|nonce/), "listing never selects secret columns"); assert.equal((await s2.listMfaCredentials(staff)).length, 0);
    const sec = await s2.getMfaCredentialSecret(boss, cred.id); assert.ok(sec.secret_ciphertext === CT && sec.secret_nonce === NONCE, "the dedicated reader returns the secret columns"); assert.equal(await s2.getMfaCredentialSecret(staff, cred.id), null);
    const wa = { type: "webauthn", label: "Key", webauthn_credential_id: randomB64(32), webauthn_public_key: randomB64(77), webauthn_sign_count: 0, webauthn_transports: ["usb", "nfc"], webauthn_backup_eligible: true };
    const wcred = await s1.createMfaCredential(boss, wa); assert.ok(wcred.type === "webauthn" && JSON.stringify(wcred).includes("nfc") && !JSON.stringify(wcred).includes(wa.webauthn_public_key)); const stored = (await admin.query("select replace(encode(webauthn_credential_id,'base64'), E'\\n', '') c, replace(encode(webauthn_public_key,'base64'), E'\\n', '') k from admin_mfa_credentials where id=$1", [wcred.id])).rows[0]; assert.deepEqual([stored.c, stored.k], [wa.webauthn_credential_id, wa.webauthn_public_key], "bytea round-trips exactly through PostgREST");
    await assert.rejects(() => s1.createMfaCredential(staff, wa), (e) => e.code === "mfa_conflict", "a credential id is unique across accounts"); assert.equal((await s1.revokeMfaCredential(boss, wcred.id, { actor: "t", reason: "lost" })).status, "revoked"); assert.equal(await s1.revokeMfaCredential(boss, wcred.id, {}), null);
    // TOTP replay across two clients
    const same = await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? s1 : s2).consumeTotpStep(boss, cred.id, 500))); assert.equal(same.filter(Boolean).length, 1, "24 simultaneous uses of one step through PostgREST and two clients: exactly one winner");
    assert.equal(await s1.consumeTotpStep(staff, cred.id, 900), false, "another account cannot consume the step"); assert.equal(await s1.consumeTotpStep(boss, cred.id, 500), false, "replay refused");
    const shuffled = Array.from({ length: 30 }, (_, i) => 600 + i).sort(() => Math.random() - 0.5); const acc = []; await Promise.all(shuffled.map(async (s, i) => { if (await (i % 2 ? s1 : s2).consumeTotpStep(boss, cred.id, s)) acc.push(s); })); assert.ok(new Set(acc).size === acc.length); assert.equal((await s1.getMfaCredentialSecret(boss, cred.id)).totp_last_step, 629, "monotonic through the Data API");
    // recovery codes
    const codes = Array.from({ length: 10 }, (_, i) => H(i)); assert.equal(await s1.replaceMfaRecoveryCodes(boss, crypto.randomUUID(), codes), 10); assert.equal(await s2.countMfaRecoveryCodes(boss), 10, "count via content-range");
    const rw = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? s1 : s2).consumeMfaRecoveryCode(boss, codes[0]))); assert.equal(rw.filter(Boolean).length, 1, "20 simultaneous uses of one code: exactly one winner"); assert.equal(await s1.consumeMfaRecoveryCode(staff, codes[1]), false, "another account cannot use it"); assert.equal(await s1.countMfaRecoveryCodes(boss), 9);
    const rr = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? s1 : s2).replaceMfaRecoveryCodes(boss, crypto.randomUUID(), Array.from({ length: 3 }, (_, j) => H(`r${i}-${j}`))))); assert.ok(rr.every((n) => n === 3)); assert.equal(await s1.countMfaRecoveryCodes(boss), 3, "racing replacements leave one batch");
    const dupVal = H("dup"); await assert.rejects(() => s1.replaceMfaRecoveryCodes(boss, crypto.randomUUID(), [dupVal, dupVal]), (e) => e.code === "mfa_conflict"); await assert.rejects(() => s1.replaceMfaRecoveryCodes(boss, crypto.randomUUID(), ["short"]), (e) => e.code === "mfa_invalid_input");
    // challenges: base64 through bytea and back
    const CH = randomB64(32); const ch = await s1.createMfaChallenge(boss, "webauthn_authenticate", CH, 60); assert.ok(ch.id && Date.parse(ch.expires_at) > Date.now());
    assert.equal(await s1.consumeMfaChallenge(staff, ch.id, "webauthn_authenticate"), null); assert.equal(await s1.consumeMfaChallenge(boss, ch.id, "webauthn_register"), null);
    const cw = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? s1 : s2).consumeMfaChallenge(boss, ch.id, "webauthn_authenticate"))); assert.equal(cw.filter((v) => v === CH).length, 1, "20 simultaneous consumes: exactly one returns the exact challenge"); assert.equal(cw.filter((v) => v === null).length, 19);
    const LONG = randomB64(200); const lc = await s1.createMfaChallenge(boss, "webauthn_register", LONG, 60); assert.equal(await s2.consumeMfaChallenge(boss, lc.id, "webauthn_register"), LONG, "a 200-byte challenge round-trips exactly (no base64 line wrapping)");
    const short = await s1.createMfaChallenge(boss, "webauthn_register", CH, 1); await sleep(1300); assert.equal(await s1.consumeMfaChallenge(boss, short.id, "webauthn_register"), null, "expired refused"); assert.ok((await s1.pruneMfaChallenges(0)) >= 2);
    // failures
    assert.equal(await s1.recordMfaFailure(crypto.randomUUID()), null); const fr = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? s1 : s2).recordMfaFailure(staff))); assert.equal(new Set(fr.map((r) => r.failed_attempts)).size, 40, "40 simultaneous failures: 40 distinct counts"); const ls = await s2.getMfaLockState(staff); assert.ok(ls.failed_attempts === 40 && Date.parse(ls.locked_until) > Date.now() + 3_000_000, "lock state read back through the Data API"); await s1.clearMfaFailures(staff); assert.deepEqual(await s1.getMfaLockState(staff), { failed_attempts: 0, locked_until: null });
    // reset
    const g0 = (await s1.getAdminUserById(boss)).session_generation; const reset = await s1.resetMfa(boss, { actor: "admin@x" }); assert.deepEqual([reset.session_generation, reset.credentials_revoked, reset.codes_deleted], [g0 + 1, 1, 3]); assert.equal((await s1.listMfaCredentials(boss)).filter((c) => c.status !== "revoked").length, 0); assert.equal(await s1.resetMfa(crypto.randomUUID(), {}), null);
    console.log("B2. Every store contract through PostgREST: lifecycle, bytea round-trip, 24-way TOTP replay, 20-way single-use codes and challenges, 40-way failure counting, atomic reset, sanitised listings — PASS");

    // B3: credential isolation at the Data API and SQL level
    const snap = async () => (await admin.query("select (select count(*) from admin_mfa_credentials) c, (select count(*) from admin_mfa_recovery_codes) r, (select count(*) from admin_mfa_challenges) h, (select md5(string_agg(email || session_generation::text || mfa_failed_attempts::text, ',' order by email)) from admin_users) u")).rows[0];
    const before = await snap();
    for (const role of ["anon", "authenticated"]) {
      for (const [m, p, b] of [["GET", "/admin_mfa_credentials?select=*", undefined], ["GET", "/admin_mfa_recovery_codes?select=*", undefined], ["GET", "/admin_mfa_challenges?select=*", undefined], ["POST", "/admin_mfa_credentials", { admin_user_id: boss, type: "totp", secret_ciphertext: "c", secret_nonce: "n", secret_key_id: "k" }], ["PATCH", "/admin_mfa_recovery_codes?used_at=is.null", { used_at: "2026-01-01T00:00:00Z" }], ["DELETE", "/admin_mfa_credentials?status=eq.active", undefined], ["GET", "/admin_users?select=mfa_failed_attempts,mfa_locked_until", undefined], ["PATCH", `/admin_users?id=eq.${boss}`, { mfa_failed_attempts: 0 }],
        ["POST", "/rpc/office_mfa_schema_version", {}], ["POST", "/rpc/office_mfa_consume_totp_step", { p_credential_id: cred.id, p_step: 99999 }], ["POST", "/rpc/office_mfa_consume_recovery_code", { p_user_id: boss, p_code_hmac: codes[2] }], ["POST", "/rpc/office_mfa_replace_recovery_codes", { p_user_id: boss, p_batch_id: crypto.randomUUID(), p_hmacs: [H("pwn")] }], ["POST", "/rpc/office_mfa_record_failure", { p_user_id: boss }], ["POST", "/rpc/office_mfa_clear_failures", { p_user_id: boss }], ["POST", "/rpc/office_mfa_reset", { p_user_id: boss, p_actor: "pwn" }], ["POST", "/rpc/office_mfa_create_challenge", { p_user_id: boss, p_purpose: "webauthn_register", p_challenge_b64: randomB64(32), p_ttl_seconds: 60 }]]) {
        const r = await rest(role, m, p, b); assert.ok([401, 403, 404].includes(r.status), `${role} ${m} ${p.slice(0, 50)} refused (got ${r.status})`); assert.ok(!r.text.includes("SENTINEL") && !r.text.includes("hmac-"), `${role} reads nothing`);
      }
      const c = await client(SB_PORT, "postgres", "testpw"); await c.query(`set role ${role}`); for (const t of ["admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_mfa_challenges"]) await assert.rejects(() => c.query(`select * from ${t}`), (e) => e.code === "42501", `${role} cannot read ${t}`); await assert.rejects(() => c.query("select office_mfa_reset(gen_random_uuid(),'x')"), (e) => e.code === "42501"); await assert.rejects(() => c.query("select mfa_failed_attempts from admin_users"), (e) => e.code === "42501", `${role} cannot read the new admin_users MFA columns`); await c.end();
    }
    assert.deepEqual(await snap(), before, "every refused Data API call changed nothing");
    const sp = await Promise.all(["admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_mfa_challenges"].flatMap((t) => ["anon", "authenticated"].flatMap((r) => ["SELECT", "INSERT", "UPDATE", "DELETE"].map(async (p) => (await admin.query("select has_table_privilege($1,$2,$3) v", [r, t, p])).rows[0].v)))); assert.ok(sp.every((v) => v === false), "anon/authenticated hold no privilege on the MFA tables");
    assert.equal(Number((await admin.query("select count(*) c from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity")).rows[0].c), 0, "no public table without RLS"); assert.equal(Number((await admin.query("select count(*) c from pg_policies where tablename like 'admin_mfa%'")).rows[0].c), 0, "no policies");
    // isolation between accounts through the store
    assert.equal((await s1.listMfaCredentials(staff)).length, 0); assert.equal(await s1.consumeMfaChallenge(staff, ch.id, "webauthn_authenticate"), null); assert.equal(await s1.getMfaCredentialSecret(staff, cred.id), null);
    console.log("B3. Isolation: anon/authenticated refused for every table, function and new column at REST and SQL level; refused calls change nothing; accounts cannot touch each other's credentials — PASS");

    // B4: failures of the database and the transport fail closed
    const probe = mkStore(); await probe.supportsMfa(); proxy.close(); await sleep(200);
    for (const [label, fn] of [["consume", () => s1.consumeTotpStep(boss, cred.id, 77777)], ["recovery", () => s1.consumeMfaRecoveryCode(boss, codes[3])], ["challenge", () => s1.consumeMfaChallenge(boss, ch.id, "webauthn_authenticate")], ["failure", () => s1.recordMfaFailure(boss)], ["create", () => s1.createMfaCredential(boss, { type: "totp", secret_ciphertext: CT, secret_nonce: NONCE, secret_key_id: "k" })], ["replace", () => s1.replaceMfaRecoveryCodes(boss, crypto.randomUUID(), [H("q1")])]]) await assert.rejects(label === "x" ? null : fn, (e) => e.code === "mfa_store_unreachable" && secretShape(e, CT, NONCE, "127.0.0.1", "ECONNREFUSED"), `${label}: transport down throws a code-only error (never a success)`);
    proxy = await startProxy(); await sleep(200); assert.equal((await s1.listMfaCredentials(boss)).length, 2, "and recovers when the transport returns"); const counter = async () => Number((await admin.query("select totp_last_step s from admin_mfa_credentials where id=$1", [cred.id])).rows[0].s); assert.equal(await counter(), 629, "with the replay counter untouched by the failed calls");
    // malformed / hostile responses from a fake endpoint
    let mode = "ok"; const fake = http.createServer((req, res) => { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { const url = req.url; if (mode === "slow") return; res.setHeader("content-type", "application/json"); if (url.includes("office_mfa_schema_version")) return res.end("1"); if (mode === "html") { res.setHeader("content-type", "text/html"); return res.end("<html>oops</html>"); } if (mode === "500") { res.statusCode = 500; return res.end(JSON.stringify({ message: "boom " + body, code: "XX000" })); } if (mode === "truthy") return res.end(JSON.stringify("yes")); if (mode === "empty") return res.end("[]"); if (mode === "badrow") return res.end(JSON.stringify([{ failed_attempts: "many" }])); res.end("true"); }); });
    await new Promise((r) => fake.listen(54385, "127.0.0.1", r)); const fs1 = mkStore("http://127.0.0.1:54385", 800); await fs1.supportsMfa();
    mode = "truthy"; await assert.rejects(() => fs1.consumeTotpStep(boss, cred.id, 5), (e) => e.code === "mfa_store_error" || e.code === "mfa_store_unreachable"); await assert.rejects(() => fs1.consumeMfaRecoveryCode(boss, codes[3]), (e) => e.code === "mfa_store_error", "a non-boolean 'success' is NOT treated as success");
    mode = "html"; await assert.rejects(() => fs1.consumeMfaRecoveryCode(boss, codes[3]), (e) => e.code === "mfa_store_error", "an HTML error page is not a success"); mode = "badrow"; await assert.rejects(() => fs1.recordMfaFailure(boss), (e) => e.code === "mfa_store_error", "a malformed failure row is rejected"); mode = "empty"; assert.equal(await fs1.recordMfaFailure(boss), null);
    mode = "500"; await assert.rejects(() => fs1.createMfaChallenge(boss, "webauthn_register", CH, 60), (e) => e.code === "mfa_store_error" && e.status === 500 && secretShape(e, CH, "boom"), "a 500 becomes a code-only error: the response body (which echoes the request) is dropped");
    mode = "slow"; const t0 = Date.now(); await assert.rejects(() => fs1.consumeMfaRecoveryCode(boss, codes[3]), (e) => e.code === "mfa_store_unreachable"); assert.ok(Date.now() - t0 < 5000, "a hung endpoint times out and fails closed"); fake.close();
    const live = await admin.query("select office_mfa_schema_version() v"); assert.equal(live.rows[0].v, 1);
    console.log("B4. Database/transport failures fail closed: down, hung, 500, HTML, non-boolean and malformed responses never read as success and never leak request bodies — PASS");

    // B5: rollback under a running store, then re-apply
    const dataBefore = await snap(); await admin.query(sql(MFA_DOWN)); await admin.query("notify pgrst, 'reload schema'"); await sleep(2500);
    const s3 = mkStore(); assert.equal(await s3.supportsMfa(), false, "after the rollback the capability is gone"); await assert.rejects(() => s3.consumeMfaRecoveryCode(boss, codes[3]), (e) => e.code === "mfa_unavailable"); assert.deepEqual(await snap(), dataBefore, "rows untouched by the rollback");
    await admin.query(sql(MFA)); await admin.query("notify pgrst, 'reload schema'"); await sleep(2500); const s4 = mkStore(); assert.equal(await s4.supportsMfa(), true, "re-applied"); assert.equal(await counter(), 629, "old state intact: the replay counter survived the rollback and re-apply"); assert.equal(await s4.consumeTotpStep(boss, cred.id, 629), false, "replay still refused (and the credential was revoked by the earlier reset)");
    console.log("B5. Rollback under a running store: capability disappears and operations refuse; all rows and the replay counter survive; re-apply restores service — PASS");
  } finally { proxy.close(); await admin.end().catch(() => {}); }
}

async function main() {
  try { for (const i of [IMG_PLAIN, IMG_PG, IMG_REST]) docker("image", "inspect", i); } catch { console.log("SKIP: Docker or the required images are unavailable"); return; }
  try { await partA(); await partB(); console.log(JSON.stringify({ status: "PASS", suite: "mfa-foundation-postgres" })); }
  finally { for (const n of names) { try { docker("rm", "-f", n); } catch { /* already gone */ } } }
}
main().catch((e) => { console.error(e); process.exit(1); });
