"use strict";

// Governed Settings registry (Settings S3). Code-defined; see docs/settings-domain/06_S3_REGISTRY_CONTRACT.md.
// The registry never duplicates persistence: `generic` settings live in office_runtime_settings through the store; `delegated` settings are read here but written
// ONLY through their existing, already-audited routes; `mirror`/`system` settings describe what other systems or the environment own and are never writable.

const { WHATSAPP_AUTONOMY_SETTING_KEY, readWhatsAppAutonomySetting } = require("./whatsapp-autonomy");
const { settings: outboxSettings } = require("./communication-outbox");
const { BRAND_KEY, validateBrandName, environmentBrandName } = require("./document-brand");

const MODES = Object.freeze(["generic", "delegated", "mirror", "system"]);
const OWNERS = Object.freeze(["office", "backend", "facility", "consumer", "edge", "platform"]);
const TYPES = Object.freeze(["boolean", "string", "integer", "enum", "object"]);
const KEY_PATTERN = /^[a-z][a-z0-9_.]{1,79}$/;
const REDACTED = "[redacted]";

// ---- validators: (value) -> { ok: true, value } | { ok: false, error } ----
const validators = {
  boolean: () => (value) => (typeof value === "boolean" ? { ok: true, value } : { ok: false, error: "must_be_boolean" }),
  string: ({ min = 0, max = 500, pattern = null } = {}) => (value) => {
    if (typeof value !== "string") return { ok: false, error: "must_be_string" };
    const v = value.trim();
    if (v.length < min) return { ok: false, error: `must_be_at_least_${min}_characters` };
    if (v.length > max) return { ok: false, error: `must_be_at_most_${max}_characters` };
    if (pattern && !pattern.test(v)) return { ok: false, error: "invalid_format" };
    return { ok: true, value: v };
  },
  integer: ({ min = -Infinity, max = Infinity } = {}) => (value) => {
    if (typeof value !== "number" || !Number.isInteger(value)) return { ok: false, error: "must_be_integer" };
    if (value < min || value > max) return { ok: false, error: `must_be_between_${min}_and_${max}` };
    return { ok: true, value };
  },
  enum: (allowed) => (value) => (allowed.includes(value) ? { ok: true, value } : { ok: false, error: `must_be_one_of_${allowed.join("|")}` }),
};

function defineSetting(d) {
  const problems = [];
  if (!KEY_PATTERN.test(String(d.key || ""))) problems.push("invalid key");
  if (!TYPES.includes(d.type)) problems.push("invalid type");
  if (!MODES.includes(d.mode)) problems.push("invalid mode");
  if (!OWNERS.includes(d.owner)) problems.push("invalid owner");
  if (!d.read_permission) problems.push("read_permission required");
  if (d.type === "enum" && (!Array.isArray(d.choices) || !d.choices.length)) problems.push("enum settings need choices");
  if (d.mode === "generic") {
    if (d.owner !== "office") problems.push("generic settings must be owned by office");
    if (d.storage !== "runtime_settings") problems.push("generic settings must use runtime_settings storage");
    if (!d.write_permission) problems.push("generic settings need write_permission");
    if (typeof d.validator !== "function") problems.push("generic settings need a validator");
    if (!d.audit_action) problems.push("generic settings need audit_action");
    if (d.sensitive) problems.push("secrets are never stored through the registry (sensitive settings cannot be generic)");
    if (d.default === undefined) problems.push("generic settings need a default");
  } else {
    if (d.write_permission) problems.push("only generic settings may declare write_permission");
    if (d.mode === "delegated" && !d.delegated_route) problems.push("delegated settings need delegated_route");
  }
  if (problems.length) throw new Error(`settings registry: ${d.key || "?"}: ${problems.join(", ")}`);
  const out = { scope: "global", sensitive: false, requires_confirmation: false, write_permission: null, description: "", ...d };
  if (out.mode === "generic" && !out.read) out.read = genericRead(out);
  return Object.freeze(out);
}

function configuredBridge(url, apiKey, bearer) { return Boolean(url && (apiKey || bearer)); }

