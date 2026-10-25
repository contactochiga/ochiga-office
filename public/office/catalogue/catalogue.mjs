// Office staff screens for the product catalogue (Phase 1). Loaded on demand by office.js (dynamic import, like shared/oyi-core) and
// rendered with office.js's own primitives (passed in as `ui`), so it looks and behaves like every other Office workspace.
// Routes: #/catalogue (products) · #/catalogue/products/:id · #/catalogue/prices · #/catalogue/taxonomy · #/catalogue/suppliers
// Every action maps to one internal API call under /api/lead-agents/admin/catalogue; the server is the authority for permissions and
// state (a stale screen gets 409 state_changed and is reloaded). Nothing here is public: there is no storefront in Phase 1.

const API = "/api/lead-agents/admin/catalogue";

const WORKFLOW_TONE = { draft: "default", in_review: "amber", changes_requested: "red", approved: "green" };
const PUBLICATION_TONE = { never_published: "default", published: "green", unpublished: "amber", archived: "red" };
const PRICE_TONE = { requested: "amber", approved: "blue", rejected: "red", published: "green" };
const SOURCING = ["in_stock", "supplier_sourced", "made_to_order", "discontinued"];

function naira(kobo) {
  if (kobo === null || kobo === undefined) return "—";
  const value = Number(kobo);
  if (!Number.isSafeInteger(value)) return "—";
  const abs = Math.abs(value);
  const whole = Math.trunc(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  return `${value < 0 ? "−" : ""}₦${whole.toLocaleString("en-NG")}.${fraction}`;
}

// "185,000.50" -> 18500050 (exact: no floating point)
function koboFromNaira(input) {
  const text = String(input || "").replace(/[₦,\s]/g, "");
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error("Enter an amount in naira, e.g. 185000 or 185000.50");
  return Number(match[1]) * 100 + Number((match[2] || "0").padEnd(2, "0"));
}

function availability(variant) {
  if (variant.status === "inactive" || variant.sourcing === "discontinued") return { label: "Unavailable", tone: "red" };
  if (variant.sourcing === "in_stock" && variant.stock_on_hand - variant.stock_reserved > 0) return { label: "In stock", tone: "green" };
  const lead = variant.lead_time_days_min != null ? ` (${variant.lead_time_days_min}–${variant.lead_time_days_max ?? variant.lead_time_days_min} days)` : "";
  return { label: `Available to order${lead}`, tone: "amber" };
}

function optionsText(options) {
  return Object.entries(options || {}).map(([k, v]) => `${k}=${v}`).join("; ");
}
function parseOptions(text) {
  const out = {};
  String(text || "").split(";").map((part) => part.trim()).filter(Boolean).forEach((part) => {
    const [k, ...rest] = part.split("=");
    if (k && rest.length) out[k.trim()] = rest.join("=").trim();
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ layout (Phase 2 stage 1: Products UI)
// Scoped to the Products content area only (sidebar, top bar and the rest of Office are untouched). Uses Office's own tokens.
const STYLE_ID = "catalogue-screen-styles";
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .cat input, .cat select, .cat textarea, .cat button { font-size: 13px; }
    .cat { --cat-radius: 10px; --cat-panel: #0e0e0c; --cat-row-sel: rgba(179,36,27,.14); color: var(--text-primary); }
    .cat-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin: 4px 0 14px; flex-wrap: wrap; }
    .cat-head h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -.02em; display: inline; }
    .cat-head .cat-sub { color: var(--text-tertiary); margin-left: 12px; font-size: 13.5px; }
    .cat-head-actions { display: flex; gap: 10px; align-items: center; }
    .cat-btn { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--line-strong); background: transparent; color: var(--text-primary); font: inherit; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .cat-btn:hover { border-color: var(--grey-500); }
    .cat-btn:disabled { opacity: .45; cursor: default; }
    .cat-btn-primary { background: var(--red); border-color: var(--red); color: #fff; }
    .cat-btn-primary:hover { background: var(--red-bright); border-color: var(--red-bright); }
    .cat-btn-icon { width: 36px; padding: 0; justify-content: center; }
    .cat-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--line); margin-bottom: 0; overflow-x: auto; }
    .cat-tab { background: none; border: 0; color: var(--text-secondary); font: inherit; font-weight: 500; padding: 10px 16px; cursor: pointer; border-radius: 8px 8px 0 0; white-space: nowrap; }
    .cat-tab.active { background: var(--red); color: #fff; font-weight: 600; }
    .cat-split { display: grid; grid-template-columns: minmax(0, 55fr) minmax(0, 45fr); border-top: 0; min-height: 70vh; }
    .cat-left { padding: 16px 16px 16px 0; border-right: 1px solid var(--line); min-width: 0; }
    .cat-right { padding: 16px 0 16px 16px; min-width: 0; }
    .cat-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
    .cat-stat { display: flex; gap: 10px; align-items: center; padding: 12px; white-space: nowrap; overflow: hidden; border: 1px solid var(--line); border-radius: var(--cat-radius); background: var(--charcoal); cursor: pointer; text-align: left; color: inherit; font: inherit; }
    .cat-stat.active { border-color: var(--red); }
    .cat-stat svg { width: 22px; height: 22px; flex: 0 0 auto; color: var(--text-secondary); }
    .cat-stat.published svg { color: #7fd9a0; }
    .cat-stat b { display: block; font-size: 20px; line-height: 1.1; }
    .cat-stat span { color: var(--text-tertiary); font-size: 12.5px; }
    .cat-toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
    .cat-search { position: relative; flex: 1 1 150px; min-width: 120px; }
    .cat-search input { width: 100%; height: 34px; padding: 0 12px 0 34px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--charcoal); color: var(--text-primary); font: inherit; }
    .cat-search svg { position: absolute; left: 11px; top: 10px; width: 16px; height: 16px; color: var(--text-tertiary); }
    .cat-select { height: 34px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--charcoal); color: var(--text-primary); font: inherit; font-size: 12.5px; flex: 0 1 auto; width: 92px; }
    .cat-clear { background: none; border: 0; color: var(--text-secondary); font: inherit; cursor: pointer; padding: 0 6px; }
    .cat-table { border: 1px solid var(--line); border-radius: var(--cat-radius); overflow: hidden; }
    .cat-tr { display: grid; grid-template-columns: minmax(140px, 2.3fr) minmax(64px, .95fr) minmax(56px, .85fr) 38px minmax(72px, .95fr) 98px 74px 24px; gap: 6px; align-items: center; padding: 8px 10px; border-top: 1px solid var(--line); cursor: pointer; }
    .cat-tr:first-child { border-top: 0; }
    .cat-tr.head { cursor: default; color: var(--text-tertiary); font-size: 12px; background: rgba(255,255,255,.02); }
    .cat-tr.head button { background: none; border: 0; color: inherit; font: inherit; padding: 0; cursor: pointer; text-align: left; }
    .cat-tr.head button.sorted { color: var(--text-primary); }
    .cat-tr:not(.head):hover { background: rgba(255,255,255,.025); }
    .cat-tr.selected { background: var(--cat-row-sel); box-shadow: inset 3px 0 0 var(--red); }
    .cat-prod { display: flex; gap: 10px; align-items: center; min-width: 0; }
    .cat-thumb { width: 42px; height: 42px; border-radius: 8px; background: #f2f0ec; flex: 0 0 auto; display: grid; place-items: center; color: #8c887f; overflow: hidden; }
    .cat-thumb svg { width: 20px; height: 20px; }
    .cat-prod-text { min-width: 0; }
    .cat-prod-text b { display: block; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cat-prod-text span { display: block; color: var(--text-tertiary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cat-cell { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cat-muted { color: var(--text-tertiary); }
    .cat-pill { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; max-width: 100%; overflow: hidden; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; border: 1px solid transparent; }
    .cat-pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .cat-pill.published { color: #7fd9a0; background: rgba(63,143,95,.16); }
    .cat-pill.published_changes_pending { color: #7fd9a0; background: rgba(63,143,95,.16); border-color: rgba(201,134,43,.5); }
    .cat-pill.in_review { color: #e3a54b; background: rgba(201,134,43,.16); }
    .cat-pill.approved { color: #8fb0ea; background: rgba(79,127,209,.16); }
    .cat-pill.changes_requested { color: var(--red-bright); background: rgba(179,36,27,.14); }
    .cat-pill.draft, .cat-pill.unpublished { color: var(--grey-300); background: rgba(255,255,255,.07); }
    .cat-pill.archived { color: var(--grey-500); background: rgba(255,255,255,.04); border-color: var(--line-strong); }
    .cat-rowmenu { background: none; border: 0; color: var(--text-tertiary); cursor: pointer; font-size: 18px; line-height: 1; padding: 4px; border-radius: 6px; }
    .cat-rowmenu:hover { color: var(--text-primary); background: rgba(255,255,255,.06); }
    .cat-pager { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; color: var(--text-tertiary); font-size: 12.5px; flex-wrap: wrap; gap: 8px; }
    .cat-pages { display: flex; gap: 4px; align-items: center; }
    .cat-page { min-width: 30px; height: 30px; border-radius: 7px; border: 0; background: none; color: var(--text-secondary); font: inherit; cursor: pointer; }
    .cat-page.active { background: var(--red); color: #fff; font-weight: 600; }
    .cat-page:disabled { opacity: .35; cursor: default; }
    .cat-menu { position: absolute; z-index: 40; min-width: 200px; background: var(--graphite); border: 1px solid var(--line-strong); border-radius: 10px; padding: 6px; box-shadow: 0 16px 40px rgba(0,0,0,.45); }
    .cat-menu button { display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--text-primary); font: inherit; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
    .cat-menu button:hover { background: rgba(255,255,255,.06); }
    .cat-menu button.danger { color: var(--red-bright); }
    .cat-ed-head { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
    .cat-ed-head .cat-thumb { width: 52px; height: 52px; }
    .cat-ed-title { flex: 1; min-width: 0; }
    .cat-ed-title h2 { margin: 0; font-size: 22px; display: inline; margin-right: 10px; overflow-wrap: anywhere; }
    .cat-ed-title p { margin: 2px 0 0; color: var(--text-tertiary); font-size: 12.5px; }
    .cat-ed-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 14px; overflow-x: auto; }
    .cat-ed-tab { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--text-secondary); font: inherit; font-size: 12.5px; padding: 9px 9px; cursor: pointer; white-space: nowrap; }
    .cat-ed-tab.active { color: var(--text-primary); border-bottom-color: var(--red); font-weight: 600; }
    .cat-card { border: 1px solid var(--line); border-radius: var(--cat-radius); background: var(--charcoal); padding: 16px; margin-bottom: 14px; }
    .cat-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .cat-card-head h3 { margin: 0; font-size: 15px; }
    .cat-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
    .cat-fields .wide { grid-column: 1 / -1; }
    .cat-field { display: grid; gap: 6px; font-size: 12.5px; color: var(--text-secondary); }
    .cat-field input, .cat-field select, .cat-field textarea { width: 100%; min-width: 0; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--black); color: var(--text-primary); font: inherit; font-size: 13px; }
    .cat-field textarea { resize: vertical; min-height: 92px; line-height: 1.5; }
    .cat-field input:disabled, .cat-field select:disabled, .cat-field textarea:disabled { color: var(--text-primary); opacity: 1; background: rgba(255,255,255,.02); -webkit-text-fill-color: var(--text-primary); }
    .cat-rows .cat-row { display: grid; gap: 6px; margin-bottom: 6px; }
    .cat-rows .cat-row.spec { grid-template-columns: 2fr 2fr 1fr 32px; }
    .cat-rows .cat-row.variant { grid-template-columns: 1.4fr 1.4fr 2fr 32px; }
    .cat-rows input { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--black); color: var(--text-primary); font: inherit; font-size: 13px; min-width: 0; }
    .cat-rows input:disabled { background: rgba(255,255,255,.02); }
    .cat-gallery { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 8px; height: 190px; }
    .cat-slot { border: 1px dashed var(--line-strong); border-radius: 10px; display: grid; place-items: center; color: var(--text-tertiary); font-size: 11.5px; text-align: center; padding: 6px; background: rgba(255,255,255,.015); }
    .cat-slot.cover { grid-row: 1 / 3; }
    .cat-actionbar { display: flex; gap: 10px; justify-content: space-between; align-items: center; padding: 12px; border: 1px solid var(--line); border-radius: var(--cat-radius); background: var(--cat-panel); margin-top: 6px; flex-wrap: wrap; }
    .cat-actionbar .grow { flex: 1; }
    .cat-note { color: var(--text-tertiary); font-size: 12px; }
    .cat-vtable .cat-tr { grid-template-columns: 1.2fr 1fr 1fr 1fr 1.2fr; cursor: default; }
    .cat-empty { border: 1px dashed var(--line-strong); border-radius: var(--cat-radius); padding: 40px 20px; text-align: center; color: var(--text-tertiary); }
    .cat-history-item { padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 12.5px; }
    .cat-back { display: none; }
    @media (max-width: 1100px) {
      .cat-split { grid-template-columns: minmax(0, 1fr); }
      .cat-left { padding-right: 0; border-right: 0; }
      .cat-right { padding-left: 0; border-top: 1px solid var(--line); }
      .cat-split.has-selection .cat-left { display: none; }
      .cat-split:not(.has-selection) .cat-right { display: none; }
      .cat-back { display: inline-flex; margin-bottom: 10px; }
    }
    @media (max-width: 720px) {
      .cat-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .cat-tr { grid-template-columns: minmax(0, 1fr) auto 32px; }
      .cat-tr > .opt { display: none; }
      .cat-fields { grid-template-columns: 1fr; }
      .cat-head .cat-sub { display: block; margin: 4px 0 0; }
      .cat-gallery { grid-template-columns: 1fr 1fr; grid-template-rows: none; height: auto; }
      .cat-slot { min-height: 90px; } .cat-slot.cover { grid-row: auto; grid-column: 1 / -1; min-height: 140px; }
    }`;
  document.head.appendChild(style);
}

const ICONS = {
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  eye: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>',
};

const STATUS_LABEL = { draft: "Draft", in_review: "In review", changes_requested: "Changes requested", approved: "Approved", published: "Published", published_changes_pending: "Published · changes pending", unpublished: "Unpublished", archived: "Archived" };
const AVAILABILITY_LABEL = { in_stock: "In stock", available_to_order: "To order", unavailable: "Unavailable" };

function pill(ui, status, short = false) {
  const label = short && status === "published_changes_pending" ? "Published*" : STATUS_LABEL[status] || status;
  return `<span class="cat-pill ${ui.escapeHtml(status)}" title="${ui.escapeHtml(STATUS_LABEL[status] || status)}">${ui.escapeHtml(label)}</span>`;
}

function priceRange(card) {
  if (card.price_min_kobo == null) return "—";
  return card.price_min_kobo === card.price_max_kobo ? naira(card.price_min_kobo) : `${naira(card.price_min_kobo)}–${naira(card.price_max_kobo)}`;
}

function shortDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// Browsing state survives re-renders within the session (route changes rebuild the DOM).
const browse = { q: "", category_id: "", brand_id: "", status: "", availability: "", sort: "updated", dir: "desc", page: 1, page_size: 12, tab: "overview" };

function popupMenu(anchor, items) {
  document.querySelectorAll(".cat-menu").forEach((m) => m.remove());
  const visible = items.filter(Boolean);
  if (!visible.length) return;
  const menu = document.createElement("div");
  menu.className = "cat-menu";
  visible.forEach((item) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = item.label;
    if (item.danger) b.className = "danger";
    b.addEventListener("click", (e) => { e.stopPropagation(); menu.remove(); item.run(); });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${window.scrollY + r.bottom + 6}px`;
  menu.style.left = `${Math.max(8, window.scrollX + r.right - menu.offsetWidth)}px`;
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}

export async function renderCatalogueRoute(outlet, rest, token, ui) {
  const { setTopbar, setSelectedObject, el, escapeHtml } = ui;
  // Office can start overlapping renders (load + hash change): only the newest one may touch the outlet
  if (token !== ui.state.renderToken) return;
  ensureStyles();
  setSelectedObject(null);
  const [section, id] = rest;
  const tabs = [
    { key: "", label: "Products", permission: "catalogue.read" },
    { key: "prices", label: "Price approvals", permission: "catalogue.read" },
    { key: "taxonomy", label: "Categories & brands", permission: "catalogue.read" },
    { key: "suppliers", label: "Suppliers", permission: "catalogue.cost.read" },
  ].filter((tab) => ui.hasPermission(tab.permission));
  const current = section === "products" ? "" : section || "";
  outlet.innerHTML = "";
  setTopbar("Products", "");
  const root = el(`<div class="cat"></div>`);
  outlet.appendChild(root);
  const head = el(`<div class="cat-head"><div><h1>Products</h1><span class="cat-sub">Office-managed catalogue — internal only</span></div><div class="cat-head-actions"></div></div>`);
  root.appendChild(head);
  const headActions = head.querySelector(".cat-head-actions");
  const tabBar = el(`<div class="cat-tabs catalogue-tabs" role="tablist"></div>`);
  tabs.forEach((tab) => {
    const button = el(`<button type="button" role="tab" class="cat-tab ${tab.key === current ? "active" : ""}">${escapeHtml(tab.label)}</button>`);
    button.addEventListener("click", () => ui.navigate(tab.key ? `catalogue/${tab.key}` : "catalogue"));
    tabBar.appendChild(button);
  });
  root.appendChild(tabBar);
  const host = el(`<div class="catalogue-host"></div>`);
  root.appendChild(host);
  host.appendChild(ui.skeletonPanel(4));
  try {
    if (section === "prices") await renderPriceQueue(host, token, ui);
    else if (section === "taxonomy") await renderTaxonomy(host, token, ui);
    else if (section === "suppliers") await renderSuppliers(host, token, ui);
    else await renderProductsWorkspace(host, headActions, section === "products" ? id : null, token, ui);
  } catch (error) {
    if (token !== ui.state.renderToken) return;
    host.innerHTML = "";
    host.appendChild(ui.errorPanel(error.status === 503 ? "The catalogue is not installed in this environment yet." : error.message || "Could not load the catalogue."));
  }
}

// ------------------------------------------------------------------------------------------------ products workspace (table + editor)
async function renderProductsWorkspace(host, headActions, selectedId, token, ui) {
  const { el, escapeHtml } = ui;
  const [{ categories }, { brands }] = await Promise.all([ui.api(`${API}/categories`), ui.api(`${API}/brands`)]);
  if (token !== ui.state.renderToken) return;
  const categoryName = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  if (ui.hasPermission("catalogue.write")) {
    const add = el(`<button type="button" class="cat-btn cat-btn-primary" data-add-product>${ICONS.plus} Add product</button>`);
    add.addEventListener("click", () => openNewProduct(ui, categories, brands));
    headActions.appendChild(add);
  }
  host.innerHTML = "";
  const split = el(`<div class="cat-split ${selectedId ? "has-selection" : ""}"><div class="cat-left"></div><div class="cat-right"></div></div>`);
  host.appendChild(split);
  const left = split.querySelector(".cat-left");
  const right = split.querySelector(".cat-right");
  let selected = selectedId;

  left.innerHTML = `
    <div class="cat-stats" data-stats></div>
    <div class="cat-toolbar">
      <label class="cat-search">${ICONS.search}<input type="search" placeholder="Search products, SKUs…" aria-label="Search products" data-q /></label>
      <select class="cat-select" aria-label="Category" data-f="category_id"><option value="">Category</option>${categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}</select>
      <select class="cat-select" aria-label="Brand" data-f="brand_id"><option value="">Brand</option>${brands.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join("")}</select>
      <select class="cat-select" aria-label="Status" data-f="status"><option value="">Status</option><option value="active">All except archived</option>${["draft", "in_review", "approved", "published", "unpublished", "archived"].map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join("")}</select>
      <select class="cat-select" aria-label="Stock" data-f="availability"><option value="">Stock</option><option value="in_stock">In stock</option><option value="available_to_order">To order</option><option value="unavailable">Unavailable</option></select>
      <button type="button" class="cat-clear" data-clear>Clear</button>
    </div>
    <div data-table></div>
    <div class="cat-pager" data-pager></div>`;
  const q = left.querySelector("[data-q]");
  q.value = browse.q;
  left.querySelectorAll("[data-f]").forEach((s) => { s.value = browse[s.dataset.f] || ""; });

  const selectRow = (id) => {
    selected = id;
    split.classList.toggle("has-selection", Boolean(id));
    left.querySelectorAll(".cat-tr[data-id]").forEach((r) => r.classList.toggle("selected", r.dataset.id === id));
    // update the address without a full route re-render: the table keeps its scroll, filters and page
    history.pushState(null, "", id ? `#/catalogue/products/${id}` : "#/catalogue");
    renderEditor(right, id, ui, { categories, brands, categoryName, refreshList: () => loadList() , back: () => selectRow(null) });
  };

  let listToken = 0;
  async function loadList() {
    const mine = ++listToken;
    const params = new URLSearchParams({ view: "cards", sort: browse.sort, dir: browse.dir, page: String(browse.page), page_size: String(browse.page_size) });
    ["q", "category_id", "brand_id", "status", "availability"].forEach((k) => { if (browse[k]) params.set(k, browse[k]); });
    const data = await ui.api(`${API}/products?${params}`);
    if (mine !== listToken || !left.isConnected) return;
    browse.page = data.page;
    const st = data.stats;
    const stat = (key, filter, label, value, icon, extra = "") => `<button type="button" class="cat-stat ${extra} ${browse.status === filter && filter ? "active" : ""}" data-stat="${filter}">${ICONS[icon]}<div><b>${value}</b><span>${label}</span></div></button>`;
    left.querySelector("[data-stats]").innerHTML = stat("total", "", "Total products", st.total, "box") + stat("draft", "draft", "Drafts", st.draft, "doc") + stat("in_review", "in_review", "In review", st.in_review, "clock") + stat("published", "published", "Published", st.published, "check", "published");
    left.querySelectorAll("[data-stat]").forEach((b) => b.addEventListener("click", () => { browse.status = b.dataset.stat === browse.status ? "" : b.dataset.stat; left.querySelector('[data-f="status"]').value = browse.status; browse.page = 1; loadList(); }));
    const sortHead = (key, label, optional = true) => `<button type="button" data-sort="${key}" class="${browse.sort === key ? "sorted" : ""} ${optional ? "opt" : ""}">${label}${browse.sort === key ? (browse.dir === "asc" ? " ↑" : " ↓") : ""}</button>`;
    const table = el(`<div class="cat-table" role="table"></div>`);
    table.appendChild(el(`<div class="cat-tr head" role="row">${sortHead("name", "Product", false)}${sortHead("sku", "SKU")}<span class="cat-cell opt">Category</span>${sortHead("stock", "Stock")}${sortHead("price", "Price")}${sortHead("status", "Status", false)}${sortHead("updated", "Updated")}<span></span></div>`));
    data.products.forEach((card) => {
      const row = el(`<div class="cat-tr ${card.id === selected ? "selected" : ""}" role="row" data-id="${escapeHtml(card.id)}" tabindex="0">
        <div class="cat-prod"><div class="cat-thumb">${ICONS.box}</div><div class="cat-prod-text"><b>${escapeHtml(card.name)}</b><span>${escapeHtml(card.summary || card.model || card.slug)}</span></div></div>
        <span class="cat-cell opt">${escapeHtml(card.sku || "—")}${card.sku_count > 1 ? ` <span class="cat-muted">+${card.sku_count - 1}</span>` : ""}</span>
        <span class="cat-cell opt">${escapeHtml(categoryName[card.category_id] || "—")}</span>
        <span class="cat-cell opt">${card.stock_available}</span>
        <span class="cat-cell opt">${escapeHtml(priceRange(card))}</span>
        <span class="cat-cell">${pill(ui, card.status, true)}</span>
        <span class="cat-cell opt">${escapeHtml(shortDate(card.updated_at))}</span>
        <button type="button" class="cat-rowmenu" aria-label="Product actions">⋯</button>
      </div>`);
      row.addEventListener("click", () => selectRow(card.id));
      row.addEventListener("keydown", (e) => { if (e.key === "Enter") selectRow(card.id); });
      row.querySelector(".cat-rowmenu").addEventListener("click", (e) => {
        e.stopPropagation();
        popupMenu(e.currentTarget, [
          { label: "Open", run: () => selectRow(card.id) },
          ui.hasPermission("catalogue.write") && { label: "Duplicate…", run: () => openDuplicate(ui, card.id) },
        ]);
      });
      table.appendChild(row);
    });
    const tableHost = left.querySelector("[data-table]");
    tableHost.innerHTML = "";
    if (!data.products.length) tableHost.appendChild(el(`<div class="cat-empty">${data.total === 0 && !browse.q && !browse.category_id && !browse.brand_id && !browse.status && !browse.availability ? "No products yet." : "No product matches these filters."}</div>`));
    else tableHost.appendChild(table);
    table.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => {
      const key = b.dataset.sort;
      browse.dir = browse.sort === key ? (browse.dir === "asc" ? "desc" : "asc") : key === "updated" ? "desc" : "asc";
      browse.sort = key; browse.page = 1; loadList();
    }));
    const from = data.total ? (data.page - 1) * data.page_size + 1 : 0;
    const to = Math.min(data.total, data.page * data.page_size);
    const pages = [];
    for (let p = 1; p <= data.pages; p += 1) if (p === 1 || p === data.pages || Math.abs(p - data.page) <= 2) pages.push(p); else if (pages[pages.length - 1] !== "…") pages.push("…");
    const pager = left.querySelector("[data-pager]");
    pager.innerHTML = `<span data-showing>Showing ${from}–${to} of ${data.total} products${data.truncated ? " (first 5,000)" : ""}</span><div class="cat-pages">
      <button type="button" class="cat-page" data-page="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""} aria-label="Previous page">‹</button>
      ${pages.map((p) => (p === "…" ? `<span class="cat-muted">…</span>` : `<button type="button" class="cat-page ${p === data.page ? "active" : ""}" data-page="${p}">${p}</button>`)).join("")}
      <button type="button" class="cat-page" data-page="${data.page + 1}" ${data.page >= data.pages ? "disabled" : ""} aria-label="Next page">›</button></div>`;
    pager.querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => { browse.page = Number(b.dataset.page); loadList(); }));
  }

  let debounce;
  q.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(() => { browse.q = q.value.trim(); browse.page = 1; loadList(); }, 250); });
  left.querySelectorAll("[data-f]").forEach((s) => s.addEventListener("change", () => { browse[s.dataset.f] = s.value; browse.page = 1; loadList(); }));
  left.querySelector("[data-clear]").addEventListener("click", () => {
    Object.assign(browse, { q: "", category_id: "", brand_id: "", status: "", availability: "", page: 1 });
    q.value = ""; left.querySelectorAll("[data-f]").forEach((s) => { s.value = ""; }); loadList();
  });
  await loadList();
  if (token !== ui.state.renderToken) return;
  await renderEditor(right, selected, ui, { categories, brands, categoryName, refreshList: () => loadList(), back: () => selectRow(null) });
}

function openNewProduct(ui, categories, brands) {
  ui.openDialog("Add product", [
    { name: "name", label: "Product name" },
    { name: "slug", label: "Slug (lowercase-with-hyphens; fixed once published)" },
    { name: "category_id", label: "Category", type: "select", value: categories[0] && categories[0].id, options: categories.filter((c) => c.status === "active").map((c) => ({ value: c.id, label: c.name })) },
    { name: "brand_id", label: "Brand", type: "select", value: "", options: [{ value: "", label: "— none —" }, ...brands.filter((b) => b.status === "active").map((b) => ({ value: b.id, label: b.name }))] },
    { name: "model", label: "Model number" },
    { name: "sku", label: "First SKU (A-Z 0-9 . _ -)" },
    { name: "variant_name", label: "First variant name", value: "Standard" },
  ], async (data) => {
    const result = await ui.api(`${API}/products`, { method: "POST", body: {
      slug: data.slug, content: { category_id: data.category_id, brand_id: data.brand_id || null, name: data.name, model: data.model, variants: [{ sku: data.sku, name: data.variant_name || "Standard", options: {} }] },
    } });
    ui.toast("Product created as a draft (v1).", "success");
    ui.navigate(`catalogue/products/${result.product.id}`);
  });
}

function openDuplicate(ui, id) {
  ui.openDialog("Duplicate product", [{ name: "slug", label: "Slug for the copy" }, { name: "sku_suffix", label: "Suffix added to every SKU (SKUs are unique)", value: "-COPY" }], async (data) => {
    const copy = await ui.api(`${API}/products/${id}/duplicate`, { method: "POST", body: { slug: data.slug, sku_suffix: data.sku_suffix } });
    ui.toast("Copy created as a new draft.", "success");
    ui.navigate(`catalogue/products/${copy.product.id}`);
  });
}

function conflictMessage(error) {
  if (error.status === 409 && error.data && error.data.error === "state_changed") return "Someone else changed this product a moment ago — it has been reloaded. Please check and try again.";
  if (error.data && error.data.error === "own_change") return "You cannot review a change you authored. Ask another reviewer.";
  if (error.data && error.data.error === "review_required") return "This version needs approval by a second person before it can be published.";
  if (error.data && error.data.details) return `${error.message}: ${error.data.details.join("; ")}`;
  return error.message || "The action failed.";
}

// ------------------------------------------------------------------------------------------------ product editor (right panel)
async function renderEditor(right, id, ui, ctx) {
  const { el, escapeHtml } = ui;
  right.innerHTML = "";
  if (!id) {
    right.appendChild(el(`<div class="cat-empty">Select a product to view or edit it.</div>`));
    return;
  }
  right.appendChild(ui.skeletonPanel(5));
  let detail;
  try {
    detail = await ui.api(`${API}/products/${id}`);
  } catch (error) {
    right.innerHTML = "";
    right.appendChild(ui.errorPanel(error.status === 404 ? "This product does not exist." : error.message || "Could not load the product."));
    return;
  }
  if (!right.isConnected) return;
  const { product, content, versions, reviews, publication_events: events, variants, permissions } = detail;
  ui.setSelectedObject("catalogue_product", product.id, content.name);
  const archived = product.publication_status === "archived";
  const canEdit = permissions.write && !archived;
  const status = detail.status;
  const me = String((ui.state.admin && ui.state.admin.email) || "").toLowerCase();
  const changeAuthors = new Set(versions.filter((v) => v.version > (product.published_version || 0) && v.version <= product.current_version).map((v) => String(v.author || "").toLowerCase()));
  const reload = async () => { await renderEditor(right, id, ui, ctx); ctx.refreshList(); };
  const draft = JSON.parse(JSON.stringify(content));
  let editing = false;
  let dirty = false;

  const act = async (path, body = {}, success) => {
    try {
      await ui.api(`${API}/products/${id}/${path}`, { method: "POST", body: { expected_row_version: product.row_version, ...body } });
      ui.toast(success, "success");
    } catch (error) { ui.toast(conflictMessage(error), "error"); }
    reload();
  };
  const save = async () => {
    try {
      const saved = await ui.api(`${API}/products/${id}`, { method: "PATCH", body: { expected_row_version: product.row_version, content: draft } });
      ui.toast(`Saved as v${saved.product.current_version}. It needs review before it can be published.`, "success");
      reload();
    } catch (error) {
      if (error.status === 409 && error.data && error.data.error === "state_changed") { ui.toast(conflictMessage(error), "error"); reload(); return; }
      ui.toast(conflictMessage(error), "error");
    }
  };

  right.innerHTML = "";
  const back = el(`<button type="button" class="cat-btn cat-back">‹ All products</button>`);
  back.addEventListener("click", () => ctx.back());
  right.appendChild(back);
  const updatedBy = product.updated_by || product.created_by || "";
  const head = el(`<div class="cat-ed-head">
    <div class="cat-thumb">${ICONS.box}</div>
    <div class="cat-ed-title"><h2>${escapeHtml(content.name)}</h2>${pill(ui, status)}
      <p>v${product.current_version}${product.published_version ? ` · live v${product.published_version}` : ""} · Last updated ${escapeHtml(ui.fmtDateTime(product.updated_at))}${updatedBy ? ` by ${escapeHtml(updatedBy)}` : ""}</p></div>
    <button type="button" class="cat-btn cat-btn-icon" aria-label="More product actions" data-more>⋯</button></div>`);
  right.appendChild(head);
  const live = product.publication_status === "published" && product.published_version === product.current_version;
  head.querySelector("[data-more]").addEventListener("click", (e) => popupMenu(e.currentTarget, [
    permissions.write && { label: "Duplicate…", run: () => openDuplicate(ui, id) },
    permissions.publish && product.publication_status === "published" && { label: "Unpublish (internal)", run: () => act("unpublish", {}, "Unpublished.") },
    permissions.override && !archived && !live && !(product.workflow_status === "approved" && product.approved_version === product.current_version) && {
      label: "Publish without review (override)…", danger: true,
      run: () => ui.openDialog("Administrative override", [{ name: "override_reason", label: "Reason (at least 20 characters; recorded, reviewers are notified)", type: "textarea" }], (data) => act("publish", { override_reason: data.override_reason }, "Published by override; reviewers were notified.")),
    },
    permissions.publish && !archived && { label: "Archive…", danger: true, run: () => { if (window.confirm("Archive this product? It is unpublished and can no longer be edited or reviewed; its history is kept.")) act("archive", {}, "Archived."); } },
  ]));

  const TABS = [["overview", "Overview"], ["media", "Media"], ["specifications", "Specifications"], ["pricing", "Pricing & Inventory"], ["history", "Publishing & History"]];
  if (!TABS.some(([k]) => k === browse.tab)) browse.tab = "overview";
  const tabBar = el(`<div class="cat-ed-tabs" role="tablist"></div>`);
  TABS.forEach(([key, label]) => {
    const b = el(`<button type="button" role="tab" class="cat-ed-tab ${browse.tab === key ? "active" : ""}" data-edtab="${key}">${label}</button>`);
    b.addEventListener("click", () => { browse.tab = key; tabBar.querySelectorAll(".cat-ed-tab").forEach((t) => t.classList.toggle("active", t.dataset.edtab === key)); drawBody(); });
    tabBar.appendChild(b);
  });
  right.appendChild(tabBar);
  const body = el(`<div class="cat-ed-body"></div>`);
  right.appendChild(body);
  const bar = el(`<div class="cat-actionbar catalogue-actions"></div>`);
  right.appendChild(bar);

  const field = (label, html, wide) => `<label class="cat-field ${wide ? "wide" : ""}">${escapeHtml(label)}${html}</label>`;
  const dis = () => (editing ? "" : "disabled");
  const markDirty = () => { dirty = true; drawBar(); };

  function galleryCard() {
    return `<div class="cat-card"><div class="cat-card-head"><h3>Media gallery (0/12)</h3><span class="cat-note">Product images arrive in the next stage</span></div>
      <div class="cat-gallery"><div class="cat-slot cover">Cover image</div><div class="cat-slot">Image 2</div><div class="cat-slot">Image 3</div><div class="cat-slot">Image 4</div><div class="cat-slot">Image 5</div><div class="cat-slot">+ more<br/>(up to 12)</div></div></div>`;
  }

  function drawBody() {
    const tab = browse.tab;
    body.innerHTML = "";
    if (tab === "overview") {
      const card = el(`<div class="cat-card"><div class="cat-card-head"><h3>Basic information</h3></div>
        <div class="cat-fields catalogue-editor">
          ${field("Product name", `<input name="name" value="${escapeHtml(draft.name)}" ${dis()} />`)}
          ${field("SKU", `<input value="${escapeHtml((draft.variants[0] && draft.variants[0].sku) || "")}${draft.variants.length > 1 ? ` (+${draft.variants.length - 1})` : ""}" disabled title="SKUs are edited under Pricing & Inventory" />`)}
          ${field("Category", `<select name="category_id" ${dis()}>${ctx.categories.map((c) => `<option value="${c.id}" ${c.id === draft.category_id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select>`)}
          ${field("Brand", `<select name="brand_id" ${dis()}><option value="">— none —</option>${ctx.brands.map((b) => `<option value="${b.id}" ${b.id === draft.brand_id ? "selected" : ""}>${escapeHtml(b.name)}</option>`).join("")}</select>`)}
          ${field("Model", `<input name="model" value="${escapeHtml(draft.model)}" ${dis()} />`)}
          ${field("Slug", `<input value="${escapeHtml(product.slug)}" disabled />`)}
          ${field("Short description", `<input name="summary" value="${escapeHtml(draft.summary)}" ${dis()} />`, true)}
          ${field("Full description", `<textarea name="description" ${dis()}>${escapeHtml(draft.description)}</textarea>`, true)}
        </div></div>`);
      if (canEdit && !editing) {
        const edit = el(`<button type="button" class="cat-btn" data-edit>${ICONS.edit} Edit</button>`);
        edit.addEventListener("click", () => { editing = true; drawBody(); drawBar(); });
        card.querySelector(".cat-card-head").appendChild(edit);
      }
      card.querySelectorAll("[name]").forEach((input) => input.addEventListener("input", () => { draft[input.name] = input.name === "brand_id" ? input.value || null : input.value; markDirty(); }));
      body.appendChild(card);
      body.appendChild(el(galleryCard()));
    } else if (tab === "media") {
      body.appendChild(el(galleryCard()));
      body.appendChild(el(`<p class="cat-note">Five visible slots, expandable to twelve, with cover selection, ordering, captions, alt text and per-variant images — built on Office's existing file storage in the next stage. Every gallery change will need review like any other content change.</p>`));
    } else if (tab === "specifications") {
      const card = el(`<div class="cat-card"><div class="cat-card-head"><h3>Specifications</h3></div><div class="cat-rows" data-specs></div></div>`);
      const host = card.querySelector("[data-specs]");
      const drawSpecs = () => {
        host.innerHTML = "";
        draft.specifications.forEach((spec, index) => {
          const row = el(`<div class="cat-row spec"><input data-k placeholder="Key" value="${escapeHtml(spec.key)}" ${dis()} /><input data-v placeholder="Value" value="${escapeHtml(spec.value)}" ${dis()} /><input data-u placeholder="Unit" value="${escapeHtml(spec.unit)}" ${dis()} />${editing ? `<button type="button" class="cat-rowmenu" aria-label="Remove specification">✕</button>` : "<span></span>"}</div>`);
          row.querySelector("[data-k]").addEventListener("input", (e) => { spec.key = e.target.value; markDirty(); });
          row.querySelector("[data-v]").addEventListener("input", (e) => { spec.value = e.target.value; markDirty(); });
          row.querySelector("[data-u]").addEventListener("input", (e) => { spec.unit = e.target.value; markDirty(); });
          if (editing) row.querySelector("button").addEventListener("click", () => { draft.specifications.splice(index, 1); markDirty(); drawSpecs(); });
          host.appendChild(row);
        });
        if (!draft.specifications.length) host.appendChild(el(`<p class="cat-note">No specifications yet.</p>`));
        if (editing) { const add = el(`<button type="button" class="cat-btn" data-add-spec>${ICONS.plus} Add specification</button>`); add.addEventListener("click", () => { draft.specifications.push({ key: "", value: "", unit: "" }); markDirty(); drawSpecs(); }); host.appendChild(add); }
      };
      drawSpecs();
      body.appendChild(card);
      const compat = el(`<div class="cat-card"><div class="cat-card-head"><h3>Oyi compatibility</h3></div><div class="cat-fields">
        ${["facility", "experience", "core", "edge"].map((flag) => `<label class="cat-field" style="display:flex;gap:8px;align-items:center;"><input type="checkbox" data-flag="${flag}" ${draft.compatibility[flag] ? "checked" : ""} ${dis()} style="width:auto;" /> Oyi ${flag[0].toUpperCase() + flag.slice(1)}</label>`).join("")}
        ${field("Notes", `<input data-compat-notes value="${escapeHtml(draft.compatibility.notes)}" ${dis()} />`, true)}</div></div>`);
      compat.querySelectorAll("[data-flag]").forEach((c) => c.addEventListener("change", () => { draft.compatibility[c.dataset.flag] = c.checked; markDirty(); }));
      compat.querySelector("[data-compat-notes]").addEventListener("input", (e) => { draft.compatibility.notes = e.target.value; markDirty(); });
      body.appendChild(compat);
      if (canEdit && !editing) { const edit = el(`<button type="button" class="cat-btn" data-edit>${ICONS.edit} Edit</button>`); edit.addEventListener("click", () => { editing = true; drawBody(); drawBar(); }); card.querySelector(".cat-card-head").appendChild(edit); }
    } else if (tab === "pricing") {
      const listed = new Set(content.variants.map((v) => v.sku));
      const vcard = el(`<div class="cat-card"><div class="cat-card-head"><h3>Variants, prices & stock</h3></div><div class="cat-table cat-vtable"></div>
        <p class="cat-note" style="margin:10px 0 0;">Prices are VAT-inclusive NGN; delivery and installation are never included. A price changes only after a request, approval by a different commercial approver, and publication.</p></div>`);
      const vt = vcard.querySelector(".cat-vtable");
      vt.appendChild(el(`<div class="cat-tr head"><span>SKU</span><span>Price (incl. VAT)</span><span>Stock</span><span>Availability</span><span></span></div>`));
      variants.forEach((variant) => {
        const a = availability(variant);
        const row = el(`<div class="cat-tr"><span class="cat-cell"><code>${escapeHtml(variant.sku)}</code>${listed.has(variant.sku) ? "" : ` <span class="cat-muted">(not in current version)</span>`}</span>
          <span class="cat-cell">${escapeHtml(naira(variant.price_ngn_kobo))}${variant.vat_treatment ? `<br/><span class="cat-muted">${escapeHtml(variant.vat_treatment.replace("_", "-"))}${variant.vat_rate_bp ? ` ${variant.vat_rate_bp / 100}%` : ""}</span>` : ""}</span>
          <span class="cat-cell">${variant.stock_on_hand} on hand<br/><span class="cat-muted">${variant.stock_reserved} reserved</span></span>
          <span class="cat-cell">${ui.badge(a.label, a.tone)}</span><span data-vactions style="display:flex;gap:6px;flex-wrap:wrap;"></span></div>`);
        const actions = row.querySelector("[data-vactions]");
        const small = (label, handler) => { const b = el(`<button type="button" class="cat-btn" style="height:30px;padding:0 10px;font-weight:500;">${escapeHtml(label)}</button>`); b.addEventListener("click", handler); actions.appendChild(b); };
        if (permissions.write) small("Request price", () => openPriceRequest(ui, variant, reload));
        if (permissions.inventory) small("Inventory", () => openInventory(ui, variant, reload));
        if (permissions.costRead) small("Costs", () => openCosts(ui, variant, permissions));
        vt.appendChild(row);
      });
      body.appendChild(vcard);
      const dcard = el(`<div class="cat-card"><div class="cat-card-head"><h3>Variant definitions</h3></div><div class="cat-rows" data-variants></div></div>`);
      const dhost = dcard.querySelector("[data-variants]");
      const drawVariants = () => {
        dhost.innerHTML = "";
        draft.variants.forEach((variant, index) => {
          const row = el(`<div class="cat-row variant"><input data-sku placeholder="SKU" value="${escapeHtml(variant.sku)}" ${dis()} /><input data-name placeholder="Variant name" value="${escapeHtml(variant.name)}" ${dis()} /><input data-options placeholder="colour=white; size=2-gang" value="${escapeHtml(optionsText(variant.options))}" ${dis()} />${editing ? `<button type="button" class="cat-rowmenu" aria-label="Remove variant">✕</button>` : "<span></span>"}</div>`);
          row.querySelector("[data-sku]").addEventListener("input", (e) => { variant.sku = e.target.value; markDirty(); });
          row.querySelector("[data-name]").addEventListener("input", (e) => { variant.name = e.target.value; markDirty(); });
          row.querySelector("[data-options]").addEventListener("input", (e) => { variant.options = parseOptions(e.target.value); markDirty(); });
          if (editing) row.querySelector("button").addEventListener("click", () => { draft.variants.splice(index, 1); markDirty(); drawVariants(); });
          dhost.appendChild(row);
        });
        if (editing) { const add = el(`<button type="button" class="cat-btn">${ICONS.plus} Add variant</button>`); add.addEventListener("click", () => { draft.variants.push({ sku: "", name: "", options: {} }); markDirty(); drawVariants(); }); dhost.appendChild(add); }
      };
      drawVariants();
      if (canEdit && !editing) { const edit = el(`<button type="button" class="cat-btn" data-edit>${ICONS.edit} Edit</button>`); edit.addEventListener("click", () => { editing = true; drawBody(); drawBar(); }); dcard.querySelector(".cat-card-head").appendChild(edit); }
      body.appendChild(dcard);
    } else {
      const lifecycle = el(`<div class="cat-card"><div class="cat-card-head"><h3>Publication</h3>${pill(ui, status)}</div>
        <p class="cat-note" style="margin:0;">${archived ? "Archived: no further edits, reviews or publication. The full history is kept." : live ? "The current version is published internally. There is no public storefront yet." : product.published_version ? `v${product.published_version} is published internally; v${product.current_version} is pending.` : "Not published yet."} Every change after publication needs approval by a second person.</p></div>`);
      body.appendChild(lifecycle);
      const history = el(`<div class="cat-card"><div class="cat-card-head"><h3>History</h3></div><div data-items></div><div data-diff style="margin-top:10px;"></div></div>`);
      const items = [
        ...versions.map((v) => ({ at: v.created_at, html: `<strong>v${v.version}</strong> saved by ${escapeHtml(v.author)} ${ui.badge(v.materiality, "amber")}${v.version > 1 ? ` <button type="button" class="cat-btn" style="height:26px;padding:0 8px;font-weight:500;" data-diff-version="${v.version}">Changes vs v${v.version - 1}</button>` : ""}` })),
        ...reviews.map((r) => ({ at: r.created_at, html: `${ui.badge(ui.titleCase(r.decision), r.decision === "approved" ? "green" : r.decision === "override" ? "red" : "default")} v${r.version} by ${escapeHtml(r.actor)}${r.note ? `<br/><span class="cat-muted">${escapeHtml(r.note)}</span>` : ""}` })),
        ...events.map((e) => ({ at: e.created_at, html: `${ui.badge(ui.titleCase(e.action), e.override ? "red" : e.action === "archived" ? "default" : "green")}${e.version ? ` v${e.version}` : ""} by ${escapeHtml(e.actor)}${e.override_reason ? `<br/><span class="cat-muted">Override: ${escapeHtml(e.override_reason)}</span>` : ""}` })),
      ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
      const list = history.querySelector("[data-items]");
      items.forEach((item) => list.appendChild(el(`<div class="cat-history-item timeline-item"><span class="cat-muted">${escapeHtml(ui.fmtDateTime(item.at))}</span><br/>${item.html}</div>`)));
      list.querySelectorAll("[data-diff-version]").forEach((button) => button.addEventListener("click", async () => {
        const n = Number(button.getAttribute("data-diff-version"));
        const { diff } = await ui.api(`${API}/products/${product.id}/versions/${n}?diff_to=${n - 1}`);
        history.querySelector("[data-diff]").innerHTML = `<h4 style="margin:6px 0;">v${n - 1} → v${n}</h4>` + (diff.length ? diff.map((d) => `<div style="margin-bottom:6px;font-size:12.5px;"><code>${escapeHtml(d.field)}</code><br/><span class="cat-muted">before:</span> ${escapeHtml(JSON.stringify(d.before))}<br/><span class="cat-muted">after:</span> ${escapeHtml(JSON.stringify(d.after))}</div>`).join("") : `<p class="cat-note">No content change.</p>`);
      }));
      body.appendChild(history);
    }
  }

  // Bottom bar: Preview (next stage), Save draft (while editing), and ONE primary action for the current state and the user's rights.
  function drawBar() {
    bar.innerHTML = "";
    const button = (label, cls, handler, attrs = "") => { const b = el(`<button type="button" class="cat-btn ${cls}" ${attrs}>${label}</button>`); if (handler) b.addEventListener("click", handler); bar.appendChild(b); return b; };
    button(`${ICONS.eye} Preview`, "", null, `disabled title="Authenticated previews arrive with publishing (stage 4)"`);
    bar.appendChild(el(`<span class="grow"></span>`));
    if (editing) {
      button("Cancel", "", () => { editing = false; dirty = false; Object.assign(draft, JSON.parse(JSON.stringify(content))); drawBody(); drawBar(); });
      button("Save draft", "cat-btn-primary", save, dirty ? "" : "disabled");
      return;
    }
    if (archived) { bar.appendChild(el(`<span class="cat-note">Archived — read-only</span>`)); return; }
    if (permissions.write && ["draft", "changes_requested"].includes(product.workflow_status)) { button("Submit for review", "cat-btn-primary", () => act("submit", {}, "Submitted for review. Reviewers were notified.")); return; }
    if (product.workflow_status === "in_review") {
      if (permissions.review && !changeAuthors.has(me)) {
        button("Request changes", "", () => ui.openDialog("Request changes", [{ name: "note", label: "What needs to change?", type: "textarea" }], (data) => act("request-changes", { note: data.note }, "Changes requested; the authors were notified.")));
        button("Approve", "cat-btn-primary", () => act("approve", {}, "Approved."));
      } else if (permissions.review) {
        bar.appendChild(el(`<span class="cat-note catalogue-own-change">You authored this change — another reviewer must approve it.</span>`));
      } else {
        bar.appendChild(el(`<span class="cat-note">Waiting for review</span>`));
      }
      return;
    }
    if (permissions.publish && !live && product.workflow_status === "approved" && product.approved_version === product.current_version) { button("Publish (internal)", "cat-btn-primary", () => act("publish", {}, "Publication state updated.")); return; }
    if (live) bar.appendChild(el(`<span class="cat-note">Published (internal) — no storefront yet</span>`));
  }

  drawBody();
  drawBar();
}

function openPriceRequest(ui, variant, reload) {
  ui.openDialog(`Price change — ${variant.sku}`, [
    { name: "price", label: "New selling price in naira, VAT-inclusive (e.g. 185000.00)" },
    { name: "vat_treatment", label: "VAT treatment", type: "select", value: variant.vat_treatment || "standard", options: [{ value: "standard", label: "Standard (7.5 %)" }, { value: "exempt", label: "Exempt" }, { value: "zero_rated", label: "Zero-rated" }] },
    { name: "note", label: "Reason", type: "textarea" },
  ], async (data) => {
    await ui.api(`${API}/variants/${variant.id}/price-changes`, { method: "POST", body: { price_ngn_kobo: koboFromNaira(data.price), vat_treatment: data.vat_treatment, note: data.note } });
    ui.toast("Price change requested. A commercial approver must approve it, then it is published.", "success");
    reload();
  });
}

function openInventory(ui, variant, reload) {
  ui.openDialog(`Inventory — ${variant.sku}`, [
    { name: "stock_on_hand", label: "Stock on hand", type: "number", value: String(variant.stock_on_hand) },
    { name: "stock_reserved", label: "Reserved", type: "number", value: String(variant.stock_reserved) },
    { name: "sourcing", label: "Sourcing", type: "select", value: variant.sourcing, options: SOURCING },
    { name: "lead_time_days_min", label: "Lead time min (days)", type: "number", value: variant.lead_time_days_min == null ? "" : String(variant.lead_time_days_min) },
    { name: "lead_time_days_max", label: "Lead time max (days)", type: "number", value: variant.lead_time_days_max == null ? "" : String(variant.lead_time_days_max) },
    { name: "status", label: "Variant status", type: "select", value: variant.status, options: ["active", "inactive"] },
    { name: "reason", label: "Reason (logged)" },
  ], async (data) => {
    const num = (v) => (v === "" || v === undefined ? null : Number(v));
    await ui.api(`${API}/variants/${variant.id}/inventory`, { method: "PATCH", body: { expected_row_version: variant.row_version, stock_on_hand: num(data.stock_on_hand), stock_reserved: num(data.stock_reserved), sourcing: data.sourcing, lead_time_days_min: num(data.lead_time_days_min), lead_time_days_max: num(data.lead_time_days_max), status: data.status, reason: data.reason } });
    ui.toast("Inventory updated and logged (no re-publication needed).", "success");
    reload();
  });
}

async function openCosts(ui, variant, permissions) {
  const [{ costs }, suppliers] = await Promise.all([ui.api(`${API}/variants/${variant.id}/costs`), ui.api(`${API}/suppliers`).then((r) => r.suppliers)]);
  const latest = costs[0];
  ui.toast(latest ? `Latest landed cost ${naira(latest.landed_cost_kobo)}; margin ${latest.margin_kobo == null ? "— (no published price)" : `${naira(latest.margin_kobo)} (${(latest.margin_bp / 100).toFixed(1)} %)`}` : "No cost recorded yet.", "default");
  if (!permissions.costManage) return;
  ui.openDialog(`Record cost — ${variant.sku} (internal)`, [
    { name: "supplier_id", label: "Supplier", type: "select", value: (latest && latest.supplier_id) || "", options: [{ value: "", label: "— none —" }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))] },
    { name: "supplier_cost", label: "Supplier cost (naira)" },
    { name: "landed_cost", label: "Landed cost incl. freight/duty (naira)" },
    { name: "note", label: "Note" },
  ], async (data) => {
    await ui.api(`${API}/variants/${variant.id}/costs`, { method: "POST", body: { supplier_id: data.supplier_id || null, supplier_cost_kobo: koboFromNaira(data.supplier_cost), landed_cost_kobo: koboFromNaira(data.landed_cost), note: data.note } });
    ui.toast("Cost recorded (append-only).", "success");
  });
}

// ------------------------------------------------------------------------------------------------ price-change queue
async function renderPriceQueue(host, token, ui) {
  const { el, escapeHtml, badge, titleCase } = ui;
  const { price_changes: changes } = await ui.api(`${API}/price-changes`);
  if (token !== ui.state.renderToken) return;
  host.innerHTML = "";
  host.appendChild(el(`<div class="view-heading"><h1>Price approvals</h1><p>Requests need approval by a commercial approver who is not the requester, then publication. The selling price changes only at publication.</p></div>`));
  const me = String((ui.state.admin && ui.state.admin.email) || "").toLowerCase();
  const table = ui.renderDataTable({
    columns: [
      { label: "Requested", render: (c) => `${escapeHtml(ui.fmtDateTime(c.requested_at))}<br/><span class="muted">${escapeHtml(c.requested_by)}</span>` },
      { label: "Change", render: (c) => `${escapeHtml(naira(c.old_price_ngn_kobo))} → <strong>${escapeHtml(naira(c.new_price_ngn_kobo))}</strong><br/><span class="muted">${escapeHtml(c.new_vat_treatment)}${c.new_vat_rate_bp ? ` ${c.new_vat_rate_bp / 100}%` : ""}</span>` },
      { label: "State", render: (c) => `${badge(titleCase(c.state), PRICE_TONE[c.state] || "default")}${c.decided_by ? `<br/><span class="muted">${escapeHtml(c.decided_by)}</span>` : ""}` },
      { label: "Note", render: (c) => escapeHtml(c.note || c.decision_note || "") },
      { label: "", render: (c) => `<span data-price-actions="${escapeHtml(c.id)}"></span>`, width: "1.4fr" },
    ],
    rows: changes,
    emptyMessage: "No price changes yet.",
  });
  host.appendChild(table);
  changes.forEach((change) => {
    const target = host.querySelector(`[data-price-actions="${CSS.escape(change.id)}"]`);
    if (!target) return;
    const act = (label, path, tone) => {
      const b = el(`<button type="button" class="btn btn-sm ${tone}">${escapeHtml(label)}</button>`);
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        try { await ui.api(`${API}/price-changes/${change.id}/${path}`, { method: "POST", body: {} }); ui.toast(`${label}: done.`, "success"); }
        catch (error) { ui.toast(error.data && error.data.error === "own_request" ? "You cannot decide your own price request." : error.data && error.data.error === "price_changed_since_request" ? "The price changed since this request was made; request again." : error.message, "error"); }
        renderCatalogueRoute(host.closest(".cat").parentElement, ["prices"], ++ui.state.renderToken, ui);
      });
      target.appendChild(b);
    };
    if (change.state === "requested" && ui.hasPermission("catalogue.price.approve") && change.requested_by !== me) { act("Approve", "approve", "btn-primary"); act("Reject", "reject", "btn-ghost"); }
    if (change.state === "approved" && ui.hasPermission("catalogue.publish")) act("Publish price", "publish", "btn-primary");
  });
}

