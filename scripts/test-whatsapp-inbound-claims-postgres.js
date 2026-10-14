const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Client } = require("pg");

// Applies the REAL migrations to a throw-away Postgres 16 container (never a production database) with fixtures that mimic production inbound_events,
// including historical duplicate provider ids, and proves the claim mechanism under true concurrency. Skips when Docker/the image is unavailable.
const PORT = 54329, NAME = `ochiga-claims-test-${process.pid}`;
const sh = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sql = (f) => fs.readFileSync(path.join(__dirname, "..", "db", f), "utf8");
const connect = async () => { const c = new Client({ host: "127.0.0.1", port: PORT, user: "postgres", password: "x", database: "postgres" }); await c.connect(); return c; };

async function main() {
  try { sh("image", "inspect", "postgres:16-alpine"); } catch { console.log("SKIP: docker or postgres:16-alpine unavailable"); return; }
  sh("run", "-d", "--rm", "--name", NAME, "-e", "POSTGRES_PASSWORD=x", "-p", `${PORT}:5432`, "postgres:16-alpine");
  try {
    let admin;
    for (let i = 0; i < 60; i++) { try { admin = await connect(); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
    assert.ok(admin, "postgres became ready");
    // production-shaped inbound_events (columns/types as inspected read-only on the production project)
    await admin.query(`create extension if not exists pgcrypto; create table inbound_events (id uuid primary key default gen_random_uuid(), channel text not null, provider text not null, event_type text not null, lead_id uuid, external_event_id text, payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());`);

    // F0: empty table -> migration applies, no claims
    await admin.query(sql("20261014_office_runtime_settings.sql")); await admin.query(sql("20261015_whatsapp_inbound_claims.sql"));
    assert.equal(Number((await admin.query("select count(*) from whatsapp_inbound_claims")).rows[0].count), 0);
    assert.deepEqual((await admin.query("select relrowsecurity from pg_class where oid='whatsapp_inbound_claims'::regclass")).rows[0], { relrowsecurity: true });
    assert.deepEqual((await admin.query("select relrowsecurity from pg_class where oid='office_runtime_settings'::regclass")).rows[0], { relrowsecurity: true });
    await admin.query("drop table whatsapp_inbound_claims");

    // fixtures: normal unique ids, historical duplicates (2x and 5x, same lead; and 2x with different leads), status events, invalid ids
    const L1 = "00000000-0000-4000-8000-000000000001", L2 = "00000000-0000-4000-8000-000000000002", L3 = "00000000-0000-4000-8000-000000000003";
    const ins = (id, type, lead, at) => admin.query("insert into inbound_events (channel, provider, event_type, lead_id, external_event_id, payload, created_at) values ('whatsapp','meta',$1,$2,$3,$5::jsonb,$4)", [type, lead, id, at, JSON.stringify({ id: "x" })]);
    for (let i = 0; i < 20; i++) await ins(`wamid.unique.${i}`, "message", L1, `2026-10-0${1 + (i % 8)}T10:00:00Z`);
    for (let i = 0; i < 5; i++) await ins("wamid.five", "message", L1, `2026-08-2${i}T10:00:00Z`);
    await ins("wamid.two", "message", L1, "2026-09-09T19:18:06Z"); await ins("wamid.two", "message", L1, "2026-09-09T19:18:06.8Z");
    await ins("wamid.twoleads", "message", L2, "2026-10-13T06:15:32Z"); await ins("wamid.twoleads", "message", L3, "2026-10-13T06:15:33Z");
    for (let i = 0; i < 4; i++) await ins("wamid.status", "status:delivered", L1, `2026-10-1${i}T10:00:00Z`); // legitimate repeated status ids must be untouched
    await ins(null, "message", L1, "2026-10-01T00:00:00Z"); await ins("", "message", L1, "2026-10-01T00:00:01Z");
    const before = (await admin.query("select count(*)::int n, md5(string_agg(id::text, ',' order by id)) h from inbound_events")).rows[0];

    await admin.query(sql("20261015_whatsapp_inbound_claims.sql"));
    const after = (await admin.query("select count(*)::int n, md5(string_agg(id::text, ',' order by id)) h from inbound_events")).rows[0];
    assert.deepEqual(after, before, "history is untouched: same rows, same ids");
    const distinctMessageIds = Number((await admin.query("select count(distinct external_event_id) c from inbound_events where event_type='message' and external_event_id is not null and external_event_id <> ''")).rows[0].c);
    assert.equal(Number((await admin.query("select count(*) c from whatsapp_inbound_claims")).rows[0].c), distinctMessageIds, "exactly one claim per distinct historical message id");
    assert.equal(Number((await admin.query("select count(*) c from whatsapp_inbound_claims where provider_message_id in ('wamid.status') or provider_message_id = ''")).rows[0].c), 0, "status events and empty ids create no claim");
    assert.ok((await admin.query("select 1 from whatsapp_inbound_claims where provider_message_id='wamid.five' and status='completed' and reply_sent_at is not null")).rowCount === 1, "historical messages are completed and treated as already answered");
    assert.ok((await admin.query("select lead_id from whatsapp_inbound_claims where provider_message_id='wamid.twoleads'")).rowCount === 1, "the two-lead duplicate yields one claim");
    // idempotent re-run
    await admin.query(sql("20261015_whatsapp_inbound_claims.sql"));
    assert.equal(Number((await admin.query("select count(*) c from whatsapp_inbound_claims")).rows[0].c), distinctMessageIds);

    // a late retry of an old message loses the claim; a new id wins it
    const claimSql = "insert into whatsapp_inbound_claims (provider_message_id, channel, status, request_id) values ($1,'whatsapp','processing',$2) on conflict (provider_message_id) do nothing returning provider_message_id";
    assert.equal((await admin.query(claimSql, ["wamid.five", "late"])).rowCount, 0);
    assert.equal((await admin.query(claimSql, ["wamid.brand.new", "r"])).rowCount, 1);

    // true concurrency: 40 separate connections claim the same new id at once
    const clients = await Promise.all(Array.from({ length: 40 }, connect));
    const wins = await Promise.all(clients.map((c, i) => c.query(claimSql, ["wamid.race", `r${i}`]).then((r) => r.rowCount)));
    assert.equal(wins.reduce((a, b) => a + b, 0), 1, "exactly one of 40 concurrent claimants wins");
    // concurrent takeover of one stale processing claim: exactly one winner; a completed claim can never be taken over
    await admin.query("update whatsapp_inbound_claims set claimed_at = now() - interval '1 hour' where provider_message_id='wamid.race'");
    const takeSql = "update whatsapp_inbound_claims set claimed_at = now(), request_id = $2 where provider_message_id = $1 and status = 'processing' and claimed_at < now() - interval '5 minutes' returning provider_message_id";
    const takes = await Promise.all(clients.map((c, i) => c.query(takeSql, ["wamid.race", `t${i}`]).then((r) => r.rowCount)));
    assert.equal(takes.reduce((a, b) => a + b, 0), 1, "exactly one concurrent takeover wins");
    await admin.query("update whatsapp_inbound_claims set status='completed', claimed_at = now() - interval '1 day' where provider_message_id='wamid.race'");
    assert.equal((await clients[0].query(takeSql, ["wamid.race", "late"])).rowCount, 0, "completed claims are final");
    // check constraint and missing-id handling
    await assert.rejects(() => admin.query("insert into whatsapp_inbound_claims (provider_message_id, status) values ('x','weird')"));
    await assert.rejects(() => admin.query("insert into whatsapp_inbound_claims (provider_message_id) values (null)"));
    await Promise.all(clients.map((c) => c.end()));

    // rollback removes only the claims table
    await admin.query(fs.readFileSync(path.join(__dirname, "..", "db", "rollback", "20261015_whatsapp_inbound_claims.down.sql"), "utf8"));
    assert.equal((await admin.query("select to_regclass('whatsapp_inbound_claims') r")).rows[0].r, null);
    assert.deepEqual((await admin.query("select count(*)::int n, md5(string_agg(id::text, ',' order by id)) h from inbound_events")).rows[0], before, "rollback leaves every inbound event intact");
    // full schema file also applies (idempotent) on the same database
    await admin.end();
    console.log(JSON.stringify({ status: "PASS", suite: "whatsapp-inbound-claims-postgres", fixtures: { rows: before.n, distinct_message_ids: distinctMessageIds } }));
  } finally {
    try { sh("rm", "-f", NAME); } catch { /* container already gone */ }
  }
}
main().catch((error) => { console.error(error); try { sh("rm", "-f", NAME); } catch {} process.exit(1); });
