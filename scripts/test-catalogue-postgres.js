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
const { runCatalogueScenarios, testUsers } = require("./catalogue-scenarios");

const ROOT = path.resolve(__dirname, "..");
const PG_IMAGE = process.env.PG_IMAGE || "public.ecr.aws/supabase/postgres:17.6.1.131";
const PGRST_IMAGE = process.env.PGRST_IMAGE || "public.ecr.aws/supabase/postgrest:v14.12";
const RUN = crypto.randomBytes(3).toString("hex");
const NET = `cat-net-${RUN}`, PG = `cat-pg-${RUN}`, REST = `cat-rest-${RUN}`;
const PW = `pw_${crypto.randomBytes(10).toString("hex")}`, JWT_SECRET = crypto.randomBytes(24).toString("hex");
const SITE_KEY = `oyi_${crypto.randomBytes(24).toString("hex")}`, FULL_KEY = `full_${crypto.randomBytes(12).toString("hex")}`;
const SESSION_SECRET = crypto.randomBytes(24).toString("hex");
const MIGRATION = path.join(ROOT, "db", "20261102_catalogue_foundation.sql");
const ROLLBACK = path.join(ROOT, "db", "rollback", "20261102_catalogue_foundation.down.sql");
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

const TABLES = ["office_suppliers", "catalogue_categories", "catalogue_brands", "catalogue_products", "catalogue_product_versions", "catalogue_reviews", "catalogue_publication_events", "catalogue_variants", "catalogue_price_changes", "catalogue_price_decisions", "catalogue_inventory_changes", "catalogue_variant_costs"];
const APPEND_ONLY = ["catalogue_product_versions", "catalogue_reviews", "catalogue_publication_events", "catalogue_price_changes", "catalogue_price_decisions", "catalogue_inventory_changes", "catalogue_variant_costs"];
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
  const dated = fs.readdirSync(path.join(ROOT, "db")).filter((f) => /^2026\d+.*\.sql$/.test(f) && f !== path.basename(MIGRATION)).sort();
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
  const gw = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const target = restUrl + req.url.replace(/^\/rest\/v1/, "");
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "connection", "content-length"].includes(k)));
    try {
      const up = await fetch(target, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !["content-encoding", "transfer-encoding", "content-length"].includes(k)))); res.end(buf);
    } catch { res.writeHead(502); res.end(); }
  });
  await new Promise((r2) => gw.listen(gwPort, "127.0.0.1", r2)); cleanup.unshift(() => gw.close());
  return { restUrl, gatewayUrl: `http://127.0.0.1:${gwPort}` };
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
      LEAD_AGENTS_SCOPED_API_KEYS: JSON.stringify([{ client: "getoyi", key_sha256: sha(SITE_KEY), scopes: ["intake.submit"] }]),
      OPENAI_API_KEY: "sk-fixture-not-real", OPENAI_BASE_URL: "http://127.0.0.1:9/v1", LEAD_AGENTS_RATE_LIMIT_MAX_REQUESTS: "100000", LEAD_AGENTS_OFFICE_RATE_LIMIT_MAX_REQUESTS: "100000", LEAD_AGENTS_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "1000",
    },
  });
  proc.stdout.on("data", (d) => logs.push(String(d))); proc.stderr.on("data", (d) => logs.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i += 1) { if (await fetch(url + "/healthz").catch(() => null)) break; await sleep(100); }
  const app = { url, logs, stop: () => new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once("exit", r); proc.kill("SIGTERM"); }) };
  cleanup.unshift(() => app.stop());
  return app;
}

// run N statements concurrently in separate psql sessions; returns each session's exit status and output
function concurrentSql(statements, user = "postgres") {
  const procs = statements.map((sql) => spawn("docker", ["exec", "-i", PG, "psql", "-X", "-q", "-At", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "pipe"] }));
  return Promise.all(procs.map((p, i) => new Promise((resolve) => { let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); p.on("close", (code) => resolve({ code, out: out.trim(), err })); p.stdin.end(statements[i]); })));
}

