"use strict";
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
module.exports = async ({psql,one,check,ROOT,vid,RUN,startApp,gatewayUrl,reloadSchema,restUrl,concurrentSql}) => {
 const run = sql => { const r=psql(sql);if(r.status)throw Error(r.err);return r.out; };
 const migration=fs.readFileSync(path.join(ROOT,'db/commerce/20261031182434_hardware_staff_delivery_first.sql'),'utf8');
 const signature='hardware_checkout_prepare_payment(text,text,uuid,bigint)';
 let r=psql(migration.replace(/commit;\s*$/, 'rollback;'));
 check('DF-ROLLBACK','transaction rollback leaves no preparation function',r.status===0&&one(`select to_regprocedure('${signature}') is null`)==='t',r.err);
 run(migration);run(migration);
 const gate=fs.readFileSync(path.join(ROOT,'release/commerce/delivery-first-gate.sql'),'utf8');
 const gated=psql(gate);
 check('DF-GATE','exact function bodies, ownership, grants and private tables pass',gated.status===0&&!gated.out.includes('FAIL'),gated);
 for(const tamper of [`alter function ${signature} security definer`,`grant execute on function ${signature} to anon`]) {
   const negative=psql('begin;'+tamper+';'+gate+'rollback;');
   check('DF-TAMPER','unsafe preparation function rejected by gate',negative.status===0&&negative.out.includes('FAIL'),negative);
 }

 check('DF-REAPPLY','additive functions can be reapplied without new records',true);
 await reloadSchema(restUrl);
 const app=await startApp(gatewayUrl,true,false,{OFFICE_HARDWARE_STAFF_DELIVERY_FIRST:'true'});
 const guest='d'.repeat(64), key='isolated-checkout-'+RUN;
 const post=async(action,body,credential=key)=>{const res=await fetch(app.url+'/api/commerce/checkout/'+action,{method:'POST',headers:{'content-type':'application/json','x-api-key':credential},body:JSON.stringify(body)});return {status:res.status,data:await res.json()};};
 const ownership=id=>({id,guest_hash:guest});
 const count=()=>one("select jsonb_build_array((select count(*) from hardware_payment_authorizations),(select count(*) from hardware_payment_confirmations),(select count(*) from hardware_payment_history),(select count(*) from hardware_reservations),(select sum(stock_reserved) from catalogue_variants),(select count(*) from hardware_reservation_events),(select count(*) from audit_events))");
 const create=async()=>{
   const q=await post('quote',{lines:[{product:'test-order',sku:'TEST-ORDER-1',quantity:1}]});
   if(q.status!==200)throw Error(JSON.stringify(q));
   check('DF-QUOTE','initial quote promises no early stock hold',q.data.quote.reservation_ttl_seconds===null);
   const body={guest_hash:guest,idempotency_key:crypto.randomUUID(),quote_hash:q.data.quote.quote_hash,order:{customer:{name:'SYNTHETIC DELIVERY REVIEW',email:'delivery-review@example.invalid',phone:'0000000000'},delivery:{country:'NG',state:'Plateau',city:'Jos',address:'SYNTHETIC ADDRESS ONLY'},installation_requested:true,lines:[{product:'test-order',sku:'TEST-ORDER-1',quantity:1}]}};
   const before=one('select count(*) from hardware_reservations');
   const saved=await post('submit',body);if(saved.status!==201)throw Error(JSON.stringify(saved));
   const replay=await post('submit',body);
   check('DF-REQUEST','request/retry create one order, no hold or payable state',replay.status===200&&replay.data.order.id===saved.data.order.id&&before===one('select count(*) from hardware_reservations')&&one(`select reservation_state||':'||payment_state||':'||delivery_state from hardware_orders where id='${saved.data.order.id}'`)==='not_reserved:not_started:unconfirmed');
   return saved.data.order.id;
 };
 const login=await fetch(app.url+'/api/lead-agents/admin/session/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'creator@fixture.test',password:'Isolated-Only-'+RUN})});
 if(login.status!==200)throw Error('fixture login failed');
 const cookie=login.headers.getSetCookie().find(x=>x.startsWith('lead_agents_admin=')).split(';')[0];
 const delivery=async id=>{
   const res=await fetch(app.url+'/api/lead-agents/admin/hardware-orders/'+id+'/delivery',{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({gross_kobo:2500,tax_kobo:0,evidence:'SYNTHETIC SERVICEABILITY AND DELIVERY CHARGE CONFIRMED'})});
   check('DF-STAFF','authorized staff confirms delivery with payment execution OFF',res.status===200,await res.json());
 };
 const total=id=>Number(one(`select payable_total_kobo from hardware_orders where id='${id}'`));
 const prepareSql=id=>`select hardware_checkout_prepare_payment('checkout','${guest}','${id}',${total(id)})`;
 const release=id=>run(`select hardware_reservation_finish('${id}','released','fixture','Synthetic cleanup')`);
 try {
   const id=await create();
   let snap=count();r=await post('payment-prepare',{...ownership(id),accepted_total_kobo:107500});
   check('DF-UNCONFIRMED','delivery-unconfirmed order cannot reserve for payment',r.status===409&&count()===snap,r);
   await delivery(id);
   snap=count();r=await post('payment-quote',ownership(id));
   check('DF-READONLY','readiness exposes total and preparation action without mutation',r.status===200&&r.data.payment.can_prepare===true&&r.data.payment.eligible===false&&r.data.payment.amount_kobo===total(id)&&count()===snap,r);
   for(const credential of ['', 'isolated-payments-'+RUN]) {
     r=await post('payment-prepare',{...ownership(id),accepted_total_kobo:total(id)},credential);
     check('DF-SCOPE','unrelated caller cannot prepare stock',r.status===401||r.status===403,r);
   }
   r=await post('payment-prepare',{id,guest_hash:'e'.repeat(64),accepted_total_kobo:total(id)});
   check('DF-OWNER','different guest receives 404',r.status===404&&count()===snap,r);
   r=await post('payment-prepare',{...ownership(id),accepted_total_kobo:1});
   check('DF-AMOUNT','changed/unaccepted total refused without mutation',r.status===409&&r.data.error==='payment_total_changed'&&count()===snap,r);
   const authCount=one('select count(*) from hardware_payment_authorizations');
   const races=await concurrentSql(Array(4).fill(prepareSql(id)));
   check('DF-RACE','four concurrent preparations produce one immutable hold',races.every(x=>x.code===0)&&one(`select count(*) from hardware_reservations where order_id='${id}'`)==='1'&&one(`select count(*) from hardware_reservation_events where reservation_id=(select id from hardware_reservations where order_id='${id}')`)==='1',races);
   r=await post('payment-prepare',{...ownership(id),accepted_total_kobo:total(id)});
   check('DF-REPLAY','lost response/retry returns same eligible hold without financial intent',r.status===200&&r.data.payment.eligible===true&&r.data.payment.can_prepare===false&&authCount===one('select count(*) from hardware_payment_authorizations'),r);
   r=await post('payment-start',{...ownership(id),accepted_total_kobo:total(id)});
   check('DF-DISABLED','initialization still 503 and no authorization created',r.status===503&&r.data.error==='payments_disabled'&&authCount===one('select count(*) from hardware_payment_authorizations'),r);
   run(`select hardware_payment_authorize('checkout','${guest}','${id}',${total(id)})`);
   snap=count();r=await post('payment-prepare',{...ownership(id),accepted_total_kobo:total(id)});
   check('DF-UNCERTAIN','existing authorization cannot be prepared again or replaced',r.status===409&&r.data.error==='payment_already_started'&&count()===snap,r);
   release(id);
   const changed=await create();await delivery(changed);
   for(const [mutation,code] of [[`update catalogue_variants set sourcing='supplier_sourced' where id='${vid}'`,'stock_unavailable'],[`update catalogue_variants set price_ngn_kobo=price_ngn_kobo+1 where id='${vid}'`,'price_not_verified'],[`select catalogue_public_withdraw((select product_id from catalogue_variants where id='${vid}'),(select row_version from catalogue_public_listings where product_id=(select product_id from catalogue_variants where id='${vid}')),'fixture','SYNTHETIC WITHDRAWAL CHECK')`,'product_unavailable']]) {
     snap=count();const result=psql('begin;'+mutation+';'+prepareSql(changed)+';rollback;');
     check('DF-RECHECK','unavailable/changed/withdrawn catalogue refuses hold',result.status!==0&&result.err.includes(code)&&count()===snap,result.err);
   }
   run(`select hardware_order_cancel('canceller@fixture.test','${changed}',1)`);
   r=await post('payment-prepare',{...ownership(changed),accepted_total_kobo:total(changed)});
   check('DF-CANCEL','cancelled order cannot prepare',r.status===409,r);
   const expired=one("select r.order_id from hardware_reservations r join hardware_checkout_receipts c on c.order_id=r.order_id where r.expires_at<=clock_timestamp() and c.client='payment-test' limit 1");
   if(!expired)throw Error('existing expiry regression fixture missing');
   snap=count();const before=one(`select row_to_json(r)::text from hardware_reservations r where order_id='${expired}'`);
   const ex=psql(`select hardware_checkout_prepare_payment('payment-test','${'a'.repeat(64)}','${expired}',${total(expired)})`);
   check('DF-EXPIRED','historical expired hold/evidence unchanged and never reused',ex.status!==0&&count()===snap&&before===one(`select row_to_json(r)::text from hardware_reservations r where order_id='${expired}'`),ex.err);
   check('DF-ACL','functions invoker, pinned path, service only',one("select bool_and(not prosecdef and proconfig=array['search_path=public, pg_temp'] and not has_function_privilege('anon',oid,'execute') and not has_function_privilege('authenticated',oid,'execute')) from pg_proc where proname in ('hardware_checkout_payment_readiness','hardware_checkout_prepare_payment')")==='t');
 } finally { await app.stop(); }
};
