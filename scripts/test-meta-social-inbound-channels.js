// Phase C0: independent Messenger / Instagram DM controls (OFFICE_META_SOCIAL_INBOUND_CHANNELS).
// A DM channel is processed only when OFFICE_META_SOCIAL_INBOUND_ENABLED=true AND the channel is listed; a missing, empty or
// invalid list enables nothing (fail-closed). Signature checks are unchanged, replies follow the same per-channel switch,
// comments keep their own flag, and the WhatsApp webhook is untouched. File store, synthetic data, no network.
"use strict";
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { rm } = require("node:fs/promises");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { dmChannelEnabled } = require("../src/lead-agents/meta-social-inbound");

const PAGE = "910000000000001", IG = "910000000000002", SECRET = "synthetic-channel-secret", VERIFY = "synthetic-verify";
let checks = 0;
const pass = (text) => { checks += 1; console.log(`PASS ${text}`); };
const dm = (object, asset, mid, sender = "777000") => ({ object, entry: [{ id: asset, messaging: [{ sender: { id: sender }, recipient: { id: asset }, timestamp: Date.now(), message: { mid, text: "Synthetic DM" } }] }] });

function configFor(value) {
  const before = process.env.OFFICE_META_SOCIAL_INBOUND_CHANNELS;
  if (value === undefined) delete process.env.OFFICE_META_SOCIAL_INBOUND_CHANNELS; else process.env.OFFICE_META_SOCIAL_INBOUND_CHANNELS = value;
  try { const c = createConfig(); return { channels: c.metaSocialInboundChannels, invalid: c.metaSocialInboundChannelsInvalid }; }
  finally { if (before === undefined) delete process.env.OFFICE_META_SOCIAL_INBOUND_CHANNELS; else process.env.OFFICE_META_SOCIAL_INBOUND_CHANNELS = before; }
}