async function main() {
  const { restUrl, gatewayUrl } = await setup();

  // ------------------------------------------------------------------------------------------------ migration
  const m1 = applyFile(MIGRATION);
  check("M10", "catalogue migration applies on top of every shipped migration and the hardened schema", m1.status === 0, m1.err.slice(0, 400));
  const m2 = applyFile(MIGRATION);
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
  check("AT02b", "11 catalogue functions: all SECURITY INVOKER, search_path pinned to public, pg_temp, EXECUTE for service_role only (no PUBLIC/anon/authenticated)",
    fnRows.length === 11 && fnRows.every((f) => !f.secdef && JSON.stringify(f.config) === JSON.stringify(["search_path=public, pg_temp"]) && !f.anon && !f.authenticated && !f.public && f.service), fnRows.filter((f) => f.secdef || f.anon || f.authenticated || f.public || !f.service || JSON.stringify(f.config) !== JSON.stringify(["search_path=public, pg_temp"])));
  const rls = one(`select count(*) filter (where relrowsecurity) || '/' || count(*) from pg_class where relnamespace='public'::regnamespace and relname in (${tl})`);
  const policies = one(`select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname in (${tl})`);
  check("AT02c", "RLS enabled on all 12 tables, no policy (deny by default); schema USAGE still closed to anon/authenticated", rls === "12/12" && policies === "0" && one("select has_schema_privilege('anon','public','USAGE') or has_schema_privilege('authenticated','public','USAGE')") === "f", { rls, policies });
  const svc = JSON.parse(one(`select json_object_agg(c.relname, json_build_object('s', has_table_privilege('service_role',c.oid,'SELECT'), 'i', has_table_privilege('service_role',c.oid,'INSERT'), 'u', has_table_privilege('service_role',c.oid,'UPDATE'), 'd', has_table_privilege('service_role',c.oid,'DELETE'), 't', has_table_privilege('service_role',c.oid,'TRUNCATE'))) from pg_class c where c.relnamespace='public'::regnamespace and c.relname in (${tl})`));
  check("AT02d", "service_role keeps SELECT/INSERT/UPDATE/DELETE on every catalogue table (gate B6) and has TRUNCATE on none (production default privileges overridden)", Object.values(svc).length === 12 && Object.values(svc).every((x) => x.s && x.i && x.u && x.d && !x.t), svc);
  const costRefs = one(`select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.prosrc ilike '%catalogue_variant_costs%'`);
  check("AT02e", "no function references catalogue_variant_costs; no view in public", costRefs === "0" && one("select count(*) from pg_class where relnamespace='public'::regnamespace and relkind in ('v','m')") === "0", costRefs);

  // ------------------------------------------------------------------------------------------------ users + application
  const users = testUsers();
  const userSql = Object.values(users).map((u) => `insert into admin_users (email, password_hash, role, status, display_name, permission_scopes) values ('${u.email}', '${hashPassword(u.password)}', '${u.role}', 'active', '${u.email}', array[${u.scopes.map((s) => `'${s}'`).join(",")}]::text[]);`).join("\n");
  check("M20", "test staff users provisioned", psql(userSql).status === 0);
  await reloadSchema(restUrl);
  const app = await startApp(gatewayUrl);

  // ------------------------------------------------------------------------------------------------ the shared acceptance scenarios, on Postgres
  const { productId } = await runCatalogueScenarios({ base: app.url, users, fullKey: FULL_KEY, scopedKey: SITE_KEY, check, label: "PG-" });

  // ------------------------------------------------------------------------------------------------ AT-03 append-only, for every role
  {
    const results = [];
    for (const t of APPEND_ONLY) {
      for (const role of ["service_role", "postgres"]) {
        const prefix = role === "postgres" ? "" : "set role service_role; ";
        const col = t === "catalogue_product_versions" ? "version" : "id";
        const upd = psql(`${prefix}update ${t} set ${col} = ${col};`);
        const del = psql(`${prefix}delete from ${t};`);
        results.push({ t, role, upd: /append_only/.test(upd.err), del: /append_only/.test(del.err) });
      }
      const trunc = psql(`truncate ${t} cascade;`);
      const svcTrunc = psql(`set role service_role; truncate ${t};`);
      results.push({ t, role: "truncate", upd: /append_only/.test(trunc.err), del: /permission denied|append_only/.test(svcTrunc.err) });
    }
    check("AT03a", "the 7 history tables refuse UPDATE and DELETE for service_role AND the owner (postgres), and TRUNCATE (owner: trigger, service_role: no privilege)", results.every((r) => r.upd && r.del), results.filter((r) => !r.upd || !r.del));
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
    check("M31", "…and keeps every table and row (non-destructive)", one("select count(*) from catalogue_product_versions") === before && one(`select count(*) from pg_class where relnamespace='public'::regnamespace and relname in (${tl})`) === "12", { before, after: one("select count(*) from catalogue_product_versions") });
    const re = applyFile(MIGRATION);
    await reloadSchema(restUrl);
    check("M32", "re-applying the migration restores the functions with the data intact (seed not duplicated)", re.status === 0 && one("select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'catalogue\\_%'") === "11" && one("select count(*) from catalogue_categories where created_by='migration'") === "6", re.err.slice(0, 200));
  }

  const logs = app.logs.join("");
  check("AT80", "no key, JWT secret, session secret or password appears in the server log", ![FULL_KEY, SITE_KEY, sha(SITE_KEY), JWT_SECRET, SESSION_SECRET, PW, ...Object.values(users).map((u) => u.password)].some((s) => logs.includes(s)));
  console.log(JSON.stringify({ suite: "catalogue-postgres", checks, failed: failures }));
}

main()
  .catch((error) => { console.error(error); failures += 1; })
  .finally(async () => { for (const fn of cleanup) { try { await fn(); } catch { /* best effort */ } } process.exit(failures ? 1 : 0); });
