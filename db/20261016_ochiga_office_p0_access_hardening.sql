-- P0 access hardening for the Office Supabase project (public schema).
--
-- Finding: every public table had RLS disabled (4 had RLS enabled with no policy) AND full table privileges granted to the Data API roles `anon` and
-- `authenticated` (Supabase default privileges), so the public anon key could read, write, delete and truncate Office data through the REST API,
-- including admin_users (password hashes), admin_invites / password_reset_tokens (token hashes), leads, conversations and staff messages.
--
-- Evidence this is safe for the applications: Office reaches this database only server-side with the service_role key (BYPASSRLS; keeps every privilege and
-- the explicit schema USAGE grant below); no browser code and no other repository uses this project's anon key; pg_stat_statements shows 108,607 service_role
-- calls and ~54 anon calls in total (all probing statements, none application traffic).
--
-- What this migration does (one transaction, repeatable, no business data read or changed):
--   1. removes every privilege of PUBLIC, anon and authenticated on all tables/views/sequences/functions in schema public (this also removes column-level grants);
--   2. enables row level security on every ordinary/partitioned table in public (no policies: deny-by-default for every role without BYPASSRLS);
--   3. removes USAGE on schema public from PUBLIC, anon and authenticated, after granting it EXPLICITLY to every other role that has it today, so no other role
--      changes behaviour. Without schema USAGE the Data API roles cannot reach ANY object in public, including objects created later by any creator role;
--   4. changes default privileges so future objects created by `postgres` in public are not granted to anon/authenticated. The same change for `supabase_admin`
--      needs that role's authority; if it cannot be made the migration says so (WARNING) and relies on step 3 for the Data API;
--   5. verifies the effective result and aborts the whole migration if anything unsafe remains or service_role lost access.
-- Not touched: auth, storage, realtime and other platform schemas. Storage bucket `office-media` is private with RLS and no policies.

begin;

-- 1. privileges -----------------------------------------------------------------------------------------------------------------------------------
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- 2. row level security on every ordinary/partitioned table in public ------------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select c.oid::regclass as rel
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  loop
    execute format('alter table %s enable row level security', r.rel);
  end loop;
end $$;

-- 3. schema usage ---------------------------------------------------------------------------------------------------------------------------------
do $$
declare r record;
begin
  -- keep every other role exactly as it is today (they hold USAGE only through PUBLIC); only the Data API roles lose it
  for r in
    select rolname from pg_roles
    where rolname !~ '^pg_' and rolname not in ('anon', 'authenticated') and has_schema_privilege(oid, 'public', 'USAGE')
  loop
    execute format('grant usage on schema public to %I', r.rolname);
  end loop;
end $$;
revoke usage on schema public from public, anon, authenticated;

-- 4. default privileges for future objects ---------------------------------------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
-- NOTE: PostgreSQL grants EXECUTE on every new function to PUBLIC by default. A schema-scoped default-privilege revoke cannot remove that implicit entry (tested), and a
-- global one would change every schema; so new functions stay ACL-executable by PUBLIC but unreachable by the Data API roles because they have no USAGE on schema public.
do $$
begin
  begin
    execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from anon, authenticated';
    execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from anon, authenticated';
    execute 'alter default privileges for role supabase_admin in schema public revoke all on functions from anon, authenticated';
  exception when insufficient_privilege then
    raise warning 'FUTURE-OBJECT NOTICE: the current role may not change default privileges of role supabase_admin. Objects that supabase_admin creates in public would carry anon/authenticated ACL entries; they remain unreachable through the Data API only because schema USAGE was revoked above. Run db/privileged/20261016_supabase_admin_default_privileges.sql as supabase_admin to close this completely.';
  end;
end $$;

-- 5. verification (aborts the transaction on any failure) ------------------------------------------------------------------------------------------
do $$
declare exposed int; col_exposed int; public_grants int; no_rls int; svc_missing int; schema_open boolean; svc_schema boolean; fn_exposed int; creator record; acl_exposed int;
begin
  -- relations: table-level privileges of anon/authenticated (tables, partitioned tables, views, materialized views, foreign tables)
  select count(*) into exposed
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated')) as roles(role_name)
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as privs(priv)
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f') and has_table_privilege(roles.role_name, c.oid, privs.priv);
  if exposed > 0 then raise exception 'P0 hardening failed: % anon/authenticated table privileges remain in public', exposed; end if;

  -- column-level grants are separate ACLs
  select count(*) into col_exposed
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated')) as roles(role_name)
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f') and (has_any_column_privilege(roles.role_name, c.oid, 'SELECT') or has_any_column_privilege(roles.role_name, c.oid, 'INSERT') or has_any_column_privilege(roles.role_name, c.oid, 'UPDATE') or has_any_column_privilege(roles.role_name, c.oid, 'REFERENCES'));
  if col_exposed > 0 then raise exception 'P0 hardening failed: % relations still carry column-level privileges for anon/authenticated', col_exposed; end if;

  -- PUBLIC entries in object ACLs
  select count(*) into public_grants from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 0);
  if public_grants > 0 then raise exception 'P0 hardening failed: % public relations still grant privileges to PUBLIC', public_grants; end if;

  select count(*) into fn_exposed from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if fn_exposed > 0 then raise exception 'P0 hardening failed: % public functions are executable by anon/authenticated', fn_exposed; end if;

  select count(*) into no_rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if no_rls > 0 then raise exception 'P0 hardening failed: % public tables still have row level security disabled', no_rls; end if;

  select count(*) into svc_missing from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and not (has_table_privilege('service_role', c.oid, 'SELECT') and has_table_privilege('service_role', c.oid, 'INSERT') and has_table_privilege('service_role', c.oid, 'UPDATE') and has_table_privilege('service_role', c.oid, 'DELETE'));
  if svc_missing > 0 then raise exception 'P0 hardening failed: service_role lost access to % tables', svc_missing; end if;

  schema_open := has_schema_privilege('anon', 'public', 'USAGE') or has_schema_privilege('authenticated', 'public', 'USAGE');
  if schema_open then raise exception 'P0 hardening failed: anon/authenticated still have USAGE on schema public'; end if;
  svc_schema := has_schema_privilege('service_role', 'public', 'USAGE') and has_schema_privilege('postgres', 'public', 'USAGE');
  if not svc_schema then raise exception 'P0 hardening failed: service_role/postgres lost USAGE on schema public'; end if;

  -- future objects: inspect the REAL default ACLs of every role that can create objects in public (schema-level and global entries)
  for creator in select r.oid, r.rolname from pg_roles r where r.rolname !~ '^pg_' and has_schema_privilege(r.oid, 'public', 'CREATE') loop
    select count(*) into acl_exposed
    from pg_default_acl d, lateral aclexplode(d.defaclacl) a
    where d.defaclrole = creator.oid and d.defaclnamespace in (0, 'public'::regnamespace) and a.grantee in ('anon'::regrole, 'authenticated'::regrole);
    if acl_exposed > 0 then
      raise warning 'FUTURE-OBJECT EXPOSURE (ACL level) for objects created by role %: % default privilege entries still grant anon/authenticated. Not reachable through the Data API because schema public has no USAGE for them; fix with the privileged script.', creator.rolname, acl_exposed;
    end if;
  end loop;
end $$;

commit;
