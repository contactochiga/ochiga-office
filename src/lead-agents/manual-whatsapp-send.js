"use strict";

// Governed MANUAL WhatsApp send lifecycle (staff replies from the CRM relationship workspace).
//
// There is no transaction that spans Meta and the database, so exactly-once delivery cannot be promised. What IS guaranteed:
//   1. the authorised send intent is persisted BEFORE any provider call (unique per lead + staff actor + client request id);
//   2. a request id is claimed once: duplicates, concurrent duplicates (any process/instance) and restarts never cause a second provider call;
//   3. the outcome is recorded honestly: provider_accepted / provider_rejected / not_sent / outcome_unknown (we could not observe it) -- "delivered" and "read" exist
//      only as provider status events and are never inferred here;
//   4. an unknown outcome is NEVER retried automatically. It can only be resolved by evidence or by an explicit, audited staff decision (resolveManualSend);
//   5. if the provider accepted but the local conversation record could not be written, the durable send row is enough to repair the record later (no provider call).

const crypto = require("node:crypto");

const STALE_PENDING_MS = 2 * 60 * 1000;
const sha256 = (text) => crypto.createHash("sha256").update(String(text), "utf8").digest("hex");

async function withRetries(fn, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (i + 1)));
    }
  }
  return { ok: false, error: lastError };
}

function classifyProviderFailure(error) {
  const status = error?.response?.status;
  // 4xx = the provider answered and refused: definitively not sent. No response (timeout, reset) or 5xx: the message may or may not have been accepted.
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    const providerError = error.response?.data?.error || {};
    return { status: "provider_rejected", code: status, reason: String(providerError.code || providerError.type || `http_${status}`).slice(0, 120) };
  }
  return { status: "outcome_unknown", code: Number.isInteger(status) ? status : null, reason: Number.isInteger(status) ? `provider_http_${status}` : String(error?.code || error?.message || "no_provider_response").slice(0, 120) };
}

// Writes the customer-visible conversation row for an accepted send (idempotent through the unique correlation id) and marks the ledger row recorded.
async function persistAcceptedConversation(store, send) {
  const conversation = await store.appendConversation({
    lead_id: send.lead_id,
    agent_name: send.actor_email,
    message_role: "assistant",
    channel: "whatsapp",
    external_message_id: send.provider_message_id || null,
    content: send.body,
    correlation_id: send.id,
  });
  await store.updateManualSend(send.id, { conversation_id: conversation?.id || null, conversation_recorded_at: new Date().toISOString() });
  return conversation;
}

async function performManualSend({ store, adapter, lead, actorEmail, clientRequestId, text, audit = async () => {}, log = () => {} }) {
  const recipient = String(lead.whatsapp_phone || "").trim();
  const requestId = String(clientRequestId || "").trim().slice(0, 80) || `srv-${crypto.randomUUID()}`;
  const bodyHash = sha256(text);

  // 1. persist intent first; if the durable state is unreachable nothing is sent
  let claim;
  try {
    claim = await store.claimManualSend({ lead_id: lead.id, actor_email: actorEmail, client_request_id: requestId, channel: "whatsapp", recipient, body: text, body_hash: bodyHash });
  } catch (error) {
    log("error", "manual_whatsapp_send_state_unavailable", { lead_id: lead.id, error: String(error?.message || error).slice(0, 200) });
    await audit("communication.whatsapp.manual_reply", "failure", { reason: "send_state_unavailable", client_request_id: requestId }).catch(() => null);
    return { httpStatus: 503, body: { ok: false, error: "send_state_unavailable", detail: "The send could not be recorded durably, so nothing was sent." } };
  }
  if (!claim.claimed) {
    const existing = claim.record;
    if (existing.body_hash !== bodyHash) {
      await audit("communication.whatsapp.manual_reply", "failure", { reason: "request_id_reused_with_different_content", client_request_id: requestId, send_id: existing.id }).catch(() => null);
      return { httpStatus: 409, body: { ok: false, error: "request_id_reused", detail: "This request id was already used for different message content.", send_id: existing.id } };
    }
    return { httpStatus: 409, body: { ok: false, error: "duplicate_request", detail: "This message was already submitted. It was not sent again.", state: existing.status, send_id: existing.id, external_message_id: existing.provider_message_id || null } };
  }
  const send = claim.record;

  // 2. the only provider call for this request id
  let result = null;
  let providerError = null;
  try {
    result = await adapter.sendTextMessage({ to: recipient, body: text });
  } catch (error) {
    providerError = error;
  }

  let outcome;
  if (providerError) {
    const failure = classifyProviderFailure(providerError);
    outcome = { status: failure.status, provider_response_code: failure.code, failure_reason: failure.reason };
  } else if (result && result.delivered) {
    outcome = { status: "provider_accepted", provider_message_id: result.external_message_id || null, provider_response_code: result.response_code ?? null };
  } else {
    // adapter reported "not delivered" without an error (e.g. not configured): the request never reached the provider
    outcome = { status: "not_sent", provider_response_code: result?.response_code ?? null, failure_reason: result?.skipped ? "provider_not_configured" : "not_accepted" };
  }

  // 3. record the outcome durably (retried; a failure here is surfaced, never swallowed)
  const saved = await withRetries(() => store.updateManualSend(send.id, outcome));
  const stateRecorded = saved.ok;
  if (!stateRecorded) {
    log("error", "manual_whatsapp_send_outcome_unrecorded", { lead_id: lead.id, send_id: send.id, outcome: outcome.status, provider_message_id: outcome.provider_message_id || null });
  }

  // 4. provider accepted -> make the message part of the relationship history
  let recorded = false;
  if (outcome.status === "provider_accepted" && stateRecorded) {
    const persisted = await withRetries(() => persistAcceptedConversation(store, { ...send, ...outcome }));
    recorded = persisted.ok;
    if (!recorded) log("error", "manual_whatsapp_send_conversation_unrecorded", { lead_id: lead.id, send_id: send.id, error: String(persisted.error?.message || persisted.error).slice(0, 200) });
  }

  await audit("communication.whatsapp.manual_reply", outcome.status === "provider_accepted" ? "success" : "failure", {
    send_id: send.id, client_request_id: requestId, state: outcome.status, external_message_id: outcome.provider_message_id || null, provider_response_code: outcome.provider_response_code ?? null,
    failure_reason: outcome.failure_reason || null, state_recorded: stateRecorded, conversation_recorded: recorded, operator: actorEmail, recipient_present: Boolean(recipient),
  }).catch(() => null);

  const base = { send_id: send.id, state: stateRecorded ? outcome.status : outcome.status, state_recorded: stateRecorded, external_message_id: outcome.provider_message_id || null };
  if (outcome.status === "provider_accepted") return { httpStatus: 200, body: { ok: true, accepted: true, delivered: true, recorded, ...base } };
  if (outcome.status === "provider_rejected") return { httpStatus: 502, body: { ok: false, accepted: false, delivered: false, error: "provider_rejected", detail: "WhatsApp refused this message. It was not sent.", ...base } };
  if (outcome.status === "not_sent") return { httpStatus: 503, body: { ok: false, accepted: false, delivered: false, error: "whatsapp_not_configured", detail: "The message did not reach WhatsApp.", ...base } };
  return { httpStatus: 202, body: { ok: false, accepted: false, delivered: false, error: "outcome_unknown", detail: "No response was received from WhatsApp. The message may or may not have been sent: do not resend; verify in WhatsApp, then resolve this send.", ...base } };
}

