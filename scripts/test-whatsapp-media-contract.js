// Slice 3.1 -- WhatsApp media contract and caption handling (Office side). Real HTTP webhook, the real WhatsAppCloudAdapter event extraction on Meta-shaped
// payloads, real file store, autonomy switched ON, and a stubbed Backend that records every webhook-event and Oyi Core request. Proves:
//   * text messages are forwarded and answered exactly as before (plus message_type "text");
//   * typed text, caption and media metadata stay distinct; captions (video included) reach Backend and Oyi; no placeholder is ever sent as customer text;
//   * media without a caption, and messages with no readable text, never draw an automatic reply and are flagged on the CRM record;
//   * a STOP typed as text or written as a caption, or a sender Backend reports as opted out, never draws an automatic reply;
//   * duplicate deliveries, human takeover and the single-responder (goal) rule are unchanged;
//   * no media bytes and no URL of any kind are forwarded to Backend; replayed deliveries carry the same fields.
// No network beyond 127.0.0.1, no Meta, no Backend, no download.
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");
const { WhatsAppCloudAdapter } = require("../src/lead-agents/whatsapp");
const media = require("../src/lead-agents/whatsapp-media");
const visibility = require("../src/lead-agents/whatsapp-inbound-visibility");
const outbox = require("../src/lead-agents/communication-outbox");

let checks = 0;
const ok = (cond, name) => { assert.ok(cond, name); checks += 1; console.log("PASS " + name); };
const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const close = (server) => new Promise((resolve) => server.close(resolve));

const SHA = "kXJ1vO8uLqFQ7d0b3Q2b4u5c6Y7z8A9B0C1D2E3F4G5=";
const ts = () => String(Math.floor(Date.now() / 1000));
// Meta Cloud API message objects, as the webhook delivers them
const metaText = (id, from, body) => ({ from, id, timestamp: ts(), type: "text", text: { body } });
const metaImage = (id, from, caption) => ({ from, id, timestamp: ts(), type: "image", image: { id: `media-${id}`, mime_type: "image/jpeg", sha256: SHA, ...(caption !== undefined ? { caption } : {}) } });
const metaVideo = (id, from, caption) => ({ from, id, timestamp: ts(), type: "video", video: { id: `media-${id}`, mime_type: "video/mp4", sha256: SHA, caption } });
const metaVoice = (id, from) => ({ from, id, timestamp: ts(), type: "audio", audio: { id: `media-${id}`, mime_type: "audio/ogg; codecs=opus", sha256: SHA, voice: true } });
const metaDocument = (id, from, caption) => ({ from, id, timestamp: ts(), type: "document", document: { id: `media-${id}`, mime_type: "application/pdf", sha256: SHA, filename: "../../etc/Site Plan.pdf", caption } });
const metaLocation = (id, from) => ({ from, id, timestamp: ts(), type: "location", location: { latitude: 6.43, longitude: 3.42, name: "Lekki" } });
const envelope = (...messages) => ({ object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "pnid", display_phone_number: "2348000000000" }, contacts: [], messages } }] }] });

