"use strict";
// Synthetic regression only. Never connects to the owner's 4387 store or reads the real workbooks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { startLocal } = require("./product-import-local");
let checks = 0;
const check = (label, fn) => { fn(); checks++; console.log(`PASS ${label}`); };
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "import-stage2-synthetic-"));
  let app = await startLocal({ directory }), cookie;
  const login = async () => {
    const r = await fetch(`${app.base}/api/lead-agents/admin/session/login`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(app.identities.importer) });
    assert.equal(r.status,200);cookie=r.headers.get("set-cookie").split(";")[0];
  };
  const call = async (method, route, body, raw=false) => {
    const r = await fetch(`${app.base}/api/lead-agents/admin/catalogue${route}`, {method,headers:{cookie,origin:app.base,"content-type":raw?"application/octet-stream":"application/json"},body:body===undefined?undefined:raw?body:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  try {
    await login();
    const csv=Buffer.from('Product name,SKU,Manufacturer,Manufacturer model,Technical specifications,Source,Public retail ₦,Dealer landed cost ₦\nSYNTHETIC Stage 2,STAGE2-SYNTHETIC-1,SYNTHETIC Maker,TEST-MODEL,Test specification only,https://example.invalid/synthetic,100,50');
    const preview=await call("POST","/imports?name=synthetic-stage2.csv",csv,true);
    assert.equal(preview.status,201);
    const candidate=preview.body.candidates[0];
    const content={...candidate.content,category_id:preview.body.categories[0].id};
    const selection={confirm_drafts_only:true,items:[{id:candidate.id,slug:candidate.slug,content}]};
    const created=await call("POST",`/imports/${preview.body.id}/drafts`,selection);
    assert.equal(created.status,201,JSON.stringify(created.body));
    const id=created.body.results[0].product_id;
    let detail=(await call("GET",`/products/${id}`)).body;
    check("imported draft reopens with exact reviewed fields and empty gallery",()=>{assert.deepEqual(detail.content,require("../src/lead-agents/catalogue").validateContent(content));assert.equal(detail.product.workflow_status,"draft");assert.equal(detail.product.current_version,1);});
    const evidence=app.store.state.audit_events.find(a=>a.action==="catalogue_product_imported"&&a.resource_id===id);
    const reviewed=JSON.parse(fs.readFileSync(path.join(directory,"storage",evidence.metadata.review_file)));
    check("audit links immutable reviewed evidence including manufacturer, sources and unapproved references",()=>{
      assert.equal(evidence.metadata.document_id,preview.body.document_id);assert.equal(evidence.metadata.pricing,"unapproved_source_reference");
      assert.equal(reviewed.items[0].candidate.manufacturer,"SYNTHETIC Maker");assert.equal(reviewed.items[0].candidate.source_references[0].value,"https://example.invalid/synthetic");
      assert.equal(reviewed.items[0].candidate.retail_references[0].ngn_kobo,10000);assert.equal(reviewed.items[0].candidate.supplier_references[0].ngn_kobo,5000);
    });
    const v1=JSON.stringify(app.store.state.catalogue.versions.find(v=>v.product_id===id&&v.version===1));
    const edited=await call("PATCH",`/products/${id}`,{expected_row_version:detail.product.row_version,content:{...detail.content,summary:"SYNTHETIC edit validation"}});
    assert.equal(edited.status,200,JSON.stringify(edited.body));detail=edited.body;
    check("editing appends version 2 and leaves version 1 untouched",()=>{assert.equal(detail.product.current_version,2);assert.equal(detail.content.summary,"SYNTHETIC edit validation");assert.equal(JSON.stringify(app.store.state.catalogue.versions.find(v=>v.product_id===id&&v.version===1)),v1);});
    const image=await sharp({create:{width:640,height:480,channels:3,background:"#334455"}}).png().toBuffer();
    const upload=await call("POST",`/products/${id}/media?name=synthetic.png`,image,true);
    assert.equal(upload.status,201,JSON.stringify(upload.body));
    const gallery=[{media_id:upload.body.media.id,cover:true,alt:"Synthetic image for local regression",caption:"",variant_skus:["STAGE2-SYNTHETIC-1"]}];
    const saved=await call("PATCH",`/products/${id}`,{expected_row_version:detail.product.row_version,content:{...detail.content,media:gallery}});
    assert.equal(saved.status,200,JSON.stringify(saved.body));
    const thumb=await fetch(`${app.base}${upload.body.media.urls.thumb}`,{headers:{cookie}});
    const thumbBytes=Buffer.from(await thumb.arrayBuffer());
    check("existing upload/gallery route supports imported drafts and private processed thumbnails",()=>{assert.equal(saved.body.product.current_version,3);assert.deepEqual(saved.body.content.media,gallery);assert.equal(thumb.status,200);assert.equal(thumb.headers.get("content-type"),"image/webp");assert.equal(thumb.headers.get("x-content-type-options"),"nosniff");assert.match(thumb.headers.get("cache-control"),/^private/);});
    assert.equal((await sharp(thumbBytes).metadata()).format,"webp");
    const duplicate=await call("POST",`/imports/${preview.body.id}/drafts`,selection);
    const refreshed=await call("GET",`/imports/${preview.body.id}`);
    check("repeat import rejected and preview exposes duplicate SKU",()=>{assert.equal(duplicate.status,409);assert.equal(duplicate.body.error,"sku_taken");assert.deepEqual(refreshed.body.candidates[0].duplicate_skus,["STAGE2-SYNTHETIC-1"]);assert.equal(app.store.state.catalogue.products.length,1);});
    check("prices/costs/stock/publication remain unchanged with matching audit events",()=>{
      assert.ok(app.store.state.catalogue.variants.every(v=>v.price_ngn_kobo===null&&v.stock_on_hand===0));assert.equal(app.store.state.catalogue.costs.length,0);
      assert.equal(saved.body.product.publication_status,"never_published");assert.equal(saved.body.public.effective,"not_public");
      for(const action of ["catalogue_product_imported","catalogue_product_edited","catalogue_media_uploaded"]) assert.ok(app.store.state.audit_events.some(a=>a.action===action&&a.resource_id===id));
    });
    const frozen=JSON.stringify(app.store.state.catalogue);
    await app.stop(); app=await startLocal({directory}); await login();
    const reopened=await call("GET",`/products/${id}`);
    check("restart persists draft, edited content, gallery and immutable history",()=>{assert.equal(reopened.status,200);assert.deepEqual(reopened.body.content,saved.body.content);assert.equal(reopened.body.product.current_version,3);assert.equal(JSON.stringify(app.store.state.catalogue),frozen);});
    check("existing test permissions allow editing/media but not review or publication",()=>{assert.equal(reopened.body.permissions.write,true);assert.equal(reopened.body.permissions.review,false);assert.equal(reopened.body.permissions.publish,false);assert.equal(reopened.body.permissions.priceApprove,false);assert.equal(reopened.body.permissions.publicPublish,false);});
    console.log(JSON.stringify({suite:"product-import-stage2-synthetic",checks,failed:0,owner_store_touched:false}));
  } finally {await app.stop();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
