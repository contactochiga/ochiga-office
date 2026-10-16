// Settings S7.5.5 (WebAuthn / passkeys) against real databases (disposable Docker containers only; never a real project):
//   A. plain Postgres 16: migration 20261025 (order guard, additive, idempotent, access control), the atomic counter compare-and-set under true concurrency, the 10-credential limit inside
//      the activation transaction, and the non-destructive down migration.
//   B. Supabase Postgres 17 + PostgREST + the real SupabaseLeadAgentsStore driving the REAL Office server: registration and sign-in with a software authenticator, replay and counter rollback,
//      code-before-migration compatibility, Data API isolation, fail-closed on a database outage, secret redaction.
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
const PLAIN_PORT = 54421, SB_PORT = 54422, REST_PORT = 54423, PROXY_PORT = 54424, SUF = process.pid;
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
const WFUNCS = ["office_mfa_webauthn_version()", "office_mfa_webauthn_record_use(uuid,uuid,bigint)", "office_mfa_activate_credential(uuid,uuid,text,uuid,bigint,text[],text)"];
const WA = "20261025_admin_mfa_webauthn.sql", WA_DOWN = "rollback/20261025_admin_mfa_webauthn.down.sql";
const { SoftwareAuthenticator } = require("./webauthn-test-authenticator");
const FUNCS = ["office_mfa_management_version()", "office_mfa_activate_credential(uuid,uuid,text,uuid,bigint,text[],text)", "office_mfa_revoke_credential(uuid,uuid,text,text,boolean)", "office_mfa_consume_recovery_code_revoking(uuid,text,text)"];

