-- LOCAL Phase 5B. Apply explicitly AFTER Phase 5A, transactionally. NOT for production databases.
-- Delivery record per paid, allocated order: dispatch details, status, tracking, failed attempts, holds, proof of delivery
-- (files stored through the existing Office storage service / office_files) and recipient acknowledgement.
-- Integration with 5A: the fulfilment steps 'dispatched' and 'delivered' can now only be made by the delivery functions,
-- which perform them in the same transaction. Orders, payments, reservations and inventory are not modified.
-- Customer notifications and public tracking do not exist here.

alter table hardware_fulfilment_events drop constraint hardware_fulfilment_events_authorization_scope_check;
alter table hardware_fulfilment_events add constraint hardware_fulfilment_events_authorization_scope_check
 check(authorization_scope in ('commerce.orders.fulfilment.manage','commerce.orders.delivery.manage'));

create table hardware_deliveries (
 order_id uuid primary key references hardware_orders(id) on delete restrict,
 state text not null check(state in ('scheduled','out_for_delivery','failed','on_hold','delivered')),
 method text not null check(method in ('own_fleet','courier','customer_pickup')),
 courier_name text check(courier_name is null or length(courier_name) between 2 and 80),
 tracking_reference text check(tracking_reference is null or tracking_reference ~ '^[A-Za-z0-9._/-]{3,64}$'),
 tracking_url text check(tracking_url is null or tracking_url ~ '^https://[A-Za-z0-9.-]+(/[^[:space:]<>"]{0,250})?$'),
 scheduled_for date,
 instructions text check(instructions is null or length(instructions)<=500),
 attempt_count integer not null default 0 check(attempt_count between 0 and 10),
 hold_return_state text check(hold_return_state is null or hold_return_state in ('scheduled','failed')),
 recipient_name text check(recipient_name is null or length(recipient_name) between 2 and 120),
 recipient_relationship text check(recipient_relationship is null or recipient_relationship in ('customer','household_member','colleague','security_or_reception','other')),
 delivered_at timestamptz,
 row_version integer not null check(row_version>0),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 check((state='delivered')=(delivered_at is not null and recipient_name is not null and recipient_relationship is not null)),
 check((state='on_hold')=(hold_return_state is not null)),
 check(method<>'courier' or courier_name is not null)
);
create table hardware_delivery_events (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references hardware_orders(id) on delete restrict,
 row_version integer not null check(row_version>0),
 event_type text not null check(event_type in ('scheduled','details_updated','dispatched','attempt_failed','rescheduled','held','released','proof_added','delivered')),
 from_state text check(from_state is null or from_state in ('scheduled','out_for_delivery','failed','on_hold','delivered')),
 to_state text not null check(to_state in ('scheduled','out_for_delivery','failed','on_hold','delivered')),
 actor text not null,
 authorization_scope text not null check(authorization_scope='commerce.orders.delivery.manage'),
 reason text not null default '' check(length(reason)<=500),
 detail jsonb not null default '{}'::jsonb check(jsonb_typeof(detail)='object'),
 created_at timestamptz not null default clock_timestamp(),
 unique(order_id,row_version)
);
create table hardware_delivery_proofs (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references hardware_orders(id) on delete restrict,
 file_id text not null unique references office_files(id) on delete restrict,
 kind text not null check(kind in ('photo','signature')),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 mime_type text not null check(mime_type='image/webp'),
 bytes integer not null check(bytes between 1 and 15728640),
 actor text not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(order_id,sha256)
);
create index hardware_delivery_events_order_idx on hardware_delivery_events(order_id,row_version);
create index hardware_deliveries_state_idx on hardware_deliveries(state,scheduled_for);

do $$declare t text;begin
 foreach t in array array['hardware_deliveries','hardware_delivery_events','hardware_delivery_proofs'] loop
  execute format('alter table %I enable row level security',t);
  execute format('revoke all on %I from public,anon,authenticated,service_role',t);
  execute format('grant select,insert on %I to service_role',t);
  execute format('create trigger delivery_no_truncate before truncate on %I execute function hardware_order_immutable()',t);
  if t<>'hardware_deliveries' then
   execute format('create trigger delivery_immutable before update or delete on %I for each row execute function hardware_order_immutable()',t);
  end if;
 end loop;end$$;
