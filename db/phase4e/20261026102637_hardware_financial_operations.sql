-- Additive financial operations; original payment and inventory facts remain immutable.
create table hardware_financial_observations (
 event_id bigint primary key,order_id uuid not null references hardware_orders(id),reference text not null references hardware_payment_authorizations(reference),
 state text not null check(state in ('provider_pending','pending_overdue','provider_failed','provider_unavailable','provider_success','amount_mismatch','disputed','dispute_review','reversed_unreconciled','office_retry','refund_pending','refund_processed','refund_escalated','refund_uncertain')),
 evidence jsonb not null,fingerprint text not null,created_at timestamptz not null default now()
);
create table hardware_refund_requests (
 id uuid primary key default gen_random_uuid(),order_id uuid not null unique references hardware_orders(id),reference text not null references hardware_payment_confirmations(reference),
 amount_kobo bigint not null check(amount_kobo>0),requested_by text not null,reason text not null check(length(reason) between 8 and 500),created_at timestamptz not null default now()
);
create table hardware_refund_decisions (
 request_id uuid primary key references hardware_refund_requests(id),approved_by text not null,created_at timestamptz not null default now()
);
do $$declare t text;begin foreach t in array array['hardware_financial_observations','hardware_refund_requests','hardware_refund_decisions'] loop
 execute format('alter table %I enable row level security',t);execute format('revoke all on %I from public,anon,authenticated,service_role',t);execute format('grant select,insert on %I to service_role',t);
 execute format('create trigger financial_immutable before update or delete on %I for each row execute function hardware_order_immutable()',t);
 execute format('create trigger financial_no_truncate before truncate on %I execute function hardware_order_immutable()',t);end loop;end$$;
create function hardware_financial_observe(p jsonb) returns void language plpgsql set search_path=public,pg_temp as $$declare a hardware_payment_authorizations%rowtype;h text;oldrow hardware_financial_observations%rowtype;begin
 select * into a from hardware_payment_authorizations where reference=p->>'reference';
 if not found or a.order_id::text is distinct from p->>'order_id' or a.amount_kobo::text is distinct from p->>'amount_kobo' or p->>'environment' is distinct from 'test' then raise exception 'financial_evidence_mismatch' using errcode='PT409';end if;
 if p->>'state'='refund_processed' and not exists(select 1 from hardware_refund_requests r join hardware_refund_decisions d on d.request_id=r.id join hardware_payment_confirmations c on c.reference=r.reference where r.id::text=p->'evidence'->>'approval_id' and r.order_id=a.order_id and r.amount_kobo::text=p->'evidence'->>'amount_kobo' and c.provider_id=p->'evidence'->>'transaction_id' and p->'evidence'->>'status'='processed' and p->'evidence'->>'currency'='NGN' and p->'evidence'->>'environment'='test' and p->'evidence'->>'refund_id' ~ '^[0-9]+$') then raise exception 'verified_refund_required' using errcode='PT409';end if;
 h:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
 insert into hardware_financial_observations values((p->>'event_id')::bigint,a.order_id,a.reference,p->>'state',p->'evidence',h,now()) on conflict do nothing;
 select * into oldrow from hardware_financial_observations where event_id=(p->>'event_id')::bigint;
 if oldrow.fingerprint<>h then raise exception 'financial_replay_conflict' using errcode='PT409';end if;
 if not exists(select 1 from hardware_payment_history where order_id=a.order_id and detail->>'financial_event_id'=p->>'event_id') then perform hardware_payment_log(a.order_id,'financial_observed','backend:hardware_payments',jsonb_build_object('financial_event_id',p->>'event_id','state',p->>'state'));end if;
end$$;
create function hardware_refund_request(p_actor text,p_order uuid,p_reason text) returns jsonb language plpgsql set search_path=public,pg_temp as $$declare c hardware_payment_confirmations%rowtype;r hardware_refund_requests%rowtype;begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.refund.request');
 select * into c from hardware_payment_confirmations where order_id=p_order for update;
 if not found then raise exception 'verified_payment_required' using errcode='PT409';end if;
 select * into r from hardware_refund_requests where order_id=p_order;
 if found then if r.requested_by<>p_actor or r.reason<>p_reason then raise exception 'refund_request_conflict' using errcode='PT409';end if;return to_jsonb(r);end if;
 insert into hardware_refund_requests(order_id,reference,amount_kobo,requested_by,reason) values(p_order,c.reference,c.amount_kobo,p_actor,p_reason) returning * into r;
 perform hardware_payment_log(p_order,'refund_requested',p_actor,jsonb_build_object('request_id',r.id,'amount_kobo',r.amount_kobo));
 return to_jsonb(r);end$$;
