-- Settings S7.5.1: MFA data foundation. Storage and atomic functions ONLY: nothing enrolls, challenges, issues codes or enforces MFA (that is later slices), and MFA stays off by default.
-- Additive: existing users, roles, passwords, scopes, statuses and generations are untouched. Requires 20261020_admin_session_generation.sql (office_mfa_reset bumps session_generation).
-- Credential material stored here is CIPHERTEXT or PUBLIC data only (TOTP secrets are encrypted by the application with a key that never reaches the database; recovery codes are keyed hashes).
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'admin_users' and column_name = 'session_generation') then
    raise exception 'apply 20261020_admin_session_generation.sql before 20261022_admin_mfa_foundation.sql';
  end if;
end $$;

alter table admin_users add column if not exists mfa_required_after timestamptz;
alter table admin_users add column if not exists mfa_failed_attempts integer not null default 0 check (mfa_failed_attempts >= 0);
alter table admin_users add column if not exists mfa_locked_until timestamptz;
alter table admin_users add column if not exists mfa_reset_at timestamptz;
alter table admin_users add column if not exists mfa_reset_by text;

create table if not exists admin_mfa_credentials (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references admin_users(id) on delete cascade,
  type text not null check (type in ('totp', 'webauthn')),
  label text not null default '',
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  secret_ciphertext text, secret_nonce text, secret_key_id text,
  totp_last_step bigint not null default 0 check (totp_last_step >= 0),
  webauthn_credential_id bytea unique, webauthn_public_key bytea, webauthn_sign_count bigint check (webauthn_sign_count is null or webauthn_sign_count >= 0),
  webauthn_transports text[], webauthn_aaguid uuid, webauthn_backup_eligible boolean,
  created_at timestamptz not null default now(), activated_at timestamptz, last_used_at timestamptz,
  revoked_at timestamptz, revoked_by text, revoked_reason text,
  check ((type = 'totp' and secret_ciphertext is not null and secret_nonce is not null and secret_key_id is not null)
      or (type = 'webauthn' and webauthn_credential_id is not null and webauthn_public_key is not null))
);
create unique index if not exists admin_mfa_one_totp_per_user on admin_mfa_credentials (admin_user_id) where type = 'totp' and status in ('pending', 'active');
create index if not exists admin_mfa_credentials_user on admin_mfa_credentials (admin_user_id);

create table if not exists admin_mfa_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references admin_users(id) on delete cascade,
  batch_id uuid not null,
  code_hmac text not null unique,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create index if not exists admin_mfa_recovery_codes_user on admin_mfa_recovery_codes (admin_user_id) where used_at is null;

create table if not exists admin_mfa_challenges (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references admin_users(id) on delete cascade,
  purpose text not null check (purpose in ('webauthn_register', 'webauthn_authenticate')),
  challenge bytea not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index if not exists admin_mfa_challenges_expiry on admin_mfa_challenges (expires_at);

-- Only the Office server's service credentials may reach any of this; never the Data API roles. RLS is on with NO policies.
alter table admin_mfa_credentials enable row level security;
alter table admin_mfa_recovery_codes enable row level security;
alter table admin_mfa_challenges enable row level security;
revoke all on admin_mfa_credentials, admin_mfa_recovery_codes, admin_mfa_challenges from public;

-- PL/pgSQL, never a constant SQL function: a trivial `language sql` body is INLINED (or folded when immutable) at plan time, and a plan cached by PostgREST's per-connection prepared
-- statements then runs for ANY role with no EXECUTE check (observed: an anon/authenticated probe answered 200). A PL/pgSQL function is a real call and is privilege-checked on every execution.
create or replace function office_mfa_schema_version() returns integer language plpgsql stable as $f$ begin return 1; end $f$;

-- Replay protection: succeeds only for an ACTIVE TOTP credential whose stored step is strictly lower. One statement; concurrent callers serialise on the row lock and re-check.
create or replace function office_mfa_consume_totp_step(p_credential_id uuid, p_step bigint) returns boolean language sql as $f$
  with u as (
    update admin_mfa_credentials set totp_last_step = p_step, last_used_at = now()
     where id = p_credential_id and type = 'totp' and status = 'active' and totp_last_step < p_step
    returning 1)
  select exists (select 1 from u);
$f$;

create or replace function office_mfa_consume_recovery_code(p_user_id uuid, p_code_hmac text) returns boolean language sql as $f$
  with u as (
    update admin_mfa_recovery_codes set used_at = now()
     where admin_user_id = p_user_id and code_hmac = p_code_hmac and used_at is null
    returning 1)
  select exists (select 1 from u);
$f$;

-- Replaces the account's UNUSED codes with a new batch in one transaction (used codes stay as history). A per-account advisory lock serialises concurrent replacements.
create or replace function office_mfa_replace_recovery_codes(p_user_id uuid, p_batch_id uuid, p_hmacs text[]) returns integer language plpgsql as $f$
declare inserted integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('office_mfa_recovery:' || p_user_id::text, 0));
  delete from admin_mfa_recovery_codes where admin_user_id = p_user_id and used_at is null;
  insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac) select p_user_id, p_batch_id, h from unnest(p_hmacs) as h;
  get diagnostics inserted = row_count;
  return inserted;
