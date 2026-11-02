import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../oyi-commerce-integration/package.json',import.meta.url));
const {JSDOM}=require('jsdom');
const dom=new JSDOM('<main></main>');globalThis.document=dom.window.document;
const {renderHardwareFinancial}=await import('../public/office/catalogue/hardware-financial.mjs');
let count=0;const ok=(v,name)=>{assert.ok(v,name);count++;console.log('PASS '+name)};
const id='11111111-2222-4333-8444-555555555555';
let perms=[],calls=[],confirmed=false,denied=false,financial=false;
const ui={state:{renderToken:1},hasPermission:p=>perms.includes(p),escapeHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),el:h=>{const t=document.createElement('template');t.innerHTML=h;return t.content.firstElementChild},api:async(p,o)=>{
 calls.push({p,...o});
 if(p.endsWith('hardware-financial')){if(financial)return {orders:[{id,payment_state:'paid',payable_total_kobo:10000,history:[]}]};throw Error('financial_operations_disabled');}
 if(p.endsWith('hardware-orders'))return {orders:[{id,order_state:'awaiting_confirmation',payment_state:'not_started',delivery_state:confirmed?'confirmed':'unconfirmed',payable_total_kobo:null}]};
 if(p.endsWith('?customer=true')){if(denied)throw Error('forbidden');return {private:{delivery:{address:'<img src=x onerror=alert(1)>',city:'TEST',state:'Plateau',country:'NG'}}};}
 if(p.endsWith('/delivery')){confirmed=true;return {confirmed:true};}
 throw Error('unexpected route');
}};
const host=document.querySelector('main'),tick=()=>new Promise(r=>setTimeout(r,0));
await renderHardwareFinancial(host,1,ui);
ok(host.textContent.includes('Delivery charge not confirmed')&&!host.textContent.includes('₦0'),'unknown delivery never shown as zero');
ok(!host.querySelector('button'),'reader has no confirmation action');
perms=['commerce.orders.delivery.confirm'];await renderHardwareFinancial(host,1,ui);
ok(!calls.some(c=>c.p.includes('?customer')),'customer data not fetched before deliberate review');
denied=true;host.querySelector('button').click();await tick();
ok(host.textContent.includes('forbidden')&&!host.querySelector('form'),'customer/CRM permission failure prevents form');
denied=false;host.querySelector('button').click();await tick();
ok(!host.querySelector('img')&&host.textContent.includes('<img'),'private address safely escaped');
const form=host.querySelector('form');
form.elements.gross.value='12.50';form.elements.tax.value='15';form.elements.evidence.value='SYNTHETIC VERIFIED DESTINATION';
await form.onsubmit({preventDefault(){}});
ok(form.textContent.includes('VAT cannot exceed')&&!calls.some(c=>c.method==='POST'),'invalid tax does not submit');
form.elements.tax.value='0.25';
const request=form.onsubmit({preventDefault(){}});await form.onsubmit({preventDefault(){}});await request;
const writes=calls.filter(c=>c.method==='POST');
ok(writes.length===1&&writes[0].body.gross_kobo===1250&&writes[0].body.tax_kobo===25,'double submit suppressed and kobo arithmetic exact');
ok(!host.querySelector('form')&&!host.textContent.includes('Confirm delivery only'),'successful confirmation removes write action');
ok(!calls.some(c=>/payment-start|refund|operations/.test(c.p)),'delivery control never calls financial execution');
perms=['commerce.orders.refund.request'];financial=true;await renderHardwareFinancial(host,1,ui);
ok(host.textContent.includes('Request full refund review'),'existing authorized refund control preserved');
console.log(JSON.stringify({suite:'delivery-first-office-ui',checks:count,failed:0}));
