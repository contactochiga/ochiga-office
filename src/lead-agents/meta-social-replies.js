"use strict";

const axios = require("axios");
const { performManualSend } = require("./manual-whatsapp-send");
const { configuredAsset, senderKeyFor } = require("./meta-social-inbound");

const WINDOW_MS = 24 * 60 * 60_000;
const idPattern = /^[0-9]{1,32}$/;

function replyTarget(config, lead, channel) {
  if (!["facebook", "instagram"].includes(channel)) return null;
  const asset = configuredAsset(config, channel);
  const sender = lead?.meta_social_sender_id;
  if (!asset || lead?.meta_social_asset_id !== asset || !idPattern.test(sender || "") ||
      lead.idempotency_key !== senderKeyFor(channel, asset, sender)) return null;
  return { asset, sender, binding: `${asset}:${sender}` };
}

function replyPolicy(config, lead, channel, now = Date.now()) {
  if (!config.metaSocialInboundEnabled || !config.metaSocialOutboundEnabled) return "social_reply_disabled";
  if (!replyTarget(config, lead, channel)) return "social_recipient_unverified";
  if (lead.meta_social_opted_out !== false || lead.contactability_status === "denied") return "social_opted_out";
  const last = Date.parse(lead.meta_social_last_inbound_at);
  if (!Number.isFinite(last) || last > now || now - last >= WINDOW_MS) return "social_window_closed";
  if (!config.facebookPageAccessToken || !idPattern.test(config.facebookPageId || "") ||
      !/^v[0-9]+\.[0-9]+$/.test(config.metaSocialGraphVersion || "")) return "social_provider_not_configured";
  return null;
}

function createMetaSocialReplyAdapter(config, request = axios.post) {
  return {
    async sendTextMessage({ to, body, channel }) {
      const response = await request(
        `https://graph.facebook.com/${config.metaSocialGraphVersion}/${config.facebookPageId}/messages`,
        { recipient: { id: to }, message: { text: body }, ...(channel === "facebook" ? { messaging_type: "RESPONSE" } : {}) },
        { headers: { Authorization: `Bearer ${config.facebookPageAccessToken}` }, timeout: 10_000, maxRedirects: 0 }
      );
      const mid = response.data?.message_id;
      if (response.status < 200 || response.status >= 300 || typeof mid !== "string" || !/^[!-~]{1,512}$/.test(mid) ||
          (response.data?.recipient_id != null && response.data.recipient_id !== to)) throw new Error("unconfirmed_provider_response");
      return { delivered: true, external_message_id: mid, response_code: response.status };
    },
  };
}

async function sendSocialReply({ config, store, adapter, lead, channel, actorEmail, clientRequestId, text, audit }) {
  const target = replyTarget(config, lead, channel);
  const problem = replyPolicy(config, lead, channel);
  if (problem) return { httpStatus: 409, body: { ok: false, error: problem } };
  return performManualSend({
    store, adapter, lead, actorEmail, clientRequestId, text, audit, channel, recipient: target.binding,
    send: async () => {
      const fresh = await store.getMetaSocialReplyLead(lead.id);
      const latest = fresh && replyTarget(config, fresh, channel);
      if (!latest || latest.binding !== target.binding || replyPolicy(config, fresh, channel)) {
        return { skipped: true };
      }
      return adapter.sendTextMessage({ to: target.sender, body: text, channel });
    },
  });
}

module.exports = { createMetaSocialReplyAdapter, replyPolicy, sendSocialReply };