grant update on hardware_deliveries to service_role;

-- Allowed state moves (the database is the authority).
create function hardware_delivery_move_allowed(p_from text,p_to text,p_event text) returns boolean language sql immutable set search_path=public,pg_temp as $$
 select (p_from,p_to,p_event) in (
  (null,'scheduled','scheduled'),('scheduled','scheduled','details_updated'),('scheduled','out_for_delivery','dispatched'),
  ('out_for_delivery','failed','attempt_failed'),('failed','scheduled','rescheduled'),
  ('scheduled','on_hold','held'),('failed','on_hold','held'),('on_hold','scheduled','released'),('on_hold','failed','released'),
  ('out_for_delivery','out_for_delivery','proof_added'),('delivered','delivered','proof_added'),('out_for_delivery','delivered','delivered'))$$;

create function hardware_delivery_guard() returns trigger language plpgsql set search_path=public,pg_temp as $$begin
 if tg_op='INSERT' then
  if new.state<>'scheduled' or new.row_version<>1 then raise exception 'invalid_delivery_transition' using errcode='PT409';end if;
  return new;end if;
 if tg_op<>'UPDATE' or new.row_version<>old.row_version+1 or old.state='delivered' and new.state<>'delivered'
  or (new.state<>old.state and not exists(select 1 from (values('scheduled','out_for_delivery'),('out_for_delivery','failed'),('failed','scheduled'),('scheduled','on_hold'),('failed','on_hold'),('on_hold','scheduled'),('on_hold','failed'),('out_for_delivery','delivered')) m(f,t) where m.f=old.state and m.t=new.state))
  or (old.state='delivered' and (to_jsonb(new)-array['row_version','updated_at']) is distinct from (to_jsonb(old)-array['row_version','updated_at'])) then
  raise exception 'invalid_delivery_transition' using errcode='PT409';end if;
 return new;end$$;
create trigger delivery_state_guard before insert or update or delete on hardware_deliveries for each row execute function hardware_delivery_guard();

-- 5A fulfilment step without the 5A permission check: called by the 5A wrapper (fulfilment.manage) and by the delivery
-- functions (delivery.manage). Same eligibility, versioning, event, audit and CRM rules as 5A.
create function hardware_fulfilment_step(p_actor text,p_order uuid,p_expected integer,p_to text,p_reason text,p_scope text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare o hardware_orders%rowtype; f hardware_fulfilments%rowtype; cur text; ver integer; inst boolean; reason text:=coalesce(p_reason,'');
begin
 if p_scope not in ('commerce.orders.fulfilment.manage','commerce.orders.delivery.manage') or p_order is null or p_expected is null or p_expected not between 0 and 4
  or p_to is null or p_to not in ('packed','dispatched','delivered','installed','closed') or length(reason)>500 then
  raise exception 'invalid_fulfilment_input' using errcode='PT400';end if;
 select * into o from hardware_orders where id=p_order for update;
 if not found then raise exception 'order_not_found' using errcode='PT404';end if;
 select * into f from hardware_fulfilments where order_id=p_order for update;
 cur:=coalesce(f.state,'paid'); ver:=coalesce(f.row_version,0);
 if f.order_id is not null and f.row_version=p_expected+1 and f.state=p_to then
  return jsonb_build_object('order_id',p_order,'state',f.state,'row_version',f.row_version,'installation_required',f.installation_required,'replayed',true);end if;
 if ver<>p_expected then raise exception 'fulfilment_state_changed' using errcode='PT409';end if;
 if not hardware_fulfilment_eligible(p_order) then raise exception 'order_not_paid_and_allocated' using errcode='PT409';end if;
 inst:=coalesce(f.installation_required,o.installation_requested);
 if not hardware_fulfilment_next_allowed(cur,p_to,inst) then raise exception 'invalid_fulfilment_transition' using errcode='PT409';end if;
 if p_to='closed' and length(trim(reason))<3 then raise exception 'closing_reason_required' using errcode='PT400';end if;
 if f.order_id is null then
  insert into hardware_fulfilments(order_id,state,installation_required,row_version) values(p_order,p_to,inst,1) returning * into f;
 else
  update hardware_fulfilments set state=p_to,row_version=row_version+1,updated_at=clock_timestamp() where order_id=p_order returning * into f;
 end if;
 insert into hardware_fulfilment_events(order_id,row_version,from_state,to_state,actor,authorization_scope,reason) values(p_order,f.row_version,cur,p_to,p_actor,p_scope,reason);
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_fulfilment_'||p_to,'hardware_order',p_order::text,
  jsonb_build_object('row_version',f.row_version,'from_state',cur,'to_state',p_to,'authorization',p_scope));
 insert into crm_activities(contact_id,organization_id,opportunity_id,related_type,related_id,activity_type,title,source,actor,metadata)
  values(o.contact_id,o.organization_id,o.opportunity_id,'hardware_order',p_order::text,'hardware_fulfilment_'||p_to,'Hardware order '||p_to,'office',p_actor,
  jsonb_build_object('order_id',p_order,'row_version',f.row_version));
 return jsonb_build_object('order_id',p_order,'state',f.state,'row_version',f.row_version,'installation_required',f.installation_required,'replayed',false);
