-- Rollback of R6 lock ordering: restores the S7.5.4 definition (function only). WARNING: that definition can deadlock against activation/reset (finding H2).
create or replace function office_mfa_consume_recovery_code_revoking(p_user_id uuid, p_code_hmac text, p_actor text)
returns table (session_generation integer, sessions_revoked_at timestamptz) language sql as $f$
  with c as (
    update admin_mfa_recovery_codes set used_at = now() where admin_user_id = p_user_id and code_hmac = p_code_hmac and used_at is null returning 1)
  update admin_users set session_generation = admin_users.session_generation + 1, sessions_revoked_at = now(), sessions_revoked_by = left(coalesce(p_actor, ''), 200)
   where admin_users.id = p_user_id and exists (select 1 from c)
  returning admin_users.session_generation, admin_users.sessions_revoked_at;
$f$;
