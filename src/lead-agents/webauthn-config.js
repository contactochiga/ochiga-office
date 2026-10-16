"use strict";

// Settings S7.5.5: relying-party configuration for WebAuthn. Contract: docs/settings-domain/32_S7_5_5_WEBAUTHN_PASSKEY_CONTRACT.md
// Nothing here invents a domain. The RP ID and the exact origins come from the deployment environment; in production they additionally need the owner's explicit approval of the
// PERMANENT domain (credentials are bound to the RP ID for good). Problem CODES only; never a value.

const RP_ID_PATTERN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

function parseOrigins(value) {
  return String(value || "").split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

/** Returns { status: not_configured|invalid|awaiting_approval|available, available, problems: [codes], rpId, rpName, origins } (rpId/origins only when available). */
function validateWebauthnConfig(config = {}) {
  const rpId = String(config.webauthnRpId || "").trim();
  const origins = Array.isArray(config.webauthnOrigins) ? config.webauthnOrigins.map(String) : parseOrigins(config.webauthnOrigins);
  if (!rpId && origins.length === 0) return { status: "not_configured", available: false, problems: [] };
  const production = config.environment === "production";
  const problems = [];
  if (!rpId) problems.push("webauthn_rp_id_missing");
  else if (!RP_ID_PATTERN.test(rpId) || IPV4.test(rpId) || (!rpId.includes(".") && rpId !== "localhost")) problems.push("webauthn_rp_id_invalid");
  if (origins.length === 0) problems.push("webauthn_origins_missing");
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { problems.push("webauthn_origin_invalid"); continue; }
    if (!["https:", "http:"].includes(url.protocol) || url.origin !== origin || url.username || url.password) { problems.push("webauthn_origin_invalid"); continue; }
    if (url.protocol === "http:" && (production || !LOCAL_HOSTS.has(url.hostname))) { problems.push("webauthn_insecure_origin"); continue; }
    if (rpId && url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) problems.push("webauthn_origin_rp_mismatch");
  }
  const unique = [...new Set(problems)];
  if (unique.length) return { status: "invalid", available: false, problems: unique };
  if (production && String(config.webauthnRpApproved || "").trim() !== rpId) return { status: "awaiting_approval", available: false, problems: ["webauthn_production_not_approved"] };
  return { status: "available", available: true, problems: [], rpId, rpName: String(config.webauthnRpName || "Ochiga Office").slice(0, 80) || "Ochiga Office", origins };
}

module.exports = { validateWebauthnConfig, parseOrigins };
