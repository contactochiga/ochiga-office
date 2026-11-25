"use strict";

const { normalizePhone } = require("./normalize-lead");
const { describeInboundMessage, customerAuthoredText } = require("./whatsapp-media");

const MAX_MESSAGES = 200;
const MAX_CURRENT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;

function text(value) {
  return String(value ?? "");
}

function isProviderId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}

function messageRow(messageId, role, content, createdAt) {
  const parsed = Date.parse(createdAt || "");
  if (!isProviderId(String(messageId || "")) || !["customer", "staff", "assistant"].includes(role) ||
      typeof content !== "string" || !content.trim() || content.length > 4000 || !Number.isFinite(parsed)) return null;
  return { message_id: String(messageId), role, text: content, created_at: new Date(parsed).toISOString() };
}

function sameMessage(a, b) {
  return a.message_id === b.message_id && a.role === b.role && a.text === b.text && a.created_at === b.created_at;
}

function ownershipFingerprint(state) {
  if (!state || !state.updated_at || !Number.isFinite(Date.parse(state.updated_at))) return null;
  return JSON.stringify({
    id: state.id || null,
    human_status: state.human_status || "auto",
    human_owner: state.human_owner || null,
    ai_paused: Boolean(state.ai_paused),
    takeover_started_at: state.takeover_started_at || null,
    takeover_reason: state.takeover_reason || null,
    resume_mode: state.resume_mode || "manual_only",
    ownership_revision: Number.isSafeInteger(Number(state.social_ownership_revision)) ? Number(state.social_ownership_revision) : null,
    updated_at: new Date(state.updated_at).toISOString(),
  });
}

function sourceIntegrity(sources) {
  return JSON.stringify({
    inboundEvents: sources.inboundEvents.map((row) => [row.id, row.lead_id, row.external_event_id, row.created_at, row.payload]),
    activities: sources.activities.map((row) => [row.id, row.lead_id, row.body, row.occurred_at, row.created_at, row.metadata]),
    manualSends: sources.manualSends.map((row) => [row.id, row.status, row.recipient, row.provider_message_id, row.actor_email, row.body, row.created_at]),
    aiTurns: sources.aiTurns.map((row) => [row.id, row.event_type, row.body, row.created_at, row.metadata]),
  });
}

