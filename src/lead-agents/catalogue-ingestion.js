"use strict";
const C=require('./catalogue');
const {normal}=require('./ingestion-evidence');
const T=require('./ingestion-taxonomy');
const {readJsonBody}=require('./http');
const confirmedIdentity=v=>!!normal(v)&&!/(pending|unconfirmed|unknown|tbc|to be confirmed)/i.test(v);
const GROUPS=['ready','missing','taxonomy','duplicate','verification'];
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
async function analyse(cat,extraction,actor=""){
 const saved=T.decisions(actor?await cat.ingestionTaxonomyDecisions(actor):[]);
 const resolveTaxonomy=(value,records,kind,model,context)=>T.resolve(value,records,kind,saved,model,context);
 const [categories,brands,products]=await Promise.all([cat.listCategories(),cat.listBrands(),cat.importIdentityIndex()]);
 const incomingModelKey=c=>(resolveTaxonomy(c.manufacturer,brands,'brand',c.model).id||normal(c.manufacturer))+':'+normal(c.model);
 const skuCounts=new Map(), incomingModels=new Map(), byName=new Map(),byModel=new Map();
 for(const p of products){const n=normal(p.name);if(n){if(!byName.has(n))byName.set(n,[]);byName.get(n).push(p);}if(p.brand_id&&p.model){const k=p.brand_id+':'+normal(p.model);if(!byModel.has(k))byModel.set(k,[]);byModel.get(k).push(p);}}
 for(const c of extraction.candidates){for(const v of c.variants)skuCounts.set(v.sku,(skuCounts.get(v.sku)||0)+1);const k=incomingModelKey(c);if(confirmedIdentity(c.manufacturer)&&confirmedIdentity(c.model))incomingModels.set(k,(incomingModels.get(k)||0)+1);}
 const found=await cat.findImportSkus([...skuCounts.keys()]),bySku=new Map(found.map(v=>[v.sku,v]));
 const candidates=extraction.candidates.map(c=>{
  const category=resolveTaxonomy(c.category,categories,'category','',c.source_references.filter(r=>/collection|category path/i.test(r.label)).map(r=>r.value).join(' ')),brand=resolveTaxonomy(c.manufacturer,brands,'brand',c.model);
  const content={name:c.name,model:c.model,summary:c.summary,description:c.description,category_id:category.id||'',brand_id:brand.id||null,specifications:c.specifications,variants:c.variants,media:[]};
  const missing=[];try{C.validateContent({...content,category_id:categories[0]?.id||''});}catch(e){missing.push(...(e.details||[e.code]));}
  if(!c.category&&!category.id)missing.push('Source category is missing');
  const duplicates=c.variants.filter(v=>skuCounts.get(v.sku)>1||bySku.has(v.sku)).map(v=>v.sku);
  const modelMatches=brand.id&&confirmedIdentity(c.model)?byModel.get(brand.id+':'+normal(c.model))||[]:[];
  const insideModel=confirmedIdentity(c.manufacturer)&&confirmedIdentity(c.model)&&incomingModels.get(incomingModelKey(c))>1;
  const existing=found.filter(v=>c.variants.some(s=>s.sku===v.sku));
  const possible=[...new Map([...(byName.get(normal(c.name))||[]),...modelMatches].map(p=>[p.id,{id:p.id,name:p.name,slug:p.slug}])).values()];
  const taxonomy=!category.id||brand.status==='ambiguous'||(!!c.manufacturer&&!brand.id&&brand.status!=='reviewed_unassigned');
  const specReview=(c.specification_evidence?.unresolved||[]).length>0;
  const groups=[];if(missing.length||specReview)groups.push('missing');if(taxonomy)groups.push('taxonomy');if(duplicates.length||modelMatches.length||insideModel||c.sheet_conflicts?.length)groups.push('duplicate');
  // Commercial exceptions never turn into a selling price, cost, inventory or certification.
  groups.push('verification');if(!groups.some(g=>g!=='verification'))groups.unshift('ready');
  return {...c,content,slug:require('./catalogue-import').slugOf(c.name),category_match:category,brand_match:brand,groups,validation:missing,
   duplicate_skus:duplicates,existing_products:existing,possible_matches:possible,model_matches:modelMatches.map(p=>({id:p.id,name:p.name})),
   warnings:[...c.warnings,...(!c.image_references.length?['Images missing; add them to the draft later.']:[]),...(!c.supplier_references.length?['Supplier information and cost missing.']:[]),'Prices, supplier costs, stock and compatibility remain unverified.'],pricing_classification:'unapproved_source_reference'};
 });
 return {categories,brands,candidates,taxonomy_groups:T.batchGroups(candidates,saved),counts:Object.fromEntries(GROUPS.map(g=>[g,candidates.filter(c=>c.groups.includes(g)).length]))};
}
async function preview(cat,extraction,query=new URLSearchParams(),actor=""){
 const data=await analyse(cat,extraction,actor),group=GROUPS.includes(query.get('group'))?query.get('group'):null;
 const filtered=group?data.candidates.filter(c=>c.groups.includes(group)):data.candidates;
 const page=Math.min(Math.max(1,Number(query.get('page'))||1),Math.max(1,Math.ceil(filtered.length/25)));
 return {...extraction,...data,candidates:filtered.slice((page-1)*25,page*25),version:2,reextract_required:extraction.sheet_processing_version!==1,total:extraction.candidates.length,filtered:filtered.length,page,page_size:25,match_note:'Matches cover the registry (up to 50,000 products). Suggestions never create categories or brands.',warnings:extraction.warnings};
}
async function handle({suffix,req,cat,envelope,id,authContext,storageService,store,send,audit,privateFile,load}){
 const actor=String(authContext.email||authContext.userId||'').trim().toLowerCase();
 if(suffix==='/jobs'&&req.method==='POST'){
  if(envelope.extraction.sheet_processing_version!==1)throw C.httpError(409,'ingestion_reextract_required');
  if(envelope.extraction.version!==2||envelope.extraction.mapping_required)throw C.httpError(400,'import_mapping_required');
  if(envelope.extraction.sheet_reconciliation?.conflicts.length||envelope.extraction.sheet_reconciliation?.unmatched.length)throw C.httpError(409,'ingestion_sheet_resolution_required');
  // Fail closed before creating a manifest if the receipt migration has not been reviewed/applied locally.
  await cat.ingestionReceipts(actor,envelope.source_sha256);
  const body=await readJsonBody(req,2*1024*1024);
  if(body?.confirm_drafts_only!==true||!Array.isArray(body.items)||!body.items.length||body.items.length>1000)throw C.httpError(400,'import_confirmation_required');
  const analysed=await analyse(cat,envelope.extraction,actor),seen=new Set(),skus=new Set(),slugs=new Set(),items=[];
  for(const selected of body.items){
   const c=analysed.candidates.find(c=>c.id===selected.id);if(!c||seen.has(c.id))throw C.httpError(400,'invalid_import_selection');seen.add(c.id);
   const action=selected.action||'create';if(!['create','skip','propose_update'].includes(action))throw C.httpError(400,'invalid_import_action');
   if(action==='skip'){items.push({id:c.id,action,content:{name:c.name},source_rows:c.source_rows});continue;}
   const content=C.validateContent(selected.content||c.content),slug=C.validSlug(selected.slug||c.slug);
   if(T.unknownManufacturer(c.manufacturer)&&content.brand_id)throw C.httpError(400,'ingestion_unknown_manufacturer');
   content.compatibility={facility:false,experience:false,core:false,edge:false,notes:''};
   if(!slug||content.media.length)throw C.httpError(400,'invalid_import_draft');
   if(action!=='skip'){
    const category=await cat.getCategory(content.category_id);if(category?.status!=='active')throw C.httpError(400,'category_not_found');
    if(content.brand_id&&(await cat.getBrand(content.brand_id))?.status!=='active')throw C.httpError(400,'brand_not_found');
   }
   if(action==='create'){
    if(c.groups.includes('duplicate'))throw C.httpError(409,'ingestion_conflict');
    if((c.groups.includes('taxonomy')||c.groups.includes('missing'))&&selected.exceptions_reviewed!==true)throw C.httpError(400,'ingestion_review_required');
    if(slugs.has(slug))throw C.httpError(409,'slug_taken');slugs.add(slug);
    for(const v of content.variants){if(skus.has(v.sku))throw C.httpError(409,'sku_taken');skus.add(v.sku);}
   }
   const targets=[...c.existing_products.map(x=>x.product_id),...c.possible_matches.map(x=>x.id)];
   if(action==='propose_update'&&!targets.includes(selected.target_id))throw C.httpError(400,'ingestion_update_target_required');
   items.push({id:c.id,action,slug,content,target_id:action==='propose_update'?selected.target_id:null,source_rows:c.source_rows,taxonomy_review:{category:c.category_match,brand:c.brand_match},exceptions_reviewed:selected.exceptions_reviewed===true});
  }
  const manifest={...envelope,kind:'product_ingestion_job_v2',source_preview:id,items:canonical(items),extraction:envelope.extraction,created_at:new Date().toISOString()};
  const job=await privateFile(storageService,store,Buffer.from(JSON.stringify(manifest)),'.json',envelope.document_id);
  await audit('catalogue_ingestion_reviewed','office_document',envelope.document_id,{job,source_sha256:envelope.source_sha256,counts:{create:items.filter(x=>x.action==='create').length,skip:items.filter(x=>x.action==='skip').length,proposed_update:items.filter(x=>x.action==='propose_update').length}});
  manifest.job_id=job; send(201,{job,...await status(cat,manifest,actor)});return true;
 }
 return false;
}
async function status(cat,job,actor){
 const receipts=await cat.ingestionReceipts(actor,job.source_sha256), failures=await cat.ingestionFailures(actor,job.job_id);
 const rows=job.items.map(i=>{const receipt=receipts.find(r=>r.candidate_key===i.id);return {id:i.id,name:i.content.name,status:i.action==='skip'?'skipped':i.action==='propose_update'?'proposed_update':receipt?(receipt.review_file===job.job_id?'draft_created':'conflict'):'pending',product_id:receipt?.product_id||i.target_id||null,...(i.action==='propose_update'?{proposal:{slug:i.slug,content:i.content,source_rows:i.source_rows}}:{})};});
 return {reextract_required:job.extraction.sheet_processing_version!==1,total:rows.length,failures,conflicts:rows.filter(r=>r.status==='conflict').length,completed:rows.filter(r=>['draft_created','skipped','proposed_update'].includes(r.status)).length,pending:rows.filter(r=>r.status==='pending').length,results:rows,automatic_updates:false};
}
async function run({cat,job,actor,id,send,audit}){
 if(job.extraction.sheet_processing_version!==1)throw C.httpError(409,'ingestion_reextract_required');
 const results=[],receipts=await cat.ingestionReceipts(actor,job.source_sha256),completed=new Map(receipts.map(r=>[r.candidate_key,r]));
 // Each request processes at most ten products. Checkpoint is the atomic immutable receipt, not browser state.
 for(const item of job.items.filter(x=>x.action==='create')){
  if(results.length>=10)break;
  const prior=completed.get(item.id);if(prior){if(prior.review_file!==id){send(207,{...await status(cat,job,actor),failure:{id:item.id,code:'ingestion_receipt_conflict'},stopped:true});return;}continue;}
  try{const receipt=await cat.createIngestedDraft({actor,source:job.source_sha256,candidate:item.id,review:id,slug:item.slug,content:item.content,categoryId:item.content.category_id,brandId:item.content.brand_id});if(receipt.review_file!==id)throw C.httpError(409,'ingestion_receipt_conflict');results.push({id:item.id,status:'draft_created',product_id:receipt.product_id});}
  catch(error){const code=['sku_taken','slug_taken','conflict','category_not_found','brand_not_found','ingestion_receipt_mismatch','ingestion_receipt_conflict'].includes(error.code)?error.code:'ingestion_save_uncertain';await audit('catalogue_ingestion_stopped','office_document',job.document_id,{job:id,id:item.id,code});send(207,{...await status(cat,job,actor),failure:{id:item.id,code},stopped:true});return;}
 }
 send(200,{...await status(cat,job,actor),stopped:false});
}
module.exports={preview,analyse,handle,status,run,canonical};
