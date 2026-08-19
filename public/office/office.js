// Ochiga Office — corporate shell (Phase 4: Private + Partnerships +
// Documents / Proposals / Quotations).
//
// Phase 1-3 (shell, Home/Attention, CRM, Projects/Portfolio/Support/
// Tasks/Meetings) are preserved as-is. Phase 4 turns the remaining
// major placeholders into real modules, and — because the latest
// backend hardening pass (commit a66c00a) added real status-transition
// and generic-activity contracts — also closes two Phase 3 gaps:
//   - Project/Portfolio/Support detail can now Add Note (the backend
//     didn't support a note sink for these in Phase 3; it does now).
//   - Task/Support/Project/Portfolio/Meeting detail now expose
//     restrained status-transition actions via the new PATCH routes.
// Private, Partnerships, Documents and Proposals/Quotations reuse the
// exact same shared primitives (renderStandardList, renderDetailShell,
// renderTimeline, railCard) — no new page pattern was invented.
//
// Every screen renders only from real backend contracts already
// documented in this repo. No independent reasoning happens here and
// nothing is fabricated. See PHASE4_REPORT for the full list of what
// is/isn't backed by a real mutation.
//
// Backend contracts used (all pre-existing, none altered):
//   GET  /api/lead-agents/admin/session/me
//   POST /api/lead-agents/admin/session/login
//   POST /api/lead-agents/admin/session/logout
//   POST /api/lead-agents/admin/office/intelligence/chat
//   GET  /api/lead-agents/admin/office/home
//   GET  /api/lead-agents/leads(/:id, /:id/timeline, /:id/proposals, /:id/conversations)
//   PATCH /api/lead-agents/leads/:id  (sparse)
//   GET/POST /api/lead-agents/admin/crm/{contacts|organizations|opportunities|activities|tasks}
//   PATCH /api/lead-agents/admin/crm/tasks/:id
//   GET/POST /api/lead-agents/admin/office/{projects|portfolio|support|private|partnerships|meetings}
//   PATCH /api/lead-agents/admin/office/{projects|portfolio|support|meetings}/:id
//   GET/POST /api/lead-agents/admin/office/activities/:relatedType/:relatedId  (generic, new)
//   GET  /api/lead-agents/admin/office/documents
//   POST /api/lead-agents/admin/documents/generate
//   GET  /api/lead-agents/admin/proposals
//   POST /api/lead-agents/leads/:id/proposals
//   PATCH /api/lead-agents/admin/proposals/:id
//   GET  /api/lead-agents/admin/office/handoffs  (safe projection, read-only here)
//   Private and Partnerships use governed review_status PATCH and
//   generic activities/notes. office_documents has no PATCH at all.

const state = {
  admin: null,
  segments: ["home"],
  selectedObject: null, // { type, id, label } | null — drives Oyi page_context
  renderToken: 0,
  oyiOpen: false,
  oyiBusy: false,
  oyiThreadStarted: false,
  notifications: [],
  notifUnreadCount: 0,
  notifPanelOpen: false,
};

const cache = {};

// ---------------------------------------------------------------
// API
// ---------------------------------------------------------------
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function cached(key, fetcher, force = false) {
  if (!force && cache[key]) return cache[key];
  const value = await fetcher();
  cache[key] = value;
  return value;
}

function invalidate(...keys) {
  keys.forEach((key) => delete cache[key]);
}

