const { auditLogContract } = require("./contracts");

const AUDIT_EVENT_NAMES = Object.freeze([
  "user.login",
  "user.invited",
  "staff.created",
  "estate.created",
  "home.created",
  "device.registered",
  "device.command.requested",
  "device.command.executed",
  "visitor.created",
  "wallet.funded",
  "support.ticket.created",
  "support.ticket.assigned",
  "document.generated",
  "plan.uploaded",
  "twin.device.action",
  "edge.heartbeat",
  "permission.denied",
  "ai.command.received",
  "ai.tool.requested",
  "ai.tool.executed",
  "ai.tool.denied",
  "ai.voice.transcribed",
  "ai.response.generated",
  "ai.command.confirmation.required",
  "ai.command.confirmed",
  "ai.command.cancelled",
  "ai.action.failed",
  "communication.whatsapp.sent",
  "communication.whatsapp.send_failed",
  "whatsapp_autonomy_setting_changed",
  "communication.whatsapp.autonomous_blocked",
  "communication.whatsapp.origin_rejected",
  "communication.whatsapp.manual_reply",
]);

const LEGACY_ACTION_NAMES = Object.freeze({
  session_login: "user.login",
  admin_invite_created: "user.invited",
  admin_user_created: "staff.created",
  office_document_generated: "document.generated",
  office_file_uploaded: "plan.uploaded",
});

function requestIp(req) {
  // R6: the server resolves the client address once per request from the trusted-proxy boundary; the raw header is never used here.
  return req?.clientAddress || req?.socket?.remoteAddress || "";
}

function normalizeAuditInput(input = {}) {
  const action = LEGACY_ACTION_NAMES[input.action] || input.action;
  return auditLogContract({
    id: input.id,
    action,
    name: action,
    actor_id: input.actorId || input.actor_id || input.actor_user_id,
    actor_email: input.actorEmail || input.actor_email,
    actor_role: input.actorRole || input.actor_role,
    resource_type: input.resourceType || input.resource_type || input.target_type,
    resource_id: input.resourceId || input.resource_id || input.target_id,
    estate_id: input.estateId || input.estate_id,
    metadata: input.metadata || {},
    ip: input.ip,
    user_agent: input.userAgent || input.user_agent,
    status: input.status || "success",
    created_at: input.created_at,
  });
}

// Settings S7.5.0: defence in depth. A credential-bearing key can never reach the audit store, whatever a caller passes (an admin-set password once logged its hash here).
const REDACTED_AUDIT_KEYS = new Set(["password", "password_hash", "passwordhash", "new_password", "current_password", "token", "step_up_token", "stepuptoken", "secret", "session_secret", "authorization", "cookie"]);
function redactAuditMetadata(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return value;
  if (Array.isArray(value)) return value.map((item) => redactAuditMetadata(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = REDACTED_AUDIT_KEYS.has(key.toLowerCase()) ? "[redacted]" : redactAuditMetadata(item, depth + 1);
  return out;
}

async function appendAuditRecord({ store, authContext, action, resourceType, resourceId, metadata, req, status = "success" }) {
  if (!store?.appendAuditEvent) return null;
  const audit = normalizeAuditInput({
    actorId: authContext?.userId || null,
    actorEmail: authContext?.email || "",
    actorRole: authContext?.role || "",
    action,
    resourceType,
    resourceId,
    metadata: redactAuditMetadata(metadata),
    ip: requestIp(req),
    userAgent: req?.headers?.["user-agent"] || "",
    status,
    estateId: metadata?.estate_id || metadata?.estateId || null,
  });
  return store.appendAuditEvent({
    actor_user_id: audit.actor_id || null,
    actor_email: audit.actor_email || "",
    actor_role: audit.actor_role || "",
    action: audit.action,
    target_type: audit.resource_type,
    target_id: audit.resource_id || "",
    metadata: {
      ...(audit.metadata || {}),
      audit_contract_version: "tier1.2026-05-16",
      estate_id: audit.estate_id || null,
      ip: audit.ip || "",
      user_agent: audit.user_agent || "",
      status: audit.status || status,
    },
  });
}

module.exports = {
  AUDIT_EVENT_NAMES,
  LEGACY_ACTION_NAMES,
  appendAuditRecord,
  normalizeAuditInput,
  redactAuditMetadata,
  requestIp,
};
