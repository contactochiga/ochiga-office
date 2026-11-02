-- Read-only POST-integration supplemental gate. Does not replace Phase 0–5 gates.
with expected(signature, digest) as (values
('hardware_order_create(text,text,jsonb)','9247e4ac74b039451ebfc71160c6cc9be98749bf4113c9c4c0356bf3c5ee8c81'),
('hardware_checkout_quote(jsonb)','5d8a105f0fadfe153e5c1b2d06a659a272ef65707cc6e3cdd36bf0b0a9bc0ab1')
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