async function getHome() {
  return api("/api/lead-agents/admin/office/home");
}
async function apiListLeads() {
  return api("/api/lead-agents/leads");
}
async function apiGetLead(id) {
  return api(`/api/lead-agents/leads/${encodeURIComponent(id)}`);
}
async function apiUpdateLead(id, patch) {
  return api(`/api/lead-agents/leads/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
}
async function apiGetLeadTimeline(id) {
  return api(`/api/lead-agents/leads/${encodeURIComponent(id)}/timeline`);
}
async function apiGetLeadProposals(id) {
  return api(`/api/lead-agents/leads/${encodeURIComponent(id)}/proposals`);
}
async function apiGetLeadConversations(id) {
  return api(`/api/lead-agents/leads/${encodeURIComponent(id)}/conversations`);
}
async function apiListCrm(collection) {
  return api(`/api/lead-agents/admin/crm/${collection}`);
}
async function apiCreateCrm(collection, body) {
  return api(`/api/lead-agents/admin/crm/${collection}`, { method: "POST", body });
}
async function apiListOffice(collection) {
  return api(`/api/lead-agents/admin/office/${collection}`);
}
async function apiCreateOffice(collection, body) {
  return api(`/api/lead-agents/admin/office/${collection}`, { method: "POST", body });
}
// Sparse PATCH for governed operational collections. namespace is
// "crm" for tasks and "office" for Office-owned objects.
async function apiPatchOperational(namespace, collection, id, patch) {
  return api(`/api/lead-agents/admin/${namespace}/${collection}/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
}
async function apiGetRelatedActivities(relatedType, relatedId) {
  return api(`/api/lead-agents/admin/office/activities/${encodeURIComponent(relatedType)}/${encodeURIComponent(relatedId)}`);
}
async function apiCreateRelatedActivity(relatedType, relatedId, body) {
  return api(`/api/lead-agents/admin/office/activities/${encodeURIComponent(relatedType)}/${encodeURIComponent(relatedId)}`, { method: "POST", body });
}
async function apiListOfficeDocuments() {
  return api("/api/lead-agents/admin/office/documents");
}
async function apiGenerateDocument(body) {
  return api("/api/lead-agents/admin/documents/generate", { method: "POST", body });
}
async function apiListDocumentTemplates() {
  return cached("documentTemplates", () => api("/api/lead-agents/admin/documents/templates"));
}
async function apiListContent(status) {
  return api(`/api/lead-agents/admin/content${status ? `?status=${encodeURIComponent(status)}` : ""}`);
}
async function apiGetContent(id) {
  return api(`/api/lead-agents/admin/content/${encodeURIComponent(id)}`);
}
async function apiCreateContent(body) {
  return api("/api/lead-agents/admin/content", { method: "POST", body });
}
async function apiUpdateContent(id, patch) {
  return api(`/api/lead-agents/admin/content/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
}
async function apiContentAction(id, action, body) {
  return api(`/api/lead-agents/admin/content/${encodeURIComponent(id)}/${action}`, { method: "POST", body: body || {} });
}
async function apiListReports(status) {
  return api(`/api/lead-agents/admin/reports${status ? `?status=${encodeURIComponent(status)}` : ""}`);
}
async function apiGetReport(id) {
  return api(`/api/lead-agents/admin/reports/${encodeURIComponent(id)}`);
}
async function apiCreateReport(body) {
  return api("/api/lead-agents/admin/reports", { method: "POST", body });
}
async function apiReportDecision(id, decision, body) {
  return api(`/api/lead-agents/admin/reports/${encodeURIComponent(id)}/${decision}`, { method: "POST", body: body || {} });
}
async function apiListDevelopmentProjects() {
  return api("/api/lead-agents/admin/development-projects");
}
async function apiGetDevelopmentProject(id) {
  return api(`/api/lead-agents/admin/development-projects/${encodeURIComponent(id)}`);
}
async function apiCreateDevelopmentProject(body) {
  return api("/api/lead-agents/admin/development-projects", { method: "POST", body });
}
async function apiUpdateDevelopmentProject(id, patch) {
  return api(`/api/lead-agents/admin/development-projects/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
}
async function apiSyncDevelopmentProject(id) {
  return api(`/api/lead-agents/admin/development-projects/${encodeURIComponent(id)}/sync`, { method: "POST", body: {} });
}
async function apiUnpublishDevelopmentProject(id) {
  return api(`/api/lead-agents/admin/development-projects/${encodeURIComponent(id)}/unpublish`, { method: "POST", body: {} });
}
async function apiListProposals() {
  return api("/api/lead-agents/admin/proposals");
}
async function apiCreateLeadProposal(leadId, body) {
  return api(`/api/lead-agents/leads/${encodeURIComponent(leadId)}/proposals`, { method: "POST", body });
}
async function apiUpdateProposal(id, patch) {
  return api(`/api/lead-agents/admin/proposals/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
}
async function apiListHandoffs() {
  return api("/api/lead-agents/admin/office/handoffs");
}
// ---------------------------------------------------------------
// Team / Settings / Audit — moved out of the legacy dashboard.
// Same admin_users / integrations / audit_events contracts the
// legacy dashboard used; nothing new invented on the backend.
// ---------------------------------------------------------------
async function apiListAdminUsers() {
  return api("/api/lead-agents/admin/users");
}
async function apiCreateAdminUser(body) {
  return api("/api/lead-agents/admin/users", { method: "POST", body });
}
async function apiInviteAdminUser(body) {
  return api("/api/lead-agents/admin/users/invite", { method: "POST", body });
}
async function apiUpdateAdminUser(id, patch) {
  return api(`/api/lead-agents/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
}
async function apiResetAdminUserPassword(id) {
  return api(`/api/lead-agents/admin/users/${encodeURIComponent(id)}/reset`, { method: "POST", body: {} });
}
async function apiUploadAdminUserPhoto(id, photoDataUrl) {
  return api(`/api/lead-agents/admin/users/${encodeURIComponent(id)}/photo`, { method: "POST", body: { photo_data_url: photoDataUrl } });
}
// Self-service — updates the CURRENT signed-in user's own photo, not
// an arbitrary staff.manage-gated target the way the function above does.
async function apiUploadMyPhoto(photoDataUrl) {
  return api("/api/lead-agents/admin/session/photo", { method: "POST", body: { photo_data_url: photoDataUrl } });
}
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}
async function apiGetPermissionsMeta() {
  return cached("permissionsMeta", () => api("/api/lead-agents/admin/permissions"));
}
async function apiListMyNotifications() {
  return api("/api/lead-agents/admin/notifications/mine");
}
async function apiMarkNotificationRead(id) {
  return api(`/api/lead-agents/admin/notifications/${encodeURIComponent(id)}/read`, { method: "POST", body: {} });
}
async function apiListStaffDirectory() {
  return api("/api/lead-agents/admin/staff/directory");
}
async function apiListConversations() {
  return api("/api/lead-agents/admin/staff/conversations");
}
async function apiCreateConversation(participantEmails, type, title) {
  return api("/api/lead-agents/admin/staff/conversations", { method: "POST", body: { participant_emails: participantEmails, type, title } });
}
async function apiListConversationMessages(conversationId) {
  return api(`/api/lead-agents/admin/staff/conversations/${encodeURIComponent(conversationId)}/messages`);
}
async function apiSendMessage(conversationId, body, attachments) {
  return api(`/api/lead-agents/admin/staff/conversations/${encodeURIComponent(conversationId)}/messages`, { method: "POST", body: { body, attachments } });
}
async function apiMarkConversationRead(conversationId) {
  return api(`/api/lead-agents/admin/staff/conversations/${encodeURIComponent(conversationId)}/read`, { method: "POST", body: {} });
}
async function apiUploadAttachment(dataUrl, filename, mimeType) {
  return api("/api/lead-agents/admin/storage", { method: "POST", body: { data_url: dataUrl, purpose: "message_attachment", filename, mime_type: mimeType } });
}
async function apiUploadContentImage(dataUrl, filename, mimeType) {
  return api("/api/lead-agents/admin/storage", { method: "POST", body: { data_url: dataUrl, purpose: "content_featured_image", filename, mime_type: mimeType } });
}
async function apiUploadDevelopmentImage(dataUrl, filename, mimeType) {
  return api("/api/lead-agents/admin/storage", { method: "POST", body: { data_url: dataUrl, purpose: "development_cover_image", filename, mime_type: mimeType } });
}
async function apiListIntegrations() {
  return api("/api/lead-agents/admin/integrations");
}
async function apiTriggerOfficeSync(target) {
  return api("/api/lead-agents/admin/office/sync", { method: "POST", body: { target } });
}
async function apiListAudit() {
  return api("/api/lead-agents/admin/audit");
}

async function fetchLeads(force) {
  const data = await cached("leads", apiListLeads, force);
  return data.leads || [];
}
async function fetchContacts(force) {
  const data = await cached("contacts", () => apiListCrm("contacts"), force);
  return data.collection || [];
}
async function fetchOrganizations(force) {
  const data = await cached("organizations", () => apiListCrm("organizations"), force);
  return data.collection || [];
}
async function fetchOpportunities(force) {
  const data = await cached("opportunities", () => apiListCrm("opportunities"), force);
  return data.collection || [];
}
async function fetchActivities(force) {
  const data = await cached("activities", () => apiListCrm("activities"), force);
  return data.collection || [];
}
async function fetchTasks(force) {
  const data = await cached("tasks", () => apiListCrm("tasks"), force);
  return data.collection || [];
}
async function fetchMeetings(force) {
  const data = await cached("meetings", () => apiListOffice("meetings"), force);
  return data.collection || [];
}
async function fetchProjects(force) {
  const data = await cached("projects", () => apiListOffice("projects"), force);
  return data.collection || [];
}
async function fetchPortfolio(force) {
  const data = await cached("portfolio", () => apiListOffice("portfolio"), force);
  return data.collection || [];
}
async function fetchSupport(force) {
  const data = await cached("support", () => apiListOffice("support"), force);
  return data.collection || [];
}
async function fetchPrivate(force) {
  const data = await cached("private", () => apiListOffice("private"), force);
  return data.collection || [];
}
async function fetchPartnerships(force) {
  const data = await cached("partnerships", () => apiListOffice("partnerships"), force);
  return data.collection || [];
}
async function fetchDocuments(force) {
  const data = await cached("documents", apiListOfficeDocuments, force);
  return data.collection || [];
}
async function fetchProposals(force) {
  const data = await cached("proposals", apiListProposals, force);
  return data.proposals || [];
}
async function fetchHandoffs(force) {
  const data = await cached("handoffs", apiListHandoffs, force);
  return data.queue || [];
}
async function fetchRelatedActivities(relatedType, relatedId) {
  try {
    const data = await apiGetRelatedActivities(relatedType, relatedId);
    return data.collection || [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------
// Session
// ---------------------------------------------------------------
function hasPermission(key) {
  return Boolean(state.admin && Array.isArray(state.admin.permissions) && state.admin.permissions.includes(key));
}
function currentEmail() {
  return (state.admin && state.admin.email || "").toLowerCase();
}
function isMine(value) {
  return Boolean(value) && String(value).toLowerCase() === currentEmail();
}

async function fetchSession() {
  try {
    const data = await api("/api/lead-agents/admin/session/me");
    state.admin = data.admin;
    return true;
  } catch {
    state.admin = null;
    return false;
  }
}

async function login(email, password) {
  const data = await api("/api/lead-agents/admin/session/login", { method: "POST", body: { email, password } });
  state.admin = data.admin;
}

async function logout() {
  try {
    await api("/api/lead-agents/admin/session/logout", { method: "POST" });
  } catch {
    // Ignore — local state clears regardless.
  }
  state.admin = null;
  Object.keys(cache).forEach((key) => delete cache[key]);
}

// ---------------------------------------------------------------
// Navigation model — permission keys match permissions.js exactly.
// Tasks and Meetings are top-level, cross-company workspaces as of
// Phase 3 (they also surface contextually inside object detail rails).
// ---------------------------------------------------------------
const PRIMARY_NAV = [
  { key: "home", label: "Home", permission: "office.read", phase: null },
  { key: "crm", label: "CRM", permission: "crm.read", phase: null },
  { key: "projects", label: "Projects", permission: "projects.read", phase: null },
  { key: "portfolio", label: "Portfolio", permission: "portfolio.read", phase: null },
  { key: "support", label: "Support", permission: "support.read", phase: null },
  { key: "tasks", label: "Tasks", permission: "tasks.read", phase: null },
  { key: "meetings", label: "Meetings", permission: "meetings.read", phase: null },
  { key: "private", label: "Private", permission: "private.read", phase: null },
  { key: "partnerships", label: "Partnerships", permission: "partnerships.read", phase: null },
  { key: "documents", label: "Documents", permission: "documents.generate", phase: null },
  { key: "content", label: "Content", permission: "content.write", phase: null },
  { key: "reports", label: "Reports", permission: "reports.write", phase: null },
  { key: "development-projects", label: "Development", permission: "development.manage", phase: null },
];

const ADMIN_NAV = [
  { key: "team", label: "Team", permission: "staff.manage", phase: null },
  { key: "settings", label: "Settings", permission: "settings.manage", phase: null },
  { key: "audit", label: "Audit", permission: "audit.read", phase: null },
  // Route/key/permission unchanged — label-only rename (Programme 4 Home
  // redesign brief).
  { key: "observatory", label: "AI Agents", permission: "audit.read", phase: null },
];

// Small, restrained outline icons (16x16, stroke-based, currentColor) for
// the sidebar — Programme 4 Home redesign brief asked for "consistent
// professional outline icon beside every menu item... small, clean and
// restrained." No icon library exists in this codebase (confirmed: only
// 2 static state-panel icons anywhere), so these are hand-authored
// geometric outlines rather than a new asset/font dependency.
const NAV_ICONS = {
  home: '<path d="M2.5 7.5 8 3l5.5 4.5"/><path d="M4 6.5V13h3v-3.5h2V13h3V6.5"/>',
  crm: '<circle cx="6" cy="5.5" r="2"/><path d="M2 13c0-2.2 1.8-4 4-4s4 1.8 4 4"/><circle cx="11.5" cy="4.5" r="1.4"/><path d="M9.6 9.1c1.6.3 2.9 1.7 3 3.4"/>',
  projects: '<path d="M2.5 4.5h3.5l1.2 1.5H13.5v6.5h-11z"/>',
  portfolio: '<rect x="3" y="2" width="10" height="12" rx="0.5"/><path d="M5.5 5h1.5M9 5h1.5M5.5 8h1.5M9 8h1.5M5.5 11h1.5M9 11h1.5"/>',
  support: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.6"/><path d="M8 2.5V4M8 12v1.5M2.5 8H4M12 8h1.5"/>',
  tasks: '<rect x="3" y="2.5" width="10" height="11" rx="0.5"/><path d="M5.5 6.5 7 8l3-3.3M5.5 11h5"/>',
  meetings: '<rect x="2.5" y="3.5" width="11" height="10" rx="0.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  private: '<rect x="4" y="7" width="8" height="6" rx="0.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  partnerships: '<path d="M2.5 8.5 5 6l2 1.7L9.5 5 13.5 8.5"/><path d="M5 6 3 8l2 2 2-1.7M9.5 5l2 2-2 2-2-1.7"/>',
  documents: '<path d="M4.5 2.5h5l2 2v9h-7z"/><path d="M6 7h4M6 9.5h4M6 12h2.5"/>',
  content: '<path d="M3.5 12.5 3 14l1.5-.5 8-8-1-1z"/><path d="M10.5 3.5 12.5 5.5"/>',
  reports: '<rect x="4" y="2.5" width="8" height="11" rx="0.5"/><path d="M6 2.5V4h4V2.5M6 8l1.5 1.5L10 6.5"/>',
  "development-projects": '<path d="M3 13.5V6l5-2 5 2v7.5"/><path d="M3 13.5h10M6.5 13.5V9.5h3v4"/>',
  team: '<circle cx="5.5" cy="5.5" r="2"/><circle cx="11" cy="6" r="1.6"/><path d="M2 13c0-2.1 1.6-3.7 3.5-3.7S9 10.9 9 13"/><path d="M9.7 10c1.4.2 2.5 1.5 2.6 3"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 2.5v1.6M8 11.9v1.6M13.5 8h-1.6M4.1 8H2.5M11.8 4.2l-1.1 1.1M5.3 10.7l-1.1 1.1M11.8 11.8l-1.1-1.1M5.3 5.3 4.2 4.2"/>',
  audit: '<path d="M8 2 3 4v4c0 3.3 2.1 5.4 5 6 2.9-.6 5-2.7 5-6V4z"/><path d="M6 8l1.5 1.5L10.5 6"/>',
  observatory: '<rect x="5.5" y="5.5" width="5" height="5" rx="0.5"/><path d="M8 2.5V4M8 12v1.5M2.5 8H4M12 8h1.5M5 5.5l-.9-.9M11.9 5.5l.9-.9M5 10.5l-.9.9M11.9 10.5l.9.9"/><circle cx="8" cy="8" r="1"/>',
  inbox: '<path d="M2.5 4.5h11v7h-11z"/><path d="M2.5 4.5 8 9l5.5-4.5"/>',
  attention: '<path d="M8 1.8 14.5 13H1.5z"/><path d="M8 6.5v3.2"/><circle cx="8" cy="11.6" r="0.4" fill="currentColor" stroke="none"/>',
  briefing: '<circle cx="8" cy="8" r="6"/><path d="M8 5.2v3.3l2.2 1.3"/>',
  trend: '<path d="M2.5 11 6 7.5l2.5 2L13.5 4"/><path d="M10.5 4h3v3"/>',
  lightning: '<path d="M8.5 2 4 9h3.2L7 14l4.5-7H8.3z"/>',
  financial: '<rect x="2" y="4.5" width="12" height="8.5" rx="1"/><path d="M2 7h12"/><circle cx="11" cy="10" r="0.9" fill="currentColor" stroke="none"/>',
};
function iconSvg(key, className) {
  const inner = NAV_ICONS[key];
  if (!inner) return "";
  return `<svg class="${className}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}
function navIconSvg(key) {
  return iconSvg(key, "nav-icon");
}

// Inbox lives as a topbar icon (next to the notification bell), not a
// sidebar item — still registered here so findNavItem() resolves its
// permission gate and topbar title the same way every routed view does.
const INBOX_NAV_ITEM = { key: "inbox", label: "Inbox", permission: "messages.read", phase: null };

function allNavItems() {
  return [...PRIMARY_NAV, ...ADMIN_NAV, INBOX_NAV_ITEM];
}
function findNavItem(key) {
  return allNavItems().find((item) => item.key === key);
}

// ---------------------------------------------------------------
// Shared UI primitives
// ---------------------------------------------------------------
function el(html) {
  const wrap = document.createElement("div");
  wrap.innerHTML = html.trim();
  return wrap.firstElementChild;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
// Compact currency for KPI cards (Financial Unification Programme) — e.g.
// "₦2.4M". Only ever fed a real aggregate from /office/financial-summary,
// never a fabricated value.
function fmtCompactNaira(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}₦${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}₦${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}₦${(abs / 1_000).toFixed(1)}K`;
  return `${sign}₦${Math.round(abs).toLocaleString("en-NG")}`;
}
function fmtDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function fmtRelative(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const diffMs = Date.now() - date.getTime();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  const hrs = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const suffix = diffMs >= 0 ? "ago" : "from now";
  if (mins < 60) return `${Math.max(mins, 1)}m ${suffix}`;
  if (hrs < 24) return `${hrs}h ${suffix}`;
  if (days < 30) return `${days}d ${suffix}`;
  return fmtDate(value);
}
// input[type=datetime-local] needs local-time "YYYY-MM-DDTHH:mm", not a
// full ISO string — this is the pre-fill counterpart to the .toISOString()
// conversion already done on submit for these fields.
function toDatetimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function titleCase(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Minimal transient status message — used anywhere an action succeeds
// off-screen (email sent, link issued) without a full-page state change.
function toast(message, tone = "default") {
  const host = document.getElementById("toastHost") || (() => {
    const el_ = el(`<div id="toastHost" class="toast-host"></div>`);
    document.body.appendChild(el_);
    return el_;
  })();
  const node = el(`<div class="toast toast-${tone}">${escapeHtml(message)}</div>`);
  host.appendChild(node);
  setTimeout(() => node.remove(), 5000);
}

function skeletonPanel(lines = 3) {
  const widths = ["70%", "45%", "60%", "38%"];
  return el(`
    <div class="state-panel">
      ${Array.from({ length: lines }).map((_, i) => `<div class="skeleton-line" style="width:${widths[i % widths.length]}"></div>`).join("")}
    </div>
  `);
}
const EMPTY_STATE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h4l2 3h4l2-3h4"></path><path d="M5.5 6h13L21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6Z"></path></svg>`;
const ERROR_STATE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5"></path><path d="M12 16.2v.1"></path></svg>`;
function emptyPanel({ kicker, title, body }) {
  return el(`
    <div class="state-panel">
      <div class="state-icon">${EMPTY_STATE_ICON}</div>
      <div class="kicker">${escapeHtml(kicker)}</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${body}</p>
    </div>
  `);
}
function errorPanel(message) {
  return el(`
    <div class="state-panel error">
      <div class="state-icon">${ERROR_STATE_ICON}</div>
      <div class="kicker">Could not load</div>
      <h2>Something needs attention</h2>
      <p>${escapeHtml(message)}</p>
    </div>
  `);
}
function phaseTag(phase) {
  return `<span class="phase-tag">Phase ${phase}</span>`;
}
function badge(text, tone = "default") {
  return `<span class="badge badge-${tone}">${escapeHtml(text)}</span>`;
}
function toneForStatus(value) {
  const v = String(value || "").toLowerCase();
  if (/won|approved|active|resolved|completed|done|accepted/.test(v)) return "green";
  if (/lost|cancelled|declined|closed|overdue|urgent|critical/.test(v)) return "red";
  if (/pending|review|awaiting|open|new|high/.test(v)) return "amber";
  return "default";
}

// A single reusable data table: renders as a CSS grid on desktop and
// stacks into label:value rows via CSS at narrow widths (see index.html).
function renderDataTable({ columns, rows, onRowClick, emptyMessage }) {
  if (!rows.length) {
    return emptyPanel({ kicker: "No records", title: "Nothing here yet", body: emptyMessage });
  }
  const template = columns.map((c) => c.width || "1fr").join(" ");
  const table = el(`<div class="crm-table" role="table"></div>`);
  const header = el(`<div class="crm-row crm-row-head" role="row"></div>`);
  header.style.gridTemplateColumns = template;
  columns.forEach((col) => header.appendChild(el(`<div class="cell" role="columnheader">${escapeHtml(col.label)}</div>`)));
  table.appendChild(header);

  rows.forEach((row) => {
    const tr = el(`<div class="crm-row" role="row" ${onRowClick ? 'tabindex="0"' : ""}></div>`);
    tr.style.gridTemplateColumns = template;
    if (onRowClick) tr.classList.add("clickable");
    columns.forEach((col) => {
      const cell = el(`<div class="cell" data-label="${escapeHtml(col.label)}" role="cell"></div>`);
      const value = col.render ? col.render(row) : escapeHtml(row[col.key] ?? "—");
      if (value instanceof Node) cell.appendChild(value);
      else cell.innerHTML = value;
      tr.appendChild(cell);
    });
    if (onRowClick) {
      tr.addEventListener("click", () => onRowClick(row));
      tr.addEventListener("keydown", (event) => {
        if (event.key === "Enter") onRowClick(row);
      });
    }
    table.appendChild(tr);
  });
  return table;
}

function renderToolbar({ query, onQuery, filters, primaryAction, secondaryAction }) {
  const bar = el(`<div class="list-toolbar"></div>`);
  const search = el(`<input type="search" class="toolbar-search" placeholder="Search…" />`);
  search.value = query || "";
  search.addEventListener("input", () => onQuery(search.value));
  bar.appendChild(search);

  (filters || []).forEach((filter) => {
    const select = el(`<select class="toolbar-filter"></select>`);
    select.appendChild(el(`<option value="">${escapeHtml(filter.label)}</option>`));
    filter.options.forEach((opt) => {
      const optionEl = el(`<option value="${escapeHtml(opt)}">${escapeHtml(titleCase(opt))}</option>`);
      if (opt === filter.value) optionEl.selected = true;
      select.appendChild(optionEl);
    });
    select.addEventListener("change", () => filter.onChange(select.value));
    bar.appendChild(select);
  });

  const spacer = el(`<div class="toolbar-spacer"></div>`);
  bar.appendChild(spacer);

  if (secondaryAction) {
    const btn = el(`<button type="button" class="btn btn-ghost btn-sm">${escapeHtml(secondaryAction.label)}</button>`);
    btn.addEventListener("click", secondaryAction.onClick);
    bar.appendChild(btn);
  }
  if (primaryAction) {
    const btn = el(`<button type="button" class="btn btn-primary btn-sm">${escapeHtml(primaryAction.label)}</button>`);
    btn.addEventListener("click", primaryAction.onClick);
    bar.appendChild(btn);
  }
  return bar;
}

// ---------------------------------------------------------------
// Timeline — shared across Lead detail (real timeline_events) and
// Contact/Organization/Opportunity detail (crm_activities filtered
// client-side, since those entities have no dedicated timeline table
// yet — see PHASE2 note in renderCrmDetail).
// ---------------------------------------------------------------
const TIMELINE_ICON = {
  lead_created: "＋", office_intake_received: "◆", lead_qualified: "✓",
  building_review_scheduled: "◷", note: "✎", stage_change: "→",
  task: "☐", meeting: "◷", proposal: "▤", default: "•",
};
function timelineIcon(type) {
  return TIMELINE_ICON[type] || TIMELINE_ICON.default;
}
function renderTimeline(events, { onAddNote, canAddNote } = {}) {
  const wrap = el(`<div class="timeline-block"></div>`);
  const head = el(`<div class="section-head"><h3>Timeline</h3></div>`);
  if (canAddNote) {
    const btn = el(`<button type="button" class="btn btn-ghost btn-sm">Add note</button>`);
    btn.addEventListener("click", onAddNote);
    head.appendChild(btn);
  }
  wrap.appendChild(head);

  if (!events.length) {
    wrap.appendChild(emptyPanel({
      kicker: "No activity yet",
      title: "Nothing recorded here yet",
      body: "Activity will appear here as the relationship progresses — notes, stage changes, tasks and meetings.",
    }));
    return wrap;
  }

  const list = el(`<div class="timeline-list"></div>`);
  [...events]
    .sort((a, b) => String(b.occurred_at || b.created_at || "").localeCompare(String(a.occurred_at || a.created_at || "")))
    .forEach((event) => {
      const type = event.event_type || event.activity_type || "default";
      const item = el(`
        <div class="timeline-item">
          <span class="timeline-icon">${timelineIcon(type)}</span>
          <div class="timeline-content">
            <div class="timeline-title">${escapeHtml(event.title || titleCase(type))}</div>
            ${event.body ? `<div class="timeline-body">${escapeHtml(event.body)}</div>` : ""}
            <div class="timeline-meta">${escapeHtml(event.actor || event.owner || "")} · ${escapeHtml(fmtRelative(event.occurred_at || event.created_at))}</div>
          </div>
        </div>
      `);
      list.appendChild(item);
    });
  wrap.appendChild(list);
  return wrap;
}

// ---------------------------------------------------------------
// Object detail shell — shared by Lead / Contact / Organization /
// Opportunity detail. Renders a summary header, a two-column body
// (main content + a compact related-records rail) and wires the
// persistent Oyi control's context to this object.
// ---------------------------------------------------------------
function renderDetailShell(outlet, { type, id, label, typeLine, badges, backLabel, onBack, mainSections, railSections, oyiContext }) {
  setSelectedObject(type, id, label, oyiContext);
  outlet.innerHTML = "";

  const back = el(`<button type="button" class="detail-back">← ${escapeHtml(backLabel)}</button>`);
  back.addEventListener("click", onBack);
  outlet.appendChild(back);

  const header = el(`
    <div class="detail-header">
      <div>
        <div class="detail-typeline">${escapeHtml(typeLine)}</div>
        <h1>${escapeHtml(label)}</h1>
        <div class="detail-badges">${(badges || []).join("")}</div>
      </div>
    </div>
  `);
  outlet.appendChild(header);

  const body = el(`<div class="detail-body"></div>`);
  const main = el(`<div class="detail-main"></div>`);
  const rail = el(`<div class="detail-rail"></div>`);
  mainSections.forEach((section) => main.appendChild(section));
  (railSections || []).forEach((section) => rail.appendChild(section));
  body.appendChild(main);
  if (railSections && railSections.length) body.appendChild(rail);
  outlet.appendChild(body);
}

function railCard(title, contentNodeOrHtml, action) {
  const card = el(`<div class="rail-card"></div>`);
  const head = el(`<div class="rail-card-head"><h4>${escapeHtml(title)}</h4></div>`);
  if (action) {
    const btn = el(`<button type="button" class="btn btn-ghost btn-sm">${escapeHtml(action.label)}</button>`);
    btn.addEventListener("click", action.onClick);
    head.appendChild(btn);
  }
  card.appendChild(head);
  if (contentNodeOrHtml instanceof Node) card.appendChild(contentNodeOrHtml);
  else card.insertAdjacentHTML("beforeend", contentNodeOrHtml);
  return card;
}
function railList(items, renderItem) {
  if (!items.length) return `<p class="rail-empty">None</p>`;
  return `<ul class="rail-list">${items.map((item) => `<li>${renderItem(item)}</li>`).join("")}</ul>`;
}

// ---------------------------------------------------------------
// Shared design primitives (Programme 4 Part 5/6) — consolidates
// kpi-grid/fact-grid/stage-strip markup that was previously
// hand-written 2-3 times across Home/CRM/Observatory with the exact
// same CSS classes but slightly different call shapes. These reuse the
// existing .kpi-*/.stage-*/.fact-* CSS untouched — no new styling for
// them. Callers still own their own data/permission logic; these only
// take already-computed values and never fetch or fabricate anything.
// ---------------------------------------------------------------
// `tone` (optional): "red"|"blue"|"amber"|"green"|"violet" — wraps the
// icon in a compact colored container instead of a bare monochrome
// glyph. Omitting it keeps the original neutral treatment, so existing
// callers (CRM/Reports/Portfolio/Development/AI Agents) are unaffected.
function KPIGroup(cards) {
  const grid = el(`<div class="kpi-grid"></div>`);
  cards.forEach((card) => {
    const node = el(`
      <div class="kpi-card${card.onClick ? " clickable" : ""}${card.alert ? " kpi-alert" : ""}">
        ${card.icon ? `<span class="kpi-icon-box${card.tone ? ` kpi-icon-${card.tone}` : ""}">${card.icon}</span>` : ""}
        <span class="kpi-label">${escapeHtml(card.label)}</span>
        <span class="kpi-value">${escapeHtml(String(card.value))}</span>
        ${card.sub ? `<span class="kpi-sub">${escapeHtml(card.sub)}</span>` : ""}
      </div>
    `);
    if (card.onClick) node.addEventListener("click", card.onClick);
    grid.appendChild(node);
  });
  return grid;
}
// rows: Array<{ label, value }|{ label, html }> — `html` is for values
// that already contain markup (e.g. a badge), mirroring factRow/
// factRowHtml's existing escape-vs-trusted-markup split.
function FactGrid(rows) {
  return el(`<div class="fact-grid">${rows.map((row) => (row.html !== undefined ? factRowHtml(row.label, row.html) : factRow(row.label, row.value))).join("")}</div>`);
}
function StageStrip(items, emptyText) {
  const strip = el(`<div class="stage-strip"></div>`);
  items.forEach(({ label, count }) => {
    strip.appendChild(el(`<div class="stage-chip"><span class="stage-count">${escapeHtml(String(count))}</span><span>${escapeHtml(label)}</span></div>`));
  });
  if (!items.length) strip.appendChild(el(`<p class="rail-empty">${escapeHtml(emptyText || "No records yet.")}</p>`));
  return strip;
}
// Returns null (never a fabricated 0%) when current/total aren't real,
// finite numbers — callers must check before appending, same pattern as
// "unsupported" evidence elsewhere in this codebase.
function ProgressBar(current, total, label) {
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
  const pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
  return el(`
    <div class="progress-bar-wrap">
      ${label ? `<div class="progress-bar-label"><span>${escapeHtml(label)}</span><span>${pct}%</span></div>` : ""}
      <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${pct}%;"></div></div>
    </div>
  `);
}
// Icon-led compact metric cell (Home closure pass) — lighter than
// KPIGroup's bordered cards (no border/padding box) and, unlike
// FactGrid, icon-led rather than stacked label-over-value. For
// secondary in-panel metric clusters (CRM/Portfolio Home panels);
// KPIGroup stays reserved for the primary top-level KPI row.
function metricCellGrid(cells) {
  const grid = el(`<div class="metric-cell-grid"></div>`);
  cells.forEach((cell) => {
    grid.appendChild(el(`
      <div class="metric-cell">
        ${cell.icon ? `<span class="kpi-icon-box${cell.tone ? ` kpi-icon-${cell.tone}` : ""} metric-cell-icon">${cell.icon}</span>` : ""}
        <div class="metric-cell-text">
          <div class="metric-cell-value">${escapeHtml(String(cell.value))}</div>
          <div class="metric-cell-label">${escapeHtml(cell.label)}</div>
        </div>
      </div>
    `));
  });
  return grid;
}

// ---------------------------------------------------------------
// Restrained status actions — mirrors
// src/lead-agents/office-operational-workflows.js STATUS_TRANSITIONS
// exactly. The backend is the source of truth and validates every
// transition server-side regardless of what this map says; this only
// decides which buttons to offer before the first PATCH. Private and
// Partnerships use review_status; the other operational records use
// status. Documents/Proposals remain read-only here.
// ---------------------------------------------------------------
const STATUS_TRANSITIONS = {
  tasks: {
    open: ["in_progress", "completed", "cancelled"],
    in_progress: ["open", "completed", "cancelled"],
    completed: [],
    cancelled: [],
  },
  support: {
    open: ["in_progress", "waiting_customer", "waiting_internal", "resolved", "closed"],
    in_progress: ["waiting_customer", "waiting_internal", "resolved", "closed"],
    waiting_customer: ["in_progress", "resolved", "closed"],
    waiting_internal: ["in_progress", "resolved", "closed"],
    resolved: ["in_progress", "closed"],
    closed: [],
  },
  projects: {
    planned: ["active", "on_hold", "cancelled"],
    prospective: ["planned", "active", "on_hold", "cancelled"],
    active: ["on_hold", "completed", "cancelled"],
    on_hold: ["active", "cancelled"],
    completed: [],
    cancelled: [],
  },
  portfolio: {
    active: ["on_hold", "completed", "cancelled"],
    normal: ["attention", "on_hold"],
    attention: ["normal", "on_hold"],
    on_hold: ["active", "normal", "cancelled"],
    completed: [],
    cancelled: [],
  },
  meetings: {
    scheduled: ["completed", "cancelled"],
    active: ["scheduled", "completed", "cancelled"],
    completed: [],
    cancelled: [],
  },
  private: {
    requested: ["under_review", "declined"],
    under_review: ["approved", "declined"],
    approved: ["active", "inactive"],
    active: ["inactive"],
    inactive: ["under_review"],
    declined: [],
  },
  partnerships: {
    new: ["under_review", "active", "declined"],
    under_review: ["active", "declined"],
    active: ["paused", "closed"],
    paused: ["active", "closed"],
    closed: [],
    declined: [],
  },
};
function allowedNextStatuses(collection, currentStatus) {
  const key = String(currentStatus || "").toLowerCase();
  return (STATUS_TRANSITIONS[collection] && STATUS_TRANSITIONS[collection][key]) || [];
}
// namespace: "crm" for tasks (PATCH /admin/crm/tasks/:id), "office"
// for projects/portfolio/support/meetings (PATCH /admin/office/:collection/:id).
function renderStatusActions(namespace, collection, record, onDone, options = {}) {
  const statusField = options.statusField || "status";
  const currentStatus = record[statusField] || record.status;
  const next = allowedNextStatuses(collection, currentStatus);
  if (!next.length) return null;
  const wrap = el(`<div class="status-actions"></div>`);
  const errorLabel = el(`<span class="form-status"></span>`);
  async function apply(status, extra) {
    try {
      await apiPatchOperational(namespace, collection, record.id, { [statusField]: status, ...(extra || {}) });
      invalidate(collection);
      onDone();
    } catch (err) {
      errorLabel.textContent = err.message || "Could not update status.";
    }
  }
  next.forEach((status) => {
    const btn = el(`<button type="button" class="btn btn-ghost btn-sm">Mark ${escapeHtml(titleCase(status))}</button>`);
    btn.addEventListener("click", () => {
      if (status === "resolved" && collection === "support" && !record.resolution_notes) {
        openDialog("Resolve Support Case", [{ name: "resolution_notes", label: "Resolution Notes", type: "textarea" }], (data) => apply(status, { resolution_notes: data.resolution_notes }));
        return;
      }
      apply(status);
    });
    wrap.appendChild(btn);
  });
  wrap.appendChild(errorLabel);
  return wrap;
}

// ---------------------------------------------------------------
// Generic related-activity note — used by Private/Partnerships/
// Documents/Proposals (new in Phase 4) and retrofitted onto Project/
// Portfolio/Support (which only gained a real note sink in this same
// backend hardening pass — Phase 3 shipped without "Add note" there
// because crm_activities had no project_id/portfolio_id/
// support_case_id column yet).
// ---------------------------------------------------------------
function promptAddRelatedNote(relatedType, relatedId) {
  openDialog("Add Note", [{ name: "title", label: "Title" }, { name: "body", label: "Note", type: "textarea" }], async (data) => {
    await apiCreateRelatedActivity(relatedType, relatedId, { title: data.title || "Note", body: data.body });
    renderRoute();
  });
}

// ---------------------------------------------------------------
// Router — generalized to support nested CRM routes:
//   #/home  #/crm  #/crm/leads  #/crm/leads/:id
//   #/crm/contacts/:id  #/crm/organizations/:id  #/crm/opportunities/:id
// Deep-linkable and refresh-safe, unlike the legacy tab-switcher.
// ---------------------------------------------------------------
function currentSegmentsFromHash() {
  const raw = (window.location.hash || "").replace(/^#\/?/, "");
  const segments = raw.split("/").filter(Boolean);
  return segments.length ? segments : ["home"];
}
function navigate(path) {
  const target = `#/${path}`;
  if (window.location.hash === target) renderRoute();
  else window.location.hash = target;
}
window.addEventListener("hashchange", () => {
  state.segments = currentSegmentsFromHash();
  renderRoute();
});

function setTopbar(title, meta) {
  document.getElementById("topbarTitle").textContent = title;
  document.getElementById("topbarMeta").textContent = meta || "";
}
// extraContext carries the SAFE, already-fetched summary of the
// selected record (crm_context / portfolio_context / support_context
// shape from Ochiga-backend's OfficeInternalOyiCoreRequest contract) so
// Oyi Core can reason about what staff are looking at without a second
// round-trip. It only ever contains fields Office already shows on
// screen — for Portfolio this is the safe aggregate operational_
// projection, never raw Facility/resident data.
function setSelectedObject(type, id, label, extraContext) {
  state.selectedObject = type ? { type, id, label, extraContext: extraContext || null } : null;
  updateOyiContext();
}

async function renderRoute() {
  const token = ++state.renderToken;
  const outlet = document.getElementById("viewOutlet");
  const [topKey, ...rest] = state.segments;
  const item = findNavItem(topKey) || PRIMARY_NAV[0];

  if (!hasPermission(item.permission)) {
    setTopbar(item.label, "");
    setSelectedObject(null);
    renderForbiddenView(outlet);
    syncNavActiveState();
    closeNavOnMobile();
    return;
  }

  if (topKey === "home") {
    setTopbar("Home", "");
    setSelectedObject(null);
    outlet.innerHTML = "";
    outlet.appendChild(skeletonPanel(4));
    await renderHomeView(outlet, token);
  } else if (topKey === "crm") {
    await renderCrmRoute(outlet, rest, token);
  } else if (topKey === "projects") {
    await renderModuleRoute(outlet, "projects", rest, token);
  } else if (topKey === "portfolio") {
    await renderModuleRoute(outlet, "portfolio", rest, token);
  } else if (topKey === "support") {
    await renderModuleRoute(outlet, "support", rest, token);
  } else if (topKey === "tasks") {
    await renderTasksRoute(outlet, rest, token);
  } else if (topKey === "meetings") {
    await renderModuleRoute(outlet, "meetings", rest, token);
  } else if (topKey === "private") {
    await renderModuleRoute(outlet, "private", rest, token);
  } else if (topKey === "partnerships") {
    await renderModuleRoute(outlet, "partnerships", rest, token);
  } else if (topKey === "documents") {
    await renderDocumentsRoute(outlet, rest, token);
  } else if (topKey === "content") {
    outlet.innerHTML = "";
    outlet.appendChild(skeletonPanel(4));
    await renderContentRoute(outlet, rest, token);
  } else if (topKey === "reports") {
    outlet.innerHTML = "";
    outlet.appendChild(skeletonPanel(4));
    await renderReportsRoute(outlet, rest, token);
  } else if (topKey === "development-projects") {
    outlet.innerHTML = "";
    outlet.appendChild(skeletonPanel(4));
    await renderDevelopmentProjectsRoute(outlet, rest, token);
  } else if (topKey === "inbox") {
    outlet.innerHTML = "";
    outlet.appendChild(skeletonPanel(4));
    await renderInboxRoute(outlet, rest, token);
  } else if (topKey === "team") {
    outlet.innerHTML = "";
    outlet.appendChild(skeletonPanel(4));
    await renderTeamView(outlet, token);
  } else if (topKey === "settings") {
    outlet.innerHTML = "";
    outlet.appendChild(skeletonPanel(4));
    await renderSettingsView(outlet, token);
  } else if (topKey === "audit") {
    outlet.innerHTML = "";
    outlet.appendChild(skeletonPanel(4));
    await renderAuditView(outlet, token);
  } else if (topKey === "observatory") {
    outlet.innerHTML = "";
    outlet.appendChild(skeletonPanel(4));
    await renderObservatoryView(outlet, token);
  } else {
    setTopbar(item.label, item.phase ? `Phase ${item.phase}` : "");
    setSelectedObject(null);
    renderPlaceholderView(outlet, item);
  }

  if (token !== state.renderToken) return;
  syncNavActiveState();
  closeNavOnMobile();
}

function renderPlaceholderView(outlet, item) {
  outlet.innerHTML = "";
  outlet.appendChild(el(`<div class="view-heading"><h1>${escapeHtml(item.label)}</h1></div>`));
  const panel = emptyPanel({
    kicker: "Not yet available",
    title: item.label,
    body: "This area does not have a route configured yet.",
  });
  if (item.phase) panel.insertBefore(el(phaseTag(item.phase)), panel.firstChild);
  outlet.appendChild(panel);
}
function renderForbiddenView(outlet) {
  outlet.innerHTML = "";
  outlet.appendChild(errorPanel("You don't have permission to view this area. Contact an administrator if you believe this is incorrect."));
}

// ---------------------------------------------------------------
// HOME — real attention and recent-activity projection from
// GET /admin/office/home. The client still hides sections where the
// signed-in staff member lacks the related permission.
// ---------------------------------------------------------------
const ATTENTION_PERMISSION = { task: "tasks.read", support_case: "support.read", proposal: "crm.read", lead: "crm.read" };
// attention_items carries only {type, id, title, priority, owner} — no
// timestamp, no secondary description (confirmed absent server-side:
// office-operating-system.js buildOfficeHomeProjection). route/
// actionLabel are honest because id IS the item's own record id for
// every type except "proposal", which has no known detail route (the
// pre-redesign Home never made proposal rows clickable either).
const ATTENTION_TYPE_META = {
  task: { label: "Tasks", icon: "tasks", tone: "blue", route: (id) => `tasks/${id}`, actionLabel: "View" },
  support_case: { label: "Support", icon: "support", tone: "amber", route: (id) => `support/${id}`, actionLabel: "Open" },
  lead: { label: "CRM", icon: "crm", tone: "violet", route: (id) => `crm/leads/${id}`, actionLabel: "Open" },
  proposal: { label: "Proposals", icon: "documents", tone: "green", route: null, actionLabel: null },
};
const ATTENTION_BORDER_COLOR = { red: "var(--red-bright)", green: "var(--green)", amber: "var(--amber)", default: "var(--line-strong)" };

// Never renders the raw email — a real display_name wins when set; the
// only fallback is a single word humanized from the email's local part
// (e.g. "contact.ochiga@..." -> "Contact"), never the full address.
function homeGreeting() {
  const hour = new Date().getHours();
  const time = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  // The admin-creation endpoint defaults an unset display_name to the
  // raw email (server.js), so a display_name that's actually an email
  // address is indistinguishable from "not set" by the time it gets
  // here — treat it the same as missing, not as a real name.
  const displayName = (state.admin?.display_name || "").trim();
  let name = displayName.includes("@") ? "" : displayName.split(/\s+/)[0];
  if (!name) {
    const localPart = (state.admin?.email || "").split("@")[0] || "";
    const humanized = localPart.replace(/[._+-]+/g, " ").trim().split(/\s+/)[0];
    name = humanized ? humanized.charAt(0).toUpperCase() + humanized.slice(1) : "there";
  }
  return `Good ${time}, ${escapeHtml(name)}`;
}

async function renderHomeView(outlet, token) {
  let home;
  // Real freshness signal for the Oyi Briefing header — the moment this
  // Home payload actually arrived, not a fabricated/cached timestamp.
  let homeFetchedAt;
  try {
    home = await getHome().then((d) => d.home);
    homeFetchedAt = new Date();
  } catch (err) {
    if (token !== state.renderToken) return;
    outlet.innerHTML = "";
    outlet.appendChild(el(`<div class="view-heading"><h1>Home</h1></div>`));
    outlet.appendChild(errorPanel(err.message || "Could not load your attention items."));
    return;
  }
  if (token !== state.renderToken) return;

  const visibleItems = home.attention_items.filter((item) => hasPermission(ATTENTION_PERMISSION[item.type] || "office.read"));
  const mine = visibleItems.filter((item) => isMine(item.owner));
  const summary = home.summary || {};

  // Fetched once, ahead of layout, so the Oyi Briefing's real "X
  // development projects currently in Y" sentence and the Development
  // panel below both read from the same real data — no duplicate fetch.
  let developmentProjects = [];
  let developmentFetchFailed = false;
  if (hasPermission("development.manage")) {
    try {
      const data = await apiListDevelopmentProjects();
      developmentProjects = data.projects || [];
    } catch {
      developmentFetchFailed = true;
    }
  }
  if (token !== state.renderToken) return;

  outlet.innerHTML = "";
  outlet.appendChild(el(`
    <div class="view-heading">
      <h1>${homeGreeting()} 👋</h1>
      <p>Here's what needs your attention across Ochiga today.</p>
    </div>
  `));

  outlet.appendChild(renderHomeKpiGrid(summary));

  const rowTop = el(`<div class="home-grid"></div>`);
  rowTop.appendChild(homePanelWrap("span-5", renderAttentionPanel(visibleItems)));
  rowTop.appendChild(homePanelWrap("span-4", renderMyWorkPanel(summary, mine)));
  rowTop.appendChild(homePanelWrap("span-3", renderOyiBriefingPanel(summary, mine, developmentProjects, homeFetchedAt)));
  outlet.appendChild(rowTop);

  const rowMid = el(`<div class="home-grid"></div>`);
  outlet.appendChild(rowMid);
  if (hasPermission("crm.read")) rowMid.appendChild(homePanelWrap("span-4", await renderCrmSnapshotPanel(token)));
  if (hasPermission("development.manage")) rowMid.appendChild(homePanelWrap("span-4", renderDevelopmentHomePanel(developmentProjects, developmentFetchFailed)));
  if (hasPermission("portfolio.read")) rowMid.appendChild(homePanelWrap("span-2", renderPortfolioPanel(summary)));
  if (hasPermission("meetings.read")) rowMid.appendChild(homePanelWrap("span-2", renderMeetingsPanel(home.upcoming_meetings || [])));
  if (token !== state.renderToken) return;

  const rowBottom = el(`<div class="home-grid"></div>`);
  outlet.appendChild(rowBottom);
  if (hasPermission("reports.write")) rowBottom.appendChild(homePanelWrap("span-3", await renderReportsHomePanel(token)));
  rowBottom.appendChild(homePanelWrap("span-3", renderRecentActivityPanel(home.recent_activity || [])));
  if (hasPermission("content.write") && home.content_publishing) rowBottom.appendChild(homePanelWrap("span-3", renderContentPanel(home.content_publishing)));
  if (hasPermission("audit.read")) rowBottom.appendChild(homePanelWrap("span-3", await renderAiAgentsHomePanel(token)));
}

function homePanelWrap(spanClass, panelNode) {
  const wrap = el(`<div class="${spanClass}"></div>`);
  if (panelNode) wrap.appendChild(panelNode);
  return wrap;
}
// freshnessLabel is for panels backed by a real captured timestamp (e.g.
// Oyi Briefing's "Updated Xm ago", from the moment this Home payload was
// actually fetched) — mutually exclusive with linkLabel/onLink since the
// reference only ever shows one or the other in that header slot.
function homePanel(title, linkLabel, onLink, freshnessLabel) {
  const head = el(`<div class="home-panel-head"><h3>${escapeHtml(title)}</h3></div>`);
  if (linkLabel && onLink) {
    const link = el(`<button type="button" class="panel-link">${escapeHtml(linkLabel)}</button>`);
    link.addEventListener("click", onLink);
    head.appendChild(link);
  } else if (freshnessLabel) {
    head.appendChild(el(`<span class="home-panel-freshness">${escapeHtml(freshnessLabel)}</span>`));
  }
  const panel = el(`<div class="home-panel"></div>`);
  panel.appendChild(head);
  return panel;
}

// KPI grid — one card per module the signed-in staff member can see,
// pulled entirely from the summary buildOfficeHomeProjection() already
// computes server-side. No client-side aggregation, no fabricated values.
// Ordered by executive priority — the top summary row shows only the
// first HOME_KPI_PRIORITY_COUNT permission-visible cards (Home redesign
// brief: "Do not display all metrics just because they exist"). The
// rest of these numbers aren't lost — they surface inside their own
// dedicated panels further down Home (CRM/Development/Portfolio/etc.).
// Final Home closure pass — fixed six-card executive order (Needs
// Attention, Active Projects, My Tasks, Pending Approvals, CRM Leads,
// Estate Cash Position). Cards not in this priority set (Portfolio, Open
// Support, Upcoming Meetings, Private/Partnerships Queue, Recent
// Documents) aren't lost — they surface inside their own dedicated panels
// further down Home.
const HOME_KPI_CARDS = [
  { key: "attention_count", label: "Needs Attention", permission: "office.read", icon: "attention", tone: "red", alert: (s) => s.attention_count > 0 },
  { key: "active_projects", label: "Active Projects", permission: "projects.read", route: "projects", icon: "projects", tone: "green" },
  { key: "open_tasks", label: "My Tasks", permission: "tasks.read", route: "tasks", icon: "tasks", tone: "blue", sub: (s) => (s.overdue_tasks ? `${s.overdue_tasks} overdue` : null), alert: (s) => s.overdue_tasks > 0 },
  { key: "reports_awaiting_approval", label: "Pending Approvals", permission: "reports.review", route: "reports", icon: "reports", tone: "amber", alert: (s) => s.reports_awaiting_approval > 0 },
  { key: "crm_leads", label: "CRM Leads", permission: "crm.read", route: "crm/leads", icon: "crm", tone: "violet" },
  // Financial Unification Programme — the one Home financial executive
  // KPI, real aggregate current balance across estate wallets (see
  // /office/financial-summary).
  { key: "financial_current_balance", label: "Estate Cash Position", permission: "financial.read", icon: "financial", tone: "green", format: (s) => fmtCompactNaira(s.financial_current_balance) },
  { key: "portfolio_entries", label: "Portfolio", permission: "portfolio.read", route: "portfolio", icon: "portfolio", tone: "blue" },
  { key: "open_support_cases", label: "Open Support", permission: "support.read", route: "support", icon: "support", tone: "amber" },
  { key: "upcoming_meetings", label: "Upcoming Meetings", permission: "meetings.read", route: "meetings", icon: "meetings", tone: "violet" },
  { key: "private_queue", label: "Private Queue", permission: "private.read", route: "private", icon: "private", tone: "green" },
  { key: "partnership_queue", label: "Partnerships Queue", permission: "partnerships.read", route: "partnerships", icon: "partnerships", tone: "violet" },
  { key: "recent_documents", label: "Recent Documents", permission: "documents.generate", route: "documents", icon: "documents", tone: "blue" },
];
const HOME_KPI_PRIORITY_COUNT = 6;
function renderHomeKpiGrid(summary) {
  const grid = el(`<div class="home-section"></div>`);
  const cards = HOME_KPI_CARDS.filter((card) => hasPermission(card.permission))
    .map((card) => {
      const value = summary[card.key];
      if (value === undefined) return null;
      return {
        label: card.label,
        value: card.format ? card.format(summary) : value,
        icon: card.icon ? iconSvg(card.icon, "kpi-icon") : null,
        tone: card.tone,
        sub: card.sub ? card.sub(summary) : null,
        alert: card.alert ? card.alert(summary) : false,
        onClick: card.route ? () => navigate(card.route) : null,
      };
    })
    .filter(Boolean)
    .slice(0, HOME_KPI_PRIORITY_COUNT);
  grid.appendChild(KPIGroup(cards));
  return grid;
}

// Compact operational-alert rows (Home closure pass) — deliberately not
// renderDataTable here: a header row + fixed grid columns cost more
// vertical space than this panel's density target allows, and the
// reference's row language (icon, stacked title/detail, domain, real
// age, action) doesn't map cleanly onto tabular columns anyway.
function renderAttentionPanel(items) {
  const panel = homePanel("Needs Attention");
  if (!items.length) {
    panel.appendChild(el(`<p class="home-panel-empty">Nothing needs attention right now.</p>`));
    return panel;
  }
  const list = el(`<div class="attention-list-v2"></div>`);
  items.forEach((item) => {
    const meta = ATTENTION_TYPE_META[item.type] || {};
    const tone = toneForStatus(item.priority);
    const row = el(`
      <div class="attention-row-v2" style="border-left-color:${ATTENTION_BORDER_COLOR[tone] || ATTENTION_BORDER_COLOR.default};">
        ${meta.icon ? `<span class="kpi-icon-box${meta.tone ? ` kpi-icon-${meta.tone}` : ""} attention-row-icon">${iconSvg(meta.icon, "kpi-icon")}</span>` : ""}
        <div class="attention-row-text">
          <div class="attention-row-title">${escapeHtml(item.title || "Untitled")}</div>
          ${item.detail ? `<div class="attention-row-detail">${escapeHtml(item.detail)}</div>` : ""}
        </div>
        <span class="badge badge-default attention-row-domain">${escapeHtml(meta.label || titleCase(item.type))}</span>
        ${item.at ? `<span class="attention-row-age">${escapeHtml(fmtRelative(item.at))}</span>` : `<span class="attention-row-age"></span>`}
      </div>
    `);
    if (meta.route) {
      const btn = el(`<button type="button" class="btn btn-ghost btn-sm attention-row-action">${escapeHtml(meta.actionLabel)}</button>`);
      btn.addEventListener("click", (event) => { event.stopPropagation(); navigate(meta.route(item.id)); });
      row.appendChild(btn);
      row.classList.add("clickable");
      row.addEventListener("click", () => navigate(meta.route(item.id)));
    }
    list.appendChild(row);
  });
  panel.appendChild(list);
  return panel;
}

function renderMyWorkPanel(summary, mine) {
  const panel = homePanel("My Work", "View all", () => navigate("tasks"));
  if (!mine.length) {
    panel.appendChild(el(`<p class="home-panel-empty">Nothing assigned to you right now.</p>`));
  } else {
    const grouped = {};
    mine.forEach((item) => { grouped[item.type] = (grouped[item.type] || 0) + 1; });
    const today = el(`<div></div>`);
    today.appendChild(el(`<h4 class="home-subhead">Today</h4>`));
    const todayList = el(`<div class="my-work-list"></div>`);
    Object.entries(grouped).forEach(([type, count]) => {
      const meta = ATTENTION_TYPE_META[type] || { label: titleCase(type) };
      todayList.appendChild(el(`
        <div class="my-work-row">
          ${meta.icon ? `<span class="kpi-icon-box${meta.tone ? ` kpi-icon-${meta.tone}` : ""} my-work-icon">${iconSvg(meta.icon, "kpi-icon")}</span>` : ""}
          <span class="my-work-count">${count}</span>
          <span class="my-work-label">${escapeHtml(meta.label)}</span>
        </div>
      `));
    });
    today.appendChild(todayList);
    panel.appendChild(today);
  }
  // "This Week" is company-wide, not owner-filtered — attention_items'
  // trimmed shape (no owner-scoped weekly completion data exists) means
  // an honest per-person figure isn't derivable; a company-wide real
  // count is more honest than a falsely-personalized one.
  const completed = summary.tasks_completed_this_week || 0;
  const pending = summary.open_tasks || 0;
  const bar = ProgressBar(completed, completed + pending, "This Week (Office-wide)");
  if (bar) {
    const thisWeek = el(`<div></div>`);
    thisWeek.appendChild(bar);
    thisWeek.appendChild(el(`<p class="home-panel-empty" style="padding:4px 0 0;">${completed} completed, ${pending} pending.</p>`));
    panel.appendChild(thisWeek);
  }
  return panel;
}

// Two-sentence executive-briefing shape: a real count opener, then a
// real elaboration clause list — still 100% derived from the same Home
// projection counts + the development projects fetched once in
// renderHomeView (real status text per project, never an invented
// milestone/date). No LLM call, no hardcoded paragraph.
function homeBriefingText(summary, mine, developmentProjects) {
  const count = summary.attention_count || 0;
  const opening = count > 0
    ? `${count} item${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} your attention today.`
    : "Nothing needs your attention right now — Office is clear.";

  const clauses = [];
  const followUpLeads = mine.filter((item) => item.type === "lead").length;
  if (followUpLeads) clauses.push(`${followUpLeads} lead${followUpLeads === 1 ? "" : "s"} require${followUpLeads === 1 ? "s" : ""} follow-up`);
  if (summary.reports_awaiting_approval) clauses.push(`${summary.reports_awaiting_approval} report${summary.reports_awaiting_approval === 1 ? "" : "s"} ${summary.reports_awaiting_approval === 1 ? "is" : "are"} awaiting approval`);
  if (summary.overdue_tasks) clauses.push(`${summary.overdue_tasks} task${summary.overdue_tasks === 1 ? "" : "s"} ${summary.overdue_tasks === 1 ? "is" : "are"} overdue`);
  const statusGroups = {};
  (developmentProjects || []).forEach((project) => {
    const label = project.status || (project.status_stages || [])[project.status_active_index];
    if (!label) return;
    statusGroups[label] = (statusGroups[label] || 0) + 1;
  });
  const topStatus = Object.entries(statusGroups).sort((a, b) => b[1] - a[1])[0];
  if (topStatus) {
    const [label, projectCount] = topStatus;
    clauses.push(`${projectCount} development project${projectCount === 1 ? "" : "s"} ${projectCount === 1 ? "is" : "are"} currently in ${label}`);
  }
  if (summary.content_awaiting_review) clauses.push(`${summary.content_awaiting_review} content item${summary.content_awaiting_review === 1 ? "" : "s"} awaiting review`);

  if (!clauses.length) return opening;
  const joined = clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
  return `${opening} ${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}
// Quick actions route through the real Oyi chat pipeline
// (sendOyiMessage → office_internal capability pipeline), so once the
// office_internal capability modules are merged, these answers improve
// automatically with zero UI changes needed.
const HOME_QUICK_ACTIONS = [
  { label: "Show priorities", icon: "attention", permission: "office.read", message: "What needs my attention today?" },
  { label: "Review approvals", icon: "reports", permission: "reports.review", message: "What reports are awaiting approval?" },
  { label: "Summarize commercial activity", icon: "trend", permission: "crm.read", message: "Summarize our commercial activity." },
  { label: "What changed today?", icon: "lightning", permission: "office.read", message: "What changed today?" },
];
function renderOyiBriefingPanel(summary, mine, developmentProjects, fetchedAt) {
  const panel = homePanel("Oyi Briefing", null, null, fetchedAt ? `Updated ${fmtRelative(fetchedAt.toISOString())}` : null);
  panel.appendChild(el(`<p class="oyi-briefing-text">${escapeHtml(homeBriefingText(summary, mine, developmentProjects))}</p>`));
  const actions = HOME_QUICK_ACTIONS.filter((action) => hasPermission(action.permission));
  if (actions.length) {
    const list = el(`<div class="oyi-quick-actions"></div>`);
    actions.forEach((action) => {
      const btn = el(`<button type="button" class="oyi-action-chip">${iconSvg(action.icon, "kpi-icon")}<span>${escapeHtml(action.label)}</span></button>`);
      btn.addEventListener("click", () => { openOyiPanel(); sendOyiMessage(action.message); });
      list.appendChild(btn);
    });
    panel.appendChild(list);
  }
  return panel;
}

async function renderCrmSnapshotPanel(token) {
  const panel = homePanel("CRM / Commercial", "Full CRM", () => navigate("crm"));
  try {
    const [leads, opportunities] = await Promise.all([fetchLeads(), fetchOpportunities()]);
    if (token !== state.renderToken) return panel;
    const activeLeads = leads.filter((lead) => !/closed|won|lost|converted|disqualified/i.test(String(lead.status || "")));
    const qualifiedLeads = activeLeads.filter((lead) => /qualified/i.test(String(lead.qualification_status || lead.status || "")));
    const openOpportunities = opportunities.filter((opp) => !/closed|won|lost/i.test(String(opp.status || "")));
    panel.appendChild(metricCellGrid([
      { label: "Active Leads", value: activeLeads.length, icon: iconSvg("crm", "kpi-icon"), tone: "violet" },
      { label: "Qualified", value: qualifiedLeads.length, icon: iconSvg("crm", "kpi-icon"), tone: "green" },
      { label: "Opportunities", value: openOpportunities.length, icon: iconSvg("crm", "kpi-icon"), tone: "blue" },
    ]));
    const stageGroups = {};
    openOpportunities.forEach((opp) => { const stage = opp.stage || "intake_received"; (stageGroups[stage] = stageGroups[stage] || []).push(opp); });
    if (Object.keys(stageGroups).length) {
      panel.appendChild(StageStrip(Object.entries(stageGroups).sort((a, b) => b[1].length - a[1].length).map(([stage, group]) => ({ label: titleCase(stage), count: group.length }))));
    }
    const recent = leads.filter((lead) => lead.updated_at).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 4);
    if (recent.length) {
      const moveHead = el(`<h4 class="home-subhead">Recent Movement</h4>`);
      panel.appendChild(moveHead);
      const moveList = el(`<div class="meeting-list"></div>`);
      recent.forEach((lead) => {
        const row = el(`
          <div class="meeting-row clickable">
            <div class="meeting-when">${escapeHtml(fmtRelative(lead.updated_at))}</div>
            <div class="meeting-title">${escapeHtml(lead.company || lead.name || "Untitled")} — ${escapeHtml(titleCase(lead.stage || lead.status || "new"))}</div>
          </div>
        `);
        row.addEventListener("click", () => navigate(`crm/leads/${lead.id}`));
        moveList.appendChild(row);
      });
      panel.appendChild(moveList);
    }
  } catch {
    panel.appendChild(errorPanel("Could not load CRM data."));
  }
  return panel;
}

// Projects fetched once in renderHomeView (shared with the Oyi Briefing's
// real "development projects currently in X" sentence) and passed in,
// rather than each consumer fetching independently.
function renderDevelopmentHomePanel(projects, fetchFailed) {
  const panel = homePanel("Projects / Development", "View all", () => navigate("development-projects"));
  if (fetchFailed) {
    panel.appendChild(errorPanel("Could not load development projects."));
    return panel;
  }
  {
    const visible = projects.slice(0, 4);
    if (!visible.length) {
      panel.appendChild(el(`<p class="home-panel-empty">No development projects yet.</p>`));
      return panel;
    }
    visible.forEach((project) => {
      const stages = project.status_stages || [];
      const row = el(`<div class="dev-home-row clickable"></div>`);
      if (project.cover_image_url) row.appendChild(el(`<img src="${escapeHtml(project.cover_image_url)}" alt="" class="dev-home-thumb" />`));
      const info = el(`<div class="dev-home-info"></div>`);
      info.appendChild(el(`<div class="dev-home-name">${escapeHtml(project.name)}</div>`));
      info.appendChild(el(`<div class="dev-home-status">${escapeHtml(project.status || stages[project.status_active_index] || "—")}</div>`));
      const bar = ProgressBar(project.status_active_index, stages.length - 1, null);
      if (bar) info.appendChild(bar);
      row.appendChild(info);
      row.addEventListener("click", () => navigate(`development-projects/${project.id}`));
      panel.appendChild(row);
    });
  }
  return panel;
}

function renderPortfolioPanel(summary) {
  const panel = homePanel("Portfolio", "View all", () => navigate("portfolio"));
  const cells = [];
  if (hasPermission("portfolio.read")) cells.push({ label: "Entries", value: summary.portfolio_entries ?? 0, icon: iconSvg("portfolio", "kpi-icon"), tone: "blue" });
  if (hasPermission("private.read")) cells.push({ label: "Private Queue", value: summary.private_queue ?? 0, icon: iconSvg("private", "kpi-icon"), tone: "green" });
  if (hasPermission("partnerships.read")) cells.push({ label: "Partnerships", value: summary.partnership_queue ?? 0, icon: iconSvg("partnerships", "kpi-icon"), tone: "violet" });
  if (!cells.length) {
    panel.appendChild(el(`<p class="home-panel-empty">No portfolio data available.</p>`));
    return panel;
  }
  panel.appendChild(metricCellGrid(cells));
  return panel;
}

function renderMeetingsPanel(meetings) {
  const panel = homePanel("Upcoming Meetings", "View all", () => navigate("meetings"));
  if (!meetings.length) {
    panel.appendChild(el(`<p class="home-panel-empty">No upcoming meetings.</p>`));
    return panel;
  }
  // A narrow panel (span-2/3) is too tight for a 2-column data table
  // without cramped truncation — a stacked compact list reads better
  // at this width, matching the reference's meeting-row treatment.
  const list = el(`<div class="meeting-list"></div>`);
  meetings.slice(0, 4).forEach((meeting) => {
    const row = el(`
      <div class="meeting-row clickable">
        <div class="meeting-when">${escapeHtml(fmtDateTime(meeting.scheduled_at))}</div>
        <div class="meeting-title">${escapeHtml(meeting.title || "Untitled")}</div>
      </div>
    `);
    row.addEventListener("click", () => navigate(`meetings/${meeting.id}`));
    list.appendChild(row);
  });
  panel.appendChild(list);
  return panel;
}

// Compact icon-led rows (Home final closure pass) — reuses the exact
// attention-row-v2 row language (icon box, stacked title/detail, domain
// badge, action) already established by the Needs Attention panel, so
// Reports & Approvals reads as the same dashboard system rather than an
// unrelated table block. Still only ever the real "submitted" (awaiting
// approval) reports this panel has always fetched — no new data source.
async function renderReportsHomePanel(token) {
  const panel = homePanel("Reports & Approvals", "View all", () => navigate("reports"));
  try {
    const data = await apiListReports("submitted");
    if (token !== state.renderToken) return panel;
    const reports = data.reports || [];
    if (!reports.length) {
      panel.appendChild(el(`<p class="home-panel-empty">No reports awaiting approval.</p>`));
      return panel;
    }
    const canReview = hasPermission("reports.review");
    const list = el(`<div class="attention-list-v2"></div>`);
    reports.slice(0, 5).forEach((r) => {
      const row = el(`
        <div class="attention-row-v2 clickable" style="border-left-color:var(--amber);">
          <span class="kpi-icon-box kpi-icon-amber attention-row-icon">${iconSvg("reports", "kpi-icon")}</span>
          <div class="attention-row-text">
            <div class="attention-row-title">${escapeHtml(r.title || "Untitled")}</div>
            <div class="attention-row-detail">${r.author ? `Submitted by ${escapeHtml(r.author)}` : (canReview ? "Awaiting your approval" : "Awaiting review")}</div>
          </div>
          <span class="badge badge-default attention-row-domain">${escapeHtml(titleCase(r.related_type || "report"))}</span>
        </div>
      `);
      // RBAC preserved: this is a link to the existing report detail page,
      // which itself already enforces reports.review server-side for the
      // actual approve/reject action — no approval logic or
      // self-escalation happens here.
      if (canReview) {
        const btn = el(`<button type="button" class="btn btn-ghost btn-sm attention-row-action">Review</button>`);
        btn.addEventListener("click", (event) => { event.stopPropagation(); navigate(`reports/${r.id}`); });
        row.appendChild(btn);
      } else {
        row.appendChild(el(`<span class="badge badge-amber attention-row-action">Awaiting</span>`));
      }
      row.addEventListener("click", () => navigate(`reports/${r.id}`));
      list.appendChild(row);
    });
    panel.appendChild(list);
  } catch {
    panel.appendChild(errorPanel("Could not load reports."));
  }
  return panel;
}

// related_object_type comes straight from buildOfficeHomeProjection's
// recent_activity mapping (task/support_case/lead/proposal/portfolio/
// project/meeting/opportunity/organization/contact) — reusing
// ATTENTION_TYPE_META's icon/tone/label gives Recent Activity the same
// semantic icon language as Needs Attention instead of a separate map to
// keep in sync. Falls back to a generic icon with no domain badge for
// activity not tied to a specific record type, rather than guessing.
function activityRowMeta(activity) {
  const known = ATTENTION_TYPE_META[activity.related_object_type];
  if (known) return { icon: known.icon, tone: known.tone, label: known.label };
  return { icon: "briefing", tone: null, label: null };
}
function renderRecentActivityPanel(activities) {
  const panel = homePanel("Recent Activity");
  const recent = [...activities]
    .sort((a, b) => String(b.occurred_at || b.created_at || "").localeCompare(String(a.occurred_at || a.created_at || "")))
    .slice(0, 6);
  if (!recent.length) {
    panel.appendChild(el(`<p class="home-panel-empty">No recent activity.</p>`));
    return panel;
  }
  const list = el(`<div class="attention-list-v2"></div>`);
  recent.forEach((activity) => {
    const meta = activityRowMeta(activity);
    const row = el(`
      <div class="attention-row-v2" style="border-left-color:var(--line-strong);">
        <span class="kpi-icon-box${meta.tone ? ` kpi-icon-${meta.tone}` : ""} attention-row-icon">${iconSvg(meta.icon, "kpi-icon")}</span>
        <div class="attention-row-text">
          <div class="attention-row-title">${escapeHtml(activity.title || activity.summary || "Office activity")}</div>
        </div>
        ${meta.label ? `<span class="badge badge-default attention-row-domain">${escapeHtml(meta.label)}</span>` : ""}
        <span class="attention-row-age">${escapeHtml(fmtRelative(activity.created_at))}</span>
      </div>
    `);
    list.appendChild(row);
  });
  panel.appendChild(list);
  return panel;
}

// Honest cadence widget — never fabricates progress toward the 2/week
// target; 0/2 renders as 0/2.
function renderContentPanel(content) {
  const panel = homePanel("Content & Public Presence", "View all", () => navigate("content"));
  if (content.available === false) {
    panel.appendChild(emptyPanel({
      kicker: "Content",
      title: "Content is temporarily unavailable",
      body: "Publishing counts couldn't be read just now — try again shortly.",
    }));
    return panel;
  }
  panel.appendChild(metricCellGrid([
    { label: "Published This Week", value: `${content.published_this_week} / ${content.target_per_week}`, icon: iconSvg("content", "kpi-icon"), tone: "green" },
    { label: "Drafts", value: content.drafts, icon: iconSvg("documents", "kpi-icon"), tone: "blue" },
    { label: "Awaiting Review", value: content.awaiting_review, icon: iconSvg("reports", "kpi-icon"), tone: "amber" },
    { label: "Scheduled", value: content.scheduled, icon: iconSvg("meetings", "kpi-icon"), tone: "violet" },
  ]));
  if (content.next_scheduled_publish_at) {
    panel.appendChild(el(`<p class="home-panel-empty" style="padding:4px 0 0;">Next: ${escapeHtml(fmtDateTime(content.next_scheduled_publish_at))}</p>`));
  }
  return panel;
}

async function renderAiAgentsHomePanel(token) {
  const panel = homePanel("AI Agents", "View all", () => navigate("observatory"));
  try {
    const data = await apiListTraces();
    if (token !== state.renderToken) return panel;
    const traces = data.traces || [];
    const toolExecutions = traces.filter((t) => t.type === "tool_executed");
    const failures = traces.filter((t) => t.type === "office_internal_chat_failed").length;
    const surfaceCounts = OBSERVATORY_KNOWN_SURFACES.map((surface) => ({
      label: surface.label,
      count: traces.filter((t) => surface.types.includes(t.type)).length,
    }));
    // "Active Surfaces" is a genuinely derivable count (surfaces with at
    // least one recorded trace) — not a fabricated "Operational" status.
    const activeSurfaces = surfaceCounts.filter((surface) => surface.count > 0).length;
    panel.appendChild(metricCellGrid([
      { label: "Interactions", value: traces.length, icon: iconSvg("observatory", "kpi-icon"), tone: "blue" },
      { label: "Tool Executions", value: toolExecutions.length, icon: iconSvg("lightning", "kpi-icon"), tone: "violet" },
      { label: "Failures", value: failures, icon: iconSvg("attention", "kpi-icon"), tone: failures > 0 ? "red" : "green" },
      { label: "Active Surfaces", value: `${activeSurfaces} / ${OBSERVATORY_KNOWN_SURFACES.length}`, icon: iconSvg("briefing", "kpi-icon"), tone: "blue" },
    ]));
    // Only the surfaces Office genuinely tracks — never claim Consumer/
    // Facility/GetOyi are connected (they render as "Not connected to
    // Office yet" on the full AI Agents page; Home simply doesn't list
    // what it can't honestly report on). No status pill here since
    // system health isn't genuinely known from trace counts alone.
    panel.appendChild(FactGrid(surfaceCounts.map((surface) => ({
      label: surface.label,
      value: String(surface.count),
    }))));
  } catch {
    panel.appendChild(errorPanel("Could not load agent activity."));
  }
  return panel;
}

// Ask Oyi's large Home card was removed (Phase 1) — it opened the exact
// same openOyiPanel() as the persistent Oyi bar in the shell chrome, so
// it was a duplicate entry point, not a separate function. The bar
// remains the single Oyi interaction surface.

// ---------------------------------------------------------------
// CRM
// ---------------------------------------------------------------
const CRM_TABS = [
  { key: "overview", label: "Overview" },
  { key: "leads", label: "Leads" },
  { key: "contacts", label: "Contacts" },
  { key: "organizations", label: "Organizations" },
  { key: "opportunities", label: "Opportunities" },
];

async function renderCrmRoute(outlet, rest, token) {
  const [subKey = "overview", objectId] = rest;
  setTopbar("CRM", objectId ? "" : titleCase(subKey));

  outlet.innerHTML = "";
  const tabs = el(`<div class="crm-tabs"></div>`);
  CRM_TABS.forEach((tab) => {
    const tabBtn = el(`<button type="button" class="crm-tab ${tab.key === subKey ? "active" : ""}" data-crm-tab="${tab.key}">${escapeHtml(tab.label)}</button>`);
    tabBtn.addEventListener("click", () => navigate(`crm/${tab.key}`));
    tabs.appendChild(tabBtn);
  });
  outlet.appendChild(tabs);

  const body = el(`<div class="crm-body"></div>`);
  body.appendChild(skeletonPanel(4));
  outlet.appendChild(body);

  try {
    if (objectId) {
      await renderCrmDetail(body, subKey, objectId, token);
    } else if (subKey === "overview") {
      await renderCrmOverview(body, token);
    } else if (["leads", "contacts", "organizations", "opportunities"].includes(subKey)) {
      await renderCrmList(body, subKey, token);
    } else {
      setSelectedObject(null);
      body.innerHTML = "";
      body.appendChild(errorPanel("Unknown CRM area."));
    }
  } catch (err) {
    if (token !== state.renderToken) return;
    body.innerHTML = "";
    body.appendChild(errorPanel(err.message || "Could not load this CRM view."));
  }
}

// Overview recomposed onto the Home design template (Programme 4 Part
// 9) — .home-panel cards, KPIGroup/StageStrip primitives, same density
// and icon treatment as Home. No new primitives; "Leads by Source" is
// the only new visualization, and only because it clears the bar Home
// review set: a stated operational question ("where are our leads
// coming from?") answered by a real, already-used field (lead.source —
// see leadChannelLabel() below, which already reads this same field).
async function renderCrmOverview(body, token) {
  setSelectedObject(null);
  const [leads, opportunities, contacts, organizations] = await Promise.all([
    fetchLeads().catch(() => []),
    fetchOpportunities().catch(() => []),
    fetchContacts().catch(() => []),
    fetchOrganizations().catch(() => []),
  ]);
  if (token !== state.renderToken) return;
  body.innerHTML = "";

  const hotLeads = leads.filter((lead) =>
    Number(lead.score || lead.lead_score || 0) >= 70 ||
    /follow|proposal|demo|meeting/i.test(String(lead.next_action || "")) ||
    (lead.next_action_at && new Date(lead.next_action_at).getTime() < Date.now())
  );
  const openOpportunities = opportunities.filter((opp) => !/closed|won|lost/i.test(String(opp.status || "")));

  body.appendChild(KPIGroup([
    { label: "Total Leads", value: leads.length, icon: iconSvg("crm", "kpi-icon") },
    { label: "Needing Attention", value: hotLeads.length, icon: iconSvg("attention", "kpi-icon"), alert: hotLeads.length > 0 },
    { label: "Open Opportunities", value: openOpportunities.length, icon: iconSvg("crm", "kpi-icon") },
    { label: "Contacts & Orgs", value: contacts.length + organizations.length, icon: iconSvg("team", "kpi-icon") },
  ]));

  const rowA = el(`<div class="home-grid"></div>`);
  body.appendChild(rowA);

  const attentionPanel = homePanel(`Leads Needing Attention (${hotLeads.length})`);
  attentionPanel.appendChild(renderDataTable({
    columns: [
      { label: "Lead", render: (l) => escapeHtml(l.company || l.name || "Untitled") },
      { label: "Next Action", render: nextActionCell },
      { label: "Owner", render: (l) => escapeHtml(l.owner || "Unassigned") },
    ],
    rows: hotLeads.slice(0, 8),
    onRowClick: (lead) => navigate(`crm/leads/${lead.id}`),
    emptyMessage: "No leads currently need attention.",
  }));
  rowA.appendChild(homePanelWrap("span-6", attentionPanel));

  const stageGroups = {};
  opportunities.forEach((opp) => {
    const stage = opp.stage || "intake_received";
    (stageGroups[stage] = stageGroups[stage] || []).push(opp);
  });
  const stagePanel = homePanel("Opportunities by Stage");
  stagePanel.appendChild(StageStrip(
    Object.entries(stageGroups)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([stage, items]) => ({ label: titleCase(stage), count: items.length })),
    "No opportunities recorded yet."
  ));
  rowA.appendChild(homePanelWrap("span-6", stagePanel));

  const rowB = el(`<div class="home-grid"></div>`);
  body.appendChild(rowB);

  const sourceGroups = {};
  leads.forEach((lead) => {
    const source = lead.source || "unknown";
    (sourceGroups[source] = sourceGroups[source] || []).push(lead);
  });
  const sourcePanel = homePanel("Leads by Source");
  sourcePanel.appendChild(StageStrip(
    Object.entries(sourceGroups)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([source, items]) => ({ label: titleCase(source), count: items.length })),
    "No leads recorded yet."
  ));
  rowB.appendChild(homePanelWrap("span-4", sourcePanel));

  const recentPeople = [...contacts, ...organizations.map((o) => ({ ...o, __org: true }))]
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .slice(0, 6);
  const peoplePanel = homePanel("Recently Active Contacts & Organizations");
  peoplePanel.appendChild(renderDataTable({
    columns: [
      { label: "Name", render: (r) => escapeHtml(r.name || "Untitled") },
      { label: "Type", render: (r) => badge(r.__org ? "Organization" : "Contact") },
      { label: "Business Unit", render: (r) => escapeHtml(titleCase(r.business_unit)) },
      { label: "Updated", render: (r) => escapeHtml(fmtRelative(r.updated_at)) },
    ],
    rows: recentPeople,
    onRowClick: (r) => navigate(`crm/${r.__org ? "organizations" : "contacts"}/${r.id}`),
    emptyMessage: "No contacts or organizations yet.",
  }));
  rowB.appendChild(homePanelWrap("span-4", peoplePanel));

  const buDistribution = {};
  [...leads, ...opportunities].forEach((r) => {
    const bu = r.business_unit || "corporate";
    buDistribution[bu] = (buDistribution[bu] || 0) + 1;
  });
  const buPanel = homePanel("Business Unit Distribution");
  buPanel.appendChild(StageStrip(
    Object.entries(buDistribution).map(([bu, count]) => ({ label: titleCase(bu), count })),
    "No records yet."
  ));
  rowB.appendChild(homePanelWrap("span-4", buPanel));
}

// Channel is the communication medium (whatsapp/email/website_chat);
// source is where the lead originated (referral/cold_outreach/website).
// Both exist on the record already (primary_channel/source_channel vs
// source) but only source was ever rendered — shown together here since
// they answer different questions.
function leadChannelLabel(record) {
  const channel = record.primary_channel || record.source_channel || "";
  return channel && channel !== record.source ? titleCase(channel) : "";
}
// next_action is free text; next_action_at is the actual due timestamp —
// existed in the schema/store since the original CRM build but was never
// rendered anywhere. Overdue (past, not yet actioned) shows red.
function nextActionCell(record) {
  const text = record.next_action ? escapeHtml(record.next_action) : "—";
  if (!record.next_action_at) return text;
  const overdue = new Date(record.next_action_at).getTime() < Date.now();
  return `${text} ${badge(fmtRelative(record.next_action_at), overdue ? "red" : "default")}`;
}

const CRM_LIST_CONFIG = {
  leads: {
    fetch: fetchLeads,
    manage: "crm.manage",
    searchFields: ["name", "company", "email"],
    columns: [
      { label: "Name / Organization", width: "1.6fr", render: (r) => escapeHtml(r.company || r.name || "Untitled") },
      { label: "Interest", render: (r) => escapeHtml(titleCase(r.inquiry_type || r.project_type || "—")) },
      { label: "Business Unit", render: (r) => escapeHtml(titleCase(r.business_unit)) },
      { label: "Source", render: (r) => `${escapeHtml(titleCase(r.source))}${leadChannelLabel(r) ? ` <span class="rail-sub">· ${escapeHtml(leadChannelLabel(r))}</span>` : ""}` },
      { label: "Status", render: (r) => badge(titleCase(r.status || r.stage || "new"), toneForStatus(r.status || r.stage)) },
      { label: "Owner", render: (r) => escapeHtml(r.owner || "Unassigned") },
      { label: "Next Action", render: nextActionCell },
    ],
    filters: [{ key: "business_unit", label: "Business Unit" }, { key: "status", label: "Status" }],
  },
  contacts: {
    fetch: fetchContacts,
    manage: "crm.manage",
    searchFields: ["name", "email", "phone"],
    columns: [
      { label: "Name", width: "1.4fr", render: (r) => escapeHtml(r.name || "Untitled") },
      { label: "Email", render: (r) => escapeHtml(r.email || "—") },
      { label: "Role", render: (r) => escapeHtml(r.role || "—") },
      { label: "Business Unit", render: (r) => escapeHtml(titleCase(r.business_unit)) },
      { label: "Updated", render: (r) => escapeHtml(fmtRelative(r.updated_at)) },
    ],
    filters: [{ key: "business_unit", label: "Business Unit" }],
  },
  organizations: {
    fetch: fetchOrganizations,
    manage: "crm.manage",
    searchFields: ["name", "website", "city", "country"],
    columns: [
      { label: "Name", width: "1.4fr", render: (r) => escapeHtml(r.name || "Untitled") },
      { label: "Type", render: (r) => escapeHtml(titleCase(r.account_type)) },
      { label: "Location", render: (r) => escapeHtml([r.city, r.country].filter(Boolean).join(", ") || "—") },
      { label: "Business Unit", render: (r) => escapeHtml(titleCase(r.business_unit)) },
      { label: "Updated", render: (r) => escapeHtml(fmtRelative(r.updated_at)) },
    ],
    filters: [{ key: "business_unit", label: "Business Unit" }, { key: "account_type", label: "Type" }],
  },
  opportunities: {
    fetch: fetchOpportunities,
    manage: "crm.manage",
    searchFields: ["inquiry_type", "pipeline"],
    columns: [
      { label: "Opportunity", width: "1.4fr", render: (r) => escapeHtml(titleCase(r.inquiry_type || "General Enquiry")) },
      { label: "Stage", render: (r) => badge(titleCase(r.stage), toneForStatus(r.stage)) },
      { label: "Business Unit", render: (r) => escapeHtml(titleCase(r.business_unit)) },
      { label: "Owner", render: (r) => escapeHtml(r.owner || "Unassigned") },
      { label: "Updated", render: (r) => escapeHtml(fmtRelative(r.updated_at)) },
    ],
    filters: [{ key: "business_unit", label: "Business Unit" }, { key: "stage", label: "Stage" }],
  },
};

async function renderCrmList(body, key, token) {
  setSelectedObject(null);
  const config = CRM_LIST_CONFIG[key];
  const records = await config.fetch();
  if (token !== state.renderToken) return;
  renderStandardList(body, {
    title: titleCase(key),
    records,
    columns: config.columns,
    searchFields: config.searchFields,
    filters: config.filters,
    canManage: hasPermission(config.manage),
    onCreate: () => openCreateDialog(key),
    onRowClick: (row) => navigate(`crm/${key}/${row.id}`),
    emptyMessage: "No records yet.",
  });
}

// ---------------------------------------------------------------
// Shared list primitive — a permission-aware, searchable/filterable
// table with an optional "My Records" toggle and "New" action. Used
// by CRM (above) and every Phase 3 module (Projects/Portfolio/
// Support/Tasks/Meetings) below, so every list in Office behaves
// identically.
// ---------------------------------------------------------------
function renderStandardList(body, { title, records, columns, searchFields, filters, canManage, onCreate, onRowClick, emptyMessage, secondaryAction, ownerField }) {
  const listState = { query: "", filters: {}, mineOnly: false };

  function draw() {
    let rows = records;
    if (listState.mineOnly) rows = rows.filter((r) => isMine(ownerField ? r[ownerField] : (r.owner || r.assignee)));
    Object.entries(listState.filters).forEach(([field, value]) => {
      if (value) rows = rows.filter((r) => String(r[field] || "") === value);
    });
    if (listState.query) {
      const q = listState.query.toLowerCase();
      rows = rows.filter((r) => searchFields.some((field) => String(r[field] || "").toLowerCase().includes(q)));
    }
    resultsHost.innerHTML = "";
    resultsHost.appendChild(renderDataTable({
      columns,
      rows,
      onRowClick,
      emptyMessage: records.length ? "No records match your filters." : (emptyMessage || "No records yet."),
    }));
    countLabel.textContent = `${rows.length} of ${records.length}`;
  }

  body.innerHTML = "";
  const heading = el(`<div class="view-heading"><h1>${escapeHtml(title)}</h1><span class="count-pill"></span></div>`);
  body.appendChild(heading);
  const countLabel = heading.querySelector(".count-pill");

  const filterDefs = (filters || []).map((filter) => ({
    label: filter.label,
    value: listState.filters[filter.key] || "",
    options: [...new Set(records.map((r) => r[filter.key]).filter(Boolean))].sort(),
    onChange: (value) => {
      listState.filters[filter.key] = value;
      draw();
    },
  }));

  const toolbar = renderToolbar({
    query: listState.query,
    onQuery: (value) => {
      listState.query = value;
      draw();
    },
    filters: filterDefs,
    secondaryAction: secondaryAction || {
      label: "My Records",
      onClick: (event) => {
        listState.mineOnly = !listState.mineOnly;
        event.target.classList.toggle("active", listState.mineOnly);
        draw();
      },
    },
    primaryAction: canManage && onCreate ? { label: "New", onClick: onCreate } : null,
  });
  body.appendChild(toolbar);

  const resultsHost = el(`<div class="crm-results"></div>`);
  body.appendChild(resultsHost);
  draw();
}

// ---------------------------------------------------------------
// Object detail — shared shell driving Lead / Contact / Organization
// / Opportunity. Related records (activities/tasks/meetings) are
// filtered client-side from the already-fetched collections, since
// the backend has no query-by-relation endpoints yet.
// ---------------------------------------------------------------
async function renderCrmDetail(body, type, id, token) {
  if (type === "leads") return renderLeadDetail(body, id, token);
  if (type === "contacts") return renderContactDetail(body, id, token);
  if (type === "organizations") return renderOrganizationDetail(body, id, token);
  if (type === "opportunities") return renderOpportunityDetail(body, id, token);
  body.innerHTML = "";
  body.appendChild(errorPanel("Unknown record type."));
}

function backToList(type) {
  return () => navigate(`crm/${type}`);
}

async function renderLeadDetail(body, id, token) {
  const [lead, timeline, proposals, conversations] = await Promise.all([
    apiGetLead(id),
    apiGetLeadTimeline(id).then((d) => d.timeline).catch(() => []),
    hasPermission("documents.generate") ? apiGetLeadProposals(id).then((d) => d.proposals).catch(() => []) : Promise.resolve([]),
    // Real WhatsApp (and any other channel) message thread — the
    // backend has always had this; the previous frontend never called
    // it (Phase 6, v2 audit).
    apiGetLeadConversations(id).then((d) => d.conversations || []).catch(() => []),
  ]);
  if (token !== state.renderToken) return;
  const record = lead.lead;
  if (!record) {
    body.innerHTML = "";
    body.appendChild(errorPanel("This lead could not be found."));
    return;
  }

  const [activities, tasks, projects] = await Promise.all([
    fetchActivities().catch(() => []),
    hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  const ownActivities = activities.filter((a) => a.lead_id === id);
  const ownTasks = tasks.filter((t) => t.lead_id === id);
  const linkedProject = projects.find((p) => p.lead_id === id);
  const combinedTimeline = [...timeline, ...ownActivities];
  const canManage = hasPermission("crm.manage");

  // Most recent contact across every channel this lead has — the real
  // WhatsApp thread plus the activity/note timeline — so "recent
  // communication" is answerable from this page at a glance.
  const lastCommunicationAt = [
    ...conversations.map((c) => c.created_at),
    ...combinedTimeline.map((t) => t.occurred_at || t.created_at),
  ].filter(Boolean).sort().pop();
  const channelLabel = leadChannelLabel(record);

  const mainSections = [];
  mainSections.push(el(`
    <div class="detail-section">
      <h3>Relationship Summary</h3>
      <div class="fact-grid">
        ${factRow("Email", record.email)}
        ${factRow("Phone", record.phone)}
        ${factRow("Business Unit", titleCase(record.business_unit))}
        ${factRow("Source", `${titleCase(record.source)}${channelLabel ? ` · ${channelLabel}` : ""}`)}
        ${factRow("Owner", record.owner || "Unassigned")}
        ${factRow("Last Communication", lastCommunicationAt ? fmtRelative(lastCommunicationAt) : "No recorded contact yet")}
        ${factRowHtml("Next Action", nextActionCell(record))}
        ${factRow("Summary", record.summary)}
      </div>
    </div>
  `));
  if (canManage) mainSections.push(renderLeadUpdateForm(record));
  if (conversations.length) mainSections.push(renderChannelThreadSection(conversations));
  mainSections.push(renderTimeline(combinedTimeline, {
    canAddNote: canManage,
    onAddNote: () => promptAddNote({ lead_id: id }),
  }));

  const railSections = [];
  if (hasPermission("tasks.read")) {
    railSections.push(railCard("Tasks", railList(ownTasks, (t) => {
      const overdue = t.due_at && !["done", "completed", "cancelled"].includes(String(t.status || "").toLowerCase()) && new Date(t.due_at).getTime() < Date.now();
      return `${escapeHtml(t.title)} <span class="rail-sub">${escapeHtml(titleCase(t.status))}${t.due_at ? ` · ${overdue ? badge(`Overdue ${fmtRelative(t.due_at)}`, "red") : escapeHtml(`Due ${fmtDate(t.due_at)}`)}` : ""}</span>`;
    })));
  }
  if (hasPermission("documents.generate")) {
    railSections.push(railCard("Proposals", railList(proposals, (p) => `<a href="#/documents/proposals/${p.id}">${escapeHtml(p.tier_name || "Proposal")}</a> <span class="rail-sub">${escapeHtml(titleCase(p.status))}</span>`), hasPermission("crm.manage") ? {
      label: "Create",
      onClick: () => openCreateProposalDialog(id, { context: record.summary || record.pain_points || "" }),
    } : null));
  }
  if (linkedProject) {
    railSections.push(railCard("Project", `<a href="#/projects/${linkedProject.id}">${escapeHtml(linkedProject.name)}</a> <span class="rail-sub">${escapeHtml(titleCase(linkedProject.stage))}</span>`));
  }

  renderDetailShell(body, {
    type: "lead",
    id,
    label: record.company || record.name || "Untitled lead",
    typeLine: `Lead · ${titleCase(record.business_unit)}`,
    badges: [badge(titleCase(record.status || record.stage || "new"), toneForStatus(record.status || record.stage)), badge(record.owner || "Unassigned")],
    backLabel: "Leads",
    onBack: backToList("leads"),
    mainSections,
    railSections,
    oyiContext: { lead_ref: id, safe_summary: record.summary || record.next_action || record.pain_points || "" },
  });
}

// Real channel message thread (WhatsApp today, whatever else uses the
// same `conversations` table later) — was captured by the backend the
// whole time; the frontend just never rendered it (Phase 6, v2 audit).
const CHANNEL_LABEL = { whatsapp: "WhatsApp", sms: "SMS", web: "Web chat" };
function renderChannelThreadSection(conversations) {
  const section = el(`<div class="detail-section"><h3>Messages</h3></div>`);
  const thread = el(`<div class="oyi-thread" style="max-height:340px;border:1px solid var(--line);border-radius:var(--radius);"></div>`);
  [...conversations]
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
    .forEach((turn) => {
      const fromCustomer = turn.message_role === "user";
      const channelLabel = CHANNEL_LABEL[turn.channel] || titleCase(turn.channel || "message");
      const item = el(`
        <div class="oyi-msg ${fromCustomer ? "assistant" : "user"}">
          <div>${escapeHtml(turn.content || "")}</div>
          <div style="font-size:10px;opacity:0.6;margin-top:4px;">${escapeHtml(fromCustomer ? channelLabel : turn.agent_name || "Oyi")} · ${escapeHtml(fmtRelative(turn.created_at))}</div>
        </div>
      `);
      thread.appendChild(item);
    });
  section.appendChild(thread);
  return section;
}

function factRow(label, value) {
  return `<div class="fact"><span class="fact-label">${escapeHtml(label)}</span><span class="fact-value">${escapeHtml(value || "—")}</span></div>`;
}
// For values that already contain markup (e.g. a badge) — factRow above
// escapes its value, which is correct for plain text but would double-
// escape real HTML.
function factRowHtml(label, html) {
  return `<div class="fact"><span class="fact-label">${escapeHtml(label)}</span><span class="fact-value">${html}</span></div>`;
}

function renderLeadUpdateForm(record) {
  const section = el(`<div class="detail-section"><h3>Update</h3></div>`);
  const form = el(`
    <form class="inline-form">
      <label>Status
        <input name="status" value="${escapeHtml(record.status || "")}" />
      </label>
      <label>Owner
        <input name="owner" value="${escapeHtml(record.owner || "")}" />
      </label>
      <label>Next Action
        <input name="next_action" value="${escapeHtml(record.next_action || "")}" />
      </label>
      <label>Next Action Due
        <input type="datetime-local" name="next_action_at" value="${escapeHtml(toDatetimeLocalValue(record.next_action_at))}" />
      </label>
      <button type="submit" class="btn btn-primary btn-sm">Save</button>
      <span class="form-status"></span>
    </form>
  `);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const statusLabel = form.querySelector(".form-status");
    const formData = new FormData(form);
    const nextActionAtRaw = formData.get("next_action_at");
    try {
      await apiUpdateLead(record.id, {
        status: formData.get("status"),
        owner: formData.get("owner"),
        next_action: formData.get("next_action"),
        next_action_at: nextActionAtRaw ? new Date(nextActionAtRaw).toISOString() : null,
      });
      invalidate("leads");
      statusLabel.textContent = "Saved.";
      setTimeout(() => navigate(`crm/leads/${record.id}`), 400);
    } catch (err) {
      statusLabel.textContent = err.message || "Could not save.";
    }
  });
  section.appendChild(form);
  return section;
}

async function renderContactDetail(body, id, token) {
  const [contacts, organizations, opportunities, activities, meetings, projects, privateRelationships, partnerships] = await Promise.all([
    fetchContacts(), fetchOrganizations(), fetchOpportunities(), fetchActivities(),
    hasPermission("meetings.read") ? fetchMeetings().catch(() => []) : Promise.resolve([]),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
    hasPermission("private.read") ? fetchPrivate().catch(() => []) : Promise.resolve([]),
    hasPermission("partnerships.read") ? fetchPartnerships().catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  const record = contacts.find((c) => c.id === id);
  if (!record) {
    body.innerHTML = "";
    body.appendChild(errorPanel("This contact could not be found."));
    return;
  }
  const org = organizations.find((o) => o.id === record.organization_id);
  const relatedOpportunities = opportunities.filter((o) => o.contact_id === id);
  const relatedActivities = activities.filter((a) => a.contact_id === id);
  const relatedMeetings = meetings.filter((m) => m.related_type === "contact" && m.related_id === id);
  const linkedProject = projects.find((p) => p.contact_id === id);
  const linkedPrivate = privateRelationships.find((p) => p.contact_id === id);
  const linkedPartnership = partnerships.find((p) => p.contact_id === id);
  const canManage = hasPermission("crm.manage");

  const mainSections = [
    el(`
      <div class="detail-section">
        <h3>Relationship Summary</h3>
        <div class="fact-grid">
          ${factRow("Email", record.email)}
          ${factRow("Phone", record.phone)}
          ${factRow("Role", record.role)}
          ${factRow("Organization", org ? org.name : "—")}
          ${factRow("Business Unit", titleCase(record.business_unit))}
        </div>
      </div>
    `),
    renderTimeline(relatedActivities, { canAddNote: canManage, onAddNote: () => promptAddNote({ contact_id: id }) }),
  ];

  const railSections = [
    railCard("Opportunities", railList(relatedOpportunities, (o) => `<a href="#/crm/opportunities/${o.id}">${escapeHtml(titleCase(o.inquiry_type))}</a> <span class="rail-sub">${escapeHtml(titleCase(o.stage))}</span>`)),
  ];
  if (hasPermission("meetings.read")) railSections.push(railCard("Meetings", railList(relatedMeetings, (m) => escapeHtml(m.title))));
  if (org) railSections.push(railCard("Organization", `<a href="#/crm/organizations/${org.id}">${escapeHtml(org.name)}</a>`));
  if (linkedProject) railSections.push(railCard("Project", `<a href="#/projects/${linkedProject.id}">${escapeHtml(linkedProject.name)}</a> <span class="rail-sub">${escapeHtml(titleCase(linkedProject.stage))}</span>`));
  if (linkedPrivate) {
    railSections.push(railCard("Private Relationship", `<a href="#/private/${linkedPrivate.id}">${escapeHtml(titleCase(linkedPrivate.relationship_type))}</a> <span class="rail-sub">${escapeHtml(titleCase(linkedPrivate.review_status))}</span>`));
  } else if (hasPermission("private.manage")) {
    railSections.push(railCard("Private Relationship", `<p class="rail-empty">No Private relationship yet.</p>`, {
      label: "Start",
      onClick: () => openCreatePrivateDialog({ contact_id: id, organization_id: record.organization_id, business_unit: record.business_unit }),
    }));
  }
  if (linkedPartnership) {
    railSections.push(railCard("Partnership", `<a href="#/partnerships/${linkedPartnership.id}">${escapeHtml(titleCase(linkedPartnership.relationship_type))}</a> <span class="rail-sub">${escapeHtml(titleCase(linkedPartnership.review_status))}</span>`));
  } else if (hasPermission("partnerships.manage")) {
    railSections.push(railCard("Partnership", `<p class="rail-empty">No partnership yet.</p>`, {
      label: "Start",
      onClick: () => openCreatePartnershipDialog({ contact_id: id, organization_id: record.organization_id, business_unit: record.business_unit }),
    }));
  }

  renderDetailShell(body, {
    type: "contact",
    id,
    label: record.name || "Untitled contact",
    typeLine: `Contact · ${titleCase(record.business_unit)}`,
    badges: [badge(record.role || "Contact")],
    backLabel: "Contacts",
    onBack: backToList("contacts"),
    mainSections,
    railSections,
    oyiContext: { contact_ref: id, organization_ref: record.organization_id || null, safe_summary: `${record.name || "Contact"} · ${titleCase(record.role || "")}`.trim() },
  });
}

async function renderOrganizationDetail(body, id, token) {
  const [organizations, contacts, opportunities, activities, meetings, projects, supportCases, privateRelationships, partnerships] = await Promise.all([
    fetchOrganizations(), fetchContacts(), fetchOpportunities(), fetchActivities(),
    hasPermission("meetings.read") ? fetchMeetings().catch(() => []) : Promise.resolve([]),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
    hasPermission("support.read") ? fetchSupport().catch(() => []) : Promise.resolve([]),
    hasPermission("private.read") ? fetchPrivate().catch(() => []) : Promise.resolve([]),
    hasPermission("partnerships.read") ? fetchPartnerships().catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  const record = organizations.find((o) => o.id === id);
  if (!record) {
    body.innerHTML = "";
    body.appendChild(errorPanel("This organization could not be found."));
    return;
  }
  const keyContacts = contacts.filter((c) => c.organization_id === id);
  const relatedOpportunities = opportunities.filter((o) => o.organization_id === id);
  const relatedActivities = activities.filter((a) => a.organization_id === id);
  const relatedMeetings = meetings.filter((m) => m.related_type === "organization" && m.related_id === id);
  const linkedProjects = projects.filter((p) => p.organization_id === id);
  const relatedSupport = supportCases.filter((s) => s.organization_id === id);
  const linkedPartnerships = partnerships.filter((p) => p.organization_id === id);
  const linkedPrivate = privateRelationships.filter((p) => p.organization_id === id);
  const canManage = hasPermission("crm.manage");

  const mainSections = [
    el(`
      <div class="detail-section">
        <h3>Relationship Summary</h3>
        <div class="fact-grid">
          ${factRow("Type", titleCase(record.account_type))}
          ${factRow("Website", record.website)}
          ${factRow("Location", [record.city, record.country].filter(Boolean).join(", "))}
          ${factRow("Business Unit", titleCase(record.business_unit))}
        </div>
      </div>
    `),
    renderTimeline(relatedActivities, { canAddNote: canManage, onAddNote: () => promptAddNote({ organization_id: id }) }),
  ];

  const railSections = [
    railCard("Key Contacts", railList(keyContacts, (c) => `<a href="#/crm/contacts/${c.id}">${escapeHtml(c.name)}</a>`)),
    railCard("Opportunities", railList(relatedOpportunities, (o) => `<a href="#/crm/opportunities/${o.id}">${escapeHtml(titleCase(o.inquiry_type))}</a> <span class="rail-sub">${escapeHtml(titleCase(o.stage))}</span>`)),
  ];
  if (hasPermission("meetings.read")) railSections.push(railCard("Meetings", railList(relatedMeetings, (m) => escapeHtml(m.title))));
  if (linkedProjects.length) railSections.push(railCard("Projects", railList(linkedProjects, (p) => `<a href="#/projects/${p.id}">${escapeHtml(p.name)}</a> <span class="rail-sub">${escapeHtml(titleCase(p.stage))}</span>`)));
  if (hasPermission("support.read")) railSections.push(railCard("Support Cases", railList(relatedSupport, (s) => `<a href="#/support/${s.id}">${escapeHtml(s.title)}</a> <span class="rail-sub">${escapeHtml(titleCase(s.status))}</span>`)));
  if (hasPermission("private.read")) {
    railSections.push(railCard("Private Relationships", railList(linkedPrivate, (p) => `<a href="#/private/${p.id}">${escapeHtml(titleCase(p.relationship_type))}</a> <span class="rail-sub">${escapeHtml(titleCase(p.review_status))}</span>`), hasPermission("private.manage") ? {
      label: "Start",
      onClick: () => openCreatePrivateDialog({ organization_id: id, business_unit: record.business_unit }),
    } : null));
  }
  if (hasPermission("partnerships.read")) {
    railSections.push(railCard("Partnerships", railList(linkedPartnerships, (p) => `<a href="#/partnerships/${p.id}">${escapeHtml(titleCase(p.relationship_type))}</a> <span class="rail-sub">${escapeHtml(titleCase(p.review_status))}</span>`), hasPermission("partnerships.manage") ? {
      label: "Start",
      onClick: () => openCreatePartnershipDialog({ organization_id: id, business_unit: record.business_unit }),
    } : null));
  }

  renderDetailShell(body, {
    type: "organization",
    id,
    label: record.name || "Untitled organization",
    typeLine: `Organization · ${titleCase(record.business_unit)}`,
    badges: [badge(titleCase(record.account_type))],
    backLabel: "Organizations",
    onBack: backToList("organizations"),
    mainSections,
    railSections,
    oyiContext: { organization_ref: id, safe_summary: `${record.name || "Organization"} · ${titleCase(record.account_type || "")}`.trim() },
  });
}

async function renderOpportunityDetail(body, id, token) {
  const [opportunities, contacts, organizations, leads, activities, tasks, projects, proposals] = await Promise.all([
    fetchOpportunities(), fetchContacts(), fetchOrganizations(),
    // GET /api/lead-agents/leads is gated on office.read (legacy
    // view_dashboard alias), not crm.read — matches the actual route.
    hasPermission("office.read") ? fetchLeads().catch(() => []) : Promise.resolve([]),
    fetchActivities(), hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
    hasPermission("office.read") ? fetchProposals().catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  const record = opportunities.find((o) => o.id === id);
  if (!record) {
    body.innerHTML = "";
    body.appendChild(errorPanel("This opportunity could not be found."));
    return;
  }
  const contact = contacts.find((c) => c.id === record.contact_id);
  const org = organizations.find((o) => o.id === record.organization_id);
  const originLead = leads.find((l) => l.id === record.lead_id);
  const relatedActivities = activities.filter((a) => a.opportunity_id === id);
  const relatedTasks = tasks.filter((t) => t.opportunity_id === id);
  const linkedProject = projects.find((p) => p.linked_opportunity_id === id);
  const relatedProposals = record.lead_id ? proposals.filter((p) => p.lead_id === record.lead_id) : [];
  const canManage = hasPermission("crm.manage");

  const mainSections = [
    el(`
      <div class="detail-section">
        <h3>Relationship Summary</h3>
        <div class="fact-grid">
          ${factRow("Stage", titleCase(record.stage))}
          ${factRow("Pipeline", titleCase(record.pipeline))}
          ${factRow("Business Unit", titleCase(record.business_unit))}
          ${factRow("Contact", contact ? contact.name : "—")}
          ${factRow("Organization", org ? org.name : "—")}
          ${factRow("Source", titleCase(record.source))}
        </div>
        <p class="detail-note">Value is not shown here — this backend does not own opportunity value data directly. See the Proposals rail for governed commercial figures backed by Ochiga's approved rate card.</p>
      </div>
    `),
    renderTimeline(relatedActivities, { canAddNote: canManage, onAddNote: () => promptAddNote({ opportunity_id: id }) }),
  ];

  const railSections = [];
  if (contact) railSections.push(railCard("Contact", `<a href="#/crm/contacts/${contact.id}">${escapeHtml(contact.name)}</a>`));
  if (org) railSections.push(railCard("Organization", `<a href="#/crm/organizations/${org.id}">${escapeHtml(org.name)}</a>`));
  if (originLead) railSections.push(railCard("Originating Lead", `<a href="#/crm/leads/${originLead.id}">${escapeHtml(originLead.company || originLead.name)}</a>`));
  if (hasPermission("tasks.read")) railSections.push(railCard("Tasks", railList(relatedTasks, (t) => `${escapeHtml(t.title)} <span class="rail-sub">${escapeHtml(titleCase(t.status))}</span>`)));
  if (hasPermission("documents.generate")) {
    railSections.push(railCard("Proposals", railList(relatedProposals, (p) => `<a href="#/documents/proposals/${p.id}">${escapeHtml(p.tier_name || "Proposal")}</a> <span class="rail-sub">${escapeHtml(titleCase(p.status))}</span>`), record.lead_id && hasPermission("crm.manage") ? {
      label: "Create",
      onClick: () => openCreateProposalDialog(record.lead_id, {}),
    } : null));
  }
  if (linkedProject) {
    railSections.push(railCard("Project", `<a href="#/projects/${linkedProject.id}">${escapeHtml(linkedProject.name)}</a> <span class="rail-sub">${escapeHtml(titleCase(linkedProject.stage))}</span>`));
  } else if (hasPermission("projects.manage")) {
    railSections.push(railCard("Project", `<p class="rail-empty">No project started from this opportunity yet.</p>`, {
      label: "Start Project",
      onClick: () => openCreateProjectDialog({
        linked_opportunity_id: id,
        lead_id: record.lead_id,
        organization_id: record.organization_id,
        contact_id: record.contact_id,
        business_unit: record.business_unit,
      }),
    }));
  }

  renderDetailShell(body, {
    type: "opportunity",
    id,
    label: titleCase(record.inquiry_type || "Opportunity"),
    typeLine: `Opportunity · ${titleCase(record.business_unit)}`,
    badges: [badge(titleCase(record.stage), toneForStatus(record.stage))],
    backLabel: "Opportunities",
    onBack: backToList("opportunities"),
    mainSections,
    railSections,
    oyiContext: {
      opportunity_ref: id,
      contact_ref: record.contact_id || null,
      organization_ref: record.organization_id || null,
      lead_ref: record.lead_id || null,
      safe_summary: `${titleCase(record.inquiry_type || "Opportunity")} · ${titleCase(record.stage || "")}`.trim(),
    },
  });
}

// ---------------------------------------------------------------
// Lightweight create/note dialogs — reuse the existing collection
// create contracts (POST /admin/crm/:collection). No new backend
// endpoints, no fabricated persistence.
// ---------------------------------------------------------------
function openDialog(title, fields, onSubmit) {
  const overlay = el(`<div class="dialog-overlay"></div>`);
  const card = el(`
    <form class="dialog-card">
      <h3>${escapeHtml(title)}</h3>
      <div class="dialog-fields"></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-cancel>Cancel</button>
        <button type="submit" class="btn btn-primary btn-sm">Save</button>
      </div>
      <p class="dialog-error"></p>
    </form>
  `);
  const fieldsHost = card.querySelector(".dialog-fields");
  fields.forEach((field) => {
    if (field.type === "textarea") {
      fieldsHost.appendChild(el(`<label>${escapeHtml(field.label)}<textarea name="${field.name}" rows="3">${escapeHtml(field.value || "")}</textarea></label>`));
      return;
    }
    if (field.type === "select") {
      const options = (field.options || []).map((opt) => {
        const value = typeof opt === "string" ? opt : opt.value;
        const label = typeof opt === "string" ? titleCase(opt) : opt.label;
        const selected = value === field.value ? " selected" : "";
        return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
      }).join("");
      fieldsHost.appendChild(el(`<label>${escapeHtml(field.label)}<select name="${field.name}">${options}</select></label>`));
      return;
    }
    const listId = field.suggestions ? `dl_${field.name}_${Math.random().toString(36).slice(2, 8)}` : "";
    const wrap = el(`
      <label>${escapeHtml(field.label)}
        <input name="${field.name}" type="${field.type || "text"}" value="${escapeHtml(field.value || "")}" ${listId ? `list="${listId}"` : ""} />
      </label>
    `);
    if (listId) {
      const datalist = el(`<datalist id="${listId}">${field.suggestions.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("")}</datalist>`);
      wrap.appendChild(datalist);
    }
    fieldsHost.appendChild(wrap);
  });
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
  }
  card.querySelector("[data-cancel]").addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  card.addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorLabel = card.querySelector(".dialog-error");
    const data = Object.fromEntries(new FormData(card).entries());
    try {
      await onSubmit(data);
      close();
    } catch (err) {
      errorLabel.textContent = err.message || "Could not save.";
    }
  });
  fieldsHost.querySelector("input,textarea")?.focus();
}

function openCreateDialog(collectionKey) {
  const forms = {
    contacts: { title: "New Contact", fields: [{ name: "name", label: "Name" }, { name: "email", label: "Email", type: "email" }, { name: "phone", label: "Phone" }, { name: "role", label: "Role" }] },
    organizations: { title: "New Organization", fields: [{ name: "name", label: "Name" }, { name: "website", label: "Website" }, { name: "city", label: "City" }, { name: "country", label: "Country" }] },
    opportunities: { title: "New Opportunity", fields: [{ name: "inquiry_type", label: "Inquiry Type" }, { name: "business_unit", label: "Business Unit" }, { name: "stage", label: "Stage" }] },
  };
  const form = forms[collectionKey];
  if (!form) return;
  openDialog(form.title, form.fields, async (data) => {
    await apiCreateCrm(collectionKey, data);
    invalidate(collectionKey);
    navigate(`crm/${collectionKey}`);
  });
}

function promptAddNote(refs) {
  openDialog("Add Note", [{ name: "title", label: "Title" }, { name: "body", label: "Note", type: "textarea" }], async (data) => {
    await apiCreateCrm("activities", { ...refs, activity_type: "note", title: data.title || "Note", body: data.body });
    invalidate("activities");
    renderRoute();
  });
}

// ---------------------------------------------------------------
// Phase 3 — Projects / Portfolio / Support / Tasks / Meetings.
//
// These collections now use governed sparse PATCH/status transitions
// where Office owns the business state. Notes/timelines flow through
// the generic related activities contract rather than per-module
// activity tables.
// ---------------------------------------------------------------
// office_projects.stage has no server-enforced enum (free text via
// normalizeCorporateRecord) — this is the Ochiga development lifecycle
// offered as a <datalist> suggestion, same non-rigid pattern as
// PARTNERSHIP_TYPE_SUGGESTIONS below. Staff can still type any value.
const PROJECT_STAGE_SUGGESTIONS = [
  "Prospective", "Secured", "Planning", "Pre-development",
  "Construction", "Sales / Offtake", "Completed", "Handed Over",
  "Paused", "Cancelled",
];

function openCreateProjectDialog(prefill = {}) {
  openDialog("New Project", [
    { name: "name", label: "Project Name" },
    { name: "location", label: "Location" },
    { name: "stage", label: "Stage", value: "prospective", suggestions: PROJECT_STAGE_SUGGESTIONS },
    { name: "business_unit", label: "Business Unit", value: prefill.business_unit || "" },
  ], async (data) => {
    await apiCreateOffice("projects", {
      ...data,
      linked_opportunity_id: prefill.linked_opportunity_id,
      lead_id: prefill.lead_id,
      organization_id: prefill.organization_id,
      contact_id: prefill.contact_id,
    });
    invalidate("projects");
    navigate("projects");
  });
}

function openCreatePortfolioDialog(prefill = {}) {
  openDialog("New Portfolio Entry", [
    { name: "name", label: "Building / Deployment Name" },
    { name: "client_account", label: "Client / Account", value: prefill.client_account || "" },
    { name: "location", label: "Location" },
    { name: "relationship_type", label: "Relationship Type", value: "customer_building" },
    { name: "business_unit", label: "Business Unit", value: prefill.business_unit || "" },
  ], async (data) => {
    await apiCreateOffice("portfolio", { ...data, project_id: prefill.project_id });
    invalidate("portfolio");
    navigate("portfolio");
  });
}

function openCreateSupportDialog(prefill = {}) {
  openDialog("New Support Case", [
    { name: "title", label: "Title" },
    { name: "category", label: "Category" },
    { name: "priority", label: "Priority", value: "normal" },
    { name: "severity", label: "Severity", value: "medium" },
    { name: "product_area", label: "Product Area", value: "oyi" },
    { name: "business_unit", label: "Business Unit", value: prefill.business_unit || "" },
  ], async (data) => {
    await apiCreateOffice("support", { ...data, portfolio_id: prefill.portfolio_id });
    invalidate("support");
    navigate(prefill.portfolio_id ? `portfolio/${prefill.portfolio_id}` : "support");
  });
}

function openCreateMeetingDialog(prefill = {}) {
  openDialog("Schedule Meeting", [
    { name: "title", label: "Title" },
    { name: "scheduled_at", label: "Scheduled At", type: "datetime-local" },
    { name: "notes", label: "Notes", type: "textarea" },
  ], async (data) => {
    await apiCreateOffice("meetings", {
      ...data,
      scheduled_at: data.scheduled_at ? new Date(data.scheduled_at).toISOString() : "",
      related_type: prefill.related_type,
      related_id: prefill.related_id,
    });
    invalidate("meetings");
    renderRoute();
  });
}

function openCreateTaskDialog(prefill = {}) {
  openDialog("Create Task", [
    { name: "title", label: "Title" },
    { name: "description", label: "Description", type: "textarea", value: prefill.description || "" },
    { name: "priority", label: "Priority", value: "normal" },
    { name: "due_at", label: "Due At", type: "datetime-local" },
    { name: "business_unit", label: "Business Unit", value: prefill.business_unit || "" },
  ], async (data) => {
    await apiCreateCrm("tasks", {
      ...data,
      due_at: data.due_at ? new Date(data.due_at).toISOString() : "",
      lead_id: prefill.lead_id,
      opportunity_id: prefill.opportunity_id,
      project_id: prefill.project_id,
      portfolio_id: prefill.portfolio_id,
      support_case_id: prefill.support_case_id,
      private_relationship_id: prefill.private_relationship_id,
      partnership_relationship_id: prefill.partnership_relationship_id,
    });
    invalidate("tasks");
    renderRoute();
  });
}

// office_private_relationships / office_partnership_relationships
// have no server-enforced relationship_type enum (it's free text via
// normalizeCorporateRecord) — these are suggestions via <datalist>,
// not a fabricated taxonomy. Staff can type any value.
const PRIVATE_TYPE_SUGGESTIONS = ["Membership", "Investor", "Landowner", "Advisor"];
const PARTNERSHIP_TYPE_SUGGESTIONS = ["Landowner / JV", "Capital Partner", "Buyer / Offtake", "Delivery Professional", "Technology / Oyi Integrator", "Strategic Partner"];

function openCreatePrivateDialog(prefill = {}) {
  openDialog("Start Private Relationship", [
    { name: "relationship_type", label: "Relationship Type", value: "membership", suggestions: PRIVATE_TYPE_SUGGESTIONS },
    { name: "business_unit", label: "Business Unit", value: prefill.business_unit || "private" },
    { name: "notes", label: "Notes", type: "textarea" },
  ], async (data) => {
    await apiCreateOffice("private", { ...data, contact_id: prefill.contact_id, organization_id: prefill.organization_id, opportunity_id: prefill.opportunity_id });
    invalidate("private");
    navigate("private");
  });
}

function openCreatePartnershipDialog(prefill = {}) {
  openDialog("Start Partnership", [
    { name: "relationship_type", label: "Relationship Type", value: "strategic_partner", suggestions: PARTNERSHIP_TYPE_SUGGESTIONS },
    { name: "business_unit", label: "Business Unit", value: prefill.business_unit || "partnerships" },
    { name: "notes", label: "Notes", type: "textarea" },
  ], async (data) => {
    await apiCreateOffice("partnerships", { ...data, contact_id: prefill.contact_id, organization_id: prefill.organization_id, opportunity_id: prefill.opportunity_id });
    invalidate("partnerships");
    navigate("partnerships");
  });
}

// Generic corporate documents (office_documents via
// POST /admin/documents/generate). No amount/currency/email_to field
// is exposed here on purpose: this dialog never carries a price, and
// Phase 4 must not send real email — see PHASE4_REPORT. Proposal and
// Quotation are deliberately excluded from this list; those go
// through the governed, pricing-safe proposal workflow below instead.
const DOCUMENT_TYPE_OPTIONS = [
  "company_profile", "pitch_deck", "oyi_material", "development_material",
  "private_material", "partnership_material", "loi", "contract", "letter",
  "meeting_brief", "project_document", "technical_document", "template",
];
async function openCreateDocumentDialog(prefill = {}) {
  // Template picker (Phase 7, v2 audit) — fetched live rather than
  // hardcoded, so adding a template server-side doesn't need a matching
  // frontend change. Falls back to just the existing basic/type flow if
  // the endpoint is unreachable, rather than blocking document creation.
  let templates = [{ id: "basic", label: "Basic Corporate Document" }];
  try {
    const data = await apiListDocumentTemplates();
    if (data.templates?.length) templates = data.templates;
  } catch {
    /* fall back to basic-only, non-fatal */
  }
  openDialog("New Document", [
    { name: "template_id", label: "Template", type: "select", value: "basic", options: templates.map((t) => ({ value: t.id, label: t.label })) },
    { name: "title", label: "Title", value: prefill.title || "" },
    { name: "document_type", label: "Type", type: "select", value: prefill.document_type || "letter", options: DOCUMENT_TYPE_OPTIONS },
    { name: "body", label: "Content", type: "textarea" },
  ], async (data) => {
    await apiGenerateDocument({ ...data, related_type: prefill.related_type, related_id: prefill.related_id });
    invalidate("documents");
    navigate(prefill.related_type && prefill.related_id ? `documents` : "documents");
  });
}

// Proposals/Quotations are governed and lead-scoped: the backend
// computes tier/pricing from its own approved OYI_PRICING rate card
// (src/lead-agents/commercial.js) — this dialog never accepts a
// staff-typed amount. If no lead_id is resolvable for the context
// this was opened from, proposal creation isn't offered at all (see
// callers) rather than falling back to a fabricated commercial draft.
const PROPOSAL_PACKAGE_OPTIONS = [
  { value: "", label: "Auto (let Oyi choose from scope)" },
  { value: "Oyi Core", label: "Oyi Core" },
  { value: "Oyi Operations", label: "Oyi Operations" },
  { value: "Oyi Infrastructure", label: "Oyi Infrastructure" },
  { value: "Oyi Command Center", label: "Oyi Command Center" },
];
function openCreateProposalDialog(leadId, prefill = {}) {
  openDialog("Create Proposal / Quotation", [
    { name: "package_name", label: "Package", type: "select", options: PROPOSAL_PACKAGE_OPTIONS },
    { name: "context", label: "Scope / Context (units, property type, notes)", type: "textarea", value: prefill.context || "" },
  ], async (data) => {
    await apiCreateLeadProposal(leadId, data);
    invalidate("proposals");
    invalidate("leads");
    navigate("documents/proposals");
  });
}

// ---- module route dispatch --------------------------------------
async function renderModuleRoute(outlet, moduleKey, rest, token) {
  const [objectId] = rest;
  const item = findNavItem(moduleKey);
  setTopbar(item.label, "");
  outlet.innerHTML = "";
  outlet.appendChild(skeletonPanel(4));
  try {
    if (moduleKey === "projects") {
      if (objectId) await renderProjectDetail(outlet, objectId, token);
      else await renderProjectsList(outlet, token);
    } else if (moduleKey === "portfolio") {
      if (objectId) await renderPortfolioDetail(outlet, objectId, token);
      else await renderPortfolioList(outlet, token);
    } else if (moduleKey === "support") {
      if (objectId) await renderSupportDetail(outlet, objectId, token);
      else await renderSupportList(outlet, token);
    } else if (moduleKey === "meetings") {
      if (objectId) await renderMeetingDetail(outlet, objectId, token);
      else await renderMeetingsList(outlet, token);
    } else if (moduleKey === "private") {
      if (objectId) await renderPrivateDetail(outlet, objectId, token);
      else await renderPrivateList(outlet, token);
    } else if (moduleKey === "partnerships") {
      if (objectId) await renderPartnershipDetail(outlet, objectId, token);
      else await renderPartnershipList(outlet, token);
    }
  } catch (err) {
    if (token !== state.renderToken) return;
    outlet.innerHTML = "";
    outlet.appendChild(errorPanel(err.message || "Could not load this view."));
  }
}

// ---------------------------------------------------------------
// PROJECTS — real Ochiga projects/engagements (office_projects).
// Not Development enquiries (those stay in CRM as Leads/Opportunities)
// — a Project is an engagement now being executed, optionally linked
// back to the Opportunity/Lead/Contact/Organization it grew from.
// ---------------------------------------------------------------
async function renderProjectsList(outlet, token) {
  setSelectedObject(null);
  const [projects, organizations] = await Promise.all([
    fetchProjects(),
    hasPermission("crm.read") ? fetchOrganizations().catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  const orgById = Object.fromEntries(organizations.map((o) => [o.id, o]));
  renderStandardList(outlet, {
    title: "Projects",
    records: projects,
    columns: [
      { label: "Project", width: "1.6fr", render: (p) => escapeHtml(p.name) },
      { label: "Business Unit", render: (p) => escapeHtml(titleCase(p.business_unit)) },
      { label: "Stage", render: (p) => badge(titleCase(p.stage), toneForStatus(p.stage)) },
      { label: "Organization", render: (p) => escapeHtml((orgById[p.organization_id] || {}).name || "—") },
      { label: "Owner", render: (p) => escapeHtml(p.owner || "Unassigned") },
      { label: "Updated", render: (p) => escapeHtml(fmtRelative(p.updated_at)) },
    ],
    searchFields: ["name", "location"],
    filters: [{ key: "business_unit", label: "Business Unit" }, { key: "stage", label: "Stage" }],
    canManage: hasPermission("projects.manage"),
    onCreate: () => openCreateProjectDialog(),
    onRowClick: (p) => navigate(`projects/${p.id}`),
    emptyMessage: "No active projects yet.",
  });
}

async function renderProjectDetail(outlet, id, token) {
  const canManage = hasPermission("projects.manage");
  const [projects, organizations, contacts, opportunities, leads, portfolioEntries, tasks, meetings, notes, documents] = await Promise.all([
    fetchProjects(),
    hasPermission("crm.read") ? fetchOrganizations().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchContacts().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOpportunities().catch(() => []) : Promise.resolve([]),
    hasPermission("office.read") ? fetchLeads().catch(() => []) : Promise.resolve([]),
    hasPermission("portfolio.read") ? fetchPortfolio().catch(() => []) : Promise.resolve([]),
    hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
    hasPermission("meetings.read") ? fetchMeetings().catch(() => []) : Promise.resolve([]),
    fetchRelatedActivities("project", id),
    hasPermission("documents.generate") ? fetchDocuments().catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  const record = projects.find((p) => p.id === id);
  if (!record) {
    outlet.innerHTML = "";
    outlet.appendChild(errorPanel("This project could not be found."));
    return;
  }
  const org = organizations.find((o) => o.id === record.organization_id);
  const contact = contacts.find((c) => c.id === record.contact_id);
  const opportunity = opportunities.find((o) => o.id === record.linked_opportunity_id);
  const lead = leads.find((l) => l.id === record.lead_id);
  const linkedPortfolio = portfolioEntries.find((p) => p.id === record.portfolio_id) || portfolioEntries.find((p) => p.project_id === id);
  const relatedTasks = tasks.filter((t) => t.project_id === id);
  const relatedMeetings = meetings.filter((m) => m.related_type === "project" && m.related_id === id);
  const relatedDocuments = documents.filter((d) => d.related_type === "project" && d.related_id === id);
  const timelineEvents = [
    ...notes,
    ...relatedTasks.map((t) => ({ event_type: "task", title: t.title, body: t.description, actor: t.assignee, occurred_at: t.created_at })),
    ...relatedMeetings.map((m) => ({ event_type: "meeting", title: m.title, body: m.notes, actor: m.owner, occurred_at: m.scheduled_at || m.created_at })),
  ];

  const summarySection = el(`
    <div class="detail-section">
      <h3>Project Summary</h3>
      <div class="fact-grid">
        ${factRow("Location", record.location)}
        ${factRow("Business Unit", titleCase(record.business_unit))}
        ${factRow("Status", titleCase(record.status))}
        ${factRow("Stage", titleCase(record.stage))}
        ${factRow("Oyi Deployment Status", titleCase(record.oyi_deployment_status))}
        ${factRow("Organization", org ? org.name : "—")}
        ${factRow("Contact", contact ? contact.name : "—")}
      </div>
    </div>
  `);
  if (canManage) {
    const editStageBtn = el(`<button type="button" class="btn btn-ghost btn-sm">Edit Stage</button>`);
    editStageBtn.addEventListener("click", () => {
      openDialog("Update Project Stage", [
        { name: "stage", label: "Stage", value: record.stage, suggestions: PROJECT_STAGE_SUGGESTIONS },
      ], async (data) => {
        await apiPatchOperational("office", "projects", id, { stage: data.stage });
        invalidate("projects");
        navigate(`projects/${id}`);
      });
    });
    summarySection.appendChild(editStageBtn);
  }
  const mainSections = [summarySection];
  if (canManage) {
    const actions = renderStatusActions("office", "projects", record, () => navigate(`projects/${id}`));
    if (actions) mainSections.push(el(`<div class="detail-section"><h3>Update Status</h3></div>`));
    if (actions) mainSections[mainSections.length - 1].appendChild(actions);
  }
  mainSections.push(renderTimeline(timelineEvents, {
    canAddNote: canManage,
    onAddNote: () => promptAddRelatedNote("project", id),
  }));

  const railSections = [];
  if (opportunity) railSections.push(railCard("Opportunity", `<a href="#/crm/opportunities/${opportunity.id}">${escapeHtml(titleCase(opportunity.inquiry_type))}</a>`));
  if (lead) railSections.push(railCard("Lead", `<a href="#/crm/leads/${lead.id}">${escapeHtml(lead.company || lead.name)}</a>`));
  if (org) railSections.push(railCard("Organization", `<a href="#/crm/organizations/${org.id}">${escapeHtml(org.name)}</a>`));
  if (contact) railSections.push(railCard("Contact", `<a href="#/crm/contacts/${contact.id}">${escapeHtml(contact.name)}</a>`));
  if (linkedPortfolio) {
    railSections.push(railCard("Portfolio Entry", `<a href="#/portfolio/${linkedPortfolio.id}">${escapeHtml(linkedPortfolio.name)}</a>`));
  } else if (hasPermission("portfolio.manage")) {
    railSections.push(railCard("Portfolio Entry", `<p class="rail-empty">No portfolio entry linked yet.</p>`, {
      label: "Add Entry",
      onClick: () => openCreatePortfolioDialog({ project_id: id, business_unit: record.business_unit, client_account: org ? org.name : "" }),
    }));
  }
  if (hasPermission("tasks.read")) railSections.push(railCard("Tasks", railList(relatedTasks, (t) => `${escapeHtml(t.title)} <span class="rail-sub">${escapeHtml(titleCase(t.status))}</span>`)));
  if (hasPermission("meetings.read")) {
    railSections.push(railCard("Meetings", railList(relatedMeetings, (m) => escapeHtml(m.title)), hasPermission("meetings.manage") ? {
      label: "Schedule",
      onClick: () => openCreateMeetingDialog({ related_type: "project", related_id: id }),
    } : null));
  }
  if (hasPermission("documents.generate")) {
    railSections.push(railCard("Documents", railList(relatedDocuments, (d) => `<a href="#/documents/${d.id}">${escapeHtml(d.title)}</a>`), {
      label: "Create Brief",
      onClick: () => openCreateDocumentDialog({ related_type: "project", related_id: id, document_type: "project_document", title: `${record.name} — Project Brief` }),
    }));
  }

  renderDetailShell(outlet, {
    type: "project",
    id,
    label: record.name,
    typeLine: `Project · ${titleCase(record.business_unit)}`,
    badges: [badge(titleCase(record.status), toneForStatus(record.status)), badge(titleCase(record.stage), toneForStatus(record.stage))],
    backLabel: "Projects",
    onBack: () => navigate("projects"),
    oyiContext: {
      project_ref: id,
      safe_summary: projectOyiSafeSummary(record, { org, contact }),
    },
    mainSections,
    railSections,
  });
}

// ---------------------------------------------------------------
// PORTFOLIO — Ochiga's corporate-level view of buildings/deployments
// (office_portfolio_entries). This is NOT Oyi Facility: it never
// calls estates/homes/devices/wallets endpoints and never renders
// resident-private data. Status fields (facility_os_status,
// consumer_os_status, oyi_deployment_status) are shown as plain,
// honest reference badges — no composite "health score" is computed.
// ---------------------------------------------------------------
// operational_projection is a SAFE AGGREGATE-ONLY view fetched live,
// server-to-server, from Ochiga Backend's GET /office/portfolio/projection
// (homes_total, homes_active, devices_total, devices_online,
// major_open_escalations, last_activity_at/label) — never wallet
// balances, camera feeds, or resident-level data. available:false means
// Ochiga Backend was unreachable when this list was requested; it is
// reported honestly rather than silently backed by stale local data.
function portfolioOperationalSummaryText(entry) {
  const projection = entry.operational_projection;
  if (!projection) return "—";
  if (projection.available === false) return "Oyi data unavailable";
  if (!projection.linked) return "Not linked to Oyi";
  const homes = projection.homes_total ?? "—";
  const devices = projection.devices_total ?? "—";
  const online = projection.devices_online != null ? ` (${projection.devices_online} online)` : "";
  return `${homes} homes · ${devices} devices${online}`;
}

function renderPortfolioOperationalSection(entry) {
  const projection = entry.operational_projection;
  if (!projection || !projection.linked) {
    return el(`
      <div class="detail-section">
        <h3>Oyi Operational Overview</h3>
        <p class="detail-note">${escapeHtml(projection?.note || "No Oyi deployment reference is linked yet for this Portfolio entry.")}</p>
      </div>
    `);
  }
  const section = el(`<div class="detail-section"><h3>Oyi Operational Overview</h3></div>`);
  section.appendChild(KPIGroup([
    { label: "Homes (Total)", value: projection.homes_total ?? "—" },
    { label: "Homes (Active)", value: projection.homes_active ?? "—" },
    { label: "Devices (Total)", value: projection.devices_total ?? "—" },
    { label: "Devices Online", value: projection.devices_online ?? "Not reported" },
    { label: "Open Escalations", value: projection.major_open_escalations ?? "—", alert: (projection.major_open_escalations || 0) > 0 },
  ]));
  section.appendChild(el(`
    <p class="detail-note">
      ${projection.last_activity_at ? `${escapeHtml(projection.last_activity_label || "Activity recorded")} · ${escapeHtml(fmtRelative(projection.last_activity_at))} — ` : "No recent activity recorded — "}
      aggregate counts only, fetched live from Ochiga Backend's safe Portfolio projection contract, never resident, wallet, or camera-level detail.
    </p>
  `));
  return section;
}

async function renderPortfolioList(outlet, token) {
  setSelectedObject(null);
  const portfolioEntries = await fetchPortfolio();
  if (token !== state.renderToken) return;
  outlet.innerHTML = "";

  const linked = portfolioEntries.filter((p) => p.operational_projection?.linked);
  const openEscalations = portfolioEntries.reduce((sum, p) => sum + (p.operational_projection?.major_open_escalations || 0), 0);
  const kpiGroup = KPIGroup([
    { label: "Portfolio Entries", value: portfolioEntries.length, icon: iconSvg("portfolio", "kpi-icon") },
    { label: "Linked to Oyi", value: linked.length, icon: iconSvg("portfolio", "kpi-icon") },
    { label: "Open Escalations", value: openEscalations, icon: iconSvg("attention", "kpi-icon"), alert: openEscalations > 0 },
  ]);
  kpiGroup.style.marginBottom = "var(--space-5)";
  outlet.appendChild(kpiGroup);

  const listBody = el(`<div></div>`);
  outlet.appendChild(listBody);
  renderStandardList(listBody, {
    title: "Portfolio",
    records: portfolioEntries,
    columns: [
      { label: "Building / Deployment", width: "1.6fr", render: (p) => escapeHtml(p.name) },
      { label: "Client / Account", render: (p) => escapeHtml(p.client_account || "—") },
      { label: "Relationship", render: (p) => escapeHtml(titleCase(p.relationship_type)) },
      { label: "Facility OS", render: (p) => badge(titleCase(p.facility_os_status), toneForStatus(p.facility_os_status)) },
      { label: "Consumer OS", render: (p) => badge(titleCase(p.consumer_os_status), toneForStatus(p.consumer_os_status)) },
      { label: "Homes / Devices", render: (p) => escapeHtml(portfolioOperationalSummaryText(p)) },
      { label: "Updated", render: (p) => escapeHtml(fmtRelative(p.updated_at)) },
    ],
    searchFields: ["name", "client_account", "location"],
    filters: [{ key: "business_unit", label: "Business Unit" }, { key: "relationship_type", label: "Relationship" }],
    canManage: hasPermission("portfolio.manage"),
    onCreate: () => openCreatePortfolioDialog(),
    onRowClick: (p) => navigate(`portfolio/${p.id}`),
    emptyMessage: "No portfolio entries yet.",
  });
}

async function renderPortfolioDetail(outlet, id, token) {
  const canManage = hasPermission("portfolio.manage");
  const [portfolioEntries, projects, supportCases, tasks, meetings, notes, documents] = await Promise.all([
    fetchPortfolio(),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
    hasPermission("support.read") ? fetchSupport().catch(() => []) : Promise.resolve([]),
    hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
    hasPermission("meetings.read") ? fetchMeetings().catch(() => []) : Promise.resolve([]),
    fetchRelatedActivities("portfolio", id),
    hasPermission("documents.generate") ? fetchDocuments().catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  const record = portfolioEntries.find((p) => p.id === id);
  if (!record) {
    outlet.innerHTML = "";
    outlet.appendChild(errorPanel("This portfolio entry could not be found."));
    return;
  }
  const linkedProject = projects.find((p) => p.id === record.project_id) || projects.find((p) => p.portfolio_id === id);
  const relatedSupport = supportCases.filter((s) => s.portfolio_id === id);
  const relatedTasks = tasks.filter((t) => t.portfolio_id === id);
  const relatedMeetings = meetings.filter((m) => m.related_type === "portfolio" && m.related_id === id);
  const relatedDocuments = documents.filter((d) => d.related_type === "portfolio" && d.related_id === id);
  const timelineEvents = [
    ...notes,
    ...relatedTasks.map((t) => ({ event_type: "task", title: t.title, body: t.description, actor: t.assignee, occurred_at: t.created_at })),
    ...relatedMeetings.map((m) => ({ event_type: "meeting", title: m.title, body: m.notes, actor: m.owner, occurred_at: m.scheduled_at || m.created_at })),
  ];

  const mainSections = [
    el(`
      <div class="detail-section">
        <h3>Relationship</h3>
        <div class="fact-grid">
          ${factRow("Client / Account", record.client_account)}
          ${factRow("Location", record.location)}
          ${factRow("Relationship Type", titleCase(record.relationship_type))}
          ${factRow("Business Unit", titleCase(record.business_unit))}
        </div>
      </div>
    `),
    el(`
      <div class="detail-section">
        <h3>Ochiga / Oyi Status</h3>
        <div class="fact-grid">
          ${factRow("Status", titleCase(record.status))}
          ${factRow("Oyi Deployment", titleCase(record.oyi_deployment_status))}
          ${factRow("Facility OS", titleCase(record.facility_os_status))}
          ${factRow("Consumer OS", titleCase(record.consumer_os_status))}
          ${factRow("Support Status", titleCase(record.support_status))}
        </div>
        <p class="detail-note">${record.health_summary ? escapeHtml(record.health_summary) : "No health summary recorded for this entry yet."}</p>
      </div>
    `),
    el(`
      <div class="detail-section">
        <h3>Linked Operational Environment</h3>
        ${record.facility_deep_link
          ? `<p><a href="${escapeHtml(record.facility_deep_link)}" target="_blank" rel="noopener">Open in Facility →</a></p>`
          : `<p class="detail-note">No authorized Facility deep link is set for this entry yet. Portfolio here is corporate oversight of the relationship — it is not a substitute for Facility's operational tools.</p>`}
        ${record.backend_building_id ? `<p class="detail-note">Backend building reference: ${escapeHtml(record.backend_building_id)}</p>` : ""}
      </div>
    `),
    renderPortfolioOperationalSection(record),
  ];
  if (canManage) {
    const actions = renderStatusActions("office", "portfolio", record, () => navigate(`portfolio/${id}`));
    if (actions) {
      const section = el(`<div class="detail-section"><h3>Update Status</h3></div>`);
      section.appendChild(actions);
      mainSections.push(section);
    }
  }
  mainSections.push(renderTimeline(timelineEvents, {
    canAddNote: canManage,
    onAddNote: () => promptAddRelatedNote("portfolio", id),
  }));

  const railSections = [];
  if (linkedProject) railSections.push(railCard("Project", `<a href="#/projects/${linkedProject.id}">${escapeHtml(linkedProject.name)}</a>`));
  if (hasPermission("support.read")) {
    railSections.push(railCard("Support Cases", railList(relatedSupport, (s) => `<a href="#/support/${s.id}">${escapeHtml(s.title)}</a> <span class="rail-sub">${escapeHtml(titleCase(s.status))}</span>`), hasPermission("support.assign") ? {
      label: "New Case",
      onClick: () => openCreateSupportDialog({ portfolio_id: id, business_unit: record.business_unit }),
    } : null));
  }
  if (hasPermission("tasks.read")) railSections.push(railCard("Tasks", railList(relatedTasks, (t) => `${escapeHtml(t.title)} <span class="rail-sub">${escapeHtml(titleCase(t.status))}</span>`)));
  if (hasPermission("meetings.read")) {
    railSections.push(railCard("Meetings", railList(relatedMeetings, (m) => escapeHtml(m.title)), hasPermission("meetings.manage") ? {
      label: "Schedule",
      onClick: () => openCreateMeetingDialog({ related_type: "portfolio", related_id: id }),
    } : null));
  }
  if (hasPermission("documents.generate")) {
    railSections.push(railCard("Documents", railList(relatedDocuments, (d) => `<a href="#/documents/${d.id}">${escapeHtml(d.title)}</a>`)));
  }
  if (record.backend_estate_id) railSections.push(railCard("Reference", `<p class="rail-sub">Backend estate ID: ${escapeHtml(record.backend_estate_id)}</p>`));

  renderDetailShell(outlet, {
    type: "portfolio",
    id,
    label: record.name,
    typeLine: `Portfolio · ${titleCase(record.business_unit)}`,
    badges: [
      badge(titleCase(record.relationship_type)),
      Number(record.major_escalations || 0) > 0 ? badge(`${record.major_escalations} Escalations`, "red") : badge("No Escalations", "green"),
    ],
    backLabel: "Portfolio",
    onBack: () => navigate("portfolio"),
    mainSections,
    railSections,
    oyiContext: {
      portfolio_ref: id,
      backend_building_ref: record.backend_building_id || record.backend_estate_id || null,
      safe_summary: portfolioOyiSafeSummary(record),
    },
  });
}

// Built ONLY from fields already rendered on the Portfolio detail page —
// corporate identity plus the safe aggregate operational_projection
// (never wallet/camera/resident-level Facility data) — so Oyi Core
// reasons over exactly what staff can already see, nothing more.
function portfolioOyiSafeSummary(record) {
  const projection = record.operational_projection;
  const parts = [
    `${record.name || "Portfolio entry"} · ${titleCase(record.relationship_type || "")}`.trim(),
    `Oyi deployment: ${titleCase(record.oyi_deployment_status || "unknown")}`,
    `Facility OS: ${titleCase(record.facility_os_status || "unknown")}, Consumer OS: ${titleCase(record.consumer_os_status || "unknown")}`,
  ];
  if (projection && projection.linked) {
    parts.push(`Operational: ${projection.homes_total ?? "—"} homes (${projection.homes_active ?? "—"} active), ${projection.devices_total ?? "—"} devices (${projection.devices_online ?? "—"} online), ${projection.major_open_escalations ?? "—"} major open escalations.`);
  } else if (projection && projection.available === false) {
    parts.push("Live Oyi operational data is currently unavailable.");
  } else {
    parts.push("Not yet linked to a live Oyi deployment reference.");
  }
  return parts.join(" ");
}

// Built ONLY from fields already rendered on the Project detail page,
// same discipline as portfolioOyiSafeSummary above.
function projectOyiSafeSummary(record, { org, contact } = {}) {
  const parts = [
    `${record.name || "Project"} · ${titleCase(record.business_unit || "")}`.trim(),
    `Status: ${titleCase(record.status || "unknown")}, Stage: ${titleCase(record.stage || "unknown")}`,
  ];
  if (record.location) parts.push(`Location: ${record.location}.`);
  if (record.oyi_deployment_status) parts.push(`Oyi deployment: ${titleCase(record.oyi_deployment_status)}.`);
  if (org) parts.push(`Organization: ${org.name}.`);
  if (contact) parts.push(`Contact: ${contact.name}.`);
  return parts.join(" ");
}

// ---------------------------------------------------------------
// SUPPORT — Ochiga-level support cases and escalations
// (office_support_cases). Distinct from the Facility/Consumer
// incident it may reference (backend_incident_ref is shown as plain
// text, never a fabricated deep link into Facility internals).
// ---------------------------------------------------------------
async function renderSupportList(outlet, token) {
  setSelectedObject(null);
  const [supportCases, contacts, organizations] = await Promise.all([
    fetchSupport(),
    hasPermission("crm.read") ? fetchContacts().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOrganizations().catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  const contactById = Object.fromEntries(contacts.map((c) => [c.id, c]));
  const orgById = Object.fromEntries(organizations.map((o) => [o.id, o]));
  renderStandardList(outlet, {
    title: "Support",
    records: supportCases,
    ownerField: "assigned_staff",
    columns: [
      { label: "Case", width: "1.5fr", render: (s) => escapeHtml(s.title) },
      { label: "Customer", render: (s) => escapeHtml((contactById[s.customer_contact_id] || {}).name || (orgById[s.organization_id] || {}).name || "—") },
      { label: "Category", render: (s) => escapeHtml(titleCase(s.category)) },
      { label: "Priority", render: (s) => badge(titleCase(s.priority), toneForStatus(s.priority)) },
      { label: "Severity", render: (s) => badge(titleCase(s.severity), toneForStatus(s.severity)) },
      { label: "Status", render: (s) => badge(titleCase(s.status), toneForStatus(s.status)) },
      { label: "Assignee", render: (s) => escapeHtml(s.assigned_staff || "Unassigned") },
    ],
    searchFields: ["title", "category", "product_area"],
    filters: [
      { key: "status", label: "Status" }, { key: "severity", label: "Severity" },
      { key: "category", label: "Category" }, { key: "business_unit", label: "Business Unit" },
    ],
    canManage: hasPermission("support.assign"),
    onCreate: () => openCreateSupportDialog(),
    onRowClick: (s) => navigate(`support/${s.id}`),
    emptyMessage: "No open support cases.",
  });
}

async function renderSupportDetail(outlet, id, token) {
  const canManage = hasPermission("support.assign");
  const [supportCases, contacts, organizations, portfolioEntries, tasks, meetings, notes, documents] = await Promise.all([
    fetchSupport(),
    hasPermission("crm.read") ? fetchContacts().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOrganizations().catch(() => []) : Promise.resolve([]),
    hasPermission("portfolio.read") ? fetchPortfolio().catch(() => []) : Promise.resolve([]),
    hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
    hasPermission("meetings.read") ? fetchMeetings().catch(() => []) : Promise.resolve([]),
    fetchRelatedActivities("support_case", id),
    hasPermission("documents.generate") ? fetchDocuments().catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  const record = supportCases.find((s) => s.id === id);
  if (!record) {
    outlet.innerHTML = "";
    outlet.appendChild(errorPanel("This support case could not be found."));
    return;
  }
  const contact = contacts.find((c) => c.id === record.customer_contact_id);
  const org = organizations.find((o) => o.id === record.organization_id);
  const portfolioEntry = portfolioEntries.find((p) => p.id === record.portfolio_id);
  const relatedTasks = tasks.filter((t) => t.support_case_id === id);
  const relatedMeetings = meetings.filter((m) => m.related_type === "support" && m.related_id === id);
  const relatedDocuments = documents.filter((d) => d.related_type === "support_case" && d.related_id === id);
  const timelineEvents = [
    ...notes,
    ...relatedTasks.map((t) => ({ event_type: "task", title: t.title, body: t.description, actor: t.assignee, occurred_at: t.created_at })),
    ...relatedMeetings.map((m) => ({ event_type: "meeting", title: m.title, body: m.notes, actor: m.owner, occurred_at: m.scheduled_at || m.created_at })),
  ];

  const mainSections = [
    el(`
      <div class="detail-section">
        <h3>Case Summary</h3>
        <div class="fact-grid">
          ${factRow("Product Area", titleCase(record.product_area))}
          ${factRow("Category", titleCase(record.category))}
          ${factRow("Customer", contact ? contact.name : "—")}
          ${factRow("Organization", org ? org.name : "—")}
          ${factRow("SLA Target", record.sla_target_at ? fmtDateTime(record.sla_target_at) : "—")}
          ${factRow("Business Unit", titleCase(record.business_unit))}
        </div>
        <p class="detail-note">This is an Ochiga corporate support case. ${record.backend_incident_ref
          ? `It references a Facility/Consumer operational incident (${escapeHtml(record.backend_incident_ref)}) — this page does not show Facility internals.`
          : "No linked Facility/Consumer operational incident reference is recorded."}</p>
      </div>
    `),
    el(`
      <div class="detail-section">
        <h3>Resolution Notes</h3>
        <p>${record.resolution_notes ? escapeHtml(record.resolution_notes) : "No resolution notes recorded yet."}</p>
      </div>
    `),
  ];
  if (canManage) {
    const actions = renderStatusActions("office", "support", record, () => navigate(`support/${id}`));
    if (actions) {
      const section = el(`<div class="detail-section"><h3>Update Status</h3></div>`);
      section.appendChild(actions);
      mainSections.push(section);
    }
  }
  mainSections.push(renderTimeline(timelineEvents, {
    canAddNote: canManage,
    onAddNote: () => promptAddRelatedNote("support_case", id),
  }));

  const railSections = [];
  if (contact) railSections.push(railCard("Customer", `<a href="#/crm/contacts/${contact.id}">${escapeHtml(contact.name)}</a>`));
  if (org) railSections.push(railCard("Organization", `<a href="#/crm/organizations/${org.id}">${escapeHtml(org.name)}</a>`));
  if (portfolioEntry) railSections.push(railCard("Portfolio", `<a href="#/portfolio/${portfolioEntry.id}">${escapeHtml(portfolioEntry.name)}</a>`));
  if (hasPermission("tasks.read")) railSections.push(railCard("Tasks", railList(relatedTasks, (t) => `${escapeHtml(t.title)} <span class="rail-sub">${escapeHtml(titleCase(t.status))}</span>`)));
  if (hasPermission("meetings.read")) {
    railSections.push(railCard("Meetings", railList(relatedMeetings, (m) => escapeHtml(m.title)), hasPermission("meetings.manage") ? {
      label: "Schedule",
      onClick: () => openCreateMeetingDialog({ related_type: "support", related_id: id }),
    } : null));
  }
  if (hasPermission("documents.generate")) {
    railSections.push(railCard("Documents", railList(relatedDocuments, (d) => `<a href="#/documents/${d.id}">${escapeHtml(d.title)}</a>`), {
      label: "Create Summary",
      onClick: () => openCreateDocumentDialog({ related_type: "support_case", related_id: id, document_type: "technical_document", title: `${record.title} — Service Summary` }),
    }));
  }

  renderDetailShell(outlet, {
    type: "support_case",
    id,
    label: record.title,
    typeLine: `Support · ${titleCase(record.business_unit)}`,
    badges: [
      badge(titleCase(record.status), toneForStatus(record.status)),
      badge(titleCase(record.severity), toneForStatus(record.severity)),
      badge(record.assigned_staff || "Unassigned"),
    ],
    backLabel: "Support",
    onBack: () => navigate("support"),
    mainSections,
    railSections,
    oyiContext: {
      support_case_ref: id,
      safe_summary: `${record.title || "Support case"} · ${titleCase(record.status || "")} · ${titleCase(record.severity || "")} · ${titleCase(record.category || "")}`.trim(),
    },
  });
}

// ---------------------------------------------------------------
// TASKS — a cross-company work view over crm_tasks. A task is not a
// destination in itself: clicking one navigates to whichever real
// object it belongs to (Lead/Opportunity/Project/Portfolio/Support/
// Private/Partnership).
// PATCH /admin/crm/tasks/:id now exists (Phase 4 backend hardening),
// so each row also carries restrained status actions.
// ---------------------------------------------------------------
function resolveTaskRelation(task, index) {
  if (task.lead_id && index.leadById[task.lead_id]) {
    const l = index.leadById[task.lead_id];
    return { type: "Lead", path: `crm/leads/${task.lead_id}`, name: l.company || l.name || "Lead" };
  }
  if (task.opportunity_id && index.oppById[task.opportunity_id]) {
    return { type: "Opportunity", path: `crm/opportunities/${task.opportunity_id}`, name: titleCase(index.oppById[task.opportunity_id].inquiry_type) };
  }
  if (task.project_id && index.projectById[task.project_id]) {
    return { type: "Project", path: `projects/${task.project_id}`, name: index.projectById[task.project_id].name };
  }
  if (task.portfolio_id && index.portfolioById[task.portfolio_id]) {
    return { type: "Portfolio", path: `portfolio/${task.portfolio_id}`, name: index.portfolioById[task.portfolio_id].name };
  }
  if (task.support_case_id && index.supportById[task.support_case_id]) {
    return { type: "Support", path: `support/${task.support_case_id}`, name: index.supportById[task.support_case_id].title };
  }
  if (task.private_relationship_id && index.privateById[task.private_relationship_id]) {
    const r = index.privateById[task.private_relationship_id];
    return { type: "Private", path: `private/${task.private_relationship_id}`, name: relationshipLabel(r, index.contacts, index.organizations) };
  }
  if (task.partnership_relationship_id && index.partnershipById[task.partnership_relationship_id]) {
    const r = index.partnershipById[task.partnership_relationship_id];
    return { type: "Partnership", path: `partnerships/${task.partnership_relationship_id}`, name: relationshipLabel(r, index.contacts, index.organizations) };
  }
  return null;
}

async function fetchTaskRelationIndex() {
  const [leads, opportunities, projects, portfolioEntries, supportCases, privateRelationships, partnerships, contacts, organizations] = await Promise.all([
    hasPermission("office.read") ? fetchLeads().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOpportunities().catch(() => []) : Promise.resolve([]),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
    hasPermission("portfolio.read") ? fetchPortfolio().catch(() => []) : Promise.resolve([]),
    hasPermission("support.read") ? fetchSupport().catch(() => []) : Promise.resolve([]),
    hasPermission("private.read") ? fetchPrivate().catch(() => []) : Promise.resolve([]),
    hasPermission("partnerships.read") ? fetchPartnerships().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchContacts().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOrganizations().catch(() => []) : Promise.resolve([]),
  ]);
  return {
    leadById: Object.fromEntries(leads.map((l) => [l.id, l])),
    oppById: Object.fromEntries(opportunities.map((o) => [o.id, o])),
    projectById: Object.fromEntries(projects.map((p) => [p.id, p])),
    portfolioById: Object.fromEntries(portfolioEntries.map((p) => [p.id, p])),
    supportById: Object.fromEntries(supportCases.map((s) => [s.id, s])),
    privateById: Object.fromEntries(privateRelationships.map((r) => [r.id, r])),
    partnershipById: Object.fromEntries(partnerships.map((p) => [p.id, p])),
    contacts,
    organizations,
  };
}

async function renderTasksList(outlet, token) {
  setSelectedObject(null);
  const [tasks, index] = await Promise.all([fetchTasks(), fetchTaskRelationIndex()]);
  if (token !== state.renderToken) return;

  const now = Date.now();
  const enriched = tasks.map((t) => {
    const relation = resolveTaskRelation(t, index);
    const overdue = Boolean(t.due_at) && !t.completed_at && new Date(t.due_at).getTime() < now && !["done", "completed", "cancelled"].includes(String(t.status || "").toLowerCase());
    return { ...t, __relation: relation, __related_type: relation ? relation.type : "", __overdue: overdue };
  });

  const listState = { query: "", quick: "open", businessUnit: "", relatedType: "" };

  outlet.innerHTML = "";
  const heading = el(`<div class="view-heading"><h1>Tasks</h1><span class="count-pill"></span></div>`);
  outlet.appendChild(heading);
  const countLabel = heading.querySelector(".count-pill");

  const toolbar = el(`<div class="list-toolbar"></div>`);
  const search = el(`<input type="search" class="toolbar-search" placeholder="Search tasks…" />`);
  search.addEventListener("input", () => { listState.query = search.value; draw(); });
  toolbar.appendChild(search);

  const buOptions = [...new Set(enriched.map((t) => t.business_unit).filter(Boolean))].sort();
  const buSelect = el(`<select class="toolbar-filter"><option value="">Business Unit</option>${buOptions.map((bu) => `<option value="${escapeHtml(bu)}">${escapeHtml(titleCase(bu))}</option>`).join("")}</select>`);
  buSelect.addEventListener("change", () => { listState.businessUnit = buSelect.value; draw(); });
  toolbar.appendChild(buSelect);

  const relSelect = el(`<select class="toolbar-filter"><option value="">Related Type</option>${["Lead", "Opportunity", "Project", "Portfolio", "Support", "Private", "Partnership"].map((r) => `<option value="${r}">${r}</option>`).join("")}</select>`);
  relSelect.addEventListener("change", () => { listState.relatedType = relSelect.value; draw(); });
  toolbar.appendChild(relSelect);
  toolbar.appendChild(el(`<div class="toolbar-spacer"></div>`));
  outlet.appendChild(toolbar);

  const quickBar = el(`<div class="list-toolbar quick-filters"></div>`);
  const quickButtons = {};
  [["open", "Open"], ["mine", "Mine"], ["overdue", "Overdue"], ["completed", "Completed"], ["all", "All"]].forEach(([key, label]) => {
    const btn = el(`<button type="button" class="btn btn-ghost btn-sm">${escapeHtml(label)}</button>`);
    btn.addEventListener("click", () => { listState.quick = key; syncQuickButtons(); draw(); });
    quickButtons[key] = btn;
    quickBar.appendChild(btn);
  });
  outlet.appendChild(quickBar);
  function syncQuickButtons() {
    Object.entries(quickButtons).forEach(([key, btn]) => btn.classList.toggle("active", key === listState.quick));
  }
  syncQuickButtons();

  const resultsHost = el(`<div class="crm-results"></div>`);
  outlet.appendChild(resultsHost);

  function draw() {
    let rows = enriched;
    if (listState.quick === "mine") rows = rows.filter((t) => isMine(t.assignee));
    else if (listState.quick === "open") rows = rows.filter((t) => !["done", "completed", "cancelled"].includes(String(t.status || "").toLowerCase()));
    else if (listState.quick === "overdue") rows = rows.filter((t) => t.__overdue);
    else if (listState.quick === "completed") rows = rows.filter((t) => ["done", "completed"].includes(String(t.status || "").toLowerCase()));
    if (listState.businessUnit) rows = rows.filter((t) => t.business_unit === listState.businessUnit);
    if (listState.relatedType) rows = rows.filter((t) => t.__related_type === listState.relatedType);
    if (listState.query) {
      const q = listState.query.toLowerCase();
      rows = rows.filter((t) => [t.title, t.description].some((f) => String(f || "").toLowerCase().includes(q)));
    }
    resultsHost.innerHTML = "";
    resultsHost.appendChild(renderDataTable({
      columns: [
        { label: "Task", width: "1.6fr", render: (t) => escapeHtml(t.title) },
        { label: "Status", render: (t) => badge(titleCase(t.status), toneForStatus(t.status)) },
        { label: "Priority", render: (t) => badge(titleCase(t.priority), toneForStatus(t.priority)) },
        { label: "Assignee", render: (t) => escapeHtml(t.assignee || "Unassigned") },
        { label: "Due", render: (t) => t.due_at ? (t.__overdue ? badge(fmtDate(t.due_at), "red") : escapeHtml(fmtDate(t.due_at))) : "—" },
        { label: "Related", render: (t) => t.__relation ? `${escapeHtml(t.__relation.type)}: ${escapeHtml(t.__relation.name || "—")}` : "—" },
        { label: "Business Unit", render: (t) => escapeHtml(titleCase(t.business_unit)) },
        ...(hasPermission("tasks.manage") ? [{
          label: "Actions",
          render: (t) => {
            const cell = el(`<div></div>`);
            cell.addEventListener("click", (event) => event.stopPropagation());
            const actions = renderStatusActions("crm", "tasks", t, () => navigate("tasks"));
            if (actions) cell.appendChild(actions);
            else cell.innerHTML = `<span class="rail-sub">—</span>`;
            return cell;
          },
        }] : []),
      ],
      rows,
      onRowClick: (t) => { if (t.__relation) navigate(t.__relation.path); },
      emptyMessage: enriched.length ? "No tasks match your filters." : "No tasks yet.",
    }));
    countLabel.textContent = `${rows.length} of ${enriched.length}`;
  }
  draw();
}

// Built ONLY from fields already rendered on this Task panel.
function taskOyiSafeSummary(record) {
  const parts = [
    `${record.title || "Task"} · ${titleCase(record.status || "unknown")}, Priority: ${titleCase(record.priority || "unknown")}`.trim(),
  ];
  if (record.assignee) parts.push(`Assignee: ${record.assignee}.`);
  if (record.due_at) parts.push(`Due: ${fmtDate(record.due_at)}.`);
  if (record.description) parts.push(`Description: ${record.description}`);
  return parts.join(" ");
}

async function renderTaskRedirect(outlet, id, token) {
  const [tasks, index] = await Promise.all([fetchTasks(), fetchTaskRelationIndex()]);
  if (token !== state.renderToken) return;
  const record = tasks.find((t) => t.id === id);
  if (!record) {
    outlet.innerHTML = "";
    outlet.appendChild(errorPanel("This task could not be found."));
    return;
  }
  const relation = resolveTaskRelation(record, index);
  if (relation) {
    navigate(relation.path);
    return;
  }

  // No resolvable related object — render a minimal read-only panel
  // rather than a broken redirect or a fabricated relation.
  setSelectedObject("task", id, record.title, { task_ref: id, safe_summary: taskOyiSafeSummary(record) });
  outlet.innerHTML = "";
  const back = el(`<button type="button" class="detail-back">← Tasks</button>`);
  back.addEventListener("click", () => navigate("tasks"));
  outlet.appendChild(back);
  outlet.appendChild(el(`
    <div class="detail-header">
      <div>
        <div class="detail-typeline">Task · ${escapeHtml(titleCase(record.business_unit))}</div>
        <h1>${escapeHtml(record.title)}</h1>
        <div class="detail-badges">${badge(titleCase(record.status), toneForStatus(record.status))}${badge(titleCase(record.priority), toneForStatus(record.priority))}</div>
      </div>
    </div>
  `));
  outlet.appendChild(el(`
    <div class="detail-body"><div class="detail-main">
      <div class="detail-section">
        <h3>Details</h3>
        <div class="fact-grid">
          ${factRow("Assignee", record.assignee)}
          ${factRow("Due", record.due_at ? fmtDate(record.due_at) : "—")}
          ${factRow("Description", record.description)}
        </div>
        <p class="detail-note">This task isn't linked to a Lead, Opportunity, Project, Portfolio, Support case, Private relationship or Partnership.</p>
      </div>
    </div></div>
  `));
}

async function renderTasksRoute(outlet, rest, token) {
  const [objectId] = rest;
  setTopbar("Tasks", "");
  outlet.innerHTML = "";
  outlet.appendChild(skeletonPanel(4));
  try {
    if (objectId) await renderTaskRedirect(outlet, objectId, token);
    else await renderTasksList(outlet, token);
  } catch (err) {
    if (token !== state.renderToken) return;
    outlet.innerHTML = "";
    outlet.appendChild(errorPanel(err.message || "Could not load tasks."));
  }
}

// ---------------------------------------------------------------
// MEETINGS — a lightweight corporate meeting workspace over
// office_meetings. related_type/related_id is a generic reference to
// any of Lead/Contact/Organization/Opportunity/Project/Portfolio/
// Support — resolved here for display, never fabricated if absent.
// ---------------------------------------------------------------
function resolveGenericRelation(type, id, { leads = [], contacts = [], organizations = [], opportunities = [], projects = [], portfolioEntries = [], supportCases = [], privateRelationships = [], partnerships = [] }) {
  if (!type || !id) return null;
  const t = String(type).toLowerCase();
  if (t === "lead") { const r = leads.find((x) => x.id === id); return r ? { name: r.company || r.name || "Lead", path: `crm/leads/${id}` } : null; }
  if (t === "contact") { const r = contacts.find((x) => x.id === id); return r ? { name: r.name || "Contact", path: `crm/contacts/${id}` } : null; }
  if (t === "organization") { const r = organizations.find((x) => x.id === id); return r ? { name: r.name || "Organization", path: `crm/organizations/${id}` } : null; }
  if (t === "opportunity") { const r = opportunities.find((x) => x.id === id); return r ? { name: titleCase(r.inquiry_type) || "Opportunity", path: `crm/opportunities/${id}` } : null; }
  if (t === "project") { const r = projects.find((x) => x.id === id); return r ? { name: r.name || "Project", path: `projects/${id}` } : null; }
  if (t === "portfolio") { const r = portfolioEntries.find((x) => x.id === id); return r ? { name: r.name || "Portfolio Entry", path: `portfolio/${id}` } : null; }
  if (t === "support" || t === "support_case") { const r = supportCases.find((x) => x.id === id); return r ? { name: r.title || "Support Case", path: `support/${id}` } : null; }
  if (t === "private_relationship" || t === "private") { const r = privateRelationships.find((x) => x.id === id); return r ? { name: relationshipLabel(r, contacts, organizations), path: `private/${id}` } : null; }
  if (t === "partnership_relationship" || t === "partnerships") { const r = partnerships.find((x) => x.id === id); return r ? { name: relationshipLabel(r, contacts, organizations), path: `partnerships/${id}` } : null; }
  return null;
}
// Private/Partnership records have no name of their own — they are
// always anchored to a real CRM Contact or Organization. This never
// invents a label: it falls back to the relationship_type only when
// neither identity is resolvable (e.g. missing permission to read CRM).
function relationshipLabel(record, contacts, organizations) {
  const contact = (contacts || []).find((c) => c.id === record.contact_id);
  if (contact && contact.name) return contact.name;
  const org = (organizations || []).find((o) => o.id === record.organization_id);
  if (org && org.name) return org.name;
  return titleCase(record.relationship_type) || "Relationship";
}

async function renderMeetingsList(outlet, token) {
  setSelectedObject(null);
  const meetings = await fetchMeetings();
  if (token !== state.renderToken) return;
  const now = Date.now();
  const enriched = meetings.map((m) => ({ ...m, __upcoming: Boolean(m.scheduled_at) && new Date(m.scheduled_at).getTime() >= now }));
  renderStandardList(outlet, {
    title: "Meetings",
    records: enriched,
    columns: [
      { label: "Title", width: "1.6fr", render: (m) => escapeHtml(m.title) },
      { label: "Related", render: (m) => m.related_type ? escapeHtml(titleCase(m.related_type)) : "—" },
      { label: "Scheduled", render: (m) => m.scheduled_at ? (m.__upcoming ? badge(fmtDateTime(m.scheduled_at), "amber") : escapeHtml(fmtDateTime(m.scheduled_at))) : "—" },
      { label: "Owner", render: (m) => escapeHtml(m.owner || "Unassigned") },
      { label: "Outcome", render: (m) => escapeHtml(m.outcome || "—") },
    ],
    searchFields: ["title", "notes", "outcome"],
    filters: [{ key: "business_unit", label: "Business Unit" }, { key: "related_type", label: "Related Type" }],
    canManage: hasPermission("meetings.manage"),
    onCreate: () => openCreateMeetingDialog(),
    onRowClick: (m) => navigate(`meetings/${m.id}`),
    emptyMessage: "No meetings scheduled yet.",
  });
}

async function renderMeetingDetail(outlet, id, token) {
  const canManage = hasPermission("meetings.manage");
  const [meetings, leads, contacts, organizations, opportunities, projects, portfolioEntries, supportCases, privateRelationships, partnerships, tasks, notes] = await Promise.all([
    fetchMeetings(),
    hasPermission("office.read") ? fetchLeads().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchContacts().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOrganizations().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOpportunities().catch(() => []) : Promise.resolve([]),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
    hasPermission("portfolio.read") ? fetchPortfolio().catch(() => []) : Promise.resolve([]),
    hasPermission("support.read") ? fetchSupport().catch(() => []) : Promise.resolve([]),
    hasPermission("private.read") ? fetchPrivate().catch(() => []) : Promise.resolve([]),
    hasPermission("partnerships.read") ? fetchPartnerships().catch(() => []) : Promise.resolve([]),
    hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
    fetchRelatedActivities("meeting", id),
  ]);
  if (token !== state.renderToken) return;
  const record = meetings.find((m) => m.id === id);
  if (!record) {
    outlet.innerHTML = "";
    outlet.appendChild(errorPanel("This meeting could not be found."));
    return;
  }
  const related = resolveGenericRelation(record.related_type, record.related_id, { leads, contacts, organizations, opportunities, projects, portfolioEntries, supportCases, privateRelationships, partnerships });
  const followUpTask = tasks.find((t) => t.id === record.follow_up_task_id);

  const mainSections = [
    el(`
      <div class="detail-section">
        <h3>Meeting Summary</h3>
        <div class="fact-grid">
          ${factRow("Status", titleCase(record.status))}
          ${factRow("Scheduled", record.scheduled_at ? fmtDateTime(record.scheduled_at) : "—")}
          ${factRow("Owner", record.owner)}
          ${factRow("Related", related ? related.name : "—")}
          ${factRow("Participants", Array.isArray(record.participants) && record.participants.length ? record.participants.join(", ") : "—")}
        </div>
      </div>
    `),
    el(`<div class="detail-section"><h3>Notes</h3><p>${record.notes ? escapeHtml(record.notes) : "No notes recorded yet."}</p></div>`),
    el(`<div class="detail-section"><h3>Outcome &amp; Follow-up</h3><p>${record.outcome ? escapeHtml(record.outcome) : "No outcome recorded yet."}</p></div>`),
  ];
  if (canManage) {
    const actions = renderStatusActions("office", "meetings", record, () => navigate(`meetings/${id}`));
    if (actions) {
      const section = el(`<div class="detail-section"><h3>Update Status</h3></div>`);
      section.appendChild(actions);
      mainSections.push(section);
    }
  }
  mainSections.push(renderTimeline(notes, {
    canAddNote: canManage,
    onAddNote: () => promptAddRelatedNote("meeting", id),
  }));

  const railSections = [];
  if (related) railSections.push(railCard(titleCase(record.related_type), `<a href="#/${related.path}">${escapeHtml(related.name)}</a>`));
  if (followUpTask) railSections.push(railCard("Follow-up Task", `${escapeHtml(followUpTask.title)} <span class="rail-sub">${escapeHtml(titleCase(followUpTask.status))}</span>`));

  renderDetailShell(outlet, {
    type: "meeting",
    id,
    label: record.title,
    typeLine: `Meeting · ${titleCase(record.business_unit)}`,
    badges: [badge(titleCase(record.status), toneForStatus(record.status)), badge(record.scheduled_at ? fmtDateTime(record.scheduled_at) : "Unscheduled")],
    backLabel: "Meetings",
    onBack: () => navigate("meetings"),
    oyiContext: {
      meeting_ref: id,
      safe_summary: meetingOyiSafeSummary(record, { related, followUpTask }),
    },
    mainSections,
    railSections,
  });
}

// Built ONLY from fields already rendered on the Meeting detail page.
function meetingOyiSafeSummary(record, { related, followUpTask } = {}) {
  const parts = [
    `${record.title || "Meeting"} · ${titleCase(record.status || "unknown")}`.trim(),
    record.scheduled_at ? `Scheduled: ${fmtDateTime(record.scheduled_at)}.` : "Not yet scheduled.",
  ];
  if (record.owner) parts.push(`Owner: ${record.owner}.`);
  if (related) parts.push(`Related ${titleCase(record.related_type || "record")}: ${related.name}.`);
  if (record.outcome) parts.push(`Outcome: ${record.outcome}`);
  if (followUpTask) parts.push(`Follow-up task: ${followUpTask.title} (${titleCase(followUpTask.status)}).`);
  return parts.join(" ");
}

function resolveRelationshipOrgName(record, contactById, orgById) {
  if (record.organization_id && orgById[record.organization_id]) return orgById[record.organization_id].name;
  const contact = contactById[record.contact_id];
  if (contact && contact.organization_id && orgById[contact.organization_id]) return orgById[contact.organization_id].name;
  return "";
}

// ---------------------------------------------------------------
// PRIVATE — Ochiga Private relationship/opportunity management
// (office_private_relationships). This is a relationship and
// opportunity workspace, not an investment marketplace: there is no
// balance, no fund-access and no return-guarantee data anywhere in
// this module because the backend owns none of that here. Every
// relationship is anchored to a real CRM Contact/Organization — this
// never creates a second person identity (see relationshipLabel).
// Private now uses the same governed operational PATCH path as the
// other Office-owned objects. The lifecycle represents membership /
// relationship review state only; it does not model investment funds,
// balances, returns or custody.
// ---------------------------------------------------------------
async function renderPrivateList(outlet, token) {
  setSelectedObject(null);
  const [relationships, contacts, organizations] = await Promise.all([
    fetchPrivate(),
    hasPermission("crm.read") ? fetchContacts().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOrganizations().catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  const contactById = Object.fromEntries(contacts.map((c) => [c.id, c]));
  const orgById = Object.fromEntries(organizations.map((o) => [o.id, o]));
  const enriched = relationships.map((r) => ({
    ...r,
    __name: relationshipLabel(r, contacts, organizations),
    __organization: resolveRelationshipOrgName(r, contactById, orgById),
  }));
  renderStandardList(outlet, {
    title: "Private",
    records: enriched,
    ownerField: "relationship_manager",
    columns: [
      { label: "Name", width: "1.4fr", render: (r) => escapeHtml(r.__name) },
      { label: "Organization", render: (r) => escapeHtml(r.__organization || "—") },
      { label: "Relationship", render: (r) => escapeHtml(titleCase(r.relationship_type)) },
      { label: "Status", render: (r) => badge(titleCase(r.review_status), toneForStatus(r.review_status)) },
      { label: "Owner", render: (r) => escapeHtml(r.relationship_manager || "Unassigned") },
      { label: "Updated", render: (r) => escapeHtml(fmtRelative(r.updated_at)) },
    ],
    searchFields: ["__name", "__organization", "notes"],
    filters: [{ key: "relationship_type", label: "Relationship" }, { key: "review_status", label: "Status" }, { key: "business_unit", label: "Business Unit" }],
    canManage: hasPermission("private.manage"),
    onCreate: () => openCreatePrivateDialog(),
    onRowClick: (r) => navigate(`private/${r.id}`),
    emptyMessage: "No Private relationships yet.",
  });
}

async function renderPrivateDetail(outlet, id, token) {
  const canManage = hasPermission("private.manage");
  const [relationships, contacts, organizations, opportunities, meetings, tasks, handoffs, documents, notes] = await Promise.all([
    fetchPrivate(),
    hasPermission("crm.read") ? fetchContacts().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOrganizations().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOpportunities().catch(() => []) : Promise.resolve([]),
    hasPermission("meetings.read") ? fetchMeetings().catch(() => []) : Promise.resolve([]),
    hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
    (hasPermission("office.manage") || hasPermission("support.assign")) ? fetchHandoffs().catch(() => []) : Promise.resolve([]),
    hasPermission("documents.generate") ? fetchDocuments().catch(() => []) : Promise.resolve([]),
    fetchRelatedActivities("private_relationship", id),
  ]);
  if (token !== state.renderToken) return;
  const record = relationships.find((r) => r.id === id);
  if (!record) {
    outlet.innerHTML = "";
    outlet.appendChild(errorPanel("This Private relationship could not be found."));
    return;
  }
  const contact = contacts.find((c) => c.id === record.contact_id);
  const org = organizations.find((o) => o.id === record.organization_id);
  const opportunity = opportunities.find((o) => o.id === record.opportunity_id);
  const relatedMeetings = meetings.filter((m) => m.related_type === "private_relationship" && m.related_id === id);
  const relatedTasks = tasks.filter((t) => t.private_relationship_id === id);
  const relatedDocuments = documents.filter((d) => d.related_type === "private_relationship" && d.related_id === id);
  const handoff = handoffs.find((h) => h.crm_contact_ref && h.crm_contact_ref === record.contact_id);
  const label = relationshipLabel(record, contacts, organizations);
  const statusActions = canManage
    ? renderStatusActions("office", "private", record, () => navigate(`private/${id}`), { statusField: "review_status" })
    : null;

  const mainSections = [
    el(`
      <div class="detail-section">
        <h3>Relationship Summary</h3>
        <div class="fact-grid">
          ${factRow("Relationship Type", titleCase(record.relationship_type))}
          ${factRow("Status", titleCase(record.review_status))}
          ${factRow("Business Unit", titleCase(record.business_unit))}
          ${factRow("Relationship Manager", record.relationship_manager)}
        </div>
        <p class="detail-note">${record.notes ? escapeHtml(record.notes) : "No notes recorded yet."}</p>
      </div>
    `),
    ...(statusActions ? [statusActions] : []),
    renderTimeline(notes, { canAddNote: canManage, onAddNote: () => promptAddRelatedNote("private_relationship", id) }),
  ];

  const railSections = [];
  if (contact) railSections.push(railCard("Contact", `<a href="#/crm/contacts/${contact.id}">${escapeHtml(contact.name)}</a>`));
  if (org) railSections.push(railCard("Organization", `<a href="#/crm/organizations/${org.id}">${escapeHtml(org.name)}</a>`));
  if (opportunity) railSections.push(railCard("Opportunity", `<a href="#/crm/opportunities/${opportunity.id}">${escapeHtml(titleCase(opportunity.inquiry_type))}</a>`));
  if (hasPermission("meetings.read")) {
    railSections.push(railCard("Meetings", railList(relatedMeetings, (m) => escapeHtml(m.title)), hasPermission("meetings.manage") ? {
      label: "Schedule",
      onClick: () => openCreateMeetingDialog({ related_type: "private_relationship", related_id: id }),
    } : null));
  }
  if (hasPermission("tasks.read")) {
    railSections.push(railCard("Tasks", railList(relatedTasks, (t) => `<a href="#/tasks/${t.id}">${escapeHtml(t.title)}</a> <span class="rail-sub">${escapeHtml(titleCase(t.status))}</span>`), hasPermission("tasks.manage") ? {
      label: "Create Task",
      onClick: () => openCreateTaskDialog({ private_relationship_id: id, business_unit: record.business_unit }),
    } : null));
  }
  if (hasPermission("documents.generate")) {
    railSections.push(railCard("Documents", railList(relatedDocuments, (d) => `<a href="#/documents/library/${d.id}">${escapeHtml(d.title)}</a>`), {
      label: "Create Letter",
      onClick: () => openCreateDocumentDialog({ related_type: "private_relationship", related_id: id, document_type: "letter", title: `Follow-up — ${label}` }),
    }));
  }
  if (handoff) railSections.push(railCard("Communications", `<p class="rail-sub">${escapeHtml(titleCase(handoff.status))} · ${escapeHtml(titleCase(handoff.media_mode))}</p>`));

  renderDetailShell(outlet, {
    type: "private_relationship",
    id,
    label,
    typeLine: `Private · ${titleCase(record.business_unit)}`,
    badges: [badge(titleCase(record.relationship_type)), badge(titleCase(record.review_status), toneForStatus(record.review_status))],
    backLabel: "Private",
    onBack: () => navigate("private"),
    mainSections,
    railSections,
  });
}

// ---------------------------------------------------------------
// PARTNERSHIPS — established/active corporate relationships
// (office_partnership_relationships). Enquiries still begin in CRM.
// Oyi Integrators are not a separate system — they are Partnership
// records whose relationship_type happens to be a technology/
// integrator value; no separate Integrator CRM was built.
// Relationship type remains free text with suggestions, while
// review_status uses a governed operational lifecycle.
// ---------------------------------------------------------------
async function renderPartnershipList(outlet, token) {
  setSelectedObject(null);
  const [partnerships, contacts, organizations, opportunities, projects] = await Promise.all([
    fetchPartnerships(),
    hasPermission("crm.read") ? fetchContacts().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOrganizations().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOpportunities().catch(() => []) : Promise.resolve([]),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  const contactById = Object.fromEntries(contacts.map((c) => [c.id, c]));
  const orgById = Object.fromEntries(organizations.map((o) => [o.id, o]));
  const enriched = partnerships.map((p) => ({
    ...p,
    __name: relationshipLabel(p, contacts, organizations),
    __organization: resolveRelationshipOrgName(p, contactById, orgById),
    __opportunity: opportunities.find((o) => o.id === p.opportunity_id) || null,
    __project: projects.find((pr) => pr.organization_id === p.organization_id) || null,
  }));
  renderStandardList(outlet, {
    title: "Partnerships",
    records: enriched,
    ownerField: "relationship_manager",
    columns: [
      { label: "Partner / Organization", width: "1.4fr", render: (p) => escapeHtml(p.__name) },
      { label: "Type", render: (p) => escapeHtml(titleCase(p.relationship_type)) },
      { label: "Business Unit", render: (p) => escapeHtml(titleCase(p.business_unit)) },
      { label: "Status", render: (p) => badge(titleCase(p.review_status), toneForStatus(p.review_status)) },
      { label: "Owner", render: (p) => escapeHtml(p.relationship_manager || "Unassigned") },
      { label: "Related", render: (p) => p.__opportunity ? escapeHtml(titleCase(p.__opportunity.inquiry_type)) : (p.__project ? escapeHtml(p.__project.name) : "—") },
      { label: "Updated", render: (p) => escapeHtml(fmtRelative(p.updated_at)) },
    ],
    searchFields: ["__name", "__organization", "notes"],
    filters: [{ key: "relationship_type", label: "Type" }, { key: "review_status", label: "Status" }, { key: "business_unit", label: "Business Unit" }],
    canManage: hasPermission("partnerships.manage"),
    onCreate: () => openCreatePartnershipDialog(),
    onRowClick: (p) => navigate(`partnerships/${p.id}`),
    emptyMessage: "No active partnerships yet.",
  });
}

async function renderPartnershipDetail(outlet, id, token) {
  const canManage = hasPermission("partnerships.manage");
  const [partnerships, contacts, organizations, opportunities, projects, meetings, tasks, handoffs, documents, notes] = await Promise.all([
    fetchPartnerships(),
    hasPermission("crm.read") ? fetchContacts().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOrganizations().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOpportunities().catch(() => []) : Promise.resolve([]),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
    hasPermission("meetings.read") ? fetchMeetings().catch(() => []) : Promise.resolve([]),
    hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
    (hasPermission("office.manage") || hasPermission("support.assign")) ? fetchHandoffs().catch(() => []) : Promise.resolve([]),
    hasPermission("documents.generate") ? fetchDocuments().catch(() => []) : Promise.resolve([]),
    fetchRelatedActivities("partnership_relationship", id),
  ]);
  if (token !== state.renderToken) return;
  const record = partnerships.find((p) => p.id === id);
  if (!record) {
    outlet.innerHTML = "";
    outlet.appendChild(errorPanel("This partnership could not be found."));
    return;
  }
  const contact = contacts.find((c) => c.id === record.contact_id);
  const org = organizations.find((o) => o.id === record.organization_id);
  const opportunity = opportunities.find((o) => o.id === record.opportunity_id);
  const linkedProjects = projects.filter((p) => p.organization_id === record.organization_id);
  const relatedMeetings = meetings.filter((m) => m.related_type === "partnership_relationship" && m.related_id === id);
  const relatedTasks = tasks.filter((t) => t.partnership_relationship_id === id);
  const relatedDocuments = documents.filter((d) => d.related_type === "partnership_relationship" && d.related_id === id);
  const handoff = handoffs.find((h) => h.crm_contact_ref && h.crm_contact_ref === record.contact_id);
  const label = relationshipLabel(record, contacts, organizations);
  const statusActions = canManage
    ? renderStatusActions("office", "partnerships", record, () => navigate(`partnerships/${id}`), { statusField: "review_status" })
    : null;

  const mainSections = [
    el(`
      <div class="detail-section">
        <h3>Relationship Summary</h3>
        <div class="fact-grid">
          ${factRow("Relationship Type", titleCase(record.relationship_type))}
          ${factRow("Status", titleCase(record.review_status))}
          ${factRow("Business Unit", titleCase(record.business_unit))}
          ${factRow("Relationship Manager", record.relationship_manager)}
        </div>
        <p class="detail-note">${record.notes ? escapeHtml(record.notes) : "No notes recorded yet."}</p>
      </div>
    `),
    ...(statusActions ? [statusActions] : []),
    renderTimeline(notes, { canAddNote: canManage, onAddNote: () => promptAddRelatedNote("partnership_relationship", id) }),
  ];

  const railSections = [];
  if (contact) railSections.push(railCard("Contact", `<a href="#/crm/contacts/${contact.id}">${escapeHtml(contact.name)}</a>`));
  if (org) railSections.push(railCard("Organization", `<a href="#/crm/organizations/${org.id}">${escapeHtml(org.name)}</a>`));
  if (opportunity) railSections.push(railCard("Opportunity", `<a href="#/crm/opportunities/${opportunity.id}">${escapeHtml(titleCase(opportunity.inquiry_type))}</a>`));
  if (linkedProjects.length) railSections.push(railCard("Projects", railList(linkedProjects, (p) => `<a href="#/projects/${p.id}">${escapeHtml(p.name)}</a> <span class="rail-sub">${escapeHtml(titleCase(p.stage))}</span>`)));
  if (hasPermission("meetings.read")) {
    railSections.push(railCard("Meetings", railList(relatedMeetings, (m) => escapeHtml(m.title)), hasPermission("meetings.manage") ? {
      label: "Schedule",
      onClick: () => openCreateMeetingDialog({ related_type: "partnership_relationship", related_id: id }),
    } : null));
  }
  if (hasPermission("tasks.read")) {
    railSections.push(railCard("Tasks", railList(relatedTasks, (t) => `<a href="#/tasks/${t.id}">${escapeHtml(t.title)}</a> <span class="rail-sub">${escapeHtml(titleCase(t.status))}</span>`), hasPermission("tasks.manage") ? {
      label: "Create Task",
      onClick: () => openCreateTaskDialog({ partnership_relationship_id: id, business_unit: record.business_unit }),
    } : null));
  }
  if (hasPermission("documents.generate")) {
    railSections.push(railCard("Documents", railList(relatedDocuments, (d) => `<a href="#/documents/library/${d.id}">${escapeHtml(d.title)}</a>`), {
      label: "Create Note",
      onClick: () => openCreateDocumentDialog({ related_type: "partnership_relationship", related_id: id, document_type: "partnership_material", title: `${label} — Partnership Note` }),
    }));
  }
  if (handoff) railSections.push(railCard("Communications", `<p class="rail-sub">${escapeHtml(titleCase(handoff.status))} · ${escapeHtml(titleCase(handoff.media_mode))}</p>`));

  renderDetailShell(outlet, {
    type: "partnership_relationship",
    id,
    label,
    typeLine: `Partnership · ${titleCase(record.business_unit)}`,
    badges: [badge(titleCase(record.relationship_type)), badge(titleCase(record.review_status), toneForStatus(record.review_status))],
    backLabel: "Partnerships",
    onBack: () => navigate("partnerships"),
    oyiContext: {
      partnership_ref: id,
      safe_summary: partnershipOyiSafeSummary(record, { label, org, opportunity, handoff }),
    },
    mainSections,
    railSections,
  });
}

// Built ONLY from fields already rendered on the Partnership detail page.
function partnershipOyiSafeSummary(record, { label, org, opportunity, handoff } = {}) {
  const parts = [
    `${label || "Partnership"} · ${titleCase(record.relationship_type || "")}`.trim(),
    `Status: ${titleCase(record.review_status || "unknown")}, Business Unit: ${titleCase(record.business_unit || "unknown")}`,
  ];
  if (record.relationship_manager) parts.push(`Relationship Manager: ${record.relationship_manager}.`);
  if (org) parts.push(`Organization: ${org.name}.`);
  if (opportunity) parts.push(`Linked Opportunity: ${titleCase(opportunity.inquiry_type)}.`);
  if (handoff) parts.push(`Last communication: ${titleCase(handoff.status)} via ${titleCase(handoff.media_mode)}.`);
  return parts.join(" ");
}

// ---------------------------------------------------------------
// DOCUMENTS + PROPOSALS/QUOTATIONS.
//
// Two distinct, real backend systems share this nav item as tabs:
//  - "Documents" (office_documents via POST /admin/documents/generate)
//    — generic corporate documents. No amount/currency/email_to is
//    ever sent from this UI: this dialog only ever creates a
//    non-commercial reference document. No PATCH exists for this
//    collection — status is shown read-only.
//  - "Proposals / Quotations" (the pre-existing lead-scoped proposal
//    system) — the ONLY commercial-document path in this app, because
//    it is the only one backed by real, backend-owned pricing
//    (OYI_PRICING in src/lead-agents/commercial.js). There is no
//    separate Quotation entity on the backend; both framings use the
//    same proposal record, so this tab is deliberately titled
//    "Proposals / Quotations" rather than fabricating a second table.
// ---------------------------------------------------------------
const DOCUMENTS_TABS = [
  { key: "library", label: "Documents" },
  { key: "proposals", label: "Proposals / Quotations" },
];

// ---------------------------------------------------------------
// Content / Publishing (Phase 8) — draft -> review -> approve ->
// publish/schedule, writing to Sanity's real "post" schema. Sanity
// stays the canonical public content store; Office only tracks the
// workflow here.
// ---------------------------------------------------------------
const CONTENT_STATUS_TONE = { draft: "default", in_review: "amber", approved: "amber", scheduled: "amber", published: "green", unpublished: "red" };

async function renderContentRoute(outlet, rest, token) {
  const contentId = rest[0];
  if (contentId) await renderContentEditor(outlet, contentId, token);
  else await renderContentList(outlet, token);
}

async function renderContentList(outlet, token) {
  setTopbar("Content", "");
  setSelectedObject(null);
  let items;
  try {
    const data = await apiListContent();
    items = data.items || [];
  } catch (err) {
    if (token !== state.renderToken) return;
    outlet.innerHTML = "";
    outlet.appendChild(el(`<div class="view-heading"><h1>Content</h1></div>`));
    outlet.appendChild(errorPanel(err.message || "Could not load content."));
    return;
  }
  if (token !== state.renderToken) return;

  outlet.innerHTML = "";
  outlet.appendChild(el(`
    <div class="view-heading">
      <h1>Content</h1>
      <p>Draft, review, and publish Ochiga Insights articles.</p>
    </div>
  `));

  const publishedThisWeek = items.filter((i) => i.workflow_status === "published" && i.updated_at && new Date(i.updated_at) >= startOfWeek()).length;
  outlet.appendChild(el(`
    <div class="kpi-grid" style="margin-bottom:18px;">
      <div class="kpi-card"><span class="kpi-label">Published This Week</span><span class="kpi-value">${publishedThisWeek} / 2</span></div>
      <div class="kpi-card"><span class="kpi-label">Drafts</span><span class="kpi-value">${items.filter((i) => i.workflow_status === "draft").length}</span></div>
      <div class="kpi-card"><span class="kpi-label">Awaiting Review</span><span class="kpi-value">${items.filter((i) => i.workflow_status === "in_review").length}</span></div>
      <div class="kpi-card"><span class="kpi-label">Scheduled</span><span class="kpi-value">${items.filter((i) => i.workflow_status === "scheduled").length}</span></div>
    </div>
  `));

  const newBtn = el(`<button type="button" class="btn btn-primary btn-sm" style="margin-bottom:14px;">New Article</button>`);
  newBtn.addEventListener("click", () => openNewContentDialog());
  outlet.appendChild(newBtn);

  outlet.appendChild(renderDataTable({
    columns: [
      { label: "Title", render: (i) => escapeHtml(i.title) },
      { label: "Status", render: (i) => badge(titleCase(i.workflow_status), CONTENT_STATUS_TONE[i.workflow_status] || "default") },
      { label: "Author", render: (i) => escapeHtml(i.author || "—") },
      { label: "Updated", render: (i) => escapeHtml(fmtRelative(i.updated_at)) },
    ],
    rows: items,
    onRowClick: (i) => navigate(`content/${i.id}`),
    emptyMessage: "No articles yet. Start with New Article.",
  }));
}

function startOfWeek() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(now.getFullYear(), now.getMonth(), diff);
}

// ---------------------------------------------------------------
// Reports + Approvals (Ecosystem Standardization Programme 9).
// Comments/history reuse the existing crm_activities timeline (see
// promptAddRelatedNote/renderTimeline below) — no second audit engine.
// ---------------------------------------------------------------
const REPORT_STATUS_TONE = { submitted: "amber", approved: "green", rejected: "red" };
// Matches RELATED_TYPES keys in office-operational-workflows.js
// (validateRelatedObject's vocabulary), not routeForRelated's — those
// two route-key vocabularies already disagree elsewhere in this
// codebase; kept local here rather than trying to reconcile both.
const REPORT_RELATED_ROUTES = {
  lead: (id) => `crm/leads/${id}`,
  contact: (id) => `crm/contacts/${id}`,
  organization: (id) => `crm/organizations/${id}`,
  opportunity: (id) => `crm/opportunities/${id}`,
  project: (id) => `projects/${id}`,
  portfolio: (id) => `portfolio/${id}`,
  support_case: (id) => `support/${id}`,
  private_relationship: (id) => `private/${id}`,
  partnership_relationship: (id) => `partnerships/${id}`,
  meeting: (id) => `meetings/${id}`,
  document: (id) => `documents/library/${id}`,
};
const REPORT_RELATED_TYPE_OPTIONS = [
  { value: "", label: "General Office activity (no specific object)" },
  { value: "project", label: "Project" },
  { value: "portfolio", label: "Portfolio" },
  { value: "support_case", label: "Support Case" },
  { value: "meeting", label: "Meeting" },
  { value: "private_relationship", label: "Private Relationship" },
  { value: "partnership_relationship", label: "Partnership" },
  { value: "lead", label: "CRM Lead" },
  { value: "document", label: "Document" },
];

async function renderReportsRoute(outlet, rest, token) {
  const reportId = rest[0];
  if (reportId) await renderReportDetail(outlet, reportId, token);
  else await renderReportsList(outlet, token);
}

async function renderReportsList(outlet, token) {
  setTopbar("Reports", "");
  setSelectedObject(null);
  let reports;
  try {
    const data = await apiListReports();
    reports = data.reports || [];
  } catch (err) {
    if (token !== state.renderToken) return;
    outlet.innerHTML = "";
    outlet.appendChild(el(`<div class="view-heading"><h1>Reports</h1></div>`));
    outlet.appendChild(errorPanel(err.message || "Could not load reports."));
    return;
  }
  if (token !== state.renderToken) return;

  outlet.innerHTML = "";
  outlet.appendChild(el(`
    <div class="view-heading">
      <h1>Reports</h1>
      <p>Staff reports tied to Office work, submitted for review and decision.</p>
    </div>
  `));

  const awaitingCount = reports.filter((r) => r.status === "submitted").length;
  const kpiGroup = KPIGroup([
    { label: "Awaiting Decision", value: awaitingCount, icon: iconSvg("attention", "kpi-icon"), alert: awaitingCount > 0 },
    { label: "Approved", value: reports.filter((r) => r.status === "approved").length, icon: iconSvg("reports", "kpi-icon") },
    { label: "Rejected", value: reports.filter((r) => r.status === "rejected").length, icon: iconSvg("reports", "kpi-icon") },
  ]);
  kpiGroup.style.marginBottom = "var(--space-5)";
  outlet.appendChild(kpiGroup);

  const newBtn = el(`<button type="button" class="btn btn-primary btn-sm" style="margin-bottom:14px;">Submit Report</button>`);
  newBtn.addEventListener("click", () => openNewReportDialog());
  outlet.appendChild(newBtn);

  outlet.appendChild(renderDataTable({
    columns: [
      { label: "Title", render: (r) => escapeHtml(r.title) },
      { label: "Status", render: (r) => badge(titleCase(r.status), REPORT_STATUS_TONE[r.status] || "default") },
      { label: "Author", render: (r) => escapeHtml(r.author || "—") },
      { label: "Related", render: (r) => r.related_type ? escapeHtml(titleCase(r.related_type)) : "General" },
      { label: "Updated", render: (r) => escapeHtml(fmtRelative(r.updated_at)) },
    ],
    rows: reports,
    onRowClick: (r) => navigate(`reports/${r.id}`),
    emptyMessage: "No reports yet. Start with Submit Report.",
  }));
}

function openNewReportDialog() {
  openDialog("Submit Report", [
    { name: "title", label: "Title" },
    { name: "related_type", label: "Related To", type: "select", value: "", options: REPORT_RELATED_TYPE_OPTIONS },
    { name: "related_id", label: "Related Record ID (if applicable)" },
    { name: "body", label: "Report", type: "textarea" },
  ], async (data) => {
    if (!data.title) throw new Error("Title is required.");
    await apiCreateReport({
      title: data.title,
      body: data.body,
      related_type: data.related_type || undefined,
      related_id: data.related_type ? data.related_id : undefined,
    });
    invalidate("reports");
    navigate("reports");
  });
}

async function renderReportDetail(outlet, id, token) {
  const [report, notes] = await Promise.all([
    apiGetReport(id).then((d) => d.report).catch(() => null),
    fetchRelatedActivities("report", id).catch(() => []),
  ]);
  if (token !== state.renderToken) return;
  if (!report) {
    outlet.innerHTML = "";
    outlet.appendChild(errorPanel("This report could not be found."));
    return;
  }
  // No dedicated report_context slot exists on Ochiga-backend's contract
  // yet (that's a separate cross-repo change) — page_context
  // (selected_type/selected_id, set by renderDetailShell below) is the
  // honest signal for now, same as most object types before Phase 9's
  // richer per-type slots were added.
  outlet.innerHTML = "";
  const back = el(`<button type="button" class="detail-back">← Reports</button>`);
  back.addEventListener("click", () => navigate("reports"));
  outlet.appendChild(back);

  outlet.appendChild(el(`
    <div class="detail-header">
      <div>
        <div class="detail-typeline">Report</div>
        <h1>${escapeHtml(report.title)}</h1>
        <div class="detail-badges">${badge(titleCase(report.status), REPORT_STATUS_TONE[report.status] || "default")}</div>
      </div>
    </div>
  `));

  const relatedRoute = report.related_type && REPORT_RELATED_ROUTES[report.related_type] && report.related_id
    ? REPORT_RELATED_ROUTES[report.related_type](report.related_id)
    : null;

  const summarySection = el(`
    <div class="detail-section">
      <h3>Report</h3>
      <div class="fact-grid">
        ${factRow("Author", report.author)}
        ${factRow("Related", report.related_type ? titleCase(report.related_type) : "General Office activity")}
        ${factRow("Submitted", fmtDateTime(report.created_at))}
        ${report.decided_at ? factRow("Decided", `${fmtDateTime(report.decided_at)} by ${report.reviewer || "—"}`) : ""}
      </div>
      ${relatedRoute ? `<p><a href="#/${relatedRoute}">View related record →</a></p>` : ""}
      <p style="white-space:pre-wrap;">${escapeHtml(report.body || "")}</p>
      ${report.decision_note ? `<div class="detail-note" style="margin-top:10px;"><strong>Decision note:</strong> ${escapeHtml(report.decision_note)}</div>` : ""}
    </div>
  `);

  const mainSections = [summarySection];
  if (report.status === "submitted" && hasPermission("reports.review")) {
    const actions = el(`<div class="status-actions"></div>`);
    const approveBtn = el(`<button type="button" class="btn btn-primary btn-sm">Approve</button>`);
    approveBtn.addEventListener("click", () => openDialog("Approve Report", [{ name: "decision_note", label: "Note (optional)", type: "textarea" }], async (data) => {
      await apiReportDecision(id, "approve", data);
      navigate(`reports/${id}`);
    }));
    const rejectBtn = el(`<button type="button" class="btn btn-ghost btn-sm">Reject</button>`);
    rejectBtn.addEventListener("click", () => openDialog("Reject Report", [{ name: "decision_note", label: "Reason", type: "textarea" }], async (data) => {
      await apiReportDecision(id, "reject", data);
      navigate(`reports/${id}`);
    }));
    actions.appendChild(approveBtn);
    actions.appendChild(rejectBtn);
    mainSections.push(el(`<div class="detail-section"><h3>Decision</h3></div>`));
    mainSections[mainSections.length - 1].appendChild(actions);
  }
  mainSections.push(renderTimeline(notes, {
    canAddNote: hasPermission("reports.write"),
    onAddNote: () => promptAddRelatedNote("report", id),
  }));

  renderDetailShell(outlet, {
    type: "report",
    id,
    label: report.title,
    typeLine: "Report",
    badges: [badge(titleCase(report.status), REPORT_STATUS_TONE[report.status] || "default")],
    backLabel: "Reports",
    onBack: () => navigate("reports"),
    mainSections,
    railSections: [],
  });
}

// ---------------------------------------------------------------
// Development Management (Ecosystem Standardization Programme 11).
// Manages only status/progress/core-metadata — the hand-authored
// multi-chapter tour narrative on the public website stays in code,
// unmanaged. "Sync to Website" pushes the current saved state to
// Sanity; edits here are NOT live on the public site until synced.
// ---------------------------------------------------------------
async function renderDevelopmentProjectsRoute(outlet, rest, token) {
  const projectId = rest[0];
  if (projectId) await renderDevelopmentProjectDetail(outlet, projectId, token);
  else await renderDevelopmentProjectsList(outlet, token);
}

async function renderDevelopmentProjectsList(outlet, token) {
  setTopbar("Development", "");
  setSelectedObject(null);
  let projects;
  try {
    const data = await apiListDevelopmentProjects();
    projects = data.projects || [];
  } catch (err) {
    if (token !== state.renderToken) return;
    outlet.innerHTML = "";
    outlet.appendChild(el(`<div class="view-heading"><h1>Development</h1></div>`));
    outlet.appendChild(errorPanel(err.message || "Could not load development projects."));
    return;
  }
  if (token !== state.renderToken) return;

  outlet.innerHTML = "";
  outlet.appendChild(el(`
    <div class="view-heading">
      <h1>Development</h1>
      <p>Status and milestone progress for public Development-section projects. The project narrative itself is managed on the website.</p>
    </div>
  `));

  const publishedCount = projects.filter((p) => p.published).length;
  const kpiGroup = KPIGroup([
    { label: "Total Projects", value: projects.length, icon: iconSvg("development-projects", "kpi-icon") },
    { label: "Synced to Website", value: publishedCount, icon: iconSvg("development-projects", "kpi-icon") },
    { label: "Not Synced", value: projects.length - publishedCount, icon: iconSvg("development-projects", "kpi-icon") },
  ]);
  kpiGroup.style.marginBottom = "var(--space-5)";
  outlet.appendChild(kpiGroup);

  const newBtn = el(`<button type="button" class="btn btn-primary btn-sm" style="margin-bottom:14px;">New Project</button>`);
  newBtn.addEventListener("click", () => openNewDevelopmentProjectDialog());
  outlet.appendChild(newBtn);

  outlet.appendChild(renderDataTable({
    columns: [
      { label: "Name", render: (p) => escapeHtml(p.name) },
      { label: "Slug", render: (p) => escapeHtml(p.slug) },
      { label: "Status", render: (p) => escapeHtml(p.status || "—") },
      { label: "Milestone", render: (p) => (p.status_stages || [])[p.status_active_index] ? escapeHtml(p.status_stages[p.status_active_index]) : "—" },
      { label: "Progress", render: (p) => ProgressBar(p.status_active_index, (p.status_stages || []).length - 1, null) || "—" },
      { label: "Live", render: (p) => badge(p.published ? "Synced" : "Not Synced", p.published ? "green" : "default") },
    ],
    rows: projects,
    onRowClick: (p) => navigate(`development-projects/${p.id}`),
    emptyMessage: "No development projects yet. Start with New Project.",
  }));
}

function openNewDevelopmentProjectDialog() {
  openDialog("New Development Project", [
    { name: "name", label: "Name" },
    { name: "slug", label: "Slug (must match the website route, e.g. \"havana\")" },
  ], async (data) => {
    if (!data.name || !data.slug) throw new Error("Name and slug are required.");
    const { project } = await apiCreateDevelopmentProject(data);
    navigate(`development-projects/${project.id}`);
  });
}

async function renderDevelopmentProjectDetail(outlet, id, token) {
  let project;
  try {
    const data = await apiGetDevelopmentProject(id);
    project = data.project;
  } catch (err) {
    if (token !== state.renderToken) return;
    outlet.innerHTML = "";
    outlet.appendChild(errorPanel(err.message || "This project could not be found."));
    return;
  }
  if (token !== state.renderToken) return;

  setSelectedObject("development_project", id, project.name);
  outlet.innerHTML = "";
  const back = el(`<button type="button" class="detail-back">← Development</button>`);
  back.addEventListener("click", () => navigate("development-projects"));
  outlet.appendChild(back);

  outlet.appendChild(el(`
    <div class="detail-header">
      <div>
        <div class="detail-typeline">Development Project</div>
        <h1>${escapeHtml(project.name)}</h1>
        <div class="detail-badges">${badge(project.published ? "Synced to Website" : "Not Synced", project.published ? "green" : "default")}</div>
      </div>
    </div>
  `));

  const stages = project.status_stages || [];
  const currentMilestone = stages[project.status_active_index];
  const progressBar = ProgressBar(project.status_active_index, stages.length - 1, currentMilestone ? `Milestone: ${currentMilestone}` : "Milestone progress");
  if (progressBar) {
    const progressSection = el(`<div class="detail-section" style="max-width:520px;"></div>`);
    progressSection.appendChild(progressBar);
    outlet.appendChild(progressSection);
  }

  const form = el(`
    <form class="inline-form" style="flex-direction:column;align-items:stretch;gap:12px;max-width:520px;">
      <label>Name<input name="name" value="${escapeHtml(project.name)}" /></label>
      <label>Slug<input name="slug" value="${escapeHtml(project.slug)}" /></label>
      <label>Type / Classification<input name="type_line" value="${escapeHtml(project.type_line || "")}" placeholder="e.g. Premium Vertical Living" /></label>
      <label>Location<input name="location" value="${escapeHtml(project.location || "")}" /></label>
      <label>Status Label<input name="status" value="${escapeHtml(project.status || "")}" placeholder="e.g. In Design Development" /></label>
      <label>Positioning Statement<textarea name="one_liner" rows="2">${escapeHtml(project.one_liner || "")}</textarea></label>
      <label>Milestone Stages (comma separated, in order)<input name="status_stages" value="${escapeHtml(stages.join(", "))}" placeholder="Concept, Design Development, Project Preview, Delivery" /></label>
      <label>Active Milestone Index<input name="status_active_index" type="number" min="0" value="${escapeHtml(String(project.status_active_index ?? 0))}" /></label>
      <label>Display Order<input name="display_order" type="number" value="${escapeHtml(String(project.display_order ?? 0))}" />
        <span class="hint">Lower numbers appear first on the public Development listing page.</span>
      </label>
      <label>Cover Image
        <div class="cover-image-field" style="display:flex;align-items:center;gap:10px;">
          <img class="cover-image-thumb" src="${escapeHtml(project.cover_image_url || "")}" style="width:64px;height:64px;object-fit:cover;border-radius:var(--radius-sm);border:1px solid var(--line);display:${project.cover_image_url ? "block" : "none"};" alt="" />
          <input type="file" accept="image/*" class="cover-image-input" />
          <span class="cover-image-status" style="font-size:11px;color:var(--text-tertiary);"></span>
        </div>
        <input type="hidden" name="cover_image_url" value="${escapeHtml(project.cover_image_url || "")}" />
      </label>
      <label>Cover Image Alt Text<input name="cover_image_alt" value="${escapeHtml(project.cover_image_alt || "")}" /></label>
      <div>
        <button type="submit" class="btn btn-primary btn-sm">Save</button>
        <span class="form-status" id="devProjectSaveStatus"></span>
      </div>
    </form>
  `);

  const coverInput = form.querySelector(".cover-image-input");
  const coverThumb = form.querySelector(".cover-image-thumb");
  const coverStatus = form.querySelector(".cover-image-status");
  const coverUrlField = form.querySelector('input[name="cover_image_url"]');
  coverInput.addEventListener("change", async () => {
    const file = coverInput.files && coverInput.files[0];
    if (!file) return;
    coverStatus.textContent = "Uploading…";
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const result = await apiUploadDevelopmentImage(dataUrl, file.name, file.type);
      coverUrlField.value = result.file.url;
      coverThumb.src = result.file.url;
      coverThumb.style.display = "block";
      coverStatus.textContent = "Uploaded — click Save to keep it.";
    } catch (err) {
      coverStatus.textContent = err.message || "Could not upload image.";
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const statusEl = form.querySelector("#devProjectSaveStatus");
    const formData = Object.fromEntries(new FormData(form).entries());
    try {
      await apiUpdateDevelopmentProject(id, {
        ...formData,
        status_stages: formData.status_stages.split(",").map((s) => s.trim()).filter(Boolean),
        status_active_index: Number(formData.status_active_index) || 0,
        display_order: Number(formData.display_order) || 0,
      });
      statusEl.textContent = "Saved. Not live until synced.";
    } catch (err) {
      statusEl.textContent = err.message || "Could not save.";
    }
  });
  outlet.appendChild(form);

  const syncSection = el(`<div class="detail-section" style="margin-top:16px;"><h3>Publish</h3></div>`);
  const syncBtn = el(`<button type="button" class="btn btn-ghost btn-sm">Sync to Website</button>`);
  const unpublishBtn = el(`<button type="button" class="btn btn-ghost btn-sm" style="margin-left:8px;">Unpublish</button>`);
  const syncStatus = el(`<span class="form-status"></span>`);
  syncBtn.addEventListener("click", async () => {
    syncStatus.textContent = "Syncing…";
    try {
      const result = await apiSyncDevelopmentProject(id);
      syncStatus.textContent = result.sanity?.ok ? "Synced — live on the website." : `Not synced: ${result.sanity?.reason || "unknown reason"}.`;
      if (result.sanity?.ok) {
        const badgeEl = outlet.querySelector(".detail-badges");
        if (badgeEl) badgeEl.innerHTML = badge("Synced to Website", "green");
      }
    } catch (err) {
      syncStatus.textContent = err.message || "Sync failed.";
    }
  });
  unpublishBtn.addEventListener("click", async () => {
    if (!confirm(`Unpublish ${project.name}? The public page will revert to its last hardcoded fallback content — the page itself stays live, only the Office-managed status/progress overrides are removed.`)) return;
    syncStatus.textContent = "Unpublishing…";
    try {
      const result = await apiUnpublishDevelopmentProject(id);
      syncStatus.textContent = result.sanity?.ok ? "Unpublished — website now shows its fallback content." : `Not unpublished: ${result.sanity?.reason || "unknown reason"}.`;
      if (result.sanity?.ok) {
        const badgeEl = outlet.querySelector(".detail-badges");
        if (badgeEl) badgeEl.innerHTML = badge("Not Synced", "default");
      }
    } catch (err) {
      syncStatus.textContent = err.message || "Unpublish failed.";
    }
  });
  syncSection.appendChild(syncBtn);
  syncSection.appendChild(unpublishBtn);
  syncSection.appendChild(syncStatus);
  outlet.appendChild(syncSection);
}

function openNewContentDialog() {
  openDialog("New Article", [
    { name: "title", label: "Title" },
    { name: "category", label: "Category (e.g. Oyi, Building Technology)" },
    { name: "author", label: "Author name" },
  ], async (data) => {
    if (!data.title) throw new Error("Title is required.");
    const { item } = await apiCreateContent(data);
    navigate(`content/${item.id}`);
  });
}

// Built ONLY from article metadata already rendered on this editor page —
// never the full body text, so Oyi Core sees what's on screen, not a draft
// staff have not yet decided to publish.
function contentOyiSafeSummary(item) {
  const parts = [
    `${item.title || "Article"} · ${titleCase(item.workflow_status || "unknown")}`.trim(),
  ];
  if (item.category) parts.push(`Category: ${item.category}.`);
  if (item.author) parts.push(`Author: ${item.author}.`);
  if (item.excerpt) parts.push(`Excerpt: ${item.excerpt}`);
  if (item.workflow_status === "scheduled" && item.scheduled_publish_at) parts.push(`Scheduled: ${fmtDateTime(item.scheduled_publish_at)}.`);
  if (item.sanity_live_url) parts.push(`Live at: ${item.sanity_live_url}.`);
  return parts.join(" ");
}

async function renderContentEditor(outlet, contentId, token) {
  setTopbar("Content", "");
  setSelectedObject(null);
  let item;
  try {
    const data = await apiGetContent(contentId);
    item = data.item;
  } catch (err) {
    if (token !== state.renderToken) return;
    outlet.innerHTML = "";
    outlet.appendChild(errorPanel(err.message || "This article could not be found."));
    return;
  }
  if (token !== state.renderToken) return;

  setSelectedObject("content", item.id, item.title, { content_ref: item.id, safe_summary: contentOyiSafeSummary(item) });
  outlet.innerHTML = "";
  const back = el(`<button type="button" class="detail-back">← Content</button>`);
  back.addEventListener("click", () => navigate("content"));
  outlet.appendChild(back);

  outlet.appendChild(el(`
    <div class="detail-header">
      <div>
        <div class="detail-typeline">Article</div>
        <h1>${escapeHtml(item.title)}</h1>
        <div class="detail-badges">${badge(titleCase(item.workflow_status), CONTENT_STATUS_TONE[item.workflow_status] || "default")}</div>
      </div>
    </div>
  `));

  if (item.sanity_live_url && item.workflow_status === "published") {
    outlet.appendChild(el(`<p style="margin:10px 0;"><a href="${escapeHtml(item.sanity_live_url)}" target="_blank" rel="noopener">Open live article →</a></p>`));
  }
  if (item.workflow_status === "scheduled" && item.scheduled_publish_at) {
    outlet.appendChild(el(`<p class="hint">Scheduled to publish ${escapeHtml(fmtDateTime(item.scheduled_publish_at))}.</p>`));
  }

  const form = el(`
    <form class="inline-form" style="flex-direction:column;align-items:stretch;gap:12px;max-width:640px;">
      <label>Title<input name="title" value="${escapeHtml(item.title)}" /></label>
      <label>Slug<input name="slug" value="${escapeHtml(item.slug || "")}" /></label>
      <label>Excerpt<textarea name="excerpt" rows="2">${escapeHtml(item.excerpt || "")}</textarea></label>
      <label>Featured Image
        <div class="featured-image-field" style="display:flex;align-items:center;gap:10px;">
          <img class="featured-image-thumb" src="${escapeHtml(item.featured_image_url || "")}" style="width:64px;height:64px;object-fit:cover;border-radius:var(--radius-sm);border:1px solid var(--line);display:${item.featured_image_url ? "block" : "none"};" alt="" />
          <input type="file" accept="image/*" class="featured-image-input" />
          <span class="featured-image-status" style="font-size:11px;color:var(--text-tertiary);"></span>
        </div>
        <input type="hidden" name="featured_image_url" value="${escapeHtml(item.featured_image_url || "")}" />
      </label>
      <label>Category<input name="category" value="${escapeHtml(item.category || "")}" /></label>
      <label>Author<input name="author" value="${escapeHtml(item.author || "")}" /></label>
      <label>Tags (comma separated)<input name="tags" value="${escapeHtml((item.tags || []).join(", "))}" /></label>
      <label>Body
        <div class="body-toolbar" style="display:flex;gap:4px;margin-bottom:4px;"></div>
        <textarea name="body" rows="14" style="font-family:inherit;">${escapeHtml(item.body || "")}</textarea>
        <span class="hint">Supports **bold**, *italic*, # / ## headings, and "- " bullet lists — carried through to the published article.</span>
      </label>
      <label>SEO Title<input name="seo_title" value="${escapeHtml(item.seo_title || "")}" /></label>
      <label>SEO Description<textarea name="seo_description" rows="2">${escapeHtml(item.seo_description || "")}</textarea></label>
      <div>
        <button type="submit" class="btn btn-primary btn-sm">Save</button>
        <button type="button" class="btn btn-ghost btn-sm content-preview-toggle">Preview</button>
        <span class="form-status"></span>
      </div>
    </form>
  `);

  wireBodyToolbar(form.querySelector(".body-toolbar"), form.querySelector('textarea[name="body"]'));

  const imageInput = form.querySelector(".featured-image-input");
  const imageThumb = form.querySelector(".featured-image-thumb");
  const imageStatus = form.querySelector(".featured-image-status");
  const imageUrlField = form.querySelector('input[name="featured_image_url"]');
  imageInput.addEventListener("change", async () => {
    const file = imageInput.files && imageInput.files[0];
    if (!file) return;
    imageStatus.textContent = "Uploading…";
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const result = await apiUploadContentImage(dataUrl, file.name, file.type);
      imageUrlField.value = result.file.url;
      imageThumb.src = result.file.url;
      imageThumb.style.display = "block";
      imageStatus.textContent = "Uploaded — click Save to keep it.";
    } catch (err) {
      imageStatus.textContent = err.message || "Could not upload image.";
    }
  });

  const previewHost = el(`<div class="content-preview" style="display:none;margin-top:14px;max-width:640px;"></div>`);
  form.querySelector(".content-preview-toggle").addEventListener("click", () => {
    const showing = previewHost.style.display !== "none";
    if (showing) {
      previewHost.style.display = "none";
      previewHost.innerHTML = "";
      return;
    }
    const formData = Object.fromEntries(new FormData(form).entries());
    previewHost.innerHTML = renderContentPreviewHtml(formData);
    previewHost.style.display = "block";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const statusEl = form.querySelector(".form-status");
    const formData = Object.fromEntries(new FormData(form).entries());
    try {
      const result = await apiUpdateContent(contentId, { ...formData, tags: formData.tags.split(",").map((t) => t.trim()).filter(Boolean) });
      statusEl.textContent = result.sanity?.ok ? "Saved and synced to Sanity draft." : "Saved locally.";
      if (result.sanity?.warnings?.length) statusEl.textContent += ` (${result.sanity.warnings.join(" ")})`;
    } catch (err) {
      statusEl.textContent = err.message || "Could not save.";
    }
  });
  outlet.appendChild(form);
  outlet.appendChild(previewHost);

  outlet.appendChild(renderContentWorkflowActions(item, contentId));
}

// Deliberately markdown-LITE, not a full markdown implementation and not
// a WYSIWYG editor — a plain textarea stays inspectable/diffable, and
// this small, fixed set of rules (bold/italic/headings/bullets) is
// exactly what textToPortableText in sanity-adapter.js also parses, so
// what a writer sees in Preview is what actually reaches the published
// article, not a plain-text approximation of formatting that gets lost.
function wireBodyToolbar(toolbar, textarea) {
  const buttons = [
    { label: "B", wrap: "**" },
    { label: "I", wrap: "*" },
    { label: "H2", prefix: "## " },
    { label: "H3", prefix: "### " },
    { label: "•", prefix: "- " },
  ];
  buttons.forEach(({ label, wrap, prefix }) => {
    const btn = el(`<button type="button" class="btn btn-ghost btn-sm" style="padding:2px 8px;">${escapeHtml(label)}</button>`);
    btn.addEventListener("click", () => {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const value = textarea.value;
      if (wrap) {
        textarea.value = value.slice(0, start) + wrap + value.slice(start, end) + wrap + value.slice(end);
        textarea.selectionStart = start + wrap.length;
        textarea.selectionEnd = end + wrap.length;
      } else if (prefix) {
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        textarea.value = value.slice(0, lineStart) + prefix + value.slice(lineStart);
        textarea.selectionStart = textarea.selectionEnd = start + prefix.length;
      }
      textarea.focus();
    });
    toolbar.appendChild(btn);
  });
}

function markdownLiteToHtml(text) {
  const inline = (line) => escapeHtml(line).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
  const paragraphs = String(text || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.map((p) => {
    const lines = p.split("\n");
    if (lines.every((l) => l.trim().startsWith("- "))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.trim().slice(2))}</li>`).join("")}</ul>`;
    }
    if (/^###\s+/.test(p)) return `<h4>${inline(p.replace(/^###\s+/, ""))}</h4>`;
    if (/^##\s+/.test(p)) return `<h3>${inline(p.replace(/^##\s+/, ""))}</h3>`;
    if (/^#\s+/.test(p)) return `<h2>${inline(p.replace(/^#\s+/, ""))}</h2>`;
    return `<p>${lines.map(inline).join("<br/>")}</p>`;
  }).join("");
}

function renderContentPreviewHtml(item) {
  return `
    <div style="border:1px solid var(--line);border-radius:var(--radius);padding:16px;background:var(--charcoal);">
      <div class="hint" style="margin-bottom:8px;">Office-rendered preview — approximates the published layout; the live article's actual design comes from the Ochiga website.</div>
      ${item.featured_image_url ? `<img src="${escapeHtml(item.featured_image_url)}" style="width:100%;max-height:260px;object-fit:cover;border-radius:var(--radius-sm);margin-bottom:12px;" alt="" />` : ""}
      <h2 style="margin:0 0 6px;">${escapeHtml(item.title || "Untitled")}</h2>
      <div class="hint" style="margin-bottom:10px;">${escapeHtml([item.author, item.category].filter(Boolean).join(" · "))}</div>
      ${item.excerpt ? `<p style="font-style:italic;color:var(--text-secondary);">${escapeHtml(item.excerpt)}</p>` : ""}
      <div>${markdownLiteToHtml(item.body)}</div>
    </div>
  `;
}

function renderContentWorkflowActions(item, contentId) {
  const wrap = el(`<div class="status-actions" style="margin-top:18px;"></div>`);
  const errorLabel = el(`<span class="form-status"></span>`);

  async function runAction(action, body) {
    try {
      await apiContentAction(contentId, action, body);
      // Same route as we're already on — navigate() re-renders in
      // place when the hash doesn't change, refreshing the status
      // badge and the now-different set of workflow buttons.
      navigate(`content/${contentId}`);
    } catch (err) {
      errorLabel.textContent = err.message || "That action could not be completed.";
      errorLabel.classList.add("visible");
    }
  }

  if (item.workflow_status === "draft" && hasPermission("content.write")) {
    const btn = el(`<button type="button" class="btn btn-primary btn-sm">Submit for Review</button>`);
    btn.addEventListener("click", () => runAction("submit-review"));
    wrap.appendChild(btn);
  }
  if (item.workflow_status === "in_review" && hasPermission("content.review")) {
    const approveBtn = el(`<button type="button" class="btn btn-primary btn-sm">Approve</button>`);
    approveBtn.addEventListener("click", () => runAction("approve"));
    wrap.appendChild(approveBtn);
    const requestBtn = el(`<button type="button" class="btn btn-ghost btn-sm">Request Changes</button>`);
    requestBtn.addEventListener("click", () => openDialog("Request Changes", [{ name: "note", label: "Note for the writer", type: "textarea" }], (data) => runAction("request-changes", data)));
    wrap.appendChild(requestBtn);
  }
  if (item.workflow_status === "approved" && hasPermission("content.publish")) {
    const publishBtn = el(`<button type="button" class="btn btn-primary btn-sm">Publish Now</button>`);
    publishBtn.addEventListener("click", () => runAction("publish"));
    wrap.appendChild(publishBtn);
    const scheduleBtn = el(`<button type="button" class="btn btn-ghost btn-sm">Schedule</button>`);
    scheduleBtn.addEventListener("click", () => openDialog("Schedule Publish", [{ name: "scheduled_publish_at", label: "Publish at (ISO date/time)", type: "datetime-local" }], (data) => runAction("schedule", { scheduled_publish_at: new Date(data.scheduled_publish_at).toISOString() })));
    wrap.appendChild(scheduleBtn);
  }
  if (item.workflow_status === "scheduled" && hasPermission("content.publish")) {
    const publishBtn = el(`<button type="button" class="btn btn-primary btn-sm">Publish Now</button>`);
    publishBtn.addEventListener("click", () => runAction("publish"));
    wrap.appendChild(publishBtn);
  }
  if (item.workflow_status === "published" && hasPermission("content.publish")) {
    const unpublishBtn = el(`<button type="button" class="btn btn-ghost btn-sm">Unpublish</button>`);
    unpublishBtn.addEventListener("click", () => runAction("unpublish"));
    wrap.appendChild(unpublishBtn);
  }
  wrap.appendChild(errorLabel);
  return wrap;
}

async function renderDocumentsRoute(outlet, rest, token) {
  const [subKey = "library", objectId] = rest;
  setTopbar("Documents", objectId ? "" : titleCase(subKey));
  outlet.innerHTML = "";
  const tabs = el(`<div class="crm-tabs"></div>`);
  DOCUMENTS_TABS.forEach((tab) => {
    const tabBtn = el(`<button type="button" class="crm-tab ${tab.key === subKey ? "active" : ""}">${escapeHtml(tab.label)}</button>`);
    tabBtn.addEventListener("click", () => navigate(`documents/${tab.key}`));
    tabs.appendChild(tabBtn);
  });
  outlet.appendChild(tabs);

  const body = el(`<div class="crm-body"></div>`);
  body.appendChild(skeletonPanel(4));
  outlet.appendChild(body);

  try {
    if (subKey === "library") {
      if (objectId) await renderDocumentDetail(body, objectId, token);
      else await renderDocumentsList(body, token);
    } else if (subKey === "proposals") {
      if (objectId) await renderProposalDetail(body, objectId, token);
      else await renderProposalsList(body, token);
    } else {
      setSelectedObject(null);
      body.innerHTML = "";
      body.appendChild(errorPanel("Unknown Documents area."));
    }
  } catch (err) {
    if (token !== state.renderToken) return;
    body.innerHTML = "";
    body.appendChild(errorPanel(err.message || "Could not load this view."));
  }
}

// GET /admin/office/documents is gated on office.read (legacy
// view_reports alias) — narrower than the documents.generate gate on
// this nav item. A role with documents.generate but not office.read
// (none of the built-in roles today, but the permission model allows
// it) would otherwise hit a confusing 403 — checked explicitly here,
// same defensive pattern used for the Leads/office.read mismatch.
async function renderDocumentsList(body, token) {
  setSelectedObject(null);
  if (!hasPermission("office.read")) {
    body.innerHTML = "";
    body.appendChild(errorPanel("You don't have permission to view Documents. Contact an administrator if you believe this is incorrect."));
    return;
  }
  const documents = await fetchDocuments();
  if (token !== state.renderToken) return;
  renderStandardList(body, {
    title: "Documents",
    records: documents,
    columns: [
      { label: "Title", width: "1.6fr", render: (d) => escapeHtml(d.title) },
      { label: "Type", render: (d) => escapeHtml(titleCase(d.document_type)) },
      { label: "Status", render: (d) => badge(titleCase(d.status), toneForStatus(d.status)) },
      { label: "Related", render: (d) => d.related_type ? escapeHtml(titleCase(d.related_type)) : "—" },
      { label: "Owner", render: (d) => escapeHtml(d.owner || "—") },
      { label: "Updated", render: (d) => escapeHtml(fmtRelative(d.updated_at)) },
    ],
    searchFields: ["title", "document_type", "status", "owner", "related_type"],
    filters: [{ key: "document_type", label: "Type" }, { key: "status", label: "Status" }],
    canManage: hasPermission("documents.generate"),
    onCreate: () => openCreateDocumentDialog(),
    onRowClick: (d) => navigate(`documents/library/${d.id}`),
    emptyMessage: "No documents yet.",
  });
}

async function renderDocumentDetail(body, id, token) {
  if (!hasPermission("office.read")) {
    body.innerHTML = "";
    body.appendChild(errorPanel("You don't have permission to view Documents."));
    return;
  }
  const canManage = hasPermission("documents.generate");
  const [documents, notes, leads, contacts, organizations, opportunities, projects, portfolioEntries, supportCases, privateRelationships, partnerships] = await Promise.all([
    fetchDocuments(),
    fetchRelatedActivities("document", id),
    hasPermission("office.read") ? fetchLeads().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchContacts().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOrganizations().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOpportunities().catch(() => []) : Promise.resolve([]),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
    hasPermission("portfolio.read") ? fetchPortfolio().catch(() => []) : Promise.resolve([]),
    hasPermission("support.read") ? fetchSupport().catch(() => []) : Promise.resolve([]),
    hasPermission("private.read") ? fetchPrivate().catch(() => []) : Promise.resolve([]),
    hasPermission("partnerships.read") ? fetchPartnerships().catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  const record = documents.find((d) => d.id === id);
  if (!record) {
    body.innerHTML = "";
    body.appendChild(errorPanel("This document could not be found."));
    return;
  }
  const related = resolveGenericRelation(record.related_type, record.related_id, { leads, contacts, organizations, opportunities, projects, portfolioEntries, supportCases, privateRelationships, partnerships });

  const fileUrl = record.html_url || record.file_url;
  const docSection = el(`
    <div class="detail-section">
      <h3>Document</h3>
      <div class="fact-grid">
        ${factRow("Type", titleCase(record.document_type))}
        ${factRow("Status", titleCase(record.status))}
        ${factRow("Owner", record.owner)}
        ${factRow("Related", related ? related.name : (record.related_type ? titleCase(record.related_type) : "—"))}
      </div>
      ${fileUrl ? `<div class="doc-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;"></div>` : `<p class="detail-note">No file is attached to this document record.</p>`}
      <div class="doc-preview-frame" style="display:none;margin-top:12px;"></div>
    </div>
  `);
  if (fileUrl) {
    const actions = docSection.querySelector(".doc-actions");
    const previewFrame = docSection.querySelector(".doc-preview-frame");

    const openLink = el(`<a href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">Open →</a>`);
    actions.appendChild(openLink);

    const previewBtn = el(`<button type="button" class="btn btn-ghost btn-sm">Preview</button>`);
    previewBtn.addEventListener("click", () => {
      const showing = previewFrame.style.display !== "none";
      if (showing) {
        previewFrame.style.display = "none";
        previewFrame.innerHTML = "";
        previewBtn.textContent = "Preview";
      } else {
        previewFrame.innerHTML = `<iframe src="${escapeHtml(fileUrl)}" style="width:100%;height:480px;border:1px solid var(--line);border-radius:var(--radius);background:var(--white);"></iframe>`;
        previewFrame.style.display = "block";
        previewBtn.textContent = "Hide Preview";
      }
    });
    actions.appendChild(previewBtn);

    const downloadLink = el(`<a href="${escapeHtml(fileUrl)}" download="${escapeHtml((record.title || "document").replace(/[^a-z0-9]+/gi, "-"))}.html" class="btn btn-ghost btn-sm">Download</a>`);
    actions.appendChild(downloadLink);

    // The Open/Download links above require an Office login — fine for
    // staff, useless if pasted into an email to an external client. The
    // share link is token-gated instead, so it actually works for them.
    const shareBtn = el(`<button type="button" class="btn btn-ghost btn-sm">Copy Share Link</button>`);
    if (record.share_token) {
      shareBtn.addEventListener("click", async () => {
        const shareUrl = `${window.location.origin}/api/lead-agents/documents/shared/${encodeURIComponent(id)}/${encodeURIComponent(record.share_token)}`;
        try {
          await navigator.clipboard.writeText(shareUrl);
          toast("Share link copied — this one works for anyone, no Office login needed.");
        } catch {
          toast(shareUrl);
        }
      });
    } else {
      shareBtn.disabled = true;
      shareBtn.title = "This document was created before shareable links existed — regenerate it to get one.";
    }
    actions.appendChild(shareBtn);
  }

  const mainSections = [
    docSection,
    renderTimeline(notes, { canAddNote: canManage, onAddNote: () => promptAddRelatedNote("document", id) }),
  ];

  const railSections = [];
  if (related) railSections.push(railCard(titleCase(record.related_type), `<a href="#/${related.path}">${escapeHtml(related.name)}</a>`));

  renderDetailShell(body, {
    type: "document",
    id,
    label: record.title,
    typeLine: `Document · ${titleCase(record.document_type)}`,
    badges: [badge(titleCase(record.status), toneForStatus(record.status))],
    backLabel: "Documents",
    onBack: () => navigate("documents/library"),
    oyiContext: {
      document_ref: id,
      safe_summary: documentOyiSafeSummary(record, { related }),
    },
    mainSections,
    railSections,
  });
}

// Built ONLY from document metadata already rendered on this page — never
// the file body/contents, which may carry sensitive commercial detail Oyi
// Core has no need to see just to answer "what is this document about".
function documentOyiSafeSummary(record, { related } = {}) {
  const parts = [
    `${record.title || "Document"} · ${titleCase(record.document_type || "unknown")}`.trim(),
    `Status: ${titleCase(record.status || "unknown")}`,
  ];
  if (record.owner) parts.push(`Owner: ${record.owner}.`);
  if (related) parts.push(`Related ${titleCase(record.related_type || "record")}: ${related.name}.`);
  return parts.join(" ");
}

function renderProposalBody(markdown) {
  const wrap = el(`<div class="proposal-body"></div>`);
  const lines = String(markdown || "").split("\n");
  let list = null;
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) { list = null; return; }
    if (trimmed.startsWith("## ")) { list = null; wrap.appendChild(el(`<h4>${escapeHtml(trimmed.slice(3))}</h4>`)); return; }
    if (trimmed.startsWith("# ")) { list = null; wrap.appendChild(el(`<h3>${escapeHtml(trimmed.slice(2))}</h3>`)); return; }
    if (trimmed.startsWith("- ")) {
      if (!list) { list = el(`<ul></ul>`); wrap.appendChild(list); }
      list.appendChild(el(`<li>${escapeHtml(trimmed.slice(2))}</li>`));
      return;
    }
    list = null;
    wrap.appendChild(el(`<p>${escapeHtml(trimmed)}</p>`));
  });
  if (!wrap.children.length) wrap.appendChild(el(`<p class="rail-empty">No draft content.</p>`));
  return wrap;
}

async function renderProposalsList(body, token) {
  setSelectedObject(null);
  if (!hasPermission("office.read")) {
    body.innerHTML = "";
    body.appendChild(errorPanel("You don't have permission to view Proposals."));
    return;
  }
  const proposals = await fetchProposals();
  if (token !== state.renderToken) return;
  renderStandardList(body, {
    title: "Proposals / Quotations",
    records: proposals,
    columns: [
      { label: "Title", width: "1.6fr", render: (p) => escapeHtml(p.title) },
      { label: "Client", render: (p) => escapeHtml((p.lead && (p.lead.company || p.lead.name)) || "—") },
      { label: "Package", render: (p) => escapeHtml(p.tier_name || "—") },
      { label: "Status", render: (p) => badge(titleCase(p.status), toneForStatus(p.status)) },
      { label: "Monthly", render: (p) => escapeHtml(p.monthly_price != null ? `${p.currency} ${Number(p.monthly_price).toLocaleString()}` : "Custom") },
      { label: "Updated", render: (p) => escapeHtml(fmtRelative(p.updated_at)) },
    ],
    searchFields: ["title", "tier_name"],
    filters: [{ key: "status", label: "Status" }, { key: "tier_name", label: "Package" }],
    canManage: false,
    onRowClick: (p) => navigate(`documents/proposals/${p.id}`),
    emptyMessage: "No proposals created yet. Create one from an Opportunity or Lead.",
  });
}

async function renderProposalDetail(body, id, token) {
  if (!hasPermission("office.read")) {
    body.innerHTML = "";
    body.appendChild(errorPanel("You don't have permission to view Proposals."));
    return;
  }
  const canManage = hasPermission("crm.manage");
  const proposals = await fetchProposals();
  if (token !== state.renderToken) return;
  const record = proposals.find((p) => p.id === id);
  if (!record) {
    body.innerHTML = "";
    body.appendChild(errorPanel("This proposal could not be found."));
    return;
  }

  const mainSections = [
    el(`
      <div class="detail-section">
        <h3>Commercial Estimate</h3>
        <div class="fact-grid">
          ${factRow("Package", record.tier_name)}
          ${factRow("Units", record.unit_count != null ? String(record.unit_count) : "—")}
          ${factRow("Monthly", record.monthly_price != null ? `${record.currency} ${Number(record.monthly_price).toLocaleString()}` : "Custom")}
          ${factRow("Client", record.lead ? (record.lead.company || record.lead.name) : "—")}
        </div>
        <p class="detail-note">Figures come from Ochiga's approved OYI_PRICING rate card, not from model reasoning.</p>
      </div>
    `),
  ];
  const draftSection = el(`<div class="detail-section"><h3>Draft</h3></div>`);
  draftSection.appendChild(renderProposalBody(record.body));
  mainSections.push(draftSection);

  if (canManage) {
    // PATCH /admin/proposals/:id has no server-enforced status
    // machine (unlike tasks/support/projects/portfolio/meetings) —
    // this small, restrained set of transitions is a frontend
    // choice, not a backend rule.
    const nextByStatus = { draft: ["sent"], sent: ["accepted", "declined"], accepted: [], declined: [] };
    const next = nextByStatus[String(record.status || "draft").toLowerCase()] || [];
    if (next.length) {
      const wrap = el(`<div class="detail-section"><h3>Update Status</h3></div>`);
      const actions = el(`<div class="status-actions"></div>`);
      const errorLabel = el(`<span class="form-status"></span>`);
      next.forEach((status) => {
        const btn = el(`<button type="button" class="btn btn-ghost btn-sm">Mark ${escapeHtml(titleCase(status))}</button>`);
        btn.addEventListener("click", async () => {
          try {
            await apiUpdateProposal(record.id, { status });
            invalidate("proposals");
            invalidate("leads");
            navigate(`documents/proposals/${id}`);
          } catch (err) {
            errorLabel.textContent = err.message || "Could not update status.";
          }
        });
        actions.appendChild(btn);
      });
      actions.appendChild(errorLabel);
      wrap.appendChild(actions);
      mainSections.push(wrap);
    }
  }

  const railSections = [];
  if (record.lead_id) railSections.push(railCard("Lead", `<a href="#/crm/leads/${record.lead_id}">${escapeHtml((record.lead && (record.lead.company || record.lead.name)) || "Lead")}</a>`));

  renderDetailShell(body, {
    type: "proposal",
    id,
    label: record.title,
    typeLine: `Proposal · ${record.tier_name || "—"}`,
    badges: [badge(titleCase(record.status), toneForStatus(record.status))],
    backLabel: "Proposals",
    onBack: () => navigate("documents/proposals"),
    mainSections,
    railSections,
  });
}

// ---------------------------------------------------------------
// TEAM — real Office staff/admin_users, not a legacy placeholder.
// Edit (role/status/display name) uses the same PATCH contract the
// legacy dashboard used; only shown to staff.manage holders (in
// practice super_admin/ochiga_admin — never weakened below that).
// ---------------------------------------------------------------
async function renderTeamView(outlet, token) {
  setTopbar("Team", "");
  setSelectedObject(null);
  outlet.innerHTML = "";
  outlet.appendChild(skeletonPanel(4));

  let users, canonicalRoles;
  try {
    const [usersData, permissionsData] = await Promise.all([apiListAdminUsers(), apiGetPermissionsMeta()]);
    users = usersData.users || [];
    // permissions.js's ROLE_PERMISSIONS is the single source of truth —
    // fetched live rather than kept as a second hardcoded copy here, so
    // this list can never drift from the backend again.
    canonicalRoles = permissionsData.canonical_roles || [];
  } catch (err) {
    if (token !== state.renderToken) return;
    outlet.innerHTML = "";
    outlet.appendChild(el(`<div class="view-heading"><h1>Team</h1></div>`));
    outlet.appendChild(errorPanel(err.message || "Could not load Office staff."));
    return;
  }
  if (token !== state.renderToken) return;

  const canManage = hasPermission("staff.manage");
  const canManageSecurity = hasPermission("manage_security");
  outlet.innerHTML = "";
  outlet.appendChild(el(`
    <div class="view-heading">
      <h1>Team</h1>
      <p>Ochiga Office staff accounts — ${users.length} total.</p>
    </div>
  `));

  if (canManage) {
    const toolbar = el(`<div class="list-toolbar"></div>`);
    const spacer = el(`<div class="toolbar-spacer"></div>`);
    toolbar.appendChild(spacer);
    const inviteBtn = el(`<button type="button" class="btn btn-ghost btn-sm">Invite Staff</button>`);
    inviteBtn.addEventListener("click", () => openInviteStaffDialog(canonicalRoles, token));
    toolbar.appendChild(inviteBtn);
    const addBtn = el(`<button type="button" class="btn btn-primary btn-sm">Add Staff</button>`);
    addBtn.addEventListener("click", () => openAddStaffDialog(canonicalRoles, token));
    toolbar.appendChild(addBtn);
    outlet.appendChild(toolbar);
  }

  const table = renderDataTable({
    columns: [
      {
        label: "Photo", width: "40px",
        render: (u) => {
          const initials = (u.display_name || u.email || "?").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
          return `<div class="avatar" style="width:24px;height:24px;font-size:10px;">${u.passport_photo_url ? `<img class="avatar-img" src="${escapeHtml(u.passport_photo_url)}" alt="" />` : `<span>${escapeHtml(initials || "?")}</span>`}</div>`;
        },
      },
      { label: "Name", render: (u) => escapeHtml(u.display_name || u.email) },
      { label: "Position", render: (u) => escapeHtml(u.office_position || "—") },
      { label: "Role", render: (u) => badge(titleCase(u.role), u.role === "super_admin" || u.role === "admin" ? "red" : "default") },
      { label: "Status", render: (u) => badge(titleCase(u.status || "active"), toneForStatus(u.status || "active")) },
      { label: "Last active", render: (u) => fmtRelative(u.last_login_at) },
    ],
    rows: users,
    onRowClick: canManage ? (user) => toggleTeamEditRow(user, canonicalRoles, canManageSecurity) : undefined,
    emptyMessage: "No staff accounts yet.",
  });
  outlet.appendChild(table);

  if (canManage) {
    const editWrap = el(`<div id="teamEditWrap"></div>`);
    outlet.appendChild(editWrap);
  } else {
    outlet.appendChild(el(`<p class="hint" style="margin-top:14px;">You have read-only visibility into Team. Role/status changes require the staff.manage permission.</p>`));
  }
}

function openAddStaffDialog(canonicalRoles, token) {
  openDialog("Add Staff", [
    { name: "display_name", label: "Full name" },
    { name: "email", label: "Email", type: "email" },
    { name: "password", label: "Temporary password", type: "password" },
    { name: "office_position", label: "Office Position (e.g. CEO, Sales Director)" },
    { name: "role", label: "System Role", type: "select", options: canonicalRoles, value: canonicalRoles[0] },
  ], async (data) => {
    if (!data.email || !data.password) throw new Error("Email and a temporary password are required.");
    await apiCreateAdminUser({
      email: data.email,
      password: data.password,
      display_name: data.display_name || data.email,
      office_position: data.office_position || "",
      role: data.role,
    });
    invalidate("permissionsMeta");
    await renderTeamView(document.getElementById("viewOutlet"), ++state.renderToken);
  });
}

function openInviteStaffDialog(canonicalRoles, token) {
  openDialog("Invite Staff", [
    { name: "display_name", label: "Full name" },
    { name: "email", label: "Email", type: "email" },
    { name: "office_position", label: "Office Position (e.g. CEO, Sales Director)" },
    { name: "role", label: "System Role", type: "select", options: canonicalRoles, value: canonicalRoles[0] },
  ], async (data) => {
    if (!data.email) throw new Error("Email is required.");
    const result = await apiInviteAdminUser({
      email: data.email,
      display_name: data.display_name || "",
      office_position: data.office_position || "",
      role: data.role,
    });
    const delivered = result?.email_delivery?.delivered;
    toast(delivered ? `Invite sent to ${data.email}.` : `Invite created for ${data.email}, but the email could not be delivered — share the link manually.`);
  });
}

// Groups PERMISSION_KEYS by their dotted prefix (e.g. "crm.read",
// "crm.manage" -> group "crm") so the permission editor reads as
// labeled sections instead of one 53-item flat list.
function groupedPermissionKeys(scopes) {
  const groups = {};
  scopes.forEach((key) => {
    const prefix = key.includes(".") ? key.split(".")[0] : "other";
    (groups[prefix] = groups[prefix] || []).push(key);
  });
  return groups;
}

async function toggleTeamEditRow(user, canonicalRoles, canManageSecurity) {
  const wrap = document.getElementById("teamEditWrap");
  if (!wrap) return;
  wrap.innerHTML = "";
  // A stored role that predates this account's current role (a legacy
  // alias like "admin"/"founder") won't be in canonicalRoles — keep it
  // selectable so editing the account doesn't silently reassign the
  // role to something else just by opening the form.
  const roles = canonicalRoles.includes(user.role) ? canonicalRoles : [user.role, ...canonicalRoles];
  const initials = (user.display_name || user.email || "?").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  let permissionsMeta;
  try {
    permissionsMeta = await apiGetPermissionsMeta();
  } catch {
    permissionsMeta = { scopes: [], roles: {} };
  }
  const allScopes = permissionsMeta.scopes || [];
  const grantedScopes = new Set(Array.isArray(user.permission_scopes) ? user.permission_scopes : []);
  const groups = groupedPermissionKeys(allScopes);

  const form = el(`
    <form class="inline-form" style="flex-direction:column;align-items:stretch;gap:14px;margin-top:14px;max-width:640px;">
      <div class="field">
        <label>Editing</label>
        <div style="padding-top:6px;color:var(--white);font-size:13px;">${escapeHtml(user.display_name || user.email)}</div>
      </div>
      <div class="field">
        <label for="teamEditPhoto">Photo</label>
        <div style="display:flex;align-items:center;gap:14px;">
          <div class="avatar" style="width:96px;height:96px;font-size:32px;">
            ${user.passport_photo_url ? `<img class="avatar-img" src="${escapeHtml(user.passport_photo_url)}" alt="" />` : `<span>${escapeHtml(initials || "?")}</span>`}
          </div>
          <input id="teamEditPhoto" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
        </div>
        <span class="form-status" id="teamPhotoStatus"></span>
      </div>
      <div class="field">
        <label for="teamEditPosition">Office Position</label>
        <input id="teamEditPosition" type="text" value="${escapeHtml(user.office_position || "")}" placeholder="e.g. Technical Advisor — AI &amp; Robotics" />
        <span class="hint">The person's actual job title — never shown as their system role.</span>
      </div>
      <div class="field">
        <label for="teamEditRole">System Role</label>
        <select id="teamEditRole">
          ${roles.map((r) => `<option value="${escapeHtml(r)}" ${r === user.role ? "selected" : ""}>${escapeHtml(titleCase(r))}</option>`).join("")}
        </select>
        <span class="hint">Determines the base set of Office capabilities below.</span>
      </div>
      <div class="field">
        <label for="teamEditStatus">Status</label>
        <select id="teamEditStatus">
          ${["active", "suspended"].map((s) => `<option value="${s}" ${s === (user.status || "active") ? "selected" : ""}>${titleCase(s)}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>Permissions</label>
        <span class="hint">Checked-and-locked items come from the System Role above. Check anything else to grant it to this person specifically, on top of their role.</span>
        <div class="permission-editor" style="display:flex;flex-direction:column;gap:10px;margin-top:8px;max-height:320px;overflow-y:auto;border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px;"></div>
      </div>
      <div>
        <button class="btn btn-primary" type="submit">Save</button>
        ${canManageSecurity ? `<button class="btn btn-ghost" type="button" id="teamResetPassword">Reset Password</button>` : ""}
        <button class="btn btn-ghost" type="button" id="teamEditCancel">Cancel</button>
      </div>
      <div class="form-error" id="teamEditError"></div>
    </form>
  `);

  const permissionHost = form.querySelector(".permission-editor");
  function renderPermissionGroups(selectedRole) {
    const roleGranted = new Set(permissionsMeta.roles?.[selectedRole] || []);
    permissionHost.innerHTML = "";
    Object.entries(groups).forEach(([prefix, keys]) => {
      const section = el(`<div></div>`);
      section.appendChild(el(`<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-tertiary);margin-bottom:4px;">${escapeHtml(titleCase(prefix))}</div>`));
      const list = el(`<div style="display:flex;flex-wrap:wrap;gap:8px 16px;"></div>`);
      keys.forEach((key) => {
        const fromRole = roleGranted.has(key);
        const checked = fromRole || grantedScopes.has(key);
        const row = el(`
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:${fromRole ? "var(--text-tertiary)" : "var(--text-secondary)"};">
            <input type="checkbox" data-scope="${escapeHtml(key)}" ${checked ? "checked" : ""} ${fromRole ? "disabled" : ""} />
            ${escapeHtml(key)}
          </label>
        `);
        list.appendChild(row);
      });
      section.appendChild(list);
      permissionHost.appendChild(section);
    });
  }
  renderPermissionGroups(user.role);
  form.querySelector("#teamEditRole").addEventListener("change", (event) => renderPermissionGroups(event.target.value));

  form.querySelector("#teamEditCancel").addEventListener("click", () => { wrap.innerHTML = ""; });
  form.querySelector("#teamEditPhoto").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const statusEl = form.querySelector("#teamPhotoStatus");
    const MAX_BYTES = 6 * 1024 * 1024; // matches the server's own 6MB cap
    if (file.size > MAX_BYTES) {
      statusEl.textContent = "Image is too large (6MB max).";
      return;
    }
    statusEl.textContent = "Uploading…";
    try {
      const dataUrl = await readFileAsDataUrl(file);
      await apiUploadAdminUserPhoto(user.id, dataUrl);
      statusEl.textContent = "Photo updated.";
      const token = ++state.renderToken;
      await renderTeamView(document.getElementById("viewOutlet"), token);
    } catch (err) {
      statusEl.textContent = err.message || "Could not upload photo.";
    }
  });
  if (canManageSecurity) {
    form.querySelector("#teamResetPassword").addEventListener("click", async () => {
      const errorBox = form.querySelector("#teamEditError");
      try {
        const result = await apiResetAdminUserPassword(user.id);
        const delivered = result?.email_delivery?.delivered;
        toast(delivered ? `Password reset link sent to ${user.email}.` : `Reset link created, but the email could not be delivered — share it manually.`);
      } catch (err) {
        errorBox.textContent = err.message || "Could not issue a password reset.";
        errorBox.classList.add("visible");
      }
    });
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = form.querySelector("#teamEditError");
    errorBox.classList.remove("visible");
    const selectedRole = form.querySelector("#teamEditRole").value;
    const roleGranted = new Set(permissionsMeta.roles?.[selectedRole] || []);
    const permissionScopes = Array.from(permissionHost.querySelectorAll("input[type=checkbox]"))
      .filter((input) => input.checked && !roleGranted.has(input.dataset.scope))
      .map((input) => input.dataset.scope);
    try {
      await apiUpdateAdminUser(user.id, {
        role: selectedRole,
        status: form.querySelector("#teamEditStatus").value,
        office_position: form.querySelector("#teamEditPosition").value,
        permission_scopes: permissionScopes,
      });
      wrap.innerHTML = "";
      const token = ++state.renderToken;
      await renderTeamView(document.getElementById("viewOutlet"), token);
    } catch (err) {
      errorBox.textContent = err.message || "Could not update this account.";
      errorBox.classList.add("visible");
    }
  });
  wrap.appendChild(form);
}

// ---------------------------------------------------------------
// SETTINGS — real integration/connectivity status, not a legacy
// placeholder. Read-only where Office has no mutation contract;
// the one real action (trigger a Facility/Consumer sync) uses the
// same endpoint the legacy dashboard used.
// ---------------------------------------------------------------
async function renderSettingsView(outlet, token) {
  setTopbar("Settings", "");
  setSelectedObject(null);
  outlet.innerHTML = "";
  outlet.appendChild(skeletonPanel(4));

  let integrations;
  try {
    const data = await apiListIntegrations();
    integrations = data.integrations || {};
  } catch (err) {
    if (token !== state.renderToken) return;
    outlet.innerHTML = "";
    outlet.appendChild(el(`<div class="view-heading"><h1>Settings</h1></div>`));
    outlet.appendChild(errorPanel(err.message || "Could not load integration status."));
    return;
  }
  if (token !== state.renderToken) return;

  outlet.innerHTML = "";
  outlet.appendChild(el(`
    <div class="view-heading">
      <h1>Settings</h1>
      <p>Office integration and connectivity status. Read-only unless noted — Office does not fabricate save actions for settings it doesn't actually own.</p>
    </div>
  `));

  const section = el(`<div class="overview-section"><h3>Integration status</h3></div>`);
  const grid = el(`<div class="fact-grid"></div>`);
  Object.entries(integrations).forEach(([key, value]) => {
    const ok = value && (value.ok === true || value.status === "active" || value.status === "same_origin");
    const configured = !(value && value.status === "not_configured");
    const tone = ok ? "green" : configured ? "amber" : "default";
    const label = configured ? (ok ? "Connected" : "Configured, not reachable") : "Not configured";
    grid.appendChild(el(`
      <div class="fact"><div class="fact-label">${escapeHtml(titleCase(key))}</div><div class="fact-value">${badge(label, tone)}</div></div>
    `));
  });
  section.appendChild(grid);
  outlet.appendChild(section);

  if (hasPermission("office.manage")) {
    const syncSection = el(`<div class="overview-section" style="margin-top:24px;"><h3>Sync</h3></div>`);
    const syncBody = el(`<p>Pull the latest safe operational snapshot from Oyi Facility and Consumer.</p>`);
    const btnRow = el(`<div class="inline-form"></div>`);
    const statusLabel = el(`<span class="hint" id="syncStatus"></span>`);
    ["facility", "consumer", "all"].forEach((target) => {
      const btn = el(`<button class="btn btn-ghost" type="button">Sync ${escapeHtml(titleCase(target))}</button>`);
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        statusLabel.textContent = "Syncing…";
        try {
          await apiTriggerOfficeSync(target);
          statusLabel.textContent = `${titleCase(target)} sync completed.`;
        } catch (err) {
          statusLabel.textContent = err.message || "Sync failed.";
        } finally {
          btn.disabled = false;
        }
      });
      btnRow.appendChild(btn);
    });
    syncSection.appendChild(syncBody);
    syncSection.appendChild(btnRow);
    syncSection.appendChild(statusLabel);
    outlet.appendChild(syncSection);
  }

  const notOwned = el(`
    <div class="overview-section" style="margin-top:24px;">
      <h3>Not yet owned by Office</h3>
      <p class="hint">Company/business profile, notification preferences, CRM assignment defaults, and session/security policy do not have a real Office settings contract yet — shown here honestly rather than as fabricated toggles.</p>
    </div>
  `);
  outlet.appendChild(notOwned);
}

