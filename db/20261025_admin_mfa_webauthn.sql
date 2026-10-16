-- Settings S7.5.5: WebAuthn / passkeys. Additive: functions only (the S7.5.1 columns already hold WebAuthn credentials). Requires 20261024_admin_mfa_management.sql.
do $$ begin
  if not exists (select 1 from pg_proc where proname = 'office_mfa_activate_credential') then
    raise exception 'apply 20261024_admin_mfa_management.sql before 20261025_admin_mfa_webauthn.sql';
  end if;
end $$;

-- PL/pgSQL on purpose (see 20261022): a trivial SQL probe would be inlined and could run from a cached plan for any role without the EXECUTE check.
create or replace function office_mfa_webauthn_version() returns integer language plpgsql stable as $f$ begin return 1; end $f$;

-- Counter compare-and-set for one ACTIVE WebAuthn credential of one account. Accepted only if the new counter is higher than the stored one, or both are 0 (synced passkeys report 0).
-- A lower or repeated counter signals a cloned or replayed authenticator: returns false and changes nothing. One statement, so concurrent assertions cannot both advance.
create or replace function office_mfa_webauthn_record_use(p_user_id uuid, p_credential_id uuid, p_new_count bigint) returns boolean language plpgsql as $f$
declare updated integer;
begin
  update admin_mfa_credentials set webauthn_sign_count = p_new_count, last_used_at = now()
   where id = p_credential_id and admin_user_id = p_user_id and type = 'webauthn' and status = 'active'
     and ((coalesce(webauthn_sign_count, 0) = 0 and p_new_count = 0) or p_new_count > coalesce(webauthn_sign_count, 0));
  get diagnostics updated = row_count;
  return updated = 1;
end $f$;

-- The S7.5.4 activation function, unchanged except for the 10-credential limit on WebAuthn (checked after a replacement frees its slot, inside the same transaction).
create or replace function office_mfa_activate_credential(
  p_user_id uuid, p_credential_id uuid, p_actor text, p_replace_credential_id uuid default null, p_totp_step bigint default null,
  p_recovery_hmacs text[] default null, p_key_id text default null)
returns table (session_generation integer, replaced boolean, recovery_codes integer) language plpgsql as $f$
declare new_generation integer; did_replace boolean := false; codes integer := 0; activated integer; ctype text;
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
  select type into ctype from admin_mfa_credentials where id = p_credential_id;
  if ctype = 'webauthn' and (select count(*) from admin_mfa_credentials where admin_user_id = p_user_id and type = 'webauthn' and status = 'active') >= 10 then
    raise exception 'credential_limit' using errcode = 'P0001';   -- at most 10 active WebAuthn credentials per account
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

do $$
declare f text;
begin
  for f in select unnest(array['office_mfa_webauthn_version()', 'office_mfa_webauthn_record_use(uuid, uuid, bigint)', 'office_mfa_activate_credential(uuid, uuid, text, uuid, bigint, text[], text)'])
  loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
