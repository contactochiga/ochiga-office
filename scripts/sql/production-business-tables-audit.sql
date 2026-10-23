-- READ-ONLY catalog audit of every table in schema public that does NOT have row level security, and what the Data API roles can do to it. Reads pg_catalog metadata only:
-- it never selects a row from any application table. Run by the project owner (Supabase SQL editor / psql) against PRODUCTION and against staging; compare.
-- Purpose: scope the least-privilege plan in docs/settings-domain/53 (R10 section C). Nothing here changes anything.
\echo 'T1. tables WITHOUT row level security, with the table-level privileges held by PUBLIC / anon / authenticated / service_role'
select c.relname as table_name,
       coalesce((select string_agg(distinct a.privilege_type, ',' order by a.privilege_type) from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where a.grantee = 0), '') as public_privs,
       coalesce((select string_agg(distinct a.privilege_type, ',' order by a.privilege_type) from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where a.grantee::regrole::text = 'anon'), '') as anon_privs,
       coalesce((select string_agg(distinct a.privilege_type, ',' order by a.privilege_type) from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where a.grantee::regrole::text = 'authenticated'), '') as authenticated_privs,
       coalesce((select string_agg(distinct a.privilege_type, ',' order by a.privilege_type) from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where a.grantee::regrole::text = 'service_role'), '') as service_role_privs
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1;

\echo 'T2. count of tables in public by RLS state'
select c.relrowsecurity as rls_enabled, count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') group by 1 order by 1;

\echo 'T3. policies that exist on public tables (a policy "using (true)" for anon/authenticated would defeat RLS)'
select schemaname, tablename, policyname, roles, cmd, qual from pg_policies where schemaname = 'public' order by 2, 3;

\echo 'T4. views and materialized views in public (a view runs with its owner''s rights unless security_invoker is set)'
select c.relname, c.relkind, coalesce(c.reloptions::text, '') as options from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm') order by 1;

\echo 'T5. foreign keys between public tables (order of enabling RLS does not matter, but deletes cascade across them)'
select conrelid::regclass as child, confrelid::regclass as parent, confdeltype as on_delete from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace order by 1, 2;

\echo 'T6. default privileges that will grant NEW tables to the Data API roles'
select pg_get_userbyid(d.defaclrole) as owner_role, d.defaclobjtype, d.defaclacl from pg_default_acl d;
