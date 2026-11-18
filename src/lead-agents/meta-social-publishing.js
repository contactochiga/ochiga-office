"use strict";

// Facebook Page and Instagram professional-account publishing. This adapter never decides whether a
// staff action is allowed; the caller has already checked permission, approval, asset and feature flag.
// Any ambiguous provider result remains UNKNOWN because Meta does not accept our idempotency key.
const axios = require("axios");

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const SAFE_PERMALINK = /^https:\/\/(www\.)?(facebook\.com|instagram\.com)\//i;

function classifyPublishError(error) {
  const status = error?.response?.status;
  const graph = error?.response?.data?.error || {};
  if (graph.code === 190) return { status: "failed", code: "token_invalid" };
  if ([10, 200, 3].includes(graph.code) || [401, 403].includes(status)) return { status: "failed", code: "permission_denied" };
  if (graph.code === 100 || graph.code === 120) return { status: "failed", code: "invalid_publish_request" };
  if (status === 429 || [4, 17, 32, 613, 80001].includes(graph.code)) return { status: "unknown", code: "rate_limited" };
  return { status: "unknown", code: Number.isInteger(status) ? `graph_http_${status}` : "provider_outcome_unknown" };
}

function normalizePublished(result, { pagePhoto = false } = {}) {
  const id = pagePhoto ? result?.post_id : (result?.id || result?.post_id);
  if (pagePhoto && typeof id !== "string") {
    return { status: "unknown", code: "page_post_id_missing", providerMediaId: typeof result?.id === "string" ? result.id : null };
  }
  if (typeof id !== "string" || !SAFE_ID.test(id)) return { status: "unknown", code: "graph_malformed_response" };
  return { status: "published", providerPostId: id,
    providerMediaId: pagePhoto && typeof result?.id === "string" && result.id !== id ? result.id : null,
    permalink: typeof result.permalink_url === "string" && SAFE_PERMALINK.test(result.permalink_url) ? result.permalink_url : null };
}

function createMetaSocialPublishingAdapter(config, { post = axios.post, get = axios.get, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const auth = (channel) => {
    const asset = channel === "facebook" ? config.facebookPageId : config.instagramBusinessAccountId;
    const token = channel === "instagram" ? config.instagramAccessToken || config.facebookPageAccessToken : config.facebookPageAccessToken;
    if (!/^\d{1,32}$/.test(asset || "") || !token || !/^v\d+\.\d+$/.test(config.metaSocialGraphVersion || "")) return null;
    return { asset, headers: { Authorization: `Bearer ${token}` }, timeout: 25_000, maxRedirects: 0 };
  };
  const endpoint = (id) => `https://graph.facebook.com/${config.metaSocialGraphVersion}/${String(id).split("/").map(encodeURIComponent).join("/")}`;
  const checkedMediaUrl = (value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2048) return null;
      // Only public Oyi/Sanity media or a short-lived Office media grant is accepted by the adapter.
      const host = url.hostname.toLowerCase();
      const trustedHost = host === "ochiga.com.ng" || host.endsWith(".ochiga.com.ng") || host === "sanity.io" || host.endsWith(".sanity.io");
      if (!trustedHost) return null;
      return url.href;
    } catch { return null; }
  };

  return {
    configured: (channel) => Boolean(auth(channel)),
    async publish(channel, content) {
      const credentials = auth(channel);
      if (!credentials) return { status: "failed", code: "not_configured" };
      if (!content || typeof content.caption !== "string" || content.caption.length > 2200) return { status: "failed", code: "invalid_caption" };
      try {
        if (channel === "facebook") {
          if (content.mediaType === "video") {
            const mediaUrl = checkedMediaUrl(content.mediaUrl);
            if (!mediaUrl) return { status: "failed", code: "media_url_not_public" };
            const response = await post(endpoint(`${credentials.asset}/videos`), null, { ...credentials, params: { file_url: mediaUrl, description: content.caption } });
            return normalizePublished(response?.data);
          }
          if (content.mediaUrl) {
            const mediaUrl = checkedMediaUrl(content.mediaUrl);
            if (!mediaUrl) return { status: "failed", code: "media_url_not_public" };
            const response = await post(endpoint(`${credentials.asset}/photos`), null, { ...credentials, params: { url: mediaUrl, caption: content.caption, published: true } });
            return normalizePublished(response?.data, { pagePhoto: true });
          }
          const response = await post(endpoint(`${credentials.asset}/feed`), null, { ...credentials, params: { message: content.caption } });
          return normalizePublished(response?.data);
        }

        const mediaUrl = checkedMediaUrl(content.mediaUrl);
        if (!mediaUrl) return { status: "failed", code: "media_url_not_public" };
        const video = content.mediaType === "video";
        const createParams = video
          ? { media_type: "REELS", video_url: mediaUrl, caption: content.caption }
          : { image_url: mediaUrl, caption: content.caption };
        const container = await post(endpoint(`${credentials.asset}/media`), null, { ...credentials, params: createParams });
        const creationId = container?.data?.id;
        if (typeof creationId !== "string" || !SAFE_ID.test(creationId)) return { status: "unknown", code: "media_container_unconfirmed" };
        if (video) {
          let ready = false;
          for (let attempt = 0; attempt < 12; attempt++) {
            const status = await get(endpoint(creationId), { ...credentials, params: { fields: "status_code" } });
            if (status?.data?.status_code === "FINISHED") { ready = true; break; }
            if (["ERROR", "EXPIRED"].includes(status?.data?.status_code)) return { status: "failed", code: "media_processing_failed" };
            await sleep(Math.min(1000 * (attempt + 1), 5000));
          }
          if (!ready) return { status: "failed", code: "media_processing_timeout" };
        }
        const result = await post(endpoint(`${credentials.asset}/media_publish`), null, { ...credentials, params: { creation_id: creationId } });
        return normalizePublished(result?.data);
      } catch (error) {
        return classifyPublishError(error);
      }
    },
  };
}

module.exports = { createMetaSocialPublishingAdapter, classifyPublishError, normalizePublished };
