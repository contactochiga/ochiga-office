-- Read-only verification for 20261016_ochiga_office_p0_access_hardening.sql. Every query should return the "expected" value shown.
-- 1. tables still exposed to the Data API roles (expected: 0 rows)
select c.relname, r.role_name, string_agg(p.priv, ',') as privileges
from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join (values ('anon'), ('authenticated')) r(role_name)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f') and has_table_privilege(r.role_name, c.oid, p.priv)
group by 1, 2 order by 1, 2;
-- 2. tables without RLS (expected: 0 rows)
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
-- 3. functions executable by the Data API roles (expected: 0 rows)
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
-- 4. service_role still complete (expected: missing_tables = 0)
select count(*) as missing_tables from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and not (has_table_privilege('service_role', c.oid, 'SELECT') and has_table_privilege('service_role', c.oid, 'INSERT') and has_table_privilege('service_role', c.oid, 'UPDATE') and has_table_privilege('service_role', c.oid, 'DELETE'));
-- 5. default privileges no longer grant anon/authenticated (expected: 0 rows for role postgres; supabase_admin rows only if its statement was run)
select pg_get_userbyid(defaclrole) as creator, defaclobjtype::text as objtype, defaclacl::text as acl from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
where n.nspname = 'public' and (defaclacl::text like '%anon=%' or defaclacl::text like '%authenticated=%');
-- 6. row counts are unaffected (compare with the pre-change baseline)
select 'inbound_events' t, count(*) from public.inbound_events union all select 'leads', count(*) from public.leads union all select 'admin_users', count(*) from public.admin_users;
-- 7. column-level grants or PUBLIC entries on relations (expected: 0 rows)
select c.relname, 'column' as kind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m','f') and (has_any_column_privilege('anon', c.oid, 'SELECT') or has_any_column_privilege('authenticated', c.oid, 'SELECT') or has_any_column_privilege('anon', c.oid, 'UPDATE') or has_any_column_privilege('authenticated', c.oid, 'UPDATE') or has_any_column_privilege('anon', c.oid, 'INSERT') or has_any_column_privilege('authenticated', c.oid, 'INSERT'))
union all select c.relname, 'public-acl' from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m','f','S') and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 0);
-- 8. schema USAGE for the Data API roles (expected: anon=false, authenticated=false, service_role=true)
select has_schema_privilege('anon','public','USAGE') anon, has_schema_privilege('authenticated','public','USAGE') authenticated, has_schema_privilege('service_role','public','USAGE') service_role;
-- 9. creator roles that can still create objects in public, and whether their default ACLs still mention anon/authenticated (report; supabase_admin needs the privileged script)
select r.rolname as creator, exists (select 1 from pg_default_acl d, lateral aclexplode(d.defaclacl) a where d.defaclrole = r.oid and d.defaclnamespace in (0, 'public'::regnamespace) and a.grantee in ('anon'::regrole, 'authenticated'::regrole)) as default_acl_still_grants_data_api_roles
from pg_roles r where r.rolname !~ '^pg_' and has_schema_privilege(r.oid, 'public', 'CREATE') order by 1;
