const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const net = require("node:net");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sql = (name) => readFileSync(path.join(__dirname, "../db", name + ".sql"), "utf8");
const PG_IMAGE = process.env.PG_IMAGE || "postgres:16-alpine";
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function main() {
  // A missing prerequisite fails the suite (and its parent npm script); it never passes by skipping.
  try { docker("image", "inspect", PG_IMAGE); }
  catch { throw new Error(`BLOCKED: Docker or the image ${PG_IMAGE} is unavailable`); }
  const name = "office-social-test-" + process.pid;
  // An explicit loopback port (as the other Docker suites use) works with every Docker setup, including host networking.
  const port = await freePort();
  docker("run", "--rm", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=fixture", "-p", `127.0.0.1:${port}:5432`, PG_IMAGE);
  const clients = [];
  try {
    const connect = async () => {
      const client = new Client({ host: "127.0.0.1", port, user: "postgres", password: "fixture", database: "postgres", statement_timeout: 10_000, connectionTimeoutMillis: 3_000 });
      try { await client.connect(); } catch (error) { await client.end(); throw error; }
      clients.push(client);
      return client;
    };
    let admin;
    for (let i = 0; !admin && i < 40; i++) {
      try { admin = await connect(); } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert.ok(admin, "disposable database ready");
    await admin.query(`create role anon; create role authenticated; create role service_role bypassrls;
      create table leads (id uuid primary key default gen_random_uuid(), name text, source text, source_channel text,
        primary_channel text, status text, idempotency_key text unique, last_contact_at timestamptz, channel_last_seen_at timestamptz, contactability_status text);
      create table conversations (id uuid primary key default gen_random_uuid(), lead_id uuid references leads(id), agent_name text,
        message_role text, channel text, content text, created_at timestamptz);
      create table lead_channel_states (lead_id uuid references leads(id), channel text, ai_paused boolean, last_inbound_at timestamptz, unique (lead_id, channel));
      grant select, insert, update on leads, conversations, lead_channel_states to service_role;`);
    for (const name of ["20261017_whatsapp_manual_sends",
      "20261113_meta_social_inbound", "20261113_meta_social_staff_replies", "20261113_meta_social_dispatch_fence"]) await admin.query(sql(name));
    const a = await connect();
    const b = await connect();
    await admin.query("grant select, insert, update on whatsapp_manual_sends to service_role");
    await a.query("set role service_role");
    await b.query("set role service_role");
    const binding = "111:333";
    const lead = (await admin.query("insert into leads (source) values ('facebook') returning id")).rows[0].id;
    for (const [i, receiptFirst] of [true, false].entries()) {
      const mid = "fixture-mid-" + i;
      const { id } = (await admin.query(`insert into whatsapp_manual_sends
        (lead_id,channel,recipient,status,actor_email,client_request_id,body,body_hash,social_dispatch_at)
        values ($1,'facebook',$2,'outcome_unknown','fixture', $3,'text','hash',now()) returning id`, [lead, binding, mid])).rows[0];
      const receipt = (db) => db.query("select office_record_meta_social_receipt('facebook',$1,$2,'delivered') as ok", [binding, mid]);
      const accept = (db) => db.query("select office_accept_meta_social_send($1,'facebook',$2,$3,200) as ok", [id, binding, mid]);
      await a.query("begin");
      assert.equal((await (receiptFirst ? receipt(a) : accept(a))).rows[0].ok, true);
      const competing = (receiptFirst ? accept(b) : receipt(b));
      const bPid = b.processID;
      let waiting = false;
      for (let tries = 0; !waiting && tries < 30; tries++) {
        waiting = (await admin.query("select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid=$1", [bPid])).rows[0]?.waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true, "competing connection actually waits on the receipt/acceptance lock");
      await a.query("commit");
      assert.equal((await competing).rows[0].ok, true);
      assert.deepEqual((await admin.query("select status,provider_message_id,social_delivery_state from whatsapp_manual_sends where id=$1", [id])).rows[0],
        { status: "provider_accepted", provider_message_id: mid, social_delivery_state: "delivered" });
      assert.equal((await admin.query("select count(*)::int as count from office_meta_social_pending_receipts")).rows[0].count, 0);
    }
    console.log("Meta social receipt/acceptance concurrency (two Postgres connections): PASS");
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()));
    docker("rm", "-f", name);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
