"use strict";

// WhatsApp sender identity, Phase 1. Captures Meta's business-scoped user ID (BSUID) from documented webhook fields and associates it with the lead that the
// EXISTING phone-based matching already chose. It never changes which lead a message belongs to, who receives a reply, goal wake-ups or opt-outs, and it never
// sends anything: identifier-only messaging is Phase 2.
//   * fields (Meta "Business-scoped user IDs"): messages[].from_user_id and contacts[].user_id carry the BSUID; format = ISO 3166 alpha-2 country code, a period,
//     up to 128 alphanumeric characters (e.g. "US.13491208655302741918"). Parent BSUIDs ("US.ENT.…") are not used in Phase 1.
//   * scope: a BSUID is "unique to each business portfolio-user pair". The webhook carries the WhatsApp Business Account id (entry[].id), which belongs to one
//     portfolio, so links are unique per (business account, BSUID) -- never looser than Meta's scope.
//   * a BSUID is opaque: it is never normalized as a phone number and never written to a phone field (whatsapp.js also refuses a BSUID-shaped `from`).
//   * linking is phone-anchored: only a message that ALSO carries the sender's phone links its BSUID to the phone-matched lead. A BSUID-only message is counted
//     and left exactly as before, so it can never block the correct link later.
//   * conflicts (the BSUID is linked to another lead, or this lead is linked to another BSUID) are never merged, overwritten or reassigned: they are recorded
//     once per (business account, BSUID, lead) and a timeline note asks a person to review.
// Gated by OFFICE_WHATSAPP_SENDER_ID_CAPTURE_ENABLED (default OFF). Never throws into the webhook.
// These records are NOT used for matching or sending in Phase 1. Any future use must follow the trusted-identity rule in docs/WHATSAPP_SENDER_IDENTITY.md:
// only a single 'linked' row with NO 'conflict' row for the same (business account, BSUID) or lead, in Office's own configured business account, is trusted;
// links are never used across business accounts; conflicts are never promoted automatically.

const BSUID_PATTERN = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/;
const BUSINESS_ACCOUNT_PATTERN = /^[0-9]{1,32}$/;
// Anything that starts like a BSUID ("US.", "US.ENT.") is not a phone number, whatever follows.
const BSUID_LIKE = /^[A-Za-z]{2}\./;
const CONFLICT_REASONS = Object.freeze({ USER_ID_LINKED_TO_OTHER_LEAD: "user_id_linked_to_other_lead", LEAD_LINKED_TO_OTHER_USER_ID: "lead_linked_to_other_user_id" });
const CONFLICT_TEXT = Object.freeze({
  user_id_linked_to_other_lead: "This customer's WhatsApp account is already associated with a different lead. Nothing was merged or changed; please review which lead is correct.",
  lead_linked_to_other_user_id: "This lead is already associated with a different WhatsApp account. Nothing was merged or changed; please review (the customer may have changed number, or two people may share it).",
});

// Process-local capture health (since this process started), shown on the admin status endpoint. No identifiers.
const health = { started_at: new Date().toISOString(), links_created: 0, already_linked: 0, conflicts_recorded: 0, not_linked_without_phone: 0, not_linked_without_identity: 0, failures: 0, last_failure_at: null };

function captureEnabled(config) {
  return Boolean(config && config.whatsappSenderIdCaptureEnabled === true);
}

function isBusinessScopedUserId(value) {
  return typeof value === "string" && BSUID_PATTERN.test(value);
}

function looksLikeBusinessScopedId(value) {
  return typeof value === "string" && BSUID_LIKE.test(value.trim());
}

// The sender's BSUID and business-account scope for one inbound message, from documented fields only. messages[].from_user_id is preferred; otherwise the
// contacts[] entry for this sender (matched on wa_id = from, or the only contact). If the two disagree, nothing is used.
function senderIdentityFromMessage({ message, contacts, businessAccountId }) {
  const m = message && typeof message === "object" ? message : {};
  const list = Array.isArray(contacts) ? contacts.filter((c) => c && typeof c === "object") : [];
  const contact = list.find((c) => m.from && c.wa_id && String(c.wa_id) === String(m.from)) || (list.length === 1 ? list[0] : null);
  const fromMessage = typeof m.from_user_id === "string" ? m.from_user_id.trim() : "";
  const fromContact = contact && typeof contact.user_id === "string" ? contact.user_id.trim() : "";
  const account = typeof businessAccountId === "string" || typeof businessAccountId === "number" ? String(businessAccountId).trim() : "";
  if (fromMessage && fromContact && fromMessage !== fromContact) return { business_account_id: null, business_scoped_user_id: null, reason: "inconsistent_user_ids" };
  const candidate = fromMessage || fromContact;
  if (!candidate) return { business_account_id: null, business_scoped_user_id: null, reason: "absent" };
  if (!isBusinessScopedUserId(candidate)) return { business_account_id: null, business_scoped_user_id: null, reason: "invalid_user_id" };
  if (!BUSINESS_ACCOUNT_PATTERN.test(account)) return { business_account_id: null, business_scoped_user_id: null, reason: "missing_business_account" };
  return { business_account_id: account, business_scoped_user_id: candidate, reason: null };
}

function recordFailure() {
  health.failures += 1;
  health.last_failure_at = new Date().toISOString();
}