end$$;

-- 5A entry point, unchanged contract, except that dispatch and delivery now belong to the delivery record.
create or replace function hardware_fulfilment_transition(p_actor text,p_order uuid,p_expected integer,p_to text,p_reason text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.fulfilment.manage');
 if p_to in ('dispatched','delivered') then raise exception 'use_delivery_record' using errcode='PT409';end if;
 return hardware_fulfilment_step(p_actor,p_order,p_expected,p_to,p_reason,'commerce.orders.fulfilment.manage');
end$$;

-- Shared bookkeeping for one delivery event.
create function hardware_delivery_record(p_actor text,p_order uuid,p_event text,p_from text,p_to text,p_version integer,p_reason text,p_detail jsonb) returns void
 language plpgsql set search_path=public,pg_temp as $$
declare o hardware_orders%rowtype;
begin
 select * into o from hardware_orders where id=p_order;
 insert into hardware_delivery_events(order_id,row_version,event_type,from_state,to_state,actor,authorization_scope,reason,detail)
  values(p_order,p_version,p_event,p_from,p_to,p_actor,'commerce.orders.delivery.manage',coalesce(p_reason,''),coalesce(p_detail,'{}'::jsonb));
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_delivery_'||p_event,'hardware_order',p_order::text,
  jsonb_build_object('row_version',p_version,'from_state',p_from,'to_state',p_to,'authorization','commerce.orders.delivery.manage'));
 insert into crm_activities(contact_id,organization_id,opportunity_id,related_type,related_id,activity_type,title,source,actor,metadata)
  values(o.contact_id,o.organization_id,o.opportunity_id,'hardware_order',p_order::text,'hardware_delivery_'||p_event,'Delivery '||replace(p_event,'_',' '),'office',p_actor,
  jsonb_build_object('order_id',p_order,'row_version',p_version));
end$$;

-- Load and lock (order row first, matching the payment and fulfilment paths), check scope, eligibility and version.
create function hardware_delivery_begin(p_actor text,p_order uuid,p_expected integer,p_allow_missing boolean) returns hardware_deliveries
 language plpgsql set search_path=public,pg_temp as $$
declare d hardware_deliveries%rowtype;
begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.delivery.manage');
 if p_order is null or p_expected is null or p_expected<0 then raise exception 'invalid_delivery_input' using errcode='PT400';end if;
 perform 1 from hardware_orders where id=p_order for update;
 if not found then raise exception 'order_not_found' using errcode='PT404';end if;
 select * into d from hardware_deliveries where order_id=p_order for update;
 if d.order_id is null and not p_allow_missing then raise exception 'delivery_not_found' using errcode='PT404';end if;
 if coalesce(d.row_version,0)<>p_expected then raise exception 'delivery_state_changed' using errcode='PT409';end if;
 -- Refund requests and anything other than a verified, allocated payment stop every delivery action (safe default).
 if not hardware_fulfilment_eligible(p_order) then raise exception 'order_not_paid_and_allocated' using errcode='PT409';end if;
 return d;
