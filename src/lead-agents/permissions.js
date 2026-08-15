const PERMISSION_KEYS = Object.freeze([
  "estates.read",
  "estates.write",
  "homes.read",
  "homes.write",
  "devices.read",
  "devices.control",
  "cameras.view",
  "visitors.create",
  "visitors.manage",
  "wallets.read",
  "wallets.manage",
  "support.read",
  "support.assign",
  "documents.generate",
  "projects.read",
  "projects.manage",
  "portfolio.read",
  "portfolio.manage",
  "private.read",
  "private.manage",
  "partnerships.read",
  "partnerships.manage",
  "tasks.read",
  "tasks.manage",
  "meetings.read",
  "meetings.manage",
  "office.intelligence",
  "twin.view",
  "twin.control",
  "planstudio.read",
  "planstudio.write",
  "staff.manage",
  "settings.manage",
  "audit.read",
  "office.read",
  "office.manage",
  "crm.read",
  "crm.manage",
  "notifications.read",
  "notifications.manage",
  "messages.read",
  "messages.send",
  // Content/Publishing (Phase 8): draft/edit, review, and
  // approve-publish are three deliberately separate grants — writer !=
  // publisher. See ROLE_PERMISSIONS below for who gets which.
  "content.write",
  "content.review",
  "content.publish",
  "storage.read",
  "storage.write",
  "integrations.read",
  "integrations.manage",
  "auth.change_password",
]);

const ROLE_PERMISSIONS = Object.freeze({
  super_admin: PERMISSION_KEYS,
  ochiga_admin: PERMISSION_KEYS,
  ochiga_staff: [
    "office.read",
    "estates.read",
    "homes.read",
    "devices.read",
    "cameras.view",
    "support.read",
    "support.assign",
    "documents.generate",
    "projects.read",
    "projects.manage",
    "portfolio.read",
    "portfolio.manage",
    "private.read",
    "private.manage",
    "partnerships.read",
    "partnerships.manage",
    "tasks.read",
    "tasks.manage",
    "meetings.read",
    "meetings.manage",
    "office.intelligence",
    "crm.read",
    "notifications.read",
    "messages.read",
    "messages.send",
    // Writer + reviewer by default, deliberately NOT publisher — "do
    // not make every writer a publisher." Publish rights are granted
    // per-user via the existing permission_scopes additive mechanism
    // for staff who should have them, or via a role with full
    // PERMISSION_KEYS (super_admin/ochiga_admin).
    "content.write",
    "content.review",
    "storage.read",
    "integrations.read",
    "auth.change_password",
  ],
  estate_admin: [
    "estates.read",
    "estates.write",
    "homes.read",
    "homes.write",
    "devices.read",
    "devices.control",
    "cameras.view",
    "visitors.create",
    "visitors.manage",
    "wallets.read",
    "support.read",
    "support.assign",
    "documents.generate",
    "auth.change_password",
  ],
  facility_manager: [
    "estates.read",
    "estates.write",
    "homes.read",
    "homes.write",
    "devices.read",
    "devices.control",
    "cameras.view",
    "visitors.manage",
    "wallets.read",
    "support.read",
    "support.assign",
    "documents.generate",
    "auth.change_password",
  ],
  security_operator: [
    "estates.read",
    "homes.read",
    "devices.read",
    "devices.control",
    "cameras.view",
    "visitors.create",
    "visitors.manage",
    "support.read",
    "auth.change_password",
  ],
  maintenance_operator: [
    "estates.read",
    "homes.read",
    "devices.read",
    "devices.control",
    "support.read",
    "support.assign",
    "auth.change_password",
  ],
  finance_operator: [
    "estates.read",
    "homes.read",
    "wallets.read",
    "wallets.manage",
    "documents.generate",
    "support.read",
    "auth.change_password",
  ],
  resident: [
    "homes.read",
    "devices.read",
    "visitors.create",
    "wallets.read",
    "support.read",
    "auth.change_password",
  ],
  guest: ["visitors.create"],
  ai_agent: [
    "office.read",
    "estates.read",
    "homes.read",
    "devices.read",
    "cameras.view",
    "support.read",
    "crm.read",
    "documents.generate",
    "projects.read",
    "portfolio.read",
    "tasks.read",
    "meetings.read",
    "office.intelligence",
    "twin.view",
    "planstudio.read",
  ],
});

