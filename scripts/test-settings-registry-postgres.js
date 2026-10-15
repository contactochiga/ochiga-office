// Settings S3 persistence against real databases (disposable Docker containers only; never a real project):
//   A. plain Postgres 16: migration preserves rows, idempotent, atomic compare-and-set under true concurrency, append-only history, RLS, rollback preserves values
//   B. Supabase Postgres 17 + PostgREST + the real SupabaseLeadAgentsStore: deploy-order compatibility (code before migration), versioned writes, conflicts, concurrency across
//      two clients, history, and the Data API roles (anon/authenticated) being refused for the new table and functions.
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
const BASE = "20261014_office_runtime_settings.sql", MIG = "20261019_office_runtime_settings_versioning.sql", DOWN = "rollback/20261019_office_runtime_settings_versioning.down.sql";
const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLAIN_PORT = 54361, SB_PORT = 54362, REST_PORT = 54363, PROXY_PORT = 54364, SUF = process.pid;
const IMG_PLAIN = "postgres:16-alpine", IMG_PG = "public.ecr.aws/supabase/postgres:17.6.1.131", IMG_REST = "public.ecr.aws/supabase/postgrest:v14.12";
const JWT_SECRET = "test-jwt-secret-test-jwt-secret-1234567890";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (role) => { const h = b64({ alg: "HS256", typ: "JWT" }), p = b64({ role, iss: "supabase-test", exp: Math.floor(Date.now() / 1000) + 7200 }); return `${h}.${p}.${crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url")}`; };
const client = async (port, user = "postgres", password = "x") => { const c = new Client({ host: "127.0.0.1", port, user, password, database: "postgres" }); await c.connect(); return c; };
const waitClient = async (port, user, password) => { for (let i = 0; i < 90; i++) { try { return await client(port, user, password); } catch { await sleep(1000); } } throw new Error("database did not become ready"); };
const SNAP = "select key, value, updated_by, updated_at from office_runtime_settings order by key";
const snapHash = async (c) => crypto.createHash("sha256").update(JSON.stringify((await c.query(SNAP)).rows)).digest("hex");
const names = [];

