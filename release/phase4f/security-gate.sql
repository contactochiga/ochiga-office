with quote_fn as (
  select p.* from pg_proc p
  where p.oid='public.hardware_payment_quote(text,text,uuid)'::regprocedure
), prior_fn as (
  select p.* from pg_proc p
  where p.oid='public.hardware_financial_phase4e_quote(text,text,uuid)'::regprocedure
)
select case when
  (select pg_get_userbyid(proowner)='postgres' and not prosecdef
      and md5(pg_get_functiondef(oid))='2b1b4185d152b0398045f82178aab557'
      and proconfig @> array['search_path=public, pg_temp']
      and not has_function_privilege('anon',oid,'execute')
      and not has_function_privilege('authenticated',oid,'execute')
      and not exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')
      and has_function_privilege('service_role',oid,'execute')
      and pg_get_functiondef(oid) like '%hardware_financial_phase4e_quote%'
      and pg_get_functiondef(oid) like '%eligibility_code%'
   from quote_fn)
  and (select pg_get_userbyid(proowner)='postgres' and not prosecdef
      and md5(pg_get_functiondef(oid))='a052233e2f685aa97239257c3cd5fc7d'
      and proconfig @> array['search_path=public, pg_temp']
      and not has_function_privilege('anon',oid,'execute')
      and not has_function_privilege('authenticated',oid,'execute')
      and not exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')
      and has_function_privilege('service_role',oid,'execute')
      and pg_get_functiondef(oid) like '%hardware_financial_previous_quote%'
      and pg_get_functiondef(oid) like '%refund_state%'
   from prior_fn)
then 'PASS' else 'FAIL' end as phase4f_quote_security_gate;
