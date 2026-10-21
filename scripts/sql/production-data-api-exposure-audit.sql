-- READ-ONLY catalog audit for the credential tables. Run by the project owner in the Supabase SQL editor (or psql) against PRODUCTION.
-- Reads only pg_catalog metadata: it never selects a row, hash or personal record from any application table. Safe to run repeatedly.
-- Expected after remediation: every query in sections 1-5 returns ZERO rows (section 0 and 6 are informational).
\echo '0. migration markers (informational): which Office objects exist'
select to_regclass('public.admin_users') is not null as admin_users, to_regclass('public.admin_mfa_credentials') is not null as mfa_tables,
       to_regclass('public.admin_revoked_sessions') is not null as revoked_sessions,
       (select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and not c.relrowsecurity) as public_tables_without_rls;

\echo '1. credential tables WITHOUT row level security (must be 0 rows)'
select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p')
  and c.relname in ('admin_users','admin_invites','password_reset_tokens','audit_events','admin_mfa_credentials','admin_mfa_recovery_codes','admin_mfa_challenges','admin_revoked_sessions','office_runtime_settings','office_runtime_setting_history')
  and not c.relrowsecurity;

\echo '2. table-level privileges held by PUBLIC / anon / authenticated on those tables (must be 0 rows)'
select c.relname, case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee, a.privilege_type
  from pg_class c, lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
 where c.relnamespace='public'::regnamespace and c.relkind in ('r','p')
   and c.relname in ('admin_users','admin_invites','password_reset_tokens','audit_events','admin_mfa_credentials','admin_mfa_recovery_codes','admin_mfa_challenges','admin_revoked_sessions','office_runtime_settings','office_runtime_setting_history')
   and (a.grantee = 0 or a.grantee::regrole::text in ('anon','authenticated'));

\echo '3. column-level privileges for PUBLIC / anon / authenticated (must be 0 rows)'
select c.relname, att.attname, case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee, a.privilege_type
  from pg_class c join pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped and att.attacl is not null,
       lateral aclexplode(att.attacl) a
 where c.relnamespace='public'::regnamespace and c.relname in ('admin_users','admin_invites','password_reset_tokens','audit_events','admin_mfa_credentials','admin_mfa_recovery_codes','admin_mfa_challenges','admin_revoked_sessions')
   and (a.grantee = 0 or a.grantee::regrole::text in ('anon','authenticated'));

\echo '4. RLS policies on those tables (must be 0 rows: the intended state is deny-by-default with no policy)'
select schemaname, tablename, policyname, roles, cmd from pg_policies where schemaname='public'
  and tablename in ('admin_users','admin_invites','password_reset_tokens','audit_events','admin_mfa_credentials','admin_mfa_recovery_codes','admin_mfa_challenges','admin_revoked_sessions');

\echo '5a. views that read those tables (must be 0 rows unless reviewed)'
select v.schemaname, v.viewname from pg_views v where v.schemaname='public' and v.definition ~* '(admin_users|admin_invites|password_reset_tokens|audit_events|admin_mfa_)';
\echo '5b. functions in public executable by PUBLIC / anon / authenticated (review every row; office_* credential functions must NOT appear)'
select p.oid::regprocedure::text as fn, p.prosecdef as security_definer,
       has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_grant
  from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f'
   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));

\echo '6. default privileges that will re-grant new tables to Data API roles (informational: Supabase ships these; they explain why a new table is exposed until RLS is enabled)'
select pg_get_userbyid(d.defaclrole) as owner_role, d.defaclobjtype, d.defaclacl from pg_default_acl d;
