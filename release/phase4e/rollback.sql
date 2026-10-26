-- PRE-USE rollback only. Once any financial facts exist retain schema and roll application forward.
begin;
do $$begin if exists(select 1 from hardware_financial_observations) or exists(select 1 from hardware_refund_decisions) or exists(select 1 from hardware_refund_requests) then raise exception 'financial_records_exist_retain_schema';end if;end$$;
drop function hardware_payment_quote(text,text,uuid);
alter function hardware_financial_previous_quote(text,text,uuid) rename to hardware_payment_quote;
drop table hardware_financial_observations;
drop table hardware_refund_decisions;
drop table hardware_refund_requests;
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and (proname like 'hardware_financial_%' or proname like 'hardware_refund_%') loop execute format('drop function %s',f);end loop;end$$;
commit;