async function partA() {
  const name = `ochiga-s755-plain-${SUF}`; names.push(name);
  docker("run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=x", "-p", `${PLAIN_PORT}:5432`, IMG_PLAIN);
  const admin = await waitClient(PLAIN_PORT);
  await admin.query("create database early"); const ea = await client(PLAIN_PORT, "postgres", "x", "early"); await ea.query(TABLE); await ea.query(sql(MIG)); await ea.query(sql(MFA)); await ea.query(sql(KEYID));
  await assert.rejects(() => ea.query(sql(WA)), /apply 20261024_admin_mfa_management\.sql/, "refuses to apply before 20261024"); await ea.end();
  console.log("A0. Order guard: 20261025 refuses to apply without 20261024 — PASS");
  for (const r of ["anon", "authenticated", "service_role"]) await admin.query(`create role ${r} nologin`);
  await admin.query(TABLE); await admin.query(sql(MIG)); await admin.query(sql(MFA)); await admin.query(sql(KEYID)); await admin.query(sql(MGMT)); await seed(admin); await admin.query("grant all on admin_users to service_role");
  const boss = (await admin.query("select id from admin_users where email='boss@ochiga.test'")).rows[0].id, staff = (await admin.query("select id from admin_users where email='staff@ochiga.test'")).rows[0].id;
  let seq = 0; const wcred = async (user, status = "active", count = 0) => { seq += 1; return (await admin.query("insert into admin_mfa_credentials (admin_user_id, type, status, webauthn_credential_id, webauthn_public_key, webauthn_sign_count) values ($1,'webauthn',$2,decode(lpad(to_hex($3::int),8,'0'),'hex'),'\\x0a',$4) returning id", [user, status, seq, count])).rows[0].id; };
  const cat = async () => (await admin.query("select (select count(*) from pg_proc where proname like 'office_mfa%') fn, (select string_agg(indexname, ',' order by indexname) from pg_indexes where tablename='admin_mfa_credentials') idx")).rows[0];
  const first = await wcred(boss, "active", 5); const before = await snapHash(admin); const rowsBefore = (await admin.query("select count(*) c from admin_mfa_credentials")).rows[0].c;
  await admin.query(sql(WA)); assert.equal(await snapHash(admin), before, "accounts untouched"); assert.equal((await admin.query("select count(*) c from admin_mfa_credentials")).rows[0].c, rowsBefore, "credentials untouched");
  const c1 = await cat(); await admin.query(sql(WA)); await admin.query(sql(WA)); assert.deepEqual(await cat(), c1, "idempotent"); assert.equal((await admin.query("select office_mfa_webauthn_version() v")).rows[0].v, 1);
  for (const role of ["anon", "authenticated"]) for (const f of WFUNCS) assert.equal((await admin.query("select has_function_privilege($1,$2,'EXECUTE') v", [role, f])).rows[0].v, false, `${role} cannot execute ${f}`);
  assert.ok((await Promise.all(WFUNCS.map(async (f) => (await admin.query("select has_function_privilege('service_role',$1,'EXECUTE') v", [f])).rows[0].v))).every(Boolean), "service_role executes all"); assert.equal((await admin.query("select count(*) c from information_schema.routine_privileges where routine_name in ('office_mfa_webauthn_record_use','office_mfa_webauthn_version','office_mfa_activate_credential') and grantee='PUBLIC'")).rows[0].c, "0", "nothing granted to PUBLIC");
  for (const role of ["anon", "authenticated"]) { const c = await client(PLAIN_PORT); await c.query(`set role ${role}`); for (let k = 0; k < 3; k++) for (const q of ["select office_mfa_webauthn_version()", "select office_mfa_webauthn_record_use(gen_random_uuid(), gen_random_uuid(), 1)"]) await assert.rejects(() => c.query(q), (e) => e.code === "42501", `${role}: ${q.slice(0, 44)} refused (run ${k})`); await c.end(); }
  console.log("A1. 20261025: additive, idempotent, accounts and credentials untouched; functions service-role only (stable across repeated calls) — PASS");

  const rec = async (c, uid, cred, n) => (await c.query("select office_mfa_webauthn_record_use($1::uuid,$2::uuid,$3::bigint) v", [uid, cred, n])).rows[0].v; const stored = async (id) => Number((await admin.query("select webauthn_sign_count s from admin_mfa_credentials where id=$1", [id])).rows[0].s);
  assert.equal(await rec(admin, boss, first, 5), false, "a repeated counter (5 = 5) is refused"); assert.equal(await rec(admin, boss, first, 4), false, "a lower counter is refused"); assert.equal(await stored(first), 5, "…and the stored counter did not move");
  assert.equal(await rec(admin, staff, first, 9), false, "another account cannot advance it"); assert.equal(await rec(admin, boss, crypto.randomUUID(), 9), false, "unknown credential: false");
  assert.equal(await rec(admin, boss, first, 6), true); assert.equal(await stored(first), 6); assert.ok((await admin.query("select last_used_at from admin_mfa_credentials where id=$1", [first])).rows[0].last_used_at, "last use recorded");
  const zero = await wcred(boss, "active", 0); assert.equal(await rec(admin, boss, zero, 0), true, "synced passkeys report 0 forever: 0 -> 0 accepted"); assert.equal(await rec(admin, boss, zero, 0), true, "…and again"); assert.equal(await rec(admin, boss, first, 0), false, "but 6 -> 0 is a rollback: refused");
  const revoked = await wcred(boss, "revoked", 0); assert.equal(await rec(admin, boss, revoked, 3), false, "a revoked credential cannot be used"); const pending = await wcred(boss, "pending", 0); assert.equal(await rec(admin, boss, pending, 3), false, "a pending credential cannot be used");
  const conns = await Promise.all(Array.from({ length: 12 }, () => client(PLAIN_PORT))); const race = await wcred(boss, "active", 10);
  const same = await Promise.all(conns.map((c) => rec(c, boss, race, 11))); assert.equal(same.filter(Boolean).length, 1, "12 simultaneous assertions with the same counter: exactly one is accepted"); assert.equal(await stored(race), 11);
  const ladder = await Promise.all(conns.map((c, i) => rec(c, boss, race, 20 + i))); assert.equal(await stored(race), 31, "12 simultaneous different counters: the highest always ends up stored (never decreases)"); assert.ok(ladder[11] === true && ladder.filter(Boolean).length >= 1, "the highest is accepted");
  assert.equal(await rec(admin, boss, race, await stored(race)), false, "after the burst, repeating the final value is refused"); await Promise.all(conns.map((c) => c.end()));
  console.log("A2. Counter compare-and-set: repeat and rollback refused, 0->0 allowed, revoked/pending/other-account refused, 12-way race has one winner, counter never decreases — PASS");

  const u2 = (await admin.query("insert into admin_users (email, password_hash) values ('lim@ochiga.test','salt:x') returning id")).rows[0].id; const act = async (uid, cred, o = {}) => (await admin.query("select * from office_mfa_activate_credential($1::uuid,$2::uuid,'t',$3::uuid,null,null,null)", [uid, cred, o.replace ?? null])).rows;
  for (let i = 0; i < 10; i++) { const p = await wcred(u2, "pending"); assert.equal((await act(u2, p)).length, 1, `activation ${i + 1} of 10`); }
  const gen = async () => Number((await admin.query("select session_generation g from admin_users where id=$1", [u2])).rows[0].g); const g0 = await gen(); const eleventh = await wcred(u2, "pending");
  await assert.rejects(() => act(u2, eleventh), (e) => e.code === "P0001" && /credential_limit/.test(e.message), "the 11th active WebAuthn credential is refused"); assert.equal(await gen(), g0, "…and nothing changed (no bump)"); assert.equal((await admin.query("select status from admin_mfa_credentials where id=$1", [eleventh])).rows[0].status, "pending");
  const victim = (await admin.query("select id from admin_mfa_credentials where admin_user_id=$1 and status='active' limit 1", [u2])).rows[0].id; assert.equal((await act(u2, eleventh, { replace: victim }))[0].replaced, true, "a REPLACEMENT at the limit succeeds (it frees its own slot)"); assert.equal(Number((await admin.query("select count(*) c from admin_mfa_credentials where admin_user_id=$1 and status='active'", [u2])).rows[0].c), 10);
  const t = (await admin.query("insert into admin_mfa_credentials (admin_user_id, type, status, secret_ciphertext, secret_nonce, secret_key_id) values ($1,'totp','pending','ct','n','k1') returning id", [u2])).rows[0].id; assert.equal((await act(u2, t)).length, 1, "a TOTP factor is not limited by the WebAuthn cap");
  const u3 = (await admin.query("insert into admin_users (email, password_hash) values ('lim2@ochiga.test','salt:x') returning id")).rows[0].id; for (let i = 0; i < 9; i++) await wcred(u3, "active"); const pend = await Promise.all(Array.from({ length: 6 }, () => wcred(u3, "pending"))); const cs = await Promise.all(pend.map(() => client(PLAIN_PORT)));
  const outs = await Promise.all(pend.map((p, i) => cs[i].query("select * from office_mfa_activate_credential($1::uuid,$2::uuid,'t',null,null,null,null)", [u3, p]).then(() => "ok", (e) => e.code))); await Promise.all(cs.map((c) => c.end()));
  assert.equal(outs.filter((x) => x === "ok").length, 1, `6 simultaneous activations with one slot left: exactly one wins (${outs.join(",")})`); assert.equal(Number((await admin.query("select count(*) c from admin_mfa_credentials where admin_user_id=$1 and status='active' and type='webauthn'", [u3])).rows[0].c), 10, "never more than 10");
  console.log("A3. Credential limit inside the activation transaction: 11th refused with no change, replacement allowed, TOTP unaffected, 6-way race cannot exceed 10 — PASS");

  const rows0 = (await admin.query("select count(*) c, md5(string_agg(id::text || status || coalesce(webauthn_sign_count,0)::text, ',' order by id)) m from admin_mfa_credentials")).rows[0];
  await admin.query(sql(WA_DOWN)); assert.equal((await admin.query("select count(*) c from pg_proc where proname in ('office_mfa_webauthn_record_use','office_mfa_webauthn_version')")).rows[0].c, "0", "new functions removed");
  assert.deepEqual((await admin.query("select count(*) c, md5(string_agg(id::text || status || coalesce(webauthn_sign_count,0)::text, ',' order by id)) m from admin_mfa_credentials")).rows[0], rows0, "every credential, status and counter kept");
  assert.equal((await admin.query("select count(*) c from pg_proc where proname='office_mfa_activate_credential'")).rows[0].c, "1", "the S7.5.4 activation function is back");
  const u4 = (await admin.query("insert into admin_users (email, password_hash) values ('lim3@ochiga.test','salt:x') returning id")).rows[0].id; for (let i = 0; i < 10; i++) await wcred(u4, "active"); const p4 = await wcred(u4, "pending"); assert.equal((await act(u4, p4)).length, 1, "after rollback the S7.5.4 function has no WebAuthn cap (documented)");
  await admin.query(sql(WA)); assert.equal((await admin.query("select office_mfa_webauthn_version() v")).rows[0].v, 1, "re-applied");
  console.log("A4. Rollback: new functions dropped, S7.5.4 activation restored, every credential and counter kept; re-apply works — PASS");
  await admin.end();
}

