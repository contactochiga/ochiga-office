const assert=require('assert/strict'),crypto=require('crypto');
const {createConfig}=require('../src/lead-agents/config');
const key='SYNTHETIC_LOCAL_SCOPE_TEST';
process.env.LEAD_AGENTS_SCOPED_API_KEYS=JSON.stringify([{client:'hardware-recovery',key_sha256:crypto.createHash('sha256').update(key).digest('hex'),scopes:['commerce.payment.operations','unknown.scope']}]);
const config=createConfig();assert.equal(config.scopedApiKeys.length,1);assert.deepEqual(config.scopedApiKeys[0].scopes,['commerce.payment.operations']);
console.log('Financial scope survives real configuration parsing; unknown scopes remain denied PASS');
