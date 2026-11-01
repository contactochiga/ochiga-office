-- Additive local-only refund presentation. Apply after customer access/notifications.
-- Financial facts are never overwritten; only verified provider observations can complete a refund.
create function hardware_refund_customer_status(p_order uuid) returns jsonb
 language plpgsql stable set search_path=public,pg_temp as $$declare f hardware_financial_observations%rowtype;begin
 select o.* into f from hardware_financial_observations o
 join hardware_refund_requests r on r.id::text=o.evidence->>'approval_id' and r.order_id=o.order_id and r.reference=o.reference
 join hardware_refund_decisions d on d.request_id=r.id and d.approved_by<>r.requested_by
 join hardware_payment_confirmations c on c.reference=r.reference and c.order_id=r.order_id
 where o.order_id=p_order and o.state='refund_processed' and o.evidence->>'status'='processed'
 and o.evidence->>'amount_kobo'=r.amount_kobo::text and r.amount_kobo=c.amount_kobo
 and o.evidence->>'transaction_id'=c.provider_id and o.evidence->>'currency'='NGN'
 and o.evidence->>'environment'='test' and o.evidence->>'refund_id' ~ '^[0-9]+$'
 order by o.event_id desc limit 1;
 if found then return jsonb_build_object('state','processed','amount_kobo',(f.evidence->>'amount_kobo')::bigint,'currency','NGN','at',f.created_at);end if;
 select * into f from hardware_financial_observations where order_id=p_order and state like 'refund_%' order by event_id desc limit 1;
 if found then return jsonb_build_object('state',case when f.state='refund_pending' then 'pending' else 'under_review' end,'amount_kobo',null,'currency','NGN','at',f.created_at);end if;
 if exists(select 1 from hardware_refund_requests where order_id=p_order) then return jsonb_build_object('state','under_review','amount_kobo',null,'currency','NGN','at',null);end if;
 return null;
end$$;
revoke all on function hardware_refund_customer_status(uuid) from public,anon,authenticated;
grant execute on function hardware_refund_customer_status(uuid) to service_role;
alter function hardware_order_public_progress(text,text,uuid) rename to hardware_order_pre_refund_progress;
create function hardware_order_public_progress(p_client text,p_guest_hash text,p_order uuid) returns jsonb
 language plpgsql stable set search_path=public,pg_temp as $$declare q jsonb;r jsonb;begin
 q:=hardware_order_pre_refund_progress(p_client,p_guest_hash,p_order); -- ownership first
 r:=hardware_refund_customer_status(p_order);
 if r is null then return q;end if;
 return q||jsonb_build_object('kind',case when r->>'state'='processed' then 'refunded' else 'under_review' end,'refund',r);
end$$;
revoke all on function hardware_order_public_progress(text,text,uuid) from public,anon,authenticated;
grant execute on function hardware_order_public_progress(text,text,uuid) to service_role;
alter table hardware_customer_email_outbox drop constraint hardware_customer_email_outbox_kind_check;
alter table hardware_customer_email_outbox add constraint hardware_customer_email_outbox_kind_check check(kind in ('refund_completed','access_code','created','cancelled','delivery_confirmed','paid','payment_failed','under_review','packed','dispatched','delivered','installed','closed','installation_requested','installation_scheduled','installation_rescheduled','installation_started','installation_completed','installation_cancelled'));
create or replace function hardware_customer_event_email() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare oid uuid; k text; event_key text;begin
 if tg_table_name='hardware_order_events' then oid:=new.order_id;k:=new.event_type;event_key:=new.id::text;
 elsif tg_table_name='hardware_payment_history' then oid:=new.order_id;k:=case when new.event_type='delivery_confirmed' then 'delivery_confirmed' end;event_key:=new.id::text;
 elsif tg_table_name='hardware_payment_confirmations' then oid:=new.order_id;k:=case when new.outcome='paid' then 'paid' else 'under_review' end;event_key:=new.reference;
 elsif tg_table_name='hardware_financial_observations' then oid:=new.order_id;k:=case when new.state='refund_processed' then 'refund_completed' when new.state='provider_failed' then 'payment_failed' when new.state in ('disputed','amount_mismatch','refund_escalated') then 'under_review' end;event_key:=new.event_id::text;
 elsif tg_table_name='hardware_fulfilment_events' then oid:=new.order_id;k:=case when new.to_state in ('packed','dispatched','delivered','installed','closed') then new.to_state end;event_key:=new.id::text;
 -- Installation completion is emitted once by the linked fulfilment 'installed' event.
 elsif tg_table_name='hardware_service_visit_events' then
 select order_id into oid from hardware_service_visits where id=new.visit_id and kind='installation';
 k:=case when new.event_type in ('requested','scheduled','rescheduled','started','cancelled') then 'installation_'||new.event_type end;event_key:=new.id::text;
 end if;
 if k='refund_completed' then
  -- Validate against the independently approved, provider-bound observation. One notice per refund,
  -- including repeated equivalent provider observations with different delivery event IDs.
  if not exists(select 1 from hardware_refund_requests r join hardware_refund_decisions d on d.request_id=r.id
   join hardware_payment_confirmations c on c.reference=r.reference and c.order_id=r.order_id
   where r.id::text=new.evidence->>'approval_id' and r.order_id=oid and r.reference=new.reference
   and d.approved_by<>r.requested_by and r.amount_kobo=c.amount_kobo
   and new.evidence->>'amount_kobo'=r.amount_kobo::text and new.evidence->>'transaction_id'=c.provider_id
   and new.evidence->>'status'='processed' and new.evidence->>'currency'='NGN'
   and new.evidence->>'environment'='test' and new.evidence->>'refund_id' ~ '^[0-9]+$') then
   raise exception 'verified_refund_required' using errcode='PT409';end if;
  perform hardware_customer_email_enqueue(oid,'refund_completed:'||(new.evidence->>'approval_id')||':'||(new.evidence->>'refund_id'),k,
    jsonb_build_object('refund_kobo',(new.evidence->>'amount_kobo')::bigint,'refund_status','processed'));
  return new;
 end if;
 if oid is not null and k is not null then perform hardware_customer_email_enqueue(oid,tg_table_name||':'||event_key,k);end if;
 if oid is not null and k in ('cancelled','under_review') then
 update hardware_customer_grants set revoked_at=now() where order_id=oid and revoked_at is null;
 insert into hardware_customer_access_events(order_id,action) values(oid,'grants_revoked');end if;
 return new;
end$$;
alter function hardware_financial_list(text) rename to hardware_financial_pre_refund_list;
create function hardware_financial_list(p_actor text) returns jsonb language plpgsql set search_path=public,pg_temp as $$declare q jsonb;begin
 q:=hardware_financial_pre_refund_list(p_actor); -- existing staff permission enforcement
 return coalesce((select jsonb_agg(x||jsonb_build_object('refund_status',hardware_refund_customer_status((x->>'id')::uuid),
 'financial_state',case when hardware_refund_customer_status((x->>'id')::uuid)->>'state'='processed' then 'refund_processed' else x->>'financial_state' end)) from jsonb_array_elements(q) x),'[]');end$$;
revoke all on function hardware_financial_list(text) from public,anon,authenticated;
grant execute on function hardware_financial_list(text) to service_role;
