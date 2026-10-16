-- Rollback of S7.5.5 WebAuthn support. NON-DESTRUCTIVE: only functions change. Every credential, public key and counter is kept.
-- The S7.5.4 activation function is restored (no WebAuthn credential limit); the counter and probe functions are dropped.
drop function if exists office_mfa_webauthn_record_use(uuid, uuid, bigint);
drop function if exists office_mfa_webauthn_version();
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
