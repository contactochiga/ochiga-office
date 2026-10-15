"use strict";

// Settings S6.1: the governed document brand name and its operational consumer. Contract: docs/settings-domain/14_S6_1_CONTRACT.md.
// The brand name is the display name printed in the header of generated documents. It is NOT a legal entity name and never alters contract text or the letterhead.

const BRAND_KEY = "office_document_brand_name";
const BRAND_MAX = 60;
const DEFAULT_BRAND = "OCHIGA OFFICE";
// Unicode letters and numbers, space, & . , ' ( ) -  (control characters, angle brackets, quotes, slashes and everything else are outside the set)
const BRAND_PATTERN = /^[\p{L}\p{N} &.,'()-]+$/u;

// Same shape as the registry validators: (value) -> { ok: true, value } | { ok: false, error }
function validateBrandName(value) {
  if (typeof value !== "string") return { ok: false, error: "must_be_string" };
  const v = value.trim();
  if (v.length < 1) return { ok: false, error: "must_be_at_least_1_characters" };
  if (v.length > BRAND_MAX) return { ok: false, error: `must_be_at_most_${BRAND_MAX}_characters` };
  if (!BRAND_PATTERN.test(v)) return { ok: false, error: "invalid_characters" };
  return { ok: true, value: v };
}

function environmentBrandName(config = {}) {
  const configured = String(config.officeDocumentBrandName || "").trim();
  return configured || DEFAULT_BRAND;
}

/**
 * Effective brand name, read at generation time. Never throws and never blocks document generation:
 *   stored valid value        -> source "stored" (with the setting version)
 *   no stored row             -> source "default" (the environment default)
 *   unreadable / invalid row  -> source "environment_fallback" (safe log: reason only, never the value)
 */
async function resolveDocumentBrandName(store, config, { log = () => {}, requestId = "" } = {}) {
  const fallback = environmentBrandName(config);
  let row;
  try {
    row = await store.getRuntimeSetting(BRAND_KEY);
  } catch (error) {
    log("warn", "document_brand.fallback", { request_id: requestId, reason: "setting_unreadable", error: String(error?.code || error?.name || "error").slice(0, 60) });
    return { name: fallback, source: "environment_fallback", version: null, reason: "setting_unreadable" };
  }
  if (!row) return { name: fallback, source: "default", version: null, reason: null };
  const checked = validateBrandName(row.value);
  if (!checked.ok) {
    log("warn", "document_brand.fallback", { request_id: requestId, reason: "stored_value_invalid", rule: checked.error });
    return { name: fallback, source: "environment_fallback", version: Number.isInteger(row.version) ? row.version : null, reason: "stored_value_invalid" };
  }
  return { name: checked.value, source: "stored", version: Number.isInteger(row.version) ? row.version : null, reason: null };
}

module.exports = { BRAND_KEY, BRAND_MAX, DEFAULT_BRAND, BRAND_PATTERN, validateBrandName, environmentBrandName, resolveDocumentBrandName };
