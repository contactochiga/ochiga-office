const axios = require("axios");

// Server-to-server bridge to Ochiga Backend's canonical financial
// aggregation contract (GET /office/financial-summary). This is the ONLY
// source Office should read financial data from — never a per-home wallet
// field, never a raw payments/dues query. The backend route only computes
// aggregate-per-estate and portfolio-total figures (current wallet balance
// snapshot, period revenue, utility sales, service-charge collections),
// so there is nothing resident-identifiable to leak even if this call's
// response were logged or cached.
function financialSummaryUrl(config = {}) {
  const base = String(config.officeBackendBaseUrl || "").replace(/\/+$/g, "");
  if (!base) return "";
  return `${base}/office/financial-summary`;
}

async function fetchBackendFinancialSummary(config = {}, options = {}) {
  const url = financialSummaryUrl(config);
  if (!url) {
    return { ok: false, reason: "not_configured", estates: [], portfolio: null };
  }

  const headers = { "content-type": "application/json" };
  if (config.officeBackendApiKey) headers["x-office-api-key"] = config.officeBackendApiKey;
  if (config.officeBackendBearerToken) headers.authorization = `Bearer ${config.officeBackendBearerToken}`;

  const params = {};
  if (options.estateId) params.estate_id = options.estateId;
  if (options.periodDays) params.period_days = options.periodDays;

  const get = options.httpGet || ((targetUrl, requestConfig) => axios.get(targetUrl, requestConfig));
  try {
    const response = await get(url, {
      timeout: config.officeBackendEventTimeoutMs || 10_000,
      headers,
      params,
      validateStatus: () => true,
    });
    if (response.status >= 200 && response.status < 300 && response.data) {
      return {
        ok: true,
        estates: Array.isArray(response.data.estates) ? response.data.estates : [],
        portfolio: response.data.portfolio || null,
        period_start: response.data.period_start || null,
        period_end: response.data.period_end || null,
        generated_at: response.data.generated_at || null,
      };
    }
    return { ok: false, reason: `backend_http_${response.status}`, estates: [], portfolio: null };
  } catch (error) {
    return {
      ok: false,
      reason: error && error.code === "ECONNABORTED" ? "backend_timeout" : "backend_unreachable",
      estates: [],
      portfolio: null,
    };
  }
}

module.exports = {
  fetchBackendFinancialSummary,
  financialSummaryUrl,
};
