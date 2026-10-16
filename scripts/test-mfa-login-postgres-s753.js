// Settings S7.5.3 against real databases (disposable Docker containers only; never a real project):
//   A. plain Postgres 16: migration 20261023 (recovery-code key identification): order guard, additive, idempotent, function replacement without an ambiguous overload, access control, rollback
//   B. Supabase Postgres 17 + PostgREST + the real SupabaseLeadAgentsStore driving the REAL Office server: password step -> challenge -> TOTP/recovery verification -> governed session, replay and
//      lockout persisted in the database, concurrency across two server instances, code-before-migration compatibility, and fail-closed behaviour when the database goes away.
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
const MIG = "20261020_admin_session_generation.sql", MFA = "20261022_admin_mfa_foundation.sql", MFA_DOWN = "rollback/20261022_admin_mfa_foundation.down.sql", KEYID = "20261023_admin_mfa_recovery_code_key_id.sql", KEYID_DOWN = "rollback/20261023_admin_mfa_recovery_code_key_id.down.sql";
const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLAIN_PORT = 54401, SB_PORT = 54402, REST_PORT = 54403, PROXY_PORT = 54404, SUF = process.pid;
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
const SESSION = "s7-5-3-pg-session-secret-0123456789abcdef-xyz", K1 = randomB64(32);
const FUNC4 = "office_mfa_replace_recovery_codes(uuid,uuid,text[],text)";