// ---------------------------------------------------------------
// AUDIT — real audit_events, super_admin/audit.read only. Read-only
// (no backend contract mutates audit history) with a client-side
// filter over the same 200 most-recent events the API returns.
// ---------------------------------------------------------------
async function renderAuditView(outlet, token) {
  setTopbar("Audit", "");
  setSelectedObject(null);
  outlet.innerHTML = "";
  outlet.appendChild(skeletonPanel(4));

  let events;
  try {
    const data = await apiListAudit();
    events = data.audit || [];
  } catch (err) {
    if (token !== state.renderToken) return;
    outlet.innerHTML = "";
    outlet.appendChild(el(`<div class="view-heading"><h1>Audit</h1></div>`));
    outlet.appendChild(errorPanel(err.message || "Could not load the audit trail."));
    return;
  }
  if (token !== state.renderToken) return;

  outlet.innerHTML = "";
  outlet.appendChild(el(`
    <div class="view-heading">
      <h1>Audit</h1>
      <p>The most recent ${events.length} corporate audit events — authentication, CRM, and workflow-state changes.</p>
    </div>
  `));

  const toolbar = el(`
    <div class="list-toolbar">
      <input class="toolbar-search" id="auditSearch" type="search" placeholder="Filter by actor, action, or target…" />
    </div>
  `);
  outlet.appendChild(toolbar);

  const tableWrap = el(`<div id="auditTableWrap"></div>`);
  outlet.appendChild(tableWrap);

  function renderFiltered(query) {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? events.filter((e) => [e.actor_email, e.action, e.target_type, e.target_id, e.resource_type, e.resource_id]
          .some((field) => String(field || "").toLowerCase().includes(q)))
      : events;
    tableWrap.innerHTML = "";
    tableWrap.appendChild(renderDataTable({
      columns: [
        { label: "Time", render: (e) => fmtDateTime(e.created_at) },
        { label: "Actor", render: (e) => escapeHtml(e.actor_email || "system") },
        { label: "Action", render: (e) => escapeHtml(titleCase(e.action)) },
        { label: "Target", render: (e) => escapeHtml(`${e.target_type || e.resource_type || ""} ${e.target_id || e.resource_id || ""}`.trim() || "—") },
        { label: "Status", render: (e) => badge(titleCase(e.status || "success"), toneForStatus(e.status || "success")) },
      ],
      rows: filtered,
      emptyMessage: "No audit events match this filter.",
    }));
  }
  renderFiltered("");
  toolbar.querySelector("#auditSearch").addEventListener("input", (event) => renderFiltered(event.target.value));
}

