"use strict";
const crypto = require('crypto');
const {json,readJsonBody}=require('./http');
const {customerView}=require('./hardware-order-progress-api');
const PREFIX='/api/public/orders/access/';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function secret(){const s=process.env.OFFICE_HARDWARE_CUSTOMER_ACCESS_SECRET;if(!s||s.length<32)throw Error('access_unavailable');return s;}
const proof=(v)=>crypto.createHmac('sha256',secret()).update(v).digest('hex');
const codeFor=id=>String(parseInt(proof('deliver:'+id).slice(0,8),16)%100000000).padStart(8,'0');
const codeHash=(id,code)=>proof('verify:'+id+':'+code);
const enabled=()=>process.env.OFFICE_HARDWARE_CUSTOMER_ACCESS_ENABLED==='true' && process.env.OFFICE_HARDWARE_ORDERS_ENABLED==='true';
const fail=(status,code)=>{const e=new Error(code);e.statusCode=status;e.safeCode=code;throw e;};
async function handleHardwareCustomerAccess({req,res,pathname,authContext,store}){
 if(!pathname.startsWith(PREFIX))return false;
 res.setHeader('cache-control','private, no-store');res.setHeader('x-content-type-options','nosniff');
 const send=(s,b)=>{json(res,s,b);return true;};
 try{
 if(authContext?.type!=='scoped_api_key'||!authContext.scopes?.includes('orders.customer.access'))fail(403,'forbidden');
 if(!enabled()||!store.client)fail(503,'access_disabled');secret();
 if(req.method!=='POST')fail(405,'method_not_allowed');
 const action=pathname.slice(PREFIX.length),b=await readJsonBody(req,2048);
 const fields={request:['reference','email'],verify:['challenge','code'],progress:['id','grant'],history:['id','grant'],revoke:['id','grant']}[action];
 if(!fields)fail(404,'not_found');
 if(!b||Array.isArray(b)||typeof b!=='object'||Object.keys(b).some(k=>!fields.includes(k))||fields.some(k=>typeof b[k]!=='string'))fail(400,'invalid_access_request');
 const rpc=async(n,p)=>(await store.client.post('/rpc/'+n,{p_client:authContext.client,...p})).data;
 if(action==='request'){
 const email=b.email.trim().toLowerCase(),ref=b.reference.trim();
 if(email.length>254||!/^\S+@[^@\s]+\.[^@\s]+$/.test(email)||!(UUID.test(ref)||/^HW-[0-9A-F]{8}$/i.test(ref)))fail(400,'invalid_access_request');
 const id=crypto.randomUUID();
 await rpc('hardware_customer_access_request',{p_reference:ref,p_email:email,p_identity_hash:proof('identity:'+email),p_id:id,p_code_hash:codeHash(id,codeFor(id))});
 return send(202,{challenge:id,message:'If these details match an order, a verification code will be emailed. It expires in ten minutes.'});
 }
 if(action==='verify'){
 if(!UUID.test(b.challenge)||!/^\d{8}$/.test(b.code))fail(400,'invalid_access_request');
 const token=crypto.randomBytes(32).toString('hex');
 const r=await rpc('hardware_customer_access_verify',{p_id:b.challenge,p_code_hash:codeHash(b.challenge,b.code),p_token_hash:sha(token)});
 if(!r)fail(403,'verification_failed');
 // This response is server-to-server only. GetOyi must put the grant in an HttpOnly cookie.
 return send(200,{...r,grant:token});
 }
 if(!UUID.test(b.id)||! /^[0-9a-f]{64}$/.test(b.grant))fail(400,'invalid_access_request');
 const r=await rpc(action==='progress'?'hardware_customer_access_progress':action==='history'?'hardware_customer_access_history':'hardware_customer_access_revoke',{p_order:b.id,p_token_hash:sha(b.grant)});
 return send(200,action==='progress'?{progress:customerView(r)}:action==='history'?{orders:(Array.isArray(r)?r:[]).slice(0,50).map(customerView)}:{signed_out:true});
 }catch(e){if(e.safeCode)return send(e.statusCode,{error:e.safeCode});
 if(e.response?.data?.code==='PT404')return send(404,{error:'order_not_found'});
 if([400,413].includes(e.statusCode))return send(e.statusCode,{error:'invalid_access_request'});
 return send(503,{error:'access_unavailable'});}
}
module.exports={handleHardwareCustomerAccess,codeFor,codeHash,sha,enabled};
