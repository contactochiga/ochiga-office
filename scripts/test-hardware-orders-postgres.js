// Stage 4A integration and migration gate tests. Uses disposable Supabase Postgres,
// PostgREST and the real Office HTTP server with synthetic identities only.
// Infrastructure setup is adapted from test-catalogue-postgres.js; no production URL is accepted.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { hashPassword } = require("../src/lead-agents/auth");
const { runCatalogueScenarios, startRevalidator, testUsers } = require("./catalogue-scenarios");

const ROOT = path.resolve(__dirname, "..");
const PG_IMAGE = process.env.PG_IMAGE || "public.ecr.aws/supabase/postgres:17.6.1.131";
const PGRST_IMAGE = process.env.PGRST_IMAGE || "public.ecr.aws/supabase/postgrest:v14.12";
const RUN = crypto.randomBytes(3).toString("hex");
const NET = `cat-net-${RUN}`, PG = `cat-pg-${RUN}`, REST = `cat-rest-${RUN}`;
const PW = `pw_${crypto.randomBytes(10).toString("hex")}`, JWT_SECRET = crypto.randomBytes(24).toString("hex");
const CATALOGUE_KEY = `oyicat_${crypto.randomBytes(24).toString("hex")}`, REVALIDATE_SECRET = crypto.randomBytes(24).toString("hex");
const SITE_KEY = `oyi_${crypto.randomBytes(24).toString("hex")}`, FULL_KEY = `full_${crypto.randomBytes(12).toString("hex")}`;
const SESSION_SECRET = crypto.randomBytes(24).toString("hex");
const MIGRATION = path.join(ROOT, "db", "20261102_catalogue_foundation.sql");
const ROLLBACK = path.join(ROOT, "db", "rollback", "20261102_catalogue_foundation.down.sql");
// follow-up catalogue migrations, applied (in order) right after 20261102
const CATALOGUE_FOLLOWUPS = fs.readdirSync(path.join(ROOT, "db")).filter((f) => /^202611(0[3-9]|[1-9]\d)_catalogue_.*\.sql$/.test(f)).sort();
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0, failures = 0;
const check = (id, text, cond, detail) => { checks += 1; if (!cond) failures += 1; console.log(`${cond ? "PASS" : "FAIL"} ${id} ${text}${cond ? "" : " :: " + String(JSON.stringify(detail === undefined ? null : detail)).slice(0, 600)}`); };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });
const cleanup = [];

function psql(sql, { stop = true, user = "postgres" } = {}) {
  const r = sh("docker", ["exec", "-i", PG, "psql", "-X", "-q", "-At", "-U", user, "-d", "postgres", "-v", `ON_ERROR_STOP=${stop ? 1 : 0}`], { input: sql });
  return { status: r.status, out: (r.stdout || "").trim(), err: r.stderr || "" };
}
const one = (sql) => psql(sql).out;
const applyFile = (file, opts) => psql(fs.readFileSync(file, "utf8"), opts);
function jwt(role) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b({ alg: "HS256", typ: "JWT" }), body = b({ role, iss: "catalogue-test", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7200 });
  return `${head}.${body}.${crypto.createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`;
}

const TABLES = ["catalogue_merchandising", "catalogue_merchandising_versions", "catalogue_merchandising_events", "office_suppliers", "catalogue_categories", "catalogue_brands", "catalogue_products", "catalogue_product_versions", "catalogue_reviews", "catalogue_publication_events", "catalogue_variants", "catalogue_price_changes", "catalogue_price_decisions", "catalogue_inventory_changes", "catalogue_variant_costs", "catalogue_media", "catalogue_media_derivatives", "catalogue_public_listings", "catalogue_public_events", "catalogue_slug_redirects", "catalogue_preview_grants"];
// catalogue_media allows exactly one update (active -> removed, unreferenced only), tested separately in DBM1; everything else refused
const APPEND_ONLY = ["catalogue_merchandising_versions", "catalogue_merchandising_events", "catalogue_product_versions", "catalogue_reviews", "catalogue_publication_events", "catalogue_price_changes", "catalogue_price_decisions", "catalogue_inventory_changes", "catalogue_variant_costs", "catalogue_media", "catalogue_media_derivatives", "catalogue_public_events", "catalogue_slug_redirects"];
const MEDIA_ROLLBACK = path.join(ROOT, "db", "rollback", "20261104_catalogue_media.down.sql");
const PUBLIC_ROLLBACK = path.join(ROOT, "db", "rollback", "20261105_catalogue_public_release.down.sql");
const FN_TOTAL = "29"; // 11 foundation + 5 media + 12 public release + 1 merchandising
const inList = (list) => list.map((t) => `'${t}'`).join(",");

