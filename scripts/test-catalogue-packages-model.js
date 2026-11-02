'use strict';
const assert=require('node:assert/strict');const PK=require('../src/lead-agents/catalogue-packages');
let checks=0;const ok=(x,m)=>{assert.ok(x,m);checks++;console.log('PASS '+m)};
const content={category_id:'11111111-1111-4111-8111-111111111111',name:'SYNTHETIC package',variants:[{sku:'SIZE-A',name:'Apartment',pricing:'fixed'}],package:{solution_types:['residential'],scope:{hardware:'One lock',software_deployment:'Consultation only',installation:'quoted_separately'},configuration:{custom:true,per_unit_label:'per door'},components:[{sku:'LOCK-A',quantity:1,quantities:{'SIZE-A':2},basis:'per_unit',role:'required'}]}};
const valid=PK.validatePackageContent(content);ok(valid.package.components[0].quantities['SIZE-A']===2,'size quantity preserved');
try{PK.validatePackageContent({...content,package:{...content.package,components:[null]}});assert.fail('null accepted');}catch(e){ok(e.statusCode===400,'malformed component returns validation 400, not internal error');}
const hit={product:{id:'p',kind:'product',publication_status:'published',published_version:1},variant:{id:'v',sku:'LOCK-A',status:'active',sourcing:'in_stock',stock_on_hand:5,stock_reserved:0,price_ngn_kobo:50000},content:{name:'Lock',variants:[{sku:'LOCK-A',name:'Lock'}]}};
const lookup=new Map([['LOCK-A',hit]]);const saved=PK.snapshotComponents(valid,lookup);
ok(PK.packageIssues(saved,lookup).length===0,'matching approved component is ready');
const sizes=[{sku:'SIZE-A',price_ngn_kobo:107500,vat_rate_bp:750,vat_treatment:'standard'}];
const readiness=PK.packageReadiness(saved,lookup,{sizeRecords:sizes,costs:new Map([['v',30000]])});ok(readiness.sizes[0].margin_kobo===40000,'margin uses VAT-exclusive price less required quantity cost');
ok(!('margin_kobo' in PK.packageReadiness(saved,lookup,{sizeRecords:sizes}).sizes[0]),'no margin without explicit cost access');
hit.variant.price_ngn_kobo=55000;ok(PK.packageIssues(saved,lookup).some(x=>x.code==='component_changed'),'approved-price drift requires re-review');
hit.product.publication_status='archived';ok(PK.packageAvailability(saved,lookup)==='unavailable','archived component immediately unavailable');
hit.product.kind="service"; hit.product.publication_status="published"; hit.variant.sourcing="discontinued";
ok(PK.componentAvailability(hit)==="unavailable", "discontinued service cannot make a package appear available");
console.log(JSON.stringify({suite:'packages-model',checks,failed:0}));
