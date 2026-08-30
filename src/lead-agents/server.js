require("dotenv").config();
require("dotenv").config({ path: ".env.lead-agents.local", override: true });
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const { createConfig } = require("./config");
const { log } = require("./logger");
const { createStore } = require("./store-factory");
const { OpenAIResponsesClient } = require("./openai");
const { ToolExecutor } = require("./tools");
const { WebhookDispatcher } = require("./webhooks");
const {
  authorizePermission,
  clearSessionCookie,
  createAdminSessionToken,
  createSessionCookie,
  enforceAuth,
  hashPassword,
  permissionsForRole,
  readAdminSession,
  verifyPassword,
} = require("./auth");
const { MemoryRateLimiter } = require("./rate-limit");
const { PATCH_FIELDS, normalizeEmail, normalizeLeadInput, normalizeText } = require("./normalize-lead");
const {
  findExistingIntakeLead,
  findOrUpsertLead,
  normalizeOfficeIntakeEnvelope,
  runOfficeIntakeCrm,
} = require("./office-intake");
const {
  buildMaterialCrmEvent,
  publishBackendMaterialEvent,
} = require("./backend-events");
const {
  buildOyiCoreCorporateRequest,
  buildPublicIntelligenceSession,
  createFormContinuationContext,
  detectBlockedPublicOperationalRequest,
} = require("./public-intelligence");
const {
  buildOyiCoreCorporateConversationRequest,
  buildOyiCoreOfficeInternalRequest,
  callOyiCoreCorporateConversation,
  callOyiCoreOfficeInternalConversation,
  callOyiCoreSpeechSynthesis,
  callOyiCoreObservabilityEvents,
  callOyiCoreListAutomations,
  callOyiCoreGetAutomation,
  callOyiCoreCreateAutomation,
  callOyiCoreUpdateAutomation,
  callOyiCoreDeleteAutomation,
  callOyiCoreListAutomationRuns,
  callOyiCoreTestAutomation,
  callOyiCoreGetWorkflow,
  callOyiCoreListWorkflows,
} = require("./oyi-core-gateway");
const { bridgeWorkflow, transitionLinkedWorkflow } = require("./workflow-bridge");
const { executeGovernedOfficeToolProposals } = require("./office-tool-governance");
const { listDocumentTemplates, renderDocumentFromTemplate } = require("./office-document-templates");
const { sanityConfigured, saveDraftToSanity, publishToSanity, unpublishFromSanity, syncDevelopmentProjectToSanity, slugify } = require("./sanity-adapter");
const { fetchBackendPortfolioProjection } = require("./backend-portfolio-gateway");
const { fetchBackendFinancialSummary } = require("./backend-financial-gateway");
const {
  CORPORATE_COLLECTIONS,
  buildOfficeHomeProjection,
  attachPortfolioOperationalProjections,
  createCorporateRecord,
  listCorporateRecords,
  upsertContactIdentity,
  validateCommercialDocumentDraft,
  notifyRecipients,
} = require("./office-operating-system");
const {
  canCreateActivityForRelatedObject,
  createOrUpdateHandoff,
  createRelatedActivity,
  findCorporateRecord,
  listHandoffQueue,
  listRelatedActivities,
  persistCorporateRecord,
  updateHandoff,
  updateOperationalRecord,
  validateOperationalRelationships,
  validateRelatedObject,
} = require("./office-operational-workflows");
const { WhatsAppCloudAdapter } = require("./whatsapp");
const { resolveRecipient, resolveRecipientByEntity } = require("./recipient-resolution");
const { buildCalendarLinks, parsePreferredSchedule } = require("./scheduling");
const { buildProposal, inferCommercialFacts } = require("./commercial");
const { PIPELINE_STAGES, qualifyLead } = require("./commercial-ops");
const { createDigitalTwinRuntime } = require("./digital-twin");
const { createPlanStudioRuntime } = require("./plan-studio");
const { createOfficeSyncService } = require("./office-sync");
const { appendAuditRecord } = require("./audit");
const { PERMISSION_KEYS, ROLE_PERMISSIONS, hasPermission } = require("./permissions");
const { createRealtimeHub } = require("./realtime");
const { createStorageService } = require("./storage");
const {
  facilityOwnerInviteEmail,
  passwordResetEmail,
  sendOfficeEmail,
  staffInviteEmail,
} = require("./email");
const { provisionBackendFacility, resendBackendFacilityOwnerInvite, revokeBackendFacilityOwnerInvite } = require("./backend-facility-provisioning-gateway");
const { credentialPayloadForUser, qrSvg } = require("./qr");
const {
  createRequestContext,
  getPathname,
  json,
  methodNotAllowed,
  notFound,
  readJsonBody,
  readJsonBodyWithRaw,
  serveFile,
  serveBuffer,
  setCorsHeaders,
} = require("./http");

function validateConfig(config) {
  if (!config.openaiApiKey) {
    throw new Error("Missing OPENAI_API_KEY for lead agents backend");
  }
}

function parseBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === "true";
}

function secureCompare(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getEdgeToken(req) {
  const authHeader = String(req.headers.authorization || "");
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  return String(req.headers["x-edge-token"] || req.headers["x-oyi-edge-token"] || "").trim();
}

function tryEdgeAuth(req, config) {
  const token = getEdgeToken(req);
  if (!token || !Array.isArray(config.edgeAgentTokens) || config.edgeAgentTokens.length === 0) {
    return null;
  }
  const allowed = config.edgeAgentTokens.some((candidate) => secureCompare(candidate, token));
  if (!allowed) return null;
  return {
    type: "edge_token",
    role: "ai_agent",
    email: "edge-agent@oyi.local",
    userId: "oyi_edge_agent",
    permissions: permissionsForRole("ai_agent", ["twin.control", "devices.control"]),
  };
}

function loginAttemptKey(req, email) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const ip = forwarded || req.socket.remoteAddress || "unknown";
  return `${normalizeEmail(email) || "unknown"}:${ip}`;
}

function requireObject(body, name) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error(`${name} must be an object`);
    error.statusCode = 400;
    throw error;
  }
}

// Office->Facility provisioning lifecycle. The one shared implementation
// of "create a facility_workspaces row, call Backend's /office/facility/
// provision intake, and (only on success) build + send the owner-
// activation email" -- both the existing lead-anchored route and the new
// Portfolio-anchored route (requirement #1) call this, so there is exactly
// one place that does the real provisioning work, not two. Reuses the
// exact staff-invite pattern already proven in this file: create, send via
// Resend, gracefully degrade to a copyable link if email isn't
// configured, never fail the whole request just because delivery failed.
// Backend never sends this email itself (see officeExport.ts's own
// comment) -- Office always owns and sends its own branded copy.
async function provisionFacilityWorkspaceCore(store, config, authContext, input) {
  const workspace = await store.createFacilityWorkspace({
    lead_id: input.leadId || null,
    portfolio_id: input.portfolioId || null,
    facility_admin_email: input.facilityAdminEmail,
    facility_admin_full_name: input.facilityAdminFullName || "",
    facility_admin_phone: input.facilityAdminPhone || "",
    customer_organization: input.customerOrganization,
    estate_name: input.estateName,
    actor: authContext?.email || "office",
  });

  let provisioning = { ok: false, reason: "not_attempted" };
  let workspaceUpdate = null;
  if (input.facilityAdminEmail) {
    provisioning = await provisionBackendFacility(config, {
      name: input.estateName,
      address: input.address || "",
      type: input.facilityType || "estate",
      timezone: input.timezone || "",
      admin_email: input.facilityAdminEmail,
      requested_by: authContext?.email || "office",
    });
    if (provisioning.ok) {
      // Facility's (auth) directory is a Next.js route GROUP, not a real
      // URL segment -- its pages resolve at the bare path (e.g. /login,
      // /signup), so the activation page is genuinely at /facility-invite,
      // not /auth/facility-invite.
      const activationLink = `${String(config.officeFacilityBaseUrl || "").replace(/\/+$/, "")}/facility-invite?token=${encodeURIComponent(provisioning.activation_token)}`;
      const emailResult = await sendOfficeEmail(
        config,
        facilityOwnerInviteEmail({ estateName: input.estateName, inviteUrl: activationLink, expiresAt: provisioning.invite?.expires_at })
      ).catch((err) => ({ delivered: false, skipped: true, reason: err?.message || "email_send_failed" }));
      workspaceUpdate = await store.updateFacilityWorkspace(workspace.id, {
        status: "invitation_sent",
        activation_link: activationLink,
        checklist: {
          ...(workspace.checklist || {}),
          customer_organization: "created",
          estate_or_building_record: "created",
          facility_admin_invite: emailResult.delivered ? "sent" : "ready_to_send",
          deployment_project: input.leadId ? "linked" : "not_applicable",
          onboarding_email: emailResult.delivered ? "sent" : "not_delivered",
        },
      });
    }
  }
  return { workspace: workspaceUpdate || workspace, provisioning, workspaceCreatedId: workspace.id };
}

// store.listAdminUsers()/updateAdminUser() return the raw admin_users row,
// which includes password_hash — never let that reach a response, even to
// a caller with staff.manage permission.
function sanitizeAdminUser(user) {
  if (!user) return user;
  const { password_hash, ...safe } = user;
  return safe;
}

function requireKnownRole(role) {
  const normalized = String(role || "viewer");
  if (!Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, normalized)) {
    const error = new Error("invalid_role");
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

// Who should be told about a create/update on a given collection's
// record — empty array means "no single owner, broadcast instead"
// rather than "notify nobody". Kept in one place so trigger coverage
// stays consistent instead of drifting per route.
function notificationTargetsForRecord(collection, record) {
  if (collection === "tasks") return [record.assignee].filter(Boolean);
  if (collection === "support") return [record.assigned_staff].filter(Boolean);
  if (collection === "meetings") return Array.isArray(record.participants) ? record.participants.filter(Boolean) : [];
  return [];
}
function notificationSummaryForRecord(collection, action, record) {
  const label = record.title || record.name || "Record";
  if (collection === "tasks") return action === "created" ? `New task assigned: ${label}` : `Task updated: ${label} (${record.status})`;
  if (collection === "support") return action === "created" ? `Support case assigned: ${label}` : `Support case updated: ${label} (${record.status})`;
  if (collection === "meetings") return `Meeting scheduled: ${label}`;
  if (collection === "projects") return `Project updated: ${label} (${record.status})`;
  if (collection === "portfolio") return `Portfolio entry updated: ${label} (${record.status})`;
  if (collection === "private") return `Private relationship updated: ${label} (${record.review_status || record.status})`;
  if (collection === "partnerships") return `Partnership updated: ${label} (${record.review_status || record.status})`;
  return `${titleCaseServer(collection)} updated: ${label}`;
}
function titleCaseServer(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function taskRelatedActivityRef(task = {}) {
  if (task.private_relationship_id) return { related_type: "private_relationship", related_id: task.private_relationship_id };
  if (task.partnership_relationship_id) return { related_type: "partnership_relationship", related_id: task.partnership_relationship_id };
  if (task.support_case_id) return { related_type: "support_case", related_id: task.support_case_id };
  if (task.project_id) return { related_type: "project", related_id: task.project_id };
  if (task.portfolio_id) return { related_type: "portfolio", related_id: task.portfolio_id };
  if (task.opportunity_id) return { related_type: "opportunity", related_id: task.opportunity_id };
  if (task.lead_id) return { related_type: "lead", related_id: task.lead_id };
  return null;
}

function sparseLeadPatchFromBody(body) {
  const patch = {};
  for (const field of PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      patch[field] = body[field];
    }
  }
  return patch;
}

function customerServiceWindowExpiry(timestampSeconds) {
  const baseMs = Number(timestampSeconds || 0) * 1000 || Date.now();
  return new Date(baseMs + 24 * 60 * 60 * 1000).toISOString();
}

function generateOpaqueToken() {
  return crypto.randomBytes(24).toString("hex");
}

function hashOpaqueToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function parseDataUrl(value) {
  const match = String(value || "").match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) return null;
  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const body = match[3] || "";
  return {
    mimeType,
    buffer: isBase64 ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8"),
  };
}

function extensionForAudioMime(mimeType) {
  const clean = String(mimeType || "").toLowerCase();
  if (clean.includes("mp4") || clean.includes("m4a")) return ".m4a";
  if (clean.includes("mpeg") || clean.includes("mp3")) return ".mp3";
  if (clean.includes("wav")) return ".wav";
  if (clean.includes("ogg")) return ".ogg";
  if (clean.includes("webm")) return ".webm";
  return ".webm";
}

function statusLabel(configured, productionReady, hasError = false, payloadIncomplete = false) {
  if (hasError) return "error";
  if (productionReady) return "production_ready";
  if (payloadIncomplete) return "configured_payload_incomplete";
  if (configured) return "configured_needs_validation";
  return "missing_credentials";
}

function authHeadersFromConfig(config, keyName) {
  const headers = {};
  if (config[`${keyName}ApiKey`]) {
    headers["x-api-key"] = config[`${keyName}ApiKey`];
  }
  if (config[`${keyName}BearerToken`]) {
    headers.authorization = `Bearer ${config[`${keyName}BearerToken`]}`;
  }
  return headers;
}

function collectionPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  return payload.collections && typeof payload.collections === "object" ? payload.collections : payload;
}

function payloadSupport(payload, requiredKeys, domain) {
  const collections = collectionPayload(payload);
  const completeness = payload && typeof payload === "object" && payload.completeness && typeof payload.completeness === "object"
    ? payload.completeness
    : {};
  const domainCompleteness = domain && completeness[domain] && typeof completeness[domain] === "object"
    ? completeness[domain]
    : {};
  const missing = requiredKeys.filter((key) => {
    if (Object.prototype.hasOwnProperty.call(domainCompleteness, key)) {
      return !domainCompleteness[key];
    }
    if (key === "users" && Object.prototype.hasOwnProperty.call(domainCompleteness, "residents")) {
      return !domainCompleteness.residents;
    }
    if (key === "support_mappings" && Object.prototype.hasOwnProperty.call(domainCompleteness, "support")) {
      return !domainCompleteness.support;
    }
    return !Object.prototype.hasOwnProperty.call(collections, key);
  });
  return {
    checked: Boolean(payload && typeof payload === "object"),
    complete: missing.length === 0,
    supported: requiredKeys.filter((key) => !missing.includes(key)),
    missing,
  };
}

async function probeEndpoint(baseUrl, pathName, options = {}) {
  if (!baseUrl) {
    return { checked: false, ok: false, status: "missing_base_url" };
  }
  try {
    const client = axios.create({
      baseURL: String(baseUrl).replace(/\/$/, ""),
      timeout: Math.min(Number(options.timeoutMs || 3500), 5000),
      headers: options.headers || {},
      validateStatus: () => true,
    });
    const response = await client.get(pathName || "/health");
    const ok = response.status >= 200 && response.status < 300;
    return {
      checked: true,
      ok,
      status: ok ? "active" : "failed",
      http_status: response.status,
      payload: ok ? response.data : null,
    };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      status: "failed",
      error: error.code || error.name || "request_failed",
    };
  }
}

async function integrationStatus(config, options = {}) {
  const missingKeys = (rows) => rows.filter(([, value]) => !value).map(([key]) => key);
  const hasFacilityAuth = Boolean(config.officeFacilityApiKey || config.officeFacilityBearerToken);
  const hasConsumerAuth = Boolean(config.officeConsumerApiKey || config.officeConsumerBearerToken);
  const hasBackendAuth = Boolean(config.officeBackendApiKey || config.edgeAgentTokens.length);
  const appStoreCredentialReady = Boolean(
    config.appStoreConnectIssuerId &&
      config.appStoreConnectKeyId &&
      config.appStoreConnectPrivateKey &&
      config.appStoreAppId
  );
  const facilityMetrics = [
    "estates",
    "buildings",
    "homes",
    "devices",
    "wallets",
    "analytics",
    "documents",
    "support_mappings",
    "visitors",
    "rooms",
    "users",
    "meta",
    "maintenance",
    "incidents",
    "edge_heartbeats",
    "utility_events",
  ];
  const consumerMetrics = [
    "homes",
    "rooms",
    "users",
    "devices",
    "wallets",
    "visitors",
    "analytics",
    "support_mappings",
    "meta",
    "community",
    "support",
    "automations",
    "notifications",
    "device_telemetry",
  ];
  const backendHealthPromise = probeEndpoint(config.officeBackendBaseUrl, "/health", {
    headers: config.officeBackendApiKey ? { "x-api-key": config.officeBackendApiKey } : {},
  });
  // Oyi Cross-Surface Observability Closure — Ochiga Website's own real
  // /api/health probe, replacing the AI Agents page's previous trace-
  // inference fallback. No auth required (a public liveness endpoint).
  const websiteProbePromise = probeEndpoint(config.officeWebsiteBaseUrl, config.officeWebsiteHealthPath || "/api/health", {});
  const facilityProbePromise = config.officeFacilityBaseUrl && hasFacilityAuth
    ? probeEndpoint(config.officeFacilityBaseUrl, config.officeFacilityExportPath || "/office/export", {
        headers: authHeadersFromConfig(config, "officeFacility"),
      })
    : { checked: false, ok: false, status: "not_configured", payload: null };
  const consumerProbePromise = config.officeConsumerBaseUrl && hasConsumerAuth
    ? probeEndpoint(config.officeConsumerBaseUrl, config.officeConsumerExportPath || "/office/export", {
        headers: authHeadersFromConfig(config, "officeConsumer"),
      })
    : { checked: false, ok: false, status: "not_configured", payload: null };
  const externalTwin = Boolean(config.officeDigitalTwinBaseUrl);
  const twinSceneProbePromise = externalTwin
    ? probeEndpoint(config.officeDigitalTwinBaseUrl, "/api/digital-twin/scene", {
        headers: config.officeDigitalTwinApiKey ? { "x-api-key": config.officeDigitalTwinApiKey } : {},
      })
    : {
        checked: true,
        ok: Boolean(options.digitalTwinRuntime),
        status: options.digitalTwinRuntime ? "active" : "pending",
        same_origin: true,
      };
  const twinStateProbePromise = config.officeDigitalTwinStatePath
    ? externalTwin
      ? probeEndpoint(config.officeDigitalTwinBaseUrl, config.officeDigitalTwinStatePath, {
          headers: config.officeDigitalTwinApiKey ? { "x-api-key": config.officeDigitalTwinApiKey } : {},
        })
      : { checked: true, ok: true, status: "same_origin", same_origin: true }
    : { checked: false, ok: false, status: externalTwin ? "pending" : "same_origin_scene_only" };
  const [backendHealth, facilityProbe, consumerProbe, twinSceneProbe, twinStateProbe, websiteProbe] = await Promise.all([
    backendHealthPromise,
    facilityProbePromise,
    consumerProbePromise,
    twinSceneProbePromise,
    twinStateProbePromise,
    websiteProbePromise,
  ]);
  const facilityPayload = payloadSupport(facilityProbe.payload, facilityMetrics, "facility");
  const consumerPayload = payloadSupport(consumerProbe.payload, consumerMetrics, "consumer");
  const webhookHistoryAvailable = Boolean(
    facilityProbe.payload?.completeness?.webhooks?.delivery_history ||
      consumerProbe.payload?.completeness?.webhooks?.delivery_history ||
      facilityProbe.payload?.meta?.webhook_delivery?.available ||
      consumerProbe.payload?.meta?.webhook_delivery?.available
  );
  const twinControlPermissionReady = PERMISSION_KEYS.includes("twin.control");
  const statuses = {
    facility: {
      key: "facility",
      name: "Oyi Facility API",
      configured: Boolean(config.officeFacilityBaseUrl),
      production_ready: Boolean(config.officeFacilityBaseUrl && hasFacilityAuth && facilityProbe.ok && facilityPayload.complete),
      status: statusLabel(
        Boolean(config.officeFacilityBaseUrl && hasFacilityAuth),
        Boolean(config.officeFacilityBaseUrl && hasFacilityAuth && facilityProbe.ok && facilityPayload.complete),
        facilityProbe.checked && !facilityProbe.ok,
        facilityProbe.ok && !facilityPayload.complete
      ),
      base_url: config.officeFacilityBaseUrl || "",
      export_path: config.officeFacilityExportPath || "/office/export",
      auth: config.officeFacilityBearerToken ? "bearer" : config.officeFacilityApiKey ? "api_key" : "none",
      sync_target: "facility",
      required_metrics: facilityMetrics,
      endpoint_health: { checked: facilityProbe.checked, ok: facilityProbe.ok, status: facilityProbe.status, http_status: facilityProbe.http_status || null },
      payload: facilityPayload,
      missing: missingKeys([
        ["OFFICE_FACILITY_BASE_URL", config.officeFacilityBaseUrl],
        ["OFFICE_FACILITY_API_KEY or OFFICE_FACILITY_BEARER_TOKEN", hasFacilityAuth],
      ]),
    },
    consumer: {
      key: "consumer",
      name: "Consumer Smart Building API",
      configured: Boolean(config.officeConsumerBaseUrl),
      production_ready: Boolean(config.officeConsumerBaseUrl && hasConsumerAuth && consumerProbe.ok && consumerPayload.complete),
      status: statusLabel(
        Boolean(config.officeConsumerBaseUrl && hasConsumerAuth),
        Boolean(config.officeConsumerBaseUrl && hasConsumerAuth && consumerProbe.ok && consumerPayload.complete),
        consumerProbe.checked && !consumerProbe.ok,
        consumerProbe.ok && !consumerPayload.complete
      ),
      base_url: config.officeConsumerBaseUrl || "",
      export_path: config.officeConsumerExportPath || "/office/export",
      auth: config.officeConsumerBearerToken ? "bearer" : config.officeConsumerApiKey ? "api_key" : "none",
      sync_target: "consumer",
      required_metrics: consumerMetrics,
      endpoint_health: { checked: consumerProbe.checked, ok: consumerProbe.ok, status: consumerProbe.status, http_status: consumerProbe.http_status || null },
      payload: consumerPayload,
      missing: missingKeys([
        ["OFFICE_CONSUMER_BASE_URL", config.officeConsumerBaseUrl],
        ["OFFICE_CONSUMER_API_KEY or OFFICE_CONSUMER_BEARER_TOKEN", hasConsumerAuth],
      ]),
    },
    // Oyi Cross-Surface Observability Closure — real probe, no auth
    // required (a public liveness endpoint). "Not Reporting" now means
    // exactly that: the probe itself couldn't get a signal, never
    // "no recent traffic."
    website: {
      key: "website",
      name: "Ochiga Website",
      configured: true,
      production_ready: Boolean(websiteProbe.ok),
      status: statusLabel(true, Boolean(websiteProbe.ok), websiteProbe.checked && !websiteProbe.ok),
      base_url: config.officeWebsiteBaseUrl || "",
      health_path: config.officeWebsiteHealthPath || "/api/health",
      endpoint_health: { checked: websiteProbe.checked, ok: websiteProbe.ok, status: websiteProbe.status, http_status: websiteProbe.http_status || null },
      missing: [],
    },
    email: {
      key: "email",
      name: "Office Email",
      configured: Boolean(config.officeEmailProvider && config.resendApiKey),
      production_ready: Boolean(config.officeEmailProvider && config.resendApiKey && config.officeEmailFrom),
      status: config.officeEmailProvider && config.resendApiKey ? "connected" : "pending_integration",
      provider: config.officeEmailProvider || "none",
      from: config.officeEmailFrom,
      missing: missingKeys([
        ["OFFICE_EMAIL_PROVIDER", config.officeEmailProvider],
        ["RESEND_API_KEY", config.resendApiKey],
        ["OFFICE_EMAIL_FROM", config.officeEmailFrom],
      ]),
    },
    storage: {
      key: "storage",
      name: "Office Storage",
      configured: Boolean(config.officeStorageDir),
      production_ready: Boolean(config.officeStorageDriver && config.officeStorageDir),
      status: config.officeStorageDriver && config.officeStorageDir ? "connected" : "pending_integration",
      driver: config.officeStorageDriver || "local",
      path: config.officeStorageDir,
      missing: missingKeys([
        ["OFFICE_STORAGE_DRIVER", config.officeStorageDriver],
        ["OFFICE_STORAGE_DIR", config.officeStorageDir],
      ]),
    },
    events: {
      key: "events",
      name: "Live Office Events",
      configured: true,
      production_ready: true,
      status: "connected",
      driver: "server_sent_events",
      endpoint: "/api/lead-agents/admin/events",
      events: [
        "device.status.updated",
        "visitor.created",
        "wallet.funded",
        "support.ticket.created",
        "support.ticket.assigned",
        "estate.updated",
        "home.updated",
        "edge.heartbeat",
        "office.notification",
        "audit.recorded",
        "twin.state.updated",
      ],
      missing: [],
    },
    maps: {
      key: "maps",
      name: "Estate Map Provider",
      configured: Boolean(config.mapboxPublicToken || config.googleMapsApiKey),
      production_ready: Boolean(config.googleMapsApiKey || config.mapboxPublicToken),
      status: config.googleMapsApiKey || config.mapboxPublicToken ? "connected" : "pending_integration",
      provider: config.mapProvider || "static",
      mapbox_ready: Boolean(config.mapboxPublicToken),
      google_ready: Boolean(config.googleMapsApiKey),
      missing: missingKeys([
        ["GOOGLE_MAPS_API_KEY or MAPBOX_PUBLIC_TOKEN", config.googleMapsApiKey || config.mapboxPublicToken],
      ]),
    },
    whatsapp: {
      key: "whatsapp",
      name: "WhatsApp Cloud",
      configured: Boolean(
        config.whatsappVerifyToken &&
          config.whatsappAccessToken &&
          config.whatsappPhoneNumberId &&
          config.whatsappBusinessAccountId
      ),
      production_ready: Boolean(
        config.whatsappVerifyToken &&
          config.whatsappAccessToken &&
          config.whatsappPhoneNumberId &&
          config.whatsappBusinessAccountId
      ),
      status:
        config.whatsappVerifyToken &&
        config.whatsappAccessToken &&
        config.whatsappPhoneNumberId &&
        config.whatsappBusinessAccountId
          ? "connected"
          : "pending_integration",
      provider: "meta",
      webhook: "/webhooks/whatsapp",
      api_version: config.whatsappApiVersion,
      missing: missingKeys([
        ["WHATSAPP_VERIFY_TOKEN", config.whatsappVerifyToken],
        ["WHATSAPP_ACCESS_TOKEN", config.whatsappAccessToken],
        ["WHATSAPP_PHONE_NUMBER_ID", config.whatsappPhoneNumberId],
        ["WHATSAPP_BUSINESS_ACCOUNT_ID", config.whatsappBusinessAccountId],
      ]),
    },
    meta: {
      key: "meta",
      name: "Meta App",
      configured: Boolean(config.metaAppId && config.metaAppSecret),
      production_ready: Boolean(config.metaAppId && config.metaAppSecret && config.metaAccessToken),
      status:
        config.metaAppId && config.metaAppSecret && config.metaAccessToken
          ? "connected"
          : "pending_integration",
      provider: "meta",
      app_ready: Boolean(config.metaAppId && config.metaAppSecret),
      api_token_ready: Boolean(config.metaAccessToken),
      instagram_ready: Boolean(
        config.instagramBusinessAccountId &&
          (config.instagramAccessToken || config.facebookPageAccessToken || config.metaAccessToken)
      ),
      facebook_page_ready: Boolean(config.facebookPageId && config.facebookPageAccessToken),
      missing: missingKeys([
        ["META_APP_ID", config.metaAppId],
        ["META_APP_SECRET", config.metaAppSecret],
        ["META_ACCESS_TOKEN", config.metaAccessToken],
        ["INSTAGRAM_BUSINESS_ACCOUNT_ID", config.instagramBusinessAccountId],
        ["INSTAGRAM_ACCESS_TOKEN or FACEBOOK_PAGE_ACCESS_TOKEN", config.instagramAccessToken || config.facebookPageAccessToken],
        ["FACEBOOK_PAGE_ID", config.facebookPageId],
        ["FACEBOOK_PAGE_ACCESS_TOKEN", config.facebookPageAccessToken],
      ]),
    },
    linkedin: {
      key: "linkedin",
      name: "LinkedIn Marketing / Analytics",
      configured: Boolean(config.linkedinClientId && config.linkedinClientSecret),
      production_ready: Boolean(
        config.linkedinClientId &&
          config.linkedinClientSecret &&
          config.linkedinOrganizationId &&
          config.linkedinAccessToken
      ),
      status:
        config.linkedinClientId &&
        config.linkedinClientSecret &&
        config.linkedinOrganizationId &&
        config.linkedinAccessToken
          ? "connected"
          : "pending_integration",
      provider: "linkedin",
      app_ready: Boolean(config.linkedinClientId && config.linkedinClientSecret),
      organization_ready: Boolean(config.linkedinOrganizationId),
      api_token_ready: Boolean(config.linkedinAccessToken),
      redirect_uri: config.linkedinRedirectUri || "",
      missing: missingKeys([
        ["LINKEDIN_CLIENT_ID", config.linkedinClientId],
        ["LINKEDIN_CLIENT_SECRET", config.linkedinClientSecret],
        ["LINKEDIN_ORGANIZATION_ID", config.linkedinOrganizationId],
        ["LINKEDIN_ACCESS_TOKEN", config.linkedinAccessToken],
      ]),
    },
    google_oauth: {
      key: "google_oauth",
      name: "Google OAuth",
      configured: Boolean(config.googleOAuthClientId && config.googleOAuthClientSecret),
      production_ready: Boolean(config.googleOAuthClientId && config.googleOAuthClientSecret),
      status: config.googleOAuthClientId && config.googleOAuthClientSecret ? "connected" : "pending_integration",
      provider: "google",
      missing: missingKeys([
        ["GOOGLE_OAUTH_CLIENT_ID", config.googleOAuthClientId],
        ["GOOGLE_OAUTH_CLIENT_SECRET", config.googleOAuthClientSecret],
      ]),
    },
    google_marketing: {
      key: "google_marketing",
      name: "Google Analytics / Ads",
      configured: Boolean(
        config.googleAdsDeveloperToken ||
          config.googleAdsCustomerId ||
          config.googleAnalyticsPropertyId ||
          config.googleAnalyticsMeasurementId
      ),
      production_ready: Boolean(
        (config.googleAdsDeveloperToken && config.googleAdsCustomerId) ||
          config.googleAnalyticsPropertyId ||
          config.googleAnalyticsMeasurementId
      ),
      status:
        (config.googleAdsDeveloperToken && config.googleAdsCustomerId) ||
        config.googleAnalyticsPropertyId ||
        config.googleAnalyticsMeasurementId
          ? "connected"
          : "pending_integration",
      provider: "google",
      ads_ready: Boolean(config.googleAdsDeveloperToken && config.googleAdsCustomerId),
      analytics_ready: Boolean(config.googleAnalyticsPropertyId || config.googleAnalyticsMeasurementId),
      missing: missingKeys([
        ["GOOGLE_ADS_DEVELOPER_TOKEN", config.googleAdsDeveloperToken],
        ["GOOGLE_ADS_CUSTOMER_ID", config.googleAdsCustomerId],
        ["GOOGLE_ANALYTICS_PROPERTY_ID", config.googleAnalyticsPropertyId],
      ]),
    },
    edge: {
      key: "edge",
      name: "Oyi Edge / Backend Control Plane",
      configured: Boolean(config.officeBackendBaseUrl || config.edgeAgentTokens.length),
      production_ready: Boolean(config.officeBackendBaseUrl && hasBackendAuth && backendHealth.ok),
      status: statusLabel(
        Boolean(config.officeBackendBaseUrl && hasBackendAuth),
        Boolean(config.officeBackendBaseUrl && hasBackendAuth && backendHealth.ok),
        backendHealth.checked && !backendHealth.ok
      ),
      base_url: config.officeBackendBaseUrl || "",
      health_endpoint: "/health",
      backend_health: { checked: backendHealth.checked, ok: backendHealth.ok, status: backendHealth.status, http_status: backendHealth.http_status || null },
      edge_token_present: Boolean(config.edgeAgentTokens.length),
      missing: missingKeys([
        ["OFFICE_BACKEND_BASE_URL", config.officeBackendBaseUrl],
        ["OFFICE_BACKEND_API_KEY or OYI_EDGE_AGENT_TOKEN(S)", hasBackendAuth],
      ]),
      required_metrics: ["edge.heartbeat", "device.status.updated", "device.command.executed", "camera.snapshot.created"],
    },
    digital_twin: {
      key: "digital_twin",
      name: "Oyi Digital Twin Binding",
      configured: Boolean(config.officeDigitalTwinBaseUrl || options.digitalTwinRuntime),
      production_ready: Boolean(twinSceneProbe.ok && twinControlPermissionReady && (!externalTwin || config.officeDigitalTwinApiKey)),
      status: statusLabel(
        Boolean(config.officeDigitalTwinBaseUrl || options.digitalTwinRuntime),
        Boolean(twinSceneProbe.ok && twinControlPermissionReady && (!externalTwin || config.officeDigitalTwinApiKey)),
        twinSceneProbe.checked && !twinSceneProbe.ok
      ),
      base_url: config.officeDigitalTwinBaseUrl || "same-origin",
      state_path: config.officeDigitalTwinStatePath || "/office/twin/state",
      scene_endpoint: { checked: twinSceneProbe.checked, ok: twinSceneProbe.ok, status: twinSceneProbe.status, same_origin: Boolean(twinSceneProbe.same_origin), http_status: twinSceneProbe.http_status || null },
      twin_state: { checked: twinStateProbe.checked, ok: twinStateProbe.ok, status: twinStateProbe.status, same_origin: Boolean(twinStateProbe.same_origin), http_status: twinStateProbe.http_status || null },
      twin_control_permission: twinControlPermissionReady ? "active" : "missing",
      event_supported: true,
      missing: missingKeys([
        ["OFFICE_DIGITAL_TWIN_API_KEY", externalTwin ? config.officeDigitalTwinApiKey : true],
      ]),
      required_metrics: ["twin.state.updated", "twin.objects", "twin.overlays", "twin.heatmap_events"],
    },
    webhooks: {
      key: "webhooks",
      name: "Provider Webhook Intake",
      configured: Boolean(config.whatsappVerifyToken || config.officeEventWebhookSecret),
      production_ready: Boolean(config.whatsappVerifyToken && config.officeEventWebhookSecret && webhookHistoryAvailable),
      status:
        config.whatsappVerifyToken && config.officeEventWebhookSecret && webhookHistoryAvailable
          ? "connected"
          : config.officeEventWebhookSecret
            ? "configured_needs_validation"
            : "pending_integration",
      delivery_history_available: webhookHistoryAvailable,
      missing: missingKeys([
        ["WHATSAPP_VERIFY_TOKEN", config.whatsappVerifyToken],
        ["OFFICE_EVENT_WEBHOOK_SECRET", config.officeEventWebhookSecret],
        ["provider_webhook_events table/export", webhookHistoryAvailable],
      ]),
      required_events: ["whatsapp.message.received", "linkedin.lead.received", "meta.message.received", "provider.delivery.recorded"],
    },
    app_store: {
      key: "app_store",
      name: "Oyi Home App Store",
      configured: Boolean(config.oyiHomeAppStoreUrl || config.oyiHomeBundleId || appStoreCredentialReady),
      production_ready: Boolean(config.oyiHomeAppStoreUrl && appStoreCredentialReady),
      status: config.oyiHomeAppStoreUrl && appStoreCredentialReady
        ? "production_ready"
        : config.oyiHomeAppStoreUrl
          ? "listed_pending_metrics_credentials"
          : appStoreCredentialReady
            ? "credentials_ready_missing_app_url"
            : "pending_integration",
      app_listed: Boolean(config.oyiHomeAppStoreUrl),
      metrics_adapter: appStoreCredentialReady ? "configured" : "pending_credentials",
      bundle_id_present: Boolean(config.oyiHomeBundleId),
      missing: missingKeys([
        ["OYI_HOME_APP_STORE_URL", config.oyiHomeAppStoreUrl],
        ["OYI_HOME_BUNDLE_ID", config.oyiHomeBundleId],
        ["APP_STORE_CONNECT_ISSUER_ID", config.appStoreConnectIssuerId],
        ["APP_STORE_CONNECT_KEY_ID", config.appStoreConnectKeyId],
        ["APP_STORE_CONNECT_PRIVATE_KEY", config.appStoreConnectPrivateKey],
        ["APP_STORE_APP_ID", config.appStoreAppId],
      ]),
      supported_future_metrics: ["app_availability", "version", "build_status", "downloads", "ratings_reviews"],
    },
    crm_support: {
      key: "crm_support",
      name: "CRM & Support Integration Visibility",
      configured: true,
      production_ready: Boolean(config.officeEventWebhookSecret && (config.whatsappVerifyToken || config.linkedinAccessToken || config.metaAccessToken)),
      status: config.officeEventWebhookSecret
        ? "configured_needs_validation"
        : "missing_credentials",
      website_lead_intake: "active",
      app_onboarding_leads: config.officeConsumerBaseUrl ? "configured" : "pending_consumer_sync",
      support_tickets: config.officeFacilityBaseUrl || config.officeConsumerBaseUrl ? "configured" : "pending_sync",
      deployment_inquiries: "active",
      provider_callbacks: config.officeEventWebhookSecret ? "secured" : "missing_secret",
      webhook_events: config.officeEventWebhookSecret ? "ready" : "pending",
      missing: missingKeys([["OFFICE_EVENT_WEBHOOK_SECRET", config.officeEventWebhookSecret]]),
    },
  };
  statuses.whatsapp.webhook_configured = Boolean(config.whatsappVerifyToken);
  statuses.webhooks.whatsapp_webhook = config.whatsappVerifyToken ? "configured" : "missing_verify_token";
  statuses.webhooks.event_intake = config.officeEventWebhookSecret ? "ready" : "pending";
  const productionChecks = Object.values(statuses).filter((item) => item && item.key !== "google_marketing" && !String(item.key).startsWith("__"));
  const readyChecks = productionChecks.filter((item) => item.production_ready).length;
  statuses.__readiness = {
    key: "__readiness",
    name: "Office Production Readiness",
    total_checks: productionChecks.length,
    ready_checks: readyChecks,
    readiness_pct: productionChecks.length ? Math.round((readyChecks / productionChecks.length) * 100) : 0,
    blockers: productionChecks
      .filter((item) => !item.production_ready)
      .map((item) => ({
        key: item.key,
        name: item.name,
        missing: item.missing || [],
        required_metrics: item.required_metrics || item.required_events || [],
      })),
  };
  return statuses;
}

