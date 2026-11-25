"use strict";

const { buildPublicIntelligenceSession } = require("./public-intelligence");
const { buildOyiCoreCorporateConversationRequest, callOyiCoreCorporateConversation } = require("./oyi-core-gateway");
const { replyPolicy, sendSocialReply, socialAiEnabled, socialAiActive, SOCIAL_AI_ACTOR } = require("./meta-social-replies");
const { evaluateChannelAutonomy } = require("./channel-autonomy");

async function continueSocialConversation({ config, store, adapter, message, audit, generate = callOyiCoreCorporateConversation }) {
  const { channel, senderKey, eventKey, occurredAt, optedOut, text } = message;
  if (!socialAiEnabled(config, channel) || optedOut) return;
  const lead = await store.findMetaSocialAiLead(senderKey);
  if (!lead || replyPolicy(config, lead, channel) || Date.parse(lead.meta_social_last_inbound_at) !== Date.parse(occurredAt)) return;
  const state = await store.getLeadChannelState(lead.id, channel);
  const revision = Number(state?.social_ownership_revision);
  const initialPolicy = await evaluateChannelAutonomy(store, channel, { configured: socialAiEnabled(config, channel) });
  if (!initialPolicy.allowed || !socialAiActive(state) || !Number.isSafeInteger(revision) || revision < 1) {
    if (!initialPolicy.allowed) await audit(lead.id, `communication.${channel}.ai_generation`, "suppressed", { event_key: eventKey, reason: initialPolicy.reason });
    return;
  }
  const unresolved = await store.listSocialManualSends(lead.id, channel, { unresolved: true });
  if (!Array.isArray(unresolved) || unresolved.length) return;
  let rows;
  try {
    rows = await store.getMetaSocialAiContext(lead.id, channel, 201);
  } catch {
    await audit(lead.id, `communication.${channel}.ai_generation`, "suppressed",
      { event_key: eventKey, reason: "conversation_context_unavailable" });
    return;
  }
  const history = normalizeVerifiedHistory(rows, { channel, eventKey, occurredAt, currentText: text });
  if (!history) {
    await audit(lead.id, `communication.${channel}.ai_generation`, "suppressed",
      { event_key: eventKey, reason: "conversation_context_incomplete" });
    return;
  }
  await audit(lead.id, `communication.${channel}.ai_generation`, "started", { event_key: eventKey });
  let previousThread;
  try { previousThread = await store.getSocialAiThread(lead.id, channel); }
  catch {
    await audit(lead.id, `communication.${channel}.ai_generation`, "suppressed",
      { event_key: eventKey, reason: "conversation_thread_unavailable" });
    return;
  }
  const session = buildPublicIntelligenceSession({
    source_site: channel, source_channel: channel, channel, lead_id: lead.id, message: text,
  });
  let result;
  try {
    result = await generate(config, buildOyiCoreCorporateConversationRequest({
      session, lead, message: text, requestId: eventKey,
      body: {
        source: channel,
        source_channel: channel,
        conversation_thread_id: previousThread,
        verified_conversation_context: {
          version: 1, source: "office_crm", channel, lead_ref: lead.id,
          conversation_thread_id: previousThread || null, complete: true,
          current_event_id: eventKey, messages: history,
        },
      },
    }));
  } catch {
    await audit(lead.id, `communication.${channel}.ai_generation`, "suppressed",
      { event_key: eventKey, reason: "oyi_core_unavailable" });
    return;
  }
  const [currentLead, currentState, currentPolicy] = await Promise.all([
    store.getMetaSocialReplyLead(lead.id).catch(() => null),
    store.getLeadChannelState(lead.id, channel).catch(() => null),
    evaluateChannelAutonomy(store, channel, { configured: socialAiEnabled(config, channel) }),
  ]);
  if (!currentLead || replyPolicy(config, currentLead, channel) || !currentPolicy.allowed ||
      !socialAiActive(currentState) || Number(currentState?.social_ownership_revision) !== revision) {
    await audit(lead.id, `communication.${channel}.ai_generation`, "suppressed",
      { event_key: eventKey, reason: !currentPolicy.allowed ? currentPolicy.reason : "social_ai_state_changed" });
    return;
  }
  let currentRows;
  let currentThread;
  try {
    currentRows = await store.getMetaSocialAiContext(lead.id, channel, 201);
    currentThread = await store.getSocialAiThread(lead.id, channel);
  } catch {
    await audit(lead.id, `communication.${channel}.ai_generation`, "suppressed",
      { event_key: eventKey, reason: "conversation_context_recheck_unavailable" });
    return;
  }
  const currentHistory = normalizeVerifiedHistory(currentRows, { channel, eventKey, occurredAt, currentText: text });
  if (!currentHistory || JSON.stringify(currentHistory) !== JSON.stringify(history) || currentThread !== previousThread) {
    await audit(lead.id, `communication.${channel}.ai_generation`, "suppressed",
      { event_key: eventKey, reason: "conversation_context_changed" });
    return;
  }
  const answer = result?.ok && typeof result.response?.answer === "string" ? result.response.answer.trim() : "";
  if (!answer || answer.length > 1000 || result.response?.handoff_recommended) {
    await audit(lead.id, `communication.${channel}.ai_generation`, "suppressed",
      { event_key: eventKey, reason: result?.response?.handoff_recommended ? "handoff_recommended" : "no_safe_answer" });
    return;
  }
  const returnedThread = String(result.response?.conversation_thread_id || "");
  if (!returnedThread || (previousThread && returnedThread !== previousThread)) {
    await audit(lead.id, `communication.${channel}.ai_generation`, "suppressed",
      { event_key: eventKey, reason: "conversation_thread_mismatch" });
    return;
  }
  const sent = await sendSocialReply({
    config, store, adapter, lead, channel, actorEmail: SOCIAL_AI_ACTOR,
    clientRequestId: `social-ai-${eventKey.slice(-64)}`, text: answer, autonomous: { revision, eventKey },
    audit: (action, status, metadata) => audit(lead.id, action, status, metadata),
  });
  if (sent.body.accepted) {
    await store.appendTimelineEvent({
      lead_id: lead.id, event_type: "oyi_core_social_turn", actor: SOCIAL_AI_ACTOR,
      title: "Oyi reply accepted by Meta",
      metadata: { channel, oyi_thread_id: returnedThread, send_id: sent.body.send_id },
    });
  }
}

