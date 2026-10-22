require("dotenv").config();
require("dotenv").config({ path: ".env.lead-agents.local", override: true });
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const axios = require("axios");
const { createConfig } = require("./config");
const { log } = require("./logger");
const { validateAuthConfig } = require("./auth-config");
const { validateMfaConfig } = require("./mfa-config");
const { createMfaCrypto, challengeSubject } = require("./mfa-crypto");
const { createWebauthn, MAX_CREDENTIALS: MAX_WEBAUTHN_CREDENTIALS } = require("./mfa-webauthn");
const { validateWebauthnConfig } = require("./webauthn-config");
const { validatePassword, passwordPolicyError } = require("./password-policy");
const { resolveSessionTtl } = require("./session-policy");
const { effectiveGeneration, revocationEnabled, checkSessionGeneration } = require("./session-generation");
// counters only (never audited per request: a replayed stolen cookie would flood the audit store); exposed by category through /healthz
const revokedSessionRejections = {};
const { resolveEnforcement, accountRequirement, enrollmentNotice, requirementForUser, runPreflight, invalidateEnforcementCache, ENFORCEMENT_LEVELS, applyBreakGlass, recoverySummary } = require("./mfa-enforcement");
const { STEP_UP_PURPOSES, STEP_UP_HEADER, stepUpEligibility, issueStepUpToken, verifyStepUpToken, grantSatisfiesMfa } = require("./step-up");
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
  authenticateSessionCookie,
  verifyPassword,
  verifyPasswordOrDummy,
  newSessionId,
  sessionIdDigest,
} = require("./auth");
const { MemoryRateLimiter } = require("./rate-limit");
const { SharedRateLimiter } = require("./shared-rate-limit");
const { resolveClientAddress } = require("./client-address");
const { issuePublicSession, publicRequestIdentity } = require("./public-session-authority");
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
  callOyiCoreIntelligenceCapabilities,
  callOyiCoreIntelligenceSummary,
  callOyiCoreIntelligenceOverview,
  callOyiCoreIntelligenceInterventions,
  callOyiCoreIntelligenceWorkers,
  callOyiCoreIntelligenceWorkerDetail,
  callOyiCoreIntelligenceGoals,
  callOyiCoreIntelligenceGoalDetail,
  callOyiCoreIntelligenceDecisions,
  callOyiCoreIntelligenceDecisionDetail,
  callOyiCoreIntelligenceActions,
  callOyiCoreIntelligenceActionDetail,
  callOyiCoreIntelligenceKnowledge,
  callOyiCoreIntelligenceKnowledgeDetail,
  callOyiCoreIntelligenceMemoryContext,
  callOyiCoreIntelligenceLearning,
  callOyiCoreIntelligenceProviders,
  callOyiCoreIntelligenceTraces,
  callOyiCoreIntelligenceTraceDetail,
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
  deleteCorporateRecord,
  findCorporateRecord,
  findOpportunityRecord,
  listHandoffQueue,
  listRelatedActivities,
  persistCorporateRecord,
  requestHandoffForLead,
  transitionOpportunity,
  updateHandoff,
  updateOperationalRecord,
  validateOperationalRelationships,
  validateRelatedObject,
} = require("./office-operational-workflows");
// Oyi Communications Convergence, Slice 4 -- DEFAULT_CAPABILITIES is the
// SAME catalog chooseStaffForHandoff() already matches against (Slice
// 3). Exposed read-only here so Team routing settings never hardcodes a
// second copy of this vocabulary in the frontend.
const { DEFAULT_CAPABILITIES } = require("./communications-handoff");
const { WhatsAppCloudAdapter } = require("./whatsapp");
const { buildProviderStatusResponse } = require("./intelligence-providers");
const { resolveDocumentBrandName } = require("./document-brand");
const { resolveDocumentLocale, formatDocumentDate } = require("./document-locale");
const { createSettingsRegistry } = require("./settings-registry");
const { handleSettingsRequest } = require("./settings-api");
const { handleSettingsOperations } = require("./settings-operations");
const { evaluateAutonomousWhatsAppPolicy, readWhatsAppAutonomySetting, verifyStaffConfirmedSend, describeWhatsAppAutonomyStatus, WHATSAPP_AUTONOMY_SETTING_KEY } = require("./whatsapp-autonomy");
const { resolveRecipient, resolveRecipientByEntity } = require("./recipient-resolution");
const { buildCalendarLinks, parsePreferredSchedule } = require("./scheduling");
const { buildProposal, inferCommercialFacts } = require("./commercial");
const { PIPELINE_STAGES, qualifyLead } = require("./commercial-ops");
const { createDigitalTwinRuntime } = require("./digital-twin");
const { createPlanStudioRuntime } = require("./plan-studio");
const { createOfficeSyncService } = require("./office-sync");
const { appendAuditRecord } = require("./audit");
const { PERMISSION_KEYS, ROLE_PERMISSIONS, hasPermission } = require("./permissions");
const relationshipWorkspace = require("./relationship-workspace");
const signatureStats = require("./webhook-signature-stats");
const inboundVisibility = require("./whatsapp-inbound-visibility");
const communicationOutbox = require("./communication-outbox");
const { performManualSend, reconcileManualSends, resolveManualSend } = require("./manual-whatsapp-send");
const { recallCrmMemory } = require("./crm-memory-access");
const { createRealtimeHub } = require("./realtime");
const { createStorageService } = require("./storage");
const {
  mfaMailboxCodeEmail,
  mfaSecurityEmail,
  facilityOwnerInviteEmail,
  passwordResetEmail,
  sendOfficeEmail,
  staffInviteEmail,
} = require("./email");
const { provisionBackendFacility, resendBackendFacilityOwnerInvite, revokeBackendFacilityOwnerInvite, deleteBackendFacilityEstate } = require("./backend-facility-provisioning-gateway");
const { credentialPayloadForUser, qrSvg } = require("./qr");
const {
  createRequestContext,
  getPathname,
  json,
  externalErrorBody,
  methodNotAllowed,
  notFound,
  readJsonBody,
  readJsonBodyWithRaw,
  readRawBodyBuffer,
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
  const ip = req.clientAddress || req.socket.remoteAddress || "unknown"; // R6: from the trusted-proxy boundary, never the raw header
  return `${normalizeEmail(email) || "unknown"}:${ip}`;
}

// R8: an issuance lifetime must be a plain number of hours in a sane range; anything else is a client error, never an "Invalid time value" 500.
function expiryHours(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const hours = typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) {
    const error = new Error("expires_in_hours must be a number between 1 and 720");
    error.statusCode = 400;
    throw error;
  }
  return hours;
}

function requireObject(body, name) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error(`${name} must be an object`);
    error.statusCode = 400;
    throw error;
  }
}