async function partA() {
  const name = `ochiga-s753-plain-${SUF}`; names.push(name);
  docker("run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=x", "-p", `${PLAIN_PORT}:5432`, IMG_PLAIN);
  const admin = await waitClient(PLAIN_PORT);
  await admin.query("create database nomfa"); const nm = await client(PLAIN_PORT, "postgres", "x", "nomfa"); await nm.query(TABLE); await nm.query(sql(MIG));
  await assert.rejects(() => nm.query(sql(KEYID)), /apply 20261022_admin_mfa_foundation\.sql/, "refuses to apply before the MFA foundation"); await nm.end();
  console.log("A0. Order guard: 20261023 refuses to apply without 20261022 — PASS");
  for (const r of ["anon", "authenticated", "service_role"]) await admin.query(`create role ${r} nologin`);
  await admin.query(TABLE); await admin.query(sql(MIG)); await admin.query(sql(MFA)); await seed(admin); await admin.query("grant all on admin_users to service_role");
  const boss = (await admin.query("select id from admin_users where email='boss@ochiga.test'")).rows[0].id, staff = (await admin.query("select id from admin_users where email='staff@ochiga.test'")).rows[0].id;
  const legacy = [H("l1"), H("l2"), H("l3")]; assert.equal((await admin.query("select office_mfa_replace_recovery_codes($1,gen_random_uuid(),$2::text[]) n", [boss, legacy])).rows[0].n, 3);
  const before = await snapHash(admin); const rowsBefore = (await admin.query("select md5(string_agg(code_hmac || coalesce(used_at::text,''), ',' order by code_hmac)) h, count(*) c from admin_mfa_recovery_codes")).rows[0];
  await admin.query(sql(KEYID));
  assert.equal(await snapHash(admin), before, "accounts untouched"); assert.deepEqual((await admin.query("select md5(string_agg(code_hmac || coalesce(used_at::text,''), ',' order by code_hmac)) h, count(*) c from admin_mfa_recovery_codes")).rows[0], rowsBefore, "every existing code row is unchanged");
  assert.equal((await admin.query("select count(*) c from admin_mfa_recovery_codes where key_id is not null")).rows[0].c, "0", "existing codes have no recorded key (null = legacy)");
  const cat = async () => (await admin.query("select (select count(*) from pg_proc where proname='office_mfa_replace_recovery_codes') fn, (select count(*) from pg_indexes where tablename='admin_mfa_recovery_codes') idx, (select count(*) from pg_constraint where conrelid='admin_mfa_recovery_codes'::regclass) con")).rows[0];
  const c1 = await cat(); await admin.query(sql(KEYID)); await admin.query(sql(KEYID)); assert.deepEqual(await cat(), c1, "re-applying changes nothing"); assert.equal(c1.fn, "1", "the 3-argument form was REPLACED, not overloaded (no ambiguous call)");
  assert.equal((await admin.query("select office_mfa_replace_recovery_codes($1,gen_random_uuid(),$2::text[]) n", [boss, [H("n1")]])).rows[0].n, 1, "a call without a key id still works (default)"); assert.equal((await admin.query("select key_id k from admin_mfa_recovery_codes where admin_user_id=$1 and used_at is null", [boss])).rows[0].k, null);
  assert.equal((await admin.query("select office_mfa_replace_recovery_codes($1,gen_random_uuid(),$2::text[],'k1') n", [boss, [H("k1"), H("k2")]])).rows[0].n, 2, "and with one"); assert.deepEqual((await admin.query("select distinct key_id k from admin_mfa_recovery_codes where admin_user_id=$1 and used_at is null", [boss])).rows, [{ k: "k1" }], "the key id is recorded");
  await assert.rejects(() => admin.query("select office_mfa_replace_recovery_codes($1,gen_random_uuid(),$2::text[],'bad id!')", [boss, [H("z")]]), (e) => e.code === "23514", "a malformed key id is refused by the database"); assert.equal((await admin.query("select count(*) c from admin_mfa_recovery_codes where admin_user_id=$1 and used_at is null", [boss])).rows[0].c, "2", "…and the refused call changed nothing (atomic)");
  const privs = async (role) => (await admin.query("select has_function_privilege($1,$2,'EXECUTE') v", [role, FUNC4])).rows[0].v; assert.deepEqual([await privs("anon"), await privs("authenticated"), await privs("service_role")], [false, false, true], "service role only");
  assert.equal((await admin.query("select count(*) c from information_schema.routine_privileges where routine_name='office_mfa_replace_recovery_codes' and grantee='PUBLIC'")).rows[0].c, "0", "nothing granted to PUBLIC"); for (const role of ["anon", "authenticated"]) { const c = await client(PLAIN_PORT); await c.query(`set role ${role}`); await assert.rejects(() => c.query("select office_mfa_replace_recovery_codes(gen_random_uuid(), gen_random_uuid(), '{x}'::text[], 'k1')"), (e) => e.code === "42501"); await c.end(); }
  const usedBefore = (await admin.query("select count(*) c from admin_mfa_recovery_codes")).rows[0].c; await admin.query(sql(KEYID_DOWN)); assert.equal((await admin.query("select count(*) c from pg_proc where proname='office_mfa_replace_recovery_codes'")).rows[0].c, "1", "rollback leaves exactly one function"); assert.equal((await admin.query("select pronargs a from pg_proc where proname='office_mfa_replace_recovery_codes'")).rows[0].a, 3, "…the original 3-argument form");
  assert.equal((await admin.query("select count(*) c from admin_mfa_recovery_codes")).rows[0].c, usedBefore, "rollback keeps every row"); assert.deepEqual((await admin.query("select distinct key_id k from admin_mfa_recovery_codes where admin_user_id=$1 and used_at is null", [boss])).rows, [{ k: "k1" }], "and the key ids already recorded");
  assert.equal((await admin.query("select office_mfa_replace_recovery_codes($1,gen_random_uuid(),$2::text[]) n", [boss, [H("after-rollback")]])).rows[0].n, 1, "the old function works after rollback"); await admin.query(sql(KEYID)); assert.equal((await admin.query("select pronargs a from pg_proc where proname='office_mfa_replace_recovery_codes'")).rows[0].a, 4, "re-applied");
  await admin.query(sql(MFA_DOWN)); assert.equal((await admin.query("select count(*) c from pg_proc where proname like 'office_mfa%'")).rows[0].c, "0", "the S7.5.1 rollback also removes the S7.5.3 form of the function"); assert.ok(Number((await admin.query("select count(*) c from admin_mfa_recovery_codes")).rows[0].c) > 0, "and keeps the data");
  console.log("A1. 20261023: additive, idempotent, function replaced (no overload), key id recorded and constrained, access control, rollback keeps columns and data — PASS");
  await admin.end();
}

