-- LOCAL Phase 5A. Apply explicitly AFTER Stage 4E (financial operations), transactionally. NOT for production databases.
-- Additive post-payment fulfilment lifecycle. It does not change hardware_orders, payments, reservations or inventory:
--   hardware_orders.fulfilment_state keeps its Phase 4 meaning (inventory 'allocated' at verified payment, exactly once);
--   the lifecycle below is a separate, append-only record per paid order.
-- Lifecycle: paid (implicit: verified, allocated, no lifecycle row yet) -> packed -> dispatched -> delivered
--            -> installed (only when the order requested installation) -> closed.
-- Delivery and installation are distinct events; orders without installation close directly after delivery.

create table hardware_fulfilments (
 order_id uuid primary key references hardware_orders(id) on delete restrict,
 state text not null check(state in ('packed','dispatched','delivered','installed','closed')),
 installation_required boolean not null,
 row_version integer not null check(row_version between 1 and 5),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 check(installation_required or state<>'installed'),
 check(row_version<=case when installation_required then 5 else 4 end)
);
create table hardware_fulfilment_events (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references hardware_orders(id) on delete restrict,
 row_version integer not null check(row_version between 1 and 5),
 from_state text not null check(from_state in ('paid','packed','dispatched','delivered','installed')),
 to_state text not null check(to_state in ('packed','dispatched','delivered','installed','closed')),
 actor text not null,
 authorization_scope text not null check(authorization_scope='commerce.orders.fulfilment.manage'),
 reason text not null default '' check(length(reason)<=500),
 -- Reserved for Phase 5B/5C references (delivery record, proof of delivery, technician job). Empty in 5A.
 detail jsonb not null default '{}'::jsonb check(detail='{}'::jsonb),
 created_at timestamptz not null default clock_timestamp(),
 unique(order_id,row_version)
);
create table hardware_fulfilment_assignments (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references hardware_orders(id) on delete restrict,
 assignment_role text not null check(assignment_role in ('fulfilment','delivery','technician')),
 sequence integer not null check(sequence>0),
 assignee text check(assignee is null or assignee=lower(assignee)),
 actor text not null,
 reason text not null default '' check(length(reason)<=500),
 created_at timestamptz not null default clock_timestamp(),
 unique(order_id,assignment_role,sequence)
);
-- Office-managed configuration. Versioned and append-only; nothing in 5A prices an order from it,
-- and no public booking reads it. No production values are seeded.
create table hardware_fulfilment_settings (
 setting_key text not null check(setting_key in ('delivery_fees','installation_fees','coverage_areas')),
 version integer not null check(version>0),
 value jsonb not null check(jsonb_typeof(value)='object'),
 actor text not null,
 reason text not null check(length(reason) between 8 and 500),
 created_at timestamptz not null default clock_timestamp(),
 primary key(setting_key,version)
);
create index hardware_fulfilment_events_order_idx on hardware_fulfilment_events(order_id,row_version);
create index hardware_fulfilments_state_idx on hardware_fulfilments(state,updated_at desc);

do $$declare t text;begin
 foreach t in array array['hardware_fulfilments','hardware_fulfilment_events','hardware_fulfilment_assignments','hardware_fulfilment_settings'] loop
  execute format('alter table %I enable row level security',t);
  execute format('revoke all on %I from public,anon,authenticated,service_role',t);
  execute format('grant select,insert on %I to service_role',t);
  execute format('create trigger fulfilment_no_truncate before truncate on %I execute function hardware_order_immutable()',t);
  if t<>'hardware_fulfilments' then
   execute format('create trigger fulfilment_immutable before update or delete on %I for each row execute function hardware_order_immutable()',t);
  end if;
 end loop;end$$;
grant update on hardware_fulfilments to service_role;

create function hardware_fulfilment_next_allowed(p_from text,p_to text,p_installation boolean) returns boolean
 language sql immutable set search_path=public,pg_temp as $$
 select (p_from,p_to) in (('paid','packed'),('packed','dispatched'),('dispatched','delivered'),('installed','closed'))
  or (p_from='delivered' and p_to='installed' and p_installation)
  or (p_from='delivered' and p_to='closed' and not p_installation)$$;

-- Row guard: only one forward step at a time; installation requirement is fixed at the first step.
create function hardware_fulfilment_guard() returns trigger language plpgsql set search_path=public,pg_temp as $$begin
 if tg_op='INSERT' then
  if new.state<>'packed' or new.row_version<>1 then raise exception 'invalid_fulfilment_transition' using errcode='PT409';end if;
  return new;end if;
 if tg_op<>'UPDATE' or (to_jsonb(new)-array['state','row_version','updated_at']) is distinct from (to_jsonb(old)-array['state','row_version','updated_at'])
  or new.row_version<>old.row_version+1 or not hardware_fulfilment_next_allowed(old.state,new.state,old.installation_required) then
  raise exception 'invalid_fulfilment_transition' using errcode='PT409';end if;
 return new;end$$;
