// Ochiga Office — corporate shell (Phase 2: Home + CRM).
//
// Phase 1 (shell/nav/layout/tokens/permission-aware nav/persistent Oyi
// control/shared states) is preserved as-is. Phase 2 adds:
//   - a real Office Home / Attention view
//   - a CRM workspace: Overview, Leads, Contacts, Organizations,
//     Opportunities, each with list + shared object-detail views
//   - a generalized nested hash router (#/crm/leads/:id etc.)
//   - a shared timeline component and object-detail shell
//   - contextual Oyi intelligence (page + selected object)
//
// Every screen renders only from real backend contracts already
// documented in this repo. No independent reasoning happens here and
// nothing is fabricated — see PHASE2_REPORT notes inline where a
// backend limitation shapes what's shown.
//
// Backend contracts used (all pre-existing, none altered):
//   GET  /api/lead-agents/admin/session/me
//   POST /api/lead-agents/admin/session/login
//   POST /api/lead-agents/admin/session/logout
//   POST /api/lead-agents/admin/office/intelligence/chat
//   GET  /api/lead-agents/admin/office/home
//   GET  /api/lead-agents/leads
//   GET  /api/lead-agents/leads/:id
//   PATCH /api/lead-agents/leads/:id
//   GET  /api/lead-agents/leads/:id/timeline
//   GET  /api/lead-agents/leads/:id/proposals
//   GET  /api/lead-agents/leads/:id/conversations
//   GET/POST /api/lead-agents/admin/crm/{contacts|organizations|opportunities|activities|tasks}
//   GET/POST /api/lead-agents/admin/office/meetings

