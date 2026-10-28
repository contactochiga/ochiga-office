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
    .cat-import [data-save-feedback]{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0}.cat-import [data-save-feedback]:empty{display:none}.cat-import [data-save-feedback][data-kind=error],.cat-import [data-validation]{color:#ffb9b9}.cat-import [aria-invalid=true]{border-color:#ffb9b9}.cat-import [data-save-links] a{display:block;padding:6px 0}.cat-import summary{cursor:pointer;padding:10px 0}.cat-import .import-warning{color:#e8bb70}.cat-import .import-status{white-space:pre-wrap;padding:10px 0}
    .cat-import .import-ref{font-size:13px;overflow-wrap:anywhere}.cat-import .import-source{color:var(--text-tertiary);font-size:12px}.cat-import .import-sticky{position:static;padding:16px;background:var(--charcoal);border:1px solid var(--line);border-radius:10px}
    .cat-import .import-confirm{display:flex;gap:10px;align-items:flex-start;margin:12px 0}.cat-import .import-structured-row{display:grid;grid-template-columns:1fr 2fr 1fr auto;gap:8px;align-items:start}.cat-import .import-structured-row label{min-width:0}.cat-import pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
    @media(max-width:700px){.cat-import .import-grid{grid-template-columns:1fr}.cat-import .import-card{padding:12px}.cat-import .import-structured-row{grid-template-columns:1fr 1fr}.cat-import .import-sticky{position:static}}
  </style><h2>Import products</h2><p>Upload an XLSX or CSV catalogue, review the detected fields, then choose which drafts to create. Spreadsheet prices are references only. Nothing is approved or published.</p>
  <button type="button" class="cat-btn" data-v2>V2 · batch ingestion and exception review</button><div class="import-upload"><label for="product-import-file">Product catalogue · XLSX or UTF-8 CSV · up to 5 MB</label><input id="product-import-file" type="file" accept=".xlsx,.csv"/><div class="import-actions"><button type="button" class="cat-btn cat-btn-primary" data-extract>Extract & review</button><button type="button" class="cat-btn" data-back>Back to products</button></div></div>
  <div class="import-status" role="status" aria-live="polite"></div><div data-preview></div></section>`);
  host.appendChild(root);
  const status = root.querySelector(".import-status"), fileInput = root.querySelector("input[type=file]"), extract = root.querySelector("[data-extract]"), preview = root.querySelector("[data-preview]");
  root.querySelector("[data-back]").onclick = () => ui.navigate("catalogue");
  root.querySelector("[data-v2]").onclick = () => ui.navigate("catalogue/ingestion");
  let state, busy = false;
  const message = (error) => {
    const code = error.data?.error || error.code;
    const labels = { forbidden: "This file requires supplier-cost read permission. Ask an authorized colleague to review it.", no_product_rows_detected: "No product table found. Include a Product name column and a SKU, category or description column.", sku_taken: "A selected SKU already exists. Re-extract to refresh duplicate checks, or correct the SKU.", import_file_size: "The file exceeds 5 MB.", unsupported_import_format: "Choose an XLSX or UTF-8 CSV file.", import_parse_timeout: "This workbook is too complex. Export its product table as CSV.", invalid_import_file: "The file could not be read. Save a standard XLSX or UTF-8 CSV and try again." };
    return labels[code] || (error.data?.details ? error.data.details.join("; ") : error.message || "Import failed.");
  };
  function drawMapping() {
    renderColumnMapping(preview, state, ui, async (mapping) => {
      if (busy) return;
      busy = true; extract.disabled = true; fileInput.disabled = true;
      status.textContent = "Checking the revised mapping. No products are being created…";
      try {
        state = await ui.api(`${API}/${state.id}/mapping`, { method: "POST", body: { mapping } });
        draw(); status.textContent = state.mapping_required ? "Mapping needs attention. Review the sheet explanations below." : `${state.candidates.length} candidates detected. Review before selecting drafts.`;
      } catch (error) { status.textContent = message(error); }
      finally { busy = false; extract.disabled = false; fileInput.disabled = false; }
    });
  }
  function draw() {
    preview.innerHTML = `<h3>${state.candidates.length} candidate products · ${e(state.name)}</h3><p>${e(state.match_note)}</p><p class="import-warning">${state.warnings.map(e).join("<br>")}</p>

    <div class="import-actions"><button type="button" class="cat-btn" data-all>Select all</button><button type="button" class="cat-btn" data-none>Clear selection</button></div><div data-candidates></div>
    <div class="import-sticky"><label class="import-confirm"><input type="checkbox" data-confirm/>I have reviewed the selected products. Create drafts only; keep selling prices unapproved and public listings unchanged.</label><button type="button" class="cat-btn cat-btn-primary" data-save>Create selected drafts</button><span data-count></span><div data-save-feedback role="status" aria-live="polite" aria-atomic="true" tabindex="-1"></div><div data-save-links></div></div>`;
    drawMapping();
    if (state.mapping_required) preview.querySelector(".import-sticky").hidden = true;
    const cards = preview.querySelector("[data-candidates]");
    const input = (name, label, value, wide = false, area = false) => `<label class="${wide ? "wide" : ""}">${e(label)}${area ? `<textarea data-field="${name}">${e(value)}</textarea>` : `<input data-field="${name}" value="${e(value)}"/>`}</label>`;
    state.candidates.forEach((c, index) => {
      const card = el(`<article class="import-card" data-index="${index}"><label class="import-confirm"><input type="checkbox" data-select/><strong>${e(c.name || "Unnamed product")}</strong></label><div class="import-source">${c.source_rows.map((r) => `${e(r.sheet)} · row ${r.row}`).join("; ")}</div>
      <p class="import-warning" data-warnings>${c.warnings.map(e).join("<br>")}</p><div data-validation role="alert"></div>${c.possible_matches.length ? `<p>Possible existing products: ${c.possible_matches.map((m) => `<a href="#/catalogue/products/${e(m.id)}">${e(m.name)}</a>`).join(", ")}</p>` : ""}
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
      const categorySelect = card.querySelector('[data-field="category_id"]');
      categorySelect.onchange = () => {
        card.querySelector('[data-warnings]').innerHTML = c.warnings.filter(w => !categorySelect.value || !w.startsWith("Choose an existing category")).map(e).join("<br>");
        categorySelect.removeAttribute("aria-invalid");
      };
      cards.appendChild(card);
    });
    const boxes = () => [...preview.querySelectorAll("[data-select]:not(:disabled)")];
    const count = () => { preview.querySelector("[data-count]").textContent = ` ${boxes().filter((b) => b.checked).length} selected`; };
    preview.querySelector("[data-all]").onclick = () => { boxes().forEach((b) => { b.checked = true; }); count(); };
    preview.querySelector("[data-none]").onclick = () => { boxes().forEach((b) => { b.checked = false; }); count(); };
    boxes().forEach((b) => b.onchange = count); count();
    const save = preview.querySelector("[data-save]"), feedback = preview.querySelector("[data-save-feedback]"), links = preview.querySelector("[data-save-links]");
    const savedIds = new Set(); let saveBlocked = false;
    function report(text, kind = "info", productLinks = []) {
      status.textContent = text; feedback.textContent = text; feedback.dataset.kind = kind;
      links.innerHTML = productLinks.map(p => `<a href="#/catalogue/products/${e(p.product_id)}">${e(p.label || "Open saved draft")}</a>`).join("");
      feedback.focus({ preventScroll: true }); feedback.scrollIntoView({ block: "nearest" });
    }
    save.onclick = async (event) => {
      event.preventDefault(); event.stopPropagation();
      if (busy || saveBlocked) return;
      links.innerHTML = "";
      if (!preview.querySelector("[data-confirm]").checked) { report("Confirm that you have reviewed the selected drafts first.", "error"); return; }
      let controls = [], dispatched = false, timer;
      try {
        const errors = [], seenSkus = new Set(), existingLinks = [];
        cards.querySelectorAll('[data-validation]').forEach(x => { x.textContent = ""; });
        cards.querySelectorAll('[aria-invalid]').forEach(x => x.removeAttribute("aria-invalid"));
        const items = [...cards.children].filter(card => card.querySelector("[data-select]").checked && !card.querySelector("[data-select]").disabled).map(card => {
          const c = state.candidates[Number(card.dataset.index)], content = { ...c.content }, rowErrors = [];
          const invalid = (field, text) => { rowErrors.push(text); field?.setAttribute("aria-invalid", "true"); };
          card.querySelectorAll("[data-field]").forEach(field => { if (field.dataset.field !== "slug") content[field.dataset.field] = field.value; });
          const slug = card.querySelector('[data-field="slug"]').value;
          if (!content.name.trim()) invalid(card.querySelector('[data-field="name"]'), "Enter a product name.");
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) invalid(card.querySelector('[data-field="slug"]'), "Enter a valid lowercase product slug.");
          if (!state.categories.some(x => x.status === "active" && x.id === content.category_id)) invalid(card.querySelector('[data-field="category_id"]'), "Choose an existing category.");
          for (const kind of ["specifications", "variants"]) content[kind] = [...card.querySelectorAll(`[data-${kind}] [data-rows] > div`)].map(row => Object.fromEntries([...row.querySelectorAll("[data-part]")].map(field => {
            if (field.dataset.part !== "options") return [field.dataset.part, field.value];
            const pairs = field.value.split(";").map(v => v.trim()).filter(Boolean).map(v => { const at = v.indexOf("="); if (at < 1) { invalid(field, "Variant options use name=value, separated by semicolons."); return ["", ""]; } return [v.slice(0,at).trim(), v.slice(at+1).trim()]; });
            return ["options", Object.fromEntries(pairs)];
          })));
          if (!content.variants.length) invalid(null, "Add at least one variant and SKU.");
          content.variants.forEach((v,i) => {
            const field = card.querySelectorAll('[data-part="sku"]')[i], sku = v.sku.trim().toUpperCase();
            if (!/^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(sku)) invalid(field, "Enter a valid SKU (2–64 letters, numbers, dots, underscores or hyphens).");
            if (seenSkus.has(sku)) invalid(field, `SKU ${sku} is repeated in the selection.`);
            seenSkus.add(sku);
            if (c.duplicate_skus.includes(sku)) {
              invalid(field, `SKU ${sku} already exists or is repeated in this workbook. Open the existing product; do not recreate it.`);
              (c.existing_products || []).filter(x => x.sku === sku).forEach(x => existingLinks.push({...x,label:`Open existing product · ${sku}`}));
            }
          });
          content.specifications.forEach((spec,i) => { for (const part of ["key", "value"]) if (!spec[part].trim()) invalid(card.querySelectorAll(`[data-specifications] [data-part="${part}"]`)[i], `Specification ${i+1}: enter ${part}.`); });
          if (rowErrors.length) { const text = `${content.name || c.name || "Unnamed product"}: ${rowErrors.join(" ")}`; card.querySelector('[data-validation]').textContent = text; errors.push(text); }
          return { id:c.id, slug, content };
        });
        if (!items.length) errors.push("Select at least one product.");
        if (errors.length) { report(`Nothing submitted. ${errors.join("\n")}`, "error", existingLinks); return; }
        busy = true; root.setAttribute("aria-busy", "true");
        controls = [...root.querySelectorAll("input,select,textarea,button")].map(node => ({node, disabled:node.disabled}));
        controls.forEach(({node}) => { node.disabled = true; }); save.textContent = "Saving drafts…";
        report(`Saving ${items.length} selected ${items.length === 1 ? "draft" : "drafts"}… Please wait. Do not submit again.`);
        const controller = new AbortController(); timer = setTimeout(() => controller.abort(), 30000);
        dispatched = true;
        const result = await ui.api(`${API}/${state.id}/drafts`, { method:"POST", body:{confirm_drafts_only:true,items}, signal:controller.signal });
        if (!result || !Array.isArray(result.results)) throw new Error("Invalid save response");
        const productLinks = [];
        result.results.forEach(r => {
          const index = state.candidates.findIndex(c => c.id === r.id), card = cards.children[index];
          if (!card) throw new Error("Unknown save result");
          card.querySelector("[data-result]").innerHTML = r.product_id ? `<a href="#/catalogue/products/${e(r.product_id)}">Open created draft</a>` : e(`Not created: ${r.error}`);
          if (r.product_id) { savedIds.add(r.id); card.querySelector("[data-select]").checked = false; productLinks.push({product_id:r.product_id,label:`Open saved draft · ${state.candidates[index].name}`}); }
        });
        const complete = result.results.length === items.length && result.results.every(r => r.status === "draft_created");
        saveBlocked = !complete;
        report(`${productLinks.length} ${productLinks.length === 1 ? "draft" : "drafts"} saved. ${complete ? "Open the saved product below. No prices approved or products published." : "The batch stopped or an audit failed. Check the saved links and Products before retrying; re-extract to refresh duplicate checks."}`, complete ? "success" : "error", productLinks);
        preview.querySelector("[data-confirm]").checked = false;
      } catch (error) {
        if (error.status === 401) { saveBlocked = true; report("Your session expired. Sign in to Office in another tab, then re-extract this file before saving. No automatic retry was made.", "error"); }
        else if (error.status === 409) { report("A SKU or product slug already exists, or the catalogue changed. Open Products and check the existing draft. Re-extract to refresh duplicate matches before retrying.", "error"); saveBlocked = true; }
        else if (dispatched && (!error.status || error.status >= 500)) { saveBlocked = true; report("Save could not be confirmed. A draft may already exist. Open Products and check the SKU before retrying; re-extract to refresh duplicate checks. No automatic retry was made.", "error"); }
        else report(`Drafts were not saved. ${message(error)} Correct the highlighted fields or reported validation error and try again.`, "error");
        if (saveBlocked) links.innerHTML += '<a href="#/catalogue">Check existing products before retrying</a>';
      } finally {
        clearTimeout(timer); busy = false; root.removeAttribute("aria-busy");
        controls.forEach(({node,disabled}) => { node.disabled = disabled; });
        [...cards.children].forEach((card,i) => { if (savedIds.has(state.candidates[i].id)) card.querySelector("[data-select]").disabled = true; });
        save.disabled = saveBlocked; save.textContent = saveBlocked ? "Re-extract before another save" : "Create selected drafts"; count();
      }
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