// ------------------------------------------------------------------------------------------------ categories and brands
async function renderTaxonomy(host, token, ui) {
  const { el, escapeHtml, badge } = ui;
  const [{ categories }, { brands }] = await Promise.all([ui.api(`${API}/categories`), ui.api(`${API}/brands`)]);
  if (token !== ui.state.renderToken) return;
  host.innerHTML = "";
  const canManage = ui.hasPermission("catalogue.publish");
  host.appendChild(el(`<div class="view-heading"><h1>Categories & brands</h1><p>${canManage ? "Changes are versioned by row and audited." : "Managed by catalogue publishers."}</p></div>`));
  const reload = () => renderCatalogueRoute(host.closest(".cat").parentElement, ["taxonomy"], ++ui.state.renderToken, ui);
  for (const [kind, rows] of [["categories", categories], ["brands", brands]]) {
    const section = el(`<section class="panel" style="margin-bottom:18px;"><div class="panel-head"><h2>${kind === "categories" ? "Categories" : "Brands"}</h2></div><div data-table></div></section>`);
    if (canManage) {
      const add = el(`<button type="button" class="btn btn-primary btn-sm" style="margin:8px 0;">Add ${kind === "categories" ? "category" : "brand"}</button>`);
      add.addEventListener("click", () => ui.openDialog(`Add ${kind === "categories" ? "category" : "brand"}`, [{ name: "name", label: "Name" }, { name: "slug", label: "Slug" }, { name: "sort", label: "Sort order", type: "number", value: "100" }], async (data) => {
        await ui.api(`${API}/${kind}`, { method: "POST", body: { name: data.name, slug: data.slug, sort: Number(data.sort || 0) } });
        reload();
      }));
      section.appendChild(add);
    }
    section.querySelector("[data-table]").appendChild(ui.renderDataTable({
      columns: [
        { label: "Name", render: (r) => escapeHtml(r.name) },
        { label: "Slug", render: (r) => `<code>${escapeHtml(r.slug)}</code>` },
        { label: "Order", render: (r) => String(r.sort) },
        { label: "Status", render: (r) => badge(r.status, r.status === "active" ? "green" : "default") },
      ],
      rows,
      onRowClick: canManage ? (r) => ui.openDialog(`Edit ${r.name}`, [{ name: "name", label: "Name", value: r.name }, { name: "sort", label: "Sort order", type: "number", value: String(r.sort) }, { name: "status", label: "Status", type: "select", value: r.status, options: ["active", "hidden"] }], async (data) => {
        try { await ui.api(`${API}/${kind}/${r.id}`, { method: "PATCH", body: { expected_row_version: r.row_version, name: data.name, sort: Number(data.sort || 0), status: data.status } }); }
        catch (error) { ui.toast(conflictMessage(error), "error"); }
        reload();
      }) : undefined,
      emptyMessage: "None yet.",
    }));
    host.appendChild(section);
  }
}

