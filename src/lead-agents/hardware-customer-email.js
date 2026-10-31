"use strict";
const {sendOfficeEmail}=require('./email');
const {backoffDelayMs}=require('./communication-outbox');
const {codeFor}=require('./hardware-customer-access');
const LABELS={created:'Order request received — not paid',cancelled:'Order cancelled',delivery_confirmed:'Delivery charge confirmed — review your total',paid:'Payment verified',payment_failed:'Payment was not successful',under_review:'Order payment under review',packed:'Order packed',dispatched:'Order dispatched',delivered:'Order delivered',installed:'Installation completed',closed:'Order completed',installation_requested:'Installation assessment requested',installation_scheduled:'Installation arrangements updated',installation_rescheduled:'Installation arrangements updated',installation_started:'Installation in progress',installation_completed:'Installation completed',installation_cancelled:'Installation arrangements cancelled'};
function message(row,origin){
 const url=new URL(origin);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw Error('invalid_customer_origin');
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('invalid_customer_origin');
 const link=url.origin+'/hardware/orders/find';
 const ref=row.order_id; // Full identifier avoids collisions; no grant or payment reference in URL.
 if(row.kind==='access_code')return {to:row.recipient,subject:'Your Oyi order verification code',text:`Your verification code is ${codeFor(row.payload.challenge_id)}. It expires ten minutes after your request.\n\nOrder: ${ref}\nEnter it at ${link}. If you did not request this, ignore this message.`};
 if(!LABELS[row.kind]||row.payload.version!==1)throw Error('unsupported_email');
 const k=row.payload.total_kobo,amount=Number.isSafeInteger(k)?`\nConfirmed total (including applicable tax and delivery): NGN ${(k/100).toFixed(2)}.`:'';
 return {to:row.recipient,subject:LABELS[row.kind],text:`${LABELS[row.kind]}.\nOrder: ${ref}${amount}\n\nVerify your email to view the authoritative order status at ${link}.\nInstallation, when requested, remains a separately assessed service. This email does not authorize a payment or confirm an appointment.`};
}
async function drainCustomerEmail({store,config,send=sendOfficeEmail,origin=process.env.GETOYI_CUSTOMER_ORDER_ORIGIN}){
 if(process.env.OFFICE_HARDWARE_CUSTOMER_EMAIL_ENABLED!=='true'||!store.client)return {disabled:true};
 // Never consume queue entries without a configured sender / customer origin.
 if(config.officeEmailProvider!=='resend'||!config.resendApiKey||!config.officeEmailFrom||!origin)return {unavailable:true};
 const rpc=async(n,p)=>(await store.client.post('/rpc/'+n,p)).data;
 const row=await rpc('hardware_customer_email_claim',{});if(!row)return {empty:true};
 let result='retry';
 try{
 if(row.kind==='access_code' && Date.now()-Date.parse(row.created_at)>=600000)result='review';
 else{const r=await send(config,{...message(row,origin),idempotencyKey:'hardware-email/'+row.id});result=r.delivered?'accepted':'review';}
 }catch(e){if([400,401,403,409,422].includes(e.providerStatus)||['invalid_customer_origin','unsupported_email','access_unavailable'].includes(e.message))result='review';}
 const delay=Math.max(30,Math.min(3600,Math.ceil(backoffDelayMs(row.attempts)/1000)));
 const saved=await rpc('hardware_customer_email_finish',{p_id:row.id,p_lease:row.lease_id,p_result:result,p_delay:delay});
 return {result,saved}; // No recipient, OTP, provider payload or contact in diagnostics.
}
function startCustomerEmailWorker({store,config}){
 let stopped=false,busy=false;
 const tick=async()=>{if(stopped||busy)return;busy=true;try{for(let i=0;i<5&&!stopped;i++){const r=await drainCustomerEmail({store,config});if(r.empty||r.disabled||r.unavailable)break;}}catch{/* Durable lease survives a process/network interruption. */}finally{busy=false;}};
 const timer=setInterval(tick,15000);timer.unref();return {stop(){stopped=true;clearInterval(timer);}};
}
module.exports={message,drainCustomerEmail,startCustomerEmailWorker};