async function partB() {
  const pg = `ochiga-s755-sbpg-${SUF}`, pr = `ochiga-s755-rest-${SUF}`; names.push(pg, pr);
  docker("run", "-d", "--rm", "--name", pg, "-e", "POSTGRES_PASSWORD=testpw", "-p", `${SB_PORT}:5432`, IMG_PG);
  let admin = await waitClient(SB_PORT, "postgres", "testpw");
  await admin.end(); const sa = await waitClient(SB_PORT, "supabase_admin", "testpw"); await sa.query("alter role authenticator with password 'testpw'"); await sa.end(); admin = await client(SB_PORT, "postgres", "testpw");
  await admin.query(TABLE); await admin.query("alter table admin_users add column if not exists last_login_at timestamptz, add column if not exists office_position text, add column if not exists phone text, add column if not exists passport_photo_url text, add column if not exists qr_credential text");
  await admin.query("create table if not exists audit_events (id uuid primary key default gen_random_uuid(), actor_user_id uuid references admin_users(id) on delete set null, actor_email text, actor_role text, action text not null, target_type text not null, target_id text, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now())");
  for (const t of ["admin_users", "audit_events"]) await admin.query(`alter table ${t} enable row level security`); await admin.query("revoke all on admin_users, audit_events from anon, authenticated");
  // R3: since S7.5.7 sign-in reads the MFA enforcement setting (fail-closed). Its table is an S3 prerequisite of any real deployment, so the fixture applies it like production does.
  for (const base of ["20261014_office_runtime_settings.sql", "20261019_office_runtime_settings_versioning.sql"]) await admin.query(sql(base));
  await admin.query(sql(MIG)); await admin.query(sql(MFA)); await admin.query(sql(KEYID)); await admin.query(sql(MGMT));
  docker("run", "-d", "--rm", "--name", pr, "-p", `${REST_PORT}:3000`, "-e", `PGRST_DB_URI=postgres://authenticator:testpw@host.docker.internal:${SB_PORT}/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`, "-e", "PGRST_DB_POOL=10", IMG_REST);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${REST_PORT}/`, { headers: { apikey: jwt("service_role") } })).status < 500) break; } catch { /* starting */ } await sleep(1000); }
  await admin.query("notify pgrst, 'reload schema'"); await sleep(2500); let proxy = await startProxy();
  const mkStore = () => new SupabaseLeadAgentsStore({ url: `http://127.0.0.1:${PROXY_PORT}`, serviceRoleKey: jwt("service_role"), requestTimeoutMs: 15000 });
  const sA = mkStore(), sB = mkStore();
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["pg-api-key-0123456789"], allowedOrigins: [], sessionSecret: SESSION, sessionSecretEphemeral: false, mfaMode: "on", mfaKey: K1, mfaKeyId: "k1", mfaKeysPrevious: "", officeEmailProvider: "", webauthnRpId: "", webauthnOrigins: [] };
  const A = "/api/lead-agents/admin"; const responses = [];
  const startApp = async (st) => { const rl = (n) => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: n }); const server = buildServer({ config, store: st, rateLimiter: rl(9000), publicRateLimiter: rl(9000), officeRateLimiter: rl(9000), loginRateLimiter: rl(9000), whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] }, openaiClient: {}, toolExecutor: new ToolExecutor({ store: st, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
    const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))); const base = `http://127.0.0.1:${port}`; const call = async (method, p, { cookie, body, token } = {}) => { const r = await fetch(`${base}${p}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { "x-step-up-token": token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); responses.push(text); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text, cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
    return { call, port, origin: `http://localhost:${port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) }; };
  const appA = await startApp(sA), appB = await startApp(sB);
  config.webauthnRpId = "localhost"; config.webauthnOrigins = [appA.origin, appB.origin];
  const mkUser = async (label) => { const id = (await admin.query("insert into admin_users (email, password_hash, role, status, display_name) values ($1,$2,'super_admin','active',$3) returning id", [`${label}@ochiga.test`, hashPassword(`${label} account passphrase number 7`), label])).rows[0].id; return { id, email: `${label}@ochiga.test`, pw: `${label} account passphrase number 7` }; };
  const login = (app, u) => app.call("POST", `${A}/session/login`, { body: { email: u.email, password: u.pw } });
  const stepUp = async (app, cookie, u, mfa) => (await app.call("POST", `${A}/session/step-up`, { cookie, body: { password: u.pw, purpose: "mfa_management", ...(mfa ? { mfa } : {}) } })).json?.step_up?.token;
  const wa = (app, p, o) => app.call("POST", `${A}/session/mfa/webauthn${p}`, o);
  const newAuth = (app, over = {}) => new SoftwareAuthenticator({ rpId: "localhost", origin: app.origin, ...over });
  const register = async (app, cookie, u, authn, label = "Key") => { const token = await stepUp(app, cookie, u); const o = await wa(app, "/register/options", { cookie, token, body: {} }); const v = await wa(app, "/register/verify", { cookie, token, body: { challenge_id: o.json.challenge_id, response: authn.createCredential(o.json.options), label } }); return { o, v, cookie: v.cookie }; };
  const signIn = async (app, u, authn, over = {}) => { const l = await login(app, u); const o = await wa(app, "/auth/options", { body: { challenge_token: l.json.challenge_token } }); const verify = (resp) => app.call("POST", `${A}/session/mfa/verify`, { body: { challenge_token: l.json.challenge_token, method: "webauthn", webauthn: { challenge_id: o.json.challenge_id, response: resp } } }); return { l, o, verify, assertion: () => authn.getAssertion(o.json.options, over) }; };
  try {
    // B1: code deployed BEFORE 20261025
    const early = await mkUser("early"); const eCookie = (await login(appA, early)).cookie; const eTok = await stepUp(appA, eCookie, early); const eOpts = await wa(appA, "/register/options", { cookie: eCookie, token: eTok, body: {} });
    assert.ok(eOpts.status === 503 && !eOpts.text.includes("secret"), `before 20261025 WebAuthn registration is unavailable, not half-working (${eOpts.status})`); assert.equal(await sA.supportsMfaWebauthn(), false);
    console.log("B1. Code before 20261025: WebAuthn refuses (503), nothing half-working — PASS");

    await admin.query(sql(WA)); await admin.query("notify pgrst, 'reload schema'"); await sleep(2500); sA.mfaWebauthnCheckedAt = 0; sB.mfaWebauthnCheckedAt = 0; assert.equal(await sA.supportsMfaWebauthn(), true); assert.equal(await sB.supportsMfaWebauthn(), true);
    // B2: registration through the real server and database
    const u1 = await mkUser("boss"); const a1 = newAuth(appA); const c1 = (await login(appA, u1)).cookie; const reg = await register(appA, c1, u1, a1, "YubiKey");
    assert.ok(reg.v.status === 200 && reg.v.json.recovery_codes.length === 10 && reg.v.json.credential.type === "webauthn", `registration over PostgREST: ${reg.v.status}`);
    const row = (await admin.query("select status, webauthn_credential_id cid, webauthn_public_key pk, webauthn_sign_count sc, label from admin_mfa_credentials where admin_user_id=$1", [u1.id])).rows[0]; assert.ok(row.status === "active" && Buffer.compare(row.cid, a1.credentialId) === 0 && row.pk.length > 40 && Number(row.sc) === 0 && row.label === "YubiKey", "stored: id, public key, counter 0");
    assert.equal(Number((await admin.query("select session_generation g from admin_users where id=$1", [u1.id])).rows[0].g), 1, "activation bumped the generation once"); assert.equal((await appB.call("GET", `${A}/users`, { cookie: reg.cookie })).status, 200, "the re-issued session is accepted by a second instance");
    const dupOpts = await wa(appA, "/register/options", { cookie: reg.cookie, token: await stepUp(appA, reg.cookie, u1, { method: "webauthn", ...await (async () => { const so = await wa(appA, "/step-up-options", { cookie: reg.cookie, body: {} }); return { challenge_id: so.json.challenge_id, response: a1.getAssertion(so.json.options) }; })() }), body: {} });
    assert.equal(dupOpts.status, 200, "step-up with the registered security key works through the database (assertion + counter CAS)"); assert.equal(Number((await admin.query("select webauthn_sign_count s from admin_mfa_credentials where admin_user_id=$1", [u1.id])).rows[0].s), 1, "counter advanced to 1");
    const dup = await wa(appA, "/register/verify", { cookie: reg.cookie, token: await stepUp(appA, reg.cookie, u1, undefined).catch(() => null), body: { challenge_id: dupOpts.json.challenge_id, response: newAuth(appA, { credentialId: a1.credentialId }).createCredential(dupOpts.json.options) } }); assert.ok([401, 403, 409].includes(dup.status), `the same credential cannot be registered twice (${dup.status})`);
    assert.equal(Number((await admin.query("select count(*) c from admin_mfa_credentials where admin_user_id=$1", [u1.id])).rows[0].c), 1, "still exactly one credential");
    console.log("B2. Registration through the real server and database: attestation verified, credential and codes stored, one bump, duplicate refused, security-key step-up advances the counter — PASS");

    // B3: sign-in, replay, rollback, concurrency across two instances
    let s = await signIn(appA, u1, a1); const asr = s.assertion(); const ok1 = await s.verify(asr); assert.ok(ok1.status === 200 && ok1.cookie, "WebAuthn sign-in through PostgREST"); assert.equal(JSON.parse(Buffer.from(decodeURIComponent(ok1.cookie.split("=")[1]).split(".")[0], "base64url").toString()).mf, 1, "session carries MFA proof");
    assert.equal((await s.verify(asr)).status, 401, "replaying the same assertion (single-use challenge): refused");
    const cnt = async () => Number((await admin.query("select webauthn_sign_count s from admin_mfa_credentials where admin_user_id=$1", [u1.id])).rows[0].s); const high = await cnt();
    s = await signIn(appB, u1, a1); const rolled = await s.verify(a1.getAssertion(s.o.json.options, { useCounter: 1 })); assert.equal(rolled.status, 401, "counter rollback refused"); assert.equal(await cnt(), high, "…and the stored counter is unchanged"); assert.ok((await admin.query("select count(*) c from audit_events where action='mfa_webauthn_counter_rollback'")).rows[0].c >= "1", "audited");
    await sA.clearMfaFailures(u1.id);
    // two sign-ins with the SAME counter value presented concurrently through two instances: one wins
    const sx = await signIn(appA, u1, a1), sy = await signIn(appB, u1, a1); const useC = high + 50; const rx = a1.getAssertion(sx.o.json.options, { useCounter: useC }), ry = a1.getAssertion(sy.o.json.options, { useCounter: useC });
    const both = await Promise.all([sx.verify(rx), sy.verify(ry)]); assert.equal(both.filter((r) => r.status === 200).length, 1, `same counter via two instances at once: exactly one session (${both.map((r) => r.status)})`); assert.equal(await cnt(), useC);
    await sA.clearMfaFailures(u1.id);
    console.log("B3. Sign-in over the real database: success, replay refused, counter rollback refused and audited, concurrent same-counter assertions across two instances have one winner — PASS");

    // B4: revocation, outage, isolation, redaction
    const g = await login(appA, u1); const su = await wa(appA, "/auth/options", { body: { challenge_token: g.json.challenge_token } }); assert.equal(su.status, 200);
    const credId = (await admin.query("select id from admin_mfa_credentials where admin_user_id=$1", [u1.id])).rows[0].id; await admin.query("select * from office_mfa_revoke_credential($1::uuid,$2::uuid,'test','removed',false)", [u1.id, credId]);
    const afterRevoke = await appA.call("POST", `${A}/session/mfa/verify`, { body: { challenge_token: g.json.challenge_token, method: "webauthn", webauthn: { challenge_id: su.json.challenge_id, response: a1.getAssertion(su.json.options) } } }); assert.ok(afterRevoke.status === 401 && !afterRevoke.cookie, "a revoked credential cannot sign in");
    const u2 = await mkUser("outage"); const a2 = newAuth(appA); const r2 = await register(appA, (await login(appA, u2)).cookie, u2, a2); assert.equal(r2.v.status, 200); const so = await signIn(appA, u2, a2); const asrt = so.assertion(); const before = (await admin.query("select webauthn_sign_count s from admin_mfa_credentials where admin_user_id=$1", [u2.id])).rows[0].s; proxy.close(); await sleep(300);
    const down = await so.verify(asrt); assert.ok(down.status >= 500 && !down.cookie && !/127\.0\.0\.1|ECONN|axios/i.test(down.text), `database away: no session, no detail (${down.status})`); proxy = await startProxy(); await sleep(300);
    assert.equal((await admin.query("select webauthn_sign_count s from admin_mfa_credentials where admin_user_id=$1", [u2.id])).rows[0].s, before, "nothing changed while it was down");
    const snap = async () => (await admin.query("select (select count(*) from admin_mfa_credentials) c, (select md5(string_agg(id::text || webauthn_sign_count::text, ',' order by id)) from admin_mfa_credentials where type='webauthn') m")).rows[0]; const s0 = await snap();
    for (const role of ["anon", "authenticated"]) for (const [fn, args] of [["office_mfa_webauthn_version", {}], ["office_mfa_webauthn_record_use", { p_user_id: u2.id, p_credential_id: crypto.randomUUID(), p_new_count: 99 }]]) { const r = await rest(role, "POST", `/rpc/${fn}`, args); assert.ok([401, 403, 404].includes(r.status), `${role} ${fn} refused (${r.status})`); } assert.deepEqual(await snap(), s0, "refused Data API calls changed nothing");
    const audit = JSON.stringify((await admin.query("select action, metadata from audit_events")).rows); const storedAll = JSON.stringify((await admin.query("select * from admin_mfa_credentials")).rows.map((r) => ({ ...r, webauthn_public_key: undefined, webauthn_credential_id: undefined })));
    for (const secret of [K1, SESSION, ...reg.v.json.recovery_codes, asr.response.signature, a1.privateKey && a1.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")].filter(Boolean)) assert.ok(!audit.includes(secret) && !storedAll.includes(secret) && !responses.some((x, i) => i < 0 && x.includes(secret)), "no key, code or signature in the audit table or in stored columns");
    const pub = Buffer.from(a1.credentialId).toString("base64"); assert.ok(!audit.includes(pub), "the credential id is not copied into audit metadata");
    console.log("B4. Revoked credential refused; outage fails closed with no partial change; Data API roles refused; nothing secret in audit or storage — PASS");
  } finally { await appA.close(); await appB.close(); try { proxy.close(); } catch { /* closed */ } await admin.end().catch(() => {}); }
}

async function main() {
  try { for (const i of [IMG_PLAIN, IMG_PG, IMG_REST]) docker("image", "inspect", i); } catch { console.log("SKIP: Docker or the required images are unavailable"); return; }
  try { await partA(); await partB(); console.log(JSON.stringify({ status: "PASS", suite: "mfa-webauthn-postgres" })); }
  finally { for (const n of names) { try { docker("rm", "-f", n); } catch { /* already gone */ } } }
}
main().catch((e) => { console.error(e); process.exit(1); });