function unitChecks() {
  const d = media.describeInboundMessage;
  const text = d(metaText("w1", "234", "  Hello there "));
  ok(text.message_type === "text" && text.text === "Hello there" && text.caption === "" && text.attachments.length === 0, "describe: text is typed text, no caption, no attachments");
  const img = d(metaImage("w2", "234", "My site plan"));
  ok(img.message_type === "image" && img.text === "" && img.caption === "My site plan" && img.attachments[0].kind === "image" && img.attachments[0].provider_media_id === "media-w2" && img.attachments[0].mime_type === "image/jpeg" && img.attachments[0].sha256 === SHA, "describe: image caption and metadata kept separately from text");
  ok(d(metaImage("w3", "234")).caption === "" && d(metaImage("w3", "234")).text === "", "describe: an image without caption has no text and no caption (no placeholder)");
  ok(d(metaVideo("w4", "234", "Progress video")).caption === "Progress video", "describe: video captions are kept");
  const voice = d(metaVoice("w5", "234"));
  ok(voice.attachments[0].voice === true && voice.attachments[0].mime_type === "audio/ogg; codecs=opus" && voice.caption === "", "describe: a voice note is audio with voice=true and no caption");
  ok(d({ type: "audio", audio: { id: "a", mime_type: "audio/mpeg" } }).attachments[0].voice === false, "describe: an audio file is not a voice note");
  const doc = d(metaDocument("w6", "234", "Contract"));
  ok(doc.attachments[0].filename === "Site Plan.pdf" && doc.caption === "Contract", "describe: document filename is a display name only (no path)");
  ok(d({ type: "sticker", sticker: { id: "s", mime_type: "image/webp", animated: true } }).attachments[0].animated === true, "describe: sticker metadata");
  const loc = d(metaLocation("w7", "234"));
  ok(loc.message_type === "location" && loc.text === "" && loc.attachments.length === 0, "describe: location is a supported-later type with no text and no media");
  ok(d({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "x", title: "Book a site visit" } } }).text === "Book a site visit", "describe: a list reply title is the customer's tapped text");
  ok(d({ type: "reaction", reaction: { message_id: "m", emoji: "👍" } }).text === "", "describe: a reaction carries no text");
  ok(d({ type: "unsupported", errors: [{ code: 131051 }] }).message_type === "unsupported", "describe: unsupported provider type is reported as such");
  const hostile = d({ type: "image", image: { id: "h", mime_type: "text/html<script>", sha256: 5, url: "https://lookaside.fbsbx.com/secret", caption: "x".repeat(10000), link: "http://internal" } });
  ok(hostile.attachments[0].mime_type === null && hostile.attachments[0].sha256 === null && !("url" in hostile.attachments[0]) && !("link" in hostile.attachments[0]) && hostile.caption.length === 4096, "describe: bad MIME/sha dropped, URL-like fields never copied, caption capped");
  ok(d({ type: "image", image: { mime_type: "image/png" } }).attachments.length === 0, "describe: media without a provider id is not an attachment");
  for (const [t, expected] of [["STOP", true], ["stop.", true], ["Please unsubscribe", true], ["don't message me again!", true], ["opt out", true], ["Leave me alone", true], ["stop by the site tomorrow", false], ["Can you stop the noise?", false], ["", false]]) {
    ok(media.isOptOutRequest(t) === expected, `opt-out check (same pattern as Backend): ${JSON.stringify(t)} -> ${expected}`);
  }
  ok(JSON.stringify(media.backendMessageFields(text)) === JSON.stringify({ message_type: "text" }), "contract: a text message adds only message_type");
  // legacy one-to-one matching keeps its exact text; the display text shows the video caption
  const videoPayload = metaVideo("w8", "234", "Roof done");
  ok(visibility.inboundMessageText(videoPayload) === "[video message — content not available in Office]" && visibility.inboundDisplayText(videoPayload) === "Roof done", "legacy matching text unchanged; CRM display shows the video caption");
  ok(visibility.inboundDisplayText(metaImage("w9", "234")) === "[image message — content not available in Office]", "CRM display keeps the honest placeholder for media without text (CRM only, never sent to Backend)");
  const replay = outbox.payloadFromInboundEvent({ event_type: "message", external_event_id: "w10", lead_id: "lead-1", payload: metaDocument("w10", "2348", "Signed"), created_at: new Date().toISOString() });
  ok(replay.text === "" && replay.message_type === "document" && replay.caption === "Signed" && replay.attachments[0].filename === "Site Plan.pdf", "replay/reconcile payload carries the same message_type, caption and attachments");
  const oldReplay = outbox.payloadFromInboundEvent({ event_type: "message", external_event_id: "w11", payload: metaText("w11", "2348", "hi"), created_at: new Date().toISOString() });
  ok(oldReplay.text === "hi" && oldReplay.message_type === "text" && !("caption" in oldReplay) && !("attachments" in oldReplay), "replay of a text message: unchanged plus message_type");
}

