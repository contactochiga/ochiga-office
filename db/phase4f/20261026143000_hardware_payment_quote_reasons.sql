-- Local Stage 4E rehearsal extension. Keeps the original quote's ownership,
-- amount and eligibility checks authoritative; adds only an allowlisted reason.
-- Preserve the Phase 4E projection (including refund_state) as the delegate.
alter function hardware_payment_quote(text,text,uuid) rename to hardware_financial_phase4e_quote;
create function hardware_payment_quote(p_client text,p_guest_hash text,p_order uuid)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare
 q jsonb;
 o hardware_orders%rowtype;
 d hardware_payment_delivery%rowtype;
 r hardware_reservations%rowtype;
 reason text;
begin
 q:=hardware_financial_phase4e_quote(p_client,p_guest_hash,p_order);
 if (q->>'eligible')::boolean is true then
   return q||jsonb_build_object('eligibility_code','eligible');
 end if;

 select * into o from hardware_orders where id=p_order;
 if o.order_state='cancelled' then reason:='order_cancelled';
 elsif o.order_state<>'awaiting_confirmation' then reason:='order_state_invalid';
 elsif o.payment_state<>'not_started' then reason:='payment_already_started';
 else
   select * into r from hardware_reservations where order_id=p_order;
   select * into d from hardware_payment_delivery where order_id=p_order;
   if r.id is null then reason:='reservation_missing';
   elsif r.state='expired' or r.expires_at<=clock_timestamp() then reason:='reservation_expired';
   elsif r.state<>'held' then reason:='reservation_invalid';
   elsif d.order_id is null then reason:='delivery_unconfirmed';
   elsif exists(
     select 1 from hardware_order_lines l
     left join catalogue_products p on p.id=l.product_id
     left join catalogue_variants v on v.id=l.variant_id
     left join catalogue_public_listings pl on pl.product_id=p.id
       and pl.status='public' and pl.public_version=l.product_version
     where l.order_id=p_order and (
       p.id is null or pl.product_id is null or p.publication_status<>'published'
       or p.published_version<>l.product_version or v.id is null
       or v.status<>'active' or v.sourcing<>'in_stock'
       or v.stock_reserved<l.quantity or v.stock_on_hand<v.stock_reserved
     )
   ) then reason:='product_or_variant_unavailable';
   elsif exists(
     select 1 from hardware_order_lines l
     left join catalogue_variants v on v.id=l.variant_id
     left join catalogue_price_changes c on c.id=l.price_change_id
     where l.order_id=p_order and (
       v.price_ngn_kobo is distinct from l.unit_price_kobo
       or v.vat_rate_bp is distinct from l.vat_rate_bp
       or v.vat_treatment is distinct from l.vat_treatment
       or c.id is null or c.new_price_ngn_kobo is distinct from v.price_ngn_kobo
       or not exists(select 1 from catalogue_price_decisions x
         where x.price_change_id=c.id and x.decision='approved' and x.actor<>c.requested_by)
       or not exists(select 1 from catalogue_price_decisions x
         where x.price_change_id=c.id and x.decision='published')
     )
   ) then reason:='approved_price_missing_or_changed';
   else reason:='catalogue_or_price_ineligible';
   end if;
 end if;
 return q||jsonb_build_object('eligibility_code',reason);
end $$;
revoke all on function hardware_payment_quote(text,text,uuid) from public,anon,authenticated;
grant execute on function hardware_payment_quote(text,text,uuid) to service_role;