// Local repair only -- never calls the provider. Stale `pending` rows (the process died or lost the response) become `outcome_unknown`; accepted rows whose
// conversation record is missing get it written (idempotent via the unique correlation id).
async function reconcileManualSends(store, leadId, { now = Date.now(), staleMs = STALE_PENDING_MS, log = () => {} } = {}) {
  const summary = { marked_unknown: 0, conversation_repaired: 0, errors: 0 };
  let sends = [];
  try {
    sends = await store.listManualSendsForLead(leadId, 200);
  } catch (error) {
    log("error", "manual_whatsapp_reconcile_unreadable", { lead_id: leadId, error: String(error?.message || error).slice(0, 200) });
    return { ...summary, errors: 1 };
  }
  for (const send of sends) {
    try {
      if (send.status === "pending" && now - Date.parse(send.created_at) > staleMs) {
        await store.updateManualSend(send.id, { status: "outcome_unknown", failure_reason: "no_provider_outcome_recorded" });
        summary.marked_unknown++;
      } else if (send.status === "provider_accepted" && !send.conversation_recorded_at) {
        await persistAcceptedConversation(store, send);
        summary.conversation_repaired++;
      }
    } catch (error) {
      summary.errors++;
      log("error", "manual_whatsapp_reconcile_failed", { lead_id: leadId, send_id: send.id, error: String(error?.message || error).slice(0, 200) });
    }
  }
  return summary;
}

// Governed resolution of an unknown outcome by a staff member who checked WhatsApp. Recording a decision never sends anything.
async function resolveManualSend(store, sendId, { resolution, providerMessageId = "", actorEmail, note = "" }) {
  const send = await store.getManualSend(sendId);
  if (!send) return { httpStatus: 404, body: { error: "send_not_found" } };
  if (!["outcome_unknown", "pending"].includes(send.status)) return { httpStatus: 409, body: { error: "send_not_unresolved", state: send.status } };
  if (!["confirmed_sent", "confirmed_not_sent"].includes(resolution)) return { httpStatus: 400, body: { error: "invalid_resolution" } };
  const resolved = { resolved_by: actorEmail, resolved_at: new Date().toISOString(), resolution_note: String(note || "").slice(0, 500) || null };
  if (resolution === "confirmed_not_sent") {
    const updated = await store.updateManualSend(sendId, { status: "not_sent", failure_reason: "staff_confirmed_not_sent", ...resolved });
    return { httpStatus: 200, body: { ok: true, state: updated.status, send_id: sendId } };
  }
  const updated = await store.updateManualSend(sendId, { status: "provider_accepted", provider_message_id: String(providerMessageId || "").trim() || null, failure_reason: null, ...resolved });
  let recorded = false;
  try {
    await persistAcceptedConversation(store, updated);
    recorded = true;
  } catch { /* reconcile will repair */ }
  return { httpStatus: 200, body: { ok: true, state: updated.status, send_id: sendId, recorded } };
}

module.exports = { performManualSend, reconcileManualSends, resolveManualSend, sha256, classifyProviderFailure, STALE_PENDING_MS };
