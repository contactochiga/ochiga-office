const path = require("path");

function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringListFromEnv(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function createConfig() {
  const cwd = process.cwd();

  return {
    port: numberFromEnv(process.env.LEAD_AGENTS_PORT, 8787),
    host: process.env.LEAD_AGENTS_HOST || "0.0.0.0",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    openaiModel: process.env.OPENAI_MODEL || "gpt-5-mini",
    openaiTranscriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1",
    requestTimeoutMs: numberFromEnv(process.env.LEAD_AGENTS_REQUEST_TIMEOUT_MS, 120000),
    maxToolRounds: numberFromEnv(process.env.LEAD_AGENTS_MAX_TOOL_ROUNDS, 8),
    maxConversationMessages: numberFromEnv(
      process.env.LEAD_AGENTS_MAX_CONVERSATION_MESSAGES,
      24
    ),
    storePath:
      process.env.LEAD_AGENTS_STORE_PATH ||
      path.join(cwd, "data", "lead-agents-store.json"),
    founderWebhookUrl: process.env.FOUNDER_ALERT_WEBHOOK_URL || "",
    founderWebhookSecret: process.env.FOUNDER_ALERT_WEBHOOK_SECRET || "",
    demoWebhookUrl: process.env.DEMO_WEBHOOK_URL || "",
    demoWebhookSecret: process.env.DEMO_WEBHOOK_SECRET || "",
    allowedOrigins: stringListFromEnv(process.env.LEAD_AGENTS_ALLOWED_ORIGINS),
    defaultLeadSource: process.env.LEAD_AGENTS_DEFAULT_SOURCE || "website_chat",
    environment: process.env.NODE_ENV || "development",
    toolsPath: path.join(cwd, "config", "openai", "lead-agent-tools.json"),
    promptPackRoot: path.join(cwd, "prompt-packs"),
    knowledgeDir:
      process.env.LEAD_AGENTS_KNOWLEDGE_DIR || path.join(cwd, "knowledge"),
    tracePath:
      process.env.LEAD_AGENTS_TRACE_PATH ||
      path.join(cwd, "data", "lead-agent-traces.jsonl"),
    leadMemoryPath:
      process.env.LEAD_AGENTS_MEMORY_PATH ||
      path.join(cwd, "data", "lead-memory.json"),
    storeDriver: process.env.LEAD_AGENTS_STORE_DRIVER || "file",
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    authMode: process.env.LEAD_AGENTS_AUTH_MODE || "optional_api_key",
    apiKeys: stringListFromEnv(process.env.LEAD_AGENTS_API_KEYS),
    edgeAgentTokens: stringListFromEnv(
      process.env.OYI_EDGE_AGENT_TOKENS || process.env.OYI_EDGE_AGENT_TOKEN
    ),
    adminEmail: process.env.LEAD_AGENTS_ADMIN_EMAIL || "",
    adminPassword: process.env.LEAD_AGENTS_ADMIN_PASSWORD || "",
    adminRole: process.env.LEAD_AGENTS_ADMIN_ROLE || "admin",
    sessionSecret:
      process.env.LEAD_AGENTS_SESSION_SECRET ||
      process.env.LEAD_AGENTS_API_KEYS ||
      "lead-agents-dev-session-secret",
    sessionCookieName:
      process.env.LEAD_AGENTS_SESSION_COOKIE_NAME || "lead_agents_admin",
    sessionTtlMs: numberFromEnv(
      process.env.LEAD_AGENTS_SESSION_TTL_MS,
      7 * 24 * 60 * 60 * 1000
    ),
    rateLimitWindowMs: numberFromEnv(
      process.env.LEAD_AGENTS_RATE_LIMIT_WINDOW_MS,
      60_000
    ),
    rateLimitMaxRequests: numberFromEnv(
      process.env.LEAD_AGENTS_RATE_LIMIT_MAX_REQUESTS,
      60
    ),
    officeRateLimitWindowMs: numberFromEnv(
      process.env.LEAD_AGENTS_OFFICE_RATE_LIMIT_WINDOW_MS,
      numberFromEnv(process.env.LEAD_AGENTS_RATE_LIMIT_WINDOW_MS, 60_000)
    ),
    officeRateLimitMaxRequests: numberFromEnv(
      process.env.LEAD_AGENTS_OFFICE_RATE_LIMIT_MAX_REQUESTS,
      300
    ),
    loginRateLimitWindowMs: numberFromEnv(
      process.env.LEAD_AGENTS_LOGIN_RATE_LIMIT_WINDOW_MS,
      15 * 60 * 1000
    ),
    loginRateLimitMaxAttempts: numberFromEnv(
      process.env.LEAD_AGENTS_LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
      10
    ),
    publicWidgetRateLimitWindowMs: numberFromEnv(
      process.env.PUBLIC_WIDGET_RATE_LIMIT_WINDOW_MS,
      numberFromEnv(process.env.LEAD_AGENTS_RATE_LIMIT_WINDOW_MS, 60_000)
    ),
    publicWidgetRateLimitMaxRequests: numberFromEnv(
      process.env.PUBLIC_WIDGET_RATE_LIMIT_MAX_REQUESTS,
      18
    ),
    publicWidgetMaxMessageChars: numberFromEnv(
      process.env.PUBLIC_WIDGET_MAX_MESSAGE_CHARS,
      1800
    ),
    salesWebhookUrl: process.env.SALES_ALERT_WEBHOOK_URL || "",
    salesWebhookSecret: process.env.SALES_ALERT_WEBHOOK_SECRET || "",
    whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
    whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
    whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    whatsappBusinessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "",
    whatsappApiVersion: process.env.WHATSAPP_API_VERSION || "v22.0",
    metaAppId: process.env.META_APP_ID || "",
    metaAppSecret: process.env.META_APP_SECRET || "",
    metaAccessToken: process.env.META_ACCESS_TOKEN || "",
    instagramBusinessAccountId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || "",
    instagramAccessToken: process.env.INSTAGRAM_ACCESS_TOKEN || "",
    facebookPageId: process.env.FACEBOOK_PAGE_ID || "",
    facebookPageAccessToken:
      process.env.FACEBOOK_PAGE_ACCESS_TOKEN ||
      process.env.FACEBOOK_ACCESS_TOKEN ||
      process.env.FACEBOOK_TOKEN ||
      "",
    linkedinClientId: process.env.LINKEDIN_CLIENT_ID || "",
    linkedinClientSecret: process.env.LINKEDIN_CLIENT_SECRET || "",
    linkedinOrganizationId: process.env.LINKEDIN_ORGANIZATION_ID || "",
    linkedinRedirectUri: process.env.LINKEDIN_REDIRECT_URI || "",
    linkedinAccessToken: process.env.LINKEDIN_ACCESS_TOKEN || "",
    googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    googleOAuthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
    googleAdsDeveloperToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "",
    googleAdsCustomerId: process.env.GOOGLE_ADS_CUSTOMER_ID || "",
    googleAnalyticsPropertyId: process.env.GOOGLE_ANALYTICS_PROPERTY_ID || "",
    googleAnalyticsMeasurementId: process.env.GOOGLE_ANALYTICS_MEASUREMENT_ID || "",
    officeFacilityBaseUrl: process.env.OFFICE_FACILITY_BASE_URL || "",
    officeFacilityApiKey: process.env.OFFICE_FACILITY_API_KEY || "",
    officeFacilityBearerToken: process.env.OFFICE_FACILITY_BEARER_TOKEN || "",
    officeFacilityExportPath: process.env.OFFICE_FACILITY_EXPORT_PATH || "",
    officeConsumerBaseUrl: process.env.OFFICE_CONSUMER_BASE_URL || "",
    officeConsumerApiKey: process.env.OFFICE_CONSUMER_API_KEY || "",
    officeConsumerBearerToken: process.env.OFFICE_CONSUMER_BEARER_TOKEN || "",
    officeConsumerExportPath: process.env.OFFICE_CONSUMER_EXPORT_PATH || "",
    officeBackendBaseUrl:
      process.env.OFFICE_BACKEND_BASE_URL ||
      process.env.OYI_BACKEND_BASE_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      "",
    officeBackendApiKey:
      process.env.OFFICE_BACKEND_API_KEY ||
      process.env.OFFICE_SYNC_API_KEY ||
      process.env.OFFICE_EXPORT_API_KEY ||
      "",
    officeBackendBearerToken:
      process.env.OFFICE_BACKEND_BEARER_TOKEN ||
      process.env.OYI_BACKEND_BEARER_TOKEN ||
      "",
    officeBackendEventsEnabled: booleanFromEnv(
      process.env.OFFICE_BACKEND_EVENTS_ENABLED,
      false
    ),
    officeBackendEventPath:
      process.env.OFFICE_BACKEND_EVENT_PATH || "/office/events/material",
    officeBackendConversationPath:
      process.env.OFFICE_BACKEND_CONVERSATION_PATH || "/office/conversation/corporate",
    officeBackendInternalConversationPath:
      process.env.OFFICE_BACKEND_INTERNAL_CONVERSATION_PATH || "/office/conversation/internal",
    officeBackendEventTimeoutMs: numberFromEnv(
      process.env.OFFICE_BACKEND_EVENT_TIMEOUT_MS,
      10_000
    ),
    officeBackendEventMaxAttempts: numberFromEnv(
      process.env.OFFICE_BACKEND_EVENT_MAX_ATTEMPTS,
      2
    ),
    officeDigitalTwinBaseUrl: process.env.OFFICE_DIGITAL_TWIN_BASE_URL || "",
    officeDigitalTwinApiKey: process.env.OFFICE_DIGITAL_TWIN_API_KEY || "",
    officeDigitalTwinStatePath: process.env.OFFICE_DIGITAL_TWIN_STATE_PATH || "",
    officeEventWebhookSecret: process.env.OFFICE_EVENT_WEBHOOK_SECRET || "",
    appStoreConnectIssuerId: process.env.APP_STORE_CONNECT_ISSUER_ID || "",
    appStoreConnectKeyId: process.env.APP_STORE_CONNECT_KEY_ID || "",
    appStoreConnectPrivateKey: process.env.APP_STORE_CONNECT_PRIVATE_KEY || "",
    appStoreAppId: process.env.APP_STORE_APP_ID || "",
    oyiHomeAppStoreUrl: process.env.OYI_HOME_APP_STORE_URL || "",
    oyiHomeBundleId: process.env.OYI_HOME_BUNDLE_ID || process.env.APNS_BUNDLE_ID || "",
    officeEmailProvider: process.env.OFFICE_EMAIL_PROVIDER || "",
    officeEmailFrom: process.env.OFFICE_EMAIL_FROM || "Ochiga Office <office@getoyi.com>",
    resendApiKey: process.env.RESEND_API_KEY || "",
    mapProvider: process.env.OFFICE_MAP_PROVIDER || "static",
    mapboxPublicToken: process.env.MAPBOX_PUBLIC_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "",
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "",
    officeDocumentBrandName: process.env.OFFICE_DOCUMENT_BRAND_NAME || "OCHIGA OFFICE",
    officeStorageDriver: process.env.OFFICE_STORAGE_DRIVER || "local",
    officeStorageDir:
      process.env.OFFICE_STORAGE_DIR || path.join(cwd, "data", "office-storage"),
  };
}

module.exports = {
  createConfig,
};
