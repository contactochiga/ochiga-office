-- LOCAL Stage 4D. Apply explicitly AFTER Stage 4C, transactionally. Test provider domain only.
create table hardware_payment_delivery (
 order_id uuid primary key references hardware_orders(id), gross_kobo bigint not null check(gross_kobo between 0 and 999999999),
 tax_kobo bigint not null check(tax_kobo between 0 and gross_kobo), actor text not null, evidence text not null check(length(evidence) between 8 and 500), created_at timestamptz not null default now()
);
create table hardware_payment_authorizations (
 order_id uuid primary key references hardware_orders(id), reference text not null unique,
 reservation_id uuid not null references hardware_reservations(id), amount_kobo bigint not null check(amount_kobo between 1 and 900999999999),
 currency text not null check(currency='NGN'), environment text not null check(environment='test'), authorization_hash text not null,
 created_at timestamptz not null default now()
);
create table hardware_payment_confirmations (
 reference text primary key references hardware_payment_authorizations(reference), provider_id text not null unique,
 order_id uuid not null unique references hardware_orders(id), reservation_id uuid not null,
 amount_kobo bigint not null, currency text not null check(currency='NGN'), environment text not null check(environment='test'),
 authorization_hash text not null, outcome text not null check(outcome in ('paid','refund_required')), created_at timestamptz not null default now()
);
create table hardware_payment_history (
 id uuid primary key default gen_random_uuid(),order_id uuid not null references hardware_orders(id),event_type text not null,
 actor text not null, detail jsonb not null default '{}',created_at timestamptz not null default now()
);
do $$declare t text;begin
 foreach t in array array['hardware_payment_delivery','hardware_payment_authorizations','hardware_payment_confirmations','hardware_payment_history'] loop
 execute format('alter table %I enable row level security',t);
 execute format('revoke all on %I from public,anon,authenticated,service_role',t);
 execute format('grant select,insert on %I to service_role',t);
 execute format('create trigger payment_immutable before update or delete on %I for each row execute function hardware_order_immutable()',t);
 execute format('create trigger payment_no_truncate before truncate on %I execute function hardware_order_immutable()',t);
 end loop;end$$;
-- Preserve the accepted guard for all existing transitions; narrowly add evidence-backed projections.
alter function hardware_order_state_guard() rename to hardware_payment_previous_order_guard;
create function hardware_order_state_guard() returns trigger language plpgsql set search_path=public,pg_temp as $$begin
 if tg_op='UPDATE' and (to_jsonb(new)-array['delivery_total_kobo','payable_total_kobo','delivery_state'])=(to_jsonb(old)-array['delivery_total_kobo','payable_total_kobo','delivery_state'])
 and old.delivery_state='unconfirmed' and new.delivery_state='confirmed' and new.payable_total_kobo=new.goods_total_kobo+new.delivery_total_kobo
 and exists(select 1 from hardware_payment_delivery d where d.order_id=new.id and d.gross_kobo=new.delivery_total_kobo) then return new;end if;
 if tg_op='UPDATE' and (to_jsonb(new)-'payment_state')=(to_jsonb(old)-'payment_state') and old.payment_state='not_started'
 and exists(select 1 from hardware_payment_confirmations c where c.order_id=new.id and c.outcome=new.payment_state) then return new;end if;
 if tg_op='UPDATE' and (to_jsonb(new)-array['reservation_state','fulfilment_state'])=(to_jsonb(old)-array['reservation_state','fulfilment_state'])
 and new.fulfilment_state=(case when new.reservation_state='allocated' then 'allocated' else 'unallocated' end)
 and ((old.reservation_state='not_reserved' and new.reservation_state='held') or (old.reservation_state='held' and new.reservation_state in ('released','expired','allocated'))) then return new;end if;
 if tg_op<>'UPDATE' or (to_jsonb(new)-array['order_state','row_version','updated_at']) is distinct from (to_jsonb(old)-array['order_state','row_version','updated_at'])
 or old.reservation_state='allocated' or old.order_state<>'awaiting_confirmation' or new.order_state<>'cancelled' or new.row_version<>old.row_version+1 then raise exception 'invalid_order_transition' using errcode='PT409';end if;return new;end$$;
