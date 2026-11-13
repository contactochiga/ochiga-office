const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { SupabaseLeadAgentsStore } = require("../src/lead-agents/store-supabase");

async function main() {
  const db = new PGlite();
  try {
    // Isolated in-memory schema fixture; no connection to any deployed database.
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table leads (id uuid primary key default gen_random_uuid(), name text, source text, source_channel text,
        primary_channel text, status text, idempotency_key text, last_contact_at timestamptz, channel_last_seen_at timestamptz);
      create unique index leads_idempotency_key_idx on leads (idempotency_key) where idempotency_key is not null;
      create table conversations (id uuid primary key default gen_random_uuid(), lead_id uuid references leads(id), agent_name text,
        message_role text, channel text, content text check (content <> 'force rollback'), correlation_id text, created_at timestamptz);
      create unique index conversations_correlation_id_uidx on conversations (correlation_id) where correlation_id is not null;
      create table lead_channel_states (lead_id uuid references leads(id), channel text, ai_paused boolean, last_inbound_at timestamptz, unique (lead_id, channel));
      grant select, insert, update on leads, conversations, lead_channel_states to service_role;
    `);
    await db.exec(readFileSync(path.join(__dirname, "../db/20261113_meta_social_inbound.sql"), "utf8"));
    const call = "select public.office_record_meta_social_message($1,$2,$3,$4,$5) as outcome";
    const input = { channel: "facebook", senderKey: "meta-social:sender:" + "1".repeat(64), eventKey: "meta-social:event:" + "2".repeat(64), text: "fixture", occurredAt: new Date().toISOString() };
    const store = new SupabaseLeadAgentsStore({ url: "http://127.0.0.1:1", serviceRoleKey: "fixture" });
    store.client = { post: async (route, payload) => {
      assert.equal(route, "/rpc/office_record_meta_social_message");
      const { p_channel, p_sender_key, p_event_key, p_text, p_occurred_at } = payload;
      const { rows } = await db.query(call, [p_channel, p_sender_key, p_event_key, p_text, p_occurred_at]);
      return { data: rows[0].outcome };
    } };
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(store.recordMetaSocialMessage(input), { code: "42501" });
    }
    await db.exec("set role service_role");
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => store.recordMetaSocialMessage(input)));
    assert.equal(outcomes.filter((value) => value === "accepted").length, 1);
    assert.equal(outcomes.filter((value) => value === "duplicate").length, 5);
    await assert.rejects(store.recordMetaSocialMessage({ ...input, channel: "whatsapp" }), { code: "22023" });
    await assert.rejects(store.recordMetaSocialMessage({ ...input, channel: "instagram" }), { code: "23505" });
    await assert.rejects(store.recordMetaSocialMessage({ ...input, senderKey: "meta-social:sender:" + "3".repeat(64),
      eventKey: "meta-social:event:" + "4".repeat(64), text: "force rollback" }), { code: "23514" });
    assert.equal(await store.recordMetaSocialMessage({ ...input, eventKey: "meta-social:event:" + "5".repeat(64), occurredAt: "2025-01-01T00:00:00Z" }), "accepted");
    const { rows: [row] } = await db.query(`select (select count(*)::int from leads) as leads,
      (select count(*)::int from conversations) as messages, (select last_inbound_at from lead_channel_states) as newest,
      (select ai_paused from lead_channel_states) as paused`);
    assert.equal(row.leads, 1);
    assert.equal(row.messages, 2);
    assert.equal(row.newest.toISOString(), input.occurredAt);
    assert.equal(row.paused, true);
    console.log("Meta social SQL fixture: service-role scope, dedupe, atomic rollback and timestamps PASS");
  } finally {
    await db.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