function publicMapConfig(config) {
  return {
    provider: config.mapProvider || "static",
    mapbox: {
      configured: Boolean(config.mapboxPublicToken),
      public_token: config.mapboxPublicToken || "",
    },
    google_maps: {
      configured: Boolean(config.googleMapsApiKey),
      api_key: config.googleMapsApiKey || "",
    },
  };
}

function escapeHtmlText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function documentHtml(config, input) {
  const type = String(input.document_type || input.type || "document").toUpperCase();
  const title = String(input.title || `${type} Document`);
  const amount = Number(input.amount || input.value || 0);
  const currency = String(input.currency || "NGN");
  const recipient = String(input.recipient || input.email_to || "Client");
  const body = String(input.body || input.description || "Generated from Ochiga Office document studio.");
  const safeTitle = escapeHtmlText(title);
  const safeRecipient = escapeHtmlText(recipient);
  const safeStatus = escapeHtmlText(input.status || "draft");
  const safeRelated = escapeHtmlText(`${input.related_type || "office"} ${input.related_id || ""}`.trim());
  const safeBody = escapeHtmlText(body).replace(/\n/g, "<br />");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <style>
    body{font-family:Arial,sans-serif;margin:0;background:#f4f7fb;color:#101828}
    .page{max-width:860px;margin:32px auto;background:white;border:1px solid #d8e0ea;border-radius:18px;overflow:hidden}
    .head{background:#06111f;color:white;padding:34px}
    .brand{font-size:13px;letter-spacing:.16em;color:#60a5fa;text-transform:uppercase}
    h1{margin:10px 0 4px;font-size:34px}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:28px 34px;border-bottom:1px solid #e5edf6}
    .section{padding:28px 34px}
    .amount{font-size:30px;font-weight:700}
    table{width:100%;border-collapse:collapse;margin-top:18px}
    th,td{padding:12px;border-bottom:1px solid #eef2f7;text-align:left}
    .foot{padding:24px 34px;background:#f8fafc;color:#667085;font-size:13px}
  </style>
</head>
<body>
  <main class="page">
    <section class="head">
      <div class="brand">${config.officeDocumentBrandName}</div>
      <h1>${safeTitle}</h1>
      <div>${type} · ${new Date().toLocaleDateString("en-NG")}</div>
    </section>
    <section class="meta">
      <div><strong>Recipient</strong><br />${safeRecipient}</div>
      <div><strong>Status</strong><br />${safeStatus}</div>
      <div><strong>Related Record</strong><br />${safeRelated}</div>
      <div><strong>Amount</strong><br /><span class="amount">${currency} ${amount.toLocaleString("en-NG")}</span></div>
    </section>
    <section class="section">
      <h2>Summary</h2>
      <p>${safeBody}</p>
      <table>
        <thead><tr><th>Description</th><th>Amount</th></tr></thead>
        <tbody><tr><td>${safeTitle}</td><td>${currency} ${amount.toLocaleString("en-NG")}</td></tr></tbody>
      </table>
    </section>
    <section class="foot">Generated by Ochiga Office. Print this page to PDF or attach it through the configured email provider.</section>
  </main>
</body>
</html>`;
}

function assetPatchForAction(kind, action, body) {
  const now = new Date().toISOString();
  const normalized = String(action || "").toLowerCase();
  const patch = { updated_at: now };
  if (["pause", "paused"].includes(normalized)) patch.status = "paused";
  if (["suspend", "suspended"].includes(normalized)) patch.status = "suspended";
  if (["disable", "disabled"].includes(normalized)) patch.status = "disabled";
  if (["enable", "active", "resume"].includes(normalized)) patch.status = "active";
  if (normalized === "reset") {
    patch.status = kind === "device" ? "online" : "active";
    patch.last_seen_at = kind === "device" ? now : undefined;
  }
  if (normalized === "assign") {
    patch.building_id = body.building_id;
    patch.home_id = body.home_id;
    patch.metadata = { assigned_to: body.assigned_to || body.owner || "" };
  }
  patch.metadata = {
    ...(patch.metadata || {}),
    last_office_action: normalized,
    action_reason: body.reason || "",
    action_actor: body.actor || "",
    action_at: now,
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

async function geocodeAddress(config, address) {
  if (!config.googleMapsApiKey) {
    const error = new Error("GOOGLE_MAPS_API_KEY is not configured");
    error.statusCode = 400;
    throw error;
  }
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", config.googleMapsApiKey);
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== "OK") {
    return {
      ok: false,
      status: payload.status || response.status,
      error_message: payload.error_message || "",
    };
  }
  const result = payload.results?.[0];
  const location = result?.geometry?.location;
  if (!location || !Number.isFinite(Number(location.lat)) || !Number.isFinite(Number(location.lng))) {
    return { ok: false, status: "NO_LOCATION" };
  }
  return {
    ok: true,
    latitude: Number(location.lat),
    longitude: Number(location.lng),
    formatted_address: result.formatted_address || address,
    place_id: result.place_id || "",
  };
}

async function geocodeOfficeEstates({ config, store, limit = 50, force = false, country = "Nigeria" }) {
  const estates = typeof store.listOfficeEstates === "function" ? await store.listOfficeEstates() : [];
  const safeCountry = String(country || "Nigeria").trim();
  const candidates = estates
    .filter((estate) => {
      if (
        !force &&
        estate.latitude !== null &&
        estate.latitude !== undefined &&
        estate.longitude !== null &&
        estate.longitude !== undefined
      ) {
        return false;
      }
      return Boolean(String(estate.location || estate.name || "").trim());
    })
    .slice(0, Math.max(1, Math.min(Number(limit || 50), 100)));
  const results = [];
  for (const estate of candidates) {
    const address = [estate.name, estate.location, safeCountry].filter(Boolean).join(", ");
    const geocode = await geocodeAddress(config, address);
    if (geocode.ok) {
      const updated = await store.updateOfficeAsset("estate", estate.id, {
        latitude: geocode.latitude,
        longitude: geocode.longitude,
        metadata: {
          ...(estate.metadata || {}),
          geocoded_address: geocode.formatted_address,
          google_place_id: geocode.place_id,
          geocoded_at: new Date().toISOString(),
        },
      });
      results.push({
        id: estate.id,
        name: estate.name,
        ok: true,
        latitude: geocode.latitude,
        longitude: geocode.longitude,
        updated: Boolean(updated),
      });
    } else {
      results.push({ id: estate.id, name: estate.name, ok: false, status: geocode.status, error_message: geocode.error_message });
    }
  }
  return {
    total_estates: estates.length,
    total_candidates: candidates.length,
    skipped: Math.max(0, estates.length - candidates.length),
    updated: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  };
}

function absoluteUrl(req, pathname, token, config = {}) {
  const requestProto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const requestHost = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  const configuredOrigin = String(config.officeAppUrl || "").trim();
  if (config.environment === "production" && !configuredOrigin) {
    const error = new Error("OFFICE_APP_URL is required for production identity links");
    error.statusCode = 503;
    throw error;
  }
  let origin;
  try {
    origin = new URL(configuredOrigin || `${requestProto}://${requestHost}`);
  } catch {
    const error = new Error("OFFICE_APP_URL must be an absolute http(s) URL");
    error.statusCode = 503;
    throw error;
  }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/") {
    const error = new Error("OFFICE_APP_URL must be an origin without credentials or a path");
    error.statusCode = 503;
    throw error;
  }
  const url = new URL(pathname, origin.origin);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

function extractTextFromResponse(response) {
  if (response && typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const messages = Array.isArray(response?.output)
    ? response.output.filter((item) => item.type === "message")
    : [];
  const chunks = [];
  for (const message of messages) {
    for (const content of message.content || []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        chunks.push(content.text.trim());
      }
    }
  }
  return chunks.join("\n").trim();
}

function extractJsonObject(text) {
  const source = String(text || "").trim();
  if (!source) return null;
  const fenced = source.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : source;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    return null;
  }
}

async function enhancePlanStudioGeometry({ openaiClient, config, imageDataUrl, heuristicGeometry }) {
  const response = await openaiClient.createResponse({
    model: config.openaiModel,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You analyze architectural floor plan images. Return JSON only. Refine room segmentation, room names, openings, and circulation. Preserve normalized coordinates between 0 and 1. Prefer conservative corrections over invented detail.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "Given this floor plan image and the initial heuristic geometry, return a JSON object with keys:",
              "confidence, content_bounds, zones, pathways, openings.",
              "zones: array of {id,label,kind,x,y,width,height}",
              "pathways: array of {id,label,kind,x1,y1,x2,y2}",
              "openings: array of {id,label,kind,x,y,orientation}",
              "Use OCR to read room names where possible.",
              "Identify door openings explicitly when visible.",
              "Split internal rooms such as baths, kitchens, stores, utility, corridor, core, bedrooms, living, dining where image evidence supports it.",
              `Initial heuristic geometry: ${JSON.stringify(heuristicGeometry)}`,
            ].join("\n"),
          },
          {
            type: "input_image",
            image_url: imageDataUrl,
            detail: "high",
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "plan_studio_geometry",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            confidence: { type: "number" },
            content_bounds: {
              type: "object",
              additionalProperties: false,
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
              },
              required: ["x", "y", "width", "height"],
            },
            zones: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  kind: { type: "string" },
                  x: { type: "number" },
                  y: { type: "number" },
                  width: { type: "number" },
                  height: { type: "number" },
                },
                required: ["id", "label", "kind", "x", "y", "width", "height"],
              },
            },
            pathways: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  kind: { type: "string" },
                  x1: { type: "number" },
                  y1: { type: "number" },
                  x2: { type: "number" },
                  y2: { type: "number" },
                },
                required: ["id", "label", "kind", "x1", "y1", "x2", "y2"],
              },
            },
            openings: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  kind: { type: "string" },
                  x: { type: "number" },
                  y: { type: "number" },
                  orientation: { type: "string" },
                },
                required: ["id", "label", "kind", "x", "y", "orientation"],
              },
            },
          },
          required: ["confidence", "content_bounds", "zones", "pathways", "openings"],
        },
      },
    },
  });

  const structured =
    response?.output?.[0]?.content?.[0]?.json ||
    extractJsonObject(extractTextFromResponse(response));
  if (!structured || typeof structured !== "object") {
    const error = new Error("Plan parsing did not return valid JSON");
    error.statusCode = 502;
    throw error;
  }
  structured.source = "openai-vision";
  return structured;
}

function fallbackPlanStudioReply(project, question) {
  const geometry = project.analysis?.geometry || {};
  const summary = project.analysis?.summary || {};
  const zones = Array.isArray(geometry.zones) ? geometry.zones : [];
  const openings = Array.isArray(geometry.openings) ? geometry.openings : [];
  const pathways = Array.isArray(geometry.pathways) ? geometry.pathways : [];
  const importantZones = zones
    .slice(0, 6)
    .map((zone) => `${zone.label} (${zone.kind})`)
    .join(", ");
  const prompt = String(question || "").toLowerCase();

  if (prompt.includes("opportunit") || prompt.includes("smart")) {
    return [
      `This plan currently exposes ${summary.cctv || 0} CCTV points, ${summary.access_points || 0} access points, ${summary.sensors || 0} sensors, and ${summary.power_outlets || 0} power outlets in the draft smart layer.`,
      `The strongest smart-building opportunities are access control around the detected entry/core zones, CCTV on circulation junctions, occupancy-driven lighting, and structured network/PoE along the ${pathways.length} detected path${pathways.length === 1 ? "" : "s"}.`,
      importantZones ? `The main parsed spaces are ${importantZones}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (prompt.includes("decision")) {
    return [
      `The next design decisions are to validate room names, confirm the ${openings.length} detected opening${openings.length === 1 ? "" : "s"}, approve corridor/core geometry, and decide which smart layers should be prioritized first for the project.`,
      `After that, the team should lock device density for security, electrical, fire safety, HVAC, and network disciplines.`,
    ].join(" ");
  }

  return [
    `This uploaded plan has been parsed into ${zones.length} space zone${zones.length === 1 ? "" : "s"}, ${pathways.length} circulation path${pathways.length === 1 ? "" : "s"}, and ${openings.length} opening${openings.length === 1 ? "" : "s"}.`,
    importantZones ? `The main detected spaces are ${importantZones}.` : "",
    `The current smart-infrastructure draft suggests ${summary.cctv || 0} CCTV points, ${summary.access_points || 0} access points, ${summary.sensors || 0} sensors, and ${summary.power_outlets || 0} power outlets.`,
  ]
    .filter(Boolean)
    .join(" ");
}

async function answerPlanStudioQuestion({ openaiClient, config, project, question }) {
  const fallback = fallbackPlanStudioReply(project, question);
  try {
    const response = await openaiClient.createResponse({
      model: config.openaiModel,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You are an expert smart-building planning agent. Explain plans in plain English, identify spaces, call out geometry uncertainty, and recommend realistic smart infrastructure layers. Keep answers concise but concrete.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Project: ${project.name}`,
                `Question: ${question}`,
                `Geometry: ${JSON.stringify(project.analysis?.geometry || {})}`,
                `Summary: ${JSON.stringify(project.analysis?.summary || {})}`,
                `Recommendations: ${JSON.stringify(project.analysis?.recommendations || [])}`,
                `Discipline reviews: ${JSON.stringify(project.discipline_reviews || {})}`,
              ].join("\n"),
            },
            project.image_data_url
              ? {
                  type: "input_image",
                  image_url: project.image_data_url,
                  detail: "high",
                }
              : null,
          ].filter(Boolean),
        },
      ],
    });
    return extractTextFromResponse(response) || fallback;
  } catch (error) {
    return fallback;
  }
}

async function buildChannelOverview(store, config) {
  const [leads, notifications] = await Promise.all([
    store.listLeads ? store.listLeads() : [],
    store.listNotifications ? store.listNotifications(500) : [],
  ]);

  function leadCount(match) {
    return leads.filter(match).length;
  }

  function notificationCount(channel) {
    return notifications.filter((notification) => {
      return (
        notification.type === "inbound_message" &&
        (notification.status || "open") === "open" &&
        String(notification.channel || notification.metadata?.source || "")
          .toLowerCase()
          .includes(channel)
      );
    }).length;
  }

  const whatsappReady = Boolean(
    config.whatsappVerifyToken &&
      config.whatsappAccessToken &&
      config.whatsappPhoneNumberId &&
      config.whatsappBusinessAccountId
  );

  return {
    channels: [
      {
        key: "website",
        name: "Website Widget",
        status: "active",
        lead_count: leadCount((lead) =>
          ["website", "website_chat", "website_widget"].includes(
            String(lead.primary_channel || lead.source || "").toLowerCase()
          )
        ),
        open_notifications: notificationCount("website"),
        description: "Live widget intake on Ochiga and Oyi websites.",
        note: "Inbound widget chats create lead records, notifications, and live conversation threads.",
      },
      {
        key: "whatsapp",
        name: "WhatsApp Business",
        status: whatsappReady ? "active" : "needs_config",
        lead_count: leadCount(
          (lead) =>
            String(lead.primary_channel || "").toLowerCase() === "whatsapp" ||
            Boolean(lead.whatsapp_phone)
        ),
        open_notifications: notificationCount("whatsapp"),
        description: "Meta webhook intake, reply orchestration, and human takeover controls.",
        note: whatsappReady
          ? "Webhook and outbound credentials are configured. New inbound messages should notify and open the thread directly."
          : "Webhook or outbound credentials are incomplete. Finish Meta configuration before go-live.",
      },
      {
        key: "facebook",
        name: "Facebook Messenger",
        status: "staged",
        lead_count: leadCount(
          (lead) =>
            String(lead.primary_channel || lead.source || "").toLowerCase() === "facebook"
        ),
        open_notifications: notificationCount("facebook"),
        description: "Reserved pipeline area for Messenger direct message intake.",
        note: "UI and CRM staging are ready. Adapter and webhook activation are still pending.",
      },
      {
        key: "instagram",
        name: "Instagram DM",
        status: "staged",
        lead_count: leadCount(
          (lead) =>
            String(lead.primary_channel || lead.source || "").toLowerCase() === "instagram"
        ),
        open_notifications: notificationCount("instagram"),
        description: "Reserved pipeline area for Instagram DM intake.",
        note: "UI and CRM staging are ready. Adapter and webhook activation are still pending.",
      },
    ],
  };
}

async function appendAudit(store, authContext, action, targetType, targetId, metadata, req, status) {
  return appendAuditRecord({
    store,
    authContext,
    action,
    resourceType: targetType,
    resourceId: targetId || "",
    metadata: metadata || {},
    req,
    status,
  });
}

function backendAiHeaders(config) {
  const headers = { accept: "application/json" };
  if (config.officeBackendBearerToken) {
    headers.authorization = `Bearer ${config.officeBackendBearerToken}`;
  }
  if (config.officeBackendApiKey) {
    headers["x-api-key"] = config.officeBackendApiKey;
  }
  return headers;
}

async function fetchBackendAiOperations(config) {
  const baseUrl = String(config.officeBackendBaseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) {
    return {
      available: false,
      status: "pending_integration",
      reason: "OFFICE_BACKEND_BASE_URL is missing",
      tools: [],
      executions: [],
      confirmations: [],
    };
  }
  if (!config.officeBackendBearerToken && !config.officeBackendApiKey) {
    return {
      available: false,
      status: "missing_credentials",
      reason: "OFFICE_BACKEND_BEARER_TOKEN or OFFICE_BACKEND_API_KEY is required for server-side AI Operations sync",
      tools: [],
      executions: [],
      confirmations: [],
    };
  }
  const headers = backendAiHeaders(config);
  const get = async (path) => {
    const response = await axios.get(`${baseUrl}${path}`, { headers, timeout: 8000 });
    return response.data || {};
  };
  try {
    const [toolsData, executionsData, confirmationsData] = await Promise.all([
      get("/ai/tools"),
      get("/ai/executions?limit=100"),
      get("/ai/confirmations?limit=50"),
    ]);
    return {
      available: true,
      status: "active",
      tools: toolsData.tools || [],
      executions: executionsData.executions || [],
      confirmations: confirmationsData.confirmations || [],
    };
  } catch (error) {
    return {
      available: false,
      status: "error",
      reason: error?.response?.data?.error || error?.message || "backend_ai_sync_failed",
      tools: [],
      executions: [],
      confirmations: [],
    };
  }
}

