"use strict";

const { readWhatsAppAutonomySetting } = require("./whatsapp-autonomy");

const CHANNELS = Object.freeze({
  whatsapp: { key: "whatsapp_autonomous_responses_enabled", label: "WhatsApp" },
  facebook: { key: "facebook_messenger_autonomous_responses_enabled", label: "Facebook Messenger" },
  instagram: { key: "instagram_direct_autonomous_responses_enabled", label: "Instagram Direct" },
});

async function readChannelAutonomySetting(store, channel) {
  if (!CHANNELS[channel]) return { known: false, enabled: false, source: "invalid_channel", error: "invalid_channel" };
  if (channel === "whatsapp") return readWhatsAppAutonomySetting(store);
  try {
    const row = await store.getRuntimeSetting(CHANNELS[channel].key);
    if (!row) return { known: true, enabled: false, source: "default", updated_by: null, updated_at: null };
    if (typeof row.value !== "boolean") {
      return { known: false, enabled: false, source: "malformed", updated_by: row.updated_by || null,
        updated_at: row.updated_at || null, error: "setting_value_not_boolean" };
    }
    return { known: true, enabled: row.value, source: "stored", updated_by: row.updated_by || null, updated_at: row.updated_at || null };
  } catch {
    return { known: false, enabled: false, source: "unreadable", updated_by: null, updated_at: null, error: "setting_unreadable" };
  }
}

async function evaluateChannelAutonomy(store, channel, { configured = true } = {}) {
  const setting = await readChannelAutonomySetting(store, channel);
  const allowed = Boolean(setting.known && setting.enabled && configured);
  return {
    channel,
    setting,
    allowed,
    state: !setting.known ? "unknown_fail_closed" : !setting.enabled ? "off" : configured ? "on" : "configured_but_unavailable",
    reason: !setting.known ? "setting_unreadable" : !setting.enabled ? "autonomous_responses_disabled" : configured ? null : "channel_not_configured",
  };
}

module.exports = { CHANNELS, readChannelAutonomySetting, evaluateChannelAutonomy };
