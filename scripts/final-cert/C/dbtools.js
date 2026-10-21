"use strict";
// SQL-level helpers shared by the AREA C database suites: catalog snapshots, data digests, rich fixture data, privilege enumeration.
const L = require("./lib");

/** Every table the authentication system reads or writes. */
const AUTH_TABLES = ["admin_users", "admin_invites", "password_reset_tokens", "audit_events", "admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_mfa_challenges", "admin_revoked_sessions", "office_runtime_settings", "office_runtime_setting_history"];
/** The subset whose content is credential, session or policy material: never visible to a Data API role. */
const SECRET_TABLES = ["admin_users", "admin_invites", "password_reset_tokens", "admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_mfa_challenges", "admin_revoked_sessions", "office_runtime_settings", "office_runtime_setting_history", "audit_events"];
/** Every function the migrations in scope define, with its identity arguments (the application's service-role interface). */
const AUTH_FUNCTIONS = [
  "office_revoke_admin_sessions(uuid, text, text)", "office_admin_update_revoking_sessions(uuid, text, text, timestamptz, text, boolean, timestamptz, text)",
  "office_mfa_schema_version()", "office_mfa_consume_totp_step(uuid, bigint)", "office_mfa_consume_recovery_code(uuid, text)", "office_mfa_replace_recovery_codes(uuid, uuid, text[], text)",
  "office_mfa_create_challenge(uuid, text, text, integer)", "office_mfa_consume_challenge(uuid, uuid, text)", "office_mfa_record_failure(uuid)", "office_mfa_clear_failures(uuid)", "office_mfa_reset(uuid, text)",
  "office_mfa_prune_challenges(interval)", "office_mfa_management_version()", "office_mfa_activate_credential(uuid, uuid, text, uuid, bigint, text[], text)",
  "office_mfa_revoke_credential(uuid, uuid, text, text, boolean)", "office_mfa_consume_recovery_code_revoking(uuid, text, text)", "office_mfa_webauthn_version()",
  "office_mfa_webauthn_record_use(uuid, uuid, bigint)", "office_session_revocation_version()", "office_revoke_session(text, uuid, timestamptz)", "office_is_session_revoked(text)",
  "office_runtime_setting_write(text, jsonb, text, integer, text, boolean, boolean)", "office_runtime_setting_record_attempt(text, text, text, text, text, jsonb, boolean)",
];

const SNAPSHOT_SQL = `
select md5(coalesce(string_agg(l, E'\\n' order by l), '')) from (
  select 'f:' || p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, '') as l
    from pg_proc p where p.pronamespace = 'public'::regnamespace
  union all
  select 'c:' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
    from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
  union all select 'i:' || indexdef from pg_indexes where schemaname = 'public'
  union all select 'k:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
  union all select 'r:' || relname || ':' || relrowsecurity || ':' || coalesce(relacl::text, '') from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
  union all select 't:' || tgname || ':' || tgrelid::regclass::text from pg_trigger where not tgisinternal
) s`;

/** md5 of the whole catalog shape of schema public (functions with ACLs, columns, indexes, constraints, RLS flags, triggers). */
function catalogDigest(stack, db = "postgres") { const r = stack.one(SNAPSHOT_SQL.replace(/\s+/g, " "), { db }); if (r.status !== 0) throw new Error("catalog digest failed: " + r.err); return r.out; }

/** md5 of the content of one table (every column), or "absent" when the table does not exist. */
function tableDigest(stack, table, db = "postgres") {
  const ex = stack.one(`select to_regclass('public.${table}') is not null`, { db });
  if (ex.out !== "t") return "absent";
  const r = stack.one(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) || ':' || count(*) from public.${table} x`, { db });
  if (r.status !== 0) throw new Error(`digest ${table}: ${r.err}`);
  return r.out;
}
function digests(stack, tables, db) { const o = {}; for (const t of tables) o[t] = tableDigest(stack, t, db); return o; }

function sqlLit(v) { return v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`; }

/**
 * Seed a rich set of credential, code, session and policy rows (requires every migration to be applied). Returns the identifiers.
 * Uses only inserts and the service functions, so it is valid on both the plain and the Supabase fixtures.
 */