async function main() {
  // ---- configuration parsing: fail-closed
  assert.deepEqual(configFor(undefined), { channels: [], invalid: false });
  assert.deepEqual(configFor(""), { channels: [], invalid: false });
  assert.deepEqual(configFor("   "), { channels: [], invalid: false });
  assert.deepEqual(configFor("facebook"), { channels: ["facebook"], invalid: false });
  assert.deepEqual(configFor("instagram"), { channels: ["instagram"], invalid: false });
  assert.deepEqual(configFor("Facebook, INSTAGRAM"), { channels: ["facebook", "instagram"], invalid: false });
  assert.deepEqual(configFor("facebook,facebook"), { channels: ["facebook"], invalid: false });
  for (const bad of ["facebook,whatsapp", "messenger", "facebook,*", "all", "true", "facebook instagram x"]) {
    assert.deepEqual(configFor(bad), { channels: [], invalid: true }, bad);
  }
  assert.equal(dmChannelEnabled({ metaSocialInboundEnabled: false, metaSocialInboundChannels: ["facebook"] }, "facebook"), false);
  assert.equal(dmChannelEnabled({ metaSocialInboundEnabled: true, metaSocialInboundChannels: ["facebook"] }, "instagram"), false);
  assert.equal(dmChannelEnabled({ metaSocialInboundEnabled: "true", metaSocialInboundChannels: ["facebook"] }, "facebook"), false);
  assert.equal(dmChannelEnabled({ metaSocialInboundEnabled: true }, "facebook"), false);
  pass("config: missing/empty list enables nothing; facebook, instagram, both (case-insensitive, de-duplicated) parse; any unknown entry rejects the whole list (fail-closed); the global switch must be strictly true");

  const { store, tempDir } = await createTempStore();
  await store.ensureAdminUser({ email: "operator@synthetic.invalid", password_hash: hashPassword("synthetic-pass-123"), role: "super_admin", display_name: "Synthetic", status: "active" });
  const operator = await store.getAdminUserByEmail("operator@synthetic.invalid");
  const waCalls = [];
  const whatsappAdapter = {
    verifyWebhook: (mode, token, challenge) => (mode === "subscribe" && token === "synthetic-wa-verify" ? challenge : null),
    extractEvents: () => { waCalls.push("extractEvents"); return []; }, verifySignature: () => { waCalls.push("verifySignature"); return false; },
    sendTextMessage: async () => { waCalls.push("send"); throw new Error("no WhatsApp sends"); }, isConfigured: () => true,
  };
  const replies = [];
  const servers = [];
  const mk = () => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5000 });
  const start = async (overrides) => {
    const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["synthetic-api"], allowedOrigins: [], officeBackendBaseUrl: "",
      metaAppSecret: SECRET, metaSocialVerifyToken: VERIFY, facebookPageId: PAGE, instagramBusinessAccountId: IG,
      facebookPageAccessToken: "synthetic-page-token", metaSocialGraphVersion: "v22.0", metaSocialOperatorIds: [operator.id],
      metaSocialInboundEnabled: false, metaSocialInboundChannels: [], metaSocialOutboundEnabled: false, metaSocialCommentsInboundEnabled: false, ...overrides };
    const server = buildServer({ config, store, rateLimiter: mk(), publicRateLimiter: mk(), officeRateLimiter: mk(), loginRateLimiter: mk(), whatsappAdapter,
      metaSocialReplyAdapter: { sendTextMessage: async (r) => { replies.push(r); return { message_id: "m_out", response_code: 200 }; } }, openaiClient: {}, toolExecutor: {} });
    servers.push(server);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const post = (base, body, secret = SECRET) => { const raw = JSON.stringify(body);
    return fetch(`${base}/webhooks/meta-social`, { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(raw).digest("hex") } : {}) }, body: raw })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })); };
  const verify = (base) => fetch(`${base}/webhooks/meta-social?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=4242`).then(async (r) => ({ status: r.status, text: await r.text() }));
  const leads = (source) => store.state.leads.filter((l) => l.source === source).length;
  try {
    // ---- Messenger only
    const fb = await start({ metaSocialInboundEnabled: true, metaSocialInboundChannels: ["facebook"] });
    assert.equal((await verify(fb)).text, "4242");
    let r = await post(fb, dm("page", PAGE, "m_fb_1"));
    assert.equal(r.status, 200); assert.equal(r.body.accepted, 1);
    r = await post(fb, dm("instagram", IG, "m_ig_1"));
    assert.equal(r.status, 200); assert.equal(r.body.accepted, 0); assert.equal(r.body.skipped, 1);
    assert.equal(leads("facebook"), 1); assert.equal(leads("instagram"), 0);
    pass("Messenger only: Meta verification works; a signed Page DM creates one Messenger lead; an Instagram DM is acknowledged (200, no retry) and dropped — no Instagram lead");

    // ---- Instagram only
    const ig = await start({ metaSocialInboundEnabled: true, metaSocialInboundChannels: ["instagram"] });
    r = await post(ig, dm("instagram", IG, "m_ig_2"));
    assert.equal(r.body.accepted, 1);
    r = await post(ig, dm("page", PAGE, "m_fb_2", "777001"));
    assert.equal(r.status, 200); assert.equal(r.body.accepted, 0);
    assert.equal(leads("instagram"), 1); assert.equal(leads("facebook"), 1);
    pass("Instagram only: a signed Instagram DM creates one Instagram lead; a Page DM is acknowledged and dropped — no new Messenger lead");

    // ---- both channels
    const both = await start({ metaSocialInboundEnabled: true, metaSocialInboundChannels: ["facebook", "instagram"] });
    assert.equal((await post(both, dm("page", PAGE, "m_fb_3", "777002"))).body.accepted, 1);
    assert.equal((await post(both, dm("instagram", IG, "m_ig_3", "777003"))).body.accepted, 1);
    assert.equal((await post(both, dm("page", PAGE, "m_fb_3", "777002"))).body.duplicate, 1);
    assert.equal(leads("facebook"), 2); assert.equal(leads("instagram"), 2);
    pass("both channels: Messenger and Instagram DMs each create their own lead; a redelivered message is a duplicate");

    // ---- no channels / invalid / global switch off: route closed, nothing recorded
    const before = store.state.conversations.length;
    for (const [label, overrides] of [["switch on, empty list", { metaSocialInboundEnabled: true, metaSocialInboundChannels: [] }],
                                      ["switch on, list missing", { metaSocialInboundEnabled: true, metaSocialInboundChannels: undefined }],
                                      ["switch on, invalid list (parsed to none)", { metaSocialInboundEnabled: true, metaSocialInboundChannels: configFor("facebook,whatsapp").channels }],
                                      ["switch off, both listed", { metaSocialInboundEnabled: false, metaSocialInboundChannels: ["facebook", "instagram"] }]]) {
      const b = await start(overrides);
      assert.equal((await verify(b)).status, 404, label);
      assert.equal((await post(b, dm("page", PAGE, "m_closed", "777009"))).status, 404, label);
    }
    assert.equal(store.state.conversations.length, before);
    pass("no channels, missing or invalid list, or global switch off: the webhook (verification and delivery) is closed (404) and nothing is recorded");

    // ---- signature verification unchanged on an enabled channel
    assert.equal((await post(fb, dm("page", PAGE, "m_sig", "777010"), null)).status, 403);
    assert.equal((await post(fb, dm("page", PAGE, "m_sig", "777010"), "wrong-secret")).status, 403);
    assert.equal(store.state.conversations.length, before);
    pass("signature verification: unsigned and wrongly signed deliveries are rejected (403) on an enabled channel; nothing recorded");

    // ---- replies follow the per-channel switch
    const out = await start({ metaSocialInboundEnabled: true, metaSocialInboundChannels: ["facebook"], metaSocialOutboundEnabled: true });
    const login = await fetch(`${out}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "operator@synthetic.invalid", password: "synthetic-pass-123" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const igLead = store.state.leads.find((l) => l.source === "instagram");
    const rr = await fetch(`${out}/api/lead-agents/admin/leads/${igLead.id}/instagram/reply`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ body: "Synthetic", client_request_id: "synthetic-request-0001" }) });
    assert.equal(rr.status, 403); assert.equal((await rr.json()).error, "social_reply_disabled");
    const fbLead = store.state.leads.find((l) => l.source === "facebook");
    const fr = await fetch(`${out}/api/lead-agents/admin/leads/${fbLead.id}/facebook/reply`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ body: "Synthetic", client_request_id: "synthetic-request-0002" }) });
    assert.notEqual((await fr.json().catch(() => ({}))).error, "social_reply_disabled", "the listed channel is not blocked by the channel switch");
    assert.ok(replies.every((x) => x.channel !== "instagram"));
    pass("replies: with only Messenger listed, an Instagram reply is refused (social_reply_disabled) even with outbound on, while a Messenger reply passes the channel switch; nothing sent on Instagram");

    // ---- comments keep their own flag
    const cm = await start({ metaSocialInboundEnabled: false, metaSocialInboundChannels: [], metaSocialCommentsInboundEnabled: true });
    const t = Math.floor(Date.now() / 1000) - 60;
    const mixed = { object: "page", entry: [{ id: PAGE, time: t, changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: `${PAGE}_c1`, post_id: `${PAGE}_p1`, from: { id: "920000000000002", name: "Synthetic" }, message: "Synthetic comment", created_time: t } }] },
                                     { id: PAGE, messaging: dm("page", PAGE, "m_cm", "777011").entry[0].messaging }] };
    r = await post(cm, mixed);
    assert.equal(r.status, 200); assert.equal(r.body.comments_accepted, 1); assert.equal(r.body.accepted, 0);
    assert.equal(store.state.conversations.length, before);
    pass("comments: with DMs off and comments on, a mixed delivery stores the comment and drops the DM");

    // ---- WhatsApp isolation
    for (const b of [fb, ig, both, cm]) {
      const w = await fetch(`${b}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=synthetic-wa-verify&hub.challenge=777`);
      assert.equal(await w.text(), "777");
      assert.equal((await fetch(`${b}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=777`)).status, 403);
    }
    assert.deepEqual(waCalls, []);
    assert.ok(store.state.conversations.every((c) => c.channel !== "whatsapp"));
    assert.ok(store.state.leads.filter((l) => ["facebook", "instagram"].includes(l.source)).every((l) => !l.whatsapp_phone));
    pass("WhatsApp isolation: WhatsApp verification behaves identically under every channel setting; Meta social traffic never reaches the WhatsApp adapter or creates WhatsApp records");
  } finally {
    for (const s of servers) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
    await rm(tempDir, { recursive: true, force: true });
  }
  console.log(`\nMeta social inbound channel controls (C0): ${checks} checks PASS`);
}

main().catch((error) => { console.error(error); process.exit(1); });