// ---------------------------------------------------------------
// Agent Observatory (Ecosystem Standardization Programme 13).
// Observability only, not another agent runtime — reuses the existing
// traces table and the already-built GET /admin/traces route (found
// during Programme 2's audit: fully implemented backend, zero frontend
// consumer). Real data for the two surfaces Office can actually see
// (its own office_internal Oyi chat, and the public-website lead-agent
// conversation runtime, both of which write real trace rows) — Oyi
// Consumer/Facility/Website-widget/Backend Oyi Core are separate repos
// with their own data stores Office has no access to, so they're shown
// honestly as not-yet-connected rather than inventing numbers for them.
// ---------------------------------------------------------------
async function apiListTraces() {
  return api("/api/lead-agents/admin/traces");
}
const OBSERVATORY_KNOWN_SURFACES = [
  { key: "office_internal", label: "Ochiga Office", types: ["office_internal_chat_completed", "office_internal_chat_failed"] },
  { key: "public_website_widget", label: "Ochiga Website (lead-agent widget)", types: ["chat_started", "tool_executed", "chat_completed"] },
];
const OBSERVATORY_UNCONNECTED_SURFACES = [
  "Oyi Consumer",
  "Oyi Facility",
  "getoyi.com (Oyi Website)",
  "Ochiga Backend / Oyi Core (direct)",
];

