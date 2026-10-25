// Product catalogue (Phase 1) on DISPOSABLE Postgres (Supabase image) + PostgREST + the real Office server (supabase store driver).
// Never a real project. Proves: the migration applies (twice) on top of every shipped migration and the production hardening state;
// its privilege boundary (nothing for anon/authenticated/PUBLIC, RLS on, no policy, SECURITY INVOKER only, EXECUTE service_role only,
// no TRUNCATE on history); append-only history for EVERY role; separation of duties and exactly-once decisions inside the database
// (also when the application is bypassed); real concurrency; the shared HTTP acceptance scenarios; rollback and re-apply.
// Requires Docker and the images public.ecr.aws/supabase/postgres:17.6.1.131 and public.ecr.aws/supabase/postgrest:v14.12.
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
  const dated = fs.readdirSync(path.join(ROOT, "db")).filter((f) => /^2026\d+.*\.sql$/.test(f) && f !== path.basename(MIGRATION) && !CATALOGUE_FOLLOWUPS.includes(f)).sort();
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
      PATH: process.env.PATH, HOME: dir, NODE_ENV: "test", LEAD_AGENTS_HOST: "127.0.0.1", LEAD_AGENTS_PORT: String(port), OFFICE_STORAGE_DIR: path.join(dir, "storage"),
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
  const { restUrl, gatewayUrl, storageDir } = await setup();

  // ------------------------------------------------------------------------------------------------ migration
  const m1 = applyFile(MIGRATION);
  check("M10", "catalogue migration applies on top of every shipped migration and the hardened schema", m1.status === 0, m1.err.slice(0, 400));
  const followups = CATALOGUE_FOLLOWUPS.map((f) => ({ f, r: applyFile(path.join(ROOT, "db", f)) }));
  check("M10b", `catalogue follow-up migrations apply after 20261102 (${CATALOGUE_FOLLOWUPS.join(", ") || "none"})`, followups.every((x) => x.r.status === 0), followups.map((x) => x.f + ": " + x.r.err.slice(0, 200)));
  const m2 = applyFile(MIGRATION);
  CATALOGUE_FOLLOWUPS.forEach((f) => applyFile(path.join(ROOT, "db", f)));
  check("M11", "…and is idempotent (second apply clean, seed not duplicated)", m2.status === 0 && one("select count(*) from catalogue_categories") === "6", { err: m2.err.slice(0, 300), categories: one("select count(*) from catalogue_categories") });

  // ------------------------------------------------------------------------------------------------ privilege boundary
  const tl = inList(TABLES), al = inList(APPEND_ONLY);
  const exposure = one(`select count(*) from pg_class c, (values ('anon'),('authenticated')) r(r), (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(p)
    where c.relnamespace='public'::regnamespace and c.relname in (${tl}) and has_table_privilege(r.r, c.oid, p.p)`);
  const colExposure = one(`select count(*) from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped, (values ('anon'),('authenticated')) r(r)
    where c.relnamespace='public'::regnamespace and c.relname in (${tl}) and (has_column_privilege(r.r,c.oid,a.attnum,'SELECT') or has_column_privilege(r.r,c.oid,a.attnum,'INSERT') or has_column_privilege(r.r,c.oid,a.attnum,'UPDATE'))`);
  const publicAcl = one(`select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relname in (${tl}) and exists (select 1 from aclexplode(c.relacl) a where a.grantee=0)`);
  check("AT02a", "anon/authenticated/PUBLIC: no table or column privilege on any catalogue table", exposure === "0" && colExposure === "0" && publicAcl === "0", { exposure, colExposure, publicAcl });
  const fnRows = JSON.parse(one(`select coalesce(json_agg(json_build_object('fn', p.oid::regprocedure::text, 'secdef', p.prosecdef, 'config', p.proconfig,
      'anon', has_function_privilege('anon',p.oid,'EXECUTE'), 'authenticated', has_function_privilege('authenticated',p.oid,'EXECUTE'), 'service', has_function_privilege('service_role',p.oid,'EXECUTE'),
      'public', exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a where a.grantee=0))), '[]') from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'catalogue\\_%'`));
  check("AT02b", "29 catalogue functions including merchandising: all SECURITY INVOKER, search_path pinned to public, pg_temp, EXECUTE for service_role only (no PUBLIC/anon/authenticated)",
    fnRows.length === Number(FN_TOTAL) && fnRows.every((f) => !f.secdef && JSON.stringify(f.config) === JSON.stringify(["search_path=public, pg_temp"]) && !f.anon && !f.authenticated && !f.public && f.service), fnRows.filter((f) => f.secdef || f.anon || f.authenticated || f.public || !f.service || JSON.stringify(f.config) !== JSON.stringify(["search_path=public, pg_temp"])));
  const rls = one(`select count(*) filter (where relrowsecurity) || '/' || count(*) from pg_class where relnamespace='public'::regnamespace and relname in (${tl})`);
  const policies = one(`select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname in (${tl})`);
  check("AT02c", "RLS enabled on all catalogue tables, no policy (deny by default); schema USAGE still closed to anon/authenticated", rls === `${TABLES.length}/${TABLES.length}` && policies === "0" && one("select has_schema_privilege('anon','public','USAGE') or has_schema_privilege('authenticated','public','USAGE')") === "f", { rls, policies });
  const svc = JSON.parse(one(`select json_object_agg(c.relname, json_build_object('s', has_table_privilege('service_role',c.oid,'SELECT'), 'i', has_table_privilege('service_role',c.oid,'INSERT'), 'u', has_table_privilege('service_role',c.oid,'UPDATE'), 'd', has_table_privilege('service_role',c.oid,'DELETE'), 't', has_table_privilege('service_role',c.oid,'TRUNCATE'))) from pg_class c where c.relnamespace='public'::regnamespace and c.relname in (${tl})`));
  check("AT02d", "existing table privileges retained; merchandising uses stricter grants; no TRUNCATE", Object.keys(svc).length === TABLES.length && Object.entries(svc).every(([t,x]) => t.startsWith("catalogue_merchandising") ? x.s && x.i && !x.d && !x.t && (t === "catalogue_merchandising" ? x.u : !x.u) : x.s && x.i && x.u && x.d && !x.t), svc);
  const costRefs = one(`select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.prosrc ilike '%catalogue_variant_costs%'`);
  check("AT02e", "no function references catalogue_variant_costs; no view in public", costRefs === "0" && one("select count(*) from pg_class where relnamespace='public'::regnamespace and relkind in ('v','m')") === "0", costRefs);

  // ------------------------------------------------------------------------------------------------ users + application
  const users = testUsers();
  const userSql = Object.values(users).map((u) => `insert into admin_users (email, password_hash, role, status, display_name, permission_scopes) values ('${u.email}', '${hashPassword(u.password)}', '${u.role}', 'active', '${u.email}', array[${u.scopes.map((s) => `'${s}'`).join(",")}]::text[]);`).join("\n");
  check("M20", "test staff users provisioned", psql(userSql).status === 0);
  await reloadSchema(restUrl);
  const revalidator = await startRevalidator(REVALIDATE_SECRET);
  cleanup.push(() => revalidator.close());
  process.env.__REVALIDATE_URL = revalidator.url;
  const app = await startApp(gatewayUrl);

  // ------------------------------------------------------------------------------------------------ the shared acceptance scenarios, on Postgres
  const { productId } = await runCatalogueScenarios({ base: app.url, users, fullKey: FULL_KEY, scopedKey: SITE_KEY, check, label: "PG-", storageDir, catalogueKey: CATALOGUE_KEY, revalidator });

  // Phase 3: execute real database workflow; no production connection is used.
  {
    const content = JSON.stringify({slides:[],featured:[],new_arrivals:[],collections:[]});
    const call = (action, expected, actor) => psql(`set role service_role; select catalogue_merchandising_transition('${action}',${expected},'${content}'::jsonb,'${actor}','');`);
    check("MC1", "merchandising draft and submit are atomic", call('save',0,'writer').status===0 && call('submit',1,'writer').status===0);
    check("MC2", "self-approval refused inside DB even with case variation", /self_review_forbidden/.test(call('approve',2,'WRITER').err));
    check("MC3", "independent approval and release succeed", call('approve',2,'reviewer').status===0 && call('publish',3,'publisher').status===0);
    check("MC4", "new draft preserves published version", call('save',4,'writer').status===0 && one('select published_version from catalogue_merchandising')==='1');
    check("MC5", "stale database save refused", /state_changed/.test(call('save',4,'writer').err));
    check("MC6", "withdraw clears public version", call('withdraw',5,'publisher').status===0 && one('select published_version is null from catalogue_merchandising')==='t');
    check("MC7", "withdraw audit identifies live v1 and current draft v2", one("select concat(version,',',previous_published_version,',',current_version) from catalogue_merchandising_events where action='withdraw' order by id desc limit 1")==='1,1,2');
  }

  // ------------------------------------------------------------------------------------------------ AT-03 append-only, for every role
  {
    const results = [];
    for (const t of APPEND_ONLY) {
      for (const role of ["service_role", "postgres"]) {
        const prefix = role === "postgres" ? "" : "set role service_role; ";
        const col = t === "catalogue_merchandising_events" ? "action" : ["catalogue_product_versions","catalogue_merchandising_versions"].includes(t) ? "version" : t === "catalogue_media_derivatives" ? "kind" : t === "catalogue_slug_redirects" ? "old_slug" : "id";
        const upd = psql(`${prefix}update ${t} set ${col} = ${col};`);
        const del = psql(`${prefix}delete from ${t};`);
        results.push({ t, role, upd: (t.startsWith("catalogue_merchandising") && role === "service_role" ? /permission denied|append_only/ : /append_only/).test(upd.err), del: (t.startsWith("catalogue_merchandising") && role === "service_role" ? /permission denied|append_only/ : /append_only/).test(del.err) });
      }
      const trunc = psql(`truncate ${t} cascade;`);
      const svcTrunc = psql(`set role service_role; truncate ${t};`);
      results.push({ t, role: "truncate", upd: /append_only/.test(trunc.err), del: /permission denied|append_only/.test(svcTrunc.err) });
    }
    check("AT03a", "the 11 history tables (incl. media, renditions, public events and slug redirects) refuse UPDATE and DELETE for service_role AND the owner (postgres), and TRUNCATE (owner: trigger, service_role: no privilege)", results.every((r) => r.upd && r.del), results.filter((r) => !r.upd || !r.del));
    const versionsBefore = one(`select count(*) from catalogue_product_versions where product_id = '${productId}'`);
    const viaRest = await rest(restUrl, "service_role", "PATCH", `/catalogue_product_versions?product_id=eq.${productId}&version=eq.1`, { content: { name: "tampered" } });
    const viaRestDel = await rest(restUrl, "service_role", "DELETE", `/catalogue_reviews?product_id=eq.${productId}`);
    check("AT03b", "…also through PostgREST with the service_role key; nothing changed", viaRest.status >= 400 && viaRestDel.status >= 400 && one(`select content->>'name' from catalogue_product_versions where product_id='${productId}' and version=1`) === "Smart Switch 2-Gang" && one(`select count(*) from catalogue_product_versions where product_id = '${productId}'`) === versionsBefore, { viaRest: viaRest.status, viaRestDel: viaRestDel.status });
  }

  // ------------------------------------------------------------------------------------------------ PostgREST boundary for anon/authenticated
  {
    const anonRpc = await rest(restUrl, null, "POST", "/rpc/catalogue_transition", { p_product_id: productId, p_expected_row_version: 1, p_action: "archive", p_actor: "anon", p_note: "", p_override_reason: "" });
    const authRead = await rest(restUrl, "authenticated", "GET", "/catalogue_variant_costs?select=*");
    const anonRead = await rest(restUrl, null, "GET", "/catalogue_products?select=*");
    check("AT02f", "PostgREST: anon cannot call catalogue functions; anon/authenticated cannot read products or costs", anonRpc.status >= 400 && authRead.status >= 400 && anonRead.status >= 400, { anonRpc: anonRpc.status, authRead: authRead.status, anonRead: anonRead.status });
  }

  // ------------------------------------------------------------------------------------------------ database-level rules, application bypassed
  {
    const cat = one("select id from catalogue_categories where slug='networking-connectivity'");
    const c = (sql) => psql(`set role service_role; ${sql}`);
    const made = c(`select (catalogue_create_product('db-direct-${RUN}', '${cat}', null, '{"name":"Direct","variants":[{"sku":"DB-${RUN.toUpperCase()}","name":"x"}]}'::jsonb, 'author@x'))->>'id';`);
    const pid = made.out.split("\n").pop();
    c(`select catalogue_transition('${pid}', 1, 'submit', 'author@x', '', '');`);
    const selfApprove = c(`select catalogue_transition('${pid}', 2, 'approve', 'author@x', '', '');`);
    const shortOverride = c(`select catalogue_transition('${pid}', 2, 'publish', 'admin@x', '', 'short');`);
    // typo exception in the database: a "minor" version that changes anything but summary/description is refused even when the app says minor
    const pubId = one("select id from catalogue_products where published_version is not null order by updated_at desc limit 1");
    const pubRow = JSON.parse(one(`select json_build_object('rv', p.row_version, 'slug', p.slug, 'cat', p.category_id, 'brand', p.brand_id, 'content', v.content) from catalogue_products p join catalogue_product_versions v on v.product_id = p.id and v.version = p.published_version where p.id = '${pubId}'`));
    const tampered = JSON.stringify({ ...pubRow.content, specifications: [...(pubRow.content.specifications || []), { key: "Warranty", value: "5 years", unit: "" }] }).replace(/'/g, "''");
    const fakeMinor = c(`select catalogue_save_version('${pubId}', ${pubRow.rv}, '${pubRow.slug}', '${pubRow.cat}', ${pubRow.brand ? `'${pubRow.brand}'` : "null"}, '${tampered}'::jsonb, 'minor', 'tamper@x');`);
    const fakeInitial = c(`select catalogue_save_version('${pubId}', ${pubRow.rv}, '${pubRow.slug}', '${pubRow.cat}', ${pubRow.brand ? `'${pubRow.brand}'` : "null"}, '${tampered}'::jsonb, 'initial', 'tamper@x');`);
    const neverPub = one("select id || '|' || row_version || '|' || slug || '|' || category_id from catalogue_products where published_version is null and publication_status <> 'archived' limit 1").split("|");
    const fakeMaterial = c(`select catalogue_save_version('${neverPub[0]}', ${neverPub[1]}, '${neverPub[2]}', '${neverPub[3]}', null, '{"name":"x","variants":[]}'::jsonb, 'material', 'tamper@x');`);
    check("DB02", "the database knows no 'minor' class at all (refused even when the application asks), 'initial' is refused after publication and 'material' before it", /invalid_materiality/.test(fakeMinor.err) && /initial_not_allowed/.test(fakeInitial.err) && /material_not_allowed/.test(fakeMaterial.err) && one("select count(*) from catalogue_product_versions where materiality not in ('initial','material')") === "0", { fakeMinor: fakeMinor.err.slice(0, 160), fakeInitial: fakeInitial.err.slice(0, 160), fakeMaterial: fakeMaterial.err.slice(0, 160) });
    const arch = c(`select (catalogue_create_product('db-archived-${RUN}', '${cat}', null, '{"name":"Archived","variants":[{"sku":"DBA-${RUN.toUpperCase()}","name":"x"}]}'::jsonb, 'author2@x'))->>'id';`).out.split("\n").pop();
    c(`select catalogue_transition('${arch}', 1, 'submit', 'author2@x', '', '');`);
    c(`select catalogue_transition('${arch}', 2, 'archive', 'admin@x', '', '');`);
    const archApprove = c(`select catalogue_transition('${arch}', 3, 'approve', 'reviewer9@x', '', '');`);
    const archChanges = c(`select catalogue_transition('${arch}', 3, 'request_changes', 'reviewer9@x', '', '');`);
    check("DB03", "in the database: an archived product cannot be approved or sent back for changes by another reviewer (20261103)", /state_changed/.test(archApprove.err) && /state_changed/.test(archChanges.err) && one(`select workflow_status || '/' || publication_status from catalogue_products where id='${arch}'`) === "in_review/archived", { archApprove: archApprove.err.slice(0, 120), archChanges: archChanges.err.slice(0, 120) });
    check("DB01", "in the database itself: the author cannot approve (own_change) and an override reason < 20 chars is refused", /own_change/.test(selfApprove.err) && /override_reason_too_short/.test(shortOverride.err), { selfApprove: selfApprove.err.slice(0, 160), shortOverride: shortOverride.err.slice(0, 160) });
    // 20 concurrent approve transactions, each in its own session
    const res = await concurrentSql(Array.from({ length: 20 }, (_, i) => `set role service_role; select (catalogue_transition('${pid}', 2, 'approve', 'reviewer${i}@x', '', ''))->>'workflow_status';`));
    const ok = res.filter((r) => r.code === 0 && /approved/.test(r.out));
    check("AT25e", "20 concurrent approve transactions in separate database sessions: exactly one commits, 19 fail with state_changed", ok.length === 1 && res.filter((r) => /state_changed/.test(r.err)).length === 19, res.map((r) => r.code));
    const pubs = await concurrentSql(Array.from({ length: 20 }, () => `set role service_role; select (catalogue_transition('${pid}', 3, 'publish', 'publisher@x', '', ''))->>'publication_status';`));
    check("AT25f", "20 concurrent publish transactions: exactly one commits; one publication event", pubs.filter((r) => r.code === 0).length === 1 && one(`select count(*) from catalogue_publication_events where product_id='${pid}'`) === "1", pubs.map((r) => r.code));
    const vid = one(`select id from catalogue_variants where product_id='${pid}'`);
    const chg = c(`select (catalogue_request_price_change('${vid}', 500000, 'standard', 750, 'req@x', ''))->>'id';`).out.split("\n").pop();
    const decisions = await concurrentSql(Array.from({ length: 10 }, (_, i) => `set role service_role; select catalogue_decide_price_change('${chg}', '${i % 2 ? "approved" : "rejected"}', 'approver${i}@x', '');`));
    const selfDecide = c(`select catalogue_decide_price_change('${chg}', 'approved', 'req@x', '');`);
    check("AT30g", "10 concurrent price decisions: exactly one recorded (unique index), others already_decided; the requester is refused in the database", decisions.filter((r) => r.code === 0).length === 1 && one(`select count(*) from catalogue_price_decisions where price_change_id='${chg}'`) === "1" && /own_request|already_decided/.test(selfDecide.err), decisions.map((r) => r.code));
    const inv = await concurrentSql(Array.from({ length: 10 }, (_, i) => `set role service_role; select catalogue_update_inventory('${vid}', 1, '{"stock_on_hand": ${i + 1}}'::jsonb, 'ops${i}@x', 'count');`));
    check("AT32e", "10 concurrent inventory edits with the same row_version: exactly one applies; one change row", inv.filter((r) => r.code === 0).length === 1 && one(`select count(*) from catalogue_inventory_changes where variant_id='${vid}'`) === "1", inv.map((r) => r.code));
  }

  // ------------------------------------------------------------------------------------------------ gallery media rules in the database itself (application bypassed)
  {
    const c = (sql) => psql(`set role service_role; ${sql}`);
    const hex = (n) => crypto.createHash("sha256").update(`${RUN}-${n}`).digest("hex");
    let fileSeq = 0;
    const files = (n) => Array.from({ length: n }, () => `product_image_dbm_${RUN}_${(fileSeq += 1)}`);
    const insertFiles = (ids) => psql(ids.map((f) => `insert into office_files (id, storage_key, filename, mime_type, size, purpose, resource_type) values ('${f}', '${f}.webp', '${f}.webp', 'image/webp', 10, 'product_image', 'catalogue_media');`).join("\n"));
    const registerSql = (productId, sha, [orig, ...ds]) => `select catalogue_register_media('${productId}', '${orig}', '${sha}', 'jpeg', 800, 600, 1000, 'x.jpg', '${JSON.stringify(["thumb", "w480", "w960", "w1600"].map((kind, i) => ({ kind, office_file_id: ds[i], width: 320, height: 240, bytes: 10, sha256: hex(`${sha}-${kind}`) })))}'::jsonb, 'w@x')`;
    const register = (productId, sha) => { const f = files(5); insertFiles(f); return JSON.parse(c(`${registerSql(productId, sha, f)};`).out.split("\n").pop()); };
    const cat = one("select id from catalogue_categories where slug='sensors-monitoring'");
    const mk = (slug, sku) => c(`select (catalogue_create_product('${slug}', '${cat}', null, '{"name":"M","variants":[{"sku":"${sku}","name":"x"}]}'::jsonb, 'author@x'))->>'id';`).out.split("\n").pop();
    const pa = mk(`dbm-a-${RUN}`, `DBMA-${RUN.toUpperCase()}`), pb = mk(`dbm-b-${RUN}`, `DBMB-${RUN.toUpperCase()}`);
    const save = (productId, media, sku) => {
      const row = one(`select row_version || '|' || slug from catalogue_products where id='${productId}'`).split("|");
      return { rv: row[0], sql: `select catalogue_save_version('${productId}', ${row[0]}, '${row[1]}', '${cat}', null, '${JSON.stringify({ name: "M", variants: [{ sku, name: "x" }], media })}'::jsonb, 'initial', 'author@x')` };
    };
    const skuA = `DBMA-${RUN.toUpperCase()}`;
    const x = register(pa, hex("x")), y = register(pa, hex("y")), z = register(pa, hex("z")), foreign = register(pb, hex("f"));
    const dup = register(pa, hex("x"));
    check("DBM0", "catalogue_register_media stores an image with 4 renditions; the same bytes again return the existing row (deduplicated)", x.id && !x.deduplicated && dup.deduplicated === true && dup.id === x.id && one(`select count(*) from catalogue_media_derivatives where media_id='${x.id}'`) === "4");

    // gallery trigger on version insert
    const ref = (m, cover = false, extra = {}) => ({ media_id: m.id, cover, alt: "", caption: "", variant_skus: [], ...extra });
    const tooMany = c(`${save(pa, Array.from({ length: 13 }, (_, i) => ({ media_id: crypto.randomUUID(), cover: i === 0 })), skuA).sql};`);
    const twoCovers = c(`${save(pa, [ref(x, true), ref(y, true)], skuA).sql};`);
    const noCover = c(`${save(pa, [ref(x), ref(y)], skuA).sql};`);
    const dupRef = c(`${save(pa, [ref(x, true), ref(x)], skuA).sql};`);
    const foreignRef = c(`${save(pa, [ref(foreign, true)], skuA).sql};`);
    const badSku = c(`${save(pa, [ref(x, true, { variant_skus: ["NOPE-1"] })], skuA).sql};`);
    const good = c(`${save(pa, [ref(x, true), ref(y)], skuA).sql};`);
    check("DBM1", "version insert trigger (any caller): > 12 images, two covers, no cover, a duplicate, another product's image and an unknown variant are refused; a valid gallery is stored",
      /gallery_too_large/.test(tooMany.err) && /gallery_cover_required/.test(twoCovers.err) && /gallery_cover_required/.test(noCover.err) && /gallery_duplicate_image/.test(dupRef.err)
        && /media_not_available/.test(foreignRef.err) && /gallery_unknown_variant/.test(badSku.err) && good.status === 0,
      { tooMany: tooMany.err.slice(0, 90), twoCovers: twoCovers.err.slice(0, 90), noCover: noCover.err.slice(0, 90), dupRef: dupRef.err.slice(0, 90), foreignRef: foreignRef.err.slice(0, 90), badSku: badSku.err.slice(0, 90), good: good.err.slice(0, 200) });

    // tampering: referenced removal, any other update, delete, truncate, office_files delete; also through PostgREST
    const refRemove = c(`select catalogue_remove_media('${x.id}', 'rm@x');`);
    const directRemove = c(`update catalogue_media set status='removed', removed_by='rm@x', removed_at=now() where id='${x.id}';`);
    const shaEdit = c(`update catalogue_media set sha256='${hex("evil")}' where id='${z.id}';`);
    const del = c(`delete from catalogue_media where id='${z.id}';`);
    const ownerDel = psql(`delete from catalogue_media where id='${z.id}';`);
    const fileDel = psql(`delete from office_files where id='${x.office_file_id}';`);
    const restDel = await rest(restUrl, "service_role", "DELETE", `/catalogue_media?id=eq.${z.id}`);
    const restFileDel = await rest(restUrl, "service_role", "DELETE", `/office_files?id=eq.${x.office_file_id}`);
    const restDeriv = await rest(restUrl, "service_role", "PATCH", `/catalogue_media_derivatives?media_id=eq.${x.id}`, { bytes: 1 });
    check("DBM2", "referenced media cannot be removed (function or direct UPDATE: media_referenced); no other change, no DELETE (service_role or owner), and its office_files rows cannot be deleted (FK RESTRICT), also via PostgREST",
      /media_referenced/.test(refRemove.err) && /media_referenced/.test(directRemove.err) && /append_only/.test(shaEdit.err) && /append_only/.test(del.err) && /append_only/.test(ownerDel.err) && /foreign key/.test(fileDel.err)
        && restDel.status >= 400 && restFileDel.status >= 400 && restDeriv.status >= 400 && one(`select count(*) from catalogue_media where id in ('${x.id}','${z.id}') and status='active'`) === "2",
      { refRemove: refRemove.err.slice(0, 90), directRemove: directRemove.err.slice(0, 90), shaEdit: shaEdit.err.slice(0, 90), del: del.err.slice(0, 90), fileDel: fileDel.err.slice(0, 90), restDel: restDel.status, restFileDel: restFileDel.status, restDeriv: restDeriv.status });
    const freeRemove = c(`select catalogue_remove_media('${z.id}', 'rm@x');`);
    const again = c(`select catalogue_remove_media('${z.id}', 'rm@x');`);
    const reuse = c(`${save(pa, [ref(x, true), ref(z)], skuA).sql};`);
    check("DBM3", "an unreferenced image can be removed once (then media_already_removed) and can never be referenced again", freeRemove.status === 0 && /media_already_removed/.test(again.err) && /media_not_available/.test(reuse.err), { freeRemove: freeRemove.err.slice(0, 90), again: again.err.slice(0, 90), reuse: reuse.err.slice(0, 90) });

    // races between removal and a version that references the same image, both orders
    const w1 = register(pa, hex("w1"));
    const s1 = save(pa, [ref(x, true), ref(w1)], skuA);
    const raceA = await concurrentSql([
      `set role service_role; begin; ${s1.sql}; select pg_sleep(1.5); commit;`,
      `select pg_sleep(0.5); set role service_role; select catalogue_remove_media('${w1.id}', 'rm@x');`,
    ]);
    const w2 = register(pa, hex("w2"));
    const s2 = save(pa, [ref(x, true), ref(w2)], skuA);
    const raceB = await concurrentSql([
      `set role service_role; begin; select catalogue_remove_media('${w2.id}', 'rm@x'); select pg_sleep(1.5); commit;`,
      `select pg_sleep(0.5); set role service_role; ${s2.sql};`,
    ]);
    const orphanRefs = one(`select count(*) from catalogue_product_versions v, jsonb_array_elements(coalesce(v.content->'media','[]'::jsonb)) e join catalogue_media m on m.id = (e->>'media_id')::uuid where m.status = 'removed'`);
    check("DBM4", "race, version first: the removal waits for the version and is then refused (media_referenced); race, removal first: the version waits and is then refused (media_not_available); no version ever references a removed image",
      raceA[0].code === 0 && /media_referenced/.test(raceA[1].err) && raceB[0].code === 0 && /media_not_available/.test(raceB[1].err) && orphanRefs === "0",
      { raceA: raceA.map((r) => [r.code, r.err.slice(0, 90)]), raceB: raceB.map((r) => [r.code, r.err.slice(0, 90)]), orphanRefs });

    // concurrent registration of the same new bytes
    const sha = hex("same");
    const fileSets = Array.from({ length: 8 }, () => files(5));
    fileSets.forEach(insertFiles);
    const regs = await concurrentSql(fileSets.map((f) => `set role service_role; select (${registerSql(pa, sha, f)})->>'deduplicated';`));
    check("DBM5", "8 concurrent registrations of the same bytes: one image row; exactly one reports deduplicated=false, the rest true",
      regs.every((r) => r.code === 0) && regs.filter((r) => r.out.endsWith("false")).length === 1 && one(`select count(*) from catalogue_media where product_id='${pa}' and sha256='${sha}'`) === "1", regs.map((r) => [r.code, r.out.slice(-6), r.err.slice(0, 80)]));
    const archived = mk(`dbm-arch-${RUN}`, `DBMC-${RUN.toUpperCase()}`);
    c(`select catalogue_transition('${archived}', 1, 'archive', 'admin@x', '', '');`);
    const archFiles = files(5); insertFiles(archFiles);
    const archReg = c(`${registerSql(archived, hex("arch"), archFiles)};`);
    check("DBM6", "an archived product accepts no media (product_archived)", /product_archived/.test(archReg.err), archReg.err.slice(0, 120));

    // ---------------------------------------------------------------------------------------------- public release in the database (stage 4)
    {
      const rel = (pid, prv, lrv, actor = "releaser@x") => c(`select catalogue_public_release('${pid}', ${prv}, ${lrv}, '${actor}');`);
      const prow = (pid) => JSON.parse(one(`select json_build_object('rv', row_version, 'slug', slug, 'pv', published_version, 'cv', current_version) from catalogue_products where id='${pid}'`));
      const lrow = (pid) => JSON.parse(one(`select coalesce((select json_build_object('rv', row_version, 'status', status, 'seq', refresh_seq) from catalogue_public_listings where product_id='${pid}'), '{"rv":0}')`));
      // a releasable product built through the database functions only
      const skuP = `DBP-${RUN.toUpperCase()}`;
      const pp = mk(`dbp-${RUN}`, skuP);
      const pm = register(pp, hex("dbp-image"));
      c(`${save(pp, [ref(pm, true, { alt: "Front" })], skuP).sql};`);
      const r0 = prow(pp);
      c(`select catalogue_transition('${pp}', ${r0.rv}, 'submit', 'author@x', '', '');`);
      c(`select catalogue_transition('${pp}', ${r0.rv + 1}, 'approve', 'reviewer@x', '', '');`);
      c(`select catalogue_transition('${pp}', ${r0.rv + 2}, 'publish', 'publisher@x', '', '');`);
      const unpriced = one(`select catalogue_public_requirements('${pp}')::text`);
      const vid = one(`select id from catalogue_variants where product_id='${pp}'`);
      const chg = c(`select (catalogue_request_price_change('${vid}', 990000, 'standard', 750, 'req@x', ''))->>'id';`).out.split("\n").pop();
      c(`select catalogue_decide_price_change('${chg}', 'approved', 'approver@x', ''); select catalogue_publish_price_change('${chg}', 'publisher@x');`);
      const ready = one(`select catalogue_public_requirements('${pp}')::text`);
      check("DBP1", "in the database: catalogue_public_requirements reports the unpriced variant, then nothing once the price is approved and published", /price_not_approved/.test(unpriced) && ready === "[]", { unpriced, ready });

      // 10 concurrent first releases: one listing, one event
      const r1 = prow(pp);
      const rels = await concurrentSql(Array.from({ length: 10 }, (_, i) => `set role service_role; select (catalogue_public_release('${pp}', ${r1.rv}, 0, 'releaser${i}@x'))->>'status';`));
      check("DBP2", "10 concurrent first releases in separate sessions: exactly one commits, one listing row and one 'released' event",
        rels.filter((r) => r.code === 0).length === 1 && one(`select count(*) from catalogue_public_listings where product_id='${pp}'`) === "1" && one(`select count(*) from catalogue_public_events where product_id='${pp}'`) === "1", rels.map((r) => [r.code, r.err.slice(0, 60)]));

      // tampering
      const delListing = c(`delete from catalogue_public_listings where product_id='${pp}';`);
      const ownerDel = psql(`delete from catalogue_public_listings where product_id='${pp}';`);
      const evEdit = c(`update catalogue_public_events set actor='evil' where product_id='${pp}';`);
      const g = JSON.parse(c(`select catalogue_create_preview_grant('${pp}', 'staff@x', 600)::text;`).out.split("\n").pop());
      const extend = c(`update catalogue_preview_grants set expires_at = expires_at + interval '1 day' where id='${g.id}';`);
      const gDel = c(`delete from catalogue_preview_grants where id='${g.id}';`);
      const tooLong = c(`select catalogue_create_preview_grant('${pp}', 'staff@x', 7200);`);
      const restListing = await rest(restUrl, "service_role", "DELETE", `/catalogue_public_listings?product_id=eq.${pp}`);
      check("DBP3", "listings cannot be deleted (service_role, owner, PostgREST); public events are immutable; a preview grant can only be revoked (no extension, no delete, at most 30 minutes)",
        /append_only/.test(delListing.err) && /append_only/.test(ownerDel.err) && /append_only/.test(evEdit.err) && /append_only/.test(extend.err) && /append_only/.test(gDel.err) && /invalid_ttl/.test(tooLong.err) && restListing.status >= 400,
        { delListing: delListing.err.slice(0, 80), evEdit: evEdit.err.slice(0, 80), extend: extend.err.slice(0, 80), gDel: gDel.err.slice(0, 80), tooLong: tooLong.err.slice(0, 80), rest: restListing.status });

      // slug: rename, then another product cannot take the old slug even by a direct UPDATE; the original product may return to it
      const r2 = prow(pp);
      const renamed = c(`select catalogue_change_slug('${pp}', ${r2.rv}, 'dbp-renamed-${RUN}', 'releaser@x');`);
      const hijack = c(`update catalogue_products set slug='dbp-${RUN}' where id='${pa}';`);
      const r3 = prow(pp);
      const back = c(`select catalogue_change_slug('${pp}', ${r3.rv}, 'dbp-${RUN}', 'releaser@x');`);
      check("DBP4", "slug change records a permanent redirect; a different product cannot take a redirecting slug even by a direct UPDATE (trigger); the listing follows the slug",
        renamed.status === 0 && /slug_taken/.test(hijack.err) && back.status === 0 && one(`select slug from catalogue_public_listings where product_id='${pp}'`) === `dbp-${RUN}` && one(`select count(*) from catalogue_slug_redirects where product_id='${pp}'`) === "2",
        { renamed: renamed.err.slice(0, 80), hijack: hijack.err.slice(0, 80), back: back.err.slice(0, 80) });

      // refresh rounds: a late answer to an older round never overwrites the newer one
      const seqA = Number(one(`set role service_role; select catalogue_public_request_refresh('${pp}');`).split("\n").pop());
      const seqB = Number(one(`set role service_role; select catalogue_public_request_refresh('${pp}');`).split("\n").pop());
      const late = one(`set role service_role; select catalogue_public_record_refresh('${pp}', ${seqA}, 'failed', 'late');`).split("\n").pop();
      const fresh = one(`set role service_role; select catalogue_public_record_refresh('${pp}', ${seqB}, 'succeeded', '');`).split("\n").pop();
      check("DBP5", "refresh rounds: recording an outcome for a superseded round is ignored (false); the current round records (true)", late === "f" && fresh === "t" && one(`select refresh_status from catalogue_public_listings where product_id='${pp}'`) === "succeeded", { late, fresh });

      // release vs internal unpublish at the same time: the unpublish waits for the release, then applies; the product is hidden
      const l1 = lrow(pp), r4 = prow(pp);
      c(`select catalogue_public_withdraw('${pp}', ${l1.rv}, 'releaser@x', 'reset');`);
      const l2 = lrow(pp);
      const race = await concurrentSql([
        `set role service_role; begin; select catalogue_public_release('${pp}', ${r4.rv}, ${l2.rv}, 'releaser@x'); select pg_sleep(1.2); commit;`,
        `select pg_sleep(0.4); set role service_role; select catalogue_transition('${pp}', ${r4.rv}, 'unpublish', 'publisher@x', '', '');`,
      ]);
      check("DBP6", "release and an internal unpublish racing: the unpublish waits for the release lock, then applies; the listing is 'public' but the product is unpublished, so the public projection hides it",
        race[0].code === 0 && race[1].code === 0 && one(`select status from catalogue_public_listings where product_id='${pp}'`) === "public" && one(`select publication_status from catalogue_products where id='${pp}'`) === "unpublished",
        race.map((r) => [r.code, r.err.slice(0, 80)]));

      // previews: an expired grant (inserted directly) and a revoked grant answer 410 through the public API
      const expired = one(`insert into catalogue_preview_grants (product_id, version, staff, created_at, expires_at) values ('${pp}', 1, '${users.staff.email}', now() - interval '20 minutes', now() - interval '10 minutes') returning id`);
      const live = one(`insert into catalogue_preview_grants (product_id, version, staff, expires_at) values ('${pp}', 1, '${users.staff.email}', now() + interval '10 minutes') returning id`);
      const key = crypto.createHmac("sha256", SESSION_SECRET).update("ochiga-catalogue:preview:v1").digest();
      const tok = (gid) => `pv1.${gid}.${crypto.createHmac("sha256", key).update(`pv1.${gid}`).digest("base64url")}`;
      const getPreview = (gid) => fetch(`${app.url}/api/public/catalogue/preview/${tok(gid)}`, { headers: { "x-api-key": CATALOGUE_KEY } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
      const pExpired = await getPreview(expired), pLive = await getPreview(live);
      c(`select catalogue_revoke_preview_grants('${pp}', 'admin@x');`);
      const pRevoked = await getPreview(live);
      check("DBP7", "previews: a live grant shows the version; an expired grant is 410 preview_expired; after revocation the same link is 410 preview_revoked",
        pLive.status === 200 && pExpired.status === 410 && pExpired.body.error === "preview_expired" && pRevoked.status === 410 && pRevoked.body.error === "preview_revoked", { pLive: pLive.status, pExpired, pRevoked });

      // rollback of 20261105: public API 503, staff reads fine, rows kept; re-apply restores
      const listings = one("select count(*) from catalogue_public_listings");
      const rbPub = applyFile(PUBLIC_ROLLBACK);
      await reloadSchema(restUrl);
      await sleep(61_000); // availability is re-probed at most once a minute
      const pubAfter = await fetch(`${app.url}/api/public/catalogue/products`, { headers: { "x-api-key": CATALOGUE_KEY } });
      const loginW = await fetch(`${app.url}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: users.writerA.email, password: users.writerA.password }) });
      const cookieW = ((loginW.headers.getSetCookie ? loginW.headers.getSetCookie() : []).find((h) => /^lead_agents_admin=/.test(h)) || "").split(";")[0];
      const staffRead = await fetch(`${app.url}/api/lead-agents/admin/catalogue/products/${pp}`, { headers: { cookie: cookieW } });
      const staffJson = await staffRead.json();
      check("M42", "public-release rollback: applies; the public API answers 503 (nothing served); staff product reads work (public block unavailable); listings kept and still undeletable",
        rbPub.status === 0 && pubAfter.status === 503 && staffRead.status === 200 && staffJson.public.available === false && one("select count(*) from catalogue_public_listings") === listings && /append_only/.test(c(`delete from catalogue_public_listings where product_id='${pp}';`).err),
        { rb: rbPub.err.slice(0, 200), pubAfter: pubAfter.status, staffRead: staffRead.status, pub: staffJson.public });
      const rePub = applyFile(path.join(ROOT, "db", "20261105_catalogue_public_release.sql"));
      await reloadSchema(restUrl);
      check("M43", "re-applying 20261105 restores the functions and the slug trigger with every row intact", rePub.status === 0 && one("select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'catalogue\\_%'") === FN_TOTAL && one("select count(*) from pg_trigger where tgname='catalogue_products_slug_redirect_check'") === "1" && one("select count(*) from catalogue_public_listings") === listings, rePub.err.slice(0, 200));
    }

    // media rollback: functions and the version check go, tables/rows/guards stay; Office reports media unavailable; re-apply restores
    const mediaRows = one("select count(*) from catalogue_media");
    const rb = applyFile(MEDIA_ROLLBACK);
    await reloadSchema(restUrl);
    const login = await fetch(`${app.url}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: users.writerA.email, password: users.writerA.password }) });
    const cookie = ((login.headers.getSetCookie ? login.headers.getSetCookie() : []).find((h) => /^lead_agents_admin=/.test(h)) || "").split(";")[0];
    await sleep(61_000); // the application re-probes media availability at most once a minute
    const up = await fetch(`${app.url}/api/lead-agents/admin/catalogue/products/${pa}/media`, { method: "POST", headers: { cookie, origin: app.url, "content-type": "image/jpeg" }, body: Buffer.from([0xff, 0xd8, 0xff]) });
    const read = await fetch(`${app.url}/api/lead-agents/admin/catalogue/products/${pa}`, { headers: { cookie } });
    const readJson = await read.json();
    const stillGuarded = c(`delete from catalogue_media where id='${x.id}';`);
    check("M40", "media rollback: applies; uploads answer 503 media_unavailable; products still read (library reported unavailable); media rows kept and still undeletable",
      rb.status === 0 && up.status === 503 && read.status === 200 && readJson.media_library.available === false && one("select count(*) from catalogue_media") === mediaRows && /append_only/.test(stillGuarded.err),
      { rb: rb.err.slice(0, 200), up: up.status, read: read.status, lib: readJson.media_library, rows: one("select count(*) from catalogue_media") });
    const reMedia = applyFile(path.join(ROOT, "db", "20261104_catalogue_media.sql"));
    await reloadSchema(restUrl);
    check("M41", "re-applying 20261104 restores the media functions and the version check with every row intact", reMedia.status === 0 && one("select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'catalogue\\_%'") === FN_TOTAL && one("select count(*) from pg_trigger where tgname='catalogue_product_versions_media_check'") === "1" && one("select count(*) from catalogue_media") === mediaRows, reMedia.err.slice(0, 200));
  }

  // ------------------------------------------------------------------------------------------------ rollback and re-apply
  {
    const before = one("select count(*) from catalogue_product_versions");
    const rb = applyFile(ROLLBACK);
    await reloadSchema(restUrl).catch(() => {});
    psql("notify pgrst, 'reload schema'"); await sleep(1500);
    const login = await fetch(`${app.url}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: users.writerA.email, password: users.writerA.password }) });
    const cookie = ((login.headers.getSetCookie ? login.headers.getSetCookie() : []).find((x) => /^lead_agents_admin=/.test(x)) || "").split(";")[0];
    const write = await fetch(`${app.url}/api/lead-agents/admin/catalogue/products`, { method: "POST", headers: { cookie, "content-type": "application/json", origin: app.url }, body: JSON.stringify({ slug: `after-rollback-${RUN}`, content: { category_id: one("select id from catalogue_categories limit 1"), name: "x", variants: [{ sku: `RB-${RUN.toUpperCase()}`, name: "x" }] } }) });
    const health = await fetch(`${app.url}/healthz`);
    check("M30", "rollback (functions only): applies; catalogue writes answer 503 catalogue_unavailable; the rest of Office is unaffected (healthz 200)", rb.status === 0 && write.status === 503 && health.status === 200, { rb: rb.err.slice(0, 200), write: write.status, health: health.status });
    check("M31", "…and keeps every table and row (non-destructive)", one("select count(*) from catalogue_product_versions") === before && one(`select count(*) from pg_class where relnamespace='public'::regnamespace and relname in (${tl})`) === String(TABLES.length), { before, after: one("select count(*) from catalogue_product_versions") });
    const re = applyFile(MIGRATION);
    CATALOGUE_FOLLOWUPS.forEach((f) => applyFile(path.join(ROOT, "db", f)));
    await reloadSchema(restUrl);
    check("M32", "re-applying the migration restores the functions with the data intact (seed not duplicated)", re.status === 0 && one("select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'catalogue\\_%'") === FN_TOTAL && one("select count(*) from catalogue_categories where created_by='migration'") === "6", re.err.slice(0, 200));
  }

  const logs = app.logs.join("");
  check("AT80", "no key, JWT secret, session secret or password appears in the server log", ![FULL_KEY, SITE_KEY, sha(SITE_KEY), CATALOGUE_KEY, sha(CATALOGUE_KEY), REVALIDATE_SECRET, JWT_SECRET, SESSION_SECRET, PW, ...Object.values(users).map((u) => u.password)].some((s) => logs.includes(s)));
  console.log(JSON.stringify({ suite: "catalogue-postgres", checks, failed: failures }));
}

main()
  .catch((error) => { console.error(error); failures += 1; })
  .finally(async () => { for (const fn of cleanup) { try { await fn(); } catch { /* best effort */ } } process.exit(failures ? 1 : 0); });
