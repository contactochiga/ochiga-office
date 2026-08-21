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
  oyiThreadId: null, // lazily generated on first message; resets on page reload or "New Conversation" — see sendOyiMessage()
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
async function apiCreateLead(body) {
  return api("/api/lead-agents/admin/crm/leads", { method: "POST", body });
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
async function apiListDemos() {
  return api("/api/lead-agents/admin/demos");
}
async function apiGetIntegrations() {
  return api("/api/lead-agents/admin/integrations");
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
// Tasks Domain UI — Automations. Office holds no automation state;
// every call round-trips through Office's own server to Ochiga-
// backend's Shared Automation Runtime (see /api/lead-agents/admin/
// automations* in server.js, and officeExport.ts's /office/automations*
// on the Backend side).
async function apiListAutomations() {
  return api("/api/lead-agents/admin/automations");
}
async function apiGetAutomation(id) {
  return api(`/api/lead-agents/admin/automations/${encodeURIComponent(id)}`);
}
async function apiCreateAutomation(body) {
  return api("/api/lead-agents/admin/automations", { method: "POST", body });
}
async function apiUpdateAutomation(id, patch) {
  return api(`/api/lead-agents/admin/automations/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
}
async function apiDeleteAutomation(id) {
  return api(`/api/lead-agents/admin/automations/${encodeURIComponent(id)}`, { method: "DELETE" });
}
async function apiListAutomationRuns(id) {
  return api(`/api/lead-agents/admin/automations/${encodeURIComponent(id)}/runs`);
}
async function apiTestAutomation(id) {
  return api(`/api/lead-agents/admin/automations/${encodeURIComponent(id)}/test`, { method: "POST" });
}
async function apiGetWorkflow(id) {
  return api(`/api/lead-agents/admin/workflows/${encodeURIComponent(id)}`);
}
async function apiListWorkflows() {
  return api("/api/lead-agents/admin/workflows");
}
async function fetchAutomations(force) {
  const data = await cached("automations", () => apiListAutomations(), force);
  return data.automations || [];
}
async function fetchWorkflows(force) {
  const data = await cached("workflows", () => apiListWorkflows(), force);
  return data.workflows || [];
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

// secondaryActions accepts either the legacy single `secondaryAction`
// object or an array of them (Leads needs My Records + Hide Test +
// Export simultaneously) — both forms render as ghost buttons in order.
function renderToolbar({ query, onQuery, filters, primaryAction, secondaryAction, secondaryActions }) {
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

  const allSecondary = [...(secondaryActions || []), ...(secondaryAction ? [secondaryAction] : [])];
  allSecondary.forEach((action) => {
    const btn = el(`<button type="button" class="btn btn-ghost btn-sm${action.active ? " active" : ""}">${escapeHtml(action.label)}</button>`);
    btn.addEventListener("click", (event) => action.onClick(event));
    bar.appendChild(btn);
  });
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
// Ordered horizontal proportional-width bars — a "funnel" without
// drawing an actual triangle, so it stays honest/legible even with a
// single record (a triangle SVG would look broken with sparse data; a
// width-proportional bar never does). Reusable anywhere Office needs an
// ordered stage/distribution visualization, not just CRM.
// Dependency-free CSS conic-gradient donut + legend. segments/items:
// tone must be one of the existing semantic KPI tones (red/green/amber/
// blue/violet) so charts never introduce a color the rest of Office
// doesn't already use.
const DONUT_TONE_VAR = { red: "--red-bright", green: "--green", amber: "--amber", blue: "--info-blue", violet: "--violet", default: "--line-strong" };
function barDistribution(items, emptyText) {
  const wrap = el(`<div class="bar-distribution"></div>`);
  if (!items.length) {
    wrap.appendChild(el(`<p class="rail-empty">${escapeHtml(emptyText || "No records yet.")}</p>`));
    return wrap;
  }
  const max = Math.max(...items.map((i) => i.count), 1);
  items.forEach((item) => {
    const pct = Math.max(Math.round((item.count / max) * 100), item.count > 0 ? 3 : 0);
    const row = el(`
      <div class="bar-row">
        <span class="bar-row-label">${escapeHtml(item.label)}</span>
        <div class="bar-row-track"><div class="bar-row-fill" style="width:${pct}%;background:var(${DONUT_TONE_VAR[item.tone] || DONUT_TONE_VAR.default});"></div></div>
        <span class="bar-row-count">${escapeHtml(String(item.count))}</span>
      </div>
    `);
    wrap.appendChild(row);
  });
  return wrap;
}
function donutChart(segments, emptyText) {
  const wrap = el(`<div class="donut-chart"></div>`);
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  if (!total) {
    wrap.appendChild(el(`<p class="rail-empty">${escapeHtml(emptyText || "No records yet.")}</p>`));
    return wrap;
  }
  let cursor = 0;
  const stops = segments.filter((s) => s.count > 0).map((s) => {
    const start = (cursor / total) * 360;
    cursor += s.count;
    const end = (cursor / total) * 360;
    return `var(${DONUT_TONE_VAR[s.tone] || DONUT_TONE_VAR.default}) ${start}deg ${end}deg`;
  });
  const ring = el(`<div class="donut-ring" style="background:conic-gradient(${stops.join(",")});"><div class="donut-hole"><span class="donut-total">${total}</span><span class="donut-total-label">Total</span></div></div>`);
  wrap.appendChild(ring);
  const legend = el(`<div class="donut-legend"></div>`);
  segments.filter((s) => s.count > 0).forEach((s) => {
    const pct = Math.round((s.count / total) * 100);
    legend.appendChild(el(`
      <div class="donut-legend-row">
        <span class="donut-swatch" style="background:var(${DONUT_TONE_VAR[s.tone] || DONUT_TONE_VAR.default});"></span>
        <span class="donut-legend-label">${escapeHtml(s.label)}</span>
        <span class="donut-legend-value">${s.count} <span class="donut-legend-pct">(${pct}%)</span></span>
      </div>
    `));
  });
  wrap.appendChild(legend);
  return wrap;
}
// Dependency-free SVG area+line chart — straight segments (not fitted
// curves) so it never implies more precision/smoothness than the real,
// discrete bucketed counts behind it actually have. points: Array<{
// label, value}> already time-ordered. Reusable anywhere Office needs a
// real time-series (Home/Portfolio/Development/Reports later).
function areaChart(points, options = {}) {
  const { height = 200, emptyText = "No data yet.", formatValue = (v) => String(v) } = options;
  const wrap = el(`<div class="area-chart"></div>`);
  if (!points.length || points.every((p) => !p.value)) {
    wrap.appendChild(el(`<p class="rail-empty">${escapeHtml(emptyText)}</p>`));
    return wrap;
  }
  const width = 600;
  const padTop = 12;
  const padBottom = 24;
  const padLeft = 4;
  const padRight = 4;
  const plotHeight = height - padTop - padBottom;
  const max = Math.max(...points.map((p) => p.value), 1);
  const stepX = points.length > 1 ? (width - padLeft - padRight) / (points.length - 1) : 0;
  const coords = points.map((p, i) => {
    const x = padLeft + i * stepX;
    const y = padTop + plotHeight - (p.value / max) * plotHeight;
    return { x, y, ...p };
  });
  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${(padTop + plotHeight).toFixed(1)} L${coords[0].x.toFixed(1)},${(padTop + plotHeight).toFixed(1)} Z`;
  const gridLines = [0, 0.5, 1].map((f) => padTop + plotHeight * f);
  const gridSvg = gridLines.map((y) => `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" class="area-chart-grid" />`).join("");
  const gradientId = `areaFill${Math.random().toString(36).slice(2, 9)}`;
  const svg = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="area-chart-svg">
      <defs>
        <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--red-bright)" stop-opacity="0.35" />
          <stop offset="100%" stop-color="var(--red-bright)" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${gridSvg}
      <path d="${areaPath}" fill="url(#${gradientId})" stroke="none" />
      <path d="${linePath}" fill="none" stroke="var(--red-bright)" stroke-width="2" vector-effect="non-scaling-stroke" />
      ${coords.map((c) => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="2.5" fill="var(--red-bright)" />`).join("")}
    </svg>
  `;
  wrap.appendChild(el(`<div class="area-chart-plot" style="height:${height}px;">${svg}</div>`));
  const axisLabels = [coords[0], coords[Math.floor((coords.length - 1) / 2)], coords[coords.length - 1]];
  const axis = el(`<div class="area-chart-axis"></div>`);
  const seen = new Set();
  axisLabels.forEach((c) => {
    if (seen.has(c.label)) return;
    seen.add(c.label);
    axis.appendChild(el(`<span>${escapeHtml(c.label)}</span>`));
  });
  wrap.appendChild(axis);
  wrap.appendChild(el(`<p class="area-chart-peak">Peak: ${escapeHtml(formatValue(max))}</p>`));
  return wrap;
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
      // A meeting can only become "scheduled" with a real date/time — the
      // backend now enforces this too (scheduled_at_required), this just
      // prompts for it instead of a confusing generic error.
      if (status === "scheduled" && collection === "meetings" && !record.scheduled_at) {
        openDialog("Confirm Meeting Time", [{ name: "scheduled_at", label: "Scheduled At", type: "datetime-local" }], (data) => {
          if (!data.scheduled_at) throw new Error("A scheduled date/time is required to mark this meeting as scheduled.");
          return apply(status, { scheduled_at: new Date(data.scheduled_at).toISOString() });
        });
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
    // Home's own summary stays scoped to Office's local traces only
    // (the same lightweight fetch as before) — the full cross-surface
    // picture, including Consumer/Facility/Website events, lives on the
    // AI Agents page itself, not duplicated here.
    const surfaceCounts = OBSERVATORY_SURFACES.map((surface) => ({
      label: surface.label,
      count: traces.filter((t) => TRACE_SURFACE_KEY_BY_TYPE[t.type] === surface.key).length,
    }));
    // "Active Surfaces" is a genuinely derivable count (surfaces with at
    // least one recorded trace) — not a fabricated "Operational" status.
    const activeSurfaces = surfaceCounts.filter((surface) => surface.count > 0).length;
    panel.appendChild(metricCellGrid([
      { label: "Interactions", value: traces.length, icon: iconSvg("observatory", "kpi-icon"), tone: "blue" },
      { label: "Tool Executions", value: toolExecutions.length, icon: iconSvg("lightning", "kpi-icon"), tone: "violet" },
      { label: "Failures", value: failures, icon: iconSvg("attention", "kpi-icon"), tone: failures > 0 ? "red" : "green" },
      { label: "Active Surfaces", value: `${activeSurfaces} / ${OBSERVATORY_SURFACES.length}`, icon: iconSvg("briefing", "kpi-icon"), tone: "blue" },
    ]));
    // Only the surfaces Office's local traces genuinely cover — the AI
    // Agents page itself shows the full cross-surface picture.
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

// Canonical stage model (CRM production closure pass). Real production
// leads carry stage values from more than one historical intake
// generation (new, intake_received, discovery, sales, proposal, quote,
// negotiation, procurement, won, lost, escalated) — this maps only the
// values whose funnel position is semantically unambiguous. "sales" and
// "escalated" are NOT stage/funnel positions (sales reads as a team/
// routing label that leaked into this column historically; escalated is
// an urgency flag, not a pipeline step) so they are deliberately left
// unmapped rather than guessed — any raw stage value not in this map
// (including a genuinely empty one) is bucketed honestly rather than
// silently dropped or force-fit into an invented funnel.
const LEAD_STAGE_CANON = [
  { key: "unstaged", label: "Unstaged", tone: "default" },
  { key: "new", label: "New", tone: "red" },
  { key: "discovery", label: "Discovery", tone: "amber" },
  { key: "proposal", label: "Proposal", tone: "blue" },
  { key: "negotiation", label: "Negotiation", tone: "violet" },
  { key: "won", label: "Won", tone: "green" },
  { key: "lost", label: "Lost", tone: "default" },
  { key: "other", label: "Other", tone: "default" },
];
const LEAD_STAGE_BUCKET_MAP = {
  new: "new",
  intake_received: "new",
  discovery: "discovery",
  proposal: "proposal",
  quote: "proposal",
  negotiation: "negotiation",
  procurement: "negotiation",
  won: "won",
  lost: "lost",
};
function leadStageBucket(lead) {
  const raw = String(lead.stage || "").trim().toLowerCase();
  if (!raw) return LEAD_STAGE_CANON[0];
  const key = LEAD_STAGE_BUCKET_MAP[raw] || "other";
  return LEAD_STAGE_CANON.find((s) => s.key === key);
}
function leadStageRawLabel(lead) {
  return lead.stage ? titleCase(lead.stage) : (lead.commercial_stage ? titleCase(lead.commercial_stage) : "Unstaged");
}
function leadStageBadge(lead) {
  return badge(leadStageRawLabel(lead), leadStageBucket(lead).tone);
}
function leadIsClosed(lead) {
  const bucket = leadStageBucket(lead).key;
  return bucket === "won" || bucket === "lost";
}

// Real production lead sources (ochiga_website:general_contact,
// ochiga_website_deployment_request, website_widget, website_chat,
// oyi_command_center, smoke_test) plus the LEAD_SOURCES enum
// (commercial-ops.js) for anything normalized to the shorter form.
// Raw value is never altered in the record — this only affects display.
const LEAD_SOURCE_LABELS = {
  "ochiga_website:general_contact": "Ochiga Website",
  ochiga_website_deployment_request: "Deployment Request",
  website_widget: "Website Assistant / Widget",
  website_chat: "Website Chat",
  oyi_command_center: "Oyi Command Center",
  smoke_test: "Internal / Test",
  website: "Website",
  widget: "Widget",
  whatsapp: "WhatsApp",
  linkedin: "LinkedIn",
  meta: "Meta",
  facebook: "Facebook",
  instagram: "Instagram",
  google: "Google",
  referral: "Referral",
  manual: "Manual",
};
function leadSourceLabel(source) {
  if (!source) return "Unknown";
  return LEAD_SOURCE_LABELS[source] || titleCase(String(source).replace(/[:_]/g, " "));
}
// A known-real value, not a heuristic guess — smoke_test is the exact
// source recorded by the platform's own smoke-test script.
function isTestLead(lead) {
  return lead.source === "smoke_test";
}
function leadDisplayName(lead) {
  return lead.name || lead.company || lead.email || lead.phone || "Unnamed Lead";
}
// Real operational criteria, not a hardcoded count: overdue next action,
// escalated, unassigned, or genuinely no follow-up plan at all — never
// applied to a lead that's already won/lost.
function leadNeedsAttention(lead) {
  if (leadIsClosed(lead)) return false;
  if (lead.next_action_at && new Date(lead.next_action_at).getTime() < Date.now()) return true;
  if (/escalated/i.test(String(lead.status || lead.stage || ""))) return true;
  if (!lead.owner) return true;
  if (!lead.next_action && !lead.next_action_at) return true;
  return false;
}
function leadAttentionReasonLabel(lead) {
  if (lead.next_action_at && new Date(lead.next_action_at).getTime() < Date.now()) return "Follow-up overdue";
  if (/escalated/i.test(String(lead.status || lead.stage || ""))) return "Escalated";
  if (!lead.owner) return "Unassigned";
  if (!lead.next_action && !lead.next_action_at) return "No follow-up planned";
  return "";
}
// qualification_status is only ever populated when a lead goes through
// POST /leads/:id/qualify (AI tool-use flow) — most leads may not have
// it set. Falls back to the exact same score thresholds
// commercial-ops.js's qualificationStatus() uses server-side (75/50/25),
// applied client-side only as a display derivation, never a new rule.
function leadQualificationLabel(lead) {
  if (lead.qualification_status) return lead.qualification_status;
  const score = Number(lead.score ?? lead.lead_score);
  if (!Number.isFinite(score)) return null;
  if (score >= 75) return "qualified";
  if (score >= 50) return "needs_discovery";
  if (score >= 25) return "nurture";
  return "unqualified";
}
function leadIsQualified(lead) {
  return leadQualificationLabel(lead) === "qualified";
}

function downloadCsv(filename, columns, rows) {
  const escapeCsv = (value) => {
    const str = String(value ?? "");
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [
    columns.map((c) => escapeCsv(c.label)).join(","),
    ...rows.map((row) => columns.map((c) => escapeCsv(c.value(row))).join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

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
  // Compact tab row only — the standalone "CRM / Manage relationships…"
  // heading block was a duplicate of the Office topbar title set just
  // above and was removed. New Lead lives inline here instead of as a
  // full-width action.
  const tabs = el(`<div class="crm-tabs"></div>`);
  CRM_TABS.forEach((tab) => {
    const tabBtn = el(`<button type="button" class="crm-tab ${tab.key === subKey ? "active" : ""}" data-crm-tab="${tab.key}">${escapeHtml(tab.label)}</button>`);
    tabBtn.addEventListener("click", () => navigate(`crm/${tab.key}`));
    tabs.appendChild(tabBtn);
  });
  if (!objectId && hasPermission("crm.manage")) {
    tabs.appendChild(el(`<div class="crm-tabs-spacer"></div>`));
    const newLeadBtn = el(`<button type="button" class="btn btn-primary btn-sm crm-tabs-action">New Lead +</button>`);
    newLeadBtn.addEventListener("click", () => openCreateLeadDialog());
    tabs.appendChild(newLeadBtn);
  }
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

// Real activity_type values written to crm_activities (see
// office-intake.js, office-tool-governance.js, server.js) mapped to the
// same semantic icon language as Home's Needs Attention / Recent
// Activity rows. "note" and anything unrecognized falls back to a
// generic icon rather than guessing a category.
const CRM_ACTIVITY_META = {
  website_intake_received: { icon: "crm", tone: "violet", label: "Intake" },
  whatsapp_message: { icon: "messages", tone: "green", label: "WhatsApp" },
  email_sent: { icon: "documents", tone: "blue", label: "Email" },
  task_created: { icon: "tasks", tone: "blue", label: "Task" },
  document_draft_requested: { icon: "documents", tone: "blue", label: "Document" },
  note: { icon: "briefing", tone: null, label: "Note" },
};
function crmActivityMeta(activity) {
  return CRM_ACTIVITY_META[activity.activity_type] || { icon: "crm", tone: null, label: titleCase(activity.activity_type || "Activity") };
}

// Overview recomposed onto the Home design template — .home-panel cards,
// the same icon-led row/metric-cell language established on Home, and
// the funnel/donut primitives above. Every figure here is computed from
// the four already-fetched collections plus activities/tasks/meetings —
// no new endpoints, no second aggregation pass on the backend.
async function renderCrmOverview(body, token) {
  setSelectedObject(null);
  const [leads, opportunities, contacts, organizations, activities, tasks, meetings] = await Promise.all([
    fetchLeads().catch(() => []),
    fetchOpportunities().catch(() => []),
    fetchContacts().catch(() => []),
    fetchOrganizations().catch(() => []),
    fetchActivities().catch(() => []),
    hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
    hasPermission("meetings.read") ? fetchMeetings().catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  body.innerHTML = "";

  const realLeads = leads.filter((l) => !isTestLead(l));
  const activeLeads = realLeads.filter((l) => !leadIsClosed(l));
  const qualifiedLeads = realLeads.filter((l) => leadIsQualified(l));
  const attentionLeads = realLeads.filter((l) => leadNeedsAttention(l));
  const wonLeads = realLeads.filter((l) => leadStageBucket(l).key === "won");
  const lostLeads = realLeads.filter((l) => leadStageBucket(l).key === "lost");

  // KPI strip — Active/Qualified/Opportunities/Contacts/Organizations are
  // always real counts (zero is a genuine measured zero here, not a
  // placeholder). Pipeline Value and Average Sales Cycle from the
  // reference are omitted entirely: opportunities carry no value/
  // probability field in this backend (see the Opportunity detail note),
  // and no canonical stage-transition timestamp exists to compute a
  // sales-cycle duration honestly.
  body.appendChild(el(`<div class="home-section"></div>`)).appendChild(KPIGroup([
    { label: "Active Leads", value: activeLeads.length, icon: iconSvg("crm", "kpi-icon"), tone: "red" },
    { label: "Qualified Leads", value: qualifiedLeads.length, icon: iconSvg("attention", "kpi-icon"), tone: "green" },
    { label: "Opportunities", value: opportunities.length, icon: iconSvg("portfolio", "kpi-icon"), tone: "blue" },
    { label: "Contacts", value: contacts.length, icon: iconSvg("team", "kpi-icon"), tone: "violet" },
    { label: "Organizations", value: organizations.length, icon: iconSvg("partnerships", "kpi-icon"), tone: "amber" },
    { label: "Needing Attention", value: attentionLeads.length, icon: iconSvg("attention", "kpi-icon"), tone: "red", alert: attentionLeads.length > 0 },
  ]));

  const rowA = el(`<div class="home-grid"></div>`);
  body.appendChild(rowA);

  // Pipeline Overview — canonical stage buckets (see LEAD_STAGE_CANON),
  // only buckets with a real count render, in funnel order.
  const stageCounts = LEAD_STAGE_CANON.map((s) => ({
    ...s,
    count: realLeads.filter((l) => leadStageBucket(l).key === s.key).length,
  })).filter((s) => s.count > 0);
  const pipelinePanel = homePanel("Pipeline Overview", "View Leads", () => navigate("crm/leads"));
  pipelinePanel.appendChild(barDistribution(stageCounts, "No leads recorded yet."));
  rowA.appendChild(homePanelWrap("span-7", pipelinePanel));

  const sourceCounts = {};
  realLeads.forEach((lead) => { const key = lead.source || ""; sourceCounts[key] = (sourceCounts[key] || 0) + 1; });
  const sourceTones = ["red", "blue", "violet", "green", "amber"];
  const sourceSegments = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([source, count], index) => ({ label: leadSourceLabel(source || null), count, tone: sourceTones[index % sourceTones.length] }));
  const sourcePanel = homePanel("Lead Sources");
  sourcePanel.appendChild(donutChart(sourceSegments, "No leads recorded yet."));
  rowA.appendChild(homePanelWrap("span-5", sourcePanel));

  const rowB = el(`<div class="home-grid"></div>`);
  body.appendChild(rowB);

  const attentionPanel = homePanel(`Leads Needing Attention (${attentionLeads.length})`, "View all", () => navigate("crm/leads"));
  attentionPanel.appendChild(renderDataTable({
    columns: [
      { label: "Lead", render: (l) => escapeHtml(leadDisplayName(l)) },
      { label: "Reason", render: (l) => badge(leadAttentionReasonLabel(l), "red") },
      { label: "Owner", render: (l) => escapeHtml(l.owner || "Unassigned") },
    ],
    rows: attentionLeads.slice(0, 8),
    onRowClick: (lead) => navigate(`crm/leads/${lead.id}`),
    emptyMessage: "No leads currently need attention.",
  }));
  rowB.appendChild(homePanelWrap("span-7", attentionPanel));

  const crmActivities = activities
    .filter((a) => a.lead_id || a.contact_id || a.organization_id || a.opportunity_id)
    .sort((a, b) => String(b.occurred_at || b.created_at || "").localeCompare(String(a.occurred_at || a.created_at || "")))
    .slice(0, 6);
  const interactionsPanel = homePanel("Recent Interactions");
  if (!crmActivities.length) {
    interactionsPanel.appendChild(el(`<p class="home-panel-empty">No recent interactions recorded.</p>`));
  } else {
    const list = el(`<div class="attention-list-v2"></div>`);
    crmActivities.forEach((activity) => {
      const meta = crmActivityMeta(activity);
      list.appendChild(el(`
        <div class="attention-row-v2" style="border-left-color:var(--line-strong);">
          <span class="kpi-icon-box${meta.tone ? ` kpi-icon-${meta.tone}` : ""} attention-row-icon">${iconSvg(meta.icon, "kpi-icon")}</span>
          <div class="attention-row-text">
            <div class="attention-row-title">${escapeHtml(activity.title || meta.label)}</div>
          </div>
          <span class="badge badge-default attention-row-domain">${escapeHtml(meta.label)}</span>
          <span class="attention-row-age">${escapeHtml(fmtRelative(activity.occurred_at || activity.created_at))}</span>
        </div>
      `));
    });
    interactionsPanel.appendChild(list);
  }
  rowB.appendChild(homePanelWrap("span-5", interactionsPanel));

  const rowC = el(`<div class="home-grid"></div>`);
  body.appendChild(rowC);

  const opportunitiesPanel = homePanel("Opportunities", "View all", () => navigate("crm/opportunities"));
  if (!opportunities.length) {
    opportunitiesPanel.appendChild(emptyPanel({
      kicker: "Opportunities",
      title: "No opportunities yet",
      body: "Qualified leads converted into commercial opportunities will appear here.",
    }));
  } else {
    const stageGroups = {};
    opportunities.forEach((opp) => { const stage = opp.stage || "intake_received"; (stageGroups[stage] = stageGroups[stage] || []).push(opp); });
    opportunitiesPanel.appendChild(StageStrip(
      Object.entries(stageGroups).sort((a, b) => b[1].length - a[1].length).map(([stage, items]) => ({ label: titleCase(stage), count: items.length })),
      "No opportunities recorded yet."
    ));
  }
  rowC.appendChild(homePanelWrap("span-6", opportunitiesPanel));

  // Upcoming Follow-ups — real next_action_at on leads, plus CRM-linked
  // tasks/meetings only (lead_id/opportunity_id or related_type in
  // lead/opportunity/contact/organization) so unrelated Office work
  // never leaks into a CRM panel.
  const now = Date.now();
  const followUps = [
    ...realLeads.filter((l) => l.next_action_at).map((l) => ({
      at: l.next_action_at, label: l.next_action || "Follow-up", subject: leadDisplayName(l), route: `crm/leads/${l.id}`,
    })),
    ...tasks.filter((t) => (t.lead_id || t.opportunity_id) && t.due_at && !["done", "completed", "cancelled"].includes(String(t.status || "").toLowerCase())).map((t) => ({
      at: t.due_at, label: t.title, subject: "Task", route: null,
    })),
    ...meetings.filter((m) => ["lead", "opportunity", "contact", "organization"].includes(m.related_type) && m.scheduled_at && !["completed", "cancelled"].includes(String(m.status || "").toLowerCase())).map((m) => ({
      at: m.scheduled_at, label: m.title, subject: "Meeting", route: `meetings/${m.id}`,
    })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(0, 8);
  const followUpsPanel = homePanel("Upcoming Follow-ups");
  if (!followUps.length) {
    followUpsPanel.appendChild(el(`<p class="home-panel-empty">No commercial follow-ups scheduled.</p>`));
  } else {
    const list = el(`<div class="meeting-list"></div>`);
    followUps.forEach((item) => {
      const overdue = new Date(item.at).getTime() < now;
      const row = el(`
        <div class="meeting-row${item.route ? " clickable" : ""}">
          <div class="meeting-when">${overdue ? badge(fmtDateTime(item.at), "red") : escapeHtml(fmtDateTime(item.at))}</div>
          <div class="meeting-title">${escapeHtml(item.label)} <span class="rail-sub">· ${escapeHtml(item.subject)}</span></div>
        </div>
      `);
      if (item.route) row.addEventListener("click", () => navigate(item.route));
      list.appendChild(row);
    });
    followUpsPanel.appendChild(list);
  }
  rowC.appendChild(homePanelWrap("span-6", followUpsPanel));

  const rowD = el(`<div class="home-grid"></div>`);
  body.appendChild(rowD);

  const recentPeople = [...contacts, ...organizations.map((o) => ({ ...o, __org: true }))]
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .slice(0, 6);
  const peoplePanel = homePanel("Contacts & Organizations", "View Contacts", () => navigate("crm/contacts"));
  peoplePanel.appendChild(renderDataTable({
    columns: [
      { label: "Name", render: (r) => escapeHtml(r.name || "Untitled") },
      { label: "Type", render: (r) => badge(r.__org ? "Organization" : "Contact") },
      { label: "Updated", render: (r) => escapeHtml(fmtRelative(r.updated_at)) },
    ],
    rows: recentPeople,
    onRowClick: (r) => navigate(`crm/${r.__org ? "organizations" : "contacts"}/${r.id}`),
    emptyMessage: "No contacts or organizations yet.",
  }));
  rowD.appendChild(homePanelWrap("span-6", peoplePanel));

  // Commercial snapshot — Conversion Rate only renders when there's a
  // real non-zero denominator (won+lost); Won/Lost This Month are always
  // real counts (a genuine zero is a measured zero, not missing data).
  // No Revenue Forecast: no real monetary opportunity data exists.
  const totalClosed = wonLeads.length + lostLeads.length;
  const wonThisMonth = wonLeads.filter((l) => isThisMonth(l.updated_at)).length;
  const lostThisMonth = lostLeads.filter((l) => isThisMonth(l.updated_at)).length;
  const commercialCells = [];
  if (totalClosed > 0) {
    commercialCells.push({ label: "Conversion Rate", value: `${Math.round((wonLeads.length / totalClosed) * 100)}%`, icon: iconSvg("trend", "kpi-icon"), tone: "green" });
  }
  commercialCells.push({ label: "Won This Month", value: wonThisMonth, icon: iconSvg("crm", "kpi-icon"), tone: "green" });
  commercialCells.push({ label: "Lost This Month", value: lostThisMonth, icon: iconSvg("attention", "kpi-icon"), tone: "default" });
  const commercialPanel = homePanel("Commercial Snapshot");
  commercialPanel.appendChild(metricCellGrid(commercialCells));
  if (!totalClosed) {
    commercialPanel.appendChild(el(`<p class="home-panel-empty" style="padding:4px 0 0;">Conversion rate will appear once a lead reaches Won or Lost.</p>`));
  }
  rowD.appendChild(homePanelWrap("span-6", commercialPanel));

  // Workload by Owner — the reference's "Top Performing Agents" would
  // require won/lost-deal outcomes tied to owner + real values, which
  // doesn't exist; ownership/workload distribution is real and
  // operationally useful instead. Grouping by "Unassigned" for a falsy
  // owner also directly answers "how many leads are unassigned?".
  const ownerCounts = {};
  activeLeads.forEach((l) => { const key = l.owner || "Unassigned"; ownerCounts[key] = (ownerCounts[key] || 0) + 1; });
  const rowE = el(`<div class="home-grid"></div>`);
  body.appendChild(rowE);
  const ownerPanel = homePanel("Workload by Owner (Active Leads)");
  ownerPanel.appendChild(barDistribution(
    Object.entries(ownerCounts).sort((a, b) => b[1] - a[1]).map(([owner, count]) => ({ label: owner, count, tone: owner === "Unassigned" ? "red" : "blue" })),
    "No active leads yet."
  ));
  rowE.appendChild(homePanelWrap("span-12", ownerPanel));
}
function isThisMonth(value) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
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
      { label: "Lead", width: "1.5fr", render: (r) => `${escapeHtml(leadDisplayName(r))}${r.company && r.name ? ` <span class="rail-sub">· ${escapeHtml(r.company)}</span>` : ""}` },
      { label: "Stage", render: leadStageBadge },
      {
        label: "Qualification",
        render: (r) => {
          const q = leadQualificationLabel(r);
          if (!q) return "—";
          return badge(titleCase(q), q === "qualified" ? "green" : q === "unqualified" ? "default" : "amber");
        },
      },
      { label: "Source", render: (r) => `${escapeHtml(leadSourceLabel(r.source))}${leadChannelLabel(r) ? ` <span class="rail-sub">· ${escapeHtml(leadChannelLabel(r))}</span>` : ""}` },
      { label: "Owner", render: (r) => escapeHtml(r.owner || "Unassigned") },
      { label: "Last Activity", render: (r) => escapeHtml(fmtRelative(r.updated_at)) },
      { label: "Next Action", render: nextActionCell },
    ],
    exportColumns: [
      { label: "Name", value: (r) => leadDisplayName(r) },
      { label: "Company", value: (r) => r.company || "" },
      { label: "Email", value: (r) => r.email || "" },
      { label: "Phone", value: (r) => r.phone || "" },
      { label: "Stage", value: (r) => leadStageRawLabel(r) },
      { label: "Qualification", value: (r) => leadQualificationLabel(r) || "" },
      { label: "Source", value: (r) => leadSourceLabel(r.source) },
      { label: "Owner", value: (r) => r.owner || "" },
      { label: "Business Unit", value: (r) => r.business_unit || "" },
      { label: "Next Action", value: (r) => r.next_action || "" },
      { label: "Next Action At", value: (r) => r.next_action_at || "" },
      { label: "Created", value: (r) => r.created_at || "" },
      { label: "Updated", value: (r) => r.updated_at || "" },
    ],
    filters: [{ key: "business_unit", label: "Business Unit" }, { key: "stage", label: "Stage" }],
  },
  contacts: {
    fetch: fetchContacts,
    manage: "crm.manage",
    searchFields: ["name", "email", "phone"],
    // The "Contact" column carries email+phone as a subline (same
    // compression pattern as Leads' name+company) so the row stays
    // scannable — Organization is prepended dynamically in
    // renderCrmList (needs an org-id lookup fetched alongside
    // contacts). Source stays available on the detail page rather than
    // adding an 8th column here.
    columns: [
      { label: "Contact", width: "1.4fr", render: (r) => `${escapeHtml(r.name || "Untitled")}${r.email || r.phone ? ` <span class="rail-sub">· ${escapeHtml(r.email || r.phone)}</span>` : ""}` },
      { label: "Role", render: (r) => escapeHtml(r.role || "—") },
      { label: "Business Unit", render: (r) => escapeHtml(titleCase(r.business_unit)) },
      { label: "Owner", render: (r) => escapeHtml(r.owner || "Unassigned") },
      { label: "Status", render: (r) => badge(titleCase(r.status || "active"), toneForStatus(r.status || "active")) },
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
    emptyMessage: "No organizations yet. Organizations linked to CRM contacts and commercial relationships will appear here.",
  },
  opportunities: {
    fetch: fetchOpportunities,
    manage: "crm.manage",
    searchFields: ["inquiry_type", "pipeline"],
    // No Value/Probability/Expected Close columns — this backend has no
    // such fields on crm_opportunities (see the detail page's own note).
    // Account/Contact is prepended dynamically in renderCrmList via the
    // same contact/organization lookup used on Contacts.
    columns: [
      { label: "Opportunity", width: "1.3fr", render: (r) => escapeHtml(titleCase(r.inquiry_type || "General Enquiry")) },
      { label: "Stage", render: (r) => badge(titleCase(r.stage), toneForStatus(r.stage)) },
      { label: "Business Unit", render: (r) => escapeHtml(titleCase(r.business_unit)) },
      { label: "Owner", render: (r) => escapeHtml(r.owner || "Unassigned") },
      { label: "Updated", render: (r) => escapeHtml(fmtRelative(r.updated_at)) },
    ],
    filters: [{ key: "business_unit", label: "Business Unit" }, { key: "stage", label: "Stage" }],
    emptyMessage: "No opportunities yet. Qualified leads converted into commercial opportunities will appear here.",
  },
};

// Compact real metrics strip above the Leads table — same
// metricCellGrid language as Overview/Home, always computed from
// non-test leads regardless of the table's own Hide Test Records
// toggle state, matching Overview's own convention.
function leadsMetricsStrip(records) {
  const real = records.filter((l) => !isTestLead(l));
  const active = real.filter((l) => !leadIsClosed(l));
  const attention = real.filter((l) => leadNeedsAttention(l));
  const qualified = real.filter((l) => leadIsQualified(l));
  const unassigned = active.filter((l) => !l.owner);
  const weekAgo = Date.now() - 7 * 86400000;
  const recentlyAdded = real.filter((l) => l.created_at && new Date(l.created_at).getTime() >= weekAgo);
  const wrap = el(`<div class="crm-metrics-strip"></div>`);
  wrap.appendChild(metricCellGrid([
    { label: "Active Leads", value: active.length, icon: iconSvg("crm", "kpi-icon"), tone: "red" },
    { label: "Needing Attention", value: attention.length, icon: iconSvg("attention", "kpi-icon"), tone: "red" },
    { label: "Qualified", value: qualified.length, icon: iconSvg("attention", "kpi-icon"), tone: "green" },
    { label: "Unassigned", value: unassigned.length, icon: iconSvg("team", "kpi-icon"), tone: "amber" },
    { label: "Added This Week", value: recentlyAdded.length, icon: iconSvg("trend", "kpi-icon"), tone: "blue" },
  ]));
  return wrap;
}

function contactsMetricsStrip(records, organizations) {
  const linked = records.filter((c) => c.organization_id).length;
  const weekAgo = Date.now() - 7 * 86400000;
  const addedThisWeek = records.filter((c) => c.created_at && new Date(c.created_at).getTime() >= weekAgo).length;
  const wrap = el(`<div class="crm-metrics-strip"></div>`);
  wrap.appendChild(metricCellGrid([
    { label: "Total Contacts", value: records.length, icon: iconSvg("team", "kpi-icon"), tone: "violet" },
    { label: "Linked to Organization", value: linked, icon: iconSvg("partnerships", "kpi-icon"), tone: "blue" },
    { label: "Added This Week", value: addedThisWeek, icon: iconSvg("trend", "kpi-icon"), tone: "green" },
  ]));
  return wrap;
}

async function renderCrmList(body, key, token) {
  setSelectedObject(null);
  const config = CRM_LIST_CONFIG[key];
  const records = await config.fetch();
  if (token !== state.renderToken) return;

  let columns = config.columns;
  if (key === "leads" && body.parentElement) {
    body.parentElement.insertBefore(leadsMetricsStrip(records), body);
  }
  if (key === "contacts") {
    const organizations = await fetchOrganizations().catch(() => []);
    if (token !== state.renderToken) return;
    const orgById = Object.fromEntries(organizations.map((o) => [o.id, o]));
    columns = [
      { label: "Organization", render: (r) => escapeHtml(r.organization_id && orgById[r.organization_id] ? orgById[r.organization_id].name : "—") },
      ...config.columns,
    ];
    if (body.parentElement) body.parentElement.insertBefore(contactsMetricsStrip(records, organizations), body);
  }
  if (key === "opportunities") {
    const [contacts, organizations] = await Promise.all([fetchContacts().catch(() => []), fetchOrganizations().catch(() => [])]);
    if (token !== state.renderToken) return;
    const contactById = Object.fromEntries(contacts.map((c) => [c.id, c]));
    const orgById = Object.fromEntries(organizations.map((o) => [o.id, o]));
    columns = [
      { label: "Account / Contact", render: (r) => escapeHtml((r.organization_id && orgById[r.organization_id]?.name) || (r.contact_id && contactById[r.contact_id]?.name) || "—") },
      ...config.columns,
    ];
  }

  const listState = { hideTest: key === "leads" };
  function currentPreFilter(r) {
    return key === "leads" && listState.hideTest ? !isTestLead(r) : true;
  }

  const secondaryActions = [];
  if (key === "leads") {
    secondaryActions.push({
      label: "Hide Test Records",
      active: true,
      onClick: (event) => {
        listState.hideTest = !listState.hideTest;
        event.target.classList.toggle("active", listState.hideTest);
        rerender();
      },
    });
    secondaryActions.push({
      label: "Export",
      onClick: () => downloadCsv(`ochiga-leads-${new Date().toISOString().slice(0, 10)}.csv`, config.exportColumns, records.filter(currentPreFilter)),
    });
  }

  function rerender() {
    renderStandardList(body, {
      title: titleCase(key),
      records,
      columns,
      searchFields: config.searchFields,
      filters: config.filters,
      canManage: hasPermission(config.manage),
      onCreate: key === "leads" ? () => openCreateLeadDialog() : () => openCreateDialog(key),
      onRowClick: (row) => navigate(`crm/${key}/${row.id}`),
      emptyMessage: config.emptyMessage || "No records yet.",
      preFilter: currentPreFilter,
      secondaryActions: secondaryActions.length ? secondaryActions : undefined,
    });
  }
  rerender();
}

// ---------------------------------------------------------------
// Shared list primitive — a permission-aware, searchable/filterable
// table with an optional "My Records" toggle and "New" action. Used
// by CRM (above) and every Phase 3 module (Projects/Portfolio/
// Support/Tasks/Meetings) below, so every list in Office behaves
// identically.
// ---------------------------------------------------------------
const LIST_PAGE_SIZE = 20;
// Real client-side pagination — every list here already loads its full
// collection up front (no server-side paging endpoint exists), so this
// slices the already-filtered rows rather than adding fake page controls
// that don't do anything.
function renderPaginationControls(page, totalPages, onChange) {
  const wrap = el(`<div class="pagination"></div>`);
  const prev = el(`<button type="button" class="btn btn-ghost btn-sm" ${page <= 1 ? "disabled" : ""}>‹</button>`);
  prev.addEventListener("click", () => onChange(page - 1));
  wrap.appendChild(prev);
  const maxButtons = 7;
  const pages = [];
  if (totalPages <= maxButtons) {
    for (let p = 1; p <= totalPages; p += 1) pages.push(p);
  } else {
    pages.push(1);
    if (page > 3) pages.push("…");
    for (let p = Math.max(2, page - 1); p <= Math.min(totalPages - 1, page + 1); p += 1) pages.push(p);
    if (page < totalPages - 2) pages.push("…");
    pages.push(totalPages);
  }
  pages.forEach((p) => {
    if (p === "…") {
      wrap.appendChild(el(`<span class="pagination-ellipsis">…</span>`));
      return;
    }
    const btn = el(`<button type="button" class="pagination-page${p === page ? " active" : ""}">${p}</button>`);
    btn.addEventListener("click", () => onChange(p));
    wrap.appendChild(btn);
  });
  const next = el(`<button type="button" class="btn btn-ghost btn-sm" ${page >= totalPages ? "disabled" : ""}>›</button>`);
  next.addEventListener("click", () => onChange(page + 1));
  wrap.appendChild(next);
  return wrap;
}

function renderStandardList(body, { title, records, columns, searchFields, filters, canManage, onCreate, onRowClick, emptyMessage, secondaryAction, secondaryActions, ownerField, preFilter, pageSize = LIST_PAGE_SIZE }) {
  const listState = { query: "", filters: {}, mineOnly: false, page: 1 };

  function draw() {
    let rows = preFilter ? records.filter(preFilter) : records;
    if (listState.mineOnly) rows = rows.filter((r) => isMine(ownerField ? r[ownerField] : (r.owner || r.assignee)));
    Object.entries(listState.filters).forEach(([field, value]) => {
      if (value) rows = rows.filter((r) => String(r[field] || "") === value);
    });
    if (listState.query) {
      const q = listState.query.toLowerCase();
      rows = rows.filter((r) => searchFields.some((field) => String(r[field] || "").toLowerCase().includes(q)));
    }
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    if (listState.page > totalPages) listState.page = totalPages;
    const pageRows = rows.slice((listState.page - 1) * pageSize, listState.page * pageSize);
    resultsHost.innerHTML = "";
    resultsHost.appendChild(renderDataTable({
      columns,
      rows: pageRows,
      onRowClick,
      emptyMessage: records.length ? "No records match your filters." : (emptyMessage || "No records yet."),
    }));
    countLabel.textContent = `${rows.length} of ${records.length}`;
    paginationHost.innerHTML = "";
    if (rows.length > pageSize) {
      paginationHost.appendChild(renderPaginationControls(listState.page, totalPages, (p) => {
        listState.page = p;
        draw();
      }));
    }
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
      listState.page = 1;
      draw();
    },
  }));

  const toolbar = renderToolbar({
    query: listState.query,
    onQuery: (value) => {
      listState.query = value;
      listState.page = 1;
      draw();
    },
    filters: filterDefs,
    secondaryAction: secondaryAction === null ? null : (secondaryAction || {
      label: "My Records",
      onClick: (event) => {
        listState.mineOnly = !listState.mineOnly;
        event.target.classList.toggle("active", listState.mineOnly);
        listState.page = 1;
        draw();
      },
    }),
    secondaryActions,
    primaryAction: canManage && onCreate ? { label: "New", onClick: onCreate } : null,
  });
  body.appendChild(toolbar);

  const resultsHost = el(`<div class="crm-results"></div>`);
  body.appendChild(resultsHost);
  const paginationHost = el(`<div></div>`);
  body.appendChild(paginationHost);
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

// Progressive disclosure (CRM production closure pass) — the primary
// schema has ~40 columns; the always-visible fact-grid stays to the
// fields useful at a glance, everything else groups into a collapsible
// <details> section per category, and a category simply doesn't render
// if none of its fields are actually populated on this record (never a
// grid of dashes).
function factsIfPresent(pairs) {
  return pairs.filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "");
}
function renderLeadDetailGroup(title, pairs) {
  const present = factsIfPresent(pairs);
  if (!present.length) return null;
  const details = el(`<details class="detail-section detail-collapsible"><summary><h3>${escapeHtml(title)}</h3></summary></details>`);
  const grid = el(`<div class="fact-grid"></div>`);
  present.forEach(([label, value]) => grid.appendChild(el(factRow(label, value))));
  details.appendChild(grid);
  return details;
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

  const [activities, tasks, projects, organizations, opportunities] = await Promise.all([
    fetchActivities().catch(() => []),
    hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
    fetchOrganizations().catch(() => []),
    fetchOpportunities().catch(() => []),
  ]);
  if (token !== state.renderToken) return;
  const ownActivities = activities.filter((a) => a.lead_id === id);
  const ownTasks = tasks.filter((t) => t.lead_id === id);
  const linkedProject = projects.find((p) => p.lead_id === id);
  const linkedOrganization = organizations.find((o) => o.id === record.organization_id);
  const linkedOpportunity = opportunities.find((o) => o.id === record.opportunity_id) || opportunities.find((o) => o.lead_id === id);
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
  const qualification = leadQualificationLabel(record);

  const mainSections = [];
  mainSections.push(el(`
    <div class="detail-section">
      <h3>Relationship Summary</h3>
      <div class="fact-grid">
        ${factRow("Email", record.email)}
        ${factRow("Phone", record.phone)}
        ${factRowHtml("Stage", leadStageBadge(record))}
        ${factRow("Business Unit", titleCase(record.business_unit))}
        ${factRow("Source", `${leadSourceLabel(record.source)}${channelLabel ? ` · ${channelLabel}` : ""}`)}
        ${factRow("Owner", record.owner || "Unassigned")}
        ${factRow("Last Communication", lastCommunicationAt ? fmtRelative(lastCommunicationAt) : "No recorded contact yet")}
        ${factRow("Last Contact (Logged)", record.last_contact_at ? fmtRelative(record.last_contact_at) : null)}
        ${factRowHtml("Next Action", nextActionCell(record))}
        ${factRow("Summary", record.summary)}
      </div>
    </div>
  `));
  if (isTestLead(record)) {
    mainSections.push(el(`<p class="home-panel-empty" style="padding:0;">This lead's source is "smoke_test" — treated as an internal/test record and hidden from Overview KPIs and Pipeline by default.</p>`));
  }
  if (canManage) mainSections.push(renderLeadUpdateForm(record));

  const identityGroup = renderLeadDetailGroup("Identity", [
    ["WhatsApp", record.whatsapp_phone],
    ["Role", record.role],
    ["Location", [record.city, record.country].filter(Boolean).join(", ") || record.location],
  ]);
  if (identityGroup) mainSections.push(identityGroup);

  const commercialGroup = renderLeadDetailGroup("Commercial", [
    ["Status", record.status],
    ["Score", Number.isFinite(Number(record.score ?? record.lead_score)) ? Number(record.score ?? record.lead_score) : null],
    ["Qualification", qualification ? titleCase(qualification) : null],
    ["Inquiry Type", record.inquiry_type],
    ["Interest Package", record.interest_package],
    ["Budget Range", record.budget_range],
    ["Timeline", record.timeline],
    ["Decision Maker", record.decision_maker_status],
    ["Property Type", record.property_type],
    ["Property Size", record.property_size],
    ["Unit Count", record.unit_count ?? record.number_of_units],
    ["Lost Reason", record.lost_reason],
  ]);
  if (commercialGroup) mainSections.push(commercialGroup);

  const sourceGroup = renderLeadDetailGroup("Source Detail", [
    ["Primary Channel", record.primary_channel],
    ["Source Channel", record.source_channel],
    ["Raw Source", record.source],
    ["Source Site", record.source_site],
    ["Source Page", record.source_page],
    ["Source Form", record.source_form],
  ]);
  if (sourceGroup) mainSections.push(sourceGroup);

  const intelligenceGroup = renderLeadDetailGroup("Intelligence / Context", [
    ["Pain Points", record.pain_points],
    ["Notes", record.notes],
  ]);
  if (intelligenceGroup) mainSections.push(intelligenceGroup);

  const systemGroup = renderLeadDetailGroup("System", [
    ["Created", record.created_at ? fmtDateTime(record.created_at) : null],
    ["Updated", record.updated_at ? fmtDateTime(record.updated_at) : null],
  ]);
  if (systemGroup) mainSections.push(systemGroup);

  if (conversations.length) mainSections.push(renderChannelThreadSection(conversations));
  mainSections.push(renderTimeline(combinedTimeline, {
    canAddNote: canManage,
    onAddNote: () => promptAddNote({ lead_id: id }),
  }));

  const railSections = [];
  if (linkedOrganization) railSections.push(railCard("Organization", `<a href="#/crm/organizations/${linkedOrganization.id}">${escapeHtml(linkedOrganization.name)}</a>`));
  if (linkedOpportunity) railSections.push(railCard("Opportunity", `<a href="#/crm/opportunities/${linkedOpportunity.id}">${escapeHtml(titleCase(linkedOpportunity.inquiry_type || "Opportunity"))}</a> <span class="rail-sub">${escapeHtml(titleCase(linkedOpportunity.stage))}</span>`));
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
    label: leadDisplayName(record),
    typeLine: `Lead · ${titleCase(record.business_unit)}`,
    badges: [leadStageBadge(record), badge(record.owner || "Unassigned")],
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

// Real production stage vocabulary (see LEAD_STAGE_CANON's mapping
// comment) offered as select options — not the largely-unused
// PIPELINE_STAGES enum from commercial-ops.js — plus the record's own
// current raw value so an unrecognized historical value is never
// silently dropped from the dropdown.
const LEAD_STAGE_OPTIONS = ["new", "intake_received", "discovery", "sales", "proposal", "quote", "negotiation", "procurement", "won", "lost", "escalated"];
function renderLeadUpdateForm(record) {
  const section = el(`<div class="detail-section"><h3>Update</h3></div>`);
  const stageOptions = record.stage && !LEAD_STAGE_OPTIONS.includes(record.stage)
    ? [record.stage, ...LEAD_STAGE_OPTIONS]
    : LEAD_STAGE_OPTIONS;
  const form = el(`
    <form class="inline-form">
      <label>Stage
        <select name="stage">
          <option value="">—</option>
          ${stageOptions.map((s) => `<option value="${escapeHtml(s)}"${s === record.stage ? " selected" : ""}>${escapeHtml(titleCase(s))}</option>`).join("")}
        </select>
      </label>
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
        stage: formData.get("stage") || null,
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

// Minimum useful fields for a manually-created lead — matches
// POST /api/lead-agents/admin/crm/leads' real accepted fields
// (normalizeLeadInput). Enrichment (score, qualification, additional
// commercial fields) happens from the lead detail page afterward.
function openCreateLeadDialog() {
  openDialog("New Lead", [
    { name: "name", label: "Name" },
    { name: "company", label: "Company" },
    { name: "email", label: "Email", type: "email" },
    { name: "phone", label: "Phone" },
    { name: "business_unit", label: "Business Unit" },
    { name: "inquiry_type", label: "Inquiry Type" },
    { name: "owner", label: "Owner" },
    { name: "summary", label: "Summary / Need", type: "textarea" },
    { name: "next_action", label: "Next Action" },
  ], async (data) => {
    if (!data.name && !data.company) throw new Error("Name or Company is required.");
    const { lead } = await apiCreateLead(data);
    invalidate("leads");
    navigate(`crm/leads/${lead.id}`);
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
    oyiContext: portfolioOyiContext(record),
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

// Structured sibling of portfolioOyiSafeSummary — same fields, plus
// projection_state derived with the EXACT same 3-branch logic as the
// safe_summary above (linked/unavailable/not_linked), so Oyi's Portfolio
// capability module can answer honestly about which of those three real
// states applies instead of treating "no operational numbers" as one
// undifferentiated blank. homes/devices/escalation counts are only ever
// sent when genuinely linked — never guessed for the other two states.
function portfolioOyiContext(record) {
  const projection = record.operational_projection;
  const projectionState = projection && projection.linked ? "linked" : projection && projection.available === false ? "unavailable" : "not_linked";
  return {
    portfolio_ref: record.id,
    backend_building_ref: record.backend_building_id || record.backend_estate_id || null,
    safe_summary: portfolioOyiSafeSummary(record),
    name: record.name || null,
    relationship_type: record.relationship_type || null,
    business_unit: record.business_unit || null,
    status: record.status || null,
    oyi_deployment_status: record.oyi_deployment_status || null,
    facility_os_status: record.facility_os_status || null,
    consumer_os_status: record.consumer_os_status || null,
    support_status: record.support_status || null,
    health_summary: record.health_summary || null,
    major_escalations: Number.isFinite(Number(record.major_escalations)) ? Number(record.major_escalations) : null,
    projection_state: projectionState,
    homes_total: projectionState === "linked" ? projection.homes_total ?? null : null,
    homes_active: projectionState === "linked" ? projection.homes_active ?? null : null,
    devices_total: projectionState === "linked" ? projection.devices_total ?? null : null,
    devices_online: projectionState === "linked" ? projection.devices_online ?? null : null,
    major_open_escalations: projectionState === "linked" ? projection.major_open_escalations ?? null : null,
  };
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

// Structured context for Oyi's Support capability module — same
// underlying fields already rendered on this page's Case Summary
// section, machine-readable, so the capability can answer a specific
// sub-question (customer/severity/category/SLA/resolution/assignee)
// instead of only ever echoing the whole safe_summary string.
function supportOyiContext(record, { contact, org } = {}) {
  return {
    support_case_ref: record.id,
    safe_summary: `${record.title || "Support case"} · ${titleCase(record.status || "")} · ${titleCase(record.severity || "")} · ${titleCase(record.category || "")}`.trim(),
    title: record.title || null,
    status: record.status || null,
    severity: record.severity || null,
    category: record.category || null,
    product_area: record.product_area || null,
    assigned_staff: record.assigned_staff || null,
    sla_target_at: record.sla_target_at || null,
    resolution_notes: record.resolution_notes || null,
    customer_name: contact ? contact.name : null,
    organization_name: org ? org.name : null,
  };
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
    oyiContext: supportOyiContext(record, { contact, org }),
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

  function enrich(list) {
    const now = Date.now();
    return list.map((t) => {
      const relation = resolveTaskRelation(t, index);
      const overdue = Boolean(t.due_at) && !t.completed_at && new Date(t.due_at).getTime() < now && !["done", "completed", "cancelled"].includes(String(t.status || "").toLowerCase());
      return { ...t, __relation: relation, __related_type: relation ? relation.type : "", __overdue: overdue };
    });
  }
  let enriched = enrich(tasks);

  const listState = { query: "", quick: "open", businessUnit: "", relatedType: "", selectedId: null };

  outlet.innerHTML = "";
  const layout = el(`<div class="split-layout"></div>`);
  const mainCol = el(`<div class="split-main"></div>`);
  layout.appendChild(mainCol);
  outlet.appendChild(layout);

  const heading = el(`<div class="view-heading"><h1>Tasks</h1><span class="count-pill"></span></div>`);
  mainCol.appendChild(heading);
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
  mainCol.appendChild(toolbar);

  const quickBar = el(`<div class="list-toolbar quick-filters"></div>`);
  const quickButtons = {};
  [["open", "Open"], ["mine", "Mine"], ["overdue", "Overdue"], ["completed", "Completed"], ["all", "All"]].forEach(([key, label]) => {
    const btn = el(`<button type="button" class="btn btn-ghost btn-sm">${escapeHtml(label)}</button>`);
    btn.addEventListener("click", () => { listState.quick = key; syncQuickButtons(); draw(); });
    quickButtons[key] = btn;
    quickBar.appendChild(btn);
  });
  mainCol.appendChild(quickBar);
  function syncQuickButtons() {
    Object.entries(quickButtons).forEach(([key, btn]) => btn.classList.toggle("active", key === listState.quick));
  }
  syncQuickButtons();

  const resultsHost = el(`<div class="crm-results"></div>`);
  mainCol.appendChild(resultsHost);

  function selectTask(id) {
    listState.selectedId = id;
    let panel = layout.querySelector(".split-panel");
    if (!panel) {
      panel = el(`<div class="split-panel"></div>`);
      layout.appendChild(panel);
    }
    panel.innerHTML = "";
    panel.appendChild(skeletonPanel(3));
    const task = enriched.find((t) => t.id === id);
    if (!task) return;
    setSelectedObject("task", id, task.title, taskOyiContext(task));
    renderTaskDetailPanel(panel, task, {
      onClose: () => { listState.selectedId = null; setSelectedObject(null); panel.remove(); },
      onChanged: () => refresh(),
    });
  }

  async function refresh() {
    const fresh = await fetchTasks(true);
    if (token !== state.renderToken) return;
    enriched = enrich(fresh);
    draw();
    if (listState.selectedId && enriched.some((t) => t.id === listState.selectedId)) selectTask(listState.selectedId);
    else {
      const panel = layout.querySelector(".split-panel");
      if (panel) panel.remove();
    }
  }

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
      ],
      rows,
      onRowClick: (t) => selectTask(t.id),
      emptyMessage: enriched.length ? "No tasks match your filters." : "No tasks yet.",
    }));
    countLabel.textContent = `${rows.length} of ${enriched.length}`;
  }
  draw();
}

// Read-only-plus-status-actions detail panel for a task, opened from
// the Tasks tab's list. Related-object link is a link-out (navigates
// away), never a duplicate editing surface for the parent record.
// Audit tab reuses the same real /admin/audit endpoint and target_type
// convention the backend already writes on every crm_tasks
// create/update (see appendAudit(..., "tasks", record.id, ...) in
// server.js) — the same pattern as the Automations detail panel's
// Audit Log tab, just a different target_type.
async function renderTaskDetailPanel(panel, task, { onClose, onChanged }) {
  const panelState = { tab: "overview" };

  function factRowEl(label, value) {
    return el(`<div class="split-fact-row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value || "—")}</span></div>`);
  }

  function renderOverviewTab() {
    const wrap = el(`<div></div>`);
    const section = el(`<div class="split-panel-section"><h4>Details</h4></div>`);
    section.appendChild(factRowEl("Priority", titleCase(task.priority)));
    section.appendChild(factRowEl("Assignee", task.assignee || "Unassigned"));
    section.appendChild(factRowEl("Due", task.due_at ? fmtDate(task.due_at) : "—"));
    section.appendChild(factRowEl("Business Unit", titleCase(task.business_unit)));
    if (task.description) section.appendChild(factRowEl("Description", task.description));
    wrap.appendChild(section);

    const relSection = el(`<div class="split-panel-section"><h4>Related Record</h4></div>`);
    if (task.__relation) {
      relSection.appendChild(factRowEl("Type", task.__relation.type));
      relSection.appendChild(factRowEl("Record", task.__relation.name || "—"));
    } else {
      relSection.appendChild(el(`<p class="rail-empty">Not linked to a Lead, Opportunity, Project, Portfolio, Support case, Private relationship or Partnership.</p>`));
    }
    wrap.appendChild(relSection);
    return wrap;
  }

  function renderAuditTab() {
    if (!hasPermission("view_audit")) {
      return emptyPanel({ kicker: "Audit Log", title: "Restricted", body: "You don't have permission to view the audit log." });
    }
    const host = el(`<div></div>`);
    host.appendChild(skeletonPanel(3));
    api("/api/lead-agents/admin/audit").then((data) => {
      const entries = (data.audit || []).filter((e) => e.target_type === "tasks" && e.target_id === task.id);
      host.innerHTML = "";
      if (!entries.length) {
        host.appendChild(emptyPanel({ kicker: "Audit Log", title: "No audit entries yet", body: "Changes to this task will be recorded here." }));
        return;
      }
      entries.forEach((entry) => {
        host.appendChild(el(`
          <div class="split-fact-row">
            <span class="label">${escapeHtml(fmtRelative(entry.created_at))}</span>
            <span class="value">${escapeHtml(titleCase(String(entry.action || "").replace(/_/g, " ")))} · ${escapeHtml(entry.actor_email || "")}</span>
          </div>
        `));
      });
    }).catch(() => {
      host.innerHTML = "";
      host.appendChild(errorPanel("Could not load the audit log."));
    });
    return host;
  }

  function draw() {
    panel.innerHTML = "";
    const head = el(`<div class="split-panel-head"></div>`);
    const headTitle = el(`<div></div>`);
    headTitle.appendChild(el(`<h2>${escapeHtml(task.title)}</h2>`));
    headTitle.appendChild(el(`<div style="margin-top:6px;">${badge(titleCase(task.status), toneForStatus(task.status))}</div>`));
    head.appendChild(headTitle);
    const closeBtn = el(`<button type="button" class="split-panel-close" aria-label="Close">✕</button>`);
    closeBtn.addEventListener("click", onClose);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    const tabs = el(`<div class="split-tabs"></div>`);
    [["overview", "Overview"], ["audit", "Audit Log"]].forEach(([key, label]) => {
      const btn = el(`<button type="button" class="split-tab ${panelState.tab === key ? "active" : ""}">${label}</button>`);
      btn.addEventListener("click", () => { panelState.tab = key; draw(); });
      tabs.appendChild(btn);
    });
    panel.appendChild(tabs);

    panel.appendChild(panelState.tab === "overview" ? renderOverviewTab() : renderAuditTab());

    const actions = el(`<div class="split-panel-actions"></div>`);
    if (hasPermission("tasks.manage")) {
      const statusActions = renderStatusActions("crm", "tasks", task, onChanged);
      if (statusActions) actions.appendChild(statusActions);
    }
    if (task.__relation) {
      const linkBtn = el(`<button type="button" class="btn btn-ghost btn-sm">Open ${escapeHtml(task.__relation.type)}</button>`);
      linkBtn.addEventListener("click", () => navigate(task.__relation.path));
      actions.appendChild(linkBtn);
    }
    panel.appendChild(actions);
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

// Structured sibling of taskOyiSafeSummary — same fields, machine-readable
// shape, so Oyi's Tasks capability module (Ochiga-backend) can answer a
// specific sub-question (owner/due date/overdue/priority) instead of only
// ever echoing the whole safe_summary string. Overdue logic matches
// renderTasksList's __overdue computation exactly.
function taskOyiContext(record) {
  const overdue = Boolean(record.due_at) && !record.completed_at
    && new Date(record.due_at).getTime() < Date.now()
    && !["done", "completed", "cancelled"].includes(String(record.status || "").toLowerCase());
  return {
    task_ref: record.id,
    safe_summary: taskOyiSafeSummary(record),
    title: record.title || null,
    status: record.status || null,
    priority: record.priority || null,
    owner: record.assignee || null,
    due_at: record.due_at || null,
    overdue,
  };
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
  setSelectedObject("task", id, record.title, taskOyiContext(record));
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

// Tasks Domain UI — Overview | Tasks | Schedule | Automations. Same
// line-nav pattern as CRM/Documents (crm-tabs/crm-tab, reused
// verbatim, not reinvented — see renderCrmRoute).
const TASKS_TABS = [
  { key: "overview", label: "Overview" },
  { key: "tasks", label: "Tasks" },
  { key: "schedule", label: "Schedule" },
  { key: "automations", label: "Automations" },
];

async function renderTasksRoute(outlet, rest, token) {
  const [first] = rest;
  const isTabKey = TASKS_TABS.some((tab) => tab.key === first);

  // Backward compatibility: existing deep links (rail cards on Lead/
  // Project/etc. detail pages, notification links — e.g. the `task:`
  // route builder) use `tasks/<task-id>`. A task id is never one of
  // the tab keys above, so this distinguishes cleanly without
  // changing any existing link anywhere else in the app.
  if (first && !isTabKey) {
    setTopbar("Tasks", "");
    outlet.innerHTML = "";
    outlet.appendChild(skeletonPanel(4));
    try {
      await renderTaskRedirect(outlet, first, token);
    } catch (err) {
      if (token !== state.renderToken) return;
      outlet.innerHTML = "";
      outlet.appendChild(errorPanel(err.message || "Could not load task."));
    }
    return;
  }

  const subKey = first || "overview";
  setTopbar("Tasks", titleCase(subKey));
  outlet.innerHTML = "";

  const tabs = el(`<div class="crm-tabs"></div>`);
  TASKS_TABS.forEach((tab) => {
    const tabBtn = el(`<button type="button" class="crm-tab ${tab.key === subKey ? "active" : ""}" data-tasks-tab="${tab.key}">${escapeHtml(tab.label)}</button>`);
    tabBtn.addEventListener("click", () => navigate(`tasks/${tab.key}`));
    tabs.appendChild(tabBtn);
  });
  outlet.appendChild(tabs);

  const body = el(`<div class="crm-body"></div>`);
  body.appendChild(skeletonPanel(4));
  outlet.appendChild(body);

  try {
    if (subKey === "tasks") await renderTasksList(body, token);
    else if (subKey === "automations") await renderAutomationsView(body, token);
    else if (subKey === "schedule") await renderScheduleView(body, token);
    else await renderTasksOverview(body, token);
  } catch (err) {
    if (token !== state.renderToken) return;
    body.innerHTML = "";
    body.appendChild(errorPanel(err.message || "Could not load this view."));
  }
}

// Tasks Domain UI — Overview. Command view composed entirely from the
// same real data Tasks/Automations already fetch (crm_tasks,
// consumer_automations, ochiga_workflows) — no new data source, no
// fabricated counts. Every KPI/list/metric below is computed from a
// live fetch; anything not cheaply computable from list-level data
// (e.g. a global "all runs" aggregate) is left out rather than
// approximated.
async function renderTasksOverview(outlet, token) {
  setSelectedObject(null);
  const [tasks, taskIndex, automations, workflows] = await Promise.all([
    fetchTasks(),
    fetchTaskRelationIndex(),
    fetchAutomations(),
    fetchWorkflows().catch(() => []),
  ]);
  if (token !== state.renderToken) return;

  const now = Date.now();
  const soonMs = now + 7 * 24 * 60 * 60 * 1000;
  const openStatuses = (t) => !["done", "completed", "cancelled"].includes(String(t.status || "").toLowerCase());
  const enrichedTasks = tasks.map((t) => {
    const relation = resolveTaskRelation(t, taskIndex);
    const overdue = Boolean(t.due_at) && !t.completed_at && new Date(t.due_at).getTime() < now && openStatuses(t);
    const dueSoon = Boolean(t.due_at) && !t.completed_at && new Date(t.due_at).getTime() >= now && new Date(t.due_at).getTime() <= soonMs && openStatuses(t);
    return { ...t, __relation: relation, __overdue: overdue, __dueSoon: dueSoon };
  });
  const openTasks = enrichedTasks.filter(openStatuses);
  const overdueTasks = enrichedTasks.filter((t) => t.__overdue);
  const dueSoonTasks = enrichedTasks.filter((t) => t.__dueSoon);
  const failedAutomations = automations.filter((a) => a.last_run_status === "failed");
  const activeAutomations = automations.filter((a) => a.enabled);
  const upcomingAutomations = automations.filter((a) => a.enabled && a.next_run_at);

  outlet.innerHTML = "";
  outlet.appendChild(KPIGroup([
    { label: "Open Tasks", value: String(openTasks.length) },
    { label: "Due Soon", value: String(dueSoonTasks.length), sub: "Next 7 days" },
    { label: "Needs Attention", value: String(overdueTasks.length + failedAutomations.length), alert: overdueTasks.length + failedAutomations.length > 0 },
    { label: "Active Automations", value: String(activeAutomations.length) },
    { label: "Upcoming Runs", value: String(upcomingAutomations.length), sub: "Scheduled" },
  ]));

  const body = el(`<div class="detail-body"></div>`);
  const main = el(`<div class="detail-main"></div>`);
  const rail = el(`<div class="detail-rail"></div>`);
  body.appendChild(main);
  body.appendChild(rail);
  outlet.appendChild(body);

  // A. My Work — open tasks assigned to the current admin, or the
  // whole team's open work if nothing is assigned to them specifically.
  const mine = openTasks.filter((t) => isMine(t.assignee));
  const myWorkRows = (mine.length ? mine : openTasks).slice(0, 8);
  const myWorkCard = railCard(mine.length ? "My Work" : "Team Work", renderDataTable({
    columns: [
      { label: "Task", width: "1.6fr", render: (t) => escapeHtml(t.title) },
      { label: "Source", render: (t) => escapeHtml(t.__relation ? t.__relation.type : "—") },
      { label: "Owner", render: (t) => escapeHtml(t.assignee || "Unassigned") },
      { label: "Due", render: (t) => t.due_at ? (t.__overdue ? badge(fmtDate(t.due_at), "red") : escapeHtml(fmtDate(t.due_at))) : "—" },
      { label: "Status", render: (t) => badge(titleCase(t.status), toneForStatus(t.status)) },
    ],
    rows: myWorkRows,
    onRowClick: (t) => { if (t.__relation) navigate(t.__relation.path); else navigate(`tasks/${t.id}`); },
    emptyMessage: "No open tasks.",
  }), { label: "View all", onClick: () => navigate("tasks/tasks") });
  main.appendChild(myWorkCard);

  // B. Upcoming Schedule — task deadlines and automation runs due
  // soon, merged into one real, date-sorted view (not a separate data
  // source — the Schedule page composes the same two fetches).
  const upcomingItems = [
    ...dueSoonTasks.map((t) => ({ kind: "Task", label: t.title, when: t.due_at, path: t.__relation ? t.__relation.path : `tasks/${t.id}` })),
    ...upcomingAutomations
      .filter((a) => new Date(a.next_run_at).getTime() <= soonMs)
      .map((a) => ({ kind: "Automation", label: a.name, when: a.next_run_at, path: "tasks/automations" })),
  ].sort((a, b) => new Date(a.when) - new Date(b.when)).slice(0, 8);
  const upcomingCard = railCard("Upcoming Schedule", upcomingItems.length
    ? railList(upcomingItems, (item) => `<a href="#" data-nav="${escapeHtml(item.path)}">${escapeHtml(item.label)}</a><span class="rail-sub">${escapeHtml(item.kind)} · ${escapeHtml(fmtDate(item.when))}</span>`)
    : `<p class="rail-empty">Nothing due in the next 7 days.</p>`,
  { label: "Schedule", onClick: () => navigate("tasks/schedule") });
  upcomingCard.querySelectorAll("[data-nav]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); navigate(a.dataset.nav); }));
  main.appendChild(upcomingCard);

  // C. Automation & Workflow Pulse — recency-derived from list data
  // (last_run_status/last_run_at), no per-automation run-history N+1.
  const lastEvent = [...automations].filter((a) => a.last_run_at).sort((a, b) => new Date(b.last_run_at) - new Date(a.last_run_at))[0];
  const recentSucceeded = automations.filter((a) => a.last_run_status === "succeeded").length;
  const pulseRows = [
    { label: "Active automations", value: String(activeAutomations.length) },
    { label: "Recent successful runs", value: String(recentSucceeded) },
    { label: "Recent failed runs", value: String(failedAutomations.length) },
  ];
  const pulseCard = railCard("Automation & Workflow Pulse", `
    ${FactGrid(pulseRows).outerHTML}
    <p class="rail-sub" style="margin-top:10px;display:block;">${lastEvent ? `Last event: ${escapeHtml(lastEvent.name)} — ${escapeHtml(fmtRelative(lastEvent.last_run_at))}` : "No automation runs recorded yet."}</p>
  `, { label: "View", onClick: () => navigate("tasks/automations") });
  rail.appendChild(pulseCard);

  // D. Performance — only metrics honestly computable from data
  // already on hand; "recent" is scoped to each automation's most
  // recent run since a global run-history aggregate isn't fetched here.
  const completedTasks = tasks.filter((t) => ["done", "completed"].includes(String(t.status || "").toLowerCase())).length;
  const workflowsDone = workflows.filter((w) => ["completed", "verified"].includes(w.workflow_status)).length;
  const perfRows = [
    { label: "Tasks completed", value: String(completedTasks) },
    { label: "Overdue tasks", value: String(overdueTasks.length) },
  ];
  if (automations.length) perfRows.push({ label: "Recent run success rate", value: `${Math.round((recentSucceeded / automations.length) * 100)}%` });
  if (workflows.length) perfRows.push({ label: "Workflow completion rate", value: `${Math.round((workflowsDone / workflows.length) * 100)}%` });
  rail.appendChild(railCard("Performance", FactGrid(perfRows)));

  // E. Needs Attention — real overdue tasks + failed automations only.
  const attentionItems = [
    ...overdueTasks.slice(0, 5).map((t) => ({ label: t.title, sub: `Overdue · ${escapeHtml(fmtDate(t.due_at))}`, path: t.__relation ? t.__relation.path : `tasks/${t.id}` })),
    ...failedAutomations.slice(0, 5).map((a) => ({ label: a.name, sub: "Automation failed", path: "tasks/automations" })),
  ];
  const attentionCard = railCard("Needs Attention", attentionItems.length
    ? railList(attentionItems, (item) => `<a href="#" data-nav="${escapeHtml(item.path)}">${escapeHtml(item.label)}</a><span class="rail-sub">${item.sub}</span>`)
    : `<p class="rail-empty">Nothing needs attention right now.</p>`);
  attentionCard.querySelectorAll("[data-nav]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); navigate(a.dataset.nav); }));
  rail.appendChild(attentionCard);
}

// Tasks Domain UI — Schedule. "What is expected to happen, and when?"
// Composed from the same two real fetches Overview uses (crm_tasks
// due dates, consumer_automations next_run_at) — not a calendar-grid
// rebuild (no recurring/multi-day event model exists in the data;
// "Day/Week/Month... if they can be supported cleanly" resolves here
// to a grouped chronological list, the honest fit for this data
// shape). Selecting an automation links out to Automations for
// actions rather than duplicating Run Now/Pause/Delete here.
const SCHEDULE_BUCKETS = ["Overdue", "Today", "Tomorrow", "This Week", "Later"];
function scheduleBucketFor(whenIso, now) {
  const when = new Date(whenIso).getTime();
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const startTomorrow = startToday.getTime() + 86400000;
  const startDayAfter = startTomorrow + 86400000;
  const startNextWeek = startToday.getTime() + 7 * 86400000;
  if (when < startToday.getTime()) return "Overdue";
  if (when < startTomorrow) return "Today";
  if (when < startDayAfter) return "Tomorrow";
  if (when < startNextWeek) return "This Week";
  return "Later";
}

async function renderScheduleView(outlet, token) {
  setSelectedObject(null);
  const [tasks, taskIndex, automations] = await Promise.all([
    fetchTasks(),
    fetchTaskRelationIndex(),
    fetchAutomations(),
  ]);
  if (token !== state.renderToken) return;

  const now = Date.now();
  const openStatuses = (t) => !["done", "completed", "cancelled"].includes(String(t.status || "").toLowerCase());
  const scheduleItems = [];
  tasks.forEach((t) => {
    if (!t.due_at || t.completed_at || !openStatuses(t)) return;
    const relation = resolveTaskRelation(t, taskIndex);
    scheduleItems.push({
      kind: "task", label: t.title, when: t.due_at,
      overdue: new Date(t.due_at).getTime() < now,
      sourceLabel: relation ? relation.type : "Task",
      owner: t.assignee, status: t.status,
      path: relation ? relation.path : `tasks/${t.id}`,
      raw: t,
    });
  });
  automations.forEach((a) => {
    if (!a.enabled || !a.next_run_at) return;
    scheduleItems.push({
      kind: "automation", label: a.name, when: a.next_run_at,
      overdue: false,
      sourceLabel: "Automation",
      owner: a.owner, status: a.last_run_status === "failed" ? "Needs Attention" : "Scheduled",
      path: "tasks/automations",
      raw: a,
    });
  });
  scheduleItems.sort((a, b) => new Date(a.when) - new Date(b.when));

  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const endToday = startToday.getTime() + 86400000;
  const endWeek = startToday.getTime() + 7 * 86400000;
  const inRange = (item, start, end) => { const w = new Date(item.when).getTime(); return w >= start && w < end; };
  const todayCount = scheduleItems.filter((i) => inRange(i, startToday.getTime(), endToday)).length;
  const weekCount = scheduleItems.filter((i) => inRange(i, startToday.getTime(), endWeek)).length;
  const upcomingRuns = scheduleItems.filter((i) => i.kind === "automation").length;
  const deadlines = scheduleItems.filter((i) => i.kind === "task").length;
  const attention = scheduleItems.filter((i) => i.overdue || i.status === "Needs Attention").length;

  outlet.innerHTML = "";
  const layout = el(`<div class="split-layout"></div>`);
  const mainCol = el(`<div class="split-main"></div>`);
  layout.appendChild(mainCol);
  outlet.appendChild(layout);

  mainCol.appendChild(KPIGroup([
    { label: "Today", value: String(todayCount) },
    { label: "This Week", value: String(weekCount) },
    { label: "Upcoming Runs", value: String(upcomingRuns) },
    { label: "Deadlines", value: String(deadlines) },
    { label: "Needs Attention", value: String(attention), alert: attention > 0 },
  ]));

  const listHost = el(`<div></div>`);
  mainCol.appendChild(listHost);

  function selectItem(item) {
    let panel = layout.querySelector(".split-panel");
    if (!panel) { panel = el(`<div class="split-panel"></div>`); layout.appendChild(panel); }
    if (item.kind === "task") setSelectedObject("task", item.raw.id, item.label, taskOyiContext(item.raw));
    else setSelectedObject("automation", item.raw.id, item.label, automationOyiContext(item.raw));
    renderScheduleDetailPanel(panel, item, () => { setSelectedObject(null); panel.remove(); });
  }

  if (!scheduleItems.length) {
    listHost.appendChild(emptyPanel({ kicker: "Schedule", title: "Nothing scheduled", body: "No open task deadlines or enabled automation runs right now." }));
    return;
  }
  SCHEDULE_BUCKETS.forEach((bucket) => {
    const items = scheduleItems.filter((i) => scheduleBucketFor(i.when, now) === bucket);
    if (!items.length) return;
    const section = el(`<div class="split-panel-section" style="margin-bottom:22px;"></div>`);
    section.appendChild(el(`<h4 style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-tertiary);margin:0 0 10px;">${escapeHtml(bucket)}</h4>`));
    section.appendChild(renderDataTable({
      columns: [
        { label: "Item", width: "1.6fr", render: (i) => {
          const cell = el(`<div style="display:flex;flex-direction:column;gap:2px;"></div>`);
          cell.appendChild(el(`<span style="color:var(--white);font-weight:500;">${escapeHtml(i.label)}</span>`));
          cell.appendChild(el(`<span style="color:var(--text-tertiary);font-size:11px;">${escapeHtml(i.sourceLabel)}</span>`));
          return cell;
        } },
        { label: "When", render: (i) => i.overdue ? badge(fmtDate(i.when), "red") : escapeHtml(fmtDate(i.when)) },
        { label: "Owner", render: (i) => escapeHtml(i.owner || "Unassigned") },
        { label: "Status", render: (i) => badge(titleCase(i.status), toneForStatus(i.status)) },
      ],
      rows: items,
      onRowClick: (i) => selectItem(i),
      emptyMessage: "",
    }));
    listHost.appendChild(section);
  });
}

function renderScheduleDetailPanel(panel, item, onClose) {
  panel.innerHTML = "";
  const head = el(`<div class="split-panel-head"></div>`);
  const headTitle = el(`<div></div>`);
  headTitle.appendChild(el(`<h2>${escapeHtml(item.label)}</h2>`));
  headTitle.appendChild(el(`<div style="margin-top:6px;">${badge(titleCase(item.status), toneForStatus(item.status))}</div>`));
  head.appendChild(headTitle);
  const closeBtn = el(`<button type="button" class="split-panel-close" aria-label="Close">✕</button>`);
  closeBtn.addEventListener("click", onClose);
  head.appendChild(closeBtn);
  panel.appendChild(head);

  const factRowEl = (label, value) => el(`<div class="split-fact-row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value || "—")}</span></div>`);
  const section = el(`<div class="split-panel-section"><h4>Details</h4></div>`);
  section.appendChild(factRowEl("Source", item.sourceLabel));
  section.appendChild(factRowEl("Owner", item.owner || "Unassigned"));
  if (item.kind === "task") {
    section.appendChild(factRowEl("Due", fmtDate(item.when)));
    if (item.raw.priority) section.appendChild(factRowEl("Priority", titleCase(item.raw.priority)));
    if (item.raw.description) section.appendChild(factRowEl("Description", item.raw.description));
  } else {
    section.appendChild(factRowEl("Trigger", humanizeAutomationTrigger(item.raw.trigger)));
    section.appendChild(factRowEl("Next Run", fmtDate(item.when)));
    section.appendChild(factRowEl("Last Run", item.raw.last_run_at ? fmtDate(item.raw.last_run_at) : "—"));
    section.appendChild(factRowEl("Action", automationActionSummary(item.raw)));
  }
  panel.appendChild(section);

  const actions = el(`<div class="split-panel-actions"></div>`);
  const linkBtn = el(`<button type="button" class="btn btn-ghost btn-sm">${item.kind === "task" ? "Open Task" : "Manage in Automations"}</button>`);
  linkBtn.addEventListener("click", () => navigate(item.path));
  actions.appendChild(linkBtn);
  panel.appendChild(actions);
}

// ---------------------------------------------------------------
// Tasks Domain UI — Automations. Every automation is a real
// consumer_automations row (surface="office") in Ochiga-backend's
// Shared Automation Runtime — same scheduler, same executor, same
// ai_execution_ledger/ochiga_intelligence_events observability as
// Consumer and Facility automations. This page only reads/writes
// through the bridge added in server.js; it holds no automation
// state of its own.
// ---------------------------------------------------------------

// Curated for the Office UI — the backend (WORKFLOW_CONTRACTS) accepts
// all 13 declared workflow types, but only these are semantically
// Office/commercial-relevant; camera/edge/security types belong to
// Facility's own operational context, not exposed here.
const OFFICE_AUTOMATION_WORKFLOW_TYPES = [
  { value: "customer_converted", label: "Customer converted" },
  { value: "proposal_accepted", label: "Proposal accepted" },
  { value: "meeting_requested", label: "Meeting requested" },
  { value: "deployment_required", label: "Deployment required" },
  { value: "customer_onboarding", label: "Customer onboarding" },
  { value: "prediction_requires_attention", label: "Needs management attention" },
];

function humanizeAutomationTrigger(trigger) {
  if (!trigger || trigger.type !== "schedule") return "—";
  if (trigger.schedule_type === "daily") return `Daily · ${trigger.local_time}`;
  if (trigger.schedule_type === "weekdays") return `Weekly · ${trigger.local_time}`;
  if (trigger.schedule_type === "once") return `Once · ${fmtDate(trigger.local_datetime)}`;
  return "—";
}

function automationStatusInfo(automation) {
  if (!automation.enabled) return { label: "Paused", tone: "default" };
  if (automation.last_run_status === "failed") return { label: "Needs Attention", tone: "red" };
  if (automation.last_run_status) return { label: "Active", tone: "green" };
  return { label: "Active", tone: "green" };
}

function automationActionSummary(automation) {
  const actions = Array.isArray(automation.actions) ? automation.actions : [];
  if (!actions.length) return "No action configured";
  const first = actions[0];
  if (first.action_type !== "workflow_action") return "Unsupported action";
  if (first.operation === "create") {
    const match = OFFICE_AUTOMATION_WORKFLOW_TYPES.find((t) => t.value === first.workflow_type);
    return `Create workflow: ${match ? match.label : first.workflow_type}`;
  }
  return `Transition workflow → ${titleCase(first.status || "")}`;
}

// Built ONLY from fields already rendered on the Automations detail
// panel — see taskOyiSafeSummary for the same discipline applied to Tasks.
function automationOyiSafeSummary(automation) {
  const info = automationStatusInfo(automation);
  const parts = [`${automation.name || "Automation"} · ${info.label} · ${humanizeAutomationTrigger(automation.trigger)}`.trim()];
  parts.push(`Then: ${automationActionSummary(automation)}.`);
  if (automation.owner) parts.push(`Owner: ${automation.owner}.`);
  if (automation.last_run_status) parts.push(`Last run: ${titleCase(automation.last_run_status)}${automation.last_run_at ? ` (${fmtRelative(automation.last_run_at)})` : ""}.`);
  return parts.join(" ");
}

// Structured sibling of automationOyiSafeSummary — same underlying
// fields, machine-readable shape, so Oyi's Automations capability
// module (Ochiga-backend) can answer a specific sub-question (trigger/
// last run/next run/owner/action) instead of only ever echoing the
// whole safe_summary string. trigger/action are sent as the same
// already-formatted display strings this page renders, not raw
// records — the backend has no independent way to render a workflow_
// action shape, and duplicating that logic there would be a second
// implementation of the same formatting this file already owns.
function automationOyiContext(automation) {
  return {
    automation_ref: automation.id,
    safe_summary: automationOyiSafeSummary(automation),
    name: automation.name || null,
    enabled: Boolean(automation.enabled),
    trigger: humanizeAutomationTrigger(automation.trigger),
    action: automationActionSummary(automation),
    owner: automation.owner || null,
    last_run_status: automation.last_run_status || null,
    last_run_at: automation.last_run_at || null,
    next_run_at: automation.next_run_at || null,
  };
}

async function renderAutomationsView(outlet, token) {
  setSelectedObject(null);
  const listState = { query: "", status: "", owner: "", selectedId: null };
  const automations = await fetchAutomations();
  if (token !== state.renderToken) return;

  outlet.innerHTML = "";
  const layout = el(`<div class="split-layout"></div>`);
  const mainCol = el(`<div class="split-main"></div>`);
  layout.appendChild(mainCol);
  outlet.appendChild(layout);

  function computeKpis(rows) {
    const active = rows.filter((a) => a.enabled).length;
    const upcoming = rows.filter((a) => a.enabled && a.next_run_at).length;
    const attention = rows.filter((a) => a.last_run_status === "failed").length;
    return [
      { label: "Active Automations", value: String(active) },
      { label: "Upcoming Runs", value: String(upcoming), sub: "Scheduled" },
      { label: "Needs Attention", value: String(attention), alert: attention > 0 },
    ];
  }
  mainCol.appendChild(KPIGroup(computeKpis(automations)));

  const toolbarHost = el(`<div></div>`);
  mainCol.appendChild(toolbarHost);
  const resultsHost = el(`<div class="crm-results"></div>`);
  mainCol.appendChild(resultsHost);

  const ownerOptions = [...new Set(automations.map((a) => a.owner).filter(Boolean))].sort();

  function drawToolbar() {
    toolbarHost.innerHTML = "";
    toolbarHost.appendChild(renderToolbar({
      query: listState.query,
      onQuery: (value) => { listState.query = value; drawTable(); },
      filters: [
        { label: "Status", value: listState.status, options: ["enabled", "disabled"], onChange: (value) => { listState.status = value; drawTable(); } },
        ...(ownerOptions.length ? [{ label: "Owner", value: listState.owner, options: ownerOptions, onChange: (value) => { listState.owner = value; drawTable(); } }] : []),
      ],
      primaryAction: hasPermission("tasks.manage") ? { label: "New Automation", onClick: () => openNewAutomationWizard(() => refresh(true)) } : null,
    }));
  }

  function filteredRows() {
    let rows = automations;
    if (listState.status === "enabled") rows = rows.filter((a) => a.enabled);
    else if (listState.status === "disabled") rows = rows.filter((a) => !a.enabled);
    if (listState.owner) rows = rows.filter((a) => a.owner === listState.owner);
    if (listState.query) {
      const q = listState.query.toLowerCase();
      rows = rows.filter((a) => String(a.name || "").toLowerCase().includes(q));
    }
    return rows;
  }

  function drawTable() {
    resultsHost.innerHTML = "";
    const rows = filteredRows();
    resultsHost.appendChild(renderDataTable({
      columns: [
        { label: "Automation", width: "1.8fr", render: (a) => {
          const cell = el(`<div style="display:flex;flex-direction:column;gap:2px;"></div>`);
          cell.appendChild(el(`<span style="color:var(--white);font-weight:500;">${escapeHtml(a.name)}</span>`));
          cell.appendChild(el(`<span style="color:var(--text-tertiary);font-size:11px;">${escapeHtml(automationActionSummary(a))}</span>`));
          return cell;
        } },
        { label: "Trigger", render: (a) => escapeHtml(humanizeAutomationTrigger(a.trigger)) },
        { label: "Next Run", render: (a) => a.enabled && a.next_run_at ? escapeHtml(fmtDate(a.next_run_at)) : "—" },
        { label: "Last Run", render: (a) => a.last_run_at ? escapeHtml(fmtDate(a.last_run_at)) : "—" },
        { label: "Status", render: (a) => { const info = automationStatusInfo(a); return badge(info.label, info.tone); } },
        { label: "Owner", render: (a) => escapeHtml(a.owner || "Unassigned") },
      ],
      rows,
      onRowClick: (a) => selectAutomation(a.id),
      emptyMessage: automations.length ? "No automations match your filters." : "No automations yet — create one to get started.",
    }));
  }

  function selectAutomation(id) {
    listState.selectedId = id;
    let panel = layout.querySelector(".split-panel");
    if (!panel) {
      panel = el(`<div class="split-panel"></div>`);
      layout.appendChild(panel);
    }
    panel.innerHTML = "";
    panel.appendChild(skeletonPanel(3));
    const automation = automations.find((a) => a.id === id);
    if (!automation) return;
    setSelectedObject("automation", id, automation.name, automationOyiContext(automation));
    renderAutomationDetailPanel(panel, automation, {
      onClose: () => { setSelectedObject(null); panel.remove(); },
      onChanged: () => refresh(true),
    });
  }

  async function refresh(force) {
    const fresh = await fetchAutomations(force);
    if (token !== state.renderToken) return;
    automations.length = 0;
    automations.push(...fresh);
    mainCol.replaceChildren();
    mainCol.appendChild(KPIGroup(computeKpis(automations)));
    mainCol.appendChild(toolbarHost);
    mainCol.appendChild(resultsHost);
    drawToolbar();
    drawTable();
    if (listState.selectedId && automations.some((a) => a.id === listState.selectedId)) selectAutomation(listState.selectedId);
    else {
      const panel = layout.querySelector(".split-panel");
      if (panel) panel.remove();
    }
  }

  drawToolbar();
  drawTable();
}

async function renderAutomationDetailPanel(panel, automation, { onClose, onChanged }) {
  const panelState = { tab: "overview" };
  const [runsResult, workflowLink] = await Promise.all([
    apiListAutomationRuns(automation.id).catch(() => ({ runs: [] })),
    Promise.resolve(null),
  ]);
  const runs = runsResult.runs || [];

  function draw() {
    panel.innerHTML = "";
    const info = automationStatusInfo(automation);
    const head = el(`<div class="split-panel-head"></div>`);
    const headTitle = el(`<div></div>`);
    headTitle.appendChild(el(`<h2>${escapeHtml(automation.name)}</h2>`));
    headTitle.appendChild(el(`<div style="margin-top:6px;">${badge(info.label, info.tone)}</div>`));
    head.appendChild(headTitle);
    const closeBtn = el(`<button type="button" class="split-panel-close" aria-label="Close">✕</button>`);
    closeBtn.addEventListener("click", onClose);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    const tabs = el(`<div class="split-tabs"></div>`);
    [["overview", "Overview"], ["runs", "Runs"], ["audit", "Audit Log"]].forEach(([key, label]) => {
      const btn = el(`<button type="button" class="split-tab ${panelState.tab === key ? "active" : ""}">${label}</button>`);
      btn.addEventListener("click", () => { panelState.tab = key; draw(); });
      tabs.appendChild(btn);
    });
    panel.appendChild(tabs);

    if (panelState.tab === "overview") panel.appendChild(renderAutomationOverviewTab());
    else if (panelState.tab === "runs") panel.appendChild(renderAutomationRunsTab());
    else panel.appendChild(renderAutomationAuditTab());

    const actions = el(`<div class="split-panel-actions"></div>`);
    if (hasPermission("tasks.manage")) {
      const runNowBtn = el(`<button type="button" class="btn btn-ghost btn-sm">Run Now</button>`);
      runNowBtn.addEventListener("click", async () => {
        runNowBtn.disabled = true;
        runNowBtn.textContent = "Running…";
        try {
          await apiTestAutomation(automation.id);
          onChanged();
        } catch (err) {
          runNowBtn.disabled = false;
          runNowBtn.textContent = "Run Now";
          panel.appendChild(errorPanel(err.message || "Could not run this automation."));
        }
      });
      actions.appendChild(runNowBtn);

      const toggleBtn = el(`<button type="button" class="btn btn-ghost btn-sm">${automation.enabled ? "Pause" : "Resume"}</button>`);
      toggleBtn.addEventListener("click", async () => {
        await apiUpdateAutomation(automation.id, { enabled: !automation.enabled });
        onChanged();
      });
      actions.appendChild(toggleBtn);

      const deleteBtn = el(`<button type="button" class="btn btn-danger btn-sm">Delete</button>`);
      deleteBtn.addEventListener("click", async () => {
        if (!confirm(`Delete "${automation.name}"? This cannot be undone.`)) return;
        await apiDeleteAutomation(automation.id);
        onClose();
        onChanged();
      });
      actions.appendChild(deleteBtn);
    }
    panel.appendChild(actions);
  }

  function factRowEl(label, value) {
    return el(`<div class="split-fact-row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value || "—")}</span></div>`);
  }

  function renderAutomationOverviewTab() {
    const wrap = el(`<div></div>`);
    const section = el(`<div class="split-panel-section"><h4>Details</h4></div>`);
    section.appendChild(factRowEl("Action", automationActionSummary(automation)));
    section.appendChild(factRowEl("Trigger", humanizeAutomationTrigger(automation.trigger)));
    section.appendChild(factRowEl("Owner", automation.owner || "Unassigned"));
    section.appendChild(factRowEl("Next Run", automation.enabled && automation.next_run_at ? fmtDate(automation.next_run_at) : "—"));
    section.appendChild(factRowEl("Last Run", automation.last_run_at ? fmtDate(automation.last_run_at) : "—"));
    wrap.appendChild(section);

    const perfSection = el(`<div class="split-panel-section"><h4>Performance (recent runs)</h4></div>`);
    const succeeded = runs.filter((r) => ["succeeded", "completed"].includes(r.status)).length;
    const failed = runs.filter((r) => ["failed", "partially_succeeded", "partially_completed"].includes(r.status)).length;
    const rate = runs.length ? Math.round((succeeded / runs.length) * 100) : null;
    const perfRow = el(`<div class="split-panel-perf"></div>`);
    perfRow.appendChild(donutChart(
      runs.length ? [{ label: "Succeeded", count: succeeded, tone: "green" }, { label: "Failed", count: failed, tone: "red" }] : [],
      "No runs yet"
    ));
    const stats = el(`<div class="split-panel-perf-stats"></div>`);
    stats.appendChild(el(`<div class="stat-row"><span class="stat-label">Runs</span><span class="stat-value">${runs.length}</span></div>`));
    stats.appendChild(el(`<div class="stat-row"><span class="stat-label">Succeeded</span><span class="stat-value">${succeeded}</span></div>`));
    stats.appendChild(el(`<div class="stat-row"><span class="stat-label">Failed</span><span class="stat-value ${failed ? "red" : ""}">${failed}</span></div>`));
    if (rate !== null) stats.appendChild(el(`<div class="stat-row"><span class="stat-label">Success rate</span><span class="stat-value">${rate}%</span></div>`));
    perfRow.appendChild(stats);
    perfSection.appendChild(perfRow);
    wrap.appendChild(perfSection);
    return wrap;
  }

  function renderAutomationRunsTab() {
    if (!runs.length) return emptyPanel({ kicker: "Runs", title: "No runs yet", body: "This automation hasn't run yet." });
    return renderDataTable({
      columns: [
        { label: "Started", render: (r) => escapeHtml(fmtDate(r.started_at || r.created_at)) },
        { label: "Status", render: (r) => badge(titleCase(r.status), toneForStatus(r.status)) },
        { label: "Source", render: (r) => escapeHtml(titleCase(r.source || "")) },
      ],
      rows: runs,
      emptyMessage: "No runs yet.",
    });
  }

  function renderAutomationAuditTab() {
    if (!hasPermission("view_audit")) {
      return emptyPanel({ kicker: "Audit Log", title: "Restricted", body: "You don't have permission to view the audit log." });
    }
    const host = el(`<div></div>`);
    host.appendChild(skeletonPanel(3));
    api("/api/lead-agents/admin/audit").then((data) => {
      const entries = (data.audit || []).filter((e) => e.target_type === "automation" && e.target_id === automation.id);
      host.innerHTML = "";
      if (!entries.length) {
        host.appendChild(emptyPanel({ kicker: "Audit Log", title: "No audit entries yet", body: "Changes to this automation will be recorded here." }));
        return;
      }
      entries.forEach((entry) => {
        host.appendChild(el(`
          <div class="split-fact-row">
            <span class="label">${escapeHtml(fmtRelative(entry.created_at))}</span>
            <span class="value">${escapeHtml(titleCase(String(entry.action || "").replace(/_/g, " ")))} · ${escapeHtml(entry.actor_email || "")}</span>
          </div>
        `));
      });
    }).catch(() => {
      host.innerHTML = "";
      host.appendChild(errorPanel("Could not load the audit log."));
    });
    return host;
  }

  draw();
}

// Mirrors the backend's WORKFLOW_STATUSES (intelligence-core/workflows.ts)
// for the "transition an existing workflow" THEN branch — kept as a
// literal list rather than fetched, since it's a fixed enum the runtime
// already validates server-side (validateWorkflowActions), not data.
const WORKFLOW_TRANSITION_STATUSES = ["created", "reviewed", "assigned", "accepted", "in_progress", "completed", "verified", "cancelled", "failed", "blocked", "escalated"];

// Guided New Automation wizard — WHEN / IF / THEN / SCOPE / OWNER / REVIEW,
// in plain language, no raw JSON exposed. Two steps are intentionally
// non-interactive rather than fake controls:
//   IF    — consumer_automations.condition is accepted and stored by the
//           backend (scenes.ts) but never evaluated anywhere in the
//           execution path (executeConsumerAutomation reads trigger and
//           actions only). Building a condition editor here would silently
//           promise enforcement the runtime doesn't provide, so this step
//           is an honest static notice instead of a functional builder.
//   SCOPE — Office automations are surface-locked server-side (surface is
//           hardcoded to "office" in officeExport.ts) and consumer_automations
//           carries no other real scoping dimension for Office (estate_id/
//           home_id are Consumer/Facility-only). There's nothing real to
//           pick, so this is a read-only statement of the actual constraint.
// THEN supports both real backend operations — create a new workflow, or
// transition an existing one (workflow_id/status) — since both are
// genuinely validated and executed by the shared runtime; only "create"
// existed in the previous flat-form dialog.
// initial optionally pre-fills fields (e.g. from an Oyi Core automation
// suggestion — see the "office.create_automation" case in
// renderApprovalSurface). Never skips a step and never submits on the
// user's behalf: it only saves retyping fields Oyi already surfaced in
// conversation, staff still walk every step and confirm on Review.
function openNewAutomationWizard(onCreated, initial = {}) {
  const STEPS = ["when", "if", "then", "scope", "owner", "review"];
  const STEP_LABELS = { when: "When", if: "If", then: "Then", scope: "Scope", owner: "Owner", review: "Review" };
  const wiz = {
    stepIndex: 0,
    name: "",
    schedule_type: "daily",
    local_time: "08:00",
    local_datetime: "",
    operation: "create",
    workflow_type: OFFICE_AUTOMATION_WORKFLOW_TYPES[0].value,
    title: "",
    summary: "",
    workflow_id: "",
    status: "in_progress",
    owner: "",
    ...initial,
  };
  let workflows = [];

  const overlay = el(`<div class="dialog-overlay"></div>`);
  const card = el(`
    <form class="dialog-card">
      <h3>New Automation</h3>
      <p class="wizard-step-label"></p>
      <div class="dialog-fields wizard-body"></div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-back></button>
        <button type="submit" class="btn btn-primary btn-sm" data-forward>Next</button>
      </div>
      <p class="dialog-error"></p>
    </form>
  `);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const stepLabelEl = card.querySelector(".wizard-step-label");
  const bodyEl = card.querySelector(".wizard-body");
  const backBtn = card.querySelector("[data-back]");
  const forwardBtn = card.querySelector("[data-forward]");
  const errorLabel = card.querySelector(".dialog-error");

  function close() { overlay.remove(); }
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });

  function currentStep() { return STEPS[wiz.stepIndex]; }

  function validateStep(step) {
    if (step === "when") {
      if (!wiz.name.trim()) return "A name is required.";
      if (wiz.schedule_type === "once" && !wiz.local_datetime) return "Pick a date and time.";
      return null;
    }
    if (step === "then") {
      if (wiz.operation === "create") {
        if (!wiz.title.trim() || !wiz.summary.trim()) return "Workflow title and summary are required.";
      } else {
        if (!wiz.workflow_id) return "Choose which workflow this should transition.";
      }
      return null;
    }
    return null;
  }

  function buildTrigger() {
    return wiz.schedule_type === "once"
      ? { type: "schedule", schedule_type: "once", local_datetime: wiz.local_datetime, timezone: "Africa/Lagos" }
      : { type: "schedule", schedule_type: "daily", local_time: wiz.local_time, timezone: "Africa/Lagos" };
  }

  function buildAction() {
    return wiz.operation === "create"
      ? { action_type: "workflow_action", operation: "create", workflow_type: wiz.workflow_type, title: wiz.title, summary: wiz.summary }
      : { action_type: "workflow_action", operation: "transition", workflow_id: wiz.workflow_id, status: wiz.status };
  }

  function renderWhenStep() {
    const wrap = el(`<div></div>`);
    wrap.appendChild(el(`<label>Automation Name<input name="name" type="text" value="${escapeHtml(wiz.name)}" /></label>`));
    wrap.querySelector('input[name="name"]').addEventListener("input", (e) => { wiz.name = e.target.value; });

    const scheduleLabel = el(`
      <label>Runs
        <select name="schedule_type">
          <option value="daily">Every day, at a time</option>
          <option value="once">Once, at a specific date and time</option>
        </select>
      </label>
    `);
    scheduleLabel.querySelector("select").value = wiz.schedule_type;
    wrap.appendChild(scheduleLabel);

    const timeLabel = el(`<label data-field="daily">Time (24h)<input name="local_time" type="time" value="${escapeHtml(wiz.local_time)}" /></label>`);
    const dateTimeLabel = el(`<label data-field="once">Date &amp; time<input name="local_datetime" type="datetime-local" value="${escapeHtml(wiz.local_datetime)}" /></label>`);
    timeLabel.style.display = wiz.schedule_type === "daily" ? "" : "none";
    dateTimeLabel.style.display = wiz.schedule_type === "once" ? "" : "none";
    wrap.appendChild(timeLabel);
    wrap.appendChild(dateTimeLabel);

    scheduleLabel.querySelector("select").addEventListener("change", (e) => {
      wiz.schedule_type = e.target.value;
      timeLabel.style.display = wiz.schedule_type === "daily" ? "" : "none";
      dateTimeLabel.style.display = wiz.schedule_type === "once" ? "" : "none";
    });
    timeLabel.querySelector("input").addEventListener("input", (e) => { wiz.local_time = e.target.value; });
    dateTimeLabel.querySelector("input").addEventListener("input", (e) => { wiz.local_datetime = e.target.value; });
    return wrap;
  }

  function renderIfStep() {
    return el(`
      <div>
        <p class="rail-empty">Conditions aren't enforced by the automation runtime yet — this automation will run every time its trigger above fires, with no extra check.</p>
      </div>
    `);
  }

  function renderThenStep() {
    const wrap = el(`<div></div>`);
    const opLabel = el(`
      <label>Then
        <select name="operation">
          <option value="create">Create a new workflow</option>
          <option value="transition">Transition an existing workflow</option>
        </select>
      </label>
    `);
    opLabel.querySelector("select").value = wiz.operation;
    wrap.appendChild(opLabel);

    const createFields = el(`<div data-field="create"></div>`);
    createFields.appendChild(el(`
      <label>Workflow type
        <select name="workflow_type">${OFFICE_AUTOMATION_WORKFLOW_TYPES.map((t) => `<option value="${escapeHtml(t.value)}" ${t.value === wiz.workflow_type ? "selected" : ""}>${escapeHtml(t.label)}</option>`).join("")}</select>
      </label>
    `));
    createFields.appendChild(el(`<label>Workflow title<input name="title" type="text" value="${escapeHtml(wiz.title)}" /></label>`));
    createFields.appendChild(el(`<label>Workflow summary<textarea name="summary" rows="2">${escapeHtml(wiz.summary)}</textarea></label>`));
    createFields.querySelector('select[name="workflow_type"]').addEventListener("change", (e) => { wiz.workflow_type = e.target.value; });
    createFields.querySelector('input[name="title"]').addEventListener("input", (e) => { wiz.title = e.target.value; });
    createFields.querySelector('textarea[name="summary"]').addEventListener("input", (e) => { wiz.summary = e.target.value; });
    wrap.appendChild(createFields);

    const transitionFields = el(`<div data-field="transition"></div>`);
    if (!workflows.length) {
      transitionFields.appendChild(el(`<p class="rail-empty">No existing workflows to transition. Create one first, or choose "Create a new workflow" above.</p>`));
    } else {
      const workflowSelect = el(`
        <label>Workflow
          <select name="workflow_id">
            <option value="">Choose a workflow…</option>
            ${workflows.map((w) => `<option value="${escapeHtml(w.id)}" ${w.id === wiz.workflow_id ? "selected" : ""}>${escapeHtml(w.title || w.workflow_id)} — ${escapeHtml(titleCase(w.workflow_status))}</option>`).join("")}
          </select>
        </label>
      `);
      workflowSelect.querySelector("select").addEventListener("change", (e) => { wiz.workflow_id = e.target.value; });
      transitionFields.appendChild(workflowSelect);
      const statusSelect = el(`
        <label>New status
          <select name="status">${WORKFLOW_TRANSITION_STATUSES.map((s) => `<option value="${escapeHtml(s)}" ${s === wiz.status ? "selected" : ""}>${escapeHtml(titleCase(s))}</option>`).join("")}</select>
        </label>
      `);
      statusSelect.querySelector("select").addEventListener("change", (e) => { wiz.status = e.target.value; });
      transitionFields.appendChild(statusSelect);
    }
    wrap.appendChild(transitionFields);

    function syncOperationVisibility() {
      createFields.style.display = wiz.operation === "create" ? "" : "none";
      transitionFields.style.display = wiz.operation === "transition" ? "" : "none";
    }
    syncOperationVisibility();
    opLabel.querySelector("select").addEventListener("change", (e) => { wiz.operation = e.target.value; syncOperationVisibility(); });
    return wrap;
  }

  function renderScopeStep() {
    return el(`
      <div>
        <p class="rail-empty">This automation runs within Ochiga Office only. Cross-surface scoping (Consumer/Facility) isn't available from this workspace.</p>
      </div>
    `);
  }

  function renderOwnerStep() {
    const wrap = el(`<div></div>`);
    wrap.appendChild(el(`<label>Owner<input name="owner" type="text" placeholder="Name or email" value="${escapeHtml(wiz.owner)}" /></label>`));
    wrap.querySelector('input[name="owner"]').addEventListener("input", (e) => { wiz.owner = e.target.value; });
    return wrap;
  }

  function renderReviewStep() {
    const trigger = buildTrigger();
    const action = buildAction();
    const rows = [
      { label: "Name", value: wiz.name },
      { label: "When", value: humanizeAutomationTrigger(trigger) },
      { label: "If", value: "No condition — always runs when triggered" },
      { label: "Then", value: automationActionSummary({ actions: [action] }) },
      ...(wiz.operation === "create" ? [{ label: "Workflow", value: `${wiz.title} — ${wiz.summary}` }] : []),
      { label: "Scope", value: "Ochiga Office" },
      { label: "Owner", value: wiz.owner || "Unassigned" },
    ];
    const wrap = el(`<div></div>`);
    rows.forEach((r) => wrap.appendChild(el(`<div class="split-fact-row"><span class="label">${escapeHtml(r.label)}</span><span class="value">${escapeHtml(r.value)}</span></div>`)));
    return wrap;
  }

  function renderStep() {
    bodyEl.innerHTML = "";
    const step = currentStep();
    stepLabelEl.textContent = `Step ${wiz.stepIndex + 1} of ${STEPS.length} · ${STEP_LABELS[step]}`;
    errorLabel.textContent = "";
    if (step === "when") bodyEl.appendChild(renderWhenStep());
    else if (step === "if") bodyEl.appendChild(renderIfStep());
    else if (step === "then") bodyEl.appendChild(renderThenStep());
    else if (step === "scope") bodyEl.appendChild(renderScopeStep());
    else if (step === "owner") bodyEl.appendChild(renderOwnerStep());
    else bodyEl.appendChild(renderReviewStep());

    backBtn.textContent = wiz.stepIndex === 0 ? "Cancel" : "Back";
    forwardBtn.textContent = step === "review" ? "Create" : "Next";
  }

  backBtn.addEventListener("click", () => {
    if (wiz.stepIndex === 0) { close(); return; }
    wiz.stepIndex -= 1;
    renderStep();
  });

  card.addEventListener("submit", async (event) => {
    event.preventDefault();
    const step = currentStep();
    if (step !== "review") {
      const error = validateStep(step);
      if (error) { errorLabel.textContent = error; return; }
      wiz.stepIndex += 1;
      renderStep();
      return;
    }
    try {
      await apiCreateAutomation({
        name: wiz.name,
        owner: wiz.owner || null,
        trigger: buildTrigger(),
        actions: [buildAction()],
      });
      invalidate("automations");
      close();
      onCreated();
    } catch (err) {
      errorLabel.textContent = err.message || "Could not create automation.";
    }
  });

  renderStep();
  fetchWorkflows().then((data) => { workflows = data; if (currentStep() === "then") renderStep(); }).catch(() => {});
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

// Purely a derived DISPLAY label — never mutates the stored status.
// Once a meeting's scheduled_at has passed and nobody has recorded it as
// completed/cancelled, "Scheduled" is misleading; this only changes what
// the detail page shows, not the record itself, so it stays honest about
// what's actually stored while still answering "did this happen?".
function meetingDisplayStatus(record) {
  if (["completed", "cancelled"].includes(record.status)) return record.status;
  if (record.scheduled_at && new Date(record.scheduled_at).getTime() < Date.now()) return "past_awaiting_outcome";
  return record.status;
}
function meetingStatusLabel(status) {
  return status === "past_awaiting_outcome" ? "Past — Awaiting Outcome" : titleCase(status);
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
          ${factRow("Status", meetingStatusLabel(meetingDisplayStatus(record)))}
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
    badges: [badge(meetingStatusLabel(meetingDisplayStatus(record)), toneForStatus(meetingDisplayStatus(record))), badge(record.scheduled_at ? fmtDateTime(record.scheduled_at) : "Unscheduled")],
    backLabel: "Meetings",
    onBack: () => navigate("meetings"),
    oyiContext: meetingOyiContext(record, { related, followUpTask }),
    mainSections,
    railSections,
  });
}

// Built ONLY from fields already rendered on the Meeting detail page.
function meetingOyiSafeSummary(record, { related, followUpTask } = {}) {
  const parts = [
    `${record.title || "Meeting"} · ${meetingStatusLabel(meetingDisplayStatus(record))}`.trim(),
    record.scheduled_at ? `Scheduled: ${fmtDateTime(record.scheduled_at)}.` : "Not yet scheduled.",
  ];
  if (record.owner) parts.push(`Owner: ${record.owner}.`);
  if (related) parts.push(`Related ${titleCase(record.related_type || "record")}: ${related.name}.`);
  if (record.outcome) parts.push(`Outcome: ${record.outcome}`);
  if (followUpTask) parts.push(`Follow-up task: ${followUpTask.title} (${titleCase(followUpTask.status)}).`);
  return parts.join(" ");
}

// Structured sibling of meetingOyiSafeSummary — same underlying fields,
// machine-readable shape, so Oyi's Meetings capability module can answer
// a specific sub-question instead of only ever echoing the whole
// safe_summary string. follow_up_task_title/status are a REAL existing
// cross-reference (followUpTask is already resolved by the caller before
// this runs) — sent as-is, present or absent, never fabricated.
function meetingOyiContext(record, { related, followUpTask } = {}) {
  return {
    meeting_ref: record.id,
    safe_summary: meetingOyiSafeSummary(record, { related, followUpTask }),
    title: record.title || null,
    status: meetingStatusLabel(meetingDisplayStatus(record)),
    scheduled_at: record.scheduled_at || null,
    owner: record.owner || null,
    outcome: record.outcome || null,
    related_type: related ? titleCase(record.related_type || "record") : null,
    related_name: related ? related.name : null,
    follow_up_task_title: followUpTask ? followUpTask.title : null,
    follow_up_task_status: followUpTask ? titleCase(followUpTask.status) : null,
  };
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
    oyiContext: partnershipOyiContext(record, { label, org, opportunity, handoff }),
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

// Structured sibling of partnershipOyiSafeSummary — same fields (record's
// own + the org/opportunity/handoff cross-references renderPartnershipDetail
// already resolves), so Oyi's Partnerships capability module can answer a
// specific sub-question instead of only ever echoing the whole summary.
function partnershipOyiContext(record, { label, org, opportunity, handoff } = {}) {
  return {
    partnership_ref: record.id,
    safe_summary: partnershipOyiSafeSummary(record, { label, org, opportunity, handoff }),
    relationship_type: record.relationship_type || null,
    review_status: record.review_status || null,
    business_unit: record.business_unit || null,
    relationship_manager: record.relationship_manager || null,
    organization_name: org ? org.name : null,
    opportunity_type: opportunity ? opportunity.inquiry_type : null,
    last_contact_status: handoff ? handoff.status : null,
    last_contact_mode: handoff ? handoff.media_mode : null,
  };
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

// Structured sibling of contentOyiSafeSummary — same metadata-only
// fields (excerpt included, never the full article body), exposed as
// flat strings so Oyi's strictly-read-only office_content.read
// capability can answer a specific sub-question.
function contentOyiContext(item) {
  return {
    content_ref: item.id,
    safe_summary: contentOyiSafeSummary(item),
    title: item.title || null,
    workflow_status: item.workflow_status || null,
    category: item.category || null,
    author: item.author || null,
    excerpt: item.excerpt || null,
    scheduled_publish_at: item.scheduled_publish_at || null,
    sanity_live_url: item.sanity_live_url || null,
  };
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

  setSelectedObject("content", item.id, item.title, contentOyiContext(item));
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
    oyiContext: documentOyiContext(record, { related }),
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

// Structured sibling of documentOyiSafeSummary — same metadata-only
// fields, exposed as flat strings so Oyi's strictly-read-only
// office_documents.read capability can answer a specific sub-question
// (status/owner/type/related record) without ever seeing the file body.
function documentOyiContext(record, { related } = {}) {
  return {
    document_ref: record.id,
    safe_summary: documentOyiSafeSummary(record, { related }),
    title: record.title || null,
    document_type: record.document_type || null,
    status: record.status || null,
    owner: record.owner || null,
    related_type: related ? record.related_type || null : null,
    related_name: related ? related.name || null : null,
  };
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
async function apiListTraces(limit) {
  return api(`/api/lead-agents/admin/traces${limit ? `?limit=${encodeURIComponent(limit)}` : ""}`);
}
// Oyi Cross-Surface Observability Closure — Backend's new safe,
// cross-surface read endpoint (Consumer/Facility/Website-Oyi-widget
// conversation, voice, vision and device-execution activity). Office's
// own `traces` table above stays the authoritative source for Office's
// two legacy paths; this is the second, additive source.
async function apiListObservabilityEvents(limit) {
  return api(`/api/lead-agents/admin/observability-events${limit ? `?limit=${encodeURIComponent(limit)}` : ""}`);
}

// Canonical cross-surface list — the ONE place Office declares which
// surfaces are real and observable. "Oyi Core / Direct" is deliberately
// omitted: repeated audits found no trace/event type anywhere that
// represents a direct-to-Core interaction bypassing every known
// surface, so listing it would just be an always-zero placeholder.
const OBSERVATORY_SURFACES = [
  { key: "office_internal", label: "Ochiga Office", tone: "red" },
  { key: "ochiga_website", label: "Ochiga Website", tone: "blue" },
  { key: "consumer", label: "Oyi Consumer", tone: "green" },
  { key: "facility", label: "Oyi Facility", tone: "amber" },
];
// Which trace `type` values belong to which canonical surface — only
// Office's own two legacy trace-writing paths (runtime.js's lead-agent
// widget, server.js's internal chat) need this; the new cross-surface
// events already carry an explicit `surface` field, no lookup needed.
const TRACE_SURFACE_KEY_BY_TYPE = {
  office_internal_chat_completed: "office_internal",
  office_internal_chat_failed: "office_internal",
  chat_started: "ochiga_website",
  tool_executed: "ochiga_website",
  chat_completed: "ochiga_website",
};
function traceSurfaceOf(trace) {
  const key = TRACE_SURFACE_KEY_BY_TYPE[trace.type];
  return OBSERVATORY_SURFACES.find((s) => s.key === key) || null;
}
// public_corporate (Backend's real surface string for the website's Oyi
// widget) folds into the same user-facing "Ochiga Website" row as the
// legacy lead-agent widget traces — two technical pipes, one product.
function eventSurfaceKey(event) {
  if (event.surface === "public_corporate") return "ochiga_website";
  if (event.surface === "consumer" || event.surface === "facility") return event.surface;
  return null;
}
function eventSurfaceLabel(event) {
  const surface = OBSERVATORY_SURFACES.find((s) => s.key === eventSurfaceKey(event));
  return surface?.label || titleCase(event.surface || "unknown");
}
function surfaceCountsFrom(traces, events) {
  return OBSERVATORY_SURFACES.map((surface) => {
    const traceCount = traces.filter((t) => TRACE_SURFACE_KEY_BY_TYPE[t.type] === surface.key).length;
    const eventCount = events.filter((e) => eventSurfaceKey(e) === surface.key).length;
    return { ...surface, count: traceCount + eventCount };
  });
}

// Canonical modality vocabulary — matches Ochiga Backend's Oyi
// communications contract exactly (text_conversation/voice_conversation/
// video_conversation on trace payloads; text/voice/vision on the newer
// cross-surface events), normalized to one label set so Office never
// shows two different names for the same real mode.
const CANONICAL_MODE_LABELS = { text: "Chat / Text", voice: "Voice", vision: "Vision / Camera" };
const CANONICAL_MODE_TONES = { text: "blue", voice: "violet", vision: "amber" };
function normalizeModeKey(rawMode) {
  if (rawMode === "text_conversation" || rawMode === "text") return "text";
  if (rawMode === "voice_conversation" || rawMode === "voice") return "voice";
  if (rawMode === "video_conversation" || rawMode === "vision") return "vision";
  return null;
}
// Only conversational activity has a mode — device/tool executions
// deliberately carry no mode (never forced into text/voice/vision).
function modeCountsFrom(traces, events) {
  const counts = {};
  traces.forEach((t) => {
    const key = normalizeModeKey(t.payload?.engagement_mode || "text_conversation");
    if (key) counts[key] = (counts[key] || 0) + 1;
  });
  events.forEach((e) => {
    const key = normalizeModeKey(e.mode);
    if (key) counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

const TRACE_TYPE_META = {
  chat_started: { label: "Chat Started", tone: "blue" },
  chat_completed: { label: "Chat Completed", tone: "green" },
  tool_executed: { label: "Tool Executed", tone: "violet" },
  office_internal_chat_completed: { label: "Office Chat", tone: "green" },
  office_internal_chat_failed: { label: "Office Chat Failed", tone: "red" },
};
function traceMeta(trace) {
  return TRACE_TYPE_META[trace.type] || { label: titleCase(trace.type), tone: "default" };
}
// Readable expansions for the real failure_reason values written at the
// office_internal_chat_failed trace site (server.js) — every value here
// traces back to an actual outcome of the real HTTP call to Oyi Core:
// "network_error" is the literal catch-block reason when that request
// throws (timeout/DNS/connection refused — a genuine failed call at
// that moment, not an instrumentation artifact); "backend_rejected"
// means Oyi Core responded but with a non-2xx/ok:false; anything else
// falls through to the raw reason so nothing is ever hidden.
const FAILURE_REASON_LABELS = {
  network_error: "Network error reaching Oyi Core",
  backend_rejected: "Oyi Core rejected the request",
  oyi_core_unavailable: "Oyi Core unavailable",
};
// A one-line, honest summary of what a trace record actually captured —
// never invented, only ever what the payload really contains.
function traceSummary(trace) {
  const payload = trace.payload || {};
  if (trace.type === "chat_started" && payload.user_message) return payload.user_message;
  if (trace.type === "tool_executed") return `Called ${trace.tool_name ? titleCase(trace.tool_name) : "a tool"}`;
  if (trace.type === "chat_completed") return payload.assistant_message ? payload.assistant_message : "Response sent";
  if (trace.type === "office_internal_chat_completed") return payload.staff_email ? `Answered ${payload.staff_email}` : "Office chat completed";
  if (trace.type === "office_internal_chat_failed") {
    const reason = payload.failure_reason || "";
    return FAILURE_REASON_LABELS[reason] || reason || "Office chat failed";
  }
  return titleCase(trace.type);
}

// Presentation for the new cross-surface events — event.summary is
// already a safe, backend-generated line (no transcript/message/image
// content was ever stored), so this only ever adds a status suffix and
// picks a badge tone, never invents new copy.
const EVENT_TYPE_META = {
  "conversation.turn_completed": { label: "Conversation" },
  "conversation.voice_turn": { label: "Voice" },
  "conversation.vision_turn": { label: "Vision" },
  "device.execution_completed": { label: "Device Action" },
};
const EVENT_STATUS_TONE = { failed: "red", denied: "red", timed_out: "red", unavailable: "default" };
function eventMeta(event) {
  const base = EVENT_TYPE_META[event.event_type] || { label: titleCase(String(event.event_type || "").split(".").pop() || "event") };
  const tone = (event.status && EVENT_STATUS_TONE[event.status]) || "green";
  return { label: base.label, tone };
}
function eventSummary(event) {
  const suffix = event.status && event.status !== "success" ? ` — ${titleCase(event.status)}` : "";
  return `${event.summary || titleCase(event.event_type || "Event")}${suffix}`;
}
function itemTimestamp(item) {
  return item.created_at || item.occurred_at || "";
}

// Canonical health adapter, reused for every surface with a real probe
// (Oyi Core /health, Facility + Consumer /office/export, Website
// /api/health), regardless of transport/auth. Reads the RAW probe
// result (checked/ok from probeEndpoint()) rather than
// integrationStatus()'s combined "status" field — that combined field
// also gates on full export-payload completeness (all 16 Facility / 14
// Consumer metric keys), which is a data-SYNC-readiness bar for the
// Settings/Integrations panel, not a basic connectivity/health bar. A
// Facility or Consumer deployment can be genuinely up and answering
// real HTTP requests while still missing a handful of non-critical
// export fields (e.g. no "documents" key implemented yet) — that's a
// sync-completeness gap, not an outage, so it must not read as
// "Degraded" here.
function healthPresentation(health) {
  if (!health || !health.checked) return { label: "Not configured", tone: "default" };
  if (health.ok) return { label: "Operational", tone: "green" };
  return { label: "Unavailable", tone: "red" };
}
// Buckets traces + cross-surface events together into a real, time-
// ordered series for the selected range. Straight day/hour buckets
// only — never a fitted curve, never a range the data can't honestly
// support.
function bucketInteractionsForRange(traces, events, range) {
  const now = new Date();
  const items = [...traces, ...events];
  if (range === "today") {
    const buckets = new Map(Array.from({ length: 24 }, (_, h) => [h, 0]));
    items.forEach((item) => {
      const d = new Date(itemTimestamp(item));
      if (Number.isNaN(d.getTime()) || d.toDateString() !== now.toDateString()) return;
      buckets.set(d.getHours(), (buckets.get(d.getHours()) || 0) + 1);
    });
    return Array.from(buckets.entries()).map(([h, value]) => ({ label: `${String(h).padStart(2, "0")}:00`, value }));
  }
  const days = range === "30d" ? 30 : 7;
  const dayKeys = [];
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toDateString();
    dayKeys.push(key);
    buckets.set(key, 0);
  }
  items.forEach((item) => {
    const d = new Date(itemTimestamp(item));
    if (Number.isNaN(d.getTime())) return;
    const key = d.toDateString();
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
  });
  return dayKeys.map((key) => ({ label: new Date(key).toLocaleDateString(undefined, { day: "numeric", month: "short" }), value: buckets.get(key) || 0 }));
}
// Groups Office's own traces (by trace_id/lead_id) AND the new cross-
// surface events (by conversation_id/request_id, category=conversation
// only — device/tool executions never appear here) into conversations.
// Never marks a group LIVE; Office's own traces can show "Active
// Recently" (a real started-but-not-yet-concluded gap exists for that
// path); cross-surface events are always recorded post-hoc, after the
// orchestrator call already returned, so they only ever show "Recent".
function groupInteractionsIntoConversations(traces, events, limit = 8) {
  const groups = new Map();
  traces.forEach((t) => {
    const key = t.trace_id || t.lead_id || t.id;
    if (!key) return;
    const id = `trace:${key}`;
    if (!groups.has(id)) groups.set(id, { kind: "trace", rows: [] });
    groups.get(id).rows.push(t);
  });
  events.filter((e) => e.category === "conversation").forEach((e) => {
    const key = e.conversation_id || e.request_id || e.id;
    if (!key) return;
    const id = `event:${key}`;
    if (!groups.has(id)) groups.set(id, { kind: "event", rows: [] });
    groups.get(id).rows.push(e);
  });
  const COMPLETION_TYPES = new Set(["chat_completed", "office_internal_chat_completed", "office_internal_chat_failed"]);
  const conversations = Array.from(groups.values()).map((group) => {
    if (group.kind === "trace") {
      const rows = group.rows;
      const sorted = rows.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const latest = sorted[0];
      const started = sorted[sorted.length - 1];
      const surface = traceSurfaceOf(latest) || traceSurfaceOf(started);
      const concluded = rows.some((r) => COMPLETION_TYPES.has(r.type));
      const lastActivityMs = new Date(latest.created_at).getTime();
      const recentlyActive = !concluded && Number.isFinite(lastActivityMs) && Date.now() - lastActivityMs < 10 * 60 * 1000;
      const summarySource = rows.find((r) => r.type === "chat_started") || started;
      return {
        surfaceLabel: surface?.label || "Unknown surface",
        summary: traceSummary(summarySource),
        lastActivity: latest.created_at,
        state: recentlyActive ? "Active Recently" : "Recent",
        stateTone: recentlyActive ? "blue" : "default",
      };
    }
    const rows = group.rows.slice().sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
    const latest = rows[0];
    return {
      surfaceLabel: eventSurfaceLabel(latest),
      summary: eventSummary(latest),
      lastActivity: latest.occurred_at,
      state: "Recent",
      stateTone: "default",
    };
  });
  return conversations.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity))).slice(0, limit);
}

async function renderObservatoryView(outlet, token) {
  setTopbar("AI Agents", "");
  setSelectedObject(null);
  outlet.innerHTML = "";
  outlet.appendChild(skeletonPanel(4));

  const canViewHealth = hasPermission("integrations.read");
  const canViewSchedules = hasPermission("office.read") || hasPermission("content.write");

  let traces;
  let events = [];
  let eventsAvailable = true;
  let integrations = null;
  let demos = [];
  let scheduledContent = [];
  let demosFailed = false;
  let contentFailed = false;
  try {
    const [tracesData, eventsData, integrationsData, demosData, contentData] = await Promise.all([
      apiListTraces(500),
      apiListObservabilityEvents(500).catch(() => { eventsAvailable = false; return { events: [] }; }),
      canViewHealth ? apiGetIntegrations().catch(() => null) : Promise.resolve(null),
      hasPermission("office.read") ? apiListDemos().catch(() => { demosFailed = true; return { demos: [] }; }) : Promise.resolve({ demos: [] }),
      hasPermission("content.write") ? apiListContent("scheduled").catch(() => { contentFailed = true; return { items: [] }; }) : Promise.resolve({ items: [] }),
    ]);
    traces = tracesData.traces || [];
    events = eventsData.events || [];
    if (eventsData.available === false) eventsAvailable = false;
    integrations = integrationsData?.integrations || null;
    demos = demosData.demos || [];
    scheduledContent = contentData.items || [];
  } catch (err) {
    if (token !== state.renderToken) return;
    outlet.innerHTML = "";
    outlet.appendChild(el(`<div class="view-heading"><h1>AI Agents</h1></div>`));
    outlet.appendChild(errorPanel(err.message || "Could not load agent traces."));
    return;
  }
  if (token !== state.renderToken) return;

  outlet.innerHTML = "";
  outlet.appendChild(el(`<div class="view-heading"><h1>AI Agents</h1></div>`));
  if (!eventsAvailable) {
    outlet.appendChild(el(`<p class="home-panel-empty" style="margin:0 0 var(--space-3);">Cross-surface activity (Consumer/Facility/Website Oyi widget) is temporarily unavailable — showing Office's own recorded activity only.</p>`));
  }

  // ---- KPI row ----
  const toolExecutions = traces.filter((t) => t.type === "tool_executed");
  const deviceEvents = events.filter((e) => e.category === "device");
  const toolCounts = {};
  toolExecutions.forEach((t) => { const name = t.tool_name || "unknown"; toolCounts[name] = (toolCounts[name] || 0) + 1; });
  deviceEvents.forEach((e) => { const name = e.tool || "unknown"; toolCounts[name] = (toolCounts[name] || 0) + 1; });
  const failures = traces.filter((t) => t.type === "office_internal_chat_failed").length;
  const surfaceCounts = surfaceCountsFrom(traces, events);
  // Active Surfaces = surfaces with at least one recorded interaction in
  // this page's fetched window (up to 500 most recent traces + 500 most
  // recent cross-surface events) — an ACTIVITY signal, distinct from
  // System Health's REACHABILITY signal below. A surface can be
  // Operational with zero recent activity, or Active with a health
  // probe that's never run (Ochiga Website before this closure). "Oyi
  // Core / Direct" is not in the denominator — no observable direct-
  // to-Core interaction type exists anywhere in the data.
  const activeSurfaces = surfaceCounts.filter((s) => s.count > 0).length;
  const now = Date.now();
  const upcomingDemos = demos.filter((d) => d.scheduled_for && new Date(d.scheduled_for).getTime() > now && d.status !== "cancelled");
  const upcomingContent = scheduledContent.filter((c) => c.scheduled_publish_at && new Date(c.scheduled_publish_at).getTime() > now);
  const schedulesRunning = upcomingDemos.length + upcomingContent.length;
  const allInteractions = [...traces, ...events];
  const lastInteraction = allInteractions.slice().sort((a, b) => String(itemTimestamp(b)).localeCompare(String(itemTimestamp(a))))[0];

  const kpiGroup = KPIGroup([
    { label: "Recorded Interactions", value: allInteractions.length, icon: iconSvg("observatory", "kpi-icon"), tone: "blue", sub: lastInteraction ? `Last interaction ${fmtRelative(itemTimestamp(lastInteraction))}` : "No interactions yet" },
    { label: "Tool Executions", value: toolExecutions.length + deviceEvents.length, icon: iconSvg("lightning", "kpi-icon"), tone: "violet", sub: Object.keys(toolCounts).length ? `${Object.keys(toolCounts).length} distinct tools` : "No tool calls yet" },
    { label: "Office Chat Failures", value: failures, icon: iconSvg("attention", "kpi-icon"), tone: failures > 0 ? "red" : "green", alert: failures > 0, sub: failures > 0 ? "Needs attention" : "None recorded" },
    { label: "Active Surfaces", value: `${activeSurfaces} / ${OBSERVATORY_SURFACES.length}`, icon: iconSvg("briefing", "kpi-icon"), tone: "green", sub: "Surfaces with recorded interaction" },
    { label: "Schedules Running", value: schedulesRunning, icon: iconSvg("meetings", "kpi-icon"), tone: "amber", sub: canViewSchedules ? "Upcoming demos + scheduled content" : "Requires reports/content access" },
  ]);
  kpiGroup.style.marginBottom = "var(--space-5)";
  outlet.appendChild(kpiGroup);

  // ---- Interactions Over Time + Interactions by Surface ----
  const rowA = el(`<div class="home-grid"></div>`);
  outlet.appendChild(rowA);

  const chartPanel = homePanel("Interactions Over Time");
  const rangeTabs = el(`<div class="list-toolbar" style="padding:0 0 var(--space-2);border:none;"></div>`);
  const chartBody = el(`<div></div>`);
  let activeRange = "7d";
  const RANGE_OPTIONS = [{ key: "today", label: "Today" }, { key: "7d", label: "7 Days" }, { key: "30d", label: "30 Days" }];
  function paintChart() {
    rangeTabs.innerHTML = "";
    RANGE_OPTIONS.forEach((opt) => {
      const btn = el(`<button type="button" class="btn btn-ghost btn-sm${opt.key === activeRange ? " active" : ""}">${escapeHtml(opt.label)}</button>`);
      btn.addEventListener("click", () => { activeRange = opt.key; paintChart(); });
      rangeTabs.appendChild(btn);
    });
    chartBody.innerHTML = "";
    chartBody.appendChild(areaChart(bucketInteractionsForRange(traces, events, activeRange), { emptyText: "No interactions recorded in this range." }));
  }
  paintChart();
  chartPanel.appendChild(rangeTabs);
  chartPanel.appendChild(chartBody);
  rowA.appendChild(homePanelWrap("span-8", chartPanel));

  const surfaceDonutPanel = homePanel("Interactions by Surface");
  surfaceDonutPanel.appendChild(donutChart(
    surfaceCounts.map((s) => ({ label: s.label, count: s.count, tone: s.tone })),
    "No interactions recorded yet."
  ));

  // Interactions by Mode — genuinely cross-surface now: Office's own
  // traces are still always text (neither of Office's two conversation
  // paths captures voice/vision), but the cross-surface events can
  // carry real voice/vision modes once Consumer/Facility/the website's
  // Oyi widget actually produce one. Zero voice/vision activity still
  // renders as 100% Chat / Text — never seeded, never assumed.
  const modeCounts = modeCountsFrom(traces, events);
  const modeSegments = Object.entries(modeCounts).map(([mode, count]) => ({
    label: CANONICAL_MODE_LABELS[mode] || titleCase(mode),
    count,
    tone: CANONICAL_MODE_TONES[mode] || "default",
  }));
  const modeDonutPanel = homePanel("Interactions by Mode");
  modeDonutPanel.style.marginTop = "var(--space-4)";
  modeDonutPanel.appendChild(donutChart(modeSegments, "No interactions recorded yet."));

  const rightCol = el(`<div class="span-4"></div>`);
  rightCol.appendChild(surfaceDonutPanel);
  rightCol.appendChild(modeDonutPanel);
  rowA.appendChild(rightCol);

  // ---- Tool Usage + Recent Activity ----
  const rowB = el(`<div class="home-grid" style="margin-top:var(--space-4);"></div>`);
  outlet.appendChild(rowB);

  const toolPanel = homePanel("Tool Usage");
  if (Object.keys(toolCounts).length) {
    // titleCase() only reformats spacing/casing (create_lead -> "Create
    // Lead") — it never collapses two distinct raw tool identifiers onto
    // the same label, so observability by real tool identity is
    // preserved even though the row now reads cleanly. Combines Office's
    // own tool_executed traces with real device/tool executions from
    // Consumer/Facility (ai_execution_ledger, via the events source).
    toolPanel.appendChild(barDistribution(
      Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ label: titleCase(name), count, tone: "violet" })),
      "No tool executions recorded yet."
    ));
  } else {
    toolPanel.appendChild(el(`<p class="home-panel-empty">No tool executions recorded yet.</p>`));
  }
  rowB.appendChild(homePanelWrap("span-6", toolPanel));

  // Recent Activity is the unified cross-surface operational event
  // stream — Office's own traces AND Consumer/Facility/Website events
  // merged and sorted by real timestamp. Failures render with their
  // real status suffix (see eventSummary/traceSummary) — never hidden.
  const activityPanel = homePanel("Recent Activity");
  const recentActivityItems = [
    ...traces.slice(0, 20).map((t) => ({ ts: t.created_at, badgeMeta: traceMeta(t), title: traceSummary(t), surfaceLabel: traceSurfaceOf(t)?.label || "" })),
    ...events.slice(0, 20).map((e) => ({ ts: e.occurred_at, badgeMeta: eventMeta(e), title: eventSummary(e), surfaceLabel: eventSurfaceLabel(e) })),
  ].sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 10);
  if (!recentActivityItems.length) {
    activityPanel.appendChild(el(`<p class="home-panel-empty">No interactions recorded yet. Real activity will appear here as staff, residents, and facility operators use Oyi across Ochiga.</p>`));
  } else {
    const list = el(`<div class="attention-list"></div>`);
    recentActivityItems.forEach((item) => {
      list.appendChild(el(`
        <div class="attention-row">
          <span class="attention-type">${badge(item.badgeMeta.label, item.badgeMeta.tone)}</span>
          <span class="attention-title">${escapeHtml(item.title)}</span>
          <span class="attention-owner">${escapeHtml(item.surfaceLabel)}</span>
          <span class="attention-owner">${escapeHtml(fmtRelative(item.ts))}</span>
        </div>
      `));
    });
    activityPanel.appendChild(list);
  }
  rowB.appendChild(homePanelWrap("span-6", activityPanel));

  // ---- Recent Conversations ----
  // Named for what these records actually are: almost all of them are
  // concluded historical conversations, not live sessions. A per-row
  // "Active Recently" badge is the only place liveness is ever implied
  // (only for Office's own traces, which have a genuine started-vs-
  // concluded gap; see groupInteractionsIntoConversations). Strictly
  // conversational — device/tool execution events never appear here.
  const conversations = groupInteractionsIntoConversations(traces, events);
  const conversationsPanel = homePanel("Recent Conversations");
  conversationsPanel.style.marginTop = "var(--space-4)";
  if (!conversations.length) {
    conversationsPanel.appendChild(el(`<p class="home-panel-empty">No conversations recorded yet.</p>`));
  } else {
    const list = el(`<div class="attention-list"></div>`);
    conversations.forEach((c) => {
      list.appendChild(el(`
        <div class="attention-row">
          <span class="attention-type">${escapeHtml(c.surfaceLabel)}</span>
          <span class="attention-title">${escapeHtml(c.summary)}</span>
          <span class="attention-owner">${badge(c.state, c.stateTone)}</span>
          <span class="attention-owner">${escapeHtml(fmtRelative(c.lastActivity))}</span>
        </div>
      `));
    });
    conversationsPanel.appendChild(list);
  }
  outlet.appendChild(conversationsPanel);

  // ---- System Health + Scheduled Tasks ----
  const rowC = el(`<div class="home-grid" style="margin-top:var(--space-4);"></div>`);
  outlet.appendChild(rowC);

  if (canViewHealth) {
    const healthPanel = homePanel("System Health");
    // Facility/Consumer sometimes probe successfully (ok:true) while
    // still missing a few non-critical export fields — real evidence
    // worth surfacing, but as a note under "Operational", not a
    // downgrade to "Degraded" (see healthPresentation's comment).
    const facilityIncomplete = integrations?.facility?.endpoint_health?.ok && !integrations?.facility?.payload?.complete;
    const consumerIncomplete = integrations?.consumer?.endpoint_health?.ok && !integrations?.consumer?.payload?.complete;
    const healthRows = [
      { label: "Oyi Core", presentation: healthPresentation(integrations?.edge?.backend_health) },
      // Self-evident: if this page rendered, Office itself is up — not
      // an inferred or fabricated value.
      { label: "Ochiga Office", presentation: { label: "Operational", tone: "green" } },
      // Real /api/health probe now, replacing the previous trace-
      // inference fallback — "Not Reporting" means exactly that: no
      // trustworthy health signal, never "no recent traffic."
      { label: "Ochiga Website", presentation: healthPresentation(integrations?.website?.endpoint_health) },
      { label: "Oyi Facility", presentation: healthPresentation(integrations?.facility?.endpoint_health), note: facilityIncomplete ? "Reachable; some export fields not yet reported" : undefined },
      { label: "Oyi Consumer", presentation: healthPresentation(integrations?.consumer?.endpoint_health), note: consumerIncomplete ? "Reachable; some export fields not yet reported" : undefined },
    ];
    const withSignal = healthRows.filter((r) => r.presentation.label !== "Not configured" && r.presentation.label !== "Not reporting");
    const healthyCount = withSignal.filter((r) => r.presentation.tone === "green").length;
    if (withSignal.length) {
      const allHealthy = healthyCount === withSignal.length;
      healthPanel.appendChild(el(`
        <div class="status-callout status-callout-${allHealthy ? "green" : "amber"}" style="margin-bottom:var(--space-3);">
          ${allHealthy ? "All reporting systems operational" : `${healthyCount} of ${withSignal.length} reporting systems healthy`}
        </div>
      `));
    }
    healthPanel.appendChild(FactGrid(healthRows.map((r) => ({
      label: r.label,
      html: `${badge(r.presentation.label, r.presentation.tone)}${(r.note || r.presentation.note) ? `<div style="font-size:10.5px;color:var(--text-tertiary);margin-top:3px;">${escapeHtml(r.note || r.presentation.note)}</div>` : ""}`,
    }))));
    rowC.appendChild(homePanelWrap("span-6", healthPanel));
  }

  const schedulePanel = homePanel("Scheduled Tasks");
  if (!canViewSchedules) {
    schedulePanel.appendChild(el(`<p class="home-panel-empty">Requires reports or content access.</p>`));
  } else if (demosFailed || contentFailed) {
    // Distinct from "no scheduled tasks" — the underlying source(s)
    // genuinely failed to load, not just came back empty.
    const failedSources = [demosFailed ? "demos" : null, contentFailed ? "scheduled content" : null].filter(Boolean).join(" and ");
    schedulePanel.appendChild(el(`<p class="home-panel-empty">Could not load ${escapeHtml(failedSources)} — scheduler view unavailable right now.</p>`));
  } else {
    const scheduleItems = [
      ...upcomingDemos.map((d) => ({ name: d.lead?.name ? `Demo — ${d.lead.name}` : "Demo call", when: d.scheduled_for })),
      ...upcomingContent.map((c) => ({ name: `Publish — ${c.title}`, when: c.scheduled_publish_at })),
    ].sort((a, b) => new Date(a.when) - new Date(b.when));
    if (!scheduleItems.length) {
      schedulePanel.appendChild(el(`<p class="home-panel-empty">No scheduled tasks recorded. Real demo bookings and scheduled content will appear here.</p>`));
    } else {
      schedulePanel.appendChild(FactGrid(scheduleItems.slice(0, 8).map((item) => ({
        label: item.name,
        html: `${escapeHtml(fmtDateTime(item.when))} <span style="color:var(--text-tertiary);">(${escapeHtml(fmtRelative(item.when))})</span>`,
      }))));
    }
  }
  rowC.appendChild(homePanelWrap("span-6", schedulePanel));

  // ---- Intelligence Insights ----
  // Every metric here is computed over the same fetched window as the
  // rest of the page (up to the 500 most recent traces + 500 most
  // recent cross-surface events — NOT scoped to the Interactions Over
  // Time range selector, which only rebuckets the same fetch for
  // display). Formulas, spelled out so they never become ambiguous
  // later:
  const insightCells = [];

  // Peak Activity = the hour-of-day (viewer's local time, 0-23) with the
  // most recorded interactions (traces + events combined) in the window.
  const hourCounts = new Map();
  allInteractions.forEach((item) => {
    const d = new Date(itemTimestamp(item));
    if (Number.isNaN(d.getTime())) return;
    const h = d.getHours();
    hourCounts.set(h, (hourCounts.get(h) || 0) + 1);
  });
  if (hourCounts.size) {
    const [peakHour] = Array.from(hourCounts.entries()).sort((a, b) => b[1] - a[1])[0];
    insightCells.push({ label: "Peak Activity", value: `${String(peakHour).padStart(2, "0")}:00`, icon: iconSvg("trend", "kpi-icon"), tone: "blue" });
  }

  // Most Active Surface = the OBSERVATORY_SURFACES entry with the
  // highest combined trace+event count (same surfaceCounts used by the
  // donut above).
  const activeSurfaceCounts = surfaceCounts.filter((s) => s.count > 0);
  if (activeSurfaceCounts.length) {
    const top = activeSurfaceCounts.slice().sort((a, b) => b.count - a.count)[0];
    insightCells.push({ label: "Most Active Surface", value: top.label, icon: iconSvg("briefing", "kpi-icon"), tone: "violet" });
  }

  // Avg Response Time (Office Chat) = mean of payload.latency_ms across
  // office_internal_chat_completed traces ONLY. office_internal_chat_
  // failed traces also carry a latency_ms (real elapsed time until the
  // call errored/timed out), but that measures time-to-failure, not
  // response latency — mixing it in would inflate/distort a metric
  // labeled "response time", so failures are deliberately excluded here
  // (they're already counted separately, in Success Rate below and the
  // Office Chat Failures KPI).
  const officeLatencies = traces.filter((t) => t.type === "office_internal_chat_completed" && Number.isFinite(t.payload?.latency_ms)).map((t) => t.payload.latency_ms);
  if (officeLatencies.length) {
    const avgMs = officeLatencies.reduce((sum, v) => sum + v, 0) / officeLatencies.length;
    insightCells.push({ label: "Avg Response Time (Office Chat)", value: `${(avgMs / 1000).toFixed(1)}s`, icon: iconSvg("lightning", "kpi-icon"), tone: "amber" });
  }

  // Office Chat Success Rate = office_internal_chat_completed count /
  // (office_internal_chat_completed + office_internal_chat_failed)
  // count. Scoped ONLY to the office_internal surface (Office's own
  // staff-facing Oyi chat) — the only trace type with an explicit,
  // unambiguous success/fail dichotomy, including network_error
  // failures (they ARE counted as failures in this denominator, not
  // dropped). Never presented as a system-wide success rate.
  const officeCompleted = traces.filter((t) => t.type === "office_internal_chat_completed").length;
  const officeFailed = traces.filter((t) => t.type === "office_internal_chat_failed").length;
  if (officeCompleted + officeFailed > 0) {
    const rate = Math.round((officeCompleted / (officeCompleted + officeFailed)) * 100);
    insightCells.push({ label: "Office Chat Success Rate", value: `${rate}%`, icon: iconSvg("audit", "kpi-icon"), tone: rate >= 90 ? "green" : "amber" });
  }

  // Consumer + Facility Success Rate = (events where surface is
  // consumer/facility, category=conversation, status=success) /
  // (same scope, any status) — the second, now-real success/fail
  // dichotomy this closure adds (every cross-surface event carries a
  // real status). Kept separate from Office Chat Success Rate rather
  // than merged into one blended number, same precision principle.
  const consumerFacilityConversations = events.filter((e) => e.category === "conversation" && (e.surface === "consumer" || e.surface === "facility"));
  if (consumerFacilityConversations.length) {
    const succeeded = consumerFacilityConversations.filter((e) => e.status === "success").length;
    const rate = Math.round((succeeded / consumerFacilityConversations.length) * 100);
    insightCells.push({ label: "Consumer + Facility Success Rate", value: `${rate}%`, icon: iconSvg("audit", "kpi-icon"), tone: rate >= 90 ? "green" : "amber" });
  }

  // Most Used Interaction Mode = the mode with the highest combined
  // trace+event count (same modeCounts used by the Interactions by Mode
  // donut above) — real today even though it will always read "Chat /
  // Text" until a genuine voice/vision turn exists anywhere.
  const modeEntries = Object.entries(modeCounts);
  if (modeEntries.length) {
    const [topMode] = modeEntries.sort((a, b) => b[1] - a[1])[0];
    insightCells.push({ label: "Most Used Interaction Mode", value: CANONICAL_MODE_LABELS[topMode] || titleCase(topMode), icon: iconSvg("observatory", "kpi-icon"), tone: "blue" });
  }
  if (insightCells.length) {
    const insightsPanel = homePanel("Intelligence Insights");
    insightsPanel.style.marginTop = "var(--space-4)";
    insightsPanel.appendChild(metricCellGrid(insightCells));
    outlet.appendChild(insightsPanel);
  }
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
  task: ["What should I do about this task?", "Should this be automated?"],
  automation: ["Summarize what this automation does.", "Has this been running reliably?"],
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
  automation: "automation_context",
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
  if (normalized.cards.length) {
    wrap.appendChild(renderResponseBlocks(normalized.cards));
  }
  if (!normalized.answer && !wrap.children.length) {
    wrap.appendChild(el(`<p>Oyi Core responded without a readable message field.</p>`));
  }
  return wrap;
}

// Oyi Conversational Runtime Completion Programme, Phase 4 — Adaptive
// response blocks (Ochiga-backend's ConversationBlock union in
// conversationAnswerPresentation.ts, surfaced to office_internal via
// OfficeInternalOyiCoreResponse.blocks). Deliberately restrained: reuses
// the existing .badge/.oyi-block-label language rather than inventing a
// new visual system. Unknown block types are skipped, not shown broken.
const BLOCK_STATUS_TONE_CLASS = {
  positive: "badge-green",
  warning: "badge-amber",
  critical: "badge-red",
  neutral: "badge-blue",
};
function renderResponseBlocks(blocks) {
  const wrap = el(`<div class="oyi-blocks"></div>`);
  blocks.forEach((block) => {
    const node = renderResponseBlock(block);
    if (node) wrap.appendChild(node);
  });
  return wrap;
}
function renderResponseBlock(block) {
  if (!block || typeof block !== "object") return null;
  switch (block.type) {
    case "table":
    case "record_list": {
      const columns = Array.isArray(block.columns) ? block.columns : [];
      const rows = Array.isArray(block.rows) ? block.rows : [];
      if (!columns.length || !rows.length) return null;
      const frag = el(`<div class="oyi-record-list"></div>`);
      if (block.title) frag.appendChild(el(`<div class="oyi-block-label">${escapeHtml(block.title)}</div>`));
      const table = el(`<table class="oyi-record-table"></table>`);
      const thead = el(`<thead><tr>${columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}</tr></thead>`);
      table.appendChild(thead);
      const tbody = el(`<tbody></tbody>`);
      rows.forEach((row) => {
        const tr = el(`<tr></tr>`);
        if (row.id != null) tr.setAttribute("data-id", String(row.id));
        columns.forEach((col) => {
          const raw = row[col.key];
          const cell = el(`<td></td>`);
          if (col.key === "status" && typeof raw === "string" && raw) {
            cell.appendChild(el(`<span class="badge">${escapeHtml(titleCase(raw))}</span>`));
          } else {
            cell.textContent = raw == null || raw === "" ? "—" : String(raw);
          }
          tr.appendChild(cell);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      frag.appendChild(table);
      if (block.total_count != null && rows.length < block.total_count) {
        frag.appendChild(el(`<div class="oyi-record-list-more">Showing ${rows.length} of ${block.total_count}${block.truncated ? " — ask to narrow the list" : ""}.</div>`));
      }
      return frag;
    }
    case "key_value": {
      const items = Array.isArray(block.items) ? block.items : [];
      if (!items.length) return null;
      const frag = el(`<div class="oyi-kv"></div>`);
      if (block.title) frag.appendChild(el(`<div class="oyi-block-label">${escapeHtml(block.title)}</div>`));
      const dl = el(`<dl class="oyi-kv-list"></dl>`);
      items.forEach((item) => {
        dl.appendChild(el(`<div class="oyi-kv-row"><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd></div>`));
      });
      frag.appendChild(dl);
      return frag;
    }
    case "status": {
      if (!block.label) return null;
      const toneClass = BLOCK_STATUS_TONE_CLASS[block.tone] || "";
      return el(`<div><span class="badge ${toneClass}">${escapeHtml(block.label)}</span></div>`);
    }
    case "warning":
    case "limitation": {
      if (!block.text) return null;
      const cls = block.type === "warning" ? "oyi-note oyi-note-warning" : "oyi-note oyi-note-limitation";
      return el(`<div class="${cls}">${escapeHtml(block.text)}</div>`);
    }
    default:
      return null;
  }
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
    } else if (action.tool === "office.create_automation") {
      // Opens the same New Automation wizard the Automations page uses —
      // no separate "AI automation" creation path. suggested_name only
      // pre-fills the Name field; staff still walk every wizard step
      // (When/If/Then/Scope/Owner/Review) and nothing is created until
      // they submit Review themselves.
      const btn = el(`<button type="button" class="btn btn-ghost btn-sm">Review &amp; Create Automation</button>`);
      btn.addEventListener("click", () => openNewAutomationWizard(() => invalidate("automations"), {
        name: action.parameters?.suggested_name ? String(action.parameters.suggested_name).slice(0, 120) : "",
      }));
      actionsRow.appendChild(btn);
    } else {
      actionsRow.appendChild(el(`<span class="hint">No in-app review action for "${escapeHtml(action.tool || action.name || "this")}" yet — nothing was created.</span>`));
    }
    row.appendChild(actionsRow);
    wrap.appendChild(row);
  });
  return wrap;
}

// Oyi Conversational Runtime Completion Programme, Phase 3 — Governed
// Action Proposals. A compact confirm/cancel card for a mutation Oyi
// proposed (task status/owner/due-date, meeting cancel, support
// resolve) — deliberately not a form: the exact operation and value
// were already understood conversationally, this only asks the staff
// member to approve or reject it.
// A single proposal's diff row (prev -> next), reused for both the
// single-record card and each child row of a batch card below.
function appendProposalDiffRow(row, proposal) {
  const prevEntry = proposal.previous_state ? Object.entries(proposal.previous_state)[0] : null;
  const nextEntry = proposal.proposed_state ? Object.entries(proposal.proposed_state)[0] : null;
  if (!prevEntry || !nextEntry) return;
  row.appendChild(el(`
    <div class="oyi-proposal-diff">
      <span class="oyi-proposal-from">${escapeHtml(titleCase(String(prevEntry[1] ?? "—")))}</span>
      <span class="oyi-proposal-arrow">→</span>
      <span class="oyi-proposal-to">${escapeHtml(titleCase(String(nextEntry[1] ?? "—")))}</span>
    </div>
  `));
}

function renderActionProposalCard(pendingAction) {
  const wrap = el(`<div class="oyi-structured oyi-action-proposal"></div>`);
  wrap.appendChild(el(`<div class="oyi-block-label">Oyi Proposes a Change</div>`));
  const row = el(`<div class="oyi-proposal"></div>`);
  row.appendChild(el(`<div class="oyi-proposal-reason">${escapeHtml(pendingAction.description)}</div>`));
  // Phase 4, PR 4 — a batch proposal (child_operations present) lists
  // each target's own from -> to diff instead of a single one; the
  // parent's own description already names every target, so this is
  // additional detail, not the only place the target list appears.
  if (Array.isArray(pendingAction.child_operations) && pendingAction.child_operations.length) {
    const list = el(`<ul class="oyi-list oyi-proposal-batch-list"></ul>`);
    pendingAction.child_operations.forEach((child) => {
      const item = el(`<li></li>`);
      appendProposalDiffRow(item, child);
      list.appendChild(item);
    });
    row.appendChild(list);
  } else {
    appendProposalDiffRow(row, pendingAction);
  }
  const actionsRow = el(`<div class="oyi-proposal-actions"></div>`);
  // btn-ghost/btn-sm, same as every existing renderApprovalSurface action
  // button — no new button prominence pattern introduced for this card.
  const confirmBtn = el(`<button type="button" class="btn btn-ghost btn-sm">Confirm</button>`);
  const cancelBtn = el(`<button type="button" class="btn btn-ghost btn-sm">Cancel</button>`);
  confirmBtn.addEventListener("click", () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    confirmOyiActionProposal(pendingAction);
  });
  cancelBtn.addEventListener("click", () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    cancelOyiActionProposal();
  });
  actionsRow.appendChild(confirmBtn);
  actionsRow.appendChild(cancelBtn);
  row.appendChild(actionsRow);
  wrap.appendChild(row);
  return wrap;
}

// Rebuilds the *_context slot from the record a successful PATCH just
// returned, reusing the SAME structured-context helpers each detail page
// already uses (taskOyiContext/meetingOyiContext/supportOyiContext) —
// not a second formatter. Cross-reference fields those helpers can take
// (related meeting, follow-up task, contact/org) are intentionally
// omitted here: this only needs the mutated field to be fresh for Oyi's
// next turn to verify against, not a full detail-page re-render.
const OFFICE_ACTION_DOMAIN_CONTEXT_BUILDER = {
  office_tasks: (record) => taskOyiContext(record),
  office_meetings: (record) => meetingOyiContext(record),
  office_support: (record) => supportOyiContext(record),
};
const OFFICE_ACTION_DOMAIN_SELECTED_TYPE = { office_tasks: "task", office_meetings: "meeting", office_support: "support_case" };

// Confirm click performs the REAL mutation through Office's own existing,
// already-permission-checked, already-audited apiPatchOperational route
// (the same one every manual "Mark In Progress" button already uses) —
// Backend never executes this itself, only proposes it and, once the
// patch has actually succeeded, verifies the resulting state. See
// officeActionProposal.ts in Ochiga-backend for the full design note.
// Phase 4, PR 4 — iterates each child's own execute_directive through
// the SAME apiPatchOperational route the single-record path uses below,
// one call per target, collecting per-child success/failure honestly (a
// failed PATCH is reported, never silently dropped). Rebuilds one
// task_batch_context entry per successfully-patched record (same
// taskOyiContext() shape the single-record rebuild already uses) and
// resends the whole array for Backend's batch VERIFY turn.
async function confirmBatchActionProposal(confirmed) {
  const children = confirmed.child_operations;
  const batchContextEntries = [];
  let failedCount = 0;
  for (const child of children) {
    const directive = child.execute_directive;
    if (!directive) {
      failedCount += 1;
      continue;
    }
    try {
      const patched = await apiPatchOperational(directive.namespace, directive.collection, directive.record_id, directive.patch);
      if (patched?.record) {
        batchContextEntries.push(taskOyiContext(patched.record));
        invalidate(directive.collection);
      } else {
        failedCount += 1;
      }
    } catch (err) {
      failedCount += 1;
    }
  }
  if (!batchContextEntries.length) {
    appendOyiMessage("system", "Could not make any of those changes — please try again.");
    // Phase 4, PR 5 — reports the failure so Oyi closes the proposal out
    // immediately instead of leaving it "confirmed" until its 10-minute
    // TTL expires.
    await callOyiChat("The change could not be made.", { execution_failed: true, execution_failure_reason: "All batch updates failed" }).catch(() => {});
    return;
  }
  const verifyTurn = await callOyiChat("Yes, do it.", { task_batch_context: batchContextEntries });
  appendOyiMessage("assistant", renderOyiResponse(verifyTurn.normalized));
  if (failedCount) {
    appendOyiMessage("system", `${failedCount} of ${children.length} change${children.length === 1 ? "" : "s"} could not be sent — please check ${failedCount === 1 ? "it" : "them"} directly.`);
  }
}

async function confirmOyiActionProposal(pendingAction) {
  appendOyiMessage("user", "Yes, do it.");
  state.oyiBusy = true;
  setOyiPresence("thinking");
  try {
    const confirmedTurn = await callOyiChat("Yes, do it.");
    const confirmed = confirmedTurn.data.oyi_core?.pending_action;
    if (confirmed?.status !== "confirmed") {
      appendOyiMessage("system", confirmedTurn.normalized.answer || "Oyi couldn't confirm that action — please try again.");
      return;
    }
    if (Array.isArray(confirmed.child_operations) && confirmed.child_operations.length) {
      await confirmBatchActionProposal(confirmed);
      return;
    }
    const directive = confirmed.execute_directive;
    if (!directive) {
      appendOyiMessage("system", confirmedTurn.normalized.answer || "Oyi couldn't confirm that action — please try again.");
      return;
    }
    let patched;
    try {
      patched = await apiPatchOperational(directive.namespace, directive.collection, directive.record_id, directive.patch);
    } catch (err) {
      appendOyiMessage("system", `Could not make that change: ${err.message || "the request failed"}.`);
      // Phase 4, PR 5 — reports the failure so Oyi closes the proposal
      // out immediately instead of leaving it "confirmed" until its
      // 10-minute TTL expires.
      await callOyiChat("The change could not be made.", { execution_failed: true, execution_failure_reason: String(err.message || "the request failed") }).catch(() => {});
      return;
    }
    const builder = OFFICE_ACTION_DOMAIN_CONTEXT_BUILDER[confirmed.domain];
    const selectedType = OFFICE_ACTION_DOMAIN_SELECTED_TYPE[confirmed.domain];
    if (builder && selectedType && patched?.record) {
      setSelectedObject(selectedType, patched.record.id, patched.record.title || (state.selectedObject && state.selectedObject.label) || "", builder(patched.record));
    }
    invalidate(directive.collection);
    const verifyTurn = await callOyiChat("Yes, do it.");
    appendOyiMessage("assistant", renderOyiResponse(verifyTurn.normalized));
  } catch (err) {
    appendOyiMessage("system", "Could not confirm that action. Please try again.");
  } finally {
    state.oyiBusy = false;
    setOyiPresence("idle");
  }
}

async function cancelOyiActionProposal() {
  appendOyiMessage("user", "No.");
  state.oyiBusy = true;
  setOyiPresence("thinking");
  try {
    const turn = await callOyiChat("No.");
    appendOyiMessage("assistant", renderOyiResponse(turn.normalized));
  } catch (err) {
    appendOyiMessage("system", "Could not reach Oyi. Please try again.");
  } finally {
    state.oyiBusy = false;
    setOyiPresence("idle");
  }
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

// Oyi Conversational Runtime Completion Programme, Phase 2 — a client-
// generated thread id, kept only in memory (never localStorage/
// sessionStorage), so a page reload naturally starts a genuinely new
// conversation with nothing to inherit from the last one.
function newOyiThreadId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Fallback v4 UUID for older browsers without crypto.randomUUID.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Core network call, extracted so the confirm/cancel round-trips (which
// must NOT show every intermediate turn as a chat bubble) can drive it
// directly instead of going through sendOyiMessage's always-visible
// user/assistant bubble pair.
async function callOyiChat(message, extraBody) {
  if (!state.oyiThreadId) state.oyiThreadId = newOyiThreadId();
  const data = await api("/api/lead-agents/admin/office/intelligence/chat", {
    method: "POST",
    body: {
      message,
      conversation_thread_id: state.oyiThreadId,
      page_context: currentPageContext(),
      ...currentSelectedObjectContext(),
      ...(extraBody || {}),
    },
  });
  const { normalizeOfficeInternalResponse } = await import("/office/shared/oyi-core/responseNormalizer.mjs");
  const normalized = normalizeOfficeInternalResponse(data.oyi_core || {}, data.proposed_actions);
  // Backend echoes back the thread id it actually persisted under —
  // normally identical to what was just sent, but this keeps the
  // client authoritative to whatever Backend decided rather than
  // assuming they always match.
  if (normalized.threadId) state.oyiThreadId = normalized.threadId;
  return { data, normalized };
}

async function sendOyiMessage(message) {
  if (!message.trim() || state.oyiBusy) return;
  appendOyiMessage("user", message);
  state.oyiBusy = true;
  document.getElementById("oyiSend").disabled = true;
  setOyiPresence("thinking");

  try {
    const { data, normalized } = await callOyiChat(message);
    appendOyiMessage("assistant", renderOyiResponse(normalized));
    if (normalized.toolProposals.length) {
      appendOyiMessage("system", renderApprovalSurface(normalized.toolProposals));
    }
    const pendingAction = data.oyi_core?.pending_action;
    if (pendingAction && pendingAction.status === "pending") {
      appendOyiMessage("system", renderActionProposalCard(pendingAction));
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
    state.oyiThreadId = null;
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
