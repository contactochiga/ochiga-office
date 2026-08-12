// Ochiga Office — corporate shell (Phase 1: foundation).
//
// Scope, deliberately: shell + navigation + responsive layout +
// design tokens (see index.html) + permission-aware nav + a
// persistent/contextual Oyi intelligence control + shared loading/
// error/empty state primitives. No CRM/Projects/Portfolio/Support/
// Private/Partnerships/Documents logic lives here yet — those are
// Phase 2+ and render as honest placeholders below.
//
// This talks only to contracts that already exist on the backend:
//   GET  /api/lead-agents/admin/session/me
//   POST /api/lead-agents/admin/session/login
//   POST /api/lead-agents/admin/session/logout
//   POST /api/lead-agents/admin/office/intelligence/chat
// No independent reasoning happens here — every Oyi response comes
// from that one endpoint, which itself delegates to Oyi Core.

const state = {
  admin: null,
  route: "home",
  oyiOpen: false,
  oyiBusy: false,
  oyiThread: [],
};

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

// ---------------------------------------------------------------
// Session
// ---------------------------------------------------------------
function hasPermission(key) {
  return Boolean(state.admin && Array.isArray(state.admin.permissions) && state.admin.permissions.includes(key));
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
  const data = await api("/api/lead-agents/admin/session/login", {
    method: "POST",
    body: { email, password },
  });
  state.admin = data.admin;
}

async function logout() {
  try {
    await api("/api/lead-agents/admin/session/logout", { method: "POST" });
  } catch {
    // Ignore — we clear local state regardless.
  }
  state.admin = null;
}

// ---------------------------------------------------------------
// Navigation model — permission keys match permissions.js exactly.
// Tasks/Meetings are deliberately not top-level destinations; they
// surface contextually inside object detail views from Phase 2 on.
// ---------------------------------------------------------------
const PRIMARY_NAV = [
  { key: "home", label: "Home", permission: "office.read", phase: null },
  { key: "crm", label: "CRM", permission: "crm.read", phase: 2 },
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
  crm: "Leads, contacts, organizations, opportunities and activities — the relationship and commercial workspace across every business unit.",
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
// Shared state primitives
// ---------------------------------------------------------------
function el(html) {
  const wrap = document.createElement("div");
  wrap.innerHTML = html.trim();
  return wrap.firstElementChild;
}

function skeletonPanel(lines = 3) {
  const widths = ["70%", "45%", "60%", "38%"];
  return el(`
    <div class="state-panel">
      ${Array.from({ length: lines })
        .map((_, i) => `<div class="skeleton-line" style="width:${widths[i % widths.length]}"></div>`)
        .join("")}
    </div>
  `);
}

function emptyPanel({ kicker, title, body }) {
  return el(`
    <div class="state-panel">
      <div class="kicker">${kicker}</div>
      <h2>${title}</h2>
      <p>${body}</p>
    </div>
  `);
}

function errorPanel(message) {
  return el(`
    <div class="state-panel error">
      <div class="kicker">Could not load</div>
      <h2>Something needs attention</h2>
      <p>${message}</p>
    </div>
  `);
}

function phaseTag(phase) {
  return `<span class="phase-tag">Phase ${phase}</span>`;
}

// ---------------------------------------------------------------
// Views
// ---------------------------------------------------------------
function renderHomeView(outlet) {
  outlet.innerHTML = "";
  outlet.appendChild(
    el(`
      <div class="view-heading">
        <h1>Home</h1>
        <p>What needs attention across Ochiga's operating environment.</p>
      </div>
    `)
  );
  outlet.appendChild(
    emptyPanel({
      kicker: "Attention",
      title: "Live attention items arrive in Phase 2",
      body: "The backend already computes a unified attention projection (leads, tasks, support and proposals needing action). This shell intentionally doesn't wire it yet — Phase 1 is the foundation only. Ask Oyi in the meantime for anything you need right now.",
    })
  );
}

function renderPlaceholderView(outlet, item) {
  outlet.innerHTML = "";
  outlet.appendChild(
    el(`
      <div class="view-heading">
        <h1>${item.label}</h1>
      </div>
    `)
  );
  const panel = emptyPanel({
    kicker: item.phase ? "Not yet built" : "Available in legacy dashboard",
    title: item.phase ? `${item.label} lands in Phase ${item.phase}` : `${item.label}`,
    body: VIEW_COPY[item.key] || "",
  });
  if (item.phase) {
    panel.insertBefore(el(phaseTag(item.phase)), panel.firstChild);
  }
  outlet.appendChild(panel);
}

function renderForbiddenView(outlet) {
  outlet.innerHTML = "";
  outlet.appendChild(
    errorPanel("You don't have permission to view this area. Contact an administrator if you believe this is incorrect.")
  );
}

function renderRoute() {
  const outlet = document.getElementById("viewOutlet");
  const item = findNavItem(state.route) || PRIMARY_NAV[0];
  document.getElementById("topbarTitle").textContent = item.label;
  document.getElementById("topbarMeta").textContent = item.phase ? `Phase ${item.phase}` : "";

  if (!hasPermission(item.permission)) {
    renderForbiddenView(outlet);
  } else if (item.key === "home") {
    renderHomeView(outlet);
  } else {
    renderPlaceholderView(outlet, item);
  }

  updateOyiContext(item);
  syncNavActiveState();
  closeNavOnMobile();
}

// ---------------------------------------------------------------
// Router (hash-based — deep-linkable, unlike the legacy dashboard)
// ---------------------------------------------------------------
function currentRouteFromHash() {
  const raw = (window.location.hash || "").replace(/^#\/?/, "");
  return raw || "home";
}

function navigate(key) {
  if (window.location.hash === `#/${key}`) {
    renderRoute();
    return;
  }
  window.location.hash = `#/${key}`;
}

window.addEventListener("hashchange", () => {
  state.route = currentRouteFromHash();
  renderRoute();
});

// ---------------------------------------------------------------
// Nav rendering (permission-aware — an item never renders in the DOM
// if the logged-in staff member lacks the permission for it)
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
  const button = el(`
    <button class="nav-item" data-nav-key="${item.key}" type="button">
      <span class="dot"></span><span>${item.label}</span>
    </button>
  `);
  button.addEventListener("click", () => navigate(item.key));
  return button;
}

function syncNavActiveState() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.navKey === state.route);
  });
}

