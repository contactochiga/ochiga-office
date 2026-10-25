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

// Scoped layout for these screens only (Office's stylesheet covers its own components: tables, badges, dialogs, panels).
const STYLE_ID = "catalogue-screen-styles";
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .catalogue-tabs .btn { width: auto; flex: 0 0 auto; }
    .catalogue-host label { display: grid; gap: 4px; font-size: 13px; }
    .catalogue-host input:not([type=checkbox]), .catalogue-host select, .catalogue-host textarea { width: 100%; box-sizing: border-box; min-width: 0; }
    .catalogue-host fieldset { border: 1px solid rgba(148,163,184,.35); border-radius: 10px; padding: 10px 12px; min-width: 0; margin: 0; }
    .catalogue-host fieldset legend { padding: 0 6px; font-size: 13px; }
    .catalogue-host .catalogue-editor { display: grid; gap: 12px; }
    .catalogue-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 18px; align-items: start; }
    .catalogue-row { display: grid; gap: 6px; margin-bottom: 6px; }
    .catalogue-row.spec { grid-template-columns: 2fr 2fr 1fr auto; }
    .catalogue-row.variant { grid-template-columns: 1.5fr 1.5fr 2fr auto; }
    .catalogue-heading-meta { overflow-wrap: anywhere; }
    @media (max-width: 900px) {
      .catalogue-grid { grid-template-columns: minmax(0, 1fr); }
      .catalogue-row.spec, .catalogue-row.variant { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
      .catalogue-host .view-heading { display: grid; gap: 6px; }
    }`;
  document.head.appendChild(style);
}

export async function renderCatalogueRoute(outlet, rest, token, ui) {
  const { setTopbar, setSelectedObject, el } = ui;
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
  setTopbar("Products", "Office-managed catalogue — internal only");
  const tabBar = el(`<div class="tab-bar catalogue-tabs" role="tablist" style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;"></div>`);
  tabs.forEach((tab) => {
    const button = el(`<button type="button" class="btn btn-sm ${tab.key === current ? "btn-primary" : "btn-ghost"}" role="tab">${ui.escapeHtml(tab.label)}</button>`);
    button.addEventListener("click", () => ui.navigate(tab.key ? `catalogue/${tab.key}` : "catalogue"));
    tabBar.appendChild(button);
  });
  outlet.appendChild(tabBar);
  const host = el(`<div class="catalogue-host"></div>`);
  outlet.appendChild(host);
  host.appendChild(ui.skeletonPanel(4));
  try {
    if (section === "products" && id) await renderProduct(host, id, token, ui);
    else if (section === "prices") await renderPriceQueue(host, token, ui);
    else if (section === "taxonomy") await renderTaxonomy(host, token, ui);
    else if (section === "suppliers") await renderSuppliers(host, token, ui);
    else await renderProductList(host, token, ui);
  } catch (error) {
    if (token !== ui.state.renderToken) return;
    host.innerHTML = "";
    host.appendChild(ui.errorPanel(error.status === 503 ? "The catalogue is not installed in this environment yet." : error.message || "Could not load the catalogue."));
  }
}

