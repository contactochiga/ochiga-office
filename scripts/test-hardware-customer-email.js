'use strict';
const assert=require('node:assert/strict'),{sendOfficeEmail}=require('../src/lead-agents/email'),{message,drainCustomerEmail}=require('../src/lead-agents/hardware-customer-email');
let n=0;const check=(ok,s)=>{assert(ok,s);n++;console.log('PASS '+s);};
(async()=>{
 const original=global.fetch;let captured;
 global.fetch=async(u,o)=>{captured={u,o};return {ok:true,json:async()=>({id:'synthetic'})};};
 const config={officeEmailProvider:'resend',officeEmailFrom:'synthetic@example.invalid',resendApiKey:'synthetic-not-provider-key'};
 await sendOfficeEmail(config,{to:'synthetic@example.invalid',subject:'test',text:'test',idempotencyKey:'hardware-email/synthetic'});
 check(captured.o.headers['Idempotency-Key']==='hardware-email/synthetic'&&captured.o.redirect==='error'&&captured.o.signal,'idempotency, no redirects and bounded timeout applied');
 await sendOfficeEmail(config,{to:'synthetic@example.invalid',subject:'legacy',text:'test'});check(!captured.o.headers['Idempotency-Key'],'existing email callers preserve behavior');global.fetch=original;
 const row={id:'synthetic-message',order_id:'11111111-2222-4333-8444-555555555555',kind:'created',recipient:'synthetic@example.invalid',payload:{version:1,total_kobo:10750},attempts:1,lease_id:'synthetic-lease'};
 for(const kind of ['created','cancelled','delivery_confirmed','paid','payment_failed','under_review','packed','dispatched','delivered','installed','closed','installation_requested','installation_scheduled','installation_rescheduled','installation_started','installation_completed','installation_cancelled']){
 const m=message({...row,kind},'https://getoyi.example');check(m.text.includes('107.50')&&m.text.includes('/hardware/orders/find')&&!m.html,'safe deterministic template '+kind);
 }
 const refund=message({...row,kind:'refund_completed',payload:{version:1,refund_status:'processed',refund_kobo:10000}},'https://getoyi.example');
 check(refund.text.includes('100.00')&&refund.subject.includes('refund'),'refund completion uses verified refund amount');
 for(const bad of [{version:1,refund_status:'pending',refund_kobo:10000},{version:1,refund_status:'processed',refund_kobo:null}])assert.throws(()=>message({...row,kind:'refund_completed',payload:bad},'https://getoyi.example'));
 check(true,'pending or missing amount cannot produce completion email');
 assert.throws(()=>message(row,'http://customer.invalid'));check(true,'unencrypted non-local customer destination refused');
 process.env.OFFICE_HARDWARE_CUSTOMER_EMAIL_ENABLED='true';let finished;
 const store={client:{post:async(u,p)=>u.endsWith('_claim')?{data:row}:(finished=p,{data:true})}};
 await drainCustomerEmail({store,config,origin:'https://getoyi.example',send:async()=>{throw Error('lost_response');}});check(finished.p_result==='retry'&&finished.p_delay>=30,'lost provider response retries same durable message');
 await drainCustomerEmail({store,config,origin:'https://getoyi.example',send:async()=>{throw Object.assign(Error('invalid'),{providerStatus:409});}});check(finished.p_result==='review','provider body/idempotency conflict quarantined');
 process.env.OFFICE_HARDWARE_CUSTOMER_EMAIL_ENABLED='false';check((await drainCustomerEmail({store,config})).disabled,'worker defaults to no delivery when disabled');
 console.log(`RESULT ${n}/${n} PASS; no network or real email`);
})().catch(e=>{console.error(e);process.exitCode=1;});
