-- Read-only additive refund gate; run alongside customer-access gate after manifest step 15.
with expected(signature,digest) as (values ('hardware_refund_customer_status(uuid)','0cdee5f1774b9ebadc8ee3b0d76172769728923291dae5c55ee35d53f098b840'),('hardware_order_public_progress(text,text,uuid)','2c988ae0e1c4585490694a3c621c302a34abf52a28e19d9439ba1f3c5ca4d8bc'),('hardware_financial_list(text)','dfce4484129e241887ea40bc1a83044ffe045e9e22f6b40cc79c1e6494b83473'),('hardware_customer_event_email()','713a76f1db066b747415f5a55c449c0c86cfb93d3d03fa8f3a53ec9c5defe9a9')), checks as (
 select 'function:'||e.signature gate,coalesce(encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=e.digest
 and not p.prosecdef and p.proconfig=array['search_path=public, pg_temp'] and pg_get_userbyid(p.proowner)='postgres'
 and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
 and has_function_privilege('service_role',p.oid,'EXECUTE'),false) passed
 from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature)
 union all select 'financial_tables_private',count(*)=3 and bool_and(relrowsecurity
 and not has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 and not has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
 from pg_class where relnamespace='public'::regnamespace and relname in ('hardware_financial_observations','hardware_refund_requests','hardware_refund_decisions')
 union all select 'financial_history_immutable',count(*)=6 and bool_and(tgenabled='O') from pg_trigger
 where tgname in ('financial_immutable','financial_no_truncate')
) select gate,case when passed then 'PASS' else 'FAIL' end status from checks order by gate;
