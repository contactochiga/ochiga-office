"use strict";

// Content → Posts & Comments, C3: hide/unhide of public Facebook and Instagram comments. No deletion, no replies, no AI and
// nothing automatic: every action is a staff request with a reason, claimed in the database ledger before any Graph call.
// Success is never inferred from a submitted request: an action is 'confirmed' only when a read-back shows the requested
// state. Definitive refusals (expired token, revoked permission, comment gone) are 'failed' with no change. Anything else
// (throttling, timeout, 5xx, malformed reply, read-back unavailable) is decided by read-back, or stays 'unknown' until
// reconciled. Hide and unhide are idempotent, so a repeated request is harmless.

const axios = require("axios");

const COMMENT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const THROTTLE_CODES = new Set([4, 17, 32, 613]);
const NOT_APPLIED_AFTER_MS = 60_000; // a read-back this long after dispatch that still shows the old state means it did not apply

function classify(error) {
  const status = error?.response?.status;
  const graph = error?.response?.data?.error || {};
  if (status === 429 || THROTTLE_CODES.has(graph.code)) return { kind: "uncertain", failure: "throttled", code: status ?? null };
  if (graph.code === 190) return { kind: "refused", failure: "token_invalid", code: status ?? null };
  if (status === 404 || (graph.code === 100 && graph.error_subcode === 33)) return { kind: "refused", failure: "comment_unavailable", code: status ?? null };
  if ([10, 200, 3].includes(graph.code) || [401, 403].includes(status)) return { kind: "refused", failure: "permission_denied", code: status ?? null };
  return { kind: "uncertain", failure: Number.isInteger(status) ? `graph_http_${status}` : "graph_no_response", code: status ?? null };
}

function createMetaSocialModerationAdapter(config, { post = axios.post, get = axios.get } = {}) {
  const auth = (channel) => {
    const token = channel === "instagram" ? config.instagramAccessToken || config.facebookPageAccessToken : config.facebookPageAccessToken;
    if (!token || !/^v[0-9]+\.[0-9]+$/.test(config.metaSocialGraphVersion || "")) return null;
    return { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000, maxRedirects: 0 };
  };
  const url = (id) => `https://graph.facebook.com/${config.metaSocialGraphVersion}/${encodeURIComponent(id)}`;
  return {
    configured: (channel) => Boolean(auth(channel)),
    // One idempotent request. Returns {kind:'accepted'|'refused'|'uncertain', failure, code}. 'accepted' is not success.
    async setHidden(channel, commentId, hidden) {
      const options = auth(channel);
      if (!options || !COMMENT_ID.test(commentId || "")) return { kind: "refused", failure: "not_configured", code: null };
      const params = channel === "facebook" ? { is_hidden: hidden } : { hide: hidden };
      try {
        const response = await post(url(commentId), null, { ...options, params });
        if (response?.status >= 200 && response.status < 300 && response.data?.success === true) return { kind: "accepted", failure: null, code: response.status };
        return { kind: "uncertain", failure: "graph_malformed", code: response?.status ?? null };
      } catch (error) {
        return classify(error);
      }
    },
    // Trusted read-back of the comment's current visibility. For Instagram the comment must belong to the stored post.
    async readBack(channel, commentId, providerPostId) {
      const options = auth(channel);
      if (!options || !COMMENT_ID.test(commentId || "")) return { failure: "not_configured" };
      try {
        const response = await get(url(commentId), { ...options, params: { fields: channel === "facebook" ? "id,is_hidden" : "id,hidden,media" } });
        const data = response?.data || {};
        if (data.id !== commentId) return { failure: "graph_malformed" };
        if (channel === "instagram") {
          if (!data.media || data.media.id !== providerPostId) return { failure: "foreign_post" };
          if (typeof data.hidden !== "boolean") return { failure: "graph_malformed" };
          return { visibility: data.hidden ? "hidden" : "visible" };
        }
        if (typeof data.is_hidden !== "boolean") return { failure: "graph_malformed" };
        return { visibility: data.is_hidden ? "hidden" : "visible" };
      } catch (error) {
        return { failure: classify(error).failure };
      }
    },
  };
}

const wanted = (action) => (action === "hide" ? "hidden" : "visible");
const STATE_HTTP = { confirmed: 200, failed: 409, unknown: 202, pending: 202, dispatched: 202 };