create trigger fulfilment_state_guard before insert or update or delete on hardware_fulfilments for each row execute function hardware_fulfilment_guard();

create function hardware_fulfilment_eligible(p_order uuid) returns boolean language sql stable set search_path=public,pg_temp as $$
 select exists(select 1 from hardware_orders o join hardware_reservations r on r.order_id=o.id
  where o.id=p_order and o.order_state='awaiting_confirmation' and o.payment_state='paid' and o.reservation_state='allocated'
  and o.fulfilment_state='allocated' and r.state='allocated' and hardware_reservation_payment_verified(o.id,r.id))
 and not exists(select 1 from hardware_refund_requests q where q.order_id=p_order)$$;

create function hardware_fulfilment_transition(p_actor text,p_order uuid,p_expected integer,p_to text,p_reason text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare o hardware_orders%rowtype; f hardware_fulfilments%rowtype; cur text; ver integer; inst boolean; reason text:=coalesce(p_reason,'');
begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.fulfilment.manage');
 if p_order is null or p_expected is null or p_expected not between 0 and 4 or p_to is null
  or p_to not in ('packed','dispatched','delivered','installed','closed') or length(reason)>500 then
  raise exception 'invalid_fulfilment_input' using errcode='PT400';end if;
 -- Serialize all lifecycle writes for one order on the order row (the payment path locks the same row).
 select * into o from hardware_orders where id=p_order for update;
 if not found then raise exception 'order_not_found' using errcode='PT404';end if;
 select * into f from hardware_fulfilments where order_id=p_order for update;
 cur:=coalesce(f.state,'paid'); ver:=coalesce(f.row_version,0);
 if f.order_id is not null and f.row_version=p_expected+1 and f.state=p_to then
  return jsonb_build_object('order_id',p_order,'state',f.state,'row_version',f.row_version,'installation_required',f.installation_required,'replayed',true);end if;
 if ver<>p_expected then raise exception 'fulfilment_state_changed' using errcode='PT409';end if;
 -- Only a verified, allocated, unrefunded payment can be fulfilled. Nothing here can set payment or allocation state.
 if not hardware_fulfilment_eligible(p_order) then raise exception 'order_not_paid_and_allocated' using errcode='PT409';end if;
 inst:=coalesce(f.installation_required,o.installation_requested);
 if not hardware_fulfilment_next_allowed(cur,p_to,inst) then raise exception 'invalid_fulfilment_transition' using errcode='PT409';end if;
 if p_to='closed' and length(trim(reason))<3 then raise exception 'closing_reason_required' using errcode='PT400';end if;
 if f.order_id is null then
  insert into hardware_fulfilments(order_id,state,installation_required,row_version) values(p_order,p_to,inst,1) returning * into f;
 else
  update hardware_fulfilments set state=p_to,row_version=row_version+1,updated_at=clock_timestamp() where order_id=p_order returning * into f;
 end if;
 insert into hardware_fulfilment_events(order_id,row_version,from_state,to_state,actor,authorization_scope,reason)
  values(p_order,f.row_version,cur,p_to,p_actor,'commerce.orders.fulfilment.manage',reason);
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_fulfilment_'||p_to,'hardware_order',p_order::text,
  jsonb_build_object('row_version',f.row_version,'from_state',cur,'to_state',p_to,'authorization','commerce.orders.fulfilment.manage'));
 insert into crm_activities(contact_id,organization_id,opportunity_id,related_type,related_id,activity_type,title,source,actor,metadata)
  values(o.contact_id,o.organization_id,o.opportunity_id,'hardware_order',p_order::text,'hardware_fulfilment_'||p_to,'Hardware order '||p_to,'office',p_actor,
  jsonb_build_object('order_id',p_order,'row_version',f.row_version));
 return jsonb_build_object('order_id',p_order,'state',f.state,'row_version',f.row_version,'installation_required',f.installation_required,'replayed',false);
end$$;

