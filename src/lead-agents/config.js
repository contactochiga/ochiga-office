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
    // The one canonical browser origin for every Office identity link.
    // Production must set this explicitly; local development may omit it
    // so links follow the localhost request that started the operation.
    officeAppUrl: String(
      process.env.OFFICE_APP_URL ||
      (process.env.NODE_ENV === "production" ? "https://office.ochiga.com.ng" : "")
    ).replace(/\/$/, ""),
    // The Facility owner-activation email must send the invited owner to
    // the actual facility-oyi Next.js frontend, not any Backend/API
    // host. FACILITY_APP_URL is Backend's own established name for this
    // exact origin (already referenced in Ochiga-backend's CORS
    // allowlist, src/config/originPolicy.ts) -- reusing it here rather
    // than inventing a new name. Production incident: the activation
    // link previously used officeFacilityBaseUrl, which is a genuinely
    // different, pre-existing config group (Office -> Backend's own
    // "facility export" API surface, see office-sync.js) that happens to
    // share the word "facility" -- not a frontend URL at all. The
    // fallback below is the real, empirically-confirmed live production
    // domain (facility.oyi.com does not resolve; facility-oyi.vercel.app
    // 404s on real routes; facility.getoyi.com serves /login and
    // /facility-invite with 200), not a guess.
    facilityAppUrl: String(
      process.env.FACILITY_APP_URL ||
      (process.env.NODE_ENV === "production" ? "https://facility.getoyi.com" : "")
    ).replace(/\/$/, ""),
    defaultLeadSource: process.env.LEAD_AGENTS_DEFAULT_SOURCE || "website_chat",
    environment: process.env.NODE_ENV || "development",
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
    // Ochiga Website's own real health endpoint (added alongside its
    // Oyi Cross-Surface Observability Closure work) — replaces trace-
    // inference in System Health with a genuine probe, same pattern as
    // Facility/Consumer above. www. is the real production alias
    // (bare ochiga.com.ng 307-redirects here) — pointing directly at
    // it avoids an unnecessary redirect hop on every probe.
    officeWebsiteBaseUrl: process.env.OFFICE_WEBSITE_BASE_URL || "https://www.ochiga.com.ng",
    officeWebsiteHealthPath: process.env.OFFICE_WEBSITE_HEALTH_PATH || "/api/health",
    // Oyi Cross-Surface Observability Closure — Backend's new safe,
    // cross-surface read endpoint (Consumer/Facility/Website-Oyi-widget
    // conversation, voice, vision and device-execution activity Office's
    // own local traces table has no visibility into).
    officeObservabilityEventsPath:
      process.env.OFFICE_OBSERVABILITY_EVENTS_PATH || "/office/observability/events",
    // Oyi Runtime Contract, Domain 3 (Task) — additive projection of the
    // 4 genuine overlapping commercial workflow types into Backend's
    // ochiga_workflows. Default ON, but a single env flag disables the
    // bridge entirely without touching any call site — that IS the
    // rollback mechanism.
    officeWorkflowBridgeEnabled: booleanFromEnv(process.env.OFFICE_WORKFLOW_BRIDGE_ENABLED, true),
    officeWorkflowsPath: process.env.OFFICE_WORKFLOWS_PATH || "/office/workflows",
    // Tasks Domain UI — Office's own additive bridge into the Shared
    // Automation Runtime (Ochiga-backend src/routes/scenes.ts). Unlike
    // the fire-and-forget workflow bridge above, these calls are
    // synchronous, user-initiated CRUD from the Automations page and
    // must surface real errors to the admin, not silently degrade.
    officeAutomationsPath: process.env.OFFICE_AUTOMATIONS_PATH || "/office/automations",
    officeBackendBaseUrl:
      process.env.OFFICE_BACKEND_BASE_URL ||
      process.env.OYI_BACKEND_BASE_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      "",
    // Office's own publicly-reachable base URL — distinct from
    // officeBackendBaseUrl above (the separate Oyi/lead-agent backend
    // service). Used to resolve Office-hosted storage URLs (e.g.
    // /api/lead-agents/admin/storage/<file>) into fetchable absolute
    // URLs when uploading an asset onward to Sanity.
    officePublicBaseUrl: process.env.OFFICE_PUBLIC_BASE_URL || "",
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
    // Defaults to whatever the DB driver already is: Render's local disk
    // does not survive a redeploy, so if we're already committed to
    // Supabase for the database, media persistence should follow the
    // same commitment rather than silently staying on ephemeral local
    // disk until someone remembers to set a second env var. Explicit
    // OFFICE_STORAGE_DRIVER always wins when set.
    officeStorageDriver:
      process.env.OFFICE_STORAGE_DRIVER ||
      (process.env.LEAD_AGENTS_STORE_DRIVER === "supabase" ? "supabase" : "local"),
    officeStorageBucket: process.env.OFFICE_STORAGE_BUCKET || "office-media",
    officeStorageDir:
      process.env.OFFICE_STORAGE_DIR || path.join(cwd, "data", "office-storage"),
  };
}

module.exports = {
  createConfig,
};
