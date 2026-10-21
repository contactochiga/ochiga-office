// S7 R6 (H2) against a DISPOSABLE Supabase-flavoured Postgres 17 only: recovery-code consumption vs credential activation / administrator reset / factor revocation / code regeneration.
// Phase 1 reproduces the deadlock on the schema WITHOUT db/20261029_mfa_lock_order.sql; phase 2 applies it and proves: no deadlock, single use, exactly-once session-generation bump, nothing lost.
// Reuses the frozen certification harness read-only. Credential values are synthetic fixtures; nothing is printed except counts and SQLSTATE codes.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const L = require("./final-cert/C/lib");
const P = require("./final-cert/C/par");

const FIX = "20261029_mfa_lock_order.sql";
const s = new L.Suite("recovery-lock-r6", "R6");
const SUTDIR = process.env.SUT_DIR || path.resolve(__dirname, "..");
const hex = () => L.randomHex(8);

s.main(async () => {
  const st = await L.DbStack.create({ kind: "supabase17", tag: "r6", suite: s });
  st.applyBase();
  const mig = st.applyMigrations(L.dbFiles().filter((f) => f !== FIX));
  s.check("R6-000", "all migrations before the fix apply", mig.every((m) => m.status === 0), mig.filter((m) => m.status).map((m) => m.file));
  const adm = st.session();
  const q = async (sql) => { const r = await adm.query(sql); if (r.error) throw new Error("sql: " + r.error.message + " :: " + sql.slice(0, 100)); return r.rows; };
  const num = async (sql) => Number((await q(sql))[0][0]);
  const newUser = async () => (await L.seedUser(adm, { role: "viewer" })).id;
  const addCred = async (uid, kind, status) => {
    const id = L.uuidv4();
    if (kind === "totp") await q(`insert into admin_mfa_credentials (id, admin_user_id, type, label, status, secret_ciphertext, secret_nonce, secret_key_id, totp_last_step, activated_at) values ('${id}','${uid}','totp','t','${status}','CT','NO','k1',0,${status === "active" ? "now()" : "null"})`);
    else await q(`insert into admin_mfa_credentials (id, admin_user_id, type, label, status, webauthn_credential_id, webauthn_public_key, webauthn_sign_count, activated_at) values ('${id}','${uid}','webauthn','w','${status}',decode('${L.randomHex(16)}','hex'),decode('${L.randomHex(32)}','hex'),0,${status === "active" ? "now()" : "null"})`);
    return id;
  };
  const addCodes = async (uid, hs) => { for (const h of hs) await q(`insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac, key_id) values ('${uid}','${L.uuidv4()}','${h}','k1')`); };
  const gen = (uid) => num(`select session_generation from admin_users where id='${uid}'`);
  const unused = (uid) => num(`select count(*) from admin_mfa_recovery_codes where admin_user_id='${uid}' and used_at is null`);
  const used = (uid) => num(`select count(*) from admin_mfa_recovery_codes where admin_user_id='${uid}' and used_at is not null`);
  const consume = (u, h) => `select * from office_mfa_consume_recovery_code_revoking('${u}', '${h}', 'r6')`;

  // each scenario: n connections, the first k consume distinct codes, the rest run the competing operation
  const scenarios = {
    "consume vs activation": async () => { const u = await newUser(); await addCred(u, "totp", "active"); const hs = Array.from({ length: 6 }, () => "r6-" + hex()); await addCodes(u, hs); const p = await addCred(u, "webauthn", "pending");
      return { u, hs, n: 8, consumers: [0, 1, 2, 3, 4, 5, 7], bumps: true, sql: (i) => (i < 6 ? consume(u, hs[i]) : i === 6 ? `select * from office_mfa_activate_credential('${u}', '${p}', 'r6', null, null, array['r6-n-${hex()}','r6-m-${hex()}'], 'k1')` : consume(u, hs[0])) }; },
    "consume vs administrator reset": async () => { const u = await newUser(); await addCred(u, "totp", "active"); const hs = Array.from({ length: 6 }, () => "r6-" + hex()); await addCodes(u, hs);
      return { u, hs, n: 8, consumers: [0, 1, 2, 3, 4, 5], bumps: true, sql: (i) => (i < 6 ? consume(u, hs[i]) : `select * from office_mfa_reset('${u}', 'r6')`) }; },
    "consume vs factor revocation": async () => { const u = await newUser(); const c = await addCred(u, "totp", "active"); const hs = Array.from({ length: 6 }, () => "r6-" + hex()); await addCodes(u, hs);
      return { u, hs, n: 8, consumers: [0, 1, 2, 3, 4, 5], bumps: true, sql: (i) => (i < 6 ? consume(u, hs[i]) : `select * from office_mfa_revoke_credential('${u}', '${c}', 'r6', 'x', false)`) }; },
    "consume vs code regeneration": async () => { const u = await newUser(); await addCred(u, "totp", "active"); const hs = Array.from({ length: 6 }, () => "r6-" + hex()); await addCodes(u, hs);
      return { u, hs, n: 8, consumers: [0, 1, 2, 3, 4, 5], bumps: false, sql: (i) => (i < 6 ? consume(u, hs[i]) : `select office_mfa_replace_recovery_codes('${u}', '${L.uuidv4()}', array['r6-x-${hex()}','r6-y-${hex()}'], 'k1')`) }; },
  };
  const rounds = async (name, count) => {
    let deadlocks = 0, other = 0, calls = 0; const samples = []; const invariants = [];
    for (let r = 0; r < count; r++) {
      const sc = await scenarios[name](); const g0 = await gen(sc.u);
      const rs = await P.barrier(st, sc.n, sc.sql); calls += sc.n;
      for (const e of P.errors(rs)) { if (e.error.code === "40P01") deadlocks++; else { other++; samples.push(e.error.code); } }
      // exactly-once bump per successful consumption: (successful consume rows) + (1 for the competing operation when it succeeded)
      const isConsumer = (i) => sc.consumers.includes(i);
      const consumed = rs.filter((x, i) => isConsumer(i) && !x.error && x.rows.length > 0).length;
      const compOk = sc.bumps ? rs.filter((x, i) => !isConsumer(i) && !x.error && x.rows.length > 0).length : 0;
      invariants.push({ g0, g1: await gen(sc.u), consumed, compOk, unused: await unused(sc.u), used: await used(sc.u), errs: P.errors(rs).length });
    }
    return { deadlocks, other, calls, samples, invariants };
  };

  // ---- phase 1: reproduce on the pre-fix schema
  await s.section("R6-1", async () => {
    const t = await rounds("consume vs activation", 10);
    const t2 = await rounds("consume vs administrator reset", 10);
    s.check("R6-101", "H2 REPRODUCED: recovery-code consumption racing activation deadlocks (pre-R6)", t.deadlocks > 0, { deadlocks: t.deadlocks, calls: t.calls });
    s.check("R6-102", "H2 REPRODUCED: recovery-code consumption racing administrator reset deadlocks (pre-R6)", t2.deadlocks > 0, { deadlocks: t2.deadlocks, calls: t2.calls });
  });

  // ---- phase 2: apply the fix
  const a1 = st.applyFile(path.join(SUTDIR, "db", FIX)); s.check("R6-200", "the lock-order migration applies cleanly", a1.status === 0, a1.out.slice(0, 200));
  const a2 = st.applyFile(path.join(SUTDIR, "db", FIX)); s.check("R6-201", "…and is idempotent", a2.status === 0, a2.out.slice(0, 200));
  const guard = await L.DbStack.create({ kind: "plain16", tag: "r6g", suite: s });
  const gr = guard.applyFile(path.join(SUTDIR, "db", FIX)); s.check("R6-202", "on a database without the MFA migrations it refuses with a clear message", gr.status !== 0 && /apply 20261025/.test(gr.out));

  await s.section("R6-3", async () => {
    for (const name of Object.keys(scenarios)) {
      const t = await rounds(name, 12);
      s.check(`R6-301-${name}`, `${name} (${t.calls} calls, 12 rounds): no deadlock`, t.deadlocks === 0, { deadlocks: t.deadlocks, other: t.other, samples: t.samples.slice(0, 3) });
      s.check(`R6-302-${name}`, `${name}: no unexpected database error`, t.other === 0, t.samples.slice(0, 3));
      const bad = t.invariants.filter((v) => v.g1 - v.g0 !== v.consumed + v.compOk);
      s.check(`R6-303-${name}`, `${name}: the session generation moves exactly once per successful consumption and once for the competing operation`, bad.length === 0, bad.slice(0, 2));
      if (name === "consume vs administrator reset") s.check(`R6-304-${name}`, "after a reset no unused code remains, and consumed codes stay as history", t.invariants.every((v) => v.unused === 0), t.invariants.slice(0, 2));
      if (name === "consume vs code regeneration") s.check(`R6-305-${name}`, "after a race with regeneration the account never holds a mixture of old unused and new codes beyond the new batch (≤ 2 unused)", t.invariants.every((v) => v.unused <= 2), t.invariants.slice(0, 2));
    }
    // single use: one code, many connections
    for (let r = 0; r < 6; r++) {
      const u = await newUser(); await addCred(u, "totp", "active"); const h = "r6-one-" + hex(); await addCodes(u, [h]); const g0 = await gen(u);
      const rs = await P.barrier(st, 12, () => consume(u, h));
      const wins = rs.filter((x) => !x.error && x.rows.length > 0).length;
      s.check(`R6-310-${r}`, "one recovery code raced by 12 connections: exactly one consumption succeeds, the generation moves exactly once, no error", wins === 1 && (await gen(u)) === g0 + 1 && P.errors(rs).length === 0 && (await used(u)) === 1, { wins, errs: P.errors(rs).map((e) => e.error.code) });
    }
    // invalid / used / foreign codes change nothing
    const u1 = await newUser(), u2 = await newUser(); await addCred(u1, "totp", "active"); await addCodes(u1, ["r6-a-" + hex()]); const hs2 = "r6-b-" + hex(); await addCodes(u2, [hs2]); const g1 = await gen(u1), g2 = await gen(u2);
    const wrong = await q(consume(u1, "r6-nope")); const foreign = await q(consume(u1, hs2)); const missing = await q(consume(L.uuidv4(), hs2));
    s.check("R6-320", "an unknown code, another account's code and an unknown account all return no row and change nothing", wrong.length === 0 && foreign.length === 0 && missing.length === 0 && (await gen(u1)) === g1 && (await gen(u2)) === g2 && (await unused(u2)) === 1);
    const first = await q(consume(u2, hs2)); const again = await q(consume(u2, hs2));
    s.check("R6-321", "sequential: first consumption returns the new generation, a replay returns nothing", first.length === 1 && Number(first[0][0]) === g2 + 1 && again.length === 0 && (await gen(u2)) === g2 + 1);
    // privileges unchanged by create-or-replace
    const priv = st.one("select has_function_privilege('anon','office_mfa_consume_recovery_code_revoking(uuid,text,text)','execute') or has_function_privilege('authenticated','office_mfa_consume_recovery_code_revoking(uuid,text,text)','execute') or has_function_privilege('public','office_mfa_consume_recovery_code_revoking(uuid,text,text)','execute')");
    s.check("R6-330", "the function is still not executable by PUBLIC, anon or authenticated", priv.out === "f", priv.out);
    const sr = st.one("select has_function_privilege('service_role','office_mfa_consume_recovery_code_revoking(uuid,text,text)','execute')"); s.check("R6-331", "…and still executable by service_role", sr.out === "t");
    // rollback file restores the previous definition and is re-appliable
    const rb = st.applyFile(path.join(SUTDIR, "db/rollback/20261029_mfa_lock_order.down.sql")); s.check("R6-340", "the rollback file applies", rb.status === 0, rb.out.slice(0, 200));
    const re = st.applyFile(path.join(SUTDIR, "db", FIX)); s.check("R6-341", "re-applying the fix after a rollback is clean", re.status === 0);
  });
});
