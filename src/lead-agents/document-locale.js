"use strict";

// Settings S6.2: the governed document locale and its operational consumer. Contract: docs/settings-domain/16_S6_2_CONTRACT.md.
// The locale controls only how the DISPLAY DATE is presented on newly generated documents. It never touches canonical timestamps, scheduling timezones or meeting times,
// currency formatting, financial calculations, existing document snapshots or legal entity information.

const LOCALE_KEY = "office_document_locale";
const SUPPORTED_LOCALES = Object.freeze(["en-NG", "en-GB", "en-US"]);
const DEFAULT_LOCALE = "en-NG";

// Same shape as the registry validators: (value) -> { ok: true, value } | { ok: false, error }. Exact, case-sensitive match only.
function validateLocale(value) {
  return typeof value === "string" && SUPPORTED_LOCALES.includes(value) ? { ok: true, value } : { ok: false, error: `must_be_one_of_${SUPPORTED_LOCALES.join("|")}` };
}

// style "short": toLocaleDateString(locale) (the previous default-document format); "long": day numeric, month long, year numeric (the previous template format).
// For en-NG both reproduce the pre-S6.2 output exactly. An unsupported locale never reaches Intl: it degrades to en-NG.
function formatDocumentDate(date, locale, style = "short") {
  const effective = SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  return style === "long" ? date.toLocaleDateString(effective, { day: "numeric", month: "long", year: "numeric" }) : date.toLocaleDateString(effective);
}

/**
 * Effective document locale, read at generation time. Never throws and never blocks document generation:
 *   stored valid value        -> source "stored" (with the setting version)
 *   no stored row             -> en-NG, source "default"
 *   unreadable / invalid row  -> en-NG, source "fallback" (safe log: reason only, never the value)
 */
async function resolveDocumentLocale(store, { log = () => {}, requestId = "" } = {}) {
  let row;
  try {
    row = await store.getRuntimeSetting(LOCALE_KEY);
  } catch (error) {
    log("warn", "document_locale.fallback", { request_id: requestId, reason: "setting_unreadable", error: String(error?.code || error?.name || "error").slice(0, 60) });
    return { locale: DEFAULT_LOCALE, source: "fallback", version: null, reason: "setting_unreadable" };
  }
  if (!row) return { locale: DEFAULT_LOCALE, source: "default", version: null, reason: null };
  const version = Number.isInteger(row.version) ? row.version : null;
  const checked = validateLocale(row.value);
  if (!checked.ok) {
    log("warn", "document_locale.fallback", { request_id: requestId, reason: "stored_value_invalid" });
    return { locale: DEFAULT_LOCALE, source: "fallback", version, reason: "stored_value_invalid" };
  }
  return { locale: checked.value, source: "stored", version, reason: null };
}

module.exports = { LOCALE_KEY, SUPPORTED_LOCALES, DEFAULT_LOCALE, validateLocale, formatDocumentDate, resolveDocumentLocale };