let seedCount = 0;
function seedRich(stack, db = "postgres") {
  const sfx = seedCount++ === 0 ? "" : "-" + L.randomHex(3);
  const u1 = L.uuidv4(), u2 = L.uuidv4(), cTotp = L.uuidv4(), cPend = L.uuidv4(), cWa = L.uuidv4(), cWa2 = L.uuidv4(), cRev = L.uuidv4();
  const wcid1 = L.randomHex(16), wcid2 = L.randomHex(16);
  const sql = `
insert into admin_users (id, email, password_hash, role, status, display_name, permission_scopes) values
 ('${u1}', 'rich1-${L.randomHex(3)}@fixture.test', '${L.scryptHash("Rich!Passw0rd1")}', 'super_admin', 'active', 'Rich One', '{}'),
 ('${u2}', 'rich2-${L.randomHex(3)}@fixture.test', '${L.scryptHash("Rich!Passw0rd2")}', 'viewer', 'active', 'Rich Two', '{}');
select office_revoke_admin_sessions('${u1}', 'seed', 'one');
select office_revoke_admin_sessions('${u1}', 'seed', 'two');
select office_revoke_admin_sessions('${u1}', 'seed', 'three');
select office_revoke_admin_sessions('${u2}', 'seed', 'one');
insert into admin_mfa_credentials (id, admin_user_id, type, label, status, secret_ciphertext, secret_nonce, secret_key_id, totp_last_step, activated_at)
 values ('${cTotp}', '${u1}', 'totp', 'Authenticator', 'active', 'CIPHERTEXT-A', 'NONCE-A', 'k1', 57000001, now());
insert into admin_mfa_credentials (id, admin_user_id, type, label, status, secret_ciphertext, secret_nonce, secret_key_id)
 values ('${cPend}', '${u1}', 'totp', 'Pending', 'pending', 'CIPHERTEXT-P', 'NONCE-P', 'k1');
insert into admin_mfa_credentials (id, admin_user_id, type, label, status, webauthn_credential_id, webauthn_public_key, webauthn_sign_count, activated_at)
 values ('${cWa}', '${u1}', 'webauthn', 'Key 1', 'active', decode('${wcid1}', 'hex'), decode('${L.randomHex(32)}', 'hex'), 7, now());
insert into admin_mfa_credentials (id, admin_user_id, type, label, status, webauthn_credential_id, webauthn_public_key, webauthn_sign_count, activated_at)
 values ('${cWa2}', '${u2}', 'webauthn', 'Key 2', 'active', decode('${wcid2}', 'hex'), decode('${L.randomHex(32)}', 'hex'), 0, now());
insert into admin_mfa_credentials (id, admin_user_id, type, label, status, secret_ciphertext, secret_nonce, secret_key_id, revoked_at, revoked_by, revoked_reason)
 values ('${cRev}', '${u2}', 'totp', 'Old', 'revoked', 'CIPHERTEXT-R', 'NONCE-R', 'k0', now(), 'seed', 'seed');
select office_mfa_replace_recovery_codes('${u1}', '${L.uuidv4()}', array['hmac-u1-a${sfx}','hmac-u1-b${sfx}','hmac-u1-c${sfx}','hmac-u1-d${sfx}'], 'k1');
update admin_mfa_recovery_codes set used_at = now() where code_hmac = 'hmac-u1-a${sfx}';
select office_mfa_replace_recovery_codes('${u2}', '${L.uuidv4()}', array['hmac-u2-a${sfx}','hmac-u2-b${sfx}'], 'k1');
select id from office_mfa_create_challenge('${u1}', 'webauthn_authenticate', 'AAECAwQFBgcICQoLDA0ODw==', 300);
select office_revoke_session('digest-seed-0123456789abcdef-1', '${u1}', now() + interval '2 days');
select office_revoke_session('digest-seed-0123456789abcdef-2', '${u2}', now() + interval '2 days');
select office_runtime_setting_write('office_mfa_enforcement', '"privileged"'::jsonb, 'seed', null, 'seed-req', false, true);
select office_runtime_setting_write('office_mfa_recovery_state', '{"applied":["TICKET-1"]}'::jsonb, 'seed', null, 'seed-req', false, true);
select office_runtime_setting_write('office_session_ttl_hours', '12'::jsonb, 'seed', null, 'seed-req', false, true);
select office_mfa_record_failure('${u2}');
`;
  const r = stack.run(sql, { db });
  if (r.status !== 0) throw new L.Blocked("seedRich failed: " + L.errLines(r.out));
  return { u1, u2, cTotp, cPend, cWa, cWa2, cRev, sfx, hm: (n) => `hmac-${n}${sfx}` };
}

const STATE_TABLES = ["admin_users", "admin_mfa_credentials", "admin_mfa_recovery_codes", "admin_mfa_challenges", "admin_revoked_sessions", "office_runtime_settings", "office_runtime_setting_history"];

module.exports = { AUTH_TABLES, SECRET_TABLES, AUTH_FUNCTIONS, SNAPSHOT_SQL, catalogDigest, tableDigest, digests, sqlLit, seedRich, STATE_TABLES };
