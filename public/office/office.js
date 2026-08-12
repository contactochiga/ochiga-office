// Ochiga Office — corporate shell (Phase 3: Projects + Portfolio +
// Support + Tasks + Meetings).
//
// Phase 1 (shell/nav/layout/tokens/permission-aware nav/persistent Oyi
// control/shared states) and Phase 2 (Home/Attention + CRM) are
// preserved as-is. Phase 3 turns the remaining core operational
// placeholders into real modules on the same shared architecture:
//   - Projects: real Ochiga projects/engagements (office_projects)
//   - Portfolio: corporate-level view of buildings/deployments —
//     a safe projection, never Facility/Consumer internals
//   - Support: Ochiga-level support cases/escalations
//   - Tasks: a cross-company work view over crm_tasks
//   - Meetings: a lightweight corporate meeting workspace
// All five reuse the Phase 2 shared list/detail/timeline/Oyi
// primitives (renderStandardList, renderDetailShell, renderTimeline,
// railCard, badge/toneForStatus) — no new page pattern was invented.
//
// Every screen renders only from real backend contracts already
// documented in this repo. No independent reasoning happens here and
// nothing is fabricated — see inline notes where a backend limitation
// (usually: list+create only, no update/status-transition endpoint)
// shapes what's shown. See PHASE3_REPORT for the full list.
//
// Backend contracts used (all pre-existing, none altered):
//   GET  /api/lead-agents/admin/session/me
//   POST /api/lead-agents/admin/session/login
//   POST /api/lead-agents/admin/session/logout
//   POST /api/lead-agents/admin/office/intelligence/chat
//   GET  /api/lead-agents/admin/office/home
//   GET  /api/lead-agents/leads
//   GET  /api/lead-agents/leads/:id
//   PATCH /api/lead-agents/leads/:id  (sparse — hardened, no more full-record workaround)
//   GET  /api/lead-agents/leads/:id/timeline
//   GET  /api/lead-agents/leads/:id/proposals
//   GET  /api/lead-agents/leads/:id/conversations
//   GET/POST /api/lead-agents/admin/crm/{contacts|organizations|opportunities|activities|tasks}
//   GET/POST /api/lead-agents/admin/office/{projects|portfolio|support|meetings}
//   None of the above support PATCH/DELETE except the lead endpoint —
//   Projects/Portfolio/Support/Tasks/Meetings/Contacts/Organizations/
//   Opportunities/Activities remain list+create only on the backend.

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
    } else if (item.type === "support_case") {
      row.classList.add("clickable");
      row.addEventListener("click", () => navigate(`support/${item.id}`));
    } else if (item.type === "task") {
      row.classList.add("clickable");
      row.addEventListener("click", () => navigate(`tasks/${item.id}`));
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
  const [contacts, organizations, opportunities, activities, meetings, projects] = await Promise.all([
    fetchContacts(), fetchOrganizations(), fetchOpportunities(), fetchActivities(),
    hasPermission("meetings.read") ? fetchMeetings().catch(() => []) : Promise.resolve([]),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
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
  const [organizations, contacts, opportunities, activities, meetings, projects, supportCases] = await Promise.all([
    fetchOrganizations(), fetchContacts(), fetchOpportunities(), fetchActivities(),
    hasPermission("meetings.read") ? fetchMeetings().catch(() => []) : Promise.resolve([]),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
    hasPermission("support.read") ? fetchSupport().catch(() => []) : Promise.resolve([]),
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
  const [opportunities, contacts, organizations, leads, activities, tasks, projects] = await Promise.all([
    fetchOpportunities(), fetchContacts(), fetchOrganizations(),
    // GET /api/lead-agents/leads is gated on office.read (legacy
    // view_dashboard alias), not crm.read — matches the actual route.
    hasPermission("office.read") ? fetchLeads().catch(() => []) : Promise.resolve([]),
    fetchActivities(), hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
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
        ${field.type === "textarea" ? `<textarea name="${field.name}" rows="3">${escapeHtml(field.value || "")}</textarea>` : `<input name="${field.name}" type="${field.type || "text"}" value="${escapeHtml(field.value || "")}" />`}
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
// Phase 3 — Projects / Portfolio / Support / Tasks / Meetings.
//
// Every one of these collections is list+create only on the backend
// (see CORPORATE_COLLECTIONS / office-operating-system.js) — there is
// no update or status-transition endpoint yet for any of them. So,
// like Contacts/Organizations/Opportunities in Phase 2, these views
// are read + create, never a fake "Edit"/"Resolve"/"Assign" action.
//
// None of these collections have a dedicated timeline/notes table
// (crm_activities has no project_id/portfolio_id/support_case_id
// column), so there is no "Add note" here — the Timeline shown is
// built honestly from real Tasks + Meetings for that record, and no
// note-taking affordance is offered where the backend has nowhere to
// put it. This is a documented backend gap, not a bug — see
// PHASE3_REPORT.
// ---------------------------------------------------------------
function openCreateProjectDialog(prefill = {}) {
  openDialog("New Project", [
    { name: "name", label: "Project Name" },
    { name: "location", label: "Location" },
    { name: "stage", label: "Stage", value: "prospective" },
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
  const [projects, organizations, contacts, opportunities, leads, portfolioEntries, tasks, meetings] = await Promise.all([
    fetchProjects(),
    hasPermission("crm.read") ? fetchOrganizations().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchContacts().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOpportunities().catch(() => []) : Promise.resolve([]),
    hasPermission("office.read") ? fetchLeads().catch(() => []) : Promise.resolve([]),
    hasPermission("portfolio.read") ? fetchPortfolio().catch(() => []) : Promise.resolve([]),
    hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
    hasPermission("meetings.read") ? fetchMeetings().catch(() => []) : Promise.resolve([]),
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
  const timelineEvents = [
    ...relatedTasks.map((t) => ({ event_type: "task", title: t.title, body: t.description, actor: t.assignee, occurred_at: t.created_at })),
    ...relatedMeetings.map((m) => ({ event_type: "meeting", title: m.title, body: m.notes, actor: m.owner, occurred_at: m.scheduled_at || m.created_at })),
  ];

  const mainSections = [
    el(`
      <div class="detail-section">
        <h3>Project Summary</h3>
        <div class="fact-grid">
          ${factRow("Location", record.location)}
          ${factRow("Business Unit", titleCase(record.business_unit))}
          ${factRow("Stage", titleCase(record.stage))}
          ${factRow("Oyi Deployment Status", titleCase(record.oyi_deployment_status))}
          ${factRow("Organization", org ? org.name : "—")}
          ${factRow("Contact", contact ? contact.name : "—")}
        </div>
      </div>
    `),
    renderTimeline(timelineEvents),
  ];

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

  renderDetailShell(outlet, {
    type: "project",
    id,
    label: record.name,
    typeLine: `Project · ${titleCase(record.business_unit)}`,
    badges: [badge(titleCase(record.stage), toneForStatus(record.stage))],
    backLabel: "Projects",
    onBack: () => navigate("projects"),
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
async function renderPortfolioList(outlet, token) {
  setSelectedObject(null);
  const portfolioEntries = await fetchPortfolio();
  if (token !== state.renderToken) return;
  renderStandardList(outlet, {
    title: "Portfolio",
    records: portfolioEntries,
    columns: [
      { label: "Building / Deployment", width: "1.6fr", render: (p) => escapeHtml(p.name) },
      { label: "Client / Account", render: (p) => escapeHtml(p.client_account || "—") },
      { label: "Relationship", render: (p) => escapeHtml(titleCase(p.relationship_type)) },
      { label: "Facility OS", render: (p) => badge(titleCase(p.facility_os_status), toneForStatus(p.facility_os_status)) },
      { label: "Consumer OS", render: (p) => badge(titleCase(p.consumer_os_status), toneForStatus(p.consumer_os_status)) },
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
  const [portfolioEntries, projects, supportCases, tasks, meetings] = await Promise.all([
    fetchPortfolio(),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
    hasPermission("support.read") ? fetchSupport().catch(() => []) : Promise.resolve([]),
    hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
    hasPermission("meetings.read") ? fetchMeetings().catch(() => []) : Promise.resolve([]),
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
  const timelineEvents = [
    ...relatedTasks.map((t) => ({ event_type: "task", title: t.title, body: t.description, actor: t.assignee, occurred_at: t.created_at })),
    ...relatedMeetings.map((m) => ({ event_type: "meeting", title: m.title, body: m.notes, actor: m.owner, occurred_at: m.scheduled_at || m.created_at })),
    ...relatedSupport.map((s) => ({ event_type: "default", title: `Support: ${s.title}`, body: s.resolution_notes, actor: s.assigned_staff, occurred_at: s.updated_at })),
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
    renderTimeline(timelineEvents),
  ];

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
  });
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
  const [supportCases, contacts, organizations, portfolioEntries, tasks, meetings] = await Promise.all([
    fetchSupport(),
    hasPermission("crm.read") ? fetchContacts().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOrganizations().catch(() => []) : Promise.resolve([]),
    hasPermission("portfolio.read") ? fetchPortfolio().catch(() => []) : Promise.resolve([]),
    hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
    hasPermission("meetings.read") ? fetchMeetings().catch(() => []) : Promise.resolve([]),
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
  const timelineEvents = [
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
    renderTimeline(timelineEvents),
  ];

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
  });
}

// ---------------------------------------------------------------
// TASKS — a cross-company work view over crm_tasks. A task is not a
// destination in itself: clicking one navigates to whichever real
// object it belongs to (Lead/Opportunity/Project/Portfolio/Support).
// There is no PATCH for crm_tasks yet, so there is deliberately no
// edit/complete action here — see PHASE3_REPORT.
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
  return null;
}

async function fetchTaskRelationIndex() {
  const [leads, opportunities, projects, portfolioEntries, supportCases] = await Promise.all([
    hasPermission("office.read") ? fetchLeads().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOpportunities().catch(() => []) : Promise.resolve([]),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
    hasPermission("portfolio.read") ? fetchPortfolio().catch(() => []) : Promise.resolve([]),
    hasPermission("support.read") ? fetchSupport().catch(() => []) : Promise.resolve([]),
  ]);
  return {
    leadById: Object.fromEntries(leads.map((l) => [l.id, l])),
    oppById: Object.fromEntries(opportunities.map((o) => [o.id, o])),
    projectById: Object.fromEntries(projects.map((p) => [p.id, p])),
    portfolioById: Object.fromEntries(portfolioEntries.map((p) => [p.id, p])),
    supportById: Object.fromEntries(supportCases.map((s) => [s.id, s])),
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

  const relSelect = el(`<select class="toolbar-filter"><option value="">Related Type</option>${["Lead", "Opportunity", "Project", "Portfolio", "Support"].map((r) => `<option value="${r}">${r}</option>`).join("")}</select>`);
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
      ],
      rows,
      onRowClick: (t) => { if (t.__relation) navigate(t.__relation.path); },
      emptyMessage: enriched.length ? "No tasks match your filters." : "No tasks yet.",
    }));
    countLabel.textContent = `${rows.length} of ${enriched.length}`;
  }
  draw();
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
  setSelectedObject("task", id, record.title);
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
        <p class="detail-note">This task isn't linked to a Lead, Opportunity, Project, Portfolio or Support case.</p>
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
function resolveGenericRelation(type, id, { leads, contacts, organizations, opportunities, projects, portfolioEntries, supportCases }) {
  if (!type || !id) return null;
  const t = String(type).toLowerCase();
  if (t === "lead") { const r = leads.find((x) => x.id === id); return r ? { name: r.company || r.name || "Lead", path: `crm/leads/${id}` } : null; }
  if (t === "contact") { const r = contacts.find((x) => x.id === id); return r ? { name: r.name || "Contact", path: `crm/contacts/${id}` } : null; }
  if (t === "organization") { const r = organizations.find((x) => x.id === id); return r ? { name: r.name || "Organization", path: `crm/organizations/${id}` } : null; }
  if (t === "opportunity") { const r = opportunities.find((x) => x.id === id); return r ? { name: titleCase(r.inquiry_type) || "Opportunity", path: `crm/opportunities/${id}` } : null; }
  if (t === "project") { const r = projects.find((x) => x.id === id); return r ? { name: r.name || "Project", path: `projects/${id}` } : null; }
  if (t === "portfolio") { const r = portfolioEntries.find((x) => x.id === id); return r ? { name: r.name || "Portfolio Entry", path: `portfolio/${id}` } : null; }
  if (t === "support" || t === "support_case") { const r = supportCases.find((x) => x.id === id); return r ? { name: r.title || "Support Case", path: `support/${id}` } : null; }
  return null;
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
  const [meetings, leads, contacts, organizations, opportunities, projects, portfolioEntries, supportCases, tasks] = await Promise.all([
    fetchMeetings(),
    hasPermission("office.read") ? fetchLeads().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchContacts().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOrganizations().catch(() => []) : Promise.resolve([]),
    hasPermission("crm.read") ? fetchOpportunities().catch(() => []) : Promise.resolve([]),
    hasPermission("projects.read") ? fetchProjects().catch(() => []) : Promise.resolve([]),
    hasPermission("portfolio.read") ? fetchPortfolio().catch(() => []) : Promise.resolve([]),
    hasPermission("support.read") ? fetchSupport().catch(() => []) : Promise.resolve([]),
    hasPermission("tasks.read") ? fetchTasks().catch(() => []) : Promise.resolve([]),
  ]);
  if (token !== state.renderToken) return;
  const record = meetings.find((m) => m.id === id);
  if (!record) {
    outlet.innerHTML = "";
    outlet.appendChild(errorPanel("This meeting could not be found."));
    return;
  }
  const related = resolveGenericRelation(record.related_type, record.related_id, { leads, contacts, organizations, opportunities, projects, portfolioEntries, supportCases });
  const followUpTask = tasks.find((t) => t.id === record.follow_up_task_id);

  const mainSections = [
    el(`
      <div class="detail-section">
        <h3>Meeting Summary</h3>
        <div class="fact-grid">
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

  const railSections = [];
  if (related) railSections.push(railCard(titleCase(record.related_type), `<a href="#/${related.path}">${escapeHtml(related.name)}</a>`));
  if (followUpTask) railSections.push(railCard("Follow-up Task", `${escapeHtml(followUpTask.title)} <span class="rail-sub">${escapeHtml(titleCase(followUpTask.status))}</span>`));

  renderDetailShell(outlet, {
    type: "meeting",
    id,
    label: record.title,
    typeLine: `Meeting · ${titleCase(record.business_unit)}`,
    badges: [badge(record.scheduled_at ? fmtDateTime(record.scheduled_at) : "Unscheduled")],
    backLabel: "Meetings",
    onBack: () => navigate("meetings"),
    mainSections,
    railSections,
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
  project: ["Summarize the current state of this project.", "What needs attention here?", "Prepare me for the next project meeting."],
  portfolio: ["Which parts of this account need Ochiga attention?", "Summarize our relationship with this building."],
  support_case: ["Summarize this case.", "What has already been tried?", "What should we do next?"],
  meeting: ["Prepare me for this meeting.", "Summarize everything relevant about this customer.", "What are the outstanding actions?"],
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
