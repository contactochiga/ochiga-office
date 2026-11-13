"use strict";

// Content → Posts & Comments, C2: read-only lookups of Facebook Page posts and Instagram media for the Content module.
// GET requests only; no publishing, replies or moderation. Every result is bound to the configured Page or Instagram
// account, preview and permalink URLs are limited to Meta's own hosts, and the access token travels in the Authorization
// header (never in a URL, log or response).

const axios = require("axios");

const FB_FIELDS = "id,message,created_time,updated_time,permalink_url,full_picture,from";
const IG_FIELDS = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,owner";
const POST_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const ASSET_ID = /^[0-9]{1,32}$/;
const PREVIEW_HOST = /^https:\/\/[a-z0-9.-]+\.(fbcdn\.net|cdninstagram\.com)\//i;
const PERMALINK = /^https:\/\/(www\.)?(facebook\.com|instagram\.com)\//i;

const isoOrNull = (value) => { const t = Date.parse(value); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const clip = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const safeUrl = (value, pattern) => (typeof value === "string" && value.length <= 2000 && pattern.test(value) ? value : null);

function assetFor(config, channel) {
  const id = channel === "facebook" ? config.facebookPageId : config.instagramBusinessAccountId;
  return ASSET_ID.test(id || "") ? id : null;
}

// Classifies a Graph failure without keeping its message: unavailable (deleted or not visible), restricted
// (token or permission), or error (anything else, including no response; retryable).
function graphFailure(error) {
  const status = error?.response?.status;
  const graph = error?.response?.data?.error || {};
  if (status === 404 || (graph.code === 100 && graph.error_subcode === 33)) return { status: "unavailable", error: "graph_100_33" };
  if ([10, 200, 190, 3].includes(graph.code) || [401, 403].includes(status)) return { status: "restricted", error: `graph_${Number.isInteger(graph.code) ? graph.code : status}` };
  return { status: "error", error: Number.isInteger(status) ? `graph_http_${status}` : "graph_no_response" };
}

// Maps a Graph object to a snapshot, or null when it does not belong to the configured asset.
function snapshotOf(channel, asset, raw) {
  if (!raw || !POST_ID.test(raw.id || "")) return null;
  if (channel === "facebook") {
    if (!raw.id.startsWith(`${asset}_`) || (raw.from && raw.from.id !== asset)) return null;
    return { channel, asset, providerPostId: raw.id, caption: clip(raw.message, 8000), permalink: safeUrl(raw.permalink_url, PERMALINK),
      mediaType: raw.full_picture ? "image" : "text", previewUrl: safeUrl(raw.full_picture, PREVIEW_HOST),
      publishedAt: isoOrNull(raw.created_time), providerUpdatedAt: isoOrNull(raw.updated_time) };
  }
  if (raw.owner && raw.owner.id !== asset) return null;
  return { channel, asset, providerPostId: raw.id, caption: clip(raw.caption, 8000), permalink: safeUrl(raw.permalink, PERMALINK),
    mediaType: clip(String(raw.media_type || "").toLowerCase(), 40), previewUrl: safeUrl(raw.thumbnail_url || raw.media_url, PREVIEW_HOST),
    publishedAt: isoOrNull(raw.timestamp), providerUpdatedAt: null };
}

function createMetaSocialPostsAdapter(config, request = axios.get) {
  const ready = (channel) => {
    const asset = assetFor(config, channel);
    const token = channel === "instagram" ? config.instagramAccessToken || config.facebookPageAccessToken : config.facebookPageAccessToken;
    if (!asset || !token || !/^v[0-9]+\.[0-9]+$/.test(config.metaSocialGraphVersion || "")) return null;
    return { asset, headers: { Authorization: `Bearer ${token}` } };
  };
  const get = (path, params, auth) => request(`https://graph.facebook.com/${config.metaSocialGraphVersion}/${path}`,
    { params, headers: auth.headers, timeout: 10_000, maxRedirects: 0 });

  return {
    configured: (channel) => Boolean(ready(channel)),
    // Recent posts of the configured asset. Items that fail the asset binding are dropped and counted.
    async listRecent(channel, limit = 25) {
      const auth = ready(channel);
      if (!auth) return { status: "error", error: "not_configured", posts: [], rejected: 0 };
      let response;
      try {
        response = channel === "facebook"
          ? await get(`${auth.asset}/posts`, { fields: FB_FIELDS, limit }, auth)
          : await get(`${auth.asset}/media`, { fields: IG_FIELDS, limit }, auth);
      } catch (error) {
        return { ...graphFailure(error), posts: [], rejected: 0 };
      }
      const rows = Array.isArray(response?.data?.data) ? response.data.data.slice(0, 100) : null;
      if (!rows) return { status: "error", error: "graph_malformed", posts: [], rejected: 0 };
      const posts = rows.map((raw) => snapshotOf(channel, auth.asset, raw));
      return { status: "synced", posts: posts.filter(Boolean), rejected: posts.filter((p) => !p).length };
    },
    // One post by its platform id. A post outside the configured asset is never looked up or stored.
    async lookup(channel, providerPostId) {
      const auth = ready(channel);
      if (!auth) return { status: "error", error: "not_configured" };
      if (!POST_ID.test(providerPostId || "") || (channel === "facebook" && !providerPostId.startsWith(`${auth.asset}_`))) {
        return { status: "restricted", error: "foreign_asset" };
      }
      try {
        const response = await get(encodeURIComponent(providerPostId), { fields: channel === "facebook" ? FB_FIELDS : IG_FIELDS }, auth);
        const snapshot = snapshotOf(channel, auth.asset, response?.data);
        return snapshot ? { status: "synced", snapshot } : { status: "restricted", error: "foreign_asset" };
      } catch (error) {
        return graphFailure(error);
      }
    },
  };
}

module.exports = { createMetaSocialPostsAdapter, snapshotOf, graphFailure, PREVIEW_HOST, PERMALINK };
