-- LOCAL Phase 5D. Apply explicitly AFTER Phase 5C, transactionally. NOT for production databases.
-- Customer-safe, read-only order progress for the guest who placed the order (proved by the existing checkout receipt:
-- client + guest hash + order). Built from the existing 5A/5B/5C states. It never returns staff identities, technician
-- names, appointment dates or slots, tracking references or links, proof/visit photos, street addresses, contact details,
-- notes, refund reasons or internal ids other than the order id the guest already holds. No table is created or changed.
create function hardware_order_public_progress(p_client text,p_guest_hash text,p_order uuid) returns jsonb
 language plpgsql stable set search_path=public,pg_temp as $$
declare o hardware_orders%rowtype; f hardware_fulfilments%rowtype; d hardware_deliveries%rowtype; v hardware_service_visits%rowtype;
 v_kind text; paid_at timestamptz; refund boolean; stages jsonb:='[]'::jsonb; area jsonb; inst text; inst_at timestamptz; current text; s text; t timestamptz;
begin
 if p_client is null or p_client !~ '^[a-z0-9_-]{1,40}$' or p_guest_hash is null or p_guest_hash !~ '^[0-9a-f]{64}$' or p_order is null then
  raise exception 'invalid_progress_request' using errcode='PT400';end if;
 -- Ownership: the same answer for unknown and not-yours orders (no enumeration).
 if not exists(select 1 from hardware_checkout_receipts where client=p_client and guest_hash=p_guest_hash and order_id=p_order) then
  raise exception 'order_not_found' using errcode='PT404';end if;
 select * into o from hardware_orders where id=p_order;
 select * into f from hardware_fulfilments where order_id=p_order;
 select * into d from hardware_deliveries where order_id=p_order;
 select * into v from hardware_service_visits where order_id=p_order and hardware_service_visits.kind='installation' order by (state='cancelled'), created_at desc limit 1;
 select min(created_at) into paid_at from hardware_payment_confirmations where order_id=p_order;
 refund:=o.payment_state='refund_required' or exists(select 1 from hardware_refund_requests where order_id=p_order);
 v_kind:=case when o.order_state='cancelled' then 'cancelled' when refund then 'under_review' when o.payment_state='paid' then 'paid_order' else 'order_request' end;
 select jsonb_build_object('state',p.delivery->>'state','city',p.delivery->>'city') into area from hardware_order_private p where p.order_id=p_order;

 stages:=stages||jsonb_build_object('key','received','status','done','at',o.created_at);
 stages:=stages||jsonb_build_object('key','payment','status',case when paid_at is not null then 'done' when o.order_state='cancelled' then 'cancelled' else 'not_paid' end,'at',paid_at);
 foreach s in array array['packed','dispatched','delivered'] loop
  select min(created_at) into t from hardware_fulfilment_events where order_id=p_order and to_state=s;
  stages:=stages||jsonb_build_object('key',s,'status',case when t is not null then 'done' else 'pending' end,'at',t,
   'note',case when s='dispatched' and t is null and d.state in ('scheduled','on_hold') then 'being_arranged'
               when s='delivered' and t is null and d.state='out_for_delivery' then 'on_its_way'
               when s='delivered' and t is null and d.state in ('failed','on_hold') then 'being_rearranged' else null end);
 end loop;
 if o.installation_requested then
  select min(created_at) into inst_at from hardware_fulfilment_events where order_id=p_order and to_state='installed';
  inst:=case when inst_at is not null then 'done' when v.id is null or v.state='cancelled' then 'requested' when v.state='in_progress' then 'in_progress' else 'being_arranged' end;
  stages:=stages||jsonb_build_object('key','installation','status',case when inst='done' then 'done' else 'pending' end,'at',inst_at,'note',case when inst='done' then null else inst end);
 end if;
 select min(created_at) into t from hardware_fulfilment_events where order_id=p_order and to_state='closed';
 stages:=stages||jsonb_build_object('key','completed','status',case when t is not null then 'done' else 'pending' end,'at',t);
 select e->>'key' into current from jsonb_array_elements(stages) e where e->>'status' in ('pending','not_paid') limit 1;

 return jsonb_build_object(
  'order_id',o.id,
  'reference','HW-'||upper(left(replace(o.id::text,'-',''),8)),
  'kind',v_kind,
  'created_at',o.created_at,
  'installation_requested',o.installation_requested,
  'delivery_area',coalesce(area,'{}'::jsonb),
  'currency',o.currency,
  'goods_total_kobo',o.goods_total_kobo,
  'goods_tax_kobo',o.goods_tax_kobo,
  'delivery_total_kobo',o.delivery_total_kobo,
  'payable_total_kobo',o.payable_total_kobo,
  'lines',(select coalesce(jsonb_agg(jsonb_build_object('name',l.product_name,'variant',l.variant_name,'options',l.variant_options,'quantity',l.quantity,
     'unit_price_kobo',l.unit_price_kobo,'gross_kobo',l.gross_kobo) order by l.position),'[]'::jsonb) from hardware_order_lines l where l.order_id=p_order),
  'stages',stages,
  'current_stage',coalesce(current,'completed'));
end$$;
revoke all on function hardware_order_public_progress(text,text,uuid) from public,anon,authenticated;
grant execute on function hardware_order_public_progress(text,text,uuid) to service_role;
