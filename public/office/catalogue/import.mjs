// Products-only import review; reuses Office UI tokens, session API and catalogue draft validation.
const API = "/api/lead-agents/admin/catalogue/imports";
export async function renderProductImport(host, token, ui) {
  const { el, escapeHtml: e } = ui;
  host.innerHTML = "";
  if (!ui.hasPermission("catalogue.write")) { host.appendChild(ui.errorPanel("Product import requires catalogue write permission.")); return; }
  const root = el(`<section class="cat-import"><style>
    .cat-import{padding:20px 0;max-width:1200px}.cat-import h2{margin:0 0 8px}.cat-import h3{overflow-wrap:anywhere}.cat-import p{color:var(--text-secondary);line-height:1.6}
    .cat-import .import-upload,.cat-import .import-card{border:1px solid var(--line);border-radius:10px;padding:18px;background:var(--charcoal);margin:16px 0}
    .cat-import .import-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.cat-import label{display:block;font-size:13px;color:var(--text-secondary)}
    .cat-import input:not([type=checkbox]),.cat-import select,.cat-import textarea{width:100%;background:var(--cat-panel);color:var(--text-primary);border:1px solid var(--line-strong);border-radius:7px;padding:9px;margin:6px 0 12px}
    .cat-import textarea{min-height:90px;resize:vertical}.cat-import .import-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}.cat-import .wide{grid-column:1/-1}
    .cat-import summary{cursor:pointer;padding:10px 0}.cat-import .import-warning{color:#e8bb70}.cat-import .import-status{white-space:pre-wrap;padding:10px 0}
    .cat-import .import-ref{font-size:13px;overflow-wrap:anywhere}.cat-import .import-source{color:var(--text-tertiary);font-size:12px}.cat-import .import-sticky{position:sticky;bottom:0;padding:16px;background:var(--charcoal);border:1px solid var(--line);border-radius:10px}
    .cat-import .import-confirm{display:flex;gap:10px;align-items:flex-start;margin:12px 0}.cat-import .import-structured-row{display:grid;grid-template-columns:1fr 2fr 1fr auto;gap:8px;align-items:start}.cat-import .import-structured-row label{min-width:0}.cat-import pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
    @media(max-width:700px){.cat-import .import-grid{grid-template-columns:1fr}.cat-import .import-card{padding:12px}.cat-import .import-structured-row{grid-template-columns:1fr 1fr}.cat-import .import-sticky{position:static}}
  </style><h2>Import products</h2><p>Upload an XLSX or CSV catalogue, review the detected fields, then choose which drafts to create. Spreadsheet prices are references only. Nothing is approved or published.</p>
  <div class="import-upload"><label for="product-import-file">Product catalogue · XLSX or UTF-8 CSV · up to 5 MB</label><input id="product-import-file" type="file" accept=".xlsx,.csv"/><div class="import-actions"><button class="cat-btn cat-btn-primary" data-extract>Extract & review</button><button class="cat-btn" data-back>Back to products</button></div></div>
  <div class="import-status" role="status" aria-live="polite"></div><div data-preview></div></section>`);
  host.appendChild(root);
  const status = root.querySelector(".import-status"), fileInput = root.querySelector("input[type=file]"), extract = root.querySelector("[data-extract]"), preview = root.querySelector("[data-preview]");
  root.querySelector("[data-back]").onclick = () => ui.navigate("catalogue");
  let state, busy = false;
  const message = (error) => {
    const code = error.data?.error || error.code;
    const labels = { forbidden: "This file requires supplier-cost read permission. Ask an authorized colleague to review it.", no_product_rows_detected: "No product table found. Include a Product name column and a SKU, category or description column.", sku_taken: "A selected SKU already exists. Re-extract to refresh duplicate checks, or correct the SKU.", import_file_size: "The file exceeds 5 MB.", unsupported_import_format: "Choose an XLSX or UTF-8 CSV file.", import_parse_timeout: "This workbook is too complex. Export its product table as CSV.", invalid_import_file: "The file could not be read. Save a standard XLSX or UTF-8 CSV and try again." };
    return labels[code] || (error.data?.details ? error.data.details.join("; ") : error.message || "Import failed.");
  };
  const FIELD_LABELS = { name: "Product name", sku: "SKU", category: "Category", manufacturer: "Brand / manufacturer", brand_model_reference: "Combined brand/model (unverified source)", model: "Model", specifications: "Technical specifications", specification: "Technical specification", retail_reference: "Unapproved retail reference", supplier_cost: "Unapproved supplier-cost reference", source_reference: "Source reference / staff note", ignore: "Ignore" };
  function drawMapping() {
    const panel = el(`<details ${state.mapping_required ? "open" : ""}><summary>Review worksheet detection & edit column mapping</summary><p>Every worksheet is inspected. Non-product sheets are excluded. Remapping replaces unsaved field edits. Price and supplier columns cannot be mapped into product specifications or approved prices.</p><div data-sheets></div><button type="button" class="cat-btn" data-remap>Apply mapping & extract again</button></details>`);
    preview.prepend(panel);
    for (const d of state.diagnostics || []) {
      const section = el(`<section class="import-upload" data-sheet="${e(d.sheet)}"><h4>${e(d.sheet)}</h4><p>${d.accepted ? "Product table recognized" : e(d.reasons.join(" "))} · ${d.total_rows} worksheet rows</p><label class="import-confirm"><input type="checkbox" data-include ${d.accepted ? "checked" : ""}/>Use this worksheet as a product table</label><label>Header row<select data-header>${d.header_choices.map((r) => `<option value="${r.row}" ${r.row === d.row ? "selected" : ""}>Row ${r.row}: ${e(r.headings.join(" · ").slice(0,160))}</option>`).join("")}</select></label><div class="import-grid" data-columns></div></section>`);
      const columnHost = section.querySelector("[data-columns]");
      const paint = () => {
        const row = d.header_choices.find((r) => r.row === Number(section.querySelector("[data-header]").value));
        columnHost.innerHTML = (row?.headings || []).map((header,i) => {
          const original = row.row === d.row ? d.fields[i] : "source_reference";
          const locked = (state.mappings.find((m) => m.sheet === d.sheet && m.row === row.row)?.columns[i]?.locked) || ["supplier", "supplier_cost", "retail_reference"].includes(original);
          return `<label>${i+1}. ${e(header || "Blank heading")}<select data-column ${locked ? "disabled" : ""}>${state.mapping_fields.map((f) => `<option value="${e(f)}" ${f === original ? "selected" : ""}>${e(FIELD_LABELS[f] || f)}</option>`).join("")}</select>${locked ? "Financial source classification is protected" : ""}</label>`;
        }).join("");
      };
      section.querySelector("[data-header]").onchange = paint; paint(); panel.querySelector("[data-sheets]").appendChild(section);
    }
    panel.querySelector("[data-remap]").onclick = async () => {
      if (busy) return;
      busy = true; panel.querySelector("[data-remap]").disabled = true; extract.disabled = true; fileInput.disabled = true;
      status.textContent = "Checking the revised mapping. No products are being created…";
      try {
        const mapping = [...panel.querySelectorAll("[data-sheet]")].map((s) => ({ sheet: s.dataset.sheet, row: Number(s.querySelector("[data-header]").value), include: s.querySelector("[data-include]").checked, fields: [...s.querySelectorAll("[data-column]")].map((x) => x.value) }));
        state = await ui.api(`${API}/${state.id}/mapping`, { method: "POST", body: { mapping } });
        draw(); status.textContent = state.mapping_required ? "Mapping needs attention. Review the sheet explanations below." : `${state.candidates.length} candidates detected. Review before selecting drafts.`;
      } catch (error) { status.textContent = message(error); }
      finally { busy = false; extract.disabled = false; fileInput.disabled = false; panel.querySelector("[data-remap]").disabled = false; }
    };
  }
  function draw() {
    preview.innerHTML = `<h3>${state.candidates.length} candidate products · ${e(state.name)}</h3><p>${e(state.match_note)}</p><p class="import-warning">${state.warnings.map(e).join("<br>")}</p>

    <div class="import-actions"><button class="cat-btn" data-all>Select all</button><button class="cat-btn" data-none>Clear selection</button></div><div data-candidates></div>
    <div class="import-sticky"><label class="import-confirm"><input type="checkbox" data-confirm/>I have reviewed the selected products. Create drafts only; keep selling prices unapproved and public listings unchanged.</label><button class="cat-btn cat-btn-primary" data-save>Create selected drafts</button><span data-count></span></div>`;
    drawMapping();
    if (state.mapping_required) preview.querySelector(".import-sticky").hidden = true;
    const cards = preview.querySelector("[data-candidates]");
    const input = (name, label, value, wide = false, area = false) => `<label class="${wide ? "wide" : ""}">${e(label)}${area ? `<textarea data-field="${name}">${e(value)}</textarea>` : `<input data-field="${name}" value="${e(value)}"/>`}</label>`;
    state.candidates.forEach((c, index) => {
      const card = el(`<article class="import-card" data-index="${index}"><label class="import-confirm"><input type="checkbox" data-select/><strong>${e(c.name || "Unnamed product")}</strong></label><div class="import-source">${c.source_rows.map((r) => `${e(r.sheet)} · row ${r.row}`).join("; ")}</div>
      <p class="import-warning">${c.warnings.map(e).join("<br>")}</p>${c.possible_matches.length ? `<p>Possible existing products: ${c.possible_matches.map((m) => `<a href="#/catalogue/products/${e(m.id)}">${e(m.name)}</a>`).join(", ")}</p>` : ""}
      ${c.brand_model_reference ? `<p class="import-ref"><strong>Original brand / model reference:</strong> ${e(c.brand_model_reference)} — confirm in the fields below.</p>` : ""}<details ${index === 0 ? "open" : ""}><summary>Review mapped product fields</summary><div class="import-grid">
      ${input("name", "Product name", c.content.name)}${input("slug", "Unique product slug", c.slug)}
      <label>Category · source: ${e(c.category || "missing")}<select data-field="category_id"><option value="">Choose category</option>${state.categories.filter((x) => x.status === "active").map((x) => `<option value="${e(x.id)}" ${x.id === c.content.category_id ? "selected" : ""}>${e(x.name)}</option>`).join("")}</select></label>
      <label>Brand · manufacturer reference: ${e(c.manufacturer || "missing")}<select data-field="brand_id"><option value="">No matched brand</option>${state.brands.filter((x) => x.status === "active").map((x) => `<option value="${e(x.id)}" ${x.id === c.content.brand_id ? "selected" : ""}>${e(x.name)}</option>`).join("")}</select></label>
      ${input("model", "Model", c.content.model)}${input("summary", "Short description", c.content.summary)}${input("description", "Full description", c.content.description, true, true)}
      <div class="wide" data-specifications><h4>Technical specifications</h4><div data-rows></div><button type="button" class="cat-btn" data-add>Add specification</button></div>
      <div class="wide" data-variants><h4>Variants & SKUs</h4><div data-rows></div><button type="button" class="cat-btn" data-add>Add variant</button></div></div></details>
      <details><summary>Pricing, supplier & image references</summary><p class="import-ref"><strong>Unapproved retail references</strong><br>${c.retail_references.map((r) => `${e(r.label)}: ${e(r.value)}`).join("<br>") || "Not provided"}</p>
      <p class="import-ref"><strong>Supplier references · restricted</strong><br>${c.supplier_references.map((r) => `${e(r.label)}: ${e(r.value)}`).join("<br>") || "Not provided"}</p>
      <p class="import-ref"><strong>Image references · not downloaded</strong><br>${c.image_references.map((r) => e(r.value)).join("<br>") || "Not provided"}</p><p class="import-ref"><strong>Source references & staff notes</strong><br>${(c.source_references || []).map((r) => `${e(r.label)}: ${e(r.value)} (${e(r.sheet)} row ${r.row})`).join("<br>") || "Not provided"}</p><p>No selling price, supplier cost, stock quantity or compatibility claim is approved by this import.</p></details><div data-result role="status"></div></article>`);
      function structured(kind, values) {
        const group = card.querySelector(`[data-${kind}]`), rowHost = group.querySelector("[data-rows]");
        const add = (value = {}) => {
          const fields = kind === "variants" ? [["sku", "SKU"], ["name", "Variant name"], ["options", "Options (colour=Black; size=Large)"]] : [["key", "Specification"], ["value", "Value"], ["unit", "Unit (optional)"]];
          const row = el(`<div class="import-structured-row">${fields.map(([key, label]) => `<label>${e(label)}<input data-part="${key}" value="${e(key === "options" ? Object.entries(value.options || {}).map(([k,v]) => `${k}=${v}`).join("; ") : value[key] || "")}"/></label>`).join("")}<button type="button" class="cat-btn" aria-label="Remove ${kind === "variants" ? "variant" : "specification"}">Remove</button></div>`);
          row.querySelector("button").onclick = () => row.remove(); rowHost.appendChild(row);
        };
        values.forEach(add); group.querySelector("[data-add]").onclick = () => add();
      }
      structured("specifications", c.content.specifications); structured("variants", c.content.variants);
      cards.appendChild(card);
    });
    const boxes = () => [...preview.querySelectorAll("[data-select]:not(:disabled)")];
    const count = () => { preview.querySelector("[data-count]").textContent = ` ${boxes().filter((b) => b.checked).length} selected`; };
    preview.querySelector("[data-all]").onclick = () => { boxes().forEach((b) => { b.checked = true; }); count(); };
    preview.querySelector("[data-none]").onclick = () => { boxes().forEach((b) => { b.checked = false; }); count(); };
    boxes().forEach((b) => b.onchange = count); count();
    preview.querySelector("[data-save]").onclick = async () => {
      if (busy) return;
      if (!preview.querySelector("[data-confirm]").checked) { status.textContent = "Confirm that you have reviewed the selected drafts first."; return; }
      try {
        const items = [...cards.children].filter((card) => card.querySelector("[data-select]").checked && !card.querySelector("[data-select]").disabled).map((card) => {
          const c = state.candidates[Number(card.dataset.index)], content = { ...c.content };
          card.querySelectorAll("[data-field]").forEach((field) => { if (field.dataset.field !== "slug") content[field.dataset.field] = ["variants", "specifications"].includes(field.dataset.field) ? JSON.parse(field.value) : field.value; });
          for (const kind of ["specifications", "variants"]) content[kind] = [...card.querySelectorAll(`[data-${kind}] [data-rows] > div`)].map((row) => Object.fromEntries([...row.querySelectorAll("[data-part]")].map((field) => {
            if (field.dataset.part !== "options") return [field.dataset.part, field.value];
            const pairs = field.value.split(";").map((v) => v.trim()).filter(Boolean).map((v) => { const at = v.indexOf("="); if (at < 1) throw new Error("Variant options use name=value, separated by semicolons."); return [v.slice(0,at).trim(), v.slice(at+1).trim()]; });
            return ["options", Object.fromEntries(pairs)];
          })));
          return { id: c.id, slug: card.querySelector('[data-field="slug"]').value, content };
        });
        if (!items.length) throw new Error("Select at least one product.");
        busy = true; preview.querySelector("[data-save]").disabled = true; extract.disabled = true; status.textContent = "Creating selected drafts…";
        const result = await ui.api(`${API}/${state.id}/drafts`, { method: "POST", body: { confirm_drafts_only: true, items } });
        result.results.forEach((r) => {
          const index = state.candidates.findIndex((c) => c.id === r.id), card = cards.children[index];
          card.querySelector("[data-result]").innerHTML = r.product_id ? `<a href="#/catalogue/products/${e(r.product_id)}">Open created draft</a>${r.status === "draft_created_audit_failed" ? " · Audit failed: stop and contact an administrator." : ""}` : e(`Not created: ${r.error}`);
          if (r.product_id) { card.querySelector("[data-select]").disabled = true; card.querySelector("[data-select]").checked = false; }
        });
        status.textContent = `${result.results.filter((r) => r.product_id).length} drafts created. ${result.results.length < result.requested || result.results.some((r) => r.status !== "draft_created") ? "The batch stopped; review the row results before continuing." : "No prices approved or products published."}`;
        preview.querySelector("[data-confirm]").checked = false; count();
      } catch (error) { status.textContent = error instanceof SyntaxError ? "Check the specification and variant JSON in the selected products." : message(error); }
      finally { busy = false; preview.querySelector("[data-save]").disabled = false; extract.disabled = false; }
    };
  }
  extract.onclick = async () => {
    if (busy) return;
    const file = fileInput.files[0];
    if (!file) { status.textContent = "Choose your XLSX or CSV catalogue first."; return; }
    if (file.size > 5 * 1024 * 1024) { status.textContent = "Choose a file no larger than 5 MB."; return; }
    busy = true; extract.disabled = true; fileInput.disabled = true; preview.innerHTML = ""; status.textContent = "Extracting product candidates. No products are being created…";
    try {
      const response = await fetch(`${API}?name=${encodeURIComponent(file.name)}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: file });
      const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error), { data });
      if (token !== ui.state.renderToken) return;
      state = data; draw(); status.textContent = data.mapping_required ? "No unambiguous product table selected. Review detected sheets, headings and mapping below." : `${data.candidates.length} candidates detected. Review the fields and warnings below.`;
    } catch (error) { status.textContent = message(error); }
    finally { busy = false; extract.disabled = false; fileInput.disabled = false; }
  };
  fileInput.onchange = () => extract.click();
}