function normalizeVerifiedHistory(rows, { channel, eventKey, occurredAt, currentText }) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 200) return null;
  const byId = new Map();
  for (const row of rows) {
    if (!row || row.channel !== channel || !["user", "assistant"].includes(row.message_role)) return null;
    const id = String(row.correlation_id || row.external_message_id || row.id || "").trim();
    const content = String(row.content || "");
    const createdAt = String(row.created_at || "");
    if (!id || !content.trim() || content.length > 4000 || !Number.isFinite(Date.parse(createdAt))) return null;
    const role = row.message_role === "user" ? "customer"
      : row.agent_name === SOCIAL_AI_ACTOR ? "assistant" : "staff";
    const normalized = { message_id: id, role, text: content, created_at: new Date(createdAt).toISOString() };
    const prior = byId.get(id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(normalized)) return null;
    byId.set(id, normalized);
  }
  const history = [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const currentIndex = history.findIndex((row) => row.message_id === eventKey);
  if (currentIndex < 0) return null;
  const [current] = history.splice(currentIndex, 1);
  if (current.role !== "customer" || current.text !== currentText ||
      Date.parse(current.created_at) !== Date.parse(occurredAt) ||
      history.some((row) => row.created_at > current.created_at)) return null;
  history.push(current);
  return history;
}

module.exports = { continueSocialConversation, normalizeVerifiedHistory };