// Wave 8 Slice 4 prerequisite -- the Opportunity transition authority is
// wired into three EXISTING Lead-scoped routes as a purely additive side
// effect. An Opportunity-side rejection (an invalid stage transition,
// e.g. a caller marking "commercial_approved" before "proposal_sent" was
// ever reached) must never fail the underlying Lead write these routes
// already perform -- that write is the one this task explicitly requires
// to keep working unchanged (Section 14). Failures here are surfaced in
// the response's own opportunity_transition field, not thrown.
async function safeTransitionOpportunity(store, input, context) {
  try {
    return await transitionOpportunity(store, input, context);
  } catch (error) {
    return { opportunity: null, activity: null, applied: false, reason: "error", error: error.message };
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
      // not /auth/facility-invite. Must use facilityAppUrl (the actual
      // facility-oyi frontend) -- officeFacilityBaseUrl is a different,
      // pre-existing config group for Office->Backend's own facility-
      // export API surface, not a user-facing origin at all.
      const activationLink = `${config.facilityAppUrl}/facility-invite?token=${encodeURIComponent(provisioning.activation_token)}`;
      // facilityOwnerInviteEmail (like staffInviteEmail) only builds
      // content (subject/text/html) -- it never sets `to`. The caller
      // must attach the persisted invited email to the send envelope
      // itself, exactly like the staff-invite path already does
      // ({ to: invite.email, ...inviteMessage }). This call previously
      // passed the template's return value straight through with no `to`
      // at all, so sendOfficeEmail always saw an empty recipient and
      // failed every Facility owner invitation with missing_recipient.
      const emailResult = await sendOfficeEmail(config, {
        to: input.facilityAdminEmail,
        ...facilityOwnerInviteEmail({ estateName: input.estateName, inviteUrl: activationLink, expiresAt: provisioning.invite?.expires_at }),
      }).catch((err) => ({ delivered: false, skipped: true, reason: err?.message || "email_send_failed" }));
      // Token/invite creation and actual email delivery are two different
      // facts -- a rotated, valid, activatable invite must never be
      // labeled the same as one that was actually emailed. Distinct
      // status values so the UI's plain status label is honest without
      // extra rendering logic, and the real, non-secret failure reason
      // (a short code like "email_provider_not_configured", or the
      // provider's own error text -- never a key/credential value) is
      // kept on the workspace so a delivery failure is diagnosable from
      // data instead of guesswork.
      workspaceUpdate = await store.updateFacilityWorkspace(workspace.id, {
        status: emailResult.delivered ? "invitation_sent" : "invitation_undelivered",
        activation_link: activationLink,
        checklist: {
          ...(workspace.checklist || {}),
          customer_organization: "created",
          estate_or_building_record: "created",
          facility_admin_invite: emailResult.delivered ? "sent" : "ready_to_send",
          deployment_project: input.leadId ? "linked" : "not_applicable",
          onboarding_email: emailResult.delivered ? "sent" : "not_delivered",
        },
        notes: emailResult.delivered
          ? workspace.notes
          : `Invitation created and valid, but the owner email was not delivered (${emailResult.reason || "unknown reason"}, provider: ${emailResult.provider || config.officeEmailProvider || "none"}). Fix delivery, then use Resend Invite -- do not re-provision.`,
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
      <div class="brand">${escapeHtmlText(config.officeDocumentBrandName)}</div>
      <h1>${safeTitle}</h1>
      <div>${type} · ${formatDocumentDate(new Date(), config.officeDocumentLocale, "short")}</div>
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

// Corporate Letterhead body sanitizer — defense in depth. The editor is
// staff-only and already strips the same patterns client-side before
// saving, but this is a corporate document other staff (and, via a
// share link, external recipients) view in their own browser, so the
// server never trusts client-side sanitization alone.
function sanitizeLetterheadBodyHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '$1="#"');
}

// Server-side mirror of the client renderer (public/office/office.js
// renderLetterheadPage) — this project has no shared bundler between
// the browser and Node, so this small, self-contained duplicate is the
// established pattern (see documentHtml above) rather than new build
// tooling. Used for the public share route and print/export, so a
// document without a stored file still has a real, working share link
// and a real downloadable page.
function renderLetterheadHtml(doc, req) {
  const snapshot = doc.metadata?.letterhead_snapshot || {};
  const logoUrl = absoluteUrl(req, snapshot.logo_url || "/office/brand/ochiga-logo-light.png");
  const bodyHtml = sanitizeLetterheadBodyHtml(doc.body || "");
  const contactRow = [
    snapshot.website ? `<span>${escapeHtmlText(snapshot.website)}</span>` : "",
    snapshot.email ? `<span>${escapeHtmlText(snapshot.email)}</span>` : "",
    snapshot.whatsapp ? `<span>${escapeHtmlText(snapshot.whatsapp)}</span>` : "",
    snapshot.social_handle ? `<span>${escapeHtmlText(snapshot.social_handle)}</span>` : "",
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtmlText(doc.title || "Letter")}</title>
  <style>
    body{font-family:Georgia,'Times New Roman',serif;margin:0;background:#e8eaee;color:#1a1a1a}
    .page{max-width:800px;margin:24px auto;background:#ffffff;padding:56px 64px;box-shadow:0 1px 4px rgba(0,0,0,0.15);position:relative;overflow:hidden;min-height:1050px}
    .page::before{content:"";position:absolute;top:-40px;right:-60px;width:340px;height:180px;background:linear-gradient(135deg,rgba(240,90,60,0.12),rgba(240,90,60,0.04));border-radius:50%;pointer-events:none}
    .letter-logo{height:44px;display:block}
    .letter-tagline{font-family:Arial,sans-serif;font-size:12px;color:#555;margin:6px 0 0}
    .letter-body{margin:48px 0 64px;font-size:15px;line-height:1.7}
    .letter-body p{margin:0 0 14px}
    .letter-footer{border-top:2px solid #e2453a;padding-top:14px;font-family:Arial,sans-serif;font-size:11px;color:#333;margin-top:auto}
    .letter-footer .contact-row{margin-bottom:4px}
    .letter-footer .address-row{color:#666}
    @media print { body{background:#fff} .page{box-shadow:none;margin:0} }
  </style>
</head>
<body>
  <main class="page">
    <header>
      <img class="letter-logo" src="${escapeHtmlText(logoUrl)}" alt="Ochiga" />
      ${snapshot.tagline ? `<p class="letter-tagline">${escapeHtmlText(snapshot.tagline)}</p>` : ""}
    </header>
    <section class="letter-body">${bodyHtml || "<p>&nbsp;</p>"}</section>
    <footer class="letter-footer">
      <div class="contact-row">${contactRow}</div>
      ${snapshot.address ? `<div class="address-row">${escapeHtmlText(snapshot.address)}</div>` : ""}
    </footer>
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
  // R8: a link that is e-mailed to someone is built from configuration. Only when no canonical origin is configured (development) is the request consulted, and then forwarded host/proto
  // are honoured solely behind a TRUSTED proxy, and a Host header only when it names this machine; anything else would let an attacker steer the link in a victim's mailbox.
  const trusted = Number(config.trustedProxyHops) > 0;
  const rawHost = String((trusted && req.headers["x-forwarded-host"]) || req.headers.host || "localhost").split(",")[0].trim();
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(rawHost);
  const requestHost = trusted || loopback ? rawHost : "localhost";
  const requestProto = trusted ? (String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim() === "https" ? "https" : "http") : "http";
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

  // Unverified email/phone is not CRM ownership. This body has passed
  // publicRequestIdentity and only a signed session can supply lead_id.
  const matchedLead = existing;

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

// OFF / unreadable / takeover: the inbound message is kept as CRM activity and a timeline note records that no reply was sent. The suppressed reply is NOT stored for
// later: switching the setting ON never replays it.
async function suppressAutonomousWhatsAppReply({ store, lead, event, requestId, reason, stage, paused = false }) {
  log("info", "whatsapp_autonomous_reply_suppressed", { request_id: requestId, lead_id: lead.id, reason, stage });
  await store.appendTimelineEvent({
    lead_id: lead.id,
    event_type: "whatsapp_autonomous_reply_suppressed",
    actor: "ochiga_intelligence",
    title: "WhatsApp autonomous reply not sent",
    body: reason === "autonomous_whatsapp_disabled" ? "Autonomous WhatsApp responses are switched off in Office settings." : reason === "setting_unreadable" ? "The autonomous-response setting could not be read, so no reply was sent." : ["claim_unavailable", "no_provider_message_id", "reply_already_sent"].includes(reason) ? "The message could not be safely de-duplicated, or a reply was already sent, so no automatic reply was sent." : "A human has taken over this conversation.",
    metadata: { request_id: requestId, reason, stage },
  }).catch(() => null);
  // The customer's message already has its canonical CRM record (written on intake, independent of any reply decision); this only records WHY no reply was sent.
  await inboundVisibility.annotateInboundActivity(store, { lead, event, requestId, patch: { ai_replied: false, suppressed_reason: reason }, log });
  return { kind: "message", lead_id: lead.id, suppressed: true, reason, ...(paused ? { paused: true } : {}) };
}

// message ids currently being processed in this process (a concurrent retry of the same Meta delivery must not draw a second reply)
const inflightWhatsAppMessageIds = new Set();

async function processWhatsAppEvent({ event, store, adapter, config, requestId }) {
  if (event.kind === "status") {
    const statusEventRow = await store.appendInboundEvent({
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
      // Durable delivery to Backend (communication outbox): first attempt inline, retried in the background with replay semantics if Backend is cold or unreachable.
      await communicationOutbox.enqueueAndAttempt(store, config, {
        payload: {
          channel: "whatsapp",
          provider_event_type: "status",
          provider_message_id: event.message_id,
          status: event.status,
          error_code: providerError?.code ?? null,
          error_title: providerError?.title || providerError?.message || null,
          occurred_at: new Date(Number(event.timestamp || 0) * 1000 || Date.now()).toISOString(),
        },
        sourceEventId: statusEventRow?.id || null,
        log,
      });
    }
    return {
      kind: "status",
      message_id: event.message_id,
      status: event.status,
    };
  }

  // Idempotency: the provider message id is CLAIMED first (before any lead is created or reply drafted) in a table whose primary key is the provider id, so a
  // retried or concurrent delivery — on this or any other instance — loses the claim and is acknowledged without a second lead, record or reply.
  // If the claim cannot be made (database error) or the event has no provider id, the message is still stored in the CRM but NO autonomous reply is sent.
  let claim = { status: event.message_id ? "unavailable" : "no_message_id", reply_sent: false };
  if (event.message_id) {
    if (inflightWhatsAppMessageIds.has(event.message_id)) return { kind: "message", duplicate: true };
    try {
      claim = await store.claimInboundMessage({ providerMessageId: event.message_id, channel: "whatsapp", requestId });
    } catch (error) {
      log("error", "whatsapp_webhook.claim_unavailable", { request_id: requestId, message_id: event.message_id, error: error?.message || String(error) });
      claim = { status: "unavailable", reply_sent: false };
    }
    if (claim.status === "duplicate") {
      log("info", "whatsapp_webhook.duplicate_delivery", { request_id: requestId, message_id: event.message_id });
      return { kind: "message", duplicate: true };
    }
    inflightWhatsAppMessageIds.add(event.message_id);
  }
  try {
    const result = await processWhatsAppMessageEvent({ event, store, adapter, config, requestId, claim });
    if (["claimed", "takeover"].includes(claim.status)) await store.updateInboundClaim(event.message_id, { status: "completed", completed_at: new Date().toISOString() }).catch(() => null);
    return result;
  } finally {
    if (event.message_id) inflightWhatsAppMessageIds.delete(event.message_id);
  }
}

async function processWhatsAppMessageEvent({ event, store, adapter, config, requestId, claim }) {
  const lead = await resolveLeadForChannel(store, event.from, "whatsapp");
  log("info", "whatsapp_webhook.thread_resolved", { request_id: requestId, lead_id: lead.id });
  await store.updateLead(lead.id, {
    whatsapp_phone: event.from,
    primary_channel: "whatsapp",
    channel_last_seen_at: new Date().toISOString(),
  });
  if (["claimed", "takeover"].includes(claim.status)) await store.updateInboundClaim(event.message_id, { lead_id: lead.id }).catch(() => null);
  // A takeover of a stale claim must not store the inbound message a second time.
  const alreadyStored = claim.status === "takeover" ? await store.hasInboundEvent({ channel: "whatsapp", eventType: "message", externalEventId: event.message_id }).catch(() => false) : false;
  let inboundEventRow = null;
  if (!alreadyStored) {
    inboundEventRow = await store.appendInboundEvent({
      channel: "whatsapp",
      provider: "meta",
      event_type: "message",
      lead_id: lead.id,
      external_event_id: event.message_id,
      // the provider's own message object; a normalised fallback keeps the text recoverable if an adapter ever hands over no raw object
      payload: event.raw && typeof event.raw === "object" && Object.keys(event.raw).length ? event.raw : { id: event.message_id, from: event.from, type: event.message_type || "text", timestamp: event.timestamp, text: { body: event.text || "" } },
    });
  }
  // CANONICAL CRM RECORD, written before anything decides whether Oyi replies: OFF, AI paused, human takeover, a Backend goal owning the thread or a failed generation can
  // never hide the customer's message. Idempotent on the provider message id. A failure is logged, flagged on the result and recoverable (the inbound event is stored, the
  // relationship thread reads it directly, and the visibility repair can back-fill the record) -- it never blocks intake and never triggers a send.
  const crmRecord = await inboundVisibility.recordInboundActivity(store, { lead, event, inboundEvent: inboundEventRow, requestId, log });
  if (!crmRecord.ok) {
    await store.appendTimelineEvent({ lead_id: lead.id, event_type: "whatsapp_crm_record_failed", actor: "office", title: "WhatsApp message stored but its CRM record could not be written", body: "The message is safe in the inbound event log and is shown in the conversation; the CRM record can be repaired.", metadata: { request_id: requestId, provider_message_id: event.message_id || null } }).catch(() => null);
  }
  const withCrmStatus = (result) => (crmRecord.ok ? result : { ...result, crm_record_failed: true });
  // Forward the inbound message itself into the Communication Runtime's
  // canonical thread (Phase 5) -- correlated by phone number so it lands
  // in the SAME thread as any prior outbound send to this person.
  let forwardResult = { forwarded: false, goalActive: false };
  if (event.message_id) {
    // Durable delivery to Backend: the first attempt is inline and LIVE (Backend may wake a goal exactly as before, so the single-responder rule below still works);
    // if it fails or times out the entry stays queued and is retried in the background with non-sending replay semantics.
    forwardResult = await communicationOutbox.enqueueAndAttempt(store, config, {
      payload: {
        channel: "whatsapp",
        provider_event_type: "message",
        provider_message_id: event.message_id,
        from: event.from,
        text: event.text || "",
        lead_id: lead.id,
        occurred_at: new Date(Number(event.timestamp || 0) * 1000 || Date.now()).toISOString(),
      },
      sourceEventId: inboundEventRow?.id || null,
      log,
    });
  }

  const channelState = await store.upsertLeadChannelState(lead.id, "whatsapp", {
    customer_service_window_expires_at: customerServiceWindowExpiry(event.timestamp),
    last_external_message_id: event.message_id,
    last_inbound_at: new Date(Number(event.timestamp || 0) * 1000 || Date.now()).toISOString(),
    // human_status is deliberately NOT written here: a customer message must never end an active human takeover (new rows take the stored default "auto").
  });

  if (channelState.ai_paused || ["human_active", "human_review"].includes(channelState.human_status)) {
    await inboundVisibility.annotateInboundActivity(store, { lead, event, inboundEvent: inboundEventRow, requestId, patch: { ai_replied: false, suppressed_reason: ["human_active", "human_review"].includes(channelState.human_status) ? "human_takeover_active" : "ai_paused" }, log });
    return withCrmStatus({
      kind: "message",
      lead_id: lead.id,
      paused: true,
    });
  }

  // Oyi Communications Convergence, Slice 1 -- single-responder rule: an
  // active Goal already watching this thread (Backend, event-driven
  // wake) owns this reply. Deferring here means the SAME inbound message
  // can never draw both Office's direct AI-reply AND a Goal-driven
  // reply -- exactly the concurrency requirement this slice exists to
  // prove. This does not change behaviour for any lead without an
  // active goal (the vast majority of conversations today).
  if (forwardResult.goalActive) {
    await store.appendTimelineEvent({
      lead_id: lead.id,
      event_type: "oyi_core_whatsapp_deferred_to_goal",
      actor: "ochiga_intelligence",
      title: "WhatsApp reply deferred to an active follow-up goal",
      body: "An autonomous follow-up goal is already watching this conversation on Backend; Office did not send a duplicate reply.",
      metadata: { request_id: requestId },
    });
    await inboundVisibility.annotateInboundActivity(store, { lead, event, inboundEvent: inboundEventRow, requestId, patch: { ai_replied: false, suppressed_reason: "deferred_to_goal" }, log });
    return withCrmStatus({
      kind: "message",
      lead_id: lead.id,
      deferred_to_goal: true,
    });
  }

  // An autonomous reply needs an exclusive, healthy claim on this provider message: no claim / no id / a reply already sent by an earlier attempt => no reply.
  const claimBlock = claim.status === "unavailable" ? "claim_unavailable" : claim.status === "no_message_id" ? "no_provider_message_id" : claim.reply_sent ? "reply_already_sent" : null;
  if (claimBlock) return withCrmStatus(await suppressAutonomousWhatsAppReply({ store, lead, event, requestId, reason: claimBlock, stage: "before_generation" }));

  // Global autonomy switch: OFF (or unreadable) means no autonomous reply is generated or sent. The inbound message stays stored and visible in the CRM.
  const earlyPolicy = await evaluateAutonomousWhatsAppPolicy(store);
  if (!earlyPolicy.allowed) {
    return withCrmStatus(await suppressAutonomousWhatsAppReply({ store, lead, event, requestId, reason: earlyPolicy.reason, stage: "before_generation" }));
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
  // The setting and the takeover state are read again IMMEDIATELY before the send: a switch-off or takeover that happened while the reply was being generated wins.
  const sendPolicy = await evaluateAutonomousWhatsAppPolicy(store);
  const freshState = await store.getLeadChannelState(lead.id, "whatsapp").catch(() => null);
  const takeoverNow = !freshState || freshState.ai_paused || ["human_active", "human_review"].includes(freshState.human_status);
  if (!sendPolicy.allowed || takeoverNow) {
    return withCrmStatus(await suppressAutonomousWhatsAppReply({ store, lead, event, requestId, reason: !sendPolicy.allowed ? sendPolicy.reason : "human_takeover_active", stage: "before_send", paused: takeoverNow && sendPolicy.allowed }));
  }

  const sendResult = await adapter.sendTextMessage({
    to: event.from,
    body: assistantMessage,
    contextMessageId: event.message_id,
  });

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

  // The customer's message already has its canonical CRM record (written on intake); record that Oyi replied.
  await inboundVisibility.annotateInboundActivity(store, { lead, event, inboundEvent: inboundEventRow, requestId, patch: { ai_replied: Boolean(sendResult && sendResult.delivered) }, log });

  if (sendResult && sendResult.delivered) await store.updateInboundClaim(event.message_id, { reply_sent_at: new Date().toISOString() }).catch(() => null);
  await store.upsertLeadChannelState(lead.id, "whatsapp", {
    last_outbound_at: new Date().toISOString(),
    last_external_message_id: sendResult.external_message_id || event.message_id,
  });

  return withCrmStatus({
    kind: "message",
    lead_id: lead.id,
    outbound: sendResult,
  });
}

const ADMIN_RECOVERY_MIN_PASSWORD_LENGTH = 12;

// Settings S7.4: signs a session for an account. The generation is re-read immediately before signing, so a revocation that lands in between yields a token that is refused on
// first use (fail-closed) and a revocation that landed earlier yields a token at the new generation. Duration and cookie Max-Age come from the same resolved value (S7.3).
async function issueSession(store, config, sessionUser, { mfaAt } = {}) {
  let account = sessionUser;
  if (revocationEnabled(config)) {
    let fresh;
    try { fresh = await store.getAdminUserById(sessionUser.id); } catch { const e = new Error("session_verification_unavailable"); e.statusCode = 503; throw e; }
    if (!fresh || fresh.status !== "active") { const e = new Error("unauthorized"); e.statusCode = 401; throw e; }
    account = { ...sessionUser, session_generation: fresh.session_generation };
  }
  const ttl = await resolveSessionTtl(store, config, { log });
  // R4: a per-session identifier is added only when its revocation storage exists (otherwise the token is exactly what it was before). A probe that cannot answer is an error, never "no":
  // silently issuing a session that can never be logged out would be a quiet downgrade.
  let sessionId;
  if (typeof store.supportsSessionIdRevocation === "function") {
    let supported;
    try { supported = await store.supportsSessionIdRevocation(); } catch { const e = new Error("session_verification_unavailable"); e.statusCode = 503; throw e; }
    if (supported) sessionId = newSessionId();
  }
  return { token: createAdminSessionToken(account, config, ttl.ttlMs, { mfaAt, sessionId }), ttl };
}

// Settings S7.5.3: with MFA on, is this account bound to a second factor (an ACTIVE credential)? Any failure to find out is a 503 (fail closed), never "no".
async function mfaRequiredFor(store, config, userId) {
  if (config.mfaMode !== "on") return false;
  try {
    if (typeof store.hasActiveMfa !== "function") throw new Error("unsupported");
    return Boolean(await store.hasActiveMfa(userId));
  } catch {
    const error = new Error("mfa_verification_unavailable");
    error.statusCode = 503;
    throw error;
  }
}

const MFA_CHALLENGE_METHODS = ["totp", "recovery_code"];
const MFA_PENDING_TTL_MS = 15 * 60_000; // a pending enrollment expires; beginning again supersedes it
const MFA_FRESH_MS = 5 * 60_000; // a second factor proven this recently counts as fresh for mfa_management

// S7.5.4: the seam read ONLY by "may this account remove its last active factor". It does not affect sign-in. Default: nobody.
// S7.5.5: one assertion check for login and step-up. The challenge is consumed (single use) BEFORE verification; the credential must be one of THIS account's ACTIVE WebAuthn credentials;
// the library verifies origin, RP ID, user presence + verification, signature and counter; then the counter is advanced by an atomic compare-and-set. Returns { ok } or { ok:false, reason };
// throws on faults (store, configuration, library) so callers answer 503 and never fall back.
async function checkWebauthnAssertion({ store, config, user, challengeId, response }) {
  const service = createWebauthn(config);
  if (typeof challengeId !== "string" || !response || typeof response !== "object" || typeof response.id !== "string") return { ok: false, reason: "invalid_request" };
  const consumed = await store.consumeMfaChallenge(user.id, challengeId, "webauthn_authenticate");
  if (!consumed) return { ok: false, reason: "challenge" };
  const wanted = Buffer.from(response.id, "base64url").toString("base64");
  const credential = (await store.listWebauthnCredentialsForAuth(user.id)).find((c) => c.credential_id === wanted);
  if (!credential) return { ok: false, reason: "unknown_credential" };
  let verified;
  try { verified = await service.verifyAuthentication({ response, expectedChallenge: Buffer.from(consumed, "base64").toString("base64url"), credential }); }
  catch (error) { if (error && error.code === "webauthn_verification_failed") return { ok: false, reason: error.category || "verification" }; throw error; }
  if (!(await store.recordWebauthnUse(user.id, credential.id, verified.newCounter))) return { ok: false, reason: "counter_rollback" };
  return { ok: true };
}

const mfaRequiredForRole = (user, config) => Array.isArray(config.mfaRequiredRoles) && config.mfaRequiredRoles.includes(user.role);

// S7.5.4: governed security notification through the existing e-mail infrastructure. Never blocks or fails the operation; the TRUTHFUL outcome is audited (`sent`, `not_configured`,
// `no_recipient`, `failed`). The message names the event and time only: no code, secret, token or hash.
async function notifyMfaEvent({ store, config, user, event, requestId, req }) {
  let delivery = "failed";
  try {
    const sent = await sendOfficeEmail(config, { to: user.email, ...mfaSecurityEmail({ displayName: user.display_name, event, at: new Date().toISOString() }) });
    delivery = sent.delivered ? "sent" : sent.reason === "missing_recipient" ? "no_recipient" : "not_configured";
  } catch { delivery = "failed"; }
  await appendAudit(store, { userId: user.id, email: user.email, role: user.role }, "mfa_notification", "admin_user", user.id, { request_id: requestId, event, delivery, at: new Date().toISOString() }, req, delivery === "sent" ? "success" : "failure").catch(() => {});
  return delivery;
}
function adminSummary(user) {
  return { id: user.id, email: user.email, role: user.role, display_name: user.display_name || user.email, status: user.status || "active", permission_scopes: Array.isArray(user.permission_scopes) ? user.permission_scopes : [], office_position: user.office_position || "", passport_photo_url: user.passport_photo_url || "", qr_credential: user.qr_credential || "", permissions: permissionsForRole(user.role, user.permission_scopes) };
}

// Settings S7.4: revoke every session of `target` with one atomic generation increment, and audit it (category/ids/generations only; never a token, grant, secret or password).
// `required: true` (explicit revocation routes) turns an unavailable capability into a 503. `required: false` (password/status flows) proceeds and audits `skipped`, because those
// flows must stay usable before the migration exists; but if the capability IS available and the increment FAILS, both fail closed (503) so a password is never changed while
// stolen sessions are left alive.
async function revokeSessionsFor({ store, config, target, auditActor, trigger, requestId, req, reason = null, required = false, auditExtra = {} }) {
  const before = effectiveGeneration(target);
  const auditRevocation = (action, status, extra) => appendAudit(store, auditActor, action, "admin_user", target.id, { request_id: requestId, target_user_id: target.id, target_email: target.email, trigger, generation_before: before, at: new Date().toISOString(), ...extra }, req, status);
  const unavailable = async (category) => {
    await auditRevocation(required ? "session_revocation_denied" : "sessions_revocation_skipped", required ? "failure" : "success", { outcome: required ? "unavailable" : "skipped", failure_reason: category });
    if (required) { const e = new Error("session_revocation_unavailable"); e.statusCode = 503; throw e; }
    return { status: "skipped", reason: category };
  };
  if (!revocationEnabled(config)) return unavailable("revocation_disabled");
  let supported;
  try { supported = typeof store.supportsSessionRevocation === "function" ? await store.supportsSessionRevocation() : false; } catch { supported = null; }
  if (supported === false) return unavailable("migration_absent");
  let result;
  try {
    if (supported === null) throw new Error("capability_probe_failed");
    result = await store.revokeAdminSessions(target.id, { actor: auditActor?.email || "", reason });
  } catch (error) {
    await auditRevocation("session_revocation_denied", "failure", { outcome: "failed", failure_reason: "store_error" }).catch(() => {});
    const e = new Error("session_revocation_unavailable"); e.statusCode = 503; throw e;
  }
  if (!result) { const e = new Error("user_not_found"); e.statusCode = 404; throw e; }
  const action = { self: "sessions_revoked_self", admin: "sessions_revoked_by_admin", password_reset: "sessions_revoked_password_reset", password_change: "sessions_revoked_password_change", admin_password_set: "sessions_revoked_admin_password_set", status_change: "sessions_revoked_status_change", admin_recovery: "sessions_revoked_admin_recovery", mfa_recovery_code: "sessions_revoked_mfa_recovery_code" }[trigger] || "sessions_revoked";
  await auditRevocation(action, "success", { outcome: "revoked", generation_after: result.session_generation, reason: typeof reason === "string" ? reason.slice(0, 200) : undefined, ...auditExtra });
  return { status: "revoked", generation_before: before, generation_after: result.session_generation, revoked_at: result.sessions_revoked_at };
}

const REVOCATION_AUDIT_ACTIONS = { self: "sessions_revoked_self", admin: "sessions_revoked_by_admin", password_reset: "sessions_revoked_password_reset", password_change: "sessions_revoked_password_change", admin_password_set: "sessions_revoked_admin_password_set", status_change: "sessions_revoked_status_change", admin_recovery: "sessions_revoked_admin_recovery", mfa_recovery_code: "sessions_revoked_mfa_recovery_code" };

// Settings S7.5.0: apply a credential/status patch (password_hash, password_changed_at, status, removed_at, removed_by only) TOGETHER with the session revocation, as one atomic step
// when the store supports it (single SQL statement / single mutation), otherwise by the S7.4 two-step path, which password binding (`pf`) keeps safe. Fails closed: when revocation
// is available and cannot be applied, nothing changes and the caller gets a 503. Returns { user, status, atomic, generation_after }.
async function applyCredentialChange({ store, config, target, patch, auditActor, trigger, requestId, req }) {
  let atomicSupported = false;
  if (revocationEnabled(config) && typeof store.updateAdminUserRevokingSessions === "function" && typeof store.supportsAtomicCredentialUpdate === "function") {
    try { atomicSupported = await store.supportsAtomicCredentialUpdate(); } catch { atomicSupported = false; }
  }
  if (atomicSupported) {
    const before = effectiveGeneration(target);
    let result;
    try {
      result = await store.updateAdminUserRevokingSessions(target.id, patch, { actor: auditActor?.email || "" });
    } catch {
      await appendAudit(store, auditActor, "session_revocation_denied", "admin_user", target.id, { request_id: requestId, target_user_id: target.id, trigger, outcome: "failed", failure_reason: "store_error", generation_before: before, at: new Date().toISOString() }, req, "failure").catch(() => {});
      const e = new Error("session_revocation_unavailable"); e.statusCode = 503; throw e;
    }
    if (!result) { const e = new Error("user_not_found"); e.statusCode = 404; throw e; }
    await appendAudit(store, auditActor, REVOCATION_AUDIT_ACTIONS[trigger] || "sessions_revoked", "admin_user", target.id, { request_id: requestId, target_user_id: target.id, target_email: target.email, trigger, outcome: "revoked", atomic: true, generation_before: before, generation_after: result.session_generation, at: new Date().toISOString() }, req, "success");
    return { user: result.user, status: "revoked", atomic: true, generation_after: result.session_generation };
  }
  const revocation = await revokeSessionsFor({ store, config, target, auditActor, trigger, requestId, req, auditExtra: { atomic: false } });
  const user = await store.updateAdminUser(target.id, patch);
  return { user, status: revocation.status, atomic: false, generation_after: revocation.generation_after };
}

// Settings S7.5.0: human-account mutations need an accountable person. API keys and edge tokens (machine credentials) are refused, audited by route category only.
async function denyNonHumanActor({ store, authContext, res, ctx, req, category }) {
  if (authContext?.type === "session") return false;
  await appendAudit(store, { type: authContext?.type || "unknown" }, "human_account_change_denied", "admin_user", "", { request_id: ctx.requestId, route_category: category, outcome: "denied", failure_reason: "api_key_not_allowed", at: new Date().toISOString() }, req, "failure").catch(() => {});
  json(res, 403, { error: "actor_identity_required", message: "Account changes need a signed-in person." }, { "x-request-id": ctx.requestId });
  return true;
}

// Settings S7.1: sends the shared 400 and returns true when a new password violates the fixed policy. Carries a code only, never password material.
function rejectPasswordViolation(res, password, ctx) {
  const result = validatePassword(password);
  if (result.valid) return false;
  json(res, 400, passwordPolicyError(result.code), { "x-request-id": ctx.requestId });
  return true;
}

// Settings S7.0 explicit administrator recovery: only when LEAD_AGENTS_ADMIN_RECOVERY=true AND the bootstrap email/password are set. Resets that ONE account's password,
// reactivates it and restores its role; audited by email only. Not reachable over HTTP. See docs/settings-domain/19_S7_0_AUTH_SECURITY_CONTRACT.md section 4.
async function applyAdminRecovery(store, config) {
  const email = normalizeEmail(config.adminEmail);
  const recoveryPolicy = validatePassword(config.adminPassword);
  if (!recoveryPolicy.valid || String(config.adminPassword).length < ADMIN_RECOVERY_MIN_PASSWORD_LENGTH) {
    log("warn", "admin_recovery_refused", { reason: recoveryPolicy.code || "recovery_password_too_short" });
    return { applied: false, reason: recoveryPolicy.code || "recovery_password_too_short" };
  }
  const existing = await store.getAdminUserByEmail(email);
  if (!existing) {
    const created = await store.ensureAdminUser({
      email, password_hash: hashPassword(config.adminPassword), role: config.adminRole || "admin", display_name: email, status: "active",
    });
    await appendAudit(store, { email }, "admin_recovery_applied", "admin_user", created?.id || "", { email, created: true });
    log("warn", "admin_recovery_applied", { email });
    return { applied: true, user: created };
  }
  // S7.4/S7.5.0: whoever held a session for this account before recovery must not keep it; the password reset, reactivation and revocation are one atomic step where supported.
  let updated;
  try {
    ({ user: updated } = await applyCredentialChange({ store, config, target: existing, patch: { password_hash: hashPassword(config.adminPassword), status: "active" }, auditActor: { email }, trigger: "admin_recovery", requestId: "startup" }));
  } catch (error) {
    log("error", "admin_recovery_revocation_failed", { message: error.message });
    updated = await store.updateAdminUser(existing.id, { password_hash: hashPassword(config.adminPassword), status: "active" }); // recovery must still succeed
  }
  updated = (await store.updateAdminUser(existing.id, { role: config.adminRole || "admin" })) || updated;
  await appendAudit(store, { email }, "admin_recovery_applied", "admin_user", existing.id, { email, created: false });
  log("warn", "admin_recovery_applied", { email });
  return { applied: true, user: updated || existing };
}

async function bootstrapAdminUser(store, config) {
  if (!config.adminEmail || !config.adminPassword) {
    return null;
  }
  if (config.adminRecovery === true) {
    return (await applyAdminRecovery(store, config)).user || null;
  }
  return store.ensureAdminUser({
    email: normalizeEmail(config.adminEmail),
    password_hash: hashPassword(config.adminPassword),
    role: config.adminRole || "admin",
    display_name: config.adminEmail,
    status: "active",
  });
}

// R8: routes that act on "my own account" are for a signed-in HUMAN only. An API key or edge token that happens to carry (or collide with) an account's e-mail address is not that person.
function requireHumanSession(authContext) {
  if (!authContext) { const error = new Error("unauthorized"); error.statusCode = 401; throw error; }
  if (authContext.type !== "session" || !authContext.user) {
    const error = new Error("forbidden");
    error.statusCode = 403;
    throw error;
  }
  return authContext;
}

async function enrichAuthContext(authContext, store, config = {}) {
  if (!authContext || authContext.type !== "session") {
    return authContext;
  }
  let user;
  try {
    user = await store.getAdminUserByEmail(authContext.email);
  } catch {
    // Settings S7.4: if the account cannot be loaded the session cannot be verified. Never fail open, never trust the token alone, never leak the store error.
    const error = new Error("session_verification_unavailable");
    error.statusCode = 503;
    throw error;
  }
  if (!user || user.status !== "active") {
    const error = new Error("unauthorized");
    error.statusCode = 401;
    throw error;
  }
  const generation = checkSessionGeneration({ authContext, user, config });
  if (!generation.ok) {
    revokedSessionRejections[generation.reason] = (revokedSessionRejections[generation.reason] || 0) + 1;
    const error = new Error("session_revoked");
    error.statusCode = 401;
    error.reason = generation.reason;
    throw error;
  }
  // R4: a session that was logged out is refused here, whatever else is true of its token. Only tokens that carry a session id are looked up; if the lookup cannot be answered the
  // request FAILS (503): "unknown" is never treated as "not revoked".
  if (authContext.sessionId) {
    let revoked;
    try { revoked = await store.isSessionDigestRevoked(sessionIdDigest(config, authContext.sessionId)); } catch {
      const error = new Error("session_verification_unavailable");
      error.statusCode = 503;
      throw error;
    }
    if (revoked) {
      revokedSessionRejections.logged_out = (revokedSessionRejections.logged_out || 0) + 1;
      const error = new Error("session_revoked");
      error.statusCode = 401;
      error.reason = "logged_out";
      throw error;
    }
  }
  // S7.5.3: one place, so /session/me and every protected route behave alike. An account bound to a second factor needs a session that PROVED it (mf = 1); password-only and
  // legacy cookies of such an account are refused until the person signs in again through the challenge.
  if (config.mfaMode === "on") {
    let required;
    try { required = await mfaRequiredFor(store, config, user.id); } catch { const unavailable = new Error("session_verification_unavailable"); unavailable.statusCode = 503; throw unavailable; }
    if (required && authContext.sessionMfa !== true) {
      revokedSessionRejections.mfa_required = (revokedSessionRejections.mfa_required || 0) + 1;
      const error = new Error("mfa_required");
      error.statusCode = 401;
      error.reason = "mfa_required";
      throw error;
    }
    // S7.5.7: an account WITHOUT a factor that the enforcement level (or an admin reset / break-glass) requires to have one: inside the grace window the session is accepted with a
    // notice; at or after the deadline it ends (the person signs in again and is routed to enrolment). Unreadable policy fails closed.
    if (!required) {
      let requirement;
      try { requirement = await requirementForUser(store, config, user); } catch { const unavailable = new Error("session_verification_unavailable"); unavailable.statusCode = 503; throw unavailable; }
      if (requirement.required && requirement.expired) {
        revokedSessionRejections.mfa_enrollment_required = (revokedSessionRejections.mfa_enrollment_required || 0) + 1;
        const error = new Error("mfa_enrollment_required");
        error.statusCode = 401;
        error.reason = "mfa_enrollment_required";
        throw error;
      }
      if (requirement.required) authContext = { ...authContext, mfaEnrollment: enrollmentNotice(requirement) };
    }
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

function buildServer({ config, store, rateLimiter, publicRateLimiter, officeRateLimiter, loginRateLimiter, whatsappAdapter, openaiClient, toolExecutor, settingsRegistryExtras }) {
  const startedAt = Date.now();
  // Governed Settings registry (S3). `settingsRegistryExtras` is a test seam for generic descriptors; production passes none.
  const settingsRegistry = createSettingsRegistry({ config, extras: Array.isArray(settingsRegistryExtras) ? settingsRegistryExtras : [] });
  const widgetRateLimiter = publicRateLimiter || rateLimiter;
  const officeInternalRateLimiter = officeRateLimiter || rateLimiter;
  const adminLoginRateLimiter =
    loginRateLimiter ||
    new SharedRateLimiter({
      store,
      namespace: "login",
      secret: config.sessionSecret,
      windowMs: config.loginRateLimitWindowMs || 15 * 60 * 1000,
      maxRequests: config.loginRateLimitMaxAttempts || 10,
    });
  // R1 (F-1): failure-only counter per account (normalised e-mail alone), five times the per-address budget over the same window.
  const adminAccountFailureLimiter = new SharedRateLimiter({
    store,
    namespace: "account-failure",
    secret: config.sessionSecret,
    windowMs: adminLoginRateLimiter.windowMs || 15 * 60 * 1000,
    maxRequests: Math.max(1, (adminLoginRateLimiter.maxRequests || 10) * 5),
  });
  // R6 (H4): wrong-password counter for the AUTHENTICATED password prompts (/session/password and step-up), keyed by account id: holding a session cookie must not allow unlimited
  // guessing of the account password, from one address or many. Failures only; cleared by a success.
  const passwordGuessLimiter = new SharedRateLimiter({
    store,
    namespace: "password-guess",
    secret: config.sessionSecret,
    windowMs: adminLoginRateLimiter.windowMs || 15 * 60 * 1000,
    maxRequests: Math.max(1, Number(config.passwordGuessMaxFailures) || 10), // independent of the sign-in budget: a generous login limit must not loosen the account password ceiling
  });
  // R8: password SPRAYING -- one address trying one password against many different accounts never trips a per-(account,address) budget. A failures-only counter per ADDRESS closes that,
  // but only where an address identifies a client: it is on by default behind a trusted proxy (LEAD_AGENTS_TRUSTED_PROXY_HOPS > 0) and off otherwise (every client would share the proxy's
  // address and one attacker could lock everyone out). LEAD_AGENTS_LOGIN_ADDRESS_FAILURE_MAX overrides (0 = off).
  const addressFailureMax = Number.isInteger(config.loginAddressFailureMax) ? config.loginAddressFailureMax : (Number(config.trustedProxyHops) > 0 ? 50 : 0);
  const addressFailureLimiter = addressFailureMax > 0 ? new SharedRateLimiter({ store, namespace: "address-failure", secret: config.sessionSecret, windowMs: adminLoginRateLimiter.windowMs || 15 * 60 * 1000, maxRequests: addressFailureMax }) : null;
  const isRateLimitHit = (error) => Boolean(error && error.statusCode === 429);
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

  let communicationOutboxWorkerHandle = null;
  const server = http.createServer(async (req, res) => {
    req.clientAddress = resolveClientAddress(req, config.trustedProxyHops);
    // the ONE place a request is authenticated and its live account state verified (protected routes and the /healthz detail decision share it)
    const resolveRequestAuth = async () => enrichAuthContext(tryEdgeAuth(req, config) || enforceAuth(req, config), store, config);
    // R8: response hardening that applies to everything. nosniff and a referrer policy always; framing only by the same origin; credential-bearing (admin API) responses are never cached.
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "SAMEORIGIN");
    res.setHeader("content-security-policy", "frame-ancestors 'self'");
    { const earlyPath = getPathname(req); if (earlyPath.startsWith("/api/lead-agents/admin/") && !earlyPath.startsWith("/api/lead-agents/admin/storage/")) { res.setHeader("cache-control", "no-store"); res.setHeader("pragma", "no-cache"); } }
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
        pathname === "/plan-studio/app.js";
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
        pathname === "/office/mfa-ui.mjs" ||
        pathname === "/office/vendor/qrcode-generator.mjs" ||
        pathname === "/office/shared/oyi-core/docking.mjs" ||
        pathname === "/office/shared/oyi-core/presence.mjs" ||
        pathname === "/office/shared/oyi-core/responseNormalizer.mjs" ||
        pathname === "/office/manifest.json" ||
        pathname === "/office/sw.js";
      const isPublicAdminSessionPath =
        pathname === "/api/lead-agents/admin/session/login" ||
        pathname === "/api/lead-agents/admin/session/mfa/verify" ||
        pathname === "/api/lead-agents/admin/session/mfa/webauthn/auth/options" ||
        pathname === "/api/lead-agents/admin/session/mfa/enroll/email-code" ||
        pathname === "/api/lead-agents/admin/session/mfa/enroll/email-verify" ||
        pathname === "/api/lead-agents/admin/session/mfa/enroll/forced/begin" ||
        pathname === "/api/lead-agents/admin/session/mfa/enroll/forced/confirm" ||
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
        pathname === "/api/lead-agents/admin/communications/create-task" ||
        // Oyi Communications Convergence, Slice 2 -- Core's HANDOFF
        // decision has no response channel back to Office on the
        // material-event path (Office never reads that response body),
        // so it needs its own outbound call, mirroring this same
        // Backend->Office bridge WhatsAppAdapter already established.
        pathname === "/api/lead-agents/admin/communications/handoff-request" ||
        // Wave 9 Slice 1 -- Core's own real knowledge retrieval contract
        // (officeKnowledgeBridge.ts) reads Office's raw knowledge/ pack
        // through this route. Read-only; Office remains the sole physical
        // owner of the files, Backend owns all classification/governance
        // (see Ochiga-backend's officeKnowledgeManifest.ts) -- this route
        // never interprets file content, it only serves it.
        pathname === "/api/lead-agents/admin/knowledge-pack";

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
        authContext = await resolveRequestAuth();
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
        const authConfigStatus = validateAuthConfig(config);
        // S7.5.1: MFA readiness. Off by default and then never a readiness concern; with MFA on, an invalid key makes /healthz 503 (codes only, never key material).
        const mfaStatus = validateMfaConfig(config);
        let mfaSchema = "not_checked";
        if (mfaStatus.mode === "on") { try { mfaSchema = typeof store.supportsMfa === "function" ? ((await store.supportsMfa()) ? "available" : "unavailable") : "unavailable"; } catch { mfaSchema = "unknown"; } }
        let mfaEnrolled = null;
        try { if (typeof store.countMfaEnrolledAccounts === "function") mfaEnrolled = await store.countMfaEnrolledAccounts(); } catch { mfaEnrolled = null; }
        let revocationCapability = "unknown";
        try { revocationCapability = typeof store.supportsSessionRevocation === "function" ? ((await store.supportsSessionRevocation()) ? "available" : "unavailable") : "unavailable"; } catch { revocationCapability = "unknown"; }
        const ready = authConfigStatus.valid && mfaStatus.valid && (mfaStatus.mode !== "on" || mfaSchema === "available");
        // R8: readiness and security-posture codes are public (load balancers and operators need them); BUSINESS statistics and the deployment inventory (cookie name, auth mode, e-mail provider,
        // storage and realtime internals) are shown only to a caller who holds a valid session or API key.
        let healthDetail = false;
        try { healthDetail = Boolean(await resolveRequestAuth()); } catch { healthDetail = false; }
        json(res, ready ? 200 : 503, {
          ok: ready,
          ready,
          // R6: where the sign-in counters live. "shared" = Postgres (every instance), "process" = this process only (file store or migration 20261028 not applied), "unavailable" = store error.
          rate_limit: { scope: typeof adminLoginRateLimiter.scope === "function" ? await adminLoginRateLimiter.scope() : "process", trusted_proxy_hops: config.trustedProxyHops, ...(config.trustedProxyHopsInvalid ? { trusted_proxy_hops_config: "invalid_ignored" } : {}) },
          mfa: { mode: mfaStatus.mode, key: mfaStatus.key, schema: mfaSchema, enrolled_accounts: mfaEnrolled, webauthn: (() => { const w = validateWebauthnConfig(config); return { status: w.status, ...(w.problems.length ? { problems: w.problems } : {}) }; })(), recovery: recoverySummary(config), ...(mfaStatus.problems.length ? { problems: mfaStatus.problems } : {}) },
          // codes and mode names only; never a secret or anything derived from one
          auth_config: {
            session_secret: authConfigStatus.session_secret,
            ...(authConfigStatus.valid ? {} : { problems: authConfigStatus.problems }),
            api_key_password_login: config.allowApiKeyPasswordLogin === true ? "enabled_deprecated" : "disabled",
            admin_recovery: config.adminRecovery === true ? "enabled" : "disabled",
            session_ttl: config.sessionTtlStatus || "ok",
          },
          // Revocation only protects against servers that enforce it: during a rolling deploy older instances still accept revoked tokens, so operators should confirm every
          // instance reports enforcement "active" (or rotate the session secret) before relying on a global sign-out.
          session_revocation: {
            enforcement: revocationEnabled(config) ? "active" : "off",
            capability: revocationCapability,
            legacy_tokens: config.rejectLegacySessions === true ? "rejected" : "accepted",
            rejected_requests: { ...revokedSessionRejections },
          },
          uptime_ms: Date.now() - startedAt,
          ...(healthDetail ? { stats: await store.stats() } : {}),
          environment: config.environment,
          store_driver: config.storeDriver,
          // booleans / a mode name only: lets an operator confirm that webhook authentication is enforced without exposing any secret
          whatsapp_webhook: { signature_mode: config.whatsappWebhookSignatureMode === "report" ? "report" : "enforce", app_secret_configured: Boolean(config.metaAppSecret) },
          ...(healthDetail ? { tier1: {
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
            // Presence-only diagnostic for the outbound transactional email
            // path (staff invites, Facility owner invites, password
            // resets all share this one config) -- never the key value
            // itself, only whether it's set, so a "delivery failed" report
            // can be triaged as configuration vs. provider vs. code
            // without needing dashboard access.
            email: {
              provider: config.officeEmailProvider || "none",
              resend_api_key_configured: Boolean(config.resendApiKey),
              from_address: config.officeEmailFrom || null,
            },
          } } : {}),
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
          // 1. the EXACT request bytes (never decoded or re-serialised); 2. authenticate them; 3. only then parse, extract events, touch the CRM or Backend.
          const rawBuffer = await readRawBodyBuffer(req);
          const signatureCheck = whatsappAdapter.verifySignature(rawBuffer, req.headers["x-hub-signature-256"]);
          const signatureMode = config.whatsappWebhookSignatureMode === "report" ? "report" : "enforce";
          signatureStats.record(signatureCheck, { mode: signatureMode, store });
          if (!signatureCheck.ok) {
            log(signatureMode === "enforce" ? "warn" : "error", signatureMode === "enforce" ? "whatsapp_webhook.signature_rejected" : "whatsapp_webhook.signature_failed_REPORT_MODE_PROCESSING_ANYWAY", {
              request_id: ctx.requestId,
              reason: signatureCheck.reason,
              has_signature_header: Boolean(req.headers["x-hub-signature-256"]),
              body_bytes: rawBuffer.length,
              mode: signatureMode,
            });
            if (signatureMode === "enforce") {
              const status = signatureCheck.reason === "app_secret_not_configured" ? 503 : signatureCheck.reason === "signature_mismatch" ? 403 : 401;
              json(res, status, { error: status === 503 ? "webhook_not_configured" : "invalid_signature" }, { "x-request-id": ctx.requestId });
              return;
            }
          }
          let body = {};
          if (rawBuffer.length) {
            try {
              body = JSON.parse(rawBuffer.toString("utf8"));
            } catch (error) {
              json(res, 400, { error: "invalid_json" }, { "x-request-id": ctx.requestId });
              return;
            }
          }
          const events = whatsappAdapter.extractEvents(body);
          log("info", "whatsapp_webhook.received", { request_id: ctx.requestId, event_count: events.length });
          // Observability only (no behaviour change): events addressed to a phone-number id other than the configured official one are counted and logged.
          const foreignPhone = config.whatsappPhoneNumberId ? events.filter((e) => e.metadata?.phone_number_id && String(e.metadata.phone_number_id) !== String(config.whatsappPhoneNumberId)).length : 0;
          if (foreignPhone) { signatureStats.notePhoneMismatch(foreignPhone); log("warn", "whatsapp_webhook.phone_number_id_mismatch", { request_id: ctx.requestId, count: foreignPhone }); }
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
        // Wave 9 Slice 1 -- the knowledge-pack route is read-only (GET);
        // every other bridge route remains POST-only, unchanged.
        const isKnowledgePackPath = pathname === "/api/lead-agents/admin/knowledge-pack";
        if (req.method !== "POST" && !(isKnowledgePackPath && req.method === "GET")) {
          methodNotAllowed(res, isKnowledgePackPath ? "GET" : "POST");
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

        if (isKnowledgePackPath) {
          // Read-only, no interpretation: lists knowledge/*.md (top-level
          // files only -- no subdirectories, no path traversal possible
          // since there is no caller-supplied path input anywhere in this
          // handler) and returns raw filename/content/mtime. Office never
          // classifies or filters this content -- see Ochiga-backend's
          // officeKnowledgeManifest.ts for where that governance lives.
          try {
            const knowledgeDir = path.join(__dirname, "..", "..", "knowledge");
            const entries = fs.readdirSync(knowledgeDir, { withFileTypes: true });
            const files = [];
            for (const entry of entries) {
              if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
              const fullPath = path.join(knowledgeDir, entry.name);
              const content = fs.readFileSync(fullPath, "utf8");
              const stat = fs.statSync(fullPath);
              files.push({ filename: entry.name, content, updated_at: stat.mtime.toISOString() });
            }
            json(res, 200, { ok: true, files }, { "x-request-id": ctx.requestId });
          } catch (error) {
            log("error", "knowledge_pack.read_failed", { request_id: ctx.requestId, error: error?.message || String(error) });
            json(res, 500, { ok: false, error: "knowledge_pack_read_failed" }, { "x-request-id": ctx.requestId });
          }
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

        // Oyi Communications Convergence, Slice 2 -- Core's HANDOFF
        // decision (relationshipCommunicationPolicyForJv) reaches here.
        // requestHandoffForLead() is idempotent (same lead_id with an
        // already-active handoff returns it rather than creating a
        // duplicate), reuses createOrUpdateHandoff/chooseStaffForHandoff
        // unchanged, and pauses automation via the existing
        // lead_channel_states human_status check -- no new handoff
        // system, no new takeover flag.
        if (pathname === "/api/lead-agents/admin/communications/handoff-request") {
          const body = await readJsonBody(req);
          const leadId = String(body.lead_id || "").trim();
          if (!leadId) {
            json(res, 200, { ok: false, error: "missing_lead_id" }, { "x-request-id": ctx.requestId });
            return;
          }
          try {
            const result = await requestHandoffForLead(store, {
              leadId,
              businessUnit: body.business_unit,
              requestedCapability: body.requested_capability,
              reason: body.reason,
              priority: body.priority,
            });
            await appendAudit(store, { userId: null, email: "oyi_core", role: "system" }, "office_handoff_requested_by_core", "communications_handoff", result.handoff.handoff_id, {
              lead_id: leadId,
              created: result.created,
              status: result.handoff.status,
              routing_status: result.routing.status,
            });
            json(res, 200, { ok: true, handoff: result.handoff, created: result.created, routing_status: result.routing.status }, { "x-request-id": ctx.requestId });
          } catch (error) {
            json(res, 200, { ok: false, error: error?.message || "handoff_request_failed" }, { "x-request-id": ctx.requestId });
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
        // Oyi Communications Convergence, Slice 1 -- CRITICAL: Office's
        // lead_channel_states is the single authoritative human-takeover
        // truth (never duplicated in Backend). Every Oyi-generated
        // outbound WhatsApp send -- whether from Office's own AI-reply
        // loop or from Backend's CommunicationRuntime/GoalRuntime -- now
        // funnels through this one bridge route, so this is the one
        // place that truth needs to be enforced to block ALL of them.
        // A fresh read-through on every send, not a cached/mirrored flag.
        // Global autonomy switch (see whatsapp-autonomy.js): a bridge send that is not explicitly declared staff-confirmed is autonomous (Goal runtime, scheduled
        // automation, anything unlabeled) and is refused while the switch is OFF or unreadable. Staff-confirmed sends are governed manual communication and unaffected.
        const staffConfirmation = verifyStaffConfirmedSend(body, config.officeBackendApiKey);
        if (String(body.send_origin || "").trim().toLowerCase() === "staff_confirmed" && !staffConfirmation.confirmed) {
          log("warn", "communication_bridge_staff_origin_rejected", { request_id: ctx.requestId, reason: staffConfirmation.reason, lead_id: String(body.lead_id || "") || null });
          await appendAuditRecord({ store, authContext: null, action: "communication.whatsapp.origin_rejected", resourceType: "communication", resourceId: body.communication_id || "", metadata: { reason: staffConfirmation.reason, source: "communication_runtime_bridge" }, req, status: "failure" }).catch(() => null);
        }
        if (!staffConfirmation.confirmed) {
          const policy = await evaluateAutonomousWhatsAppPolicy(store);
          if (!policy.allowed) {
            log("info", "communication_bridge_send_blocked_autonomy", { request_id: ctx.requestId, reason: policy.reason, lead_id: String(body.lead_id || "") || null });
            await appendAuditRecord({
              store, authContext: null, action: "communication.whatsapp.autonomous_blocked", resourceType: "communication", resourceId: body.communication_id || "",
              metadata: { to_present: Boolean(to), reason: policy.reason, send_origin: String(body.send_origin || "") || "unspecified", origin_verification: staffConfirmation.reason, source: "communication_runtime_bridge" },
              req, status: "failure",
            }).catch(() => null);
            json(res, 200, { ok: false, delivered: false, failure_reason: policy.reason === "setting_unreadable" ? "autonomy_setting_unreadable" : "autonomous_whatsapp_disabled", failure_detail: "Autonomous WhatsApp responses are switched off in Office settings." }, { "x-request-id": ctx.requestId });
            return;
          }
        }
        const leadIdForTakeoverCheck = String(body.lead_id || "").trim();
        if (leadIdForTakeoverCheck) {
          const channelState = await store.getLeadChannelState(leadIdForTakeoverCheck, "whatsapp").catch(() => null);
          if (channelState && (channelState.ai_paused || ["human_active", "human_review"].includes(channelState.human_status))) {
            log("info", "communication_bridge_send_blocked_takeover", { request_id: ctx.requestId, lead_id: leadIdForTakeoverCheck });
            json(
              res,
              200,
              { ok: false, delivered: false, failure_reason: "human_takeover_active", failure_detail: "A human has taken over this conversation." },
              { "x-request-id": ctx.requestId }
            );
            return;
          }
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
              send_origin: staffConfirmation.confirmed ? "staff_confirmed" : "autonomous",
              ...(staffConfirmation.confirmed ? { confirmed_by: staffConfirmation.confirmed_by, confirmation_id: staffConfirmation.confirmation_id } : {}),
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
          await adminLoginRateLimiter.checkKey(loginAttemptKey(req, email));
        } catch (error) {
          if (!isRateLimitHit(error)) { json(res, 503, { error: "reset_unavailable", message: "Password reset is temporarily unavailable." }, { "x-request-id": ctx.requestId }); return; }
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
        if (!validateAuthConfig(config).valid) {
          json(res, 503, { error: "auth_configuration_invalid", message: "Sign-in is temporarily unavailable." }, { "x-request-id": ctx.requestId });
          return;
        }
        const body = await readJsonBody(req);
        const attemptKey = loginAttemptKey(req, body.email);
        const accountKey = `account:${normalizeEmail(body.email) || "unknown"}`;
        // R1 (F-1): the limiter comes FIRST, before any account lookup or password hashing, and it refuses EVERY attempt once tripped: a correct password does not bypass it, and the
        // answer is identical whatever was sent. Two counters: per address (every attempt, cleared by a success, as before) and per account (failures only, so rotating the
        // client-supplied forwarding header cannot start a fresh budget).
        const limitedAnswer = (resetAt) => json(
          res,
          429,
          { error: "login_rate_limit_exceeded", message: "Too many sign-in attempts. Please wait a few minutes and try again." },
          { "x-request-id": ctx.requestId, "x-login-ratelimit-reset": resetAt ? new Date(resetAt).toISOString() : "" }
        );
        try {
          const loginLimit = await adminLoginRateLimiter.checkKey(attemptKey);
          res.setHeader("x-login-ratelimit-remaining", String(loginLimit.remaining));
          res.setHeader("x-login-ratelimit-reset", new Date(loginLimit.resetAt).toISOString());
        } catch (error) {
          if (!isRateLimitHit(error)) { json(res, 503, { error: "sign_in_unavailable", message: "Sign-in is temporarily unavailable." }, { "x-request-id": ctx.requestId }); return; } // fail closed: a counter that cannot be read never means "allow"
          limitedAnswer(error.rateLimit?.resetAt);
          return;
        }
        try {
          if (await adminAccountFailureLimiter.isLimited(accountKey)) {
            limitedAnswer(await adminAccountFailureLimiter.resetAtOf(accountKey));
            return;
          }
          if (addressFailureLimiter && (await addressFailureLimiter.isLimited(`address:${req.clientAddress || "unknown"}`))) {
            limitedAnswer(await addressFailureLimiter.resetAtOf(`address:${req.clientAddress || "unknown"}`));
            return;
          }
        } catch {
          json(res, 503, { error: "sign_in_unavailable", message: "Sign-in is temporarily unavailable." }, { "x-request-id": ctx.requestId });
          return;
        }
        let adminUser;
        try {
          adminUser = await store.getAdminUserByEmail(body.email);
        } catch {
          // S7.5.3: the account store being down is a generic 503 (the raw driver message names internal hosts and ports); never a password-only fallback.
          json(res, 503, { error: "sign_in_unavailable", message: "Sign-in is temporarily unavailable." }, { "x-request-id": ctx.requestId });
          return;
        }
        // Legacy API-key-as-password sign-in: off unless LEAD_AGENTS_ALLOW_API_KEY_LOGIN=true (transitional, audited).
        const fallbackAllowed =
          config.allowApiKeyPasswordLogin === true &&
          config.mfaMode !== "on" &&
          !adminUser &&
          normalizeEmail(body.email) &&
          config.apiKeys.includes(String(body.password || ""));
        // R1 (F-3): the password is verified for every request (a fixed dummy hash stands in when no account exists), so an unknown address costs the same hashing work.
        const credentialsValid = fallbackAllowed || (verifyPasswordOrDummy(body.password, adminUser && adminUser.password_hash) && Boolean(adminUser));
        // R1 (F-2): one failure answer for wrong password, unknown account AND inactive account (whatever its password). Deactivation is still absolute: no session is issued.
        if (!credentialsValid || (adminUser && adminUser.status !== "active")) {
          try { await adminAccountFailureLimiter.hit(accountKey); if (addressFailureLimiter) await addressFailureLimiter.hit(`address:${req.clientAddress || "unknown"}`); } catch { json(res, 503, { error: "sign_in_unavailable", message: "Sign-in is temporarily unavailable." }, { "x-request-id": ctx.requestId }); return; }
          if (credentialsValid && adminUser) {
            await appendAudit(store, { userId: adminUser.id, email: adminUser.email, role: adminUser.role }, "session_login_denied_inactive", "admin_user", adminUser.id, { request_id: ctx.requestId, at: new Date().toISOString() }, req, "failure").catch(() => {});
          }
          json(res, 401, { error: "unauthorized", message: "Email or password is incorrect." });
          return;
        }

        // S7.5.3: password proven. If this account is bound to a second factor, answer with a short-lived CHALLENGE: no cookie, no account data, no authority.
        let loginEnrollmentNotice = null;
        if (adminUser && config.mfaMode === "on") {
          let mfaRequired;
          try { mfaRequired = await mfaRequiredFor(store, config, adminUser.id); } catch { json(res, 503, { error: "mfa_verification_unavailable", message: "Sign-in is temporarily unavailable." }, { "x-request-id": ctx.requestId }); return; }
          if (mfaRequired) {
            let challenge;
            try {
              if (!validateMfaConfig(config).valid) throw new Error("mfa_config_invalid");
              challenge = createMfaCrypto(config).issueChallengeToken({ user: adminUser, purpose: "login" });
            } catch {
              await appendAudit(store, { userId: adminUser.id, email: adminUser.email, role: adminUser.role }, "mfa_verification_error", "admin_user", adminUser.id, { request_id: ctx.requestId, phase: "challenge_issue", failure_reason: "mfa_unavailable", at: new Date().toISOString() }, req, "failure").catch(() => {});
              json(res, 503, { error: "mfa_unavailable", message: "Sign-in is temporarily unavailable." }, { "x-request-id": ctx.requestId });
              return;
            }
            await appendAudit(store, { userId: adminUser.id, email: adminUser.email, role: adminUser.role }, "mfa_challenge_issued", "admin_user", adminUser.id, { request_id: ctx.requestId, purpose: "login", at: new Date().toISOString() }, req);
            let methods = MFA_CHALLENGE_METHODS;
            try {
              const active = (await store.listMfaCredentials(adminUser.id)).filter((c) => c.status === "active");
              methods = [...(active.some((c) => c.type === "totp") ? ["totp"] : []), ...(active.some((c) => c.type === "webauthn") && validateWebauthnConfig(config).available ? ["webauthn"] : []), "recovery_code"];
            } catch { methods = MFA_CHALLENGE_METHODS; }
            json(res, 200, { ok: false, mfa_required: true, challenge_token: challenge.token, expires_at: challenge.expires_at, methods }, { "x-request-id": ctx.requestId, "cache-control": "no-store" });
            return;
          }
          // S7.5.7: not enrolled. If enforcement (or a reset / break-glass) requires a factor: before the deadline sign in with a notice; at or after it NO session is issued, only an enrolment
          // challenge (the S7.5.4 mailbox-code gate). An enrolled account never reaches here, so it can never be downgraded to password-only.
          let requirement;
          try { requirement = await requirementForUser(store, config, adminUser); } catch { json(res, 503, { error: "mfa_verification_unavailable", message: "Sign-in is temporarily unavailable." }, { "x-request-id": ctx.requestId }); return; }
          if (requirement.required && requirement.expired) {
            let challenge;
            try {
              if (!validateMfaConfig(config).valid) throw new Error("mfa_config_invalid");
              challenge = createMfaCrypto(config).issueChallengeToken({ user: adminUser, purpose: "enroll" });
            } catch {
              await appendAudit(store, { userId: adminUser.id, email: adminUser.email, role: adminUser.role }, "mfa_verification_error", "admin_user", adminUser.id, { request_id: ctx.requestId, phase: "enrollment_challenge_issue", failure_reason: "mfa_unavailable", at: new Date().toISOString() }, req, "failure").catch(() => {});
              json(res, 503, { error: "mfa_unavailable", message: "Sign-in is temporarily unavailable." }, { "x-request-id": ctx.requestId });
              return;
            }
            await appendAudit(store, { userId: adminUser.id, email: adminUser.email, role: adminUser.role }, "mfa_enrollment_required", "admin_user", adminUser.id, { request_id: ctx.requestId, source: requirement.source, at: new Date().toISOString() }, req);
            json(res, 200, { ok: false, mfa_enrollment_required: true, challenge_token: challenge.token, expires_at: challenge.expires_at, methods: ["totp"] }, { "x-request-id": ctx.requestId, "cache-control": "no-store" });
            return;
          }
          if (requirement.required) loginEnrollmentNotice = enrollmentNotice(requirement);
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
        try { await adminLoginRateLimiter.resetKey(attemptKey); } catch { /* the window expires on its own; a failed clear only keeps the stricter state */ }
        // R8: a sign-in whose audit record cannot be written is not completed: no session is issued and the answer is an honest, generic 503 (security evidence is not optional).
        try {
          await appendAudit(store, { userId: sessionUser.id, email: sessionUser.email, role: sessionUser.role }, "session_login", "admin_user", sessionUser.id, {});
        } catch {
          json(res, 503, { error: "sign_in_unavailable", message: "Sign-in is temporarily unavailable." }, { "x-request-id": ctx.requestId });
          return;
        }
        if (fallbackAllowed) {
          await appendAudit(
            store,
            { userId: sessionUser.id, email: sessionUser.email, role: sessionUser.role },
            "session_login_api_key_fallback",
            "admin_user",
            sessionUser.id,
            { email: sessionUser.email }
          );
        }
        // S7.3: one effective duration, resolved now, drives BOTH the signed expiry and the cookie Max-Age. S7.4: generation re-read right before signing.
        const { token, ttl: sessionTtl } = await issueSession(store, config, sessionUser);
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
            ...(loginEnrollmentNotice ? { mfa_enrollment: loginEnrollmentNotice } : {}),
          },
          {
            "set-cookie": createSessionCookie(token, config, sessionTtl.ttlMs),
            "x-request-id": ctx.requestId,
          }
        );
        return;
      }

      // ---- Settings S7.5.4: MFA enrollment and recovery management (contract: docs/settings-domain/31_S7_5_4_MFA_ENROLLMENT_AND_RECOVERY_MANAGEMENT_CONTRACT.md) ----
      const mfaHeaders = { "x-request-id": ctx.requestId, "cache-control": "no-store" };
      const mfaDeny = async (status, error, category, actor, extra = {}) => {
        await appendAudit(store, actor || (authContext?.type === "session" ? authContext : { type: authContext?.type || "unknown" }), "mfa_management_denied", "admin_user", authContext?.user?.id || "", { request_id: ctx.requestId, route: category, failure_reason: category, at: new Date().toISOString() }, req, "failure").catch(() => {});
        json(res, status, { error, ...extra }, mfaHeaders);
        return null;
      };
      // Common gate of every authenticated MFA-management route: human session, MFA on with a valid key, schema present, and the step-up grant (`mfa_management`) with a fresh second
      // factor when the account already has one. Returns the working context, or null after answering.
      const mfaManagementGate = async (category, { stepUp = true } = {}) => {
        if (authContext?.type !== "session") return mfaDeny(403, "actor_identity_required", "api_key_not_allowed");
        if (!validateAuthConfig(config).valid) return mfaDeny(503, "auth_configuration_invalid", "auth_config_invalid");
        let lib;
        try { if (config.mfaMode !== "on" || !validateMfaConfig(config).valid) throw new Error("off"); lib = createMfaCrypto(config); } catch { return mfaDeny(503, "mfa_unavailable", "mfa_unavailable"); }
        try { if (typeof store.supportsMfaManagement !== "function" || !(await store.supportsMfaManagement())) throw new Error("schema"); } catch { return mfaDeny(503, "mfa_unavailable", "schema_unavailable"); }
        const user = authContext.user; let hasFactor;
        try { hasFactor = Boolean(await store.hasActiveMfa(user.id)); } catch { return mfaDeny(503, "mfa_verification_unavailable", "store_error"); }
        let grant = null;
        if (stepUp) {
          grant = verifyStepUpToken({ config, authContext, purpose: "mfa_management", token: req.headers[STEP_UP_HEADER] });
          if (!grant.ok) return mfaDeny(403, "step_up_required", "step_up_required", undefined, { reason: grant.reason, purpose: "mfa_management" });
          if (hasFactor && grant.mf !== true) return mfaDeny(403, "step_up_required", "step_up_required", undefined, { reason: "mfa_required", purpose: "mfa_management" });
        }
        return { lib, user, hasFactor, grant, actor: { userId: user.id, email: user.email, role: user.role } };
      };
      const mfaStoreFault = async (error, actor, op) => {
        const known = ["mfa_conflict", "mfa_last_factor"].includes(error && error.code);
        await appendAudit(store, actor, "mfa_management_denied", "admin_user", actor?.userId || "", { request_id: ctx.requestId, route: op, failure_reason: known ? error.code : "store_error", at: new Date().toISOString() }, req, "failure").catch(() => {});
        if (error && error.code === "mfa_conflict") json(res, 409, { error: "mfa_conflict" }, mfaHeaders);
        else if (error && error.code === "mfa_last_factor") json(res, 409, { error: "last_factor", message: "MFA is required for this account, so its last factor cannot be removed." }, mfaHeaders);
        else if (error && ["mfa_decrypt_failed", "mfa_key_unavailable", "mfa_unavailable"].includes(error.code)) json(res, 503, { error: "mfa_unavailable" }, mfaHeaders);
        else json(res, 503, { error: "mfa_verification_unavailable" }, mfaHeaders);
      };
      const enrollLimiter = async (label, user) => { try { await adminLoginRateLimiter.checkKey(`${label}|${loginAttemptKey(req, user.email)}`); return true; } catch (error) { if (!isRateLimitHit(error)) { json(res, 503, { error: "mfa_verification_unavailable" }, mfaHeaders); return false; } json(res, 429, { error: "login_rate_limit_exceeded", message: "Too many attempts. Please wait a few minutes and try again." }, mfaHeaders); return false; } };

      // shared by the voluntary and the forced path: a fresh pending TOTP, the secret returned ONCE
      const beginTotp = async (gate, user) => {
        await store.revokePendingTotp(user.id, { actor: user.email });
        const credentialId = crypto.randomUUID();
        const prepared = gate.lib.prepareTotpEnrollment({ userId: user.id, credentialId, account: user.email });
        await store.createMfaCredential(user.id, { id: credentialId, type: "totp", label: "Authenticator app", ...prepared.record });
        const active = await store.getActiveTotpCredential(user.id);
        await appendAudit(store, gate.actor, "mfa_enrollment_started", "admin_user", user.id, { request_id: ctx.requestId, credential_id: credentialId, replaces_credential_id: active ? active.id : null, at: new Date().toISOString() }, req);
        json(res, 200, { ok: true, credential_id: credentialId, secret_base32: prepared.secretBase32, otpauth_uri: prepared.otpauthUri, expires_at: new Date(Date.now() + MFA_PENDING_TTL_MS).toISOString(), replaces_credential_id: active ? active.id : null }, mfaHeaders);
      };
      // shared confirm: verify the code against the PENDING secret without consuming it, then activate (and, for a first factor, issue recovery codes) in ONE atomic step
      const confirmTotp = async (gate, user, body, { forced }) => {
        const pending = (await store.listMfaCredentials(user.id)).find((c) => c.id === body.credential_id && c.type === "totp" && c.status === "pending");
        const fail = async (status, error, reason) => { await appendAudit(store, gate.actor, "mfa_enrollment_failed", "admin_user", user.id, { request_id: ctx.requestId, failure_reason: reason, forced, at: new Date().toISOString() }, req, "failure").catch(() => {}); json(res, status, { error }, mfaHeaders); };
        if (!pending) return fail(409, "mfa_enrollment_not_pending", "not_pending");
        if (Date.now() - Date.parse(pending.created_at) > MFA_PENDING_TTL_MS) { await store.revokeMfaCredential(user.id, pending.id, { actor: user.email, reason: "expired" }).catch(() => {}); return fail(410, "mfa_enrollment_expired", "expired"); }
        const checked = await gate.lib.checkTotp({ store, userId: user.id, credentialId: pending.id, code: body.code });
        if (!checked.ok) return fail(401, "mfa_failed", "invalid_code");
        const active = await store.getActiveTotpCredential(user.id);
        if (forced && (await store.hasActiveMfa(user.id))) return fail(409, "mfa_conflict", "already_enrolled");
        // recovery codes belong to the ACCOUNT's first factor of any type: adding a TOTP next to a security key (or replacing one) never silently regenerates them
        const needCodes = !gate.hasFactor || (await store.countMfaRecoveryCodes(user.id)) === 0;
        const batch = needCodes ? gate.lib.newRecoveryBatch(user.id) : null;
        const result = await store.activateMfaCredentialAtomic(user.id, pending.id, { actor: user.email, replaceCredentialId: active ? active.id : null, totpStep: checked.step, recoveryHmacs: batch ? batch.hmacs : null, keyId: batch ? batch.key_id : null });
        if (!result) return fail(409, "mfa_enrollment_not_pending", "raced");
        if (user.mfa_required_after) await store.updateAdminUser(user.id, { mfa_required_after: null }).catch(() => {}); // enrolled: the per-account requirement is met
        const event = result.replaced ? "factor_replaced" : gate.hasFactor ? "factor_added" : "enrolled";
        await appendAudit(store, gate.actor, result.replaced ? "mfa_factor_replaced" : gate.hasFactor ? "mfa_factor_added" : "mfa_enrolled", "admin_user", user.id, { request_id: ctx.requestId, credential_id: pending.id, recovery_codes_issued: result.recovery_codes, generation_after: result.session_generation, forced, at: new Date().toISOString() }, req);
        const delivery = await notifyMfaEvent({ store, config, user, event, requestId: ctx.requestId, req });
        let cookieHeader = {}; let sessionReissued = false;
        if (!forced) { try { const fresh = await store.getAdminUserById(user.id); const { token, ttl } = await issueSession(store, config, fresh, { mfaAt: Date.now() }); cookieHeader = { "set-cookie": createSessionCookie(token, config, ttl.ttlMs) }; sessionReissued = true; } catch { /* the factor IS active; the person signs in again (the recovery codes below are still shown: this is their only chance) */ } }
        json(res, 200, { ok: true, credential: { id: pending.id, type: "totp", status: "active" }, replaced: result.replaced, ...(batch ? { recovery_codes: batch.codes } : {}), recovery_codes_issued: result.recovery_codes, session_reissued: sessionReissued, sign_in_again: !sessionReissued, notification: delivery }, { ...mfaHeaders, ...cookieHeader });
      };

      if (pathname === "/api/lead-agents/admin/session/mfa") {
        if (req.method !== "GET") { methodNotAllowed(res, "GET"); return; }
        if (authContext?.type !== "session") { await mfaDeny(403, "actor_identity_required", "api_key_not_allowed"); return; }
        const user = authContext.user; const modeOn = config.mfaMode === "on" && validateMfaConfig(config).valid;
        if (!modeOn) { json(res, 200, { mode: config.mfaMode === "on" ? "on_invalid" : "off", enrolled: false, management_available: false }, mfaHeaders); return; }
        try {
          const management = typeof store.supportsMfaManagement === "function" && (await store.supportsMfaManagement());
          const credentials = (await store.listMfaCredentials(user.id)).filter((c) => c.status !== "revoked");
          const enrolled = credentials.some((c) => c.status === "active");
          const policy = await resolveEnforcement(store, config); const requirement = enrolled ? { required: false } : accountRequirement({ policy, user }); const canReadEnforcement = hasPermission(authContext, "staff.manage");
          const waStatus = validateWebauthnConfig(config); json(res, 200, { mode: "on", management_available: Boolean(management), webauthn: { status: waStatus.status, available: waStatus.available, limit: MAX_WEBAUTHN_CREDENTIALS, registered: credentials.filter((c) => c.type === "webauthn" && c.status === "active").length }, enrolled, required: mfaRequiredForRole(user, config) || requirement.required, ...(requirement.required ? { enrollment: enrollmentNotice(requirement) } : {}), ...(canReadEnforcement ? { enforcement: { level: policy.level, active: policy.active, status: policy.status, recovery: recoverySummary(config) } } : {}), credentials, recovery_codes_remaining: enrolled ? await store.countMfaRecoveryCodes(user.id) : 0, step_up: { purpose: "mfa_management", requires_second_factor: enrolled }, session: { mfa_verified: authContext.sessionMfa === true } }, mfaHeaders);
        } catch { json(res, 503, { error: "mfa_verification_unavailable" }, mfaHeaders); }
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/mfa/enroll/totp/begin") {
        if (req.method !== "POST") { methodNotAllowed(res, "POST"); return; }
        const gate = await mfaManagementGate("enroll_begin"); if (!gate) return;
        if (!(await enrollLimiter("mfa-enroll", gate.user))) return;
        try { await beginTotp(gate, gate.user); } catch (error) { await mfaStoreFault(error, gate.actor, "enroll_begin"); }
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/mfa/enroll/totp/confirm") {
        if (req.method !== "POST") { methodNotAllowed(res, "POST"); return; }
        const gate = await mfaManagementGate("enroll_confirm"); if (!gate) return;
        const body = await readJsonBody(req); requireObject(body, "body");
        if (typeof body.credential_id !== "string" || typeof body.code !== "string" || body.code.length > 32) { json(res, 400, { error: "invalid_request" }, mfaHeaders); return; }
        if (!(await enrollLimiter("mfa-enroll", gate.user))) return;
        try { await confirmTotp(gate, gate.user, body, { forced: false }); } catch (error) { await mfaStoreFault(error, gate.actor, "enroll_confirm"); }
        return;
      }

      const mfaRemoveMatch = pathname.match(/^\/api\/lead-agents\/admin\/session\/mfa\/credentials\/([0-9a-fA-F-]{36})\/remove$/);
      if (mfaRemoveMatch) {
        if (req.method !== "POST") { methodNotAllowed(res, "POST"); return; }
        const gate = await mfaManagementGate("remove"); if (!gate) return;
        try {
          const result = await store.revokeMfaCredentialAtomic(gate.user.id, mfaRemoveMatch[1].toLowerCase(), { actor: gate.user.email, reason: "removed_by_user", keepLast: mfaRequiredForRole(gate.user, config) || (await requirementForUser(store, config, gate.user).catch(() => ({ required: true }))).required });
          if (!result) { json(res, 404, { error: "credential_not_found" }, mfaHeaders); return; }
          await appendAudit(store, gate.actor, "mfa_factor_removed", "admin_user", gate.user.id, { request_id: ctx.requestId, credential_id: mfaRemoveMatch[1].toLowerCase(), was_active: result.was_active, remaining_active: result.remaining_active, recovery_codes_deleted: result.codes_deleted, generation_after: result.session_generation, at: new Date().toISOString() }, req);
          const delivery = result.was_active ? await notifyMfaEvent({ store, config, user: gate.user, event: "factor_removed", requestId: ctx.requestId, req }) : "not_applicable";
          let cookieHeader = {}; let sessionReissued = false;
          if (result.was_active) { try { const fresh = await store.getAdminUserById(gate.user.id); const { token, ttl } = await issueSession(store, config, fresh, { mfaAt: result.remaining_active > 0 ? Date.now() : undefined }); cookieHeader = { "set-cookie": createSessionCookie(token, config, ttl.ttlMs) }; sessionReissued = true; } catch { /* sign in again */ } }
          json(res, 200, { ok: true, removed: true, remaining_active: result.remaining_active, recovery_codes_deleted: result.codes_deleted, session_reissued: sessionReissued, sign_in_again: result.was_active && !sessionReissued, notification: delivery }, { ...mfaHeaders, ...cookieHeader });
        } catch (error) { await mfaStoreFault(error, gate.actor, "remove"); }
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/mfa/recovery-codes/regenerate") {
        if (req.method !== "POST") { methodNotAllowed(res, "POST"); return; }
        const gate = await mfaManagementGate("regenerate"); if (!gate) return;
        if (!gate.hasFactor) { await mfaDeny(409, "no_active_factor", "no_active_factor", gate.actor); return; }
        try {
          const batch = gate.lib.newRecoveryBatch(gate.user.id);
          const count = await store.replaceMfaRecoveryCodes(gate.user.id, crypto.randomUUID(), batch.hmacs, { keyId: batch.key_id });
          await appendAudit(store, gate.actor, "mfa_recovery_codes_regenerated", "admin_user", gate.user.id, { request_id: ctx.requestId, codes_issued: count, at: new Date().toISOString() }, req);
          const delivery = await notifyMfaEvent({ store, config, user: gate.user, event: "recovery_codes_regenerated", requestId: ctx.requestId, req });
          json(res, 200, { ok: true, recovery_codes: batch.codes, recovery_codes_issued: count, notification: delivery }, mfaHeaders);
        } catch (error) { await mfaStoreFault(error, gate.actor, "regenerate"); }
        return;
      }

      // ---- forced enrollment: the challenge holder proves the MAILBOX, then enrolls. No session is ever created here. ----
      const forcedGate = async (purpose, token, { quiet = false } = {}) => {
        if (!validateAuthConfig(config).valid) { json(res, 503, { error: "auth_configuration_invalid" }, mfaHeaders); return null; }
        let lib;
        try { if (config.mfaMode !== "on" || !validateMfaConfig(config).valid) throw new Error("off"); lib = createMfaCrypto(config); if (typeof store.supportsMfaManagement !== "function" || !(await store.supportsMfaManagement())) throw new Error("schema"); } catch { json(res, 503, { error: "mfa_unavailable" }, mfaHeaders); return null; }
        const generic = async (reason, uid) => { await appendAudit(store, { type: "unknown" }, "mfa_enrollment_failed", "admin_user", uid || "", { request_id: ctx.requestId, failure_reason: `forced_${reason}`, at: new Date().toISOString() }, req, "failure").catch(() => {}); if (!quiet) json(res, 401, { error: "mfa_failed" }, mfaHeaders); return null; };
        const subject = challengeSubject(token);
        if (!subject) return generic("malformed");
        let user; try { user = await store.getAdminUserById(subject); } catch { json(res, 503, { error: "mfa_verification_unavailable" }, mfaHeaders); return null; }
        if (!user || user.status !== "active") return generic("unknown_account");
        const verdict = lib.verifyChallengeToken({ token, user, purpose });
        if (!verdict.ok) return generic(verdict.reason, user.id);
        return { lib, user, claims: verdict.claims, actor: { userId: user.id, email: user.email, role: user.role } };
      };

      if (pathname === "/api/lead-agents/admin/session/mfa/enroll/email-code") {
        if (req.method !== "POST") { methodNotAllowed(res, "POST"); return; }
        const body = await readJsonBody(req); requireObject(body, "body");
        const subjectUser = await (async () => { const uid = challengeSubject(body.challenge_token); if (!uid) return null; try { return await store.getAdminUserById(uid); } catch { return null; } })();
        if (subjectUser && !(await enrollLimiter("mfa-enroll-mail", subjectUser))) return;
        const gate = await forcedGate("enroll", body.challenge_token, { quiet: true });
        // an invalid token and a valid one get the SAME answer (no oracle on which challenges exist); only real faults (503) answer differently
        if (!gate) { if (!res.headersSent) json(res, 200, { ok: true, message: "If this sign-in is valid, a verification code was sent to the account's mailbox." }, mfaHeaders); return; }
        let delivery = "failed";
        try {
          const message = mfaMailboxCodeEmail({ displayName: gate.user.display_name, code: gate.lib.mailboxCodeFor(gate.claims), minutes: Math.max(1, Math.round((gate.claims.exp - Date.now()) / 60000)) });
          const sent = await sendOfficeEmail(config, { to: gate.user.email, ...message });
          delivery = sent.delivered ? "sent" : sent.reason === "missing_recipient" ? "no_recipient" : "not_configured";
        } catch { delivery = "failed"; }
        await appendAudit(store, gate.actor, "mfa_notification", "admin_user", gate.user.id, { request_id: ctx.requestId, event: "mailbox_code", delivery, at: new Date().toISOString() }, req, delivery === "sent" ? "success" : "failure").catch(() => {});
        json(res, 200, { ok: true, message: "If this sign-in is valid, a verification code was sent to the account's mailbox." }, mfaHeaders);
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/mfa/enroll/email-verify") {
        if (req.method !== "POST") { methodNotAllowed(res, "POST"); return; }
        const body = await readJsonBody(req); requireObject(body, "body");
        const gate = await forcedGate("enroll", body.challenge_token); if (!gate) return;
        if (!(await enrollLimiter("mfa-enroll-verify", gate.user))) return;
        if (!gate.lib.verifyMailboxCode(gate.claims, body.email_code)) { await appendAudit(store, gate.actor, "mfa_enrollment_failed", "admin_user", gate.user.id, { request_id: ctx.requestId, failure_reason: "mailbox_code", at: new Date().toISOString() }, req, "failure").catch(() => {}); json(res, 401, { error: "mfa_failed" }, mfaHeaders); return; }
        const issued = gate.lib.issueChallengeToken({ user: gate.user, purpose: "enroll_verified", ttlMs: 10 * 60_000 });
        await appendAudit(store, gate.actor, "mfa_mailbox_verified", "admin_user", gate.user.id, { request_id: ctx.requestId, at: new Date().toISOString() }, req);
        json(res, 200, { ok: true, enrollment_token: issued.token, expires_at: issued.expires_at }, mfaHeaders);
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/mfa/enroll/forced/begin") {
        if (req.method !== "POST") { methodNotAllowed(res, "POST"); return; }
        const body = await readJsonBody(req); requireObject(body, "body");
        const gate = await forcedGate("enroll_verified", body.enrollment_token); if (!gate) return;
        try { if (await store.hasActiveMfa(gate.user.id)) { json(res, 409, { error: "mfa_conflict" }, mfaHeaders); return; } if (!(await enrollLimiter("mfa-enroll", gate.user))) return; await beginTotp(gate, gate.user); } catch (error) { await mfaStoreFault(error, gate.actor, "forced_begin"); }
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/mfa/enroll/forced/confirm") {
        if (req.method !== "POST") { methodNotAllowed(res, "POST"); return; }
        const body = await readJsonBody(req); requireObject(body, "body");
        const gate = await forcedGate("enroll_verified", body.enrollment_token); if (!gate) return;
        if (typeof body.credential_id !== "string" || typeof body.code !== "string" || body.code.length > 32) { json(res, 400, { error: "invalid_request" }, mfaHeaders); return; }
        if (!(await enrollLimiter("mfa-enroll", gate.user))) return;
        try { await confirmTotp(gate, gate.user, body, { forced: true }); } catch (error) { await mfaStoreFault(error, gate.actor, "forced_confirm"); }
        return;
      }

      // ---- Settings S7.5.5: WebAuthn registration and authentication (contract: docs/settings-domain/32_S7_5_5_WEBAUTHN_PASSKEY_CONTRACT.md) ----
      const webauthnService = async () => {
        try { const service = createWebauthn(config); if (typeof store.supportsMfaWebauthn !== "function" || !(await store.supportsMfaWebauthn())) throw new Error("schema"); return service; } catch { return null; }
      };
      const newWebauthnChallenge = async (userId, purpose) => {
        const challenge = crypto.randomBytes(32);
        const created = await store.createMfaChallenge(userId, purpose, challenge.toString("base64"), 300);
        return { challenge, id: created.id, expiresAt: created.expires_at };
      };

      if (pathname === "/api/lead-agents/admin/session/mfa/webauthn/register/options") {
        if (req.method !== "POST") { methodNotAllowed(res, "POST"); return; }
        const gate = await mfaManagementGate("webauthn_register_options"); if (!gate) return;
        const wa = await webauthnService(); if (!wa) { await mfaDeny(503, "webauthn_unavailable", "webauthn_unavailable", gate.actor); return; }
        if (!(await enrollLimiter("mfa-enroll", gate.user))) return;
        try {
          const existing = await store.listWebauthnCredentialsForAuth(gate.user.id);
          if (existing.length >= MAX_WEBAUTHN_CREDENTIALS) { await mfaDeny(409, "credential_limit", "credential_limit", gate.actor); return; }
          const ch = await newWebauthnChallenge(gate.user.id, "webauthn_register");
          const options = await wa.registrationOptions({ user: gate.user, existing, challenge: ch.challenge });
          await appendAudit(store, gate.actor, "mfa_webauthn_registration_started", "admin_user", gate.user.id, { request_id: ctx.requestId, at: new Date().toISOString() }, req);
          json(res, 200, { ok: true, options, challenge_id: ch.id, expires_at: ch.expiresAt }, mfaHeaders);
        } catch (error) { await mfaStoreFault(error, gate.actor, "webauthn_register_options"); }
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/mfa/webauthn/register/verify") {
        if (req.method !== "POST") { methodNotAllowed(res, "POST"); return; }
        const gate = await mfaManagementGate("webauthn_register_verify"); if (!gate) return;
        const wa = await webauthnService(); if (!wa) { await mfaDeny(503, "webauthn_unavailable", "webauthn_unavailable", gate.actor); return; }
        const body = await readJsonBody(req); requireObject(body, "body");
        if (typeof body.challenge_id !== "string" || !body.response || typeof body.response !== "object") { json(res, 400, { error: "invalid_request" }, mfaHeaders); return; }
        if (!(await enrollLimiter("mfa-enroll", gate.user))) return;
        const fail = async (status, error, reason, category) => { await appendAudit(store, gate.actor, "mfa_enrollment_failed", "admin_user", gate.user.id, { request_id: ctx.requestId, method: "webauthn", failure_reason: reason, ...(category ? { category } : {}), at: new Date().toISOString() }, req, "failure").catch(() => {}); json(res, status, { error }, mfaHeaders); };
        let createdId = null;
        try {
          const consumed = await store.consumeMfaChallenge(gate.user.id, body.challenge_id, "webauthn_register"); // single use: spent whether or not the response verifies
          if (!consumed) return fail(401, "mfa_failed", "challenge");
          let info;
          try { info = await wa.verifyRegistration({ response: body.response, expectedChallenge: Buffer.from(consumed, "base64").toString("base64url") }); }
          catch (error) { if (error && error.code === "webauthn_verification_failed") return fail(401, "mfa_failed", "verification", error.category); throw error; }
          const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : "Security key";
          const created = await store.createMfaCredential(gate.user.id, { type: "webauthn", label, webauthn_credential_id: info.credential_id, webauthn_public_key: info.public_key, webauthn_sign_count: info.sign_count, webauthn_transports: info.transports, webauthn_aaguid: info.aaguid, webauthn_backup_eligible: info.backup_eligible });
          createdId = created.id;
          const needCodes = !gate.hasFactor || (await store.countMfaRecoveryCodes(gate.user.id)) === 0;
          const batch = needCodes ? gate.lib.newRecoveryBatch(gate.user.id) : null;
          const result = await store.activateMfaCredentialAtomic(gate.user.id, created.id, { actor: gate.user.email, recoveryHmacs: batch ? batch.hmacs : null, keyId: batch ? batch.key_id : null });
          if (!result) { await store.revokeMfaCredential(gate.user.id, created.id, { actor: gate.user.email, reason: "activation_failed" }).catch(() => {}); return fail(409, "mfa_conflict", "raced"); }
          createdId = null;
          if (gate.user.mfa_required_after) await store.updateAdminUser(gate.user.id, { mfa_required_after: null }).catch(() => {});
          await appendAudit(store, gate.actor, gate.hasFactor ? "mfa_factor_added" : "mfa_enrolled", "admin_user", gate.user.id, { request_id: ctx.requestId, credential_id: created.id, method: "webauthn", recovery_codes_issued: result.recovery_codes, generation_after: result.session_generation, at: new Date().toISOString() }, req);
          const delivery = await notifyMfaEvent({ store, config, user: gate.user, event: gate.hasFactor ? "factor_added" : "enrolled", requestId: ctx.requestId, req });
          let cookieHeader = {}; let sessionReissued = false;
          try { const fresh = await store.getAdminUserById(gate.user.id); const { token, ttl } = await issueSession(store, config, fresh, { mfaAt: Date.now() }); cookieHeader = { "set-cookie": createSessionCookie(token, config, ttl.ttlMs) }; sessionReissued = true; } catch { /* the credential IS active; sign in again (the recovery codes below are still shown) */ }
          json(res, 200, { ok: true, credential: { id: created.id, type: "webauthn", status: "active", label }, ...(batch ? { recovery_codes: batch.codes } : {}), recovery_codes_issued: result.recovery_codes, session_reissued: sessionReissued, sign_in_again: !sessionReissued, notification: delivery }, { ...mfaHeaders, ...cookieHeader });
        } catch (error) {
          if (createdId) await store.revokeMfaCredential(gate.user.id, createdId, { actor: gate.user.email, reason: "activation_failed" }).catch(() => {});
          if (error && error.code === "mfa_credential_limit") { await mfaDeny(409, "credential_limit", "credential_limit", gate.actor); return; }
          await mfaStoreFault(error, gate.actor, "webauthn_register_verify");
        }
        return;
      }

      // options for a SESSION-bound fresh proof (step-up): the account's active credentials only
      if (pathname === "/api/lead-agents/admin/session/mfa/webauthn/step-up-options") {
        if (req.method !== "POST") { methodNotAllowed(res, "POST"); return; }
        const gate = await mfaManagementGate("webauthn_stepup_options", { stepUp: false }); if (!gate) return;
        const wa = await webauthnService(); if (!wa) { await mfaDeny(503, "webauthn_unavailable", "webauthn_unavailable", gate.actor); return; }
        if (!(await enrollLimiter("mfa-webauthn-options", gate.user))) return;
        try {
          const creds = await store.listWebauthnCredentialsForAuth(gate.user.id);
          if (!creds.length) { json(res, 409, { error: "no_webauthn_credential" }, mfaHeaders); return; }
          const ch = await newWebauthnChallenge(gate.user.id, "webauthn_authenticate");
          json(res, 200, { ok: true, options: await wa.authenticationOptions({ allow: creds, challenge: ch.challenge }), challenge_id: ch.id, expires_at: ch.expiresAt }, mfaHeaders);
        } catch (error) { await mfaStoreFault(error, gate.actor, "webauthn_stepup_options"); }
        return;
      }

      // options for the LOGIN second step: the person proves the password via the login challenge (public path: no session exists yet)
      if (pathname === "/api/lead-agents/admin/session/mfa/webauthn/auth/options") {
        if (req.method !== "POST") { methodNotAllowed(res, "POST"); return; }
        const body = await readJsonBody(req); requireObject(body, "body");
        const failedGeneric = () => json(res, 401, { error: "mfa_failed", message: "That verification could not be completed." }, mfaHeaders);
        if (!validateAuthConfig(config).valid) { json(res, 503, { error: "auth_configuration_invalid" }, mfaHeaders); return; }
        let lib; try { if (config.mfaMode !== "on" || !validateMfaConfig(config).valid) throw new Error("off"); lib = createMfaCrypto(config); } catch { json(res, 503, { error: "mfa_unavailable" }, mfaHeaders); return; }
        const wa = await webauthnService(); if (!wa) { json(res, 503, { error: "webauthn_unavailable" }, mfaHeaders); return; }
        const subject = challengeSubject(body.challenge_token); if (!subject) { failedGeneric(); return; }
        let user; try { user = await store.getAdminUserById(subject); } catch { json(res, 503, { error: "mfa_verification_unavailable" }, mfaHeaders); return; }
        if (!user || user.status !== "active" || !lib.verifyChallengeToken({ token: body.challenge_token, user, purpose: "login" }).ok) { failedGeneric(); return; }
        if (!(await enrollLimiter("mfa-webauthn-options", user))) return;
        try {
          const creds = await store.listWebauthnCredentialsForAuth(user.id);
          if (!creds.length) { failedGeneric(); return; }
          const ch = await newWebauthnChallenge(user.id, "webauthn_authenticate");
          json(res, 200, { ok: true, options: await wa.authenticationOptions({ allow: creds, challenge: ch.challenge }), challenge_id: ch.id, expires_at: ch.expiresAt }, mfaHeaders);
        } catch { json(res, 503, { error: "mfa_verification_unavailable" }, mfaHeaders); }
        return;
      }

      // ---- Settings S7.5.3: second-factor verification (contract: docs/settings-domain/30_S7_5_3_MFA_LOGIN_CHALLENGE_CONTRACT.md). Public path: no session exists yet. ----
      if (pathname === "/api/lead-agents/admin/session/mfa/verify") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        const headersOut = { "x-request-id": ctx.requestId, "cache-control": "no-store" };
        if (!validateAuthConfig(config).valid) { json(res, 503, { error: "auth_configuration_invalid", message: "Sign-in is temporarily unavailable." }, headersOut); return; }
        let mfaLib;
        try {
          if (config.mfaMode !== "on" || !validateMfaConfig(config).valid) throw new Error("mfa_unavailable");
          mfaLib = createMfaCrypto(config);
        } catch { json(res, 503, { error: "mfa_unavailable", message: "Sign-in is temporarily unavailable." }, headersOut); return; }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const failedGeneric = () => json(res, 401, { error: "mfa_failed", message: "That verification could not be completed." }, headersOut);
        const subject = challengeSubject(body.challenge_token);
        const unknownActor = { type: "unknown" };
        const auditFailure = (actor, userId, reason, extra = {}) => appendAudit(store, actor, "mfa_failed", "admin_user", userId || "", { request_id: ctx.requestId, failure_reason: reason, at: new Date().toISOString(), ...extra }, req, "failure").catch(() => {});
        if (!subject) { await auditFailure(unknownActor, "", "malformed_challenge"); failedGeneric(); return; }
        let mfaUser;
        try { mfaUser = await store.getAdminUserById(subject); } catch { json(res, 503, { error: "mfa_verification_unavailable", message: "Sign-in is temporarily unavailable." }, headersOut); return; }
        if (!mfaUser || mfaUser.status !== "active") { await auditFailure(unknownActor, "", "unknown_account"); failedGeneric(); return; }
        const actor = { userId: mfaUser.id, email: mfaUser.email, role: mfaUser.role };
        const limiterKey = `mfa|${loginAttemptKey(req, mfaUser.email)}`;
        try { await adminLoginRateLimiter.checkKey(limiterKey); } catch (error) {
          if (!isRateLimitHit(error)) { json(res, 503, { error: "mfa_verification_unavailable", message: "Sign-in is temporarily unavailable." }, headersOut); return; }
          json(res, 429, { error: "login_rate_limit_exceeded", message: "Too many sign-in attempts. Please wait a few minutes and try again." }, { ...headersOut, "x-login-ratelimit-reset": error.rateLimit?.resetAt ? new Date(error.rateLimit.resetAt).toISOString() : "" });
          return;
        }
        let lock;
        try { lock = await store.getMfaLockState(mfaUser.id); } catch { json(res, 503, { error: "mfa_verification_unavailable", message: "Sign-in is temporarily unavailable." }, headersOut); return; }
        const lockedFor = lock && lock.locked_until ? Date.parse(lock.locked_until) - Date.now() : 0;
        if (lockedFor > 0) { json(res, 429, { error: "mfa_locked", message: "Too many incorrect codes. Try again later.", retry_after_seconds: Math.ceil(lockedFor / 1000) }, { ...headersOut, "retry-after": String(Math.ceil(lockedFor / 1000)) }); return; }
        const verdict = mfaLib.verifyChallengeToken({ token: body.challenge_token, user: mfaUser, purpose: "login" });
        if (!verdict.ok) {
          await auditFailure(unknownActor, mfaUser.id, `challenge_${verdict.reason}`);
          if (["expired", "password_changed", "revoked"].includes(verdict.reason)) json(res, 401, { error: "mfa_challenge_expired", message: "This sign-in expired. Sign in again." }, headersOut); else failedGeneric();
          return;
        }
        const isWebauthn = body.method === "webauthn";
        if (isWebauthn ? (!body.webauthn || typeof body.webauthn !== "object" || typeof body.webauthn.challenge_id !== "string" || !body.webauthn.response || typeof body.webauthn.response !== "object")
          : (!MFA_CHALLENGE_METHODS.includes(body.method) || typeof body.code !== "string" || body.code.length > 64)) { await auditFailure(actor, mfaUser.id, "invalid_request"); failedGeneric(); return; }
        let outcome;
        try {
          if (body.method === "totp") {
            const credential = await store.getActiveTotpCredential(mfaUser.id);
            outcome = credential ? await mfaLib.verifyAndConsumeTotp({ store, userId: mfaUser.id, credentialId: credential.id, code: body.code }) : { ok: false, reason: "no_totp_factor" };
          } else if (isWebauthn) {
            outcome = await checkWebauthnAssertion({ store, config, user: mfaUser, challengeId: body.webauthn.challenge_id, response: body.webauthn.response });
          } else {
            // S7.5.4: consumption and the generation bump are ONE database step (closes the S7.5.3 two-step gap); older databases fall back to the two-step path
            outcome = await mfaLib.verifyAndConsumeRecoveryCodeRevoking({ store, userId: mfaUser.id, code: body.code, actor: mfaUser.email });
          }
        } catch (error) {
          const keyProblem = ["mfa_decrypt_failed", "mfa_key_unavailable", "mfa_unavailable", "webauthn_unavailable"].includes(error && error.code);
          await appendAudit(store, actor, "mfa_verification_error", "admin_user", mfaUser.id, { request_id: ctx.requestId, method: body.method, failure_reason: keyProblem ? "key_or_decrypt" : "store_error", at: new Date().toISOString() }, req, "failure").catch(() => {});
          json(res, 503, { error: keyProblem ? "mfa_unavailable" : "mfa_verification_unavailable", message: "Sign-in is temporarily unavailable." }, headersOut); // server-side fault: never password-only, never counted against the person
          return;
        }
        if (!outcome.ok) {
          let failure;
          try { failure = await store.recordMfaFailure(mfaUser.id); } catch { json(res, 503, { error: "mfa_verification_unavailable", message: "Sign-in is temporarily unavailable." }, headersOut); return; }
          await auditFailure(actor, mfaUser.id, outcome.reason, { method: body.method, failed_attempts: failure ? failure.failed_attempts : undefined });
          if (outcome.reason === "counter_rollback" || outcome.reason === "counter") await appendAudit(store, actor, "mfa_webauthn_counter_rollback", "admin_user", mfaUser.id, { request_id: ctx.requestId, at: new Date().toISOString() }, req, "failure").catch(() => {});
          const lockedNow = failure && failure.locked_until ? Date.parse(failure.locked_until) - Date.now() : 0;
          if (lockedNow > 0) {
            await appendAudit(store, actor, "mfa_locked", "admin_user", mfaUser.id, { request_id: ctx.requestId, failed_attempts: failure.failed_attempts, locked_until: failure.locked_until, at: new Date().toISOString() }, req, "failure").catch(() => {});
            json(res, 429, { error: "mfa_locked", message: "Too many incorrect codes. Try again later.", retry_after_seconds: Math.ceil(lockedNow / 1000) }, { ...headersOut, "retry-after": String(Math.ceil(lockedNow / 1000)) });
            return;
          }
          failedGeneric();
          return;
        }
        // factor accepted (the S7.5.1 single-use/replay operation already recorded it)
        try { await store.clearMfaFailures(mfaUser.id); } catch { /* the counter heals on the next success; the factor itself was verified */ }
        let remaining;
        if (body.method === "recovery_code") {
          // using a recovery code signals a lost device: every other session ends (decision D-3). With the atomic function that already happened together with consumption.
          try {
            if (outcome.atomic) await appendAudit(store, actor, "sessions_revoked_mfa_recovery_code", "admin_user", mfaUser.id, { request_id: ctx.requestId, trigger: "mfa_recovery_code", outcome: "revoked", atomic: true, generation_after: outcome.generation, at: new Date().toISOString() }, req);
            else await revokeSessionsFor({ store, config, target: mfaUser, auditActor: actor, trigger: "mfa_recovery_code", requestId: ctx.requestId, req, auditExtra: { atomic: false } });
            remaining = await store.countMfaRecoveryCodes(mfaUser.id);
          } catch { remaining = undefined; /* the code is spent and sessions are ended either way: record that FIRST (below), then report the fault */ }
          // the audit record and the owner notification are written BEFORE the session is issued, so a failure afterwards leaves an explained state (code spent, other sessions ended, owner told)
          await appendAudit(store, actor, "mfa_recovery_code_used", "admin_user", mfaUser.id, { request_id: ctx.requestId, recovery_codes_remaining: remaining, atomic: Boolean(outcome.atomic), at: new Date().toISOString() }, req).catch(() => {});
          await notifyMfaEvent({ store, config, user: mfaUser, event: "recovery_code_used", requestId: ctx.requestId, req });
          if (remaining === undefined) { json(res, 503, { error: "mfa_verification_unavailable", message: "Sign-in is temporarily unavailable." }, headersOut); return; }
        }
        try { await adminLoginRateLimiter.resetKey(limiterKey); await adminLoginRateLimiter.resetKey(loginAttemptKey(req, mfaUser.email)); } catch { /* windows expire on their own */ }
        const verifiedAt = Date.now();
        await store.updateAdminUser(mfaUser.id, { last_login_at: new Date(verifiedAt).toISOString() });
        await appendAudit(store, actor, "mfa_verified", "admin_user", mfaUser.id, { request_id: ctx.requestId, method: body.method, ...(remaining !== undefined ? { recovery_codes_remaining: remaining } : {}), at: new Date(verifiedAt).toISOString() }, req);
        await appendAudit(store, actor, "session_login", "admin_user", mfaUser.id, { mfa: true }, req);
        const { token: mfaToken, ttl: mfaTtl } = await issueSession(store, config, mfaUser, { mfaAt: verifiedAt });
        json(res, 200, { ok: true, admin: adminSummary(mfaUser), mfa: { verified: true, method: body.method, ...(remaining !== undefined ? { recovery_codes_remaining: remaining } : {}) } }, { ...headersOut, "set-cookie": createSessionCookie(mfaToken, config, mfaTtl.ttlMs) });
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/logout") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        // R4: revoke THIS session on the server, then clear the browser cookie. The session is identified only by the signature-verified, unexpired cookie (a person can always log out,
        // even if the account has since changed); nothing in the body or query is read. The browser cookie is cleared in every outcome. Only an honest result is reported.
        const logoutHeaders = { "set-cookie": clearSessionCookie(config), "x-request-id": ctx.requestId, "cache-control": "no-store" };
        const cookieSession = authenticateSessionCookie(req, config);
        let outcome = { revoked: false, reason: cookieSession ? "not_individually_revocable" : "no_session" };
        if (cookieSession && cookieSession.sessionId) {
          try {
            await store.revokeSessionDigest(sessionIdDigest(config, cookieSession.sessionId), cookieSession.userId, cookieSession.sessionExpiresAtMs);
            outcome = { revoked: true };
          } catch {
            outcome = { failed: true };
          }
        }
        const auditActor = cookieSession ? { userId: cookieSession.userId, email: cookieSession.email, role: cookieSession.role } : { type: authContext?.type || "unknown" };
        await appendAudit(store, auditActor, outcome.failed ? "session_logout_unconfirmed" : "session_logout", "session", cookieSession?.userId || "", { revoked: Boolean(outcome.revoked), ...(outcome.reason ? { reason: outcome.reason } : {}) }, req, outcome.failed ? "failure" : undefined).catch(() => {});
        if (outcome.failed) {
          json(res, 503, { ok: false, revoked: false, error: "logout_not_confirmed", message: "You were signed out in this browser, but the server could not confirm that this session was revoked. If you think the session was copied, use Sign out everywhere." }, logoutHeaders);
          return;
        }
        json(res, 200, { ok: true, revoked: outcome.revoked, ...(outcome.reason ? { reason: outcome.reason } : {}) }, logoutHeaders);
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/me") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        // S7.5.0: the same single cookie reader and the same single live-state check as every protected route (no private copy of either).
        const meContext = authenticateSessionCookie(req, config);
        if (!meContext) {
          json(res, 401, { error: "unauthorized" }, { "x-request-id": ctx.requestId });
          return;
        }
        let currentUser; let meEnrollment = null;
        try {
          const enrichedMe = await enrichAuthContext(meContext, store, config); currentUser = enrichedMe.user; meEnrollment = enrichedMe.mfaEnrollment || null;
        } catch (meError) {
          json(res, meError.statusCode === 503 ? 503 : 401, { error: meError.statusCode === 503 ? "session_verification_unavailable" : (["session_revoked", "mfa_required", "mfa_enrollment_required"].includes(meError.message) ? meError.message : "unauthorized") }, { "x-request-id": ctx.requestId });
          return;
        }
        json(
          res,
          200,
          {
            ok: true,
            mfa: { enabled: config.mfaMode === "on", verified: meContext.sessionMfa === true, ...(meEnrollment ? { enrollment: meEnrollment } : {}) },
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

      // ---- Settings S7.2 step-up authentication (contract: docs/settings-domain/21_S7_2_STEP_UP_AUTH_CONTRACT.md) ----
      // Enforcement middleware for future security-policy writes. Sends the 403 and returns null when the step-up authorisation is missing or invalid.
      // S7.5.6: with MFA on and a factor enrolled NOW, the grant must carry a verified second factor. Fails closed when the factor state cannot be read.
      const stepUpMfaGate = async (grant, purpose) => {
        if (config.mfaMode !== "on") return { ok: true };
        let enrolled;
        try { enrolled = Boolean(await store.hasActiveMfa(authContext.user.id)); } catch { return { ok: false, status: 503, error: "mfa_verification_unavailable" }; }
        return grantSatisfiesMfa(grant, { mfaRequired: enrolled }) ? { ok: true } : { ok: false, status: 403, error: "step_up_required", reason: "mfa_required" };
      };
      const requireStepUp = async (purpose) => {
        const result = verifyStepUpToken({ config, authContext, purpose, token: req.headers[STEP_UP_HEADER] });
        if (!result.ok) {
          json(res, 403, { error: "step_up_required", reason: result.reason, purpose }, { "x-request-id": ctx.requestId });
          return null;
        }
        const gate = await stepUpMfaGate(result, purpose);
        if (!gate.ok) {
          json(res, gate.status, { error: gate.error, ...(gate.reason ? { reason: gate.reason, purpose } : {}) }, { "x-request-id": ctx.requestId });
          return null;
        }
        return result;
      };

      if (pathname === "/api/lead-agents/admin/session/step-up") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        if (!validateAuthConfig(config).valid) {
          json(res, 503, { error: "auth_configuration_invalid", message: "Verification is temporarily unavailable." }, { "x-request-id": ctx.requestId });
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const purpose = String(body.purpose || "");
        const stepUpAudit = (outcome, failureReason, factor) => appendAudit(
          store,
          authContext && authContext.type === "session" ? authContext : { type: authContext?.type || "unknown" },
          outcome === "verified" ? "step_up_verified" : "step_up_failed",
          "admin_user",
          authContext?.user?.id || "",
          { request_id: ctx.requestId, purpose: STEP_UP_PURPOSES.includes(purpose) ? purpose : "invalid", outcome, ...(failureReason ? { failure_reason: failureReason } : {}), ...(factor ? { second_factor: factor } : {}), at: new Date().toISOString() },
          req
        );
        if (authContext?.type !== "session") {
          await stepUpAudit("failed", "api_key_not_allowed");
          json(res, 403, { error: "step_up_session_required", message: "Step-up verification requires a signed-in administrator." }, { "x-request-id": ctx.requestId });
          return;
        }
        if (stepUpEligibility(authContext, purpose)) {
          await stepUpAudit("failed", "forbidden");
          json(res, 403, { error: "forbidden" }, { "x-request-id": ctx.requestId });
          return;
        }
        if (!STEP_UP_PURPOSES.includes(purpose)) {
          await stepUpAudit("failed", "invalid_purpose");
          json(res, 400, { error: "invalid_purpose" }, { "x-request-id": ctx.requestId });
          return;
        }
        // S7.5.4: managing one's own factors. When the account has an active factor, the grant must carry a FRESH second factor: a TOTP code in this request, or a sign-in whose MFA
        // proof is itself fresh. A persisted lock applies (checked BEFORE the password so the answer reveals nothing about it).
        const mfaStepUp = config.mfaMode === "on";
        if (mfaStepUp) {
          try {
            const lockState = await store.getMfaLockState(authContext.user.id);
            const lockedFor = lockState && lockState.locked_until ? Date.parse(lockState.locked_until) - Date.now() : 0;
            if (lockedFor > 0) { await stepUpAudit("failed", "mfa_locked"); json(res, 429, { error: "mfa_locked", retry_after_seconds: Math.ceil(lockedFor / 1000) }, { "x-request-id": ctx.requestId }); return; }
          } catch { json(res, 503, { error: "mfa_verification_unavailable" }, { "x-request-id": ctx.requestId }); return; }
        }
        const stepUpKeyId = `step-up|${loginAttemptKey(req, authContext.user.email)}`;
        const guessKey = `user:${authContext.user.id}`;
        try {
          await adminLoginRateLimiter.checkKey(stepUpKeyId);
          if (await passwordGuessLimiter.isLimited(guessKey)) { const limited = new Error("rate_limit_exceeded"); limited.statusCode = 429; throw limited; } // R6 (H4): per-account wrong-password ceiling, whatever the address
        } catch (error) {
          if (!isRateLimitHit(error)) { json(res, 503, { error: "step_up_unavailable" }, { "x-request-id": ctx.requestId }); return; }
          await stepUpAudit("failed", "rate_limited");
          json(res, 429, { error: "step_up_rate_limit_exceeded", message: "Too many verification attempts. Please wait a few minutes and try again." }, { "x-request-id": ctx.requestId });
          return;
        }
        if (typeof body.password !== "string" || !body.password || !verifyPassword(body.password, authContext.user.password_hash)) {
          try { await passwordGuessLimiter.hit(guessKey); } catch { json(res, 503, { error: "step_up_unavailable" }, { "x-request-id": ctx.requestId }); return; }
          await stepUpAudit("failed", "invalid_password");
          json(res, 401, { error: "step_up_failed", message: "That verification could not be completed." }, { "x-request-id": ctx.requestId }); // R8: identical to every other step-up refusal (no oracle on which part was wrong)
          return;
        }
        let grantHasFactor = false, secondFactor = "none", secondFactorAt;
        if (mfaStepUp) {
          let hasFactor;
          try { hasFactor = Boolean(await store.hasActiveMfa(authContext.user.id)); } catch { json(res, 503, { error: "mfa_verification_unavailable" }, { "x-request-id": ctx.requestId }); return; }
          if (hasFactor && !validateMfaConfig(config).valid) { await stepUpAudit("failed", "mfa_unavailable"); json(res, 503, { error: "mfa_unavailable" }, { "x-request-id": ctx.requestId }); return; }
          if (hasFactor) {
            const fresh = authContext.sessionMfa === true && Date.now() - (authContext.sessionMfaAt || 0) <= MFA_FRESH_MS;
            const mfaIn = body.mfa && typeof body.mfa === "object" ? body.mfa : null;
            const viaTotp = mfaIn && mfaIn.method === "totp" && typeof mfaIn.code === "string" && mfaIn.code.length <= 32;
            const viaWebauthn = mfaIn && mfaIn.method === "webauthn" && typeof mfaIn.challenge_id === "string" && mfaIn.response && typeof mfaIn.response === "object";
            if (viaTotp || viaWebauthn) {
              let proved;
              try {
                if (!validateMfaConfig(config).valid) throw new Error("mfa_unavailable");
                if (viaWebauthn) { proved = await checkWebauthnAssertion({ store, config, user: authContext.user, challengeId: mfaIn.challenge_id, response: mfaIn.response }); if (!proved.ok && (proved.reason === "counter_rollback" || proved.reason === "counter")) await appendAudit(store, authContext, "mfa_webauthn_counter_rollback", "admin_user", authContext.user.id, { request_id: ctx.requestId, at: new Date().toISOString() }, req, "failure").catch(() => {}); }
                else { const lib = createMfaCrypto(config); const credential = await store.getActiveTotpCredential(authContext.user.id); proved = credential ? await lib.verifyAndConsumeTotp({ store, userId: authContext.user.id, credentialId: credential.id, code: mfaIn.code }) : { ok: false }; }
                if (!proved.ok) await store.recordMfaFailure(authContext.user.id);
              } catch { json(res, 503, { error: "mfa_unavailable" }, { "x-request-id": ctx.requestId }); return; }
              if (!proved.ok) { await stepUpAudit("failed", "invalid_second_factor"); json(res, 401, { error: "step_up_failed", message: "That verification could not be completed." }, { "x-request-id": ctx.requestId }); return; }
              try { await store.clearMfaFailures(authContext.user.id); } catch { /* heals on the next success */ }
              grantHasFactor = true; secondFactor = viaWebauthn ? "webauthn" : "totp"; secondFactorAt = Date.now();
            } else if (fresh) {
              grantHasFactor = true; secondFactor = "session_proof"; secondFactorAt = authContext.sessionMfaAt;
            } else {
              await stepUpAudit("failed", "second_factor_required");
              json(res, 401, { error: "step_up_failed", message: "That verification could not be completed." }, { "x-request-id": ctx.requestId }); // same answer as a wrong password: no oracle
              return;
            }
          }
        }
        try { await adminLoginRateLimiter.resetKey(stepUpKeyId); await passwordGuessLimiter.resetKey(guessKey); } catch { /* windows expire on their own */ }
        const grant = issueStepUpToken({ config, authContext, purpose, mfa: grantHasFactor, mfaAt: secondFactorAt });
        await stepUpAudit("verified", undefined, secondFactor);
        json(res, 200, { ok: true, step_up: { ...grant, mfa_verified: grantHasFactor, ...(grantHasFactor ? { second_factor: secondFactor } : {}) } }, { "x-request-id": ctx.requestId, "cache-control": "no-store" });
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/step-up/check") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const verified = await requireStepUp(String(body.purpose || ""));
        if (!verified) return;
        json(res, 200, { valid: true, purpose: verified.purpose, expires_at: new Date(verified.expiresAt).toISOString() }, { "x-request-id": ctx.requestId, "cache-control": "no-store" });
        return;
      }

      // ---- Settings S7.5.7: enforcement preflight (read) and administrator MFA reset (contract: docs/settings-domain/34_S7_5_7_MFA_ENFORCEMENT_AND_RECOVERY_CONTRACT.md) ----
      if (pathname === "/api/lead-agents/admin/session/mfa/enforcement/preflight") {
        if (req.method !== "GET") { methodNotAllowed(res, "GET"); return; }
        if (authContext?.type !== "session") { json(res, 403, { error: "actor_identity_required" }, { "x-request-id": ctx.requestId }); return; }
        try { authorizePermission(authContext, "staff.manage"); } catch { json(res, 403, { error: "forbidden" }, { "x-request-id": ctx.requestId }); return; }
        let enforcementNow;
        try { enforcementNow = await resolveEnforcement(store, config); } catch { json(res, 503, { error: "preflight_unavailable" }, { "x-request-id": ctx.requestId }); return; }
        const level = new URL(req.url, "http://office.local").searchParams.get("level") || enforcementNow.level;
        if (!ENFORCEMENT_LEVELS.includes(level)) { json(res, 400, { error: "invalid_level", allowed: ENFORCEMENT_LEVELS }, { "x-request-id": ctx.requestId }); return; }
        let result;
        try { result = await runPreflight({ store, config, actor: authContext.user, level, policy: enforcementNow }); } catch { json(res, 503, { error: "preflight_unavailable" }, { "x-request-id": ctx.requestId }); return; }
        json(res, 200, { ...result, current: { level: enforcementNow.level, status: enforcementNow.status, active: enforcementNow.active, version: enforcementNow.version, effective_since: enforcementNow.effectiveSince }, recovery: recoverySummary(config) }, { "x-request-id": ctx.requestId, "cache-control": "no-store" });
        return;
      }

      const mfaResetMatch = pathname.match(/^\/api\/lead-agents\/admin\/users\/([^/]+)\/mfa\/reset$/);
      if (mfaResetMatch) {
        if (req.method !== "POST") { methodNotAllowed(res, "POST"); return; }
        const targetId = mfaResetMatch[1];
        const denied = async (status, error, category, extra) => {
          await appendAudit(store, authContext?.type === "session" ? authContext : { type: authContext?.type || "unknown" }, "mfa_reset_denied", "admin_user", targetId, { request_id: ctx.requestId, category, at: new Date().toISOString() }, req, "failure").catch(() => {});
          json(res, status, { error, ...(extra || {}) }, { "x-request-id": ctx.requestId, "cache-control": "no-store" });
        };
        if (authContext?.type !== "session") return denied(403, "actor_identity_required", "api_key_not_allowed");
        if (config.mfaMode !== "on" || !validateMfaConfig(config).valid) return denied(503, "mfa_unavailable", "mfa_unavailable");
        if (authContext.role !== "super_admin") return denied(403, "forbidden", "not_super_admin");
        try { authorizePermission(authContext, "team.manage"); } catch { return denied(403, "forbidden", "permission_missing"); }
        const grant = verifyStepUpToken({ config, authContext, purpose: "mfa_management", token: req.headers[STEP_UP_HEADER] });
        if (!grant.ok) return denied(403, "step_up_required", `step_up_${grant.reason}`, { reason: grant.reason, purpose: "mfa_management" });
        // a reset of someone else's factors always needs the actor's own FRESH second factor (so the actor must be enrolled), never the password alone
        if (grant.mf !== true) return denied(403, "step_up_required", "second_factor_required", { reason: "mfa_required", purpose: "mfa_management" });
        const body = await readJsonBody(req).catch(() => null);
        if (!body || typeof body !== "object") return denied(400, "invalid_body", "invalid_body");
        const reason = typeof body.reason === "string" ? body.reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
        if (reason.length < 3 || reason.length > 500) return denied(400, "reason_required", "reason_invalid");
        if (body.confirm !== true) return denied(400, "confirmation_required", "confirmation_missing");
        if (String(targetId) === String(authContext.user.id)) return denied(400, "use_self_service", "self_target");
        let target;
        try { target = await store.getAdminUserById(targetId); } catch { return denied(503, "mfa_verification_unavailable", "store_error"); }
        if (!target) return denied(404, "user_not_found", "target_not_found");
        if (normalizeEmail(body.confirm_email) !== normalizeEmail(target.email)) return denied(400, "confirmation_mismatch", "confirmation_mismatch");
        if (target.status !== "active") return denied(409, "target_inactive", "target_inactive");
        try {
          if (target.role === "super_admin") {
            const [users, enrolled] = await Promise.all([store.listAdminUsers(), store.listMfaEnrolledUserIds()]);
            const enrolledSet = new Set(enrolled);
            // protect the last recoverable super administrator: someone ELSE must still be able to sign in with a factor and reset others
            if (!users.some((u) => u.status === "active" && u.role === "super_admin" && u.id !== target.id && enrolledSet.has(u.id))) return denied(409, "last_recoverable_super_admin", "last_recoverable");
          }
        } catch { return denied(503, "mfa_verification_unavailable", "store_error"); }
        let result;
        try {
          await store.updateAdminUser(target.id, { mfa_required_after: new Date().toISOString() }); // first: if the next step fails the account is at worst required to enrol
          result = await store.resetMfa(target.id, { actor: authContext.user.email });
          if (!result) return denied(404, "user_not_found", "target_not_found");
          await store.clearMfaFailures(target.id).catch(() => {});
        } catch { return denied(503, "mfa_reset_unavailable", "store_error"); }
        invalidateEnforcementCache(config);
        await appendAudit(store, authContext, "mfa_reset_by_admin", "admin_user", target.id, { request_id: ctx.requestId, target_user_id: target.id, target_email: target.email, reason, credentials_revoked: result.credentials_revoked, recovery_codes_deleted: result.codes_deleted, generation_after: result.session_generation, at: new Date().toISOString() }, req);
        const notification = await notifyMfaEvent({ store, config, user: target, event: "reset_by_admin", requestId: ctx.requestId, req });
        json(res, 200, { ok: true, target_user_id: target.id, credentials_revoked: result.credentials_revoked, recovery_codes_deleted: result.codes_deleted, session_generation: result.session_generation, re_enrollment_required: true, notification }, { "x-request-id": ctx.requestId, "cache-control": "no-store" });
        return;
      }

      // ---- Settings S7.4 session revocation (contract: docs/settings-domain/24_S7_4_SESSION_REVOCATION_IMPLEMENTATION_CONTRACT.md) ----
      if (pathname === "/api/lead-agents/admin/session/revoke-all") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        if (authContext?.type !== "session") {
          await appendAudit(store, { type: authContext?.type || "unknown" }, "session_revocation_denied", "admin_user", "", { request_id: ctx.requestId, trigger: "self", outcome: "denied", failure_reason: "api_key_not_allowed", at: new Date().toISOString() }, req, "failure");
          json(res, 403, { error: "actor_identity_required" }, { "x-request-id": ctx.requestId });
          return;
        }
        let body = {};
        try { body = await readJsonBody(req); } catch { body = {}; }
        const keepCurrent = Boolean(body && body.keep_current === true);
        const result = await revokeSessionsFor({ store, config, target: authContext.user, auditActor: authContext, trigger: "self", requestId: ctx.requestId, req, required: true });
        const kept = keepCurrent ? await issueSession(store, config, await store.getAdminUserById(authContext.user.id), { mfaAt: authContext.sessionMfa ? authContext.sessionMfaAt || Date.now() : undefined }) : null;
        json(res, 200, { ok: true, user_id: authContext.user.id, session_generation: result.generation_after, revoked_at: result.revoked_at, kept_current: Boolean(kept), scope: "every_server_running_this_version" }, { "x-request-id": ctx.requestId, "cache-control": "no-store", "set-cookie": kept ? createSessionCookie(kept.token, config, kept.ttl.ttlMs) : clearSessionCookie(config) });
        return;
      }

      const revokeUserMatch = pathname.match(/^\/api\/lead-agents\/admin\/users\/([^/]+)\/revoke-sessions$/);
      if (revokeUserMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        const denied = async (status, error, category, extra = {}) => {
          await appendAudit(store, authContext?.type === "session" ? authContext : { type: authContext?.type || "unknown" }, "session_revocation_denied", "admin_user", revokeUserMatch[1], { request_id: ctx.requestId, trigger: "admin", outcome: "denied", failure_reason: category, at: new Date().toISOString() }, req, "failure");
          json(res, status, { error, ...extra }, { "x-request-id": ctx.requestId });
        };
        if (authContext?.type !== "session") return denied(403, "actor_identity_required", "api_key_not_allowed");
        try { authorizePermission(authContext, "team.manage"); } catch { return denied(403, "forbidden", "forbidden"); }
        const stepUp = verifyStepUpToken({ config, authContext, purpose: "session_revocation", token: req.headers[STEP_UP_HEADER] });
        if (!stepUp.ok) return denied(403, "step_up_required", `step_up_${stepUp.reason}`, { reason: stepUp.reason, purpose: "session_revocation" });
        const revokeGate = await stepUpMfaGate(stepUp, "session_revocation");
        if (!revokeGate.ok) return denied(revokeGate.status, revokeGate.error, "step_up_mfa_required", revokeGate.reason ? { reason: revokeGate.reason, purpose: "session_revocation" } : undefined);
        const body = await readJsonBody(req).catch(() => ({}));
        const target = await store.getAdminUserById(revokeUserMatch[1]);
        if (!target) return denied(404, "user_not_found", "target_not_found");
        if (String(target.id) === String(authContext.user.id)) return denied(400, "use_self_revocation", "self_target");
        const result = await revokeSessionsFor({ store, config, target, auditActor: authContext, trigger: "admin", requestId: ctx.requestId, req, reason: body && typeof body.reason === "string" ? body.reason : null, required: true });
        json(res, 200, { ok: true, user_id: target.id, session_generation: result.generation_after, revoked_at: result.revoked_at, scope: "every_server_running_this_version" }, { "x-request-id": ctx.requestId, "cache-control": "no-store" });
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/password") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "change_password");
        requireHumanSession(authContext);
        const body = await readJsonBody(req);
        requireObject(body, "body");
        if (!body.current_password || !body.new_password) {
          json(res, 400, { error: "current_password and new_password are required" });
          return;
        }
        // R6 (H4): bounded guessing of the current password. Network dimension (address + account) and account dimension (wrong guesses per account id). The answers stay generic:
        // 401 for any wrong password, 429 once a budget is spent (also for the right password: a tripped limiter refuses everything until the window ends).
        const pwKey = `session-password|${loginAttemptKey(req, authContext.email)}`;
        const pwGuessKey = `user:${authContext.userId || authContext.user?.id || normalizeEmail(authContext.email)}`;
        try {
          await adminLoginRateLimiter.checkKey(pwKey);
          if (await passwordGuessLimiter.isLimited(pwGuessKey)) { const limited = new Error("rate_limit_exceeded"); limited.statusCode = 429; throw limited; }
        } catch (error) {
          if (!isRateLimitHit(error)) { json(res, 503, { error: "password_change_unavailable" }, { "x-request-id": ctx.requestId }); return; }
          json(res, 429, { error: "password_rate_limit_exceeded", message: "Too many attempts. Please wait a few minutes and try again." }, { "x-request-id": ctx.requestId });
          return;
        }
        requireHumanSession(authContext);
        const currentUser = await store.getAdminUserByEmail(authContext.user.email);
        if (!currentUser || !verifyPassword(body.current_password, currentUser.password_hash)) {
          try { await passwordGuessLimiter.hit(pwGuessKey); } catch { json(res, 503, { error: "password_change_unavailable" }, { "x-request-id": ctx.requestId }); return; }
          json(res, 401, { error: "unauthorized" });
          return;
        }
        try { await adminLoginRateLimiter.resetKey(pwKey); await passwordGuessLimiter.resetKey(pwGuessKey); } catch { /* windows expire on their own */ }
        if (rejectPasswordViolation(res, body.new_password, ctx)) return;
        // S7.4: bump first (fail-safe order), then write the password, then re-issue THIS browser's cookie at the new generation; every other session is signed out.
        const { user: updated, status: revocationStatus } = await applyCredentialChange({ store, config, target: currentUser, patch: { password_hash: hashPassword(body.new_password), password_changed_at: new Date().toISOString() }, auditActor: authContext, trigger: "password_change", requestId: ctx.requestId, req });
        const revocation = { status: revocationStatus };
        await appendAudit(store, authContext, "password_changed", "admin_user", currentUser.id, {});
        const reissued = revocation.status === "revoked" ? await issueSession(store, config, updated || currentUser, { mfaAt: authContext.sessionMfa ? authContext.sessionMfaAt || Date.now() : undefined }) : null;
        json(res, 200, { ok: true, user: sanitizeAdminUser(updated), other_sessions_signed_out: revocation.status === "revoked" }, { "x-request-id": ctx.requestId, ...(reissued ? { "set-cookie": createSessionCookie(reissued.token, config, reissued.ttl.ttlMs) } : {}) });
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
        requireHumanSession(authContext);
        const currentUser = await store.getAdminUserByEmail(authContext.user.email);
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

      // Genuine self-service profile editing -- deliberately the ONLY
      // route (besides /session/photo above) any team member can use to
      // change their own admin_users row, and deliberately narrow: only
      // `phone` is ever read off the body. Organisation-controlled
      // fields (role/status/office_position/permission_scopes) are only
      // reachable via the team.manage-gated admin routes, never here --
      // this is a real server-side boundary, not a client-side hide.
      if (pathname === "/api/lead-agents/admin/session/profile") {
        if (req.method !== "PATCH") {
          methodNotAllowed(res, "PATCH");
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        requireHumanSession(authContext);
        const currentUser = await store.getAdminUserByEmail(authContext.user.email);
        if (!currentUser) {
          json(res, 401, { error: "unauthorized" });
          return;
        }
        const patch = {};
        if (body.phone !== undefined) patch.phone = String(body.phone || "").trim();
        if (!Object.keys(patch).length) {
          json(res, 400, { error: "no_editable_fields_supplied" }, { "x-request-id": ctx.requestId });
          return;
        }
        const updated = await store.updateAdminUser(currentUser.id, patch);
        await appendAudit(store, authContext, "admin_user_profile_updated", "admin_user", currentUser.id, { email: currentUser.email, self_service: true, fields: Object.keys(patch) });
        json(res, 200, { user: sanitizeAdminUser(updated) }, { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/session/invite/accept") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        if (!validateAuthConfig(config).valid) {
          json(res, 503, { error: "auth_configuration_invalid", message: "Sign-in is temporarily unavailable." }, { "x-request-id": ctx.requestId });
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        if (typeof body.token !== "string" || typeof body.password !== "string" || !body.token || !body.password) {
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
        if (rejectPasswordViolation(res, body.password, ctx)) return;
        // S7.5.0: claim the single-use invite first; release it if the account could not be activated.
        const claimedInvite = await store.claimAdminInvite(invite.id);
        if (!claimedInvite) {
          json(res, 400, { error: "invalid_or_expired_invite" });
          return;
        }
        let user;
        try {
          user = await store.updateAdminUser(existingUser.id, {
            password_hash: hashPassword(body.password),
            role: invite.role || "viewer",
            display_name: body.display_name || invite.display_name || invite.email,
            office_position: invite.office_position || "",
            phone: invite.phone || existingUser.phone || "",
            status: "active",
            password_changed_at: new Date().toISOString(),
          });
        } catch (error) {
          await store.releaseAdminInvite(invite.id).catch(() => {});
          throw error;
        }
        await appendAudit(
          store,
          { userId: user.id, email: user.email, role: user.role },
          "invite_accepted",
          "admin_invite",
          invite.id,
          { email: invite.email }
        );
        const { token, ttl: sessionTtl } = await issueSession(store, config, user);
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
            "set-cookie": createSessionCookie(token, config, sessionTtl.ttlMs),
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
        if (typeof body.token !== "string" || typeof body.new_password !== "string" || !body.token || !body.new_password) {
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
          json(res, 400, { error: "invalid_or_expired_reset" });
          return;
        }
        if (rejectPasswordViolation(res, body.new_password, ctx)) return;
        // S7.5.0: claim the single-use token FIRST (compare-and-set), so two simultaneous confirmations cannot both succeed; release it if the password could not be written.
        const claimedReset = await store.claimPasswordResetToken(reset.id);
        if (!claimedReset) {
          json(res, 400, { error: "invalid_or_expired_reset" });
          return;
        }
        try {
          await applyCredentialChange({ store, config, target: user, patch: { password_hash: hashPassword(body.new_password), password_changed_at: new Date().toISOString() }, auditActor: { userId: user.id, email: user.email, role: user.role }, trigger: "password_reset", requestId: ctx.requestId, req });
        } catch (error) {
          await store.releasePasswordResetToken(reset.id).catch(() => {});
          throw error;
        }
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

      // Settings S7.5.8: the MFA interface module and its vendored, pinned QR generator (read-only, public like the rest of the Office shell: the login challenge needs them before a session exists)
      if (pathname === "/office/mfa-ui.mjs" || pathname === "/office/vendor/qrcode-generator.mjs") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        await serveFile(res, path.join(process.cwd(), "public", "office", pathname === "/office/mfa-ui.mjs" ? "mfa-ui.mjs" : path.join("vendor", "qrcode-generator.mjs")));
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

        const body = publicRequestIdentity(config, await readJsonBody(req, 32 * 1024));
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
          session: { ...session, session_token: issuePublicSession(config, session, body.lead_id) },
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
          authorizePermission(authContext, "planstudio.read");
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
        authorizePermission(authContext, "planstudio.read");
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
        const coreRequest = await buildOyiCoreOfficeInternalRequest({
          authContext, message: String(body.question).slice(0, 2000),
          body: {}, requestId: ctx.requestId, config,
        });
        const geometry = project.analysis?.geometry || {};
        // Only this authenticated server-loaded project path supplies plan
        // evidence. The generic chat proxy does not forward a browser slot.
        coreRequest.plan_review_context = {
          project_id: project.id, name: project.name, updated_at: project.updated_at || null,
          zones: (Array.isArray(geometry.zones) ? geometry.zones : []).slice(0, 80).map(zone => ({ label: zone.label, kind: zone.kind })),
          pathway_count: Array.isArray(geometry.pathways) ? geometry.pathways.length : null,
          opening_count: Array.isArray(geometry.openings) ? geometry.openings.length : null,
          draft_counts: Object.fromEntries(["cctv", "access_points", "sensors", "power_outlets"].map(key => [key, project.analysis?.summary?.[key]])),
        };
        const result = await callOyiCoreOfficeInternalConversation(config, coreRequest);
        const acknowledgement = result.response?.safe_metadata?.plan_review;
        if (!result.ok || !result.response?.answer || acknowledgement?.version !== 1
          || acknowledgement.capability !== "office.plan_studio.review"
          || acknowledgement.result !== "answered" || acknowledgement.advisory_only !== true) {
          json(res, 503, { error: "oyi_core_unavailable", reply: "Oyi Core plan review is unavailable. No local assessment was generated." });
          return;
        }
        json(res, 200, { reply: result.response.answer, intelligence_authority: "ochiga-backend", advisory_only: true }, { "x-request-id": ctx.requestId });
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

        const body = publicRequestIdentity(config, await readJsonBody(req));
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
        session.session_token = issuePublicSession(config, session, lead.id);
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
            lead: { id: lead.id },
            public_intelligence: {
              session: {
                ...session,
                known_contact: Boolean(lead.id),
                crm_contact_ref: lead.id ? "office_lead_record" : null,
              },
              oyi_core_request: { request_id: ctx.requestId, public_session_id: session.session_id },
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
          lead: { id: finalLead.id },
          trace_id: ctx.requestId,
          lead_memory: null,
          knowledge_hits: Array.isArray(oyiCoreResponse.knowledge_references) ? oyiCoreResponse.knowledge_references : [],
          assistant_message: oyiCoreResponse.answer || "",
          tools: governedTools.results,
          conversations: [], // CRM history may contain staff-private notes.
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
              session_token: issuePublicSession(config, { ...session, conversation_thread_id: oyiCoreResponse.conversation_thread_id || session.conversation_thread_id }, finalLead.id),
              active_agent_role: oyiCoreResponse.recommended_internal_role || session.active_agent_role,
              known_contact: Boolean(result.lead?.id),
              crm_contact_ref: result.lead?.id ? "office_lead_record" : null,
            },
            oyi_core_request: { request_id: ctx.requestId, public_session_id: session.session_id },
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
          opportunity: crm?.opportunity || null,
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
        const memory = await recallCrmMemory({ store, actor: authContext, leadId: memoryMatch[1] });
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
        // Wave 8 Slice 4 prerequisite (Section 16) -- only when the
        // caller explicitly names a real Opportunity AND this call
        // actually produced a "qualified" outcome (never guessed among
        // this lead's possibly-several opportunities; legacy Lead-only
        // behavior above is completely unaffected either way). Evidence
        // identity is this specific HTTP request's own id -- a real,
        // stable identity for THIS write, though it does not (and is not
        // claimed to) dedupe genuinely separate re-qualification calls
        // for the same lead/opportunity over time -- disclosed limitation,
        // see the implementation doc's Section 10.
        let opportunityTransition = null;
        if (body.opportunity_id && qualification.qualification_status === "qualified") {
          const opportunityRecord = await findOpportunityRecord(store, String(body.opportunity_id));
          if (opportunityRecord) {
            opportunityTransition = await safeTransitionOpportunity(
              store,
              { opportunityId: opportunityRecord.id, targetStage: "qualified", evidenceType: "qualification_completed", evidenceId: ctx.requestId },
              { actorEmail: authContext?.email || "office" }
            );
          }
        }
        json(res, 200, { lead: updated, qualification, opportunity_transition: opportunityTransition }, { "x-request-id": ctx.requestId });
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
        // Wave 8 Slice 4 prerequisite (Section 17) -- same treatment as
        // qualification (Section 16): only when the caller explicitly
        // names a real Opportunity, no fuzzy resolution among a lead's
        // possibly-several opportunities. body.approved === false targets
        // "negotiation" (an unblocking step, not a loss); true targets
        // "commercial_approved" -- both real OPPORTUNITY_STAGE_TRANSITIONS
        // edges, but only reachable from proposal_sent/negotiation, so a
        // premature approval call honestly fails (safeTransitionOpportunity
        // reports it, never breaks the Lead write above).
        let opportunityTransition = null;
        if (body.opportunity_id) {
          const opportunityRecord = await findOpportunityRecord(store, String(body.opportunity_id));
          if (opportunityRecord) {
            opportunityTransition = await safeTransitionOpportunity(
              store,
              {
                opportunityId: opportunityRecord.id,
                targetStage: body.approved === false ? "negotiation" : "commercial_approved",
                evidenceType: "commercial_approval",
                evidenceId: ctx.requestId,
              },
              { actorEmail: authContext?.email || "office" }
            );
          }
        }
        json(res, 200, { lead: updatedLead, opportunity_transition: opportunityTransition }, { "x-request-id": ctx.requestId });
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
        // Smallest safe idempotency guard for the double-submit bug: a
        // Portfolio record that's already linked to a real Backend estate
        // must never be provisioned a second time (e.g. two rapid clicks
        // on the New Facility dialog before its submit button disabled,
        // or a duplicate "Retry provisioning" click). The client-side fix
        // in openDialog's submit handler is the primary guard; this is
        // the server-side backstop for the one case that matters --
        // re-provisioning the SAME already-linked Portfolio record.
        if (portfolioRecord.backend_estate_id) {
          const existingWorkspaces = await store.listFacilityWorkspacesByPortfolioIds([portfolioId]);
          json(
            res,
            200,
            { workspace: existingWorkspaces[0] || null, provisioning: { ok: true, already_provisioned: true, estate: { id: portfolioRecord.backend_estate_id } } },
            { "x-request-id": ctx.requestId }
          );
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
          // Same host fix as initial provisioning -- facilityAppUrl (the
          // real facility-oyi frontend), never officeFacilityBaseUrl
          // (Office->Backend's own facility-export API surface).
          const activationLink = `${config.facilityAppUrl}/facility-invite?token=${encodeURIComponent(result.activation_token)}`;
          // Same missing-envelope bug as initial provisioning: the
          // template's return value has no `to`, so it must be attached
          // by the caller. Backend's resend response already returns the
          // invite's own persisted invited_email (invites.invited_email)
          // -- the authoritative source, not a copy -- so use that
          // directly rather than Office's own bookkeeping field.
          const emailResult = await sendOfficeEmail(config, {
            to: result.invite?.invited_email,
            ...facilityOwnerInviteEmail({ estateName, inviteUrl: activationLink, expiresAt: result.invite?.expires_at }),
          }).catch((err) => ({ delivered: false, skipped: true, reason: err?.message || "email_send_failed" }));
          if (workspace) {
            await store.updateFacilityWorkspace(workspace.id, {
              // Same truthful distinction as initial provisioning -- a
              // rotated, valid invite is not the same fact as an emailed
              // one.
              status: emailResult.delivered ? "invitation_sent" : "invitation_undelivered",
              activation_link: activationLink,
              checklist: {
                ...(workspace.checklist || {}),
                facility_admin_invite: emailResult.delivered ? "sent" : "ready_to_send",
                onboarding_email: emailResult.delivered ? "sent" : "not_delivered",
              },
              notes: emailResult.delivered
                ? workspace.notes
                : `Invitation rotated and valid, but the owner email was not delivered (${emailResult.reason || "unknown reason"}, provider: ${emailResult.provider || config.officeEmailProvider || "none"}). Fix delivery, then use Resend Invite again -- do not re-provision.`,
            });
          }
          await appendAudit(store, authContext, "facility_invitation_resent", "portfolio", portfolioRecord.id, {
            backend_estate_id: estateId,
            email_delivered: Boolean(emailResult.delivered),
            email_delivery_reason: emailResult.delivered ? undefined : emailResult.reason || "unknown",
            email_provider: emailResult.provider || config.officeEmailProvider || "none",
          });
          json(
            res,
            200,
            {
              ok: true,
              email_delivered: Boolean(emailResult.delivered),
              email_delivery_reason: emailResult.delivered ? undefined : emailResult.reason || "unknown",
            },
            { "x-request-id": ctx.requestId }
          );
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
          // Wave 8 Slice 4 prerequisite -- explicit only (Section 11):
          // opportunity_id is accepted from the caller's own request
          // body, never inferred from leadId (a lead can have several
          // simultaneous Opportunities -- guessing among them would be
          // dishonest). Validated against a real row when supplied so a
          // typo/stale id can't silently create an orphaned reference.
          let opportunityId = null;
          if (body.opportunity_id) {
            const opportunityRecord = await findOpportunityRecord(store, String(body.opportunity_id));
            if (!opportunityRecord) {
              const error = new Error("opportunity_not_found");
              error.statusCode = 404;
              throw error;
            }
            opportunityId = opportunityRecord.id;
          }
          const proposal = await store.createProposal({
            lead_id: leadId,
            opportunity_id: opportunityId,
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
          // Wave 8 Slice 4 prerequisite -- additive alongside the
          // existing Lead-level write above (Section 14: preserve Lead
          // compatibility, never remove it). Only fires when this
          // proposal is explicitly linked to a real Opportunity (Section
          // 12/16) -- never inferred, never applied to "the lead's
          // opportunities" as a group. "sent"/"accepted"/"declined" are
          // the same three proposal states the EXISTING Lead-level write
          // above already treats as real business events; "declined" ->
          // "lost" mirrors that exact existing judgment (lost_reason:
          // "proposal_declined" above), not an invented new semantic
          // (Section 13).
          let opportunityTransition = null;
          if (opportunityId && ["sent", "accepted", "declined"].includes(proposalStatus)) {
            const targetStage = proposalStatus === "accepted" ? "won" : proposalStatus === "declined" ? "lost" : "proposal_sent";
            opportunityTransition = await safeTransitionOpportunity(
              store,
              {
                opportunityId,
                targetStage,
                evidenceType: `proposal_${proposalStatus}`,
                evidenceId: proposal.id,
              },
              { actorEmail: authContext?.email || "office" }
            );
          }
          json(res, 201, { proposal, lead: updatedLead, opportunity_transition: opportunityTransition }, { "x-request-id": ctx.requestId });
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

      // Intelligence System Visibility, Slice 1 -- same "view_traces"
      // read gate as the observability-events route above (this is the
      // same Intelligence area, not a new permission surface). Thin
      // pass-through to Backend's live capability registry; never
      // fabricates a count when Backend is unreachable.
      if (pathname === "/api/lead-agents/admin/intelligence/capabilities") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const result = await callOyiCoreIntelligenceCapabilities(config);
        json(
          res,
          200,
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/intelligence/summary") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const result = await callOyiCoreIntelligenceSummary(config);
        json(
          res,
          200,
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      // Intelligence System Visibility, Slice 2 -- same "view_traces" read
      // gate as the two Slice 1 routes above (same Intelligence area, not
      // a new permission surface). Thin pass-through to Backend's Overview
      // read model; never fabricates data when Backend is unreachable.
      if (pathname === "/api/lead-agents/admin/intelligence/overview") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const result = await callOyiCoreIntelligenceOverview(config);
        json(
          res,
          200,
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/intelligence/interventions") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const interventionsUrl = new URL(req.url, "http://localhost");
        const requestedLimit = Number(interventionsUrl.searchParams.get("limit"));
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(Math.floor(requestedLimit), 200) : 50;
        const result = await callOyiCoreIntelligenceInterventions(config, { limit });
        json(
          res,
          200,
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      // Intelligence System Visibility, Slice 3 -- same "view_traces" read
      // gate as the Slice 1/2 Intelligence routes above (same Intelligence
      // area, not a new permission surface). Thin pass-through to
      // Backend's per-worker read model; never fabricates data when
      // Backend is unreachable. The detail route is matched by prefix
      // (this server uses plain pathname equality elsewhere, but a path
      // param is unavoidable here -- the workerKey segment is never used
      // for anything but a single encodeURIComponent'd path append).
      if (pathname === "/api/lead-agents/admin/intelligence/workers") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const result = await callOyiCoreIntelligenceWorkers(config);
        json(
          res,
          200,
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname.startsWith("/api/lead-agents/admin/intelligence/workers/")) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const workerKey = decodeURIComponent(pathname.slice("/api/lead-agents/admin/intelligence/workers/".length));
        const result = await callOyiCoreIntelligenceWorkerDetail(config, workerKey);
        json(
          res,
          result.ok ? 200 : (result.status === 404 ? 404 : 200),
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      // Intelligence System Visibility, Slice 4 -- same "view_traces" read
      // gate as every Intelligence route above. Thin pass-through to
      // Backend's Goals/Decisions/Actions read models; never fabricates
      // data when Backend is unreachable. Detail routes matched by
      // prefix, same convention as the Slice 3 worker-detail route above.
      if (pathname === "/api/lead-agents/admin/intelligence/goals") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const result = await callOyiCoreIntelligenceGoals(config);
        json(
          res,
          200,
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname.startsWith("/api/lead-agents/admin/intelligence/goals/")) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const goalId = decodeURIComponent(pathname.slice("/api/lead-agents/admin/intelligence/goals/".length));
        const result = await callOyiCoreIntelligenceGoalDetail(config, goalId);
        json(
          res,
          result.ok ? 200 : (result.status === 404 ? 404 : 200),
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/intelligence/decisions") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const result = await callOyiCoreIntelligenceDecisions(config);
        json(
          res,
          200,
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname.startsWith("/api/lead-agents/admin/intelligence/decisions/")) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const decisionId = decodeURIComponent(pathname.slice("/api/lead-agents/admin/intelligence/decisions/".length));
        const result = await callOyiCoreIntelligenceDecisionDetail(config, decisionId);
        json(
          res,
          result.ok ? 200 : (result.status === 404 ? 404 : 200),
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname === "/api/lead-agents/admin/intelligence/actions") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const result = await callOyiCoreIntelligenceActions(config);
        json(
          res,
          200,
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname.startsWith("/api/lead-agents/admin/intelligence/actions/")) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        // decodeURIComponent is required here (runtime-verified bug fix):
        // pathname comes from `new URL(req.url, ...).pathname`, which
        // preserves %3A un-decoded (colon is in the WHATWG "path
        // percent-encode set"). Action ids are colon-joined
        // ("communication:<uuid>") -- without decoding first, the
        // gateway's own encodeURIComponent() double-encodes the colon
        // (%3A -> %253A), and Backend's compoundId.indexOf(":") then
        // finds no real colon at all, 400ing as "Invalid action id".
        const actionId = decodeURIComponent(pathname.slice("/api/lead-agents/admin/intelligence/actions/".length));
        const result = await callOyiCoreIntelligenceActionDetail(config, actionId);
        json(
          res,
          result.ok ? 200 : (result.status === 404 ? 404 : 200),
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      // Intelligence System Visibility, Slice 5 -- Governed Knowledge. Same
      // "view_traces" gate and honest-degradation shape as Slice 4 above.
      // Canonical keys are colon-joined ("office:<stem>"), so the detail
      // key is decodeURIComponent()-ed first -- same double-encoding fix
      // as the Slice 4 action-detail route.
      if (pathname === "/api/lead-agents/admin/intelligence/knowledge") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const knowledgeUrl = new URL(req.url, "http://localhost");
        const query = {};
        for (const key of new Set(knowledgeUrl.searchParams.keys())) query[key] = knowledgeUrl.searchParams.getAll(key);
        const result = await callOyiCoreIntelligenceKnowledge(config, query);
        json(
          res,
          200,
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname.startsWith("/api/lead-agents/admin/intelligence/knowledge/")) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const canonicalKey = decodeURIComponent(pathname.slice("/api/lead-agents/admin/intelligence/knowledge/".length));
        const result = await callOyiCoreIntelligenceKnowledgeDetail(config, canonicalKey);
        json(
          res,
          result.ok ? 200 : (result.status === 404 ? 404 : 200),
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      // Intelligence System Visibility, Slice 6 -- Memory & Context and
      // Learning. Same "view_traces" gate and honest-degradation shape as
      // Slices 1-5. GET only; there are deliberately no control routes.
      if (pathname === "/api/lead-agents/admin/intelligence/memory-context") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const result = await callOyiCoreIntelligenceMemoryContext(config);
        json(
          res,
          200,
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      // Settings S5: read-only AI provider status. State is owned by the Backend/IQ gateway; this route only bridges and normalises it (no secrets, no provider calls).
      if (pathname === "/api/lead-agents/admin/intelligence/providers") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const result = await callOyiCoreIntelligenceProviders(config);
        json(res, 200, buildProviderStatusResponse(result, config), { "x-request-id": ctx.requestId });
        return;
      }

      if (pathname === "/api/lead-agents/admin/intelligence/learning") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const result = await callOyiCoreIntelligenceLearning(config);
        json(
          res,
          200,
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      // Intelligence System Visibility, Slice 7 -- durable canonical traces.
      // Same "view_traces" gate and honest-degradation shape. GET only.
      if (pathname === "/api/lead-agents/admin/intelligence/traces") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const tracesUrl = new URL(req.url, "http://localhost");
        const query = {};
        for (const key of new Set(tracesUrl.searchParams.keys())) query[key] = tracesUrl.searchParams.get(key);
        const result = await callOyiCoreIntelligenceTraces(config, query);
        json(
          res,
          200,
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      if (pathname.startsWith("/api/lead-agents/admin/intelligence/traces/")) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "view_traces");
        const traceId = decodeURIComponent(pathname.slice("/api/lead-agents/admin/intelligence/traces/".length));
        const result = await callOyiCoreIntelligenceTraceDetail(config, traceId);
        json(
          res,
          result.ok ? 200 : (result.status === 404 ? 404 : 200),
          result.ok
            ? { ...result.data, available: true }
            : { ok: false, available: false, reason: result.reason || "unavailable" },
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

      const officeOperatingItemMatch = pathname.match(/^\/api\/lead-agents\/admin\/office\/(projects|portfolio|support|private|partnerships|meetings|documents)\/([^/]+)$/);
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
        // Office->Facility provisioning lifecycle -- governed Portfolio
        // delete. Deliberately scoped to "portfolio" only, not a generic
        // delete for every collection this route already handles PATCH
        // for. Backend is the sole authority on whether the linked
        // estate (if any) is safe to remove -- Office never deletes real
        // Facility operational data itself, it only asks and then cleans
        // up its own bookkeeping once Backend confirms it's safe.
        if (req.method === "DELETE" && collection === "portfolio") {
          authorizePermission(authContext, "portfolio.manage");
          authorizePermission(authContext, "crm.manage");
          const portfolioId = decodeURIComponent(id);
          const portfolioRecord = await findCorporateRecord(store, "portfolio", portfolioId);
          if (!portfolioRecord) {
            json(res, 200, { ok: true, already_deleted: true, id: portfolioId }, { "x-request-id": ctx.requestId });
            return;
          }
          if (portfolioRecord.backend_estate_id) {
            const result = await deleteBackendFacilityEstate(config, portfolioRecord.backend_estate_id);
            if (!result.ok) {
              await appendAudit(store, authContext, "office_portfolio_delete_blocked", "portfolio", portfolioId, {
                backend_estate_id: portfolioRecord.backend_estate_id,
                reason: result.reason,
                blocking: result.blocking || [],
              });
              json(
                res,
                409,
                { ok: false, error: result.reason || "facility_has_operational_dependencies", blocking: result.blocking || [] },
                { "x-request-id": ctx.requestId }
              );
              return;
            }
          }
          const linkedWorkspaces = await store.listFacilityWorkspacesByPortfolioIds([portfolioId]);
          for (const workspace of linkedWorkspaces) {
            await store.deleteFacilityWorkspace(workspace.id);
          }
          await deleteCorporateRecord(store, "portfolio", portfolioId);
          await appendAudit(store, authContext, "office_portfolio_deleted", "portfolio", portfolioId, {
            name: portfolioRecord.name,
            backend_estate_id: portfolioRecord.backend_estate_id || null,
          });
          json(res, 200, { ok: true, deleted: true, id: portfolioId }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, collection === "portfolio" ? "PATCH,DELETE" : "PATCH");
        return;
      }

      // ---------------------------------------------------------------
      // Meetings Trash lifecycle -- same additive trashed_at/trashed_by
      // shape and same three-dedicated-routes pattern already proven for
      // Documents (kept separate from the generic PATCH above, exactly
      // like Documents' trash routes are separate from its own PATCH).
      // Permanent delete requires meetings.manage AND crm.manage, the
      // same dual-grant precedent Portfolio's own governed delete uses
      // above -- meetings has no documents.manage-style dedicated
      // senior-tier permission of its own.
      // ---------------------------------------------------------------
      const meetingTrashMatch = pathname.match(/^\/api\/lead-agents\/admin\/meetings\/([^/]+)\/trash$/);
      if (meetingTrashMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "meetings.manage");
        const id = decodeURIComponent(meetingTrashMatch[1]);
        const current = await findCorporateRecord(store, "meetings", id);
        if (!current) {
          notFound(res);
          return;
        }
        if (current.trashed_at) {
          json(res, 200, { meeting: current }, { "x-request-id": ctx.requestId });
          return;
        }
        const record = await persistCorporateRecord(store, "meetings", {
          ...current,
          trashed_at: new Date().toISOString(),
          trashed_by: authContext?.email || "office",
        });
        await appendAudit(store, authContext, "office_meeting_trashed", "office_meeting", id, { title: current.title });
        json(res, 200, { meeting: record }, { "x-request-id": ctx.requestId });
        return;
      }

      const meetingRestoreMatch = pathname.match(/^\/api\/lead-agents\/admin\/meetings\/([^/]+)\/restore$/);
      if (meetingRestoreMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "meetings.manage");
        const id = decodeURIComponent(meetingRestoreMatch[1]);
        const current = await findCorporateRecord(store, "meetings", id);
        if (!current) {
          notFound(res);
          return;
        }
        if (!current.trashed_at) {
          json(res, 200, { meeting: current }, { "x-request-id": ctx.requestId });
          return;
        }
        const record = await persistCorporateRecord(store, "meetings", { ...current, trashed_at: null, trashed_by: null });
        await appendAudit(store, authContext, "office_meeting_restored", "office_meeting", id, { title: current.title });
        json(res, 200, { meeting: record }, { "x-request-id": ctx.requestId });
        return;
      }

      const meetingPermanentDeleteMatch = pathname.match(/^\/api\/lead-agents\/admin\/meetings\/([^/]+)\/permanent$/);
      if (meetingPermanentDeleteMatch) {
        if (req.method !== "DELETE") {
          methodNotAllowed(res, "DELETE");
          return;
        }
        authorizePermission(authContext, "meetings.manage");
        authorizePermission(authContext, "crm.manage");
        const id = decodeURIComponent(meetingPermanentDeleteMatch[1]);
        const current = await findCorporateRecord(store, "meetings", id);
        if (!current) {
          json(res, 200, { ok: true, already_deleted: true, id }, { "x-request-id": ctx.requestId });
          return;
        }
        if (!current.trashed_at) {
          json(res, 409, { ok: false, error: "meeting_not_trashed" }, { "x-request-id": ctx.requestId });
          return;
        }
        await deleteCorporateRecord(store, "meetings", id);
        await appendAudit(store, authContext, "office_meeting_deleted", "office_meeting", id, { title: current.title });
        json(res, 200, { ok: true, deleted: true, id }, { "x-request-id": ctx.requestId });
        return;
      }

      // ---------------------------------------------------------------
      // Corporate Letterhead -- one small, admin-editable master config
      // row. GET is office.read (any staff creating a Letterhead
      // document needs to read it to snapshot it); PATCH is
      // settings.manage, the exact permission already gating the whole
      // Settings page this editor lives on. No create/delete/versioning
      // surface -- deliberately kept to "one row, one PATCH."
      // ---------------------------------------------------------------
      if (pathname === "/api/lead-agents/admin/letterhead-config") {
        if (req.method === "GET") {
          authorizePermission(authContext, "office.read");
          const config = (await store.getLetterheadConfig()) || { id: "default" };
          json(res, 200, { config }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "PATCH") {
          authorizePermission(authContext, "settings.manage");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const allowed = ["logo_url", "tagline", "email", "website", "whatsapp", "address", "social_handle"];
          const patch = {};
          for (const key of allowed) {
            if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = String(body[key] || "").trim();
          }
          patch.updated_by = authContext?.email || "office";
          const config = await store.upsertLetterheadConfig(patch);
          if (config.sync_status === "schema_pending") {
            json(res, 503, { error: "letterhead_schema_pending", message: config.sync_warning }, { "x-request-id": ctx.requestId });
            return;
          }
          await appendAudit(store, authContext, "office_letterhead_config_updated", "letterhead_config", "default", { fields: Object.keys(patch) });
          json(res, 200, { config }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,PATCH");
        return;
      }

      // ---------------------------------------------------------------
      // Documents Workspace -- Folders. A real, persisted first-level
      // organizational entity (Documents rebuild) -- not a frontend-only
      // filter. Deliberately bespoke rather than routed through
      // CORPORATE_COLLECTIONS: a folder is just {id, name}, not a
      // business record with owner/business_unit/status.
      // ---------------------------------------------------------------
      if (pathname === "/api/lead-agents/admin/documents/folders") {
        if (req.method === "GET") {
          authorizePermission(authContext, "office.read");
          const folders = await store.listOfficeDocumentFolders();
          json(res, 200, { folders }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "POST") {
          authorizePermission(authContext, "documents.generate");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const name = String(body.name || "").trim();
          if (!name) {
            json(res, 400, { error: "name is required" }, { "x-request-id": ctx.requestId });
            return;
          }
          const id = `docfolder_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
          const folder = await store.createOfficeDocumentFolder({ id, name, created_by: authContext?.email || "office" });
          // office_document_folders is a brand-new table (unlike
          // office_documents' new columns, which already exist on a
          // live table) -- if the migration hasn't run yet, the store
          // layer's schema-pending fallback would otherwise look like a
          // real 201 to the caller while nothing was actually
          // persisted. Fail honestly instead of a phantom success.
          if (folder.sync_status === "schema_pending") {
            json(res, 503, { error: "documents_workspace_schema_pending", message: folder.sync_warning || "Documents Workspace database migration has not been applied yet." }, { "x-request-id": ctx.requestId });
            return;
          }
          await appendAudit(store, authContext, "office_document_folder_created", "document_folder", folder.id, { name });
          json(res, 201, { folder }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,POST");
        return;
      }

      const documentFolderItemMatch = pathname.match(/^\/api\/lead-agents\/admin\/documents\/folders\/([^/]+)$/);
      if (documentFolderItemMatch) {
        const folderId = decodeURIComponent(documentFolderItemMatch[1]);
        if (req.method === "PATCH") {
          authorizePermission(authContext, "documents.generate");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const name = String(body.name || "").trim();
          if (!name) {
            json(res, 400, { error: "name is required" }, { "x-request-id": ctx.requestId });
            return;
          }
          const folder = await store.renameOfficeDocumentFolder(folderId, name);
          if (!folder) {
            notFound(res);
            return;
          }
          await appendAudit(store, authContext, "office_document_folder_renamed", "document_folder", folderId, { name });
          json(res, 200, { folder }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "DELETE") {
          // Senior-tier: deleting a folder is not the same action as
          // creating/renaming one. A folder that still contains
          // documents is never silently cascade-deleted -- same
          // "blocked with a clear reason" precedent as Portfolio delete
          // above, not a fake-filesystem rm -rf.
          authorizePermission(authContext, "documents.manage");
          const folder = await store.getOfficeDocumentFolderById(folderId);
          if (!folder) {
            json(res, 200, { ok: true, already_deleted: true, id: folderId }, { "x-request-id": ctx.requestId });
            return;
          }
          const documents = await store.listOfficeDocuments();
          const contained = documents.filter((d) => d.folder_id === folderId).length;
          if (contained > 0) {
            json(
              res,
              409,
              { ok: false, error: "folder_not_empty", document_count: contained },
              { "x-request-id": ctx.requestId }
            );
            return;
          }
          await store.deleteOfficeDocumentFolder(folderId);
          await appendAudit(store, authContext, "office_document_folder_deleted", "document_folder", folderId, { name: folder.name });
          json(res, 200, { ok: true, deleted: true, id: folderId }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "PATCH,DELETE");
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
          // Pre-existing bug, first surfaced by Slice 4's real HTTP-level
          // coverage (Slice 2/3 only ever called listHandoffQueue()
          // directly, never through this route) -- `url` was never
          // defined in this scope. Fixed with the same local-URL-parse
          // pattern every other query-param-reading route in this file
          // already uses.
          const requestUrl = new URL(req.url, "http://localhost");
          const queue = await listHandoffQueue(store, authContext, { status: requestUrl.searchParams.get("status") || "" });
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

      // Global WhatsApp autonomous-response switch. The server's persisted setting is the only source of truth; the response always reports what is actually stored.
      if (pathname === "/api/lead-agents/admin/settings/whatsapp-autonomy") {
        if (req.method === "GET") {
          authorizePermission(authContext, "view_integrations");
          const setting = await readWhatsAppAutonomySetting(store);
          json(res, 200, { whatsapp_autonomy: describeWhatsAppAutonomyStatus(setting, { officialNumber: config.whatsappDisplayNumber }) }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "PUT") {
          authorizePermission(authContext, "manage_integrations");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          if (typeof body.enabled !== "boolean") {
            json(res, 400, { error: "enabled_must_be_boolean" }, { "x-request-id": ctx.requestId });
            return;
          }
          let change;
          try {
            change = await store.setRuntimeSetting(WHATSAPP_AUTONOMY_SETTING_KEY, body.enabled, authContext.email || "", { requestId: ctx.requestId });
          } catch (error) {
            await appendAuditRecord({ store, authContext, action: "whatsapp_autonomy_setting_changed", resourceType: "runtime_setting", resourceId: WHATSAPP_AUTONOMY_SETTING_KEY, metadata: { requested: body.enabled, error: String(error?.message || error).slice(0, 200) }, req, status: "failure" }).catch(() => null);
            json(res, 503, { error: "setting_not_saved", detail: "The setting could not be saved. Nothing was changed." }, { "x-request-id": ctx.requestId });
            return;
          }
          await appendAuditRecord({
            store, authContext, action: "whatsapp_autonomy_setting_changed", resourceType: "runtime_setting", resourceId: WHATSAPP_AUTONOMY_SETTING_KEY,
            metadata: { old_value: change.previous ? change.previous.value : null, new_value: change.current.value, previous_updated_by: change.previous?.updated_by || null },
            req, status: "success",
          });
          // report what is now actually stored, not what was requested
          const setting = await readWhatsAppAutonomySetting(store);
          json(res, 200, { whatsapp_autonomy: describeWhatsAppAutonomyStatus(setting, { officialNumber: config.whatsappDisplayNumber }), changed: !change.previous || change.previous.value !== change.current.value }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,PUT");
        return;
      }

      // Governed Settings registry (S3). The legacy path /admin/settings/whatsapp-autonomy above matches first and keeps its own contract.
      if (pathname.startsWith("/api/lead-agents/admin/settings")) {
        // S4: allowlisted connection tests and dry-run-only diagnostics (never the apply paths)
        const opsHandled = await handleSettingsOperations({ req, res, pathname, authContext, store, config, ctx, deps: { json, readJsonBody, appendAuditRecord, authorizePermission, probeEndpoint, authHeadersFromConfig, digitalTwinRuntime, communicationOutbox, inboundVisibility, log } });
        if (opsHandled) return;
        const handled = await handleSettingsRequest({ req, res, pathname, authContext, store, registry: settingsRegistry, ctx, deps: { json, readJsonBody, appendAuditRecord, authorizePermission, verifyStepUp: async (purpose) => { const grant = verifyStepUpToken({ config, authContext, purpose, token: req.headers[STEP_UP_HEADER] }); if (!grant.ok) return grant; const gate = await stepUpMfaGate(grant, purpose); return gate.ok ? grant : gate.reason ? { ok: false, reason: gate.reason } : { ok: false, status: gate.status, error: gate.error }; } } });
        if (handled) return;
      }

      // Unified CRM Relationship Workspace (read model). Staff-only (crm.read); customers' external communications only -- staff_conversations/staff_messages are never read.
      // Inbox: GET .../admin/crm/relationships?q=&filter=all|unread|mine&contact_id=&organization_id=&opportunity_id=&limit=&offset=
      // Thread: GET .../admin/crm/relationships/:leadId?before=<cursor>&limit=&opportunity_id=&q=
      const relationshipMatch = pathname.match(/^\/api\/lead-agents\/admin\/crm\/relationships(?:\/([^/]+))?$/);
      if (relationshipMatch) {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "crm.read");
        const params = new URL(req.url, "http://office.local").searchParams;
        const q = String(params.get("q") || "").trim().toLowerCase();
        const [allLeads, opportunities] = await Promise.all([store.listLeads(), listCorporateRecords(store, "opportunities")]);
        const leadId = relationshipMatch[1] ? decodeURIComponent(relationshipMatch[1]) : "";
        if (!leadId) {
          const scope = { contact_id: params.get("contact_id") || "", organization_id: params.get("organization_id") || "", opportunity_id: params.get("opportunity_id") || "" };
          let scoped = allLeads.filter((lead) => lead.source !== "smoke_test");
          if (scope.contact_id || scope.organization_id || scope.opportunity_id) {
            const [contacts, activities] = await Promise.all([
              scope.contact_id ? listCorporateRecords(store, "contacts") : [],
              scope.contact_id ? listCorporateRecords(store, "activities") : [],
            ]);
            const ids = relationshipWorkspace.leadIdsForScope({ leads: scoped, contacts, opportunities, activities, scope });
            scoped = scoped.filter((lead) => ids.has(lead.id));
          }
          // facets describe the whole scope (before the stage / business-unit filters) so the filter menus stay complete
          const facets = {
            stages: [...new Set(scoped.map((lead) => relationshipWorkspace.stageOf(lead)).filter(Boolean))].sort(),
            business_units: [...new Set(scoped.map((lead) => String(lead.business_unit || "").trim()).filter(Boolean))].sort(),
          };
          const stageFilter = String(params.get("stage") || "").trim().toLowerCase();
          const unitFilter = String(params.get("business_unit") || "").trim().toLowerCase();
          if (stageFilter) scoped = scoped.filter((lead) => String(relationshipWorkspace.stageOf(lead) || "").toLowerCase() === stageFilter);
          if (unitFilter) scoped = scoped.filter((lead) => String(lead.business_unit || "").trim().toLowerCase() === unitFilter);
          if (q) scoped = scoped.filter((lead) => `${lead.name || ""} ${lead.company || ""} ${lead.email || ""} ${lead.phone || ""} ${lead.whatsapp_phone || ""} ${lead.summary || ""}`.toLowerCase().includes(q));
          scoped.sort((a, b) => String(b.last_contact_at || b.updated_at || b.created_at).localeCompare(String(a.last_contact_at || a.updated_at || a.created_at)));
          const limit = Math.min(Math.max(Number(params.get("limit")) || 30, 1), 100);
          const offset = Math.max(Number(params.get("offset")) || 0, 0);
          const pageLeads = scoped.slice(offset, offset + limit);
          const pageIds = pageLeads.map((lead) => lead.id);
          const [latest, states, allActivities] = await Promise.all([store.listLatestConversationsForLeads(pageIds), store.listLeadChannelStatesForLeads(pageIds, "whatsapp"), listCorporateRecords(store, "activities")]);
          const stateByLead = new Map(states.map((state) => [state.lead_id, state]));
          const pageSet = new Set(pageIds);
          const activitiesByLead = new Map();
          for (const activity of allActivities) if (activity.lead_id && pageSet.has(activity.lead_id)) (activitiesByLead.get(activity.lead_id) || activitiesByLead.set(activity.lead_id, []).get(activity.lead_id)).push(activity);
          let items = pageLeads.map((lead) => relationshipWorkspace.buildInboxEntry({ lead, lastMessage: relationshipWorkspace.latestMessageFor({ conversation: latest[lead.id], activities: activitiesByLead.get(lead.id) || [] }), channelState: stateByLead.get(lead.id), opportunities }));
          const filter = String(params.get("filter") || "all");
          if (filter === "unread") items = items.filter((item) => item.unread);
          if (filter === "mine") items = items.filter((item) => authContext.email && [item.owner, item.human_owner].some((v) => String(v || "").toLowerCase() === String(authContext.email).toLowerCase()));
          json(res, 200, { relationships: items, total: scoped.length, offset, limit, has_more: offset + limit < scoped.length, facets }, { "x-request-id": ctx.requestId });
          return;
        }
        const lead = await store.getLead(leadId).catch(() => null);
        if (!lead) {
          json(res, 404, { error: "lead_not_found" }, { "x-request-id": ctx.requestId });
          return;
        }
        // Local repair only (never calls WhatsApp): stale pending sends become "outcome unknown"; accepted sends missing their conversation record get it written.
        await reconcileManualSends(store, leadId, { log }).catch(() => null);
        const [conversations, timeline, activities, documents, channelState, setting, manualSends, inboundMessageEvents] = await Promise.all([
          store.listConversationsForLead(leadId, 500),
          store.listTimelineForLead(leadId, 500),
          listCorporateRecords(store, "activities"),
          hasPermission(authContext, "documents.generate") ? store.listOfficeDocuments().catch(() => []) : Promise.resolve([]),
          store.getLeadChannelState(leadId, "whatsapp").catch(() => null),
          readWhatsAppAutonomySetting(store),
          store.listManualSendsForLead(leadId, 200).catch(() => []),
          store.listInboundMessageEvents({ leadId, limit: 500 }).catch(() => []),
        ]);
        const leadActivities = activities.filter((a) => a.lead_id === leadId);
        const leadOpportunities = opportunities.filter((o) => o.lead_id === leadId);
        const opportunityIds = new Set(leadOpportunities.map((o) => o.id));
        const leadDocuments = documents.filter((d) => (d.related_type === "lead" && d.related_id === leadId) || (d.related_type === "opportunity" && opportunityIds.has(d.related_id)));
        const statusEvents = await store.listInboundStatusEventsByExternalIds([...conversations.map((c) => c.external_message_id), ...manualSends.map((m) => m.provider_message_id)].filter(Boolean)).catch(() => []);
        const thread = relationshipWorkspace.buildThread({
          lead, conversations, timeline, activities: leadActivities, statusEvents, documents: leadDocuments, manualSends, inboundEvents: inboundMessageEvents,
          opportunityId: params.get("opportunity_id") || "", before: params.get("before") || "", limit: params.get("limit") || 50, search: q,
        });
        const takeoverActive = Boolean(channelState && ["human_active", "human_review"].includes(channelState.human_status));
        const canReply = hasPermission(authContext, "manage_takeover");
        const autonomy = describeWhatsAppAutonomyStatus(setting, { officialNumber: config.whatsappDisplayNumber });
        const sourceInfo = relationshipWorkspace.leadSourceInfo(lead);
        json(res, 200, {
          lead: {
            id: lead.id, display_name: lead.name || lead.company || lead.email || lead.phone || lead.whatsapp_phone || "Unnamed lead", name: lead.name || null, company: lead.company || null, email: lead.email || null, phone: lead.phone || null, whatsapp_phone: lead.whatsapp_phone || null,
            role: lead.role || null, location: [lead.city, lead.country].filter(Boolean).join(", ") || lead.location || null, status: relationshipWorkspace.stageOf(lead), qualification: relationshipWorkspace.qualificationOf(lead) || null, owner: lead.owner || null, business_unit: lead.business_unit || null, summary: lead.summary || null,
            next_action: lead.next_action || null, next_action_at: lead.next_action_at || null, created_at: lead.created_at, organization_id: lead.organization_id || null,
          },
          source: sourceInfo,
          thread,
          opportunities: leadOpportunities.map((o) => ({ id: o.id, business_unit: o.business_unit, inquiry_type: o.inquiry_type, stage: o.stage, status: o.status, owner: o.owner || null })),
          channel_state: channelState ? { human_status: channelState.human_status, human_owner: channelState.human_owner || null, ai_paused: Boolean(channelState.ai_paused), takeover_started_at: channelState.takeover_started_at || null, last_inbound_at: channelState.last_inbound_at || null, last_outbound_at: channelState.last_outbound_at || null } : { human_status: "auto", human_owner: null, ai_paused: false },
          communication: {
            global_autonomous_responses: autonomy.state === "on" ? "on" : autonomy.state === "off" ? "off" : "unknown",
            takeover_active: takeoverActive,
            mode: takeoverActive ? "human" : autonomy.state === "on" ? "autonomous_allowed" : autonomy.state === "off" ? "autonomous_off" : "autonomous_off_unreadable",
            whatsapp_reply: { available: Boolean(lead.whatsapp_phone) && canReply && takeoverActive && whatsappAdapter.isConfigured(), can_reply_permission: canReply, takeover_required: !takeoverActive, whatsapp_number_known: Boolean(lead.whatsapp_phone) },
          },
          integrations: {
            whatsapp: { connected: whatsappAdapter.isConfigured(), media_ingestion: "not_verified" },
            email: { inbound_sync: "not_connected", note: "Website form notifications are not inbound mailbox synchronisation." },
            linkedin: { messaging: "not_connected", lead_gen: "not_verified" },
            facebook: { messaging: "not_connected" }, instagram: { messaging: "not_connected" },
          },
        }, { "x-request-id": ctx.requestId });
        return;
      }

      // Idempotent historical visibility repair for inbound WhatsApp messages (see whatsapp-inbound-visibility.js). dry_run defaults to TRUE: report first, write only when
      // asked. Creates only the missing CRM records (original provider id / timestamp / lead); never modifies or deletes inbound events and never sends a message.
      if (pathname === "/api/lead-agents/admin/whatsapp/inbound-visibility/repair") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_integrations");
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const dryRun = body.dry_run !== false;
        const summary = await inboundVisibility.repairInboundVisibility(store, { dryRun, limit: Math.min(Math.max(Number(body.limit) || 1000, 1), 2000), log });
        await appendAuditRecord({ store, authContext, action: dryRun ? "whatsapp.inbound_visibility.dry_run" : "whatsapp.inbound_visibility.repair", resourceType: "whatsapp_inbound", resourceId: "inbound_events", metadata: { raw_missing_event_rows: summary.raw_missing_event_rows, unique_missing_messages: summary.unique_missing_messages, duplicate_event_rows: summary.duplicate_event_rows, invalid_records: summary.invalid_records, conflicting_lead_groups: summary.conflicting_lead_groups, created: summary.created, skipped_existing: summary.skipped_existing, skipped_claimed_elsewhere: summary.skipped_claimed_elsewhere, failed: summary.failed, operator: authContext.email || "" }, req, status: "success" }).catch(() => null);
        json(res, 200, { ok: true, ...summary }, { "x-request-id": ctx.requestId });
        return;
      }

      // Communication delivery outbox (admin only). GET = diagnostics (counts, recent undelivered entries; provider ids and leads are shortened, no message text).
      // POST reconcile = find stored WhatsApp events that were never queued (dry_run defaults to TRUE; entries are created as non-sending REPLAY deliveries).
      // POST recover = re-queue and attempt ONE stored message as a replay. POST retry = put a dead-lettered entry back in the queue as a replay.
      const outboxMatch = pathname.match(/^\/api\/lead-agents\/admin\/communications\/outbox(?:\/(reconcile|recover|retry))?$/);
      if (outboxMatch) {
        const action = outboxMatch[1] || "";
        const mask = (e) => ({ id: e.id, event_type: e.event_type, status_value: e.status_value || null, status: e.status, mode: e.mode, attempts: e.attempts, next_attempt_at: e.next_attempt_at, last_attempt_at: e.last_attempt_at, last_error: e.last_error, last_http_status: e.last_http_status, provider_message_id_tail: String(e.provider_message_id || "").slice(-8), lead: e.lead_id ? String(e.lead_id).slice(0, 8) : null, created_at: e.created_at, delivered_at: e.delivered_at, dead_at: e.dead_at });
        if (!action) {
          if (req.method !== "GET") { methodNotAllowed(res, "GET"); return; }
          authorizePermission(authContext, "manage_integrations"); // admin-only (view_integrations is also held by ordinary staff)
          const [summary, undelivered] = await Promise.all([store.communicationDeliverySummary(), store.listCommunicationDeliveries({ statuses: ["pending", "dead"], limit: 50 })]);
          json(res, 200, { outbox: { ...summary, worker: Boolean(communicationOutboxWorkerHandle), settings: communicationOutbox.settings(config), undelivered: undelivered.map(mask) } }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method !== "POST") { methodNotAllowed(res, "POST"); return; }
        authorizePermission(authContext, "manage_integrations");
        const body = await readJsonBody(req);
        requireObject(body, "body");
        let result;
        if (action === "reconcile") {
          const dryRun = body.dry_run !== false;
          result = await communicationOutbox.reconcileOutbox(store, config, { dryRun, windowMinutes: Math.min(Math.max(Number(body.window_minutes) || 180, 1), 10080), limit: Math.min(Math.max(Number(body.limit) || 500, 1), 2000), log });
        } else if (action === "recover") {
          const providerMessageId = String(body.provider_message_id || "").trim();
          if (!providerMessageId) { json(res, 400, { error: "provider_message_id_required" }, { "x-request-id": ctx.requestId }); return; }
          result = await communicationOutbox.recoverMessage(store, config, { providerMessageId, log });
        } else {
          const id = String(body.id || "").trim();
          const entry = id ? await store.requeueCommunicationDelivery(id, { mode: "replay" }) : null;
          if (!entry) { json(res, 404, { error: "outbox_entry_not_found" }, { "x-request-id": ctx.requestId }); return; }
          result = { ok: true, requeued: mask(entry) };
        }
        await appendAuditRecord({ store, authContext, action: `communication.outbox.${action}`, resourceType: "communication_outbox", resourceId: action, metadata: { dry_run: action === "reconcile" ? result.dry_run : undefined, scanned_events: result.scanned_events, missing_deliveries: result.missing_deliveries, enqueued: result.enqueued, delivered: result.delivered, error: result.error || null, operator: authContext.email || "" }, req, status: result.ok === false ? "failure" : "success" }).catch(() => null);
        json(res, result.ok === false ? 404 : 200, { ok: result.ok !== false, ...result }, { "x-request-id": ctx.requestId });
        return;
      }

      // Governed MANUAL WhatsApp reply by an authorised staff member. Independent of the autonomy switch (a human is sending), but only while that human owns the
      // conversation (active takeover), and always audited with the operator.
      const manualReplyMatch = pathname.match(/^\/api\/lead-agents\/admin\/leads\/([^/]+)\/whatsapp\/reply$/);
      if (manualReplyMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_takeover");
        const leadId = decodeURIComponent(manualReplyMatch[1]);
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const text = String(body.body || "").trim();
        if (!text) {
          json(res, 400, { error: "missing_body" }, { "x-request-id": ctx.requestId });
          return;
        }
        const lead = await store.getLead(leadId).catch(() => null);
        const to = String(lead?.whatsapp_phone || "").trim();
        if (!lead || !to) {
          json(res, 404, { error: "lead_whatsapp_not_found" }, { "x-request-id": ctx.requestId });
          return;
        }
        const state = await store.getLeadChannelState(leadId, "whatsapp").catch(() => null);
        if (!state || !["human_active", "human_review"].includes(state.human_status)) {
          json(res, 409, { error: "takeover_required", detail: "Take over the conversation before replying manually." }, { "x-request-id": ctx.requestId });
          return;
        }
        if (!whatsappAdapter.isConfigured()) {
          json(res, 503, { error: "whatsapp_not_configured" }, { "x-request-id": ctx.requestId });
          return;
        }
        // The sender is ALWAYS the authenticated session; a body that names a different actor is refused rather than ignored.
        for (const field of ["actor_email", "sent_by", "operator", "actor"]) {
          if (body[field] !== undefined && String(body[field] || "").trim().toLowerCase() !== String(authContext.email || "").toLowerCase()) {
            json(res, 400, { error: "forged_actor", detail: "The sender is taken from the signed-in session." }, { "x-request-id": ctx.requestId });
            return;
          }
        }
        const outcome = await performManualSend({
          store, adapter: whatsappAdapter, lead, actorEmail: authContext.email || "staff", clientRequestId: body.client_request_id, text, log,
          audit: (action, status, metadata) => appendAuditRecord({ store, authContext, action, resourceType: "lead", resourceId: leadId, metadata, req, status }),
        });
        if (outcome.body.accepted) await store.upsertLeadChannelState(leadId, "whatsapp", { last_outbound_at: new Date().toISOString(), last_external_message_id: outcome.body.external_message_id || undefined }).catch(() => null);
        json(res, outcome.httpStatus, outcome.body, { "x-request-id": ctx.requestId });
        return;
      }

      // Governed resolution of an UNKNOWN manual-send outcome. A staff member who has checked WhatsApp records what happened; this never sends a message.
      const manualSendResolveMatch = pathname.match(/^\/api\/lead-agents\/admin\/leads\/([^/]+)\/whatsapp\/manual-sends\/([^/]+)\/resolve$/);
      if (manualSendResolveMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "manage_takeover");
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const sendId = decodeURIComponent(manualSendResolveMatch[2]);
        const leadIdForSend = decodeURIComponent(manualSendResolveMatch[1]);
        const record = await store.getManualSend(sendId).catch(() => null);
        if (!record || record.lead_id !== leadIdForSend) {
          json(res, 404, { error: "send_not_found" }, { "x-request-id": ctx.requestId });
          return;
        }
        const outcome = await resolveManualSend(store, sendId, { resolution: String(body.resolution || ""), providerMessageId: body.provider_message_id, actorEmail: authContext.email || "staff", note: body.note });
        await appendAuditRecord({ store, authContext, action: "communication.whatsapp.manual_send_resolved", resourceType: "lead", resourceId: leadIdForSend, metadata: { send_id: sendId, resolution: String(body.resolution || ""), result_state: outcome.body.state || null, operator: authContext.email || "" }, req, status: outcome.httpStatus === 200 ? "success" : "failure" }).catch(() => null);
        json(res, outcome.httpStatus, outcome.body, { "x-request-id": ctx.requestId });
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
        // Governed document brand name (Settings S6.1): read at generation time; any failure falls back to the environment value and is recorded on the document.
        const brand = await resolveDocumentBrandName(store, config, { log, requestId: ctx.requestId });
        const locale = await resolveDocumentLocale(store, { log, requestId: ctx.requestId });
        const documentConfig = { ...config, officeDocumentBrandName: brand.name, officeDocumentLocale: locale.locale };
        const templateHtml = body.template_id && body.template_id !== "basic" ? renderDocumentFromTemplate(body.template_id, documentConfig, body) : null;
        const html = templateHtml || documentHtml(documentConfig, body);
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
          folder_id: body.folder_id || null,
          // Persisted verbatim (not just baked into the generated HTML)
          // so this document is immediately continue-editable through
          // the Documents Workspace native editor -- create/write/save/
          // reopen from the very first save, not just at creation time.
          body: body.body || null,
          metadata: {
            recipient: body.recipient || "",
            template_id: body.template_id || "basic",
            generated_format: "printable_html",
            pdf_status: "print_ready",
            source_file_url: body.file_url || "",
            brand_name_source: brand.source,
            brand_setting_version: brand.version,
            document_locale: locale.locale,
            document_locale_source: locale.source,
            document_locale_version: locale.version,
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
      // Documents Workspace -- Upload. A genuinely different creation
      // path from /documents/generate above: no server-side HTML
      // template, the bytes the caller uploaded are stored verbatim via
      // the same primitives the generic /admin/storage upload and
      // staff-messaging-attachment paths already use. metadata.upload_kind
      // is the one flag that distinguishes an uploaded file from a
      // native document at render time (never both).
      // ---------------------------------------------------------------
      if (pathname === "/api/lead-agents/admin/documents/upload") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "documents.generate");
        const body = await readJsonBody(req, 16 * 1024 * 1024);
        requireObject(body, "body");
        if (!body.title) {
          json(res, 400, { error: "title is required" }, { "x-request-id": ctx.requestId });
          return;
        }
        if (!body.data_url) {
          json(res, 400, { error: "data_url is required" }, { "x-request-id": ctx.requestId });
          return;
        }
        const id = `doc_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
        const storedRaw = await storageService.putDataUrl({
          purpose: "document",
          data_url: body.data_url,
          filename: body.filename || "",
          resource_type: "office_document",
          resource_id: id,
        });
        let stored = storedRaw;
        if (typeof store.createOfficeFile === "function") {
          try {
            stored = await store.createOfficeFile(storedRaw);
          } catch (error) {
            stored = {
              ...storedRaw,
              sync_status: "metadata_pending",
              sync_warning: error?.response?.data?.message || error.message || "office_files metadata write failed.",
            };
          }
        }
        const shareToken = crypto.randomBytes(16).toString("hex");
        const documentRecord = await store.createOfficeDocument({
          id,
          title: body.title,
          document_type: body.document_type || "uploaded_file",
          status: "draft",
          owner: authContext?.email || "Office",
          related_type: body.related_type || "",
          related_id: body.related_id || "",
          folder_id: body.folder_id || null,
          file_url: stored.url,
          share_token: shareToken,
          metadata: { upload_kind: "uploaded_file", mime_type: stored.mime_type, size: stored.size, filename: stored.filename },
        });
        documentRecord.share_url = absoluteUrl(req, `/api/lead-agents/documents/shared/${id}/${shareToken}`);
        await appendAudit(store, authContext, "office_document_uploaded", "office_document", id, {
          title: body.title,
          mime_type: stored.mime_type,
          size: stored.size,
        });
        eventBus.publish("office.document", { actor: authContext?.email || "", document: documentRecord });
        json(res, 201, { document: documentRecord, file: stored }, { "x-request-id": ctx.requestId });
        return;
      }

      // ---------------------------------------------------------------
      // Corporate Letterhead -- "Documents -> New Document" default
      // native template. Creates a real office_documents row with an
      // empty, genuinely editable HTML body and a snapshot of the
      // CURRENT master Letterhead config baked into metadata at creation
      // time only -- later admin edits to office_letterhead_config never
      // touch this record (no join at render time), so historical
      // letters keep the letterhead that existed when they were issued.
      // ---------------------------------------------------------------
      if (pathname === "/api/lead-agents/admin/documents/letterhead") {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "documents.generate");
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const masterConfig = (await store.getLetterheadConfig()) || {};
        const snapshot = {
          logo_url: masterConfig.logo_url || "/office/brand/ochiga-logo-light.png",
          tagline: masterConfig.tagline || "",
          email: masterConfig.email || "",
          website: masterConfig.website || "",
          whatsapp: masterConfig.whatsapp || "",
          address: masterConfig.address || "",
          social_handle: masterConfig.social_handle || "",
          snapshotted_at: new Date().toISOString(),
        };
        const id = `doc_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
        const shareToken = crypto.randomBytes(16).toString("hex");
        const documentRecord = await store.createOfficeDocument({
          id,
          title: body.title || "Untitled Letter",
          document_type: "letter",
          status: "draft",
          owner: authContext?.email || "Office",
          related_type: body.related_type || "",
          related_id: body.related_id || "",
          folder_id: body.folder_id || null,
          body: "",
          share_token: shareToken,
          metadata: { template: "ochiga_letterhead", body_format: "html", letterhead_snapshot: snapshot },
        });
        documentRecord.share_url = absoluteUrl(req, `/api/lead-agents/documents/shared/${id}/${shareToken}`);
        await appendAudit(store, authContext, "office_document_letterhead_created", "office_document", id, { title: documentRecord.title });
        eventBus.publish("office.document", { actor: authContext?.email || "", document: documentRecord });
        json(res, 201, { document: documentRecord }, { "x-request-id": ctx.requestId });
        return;
      }

      // ---------------------------------------------------------------
      // Documents Workspace -- Trash / Restore / Permanent delete.
      // trashed_at is a separate lifecycle flag from the business
      // `status` column (draft/sent/accepted, per document_type) --
      // trashing never rewrites status. Permanent delete requires the
      // document to already be trashed (no direct hard-delete) and is
      // gated on the senior documents.manage permission, matching the
      // Portfolio-delete governance precedent.
      // ---------------------------------------------------------------
      const documentTrashMatch = pathname.match(/^\/api\/lead-agents\/admin\/documents\/([^/]+)\/trash$/);
      if (documentTrashMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "documents.generate");
        const id = decodeURIComponent(documentTrashMatch[1]);
        const current = await findCorporateRecord(store, "documents", id);
        if (!current) {
          notFound(res);
          return;
        }
        if (current.trashed_at) {
          json(res, 200, { document: current }, { "x-request-id": ctx.requestId });
          return;
        }
        const record = await persistCorporateRecord(store, "documents", {
          ...current,
          trashed_at: new Date().toISOString(),
          trashed_by: authContext?.email || "office",
        });
        await appendAudit(store, authContext, "office_document_trashed", "office_document", id, { title: current.title });
        json(res, 200, { document: record }, { "x-request-id": ctx.requestId });
        return;
      }

      const documentRestoreMatch = pathname.match(/^\/api\/lead-agents\/admin\/documents\/([^/]+)\/restore$/);
      if (documentRestoreMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "documents.generate");
        const id = decodeURIComponent(documentRestoreMatch[1]);
        const current = await findCorporateRecord(store, "documents", id);
        if (!current) {
          notFound(res);
          return;
        }
        if (!current.trashed_at) {
          json(res, 200, { document: current }, { "x-request-id": ctx.requestId });
          return;
        }
        const record = await persistCorporateRecord(store, "documents", {
          ...current,
          trashed_at: null,
          trashed_by: null,
        });
        await appendAudit(store, authContext, "office_document_restored", "office_document", id, { title: current.title });
        json(res, 200, { document: record }, { "x-request-id": ctx.requestId });
        return;
      }

      const documentShareRegenerateMatch = pathname.match(/^\/api\/lead-agents\/admin\/documents\/([^/]+)\/regenerate-share-link$/);
      if (documentShareRegenerateMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "documents.generate");
        const id = decodeURIComponent(documentShareRegenerateMatch[1]);
        const current = await findCorporateRecord(store, "documents", id);
        if (!current) {
          notFound(res);
          return;
        }
        const shareToken = crypto.randomBytes(16).toString("hex");
        const record = await persistCorporateRecord(store, "documents", { ...current, share_token: shareToken });
        await appendAudit(store, authContext, "office_document_share_link_regenerated", "office_document", id, {});
        json(
          res,
          200,
          { document: record, share_url: absoluteUrl(req, `/api/lead-agents/documents/shared/${id}/${shareToken}`) },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      const documentPermanentDeleteMatch = pathname.match(/^\/api\/lead-agents\/admin\/documents\/([^/]+)\/permanent$/);
      if (documentPermanentDeleteMatch) {
        if (req.method !== "DELETE") {
          methodNotAllowed(res, "DELETE");
          return;
        }
        authorizePermission(authContext, "documents.manage");
        const id = decodeURIComponent(documentPermanentDeleteMatch[1]);
        const current = await findCorporateRecord(store, "documents", id);
        if (!current) {
          json(res, 200, { ok: true, already_deleted: true, id }, { "x-request-id": ctx.requestId });
          return;
        }
        if (!current.trashed_at) {
          json(res, 409, { ok: false, error: "document_not_trashed" }, { "x-request-id": ctx.requestId });
          return;
        }
        // Clean up the underlying storage object and its office_files
        // row before removing the record itself -- never leave an
        // orphaned storage object or a dangling office_files reference.
        if (typeof store.listOfficeFilesByResource === "function") {
          const files = await store.listOfficeFilesByResource("office_document", id).catch(() => []);
          for (const file of files) {
            try {
              await storageService.deleteObject(file.filename);
            } catch {
              // Non-fatal — the metadata row is still removed below, and
              // this is logged via the audit event's file list so a
              // stray object can be found and cleaned up manually.
            }
            if (typeof store.deleteOfficeFile === "function") await store.deleteOfficeFile(file.id).catch(() => null);
          }
        }
        if (typeof store.deleteOfficeDocument === "function") {
          await store.deleteOfficeDocument(id);
        } else {
          await deleteCorporateRecord(store, "documents", id);
        }
        await appendAudit(store, authContext, "office_document_deleted", "office_document", id, { title: current.title });
        json(res, 200, { ok: true, deleted: true, id }, { "x-request-id": ctx.requestId });
        return;
      }

      // ---------------------------------------------------------------
      // Documents Workspace -- Storage summary. Real bytes only (sum of
      // office_files.size for office_document-resourced uploads) -- no
      // fabricated "available"/quota value, since no real capacity limit
      // exists on either storage driver.
      // ---------------------------------------------------------------
      if (pathname === "/api/lead-agents/admin/documents/storage-summary") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "office.read");
        const files =
          typeof store.listOfficeFilesByResourceType === "function"
            ? await store.listOfficeFilesByResourceType("office_document")
            : [];
        const usedBytes = files.reduce((sum, f) => sum + Number(f.size || 0), 0);
        json(res, 200, { used_bytes: usedBytes, file_count: files.length }, { "x-request-id": ctx.requestId });
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
          .map((u) => ({
            email: u.email,
            display_name: u.display_name || u.email,
            office_position: u.office_position || "",
            // "Appropriate Office contact information" for the Messages
            // details panel (Part 2 of the brief) — still deliberately
            // NOT role/status/permission_scopes/admin fields, same
            // restraint as this route's original comment.
            phone: u.phone || "",
            passport_photo_url: u.passport_photo_url || "",
            last_login_at: u.last_login_at || null,
          }));
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
              const mine = participants.find((p) => p.staff_email === email);
              return {
                ...conversation,
                participants: participants.map((p) => p.staff_email),
                last_message: messages[messages.length - 1] || null,
                unread_count: unread,
                // Per-participant state — mine only, never another
                // participant's (archiving/muting/pinning is always a
                // personal view preference, never shared).
                archived_at: mine?.archived_at || null,
                muted_at: mine?.muted_at || null,
                pinned_at: mine?.pinned_at || null,
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
          // Suspended/deactivated/removed users must not remain
          // reachable as new-message recipients, even if a client
          // somehow submits their email directly — this is the real
          // server-side boundary, the staff directory's own active-only
          // filter is only the client-side convenience on top of it.
          const activeUsers = await store.listAdminUsers();
          const activeEmails = new Set(
            activeUsers.filter((u) => u.status === "active").map((u) => normalizeEmail(u.email))
          );
          const invalidRecipients = participantEmails.filter((e) => !activeEmails.has(e));
          if (invalidRecipients.length) {
            json(res, 400, { error: "inactive_recipients", message: "One or more recipients are not active Office users.", recipients: invalidRecipients }, { "x-request-id": ctx.requestId });
            return;
          }
          const type = participantEmails.length === 1 && body.type !== "group" ? "direct" : "group";
          if (type === "group" && !String(body.title || "").trim()) {
            json(res, 400, { error: "title_required", message: "Give the group a name." }, { "x-request-id": ctx.requestId });
            return;
          }
          let conversation = null;
          if (type === "direct") {
            conversation = await store.findDirectStaffConversation(createdBy, participantEmails[0]);
          }
          if (!conversation) {
            conversation = await store.createStaffConversation({
              type,
              title: type === "group" ? body.title.trim() : null,
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

      // Rename a group (title only). Creator-only — the single truthful
      // "admin" concept this model has (see the additive migration's
      // comment: deliberately no separate role column). Direct
      // conversations have no title to rename.
      const staffConversationRenameMatch = pathname.match(/^\/api\/lead-agents\/admin\/staff\/conversations\/([^/]+)$/);
      if (staffConversationRenameMatch) {
        if (req.method !== "PATCH") {
          methodNotAllowed(res, "PATCH");
          return;
        }
        authorizePermission(authContext, "messages.send");
        const conversationId = staffConversationRenameMatch[1];
        const email = normalizeEmail(authContext?.email || "");
        const conversation = await store.getStaffConversationById(conversationId);
        if (!conversation) {
          notFound(res);
          return;
        }
        if (conversation.type !== "group") {
          json(res, 400, { error: "not_a_group" }, { "x-request-id": ctx.requestId });
          return;
        }
        if (normalizeEmail(conversation.created_by) !== email) {
          json(res, 403, { error: "forbidden", message: "Only the group creator can rename it." }, { "x-request-id": ctx.requestId });
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const title = String(body.title || "").trim();
        if (!title) {
          json(res, 400, { error: "title_required" }, { "x-request-id": ctx.requestId });
          return;
        }
        const updated = await store.updateStaffConversation(conversationId, { title });
        const participants = await store.listStaffConversationParticipants(conversationId);
        const otherEmails = participants.map((p) => p.staff_email).filter((e) => e !== email);
        eventBus.publish("office.conversation.updated", { conversation: updated }, otherEmails.length ? { recipients: otherEmails } : undefined);
        await appendAudit(store, authContext, "staff_conversation_renamed", "staff_conversation", conversationId, { title });
        json(res, 200, { conversation: updated }, { "x-request-id": ctx.requestId });
        return;
      }

      // Add / remove group members. Add is creator-only (the same
      // "ordinary users cannot arbitrarily add themselves to private
      // groups" boundary the brief asks to prove). Remove allows either
      // the creator removing someone else, or a member removing
      // themselves (leave) — direct conversations reject both, they
      // have no membership to manage.
      const staffConversationMembersMatch = pathname.match(/^\/api\/lead-agents\/admin\/staff\/conversations\/([^/]+)\/members$/);
      if (staffConversationMembersMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "messages.send");
        const conversationId = staffConversationMembersMatch[1];
        const email = normalizeEmail(authContext?.email || "");
        const conversation = await store.getStaffConversationById(conversationId);
        if (!conversation) {
          notFound(res);
          return;
        }
        if (conversation.type !== "group") {
          json(res, 400, { error: "not_a_group" }, { "x-request-id": ctx.requestId });
          return;
        }
        if (normalizeEmail(conversation.created_by) !== email) {
          json(res, 403, { error: "forbidden", message: "Only the group creator can add members." }, { "x-request-id": ctx.requestId });
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const newEmails = Array.isArray(body.participant_emails) ? body.participant_emails.map(normalizeEmail).filter(Boolean) : [];
        if (!newEmails.length) {
          json(res, 400, { error: "participant_emails is required" }, { "x-request-id": ctx.requestId });
          return;
        }
        const activeUsers = await store.listAdminUsers();
        const activeEmails = new Set(activeUsers.filter((u) => u.status === "active").map((u) => normalizeEmail(u.email)));
        const invalidRecipients = newEmails.filter((e) => !activeEmails.has(e));
        if (invalidRecipients.length) {
          json(res, 400, { error: "inactive_recipients", recipients: invalidRecipients }, { "x-request-id": ctx.requestId });
          return;
        }
        const added = await store.addStaffConversationParticipants(conversationId, newEmails);
        const participants = await store.listStaffConversationParticipants(conversationId);
        const otherEmails = participants.map((p) => p.staff_email).filter((e) => e !== email);
        eventBus.publish("office.conversation.updated", { conversation }, otherEmails.length ? { recipients: otherEmails } : undefined);
        await appendAudit(store, authContext, "staff_conversation_members_added", "staff_conversation", conversationId, { added: newEmails });
        json(res, 200, { added: added.length, participants: participants.map((p) => p.staff_email) }, { "x-request-id": ctx.requestId });
        return;
      }

      const staffConversationMemberMatch = pathname.match(/^\/api\/lead-agents\/admin\/staff\/conversations\/([^/]+)\/members\/([^/]+)$/);
      if (staffConversationMemberMatch) {
        if (req.method !== "DELETE") {
          methodNotAllowed(res, "DELETE");
          return;
        }
        authorizePermission(authContext, "messages.send");
        const conversationId = staffConversationMemberMatch[1];
        const targetEmail = normalizeEmail(decodeURIComponent(staffConversationMemberMatch[2]));
        const email = normalizeEmail(authContext?.email || "");
        const conversation = await store.getStaffConversationById(conversationId);
        if (!conversation) {
          notFound(res);
          return;
        }
        if (conversation.type !== "group") {
          json(res, 400, { error: "not_a_group" }, { "x-request-id": ctx.requestId });
          return;
        }
        const isSelf = targetEmail === email;
        const isCreator = normalizeEmail(conversation.created_by) === email;
        if (!isSelf && !isCreator) {
          json(res, 403, { error: "forbidden", message: "Only the group creator can remove other members." }, { "x-request-id": ctx.requestId });
          return;
        }
        await store.removeStaffConversationParticipant(conversationId, targetEmail);
        const participants = await store.listStaffConversationParticipants(conversationId);
        const otherEmails = participants.map((p) => p.staff_email);
        eventBus.publish("office.conversation.updated", { conversation }, otherEmails.length ? { recipients: [...otherEmails, targetEmail] } : { recipients: [targetEmail] });
        await appendAudit(store, authContext, isSelf ? "staff_conversation_left" : "staff_conversation_member_removed", "staff_conversation", conversationId, { email: targetEmail });
        json(res, 200, { ok: true }, { "x-request-id": ctx.requestId });
        return;
      }

      // Per-participant state: archive/mute/pin. Always self-only (no
      // creator override) — these are personal view preferences, never
      // something one coworker can impose on another's inbox.
      const staffConversationStateMatch = pathname.match(/^\/api\/lead-agents\/admin\/staff\/conversations\/([^/]+)\/(archive|unarchive|mute|unmute|pin|unpin)$/);
      if (staffConversationStateMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "messages.read");
        const conversationId = staffConversationStateMatch[1];
        const action = staffConversationStateMatch[2];
        const email = normalizeEmail(authContext?.email || "");
        if (!(await store.isStaffConversationParticipant(conversationId, email))) {
          json(res, 403, { error: "forbidden" }, { "x-request-id": ctx.requestId });
          return;
        }
        const patch = {
          archive: { archived_at: new Date().toISOString() },
          unarchive: { archived_at: null },
          mute: { muted_at: new Date().toISOString() },
          unmute: { muted_at: null },
          pin: { pinned_at: new Date().toISOString() },
          unpin: { pinned_at: null },
        }[action];
        const participant = await store.setStaffConversationParticipantState(conversationId, email, patch);
        json(res, 200, { participant }, { "x-request-id": ctx.requestId });
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

      // Toggle (add/remove) the caller's own reaction on a message —
      // participant-of-the-conversation gated, same as reading/sending.
      const staffMessageReactionMatch = pathname.match(/^\/api\/lead-agents\/admin\/staff\/messages\/([^/]+)\/reactions$/);
      if (staffMessageReactionMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        authorizePermission(authContext, "messages.send");
        const messageId = staffMessageReactionMatch[1];
        const email = normalizeEmail(authContext?.email || "");
        const message = await store.getStaffMessageById(messageId);
        if (!message) {
          notFound(res);
          return;
        }
        if (!(await store.isStaffConversationParticipant(message.conversation_id, email))) {
          json(res, 403, { error: "forbidden" }, { "x-request-id": ctx.requestId });
          return;
        }
        const body = await readJsonBody(req);
        requireObject(body, "body");
        const emoji = String(body.emoji || "").trim();
        if (!emoji) {
          json(res, 400, { error: "emoji_required" }, { "x-request-id": ctx.requestId });
          return;
        }
        const result = await store.toggleStaffMessageReaction(messageId, email, emoji);
        const participants = await store.listStaffConversationParticipants(message.conversation_id);
        const otherEmails = participants.map((p) => p.staff_email).filter((e) => e !== email);
        eventBus.publish(
          "office.message.reaction",
          { conversation_id: message.conversation_id, message_id: messageId, staff_email: email, emoji, action: result.action },
          otherEmails.length ? { recipients: otherEmails } : undefined
        );
        json(res, 200, result, { "x-request-id": ctx.requestId });
        return;
      }

      // Soft-delete (tombstone) a message — own message only. Never a
      // hard delete: every other participant's copy of the conversation
      // must keep an honest "message deleted" marker, not a silent gap
      // and never a version another participant can't account for.
      // Message-content search — scoped server-side to conversations the
      // caller actually belongs to. This is the real boundary (Part 12/
      // 16 of the brief: "a user must never discover private
      // conversation content they are not a participant in merely
      // through search") — never a client-side filter over a broader
      // fetch. Checked BEFORE the /messages/:id delete route below,
      // since that route's [^/]+ id-matcher would otherwise swallow
      // the literal "search" path segment.
      if (pathname === "/api/lead-agents/admin/staff/messages/search") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "messages.read");
        const email = normalizeEmail(authContext?.email || "");
        const requestUrl = new URL(req.url, "http://localhost");
        const query = (requestUrl.searchParams.get("q") || "").trim();
        if (!query) {
          json(res, 200, { results: [] }, { "x-request-id": ctx.requestId });
          return;
        }
        const conversations = await store.listStaffConversationsForStaff(email);
        const conversationIds = conversations.map((c) => c.id);
        const matches = await store.searchStaffMessages(conversationIds, query, 40);
        const conversationById = new Map(conversations.map((c) => [c.id, c]));
        const results = matches.map((message) => ({
          message,
          conversation_id: message.conversation_id,
          conversation_title: conversationById.get(message.conversation_id)?.title || null,
          conversation_type: conversationById.get(message.conversation_id)?.type || "direct",
        }));
        json(res, 200, { results }, { "x-request-id": ctx.requestId });
        return;
      }

      // Soft-delete (tombstone) a message — own message only. Never a
      // hard delete: every other participant's copy of the conversation
      // must keep an honest "message deleted" marker, not a silent gap
      // and never a version another participant can't account for.
      const staffMessageDeleteMatch = pathname.match(/^\/api\/lead-agents\/admin\/staff\/messages\/([^/]+)$/);
      if (staffMessageDeleteMatch) {
        if (req.method !== "DELETE") {
          methodNotAllowed(res, "DELETE");
          return;
        }
        authorizePermission(authContext, "messages.send");
        const messageId = staffMessageDeleteMatch[1];
        const email = normalizeEmail(authContext?.email || "");
        const message = await store.getStaffMessageById(messageId);
        if (!message) {
          notFound(res);
          return;
        }
        if (normalizeEmail(message.sender_email) !== email) {
          json(res, 403, { error: "forbidden", message: "You can only delete your own messages." }, { "x-request-id": ctx.requestId });
          return;
        }
        const updated = await store.softDeleteStaffMessage(messageId, email);
        const participants = await store.listStaffConversationParticipants(message.conversation_id);
        const otherEmails = participants.map((p) => p.staff_email).filter((e) => e !== email);
        eventBus.publish(
          "office.message.deleted",
          { conversation_id: message.conversation_id, message_id: messageId },
          otherEmails.length ? { recipients: otherEmails } : undefined
        );
        await appendAudit(store, authContext, "staff_message_deleted", "staff_message", messageId, { conversation_id: message.conversation_id });
        json(res, 200, { message: updated }, { "x-request-id": ctx.requestId });
        return;
      }

      // Presence — genuinely derived from who currently holds an open
      // SSE connection to /admin/events (the same realtime hub every
      // other live-update feature already uses), never a fabricated
      // "everyone is online" default. A connected client is a truthful,
      // if imperfect, "has Office open right now" signal; the frontend
      // falls back to admin_users.last_login_at ("last active") for
      // anyone not currently connected.
      if (pathname === "/api/lead-agents/admin/staff/presence") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "messages.read");
        const requestUrl = new URL(req.url, "http://localhost");
        const emails = (requestUrl.searchParams.get("emails") || "").split(",").map(normalizeEmail).filter(Boolean);
        const presence = {};
        emails.forEach((e) => {
          presence[e] = eventBus.isOnline(e);
        });
        json(res, 200, { presence }, { "x-request-id": ctx.requestId });
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
        // A Letterhead (or any future HTML-bodied native) document has
        // no stored file to look up -- render it server-side on the
        // fly, reusing this exact same token-gated route/permission
        // model rather than a second sharing mechanism.
        if (!doc.html_url && !doc.file_url && doc.metadata?.body_format === "html") {
          const html = renderLetterheadHtml(doc, req);
          serveBuffer(res, Buffer.from(html, "utf8"), "text/html; charset=utf-8", `${sharedDocId}.html`);
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
          if (await denyNonHumanActor({ store, authContext, res, ctx, req, category: "admin_user_create" })) return;
          authorizePermission(authContext, "manage_users");
          const body = await readJsonBody(req);
          requireObject(body, "body");
          if (!body.email || !body.password) {
            json(res, 400, { error: "email and password are required" });
            return;
          }
          if (rejectPasswordViolation(res, body.password, ctx)) return;
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
        if (await denyNonHumanActor({ store, authContext, res, ctx, req, category: "admin_user_invite" })) return;
        // Adding a team member is organisation-controlled -- super_admin
        // only (team.manage), same gate as every other Team-management
        // mutation.
        authorizePermission(authContext, "team.manage");
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
          expires_at: new Date(Date.now() + expiryHours(body.expires_in_hours, 72) * 60 * 60 * 1000).toISOString(),
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
        if (await denyNonHumanActor({ store, authContext, res, ctx, req, category: "admin_user_update" })) return;
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
        if (body.password !== undefined && body.password !== null && body.password !== "") {
          if (rejectPasswordViolation(res, body.password, ctx)) return;
          patch.password_hash = hashPassword(body.password);
          patch.password_changed_at = new Date().toISOString();
        }
        // S7.4/S7.5.0: a password set by an administrator, or any status change, is applied TOGETHER with the revocation of the target's sessions; other edits follow separately.
        const existingTarget = (patch.password_hash || patch.status !== undefined) ? await store.getAdminUserById(adminUserMatch[1]) : null;
        const statusChanged = Boolean(existingTarget && patch.status !== undefined && patch.status !== existingTarget.status);
        let user;
        if (existingTarget && (patch.password_hash || statusChanged)) {
          const credentialPatch = {}; const rest = { ...patch };
          if (patch.password_hash) { credentialPatch.password_hash = patch.password_hash; credentialPatch.password_changed_at = patch.password_changed_at; delete rest.password_hash; delete rest.password_changed_at; }
          if (statusChanged) { credentialPatch.status = patch.status; delete rest.status; }
          const changed = await applyCredentialChange({ store, config, target: existingTarget, patch: credentialPatch, auditActor: authContext, trigger: patch.password_hash ? "admin_password_set" : "status_change", requestId: ctx.requestId, req });
          user = Object.keys(rest).length ? await store.updateAdminUser(adminUserMatch[1], rest) : changed.user;
        } else {
          user = await store.updateAdminUser(adminUserMatch[1], patch);
        }
        if (!user) {
          notFound(res);
          return;
        }
        { const { password_hash: _hash, password_changed_at: _changedAt, ...auditablePatch } = patch; await appendAudit(store, authContext, "admin_user_updated", "admin_user", user.id, { ...auditablePatch, ...(patch.password_hash ? { password_set: true } : {}) }); }
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
        if (await denyNonHumanActor({ store, authContext, res, ctx, req, category: "admin_user_photo" })) return;
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
        if (await denyNonHumanActor({ store, authContext, res, ctx, req, category: "admin_user_reset" })) return;
        // Resetting ANOTHER member's credentials is organisation-
        // controlled, same gate as the rest of Team management.
        authorizePermission(authContext, "team.manage");
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
          expires_at: new Date(Date.now() + expiryHours(body?.expires_in_hours, 24) * 60 * 60 * 1000).toISOString(),
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
            reset: { id: reset.id, admin_user_id: reset.admin_user_id, email: reset.email, status: reset.status, expires_at: reset.expires_at, created_at: reset.created_at }, // R8: never the stored token digest
            reset_token: rawToken,
            reset_url: resetUrl,
            email_delivery: emailDelivery,
          },
          { "x-request-id": ctx.requestId }
        );
        return;
      }

      // ---------------------------------------------------------------
      // Oyi Communications Convergence, Slice 4 -- Team routing settings.
      // team.manage-gated (same authority as every other org-controlled
      // Team field) -- Slice 3's office_staff_profiles/
      // office_staff_capabilities were real and additive but had no
      // reader/writer until now. Staff identity stays admin_users.email
      // (path param), matching Slice 3's own store-layer design.
      // ---------------------------------------------------------------
      if (pathname === "/api/lead-agents/admin/staff/capability-catalog") {
        if (req.method !== "GET") {
          methodNotAllowed(res, "GET");
          return;
        }
        authorizePermission(authContext, "team.manage");
        json(res, 200, { catalog: DEFAULT_CAPABILITIES }, { "x-request-id": ctx.requestId });
        return;
      }

      const staffRoutingProfileMatch = pathname.match(/^\/api\/lead-agents\/admin\/staff\/([^/]+)\/routing-profile$/);
      if (staffRoutingProfileMatch) {
        authorizePermission(authContext, "team.manage");
        const email = decodeURIComponent(staffRoutingProfileMatch[1]);
        if (req.method === "GET") {
          const [profile, capabilities] = await Promise.all([
            store.getStaffProfile(email),
            store.listStaffCapabilities(email),
          ]);
          json(res, 200, { profile, capabilities }, { "x-request-id": ctx.requestId });
          return;
        }
        if (req.method === "PATCH") {
          const body = await readJsonBody(req);
          requireObject(body, "body");
          const profile = await store.upsertStaffProfile(email, {
            business_unit: body.business_unit,
            availability: body.availability,
            routing_priority: body.routing_priority,
          });
          // Replace the capability set -- diffed against what's
          // currently stored so this stays a small, deliberate write
          // (no wholesale delete-then-recreate of every row on every
          // save), matching this codebase's established sparse-patch
          // convention elsewhere.
          const nextCapabilities = Array.isArray(body.capabilities) ? body.capabilities : [];
          const nextKeys = new Set(nextCapabilities.map((c) => String(c.capability || "").trim().toLowerCase()).filter(Boolean));
          const existing = await store.listStaffCapabilities(email);
          const removals = existing.filter((c) => !nextKeys.has(c.capability));
          await Promise.all([
            ...removals.map((c) => store.deleteStaffCapability(email, c.capability)),
            ...nextCapabilities
              .filter((c) => c.capability)
              .map((c) => store.upsertStaffCapability(email, { capability: c.capability, specialty: c.specialty || "" })),
          ]);
          const capabilities = await store.listStaffCapabilities(email);
          await appendAudit(store, authContext, "staff_routing_profile_updated", "office_staff_profile", email, {
            business_unit: profile.business_unit,
            availability: profile.availability,
            capability_count: capabilities.length,
          });
          json(res, 200, { profile, capabilities }, { "x-request-id": ctx.requestId });
          return;
        }
        methodNotAllowed(res, "GET,PATCH");
        return;
      }

      // ---------------------------------------------------------------
      // Team lifecycle: Active -> Deactivated (existing `status` PATCH,
      // already immediate -- enrichAuthContext 401s the very next
      // request once status != "active") -> Removed/Trash -> Permanently
      // Deleted. Same governance shape as Documents: Remove/Restore are
      // reversible, permanent delete requires the account to already be
      // removed first, all three team.manage-gated (super_admin only).
      // ---------------------------------------------------------------
      const adminUserRemoveMatch = pathname.match(/^\/api\/lead-agents\/admin\/users\/([^/]+)\/remove$/);
      if (adminUserRemoveMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        if (await denyNonHumanActor({ store, authContext, res, ctx, req, category: "admin_user_remove" })) return;
        authorizePermission(authContext, "team.manage");
        const id = adminUserRemoveMatch[1];
        const user = await store.getAdminUserById(id);
        if (!user) {
          notFound(res);
          return;
        }
        if (user.email && normalizeEmail(user.email) === normalizeEmail(authContext?.email || "")) {
          json(res, 400, { error: "cannot_remove_self" }, { "x-request-id": ctx.requestId });
          return;
        }
        const { user: updated } = await applyCredentialChange({ store, config, target: user, auditActor: authContext, trigger: "status_change", requestId: ctx.requestId, req, patch: {
          removed_at: new Date().toISOString(),
          removed_by: authContext?.email || "office",
          // Reuses the existing, already-immediate access-revocation
          // check (enrichAuthContext rejects any status != "active") --
          // no separate revocation logic needed.
          status: "removed",
        } });
        await appendAudit(store, authContext, "admin_user_removed", "admin_user", id, { email: user.email });
        json(res, 200, { user: sanitizeAdminUser(updated) }, { "x-request-id": ctx.requestId });
        return;
      }

      const adminUserRestoreMatch = pathname.match(/^\/api\/lead-agents\/admin\/users\/([^/]+)\/restore$/);
      if (adminUserRestoreMatch) {
        if (req.method !== "POST") {
          methodNotAllowed(res, "POST");
          return;
        }
        if (await denyNonHumanActor({ store, authContext, res, ctx, req, category: "admin_user_restore" })) return;
        authorizePermission(authContext, "team.manage");
        const id = adminUserRestoreMatch[1];
        const user = await store.getAdminUserById(id);
        if (!user) {
          notFound(res);
          return;
        }
        const { user: updated } = await applyCredentialChange({ store, config, target: user, auditActor: authContext, trigger: "status_change", requestId: ctx.requestId, req, patch: { removed_at: null, removed_by: null, status: "active" } });
        await appendAudit(store, authContext, "admin_user_restored", "admin_user", id, { email: user.email });
        json(res, 200, { user: sanitizeAdminUser(updated) }, { "x-request-id": ctx.requestId });
        return;
      }

      const adminUserPermanentMatch = pathname.match(/^\/api\/lead-agents\/admin\/users\/([^/]+)\/permanent$/);
      if (adminUserPermanentMatch) {
        if (req.method !== "DELETE") {
          methodNotAllowed(res, "DELETE");
          return;
        }
        if (await denyNonHumanActor({ store, authContext, res, ctx, req, category: "admin_user_permanent_delete" })) return;
        authorizePermission(authContext, "team.manage");
        const id = adminUserPermanentMatch[1];
        const user = await store.getAdminUserById(id);
        if (!user) {
          json(res, 200, { ok: true, already_deleted: true, id }, { "x-request-id": ctx.requestId });
          return;
        }
        if (!user.removed_at) {
          json(res, 409, { ok: false, error: "user_not_removed" }, { "x-request-id": ctx.requestId });
          return;
        }
        // Real physical delete -- see deleteAdminUser's comment in the
        // store layer for exactly why this is safe: no business table
        // FKs to admin_users.id, every historical document/meeting/
        // audit row already keeps its owner/actor as a durable email
        // string independent of whether this row still exists.
        await store.deleteAdminUser(id);
        await appendAudit(store, authContext, "admin_user_permanently_deleted", "admin_user", id, { email: user.email });
        json(res, 200, { ok: true, deleted: true, id }, { "x-request-id": ctx.requestId });
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

      const external = externalErrorBody(err, ctx.requestId); // R8: no driver text, hostnames, SQL or upstream bodies in a response; the log above has them under this request_id
      json(res, external.statusCode, external.body, { "x-request-id": ctx.requestId });
    }
  });

  // Background delivery of queued communication evidence to Backend (production by default; tests opt in explicitly). Stops with the server.
  if ((config.communicationOutboxWorker ?? config.environment === "production") && config.officeBackendBaseUrl && config.officeBackendApiKey && typeof store.listDueCommunicationDeliveries === "function") {
    communicationOutboxWorkerHandle = communicationOutbox.startOutboxWorker({ store, config, log });
    server.on("close", () => communicationOutboxWorkerHandle.stop());
  }
  return server;
}

// Settings S7.5.7: the audit adapter for the deployment-owner break-glass (a system actor; e-mail and recovery id only, never a secret).
function runBreakGlass(store, config) {
  const audit = (action, metadata, status) => appendAudit(store, { type: "system", email: "break-glass", role: "system" }, action, "admin_user", metadata.target_user_id || "", { ...metadata, at: new Date().toISOString() }, undefined, status);
  return applyBreakGlass({ store, config, audit, log });
}

async function start() {
  const config = createConfig();
  validateConfig(config);

  const authStatus = validateAuthConfig(config);
  if (!authStatus.valid) log("error", "auth_configuration_invalid", { problems: authStatus.problems });
  if (config.sessionSecretEphemeral) log("warn", "session_secret_ephemeral", { note: "LEAD_AGENTS_SESSION_SECRET is unset; sessions will not survive a restart" });
  if (config.allowApiKeyPasswordLogin) log("warn", "api_key_password_login_enabled_deprecated", {});
  { const mfaStartup = validateMfaConfig(config); if (mfaStartup.mode === "on" && !mfaStartup.valid) log("error", "mfa_configuration_invalid", { problems: mfaStartup.problems }); else if (mfaStartup.mode === "off" && mfaStartup.problems.length) log("warn", "mfa_key_configured_but_mfa_off", { problems: mfaStartup.problems }); }
  if (config.sessionTtlStatus && config.sessionTtlStatus !== "ok") log("warn", "session_ttl_env_adjusted", { status: config.sessionTtlStatus, applied_hours: config.sessionTtlMs / 3_600_000 });
  if (config.adminRecovery) log("warn", "admin_recovery_enabled", { note: "remove LEAD_AGENTS_ADMIN_RECOVERY after signing in" });

  const store = createStore(config);
  await store.init();
  await bootstrapAdminUser(store, config);
  await runBreakGlass(store, config); // S7.5.7: deployment-owner MFA recovery; process start is its only entry (never an HTTP route)

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
  // R6: no injected login limiter here -- buildServer builds the shared (database-backed when available) limiters from config.loginRateLimit* itself.

  const server = buildServer({
    config,
    store,
    rateLimiter,
    publicRateLimiter,
    officeRateLimiter,
    
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
  bootstrapAdminUser,
  runBreakGlass,
};