drop trigger order_state_guard on hardware_orders;
create trigger order_state_guard before update or delete on hardware_orders for each row execute function hardware_order_state_guard();
alter table hardware_orders drop constraint hardware_orders_delivery_total_kobo_check,drop constraint hardware_orders_payable_total_kobo_check,drop constraint hardware_orders_delivery_state_check,drop constraint hardware_orders_payment_state_check;
alter table hardware_orders add constraint hardware_orders_delivery_total_kobo_check check(delivery_total_kobo between 0 and 999999999),add constraint hardware_orders_payable_total_kobo_check check(payable_total_kobo=goods_total_kobo+delivery_total_kobo),add constraint hardware_orders_delivery_state_check check(delivery_state in ('unconfirmed','confirmed')),add constraint hardware_orders_payment_state_check check(payment_state in ('not_started','paid','refund_required'));
create function hardware_payment_log(p_order uuid,p_event text,p_actor text,p_detail jsonb) returns void language plpgsql set search_path=public,pg_temp as $$begin
 insert into hardware_payment_history(order_id,event_type,actor,detail) values(p_order,p_event,p_actor,p_detail);
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_payment_'||p_event,'hardware_order',p_order::text,p_detail);
end$$;
create function hardware_payment_confirm_delivery(p_actor text,p_order uuid,p_gross bigint,p_tax bigint,p_evidence text) returns void language plpgsql set search_path=public,pg_temp as $$declare d hardware_payment_delivery%rowtype;begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.delivery.confirm');perform pg_advisory_xact_lock(71404,4);
 perform 1 from hardware_orders where id=p_order and order_state='awaiting_confirmation' and payment_state='not_started' for update;
 if not found then raise exception 'order_not_eligible' using errcode='PT409';end if;
 select * into d from hardware_payment_delivery where order_id=p_order;
 if found then if d.gross_kobo=p_gross and d.tax_kobo=p_tax and d.evidence=p_evidence then return;end if;raise exception 'delivery_already_confirmed' using errcode='PT409';end if;
 insert into hardware_payment_delivery values(p_order,p_gross,p_tax,p_actor,p_evidence,now());
 update hardware_orders set delivery_total_kobo=p_gross,payable_total_kobo=goods_total_kobo+p_gross,delivery_state='confirmed' where id=p_order;
 perform hardware_payment_log(p_order,'delivery_confirmed',p_actor,jsonb_build_object('gross_kobo',p_gross,'tax_kobo',p_tax));end$$;
create function hardware_payment_eligible(p_order uuid) returns boolean language plpgsql set search_path=public,pg_temp as $$declare l record;v catalogue_variants%rowtype;p catalogue_products%rowtype;begin
 perform cp.id from catalogue_products cp join hardware_order_lines ol on ol.product_id=cp.id where ol.order_id=p_order order by cp.id for share of cp;
 for l in select * from hardware_order_lines where order_id=p_order order by variant_id loop
 select * into v from catalogue_variants where id=l.variant_id for share;
 select * into p from catalogue_products where id=l.product_id;
 perform 1 from catalogue_public_listings where product_id=p.id and status='public' and public_version=l.product_version for share;
 if not found or p.publication_status<>'published' or p.published_version<>l.product_version or v.status<>'active' or v.sourcing<>'in_stock' or v.stock_reserved<l.quantity or v.stock_on_hand<v.stock_reserved or v.price_ngn_kobo<>l.unit_price_kobo or v.vat_rate_bp<>l.vat_rate_bp or v.vat_treatment<>l.vat_treatment
 or not exists(select 1 from catalogue_price_changes c where c.id=l.price_change_id and c.new_price_ngn_kobo=v.price_ngn_kobo and exists(select 1 from catalogue_price_decisions x where x.price_change_id=c.id and x.decision='approved' and x.actor<>c.requested_by) and exists(select 1 from catalogue_price_decisions x where x.price_change_id=c.id and x.decision='published')) then return false;end if;
 end loop;return exists(select 1 from hardware_order_lines where order_id=p_order);end$$;