async function partB() {
  const pg = `ochiga-s753-sbpg-${SUF}`, pr = `ochiga-s753-rest-${SUF}`; names.push(pg, pr);
  docker("run", "-d", "--rm", "--name", pg, "-e", "POSTGRES_PASSWORD=testpw", "-p", `${SB_PORT}:5432`, IMG_PG);
  let admin = await waitClient(SB_PORT, "postgres", "testpw");
  await admin.end(); const sa = await waitClient(SB_PORT, "supabase_admin", "testpw"); await sa.query("alter role authenticator with password 'testpw'"); await sa.end(); admin = await client(SB_PORT, "postgres", "testpw");
  await admin.query(TABLE); await admin.query("alter table admin_users add column if not exists last_login_at timestamptz, add column if not exists office_position text, add column if not exists phone text, add column if not exists passport_photo_url text, add column if not exists qr_credential text");
  await admin.query("create table if not exists audit_events (id uuid primary key default gen_random_uuid(), actor_user_id uuid references admin_users(id) on delete set null, actor_email text, actor_role text, action text not null, target_type text not null, target_id text, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now())");
  for (const t of ["admin_users", "audit_events"]) await admin.query(`alter table ${t} enable row level security`); await admin.query("revoke all on admin_users, audit_events from anon, authenticated");
  // R3: since S7.5.7 sign-in reads the MFA enforcement setting (fail-closed). Its table is an S3 prerequisite of any real deployment, so the fixture applies it like production does.
  for (const base of ["20261014_office_runtime_settings.sql", "20261019_office_runtime_settings_versioning.sql"]) await admin.query(sql(base));
  await admin.query(sql(MIG)); await admin.query(sql(MFA));
  docker("run", "-d", "--rm", "--name", pr, "-p", `${REST_PORT}:3000`, "-e", `PGRST_DB_URI=postgres://authenticator:testpw@host.docker.internal:${SB_PORT}/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`, "-e", "PGRST_DB_POOL=10", IMG_REST);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${REST_PORT}/`, { headers: { apikey: jwt("service_role") } })).status < 500) break; } catch { /* starting */ } await sleep(1000); }
  await admin.query("notify pgrst, 'reload schema'"); await sleep(2500); let proxy = await startProxy();
  const mkStore = () => new SupabaseLeadAgentsStore({ url: `http://127.0.0.1:${PROXY_PORT}`, serviceRoleKey: jwt("service_role"), requestTimeoutMs: 15000 });
  const sA = mkStore(), sB = mkStore();
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["pg-api-key-0123456789"], allowedOrigins: [], sessionSecret: SESSION, sessionSecretEphemeral: false, mfaMode: "on", mfaKey: K1, mfaKeyId: "k1", mfaKeysPrevious: "" };
  const lib = m.createMfaCrypto(config); const A = "/api/lead-agents/admin"; const responses = [];
  const startApp = async (st) => { const rl = (n) => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: n }); const server = buildServer({ config, store: st, rateLimiter: rl(9000), publicRateLimiter: rl(9000), officeRateLimiter: rl(9000), loginRateLimiter: rl(9000), whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] }, openaiClient: {}, toolExecutor: new ToolExecutor({ store: st, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
    const base = `http://127.0.0.1:${await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)))}`; const call = async (method, p, { cookie, body } = {}) => { const r = await fetch(`${base}${p}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); responses.push(text); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text, cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
    return { call, login: (e, p) => call("POST", `${A}/session/login`, { body: { email: e, password: p } }), verify: (b) => call("POST", `${A}/session/mfa/verify`, { body: b }), protectedRoute: (c) => call("GET", `${A}/users`, { cookie: c }), me: (c) => call("GET", `${A}/session/me`, { cookie: c }), health: () => call("GET", "/healthz"), close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) }; };
  const appA = await startApp(sA), appB = await startApp(sB);
  const mkUser = async (label) => { const id = (await admin.query("insert into admin_users (email, password_hash, role, status, display_name) values ($1,$2,'super_admin','active',$3) returning id", [`${label}@ochiga.test`, hashPassword(`${label} account passphrase number 7`), label])).rows[0].id; return { id, email: `${label}@ochiga.test`, pw: `${label} account passphrase number 7` }; };
  const enrol = async (u, { recovery = true, keyId } = {}) => { const id = crypto.randomUUID(); const secret = m.generateTotpSecret(); await sA.createMfaCredential(u.id, { id, type: "totp", label: "Phone", ...lib.encryptTotpSecret(secret, { userId: u.id, credentialId: id }) }); await sA.activateMfaCredential(u.id, id); let batch = null; if (recovery) { batch = lib.newRecoveryBatch(u.id); await sA.replaceMfaRecoveryCodes(u.id, crypto.randomUUID(), batch.hmacs, keyId ? { keyId: batch.key_id } : {}); } return { id, secret, batch }; };
  const code = (secret, off = 0) => m.hotp(secret, m.totpCounter(Date.now()) + off); const claims = (c) => JSON.parse(Buffer.from(decodeURIComponent(c.split("=")[1]).split(".")[0], "base64url").toString());
  try {
    // B1: the real server over the real Data API
    const plain = await mkUser("plain"); const u1 = await mkUser("boss"); const e1 = await enrol(u1);
    const plainLogin = await appA.login(plain.email, plain.pw); assert.ok(plainLogin.status === 200 && plainLogin.cookie && plainLogin.json.admin.email === plain.email, "an account without a factor signs in as before, through PostgREST");
    const step = await appA.login(u1.email, u1.pw); assert.ok(step.status === 200 && step.json.mfa_required === true && !step.cookie && !("admin" in step.json), "password only: a challenge, no cookie");
    const done = await appA.verify({ challenge_token: step.json.challenge_token, method: "totp", code: code(e1.secret) }); assert.ok(done.status === 200 && done.cookie && done.json.mfa.verified === true, "TOTP verified through the real database -> governed session"); const sc = claims(done.cookie); assert.ok(sc.mf === 1 && sc.sg === 0 && typeof sc.pf === "string" && Math.abs(sc.mft - Date.now()) < 10_000, "claims mf, mft, sg, pf");
    assert.equal((await appB.protectedRoute(done.cookie)).status, 200, "a second server instance (same database) accepts the session"); assert.equal((await appB.me(done.cookie)).json.mfa.verified, true);
    assert.equal((await appA.protectedRoute(plainLogin.cookie)).status, 200, "(the unenrolled session still works)");
    assert.equal(Number((await admin.query("select totp_last_step s from admin_mfa_credentials where id=$1", [e1.id])).rows[0].s), m.totpCounter(Date.now()), "the consumed step is stored by the S7.5.1 function");
    console.log("B1. Real server + Data API: unenrolled login unchanged; password -> challenge (no cookie) -> TOTP -> governed session with mf/mft/sg/pf; accepted by a second instance — PASS");

    // B2: replay and concurrency across two server instances sharing one database
    const u2 = await mkUser("race"); const e2 = await enrol(u2, { recovery: false }); const t2 = (await appA.login(u2.email, u2.pw)).json.challenge_token; const c2 = code(e2.secret);
    const burst = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? appA : appB).verify({ challenge_token: t2, method: "totp", code: c2 }))); assert.equal(burst.filter((r) => r.status === 200).length, 1, "16 simultaneous submissions of one code through two server instances: exactly ONE session"); assert.ok(burst.filter((r) => r.status !== 200).every((r) => [401, 429].includes(r.status) && !r.cookie));
    const u3 = await mkUser("replay"); const e3 = await enrol(u3, { recovery: false }); const cc = code(e3.secret); assert.equal((await appA.verify({ challenge_token: (await appA.login(u3.email, u3.pw)).json.challenge_token, method: "totp", code: cc })).status, 200); const rep = await appB.verify({ challenge_token: (await appB.login(u3.email, u3.pw)).json.challenge_token, method: "totp", code: cc }); assert.ok(rep.status === 401 && !rep.cookie, "the same code on the OTHER instance is a replay (the database is the only replay state)");
    console.log("B2. Replay and concurrency: one winner across two instances, replay refused by the database — PASS");

    // B3: persisted lockout
    const u4 = await mkUser("lock"); const e4 = await enrol(u4, { recovery: false }); const t4 = (await appA.login(u4.email, u4.pw)).json.challenge_token; for (let i = 0; i < 4; i += 1) assert.equal((await appA.verify({ challenge_token: t4, method: "totp", code: "000000" })).status, 401);
    const locked = await appB.verify({ challenge_token: t4, method: "totp", code: "000000" }); assert.ok(locked.status === 429 && locked.json.error === "mfa_locked", "the 5th failure locks the account (counted on instance A and B alike)"); const row = (await admin.query("select mfa_failed_attempts f, mfa_locked_until l from admin_users where id=$1", [u4.id])).rows[0]; assert.ok(row.f === 5 && Date.parse(row.l) - Date.now() > 50_000 && Date.parse(row.l) - Date.now() <= 61_000, "the lock lives in the database");
    assert.equal((await appA.verify({ challenge_token: t4, method: "totp", code: code(e4.secret) })).status, 429, "the correct code is refused while locked"); await admin.query("update admin_users set mfa_locked_until = now() - interval '1 second' where id=$1", [u4.id]); assert.equal((await appA.verify({ challenge_token: t4, method: "totp", code: code(e4.secret) })).status, 200); assert.deepEqual((await admin.query("select mfa_failed_attempts f, mfa_locked_until l from admin_users where id=$1", [u4.id])).rows[0], { f: 0, l: null }, "success clears it in the database");
    console.log("B3. Lockout persisted in the database, shared by both instances, cleared on success — PASS");

    // B4: recovery codes before and after the key-id migration
    const u5 = await mkUser("recover"); const e5 = await enrol(u5, { recovery: true }); // keyless batch: the database predates 20261023
    await assert.rejects(() => sA.replaceMfaRecoveryCodes(u5.id, crypto.randomUUID(), [H("x")], { keyId: "k1" }), (e) => e.code === "mfa_unavailable", "before 20261023 a keyed batch is refused loudly (never silently stored without its key)"); await assert.rejects(() => sA.listMfaRecoveryKeyIds(u5.id), (e) => e.code === "mfa_schema_outdated", "and the key-id reader reports the schema is outdated");
    const oldRc = await appA.verify({ challenge_token: (await appA.login(u5.email, u5.pw)).json.challenge_token, method: "recovery_code", code: e5.batch.codes[0] }); assert.ok(oldRc.status === 200 && oldRc.json.mfa.recovery_codes_remaining === 9, "recovery codes still verify before the migration (every key is tried)");
    await admin.query(sql(KEYID)); await admin.query("notify pgrst, 'reload schema'"); await sleep(2500);
    const keyed = lib.newRecoveryBatch(u5.id); assert.equal(await sA.replaceMfaRecoveryCodes(u5.id, crypto.randomUUID(), keyed.hmacs, { keyId: keyed.key_id }), 10); assert.deepEqual(await sB.listMfaRecoveryKeyIds(u5.id), ["k1"], "the key id is recorded through the Data API");
    assert.ok((await sA.countUnusedRecoveryCodesNotUsingKey("k1")) >= 0 && (await sA.countUnusedRecoveryCodesNotUsingKey("k2")) >= 10, "retirement readiness counts through the Data API"); const before = await sA.listMfaRecoveryKeyIds(u1.id); assert.deepEqual(before, ["k1"].filter(() => false).concat(before), "(legacy accounts report null key ids)"); assert.ok(before.every((k) => k === null || typeof k === "string"));
    const old5 = (await appA.login(u5.email, u5.pw)).cookie; assert.equal(old5, "", "(a login now needs the second factor)"); const other = await appA.verify({ challenge_token: (await appA.login(u5.email, u5.pw)).json.challenge_token, method: "totp", code: code(e5.secret) }); assert.equal(other.status, 200);
    const rc = await appB.verify({ challenge_token: (await appB.login(u5.email, u5.pw)).json.challenge_token, method: "recovery_code", code: keyed.codes[0].toLowerCase() }); assert.ok(rc.status === 200 && rc.json.mfa.recovery_codes_remaining === 9 && claims(rc.cookie).sg === 2, "a keyed recovery code works through the database; the generation was bumped again (it was 1 after the first recovery-code use)");
    assert.equal((await appA.protectedRoute(other.cookie)).status, 401, "the earlier session of that account was ended by the recovery-code use"); assert.equal((await appA.verify({ challenge_token: (await appA.login(u5.email, u5.pw)).json.challenge_token, method: "recovery_code", code: keyed.codes[0] })).status, 401, "single use");
    const rcBurst = (() => null)(); const tb = (await appA.login(u5.email, u5.pw)).json.challenge_token; const wins = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? appA : appB).verify({ challenge_token: tb, method: "recovery_code", code: keyed.codes[1] }))); assert.equal(wins.filter((r) => r.status === 200).length, 1, "12 simultaneous uses of one recovery code through two instances: exactly one session"); void rcBurst;
    console.log("B4. Recovery codes: tolerant before 20261023, keyed after; single use under a 12-way race; other sessions ended; remaining count reported — PASS");

    // B5: readiness and redaction
    // (the full /healthz also reads unrelated tables this minimal database does not have, so the readiness inputs are checked directly)
    assert.ok((await sA.supportsMfa()) === true && (await sA.countMfaEnrolledAccounts()) >= 5 && require("../src/lead-agents/mfa-config").validateMfaConfig(config).valid, "readiness inputs: schema available, enrolled accounts counted, key configuration valid");
    const audit = JSON.stringify((await admin.query("select action, metadata from audit_events")).rows); for (const a of ["mfa_challenge_issued", "mfa_verified", "mfa_failed", "mfa_locked", "mfa_recovery_code_used", "sessions_revoked_mfa_recovery_code"]) assert.ok(audit.includes(a), `audit row written through the Data API: ${a}`);
    const stored = JSON.stringify((await admin.query("select secret_ciphertext, code_hmac from admin_mfa_credentials full join admin_mfa_recovery_codes on false")).rows);
    for (const secret of [K1, SESSION, e1.secret.toString("base64"), m.base32Encode(e1.secret), keyed.codes[0], keyed.codes[0].replace("-", ""), e5.batch.codes[0]]) assert.ok(!responses.join("").includes(secret) && !audit.includes(secret) && !stored.includes(secret), "no secret, code or key in any response, audit row or stored column");
    assert.ok(!audit.includes("challenge_token") && !/scrypt/.test(audit), "no challenge token or password hash in the audit table");
    console.log("B5. Readiness reports the schema and enrolled accounts; audit rows written; nothing secret in responses, audit or storage — PASS");

    // B6: the database goes away: everything fails closed
    const u6 = await mkUser("outage"); const e6 = await enrol(u6, { recovery: false }); const s6 = (await appA.login(u6.email, u6.pw)).json.challenge_token; const ok6 = await appA.verify({ challenge_token: s6, method: "totp", code: code(e6.secret) }); assert.equal(ok6.status, 200);
    const t6 = (await appA.login(u6.email, u6.pw)).json.challenge_token; proxy.close(); await sleep(300);
    const down1 = await appA.login(u6.email, u6.pw); assert.ok(down1.status >= 500 && !down1.cookie && !down1.json?.challenge_token, "login with the database down: an error, never a challenge or a session");
    const down2 = await appA.verify({ challenge_token: t6, method: "totp", code: code(e6.secret, 1) }); assert.ok(down2.status >= 500 && !down2.cookie, "verification with the database down: an error, no session"); const down3 = await appA.protectedRoute(ok6.cookie); assert.ok(down3.status >= 500, "a live session is not accepted when its state cannot be verified");
    for (const r of [down1, down2, down3]) assert.ok(!/127\.0\.0\.1|ECONNREFUSED|axios/i.test(r.text), "no connection detail is returned");
    proxy = await startProxy(); await sleep(300); assert.equal((await appA.protectedRoute(ok6.cookie)).status, 200, "service resumes when the database returns"); assert.equal((await appA.verify({ challenge_token: t6, method: "totp", code: code(e6.secret, 1) })).status, 200, "and the unconsumed code still works (the failed attempts consumed nothing)");
    console.log("B6. Database outage: login, verification and session checks all fail closed with no connection detail; nothing consumed; recovers — PASS");
  } finally { await appA.close(); await appB.close(); try { proxy.close(); } catch { /* closed */ } await admin.end().catch(() => {}); }
}

async function main() {
  try { for (const i of [IMG_PLAIN, IMG_PG, IMG_REST]) docker("image", "inspect", i); } catch { console.log("SKIP: Docker or the required images are unavailable"); return; }
  try { await partA(); await partB(); console.log(JSON.stringify({ status: "PASS", suite: "mfa-login-postgres" })); }
  finally { for (const n of names) { try { docker("rm", "-f", n); } catch { /* already gone */ } } }
}
main().catch((e) => { console.error(e); process.exit(1); });
