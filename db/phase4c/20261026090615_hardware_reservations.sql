-- Stage 4C LOCAL CANDIDATE. Apply AFTER 20261108, never by filename-date sorting.
-- One database inventory mutex plus deterministic row locks. No in-memory authority.
create table hardware_reservations (
 id uuid primary key default gen_random_uuid(), order_id uuid not null unique references hardware_orders(id) on delete restrict,
 idempotency_key text not null check(idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'), request_hash text not null,
 actor text not null, state text not null default 'held' check(state in ('held','released','expired','allocated')),
 expires_at timestamptz not null, created_at timestamptz not null default clock_timestamp(), ended_at timestamptz,
 row_version integer not null default 1 check(row_version in (1,2)),
 check(expires_at>created_at), check((state='held')=(ended_at is null))
);
create index hardware_reservations_expiry on hardware_reservations(expires_at,id) where state='held';
create table hardware_reservation_lines (
 reservation_id uuid not null references hardware_reservations(id) on delete restrict,
 variant_id uuid not null references catalogue_variants(id) on delete restrict,
 quantity integer not null check(quantity between 1 and 1000), primary key(reservation_id,variant_id)
);
create table hardware_reservation_events (
 id uuid primary key default gen_random_uuid(), reservation_id uuid not null references hardware_reservations(id) on delete restrict,
 row_version integer not null, event_type text not null check(event_type in ('held','released','expired','allocated')),
 actor text not null, reason text not null default '' check(length(reason)<=500), created_at timestamptz not null default clock_timestamp(),
 unique(reservation_id,row_version)
);
-- Retains pre-existing manual reservations. The catalogue counter remains the sole public stock counter.
create table hardware_reservation_stock (
 variant_id uuid primary key references catalogue_variants(id) on delete restrict,
 legacy_reserved integer not null check(legacy_reserved>=0)
);
create function hardware_reservation_guard() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if tg_op<>'UPDATE' or old.state<>'held' or new.state not in ('released','expired','allocated') or new.row_version<>old.row_version+1
 or new.ended_at is null or (to_jsonb(new)-array['state','row_version','ended_at']) is distinct from (to_jsonb(old)-array['state','row_version','ended_at'])
 then raise exception 'reservation_history_immutable' using errcode='PT409';end if;
 return new;
end $$;
do $$declare t text;begin
 foreach t in array array['hardware_reservations','hardware_reservation_lines','hardware_reservation_events','hardware_reservation_stock'] loop
 execute format('alter table %I enable row level security',t);
 execute format('revoke all on %I from public,anon,authenticated,service_role',t);
 execute format('grant select,insert,update,delete on %I to service_role',t);
 execute format('create trigger reservation_no_truncate before truncate on %I for each statement execute function hardware_order_immutable()',t);
 if t in ('hardware_reservation_lines','hardware_reservation_events') then execute format('create trigger reservation_immutable before update or delete on %I for each row execute function hardware_order_immutable()',t); end if;
 end loop;
end $$;
create trigger reservation_state_guard before update or delete on hardware_reservations for each row execute function hardware_reservation_guard();
create trigger reservation_stock_no_delete before delete on hardware_reservation_stock for each row execute function hardware_order_immutable();
alter table hardware_orders drop constraint hardware_orders_reservation_state_check;
alter table hardware_orders add constraint hardware_orders_reservation_state_check check(reservation_state in ('not_reserved','held','released','expired','allocated'));
alter table hardware_orders drop constraint hardware_orders_fulfilment_state_check;
alter table hardware_orders add constraint hardware_orders_fulfilment_state_check check(fulfilment_state in ('unallocated','allocated'));
-- Fail-closed adapter. Stage 4D must replace this ONLY with a reviewed query of durable,
-- server-verified order-payment evidence bound to order, hold, exact NGN amount, purpose,
-- environment and confirmed delivery. No request parameter can claim verification.
create function hardware_reservation_payment_verified(p_order uuid,p_reservation uuid) returns boolean language sql stable set search_path=public,pg_temp as $$ select false $$;
-- Independent reservation revision lives on its aggregate; order financial/status history is unchanged.
create or replace function hardware_order_state_guard() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if tg_op='UPDATE' and (to_jsonb(new)-array['reservation_state','fulfilment_state'])=(to_jsonb(old)-array['reservation_state','fulfilment_state'])
 and new.fulfilment_state=(case when new.reservation_state='allocated' then 'allocated' else 'unallocated' end)
 and ((old.reservation_state='not_reserved' and new.reservation_state='held') or (old.reservation_state='held' and new.reservation_state in ('released','expired','allocated'))) then return new;end if;
 if tg_op<>'UPDATE' then raise exception 'order_history_immutable' using errcode='PT409';end if;
 if (to_jsonb(new)-array['order_state','row_version','updated_at']) is distinct from (to_jsonb(old)-array['order_state','row_version','updated_at'])
 or old.reservation_state='allocated' or old.order_state<>'awaiting_confirmation' or new.order_state<>'cancelled' or new.row_version<>old.row_version+1 then raise exception 'invalid_order_transition' using errcode='PT409';end if;
 return new;
end $$;
create function hardware_reservation_check() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare r hardware_reservations%rowtype; o hardware_orders%rowtype; rid uuid; vid uuid; baseline integer; held bigint;
begin
 if tg_table_name in ('catalogue_variants','hardware_reservation_stock') then
 vid:=coalesce((to_jsonb(new)->>'variant_id')::uuid,(to_jsonb(new)->>'id')::uuid);
 select legacy_reserved into baseline from hardware_reservation_stock where variant_id=vid;
 if found then
 select coalesce(sum(l.quantity),0) into held from hardware_reservation_lines l join hardware_reservations x on x.id=l.reservation_id where l.variant_id=vid and x.state='held';
 if not exists(select 1 from catalogue_variants where id=vid and stock_reserved=baseline+held) then raise exception 'reservation_stock_integrity' using errcode='PT409';end if;
 end if;return null;end if;
 if tg_table_name='hardware_orders' then
 select * into r from hardware_reservations where order_id=new.id;
 if not found then if new.reservation_state<>'not_reserved' then raise exception 'reservation_order_integrity' using errcode='PT409';end if;return null;end if;
 else rid:=coalesce((to_jsonb(new)->>'reservation_id')::uuid,(to_jsonb(new)->>'id')::uuid);select * into r from hardware_reservations where id=rid;end if;
 select * into o from hardware_orders where id=r.order_id;
 if o.reservation_state<>r.state or (o.order_state='cancelled' and r.state='held')
 or (r.state='allocated' and (o.fulfilment_state<>'allocated' or not hardware_reservation_payment_verified(o.id,r.id)))
 or (r.state<>'allocated' and o.fulfilment_state<>'unallocated')
 or not exists(select 1 from hardware_reservation_events where reservation_id=r.id and row_version=1 and event_type='held' and actor=r.actor)
 or (select count(*) from hardware_reservation_events where reservation_id=r.id)<>r.row_version
 or not exists(select 1 from hardware_reservation_events where reservation_id=r.id and row_version=r.row_version and event_type=r.state)
 or exists((select variant_id,quantity from hardware_order_lines where order_id=o.id) except (select variant_id,quantity from hardware_reservation_lines where reservation_id=r.id))
 or exists((select variant_id,quantity from hardware_reservation_lines where reservation_id=r.id) except (select variant_id,quantity from hardware_order_lines where order_id=o.id))
 or exists(select 1 from hardware_reservation_events e where e.reservation_id=r.id and not exists(select 1 from audit_events a where a.target_type='hardware_reservation' and a.target_id=r.id::text and a.action='hardware_reservation_'||e.event_type and a.actor_email=e.actor and a.metadata->>'row_version'=e.row_version::text))
 or exists(select 1 from hardware_reservation_lines l join hardware_reservation_events e on e.reservation_id=l.reservation_id where l.reservation_id=r.id and not exists(select 1 from catalogue_inventory_changes c where c.variant_id=l.variant_id and c.field='stock_reserved' and c.reason='reservation:'||r.id::text||':'||e.row_version and c.actor=e.actor and (c.new_value::integer-c.old_value::integer)=case when e.event_type='held' then l.quantity else -l.quantity end))
 or exists(select 1 from hardware_reservation_lines l where l.reservation_id=r.id and r.state='allocated' and not exists(select 1 from catalogue_inventory_changes c where c.variant_id=l.variant_id and c.field='stock_on_hand' and c.reason='reservation:'||r.id::text||':2' and c.new_value::integer-c.old_value::integer=-l.quantity))
 then raise exception 'reservation_integrity' using errcode='PT409';end if;
 return null;
end $$;
do $$declare t text;begin
 foreach t in array array['hardware_reservations','hardware_reservation_lines','hardware_reservation_events','hardware_orders','catalogue_variants','hardware_reservation_stock'] loop
 execute format('create constraint trigger reservation_consistency after insert or update on %I deferrable initially deferred for each row execute function hardware_reservation_check()',t);
 end loop;
end $$;
create function hardware_reservation_finish(p_order uuid,p_state text,p_actor text,p_reason text) returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare r hardware_reservations%rowtype; l record; before_qty integer; before_on_hand integer;
begin
 perform pg_advisory_xact_lock(71404,4);
 perform 1 from hardware_orders where id=p_order for update;
 select * into r from hardware_reservations where order_id=p_order for update;
 if not found then return jsonb_build_object('state','not_reserved');end if;
 if r.state<>'held' then return jsonb_build_object('id',r.id,'state',r.state,'replayed',true);end if;
 if p_state not in ('released','expired','allocated') then raise exception 'invalid_reservation_action' using errcode='PT400';end if;
 if p_state='allocated' and (r.expires_at<=clock_timestamp() or not hardware_reservation_payment_verified(p_order,r.id)) then raise exception 'verified_order_payment_required' using errcode='PT409';end if;
 if p_state='expired' and r.expires_at>clock_timestamp() then raise exception 'reservation_not_expired' using errcode='PT409';end if;
 if r.expires_at<=clock_timestamp() then p_state:='expired';end if;
 for l in select * from hardware_reservation_lines where reservation_id=r.id order by variant_id loop
 select stock_reserved,stock_on_hand into before_qty,before_on_hand from catalogue_variants where id=l.variant_id for update;
 update catalogue_variants set stock_reserved=stock_reserved-l.quantity,stock_on_hand=stock_on_hand-case when p_state='allocated' then l.quantity else 0 end,row_version=row_version+1,updated_at=now() where id=l.variant_id;
 insert into catalogue_inventory_changes(variant_id,field,old_value,new_value,actor,reason) values(l.variant_id,'stock_reserved',before_qty::text,(before_qty-l.quantity)::text,p_actor,'reservation:'||r.id::text||':2');
 if p_state='allocated' then insert into catalogue_inventory_changes(variant_id,field,old_value,new_value,actor,reason) values(l.variant_id,'stock_on_hand',before_on_hand::text,(before_on_hand-l.quantity)::text,p_actor,'reservation:'||r.id::text||':2');end if;
 end loop;
 update hardware_reservations set state=p_state,ended_at=clock_timestamp(),row_version=2 where id=r.id;
 update hardware_orders set reservation_state=p_state,fulfilment_state=case when p_state='allocated' then 'allocated' else 'unallocated' end where id=p_order;
 insert into hardware_reservation_events(reservation_id,row_version,event_type,actor,reason) values(r.id,2,p_state,p_actor,left(coalesce(p_reason,''),500));
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_reservation_'||p_state,'hardware_reservation',r.id::text,jsonb_build_object('order_id',p_order,'row_version',2));
 return jsonb_build_object('id',r.id,'state',p_state,'replayed',false);
end $$;
create function hardware_reservation_expire(p_limit integer default 500) returns integer language plpgsql set search_path=public,pg_temp as $$
declare r record; n integer:=0;
begin
 if p_limit not between 1 and 1000 then raise exception 'invalid_limit' using errcode='PT400';end if;
 perform pg_advisory_xact_lock(71404,4);
 for r in select order_id from hardware_reservations where state='held' and expires_at<=clock_timestamp() order by expires_at,id limit p_limit loop
 perform hardware_reservation_finish(r.order_id,'expired','system:reservation-expiry','Reservation TTL elapsed');n:=n+1;end loop;
 return n;
end $$;
create function hardware_reservation_hold(p_order uuid,p_key text,p_actor text,p_ttl integer default 900) returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare o hardware_orders%rowtype; r hardware_reservations%rowtype; l record; q jsonb; current_line jsonb; h text; old_qty integer;
begin
 if p_key is null or p_key !~ '^[A-Za-z0-9_-]{16,128}$' or p_ttl not between 60 and 1800 then raise exception 'invalid_reservation' using errcode='PT400';end if;
 perform pg_advisory_xact_lock(71404,4);
 perform hardware_reservation_expire(1000);
 select * into o from hardware_orders where id=p_order for update;
 if not found then raise exception 'order_not_found' using errcode='PT404';end if;
 h:=encode(sha256(convert_to(p_order::text||':'||p_ttl::text,'UTF8')),'hex');
 select * into r from hardware_reservations where order_id=p_order;
 if found then
 if r.idempotency_key<>p_key or r.request_hash<>h then raise exception 'idempotency_conflict' using errcode='PT409';end if;
 return jsonb_build_object('id',r.id,'state',r.state,'expires_at',r.expires_at,'replayed',true);end if;
 if o.order_state<>'awaiting_confirmation' or o.payment_state<>'not_started' or o.reservation_state<>'not_reserved' then raise exception 'order_not_eligible' using errcode='PT409';end if;
 -- Quote checks independently approved price, current public version, sourcing and quantities under product/variant locks.
 select jsonb_agg(jsonb_build_object('variant_id',variant_id,'quantity',quantity) order by variant_id) into q from hardware_order_lines where order_id=p_order;
 q:=hardware_checkout_quote(q);
 for l in select * from hardware_order_lines where order_id=p_order order by variant_id loop
 select x into current_line from jsonb_array_elements(q->'lines') x where x->>'variant_id'=l.variant_id::text;
 if current_line->>'product_version'<>l.product_version::text or current_line->>'unit_price_kobo'<>l.unit_price_kobo::text or current_line->>'vat_rate_bp'<>l.vat_rate_bp::text or current_line->>'vat_treatment'<>l.vat_treatment or current_line->>'price_change_id'<>l.price_change_id::text then raise exception 'order_price_changed' using errcode='PT409';end if;
 end loop;
 -- Upgrade locks in the same stable order. A single DB mutex prevents shared-lock upgrade races between reservations.
 perform v.id from catalogue_variants v join hardware_order_lines ol on ol.variant_id=v.id where ol.order_id=p_order order by v.id for update of v;
 insert into hardware_reservations(order_id,idempotency_key,request_hash,actor,expires_at) values(p_order,p_key,h,p_actor,clock_timestamp()+make_interval(secs=>p_ttl)) returning * into r;
 for l in select * from hardware_order_lines where order_id=p_order order by variant_id loop
 select stock_reserved into old_qty from catalogue_variants where id=l.variant_id;
 insert into hardware_reservation_stock values(l.variant_id,old_qty) on conflict do nothing;
 insert into hardware_reservation_lines values(r.id,l.variant_id,l.quantity);
 update catalogue_variants set stock_reserved=stock_reserved+l.quantity,row_version=row_version+1,updated_at=now() where id=l.variant_id and stock_on_hand-stock_reserved>=l.quantity;
 if not found then raise exception 'stock_unavailable' using errcode='PT409';end if;
 insert into catalogue_inventory_changes(variant_id,field,old_value,new_value,actor,reason) values(l.variant_id,'stock_reserved',old_qty::text,(old_qty+l.quantity)::text,p_actor,'reservation:'||r.id::text||':1');
 end loop;
 update hardware_orders set reservation_state='held' where id=p_order;
 insert into hardware_reservation_events(reservation_id,row_version,event_type,actor) values(r.id,1,'held',p_actor);
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_reservation_held','hardware_reservation',r.id::text,jsonb_build_object('order_id',p_order,'row_version',1,'expires_at',r.expires_at));
 return jsonb_build_object('id',r.id,'state','held','expires_at',r.expires_at,'replayed',false);
end $$;
-- Allocation is deliberately fail-closed until Stage 4D installs verified, purpose/amount-bound payment evidence.
create function hardware_reservation_allocate(p_order uuid) returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare r hardware_reservations%rowtype;
begin
 perform pg_advisory_xact_lock(71404,4);
 perform 1 from hardware_orders where id=p_order for update;
 select * into r from hardware_reservations where order_id=p_order for update;
 if not found then raise exception 'reservation_not_found' using errcode='PT404';end if;
 if r.state='allocated' then return jsonb_build_object('id',r.id,'state','allocated','replayed',true);end if;
 if r.state<>'held' then raise exception 'reservation_not_held' using errcode='PT409';end if;
 if r.expires_at<=clock_timestamp() then return hardware_reservation_finish(p_order,'expired','system:reservation-expiry','Payment arrived after expiry');end if;
 if not hardware_reservation_payment_verified(p_order,r.id) then raise exception 'verified_order_payment_required' using errcode='PT409';end if;
 return hardware_reservation_finish(p_order,'allocated','system:verified-order-payment','Verified order payment allocation');
end $$;
create function hardware_reservation_staff(p_actor text,p_order uuid,p_key text,p_action text) returns jsonb language plpgsql set search_path=public,pg_temp as $$
begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.read');
 if p_action='hold' then perform hardware_order_require_actor(p_actor,'commerce.orders.create');return hardware_reservation_hold(p_order,p_key,p_actor,900);
 elsif p_action='release' then perform hardware_order_require_actor(p_actor,'commerce.orders.cancel');return hardware_reservation_finish(p_order,'released',p_actor,'Staff release');
 else raise exception 'invalid_reservation_action' using errcode='PT400';end if;
end $$;
create function hardware_reservation_checkout(p_client text,p_guest_hash text,p_key text,p_request jsonb,p_quote_hash text) returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare result jsonb; hold jsonb;
begin
 perform pg_advisory_xact_lock(71404,4);perform hardware_reservation_expire(1000);
 result:=hardware_checkout_submit(p_client,p_guest_hash,p_key,p_request,p_quote_hash);
 hold:=hardware_reservation_hold((result->>'id')::uuid,p_key,'checkout:'||p_client,900);
 return result||jsonb_build_object('reservation',hold,'payment_eligible',false);
end $$;
create or replace function hardware_reservation_cancel_core(p_actor text,p_id uuid,p_expected integer) returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare o hardware_orders%rowtype;
begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.cancel');
 select * into o from hardware_orders where id=p_id for update;
 if not found then raise exception 'order_not_found' using errcode='PT404'; end if;
 if o.order_state='cancelled' and o.row_version=p_expected+1 then return jsonb_build_object('id',o.id,'row_version',o.row_version,'order_state',o.order_state,'replayed',true); end if;
 if o.reservation_state='allocated' then raise exception 'allocated_order_requires_refund_workflow' using errcode='PT409';end if;
 if o.row_version<>p_expected or o.order_state<>'awaiting_confirmation' then raise exception 'order_state_changed' using errcode='PT409'; end if;
 update hardware_orders set order_state='cancelled',row_version=row_version+1,updated_at=now() where id=p_id returning * into o;
 insert into hardware_order_events(order_id,event_type,row_version,actor) values(o.id,'cancelled',o.row_version,p_actor);
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_order_cancelled','hardware_order',o.id::text,jsonb_build_object('row_version',o.row_version));
 insert into crm_activities(contact_id,organization_id,opportunity_id,related_type,related_id,activity_type,title,source,actor,metadata) values(o.contact_id,o.organization_id,o.opportunity_id,'hardware_order',o.id::text,'hardware_order_cancelled','Hardware order cancelled','office',p_actor,jsonb_build_object('order_id',o.id));
 return jsonb_build_object('id',o.id,'row_version',o.row_version,'order_state',o.order_state);
end $$;
create or replace function hardware_order_cancel(p_actor text,p_id uuid,p_expected integer) returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare o hardware_orders%rowtype; result jsonb;
begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.cancel');perform pg_advisory_xact_lock(71404,4);
 select * into o from hardware_orders where id=p_id for update;
 if not found then raise exception 'order_not_found' using errcode='PT404';end if;
 if o.reservation_state='allocated' then raise exception 'allocated_order_requires_refund_workflow' using errcode='PT409';end if;
 if o.row_version<>p_expected and not (o.order_state='cancelled' and o.row_version=p_expected+1) then raise exception 'order_state_changed' using errcode='PT409';end if;
 perform hardware_reservation_finish(p_id,'released',p_actor,'Order cancelled');
 result:=hardware_reservation_cancel_core(p_actor,p_id,p_expected);return result;
end $$;
create or replace function hardware_reservation_inventory_core(p_variant_id uuid, p_expected_row_version integer, p_patch jsonb, p_actor text, p_reason text)
returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare o catalogue_variants%rowtype; v catalogue_variants%rowtype; f text;
begin
  select * into o from catalogue_variants where id = p_variant_id and row_version = p_expected_row_version for update;
  if not found then
    if not exists (select 1 from catalogue_variants where id = p_variant_id) then raise exception 'variant_not_found' using errcode = 'PT404'; end if;
    raise exception 'state_changed' using errcode = 'PT409', detail = (select jsonb_build_object('id', id, 'row_version', row_version) from catalogue_variants where id = p_variant_id)::text;
  end if;
  update catalogue_variants set
    stock_on_hand = case when p_patch ? 'stock_on_hand' then (p_patch->>'stock_on_hand')::integer else stock_on_hand end,
    stock_reserved = case when p_patch ? 'stock_reserved' then (p_patch->>'stock_reserved')::integer else stock_reserved end,
    sourcing = case when p_patch ? 'sourcing' then p_patch->>'sourcing' else sourcing end,
    lead_time_days_min = case when p_patch ? 'lead_time_days_min' then (p_patch->>'lead_time_days_min')::integer else lead_time_days_min end,
    lead_time_days_max = case when p_patch ? 'lead_time_days_max' then (p_patch->>'lead_time_days_max')::integer else lead_time_days_max end,
    status = case when p_patch ? 'status' then p_patch->>'status' else status end,
    supplier_id = case when p_patch ? 'supplier_id' then nullif(p_patch->>'supplier_id', '') else supplier_id end,
    row_version = row_version + 1, updated_at = now()
  where id = p_variant_id and row_version = p_expected_row_version
  returning * into v;
  foreach f in array array['stock_on_hand', 'stock_reserved', 'sourcing', 'lead_time_days_min', 'lead_time_days_max', 'status', 'supplier_id'] loop
    if (to_jsonb(o)->>f) is distinct from (to_jsonb(v)->>f) then
      insert into catalogue_inventory_changes (variant_id, field, old_value, new_value, actor, reason) values (v.id, f, to_jsonb(o)->>f, to_jsonb(v)->>f, p_actor, coalesce(p_reason, ''));
    end if;
  end loop;
  return to_jsonb(v);
end $f$;

create or replace function catalogue_update_inventory(p_variant_id uuid,p_expected_row_version integer,p_patch jsonb,p_actor text,p_reason text) returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare managed integer;
begin
 perform pg_advisory_xact_lock(71404,4);
 -- Do not sweep here: a caller's expected inventory revision must not silently change under it.
 perform 1 from catalogue_variants where id=p_variant_id for update;
 if p_patch ? 'stock_reserved' and exists(select 1 from hardware_reservation_stock where variant_id=p_variant_id) then
 select coalesce(sum(l.quantity),0) into managed from hardware_reservation_lines l join hardware_reservations r on r.id=l.reservation_id where l.variant_id=p_variant_id and r.state='held';
 if (p_patch->>'stock_reserved')::integer<managed then raise exception 'reserved_stock_protected' using errcode='PT409';end if;
 update hardware_reservation_stock set legacy_reserved=(p_patch->>'stock_reserved')::integer-managed where variant_id=p_variant_id;
 end if;
 return hardware_reservation_inventory_core(p_variant_id,p_expected_row_version,p_patch,p_actor,p_reason);
end $$;
create function hardware_reservation_status(p_client text,p_guest_hash text,p_id uuid) returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare result jsonb; reservation jsonb;
begin
 result:=hardware_checkout_get(p_client,p_guest_hash,p_id);if result is null then return null;end if;
 perform hardware_reservation_expire(1000);
 select jsonb_build_object('id',id,'state',state,'expires_at',expires_at) into reservation from hardware_reservations where order_id=p_id;
 return result||jsonb_build_object('reservation',reservation);
end $$;
do $$declare f regprocedure;begin
 for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname like 'hardware_reservation_%' loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);execute format('grant execute on function %s to service_role',f);
 end loop;
end $$;