function extractPublicLeadPatch(message) {
  const text = String(message || "").trim();
  const lower = text.toLowerCase();
  const patch = {};
  const inferred = inferCommercialFacts(text);

  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (emailMatch) {
    patch.email = emailMatch[0];
  }

  const phoneMatch = text.match(/(?:\+?\d[\d\s().-]{7,}\d)/);
  if (phoneMatch) {
    patch.phone = phoneMatch[0];
  }

  const locationPatterns = [
    /location\s+(?:is\s+)?(?:at|in)\s+([a-z0-9&,\- ]{4,})/i,
    /project\s+(?:is\s+)?(?:at|in)\s+([a-z0-9&,\- ]{4,})/i,
    /(?:at|in)\s+([a-z0-9&,\- ]{4,})/i,
  ];
  for (const pattern of locationPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      patch.location = match[1].trim().replace(/\s+/g, " ");
      break;
    }
  }

  const unitMatch = lower.match(/(\d{1,5})\s+units?/);
  const bedroomMatch = lower.match(/(\d(?:\s*&\s*\d)?)\s*bed/);
  const fragments = [];
  if (unitMatch) {
    fragments.push(`${unitMatch[1]} units`);
  }
  if (bedroomMatch) {
    fragments.push(`${bedroomMatch[1]} bedroom mix`);
  }
  if (patch.location) {
    fragments.push(`location ${patch.location}`);
  }

  if (fragments.length) {
    patch.summary = `Fallback project signals: ${fragments.join(", ")}.`;
  }
  if (inferred.unit_count) patch.unit_count = inferred.unit_count;
  if (inferred.project_type) patch.project_type = inferred.project_type;

  return patch;
}

async function ensurePublicFallbackLead(store, body) {
  const existing =
    body.lead_id && typeof body.lead_id === "string"
      ? await store.getLead(body.lead_id)
      : null;
  const patch = extractPublicLeadPatch(body.message);

  const existingByEmail =
    !existing && body.profile?.email && store.findLeadByEmail
      ? await store.findLeadByEmail(body.profile.email)
      : null;
  const existingByPhone =
    !existing && !existingByEmail && body.profile?.phone && store.findLeadByPhone
      ? await store.findLeadByPhone(body.profile.phone)
      : null;
  const matchedLead = existing || existingByEmail || existingByPhone;

  if (matchedLead) {
    return store.updateLead(matchedLead.id, {
      ...body.profile,
      ...patch,
      source: body.source || matchedLead.source || "website_chat",
    });
  }

  return store.createLead(
    normalizeLeadInput(
      {
        ...body.profile,
        ...patch,
        source: body.source || "website_chat",
        owner: "marketing_agent",
        status: "new",
        primary_channel: "website",
        summary:
          patch.summary || "Lead captured through public fallback response path.",
      },
      body.source || "website_chat"
    )
  );
}

async function resolveLeadForChannel(store, phone, source) {
  const existing = await store.findLeadByPhone(phone);
  if (existing) {
    return existing;
  }
  return store.createLead({
    phone,
    whatsapp_phone: phone,
    primary_channel: "whatsapp",
    channel_last_seen_at: new Date().toISOString(),
    source,
    owner: "marketing_agent",
    status: "new",
    summary: "Lead created from WhatsApp inbound message.",
  });
}

// Best-effort forward to Backend's Communication Runtime canonical event
// log (/office/communications/webhook-event) -- same Office->Backend
// direction/credential every other officeExport.ts call already uses.
// Returns a coarse outcome for logging; NEVER throws (a forward failure
// must not break WhatsApp webhook processing itself).
async function forwardCommunicationWebhookEvent(config, payload, requestId) {
  if (!config.officeBackendBaseUrl || !config.officeBackendApiKey) {
    return { forwarded: false, reason: "backend_bridge_not_configured" };
  }
  try {
    const response = await axios.post(
      `${config.officeBackendBaseUrl.replace(/\/$/, "")}/office/communications/webhook-event`,
      payload,
      { headers: { "x-api-key": config.officeBackendApiKey }, timeout: 8000 }
    );
    log("info", "whatsapp_webhook.backend_forward_result", {
      request_id: requestId,
      provider_event_type: payload.provider_event_type,
      status_code: response.status,
      // "status" events return matched (an existing row was found to
      // update); "message" events return matched_outbound (correlated
      // to a prior send on the same thread) -- distinct response shapes.
      matched: Boolean(response.data?.matched),
      matched_outbound: Boolean(response.data?.matched_outbound),
      thread_reference: response.data?.thread_reference || null,
      ok: Boolean(response.data?.ok),
    });
    return { forwarded: true, ok: Boolean(response.data?.ok) };
  } catch (error) {
    log("error", "whatsapp_webhook.backend_forward_failed", {
      request_id: requestId,
      provider_event_type: payload.provider_event_type,
      error: error?.message || String(error),
    });
    return { forwarded: false, reason: "request_failed" };
  }
}

async function processWhatsAppEvent({ event, store, adapter, config, requestId }) {
  if (event.kind === "status") {
    await store.appendInboundEvent({
      channel: "whatsapp",
      provider: "meta",
      event_type: `status:${event.status}`,
      external_event_id: event.message_id,
      payload: event.raw,
    });
    if (event.message_id) {
      // Meta attaches a real error code/title on a "failed" status
      // (e.g. 131047 = outside the 24h customer-service window, a
      // template is required) -- forwarded so the canonical record
      // reports the ACTUAL provider reason, not a generic "failed".
      const providerError = Array.isArray(event.raw?.errors) ? event.raw.errors[0] : null;
      await forwardCommunicationWebhookEvent(
        config,
        {
          channel: "whatsapp",
          provider_event_type: "status",
          provider_message_id: event.message_id,
          status: event.status,
          error_code: providerError?.code ?? null,
          error_title: providerError?.title || providerError?.message || null,
          occurred_at: new Date(Number(event.timestamp || 0) * 1000 || Date.now()).toISOString(),
        },
        requestId
      );
    }
    return {
      kind: "status",
      message_id: event.message_id,
      status: event.status,
    };
  }

  const lead = await resolveLeadForChannel(store, event.from, "whatsapp");
  log("info", "whatsapp_webhook.thread_resolved", { request_id: requestId, lead_id: lead.id });
  await store.updateLead(lead.id, {
    whatsapp_phone: event.from,
    primary_channel: "whatsapp",
    channel_last_seen_at: new Date().toISOString(),
  });
  await store.appendInboundEvent({
    channel: "whatsapp",
    provider: "meta",
    event_type: "message",
    lead_id: lead.id,
    external_event_id: event.message_id,
    payload: event.raw,
  });
  // Forward the inbound message itself into the Communication Runtime's
  // canonical thread (Phase 5) -- correlated by phone number so it lands
  // in the SAME thread as any prior outbound send to this person.
  if (event.message_id) {
    await forwardCommunicationWebhookEvent(
      config,
      {
        channel: "whatsapp",
        provider_event_type: "message",
        provider_message_id: event.message_id,
        from: event.from,
        text: event.text || "",
        lead_id: lead.id,
        occurred_at: new Date(Number(event.timestamp || 0) * 1000 || Date.now()).toISOString(),
      },
      requestId
    );
  }

  const channelState = await store.upsertLeadChannelState(lead.id, "whatsapp", {
    customer_service_window_expires_at: customerServiceWindowExpiry(event.timestamp),
    last_external_message_id: event.message_id,
    last_inbound_at: new Date(Number(event.timestamp || 0) * 1000 || Date.now()).toISOString(),
    human_status: "auto",
  });

  if (channelState.ai_paused || ["human_active", "human_review"].includes(channelState.human_status)) {
    return {
      kind: "message",
      lead_id: lead.id,
      paused: true,
    };
  }

  const session = buildPublicIntelligenceSession({
    source_site: "whatsapp",
    source_channel: "whatsapp",
    lead_id: lead.id,
    message: event.text || "",
    lead_stage: lead.status || lead.commercial_stage || "exploring",
  });
  const oyiCoreRequest = buildOyiCoreCorporateConversationRequest({
    session,
    message: event.text || "",
    lead,
    body: {
      source: "whatsapp",
      profile: { phone: event.from },
    },
    requestId,
  });
  const oyiCoreResult = await callOyiCoreCorporateConversation(config, oyiCoreRequest);
  const assistantMessage = oyiCoreResult.ok
    ? oyiCoreResult.response.answer
    : "Ochiga Intelligence is temporarily unavailable. We have your WhatsApp message and the Office team can follow up, but I cannot continue the automated conversation right now.";
  await store.appendTimelineEvent({
    lead_id: lead.id,
    event_type: oyiCoreResult.ok ? "oyi_core_whatsapp_turn" : "oyi_core_whatsapp_unavailable",
    actor: "ochiga_intelligence",
    title: oyiCoreResult.ok ? "WhatsApp intelligence turn" : "WhatsApp intelligence unavailable",
    body: String(assistantMessage || "").slice(0, 500),
    metadata: {
      request_id: requestId,
      public_session_id: session.session_id,
      oyi_thread_id: oyiCoreResult.ok ? oyiCoreResult.response.conversation_thread_id : "",
      reason: oyiCoreResult.ok ? "" : oyiCoreResult.reason,
    },
  });
  // Also log to the canonical polymorphic crm_activities timeline (Phase
  // 6, v2 audit) — timeline_events above stays as the source-specific
  // technical log this webhook path already depended on; this is the
  // one staff actually see in the CRM activity feed alongside notes,
  // status changes, and other channels. createCorporateRecord directly,
  // not the staff-authorization-gated createRelatedActivity wrapper —
  // this webhook has no logged-in staff actor to authorize against.
  await createCorporateRecord(
    store,
    "activities",
    {
      lead_id: lead.id,
      related_type: "lead",
      related_id: lead.id,
      activity_type: "whatsapp_message",
      title: "WhatsApp message",
      body: String(event.text || "").slice(0, 2000),
      source: "whatsapp",
      metadata: { direction: "inbound", ai_replied: oyiCoreResult.ok, request_id: requestId },
    },
    { actorEmail: "whatsapp" }
  ).catch(() => null);

  const sendResult = await adapter.sendTextMessage({
    to: event.from,
    body: assistantMessage,
    contextMessageId: event.message_id,
  });

  await store.upsertLeadChannelState(lead.id, "whatsapp", {
    last_outbound_at: new Date().toISOString(),
    last_external_message_id: sendResult.external_message_id || event.message_id,
  });

  return {
    kind: "message",
    lead_id: lead.id,
    outbound: sendResult,
  };
}

async function bootstrapAdminUser(store, config) {
  if (!config.adminEmail || !config.adminPassword) {
    return null;
  }
  return store.ensureAdminUser({
    email: normalizeEmail(config.adminEmail),
    password_hash: hashPassword(config.adminPassword),
    role: config.adminRole || "admin",
    display_name: config.adminEmail,
    status: "active",
  });
}

async function enrichAuthContext(authContext, store) {
  if (!authContext || authContext.type !== "session") {
    return authContext;
  }
  const user = await store.getAdminUserByEmail(authContext.email);
  if (!user || user.status !== "active") {
    const error = new Error("unauthorized");
    error.statusCode = 401;
    throw error;
  }
  return {
    ...authContext,
    user,
    role: user.role || authContext.role,
    permissionScopes: Array.isArray(user.permission_scopes) ? user.permission_scopes : [],
    permissions: permissionsForRole(
      user.role || authContext.role,
      Array.isArray(user.permission_scopes) ? user.permission_scopes : []
    ),
  };
}

