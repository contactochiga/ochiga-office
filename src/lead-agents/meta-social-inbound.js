"use strict";

const { createHash, createHmac, timingSafeEqual } = require("node:crypto");
const { json, methodNotAllowed, readRawBodyBuffer } = require("./http");

const CHANNELS = new Map([["page", "facebook"], ["instagram", "instagram"]]);
const isAssetId = (value) => typeof value === "string" && /^[0-9]{1,32}$/.test(value);
const key = (scope, parts) => `meta-social:${scope}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
const senderKeyFor = (channel, asset, sender) => key("sender", [channel, asset, sender]);
const isOptOut = (text) => /^(?:stop(?: all)?|unsubscribe|opt[ -]?out|cancel|end|quit|do not (?:contact|message)(?: me)?)[.!]?$/i.test(text);

function matches(expected, received) {
  if (typeof received !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

function configuredAsset(config, channel) {
  const id = channel === "facebook" ? config.facebookPageId : config.instagramBusinessAccountId;
  return isAssetId(id) ? id : null;
}

function parseMessages(body, config) {
  const channel = CHANNELS.get(body?.object);
  if (!channel || !Array.isArray(body.entry)) return null;
  const asset = configuredAsset(config, channel);
  if (!asset) return { unconfigured: true };
  const messages = [];
  const receipts = [];
  let skipped = 0;
  for (const entry of body.entry) {
    if (entry?.id !== asset || !Array.isArray(entry.messaging)) {
      skipped++;
      continue;
    }
    for (const event of entry.messaging) {
      const sender = event?.sender?.id;
      const message = event?.message;
      const text = typeof message?.text === "string" ? message.text.trim() : "";
      const mid = message?.mid;
      const timestamp = event?.timestamp;
      const recipient = event?.recipient?.id;
      const peer = sender === asset ? recipient : recipient === asset ? sender : null;
      if (isAssetId(peer) && peer !== asset && (event.delivery || event.read)) {
        const mids = channel === "facebook" ? event.delivery?.mids : [event.read?.mid];
        for (const id of Array.isArray(mids) ? mids : []) {
          if (typeof id === "string" && /^[!-~]{1,512}$/.test(id)) {
            receipts.push({ channel, binding: `${asset}:${peer}`, mid: id, state: channel === "facebook" ? "delivered" : "read" });
          }
        }
        continue;
      }
      if (!isAssetId(sender) || sender === asset || event?.recipient?.id !== asset ||
          message?.is_echo || message?.is_self || message?.is_deleted || message?.is_unsupported ||
          typeof mid !== "string" || !/^[!-~]{1,512}$/.test(mid) ||
          !text || text.length > 4000 || text.includes("\0") ||
          !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > Date.now() + 5 * 60_000) {
        skipped++;
        continue;
      }
      messages.push({
        channel,
        senderKey: senderKeyFor(channel, asset, sender),
        asset,
        sender,
        optedOut: isOptOut(text),
        eventKey: key("event", [channel, asset, mid]),
        text,
        occurredAt: new Date(timestamp).toISOString(),
      });
    }
  }
  return { messages, receipts, skipped };
}

async function handleMetaSocialWebhook({ req, res, config, store, log }) {
  if (!config.metaSocialInboundEnabled) return json(res, 404, { error: "not_found" });
  if (!config.metaAppSecret || !config.metaSocialVerifyToken ||
      ![...CHANNELS.values()].some((channel) => configuredAsset(config, channel))) {
    return json(res, 503, { error: "webhook_not_configured" });
  }
  if (req.method === "GET") {
    const query = new URL(req.url, "http://localhost").searchParams;
    const challenge = query.get("hub.challenge") || "";
    if (query.get("hub.mode") !== "subscribe" || !/^[0-9]{1,64}$/.test(challenge) ||
        !matches(config.metaSocialVerifyToken, query.get("hub.verify_token"))) {
      return json(res, 403, { error: "forbidden" });
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end(challenge);
  }
  if (req.method !== "POST") return methodNotAllowed(res, "GET,POST");
  const raw = await readRawBodyBuffer(req);
  const signature = `sha256=${createHmac("sha256", config.metaAppSecret).update(raw).digest("hex")}`;
  if (!matches(signature, req.headers["x-hub-signature-256"])) {
    return json(res, 403, { error: "invalid_signature" });
  }
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return json(res, 400, { error: "invalid_json" });
  }
  const parsed = parseMessages(body, config);
  if (!parsed) return json(res, 400, { error: "invalid_envelope" });
  if (parsed.unconfigured) return json(res, 503, { error: "webhook_not_configured" });
  const counts = { accepted: 0, duplicate: 0, skipped: parsed.skipped, failed: 0 };
  for (const message of parsed.messages) {
    try {
      const result = await store.recordMetaSocialMessage(message);
      if (result !== "accepted" && result !== "duplicate") throw new Error("invalid_store_result");
      counts[result]++;
    } catch {
      counts.failed++;
    }
  }
  for (const receipt of parsed.receipts) {
    try {
      // A receipt can precede the send response being saved; retry rather than guess.
      if (!(await store.recordMetaSocialReceipt(receipt))) counts.failed++;
    } catch {
      counts.failed++;
    }
  }
  log(counts.failed ? "error" : "info", "meta_social_webhook.batch", counts);
  // A partially written batch is retryable; the store deduplicates committed messages.
  return json(res, counts.failed ? 503 : 200, { ok: !counts.failed, ...counts });
}

module.exports = { handleMetaSocialWebhook, configuredAsset, senderKeyFor, isOptOut };