// Decides an outcome from a read-back. sentAt is when the request was dispatched (null if it never was).
function decide(action, readBack, { requestKind, sentAt, now = Date.now() }) {
  if (readBack.visibility === wanted(action)) return { status: "confirmed", observed: readBack.visibility };
  if (readBack.visibility) {
    if (requestKind === "refused") return { status: "failed", observed: readBack.visibility };
    const settledLongEnough = !sentAt || now - Date.parse(sentAt) >= NOT_APPLIED_AFTER_MS;
    return settledLongEnough ? { status: "failed", observed: readBack.visibility, failure: "not_applied" } : { status: "unknown", observed: readBack.visibility, failure: "not_yet_applied" };
  }
  if (["comment_unavailable", "foreign_post"].includes(readBack.failure)) return { status: "failed", failure: readBack.failure };
  return { status: "unknown", failure: readBack.failure || "readback_unavailable" };
}

async function moderateComment({ store, adapter, comment, post, action, actor, requestId, reason, audit }) {
  const claim = await store.claimCommentModeration({ commentId: comment.id, action, actorId: actor.id, actorEmail: actor.email, requestId, reason });
  if (claim.outcome === "not_actionable") return { httpStatus: 409, body: { error: "comment_not_actionable" } };
  if (claim.outcome === "blocked") return { httpStatus: 409, body: { error: "moderation_in_progress" } };
  if (claim.outcome === "request_reused") return { httpStatus: 409, body: { error: "request_id_reused" } };
  if (claim.outcome === "duplicate") return { httpStatus: STATE_HTTP[claim.status] || 202, body: { duplicate: true, action_id: claim.id, state: claim.status, failure_reason: claim.failure_reason || null } };

  const actionId = claim.id;
  await audit("requested", { action_id: actionId, action });
  if (!(await store.markCommentModerationDispatched(actionId))) return { httpStatus: 409, body: { error: "moderation_state_changed", action_id: actionId } };
  const sentAt = new Date().toISOString();
  const request = await adapter.setHidden(post.channel, comment.provider_comment_id, action === "hide");
  let outcome;
  if (request.kind === "refused" && request.failure !== "comment_unavailable") {
    outcome = { status: "failed", failure: request.failure, resolvedBy: "refusal" };
  } else {
    const readBack = await adapter.readBack(post.channel, comment.provider_comment_id, post.provider_post_id);
    const decision = decide(action, readBack, { requestKind: request.kind, sentAt });
    outcome = { ...decision, failure: decision.failure || (decision.status === "confirmed" ? null : request.failure), resolvedBy: "readback" };
  }
  await store.settleCommentModeration({ actionId, status: outcome.status, observed: outcome.observed || null, code: request.code ?? null, failure: outcome.failure || null, resolvedBy: outcome.resolvedBy });
  await audit(outcome.status, { action_id: actionId, action, state: outcome.status, failure_reason: outcome.failure || null });
  return { httpStatus: STATE_HTTP[outcome.status], body: { ok: outcome.status === "confirmed", action_id: actionId, state: outcome.status, visibility: outcome.observed || null, failure_reason: outcome.failure || null } };
}

// Re-check an open (pending/dispatched/unknown) action by read-back only. Never sends a moderation request.
async function reconcileModeration({ store, adapter, action, comment, post, audit, now = Date.now() }) {
  if (!["pending", "dispatched", "unknown"].includes(action.status)) return { httpStatus: 409, body: { error: "moderation_already_settled", state: action.status } };
  const readBack = await adapter.readBack(post.channel, comment.provider_comment_id, post.provider_post_id);
  const decision = decide(action.action, readBack, { requestKind: action.status === "pending" ? "refused" : "uncertain", sentAt: action.dispatch_at, now });
  await store.settleCommentModeration({ actionId: action.id, status: decision.status, observed: decision.observed || null, code: null, failure: decision.failure || null, resolvedBy: "reconcile" });
  await audit(`reconciled_${decision.status}`, { action_id: action.id, action: action.action, state: decision.status, failure_reason: decision.failure || null });
  return { httpStatus: STATE_HTTP[decision.status], body: { ok: decision.status === "confirmed", action_id: action.id, state: decision.status, visibility: decision.observed || null, failure_reason: decision.failure || null } };
}

module.exports = { createMetaSocialModerationAdapter, moderateComment, reconcileModeration, decide, classify, NOT_APPLIED_AFTER_MS };