const LEGACY_ROLE_ALIASES = Object.freeze({
  admin: "super_admin",
  founder: "super_admin",
  operator: "ochiga_admin",
  sales: "ochiga_staff",
  viewer: "ochiga_staff",
});

const LEGACY_PERMISSION_ALIASES = Object.freeze({
  view_dashboard: "office.read",
  view_reports: "office.read",
  view_traces: "audit.read",
  view_audit: "audit.read",
  view_users: "staff.manage",
  manage_users: "staff.manage",
  manage_security: "settings.manage",
  manage_leads: "crm.manage",
  manage_demos: "crm.manage",
  manage_commercial: "crm.manage",
  manage_takeover: "crm.manage",
  manage_notifications: "notifications.manage",
  escalate_founder: "notifications.manage",
  change_password: "auth.change_password",
  view_office: "office.read",
  manage_office: "office.manage",
  view_estates: "estates.read",
  manage_estates: "estates.write",
  view_buildings: "estates.read",
  manage_buildings: "estates.write",
  view_devices: "devices.read",
  manage_devices: "devices.control",
  view_wallets: "wallets.read",
  manage_wallets: "wallets.manage",
  view_documents: "documents.generate",
  manage_documents: "documents.generate",
  view_projects: "projects.read",
  manage_projects: "projects.manage",
  view_portfolio: "portfolio.read",
  manage_portfolio: "portfolio.manage",
  view_private: "private.read",
  manage_private: "private.manage",
  view_partnerships: "partnerships.read",
  manage_partnerships: "partnerships.manage",
  view_tasks: "tasks.read",
  manage_tasks: "tasks.manage",
  view_meetings: "meetings.read",
  manage_meetings: "meetings.manage",
  use_office_intelligence: "office.intelligence",
  view_integrations: "integrations.read",
  manage_integrations: "integrations.manage",
  view_storage: "storage.read",
  manage_storage: "storage.write",
});

function canonicalRole(role) {
  const value = String(role || "guest").trim().toLowerCase();
  return LEGACY_ROLE_ALIASES[value] || value;
}

function canonicalPermission(permission) {
  const value = String(permission || "").trim();
  return LEGACY_PERMISSION_ALIASES[value] || value;
}

function legacyPermissionsForCanonical(permission) {
  return Object.entries(LEGACY_PERMISSION_ALIASES)
    .filter(([, canonical]) => canonical === permission)
    .map(([legacy]) => legacy);
}

function permissionsForRole(role, extraScopes) {
  const canonical = canonicalRole(role);
  const base = ROLE_PERMISSIONS[canonical] || ROLE_PERMISSIONS.guest;
  const normalized = new Set();
  base.forEach((permission) => {
    normalized.add(permission);
    legacyPermissionsForCanonical(permission).forEach((legacy) => normalized.add(legacy));
  });
  (Array.isArray(extraScopes) ? extraScopes : []).forEach((scope) => {
    const canonicalScope = canonicalPermission(scope);
    normalized.add(scope);
    normalized.add(canonicalScope);
    legacyPermissionsForCanonical(canonicalScope).forEach((legacy) => normalized.add(legacy));
  });
  return Array.from(normalized);
}

function hasPermission(session, permission) {
  if (!session) return false;
  if (session.type === "api_key") return true;
  const requested = canonicalPermission(permission);
  return permissionsForRole(session.role, session.permissionScopes).some(
    (item) => item === permission || canonicalPermission(item) === requested
  );
}

module.exports = {
  LEGACY_PERMISSION_ALIASES,
  LEGACY_ROLE_ALIASES,
  PERMISSION_KEYS,
  ROLE_PERMISSIONS,
  canonicalPermission,
  canonicalRole,
  hasPermission,
  permissionsForRole,
};
