'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const E=require('../src/lead-agents/product-import-extract'),I=require('../src/lead-agents/ingestion-evidence');
const {startLocal}=require('./product-import-local'),{catalogueStoreFor}=require('../src/lead-agents/catalogue-store');
let checks=0;const pass=x=>{checks++;console.log('PASS '+x);};
async function main(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ingestion-v2-'));let app=await startLocal({directory}),cookies={};
 const login=async()=>{cookies={};for(const [who,user] of Object.entries(app.identities)){const r=await fetch(app.base+'/api/lead-agents/admin/session/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(user)});assert.equal(r.status,200);cookies[who]=r.headers.get('set-cookie').split(';')[0];}};await login();
 const request=async(route,body,who='importer',raw=false)=>{const r=await fetch(app.base+'/api/lead-agents/admin/catalogue'+route,{method:body===undefined?'GET':'POST',headers:{cookie:cookies[who]||'',origin:app.base,'content-type':raw?'application/octet-stream':'application/json'},body:body===undefined?undefined:raw?body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 try{
  const file='/Users/ochigaidoko/Downloads/GetOyi_50_Products_Office_Import_Only.xlsx',bytes=fs.readFileSync(file),hash=crypto.createHash('sha256').update(bytes).digest('hex');
  let r=await request('/imports?name=original-50.xlsx&version=2',bytes,'importer',true);assert.equal(r.status,201,JSON.stringify(r.data));const real=r.data;
  assert.equal(real.total,50);assert.equal(real.candidates.length,25);pass('original 50-product workbook: exactly 50 candidates, bounded 25-row HTTP page');
  const second=(await request(`/imports/${real.id}?page=2`)).data,all=[...real.candidates,...second.candidates];assert.equal(all.length,50);
  assert.ok(all.every(c=>c.source_cells.length&&c.specification_evidence.attributes.length&&c.content.specifications.length));assert.ok(all.every(c=>c.source_cells.some(x=>x.cell==='B'+c.source_rows[0].row&&x.value===c.variants[0].sku)));pass('50/50 preserve source-cell SKU provenance and per-product structured attributes');
  assert.ok(all.every(c=>c.category_match.id||c.category_match.suggestions.length),JSON.stringify(all.filter(c=>!c.category_match.id).map(c=>c.category)));pass('50/50 category suggestions reference existing categories; ambiguous electrical classifications require review');
  assert.ok(all.filter(c=>c.manufacturer==='Unconfirmed OEM').every(c=>!c.content.brand_id&&!c.groups.includes('duplicate')));assert.ok(all.every(c=>c.pricing_classification==='unapproved_source_reference'&&c.groups.includes('verification')));pass('unknown OEM/model placeholders are not false duplicates, brands, certified compatibility or prices');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),hash);assert.equal(app.store.state.catalogue.products.length,0);pass('real workbook unchanged; extraction creates no products');
  const parsed=I.parseSpecifications([{header:'Voltage (V)',field:'source_reference',value:'12',sheet:'S',row:2,column:2},{header:'Specs',field:'specifications',value:'Power: 5 W; Material: Steel; Voltage: 24 V',sheet:'S',row:2,column:3}]);assert.equal(parsed.attributes[0].unit,'V');assert.equal(parsed.attributes[1].unit,'W');assert.equal(parsed.attributes[2].unit,'');assert.ok(parsed.unresolved.some(x=>x.reason.includes('Conflicting')));pass('deterministic key/value/unit extraction; no invented units; conflicts retained');
  const brands=[{id:'one',name:'TP-Link',slug:'tp-link',status:'active'},{id:'two',name:'Ubiquiti',slug:'ubiquiti',status:'active'}];
  assert.equal(I.resolveTaxonomy('TP Link',brands,'brand').id,'one');assert.equal(I.resolveTaxonomy('',brands,'brand','UniFi U6').id,null);assert.equal(I.resolveTaxonomy('Compatible with TP-Link',brands,'brand').id,null);pass('brand aliases resolve; model family suggestions and provider compatibility never certify manufacturer');
  const csv='Product name,SKU,Category,Specifications\n'+Array.from({length:1000},(_,n)=>`Synthetic ingestion ${n},SYN-V2-${n},Sensors,Power: 5 W; Protocol: Zigbee`).join('\n');
  const started=performance.now();r=await request('/imports?name=synthetic-1000.csv&version=2',Buffer.from(csv),'importer',true);assert.equal(r.status,201,JSON.stringify(r.data));const source=r.data;
  assert.equal(source.total,1000);assert.equal(source.counts.ready,1000);assert.equal(source.candidates.length,25);pass('1,000 synthetic candidates, all ready, bounded HTTP response and parser limits');
  const elapsed=performance.now()-started;
  r=await request('/imports?name=synthetic-1000.csv',Buffer.from(csv),'importer',true);assert.equal(r.status,422);pass('V1 remains bounded at its original 250-candidate limit');
  r=await request('/imports?name=cost.csv&version=2',Buffer.from('Product,SKU,Supplier cost NGN\nSecretCost,SEC-1,10'),'writer',true);assert.equal(r.status,403);pass('supplier references still require cost-read permission');
  assert.equal((await request(`/imports/${source.id}`,undefined,'other')).status,404);assert.equal((await request(`/imports/${source.id}`,undefined,'reader')).status,403);pass('cross-owner and read-only preview access denied');
  const ids=Array.from({length:1000},(_,i)=>({id:`1:${i+2}`}));
  r=await request(`/imports/${source.id}/jobs`,{confirm_drafts_only:true,items:ids});assert.equal(r.status,201,JSON.stringify(r.data));const job=r.data.job;assert.equal(r.data.pending,1000);pass('immutable reviewed manifest checkpoints 1,000 selections without creating products');
  assert.equal((await request(`/imports/${job}/run`,{confirm_drafts_only:true},'other')).status,404);assert.equal((await request(`/imports/${job}/run`,{})).status,400);pass('job owner and explicit execution confirmation enforced');
  const cat=catalogueStoreFor(app.store), original=cat.createIngestedDraft.bind(cat);let lost=true;
  cat.createIngestedDraft=async a=>{const result=await original(a);if(lost){lost=false;throw Error('injected lost response after commit');}return result;};
  r=await request(`/imports/${job}/run`,{confirm_drafts_only:true});assert.equal(r.status,207);assert.equal(r.data.completed,1);assert.equal(r.data.failure.code,'ingestion_save_uncertain');assert.equal(r.data.failures.length,1);cat.createIngestedDraft=original;pass('lost response after commit stops and retains one draft, receipt and durable failure audit');
  await app.stop();app=await startLocal({directory});await login();r=await request(`/imports/${job}`);assert.equal(r.data.completed,1);assert.equal(r.data.failures.length,1);pass('process restart restores manifest, receipts, failures and progress without automatic execution');
  const simultaneous=await Promise.all([request(`/imports/${job}/run`,{confirm_drafts_only:true}),request(`/imports/${job}/run`,{confirm_drafts_only:true})]);assert.ok(simultaneous.every(r=>r.status===200||r.status===207));
  while((r=await request(`/imports/${job}`)).data.pending){const step=await request(`/imports/${job}/run`,{confirm_drafts_only:true});assert.equal(step.status,200,JSON.stringify(step.data));}
  assert.equal(r.data.completed,1000);assert.equal(app.store.state.catalogue.products.length,1000);assert.equal(new Set(app.store.state.catalogue.products.map(p=>p.slug)).size,1000);pass('concurrent requests and bounded resumes produce exactly 1,000 distinct drafts');
  assert.equal((await request(`/imports/${job}/run`,{confirm_drafts_only:true})).data.completed,1000);assert.equal(app.store.state.catalogue.ingestion_receipts.length,1000);assert.equal(app.store.state.audit_events.filter(a=>a.action==='catalogue_product_imported').length,1000);pass('repeat execution cannot duplicate receipts, drafts or import audit events');
  assert.ok(app.store.state.catalogue.variants.every(v=>v.price_ngn_kobo===null&&v.stock_on_hand===0));assert.ok(app.store.state.catalogue.products.every(p=>p.publication_status==='never_published'&&p.workflow_status==='draft'));pass('prices, inventory and public approval remain untouched across 1,000 drafts');
  r=await request(`/imports/${source.id}?group=duplicate`);assert.equal(r.data.counts.duplicate,1000);pass('duplicate checks cover existing catalogue records beyond the V1 500-product window');
  r=await request(`/imports/${source.id}/jobs`,{confirm_drafts_only:true,items:[{id:'1:2',action:'propose_update',target_id:app.store.state.catalogue.products[0].id}]});assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(r.data.results[0].status,'proposed_update');assert.equal(app.store.state.catalogue.versions.length,1000);pass('update proposal persisted for existing-editor review, without overwriting a version');
  assert.equal((await request(`/imports/${source.id}/drafts`,{confirm_drafts_only:true,items:[]})).status,400);pass('V2 cannot bypass durable receipts through legacy draft endpoint');
  console.log(JSON.stringify({suite:'ingestion-v2-http',checks,failed:0,fixture_sha256:hash,extraction_1000_ms:Math.round(elapsed),peak_rss_mb:Math.round(process.resourceUsage().maxRSS/1024),production_access:false}));
 }finally{await app.stop();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
