-- S7 R6 (H2): one lock order for the account's MFA state. Requires 20261025_admin_mfa_webauthn.sql. Function-only change; no table, row or privilege changes.
-- Root cause: office_mfa_consume_recovery_code_revoking updated the recovery-code row FIRST and the admin_users row SECOND, while activation, reset, factor revocation and
-- recovery-code regeneration take the admin_users row FIRST and delete recovery-code rows SECOND. Two sessions in opposite order => Postgres 40P01 (deadlock detected).
-- Fix: the consumer locks the admin_users row (FOR NO KEY UPDATE: conflicts with every writer of that row, does not block foreign-key inserts) before touching its code row.
-- Semantics are unchanged: a valid unused code is consumed AND the session generation is bumped in one transaction; an invalid/used code changes nothing and returns no row;
-- two concurrent consumptions of the same code still yield exactly one success (the second sees used_at set once the first commits).
do $$ begin
  if to_regprocedure('public.office_mfa_consume_recovery_code_revoking(uuid, text, text)') is null then
    raise exception 'apply 20261025_admin_mfa_webauthn.sql before 20261029_mfa_lock_order.sql';
  end if;
end $$;

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