create function hardware_fulfilment_assign(p_actor text,p_order uuid,p_role text,p_expected_sequence integer,p_assignee text,p_reason text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare a text:=nullif(lower(trim(coalesce(p_assignee,''))),''); seq integer; inst boolean;
begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.fulfilment.manage');
 if p_order is null or p_role is null or p_role not in ('fulfilment','delivery','technician') or p_expected_sequence is null or p_expected_sequence<0
  or length(coalesce(p_reason,''))>500 then raise exception 'invalid_fulfilment_input' using errcode='PT400';end if;
 perform 1 from hardware_orders where id=p_order for update;
 if not found then raise exception 'order_not_found' using errcode='PT404';end if;
 if not hardware_fulfilment_eligible(p_order) then raise exception 'order_not_paid_and_allocated' using errcode='PT409';end if;
 if exists(select 1 from hardware_fulfilments where order_id=p_order and state='closed') then raise exception 'fulfilment_closed' using errcode='PT409';end if;
 select coalesce(f.installation_required,o.installation_requested) into inst from hardware_orders o left join hardware_fulfilments f on f.order_id=o.id where o.id=p_order;
 if p_role='technician' and not inst then raise exception 'installation_not_requested' using errcode='PT409';end if;
 if a is not null and not exists(select 1 from admin_users where lower(email)=a and status='active' and removed_at is null and role in ('super_admin','ochiga_admin','ochiga_staff')) then
  raise exception 'assignee_not_active_staff' using errcode='PT400';end if;
 select coalesce(max(sequence),0) into seq from hardware_fulfilment_assignments where order_id=p_order and assignment_role=p_role;
 if seq<>p_expected_sequence then raise exception 'assignment_changed' using errcode='PT409';end if;
 insert into hardware_fulfilment_assignments(order_id,assignment_role,sequence,assignee,actor,reason) values(p_order,p_role,seq+1,a,p_actor,coalesce(p_reason,''));
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_fulfilment_assigned','hardware_order',p_order::text,
  jsonb_build_object('assignment_role',p_role,'sequence',seq+1,'assignee',a));
 return jsonb_build_object('order_id',p_order,'assignment_role',p_role,'sequence',seq+1,'assignee',a);
end$$;

