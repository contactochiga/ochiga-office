'use strict';
const assert=require('node:assert/strict');
const {hasPermission}=require('../src/lead-agents/permissions');
const {handleHardwareOrdersRequest}=require('../src/lead-agents/hardware-orders-api');
(async()=>{
 for(const role of ['ochiga_admin','ochiga_staff','estate_admin']) for(const permission of ['commerce.orders.read','commerce.orders.create','commerce.orders.cancel','commerce.orders.customer.read']) assert.equal(hasPermission({type:'session',role},permission),false);
 assert.equal(hasPermission({type:'session',role:'super_admin'},'commerce.orders.read'),true);
 delete process.env.OFFICE_HARDWARE_ORDERS_ENABLED;
 let status,body;const res={setHeader(){},writeHead(s){status=s},end(x){body=JSON.parse(x)}};
 const handled=await handleHardwareOrdersRequest({req:{method:'POST',url:'/api/lead-agents/admin/hardware-orders'},res,pathname:'/api/lead-agents/admin/hardware-orders',authContext:{type:'session',role:'super_admin'},store:{}});
 assert.equal(handled,true);assert.equal(status,503);assert.equal(body.error,'orders_disabled');
 assert.equal(await handleHardwareOrdersRequest({pathname:'/api/office/intake'}),false);
 console.log('17 permission/disabled-route/isolation assertions passed');
})().catch(e=>{console.error(e);process.exitCode=1});