create function hardware_payment_quote(p_client text,p_guest_hash text,p_order uuid) returns jsonb language plpgsql set search_path=public,pg_temp as $$declare o hardware_orders%rowtype;d hardware_payment_delivery%rowtype;r hardware_reservations%rowtype;begin
 if hardware_checkout_get(p_client,p_guest_hash,p_order) is null then raise exception 'order_not_found' using errcode='PT404';end if;
 perform pg_advisory_xact_lock(71404,4);
 select * into o from hardware_orders where id=p_order for update;select * into d from hardware_payment_delivery where order_id=p_order;select * into r from hardware_reservations where order_id=p_order;
 return jsonb_build_object('order_id',o.id,'amount_kobo',o.payable_total_kobo,'goods_tax_kobo',o.goods_tax_kobo,'delivery_kobo',d.gross_kobo,'delivery_tax_kobo',d.tax_kobo,'payment_state',o.payment_state,'eligible',o.order_state='awaiting_confirmation' and o.payment_state='not_started' and d.order_id is not null and r.state='held' and r.expires_at>clock_timestamp() and hardware_payment_eligible(p_order));end$$;
create function hardware_payment_authorize(p_client text,p_guest_hash text,p_order uuid,p_accepted_total bigint) returns jsonb language plpgsql set search_path=public,pg_temp as $$declare q jsonb;a hardware_payment_authorizations%rowtype;r hardware_reservations%rowtype;h text;begin
 q:=hardware_payment_quote(p_client,p_guest_hash,p_order);
 if (q->>'eligible')::boolean is distinct from true or (q->>'amount_kobo')::bigint is distinct from p_accepted_total then raise exception 'payment_not_eligible' using errcode='PT409';end if;
 select * into r from hardware_reservations where order_id=p_order;
 select * into a from hardware_payment_authorizations where order_id=p_order;
 if not found then
 h:=encode(sha256(convert_to(p_order::text||':'||r.id::text||':'||p_accepted_total::text||':NGN:test','UTF8')),'hex');
 insert into hardware_payment_authorizations values(p_order,'hwo_'||replace(p_order::text,'-',''),r.id,p_accepted_total,'NGN','test',h,now()) returning * into a;
 perform hardware_payment_log(p_order,'authorized','checkout:'||p_client,jsonb_build_object('reference',a.reference,'amount_kobo',a.amount_kobo));end if;
 return (to_jsonb(a)-'created_at')||jsonb_build_object('email',(select customer->>'email' from hardware_order_private where order_id=p_order));end$$;
create or replace function hardware_reservation_payment_verified(p_order uuid,p_reservation uuid) returns boolean language sql stable set search_path=public,pg_temp as $$
 select exists(select 1 from hardware_payment_confirmations c join hardware_payment_authorizations a using(reference) join hardware_orders o on o.id=c.order_id where c.order_id=p_order and c.reservation_id=p_reservation and c.outcome='paid' and c.amount_kobo=a.amount_kobo and c.amount_kobo=o.payable_total_kobo and c.authorization_hash=a.authorization_hash and c.environment='test' and c.currency='NGN' and o.delivery_state='confirmed')$$;
