// Oyi Universal Interaction Shell — response normalization.
//
// Ochiga Backend exposes three distinct, non-unified response
// contracts (confirmed via direct repo audit of Ochiga-backend):
//   - CorporateOyiCoreResponse       (public,  POST /office/conversation/corporate)
//   - OfficeInternalOyiCoreResponse  (staff,   POST /office/conversation/internal)
//   - CanonicalConversationResponse  (session, POST /oyi/runtime/conversation — Consumer/Facility, not used by Office or Website today)
//
// This file adapts each into one NormalizedInteractionResponse shape
// so RichResponseRenderer never needs to know which backend contract
// produced a given reply. No backend rewrite — this is purely an
// adapter layer, per the "contract normalization, not a rewrite"
// instruction. Framework-agnostic (see docking.mjs for why).

/**
 * @typedef {Object} NormalizedToolProposal
 * @property {string} id
 * @property {string} tool
 * @property {string} reason
 * @property {Record<string, unknown>} parameters
 * @property {string} governance
 */

/**
 * @typedef {Object} NormalizedInteractionResponse
 * @property {"ok"|"unavailable"|"error"} status
 * @property {string} answer
 * @property {string|null} threadId
 * @property {Array<Record<string, unknown>>} cards
 * @property {string[]} suggestions
 * @property {NormalizedToolProposal[]} toolProposals
 * @property {boolean} confirmationRequired
 * @property {string|null} attentionSignal - office_internal's operational triage signal
 * @property {string|null} commercialSignal - corporate/public's sales-funnel signal
 * @property {boolean} handoffRecommended
 * @property {string[]} errors
 * @property {unknown} raw - original backend response, for renderer edge cases this layer doesn't yet cover
 */

let _idCounter = 0;
function makeProposalId(prefix) {
  _idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idCounter}`;
}

/**
 * @param {Array<Record<string, any>>|undefined} proposals
 * @returns {NormalizedToolProposal[]}
 */
function normalizeToolProposals(proposals) {
  if (!Array.isArray(proposals)) return [];
  return proposals.map((proposal) => ({
    id: proposal.proposal_id || makeProposalId("proposal"),
    tool: proposal.tool || "unknown",
    reason: proposal.reason || "",
    parameters: proposal.parameters || {},
    governance: proposal.governance || "office_validates_before_execution",
  }));
}

/**
 * Adapts CorporateOyiCoreResponse (public corporate/website surface).
 * @param {Record<string, any>} response
 * @returns {NormalizedInteractionResponse}
 */
export function normalizeCorporateResponse(response) {
  return {
    status: response?.ok ? "ok" : "error",
    answer: response?.answer || "",
    threadId: response?.conversation_thread_id || null,
    cards: [],
    suggestions: response?.suggested_next_action ? [response.suggested_next_action] : [],
    toolProposals: normalizeToolProposals(response?.tool_proposals),
    confirmationRequired: false,
    attentionSignal: null,
    commercialSignal: response?.commercial_signal || null,
    handoffRecommended: Boolean(response?.handoff_recommended),
    errors: response?.ok ? [] : [response?.error || response?.message || "corporate_response_error"],
    raw: response,
  };
}

/**
 * Adapts OfficeInternalOyiCoreResponse (Office staff surface). Office's
 * own server.js already unwraps tool_proposals to a top-level
 * `proposed_actions` field on its /office/intelligence/chat response
 * (see server.js's office/intelligence/chat route) — accept either.
 * @param {Record<string, any>} response
 * @param {Array<Record<string, any>>} [proposedActionsOverride]
 * @returns {NormalizedInteractionResponse}
 */
export function normalizeOfficeInternalResponse(response, proposedActionsOverride) {
  const proposals = proposedActionsOverride ?? response?.tool_proposals;
  return {
    status: response?.ok ? "ok" : "error",
    answer: response?.answer || "",
    threadId: response?.conversation_thread_id || null,
    cards: [],
    suggestions: response?.suggested_next_action ? [response.suggested_next_action] : [],
    toolProposals: normalizeToolProposals(proposals),
    confirmationRequired: normalizeToolProposals(proposals).length > 0,
    attentionSignal: response?.attention_signal && response.attention_signal !== "none" ? response.attention_signal : null,
    commercialSignal: null,
    handoffRecommended: response?.attention_signal === "handoff",
    errors: [],
    raw: response,
  };
}

/**
 * Adapts CanonicalConversationResponse (session-authenticated kernel
 * contract — Consumer/Facility today; not consumed by Office or
 * Website yet, included so the normalizer is ready when they are).
 * @param {Record<string, any>} response
 * @returns {NormalizedInteractionResponse}
 */
export function normalizeCanonicalConversationResponse(response) {
  return {
    status: "ok",
    answer: response?.answer || response?.reply || response?.message || response?.summary || "",
    threadId: response?.thread_id || null,
    cards: Array.isArray(response?.cards) ? response.cards : [],
    suggestions: Array.isArray(response?.suggested_actions)
      ? response.suggested_actions.map((a) => (typeof a === "string" ? a : a?.text || JSON.stringify(a)))
      : [],
    toolProposals: normalizeToolProposals(response?.confirmations),
    confirmationRequired: Array.isArray(response?.confirmations) && response.confirmations.length > 0,
    attentionSignal: null,
    commercialSignal: null,
    handoffRecommended: false,
    errors: Array.isArray(response?.warnings) ? response.warnings : [],
    raw: response,
  };
}

/**
 * Builds a normalized response for a transport/backend failure (503,
 * network error, empty body) — every surface's honest "Oyi Core is
 * unavailable" path collapses to this instead of each hand-rolling
 * its own error bubble shape.
 * @param {string} reason
 * @param {string} [message]
 * @returns {NormalizedInteractionResponse}
 */
export function normalizeUnavailable(reason, message) {
  return {
    status: "unavailable",
    answer: "",
    threadId: null,
    cards: [],
    suggestions: [],
    toolProposals: [],
    confirmationRequired: false,
    attentionSignal: null,
    commercialSignal: null,
    handoffRecommended: false,
    errors: [message || reason],
    raw: { reason, message },
  };
}
