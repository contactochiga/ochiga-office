-- S7 R5: credential-table lockdown. ADDITIVE and IDEMPOTENT; changes no row, column, hash or account.
-- Closes finding H1: the bootstrap schema created admin_users / admin_invites / password_reset_tokens / audit_events without row level
-- security, so on a Supabase project (whose default privileges grant anon and authenticated access to new public tables) the Data API
-- could return password hashes, invitation/reset token digests and the audit trail to any holder of the public anon key.
--   Order: after lead-agents-schema.sql and every earlier dated migration (it needs only the base tables).
--   Effect: RLS enabled with NO policy (deny by default for every role that does not bypass RLS), all privileges revoked from PUBLIC,
--           anon and authenticated (table level AND column level), service_role keeps full row access. The application connects as
--           service_role (PostgREST) or as the table owner (direct connection); both bypass RLS and are unaffected.
--   Not FORCEd on purpose: FORCE would also bind the owner and break direct-connection deployments and the SECURITY INVOKER functions.
do $$
begin
  if to_regclass('public.admin_users') is null then
    raise exception 'apply db/lead-agents-schema.sql before 20261027_credential_tables_lockdown.sql';
  end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['admin_users', 'admin_invites', 'password_reset_tokens', 'audit_events'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
      execute format('revoke all (%s) on public.%I from anon', (select string_agg(quote_ident(attname), ', ') from pg_attribute where attrelid = ('public.' || quote_ident(t))::regclass and attnum > 0 and not attisdropped), t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t);
      execute format('revoke all (%s) on public.%I from authenticated', (select string_agg(quote_ident(attname), ', ') from pg_attribute where attrelid = ('public.' || quote_ident(t))::regclass and attnum > 0 and not attisdropped), t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select, insert, update, delete on public.%I to service_role', t);
    end if;
  end loop;
end $$;

-- Trigger function from 20261019 was revoked from PUBLIC only; Supabase default privileges had also granted it to the Data API roles.
-- It cannot be called as an RPC (it returns trigger) but nothing should be executable there that need not be.
do $$
begin
  if to_regprocedure('public.office_runtime_setting_history_immutable()') is not null then
    if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.office_runtime_setting_history_immutable() from anon; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.office_runtime_setting_history_immutable() from authenticated; end if;
  end if;
end $$;

-- office_runtime_settings already had RLS on (no policy) but still carried table privileges for the Data API roles (incl. TRUNCATE, which RLS does not govern).
-- Privileges are removed; service_role is not re-granted anything here (it keeps what it has).
do $$
begin
  if to_regclass('public.office_runtime_settings') is not null then
    revoke all on public.office_runtime_settings from public;
    if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.office_runtime_settings from anon; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.office_runtime_settings from authenticated; end if;
  end if;
end $$;
