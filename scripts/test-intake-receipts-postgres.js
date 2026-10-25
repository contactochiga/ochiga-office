// Intake receipts on DISPOSABLE Postgres (Supabase image) + PostgREST + the real Office server (supabase store driver). Never a real project.
// Proves: the migration's privilege boundary; an atomic claim under real concurrency (SQL and HTTP); lease expiry with fencing; interrupted CRM
// writes (both the "swallowed 400" path and a thrown error) stay retryable, are never reported as duplicates, and finish without duplicate
// records once the fault is gone; a lead-write failure is retryable; rollback is non-destructive and the application falls back.
// Requires Docker and the images public.ecr.aws/supabase/postgres:17.6.1.131 and public.ecr.aws/supabase/postgrest:v14.12 (BLOCKED otherwise).
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PG_IMAGE = process.env.PG_IMAGE || "public.ecr.aws/supabase/postgres:17.6.1.131";
const PGRST_IMAGE = process.env.PGRST_IMAGE || "public.ecr.aws/supabase/postgrest:v14.12";
const RUN = crypto.randomBytes(3).toString("hex");
const NET = `intake-net-${RUN}`, PG = `intake-pg-${RUN}`, REST = `intake-rest-${RUN}`;
const PW = `pw_${crypto.randomBytes(10).toString("hex")}`, JWT_SECRET = crypto.randomBytes(24).toString("hex");
const SITE_KEY = `oyi_${crypto.randomBytes(24).toString("hex")}`, FULL_KEY = `full_${crypto.randomBytes(12).toString("hex")}`;
const MIGRATION = path.join(ROOT, "db", "20261101_office_intake_receipts.sql");
const ROLLBACK = path.join(ROOT, "db", "rollback", "20261101_office_intake_receipts.down.sql");
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0, failures = 0;
const check = (id, text, cond, detail) => { checks += 1; if (!cond) failures += 1; console.log(`${cond ? "PASS" : "FAIL"} ${id} ${text}${cond ? "" : " :: " + String(JSON.stringify(detail === undefined ? null : detail)).slice(0, 500)}`); };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });
const cleanup = [];

function psql(sql, { stop = true } = {}) {
  const r = sh("docker", ["exec", "-i", PG, "psql", "-X", "-q", "-At", "-U", "postgres", "-d", "postgres", "-v", `ON_ERROR_STOP=${stop ? 1 : 0}`], { input: sql });
  return { status: r.status, out: (r.stdout || "").trim(), err: r.stderr || "" };
}
const one = (sql) => psql(sql).out;
const applyFile = (file, opts) => psql(fs.readFileSync(file, "utf8"), opts);
function jwt(role) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b({ alg: "HS256", typ: "JWT" }), body = b({ role, iss: "intake-test", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7200 });
  return `${head}.${body}.${crypto.createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`;
}