end$$;

create function hardware_delivery_valid_details(p jsonb) returns boolean language plpgsql immutable set search_path=public,pg_temp as $$
begin
 return jsonb_typeof(p)='object' and (p-array['method','courier_name','tracking_reference','tracking_url','scheduled_for','instructions'])='{}'::jsonb
  and p->>'method' in ('own_fleet','courier','customer_pickup')
  and (p->>'method'<>'courier' or coalesce(length(trim(p->>'courier_name')),0) between 2 and 80)
  and (p->'courier_name' is null or jsonb_typeof(p->'courier_name') in ('string','null'))
  and (p->>'tracking_reference' is null or p->>'tracking_reference' ~ '^[A-Za-z0-9._/-]{3,64}$')
  and (p->>'tracking_url' is null or p->>'tracking_url' ~ '^https://[A-Za-z0-9.-]+(/[^[:space:]<>"]{0,250})?$')
  and (p->>'scheduled_for' is null or p->>'scheduled_for' ~ '^\d{4}-\d{2}-\d{2}$')
  and (p->>'instructions' is null or length(p->>'instructions')<=500);
end$$;

-- Create (expected 0) or update the dispatch details while scheduled.
create function hardware_delivery_schedule(p_actor text,p_order uuid,p_expected integer,p_details jsonb) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare d hardware_deliveries%rowtype; fs text; day date;
begin
 d:=hardware_delivery_begin(p_actor,p_order,p_expected,true);
 if not hardware_delivery_valid_details(p_details) then raise exception 'invalid_delivery_details' using errcode='PT400';end if;
 begin day:=nullif(p_details->>'scheduled_for','')::date; exception when others then raise exception 'invalid_delivery_date' using errcode='PT400'; end;
 if day is not null and (day<current_date or day>current_date+90) then raise exception 'invalid_delivery_date' using errcode='PT400';end if;
 select coalesce((select state from hardware_fulfilments where order_id=p_order),'paid') into fs;
 if d.order_id is null then
  if fs not in ('paid','packed') then raise exception 'invalid_delivery_transition' using errcode='PT409';end if;
  insert into hardware_deliveries(order_id,state,method,courier_name,tracking_reference,tracking_url,scheduled_for,instructions,row_version)
   values(p_order,'scheduled',p_details->>'method',nullif(trim(p_details->>'courier_name'),''),p_details->>'tracking_reference',p_details->>'tracking_url',day,p_details->>'instructions',1) returning * into d;
  perform hardware_delivery_record(p_actor,p_order,'scheduled',null,'scheduled',1,'',p_details);
 else
  if d.state<>'scheduled' then raise exception 'invalid_delivery_transition' using errcode='PT409';end if;
  update hardware_deliveries set method=p_details->>'method',courier_name=nullif(trim(p_details->>'courier_name'),''),tracking_reference=p_details->>'tracking_reference',
   tracking_url=p_details->>'tracking_url',scheduled_for=day,instructions=p_details->>'instructions',row_version=row_version+1,updated_at=clock_timestamp()
   where order_id=p_order returning * into d;
  perform hardware_delivery_record(p_actor,p_order,'details_updated','scheduled','scheduled',d.row_version,'',p_details);
 end if;
 return to_jsonb(d);
end$$;

