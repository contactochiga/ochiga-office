// Settings S7.5.6 (MFA-protected step-up) against real databases (disposable Docker containers only; never a real project): Supabase Postgres 17 + PostgREST + the real SupabaseLeadAgentsStore driving
// the REAL Office server. No schema change in this slice: the test proves the existing atomic TOTP-step and WebAuthn counter functions protect the step-up path across two server instances.
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
const PLAIN_PORT = 54431, SB_PORT = 54432, REST_PORT = 54433, PROXY_PORT = 54434, SUF = process.pid;
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


async function partB() {
  const pg = `ochiga-s756-sbpg-${SUF}`, pr = `ochiga-s756-rest-${SUF}`; names.push(pg, pr);
  docker("run", "-d", "--rm", "--name", pg, "-e", "POSTGRES_PASSWORD=testpw", "-p", `${SB_PORT}:5432`, IMG_PG);
  let admin = await waitClient(SB_PORT, "postgres", "testpw");
  await admin.end(); const sa = await waitClient(SB_PORT, "supabase_admin", "testpw"); await sa.query("alter role authenticator with password 'testpw'"); await sa.end(); admin = await client(SB_PORT, "postgres", "testpw");
  await admin.query(TABLE); await admin.query("alter table admin_users add column if not exists last_login_at timestamptz, add column if not exists office_position text, add column if not exists phone text, add column if not exists passport_photo_url text, add column if not exists qr_credential text");
  await admin.query("create table if not exists audit_events (id uuid primary key default gen_random_uuid(), actor_user_id uuid references admin_users(id) on delete set null, actor_email text, actor_role text, action text not null, target_type text not null, target_id text, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now())");
  for (const t of ["admin_users", "audit_events"]) await admin.query(`alter table ${t} enable row level security`); await admin.query("revoke all on admin_users, audit_events from anon, authenticated"); await admin.query(sql(MIG)); await admin.query(sql(MFA)); await admin.query(sql(KEYID)); await admin.query(sql(MGMT));
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
    await admin.query(sql(WA)); await admin.query("notify pgrst, 'reload schema'"); await sleep(2500);
    const code = (secret, off = 0) => m.hotp(secret, m.totpCounter(Date.now()) + off); const lib = m.createMfaCrypto(config);
    const mf = (app, p, o) => app.call("POST", `${A}/session/mfa${p}`, o);
    const enroll = async (app, u) => { const cookie = (await login(app, u)).cookie; const g = await stepUp(app, cookie, u); const b = await mf(app, "/enroll/totp/begin", { cookie, token: g, body: {} }); const secret = m.base32Decode(b.json.secret_base32); const c = await mf(app, "/enroll/totp/confirm", { cookie, token: g, body: { credential_id: b.json.credential_id, code: code(secret) } }); assert.equal(c.status, 200); return { secret }; };
    const resetStep = (u) => admin.query("update admin_mfa_credentials set totp_last_step = 0 where admin_user_id=$1 and type='totp'", [u.id]);
    const su = (app, cookie, u, purpose, mfa, password) => app.call("POST", `${A}/session/step-up`, { cookie, body: { password: password ?? u.pw, purpose, ...(mfa ? { mfa } : {}) } });
    const signIn = async (app, u, secret) => { await resetStep(u); await sA.clearMfaFailures(u.id); const l = await login(app, u); const v = await app.call("POST", `${A}/session/mfa/verify`, { body: { challenge_token: l.json.challenge_token, method: "totp", code: code(secret) } }); assert.equal(v.status, 200); return v.cookie; };
    const staleCookie = async (u, ageMs) => { const fresh = (await admin.query("select * from admin_users where id=$1", [u.id])).rows[0]; const { createAdminSessionToken } = require("../src/lead-agents/auth"); const name = (await login(appA, await mkUser(`probe${Math.random().toString(36).slice(2, 7)}`))).cookie.split("=")[0]; return `${name}=${encodeURIComponent(createAdminSessionToken({ ...fresh }, config, 3_600_000, { mfaAt: Date.now() - ageMs }))}`; };

    // B1: password-only enrolment, then every purpose needs the factor
    const boss = await mkUser("boss"); const e = await enroll(appA, boss);
    const open = await signIn(appA, boss, e.secret);
    for (const purpose of ["security_policy_write", "session_revocation", "mfa_management"]) { const r = await su(appB, open, boss, purpose); assert.ok(r.status === 200 && r.json.step_up.second_factor === "session_proof", `${purpose}: password + fresh sign-in proof (through a second instance, real database)`); }
    const stale = await staleCookie(boss, 10 * 60_000); assert.equal((await appA.call("GET", `${A}/users`, { cookie: stale })).status, 200);
    assert.equal((await su(appA, stale, boss, "security_policy_write")).status, 401, "stale proof + password only: refused");
    await resetStep(boss); await sA.clearMfaFailures(boss.id);
    const good = await su(appA, stale, boss, "security_policy_write", { method: "totp", code: code(e.secret) }); assert.ok(good.status === 200 && good.json.step_up.second_factor === "totp", "password + TOTP over PostgREST");
    assert.equal((await su(appB, stale, boss, "security_policy_write", { method: "totp", code: code(e.secret) })).status, 401, "the same code through the OTHER instance: replay refused by the database compare-and-set");
    assert.equal((await appB.call("POST", `${A}/session/step-up/check`, { cookie: stale, token: good.json.step_up.token, body: { purpose: "security_policy_write" } })).status, 200, "the grant verifies on the other instance");
    console.log("B1. Password + fresh factor for each purpose through two instances; TOTP replay refused across instances by the database — PASS");

    // B2: 12 simultaneous step-ups with ONE code across two instances: exactly one grant
    await resetStep(boss); await sA.clearMfaFailures(boss.id); const one = code(e.secret);
    const race = await Promise.all(Array.from({ length: 12 }, (_, i) => su(i % 2 ? appA : appB, stale, boss, "session_revocation", { method: "totp", code: one })));
    assert.equal(race.filter((r) => r.status === 200).length, 1, `12 simultaneous step-ups with one TOTP code: exactly one grant (${race.map((r) => r.status).join(",")})`);
    await sA.clearMfaFailures(boss.id);
    console.log("B2. Concurrent step-up with one code across two instances: exactly one grant — PASS");

    // B3: WebAuthn second factor, replay and counter against the real database
    const wu = await mkUser("webauthn"); const wc = (await login(appA, wu)).cookie; const authn = newAuth(appA); const reg = await register(appA, wc, wu, authn); assert.equal(reg.v.status, 200);
    const wStale = await staleCookie(wu, 10 * 60_000);
    const opt = async () => (await wa(appA, "/step-up-options", { cookie: wStale, body: {} })).json;
    let o = await opt(); const first = authn.getAssertion(o.options); const w1 = await su(appA, wStale, wu, "mfa_management", { method: "webauthn", challenge_id: o.challenge_id, response: first }); assert.ok(w1.status === 200 && w1.json.step_up.second_factor === "webauthn", "password + WebAuthn over PostgREST");
    assert.equal((await su(appB, wStale, wu, "mfa_management", { method: "webauthn", challenge_id: o.challenge_id, response: first })).status, 401, "replayed assertion refused (single-use challenge in the database)");
    await sA.clearMfaFailures(wu.id); o = await opt(); const count = Number((await admin.query("select webauthn_sign_count s from admin_mfa_credentials where admin_user_id=$1", [wu.id])).rows[0].s);
    assert.equal((await su(appA, wStale, wu, "mfa_management", { method: "webauthn", challenge_id: o.challenge_id, response: authn.getAssertion(o.options, { useCounter: 1 }) })).status, 401, "counter rollback refused"); assert.equal(Number((await admin.query("select webauthn_sign_count s from admin_mfa_credentials where admin_user_id=$1", [wu.id])).rows[0].s), count, "stored counter unchanged");
    await sA.clearMfaFailures(wu.id);
    console.log("B3. WebAuthn step-up over the real database: assertion accepted, replay and counter rollback refused — PASS");

    // B4: recovery code is not a step-up factor; outage fails closed; redaction
    const rc = lib.newRecoveryBatch(boss.id); await sA.replaceMfaRecoveryCodes(boss.id, crypto.randomUUID(), rc.hmacs, { keyId: rc.key_id });
    await sA.clearMfaFailures(boss.id); assert.equal((await su(appA, stale, boss, "security_policy_write", { method: "recovery_code", code: rc.codes[0] })).status, 401, "a recovery code is refused as a step-up factor"); assert.equal(Number((await admin.query("select count(*) c from admin_mfa_recovery_codes where admin_user_id=$1 and used_at is not null", [boss.id])).rows[0].c), 0, "…and it was not consumed");
    const before = (await admin.query("select (select count(*) from admin_mfa_credentials) c, (select md5(string_agg(id::text || coalesce(totp_last_step,0)::text, ',' order by id)) from admin_mfa_credentials) m")).rows[0];
    proxy.close(); await sleep(300); const down = await su(appA, stale, boss, "security_policy_write", { method: "totp", code: code(e.secret, 1) }); assert.ok(down.status >= 401 && !(down.json && down.json.step_up) && !/127\.0\.0\.1|ECONN|axios/i.test(down.text), `database away: no grant, no detail (${down.status})`);
    proxy = await startProxy(); await sleep(300); assert.deepEqual((await admin.query("select (select count(*) from admin_mfa_credentials) c, (select md5(string_agg(id::text || coalesce(totp_last_step,0)::text, ',' order by id)) from admin_mfa_credentials) m")).rows[0], before, "nothing changed while it was down");
    const audit = JSON.stringify((await admin.query("select action, metadata from audit_events")).rows); const stored = JSON.stringify((await admin.query("select secret_ciphertext, code_hmac from admin_mfa_credentials full join admin_mfa_recovery_codes on false")).rows);
    for (const secret of [K1, SESSION, e.secret, ...rc.codes, good.json.step_up.token, good.json.step_up.token.split(".")[1]]) assert.ok(!audit.includes(secret) && !stored.includes(secret), "no key, secret, code or grant in the audit table or stored columns");
    assert.ok(audit.includes('"second_factor":"totp"') && audit.includes('"second_factor":"webauthn"') && audit.includes('"second_factor":"session_proof"'), "step-up audit records the factor kind");
    console.log("B4. Recovery code refused (and not consumed); outage fails closed with no change; nothing secret in audit or storage — PASS");
  } finally { await appA.close(); await appB.close(); try { proxy.close(); } catch { /* closed */ } await admin.end().catch(() => {}); }
}

async function main() {
  try { for (const i of [IMG_PLAIN, IMG_PG, IMG_REST]) docker("image", "inspect", i); } catch { console.log("SKIP: Docker or the required images are unavailable"); return; }
  try { await partB(); console.log(JSON.stringify({ status: "PASS", suite: "mfa-stepup-postgres" })); }
  finally { for (const n of names) { try { docker("rm", "-f", n); } catch { /* already gone */ } } }
}
main().catch((e) => { console.error(e); process.exit(1); });