-- Shape validation only (no business values). Amounts are integer kobo; VAT in basis points.
create function hardware_fulfilment_setting_valid(p_key text,v jsonb) returns boolean language plpgsql immutable set search_path=public,pg_temp as $$
declare x jsonb; codes text[]:='{}';
begin
 if jsonb_typeof(v) is distinct from 'object' then return false;end if;
 if p_key in ('delivery_fees','installation_fees') then
  if (v-array['currency',case when p_key='delivery_fees' then 'zones' else 'services' end])<>'{}'::jsonb or v->>'currency' is distinct from 'NGN'
   or jsonb_typeof(v->(case when p_key='delivery_fees' then 'zones' else 'services' end)) is distinct from 'array'
   or jsonb_array_length(v->(case when p_key='delivery_fees' then 'zones' else 'services' end))>100 then return false;end if;
  for x in select value from jsonb_array_elements(v->(case when p_key='delivery_fees' then 'zones' else 'services' end)) loop
   if jsonb_typeof(x) is distinct from 'object' or coalesce(x->>'code','') !~ '^[a-z0-9_-]{2,40}$' or x->>'code'=any(codes)
    or jsonb_typeof(x->'label') is distinct from 'string' or length(x->>'label') not between 1 and 80
    or jsonb_typeof(x->'fee_kobo') is distinct from 'number' or (x->>'fee_kobo') !~ '^[0-9]{1,9}$'
    or jsonb_typeof(x->'vat_rate_bp') is distinct from 'number' or (x->>'vat_rate_bp') !~ '^[0-9]{1,5}$' or (x->>'vat_rate_bp')::integer>10000 then return false;end if;
   if p_key='delivery_fees' and ((x-array['code','label','fee_kobo','vat_rate_bp','states'])<>'{}'::jsonb or jsonb_typeof(x->'states') is distinct from 'array'
    or jsonb_array_length(x->'states') not between 1 and 40 or exists(select 1 from jsonb_array_elements(x->'states') s where jsonb_typeof(s)<>'string' or length(s#>>'{}') not between 2 and 60)) then return false;end if;
   if p_key='installation_fees' and ((x-array['code','label','fee_kobo','vat_rate_bp','per'])<>'{}'::jsonb or x->>'per' is null or x->>'per' not in ('order','unit')) then return false;end if;
   codes:=codes||(x->>'code');
  end loop;
  return true;
 end if;
 if p_key='coverage_areas' then
  if (v-'areas')<>'{}'::jsonb or jsonb_typeof(v->'areas') is distinct from 'array' or jsonb_array_length(v->'areas')>100 then return false;end if;
  for x in select value from jsonb_array_elements(v->'areas') loop
   if jsonb_typeof(x) is distinct from 'object' or (x-array['state','cities','delivery','installation','inspection'])<>'{}'::jsonb
    or jsonb_typeof(x->'state') is distinct from 'string' or length(x->>'state') not between 2 and 60 or x->>'state'=any(codes)
    or jsonb_typeof(x->'cities') is distinct from 'array' or jsonb_array_length(x->'cities')>200
    or exists(select 1 from jsonb_array_elements(x->'cities') c where jsonb_typeof(c)<>'string' or length(c#>>'{}') not between 2 and 60)
    or jsonb_typeof(x->'delivery') is distinct from 'boolean' or jsonb_typeof(x->'installation') is distinct from 'boolean' or jsonb_typeof(x->'inspection') is distinct from 'boolean' then return false;end if;
   codes:=codes||(x->>'state');
  end loop;
  return true;
 end if;
 return false;
end$$;

create function hardware_fulfilment_setting_set(p_actor text,p_key text,p_expected_version integer,p_value jsonb,p_reason text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare cur integer;
begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.fulfilment.configure');
 if p_key is null or p_key not in ('delivery_fees','installation_fees','coverage_areas') or p_expected_version is null or p_expected_version<0
  or length(coalesce(p_reason,'')) not between 8 and 500 or not hardware_fulfilment_setting_valid(p_key,p_value) then
  raise exception 'invalid_fulfilment_setting' using errcode='PT400';end if;
 perform pg_advisory_xact_lock(71405,hashtext(p_key));
 select coalesce(max(version),0) into cur from hardware_fulfilment_settings where setting_key=p_key;
 if cur<>p_expected_version then raise exception 'setting_changed' using errcode='PT409';end if;
 insert into hardware_fulfilment_settings(setting_key,version,value,actor,reason) values(p_key,cur+1,p_value,p_actor,p_reason);
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_fulfilment_setting_changed','hardware_fulfilment_setting',p_key,
  jsonb_build_object('version',cur+1));
 return jsonb_build_object('setting_key',p_key,'version',cur+1);
end$$;

-- Every commit: the lifecycle row, its event chain, the payment/allocation facts and the audit/CRM evidence agree.
create function hardware_fulfilment_consistency() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare oid uuid; f hardware_fulfilments%rowtype; o hardware_orders%rowtype;
begin
 oid:=(to_jsonb(new)->>'order_id')::uuid;
 select * into f from hardware_fulfilments where order_id=oid; select * into o from hardware_orders where id=oid;
 if f.order_id is null then
  if exists(select 1 from hardware_fulfilment_events where order_id=oid) then raise exception 'fulfilment_integrity_violation' using errcode='PT409';end if;
  return null;end if;
 if f.installation_required<>o.installation_requested or o.payment_state<>'paid' or o.reservation_state<>'allocated' or o.fulfilment_state<>'allocated'
  or (select count(*) from hardware_fulfilment_events where order_id=oid)<>f.row_version
  or not exists(select 1 from hardware_fulfilment_events where order_id=oid and row_version=f.row_version and to_state=f.state)
  or not exists(select 1 from hardware_fulfilment_events where order_id=oid and row_version=1 and from_state='paid')
  or exists(select 1 from hardware_fulfilment_events e where e.order_id=oid and (
       not hardware_fulfilment_next_allowed(e.from_state,e.to_state,f.installation_required)
    or (e.row_version>1 and not exists(select 1 from hardware_fulfilment_events p where p.order_id=oid and p.row_version=e.row_version-1 and p.to_state=e.from_state))
    or not exists(select 1 from audit_events a where a.target_type='hardware_order' and a.target_id=oid::text and a.action='hardware_fulfilment_'||e.to_state
       and a.actor_email=e.actor and (a.metadata->>'row_version')::integer=e.row_version)
    or not exists(select 1 from crm_activities c where c.related_type='hardware_order' and c.related_id=oid::text and c.activity_type='hardware_fulfilment_'||e.to_state
       and c.actor=e.actor and (c.metadata->>'row_version')::integer=e.row_version))) then
  raise exception 'fulfilment_integrity_violation' using errcode='PT409';end if;
 return null;
end$$;
do $$declare t text;begin foreach t in array array['hardware_fulfilments','hardware_fulfilment_events'] loop
 execute format('create constraint trigger fulfilment_consistency after insert or update on %I deferrable initially deferred for each row execute function hardware_fulfilment_consistency()',t);
end loop;end$$;

do $$declare f regprocedure;begin
 for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname like 'hardware_fulfilment_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f);
  execute format('grant execute on function %s to service_role',f);
 end loop;end$$;