create function hardware_refund_approve(p_actor text,p_id uuid) returns jsonb language plpgsql set search_path=public,pg_temp as $$declare r hardware_refund_requests%rowtype;d hardware_refund_decisions%rowtype;begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.refund.approve');select * into r from hardware_refund_requests where id=p_id for update;
 if not found then raise exception 'refund_not_found' using errcode='PT404';end if;
 if p_actor=r.requested_by then raise exception 'self_approval_denied' using errcode='PT403';end if;
 if exists(select 1 from hardware_financial_observations where order_id=r.order_id and state in ('disputed','dispute_review','reversed_unreconciled','amount_mismatch')) then raise exception 'manual_reconciliation_required' using errcode='PT409';end if;
 select * into d from hardware_refund_decisions where request_id=p_id;
 if found then if d.approved_by<>p_actor then raise exception 'refund_already_approved' using errcode='PT409';end if;return to_jsonb(d);end if;
 insert into hardware_refund_decisions values(p_id,p_actor,now()) returning * into d;
 perform hardware_payment_log(r.order_id,'refund_approved',p_actor,jsonb_build_object('request_id',r.id));return to_jsonb(d);end$$;
create function hardware_financial_list(p_actor text) returns jsonb language plpgsql set search_path=public,pg_temp as $$begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.read');
 return coalesce((select jsonb_agg(to_jsonb(x)) from (select o.id,o.payment_state,o.order_state,o.payable_total_kobo,
 (select state from hardware_financial_observations f where f.order_id=o.id order by event_id desc limit 1) financial_state,
 (select to_jsonb(r)||jsonb_build_object('approved_by',(select approved_by from hardware_refund_decisions where request_id=r.id)) from hardware_refund_requests r where r.order_id=o.id) refund,
 (select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at),'[]') from hardware_payment_history h where h.order_id=o.id) history
 from hardware_orders o order by o.created_at desc limit 100) x),'[]');end$$;
create function hardware_refund_approved() returns jsonb language sql stable set search_path=public,pg_temp as $$select coalesce(jsonb_agg(jsonb_build_object('approval_id',r.id,'order_id',r.order_id,'reference',r.reference,'amount_kobo',r.amount_kobo,'requested_by',r.requested_by,'approved_by',d.approved_by)),'[]') from hardware_refund_requests r join hardware_refund_decisions d on d.request_id=r.id where not exists(select 1 from hardware_financial_observations f where f.order_id=r.order_id and f.state='refund_processed')$$;
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and (proname like 'hardware_financial_%' or proname like 'hardware_refund_%') loop execute format('revoke all on function %s from public,anon,authenticated',f);execute format('grant execute on function %s to service_role',f);end loop;end$$;
-- Transactional notification delivery records reuse Office's existing inbox.
create function hardware_financial_notify() returns trigger language plpgsql set search_path=public,pg_temp as $$declare oid uuid;actor text;begin
 if tg_table_name='hardware_refund_requests' then
 oid:=new.order_id;actor:=new.requested_by;
 insert into notifications(type,reason,summary,recipient_email,related_type,related_id,metadata)
 select 'internal','hardware_refund_review','Hardware refund requires independent review',email,'hardware_order',oid::text,jsonb_build_object('request_id',new.id)
 from admin_users where status='active' and removed_at is null and lower(email)<>actor and (role='super_admin' or 'commerce.orders.refund.approve'=any(permission_scopes));
 elsif tg_table_name='hardware_refund_decisions' then
 select order_id,requested_by into oid,actor from hardware_refund_requests where id=new.request_id;
 if actor=new.approved_by then raise exception 'self_approval_denied' using errcode='PT403';end if;
 insert into notifications(type,reason,summary,recipient_email,related_type,related_id) values('internal','hardware_refund_approved','Refund approved for provider processing',actor,'hardware_order',oid::text);
 end if;return new;end$$;
create trigger financial_notify after insert on hardware_refund_requests for each row execute function hardware_financial_notify();
create trigger financial_notify after insert on hardware_refund_decisions for each row execute function hardware_financial_notify();
revoke all on function hardware_financial_notify() from public,anon,authenticated;
grant execute on function hardware_financial_notify() to service_role;
-- Guest-bound projection adds safe status labels, never staff notes or provider identifiers.
alter function hardware_payment_quote(text,text,uuid) rename to hardware_financial_previous_quote;
create function hardware_payment_quote(p_client text,p_guest_hash text,p_order uuid) returns jsonb language plpgsql set search_path=public,pg_temp as $$declare q jsonb;s text;begin
 q:=hardware_financial_previous_quote(p_client,p_guest_hash,p_order);
 select state into s from hardware_financial_observations where order_id=p_order and state like 'refund_%' order by case when state='refund_processed' then 0 else 1 end,event_id desc limit 1;
 return q||jsonb_build_object('refund_state',s);end$$;
revoke all on function hardware_payment_quote(text,text,uuid) from public,anon,authenticated;
grant execute on function hardware_payment_quote(text,text,uuid) to service_role;
create function hardware_financial_note(p_actor text,p_order uuid,p_note text) returns void language plpgsql set search_path=public,pg_temp as $$begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.reconcile');
 if length(p_note) not between 8 and 500 or p_note is null then raise exception 'invalid_reconciliation_note' using errcode='PT400';end if;
 perform 1 from hardware_orders where id=p_order;if not found then raise exception 'order_not_found' using errcode='PT404';end if;
 perform hardware_payment_log(p_order,'reconciliation_note',p_actor,jsonb_build_object('note',p_note));end$$;
revoke all on function hardware_financial_note(text,uuid,text) from public,anon,authenticated;
grant execute on function hardware_financial_note(text,uuid,text) to service_role;
