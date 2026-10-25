// Office staff screens for the product catalogue (Phase 1). Loaded on demand by office.js (dynamic import, like shared/oyi-core) and
// rendered with office.js's own primitives (passed in as `ui`), so it looks and behaves like every other Office workspace.
// Routes: #/catalogue (products) · #/catalogue/products/:id · #/catalogue/prices · #/catalogue/taxonomy · #/catalogue/suppliers
// Every action maps to one internal API call under /api/lead-agents/admin/catalogue; the server is the authority for permissions and
// state (a stale screen gets 409 state_changed and is reloaded). Nothing here is public: there is no storefront yet. Product images
// (Phase 2 stage 3) are served by authenticated Office URLs only.

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
    .cat-thumb img { width: 100%; height: 100%; object-fit: contain; background: #fff; display: block; }
    .cat-slot.img { padding: 0; overflow: hidden; border-style: solid; background: #fff; position: relative; }
    .cat-slot.img img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .cat-badge-cover { position: absolute; left: 6px; top: 6px; background: var(--red); color: #fff; font-size: 10.5px; font-weight: 700; padding: 2px 6px; border-radius: 6px; letter-spacing: .02em; }
    .cat-readiness { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; font-size: 12px; }
    .cat-readiness span { padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,.06); color: var(--text-secondary); }
    .cat-readiness span.ok { color: #7fd9a0; background: rgba(63,143,95,.14); }
    .cat-readiness span.warn { color: #e3a54b; background: rgba(201,134,43,.14); }
    .cat-mgrid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
    .cat-mtile { position: relative; aspect-ratio: 1 / 1; border: 1px solid var(--line-strong); border-radius: 10px; overflow: hidden; background: #fff; }
    .cat-mtile.selected { outline: 2px solid var(--red); outline-offset: 1px; }
    .cat-mtile.dragging { opacity: .4; }
    .cat-mtile.over { outline: 2px dashed var(--red-bright); }
    .cat-mtile > img { width: 100%; height: 100%; object-fit: contain; display: block; cursor: pointer; }
    .cat-mtile .cat-mpos { position: absolute; right: 6px; top: 6px; background: rgba(0,0,0,.6); color: #fff; font-size: 10.5px; padding: 1px 6px; border-radius: 6px; }
    .cat-mtile .cat-mflag { position: absolute; left: 6px; bottom: 6px; background: rgba(201,134,43,.92); color: #111; font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 5px; }
    .cat-gallery.summary { grid-template-columns: 2fr 1fr 1fr; }
    .cat-slot .cat-more { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(14,14,12,.6); color: #fff; font-weight: 700; font-size: 15px; }
    .cat-mtile .cat-mctl { opacity: 0; transition: opacity .12s; }
    .cat-mtile:hover .cat-mctl, .cat-mtile:focus-within .cat-mctl, .cat-mtile.selected .cat-mctl { opacity: 1; }
    @media (hover: none) { .cat-mtile .cat-mctl { opacity: 1; } }
    .cat-mctl { position: absolute; left: 0; right: 0; bottom: 0; display: flex; justify-content: space-between; gap: 2px; padding: 3px; background: rgba(14,14,12,.82); }
    .cat-mctl button { flex: 1; min-width: 0; height: 24px; border: 0; border-radius: 5px; background: transparent; color: #fff; cursor: pointer; font-size: 12px; padding: 0; }
    .cat-mctl button:hover:not(:disabled) { background: rgba(255,255,255,.14); }
    .cat-mctl button:disabled { opacity: .35; cursor: default; }
    .cat-mslot { aspect-ratio: 1 / 1; border: 1px dashed var(--line-strong); border-radius: 10px; display: grid; place-items: center; color: var(--text-tertiary); font-size: 11.5px; text-align: center; padding: 6px; background: rgba(255,255,255,.015); }
    button.cat-mslot { cursor: pointer; font: inherit; font-size: 11.5px; color: var(--text-secondary); }
    button.cat-mslot:hover { border-color: var(--red); color: var(--text-primary); }
    .cat-drop.over { outline: 2px dashed var(--red); outline-offset: 4px; border-radius: 10px; }
    .cat-mdetail { margin-top: 12px; display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
    .cat-mdetail > img { width: 96px; height: 96px; object-fit: contain; background: #fff; border-radius: 8px; }
    .cat-mdetail .cat-fields { grid-template-columns: 1fr; gap: 8px; }
    .cat-mvariants { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12.5px; color: var(--text-secondary); }
    .cat-mvariants label { display: inline-flex; gap: 6px; align-items: center; }
    .cat-mvariants input { width: auto; }
    .cat-uploads { margin-top: 12px; display: grid; gap: 6px; }
    .cat-upl { display: grid; grid-template-columns: minmax(0, 1fr) 120px auto; gap: 10px; align-items: center; font-size: 12.5px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; }
    .cat-upl .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cat-upl .bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,.08); overflow: hidden; }
    .cat-upl .bar i { display: block; height: 100%; width: 0; background: var(--red); transition: width .15s; }
    .cat-upl.done .bar i { background: #3f8f5f; }
    .cat-upl.failed { border-color: rgba(179,36,27,.5); }
    .cat-upl .state { color: var(--text-tertiary); white-space: nowrap; display: flex; gap: 6px; align-items: center; }
    .cat-upl.failed .state { color: var(--red-bright); }
    .cat-lib { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
    .cat-lib .cat-mtile .cat-mctl button { font-size: 11px; }
    .cat-sm { height: 30px; padding: 0 10px; font-weight: 500; }
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
      .cat-mgrid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .cat-lib { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .cat-upl { grid-template-columns: minmax(0, 1fr) 70px; } .cat-upl .state { grid-column: 1 / -1; }
      .cat-mdetail { grid-template-columns: 1fr; } .cat-mdetail > img { width: 100%; height: 160px; }
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
  image: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 2.5-2.5L20 19"/></svg>',
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

// Gallery images are authenticated Office URLs (catalogue.read session); nothing is public.
const mediaUrl = (mediaId, kind = "thumb") => `${API}/media/${encodeURIComponent(mediaId)}/${kind}`;
const thumbHtml = (ui, mediaId, alt = "") => (mediaId ? `<img src="${ui.escapeHtml(mediaUrl(mediaId))}" alt="${ui.escapeHtml(alt)}" loading="lazy" decoding="async" />` : ICONS.box);

const MEDIA_MAX = 12;
const MEDIA_VISIBLE = 5;
const UPLOAD_MAX_BYTES = 15 * 1024 * 1024;
const UPLOAD_ERRORS = {
  unsupported_image_type: "Not a JPEG, PNG or WebP image",
  image_too_large: "Larger than 15 MB",
  image_unreadable: "Damaged file, or not a real image",
  image_format_mismatch: "The file content does not match its image format",
  image_animated: "Animated images are not supported",
  image_dimensions_too_small: "Too small (at least 200 px per side)",
  image_dimensions_too_large: "Too large (at most 8000 px per side)",
  image_too_many_pixels: "Too many pixels (at most 40 megapixels)",
  image_empty: "Empty file",
  product_archived: "The product is archived",
  media_limit: "This product already stores 60 images",
  media_unavailable: "Image storage is not available in this environment",
  forbidden: "You do not have permission to upload images",
};

// Raw-bytes upload with progress (fetch has no upload progress). The server learns everything about the file from its content.
function uploadImage(productId, file, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/products/${encodeURIComponent(productId)}/media?name=${encodeURIComponent(file.name || "image")}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => { let json = null; try { json = JSON.parse(xhr.responseText); } catch { /* not json */ } resolve({ status: xhr.status, json }); };
    xhr.onerror = () => resolve({ status: 0, json: null });
    xhr.send(file);
  });
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
        <div class="cat-prod"><div class="cat-thumb">${thumbHtml(ui, card.cover_media_id)}</div><div class="cat-prod-text"><b>${escapeHtml(card.name)}</b><span>${escapeHtml(card.summary || card.model || card.slug)}</span></div></div>
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
    <div class="cat-thumb" data-head-thumb>${thumbHtml(ui, ((content.media || []).find((m) => m.cover) || {}).media_id, content.name)}</div>
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

  // ---- gallery (Phase 2 stage 3). draft.media = [{media_id, cover, alt, caption, variant_skus}], array order = gallery order.
  // Uploads go to the product's image library at once; arranging the gallery is a content change saved (and reviewed) as a new version.
  const library = { available: Boolean(detail.media_library && detail.media_library.available), items: (detail.media_library && detail.media_library.items) || [] };
  const uploads = [];
  let uploadSeq = 0;
  let selectedMedia = null;
  let showAllSlots = false;
  if (!Array.isArray(draft.media)) draft.media = [];
  const canArrange = () => canEdit && library.available;
  const libraryItem = (mediaId) => library.items.find((m) => m.id === mediaId);
  const uploading = () => uploads.some((u) => u.state === "queued" || u.state === "uploading" || u.state === "processing");
  const changeGallery = () => {
    editing = true; markDirty(); drawBody();
    const cover = draft.media.find((m) => m.cover);
    const headThumb = right.querySelector("[data-head-thumb]");
    if (headThumb) headThumb.innerHTML = thumbHtml(ui, cover && cover.media_id, draft.name);
  };
  const ensureCover = () => { if (draft.media.length && !draft.media.some((m) => m.cover)) draft.media[0].cover = true; };
  const readinessHtml = () => {
    const missingAlt = draft.media.filter((m) => !String(m.alt || "").trim()).length;
    const cover = draft.media.some((m) => m.cover);
    return `<div class="cat-readiness" data-readiness>
      <span class="${cover ? "ok" : "warn"}">${cover ? "Cover chosen" : "No cover image"}</span>
      <span class="${draft.media.length && !missingAlt ? "ok" : "warn"}">${draft.media.length ? (missingAlt ? `${missingAlt} without alt text` : "Alt text on every image") : "No images"}</span>
      ${draft.media.length < MEDIA_VISIBLE ? `<span>${MEDIA_VISIBLE} images recommended</span>` : ""}
      <span>Public publishing (next stage) needs a cover and alt text on every image</span></div>`;
  };

  // Overview: a compact summary (cover + the next four), full tools live in the Media tab
  function gallerySummary() {
    const items = draft.media;
    const slot = (item, index) => {
      const cls = index === 0 ? "cat-slot cover" : "cat-slot";
      if (!item) return `<div class="${cls}">${index === 0 ? "Cover image" : `Image ${index + 1}`}</div>`;
      return `<div class="${cls} img"><img src="${escapeHtml(mediaUrl(item.media_id, index === 0 ? "w480" : "thumb"))}" alt="${escapeHtml(item.alt || "")}" loading="lazy" />${item.cover ? `<span class="cat-badge-cover">Cover</span>` : ""}${index === 4 ? extra : ""}</div>`;
    };
    const ordered = [...items].sort((a, b) => Number(b.cover) - Number(a.cover));
    const extra = items.length > MEDIA_VISIBLE ? `<span class="cat-more">+${items.length - MEDIA_VISIBLE}</span>` : "";
    const card = el(`<div class="cat-card" data-gallery-summary><div class="cat-card-head"><h3>Media gallery (${items.length}/${MEDIA_MAX})</h3><button type="button" class="cat-btn cat-sm" data-manage-media>${ICONS.image} ${canArrange() ? "Manage images" : "View images"}</button></div>
      <div class="cat-gallery summary">${[0, 1, 2, 3, 4].map((i) => slot(ordered[i], i)).join("")}</div>${readinessHtml()}</div>`);
    card.querySelector("[data-manage-media]").addEventListener("click", () => { browse.tab = "media"; tabBar.querySelectorAll(".cat-ed-tab").forEach((t) => t.classList.toggle("active", t.dataset.edtab === "media")); drawBody(); });
    return card;
  }

  function startUploads(files, { replaceIndex = null } = {}) {
    [...files].forEach((file) => {
      const job = { key: `u${(uploadSeq += 1)}`, file, name: file.name || "image", progress: 0, state: "queued", message: "", replaceIndex, busyRetries: 0 };
      if (file.size > UPLOAD_MAX_BYTES) Object.assign(job, { state: "failed", message: UPLOAD_ERRORS.image_too_large, final: true });
      uploads.push(job);
    });
    drawUploads();
    pumpUploads();
  }
  function pumpUploads() {
    // two at a time: the server processes one image at a time and queues a few
    while (uploads.filter((u) => u.state === "uploading" || u.state === "processing").length < 2) {
      const next = uploads.find((u) => u.state === "queued");
      if (!next) break;
      runUpload(next);
    }
    drawBar();
  }
  async function runUpload(job) {
    job.state = "uploading"; job.progress = 0; job.message = ""; drawUpload(job);
    const result = await uploadImage(id, job.file, (fraction) => { job.progress = fraction; if (fraction >= 1) job.state = "processing"; drawUpload(job); });
    if ((result.status === 201 || result.status === 200) && result.json && result.json.media) {
      const media = result.json.media;
      if (!libraryItem(media.id)) library.items.push(media);
      job.state = "done"; job.progress = 1;
      job.message = result.json.deduplicated ? "Already uploaded — reused" : "Uploaded";
      placeUploaded(job, media);
    } else if (result.status === 503 && result.json && result.json.error === "media_busy" && job.busyRetries < 3) {
      job.busyRetries += 1; job.state = "queued"; job.message = "Server busy — retrying";
      setTimeout(pumpUploads, 3000);
    } else {
      const code = result.json && result.json.error;
      job.state = "failed";
      job.final = Boolean(code && UPLOAD_ERRORS[code] && code !== "media_unavailable");
      job.message = (code && UPLOAD_ERRORS[code]) || (result.status === 0 ? "Connection lost" : `Upload failed (${result.status})`);
    }
    drawUpload(job);
    pumpUploads();
  }
  // a finished upload joins the gallery (or replaces its slot) in the draft; it becomes part of the product only when the draft is saved
  function placeUploaded(job, media) {
    if (!canArrange()) return;
    if (job.replaceIndex != null && draft.media[job.replaceIndex]) {
      const slotItem = draft.media[job.replaceIndex];
      if (slotItem.media_id !== media.id && !draft.media.some((m) => m.media_id === media.id)) {
        draft.media[job.replaceIndex] = { ...slotItem, media_id: media.id };
        selectedMedia = media.id;
      }
    } else if (!draft.media.some((m) => m.media_id === media.id) && draft.media.length < MEDIA_MAX) {
      draft.media.push({ media_id: media.id, cover: draft.media.length === 0, alt: "", caption: "", variant_skus: [] });
    } else if (draft.media.length >= MEDIA_MAX) {
      job.message = "Uploaded — gallery is full (12); kept in the library";
    }
    changeGallery();
  }
  function uploadRowHtml(job) {
    const state = { queued: job.message || "Waiting", uploading: `${Math.round(job.progress * 100)}%`, processing: "Processing…", done: job.message, failed: job.message }[job.state];
    return `<div class="cat-upl ${job.state}" data-upload="${job.key}"><span class="name" title="${escapeHtml(job.name)}">${escapeHtml(job.name)}</span>
      <span class="bar"><i style="width:${Math.round((job.state === "done" ? 1 : job.progress) * 100)}%"></i></span>
      <span class="state">${escapeHtml(state || "")}${job.state === "failed" && !job.final ? ` <button type="button" class="cat-btn cat-sm" data-retry="${job.key}">Retry</button>` : ""}${job.state === "failed" || job.state === "done" ? ` <button type="button" class="cat-rowmenu" data-dismiss="${job.key}" aria-label="Dismiss">✕</button>` : ""}</span></div>`;
  }
  function wireUploadRow(node) {
    node.querySelectorAll("[data-retry]").forEach((b) => b.addEventListener("click", () => { const job = uploads.find((u) => u.key === b.dataset.retry); if (job) { job.state = "queued"; job.busyRetries = 0; drawUpload(job); pumpUploads(); } }));
    node.querySelectorAll("[data-dismiss]").forEach((b) => b.addEventListener("click", () => { const i = uploads.findIndex((u) => u.key === b.dataset.dismiss); if (i >= 0) uploads.splice(i, 1); drawUploads(); }));
  }
  function drawUpload(job) {
    const node = body.querySelector(`[data-upload="${job.key}"]`);
    if (!node) return;
    const fresh = el(uploadRowHtml(job));
    node.replaceWith(fresh);
    wireUploadRow(fresh);
  }
  function drawUploads() {
    const host = body.querySelector("[data-uploads]");
    if (!host) return;
    host.innerHTML = "";
    uploads.forEach((job) => { const row = el(uploadRowHtml(job)); wireUploadRow(row); host.appendChild(row); });
  }
  const pickFiles = ({ multiple = true, onPick }) => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = multiple; input.accept = "image/jpeg,image/png,image/webp";
    input.addEventListener("change", () => { if (input.files && input.files.length) onPick(input.files); });
    input.click();
  };

  function mediaWorkspace() {
    const wrap = el(`<div></div>`);
    if (!library.available) {
      wrap.appendChild(el(`<div class="cat-card"><div class="cat-card-head"><h3>Media gallery</h3></div><p class="cat-note" style="margin:0;">Image storage is not installed in this environment yet.</p></div>`));
      return wrap;
    }
    const arrange = canArrange();
    const count = draft.media.length;
    const slots = Math.min(MEDIA_MAX, showAllSlots || count >= MEDIA_VISIBLE ? Math.max(MEDIA_VISIBLE, count + (arrange && count < MEDIA_MAX ? 1 : 0)) : MEDIA_VISIBLE);
    const card = el(`<div class="cat-card cat-drop" data-media-gallery><div class="cat-card-head"><h3>Gallery (${count}/${MEDIA_MAX})</h3>
      <div style="display:flex;gap:8px;">${arrange ? `<button type="button" class="cat-btn cat-sm" data-add-images>${ICONS.plus} Add images</button>` : ""}</div></div>
      <div class="cat-mgrid" data-mgrid></div>
      ${slots < MEDIA_MAX && count < MEDIA_MAX && arrange ? `<button type="button" class="cat-clear" style="margin-top:8px;" data-more-slots>Show all ${MEDIA_MAX} positions</button>` : ""}
      ${readinessHtml()}
      <p class="cat-note" style="margin:8px 0 0;">${arrange ? "JPEG, PNG or WebP, up to 15 MB each. Drag images here or use Add images. Drag tiles (or use ‹ ›) to reorder; ★ sets the cover. Changes are saved as a new draft version and reviewed like any other content." : "Read-only."}</p>
      <div class="cat-uploads" data-uploads></div><div data-mdetail></div></div>`);
    const grid = card.querySelector("[data-mgrid]");
    let dragFrom = null;
    draft.media.forEach((item, index) => {
      const lib = libraryItem(item.media_id);
      const tile = el(`<div class="cat-mtile ${selectedMedia === item.media_id ? "selected" : ""}" data-media-tile="${escapeHtml(item.media_id)}" ${arrange ? 'draggable="true"' : ""}>
        <img src="${escapeHtml(mediaUrl(item.media_id))}" alt="${escapeHtml(item.alt || "")}" loading="lazy" title="${escapeHtml(lib ? `${lib.width}×${lib.height} ${lib.format.toUpperCase()}` : "")}" />
        ${item.cover ? `<span class="cat-badge-cover">Cover</span>` : ""}<span class="cat-mpos">${index + 1}</span>
        ${!String(item.alt || "").trim() ? `<span class="cat-mflag">No alt</span>` : ""}
        ${arrange ? `<div class="cat-mctl"><button type="button" data-move="-1" aria-label="Move earlier" ${index === 0 ? "disabled" : ""}>‹</button><button type="button" data-cover aria-label="Set as cover" ${item.cover ? "disabled" : ""}>★</button><button type="button" data-details aria-label="Edit details">✎</button><button type="button" data-replace aria-label="Replace image">⇄</button><button type="button" data-remove aria-label="Remove from gallery">✕</button><button type="button" data-move="1" aria-label="Move later" ${index === count - 1 ? "disabled" : ""}>›</button></div>` : ""}</div>`);
      tile.querySelector("img").addEventListener("click", () => { selectedMedia = selectedMedia === item.media_id ? null : item.media_id; drawBody(); });
      if (arrange) {
        tile.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", () => { const to = index + Number(b.dataset.move); [draft.media[index], draft.media[to]] = [draft.media[to], draft.media[index]]; changeGallery(); }));
        tile.querySelector("[data-cover]").addEventListener("click", () => { draft.media.forEach((m) => { m.cover = m === item; }); changeGallery(); });
        tile.querySelector("[data-details]").addEventListener("click", () => { selectedMedia = item.media_id; drawBody(); });
        tile.querySelector("[data-replace]").addEventListener("click", () => pickFiles({ multiple: false, onPick: (files) => startUploads(files, { replaceIndex: index }) }));
        tile.querySelector("[data-remove]").addEventListener("click", () => { draft.media.splice(index, 1); ensureCover(); if (selectedMedia === item.media_id) selectedMedia = null; changeGallery(); });
        tile.addEventListener("dragstart", (e) => { dragFrom = index; tile.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(index)); });
        tile.addEventListener("dragend", () => tile.classList.remove("dragging"));
        tile.addEventListener("dragover", (e) => { if (dragFrom !== null) { e.preventDefault(); tile.classList.add("over"); } });
        tile.addEventListener("dragleave", () => tile.classList.remove("over"));
        tile.addEventListener("drop", (e) => { if (dragFrom === null) return; e.preventDefault(); e.stopPropagation(); const [moved] = draft.media.splice(dragFrom, 1); draft.media.splice(index, 0, moved); dragFrom = null; changeGallery(); });
      }
      grid.appendChild(tile);
    });
    for (let i = count; i < slots; i += 1) {
      const label = i === 0 ? "Cover image" : `Image ${i + 1}`;
      const slot = arrange ? el(`<button type="button" class="cat-mslot" data-empty-slot>${ICONS.plus}<br/>${label}</button>`) : el(`<div class="cat-mslot">${label}</div>`);
      if (arrange) slot.addEventListener("click", () => pickFiles({ onPick: (files) => startUploads(files) }));
      grid.appendChild(slot);
    }
    if (arrange) {
      card.querySelector("[data-add-images]").addEventListener("click", () => pickFiles({ onPick: (files) => startUploads(files) }));
      const more = card.querySelector("[data-more-slots]");
      if (more) more.addEventListener("click", () => { showAllSlots = true; drawBody(); });
      card.addEventListener("dragover", (e) => { if (dragFrom === null && e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); card.classList.add("over"); } });
      card.addEventListener("dragleave", (e) => { if (e.target === card) card.classList.remove("over"); });
      card.addEventListener("drop", (e) => { if (dragFrom !== null || !e.dataTransfer || !e.dataTransfer.files.length) return; e.preventDefault(); card.classList.remove("over"); startUploads(e.dataTransfer.files); });
    }

    // inline details of the selected image: alt text, caption, variant links (no dialog)
    const selected = draft.media.find((m) => m.media_id === selectedMedia);
    if (selected) {
      const lib = libraryItem(selected.media_id);
      const dis2 = arrange ? "" : "disabled";
      const panel = el(`<div class="cat-mdetail" data-media-detail><img src="${escapeHtml(mediaUrl(selected.media_id, "w480"))}" alt="${escapeHtml(selected.alt || "")}" />
        <div class="cat-fields">
          <label class="cat-field">Alt text (describes the image for screen readers and search; required before public publishing)<input data-alt maxlength="250" value="${escapeHtml(selected.alt || "")}" ${dis2} /></label>
          <label class="cat-field">Caption<input data-caption maxlength="300" value="${escapeHtml(selected.caption || "")}" ${dis2} /></label>
          <div class="cat-field">Shown for variants (none = all variants)<div class="cat-mvariants">${draft.variants.map((v) => `<label><input type="checkbox" data-vsku="${escapeHtml(v.sku)}" ${(selected.variant_skus || []).includes(v.sku) ? "checked" : ""} ${dis2} /> ${escapeHtml(v.sku)} · ${escapeHtml(v.name)}</label>`).join("")}</div></div>
          <span class="cat-note">${lib ? `${lib.width}×${lib.height} ${escapeHtml(lib.format.toUpperCase())} · ${(lib.bytes / 1024 / 1024).toFixed(1)} MB · uploaded by ${escapeHtml(lib.uploaded_by)}` : ""}</span>
        </div></div>`);
      if (arrange) {
        panel.querySelector("[data-alt]").addEventListener("input", (e) => { selected.alt = e.target.value; editing = true; markDirty(); const r = card.querySelector("[data-readiness]"); if (r) r.outerHTML = readinessHtml(); });
        panel.querySelector("[data-caption]").addEventListener("input", (e) => { selected.caption = e.target.value; editing = true; markDirty(); });
        panel.querySelectorAll("[data-vsku]").forEach((c) => c.addEventListener("change", () => { selected.variant_skus = [...panel.querySelectorAll("[data-vsku]:checked")].map((x) => x.dataset.vsku); editing = true; markDirty(); }));
        panel.querySelector("[data-alt]").addEventListener("change", () => drawBody());
      }
      card.querySelector("[data-mdetail]").appendChild(panel);
    }
    wrap.appendChild(card);

    // the library: uploaded images not in this draft's gallery. Never-used ones can be deleted; used ones stay for the version history.
    const spare = library.items.filter((m) => m.status === "active" && !draft.media.some((g) => g.media_id === m.id));
    if (spare.length) {
      const libCard = el(`<div class="cat-card" data-media-library><div class="cat-card-head"><h3>Image library</h3><span class="cat-note">${spare.length} not in the gallery</span></div><div class="cat-lib"></div>
        <p class="cat-note" style="margin:8px 0 0;">Images used by any saved version stay available for that version's history and cannot be deleted.</p></div>`);
      const libGrid = libCard.querySelector(".cat-lib");
      spare.forEach((m) => {
        const used = (m.referenced_by_versions || []).length > 0;
        const tile = el(`<div class="cat-mtile" data-library-item="${escapeHtml(m.id)}"><img src="${escapeHtml(m.urls.thumb || mediaUrl(m.id))}" alt="" loading="lazy" title="${escapeHtml(m.original_name || "")}" />
          ${used ? `<span class="cat-mpos" title="Used by saved versions">v${escapeHtml(m.referenced_by_versions.join(", v"))}</span>` : ""}
          ${arrange ? `<div class="cat-mctl"><button type="button" data-lib-add ${draft.media.length >= MEDIA_MAX ? "disabled" : ""}>Add</button>${used ? "" : `<button type="button" data-lib-delete>Delete</button>`}</div>` : ""}</div>`);
        if (arrange) {
          tile.querySelector("[data-lib-add]").addEventListener("click", () => { draft.media.push({ media_id: m.id, cover: draft.media.length === 0, alt: "", caption: "", variant_skus: [] }); changeGallery(); });
          const del = tile.querySelector("[data-lib-delete]");
          if (del) del.addEventListener("click", async () => {
            if (!window.confirm("Delete this image permanently? It is not used by any saved version.")) return;
            try {
              const result = await ui.api(`${API}/media/${m.id}/remove`, { method: "POST", body: {} });
              library.items = result.media_library.items;
              ui.toast("Image deleted.", "success");
            } catch (error) { ui.toast(error.data && error.data.error === "media_referenced" ? "This image is used by a saved version and cannot be deleted." : conflictMessage(error), "error"); }
            drawBody();
          });
        }
        libGrid.appendChild(tile);
      });
      wrap.appendChild(libCard);
    }
    return wrap;
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
      body.appendChild(gallerySummary());
    } else if (tab === "media") {
      body.appendChild(mediaWorkspace());
      drawUploads();
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
      button("Cancel", "", () => { editing = false; dirty = false; selectedMedia = null; Object.assign(draft, JSON.parse(JSON.stringify(content))); if (!Array.isArray(draft.media)) draft.media = []; drawBody(); drawBar(); });
      if (uploading()) bar.appendChild(el(`<span class="cat-note">Waiting for uploads…</span>`));
      button("Save draft", "cat-btn-primary", save, dirty && !uploading() ? "" : "disabled");
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