// Trace records ({type, agent, tool_name, created_at, ...}) don't match
// renderTimeline's expected shape ({activity_type, title, body, actor,
// created_at}) — small adapter so Recent Activity here uses the same
// row pattern as Home's Recent Activity, instead of a bespoke layout.
function traceToTimelineItem(trace) {
  return {
    activity_type: trace.type,
    title: titleCase(trace.type),
    body: trace.tool_name ? `Tool: ${trace.tool_name}` : null,
    actor: trace.agent || trace.source || "",
    created_at: trace.created_at,
  };
}

async function renderObservatoryView(outlet, token) {
  setTopbar("AI Agents", "");
  setSelectedObject(null);
  outlet.innerHTML = "";
  outlet.appendChild(skeletonPanel(4));

  let traces;
  try {
    const data = await apiListTraces();
    traces = data.traces || [];
  } catch (err) {
    if (token !== state.renderToken) return;
    outlet.innerHTML = "";
    outlet.appendChild(el(`<div class="view-heading"><h1>AI Agents</h1></div>`));
    outlet.appendChild(errorPanel(err.message || "Could not load agent traces."));
    return;
  }
  if (token !== state.renderToken) return;

  outlet.innerHTML = "";
  outlet.appendChild(el(`
    <div class="view-heading">
      <h1>AI Agents</h1>
      <p>Real interaction data from surfaces that report into Office. This is observability, not a second intelligence runtime — numbers below are computed only from what was actually recorded.</p>
    </div>
  `));

  const toolExecutions = traces.filter((t) => t.type === "tool_executed");
  const toolCounts = {};
  toolExecutions.forEach((t) => { const name = t.tool_name || "unknown"; toolCounts[name] = (toolCounts[name] || 0) + 1; });
  const failures = traces.filter((t) => t.type === "office_internal_chat_failed").length;

  const kpiGroup = KPIGroup([
    { label: "Recorded Interactions", value: traces.length, icon: iconSvg("observatory", "kpi-icon") },
    { label: "Tool Executions", value: toolExecutions.length, icon: iconSvg("observatory", "kpi-icon") },
    { label: "Office Chat Failures", value: failures, icon: iconSvg("attention", "kpi-icon"), alert: failures > 0 },
  ]);
  kpiGroup.style.marginBottom = "var(--space-5)";
  outlet.appendChild(kpiGroup);

  const rowA = el(`<div class="home-grid"></div>`);
  outlet.appendChild(rowA);

  const surfacesPanel = homePanel("Surfaces");
  const surfaceRows = OBSERVATORY_KNOWN_SURFACES.map((surface) => {
    const rows = traces.filter((t) => surface.types.includes(t.type));
    const lastAt = rows[0]?.created_at;
    return { label: surface.label, value: `${rows.length} interactions${lastAt ? ` · last ${fmtRelative(lastAt)}` : " · no data yet"}` };
  });
  // Never implied as operational — a plain unstyled note, distinct from
  // the real (StageStrip/FactGrid) values above it.
  const unconnectedRows = OBSERVATORY_UNCONNECTED_SURFACES.map((label) => ({ label, html: `<span style="color:var(--text-tertiary);">Not connected to Office yet</span>` }));
  surfacesPanel.appendChild(FactGrid([...surfaceRows, ...unconnectedRows]));
  rowA.appendChild(homePanelWrap("span-6", surfacesPanel));

  // Tool Usage as a proportional strip, not a plain count list — answers
  // "which tools does Oyi invoke most, relative to each other?" using
  // the real tool_name field already computed into toolCounts above.
  const toolPanel = homePanel("Tool Usage");
  if (Object.keys(toolCounts).length) {
    toolPanel.appendChild(StageStrip(
      Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ label: name, count })),
      "No tool executions recorded yet."
    ));
  } else {
    toolPanel.appendChild(el(`<p class="home-panel-empty">No tool executions recorded yet.</p>`));
  }
  rowA.appendChild(homePanelWrap("span-6", toolPanel));

  const activityPanel = homePanel("Recent Activity");
  activityPanel.style.marginTop = "var(--space-4)";
  if (!traces.length) {
    activityPanel.appendChild(el(`<p class="home-panel-empty">No interactions recorded yet. Real activity will appear here as staff use Office's Oyi chat or the public website's lead-agent widget.</p>`));
  } else {
    activityPanel.appendChild(renderTimeline(traces.slice(0, 12).map(traceToTimelineItem)));
  }
  outlet.appendChild(activityPanel);
}

