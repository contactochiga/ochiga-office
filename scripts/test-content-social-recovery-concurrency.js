"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const net = require("node:net");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const freePort = () => new Promise((resolve) => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }); });

async function main() {
  const image = process.env.PG_IMAGE || "postgres:16-alpine";
  try { docker("image", "inspect", image); } catch { throw new Error(`BLOCKED: Docker image ${image} is unavailable`); }
  const name = `office-content-social-recovery-${process.pid}`;
  const port = await freePort();
  docker("run", "--rm", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=fixture", "-p", `127.0.0.1:${port}:5432`, image);
  const clients = [];
  try {
    const connect = async () => {
      const client = new Client({ host: "127.0.0.1", port, user: "postgres", password: "fixture", database: "postgres", connectionTimeoutMillis: 3000 });
      await client.connect(); clients.push(client); return client;
    };
    let admin;
    for (let i = 0; !admin && i < 40; i++) {
      try { admin = await connect(); } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert.ok(admin, "disposable PostgreSQL is ready");
    await admin.query(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.office_content_items(id text primary key,title text not null);
      create table public.office_social_posts(id uuid primary key default gen_random_uuid(),channel text not null,asset_id text not null,
        provider_post_id text not null,content_item_id text references public.office_content_items(id),origin text not null default 'external',
        caption text,permalink_url text,media_type text,published_at timestamptz,sync_status text not null default 'not_synced',synced_at timestamptz,
        unique(channel,asset_id,provider_post_id));
      create table public.office_social_comments(id uuid primary key default gen_random_uuid(),post_id uuid not null references public.office_social_posts(id),
        channel text not null,asset_id text not null,provider_comment_id text not null,deleted_at timestamptz,author_is_page boolean not null default false);
      grant select,insert,update,delete on public.office_content_items,public.office_social_posts,public.office_social_comments to service_role;`);
    await admin.query(readFileSync(path.join(__dirname, "../db/20261119_content_social_management.sql"), "utf8"));
    const a = await connect(); const b = await connect();
    await Promise.all([a.query("set role service_role"), b.query("set role service_role")]);
    await admin.query("insert into public.office_content_items(id,title) values('race','Race fixture')");
    const startScheduled = async (requestId, contentId = "race") => (await a.query(`select public.office_start_social_publish($1,'facebook','910000000000001',$2,$3,'staff','staff@example.test',now()+interval '1 minute') as row`, [contentId,"a".repeat(64),requestId])).rows[0].row;
    const claim = async () => (await a.query("select * from public.office_claim_due_social_publishes(now()+interval '2 minutes',10)")).rows[0];
    const staleCutoff = new Date(Date.now() - 5 * 60_000).toISOString();

    const activeStart = await startScheduled("active_claim_12345678");
    const active = await claim();
    assert.equal((await a.query("select count(*)::int as n from public.office_recover_stale_social_publishes(now()-interval '1 minute',100)")).rows[0].n, 0);
    assert.equal(active.status, "publishing");

    const expired = await startScheduled("expired_claim_123456");
    const expiredRow = await claim();
    await admin.query("update public.office_social_publish_attempts set dispatched_at=now()-interval '10 minutes' where id=$1", [expired.id]);
    await a.query("begin");
    const recoveryA = a.query("select id,status,failure_code from public.office_recover_stale_social_publishes($1,100)", [staleCutoff]);
    const resultA = await recoveryA;
    assert.equal(resultA.rows.length, 1); assert.equal(resultA.rows[0].id, expired.id); assert.equal(resultA.rows[0].status, "failed");
    const resultB = await b.query("select id from public.office_recover_stale_social_publishes($1,100)", [staleCutoff]);
    assert.equal(resultB.rows.length, 0, "a competing worker skips the row locked by the first recovery");
    await a.query("commit");
    assert.equal((await admin.query("select count(*)::int as n from public.office_social_publish_events where publish_attempt_id=$1 and event_type='stale_pre_dispatch_failed'", [expired.id])).rows[0].n, 1);

    const uncertainStart = await startScheduled("uncertain_claim_12345");
    const uncertainClaim = await claim();
    await a.query("select public.office_mark_social_publish_dispatch($1,$2,'staff','staff@example.test')", [uncertainStart.id, uncertainClaim.dispatch_token]);
    await admin.query("update public.office_social_publish_attempts set dispatched_at=now()-interval '10 minutes',provider_dispatch_started_at=now()-interval '10 minutes' where id=$1", [uncertainStart.id]);
    const unknown = await b.query("select id,status,failure_code from public.office_recover_stale_social_publishes($1,100)", [staleCutoff]);
    assert.equal(unknown.rows[0].status, "unknown"); assert.equal(unknown.rows[0].failure_code, "stale_dispatch_unknown");
    const duplicate = (await a.query(`select public.office_start_social_publish('race','facebook','910000000000001',$1,'automatic_retry_123456','staff','staff@example.test',null) as row`, ["a".repeat(64)])).rows[0].row;
    assert.equal(duplicate.status, "unknown"); assert.equal(duplicate.duplicate, true, "expired uncertainty never automatically dispatches again");

    await admin.query("insert into public.office_content_items(id,title) values('race-complete','Completion fixture')");
    const completedStart = await startScheduled("completed_claim_123456", "race-complete");
    const completedClaim = await claim();
    await a.query("select public.office_mark_social_publish_dispatch($1,$2,'staff','staff@example.test')", [completedStart.id, completedClaim.dispatch_token]);
    await a.query("select public.office_settle_social_publish($1,$2,'published','verified-post',null,'https://www.facebook.com/page/posts/verified',null)", [completedStart.id, completedClaim.dispatch_token]);
    await admin.query("update public.office_social_publish_attempts set dispatched_at=now()-interval '10 minutes',provider_dispatch_started_at=now()-interval '10 minutes' where id=$1", [completedStart.id]);
    const terminal = await b.query("select id from public.office_recover_stale_social_publishes($1,100)", [staleCutoff]);
    assert.equal(terminal.rows.some((row) => row.id === completedStart.id), false, "provider-confirmed success stays terminal through recovery");
    console.log("Content social recovery: two-connection SKIP LOCKED, active/pre-dispatch/UNKNOWN/terminal cases PASS");
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()));
    docker("rm", "-f", name);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