end $f$;

create or replace function office_mfa_create_challenge(p_user_id uuid, p_purpose text, p_challenge_b64 text, p_ttl_seconds integer)
returns table (id uuid, expires_at timestamptz) language sql as $f$
  insert into admin_mfa_challenges (admin_user_id, purpose, challenge, expires_at)
  values (p_user_id, p_purpose, decode(p_challenge_b64, 'base64'), now() + make_interval(secs => greatest(1, least(coalesce(p_ttl_seconds, 300), 900))))
  returning admin_mfa_challenges.id, admin_mfa_challenges.expires_at;
$f$;

-- Single use, bound to the account AND the purpose; returns the challenge (base64) exactly once, otherwise NULL.
create or replace function office_mfa_consume_challenge(p_challenge_id uuid, p_user_id uuid, p_purpose text) returns text language sql as $f$
  with c as (
    update admin_mfa_challenges set consumed_at = now()
     where id = p_challenge_id and admin_user_id = p_user_id and purpose = p_purpose and consumed_at is null and expires_at > now()
    returning replace(encode(challenge, 'base64'), E'\n', '') as v)
  select v from c;
$f$;

-- Atomic failure counting with progressive, time-limited locks (never permanent; a longer existing lock is never shortened).
create or replace function office_mfa_record_failure(p_user_id uuid) returns table (failed_attempts integer, locked_until timestamptz) language sql as $f$
  update admin_users
     set mfa_failed_attempts = admin_users.mfa_failed_attempts + 1,
         mfa_locked_until = case
           when admin_users.mfa_failed_attempts + 1 >= 20 then greatest(coalesce(admin_users.mfa_locked_until, now()), now() + interval '60 minutes')
           when admin_users.mfa_failed_attempts + 1 >= 10 then greatest(coalesce(admin_users.mfa_locked_until, now()), now() + interval '15 minutes')
           when admin_users.mfa_failed_attempts + 1 >= 5 then greatest(coalesce(admin_users.mfa_locked_until, now()), now() + interval '1 minute')
           else admin_users.mfa_locked_until end
   where id = p_user_id
  returning admin_users.mfa_failed_attempts, admin_users.mfa_locked_until;
$f$;

create or replace function office_mfa_clear_failures(p_user_id uuid) returns void language sql as $f$
  update admin_users set mfa_failed_attempts = 0, mfa_locked_until = null where id = p_user_id;
$f$;

-- One transaction: revoke the account's credentials, delete its unused codes, clear failures, stamp the reset and bump the session generation. No caller exists in S7.5.1.
create or replace function office_mfa_reset(p_user_id uuid, p_actor text) returns table (session_generation integer, credentials_revoked integer, codes_deleted integer) language plpgsql as $f$
declare new_generation integer; revoked integer; deleted integer;
begin
  update admin_users
     set session_generation = admin_users.session_generation + 1, sessions_revoked_at = now(), sessions_revoked_by = left(coalesce(p_actor, ''), 200),
         mfa_reset_at = now(), mfa_reset_by = left(coalesce(p_actor, ''), 200), mfa_failed_attempts = 0, mfa_locked_until = null
   where admin_users.id = p_user_id
  returning admin_users.session_generation into new_generation;
  if new_generation is null then return; end if;
  update admin_mfa_credentials set status = 'revoked', revoked_at = now(), revoked_by = left(coalesce(p_actor, ''), 200), revoked_reason = 'reset'
   where admin_mfa_credentials.admin_user_id = p_user_id and admin_mfa_credentials.status in ('pending', 'active');
  get diagnostics revoked = row_count;
  delete from admin_mfa_recovery_codes where admin_mfa_recovery_codes.admin_user_id = p_user_id and admin_mfa_recovery_codes.used_at is null;
  get diagnostics deleted = row_count;
  return query select new_generation, revoked, deleted;
end $f$;

create or replace function office_mfa_prune_challenges(p_older_than interval default interval '1 hour') returns integer language sql as $f$
  with d as (delete from admin_mfa_challenges where expires_at < now() - p_older_than or consumed_at < now() - p_older_than returning 1)
  select count(*)::integer from d;
$f$;

-- Function access: service role only (guarded so the file also applies on plain Postgres fixtures).
do $$
declare f text;
begin
  for f in select unnest(array[
    'office_mfa_schema_version()', 'office_mfa_consume_totp_step(uuid, bigint)', 'office_mfa_consume_recovery_code(uuid, text)',
    'office_mfa_replace_recovery_codes(uuid, uuid, text[])', 'office_mfa_create_challenge(uuid, text, text, integer)', 'office_mfa_consume_challenge(uuid, uuid, text)',
    'office_mfa_record_failure(uuid)', 'office_mfa_clear_failures(uuid)', 'office_mfa_reset(uuid, text)', 'office_mfa_prune_challenges(interval)'])
  loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on admin_mfa_credentials, admin_mfa_recovery_codes, admin_mfa_challenges from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on admin_mfa_credentials, admin_mfa_recovery_codes, admin_mfa_challenges from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on admin_mfa_credentials to service_role;
    grant select, insert, update, delete on admin_mfa_recovery_codes, admin_mfa_challenges to service_role;
  end if;
end $$;
