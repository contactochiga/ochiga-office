-- Settings S7.4: session revocation. Additive only: existing users, roles, scopes, statuses and password hashes are untouched (every row starts at generation 0).
-- A session token carries the generation it was issued under; it is valid only while that equals admin_users.session_generation. Revocation is one atomic increment.
alter table admin_users add column if not exists session_generation integer not null default 0;
alter table admin_users add column if not exists sessions_revoked_at timestamptz;
alter table admin_users add column if not exists sessions_revoked_by text;
alter table admin_users drop constraint if exists admin_users_session_generation_check;
alter table admin_users add constraint admin_users_session_generation_check check (session_generation >= 0);

-- Atomic and serialised by the row lock; returns the NEW generation. p_reason is accepted for call-site symmetry and is recorded in the application audit, not here.
create or replace function office_revoke_admin_sessions(p_user_id uuid, p_actor text, p_reason text default null)
returns table (session_generation integer, sessions_revoked_at timestamptz) language sql as $f$
  update admin_users
     set session_generation = admin_users.session_generation + 1,
         sessions_revoked_at = now(),
         sessions_revoked_by = left(coalesce(p_actor, ''), 200)
   where id = p_user_id
  returning admin_users.session_generation, admin_users.sessions_revoked_at;
$f$;

-- Only the Office server's service credentials may call it; never the Data API roles (guarded so the file also applies on plain Postgres test fixtures).
revoke all on function office_revoke_admin_sessions(uuid, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function office_revoke_admin_sessions(uuid, text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function office_revoke_admin_sessions(uuid, text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function office_revoke_admin_sessions(uuid, text, text) to service_role;
  end if;
end $$;
