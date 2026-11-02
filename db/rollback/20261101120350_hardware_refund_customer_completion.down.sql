-- Only before this notification type has been used. Otherwise retain schema and recover forward.
do $$begin if exists(select 1 from hardware_customer_email_outbox where kind='refund_completed') then raise exception 'refund_completion_history_present';end if;end$$;
drop function hardware_financial_list(text);
alter function hardware_financial_pre_refund_list(text) rename to hardware_financial_list;
drop function hardware_order_public_progress(text,text,uuid);
alter function hardware_order_pre_refund_progress(text,text,uuid) rename to hardware_order_public_progress;
create or replace function hardware_customer_event_email() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare oid uuid; k text; event_key text;begin
 if tg_table_name='hardware_order_events' then oid:=new.order_id;k:=new.event_type;event_key:=new.id::text;
 elsif tg_table_name='hardware_payment_history' then oid:=new.order_id;k:=case when new.event_type='delivery_confirmed' then 'delivery_confirmed' end;event_key:=new.id::text;
 elsif tg_table_name='hardware_payment_confirmations' then oid:=new.order_id;k:=case when new.outcome='paid' then 'paid' else 'under_review' end;event_key:=new.reference;
 elsif tg_table_name='hardware_financial_observations' then oid:=new.order_id;k:=case when new.state='provider_failed' then 'payment_failed' when new.state in ('disputed','amount_mismatch','refund_processed','refund_escalated') then 'under_review' end;event_key:=new.event_id::text;
 elsif tg_table_name='hardware_fulfilment_events' then oid:=new.order_id;k:=case when new.to_state in ('packed','dispatched','delivered','installed','closed') then new.to_state end;event_key:=new.id::text;
 -- Installation completion is emitted once by the linked fulfilment 'installed' event.
 elsif tg_table_name='hardware_service_visit_events' then
 select order_id into oid from hardware_service_visits where id=new.visit_id and kind='installation';
 k:=case when new.event_type in ('requested','scheduled','rescheduled','started','cancelled') then 'installation_'||new.event_type end;event_key:=new.id::text;
 end if;
 if oid is not null and k is not null then perform hardware_customer_email_enqueue(oid,tg_table_name||':'||event_key,k);end if;
 if oid is not null and k in ('cancelled','under_review') then
 update hardware_customer_grants set revoked_at=now() where order_id=oid and revoked_at is null;
 insert into hardware_customer_access_events(order_id,action) values(oid,'grants_revoked');end if;
 return new;
end$$;
drop function hardware_refund_customer_status(uuid);
alter table hardware_customer_email_outbox drop constraint hardware_customer_email_outbox_kind_check;
alter table hardware_customer_email_outbox add constraint hardware_customer_email_outbox_kind_check check(kind in ('access_code','created','cancelled','delivery_confirmed','paid','payment_failed','under_review','packed','dispatched','delivered','installed','closed','installation_requested','installation_scheduled','installation_rescheduled','installation_started','installation_completed','installation_cancelled'));
