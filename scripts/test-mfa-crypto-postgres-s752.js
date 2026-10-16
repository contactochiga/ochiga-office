// Settings S7.5.2 MFA cryptographic foundation against a real Supabase Postgres 17 + PostgREST + the real SupabaseLeadAgentsStore (disposable Docker containers only):
// application-encrypted TOTP secrets stored and read back through the Data API, replay protection by the S7.5.1 atomic function under concurrency across two clients,
// recovery-code hashes, controlled key rotation (compare-and-set through PostgREST), tamper detection of stored ciphertext, and redaction of every error. Skips (exit 0) without Docker.
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
const PLAIN_PORT = 54391, SB_PORT = 54392, REST_PORT = 54393, PROXY_PORT = 54394, SUF = process.pid;
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

const m = require("../src/lead-agents/mfa-crypto");
const randomB64 = (n) => crypto.randomBytes(n).toString("base64");
const SESSION = "s7-5-2-pg-session-secret-0123456789abcdef-xyz";
const K1 = randomB64(32), K2 = randomB64(32);
const cfgFor = (over = {}) => ({ mfaMode: "on", mfaKey: K1, mfaKeyId: "k1", mfaKeysPrevious: "", sessionSecret: SESSION, apiKeys: ["pg-api-key-0123456789"], ...over });