async function main() {
  unitChecks();

  const webhookBodies = [];
  const coreRequests = [];
  let goalActive = false, optedOut = false;
  const backend = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/office/communications/webhook-event") { webhookBodies.push(JSON.parse(raw)); return res.end(JSON.stringify({ ok: true, goal_active: goalActive, ...(optedOut ? { opted_out: true } : {}) })); }
      if (req.url === "/office/conversation/corporate") { coreRequests.push(JSON.parse(raw)); return res.end(JSON.stringify({ ok: true, answer: "Thanks, we have it.", conversation_thread_id: "oyi-thread-1" })); }
      res.statusCode = 404; res.end("{}");
    });
  });
  const backendPort = await listen(backend);
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["media-test-key"], allowedOrigins: [], officeBackendBaseUrl: `http://127.0.0.1:${backendPort}`, officeBackendApiKey: "media-bridge-key", whatsappAccessToken: "test-token-not-real", whatsappPhoneNumberId: "pnid", whatsappVerifyToken: "verify", metaAppSecret: "" };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super", status: "active" });
  const adapter = new WhatsAppCloudAdapter(config);
  const sent = [];
  adapter.verifySignature = () => ({ ok: true, reason: null });
  adapter.sendTextMessage = async (m) => { sent.push(m); return { delivered: true, response_code: 200, external_message_id: `wamid.out.${sent.length}` }; };
  const server = buildServer({
    config, store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }), publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }), loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 50 }),
    whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }),
  });
  const base = `http://127.0.0.1:${await listen(server)}`;
  const post = async (body) => { const res = await fetch(`${base}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); assert.equal(res.status, 200); return (await res.json()).results; };
  const deliver = async (message) => (await post(envelope(message)))[0];
  const login = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "super@ochiga.local", password: "super-pass-123" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${base}/api/lead-agents/admin/settings/whatsapp-autonomy`, { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ enabled: true }) })).status, 200);
  const bodyFor = (id) => webhookBodies.filter((b) => b.provider_message_id === id);
  const activityFor = async (id) => store.findCrmActivityByProviderMessageId(id);
  const counts = () => ({ sent: sent.length, core: coreRequests.length });

  try {
    // 1. Text: unchanged behaviour
    let before = counts();
    const r1 = await deliver(metaText("wamid.t1", "2348011111111", "Hello, I own land in Lekki"));
    const b1 = bodyFor("wamid.t1")[0];
    ok(b1 && b1.text === "Hello, I own land in Lekki" && b1.message_type === "text" && !("caption" in b1) && !("attachments" in b1), "text: forwarded with its text and message_type only");
    ok(counts().core === before.core + 1 && coreRequests.at(-1).message === "Hello, I own land in Lekki" && !coreRequests.at(-1).metadata.inbound_message && counts().sent === before.sent + 1 && r1.outbound, "text: Oyi answers the typed text and the reply is sent, as before");

    // 2. Image without caption: no AI call, no reply, flagged for a human
    before = counts();
    const r2 = await deliver(metaImage("wamid.i1", "2348022222222"));
    const b2 = bodyFor("wamid.i1")[0];
    ok(b2.text === "" && b2.message_type === "image" && !("caption" in b2) && b2.attachments.length === 1 && b2.attachments[0].provider_media_id === "media-wamid.i1", "media only: Backend gets empty text, the type and the media metadata (no placeholder text)");
    ok(counts().core === before.core && counts().sent === before.sent && r2.suppressed && r2.reason === "media_without_text", "media only: Oyi is not asked and nothing is sent");
    const a2 = await activityFor("wamid.i1");
    ok(a2 && a2.metadata.attachments[0].kind === "image" && a2.metadata.customer_text_present === false && a2.metadata.suppressed_reason === "media_without_text" && a2.metadata.ai_replied === false, "media only: the CRM record keeps the media metadata and is flagged for a human");
    const lead2 = (await store.listLeads()).find((l) => l.whatsapp_phone === "2348022222222");
    const thread = await (await fetch(`${base}/api/lead-agents/admin/crm/relationships/${lead2.id}`, { headers: { cookie } })).json();
    const entry2 = (thread.entries || thread.thread?.entries || []).find((e) => e.provider_message_id === "wamid.i1");
    ok(entry2 && /Media without text/.test(entry2.reply_suppressed?.text || "") && /image message/.test(entry2.text), "media only: the conversation shows the message and why no reply was sent");
    const inbox = await (await fetch(`${base}/api/lead-agents/admin/crm/relationships`, { headers: { cookie } })).json();
    const row2 = (inbox.relationships || []).find((r) => r.lead_id === lead2.id);
    ok(row2 && row2.unread === true, "media only: the inbox keeps the conversation unread (awaiting a person)");

    // 3. Image with caption: caption answered, media described structurally
    before = counts();
    const r3 = await deliver(metaImage("wamid.i2", "2348022222222", "Here is my site plan"));
    const b3 = bodyFor("wamid.i2")[0];
    ok(b3.text === "" && b3.caption === "Here is my site plan" && b3.attachments.length === 1, "caption: forwarded as caption (not as text)");
    const core3 = coreRequests.at(-1);
    ok(counts().core === before.core + 1 && core3.message === "Here is my site plan" && core3.metadata.inbound_message.message_type === "image" && core3.metadata.inbound_message.caption_present === true && core3.metadata.inbound_message.attachment_kinds.join() === "image" && counts().sent === before.sent + 1 && r3.outbound, "caption: Oyi answers the caption; the attachment is described in metadata, not in the message");
    ok((await activityFor("wamid.i2")).body === "Here is my site plan" && (await activityFor("wamid.i2")).metadata.caption === "Here is my site plan", "caption: shown in the CRM record and kept in its own field");

    // 4. STOP as a video caption, and as text: no automatic reply
    before = counts();
    const r4 = await deliver(metaVideo("wamid.v1", "2348033333333", "STOP"));
    ok(bodyFor("wamid.v1")[0].caption === "STOP" && r4.reason === "opt_out_requested" && counts().core === before.core && counts().sent === before.sent, "STOP caption on a video: forwarded to Backend for opt-out, never answered automatically");
    const r5 = await deliver(metaText("wamid.t2", "2348033333333", "stop"));
    ok(r5.reason === "opt_out_requested" && counts().sent === before.sent && counts().core === before.core, "STOP as text: never answered automatically (previously Office still replied)");

    // 5. Backend reports the sender as opted out
    optedOut = true;
    before = counts();
    const r6 = await deliver(metaText("wamid.t3", "2348033333333", "hello again"));
    optedOut = false;
    ok(r6.reason === "opted_out" && counts().sent === before.sent && counts().core === before.core, "opted-out sender (per Backend): no automatic reply to later messages");

    // 6. Location / document without caption
    before = counts();
    const r7 = await deliver(metaLocation("wamid.l1", "2348044444444"));
    ok(r7.reason === "no_customer_text" && bodyFor("wamid.l1")[0].message_type === "location" && !("attachments" in bodyFor("wamid.l1")[0]) && counts().sent === before.sent, "location: no readable text, no reply, type forwarded");
    const r8 = await deliver(metaVoice("wamid.a1", "2348044444444"));
    ok(r8.reason === "media_without_text" && bodyFor("wamid.a1")[0].attachments[0].voice === true && counts().core === before.core, "voice note: no transcription, no AI, no reply; voice flag forwarded");
    const r9 = await deliver(metaDocument("wamid.d1", "2348044444444"));
    ok(r9.reason === "media_without_text" && bodyFor("wamid.d1")[0].attachments[0].filename === "Site Plan.pdf" && !("caption" in bodyFor("wamid.d1")[0]), "document without caption: metadata forwarded, no reply");

    // 7. Duplicate delivery of a media message: one record, one Backend delivery, no reply
    before = counts();
    const dupMsg = metaImage("wamid.i3", "2348055555555", "Duplicate test");
    const [d1, d2] = await post(envelope(dupMsg, dupMsg));
    const d3 = await deliver(dupMsg);
    const acts = (await store.listCrmActivitiesForWhatsApp()).filter((a) => a.metadata?.provider_message_id === "wamid.i3");
    ok(bodyFor("wamid.i3").length === 1 && acts.length === 1 && [d2, d3].every((r) => r.duplicate) && counts().sent === before.sent + 1, "duplicates: one Backend delivery, one CRM record, one reply");

    // 8. Human takeover: a captioned image is not answered
    const lead6 = (await store.listLeads()).find((l) => l.whatsapp_phone === "2348011111111");
    await store.upsertLeadChannelState(lead6.id, "whatsapp", { human_status: "human_active" });
    before = counts();
    const r10 = await deliver(metaImage("wamid.i4", "2348011111111", "Is this the right roof?"));
    await store.upsertLeadChannelState(lead6.id, "whatsapp", { human_status: "auto" });
    ok(r10.paused && counts().sent === before.sent && counts().core === before.core && bodyFor("wamid.i4")[0].caption === "Is this the right roof?", "human takeover: no automatic reply; the message still reaches Backend with its caption");

    // 9. Single responder: an active goal owns the reply
    goalActive = true;
    before = counts();
    const r11 = await deliver(metaImage("wamid.i5", "2348011111111", "Second photo"));
    goalActive = false;
    ok(r11.deferred_to_goal && counts().sent === before.sent && counts().core === before.core, "single responder: an active Backend goal owns the reply to a captioned image");

    // 10. Nothing that could reach media bytes, a provider URL or a private storage URL was forwarded
    const everything = JSON.stringify(webhookBodies);
    ok(!/https?:\/\/|lookaside|fbsbx|\/api\/lead-agents\/admin\/storage|data:/i.test(everything) && webhookBodies.every((b) => (b.attachments || []).every((a) => Object.keys(a).sort().join() === "animated,filename,kind,mime_type,provider_media_id,sha256,size_bytes,voice")), "no media bytes, provider URL or storage URL in any Backend request; attachments carry only the agreed metadata keys");
    ok(webhookBodies.every((b) => typeof b.text === "string" && !/content not available|\[(image|video|audio|document|location)/i.test(b.text)), "no placeholder ever sent to Backend as customer text");
  } finally {
    await close(server);
    await close(backend);
  }
  console.log(JSON.stringify({ suite: "whatsapp-media-contract", checks, failed: 0 }));
}

main().catch((error) => { console.error(error); process.exit(1); });