// Decide and write one association. Store primitives: findWhatsAppSenderIdentities, insertWhatsAppSenderIdentityLink (plain insert; duplicate on 23505) and
// insertWhatsAppSenderIdentityConflict (idempotent per business account + BSUID + lead). One retry covers a concurrent writer winning the link first.
async function associate(store, { businessAccountId, businessScopedUserId, leadId, providerMessageId }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rows = await store.findWhatsAppSenderIdentities({ businessAccountId, businessScopedUserId, leadId });
    const linkedForUser = rows.find((r) => r.state === "linked" && r.business_scoped_user_id === businessScopedUserId);
    if (linkedForUser && linkedForUser.lead_id === leadId) return { outcome: "already_linked" };
    const conflict = linkedForUser
      ? { reason: CONFLICT_REASONS.USER_ID_LINKED_TO_OTHER_LEAD, conflictingLeadId: linkedForUser.lead_id }
      : rows.some((r) => r.state === "linked" && r.lead_id === leadId) ? { reason: CONFLICT_REASONS.LEAD_LINKED_TO_OTHER_USER_ID, conflictingLeadId: null } : null;
    if (conflict) {
      const recorded = await store.insertWhatsAppSenderIdentityConflict({ business_account_id: businessAccountId, business_scoped_user_id: businessScopedUserId, lead_id: leadId, state: "conflict", conflict_reason: conflict.reason, conflicting_lead_id: conflict.conflictingLeadId, provider_message_id: providerMessageId || null });
      return { outcome: "conflict", reason: conflict.reason, conflicting_lead_id: conflict.conflictingLeadId, created: Boolean(recorded && recorded.created) };
    }
    // an earlier conflict for this exact pair stays a conflict until a person resolves it (never promoted automatically)
    if (rows.some((r) => r.state === "conflict" && r.business_scoped_user_id === businessScopedUserId && r.lead_id === leadId)) return { outcome: "conflict_pending" };
    const inserted = await store.insertWhatsAppSenderIdentityLink({ business_account_id: businessAccountId, business_scoped_user_id: businessScopedUserId, lead_id: leadId, state: "linked", provider_message_id: providerMessageId || null });
    if (inserted && inserted.created) return { outcome: "linked" };
    // someone else linked first (this BSUID or this lead): read again and decide on what is now stored
  }
  return { outcome: "unresolved" };
}

// Webhook hook. OFF -> returns at once without touching the store. Never throws; never changes the lead, the reply decision or anything sent.
async function linkSenderIdentity(store, config, { identity, leadId, phonePresent, providerMessageId, requestId, log = () => {} }) {
  if (!captureEnabled(config)) return { enabled: false };
  const id = identity && identity.business_scoped_user_id;
  if (!id) { health.not_linked_without_identity += 1; return { enabled: true, outcome: "no_identity", reason: (identity && identity.reason) || "absent" }; }
  if (!phonePresent) { health.not_linked_without_phone += 1; return { enabled: true, outcome: "not_linked_without_phone" }; }
  if (typeof store.findWhatsAppSenderIdentities !== "function") { recordFailure(); log("error", "whatsapp_sender_identity.store_unavailable", { request_id: requestId }); return { enabled: true, outcome: "failed" }; }
  try {
    const result = await associate(store, { businessAccountId: identity.business_account_id, businessScopedUserId: id, leadId, providerMessageId });
    if (result.outcome === "linked") health.links_created += 1;
    if (result.outcome === "already_linked") health.already_linked += 1;
    if (result.outcome === "conflict" && result.created) {
      health.conflicts_recorded += 1;
      await store.appendTimelineEvent({ lead_id: leadId, event_type: "whatsapp_identity_conflict", actor: "office", title: "WhatsApp identity needs review", body: CONFLICT_TEXT[result.reason], metadata: { request_id: requestId, reason: result.reason, conflicting_lead_id: result.conflicting_lead_id || null, provider_message_id: providerMessageId || null } }).catch(() => null);
      log("warn", "whatsapp_sender_identity.conflict_recorded", { request_id: requestId, reason: result.reason });
    }
    if (result.outcome === "unresolved") { recordFailure(); log("error", "whatsapp_sender_identity.unresolved", { request_id: requestId }); }
    return { enabled: true, ...result };
  } catch (error) {
    recordFailure();
    log("error", "whatsapp_sender_identity.capture_failed", { request_id: requestId, error: String((error && (error.code || error.message)) || error).replace(/https?:\/\/\S+/gi, "[url]").slice(0, 200) });
    return { enabled: true, outcome: "failed" };
  }
}

// Aggregates for the admin status endpoint: counts only, no identifiers.
function summarizeSenderIdentities(rows) {
  const conflicts = rows.filter((r) => r.state === "conflict");
  return {
    linked: rows.filter((r) => r.state === "linked").length,
    conflicts: conflicts.length,
    conflicts_by_reason: Object.fromEntries(Object.values(CONFLICT_REASONS).map((reason) => [reason, conflicts.filter((r) => r.conflict_reason === reason).length])),
  };
}

module.exports = {
  BSUID_PATTERN,
  CONFLICT_REASONS,
  health,
  captureEnabled,
  isBusinessScopedUserId,
  looksLikeBusinessScopedId,
  senderIdentityFromMessage,
  associate,
  linkSenderIdentity,
  summarizeSenderIdentities,
};
