// S7 R9 against DISPOSABLE Supabase-flavoured Postgres 17 + PostgREST only (never a real project): factor-population evidence and the mailbox attempt budget through the real
// SupabaseLeadAgentsStore, with a fault-injecting gateway. Credential values are synthetic; only counts, codes and booleans are recorded.
"use strict";
const path = require("node:path");
const L = require("./final-cert/C/lib");
const { SupabaseLeadAgentsStore } = require("./../src/lead-agents/store-supabase");

const EVID = "20261030_mfa_active_factor_evidence.sql", MBOX = "20261031_mfa_mailbox_attempts.sql";
const s = new L.Suite("mfa-closure-postgres-r9", "R9");
const SUTDIR = process.env.SUT_DIR || path.resolve(__dirname, "..");

s.main(async () => {
  const st = await L.DbStack.create({ kind: "supabase17", tag: "r9", postgrest: true, suite: s });
  st.applyBase();
  const pre = st.applyMigrations(L.dbFiles().filter((f) => f !== EVID && f !== MBOX)); s.check("R9-000", "all earlier migrations apply", pre.every((m) => m.status === 0), pre.filter((m) => m.status).map((m) => m.file));
  const adm = st.session();
  const q = async (sql) => { const r = await adm.query(sql); if (r.error) throw new Error("sql: " + r.error.message + " :: " + sql.slice(0, 100)); return r.rows; };
  const num = async (sql) => Number((await q(sql))[0][0]);
  const newUser = async () => (await L.seedUser(adm, { role: "viewer" })).id;
  const addCred = async (uid, status = "active", type = "totp") => { const id = L.uuidv4(); await q(type === "totp"
    ? `insert into admin_mfa_credentials (id, admin_user_id, type, label, status, secret_ciphertext, secret_nonce, secret_key_id, totp_last_step, activated_at) values ('${id}','${uid}','totp','t','${status}','CT','NO','k1',0,${status === "active" ? "now()" : "null"})`
    : `insert into admin_mfa_credentials (id, admin_user_id, type, label, status, webauthn_credential_id, webauthn_public_key, webauthn_sign_count, activated_at) values ('${id}','${uid}','webauthn','w','${status}',decode('${L.randomHex(16)}','hex'),decode('${L.randomHex(32)}','hex'),0,${status === "active" ? "now()" : "null"})`); return id; };
  const marker = (uid) => num(`select mfa_active_count from admin_users where id='${uid}'`);
  await st.settle(async () => (await st.rpc("service_role", "office_mfa_schema_version")).json === 1);
  const gw = await new L.FaultProxy(st.url).start();
  const mkStore = () => new SupabaseLeadAgentsStore({ url: gw.url, serviceRoleKey: st.jwt("service_role"), requestTimeoutMs: 8000 });
  const credUrl = (rec) => rec.url.includes("/admin_mfa_credentials") && rec.method === "GET";

  // ---------------------------------------------------------------- phase 1: the exposure, before the migration
  const uPre = await newUser(); await addCred(uPre);
  { const store = mkStore();
    gw.rule(credUrl, "emptylist");
    const r = await store.hasActiveMfa(uPre);
    s.check("R9-101", "EXPOSURE REPRODUCED (pre-R9 schema): an empty factor list makes an ENROLLED account read as unenrolled", r === false);
    gw.clearRules();
    s.eq("R9-102", "…and the same account reads as enrolled when the gateway is honest", await store.hasActiveMfa(uPre), true); }

  // ---------------------------------------------------------------- phase 2: migrations
  s.check("R9-200", "the evidence migration applies", st.applyFile(path.join(SUTDIR, "db", EVID)).status === 0);
  s.check("R9-201", "…and is idempotent", st.applyFile(path.join(SUTDIR, "db", EVID)).status === 0);
  s.check("R9-202", "the mailbox migration applies and is idempotent", st.applyFile(path.join(SUTDIR, "db", MBOX)).status === 0 && st.applyFile(path.join(SUTDIR, "db", MBOX)).status === 0);
  const guard = await L.DbStack.create({ kind: "plain16", tag: "r9g", suite: s });
  const g1 = guard.applyFile(path.join(SUTDIR, "db", EVID)), g2 = guard.applyFile(path.join(SUTDIR, "db", MBOX));
  s.check("R9-203", "on a database without the MFA foundation both refuse with a clear message (ordering guard)", g1.status !== 0 && /apply 20261022/.test(g1.out) && g2.status !== 0 && /apply 20261022/.test(g2.out));
  await st.settle(async () => (await st.rpc("service_role", "office_mfa_evidence_version")).json === 1 && (await st.rpc("service_role", "office_mfa_mailbox_version")).json === 1);
  s.eq("R9-204", "the one-time backfill counted the account that was enrolled BEFORE the migration", await marker(uPre), 1);

  // ---------------------------------------------------------------- triggers keep the evidence true
  await s.section("R9-3", async () => {
    const u = await newUser();
    s.eq("R9-301", "a new account has marker 0", await marker(u), 0);
    const pending = await addCred(u, "pending"); s.eq("R9-302", "a pending credential does not count", await marker(u), 0);
    await q(`select * from office_mfa_activate_credential('${u}', '${pending}', 'r9', null, null, null, null)`); s.eq("R9-303", "activation through the atomic function makes it 1", await marker(u), 1);
    const second = await addCred(u, "active", "webauthn"); s.eq("R9-304", "a second active factor makes it 2", await marker(u), 2);
    await q(`select * from office_mfa_revoke_credential('${u}', '${second}', 'r9', 'x', false)`); s.eq("R9-305", "revoking one factor makes it 1", await marker(u), 1);
    await q(`update admin_mfa_credentials set totp_last_step = totp_last_step + 1 where admin_user_id='${u}' and type='totp'`); s.eq("R9-306", "a counter update (no status change) leaves it at 1", await marker(u), 1);
    await q(`select * from office_mfa_reset('${u}', 'r9')`); s.eq("R9-307", "administrator reset makes it 0", await marker(u), 0);
    const w = await addCred(u); await q(`delete from admin_mfa_credentials where id='${w}'`); s.eq("R9-308", "deleting an active factor makes it 0", await marker(u), 0);
    const a = await newUser(), b = await newUser(); const moved = await addCred(a); await q(`update admin_mfa_credentials set admin_user_id='${b}' where id='${moved}'`);
    s.check("R9-309", "moving a credential between accounts fixes BOTH counts", (await marker(a)) === 0 && (await marker(b)) === 1);
    // concurrent activations/revocations keep the count equal to the truth
    const c = await newUser(); const ids = []; for (let i = 0; i < 6; i++) ids.push(await addCred(c, "pending", "webauthn"));
    await Promise.all(ids.map((id) => q(`update admin_mfa_credentials set status='active', activated_at=now() where id='${id}'`)));
    s.check("R9-310", "six concurrent activations: marker equals the true count", (await marker(c)) === (await num(`select count(*) from admin_mfa_credentials where admin_user_id='${c}' and status='active'`)) && (await marker(c)) === 6);
    // privileges
    for (const role of ["anon", "authenticated"]) {
      const r = await st.rpc(role, "office_mfa_sync_active_count", { p_user_id: u }); s.check(`R9-320-${role}`, `${role} cannot execute the evidence functions`, r.status >= 400, r.status);
      const m = await st.rpc(role, "office_mfa_mailbox_attempt", { p_user_id: u, p_challenge_id: "abcdefgh12", p_expires_at: new Date().toISOString(), p_max: 5 }); s.check(`R9-321-${role}`, `${role} cannot execute the mailbox functions`, m.status >= 400, m.status);
      const t = await st.rest(role, "GET", "/admin_mfa_mailbox_attempts?select=*"); s.check(`R9-322-${role}`, `${role} cannot read the attempt table`, !(t.status === 200 && Array.isArray(t.json) && t.json.length > 0), t.status);
    }
  });

  // ---------------------------------------------------------------- the store decides from two independent reads
  await s.section("R9-4", async () => {
    const store = mkStore(); const enrolled = await newUser(); await addCred(enrolled); await addCred(enrolled, "active", "webauthn"); const plain = await newUser();
    s.eq("R9-401", "verified zero: an unenrolled account reads as unenrolled", await store.hasActiveMfa(plain), false);
    s.eq("R9-402", "an enrolled account reads as enrolled", await store.hasActiveMfa(enrolled), true);
    const refuse = async (label, rule, uid = enrolled) => { gw.rule(rule, label.action, undefined); try { await store.hasActiveMfa(uid); return "answered"; } catch (e) { return e.code || e.message; } finally { gw.clearRules(); } };
    for (const mode of ["emptylist", "emptyobj", "garbage", "500leak", "502", "reset"]) {
      const out = await refuse({ action: mode }, credUrl); s.check(`R9-410-${mode}`, `factor list answers '${mode}': the question is REFUSED, never answered "no factor" (${out})`, out !== "answered");
    }
    // a truncated list (1 of 2) is "incomplete": markers disagree
    gw.rule(credUrl, (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify([{ id: L.uuidv4() }])); });
    const trunc = await store.hasActiveMfa(enrolled).then(() => "answered", (e) => e.code || e.message); gw.clearRules(); s.check("R9-411", `a truncated list (1 of 2 active) is refused (${trunc})`, trunc !== "answered");
    // a marker that lies in either direction
    gw.rule((rec) => rec.url.includes("/admin_users") && rec.url.includes("mfa_active_count"), (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify([{ mfa_active_count: 0 }])); });
    const lie = await store.hasActiveMfa(enrolled).then(() => "answered", (e) => e.code || e.message); gw.clearRules(); s.check("R9-412", `a stale marker (0) against two active factors is refused (${lie})`, lie !== "answered");
    gw.rule((rec) => rec.url.includes("/admin_users") && rec.url.includes("mfa_active_count"), (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("[]"); });
    const nomark = await store.hasActiveMfa(enrolled).then(() => "answered", (e) => e.code || e.message); gw.clearRules(); s.check("R9-413", `a missing marker row is refused (${nomark})`, nomark !== "answered");
    gw.rule((rec) => rec.url.includes("/admin_users") && rec.url.includes("mfa_active_count"), (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify([{ mfa_active_count: "2" }])); });
    const typed = await store.hasActiveMfa(enrolled).then(() => "answered", (e) => e.code || e.message); gw.clearRules(); s.check("R9-414", `a marker of the wrong type is refused (${typed})`, typed !== "answered");
    // drift in the database itself (direct tamper) is caught, then healed by the sync function
    await q(`update admin_users set mfa_active_count = 0 where id = '${enrolled}'`);
    const drift = await store.hasActiveMfa(enrolled).then(() => "answered", (e) => e.code || e.message); s.check("R9-415", `database drift (marker 0, two active factors) is refused, not trusted (${drift})`, drift !== "answered");
    await q(`select office_mfa_sync_active_count('${enrolled}')`); s.eq("R9-416", "…and the sync function repairs it", await store.hasActiveMfa(enrolled), true);
    s.check("R9-417", "the capability probe reports evidence available", (await store.supportsMfaEvidence()) === true);
    s.check("R9-418", "no error message carries driver text", await (async () => { gw.rule(credUrl, "500leak"); try { await store.hasActiveMfa(enrolled); return false; } catch (e) { return !/XX000|172\.20|password authentication|pg/.test(String(e.message) + String(e.code)); } finally { gw.clearRules(); } })());
  });

  // ---------------------------------------------------------------- mailbox attempt budget
  await s.section("R9-5", async () => {
    const sa = mkStore(), sb = mkStore(); const u = await newUser(), v = await newUser(); const cid = "chal" + L.randomHex(8); const exp = Date.now() + 600_000;
    const seq = []; for (let i = 0; i < 7; i++) seq.push((await (i % 2 ? sb : sa).recordMailboxAttempt(u, cid, exp, 5)).allowed);
    s.eq("R9-501", "five attempts split across two instances are allowed, then refused (one shared budget)", JSON.stringify(seq), JSON.stringify([true, true, true, true, true, false, false]));
    const burstCid = "burst" + L.randomHex(8);
    const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? sb : sa).recordMailboxAttempt(u, burstCid, exp, 5).then((r) => r.allowed, () => "error")));
    s.eq("R9-502", "40 concurrent attempts across two instances: exactly 5 allowed, 35 refused, none errors", `${burst.filter((x) => x === true).length}/${burst.filter((x) => x === false).length}/${burst.filter((x) => x === "error").length}`, "5/35/0");
    s.check("R9-503", "another account holding the same challenge id has its own budget", (await sa.recordMailboxAttempt(v, cid, exp, 5)).allowed === true);
    const used = "used" + L.randomHex(8); await sa.recordMailboxAttempt(u, used, exp, 5);
    const races = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? sb : sa).markMailboxVerified(u, used))); s.eq("R9-504", "a challenge is marked verified exactly once under 12 concurrent calls", races.filter(Boolean).length, 1);
    s.check("R9-505", "after verification further attempts are refused", (await sa.recordMailboxAttempt(u, used, exp, 5)).allowed === false);
    s.eq("R9-506", "an unknown challenge cannot be marked verified", await sa.markMailboxVerified(u, "nonesuch" + L.randomHex(4)), false);
    const longCid = "long" + L.randomHex(8); await sa.recordMailboxAttempt(u, longCid, Date.now() + 86_400_000, 5);
    s.check("R9-507", "an expiry far in the future is capped at 15 minutes", (await num(`select extract(epoch from (expires_at - now())) from admin_mfa_mailbox_attempts where admin_user_id='${u}' and challenge_id='${longCid}'`)) <= 905);
    s.check("R9-508", "rows contain no code and no e-mail/address material", (await q(`select challenge_id from admin_mfa_mailbox_attempts`)).every((r) => /^[A-Za-z0-9_-]{8,64}$/.test(r[0])));
    // malformed challenge id is rejected by the table constraint, not stored
    const bad = await sa.recordMailboxAttempt(u, "x y!", exp, 5).then(() => "stored", (e) => e.code || "error"); s.check("R9-509", "a malformed challenge id is refused", bad !== "stored", bad);
    // deleting the account removes its rows (cascade)
    const gone = await newUser(); await sa.recordMailboxAttempt(gone, "gone" + L.randomHex(6), exp, 5); await q(`delete from admin_users where id='${gone}'`);
    s.eq("R9-510", "permanent deletion of an account removes its attempt rows", await num(`select count(*) from admin_mfa_mailbox_attempts where admin_user_id='${gone}'`), 0);
    // outage: fail closed
    gw.rule((rec) => rec.url.includes("/rpc/office_mfa_mailbox_attempt"), "500leak");
    const down = await mkStore().recordMailboxAttempt(u, "down" + L.randomHex(6), exp, 5).then(() => "allowed", (e) => e.code || e.message); gw.clearRules();
    s.check("R9-511", `gateway failure: the attempt is refused with a sanitized error, never "allowed" (${down})`, down !== "allowed" && !/XX000|172\.20|password authentication/.test(String(down)));
    // restart-style: a brand-new store object sees the persisted count
    const fresh = mkStore(); const r = await fresh.recordMailboxAttempt(u, cid, exp, 5); s.check("R9-512", "a new process (new store object) still sees the spent budget (persisted, not in memory)", r.allowed === false && r.attempts > 5);
  });

  // ---------------------------------------------------------------- rollback safety
  await s.section("R9-6", async () => {
    const store = mkStore(); const u = await newUser(); await addCred(u);
    const rb1 = st.applyFile(path.join(SUTDIR, "db/rollback/20261030_mfa_active_factor_evidence.down.sql")); s.check("R9-601", "evidence rollback applies and is repeatable", rb1.status === 0 && st.applyFile(path.join(SUTDIR, "db/rollback/20261030_mfa_active_factor_evidence.down.sql")).status === 0);
    s.check("R9-602", "…it keeps the column and every credential", (await num(`select count(*) from information_schema.columns where table_name='admin_users' and column_name='mfa_active_count'`)) === 1 && (await num(`select count(*) from admin_mfa_credentials where admin_user_id='${u}'`)) === 1);
    await st.settle(async () => (await st.rpc("service_role", "office_mfa_evidence_version")).status === 404);
    const fresh = mkStore(); s.eq("R9-603", "with the capability gone the store falls back to the single list read (pre-R9 behaviour) and still answers", await fresh.hasActiveMfa(u), true);
    s.check("R9-604", "…and reports evidence unavailable", (await fresh.supportsMfaEvidence()) === false);
    s.check("R9-605", "re-applying the migration after a rollback recomputes the evidence", st.applyFile(path.join(SUTDIR, "db", EVID)).status === 0 && (await marker(u)) === 1);
    const rb2 = st.applyFile(path.join(SUTDIR, "db/rollback/20261031_mfa_mailbox_attempts.down.sql")); s.check("R9-606", "mailbox rollback applies; accounts and factors are untouched", rb2.status === 0 && (await num(`select count(*) from admin_users`)) > 0);
    s.check("R9-607", "mailbox migration re-applies after rollback", st.applyFile(path.join(SUTDIR, "db", MBOX)).status === 0);
  });
});