create function hardware_payment_confirm(p jsonb) returns jsonb language plpgsql set search_path=public,pg_temp as $$declare a hardware_payment_authorizations%rowtype;c hardware_payment_confirmations%rowtype;o hardware_orders%rowtype;r hardware_reservations%rowtype;outcome text;begin
 perform pg_advisory_xact_lock(71404,4);
 select * into a from hardware_payment_authorizations where reference=p->>'reference';
 if not found then raise exception 'unknown_payment_reference' using errcode='PT404';end if;
 if p->>'order_id' is distinct from a.order_id::text or p->>'reservation_id' is distinct from a.reservation_id::text or p->>'amount_kobo' is distinct from a.amount_kobo::text or p->>'currency' is distinct from a.currency or p->>'environment' is distinct from a.environment or p->>'purpose' is distinct from 'hardware_order' or p->>'authorization_hash' is distinct from a.authorization_hash or coalesce(p->>'provider_id','') !~ '^[0-9]+$' then raise exception 'payment_evidence_mismatch' using errcode='PT409';end if;
 select * into c from hardware_payment_confirmations where reference=a.reference;
 if found then if c.provider_id<>p->>'provider_id' then raise exception 'duplicate_payment_requires_reconciliation' using errcode='PT409';end if;return jsonb_build_object('payment_state',c.outcome,'replayed',true);end if;
 select * into o from hardware_orders where id=a.order_id for update;select * into r from hardware_reservations where id=a.reservation_id for update;
 outcome:=case when o.order_state='awaiting_confirmation' and o.payment_state='not_started' and r.state='held' and r.expires_at>clock_timestamp() and hardware_payment_eligible(o.id) then 'paid' else 'refund_required' end;
 insert into hardware_payment_confirmations values(a.reference,p->>'provider_id',a.order_id,a.reservation_id,a.amount_kobo,a.currency,a.environment,a.authorization_hash,outcome,now());
 if outcome='paid' then if hardware_reservation_allocate(o.id)->>'state' is distinct from 'allocated' then raise exception 'reservation_expired_retry_confirmation' using errcode='PT409';end if;else perform hardware_reservation_finish(o.id,'released','payment','Payment requires refund');end if;
 update hardware_orders set payment_state=outcome where id=o.id;
 perform hardware_payment_log(o.id,outcome,'backend:hardware_payments',jsonb_build_object('reference',a.reference,'provider_id',p->>'provider_id'));
 insert into crm_activities(contact_id,opportunity_id,related_type,related_id,activity_type,title,source,actor,metadata) values(o.contact_id,o.opportunity_id,'hardware_order',o.id::text,'hardware_payment_'||outcome,'Hardware payment verified','backend','backend:hardware_payments',jsonb_build_object('payment_state',outcome));
 return jsonb_build_object('payment_state',outcome,'replayed',false);end$$;
do $$declare f regprocedure;begin
 for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and (proname like 'hardware_payment_%' or proname in ('hardware_order_state_guard','hardware_reservation_payment_verified')) loop
 execute format('revoke all on function %s from public,anon,authenticated',f);execute format('grant execute on function %s to service_role',f);end loop;end$$;

create function hardware_payment_consistency() returns trigger language plpgsql set search_path=public,pg_temp as $$declare oid uuid;o hardware_orders%rowtype;c hardware_payment_confirmations%rowtype;a hardware_payment_authorizations%rowtype;begin
 oid:=coalesce((to_jsonb(new)->>'order_id')::uuid,(to_jsonb(new)->>'id')::uuid);select * into o from hardware_orders where id=oid;select * into c from hardware_payment_confirmations where order_id=oid;select * into a from hardware_payment_authorizations where order_id=oid;
 if (o.payment_state<>'not_started' and c.order_id is null) or (c.order_id is not null and (c.outcome<>o.payment_state or c.amount_kobo is distinct from o.payable_total_kobo or c.amount_kobo<>a.amount_kobo or c.authorization_hash<>a.authorization_hash or c.reservation_id<>a.reservation_id or (c.outcome='paid' and o.reservation_state<>'allocated') or not exists(select 1 from hardware_payment_history h where h.order_id=oid and h.event_type=c.outcome)))
 or (o.delivery_state='confirmed' and not exists(select 1 from hardware_payment_delivery d where d.order_id=oid and d.gross_kobo=o.delivery_total_kobo))
 or exists(select 1 from hardware_payment_history h where h.order_id=oid and not exists(select 1 from audit_events e where e.target_id=oid::text and e.action='hardware_payment_'||h.event_type and e.actor_email=h.actor)) then raise exception 'payment_integrity_violation' using errcode='PT409';end if;return null;end$$;
revoke all on function hardware_payment_consistency() from public,anon,authenticated;
grant execute on function hardware_payment_consistency() to service_role;
do $$declare t text;begin foreach t in array array['hardware_orders','hardware_payment_delivery','hardware_payment_authorizations','hardware_payment_confirmations','hardware_payment_history'] loop
 execute format('create constraint trigger payment_consistency after insert or update on %I deferrable initially deferred for each row execute function hardware_payment_consistency()',t);end loop;end$$;