-- Hand over to the driver/courier (or ready for pickup). The first dispatch performs fulfilment packed -> dispatched.
create function hardware_delivery_dispatch(p_actor text,p_order uuid,p_expected integer) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare d hardware_deliveries%rowtype; f hardware_fulfilments%rowtype; who text;
begin
 d:=hardware_delivery_begin(p_actor,p_order,p_expected,false);
 if d.state<>'scheduled' then raise exception 'invalid_delivery_transition' using errcode='PT409';end if;
 -- Safe default until the policy is decided: at most 3 attempts, then a manager decision is required.
 if d.attempt_count>=3 then raise exception 'delivery_attempts_exhausted' using errcode='PT409';end if;
 select assignee into who from hardware_fulfilment_assignments where order_id=p_order and assignment_role='delivery' order by sequence desc limit 1;
 if d.method<>'courier' and who is null then raise exception 'delivery_assignee_required' using errcode='PT409';end if;
 if d.method='courier' and d.tracking_reference is null then raise exception 'tracking_reference_required' using errcode='PT409';end if;
 select * into f from hardware_fulfilments where order_id=p_order for update;
 if coalesce(f.state,'paid')='packed' then perform hardware_fulfilment_step(p_actor,p_order,f.row_version,'dispatched','Dispatched with delivery record','commerce.orders.delivery.manage');
 elsif coalesce(f.state,'paid')<>'dispatched' then raise exception 'order_not_packed' using errcode='PT409';end if;
 update hardware_deliveries set state='out_for_delivery',row_version=row_version+1,updated_at=clock_timestamp() where order_id=p_order returning * into d;
 perform hardware_delivery_record(p_actor,p_order,'dispatched','scheduled','out_for_delivery',d.row_version,'',jsonb_build_object('attempt',d.attempt_count+1,'assignee',who));
 return to_jsonb(d);
end$$;

