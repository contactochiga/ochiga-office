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
      let response;
      try {
        response = await request(
          `https://graph.facebook.com/${config.metaSocialGraphVersion}/${config.facebookPageId}/messages`,
          { recipient: { id: to }, message: { text: body }, ...(channel === "facebook" ? { messaging_type: "RESPONSE" } : {}) },
          { headers: { Authorization: `Bearer ${config.facebookPageAccessToken}` }, timeout: 10_000, maxRedirects: 0 }
        );
      } catch (error) {
        const status = error?.response?.status;
        const graph = error?.response?.data?.error;
        // Only known authorization refusals with recognizable Graph evidence release the block.
        const refused = [400, 401, 403].includes(status) && graph?.type === "OAuthException" &&
          [10, 190, 200].includes(graph.code) && graph.is_transient !== true &&
          typeof graph.message === "string" && Boolean(graph.message.trim()) &&
          typeof graph.fbtrace_id === "string" && /^[\w-]{1,128}$/.test(graph.fbtrace_id);
        if (refused) return { rejected: true, response_code: status };
        throw new Error("meta_provider_outcome_unconfirmed");
      }
      const mid = response.data?.message_id;
      if (response.status < 200 || response.status >= 300 || typeof mid !== "string" || !/^[!-~]{1,512}$/.test(mid) ||
          response.data?.recipient_id !== to) throw new Error("unconfirmed_provider_response");
      return { delivered: true, external_message_id: mid, response_code: response.status };
    },
  };
}

async function sendSocialReply({ config, store, adapter, lead, channel, actorEmail, clientRequestId, text, audit }) {
  const target = replyTarget(config, lead, channel);
  const problem = replyPolicy(config, lead, channel);
  if (problem) {
    await audit(`communication.${channel}.manual_reply`, "failure", { failure_reason: problem }).catch(() => null);
    return { httpStatus: 409, body: { ok: false, error: problem } };
  }
  return performManualSend({
    store, adapter, lead, actorEmail, clientRequestId, text, audit, channel, recipient: target.binding,
    send: async (intent) => {
      const fresh = await store.getMetaSocialReplyLead(lead.id);
      const latest = fresh && replyTarget(config, fresh, channel);
      if (!latest || latest.binding !== target.binding) return { refusal: "social_recipient_unverified" };
      const refusal = replyPolicy(config, fresh, channel);
      if (refusal) return { refusal };
      const started = performance.now();
      // A failed RPC response may conceal a committed grant; never classify it as Meta rejection.
      const fence = await store.fenceMetaSocialDispatch(intent.id, channel, fresh.idempotency_key)
        .catch(() => { throw new Error("social_dispatch_fence_unconfirmed"); });
      if (fence !== "acquired") return { refusal: fence };
      if (performance.now() - started >= 5_000) throw new Error("social_dispatch_grant_stale");
      return adapter.sendTextMessage({ to: target.sender, body: text, channel });
    },
  });
}

module.exports = { createMetaSocialReplyAdapter, replyPolicy, sendSocialReply };