async function setup() {
  for (const img of [PG_IMAGE, PGRST_IMAGE]) if (sh("docker", ["image", "inspect", img]).status !== 0) throw new Error(`BLOCKED: docker image ${img} not available`);
  sh("docker", ["network", "create", NET]); cleanup.push(() => sh("docker", ["network", "rm", NET]));
  let r = sh("docker", ["run", "-d", "--rm", "--name", PG, "--network", NET, "--network-alias", "pg", "-e", `POSTGRES_PASSWORD=${PW}`, PG_IMAGE]);
  if (r.status !== 0) throw new Error("BLOCKED: postgres container: " + r.stderr);
  cleanup.unshift(() => sh("docker", ["rm", "-f", PG]));
  let good = 0;
  for (let i = 0; i < 400 && good < 3; i += 1) { const x = sh("docker", ["exec", PG, "psql", "-X", "-At", "-U", "postgres", "-h", "127.0.0.1", "-c", "select count(*) from pg_roles where rolname in ('anon','authenticated','service_role','authenticator')"]); good = x.stdout && x.stdout.trim() === "4" ? good + 1 : 0; await sleep(300); }
  if (good < 3) throw new Error("BLOCKED: postgres not ready");
  // schema exactly as this branch ships it: bootstrap (two passes: the pre-R10 bootstrap has a forward reference) + every dated migration
  psql(fs.readFileSync(path.join(ROOT, "db", "lead-agents-schema.sql"), "utf8"), { stop: false });
  const second = psql(fs.readFileSync(path.join(ROOT, "db", "lead-agents-schema.sql"), "utf8"), { stop: false });
  check("P00", "bootstrap schema: second pass is clean", !/ERROR/.test(second.err), second.err.slice(0, 300));
  const dated = fs.readdirSync(path.join(ROOT, "db")).filter((f) => /^2026\d+.*\.sql$/.test(f) && f !== path.basename(MIGRATION)).sort();
  const failedMigs = dated.map((f) => ({ f, r: applyFile(path.join(ROOT, "db", f)) })).filter((x) => x.r.status !== 0);
  check("P01", "every pre-existing dated migration applies", failedMigs.length === 0, failedMigs.map((x) => x.f + ": " + x.r.err.slice(0, 200)));
  // the production hardening state (RLS on every table, nothing for PUBLIC/anon/authenticated, schema USAGE closed) -- as measured in R11
  const p0 = psql(`
    revoke all on all tables in schema public from public, anon, authenticated;
    revoke all on all sequences in schema public from public, anon, authenticated;
    revoke all on all functions in schema public from public, anon, authenticated;
    do $$ declare r record; begin for r in select c.oid::regclass as rel from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') loop execute format('alter table %s enable row level security', r.rel); end loop; end $$;
    grant usage on schema public to service_role, authenticator, postgres;
    revoke usage on schema public from public, anon, authenticated;
    alter default privileges in schema public revoke all on tables from anon, authenticated;
    alter default privileges in schema public revoke all on functions from anon, authenticated;`);
  check("P02", "production hardening state applied to the fixture", p0.status === 0, p0.err.slice(0, 300));
  // PostgREST + a gateway that plays Supabase's /rest/v1 prefix
  sh("docker", ["exec", PG, "psql", "-X", "-U", "supabase_admin", "-d", "postgres", "-h", "127.0.0.1", "-c", `alter role authenticator with password '${PW}'`]);
  const restPort = await freePort();
  r = sh("docker", ["run", "-d", "--rm", "--name", REST, "--network", NET, "-p", `127.0.0.1:${restPort}:3000`, "-e", `PGRST_DB_URI=postgres://authenticator:${PW}@pg:5432/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`, "-e", "PGRST_SERVER_PORT=3000", PGRST_IMAGE]);
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
  for (let i = 0; i < 60; i += 1) { await sleep(250); const r = await rest(restUrl, "service_role", "GET", "/leads?limit=0"); if (r.status === 200) break; }
  await sleep(500);
}

async function startApp(gatewayUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-pg-app-"));
  const port = await freePort();
  const logs = [];
  const proc = spawn(process.execPath, ["lead-agents-server.js"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: dir, NODE_ENV: "test", LEAD_AGENTS_HOST: "127.0.0.1", LEAD_AGENTS_PORT: String(port), OFFICE_STORAGE_DIR: path.join(dir, "storage"),
      LEAD_AGENTS_STORE_DRIVER: "supabase", SUPABASE_URL: gatewayUrl, SUPABASE_SERVICE_ROLE_KEY: jwt("service_role"),
      LEAD_AGENTS_AUTH_MODE: "required_api_key", LEAD_AGENTS_API_KEYS: FULL_KEY, LEAD_AGENTS_SESSION_SECRET: crypto.randomBytes(24).toString("hex"),
      LEAD_AGENTS_SCOPED_API_KEYS: JSON.stringify([{ client: "getoyi", key_sha256: sha(SITE_KEY), scopes: ["intake.submit"] }]),
      OPENAI_API_KEY: "sk-fixture-not-real", OPENAI_BASE_URL: "http://127.0.0.1:9/v1", LEAD_AGENTS_RATE_LIMIT_MAX_REQUESTS: "100000", LEAD_AGENTS_OFFICE_RATE_LIMIT_MAX_REQUESTS: "100000",
    },
  });
  proc.stdout.on("data", (d) => logs.push(String(d))); proc.stderr.on("data", (d) => logs.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i += 1) { if (await fetch(url + "/healthz").catch(() => null)) break; await sleep(100); }
  const app = { url, logs, stop: () => new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once("exit", r); proc.kill("SIGTERM"); }) };
  cleanup.unshift(() => app.stop());
  return app;
}