function buildServer({ config, store, rateLimiter, publicRateLimiter, officeRateLimiter, loginRateLimiter, whatsappAdapter, openaiClient, toolExecutor }) {
  const startedAt = Date.now();
  const widgetRateLimiter = publicRateLimiter || rateLimiter;
  const officeInternalRateLimiter = officeRateLimiter || rateLimiter;
  const adminLoginRateLimiter =
    loginRateLimiter ||
    new MemoryRateLimiter({
      windowMs: config.loginRateLimitWindowMs || 15 * 60 * 1000,
      maxRequests: config.loginRateLimitMaxAttempts || 10,
    });
  const eventBus = createRealtimeHub();
  // Scheduled-content publisher (Phase 8) — off by default, same
  // precedent as Ochiga Backend's own proactive scheduler (also
  // env-gated, also off unless explicitly enabled). Only touches
  // content items a publisher already explicitly scheduled; never
  // auto-approves or auto-publishes anything that wasn't already in
  // "scheduled" status via a real content.publish action.
  if (process.env.OFFICE_CONTENT_SCHEDULER_ENABLED === "true") {
    const intervalMs = Number(process.env.OFFICE_CONTENT_SCHEDULER_INTERVAL_MS || 5 * 60 * 1000);
    setInterval(async () => {
      try {
        const due = await store.listScheduledContentDue(new Date());
        for (const item of due) {
          try {
            const docId = item.sanity_document_id || `post-${item.id}`;
            const result = await publishToSanity(docId);
            if (result.ok) {
              const liveUrl = `${process.env.OCHIGA_WEBSITE_URL || "https://ochiga.com.ng"}/insights/${item.slug || slugify(item.title)}`;
              await store.updateContentItem(item.id, { workflow_status: "published", sanity_document_id: docId, sanity_live_url: liveUrl, published_by: "scheduler" });
              await appendAudit(store, { email: "scheduler", role: "system" }, "content_published", "office_content_item", item.id, { title: item.title, via: "scheduler" });
              eventBus.publish("office.notification", { actor: "scheduler", summary: `"${item.title}" published on schedule` });
            }
          } catch (err) {
            log("error", "content_scheduler.publish_failed", { content_id: item.id, error: err.message });
          }
        }
      } catch (err) {
        log("error", "content_scheduler.tick_failed", { error: err.message });
      }
    }, intervalMs);
  }
  const storageService = createStorageService(config);
  const digitalTwinRuntime = createDigitalTwinRuntime();
  const planStudioRuntime = createPlanStudioRuntime({
    storePath: path.join(process.cwd(), "data", "plan-studio-store.json"),
  });
  const officeSync = createOfficeSyncService({ config, store });
  const widgetIndexPath = path.join(process.cwd(), "public", "widget", "index.html");
  const widgetScriptPath = path.join(
    process.cwd(),
    "public",
    "widget",
    "oma-widget.js"
  );
  const dashboardIndexPath = path.join(
    process.cwd(),
    "public",
    "dashboard",
    "index.html"
  );
  const dashboardScriptPath = path.join(
    process.cwd(),
    "public",
    "dashboard",
    "dashboard.js"
  );
  // Ochiga Office corporate shell (Phase 1 rebuild) — same explicit
  // static-route pattern as the legacy dashboard above; the legacy
  // dashboard is left fully intact and reachable at its existing path.
  const officeShellIndexPath = path.join(
    process.cwd(),
    "public",
    "office",
    "index.html"
  );
  const officeShellScriptPath = path.join(
    process.cwd(),
    "public",
    "office",
    "office.js"
  );
  const dashboardLogoPath = path.join(
    process.cwd(),
    "public",
    "assets",
    "ochiga-logo.png"
  );
  const officeLogoDarkPath = path.join(
    process.cwd(),
    "public",
    "office",
    "brand",
    "ochiga-logo-dark.png"
  );
  const officeLogoLightPath = path.join(
    process.cwd(),
    "public",
    "office",
    "brand",
    "ochiga-logo-light.png"
  );
  const officeManifestPath = path.join(process.cwd(), "public", "office", "manifest.json");
  const officeServiceWorkerPath = path.join(process.cwd(), "public", "office", "sw.js");
  const officeIcon192Path = path.join(process.cwd(), "public", "office", "brand", "icon-192.png");
  const officeIcon512Path = path.join(process.cwd(), "public", "office", "brand", "icon-512.png");
  const officeIconMaskable512Path = path.join(process.cwd(), "public", "office", "brand", "icon-maskable-512.png");
  // Oyi Universal Interaction Shell shared core (vendored from
  // Ochiga-website's lib/oyi-shell/core/ — see SYNC.md there). Plain
  // dependency-free ES modules, imported natively by office.js's own
  // <script type="module">.
  const officeOyiCoreDockingPath = path.join(process.cwd(), "public", "office", "shared", "oyi-core", "docking.mjs");
  const officeOyiCorePresencePath = path.join(process.cwd(), "public", "office", "shared", "oyi-core", "presence.mjs");
  const officeOyiCoreResponseNormalizerPath = path.join(process.cwd(), "public", "office", "shared", "oyi-core", "responseNormalizer.mjs");
  const digitalTwinIndexPath = path.join(
    process.cwd(),
    "public",
    "digital-twin",
    "index.html"
  );
  const digitalTwinScriptPath = path.join(
    process.cwd(),
    "public",
    "digital-twin",
    "app.js"
  );
  const digitalTwinModelDir = path.join(
    process.cwd(),
    "public",
    "digital-twin",
    "model"
  );
  const planStudioIndexPath = path.join(
    process.cwd(),
    "public",
    "plan-studio",
    "index.html"
  );
  const planStudioScriptPath = path.join(
    process.cwd(),
    "public",
    "plan-studio",
    "app.js"
  );

  return http.createServer(async (req, res) => {
    const ctx = createRequestContext(req);
    const pathname = getPathname(req);
    const corsAccepted = setCorsHeaders(req, res, config.allowedOrigins);
    let authContext = null;

    if (req.method === "OPTIONS") {
      if (!corsAccepted && config.allowedOrigins.length > 0) {
        json(res, 403, { error: "origin_not_allowed" });
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    if (!corsAccepted && config.allowedOrigins.length > 0) {
      json(res, 403, { error: "origin_not_allowed" });
      return;
    }

    try {
      const isPublicWidgetPath =
        pathname === "/widget" ||
        pathname === "/widget/" ||
        pathname === "/widget.js" ||
        pathname === "/api/lead-agents/public/session" ||
        pathname === "/api/lead-agents/public/transcribe" ||
        pathname === "/api/lead-agents/public/chat";
      const isPublicDigitalTwinPath =
        pathname === "/digital-twin" ||
        pathname === "/digital-twin/" ||
        pathname === "/digital-twin/app.js" ||
        pathname === "/digital-twin/model/scene-definition.json" ||
        pathname === "/digital-twin/model/twin.gltf" ||
        pathname === "/digital-twin/model/twin.bin" ||
        pathname === "/digital-twin/model/twin.glb" ||
        pathname === "/api/digital-twin/scene";
      const isPublicPlanStudioPath =
        pathname === "/plan-studio" ||
        pathname === "/plan-studio/" ||
        pathname === "/plan-studio/app.js" ||
        (pathname === "/api/plan-studio/projects" && req.method === "GET") ||
        (pathname === "/api/plan-studio/project" && req.method === "GET");
      const isPublicDashboardPath =
        pathname === "/dashboard" ||
        pathname === "/dashboard/" ||
        pathname === "/dashboard.js" ||
        pathname === "/assets/ochiga-logo.png";
      const isPublicOfficeShellPath =
        pathname === "/" ||
        pathname === "/office" ||
        pathname === "/office/" ||
        pathname === "/office.js" ||
        pathname === "/office/brand/ochiga-logo-dark.png" ||
        pathname === "/office/brand/ochiga-logo-light.png" ||
        pathname === "/office/brand/icon-192.png" ||
        pathname === "/office/brand/icon-512.png" ||
        pathname === "/office/brand/icon-maskable-512.png" ||
        pathname === "/office/shared/oyi-core/docking.mjs" ||
        pathname === "/office/shared/oyi-core/presence.mjs" ||
        pathname === "/office/shared/oyi-core/responseNormalizer.mjs" ||
        pathname === "/office/manifest.json" ||
        pathname === "/office/sw.js";
      const isPublicAdminSessionPath =
        pathname === "/api/lead-agents/admin/session/login" ||
        pathname === "/api/lead-agents/admin/session/logout" ||
        pathname === "/api/lead-agents/admin/session/me" ||
        pathname === "/api/lead-agents/admin/session/reset/request" ||
        // These endpoints authenticate with a one-time, hashed token. They
        // must remain reachable before an invited/recovering user has a
        // session; each handler performs the token and expiry validation.
        pathname === "/api/lead-agents/admin/session/invite/accept" ||
        pathname === "/api/lead-agents/admin/session/reset/confirm";
      const isPublicWhatsappPath = pathname === "/webhooks/whatsapp";
      // A document share link is meant to be opened by an external
      // recipient (a lead/client with no Office login) — the token
      // itself (validated inside the route handler) is what gates
      // access here, not a staff session.
      const isPublicDocumentSharePath = /^\/api\/lead-agents\/documents\/shared\/[^/]+\/[^/]+$/.test(pathname);
      // Backend->Office Communication Runtime bridge (Oyi Communication
      // Runtime's WhatsAppAdapter calling out to reuse the existing
      // WhatsAppCloudAdapter here, since credentials/webhook live only
      // in Office). No Office staff session exists on this call path --
      // authenticated instead by the SAME shared secret
      // (OFFICE_SYNC_API_KEY/OFFICE_EXPORT_API_KEY) Office already sends
      // to Backend today, checked inline in the route handler below via
      // requireBackendBridgeKey, exactly like /webhooks/whatsapp bypasses
      // the generic session/api-key gate for its own dedicated check.
      const isBackendBridgePath =
        pathname === "/api/lead-agents/admin/communications/whatsapp/send" ||
        pathname === "/api/lead-agents/admin/communications/whatsapp/templates" ||
        pathname === "/api/lead-agents/admin/recipients/resolve" ||
        pathname === "/api/lead-agents/admin/communications/activity" ||
        pathname === "/api/lead-agents/admin/communications/create-task";

      if (
        pathname !== "/healthz" &&
        !isPublicWidgetPath &&
        !isPublicDigitalTwinPath &&
        !isPublicPlanStudioPath &&
        !isPublicDashboardPath &&
        !isPublicOfficeShellPath &&
        !isPublicAdminSessionPath &&
        !isPublicWhatsappPath &&
        !isPublicDocumentSharePath &&
        !isBackendBridgePath
      ) {
        authContext = tryEdgeAuth(req, config) || enforceAuth(req, config);
        authContext = await enrichAuthContext(authContext, store);
        const rateLimitState = officeInternalRateLimiter.check(req);
        res.setHeader("x-ratelimit-remaining", String(rateLimitState.remaining));
        res.setHeader(
          "x-ratelimit-reset",
          new Date(rateLimitState.resetAt).toISOString()
        );
      }

      if (pathname === "/healthz") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        json(res, 200, {
          ok: true,
          uptime_ms: Date.now() - startedAt,
          stats: await store.stats(),
          environment: config.environment,
          store_driver: config.storeDriver,
          tier1: {
            auth: {
              mode: config.authMode,
              session_cookie: config.sessionCookieName,
            },
            permissions: {
              roles: Object.keys(ROLE_PERMISSIONS),
              permission_count: PERMISSION_KEYS.length,
            },
            storage: storageService.health(),
            realtime: eventBus.stats(),
            database: {
              store_driver: config.storeDriver,
              connected: true,
            },
          },
        });
        return;
      }

      if (pathname === "/webhooks/whatsapp") {
        if (req.method === "GET") {
          const url = new URL(req.url, "http://localhost");
          const mode = url.searchParams.get("hub.mode");
          const challenge = whatsappAdapter.verifyWebhook(
            mode,
            url.searchParams.get("hub.verify_token"),
            url.searchParams.get("hub.challenge")
          );
          // Diagnostic only -- never the token/challenge values themselves.
          log("info", "whatsapp_webhook.verify_attempt", { request_id: ctx.requestId, mode, verified: Boolean(challenge) });
          if (!challenge) {
            json(res, 403, { error: "forbidden" });
            return;
          }
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(String(challenge));
          return;
        }
        if (req.method === "POST") {
          const { raw, json: body } = await readJsonBodyWithRaw(req);
          const signatureCheck = whatsappAdapter.verifySignature(raw, req.headers["x-hub-signature-256"]);
          // LIVE FINDING (Programme C verification, 2026-08-22): genuine
          // Meta-originated status-callback traffic was observed failing
          // this check with reason "signature_mismatch" immediately after
          // deploy -- the HMAC implementation matches Meta's documented
          // algorithm exactly (verified against the spec and unit-tested),
          // so the configured META_APP_SECRET in production is most likely
          // stale/incorrect (or there is an intermediary altering the raw
          // body in transit). Rejecting on this check right now would
          // silently break the entire live WhatsApp reply loop this same
          // programme built, which is strictly worse than the pre-existing
          // unverified state. Logged loudly (never silently) and NOT
          // enforced until a human confirms/regenerates META_APP_SECRET
          // against the real Meta App Dashboard value -- flip the `return`
          // back on below once that's confirmed correct.
          if (!signatureCheck.ok) {
            log("warn", "whatsapp_webhook.signature_check_failed_not_enforced", {
              request_id: ctx.requestId,
              reason: signatureCheck.reason,
              has_signature_header: Boolean(req.headers["x-hub-signature-256"]),
            });
          }
          const events = whatsappAdapter.extractEvents(body);
          log("info", "whatsapp_webhook.received", { request_id: ctx.requestId, event_count: events.length });
          const results = [];
          for (const event of events) {
            log("info", "whatsapp_webhook.event", {
              request_id: ctx.requestId,
              kind: event.kind,
              message_type: event.message_type || null,
              status: event.status || null,
              error_code: event.status === "failed" ? (event.raw?.errors?.[0]?.code ?? null) : null,
              error_title: event.status === "failed" ? (event.raw?.errors?.[0]?.title || event.raw?.errors?.[0]?.message || null) : null,
              message_id: event.message_id || null,
              phone_number_id: event.metadata?.phone_number_id || null,
              waba_display_number: event.metadata?.display_phone_number || null,
              sender_present: Boolean(event.from),
              timestamp: event.timestamp || null,
            });
            let outcome;
            try {
              outcome = await processWhatsAppEvent({
                event,
                store,
                adapter: whatsappAdapter,
                config,
                requestId: ctx.requestId,
              });
              log("info", "whatsapp_webhook.event_processed", {
                request_id: ctx.requestId,
                kind: event.kind,
                message_id: event.message_id || null,
                lead_id: outcome?.lead_id || null,
                paused: Boolean(outcome?.paused),
              });
            } catch (processError) {
              outcome = { kind: event.kind, error: true };
              log("error", "whatsapp_webhook.event_failed", {
                request_id: ctx.requestId,
                kind: event.kind,
                message_id: event.message_id || null,
                error: processError?.message || String(processError),
                // Diagnostic only -- HTTP status/PostgREST error code and
                // hint, never the request payload (could carry message
                // text) or any credential.
                http_status: processError?.response?.status || null,
                provider_error_code: processError?.response?.data?.code || null,
                provider_error_hint: processError?.response?.data?.hint || null,
                request_url: processError?.config?.url || null,
              });
            }
            results.push(outcome);
          }
          json(res, 200, { ok: true, results }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      if (isBackendBridgePath) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        const expectedKey = config.officeBackendApiKey;
        const providedKey = String(
          req.headers["x-api-key"] || req.headers["x-office-api-key"] || ""
        ).trim();
        if (!expectedKey || !providedKey || !secureCompare(providedKey, expectedKey)) {
          json(res, 401, { error: "unauthorized" }, { "x-request-id": ctx.requestId });
          return;
        }

        if (pathname === "/api/lead-agents/admin/recipients/resolve") {
          const body = await readJsonBody(req);
          try {
            const result = body.entity_type && body.entity_id
              ? await (async () => {
                  const candidate = await resolveRecipientByEntity(store, { entityType: body.entity_type, entityId: body.entity_id });
                  return candidate ? { status: "resolved", candidates: [candidate] } : { status: "not_found", candidates: [] };
                })()
              : await resolveRecipient(store, { query: body.query, queryType: body.query_type });
            json(res, 200, { ok: true, ...result }, { "x-request-id": ctx.requestId });
          } catch (error) {
            json(res, 200, { ok: false, status: "not_found", candidates: [], error: error?.message || "resolution_failed" }, { "x-request-id": ctx.requestId });
          }
          return;
        }

        // Phase 2 -- lets Oyi offer a REAL approved template instead of
        // just reporting a "template required" failure. Queries Meta
        // directly; never a hard-coded template name.
        if (pathname === "/api/lead-agents/admin/communications/whatsapp/templates") {
          try {
            const templates = await whatsappAdapter.listApprovedTemplates();
            json(res, 200, { ok: true, templates }, { "x-request-id": ctx.requestId });
          } catch (error) {
            json(res, 200, { ok: false, templates: [], error: error?.message || "templates_lookup_failed" }, { "x-request-id": ctx.requestId });
          }
          return;
        }

        // Communication outcomes -> CRM activity (Phase 13 of the
        // Communication Runtime programme). Purely additive: appends a
        // crm_activities row, never mutates lead/contact/opportunity
        // stage or status -- business state changes stay governed and
        // evidence-based elsewhere, not inferred from a delivery event.
        if (pathname === "/api/lead-agents/admin/communications/activity") {
          const body = await readJsonBody(req);
          if (!body.lead_id && !body.contact_id && !body.organization_id) {
            json(res, 200, { ok: false, error: "no_crm_linkage" }, { "x-request-id": ctx.requestId });
            return;
          }
          try {
            const record = await createCorporateRecord(
              store,
              "activities",
              {
                lead_id: body.lead_id || null,
                contact_id: body.contact_id || null,
                organization_id: body.organization_id || null,
                activity_type: body.activity_type || "communication",
                title: body.title || "Communication",
                body: body.body || "",
                source: "communication_runtime",
                actor: body.actor || "oyi",
                occurred_at: body.occurred_at || new Date().toISOString(),
              },
              { actorEmail: body.actor || "oyi" }
            );
            json(res, 200, { ok: true, activity_id: record?.id || null }, { "x-request-id": ctx.requestId });
          } catch (error) {
            json(res, 200, { ok: false, error: error?.message || "activity_create_failed" }, { "x-request-id": ctx.requestId });
          }
          return;
        }

        // Live Reply Loop programme -- lets a goal's reply_branches
        // ("if he says he's interested, create a task for me to call
        // him") create a REAL crm_tasks row through the existing Task
        // system, not a second one. Mirrors the activity-creation bridge
        // immediately above exactly (same auth, same createCorporateRecord
        // call, same actor-attribution convention).
        if (pathname === "/api/lead-agents/admin/communications/create-task") {
          const body = await readJsonBody(req);
          if (!body.title) {
            json(res, 200, { ok: false, error: "missing_title" }, { "x-request-id": ctx.requestId });
            return;
          }
          try {
            const record = await createCorporateRecord(
              store,
              "tasks",
              {
                lead_id: body.lead_id || null,
                opportunity_id: body.opportunity_id || null,
                title: body.title,
                description: body.description || "",
                priority: body.priority || "normal",
                assignee: body.assignee || "oyi",
                due_at: body.due_at || null,
              },
              { actorEmail: body.actor || "oyi" }
            );
            json(res, 200, { ok: true, task_id: record?.id || null }, { "x-request-id": ctx.requestId });
          } catch (error) {
            json(res, 200, { ok: false, error: error?.message || "task_create_failed" }, { "x-request-id": ctx.requestId });
          }
          return;
        }

        const body = await readJsonBody(req);
        const to = String(body.to || "").trim();
        const text = String(body.body || "").trim();
        const templateName = String(body.template_name || "").trim();
        if (!to || (!text && !templateName)) {
          json(res, 400, { error: "missing_to_or_body" }, { "x-request-id": ctx.requestId });
          return;
        }
        if (!whatsappAdapter.isConfigured()) {
          json(
            res,
            200,
            { ok: false, delivered: false, failure_reason: "not_configured" },
            { "x-request-id": ctx.requestId }
          );
          return;
        }
        try {
          const result = templateName
            ? await whatsappAdapter.sendTemplateMessage({
                to,
                templateName,
                languageCode: body.template_language || undefined,
                components: body.template_components || undefined,
              })
            : await whatsappAdapter.sendTextMessage({
                to,
                body: text,
                contextMessageId: body.context_message_id || undefined,
              });
          await appendAuditRecord({
            store,
            authContext: null,
            action: result.delivered ? "communication.whatsapp.sent" : "communication.whatsapp.send_failed",
            resourceType: "communication",
            resourceId: body.communication_id || "",
            metadata: {
              to,
              external_message_id: result.external_message_id || null,
              response_code: result.response_code || null,
              source: "communication_runtime_bridge",
            },
            req,
            status: result.delivered ? "success" : "failure",
          });
          json(
            res,
            200,
            {
              ok: Boolean(result.delivered),
              delivered: Boolean(result.delivered),
              external_message_id: result.external_message_id || null,
              response_code: result.response_code || null,
            },
            { "x-request-id": ctx.requestId }
          );
        } catch (error) {
          const statusCode = error?.response?.status || null;
          await appendAuditRecord({
            store,
            authContext: null,
            action: "communication.whatsapp.send_failed",
            resourceType: "communication",
            resourceId: body.communication_id || "",
            metadata: { to, provider_status: statusCode, source: "communication_runtime_bridge" },
            req,
            status: "failure",
          });
          json(
            res,
            200,
            {
              ok: false,
              delivered: false,
              failure_reason: statusCode === 401 || statusCode === 403 ? "authentication_failed" : "provider_unavailable",
              failure_detail: String(error?.response?.data?.error?.message || error?.message || error),
            },
            { "x-request-id": ctx.requestId }
          );
        }
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/reset/request") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        const body = await readJsonBody(req);
        const email = normalizeEmail(body.email);
        try {
          adminLoginRateLimiter.checkKey(loginAttemptKey(req, email));
        } catch (error) {
          json(res, 429, {
            error: "reset_rate_limit_exceeded",
            message: "Too many reset requests. Please wait a few minutes and try again.",
          });
          return;
        }
        const user = email ? await store.getAdminUserByEmail(email) : null;
        if (user && user.status === "active") {
          try {
            const rawToken = generateOpaqueToken();
            const reset = await store.createPasswordResetToken({
              admin_user_id: user.id,
              email: user.email,
              token_hash: hashOpaqueToken(rawToken),
              requested_by: "self_service",
              expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            });
            const resetUrl = absoluteUrl(req, "/office?mode=reset", rawToken, config);
            const emailDelivery = await sendOfficeEmail(config, {
              to: user.email,
              ...passwordResetEmail({ displayName: user.display_name || user.email, resetUrl }),
            });
            await appendAudit(store, { userId: user.id, email: user.email, role: user.role }, "password_reset_issued", "admin_user", user.id, {
              email: user.email,
              reset_id: reset.id,
              request_source: "self_service",
              email_delivery: emailDelivery,
            });
          } catch (error) {
            log("error", "office_auth.password_reset_request_failed", {
              request_id: ctx.requestId,
              failure_category: "delivery_or_persistence",
            });
          }
        }
        // Deliberately non-enumerating: unknown, inactive and active emails
        // receive the same response and no delivery metadata or token.
        json(res, 202, { ok: true, message: "If that Office account exists, a reset link has been sent." });
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/login") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        const body = await readJsonBody(req);
        const attemptKey = loginAttemptKey(req, body.email);
        const adminUser = await store.getAdminUserByEmail(body.email);
        const fallbackAllowed =
          !adminUser &&
          normalizeEmail(body.email) &&
          config.apiKeys.includes(String(body.password || ""));
        const credentialsValid =
          fallbackAllowed ||
          Boolean(adminUser && verifyPassword(body.password, adminUser.password_hash));
        try {
          const loginLimit = adminLoginRateLimiter.checkKey(attemptKey);
          res.setHeader("x-login-ratelimit-remaining", String(loginLimit.remaining));
          res.setHeader("x-login-ratelimit-reset", new Date(loginLimit.resetAt).toISOString());
        } catch (error) {
          if (credentialsValid) {
            adminLoginRateLimiter.resetKey(attemptKey);
          } else {
            json(
              res,
              429,
              {
                error: "login_rate_limit_exceeded",
                message: "Too many sign-in attempts. Please wait a few minutes and try again.",
              },
              {
                "x-request-id": ctx.requestId,
                "x-login-ratelimit-reset": error.rateLimit?.resetAt
                  ? new Date(error.rateLimit.resetAt).toISOString()
                  : "",
              }
            );
            return;
          }
        }

        if (adminUser && adminUser.status !== "active") {
          json(res, 403, { error: "account_inactive", message: "This Office account is inactive." });
          return;
        }
        if (!credentialsValid) {
          json(res, 401, { error: "unauthorized", message: "Email or password is incorrect." });
          return;
        }

        const sessionUser =
          adminUser ||
          (await store.ensureAdminUser({
            email: normalizeEmail(body.email),
            password_hash: hashPassword(body.password),
            role: config.adminRole || "admin",
            display_name: body.email,
            status: "active",
            last_login_at: new Date().toISOString(),
          }));
        await store.updateAdminUser(sessionUser.id, {
          last_login_at: new Date().toISOString(),
        });
        adminLoginRateLimiter.resetKey(attemptKey);
        await appendAudit(
          store,
          {
            userId: sessionUser.id,
            email: sessionUser.email,
            role: sessionUser.role,
          },
          "session_login",
          "admin_user",
          sessionUser.id,
          {}
        );
        const token = createAdminSessionToken(sessionUser, config);
        json(
          res,
          200,
          {
            ok: true,
            admin: {
              id: sessionUser.id,
              email: sessionUser.email,
              role: sessionUser.role,
              display_name: sessionUser.display_name || sessionUser.email,
              status: sessionUser.status || "active",
              permission_scopes: Array.isArray(sessionUser.permission_scopes)
                ? sessionUser.permission_scopes
                : [],
              office_position: sessionUser.office_position || "",
              passport_photo_url: sessionUser.passport_photo_url || "",
              qr_credential: sessionUser.qr_credential || "",
              permissions: permissionsForRole(sessionUser.role, sessionUser.permission_scopes),
            },
          },
          {
            "set-cookie": createSessionCookie(token, config),
            "x-request-id": ctx.requestId,
          }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/logout") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        json(
          res,
          200,
          { ok: true },
          {
            "set-cookie": clearSessionCookie(config),
            "x-request-id": ctx.requestId,
          }
        );
        await appendAudit(store, authContext, "session_logout", "session", authContext?.userId || "", {});
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/me") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        const session = readAdminSession(req, config);
        if (!session) {
          json(res, 401, { error: "unauthorized" }, { "x-request-id": ctx.requestId });
          return;
        }
        const currentUser = await store.getAdminUserByEmail(session.email);
        if (!currentUser || currentUser.status !== "active") {
          json(res, 401, { error: "unauthorized" }, { "x-request-id": ctx.requestId });
          return;
        }
        json(
          res,
          200,
          {
            ok: true,
            admin: {
              id: currentUser.id,
              email: currentUser.email,
              role: currentUser.role,
              display_name: currentUser.display_name || currentUser.email,
              status: currentUser.status || "active",
              permission_scopes: Array.isArray(currentUser.permission_scopes)
                ? currentUser.permission_scopes
                : [],
              office_position: currentUser.office_position || "",
              passport_photo_url: currentUser.passport_photo_url || "",
              qr_credential: currentUser.qr_credential || "",
              permissions: permissionsForRole(currentUser.role, currentUser.permission_scopes),
            },
          },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/password") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "change_password");
        const body = await readJsonBody(req);
        requireObject(body, "body");
        if (!body.current_password || !body.new_password) {
          json(res, 400, { error: "current_password and new_password are required" });
          return;
        }
        const currentUser = await store.getAdminUserByEmail(authContext.email);
        if (!currentUser || !verifyPassword(body.current_password, currentUser.password_hash)) {
          json(res, 401, { error: "unauthorized" });
          return;
        }
        const updated = await store.updateAdminUser(currentUser.id, {
          password_hash: hashPassword(body.new_password),
          password_changed_at: new Date().toISOString(),
        });
        await appendAudit(store, authContext, "password_changed", "admin_user", currentUser.id, {});
        json(res, 200, { ok: true, user: updated }, { "x-request-id": ctx.requestId });
        return;
      }

      // Self-service avatar upload — distinct from POST
      // /admin/users/:id/photo (staff.manage-gated, lets an admin set
      // someone else's photo). Any authenticated staff member can set
      // their OWN photo; no elevated permission required, same as
      // session/me and session/password above.
      if (pathname === "/api/lead-agents/admin/session/photo") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        if (!body.photo_data_url) {
          json(res, 400, { error: "photo_data_url is required" });
          return;
        }
        const currentUser = await store.getAdminUserByEmail(authContext.email);
        if (!currentUser) {
          json(res, 401, { error: "unauthorized" });
          return;
        }
        const storedPhotoRaw = await storageService.putDataUrl({
          data_url: body.photo_data_url,
          purpose: "staff_photo",
          mime_type: body.mime_type,
          resource_type: "staff",
          resource_id: currentUser.id,
        });
        const storedPhoto =
          typeof store.createOfficeFile === "function" ? await store.createOfficeFile(storedPhotoRaw) : storedPhotoRaw;
        const updated = await store.updateAdminUser(currentUser.id, { passport_photo_url: storedPhoto.url });
        await appendAudit(store, authContext, "admin_user_photo_updated", "admin_user", currentUser.id, { email: currentUser.email, self_service: true });
        eventBus.publish("office.staff", {
          action: "photo_updated",
          actor: authContext?.email || "",
          user: { id: updated.id, email: updated.email, passport_photo_url: updated.passport_photo_url },
        });
        json(res, 200, { ok: true, passport_photo_url: updated.passport_photo_url }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/invite/accept") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        if (!body.token || !body.password) {
          json(res, 400, { error: "token and password are required" });
          return;
        }
        const invite = await store.getAdminInviteByTokenHash(hashOpaqueToken(body.token));
        if (!invite || invite.status !== "pending" || new Date(invite.expires_at).getTime() < Date.now()) {
          json(res, 400, { error: "invalid_or_expired_invite" });
          return;
        }
        const existingUser = invite.admin_user_id
          ? await store.getAdminUserById(invite.admin_user_id)
          : await store.getAdminUserByEmail(invite.email);
        if (!existingUser || normalizeEmail(existingUser.email) !== normalizeEmail(invite.email) || existingUser.status !== "invited") {
          json(res, 409, { error: "staff_linkage_invalid", message: "This invitation is no longer linked to a pending staff account." });
          return;
        }
        const user = await store.updateAdminUser(existingUser.id, {
          password_hash: hashPassword(body.password),
          role: invite.role || "viewer",
          display_name: body.display_name || invite.display_name || invite.email,
          office_position: invite.office_position || "",
          phone: invite.phone || existingUser.phone || "",
          status: "active",
          password_changed_at: new Date().toISOString(),
        });
        await store.updateAdminInvite(invite.id, {
          status: "accepted",
          accepted_at: new Date().toISOString(),
        });
        await appendAudit(
          store,
          { userId: user.id, email: user.email, role: user.role },
          "invite_accepted",
          "admin_invite",
          invite.id,
          { email: invite.email }
        );
        const token = createAdminSessionToken(user, config);
        json(
          res,
          200,
          {
            ok: true,
            admin: {
              id: user.id,
              email: user.email,
              role: user.role,
              display_name: user.display_name || user.email,
              status: user.status || "active",
              office_position: user.office_position || "",
              permission_scopes: Array.isArray(user.permission_scopes) ? user.permission_scopes : [],
              passport_photo_url: user.passport_photo_url || "",
              qr_credential: user.qr_credential || "",
              permissions: permissionsForRole(user.role, user.permission_scopes),
            },
          },
          {
            "set-cookie": createSessionCookie(token, config),
            "x-request-id": ctx.requestId,
          }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/reset/confirm") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        if (!body.token || !body.new_password) {
          json(res, 400, { error: "token and new_password are required" });
          return;
        }
        const reset = await store.getPasswordResetTokenByHash(hashOpaqueToken(body.token));
        if (!reset || reset.status !== "pending" || new Date(reset.expires_at).getTime() < Date.now()) {
          json(res, 400, { error: "invalid_or_expired_reset" });
          return;
        }
        const user = await store.getAdminUserByEmail(reset.email);
        if (!user) {
          json(res, 404, { error: "user_not_found" });
          return;
        }
        await store.updateAdminUser(user.id, {
          password_hash: hashPassword(body.new_password),
          password_changed_at: new Date().toISOString(),
        });
        await store.updatePasswordResetToken(reset.id, {
          status: "used",
          used_at: new Date().toISOString(),
        });
        await appendAudit(
          store,
          { userId: user.id, email: user.email, role: user.role },
          "password_reset_completed",
          "admin_user",
          user.id,
          {}
        );
        json(res, 200, { ok: true }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/" || pathname === "/office" || pathname === "/office/") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, officeShellIndexPath);
        return;
      }

      if (pathname === "/dashboard" || pathname === "/dashboard/") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, dashboardIndexPath);
        return;
      }

      if (pathname === "/dashboard.js") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, dashboardScriptPath);
        return;
      }

      if (pathname === "/office.js") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, officeShellScriptPath);
        return;
      }

      if (pathname === "/assets/ochiga-logo.png") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, dashboardLogoPath);
        return;
      }

      if (pathname === "/office/brand/ochiga-logo-dark.png") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, officeLogoDarkPath);
        return;
      }

      if (pathname === "/office/brand/ochiga-logo-light.png") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, officeLogoLightPath);
        return;
      }

      if (pathname === "/office/brand/icon-192.png") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, officeIcon192Path);
        return;
      }

      if (pathname === "/office/brand/icon-512.png") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, officeIcon512Path);
        return;
      }

      if (pathname === "/office/brand/icon-maskable-512.png") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, officeIconMaskable512Path);
        return;
      }

      if (pathname === "/office/shared/oyi-core/docking.mjs") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, officeOyiCoreDockingPath);
        return;
      }

      if (pathname === "/office/shared/oyi-core/presence.mjs") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, officeOyiCorePresencePath);
        return;
      }

      if (pathname === "/office/shared/oyi-core/responseNormalizer.mjs") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, officeOyiCoreResponseNormalizerPath);
        return;
      }

      if (pathname === "/office/manifest.json") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, officeManifestPath);
        return;
      }

      if (pathname === "/office/sw.js") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, officeServiceWorkerPath);
        return;
      }

      if (pathname === "/widget" || pathname === "/widget/") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, widgetIndexPath);
        return;
      }

      if (pathname === "/widget.js") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, widgetScriptPath);
        return;
      }

      if (pathname === "/api/lead-agents/public/session") {
        const rateLimitState = widgetRateLimiter.check(req);
        res.setHeader("x-ratelimit-remaining", String(rateLimitState.remaining));
        res.setHeader("x-ratelimit-reset", new Date(rateLimitState.resetAt).toISOString());

        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }

        const body = await readJsonBody(req, 32 * 1024);
        const session = buildPublicIntelligenceSession({
          ...body,
          source_site: body.source_site || body.source || config.defaultLeadSource,
          source_channel: body.source_channel || "website",
        });
        await appendAudit(store, { userId: null, email: "", role: "guest" }, "public.session.created", "public_widget", session.session_id, {
          source_site: session.source.source_site,
          source_page: session.source.source_page,
          business_unit: session.business_unit,
          agent_role: session.active_agent_role,
          mode: session.engagement_mode,
        }, req);
        json(res, 201, {
          ok: true,
          session,
          public_identity: session.public_identity,
          oyi_core_request: buildOyiCoreCorporateRequest(session, body.message || ""),
        }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/digital-twin" || pathname === "/digital-twin/") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, digitalTwinIndexPath);
        return;
      }

      if (pathname === "/digital-twin/app.js") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, digitalTwinScriptPath);
        return;
      }

      if (pathname === "/plan-studio" || pathname === "/plan-studio/") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, planStudioIndexPath);
        return;
      }

      if (pathname === "/plan-studio/app.js") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, planStudioScriptPath);
        return;
      }

      if (pathname.startsWith("/digital-twin/model/")) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        const filename = pathname.slice("/digital-twin/model/".length);
        const allowedFiles = new Set([
          "scene-definition.json",
          "twin.gltf",
          "twin.bin",
          "twin.glb",
        ]);
        if (!allowedFiles.has(filename)) {
          notFound(res);
          return;
        }
        await serveFile(res, path.join(digitalTwinModelDir, filename));
        return;
      }

      if (pathname === "/api/digital-twin/scene") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        json(res, 200, digitalTwinRuntime.getScene(), {
          "x-request-id": ctx.requestId,
        });
        return;
      }

      if (pathname === "/api/digital-twin/device-action") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "twin.control");
        const body = await readJsonBody(req);
        if (!body.device_id || !body.action) {
          json(res, 400, { error: "device_id and action are required" });
          return;
        }
        const result = digitalTwinRuntime.dispatchAction(body.device_id, body.action);
        await appendAudit(store, authContext, "twin.device.action", "digital_twin_device", body.device_id, {
          action: body.action,
          source: "digital_twin",
        }, req);
        eventBus.publish("twin.state.updated", {
          device_id: body.device_id,
          action: body.action,
          result,
        });
        json(res, 200, result, {
          "x-request-id": ctx.requestId,
        });
        return;
      }

      if (pathname === "/api/digital-twin/edge-sync") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "devices.control");
        const result = digitalTwinRuntime.syncEdge();
        await appendAudit(store, authContext, "edge.heartbeat", "edge_agent", "digital_twin_edge", {
          source: "digital_twin_edge_sync",
          result,
        }, req);
        eventBus.publish("edge.heartbeat", {
          source: "digital_twin_edge_sync",
          result,
        });
        json(res, 200, result, {
          "x-request-id": ctx.requestId,
        });
        return;
      }

      if (pathname === "/api/plan-studio/projects") {
        if (req.method === "GET") {
          const projects = await planStudioRuntime.listProjects();
          json(res, 200, { projects }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, "planstudio.write");
          const body = await readJsonBody(req, 12 * 1024 * 1024);
          if (!body.image_data_url || !body.file_name) {
            json(res, 400, { error: "image_data_url and file_name are required" });
            return;
          }
          const project = await planStudioRuntime.saveProject(body);
          await appendAudit(store, authContext, "plan.uploaded", "plan", project.id, {
            file_name: project.file_name || body.file_name,
            source: "plan_studio",
          }, req);
          json(res, 200, { project }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      if (pathname === "/api/plan-studio/project") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        const url = new URL(req.url, "http://localhost");
        const projectId = url.searchParams.get("id");
        if (!projectId) {
          json(res, 400, { error: "id is required" });
          return;
        }
        const project = await planStudioRuntime.getProject(projectId);
        if (!project) {
          notFound(res);
          return;
        }
        json(res, 200, { project }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/plan-studio/analyze") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "planstudio.write");
        const body = await readJsonBody(req);
        if (!body.project_id) {
          json(res, 400, { error: "project_id is required" });
          return;
        }
        const project = await planStudioRuntime.analyzeProject(
          body.project_id,
          body.parsed_geometry
        );
        if (!project) {
          notFound(res);
          return;
        }
        json(res, 200, { project }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/plan-studio/parse") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "planstudio.write");
        const body = await readJsonBody(req, 12 * 1024 * 1024);
        if (!body.image_data_url) {
          json(res, 400, { error: "image_data_url is required" });
          return;
        }
        const parsed_geometry = await enhancePlanStudioGeometry({
          openaiClient,
          config,
          imageDataUrl: body.image_data_url,
          heuristicGeometry: body.parsed_geometry || {},
        });
        json(res, 200, { parsed_geometry }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/plan-studio/agent") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "planstudio.read");
        const body = await readJsonBody(req, 12 * 1024 * 1024);
        if (!body.project_id || !body.question) {
          json(res, 400, { error: "project_id and question are required" });
          return;
        }
        const project = await planStudioRuntime.getProject(body.project_id);
        if (!project) {
          notFound(res);
          return;
        }
        const reply = await answerPlanStudioQuestion({
          openaiClient,
          config,
          project,
          question: body.question,
        });
        json(res, 200, { reply }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/plan-studio/discipline") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "planstudio.write");
        const body = await readJsonBody(req);
        if (!body.project_id || !body.discipline) {
          json(res, 400, { error: "project_id and discipline are required" });
          return;
        }
        const project = await planStudioRuntime.updateDisciplineReview(
          body.project_id,
          body.discipline,
          body
        );
        if (!project) {
          notFound(res);
          return;
        }
        json(res, 200, { project }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/plan-studio/geometry") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "planstudio.write");
        const body = await readJsonBody(req, 12 * 1024 * 1024);
        if (!body.project_id || !body.geometry_truth) {
          json(res, 400, { error: "project_id and geometry_truth are required" });
          return;
        }
        const project = await planStudioRuntime.updateGeometryTruth(body.project_id, body);
        if (!project) {
          notFound(res);
          return;
        }
        json(res, 200, { project }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/public/chat") {
        const rateLimitState = widgetRateLimiter.check(req);
        res.setHeader("x-ratelimit-remaining", String(rateLimitState.remaining));
        res.setHeader(
          "x-ratelimit-reset",
          new Date(rateLimitState.resetAt).toISOString()
        );

        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }

        const body = await readJsonBody(req);
        if (body.website || body.company_url === "http://") {
          json(res, 400, { error: "request_rejected" });
          return;
        }
        if (!body.message || typeof body.message !== "string") {
          json(res, 400, { error: "message is required" });
          return;
        }
        if (body.message.length > config.publicWidgetMaxMessageChars) {
          json(res, 413, { error: "message_too_large", max_chars: config.publicWidgetMaxMessageChars });
          return;
        }

        const session = buildPublicIntelligenceSession({
          ...body,
          source_site: body.source_site || body.source || config.defaultLeadSource,
          source_channel: "website",
          lead_id: body.lead_id,
        });
        const blocked = detectBlockedPublicOperationalRequest({ message: body.message });
        if (blocked.blocked) {
          await appendAudit(store, { userId: null, email: "", role: "guest" }, "public.capability.blocked", "public_widget", body.lead_id || session.session_id, {
            source: body.source || config.defaultLeadSource,
            domain: blocked.domain,
            action: blocked.action,
            reason: blocked.reason,
          }, req);
          json(res, 403, {
            error: "public_capability_blocked",
            message: "I can explain Ochiga and route your enquiry, but I cannot access or control private building, resident, security, visitor, wallet, or device systems from this public surface.",
            session,
          }, { "x-request-id": ctx.requestId });
          return;
        }

        await appendAudit(store, { userId: null, email: "", role: "guest" }, "oyi_core.public_command.received", "public_widget", body.lead_id || session.session_id, { source: body.source || config.defaultLeadSource, prompt_excerpt: body.message.slice(0, 240), agent_role: session.active_agent_role, business_unit: session.business_unit }, req);

        const lead = await ensurePublicFallbackLead(store, body);
        const oyiCoreRequest = buildOyiCoreCorporateConversationRequest({
          session,
          message: body.message,
          lead,
          body,
          requestId: ctx.requestId,
        });
        const oyiCoreResult = await callOyiCoreCorporateConversation(config, oyiCoreRequest);
        if (!oyiCoreResult.ok) {
          log("warn", "lead_agents_server.oyi_core_unavailable", {
            request_id: ctx.requestId,
            public_session_id: session.session_id,
            reason: oyiCoreResult.reason,
            status: oyiCoreResult.status,
          });
          await store.appendTimelineEvent({
            lead_id: lead.id,
            event_type: "oyi_core_unavailable",
            actor: "ochiga_intelligence",
            title: "Oyi Core unavailable",
            body: "Public intelligence request could not be completed because Oyi Core was unavailable.",
            metadata: {
              request_id: ctx.requestId,
              public_session_id: session.session_id,
              reason: oyiCoreResult.reason,
              status: oyiCoreResult.status,
            },
          });
          await appendAudit(store, { userId: null, email: "", role: "guest" }, "oyi_core.public_response.unavailable", "public_widget", lead.id, { source: body.source || config.defaultLeadSource, reason: oyiCoreResult.reason, status: oyiCoreResult.status }, req, "failed");
          json(res, 503, {
            error: "oyi_core_unavailable",
            message: "Ochiga Intelligence is temporarily unavailable. Your enquiry context is saved in Office, but I cannot continue the conversation right now.",
            lead,
            public_intelligence: {
              session: {
                ...session,
                known_contact: Boolean(lead.id),
                crm_contact_ref: lead.id ? "office_lead_record" : null,
              },
              oyi_core_request: oyiCoreRequest,
            },
            degraded: true,
            intelligence_available: false,
          }, { "x-request-id": ctx.requestId });
          return;
        }

        const oyiCoreResponse = oyiCoreResult.response;
        const governedTools = await executeGovernedOfficeToolProposals({
          proposals: oyiCoreResponse.tool_proposals,
          store,
          lead,
          session,
          requestId: ctx.requestId,
        });
        const finalLead = governedTools.lead || lead;
        await store.appendTimelineEvent({
          lead_id: finalLead.id,
          event_type: "oyi_core_conversation_turn",
          actor: "ochiga_intelligence",
          title: "Public intelligence conversation",
          body: String(oyiCoreResponse.answer || "").slice(0, 500),
          metadata: {
            request_id: ctx.requestId,
            public_session_id: session.session_id,
            oyi_thread_id: oyiCoreResponse.conversation_thread_id,
            agent_role: oyiCoreResponse.recommended_internal_role || session.active_agent_role,
            business_unit: oyiCoreResponse.business_domain || session.business_unit,
            commercial_signal: oyiCoreResponse.commercial_signal,
            qualification_signal: oyiCoreResponse.qualification_signal,
            tool_result_count: governedTools.results.length,
          },
        });

        const result = {
          agent: session.active_agent_role === "osa" ? "sales_agent" : "marketing_agent",
          lead: finalLead,
          trace_id: ctx.requestId,
          lead_memory: null,
          knowledge_hits: Array.isArray(oyiCoreResponse.knowledge_references) ? oyiCoreResponse.knowledge_references : [],
          assistant_message: oyiCoreResponse.answer || "",
          tools: governedTools.results,
          conversations: await store.listConversationsForLead(finalLead.id, config.maxConversationMessages),
          oyi_core: {
            ok: true,
            canonical: Boolean(oyiCoreResponse.canonical),
            thread_id: oyiCoreResponse.conversation_thread_id || "",
          },
          intelligence_authority: "ochiga-backend",
          crm_source_of_truth: "ochiga-office",
        };

        await appendAudit(store, { userId: null, email: "", role: "guest" }, "oyi_core.public_response.generated", "public_widget", result.lead?.id || body.lead_id || "", { source: body.source || config.defaultLeadSource, trace_id: result.trace_id || "", degraded: Boolean(result.degraded), oyi_thread_id: oyiCoreResponse.conversation_thread_id || "" }, req);
        json(res, 200, {
          ...result,
          public_intelligence: {
            session: {
              ...session,
              conversation_thread_id: oyiCoreResponse.conversation_thread_id || session.conversation_thread_id,
              active_agent_role: oyiCoreResponse.recommended_internal_role || session.active_agent_role,
              known_contact: Boolean(result.lead?.id),
              crm_contact_ref: result.lead?.id ? "office_lead_record" : null,
            },
            oyi_core_request: oyiCoreRequest,
            oyi_core_response: {
              conversation_thread_id: oyiCoreResponse.conversation_thread_id || "",
              understood_intent: oyiCoreResponse.understood_intent || "",
              business_domain: oyiCoreResponse.business_domain || session.business_unit,
              recommended_internal_role: oyiCoreResponse.recommended_internal_role || session.active_agent_role,
              commercial_signal: oyiCoreResponse.commercial_signal || "none",
              qualification_signal: oyiCoreResponse.qualification_signal || "low",
              suggested_next_action: oyiCoreResponse.suggested_next_action || "",
              handoff_recommended: Boolean(oyiCoreResponse.handoff_recommended),
            },
            compatibility_contract: buildOyiCoreCorporateRequest(session, body.message),
          },
        }, {
          "x-request-id": ctx.requestId,
        });
        return;
      }

      if (pathname === "/api/lead-agents/public/transcribe") {
        const rateLimitState = widgetRateLimiter.check(req);
        res.setHeader("x-ratelimit-remaining", String(rateLimitState.remaining));
        res.setHeader(
          "x-ratelimit-reset",
          new Date(rateLimitState.resetAt).toISOString()
        );

        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }

        const body = await readJsonBody(req, 40 * 1024 * 1024);
        if (body.website || body.company_url === "http://") {
          json(res, 400, { error: "request_rejected" });
          return;
        }
        const audio = parseDataUrl(body.audio_data_url || body.audioDataUrl || "");
        if (!audio || !audio.buffer.length) {
          json(res, 400, { error: "audio_data_url is required" });
          return;
        }
        if (audio.buffer.length > 25 * 1024 * 1024) {
          json(res, 413, { error: "audio_too_large", max_bytes: 25 * 1024 * 1024 });
          return;
        }

        const mimeType = body.mime_type || body.mimeType || audio.mimeType || "audio/webm";
        const filename =
          body.file_name ||
          body.fileName ||
          `oyi-voice-note${extensionForAudioMime(mimeType)}`;
        const durationMs = Number(body.duration_ms || body.durationMs || 0);
        if (durationMs && durationMs > 120000) {
          json(res, 413, { error: "audio_too_long", max_duration_ms: 120000 });
          return;
        }

        try {
          const transcription = await openaiClient.createTranscription({
            buffer: audio.buffer,
            filename,
            mimeType,
            language: body.language || "en",
            prompt:
              body.prompt ||
              "Ochiga and Oyi smart estates, smart buildings, facility support, sales, and community conversations.",
          });
          const transcriptText = String(transcription.text || "").trim();
          await appendAudit(store, { userId: null, email: "", role: "guest" }, "ai.voice.transcribed", "public_widget_voice", body.lead_id || "", { model: config.openaiTranscriptionModel, bytes: audio.buffer.length, mime_type: mimeType, text_length: transcriptText.length }, req);
          json(
            res,
            200,
            {
              text: transcriptText,
              transcription,
              model: config.openaiTranscriptionModel,
            },
            { "x-request-id": ctx.requestId }
          );
        } catch (err) {
          log("error", "lead_agents_server.public_transcribe_failed", {
            request_id: ctx.requestId,
            error: err?.stack || err?.message || String(err),
          });
          json(
            res,
            err.statusCode && err.statusCode >= 400 ? err.statusCode : 502,
            {
              error: "transcription_failed",
              message: "Unable to transcribe this recording right now.",
            },
            { "x-request-id": ctx.requestId }
          );
        }
        return;
      }

      if (pathname === "/api/lead-agents/chat") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_leads");
        const body = await readJsonBody(req);
        if (!body.message || typeof body.message !== "string") {
          json(res, 400, { error: "message is required" });
          return;
        }

        const oyiCoreRequest = await buildOyiCoreOfficeInternalRequest({
          authContext,
          message: body.message,
          body,
          requestId: ctx.requestId,
          store,
          config,
        });
        const oyiCoreResult = await callOyiCoreOfficeInternalConversation(config, oyiCoreRequest);
        if (!oyiCoreResult.ok) {
          await appendAudit(store, authContext, "oyi_core.office_internal.unavailable", "office_session", oyiCoreRequest.office_session_id, {
            reason: oyiCoreResult.reason,
            status: oyiCoreResult.status,
          }, req, "failed");
          json(res, 503, {
            error: "oyi_core_unavailable",
            message: "Oyi Core is unavailable, so Office Internal intelligence cannot answer from a separate reasoning path.",
            oyi_core_request: oyiCoreRequest,
          }, { "x-request-id": ctx.requestId });
          return;
        }

        await appendAudit(store, authContext, "oyi_core.office_internal.completed", "office_session", oyiCoreRequest.office_session_id, {
          oyi_thread_id: oyiCoreResult.response.conversation_thread_id,
          business_domain: oyiCoreResult.response.business_domain,
          attention_signal: oyiCoreResult.response.attention_signal,
        }, req);
        json(res, 200, {
          agent: "office_internal",
          trace_id: ctx.requestId,
          assistant_message: oyiCoreResult.response.answer,
          oyi_core: oyiCoreResult.response,
          tools: oyiCoreResult.response.tool_proposals || [],
          intelligence_authority: "ochiga-backend",
          crm_source_of_truth: "ochiga-office",
        }, {
          "x-request-id": ctx.requestId,
        });
        return;
      }

      if (pathname === "/api/lead-agents/admin/leads") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_leads");
        const body = await readJsonBody(req);
        requireObject(body, "body");
        if (!body.source || typeof body.source !== "string") {
          json(res, 400, { error: "source is required" });
          return;
        }

        const lead = await store.createLead(
          normalizeLeadInput(
            {
              ...body,
              status: body.status || "new",
              owner: body.owner || "marketing_agent",
            },
            body.source
          )
        );

        json(res, 201, { lead }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/office/intake") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_leads");
        const body = await readJsonBody(req, 64 * 1024);
        const envelope = normalizeOfficeIntakeEnvelope(body);
        const existing = await findExistingIntakeLead(store, envelope.idempotency_key);
        if (existing) {
          const continuation = createFormContinuationContext(envelope, existing);
          json(res, 200, {
            ok: true,
            duplicate: true,
            request_id: envelope.request_id,
            idempotency_key: envelope.idempotency_key,
            lead: existing,
            conversation_continuation: continuation,
          }, { "x-request-id": ctx.requestId });
          return;
        }

        // Lead identity is deduped by email/phone (findOrUpsertLead) rather
        // than always creating a new row — a repeat enquiry from the same
        // person folds into their existing Lead as a sparse update plus a
        // fresh timeline/activity entry, so Office never accumulates an
        // uncontrolled number of duplicate records for one visitor.
        const { lead, created: leadCreated } = await findOrUpsertLead(store, envelope);
        const continuation = createFormContinuationContext(envelope, lead);

        // The canonical-CRM write (Contact/Organization/Opportunity/
        // Private or Partnership relationship/Activity) is additive
        // enrichment on top of the legacy Lead record above, not a
        // dependency of it — a transient failure here must not stop the
        // visitor's submission from being acknowledged and filed as a
        // Lead, since that's the record Office already relies on today.
        let crm = null;
        try {
          crm = await runOfficeIntakeCrm(store, envelope, lead, { actorEmail: envelope.source_site });
        } catch (error) {
          log("warn", "office_intake_crm_write_failed", {
            reason: error?.message || String(error),
            lead_id: lead.id,
            request_id: ctx.requestId,
          });
        }

        const timelineEvent = await store.appendTimelineEvent({
          lead_id: lead.id,
          event_type: "office_intake_received",
          actor: envelope.source_site,
          title: leadCreated ? "Office intake received" : "Repeat office intake received",
          body: `${envelope.business_unit} ${envelope.inquiry_type} intake received from ${envelope.source_site}.`,
          metadata: {
            request_id: envelope.request_id,
            idempotency_key: envelope.idempotency_key,
            source_channel: envelope.source_channel,
            source_site: envelope.source_site,
            source_page: envelope.source_page,
            source_form: envelope.source_form,
            business_unit: envelope.business_unit,
            inquiry_type: envelope.inquiry_type,
            campaign: envelope.campaign,
            consent: envelope.consent,
            public_context_ref: continuation.public_context_ref,
            crm_contact_id: crm?.contact?.id || null,
          },
        });
        const materialEvent = buildMaterialCrmEvent({
          lead,
          envelope,
          timelineEvent,
          requestId: ctx.requestId,
        });
        const backendEventResult = await publishBackendMaterialEvent(config, materialEvent);
        if (!backendEventResult.ok && !backendEventResult.skipped) {
          log("warn", "office_backend_material_event_publish_failed", {
            reason: backendEventResult.reason,
            status: backendEventResult.status,
            event_type: materialEvent.event_type,
            lead_id: lead.id,
            request_id: ctx.requestId,
          });
        }

        json(res, 201, {
          ok: true,
          duplicate: false,
          lead_created: leadCreated,
          request_id: envelope.request_id,
          idempotency_key: envelope.idempotency_key,
          lead,
          crm: crm
            ? {
                contact_id: crm.contact?.id || null,
                organization_id: crm.organization?.id || null,
                opportunity_id: crm.opportunity?.id || null,
                relationship_type: crm.relationship_collection,
                relationship_id: crm.relationship?.id || null,
                activity_id: crm.activity?.id || null,
              }
            : { sync_status: "failed_see_server_logs" },
          conversation_continuation: continuation,
          backend_event: {
            enabled: Boolean(config.officeBackendEventsEnabled),
            sent: Boolean(backendEventResult.ok),
            skipped: Boolean(backendEventResult.skipped),
            reason: backendEventResult.reason || null,
          },
        }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/leads") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_dashboard");
        json(
          res,
          200,
          { leads: await store.listLeads() },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      // Manual lead creation (CRM production closure pass) — leads have
      // always been creatable server-side (store.createLead, used by
      // website intake / marketing-agent flows), but no admin-facing
      // route existed for a staff member to add one directly. Reuses the
      // exact same store method, just gated to crm.manage and defaulting
      // owner/source to the real values a manual entry should carry
      // (the authenticated staff member and LEAD_SOURCES' "manual"),
      // instead of the automated-intake defaults.
      if (pathname === "/api/lead-agents/admin/crm/leads") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "crm.manage");
        const body = await readJsonBody(req);
        requireObject(body, "body");
        if (!String(body.name || body.company || "").trim()) {
          json(res, 400, { error: "name_or_company_required" });
          return;
        }
        const lead = await store.createLead({
          ...body,
          source: normalizeText(body.source) || "manual",
          owner: normalizeText(body.owner) || authContext?.email || "",
          status: normalizeText(body.status) || "new",
        });
        await appendAudit(store, authContext, "lead_created_manual", "lead", lead.id, {
          source: lead.source,
          business_unit: lead.business_unit,
        }, req);
        json(res, 201, { lead }, { "x-request-id": ctx.requestId });
        return;
      }

      const memoryMatch = pathname.match(/^\/api\/lead-agents\/leads\/([^/]+)\/memory$/);
      if (memoryMatch) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_dashboard");
        const memory = await store.getLeadMemory(memoryMatch[1]);
        json(res, 200, { memory }, { "x-request-id": ctx.requestId });
        return;
      }

      const timelineMatch = pathname.match(/^\/api\/lead-agents\/leads\/([^/]+)\/timeline$/);
      if (timelineMatch) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_dashboard");
        json(
          res,
          200,
          {
            timeline: await store.listTimelineForLead(timelineMatch[1]),
          },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      const channelStateMatch = pathname.match(
        /^\/api\/lead-agents\/leads\/([^/]+)\/channel-state\/([^/]+)$/
      );
      if (channelStateMatch) {
        const leadId = channelStateMatch[1];
        const channel = channelStateMatch[2];
        if (req.method === "GET") {
          authorizePermission(authContext, "view_dashboard");
          json(
            res,
            200,
            {
              channel_state: await store.getLeadChannelState(leadId, channel),
            },
            { "x-request-id": ctx.requestId }
          );
          return;
        }
        if (req.method === "PATCH") {
          authorizePermission(authContext, "manage_takeover");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const updated = await store.upsertLeadChannelState(leadId, channel, {
            ai_paused: body.ai_paused,
            human_owner: body.human_owner,
            human_status: body.human_status,
            takeover_started_at: body.takeover_started_at,
            takeover_reason: body.takeover_reason,
            resume_mode: body.resume_mode,
            customer_service_window_expires_at:
              body.customer_service_window_expires_at,
            last_external_message_id: body.last_external_message_id,
            last_inbound_at: body.last_inbound_at,
            last_outbound_at: body.last_outbound_at,
          });
          json(
            res,
            200,
            {
              channel_state: updated,
            },
            { "x-request-id": ctx.requestId }
          );
          return;
        }
        methodNotAllowed(res, "GET,PATCH");
        return;
      }

      const leadMatch = pathname.match(/^\/api\/lead-agents\/leads\/([^/]+)$/);
      if (leadMatch) {
        if (req.method === "GET") {
          authorizePermission(authContext, "view_dashboard");
          const lead = await store.getLead(leadMatch[1]);
          if (!lead) {
            notFound(res);
            return;
          }
          json(res, 200, { lead }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "PATCH") {
          authorizePermission(authContext, "manage_leads");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const before = await store.getLead(leadMatch[1]);
          const updated = await store.updateLead(leadMatch[1], sparseLeadPatchFromBody(body));
          if (!updated) {
            notFound(res);
            return;
          }
          // Oyi Runtime Contract, Domain 3 (Task) — customer_converted.
          // Fires only on the real transition into "won" (not every
          // subsequent edit to an already-won lead), matching the one
          // event this actually represents.
          if (before && before.commercial_stage !== "won" && updated.commercial_stage === "won") {
            void bridgeWorkflow({
              config,
              store,
              workflowType: "customer_converted",
              recordType: "lead",
              recordId: updated.id,
              title: `Customer converted — ${updated.company || updated.name || updated.id}`,
              summary: `Lead ${updated.company || updated.name || updated.id} moved to won.`,
              sourceRef: `lead:${updated.id}`,
            });
          }
          json(res, 200, { lead: updated }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,PATCH");
        return;
      }

      const qualifyMatch = pathname.match(/^\/api\/lead-agents\/leads\/([^/]+)\/qualify$/);
      if (qualifyMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_leads");
        const lead = await store.getLead(qualifyMatch[1]);
        if (!lead) {
          notFound(res);
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const qualification = qualifyLead(lead, body);
        const updated = store.qualifyLead
          ? await store.qualifyLead(lead.id, qualification)
          : await store.updateLead(lead.id, {
              ...qualification.patch,
              summary: qualification.summary,
              next_action: qualification.recommended_next_action,
            });
        await appendAudit(store, authContext, "lead_qualified", "lead", lead.id, qualification);
        json(res, 200, { lead: updated, qualification }, { "x-request-id": ctx.requestId });
        return;
      }

      const buildingReviewMatch = pathname.match(/^\/api\/lead-agents\/leads\/([^/]+)\/building-review$/);
      if (buildingReviewMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_demos");
        const lead = await store.getLead(buildingReviewMatch[1]);
        if (!lead) {
          notFound(res);
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const schedule = parsePreferredSchedule({
          text: body.scheduled_for || "",
          timezoneHint: body.timezone || "",
        });
        const reviewType = body.review_type || "building_review";
        const demo = await store.createDemo({
          lead_id: lead.id,
          scheduled_for: schedule.scheduled_for,
          status: body.status || (schedule.scheduled_for ? "confirmed" : "pending"),
          notes: JSON.stringify({
            review_type: reviewType,
            label: reviewType === "site_visit" ? "Site Visit" : "Building Review",
            notes: body.notes || "",
            timezone: schedule.timezone || body.timezone || "",
            preferred_time_text: body.scheduled_for || "",
            display_time: schedule.display_text || "",
          }),
        });
        const stage = reviewType === "site_visit" || reviewType === "technical_inspection"
          ? "site_visit_scheduled"
          : "discovery_scheduled";
        const updatedLead = await store.updateLead(lead.id, {
          stage,
          commercial_stage: stage,
          status: "booked",
          owner: "sales_agent",
          next_action: schedule.scheduled_for
            ? `${reviewType === "site_visit" ? "Site Visit" : "Building Review"} scheduled for ${schedule.display_text}`
            : `Confirm ${reviewType === "site_visit" ? "site visit" : "building review"} time`,
          next_action_at: schedule.scheduled_for,
        });
        await appendAudit(store, authContext, "building_review_scheduled", "lead", lead.id, {
          demo_id: demo.id,
          review_type: reviewType,
        });
        json(res, 201, { review: demo, lead: updatedLead }, { "x-request-id": ctx.requestId });
        return;
      }

      const approvalMatch = pathname.match(/^\/api\/lead-agents\/leads\/([^/]+)\/commercial-approval$/);
      if (approvalMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_commercial");
        const lead = await store.getLead(approvalMatch[1]);
        if (!lead) {
          notFound(res);
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const updatedLead = await store.updateLead(lead.id, {
          stage: body.approved === false ? "negotiation" : "commercial_approved",
          commercial_stage: body.approved === false ? "negotiation" : "commercial_approved",
          status: body.approved === false ? "sales" : "approved",
          owner: "sales_agent",
          next_action: body.approved === false ? "Resolve commercial blockers" : "Create deployment project and Facility workspace",
          notes: body.notes,
        });
        await appendAudit(store, authContext, "commercial_approval_updated", "lead", lead.id, {
          approved: body.approved !== false,
          notes: body.notes || "",
        });
        json(res, 200, { lead: updatedLead }, { "x-request-id": ctx.requestId });
        return;
      }

      const provisionMatch = pathname.match(/^\/api\/lead-agents\/leads\/([^/]+)\/provision-facility-workspace$/);
      if (provisionMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_commercial");
        const lead = await store.getLead(provisionMatch[1]);
        if (!lead) {
          notFound(res);
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const facilityAdminEmail = String(body.facility_admin_email || lead.email || "").trim().toLowerCase();
        const estateName = body.estate_name || body.property_name || lead.company;
        const [deployment, provisionResult] = await Promise.all([
          store.createDeploymentProject({
            lead_id: lead.id,
            package_name: body.package_name || lead.interest_package,
            property_name: body.property_name || lead.company,
            actor: authContext?.email || "office",
          }),
          provisionFacilityWorkspaceCore(store, config, authContext, {
            leadId: lead.id,
            facilityAdminEmail,
            customerOrganization: body.customer_organization || lead.company,
            estateName,
            address: body.address,
            timezone: body.timezone,
            facilityType: body.facility_type,
          }),
        ]);
        const { workspace, provisioning, workspaceCreatedId } = provisionResult;
        await appendAudit(store, authContext, "facility_workspace_requested", "lead", lead.id, {
          deployment_id: deployment.id,
          workspace_id: workspaceCreatedId,
        });
        if (provisioning.ok) {
          await appendAudit(store, authContext, "facility_provisioned", "lead", lead.id, {
            deployment_id: deployment.id,
            workspace_id: workspaceCreatedId,
            backend_estate_id: provisioning.estate?.id,
          });
        } else if (facilityAdminEmail) {
          await appendAudit(store, authContext, "facility_provisioning_failed", "lead", lead.id, {
            deployment_id: deployment.id,
            workspace_id: workspaceCreatedId,
            reason: provisioning.reason,
          });
        }
        json(res, 201, { deployment, workspace, provisioning }, { "x-request-id": ctx.requestId });
        return;
      }

      // Office->Facility provisioning lifecycle -- the "Portfolio -> New"
      // entry point (requirement #1). Same core provisioning as the
      // lead-anchored route above (shared, not duplicated), anchored to a
      // Portfolio record instead of a Lead -- no deployment_project or
      // lead-stage concept applies here. On success, links the Portfolio
      // record to the new estate via backend_estate_id (the same field
      // /office/portfolio/projection already matches operational data
      // against), so the Portfolio detail view's existing live-status
      // machinery picks it up with no further wiring.
      const portfolioProvisionMatch = pathname.match(/^\/api\/lead-agents\/admin\/office\/portfolio\/([^/]+)\/provision-facility$/);
      if (portfolioProvisionMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_commercial");
        const portfolioId = decodeURIComponent(portfolioProvisionMatch[1]);
        const portfolioRecord = await findCorporateRecord(store, "portfolio", portfolioId);
        if (!portfolioRecord) {
          notFound(res);
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const facilityAdminEmail = String(body.facility_admin_email || "").trim().toLowerCase();
        if (!facilityAdminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(facilityAdminEmail)) {
          const error = new Error("A valid facility_admin_email is required");
          error.statusCode = 400;
          throw error;
        }
        const estateName = body.estate_name || portfolioRecord.name;
        const { workspace, provisioning, workspaceCreatedId } = await provisionFacilityWorkspaceCore(store, config, authContext, {
          portfolioId,
          facilityAdminEmail,
          facilityAdminFullName: body.facility_admin_full_name,
          facilityAdminPhone: body.facility_admin_phone,
          customerOrganization: body.customer_organization || portfolioRecord.client_account,
          estateName,
          address: body.address,
          timezone: body.timezone,
          facilityType: body.facility_type,
        });
        await appendAudit(store, authContext, "facility_workspace_requested", "portfolio", portfolioRecord.id, {
          workspace_id: workspaceCreatedId,
        });
        if (provisioning.ok && provisioning.estate?.id) {
          const nextPortfolioRecord = { ...portfolioRecord, backend_estate_id: provisioning.estate.id, updated_at: new Date().toISOString() };
          await persistCorporateRecord(store, "portfolio", nextPortfolioRecord);
          await appendAudit(store, authContext, "facility_provisioned", "portfolio", portfolioRecord.id, {
            workspace_id: workspaceCreatedId,
            backend_estate_id: provisioning.estate.id,
          });
        } else {
          await appendAudit(store, authContext, "facility_provisioning_failed", "portfolio", portfolioRecord.id, {
            workspace_id: workspaceCreatedId,
            reason: provisioning.reason,
          });
        }
        json(res, 201, { workspace, provisioning }, { "x-request-id": ctx.requestId });
        return;
      }

      // Office->Facility provisioning lifecycle -- resend/revoke controls
      // on the Portfolio record (requirement #14). Both proxy onto
      // Backend's new Office-gated owner-invite routes, scoped by the
      // estate Office already linked at provisioning time
      // (portfolioRecord.backend_estate_id) -- never a client-submitted
      // invite id. Backend never sends the resend email itself (same
      // boundary as provisioning); Office builds/sends its own branded
      // copy from the rotated token it gets back.
      const portfolioInviteActionMatch = pathname.match(/^\/api\/lead-agents\/admin\/office\/portfolio\/([^/]+)\/facility-invite\/(resend|revoke)$/);
      if (portfolioInviteActionMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_commercial");
        const portfolioId = decodeURIComponent(portfolioInviteActionMatch[1]);
        const action = portfolioInviteActionMatch[2];
        const portfolioRecord = await findCorporateRecord(store, "portfolio", portfolioId);
        if (!portfolioRecord) {
          notFound(res);
          return;
        }
        const estateId = portfolioRecord.backend_estate_id;
        if (!estateId) {
          const error = new Error("This Portfolio record has no linked Facility deployment yet");
          error.statusCode = 400;
          throw error;
        }
        const [workspace] = await store.listFacilityWorkspacesByPortfolioIds([portfolioId]);

        if (action === "revoke") {
          const result = await revokeBackendFacilityOwnerInvite(config, estateId);
          if (result.ok && workspace) {
            await store.updateFacilityWorkspace(workspace.id, {
              status: "invite_revoked",
              checklist: { ...(workspace.checklist || {}), facility_admin_invite: "revoked" },
            });
          }
          await appendAudit(store, authContext, result.ok ? "facility_invitation_revoked" : "facility_invitation_revoke_failed", "portfolio", portfolioRecord.id, {
            backend_estate_id: estateId,
            reason: result.ok ? undefined : result.reason,
          });
          json(res, result.ok ? 200 : 502, result, { "x-request-id": ctx.requestId });
          return;
        }

        const result = await resendBackendFacilityOwnerInvite(config, estateId);
        if (result.ok && result.activation_token) {
          const estateName = portfolioRecord.name || "";
          const activationLink = `${String(config.officeFacilityBaseUrl || "").replace(/\/+$/, "")}/facility-invite?token=${encodeURIComponent(result.activation_token)}`;
          const emailResult = await sendOfficeEmail(
            config,
            facilityOwnerInviteEmail({ estateName, inviteUrl: activationLink, expiresAt: result.invite?.expires_at })
          ).catch((err) => ({ delivered: false, skipped: true, reason: err?.message || "email_send_failed" }));
          if (workspace) {
            await store.updateFacilityWorkspace(workspace.id, {
              status: "invitation_sent",
              activation_link: activationLink,
              checklist: { ...(workspace.checklist || {}), facility_admin_invite: emailResult.delivered ? "sent" : "ready_to_send" },
            });
          }
          await appendAudit(store, authContext, "facility_invitation_resent", "portfolio", portfolioRecord.id, {
            backend_estate_id: estateId,
            email_delivered: Boolean(emailResult.delivered),
          });
          json(res, 200, { ok: true, email_delivered: Boolean(emailResult.delivered) }, { "x-request-id": ctx.requestId });
          return;
        }
        await appendAudit(store, authContext, "facility_invitation_resend_failed", "portfolio", portfolioRecord.id, {
          backend_estate_id: estateId,
          reason: result.reason,
        });
        json(res, 502, result, { "x-request-id": ctx.requestId });
        return;
      }

      const conversationMatch = pathname.match(
        /^\/api\/lead-agents\/leads\/([^/]+)\/conversations$/
      );
      if (conversationMatch) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_dashboard");
        json(
          res,
          200,
          {
            conversations: await store.listConversationsForLead(conversationMatch[1]),
          },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      const proposalMatch = pathname.match(/^\/api\/lead-agents\/leads\/([^/]+)\/proposals$/);
      if (proposalMatch) {
        const leadId = proposalMatch[1];
        if (req.method === "GET") {
          authorizePermission(authContext, "view_dashboard");
          json(
            res,
            200,
            { proposals: await store.listProposalsForLead(leadId) },
            { "x-request-id": ctx.requestId }
          );
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, "manage_commercial");
          const lead = await store.getLead(leadId);
          if (!lead) {
            notFound(res);
            return;
          }
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const inferred = inferCommercialFacts([lead.summary, lead.next_action, body.context || ""].join(" "));
          const unitCount = body.unit_count || lead.unit_count || inferred.unit_count;
          const projectType = body.project_type || lead.project_type || inferred.project_type;
          const proposalPayload = buildProposal({
            unitCount,
            projectType,
            leadName: lead.name,
            company: lead.company,
            packageName: body.package_name || lead.interest_package,
            painPoints: body.pain_points || lead.pain_points || lead.summary,
            timeline: body.timeline || lead.timeline,
          });
          const proposal = await store.createProposal({
            lead_id: leadId,
            ...proposalPayload,
            status: body.status || "draft",
            actor: authContext?.email || "system",
          });
          const proposalStatus = String(body.status || "draft").toLowerCase();
          const updatedLead = await store.updateLead(leadId, {
            unit_count: unitCount,
            project_type: projectType,
            commercial_stage:
              proposalStatus === "accepted"
                ? "won"
                : proposalStatus === "declined"
                ? "lost"
                : proposalStatus === "sent"
                ? "proposal_sent"
                : lead.stage || lead.commercial_stage || "qualified",
            status: proposalStatus === "accepted" ? "closed" : proposalStatus === "declined" ? "lost" : undefined,
            stage:
              proposalStatus === "sent"
                ? "proposal_sent"
                : proposalStatus === "accepted"
                ? "won"
                : proposalStatus === "declined"
                ? "lost"
                : undefined,
            interest_package: proposalPayload.tier_name,
            lost_reason: proposalStatus === "declined" ? "proposal_declined" : undefined,
            next_action:
              proposalStatus === "accepted"
                ? "Prepare deployment plan"
                : proposalStatus === "declined"
                ? "Record loss and nurture if needed"
                : "Review and send proposal",
          });
          await appendAudit(store, authContext, "proposal_created", "proposal", proposal.id, {
            lead_id: leadId,
            tier_name: proposal.tier_name,
            status: proposal.status,
          });
          json(res, 201, { proposal, lead: updatedLead }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      const demosMatch = pathname.match(/^\/api\/lead-agents\/leads\/([^/]+)\/demos$/);
      if (demosMatch) {
        if (req.method === "GET") {
          authorizePermission(authContext, "view_dashboard");
          json(
            res,
            200,
            {
              demos: await store.listDemosForLead(demosMatch[1]),
            },
            { "x-request-id": ctx.requestId }
          );
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, "manage_demos");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const lead = await store.getLead(demosMatch[1]);
          if (!lead) {
            notFound(res);
            return;
          }
          const schedule = parsePreferredSchedule({
            text: body.scheduled_for || "",
            timezoneHint: body.timezone || "",
          });
          const calendarLinks = buildCalendarLinks({
            title: "Ochiga Discovery Demo",
            description: `Lead ${lead.name || ""} ${lead.company ? `(${lead.company})` : ""}`.trim(),
            location: lead.location || "",
            startIso: schedule.scheduled_for,
            timezone: schedule.timezone,
          });
          const demo = await store.createDemo({
            lead_id: demosMatch[1],
            scheduled_for: schedule.scheduled_for,
            status: body.status || (schedule.scheduled_for ? "confirmed" : "pending"),
            notes: JSON.stringify({
              notes: body.notes || "",
              timezone: schedule.timezone || body.timezone || "",
              preferred_time_text: body.scheduled_for || "",
              display_time: schedule.display_text || "",
              calendar_links: calendarLinks,
            }),
          });
          // Oyi Runtime Contract, Domain 3 (Task) — meeting_requested.
          // Every real demo booking is a new meeting request; no
          // before/after transition check needed (unlike stage-change
          // triggers) since creation itself is the event.
          void bridgeWorkflow({
            config,
            store,
            workflowType: "meeting_requested",
            recordType: "demo",
            recordId: demo.id,
            title: `Demo requested — ${lead.company || lead.name || lead.id}`,
            summary: schedule.scheduled_for ? `Demo requested for ${schedule.display_text}.` : "Demo requested, time to be confirmed.",
            sourceRef: `demo:${demo.id}`,
          });
          if (parseBoolean(body.update_lead_status, true)) {
            await store.updateLead(demosMatch[1], {
              status: "booked",
              owner: "sales_agent",
              next_action: schedule.scheduled_for
                ? `Confirmed demo for ${schedule.display_text}`
                : "Confirm scheduled demo",
            });
          }
          json(res, 201, { demo }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      if (pathname === "/api/lead-agents/admin/demos") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_reports");
        json(
          res,
          200,
          { demos: await store.listDemos() },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/proposals") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_reports");
        json(
          res,
          200,
          { proposals: await store.listProposals() },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/commercial/pipeline") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_dashboard");
        const leads = await store.listLeads();
        const byStage = Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage, []]));
        leads.forEach((lead) => {
          const stage = PIPELINE_STAGES.includes(lead.stage) ? lead.stage : lead.commercial_stage || lead.status || "new";
          const key = PIPELINE_STAGES.includes(stage) ? stage : "new";
          byStage[key].push(lead);
        });
        json(res, 200, { stages: PIPELINE_STAGES, by_stage: byStage }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/partners") {
        if (req.method === "GET") {
          authorizePermission(authContext, "view_dashboard");
          json(res, 200, { partners: store.listPartners ? await store.listPartners() : [] }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, "manage_commercial");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const partner = await store.createPartner(body);
          await appendAudit(store, authContext, "partner_created", "partner", partner.id, partner);
          json(res, 201, { partner }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      if (pathname === "/api/lead-agents/admin/deployments") {
        if (req.method === "GET") {
          authorizePermission(authContext, "view_dashboard");
          json(res, 200, { deployments: store.listDeploymentProjects ? await store.listDeploymentProjects() : [] }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, "manage_commercial");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const deployment = await store.createDeploymentProject({
            ...body,
            actor: authContext?.email || "office",
          });
          await appendAudit(store, authContext, "deployment_project_created", "deployment", deployment.id, deployment);
          // Oyi Runtime Contract, Domain 3 (Task) — deployment_required.
          // Creation itself is the event; origin_agent osa -> Facility,
          // the real cross-agent handoff this workflow_type exists for.
          void bridgeWorkflow({
            config,
            store,
            workflowType: "deployment_required",
            recordType: "deployment",
            recordId: deployment.id,
            title: `Deployment required — ${deployment.name || deployment.company || deployment.id}`,
            summary: `New deployment project created: ${deployment.name || deployment.id}.`,
            sourceRef: `deployment:${deployment.id}`,
          });
          json(res, 201, { deployment }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      if (pathname === "/api/lead-agents/admin/facility-workspaces") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_dashboard");
        json(res, 200, { workspaces: store.listFacilityWorkspaces ? await store.listFacilityWorkspaces() : [] }, { "x-request-id": ctx.requestId });
        return;
      }

      const proposalAdminMatch = pathname.match(/^\/api\/lead-agents\/admin\/proposals\/([^/]+)$/);
      if (proposalAdminMatch) {
        if (req.method !== "PATCH") {
          methodNotAllowed(res, "PATCH");
          return;
        }
        authorizePermission(authContext, "manage_commercial");
        const proposal = await store.getProposal(proposalAdminMatch[1]);
        if (!proposal) {
          notFound(res);
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const updatedProposal = await store.updateProposal(proposal.id, {
          status: body.status || proposal.status,
          body: body.body || proposal.body,
          metadata: body.metadata || proposal.metadata,
        });
        const proposalStatus = String(updatedProposal.status || "").toLowerCase();
        const leadPatch = {
          commercial_stage:
            proposalStatus === "accepted"
              ? "won"
              : proposalStatus === "declined"
              ? "lost"
              : proposalStatus === "sent"
              ? "proposal_sent"
              : "proposal_sent",
          status: proposalStatus === "accepted" ? "closed" : proposalStatus === "declined" ? "lost" : undefined,
          stage: proposalStatus === "sent" ? "proposal_sent" : proposalStatus === "accepted" ? "won" : proposalStatus === "declined" ? "lost" : undefined,
          lost_reason: proposalStatus === "declined" ? "proposal_declined" : undefined,
          next_action:
            proposalStatus === "accepted"
              ? "Prepare deployment plan"
              : proposalStatus === "declined"
              ? "Record loss and nurture if needed"
              : proposalStatus === "sent"
              ? "Await proposal feedback"
              : "Review proposal",
        };
        const updatedLead = await store.updateLead(proposal.lead_id, leadPatch);
        await appendAudit(store, authContext, "proposal_updated", "proposal", proposal.id, {
          status: updatedProposal.status,
          lead_id: proposal.lead_id,
        });
        // Oyi Runtime Contract, Domain 3 (Task) — proposal_accepted.
        // Fires only on the real transition into "accepted" (proposal.
        // status was something else before this PATCH), matching the
        // one event this represents. This is the moment the lead also
        // moves to "won" above — deliberately NOT also firing
        // customer_converted for the same fact (that bridges only from
        // a direct lead-stage PATCH with no proposal involved).
        if (proposal.status !== "accepted" && proposalStatus === "accepted") {
          void bridgeWorkflow({
            config,
            store,
            workflowType: "proposal_accepted",
            recordType: "proposal",
            recordId: updatedProposal.id,
            title: `Proposal accepted — ${updatedLead?.company || updatedLead?.name || proposal.lead_id}`,
            summary: `Proposal ${updatedProposal.tier_name || updatedProposal.id} accepted.`,
            sourceRef: `proposal:${updatedProposal.id}`,
          });
        }
        json(
          res,
          200,
          { proposal: updatedProposal, lead: updatedLead },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/notify-founder") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "escalate_founder");
        const body = await readJsonBody(req);
        requireObject(body, "body");
        if (!body.reason || !body.summary) {
          json(res, 400, { error: "reason and summary are required" });
          return;
        }
        const result = await toolExecutor.execute(
          "notify_founder",
          {
            lead_id: body.lead_id,
            urgency: body.urgency,
            reason: body.reason,
            summary: body.summary,
          },
          {
            leadId: body.lead_id || null,
            source: "admin",
            agentName: "human",
          }
        );
        json(res, 200, result, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/traces") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        // AI Agents (observability closure pass) — a real 7/30-day
        // Interactions Over Time range needs more depth than the
        // previous hardcoded 200-row cap could honestly support; capped
        // at 1000 so this stays a bounded, deliberate query, not an
        // unbounded one.
        const tracesUrl = new URL(req.url, "http://localhost");
        const requestedLimit = Number(tracesUrl.searchParams.get("limit"));
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
          ? Math.min(Math.floor(requestedLimit), 1000)
          : 200;
        json(
          res,
          200,
          {
            traces: await store.listTraces(limit, {
              lead_id: req.headers["x-lead-id"] || "",
            }),
          },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      // Oyi Cross-Surface Observability Closure — Consumer/Facility/
      // Website-Oyi-widget conversation, voice, vision and device-
      // execution activity Office's own local traces table has no
      // visibility into. Same permission as traces (this is the same
      // observability surface, just a second real source feeding it).
      if (pathname === "/api/lead-agents/admin/observability-events") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const eventsUrl = new URL(req.url, "http://localhost");
        const requestedLimit = Number(eventsUrl.searchParams.get("limit"));
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
          ? Math.min(Math.floor(requestedLimit), 1000)
          : 200;
        const result = await callOyiCoreObservabilityEvents(config, { limit });
        json(
          res,
          200,
          { events: result.events || [], available: result.ok !== false },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/notifications") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "manage_notifications");
        json(
          res,
          200,
          {
            notifications: await store.listNotifications(200),
          },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      // Every real Office role gets notifications.read (see
      // permissions.js) — deliberately lighter than manage_notifications
      // above, which is for the admin oversight view of every
      // notification. This route only ever returns rows targeted at the
      // caller plus broadcast rows, never another staff member's.
      if (pathname === "/api/lead-agents/admin/notifications/mine") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "notifications.read");
        const mine = await store.listNotifications(100, { forRecipient: normalizeEmail(authContext?.email || "") });
        json(
          res,
          200,
          {
            notifications: mine,
            unread_count: mine.filter((item) => !item.read_at).length,
          },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      const notificationReadMatch = pathname.match(/^\/api\/lead-agents\/admin\/notifications\/([^/]+)\/read$/);
      if (notificationReadMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "notifications.read");
        const existing = await store.getNotificationById?.(notificationReadMatch[1]);
        // Ownership check: only the targeted recipient (or a broadcast
        // row anyone with notifications.read can see) may acknowledge
        // it — never someone else's targeted notification, even with
        // this lighter permission.
        if (existing && existing.recipient_email && normalizeEmail(existing.recipient_email) !== normalizeEmail(authContext?.email || "")) {
          json(res, 403, { error: "forbidden" }, { "x-request-id": ctx.requestId });
          return;
        }
        const notification = await store.updateNotification(notificationReadMatch[1], { read_at: new Date().toISOString() });
        if (!notification) {
          notFound(res);
          return;
        }
        json(res, 200, { notification }, { "x-request-id": ctx.requestId });
        return;
      }

      const notificationMatch = pathname.match(
        /^\/api\/lead-agents\/admin\/notifications\/([^/]+)$/
      );
      if (notificationMatch) {
        if (req.method !== "PATCH") {
          methodNotAllowed(res, "PATCH");
          return;
        }
        authorizePermission(authContext, "manage_notifications");
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const notification = await store.updateNotification(notificationMatch[1], {
          status: body.status,
          delivered:
            body.delivered === undefined ? undefined : parseBoolean(body.delivered, false),
          response_code: body.response_code,
          metadata: body.metadata,
          summary: body.summary,
        });
        if (!notification) {
          notFound(res);
          return;
        }
        eventBus.publish("office.notification", {
          actor: authContext?.email || "",
          notification,
        });
        json(
          res,
          200,
          {
            notification,
          },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/reports/summary") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_reports");
        json(
          res,
          200,
          {
            report: await store.getReportingSummary(),
          },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/office/home") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "office.read");
        const home = await buildOfficeHomeProjection(store, {
          includeRecentActivity: authContext.type === "api_key" || hasPermission(authContext, "crm.read"),
          includeFinancial: hasPermission(authContext, "financial.read"),
          config,
        });
        json(res, 200, { home }, { "x-request-id": ctx.requestId });
        return;
      }

      const crmCollectionMatch = pathname.match(/^\/api\/lead-agents\/admin\/crm\/(contacts|organizations|opportunities|activities|tasks)$/);
      if (crmCollectionMatch) {
        const collection = crmCollectionMatch[1];
        const policy = CORPORATE_COLLECTIONS[collection];
        if (req.method === "GET") {
          authorizePermission(authContext, policy.permission);
          json(res, 200, { collection: await listCorporateRecords(store, collection) }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, policy.manage);
          const body = await readJsonBody(req);
          requireObject(body, "body");
          if (collection === "tasks") {
            await validateOperationalRelationships(store, authContext, collection, body);
          }
          const record = collection === "contacts"
            ? await upsertContactIdentity(store, body, { actorEmail: authContext?.email || "office" })
            : await createCorporateRecord(store, collection, body, { actorEmail: authContext?.email || "office" });
          const relatedTaskRef = collection === "tasks" ? taskRelatedActivityRef(record) : null;
          if (relatedTaskRef) {
            await createRelatedActivity(store, {
              ...relatedTaskRef,
              activity_type: "task_created",
              title: "Task created",
              body: record.title || "Task created.",
            }, { authContext, actorEmail: authContext?.email || "office" });
          }
          await appendAudit(store, authContext, `crm_${collection}_upserted`, collection, record.id, {
            business_unit: record.business_unit,
            status: record.status,
          });
          if (collection === "tasks") {
            await notifyRecipients(store, eventBus, {
              recipientEmails: notificationTargetsForRecord(collection, record),
              actorEmail: authContext?.email,
              type: "task_assigned",
              summary: notificationSummaryForRecord(collection, "created", record),
              relatedType: "task",
              relatedId: record.id,
            });
          }
          json(res, 201, { record }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      const crmItemMatch = pathname.match(/^\/api\/lead-agents\/admin\/crm\/(tasks)\/([^/]+)$/);
      if (crmItemMatch) {
        const [, collection, id] = crmItemMatch;
        const policy = CORPORATE_COLLECTIONS[collection];
        if (req.method === "PATCH") {
          authorizePermission(authContext, policy.manage);
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const result = await updateOperationalRecord(store, collection, decodeURIComponent(id), body, {
            authContext,
            actorEmail: authContext?.email || "office",
          });
          await appendAudit(store, authContext, `crm_${collection}_updated`, collection, result.record.id, {
            status: result.record.status,
            allowed_status_transitions: result.allowed_status_transitions,
          });
          await notifyRecipients(store, eventBus, {
            recipientEmails: notificationTargetsForRecord(collection, result.record),
            actorEmail: authContext?.email,
            type: "task_updated",
            summary: notificationSummaryForRecord(collection, "updated", result.record),
            relatedType: "task",
            relatedId: result.record.id,
          });
          json(res, 200, result, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "PATCH");
        return;
      }

      // Tasks Domain UI — Automations. Thin proxy to Ochiga-backend's
      // /office/automations* (officeExport.ts), which is itself a thin
      // wrapper around the existing Shared Automation Runtime
      // (scenes.ts). No automation state lives in Office — every read
      // and write here round-trips to Backend. Reuses the Tasks
      // permission pair (tasks.read/tasks.manage) rather than
      // inventing a new one, since Automations is part of the Tasks
      // domain, not a separate feature area.
      const automationsCollectionMatch = pathname.match(/^\/api\/lead-agents\/admin\/automations$/);
      if (automationsCollectionMatch) {
        if (req.method === "GET") {
          authorizePermission(authContext, "tasks.read");
          const requestUrl = new URL(req.url, "http://localhost");
          const result = await callOyiCoreListAutomations(config, { status: requestUrl.searchParams.get("status") || undefined });
          json(res, result.ok ? 200 : (result.status || 502), result.ok ? { automations: result.data.automations || [] } : { error: result.error }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, "tasks.manage");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const result = await callOyiCoreCreateAutomation(config, body);
          if (result.ok) {
            await appendAudit(store, authContext, "automation_created", "automation", result.data.automation?.id, { name: body.name });
          }
          json(res, result.ok ? 201 : (result.status || 502), result.ok ? { automation: result.data.automation } : { error: result.error }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      const automationItemMatch = pathname.match(/^\/api\/lead-agents\/admin\/automations\/([^/]+)$/);
      if (automationItemMatch) {
        const id = decodeURIComponent(automationItemMatch[1]);
        if (req.method === "GET") {
          authorizePermission(authContext, "tasks.read");
          const result = await callOyiCoreGetAutomation(config, id);
          json(res, result.ok ? 200 : (result.status || 502), result.ok ? { automation: result.data.automation } : { error: result.error }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "PATCH") {
          authorizePermission(authContext, "tasks.manage");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const result = await callOyiCoreUpdateAutomation(config, id, body);
          if (result.ok) {
            await appendAudit(store, authContext, "automation_updated", "automation", id, { enabled: body.enabled });
          }
          json(res, result.ok ? 200 : (result.status || 502), result.ok ? { automation: result.data.automation } : { error: result.error }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "DELETE") {
          authorizePermission(authContext, "tasks.manage");
          const result = await callOyiCoreDeleteAutomation(config, id);
          if (result.ok) {
            await appendAudit(store, authContext, "automation_deleted", "automation", id, {});
          }
          json(res, result.ok ? 200 : (result.status || 502), result.ok ? { ok: true, id } : { error: result.error }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,PATCH,DELETE");
        return;
      }

      const automationRunsMatch = pathname.match(/^\/api\/lead-agents\/admin\/automations\/([^/]+)\/runs$/);
      if (automationRunsMatch) {
        authorizePermission(authContext, "tasks.read");
        const result = await callOyiCoreListAutomationRuns(config, decodeURIComponent(automationRunsMatch[1]));
        json(res, result.ok ? 200 : (result.status || 502), result.ok ? { runs: result.data.runs || [] } : { error: result.error }, { "x-request-id": ctx.requestId });
        return;
      }

      const automationTestMatch = pathname.match(/^\/api\/lead-agents\/admin\/automations\/([^/]+)\/test$/);
      if (automationTestMatch && req.method === "POST") {
        authorizePermission(authContext, "tasks.manage");
        const id = decodeURIComponent(automationTestMatch[1]);
        const result = await callOyiCoreTestAutomation(config, id);
        if (result.ok) {
          await appendAudit(store, authContext, "automation_run_now", "automation", id, {});
        }
        json(res, result.ok ? 200 : (result.status || 502), result.ok ? { run: result.data.run } : { error: result.error }, { "x-request-id": ctx.requestId });
        return;
      }

      const workflowItemMatch = pathname.match(/^\/api\/lead-agents\/admin\/workflows\/([^/]+)$/);
      if (workflowItemMatch && req.method === "GET") {
        authorizePermission(authContext, "tasks.read");
        const result = await callOyiCoreGetWorkflow(config, decodeURIComponent(workflowItemMatch[1]));
        json(res, result.ok ? 200 : (result.status || 502), result.ok ? { workflow: result.data.workflow, events: result.data.events || [] } : { error: result.error }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/workflows" && req.method === "GET") {
        authorizePermission(authContext, "tasks.read");
        const requestUrl = new URL(req.url, "http://localhost");
        const result = await callOyiCoreListWorkflows(config, { limit: requestUrl.searchParams.get("limit") || undefined });
        json(res, result.ok ? 200 : (result.status || 502), result.ok ? { workflows: result.data.workflows || [] } : { error: result.error }, { "x-request-id": ctx.requestId });
        return;
      }

      const officeOperatingMatch = pathname.match(/^\/api\/lead-agents\/admin\/office\/(projects|portfolio|support|private|partnerships|meetings)$/);
      if (officeOperatingMatch) {
        const collection = officeOperatingMatch[1];
        const policy = CORPORATE_COLLECTIONS[collection];
        if (req.method === "GET") {
          authorizePermission(authContext, policy.permission);
          const records = await listCorporateRecords(store, collection);
          let collectionOut = records;
          if (collection === "portfolio") {
            const [backendProjection, facilityWorkspaces] = await Promise.all([
              fetchBackendPortfolioProjection(config),
              store.listFacilityWorkspacesByPortfolioIds(records.map((r) => r.id)).catch(() => []),
            ]);
            collectionOut = await attachPortfolioOperationalProjections(records, backendProjection, facilityWorkspaces);
          }
          json(res, 200, { collection: collectionOut }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, policy.manage);
          const body = await readJsonBody(req);
          requireObject(body, "body");
          if (collection === "private" || collection === "partnerships") {
            await validateOperationalRelationships(store, authContext, collection, body);
          }
          const record = await createCorporateRecord(store, collection, body, { actorEmail: authContext?.email || "office" });
          await appendAudit(store, authContext, `office_${collection}_created`, collection, record.id, {
            business_unit: record.business_unit,
            status: record.status,
          });
          await notifyRecipients(store, eventBus, {
            recipientEmails: notificationTargetsForRecord(collection, record),
            actorEmail: authContext?.email,
            type: `${collection}_created`,
            summary: notificationSummaryForRecord(collection, "created", record),
            relatedType: collection,
            relatedId: record.id,
          });
          json(res, 201, { record }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      const financialSummaryMatch = pathname.match(/^\/api\/lead-agents\/admin\/office\/financial-summary$/);
      if (financialSummaryMatch) {
        if (req.method === "GET") {
          authorizePermission(authContext, "financial.read");
          const requestUrl = new URL(req.url, "http://localhost");
          const estateId = requestUrl.searchParams.get("estate_id") || null;
          const periodDaysRaw = requestUrl.searchParams.get("period_days");
          const periodDays = periodDaysRaw ? Number(periodDaysRaw) : null;
          const summary = await fetchBackendFinancialSummary(config, {
            estateId,
            periodDays: Number.isFinite(periodDays) ? periodDays : null,
          });
          json(res, 200, summary, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET");
        return;
      }

      const officeOperatingItemMatch = pathname.match(/^\/api\/lead-agents\/admin\/office\/(projects|portfolio|support|private|partnerships|meetings)\/([^/]+)$/);
      if (officeOperatingItemMatch) {
        const [, collection, id] = officeOperatingItemMatch;
        const policy = CORPORATE_COLLECTIONS[collection];
        if (req.method === "PATCH") {
          authorizePermission(authContext, policy.manage);
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const result = await updateOperationalRecord(store, collection, decodeURIComponent(id), body, {
            authContext,
            actorEmail: authContext?.email || "office",
          });
          await appendAudit(store, authContext, `office_${collection}_updated`, collection, result.record.id, {
            status: result.record.status,
            allowed_status_transitions: result.allowed_status_transitions,
          });
          await notifyRecipients(store, eventBus, {
            recipientEmails: notificationTargetsForRecord(collection, result.record),
            actorEmail: authContext?.email,
            type: `${collection}_updated`,
            summary: notificationSummaryForRecord(collection, "updated", result.record),
            relatedType: collection,
            relatedId: result.record.id,
          });
          json(res, 200, result, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "PATCH");
        return;
      }

      const relatedActivityMatch = pathname.match(/^\/api\/lead-agents\/admin\/office\/activities\/([^/]+)\/([^/]+)$/);
      if (relatedActivityMatch) {
        const [, relatedType, relatedId] = relatedActivityMatch;
        if (req.method === "GET") {
          await validateRelatedObject(store, authContext, decodeURIComponent(relatedType), decodeURIComponent(relatedId));
          const activities = await listRelatedActivities(store, authContext, decodeURIComponent(relatedType), decodeURIComponent(relatedId));
          json(res, 200, { collection: activities }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "POST") {
          if (!canCreateActivityForRelatedObject(authContext, decodeURIComponent(relatedType))) {
            authorizePermission(authContext, "crm.manage");
          }
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const activity = await createRelatedActivity(store, {
            ...body,
            related_type: decodeURIComponent(relatedType),
            related_id: decodeURIComponent(relatedId),
          }, { authContext, actorEmail: authContext?.email || "office" });
          await appendAudit(store, authContext, "office_activity_created", activity.related_type || "activity", activity.related_id || activity.id, {
            activity_type: activity.activity_type,
          });
          json(res, 201, { record: activity }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      if (pathname === "/api/lead-agents/admin/office/handoffs") {
        if (req.method === "GET") {
          if (!hasPermission(authContext, "office.read") && !hasPermission(authContext, "support.read")) {
            authorizePermission(authContext, "office.read");
          }
          const queue = await listHandoffQueue(store, authContext, { status: url.searchParams.get("status") || "" });
          json(res, 200, { queue }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, "office.manage");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const handoff = await createOrUpdateHandoff(store, body);
          await appendAudit(store, authContext, "office_handoff_created", "communications_handoff", handoff.handoff_id, {
            business_unit: handoff.business_unit,
            requested_capability: handoff.requested_capability,
            media_mode: handoff.media_mode,
          });
          json(res, 201, { handoff }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      const handoffDetailMatch = pathname.match(/^\/api\/lead-agents\/admin\/office\/handoffs\/([^/]+)$/);
      if (handoffDetailMatch) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        if (!hasPermission(authContext, "office.read") && !hasPermission(authContext, "support.read")) {
          authorizePermission(authContext, "office.read");
        }
        const [handoff] = (await listHandoffQueue(store, authContext, {})).filter((item) => item.handoff_id === decodeURIComponent(handoffDetailMatch[1]));
        if (!handoff) {
          notFound(res);
          return;
        }
        json(res, 200, { handoff }, { "x-request-id": ctx.requestId });
        return;
      }

      const handoffActionMatch = pathname.match(/^\/api\/lead-agents\/admin\/office\/handoffs\/([^/]+)\/(accept|decline|assign|callback)$/);
      if (handoffActionMatch) {
        const [, handoffId, action] = handoffActionMatch;
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        const body = await readJsonBody(req);
        const handoff = await updateHandoff(store, authContext, decodeURIComponent(handoffId), action, body || {});
        await appendAudit(store, authContext, `office_handoff_${action}`, "communications_handoff", handoff.handoff_id, {
          status: handoff.status,
          assigned_staff_id: handoff.assigned_staff_id,
        });
        await createCorporateRecord(store, "activities", {
          activity_type: `handoff_${action}`,
          title: `Handoff ${action}`,
          body: handoff.reason,
          business_unit: handoff.business_unit,
          related_type: "handoff",
          related_id: handoff.handoff_id,
          metadata: {
            communications_session_id: handoff.communications_session_id,
            public_session_id: handoff.public_session_id,
          },
        }, { actorEmail: authContext?.email || "office" });
        json(res, 200, { handoff }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/office/documents/draft") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "documents.generate");
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const pricing = validateCommercialDocumentDraft(body);
        const record = await createCorporateRecord(store, "activities", {
          activity_type: "document_draft_requested",
          title: body.title || "Commercial document draft",
          body: pricing.allowed_to_price
            ? "Commercial draft can use approved pricing truth."
            : "Commercial draft requires staff pricing input before totals can be presented.",
          business_unit: body.business_unit,
          lead_id: body.lead_id,
          opportunity_id: body.opportunity_id,
          metadata: {
            document_type: body.document_type || "proposal",
            pricing,
          },
        }, { actorEmail: authContext?.email || "office" });
        await appendAudit(store, authContext, "office_document_draft_requested", "office_document", record.id, {
          pricing_status: pricing.pricing_status,
        });
        json(res, 202, { draft: record, pricing }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/office/intelligence/chat") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "office.intelligence");
        // Same generous limit as the transcribe route below -- a turn
        // can now carry an attached photo or file as a base64 data URL.
        const body = await readJsonBody(req, 30 * 1024 * 1024);
        requireObject(body, "body");
        if (!body.message || typeof body.message !== "string") {
          json(res, 400, { error: "message is required" });
          return;
        }
        // Additive streaming contract for Office's single processing
        // row. Events describe only real request boundaries observed by
        // this gateway; they never expose model reasoning or timed UI
        // theatre. Existing JSON callers retain the original response.
        const streamsRuntimeStages = /application\/x-ndjson/i.test(String(req.headers.accept || ""));
        let runtimeStageSequence = 0;
        let lastRuntimeStage = "";
        if (streamsRuntimeStages) {
          res.writeHead(200, {
            "content-type": "application/x-ndjson; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
            "x-request-id": ctx.requestId,
          });
          if (typeof res.flushHeaders === "function") res.flushHeaders();
        }
        const emitRuntimeStage = (stage) => {
          if (!streamsRuntimeStages || !stage || stage === lastRuntimeStage) return;
          lastRuntimeStage = stage;
          runtimeStageSequence += 1;
          res.write(`${JSON.stringify({ type: "stage", stage, sequence: runtimeStageSequence, occurred_at: new Date().toISOString() })}\n`);
        };
        const finishRuntimeStream = (payload) => {
          res.end(`${JSON.stringify(payload)}\n`);
        };
        const oyiCoreRequest = await buildOyiCoreOfficeInternalRequest({
          authContext,
          message: body.message,
          body,
          requestId: ctx.requestId,
          store,
          config,
          onStage: emitRuntimeStage,
        });
        const chatStartedAt = Date.now();
        // A photo or file attached to this turn means Backend does a
        // real extra OpenAI analysis call before it even starts
        // orchestrating an answer -- the default 10s chat timeout is
        // sized for text-only turns and is too tight for that combined
        // round-trip, so it's raised only when media is genuinely
        // attached, never as a blanket change to every chat call.
        const hasAttachedMedia = Boolean(oyiCoreRequest.image_data_url || oyiCoreRequest.document_data_url);
        const chatConfig = hasAttachedMedia
          ? { ...config, officeBackendEventTimeoutMs: Math.max(config.officeBackendEventTimeoutMs || 10_000, 45_000) }
          : config;
        const preparesAction = /\b(create|update|send|schedule|automate|follow up with|assign|cancel|move)\b/i.test(body.message);
        emitRuntimeStage(preparesAction ? "preparing_action" : "preparing_summary");
        const oyiCoreResult = await callOyiCoreOfficeInternalConversation(chatConfig, oyiCoreRequest);
        // Agent Observatory (Programme 13) — office_internal previously had
        // zero observability of its own, unlike the older lead-agent
        // runtime.js chat path, which already writes real trace rows.
        // Extends the same existing traces table rather than building a
        // second one.
        if (store.appendTrace) {
          await store.appendTrace({
            type: oyiCoreResult.ok ? "office_internal_chat_completed" : "office_internal_chat_failed",
            agent: "office_internal",
            source: "office",
            request_id: ctx.requestId,
            payload: {
              staff_email: authContext?.email || "",
              latency_ms: Date.now() - chatStartedAt,
              attention_signal: oyiCoreResult.ok ? oyiCoreResult.response.attention_signal || null : null,
              tool_proposal_count: oyiCoreResult.ok ? (oyiCoreResult.response.tool_proposals || []).length : 0,
              failure_reason: oyiCoreResult.ok ? null : oyiCoreResult.reason || "oyi_core_unavailable",
              // Same engagement_mode vocabulary as Ochiga Backend's Oyi
              // communications contract — Office's own internal chat box
              // is text-only today, so this is a real, not fabricated,
              // constant until the Office UI gains its own voice/vision
              // capture and starts sending a real value.
              engagement_mode: body.engagement_mode || "text_conversation",
            },
          }).catch(() => null);
        }
        if (!oyiCoreResult.ok) {
          if (streamsRuntimeStages) {
            emitRuntimeStage("failed");
            finishRuntimeStream({
              type: "error",
              status: 503,
              error: "oyi_core_unavailable",
              message: "Oyi Core is unavailable, so Office Internal intelligence cannot answer from a separate reasoning path.",
            });
            return;
          }
          json(res, 503, {
            error: "oyi_core_unavailable",
            message: "Oyi Core is unavailable, so Office Internal intelligence cannot answer from a separate reasoning path.",
            oyi_core_request: oyiCoreRequest,
          }, { "x-request-id": ctx.requestId });
          return;
        }
        const responsePayload = {
          oyi_core: oyiCoreResult.response,
          proposed_actions: oyiCoreResult.response.tool_proposals || [],
        };
        if (streamsRuntimeStages) {
          emitRuntimeStage("completed");
          finishRuntimeStream({ type: "result", data: responsePayload });
          return;
        }
        json(res, 200, responsePayload, { "x-request-id": ctx.requestId });
        return;
      }

      // Oyi Office Conversational Interaction programme, Phase 9 — voice
      // input. Reuses the SAME canonical transcription capability the
      // public widget's voice input already calls
      // (openaiClient.createTranscription(), Whisper via
      // config.openaiTranscriptionModel) rather than a second speech
      // path -- this route only adds staff authentication/audit
      // attribution on top, mirroring the public /transcribe handler's
      // own validation exactly. The transcript itself re-enters the
      // SAME office/intelligence/chat pipeline as typed text -- Oyi
      // never has a separate "voice conversation" runtime.
      if (pathname === "/api/lead-agents/admin/office/intelligence/transcribe") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "office.intelligence");
        const body = await readJsonBody(req, 30 * 1024 * 1024);
        const audio = parseDataUrl(body.audio_data_url || "");
        if (!audio || !audio.buffer.length) {
          json(res, 400, { error: "audio_data_url is required" }, { "x-request-id": ctx.requestId });
          return;
        }
        if (audio.buffer.length > 25 * 1024 * 1024) {
          json(res, 413, { error: "audio_too_large", max_bytes: 25 * 1024 * 1024 }, { "x-request-id": ctx.requestId });
          return;
        }
        const mimeType = body.mime_type || audio.mimeType || "audio/webm";
        const filename = body.file_name || `oyi-office-voice${extensionForAudioMime(mimeType)}`;
        const durationMs = Number(body.duration_ms || 0);
        if (durationMs && durationMs > 120000) {
          json(res, 413, { error: "audio_too_long", max_duration_ms: 120000 }, { "x-request-id": ctx.requestId });
          return;
        }
        try {
          const transcription = await openaiClient.createTranscription({
            buffer: audio.buffer,
            filename,
            mimeType,
            language: body.language || "en",
            prompt: "Ochiga Office -- CRM, tasks, meetings, automations, portfolio, partnerships, support, and internal staff operations.",
          });
          const transcriptText = String(transcription.text || "").trim();
          await appendAudit(store, authContext, "ai.voice.transcribed", "office_internal_voice", "", { model: config.openaiTranscriptionModel, bytes: audio.buffer.length, mime_type: mimeType, text_length: transcriptText.length }, req);
          json(res, 200, { text: transcriptText, model: config.openaiTranscriptionModel }, { "x-request-id": ctx.requestId });
        } catch (err) {
          log("error", "office_intelligence_transcribe_failed", { request_id: ctx.requestId, error: err?.stack || err?.message || String(err) });
          json(res, err.statusCode && err.statusCode >= 400 ? err.statusCode : 502, { error: "transcription_failed", message: "Unable to transcribe this recording right now." }, { "x-request-id": ctx.requestId });
        }
        return;
      }

      // Oyi Office Intelligence Interaction Repositioning -- speech-out
      // leg of the turn-based Voice Chat shell. Reuses Backend's real
      // synthesizeOyiSpeech() (already proven live on the consumer
      // website's voice turns), never a second speech capability.
      if (pathname === "/api/lead-agents/admin/office/intelligence/speech") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "office.intelligence");
        const body = await readJsonBody(req);
        const speechText = String(body.text || "").trim();
        if (!speechText) {
          json(res, 400, { error: "text is required" }, { "x-request-id": ctx.requestId });
          return;
        }
        const result = await callOyiCoreSpeechSynthesis(config, speechText.slice(0, 4000));
        if (!result.ok) {
          json(res, 502, { error: "speech_synthesis_failed", message: "Oyi couldn't generate speech for that reply right now." }, { "x-request-id": ctx.requestId });
          return;
        }
        json(res, 200, { audio_data_url: result.audio_data_url, mime_type: result.mime_type }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/office/overview") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_reports");
        json(
          res,
          200,
          {
            office: await store.getOfficeSnapshot(),
          },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/events") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_office");
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-request-id": ctx.requestId,
        });
        const removeClient = eventBus.add(res, authContext);
        const heartbeat = setInterval(() => {
          res.write(`event: heartbeat\n`);
          res.write(`data: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
        }, 25000);
        req.on("close", () => {
          clearInterval(heartbeat);
          removeClient();
        });
        return;
      }

      if (pathname === "/api/lead-agents/admin/office/sync") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_office");
        const body = await readJsonBody(req);
        const target = String(body?.target || "all").toLowerCase();
        let result;
        if (target === "facility") {
          result = await officeSync.syncFacility();
        } else if (target === "consumer") {
          result = await officeSync.syncConsumer();
        } else {
          result = await officeSync.syncAll();
        }
        await appendAudit(store, authContext, "office_sync_run", "office_sync", target, {
          target,
          result_summary: result?.collections || result?.results || {},
        });
        eventBus.publish("office.sync", {
          target,
          actor: authContext?.email || "",
          result_summary: result?.collections || result?.results || {},
        });
        json(res, 200, { ok: true, result }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/office/import") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_office");
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const source = String(body.source || "manual").toLowerCase();
        const result = await officeSync.ingestCollections(
          source,
          body.payload || body.collections || body
        );
        await appendAudit(store, authContext, "office_import_ingested", "office_import", source, {
          source,
          collections: result.collections,
        });
        eventBus.publish("office.import", {
          source,
          actor: authContext?.email || "",
          collections: result.collections,
        });
        json(res, 200, { ok: true, result }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/permissions") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_users");
        json(
          res,
          200,
          {
            // canonical_roles is the single source of truth for any UI
            // role picker — Object.keys(ROLE_PERMISSIONS) in permissions.js.
            // `roles` below additionally merges in legacy aliases
            // (admin/founder/operator/sales/viewer) purely so existing
            // permission lookups for already-stored legacy role values
            // keep working; new assignments should only ever use
            // canonical_roles.
            canonical_roles: Object.keys(ROLE_PERMISSIONS),
            roles: {
              ...Object.fromEntries(
                Object.keys(ROLE_PERMISSIONS).map((role) => [role, permissionsForRole(role)])
              ),
              admin: permissionsForRole("admin"),
              founder: permissionsForRole("founder"),
              operator: permissionsForRole("operator"),
              sales: permissionsForRole("sales"),
              viewer: permissionsForRole("viewer"),
            },
            scopes: PERMISSION_KEYS,
            legacy_scopes: permissionsForRole("admin").filter((scope) => !scope.includes(".")),
          },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/integrations") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_integrations");
        json(
          res,
          200,
          {
            integrations: await integrationStatus(config, { digitalTwinRuntime }),
          },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/maps/config") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_estates");
        json(res, 200, { maps: publicMapConfig(config) }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/maps/geocode") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_estates");
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const result = await geocodeOfficeEstates({
          config,
          store,
          force: parseBoolean(body.force, false),
          limit: body.limit,
          country: body.country || "Nigeria",
        });
        await appendAudit(store, authContext, "office_estates_geocoded", "office_maps", "google", {
          provider: "google",
          force: parseBoolean(body.force, false),
          total_candidates: result.total_candidates,
          updated: result.updated,
          failed: result.failed,
        });
        eventBus.publish("office.maps", {
          actor: authContext?.email || "",
          provider: "google",
          updated: result.updated,
          failed: result.failed,
        });
        json(res, 200, { ok: true, result }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/storage") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        const body = await readJsonBody(req, 16 * 1024 * 1024);
        requireObject(body, "body");
        // General file storage stays manage_storage-gated, except two
        // narrow cases: any staff member who can send a message can
        // attach a file to it, and any staff member who can write
        // content can upload that article's featured image — neither
        // needs the broader storage-write capability just for that.
        const PURPOSE_PERMISSION = {
          message_attachment: "messages.send",
          content_featured_image: "content.write",
          development_cover_image: "development.manage",
        };
        authorizePermission(authContext, PURPOSE_PERMISSION[body.purpose] || "manage_storage");
        const storedFile = await storageService.putDataUrl(body);
        const file =
          typeof store.createOfficeFile === "function"
            ? await store.createOfficeFile(storedFile)
            : storedFile;
        await appendAudit(store, authContext, "office_file_uploaded", "office_file", file.id, {
          filename: file.filename,
          mime_type: file.mime_type,
          size: file.size,
          purpose: file.purpose,
        });
        eventBus.publish("office.storage", {
          actor: authContext?.email || "",
          file,
        });
        json(res, 201, { file }, { "x-request-id": ctx.requestId });
        return;
      }

      // Template picker for "New Document" (Phase 7, v2 audit) — the
      // structural templates live in office-document-templates.js;
      // "basic" isn't in that list's render map, it's the existing
      // documentHtml() below, kept as the default for backward
      // compatibility with callers that don't pass template_id at all.
      if (pathname === "/api/lead-agents/admin/documents/templates") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "documents.generate");
        json(res, 200, { templates: listDocumentTemplates() }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/documents/generate") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_documents");
        const body = await readJsonBody(req, 2 * 1024 * 1024);
        requireObject(body, "body");
        if (!body.title) {
          json(res, 400, { error: "title is required" });
          return;
        }
        const id = `doc_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
        const templateHtml = body.template_id && body.template_id !== "basic" ? renderDocumentFromTemplate(body.template_id, config, body) : null;
        const html = templateHtml || documentHtml(config, body);
        const storedHtmlRaw = await storageService.putText({
          purpose: "office_document",
          extension: ".html",
          mime_type: "text/html; charset=utf-8",
          content: html,
          resource_type: "office_document",
          resource_id: id,
        });
        let storedHtml = storedHtmlRaw;
        if (typeof store.createOfficeFile === "function") {
          try {
            storedHtml = await store.createOfficeFile(storedHtmlRaw);
          } catch (error) {
            storedHtml = {
              ...storedHtmlRaw,
              sync_status: "metadata_pending",
              sync_warning: error?.response?.data?.message || error.message || "office_files metadata write failed.",
            };
          }
        }
        const shareToken = crypto.randomBytes(16).toString("hex");
        const documentRecord = await store.createOfficeDocument({
          id,
          title: body.title,
          document_type: body.document_type || body.type || "document",
          status: body.status || "draft",
          owner: authContext?.email || body.owner || "Office",
          related_type: body.related_type || "",
          related_id: body.related_id || "",
          amount: Number(body.amount || body.value || 0),
          currency: body.currency || "NGN",
          html_url: storedHtml.url,
          file_url: storedHtml.url,
          email_to: body.email_to || "",
          share_token: shareToken,
          metadata: {
            recipient: body.recipient || "",
            template_id: body.template_id || "basic",
            generated_format: "printable_html",
            pdf_status: "print_ready",
            source_file_url: body.file_url || "",
          },
        });
        // A staff session URL (storedHtml.url) 401s for anyone without an
        // Office login, and is relative anyway — this is the link that
        // actually works for the external recipient.
        const shareUrl = absoluteUrl(req, `/api/lead-agents/documents/shared/${id}/${shareToken}`);
        documentRecord.share_url = shareUrl;
        if (body.email_to) {
          try {
            const emailDelivery = await sendOfficeEmail(config, {
              to: body.email_to,
              subject: body.email_subject || body.title,
              text: `Ochiga Office generated ${body.document_type || "document"}: ${body.title}\n\n${shareUrl}`,
              html: `<p>Ochiga Office generated <strong>${body.document_type || "document"}</strong>: ${body.title}</p><p><a href="${shareUrl}">Open document</a></p>`,
            });
            documentRecord.email_delivery = emailDelivery;
            // CRM-logged outbound email (Phase 6, v2 audit: email existed
            // only as a delivery mechanism, never as CRM activity). Only
            // when the document is actually tied to a CRM record —
            // nothing to log an activity against otherwise.
            if (emailDelivery?.delivered && body.related_type && body.related_id) {
              await createCorporateRecord(
                store,
                "activities",
                {
                  related_type: body.related_type,
                  related_id: body.related_id,
                  activity_type: "email_sent",
                  title: `Email sent: ${body.title}`,
                  body: `Sent to ${body.email_to}`,
                  source: "office_document",
                  metadata: { document_id: id, document_type: body.document_type || "document" },
                },
                { actorEmail: authContext?.email || "office" }
              ).catch(() => null);
            }
          } catch (error) {
            documentRecord.email_delivery = {
              ok: false,
              error: error.message || "Email delivery failed after the document was generated.",
            };
          }
        }
        await appendAudit(store, authContext, "office_document_generated", "office_document", id, {
          title: body.title,
          document_type: body.document_type || body.type || "document",
          html_url: storedHtml.url,
        });
        eventBus.publish("office.document", {
          actor: authContext?.email || "",
          document: documentRecord,
        });
        await notifyRecipients(store, eventBus, {
          actorEmail: authContext?.email,
          type: "document_created",
          summary: `New document: ${documentRecord.title || body.title || "Untitled"}`,
          relatedType: "document",
          relatedId: documentRecord.id,
        });
        json(res, 201, { document: documentRecord, html_file: storedHtml }, { "x-request-id": ctx.requestId });
        return;
      }

      // ---------------------------------------------------------------
      // Staff messaging (Phase 5) — staff-to-staff only, deliberately
      // never touching the CRM lead/visitor `conversations` table.
      // Reuses existing identity (authContext.email), RBAC
      // (messages.read/messages.send), the fixed realtime hub
      // (Phase 4), the notification pipeline (Phase 4), and the
      // existing file storage service for attachments — the client
      // uploads via POST /admin/storage first and references the
      // resulting file_url here, same as every other attachment path.
      // ---------------------------------------------------------------
      // Minimal staff picker for starting a conversation — deliberately
      // NOT the full Team admin_users list (that stays staff.manage-
      // gated and includes role/status/audit-relevant fields no
      // ordinary staff member needs to see about a colleague just to
      // message them).
      if (pathname === "/api/lead-agents/admin/staff/directory") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "messages.read");
        const users = await store.listAdminUsers();
        const directory = users
          .filter((u) => u.status === "active" && normalizeEmail(u.email) !== normalizeEmail(authContext?.email || ""))
          .map((u) => ({ email: u.email, display_name: u.display_name || u.email, office_position: u.office_position || "" }));
        json(res, 200, { staff: directory }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/staff/conversations") {
        if (req.method === "GET") {
          authorizePermission(authContext, "messages.read");
          const email = normalizeEmail(authContext?.email || "");
          const conversations = await store.listStaffConversationsForStaff(email);
          const enriched = await Promise.all(
            conversations.map(async (conversation) => {
              const participants = await store.listStaffConversationParticipants(conversation.id);
              const messages = await store.listStaffMessages(conversation.id, 1);
              const unread = await store.countUnreadStaffMessages(conversation.id, email);
              return {
                ...conversation,
                participants: participants.map((p) => p.staff_email),
                last_message: messages[messages.length - 1] || null,
                unread_count: unread,
              };
            })
          );
          json(res, 200, { conversations: enriched }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, "messages.send");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const createdBy = normalizeEmail(authContext?.email || "");
          const participantEmails = Array.isArray(body.participant_emails) ? body.participant_emails.map(normalizeEmail).filter(Boolean) : [];
          if (!participantEmails.length) {
            json(res, 400, { error: "participant_emails is required" }, { "x-request-id": ctx.requestId });
            return;
          }
          const type = participantEmails.length === 1 && body.type !== "group" ? "direct" : "group";
          let conversation = null;
          if (type === "direct") {
            conversation = await store.findDirectStaffConversation(createdBy, participantEmails[0]);
          }
          if (!conversation) {
            conversation = await store.createStaffConversation({
              type,
              title: type === "group" ? body.title || null : null,
              createdBy,
              participantEmails,
            });
            await appendAudit(store, authContext, "staff_conversation_created", "staff_conversation", conversation.id, {
              type: conversation.type,
              participants: participantEmails,
            });
          }
          json(res, 201, { conversation }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      const staffConversationMessagesMatch = pathname.match(/^\/api\/lead-agents\/admin\/staff\/conversations\/([^/]+)\/messages$/);
      if (staffConversationMessagesMatch) {
        const conversationId = staffConversationMessagesMatch[1];
        const email = normalizeEmail(authContext?.email || "");
        if (req.method === "GET") {
          authorizePermission(authContext, "messages.read");
          if (!(await store.isStaffConversationParticipant(conversationId, email))) {
            json(res, 403, { error: "forbidden" }, { "x-request-id": ctx.requestId });
            return;
          }
          const messages = await store.listStaffMessages(conversationId, 200);
          json(res, 200, { messages }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, "messages.send");
          if (!(await store.isStaffConversationParticipant(conversationId, email))) {
            json(res, 403, { error: "forbidden" }, { "x-request-id": ctx.requestId });
            return;
          }
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const bodyText = normalizeText(body.body || "");
          const attachments = Array.isArray(body.attachments) ? body.attachments.filter((a) => a && a.file_url) : [];
          if (!bodyText && !attachments.length) {
            json(res, 400, { error: "A message needs body text or at least one attachment." }, { "x-request-id": ctx.requestId });
            return;
          }
          const message = await store.createStaffMessage({
            conversationId,
            senderEmail: email,
            body: bodyText,
            attachments,
          });
          const participants = await store.listStaffConversationParticipants(conversationId);
          const otherEmails = participants.map((p) => p.staff_email).filter((e) => e !== email);
          eventBus.publish(
            "office.message",
            { conversation_id: conversationId, message },
            otherEmails.length ? { recipients: otherEmails } : undefined
          );
          // Guard against notifyRecipients' "no targets = broadcast"
          // fallback — a message with no other participants (shouldn't
          // happen; conversations always have >=2) must never fan out
          // as a broadcast notification.
          if (otherEmails.length) {
            await notifyRecipients(store, eventBus, {
              recipientEmails: otherEmails,
              actorEmail: email,
              type: "staff_message",
              summary: `New message from ${email}${bodyText ? `: ${bodyText.slice(0, 80)}` : " (attachment)"}`,
              relatedType: "staff_conversation",
              relatedId: conversationId,
            });
          }
          json(res, 201, { message }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      const staffConversationReadMatch = pathname.match(/^\/api\/lead-agents\/admin\/staff\/conversations\/([^/]+)\/read$/);
      if (staffConversationReadMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "messages.read");
        const conversationId = staffConversationReadMatch[1];
        const email = normalizeEmail(authContext?.email || "");
        if (!(await store.isStaffConversationParticipant(conversationId, email))) {
          json(res, 403, { error: "forbidden" }, { "x-request-id": ctx.requestId });
          return;
        }
        const marked = await store.markStaffMessagesRead(conversationId, email);
        json(res, 200, { marked_read: marked }, { "x-request-id": ctx.requestId });
        return;
      }

      // ---------------------------------------------------------------
      // Content / Publishing (Phase 8) — writer (content.write) drafts
      // and edits; reviewer (content.review) approves or sends back;
      // publisher (content.publish) publishes/schedules/unpublishes.
      // Sanity stays canonical for public content; this table is only
      // Office's workflow/audit trail. Reuses appendAudit (not a
      // second audit system) and notifyRecipients (Phase 4) for
      // editorial events.
      // ---------------------------------------------------------------
      // ---------------------------------------------------------------
      // Reports + Approvals (Ecosystem Standardization Programme 9).
      // Comments/history reuse the existing crm_activities timeline via
      // RELATED_TYPES.report — no second audit/history engine. Review is
      // reports.review (senior-tier), matching "a useful CEO/super-admin
      // approval/review surface" — no self-review guard is needed since,
      // unlike content, ochiga_staff does NOT hold reports.review at all.
      // ---------------------------------------------------------------
      if (pathname === "/api/lead-agents/admin/reports") {
        if (req.method === "GET") {
          authorizePermission(authContext, "reports.write");
          const url = new URL(req.url, "http://localhost");
          const reports = await store.listOfficeReports({ status: url.searchParams.get("status") || undefined });
          json(res, 200, { reports }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, "reports.write");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          if (!body.title) {
            json(res, 400, { error: "title is required" }, { "x-request-id": ctx.requestId });
            return;
          }
          if (body.related_type) {
            await validateRelatedObject(store, authContext, body.related_type, body.related_id);
          }
          const report = await store.createOfficeReport({ ...body, author: authContext?.email || "office" });
          await appendAudit(store, authContext, "report_submitted", "office_report", report.id, { title: report.title });
          await notifyRecipients(store, eventBus, {
            actorEmail: authContext?.email,
            type: "report_submitted",
            summary: `New report submitted: ${report.title}`,
            relatedType: "report",
            relatedId: report.id,
          });
          json(res, 201, { report }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      const reportItemMatch = pathname.match(/^\/api\/lead-agents\/admin\/reports\/([^/]+)$/);
      if (reportItemMatch) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "reports.write");
        const report = await store.getOfficeReportById(reportItemMatch[1]);
        if (!report) {
          notFound(res);
          return;
        }
        json(res, 200, { report }, { "x-request-id": ctx.requestId });
        return;
      }

      const reportDecisionMatch = pathname.match(/^\/api\/lead-agents\/admin\/reports\/([^/]+)\/(approve|reject)$/);
      if (reportDecisionMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "reports.review");
        const [, reportId, decision] = reportDecisionMatch;
        const report = await store.getOfficeReportById(reportId);
        if (!report) {
          notFound(res);
          return;
        }
        if (report.status !== "submitted") {
          json(res, 400, { error: `Cannot ${decision} a report with status "${report.status}".` }, { "x-request-id": ctx.requestId });
          return;
        }
        const body = await readJsonBody(req).catch(() => ({}));
        const updated = await store.updateOfficeReport(reportId, {
          status: decision === "approve" ? "approved" : "rejected",
          reviewer: authContext?.email || "office",
          decision_note: body.decision_note || "",
          decided_at: new Date().toISOString(),
        });
        await appendAudit(store, authContext, `report_${decision}d`, "office_report", reportId, { title: report.title });
        await notifyRecipients(store, eventBus, {
          actorEmail: authContext?.email,
          type: `report_${decision}d`,
          summary: `Report ${decision === "approve" ? "approved" : "rejected"}: ${report.title}`,
          relatedType: "report",
          relatedId: reportId,
        });
        json(res, 200, { report: updated }, { "x-request-id": ctx.requestId });
        return;
      }

      // ---------------------------------------------------------------
      // Development Management (Ecosystem Standardization Programme 11).
      // Manages only the status/progress/core-metadata fields that
      // actually change as construction progresses — the hand-authored
      // multi-chapter tour narrative on the public website stays in
      // code, unmanaged. Syncs to Sanity's developmentProject schema
      // using the same adapter pattern as Content/Publishing.
      // ---------------------------------------------------------------
      if (pathname === "/api/lead-agents/admin/development-projects") {
        if (req.method === "GET") {
          authorizePermission(authContext, "development.manage");
          const projects = await store.listDevelopmentProjects();
          json(res, 200, { projects }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, "development.manage");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          if (!body.name || !body.slug) {
            json(res, 400, { error: "name and slug are required" }, { "x-request-id": ctx.requestId });
            return;
          }
          const project = await store.createDevelopmentProject({ ...body, created_by: authContext?.email || "office" });
          await appendAudit(store, authContext, "development_project_created", "office_development_project", project.id, { name: project.name });
          json(res, 201, { project }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      const developmentProjectMatch = pathname.match(/^\/api\/lead-agents\/admin\/development-projects\/([^/]+)$/);
      if (developmentProjectMatch) {
        const projectId = developmentProjectMatch[1];
        if (req.method === "GET") {
          authorizePermission(authContext, "development.manage");
          const project = await store.getDevelopmentProjectById(projectId);
          if (!project) {
            notFound(res);
            return;
          }
          json(res, 200, { project }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "PATCH") {
          authorizePermission(authContext, "development.manage");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const patch = {};
          [
            "name",
            "slug",
            "type_line",
            "location",
            "status",
            "one_liner",
            "status_stages",
            "status_active_index",
            "display_order",
            "cover_image_url",
            "cover_image_alt",
          ].forEach((field) => {
            if (body[field] !== undefined) patch[field] = body[field];
          });
          const project = await store.updateDevelopmentProject(projectId, patch);
          if (!project) {
            notFound(res);
            return;
          }
          await appendAudit(store, authContext, "development_project_edited", "office_development_project", projectId, { fields: Object.keys(patch) });
          json(res, 200, { project }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,PATCH");
        return;
      }

      const developmentProjectSyncMatch = pathname.match(/^\/api\/lead-agents\/admin\/development-projects\/([^/]+)\/sync$/);
      if (developmentProjectSyncMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "development.manage");
        const projectId = developmentProjectSyncMatch[1];
        const project = await store.getDevelopmentProjectById(projectId);
        if (!project) {
          notFound(res);
          return;
        }
        const syncResult = await syncDevelopmentProjectToSanity(project, { baseUrl: config.officePublicBaseUrl });
        const updated = syncResult.ok
          ? await store.updateDevelopmentProject(projectId, { sanity_document_id: syncResult.document_id, published: true })
          : project;
        await appendAudit(store, authContext, "development_project_synced", "office_development_project", projectId, { ok: syncResult.ok, reason: syncResult.reason });
        json(res, 200, { project: updated, sanity: syncResult }, { "x-request-id": ctx.requestId });
        return;
      }

      const developmentProjectUnpublishMatch = pathname.match(/^\/api\/lead-agents\/admin\/development-projects\/([^/]+)\/unpublish$/);
      if (developmentProjectUnpublishMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "development.manage");
        const projectId = developmentProjectUnpublishMatch[1];
        const project = await store.getDevelopmentProjectById(projectId);
        if (!project) {
          notFound(res);
          return;
        }
        if (!project.sanity_document_id) {
          json(res, 200, { project, sanity: { ok: false, reason: "not_synced" } }, { "x-request-id": ctx.requestId });
          return;
        }
        const unpublishResult = await unpublishFromSanity(project.sanity_document_id);
        const updated = unpublishResult.ok ? await store.updateDevelopmentProject(projectId, { published: false }) : project;
        await appendAudit(store, authContext, "development_project_unpublished", "office_development_project", projectId, { ok: unpublishResult.ok, reason: unpublishResult.reason });
        json(res, 200, { project: updated, sanity: unpublishResult }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/content") {
        if (req.method === "GET") {
          authorizePermission(authContext, "content.write");
          const url = new URL(req.url, "http://localhost");
          const items = await store.listContentItems({ status: url.searchParams.get("status") || undefined });
          json(res, 200, { items }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, "content.write");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          if (!body.title) {
            json(res, 400, { error: "title is required" }, { "x-request-id": ctx.requestId });
            return;
          }
          const item = await store.createContentItem({ ...body, slug: body.slug || slugify(body.title), created_by: authContext?.email || "office" });
          const sanityResult = await saveDraftToSanity(item).catch(() => ({ ok: false }));
          const updated = sanityResult.ok
            ? await store.updateContentItem(item.id, { sanity_document_id: sanityResult.document_id, metadata: { ...item.metadata, sanity_warnings: sanityResult.warnings } })
            : item;
          await appendAudit(store, authContext, "content_created", "office_content_item", item.id, { title: item.title });
          json(res, 201, { item: updated, sanity: sanityResult }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      const contentItemMatch = pathname.match(/^\/api\/lead-agents\/admin\/content\/([^/]+)$/);
      if (contentItemMatch) {
        const contentId = contentItemMatch[1];
        if (req.method === "GET") {
          authorizePermission(authContext, "content.write");
          const item = await store.getContentItemById(contentId);
          if (!item) {
            notFound(res);
            return;
          }
          json(res, 200, { item }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "PATCH") {
          authorizePermission(authContext, "content.write");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const patch = {};
          ["title", "slug", "excerpt", "category", "author", "tags", "body", "featured_image_url", "seo_title", "seo_description"].forEach((field) => {
            if (body[field] !== undefined) patch[field] = body[field];
          });
          const item = await store.updateContentItem(contentId, patch);
          if (!item) {
            notFound(res);
            return;
          }
          const sanityResult = await saveDraftToSanity(item).catch(() => ({ ok: false }));
          if (sanityResult.ok) await store.updateContentItem(contentId, { sanity_document_id: sanityResult.document_id, metadata: { ...item.metadata, sanity_warnings: sanityResult.warnings } });
          await appendAudit(store, authContext, "content_edited", "office_content_item", contentId, { fields: Object.keys(patch) });
          json(res, 200, { item: await store.getContentItemById(contentId), sanity: sanityResult }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,PATCH");
        return;
      }

      const contentActionMatch = pathname.match(/^\/api\/lead-agents\/admin\/content\/([^/]+)\/(submit-review|request-changes|approve|publish|schedule|unpublish)$/);
      if (contentActionMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        const [, contentId, action] = contentActionMatch;
        const item = await store.getContentItemById(contentId);
        if (!item) {
          notFound(res);
          return;
        }
        const body = await readJsonBody(req).catch(() => ({}));

        if (action === "submit-review") {
          authorizePermission(authContext, "content.write");
          if (item.workflow_status !== "draft") {
            json(res, 400, { error: `Cannot submit for review from status "${item.workflow_status}".` }, { "x-request-id": ctx.requestId });
            return;
          }
          const updated = await store.updateContentItem(contentId, { workflow_status: "in_review" });
          await appendAudit(store, authContext, "content_submitted_for_review", "office_content_item", contentId, { title: item.title });
          await notifyRecipients(store, eventBus, { actorEmail: authContext?.email, type: "content_submitted", summary: `"${item.title}" submitted for review`, relatedType: "content", relatedId: contentId });
          json(res, 200, { item: updated }, { "x-request-id": ctx.requestId });
          return;
        }

        if (action === "request-changes") {
          authorizePermission(authContext, "content.review");
          if (item.workflow_status !== "in_review") {
            json(res, 400, { error: `Cannot request changes from status "${item.workflow_status}".` }, { "x-request-id": ctx.requestId });
            return;
          }
          // Separation of duties: a writer who also happens to hold
          // content.review (the only real option while there's no
          // dedicated "editor" role) still cannot review their own
          // work — the review step would otherwise be a rubber stamp.
          // Senior staff who also hold content.publish are exempt,
          // since that permission already lets them bypass the
          // workflow entirely if truly needed.
          if (normalizeEmail(item.created_by) === normalizeEmail(authContext?.email || "") && !hasPermission(authContext, "content.publish")) {
            json(res, 403, { error: "You cannot review your own draft. Ask another reviewer." }, { "x-request-id": ctx.requestId });
            return;
          }
          const updated = await store.updateContentItem(contentId, { workflow_status: "draft", reviewed_by: authContext?.email || "" });
          await appendAudit(store, authContext, "content_changes_requested", "office_content_item", contentId, { note: body.note || "" });
          await notifyRecipients(store, eventBus, {
            recipientEmails: [item.created_by],
            actorEmail: authContext?.email,
            type: "content_changes_requested",
            summary: `Changes requested on "${item.title}"${body.note ? `: ${body.note}` : ""}`,
            relatedType: "content",
            relatedId: contentId,
          });
          json(res, 200, { item: updated }, { "x-request-id": ctx.requestId });
          return;
        }

        if (action === "approve") {
          authorizePermission(authContext, "content.review");
          if (item.workflow_status !== "in_review") {
            json(res, 400, { error: `Cannot approve from status "${item.workflow_status}".` }, { "x-request-id": ctx.requestId });
            return;
          }
          if (normalizeEmail(item.created_by) === normalizeEmail(authContext?.email || "") && !hasPermission(authContext, "content.publish")) {
            json(res, 403, { error: "You cannot approve your own draft. Ask another reviewer." }, { "x-request-id": ctx.requestId });
            return;
          }
          const updated = await store.updateContentItem(contentId, { workflow_status: "approved", approved_by: authContext?.email || "" });
          await appendAudit(store, authContext, "content_approved", "office_content_item", contentId, { title: item.title });
          json(res, 200, { item: updated }, { "x-request-id": ctx.requestId });
          return;
        }

        if (action === "publish") {
          authorizePermission(authContext, "content.publish");
          if (!["approved", "scheduled"].includes(item.workflow_status)) {
            json(res, 400, { error: `Cannot publish from status "${item.workflow_status}". Approve it first.` }, { "x-request-id": ctx.requestId });
            return;
          }
          if (!sanityConfigured()) {
            json(res, 503, { error: "Sanity is not configured (SANITY_PROJECT_ID/SANITY_DATASET/SANITY_API_WRITE_TOKEN)." }, { "x-request-id": ctx.requestId });
            return;
          }
          const draftResult = await saveDraftToSanity(item);
          const docId = draftResult.document_id || item.sanity_document_id || `post-${item.id}`;
          const publishResult = await publishToSanity(docId);
          if (!publishResult.ok) {
            json(res, 502, { error: `Sanity publish failed: ${publishResult.reason || "unknown error"}` }, { "x-request-id": ctx.requestId });
            return;
          }
          const liveUrl = `${process.env.OCHIGA_WEBSITE_URL || "https://ochiga.com.ng"}/insights/${item.slug || slugify(item.title)}`;
          const updated = await store.updateContentItem(contentId, {
            workflow_status: "published",
            published_by: authContext?.email || "",
            sanity_document_id: docId,
            sanity_live_url: liveUrl,
          });
          await appendAudit(store, authContext, "content_published", "office_content_item", contentId, { title: item.title, sanity_document_id: docId, live_url: liveUrl });
          await notifyRecipients(store, eventBus, { actorEmail: authContext?.email, type: "content_published", summary: `"${item.title}" is now live`, relatedType: "content", relatedId: contentId });
          json(res, 200, { item: updated, sanity: publishResult, warnings: draftResult.warnings }, { "x-request-id": ctx.requestId });
          return;
        }

        if (action === "schedule") {
          authorizePermission(authContext, "content.publish");
          if (item.workflow_status !== "approved") {
            json(res, 400, { error: `Cannot schedule from status "${item.workflow_status}". Approve it first.` }, { "x-request-id": ctx.requestId });
            return;
          }
          if (!body.scheduled_publish_at) {
            json(res, 400, { error: "scheduled_publish_at is required" }, { "x-request-id": ctx.requestId });
            return;
          }
          const updated = await store.updateContentItem(contentId, { workflow_status: "scheduled", scheduled_publish_at: body.scheduled_publish_at });
          await appendAudit(store, authContext, "content_scheduled", "office_content_item", contentId, { scheduled_publish_at: body.scheduled_publish_at });
          json(res, 200, { item: updated }, { "x-request-id": ctx.requestId });
          return;
        }

        if (action === "unpublish") {
          authorizePermission(authContext, "content.publish");
          if (item.workflow_status !== "published") {
            json(res, 400, { error: `Cannot unpublish from status "${item.workflow_status}".` }, { "x-request-id": ctx.requestId });
            return;
          }
          const result = await unpublishFromSanity(item.sanity_document_id || `post-${item.id}`);
          if (!result.ok) {
            json(res, 502, { error: `Sanity unpublish failed: ${result.reason || "unknown error"}` }, { "x-request-id": ctx.requestId });
            return;
          }
          const updated = await store.updateContentItem(contentId, { workflow_status: "unpublished" });
          await appendAudit(store, authContext, "content_unpublished", "office_content_item", contentId, { title: item.title });
          json(res, 200, { item: updated }, { "x-request-id": ctx.requestId });
          return;
        }
      }

      const officeAssetActionMatch = pathname.match(
        /^\/api\/lead-agents\/admin\/office\/assets\/(estate|building|device)\/([^/]+)\/action$/
      );
      if (officeAssetActionMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        const kind = officeAssetActionMatch[1];
        const assetId = decodeURIComponent(officeAssetActionMatch[2]);
        const permission =
          kind === "estate" ? "manage_estates" : kind === "building" ? "manage_buildings" : "manage_devices";
        authorizePermission(authContext, permission);
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const action = String(body.action || "").trim().toLowerCase();
        if (!action) {
          json(res, 400, { error: "action is required" });
          return;
        }
        if (!["pause", "suspend", "disable", "enable", "reset", "assign"].includes(action)) {
          json(res, 400, { error: "unsupported_action" });
          return;
        }
        const updated = await store.updateOfficeAsset(kind, assetId, assetPatchForAction(kind, action, {
          ...body,
          actor: authContext?.email || "",
        }));
        if (!updated) {
          notFound(res);
          return;
        }
        await appendAudit(store, authContext, `office_${kind}_${action}`, kind, assetId, {
          action,
          reason: body.reason || "",
          patch_target: "office_table",
        });
        eventBus.publish("office.asset", {
          actor: authContext?.email || "",
          kind,
          action,
          asset: updated,
        });
        json(res, 200, { ok: true, kind, action, asset: updated }, { "x-request-id": ctx.requestId });
        return;
      }

      // Public — deliberately not behind authorizePermission. Gated by
      // the per-document share_token instead of a staff session, so a
      // document emailed to an external lead/client is actually openable
      // by them. See isPublicDocumentSharePath above.
      const documentShareMatch = pathname.match(/^\/api\/lead-agents\/documents\/shared\/([^/]+)\/([^/]+)$/);
      if (documentShareMatch) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        const [, sharedDocId, providedToken] = documentShareMatch;
        const doc = typeof store.getOfficeDocumentById === "function" ? await store.getOfficeDocumentById(sharedDocId) : null;
        if (!doc || !doc.share_token || !secureCompare(doc.share_token, providedToken)) {
          notFound(res);
          return;
        }
        const servedUrl = doc.html_url || doc.file_url || "";
        const rawFilename = servedUrl.split("/").pop();
        if (!rawFilename) {
          notFound(res);
          return;
        }
        const filename = path.basename(decodeURIComponent(rawFilename));
        const shareObject = await storageService.getObject(filename);
        if (!shareObject) {
          notFound(res);
          return;
        }
        serveBuffer(res, shareObject.buffer, shareObject.mimeType, filename);
        return;
      }

      const storageMatch = pathname.match(/^\/api\/lead-agents\/admin\/storage\/([^/]+)$/);
      if (storageMatch) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_storage");
        const filename = path.basename(decodeURIComponent(storageMatch[1]));
        const storedObject = await storageService.getObject(filename);
        if (!storedObject) {
          notFound(res);
          return;
        }
        serveBuffer(res, storedObject.buffer, storedObject.mimeType, filename);
        return;
      }

      const officeCollectionRoutes = {
        "/api/lead-agents/admin/office/packages": "listOfficePackages",
        "/api/lead-agents/admin/office/estates": "listOfficeEstates",
        "/api/lead-agents/admin/office/buildings": "listOfficeBuildings",
        "/api/lead-agents/admin/office/homes": "listOfficeHomes",
        "/api/lead-agents/admin/office/devices": "listOfficeDevices",
        "/api/lead-agents/admin/office/wallets": "listOfficeWallets",
        "/api/lead-agents/admin/office/analytics": "listOfficeAnalytics",
        "/api/lead-agents/admin/office/documents": "listOfficeDocuments",
        "/api/lead-agents/admin/office/support-mappings": "listOfficeSupportMappings",
      };
      if (officeCollectionRoutes[pathname]) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_reports");
        const methodName = officeCollectionRoutes[pathname];
        const collection = typeof store[methodName] === "function" ? await store[methodName]() : [];
        json(
          res,
          200,
          {
            collection,
          },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/channels") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_reports");
        json(
          res,
          200,
          await buildChannelOverview(store, config),
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/audit") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_audit");
        json(
          res,
          200,
          { audit: await store.listAuditEvents(200) },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/ai/operations") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const operations = await fetchBackendAiOperations(config);
        json(res, 200, { ai_operations: operations }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/users") {
        if (req.method === "GET") {
          authorizePermission(authContext, "view_users");
          json(
            res,
            200,
            {
              users: (await store.listAdminUsers()).map(sanitizeAdminUser),
            },
            { "x-request-id": ctx.requestId }
          );
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, "manage_users");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          if (!body.email || !body.password) {
            json(res, 400, { error: "email and password are required" });
            return;
          }
          const user = await store.ensureAdminUser({
            email: normalizeEmail(body.email),
            password_hash: hashPassword(body.password),
            role: requireKnownRole(body.role || "viewer"),
            display_name: body.display_name || body.email,
            office_position: body.office_position || "",
            phone: body.phone || "",
            status: body.status || "active",
            passport_photo_url: body.passport_photo_url || "",
            qr_credential: body.qr_credential || "",
            permission_scopes: Array.isArray(body.permission_scopes) ? body.permission_scopes : [],
          });
          await appendAudit(store, authContext, "admin_user_created", "admin_user", user.id, {
            email: user.email,
            role: user.role,
          });
          eventBus.publish("office.staff", {
            action: "created",
            actor: authContext?.email || "",
            user: {
              id: user.id,
              email: user.email,
              role: user.role,
              status: user.status,
            },
          });
          json(res, 201, { user: sanitizeAdminUser(user) }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      if (pathname === "/api/lead-agents/admin/users/qr") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_users");
        const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const svg = qrSvg(requestUrl.searchParams.get("data") || "ochiga-office", { size: 144 });
        res.writeHead(200, {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "private, max-age=300",
          "x-request-id": ctx.requestId,
        });
        res.end(svg);
        return;
      }

      if (pathname === "/api/lead-agents/admin/users/invite") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_security");
        const body = await readJsonBody(req);
        requireObject(body, "body");
        if (!body.email) {
          json(res, 400, { error: "email is required" });
          return;
        }
        const rawToken = generateOpaqueToken();
        const normalizedEmail = normalizeEmail(body.email);
        const invitedRole = requireKnownRole(body.role || "viewer");
        const existingUser = await store.getAdminUserByEmail(normalizedEmail);
        if (existingUser && existingUser.status !== "invited") {
          json(res, 409, { error: "staff_already_exists", message: "An Office account already exists for this email." });
          return;
        }
        const pendingInvites = (await store.listAdminInvites()).filter((item) =>
          normalizeEmail(item.email) === normalizedEmail && item.status === "pending"
        );
        for (const pending of pendingInvites) {
          await store.updateAdminInvite(pending.id, { status: "superseded" });
        }
        const staffUser = existingUser || await store.ensureAdminUser({
          email: normalizedEmail,
          password_hash: hashPassword(generateOpaqueToken()),
          role: invitedRole,
          display_name: body.display_name || normalizedEmail,
          office_position: body.office_position || "",
          phone: body.phone || "",
          status: "invited",
        });
        if (existingUser) {
          await store.updateAdminUser(existingUser.id, {
            role: invitedRole,
            display_name: body.display_name || existingUser.display_name,
            office_position: body.office_position || existingUser.office_position,
            phone: body.phone || existingUser.phone || "",
          });
        }
        const invite = await store.createAdminInvite({
          email: normalizedEmail,
          admin_user_id: staffUser.id,
          role: invitedRole,
          display_name: body.display_name || "",
          office_position: body.office_position || "",
          phone: body.phone || "",
          token_hash: hashOpaqueToken(rawToken),
          status: "pending",
          invited_by: authContext?.email || "",
          expires_at: new Date(Date.now() + (Number(body.expires_in_hours || 72) * 60 * 60 * 1000)).toISOString(),
        });
        const inviteUrl = absoluteUrl(req, "/office?mode=invite", rawToken, config);
        const inviteMessage = staffInviteEmail({
          displayName: invite.display_name || invite.email,
          inviteUrl,
          role: invite.role,
        });
        const emailDelivery = await sendOfficeEmail(config, {
          to: invite.email,
          ...inviteMessage,
        });
        await appendAudit(store, authContext, "admin_invite_created", "admin_invite", invite.id, {
          email: invite.email,
          role: invite.role,
          email_delivery: emailDelivery,
        });
        eventBus.publish("office.staff", {
          action: "invited",
          actor: authContext?.email || "",
          invite: {
            id: invite.id,
            email: invite.email,
            role: invite.role,
            status: invite.status,
            email_delivery: emailDelivery,
          },
        });
        json(
          res,
          201,
          {
            invite: {
              id: invite.id,
              admin_user_id: invite.admin_user_id,
              email: invite.email,
              role: invite.role,
              status: invite.status,
              expires_at: invite.expires_at,
            },
            invite_url: inviteUrl,
            email_delivery: emailDelivery,
          },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      const adminUserMatch = pathname.match(/^\/api\/lead-agents\/admin\/users\/([^/]+)$/);
      if (adminUserMatch) {
        if (req.method !== "PATCH") {
          methodNotAllowed(res, "PATCH");
          return;
        }
        authorizePermission(authContext, "manage_users");
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const patch = {};
        if (body.display_name !== undefined) patch.display_name = body.display_name;
        if (body.office_position !== undefined) patch.office_position = body.office_position;
        if (body.phone !== undefined) patch.phone = body.phone;
        if (body.role !== undefined) patch.role = requireKnownRole(body.role);
        if (body.status !== undefined) patch.status = body.status;
        if (body.passport_photo_url !== undefined) patch.passport_photo_url = body.passport_photo_url;
        if (body.qr_credential !== undefined) patch.qr_credential = body.qr_credential;
        if (Array.isArray(body.permission_scopes)) patch.permission_scopes = body.permission_scopes;
        if (body.password) {
          patch.password_hash = hashPassword(body.password);
          patch.password_changed_at = new Date().toISOString();
        }
        const user = await store.updateAdminUser(adminUserMatch[1], patch);
        if (!user) {
          notFound(res);
          return;
        }
        await appendAudit(store, authContext, "admin_user_updated", "admin_user", user.id, patch);
        eventBus.publish("office.staff", {
          action: "updated",
          actor: authContext?.email || "",
          user: {
            id: user.id,
            email: user.email,
            role: user.role,
            status: user.status,
          },
        });
        json(res, 200, { user: sanitizeAdminUser(user) }, { "x-request-id": ctx.requestId });
        return;
      }

      const adminUserPhotoMatch = pathname.match(/^\/api\/lead-agents\/admin\/users\/([^/]+)\/photo$/);
      if (adminUserPhotoMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_users");
        const body = await readJsonBody(req);
        requireObject(body, "body");
        let passportPhotoUrl = body.passport_photo_url || "";
        if (!passportPhotoUrl && body.photo_data_url) {
          const storedPhotoRaw = await storageService.putDataUrl({
            data_url: body.photo_data_url,
            purpose: "staff_photo",
            mime_type: body.mime_type,
            resource_type: "staff",
            resource_id: adminUserPhotoMatch[1],
          });
          const storedPhoto =
            typeof store.createOfficeFile === "function"
              ? await store.createOfficeFile(storedPhotoRaw)
              : storedPhotoRaw;
          passportPhotoUrl = storedPhoto.url;
        }
        if (!passportPhotoUrl) {
          json(res, 400, { error: "passport_photo_url or photo_data_url is required" });
          return;
        }
        const user = await store.updateAdminUser(adminUserPhotoMatch[1], {
          passport_photo_url: passportPhotoUrl,
        });
        if (!user) {
          notFound(res);
          return;
        }
        await appendAudit(store, authContext, "admin_user_photo_updated", "admin_user", user.id, {
          email: user.email,
        });
        eventBus.publish("office.staff", {
          action: "photo_updated",
          actor: authContext?.email || "",
          user: {
            id: user.id,
            email: user.email,
            passport_photo_url: user.passport_photo_url,
          },
        });
        json(res, 200, { user: sanitizeAdminUser(user) }, { "x-request-id": ctx.requestId });
        return;
      }

      const adminUserResetMatch = pathname.match(/^\/api\/lead-agents\/admin\/users\/([^/]+)\/reset$/);
      if (adminUserResetMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_security");
        const user = await store.getAdminUserById(adminUserResetMatch[1]);
        if (!user) {
          notFound(res);
          return;
        }
        const body = await readJsonBody(req);
        const rawToken = generateOpaqueToken();
        const reset = await store.createPasswordResetToken({
          admin_user_id: user.id,
          email: user.email,
          token_hash: hashOpaqueToken(rawToken),
          requested_by: authContext?.email || "",
          expires_at: new Date(Date.now() + (Number(body?.expires_in_hours || 24) * 60 * 60 * 1000)).toISOString(),
        });
        const resetUrl = absoluteUrl(req, "/office?mode=reset", rawToken, config);
        const resetMessage = passwordResetEmail({
          displayName: user.display_name || user.email,
          resetUrl,
        });
        const emailDelivery = await sendOfficeEmail(config, {
          to: user.email,
          ...resetMessage,
        });
        await appendAudit(store, authContext, "password_reset_issued", "admin_user", user.id, {
          email: user.email,
          reset_id: reset.id,
          email_delivery: emailDelivery,
        });
        eventBus.publish("office.staff", {
          action: "password_reset_issued",
          actor: authContext?.email || "",
          user: {
            id: user.id,
            email: user.email,
          },
          email_delivery: emailDelivery,
        });
        json(
          res,
          201,
          {
            reset,
            reset_token: rawToken,
            reset_url: resetUrl,
            email_delivery: emailDelivery,
          },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      notFound(res);
    } catch (err) {
      if (err?.statusCode === 403 || err?.message === "forbidden") {
        try {
          await appendAudit(
            store,
            authContext,
            "permission.denied",
            "route",
            pathname,
            { method: req.method },
            req,
            "denied"
          );
          eventBus.publish("audit.recorded", {
            action: "permission.denied",
            route: pathname,
            actor: authContext?.email || "",
          });
        } catch (_) {}
      }
      log("error", "lead_agents_server.request_failed", {
        request_id: ctx.requestId,
        method: req.method,
        pathname,
        error: err?.stack || err?.message || String(err),
        upstream_status: err?.response?.status,
        upstream_data: config.environment === "production" ? undefined : err?.response?.data,
      });

      json(
        res,
        err.statusCode || 500,
        {
          error: err.message || "internal_server_error",
          upstream_status: err?.response?.status,
          upstream_data: config.environment === "production" ? undefined : err?.response?.data,
          request_id: ctx.requestId,
        },
        { "x-request-id": ctx.requestId }
      );
    }
  });
}

async function start() {
  const config = createConfig();
  validateConfig(config);

  const store = createStore(config);
  await store.init();
  await bootstrapAdminUser(store, config);

  const openaiClient = new OpenAIResponsesClient(config);
  const webhooks = new WebhookDispatcher({ config });
  const whatsappAdapter = new WhatsAppCloudAdapter(config);
  const toolExecutor = new ToolExecutor({ store, config, log, webhooks });
  const rateLimiter = new MemoryRateLimiter({
    windowMs: config.rateLimitWindowMs,
    maxRequests: config.rateLimitMaxRequests,
  });
  const publicRateLimiter = new MemoryRateLimiter({
    windowMs: config.publicWidgetRateLimitWindowMs,
    maxRequests: config.publicWidgetRateLimitMaxRequests,
  });
  const officeRateLimiter = new MemoryRateLimiter({
    windowMs: config.officeRateLimitWindowMs,
    maxRequests: config.officeRateLimitMaxRequests,
  });
  const loginRateLimiter = new MemoryRateLimiter({
    windowMs: config.loginRateLimitWindowMs,
    maxRequests: config.loginRateLimitMaxAttempts,
  });

  const server = buildServer({
    config,
    store,
    rateLimiter,
    publicRateLimiter,
    officeRateLimiter,
    loginRateLimiter,
    whatsappAdapter,
    openaiClient,
    toolExecutor,
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  log("info", "lead_agents_server.started", {
    host: config.host,
    port: config.port,
    store_path: config.storePath,
    store_driver: config.storeDriver,
    model: config.openaiModel,
  });

  const shutdown = () => {
    log("info", "lead_agents_server.stopping");
    server.close(() => {
      log("info", "lead_agents_server.stopped");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

module.exports = {
  buildServer,
  start,
};
