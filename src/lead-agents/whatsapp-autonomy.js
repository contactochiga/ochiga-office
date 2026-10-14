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

// A bridge send is autonomous unless the caller explicitly declares it staff-confirmed. A missing/unknown origin is autonomous (fail closed).
function isStaffConfirmedOrigin(sendOrigin) {
  return String(sendOrigin || "").trim().toLowerCase() === "staff_confirmed";
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
  isStaffConfirmedOrigin,
  describeWhatsAppAutonomyStatus,
};