const envelope = (idem, email, message) => ({
  request_id: `req-${crypto.randomUUID()}`, idempotency_key: idem, source_channel: "website", source_site: "oyi_website", source_page: "/deployments",
  source_form: "oyi_deployment_request", business_unit: "technology", inquiry_type: "oyi_deployment_request",
  contact: { name: "Ada Test", email, phone: "" }, organization: { name: `Estate ${email}`, location: "Lekki" }, payload: { message },
});
async function intake(app, body, key = SITE_KEY) {
  const r = await fetch(app.url + "/api/office/intake", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify({ ...body, request_id: `req-${crypto.randomUUID()}` }) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json };
}
const counts = (email, key) => JSON.parse(one(`select json_build_object(
  'leads', (select count(*) from leads where email = '${email}'),
  'opportunities', (select count(*) from crm_opportunities o join leads l on l.id = o.lead_id where l.email = '${email}'),
  'activities', (select count(*) from crm_activities a join leads l on l.id = a.lead_id where l.email = '${email}' and a.activity_type = 'website_intake_received'),
  'events', (select count(*) from timeline_events where event_type = 'office_intake_received' and metadata->>'idempotency_key' = '${key}'),
  'receipt', (select row_to_json(r) from (select status, attempts, lead_id is not null as has_lead, last_error from office_intake_receipts where idempotency_key = '${key}') r))`));

