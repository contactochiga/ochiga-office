// Settings S7.5.7 (MFA enforcement and administrator recovery) against real databases (disposable Docker containers only; never a real project): Supabase Postgres 17 + PostgREST + the real
// SupabaseLeadAgentsStore driving the REAL Office server, two instances. No migration is added by this slice: the test proves the governed setting (versioned compare-and-set), the sign-in gate,
// the administrator reset (atomic reset function), the once-per-id break-glass marker and the break-glass reset all work on the real schema, concurrently, and fail closed.
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
const PLAIN_PORT = 54441, SB_PORT = 54442, REST_PORT = 54443, PROXY_PORT = 54444, SUF = process.pid;
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
  const pg = `ochiga-s757-sbpg-${SUF}`, pr = `ochiga-s757-rest-${SUF}`; names.push(pg, pr);
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
    await admin.query(sql(WA)); await admin.query(sql("20261014_office_runtime_settings.sql")); await admin.query(sql("20261019_office_runtime_settings_versioning.sql")); await admin.query("notify pgrst, 'reload schema'"); await sleep(2500);
    const E = require("../src/lead-agents/mfa-enforcement"); const { runBreakGlass } = require("../src/lead-agents/server"); const { createAdminSessionToken } = require("../src/lead-agents/auth");
    const code = (secret, off = 0) => m.hotp(secret, m.totpCounter(Date.now()) + off); const KEY = "office_mfa_enforcement"; const DAY = 86_400_000;
    const mf = (app, p, o) => app.call("POST", `${A}/session/mfa${p}`, o);
    const resetStep = async (u) => { await admin.query("update admin_mfa_credentials set totp_last_step = 0 where admin_user_id=$1 and type='totp'", [u.id]); await sA.clearMfaFailures(u.id); };
    const enroll = async (app, u) => { const cookie = (await login(app, u)).cookie; const g = await stepUp(app, cookie, u); const b = await mf(app, "/enroll/totp/begin", { cookie, token: g, body: {} }); const secret = m.base32Decode(b.json.secret_base32); const c = await mf(app, "/enroll/totp/confirm", { cookie, token: g, body: { credential_id: b.json.credential_id, code: code(secret) } }); assert.equal(c.status, 200); return { secret, codes: c.json.recovery_codes }; };
    const signIn = async (app, u, secret) => { await resetStep(u); const l = await login(app, u); assert.equal(l.json.mfa_required, true); const v = await app.call("POST", `${A}/session/mfa/verify`, { body: { challenge_token: l.json.challenge_token, method: "totp", code: code(secret) } }); assert.equal(v.status, 200); return v.cookie; };
    const grant = async (app, cookie, u, purpose) => (await app.call("POST", `${A}/session/step-up`, { cookie, body: { password: u.pw, purpose } })).json?.step_up?.token;
    const get = (app, cookie) => app.call("GET", `${A}/settings/${KEY}`, { cookie });
    const put = async (app, cookie, u, value) => { const cur = (await get(app, cookie)).json.setting; return app.call("PUT", `${A}/settings/${KEY}`, { cookie, token: await grant(app, cookie, u, "security_policy_write"), body: { value, expected_version: cur.version, confirm: true } }); };
    const level = async () => (await admin.query("select value, version from office_runtime_settings where key=$1", [KEY])).rows[0];

    // B1: code on a database that has the settings migrations; enrolment of two administrators
    const boss = await mkUser("boss"); const bE = await enroll(appA, boss); const second = await mkUser("second"); const sE = await enroll(appB, second);
    let bossCookie = await signIn(appA, boss, bE.secret);
    const g0 = await get(appA, bossCookie); assert.ok(g0.status === 200 && g0.json.setting.value === "off" && g0.json.setting.version === 0, "default off at version 0 on the real schema");
    // B2: governed raise through PostgREST, preflight on the real schema
    config.officeEmailProvider = "resend"; config.resendApiKey = "re_test_not_real"; const realFetch = global.fetch; global.fetch = async (url, init) => String(url).startsWith("https://api.resend.com") ? new Response(JSON.stringify({ id: "m" }), { status: 200 }) : realFetch(url, init);
    let r = await put(appA, bossCookie, boss, "privileged"); assert.ok(r.status === 412 && r.json.failed_checks.includes("fleet_attested") && !r.json.failed_checks.includes("recovery_path"), `refused without fleet attestation; a second enrolled administrator satisfies the recovery path (${r.status} ${r.text.slice(0, 120)})`);
    assert.equal((await level()), undefined, "…and nothing was stored");
    config.mfaFleetAttested = E.ENFORCEMENT_RELEASE; E.invalidateEnforcementCache(config);
    r = await put(appA, bossCookie, boss, "privileged"); assert.ok(r.status === 200 && r.json.setting.value === "privileged" && r.json.setting.version === 1, `raise succeeds through PostgREST (${r.status} ${r.text.slice(0, 160)})`);
    assert.deepEqual([(await level()).value, Number((await level()).version)], ["privileged", 1], "stored with its version");
    assert.equal((await put(appB, bossCookie, boss, "privileged")).json.error, "enforcement_unchanged", "the second instance refuses the unchanged level");
    // two instances raise/lower at the same moment from the same version: one winner
    const gA = await grant(appA, bossCookie, boss, "security_policy_write"), gB = await grant(appB, bossCookie, boss, "security_policy_write"); const cur = (await get(appA, bossCookie)).json.setting.version;
    const both = await Promise.all([appA.call("PUT", `${A}/settings/${KEY}`, { cookie: bossCookie, token: gA, body: { value: "all", expected_version: cur, confirm: true } }), appB.call("PUT", `${A}/settings/${KEY}`, { cookie: bossCookie, token: gB, body: { value: "optional", expected_version: cur, confirm: true } })]);
    assert.deepEqual(both.map((x) => x.status).sort(), [200, 409], `two simultaneous changes from one version: one wins, one conflicts (${both.map((x) => x.status)})`); assert.equal(Number((await level()).version), cur + 1, "exactly one version step");
    const hist = (await admin.query("select version, outcome from office_runtime_setting_history where setting_key=$1 order by created_at", [KEY])).rows; assert.ok(hist.length >= 3, "history recorded");
    r = await put(appA, bossCookie, boss, "off"); assert.equal(r.status, 200, "lowering is immediate"); E.invalidateEnforcementCache(config);
    console.log("B1. Governed setting through two instances on the real schema: default, preflight refusal, raise, unchanged refusal, 409 on a simultaneous change, history — PASS");

    // B3: behaviour at sign-in against real data (level and account dates in the database)
    const staff = await mkUser("staffer"); await admin.query("update admin_users set role='ochiga_staff' where id=$1", [staff.id]);
    const setStored = async (value, daysAgo) => { await admin.query("insert into office_runtime_settings (key, value, updated_by, version) values ($1, to_jsonb($2::text), 'test', 1) on conflict (key) do update set value=to_jsonb($2::text), updated_at=now() - ($3 || ' days')::interval, version=office_runtime_settings.version+1", [KEY, value, String(daysAgo)]); await admin.query("update office_runtime_settings set updated_at = now() - ($2 || ' days')::interval where key=$1", [KEY, String(daysAgo)]); E.invalidateEnforcementCache(config); };
    await admin.query("update admin_users set created_at = now() - interval '400 days' where id = any($1)", [[staff.id, boss.id, second.id]]);
    await setStored("all", 3); { const l = await login(appA, staff); assert.ok(l.cookie && l.json.mfa_enrollment && l.json.mfa_enrollment.days_left >= 10, "inside grace: a session with a notice (level and dates read from the database)"); }
    const legacy = (await login(appB, staff)).cookie; await setStored("all", 15);
    { const l = await login(appA, staff); assert.ok(!l.cookie && l.json.mfa_enrollment_required === true && l.json.challenge_token, "after grace: no session, an enrolment challenge"); assert.equal((await appB.call("GET", `${A}/session/me`, { cookie: legacy })).status, 401, "the legacy session ends (second instance)"); }
    { const l = await login(appA, boss); assert.equal(l.json.mfa_required, true, "an enrolled administrator is still challenged"); }
    await setStored("off", 15); { const l = await login(appA, staff); assert.ok(l.cookie, "lowering is immediate"); }
    // revocation is never revived by a level change
    const revoked = (await login(appA, staff)).cookie; await admin.query("select * from office_revoke_admin_sessions($1::uuid,'test',null)", [staff.id]); for (const lv of ["all", "off", "privileged"]) { await setStored(lv, 20); assert.equal((await appA.call("GET", `${A}/session/me`, { cookie: revoked })).status, 401, `a revoked session stays dead at level ${lv}`); }
    // a database outage while reading the level fails closed
    proxy.close(); await sleep(300); E.invalidateEnforcementCache(config); { const l = await login(appA, staff); assert.ok(l.status >= 500 && !l.cookie && !/127\.0\.0\.1|ECONN|axios/i.test(l.text), `database away: sign-in fails closed with no detail (${l.status})`); } proxy = await startProxy(); await sleep(300); E.invalidateEnforcementCache(config);
    console.log("B2. Sign-in and session verification against real data: notice in grace, enrolment challenge after, enrolled still challenged, revocation not revived, outage fails closed — PASS");

    // B4: administrator MFA reset through the real atomic reset function
    await setStored("off", 1); bossCookie = await signIn(appA, boss, bE.secret); const tgt = await mkUser("target"); const tE = await enroll(appA, tgt); const tCookie = await signIn(appB, tgt, tE.secret);
    const tHash = (await admin.query("select password_hash h from admin_users where id=$1", [tgt.id])).rows[0].h;
    const doReset = async (app, cookie, tok, id, email) => app.call("POST", `${A}/users/${id}/mfa/reset`, { cookie, token: tok, body: { reason: "device lost, identity verified", confirm: true, confirm_email: email } });
    assert.equal((await doReset(appA, bossCookie, null, tgt.id, tgt.email)).status, 403, "no grant: refused"); assert.equal((await doReset(appA, bossCookie, await grant(appA, bossCookie, boss, "security_policy_write"), tgt.id, tgt.email)).status, 403, "wrong purpose: refused");
    const t1 = await grant(appA, bossCookie, boss, "mfa_management"), t2 = await grant(appB, bossCookie, boss, "mfa_management");
    const racedReset = await Promise.all([doReset(appA, bossCookie, t1, tgt.id, tgt.email), doReset(appB, bossCookie, t2, tgt.id, tgt.email)]); assert.ok(racedReset.every((x) => x.status === 200), "two simultaneous resets both complete idempotently");
    assert.equal((await appB.call("GET", `${A}/session/me`, { cookie: tCookie })).status, 401, "the target's session ended (second instance)");
    const row = (await admin.query("select password_hash h, mfa_required_after r, mfa_reset_by b, session_generation g from admin_users where id=$1", [tgt.id])).rows[0]; assert.ok(row.h === tHash && row.r && row.b === boss.email, "password untouched; re-enrolment required; reset attributed");
    assert.deepEqual((await admin.query("select (select count(*) from admin_mfa_credentials where admin_user_id=$1 and status='active') c, (select count(*) from admin_mfa_recovery_codes where admin_user_id=$1 and used_at is null) r", [tgt.id])).rows[0], { c: "0", r: "0" }, "no active factor, no recovery codes");
    { const l = await login(appA, tgt); assert.ok(l.json.mfa_enrollment_required === true && !l.cookie, "the target is routed to re-enrolment"); }
    const guardCookie = bossCookie; await admin.query("update admin_users set status='inactive' where id=$1", [second.id]); const lone = await mkUser("lone"); await enroll(appA, lone); await admin.query("update admin_users set status='inactive' where id=$1", [lone.id]); await admin.query("update admin_users set status='active' where id=$1", [lone.id]);
    await admin.query("update admin_users set status='active' where id=$1", [second.id]);
    assert.equal((await doReset(appA, guardCookie, await grant(appA, guardCookie, boss, "mfa_management"), boss.id, boss.email)).json.error, "use_self_service", "self-reset refused");
    console.log("B3. Administrator reset on the real schema: grant and purpose enforced, atomic reset visible to both instances, password untouched, re-enrolment required, self refused — PASS");

    // B5: break-glass on the real schema (once per id, race across two starts, marker in the real runtime-settings table)
    const bg = await mkUser("glass"); const bgE = await enroll(appA, bg); const bgHash = (await admin.query("select password_hash h from admin_users where id=$1", [bg.id])).rows[0].h;
    const bgCfg = { ...config, mfaRecovery: true, mfaRecoveryEmail: bg.email, mfaRecoveryId: "TICKET-PG-1" };
    const startRace = await Promise.all([runBreakGlass(sA, { ...bgCfg }), runBreakGlass(sB, { ...bgCfg })]); assert.equal(startRace.filter((x) => x === "applied").length, 1, `two instances starting together: exactly one applies (${startRace})`);
    assert.equal((await admin.query("select password_hash h from admin_users where id=$1", [bg.id])).rows[0].h, bgHash, "the password is preserved"); assert.equal((await admin.query("select count(*) c from admin_mfa_credentials where admin_user_id=$1 and status='active'", [bg.id])).rows[0].c, "0", "factors cleared");
    assert.deepEqual((await admin.query("select value->'ids' i from office_runtime_settings where key='office_mfa_recovery_state'")).rows[0].i, ["TICKET-PG-1"], "the once-per-id marker is stored");
    await admin.query("update admin_users set mfa_required_after = null where id=$1", [bg.id]); await enroll(appA, bg); assert.equal(await runBreakGlass(sA, { ...bgCfg }), "already_applied", "a restart with the same id changes nothing"); assert.equal((await admin.query("select count(*) c from admin_mfa_credentials where admin_user_id=$1 and status='active'", [bg.id])).rows[0].c, "1", "…the re-enrolled factor survives");
    assert.equal(await runBreakGlass(sA, { ...bgCfg, mfaRecoveryId: "TICKET-PG-2" }), "applied", "a new id applies again");
    assert.ok(/applied/.test(JSON.stringify((await admin.query("select action, metadata from audit_events where action in ('mfa_recovery_applied','mfa_reset_by_admin')")).rows)), "audited");
    console.log("B4. Break-glass on the real schema: one winner across two instances, password preserved, marker stored, restart idempotent, new id applies — PASS");

    // B6: redaction
    const audit = JSON.stringify((await admin.query("select action, metadata from audit_events")).rows); const stored = JSON.stringify((await admin.query("select secret_ciphertext, code_hmac from admin_mfa_credentials full join admin_mfa_recovery_codes on false")).rows);
    for (const secret of [K1, SESSION, bE.secret.toString("base64"), m.base32Encode(bE.secret), ...bE.codes, ...bgE.codes, tHash, bgHash]) assert.ok(!audit.includes(secret) && !stored.includes(secret), "no key, secret, code or hash in the audit table or stored columns");
    console.log("B5. Nothing secret in audit or storage — PASS");
    global.fetch = realFetch;
  } finally { await appA.close(); await appB.close(); try { proxy.close(); } catch { /* closed */ } await admin.end().catch(() => {}); }
}

async function main() {
  try { for (const i of [IMG_PLAIN, IMG_PG, IMG_REST]) docker("image", "inspect", i); } catch { console.log("SKIP: Docker or the required images are unavailable"); return; }
  try { await partB(); console.log(JSON.stringify({ status: "PASS", suite: "mfa-enforcement-postgres" })); }
  finally { for (const n of names) { try { docker("rm", "-f", n); } catch { /* already gone */ } } }
}
main().catch((e) => { console.error(e); process.exit(1); });