// ---------------------------------------------------------------
// Nav rendering (permission-aware)
// ---------------------------------------------------------------
function renderNav() {
  const container = document.getElementById("navGroups");
  container.innerHTML = "";
  const primaryVisible = PRIMARY_NAV.filter((item) => hasPermission(item.permission));
  const adminVisible = ADMIN_NAV.filter((item) => hasPermission(item.permission));

  if (primaryVisible.length) {
    const group = el(`<div class="nav-group"><div class="nav-group-label">Operating Areas</div></div>`);
    primaryVisible.forEach((item) => group.appendChild(navButton(item)));
    container.appendChild(group);
  }
  if (adminVisible.length) {
    const group = el(`<div class="nav-group"><div class="nav-group-label">Admin</div></div>`);
    adminVisible.forEach((item) => group.appendChild(navButton(item)));
    container.appendChild(group);
  }
}
function navButton(item) {
  const button = el(`<button class="nav-item" data-nav-key="${item.key}" type="button">${navIconSvg(item.key)}<span>${escapeHtml(item.label)}</span></button>`);
  button.addEventListener("click", () => navigate(item.key));
  return button;
}
function syncNavActiveState() {
  const topKey = state.segments[0];
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.navKey === topKey);
  });
}
function renderUserFooter() {
  if (!state.admin) return;
  const initials = (state.admin.display_name || state.admin.email || "?").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const img = document.getElementById("navAvatarImg");
  const initialsSpan = document.getElementById("navAvatarInitials");
  if (state.admin.passport_photo_url) {
    img.src = state.admin.passport_photo_url;
    img.style.display = "block";
    initialsSpan.style.display = "none";
  } else {
    img.style.display = "none";
    initialsSpan.style.display = "block";
    initialsSpan.textContent = initials || "?";
  }
  const nameEl = document.getElementById("navUserName");
  nameEl.textContent = state.admin.display_name || state.admin.email;
  nameEl.title = state.admin.email || "";
  // Position and system role are deliberately different concepts (see
  // Phase 2) — show both where a position is set, role alone otherwise.
  const roleLabel = (state.admin.role || "").replace(/_/g, " ");
  document.getElementById("navUserRole").textContent = state.admin.office_position
    ? `${state.admin.office_position} · ${titleCase(roleLabel)}`
    : titleCase(roleLabel);
}