function buildVerifiedWhatsAppContext({ lead, event, sources, now = Date.now() } = {}) {
  if (!lead?.id || !event || !isProviderId(event.message_id) || !Array.isArray(sources?.inboundEvents) ||
      !Array.isArray(sources?.activities) || !Array.isArray(sources?.manualSends) || !Array.isArray(sources?.aiTurns)) {
    return { ok: false, reason: "conversation_context_unavailable" };
  }
  const leadPhone = normalizePhone(lead.whatsapp_phone || lead.phone || "");
  const eventPhone = normalizePhone(event.from || "");
  if (!leadPhone || leadPhone !== eventPhone) return { ok: false, reason: "conversation_identity_mismatch" };
  if ([sources.inboundEvents, sources.activities, sources.manualSends, sources.aiTurns].some((rows) => rows.length > MAX_MESSAGES)) {
    return { ok: false, reason: "conversation_context_too_large" };
  }

  const messagesById = new Map();
  const inboundByProviderId = new Map();
  for (const stored of sources.inboundEvents) {
    if (stored?.channel !== "whatsapp" || stored.event_type !== "message" || stored.lead_id !== lead.id) {
      return { ok: false, reason: "conversation_history_invalid" };
    }
    const payload = stored.payload && typeof stored.payload === "object" ? stored.payload : null;
    const providerId = String(stored.external_event_id || "");
    if (!payload || !isProviderId(providerId) || payload.id !== providerId || normalizePhone(payload.from || "") !== leadPhone) {
      return { ok: false, reason: "conversation_message_identity_invalid" };
    }
    const seconds = Number(payload.timestamp);
    const occurredAt = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : "";
    if (!occurredAt) return { ok: false, reason: "conversation_message_timestamp_invalid" };
    const described = describeInboundMessage(payload);
    const authored = customerAuthoredText(described);
    if (!authored) return { ok: false, reason: "conversation_content_unavailable" };
    const content = authored;
    const row = messageRow(providerId, "customer", content, occurredAt);
    if (!row) return { ok: false, reason: "conversation_message_invalid" };
    const previous = messagesById.get(providerId);
    if (previous && !sameMessage(previous, row)) return { ok: false, reason: "conversation_provider_id_conflict" };
    messagesById.set(providerId, row);
    inboundByProviderId.set(providerId, { row, requestId: "", activity: null });
  }

  const activityByProviderId = new Map();
  for (const activity of sources.activities) {
    if (activity?.lead_id !== lead.id || activity.activity_type !== "whatsapp_message") continue;
    const metadata = activity.metadata && typeof activity.metadata === "object" ? activity.metadata : {};
    const providerId = String(metadata.provider_message_id || metadata.external_message_id || "");
    if (!providerId) continue;
    if (!inboundByProviderId.has(providerId)) return { ok: false, reason: "conversation_activity_unmatched" };
    if (activityByProviderId.has(providerId)) return { ok: false, reason: "conversation_activity_duplicate" };
    activityByProviderId.set(providerId, { ...activity, metadata });
    inboundByProviderId.get(providerId).requestId = String(metadata.request_id || "");
    inboundByProviderId.get(providerId).activity = activity;
  }
  if ([...inboundByProviderId.values()].some((entry) => !entry.activity)) {
    return { ok: false, reason: "conversation_activity_missing" };
  }
  const currentActivity = activityByProviderId.get(event.message_id);
  if (!currentActivity || currentActivity.metadata.channel !== "whatsapp" || currentActivity.metadata.direction !== "inbound") {
    return { ok: false, reason: "conversation_current_activity_mismatch" };
  }

  for (const send of sources.manualSends) {
    if (send?.lead_id !== lead.id || send.channel !== "whatsapp") return { ok: false, reason: "conversation_send_identity_invalid" };
    if (["pending", "outcome_unknown"].includes(send.status)) return { ok: false, reason: "conversation_send_unresolved" };
    if (["not_sent", "provider_rejected"].includes(send.status)) continue;
    if (send.status !== "provider_accepted") return { ok: false, reason: "conversation_send_state_invalid" };
    const recipient = normalizePhone(send.recipient || "");
    if (!recipient || recipient !== leadPhone || !isProviderId(send.provider_message_id)) {
      return { ok: false, reason: "conversation_send_identity_invalid" };
    }
    if (!String(send.actor_email || "").trim()) return { ok: false, reason: "conversation_send_identity_invalid" };
    const row = messageRow(send.provider_message_id, "staff", text(send.body), send.created_at);
    if (!row) return { ok: false, reason: "conversation_send_invalid" };
    const previous = messagesById.get(row.message_id);
    if (previous && !sameMessage(previous, row)) return { ok: false, reason: "conversation_provider_id_conflict" };
    messagesById.set(row.message_id, row);
  }

  const threadIds = new Set();
  for (const turn of sources.aiTurns) {
    if (turn?.lead_id !== lead.id || !["oyi_core_whatsapp_turn", "oyi_core_whatsapp_unavailable"].includes(turn.event_type)) {
      return { ok: false, reason: "conversation_ai_turn_invalid" };
    }
    const metadata = turn.metadata && typeof turn.metadata === "object" ? turn.metadata : {};
    const requestId = String(metadata.request_id || "");
    const linkedInbound = [...inboundByProviderId.entries()].find(([, value]) => value.requestId && value.requestId === requestId);
    if (!requestId || !linkedInbound) return { ok: false, reason: "conversation_ai_turn_unmatched" };
    const [providerId, inbound] = linkedInbound;
    const activity = activityByProviderId.get(providerId);
    if (!activity) return { ok: false, reason: "conversation_ai_turn_unmatched" };
    if (activity.metadata.ai_replied !== true) {
      if (turn.event_type === "oyi_core_whatsapp_turn") return { ok: false, reason: "conversation_ai_turn_delivery_unverified" };
      continue;
    }
    const threadId = String(metadata.oyi_thread_id || "");
    if (turn.event_type === "oyi_core_whatsapp_turn") {
      if (!threadId) return { ok: false, reason: "conversation_thread_missing" };
      threadIds.add(threadId);
    }
    const sentAt = Date.parse(turn.created_at || "");
    if (!Number.isFinite(sentAt) || sentAt <= Date.parse(inbound.row.created_at)) {
      return { ok: false, reason: "conversation_ai_turn_order_invalid" };
    }
    const row = messageRow(turn.id, "assistant", text(turn.body), turn.created_at);
    if (!row || row.text.length >= 500) return { ok: false, reason: "conversation_ai_turn_truncated" };
    const previous = messagesById.get(row.message_id);
    if (previous && !sameMessage(previous, row)) return { ok: false, reason: "conversation_provider_id_conflict" };
    messagesById.set(row.message_id, row);
  }
  if (threadIds.size > 1) return { ok: false, reason: "conversation_thread_conflict" };

  const messages = [...messagesById.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id));
  if (!messages.length || messages.length > MAX_MESSAGES) return { ok: false, reason: "conversation_context_incomplete" };
  const latest = messages[messages.length - 1];
  const currentInbound = inboundByProviderId.get(event.message_id)?.row;
  const currentAt = currentInbound ? Date.parse(currentInbound.created_at) : NaN;
  if (!currentInbound || currentInbound.text !== String(event.text || "") || latest.message_id !== event.message_id ||
      !Number.isFinite(currentAt) || currentAt > now + MAX_FUTURE_SKEW_MS || now - currentAt > MAX_CURRENT_AGE_MS) {
    return { ok: false, reason: "conversation_current_event_mismatch" };
  }

  const conversationThreadId = threadIds.size ? [...threadIds][0] : null;
  return {
    ok: true,
    integrity: sourceIntegrity(sources),
    context: {
      version: 1,
      source: "office_crm",
      channel: "whatsapp",
      lead_ref: lead.id,
      conversation_thread_id: conversationThreadId,
      complete: true,
      current_event_id: event.message_id,
      messages,
    },
  };
}

module.exports = { buildVerifiedWhatsAppContext, ownershipFingerprint, sourceIntegrity, MAX_MESSAGES };
