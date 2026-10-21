"use strict";
// AREA C / C01: migrations on a plain Postgres 16 container.
// Ordering guards, idempotence, additive behaviour, constraints, cascade rules and the non-destructive rollback scripts.
const path = require("path");
const fs = require("fs");
const L = require("./lib");
const T = require("./dbtools");

const s = new L.Suite("c01-migrations-plain16", "C");
const M = (n) => L.AUTH_MIGRATIONS.find((f) => f.startsWith(n));
const F = (name) => path.join(L.SUT, "db", name);

s.main(async () => {
  const st = await L.DbStack.create({ kind: "plain16", tag: "c01", suite: s });
  let dbSeq = 0;
  const newDb = (tpl = "tbase") => { const n = `d${++dbSeq}_${L.randomHex(2)}`; const r = st.one(`create database ${n} template ${tpl}`); if (r.status !== 0) throw new L.Blocked("create database failed: " + r.err); return n; };
  const apply = (db, list, opts = {}) => list.map((f) => ({ f, ...st.applyFile(F(f), { db, ...opts }) }));
  const exists = (db, sql) => st.one(sql, { db }).out === "t";

  // ---------------------------------------------------------------- fixture: the bootstrap schema on an empty database
  st.one("create database tbase");
  const base = st.applyBase({ db: "tbase" });
  s.check("MIG-001", "the bootstrap schema applies to an EMPTY database in a single run without errors", base.firstErrors === 0, { firstPassErrors: base.firstErrors, sample: (base.first.out.match(/ERROR:[^\n]*/g) || []).slice(0, 3) });
  s.check("MIG-002", "the bootstrap schema applied a second time is clean (idempotent)", base.secondErrors === 0, base.second.out.slice(0, 300));
  s.check("MIG-003", "admin_users exists after the bootstrap schema (precondition of every authentication migration)", exists("tbase", "select to_regclass('public.admin_users') is not null"));

  // ---------------------------------------------------------------- 1. ordering guards: each later migration refuses without its prerequisite
  await s.section("MIG-1", async () => {
    const m20 = M("20261020"), m21 = M("20261021"), m22 = M("20261022"), m23 = M("20261023"), m24 = M("20261024"), m25 = M("20261025"), m26 = M("20261026"), m14 = M("20261014"), m19 = M("20261019");
    const scenarios = [
      { id: "MIG-101", pre: [], target: m21, refuse: true, why: "20261021 needs 20261020", absent: ["select to_regprocedure('office_admin_update_revoking_sessions(uuid,text,text,timestamptz,text,boolean,timestamptz,text)') is null"] },
      { id: "MIG-102", pre: [], target: m22, refuse: true, msg: /20261020/, why: "20261022 needs 20261020", absent: ["select to_regclass('public.admin_mfa_credentials') is null"] },
      { id: "MIG-103", pre: [m20], target: m23, refuse: true, msg: /20261022/, why: "20261023 needs 20261022", absent: ["select not exists (select 1 from information_schema.columns where table_name='admin_mfa_recovery_codes' and column_name='key_id')"] },
      { id: "MIG-104", pre: [], target: m23, refuse: true, why: "20261023 needs 20261022 (and 20261020)" },
      { id: "MIG-105", pre: [m20, m22], target: m24, refuse: true, msg: /20261023/, why: "20261024 needs 20261023", absent: ["select to_regclass('public.admin_mfa_one_totp_per_user') is not null", "select to_regclass('public.admin_mfa_one_active_totp_per_user') is null"] },
      { id: "MIG-106", pre: [m20, m22, m23], target: m25, refuse: true, msg: /20261024/, why: "20261025 needs 20261024", absent: ["select to_regprocedure('office_mfa_webauthn_record_use(uuid,uuid,bigint)') is null"] },
      { id: "MIG-107", pre: [], target: m25, refuse: true, why: "20261025 needs 20261024 (and everything before it)" },
      { id: "MIG-108", pre: [m20, m22], target: m25, refuse: true, why: "20261025 without 20261023/24" },
      { id: "MIG-109", pre: [], target: m26, refuse: true, msg: /20261020/, why: "20261026 needs 20261020", absent: ["select to_regclass('public.admin_revoked_sessions') is null"] },
      { id: "MIG-110", pre: [], target: m19, refuse: false, why: "positive control: 20261019 applies on the bootstrap schema (which already contains office_runtime_settings)" },
      { id: "MIG-111", pre: [], target: m24, refuse: true, why: "20261024 on a database with no MFA foundation" },
      { id: "MIG-112", pre: [m20, m22, m23, m24], target: m26, refuse: false, why: "positive control: 20261026 applies with 20261020 present (later migrations do not matter)" },
      { id: "MIG-113", pre: [m20], target: m26, refuse: false, why: "positive control: 20261026 applies after only 20261020" },
      { id: "MIG-114", pre: [m20, m22, m23, m24], target: m25, refuse: false, why: "positive control: 20261025 applies after 20 22 23 24" },
      { id: "MIG-115", pre: [m20], target: m22, refuse: false, why: "positive control: 20261022 applies after 20261020" },
      { id: "MIG-116", pre: [m14], target: m19, refuse: false, why: "positive control: 20261019 applies after 20261014" },
      { id: "MIG-117", pre: [m20], target: m21, refuse: false, why: "positive control: 20261021 applies after 20261020" },
    ];
    for (const sc of scenarios) {
      const db = newDb(); apply(db, sc.pre);
      const before = T.catalogDigest(st, db);
      const r = st.applyFile(F(sc.target), { db });
      const after = T.catalogDigest(st, db);
      if (sc.refuse) {
        s.check(sc.id, `${sc.why}: the migration is refused (non-zero exit)`, r.status !== 0, r.out.slice(0, 200));
        if (sc.msg) s.check(`${sc.id}b`, `${sc.why}: the refusal names the missing prerequisite`, sc.msg.test(r.out), r.out.slice(0, 300));
        s.check(`${sc.id}c`, `${sc.why}: a refused migration changes nothing in the catalog`, before === after, { before, after });
        for (let i = 0; i < (sc.absent || []).length; i++) s.check(`${sc.id}d${i}`, `${sc.why}: nothing from the refused migration exists`, exists(db, sc.absent[i]), sc.absent[i]);
      } else {
        s.check(sc.id, `${sc.why}`, r.status === 0, r.out.slice(0, 300));
      }
    }
    // the order recommended in the documents applied in full succeeds from empty
    const db = newDb(); const res = apply(db, L.dbFiles());
    s.check("MIG-118", "every dated migration applies in filename order on a fresh database", res.every((x) => x.status === 0), res.filter((x) => x.status !== 0).map((x) => x.f + ": " + L.errLines(x.out)));
    // applying the same set in the documented order but starting at the middle is refused at the first dependent migration
    const db2 = newDb(); const res2 = apply(db2, [m22, m23, m24, m25, m26], { onErrorStop: true });
    s.check("MIG-119", "applying the MFA migrations without 20261020 first is refused at the first one", res2[0].status !== 0, res2[0].out.slice(0, 200));
    s.check("MIG-120", "no half-applied MFA schema remains after the refused sequence", exists(db2, "select to_regclass('public.admin_mfa_credentials') is null"));
  });

  // ---------------------------------------------------------------- 2. idempotence
  const full = newDb(); let fullDigest;
  await s.section("MIG-2", async () => {
    const r1 = apply(full, L.dbFiles());
    s.check("MIG-201", "first application of all migrations is clean", r1.every((x) => x.status === 0), r1.filter((x) => x.status !== 0).map((x) => x.f + ": " + L.errLines(x.out)));
    const d1 = T.catalogDigest(st, full); fullDigest = d1;
    const seeded = T.seedRich(st, full);
    const t1 = T.digests(st, T.STATE_TABLES, full);
    const r2 = apply(full, L.dbFiles());
    s.check("MIG-202", "a second application of all migrations is clean", r2.every((x) => x.status === 0), r2.filter((x) => x.status !== 0).map((x) => x.f + ": " + L.errLines(x.out)));
    s.check("MIG-203", "re-application leaves the catalog identical (functions, ACLs, columns, indexes, constraints, RLS)", T.catalogDigest(st, full) === d1);
    const t2 = T.digests(st, T.STATE_TABLES, full);
    s.eq("MIG-204", "re-application changes no row of any authentication state table", t2, t1);
    let ok = true; const bad = [];
    for (const m of L.AUTH_MIGRATIONS) for (let i = 0; i < 3; i++) { const r = st.applyFile(F(m), { db: full }); if (r.status !== 0) { ok = false; bad.push(m + ": " + L.errLines(r.out)); } }
    s.check("MIG-205", "each authentication migration applied three more times in a row is clean", ok, bad);
    s.eq("MIG-206", "repeated single-file application changes no state row", T.digests(st, T.STATE_TABLES, full), t1);
    s.check("MIG-207", "repeated single-file application leaves the catalog identical", T.catalogDigest(st, full) === d1);
    const gen = st.one(`select session_generation from admin_users where id='${seeded.u1}'`, { db: full }).out;
    s.check("MIG-208", "a session generation reached before re-application is not reset by it", gen === "3", gen);
    s.check("MIG-209", "the unused recovery codes seeded before re-application are all still present", st.one(`select count(*) from admin_mfa_recovery_codes where used_at is null and admin_user_id='${seeded.u1}'`, { db: full }).out === "3");
    s.check("MIG-210", "the used recovery code is still marked used after re-application", st.one(`select count(*) from admin_mfa_recovery_codes where used_at is not null and admin_user_id='${seeded.u1}'`, { db: full }).out === "1");
    // an EARLIER file applied again on its own, after the later ones, must not undo what the later ones established (no data in the way)
    for (const m of L.AUTH_MIGRATIONS.filter((x) => x >= "20261020")) {
      const db = newDb(); apply(db, L.dbFiles());
      const d = T.catalogDigest(st, db);
      const r = st.applyFile(F(m), { db });
      s.check(`MIG-211-${m.slice(0, 8)}`, `re-applying ${m} alone after all later migrations succeeds`, r.status === 0, L.errLines(r.out));
      s.check(`MIG-212-${m.slice(0, 8)}`, `re-applying ${m} alone after all later migrations leaves the catalog unchanged (does not reinstate superseded indexes/functions)`, T.catalogDigest(st, db) === d, st.one("select string_agg(indexname, ',') from pg_indexes where tablename='admin_mfa_credentials'", { db }).out + " | overloads: " + st.one("select string_agg(oid::regprocedure::text, ' ; ') from pg_proc where proname in ('office_mfa_replace_recovery_codes','office_mfa_activate_credential') and pronamespace='public'::regnamespace", { db }).out);
    }
  });

  // ---------------------------------------------------------------- 3. additive behaviour on a database with existing accounts
  await s.section("MIG-3", async () => {
    const db = newDb();
    const pre = L.dbFiles().filter((f) => f < "20261020");
    const r0 = apply(db, pre);
    s.check("MIG-300", "pre-S7 migrations apply (fixture for the additive checks)", r0.every((x) => x.status === 0), r0.filter((x) => x.status !== 0).map((x) => x.f + ": " + L.errLines(x.out)));
    const legacy = [];
    for (let i = 0; i < 6; i++) legacy.push({ id: L.uuidv4(), email: `legacy${i}-${L.randomHex(2)}@fixture.test`, pw: L.scryptHash("Legacy!Pass" + i), role: ["super_admin", "admin", "viewer", "sales", "admin", "viewer"][i], status: i === 3 ? "inactive" : "active" });
    const ins = legacy.map((u, i) => `insert into admin_users (id, email, password_hash, role, status, display_name, permission_scopes, last_login_at, password_changed_at, removed_at, removed_by) values ('${u.id}', '${u.email}', '${u.pw}', '${u.role}', '${u.status}', 'Legacy ${i}', ${i % 2 ? "array['crm.read','tasks.manage']::text[]" : "'{}'::text[]"}, now() - interval '${i} days', now() - interval '${i + 3} days', ${i === 4 ? "now()" : "null"}, ${i === 4 ? "'owner'" : "null"});`).join("\n");
    const inv = `insert into admin_invites (id, admin_user_id, email, role, token_hash, status, expires_at) values ('${L.uuidv4()}', '${legacy[0].id}', 'invitee-${L.randomHex(2)}@fixture.test', 'viewer', 'hash-${L.randomHex(8)}', 'pending', now() + interval '1 day');
insert into password_reset_tokens (id, admin_user_id, email, token_hash, status, expires_at) values ('${L.uuidv4()}', '${legacy[1].id}', '${legacy[1].email}', 'rthash-${L.randomHex(8)}', 'pending', now() + interval '1 hour');
insert into audit_events (actor_email, action, target_type) values ('legacy@fixture.test', 'seed_event', 'admin_user');`;
    const rs = st.run(ins + "\n" + inv, { db }); s.check("MIG-301", "legacy accounts, an invite, a reset token and an audit row are seeded", rs.status === 0, rs.out.slice(0, 200));
    const cols = "id,email,password_hash,role,status,display_name,office_position,phone,passport_photo_url,qr_credential,permission_scopes,last_login_at,password_changed_at,created_at,updated_at,removed_at,removed_by";
    const snap = () => st.one(`select md5(string_agg(t::text, '|' order by id)) from (select ${cols} from admin_users) t`, { db }).out;
    const before = snap(); const invBefore = T.tableDigest(st, "admin_invites", db), rtBefore = T.tableDigest(st, "password_reset_tokens", db), auBefore = T.tableDigest(st, "audit_events", db);
    const steps = L.AUTH_MIGRATIONS.filter((m) => m >= "20261020");
    for (const m of steps) {
      const r = st.applyFile(F(m), { db });
      const id = m.slice(0, 8);
      s.check(`MIG-31-${id}`, `${m} applies on a database with existing accounts`, r.status === 0, r.out.slice(0, 200));
      s.check(`MIG-32-${id}`, `${m} leaves every pre-existing account column (email, hash, role, status, scopes, dates) unchanged`, snap() === before);
      s.check(`MIG-33-${id}`, `${m} keeps the account count`, st.one("select count(*) from admin_users", { db }).out === "6");
    }
    s.check("MIG-340", "new generation columns default every legacy account to generation 0", st.one("select count(*) from admin_users where session_generation = 0 and sessions_revoked_at is null and sessions_revoked_by is null", { db }).out === "6");
    s.check("MIG-341", "new MFA columns default to no failures, no lock, no requirement, no reset", st.one("select count(*) from admin_users where mfa_failed_attempts = 0 and mfa_locked_until is null and mfa_required_after is null and mfa_reset_at is null and mfa_reset_by is null", { db }).out === "6");
    s.check("MIG-342", "the invite, reset-token and audit tables are untouched", T.tableDigest(st, "admin_invites", db) === invBefore && T.tableDigest(st, "password_reset_tokens", db) === rtBefore && T.tableDigest(st, "audit_events", db) === auBefore);
    s.check("MIG-343", "no MFA credential, recovery code or challenge row is created for any existing account", st.one("select (select count(*) from admin_mfa_credentials) + (select count(*) from admin_mfa_recovery_codes) + (select count(*) from admin_mfa_challenges) + (select count(*) from admin_revoked_sessions)", { db }).out === "0");
    const old = st.run(`insert into admin_users (email, password_hash, role) values ('oldstyle-${L.randomHex(2)}@fixture.test', 'x:y', 'viewer');`, { db });
    s.check("MIG-344", "an insert written for the previous schema (no new columns) still works", old.status === 0, old.out);
    const upd = st.run(`update admin_users set last_login_at = now() where id = '${legacy[0].id}';`, { db });
    s.check("MIG-345", "a previous-release style update still works", upd.status === 0, upd.out);
    s.check("MIG-346", "a legacy account can be revoked through the new function from generation 0", st.one(`select session_generation from office_revoke_admin_sessions('${legacy[0].id}','t','r')`, { db }).out === "1");
  });

  // ---------------------------------------------------------------- 4. table constraints
  await s.section("MIG-4", async () => {
    const db = newDb(); apply(db, L.dbFiles());
    const ids = T.seedRich(st, db);
    const sess = st.session({ db }); // one connection for the negative inserts
    const tryq = async (sql) => (await sess.query(sql)).error;
    const expectErr = async (id, text, sql, code) => { const e = await tryq(sql); s.check(id, text, !!e && (!code || e.code === code), e || "no error"); };
    const u = ids.u2;
    const tot = (st2, extra = "") => `insert into admin_mfa_credentials (admin_user_id, type, status, secret_ciphertext, secret_nonce, secret_key_id${extra ? "," + extra.split("=")[0] : ""}) values ('${u}', 'totp', '${st2}', 'c', 'n', 'k'${extra ? "," + extra.split("=")[1] : ""})`;
    await expectErr("MIG-401", "an unknown credential type is refused", `insert into admin_mfa_credentials (admin_user_id, type, secret_ciphertext, secret_nonce, secret_key_id) values ('${u}', 'sms', 'c', 'n', 'k')`, "23514");
    await expectErr("MIG-402", "an unknown credential status is refused", tot("zombie"), "23514");
    await expectErr("MIG-403", "a TOTP credential without secret material is refused", `insert into admin_mfa_credentials (admin_user_id, type) values ('${u}', 'totp')`, "23514");
    await expectErr("MIG-404", "a WebAuthn credential without a public key is refused", `insert into admin_mfa_credentials (admin_user_id, type, webauthn_credential_id) values ('${u}', 'webauthn', decode('aa','hex'))`, "23514");
    await expectErr("MIG-405", "a duplicate WebAuthn credential id (even for another account) is refused", `insert into admin_mfa_credentials (admin_user_id, type, webauthn_credential_id, webauthn_public_key) select '${u}', 'webauthn', webauthn_credential_id, decode('bb','hex') from admin_mfa_credentials where id='${ids.cWa}'`, "23505");
    await expectErr("MIG-406", "a negative TOTP step is refused", tot("pending", "totp_last_step=-1"), "23514");
    await expectErr("MIG-407", "a negative WebAuthn counter is refused", `insert into admin_mfa_credentials (admin_user_id, type, webauthn_credential_id, webauthn_public_key, webauthn_sign_count) values ('${u}', 'webauthn', decode('cc01','hex'), decode('dd','hex'), -1)`, "23514");
    await expectErr("MIG-408", "a second ACTIVE TOTP for the same account is refused (unique index)", `insert into admin_mfa_credentials (admin_user_id, type, status, secret_ciphertext, secret_nonce, secret_key_id) values ('${ids.u1}', 'totp', 'active', 'c', 'n', 'k')`, "23505");
    await expectErr("MIG-409", "a second PENDING TOTP for the same account is refused (unique index)", `insert into admin_mfa_credentials (admin_user_id, type, status, secret_ciphertext, secret_nonce, secret_key_id) values ('${ids.u1}', 'totp', 'pending', 'c', 'n', 'k')`, "23505");
    s.check("MIG-410", "positive control: one pending TOTP next to an active one is allowed (replacement in progress)", !(await tryq(tot("pending"))));
    await expectErr("MIG-411", "a recovery-code hash that already exists (even for another account) is refused", `insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac) values ('${u}', '${L.uuidv4()}', 'hmac-u1-b')`, "23505");
    await expectErr("MIG-412", "a recovery-code key id with illegal characters is refused", `insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac, key_id) values ('${u}', '${L.uuidv4()}', 'h-bad-1', 'bad key!')`, "23514");
    await expectErr("MIG-413", "a recovery-code key id longer than 32 characters is refused", `insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac, key_id) values ('${u}', '${L.uuidv4()}', 'h-bad-2', '${"k".repeat(33)}')`, "23514");
    s.check("MIG-414", "positive control: a well-formed key id is accepted", !(await tryq(`insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac, key_id) values ('${u}', '${L.uuidv4()}', 'h-ok-1', 'key.v2-A_1')`)));
    await expectErr("MIG-415", "a challenge with an unknown purpose is refused", `insert into admin_mfa_challenges (admin_user_id, purpose, challenge, expires_at) values ('${u}', 'login', decode('aa','hex'), now())`, "23514");
    await expectErr("MIG-416", "a revoked-session digest shorter than 16 characters is refused", `insert into admin_revoked_sessions (session_digest, admin_user_id, expires_at) values ('${"a".repeat(15)}', '${u}', now())`, "23514");
    await expectErr("MIG-417", "a revoked-session digest longer than 128 characters is refused", `insert into admin_revoked_sessions (session_digest, admin_user_id, expires_at) values ('${"a".repeat(129)}', '${u}', now())`, "23514");
    await expectErr("MIG-418", "a revoked-session row for a non-existent account is refused (foreign key)", `insert into admin_revoked_sessions (session_digest, admin_user_id, expires_at) values ('${"b".repeat(20)}', '${L.uuidv4()}', now())`, "23503");
    await expectErr("MIG-419", "a credential for a non-existent account is refused (foreign key)", `insert into admin_mfa_credentials (admin_user_id, type, secret_ciphertext, secret_nonce, secret_key_id) values ('${L.uuidv4()}', 'totp', 'c', 'n', 'k')`, "23503");
    await expectErr("MIG-420", "a negative session generation is refused", `update admin_users set session_generation = -1 where id='${u}'`, "23514");
    await expectErr("MIG-421", "a negative MFA failure counter is refused", `update admin_users set mfa_failed_attempts = -1 where id='${u}'`, "23514");
    await expectErr("MIG-422", "runtime-setting history cannot be updated (append-only)", `update office_runtime_setting_history set actor = 'x'`, "42501");
    await expectErr("MIG-423", "runtime-setting history cannot be deleted (append-only)", `delete from office_runtime_setting_history`, "42501");
    await expectErr("MIG-424", "a runtime setting version below 1 is refused", `update office_runtime_settings set version = 0 where key = 'office_mfa_enforcement'`, "23514");
    await expectErr("MIG-425", "a history outcome outside the allowed set is refused", `insert into office_runtime_setting_history (setting_key, version, outcome) values ('k', 1, 'weird')`, "23514");
    // cascade and deleted-and-recreated accounts
    const email1 = st.one(`select email from admin_users where id='${ids.u1}'`, { db }).out;
    const countRows = (uid) => st.one(`select (select count(*) from admin_mfa_credentials where admin_user_id='${uid}') || ',' || (select count(*) from admin_mfa_recovery_codes where admin_user_id='${uid}') || ',' || (select count(*) from admin_mfa_challenges where admin_user_id='${uid}') || ',' || (select count(*) from admin_revoked_sessions where admin_user_id='${uid}')`, { db }).out;
    const u2Before = countRows(ids.u2);
    s.check("MIG-430", "before deletion the account has credentials, codes, a challenge and a revoked session", countRows(ids.u1).split(",").every((n) => Number(n) > 0), countRows(ids.u1));
    const del = st.run(`delete from admin_users where id='${ids.u1}';`, { db });
    s.check("MIG-431", "an account can be deleted", del.status === 0, del.out);
    s.check("MIG-432", "deleting an account cascades to ALL of its credentials, codes, challenges and revoked-session rows", countRows(ids.u1) === "0,0,0,0", countRows(ids.u1));
    s.check("MIG-433", "deleting one account leaves another account's rows untouched", countRows(ids.u2) === u2Before, { before: u2Before, after: countRows(ids.u2) });
    const newId = L.uuidv4();
    st.run(`insert into admin_users (id, email, password_hash, role) values ('${newId}', '${email1}', '${L.scryptHash("Recreated!Pass1")}', 'super_admin');`, { db });
    s.check("MIG-434", "a recreated account with the same e-mail inherits no credential, code, challenge or revoked session", countRows(newId) === "0,0,0,0", countRows(newId));
    s.check("MIG-435", "a recreated account starts at generation 0 with a different identifier", st.one(`select session_generation from admin_users where id='${newId}'`, { db }).out === "0" && newId !== ids.u1);
    s.check("MIG-436", "the revoked-session digest of the deleted account is gone with it (bounded growth)", st.one("select count(*) from admin_revoked_sessions where session_digest='digest-seed-0123456789abcdef-1'", { db }).out === "0");
    await sess.close();
  });

  // ---------------------------------------------------------------- 5. rollback scripts: non-destructive, repeatable, re-appliable
  await s.section("MIG-5", async () => {
    const db = newDb(); apply(db, L.dbFiles());
    const ids = T.seedRich(st, db);
    // drop the pending credential so that the 20261024 rollback has nothing documented to revoke
    st.run(`delete from admin_mfa_credentials where id='${ids.cPend}';`, { db });
    const D0 = T.digests(st, ["admin_users", "admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_mfa_challenges", "admin_revoked_sessions"], db);
    const order = ["20261026", "20261025", "20261024", "20261023", "20261022", "20261021", "20261020"].map(M);
    for (const m of order) {
      const r = st.applyRollback(m, { db });
      const id = m.slice(0, 8);
      s.check(`MIG-50-${id}`, `rollback of ${m} runs cleanly`, r.status === 0, r.out.slice(0, 300));
      const now = T.digests(st, Object.keys(D0), db);
      s.eq(`MIG-51-${id}`, `rollback of ${m} loses no credential, recovery code, challenge, revoked session or account state`, now, D0);
    }
    s.check("MIG-520", "after rolling back everything the session generation of the account is still 3 (no session resurrected)", st.one(`select session_generation from admin_users where id='${ids.u1}'`, { db }).out === "3");
    s.check("MIG-521", "after rolling back everything the credential tables still exist", ["admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_mfa_challenges", "admin_revoked_sessions"].every((t) => exists(db, `select to_regclass('public.${t}') is not null`)));
    s.check("MIG-522", "rolling back the functions leaves no authentication function behind that could be called half-configured", st.one("select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'office_mfa_%'", { db }).out === "0", st.one("select string_agg(proname, ',') from pg_proc where pronamespace='public'::regnamespace and proname like 'office_mfa_%'", { db }).out);
    // second pass of every rollback is a no-op, not an error
    const again = order.map((m) => ({ m, ...st.applyRollback(m, { db }) }));
    s.check("MIG-523", "every rollback script is repeatable (second run succeeds)", again.every((x) => x.status === 0), again.filter((x) => x.status !== 0).map((x) => x.m + ": " + L.errLines(x.out)));
    s.eq("MIG-524", "the repeated rollback loses nothing either", T.digests(st, Object.keys(D0), db), D0);
    // re-apply forward on top of the rolled-back database
    const re = apply(db, L.AUTH_MIGRATIONS.filter((m) => m >= "20261020"));
    s.check("MIG-525", "re-applying the migrations after a full rollback succeeds", re.every((x) => x.status === 0), re.filter((x) => x.status !== 0).map((x) => x.f + ": " + L.errLines(x.out)));
    s.eq("MIG-526", "re-applying after rollback keeps every credential, code, challenge and revoked session", T.digests(st, Object.keys(D0), db), D0);
    s.check("MIG-527", "the catalog after rollback + re-apply equals the original catalog", T.catalogDigest(st, db) === fullDigest);

    // rollback of a single middle migration, without the later ones
    for (const m of [M("20261022"), M("20261023"), M("20261024"), M("20261025"), M("20261026"), M("20261021"), M("20261020")]) {
      const db2 = newDb(); apply(db2, L.dbFiles()); const ids2 = T.seedRich(st, db2); st.run(`delete from admin_mfa_credentials where id='${ids2.cPend}';`, { db: db2 });
      const d0 = T.digests(st, Object.keys(D0), db2);
      const r = st.applyRollback(m, { db: db2 });
      s.check(`MIG-53-${m.slice(0, 8)}`, `rolling back ${m} on its own (later migrations still applied) runs cleanly`, r.status === 0, r.out.slice(0, 300));
      s.eq(`MIG-54-${m.slice(0, 8)}`, `rolling back ${m} on its own loses no authentication state`, T.digests(st, Object.keys(D0), db2), d0);
      const back = st.applyFile(F(m), { db: db2 });
      s.check(`MIG-55-${m.slice(0, 8)}`, `re-applying ${m} after its own rollback succeeds`, back.status === 0, back.out.slice(0, 300));
      s.eq(`MIG-56-${m.slice(0, 8)}`, `re-applying ${m} after its own rollback keeps the data`, T.digests(st, Object.keys(D0), db2), d0);
    }
    // 20261024: a pending TOTP beside an active one is revoked (documented); the ACTIVE credential and the codes stay
    const db3 = newDb(); apply(db3, L.dbFiles()); const ids3 = T.seedRich(st, db3);
    const r24 = st.applyRollback(M("20261024"), { db: db3 });
    s.check("MIG-570", "rollback of 20261024 with a pending replacement TOTP runs cleanly", r24.status === 0, r24.out.slice(0, 300));
    s.check("MIG-571", "the ACTIVE TOTP credential survives the 20261024 rollback", st.one(`select status from admin_mfa_credentials where id='${ids3.cTotp}'`, { db: db3 }).out === "active");
    s.check("MIG-572", "the pending replacement is revoked (documented) rather than deleted", st.one(`select status || ':' || coalesce(revoked_reason,'') from admin_mfa_credentials where id='${ids3.cPend}'`, { db: db3 }).out === "revoked:rollback_20261024");
    s.check("MIG-573", "the single pending-or-active index of the older schema is restored by the 20261024 rollback", exists(db3, "select to_regclass('public.admin_mfa_one_totp_per_user') is not null"));
    s.check("MIG-574", "recovery codes survive the 20261024 rollback", st.one(`select count(*) from admin_mfa_recovery_codes where admin_user_id='${ids3.u1}'`, { db: db3 }).out === "4");

    // settings migrations: the runtime-settings table holds authentication policy (MFA enforcement, break-glass memory, session duration)
    const db4 = newDb(); apply(db4, L.dbFiles()); T.seedRich(st, db4);
    const polBefore = st.one("select md5(string_agg(key || value::text, '|' order by key)) from office_runtime_settings where key in ('office_mfa_enforcement','office_mfa_recovery_state','office_session_ttl_hours')", { db: db4 }).out;
    const histBefore = st.one("select count(*) from office_runtime_setting_history", { db: db4 }).out;
    const r19 = st.applyRollback(M("20261019"), { db: db4 });
    s.check("MIG-580", "rollback of 20261019 runs cleanly", r19.status === 0, r19.out.slice(0, 200));
    s.check("MIG-581", "rollback of 20261019 keeps the append-only history of policy changes (evidence)", exists(db4, "select to_regclass('public.office_runtime_setting_history') is not null") && st.one("select count(*) from office_runtime_setting_history", { db: db4 }).out === histBefore, "history table is dropped by the script");
    s.check("MIG-582", "rollback of 20261019 keeps the stored authentication policy values", st.one("select md5(string_agg(key || value::text, '|' order by key)) from office_runtime_settings where key in ('office_mfa_enforcement','office_mfa_recovery_state','office_session_ttl_hours')", { db: db4 }).out === polBefore);
    const r14 = st.applyRollback(M("20261014"), { db: db4 });
    s.check("MIG-583", "rollback of 20261014 runs cleanly", r14.status === 0, r14.out.slice(0, 200));
    s.check("MIG-584", "rollback of 20261014 does not delete the stored MFA enforcement level, the break-glass applied-id memory or the session duration (silent downgrade / replay of a one-time recovery id)", exists(db4, "select to_regclass('public.office_runtime_settings') is not null"), "office_runtime_settings is dropped with all authentication policy state");
  });

  // ---------------------------------------------------------------- 6. privilege defaults on a plain database that already has Supabase-style roles
  await s.section("MIG-6", async () => {
    const db = newDb();
    st.run(`do $$ begin
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`, { db });
    apply(db, L.dbFiles());
    // base tables were created BEFORE the default privileges in tbase, so only the migration-created objects carry the defaults here
    const q = (sql) => st.one(sql, { db }).out;
    const mfaTables = ["admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_mfa_challenges", "admin_revoked_sessions"];
    for (const t of mfaTables) {
      s.check(`MIG-60-${t}`, `${t}: row level security is on`, q(`select relrowsecurity from pg_class where oid='public.${t}'::regclass`) === "t");
      s.check(`MIG-61-${t}`, `${t}: no policy exists (deny by default)`, q(`select count(*) from pg_policies where tablename='${t}'`) === "0");
      s.check(`MIG-62-${t}`, `${t}: anon and authenticated hold no privilege at all`, q(`select has_table_privilege('anon','public.${t}','select,insert,update,delete,truncate,references,trigger') or has_table_privilege('authenticated','public.${t}','select,insert,update,delete,truncate,references,trigger')`) === "f");
      s.check(`MIG-63-${t}`, `${t}: PUBLIC holds no privilege`, q(`select count(*) from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where c.oid='public.${t}'::regclass and a.grantee = 0`) === "0");
    }
    for (const fn of T.AUTH_FUNCTIONS) {
      s.check(`MIG-64-${fn.split("(")[0]}`, `${fn}: no PUBLIC/anon/authenticated EXECUTE, service_role may execute`, q(`select not has_function_privilege('anon','${fn}','execute') and not has_function_privilege('authenticated','${fn}','execute') and has_function_privilege('service_role','${fn}','execute') and (select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid='${fn}'::regprocedure and a.grantee=0)=0`) === "t");
    }
    // the same must hold after a full rollback + re-apply cycle (functions are recreated with default privileges in between)
    for (const m of ["20261026", "20261025", "20261024", "20261023", "20261022", "20261021", "20261020"].map(M)) st.applyRollback(m, { db });
    apply(db, L.AUTH_MIGRATIONS.filter((m) => m >= "20261020"));
    for (const fn of T.AUTH_FUNCTIONS.filter((f) => !/runtime_setting/.test(f))) {
      s.check(`MIG-65-${fn.split("(")[0]}`, `${fn}: still closed to anon/authenticated/PUBLIC after rollback and re-apply`, q(`select not has_function_privilege('anon','${fn}','execute') and not has_function_privilege('authenticated','${fn}','execute') and (select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid='${fn}'::regprocedure and a.grantee=0)=0`) === "t");
    }
  });
});