async function main() {
  try { for (const i of [IMG_PG, IMG_REST]) docker("image", "inspect", i); } catch { console.log("SKIP: Docker or the required images are unavailable"); return; }
  const pg = `ochiga-s752-sbpg-${SUF}`, pr = `ochiga-s752-rest-${SUF}`; names.push(pg, pr);
  let proxy;
  try {
    docker("run", "-d", "--rm", "--name", pg, "-e", "POSTGRES_PASSWORD=testpw", "-p", `${SB_PORT}:5432`, IMG_PG);
    let admin = await waitClient(SB_PORT, "postgres", "testpw");
    await admin.end(); const sa = await waitClient(SB_PORT, "supabase_admin", "testpw"); await sa.query("alter role authenticator with password 'testpw'"); await sa.end(); admin = await client(SB_PORT, "postgres", "testpw");
    await admin.query(TABLE); await admin.query("alter table admin_users enable row level security"); await admin.query("revoke all on admin_users from anon, authenticated"); await seed(admin); await admin.query(sql(MIG)); await admin.query(sql(MFA));
    docker("run", "-d", "--rm", "--name", pr, "-p", `${REST_PORT}:3000`, "-e", `PGRST_DB_URI=postgres://authenticator:testpw@host.docker.internal:${SB_PORT}/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`, "-e", "PGRST_DB_POOL=10", IMG_REST);
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${REST_PORT}/`, { headers: { apikey: jwt("service_role") } })).status < 500) break; } catch { /* starting */ } await sleep(1000); }
    await admin.query("notify pgrst, 'reload schema'"); await sleep(2000); proxy = await startProxy();
    const mkStore = () => new SupabaseLeadAgentsStore({ url: `http://127.0.0.1:${PROXY_PORT}`, serviceRoleKey: jwt("service_role"), requestTimeoutMs: 15000 });
    const s1 = mkStore(), s2 = mkStore(); const boss = (await admin.query("select id from admin_users where email='boss@ochiga.test'")).rows[0].id, staff = (await admin.query("select id from admin_users where email='staff@ochiga.test'")).rows[0].id;
    const mfa1 = m.createMfaCrypto(cfgFor()); const ring2 = m.createMfaCrypto(cfgFor({ mfaKey: K2, mfaKeyId: "k2", mfaKeysPrevious: `k1:${K1}` }));
    assert.equal(await s1.supportsMfa(), true);

    // C1: encrypt -> store -> read -> decrypt -> verify, with the credential id chosen by the application and bound into the authenticated metadata
    const id = crypto.randomUUID(); const secretBytes = m.generateTotpSecret(); const enc = mfa1.encryptTotpSecret(secretBytes, { userId: boss, credentialId: id });
    const created = await s1.createMfaCredential(boss, { id, type: "totp", label: "Phone", ...enc }); assert.equal(created.id, id, "the application-chosen id is stored");
    const row = (await admin.query("select secret_ciphertext c, secret_nonce n, secret_key_id k, id from admin_mfa_credentials where id=$1", [id])).rows[0]; assert.ok(row.c === enc.secret_ciphertext && !row.c.includes(secretBytes.toString("base64")) && !Buffer.from(row.c, "base64").subarray(0, 20).equals(secretBytes), "what the database holds is ciphertext, never the secret");
    assert.ok(!JSON.stringify((await admin.query("select * from admin_mfa_credentials")).rows).includes(m.base32Encode(secretBytes)), "the Base32 secret appears nowhere in the table");
    await s1.activateMfaCredential(boss, id); const now = Date.now(); const st = m.totpCounter(now); const code = (s) => m.hotp(secretBytes, s);
    const v1 = await mfa1.verifyAndConsumeTotp({ store: s1, userId: boss, credentialId: id, code: code(st), nowMs: now }); assert.ok(v1.ok && v1.step === st, "decrypts through the Data API and verifies the code");
    const again = await mfa1.verifyAndConsumeTotp({ store: s2, userId: boss, credentialId: id, code: code(st), nowMs: now }); assert.ok(!again.ok && again.reason === "replay", "the second client sees the consumed step: replay refused by the database, not by this module");
    assert.equal(Number((await admin.query("select totp_last_step s from admin_mfa_credentials where id=$1", [id])).rows[0].s), st, "the S7.5.1 replay counter is the only replay state");
    const burst = await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? mfa1 : ring2).verifyAndConsumeTotp({ store: i % 2 ? s1 : s2, userId: boss, credentialId: id, code: code(st + 1), nowMs: now + 30_000 })));
    assert.equal(burst.filter((r) => r.ok).length, 1, "24 simultaneous submissions of one code through PostgREST, two clients and two key rings: exactly one success"); assert.equal(burst.filter((r) => r.reason === "replay").length, 23);
    assert.equal((await mfa1.verifyAndConsumeTotp({ store: s1, userId: staff, credentialId: id, code: code(st + 2), nowMs: now + 60_000 })).ok, false, "another account cannot use it");
    console.log("C1. Application-encrypted secret: stored as ciphertext only, decrypted and verified through PostgREST, 24-way replay race has one winner, replay state is the S7.5.1 counter — PASS");

    // C2: tamper detection of the STORED ciphertext
    await admin.query("update admin_mfa_credentials set secret_ciphertext = $2 where id = $1", [id, Buffer.from(row.c, "base64").map((b, i) => (i === 4 ? b ^ 1 : b)).toString("base64")]);
    await assert.rejects(() => mfa1.verifyAndConsumeTotp({ store: s1, userId: boss, credentialId: id, code: code(st + 3), nowMs: now + 90_000 }), (e) => e.code === "mfa_decrypt_failed", "a modified stored ciphertext is detected (authenticated encryption): the login cannot succeed"); await admin.query("update admin_mfa_credentials set secret_ciphertext = $2 where id = $1", [id, row.c]);
    // a ciphertext copied to another credential row is useless (credential id is authenticated metadata)
    const id2 = crypto.randomUUID(); await admin.query("update admin_mfa_credentials set status='revoked' where id=$1", [id]); await s1.createMfaCredential(boss, { id: id2, type: "totp", label: "Copy", secret_ciphertext: row.c, secret_nonce: row.n, secret_key_id: row.k });
    await assert.rejects(() => mfa1.checkTotp({ store: s1, userId: boss, credentialId: id2, code: code(st + 4), nowMs: now + 120_000 }), (e) => e.code === "mfa_decrypt_failed", "ciphertext copied to a different credential id does not decrypt"); await s1.revokeMfaCredential(boss, id2, { actor: "t" }); await admin.query("update admin_mfa_credentials set status='active' where id=$1", [id]);
    console.log("C2. Tampered or transplanted stored ciphertext is rejected by the authenticated metadata — PASS");

    // C3: controlled rotation through PostgREST (compare-and-set), concurrent rotators, retiring the old key
    const staffId = crypto.randomUUID(); const sb = m.generateTotpSecret(); await s1.createMfaCredential(staff, { id: staffId, type: "totp", label: "Staff", ...mfa1.encryptTotpSecret(sb, { userId: staff, credentialId: staffId }) }); await s1.activateMfaCredential(staff, staffId);
    const listed = await s1.listMfaCredentialsNotUsingKey("k2", 100); assert.equal(listed.length, 2, "both live credentials still use k1"); assert.ok(!JSON.stringify(listed).match(/secret|ciphertext|nonce/), "the rotation listing returns ids only");
    const reports = await Promise.all([ring2.rotateCredentialSecrets({ store: s1 }), ring2.rotateCredentialSecrets({ store: s2 })]); assert.equal(reports.reduce((n, r) => n + r.rotated, 0), 2, "two concurrent rotation jobs through two clients: every credential rotated exactly once"); assert.ok(reports.every((r) => r.failed === 0 && Object.values(r).every(Number.isInteger)), "counts only");
    const rotated = await s1.getMfaCredentialSecret(boss, id); assert.equal(rotated.secret_key_id, "k2"); const retired = m.createMfaCrypto(cfgFor({ mfaKey: K2, mfaKeyId: "k2" })); assert.ok(retired.decryptTotpSecret(rotated, { userId: boss, credentialId: id }).equals(secretBytes), "after rotation the retired key is not needed");
    assert.equal(await s1.rotateMfaCredentialSecret(boss, id, { expected: { key_id: "k1", nonce: row.n }, next: { secret_ciphertext: "x".repeat(20), secret_nonce: "y".repeat(8), secret_key_id: "k3" } }), false, "a stale compare-and-set swaps nothing (through the Data API)");
    assert.equal((await retired.verifyAndConsumeTotp({ store: s1, userId: boss, credentialId: id, code: code(st + 5), nowMs: now + 150_000 })).ok, true, "verification keeps working across the rotation, replay counter intact"); assert.equal((await retired.verifyAndConsumeTotp({ store: s2, userId: boss, credentialId: id, code: code(st + 5), nowMs: now + 150_000 })).reason, "replay");
    console.log("C3. Rotation: concurrent jobs through PostgREST rotate each credential exactly once; stale swaps do nothing; the retired key is no longer needed; replay counter survives — PASS");

    // C4: recovery-code hashes against the real database
    const batch = ring2.newRecoveryBatch(boss); assert.equal(await s1.replaceMfaRecoveryCodes(boss, crypto.randomUUID(), batch.hmacs), 10); const stored = (await admin.query("select code_hmac h from admin_mfa_recovery_codes where admin_user_id=$1", [boss])).rows.map((r) => r.h);
    assert.ok(stored.every((h) => !batch.codes.some((c) => h.includes(c.replace("-", "")))) && new Set(stored).size === 10, "only keyed hashes are stored");
    const wins = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? ring2 : retired).verifyAndConsumeRecoveryCode({ store: i % 2 ? s1 : s2, userId: boss, code: batch.codes[0].toLowerCase() }))); assert.equal(wins.filter((r) => r.ok).length, 1, "20 simultaneous uses of one code through two clients: exactly one success");
    assert.equal((await ring2.verifyAndConsumeRecoveryCode({ store: s1, userId: staff, code: batch.codes[1] })).ok, false, "another account cannot use it"); assert.equal((await ring2.verifyAndConsumeRecoveryCode({ store: s1, userId: boss, code: batch.codes[1] })).ok, true);
    console.log("C4. Recovery codes: only keyed hashes stored; single use under a 20-way race; account-bound — PASS");

    // C5: redaction of everything thrown by the real store/crypto stack
    proxy.close(); await sleep(200); const seen = [];
    for (const fn of [() => mfa1.verifyAndConsumeTotp({ store: s1, userId: boss, credentialId: id, code: "123456" }), () => mfa1.verifyAndConsumeRecoveryCode({ store: s1, userId: boss, code: batch.codes[2] }), () => s1.createMfaCredential(boss, { type: "totp", label: "x", ...enc }), () => ring2.rotateCredentialSecrets({ store: s1 })]) { try { await fn(); assert.fail("must reject"); } catch (e) { if (e.code === "ERR_ASSERTION") throw e; seen.push(Object.getOwnPropertyNames(e).map((k) => String(e[k])).join("|") + String(e.stack)); } }
    const dump = seen.join(" "); for (const leak of [K1, K2, enc.secret_ciphertext, enc.secret_nonce, secretBytes.toString("base64"), m.base32Encode(secretBytes), batch.codes[0], batch.hmacs[0], jwt("service_role"), "127.0.0.1"]) assert.ok(!dump.includes(leak), "no key, ciphertext, nonce, secret, code, hash, service key or address in any error"); assert.ok(seen.every((e) => /mfa_store_unreachable/.test(e)), "a dead transport is a code-only failure, never a success");
    console.log("C5. With the database unreachable every operation fails closed with code-only errors that carry no secret material — PASS");
    console.log(JSON.stringify({ status: "PASS", suite: "mfa-crypto-postgres" }));
    await admin.end().catch(() => {});
  } finally { try { proxy && proxy.close(); } catch { /* closed */ } for (const n of names) { try { docker("rm", "-f", n); } catch { /* already gone */ } } }
}
main().catch((e) => { console.error(e); process.exit(1); });
