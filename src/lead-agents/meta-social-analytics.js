"use strict";

const axios = require("axios");
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const FB_METRICS = ["post_reactions_like_total", "post_clicks", "post_media_view", "post_impressions_organic"];
const IG_METRICS = ["reach", "likes", "comments", "shares", "saved", "total_interactions", "views"];

function createMetaSocialAnalyticsAdapter(config, { get = axios.get } = {}) {
  const auth = (channel) => {
    const token = channel === "instagram" ? config.instagramAccessToken || config.facebookPageAccessToken : config.facebookPageAccessToken;
    return token && /^v\d+\.\d+$/.test(config.metaSocialGraphVersion || "") ? { headers: { Authorization: `Bearer ${token}` }, timeout: 12_000, maxRedirects: 0 } : null;
  };
  const endpoint = (id) => `https://graph.facebook.com/${config.metaSocialGraphVersion}/${encodeURIComponent(id)}`;
  return {
    configured: (channel) => Boolean(auth(channel)),
    async read(channel, postId, mediaType) {
      const credentials = auth(channel);
      if (!credentials || !ID.test(postId || "")) return { status: "unavailable", metrics: {}, unavailable: ["all"] };
      const candidates = channel === "instagram" ? IG_METRICS : FB_METRICS;
      const metrics = {};
      const unavailable = [];
      for (const metric of candidates) {
        if (channel === "instagram" && mediaType === "CAROUSEL_ALBUM" && ["reach", "likes", "comments", "shares", "saved"].includes(metric)) {
          unavailable.push(metric); continue;
        }
        try {
          const response = channel === "facebook"
            ? await get(`${endpoint(postId)}/insights`, { ...credentials, params: { metric } })
            : await get(`${endpoint(postId)}/insights`, { ...credentials, params: { metric } });
          const record = Array.isArray(response?.data?.data) ? response.data.data.find((row) => row.name === metric) : null;
          const value = record?.values?.[0]?.value;
          if (typeof value === "number" && Number.isFinite(value)) metrics[metric] = value;
          else unavailable.push(metric);
        } catch { unavailable.push(metric); }
      }
      return { status: Object.keys(metrics).length ? "available" : "unavailable", metrics, unavailable: [...new Set(unavailable)] };
    },
  };
}

module.exports = { createMetaSocialAnalyticsAdapter, FB_METRICS, IG_METRICS };
