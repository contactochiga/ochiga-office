-- S7 R11: READ-ONLY rollout gates for the Office production database (Supabase project "Ochiga marketing and sales agent").
-- One statement, pg_catalog / information_schema metadata only: it never selects a row, hash, token or personal record from any application table, and it changes nothing.
-- Run it in the Supabase SQL editor (or `supabase db query --linked -f`) BEFORE and AFTER each rollout stage and keep the output with the change record.
--
--   BASELINE rows must read PASS at every moment (they describe the protections production has today and must keep).
--   STAGE rows read ABSENT (nothing of that stage exists), APPLIED (everything exists) or PARTIAL (some objects exist: STOP, a stage was interrupted or applied by hand).
--   ORDER rows read PASS unless a later stage exists without the earlier stage it needs.
--   FOLLOW-UP reads PENDING while a credential/history table created by an earlier stage still carries broad service_role rights (run 20261027).
--   The last row, VERDICT, reads GO only when every BASELINE row is PASS, no stage is PARTIAL, no ORDER row failed and nothing is PENDING (GO-WITH-REVIEW otherwise; NO-GO on any FAIL/PARTIAL).
-- Stages (see docs/settings-domain/54_S7_R11_PRODUCTION_DB_RECONCILIATION.md):
--   S1 = 20261019 + 20261020 + 20261021   S2 = 20261026   S3 = 20261028   S4 = 20261022-20261025 + 20261029-20261031   S5 = 20261027 (after S1 and, when present, S4)
with
objs(stage, kind, name) as (values
  ('S1','col','admin_users.session_generation'), ('S1','col','admin_users.sessions_revoked_at'), ('S1','col','admin_users.sessions_revoked_by'),
  ('S1','col','office_runtime_settings.version'), ('S1','table','office_runtime_setting_history'),
  ('S1','fn','office_runtime_setting_write'), ('S1','fn','office_runtime_setting_record_attempt'), ('S1','fn','office_runtime_setting_history_immutable'),
  ('S1','fn','office_revoke_admin_sessions'), ('S1','fn','office_admin_update_revoking_sessions'), ('S1','trigger','office_runtime_setting_history_no_change'),
  ('S2','table','admin_revoked_sessions'), ('S2','fn','office_revoke_session'), ('S2','fn','office_is_session_revoked'), ('S2','fn','office_session_revocation_version'),
  ('S3','table','admin_rate_limits'), ('S3','fn','office_rate_limit_hit'), ('S3','fn','office_rate_limit_peek'), ('S3','fn','office_rate_limit_reset'), ('S3','fn','office_rate_limit_version'),
  ('S4','table','admin_mfa_credentials'), ('S4','table','admin_mfa_recovery_codes'), ('S4','table','admin_mfa_challenges'), ('S4','table','admin_mfa_mailbox_attempts'),
  ('S4','col','admin_users.mfa_active_count'), ('S4','col','admin_users.mfa_failed_attempts'), ('S4','col','admin_users.mfa_locked_until'), ('S4','col','admin_users.mfa_required_after'),
  ('S4','col','admin_users.mfa_reset_at'), ('S4','col','admin_users.mfa_reset_by'), ('S4','col','admin_mfa_recovery_codes.key_id'), ('S4','trigger','admin_mfa_credentials_active_count'),
  ('S4','fn','office_mfa_schema_version'), ('S4','fn','office_mfa_management_version'), ('S4','fn','office_mfa_webauthn_version'), ('S4','fn','office_mfa_evidence_version'), ('S4','fn','office_mfa_mailbox_version'),
  ('S4','fn','office_mfa_consume_totp_step'), ('S4','fn','office_mfa_consume_recovery_code'), ('S4','fn','office_mfa_consume_recovery_code_revoking'), ('S4','fn','office_mfa_replace_recovery_codes'),
  ('S4','fn','office_mfa_create_challenge'), ('S4','fn','office_mfa_consume_challenge'), ('S4','fn','office_mfa_record_failure'), ('S4','fn','office_mfa_clear_failures'), ('S4','fn','office_mfa_reset'),
  ('S4','fn','office_mfa_prune_challenges'), ('S4','fn','office_mfa_activate_credential'), ('S4','fn','office_mfa_revoke_credential'), ('S4','fn','office_mfa_webauthn_record_use'),
  ('S4','fn','office_mfa_active_count_trigger'), ('S4','fn','office_mfa_sync_active_count'), ('S4','fn','office_mfa_mailbox_attempt')
),
present as (
  select stage, kind, name,
    case kind
      when 'col'     then exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name || '.' || c.column_name = name)
      when 'table'   then to_regclass('public.' || name) is not null
      when 'fn'      then exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = name)
      when 'trigger' then exists (select 1 from pg_trigger t where t.tgname = name and not t.tgisinternal)
    end as ok
  from objs
),
stage_status as (
  select stage,
    case when bool_and(ok) then 'APPLIED' when not bool_or(ok) then 'ABSENT' else 'PARTIAL' end as status,
    coalesce(string_agg(kind || ':' || name, ', ' order by kind, name) filter (where not ok), '') as missing,
    count(*) as objects, count(*) filter (where ok) as present
  from present group by stage
),
-- 20261027: what it narrows on the tables other stages create (service_role must not be able to truncate or delete the credential/history evidence)
narrow as (
  select t.tbl, to_regclass('public.' || t.tbl) is not null as exists_,
    case when to_regclass('public.' || t.tbl) is null then null
         else not exists (select 1 from unnest(t.privs) p where has_table_privilege('service_role', ('public.' || t.tbl)::regclass, p)) end as narrowed
  from (values ('admin_mfa_credentials', array['DELETE','TRUNCATE','REFERENCES','TRIGGER']), ('admin_mfa_recovery_codes', array['TRUNCATE','REFERENCES','TRIGGER']),
               ('admin_mfa_challenges', array['TRUNCATE','REFERENCES','TRIGGER']), ('office_runtime_setting_history', array['TRUNCATE','DELETE','UPDATE','REFERENCES','TRIGGER'])) as t(tbl, privs)
),
baseline as (
  select 'B1 schema public is closed to the Data API roles (no USAGE for anon/authenticated)' as gate,
         case when not has_schema_privilege('anon','public','USAGE') and not has_schema_privilege('authenticated','public','USAGE') then 'PASS' else 'FAIL' end as status, '' as detail
  union all select 'B2 row level security on every public table',
         case when n = 0 then 'PASS' else 'FAIL' end, n || ' table(s) without RLS' from (select count(*) n from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','p') and not relrowsecurity) x
  union all select 'B3 anon/authenticated hold no privilege on any public relation, column or sequence',
         case when n = 0 then 'PASS' else 'FAIL' end, n || ' grant(s)' from (
           select count(*) n from pg_class c, (values ('anon'),('authenticated')) r(r), (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(p)
            where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f') and has_table_privilege(r.r, c.oid, p.p)) a
  union all select 'B3b …and no column-level or sequence privilege',
         case when n = 0 then 'PASS' else 'FAIL' end, n || ' grant(s)' from (
           select (select count(*) from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped, (values ('anon'),('authenticated')) r(r)
                    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f') and (has_column_privilege(r.r, c.oid, a.attnum, 'SELECT') or has_column_privilege(r.r, c.oid, a.attnum, 'INSERT') or has_column_privilege(r.r, c.oid, a.attnum, 'UPDATE')))
                + (select count(*) from pg_class c, (values ('anon'),('authenticated')) r(r) where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and (has_sequence_privilege(r.r, c.oid, 'USAGE') or has_sequence_privilege(r.r, c.oid, 'SELECT'))) as n) y
  union all select 'B4 no public function is executable by anon/authenticated',
         case when n = 0 then 'PASS' else 'FAIL' end, n || ' function(s)' from (select count(*) n from pg_proc p where p.pronamespace = 'public'::regnamespace and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))) x
  union all select 'B5 no SECURITY DEFINER function and no view in public (nothing runs with the owner''s rights on a caller''s behalf)',
         case when n = 0 then 'PASS' else 'REVIEW' end, n || ' object(s)' from (
           select (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef) + (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')) as n) x
  union all select 'B6 service_role keeps the rights the application uses on every public table (20261027 intentionally withholds UPDATE/DELETE on the append-only settings history and DELETE on MFA credentials)',
         case when n = 0 then 'PASS' else 'FAIL' end, n || ' table(s) lacking a right' from (
           select count(*) n from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
              and (not (has_table_privilege('service_role', c.oid, 'SELECT') and has_table_privilege('service_role', c.oid, 'INSERT'))
                   or (c.relname <> 'office_runtime_setting_history' and not has_table_privilege('service_role', c.oid, 'UPDATE'))
                   or (c.relname not in ('office_runtime_setting_history', 'admin_mfa_credentials') and not has_table_privilege('service_role', c.oid, 'DELETE')))) x
  union all select 'B7 no row level security policy in public (deny by default stays deny by default)',
         case when n = 0 then 'PASS' else 'REVIEW' end, n || ' policy(ies)' from (select count(*) n from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'public'::regnamespace) x
  union all select 'B8 PUBLIC holds nothing on any public relation',
         case when n = 0 then 'PASS' else 'FAIL' end, n || ' relation(s)' from (select count(*) n from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f','S') and exists (select 1 from aclexplode(c.relacl) a where a.grantee = 0)) x
  union all select 'B9 the four credential tables and the settings table: RLS on and no privilege for anon/authenticated/PUBLIC',
         case when n = 0 then 'PASS' else 'FAIL' end, n || ' problem(s)' from (
           select count(*) n from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('admin_users','admin_invites','password_reset_tokens','audit_events','office_runtime_settings')
              and (not c.relrowsecurity or has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT') or exists (select 1 from aclexplode(c.relacl) a where a.grantee = 0))) x
),
stage_rows as (
  select 'STAGE ' || s.stage || ' (' || case s.stage when 'S1' then '20261019 + 20261020 + 20261021' when 'S2' then '20261026' when 'S3' then '20261028' when 'S4' then '20261022-20261025 + 20261029-20261031' end || ')' as gate,
         s.status, case when s.status = 'APPLIED' then s.present || ' of ' || s.objects || ' objects present' else s.present || ' of ' || s.objects || ' present; missing: ' || s.missing end as detail
  from stage_status s
  union all select 'STAGE S5 (20261027 service_role narrowing on credential/history tables)',
         case when not bool_or(exists_) then 'NOT_APPLICABLE' when bool_and(narrowed) filter (where exists_) then 'APPLIED' when not bool_or(narrowed) filter (where exists_) then 'ABSENT' else 'PARTIAL' end,
         coalesce(string_agg(tbl || case when narrowed then ':narrowed' else ':BROAD' end, ', ' order by tbl) filter (where exists_), 'none of its tables exist yet')
  from narrow
),
orders as (
  select 'ORDER S2 needs S1 (admin_users.session_generation)' as gate,
         case when (select status from stage_status where stage = 'S2') <> 'ABSENT' and (select status from stage_status where stage = 'S1') <> 'APPLIED' then 'FAIL' else 'PASS' end as status, '' as detail
  union all select 'ORDER S4 needs S1 (session generation) before any MFA object',
         case when (select status from stage_status where stage = 'S4') <> 'ABSENT' and (select status from stage_status where stage = 'S1') <> 'APPLIED' then 'FAIL' else 'PASS' end, ''
  union all select 'FOLLOW-UP S5: every credential/history table created by an earlier stage is narrowed for service_role',
         case when exists (select 1 from narrow where exists_ and not narrowed) then 'PENDING' else 'PASS' end, 'run 20261027 after S1 and again after S4; re-run it after any later table it covers'
),
all_rows as (
  select 1 as o, gate, status, detail from baseline
  union all select 2, gate, status, detail from stage_rows
  union all select 3, gate, status, detail from orders
)
select gate, status, detail from (
  select o, gate, status, detail from all_rows
  union all select 4, 'VERDICT (GO = every BASELINE row PASS, no stage PARTIAL, no ORDER failure, nothing pending)',
         case when exists (select 1 from all_rows where (o = 1 and status = 'FAIL') or (o = 2 and status = 'PARTIAL') or (o = 3 and status = 'FAIL')) then 'NO-GO'
              when exists (select 1 from all_rows where (o = 1 and status = 'REVIEW') or (o = 3 and status = 'PENDING')) then 'GO-WITH-REVIEW' else 'GO' end,
         (select count(*) from all_rows where o = 1 and status = 'PASS') || ' of ' || (select count(*) from all_rows where o = 1) || ' baseline rows PASS'
) z order by o, gate;
