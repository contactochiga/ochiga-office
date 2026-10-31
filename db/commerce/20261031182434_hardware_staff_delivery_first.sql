-- Additive, local-only. Apply after Phase4F and the commerce kind boundary.
-- No replacement of immutable orders, financial evidence or expired holds.
begin;
create or replace function hardware_checkout_payment_readiness(p_client text,p_guest_hash text,p_order uuid)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare q jsonb; o hardware_orders%rowtype; r hardware_reservations%rowtype;
begin
 -- This delegate proves ownership and reads the authoritative total; it does not mutate.
 q:=hardware_payment_quote(p_client,p_guest_hash,p_order);
 select * into o from hardware_orders where id=p_order;
 select * into r from hardware_reservations where order_id=p_order;
 return q||jsonb_build_object('eligible',(q->>'eligible')::boolean is true,'can_prepare',
   o.order_state='awaiting_confirmation' and o.payment_state='not_started'
   and o.delivery_state='confirmed' and o.reservation_state='not_reserved' and r.id is null
   and not exists(select 1 from hardware_payment_authorizations where order_id=p_order),
   'reservation_expires_at',r.expires_at);
end $$;

create or replace function hardware_checkout_prepare_payment(p_client text,p_guest_hash text,p_order uuid,p_accepted_total bigint)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare q jsonb; hold jsonb;
begin
 -- The same DB mutex is used by reservations, payment authorization and confirmation.
 perform pg_advisory_xact_lock(71404,4);
 q:=hardware_checkout_payment_readiness(p_client,p_guest_hash,p_order);
 if p_accepted_total is null or p_accepted_total<1 or p_accepted_total is distinct from (q->>'amount_kobo')::bigint then
   raise exception 'payment_total_changed' using errcode='PT409';end if;
 -- Even an uncertain initialization has an authorization. Never reopen or replace it.
 if exists(select 1 from hardware_payment_authorizations where order_id=p_order) then
   raise exception 'payment_already_started' using errcode='PT409';end if;
 if (q->>'eligible')::boolean is true then return q;end if;
 if (q->>'can_prepare')::boolean is distinct from true then
   raise exception 'payment_preparation_not_eligible' using errcode='PT409';end if;
 -- Reuses current public/price/stock validation and immutable reservation audit.
 -- The hold begins when the customer returns, not while staff reviews delivery.
 hold:=hardware_reservation_hold(p_order,'prepare-'||p_order::text,'checkout:'||p_client,900);
 q:=hardware_checkout_payment_readiness(p_client,p_guest_hash,p_order);
 if (q->>'eligible')::boolean is distinct from true then
   raise exception 'payment_preparation_not_eligible' using errcode='PT409';end if;
 return q;
end $$;
revoke all on function hardware_checkout_payment_readiness(text,text,uuid) from public,anon,authenticated;
revoke all on function hardware_checkout_prepare_payment(text,text,uuid,bigint) from public,anon,authenticated;
grant execute on function hardware_checkout_payment_readiness(text,text,uuid) to service_role;
grant execute on function hardware_checkout_prepare_payment(text,text,uuid,bigint) to service_role;
commit;
