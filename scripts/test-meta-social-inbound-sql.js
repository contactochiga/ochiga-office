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
      create role anon; create role authenticated; create role service_role bypassrls;
      create table leads (id uuid primary key default gen_random_uuid(), name text, source text, source_channel text,
        primary_channel text, status text, idempotency_key text, last_contact_at timestamptz, channel_last_seen_at timestamptz, contactability_status text);
      create unique index leads_idempotency_key_idx on leads (idempotency_key) where idempotency_key is not null;
      create table conversations (id uuid primary key default gen_random_uuid(), lead_id uuid references leads(id), agent_name text,
        message_role text, channel text, content text check (content <> 'force rollback'), correlation_id text, created_at timestamptz);
      create unique index conversations_correlation_id_uidx on conversations (correlation_id) where correlation_id is not null;
      create table lead_channel_states (id uuid primary key default gen_random_uuid(), lead_id uuid references leads(id), channel text,
        ai_paused boolean not null default false, human_owner text, human_status text not null default 'auto', takeover_started_at timestamptz,
        takeover_reason text, resume_mode text not null default 'manual_only', customer_service_window_expires_at timestamptz,
        last_external_message_id text, last_inbound_at timestamptz, last_outbound_at timestamptz, created_at timestamptz default now(),
        updated_at timestamptz default now(), unique (lead_id, channel));
      create table whatsapp_manual_sends (id uuid primary key default gen_random_uuid(), lead_id uuid, channel text, recipient text, provider_message_id text,
        status text, created_at timestamptz default now(), updated_at timestamptz default now(), failure_reason text, provider_response_code integer);
      grant select, insert, update on leads, conversations, lead_channel_states, whatsapp_manual_sends to service_role;
    `);
    await db.exec(readFileSync(path.join(__dirname, "../db/20261113_meta_social_inbound.sql"), "utf8"));
    await db.exec(readFileSync(path.join(__dirname, "../db/20261113_meta_social_staff_replies.sql"), "utf8"));
    const fenceSql = readFileSync(path.join(__dirname, "../db/20261113_meta_social_dispatch_fence.sql"), "utf8");
    await db.exec(fenceSql);
    const takeoverSql = readFileSync(path.join(__dirname, "../db/20261117_meta_social_takeover.sql"), "utf8");
    await db.exec(takeoverSql);
    const call = "select public.office_record_meta_social_reply_target($1,$2,$3,$4,$5,$6,$7,$8) as outcome";
    const input = { channel: "facebook", senderKey: "meta-social:sender:" + "1".repeat(64), eventKey: "meta-social:event:" + "2".repeat(64), text: "fixture", occurredAt: new Date().toISOString(), asset: "111", sender: "333", optedOut: false };
    const store = new SupabaseLeadAgentsStore({ url: "http://127.0.0.1:1", serviceRoleKey: "fixture" });
    store.client = { post: async (route, payload) => {
      if (route === "/rpc/office_accept_meta_social_send") {
        const { p_send, p_channel, p_binding, p_mid, p_code } = payload;
        const { rows } = await db.query("select public.office_accept_meta_social_send($1,$2,$3,$4,$5) as outcome", [p_send, p_channel, p_binding, p_mid, p_code]);
        return { data: rows[0].outcome };
      }
      if (route === "/rpc/office_fence_meta_social_dispatch") {
        const { rows } = await db.query("select public.office_fence_meta_social_dispatch($1,$2,$3,$4) as outcome",
          [payload.p_send, payload.p_channel, payload.p_sender_key, payload.p_actor_email]);
        return { data: rows[0].outcome };
      }
      if (route === "/rpc/office_transition_meta_social_ownership") {
        const { rows } = await db.query("select public.office_transition_meta_social_ownership($1,$2,$3,$4,$5,$6) as outcome",
          [payload.p_lead, payload.p_channel, payload.p_action, payload.p_actor_id, payload.p_actor_email, payload.p_request_id]);
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
      await assert.rejects(store.transitionMetaSocialOwnership({ leadId: "00000000-0000-4000-8000-000000000001", channel: "facebook", action: "takeover", actorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", actorEmail: "operator@example.test", requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), { code: "42501" });
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
    const { rows: [socialLead] } = await db.query("select id from leads");
    const actorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const actorEmail = "operator@example.test";
    const firstRequest = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const claimed = await store.transitionMetaSocialOwnership({ leadId: socialLead.id, channel: "facebook", action: "takeover", actorId, actorEmail, requestId: firstRequest });
    assert.equal(claimed.outcome, "taken_over");
    assert.equal(claimed.state.human_owner, actorEmail);
    assert.equal(claimed.state.ai_paused, true);
    const duplicateClaim = await store.transitionMetaSocialOwnership({ leadId: socialLead.id, channel: "facebook", action: "takeover", actorId, actorEmail, requestId: firstRequest });
    assert.equal(duplicateClaim.outcome, "taken_over");
    assert.equal(duplicateClaim.replayed, true);
    const conflictClaim = await store.transitionMetaSocialOwnership({ leadId: socialLead.id, channel: "facebook", action: "takeover", actorId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", actorEmail: "other@example.test", requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
    assert.equal(conflictClaim.outcome, "owned_by_another");
    await db.exec("insert into whatsapp_manual_sends (lead_id, channel, recipient, status) select id, 'facebook', '111:333', 'pending' from leads");
    const { rows: [intent] } = await db.query("select id from whatsapp_manual_sends");
    await db.exec("reset role");
    await db.exec(fenceSql);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(store.fenceMetaSocialDispatch(intent.id, "facebook", input.senderKey, actorEmail), { code: "42501" });
      await assert.rejects(store.acceptMetaSocialSend({ id: intent.id, channel: "facebook", recipient: "111:333" },
        { provider_message_id: "fixture", provider_response_code: 200 }), { code: "42501" });
      await assert.rejects(db.exec("select * from office_meta_social_pending_receipts"), { code: "42501" });
    }
    await db.exec("set role service_role");
    assert.equal(await store.fenceMetaSocialDispatch(intent.id, "instagram", input.senderKey, actorEmail), "social_dispatch_claim_lost");
    assert.equal(await store.fenceMetaSocialDispatch(intent.id, "facebook", input.senderKey, "other@example.test"), "social_takeover_owner_required");
    assert.equal((await db.query("select social_dispatch_at from whatsapp_manual_sends where id = $1", [intent.id])).rows[0].social_dispatch_at, null);
    const releaseBeforeFence = await store.transitionMetaSocialOwnership({ leadId: socialLead.id, channel: "facebook", action: "release", actorId, actorEmail, requestId: "22222222-2222-4222-8222-222222222222" });
    assert.equal(releaseBeforeFence.outcome, "released");
    assert.equal(await store.fenceMetaSocialDispatch(intent.id, "facebook", input.senderKey, actorEmail), "social_takeover_required");
    const claimAgain = await store.transitionMetaSocialOwnership({ leadId: socialLead.id, channel: "facebook", action: "takeover", actorId, actorEmail, requestId: "33333333-3333-4333-8333-333333333333" });
    assert.equal(claimAgain.outcome, "taken_over");
    const competing = await Promise.all([store.fenceMetaSocialDispatch(intent.id, "facebook", input.senderKey, actorEmail),
      store.fenceMetaSocialDispatch(intent.id, "facebook", input.senderKey, actorEmail)]);
    assert.deepEqual(competing.sort(), ["acquired", "social_dispatch_claim_lost"]);
    await assert.rejects(db.exec("insert into whatsapp_manual_sends (lead_id, channel, recipient, status) select id, 'facebook', '111:333', 'pending' from leads"), { code: "23505" });
    const receipt = { channel: "facebook", binding: "111:333", mid: "fixture", state: "delivered" };
    assert.equal(await store.recordMetaSocialReceipt({ ...receipt, binding: "111:444", state: "read" }), true);
    assert.equal(await store.recordMetaSocialReceipt(receipt), true);
    assert.equal(await store.recordMetaSocialReceipt(receipt), true);
    assert.equal((await db.query("select count(*)::int as count from office_meta_social_pending_receipts")).rows[0].count, 1);
    await db.exec("update whatsapp_manual_sends set status='outcome_unknown'");
    const releaseDuringUnknown = await store.transitionMetaSocialOwnership({ leadId: socialLead.id, channel: "facebook", action: "release", actorId, actorEmail, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" });
    assert.equal(releaseDuringUnknown.outcome, "send_outcome_unresolved");
    const attempt = { id: intent.id, channel: "facebook", recipient: "111:333" };
    const acceptance = { provider_message_id: "fixture", provider_response_code: 200 };
    assert.equal(await store.acceptMetaSocialSend({ ...attempt, recipient: "111:444" }, acceptance), false);
    assert.equal(await store.acceptMetaSocialSend(attempt, acceptance), true);
    assert.equal(await store.acceptMetaSocialSend(attempt, acceptance), true);
    assert.equal(await store.acceptMetaSocialSend(attempt, { ...acceptance, provider_message_id: "conflict" }), false);
    assert.equal((await db.query("select social_delivery_state from whatsapp_manual_sends")).rows[0].social_delivery_state, "delivered");
    assert.equal(await store.recordMetaSocialReceipt({ ...receipt, state: "read" }), true);
    assert.equal(await store.recordMetaSocialReceipt(receipt), true);
    assert.equal((await db.query("select social_delivery_state from whatsapp_manual_sends")).rows[0].social_delivery_state, "read");
    const released = await store.transitionMetaSocialOwnership({ leadId: socialLead.id, channel: "facebook", action: "release", actorId, actorEmail, requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    assert.equal(released.outcome, "released");
    assert.equal(released.state.ai_paused, true);
    const reacquired = await store.transitionMetaSocialOwnership({ leadId: socialLead.id, channel: "facebook", action: "takeover", actorId, actorEmail, requestId: "11111111-1111-4111-8111-111111111111" });
    assert.equal(reacquired.outcome, "taken_over");
    const { rows: [stale] } = await db.query("insert into whatsapp_manual_sends (lead_id, channel, recipient, status) select id, 'facebook', '111:333', 'pending' from leads returning id");
    assert.equal(await store.fenceMetaSocialDispatch(stale.id, "facebook", "wrong-binding", actorEmail), "social_recipient_unverified");
    await db.exec("update leads set meta_social_opted_out = true");
    assert.equal(await store.fenceMetaSocialDispatch(stale.id, "facebook", input.senderKey, actorEmail), "social_opted_out");
    await db.exec("update leads set meta_social_opted_out = false, meta_social_last_inbound_at = now() - interval '1 day'");
    assert.equal(await store.fenceMetaSocialDispatch(stale.id, "facebook", input.senderKey, actorEmail), "social_window_closed");
    assert.equal((await db.query("select social_dispatch_at from whatsapp_manual_sends where id = $1", [stale.id])).rows[0].social_dispatch_at, null);
    await db.query("update whatsapp_manual_sends set status = 'not_sent' where id = $1 and status = 'pending' and social_dispatch_at is null", [stale.id]);
    assert.equal(await store.fenceMetaSocialDispatch(stale.id, "facebook", input.senderKey, actorEmail), "social_dispatch_claim_lost");
    console.log("Meta social SQL fixture: service-role scope, dedupe, atomic rollback and timestamps PASS");
  } finally {
    await db.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
