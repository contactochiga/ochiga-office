// S7 R6 (H3/H4) against DISPOSABLE Postgres + PostgREST only: the database-backed limiter shared by every instance, its privileges, failure behaviour and the real
// store/server wiring. Keys are digests; the test also proves no e-mail or network address reaches the table. Skips (exit 0) is NOT used: a missing Docker is BLOCKED.
"use strict";
const path = require("node:path");
const L = require("./final-cert/C/lib");
const { SupabaseLeadAgentsStore } = require("../src/lead-agents/store-supabase");
const { SharedRateLimiter } = require("../src/lead-agents/shared-rate-limit");

const MIG = "20261028_shared_rate_limits.sql";
const s = new L.Suite("shared-rate-limit-r6", "R6");
const SUTDIR = process.env.SUT_DIR || path.resolve(__dirname, "..");
const SECRET = "r6-test-secret-" + L.randomHex(16);

s.main(async () => {
  const st = await L.DbStack.create({ kind: "supabase17", tag: "r6rl", postgrest: true, suite: s });
  st.applyBase();
  const pre = st.applyMigrations(L.dbFiles().filter((f) => f !== MIG)); s.check("R6L-000", "all migrations before the limiter migration apply", pre.every((m) => m.status === 0));
  await st.settle();
  const gw = await new L.FaultProxy(st.url).start(); // plays the Supabase gateway: strips /rest/v1 before PostgREST
  const mkStore = () => new SupabaseLeadAgentsStore({ url: gw.url, serviceRoleKey: st.jwt("service_role"), requestTimeoutMs: 8000 });
  const mk = (store, ns, windowMs, max) => new SharedRateLimiter({ store, namespace: ns, secret: SECRET, windowMs, maxRequests: max });

  // ---- before the migration: honest per-process fallback
  await s.section("R6L-1", async () => {
    const lim = mk(mkStore(), "pre", 60000, 3);
    s.eq("R6L-101", "without the migration the scope is reported as 'process'", await lim.scope(), "process");
    const r = []; for (let i = 0; i < 5; i += 1) { try { await lim.checkKey("k"); r.push(200); } catch (e) { r.push(e.statusCode); } }
    s.eq("R6L-102", "…and the budget still works inside the process (3 allowed, then refused)", JSON.stringify(r), JSON.stringify([200, 200, 200, 429, 429]));
  });

  const a = st.applyFile(path.join(SUTDIR, "db", MIG)); s.check("R6L-200", "the limiter migration applies cleanly", a.status === 0, a.out.slice(0, 200));
  s.check("R6L-201", "…and is idempotent", st.applyFile(path.join(SUTDIR, "db", MIG)).status === 0);
  await st.settle(async () => (await st.rpc("service_role", "office_rate_limit_version")).json === 1);

  await s.section("R6L-3", async () => {
    // two "instances": separate store objects (separate capability caches) against one database
    const sa = mkStore(), sb = mkStore();
    const A = mk(sa, "login", 60000, 5), B = mk(sb, "login", 60000, 5);
    await new Promise((r) => setTimeout(r, 61000)); // capability re-probe window (a 404 before the migration is cached for a minute)
    s.eq("R6L-301", "after the migration both instances report scope 'shared'", [await A.scope(), await B.scope()].join(","), "shared,shared");
    const out = [];
    for (let i = 0; i < 8; i += 1) { const lim = i % 2 ? B : A; try { await lim.checkKey("addr-1"); out.push(200); } catch (e) { out.push(e.statusCode); } }
    s.eq("R6L-302", "five hits split across two instances exhaust ONE budget (no second budget by switching instance)", JSON.stringify(out), JSON.stringify([200, 200, 200, 200, 200, 429, 429, 429]));
    s.check("R6L-303", "a different key has its own budget", (await A.checkKey("addr-2")).remaining === 4);
    s.check("R6L-304", "isLimited / resetAtOf agree on both instances", (await B.isLimited("addr-1")) === true && (await A.isLimited("addr-2")) === false && (await B.resetAtOf("addr-1")) > Date.now());
    await B.resetKey("addr-1"); s.check("R6L-305", "reset on one instance clears the budget for the other", (await A.isLimited("addr-1")) === false && (await A.checkKey("addr-1")).remaining === 4);

    // concurrency: 40 simultaneous hits across both instances, budget 10 => exactly 10 pass
    const C = mk(sa, "burst", 60000, 10), D = mk(sb, "burst", 60000, 10);
    const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? D : C).checkKey("burst-key").then(() => 200, (e) => e.statusCode || 500)));
    s.eq("R6L-310", "40 concurrent attempts across two instances: exactly 10 pass, 30 are refused, none error", `${burst.filter((x) => x === 200).length}/${burst.filter((x) => x === 429).length}/${burst.filter((x) => x === 500).length}`, "10/30/0");

    // window expiry restarts the count
    const E = mk(sa, "short", 1000, 2); await E.checkKey("w"); await E.checkKey("w"); let blocked = false; try { await E.checkKey("w"); } catch { blocked = true; }
    await new Promise((r) => setTimeout(r, 2300)); const again = await E.checkKey("w").then(() => true, () => false);
    s.check("R6L-320", "a spent budget is refused, and a new window starts after expiry", blocked && again);

    // failure-only counters (hit / isLimited) used for per-account ceilings
    const F = mk(sa, "acct", 60000, 3); for (let i = 0; i < 3; i += 1) await F.hit("acct:x"); s.check("R6L-330", "hit() counts without throwing and isLimited() trips at the ceiling", (await mk(sb, "acct", 60000, 3).isLimited("acct:x")) === true);
    s.check("R6L-331", "namespaces are independent: the same key under another namespace is untouched", (await mk(sb, "other", 60000, 3).isLimited("acct:x")) === false);

    // privacy: the table holds digests only
    const rows = st.one("select string_agg(key_digest, ',') from admin_rate_limits").out;
    s.check("R6L-340", "no stored key contains an e-mail address, a network address or the raw key", !/addr-|acct|burst|@/.test(rows) && rows.split(",").every((d) => /^[0-9a-f]{64}$/.test(d)));
    s.check("R6L-341", "keys are keyed (HMAC): a different secret yields different digests", new SharedRateLimiter({ store: sa, namespace: "login", secret: "another-secret-xxxxxxxx", windowMs: 1, maxRequests: 1 }).digest("addr-1") !== A.digest("addr-1"));

    // privileges
    for (const role of ["anon", "authenticated"]) {
      const rd = await st.rest(role, "GET", "/admin_rate_limits?select=*&limit=3"); s.check(`R6L-350-${role}`, `${role} cannot read the counter table`, !(rd.status === 200 && Array.isArray(rd.json) && rd.json.length > 0), rd.status);
      const wr = await st.rest(role, "POST", "/admin_rate_limits", { body: { key_digest: "a".repeat(64), hits: 0, window_ends_at: new Date().toISOString() }, headers: { Prefer: "return=minimal" } }); s.check(`R6L-351-${role}`, `${role} cannot write the counter table`, wr.status >= 400, wr.status);
      const fn = await st.rpc(role, "office_rate_limit_hit", { p_key_digest: "b".repeat(64), p_window_seconds: 60 }); s.check(`R6L-352-${role}`, `${role} cannot execute the limiter functions`, fn.status >= 400, fn.status);
      const rs = await st.rpc(role, "office_rate_limit_reset", { p_key_digest: "b".repeat(64) }); s.check(`R6L-353-${role}`, `${role} cannot reset a counter`, rs.status >= 400, rs.status);
    }
    const rls = st.one("select relrowsecurity from pg_class where relname='admin_rate_limits'").out; s.eq("R6L-354", "row level security is on for the counter table", rls, "t");
    const bad = await st.rpc("service_role", "office_rate_limit_hit", { p_key_digest: "not-a-digest", p_window_seconds: 60 }); s.check("R6L-355", "a malformed key is rejected by the table constraint, not stored", bad.status >= 400);
    const exp = st.one("select count(*) from admin_rate_limits where window_ends_at < now() - interval '1 day'"); s.eq("R6L-356", "no expired window lingers beyond a day", exp.out, "0");

    // fail closed
    await gw.setMode("down");
    const dead = mk(mkStore(), "down", 60000, 5);
    const r1 = await dead.checkKey("k").then(() => "allowed", (e) => e.code || e.message);
    s.eq("R6L-360", "database/gateway down: checkKey fails closed with rate_limit_store_error (never 'allowed')", r1, "rate_limit_store_error");
    const r2 = await dead.isLimited("k").then(() => "answered", (e) => e.code);
    s.eq("R6L-361", "…and so does isLimited", r2, "rate_limit_store_error");
    const sc = await mk(sa, "login", 60000, 5).scope(); s.check("R6L-362", "an already-probed instance does not silently fall back to per-process counting when the gateway dies", sc === "shared", sc);
  });

  await s.section("R6L-4", async () => {
    const rb = st.applyFile(path.join(SUTDIR, "db/rollback/20261028_shared_rate_limits.down.sql")); s.check("R6L-401", "the rollback applies (counters are ephemeral)", rb.status === 0, rb.out.slice(0, 200));
    s.eq("R6L-402", "…and removes only the limiter objects", st.one("select count(*) from pg_proc where proname like 'office_rate_limit%'").out, "0");
    s.check("R6L-403", "…while admin_users and the MFA tables are intact", Number(st.one("select count(*) from information_schema.tables where table_name in ('admin_users','admin_mfa_credentials','admin_revoked_sessions')").out) === 3);
  });
});