function renderUserFooter() {
  if (!state.admin) return;
  const initials = (state.admin.display_name || state.admin.email || "?")
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  document.getElementById("navAvatar").textContent = initials || "?";
  document.getElementById("navUserName").textContent = state.admin.display_name || state.admin.email;
  document.getElementById("navUserRole").textContent = (state.admin.role || "").replace(/_/g, " ");
}

// ---------------------------------------------------------------
// Mobile nav (off-canvas rail, not a squeezed desktop layout)
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
// Persistent Oyi intelligence control
// ---------------------------------------------------------------
function updateOyiContext(item) {
  document.getElementById("oyiContext").textContent = `Context: ${item.label}`;
}

function currentPageContext() {
  const item = findNavItem(state.route) || PRIMARY_NAV[0];
  // selected_type/selected_id populate from Phase 2+ once object detail
  // views exist; today the control is context-aware only at the page
  // level, which the backend contract already supports independently.
  return { page: item.key, selected_type: "", selected_id: "" };
}

function appendOyiMessage(role, text) {
  const thread = document.getElementById("oyiThread");
  thread.appendChild(el(`<div class="oyi-msg ${role}">${escapeHtml(text)}</div>`));
  thread.scrollTop = thread.scrollHeight;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
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
    const reply =
      (data.oyi_core && (data.oyi_core.message || data.oyi_core.reply || data.oyi_core.text)) ||
      "Oyi Core responded without a readable message field.";
    appendOyiMessage("assistant", reply);
    if (Array.isArray(data.proposed_actions) && data.proposed_actions.length) {
      const summary = data.proposed_actions.map((action) => action.tool || action.name).join(", ");
      appendOyiMessage("system", `Oyi proposed: ${summary}. Approval workflow isn't available yet — no action was taken.`);
    }
  } catch (err) {
    if (err.status === 503) {
      appendOyiMessage("system", "Oyi Core is unavailable right now. Nothing was answered from a separate reasoning path — please try again shortly.");
    } else if (err.status === 403) {
      appendOyiMessage("system", "You don't have permission to use Office intelligence.");
    } else {
      appendOyiMessage("system", "Could not reach Oyi. Please try again.");
    }
  } finally {
    state.oyiBusy = false;
    document.getElementById("oyiSend").disabled = false;
  }
}

function wireOyiControl() {
  const control = document.getElementById("oyiControl");
  const bar = document.getElementById("oyiBar");
  const closeBtn = document.getElementById("oyiClose");
  const composer = document.getElementById("oyiComposer");
  const input = document.getElementById("oyiInput");

  function open() {
    control.classList.add("open");
    bar.setAttribute("aria-expanded", "true");
    input.focus();
    if (!state.oyiThread.length) {
      appendOyiMessage("system", "Ask about what you're looking at, or anything else across Office.");
    }
  }
  function close() {
    control.classList.remove("open");
    bar.setAttribute("aria-expanded", "false");
  }

  bar.addEventListener("click", open);
  bar.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
  closeBtn.addEventListener("click", close);

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
  state.route = currentRouteFromHash();
  renderRoute();
  syncNavActiveState();
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
  if (authed) {
    showShell();
  } else {
    showLogin();
  }
}

boot();
