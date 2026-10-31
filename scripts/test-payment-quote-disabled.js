'use strict';
const http=require('http'),assert=require('assert/strict');
const {handleHardwareCheckoutRequest}=require('../src/lead-agents/hardware-checkout-api');
process.env.OFFICE_HARDWARE_CHECKOUT_ENABLED='true';process.env.OFFICE_HARDWARE_ORDERS_ENABLED='true';process.env.OFFICE_HARDWARE_PAYMENTS_ENABLED='false';
let calls=[],result={eligible:true,amount_kobo:10000,payment_state:'not_started'},failure=null;
const server=http.createServer((req,res)=>handleHardwareCheckoutRequest({req,res,pathname:req.url,authContext:req.headers.authorization==='synthetic'?{type:'scoped_api_key',client:'test',scopes:['commerce.checkout.submit']}:null,store:{client:{post:async(p,args)=>{calls.push(p);if(failure)throw {response:{data:failure}};return {data:result}}}}}));
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port+'/api/commerce/checkout/';const body={id:'00000000-0000-0000-0000-000000000001',guest_hash:'a'.repeat(64)};
const post=(action,b=body,auth='synthetic')=>fetch(base+action,{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify(b)});
let r=await post('payment-quote');assert.equal(r.status,200);assert.equal((await r.json()).payment.amount_kobo,10000);assert.equal(r.headers.get('cache-control'),'private, no-store');
for(const reason of ['reservation_expired','order_cancelled','product_or_variant_unavailable','approved_price_missing_or_changed','order_state_invalid']){result={eligible:false,eligibility_code:reason,amount_kobo:10000,payment_state:'not_started'};r=await post('payment-quote');assert.equal(r.status,200);const q=(await r.json()).payment;assert.equal(q.eligible,false);assert.equal(q.eligibility_code,reason);}
result={eligible:false,eligibility_code:'private_internal_reason',amount_kobo:10000,payment_state:'not_started'};r=await post('payment-quote');assert.equal((await r.json()).payment.eligibility_code,'catalogue_or_price_ineligible');
failure={code:'PT404',message:'order_not_found'};r=await post('payment-quote');assert.equal(r.status,404);failure=null;
const before=calls.length;r=await post('payment-quote',body,'wrong');assert.equal(r.status,403);r=await post('payment-quote',{...body,guest_hash:'bad'});assert.equal(r.status,400);r=await post('payment-start',{...body,accepted_total_kobo:10000});assert.equal(r.status,503);assert.equal((await r.json()).error,'payments_disabled');assert.equal(calls.length,before);assert(calls.every(x=>x==='/rpc/hardware_payment_quote'));
console.log('PASS disabled quote HTTP: eligibility, privacy, restrictions, ownership, authorization, validation, initialization denial; only quote RPC called');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>server.close());
