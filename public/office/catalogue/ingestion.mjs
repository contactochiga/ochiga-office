import { renderBatchTaxonomy } from './ingestion-taxonomy.mjs';
import { renderColumnMapping } from './import.mjs';
// V2 is an additive review surface over V1 extraction/storage and the existing catalogue editor.
const API='/api/lead-agents/admin/catalogue/imports';
export async function renderIngestion(host,token,ui){
 const {el,escapeHtml:e}=ui;
 if(token!==ui.state.renderToken)return;host.innerHTML='';
 if(!ui.hasPermission('catalogue.write')){host.appendChild(ui.errorPanel('Catalogue write permission is required.'));return;}
 const root=el(`<section class="cat-ingestion"><style>
 .cat-ingestion{font-size:13px;min-width:0}
 .cat-ingestion [hidden]{display:none!important}
 .cat-ingestion h2{font-size:15px;margin:0}
 .cat-ingestion h3{font-size:14px;margin:0 0 4px}
 .cat-ingestion h4{font-size:14px;margin:0 0 12px}
 .cat-ingestion p{color:var(--text-secondary);line-height:1.5;margin:6px 0 12px}
 .cat-ingestion label{display:block;margin:10px 0}
 .cat-ingestion input:not([type=checkbox]),.cat-ingestion select,.cat-ingestion textarea{width:100%;min-width:0;background:var(--black);color:var(--text-primary);border:1px solid var(--line-strong);border-radius:5px;padding:8px;font:inherit}
 .cat-ingestion textarea{min-height:72px;resize:vertical}
 .cat-ingestion .cat-btn{height:28px;padding:0 10px;font-size:12px;border-radius:5px;font-weight:500}
 .cat-ingestion .ing-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
 .cat-ingestion .ing-upload{border-bottom:1px solid var(--line);padding:12px 0;margin-bottom:12px}
 .cat-ingestion summary{cursor:pointer;font-size:12.5px}
 .cat-ingestion .ing-upload-fields{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:12px;padding:8px 0}
 .cat-ingestion .ing-upload-fields label{margin:0}
 .cat-ingestion .ing-upload-fields input{margin-top:6px}
 .cat-ingestion .ing-checkpoint{max-width:650px;padding:8px 0}
 .cat-ingestion .ing-checkpoint input{margin-bottom:8px}
 .cat-ingestion .ing-primary-tabs{overflow-x:auto;white-space:nowrap;margin-bottom:16px}
 .cat-ingestion .ing-primary-tabs .crm-tab{font-size:12.5px;flex-shrink:0}
 .cat-ingestion .ing-tab-count{font-size:11px;color:var(--text-tertiary);margin-left:5px}
 .cat-ingestion .ing-section-head{display:flex;align-items:start;justify-content:space-between;gap:12px;margin:12px 0}
 .cat-ingestion .ing-section-head p{margin:0}
 .cat-ingestion .ing-split{display:grid;grid-template-columns:minmax(210px,32%) minmax(0,1fr);border-top:1px solid var(--line);border-bottom:1px solid var(--line);min-height:300px}
 .cat-ingestion .ing-group-list{max-height:400px;overflow:auto;border-right:1px solid var(--line);min-width:0}
 .cat-ingestion .ing-group{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid var(--line);background:none;color:var(--text-primary);padding:12px;cursor:pointer;line-height:1.5;overflow-wrap:anywhere}
 .cat-ingestion .ing-group small{display:block;color:var(--text-tertiary);font-size:11.5px}
 .cat-ingestion .ing-group[aria-pressed=true]{background:rgba(255,255,255,.035);box-shadow:inset 2px 0 var(--red)}
 .cat-ingestion .ing-detail{padding:20px;min-width:0;overflow-wrap:anywhere}
 .cat-ingestion .ing-mapping-footer{padding:12px 0}
 .cat-ingestion .ing-muted{font-size:11.5px;color:var(--text-tertiary)}
 .cat-ingestion .ing-empty{padding:24px 0}
 .cat-ingestion .ing-check{display:flex;gap:8px;align-items:flex-start;line-height:1.5;font-size:12px}
 .cat-ingestion .ing-check input{margin-top:3px;flex-shrink:0}
 .cat-ingestion [data-summary]{padding:10px 0;gap:6px}
 .cat-ingestion [data-summary] button{background:none;border:0;border-bottom:1px solid transparent;border-radius:0;padding:4px 8px;height:auto;color:var(--text-secondary);font-weight:400}
 .cat-ingestion [data-summary] button[aria-pressed=true]{border-color:var(--red);color:var(--white)}
 .cat-ingestion .ing-review{border-top:1px solid var(--line);margin-top:16px;padding-top:12px}
 .cat-ingestion .ing-product-split{display:grid;grid-template-columns:minmax(190px,28%) minmax(0,1fr);border-block:1px solid var(--line);margin:12px 0}
 .cat-ingestion article{min-width:0;padding:16px}
 .cat-ingestion article>details{margin:12px 0}
 .cat-ingestion .ing-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
 .cat-ingestion .ing-spec{display:grid;grid-template-columns:1fr 2fr 1fr auto;gap:8px;margin:6px 0}
 .cat-ingestion pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11.5px;max-height:360px;overflow:auto}
 .cat-ingestion [role=status],.cat-ingestion [role=alert]{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;margin:8px 0}
 .cat-ingestion [role=alert]{color:#ffb9b9}
 .cat-ingestion .ing-save{border-top:1px solid var(--line);padding:16px 0}
 .cat-ingestion progress{width:100%;height:4px;accent-color:var(--red)}
 .cat-ingestion .ing-loader{padding:12px 0;display:flex;align-items:center;gap:12px}
 .cat-ingestion .ing-spinner{width:18px;height:18px;flex-shrink:0;border:1px solid var(--line-strong);border-top:2px solid var(--red);border-radius:50%;animation:ing-spin 1.1s linear infinite}
 .cat-ingestion .ing-loader[data-phase=done] .ing-stage-list{display:none}
 .cat-ingestion .ing-loader[data-phase=done] .ing-spinner,.cat-ingestion .ing-loader[data-phase=error] .ing-spinner{animation:none;border-color:var(--line-strong)}
 .cat-ingestion .ing-stage-list{display:flex;gap:14px;flex-wrap:wrap;padding:0;list-style:none;font-size:11.5px;color:var(--text-tertiary);margin:4px 0}
 .cat-ingestion .ing-stage-list [data-active=true]{color:var(--text-primary)}
 @keyframes ing-spin{to{transform:rotate(360deg)}}
 @media(prefers-reduced-motion:reduce){.cat-ingestion .ing-spinner{animation:none}
 .cat-ingestion *{scroll-behavior:auto;transition:none!important}}
 @media(max-width:760px){.cat-ingestion .ing-split,.cat-ingestion .ing-product-split{grid-template-columns:1fr}
 .cat-ingestion .ing-group-list{max-height:190px;border-right:0;border-bottom:1px solid var(--line)}
 .cat-ingestion .ing-detail,.cat-ingestion article{padding:14px 0}
 .cat-ingestion .ing-grid,.cat-ingestion .ing-spec,.cat-ingestion .ing-upload-fields{grid-template-columns:1fr}
 .cat-ingestion .ing-section-head{flex-direction:column}
 .cat-ingestion .ing-stage-list{gap:8px}
 .cat-ingestion .ing-primary-tabs .crm-tab{margin-right:10px}
 .cat-ingestion .ing-grid>*{min-width:0}}
 </style><div class="ing-section-head"><h2>Catalogue ingestion <span class="ing-muted">V2 · Drafts only</span></h2><a href="#/catalogue" class="ing-muted">Back to products</a></div>
 <details class="ing-upload" data-upload-panel open><summary>Import catalogue <span class="ing-muted" data-file-label>· XLSX / CSV · up to 1,000 products</span></summary><div class="ing-upload-fields"><label>Choose file · maximum 5 MB<input type="file" accept=".xlsx,.csv" data-file></label><div class="ing-actions"><button type="button" class="cat-btn" data-upload>Extract & review</button><button type="button" class="cat-btn" data-legacy>V1 import</button></div></div></details>
 <details class="ing-checkpoint"><summary>Resume a saved review or draft checkpoint</summary><label>Checkpoint reference<input data-checkpoint placeholder="catalogue_import_….json"></label><button type="button" class="cat-btn" data-resume>Open last checkpoint</button></details>
 <div class="ing-loader" data-loader hidden><span class="ing-spinner" aria-hidden="true"></span><div><div role="progressbar" aria-label="Catalogue extraction" aria-valuetext="Processing; progress not reported" data-upload-progress></div><ol class="ing-stage-list"><li data-stage="reading">Reading file</li><li data-stage="mapping">Mapping worksheets</li><li data-stage="linking">Linking specifications</li><li data-stage="preparing">Preparing review</li></ol><span class="ing-muted" data-loading-note></span></div></div>
 <div role="status" aria-live="polite" data-status></div><div role="alert" data-error></div>
 <div class="crm-tabs ing-primary-tabs" role="tablist" aria-label="Catalogue ingestion review">${[['category','Product category mapping'],['brand','Brand mapping'],['worksheets','Worksheet preview'],['summary','Summary']].map(([key,label])=>`<button type="button" class="crm-tab" role="tab" data-primary="${key}" id="ing-tab-${key}" aria-controls="ing-pane-${key}" aria-selected="${key==='category'}" tabindex="${key==='category'?0:-1}">${label}<span class="ing-tab-count" data-tab-count="${key}"></span></button>`).join('')}</div>
 <section role="tabpanel" id="ing-pane-category" aria-labelledby="ing-tab-category" data-pane="category"><div data-category><p class="ing-empty">Upload a catalogue or open a checkpoint to review category mappings.</p></div></section>
 <section role="tabpanel" id="ing-pane-brand" aria-labelledby="ing-tab-brand" data-pane="brand" hidden><div data-brand><p class="ing-empty">Manufacturer groups will appear after extraction.</p></div></section>
 <section role="tabpanel" id="ing-pane-worksheets" aria-labelledby="ing-tab-worksheets" data-pane="worksheets" hidden><div data-sheets-summary></div><div data-column-mapping></div></section>
 <section role="tabpanel" id="ing-pane-summary" aria-labelledby="ing-tab-summary" data-pane="summary" hidden><div data-compact-summary><p class="ing-empty">Review counts will appear after extraction.</p></div><button type="button" class="cat-btn" data-open-review>Review products & select drafts</button></section>
 <details class="ing-review" data-full-review hidden><summary>Product review & draft selection <span data-review-count></span></summary><p class="ing-muted">Review full fields, specifications and source evidence here from any tab. No products are saved until you select and confirm.</p><div data-summary class="ing-actions"></div><div data-review></div>
 <div class="ing-save"><div class="ing-actions"><button type="button" class="cat-btn" data-ready>Select all ready records</button><button type="button" class="cat-btn" data-page>Select this page for review</button><button type="button" class="cat-btn" data-ack>Mark selected exceptions reviewed</button><button type="button" class="cat-btn" data-clear>Clear selection</button><span data-selected>0 selected</span></div>
 <label class="ing-check"><input type="checkbox" data-confirm> I reviewed these selections and exceptions. Create drafts only; keep prices, supplier costs, inventory and public listings unchanged.</label>
 <div class="ing-actions"><button type="button" class="cat-btn cat-btn-primary" data-start>Create selected drafts / save proposals</button><button type="button" class="cat-btn" data-continue disabled>Resume checkpoint</button><button type="button" class="cat-btn" data-pause disabled>Pause after current batch</button></div><progress max="1" value="0" aria-label="Completed import items" data-draft-progress></progress><div data-outcome role="status" aria-live="polite"></div></div></details></section>`);
 host.appendChild(root);const q=s=>root.querySelector(s),selection=new Map();let preview=null,previewId=null,group='',page=1,job=null,busy=false,paused=false,activeTab='category',activeProduct=null;const mappingDrafts=new Map();
 const showTab=key=>{activeTab=key;root.querySelectorAll('[data-primary]').forEach(n=>{const selected=n.dataset.primary===key;n.classList.toggle('active',selected);n.setAttribute('aria-selected',String(selected));n.tabIndex=selected?0:-1;});root.querySelectorAll('[data-pane]').forEach(n=>n.hidden=n.dataset.pane!==key);};
 root.querySelectorAll('[data-primary]').forEach(button=>{button.onclick=()=>showTab(button.dataset.primary);button.onkeydown=event=>{const tabs=[...root.querySelectorAll('[data-primary]')],index=tabs.indexOf(button);let next;if(event.key==='ArrowRight')next=(index+1)%tabs.length;if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;if(event.key==='Home')next=0;if(event.key==='End')next=tabs.length-1;if(next!==undefined){event.preventDefault();tabs[next].focus();showTab(tabs[next].dataset.primary);}};});showTab(activeTab);
 const openReview=()=>{q('[data-full-review]').open=true;q('[data-full-review] > summary').focus();};q('[data-open-review]').onclick=openReview;
 const loading=phase=>{q('[data-loader]').hidden=false;q('[data-loader]').dataset.phase=phase;const labels={reading:'Reading file',processing:'Processing workbook',preparing:'Preparing review',done:'Extraction complete',error:'Extraction failed'};q('[data-upload-progress]').textContent=labels[phase];if(phase==='done')q('[data-upload-progress]').setAttribute('aria-valuenow','100');else q('[data-upload-progress]').removeAttribute('aria-valuenow');q('[data-upload-progress]').setAttribute('aria-valuetext',labels[phase]+(phase==='processing'?'; progress not reported':''));q('[data-loading-note]').textContent=phase==='processing'?'Mapping worksheets and linking evidence on the server. Indeterminate — stage progress is not reported.':phase==='error'?'Review the error below, then retry with the same file or choose another.':phase==='done'?'Ready for staff review. No products created.':'';root.querySelectorAll('[data-stage]').forEach(n=>n.dataset.active=String(n.dataset.stage===phase||(phase==='processing'&&['mapping','linking'].includes(n.dataset.stage))));q('[data-upload]').textContent=phase==='error'?'Retry extraction':'Extract & review';};
 const mappingErrors={unauthorized:'Your Office session has expired. Sign in again, then reopen the saved checkpoint or retry the file.',forbidden:'Your account does not have permission for this operation. Your saved review is unchanged.',invalid_import_file:'This file could not be read as an XLSX workbook or CSV. Check the file and try again.',import_file_size:'The file exceeds the 5 MB limit. Choose a smaller file.',unsupported_import_format:'Choose an XLSX workbook or CSV file.',ingestion_mapping_changed:'These mappings changed in another review. Refresh registry & matches, then review again.',ingestion_mapping_target_inactive:'Choose an active canonical category or brand. Refresh the registry if it changed.',ingestion_unassigned_reason_required:'Enter a reason of at least eight characters for each manufacturer left unassigned.',ingestion_unknown_manufacturer:'An unknown OEM or compatibility statement cannot be assigned as a manufacturer. Keep the brand unassigned.',ingestion_mapping_save_unconfirmed:'Mapping save was not confirmed. Refresh registry & matches before retrying.'};
 const note=t=>{q('[data-status]').textContent=t;},error=x=>{q('[data-error]').textContent=x?.data?.details?.join('; ')||mappingErrors[x?.data?.error||x?.message]||x?.data?.error||x?.message||String(x);};
 const lock=value=>{busy=value;root.setAttribute('aria-busy',String(value));root.querySelectorAll('button,input,select,textarea').forEach(n=>{n.disabled=value||n.hasAttribute('data-mapping-locked');});q('[data-pause]').disabled=!value;q('[data-continue]').disabled=value||!job||preview?.reextract_required;q('[data-start]').disabled=value||!preview||preview?.reextract_required||preview?.mapping_required||!!preview?.sheet_reconciliation?.counts.conflicts||!!preview?.sheet_reconciliation?.counts.unmatched;q('[data-ready]').disabled=value||!preview;q('[data-clear]').disabled=value||!preview;q('[data-page]').disabled=value||!preview;q('[data-ack]').disabled=value||!preview;if(q('[data-prev]'))q('[data-prev]').disabled=value||page<=1;if(q('[data-next]'))q('[data-next]').disabled=value||page*25>=preview.filtered;};
 const count=()=>q('[data-selected]').textContent=`${selection.size} selected across pages`;
 q('[data-legacy]').onclick=()=>ui.navigate('catalogue/import');
 function remember(){q('[data-checkpoint]').value=job||previewId||'';localStorage.setItem('office-ingestion-v2-checkpoint',JSON.stringify({preview:previewId,job}));}
 async function loadPage(p=1,g=group){const data=await ui.api(`${API}/${previewId}?page=${p}&group=${g}`);if(token!==ui.state.renderToken)return;preview=data;page=data.page;group=g;draw();}
 function draw(){
  const stats=preview.sheet_reconciliation?.counts;
  const roles={product_master:'Product master',specifications:'Specifications',pricing:'Pricing',inventory:'Inventory',images:'Images / requirements',qa:'Verification / QA',metadata:'Instructions / metadata',unknown:'Unknown / ambiguous'};
  q('[data-full-review]').hidden=false;q('[data-review-count]').textContent=`· ${preview.total} products`;
  for(const kind of ['category','brand'])q(`[data-tab-count="${kind}"]`).textContent=' · '+String((preview.taxonomy_groups||[]).filter(g=>g.kind===kind&&g.unresolved).length);
  q('[data-tab-count="worksheets"]').textContent=' · '+String(preview.sheet_roles?.length||0);q('[data-tab-count="summary"]').textContent=' · '+String(preview.total);
  q('[data-sheets-summary]').innerHTML=preview.reextract_required?'<p role="alert">This saved preview predates the worksheet-role correction. Re-upload the workbook; records and receipts are retained.</p>':stats?`<div class="ing-section-head"><div><h3>Worksheet preview</h3><p>${stats.specifications} specifications · ${stats.images} image requirements · ${stats.qa} QA records</p></div><button type="button" class="cat-btn" data-sheet-review>Open product review</button></div><div class="ing-split"><div class="ing-group-list" data-sheet-list></div><div class="ing-detail" data-sheet-detail></div></div><p class="ing-muted">${stats.unmatched} unmatched rows · ${stats.conflicts} conflicts. Image requirements are not uploaded files; source prices, costs and stock remain unapproved.</p>`:'';
  if(stats&&!preview.reextract_required){const selectSheet=index=>{const r=preview.sheet_roles[index];q('[data-sheet-detail]').innerHTML=`<h4>${e(r.sheet)}</h4><p>${e(roles[r.role])} · ${r.rows} rows ${r.excluded?'· excluded':''}</p><p>${e(r.reason)}</p><p class="ing-muted">Original row and cell evidence remains available in product review. Use the worksheet mapping control below to resolve roles or headings.</p>`;q('[data-sheet-list]').querySelectorAll('button').forEach((n,i)=>n.setAttribute('aria-pressed',String(i===index)));};preview.sheet_roles.forEach((r,index)=>{const b=el(`<button type="button" class="ing-group" aria-pressed="false">${e(r.sheet)}<small>${e(roles[r.role])} · ${r.rows} rows</small></button>`);b.onclick=()=>selectSheet(index);q('[data-sheet-list]').appendChild(b);});selectSheet(0);q('[data-sheet-review]').onclick=openReview;}
  q('[data-compact-summary]').innerHTML=`<div class="ing-section-head"><div><h3>${preview.total} product candidates</h3><p>${preview.counts.ready} ready for drafts · ${preview.counts.taxonomy} category / brand review · ${preview.counts.missing} required-field / specification review · ${preview.counts.duplicate} duplicate / conflict</p></div></div><p>${stats?.specifications||0} linked specifications · ${stats?.images||0} image requirements · ${stats?.qa||0} QA records</p><p class="ing-muted">${preview.counts.verification} products retain supplier, price or image verification warnings. These do not approve commercial information or prevent otherwise valid drafts.</p>`;
  q('[data-summary]').innerHTML=['all','ready','missing','taxonomy','duplicate','verification'].map(g=>`<button type="button" class="cat-btn" data-group="${g}" aria-pressed="${(group||'all')===g}">${e({all:'All',ready:'Ready for drafts',missing:'Missing / specification review',taxonomy:'Category / brand review',duplicate:'Duplicate / conflict',verification:'Supplier / price verification'}[g])} · ${g==='all'?preview.total:preview.counts[g]}</button>`).join('');
  q('[data-summary]').querySelectorAll('button').forEach(b=>b.onclick=async()=>{if(busy)return;lock(true);try{await loadPage(1,b.dataset.group==='all'?'':b.dataset.group);}catch(x){error(x);}finally{lock(false);}});
  const refreshTaxonomy=async body=>{
   if(busy)return;lock(true);q('[data-error]').textContent='';
   try{
    if(body){if(!body.confirm_mappings||!body.mappings.length)throw Error('Select batch destinations and confirm the mappings first.');await ui.api(`${API}/${previewId}/taxonomy`,{method:'POST',body});}
    if(body)for(const m of body.mappings){const g=preview.taxonomy_groups.find(g=>g.kind===m.kind&&g.source===m.source&&g.context===m.context);if(g)mappingDrafts.delete(g.key);}selection.clear();job=null;q('[data-confirm]').checked=false;remember();await loadPage(1,'');
    note('Mappings refreshed. Select ready products when you are ready to review draft creation. No products were created.');
   }catch(x){error(x);note('Mapping outcome not confirmed. Refresh registry & matches before retrying; existing audit decisions are retained.');}finally{lock(false);}
  };
  for(const kind of ['category','brand'])renderBatchTaxonomy(q(`[data-${kind}]`),preview,ui,refreshTaxonomy,()=>refreshTaxonomy(),{kind,drafts:mappingDrafts,onReview:openReview});
  q('[data-review]').innerHTML='';
  q('[data-column-mapping]').innerHTML='';
  renderColumnMapping(q('[data-column-mapping]'),preview,ui,async mapping=>{
   if(busy)return;lock(true);note('Checking revised mapping. No products are being created.');
   try{const data=await ui.api(`${API}/${previewId}/mapping`,{method:'POST',body:{mapping}});preview=data;previewId=data.id;job=null;page=1;group='';selection.clear();q('[data-confirm]').checked=false;remember();draw();note(data.mapping_required?'Review the detected worksheet headings and rejection reasons.':`${data.total} candidates detected from the revised mapping.`);}catch(x){error(x);}finally{lock(false);}
  });
  if(preview.mapping_required){showTab('worksheets');note('Ambiguous source table. Review worksheet headings and edit the mapping below.');return;}
  const field=(key,label,value)=>`<label>${e(label)}<input data-field="${key}" value="${e(value||'')}"></label>`;
  const options=(rows,value)=>`<option value="">Choose / unconfirmed</option>`+rows.filter(r=>r.status==='active').map(r=>`<option value="${e(r.id)}" ${r.id===value?'selected':''}>${e(r.name)}</option>`).join('');
  const productSplit=el('<div class="ing-product-split"><div class="ing-group-list" data-product-list role="group" aria-label="Products to review"></div><div data-product-details></div></div>');q('[data-review]').appendChild(productSplit);
  if(!preview.candidates.some(c=>c.id===activeProduct))activeProduct=preview.candidates[0]?.id;
  const selectProduct=id=>{activeProduct=id;productSplit.querySelectorAll('[data-product-id]').forEach(n=>n.setAttribute('aria-pressed',String(n.dataset.productId===id)));productSplit.querySelectorAll('article').forEach(n=>n.hidden=n.dataset.productDetail!==id);};
  for(const c of preview.candidates){
   const saved=selection.get(c.id),content=structuredClone(saved?.content||c.content),slug=saved?.slug||c.slug;
   const matches=[...new Map([...c.existing_products.map(p=>({id:p.product_id,name:p.sku})),...c.possible_matches].map(p=>[p.id,p])).values()];
   const card=el(`<article data-product-detail="${e(c.id)}"><label><input type="checkbox" data-select ${saved?'checked':''}> <strong>${e(c.name||'Unnamed product')}</strong></label><p>${e(c.source_rows.map(s=>`${s.sheet} row ${s.row}`).join('; '))} · ${e(c.groups.join(' · '))}</p>
    <p>${e(c.category_match.reason)}<br>${e(c.brand_match.reason)}</p><p>${e(c.warnings.join(' '))}</p>
    <div class="ing-grid"><label>Action<select data-action><option value="create">Create draft</option><option value="skip">Skip</option><option value="propose_update">Propose update — existing editor review required</option></select></label><label>Existing target<select data-target><option value="">None</option>${matches.map(p=>`<option value="${e(p.id)}">${e(p.name||p.id)}</option>`).join('')}</select></label></div>
    ${matches.map(p=>`<a href="#/catalogue/products/${e(p.id)}">Open existing product · ${e(p.name||p.id)}</a>`).join('<br>')}
    <details><summary>Edit fields, variants and attributes</summary><div class="ing-grid">${field('name','Product name',content.name)}${field('slug','Slug',slug)}<label>Category · ${e(c.category)}<select data-field="category_id">${options(preview.categories,content.category_id)}</select></label><label>Brand · source ${e(c.manufacturer||'not provided')}<select data-field="brand_id">${options(preview.brands,content.brand_id)}</select></label>${field('model','Model',content.model)}${field('summary','Summary',content.summary)}<label>Description<textarea data-field="description">${e(content.description)}</textarea></label></div>
    <p>${e([...c.category_match.suggestions,...c.brand_match.suggestions].map(s=>s.name+': '+s.reason).join('; '))}</p><h4>Specifications · units require source evidence</h4><div data-specs></div><button type="button" class="cat-btn" data-add-spec>Add attribute</button><h4>Variants & SKUs</h4><div data-variants></div></details>
    <details><summary>Original cells, references and parsing evidence</summary><pre>${e(JSON.stringify({cells:c.source_cells,specifications:c.specification_evidence,retail:c.retail_references,supplier:c.supplier_references,supporting:c.supporting_records,conflicts:c.sheet_conflicts},null,2))}</pre></details>
    <label><input type="checkbox" data-reviewed ${saved?.exceptions_reviewed?'checked':''}> I reviewed the taxonomy and specification exceptions; unresolved commercial information stays unverified.</label></article>`);
   card.querySelector('[data-action]').value=saved?.action||'create';card.querySelector('[data-target]').value=saved?.target_id||'';
   function rows(kind,values){const target=card.querySelector(`[data-${kind}]`);const keys=kind==='specs'?['key','value','unit']:['sku','name'];
    function add(value={}){const row=el(`<div class="ing-spec">${keys.map(k=>`<label>${e(k)}<input data-part="${k}" value="${e(value[k]||'')}"></label>`).join('')}${kind==='specs'?'<button type="button" class="cat-btn" data-remove>Remove</button>':''}</div>`);row._options=value.options||{};if(kind==='specs')row.querySelector('button').onclick=()=>{row.remove();sync();};target.appendChild(row);}
    values.forEach(add);if(kind==='specs')card.querySelector('[data-add-spec]').onclick=()=>{add();sync();};
   }rows('specs',content.specifications);rows('variants',content.variants);
   function sync(){if(!card.querySelector('[data-select]').checked){selection.delete(c.id);count();return;}const fields=Object.fromEntries([...card.querySelectorAll('[data-field]')].map(n=>[n.dataset.field,n.value]));
    const specs=[...card.querySelectorAll('[data-specs] .ing-spec')].map(r=>Object.fromEntries([...r.querySelectorAll('[data-part]')].map(n=>[n.dataset.part,n.value])));
    const variants=[...card.querySelectorAll('[data-variants] .ing-spec')].map(r=>({...Object.fromEntries([...r.querySelectorAll('[data-part]')].map(n=>[n.dataset.part,n.value])),options:r._options}));
    selection.set(c.id,{id:c.id,action:card.querySelector('[data-action]').value,target_id:card.querySelector('[data-target]').value||null,exceptions_reviewed:card.querySelector('[data-reviewed]').checked,slug:fields.slug,content:{...content,...fields,brand_id:fields.brand_id||null,specifications:specs,variants}});count();
   }card.oninput=sync;card.onchange=sync;productSplit.querySelector('[data-product-details]').appendChild(card);const productButton=el(`<button type="button" class="ing-group" data-product-id="${e(c.id)}" aria-pressed="false">${e(c.name)}<small>${e(c.variants.map(v=>v.sku).join(', '))} · ${e(c.groups.join(' · '))}</small></button>`);productButton.onclick=()=>selectProduct(c.id);productSplit.querySelector('[data-product-list]').appendChild(productButton);
  }
  selectProduct(activeProduct);if(!preview.candidates.length)q('[data-review]').appendChild(el('<p class="ing-empty">No products in this review group.</p>'));
  const nav=el(`<div class="ing-actions"><button type="button" class="cat-btn" data-prev>Previous</button><span>Page ${page} / ${Math.max(1,Math.ceil(preview.filtered/25))} · ${preview.total} candidates</span><button type="button" class="cat-btn" data-next>Next</button></div>`);
  nav.querySelector('[data-prev]').disabled=page<=1;nav.querySelector('[data-next]').disabled=page*25>=preview.filtered;
  for(const [selector,next] of [['[data-prev]',page-1],['[data-next]',page+1]])nav.querySelector(selector).onclick=async()=>{if(busy)return;lock(true);try{await loadPage(next);}catch(x){error(x);}finally{lock(false);}};
  q('[data-review]').appendChild(nav);count();
 }
 function outcome(data){q('[data-draft-progress]').max=data.total||1;q('[data-draft-progress]').value=data.completed||0;q('[data-outcome]').innerHTML=`${data.completed}/${data.total} checkpointed; ${data.pending} pending. ${data.conflicts||0} conflicts. ${data.failure?e('Stopped: '+data.failure.code):''}<br>`+(data.failures?.length?e('Prior stopped attempts: '+data.failures.map(f=>f.metadata.code).join(', '))+'<br>':'')+data.results.filter(r=>r.product_id).map(r=>`<a href="#/catalogue/products/${e(r.product_id)}">${e(r.name)} · ${e(r.status)}</a>${r.proposal?`<details><summary>Review saved proposal — no update applied</summary><pre>${e(JSON.stringify(r.proposal,null,2))}</pre></details>`:''}`).join('<br>');}
 async function run(){if(busy||!job)return;lock(true);paused=false;q('[data-error]').textContent='';try{
   let data=await ui.api(`${API}/${job}`);outcome(data);if(data.reextract_required)throw Error('This checkpoint predates the worksheet-role correction. Re-upload the workbook; do not resume this job.');
   if(data.results.some(r=>r.status==='conflict'))throw Error('Another reviewed job created one of these products. Open the existing drafts; do not resubmit.');
   while(data.pending&&!paused){note('Saving up to 10 drafts. Durable receipts protect completed rows.');const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);try{data=await ui.api(`${API}/${job}/run`,{method:'POST',body:{confirm_drafts_only:true},signal:controller.signal});}finally{clearTimeout(timer);}outcome(data);if(data.stopped)break;}
   note(data.stopped?'Stopped on an exception. Inspect the checkpoint before resuming.':data.pending?'Paused. You can resume this checkpoint after reopening Office.':'Completed. Drafts only; proposals need review in the existing editor.');
  }catch(x){error(x);note('Outcome not confirmed. Execution stopped; reopen the checkpoint to inspect durable receipts. No automatic retry.');}finally{lock(false);}
 }
 q('[data-pause]').onclick=()=>{paused=true;note('Pausing after the current bounded batch…');};q('[data-continue]').onclick=run;
 lock(false);
 q('[data-upload]').onclick=async()=>{if(busy)return;const file=q('[data-file]').files[0];if(!file){error('Choose an XLSX or CSV file.');return;}if(file.size>5*1024*1024){error('Maximum upload is 5 MB.');return;}lock(true);loading('reading');note('Reading your file. No products are being created.');q('[data-error]').textContent='';try{const bytes=await file.arrayBuffer();loading('processing');const r=await fetch(`${API}?name=${encodeURIComponent(file.name)}&version=2`,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/octet-stream'},body:bytes});const data=await r.json();if(!r.ok)throw Error(data.error);loading('preparing');if(token!==ui.state.renderToken)return;preview=data;previewId=data.id;job=null;selection.clear();mappingDrafts.clear();remember();draw();loading('done');q('[data-upload-panel]').open=false;q('[data-file-label]').textContent=`· ${file.name} · ${data.total} products`;note(data.mapping_required?'Review detected worksheets and edit ambiguous column mappings below.':`${data.total} candidates detected. Review exceptions before creating drafts.`);}catch(x){loading('error');error(x);note('Extraction stopped. Any previous review is unchanged; no products were created.');}finally{lock(false);}};
 q('[data-resume]').onclick=async()=>{if(busy)return;lock(true);try{let checkpoint=JSON.parse(localStorage.getItem('office-ingestion-v2-checkpoint')||'null');const entered=q('[data-checkpoint]').value.trim();if(entered){const restored=await ui.api(`${API}/${encodeURIComponent(entered)}`);checkpoint=restored.job?{preview:restored.source_preview,job:restored.job}:{preview:entered,job:null};}if(!checkpoint?.preview)throw Error('No local checkpoint reference.');previewId=checkpoint.preview;job=checkpoint.job;await loadPage();q('[data-upload-panel]').open=false;q('.ing-checkpoint').open=false;q('[data-file-label]').textContent='· '+(preview.name||'Saved review')+' · '+preview.total+' products';if(job){openReview();}if(job)outcome(await ui.api(`${API}/${job}`));note('Checkpoint opened. Processing will not resume until you choose Resume checkpoint.');}catch(x){error(x);}finally{lock(false);}};
 q('[data-page]').onclick=()=>{for(const c of preview.candidates){if(!c.groups.includes('duplicate')&&!selection.has(c.id))selection.set(c.id,{id:c.id,action:'create',slug:c.slug,content:c.content,exceptions_reviewed:false});}draw();note('Page selected for review. Check source evidence and required categories before confirming.');};
 q('[data-ack]').onclick=()=>{for(const item of selection.values())item.exceptions_reviewed=true;draw();note('Selected draft exceptions marked reviewed. Unknown identities, specifications and commercial facts remain unverified; no facts approved.');};
 q('[data-clear]').onclick=()=>{selection.clear();draw();note('Selection cleared. No drafts submitted.');};
 q('[data-ready]').onclick=async()=>{if(busy||!previewId)return;lock(true);try{for(let p=1;;p++){const data=await ui.api(`${API}/${previewId}?page=${p}&group=ready`);for(const c of data.candidates)if(!selection.has(c.id))selection.set(c.id,{id:c.id,action:'create',slug:c.slug,content:c.content});note(`Selected ${selection.size} ready records; nothing saved.`);if(p*25>=data.filtered)break;}draw();}catch(x){error(x);}finally{lock(false);}};
 q('[data-start]').onclick=async()=>{if(busy)return;if(!q('[data-confirm]').checked||!selection.size){error('Review and select records, then confirm drafts only.');return;}lock(true);q('[data-error]').textContent='';try{const data=await ui.api(`${API}/${previewId}/jobs`,{method:'POST',body:{confirm_drafts_only:true,items:[...selection.values()]}});job=data.job;remember();outcome(data);q('[data-confirm]').checked=false;}catch(x){error(x);job=null;}finally{lock(false);}if(job)await run();};
}