async function main() {
  const { restUrl, gatewayUrl } = await setup();

  // ---------------- migration and privilege boundary
  const m1 = applyFile(MIGRATION), m2 = applyFile(MIGRATION);
  check("P10", "the receipts migration applies, and a second application is clean", m1.status === 0 && m2.status === 0, (m1.err + m2.err).slice(0, 300));
  check("P11", "row level security is on and there is NO policy (deny by default)", one("select relrowsecurity from pg_class where oid = 'office_intake_receipts'::regclass") === "t" && one("select count(*) from pg_policy where polrelid = 'office_intake_receipts'::regclass") === "0");
  check("P12", "anon/authenticated hold no privilege on the table and cannot execute any receipts function", one(`select count(*) from (values ('anon'),('authenticated')) r(r), (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(p) where has_table_privilege(r.r, 'office_intake_receipts', p.p)`) === "0" && one(`select count(*) from pg_proc p, (values ('anon'),('authenticated')) r(r) where p.proname like 'office_intake%' and has_function_privilege(r.r, p.oid, 'EXECUTE')`) === "0");
  check("P13", "service_role may only SELECT the table (writes go through the functions)", one("select string_agg(p, ',' order by p) from (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) x(p) where has_table_privilege('service_role', 'office_intake_receipts', p)") === "SELECT");
  check("P14", "the whole public schema still exposes nothing to the Data API roles (R11 baseline)", one(`select count(*) from pg_class c, (values ('anon'),('authenticated')) r(r) where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','v','m') and (has_table_privilege(r.r, c.oid, 'SELECT') or has_table_privilege(r.r, c.oid, 'INSERT'))`) === "0" && one("select count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r' and not relrowsecurity") === "0");
  await reloadSchema(restUrl);
  for (const role of ["anon", "authenticated"]) {
    const t = await rest(restUrl, role, "GET", "/office_intake_receipts?select=*");
    const f = await rest(restUrl, role, "POST", "/rpc/office_intake_claim", { p_key: "x", p_client: "", p_request_id: "", p_digest: "0".repeat(64), p_lease_seconds: 30 });
    check(`P15-${role}`, `through PostgREST, ${role} can neither read receipts nor claim a key`, t.status >= 400 && f.status >= 400, { table: t.status, rpc: f.status });
  }
  const direct = await rest(restUrl, "service_role", "POST", "/office_intake_receipts", { idempotency_key: "direct", payload_digest: "0".repeat(64), status: "completed" });
  check("P16", "service_role cannot forge a 'completed' receipt by writing the table directly", direct.status >= 400 && one("select count(*) from office_intake_receipts where idempotency_key = 'direct'") === "0", direct.status);

  // ---------------- atomic claim under real concurrency (SQL level)
  const sqlKey = `sql:${crypto.randomUUID()}`, digest = "a".repeat(64);
  const outcomes = await Promise.all(Array.from({ length: 20 }, () => new Promise((resolve) => {
    const p = spawn("docker", ["exec", "-i", PG, "psql", "-X", "-At", "-U", "postgres", "-d", "postgres", "-c", `select outcome from office_intake_claim('${sqlKey}', 'getoyi', 'r', '${digest}', 30)`]);
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.on("exit", () => resolve(out.trim()));
  })));
  check("P20", "20 simultaneous claims of one key: exactly one 'claimed', 19 'in_progress'", outcomes.filter((o) => o === "claimed").length === 1 && outcomes.filter((o) => o === "in_progress").length === 19, outcomes);
  check("P21", "re-using a key for different content answers 'conflict'", one(`select outcome from office_intake_claim('${sqlKey}', 'getoyi', 'r', '${"b".repeat(64)}', 30)`) === "conflict");
  // lease expiry + fencing
  const leaseKey = `lease:${crypto.randomUUID()}`;
  one(`select outcome from office_intake_claim('${leaseKey}', 'getoyi', 'r1', '${digest}', 5)`);
  await sleep(6000);
  const re = one(`select outcome || ':' || attempts from office_intake_claim('${leaseKey}', 'getoyi', 'r2', '${digest}', 30)`);
  check("P22", "after the lease expires another request re-claims the key (attempt 2)", re === "reclaimed:2", re);
  check("P23", "…the stale attempt 1 can no longer complete or fail it (fenced)", one(`select office_intake_complete('${leaseKey}', 1, null)`) === "f" && one(`select office_intake_fail('${leaseKey}', 1, null, 'late')`) === "f");
  check("P24", "…the current attempt completes it, and the key then answers 'duplicate'", one(`select office_intake_complete('${leaseKey}', 2, null)`) === "t" && one(`select outcome from office_intake_claim('${leaseKey}', 'getoyi', 'r3', '${digest}', 30)`) === "duplicate");

  // ---------------- the real application
  let app = await startApp(gatewayUrl);
  const K = crypto.randomUUID(), key = `getoyi:${K}`, burstEnv = envelope(K, "burst@example.com", "burst");
  const burst = await Promise.all(Array.from({ length: 10 }, () => intake(app, burstEnv)));
  const st = burst.map((r) => r.status);
  check("P30", "10 simultaneous identical submissions through Office: exactly one 201, the rest 200/409", st.filter((s) => s === 201).length === 1 && st.every((s) => [200, 201, 409].includes(s)), st);
  let c = counts("burst@example.com", key);
  check("P31", "…one lead, one opportunity, one CRM activity, one intake event, receipt completed after ONE attempt", c.leads === 1 && c.opportunities === 1 && c.activities === 1 && c.events === 1 && c.receipt && c.receipt.status === "completed" && c.receipt.attempts === 1, c);
  const lease150 = one(`select outcome from office_intake_claim('lease-probe:${RUN}', 'getoyi', 'r', '${"c".repeat(64)}', 150)`);
  const lease601 = psql(`select outcome from office_intake_claim('lease-probe2:${RUN}', 'getoyi', 'r', '${"c".repeat(64)}', 601)`);
  check("P32", "the application's lease (150 s for the default 120 s request timeout) is within the claim function's bounds; out-of-range leases are refused", lease150 === "claimed" && lease601.status !== 0 && /invalid_lease/.test(lease601.err), { lease150, lease601: lease601.err.slice(0, 120) });

  // interrupted CRM write, mode 1: the activity insert fails with a raised exception -> PostgREST 400 -> createCorporateRecord would have SWALLOWED it
  psql(`create table if not exists test_fault (target text primary key);
    create or replace function test_fault_trigger() returns trigger language plpgsql as $$ begin if exists (select 1 from test_fault where target = tg_table_name) then raise exception 'injected fault on %', tg_table_name; end if; return new; end $$;
    drop trigger if exists test_fault_activities on crm_activities; create trigger test_fault_activities before insert on crm_activities for each row execute function test_fault_trigger();
    drop trigger if exists test_fault_leads on leads; create trigger test_fault_leads before insert on leads for each row execute function test_fault_trigger();
    insert into test_fault values ('crm_activities');`);
  const I = crypto.randomUUID(), ikey = `getoyi:${I}`, ienv = envelope(I, "interrupt@example.com", "interrupted");
  const i1 = await intake(app, ienv);
  c = counts("interrupt@example.com", ikey);
  check("P40", "CRM write fails (swallowed-400 path): answer 202 with crm_synced=false and retryable, NOT a success", i1.status === 202 && i1.json.crm_synced === false && i1.json.retryable === true, i1);
  check("P41", "…the receipt is 'crm_failed' (never 'completed'), the lead is filed, the opportunity written once, no intake event yet", c.receipt.status === "crm_failed" && c.receipt.attempts === 1 && c.leads === 1 && c.opportunities === 1 && c.activities === 0 && c.events === 0, c);
  const i2 = await intake(app, ienv);
  c = counts("interrupt@example.com", ikey);
  check("P42", "a retry while the fault persists is NOT reported as a duplicate: 202 again, attempt 2, still ONE opportunity", i2.status === 202 && i2.json.duplicate === false && c.receipt.attempts === 2 && c.opportunities === 1 && c.leads === 1, { i2, c });
  // mode 2: thrown error (insufficient privilege -> PostgREST 403 -> createCorporateRecord throws)
  psql("delete from test_fault; revoke insert on crm_activities from service_role;");
  const i3 = await intake(app, ienv);
  c = counts("interrupt@example.com", ikey);
  check("P43", "a different fault class (thrown, 403) is equally retryable: 202, attempt 3, no duplicate records", i3.status === 202 && c.receipt.status === "crm_failed" && c.receipt.attempts === 3 && c.opportunities === 1, { i3, c });
  psql("grant insert on crm_activities to service_role;");
  const i4 = await intake(app, ienv);
  c = counts("interrupt@example.com", ikey);
  check("P44", "fault removed: the retry completes (201, crm_synced)", i4.status === 201 && i4.json.crm_synced === true, i4);
  check("P45", "…with exactly one lead, one opportunity, one activity and one intake event, receipt completed at attempt 4", c.leads === 1 && c.opportunities === 1 && c.activities === 1 && c.events === 1 && c.receipt.status === "completed" && c.receipt.attempts === 4, c);
  const i5 = await intake(app, ienv);
  check("P46", "…and only now is it a duplicate", i5.status === 200 && i5.json.duplicate === true, i5);

  // lead write failure
  psql("insert into test_fault values ('leads');");
  const L = crypto.randomUUID(), lkey = `getoyi:${L}`, lenv = envelope(L, "leadfail@example.com", "lead fails");
  const l1 = await intake(app, lenv);
  c = counts("leadfail@example.com", lkey);
  check("P50", "a lead write failure answers 503 retryable and records the key as failed (retryable)", l1.status === 503 && l1.json.retryable === true && c.leads === 0 && c.receipt.status === "crm_failed", { l1, c });
  psql("delete from test_fault;");
  const l2 = await intake(app, lenv);
  c = counts("leadfail@example.com", lkey);
  check("P51", "…and the retry files it once", l2.status === 201 && c.leads === 1 && c.events === 1 && c.receipt.status === "completed", { l2, c });

  // credential separation on the real stack
  const denied = await fetch(app.url + "/api/lead-agents/admin/leads", { headers: { "x-api-key": SITE_KEY } });
  check("P60", "the scoped website key is refused on staff routes against the real stack", denied.status === 403, denied.status);
  check("P61", "every scoped answer above is minimal", [...burst, i1, i2, i3, i4, i5, l1, l2].every((r) => r.json && Object.keys(r.json).every((k) => ["ok", "duplicate", "request_id", "idempotency_key", "lead_id", "crm_synced", "retryable", "error"].includes(k))));

  // ---------------- rollback: non-destructive; the application falls back to Phase 0 behaviour
  const rb = applyFile(ROLLBACK);
  check("P70", "rollback runs, keeps the receipts table and its rows, removes the functions", rb.status === 0 && one("select to_regclass('public.office_intake_receipts') is not null") === "t" && Number(one("select count(*) from office_intake_receipts")) > 0 && one("select count(*) from pg_proc where proname like 'office_intake%'") === "0");
  await reloadSchema(restUrl);
  const live = await intake(app, envelope(crypto.randomUUID(), "live-rollback@example.com", "rollback without restart"));
  check("P71a", "rollback WITHOUT restarting Office: the very next intake still files (falls back in the same request, no 503 window)", live.status === 201, live);
  await app.stop(); app = await startApp(gatewayUrl);
  const fb = await intake(app, envelope(crypto.randomUUID(), "fallback@example.com", "after rollback"));
  check("P71", "after rollback and a restart the application still files intake (Phase 0 path)", fb.status === 201, fb);
  // negative control: without the atomic claim, simultaneous identical submissions are NOT guaranteed to be filed once
  const N = crypto.randomUUID(), nenv = envelope(N, "race@example.com", "race");
  const nb = await Promise.all(Array.from({ length: 10 }, () => intake(app, nenv)));
  const nc = counts("race@example.com", `getoyi:${N}`);
  console.log(`INFO negative control (receipt functions removed): statuses ${JSON.stringify(nb.map((r) => r.status))}, records ${JSON.stringify({ leads: nc.leads, opportunities: nc.opportunities, activities: nc.activities, events: nc.events })}`);
  check("P72", "negative control: WITHOUT the receipts the same burst is filed more than once (the defect the migration closes)", nc.events > 1 || nc.activities > 1 || nc.opportunities > 1, nc);
  const ra = applyFile(MIGRATION);
  check("P73", "re-applying the migration after rollback succeeds and keeps the earlier receipts", ra.status === 0 && Number(one("select count(*) from office_intake_receipts where status = 'completed'")) >= 3);

  // ---------------- nothing secret in logs
  const logText = app.logs.join("");
  check("P80", "no API key, key digest, JWT secret or database password appears in the application log", ![SITE_KEY, FULL_KEY, sha(SITE_KEY), JWT_SECRET, PW].some((s) => logText.includes(s)));

  console.log(JSON.stringify({ suite: "intake-receipts-postgres", checks, failed: failures }));
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error(String(e && e.message || e)); process.exitCode = /BLOCKED/.test(String(e)) ? 2 : 1; })
  .finally(async () => { for (const fn of cleanup) { try { await fn(); } catch { /* best effort */ } } });