async function partA() {
  const name = `ochiga-s3-plain-${SUF}`; names.push(name);
  docker("run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=x", "-p", `${PLAIN_PORT}:5432`, IMG_PLAIN);
  const admin = await waitClient(PLAIN_PORT);
  await admin.query(sql(BASE));
  await admin.query("insert into office_runtime_settings (key, value, updated_by, updated_at) values ('whatsapp_autonomous_responses_enabled', 'true'::jsonb, 'owner@ochiga.test', '2026-10-01T10:00:00Z'), ('whatsapp_webhook_signature_stats', '{\"counts\":{\"valid_raw\":3}}'::jsonb, 'webhook-signature-monitor', '2026-10-02T11:00:00Z')");
  const before = await snapHash(admin);

  // migration: additive, preserves every row, idempotent
  await admin.query(sql(MIG));
  assert.equal(await snapHash(admin), before, "existing keys, values, actors and timestamps are untouched by the migration");
  assert.deepEqual((await admin.query("select key, version from office_runtime_settings order by key")).rows.map((r) => r.version), [1, 1], "existing rows become version 1");
  await admin.query(sql(MIG));
  assert.equal(await snapHash(admin), before, "re-applying is idempotent");
  assert.deepEqual((await admin.query("select relname, relrowsecurity from pg_class where relname in ('office_runtime_settings','office_runtime_setting_history') order by relname")).rows, [{ relname: "office_runtime_setting_history", relrowsecurity: true }, { relname: "office_runtime_settings", relrowsecurity: true }], "RLS stays enabled on both tables");
  assert.equal(Number((await admin.query("select count(*) c from pg_policies where tablename in ('office_runtime_settings','office_runtime_setting_history')")).rows[0].c), 0, "no RLS policies: only service credentials reach the tables");
  console.log("A1. Migration preserves rows, sets version 1, idempotent, RLS on, no policies — PASS");

  const w = (c, ...a) => c.query("select office_runtime_setting_write($1,$2::jsonb,$3,$4,$5,$6,$7) as r", a).then((x) => x.rows[0].r);
  let r = await w(admin, "t.key", "5", "alice", 0, "req-1", false, true); assert.equal(r.status, "ok"); assert.equal(r.current.version, 1); assert.equal(r.previous, null);
  r = await w(admin, "t.key", "6", "bob", 0, "req-2", false, true); assert.equal(r.status, "conflict", "expected_version 0 but a row exists"); assert.equal(r.current.version, 1);
  r = await w(admin, "t.key", "7", "alice", 1, "req-3", false, true); assert.equal(r.status, "ok"); assert.equal(r.current.version, 2); assert.equal(r.previous.value, 5);
  r = await w(admin, "t.key", "8", "bob", 1, "req-4", false, true); assert.equal(r.status, "conflict"); assert.equal(r.current.value, 7, "conflict reports the stored value");
  r = await w(admin, "t.key", "9", "legacy", null, "req-5", false, true); assert.equal(r.status, "ok"); assert.equal(r.current.version, 3, "unconditional (legacy) writes still bump the version");
  r = await w(admin, "t.nohist", "1", "sys", null, null, false, false); assert.equal(r.status, "ok");
  r = await w(admin, "t.secret", "\"hunter2\"", "alice", 0, "req-6", true, true); assert.equal(r.status, "ok");
  r = await w(admin, "t.none", "1", "alice", 3, "req-7", false, true); assert.equal(r.status, "conflict"); assert.equal(r.current, null, "expected_version > 0 for a missing key conflicts");
  const hist = (await admin.query("select setting_key, version, previous_value, new_value, actor, request_id, outcome from office_runtime_setting_history order by created_at, version")).rows;
  assert.deepEqual(hist.filter((h) => h.setting_key === "t.key").map((h) => [h.version, h.outcome, h.actor, h.request_id]), [[1, "success", "alice", "req-1"], [1, "conflict", "bob", "req-2"], [2, "success", "alice", "req-3"], [2, "conflict", "bob", "req-4"], [3, "success", "legacy", "req-5"]], "every success and conflict is recorded with actor and request id");
  assert.equal(hist.filter((h) => h.setting_key === "t.nohist").length, 0, "p_history=false writes no history row");
  assert.equal(hist.find((h) => h.setting_key === "t.secret").new_value, "[redacted]", "redacted writes never put the value in history");
  assert.ok(!JSON.stringify(hist).includes("hunter2"), "secret value absent from history");
  await admin.query("select office_runtime_setting_record_attempt('t.key','carol','req-8','rejected','invalid_value','\"x\"'::jsonb,false)");
  assert.equal((await admin.query("select outcome, version from office_runtime_setting_history where request_id='req-8'")).rows[0].outcome, "rejected");
  console.log("A2. Atomic compare-and-set: create/update/conflict/legacy/redact/no-history and attempt records — PASS");

  // true concurrency: separate connections racing with the same expected version
  const racers = await Promise.all(Array.from({ length: 10 }, async () => client(PLAIN_PORT)));
  const cur = Number((await admin.query("select version from office_runtime_settings where key='t.key'")).rows[0].version);
  const results = await Promise.all(racers.map((c, i) => w(c, "t.key", String(100 + i), `racer${i}`, cur, `race-${i}`, false, true)));
  assert.equal(results.filter((x) => x.status === "ok").length, 1, "exactly one of 10 concurrent writers wins the same expected_version");
  assert.equal(Number((await admin.query("select version from office_runtime_settings where key='t.key'")).rows[0].version), cur + 1, "version advanced exactly once");
  const creators = await Promise.all(racers.map((c, i) => w(c, "t.created", String(i), `maker${i}`, 0, `mk-${i}`, false, true)));
  assert.equal(creators.filter((x) => x.status === "ok").length, 1, "exactly one of 10 concurrent creators wins (expected_version 0)");
  assert.equal(Number((await admin.query("select count(*) c from office_runtime_settings where key='t.created'")).rows[0].c), 1);
  await Promise.all(racers.map((c) => c.end()));
  console.log("A3. 10 concurrent writers and 10 concurrent creators on separate connections: one winner each — PASS");

  // append-only
  await assert.rejects(() => admin.query("update office_runtime_setting_history set actor='x'"), /append-only/, "history cannot be edited");
  await assert.rejects(() => admin.query("delete from office_runtime_setting_history"), /append-only/, "history cannot be deleted");
  console.log("A4. History is append-only (update and delete rejected) — PASS");

  // rollback keeps existing keys/values; re-apply works
  await admin.query("delete from office_runtime_settings where key like 't.%'").catch(() => null);
  const preRollbackRows = (await admin.query(SNAP)).rows.filter((r) => !r.key.startsWith("t."));
  await admin.query(sql(DOWN));
  const gone = (await admin.query("select (select count(*) from pg_class where relname='office_runtime_setting_history') h, (select count(*) from pg_proc where proname like 'office_runtime_setting%') f, (select count(*) from information_schema.columns where table_name='office_runtime_settings' and column_name='version') v")).rows[0];
  assert.deepEqual({ h: Number(gone.h), f: Number(gone.f), v: Number(gone.v) }, { h: 0, f: 0, v: 0 }, "rollback removes history, functions and the version column");
  assert.deepEqual((await admin.query(SNAP)).rows.filter((r) => !r.key.startsWith("t.")), preRollbackRows, "rollback leaves existing keys and values exactly as they were");
  await admin.query(sql(DOWN)); // idempotent
  await admin.query(sql(MIG)); assert.equal(Number((await admin.query("select count(*) c from office_runtime_settings where version = 1")).rows[0].c) >= 2, true, "migration re-applies cleanly after rollback");
  console.log("A5. Rollback removes S3 objects, keeps keys/values, is idempotent, and the migration re-applies — PASS");
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
  const pg = `ochiga-s3-sbpg-${SUF}`, pr = `ochiga-s3-rest-${SUF}`; names.push(pg, pr);
  docker("run", "-d", "--rm", "--name", pg, "-e", "POSTGRES_PASSWORD=testpw", "-p", `${SB_PORT}:5432`, IMG_PG);
  let admin = await waitClient(SB_PORT, "postgres", "testpw");
  await admin.end(); const sa = await waitClient(SB_PORT, "supabase_admin", "testpw"); await sa.query("alter role authenticator with password 'testpw'"); await sa.end(); admin = await client(SB_PORT, "postgres", "testpw");
  await admin.query(sql(BASE));
  // production state after the P0 hardening: the Data API roles hold nothing on this table
  await admin.query("revoke all on office_runtime_settings from anon, authenticated");
  await admin.query("insert into office_runtime_settings (key, value, updated_by) values ('whatsapp_autonomous_responses_enabled', 'false'::jsonb, 'owner@ochiga.test')");
  docker("run", "-d", "--rm", "--name", pr, "-p", `${REST_PORT}:3000`, "-e", `PGRST_DB_URI=postgres://authenticator:testpw@host.docker.internal:${SB_PORT}/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`, IMG_REST);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${REST_PORT}/`, { headers: { apikey: jwt("service_role") } })).status < 500) break; } catch { /* starting */ } await sleep(1000); }
  const proxy = await startProxy();
  const mkStore = () => new SupabaseLeadAgentsStore({ url: `http://127.0.0.1:${PROXY_PORT}`, serviceRoleKey: jwt("service_role"), requestTimeoutMs: 15000 });
  const s1 = mkStore(), s2 = mkStore();
  try {
    // B1: code deployed BEFORE the migration
    const legacy = await s1.setRuntimeSetting("whatsapp_autonomous_responses_enabled", true, "owner@ochiga.test", { requestId: "pre" });
    assert.equal(legacy.current.value, true, "autonomy keeps working before the migration (legacy path)"); assert.equal(legacy.previous.value, false);
    await assert.rejects(() => s1.writeRuntimeSetting("k", 1, "a", { expectedVersion: 0 }), (e) => e.code === "versioning_unavailable", "conditional writes fail loudly without the migration");
    assert.deepEqual(await s1.listRuntimeSettingHistory("k"), { supported: false, rows: [] }, "history reports unsupported, not empty-success");
    assert.equal(await s1.recordRuntimeSettingAttempt({ key: "k", actor: "a", requestId: "r", outcome: "rejected", reason: "x", attempted: 1 }), false);
    console.log("B1. Code before migration: autonomy write works, versioned writes refuse, history unsupported — PASS");

    // B2: apply the migration; the running store re-probes within a minute (simulated by clearing the timestamp)
    await admin.query(sql(MIG)); await admin.query("notify pgrst, 'reload schema'"); await sleep(2500);
    s1.runtimeVersioningCheckedAt = 0;
    const row = await s1.getRuntimeSetting("whatsapp_autonomous_responses_enabled"); assert.equal(row.version, 1); assert.equal(row.value, true, "existing value preserved through the migration");
    const w1 = await s1.writeRuntimeSetting("office.s3", { n: 1 }, "alice", { expectedVersion: 0, requestId: "req-a" });
    assert.equal(w1.status, "ok"); assert.equal(w1.current.version, 1); assert.deepEqual(w1.current.value, { n: 1 });
    const stale = await s2.writeRuntimeSetting("office.s3", { n: 2 }, "bob", { expectedVersion: 0, requestId: "req-b" }); assert.equal(stale.status, "conflict"); assert.deepEqual(stale.current.value, { n: 1 });
    const w2 = await s2.writeRuntimeSetting("office.s3", { n: 3 }, "bob", { expectedVersion: 1, requestId: "req-c" }); assert.equal(w2.status, "ok"); assert.equal(w2.current.version, 2);
    const legacy2 = await s1.setRuntimeSetting("whatsapp_autonomous_responses_enabled", false, "owner@ochiga.test", { requestId: "req-legacy" }); assert.equal(legacy2.current.version, 2, "the existing autonomy writer is now versioned"); assert.equal(legacy2.previous.value, true);
    const racers = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? s1 : s2).writeRuntimeSetting("office.s3", { n: 10 + i }, `r${i}`, { expectedVersion: 2, requestId: `race-${i}` })));
    assert.equal(racers.filter((x) => x.status === "ok").length, 1, "through PostgREST and two clients, one of 8 concurrent writers wins"); assert.equal((await s1.getRuntimeSetting("office.s3")).version, 3);
    await s1.recordRuntimeSettingAttempt({ key: "office.s3", actor: "carol", requestId: "req-d", outcome: "denied", reason: "forbidden", attempted: { n: 99 } });
    const h = await s2.listRuntimeSettingHistory("office.s3", { limit: 100 }); assert.equal(h.supported, true);
    const byReq = Object.fromEntries(h.rows.map((r) => [r.request_id, r])); assert.equal(byReq["req-a"].outcome, "success"); assert.equal(byReq["req-b"].outcome, "conflict"); assert.equal(byReq["req-d"].outcome, "denied"); assert.equal(byReq["req-c"].previous_value.n, 1);
    await s1.setRuntimeSetting("whatsapp_webhook_signature_stats", { counts: { x: 1 } }, "monitor", { history: false });
    assert.equal((await s1.listRuntimeSettingHistory("whatsapp_webhook_signature_stats")).rows.length, 0, "system counters write no history through PostgREST");
    console.log("B2. Migration applied under a running store: versioned writes, conflict, 8-way race across two clients, history, legacy writer — PASS");

    // B3: Data API roles are refused for the new table and functions, and nothing changes
    const state = async () => (await admin.query("select (select count(*) from office_runtime_setting_history) h, (select count(*) from office_runtime_settings) s, (select md5(string_agg(key || value::text || version, ',' order by key)) from office_runtime_settings) m")).rows[0];
    const before = await state();
    for (const role of ["anon", "authenticated"]) {
      for (const [m, p, b] of [["GET", "/office_runtime_setting_history?select=*", undefined], ["GET", "/office_runtime_settings?select=*", undefined], ["POST", "/rpc/office_runtime_setting_write", { p_key: "pwn", p_value: 1, p_actor: "x", p_expected_version: null, p_request_id: "x" }], ["POST", "/rpc/office_runtime_setting_record_attempt", { p_key: "pwn", p_actor: "x", p_request_id: "x", p_outcome: "success", p_reason: "x", p_attempted: 1 }], ["PATCH", "/office_runtime_settings?key=eq.office.s3", { value: 0 }], ["DELETE", "/office_runtime_setting_history?setting_key=eq.office.s3", undefined]]) {
        const r = await rest(role, m, p, b); assert.ok([401, 403, 404].includes(r.status), `${role} ${m} ${p} refused (got ${r.status})`); assert.ok(!r.text.includes("req-a"), `${role} reads no history`);
      }
    }
    assert.deepEqual(await state(), before, "refused Data API calls changed nothing");
    const priv = (await admin.query("select has_table_privilege('anon','office_runtime_setting_history','SELECT') a, has_table_privilege('authenticated','office_runtime_setting_history','SELECT') u, has_table_privilege('service_role','office_runtime_setting_history','SELECT') s, has_function_privilege('anon','office_runtime_setting_write(text,jsonb,text,integer,text,boolean,boolean)','EXECUTE') fa, has_function_privilege('authenticated','office_runtime_setting_write(text,jsonb,text,integer,text,boolean,boolean)','EXECUTE') fu, has_function_privilege('service_role','office_runtime_setting_write(text,jsonb,text,integer,text,boolean,boolean)','EXECUTE') fs")).rows[0];
    assert.deepEqual(priv, { a: false, u: false, s: true, fa: false, fu: false, fs: true }, "anon/authenticated hold nothing on the new table or functions; service_role does");
    for (const role of ["anon", "authenticated"]) { const c = await client(SB_PORT, "postgres", "testpw"); await c.query(`set role ${role}`); await assert.rejects(() => c.query("select * from office_runtime_setting_history"), (e) => e.code === "42501"); await assert.rejects(() => c.query("select office_runtime_setting_write('x','1'::jsonb,'a',null,'r')"), (e) => e.code === "42501"); await c.end(); }
    assert.equal((await admin.query("select relrowsecurity from pg_class where relname='office_runtime_setting_history'")).rows[0].relrowsecurity, true);
    assert.equal(Number((await admin.query("select count(*) c from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity")).rows[0].c), 0, "no public table without RLS");
    console.log("B3. anon/authenticated refused at REST and SQL level for table and functions; RLS everywhere; nothing changed — PASS");
  } finally { proxy.close(); await admin.end().catch(() => {}); }
}

async function main() {
  try { for (const i of [IMG_PLAIN, IMG_PG, IMG_REST]) docker("image", "inspect", i); } catch { console.log("SKIP: Docker or the required images are unavailable"); return; }
  try { await partA(); await partB(); console.log(JSON.stringify({ status: "PASS", suite: "settings-registry-postgres" })); }
  finally { for (const n of names) { try { docker("rm", "-f", n); } catch { /* already gone */ } } }
}
main().catch((e) => { console.error(e); process.exit(1); });
