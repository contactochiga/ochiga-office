'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {startLocal}=require('./product-import-local'),{catalogueStoreFor}=require('../src/lead-agents/catalogue-store');
const T=require('../src/lead-agents/ingestion-taxonomy'),E=require('../src/lead-agents/ingestion-evidence');
let checks=0;const pass=s=>{checks++;console.log('PASS '+s);};
async function main(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ingestion-taxonomy-'));let app=await startLocal({directory}),cookies={};
 const login=async()=>{for(const [who,user] of Object.entries(app.identities)){const r=await fetch(app.base+'/api/lead-agents/admin/session/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(user)});assert.equal(r.status,200);cookies[who]=r.headers.get('set-cookie').split(';')[0];}};await login();
 const req=async(route,body,who='importer',raw=false)=>{const r=await fetch(app.base+'/api/lead-agents/admin/catalogue'+route,{method:body===undefined?'GET':'POST',headers:{cookie:cookies[who]||'',origin:app.base,'content-type':raw?'application/octet-stream':'application/json'},body:body===undefined?undefined:raw?body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 try{
 const asset=await fetch(app.base+'/office/catalogue/ingestion-taxonomy.mjs');assert.equal(asset.status,200);assert.match(await asset.text(),/renderBatchTaxonomy/);assert.equal((await fetch(app.base+'/office/catalogue/ingestion-taxonomy.mjs',{method:'POST'})).status,405);pass('batch UI module is served through reviewed GET-only static route');
 const bytes=fs.readFileSync('/Users/ochigaidoko/Downloads/GetOyi_Hardware_Catalogue_V2_Research_Master.xlsx');
 const upload=async who=>(await req('/imports?name=research-master.xlsx&version=2',bytes,who||'importer',true)).data;
 let preview=await upload();const original=preview, id=preview.id,initial=preview.taxonomy_groups;
 assert.equal(preview.total,50);assert.equal(initial.filter(g=>g.kind==='category').length,25);assert.equal(initial.filter(g=>g.kind==='brand').length,21);pass('real workbook: 50 candidates grouped into 25 category paths and 21 manufacturer labels');
 const cat=catalogueStoreFor(app.store),registry=await cat.listCategories();
 assert.equal(registry.length,6);assert.equal((await cat.listBrands()).length,0);assert.equal(preview.counts.ready,0);pass('actual six-category / zero-brand baseline reproduced');
 const post=body=>req(`/imports/${id}/taxonomy`,body);
 const mapping=(g,target)=>({kind:g.kind,source:g.source,context:g.context,revision:g.revision,target_id:target,reason:target===null?'Manufacturer evidence not independently confirmed':''});
 let catGroup=initial.find(g=>g.kind==='category'&&g.unresolved),brandGroup=initial.find(g=>g.source==='Unconfirmed OEM');
 assert.equal((await post({mappings:[mapping(catGroup,registry[0].id)]})).status,400);
 assert.equal((await req(`/imports/${id}/taxonomy`,{confirm_mappings:true,mappings:[mapping(catGroup,registry[0].id)]},'other')).status,404);
 assert.equal((await req(`/imports/${id}/taxonomy`,{confirm_mappings:true,mappings:[mapping(catGroup,registry[0].id)]},'reader')).status,403);
 assert.equal((await req(`/imports/${id}/taxonomy`,{confirm_mappings:true,mappings:[mapping(catGroup,registry[0].id)]},'')).status,401);pass('confirmation, session, catalogue-write and source-owner boundaries enforced');
 assert.equal((await post({confirm_mappings:true,mappings:[mapping(catGroup,'missing')]})).status,400);
 assert.equal((await post({confirm_mappings:true,mappings:[mapping(brandGroup,registry[0].id)]})).data.error,'ingestion_unknown_manufacturer');
 assert.equal((await post({confirm_mappings:true,mappings:[{...mapping(brandGroup,null),reason:''}]})).status,400);pass('inactive/missing targets and false OEM identity rejected; unassignment requires explanation');
 assert.equal((await req('/brands',{name:'Synthetic Brand',slug:'synthetic-brand'})).status,403);pass('importer cannot create brands or grant taxonomy permissions');
 // Dedicated disposable actor only: existing governed taxonomy API, no role changes to owner environment.
 const actor=app.identities.other;const u=app.store.state.admin_users.find(u=>u.email===actor.email);u.permission_scopes=['catalogue.write','catalogue.cost.read','catalogue.publish'];await app.store.persist();await login();
 let b=await req('/brands',{name:'Synthetic reviewed manufacturer',slug:'synthetic-reviewed-manufacturer'},'other');assert.equal(b.status,201,JSON.stringify(b));const brand=b.data.brand;
 assert.ok(app.store.state.audit_events.some(e=>e.action==='catalogue_brand_created'));pass('authorized synthetic staff creates taxonomy through existing audited API');
 // Real manufacturer records are not created; HTTP permission test above uses a clearly synthetic brand.
 // Rehearsal confirms identities remain unassigned until the owner establishes canonical brands.
 const categoryTarget=g=>{const v=g.source.toLowerCase();let slug=v.includes('electrical')?'installation-accessories':v.includes('automation & controls')||v.includes('hubs & ir')||v.includes('iot')?'control-panels-gateways':v.includes('switches & lighting')||v.includes('plugs & relays')?'smart-home-automation':v.includes('network')?'networking-connectivity':v.includes('metering')||v.includes('sensors')||v.includes('environmental')?'sensors-monitoring':'security-access-control';return registry.find(r=>r.slug===slug).id;};
 const mappings=initial.filter(g=>g.unresolved).map(g=>mapping(g,g.kind==='brand'?null:categoryTarget(g)));
 let r=await post({confirm_mappings:true,mappings});assert.equal(r.status,200,JSON.stringify(r));preview=r.data;
 assert.equal(preview.counts.ready,50);assert.equal(preview.counts.taxonomy,0);assert.equal(preview.counts.verification,50);
 assert.ok(preview.candidates.every(c=>c.content.brand_id===null&&c.pricing_classification==='unapproved_source_reference'));
 pass('single reviewed batch resolves recurring groups: 50 draft-ready, zero taxonomy exceptions, 50 nonblocking commercial warnings');
 assert.deepEqual(preview.sheet_reconciliation,original.sheet_reconciliation);assert.equal(preview.sheet_reconciliation.counts.specifications,149);assert.equal(preview.sheet_reconciliation.counts.images,250);assert.equal(preview.sheet_reconciliation.counts.qa,50);
 assert.deepEqual(preview.candidates.map(c=>[c.source_cells,c.specification_evidence,c.supporting_records]),original.candidates.map(c=>[c.source_cells,c.specification_evidence,c.supporting_records]));pass('149 attributes, 250 image requirements, 50 QA records and provenance unchanged');
 assert.equal((await post({confirm_mappings:true,mappings})).status,409);pass('replayed/stale batch revision rejected, no duplicate mapping event');
 const audits=app.store.state.audit_events.filter(e=>e.action===T.ACTION);assert.equal(audits.length,1);assert.equal(audits[0].metadata.mappings.length,mappings.length);
 assert.equal(app.store.state.catalogue.products.length,0);assert.equal(app.store.state.catalogue.prices?.length||0,0);pass('durable audit-only batch, zero product, price, stock or publication mutations');
 let fresh=await upload();assert.equal(fresh.counts.ready,50);assert.equal((await upload('other')).counts.ready,0);pass('future uploads reuse reviewed mappings for the same staff account only');
 await app.stop();app=await startLocal({directory});await login();fresh=(await req(`/imports/${id}`)).data;assert.equal(fresh.counts.ready,50);pass('reviewed mappings survive service restart without parser or source changes');
 // Separately rehearse governed canonical establishment in this disposable database only.
 const canonicalBrands=new Map();
 const sourceNames=initial.filter(g=>g.kind==='brand'&&!g.unassigned_only).map(g=>g.source==='TP-Link Omada'?'TP-Link':g.source);
 // Restart preserves the launcher's intentionally unprivileged identities; re-authorize ONLY disposable test actor.
 const testPublisher=app.store.state.admin_users.find(u=>u.email===app.identities.other.email);testPublisher.permission_scopes=['catalogue.write','catalogue.cost.read','catalogue.publish'];await app.store.persist();await login();
 for(const name of new Set(sourceNames)){
  const created=await req('/brands',{name,slug:name.toLowerCase().replace(/[^a-z0-9]+/g,'-')},'other');assert.equal(created.status,201,JSON.stringify(created));canonicalBrands.set(name,created.data.brand.id);
 }
 assert.equal(canonicalBrands.size,19);fresh=(await req(`/imports/${id}`)).data;
 assert.ok(fresh.candidates.every(c=>!c.content.brand_id));pass('19 canonical manufacturers created only through authorized disposable taxonomy API; prior unassignment is not silently replaced');
 const brandedMappings=fresh.taxonomy_groups.filter(g=>g.kind==='brand'&&!g.unassigned_only).map(g=>mapping(g,canonicalBrands.get(g.source==='TP-Link Omada'?'TP-Link':g.source)));
 r=await post({confirm_mappings:true,mappings:brandedMappings});assert.equal(r.status,200,JSON.stringify(r));
 const last=(await req(`/imports/${id}?page=2`)).data;
 const branded=[...r.data.candidates,...last.candidates];assert.equal(branded.filter(c=>c.content.brand_id).length,38);assert.equal(branded.filter(c=>!c.content.brand_id).length,12);assert.equal(r.data.counts.ready,50);
 assert.equal(branded.find(c=>c.manufacturer==='TP-Link Omada').content.brand_id,canonicalBrands.get('TP-Link'));pass('20 reviewed manufacturer labels map to 19 canonical brands for 38 products; 12 OEM products remain unassigned');
 const another=await upload('other');assert.equal(another.taxonomy_groups.filter(g=>g.kind==='brand'&&g.unresolved).length,1);pass('new actor import resolves established canonical names and TP-Link alias, with only OEM identity pending');
 // Active canonical brand mapping, stale target, unknown OEM and hierarchy in synthetic fixtures.
 const csv=Buffer.from('Product,SKU,Category,Manufacturer\nSynthetic mapped item,SYN-MAP-1,Sensors,Synthetic reviewed manufacturer');
 let syn=(await req('/imports?name=synthetic.csv&version=2',csv,'importer',true)).data;assert.equal(syn.counts.ready,1);assert.equal(syn.candidates[0].content.brand_id,brand.id);pass('existing exact canonical brand resolves automatically');
 const parent={id:'p',name:'Security',slug:'security',status:'active'},child={id:'c',parent_id:'p',name:'Cameras',slug:'cameras',status:'active'};
 assert.equal(E.resolveTaxonomy(' Security > CAMERAS ',[parent,child],'category').id,'c');pass('normalized full canonical hierarchy resolves');
 const ev=(id,target,parents=[])=>({id,metadata:{mappings:[{kind:'category',source_key:'sensors',target_id:target,parents}]}});
 let saved=T.decisions([ev('a','one'),ev('b','two')]);assert.equal(T.resolve('Sensors',registry,'category',saved).status,'ambiguous');
 saved=T.decisions([ev('a','one'),ev('b','two'),ev('c',registry[0].id,['a:0','b:0'])]);assert.equal(T.resolve('Sensors',registry,'category',saved).id,registry[0].id);pass('concurrent conflicting review leaves remain blocked until explicit superseding review');
 assert.equal(T.resolve('Sensors',[],'category',saved).status,'ambiguous');pass('hidden/deleted canonical targets invalidate saved mapping');
 const catNow=catalogueStoreFor(app.store);const oldRead=catNow.ingestionTaxonomyDecisions;catNow.ingestionTaxonomyDecisions=async()=>{throw Error('injected storage unavailable');};assert.equal((await req(`/imports/${id}`)).status,500);catNow.ingestionTaxonomyDecisions=oldRead;pass('mapping-store read failure fails closed');
 const bad={...preview.candidates.find(c=>c.manufacturer==='Unconfirmed OEM').content,brand_id:brand.id};
 r=await req(`/imports/${id}/jobs`,{confirm_drafts_only:true,items:[{id:preview.candidates.find(c=>c.manufacturer==='Unconfirmed OEM').id,content:bad,exceptions_reviewed:true}]});assert.equal(r.data.error,'ingestion_unknown_manufacturer');pass('per-record edited payload cannot bypass OEM unassignment protection');
 const contexts=(await req('/imports?name=contexts.csv&version=2',Buffer.from('Product,SKU,Category,Collection\nSynthetic home,SYN-CTX-1,Generic equipment,Residential\nSynthetic industry,SYN-CTX-2,Generic equipment,Industrial'),'importer',true)).data;
 assert.equal(contexts.taxonomy_groups.filter(g=>g.kind==='category').length,2);
 const oneContext=contexts.taxonomy_groups.find(g=>g.context==='Residential');
 r=await req(`/imports/${contexts.id}/taxonomy`,{confirm_mappings:true,mappings:[mapping(oneContext,registry[0].id)]});assert.equal(r.data.counts.ready,1);assert.equal(r.data.counts.taxonomy,1);pass('same source label in different collections is grouped and persisted separately');
 // Genuine concurrent HTTP mapping decisions retain conflicting heads rather than silently last-write-winning.
 const race=(await req('/imports?name=race.csv&version=2',Buffer.from('Product,SKU,Category\nSynthetic race,SYN-RACE-1,Unmatched race category'),'importer',true)).data;
 const rg=race.taxonomy_groups.find(g=>g.kind==='category'),snapshot=await catNow.ingestionTaxonomyDecisions(app.identities.importer.email);
 let arrivals=0,release;const barrier=new Promise(r=>release=r);const read=catNow.ingestionTaxonomyDecisions.bind(catNow);
 catNow.ingestionTaxonomyDecisions=async actor=>{if(arrivals<2){arrivals++;if(arrivals===2)release();await barrier;return structuredClone(snapshot);}return read(actor);};
 const outcomes=await Promise.all([registry[0].id,registry[1].id].map(target=>req(`/imports/${race.id}/taxonomy`,{confirm_mappings:true,mappings:[mapping(rg,target)]})));catNow.ingestionTaxonomyDecisions=read;
 assert.ok(outcomes.every(r=>r.status===200));const conflict=(await req(`/imports/${race.id}`)).data;assert.equal(conflict.counts.ready,0);assert.equal(conflict.candidates[0].category_match.status,'ambiguous');
 const fixed=await req(`/imports/${race.id}/taxonomy`,{confirm_mappings:true,mappings:[mapping(conflict.taxonomy_groups[0],registry[0].id)]});assert.equal(fixed.data.counts.ready,1);pass('real concurrent HTTP reviews preserve both decisions and require an explicit conflict resolution');
 console.log(JSON.stringify({checks,failed:0,category_paths:25,manufacturer_labels:21,initial_unresolved_category_groups:initial.filter(g=>g.kind==='category'&&g.unresolved).length,initial_matched_category_products:initial.filter(g=>g.kind==='category'&&!g.unresolved).reduce((n,g)=>n+g.count,0),reviewed_mapping_count:mappings.length,ready_after_review:50,products_created:app.store.state.catalogue.products.length}));
 }finally{await app.stop();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
