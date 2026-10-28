"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {startFeedback}=require("./product-import-feedback-local");
async function main(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"import-feedback-http-"));
  const app=await startFeedback({directory});let checks=0;
  const pass=(text,fn)=>{fn();checks++;console.log(`PASS ${text}`);};
  try{
    const login=await fetch(`${app.base}/api/lead-agents/admin/session/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(app.identities.importer)});
    assert.equal(login.status,200);const cookie=login.headers.get("set-cookie").split(";")[0];
    const call=async(method,route,body,raw=false,auth=cookie)=>{
      const r=await fetch(`${app.base}/api/lead-agents/admin/catalogue${route}`,{method,headers:{cookie:auth,origin:app.base,"content-type":raw?"application/octet-stream":"application/json"},body:body===undefined?undefined:raw?body:JSON.stringify(body)});
      return {status:r.status,body:await r.json()};
    };
    const preview=await call("POST","/imports?name=synthetic-feedback.csv",Buffer.from("Product name,SKU,Category\nSYNTHETIC Feedback HTTP,FB-HTTP-1,Smart Home & Automation"),true);
    assert.equal(preview.status,201);const c=preview.body.candidates[0],route=`/imports/${preview.body.id}/drafts`;
    const body={confirm_drafts_only:true,items:[{id:c.id,slug:c.slug,content:c.content}]};
    for(const [field,value,label] of [["category_id","","missing category"],["name","","missing name"],["variants",[{sku:"",name:"Test",options:{}}],"missing SKU"]]){
      const invalid=structuredClone(body);invalid.items[0].content[field]=value;
      const result=await call("POST",route,invalid);
      pass(`${label}: HTTP 400 with validation details and no product`,()=>{assert.equal(result.status,400);assert.equal(result.body.error,"invalid_catalogue_input");assert.ok(result.body.details.length);assert.equal(app.store.state.catalogue.products.length,0);});
    }
    const expired=await call("POST",route,body,false,"lead_agents_admin=expired-synthetic-session");
    pass("invalid/expired session: HTTP 401, no product",()=>{assert.equal(expired.status,401);assert.equal(app.store.state.catalogue.products.length,0);});
    fs.writeFileSync(path.join(directory,"fault.json"),JSON.stringify({mode:"server-error"}));
    const failed=await call("POST",route,body);
    pass("injected server error: HTTP 500, no product",()=>{assert.equal(failed.status,500);assert.equal(app.store.state.catalogue.products.length,0);});
    fs.writeFileSync(path.join(directory,"fault.json"),JSON.stringify({mode:"delay"}));
    const concurrent=await Promise.all([call("POST",route,body),call("POST",route,body)]);
    pass("concurrent duplicate submissions create exactly one draft",()=>{assert.equal(concurrent.filter(r=>r.status===201).length,1);assert.equal(app.store.state.catalogue.products.length,1);assert.ok(concurrent.some(r=>[409,207].includes(r.status)));});
    fs.writeFileSync(path.join(directory,"fault.json"),JSON.stringify({mode:"none"}));
    const id=concurrent.find(r=>r.status===201).body.results[0].product_id;
    const detail=await call("GET",`/products/${id}`);
    pass("successful save and reopen returns canonical draft with null price",()=>{assert.equal(detail.status,200);assert.equal(detail.body.content.name,c.name);assert.equal(detail.body.product.workflow_status,"draft");assert.equal(detail.body.variants[0].price_ngn_kobo,null);assert.equal(detail.body.product.publication_status,"never_published");});
    const duplicate=await call("POST",route,body);
    pass("existing SKU returns HTTP 409 and cannot create another draft",()=>{assert.equal(duplicate.status,409);assert.equal(duplicate.body.error,"sku_taken");assert.equal(app.store.state.catalogue.products.length,1);});
    const refresh=await call("GET",`/imports/${preview.body.id}`);
    pass("preview links exact existing SKU to saved product",()=>assert.deepEqual(refresh.body.candidates[0].existing_products,[{sku:"FB-HTTP-1",product_id:id}]));
    pass("only one successful import audit; no public release events",()=>{assert.equal(app.store.state.audit_events.filter(a=>a.action==="catalogue_product_imported").length,1);assert.equal(app.store.state.catalogue.events.length,0);});
    console.log(JSON.stringify({suite:"product-import-feedback-http",checks,failed:0}));
  }finally{await app.stop();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
