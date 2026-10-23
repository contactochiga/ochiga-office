-- Settings S7.5.4: MFA enrollment and recovery management. Additive: indexes replaced, functions added; existing accounts, credentials and codes are untouched.
-- Requires 20261020 (session generation), 20261022 (MFA foundation) and 20261023 (recovery-code key id).
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'admin_mfa_recovery_codes' and column_name = 'key_id') then
    raise exception 'apply 20261023_admin_mfa_recovery_code_key_id.sql before 20261024_admin_mfa_management.sql';
  end if;
end $$;

-- A replacement needs the old ACTIVE credential and the new PENDING one at the same time: one of each per account instead of one pending-or-active.
drop index if exists admin_mfa_one_totp_per_user;
create unique index if not exists admin_mfa_one_active_totp_per_user on admin_mfa_credentials (admin_user_id) where type = 'totp' and status = 'active';
create unique index if not exists admin_mfa_one_pending_totp_per_user on admin_mfa_credentials (admin_user_id) where type = 'totp' and status = 'pending';

-- PL/pgSQL on purpose (see 20261022): an inlinable constant SQL function would skip the EXECUTE privilege check when run from a cached plan.
create or replace function office_mfa_management_version() returns integer language plpgsql stable as $f$ begin return 1; end $f$;

-- One transaction: (optionally) revoke the credential being replaced, activate the pending one, record the used TOTP step, store the first recovery batch, bump the session generation.
-- Returns no row when the pending credential is not the account's pending credential; raises (rolling everything back) when a replacement target is not the active credential.
-- R10: this definition is superseded by 20261025 (WebAuthn-aware); re-applying this file later must not revert it.
do $guard$ begin
  if to_regprocedure('office_mfa_webauthn_version()') is null or to_regprocedure('office_mfa_activate_credential(uuid, uuid, text, uuid, bigint, text[], text)') is null then
    execute $def$
create or replace function office_mfa_activate_credential(
  p_user_id uuid, p_credential_id uuid, p_actor text, p_replace_credential_id uuid default null, p_totp_step bigint default null,
  p_recovery_hmacs text[] default null, p_key_id text default null)
returns table (session_generation integer, replaced boolean, recovery_codes integer) language plpgsql as $f$
declare new_generation integer; did_replace boolean := false; codes integer := 0; activated integer;
begin
  perform 1 from admin_users where id = p_user_id for update;
  if not found then return; end if;
  if not exists (select 1 from admin_mfa_credentials where id = p_credential_id and admin_user_id = p_user_id and status = 'pending') then return; end if;
  if p_replace_credential_id is not null then
    update admin_mfa_credentials set status = 'revoked', revoked_at = now(), revoked_by = left(coalesce(p_actor, ''), 200), revoked_reason = 'replaced'
     where id = p_replace_credential_id and admin_user_id = p_user_id and status = 'active';
    get diagnostics activated = row_count;
    if activated <> 1 then raise exception 'replace_target_not_active' using errcode = 'P0001'; end if;
    did_replace := true;
  end if;
  update admin_mfa_credentials set status = 'active', activated_at = now(), totp_last_step = greatest(totp_last_step, coalesce(p_totp_step, 0))
   where id = p_credential_id and admin_user_id = p_user_id and status = 'pending';
  if p_recovery_hmacs is not null then
    perform pg_advisory_xact_lock(hashtextextended('office_mfa_recovery:' || p_user_id::text, 0));
    delete from admin_mfa_recovery_codes where admin_user_id = p_user_id and used_at is null;
    insert into admin_mfa_recovery_codes (admin_user_id, batch_id, code_hmac, key_id) select p_user_id, gen_random_uuid(), h, p_key_id from unnest(p_recovery_hmacs) as h;
    get diagnostics codes = row_count;
  end if;
  update admin_users set session_generation = admin_users.session_generation + 1, sessions_revoked_at = now(), sessions_revoked_by = left(coalesce(p_actor, ''), 200)
   where admin_users.id = p_user_id returning admin_users.session_generation into new_generation;
  return query select new_generation, did_replace, codes;
end $f$;
    $def$;
  end if;
end $guard$;

-- One transaction: revoke a pending/active credential; refuse (roll back) when it is the last active factor and the caller wants one kept; delete the unused recovery codes when no
-- active factor remains; bump the generation when an ACTIVE factor was removed. Returns no row when the credential is not revocable.
create or replace function office_mfa_revoke_credential(p_user_id uuid, p_credential_id uuid, p_actor text, p_reason text default null, p_keep_last boolean default false)
returns table (session_generation integer, remaining_active integer, codes_deleted integer, was_active boolean) language plpgsql as $f$
declare was text; remaining integer; deleted integer := 0; new_generation integer;
begin
  perform 1 from admin_users where id = p_user_id for update;
  if not found then return; end if;
  select status into was from admin_mfa_credentials where id = p_credential_id and admin_user_id = p_user_id and status in ('pending', 'active') for update;
  if was is null then return; end if;
  update admin_mfa_credentials set status = 'revoked', revoked_at = now(), revoked_by = left(coalesce(p_actor, ''), 200), revoked_reason = left(coalesce(p_reason, ''), 200)
   where id = p_credential_id and admin_user_id = p_user_id;
  select count(*)::integer into remaining from admin_mfa_credentials where admin_user_id = p_user_id and status = 'active';
  if was = 'active' and remaining = 0 and p_keep_last then raise exception 'last_active_factor' using errcode = 'P0001'; end if;
  if was = 'active' then
    if remaining = 0 then delete from admin_mfa_recovery_codes where admin_user_id = p_user_id and used_at is null; get diagnostics deleted = row_count; end if;
    update admin_users set session_generation = admin_users.session_generation + 1, sessions_revoked_at = now(), sessions_revoked_by = left(coalesce(p_actor, ''), 200)
     where admin_users.id = p_user_id returning admin_users.session_generation into new_generation;
  else
    select admin_users.session_generation into new_generation from admin_users where admin_users.id = p_user_id;
  end if;
  return query select new_generation, remaining, deleted, (was = 'active');
end $f$;

-- Closes the S7.5.3 gap: consuming a recovery code and ending the account's other sessions are ONE statement. No row = the code was not valid; nothing changed.
-- R6 (H2): same definition as db/20261029_mfa_lock_order.sql (admin_users locked first), so re-applying this older file never re-introduces the deadlock.
create or replace function office_mfa_consume_recovery_code_revoking(p_user_id uuid, p_code_hmac text, p_actor text)
returns table (session_generation integer, sessions_revoked_at timestamptz) language plpgsql as $f$
declare consumed integer;
begin
  perform 1 from admin_users where id = p_user_id for no key update;   -- lock order: admin_users first, then the code rows (as every other MFA function does)
  if not found then return; end if;
  update admin_mfa_recovery_codes set used_at = now() where admin_user_id = p_user_id and code_hmac = p_code_hmac and used_at is null;
  get diagnostics consumed = row_count;
  if consumed = 0 then return; end if;
  return query
    update admin_users set session_generation = admin_users.session_generation + 1, sessions_revoked_at = now(), sessions_revoked_by = left(coalesce(p_actor, ''), 200)
     where admin_users.id = p_user_id
    returning admin_users.session_generation, admin_users.sessions_revoked_at;
end $f$;


do $$
declare f text;
begin
  for f in select unnest(array[
    'office_mfa_management_version()',
    'office_mfa_activate_credential(uuid, uuid, text, uuid, bigint, text[], text)',
    'office_mfa_revoke_credential(uuid, uuid, text, text, boolean)',
    'office_mfa_consume_recovery_code_revoking(uuid, text, text)'])
  loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
