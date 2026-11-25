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
      create table lead_channel_states (lead_id uuid references leads(id), channel text, ai_paused boolean, last_inbound_at timestamptz,
        human_status text not null default 'auto', human_owner text, takeover_started_at timestamptz,
        takeover_reason text, resume_mode text not null default 'manual_only', social_ownership_revision bigint not null default 0,
        updated_at timestamptz not null default now(), unique (lead_id, channel));
      create table office_runtime_settings (key text primary key, value jsonb not null, updated_by text, updated_at timestamptz not null default now());
      create table whatsapp_inbound_claims (provider_message_id text primary key, channel text not null default 'whatsapp',
        status text not null default 'processing', lead_id uuid, claimed_at timestamptz not null default now(), completed_at timestamptz,
        reply_sent_at timestamptz, request_id text);
      grant select, insert, update on leads, conversations, lead_channel_states, office_runtime_settings, whatsapp_inbound_claims to service_role;`);
    for (const name of ["20261017_whatsapp_manual_sends",
      "20261113_meta_social_inbound", "20261113_meta_social_staff_replies", "20261113_meta_social_dispatch_fence",
      "20261117_meta_social_takeover", "20261118_meta_social_autonomy", "20261125_social_autonomy_setting_fence",
      "20261126_whatsapp_autonomous_dispatch_fence"]) await admin.query(sql(name));
    const a = await connect();
    const b = await connect();
    await admin.query("grant select, insert, update on whatsapp_manual_sends to service_role");
    await a.query("set role service_role");
    await b.query("set role service_role");
    await admin.query(`insert into office_runtime_settings(key,value) values
      ('facebook_messenger_autonomous_responses_enabled','true'::jsonb),
      ('instagram_direct_autonomous_responses_enabled','false'::jsonb),
      ('whatsapp_autonomous_responses_enabled','true'::jsonb)`);
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
    const senderKey = "meta-social:sender:" + "a".repeat(64);
    const eventKey = "meta-social:event:" + "b".repeat(64);
    const aiLead = (await admin.query(`insert into leads (source_channel, idempotency_key, meta_social_asset_id,
      meta_social_sender_id, meta_social_opted_out, meta_social_last_inbound_at)
      values ('facebook',$1,'111','333',false,now()) returning id`, [senderKey])).rows[0];
    await admin.query("insert into conversations (lead_id, channel, message_role, correlation_id, created_at) select id,'facebook','user',$2,meta_social_last_inbound_at from leads where id=$1",
      [aiLead.id, eventKey]);
    const owner = (db, action, id) => db.query(`select office_transition_meta_social_ownership($1,'facebook',$2,
      'f0000000-0000-4000-8000-000000000001','operator@example.test',$3) as result`, [aiLead.id, action, id]).then((r) => r.rows[0].result);
    const resumed = await owner(a, "resume_ai", "f0000000-0000-4000-8000-000000000002");
    const claim = (id) => admin.query(`insert into whatsapp_manual_sends (lead_id,channel,recipient,status,actor_email,client_request_id,body,body_hash)
      values ($1,'facebook',$2,'pending','oyi_social_autonomy',$3,'text','hash') returning id`, [aiLead.id, binding, id]).then((r) => r.rows[0].id);
    const aiIntent = await claim("social-ai-" + "b".repeat(64));
    const fence = (db, revision) => db.query(`select office_fence_meta_social_dispatch($1,'facebook',$2,'oyi_social_autonomy',$3,$4) as outcome`,
      [aiIntent, senderKey, revision, eventKey]).then((r) => r.rows[0].outcome);
    const waitForLock = async () => {
      for (let i = 0; i < 100; i++) {
        if ((await admin.query("select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid=$1", [b.processID])).rows[0]?.waiting) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail("competing transaction did not wait for the ownership lock");
    };
    await a.query("begin");
    assert.equal((await owner(a, "takeover", "f0000000-0000-4000-8000-000000000003")).outcome, "taken_over");
    const staleFence = fence(b, resumed.state.social_ownership_revision);
    await waitForLock();
    await a.query("commit");
    assert.equal(await staleFence, "social_ai_state_changed");
    const fresh = await owner(a, "resume_ai", "f0000000-0000-4000-8000-000000000004");
    await a.query("begin");
    assert.equal(await fence(a, fresh.state.social_ownership_revision), "acquired");
    const blockedTakeover = owner(b, "takeover", "f0000000-0000-4000-8000-000000000005");
    await waitForLock();
    await a.query("commit");
    assert.equal((await blockedTakeover).outcome, "send_outcome_unresolved");
    await admin.query("update whatsapp_manual_sends set status='provider_rejected',failure_reason='test_fixture_settled' where id=$1", [aiIntent]);
    console.log("Meta social AI dispatch/ownership concurrency (both lock orderings): PASS");

    const settingKeys = {
      facebook: "facebook_messenger_autonomous_responses_enabled",
      instagram: "instagram_direct_autonomous_responses_enabled",
    };
    const socialRevisions = { facebook: fresh.state.social_ownership_revision };
    const instagramEvent = "meta-social:event:" + "c".repeat(64);
    await admin.query(`insert into conversations (lead_id,channel,message_role,correlation_id,created_at)
      select id,'instagram','user',$2,meta_social_last_inbound_at from leads where id=$1`, [aiLead.id, instagramEvent]);
    const instagramResume = await admin.query(`select office_transition_meta_social_ownership($1,'instagram','resume_ai',
      'f0000000-0000-4000-8000-000000000001','operator@example.test','f0000000-0000-4000-8000-000000000010') as result`, [aiLead.id]);
    assert.equal(instagramResume.rows[0].result.outcome, "ai_resumed");
    socialRevisions.instagram = instagramResume.rows[0].result.state.social_ownership_revision;
    const eventFor = (suffix) => "meta-social:event:" + require("node:crypto").createHash("sha256").update(suffix).digest("hex");
    const dispatchIntent = async (channel, suffix) => {
      const event = eventFor(`${channel}:${suffix}`);
      await admin.query(`insert into conversations (lead_id,channel,message_role,correlation_id,created_at)
        select id,$2,'user',$3,meta_social_last_inbound_at from leads where id=$1`, [aiLead.id, channel, event]);
      const id = (await admin.query(`insert into whatsapp_manual_sends
      (lead_id,channel,recipient,status,actor_email,client_request_id,body,body_hash)
      values ($1,$2,$3,'pending','oyi_social_autonomy',$4,'synthetic','hash') returning id`,
      [aiLead.id, channel, binding, `social-ai-${event.slice(-64)}`])).rows[0].id;
      return { id, event };
    };
    const trySocialFence = async (db, channel, suffix) => {
      const intent = await dispatchIntent(channel, suffix);
      try {
        const result = await db.query(`select office_fence_meta_social_dispatch($1,$2,$3,'oyi_social_autonomy',$4,$5) as outcome`,
          [intent.id, channel, senderKey, socialRevisions[channel], intent.event]);
        return { ...intent, outcome: result.rows[0].outcome };
      } catch (error) { return { ...intent, error }; }
    };
    const deniedSocialFence = async (channel, suffix) => {
      const attempt = await trySocialFence(a, channel, suffix);
      assert.match(attempt.error?.message || "", /social_ai_setting_off/);
      await admin.query("update whatsapp_manual_sends set status='provider_rejected',failure_reason='setting_off' where id=$1", [attempt.id]);
    };

    await admin.query("update office_runtime_settings set value='false'::jsonb where key=$1", [settingKeys.facebook]);
    await deniedSocialFence("facebook", "off");
    await admin.query("update office_runtime_settings set value='false'::jsonb where key=$1", [settingKeys.instagram]);
    await deniedSocialFence("instagram", "off");
    await admin.query("delete from office_runtime_settings where key=$1", [settingKeys.facebook]);
    await deniedSocialFence("facebook", "missing");
    await admin.query("insert into office_runtime_settings(key,value) values ($1,'\"true\"'::jsonb)", [settingKeys.facebook]);
    await deniedSocialFence("facebook", "malformed-string");

    await admin.query("update office_runtime_settings set value='true'::jsonb where key=$1", [settingKeys.facebook]);
    const fbAllowed = await trySocialFence(a, "facebook", "explicit-true");
    assert.equal(fbAllowed.outcome, "acquired");
    await admin.query("update whatsapp_manual_sends set status='provider_accepted' where id=$1", [fbAllowed.id]);
    await admin.query("update office_runtime_settings set value='false'::jsonb where key=$1", [settingKeys.facebook]);
    await admin.query("update office_runtime_settings set value='true'::jsonb where key=$1", [settingKeys.instagram]);
    const igAllowed = await trySocialFence(a, "instagram", "independent-true");
    assert.equal(igAllowed.outcome, "acquired", "Facebook OFF does not block Instagram ON");
    await admin.query("update whatsapp_manual_sends set status='provider_accepted' where id=$1", [igAllowed.id]);
    await admin.query("update office_runtime_settings set value='false'::jsonb where key=$1", [settingKeys.instagram]);
    await deniedSocialFence("instagram", "independent-off");
    console.log("Social autonomy fence: OFF, missing, malformed, explicit true, and channel independence: PASS");

    // A setting change that wins before dispatch authorization blocks that dispatch.
    await admin.query("update office_runtime_settings set value='false'::jsonb where key=$1", [settingKeys.facebook]);
    await deniedSocialFence("facebook", "off-change-before-dispatch");

    // If dispatch authorization reads true first, its FOR SHARE lock is the
    // linearization point; the setting update waits, then governs later turns.
    await admin.query("update office_runtime_settings set value='true'::jsonb where key=$1", [settingKeys.facebook]);
    const raceIntent = await dispatchIntent("facebook", "setting-race");
    await a.query("begin");
    const racedDispatch = await a.query(`select office_fence_meta_social_dispatch($1,'facebook',$2,'oyi_social_autonomy',$3,$4) as outcome`,
      [raceIntent.id, senderKey, socialRevisions.facebook, raceIntent.event]);
    assert.equal(racedDispatch.rows[0].outcome, "acquired");
    const settingPid = b.processID;
    const turnOff = b.query("update office_runtime_settings set value='false'::jsonb where key=$1", [settingKeys.facebook]);
    await waitForLock(settingPid);
    await a.query("commit");
    await turnOff;
    await admin.query("update whatsapp_manual_sends set status='provider_accepted' where id=$1", [raceIntent.id]);
    await deniedSocialFence("facebook", "off-after-authorized-dispatch");
    console.log("Social autonomy setting/dispatch race: OFF-first blocks; authorized-first serializes: PASS");

    const waLead = (await admin.query("insert into leads (source) values ('whatsapp') returning id")).rows[0].id;
    await admin.query(`insert into lead_channel_states(lead_id,channel,ai_paused,human_status,updated_at)
      values ($1,'whatsapp',false,'auto',clock_timestamp())`, [waLead]);
    const waState = async () => (await admin.query("select updated_at::text as updated_at from lead_channel_states where lead_id=$1 and channel='whatsapp'", [waLead])).rows[0].updated_at;
    const waClaim = async (id) => admin.query(`insert into whatsapp_inbound_claims(provider_message_id,channel,status,lead_id)
      values ($1,'whatsapp','processing',$2)`, [id, waLead]);
    const waAuthorize = (db, id, stateAt) => db.query("select office_authorize_whatsapp_autonomous_dispatch($1,$2,$3) as result", [id, waLead, stateAt]).then((result) => result.rows[0].result);
    await admin.query("update office_runtime_settings set value='false'::jsonb where key='whatsapp_autonomous_responses_enabled'");
    await waClaim("wa-setting-off");
    assert.equal(await waAuthorize(a, "wa-setting-off", await waState()), "autonomous_whatsapp_disabled");
    await admin.query("update office_runtime_settings set value='true'::jsonb where key='whatsapp_autonomous_responses_enabled'");

    await waClaim("wa-takeover-first");
    const preTakeoverState = await waState();
    await a.query("begin");
    await a.query("update lead_channel_states set ai_paused=true,human_status='human_active',updated_at=clock_timestamp() where lead_id=$1 and channel='whatsapp'", [waLead]);
    const waitingAuthorization = waAuthorize(b, "wa-takeover-first", preTakeoverState);
    await waitForLock(b.processID);
    await a.query("commit");
    assert.equal(await waitingAuthorization, "whatsapp_ownership_changed", "takeover winning before authorization suppresses dispatch");

    await admin.query("update lead_channel_states set ai_paused=false,human_status='auto',updated_at=clock_timestamp() where lead_id=$1 and channel='whatsapp'", [waLead]);
    await waClaim("wa-pause-first");
    const beforePause = await waState();
    await a.query("begin");
    await a.query("update lead_channel_states set ai_paused=true,updated_at=clock_timestamp() where lead_id=$1 and channel='whatsapp'", [waLead]);
    const waitingPausedAuthorization = waAuthorize(b, "wa-pause-first", beforePause);
    await waitForLock(b.processID);
    await a.query("commit");
    assert.equal(await waitingPausedAuthorization, "whatsapp_ownership_changed", "AI pause winning before authorization suppresses dispatch");

    await a.query("update lead_channel_states set ai_paused=false,human_status='auto',updated_at=clock_timestamp() where lead_id=$1 and channel='whatsapp'", [waLead]);
    await waClaim("wa-dispatch-first");
    const beforeAuthorization = await waState();
    await a.query("begin");
    assert.equal(await waAuthorize(a, "wa-dispatch-first", beforeAuthorization), "authorized");
    const takeoverAfterAuthorization = b.query("update lead_channel_states set ai_paused=true,human_status='human_active',updated_at=clock_timestamp() where lead_id=$1 and channel='whatsapp'", [waLead]);
    await waitForLock(b.processID);
    await a.query("commit");
    await takeoverAfterAuthorization;
    assert.equal((await admin.query("select autonomous_dispatch_state from whatsapp_inbound_claims where provider_message_id='wa-dispatch-first'")).rows[0].autonomous_dispatch_state, "authorized");
    const reclaimed = await admin.query("update whatsapp_inbound_claims set claimed_at=now()-interval '1 hour' where provider_message_id='wa-dispatch-first' and autonomous_dispatch_at is null returning provider_message_id");
    assert.equal(reclaimed.rowCount, 0, "authorized in-flight send cannot be stale-reclaimed/replayed");
    assert.equal(await waAuthorize(a, "wa-dispatch-first", beforeAuthorization), "whatsapp_dispatch_claim_unavailable", "duplicate dispatch authorization is fenced");
    assert.equal(await admin.query("select office_settle_whatsapp_autonomous_dispatch('wa-dispatch-first','unknown') as result").then((r) => r.rows[0].result), "settled");
    assert.equal(await waAuthorize(a, "wa-dispatch-first", beforeAuthorization), "whatsapp_dispatch_claim_unavailable", "unknown provider outcome remains non-replayable");
    console.log("WhatsApp dispatch fence: setting gate, takeover races, in-flight claim and UNKNOWN no-replay: PASS");
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()));
    docker("rm", "-f", name);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
