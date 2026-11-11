-- Read-only gate for manifest step 16 (20261104090000_hardware_refund_lock_compat.sql). Run after step 16; every row must say PASS.
-- Refund request/approval must serialize with an advisory lock (no row lock on immutable evidence), keep their security shape, and the
-- immutable financial tables must still deny service_role UPDATE/DELETE.
with checks(gate,passed) as (
 select 'function:'||p.oid::regprocedure::text,
        p.prosrc ilike '%pg_advisory_xact_lock(hashtextextended(''hardware_refund:''%' and p.prosrc !~* 'for (update|share|no key update|key share)'
        and not p.prosecdef and p.proconfig=array['search_path=public, pg_temp']
        and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE') and has_function_privilege('service_role',p.oid,'EXECUTE')
 from pg_proc p where p.oid in (to_regprocedure('hardware_refund_request(text,uuid,text)'),to_regprocedure('hardware_refund_approve(text,uuid)'))
 union all select 'both_refund_functions_present',count(*)=2 from pg_proc where oid in (to_regprocedure('hardware_refund_request(text,uuid,text)'),to_regprocedure('hardware_refund_approve(text,uuid)'))
 union all select 'immutable_evidence_not_writable_by_service_role',bool_and(not has_table_privilege('service_role',t,'UPDATE') and not has_table_privilege('service_role',t,'DELETE'))
 from unnest(array['hardware_payment_confirmations','hardware_refund_requests','hardware_refund_decisions','hardware_financial_observations','hardware_payment_history']) t
) select gate,case when passed then 'PASS' else 'FAIL' end status from checks order by gate;
