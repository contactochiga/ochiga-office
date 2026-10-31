-- Read-only staff-delivery-first additive gate. Run alongside security-gate.sql and Phase 0–5 gates.
with expected(signature, digest) as (values
('hardware_checkout_payment_readiness(text,text,uuid)','cfcb99199a46ea5743fcb052b6f09a4c5af23fa966c89c8e3c75a573dc3f28fc'),
('hardware_checkout_prepare_payment(text,text,uuid,bigint)','0f0dde4faacd64fd1d3c9f54608bd6affa960b3b0be381b5ede9894b51e092f3')
), checks as (
 select 'function:'||e.signature as gate,
   coalesce(encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=e.digest
   and not p.prosecdef and p.proconfig=array['search_path=public, pg_temp']
   and pg_get_userbyid(p.proowner)='postgres'
   and not has_function_privilege('anon',p.oid,'execute')
   and not has_function_privilege('authenticated',p.oid,'execute')
   and has_function_privilege('service_role',p.oid,'execute'),false) as passed
 from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature)
 union all
 select 'hardware_tables_private', count(*)>0 and bool_and(c.relrowsecurity
   and not has_table_privilege('anon',c.oid,'select,insert,update,delete,truncate')
   and not has_table_privilege('authenticated',c.oid,'select,insert,update,delete,truncate'))
 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r' and c.relname like 'hardware_%'
)
select gate, case when passed then 'PASS' else 'FAIL' end as status from checks order by gate;
