const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { WhatsAppCloudAdapter, escapeNonAscii } = require("../src/lead-agents/whatsapp");
const signatureStats = require("../src/lead-agents/webhook-signature-stats");

// Meta WhatsApp webhook authentication: REAL WhatsAppCloudAdapter (real HMAC), real HTTP server, file store, stubbed Backend that counts every call and a spy on
// outbound sends. Fixture secret/ids only. Nothing here touches a real customer, Meta, or production.
const SECRET = "fixture-app-secret-for-tests-only-0123456789";
const PHONE_ID = "585884641275180";
const VERIFY = "fixture-verify-token";
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
const sign = (bytes, secret = SECRET) => `sha256=${crypto.createHmac("sha256", secret).update(bytes).digest("hex")}`;
let seq = 0;
const messagePayload = ({ from = "2348012345678", text = "Hello, I own land in Lekki", id, phoneId = PHONE_ID } = {}) => ({ object: "whatsapp_business_account", entry: [{ id: "531423816726977", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "2349164738454", phone_number_id: phoneId }, contacts: [{ profile: { name: "Fixture Customer" }, wa_id: from }], messages: [{ from, id: id || `wamid.sig.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] });
const statusPayload = (id) => ({ object: "whatsapp_business_account", entry: [{ id: "531423816726977", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "2349164738454", phone_number_id: PHONE_ID }, statuses: [{ id, status: "delivered", timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: "2348012345678" }] } }] }] });

async function main() {
  let backendCalls = 0;
  const backend = http.createServer((req, res) => { backendCalls++; req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true })); }); });
  const backendPort = await listen(backend);
  const baseConfig = { ...createConfig(), authMode: "required_api_key", apiKeys: ["sig-test-key"], allowedOrigins: [], officeBackendBaseUrl: `http://127.0.0.1:${backendPort}`, officeBackendApiKey: "sig-bridge", metaAppSecret: SECRET, whatsappVerifyToken: VERIFY, whatsappAccessToken: "fixture-access-token", whatsappPhoneNumberId: PHONE_ID };
  const { store } = await createTempStore();
  const outbound = [];
  const makeAdapter = (config) => { const real = new WhatsAppCloudAdapter(config); const wrapped = Object.create(real); wrapped.sendTextMessage = async (m) => { outbound.push(m); return { delivered: true, external_message_id: "wamid.should.not.exist" }; }; wrapped.sendTemplateMessage = async (m) => { outbound.push(m); return { delivered: false }; }; return wrapped; };
  const servers = [];
  const start = async (config) => {
    const server = buildServer({ config, store, rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 9999 }), publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 9999 }), officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 9999 }), loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }), whatsappAdapter: makeAdapter(config), openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
    servers.push(server); return `http://127.0.0.1:${await listen(server)}`;
  };
  const base = await start(baseConfig);
  const post = (url, bytes, headers = {}) => fetch(`${url}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: bytes }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const signed = (payload, { secret = SECRET, pretty = false } = {}) => { const bytes = Buffer.from(pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload), "utf8"); return { bytes, headers: { "x-hub-signature-256": sign(bytes, secret) } }; };
  const snapshot = () => JSON.stringify({ leads: store.state.leads.length, inbound: store.state.inbound_events.length, claims: Object.keys(store.state.whatsapp_inbound_claims).length, conversations: store.state.conversations.length, timeline: store.state.timeline_events.length, activities: (store.state.crm_activities || []).length, states: store.state.lead_channel_states.length, contacts: (store.state.crm_contacts || []).length });
  signatureStats.resetForTests();

  try {
    // ---- GET challenge (J, K) ----
    const okChallenge = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=CHALLENGE123`); assert.equal(okChallenge.status, 200); assert.equal(await okChallenge.text(), "CHALLENGE123");
    assert.equal((await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=X`)).status, 403);
    assert.equal((await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=X`)).status, 403);
    console.log("J/K. GET verification challenge: valid works, invalid/missing token refused — PASS");

    // ---- A, P: valid signature accepted, normal CRM intake ----
    const first = signed(messagePayload({ id: "wamid.valid.1", text: "Hello, I own land in Lekki" }));
    const accepted = await post(base, first.bytes, first.headers);
    assert.equal(accepted.status, 200);
    const lead = store.state.leads.find((l) => l.whatsapp_phone === "2348012345678"); assert.ok(lead, "a valid signed message creates the CRM lead");
    assert.ok(store.state.inbound_events.some((e) => e.external_event_id === "wamid.valid.1"), "inbound event stored");
    assert.ok(store.state.whatsapp_inbound_claims["wamid.valid.1"], "claim made");
    console.log("A/P. Valid Meta HMAC accepted; normal CRM intake continues — PASS");

    // ---- B..I, L..O: every unauthenticated variant is refused and leaves NO trace ----
    const before = snapshot(); const backendBefore = backendCalls; const outBefore = outbound.length;
    const ok = signed(messagePayload({ id: "wamid.forged.1", from: "2348099999999", text: "FORGED lead" }));
    const tampered = Buffer.from(ok.bytes.toString("utf8").replace("FORGED lead", "FORGED lead!"), "utf8");
    const pretty = Buffer.from(JSON.stringify(JSON.parse(ok.bytes.toString("utf8")), null, 2), "utf8"); // same JSON, different bytes
    const cases = [
      ["B missing signature", ok.bytes, {}, 401],
      ["G empty signature", ok.bytes, { "x-hub-signature-256": "" }, 401],
      ["F malformed (no prefix)", ok.bytes, { "x-hub-signature-256": ok.headers["x-hub-signature-256"].slice(7) }, 401],
      ["F malformed (short)", ok.bytes, { "x-hub-signature-256": "sha256=abc123" }, 401],
      ["F malformed (sha1)", ok.bytes, { "x-hub-signature-256": `sha1=${crypto.createHmac("sha1", SECRET).update(ok.bytes).digest("hex")}` }, 401],
      ["F malformed (non-hex)", ok.bytes, { "x-hub-signature-256": `sha256=${"z".repeat(64)}` }, 401],
      ["C incorrect signature", ok.bytes, { "x-hub-signature-256": `sha256=${"0".repeat(64)}` }, 403],
      ["D tampered body", tampered, ok.headers, 403],
      ["E wrong app secret", ok.bytes, signed(messagePayload({ id: "wamid.forged.1", from: "2348099999999", text: "FORGED lead" }), { secret: "some-other-apps-secret" }).headers, 403],
      ["I reserialised JSON does not verify", pretty, ok.headers, 403],
    ];
    for (const [name, bytes, headers, expected] of cases) {
      const r = await post(base, bytes, headers);
      assert.equal(r.status, expected, `${name}: expected ${expected}, got ${r.status}`);
      assert.ok(!r.text.includes(SECRET), "no secret in any response");
    }
    // an unsigned body that is not even JSON is refused on the signature, never parsed
    assert.equal((await post(base, Buffer.from("not json at all"), {})).status, 401);
    assert.equal(snapshot(), before, "L/M. rejected requests created NO lead, contact, inbound event, claim, conversation, timeline or activity record");
    assert.equal(backendCalls, backendBefore, "O. rejected requests triggered no Backend / Oyi Core call");
    assert.equal(outbound.length, outBefore, "N. rejected requests produced no outbound message");
    console.log("B-I, L-O. 11 unauthenticated variants refused (401/403) with zero side effects — PASS");

    // ---- H: missing app secret fails closed ----
    const noSecretBase = await start({ ...baseConfig, metaAppSecret: "" });
    const stillBefore = snapshot();
    const noSecret = await post(noSecretBase, first.bytes, first.headers); assert.equal(noSecret.status, 503); assert.ok(noSecret.text.includes("webhook_not_configured"));
    assert.equal((await post(noSecretBase, ok.bytes, {})).status, 503);
    assert.equal(snapshot(), stillBefore, "H. no secret configured => nothing is accepted or stored");
    console.log("H. Missing META_APP_SECRET fails closed (503), nothing stored — PASS");

    // ---- Unicode / raw-byte handling ----
    const emoji = messagePayload({ id: "wamid.emoji.1", from: "2348011110001", text: "Interested in land 😀 in Abuja é" });
    const emojiRaw = signed(emoji); assert.equal((await post(base, emojiRaw.bytes, emojiRaw.headers)).status, 200, "signature over the exact bytes (raw UTF-8 emoji) verifies");
    const emoji2 = messagePayload({ id: "wamid.emoji.2", from: "2348011110002", text: "Café 😀 plot" });
    const emoji2Bytes = Buffer.from(JSON.stringify(emoji2), "utf8");
    const escapedSig = sign(Buffer.from(escapeNonAscii(emoji2Bytes.toString("utf8")), "utf8"));
    assert.equal((await post(base, emoji2Bytes, { "x-hub-signature-256": escapedSig })).status, 200, "signature over the lower-case \\uXXXX-escaped form (as Meta documents) verifies");
    const emoji3Bytes = Buffer.from(JSON.stringify(messagePayload({ id: "wamid.emoji.3", from: "2348011110003", text: "😀" })), "utf8");
    assert.equal((await post(base, emoji3Bytes, { "x-hub-signature-256": sign(Buffer.from(escapeNonAscii(emoji3Bytes.toString("utf8")).toUpperCase(), "utf8")) })).status, 403, "an upper-case-escaped variant is not an accepted form");
    const invalidUtf8 = Buffer.concat([Buffer.from('{"object":"whatsapp_business_account","entry":[],"x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]);
    assert.equal((await post(base, invalidUtf8, { "x-hub-signature-256": sign(invalidUtf8) })).status, 200, "bytes that are not valid UTF-8 are hashed exactly as received (a decoded string would have changed them)");
    console.log("I2. Raw-byte verification: exact bytes, Meta's escaped-unicode form, invalid UTF-8 — PASS");

    // ---- Q duplicates, R status events, S autonomy OFF, T takeover ----
    const leadsBeforeDup = store.state.leads.length;
    const dup = await post(base, first.bytes, first.headers); assert.equal(dup.status, 200);
    assert.equal(store.state.leads.length, leadsBeforeDup, "Q. a duplicate valid delivery creates no second lead");
    assert.equal(store.state.inbound_events.filter((e) => e.external_event_id === "wamid.valid.1" && e.event_type === "message").length, 1, "Q. one stored inbound message for the duplicated delivery");
    const status = signed(statusPayload("wamid.out.zzz")); assert.equal((await post(base, status.bytes, status.headers)).status, 200);
    assert.ok(store.state.inbound_events.some((e) => e.event_type === "status:delivered" && e.external_event_id === "wamid.out.zzz"), "R. valid status events keep being processed");
    assert.equal(outbound.length, outBefore, "S. global autonomy is OFF (no setting row): no outbound message was sent for any accepted message");
    assert.equal(await store.getRuntimeSetting("whatsapp_autonomous_responses_enabled"), null, "the autonomy setting was never written");
    assert.ok(store.state.timeline_events.some((e) => e.lead_id === lead.id && e.event_type === "whatsapp_autonomous_reply_suppressed"), "S. the suppression is recorded on the lead");
    await store.upsertLeadChannelState(lead.id, "whatsapp", { human_status: "human_active", human_owner: "staff@ochiga.local", ai_paused: true });
    const takeoverMsg = signed(messagePayload({ id: "wamid.valid.2", text: "Second message while a human owns the chat" })); assert.equal((await post(base, takeoverMsg.bytes, takeoverMsg.headers)).status, 200);
    const state = await store.getLeadChannelState(lead.id, "whatsapp"); assert.equal(state.human_status, "human_active", "T. a customer message does not end an active human takeover"); assert.equal(outbound.length, outBefore);
    console.log("Q/R/S/T. Duplicate delivery, status events, autonomy OFF, human takeover — PASS");

    // ---- phone-number id observability, report mode, health, evidence ----
    const foreign = signed(messagePayload({ id: "wamid.foreign.1", from: "2348011110009", phoneId: "999999999999999" })); assert.equal((await post(base, foreign.bytes, foreign.headers)).status, 200, "a validly signed event for another phone-number id is still processed (observed, not blocked)");
    const reportBase = await start({ ...baseConfig, whatsappWebhookSignatureMode: "report" });
    const reportBefore = store.state.leads.length;
    const legacy = signed(messagePayload({ id: "wamid.report.1", from: "2348011110010" }), { secret: "wrong" });
    assert.equal((await post(reportBase, legacy.bytes, legacy.headers)).status, 200, "explicit REPORT mode keeps the legacy rollout behaviour (processes, but loudly logs and counts the failure)");
    assert.equal(store.state.leads.length, reportBefore + 1);
    const healthEnforce = await (await fetch(`${base}/healthz`)).json(); const healthReport = await (await fetch(`${reportBase}/healthz`)).json();
    assert.deepEqual(healthEnforce.whatsapp_webhook, { signature_mode: "enforce", app_secret_configured: true }, "enforce is the default");
    assert.equal(healthReport.whatsapp_webhook.signature_mode, "report");
    assert.ok(!JSON.stringify(healthEnforce).includes(SECRET));
    await signatureStats.flush(store, "enforce");
    const stats = (await store.getRuntimeSetting(signatureStats.STATS_KEY)).value;
    for (const key of ["valid_raw", "valid_escaped_unicode", "missing_signature", "malformed_signature", "signature_mismatch", "app_secret_not_configured"]) assert.ok(stats.counts[key] >= 1, `evidence counter ${key} recorded`);
    assert.ok(stats.phone_number_mismatch >= 1); assert.ok(stats.last_valid_at && stats.last_invalid_reason);
    const storedStats = JSON.stringify(stats); assert.ok(!storedStats.includes(SECRET) && !storedStats.includes("sha256=") && !storedStats.includes("2348"), "the evidence holds counters only: no secret, signature or phone number");
    console.log("Evidence. Enforce is the default; report mode explicit and visible; counters-only stats; foreign phone-number id observed — PASS");

    // ---- the offline verification helper reports MATCH / MISMATCH only and never echoes a secret ----
    {
      const { spawnSync } = require("node:child_process"); const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
      const run = (modeArgs, env) => spawnSync(process.execPath, [path.join(__dirname, "verify-meta-webhook-signature.js"), ...modeArgs], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
      const same = run(["compare"], { META_SECRET_A: SECRET, META_SECRET_B: SECRET }); assert.equal(same.stdout.trim(), "MATCH"); assert.equal(same.status, 0);
      const diff = run(["compare"], { META_SECRET_A: SECRET, META_SECRET_B: SECRET + "x" }); assert.ok(diff.stdout.startsWith("MISMATCH")); assert.equal(diff.status, 1);
      const file = path.join(os.tmpdir(), `sig-sample-${process.pid}.json`); fs.writeFileSync(file, first.bytes);
      const good = run(["sample", "--body-file", file, "--signature", first.headers["x-hub-signature-256"]], { META_APP_SECRET: SECRET }); assert.ok(good.stdout.startsWith("MATCH"), good.stdout);
      const bad = run(["sample", "--body-file", file, "--signature", first.headers["x-hub-signature-256"]], { META_APP_SECRET: "wrong-secret" }); assert.ok(bad.stdout.startsWith("MISMATCH"));
      for (const out of [same, diff, good, bad]) assert.ok(!(out.stdout + out.stderr).includes(SECRET), "the helper never prints a secret");
      fs.rmSync(file, { force: true });
      console.log("Tooling. Offline secret comparison / sample verification reports MATCH or MISMATCH only — PASS");
    }

    console.log(JSON.stringify({ status: "PASS", suite: "whatsapp-webhook-signature", rejected_variants: cases.length + 1 }));
  } finally {
    for (const server of servers) await close(server).catch(() => {});
    await close(backend).catch(() => {});
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
