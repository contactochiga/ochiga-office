-- Settings S7 remediation R4: durable revocation of ONE session (ordinary logout). Additive: no existing table, column, account, password, generation or session changes.
-- A session token may carry `sid` (random, signed). Logout stores a KEYED DIGEST of it here (never the identifier itself); verification refuses a token whose digest is listed.
-- A row only matters until the token's own expiry, so the table is bounded by the session lifetime and prunes itself. Service role only; MFA and account-wide revocation are untouched.
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'admin_users' and column_name = 'session_generation') then
    raise exception 'apply 20261020_admin_session_generation.sql before 20261026_admin_revoked_sessions.sql';
  end if;
end $$;

create table if not exists admin_revoked_sessions (
  session_digest text primary key check (char_length(session_digest) between 16 and 128),
  admin_user_id uuid not null references admin_users(id) on delete cascade,
  revoked_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists admin_revoked_sessions_expiry on admin_revoked_sessions (expires_at);
alter table admin_revoked_sessions enable row level security;   -- no policies: deny by default for every role that is not a superuser/service role
revoke all on admin_revoked_sessions from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on admin_revoked_sessions from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on admin_revoked_sessions from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select, insert, delete on admin_revoked_sessions to service_role; end if;
end $$;

-- PL/pgSQL on purpose (see 20261022): a constant SQL function can be planned once and run for any role without the EXECUTE check.
create or replace function office_session_revocation_version() returns integer language plpgsql stable as $f$ begin return 1; end $f$;

-- Idempotent: revoking an already revoked session succeeds and changes nothing. Also removes rows more than a day past their expiry (the token is dead by then anyway).
create or replace function office_revoke_session(p_digest text, p_user_id uuid, p_expires_at timestamptz) returns boolean language plpgsql as $f$
begin
  delete from admin_revoked_sessions where expires_at < now() - interval '1 day';
  insert into admin_revoked_sessions (session_digest, admin_user_id, expires_at) values (p_digest, p_user_id, p_expires_at) on conflict (session_digest) do nothing;
  return true;
end $f$;

create or replace function office_is_session_revoked(p_digest text) returns boolean language plpgsql stable as $f$
begin
  return exists (select 1 from admin_revoked_sessions where session_digest = p_digest);
end $f$;

do $$
declare f text;
begin
  for f in select unnest(array['office_session_revocation_version()', 'office_revoke_session(text, uuid, timestamptz)', 'office_is_session_revoked(text)'])
  loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
