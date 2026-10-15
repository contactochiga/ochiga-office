"use strict";

// Settings S7.0: authentication-secret configuration and its readiness check. Contract: docs/settings-domain/19_S7_0_AUTH_SECURITY_CONTRACT.md.
// The session-signing secret comes ONLY from LEAD_AGENTS_SESSION_SECRET. It never falls back to shared API keys or to any hard-coded value. The checker reports problem
// CODES only: never a secret, a length derived from one, or a hint about its content.

const crypto = require("crypto");

const MIN_SESSION_SECRET_LENGTH = 32;
// Known placeholders and the historical hard-coded default (it is public, so it can never be a valid production secret).
const PLACEHOLDER = /^(lead-agents-dev-session-secret|change-?me|changeme|replace-?me|secret|password|session-?secret|dev|development|test|example|your[-_ ]?secret.*|todo|xxx+|0+|1234.*)$/i;

// Configuration fields that hold a secret shared with another system or used for another purpose. The session secret must never equal any of them.
const SHARED_SECRET_FIELDS = [
  "openaiApiKey", "founderWebhookSecret", "demoWebhookSecret", "salesWebhookSecret", "whatsappVerifyToken", "whatsappAccessToken", "metaAppSecret", "metaAccessToken",
  "instagramAccessToken", "facebookPageAccessToken", "linkedinClientSecret", "linkedinAccessToken", "googleOAuthClientSecret", "googleAdsDeveloperToken",
  "officeFacilityApiKey", "officeFacilityBearerToken", "officeConsumerApiKey", "officeConsumerBearerToken", "officeBackendApiKey", "officeBackendBearerToken",
  "officeDigitalTwinApiKey", "officeEventWebhookSecret", "resendApiKey", "supabaseServiceRoleKey", "adminPassword",
];

/** Resolve the session secret from the environment. Outside production an unset secret becomes an EPHEMERAL random one (never a constant). */
function resolveSessionSecret(env = process.env, environment = env.NODE_ENV || "development") {
  const configured = String(env.LEAD_AGENTS_SESSION_SECRET || "");
  if (configured) return { secret: configured, ephemeral: false };
  if (environment === "production") return { secret: "", ephemeral: false };
  return { secret: crypto.randomBytes(32).toString("hex"), ephemeral: true };
}

function sharedSecrets(config) {
  const values = [];
  for (const key of SHARED_SECRET_FIELDS) { const v = config[key]; if (typeof v === "string" && v) values.push(v); }
  for (const list of [config.apiKeys, config.edgeAgentTokens]) if (Array.isArray(list)) for (const v of list) if (typeof v === "string" && v) values.push(v);
  return values;
}

/**
 * Validity of the authentication configuration. Always valid outside production. In production the session secret must be present, long enough, not a placeholder,
 * and distinct from every other shared secret in configuration. Returns { valid, production, problems: [codes], session_secret: "configured" | "invalid" | "ephemeral" }.
 */
function validateAuthConfig(config = {}) {
  const production = config.environment === "production";
  const secret = String(config.sessionSecret || "");
  const problems = [];
  if (production) {
    if (!secret) problems.push("session_secret_missing");
    else {
      if (secret.length < MIN_SESSION_SECRET_LENGTH) problems.push("session_secret_too_short");
      if (PLACEHOLDER.test(secret)) problems.push("session_secret_placeholder");
      const apiKeys = Array.isArray(config.apiKeys) ? config.apiKeys : [];
      if (apiKeys.includes(secret) || secret === apiKeys.join(",")) problems.push("session_secret_shared_with_api_key");
      else if (sharedSecrets(config).includes(secret)) problems.push("session_secret_reused_bridge_secret");
    }
  } else if (!secret) problems.push("session_secret_missing"); // a non-production config object built by hand without any secret still cannot sign
  return { valid: problems.length === 0, production, problems, session_secret: problems.length ? "invalid" : config.sessionSecretEphemeral ? "ephemeral" : "configured" };
}

module.exports = { MIN_SESSION_SECRET_LENGTH, resolveSessionSecret, validateAuthConfig };
