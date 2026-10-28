"use strict";
// Actual workbook acceptance via the authenticated browser upload endpoint. Never calls /drafts or creates catalogue records.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const E = require("../src/lead-agents/product-import-extract");
const { startLocal } = require("./product-import-local");
let checks = 0;
const check = (label, fn) => { fn(); checks++; console.log(`PASS ${label}`); };
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
async function main() {
  const fixtures = [
    { file: process.argv[2] || "/Users/ochigaidoko/Downloads/getoyi_12_hardware_sourcing_catalogue.xlsx", count: 12 },
    { file: process.argv[3] || "/Users/ochigaidoko/Downloads/GetOyi_Commercial_Facility_Hardware_15_Products.xlsx", count: 15 },
  ];
  for (const fixture of fixtures) assert.ok(fs.existsSync(fixture.file), `Actual workbook missing: ${fixture.file}`);
  check("header normalization accepts case, punctuation and spacing",()=>{
    assert.equal(E.fieldFor("  OCHIGA   provisional_SKU  "),"sku");
    assert.equal(E.fieldFor("Technical specifications (verify by exact revision)"),"specifications");
    assert.equal(E.fieldFor("Dealer landed cost ₦"),"supplier_cost");
    assert.equal(E.fieldFor("Public retail ₦"),"retail_reference");
  });
  check("all sheets scanned; later header and repeated page header handled",()=>{
    const parsed=E.candidatesFromTables({tables:[{sheet:"Guide",data:[["Instructions","Notes"]]},{sheet:"Products",data:[["Catalogue"],["Product name","SKU"],["One","ONE-1"],["Product name","SKU"],["Two","TWO-1"]]}]});
    assert.equal(parsed.candidates.length,2);assert.equal(parsed.mappings[0].row,2);assert.equal(parsed.mapping_required,false);
  });
  check("explicitly excluded ambiguous sheet does not block valid table",()=>{
    const tables=[{sheet:"Products",data:[["Product name","SKU"],["One","ONE-1"]]},{sheet:"Excluded",data:[["Product name","Proposed listing title","SKU"],["One","Two","TWO-1"]]}];
    assert.equal(E.candidatesFromTables({tables}).mapping_required,true);
    const resolved=E.candidatesFromTables({tables},[{sheet:"Excluded",row:1,include:false,fields:["name","name","sku"]}]);
    assert.equal(resolved.mapping_required,false);assert.equal(resolved.candidates.length,1);
  });
  const app = await startLocal({ directory: fs.mkdtempSync(path.join(os.tmpdir(), "import-real-preview-")) });
  const evidence = [];
  try {
    const cookies = {};
    for (const who of ["importer", "other", "writer"]) {
      const response = await fetch(`${app.base}/api/lead-agents/admin/session/login`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(app.identities[who])});
      assert.equal(response.status,200); cookies[who] = response.headers.get("set-cookie").split(";")[0];
    }
    const request = async (route, body, who = "importer", raw = false) => {
      assert.ok(!route.endsWith("/drafts"), "Preview rehearsal must not create drafts");
      const response = await fetch(`${app.base}/api/lead-agents/admin/catalogue${route}`, {method:body === undefined ? "GET":"POST",headers:{cookie:cookies[who],origin:app.base,"content-type":raw?"application/octet-stream":"application/json"},body:body===undefined?undefined:raw?body:JSON.stringify(body)});
      return {status:response.status,data:await response.json()};
    };
    await request("/products");
    const before = JSON.stringify(app.store.state.catalogue);
    for (const fixture of fixtures) {
      const bytes=fs.readFileSync(fixture.file), hash=digest(bytes), name=path.basename(fixture.file);
      const source=await E.extractTables(bytes,"xlsx");
      const {status,data}=await request(`/imports?name=${encodeURIComponent(name)}`,bytes,"importer",true);
      check(`${name}: ${fixture.count}/${fixture.count} via upload HTTP`,()=>{assert.equal(status,201,JSON.stringify(data));assert.equal(data.candidates.length,fixture.count);assert.equal(data.mapping_required,false);});
      check(`${name}: all worksheets diagnosed; only product table used`,()=>{assert.equal(data.diagnostics.length,source.tables.length);assert.equal(data.mappings.length,1);assert.ok(data.diagnostics.filter(d=>!d.accepted).every(d=>d.reasons.length));});
      const map=data.mappings[0], table=source.tables.find(t=>t.sheet===map.sheet);
      for(const c of data.candidates) {
        const row=table.data[c.source_rows[0].row-1];
        for(const [f,property] of [["sku",null],["name","name"],["category","category"],["manufacturer","manufacturer"],["model","model"],["brand_model_reference","brand_model_reference"]]) {
          const column=map.columns.find(x=>x.field===f);
          if(column) assert.equal(property?c[property]:c.variants[0].sku,String(row[column.column-1]||"").trim());
        }
        const spec=map.columns.find(x=>x.field==="specifications");
        assert.ok(c.specifications.some(s=>s.value===String(row[spec.column-1]).trim()));
        for(const ref of c.source_references) assert.equal(ref.value,String(row[map.columns.find(x=>x.header===ref.label).column-1]).trim());
        assert.equal(c.pricing_classification,"unapproved_source_reference");
        assert.ok(!Object.hasOwn(c.content,"price_ngn_kobo")); assert.deepEqual(c.content.media,[]);
        assert.ok(c.warnings.some(w=>w.includes("Images missing")));
        assert.ok(c.warnings.some(w=>/supplier cost missing|Supplier cost missing/.test(w)));
        assert.ok(c.warnings.some(w=>/unapproved|Selling price remains unapproved/.test(w)));
        if(!c.content.category_id) assert.ok(c.warnings.some(w=>w.includes("Choose an existing category")));
      }
      check(`${name}: every candidate preserves identity, specifications and source references; commercial warnings intact`,()=>assert.equal(data.candidates.length,fixture.count));
      const override=data.diagnostics.map(d=>({sheet:d.sheet,row:d.row,include:d.accepted,fields:[...d.fields]}));
      const financial=override.find(o=>o.include); const priceIndex=financial.fields.indexOf("retail_reference");financial.fields[priceIndex]="specification";
      const remapped=await request(`/imports/${data.id}/mapping`,{mapping:override});
      check(`${name}: remapping cannot turn price references into specifications`,()=>{assert.equal(remapped.status,200,JSON.stringify(remapped.data));assert.equal(remapped.data.mappings[0].columns[priceIndex].field,"retail_reference");assert.equal(remapped.data.candidates.length,fixture.count);assert.notEqual(remapped.data.id,data.id);});
      const old=await request(`/imports/${data.id}`);
      check(`${name}: original preview remains readable and unchanged`,()=>assert.deepEqual(old.data.candidates,data.candidates));
      const other=await request(`/imports/${data.id}/mapping`,{mapping:override},"other");
      check(`${name}: another uploader cannot remap source evidence`,()=>assert.equal(other.status,404));
      check(`${name}: original XLSX bytes unchanged`,()=>assert.equal(digest(fs.readFileSync(fixture.file)),hash));
      evidence.push({file:name,sha256:hash,http_status:status,candidates:data.candidates.length,sheets:data.diagnostics.map(d=>({sheet:d.sheet,row:d.row,accepted:d.accepted,reasons:d.reasons}))});
    }
    const unknown=await request("/imports?name=unknown.csv",Buffer.from("Listing heading,Inventory ID\nSynthetic mapping only,MAP-1"),"importer",true);
    check("unrecognized table returns sheets/headings/reasons and an editable preview",()=>{assert.equal(unknown.status,202);assert.equal(unknown.data.candidates.length,0);assert.ok(unknown.data.mapping_required);assert.deepEqual(unknown.data.diagnostics[0].headings,["Listing heading","Inventory ID"]);});
    const recovered=await request(`/imports/${unknown.data.id}/mapping`,{mapping:[{sheet:"CSV",row:1,include:true,fields:["name","sku"]}]});
    check("explicit mapping recovers unknown headings without product creation",()=>{assert.equal(recovered.status,200);assert.equal(recovered.data.candidates.length,1);assert.equal(recovered.data.candidates[0].variants[0].sku,"MAP-1");});
    const ambiguous=await request("/imports?name=ambiguous.csv",Buffer.from("Product name,Proposed listing title,SKU\nOne,Two,AMB-1"),"importer",true);
    check("ambiguous name mapping is refused instead of silently choosing a column",()=>{assert.equal(ambiguous.status,202);assert.ok(ambiguous.data.diagnostics[0].reasons.some(r=>r.includes("Multiple columns")));});
    const resolved=await request(`/imports/${ambiguous.data.id}/mapping`,{mapping:[{sheet:"CSV",row:1,include:true,fields:["source_reference","name","sku"]}]});
    check("reviewer selects one ambiguous name and preserves the alternative as reference",()=>{assert.equal(resolved.data.candidates[0].name,"Two");assert.equal(resolved.data.candidates[0].source_references[0].value,"One");});
    const restricted=await request("/imports?name=unknown-cost.csv",Buffer.from("Heading,Dealer quote ₦\nOne,100"),"writer",true);
    check("unrecognized tables do not bypass supplier-cost permissions",()=>assert.equal(restricted.status,403));
    const bad=await request(`/imports/${unknown.data.id}/mapping`,{mapping:[{sheet:"CSV",row:1,fields:["name","approved_price"]}]});
    check("unrecognized mapping targets rejected",()=>assert.equal(bad.status,422));
    check("entire preview/mapping rehearsal leaves catalogue byte-for-byte unchanged",()=>assert.equal(JSON.stringify(app.store.state.catalogue),before));
    check("no product-created or imported audit events",()=>assert.equal(app.store.state.audit_events.filter(a=>["catalogue_product_created","catalogue_product_imported"].includes(a.action)).length,0));
    fs.mkdirSync("outputs/import-correction",{recursive:true});fs.writeFileSync("outputs/import-correction/http-evidence.json",JSON.stringify({checks,failed:0,evidence,catalogue_unchanged:true},null,2));
    console.log(JSON.stringify({suite:"actual-workbook-preview-http",checks,failed:0,catalogue_unchanged:true}));
  } finally {await app.stop();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
