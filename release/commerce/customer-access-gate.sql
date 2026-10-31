-- Read-only additive customer access gate; run alongside every accepted Phase 0–5 gate.
with expected(signature,digest) as (values
('hardware_customer_email_enqueue(uuid,text,text,jsonb)','2dffd37aeb4858fd03380898b042b82b360b183d8dc1fcc2f04881e17049a3ac'),
('hardware_customer_access_request(text,text,text,text,uuid,text)','46ed3c4a41b1e3123f54bcdbdf288d69de9319650e9086c0a1998382e046e822'),
('hardware_customer_access_verify(text,uuid,text,text)','2b083ed8879097256abab4052a886821098c8b482cca48f3d8a83fb1948a8cfc'),
('hardware_customer_access_owner(text,uuid,text)','6ef790cb772ca74e093a3655ee98aacdb1ae40fecfb8737cc06b931009a4e990'),
('hardware_customer_access_progress(text,uuid,text)','6f80bd18cc0a5fd2ba2b51724e886a8079b0d377863e5f2ef6537c55377c47d0'),
('hardware_customer_access_history(text,uuid,text)','8c3084cea3cb3aedfd53881c29a1fda80bd46c872edd06e3ca4ea37fb360b68d'),
('hardware_customer_access_revoke(text,uuid,text)','e2d032bf748d4e50ac94db8606636437f16a34c02927bc80112293dda4a11905'),
('hardware_customer_event_email()','fafec384eb1d6d55f1aff25da68c977686c5861927e9cbd33c30cb498ff56779'),
('hardware_customer_email_claim()','c0c9746edc40ea5bb8bc456f7d751c3782ebc8da559d3d6a74ec5c8bf7650c84'),
('hardware_customer_email_finish(uuid,uuid,text,integer)','664b0e09cd0743c84fc7c51e50df505edb792aa7d7cac19972f86782277720c3'),
('hardware_customer_email_guard()','d78009b27e8dc3d7ec15e0b742e2027f5f3fbaaa01cabb4e4362731b32e8c0f1')
), checks as (
 select 'function:'||e.signature as gate,coalesce(encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=e.digest
 and not p.prosecdef and p.proconfig=array['search_path=public, pg_temp'] and pg_get_userbyid(p.proowner)='postgres'
 and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
 and has_function_privilege('service_role',p.oid,'EXECUTE'),false) as passed
 from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature)
 union all
 select 'customer_tables_private',count(*)=4 and bool_and(relrowsecurity
 and not has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 and not has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
 from pg_class where relnamespace='public'::regnamespace and relkind='r'
 and relname in ('hardware_customer_challenges','hardware_customer_grants','hardware_customer_email_outbox','hardware_customer_access_events')
 union all
 select 'immutable_history_and_envelopes',count(*)=4 and bool_and(tgenabled='O') from pg_trigger where tgname in
 ('customer_access_events_immutable','customer_access_events_no_truncate','customer_email_guard','customer_email_no_truncate')
)
select gate,case when passed then 'PASS' else 'FAIL' end as status from checks order by gate;
