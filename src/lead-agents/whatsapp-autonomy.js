// Global switch for AUTONOMOUS WhatsApp sends (Oyi/Oma/Osa replies, goal and automation sends).
// One authoritative persisted setting, read at the moment of every autonomous send. It never disables WhatsApp ingestion, CRM persistence
// or governed manual staff communication. Default OFF; an unreadable setting is treated as OFF (fail closed).

const WHATSAPP_AUTONOMY_SETTING_KEY = "whatsapp_autonomous_responses_enabled";

async function readWhatsAppAutonomySetting(store) {
  try {
    const row = await store.getRuntimeSetting(WHATSAPP_AUTONOMY_SETTING_KEY);
    if (!row) return { known: true, enabled: false, source: "default", updated_by: null, updated_at: null };
    if (typeof row.value !== "boolean") {
      return { known: false, enabled: false, source: "malformed", updated_by: row.updated_by || null, updated_at: row.updated_at || null, error: "setting_value_not_boolean" };
    }
    return { known: true, enabled: row.value === true, source: "stored", updated_by: row.updated_by || null, updated_at: row.updated_at || null };
  } catch (error) {
    return { known: false, enabled: false, source: "unreadable", updated_by: null, updated_at: null, error: String(error?.message || error).slice(0, 200) };
  }
}

// { allowed, reason }: allowed only when the stored value is the boolean true.
async function evaluateAutonomousWhatsAppPolicy(store) {
  const setting = await readWhatsAppAutonomySetting(store);
  if (!setting.known) return { allowed: false, reason: "setting_unreadable", setting };
  if (!setting.enabled) return { allowed: false, reason: "autonomous_whatsapp_disabled", setting };
  return { allowed: true, reason: "enabled", setting };
}

const crypto = require("crypto");

// A bridge send is autonomous unless it carries a VALID staff-confirmation attestation. A bare `send_origin: "staff_confirmed"` label proves nothing: any holder of
// the shared bridge key (or any buggy caller) could write it. The attestation binds the confirming staff member, the confirmation id, the recipient and the exact
// message content to a timestamp with an HMAC keyed by the shared bridge secret (the same OFFICE_SYNC key Backend already uses; no new secret). Anything else —
// missing, malformed, stale, mismatched content, wrong signature — is treated as AUTONOMOUS and is refused while the switch is OFF.
const STAFF_CONFIRMATION_MAX_AGE_MS = 10 * 60 * 1000;
const STAFF_CONFIRMATION_MAX_SKEW_MS = 60 * 1000;

function staffConfirmationContentHash(body = {}) {
  const content = body.template_name
    ? `template:${String(body.template_name)}:${String(body.template_language || "")}`
    : `text:${String(body.body || "")}`;
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}
function staffConfirmationCanonical(body, attestation) {
  return ["v1", String(body.communication_id || ""), String(attestation.confirmed_by || ""), String(attestation.confirmation_id || ""), String(body.to || ""), staffConfirmationContentHash(body), String(attestation.confirmed_at || "")].join("|");
}
function signStaffConfirmation(body, attestation, key) {
  return crypto.createHmac("sha256", String(key || "")).update(staffConfirmationCanonical(body, attestation), "utf8").digest("hex");
}
// -> { confirmed: boolean, reason: string, confirmed_by?: string, confirmation_id?: string }
function verifyStaffConfirmedSend(body, key, now = Date.now()) {
  if (String(body?.send_origin || "").trim().toLowerCase() !== "staff_confirmed") return { confirmed: false, reason: "origin_not_declared" };
  const a = body.staff_confirmation;
  if (!key) return { confirmed: false, reason: "no_verification_key" };
  if (!a || typeof a !== "object") return { confirmed: false, reason: "attestation_missing" };
  for (const field of ["confirmed_by", "confirmation_id", "confirmed_at", "signature"]) {
    if (!String(a[field] || "").trim()) return { confirmed: false, reason: `attestation_${field}_missing` };
  }
  if (!String(body.communication_id || "").trim() || !String(body.to || "").trim()) return { confirmed: false, reason: "attestation_unbound_message" };
  const at = Date.parse(a.confirmed_at);
  if (!Number.isFinite(at)) return { confirmed: false, reason: "attestation_time_invalid" };
  if (now - at > STAFF_CONFIRMATION_MAX_AGE_MS) return { confirmed: false, reason: "attestation_stale" };
  if (at - now > STAFF_CONFIRMATION_MAX_SKEW_MS) return { confirmed: false, reason: "attestation_from_future" };
  const expected = Buffer.from(signStaffConfirmation(body, a, key), "hex");
  let provided;
  try { provided = Buffer.from(String(a.signature), "hex"); } catch { return { confirmed: false, reason: "attestation_signature_malformed" }; }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return { confirmed: false, reason: "attestation_signature_invalid" };
  return { confirmed: true, reason: "verified", confirmed_by: String(a.confirmed_by), confirmation_id: String(a.confirmation_id) };
}

function describeWhatsAppAutonomyStatus(setting, { officialNumber = "" } = {}) {
  return {
    enabled: Boolean(setting.known && setting.enabled),
    effective: Boolean(setting.known && setting.enabled),
    state: !setting.known ? "unknown_fail_closed" : setting.enabled ? "on" : "off",
    source: setting.source,
    updated_by: setting.updated_by || null,
    updated_at: setting.updated_at || null,
    official_number: officialNumber || "",
    ...(setting.known ? {} : { error: setting.error || "setting_unreadable" }),
  };
}

module.exports = {
  WHATSAPP_AUTONOMY_SETTING_KEY,
  readWhatsAppAutonomySetting,
  evaluateAutonomousWhatsAppPolicy,
  verifyStaffConfirmedSend,
  signStaffConfirmation,
  STAFF_CONFIRMATION_MAX_AGE_MS,
  describeWhatsAppAutonomyStatus,
};
