"use strict";
// Browser fault-rehearsal host. Separate disposable store, synthetic data only; no production/test-owner writes.
const fs = require("node:fs");
const path = require("node:path");
const { startLocal } = require("./product-import-local");
const { workbook, rows } = require("./test-product-import");
async function startFeedback({directory=path.resolve("outputs/import-feedback-local"),port=0}={}) {
  const app=await startLocal({directory,port});
  const fixture=rows.map(r=>[...r]);fixture[1][0]="SYNTHETIC Feedback One";fixture[1][1]="FEEDBACK-ONE";
  fixture[2][0]="SYNTHETIC Feedback Two";fixture[2][1]="FEEDBACK-TWO";fixture[2][2]="Unmapped category";
  fs.writeFileSync(path.join(directory,"synthetic.xlsx"),workbook(fixture));
  fs.writeFileSync(path.join(directory,"fault.json"),JSON.stringify({mode:"none"}));
  const emit=app.server.emit;
  app.server.emit=function(event,...args){
    if(event!=="request")return emit.call(this,event,...args);
    const [req,res]=args,route=req.url.split("?")[0];
    if(req.method!=="POST"||!/^\/api\/lead-agents\/admin\/catalogue\/imports\/[^/]+\/drafts$/.test(route))return emit.call(this,event,...args);
    const fault=JSON.parse(fs.readFileSync(path.join(directory,"fault.json"),"utf8"));
    const record={method:req.method,route:route.replace(/\/imports\/[^/]+\//,"/imports/:id/"),mode:fault.mode,status:null,error:null};
    const end=res.end;res.end=function(chunk,...rest){try{record.error=JSON.parse(String(chunk)).error||null;}catch{}return end.call(this,chunk,...rest);};
    res.on("finish",()=>{record.status=res.statusCode;fs.appendFileSync(path.join(directory,"requests.jsonl"),JSON.stringify(record)+"\n");});
    if(["server-error","expired-session"].includes(fault.mode)){
      res.writeHead(fault.mode==="server-error"?500:401,{"content-type":"application/json"});res.end(JSON.stringify({error:fault.mode==="server-error"?"synthetic_server_error":"unauthorized"}));return true;
    }
    if(fault.mode==="delay"){setTimeout(()=>emit.call(this,event,...args),1500);return true;}
    return emit.call(this,event,...args);
  };
  return app;
}
if(require.main===module)startFeedback({port:Number(process.argv[2]||4390)}).then(app=>console.log(`Synthetic-only feedback browser host: http://localhost:${app.server.address().port}/office/#/catalogue/import`)).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={startFeedback};
