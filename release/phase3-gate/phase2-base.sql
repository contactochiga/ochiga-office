-- Phase 2 stage 4 addition (db/20261105_catalogue_public_release.sql): NO new exception either (SECURITY INVOKER functions, B11 shape,
-- service_role keeps its rights).
--   * NEW B13 FAILS when installed public-release objects deviate from the reviewed design: public events / slug redirects not append-only
--     or truncatable; listings deletable or truncatable; preview grants changeable other than by revocation; service_role holding TRUNCATE
--     on any of them; a foreign key that is not ON DELETE RESTRICT; or, while the functions are installed, the slug-redirect check on
--     catalogue_products missing or disabled.
--   * NEW STAGE P2P reads ABSENT / APPLIED / ROLLED_BACK (tables, rows and guards kept; functions and the slug check removed) / PARTIAL.
--
-- Phase 2 (stage 3) revision of the READ-ONLY production rollout gate (= the Phase 1 revision, phase1/gate/production-rollout-gates.sql,
-- unchanged in every row, plus the product-gallery migration db/20261104_catalogue_media.sql). Media needs NO new exception: its functions
-- are SECURITY INVOKER (B5) with pinned search_path and EXECUTE service_role only (already enforced for every catalogue_% function by B11),
-- and service_role keeps SELECT/INSERT/UPDATE/DELETE on both new tables (B6).
--   * NEW B12 FAILS when installed media objects deviate from the reviewed design: the media guard trigger (only active -> removed, and
--     never while referenced) missing/disabled or not on catalogue_media_guard(); an append-only / no-truncate trigger missing or disabled
--     on the renditions table or the no-truncate trigger on catalogue_media; service_role holding TRUNCATE on either; a media foreign key
--     (to catalogue_products, office_files, catalogue_media) that is not ON DELETE RESTRICT; or, while the media functions are installed,
--     the version gallery check trigger on catalogue_product_versions missing or disabled.
--   * NEW STAGE P2M reads ABSENT / APPLIED / ROLLED_BACK (tables, rows and guards kept, functions + version check removed: the documented
--     rollback, GO-WITH-REVIEW) / PARTIAL.
--
-- Phase 1 revision of the READ-ONLY production rollout gate (= the Phase 0 revision, phase0/gate/production-rollout-gates.sql, unchanged in
-- every row, plus the product-catalogue migration db/20261102_catalogue_foundation.sql). The catalogue needs NO new exception: its
-- functions are SECURITY INVOKER (B5 unaffected) and service_role keeps SELECT/INSERT/UPDATE/DELETE on its tables (B6 unaffected).
--   * NEW B11 FAILS when installed catalogue objects deviate from the reviewed design: an append-only/no-truncate trigger missing or
--     disabled on a history table, service_role holding TRUNCATE on a history table, a catalogue function that is SECURITY DEFINER, lacks
--     the pinned search_path, or is executable by anyone but service_role (and its owner), or any function body referencing the internal
--     cost table catalogue_variant_costs.
--   * NEW STAGE P1 reads ABSENT / APPLIED / ROLLED_BACK (tables kept, functions removed: the documented rollback, GO-WITH-REVIEW) / PARTIAL.
--
-- Phase 0 revision of the S7 R11 READ-ONLY rollout gates (source: S7 branch scripts/sql/production-rollout-gates.sql @ 820346a, kept unchanged there).
-- Every R11 row is kept with its original meaning. The ONLY relaxations are two named exceptions for the reviewed intake-receipts migration
-- db/20261101_office_intake_receipts.sql (Office Phase 0, commit c613d04), and each applies only while that design is intact:
--   * B5 does not count the three reviewed SECURITY DEFINER functions office_intake_claim / _complete / _fail, identified by exact signature AND by a
--     fingerprint of their definition (result type, language, SECURITY DEFINER flag, volatility, settings incl. the pinned search_path, body), AND owned by
--     postgres, AND executable by service_role and nobody else (no PUBLIC, anon, authenticated or other grantee).
--   * B6 does not demand INSERT/UPDATE/DELETE from service_role on office_intake_receipts (writes go only through those functions), and only while
--     the table is in its reviewed restricted state (B10).
--   * NEW B10 FAILS when any receipts object deviates: table not owned by postgres, RLS off, any policy or trigger, any service_role table or column
--     write right, anything for PUBLIC/anon/authenticated/other roles, or a function whose fingerprint, owner or EXECUTE list differs.
--   * NEW STAGE P0 reads ABSENT / APPLIED / ROLLED_BACK (table kept, functions removed: the documented rollback, verdict GO-WITH-REVIEW) / PARTIAL (NO-GO).
-- Any other SECURITY DEFINER function or view still makes B5 REVIEW; any other table lacking service_role writes still makes B6 FAIL.
-- Changing the receipts functions requires a new review and new fingerprints here.
--
-- ---- original R11 header ----
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
p0_fn(sig, secdef, fp) as (values
  ('office_intake_receipts_version()', false, '51c59b7b78d9b5ab695a425d3ef578f5'),
  ('office_intake_claim(text,text,text,text,integer)', true, '72adbec673c7b96dc503d946b717f28a'),
  ('office_intake_complete(text,integer,uuid)', true, '085795fef451e6cd9d2ff207b841f9d4'),
  ('office_intake_fail(text,integer,uuid,text)', true, 'af596bdeeb5487077d0b81ff1eee4084')
),
p0_fn_state as (
  select f.sig, f.secdef as want_secdef, p.oid, p.oid is not null as present,
    coalesce(p.oid is not null
      and p.prosecdef = f.secdef
      and md5(concat_ws('|', pg_get_function_result(p.oid), l.lanname, p.prosecdef::text, p.provolatile::text, coalesce(array_to_string(p.proconfig, ';'), ''), p.prosrc)) = f.fp
      and (not f.secdef or p.proconfig = array['search_path=public, pg_temp'])
      and pg_get_userbyid(p.proowner) = 'postgres'
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
      and not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where a.grantee <> p.proowner and a.grantee <> (select oid from pg_roles where rolname = 'service_role')), false) as approved
  from p0_fn f
  left join pg_proc p on p.oid = to_regprocedure('public.' || f.sig)
  left join pg_language l on l.oid = p.prolang
),
p0_tbl as (
  select c.oid,
    (c.relkind = 'r' and pg_get_userbyid(c.relowner) = 'postgres' and c.relrowsecurity
     and not exists (select 1 from pg_policy pp where pp.polrelid = c.oid)
     and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal)
     and has_table_privilege('service_role', c.oid, 'SELECT')
     and not exists (select 1 from (values ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) v(p) where has_table_privilege('service_role', c.oid, v.p))
     and not has_any_column_privilege('service_role', c.oid, 'INSERT') and not has_any_column_privilege('service_role', c.oid, 'UPDATE') and not has_any_column_privilege('service_role', c.oid, 'REFERENCES')
     and not exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                      where a.grantee <> c.relowner and not (a.grantee = (select oid from pg_roles where rolname = 'service_role') and a.privilege_type = 'SELECT'))
     and not exists (select 1 from pg_attribute att where att.attrelid = c.oid and att.attnum > 0 and att.attacl is not null)) as approved
  from pg_class c where c.oid = to_regclass('public.office_intake_receipts')
),
p0_status as (
  select
    case when not exists (select 1 from p0_tbl) and not exists (select 1 from p0_fn_state where present) then 'ABSENT'
         when exists (select 1 from p0_tbl) and (select bool_and(present) from p0_fn_state) then 'APPLIED'
         when exists (select 1 from p0_tbl) and not exists (select 1 from p0_fn_state where present) then 'ROLLED_BACK'
         else 'PARTIAL' end as status,
    coalesce((select bool_and(approved) from p0_tbl), true) and coalesce((select bool_and(approved) from p0_fn_state where present), true) as all_present_approved,
    (select string_agg(sig, ', ' order by sig) from p0_fn_state where present and not approved) as bad_fns,
    (select not approved from p0_tbl) as bad_tbl,
    (select string_agg(sig, ', ' order by sig) from p0_fn_state where not present) as missing_fns
),
p1_tables(name, history) as (values
  ('office_suppliers', false), ('catalogue_categories', false), ('catalogue_brands', false), ('catalogue_products', false),
  ('catalogue_product_versions', true), ('catalogue_reviews', true), ('catalogue_publication_events', true), ('catalogue_variants', false),
  ('catalogue_price_changes', true), ('catalogue_price_decisions', true), ('catalogue_inventory_changes', true), ('catalogue_variant_costs', true)
),
p1_functions(sig) as (values
  ('catalogue_refuse_change()'), ('catalogue_schema_version()'), ('catalogue_state_changed(uuid)'), ('catalogue_register_variants(uuid,jsonb)'),
  ('catalogue_create_product(text,uuid,uuid,jsonb,text)'), ('catalogue_save_version(uuid,integer,text,uuid,uuid,jsonb,text,text)'),
  ('catalogue_transition(uuid,integer,text,text,text,text)'), ('catalogue_request_price_change(uuid,bigint,text,integer,text,text)'),
  ('catalogue_decide_price_change(uuid,text,text,text)'), ('catalogue_publish_price_change(uuid,text)'), ('catalogue_update_inventory(uuid,integer,jsonb,text,text)')
),
p1_state as (
  select
    (select count(*) from p1_tables t where to_regclass('public.' || t.name) is not null) as tables_present,
    (select count(*) from p1_tables) as tables_total,
    (select count(*) from p1_functions f where to_regprocedure('public.' || f.sig) is not null) as functions_present,
    (select count(*) from p1_functions) as functions_total,
    to_regprocedure('public.catalogue_refuse_change()') is not null as guard_present
),
p1_problems as (
  -- history tables: both triggers present, enabled, on the guard function; no TRUNCATE for service_role
  select 'history ' || t.name || ': append-only/no-truncate trigger missing or disabled' as problem
    from p1_tables t where t.history and to_regclass('public.' || t.name) is not null
     and (select count(*) from pg_trigger g where g.tgrelid = to_regclass('public.' || t.name) and not g.tgisinternal and g.tgenabled <> 'D'
            and g.tgfoid = to_regprocedure('public.catalogue_refuse_change()') and g.tgname in (t.name || '_append_only', t.name || '_no_truncate')) <> 2
  union all
  select 'history ' || t.name || ': service_role holds TRUNCATE'
    from p1_tables t where t.history and to_regclass('public.' || t.name) is not null and has_table_privilege('service_role', to_regclass('public.' || t.name), 'TRUNCATE')
  union all
  -- every catalogue function present: invoker, pinned search_path, EXECUTE service_role (+ owner) only
  select 'function ' || p.oid::regprocedure::text || ': not the reviewed security shape'
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'catalogue\_%'
     and (p.prosecdef or p.proconfig is distinct from array['search_path=public, pg_temp']
          or not has_function_privilege('service_role', p.oid, 'EXECUTE')
          or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where a.grantee <> p.proowner and a.grantee <> (select oid from pg_roles where rolname = 'service_role')))
  union all
  select 'function ' || p.oid::regprocedure::text || ': references the internal cost table'
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ilike '%catalogue_variant_costs%'
),
p2m_tables(name) as (values ('catalogue_media'), ('catalogue_media_derivatives')),
p2m_functions(sig) as (values
  ('catalogue_version_media_check()'), ('catalogue_media_schema_version()'),
  ('catalogue_register_media(uuid,text,text,text,integer,integer,integer,text,jsonb,text)'), ('catalogue_remove_media(uuid,text)')
),
p2m_state as (
  select
    (select count(*) from p2m_tables t where to_regclass('public.' || t.name) is not null) as tables_present,
    (select count(*) from p2m_tables) as tables_total,
    (select count(*) from p2m_functions f where to_regprocedure('public.' || f.sig) is not null) as functions_present,
    (select count(*) from p2m_functions) as functions_total,
    to_regprocedure('public.catalogue_media_guard()') is not null as guard_present,
    exists (select 1 from pg_trigger g where g.tgname = 'catalogue_product_versions_media_check' and g.tgrelid = to_regclass('public.catalogue_product_versions') and not g.tgisinternal) as version_check_present
),
p2m_problems as (
  select 'catalogue_media: guard trigger (active -> removed only, never while referenced) missing, disabled or not on catalogue_media_guard()' as problem
   where to_regclass('public.catalogue_media') is not null
     and not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.catalogue_media') and g.tgname = 'catalogue_media_guarded' and not g.tgisinternal and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure('public.catalogue_media_guard()') and (g.tgtype & 1) = 1 and (g.tgtype & 2) = 2 and (g.tgtype & 8) = 8 and (g.tgtype & 16) = 16)
  union all
  select 'catalogue_media: no-truncate trigger missing or disabled'
   where to_regclass('public.catalogue_media') is not null
     and not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.catalogue_media') and g.tgname = 'catalogue_media_no_truncate' and not g.tgisinternal and g.tgenabled <> 'D' and g.tgfoid = to_regprocedure('public.catalogue_refuse_change()'))
  union all
  select 'catalogue_media_derivatives: append-only/no-truncate trigger missing or disabled'
   where to_regclass('public.catalogue_media_derivatives') is not null
     and (select count(*) from pg_trigger g where g.tgrelid = to_regclass('public.catalogue_media_derivatives') and not g.tgisinternal and g.tgenabled <> 'D'
            and g.tgfoid = to_regprocedure('public.catalogue_refuse_change()') and g.tgname in ('catalogue_media_derivatives_append_only', 'catalogue_media_derivatives_no_truncate')) <> 2
  union all
  select t.name || ': service_role holds TRUNCATE'
    from p2m_tables t where to_regclass('public.' || t.name) is not null and has_table_privilege('service_role', to_regclass('public.' || t.name), 'TRUNCATE')
  union all
  select t.name || ': a foreign key is not ON DELETE RESTRICT (' || pg_get_constraintdef(c.oid) || ')'
    from p2m_tables t join pg_constraint c on c.conrelid = to_regclass('public.' || t.name) and c.contype = 'f'
   where c.confdeltype <> 'r'
  union all
  select t.name || ': expected foreign keys missing'
    from p2m_tables t where to_regclass('public.' || t.name) is not null
     and (select count(*) from pg_constraint c where c.conrelid = to_regclass('public.' || t.name) and c.contype = 'f' and c.confdeltype = 'r') <> 2
  union all
  select 'catalogue_product_versions: gallery check trigger missing or disabled while the media functions are installed'
   where to_regprocedure('public.catalogue_version_media_check()') is not null
     and not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.catalogue_product_versions') and g.tgname = 'catalogue_product_versions_media_check' and not g.tgisinternal
                       and g.tgenabled <> 'D' and g.tgfoid = to_regprocedure('public.catalogue_version_media_check()'))
),
p2p_tables(name) as (values ('catalogue_public_listings'), ('catalogue_public_events'), ('catalogue_slug_redirects'), ('catalogue_preview_grants')),
p2p_functions(sig) as (values
  ('catalogue_slug_redirect_check()'), ('catalogue_public_schema_version()'), ('catalogue_public_requirements(uuid)'), ('catalogue_public_release(uuid,integer,integer,text)'),
  ('catalogue_public_withdraw(uuid,integer,text,text)'), ('catalogue_change_slug(uuid,integer,text,text)'), ('catalogue_public_request_refresh(uuid)'),
  ('catalogue_public_record_refresh(uuid,integer,text,text)'), ('catalogue_create_preview_grant(uuid,text,integer)'), ('catalogue_revoke_preview_grants(uuid,text)')
),
p2p_state as (
  select
    (select count(*) from p2p_tables t where to_regclass('public.' || t.name) is not null) as tables_present,
    (select count(*) from p2p_tables) as tables_total,
    (select count(*) from p2p_functions f where to_regprocedure('public.' || f.sig) is not null) as functions_present,
    (select count(*) from p2p_functions) as functions_total,
    to_regprocedure('public.catalogue_public_listing_guard()') is not null and to_regprocedure('public.catalogue_preview_grant_guard()') is not null as guards_present,
    exists (select 1 from pg_trigger g where g.tgname = 'catalogue_products_slug_redirect_check' and g.tgrelid = to_regclass('public.catalogue_products') and not g.tgisinternal) as slug_check_present
),
p2p_trigger(tbl, tgname, fn, row_level, ev_update, ev_delete, ev_truncate) as (values
  ('catalogue_public_events', 'catalogue_public_events_append_only', 'catalogue_refuse_change()', true, true, true, false),
  ('catalogue_public_events', 'catalogue_public_events_no_truncate', 'catalogue_refuse_change()', false, false, false, true),
  ('catalogue_slug_redirects', 'catalogue_slug_redirects_append_only', 'catalogue_refuse_change()', true, true, true, false),
  ('catalogue_slug_redirects', 'catalogue_slug_redirects_no_truncate', 'catalogue_refuse_change()', false, false, false, true),
  ('catalogue_public_listings', 'catalogue_public_listings_no_delete', 'catalogue_public_listing_guard()', true, false, true, false),
  ('catalogue_public_listings', 'catalogue_public_listings_no_truncate', 'catalogue_refuse_change()', false, false, false, true),
  ('catalogue_preview_grants', 'catalogue_preview_grants_guarded', 'catalogue_preview_grant_guard()', true, true, true, false),
  ('catalogue_preview_grants', 'catalogue_preview_grants_no_truncate', 'catalogue_refuse_change()', false, false, false, true)
),
p2p_problems as (
  select x.tbl || ': trigger ' || x.tgname || ' missing, disabled or changed' as problem
    from p2p_trigger x where to_regclass('public.' || x.tbl) is not null
     and not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || x.tbl) and g.tgname = x.tgname and not g.tgisinternal and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure('public.' || x.fn) and ((g.tgtype & 1) = 1) = x.row_level and ((g.tgtype & 16) = 16) = x.ev_update
                       and ((g.tgtype & 8) = 8) = x.ev_delete and ((g.tgtype & 32) = 32) = x.ev_truncate)
  union all
  select t.name || ': service_role holds TRUNCATE'
    from p2p_tables t where to_regclass('public.' || t.name) is not null and has_table_privilege('service_role', to_regclass('public.' || t.name), 'TRUNCATE')
  union all
  select t.name || ': a foreign key is not ON DELETE RESTRICT (' || pg_get_constraintdef(c.oid) || ')'
    from p2p_tables t join pg_constraint c on c.conrelid = to_regclass('public.' || t.name) and c.contype = 'f' where c.confdeltype <> 'r'
  union all
  select t.name || ': expected foreign key missing'
    from p2p_tables t where to_regclass('public.' || t.name) is not null
     and (select count(*) from pg_constraint c where c.conrelid = to_regclass('public.' || t.name) and c.contype = 'f' and c.confdeltype = 'r') <> 1
  union all
  select 'catalogue_products: slug-redirect check missing or disabled while the public-release functions are installed'
   where to_regprocedure('public.catalogue_public_release(uuid,integer,integer,text)') is not null
     and not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.catalogue_products') and g.tgname = 'catalogue_products_slug_redirect_check' and not g.tgisinternal
                       and g.tgenabled <> 'D' and g.tgfoid = to_regprocedure('public.catalogue_slug_redirect_check()'))
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
  union all select 'B5 no SECURITY DEFINER function and no view in public (nothing runs with the owner''s rights on a caller''s behalf) -- except the three reviewed intake-receipt functions while B10 holds for them',
         case when n = 0 then 'PASS' else 'REVIEW' end, n || ' object(s)' from (
           select (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
                     and p.oid not in (select s.oid from p0_fn_state s where s.approved and s.want_secdef)) + (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')) as n) x
  union all select 'B6 service_role keeps the rights the application uses on every public table (20261027 intentionally withholds UPDATE/DELETE on the append-only settings history and DELETE on MFA credentials; office_intake_receipts is SELECT-only by design while B10 holds)',
         case when n = 0 then 'PASS' else 'FAIL' end, n || ' table(s) lacking a right' from (
           select count(*) n from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
              and c.oid not in (select t.oid from p0_tbl t where t.approved and has_table_privilege('service_role', t.oid, 'SELECT'))
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
  union all select 'B10 intake receipts (20261101): reviewed restricted design intact (table RLS on, no policy/trigger, service_role SELECT only, no column grants; functions match reviewed fingerprints, owner postgres, EXECUTE service_role only)',
         case when s.all_present_approved then 'PASS' else 'FAIL' end,
         case when s.status = 'ABSENT' then 'not installed'
              when s.all_present_approved then 'intact (' || lower(s.status) || ')'
              else 'deviates: ' || concat_ws('; ', case when s.bad_tbl then 'table office_intake_receipts' end, case when s.bad_fns is not null then 'functions ' || s.bad_fns end) end
  from p0_status s
  union all select 'B11 product catalogue (20261102): reviewed design intact (history append-only + no truncate, SECURITY INVOKER functions with pinned search_path, EXECUTE service_role only, no function touches costs)',
         case when (select count(*) from p1_problems) = 0 then 'PASS' else 'FAIL' end,
         case when (select tables_present from p1_state) = 0 and (select functions_present from p1_state) = 0 then 'not installed'
              when (select count(*) from p1_problems) = 0 then 'intact'
              else 'deviates: ' || (select string_agg(problem, '; ' order by problem) from p1_problems) end
  union all select 'B12 product gallery media (20261104): reviewed design intact (media immutable except unreferenced removal, renditions append-only, no truncate, ON DELETE RESTRICT to products/office_files, version gallery check installed with the functions)',
         case when (select count(*) from p2m_problems) = 0 then 'PASS' else 'FAIL' end,
         case when (select tables_present from p2m_state) = 0 and (select functions_present from p2m_state) = 0 then 'not installed'
              when (select count(*) from p2m_problems) = 0 then 'intact'
              else 'deviates: ' || (select string_agg(problem, '; ' order by problem) from p2m_problems) end
  union all select 'B13 public release (20261105): reviewed design intact (events and redirects append-only, listings undeletable, preview grants revocable only, no truncate, ON DELETE RESTRICT, slug-redirect check installed with the functions)',
         case when (select count(*) from p2p_problems) = 0 then 'PASS' else 'FAIL' end,
         case when (select tables_present from p2p_state) = 0 and (select functions_present from p2p_state) = 0 then 'not installed'
              when (select count(*) from p2p_problems) = 0 then 'intact'
              else 'deviates: ' || (select string_agg(problem, '; ' order by problem) from p2p_problems) end
),
stage_rows as (
  select 'STAGE ' || s.stage || ' (' || case s.stage when 'S1' then '20261019 + 20261020 + 20261021' when 'S2' then '20261026' when 'S3' then '20261028' when 'S4' then '20261022-20261025 + 20261029-20261031' end || ')' as gate,
         s.status, case when s.status = 'APPLIED' then s.present || ' of ' || s.objects || ' objects present' else s.present || ' of ' || s.objects || ' present; missing: ' || s.missing end as detail
  from stage_status s
  union all select 'STAGE S5 (20261027 service_role narrowing on credential/history tables)',
         case when not bool_or(exists_) then 'NOT_APPLICABLE' when bool_and(narrowed) filter (where exists_) then 'APPLIED' when not bool_or(narrowed) filter (where exists_) then 'ABSENT' else 'PARTIAL' end,
         coalesce(string_agg(tbl || case when narrowed then ':narrowed' else ':BROAD' end, ', ' order by tbl) filter (where exists_), 'none of its tables exist yet')
  from narrow
  union all select 'STAGE P0 (20261101 office intake receipts)', s.status,
         case s.status when 'ABSENT' then 'table and 4 functions absent' when 'APPLIED' then 'table + 4 functions present'
              when 'ROLLED_BACK' then 'table kept, functions removed (documented rollback: Office falls back; review crm_failed rows)'
              else 'PARTIAL: missing ' || coalesce(s.missing_fns, case when s.bad_tbl is null then 'table office_intake_receipts' end, '?') end
  from p0_status s
  union all select 'STAGE P1 (20261102 product catalogue)',
         case when s.tables_present = 0 and s.functions_present = 0 then 'ABSENT'
              when s.tables_present = s.tables_total and s.functions_present = s.functions_total then 'APPLIED'
              when s.tables_present = s.tables_total and s.functions_present = 1 and s.guard_present then 'ROLLED_BACK'
              else 'PARTIAL' end,
         s.tables_present || ' of ' || s.tables_total || ' tables, ' || s.functions_present || ' of ' || s.functions_total || ' functions'
  from p1_state s
  union all select 'STAGE P2M (20261104 product gallery media)',
         case when s.tables_present = 0 and s.functions_present = 0 and not s.guard_present then 'ABSENT'
              when s.tables_present = s.tables_total and s.functions_present = s.functions_total and s.guard_present and s.version_check_present then 'APPLIED'
              when s.tables_present = s.tables_total and s.functions_present = 0 and s.guard_present and not s.version_check_present then 'ROLLED_BACK'
              else 'PARTIAL' end,
         s.tables_present || ' of ' || s.tables_total || ' tables, ' || s.functions_present || ' of ' || s.functions_total || ' functions, guard ' || case when s.guard_present then 'present' else 'absent' end
           || ', version check ' || case when s.version_check_present then 'present' else 'absent' end
  from p2m_state s
  union all select 'STAGE P2P (20261105 public release, slugs, previews)',
         case when s.tables_present = 0 and s.functions_present = 0 and not s.guards_present then 'ABSENT'
              when s.tables_present = s.tables_total and s.functions_present = s.functions_total and s.guards_present and s.slug_check_present then 'APPLIED'
              when s.tables_present = s.tables_total and s.functions_present = 0 and s.guards_present and not s.slug_check_present then 'ROLLED_BACK'
              else 'PARTIAL' end,
         s.tables_present || ' of ' || s.tables_total || ' tables, ' || s.functions_present || ' of ' || s.functions_total || ' functions, guards ' || case when s.guards_present then 'present' else 'absent' end
           || ', slug check ' || case when s.slug_check_present then 'present' else 'absent' end
  from p2p_state s
),
orders as (
  select 'ORDER S2 needs S1 (admin_users.session_generation)' as gate,
         case when (select status from stage_status where stage = 'S2') <> 'ABSENT' and (select status from stage_status where stage = 'S1') <> 'APPLIED' then 'FAIL' else 'PASS' end as status, '' as detail
  union all select 'ORDER S4 needs S1 (session generation) before any MFA object',
         case when (select status from stage_status where stage = 'S4') <> 'ABSENT' and (select status from stage_status where stage = 'S1') <> 'APPLIED' then 'FAIL' else 'PASS' end, ''
  union all select 'ORDER P2M needs P1 (20261104 requires the 20261102 catalogue)',
         case when (select tables_present from p2m_state) > 0 and (select tables_present from p1_state) < (select tables_total from p1_state) then 'FAIL' else 'PASS' end, ''
  union all select 'ORDER P2P needs P2M (20261105 requires 20261104)',
         case when (select tables_present from p2p_state) > 0 and (select tables_present from p2m_state) < (select tables_total from p2m_state) then 'FAIL' else 'PASS' end, ''
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
              when exists (select 1 from all_rows where (o = 1 and status = 'REVIEW') or (o = 2 and status = 'ROLLED_BACK') or (o = 3 and status = 'PENDING')) then 'GO-WITH-REVIEW' else 'GO' end,
         (select count(*) from all_rows where o = 1 and status = 'PASS') || ' of ' || (select count(*) from all_rows where o = 1) || ' baseline rows PASS'
) z order by o, gate;