// Self-service sidebar photo change — separate from the Team edit row's
// admin-on-someone-else upload. Every signed-in staff member can set
// their own canonical avatar this way.
function wireOwnAvatarUpload() {
  const trigger = document.getElementById("navAvatar");
  const input = document.getElementById("navAvatarInput");
  if (!trigger || !input) return;
  trigger.addEventListener("click", () => input.click());
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const result = await apiUploadMyPhoto(dataUrl);
      state.admin.passport_photo_url = result.passport_photo_url;
      renderUserFooter();
      toast("Photo updated.");
    } catch (err) {
      toast(err.message || "Could not update your photo.");
    }
  });
}

// ---------------------------------------------------------------
// Mobile nav
// ---------------------------------------------------------------
function openNav() {
  document.body.classList.add("nav-open");
}
function closeNav() {
  document.body.classList.remove("nav-open");
}
function closeNavOnMobile() {
  if (window.matchMedia("(max-width: 900px)").matches) closeNav();
}

// ---------------------------------------------------------------
// Persistent Oyi intelligence control — now object-aware. Quick
// prompts are pre-filled text, never independent reasoning: every
// send still goes through the same office_internal endpoint.
// ---------------------------------------------------------------
const QUICK_PROMPTS = {
  lead: ["Which of these require attention today?", "What should I follow up on here?"],
  contact: ["Summarize our relationship with this person.", "Prepare me for the next conversation."],
  organization: ["Prepare me for the next meeting with this company.", "Summarize our relationship with this organization."],
  opportunity: ["What should I follow up on here?", "Summarize this opportunity."],
  project: ["Summarize the current state of this project.", "What needs attention here?", "Prepare me for the next project meeting."],
  portfolio: ["Which parts of this account need Ochiga attention?", "Summarize our relationship with this building."],
  support_case: ["Summarize this case.", "What has already been tried?", "What should we do next?"],
  meeting: ["Prepare me for this meeting.", "Summarize everything relevant about this customer.", "What are the outstanding actions?"],
  private_relationship: ["Summarize this relationship.", "What should we follow up on?", "What interests has this person expressed?", "Prepare me for the next meeting.", "Draft a follow-up."],
  partnership_relationship: ["Summarize our relationship with this partner.", "What is outstanding?", "Prepare me for the next meeting.", "Which projects are connected to this relationship?"],
  document: ["Summarize this document.", "What should happen with this next?"],
  proposal: ["Summarize this proposal.", "What should I follow up on before sending this?"],
};

