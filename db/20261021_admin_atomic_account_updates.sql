-- Settings S7.5.0: one atomic statement for a credential/status change AND its session revocation. Requires 20261020_admin_session_generation.sql.
-- Closes the window between "bump the generation" and "write the password" (the old two-step order let a sign-in with the old password in between survive the change).
-- Additive: a function only; no table or column changes, existing accounts untouched. NULL arguments leave a column unchanged.
create or replace function office_admin_update_revoking_sessions(
  p_user_id uuid, p_actor text,
  p_password_hash text default null, p_password_changed_at timestamptz default null,
  p_status text default null,
  p_set_removed boolean default false, p_removed_at timestamptz default null, p_removed_by text default null)
returns table (session_generation integer, sessions_revoked_at timestamptz) language sql as $f$
  update admin_users
     set password_hash = coalesce(p_password_hash, admin_users.password_hash),
         password_changed_at = coalesce(p_password_changed_at, admin_users.password_changed_at),
         status = coalesce(p_status, admin_users.status),
         removed_at = case when p_set_removed then p_removed_at else admin_users.removed_at end,
         removed_by = case when p_set_removed then p_removed_by else admin_users.removed_by end,
         session_generation = admin_users.session_generation + 1,
         sessions_revoked_at = now(),
         sessions_revoked_by = left(coalesce(p_actor, ''), 200)
   where id = p_user_id
  returning admin_users.session_generation, admin_users.sessions_revoked_at;
$f$;

revoke all on function office_admin_update_revoking_sessions(uuid, text, text, timestamptz, text, boolean, timestamptz, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function office_admin_update_revoking_sessions(uuid, text, text, timestamptz, text, boolean, timestamptz, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function office_admin_update_revoking_sessions(uuid, text, text, timestamptz, text, boolean, timestamptz, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function office_admin_update_revoking_sessions(uuid, text, text, timestamptz, text, boolean, timestamptz, text) to service_role;
  end if;
end $$;