function productionDescriptors(config) {
  return [
    defineSetting({
      key: WHATSAPP_AUTONOMY_SETTING_KEY, label: "WhatsApp autonomous replies", description: "Global switch for autonomous WhatsApp replies. Default OFF; an unreadable value is treated as OFF.",
      type: "boolean", default: false, owner: "office", mode: "delegated", storage: "runtime_settings", read_permission: "integrations.read", requires_confirmation: true, audit_action: "whatsapp_autonomy_setting_changed",
      delegated_route: { path: "/api/lead-agents/admin/settings/whatsapp-autonomy", methods: ["GET", "PUT"], write_permission: "integrations.manage" },
      read: async (store) => {
        const setting = await readWhatsAppAutonomySetting(store);
        const row = setting.source === "stored" || setting.source === "malformed" ? await store.getRuntimeSetting(WHATSAPP_AUTONOMY_SETTING_KEY).catch(() => null) : null;
        return { value: setting.known ? setting.enabled : null, version: row ? (row.version ?? null) : 0, updated_by: setting.updated_by, updated_at: setting.updated_at, source: setting.source, history_supported: true };
      },
    }),
    defineSetting({
      key: BRAND_KEY, label: "Document brand name", description: "The display name printed in the header of newly generated documents. Existing documents keep the header they were created with. It is not a legal entity name and does not change the letterhead.",
      type: "string", default: environmentBrandName(config), owner: "office", mode: "generic", storage: "runtime_settings", read_permission: "office.read", write_permission: "settings.manage",
      validator: validateBrandName, audit_action: "office_document_brand_name_changed", edit_section: "organization",
    }),
    defineSetting({
      key: "office_letterhead_config", label: "Corporate letterhead", description: "Default header and footer for new documents (logo, tagline, contact details).",
      type: "object", default: {}, owner: "office", mode: "delegated", storage: "letterhead_config", read_permission: "office.read", audit_action: "office_letterhead_config_updated",
      delegated_route: { path: "/api/lead-agents/admin/letterhead-config", methods: ["GET", "PATCH"], write_permission: "settings.manage" },
      read: async (store) => {
        const row = (await store.getLetterheadConfig()) || {};
        const value = {}; for (const k of ["logo_url", "tagline", "email", "website", "whatsapp", "address", "social_handle"]) value[k] = row[k] || "";
        return { value, version: null, updated_by: row.updated_by || null, updated_at: row.updated_at || null, source: row.id ? "stored" : "default", history_supported: false };
      },
    }),
    defineSetting({
      key: "whatsapp_webhook_signature_mode", label: "WhatsApp webhook signature mode", description: "Meta webhook authentication. Anything other than `report` enforces. Changed only through deployment configuration.",
      type: "object", default: { mode: "enforce" }, owner: "platform", mode: "mirror", storage: "environment", read_permission: "integrations.read",
      read: async () => ({ value: { mode: config.whatsappWebhookSignatureMode === "report" ? "report" : "enforce", app_secret_configured: Boolean(config.metaAppSecret) }, version: null, updated_by: null, updated_at: null, source: "environment", history_supported: false }),
    }),
    defineSetting({
      key: "whatsapp_webhook_signature_stats", label: "Webhook signature counters", description: "Counters and timestamps written by the webhook monitor. No secrets, signatures or message content.",
      type: "object", default: {}, owner: "office", mode: "system", storage: "runtime_settings", read_permission: "integrations.manage",
      read: async (store) => { const row = await store.getRuntimeSetting("whatsapp_webhook_signature_stats"); return { value: row ? row.value : null, version: row ? (row.version ?? null) : 0, updated_by: row ? row.updated_by : null, updated_at: row ? row.updated_at : null, source: row ? "stored" : "default", history_supported: false }; },
    }),
    defineSetting({
      key: "communication_outbox_settings", label: "Communication delivery outbox policy", description: "Retry and lease policy of the WhatsApp inbound delivery outbox. Defined in code/deployment configuration.",
      type: "object", default: {}, owner: "office", mode: "mirror", storage: "environment", read_permission: "integrations.manage",
      read: async () => ({ value: outboxSettings(config), version: null, updated_by: null, updated_at: null, source: "environment", history_supported: false }),
    }),
    defineSetting({
      key: "mirror.backend.bridge", label: "Ochiga Backend bridge", description: "Owned by the Backend. Configuration presence only; reachability is on Integrations.", type: "object", default: {}, owner: "backend", mode: "mirror", storage: "environment", read_permission: "integrations.read",
      read: async () => ({ value: { configured: configuredBridge(config.officeBackendBaseUrl, config.officeBackendApiKey, config.officeBackendBearerToken), verification: "configuration_only" }, version: null, updated_by: null, updated_at: null, source: "environment", history_supported: false }),
    }),
    defineSetting({
      key: "mirror.facility.bridge", label: "Oyi Facility bridge", description: "Owned by Facility. Configuration presence only.", type: "object", default: {}, owner: "facility", mode: "mirror", storage: "environment", read_permission: "integrations.read",
      read: async () => ({ value: { configured: configuredBridge(config.officeFacilityBaseUrl, config.officeFacilityApiKey, config.officeFacilityBearerToken), verification: "configuration_only" }, version: null, updated_by: null, updated_at: null, source: "environment", history_supported: false }),
    }),
    defineSetting({
      key: "mirror.consumer.bridge", label: "Oyi Consumer bridge", description: "Owned by Consumer. Configuration presence only.", type: "object", default: {}, owner: "consumer", mode: "mirror", storage: "environment", read_permission: "integrations.read",
      read: async () => ({ value: { configured: configuredBridge(config.officeConsumerBaseUrl, config.officeConsumerApiKey, config.officeConsumerBearerToken), verification: "configuration_only" }, version: null, updated_by: null, updated_at: null, source: "environment", history_supported: false }),
    }),
    defineSetting({
      key: "mirror.edge.agents", label: "Edge agent access", description: "Owned by Edge/Backend. Number of configured edge agent tokens (never the tokens).", type: "object", default: {}, owner: "edge", mode: "mirror", storage: "environment", read_permission: "integrations.read",
      read: async () => ({ value: { agent_tokens_configured: Array.isArray(config.edgeAgentTokens) ? config.edgeAgentTokens.length : 0, verification: "configuration_only" }, version: null, updated_by: null, updated_at: null, source: "environment", history_supported: false }),
    }),
  ];
}