// Shared source-mapping presentation; both versions use the existing protected mapping API.
export function renderColumnMapping(host, state, ui, applyMapping) {
  const { el, escapeHtml: e } = ui;
  const ROLE_LABELS={product_master:"Product master",specifications:"Specifications",pricing:"Pricing",inventory:"Inventory",images:"Images / requirements",qa:"Verification / QA",metadata:"Instructions / metadata",unknown:"Unknown / ambiguous"};
  const FIELD_LABELS = { specifications_json:"Structured specifications JSON", attribute_key:"Specification key", attribute_value:"Specification value", attribute_unit:"Explicit unit", image_slot:"Image order / number", image_type:"Image type / requirement", image_file:"Image filename reference", stock_reference:"Unverified stock reference", qa_check:"Verification check", qa_result:"Verification result", name: "Product name", sku: "SKU", category: "Category", manufacturer: "Brand / manufacturer", brand_model_reference: "Combined brand/model (unverified source)", model: "Model", specifications: "Technical specifications", specification: "Technical specification", retail_reference: "Unapproved retail reference", supplier_cost: "Unapproved supplier-cost reference", source_reference: "Source reference / staff note", ignore: "Ignore" };
    const panel = el(`<details ${state.mapping_required ? "open" : ""}><summary>Review worksheet detection & edit column mapping</summary><p>${state.version===2?"Master sheets create candidates; supporting sheets link evidence. Names and SKUs alone do not establish a master.":"Every worksheet is inspected. Non-product sheets are excluded."} Remapping replaces unsaved field edits. Price and supplier columns cannot be mapped into product specifications or approved prices.</p><div data-sheets></div><button type="button" class="cat-btn" data-remap>Apply mapping & extract again</button></details>`);
    host.prepend(panel);
    for (const d of state.diagnostics || []) {
      const section = el(`<section class="import-upload" data-sheet="${e(d.sheet)}"><h4>${e(d.sheet)}</h4><p>${d.role?e(ROLE_LABELS[d.role]+": "+d.role_reason+" "+d.reasons.join(" ")):d.accepted ? "Product table recognized" : e(d.reasons.join(" "))} · ${d.total_rows} worksheet rows</p><label class="import-confirm"><input type="checkbox" data-include ${(d.role?!d.excluded:d.accepted) ? "checked" : ""}/>${d.role?"Process this worksheet using its selected role":"Use this worksheet as a product table"}</label>${d.role?`<label>Worksheet role<select data-role>${Object.entries(ROLE_LABELS).map(([role,label])=>`<option value="${role}" ${d.role===role?"selected":""}>${label}</option>`).join("")}</select></label>`:""}<label>Header row<select data-header>${d.header_choices.map((r) => `<option value="${r.row}" ${r.row === d.row ? "selected" : ""}>Row ${r.row}: ${e(r.headings.join(" · ").slice(0,160))}</option>`).join("")}</select></label><div class="import-grid" data-columns></div></section>`);
      if(d.role){
        const issues=[...(state.sheet_reconciliation?.unmatched||[]),...(state.sheet_reconciliation?.conflicts||[])].filter(x=>x.sheet===d.sheet&&x.row);
        const unique=[...new Map(issues.map(x=>[x.row,x])).values()];
        for(const decision of state.sheet_reconciliation?.decisions||[])if(decision.sheet===d.sheet&&!unique.some(x=>x.row===decision.row))unique.push({...decision,reason:'Previous explicit row resolution'});
        for(const issue of unique){
          const prior=(d.links||[]).find(x=>x.row===issue.row);
          const row=el(`<div data-link-row="${issue.row}"><p>Row ${issue.row}: ${e(issue.reason)} · ${e(issue.sku||'No SKU')}</p><details><summary>Supporting source cells</summary><pre>${e(JSON.stringify(issue.cells||[],null,2))}</pre></details><label>Row resolution<select data-link-action><option value="">Unresolved</option><option value="ignore">Exclude supporting row, retain evidence</option><option value="link">Link to explicit master (no identity replacement)</option></select></label><label>Master SKU<select data-link-target><option value="">Select exact master</option>${(state.link_targets||[]).map(x=>`<option value="${e(x.sku)}">${e(x.sku)} · ${e(x.name)}</option>`).join('')}</select></label><label>Reason required<input data-link-reason maxlength="400" value="${e(prior?.reason||'')}"></label></div>`);
          row.querySelector('[data-link-action]').value=prior?.action||'';row.querySelector('[data-link-target]').value=prior?.target_sku||'';section.appendChild(row);
        }
      }
      const columnHost = section.querySelector("[data-columns]");
      const paint = () => {
        const row = d.header_choices.find((r) => r.row === Number(section.querySelector("[data-header]").value));
        columnHost.innerHTML = (row?.headings || []).map((header,i) => {
          const original = row.row === d.row ? d.fields[i] : "source_reference";
          const locked = (state.mappings.find((m) => m.sheet === d.sheet && m.row === row.row)?.columns[i]?.locked) || ["supplier", "supplier_cost", "retail_reference"].includes(original);
          return `<label>${i+1}. ${e(header || "Blank heading")}<select data-column ${locked ? "disabled data-mapping-locked" : ""}>${state.mapping_fields.map((f) => `<option value="${e(f)}" ${f === original ? "selected" : ""}>${e(FIELD_LABELS[f] || f)}</option>`).join("")}</select>${locked ? "Financial source classification is protected" : ""}</label>`;
        }).join("");
      };
      section.querySelector("[data-header]").onchange = paint; paint(); panel.querySelector("[data-sheets]").appendChild(section);
    }
    panel.querySelector("[data-remap]").onclick = async () => {
      const button = panel.querySelector("[data-remap]");
      if (button.disabled) return;
      const mapping = [...panel.querySelectorAll("[data-sheet]")].map((s) => ({ sheet: s.dataset.sheet, row: Number(s.querySelector("[data-header]").value), include: s.querySelector("[data-include]").checked, fields: [...s.querySelectorAll("[data-column]")].map((x) => x.value),...(s.querySelector('[data-role]')?{role:s.querySelector('[data-role]').value,links:[...s.querySelectorAll('[data-link-row]')].filter(r=>r.querySelector('[data-link-action]').value).map(r=>({row:Number(r.dataset.linkRow),action:r.querySelector('[data-link-action]').value,target_sku:r.querySelector('[data-link-target]').value,reason:r.querySelector('[data-link-reason]').value}))}:{}) }));
      button.disabled = true;
      try { await applyMapping(mapping); } finally { button.disabled = false; }
    };
    return panel;
}
