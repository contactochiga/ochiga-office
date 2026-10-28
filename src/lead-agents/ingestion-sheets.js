'use strict';
// Worksheet roles and joins use source structure, never name/SKU presence alone.
// No source value authorizes a price, stock change, uploaded image or certification.
const {normal}=require('./ingestion-evidence');
const ROLES=['product_master','specifications','pricing','inventory','images','qa','metadata','unknown'];
const EXTRA_FIELDS=['specifications_json','attribute_key','attribute_value','attribute_unit','image_slot','image_type','image_file','stock_reference','qa_check','qa_result'];
const str=v=>v==null?'':String(v).trim();
const confirmed=v=>!!normal(v)&&!/pending|unconfirmed|unknown|tbc/i.test(v);
function fieldForV2(header,base){
 const h=normal(header);
 if (/^attribute\s*#$/i.test(str(header))||h==='attribute number')return 'ignore';
 if (['specification evidence','specification status','retail listing origin url'].includes(h))return 'source_reference';
 const aliases={category:['category path','category subcategory path'],manufacturer:['brand manufacturer'],specifications_json:['structured specifications json','specifications json'],attribute_key:['specification key','attribute','attribute key','attribute name','parameter'],attribute_value:['value','attribute value','specification value'],attribute_unit:['unit','units','attribute unit'],image_slot:['photo number','image number','image order','image slot'],image_type:['photo type','image type','image requirement'],image_file:['photo filename','image filename','file name'],stock_reference:['physical stock quantity unverified','stock quantity','stock on hand','available quantity','quantity','qty','stock','warehouse'],qa_check:['check','verification check','qa check'],qa_result:['result','verification result','qa result']};
 for(const [f,values] of Object.entries(aliases))if(values.includes(h))return f;
 return base(header);
}
function roleEvidence(sheet,headings,fields){
 const has=f=>fields.includes(f),identity=has('sku')||(has('manufacturer')&&has('model'));
 const h=headings.map(normal),support=[];
 if(identity&&/^(read me|readme|instructions?|metadata|notes|cover|guide)$/.test(normal(sheet)))return {role:'unknown',reason:'Instruction/metadata label contains a structured identity table; explicit role required.',score:8};
 if(identity&&has('attribute_key')&&has('attribute_value'))support.push('specifications');
 if(identity&&(has('image_slot')||has('image_file')||has('image')||(has('image_type')&&!has('description'))))support.push('images');
 const qaColumns=h.filter(v=>/^(category action|brand action|model action|spec confidence|images complete|image action|supplier verified|stock confirmed|sale price approved|validation status|verification status)$/.test(v));
 if(identity&&((has('qa_check')&&has('qa_result'))||qaColumns.length>=2))support.push('qa');
 const named=normal(sheet),financial=fields.some(f=>['retail_reference','supplier_cost','supplier'].includes(f));
 // Sheet labels corroborate an actual commercial/stock/image structure; labels alone never suffice.
 if(identity&&financial&&/\b(prices?|pricing|rates|costs?|quotations?)\b/.test(named))support.push('pricing');
 if(identity&&has('stock_reference')&&/\b(inventory|stock|warehouse)\b/.test(named))support.push('inventory');
 const descriptors=fields.filter(f=>['category','description','summary','specifications','specifications_json'].includes(f));
 const master=has('name')&&(has('sku')||has('model')||has('category')||has('description'))&&descriptors.length>0;
 // A detailed master may contain a cover URL or image requirement. Long-form support layouts take precedence.
 const strongSupport=support.filter(r=>r!=='images'||has('image_slot')||has('image_file')||/\b(photos?|images?|photographs?)\b/.test(named)||!master);
 if(strongSupport.length>1)return {role:'unknown',reason:'Conflicting support-table structures; choose a role explicitly.',score:8};
 if(strongSupport.length)return {role:strongSupport[0],reason:'Identity plus dedicated supporting-record columns.',score:10+fields.length};
 if(master)return {role:'product_master',reason:'Product identity plus descriptive master fields; not name/SKU alone.',score:10+descriptors.length};
 if(identity&&fields.some(f=>['retail_reference','supplier_cost','supplier'].includes(f))&&has('stock_reference'))return {role:'unknown',reason:'Mixed pricing and inventory structure; explicit role required.',score:8};
 if(identity&&fields.some(f=>['retail_reference','supplier_cost','supplier'].includes(f)))return {role:'pricing',reason:'Identity and commercial-reference columns without master description.',score:9};
 if(identity&&(has('stock_reference')||h.includes('stock status')))return {role:'inventory',reason:'Identity and stock-reference columns without master description.',score:9};
 if(!identity&&/^(read me|readme|instructions?|metadata|notes|cover|guide)$/.test(normal(sheet)))return {role:'metadata',reason:'Instruction/metadata sheet without a product identity structure.',score:1};
 return {role:'unknown',reason:'Insufficient or ambiguous worksheet structure. Names/SKUs alone do not establish a master.',score:0};
}
function applyRole(d,chosen){
 if(chosen?.role!==undefined&&!ROLES.includes(chosen.role))throw Error('import_invalid_mapping');
 const evidence=roleEvidence(d.sheet,d.headings,d.fields),role=chosen?.role||evidence.role;
 const excluded=chosen?.include===false;
 let reasons=d.reasons.filter(r=>!r.startsWith('No product-name')&&!r.startsWith('No SKU, category'));
 if(role==='product_master'){
  if(!d.fields.includes('name'))reasons.push('Product master requires a product-name column.');
  if(!d.fields.some(f=>['sku','category','description','model'].includes(f)))reasons.push('Product master requires an identity/description column.');
 }else if(role==='unknown'&&!excluded)reasons.push(evidence.reason);
 const links=chosen?.links||[];
 if(!Array.isArray(links)||links.length>2000||new Set(links.map(x=>x.row)).size!==links.length||links.some(x=>!Number.isInteger(x.row)||x.row<=d.row||x.row>d.total_rows||!['link','ignore'].includes(x.action)||!str(x.reason)||str(x.reason).length>400||(x.action==='link'&&!str(x.target_sku))))throw Error('import_invalid_mapping');
 return {...d,role,role_reason:chosen?.role?'Explicit staff role selection. '+evidence.reason:evidence.reason,role_reviewed:!!chosen?.role,excluded,links,accepted:!excluded&&role==='product_master'&&!reasons.length,reasons};
}
function cellsFor(table,d,row){return d.headings.map((header,i)=>({sheet:table.sheet,row,column:i+1,cell:columnName(i+1)+row,header,field:d.fields[i],value:str(table.data[row-1]?.[i])})).filter(c=>c.value);}
function columnName(n){let s='';for(;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}
const costKey=v=>/supplier.*(price|cost|quote)|dealer.*(price|cost|quote)|wholesale|landed.*cost|purchase.*(price|cost)/i.test(v);
function reconcileSheets(extraction,tables){
 const candidates=extraction.candidates,bySku=new Map(),byModel=new Map();
 for(const c of candidates){if(c.specification_evidence.attributes.some(a=>costKey(a.key))||c.source_cells.some(cell=>cell.field==='specifications_json'&&costKey(cell.value)))extraction.contains_supplier_data=true;c.supporting_records={specifications:[],images:[],qa:[],pricing:[],inventory:[]};c.sheet_conflicts=[];
  for(const v of c.variants){const sku=str(v.sku).toUpperCase();if(!sku)continue;if(!bySku.has(sku))bySku.set(sku,[]);if(!bySku.get(sku).includes(c))bySku.get(sku).push(c);}
  if(confirmed(c.manufacturer)&&confirmed(c.model)){const key=normal(c.manufacturer)+':'+normal(c.model);if(!byModel.has(key))byModel.set(key,[]);byModel.get(key).push(c);}
 }
 const unmatched=[],conflicts=[],decisions=[];
 const stats={unique_products:candidates.length,specifications:0,images:0,qa:0,pricing:0,inventory:0,unmatched:0,conflicts:0};
 for(const d of extraction.diagnostics){if(d.excluded||!['specifications','images','qa','pricing','inventory'].includes(d.role))continue;
  const table=tables.find(t=>t.sheet===d.sheet);
  for(let row=d.row+1;row<=table.data.length;row++){
   const cells=cellsFor(table,d,row);if(!cells.length)continue;
   // Repeated printed headers are structural, not supporting records.
   if(cells.every(c=>normal(c.value)===normal(c.header)))continue;
   const value=f=>cells.find(c=>c.field===f)?.value||'';
   if(costKey(value('attribute_key')))extraction.contains_supplier_data=true;
   const sku=value('sku').toUpperCase(),brand=value('manufacturer'),model=value('model');
   const record={sheet:d.sheet,row,role:d.role,sku,cells,status:'unverified_source'};
   const resolution=d.links.find(x=>x.row===row);
   if(resolution?.action==='ignore'){decisions.push({...record,resolution});continue;}
   let targets=sku?bySku.get(sku)||[]:confirmed(brand)&&confirmed(model)?byModel.get(normal(brand)+':'+normal(model))||[]:[];
   let reason=targets.length===0?'No exact master SKU or unique confirmed manufacturer/model match.':targets.length>1?'Identity matches multiple master products.':'';
   if(resolution?.action==='link'){targets=bySku.get(str(resolution.target_sku).toUpperCase())||[];reason=targets.length===1?'':'Explicit target does not identify one master product.';}
   if(targets.length!==1){unmatched.push({...record,reason});if(targets.length>1){conflicts.push({...record,reason});for(const c of targets)c.sheet_conflicts.push({sheet:d.sheet,row,reason});}continue;}
   const c=targets[0];
   // Suggestions and QA source labels are retained as evidence, never identity overrides.
   const mismatches=['name','manufacturer','model','category'].filter(f=>value(f)&&str(c[f])&&normal(value(f))!==normal(c[f]));
   if(mismatches.length&&!resolution){reason='Supporting identity disagrees with master: '+mismatches.join(', ');conflicts.push({...record,reason});c.sheet_conflicts.push({sheet:d.sheet,row,reason});continue;}
   if(resolution)decisions.push({...record,resolution});
   if(d.role==='specifications'){
    const key=value('attribute_key'),val=value('attribute_value'),unit=value('attribute_unit');
    if(!key||!val||key.length>80||val.length>400||unit.length>40){conflicts.push({...record,reason:'Invalid or oversized structured attribute.'});c.sheet_conflicts.push({sheet:d.sheet,row,reason:'Invalid structured attribute'});continue;}
    const attr={key,value:val,unit,provenance:cells};const existing=c.specification_evidence.attributes.find(a=>normal(a.key)===normal(key));
    if(existing&&(existing.value!==val||existing.unit!==unit)){reason='Conflicting specification: '+key;conflicts.push({...record,reason});c.sheet_conflicts.push({sheet:d.sheet,row,reason});continue;}
    if(existing)existing.provenance.push(...cells);else if(c.specification_evidence.attributes.length<100)c.specification_evidence.attributes.push(attr);else{conflicts.push({...record,reason:'Catalogue attribute limit exceeded.'});c.sheet_conflicts.push({sheet:d.sheet,row,reason:'Catalogue attribute limit exceeded'});continue;}
   }
   c.supporting_records[d.role].push(record);stats[d.role]++;
   if(d.role==='pricing')for(const cell of cells){if(['retail_reference','supplier_cost','supplier'].includes(cell.field)){const ref={label:cell.header,value:cell.value,kind:cell.field,sheet:d.sheet,row,cell:cell.cell,ngn_kobo:null};(cell.field==='retail_reference'?c.retail_references:c.supplier_references).push(ref);}}
  }
 }
 for(const [sku,rows]of bySku)if(rows.length>1){const issue={role:'product_master',sku,reason:'SKU shared by multiple master candidates; resolve master identity before creation.',sources:rows.flatMap(c=>c.source_rows)};conflicts.push(issue);for(const c of rows)c.sheet_conflicts.push(issue);}
 for(const c of candidates){c.specifications=c.specification_evidence.attributes.map(({key,value,unit})=>({key,value,unit}));if(c.supporting_records.qa.length)c.warnings.push('Linked QA records are source verification tasks, not approvals.');if(c.supporting_records.images.length)c.warnings.push(`${c.supporting_records.images.length} image requirements linked; no image files uploaded.`);}
 stats.unmatched=unmatched.length;stats.conflicts=conflicts.length;
 extraction.sheet_processing_version=1;
 extraction.sheet_roles=extraction.diagnostics.map(d=>({sheet:d.sheet,role:d.role,reason:d.role_reason,excluded:d.excluded,rows:tables.find(t=>t.sheet===d.sheet).data.slice(d.row).filter(row=>row.some(v=>str(v))).length}));
 extraction.sheet_reconciliation={counts:stats,unmatched,conflicts,decisions};
 extraction.link_targets=[...bySku].filter(([,rows])=>rows.length===1).map(([sku,rows])=>({sku,name:rows[0].name}));
 extraction.mapping_required=extraction.mapping_required||extraction.diagnostics.some(d=>!d.excluded&&d.role==='unknown');
 return extraction;
}
module.exports={ROLES,EXTRA_FIELDS,fieldForV2,roleEvidence,applyRole,reconcileSheets};