// ------------------------------------------------------------------------------------------------ product list
async function renderProductList(host, token, ui) {
  const { el, escapeHtml, badge, titleCase } = ui;
  const [{ products }, { categories }, { brands }, prices] = await Promise.all([
    ui.api(`${API}/products`), ui.api(`${API}/categories`), ui.api(`${API}/brands`), ui.api(`${API}/price-changes?state=requested`),
  ]);
  if (token !== ui.state.renderToken) return;
  host.innerHTML = "";
  host.appendChild(el(`<div class="view-heading"><h1>Products</h1><p>Hardware products, versions, reviews and publication state. Nothing here is public until the storefront phase.</p></div>`));
  const kpis = ui.KPIGroup([
    { label: "Drafts", value: products.filter((p) => p.workflow_status === "draft" && p.publication_status !== "archived").length },
    { label: "Awaiting review", value: products.filter((p) => p.workflow_status === "in_review").length, alert: products.some((p) => p.workflow_status === "in_review") },
    { label: "Approved, not live", value: products.filter((p) => p.workflow_status === "approved" && p.publication_status !== "published").length },
    { label: "Published", value: products.filter((p) => p.publication_status === "published").length },
    { label: "Price changes waiting", value: prices.price_changes.length, alert: prices.price_changes.length > 0, onClick: () => ui.navigate("catalogue/prices") },
  ]);
  kpis.style.marginBottom = "18px";
  host.appendChild(kpis);

  const bar = el(`<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
    <input type="search" class="input" placeholder="Search name, model or slug" aria-label="Search products" style="min-width:240px;" />
    <select aria-label="Workflow"><option value="">Any review state</option>${["draft", "in_review", "changes_requested", "approved"].map((s) => `<option value="${s}">${escapeHtml(titleCase(s))}</option>`).join("")}</select>
    <select aria-label="Publication"><option value="">Any publication</option>${["never_published", "published", "unpublished", "archived"].map((s) => `<option value="${s}">${escapeHtml(titleCase(s))}</option>`).join("")}</select>
  </div>`);
  if (ui.hasPermission("catalogue.write")) {
    const create = el(`<button type="button" class="btn btn-primary btn-sm">New product</button>`);
    create.addEventListener("click", () => openNewProduct(ui, categories, brands));
    bar.appendChild(create);
  }
  host.appendChild(bar);
  const tableHost = el(`<div></div>`);
  host.appendChild(tableHost);
  const categoryName = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  const [search, workflow, publication] = bar.querySelectorAll("input, select");
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const rows = products.filter((p) => (!q || `${p.name} ${p.model} ${p.slug}`.toLowerCase().includes(q)) && (!workflow.value || p.workflow_status === workflow.value) && (!publication.value || p.publication_status === publication.value));
    tableHost.innerHTML = "";
    tableHost.appendChild(ui.renderDataTable({
      columns: [
        { label: "Product", render: (p) => `<strong>${escapeHtml(p.name || p.slug)}</strong><br/><span class="muted">${escapeHtml(p.model || "")} · ${escapeHtml(p.slug)}</span>`, width: "2fr" },
        { label: "Category", render: (p) => escapeHtml(categoryName[p.category_id] || "—") },
        { label: "Review", render: (p) => badge(titleCase(p.workflow_status), WORKFLOW_TONE[p.workflow_status] || "default") },
        { label: "Publication", render: (p) => badge(titleCase(p.publication_status), PUBLICATION_TONE[p.publication_status] || "default") },
        { label: "Version", render: (p) => `v${p.current_version}${p.published_version ? ` · live v${p.published_version}` : ""}` },
        { label: "Updated", render: (p) => escapeHtml(ui.fmtRelative(p.updated_at)) },
      ],
      rows,
      onRowClick: (p) => ui.navigate(`catalogue/products/${p.id}`),
      emptyMessage: products.length ? "No product matches these filters." : "No products yet. Start with New product.",
    }));
  };
  [search, workflow, publication].forEach((input) => input.addEventListener("input", draw));
  draw();
}

