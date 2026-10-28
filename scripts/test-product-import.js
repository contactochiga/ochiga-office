"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { zipSync, strToU8 } = require("fflate");
const { extract, candidatesFromTables, money } = require("../src/lead-agents/product-import-extract");
const { startLocal } = require("./product-import-local");
const { catalogueStoreFor } = require("../src/lead-agents/catalogue-store");
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
// Tiny OOXML protocol fixture, all products explicitly synthetic. Not the user's acceptance workbook.
function workbook(rows, formula = false) {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries({
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Synthetic catalogue" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((c, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${xml(c)}</t></is></c>`).join("")}${formula && i === 1 ? '<c r="Z2"><f>1+1</f><v>2</v></c>' : ""}</row>`).join("")}</sheetData></worksheet>`,
  }).map(([k, v]) => [k, strToU8(v)]))));
}
const rows = [["Product name", "SKU", "Category", "Technical specifications", "Retail benchmark NGN"], ...Array.from({ length: 12 }, (_, i) => [`SYNTHETIC Hardware ${i + 1}`, `IMPORT-TEST-${i + 1}`, "Smart Home & Automation", `Test voltage ${i + 1}V`, "1,234.50"])];
async function main() {
  const bytes = workbook(rows), parsed = await extract(bytes, "xlsx");
  check("XLSX recognizes twelve synthetic candidates with exact source rows", () => { assert.equal(parsed.candidates.length, 12); assert.equal(parsed.candidates[0].source_rows[0].row, 2); assert.equal(parsed.candidates[11].variants[0].sku, "IMPORT-TEST-12"); });
  check("integer kobo references; ranges never guessed", () => { assert.equal(parsed.candidates[0].retail_references[0].ngn_kobo, 123450); assert.equal(money("₦100–₦200"), null); });
  const csv = await extract(Buffer.from('Product name,SKU,Description\r\n"Quoted, product",ABC-1,"Line one\nLine two"'), "csv");
  check("CSV quoting and multiline description", () => assert.equal(csv.candidates[0].description, "Line one\nLine two"));
  const f = await extract(workbook(rows, true), "xlsx");
  check("formula cached results ignored", () => assert.ok(f.warnings.some((w) => w.includes("Formula ignored"))));
  const grouped = candidatesFromTables({ tables: [{ sheet: "Variants", data: [["Product", "SKU", "Variant"], ["Test", "T-1", "Black"], ["Test", "T-2", "White"]] }] });
  check("explicit variant rows group under one product", () => assert.equal(grouped.candidates[0].variants.length, 2));
  const delimited = await extract(Buffer.from('Product name;SKU;Description\nSynthetic;SEM-1;"a,b,c,d,e,f"'), "csv");
  check("CSV delimiter uses headers rather than punctuation inside descriptions", () => assert.equal(delimited.candidates[0].variants[0].sku, "SEM-1"));
  const unpriced = await extract(Buffer.from('Product,SKU,Retail price\nSynthetic,UNK-1,100'), "csv");
  check("unspecified currency is not invented as NGN", () => assert.equal(unpriced.candidates[0].retail_references[0].ngn_kobo, null));
  const bomb = Buffer.from(zipSync({ "huge.xml": new Uint8Array(25 * 1024 * 1024) }));
  await assert.rejects(extract(bomb, "xlsx")); checks++; console.log("PASS reject expanded ZIP over limit");
  const noRows = candidatesFromTables({ tables: [{sheet:"Notes", data:[["An instruction is not a product table"]]}] });
  check("non-product content does not fabricate candidates", () => assert.equal(noRows.candidates.length, 0));
  for (const [name, b, ext] of [["corrupt XLSX", Buffer.from("not a workbook"), "xlsx"], ["oversized file", Buffer.alloc(5 * 1024 * 1024 + 1), "csv"], ["active content", Buffer.from(zipSync({ "xl/vbaProject.bin": new Uint8Array([1]) })), "xlsx"]]) {
    await assert.rejects(extract(b, ext)); checks++; console.log(`PASS reject ${name}`);
  }
  const app = await startLocal({ directory: fs.mkdtempSync(path.join(os.tmpdir(), "product-import-test-")) });
  try {
    const cookies = {};
    for (const [name, u] of Object.entries(app.identities)) {
      const r = await fetch(`${app.base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(u) });
      assert.equal(r.status, 200); cookies[name] = r.headers.get("set-cookie").split(";")[0];
    }
    const call = async (who, method, route, body, raw = false) => {
      const r = await fetch(`${app.base}${route.startsWith("/api/") ? route : "/api/lead-agents/admin/catalogue" + route}`, { method, headers: { cookie: cookies[who] || "", origin: app.base, "content-type": raw ? "application/octet-stream" : "application/json" }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const before = app.store.state.catalogue?.products?.length || 0;
    let r = await call("reader", "POST", "/imports?name=test.xlsx", bytes, true);
    check("read-only staff cannot extract", () => assert.equal(r.status, 403));
    r = await call("importer", "POST", "/imports?name=test.xlsx", bytes, true);
    check("real HTTP upload returns editable preview, no product creation", () => { assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.candidates.length, 12); assert.equal(app.store.state.catalogue.products.length, before); });
    const preview = r.body;
    r = await call("nobody", "GET", `/imports/${preview.id}`);
    check("unauthenticated import access denied", () => assert.equal(r.status, 401));
    check("missing media and supplier data flagged, retail never approved", () => { assert.ok(preview.candidates[0].warnings.some((w) => w.includes("Images missing"))); assert.ok(preview.candidates[0].warnings.some((w) => w.includes("supplier cost missing"))); assert.equal(preview.candidates[0].pricing_classification, "unapproved_source_reference"); });
    r = await call("other", "GET", `/imports/${preview.id}`);
    check("other staff cannot read private source preview", () => assert.equal(r.status, 404));
    r = await call("importer", "GET", `/api/lead-agents/admin/storage/${preview.id}`);
    check("generic storage denies raw import even to storage reader", () => assert.equal(r.status, 404));
    const costBytes = Buffer.from("Product,SKU,Supplier cost NGN\nSynthetic,SUP-1,123.45");
    r = await call("writer", "POST", "/imports?name=cost.csv", costBytes, true);
    check("supplier data requires cost-read permission", () => assert.equal(r.status, 403));
    r = await call("importer", "POST", "/imports?name=cost.csv", costBytes, true);
    check("authorized supplier references are extracted without actual costs", () => { assert.equal(r.status, 201); assert.equal(r.body.candidates[0].supplier_references[0].ngn_kobo, 12345); });
    const cat = catalogueStoreFor(app.store), categories = await cat.listCategories();
    const selection = preview.candidates.slice(0, 3).map((c) => ({ id: c.id, slug: c.slug, content: { ...c.content, category_id: categories[0].id, price_ngn_kobo: 999, publication_status: "published" } }));
    r = await call("importer", "POST", `/imports/${preview.id}/drafts`, null);
    check("malformed confirmation body denied safely", () => assert.equal(r.status, 400));
    const invalid = structuredClone(selection); invalid[1].content.variants[0].sku = invalid[0].content.variants[0].sku;
    r = await call("importer", "POST", `/imports/${preview.id}/drafts`, { confirm_drafts_only: true, items: invalid });
    check("duplicate SKU within selection rejects before any product writes", () => { assert.equal(r.status, 409); assert.equal(app.store.state.catalogue.products.length, 0); });
    r = await call("importer", "POST", `/imports/${preview.id}/drafts`, { items: selection });
    check("explicit draft confirmation required", () => assert.equal(r.status, 400));
    r = await call("importer", "POST", `/imports/${preview.id}/drafts`, { confirm_drafts_only: true, items: selection });
    check("selected subset creates drafts only", () => { assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.results.length, 3); assert.equal(app.store.state.catalogue.products.length, 3); assert.ok(app.store.state.catalogue.products.every((p) => p.workflow_status === "draft" && p.publication_status === "never_published")); });
    check("selling prices, stock, costs and publication unchanged", () => { assert.ok(app.store.state.catalogue.variants.every((v) => v.price_ngn_kobo === null && v.stock_on_hand === 0)); assert.equal(app.store.state.catalogue.costs.length, 0); });
    check("version 1 and audit source provenance retained", () => { assert.equal(app.store.state.catalogue.versions.length, 3); assert.equal(app.store.state.audit_events.filter((a) => a.action === "catalogue_product_imported").length, 3); });
    r = await call("importer", "POST", `/imports/${preview.id}/drafts`, { confirm_drafts_only: true, items: selection });
    check("retry cannot duplicate products", () => { assert.equal(r.status, 409); assert.equal(app.store.state.catalogue.products.length, 3); });
    r = await call("importer", "GET", `/imports/${preview.id}`);
    check("duplicate detection refreshes against saved catalogue", () => assert.deepEqual(r.body.candidates[0].duplicate_skus, ["IMPORT-TEST-1"]));
    r = await call("importer", "POST", "/products", { slug: "manual-regression", content: { name: "Synthetic manual", category_id: categories[0].id, variants: [{ sku: "MANUAL-1", name: "Manual", options: {} }] } });
    check("manual Add Product remains functional", () => assert.equal(r.status, 201));
    r = await call("importer", "POST", `/products/${r.body.product.id}/publish`, { expected_row_version: 1 });
    check("importer cannot publish", () => assert.equal(r.status, 403));
    const concurrentSelection = [{ ...selection[0], id: preview.candidates[3].id, slug: "synthetic-concurrent", content: { ...preview.candidates[3].content, category_id: categories[0].id } }];
    const concurrent = await Promise.all([1,2].map(() => call("importer", "POST", `/imports/${preview.id}/drafts`, { confirm_drafts_only:true, items:concurrentSelection })));
    check("simultaneous submissions create one draft only", () => { assert.equal(app.store.state.catalogue.products.filter((p) => p.slug === "synthetic-concurrent").length,1); assert.equal(concurrent.filter((r) => r.status === 201).length,1); });
    const docs = await app.store.listOfficeDocuments();
    check("shared Documents index never includes supplier amounts or raw rows", () => assert.ok(docs.filter((d) => d.document_type === "product_import").every((d) => !d.file_url && !d.share_token && !d.body && !JSON.stringify(d.metadata).includes("123.45"))));
    await assert.rejects(fetch("https://production.invalid/"), /blocks external/); checks++; console.log("PASS local rehearsal blocks non-loopback network access");
    fs.mkdirSync(path.resolve("outputs/import-tests"), { recursive: true });
    fs.writeFileSync(path.resolve("outputs/import-tests/synthetic-catalogue.xlsx"), bytes);
  } finally { await app.stop(); }
  console.log(JSON.stringify({ suite: "product-import", passed: checks, failed: 0 }));
}
if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });
module.exports = { workbook, rows };
