"use strict";

// Format adapters return source-addressed tables. No network, AI runtime, formula evaluation or image fetching.
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { parse } = require("csv-parse/sync");
const { unzipSync, zipSync, strFromU8, strToU8 } = require("fflate");
const readExcel = require("read-excel-file/node");
const C = require("./catalogue");
const LIMITS = Object.freeze({ bytes: 5 * 1024 * 1024, expanded: 24 * 1024 * 1024, rows: 2000, columns: 100, sheets: 12, candidates: 250 });
const fail = (code) => { throw C.httpError(400, code); };
const text = (v) => v == null ? "" : v instanceof Date ? v.toISOString() : String(v).trim();
const key = (v) => text(v).toLowerCase().replace(/[₦()]/g, " ").replace(/[_\-\/]+/g, " ").replace(/\s+/g, " ").trim();
const ALIASES = {
  name: ["name", "product", "product name", "item", "item name", "product title", "equipment", "proposed listing title", "listing title", "office product title"],
  sku: ["sku", "product sku", "item code", "product code", "code", "variant sku", "suggested sku", "recommended sku", "sku code", "ochiga provisional sku", "provisional sku", "internal sku", "internal sku proposed"],
  category: ["category", "product category", "category name", "type", "office subcategory", "subcategory", "category subcategory"],
  manufacturer: ["manufacturer", "brand", "brand name", "make"],
  brand_model_reference: ["brand confirmed model", "brand model", "brand and model"],
  model: ["model", "model number", "model no", "manufacturer model"],
  description: ["description", "product description", "full description"],
  summary: ["summary", "short description"],
  specifications: ["specifications", "technical specifications", "technical specification", "key specifications", "specs", "features", "key features"],
  variant: ["variant", "variant name", "variation"],
  options: ["options", "variant options"],
  image: ["image", "images", "image url", "image urls", "photo", "image reference", "product image"],
  supplier: ["supplier", "supplier name", "supplier action"],
  group: ["product id", "parent sku", "group id"],
  source_reference: ["source", "source product photo page", "source reference", "source url", "product page", "use case", "priority", "outstanding checks", "moq", "stock status", "listing status", "supplier manufacturer permission", "pricing status", "sourcing oyi status", "product photo & price source", "second source", "image source page", "usage license status"],
  ignore: ["no", "no.", "s n", "sn", "s/n", "quantity", "qty", "stock", "stock quantity"],
};
function fieldFor(header) {
  const h = key(header);
  if (/^(technical |key )?specifications?(?: |$)/.test(h)) return "specifications";
  for (const [field, names] of Object.entries(ALIASES)) if (names.includes(h)) return field;
  if (/supplier.*(price|cost|quote)|dealer.*(price|cost|quote)|purchase.*(price|cost)|wholesale|landed.*cost/.test(h)) return "supplier_cost";
  if (/price|retail|benchmark|rrp|msrp|selling|cost|amount|currency/.test(h)) return "retail_reference";
  return h ? "source_reference" : "ignore";
}
function money(raw) {
  const value = text(raw).replace(/^(NGN|₦)\s*/i, "").replace(/,/g, "");
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) return null;
  const kobo = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
  return Number.isSafeInteger(kobo) ? kobo : null;
}
async function extractTables(buffer, extension) {
  if (!buffer.length || buffer.length > LIMITS.bytes) fail("import_file_size");
  let tables, warnings = [];
  if (extension === "csv") {
    const data = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (data.includes("\0")) fail("invalid_csv");
    const options = [",", ";", "\t"].map((delimiter) => {
      try {
        const rows = parse(data, { bom: true, delimiter, relax_column_count: true, max_record_size: 64000 });
        const score = Math.max(0, ...rows.slice(0, 30).map((row) => row.some((h) => fieldFor(h) === "name") ? row.filter((h) => !["specification", "source_reference", "ignore"].includes(fieldFor(h))).length : 0));
        return { rows, score };
      } catch { return { rows: [], score: -1 }; }
    }).sort((a, b) => b.score - a.score);
    if (options[0].score < 0) fail("invalid_csv");
    tables = [{ sheet: "CSV", data: options[0].rows }];
  } else if (extension === "xlsx") {
    if (buffer.readUInt16LE(0) !== 0x4b50) fail("invalid_xlsx");
    let expanded = 0, entries = 0;
    const files = unzipSync(buffer, { filter: (entry) => {
      expanded += entry.originalSize; entries++;
      if (expanded > LIMITS.expanded || entries > 1000 || entry.originalSize > LIMITS.expanded) fail("import_expansion_limit");
      if (/vbaProject|externalLinks|activeX|embeddings/i.test(entry.name)) fail("active_workbook_not_supported");
      return true;
    } });
    let actual = 0;
    for (const [name, bytes] of Object.entries(files)) {
      actual += bytes.length;
      if (actual > LIMITS.expanded) fail("import_expansion_limit");
      if (!/\.xml$|\.rels$/.test(name)) continue;
      let xml = strFromU8(bytes);
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail("unsafe_workbook_xml");
      if (/worksheets\/sheet\d+\.xml$/.test(name)) {
        if ([...xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)].some((m) => +m[1] > LIMITS.rows)) fail("import_row_limit");
        // Ignore cached formula results too: they are neither current nor an approved commercial price.
        xml = xml.replace(/<c\b[^>]*>[\s\S]*?<\/c>/g, (cell) => {
          if (!/<f[\s>\/]/.test(cell)) return cell;
          warnings.push(`Formula ignored in ${name}, ${cell.match(/\br="([^"]+)"/)?.[1] || "cell"}`);
          return "";
        });
        files[name] = strToU8(xml);
      }
    }
    tables = await readExcel(Buffer.from(zipSync(files)));
    if (Object.keys(files).some((n) => n.startsWith("xl/media/"))) warnings.push("Embedded images are not imported. Add validated photographs through the product media gallery.");
  } else fail("unsupported_import_format");
  if (tables.length > LIMITS.sheets) fail("import_sheet_limit");
  let rowCount = 0;
  for (const table of tables) {
    rowCount += table.data.length;
    if (rowCount > LIMITS.rows) fail("import_row_limit");
    if (table.data.some((row) => row.length > LIMITS.columns || row.some((cell) => text(cell).length > 10000))) fail("import_cell_limit");
  }
  return { tables, warnings };
}
const FIELDS = Object.freeze([...Object.keys(ALIASES), "specification", "retail_reference", "supplier_cost"]);
const SINGLE_FIELDS = ["name", "sku", "category", "manufacturer", "model", "group", "variant", "description", "summary", "options"];
const LOCKED_FIELDS = ["retail_reference", "supplier_cost", "supplier"];
function inspectTables(tables, overrides = []) {
  if (!Array.isArray(overrides) || overrides.length > LIMITS.sheets) fail("import_invalid_mapping");
  if (new Set(overrides.map((o) => o?.sheet)).size !== overrides.length || overrides.some((o) => !o || !tables.some((t) => t.sheet === o.sheet))) fail("import_invalid_mapping");
  return tables.map((table) => {
    const choices = table.data.slice(0, 30).map((row, index) => {
      const headings = row.map(text), fields = headings.map(fieldFor);
      const hasIdentity = fields.some((f) => ["sku", "category", "description", "model"].includes(f));
      const score = fields.includes("name") && hasIdentity ? fields.filter((f) => !["source_reference", "ignore", "specification"].includes(f)).length : 0;
      return { row: index + 1, headings, fields, score };
    }).filter((row) => row.headings.some(Boolean));
    const strong = choices.filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
    const distinct = new Set(strong.map((c) => JSON.stringify(c.headings)));
    const chosen = overrides.find((o) => o.sheet === table.sheet);
    let selected = chosen ? choices.find((c) => c.row === chosen.row) : strong[0] || choices[0];
    if (chosen?.include === false && !selected && !choices.length) selected = {row:1,headings:[],fields:[],score:0};
    if (chosen && ((chosen.include !== undefined && typeof chosen.include !== "boolean") || !selected || !Array.isArray(chosen.fields) || chosen.fields.length !== selected.headings.length || chosen.fields.some((f) => !FIELDS.includes(f)))) fail("import_invalid_mapping");
    selected ||= { row: 1, headings: [], fields: [], score: 0 };
    const fields = chosen ? selected.fields.map((original, i) => LOCKED_FIELDS.includes(original) ? original : chosen.fields[i]) : selected.fields;
    const reasons = [];
    if (!fields.includes("name")) reasons.push("No product-name column mapped.");
    if (!fields.some((f) => ["sku", "category", "description", "model"].includes(f))) reasons.push("No SKU, category, description or model column mapped.");
    if (!chosen && distinct.size > 1) reasons.push("Multiple possible header rows; choose the product table explicitly.");
    for (const field of SINGLE_FIELDS) if (fields.filter((f) => f === field).length > 1) reasons.push(`Multiple columns map to ${field}; select one and retain the others as source references.`);
    if (chosen?.include === false) reasons.push("Sheet excluded by reviewer.");
    return { sheet: table.sheet, total_rows: table.data.length, row: selected.row, headings: selected.headings, fields, accepted: reasons.length === 0, reasons, header_choices: choices.map(({row,headings}) => ({row,headings})) };
  });
}
function candidatesFromTables({ tables, warnings = [] }, overrides = [], version = 1) {
  const candidates = [], mappings = [], diagnostics = inspectTables(tables, overrides);
  for (const table of tables) {
    const diagnostic = diagnostics.find((d) => d.sheet === table.sheet);
    if (!diagnostic.accepted) { warnings.push(`${table.sheet}: ${diagnostic.reasons.join(" ")}`); continue; }
    const headerIndex = diagnostic.row - 1, headers = diagnostic.headings, fields = diagnostic.fields;
    mappings.push({ sheet: table.sheet, row: headerIndex + 1, columns: headers.map((header, i) => ({ column: i + 1, header, field: fields[i], locked: LOCKED_FIELDS.includes(fieldFor(header)) })) });
    const groups = new Map();
    table.data.slice(headerIndex + 1).forEach((row, offset) => {
      if (!row.some((cell) => text(cell))) return;
      const values = Object.create(null);
      fields.forEach((field, i) => { if (text(row[i]) && !values[field]) values[field] = text(row[i]); });
      if (values.name && fieldFor(values.name) === "name" && values.sku && fieldFor(values.sku) === "sku") return; // repeated page header
      const source = { sheet: table.sheet, row: headerIndex + offset + 2 };
      const group = values.group || (version === 2 ? `row-${source.row}` : values.name ? `${values.name}\0${values.model || ""}` : `row-${source.row}`);
      let item = groups.get(group);
      if (!item) {
        item = { id: `${mappings.length}:${source.row}`, source_rows: [], name: values.name || "", model: values.model || "", manufacturer: values.manufacturer || "", category: values.category || "", summary: values.summary || "", description: values.description || "", specifications: [], variants: [], retail_references: [], supplier_references: [], image_references: [], source_references: [], brand_model_reference: values.brand_model_reference || "", warnings: [] };
        groups.set(group, item); candidates.push(item);
      }
      item.source_rows.push(source);
      if (values.brand_model_reference) item.warnings.push("Combined brand/model source is unverified; confirm manufacturer and model separately before publishing.");
      if (fields.some((field, i) => field === "sku" && typeof row[i] === "number")) item.warnings.push("Numeric SKU: verify leading zeros and formatting against the source workbook.");
      const formula = (v) => /^[=+@]/.test(v);
      row.forEach((cell, i) => {
        const value = text(cell), field = fields[i];
        if (!value) return;
        if (formula(value)) { item.warnings.push(`Formula-like value in ${headers[i]} requires manual review.`); return; }
        const explicitNgn = /\bNGN\b|₦/i.test(`${headers[i]} ${value}`);
        if (field === "retail_reference") item.retail_references.push({ label: headers[i], value, ngn_kobo: explicitNgn ? money(value) : null, currency: explicitNgn ? "NGN" : "unspecified", ...source });
        else if (field === "supplier_cost" || field === "supplier") item.supplier_references.push({ label: headers[i], kind: field, value, ngn_kobo: field === "supplier_cost" && explicitNgn ? money(value) : null, ...source });
        else if (field === "image") item.image_references.push({ value, ...source });
        else if (field === "source_reference" || field === "brand_model_reference") item.source_references.push({ label: headers[i], value, ...source });
        else if (field === "specification" || field === "specifications") {
          if (!item.specifications.some((s) => s.key === headers[i] && s.value === value)) {
            if (item.specifications.some((s) => s.key === headers[i])) item.warnings.push(`Conflicting ${headers[i]} values across variant rows; review specifications.`);
            else item.specifications.push({ key: headers[i], value, unit: "" });
          }
        }
      });
      item.variants.push({ sku: (values.sku || "").toUpperCase(), name: values.variant || values.name || "", options: {} });
      if (values.options) {
        try { const opts = JSON.parse(values.options); if (opts && typeof opts === "object" && !Array.isArray(opts)) item.variants.at(-1).options = opts; else throw Error(); }
        catch { item.warnings.push("Variant options must be a JSON object; enter them in the preview."); }
      }
      if (!values.name) item.warnings.push("Product name missing; row retained for review.");
    });
  }
  if (candidates.length > (version === 2 ? 1000 : LIMITS.candidates)) fail("import_product_limit");
  // Permission checks cover raw source data even on skipped sheets or after a reviewer remaps columns.
  const supplierSource = tables.some((t) => t.data.slice(0,30).some((row, ri) => row.some((h, ci) => ["supplier", "supplier_cost"].includes(fieldFor(h)) && t.data.slice(ri+1).some((r) => text(r[ci])))));
  return { candidates, mappings, diagnostics, mapping_fields: FIELDS, mapping_required: candidates.length === 0 || diagnostics.some((d) => !d.reasons.includes("Sheet excluded by reviewer.") && d.reasons.some((r) => /Multiple/.test(r))), warnings: warnings.slice(0, 200), contains_supplier_data: supplierSource || candidates.some((c) => c.supplier_references.length) };
}
let active = 0;
function extract(buffer, extension, mapping = [], version = 1) {
  if (active >= 2) return Promise.reject(C.httpError(429, "import_busy"));
  active++;
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { buffer, extension, mapping, version }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); active--; worker.terminate(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(C.httpError(422, "import_parse_timeout")), 15000);
    worker.once("message", (v) => v.error ? finish(C.httpError(422, v.error)) : finish(null, v));
    worker.once("error", () => finish(C.httpError(422, "invalid_import_file")));
    worker.once("exit", () => { if (!done) finish(C.httpError(422, "invalid_import_file")); });
  });
}
if (!isMainThread) extractTables(Buffer.from(workerData.buffer), workerData.extension).then((tables) => { const result = candidatesFromTables(tables, workerData.mapping, workerData.version); return workerData.version === 2 ? require("./ingestion-evidence").enrichExtraction(result, tables.tables) : result; }).then((v) => parentPort.postMessage(v)).catch((e) => parentPort.postMessage({ error: e.code?.startsWith("import_") || ["unsupported_import_format", "active_workbook_not_supported", "unsafe_workbook_xml"].includes(e.code) ? e.code : "invalid_import_file" }));
module.exports = { extract, extractTables, candidatesFromTables, fieldFor, money, LIMITS, inspectTables, FIELDS };
