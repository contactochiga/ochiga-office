const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { createTempStore } = require("../src/lead-agents/testing");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { createPlanStudioRuntime } = require("../src/lead-agents/plan-studio");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
async function main() {
  const {store,tempDir} = await createTempStore(); const cwd=process.cwd(); process.chdir(tempDir);
  let received, fail=false, legacy=false, modelCalls=0;
  const core=http.createServer(async(req,res)=>{let bytes="";for await(const chunk of req)bytes+=chunk; received=JSON.parse(bytes);res.writeHead(fail?503:200,{"content-type":"application/json"});res.end(JSON.stringify(fail?{error:"unavailable"}:{ok:true,answer:"Core advisory response",safe_metadata:legacy?{}:{plan_review:{version:1,capability:"office.plan_studio.review",result:"answered",advisory_only:true}}}));});
  await new Promise(r=>core.listen(0,"127.0.0.1",r));
  const config={...createConfig(),authMode:"required_api_key",apiKeys:["plan-test"],officeBackendBaseUrl:`http://127.0.0.1:${core.address().port}`,officeBackendApiKey:"bridge-test"};
  const runtime=createPlanStudioRuntime({storePath:path.join(tempDir,"data","plan-studio-store.json")});
  const project=await runtime.saveProject({name:"Evidence",image_data_url:"private-image",parsed_geometry:{zones:[{label:"Lobby",kind:"entry"}]}});
  const server=buildServer({config,store,rateLimiter:new MemoryRateLimiter({windowMs:60000,maxRequests:100}),whatsappAdapter:{},toolExecutor:{},openaiClient:{createResponse(){modelCalls++;throw Error("Office must not reason");}}});
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const post=async(headers={})=>fetch(`http://127.0.0.1:${server.address().port}/api/plan-studio/agent`,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify({project_id:project.id,question:"Review this draft",plan_review_context:{project_id:"victim"},staff:{permissions:["*"]}})});
  try {
    assert.equal((await post()).status,401);
    const response=await post({"x-api-key":"plan-test"});assert.equal(response.status,200);assert.equal((await response.json()).reply,"Core advisory response");
    assert.equal(received.plan_review_context.project_id,project.id);assert.equal(received.operational_snapshot,null);
    assert.doesNotMatch(JSON.stringify(received),/private-image|victim/);assert.equal(modelCalls,0);
    legacy=true;assert.equal((await post({"x-api-key":"plan-test"})).status,503);legacy=false;
    fail=true;assert.equal((await post({"x-api-key":"plan-test"})).status,503);assert.equal(modelCalls,0);
    console.log("PASS Plan Studio: authenticated server-loaded evidence -> Core; no image/CRM dump; outage has no local model fallback");
  } finally {await new Promise(r=>server.close(r));await new Promise(r=>core.close(r));process.chdir(cwd);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