function genericRead(descriptor) {
  return async (store) => {
    const row = await store.getRuntimeSetting(descriptor.key);
    if (!row) return { value: descriptor.default, version: 0, updated_by: null, updated_at: null, source: "default", history_supported: true };
    return { value: row.value, version: row.version ?? null, updated_by: row.updated_by || null, updated_at: row.updated_at || null, source: "stored", history_supported: true };
  };
}

function createSettingsRegistry({ config = {}, extras = [] } = {}) {
  const all = [...productionDescriptors(config), ...extras.map((d) => defineSetting(d))];
  const seen = new Set();
  for (const d of all) { if (seen.has(d.key)) throw new Error(`settings registry: duplicate key ${d.key}`); seen.add(d.key); }
  const byKey = new Map(all.map((d) => [d.key, d]));
  return {
    keys: () => all.map((d) => d.key),
    get: (key) => byKey.get(String(key)) || null,
    list: () => [...all],
  };
}

// Never return a sensitive value: only whether one is configured.
function publicValue(descriptor, value) {
  if (!descriptor.sensitive) return value;
  return { configured: value !== null && value !== undefined && value !== "" };
}
function historyValue(descriptor, value) { return descriptor.sensitive ? REDACTED : value; }

async function readEntry(descriptor, store) {
  try {
    const r = await descriptor.read(store);
    return { ...r, value: publicValue(descriptor, r.value), error: null };
  } catch (error) {
    // fail closed: no invented value
    return { value: null, version: null, updated_by: null, updated_at: null, source: "unreadable", history_supported: false, error: String(error?.message || error).slice(0, 160) };
  }
}

// Serialises a descriptor for an API response, tailored to the caller's permissions (`can(permission) -> boolean`).
async function describeEntry(descriptor, store, can) {
  const state = await readEntry(descriptor, store);
  const generic = descriptor.mode === "generic";
  return {
    key: descriptor.key, label: descriptor.label, description: descriptor.description, type: descriptor.type, scope: descriptor.scope, owner: descriptor.owner, mode: descriptor.mode, storage: descriptor.storage,
    read_permission: descriptor.read_permission, write_permission: generic ? descriptor.write_permission : null, sensitive: descriptor.sensitive, requires_confirmation: descriptor.requires_confirmation,
    default: publicValue(descriptor, descriptor.default),
    choices: descriptor.type === "enum" ? descriptor.choices : undefined,
    edit_section: descriptor.edit_section || null,
    editable: generic && can(descriptor.write_permission) && typeof state.version === "number",
    edit_via: descriptor.mode === "delegated" ? { path: descriptor.delegated_route.path, methods: descriptor.delegated_route.methods, write_permission: descriptor.delegated_route.write_permission, can_write: can(descriptor.delegated_route.write_permission) } : null,
    value: state.value, version: state.version, updated_by: state.updated_by, updated_at: state.updated_at, source: state.source, history_supported: state.history_supported, read_error: state.error,
  };
}

module.exports = { MODES, OWNERS, REDACTED, createSettingsRegistry, defineSetting, describeEntry, historyValue, publicValue, validators };