function updateOyiContext() {
  const contextEl = document.getElementById("oyiContext");
  const quickPromptsEl = document.getElementById("oyiQuickPrompts");
  if (state.selectedObject) {
    contextEl.textContent = `Context: ${state.selectedObject.label}`;
    renderQuickPrompts(QUICK_PROMPTS[state.selectedObject.type] || []);
  } else {
    const item = findNavItem(state.segments[0]) || PRIMARY_NAV[0];
    contextEl.textContent = `Context: ${item.label}`;
    renderQuickPrompts(item.key === "home" ? ["Show me the leads that need attention today.", "Which opportunities haven't been followed up this week?"] : []);
  }
}
function renderQuickPrompts(prompts) {
  const host = document.getElementById("oyiQuickPrompts");
  host.innerHTML = "";
  prompts.forEach((prompt) => {
    const chip = el(`<button type="button" class="quick-prompt">${escapeHtml(prompt)}</button>`);
    chip.addEventListener("click", () => sendOyiMessage(prompt));
    host.appendChild(chip);
  });
  host.style.display = prompts.length ? "flex" : "none";
}

function currentPageContext() {
  const page = state.segments[0] || "home";
  if (state.selectedObject) {
    return { page, selected_type: state.selectedObject.type, selected_id: state.selectedObject.id };
  }
  return { page, selected_type: "", selected_id: "" };
}

// Maps the selected object's safe extraContext (set via renderDetailShell's
// oyiContext, or directly via setSelectedObject for the lighter Task panel)
// onto Ochiga-backend's OfficeInternalOyiCoreRequest slots — crm_context for
// CRM records, portfolio_context for Portfolio (carrying the safe aggregate
// operational_projection, never raw Facility data), support_context for
// Support cases, and one dedicated slot each for Project, Task, Meeting,
// Partnership, Document and Content. Private relationships still reach Oyi
// Core via page_context only, matching upstream's message-based "private"
// attention signal (no dedicated contract slot for that domain).
const SELECTED_TYPE_CONTEXT_KEY = {
  lead: "crm_context",
  contact: "crm_context",
  organization: "crm_context",
  opportunity: "crm_context",
  portfolio: "portfolio_context",
  support_case: "support_context",
  project: "project_context",
  task: "task_context",
  meeting: "meeting_context",
  partnership_relationship: "partnership_context",
  document: "document_context",
  content: "content_context",
};
function currentSelectedObjectContext() {
  const selected = state.selectedObject;
  if (!selected || !selected.extraContext) return {};
  const key = SELECTED_TYPE_CONTEXT_KEY[selected.type];
  return key ? { [key]: selected.extraContext } : {};
}

function appendOyiMessage(role, contentNodeOrText) {
  const thread = document.getElementById("oyiThread");
  const bubble = el(`<div class="oyi-msg ${role}"></div>`);
  if (contentNodeOrText instanceof Node) bubble.appendChild(contentNodeOrText);
  else bubble.textContent = contentNodeOrText;
  thread.appendChild(bubble);
  thread.scrollTop = thread.scrollHeight;
}

// Rich response rendering (Universal Interaction Shell) — renders a
// NormalizedInteractionResponse (see shared/oyi-core/responseNormalizer.mjs)
// rather than sniffing Ochiga Backend's raw response shape by hand.
// The normalizer is the single place that knows OfficeInternalOyiCoreResponse's
// real field names; this function only ever sees the normalized shape,
// so it can't silently drift from what Website's renderer expects too.
const ATTENTION_SIGNAL_LABEL = {
  follow_up: "Follow-up",
  support: "Support",
  project: "Project",
  portfolio: "Portfolio",
  private: "Private",
  partnership: "Partnership",
  handoff: "Handoff",
  meeting: "Meeting",
};
function renderOyiResponse(normalized) {
  const wrap = el(`<div class="oyi-structured"></div>`);

  if (normalized.attentionSignal) {
    wrap.appendChild(
      el(`<div class="oyi-attention-badge">${escapeHtml(ATTENTION_SIGNAL_LABEL[normalized.attentionSignal] || titleCase(normalized.attentionSignal))}</div>`)
    );
  }
  if (normalized.answer) wrap.appendChild(el(`<p>${escapeHtml(normalized.answer)}</p>`));

  if (normalized.suggestions.length) {
    wrap.appendChild(el(`<div class="oyi-block-label">Suggested Next Step</div>`));
    const list = el(`<ul class="oyi-list"></ul>`);
    normalized.suggestions.forEach((suggestion) => list.appendChild(el(`<li>${escapeHtml(suggestion)}</li>`)));
    wrap.appendChild(list);
  }
  if (normalized.knowledgeReferences.length) {
    wrap.appendChild(el(`<div class="oyi-block-label">References</div>`));
    const list = el(`<ul class="oyi-list oyi-references"></ul>`);
    normalized.knowledgeReferences.forEach((ref) =>
      list.appendChild(el(`<li>${escapeHtml(ref.title)}${ref.source ? ` <span class="oyi-reference-source">· ${escapeHtml(ref.source)}</span>` : ""}</li>`))
    );
    wrap.appendChild(list);
  }
  if (!normalized.answer && !wrap.children.length) {
    wrap.appendChild(el(`<p>Oyi Core responded without a readable message field.</p>`));
  }
  return wrap;
}

// Approval Surface (Universal Interaction Shell, Programme 2/3/4) — every
// tool proposal Oyi Core returns is governed "office_validates_before_
// execution" (Ochiga-backend's corporateOfficeInternalPolicy.ts), meaning
// staff review before persistence, not blind auto-execute. For Office's
// higher-stakes proposals (creating a CRM task, drafting a commercial
// document with real pricing) the correct confirmation policy is "review"
// — open the real creation dialog, pre-filled with only what the proposal
// actually supplied, so the existing form validation/permission checks
// still apply and nothing gets created without a human looking at it
// first. This replaces the previous bare "no action was taken" notice.
const TASK_PREFILL_FK_BY_SELECTED_TYPE = {
  lead: "lead_id",
  opportunity: "opportunity_id",
  project: "project_id",
  portfolio: "portfolio_id",
  support_case: "support_case_id",
  partnership_relationship: "partnership_relationship_id",
  private_relationship: "private_relationship_id",
};
function renderApprovalSurface(proposedActions) {
  const wrap = el(`<div class="oyi-structured"></div>`);
  wrap.appendChild(el(`<div class="oyi-block-label">Oyi Proposed</div>`));
  proposedActions.forEach((action) => {
    const row = el(`<div class="oyi-proposal"></div>`);
    row.appendChild(el(`<div class="oyi-proposal-reason">${escapeHtml(action.reason || titleCase(action.tool || action.name || "action"))}</div>`));
    const actionsRow = el(`<div class="oyi-proposal-actions"></div>`);
    const selected = state.selectedObject;
    const fkField = selected ? TASK_PREFILL_FK_BY_SELECTED_TYPE[selected.type] : null;

    if (action.tool === "office.create_followup_task") {
      const btn = el(`<button type="button" class="btn btn-ghost btn-sm">Review &amp; Create Task</button>`);
      btn.addEventListener("click", () => openCreateTaskDialog({
        description: action.reason || "",
        business_unit: action.parameters?.business_unit || "",
        ...(fkField ? { [fkField]: selected.id } : {}),
      }));
      actionsRow.appendChild(btn);
    } else if (action.tool === "office.prepare_commercial_document") {
      const btn = el(`<button type="button" class="btn btn-ghost btn-sm">Review &amp; Create Document</button>`);
      btn.addEventListener("click", () => openCreateDocumentDialog({
        related_type: selected?.type || "",
        related_id: selected?.id || "",
      }));
      actionsRow.appendChild(btn);
    } else if (action.tool === "office.review_meeting_context" && action.parameters?.selected_id) {
      const btn = el(`<button type="button" class="btn btn-ghost btn-sm">View Meeting</button>`);
      btn.addEventListener("click", () => navigate(`meetings/${action.parameters.selected_id}`));
      actionsRow.appendChild(btn);
    } else {
      actionsRow.appendChild(el(`<span class="hint">No in-app review action for "${escapeHtml(action.tool || action.name || "this")}" yet — nothing was created.</span>`));
    }
    row.appendChild(actionsRow);
    wrap.appendChild(row);
  });
  return wrap;
}

// Presence (Universal Interaction Shell) — drives the orb's glow/pulse
// from the shared vocabulary in shared/oyi-core/presence.mjs rather
// than an ad-hoc busy flag, so Office and Website's orbs read the same
// state the same way. Only idle/thinking are reachable from Office's
// text-only composer today; listening/speaking/executing are real
// states the vocabulary already supports for when voice/action-
// execution UI lands here.
function setOyiPresence(nextState) {
  const orb = document.getElementById("oyiBar");
  if (!orb) return;
  orb.classList.remove("presence-idle", "presence-thinking");
  orb.classList.add(`presence-${nextState}`);
}

async function sendOyiMessage(message) {
  if (!message.trim() || state.oyiBusy) return;
  appendOyiMessage("user", message);
  state.oyiBusy = true;
  document.getElementById("oyiSend").disabled = true;
  setOyiPresence("thinking");

  try {
    const data = await api("/api/lead-agents/admin/office/intelligence/chat", {
      method: "POST",
      body: { message, page_context: currentPageContext(), ...currentSelectedObjectContext() },
    });
    const { normalizeOfficeInternalResponse } = await import("/office/shared/oyi-core/responseNormalizer.mjs");
    const normalized = normalizeOfficeInternalResponse(data.oyi_core || {}, data.proposed_actions);
    appendOyiMessage("assistant", renderOyiResponse(normalized));
    if (normalized.toolProposals.length) {
      appendOyiMessage("system", renderApprovalSurface(normalized.toolProposals));
    }
  } catch (err) {
    if (err.status === 503) appendOyiMessage("system", "Oyi Core is unavailable right now. Nothing was answered from a separate reasoning path — please try again shortly.");
    else if (err.status === 403) appendOyiMessage("system", "You don't have permission to use Office intelligence.");
    else appendOyiMessage("system", "Could not reach Oyi. Please try again.");
  } finally {
    state.oyiBusy = false;
    document.getElementById("oyiSend").disabled = false;
    setOyiPresence("idle");
  }
}

function oyiStartThreadIfNeeded() {
  if (!state.oyiThreadStarted) {
    state.oyiThreadStarted = true;
    appendOyiMessage("system", "Ask about what you're looking at, or anything else across Office.");
  }
}

function openOyiPanel() {
  const control = document.getElementById("oyiControl");
  control.classList.remove("minimized");
  control.classList.add("open");
  document.getElementById("oyiBar").setAttribute("aria-expanded", "true");
  positionOyiSurfaces();
  document.getElementById("oyiInput").focus();
  oyiStartThreadIfNeeded();
}

function minimizeOyiPanel() {
  const control = document.getElementById("oyiControl");
  control.classList.remove("open");
  control.classList.add("minimized");
  document.getElementById("oyiBar").setAttribute("aria-expanded", "false");
  positionOyiSurfaces();
}

function closeOyiPanel() {
  const control = document.getElementById("oyiControl");
  control.classList.remove("open", "minimized");
  document.getElementById("oyiBar").setAttribute("aria-expanded", "false");
}

// Edge-docked Universal Interaction Shell orb (Consumer's visual
// basis, red accent here) backed by the shared docking engine
// (docking.mjs, vendored from Ochiga-website's lib/oyi-shell/core —
// see that repo's SYNC.md). Dragging is initiated only from the
// closed-state orb, using Pointer Capture so the drag tracks
// correctly even if the pointer leaves the small circular hit area.
// While dragging, the orb is projected onto whichever screen edge is
// nearest (it never floats into the interior); on release it snaps to
// the closest of the 6 canonical anchors. Position persists in
// localStorage across reloads; docking is desktop-only — below the
// mobile breakpoint the orb stays fixed bottom-right and CSS takes
// over positioning the panel/minimized bar as a bottom sheet.
const OYI_POSITION_KEY = "oyi_orb_anchor";
const OYI_DRAG_THRESHOLD = 4;
const OYI_MOBILE_BREAKPOINT = 640;
const OYI_ORB_SIZE = 54;
const OYI_EDGE_MARGIN = 20;

function oyiDockingEnabled() {
  return window.innerWidth >= OYI_MOBILE_BREAKPOINT;
}

function oyiDockingBounds() {
  const panel = document.getElementById("oyiPanel");
  return {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    size: OYI_ORB_SIZE,
    margin: OYI_EDGE_MARGIN,
    panelWidth: Math.min(400, window.innerWidth - 40),
    panelHeight: Math.min(panel.scrollHeight || 560, 560, window.innerHeight - 120),
    panelGap: 0,
  };
}

// Applies an orb position (top-left, in viewport px) to the orb
// itself, then — if the panel or minimized bar is currently showing —
// repositions it flush against whichever corner of the orb it should
// visually extend from, per openDirection. The panel/minimized bar
// deliberately share the orb's own corner rather than floating beside
// it, so opening/closing reads as one surface changing shape in
// place, matching the reference design.
function applyOyiOrbPosition(x, y, openDirection) {
  const control = document.getElementById("oyiControl");
  control.style.left = `${x}px`;
  control.style.top = `${y}px`;
  control.style.right = "auto";
  control.style.bottom = "auto";
  if (openDirection) positionOyiSurfaces(x, y, openDirection);
}

function positionOyiSurfaces(orbX, orbY, openDirection) {
  const control = document.getElementById("oyiControl");
  if (!oyiDockingEnabled()) return; // CSS media query owns positioning below the breakpoint
  const rect = control.getBoundingClientRect();
  const x = orbX ?? rect.left;
  const y = orbY ?? rect.top;
  const direction = openDirection || state.oyiOpenDirection || { horizontal: "left", vertical: "up" };
  state.oyiOpenDirection = direction;
  [document.getElementById("oyiPanel"), document.getElementById("oyiMinimizedBar")].forEach((surface) => {
    if (direction.horizontal === "right") {
      surface.style.left = `${x}px`;
      surface.style.right = "auto";
    } else {
      surface.style.right = `${window.innerWidth - (x + OYI_ORB_SIZE)}px`;
      surface.style.left = "auto";
    }
    if (direction.vertical === "down") {
      surface.style.top = `${y}px`;
      surface.style.bottom = "auto";
    } else {
      surface.style.bottom = `${window.innerHeight - (y + OYI_ORB_SIZE)}px`;
      surface.style.top = "auto";
    }
  });
}

async function wireOyiControl() {
  const control = document.getElementById("oyiControl");
  const orb = document.getElementById("oyiBar");
  const closeBtn = document.getElementById("oyiClose");
  const minimizeBtn = document.getElementById("oyiMinimize");
  const restoreBtn = document.getElementById("oyiRestore");
  const minimizedCloseBtn = document.getElementById("oyiMinimizedClose");
  const newConversationBtn = document.getElementById("oyiNewConversation");
  const composer = document.getElementById("oyiComposer");
  const input = document.getElementById("oyiInput");

  let docking;
  try {
    docking = await import("/office/shared/oyi-core/docking.mjs");
  } catch {
    docking = null; // Shared core failed to load — orb still opens/closes, just not draggable.
  }

  if (docking && oyiDockingEnabled()) {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(OYI_POSITION_KEY) || "null");
    } catch {
      saved = null;
    }
    if (saved && docking.ANCHOR_IDS.includes(saved.anchor)) {
      const anchors = docking.anchorPositions(oyiDockingBounds());
      const position = anchors[saved.anchor];
      const direction = docking.panelOpenDirection(saved.anchor);
      const vertical =
        direction.vertical === "auto"
          ? docking.resolveVerticalOpenDirection({
              orbY: position.y,
              orbSize: OYI_ORB_SIZE,
              panelHeight: oyiDockingBounds().panelHeight,
              viewportHeight: window.innerHeight,
              gap: 0,
            })
          : direction.vertical;
      applyOyiOrbPosition(position.x, position.y, { horizontal: direction.horizontal, vertical });
    }
  }

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  orb.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    if (!docking || !oyiDockingEnabled()) return;
    dragging = true;
    moved = false;
    const rect = control.getBoundingClientRect();
    startX = event.clientX;
    startY = event.clientY;
    originX = rect.left;
    originY = rect.top;
    orb.setPointerCapture(event.pointerId);
    control.classList.add("dragging");
  });
  orb.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > OYI_DRAG_THRESHOLD) moved = true;
    if (!moved) return;
    const projected = docking.projectToNearestEdge({ x: originX + dx, y: originY + dy }, oyiDockingBounds());
    applyOyiOrbPosition(projected.x, projected.y, null);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    control.classList.remove("dragging");
    if (moved) {
      const rect = control.getBoundingClientRect();
      const resolved = docking.resolveDockedState({ x: rect.left, y: rect.top }, oyiDockingBounds());
      applyOyiOrbPosition(resolved.position.x, resolved.position.y, resolved.openDirection);
      try {
        localStorage.setItem(OYI_POSITION_KEY, JSON.stringify({ anchor: resolved.anchor }));
      } catch {
        // Position just won't persist across reloads — not worth surfacing.
      }
    }
  };
  orb.addEventListener("pointerup", endDrag);
  orb.addEventListener("pointercancel", endDrag);
  orb.addEventListener("click", (event) => {
    if (moved) {
      event.preventDefault();
      moved = false;
      return;
    }
    openOyiPanel();
  });
  window.addEventListener("resize", () => {
    if (!docking || !oyiDockingEnabled()) return;
    const rect = control.getBoundingClientRect();
    const resolved = docking.resolveDockedState({ x: rect.left, y: rect.top }, oyiDockingBounds());
    applyOyiOrbPosition(resolved.position.x, resolved.position.y, resolved.openDirection);
  });

  closeBtn.addEventListener("click", closeOyiPanel);
  minimizedCloseBtn.addEventListener("click", closeOyiPanel);
  minimizeBtn.addEventListener("click", minimizeOyiPanel);
  restoreBtn.addEventListener("click", openOyiPanel);
  newConversationBtn.addEventListener("click", () => {
    document.getElementById("oyiThread").innerHTML = "";
    state.oyiThreadStarted = false;
    oyiStartThreadIfNeeded();
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = input.value;
    input.value = "";
    sendOyiMessage(message);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
}

// ---------------------------------------------------------------
// Notifications — bell + panel, backed by GET .../notifications/mine
// (recipient-targeted rows + broadcasts, never another staff member's)
// and live-updated over the same SSE hub the Oyi control doesn't use
// but the legacy dashboard's inbox did — office.notification events
// only reach this client when it's a broadcast or this session's own
// email is in the trigger's recipient list (see realtime.js).
// ---------------------------------------------------------------
function routeForRelated(relatedType, relatedId) {
  // Keys match server.js's relatedType verbatim — the raw collection
  // name for everything routed through the generic office/crm handlers
  // (projects, portfolio, support, tasks, meetings, private,
  // partnerships), plus the two routes with their own dedicated
  // triggers (task, document).
  const routes = {
    task: `tasks/${relatedId}`,
    support: `support/${relatedId}`,
    projects: `projects/${relatedId}`,
    portfolio: `portfolio/${relatedId}`,
    private: `private/${relatedId}`,
    partnerships: `partnerships/${relatedId}`,
    meetings: `meetings/${relatedId}`,
    document: `documents/library/${relatedId}`,
    lead: `crm/leads/${relatedId}`,
    staff_conversation: `inbox/${relatedId}`,
  };
  return routes[relatedType] || null;
}

function renderNotifBadge() {
  const badge_ = document.getElementById("notifBadge");
  if (!badge_) return;
  if (state.notifUnreadCount > 0) {
    badge_.textContent = state.notifUnreadCount > 99 ? "99+" : String(state.notifUnreadCount);
    badge_.hidden = false;
  } else {
    badge_.hidden = true;
  }
}

function renderNotifPanel() {
  const panel = document.getElementById("notifPanel");
  if (!panel) return;
  panel.innerHTML = "";
  const head = el(`
    <div class="notif-panel-head">
      <h3>Notifications</h3>
      <button type="button" id="notifMarkAllRead">Mark all read</button>
    </div>
  `);
  head.querySelector("#notifMarkAllRead").addEventListener("click", async () => {
    const unread = state.notifications.filter((item) => !item.read_at);
    await Promise.all(unread.map((item) => apiMarkNotificationRead(item.id).catch(() => null)));
    await refreshNotifications();
  });
  panel.appendChild(head);

  if (!state.notifications.length) {
    panel.appendChild(el(`<div class="notif-empty">No notifications yet.</div>`));
    return;
  }

  state.notifications.forEach((item) => {
    const row = el(`
      <div class="notif-item ${item.read_at ? "" : "unread"}">
        <span class="notif-summary">${escapeHtml(item.summary || titleCase(item.type || "notification"))}</span>
        <span class="notif-meta">${escapeHtml(fmtRelative(item.created_at))}</span>
      </div>
    `);
    row.addEventListener("click", async () => {
      if (!item.read_at) {
        try {
          await apiMarkNotificationRead(item.id);
        } catch {
          /* non-fatal — clicking through still works even if the read receipt fails */
        }
      }
      toggleNotifPanel(false);
      const route = routeForRelated(item.related_type, item.related_id);
      if (route) navigate(route);
      await refreshNotifications();
    });
    panel.appendChild(row);
  });
}

async function refreshNotifications() {
  try {
    const data = await apiListMyNotifications();
    state.notifications = data.notifications || [];
    state.notifUnreadCount = data.unread_count || 0;
    renderNotifBadge();
    if (state.notifPanelOpen) renderNotifPanel();
  } catch {
    // Quiet failure — the bell simply doesn't update this cycle rather
    // than interrupting whatever else the user is doing.
  }
}

function toggleNotifPanel(force) {
  const panel = document.getElementById("notifPanel");
  const bell = document.getElementById("notifBell");
  if (!panel || !bell) return;
  const next = force === undefined ? !state.notifPanelOpen : force;
  state.notifPanelOpen = next;
  panel.hidden = !next;
  bell.setAttribute("aria-expanded", String(next));
  if (next) renderNotifPanel();
}

function wireNotifBell() {
  const bell = document.getElementById("notifBell");
  if (!bell) return;
  bell.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleNotifPanel();
  });
  document.addEventListener("click", (event) => {
    const panel = document.getElementById("notifPanel");
    if (state.notifPanelOpen && panel && !panel.contains(event.target) && event.target !== bell) {
      toggleNotifPanel(false);
    }
  });
}

let notifStream = null;
function connectRealtimeStream() {
  if (notifStream) return;
  try {
    notifStream = new EventSource("/api/lead-agents/admin/events");
    notifStream.addEventListener("office.notification", () => {
      refreshNotifications();
    });
    notifStream.addEventListener("office.message", (event) => {
      refreshInboxBadge();
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch {
        payload = null;
      }
      // Live-append if the thread this message belongs to is open right now.
      if (payload && state.segments[0] === "inbox" && state.segments[1] === payload.conversation_id) {
        appendMessageToOpenThread(payload.conversation_id, payload.message);
      }
    });
    notifStream.onerror = () => {
      // EventSource retries on its own; nothing to do here besides not
      // crash the tab if the connection drops.
    };
  } catch {
    notifStream = null;
  }
}

// ---------------------------------------------------------------
// Inbox — staff-to-staff messaging (Phase 5). Deliberately separate
// data model from CRM lead conversations and from Notifications;
// reuses RBAC (messages.read/messages.send), the same realtime hub as
// Notifications (one EventSource, two event types), and the existing
// storage service for attachments.
// ---------------------------------------------------------------
async function refreshInboxBadge() {
  const badge_ = document.getElementById("inboxBadge");
  if (!badge_) return;
  try {
    const data = await apiListConversations();
    const totalUnread = (data.conversations || []).reduce((sum, c) => sum + (c.unread_count || 0), 0);
    if (totalUnread > 0) {
      badge_.textContent = totalUnread > 99 ? "99+" : String(totalUnread);
      badge_.hidden = false;
    } else {
      badge_.hidden = true;
    }
  } catch {
    // Quiet failure, same as the notification badge.
  }
}

function conversationLabel(conversation) {
  if (conversation.title) return conversation.title;
  const others = (conversation.participants || []).filter((email) => email !== state.admin?.email);
  return others.join(", ") || "Conversation";
}

async function renderInboxRoute(outlet, rest, token) {
  const conversationId = rest[0];
  if (conversationId) {
    await renderInboxThread(outlet, conversationId, token);
  } else {
    await renderInboxList(outlet, token);
  }
}

async function renderInboxList(outlet, token) {
  setTopbar("Inbox", "");
  setSelectedObject(null);
  let conversations;
  try {
    const data = await apiListConversations();
    conversations = data.conversations || [];
  } catch (err) {
    if (token !== state.renderToken) return;
    outlet.innerHTML = "";
    outlet.appendChild(el(`<div class="view-heading"><h1>Inbox</h1></div>`));
    outlet.appendChild(errorPanel(err.message || "Could not load your messages."));
    return;
  }
  if (token !== state.renderToken) return;

  outlet.innerHTML = "";
  const heading = el(`
    <div class="view-heading">
      <h1>Inbox</h1>
      <p>Direct and group messages with Office staff.</p>
    </div>
  `);
  outlet.appendChild(heading);

  const newBtn = el(`<button type="button" class="btn btn-primary btn-sm" style="margin-bottom:14px;">New Message</button>`);
  newBtn.addEventListener("click", () => openNewConversationDialog());
  outlet.appendChild(newBtn);

  if (!conversations.length) {
    outlet.appendChild(emptyPanel({ kicker: "Inbox", title: "No conversations yet", body: "Start a conversation with a colleague using New Message." }));
    return;
  }

  const list = el(`<div class="attention-list"></div>`);
  conversations.forEach((conversation) => {
    const preview = conversation.last_message?.body || (conversation.last_message?.attachments?.length ? "Attachment" : "No messages yet");
    const row = el(`
      <div class="attention-row clickable" style="grid-template-columns: 1fr auto 140px;">
        <span class="attention-title">
          <strong>${escapeHtml(conversationLabel(conversation))}</strong>
          <span style="color:var(--text-tertiary);"> — ${escapeHtml(preview.slice(0, 60))}</span>
        </span>
        ${conversation.unread_count ? badge(String(conversation.unread_count), "red") : ""}
        <span class="attention-owner">${escapeHtml(fmtRelative(conversation.last_message_at || conversation.created_at))}</span>
      </div>
    `);
    row.addEventListener("click", () => navigate(`inbox/${conversation.id}`));
    list.appendChild(row);
  });
  outlet.appendChild(list);
}

function openNewConversationDialog() {
  apiListStaffDirectory().then((data) => {
    const staff = data.staff || [];
    openDialog("New Message", [
      {
        name: "participant_email", label: "To", type: "select",
        options: staff.map((s) => ({ value: s.email, label: `${s.display_name}${s.office_position ? ` (${s.office_position})` : ""}` })),
      },
      { name: "body", label: "Message", type: "textarea" },
    ], async (data_) => {
      if (!data_.participant_email) throw new Error("Choose who to message.");
      const { conversation } = await apiCreateConversation([data_.participant_email], "direct");
      if (data_.body && data_.body.trim()) {
        await apiSendMessage(conversation.id, data_.body.trim(), []);
      }
      navigate(`inbox/${conversation.id}`);
    });
  }).catch((err) => toast(err.message || "Could not load the staff directory."));
}

let pendingAttachments = [];
async function renderInboxThread(outlet, conversationId, token) {
  setTopbar("Inbox", "");
  setSelectedObject(null);
  pendingAttachments = [];
  let messages;
  try {
    const data = await apiListConversationMessages(conversationId);
    messages = data.messages || [];
    await apiMarkConversationRead(conversationId);
    refreshInboxBadge();
  } catch (err) {
    if (token !== state.renderToken) return;
    outlet.innerHTML = "";
    outlet.appendChild(el(`<div class="view-heading"><h1>Inbox</h1></div>`));
    outlet.appendChild(err.status === 403 ? errorPanel("You're not part of this conversation.") : errorPanel(err.message || "Could not load this conversation."));
    return;
  }
  if (token !== state.renderToken) return;

  outlet.innerHTML = "";
  const back = el(`<button type="button" class="detail-back">← Inbox</button>`);
  back.addEventListener("click", () => navigate("inbox"));
  outlet.appendChild(back);

  const thread = el(`<div class="oyi-thread" id="inboxThread" style="max-height:60vh;border:1px solid var(--line);border-radius:var(--radius);margin:14px 0;"></div>`);
  messages.forEach((message) => thread.appendChild(renderInboxMessage(message)));
  outlet.appendChild(thread);
  thread.scrollTop = thread.scrollHeight;

  const composer = el(`
    <form class="oyi-composer" id="inboxComposer" style="border:1px solid var(--line);border-radius:var(--radius);">
      <input type="file" id="inboxAttachInput" style="display:none;" multiple />
      <button type="button" class="btn btn-ghost btn-sm" id="inboxAttachBtn" title="Attach file">📎</button>
      <textarea id="inboxComposerText" placeholder="Write a message…" rows="1"></textarea>
      <button type="submit">➤</button>
    </form>
  `);
  const attachList = el(`<div id="inboxAttachList" style="font-size:11px;color:var(--text-tertiary);"></div>`);
  outlet.appendChild(attachList);
  outlet.appendChild(composer);

  composer.querySelector("#inboxAttachBtn").addEventListener("click", () => composer.querySelector("#inboxAttachInput").click());
  composer.querySelector("#inboxAttachInput").addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    for (const file of files) {
      if (file.size > 6 * 1024 * 1024) {
        toast(`${file.name} is too large (6MB max).`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const { file: stored } = await apiUploadAttachment(dataUrl, file.name, file.type);
        pendingAttachments.push({ file_url: stored.url, filename: file.name, mime_type: file.type, size_bytes: file.size });
        attachList.textContent = `Attached: ${pendingAttachments.map((a) => a.filename).join(", ")}`;
      } catch (err) {
        toast(err.message || `Could not attach ${file.name}.`);
      }
    }
  });

  composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const textarea = composer.querySelector("#inboxComposerText");
    const text = textarea.value.trim();
    if (!text && !pendingAttachments.length) return;
    try {
      const { message } = await apiSendMessage(conversationId, text, pendingAttachments);
      thread.appendChild(renderInboxMessage(message));
      thread.scrollTop = thread.scrollHeight;
      textarea.value = "";
      pendingAttachments = [];
      attachList.textContent = "";
    } catch (err) {
      toast(err.message || "Could not send that message.");
    }
  });
  composer.querySelector("#inboxComposerText").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
}

function renderInboxMessage(message) {
  const mine = message.sender_email === state.admin?.email;
  const item = el(`
    <div class="oyi-msg ${mine ? "user" : "assistant"}">
      ${message.body ? `<div>${escapeHtml(message.body)}</div>` : ""}
      ${(message.attachments || []).map((att) => `<div><a href="${escapeHtml(att.file_url)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;">${escapeHtml(att.filename || "Attachment")}</a></div>`).join("")}
      <div style="font-size:10px;opacity:0.6;margin-top:4px;">${escapeHtml(mine ? "You" : message.sender_email)} · ${escapeHtml(fmtRelative(message.created_at))}</div>
    </div>
  `);
  return item;
}

function appendMessageToOpenThread(conversationId, message) {
  const thread = document.getElementById("inboxThread");
  if (!thread || !message) return;
  thread.appendChild(renderInboxMessage(message));
  thread.scrollTop = thread.scrollHeight;
  apiMarkConversationRead(conversationId).then(refreshInboxBadge).catch(() => null);
}

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------
function showShell() {
  document.body.classList.remove("auth-logged-out");
  renderNav();
  renderUserFooter();
  const bell = document.getElementById("notifBell");
  if (bell) {
    bell.style.display = hasPermission("notifications.read") ? "" : "none";
  }
  const inboxBell = document.getElementById("inboxBell");
  if (inboxBell) {
    inboxBell.style.display = hasPermission("messages.read") ? "" : "none";
    if (hasPermission("messages.read")) refreshInboxBadge();
  }
  if (hasPermission("notifications.read")) refreshNotifications();
  if (hasPermission("notifications.read") || hasPermission("messages.read")) connectRealtimeStream();
  state.segments = currentSegmentsFromHash();
  renderRoute();
}
function showLogin() {
  document.body.classList.add("auth-logged-out");
}

function wireLogin() {
  const form = document.getElementById("loginForm");
  const errorBox = document.getElementById("loginError");
  const submit = document.getElementById("loginSubmit");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.classList.remove("visible");
    submit.disabled = true;
    submit.textContent = "Signing in…";
    try {
      await login(document.getElementById("loginEmail").value, document.getElementById("loginPassword").value);
      showShell();
    } catch (err) {
      errorBox.textContent = err.message || "Sign-in failed. Check your email and password.";
      errorBox.classList.add("visible");
    } finally {
      submit.disabled = false;
      submit.textContent = "Sign in";
    }
  });
}
function wireShellChrome() {
  document.getElementById("navLogout").addEventListener("click", async () => {
    await logout();
    showLogin();
  });
  wireOwnAvatarUpload();
  document.getElementById("navToggle").addEventListener("click", openNav);
  document.getElementById("navScrim").addEventListener("click", closeNav);
  wireNotifBell();
  document.getElementById("inboxBell").addEventListener("click", () => navigate("inbox"));
}

// PWA (Programme 14) — app-shell caching only, never API responses; see
// sw.js. Registration failure is silent/non-fatal: the app works
// identically without it, this only affects install-ability/offline
// shell speed.
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/office/sw.js").catch(() => {});
}

async function boot() {
  wireLogin();
  wireShellChrome();
  wireOyiControl();
  registerServiceWorker();
  const authed = await fetchSession();
  if (authed) showShell();
  else showLogin();
}

boot();
