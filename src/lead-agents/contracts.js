const CONTRACT_VERSION = "tier1.2026-05-16";

const ENTITY_TYPES = Object.freeze([
  "user",
  "staff",
  "estate",
  "building",
  "home",
  "room",
  "device",
  "camera",
  "wallet",
  "visitor",
  "maintenance_ticket",
  "support_ticket",
  "document",
  "plan",
  "digital_twin_object",
  "edge_agent",
  "event",
  "audit_log",
  "notification",
]);

function asString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function asIso(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function baseEntity(input, type) {
  const row = input && typeof input === "object" ? input : {};
  return {
    id: asString(row.id || row._id || `${type}_${Date.now().toString(36)}`),
    type,
    source_system: asString(row.source_system || row.source || "office"),
    estate_id: row.estate_id || row.estateId || null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    created_at: asIso(row.created_at || row.createdAt),
    updated_at: asIso(row.updated_at || row.updatedAt),
  };
}

function userContract(input = {}) {
  return {
    ...baseEntity(input, "user"),
    email: asString(input.email).toLowerCase(),
    phone: asString(input.phone),
    display_name: asString(input.display_name || input.displayName || input.name),
    role: asString(input.role || "guest"),
    status: asString(input.status || "active"),
    home_ids: Array.isArray(input.home_ids || input.homeIds) ? input.home_ids || input.homeIds : [],
  };
}

function staffContract(input = {}) {
  return {
    ...userContract(input),
    type: "staff",
    staff_profile_id: asString(input.staff_profile_id || input.staffProfileId || input.id),
    permission_scopes: Array.isArray(input.permission_scopes) ? input.permission_scopes : [],
    passport_photo_url: asString(input.passport_photo_url),
    qr_credential: asString(input.qr_credential),
  };
}

function estateContract(input = {}) {
  return {
    ...baseEntity(input, "estate"),
    name: asString(input.name, "Unnamed Estate"),
    location: asString(input.location || input.address),
    status: asString(input.status || "active"),
    subscription_status: asString(input.subscription_status || "live"),
    package_id: input.package_id || input.packageId || null,
    latitude: input.latitude ?? input.lat ?? null,
    longitude: input.longitude ?? input.lng ?? null,
    health_score: input.health_score ?? input.healthScore ?? null,
  };
}

function buildingContract(input = {}) {
  return {
    ...baseEntity(input, "building"),
    name: asString(input.name, "Unnamed Building"),
    status: asString(input.status || "active"),
    type: asString(input.type),
    homes_count: asNumber(input.homes_count || input.homesCount),
    devices_count: asNumber(input.devices_count || input.devicesCount),
  };
}

function homeContract(input = {}) {
  return {
    ...baseEntity(input, "home"),
    building_id: input.building_id || input.buildingId || null,
    name: asString(input.name || input.unit || input.label, "Unnamed Home"),
    residents_count: asNumber(input.residents_count || input.residentsCount),
    devices_count: asNumber(input.devices_count || input.devicesCount),
    wallet_balance: asNumber(input.wallet_balance || input.walletBalance),
    automation_state: asString(input.automation_state || input.automationState || "standby"),
  };
}

function deviceContract(input = {}) {
  return {
    ...baseEntity(input, "device"),
    building_id: input.building_id || input.buildingId || null,
    home_id: input.home_id || input.homeId || null,
    name: asString(input.name, "Unnamed Device"),
    category: asString(input.category || input.type || "device"),
    provider: asString(input.provider),
    protocol: asString(input.protocol),
    status: asString(input.status || "unknown"),
    battery_level: input.battery_level ?? input.batteryLevel ?? null,
    last_seen_at: input.last_seen_at || input.lastSeenAt || null,
  };
}

function cameraContract(input = {}) {
  return {
    ...deviceContract({ ...input, category: input.category || "camera" }),
    type: "camera",
    stream_url: asString(input.stream_url || input.streamUrl),
    recording: Boolean(input.recording),
  };
}

function walletContract(input = {}) {
  return {
    ...baseEntity(input, "wallet"),
    scope_type: asString(input.scope_type || input.scopeType || "estate"),
    scope_id: asString(input.scope_id || input.scopeId),
    label: asString(input.label || "Wallet"),
    balance: asNumber(input.balance),
    currency: asString(input.currency || "NGN"),
    pending_charges: asNumber(input.pending_charges || input.pendingCharges),
  };
}

function ticketContract(input = {}, type = "support_ticket") {
  return {
    ...baseEntity(input, type),
    title: asString(input.title, "Untitled Ticket"),
    category: asString(input.category || "general"),
    priority: asString(input.priority || "medium"),
    status: asString(input.status || "open"),
    assigned_to: asString(input.assigned_to || input.assignedTo || input.assigned_team),
  };
}

function documentContract(input = {}) {
  return {
    ...baseEntity(input, "document"),
    title: asString(input.title, "Untitled Document"),
    document_type: asString(input.document_type || input.type || "document"),
    status: asString(input.status || "draft"),
    owner: asString(input.owner),
    file_url: asString(input.file_url || input.fileUrl),
    html_url: asString(input.html_url || input.htmlUrl),
  };
}

function eventContract(input = {}) {
  return {
    ...baseEntity(input, "event"),
    name: asString(input.name || input.event || input.action, "event"),
    resource_type: asString(input.resource_type || input.resourceType || input.target_type),
    resource_id: asString(input.resource_id || input.resourceId || input.target_id),
    actor_id: input.actor_id || input.actorId || input.actor_user_id || null,
    actor_role: asString(input.actor_role || input.actorRole),
    status: asString(input.status || "ok"),
    occurred_at: asIso(input.occurred_at || input.created_at),
  };
}

function auditLogContract(input = {}) {
  return {
    ...eventContract(input),
    type: "audit_log",
    action: asString(input.action || input.name, "audit.event"),
    actor_email: asString(input.actor_email || input.actorEmail),
    ip: asString(input.ip),
    user_agent: asString(input.user_agent || input.userAgent),
  };
}

module.exports = {
  CONTRACT_VERSION,
  ENTITY_TYPES,
  auditLogContract,
  buildingContract,
  cameraContract,
  deviceContract,
  documentContract,
  estateContract,
  eventContract,
  homeContract,
  staffContract,
  ticketContract,
  userContract,
  walletContract,
};