create function hardware_delivery_fail(p_actor text,p_order uuid,p_expected integer,p_reason_code text,p_note text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare d hardware_deliveries%rowtype;
begin
 d:=hardware_delivery_begin(p_actor,p_order,p_expected,false);
 if d.state<>'out_for_delivery' then raise exception 'invalid_delivery_transition' using errcode='PT409';end if;
 if p_reason_code is null or p_reason_code not in ('recipient_unavailable','address_issue','refused','access_denied','damaged_in_transit','other')
  or length(coalesce(p_note,''))>500 or (p_reason_code in ('refused','damaged_in_transit','other') and length(trim(coalesce(p_note,'')))<8) then
  raise exception 'invalid_failure_reason' using errcode='PT400';end if;
 update hardware_deliveries set state='failed',attempt_count=attempt_count+1,row_version=row_version+1,updated_at=clock_timestamp() where order_id=p_order returning * into d;
 perform hardware_delivery_record(p_actor,p_order,'attempt_failed','out_for_delivery','failed',d.row_version,coalesce(p_note,''),jsonb_build_object('reason_code',p_reason_code,'attempt',d.attempt_count));
 return to_jsonb(d);
end$$;

create function hardware_delivery_reschedule(p_actor text,p_order uuid,p_expected integer,p_scheduled_for date,p_note text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare d hardware_deliveries%rowtype;
begin
 d:=hardware_delivery_begin(p_actor,p_order,p_expected,false);
 if d.state<>'failed' then raise exception 'invalid_delivery_transition' using errcode='PT409';end if;
 if d.attempt_count>=3 then raise exception 'delivery_attempts_exhausted' using errcode='PT409';end if;
 if p_scheduled_for is null or p_scheduled_for<current_date or p_scheduled_for>current_date+90 or length(coalesce(p_note,''))>500 then raise exception 'invalid_delivery_date' using errcode='PT400';end if;
 update hardware_deliveries set state='scheduled',scheduled_for=p_scheduled_for,row_version=row_version+1,updated_at=clock_timestamp() where order_id=p_order returning * into d;
 perform hardware_delivery_record(p_actor,p_order,'rescheduled','failed','scheduled',d.row_version,coalesce(p_note,''),jsonb_build_object('scheduled_for',p_scheduled_for));
 return to_jsonb(d);
end$$;

create function hardware_delivery_hold(p_actor text,p_order uuid,p_expected integer,p_exception text,p_note text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare d hardware_deliveries%rowtype; prev text;
begin
 d:=hardware_delivery_begin(p_actor,p_order,p_expected,false);
 if d.state not in ('scheduled','failed') then raise exception 'invalid_delivery_transition' using errcode='PT409';end if;
 if p_exception is null or p_exception not in ('cancellation_requested','address_verification','customer_request','stock_issue','refund_review','other') or length(trim(coalesce(p_note,''))) not between 8 and 500 then
  raise exception 'invalid_delivery_exception' using errcode='PT400';end if;
 prev:=d.state;
 update hardware_deliveries set state='on_hold',hold_return_state=prev,row_version=row_version+1,updated_at=clock_timestamp() where order_id=p_order returning * into d;
 perform hardware_delivery_record(p_actor,p_order,'held',prev,'on_hold',d.row_version,p_note,jsonb_build_object('exception',p_exception));
 return to_jsonb(d);
end$$;

create function hardware_delivery_release(p_actor text,p_order uuid,p_expected integer,p_note text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare d hardware_deliveries%rowtype; back text;
begin
 d:=hardware_delivery_begin(p_actor,p_order,p_expected,false);
 if d.state<>'on_hold' then raise exception 'invalid_delivery_transition' using errcode='PT409';end if;
 if length(trim(coalesce(p_note,''))) not between 8 and 500 then raise exception 'invalid_delivery_exception' using errcode='PT400';end if;
 back:=d.hold_return_state;
 update hardware_deliveries set state=back,hold_return_state=null,row_version=row_version+1,updated_at=clock_timestamp() where order_id=p_order returning * into d;
 perform hardware_delivery_record(p_actor,p_order,'released','on_hold',back,d.row_version,p_note,'{}'::jsonb);
 return to_jsonb(d);
end$$;

-- Register a proof file already stored by the Office storage service (purpose delivery_proof, linked to this order).
create function hardware_delivery_add_proof(p_actor text,p_order uuid,p_expected integer,p_file_id text,p_kind text,p_sha256 text,p_bytes integer) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare d hardware_deliveries%rowtype; pr hardware_delivery_proofs%rowtype; f office_files%rowtype;
begin
 d:=hardware_delivery_begin(p_actor,p_order,p_expected,false);
 if d.state not in ('out_for_delivery','delivered') then raise exception 'invalid_delivery_transition' using errcode='PT409';end if;
 if p_kind is null or p_kind not in ('photo','signature') or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'invalid_proof' using errcode='PT400';end if;
 select * into f from office_files where id=p_file_id;
 if f.id is null or f.purpose<>'delivery_proof' or f.resource_type<>'hardware_order' or f.resource_id<>p_order::text or f.mime_type<>'image/webp'
  or f.size<>p_bytes or f.storage_key not like 'delivery\_proof\_%' or exists(select 1 from hardware_delivery_proofs where file_id=p_file_id) then
  raise exception 'invalid_proof_file' using errcode='PT400';end if;
 if exists(select 1 from hardware_delivery_proofs where order_id=p_order and sha256=p_sha256) then raise exception 'duplicate_proof' using errcode='PT409';end if;
 if (select count(*) from hardware_delivery_proofs where order_id=p_order)>=10 then raise exception 'proof_limit_reached' using errcode='PT409';end if;
 insert into hardware_delivery_proofs(order_id,file_id,kind,sha256,mime_type,bytes,actor) values(p_order,p_file_id,p_kind,p_sha256,'image/webp',p_bytes,p_actor) returning * into pr;
 update hardware_deliveries set row_version=row_version+1,updated_at=clock_timestamp() where order_id=p_order returning * into d;
 perform hardware_delivery_record(p_actor,p_order,'proof_added',d.state,d.state,d.row_version,'',jsonb_build_object('proof_id',pr.id,'kind',p_kind,'sha256',p_sha256));
 return jsonb_build_object('proof_id',pr.id,'row_version',d.row_version);
end$$;

-- Recipient acknowledgement + at least one proof (safe default) -> delivered; performs fulfilment dispatched -> delivered.
create function hardware_delivery_complete(p_actor text,p_order uuid,p_expected integer,p_recipient text,p_relationship text,p_note text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare d hardware_deliveries%rowtype; f hardware_fulfilments%rowtype;
begin
 d:=hardware_delivery_begin(p_actor,p_order,p_expected,false);
 if d.state<>'out_for_delivery' then raise exception 'invalid_delivery_transition' using errcode='PT409';end if;
 if length(trim(coalesce(p_recipient,''))) not between 2 and 120 or p_relationship is null
  or p_relationship not in ('customer','household_member','colleague','security_or_reception','other') or length(coalesce(p_note,''))>500 then
  raise exception 'invalid_acknowledgement' using errcode='PT400';end if;
 if not exists(select 1 from hardware_delivery_proofs where order_id=p_order) then raise exception 'proof_of_delivery_required' using errcode='PT409';end if;
 select * into f from hardware_fulfilments where order_id=p_order for update;
 perform hardware_fulfilment_step(p_actor,p_order,f.row_version,'delivered','Delivered with proof of delivery','commerce.orders.delivery.manage');
 update hardware_deliveries set state='delivered',recipient_name=trim(p_recipient),recipient_relationship=p_relationship,delivered_at=clock_timestamp(),
  row_version=row_version+1,updated_at=clock_timestamp() where order_id=p_order returning * into d;
 perform hardware_delivery_record(p_actor,p_order,'delivered','out_for_delivery','delivered',d.row_version,coalesce(p_note,''),
  jsonb_build_object('recipient_relationship',p_relationship,'proofs',(select count(*) from hardware_delivery_proofs where order_id=p_order)));
 return to_jsonb(d);
end$$;

-- Every commit: the delivery row, its event chain, proofs, fulfilment state and audit/CRM evidence agree.
create function hardware_delivery_consistency() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare oid uuid; d hardware_deliveries%rowtype; fs text;
begin
 oid:=(to_jsonb(new)->>'order_id')::uuid;
 select * into d from hardware_deliveries where order_id=oid;
 select state into fs from hardware_fulfilments where order_id=oid;
 if d.order_id is null then
  if exists(select 1 from hardware_delivery_events where order_id=oid) or exists(select 1 from hardware_delivery_proofs where order_id=oid) then raise exception 'delivery_integrity_violation' using errcode='PT409';end if;
  return null;end if;
 if (select count(*) from hardware_delivery_events where order_id=oid)<>d.row_version
  or not exists(select 1 from hardware_delivery_events where order_id=oid and row_version=1 and event_type='scheduled' and from_state is null)
  or not exists(select 1 from hardware_delivery_events where order_id=oid and row_version=d.row_version and to_state=d.state)
  or exists(select 1 from hardware_delivery_events e where e.order_id=oid and (
       not hardware_delivery_move_allowed(e.from_state,e.to_state,e.event_type)
    or (e.row_version>1 and not exists(select 1 from hardware_delivery_events p where p.order_id=oid and p.row_version=e.row_version-1 and p.to_state=e.from_state))
    or not exists(select 1 from audit_events a where a.target_type='hardware_order' and a.target_id=oid::text and a.action='hardware_delivery_'||e.event_type and a.actor_email=e.actor and (a.metadata->>'row_version')::integer=e.row_version)
    or not exists(select 1 from crm_activities c where c.related_type='hardware_order' and c.related_id=oid::text and c.activity_type='hardware_delivery_'||e.event_type and c.actor=e.actor and (c.metadata->>'row_version')::integer=e.row_version)))
  or (select count(*) from hardware_delivery_proofs where order_id=oid)<>(select count(*) from hardware_delivery_events where order_id=oid and event_type='proof_added')
  or (d.state in ('out_for_delivery','failed') and coalesce(fs,'paid')<>'dispatched')
  or (d.state='delivered' and (coalesce(fs,'paid') not in ('delivered','installed','closed') or not exists(select 1 from hardware_delivery_proofs where order_id=oid)
      or not exists(select 1 from hardware_fulfilment_events where order_id=oid and to_state='delivered' and authorization_scope='commerce.orders.delivery.manage'))) then
  raise exception 'delivery_integrity_violation' using errcode='PT409';end if;
 return null;
end$$;
do $$declare t text;begin foreach t in array array['hardware_deliveries','hardware_delivery_events','hardware_delivery_proofs'] loop
 execute format('create constraint trigger delivery_consistency after insert or update on %I deferrable initially deferred for each row execute function hardware_delivery_consistency()',t);
end loop;end$$;

do $$declare f regprocedure;begin
 for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and (proname like 'hardware_delivery_%' or proname in ('hardware_fulfilment_step','hardware_fulfilment_transition')) loop
  execute format('revoke all on function %s from public,anon,authenticated',f);
  execute format('grant execute on function %s to service_role',f);
 end loop;end$$;
