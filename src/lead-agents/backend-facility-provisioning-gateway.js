const axios = require("axios");

// Server-to-server bridge to Ochiga Backend's facility-provisioning intake
// (POST /office/facility/provision) -- commercial production-hardening.
// Same x-office-api-key trust boundary already used by
// backend-portfolio-gateway.js/backend-financial-gateway.js, just a WRITE
// call instead of a read. This is the ONLY path that creates a new
// production estate now that Backend's own public signup no longer does.
function provisionUrl(config = {}) {
  const base = String(config.officeBackendBaseUrl || "").replace(/\/+$/g, "");
  if (!base) return "";
  return `${base}/office/facility/provision`;
}

async function provisionBackendFacility(config = {}, input = {}, options = {}) {
  const url = provisionUrl(config);
  if (!url) {
    return { ok: false, reason: "not_configured" };
  }

  const headers = { "content-type": "application/json" };
  if (config.officeBackendApiKey) headers["x-office-api-key"] = config.officeBackendApiKey;
  if (config.officeBackendBearerToken) headers.authorization = `Bearer ${config.officeBackendBearerToken}`;

  const post = options.httpPost || ((targetUrl, body, requestConfig) => axios.post(targetUrl, body, requestConfig));
  try {
    const response = await post(url, input, {
      timeout: config.officeBackendEventTimeoutMs || 10_000,
      headers,
      validateStatus: () => true,
    });
    const body = response.data || {};
    if (response.status >= 200 && response.status < 300 && body.ok !== false) {
      return {
        ok: true,
        estate: body.estate || null,
        invite: body.invite || null,
        activation_token: body.activation_token || null,
      };
    }
    return { ok: false, reason: body.error || `backend_http_${response.status}`, status: response.status };
  } catch (error) {
    return {
      ok: false,
      reason: error && error.code === "ECONNABORTED" ? "backend_timeout" : "backend_unreachable",
    };
  }
}

// Office->Facility provisioning lifecycle -- owner-invite resend/revoke
// (requirement #14). Same URL/header/error-shape convention as
// provisionBackendFacility above, just two more thin proxy calls onto
// Backend's new Office-gated owner-invite routes.
function ownerInviteUrl(config = {}, estateId, action) {
  const base = String(config.officeBackendBaseUrl || "").replace(/\/+$/g, "");
  if (!base || !estateId) return "";
  return `${base}/office/facility/estates/${encodeURIComponent(estateId)}/owner-invite/${action}`;
}

async function callOwnerInviteAction(config, estateId, action, options = {}) {
  const url = ownerInviteUrl(config, estateId, action);
  if (!url) return { ok: false, reason: "not_configured" };

  const headers = { "content-type": "application/json" };
  if (config.officeBackendApiKey) headers["x-office-api-key"] = config.officeBackendApiKey;
  if (config.officeBackendBearerToken) headers.authorization = `Bearer ${config.officeBackendBearerToken}`;

  const post = options.httpPost || ((targetUrl, body, requestConfig) => axios.post(targetUrl, body, requestConfig));
  try {
    const response = await post(url, {}, {
      timeout: config.officeBackendEventTimeoutMs || 10_000,
      headers,
      validateStatus: () => true,
    });
    const body = response.data || {};
    if (response.status >= 200 && response.status < 300 && body.ok !== false) {
      return { ok: true, invite: body.invite || null, activation_token: body.activation_token || null };
    }
    return { ok: false, reason: body.error || `backend_http_${response.status}`, status: response.status };
  } catch (error) {
    return { ok: false, reason: error && error.code === "ECONNABORTED" ? "backend_timeout" : "backend_unreachable" };
  }
}

async function resendBackendFacilityOwnerInvite(config, estateId, options) {
  return callOwnerInviteAction(config, estateId, "resend", options);
}

async function revokeBackendFacilityOwnerInvite(config, estateId, options) {
  return callOwnerInviteAction(config, estateId, "revoke", options);
}

module.exports = {
  provisionBackendFacility,
  provisionUrl,
  resendBackendFacilityOwnerInvite,
  revokeBackendFacilityOwnerInvite,
};
