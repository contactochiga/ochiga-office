-- P0 access hardening for the Office Supabase project (public schema).
--
-- Finding: every public table had RLS disabled (4 had RLS enabled with no policy) AND full table privileges granted to the Data API roles `anon` and
-- `authenticated` (Supabase default privileges), so the public anon key could read, write, delete and truncate Office data through the REST API,
-- including admin_users (password hashes), admin_invites / password_reset_tokens (token hashes), leads, conversations and staff messages.
--
-- Evidence this is safe for the applications: Office reaches this database only server-side with the service_role key (bypasses RLS and is not touched here);
-- no browser code and no other repository uses this project's anon key; pg_stat_statements shows 108,607 service_role calls and ~54 anon calls in total
-- (all of them probing statements, none application traffic).
--
-- What this migration does (all repeatable; no business data is read or changed):
--   1. removes every privilege of anon and authenticated on all tables, sequences and functions in schema public (schema USAGE is deliberately left alone:
--      it is also granted to PUBLIC by PostgreSQL's default ACL, revoking that would affect every role, and without table privileges it exposes no data or names);
--   2. enables row level security on every table in public (no policies: deny by default for any role that does not bypass RLS);
--   3. changes the default privileges so FUTURE objects created by postgres / supabase_admin in public are not exposed to anon/authenticated;
--   4. leaves service_role and postgres untouched;
--   5. verifies the result and aborts the whole migration (it runs in one transaction) if any exposure remains or service_role lost access.
-- Not touched: auth, storage, realtime schemas (storage bucket `office-media` is private with RLS and no policies); WhatsApp tables from other migrations
-- are covered automatically by the dynamic loops below.

begin;

-- 1. privileges -----------------------------------------------------------------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
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

-- 3. default privileges for future objects ---------------------------------------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
do $$
begin
  -- Supabase also installs default privileges for objects created by supabase_admin; changing them may need that role, so a refusal is reported, not fatal
  begin
    execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from anon, authenticated';
    execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from anon, authenticated';
    execute 'alter default privileges for role supabase_admin in schema public revoke all on functions from anon, authenticated';
  exception when insufficient_privilege then
    raise notice 'could not change supabase_admin default privileges (insufficient privilege); run that statement as supabase_admin if tables are ever created by it';
  end;
end $$;

-- 4. verification (aborts the transaction on any failure) ------------------------------------------------------------------------------------------
do $$
declare exposed int; no_rls int; svc_missing int;
begin
  select count(*) into exposed
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated')) as roles(role_name)
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as privs(priv)
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and has_table_privilege(roles.role_name, c.oid, privs.priv);
  if exposed > 0 then raise exception 'P0 hardening failed: % anon/authenticated table privileges remain in public', exposed; end if;

  select count(*) into no_rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if no_rls > 0 then raise exception 'P0 hardening failed: % public tables still have row level security disabled', no_rls; end if;

  select count(*) into svc_missing from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and not (has_table_privilege('service_role', c.oid, 'SELECT') and has_table_privilege('service_role', c.oid, 'INSERT') and has_table_privilege('service_role', c.oid, 'UPDATE') and has_table_privilege('service_role', c.oid, 'DELETE'));
  if svc_missing > 0 then raise exception 'P0 hardening failed: service_role lost access to % tables', svc_missing; end if;

end $$;

commit;