async function setup() {
  for (const img of [PG_IMAGE, PGRST_IMAGE]) if (sh("docker", ["image", "inspect", img]).status !== 0) throw new Error(`BLOCKED: docker image ${img} not available`);
  sh("docker", ["network", "create", NET]); cleanup.push(() => sh("docker", ["network", "rm", NET]));
  let r = sh("docker", ["run", "-d", "--rm", "--name", PG, "--network", NET, "--network-alias", "pg", "-e", `POSTGRES_PASSWORD=${PW}`, PG_IMAGE]);
  if (r.status !== 0) throw new Error("BLOCKED: postgres container: " + r.stderr);
  cleanup.unshift(() => sh("docker", ["rm", "-f", PG]));
  let good = 0;
  for (let i = 0; i < 400 && good < 3; i += 1) { const x = sh("docker", ["exec", PG, "psql", "-X", "-At", "-U", "postgres", "-h", "127.0.0.1", "-c", "select count(*) from pg_roles where rolname in ('anon','authenticated','service_role','authenticator')"]); good = x.stdout && x.stdout.trim() === "4" ? good + 1 : 0; await sleep(300); }
  if (good < 3) throw new Error("BLOCKED: postgres not ready");
  psql(fs.readFileSync(path.join(ROOT, "db", "lead-agents-schema.sql"), "utf8"), { stop: false });
  const second = psql(fs.readFileSync(path.join(ROOT, "db", "lead-agents-schema.sql"), "utf8"), { stop: false });
  check("M00", "bootstrap schema: second pass is clean", !/ERROR/.test(second.err), second.err.slice(0, 300));
  const dated = fs.readdirSync(path.join(ROOT, "db")).filter((f) => /^2026\d+.*\.sql$/.test(f) && f !== path.basename(MIGRATION) && !CATALOGUE_FOLLOWUPS.includes(f) && f !== "20261107_hardware_orders.sql").sort();
  const failed = dated.map((f) => ({ f, r: applyFile(path.join(ROOT, "db", f)) })).filter((x) => x.r.status !== 0);
  check("M01", "every earlier dated migration (incl. 20261101 intake receipts) applies", failed.length === 0, failed.map((x) => x.f + ": " + x.r.err.slice(0, 200)));
  // the production hardening state measured in R11 (RLS everywhere, nothing for PUBLIC/anon/authenticated, schema USAGE closed)
  const p0 = psql(`
    revoke all on all tables in schema public from public, anon, authenticated;
    revoke all on all sequences in schema public from public, anon, authenticated;
    revoke all on all functions in schema public from public, anon, authenticated;
    do $$ declare r record; begin for r in select c.oid::regclass as rel from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') loop execute format('alter table %s enable row level security', r.rel); end loop; end $$;
    grant usage on schema public to service_role, authenticator, postgres;
    revoke usage on schema public from public, anon, authenticated;
    alter default privileges in schema public revoke all on tables from anon, authenticated;
    alter default privileges in schema public revoke all on functions from anon, authenticated;
    alter default privileges in schema public grant all on tables to service_role;
    alter default privileges in schema public grant all on functions to service_role;`);
  check("M02", "production hardening state (and production's default privileges for service_role) applied to the fixture", p0.status === 0, p0.err.slice(0, 300));
  sh("docker", ["exec", PG, "psql", "-X", "-U", "supabase_admin", "-d", "postgres", "-h", "127.0.0.1", "-c", `alter role authenticator with password '${PW}'`]);
  const restPort = await freePort();
  r = sh("docker", ["run", "-d", "--rm", "--name", REST, "--network", NET, "-p", `127.0.0.1:${restPort}:3000`, "-e", `PGRST_DB_URI=postgres://authenticator:${PW}@pg:5432/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`, "-e", "PGRST_SERVER_PORT=3000", "-e", "PGRST_DB_POOL=20", PGRST_IMAGE]);
  if (r.status !== 0) throw new Error("BLOCKED: postgrest container: " + r.stderr);
  cleanup.unshift(() => sh("docker", ["rm", "-f", REST]));
  const restUrl = `http://127.0.0.1:${restPort}`;
  for (let i = 0; i < 200; i += 1) { const x = await fetch(restUrl + "/", { headers: { authorization: `Bearer ${jwt("service_role")}` } }).catch(() => null); if (x && x.status === 200) break; await sleep(300); }
  const gwPort = await freePort();
  // Supabase Storage stand-in (object upload / download / delete on a private bucket, service-role key required), so the media pipeline
  // runs through Office's real "supabase" storage driver as in production. Not-found mimics the live API (400 wrapping a 404).
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-pg-storage-"));
  const typeDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-pg-storage-types-"));
  const gw = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const so = req.url.match(/^\/storage\/v1\/object\/([^/]+)\/([^/?]+)$/);
    if (so) {
      const [h, b, sig] = String(req.headers.authorization || "").replace(/^Bearer /, "").split(".");
      const validService = sig && crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${b}`).digest("base64url") === sig && JSON.parse(Buffer.from(b, "base64url").toString()).role === "service_role";
      if (!validService) { res.writeHead(403, { "content-type": "application/json" }); res.end('{"statusCode":"403","error":"Unauthorized"}'); return; }
      const name = path.basename(decodeURIComponent(so[2]));
      const file = path.join(storageDir, name), typeFile = path.join(typeDir, name);
      const missing = () => { res.writeHead(400, { "content-type": "application/json" }); res.end('{"statusCode":"404","error":"not_found","message":"Object not found"}'); };
      if (req.method === "POST") { fs.writeFileSync(file, Buffer.concat(chunks)); fs.writeFileSync(typeFile, String(req.headers["content-type"] || "")); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ Key: `${so[1]}/${so[2]}` })); return; }
      if (!fs.existsSync(file)) return missing();
      if (req.method === "GET") { res.writeHead(200, { "content-type": fs.readFileSync(typeFile, "utf8") || "application/octet-stream" }); res.end(fs.readFileSync(file)); return; }
      if (req.method === "DELETE") { fs.unlinkSync(file); fs.rmSync(typeFile, { force: true }); res.writeHead(200, { "content-type": "application/json" }); res.end("[]"); return; }
      res.writeHead(405); res.end(); return;
    }
    const target = restUrl + req.url.replace(/^\/rest\/v1/, "");
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "connection", "content-length"].includes(k)));
    try {
      const up = await fetch(target, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !["content-encoding", "transfer-encoding", "content-length"].includes(k)))); res.end(buf);
    } catch { res.writeHead(502); res.end(); }
  });
  await new Promise((r2) => gw.listen(gwPort, "127.0.0.1", r2)); cleanup.unshift(() => gw.close());
  return { restUrl, gatewayUrl: `http://127.0.0.1:${gwPort}`, storageDir };
}

async function rest(restUrl, role, method, p, body) {
  const r = await fetch(restUrl + p, { method, headers: { "content-type": "application/json", ...(role ? { authorization: `Bearer ${jwt(role)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}
async function reloadSchema(restUrl) {
  psql("notify pgrst, 'reload schema'");
  for (let i = 0; i < 60; i += 1) { await sleep(250); const r = await rest(restUrl, "service_role", "POST", "/rpc/catalogue_schema_version", {}); if (r.status === 200) break; }
  await sleep(500);
}

async function startApp(gatewayUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-pg-app-"));
  const port = await freePort();
  const logs = [];
  const proc = spawn(process.execPath, ["lead-agents-server.js"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: dir, NODE_ENV: "test", LEAD_AGENTS_HOST: "127.0.0.1", LEAD_AGENTS_PORT: String(port), OFFICE_STORAGE_DIR: path.join(dir, "storage"), OFFICE_HARDWARE_ORDERS_ENABLED: "true",
      LEAD_AGENTS_STORE_DRIVER: "supabase", SUPABASE_URL: gatewayUrl, SUPABASE_SERVICE_ROLE_KEY: jwt("service_role"),
      LEAD_AGENTS_AUTH_MODE: "required_api_key", LEAD_AGENTS_API_KEYS: FULL_KEY, LEAD_AGENTS_SESSION_SECRET: SESSION_SECRET,
      LEAD_AGENTS_SCOPED_API_KEYS: JSON.stringify([{ client: "getoyi", key_sha256: sha(SITE_KEY), scopes: ["intake.submit"] }, { client: "getoyi-catalogue", key_sha256: sha(CATALOGUE_KEY), scopes: ["catalogue.public.read"] }]),
      GETOYI_REVALIDATE_URL: process.env.__REVALIDATE_URL || "", GETOYI_REVALIDATE_SECRET: REVALIDATE_SECRET, GETOYI_PUBLIC_BASE_URL: "https://getoyi.example",
      OPENAI_API_KEY: "sk-fixture-not-real", OPENAI_BASE_URL: "http://127.0.0.1:9/v1", LEAD_AGENTS_RATE_LIMIT_MAX_REQUESTS: "100000", LEAD_AGENTS_OFFICE_RATE_LIMIT_MAX_REQUESTS: "100000", LEAD_AGENTS_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "1000",
    },
  });
  proc.stdout.on("data", (d) => logs.push(String(d))); proc.stderr.on("data", (d) => logs.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i += 1) { if (await fetch(url + "/healthz").catch(() => null)) break; await sleep(100); }
  const app = { url, dir, logs, stop: () => new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once("exit", r); proc.kill("SIGTERM"); }) };
  cleanup.unshift(() => app.stop());
  // CATALOGUE_TEST_DEBUG=1 prints the application's error log lines at the end (never set in CI; the AT80 secret check still runs)
  if (process.env.CATALOGUE_TEST_DEBUG) cleanup.unshift(() => console.error(logs.join("").split("\n").filter((l) => /"level":"(error|warn)"/.test(l)).slice(-15).join("\n")));
  return app;
}

// run N statements concurrently in separate psql sessions; returns each session's exit status and output
function concurrentSql(statements, user = "postgres") {
  const procs = statements.map((sql) => spawn("docker", ["exec", "-i", PG, "psql", "-X", "-q", "-At", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "pipe"] }));
  return Promise.all(procs.map((p, i) => new Promise((resolve) => { let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); p.on("close", (code) => resolve({ code, out: out.trim(), err })); p.stdin.end(statements[i]); })));
}

async function main() {
 const {restUrl,gatewayUrl}=await setup();
 for(const f of [MIGRATION,...CATALOGUE_FOLLOWUPS.map(f=>path.join(ROOT,'db',f))]) {const r=applyFile(f);if(r.status)throw Error(r.err)}
 const migration=fs.readFileSync(path.join(ROOT,'db/20261107_hardware_orders.sql'),'utf8');
 const before=psql('begin;'+migration+'rollback;');
 check('M1','transaction rollback removes all new order objects',before.status===0&&one("select to_regclass('hardware_orders') is null")==='t',before.err);
 const preGate=fs.readFileSync(path.join(ROOT,'release/phase4a-gate/production-rollout-gates.sql'),'utf8').trim().replace(/;$/, '');
 const preRows=JSON.parse(one(`select jsonb_agg(g) from (${preGate}) g`));check('G0','gate permits wholly absent Stage 4A',preRows.find(r=>r.gate.startsWith('VERDICT')).status==='GO'&&preRows.find(r=>r.gate.startsWith('STAGE P4A')).status==='ABSENT');
 const applied=psql('begin;'+migration+'commit;');if(applied.status)throw Error(applied.err);
 const shapeSql=fs.readFileSync(path.join(ROOT,'release/phase4a-gate/order-shape.sql'),'utf8');
 check('SHAPE','exact frozen order manifest matches fixture',JSON.stringify(JSON.parse(one(shapeSql)))===JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT,'release/phase4a-gate/reviewed-shape.json'),'utf8'))));
 const gateSql=fs.readFileSync(path.join(ROOT,'release/phase4a-gate/production-rollout-gates.sql'),'utf8').trim().replace(/;$/, '');
 const gate=(mutation='')=>{const r=psql(`begin;${mutation};select jsonb_agg(g) from (${gateSql}) g;rollback;`);if(r.status)throw Error(r.err);return JSON.parse(r.out.split('\n').filter(Boolean).pop())};
 const rows=gate();check('G1','all baseline checks pass with P4A applied',rows.find(r=>r.gate.startsWith('VERDICT')).status==='GO',rows.filter(r=>r.status==='FAIL'||r.status==='PARTIAL'));
 for(const mutation of ['alter table hardware_orders disable row level security','grant select on hardware_order_private to anon','grant truncate on hardware_order_events to service_role','alter table hardware_order_lines disable trigger order_immutable','alter function hardware_order_create(text,text,jsonb) security definer','alter function hardware_order_create(text,text,jsonb) set search_path=public','grant execute on function hardware_order_create(text,text,jsonb) to authenticated','alter table hardware_orders drop constraint hardware_orders_payment_state_check']) {
  const r=gate(mutation);check('GNEG','tampered schema refused: '+mutation,r.find(x=>x.gate.startsWith('VERDICT')).status!=='GO');
 }
 const scopes={creator:['commerce.orders.read','commerce.orders.create'],reader:['commerce.orders.read'],privateReader:['commerce.orders.read','commerce.orders.customer.read'],canceller:['commerce.orders.read','commerce.orders.cancel'],plain:[]};
 const password='Isolated-Only-'+RUN;
 for(const [name,sc] of Object.entries(scopes)) {const r=psql(`insert into admin_users(email,password_hash,role,status,permission_scopes) values('${name.toLowerCase()}@fixture.test','${hashPassword(password)}','ochiga_staff','active',array[${sc.map(x=>`'${x}'`).join(',')}]::text[])`);if(r.status)throw Error(r.err)}
 const contact=one("insert into crm_contacts(name,email,phone) values('LOCAL TEST','private@fixture.test','TEST-PRIVATE-PHONE') returning id");
 const category=one('select id from catalogue_categories limit 1');
 const content=JSON.stringify({name:'LOCAL TEST product',variants:[{sku:'TEST-ORDER-1',name:'Option'}]});
 const pid=one(`select catalogue_create_product('test-order','${category}',null,'${content}','author@fixture.test')->>'id'`);
 const vid=one(`select id from catalogue_variants where product_id='${pid}'`);
 for(const [action,rv,actor] of [['submit',1,'author'],['approve',2,'reviewer'],['publish',3,'author']]){const r=psql(`select catalogue_transition('${pid}',${rv},'${action}','${actor}@fixture.test','','')`);if(r.status)throw Error(r.err)}
 const pc=one(`select catalogue_request_price_change('${vid}',107500,'standard',750,'author@fixture.test','')->>'id'`);
 psql(`select catalogue_decide_price_change('${pc}','approved','reviewer@fixture.test',''); select catalogue_publish_price_change('${pc}','author@fixture.test');`);
 await reloadSchema(restUrl);const app=await startApp(gatewayUrl);const cookies={};
 for(const name of Object.keys(scopes)) {const r=await fetch(app.url+'/api/lead-agents/admin/session/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:name.toLowerCase()+'@fixture.test',password})});if(r.status!==200)throw Error('login '+r.status);cookies[name]=r.headers.getSetCookie().find(h=>h.startsWith('lead_agents_admin=')).split(';')[0]}
 const api=async(who,method,p='',body,headers={})=>{const r=await fetch(app.url+'/api/lead-agents/admin/hardware-orders'+p,{method,headers:{cookie:cookies[who]||'',origin:app.url,'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),headers:r.headers}};
 const request={contact_id:contact,delivery:{country:'NG',state:'Plateau',city:'Jos',address:'LOCAL TEST ADDRESS'},installation_requested:true,lines:[{variant_id:vid,quantity:2}]};
 const body={idempotency_key:'stage4a-isolated-key-1',order:request};
 for(const [who,headers] of [[null,{}],[null,{'x-api-key':FULL_KEY}],[null,{'x-api-key':SITE_KEY}],[null,{'x-api-key':CATALOGUE_KEY}],['plain',{}]]){const r=await api(who,'GET','',undefined,headers);check('AUTH','unauthorized session/key boundary',r.status===401||r.status===403,r.status)}
 check('BODY','missing order body rejected',(await api('creator','POST','',{})).status===400);
 const cross=await api('creator','POST','',body,{origin:'https://untrusted.invalid'});check('CSRF','foreign origin denied',cross.status===403);
 const cr=await api('creator','POST','',body);check('C1','creates durable order',cr.status===201,cr);if(cr.status!==201)throw Error(psql(`select hardware_order_create('creator@fixture.test','stage4a-debug-key','${JSON.stringify(request)}'::jsonb)`).err);const id=cr.data.order.id;
 const detail=await api('reader','GET','/'+id);
 check('C2','server approved price and VAT-inclusive tax snapshot',detail.data.order.goods_total_kobo===215000&&detail.data.order.goods_tax_kobo===15000&&detail.data.lines[0].price_change_id===pc,detail.data);
 check('C3','no pay, fulfil or reservation capability; unknown delivery is not free',detail.data.payment_eligible===false&&detail.data.order.payable_total_kobo===null&&detail.data.order.delivery_total_kobo===null&&detail.data.order.payment_state==='not_started'&&detail.data.order.reservation_state==='not_reserved',detail.data.order);
 check('C4','supplier sourcing remains confirmation-only',detail.data.lines[0].availability_at_creation==='confirmation_required');
 check('P1','reader response excludes customer/address/contact refs',!JSON.stringify(detail.data).includes('PRIVATE')&&!detail.data.order.contact_id&&!detail.data.private);
 check('P2','private customer access separately denied',(await api('reader','GET','/'+id+'?customer=true')).status===403);
 const priv=await api('privateReader','GET','/'+id+'?customer=true');check('P3','private permission reads CRM snapshot/address and no-store',priv.status===200&&priv.data.private.customer.email==='private@fixture.test'&&priv.headers.get('cache-control').includes('no-store'),priv);
 const replay=await api('creator','POST','',body);check('I1','retry returns same ID without duplicate event',replay.status===200&&replay.data.order.id===id&&one(`select count(*) from hardware_order_events where order_id='${id}'`)==='1');
 const conflict=await api('creator','POST','',{...body,order:{...request,installation_requested:false}});check('I2','key reused for different payload conflicts',conflict.status===409&&conflict.data.error==='idempotency_conflict',conflict);
 const race=await Promise.all(Array.from({length:6},()=>api('creator','POST','',{...body,idempotency_key:'stage4a-isolated-race'})));
 check('I3','concurrent duplicate creation has one winner',race.filter(x=>x.status===201).length===1&&race.every(x=>x.status===200||x.status===201)&&new Set(race.map(x=>x.data.order.id)).size===1,race.map(x=>x.status));
 let k=0;const invalid=async(order,code)=>{const r=await api('creator','POST','',{idempotency_key:'invalid-isolated-key-'+(++k),order});check('V'+k,code,r.data.error===code,r);};
 await invalid({...request,price:1},'invalid_order_input');
 await invalid({...request,lines:[{variant_id:vid,quantity:2,unit_price_kobo:1}]},'invalid_order_lines');
 await invalid({...request,lines:[{variant_id:vid,quantity:0}]},'invalid_quantity');
 await invalid({...request,lines:[{variant_id:vid,quantity:1.5}]},'invalid_order_lines');
 await invalid({...request,lines:[request.lines[0],request.lines[0]]},'duplicate_variant');
 await invalid({...request,contact_id:crypto.randomUUID()},'invalid_crm_reference');
 await invalid({...request,delivery:{...request.delivery,country:'XX'}},'invalid_delivery');
 await invalid({...request,payment_state:'paid'},'invalid_order_input');
 check('AUTH2','reader cannot create',(await api('reader','POST','',body)).status===403);
 const change=one(`select catalogue_request_price_change('${vid}',215000,'standard',750,'author@fixture.test','')->>'id'`);
 psql(`select catalogue_decide_price_change('${change}','approved','reviewer@fixture.test','');select catalogue_publish_price_change('${change}','author@fixture.test');`);
 check('I4','idempotent retry after price move returns original order',(await api('creator','POST','',body)).data.order.id===id);
 const newer=await api('creator','POST','',{...body,idempotency_key:'stage4a-new-price-key'});const newerDetail=await api('reader','GET','/'+newer.data.order.id);
 check('F1','new order reprices; prior financial snapshot unchanged',newerDetail.data.order.goods_total_kobo===430000&&(await api('reader','GET','/'+id)).data.order.goods_total_kobo===215000);
 const countBefore=one('select count(*) from hardware_orders');
 psql(`update catalogue_variants set status='inactive' where id='${vid}'`);
 await invalid(request,'variant_unavailable');
 psql(`update catalogue_variants set status='active',price_ngn_kobo=999 where id='${vid}'`);
 await invalid(request,'price_not_verified');
 psql(`update catalogue_variants set price_ngn_kobo=215000 where id='${vid}'`);
 psql(`select catalogue_transition('${pid}',4,'unpublish','author@fixture.test','','')`);
 await invalid(request,'product_not_approved');
 check('ATOMIC','rejected commercial requests leave no orders or events',one('select count(*) from hardware_orders')===countBefore&&one('select count(*) from hardware_order_events')===countBefore);
 const cancel=await api('canceller','POST','/'+id+'/cancel',{expected_row_version:1});check('S1','authorized cancel records conditional status transition',cancel.status===200&&cancel.data.order.row_version===2,cancel);
 check('S2','identical cancellation retry is idempotent',(await api('canceller','POST','/'+id+'/cancel',{expected_row_version:1})).status===200&&one(`select count(*) from hardware_order_events where order_id='${id}'`)==='2');
 check('S3','reader cannot cancel',(await api('reader','POST','/'+id+'/cancel',{expected_row_version:2})).status===403);
 check('S4','client payment-success transition does not exist',(await api('creator','POST','/'+id+'/paid',{})).status===405);
 for(const sql of [`update hardware_orders set goods_total_kobo=1 where id='${id}'`,`update hardware_orders set payment_state='paid' where id='${id}'`,`update hardware_order_lines set unit_price_kobo=1 where order_id='${id}'`,`delete from hardware_order_events where order_id='${id}'`,`update hardware_order_private set delivery='{}' where order_id='${id}'`,`truncate hardware_order_events`]){const r=psql('set role service_role;'+sql);check('IMM','financial/private/history mutation denied',r.status!==0,r.err)}
 check('AUD1','creation/cancel/privacy audit events match resource',one(`select count(distinct action) from audit_events where target_id='${id}' and action in ('hardware_order_created','hardware_order_cancelled','hardware_order_customer_viewed')`)==='3');
 check('CRM','one creation and one cancellation activity linked to customer',one(`select count(*) from crm_activities where related_id='${id}' and contact_id='${contact}'`)==='2');
 check('AUD2','write audit metadata excludes customer and delivery',one("select count(*) from audit_events where action like 'hardware_order_%' and metadata::text ~ 'PRIVATE|private@fixture|LOCAL TEST ADDRESS'")==='0');
 const tables=['hardware_orders','hardware_order_private','hardware_order_lines','hardware_order_events'];
 for(const t of tables){check('DB','RLS / anonymous grants / no truncate '+t,one(`select relrowsecurity and not has_table_privilege('anon','${t}','SELECT') and not has_table_privilege('authenticated','${t}','SELECT') and not has_table_privilege('service_role','${t}','TRUNCATE') from pg_class where oid='${t}'::regclass`)==='t');}
 check('DBFN','functions invoker, pinned path, service-only execute',one("select count(*) from pg_proc p where pronamespace='public'::regnamespace and proname like 'hardware_order_%' and (prosecdef or proconfig is distinct from array['search_path=public, pg_temp'] or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))")==='0');
 check('HIGH1','direct status mutation without evidence denied',psql(`update hardware_orders set order_state='cancelled',row_version=2 where id='${newer.data.order.id}'`).status!==0);
 check('HIGH2','late status event injection denied',psql(`insert into hardware_order_events(order_id,event_type,row_version,actor) values('${id}','cancelled',99,'creator@fixture.test')`).status!==0);
 const hist=one('select count(*) from hardware_order_events');const reapplied=psql(migration);check('M2','reapply preserves history',reapplied.status===0&&one('select count(*) from hardware_order_events')===hist,reapplied.err);
 check('ISOLATION','no stock reservations consumed',one(`select stock_reserved from catalogue_variants where id='${vid}'`)==='0');
 console.log(JSON.stringify({suite:'hardware-orders-stage4a',checks,failed:failures}));
}
main().catch(e=>{console.error(e);failures++}).finally(async()=>{for(const f of cleanup){try{await f()}catch{}}process.exit(failures?1:0)});