function openNewProduct(ui, categories, brands) {
  ui.openDialog("New product", [
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

// ------------------------------------------------------------------------------------------------ product detail / editor
async function renderProduct(host, id, token, ui) {
  const { el, escapeHtml, badge, titleCase } = ui;
  const [detail, { categories }, { brands }] = await Promise.all([ui.api(`${API}/products/${id}`), ui.api(`${API}/categories`), ui.api(`${API}/brands`)]);
  if (token !== ui.state.renderToken) return;
  const { product, content, versions, reviews, publication_events: events, variants, permissions } = detail;
  ui.setSelectedObject("catalogue_product", product.id, content.name);
  const reload = () => renderCatalogueRoute(host.parentElement, ["products", id], ++ui.state.renderToken, ui);
  const act = async (path, body = {}, success) => {
    try {
      await ui.api(`${API}/products/${id}/${path}`, { method: "POST", body: { expected_row_version: product.row_version, ...body } });
      ui.toast(success, "success");
    } catch (error) {
      ui.toast(conflictMessage(error), "error");
    }
    reload();
  };
  host.innerHTML = "";
  const archived = product.publication_status === "archived";
  host.appendChild(el(`<div class="view-heading">
    <h1>${escapeHtml(content.name)}</h1>
    <p class="catalogue-heading-meta">${escapeHtml(content.model || "")} · <code>${escapeHtml(product.slug)}</code> · v${product.current_version} (${escapeHtml(detail.current_materiality)})
      ${product.published_version ? ` · live version v${product.published_version}` : ""}</p>
    <div style="display:flex;gap:6px;flex-wrap:wrap;">${badge(titleCase(product.workflow_status), WORKFLOW_TONE[product.workflow_status])} ${badge(titleCase(product.publication_status), PUBLICATION_TONE[product.publication_status])}
      ${product.publication_status === "published" ? badge("Internal publication only — no storefront yet", "default") : ""}</div>
  </div>`));

  // workflow actions, offered only when the state and the user's permissions allow them (the server re-checks everything)
  const actions = el(`<div class="catalogue-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 18px;"></div>`);
  const button = (label, tone, handler) => { const b = el(`<button type="button" class="btn btn-sm ${tone}">${escapeHtml(label)}</button>`); b.addEventListener("click", handler); actions.appendChild(b); };
  if (!archived) {
    if (permissions.write && ["draft", "changes_requested"].includes(product.workflow_status)) button("Submit for review", "btn-primary", () => act("submit", {}, "Submitted for review. Reviewers were notified."));
    // second-person rule (also enforced by the database): an author of any version in the pending change set is not offered review actions
    const me = String((ui.state.admin && ui.state.admin.email) || "").toLowerCase();
    const changeAuthors = new Set(versions.filter((v) => v.version > (product.published_version || 0) && v.version <= product.current_version).map((v) => String(v.author || "").toLowerCase()));
    if (permissions.review && product.workflow_status === "in_review" && !changeAuthors.has(me)) {
      button("Approve", "btn-primary", () => act("approve", {}, "Approved."));
      button("Request changes", "btn-ghost", () => ui.openDialog("Request changes", [{ name: "note", label: "What needs to change?", type: "textarea" }], (data) => act("request-changes", { note: data.note }, "Changes requested; the authors were notified.")));
    } else if (permissions.review && product.workflow_status === "in_review") {
      actions.appendChild(el(`<span class="muted catalogue-own-change">You authored this change — another reviewer must approve it.</span>`));
    }
    const live = product.publication_status === "published" && product.published_version === product.current_version;
    // every change is reviewed: publication is offered only for an approved current version (no minor/typo path)
    if (permissions.publish && !live && product.workflow_status === "approved" && product.approved_version === product.current_version) {
      button("Publish (internal)", "btn-primary", () => act("publish", {}, "Publication state updated."));
    }
    if (permissions.override && !live && !(product.workflow_status === "approved" && product.approved_version === product.current_version)) {
      button("Publish without review (override)", "btn-danger", () => ui.openDialog("Administrative override", [{ name: "override_reason", label: "Reason (at least 20 characters; recorded, reviewers are notified)", type: "textarea" }], (data) => act("publish", { override_reason: data.override_reason }, "Published by override; reviewers were notified.")));
    }
    if (permissions.publish && product.publication_status === "published") button("Unpublish", "btn-ghost", () => act("unpublish", {}, "Unpublished."));
    if (permissions.publish) button("Archive", "btn-ghost", () => { if (window.confirm("Archive this product? It is unpublished and can no longer be edited; its history is kept.")) act("archive", {}, "Archived."); });
  }
  if (permissions.write) button("Duplicate", "btn-ghost", () => ui.openDialog("Duplicate product", [{ name: "slug", label: "Slug for the copy" }, { name: "sku_suffix", label: "Suffix added to every SKU (SKUs are unique)", value: "-COPY" }], async (data) => {
    const copy = await ui.api(`${API}/products/${id}/duplicate`, { method: "POST", body: { slug: data.slug, sku_suffix: data.sku_suffix } });
    ui.toast("Copy created as a new draft.", "success");
    ui.navigate(`catalogue/products/${copy.product.id}`);
  }));
  host.appendChild(actions);

  const grid = el(`<div class="catalogue-grid"></div>`);
  host.appendChild(grid);
  const left = el(`<div></div>`), right = el(`<div></div>`);
  grid.appendChild(left); grid.appendChild(right);
  left.appendChild(editorPanel(ui, product, content, categories, brands, permissions.write && !archived, reload));
  left.appendChild(variantsPanel(ui, product, content, variants, permissions, reload));
  right.appendChild(historyPanel(ui, product, versions, reviews, events));
}

function conflictMessage(error) {
  if (error.status === 409 && error.data && error.data.error === "state_changed") return "Someone else changed this product a moment ago — the page has been reloaded. Please check and try again.";
  if (error.data && error.data.error === "own_change") return "You cannot review a change you authored. Ask another reviewer.";
  if (error.data && error.data.error === "review_required") return "This version needs approval by a second person before it can be published.";
  if (error.data && error.data.details) return `${error.message}: ${error.data.details.join("; ")}`;
  return error.message || "The action failed.";
}

function editorPanel(ui, product, content, categories, brands, editable, reload) {
  const { el, escapeHtml } = ui;
  const panel = el(`<section class="panel" style="margin-bottom:18px;"><div class="panel-head"><h2>Content (v${product.current_version})</h2></div><form class="catalogue-editor"></form></section>`);
  const form = panel.querySelector("form");
  const input = (name, label, value, type = "text") => `<label>${escapeHtml(label)}<input name="${name}" type="${type}" value="${escapeHtml(value || "")}" ${editable ? "" : "disabled"} /></label>`;
  form.innerHTML = `
    ${input("name", "Name", content.name)}
    ${input("model", "Model", content.model)}
    <label>Category<select name="category_id" ${editable ? "" : "disabled"}>${categories.map((c) => `<option value="${c.id}" ${c.id === content.category_id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select></label>
    <label>Brand<select name="brand_id" ${editable ? "" : "disabled"}><option value="">— none —</option>${brands.map((b) => `<option value="${b.id}" ${b.id === content.brand_id ? "selected" : ""}>${escapeHtml(b.name)}</option>`).join("")}</select></label>
    ${product.first_published_at ? `<p class="muted">Slug <code>${escapeHtml(product.slug)}</code> is fixed after first publication.</p>` : input("slug", "Slug", product.slug)}
    <label>Summary<textarea name="summary" rows="2" ${editable ? "" : "disabled"}>${escapeHtml(content.summary)}</textarea></label>
    <label>Description<textarea name="description" rows="6" ${editable ? "" : "disabled"}>${escapeHtml(content.description)}</textarea></label>
    <fieldset><legend>Specifications</legend><div data-specs></div>${editable ? `<button type="button" class="btn btn-ghost btn-sm" data-add-spec>Add specification</button>` : ""}</fieldset>
    <fieldset><legend>Oyi compatibility</legend>
      ${["facility", "experience", "core", "edge"].map((flag) => `<label style="display:inline-flex;gap:6px;margin-right:12px;"><input type="checkbox" name="compat_${flag}" ${content.compatibility[flag] ? "checked" : ""} ${editable ? "" : "disabled"} /> ${escapeHtml(flag[0].toUpperCase() + flag.slice(1))}</label>`).join("")}
      <label>Notes<input name="compat_notes" value="${escapeHtml(content.compatibility.notes)}" ${editable ? "" : "disabled"} /></label>
    </fieldset>
    <fieldset><legend>Variants (SKUs)</legend><div data-variants></div>${editable ? `<button type="button" class="btn btn-ghost btn-sm" data-add-variant>Add variant</button>` : ""}</fieldset>
    <p class="muted">Product gallery (5–12 images) and documents arrive in Phase 2, through the existing Office file storage.</p>
    ${editable ? `<div><button type="submit" class="btn btn-primary btn-sm">Save as new version</button> <span class="muted">Saving creates v${product.current_version + 1}; any pending review or approval is superseded.</span></div>` : ""}
    <p class="dialog-error" data-error></p>`;
  const specsHost = form.querySelector("[data-specs]");
  const variantsHost = form.querySelector("[data-variants]");
  const specRow = (spec = { key: "", value: "", unit: "" }) => {
    const row = el(`<div class="catalogue-row spec">
      <input data-k placeholder="Key" value="${escapeHtml(spec.key)}" ${editable ? "" : "disabled"} /><input data-v placeholder="Value" value="${escapeHtml(spec.value)}" ${editable ? "" : "disabled"} />
      <input data-u placeholder="Unit" value="${escapeHtml(spec.unit)}" ${editable ? "" : "disabled"} />${editable ? `<button type="button" class="btn btn-ghost btn-sm" aria-label="Remove specification">✕</button>` : "<span></span>"}</div>`);
    if (editable) row.querySelector("button").addEventListener("click", () => row.remove());
    specsHost.appendChild(row);
  };
  const variantRow = (variant = { sku: "", name: "", options: {} }) => {
    const row = el(`<div class="catalogue-row variant">
      <input data-sku placeholder="SKU" value="${escapeHtml(variant.sku)}" ${editable ? "" : "disabled"} /><input data-name placeholder="Variant name" value="${escapeHtml(variant.name)}" ${editable ? "" : "disabled"} />
      <input data-options placeholder="colour=white; size=2-gang" value="${escapeHtml(optionsText(variant.options))}" ${editable ? "" : "disabled"} />${editable ? `<button type="button" class="btn btn-ghost btn-sm" aria-label="Remove variant">✕</button>` : "<span></span>"}</div>`);
    if (editable) row.querySelector("button").addEventListener("click", () => row.remove());
    variantsHost.appendChild(row);
  };
  content.specifications.forEach(specRow);
  content.variants.forEach(variantRow);
  if (editable) {
    form.querySelector("[data-add-spec]").addEventListener("click", () => specRow());
    form.querySelector("[data-add-variant]").addEventListener("click", () => variantRow());
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const f = new FormData(form);
      const next = {
        category_id: f.get("category_id"), brand_id: f.get("brand_id") || null, name: f.get("name"), model: f.get("model"), summary: f.get("summary"), description: f.get("description"),
        specifications: [...specsHost.children].map((row) => ({ key: row.querySelector("[data-k]").value, value: row.querySelector("[data-v]").value, unit: row.querySelector("[data-u]").value })).filter((s) => s.key || s.value),
        compatibility: { facility: f.get("compat_facility") === "on", experience: f.get("compat_experience") === "on", core: f.get("compat_core") === "on", edge: f.get("compat_edge") === "on", notes: f.get("compat_notes") },
        variants: [...variantsHost.children].map((row) => ({ sku: row.querySelector("[data-sku]").value, name: row.querySelector("[data-name]").value, options: parseOptions(row.querySelector("[data-options]").value) })).filter((v) => v.sku || v.name),
      };
      try {
        const saved = await ui.api(`${API}/products/${product.id}`, { method: "PATCH", body: { expected_row_version: product.row_version, ...(f.get("slug") ? { slug: f.get("slug") } : {}), content: next } });
        ui.toast(`Saved v${saved.product.current_version} (${saved.current_materiality} change).`, "success");
        reload();
      } catch (error) {
        if (error.status === 409 && error.data && error.data.error === "state_changed") { ui.toast(conflictMessage(error), "error"); reload(); return; }
        form.querySelector("[data-error]").textContent = conflictMessage(error);
      }
    });
  }
  return panel;
}

function variantsPanel(ui, product, content, variants, permissions, reload) {
  const { el, escapeHtml, badge } = ui;
  const panel = el(`<section class="panel" style="margin-bottom:18px;"><div class="panel-head"><h2>Prices & inventory</h2></div><div data-table></div>
    <p class="muted">Prices are VAT-inclusive NGN; delivery and installation are never included. A price changes only after a request, approval by a different commercial approver, and publication.</p></section>`);
  const listed = new Set(content.variants.map((v) => v.sku));
  panel.querySelector("[data-table]").appendChild(ui.renderDataTable({
    columns: [
      { label: "SKU", render: (v) => `<code>${escapeHtml(v.sku)}</code>${listed.has(v.sku) ? "" : ` ${badge("not in current version", "default")}`}` },
      { label: "Price (incl. VAT)", render: (v) => `${escapeHtml(naira(v.price_ngn_kobo))}${v.vat_treatment ? `<br/><span class="muted">${escapeHtml(v.vat_treatment.replace("_", "-"))}${v.vat_rate_bp ? ` ${v.vat_rate_bp / 100}%` : ""}</span>` : ""}` },
      { label: "Stock", render: (v) => `${v.stock_on_hand} on hand · ${v.stock_reserved} reserved` },
      { label: "Availability", render: (v) => { const a = availability(v); return badge(a.label, a.tone); } },
      { label: "", render: (v) => `<span data-variant-actions="${escapeHtml(v.id)}"></span>`, width: "1.6fr" },
    ],
    rows: variants,
    emptyMessage: "No variants yet.",
  }));
  variants.forEach((variant) => {
    const host = panel.querySelector(`[data-variant-actions="${CSS.escape(variant.id)}"]`);
    if (!host) return;
    const small = (label, handler) => { const b = el(`<button type="button" class="btn btn-ghost btn-sm">${escapeHtml(label)}</button>`); b.addEventListener("click", (e) => { e.stopPropagation(); handler(); }); host.appendChild(b); };
    if (permissions.write) small("Request price", () => ui.openDialog(`Price change — ${variant.sku}`, [
      { name: "price", label: "New selling price in naira, VAT-inclusive (e.g. 185000.00)" },
      { name: "vat_treatment", label: "VAT treatment", type: "select", value: variant.vat_treatment || "standard", options: [{ value: "standard", label: "Standard (7.5 %)" }, { value: "exempt", label: "Exempt" }, { value: "zero_rated", label: "Zero-rated" }] },
      { name: "note", label: "Reason", type: "textarea" },
    ], async (data) => {
      await ui.api(`${API}/variants/${variant.id}/price-changes`, { method: "POST", body: { price_ngn_kobo: koboFromNaira(data.price), vat_treatment: data.vat_treatment, note: data.note } });
      ui.toast("Price change requested. A commercial approver must approve it, then it is published.", "success");
      reload();
    }));
    if (permissions.inventory) small("Inventory", () => ui.openDialog(`Inventory — ${variant.sku}`, [
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
    }));
    if (permissions.costRead) small("Costs", () => openCosts(ui, variant, permissions));
  });
  return panel;
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

function historyPanel(ui, product, versions, reviews, events) {
  const { el, escapeHtml, badge, titleCase } = ui;
  const panel = el(`<section class="panel"><div class="panel-head"><h2>History</h2></div><div data-items></div><div data-diff style="margin-top:12px;"></div></section>`);
  const items = [
    ...versions.map((v) => ({ at: v.created_at, html: `<strong>v${v.version}</strong> saved by ${escapeHtml(v.author)} ${badge(v.materiality, "amber")}${v.version > 1 ? ` <button type="button" class="btn btn-ghost btn-sm" data-diff-version="${v.version}">Changes vs v${v.version - 1}</button>` : ""}` })),
    ...reviews.map((r) => ({ at: r.created_at, html: `${badge(titleCase(r.decision), r.decision === "approved" ? "green" : r.decision === "override" ? "red" : "default")} v${r.version} by ${escapeHtml(r.actor)}${r.note ? `<br/><span class="muted">${escapeHtml(r.note)}</span>` : ""}` })),
    ...events.map((e) => ({ at: e.created_at, html: `${badge(titleCase(e.action), e.override ? "red" : "green")}${e.version ? ` v${e.version}` : ""} by ${escapeHtml(e.actor)}${e.override_reason ? `<br/><span class="muted">Override: ${escapeHtml(e.override_reason)}</span>` : ""}` })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const list = panel.querySelector("[data-items]");
  items.forEach((item) => list.appendChild(el(`<div class="timeline-item" style="padding:6px 0;border-bottom:1px solid var(--line, #e2e8f0);"><span class="muted">${escapeHtml(ui.fmtDateTime(item.at))}</span><br/>${item.html}</div>`)));
  list.querySelectorAll("[data-diff-version]").forEach((button) => button.addEventListener("click", async () => {
    const n = Number(button.getAttribute("data-diff-version"));
    const { diff } = await ui.api(`${API}/products/${product.id}/versions/${n}?diff_to=${n - 1}`);
    const host = panel.querySelector("[data-diff]");
    host.innerHTML = `<h3>v${n - 1} → v${n}</h3>` + (diff.length ? diff.map((d) => `<div style="margin-bottom:6px;"><code>${escapeHtml(d.field)}</code><br/><span class="muted">before:</span> ${escapeHtml(JSON.stringify(d.before))}<br/><span class="muted">after:</span> ${escapeHtml(JSON.stringify(d.after))}</div>`).join("") : "<p class=\"muted\">No content change.</p>");
  }));
  return panel;
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
        renderCatalogueRoute(host.parentElement, ["prices"], ++ui.state.renderToken, ui);
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
  const reload = () => renderCatalogueRoute(host.parentElement, ["taxonomy"], ++ui.state.renderToken, ui);
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
  const reload = () => renderCatalogueRoute(host.parentElement, ["suppliers"], ++ui.state.renderToken, ui);
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
