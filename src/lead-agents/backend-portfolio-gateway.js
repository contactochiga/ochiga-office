const axios = require("axios");

// Server-to-server bridge to Ochiga Backend's safe Portfolio projection
// contract (GET /office/portfolio/projection). This is the ONLY source
// Office's Portfolio module reads Oyi operational data from — never the
// broader /office/export sync, never Office's own office_estates/
// office_buildings/office_devices copies. The backend route itself only
// computes aggregate counts, so there is nothing sensitive to leak even
// if this call's response were logged or cached.
function projectionUrl(config = {}) {
  const base = String(config.officeBackendBaseUrl || "").replace(/\/+$/g, "");
  if (!base) return "";
  return `${base}/office/portfolio/projection`;
}

async function fetchBackendPortfolioProjection(config = {}, options = {}) {
  const url = projectionUrl(config);
  if (!url) {
    return { ok: false, reason: "not_configured", estates: [], buildings: [] };
  }

  const headers = { "content-type": "application/json" };
  if (config.officeBackendApiKey) headers["x-office-api-key"] = config.officeBackendApiKey;
  if (config.officeBackendBearerToken) headers.authorization = `Bearer ${config.officeBackendBearerToken}`;

  const get = options.httpGet || ((targetUrl, requestConfig) => axios.get(targetUrl, requestConfig));
  try {
    const response = await get(url, {
      timeout: config.officeBackendEventTimeoutMs || 10_000,
      headers,
      validateStatus: () => true,
    });
    if (response.status >= 200 && response.status < 300 && response.data) {
      return {
        ok: true,
        estates: Array.isArray(response.data.estates) ? response.data.estates : [],
        buildings: Array.isArray(response.data.buildings) ? response.data.buildings : [],
        generated_at: response.data.generated_at || null,
      };
    }
    return { ok: false, reason: `backend_http_${response.status}`, estates: [], buildings: [] };
  } catch (error) {
    return {
      ok: false,
      reason: error && error.code === "ECONNABORTED" ? "backend_timeout" : "backend_unreachable",
      estates: [],
      buildings: [],
    };
  }
}

module.exports = {
  fetchBackendPortfolioProjection,
  projectionUrl,
};