// ------------------------------------------------------------------------------------------------ suppliers (catalogue.cost.read)
async function renderSuppliers(host, token, ui) {
  const { el, escapeHtml, badge } = ui;
  const { suppliers } = await ui.api(`${API}/suppliers`);
  if (token !== ui.state.renderToken) return;
  host.innerHTML = "";
  host.appendChild(el(`<div class="view-heading"><h1>Suppliers</h1><p>Internal and commercially sensitive: visible only with catalogue cost access.</p></div>`));
  const reload = () => renderCatalogueRoute(host.closest(".cat").parentElement, ["suppliers"], ++ui.state.renderToken, ui);
  const fields = (s = {}) => [
    { name: "name", label: "Supplier name", value: s.name }, { name: "contact_name", label: "Contact", value: s.contact_name }, { name: "email", label: "Email", value: s.email },
    { name: "phone", label: "Phone", value: s.phone }, { name: "country", label: "Country", value: s.country }, { name: "payment_terms", label: "Payment terms", value: s.payment_terms },
    { name: "notes", label: "Notes", type: "textarea", value: s.notes },
  ];
  if (ui.hasPermission("catalogue.cost.manage")) {
    const add = el(`<button type="button" class="btn btn-primary btn-sm" style="margin-bottom:14px;">Add supplier</button>`);
    add.addEventListener("click", () => ui.openDialog("Add supplier", fields(), async (data) => { await ui.api(`${API}/suppliers`, { method: "POST", body: data }); reload(); }));
    host.appendChild(add);
  }
  host.appendChild(ui.renderDataTable({
    columns: [
      { label: "Supplier", render: (s) => escapeHtml(s.name) },
      { label: "Contact", render: (s) => `${escapeHtml(s.contact_name || "—")}<br/><span class="muted">${escapeHtml(s.email || "")}</span>` },
      { label: "Country", render: (s) => escapeHtml(s.country || "—") },
      { label: "Status", render: (s) => badge(s.status, s.status === "active" ? "green" : "default") },
    ],
    rows: suppliers,
    onRowClick: ui.hasPermission("catalogue.cost.manage") ? (s) => ui.openDialog(`Edit ${s.name}`, fields(s), async (data) => { await ui.api(`${API}/suppliers/${s.id}`, { method: "PATCH", body: data }); reload(); }) : undefined,
    emptyMessage: "No suppliers yet.",
  }));
}

export const __test__ = { naira, koboFromNaira, availability, parseOptions, optionsText };
