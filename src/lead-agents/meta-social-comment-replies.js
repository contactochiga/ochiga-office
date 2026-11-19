"use strict";

const axios = require("axios");
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

function classify(error) {
  const status = error?.response?.status;
  const graph = error?.response?.data?.error || {};
  if (graph.code === 190) return { status: "failed", code: "token_invalid" };
  if ([10, 200, 3].includes(graph.code) || [401, 403].includes(status)) return { status: "failed", code: "permission_denied" };
  if (graph.code === 100 || graph.code === 1705) return { status: "failed", code: "reply_rejected" };
  return { status: "unknown", code: Number.isInteger(status) ? `graph_http_${status}` : "provider_outcome_unknown" };
}

function createMetaSocialCommentReplyAdapter(config, { post = axios.post } = {}) {
  const credentials = (channel) => {
    const token = channel === "instagram" ? config.instagramAccessToken || config.facebookPageAccessToken : config.facebookPageAccessToken;
    return token && /^v\d+\.\d+$/.test(config.metaSocialGraphVersion || "")
      ? { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000, maxRedirects: 0 } : null;
  };
  return {
    configured: (channel) => Boolean(credentials(channel)),
    async reply(channel, commentId, message) {
      const auth = credentials(channel);
      if (!auth || !ID.test(commentId || "") || typeof message !== "string" || !message.trim() || message.length > 8000) return { status: "failed", code: "invalid_reply" };
      const edge = channel === "instagram" ? "replies" : "comments";
      try {
        const response = await post(`https://graph.facebook.com/${config.metaSocialGraphVersion}/${encodeURIComponent(commentId)}/${edge}`, null,
          { ...auth, params: { message: message.trim() } });
        const id = response?.data?.id;
        return typeof id === "string" && ID.test(id) ? { status: "published", providerReplyId: id } : { status: "unknown", code: "graph_malformed_response" };
      } catch (error) { return classify(error); }
    },
  };
}

module.exports = { createMetaSocialCommentReplyAdapter, classify };
