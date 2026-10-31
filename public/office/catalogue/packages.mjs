// Solutions & Packages (SP2): Office screens for packages and services. A package is a catalogue item of kind "package": every action
// here calls the EXISTING catalogue endpoints (create, versioned save, submit, second-person approval, internal publication, price
// approval, public release / withdrawal, preview). The readiness panel and every refusal come from the server; nothing is decided here.
const API = "/api/lead-agents/admin/catalogue";
const SOLUTIONS = [["residential", "Residential"], ["hospitality", "Hospitality"], ["commercial", "Commercial"], ["mixed-use", "Mixed-use"], ["healthcare", "Healthcare"]];
const ROLES = [["required", "Required"], ["optional", "Optional"], ["recommended", "Recommended"]];
const AVAILABILITY = { in_stock: "In stock", available_to_order: "Available to order", unavailable: "Unavailable" };
const naira = (kobo) => (Number.isSafeInteger(kobo) ? `₦${(kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : "—");

const blankPackage = (categoryId) => ({
  category_id: categoryId || "", brand_id: null, name: "", model: "", summary: "", description: "", specifications: [],
  compatibility: { facility: true, experience: true, core: false, edge: false, notes: "" },
  variants: [{ sku: "", name: "Standard", options: {}, pricing: "fixed" }],
  media: [], documents: [],
  package: {
    solution_types: [],
    scope: { hardware: "", software_deployment: "Oyi deployment is planned with your team in a consultation.", installation: "quoted_separately", installation_note: "" },
    configuration: { custom: false, per_unit_label: "" },
    components: [],
  },
});

export async function renderPackages(host, token, ui, selectedId = null) {
  const { el, escapeHtml: esc } = ui;
  // The catalogue endpoint caps a page at 100. Follow its pages instead of silently hiding older approved SKUs.
  const allCards = async (kind) => {
    const first = await ui.api(`${API}/products?view=cards&kind=${kind}&page_size=100`);
    const products = [...(first.products || [])];
    for (let page = 2; page <= Math.min(first.pages || 1, 50); page += 1) {
      if (token !== ui.state.renderToken) break;
      const next = await ui.api(`${API}/products?view=cards&kind=${kind}&page_size=100&page=${page}`);
      products.push(...(next.products || []));
    }
    return {...first, products};
  };
  const [cards, services, categories, options] = await Promise.all([
    allCards("package"),
    allCards("service"),
    ui.api(`${API}/categories`),
    allCards("all"),
  ]);
  if (token !== ui.state.renderToken) return;
  host.innerHTML = "";
  host.appendChild(el(`<style>.pkg-layout{display:grid;grid-template-columns:minmax(260px,340px) minmax(0,1fr);gap:16px;align-items:start}.pkg-layout [data-editor]{min-width:0}.pkg-layout button.cat-row{border:1px solid var(--line-strong);border-radius:8px;padding:10px 12px;background:var(--black);color:var(--text-primary);cursor:pointer}.pkg-layout button.cat-row.active{border-color:var(--red);background:var(--cat-row-sel)}.pkg-layout .cat-input{min-height:36px;padding:8px 10px;border:1px solid var(--line-strong);border-radius:8px;background:var(--black);color:var(--text-primary);font:inherit}.pkg-layout :focus-visible{outline:2px solid var(--red);outline-offset:3px}.pkg-layout table{display:block;overflow:auto}.pkg-layout input,.pkg-layout select,.pkg-layout textarea{max-width:100%}@media(max-width:800px){.pkg-component-fields{grid-template-columns:repeat(2,minmax(0,1fr))!important}.pkg-layout{grid-template-columns:minmax(0,1fr)}.pkg-layout [data-media]{grid-template-columns:60px minmax(0,1fr)!important}.pkg-layout [data-media]>span{grid-column:1/-1}}</style>`));
  const canWrite = ui.hasPermission("catalogue.write");
  const layout = el(`<div class="pkg-layout"></div>`);
  host.appendChild(layout);

  // ---- list
  const list = el(`<section class="cat-panel" style="padding:16px" aria-labelledby="pkg-list-h"><h2 id="pkg-list-h" style="margin-top:0">Packages</h2>
    <p class="cat-muted">Bundles of approved hardware and services, with Oyi deployment by consultation. Prices cover hardware; installation is quoted separately unless a package says it is included.</p>
    <div data-actions class="cat-head-actions"></div><ul data-list style="list-style:none;padding:0;margin:12px 0 0;display:grid;gap:8px"></ul></section>`);
  const left = el(`<div data-left-column></div>`);
  left.appendChild(list);
  layout.appendChild(left);
  if (canWrite) {
    const add = el(`<button type="button" class="cat-btn" data-new-package>New package</button>`);
    add.addEventListener("click", () => ui.navigate("catalogue/packages/new"));
    const svc = el(`<button type="button" class="cat-btn" data-new-service>New service</button>`);
    svc.addEventListener("click", () => openServiceDialog(ui, categories.categories));
    list.querySelector("[data-actions]").append(add, svc);
  }
  const items = cards.products || [];
  if (cards.truncated || options.truncated || cards.pages > 50 || options.pages > 50) list.appendChild(el(`<p role="status">Catalogue results reached the 5,000-item review limit. Some items are not shown.</p>`));
  if (!items.length) list.querySelector("[data-list]").appendChild(el(`<li class="cat-muted">No packages yet.</li>`));
  for (const c of items) {
    const li = el(`<li><button type="button" class="cat-row ${c.id === selectedId ? "active" : ""}" style="width:100%;text-align:left" data-package-row="${esc(c.id)}">
      <strong>${esc(c.name || c.slug)}</strong><br><span class="cat-muted">${esc(c.status || "")} · ${esc(c.slug)}</span></button></li>`);
    li.querySelector("button").addEventListener("click", () => ui.navigate(`catalogue/packages/${c.id}`));
    list.querySelector("[data-list]").appendChild(li);
  }

  // services: reviewed and priced in the normal Products editor; listed here because the Products table shows products only
  const svcList = el(`<section class="cat-panel" style="padding:16px;margin-top:12px" aria-labelledby="svc-list-h"><h3 id="svc-list-h" style="margin-top:0">Services</h3><ul data-services style="list-style:none;padding:0;margin:0;display:grid;gap:6px"></ul></section>`);
  left.appendChild(svcList);
  const svcItems = services.products || [];
  if (!svcItems.length) svcList.querySelector("[data-services]").appendChild(el(`<li class="cat-muted">No services yet.</li>`));
  for (const c of svcItems) {
    const li = el(`<li><button type="button" class="cat-row" style="width:100%;text-align:left" data-service-row="${esc(c.id)}">${esc(c.name || c.slug)} <span class="cat-muted">· ${esc(c.status || "")}</span></button></li>`);
    li.querySelector("button").addEventListener("click", () => ui.navigate(`catalogue/products/${c.id}`));
    svcList.querySelector("[data-services]").appendChild(li);
  }
  const right = el(`<div data-editor></div>`);
  layout.appendChild(right);
  if (selectedId === "new") {
    if (!canWrite) { right.appendChild(ui.emptyPanel("You need catalogue.write to create packages.")); return; }
    renderEditor(right, ui, { isNew: true, content: blankPackage(categories.categories[0] && categories.categories[0].id), categories: categories.categories, options: options.products || [] });
  } else if (selectedId) {
    const detail = await ui.api(`${API}/products/${selectedId}`);
    if (token !== ui.state.renderToken) return;
    renderEditor(right, ui, { isNew: false, detail, content: structuredClone(detail.content), categories: categories.categories, options: options.products || [] });
  } else {
    right.appendChild(ui.emptyPanel("Choose a package, or create one."));
  }
}

function openServiceDialog(ui, categories) {
  // Services are package components (installation, configuration, surveys): same review and price approval as products, and never
  // listed on GetOyi on their own (the server refuses a public release of a service).
  ui.openDialog("New service", [
    { name: "name", label: "Service name (e.g. Installation per door)" },
    { name: "slug", label: "Slug (lowercase-with-hyphens)" },
    { name: "sku", label: "SKU (A-Z 0-9 . _ -)" },
    { name: "category_id", label: "Category", type: "select", value: categories[0] && categories[0].id, options: categories.filter((c) => c.status === "active").map((c) => ({ value: c.id, label: c.name })) },
  ], async (data) => {
    const made = await ui.api(`${API}/products`, { method: "POST", body: { kind: "service", slug: data.slug, content: { category_id: data.category_id, brand_id: null, name: data.name, model: "", summary: "", description: "", specifications: [], compatibility: {}, variants: [{ sku: String(data.sku || "").toUpperCase(), name: data.name }] } } });
    ui.toast("Service created as a draft. Review and price it in Products like any item.");
    ui.navigate(`catalogue/products/${made.product.id}`);
  });
}

function renderEditor(right, ui, ctx) {
  const { el, escapeHtml: esc } = ui;
  const { detail } = ctx;
  const content = ctx.content;
  const pkg = content.package;
  const perms = detail ? detail.permissions : { write: ui.hasPermission("catalogue.write") };
  const editable = Boolean(perms.write) && !(detail && detail.product.publication_status === "archived");
  right.innerHTML = "";
  const panel = el(`<section class="cat-panel" style="padding:18px" aria-label="Package editor"></section>`);
  right.appendChild(panel);
  const status = detail ? `${esc(detail.status)} · version ${detail.product.current_version}${detail.product.published_version ? ` · published v${detail.product.published_version}` : ""}` : "New package (not saved)";
  panel.appendChild(el(`<header><h2 style="margin:0">${esc(content.name || "New package")}</h2><p class="cat-muted" data-status-line>${status}</p><div role="status" aria-live="polite" data-msg></div></header>`));
  const msg = (text, bad = false) => { const m = panel.querySelector("[data-msg]"); m.textContent = text; m.style.color = bad ? "var(--danger, #b42318)" : ""; };

  const section = (title) => { const s = el(`<fieldset style="border:1px solid var(--line);border-radius:12px;padding:14px;margin:14px 0"><legend><strong>${esc(title)}</strong></legend></fieldset>`); panel.appendChild(s); return s; };
  const input = (parent, label, value, apply, { type = "text", multiline = false, attrs = "" } = {}) => {
    const tag = multiline ? `<textarea class="cat-input" rows="3" ${attrs}>${esc(value ?? "")}</textarea>` : `<input class="cat-input" type="${type}" value="${esc(value ?? "")}" ${attrs}>`;
    const wrap = el(`<label class="cat-field" style="margin:8px 0">${esc(label)}${tag}</label>`);
    const field = wrap.querySelector("input,textarea");
    field.disabled = !editable;
    field.addEventListener("input", () => apply(field.value));
    parent.appendChild(wrap);
    return field;
  };

  // ---- identity
  const basics = section("Package");
  let slug = detail ? detail.product.slug : "";
  if (!detail) input(basics, "Slug (web address)", slug, (v) => { slug = v; }, { attrs: 'data-field="slug" placeholder="oyi-smart-living"' });
  input(basics, "Name", content.name, (v) => { content.name = v; }, { attrs: 'data-field="name"' });
  input(basics, "Summary", content.summary, (v) => { content.summary = v; }, { attrs: 'data-field="summary"' });
  input(basics, "Description", content.description, (v) => { content.description = v; }, { multiline: true });
  const catSel = el(`<label class="cat-field" style="margin:8px 0">Category<select class="cat-input" data-field="category">${ctx.categories.map((c) => `<option value="${esc(c.id)}" ${c.id === content.category_id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>`);
  catSel.querySelector("select").disabled = !editable;
  catSel.querySelector("select").addEventListener("change", (e) => { content.category_id = e.target.value; });
  basics.appendChild(catSel);

  // ---- solutions and scope
  const sol = section("Solutions and scope");
  const solBox = el(`<div role="group" aria-label="Solution types" style="display:flex;flex-wrap:wrap;gap:10px" data-solutions></div>`);
  SOLUTIONS.forEach(([key, label]) => {
    const item = el(`<label><input type="checkbox" value="${key}" ${pkg.solution_types.includes(key) ? "checked" : ""}> ${esc(label)}</label>`);
    const box = item.querySelector("input"); box.disabled = !editable;
    box.addEventListener("change", () => { pkg.solution_types = [...solBox.querySelectorAll("input:checked")].map((x) => x.value); });
    solBox.appendChild(item);
  });
  sol.appendChild(solBox);
  input(sol, "Hardware covered by the package price", pkg.scope.hardware, (v) => { pkg.scope.hardware = v; }, { multiline: true, attrs: 'data-field="scope-hardware"' });
  input(sol, "Oyi software deployment (always by consultation; never priced here)", pkg.scope.software_deployment, (v) => { pkg.scope.software_deployment = v; }, { multiline: true, attrs: 'data-field="scope-software"' });
  const inst = el(`<div role="radiogroup" aria-label="Installation" style="display:flex;gap:16px;margin:8px 0" data-installation>
    <label><input type="radio" name="inst" value="quoted_separately" ${pkg.scope.installation !== "included" ? "checked" : ""}> Installation quoted separately</label>
    <label><input type="radio" name="inst" value="included" ${pkg.scope.installation === "included" ? "checked" : ""}> Installation included in the approved price</label></div>`);
  inst.querySelectorAll("input").forEach((r) => { r.disabled = !editable; r.addEventListener("change", () => { pkg.scope.installation = r.value; }); });
  sol.appendChild(inst);
  input(sol, "Installation note", pkg.scope.installation_note, (v) => { pkg.scope.installation_note = v; });
  const custom = el(`<label style="display:block;margin:8px 0"><input type="checkbox" data-field="custom" ${pkg.configuration.custom ? "checked" : ""}> Custom configurations available by consultation</label>`);
  custom.querySelector("input").disabled = !editable;
  custom.querySelector("input").addEventListener("change", (e) => { pkg.configuration.custom = e.target.checked; });
  sol.appendChild(custom);
  input(sol, "Per-unit label (for per-unit components, e.g. \"per door\")", pkg.configuration.per_unit_label, (v) => { pkg.configuration.per_unit_label = v; }, { attrs: 'data-field="per-unit"' });

  // ---- sizes
  const sizes = section("Sizes");
  sizes.appendChild(el(`<p class="cat-muted">Each size is fixed-price (an approved price is required before release) or by consultation (never priced).</p>`));
  const sizeRows = el(`<div data-sizes style="display:grid;gap:8px"></div>`);
  sizes.appendChild(sizeRows);
  const drawSizes = () => {
    sizeRows.innerHTML = "";
    content.variants.forEach((size, index) => {
      const record = detail && detail.variants.find((v) => v.sku === size.sku);
      const row = el(`<div style="display:grid;grid-template-columns:1fr 1.4fr 1fr auto auto;gap:8px;align-items:end" data-size-row>
        <label>SKU<input class="cat-input" value="${esc(size.sku)}" data-size-sku></label>
        <label>Name<input class="cat-input" value="${esc(size.name)}" data-size-name></label>
        <label>Pricing<select class="cat-input" data-size-pricing><option value="fixed" ${size.pricing === "fixed" ? "selected" : ""}>Fixed price</option><option value="consultation" ${size.pricing === "consultation" ? "selected" : ""}>By consultation</option></select></label>
        <span class="cat-muted" data-size-price>${record ? (size.pricing === "consultation" ? "By consultation" : naira(record.price_ngn_kobo)) : ""}</span>
        <span></span></div>`);
      const [skuI, nameI] = row.querySelectorAll("input");
      const pricingS = row.querySelector("select");
      [skuI, nameI, pricingS].forEach((x) => { x.disabled = !editable; });
      if (detail) skuI.disabled = true; // a saved size keeps its SKU (prices and history hang off it)
      skuI.addEventListener("input", () => { size.sku = skuI.value.toUpperCase(); });
      nameI.addEventListener("input", () => { size.name = nameI.value; });
      pricingS.addEventListener("change", () => { size.pricing = pricingS.value; });
      const slot = row.lastElementChild;
      if (record && size.pricing === "fixed" && editable) {
        const ask = el(`<button type="button" class="cat-btn" data-request-price>Request price</button>`);
        ask.addEventListener("click", async () => {
          const value = window.prompt(`Hardware price for ${size.name} in naira (VAT-inclusive). A price approver approves it, then a publisher publishes it.`);
          if (!value) return;
          try {
            await ui.api(`${API}/variants/${record.id}/price-changes`, { method: "POST", body: { price_ngn_kobo: Math.round(Number(String(value).replace(/[^0-9.]/g, "")) * 100), vat_treatment: "standard", note: "Package size price" } });
            msg(`Price requested for ${size.name}. It appears under Price approvals.`);
          } catch (error) { msg(error.message || "Could not request the price.", true); }
        });
        slot.appendChild(ask);
      } else if (!detail && editable && content.variants.length > 1) {
        const remove = el(`<button type="button" class="cat-btn" aria-label="Remove size">Remove</button>`);
        remove.addEventListener("click", () => { content.variants.splice(index, 1); drawSizes(); drawComponents(); });
        slot.appendChild(remove);
      }
      sizeRows.appendChild(row);
    });
  };
  drawSizes();
  if (editable) {
    const addSize = el(`<button type="button" class="cat-btn" data-add-size>Add size</button>`);
    addSize.addEventListener("click", () => { content.variants.push({ sku: "", name: "", options: {}, pricing: "fixed" }); drawSizes(); drawComponents(); });
    sizes.appendChild(addSize);
  }

  // ---- components
  const comps = section("Components");
  comps.appendChild(el(`<p class="cat-muted">Only internally published products and services can be components. Quantities can differ per size; per-unit components scale with the per-unit label.</p>`));
  const compRows = el(`<div data-components style="display:grid;gap:10px"></div>`);
  comps.appendChild(compRows);
  const readiness = detail && detail.package_readiness;
  const nameFor = (sku) => {
    const r = readiness && readiness.components.find((c) => c.sku === sku);
    if (r && r.name) return r.name;
    const o = ctx.options.find((p) => (p.skus || []).includes(sku));
    return o ? o.name : sku;
  };
  const drawComponents = () => {
    compRows.innerHTML = "";
    pkg.components.forEach((c, index) => {
      const r = readiness && readiness.components.find((x) => x.sku === c.sku);
      const row = el(`<div style="border:1px solid var(--line);border-radius:10px;padding:10px" data-component-row="${esc(c.sku)}">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><strong>${esc(nameFor(c.sku))}</strong>
        <span class="cat-muted">${esc(c.sku)}${r ? ` · ${esc(r.kind || "")} · ${esc(AVAILABILITY[r.availability] || r.availability)}${r.changed ? " · <b>changed — needs re-review</b>" : ""}` : ""}</span></div>
        <div class="pkg-component-fields" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:8px">
          <label>Role<select class="cat-input" data-role>${ROLES.map(([v, l]) => `<option value="${v}" ${c.role === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label>Basis<select class="cat-input" data-basis><option value="fixed" ${c.basis !== "per_unit" ? "selected" : ""}>Fixed quantity</option><option value="per_unit" ${c.basis === "per_unit" ? "selected" : ""}>Per unit</option></select></label>
          <label>Quantity<input class="cat-input" type="number" min="1" max="999" value="${c.quantity}" data-quantity></label>
          <label>Note<input class="cat-input" value="${esc(c.note || "")}" maxlength="300" data-note></label>
        </div><div data-per-size style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px"></div></div>`);
      const [roleS, basisS] = row.querySelectorAll("select");
      const qty = row.querySelector("[data-quantity]"), note = row.querySelector("[data-note]");
      [roleS, basisS, qty, note].forEach((x) => { x.disabled = !editable; });
      roleS.addEventListener("change", () => { c.role = roleS.value; });
      basisS.addEventListener("change", () => { c.basis = basisS.value; });
      qty.addEventListener("input", () => { c.quantity = Number(qty.value); });
      note.addEventListener("input", () => { c.note = note.value; });
      const perSize = row.querySelector("[data-per-size]");
      content.variants.filter((s) => s.sku).forEach((size) => {
        const has = Object.prototype.hasOwnProperty.call(c.quantities || {}, size.sku);
        const q = el(`<label class="cat-muted">${esc(size.name || size.sku)}<input class="cat-input" type="number" min="0" max="999" style="width:80px" value="${has ? c.quantities[size.sku] : ""}" placeholder="${c.quantity}" data-size-quantity="${esc(size.sku)}"></label>`);
        const field = q.querySelector("input"); field.disabled = !editable;
        field.addEventListener("input", () => { c.quantities = c.quantities || {}; if (field.value === "") delete c.quantities[size.sku]; else c.quantities[size.sku] = Number(field.value); });
        perSize.appendChild(q);
      });
      if (editable) {
        const remove = el(`<button type="button" class="cat-btn" style="margin-top:8px" aria-label="Remove ${esc(c.sku)}">Remove</button>`);
        remove.addEventListener("click", () => { pkg.components.splice(index, 1); drawComponents(); });
        row.appendChild(remove);
      }
      compRows.appendChild(row);
    });
  };
  drawComponents();
  if (editable) {
    const pick = el(`<div style="display:flex;gap:8px;align-items:end;margin-top:10px" data-component-picker>
      <label style="flex:1">Add component<select class="cat-input" data-pick><option value="">Choose a published product or service…</option>
      ${ctx.options.filter((p) => p.kind !== "package" && p.status && /published/.test(p.status)).flatMap((p) => (p.skus || []).map((sku) => `<option value="${esc(sku)}">${esc(p.name)} · ${esc(sku)}${p.kind === "service" ? " (service)" : ""}</option>`)).join("")}
      </select></label><button type="button" class="cat-btn" data-add-component>Add</button></div>`);
    pick.querySelector("[data-add-component]").addEventListener("click", () => {
      const sku = pick.querySelector("select").value;
      if (!sku || pkg.components.some((c) => c.sku === sku)) return;
      pkg.components.push({ sku, role: "required", basis: "fixed", quantity: 1, quantities: {}, note: "" });
      drawComponents();
    });
    comps.appendChild(pick);
  }

  // ---- gallery (images uploaded to this package; the same pipeline and limits as products)
  if (detail) {
    const gal = section("Images");
    const lib = detail.media_library && detail.media_library.items ? detail.media_library.items.filter((m) => m.status === "active") : [];
    const chosen = new Map((content.media || []).map((m) => [m.media_id, m]));
    lib.forEach((m) => {
      const cur = chosen.get(m.id);
      const row = el(`<div style="display:grid;grid-template-columns:90px 1fr auto;gap:10px;align-items:center;margin:6px 0" data-media="${esc(m.id)}">
        <img src="${esc(m.urls.thumb || "")}" alt="" width="90" height="68" style="object-fit:cover;border-radius:8px">
        <label>Alt text<input class="cat-input" value="${esc(cur ? cur.alt : "")}" maxlength="250"></label>
        <span><label><input type="checkbox" ${cur ? "checked" : ""}> In gallery</label> <label><input type="radio" name="cover" ${cur && cur.cover ? "checked" : ""}> Cover</label></span></div>`);
      const [alt, inGallery, cover] = row.querySelectorAll("input");
      [alt, inGallery, cover].forEach((x) => { x.disabled = !editable; });
      const sync = () => {
        content.media = (content.media || []).filter((x) => x.media_id !== m.id);
        if (inGallery.checked) content.media.push({ media_id: m.id, cover: cover.checked, alt: alt.value, caption: "", variant_skus: [] });
        if (cover.checked) content.media.forEach((x) => { x.cover = x.media_id === m.id; });
      };
      [alt, inGallery, cover].forEach((x) => x.addEventListener(x === alt ? "input" : "change", sync));
      gal.appendChild(row);
    });
    if (editable) {
      const up = el(`<label style="display:block;margin-top:8px">Upload image (JPEG, PNG or WebP)<input type="file" accept="image/jpeg,image/png,image/webp" data-upload></label>`);
      up.querySelector("input").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const r = await fetch(`${API}/products/${detail.product.id}/media?name=${encodeURIComponent(file.name)}`, { method: "POST", credentials: "same-origin", headers: { "content-type": file.type }, body: file });
        if (r.ok) { ui.toast("Image uploaded. Add it to the gallery and save."); ui.navigate(`catalogue/packages/${detail.product.id}`); }
        else msg(`Upload failed (${r.status}).`, true);
      });
      gal.appendChild(up);
    }
  }

  // ---- readiness (server)
  if (readiness) {
    const ready = section("Readiness");
    const issues = readiness.issues.length ? `<ul data-issues>${readiness.issues.map((i) => `<li>${esc(i.label)}${i.sku ? ` — ${esc(i.sku)}` : ""}</li>`).join("")}</ul>` : `<p data-issues-none>No blocking issues.</p>`;
    const warnings = readiness.warnings.length ? `<ul data-warnings>${readiness.warnings.map((w) => `<li>${esc(w.code.replace(/_/g, " "))} — ${esc(w.sku)}</li>`).join("")}</ul>` : "";
    const showCost = readiness.sizes.some((s) => "margin_kobo" in s);
    ready.appendChild(el(`<div><p>Package availability (derived from required components): <strong data-availability>${esc(AVAILABILITY[readiness.availability] || readiness.availability)}</strong></p>${issues}${warnings}
      <table class="cat-table" data-size-table><thead><tr><th>Size</th><th>Pricing</th><th>Approved price</th><th>Required components at list price</th>${showCost ? "<th>Component cost</th><th>Margin</th>" : ""}</tr></thead>
      <tbody>${readiness.sizes.map((s) => `<tr><td>${esc(s.name)}</td><td>${s.pricing === "consultation" ? "By consultation" : "Fixed"}</td><td>${s.pricing === "consultation" ? "—" : naira(s.price_kobo)}</td><td>${naira(s.required_components_price_kobo)}</td>${showCost ? `<td>${naira(s.required_components_cost_kobo)}</td><td>${naira(s.margin_kobo)}</td>` : ""}</tr>`).join("")}</tbody></table></div>`));
  }

  // ---- public state
  if (detail && detail.public && detail.public.available) {
    const p = detail.public;
    const pubBox = section("GetOyi");
    pubBox.appendChild(el(`<div><p>Public state: <strong data-public-state>${esc(p.effective || "not_public")}</strong>${p.listing ? ` · version ${p.listing.public_version} · refresh ${esc(p.listing.refresh_status)}` : ""}</p>
      ${(p.requirements || []).length ? `<ul data-requirements>${p.requirements.map((r) => `<li>${esc(r.label)}</li>`).join("")}</ul>` : ""}</div>`));
  }

  // ---- actions (existing endpoints; the server enforces permissions, second person and package rules)
  const actions = el(`<div class="cat-head-actions" style="margin-top:14px;display:flex;flex-wrap:wrap;gap:8px" data-actions></div>`);
  panel.appendChild(actions);
  const act = (label, run, key) => { const b = el(`<button type="button" class="cat-btn" data-action="${key}">${esc(label)}</button>`); b.addEventListener("click", async () => { b.disabled = true; try { await run(); } catch (error) { msg(describe(error), true); } finally { b.disabled = false; } }); actions.appendChild(b); };
  const describe = (error) => {
    const issues = error && error.data && error.data.current && error.data.current.issues;
    if (issues) return `Not possible yet: ${issues.map((i) => `${i.label || i.code}${i.sku ? ` (${i.sku})` : ""}`).join("; ")}`;
    return (error && error.message) || "Request failed";
  };
  const reload = (id) => ui.navigate(`catalogue/packages/${id}`);
  if (editable) act(detail ? "Save new version" : "Create package", async () => {
    if (detail) { await ui.api(`${API}/products/${detail.product.id}`, { method: "PATCH", body: { expected_row_version: detail.product.row_version, content } }); reload(detail.product.id); }
    else { const made = await ui.api(`${API}/products`, { method: "POST", body: { kind: "package", slug, content } }); reload(made.product.id); }
  }, "save");
  if (detail) {
    const id = detail.product.id, rv = detail.product.row_version, wf = detail.product.workflow_status;
    if (perms.write && ["draft", "changes_requested"].includes(wf)) act("Submit for review", async () => { await ui.api(`${API}/products/${id}/submit`, { method: "POST", body: { expected_row_version: rv } }); reload(id); }, "submit");
    if (perms.review && wf === "in_review") {
      act("Approve", async () => { await ui.api(`${API}/products/${id}/approve`, { method: "POST", body: { expected_row_version: rv } }); reload(id); }, "approve");
      act("Request changes", async () => { await ui.api(`${API}/products/${id}/request-changes`, { method: "POST", body: { expected_row_version: rv, note: window.prompt("What needs to change?") || "" } }); reload(id); }, "request-changes");
    }
    if (perms.publish && wf === "approved" && detail.product.published_version !== detail.product.current_version) act("Publish internally", async () => { await ui.api(`${API}/products/${id}/publish`, { method: "POST", body: { expected_row_version: rv } }); reload(id); }, "publish");
    if (perms.publicPublish && detail.public && detail.public.available) {
      const listing = detail.public.listing;
      act(listing && listing.status === "public" ? "Update GetOyi" : "Release to GetOyi", async () => { await ui.api(`${API}/products/${id}/public/release`, { method: "POST", body: { expected_row_version: rv, expected_listing_row_version: listing ? listing.row_version : 0 } }); reload(id); }, "release");
    }
    if ((perms.publicPublish || perms.publish) && detail.public && detail.public.listing && detail.public.listing.status === "public") {
      act("Withdraw from GetOyi", async () => { await ui.api(`${API}/products/${id}/public/withdraw`, { method: "POST", body: { expected_listing_row_version: detail.public.listing.row_version, reason: window.prompt("Reason for withdrawal") || "" } }); reload(id); }, "withdraw");
    }
    act("Preview", async () => { const r = await ui.api(`${API}/products/${id}/preview`, { method: "POST", body: {} }); window.open(r.url, "_blank", "noopener"); }, "preview");
  }
}