const state = {
  admin: null,
  segments: ["home"],
  selectedObject: null, // { type, id, label } | null — drives Oyi page_context
  renderToken: 0,
  oyiOpen: false,
  oyiBusy: false,
  oyiThreadStarted: false,
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
// Tasks/Meetings are deliberately not top-level destinations; they
// surface contextually inside object detail views (see below).
// ---------------------------------------------------------------
const PRIMARY_NAV = [
  { key: "home", label: "Home", permission: "office.read", phase: null },
  { key: "crm", label: "CRM", permission: "crm.read", phase: null },
  { key: "projects", label: "Projects", permission: "projects.read", phase: 3 },
  { key: "portfolio", label: "Portfolio", permission: "portfolio.read", phase: 3 },
  { key: "support", label: "Support", permission: "support.read", phase: 3 },
  { key: "private", label: "Private", permission: "private.read", phase: 4 },
  { key: "partnerships", label: "Partnerships", permission: "partnerships.read", phase: 4 },
  { key: "documents", label: "Documents", permission: "documents.generate", phase: 5 },
];

const ADMIN_NAV = [
  { key: "team", label: "Team", permission: "staff.manage", phase: null },
  { key: "settings", label: "Settings", permission: "settings.manage", phase: null },
  { key: "audit", label: "Audit", permission: "audit.read", phase: null },
];

const VIEW_COPY = {
  projects: "Actual Ochiga projects and engagements being executed — real estate development, technology deployments and other corporate projects.",
  portfolio: "Corporate-level visibility across relevant Ochiga assets, buildings and deployments — a projection, not a duplicate of Facility or Consumer operational truth.",
  support: "Corporate and customer support cases and escalations, distinct from the Facility/Consumer incidents they may reference.",
  private: "Ochiga Private relationship, member and investor workflow — relationship-oriented, not an investment marketplace.",
  partnerships: "Landowner, capital, buyer/offtake, delivery, technology/integration and strategic partner relationships.",
  documents: "Quotations, proposals and drafts built from approved Office truth — Oyi will never invent a price here.",
  team: "Staff accounts, roles and invitations. Available today in the legacy dashboard while this shell is rebuilt module by module.",
  settings: "Platform configuration and integrations. Available today in the legacy dashboard while this shell is rebuilt module by module.",
  audit: "The Office audit trail. Available today in the legacy dashboard while this shell is rebuilt module by module.",
};

function allNavItems() {
  return [...PRIMARY_NAV, ...ADMIN_NAV];
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
function titleCase(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function skeletonPanel(lines = 3) {
  const widths = ["70%", "45%", "60%", "38%"];
  return el(`
    <div class="state-panel">
      ${Array.from({ length: lines }).map((_, i) => `<div class="skeleton-line" style="width:${widths[i % widths.length]}"></div>`).join("")}
    </div>
  `);
}
function emptyPanel({ kicker, title, body }) {
  return el(`
    <div class="state-panel">
      <div class="kicker">${escapeHtml(kicker)}</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${body}</p>
    </div>
  `);
}
function errorPanel(message) {
  return el(`
    <div class="state-panel error">
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
  if (/won|approved|active|resolved|completed|done/.test(v)) return "green";
  if (/lost|cancelled|declined|closed|overdue/.test(v)) return "red";
  if (/pending|review|awaiting|open|new/.test(v)) return "amber";
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
function renderDetailShell(outlet, { type, id, label, typeLine, badges, backLabel, onBack, mainSections, railSections }) {
  setSelectedObject(type, id, label);
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

function railCard(title, contentNodeOrHtml) {
  const card = el(`<div class="rail-card"><h4>${escapeHtml(title)}</h4></div>`);
  if (contentNodeOrHtml instanceof Node) card.appendChild(contentNodeOrHtml);
  else card.insertAdjacentHTML("beforeend", contentNodeOrHtml);
  return card;
}
function railList(items, renderItem) {
  if (!items.length) return `<p class="rail-empty">None</p>`;
  return `<ul class="rail-list">${items.map((item) => `<li>${renderItem(item)}</li>`).join("")}</ul>`;
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
function setSelectedObject(type, id, label) {
  state.selectedObject = type ? { type, id, label } : null;
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
    kicker: item.phase ? "Not yet built" : "Available in legacy dashboard",
    title: item.phase ? `${item.label} lands in Phase ${item.phase}` : `${item.label}`,
    body: VIEW_COPY[item.key] || "",
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

async function renderHomeView(outlet, token) {
  let home;
  try {
    home = await getHome().then((d) => d.home);
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

  outlet.innerHTML = "";
  outlet.appendChild(el(`
    <div class="view-heading">
      <h1>Home</h1>
      <p>What needs attention across Ochiga's operating environment.</p>
    </div>
  `));

  outlet.appendChild(renderHomeSection("Needs Attention", visibleItems, "Nothing needs attention right now."));
  outlet.appendChild(renderHomeSection("My Work", mine, "Nothing assigned to you right now."));

  // Commercial movement — leads with meaningful recent change, permission-gated.
  if (hasPermission("crm.read")) {
    try {
      const leads = await fetchLeads();
      if (token !== state.renderToken) return;
      const moved = leads
        .filter((lead) => lead.updated_at)
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .slice(0, 6);
      outlet.appendChild(renderCommercialMovement(moved));
    } catch {
      outlet.appendChild(errorPanel("Could not load recent commercial movement."));
    }
  }

  outlet.appendChild(renderRecentActivitySection(home.recent_activity || []));
  outlet.appendChild(renderAskOyiCard());
}

function renderHomeSection(title, items, emptyText) {
  const section = el(`<div class="home-section"><h3>${escapeHtml(title)}</h3></div>`);
  if (!items.length) {
    section.appendChild(emptyPanel({ kicker: title, title: "All clear", body: emptyText }));
    return section;
  }
  const list = el(`<div class="attention-list"></div>`);
  items.forEach((item) => {
    const row = el(`
      <div class="attention-row">
        <span class="attention-type">${escapeHtml(titleCase(item.type))}</span>
        <span class="attention-title">${escapeHtml(item.title || "Untitled")}</span>
        ${badge(titleCase(item.priority || "normal"), toneForStatus(item.priority))}
        <span class="attention-owner">${escapeHtml(item.owner || "Unassigned")}</span>
      </div>
    `);
    if (item.type === "lead") {
      row.classList.add("clickable");
      row.addEventListener("click", () => navigate(`crm/leads/${item.id}`));
    }
    list.appendChild(row);
  });
  section.appendChild(list);
  return section;
}

function renderCommercialMovement(leads) {
  const section = el(`<div class="home-section"><h3>Commercial Movement</h3></div>`);
  section.appendChild(renderDataTable({
    columns: [
      { label: "Lead", key: "name", render: (l) => escapeHtml(l.company || l.name || "Untitled") },
      { label: "Stage", render: (l) => badge(titleCase(l.stage || l.status || "new"), toneForStatus(l.stage || l.status)) },
      { label: "Owner", render: (l) => escapeHtml(l.owner || "Unassigned") },
      { label: "Updated", render: (l) => escapeHtml(fmtRelative(l.updated_at)) },
    ],
    rows: leads,
    onRowClick: (lead) => navigate(`crm/leads/${lead.id}`),
    emptyMessage: "No recent commercial movement.",
  }));
  return section;
}

function renderRecentActivitySection(activities) {
  const section = el(`<div class="home-section"><h3>Recent Activity</h3></div>`);
  const recent = [...activities]
    .sort((a, b) => String(b.occurred_at || b.created_at || "").localeCompare(String(a.occurred_at || a.created_at || "")))
    .slice(0, 6);
  section.appendChild(renderTimeline(recent));
  return section;
}

function renderAskOyiCard() {
  const section = el(`<div class="home-section"><h3>Ask Oyi</h3></div>`);
  const card = el(`
    <div class="state-panel ask-oyi-card">
      <p>Try: "Show me the leads that need attention today" or "Which opportunities haven't been followed up this week?"</p>
    </div>
  `);
  const btn = el(`<button type="button" class="btn btn-primary btn-sm">Open Oyi</button>`);
  btn.addEventListener("click", openOyiPanel);
  card.appendChild(btn);
  section.appendChild(card);
  return section;
}

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

  const hotLeads = leads.filter((lead) => Number(lead.score || lead.lead_score || 0) >= 70 || /follow|proposal|demo|meeting/i.test(String(lead.next_action || "")));
  body.appendChild(el(`<div class="overview-section"><h3>Leads Needing Attention <span class="count-pill">${hotLeads.length}</span></h3></div>`));
  body.lastElementChild.appendChild(renderDataTable({
    columns: [
      { label: "Lead", render: (l) => escapeHtml(l.company || l.name || "Untitled") },
      { label: "Next Action", render: (l) => escapeHtml(l.next_action || "—") },
      { label: "Owner", render: (l) => escapeHtml(l.owner || "Unassigned") },
    ],
    rows: hotLeads.slice(0, 8),
    onRowClick: (lead) => navigate(`crm/leads/${lead.id}`),
    emptyMessage: "No leads currently need attention.",
  }));

  const stageGroups = {};
  opportunities.forEach((opp) => {
    const stage = opp.stage || "intake_received";
    (stageGroups[stage] = stageGroups[stage] || []).push(opp);
  });
  const stageSection = el(`<div class="overview-section"><h3>Opportunities by Stage</h3></div>`);
  const strip = el(`<div class="stage-strip"></div>`);
  Object.entries(stageGroups)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([stage, items]) => {
      const chip = el(`<div class="stage-chip"><span class="stage-count">${items.length}</span><span>${escapeHtml(titleCase(stage))}</span></div>`);
      strip.appendChild(chip);
    });
  if (!opportunities.length) strip.appendChild(el(`<p class="rail-empty">No opportunities recorded yet.</p>`));
  stageSection.appendChild(strip);
  body.appendChild(stageSection);

  const recentPeople = [...contacts, ...organizations.map((o) => ({ ...o, __org: true }))]
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .slice(0, 6);
  const peopleSection = el(`<div class="overview-section"><h3>Recently Active Contacts &amp; Organizations</h3></div>`);
  peopleSection.appendChild(renderDataTable({
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
  body.appendChild(peopleSection);

  const buDistribution = {};
  [...leads, ...opportunities].forEach((r) => {
    const bu = r.business_unit || "corporate";
    buDistribution[bu] = (buDistribution[bu] || 0) + 1;
  });
  const buSection = el(`<div class="overview-section"><h3>Business Unit Distribution</h3></div>`);
  const buStrip = el(`<div class="stage-strip"></div>`);
  Object.entries(buDistribution).forEach(([bu, count]) => {
    buStrip.appendChild(el(`<div class="stage-chip"><span class="stage-count">${count}</span><span>${escapeHtml(titleCase(bu))}</span></div>`));
  });
  if (!Object.keys(buDistribution).length) buStrip.appendChild(el(`<p class="rail-empty">No records yet.</p>`));
  buSection.appendChild(buStrip);
  body.appendChild(buSection);
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
      { label: "Source", render: (r) => escapeHtml(titleCase(r.source)) },
      { label: "Status", render: (r) => badge(titleCase(r.status || r.stage || "new"), toneForStatus(r.status || r.stage)) },
      { label: "Owner", render: (r) => escapeHtml(r.owner || "Unassigned") },
      { label: "Next Action", render: (r) => escapeHtml(r.next_action || "—") },
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

  const listState = { query: "", filters: {}, mineOnly: false };

  function draw() {
    let rows = records;
    if (listState.mineOnly) rows = rows.filter((r) => isMine(r.owner));
    Object.entries(listState.filters).forEach(([field, value]) => {
      if (value) rows = rows.filter((r) => String(r[field] || "") === value);
    });
    if (listState.query) {
      const q = listState.query.toLowerCase();
      rows = rows.filter((r) => config.searchFields.some((field) => String(r[field] || "").toLowerCase().includes(q)));
    }
    resultsHost.innerHTML = "";
    resultsHost.appendChild(renderDataTable({
      columns: config.columns,
      rows,
      onRowClick: (row) => navigate(`crm/${key}/${row.id}`),
      emptyMessage: records.length ? "No records match your filters." : "No records yet.",
    }));
    countLabel.textContent = `${rows.length} of ${records.length}`;
  }

  body.innerHTML = "";
  const heading = el(`<div class="view-heading"><h1>${escapeHtml(titleCase(key))}</h1><span class="count-pill" id="crmListCount"></span></div>`);
  body.appendChild(heading);
  const countLabel = heading.querySelector("#crmListCount");

  const filterDefs = config.filters.map((filter) => ({
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
    secondaryAction: {
      label: "My Records",
      onClick: (event) => {
        listState.mineOnly = !listState.mineOnly;
        event.target.classList.toggle("active", listState.mineOnly);
        draw();
      },
    },
    primaryAction: hasPermission(config.manage) ? { label: "New", onClick: () => openCreateDialog(key) } : null,
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
  const [lead, timeline, proposals] = await Promise.all([
    apiGetLead(id),
    apiGetLeadTimeline(id).then((d) => d.timeline).catch(() => []),
    hasPermission("documents.generate") ? apiGetLeadProposals(id).then((d) => d.proposals).catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  const record = lead.lead;
  if (!record) {
    body.innerHTML = "";
    body.appendChild(errorPanel("This lead could not be found."));
    return;
  }

  const [activities, tasks] = await Promise.all([
    fetchActivities().catch(() => []),
    hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  const ownActivities = activities.filter((a) => a.lead_id === id);
  const ownTasks = tasks.filter((t) => t.lead_id === id);
  const combinedTimeline = [...timeline, ...ownActivities];
  const canManage = hasPermission("crm.manage");

  const mainSections = [];
  mainSections.push(el(`
    <div class="detail-section">
      <h3>Relationship Summary</h3>
      <div class="fact-grid">
        ${factRow("Email", record.email)}
        ${factRow("Phone", record.phone)}
        ${factRow("Business Unit", titleCase(record.business_unit))}
        ${factRow("Source", titleCase(record.source))}
        ${factRow("Next Action", record.next_action)}
        ${factRow("Summary", record.summary)}
      </div>
    </div>
  `));
  if (canManage) mainSections.push(renderLeadUpdateForm(record));
  mainSections.push(renderTimeline(combinedTimeline, {
    canAddNote: canManage,
    onAddNote: () => promptAddNote({ lead_id: id }),
  }));

  const railSections = [];
  if (hasPermission("tasks.read")) {
    railSections.push(railCard("Tasks", railList(ownTasks, (t) => `${escapeHtml(t.title)} <span class="rail-sub">${escapeHtml(titleCase(t.status))}</span>`)));
  }
  if (hasPermission("documents.generate")) {
    railSections.push(railCard("Proposals", railList(proposals, (p) => `${escapeHtml(p.tier_name || "Proposal")} <span class="rail-sub">${escapeHtml(titleCase(p.status))}</span>`)));
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
  });
}

function factRow(label, value) {
  return `<div class="fact"><span class="fact-label">${escapeHtml(label)}</span><span class="fact-value">${escapeHtml(value || "—")}</span></div>`;
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
      <button type="submit" class="btn btn-primary btn-sm">Save</button>
      <span class="form-status"></span>
    </form>
  `);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const statusLabel = form.querySelector(".form-status");
    const formData = new FormData(form);
    try {
      await apiUpdateLead(record.id, {
        status: formData.get("status"),
        owner: formData.get("owner"),
        next_action: formData.get("next_action"),
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
  const [contacts, organizations, opportunities, activities, meetings] = await Promise.all([
    fetchContacts(), fetchOrganizations(), fetchOpportunities(), fetchActivities(), hasPermission("meetings.read") ? fetchMeetings().catch(() => []) : Promise.resolve([]),
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
  });
}

async function renderOrganizationDetail(body, id, token) {
  const [organizations, contacts, opportunities, activities, meetings] = await Promise.all([
    fetchOrganizations(), fetchContacts(), fetchOpportunities(), fetchActivities(), hasPermission("meetings.read") ? fetchMeetings().catch(() => []) : Promise.resolve([]),
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
  });
}

async function renderOpportunityDetail(body, id, token) {
  const [opportunities, contacts, organizations, leads, activities, tasks] = await Promise.all([
    fetchOpportunities(), fetchContacts(), fetchOrganizations(),
    // GET /api/lead-agents/leads is gated on office.read (legacy
    // view_dashboard alias), not crm.read — matches the actual route.
    hasPermission("office.read") ? fetchLeads().catch(() => []) : Promise.resolve([]),
    fetchActivities(), hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
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
        <p class="detail-note">Value is not shown — this backend does not currently own trustworthy opportunity value data. Commercial figures live with approved documents (see Documents, Phase 5).</p>
      </div>
    `),
    renderTimeline(relatedActivities, { canAddNote: canManage, onAddNote: () => promptAddNote({ opportunity_id: id }) }),
  ];

  const railSections = [];
  if (contact) railSections.push(railCard("Contact", `<a href="#/crm/contacts/${contact.id}">${escapeHtml(contact.name)}</a>`));
  if (org) railSections.push(railCard("Organization", `<a href="#/crm/organizations/${org.id}">${escapeHtml(org.name)}</a>`));
  if (originLead) railSections.push(railCard("Originating Lead", `<a href="#/crm/leads/${originLead.id}">${escapeHtml(originLead.company || originLead.name)}</a>`));
  if (hasPermission("tasks.read")) railSections.push(railCard("Tasks", railList(relatedTasks, (t) => `${escapeHtml(t.title)} <span class="rail-sub">${escapeHtml(titleCase(t.status))}</span>`)));

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
    fieldsHost.appendChild(el(`
      <label>${escapeHtml(field.label)}
        ${field.type === "textarea" ? `<textarea name="${field.name}" rows="3"></textarea>` : `<input name="${field.name}" type="${field.type || "text"}" />`}
      </label>
    `));
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
  const button = el(`<button class="nav-item" data-nav-key="${item.key}" type="button"><span class="dot"></span><span>${escapeHtml(item.label)}</span></button>`);
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
  document.getElementById("navAvatar").textContent = initials || "?";
  document.getElementById("navUserName").textContent = state.admin.display_name || state.admin.email;
  document.getElementById("navUserRole").textContent = (state.admin.role || "").replace(/_/g, " ");
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

function appendOyiMessage(role, contentNodeOrText) {
  const thread = document.getElementById("oyiThread");
  const bubble = el(`<div class="oyi-msg ${role}"></div>`);
  if (contentNodeOrText instanceof Node) bubble.appendChild(contentNodeOrText);
  else bubble.textContent = contentNodeOrText;
  thread.appendChild(bubble);
  thread.scrollTop = thread.scrollHeight;
}

// Defensive structured-response rendering: Oyi Core's response schema
// isn't documented in this repo (external system), so this renders
// whichever of these common shapes are present rather than assuming
// one. Plain prose always falls back to a normal bubble.
function renderOyiResponse(oyiCore) {
  const wrap = el(`<div class="oyi-structured"></div>`);
  const message = oyiCore.message || oyiCore.reply || oyiCore.text || oyiCore.summary;
  if (message) wrap.appendChild(el(`<p>${escapeHtml(message)}</p>`));

  if (Array.isArray(oyiCore.recommendations) && oyiCore.recommendations.length) {
    const list = el(`<ul class="oyi-list"></ul>`);
    oyiCore.recommendations.forEach((rec) => list.appendChild(el(`<li>${escapeHtml(typeof rec === "string" ? rec : rec.text || JSON.stringify(rec))}</li>`)));
    wrap.appendChild(el(`<div class="oyi-block-label">Recommendations</div>`));
    wrap.appendChild(list);
  }
  if (Array.isArray(oyiCore.next_actions) && oyiCore.next_actions.length) {
    const list = el(`<ul class="oyi-list"></ul>`);
    oyiCore.next_actions.forEach((action) => list.appendChild(el(`<li>${escapeHtml(typeof action === "string" ? action : action.text || JSON.stringify(action))}</li>`)));
    wrap.appendChild(el(`<div class="oyi-block-label">Next Actions</div>`));
    wrap.appendChild(list);
  }
  if (Array.isArray(oyiCore.table) && oyiCore.table.length) {
    wrap.appendChild(el(`<div class="oyi-block-label">Details</div>`));
    const columns = Object.keys(oyiCore.table[0]);
    wrap.appendChild(renderDataTable({
      columns: columns.map((c) => ({ label: titleCase(c), key: c })),
      rows: oyiCore.table,
      emptyMessage: "",
    }));
  }
  if (!message && !wrap.children.length) {
    wrap.appendChild(el(`<p>Oyi Core responded without a readable message field.</p>`));
  }
  return wrap;
}

async function sendOyiMessage(message) {
  if (!message.trim() || state.oyiBusy) return;
  appendOyiMessage("user", message);
  state.oyiBusy = true;
  document.getElementById("oyiSend").disabled = true;

  try {
    const data = await api("/api/lead-agents/admin/office/intelligence/chat", {
      method: "POST",
      body: { message, page_context: currentPageContext() },
    });
    appendOyiMessage("assistant", renderOyiResponse(data.oyi_core || {}));
    if (Array.isArray(data.proposed_actions) && data.proposed_actions.length) {
      const summary = data.proposed_actions.map((action) => action.tool || action.name).join(", ");
      appendOyiMessage("system", `Oyi proposed: ${summary}. Approval workflow isn't available yet — no action was taken.`);
    }
  } catch (err) {
    if (err.status === 503) appendOyiMessage("system", "Oyi Core is unavailable right now. Nothing was answered from a separate reasoning path — please try again shortly.");
    else if (err.status === 403) appendOyiMessage("system", "You don't have permission to use Office intelligence.");
    else appendOyiMessage("system", "Could not reach Oyi. Please try again.");
  } finally {
    state.oyiBusy = false;
    document.getElementById("oyiSend").disabled = false;
  }
}

function openOyiPanel() {
  const control = document.getElementById("oyiControl");
  control.classList.add("open");
  document.getElementById("oyiBar").setAttribute("aria-expanded", "true");
  document.getElementById("oyiInput").focus();
  if (!state.oyiThreadStarted) {
    state.oyiThreadStarted = true;
    appendOyiMessage("system", "Ask about what you're looking at, or anything else across Office.");
  }
}
function wireOyiControl() {
  const control = document.getElementById("oyiControl");
  const bar = document.getElementById("oyiBar");
  const closeBtn = document.getElementById("oyiClose");
  const composer = document.getElementById("oyiComposer");
  const input = document.getElementById("oyiInput");

  bar.addEventListener("click", openOyiPanel);
  bar.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openOyiPanel();
    }
  });
  closeBtn.addEventListener("click", () => {
    control.classList.remove("open");
    bar.setAttribute("aria-expanded", "false");
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
// Boot
// ---------------------------------------------------------------
function showShell() {
  document.body.classList.remove("auth-logged-out");
  renderNav();
  renderUserFooter();
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
  document.getElementById("navToggle").addEventListener("click", openNav);
  document.getElementById("navScrim").addEventListener("click", closeNav);
}

async function boot() {
  wireLogin();
  wireShellChrome();
  wireOyiControl();
  const authed = await fetchSession();
  if (authed) showShell();
  else showLogin();
}

boot();
