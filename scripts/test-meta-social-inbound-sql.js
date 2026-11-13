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
        primary_channel text, status text, idempotency_key text, last_contact_at timestamptz, channel_last_seen_at timestamptz, contactability_status text);
      create unique index leads_idempotency_key_idx on leads (idempotency_key) where idempotency_key is not null;
      create table conversations (id uuid primary key default gen_random_uuid(), lead_id uuid references leads(id), agent_name text,
        message_role text, channel text, content text check (content <> 'force rollback'), correlation_id text, created_at timestamptz);
      create unique index conversations_correlation_id_uidx on conversations (correlation_id) where correlation_id is not null;
      create table lead_channel_states (lead_id uuid references leads(id), channel text, ai_paused boolean, last_inbound_at timestamptz, unique (lead_id, channel));
      create table whatsapp_manual_sends (id uuid primary key default gen_random_uuid(), lead_id uuid, channel text, recipient text, provider_message_id text,
        status text, created_at timestamptz default now(), failure_reason text);
      grant select, insert, update on leads, conversations, lead_channel_states, whatsapp_manual_sends to service_role;
    `);
    await db.exec(readFileSync(path.join(__dirname, "../db/20261113_meta_social_inbound.sql"), "utf8"));
    await db.exec(readFileSync(path.join(__dirname, "../db/20261113_meta_social_staff_replies.sql"), "utf8"));
    const fenceSql = readFileSync(path.join(__dirname, "../db/20261113_meta_social_dispatch_fence.sql"), "utf8");
    await db.exec(fenceSql);
    const call = "select public.office_record_meta_social_reply_target($1,$2,$3,$4,$5,$6,$7,$8) as outcome";
    const input = { channel: "facebook", senderKey: "meta-social:sender:" + "1".repeat(64), eventKey: "meta-social:event:" + "2".repeat(64), text: "fixture", occurredAt: new Date().toISOString(), asset: "111", sender: "333", optedOut: false };
    const store = new SupabaseLeadAgentsStore({ url: "http://127.0.0.1:1", serviceRoleKey: "fixture" });
    store.client = { post: async (route, payload) => {
      if (route === "/rpc/office_fence_meta_social_dispatch") {
        const { rows } = await db.query("select public.office_fence_meta_social_dispatch($1,$2,$3) as outcome",
          [payload.p_send, payload.p_channel, payload.p_sender_key]);
        return { data: rows[0].outcome };
      }
      if (route === "/rpc/office_record_meta_social_receipt") {
        const { p_channel, p_binding, p_mid, p_state } = payload;
        const { rows } = await db.query("select public.office_record_meta_social_receipt($1,$2,$3,$4) as outcome", [p_channel, p_binding, p_mid, p_state]);
        return { data: rows[0].outcome };
      }
      assert.equal(route, "/rpc/office_record_meta_social_reply_target");
      const { p_channel, p_sender_key, p_event_key, p_text, p_occurred_at, p_asset, p_sender, p_opted_out } = payload;
      const { rows } = await db.query(call, [p_channel, p_sender_key, p_event_key, p_text, p_occurred_at, p_asset, p_sender, p_opted_out]);
      return { data: rows[0].outcome };
    } };
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(store.recordMetaSocialMessage(input), { code: "42501" });
      await assert.rejects(store.recordMetaSocialReceipt({ channel: "facebook", binding: "111:333", mid: "fixture", state: "delivered" }), { code: "42501" });
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
    await db.exec("insert into whatsapp_manual_sends (lead_id, channel, recipient, status) select id, 'facebook', '111:333', 'pending' from leads");
    const { rows: [intent] } = await db.query("select id from whatsapp_manual_sends");
    await db.exec("reset role");
    await db.exec(fenceSql);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(store.fenceMetaSocialDispatch(intent.id, "facebook", input.senderKey), { code: "42501" });
    }
    await db.exec("set role service_role");
    assert.equal(await store.fenceMetaSocialDispatch(intent.id, "instagram", input.senderKey), "social_dispatch_claim_lost");
    const competing = await Promise.all([store.fenceMetaSocialDispatch(intent.id, "facebook", input.senderKey),
      store.fenceMetaSocialDispatch(intent.id, "facebook", input.senderKey)]);
    assert.deepEqual(competing.sort(), ["acquired", "social_dispatch_claim_lost"]);
    await assert.rejects(db.exec("insert into whatsapp_manual_sends (lead_id, channel, recipient, status) select id, 'facebook', '111:333', 'pending' from leads"), { code: "23505" });
    const receipt = { channel: "facebook", binding: "111:333", mid: "fixture", state: "delivered" };
    assert.equal(await store.recordMetaSocialReceipt(receipt), false);
    await db.exec("update whatsapp_manual_sends set status='provider_accepted', provider_message_id='fixture'");
    assert.equal(await store.recordMetaSocialReceipt({ ...receipt, binding: "111:444" }), true);
    assert.equal((await db.query("select social_delivery_state from whatsapp_manual_sends")).rows[0].social_delivery_state, null);
    assert.equal(await store.recordMetaSocialReceipt({ ...receipt, state: "read" }), true);
    assert.equal(await store.recordMetaSocialReceipt(receipt), true);
    assert.equal((await db.query("select social_delivery_state from whatsapp_manual_sends")).rows[0].social_delivery_state, "read");
    const { rows: [stale] } = await db.query("insert into whatsapp_manual_sends (lead_id, channel, recipient, status) select id, 'facebook', '111:333', 'pending' from leads returning id");
    assert.equal(await store.fenceMetaSocialDispatch(stale.id, "facebook", "wrong-binding"), "social_recipient_unverified");
    await db.exec("update leads set meta_social_opted_out = true");
    assert.equal(await store.fenceMetaSocialDispatch(stale.id, "facebook", input.senderKey), "social_opted_out");
    await db.exec("update leads set meta_social_opted_out = false, meta_social_last_inbound_at = now() - interval '1 day'");
    assert.equal(await store.fenceMetaSocialDispatch(stale.id, "facebook", input.senderKey), "social_window_closed");
    assert.equal((await db.query("select social_dispatch_at from whatsapp_manual_sends where id = $1", [stale.id])).rows[0].social_dispatch_at, null);
    await db.query("update whatsapp_manual_sends set status = 'not_sent' where id = $1 and status = 'pending' and social_dispatch_at is null", [stale.id]);
    assert.equal(await store.fenceMetaSocialDispatch(stale.id, "facebook", input.senderKey), "social_dispatch_claim_lost");
    console.log("Meta social SQL fixture: service-role scope, dedupe, atomic rollback and timestamps PASS");
  } finally {
    await db.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
