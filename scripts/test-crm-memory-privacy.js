const assert = require("node:assert/strict");
const { recallCrmMemory, RETENTION_MS } = require("../src/lead-agents/crm-memory-access");
(async () => {
 const now = Date.now();
 const actor = { type:"session",userId:"staff-a",role:"ochiga_staff" };
 let lead={id:"lead-a",owner:"staff-a"};
 let memory={lead_id:"lead-a",updated_at:new Date(now).toISOString(),known_fields:{project_type:"residential",email:"private@example.invalid"},last_summary:"private",tool_calls:["secret"]};
 const store={getLead:async()=>lead,getLeadMemory:async()=>memory};
 const run=(a=actor,id="lead-a")=>recallCrmMemory({store,actor:a,leadId:id,now});
 assert.deepEqual((await run()).known_fields,{project_type:"residential"});
 assert.equal((await run()).last_summary,undefined);
 for(const a of [null,{...actor,userId:"staff-b"},{...actor,type:"api_key"},{...actor,type:"public_session"},{...actor,role:"guest",permissionScopes:["view_dashboard"]},{...actor,organization_id:"other"}]) await assert.rejects(run(a),/access_denied/);
 await assert.rejects(run(actor,"lead-b"),/access_denied/);
 assert(await run({...actor,userId:"manager",role:"ochiga_admin"}));
 memory={...memory,lead_id:"lead-b"};await assert.rejects(run(),/access_denied/);
 memory={...memory,lead_id:"lead-a",estate_id:"other"};await assert.rejects(run(),/access_denied/);
 delete memory.estate_id;
 for(const t of ["invalid",new Date(now+1).toISOString(),new Date(now-RETENTION_MS).toISOString()]){memory.updated_at=t;assert.equal(await run(),null);}
 memory=null;assert.equal(await run(),null);
 lead=null;await assert.rejects(run(),/access_denied/);
 console.log("PASS CRM memory: owner/manager, denied public/API-key/cross-staff/lead/org/estate, bounded fields, expiry, missing/deleted fail closed");
})().catch(e=>{console.error(e);process.exitCode=1});
