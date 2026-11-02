-- LOCAL Phase 5C. Apply explicitly AFTER Phase 5B, transactionally. NOT for production databases.
-- Staff-side site inspections and installations: service requests with service addresses inside Office-managed coverage,
-- appointments for staff holding the existing capability 'hardware.field_technician' within Office-managed working
-- hours, double-booking prevention (database exclusion constraint + the technician's existing office_meetings),
-- reports, checklists, photo evidence (existing office_files/storage service), customer acceptance, rescheduling,
-- cancellation and holds. Appointments are mirrored into office_meetings (the existing Office calendar).
-- Completing an installation performs the 5A fulfilment step delivered -> installed. No public booking, customer
-- notification, payment, refund or inventory action exists here. No fee or price is seeded or applied.
create extension if not exists btree_gist;

-- 5A settings: two more Office-managed keys (shape-validated, versioned, not applied to pricing).
alter table hardware_fulfilment_settings drop constraint hardware_fulfilment_settings_setting_key_check;
alter table hardware_fulfilment_settings add constraint hardware_fulfilment_settings_setting_key_check
 check(setting_key in ('delivery_fees','installation_fees','coverage_areas','inspection_fees','installation_checklist'));
create function hardware_service_setting_valid(p_key text,v jsonb) returns boolean language plpgsql immutable set search_path=public,pg_temp as $$
declare x jsonb; codes text[]:='{}';
begin
 if jsonb_typeof(v) is distinct from 'object' then return false;end if;
 if p_key='inspection_fees' then
  if (v-array['currency','services'])<>'{}'::jsonb or v->>'currency' is distinct from 'NGN' or jsonb_typeof(v->'services') is distinct from 'array' or jsonb_array_length(v->'services')>50 then return false;end if;
  for x in select value from jsonb_array_elements(v->'services') loop
   if jsonb_typeof(x) is distinct from 'object' or (x-array['code','label','fee_kobo','vat_rate_bp'])<>'{}'::jsonb or coalesce(x->>'code','') !~ '^[a-z0-9_-]{2,40}$' or x->>'code'=any(codes)
    or jsonb_typeof(x->'label') is distinct from 'string' or length(x->>'label') not between 1 and 80 or jsonb_typeof(x->'fee_kobo') is distinct from 'number' or (x->>'fee_kobo') !~ '^[0-9]{1,9}$'
    or jsonb_typeof(x->'vat_rate_bp') is distinct from 'number' or (x->>'vat_rate_bp') !~ '^[0-9]{1,5}$' or (x->>'vat_rate_bp')::integer>10000 then return false;end if;
   codes:=codes||(x->>'code');
  end loop;
  return true;
 end if;
 if p_key='installation_checklist' then
  if (v-'items')<>'{}'::jsonb or jsonb_typeof(v->'items') is distinct from 'array' or jsonb_array_length(v->'items') not between 1 and 50 then return false;end if;
  for x in select value from jsonb_array_elements(v->'items') loop
   if jsonb_typeof(x) is distinct from 'object' or (x-array['code','label','required'])<>'{}'::jsonb or coalesce(x->>'code','') !~ '^[a-z0-9_-]{2,40}$' or x->>'code'=any(codes)
    or jsonb_typeof(x->'label') is distinct from 'string' or length(x->>'label') not between 1 and 120 or jsonb_typeof(x->'required') is distinct from 'boolean' then return false;end if;
   codes:=codes||(x->>'code');
  end loop;
  return true;
 end if;
 return false;
end$$;
create or replace function hardware_fulfilment_setting_set(p_actor text,p_key text,p_expected_version integer,p_value jsonb,p_reason text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare cur integer;
begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.fulfilment.configure');
 if p_key is null or p_key not in ('delivery_fees','installation_fees','coverage_areas','inspection_fees','installation_checklist') or p_expected_version is null or p_expected_version<0
  or length(coalesce(p_reason,'')) not between 8 and 500
  or not (case when p_key in ('inspection_fees','installation_checklist') then hardware_service_setting_valid(p_key,p_value) else hardware_fulfilment_setting_valid(p_key,p_value) end) then
  raise exception 'invalid_fulfilment_setting' using errcode='PT400';end if;
 perform pg_advisory_xact_lock(71405,hashtext(p_key));
 select coalesce(max(version),0) into cur from hardware_fulfilment_settings where setting_key=p_key;
 if cur<>p_expected_version then raise exception 'setting_changed' using errcode='PT409';end if;
 insert into hardware_fulfilment_settings(setting_key,version,value,actor,reason) values(p_key,cur+1,p_value,p_actor,p_reason);
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_fulfilment_setting_changed','hardware_fulfilment_setting',p_key,jsonb_build_object('version',cur+1));
 return jsonb_build_object('setting_key',p_key,'version',cur+1);
end$$;

-- 5A/5B: installation completion now belongs to the installation record.
alter table hardware_fulfilment_events drop constraint hardware_fulfilment_events_authorization_scope_check;
alter table hardware_fulfilment_events add constraint hardware_fulfilment_events_authorization_scope_check
 check(authorization_scope in ('commerce.orders.fulfilment.manage','commerce.orders.delivery.manage','commerce.orders.service.perform'));

-- Technician working hours (Africa/Lagos, versioned, append-only) and unavailability.
create table hardware_technician_schedules (
 technician text not null, version integer not null check(version>0),
 windows jsonb not null check(jsonb_typeof(windows)='array'),
 actor text not null, reason text not null check(length(reason) between 8 and 500), created_at timestamptz not null default clock_timestamp(),
 primary key(technician,version)
);
create table hardware_technician_unavailability (
 id uuid primary key default gen_random_uuid(), technician text not null,
 period tstzrange not null check(not isempty(period) and lower(period) is not null and upper(period) is not null),
 reason text not null check(length(reason) between 3 and 200), actor text not null, created_at timestamptz not null default clock_timestamp()
);
create table hardware_service_visits (
 id uuid primary key default gen_random_uuid(),
 kind text not null check(kind in ('inspection','installation')),
 order_id uuid references hardware_orders(id) on delete restrict,
 contact_id uuid not null references crm_contacts(id) on delete restrict,
 service_address jsonb not null check(jsonb_typeof(service_address)='object'),
 state text not null check(state in ('requested','scheduled','in_progress','on_hold','completed','cancelled')),
 technician text, starts_at timestamptz, ends_at timestamptz,
 hold_return_state text check(hold_return_state is null or hold_return_state='requested'),
 reschedule_count integer not null default 0 check(reschedule_count between 0 and 20),
 report jsonb check(report is null or jsonb_typeof(report)='object'),
 checklist_version integer, checklist jsonb check(checklist is null or jsonb_typeof(checklist)='object'),
 acceptance_name text check(acceptance_name is null or length(acceptance_name) between 2 and 120),
 acceptance_relationship text check(acceptance_relationship is null or acceptance_relationship in ('customer','household_member','colleague','security_or_reception','other')),
 completed_at timestamptz,
 row_version integer not null check(row_version>0), created_by text not null,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 check(kind='inspection' or order_id is not null),
 check(case when state in ('scheduled','in_progress','completed') then technician is not null and starts_at is not null and ends_at is not null
  else technician is null and starts_at is null and ends_at is null end),
 check((state='completed')=(completed_at is not null)),
 check(kind<>'installation' or state<>'completed' or (acceptance_name is not null and acceptance_relationship is not null)),
 check((state='on_hold')=(hold_return_state is not null))
);
create unique index hardware_service_one_open_installation on hardware_service_visits(order_id) where kind='installation' and state<>'cancelled';
create table hardware_service_appointments (
 id uuid primary key default gen_random_uuid(),
 visit_id uuid not null references hardware_service_visits(id) on delete restrict,
 sequence integer not null check(sequence>0),
 technician text not null, slot tstzrange not null check(not isempty(slot)),
 state text not null check(state in ('booked','superseded','cancelled','completed')),
 meeting_id text references office_meetings(id) on delete restrict,
 actor text not null, created_at timestamptz not null default clock_timestamp(),
 unique(visit_id,sequence),
 -- Double booking is impossible: two booked appointments for one technician can never overlap.
 constraint hardware_service_no_double_booking exclude using gist (technician with =, slot with &&) where (state='booked')
);
create table hardware_service_visit_events (
 id uuid primary key default gen_random_uuid(),
 visit_id uuid not null references hardware_service_visits(id) on delete restrict,
 row_version integer not null check(row_version>0),
 event_type text not null check(event_type in ('requested','scheduled','rescheduled','started','report_recorded','checklist_updated','evidence_added','completed','held','released','cancelled')),
 from_state text, to_state text not null,
 actor text not null,
 authorization_scope text not null check(authorization_scope in ('commerce.orders.service.schedule','commerce.orders.service.perform')),
 reason text not null default '' check(length(reason)<=1000),
 detail jsonb not null default '{}'::jsonb check(jsonb_typeof(detail)='object'),
 created_at timestamptz not null default clock_timestamp(),
 unique(visit_id,row_version)
);
create table hardware_service_visit_evidence (
 id uuid primary key default gen_random_uuid(),
 visit_id uuid not null references hardware_service_visits(id) on delete restrict,
 file_id text not null unique references office_files(id) on delete restrict,
 kind text not null check(kind in ('inspection_photo','installation_photo','acceptance_signature')),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'), bytes integer not null check(bytes between 1 and 15728640),
 actor text not null, created_at timestamptz not null default clock_timestamp(),
 unique(visit_id,sha256)
);
create index hardware_service_visits_state_idx on hardware_service_visits(state,starts_at);
create index hardware_service_events_idx on hardware_service_visit_events(visit_id,row_version);

do $$declare t text;begin
 foreach t in array array['hardware_technician_schedules','hardware_technician_unavailability','hardware_service_visits','hardware_service_appointments','hardware_service_visit_events','hardware_service_visit_evidence'] loop
  execute format('alter table %I enable row level security',t);
  execute format('revoke all on %I from public,anon,authenticated,service_role',t);
  execute format('grant select,insert on %I to service_role',t);
  execute format('create trigger service_no_truncate before truncate on %I execute function hardware_order_immutable()',t);
  if t not in ('hardware_service_visits','hardware_service_appointments') then
   execute format('create trigger service_immutable before update or delete on %I for each row execute function hardware_order_immutable()',t);
  end if;
 end loop;end$$;
grant update on hardware_service_visits, hardware_service_appointments to service_role;

create function hardware_service_appointment_guard() returns trigger language plpgsql set search_path=public,pg_temp as $$begin
 if tg_op='INSERT' then if new.state<>'booked' then raise exception 'invalid_service_transition' using errcode='PT409';end if;return new;end if;
 if tg_op<>'UPDATE' or old.state<>'booked' or new.state not in ('superseded','cancelled','completed')
  or (to_jsonb(new)-'state') is distinct from (to_jsonb(old)-'state') then raise exception 'invalid_service_transition' using errcode='PT409';end if;
 return new;end$$;
create trigger service_appointment_guard before insert or update or delete on hardware_service_appointments for each row execute function hardware_service_appointment_guard();

create function hardware_service_visit_guard() returns trigger language plpgsql set search_path=public,pg_temp as $$begin
 if tg_op='INSERT' then if new.state<>'requested' or new.row_version<>1 then raise exception 'invalid_service_transition' using errcode='PT409';end if;return new;end if;
 if tg_op<>'UPDATE' or new.row_version<>old.row_version+1 or old.state in ('completed','cancelled')
  or new.kind<>old.kind or new.order_id is distinct from old.order_id or new.contact_id<>old.contact_id or new.created_by<>old.created_by or new.service_address<>old.service_address
  or (new.state<>old.state and not exists(select 1 from (values('requested','scheduled'),('scheduled','scheduled'),('scheduled','in_progress'),('in_progress','completed'),('requested','on_hold'),('scheduled','on_hold'),('in_progress','on_hold'),('on_hold','requested'),('requested','cancelled'),('scheduled','cancelled'),('on_hold','cancelled')) m(f,t) where m.f=old.state and m.t=new.state)) then
  raise exception 'invalid_service_transition' using errcode='PT409';end if;
 return new;end$$;
create trigger service_visit_guard before insert or update or delete on hardware_service_visits for each row execute function hardware_service_visit_guard();

-- Replace the shared 5A step so it accepts the service scope; 5A entry point also refuses 'installed' now.
create or replace function hardware_fulfilment_step(p_actor text,p_order uuid,p_expected integer,p_to text,p_reason text,p_scope text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare o hardware_orders%rowtype; f hardware_fulfilments%rowtype; cur text; ver integer; inst boolean; reason text:=coalesce(p_reason,'');
begin
 if p_scope not in ('commerce.orders.fulfilment.manage','commerce.orders.delivery.manage','commerce.orders.service.perform') or p_order is null or p_expected is null or p_expected not between 0 and 4
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
create or replace function hardware_fulfilment_transition(p_actor text,p_order uuid,p_expected integer,p_to text,p_reason text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.fulfilment.manage');
 if p_to in ('dispatched','delivered') then raise exception 'use_delivery_record' using errcode='PT409';end if;
 if p_to='installed' then raise exception 'use_installation_record' using errcode='PT409';end if;
 return hardware_fulfilment_step(p_actor,p_order,p_expected,p_to,p_reason,'commerce.orders.fulfilment.manage');
end$$;

-- Helpers.
create function hardware_service_technician_ok(p_tech text) returns boolean language sql stable set search_path=public,pg_temp as $$
 select exists(select 1 from admin_users u join office_staff_capabilities c on lower(c.staff_email)=lower(u.email) and c.capability='hardware.field_technician'
  where lower(u.email)=lower(p_tech) and u.status='active' and u.removed_at is null and u.role in ('super_admin','ochiga_admin','ochiga_staff'))$$;
create function hardware_service_latest_setting(p_key text) returns jsonb language sql stable set search_path=public,pg_temp as $$
 select value from hardware_fulfilment_settings where setting_key=p_key order by version desc limit 1$$;
-- Coverage: the latest coverage_areas version must list the address state (and city, when the area lists cities) with the flag on.
create function hardware_service_covered(p_address jsonb,p_flag text) returns text language plpgsql stable set search_path=public,pg_temp as $$
declare cov jsonb:=hardware_service_latest_setting('coverage_areas'); a jsonb;
begin
 if cov is null then return 'coverage_not_configured';end if;
 for a in select value from jsonb_array_elements(cov->'areas') loop
  if lower(a->>'state')=lower(p_address->>'state') and coalesce((a->>p_flag)::boolean,false)
   and (jsonb_array_length(a->'cities')=0 or exists(select 1 from jsonb_array_elements_text(a->'cities') c where lower(c)=lower(p_address->>'city'))) then return 'covered';end if;
 end loop;
 return 'outside_coverage';
end$$;
create function hardware_service_valid_address(p jsonb) returns boolean language sql immutable set search_path=public,pg_temp as $$
 select jsonb_typeof(p)='object' and (p-array['country','state','city','address','landmark'])='{}'::jsonb and p->>'country'='NG'
  and coalesce(length(trim(p->>'state')),0) between 2 and 60 and coalesce(length(trim(p->>'city')),0) between 2 and 60 and coalesce(length(trim(p->>'address')),0) between 5 and 300
  and (p->>'landmark' is null or length(p->>'landmark')<=200)
  and not exists(select 1 from jsonb_each(p) x where jsonb_typeof(x.value)<>'string')$$;

create function hardware_service_record(p_actor text,v hardware_service_visits,p_event text,p_from text,p_scope text,p_reason text,p_detail jsonb) returns void
 language plpgsql set search_path=public,pg_temp as $$
declare o hardware_orders%rowtype;
begin
 insert into hardware_service_visit_events(visit_id,row_version,event_type,from_state,to_state,actor,authorization_scope,reason,detail)
  values(v.id,v.row_version,p_event,p_from,v.state,p_actor,p_scope,coalesce(p_reason,''),coalesce(p_detail,'{}'::jsonb));
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_service_'||p_event,'hardware_service_visit',v.id::text,
  jsonb_build_object('row_version',v.row_version,'kind',v.kind,'order_id',v.order_id,'from_state',p_from,'to_state',v.state,'authorization',p_scope));
 if v.order_id is not null then select * into o from hardware_orders where id=v.order_id;end if;
 insert into crm_activities(contact_id,organization_id,opportunity_id,related_type,related_id,activity_type,title,source,actor,metadata)
  values(v.contact_id,o.organization_id,o.opportunity_id,'hardware_service_visit',v.id::text,'hardware_service_'||p_event,initcap(v.kind)||' '||replace(p_event,'_',' '),'office',p_actor,
  jsonb_build_object('visit_id',v.id,'order_id',v.order_id,'row_version',v.row_version));
end$$;

create function hardware_service_begin(p_actor text,p_visit uuid,p_expected integer,p_scope text) returns hardware_service_visits
 language plpgsql set search_path=public,pg_temp as $$
declare v hardware_service_visits%rowtype;
begin
 perform hardware_order_require_actor(p_actor,p_scope);
 if p_visit is null or p_expected is null or p_expected<1 then raise exception 'invalid_service_input' using errcode='PT400';end if;
 select * into v from hardware_service_visits where id=p_visit;
 if not found then raise exception 'visit_not_found' using errcode='PT404';end if;
 if v.order_id is not null then perform 1 from hardware_orders where id=v.order_id for update;end if;
 select * into v from hardware_service_visits where id=p_visit for update;
 if v.row_version<>p_expected then raise exception 'visit_state_changed' using errcode='PT409';end if;
 if v.state in ('completed','cancelled') then raise exception 'invalid_service_transition' using errcode='PT409';end if;
 -- Installations follow the order: refund requests or anything but a verified, allocated payment stop them (safe default).
 if v.kind='installation' and not hardware_fulfilment_eligible(v.order_id) then raise exception 'order_not_paid_and_allocated' using errcode='PT409';end if;
 if p_scope='commerce.orders.service.perform' and lower(coalesce(v.technician,''))<>lower(p_actor) then raise exception 'not_assigned_technician' using errcode='PT403';end if;
 return v;
end$$;

create function hardware_service_request(p_actor text,p_kind text,p_order uuid,p_contact uuid,p_address jsonb,p_note text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare v hardware_service_visits%rowtype; o hardware_orders%rowtype; cov text;
begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.service.schedule');
 if p_kind is null or p_kind not in ('inspection','installation') or not hardware_service_valid_address(p_address) or length(coalesce(p_note,''))>1000 then raise exception 'invalid_service_input' using errcode='PT400';end if;
 if p_order is not null then
  select * into o from hardware_orders where id=p_order for update;
  if not found then raise exception 'order_not_found' using errcode='PT404';end if;
  if p_contact is not null and p_contact<>o.contact_id then raise exception 'invalid_service_input' using errcode='PT400';end if;
 end if;
 if p_kind='installation' then
  if p_order is null then raise exception 'installation_requires_order' using errcode='PT400';end if;
  if not o.installation_requested then raise exception 'installation_not_requested' using errcode='PT409';end if;
  if not hardware_fulfilment_eligible(p_order) then raise exception 'order_not_paid_and_allocated' using errcode='PT409';end if;
  if exists(select 1 from hardware_service_visits where order_id=p_order and kind='installation' and state<>'cancelled') then raise exception 'installation_already_open' using errcode='PT409';end if;
 end if;
 if not exists(select 1 from crm_contacts where id=coalesce(p_contact,o.contact_id)) then raise exception 'invalid_service_input' using errcode='PT400';end if;
 cov:=hardware_service_covered(p_address,case when p_kind='inspection' then 'inspection' else 'installation' end);
 if cov<>'covered' then raise exception '%',cov using errcode='PT409';end if;
 insert into hardware_service_visits(kind,order_id,contact_id,service_address,state,row_version,created_by)
  values(p_kind,p_order,coalesce(p_contact,o.contact_id),p_address,'requested',1,p_actor) returning * into v;
 perform hardware_service_record(p_actor,v,'requested',null,'commerce.orders.service.schedule',p_note,'{}'::jsonb);
 return to_jsonb(v);
end$$;

-- Verified availability: inside a working-hours window of the technician's latest schedule (Africa/Lagos, same day), no
-- unavailability overlap, no booked appointment overlap, no active office_meeting owned by the technician inside the slot.
create function hardware_service_slot_problem(p_tech text,p_start timestamptz,p_end timestamptz,p_ignore_visit uuid) returns text
 language plpgsql stable set search_path=public,pg_temp as $$
declare w jsonb; ls timestamp:=p_start at time zone 'Africa/Lagos'; le timestamp:=p_end at time zone 'Africa/Lagos'; okw boolean:=false; x jsonb;
begin
 if not hardware_service_technician_ok(p_tech) then return 'technician_not_eligible';end if;
 if p_start is null or p_end is null or p_end<=p_start or p_end-p_start<interval '30 minutes' or p_end-p_start>interval '8 hours' then return 'invalid_slot';end if;
 if p_start<clock_timestamp() or p_start>clock_timestamp()+interval '90 days' then return 'invalid_slot';end if;
 if ls::date<>le::date then return 'outside_working_hours';end if;
 select windows into w from hardware_technician_schedules where lower(technician)=lower(p_tech) order by version desc limit 1;
 if w is null then return 'no_working_hours';end if;
 for x in select value from jsonb_array_elements(w) loop
  if (x->>'weekday')::integer=extract(dow from ls)::integer and ls::time>=(x->>'start')::time and le::time<=(x->>'end')::time then okw:=true;end if;
 end loop;
 if not okw then return 'outside_working_hours';end if;
 if exists(select 1 from hardware_technician_unavailability where lower(technician)=lower(p_tech) and period && tstzrange(p_start,p_end)) then return 'technician_unavailable';end if;
 if exists(select 1 from hardware_service_appointments a where lower(a.technician)=lower(p_tech) and a.state='booked' and a.slot && tstzrange(p_start,p_end) and a.visit_id is distinct from p_ignore_visit) then return 'technician_double_booked';end if;
 if exists(select 1 from office_meetings m where lower(m.owner)=lower(p_tech) and m.status='active' and m.trashed_at is null and m.cancelled_at is null and m.completed_at is null
  -- office_meetings has no duration: each meeting is treated as one hour from its start.
  and m.scheduled_at is not null and tstzrange(m.scheduled_at,m.scheduled_at+interval '1 hour') && tstzrange(p_start,p_end) and coalesce(m.related_type,'')<>'hardware_service_visit') then return 'technician_has_meeting';end if;
 return null;
end$$;

create function hardware_service_schedule(p_actor text,p_visit uuid,p_expected integer,p_technician text,p_start timestamptz,p_end timestamptz,p_note text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare v hardware_service_visits%rowtype; prev hardware_service_appointments%rowtype; tech text:=lower(trim(coalesce(p_technician,''))); prob text; seq integer; mid text; apid uuid; ev text; from_state text;
begin
 v:=hardware_service_begin(p_actor,p_visit,p_expected,'commerce.orders.service.schedule');
 if v.state not in ('requested','scheduled') or length(coalesce(p_note,''))>1000 then raise exception 'invalid_service_transition' using errcode='PT409';end if;
 -- One schedule change at a time per technician (serializes the overlap checks with the exclusion constraint as backstop).
 perform pg_advisory_xact_lock(71406,hashtext(tech));
 prob:=hardware_service_slot_problem(tech,p_start,p_end,v.id);
 if prob is not null then raise exception '%',prob using errcode='PT409';end if;
 select * into prev from hardware_service_appointments where visit_id=v.id and state='booked' for update;
 if prev.id is not null then
  update hardware_service_appointments set state='superseded' where id=prev.id;
  if prev.meeting_id is not null then update office_meetings set status='cancelled',cancelled_at=now(),updated_at=now() where id=prev.meeting_id;end if;
 end if;
 select coalesce(max(sequence),0)+1 into seq from hardware_service_appointments where visit_id=v.id;
 apid:=gen_random_uuid(); mid:='svc_'||replace(apid::text,'-','');
 insert into office_meetings(id,title,business_unit,status,owner,scheduled_at,participants,related_type,related_id,notes,metadata)
  values(mid,case when v.kind='inspection' then 'Site inspection' else 'Installation' end||' (hardware)','technology','active',tech,p_start,jsonb_build_array(tech),'hardware_service_visit',v.id::text,
   null,jsonb_build_object('ends_at',p_end,'visit_id',v.id,'source','hardware_service'));
 begin
  insert into hardware_service_appointments(id,visit_id,sequence,technician,slot,state,meeting_id,actor) values(apid,v.id,seq,tech,tstzrange(p_start,p_end),'booked',mid,p_actor);
 exception when exclusion_violation then raise exception 'technician_double_booked' using errcode='PT409';
 end;
 from_state:=v.state; ev:=case when v.state='requested' then 'scheduled' else 'rescheduled' end;
 update hardware_service_visits set state='scheduled',technician=tech,starts_at=p_start,ends_at=p_end,reschedule_count=reschedule_count+case when ev='rescheduled' then 1 else 0 end,
  row_version=row_version+1,updated_at=clock_timestamp() where id=v.id returning * into v;
 perform hardware_service_record(p_actor,v,ev,from_state,'commerce.orders.service.schedule',p_note,jsonb_build_object('technician',tech,'starts_at',p_start,'ends_at',p_end,'appointment',seq));
 return to_jsonb(v);
end$$;

create function hardware_service_start(p_actor text,p_visit uuid,p_expected integer) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare v hardware_service_visits%rowtype; cl jsonb; ver integer;
begin
 v:=hardware_service_begin(p_actor,p_visit,p_expected,'commerce.orders.service.perform');
 if v.state<>'scheduled' then raise exception 'invalid_service_transition' using errcode='PT409';end if;
 -- Work can start from the day before the appointment (Africa/Lagos), never earlier.
 if (clock_timestamp() at time zone 'Africa/Lagos')::date<(v.starts_at at time zone 'Africa/Lagos')::date-1 then raise exception 'too_early_to_start' using errcode='PT409';end if;
 if v.kind='installation' then
  if coalesce((select state from hardware_fulfilments where order_id=v.order_id),'paid')<>'delivered' then raise exception 'goods_not_delivered' using errcode='PT409';end if;
  select value,version into cl,ver from hardware_fulfilment_settings where setting_key='installation_checklist' order by version desc limit 1;
  if cl is null then raise exception 'checklist_not_configured' using errcode='PT409';end if;
 end if;
 update hardware_service_visits set state='in_progress',checklist_version=ver,checklist=case when v.kind='installation' then '{}'::jsonb end,row_version=row_version+1,updated_at=clock_timestamp()
  where id=v.id returning * into v;
 perform hardware_service_record(p_actor,v,'started','scheduled','commerce.orders.service.perform','',jsonb_build_object('checklist_version',ver));
 return to_jsonb(v);
end$$;

create function hardware_service_record_report(p_actor text,p_visit uuid,p_expected integer,p_report jsonb) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare v hardware_service_visits%rowtype;
begin
 v:=hardware_service_begin(p_actor,p_visit,p_expected,'commerce.orders.service.perform');
 if v.state<>'in_progress' or v.kind<>'inspection' then raise exception 'invalid_service_transition' using errcode='PT409';end if;
 if jsonb_typeof(p_report) is distinct from 'object' or (p_report-array['findings','recommendation','notes'])<>'{}'::jsonb
  or length(coalesce(p_report->>'findings','')) not between 10 and 4000 or p_report->>'recommendation' is null
  or p_report->>'recommendation' not in ('proceed','proceed_with_changes','requires_quote','not_feasible') or length(coalesce(p_report->>'notes',''))>2000 then
  raise exception 'invalid_inspection_report' using errcode='PT400';end if;
 update hardware_service_visits set report=p_report,row_version=row_version+1,updated_at=clock_timestamp() where id=v.id returning * into v;
 perform hardware_service_record(p_actor,v,'report_recorded','in_progress','commerce.orders.service.perform','',jsonb_build_object('recommendation',p_report->>'recommendation'));
 return to_jsonb(v);
end$$;

create function hardware_service_update_checklist(p_actor text,p_visit uuid,p_expected integer,p_checklist jsonb) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare v hardware_service_visits%rowtype; cl jsonb; k text;
begin
 v:=hardware_service_begin(p_actor,p_visit,p_expected,'commerce.orders.service.perform');
 if v.state<>'in_progress' or v.kind<>'installation' then raise exception 'invalid_service_transition' using errcode='PT409';end if;
 select value into cl from hardware_fulfilment_settings where setting_key='installation_checklist' and version=v.checklist_version;
 if jsonb_typeof(p_checklist) is distinct from 'object' then raise exception 'invalid_checklist' using errcode='PT400';end if;
 for k in select jsonb_object_keys(p_checklist) loop
  if jsonb_typeof(p_checklist->k)<>'boolean' or not exists(select 1 from jsonb_array_elements(cl->'items') i where i->>'code'=k) then raise exception 'invalid_checklist' using errcode='PT400';end if;
 end loop;
 update hardware_service_visits set checklist=p_checklist,row_version=row_version+1,updated_at=clock_timestamp() where id=v.id returning * into v;
 perform hardware_service_record(p_actor,v,'checklist_updated','in_progress','commerce.orders.service.perform','',jsonb_build_object('checked',(select count(*) from jsonb_each(p_checklist) e where e.value='true'::jsonb)));
 return to_jsonb(v);
end$$;

create function hardware_service_add_evidence(p_actor text,p_visit uuid,p_expected integer,p_file_id text,p_kind text,p_sha256 text,p_bytes integer) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare v hardware_service_visits%rowtype; f office_files%rowtype; e hardware_service_visit_evidence%rowtype;
begin
 v:=hardware_service_begin(p_actor,p_visit,p_expected,'commerce.orders.service.perform');
 if v.state<>'in_progress' then raise exception 'invalid_service_transition' using errcode='PT409';end if;
 if p_kind is null or p_kind not in ('inspection_photo','installation_photo','acceptance_signature') or (v.kind='inspection' and p_kind='installation_photo') or (v.kind='installation' and p_kind='inspection_photo')
  or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'invalid_evidence' using errcode='PT400';end if;
 select * into f from office_files where id=p_file_id;
 if f.id is null or f.purpose<>'service_visit_photo' or f.resource_type<>'hardware_service_visit' or f.resource_id<>v.id::text or f.mime_type<>'image/webp' or f.size<>p_bytes
  or f.storage_key not like 'service\_visit\_photo\_%' or exists(select 1 from hardware_service_visit_evidence where file_id=p_file_id) then raise exception 'invalid_evidence_file' using errcode='PT400';end if;
 if exists(select 1 from hardware_service_visit_evidence where visit_id=v.id and sha256=p_sha256) then raise exception 'duplicate_evidence' using errcode='PT409';end if;
 if (select count(*) from hardware_service_visit_evidence where visit_id=v.id)>=20 then raise exception 'evidence_limit_reached' using errcode='PT409';end if;
 insert into hardware_service_visit_evidence(visit_id,file_id,kind,sha256,bytes,actor) values(v.id,p_file_id,p_kind,p_sha256,p_bytes,p_actor) returning * into e;
 update hardware_service_visits set row_version=row_version+1,updated_at=clock_timestamp() where id=v.id returning * into v;
 perform hardware_service_record(p_actor,v,'evidence_added','in_progress','commerce.orders.service.perform','',jsonb_build_object('evidence_id',e.id,'kind',p_kind,'sha256',p_sha256));
 return jsonb_build_object('evidence_id',e.id,'row_version',v.row_version);
end$$;

create function hardware_service_complete(p_actor text,p_visit uuid,p_expected integer,p_acceptance_name text,p_relationship text,p_note text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare v hardware_service_visits%rowtype; cl jsonb; missing integer; f hardware_fulfilments%rowtype;
begin
 v:=hardware_service_begin(p_actor,p_visit,p_expected,'commerce.orders.service.perform');
 if v.state<>'in_progress' or length(coalesce(p_note,''))>1000 then raise exception 'invalid_service_transition' using errcode='PT409';end if;
 if v.kind='inspection' then
  if v.report is null then raise exception 'inspection_report_required' using errcode='PT409';end if;
  if not exists(select 1 from hardware_service_visit_evidence where visit_id=v.id and kind='inspection_photo') then raise exception 'evidence_required' using errcode='PT409';end if;
 else
  select value into cl from hardware_fulfilment_settings where setting_key='installation_checklist' and version=v.checklist_version;
  select count(*) into missing from jsonb_array_elements(cl->'items') i where (i->>'required')::boolean and coalesce(v.checklist->(i->>'code'),'false'::jsonb)<>'true'::jsonb;
  if missing>0 then raise exception 'checklist_incomplete' using errcode='PT409';end if;
  if not exists(select 1 from hardware_service_visit_evidence where visit_id=v.id and kind='installation_photo') then raise exception 'evidence_required' using errcode='PT409';end if;
  if length(trim(coalesce(p_acceptance_name,''))) not between 2 and 120 or p_relationship is null or p_relationship not in ('customer','household_member','colleague','security_or_reception','other') then
   raise exception 'customer_acceptance_required' using errcode='PT400';end if;
  select * into f from hardware_fulfilments where order_id=v.order_id for update;
  perform hardware_fulfilment_step(p_actor,v.order_id,f.row_version,'installed','Installed with checklist, evidence and customer acceptance','commerce.orders.service.perform');
 end if;
 update hardware_service_appointments set state='completed' where visit_id=v.id and state='booked';
 update office_meetings set status='completed',completed_at=now(),updated_at=now() where related_type='hardware_service_visit' and related_id=v.id::text and status='active';
 update hardware_service_visits set state='completed',completed_at=clock_timestamp(),
  acceptance_name=case when v.kind='installation' then trim(p_acceptance_name) else nullif(trim(coalesce(p_acceptance_name,'')),'') end,
  acceptance_relationship=case when v.kind='installation' or nullif(trim(coalesce(p_acceptance_name,'')),'') is not null then p_relationship end,
  row_version=row_version+1,updated_at=clock_timestamp() where id=v.id returning * into v;
 perform hardware_service_record(p_actor,v,'completed','in_progress','commerce.orders.service.perform',p_note,jsonb_build_object('evidence',(select count(*) from hardware_service_visit_evidence where visit_id=v.id)));
 return to_jsonb(v);
end$$;

create function hardware_service_free_booking(v hardware_service_visits) returns void language plpgsql set search_path=public,pg_temp as $$
declare a hardware_service_appointments%rowtype;
begin
 select * into a from hardware_service_appointments where visit_id=v.id and state='booked' for update;
 if a.id is not null then
  update hardware_service_appointments set state='cancelled' where id=a.id;
  if a.meeting_id is not null then update office_meetings set status='cancelled',cancelled_at=now(),updated_at=now() where id=a.meeting_id;end if;
 end if;
end$$;

create function hardware_service_hold(p_actor text,p_visit uuid,p_expected integer,p_exception text,p_note text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare v hardware_service_visits%rowtype; prev text;
begin
 v:=hardware_service_begin(p_actor,p_visit,p_expected,'commerce.orders.service.schedule');
 if v.state not in ('requested','scheduled','in_progress') then raise exception 'invalid_service_transition' using errcode='PT409';end if;
 if p_exception is null or p_exception not in ('customer_unavailable','site_not_ready','access_issue','safety_issue','parts_unavailable','refund_review','other') or length(trim(coalesce(p_note,''))) not between 8 and 1000 then
  raise exception 'invalid_service_exception' using errcode='PT400';end if;
 prev:=v.state;
 perform hardware_service_free_booking(v);
 update hardware_service_visits set state='on_hold',hold_return_state='requested',technician=null,starts_at=null,ends_at=null,row_version=row_version+1,updated_at=clock_timestamp() where id=v.id returning * into v;
 perform hardware_service_record(p_actor,v,'held',prev,'commerce.orders.service.schedule',p_note,jsonb_build_object('exception',p_exception));
 return to_jsonb(v);
end$$;

create function hardware_service_release(p_actor text,p_visit uuid,p_expected integer,p_note text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare v hardware_service_visits%rowtype;
begin
 v:=hardware_service_begin(p_actor,p_visit,p_expected,'commerce.orders.service.schedule');
 if v.state<>'on_hold' or length(trim(coalesce(p_note,''))) not between 8 and 1000 then raise exception 'invalid_service_exception' using errcode='PT400';end if;
 update hardware_service_visits set state='requested',hold_return_state=null,row_version=row_version+1,updated_at=clock_timestamp() where id=v.id returning * into v;
 perform hardware_service_record(p_actor,v,'released','on_hold','commerce.orders.service.schedule',p_note,'{}'::jsonb);
 return to_jsonb(v);
end$$;

create function hardware_service_cancel(p_actor text,p_visit uuid,p_expected integer,p_reason text,p_note text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare v hardware_service_visits%rowtype; prev text;
begin
 v:=hardware_service_begin(p_actor,p_visit,p_expected,'commerce.orders.service.schedule');
 if v.state not in ('requested','scheduled','on_hold') then raise exception 'invalid_service_transition' using errcode='PT409';end if;
 if p_reason is null or p_reason not in ('customer_request','duplicate','not_feasible','outside_coverage','other') or length(trim(coalesce(p_note,''))) not between 8 and 1000 then
  raise exception 'invalid_service_exception' using errcode='PT400';end if;
 prev:=v.state;
 perform hardware_service_free_booking(v);
 update hardware_service_visits set state='cancelled',hold_return_state=null,technician=null,starts_at=null,ends_at=null,row_version=row_version+1,updated_at=clock_timestamp() where id=v.id returning * into v;
 perform hardware_service_record(p_actor,v,'cancelled',prev,'commerce.orders.service.schedule',p_note,jsonb_build_object('reason',p_reason));
 return to_jsonb(v);
end$$;

-- Office-managed working hours and unavailability.
create function hardware_service_set_schedule(p_actor text,p_technician text,p_expected integer,p_windows jsonb,p_reason text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare tech text:=lower(trim(coalesce(p_technician,''))); cur integer; x jsonb;
begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.service.configure');
 if not hardware_service_technician_ok(tech) then raise exception 'technician_not_eligible' using errcode='PT409';end if;
 if jsonb_typeof(p_windows) is distinct from 'array' or jsonb_array_length(p_windows)>21 or length(coalesce(p_reason,'')) not between 8 and 500 then raise exception 'invalid_schedule' using errcode='PT400';end if;
 for x in select value from jsonb_array_elements(p_windows) loop
  if jsonb_typeof(x) is distinct from 'object' or (x-array['weekday','start','end'])<>'{}'::jsonb or jsonb_typeof(x->'weekday') is distinct from 'number' or (x->>'weekday') !~ '^[0-6]$'
   or coalesce(x->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(x->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or (x->>'end')::time<=(x->>'start')::time then
   raise exception 'invalid_schedule' using errcode='PT400';end if;
 end loop;
 perform pg_advisory_xact_lock(71406,hashtext(tech));
 select coalesce(max(version),0) into cur from hardware_technician_schedules where technician=tech;
 if cur<>coalesce(p_expected,-1) then raise exception 'schedule_changed' using errcode='PT409';end if;
 insert into hardware_technician_schedules(technician,version,windows,actor,reason) values(tech,cur+1,p_windows,p_actor,p_reason);
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_technician_schedule_changed','admin_user',tech,jsonb_build_object('version',cur+1));
 return jsonb_build_object('technician',tech,'version',cur+1);
end$$;
create function hardware_service_add_unavailability(p_actor text,p_technician text,p_start timestamptz,p_end timestamptz,p_reason text) returns jsonb
 language plpgsql set search_path=public,pg_temp as $$
declare tech text:=lower(trim(coalesce(p_technician,''))); u hardware_technician_unavailability%rowtype;
begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.service.configure');
 if not hardware_service_technician_ok(tech) or p_start is null or p_end is null or p_end<=p_start or p_end-p_start>interval '60 days' or length(coalesce(p_reason,'')) not between 3 and 200 then raise exception 'invalid_unavailability' using errcode='PT400';end if;
 perform pg_advisory_xact_lock(71406,hashtext(tech));
 if exists(select 1 from hardware_service_appointments where technician=tech and state='booked' and slot && tstzrange(p_start,p_end)) then raise exception 'conflicts_with_booked_appointment' using errcode='PT409';end if;
 insert into hardware_technician_unavailability(technician,period,reason,actor) values(tech,tstzrange(p_start,p_end),p_reason,p_actor) returning * into u;
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_technician_unavailability_added','admin_user',tech,jsonb_build_object('id',u.id));
 return to_jsonb(u);
end$$;

-- Every commit: visit row, event chain, appointment, fulfilment and audit/CRM evidence agree.
create function hardware_service_consistency() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare vid uuid; v hardware_service_visits%rowtype; booked integer; a hardware_service_appointments%rowtype;
begin
 vid:=coalesce((to_jsonb(new)->>'visit_id')::uuid,(to_jsonb(new)->>'id')::uuid);
 select * into v from hardware_service_visits where id=vid;
 if v.id is null then return null;end if;
 select count(*) into booked from hardware_service_appointments where visit_id=vid and state='booked';
 select * into a from hardware_service_appointments where visit_id=vid and state='booked';
 if (select count(*) from hardware_service_visit_events where visit_id=vid)<>v.row_version
  or not exists(select 1 from hardware_service_visit_events where visit_id=vid and row_version=1 and event_type='requested')
  or not exists(select 1 from hardware_service_visit_events where visit_id=vid and row_version=v.row_version and to_state=v.state)
  or exists(select 1 from hardware_service_visit_events e where e.visit_id=vid and e.row_version>1 and not exists(select 1 from hardware_service_visit_events p where p.visit_id=vid and p.row_version=e.row_version-1 and p.to_state=coalesce(e.from_state,p.to_state)))
  or exists(select 1 from hardware_service_visit_events e where e.visit_id=vid and not exists(select 1 from audit_events x where x.target_type='hardware_service_visit' and x.target_id=vid::text and x.action='hardware_service_'||e.event_type and x.actor_email=e.actor and (x.metadata->>'row_version')::integer=e.row_version))
  or booked>1
  or (v.state in ('scheduled','in_progress') and (booked<>1 or a.technician<>v.technician or a.slot<>tstzrange(v.starts_at,v.ends_at)))
  or (v.state in ('requested','on_hold','cancelled') and booked<>0)
  or (select count(*) from hardware_service_visit_evidence where visit_id=vid)<>(select count(*) from hardware_service_visit_events where visit_id=vid and event_type='evidence_added')
  or (v.kind='installation' and v.state='completed' and not exists(select 1 from hardware_fulfilment_events where order_id=v.order_id and to_state='installed' and authorization_scope='commerce.orders.service.perform')) then
  raise exception 'service_integrity_violation' using errcode='PT409';end if;
 return null;
end$$;
do $$declare t text;begin foreach t in array array['hardware_service_visits','hardware_service_appointments','hardware_service_visit_events','hardware_service_visit_evidence'] loop
 execute format('create constraint trigger service_consistency after insert or update on %I deferrable initially deferred for each row execute function hardware_service_consistency()',t);
end loop;end$$;

do $$declare f regprocedure;begin
 for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and (proname like 'hardware_service_%' or proname in ('hardware_fulfilment_step','hardware_fulfilment_transition','hardware_fulfilment_setting_set')) loop
  execute format('revoke all on function %s from public,anon,authenticated',f);
  execute format('grant execute on function %s to service_role',f);
 end loop;end$$;
