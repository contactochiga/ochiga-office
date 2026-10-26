'use strict';
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const {handleHardwareCheckoutRequest}=require('../src/lead-agents/hardware-checkout-api');
const codes=['OFFICE_HARDWARE_CHECKOUT_ENABLED','OFFICE_HARDWARE_ORDERS_ENABLED','OFFICE_HARDWARE_PAYMENTS_ENABLED','HARDWARE_PAYMENT_BACKEND_URL','HARDWARE_PAYMENT_BACKEND_KEY'];
const previous=Object.fromEntries(codes.map(k=>[k,process.env[k]]));
Object.assign(process.env,{OFFICE_HARDWARE_CHECKOUT_ENABLED:'true',OFFICE_HARDWARE_ORDERS_ENABLED:'true',OFFICE_HARDWARE_PAYMENTS_ENABLED:'true',HARDWARE_PAYMENT_BACKEND_URL:'https://backend.hardware.test',HARDWARE_PAYMENT_BACKEND_KEY:'synthetic-test-key-'.padEnd(40,'x')});
const authContext={type:'scoped_api_key',scopes:['commerce.checkout.submit'],client:'synthetic-checkout'};
const body={id:'11111111-1111-4111-8111-111111111111',guest_hash:'a'.repeat(64),accepted_total_kobo:10000};
async function request(mockFetch){
 const original=global.fetch;global.fetch=mockFetch;
 let status,bodyText='';const res={setHeader(){},writeHead(s){status=s},end(value){bodyText=String(value||'')}};
 const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.headers={};
 const store={client:{post:async route=>route==='/rpc/hardware_payment_quote'?{data:{eligible:true,amount_kobo:10000,payment_state:'not_started'}}:{data:{reference:'synthetic-reference',amount_kobo:10000}}}};
 try { await handleHardwareCheckoutRequest({req,res,pathname:'/api/commerce/checkout/payment-start',authContext,store}); }
 finally {global.fetch=original;}
 return {status,body:JSON.parse(bodyText)};
}
function http(status,payload){return {ok:status>=200&&status<300,status,json:async()=>payload};}
(async()=>{
 let r=await request(async()=>http(409,{error:'payment_not_eligible'}));assert.equal(r.status,409);assert.equal(r.body.error,'payment_not_eligible');
 r=await request(async()=>http(503,{error:'payments_disabled'}));assert.equal(r.status,503);assert.equal(r.body.error,'payments_disabled');
 r=await request(async()=>http(503,{error:'payment_unavailable'}));assert.equal(r.status,503);assert.equal(r.body.error,'payment_backend_rejected');
 r=await request(async()=>{const e=new Error('must not leak');e.name='TimeoutError';throw e;});assert.equal(r.status,503);assert.equal(r.body.error,'payment_backend_timeout_uncertain');assert.equal(JSON.stringify(r.body).includes('must not leak'),false);
 r=await request(async()=>{const e=new Error('must not leak');e.code='ECONNREFUSED';throw e;});assert.equal(r.status,503);assert.equal(r.body.error,'payment_backend_connection_failure');
 r=await request(async()=>({ok:true,status:200,json:async()=>{throw Error('private body');}}));assert.equal(r.status,503);assert.equal(r.body.error,'payment_backend_malformed_response');
 r=await request(async()=>http(200,{state:'pending',checkout_url:'https://checkout.paystack.com/synthetic'}));assert.equal(r.status,200);assert.equal(r.body.payment.state,'pending');
 r=await request(async()=>http(200,{state:'processing'}));assert.equal(r.status,200);assert.equal(r.body.payment.state,'processing');
 console.log('Office payment-start upstream diagnostics: 8 application/transport cases PASS; fetch mocked, no Backend or Paystack calls');
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>{for(const k of codes){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}});
