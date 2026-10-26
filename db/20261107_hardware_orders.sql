-- LOCAL CANDIDATE ONLY. Stage 4A: staff-managed orders; no checkout, reservations or payment execution.
-- SECURITY INVOKER matches the existing Office catalogue boundary. Apply transactionally after Phase 3.
create table if not exists hardware_orders (
 id uuid primary key default gen_random_uuid(),
 contact_id uuid not null references crm_contacts(id) on delete restrict,
 organization_id uuid references crm_organizations(id) on delete restrict,
 opportunity_id uuid references crm_opportunities(id) on delete restrict,
 created_by text not null, idempotency_key text not null check(length(idempotency_key) between 16 and 128),
 request_hash text not null check(length(request_hash)=64),
 currency text not null default 'NGN' check(currency='NGN'),
 goods_total_kobo bigint not null check(goods_total_kobo between 1 and 900000000000),
 goods_tax_kobo bigint not null check(goods_tax_kobo between 0 and goods_total_kobo),
 delivery_total_kobo bigint check(delivery_total_kobo is null),
 payable_total_kobo bigint check(payable_total_kobo is null),
 delivery_state text not null default 'unconfirmed' check(delivery_state='unconfirmed'),
 installation_requested boolean not null default false,
 order_state text not null default 'awaiting_confirmation' check(order_state in ('awaiting_confirmation','cancelled')),
 payment_state text not null default 'not_started' check(payment_state='not_started'),
 fulfilment_state text not null default 'unallocated' check(fulfilment_state='unallocated'),
 reservation_state text not null default 'not_reserved' check(reservation_state='not_reserved'),
 row_version integer not null default 1 check(row_version>0),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(created_by,idempotency_key)
);
create table if not exists hardware_order_private (
 order_id uuid primary key references hardware_orders(id) on delete restrict,
 customer jsonb not null check(jsonb_typeof(customer)='object'),
 delivery jsonb not null check(jsonb_typeof(delivery)='object')
);
create table if not exists hardware_order_lines (
 order_id uuid not null references hardware_orders(id) on delete restrict,
 position integer not null check(position between 1 and 50),
 product_id uuid not null references catalogue_products(id) on delete restrict,
 product_version integer not null,
 variant_id uuid not null references catalogue_variants(id) on delete restrict,
 variant_row_version integer not null,
 price_change_id uuid not null references catalogue_price_changes(id) on delete restrict,
 sku text not null, product_name text not null, variant_name text not null, variant_options jsonb not null check(jsonb_typeof(variant_options)='object'),
 quantity integer not null check(quantity between 1 and 1000),
 unit_price_kobo bigint not null check(unit_price_kobo between 1 and 900000000),
 vat_treatment text not null check(vat_treatment in ('standard','exempt','zero_rated')),
 vat_rate_bp integer not null check(vat_rate_bp between 0 and 10000),
 gross_kobo bigint not null check(gross_kobo=unit_price_kobo*quantity),
 tax_kobo bigint not null check(tax_kobo between 0 and gross_kobo),
 sourcing text not null, availability_at_creation text not null check(availability_at_creation in ('in_stock','confirmation_required')),
 primary key(order_id,position), unique(order_id,variant_id),
 foreign key(product_id,product_version) references catalogue_product_versions(product_id,version) on delete restrict
);
create table if not exists hardware_order_events (
 id uuid primary key default gen_random_uuid(), order_id uuid not null references hardware_orders(id) on delete restrict,
 event_type text not null check(event_type in ('created','cancelled')), row_version integer not null,
 actor text not null, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(),
 unique(order_id,row_version)
);
create index if not exists hardware_orders_created_idx on hardware_orders(created_at desc,id);
create or replace function hardware_order_immutable() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin raise exception 'order_history_immutable' using errcode='PT409'; end $$;
create or replace function hardware_order_state_guard() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if tg_op<>'UPDATE' then raise exception 'order_history_immutable' using errcode='PT409'; end if;
 if (to_jsonb(new)-array['order_state','row_version','updated_at']) is distinct from (to_jsonb(old)-array['order_state','row_version','updated_at'])
 or old.order_state<>'awaiting_confirmation' or new.order_state<>'cancelled' or new.row_version<>old.row_version+1 then
 raise exception 'invalid_order_transition' using errcode='PT409'; end if;
 return new;
end $$;
do $$ declare t text; begin
 foreach t in array array['hardware_orders','hardware_order_private','hardware_order_lines','hardware_order_events'] loop
 execute format('alter table %I enable row level security',t);
 execute format('revoke all on table %I from public,anon,authenticated,service_role',t);
 execute format('grant select,insert,update,delete on table %I to service_role',t);
 execute format('drop trigger if exists order_no_truncate on %I',t);
 execute format('create trigger order_no_truncate before truncate on %I for each statement execute function hardware_order_immutable()',t);
 if t<>'hardware_orders' then
 execute format('drop trigger if exists order_immutable on %I',t);
 execute format('create trigger order_immutable before update or delete on %I for each row execute function hardware_order_immutable()',t);
 end if;
 end loop;
end $$;
drop trigger if exists order_state_guard on hardware_orders;
create trigger order_state_guard before update or delete on hardware_orders for each row execute function hardware_order_state_guard();
create or replace function hardware_order_require_actor(p_actor text,p_permission text) returns void language plpgsql set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from admin_users where lower(email)=p_actor and status='active' and removed_at is null
 and role in ('super_admin','ochiga_admin','ochiga_staff') and (role='super_admin' or p_permission='crm.read' or p_permission=any(coalesce(permission_scopes,'{}')))) then
 raise exception 'forbidden' using errcode='PT403'; end if;
end $$;
create or replace function hardware_order_create(p_actor text,p_key text,p_request jsonb) returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare o hardware_orders%rowtype; c crm_contacts%rowtype; v catalogue_variants%rowtype; p catalogue_products%rowtype;
 item jsonb; content jsonb; lines jsonb:='[]'; line jsonb; d jsonb; h text; pc uuid; cid uuid; oid uuid; opid uuid;
 q integer; pos integer:=0; gross bigint; tax bigint; total bigint:=0; taxes bigint:=0;
begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.create');
 perform hardware_order_require_actor(p_actor,'crm.read');
 if p_key is null or p_key !~ '^[A-Za-z0-9_-]{16,128}$' or jsonb_typeof(p_request) is distinct from 'object' or
 (p_request-array['contact_id','organization_id','opportunity_id','delivery','installation_requested','lines'])<>'{}'::jsonb then
 raise exception 'invalid_order_input' using errcode='PT400'; end if;
 h:=encode(sha256(convert_to(p_request::text,'UTF8')),'hex');
 -- Serialize same actor/key before looking at changing catalogue state; successful retries return the same order.
 perform pg_advisory_xact_lock(hashtextextended(p_actor||':'||p_key,0));
 select * into o from hardware_orders where created_by=p_actor and idempotency_key=p_key;
 if found then
 if o.request_hash<>h then raise exception 'idempotency_conflict' using errcode='PT409'; end if;
 return jsonb_build_object('id',o.id,'replayed',true); end if;
 begin cid:=(p_request->>'contact_id')::uuid; oid:=(p_request->>'organization_id')::uuid; opid:=(p_request->>'opportunity_id')::uuid;
 exception when invalid_text_representation then raise exception 'invalid_crm_reference' using errcode='PT400'; end;
 select * into c from crm_contacts where id=cid for share;
 if not found or (oid is not null and c.organization_id is distinct from oid) then raise exception 'invalid_crm_reference' using errcode='PT400'; end if;
 oid:=coalesce(oid,c.organization_id);
 if opid is not null and not exists(select 1 from crm_opportunities where id=opid and contact_id=cid and organization_id is not distinct from oid) then
 raise exception 'invalid_crm_reference' using errcode='PT400'; end if;
 d:=p_request->'delivery';
 if jsonb_typeof(d) is distinct from 'object' or (d-array['country','state','city','address','postcode'])<>'{}'::jsonb
 or d->>'country' is distinct from 'NG' or exists(select 1 from jsonb_each(d) x where jsonb_typeof(x.value)<>'string' or length(x.value#>>'{}')>500)
 or coalesce(length(trim(d->>'state')),0)=0 or coalesce(length(trim(d->>'city')),0)=0 or coalesce(length(trim(d->>'address')),0)=0
 or (p_request ? 'installation_requested' and jsonb_typeof(p_request->'installation_requested')<>'boolean') then raise exception 'invalid_delivery' using errcode='PT400'; end if;
 if jsonb_typeof(p_request->'lines') is distinct from 'array' or jsonb_array_length(p_request->'lines') not between 1 and 50 then raise exception 'invalid_order_lines' using errcode='PT400'; end if;
 -- Lock products before variants, matching catalogue edit order; requests use stable ID ordering.
 perform cp.id from catalogue_products cp where cp.id in
 (select cv.product_id from catalogue_variants cv join jsonb_array_elements(p_request->'lines') x on cv.id::text=x->>'variant_id') order by cp.id for share;
 for item in select value from jsonb_array_elements(p_request->'lines') order by value->>'variant_id' loop
 if jsonb_typeof(item) is distinct from 'object' or item-array['variant_id','quantity']<>'{}'::jsonb
 or jsonb_typeof(item->'quantity') is distinct from 'number' or (item->>'quantity') !~ '^[0-9]{1,4}$' then raise exception 'invalid_order_lines' using errcode='PT400'; end if;
 q:=(item->>'quantity')::integer; if q not between 1 and 1000 then raise exception 'invalid_quantity' using errcode='PT400'; end if;
 begin select * into v from catalogue_variants where id=(item->>'variant_id')::uuid for share;
 exception when invalid_text_representation then raise exception 'invalid_variant' using errcode='PT400'; end;
 if v.id is null or v.status<>'active' or v.sourcing='discontinued' then raise exception 'variant_unavailable' using errcode='PT409'; end if;
 if exists(select 1 from jsonb_array_elements(lines) x where x->>'variant_id'=v.id::text) then raise exception 'duplicate_variant' using errcode='PT400'; end if;
 select * into p from catalogue_products where id=v.product_id for share;
 if p.publication_status<>'published' or p.published_version is null or not exists(select 1 from catalogue_reviews r where r.product_id=p.id and r.version=p.published_version and r.decision='approved') then raise exception 'product_not_approved' using errcode='PT409'; end if;
 select pv.content into content from catalogue_product_versions pv where product_id=p.id and version=p.published_version;
 if not exists(select 1 from jsonb_array_elements(content->'variants') x where x->>'sku'=v.sku) then raise exception 'variant_not_published' using errcode='PT409'; end if;
 select x.id into pc from catalogue_price_changes x where x.variant_id=v.id and x.new_price_ngn_kobo=v.price_ngn_kobo
 and x.new_vat_treatment=v.vat_treatment and x.new_vat_rate_bp=v.vat_rate_bp
 and exists(select 1 from catalogue_price_decisions a where a.price_change_id=x.id and a.decision='approved' and a.actor<>x.requested_by)
 and exists(select 1 from catalogue_price_decisions b where b.price_change_id=x.id and b.decision='published') order by x.requested_at desc,x.id limit 1;
 if pc is null or v.price_ngn_kobo is null or v.price_ngn_kobo not between 1 and 900000000 then raise exception 'price_not_verified' using errcode='PT409'; end if;
 gross:=v.price_ngn_kobo*q; tax:=round(gross::numeric*v.vat_rate_bp/(10000+v.vat_rate_bp))::bigint;
 total:=total+gross; taxes:=taxes+tax; pos:=pos+1;
 line:=jsonb_build_object('position',pos,'product_id',p.id,'product_version',p.published_version,'variant_id',v.id,'variant_row_version',v.row_version,'price_change_id',pc,
 'sku',v.sku,'product_name',content->>'name','variant_name',(select x->>'name' from jsonb_array_elements(content->'variants') x where x->>'sku'=v.sku limit 1),
 'variant_options',coalesce((select x->'options' from jsonb_array_elements(content->'variants') x where x->>'sku'=v.sku limit 1),'{}'::jsonb),
 'quantity',q,'unit_price_kobo',v.price_ngn_kobo,'vat_treatment',v.vat_treatment,'vat_rate_bp',v.vat_rate_bp,'gross_kobo',gross,'tax_kobo',tax,
 'sourcing',v.sourcing,'availability_at_creation',case when v.sourcing='in_stock' and v.stock_on_hand-v.stock_reserved>=q then 'in_stock' else 'confirmation_required' end);
 lines:=lines||jsonb_build_array(line);
 end loop;
 if total>900000000000 then raise exception 'order_total_limit' using errcode='PT400'; end if;
 insert into hardware_orders(contact_id,organization_id,opportunity_id,created_by,idempotency_key,request_hash,goods_total_kobo,goods_tax_kobo,installation_requested)
 values(cid,oid,opid,p_actor,p_key,h,total,taxes,coalesce((p_request->>'installation_requested')::boolean,false)) returning * into o;
 insert into hardware_order_private values(o.id,jsonb_strip_nulls(jsonb_build_object('name',c.name,'email',c.email,'phone',c.phone)),d);
 insert into hardware_order_lines select o.id,x.* from jsonb_to_recordset(lines) as x(position integer,product_id uuid,product_version integer,variant_id uuid,variant_row_version integer,price_change_id uuid,sku text,product_name text,variant_name text,variant_options jsonb,quantity integer,unit_price_kobo bigint,vat_treatment text,vat_rate_bp integer,gross_kobo bigint,tax_kobo bigint,sourcing text,availability_at_creation text);
 insert into hardware_order_events(order_id,event_type,row_version,actor,metadata) values(o.id,'created',1,p_actor,jsonb_build_object('currency','NGN','goods_total_kobo',total,'goods_tax_kobo',taxes,'payment_eligible',false));
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_order_created','hardware_order',o.id::text,jsonb_build_object('row_version',1,'line_count',pos,'payment_eligible',false));
 insert into crm_activities(contact_id,organization_id,opportunity_id,related_type,related_id,activity_type,title,source,actor,metadata) values(cid,oid,opid,'hardware_order',o.id::text,'hardware_order_created','Hardware order awaiting confirmation','office',p_actor,jsonb_build_object('order_id',o.id));
 return jsonb_build_object('id',o.id,'replayed',false);
end $$;
create or replace function hardware_order_cancel(p_actor text,p_id uuid,p_expected integer) returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare o hardware_orders%rowtype;
begin
 perform hardware_order_require_actor(p_actor,'commerce.orders.cancel');
 select * into o from hardware_orders where id=p_id for update;
 if not found then raise exception 'order_not_found' using errcode='PT404'; end if;
 if o.order_state='cancelled' and o.row_version=p_expected+1 then return jsonb_build_object('id',o.id,'row_version',o.row_version,'order_state',o.order_state,'replayed',true); end if;
 if o.row_version<>p_expected or o.order_state<>'awaiting_confirmation' then raise exception 'order_state_changed' using errcode='PT409'; end if;
 update hardware_orders set order_state='cancelled',row_version=row_version+1,updated_at=now() where id=p_id returning * into o;
 insert into hardware_order_events(order_id,event_type,row_version,actor) values(o.id,'cancelled',o.row_version,p_actor);
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(p_actor,'hardware_order_cancelled','hardware_order',o.id::text,jsonb_build_object('row_version',o.row_version));
 insert into crm_activities(contact_id,organization_id,opportunity_id,related_type,related_id,activity_type,title,source,actor,metadata) values(o.contact_id,o.organization_id,o.opportunity_id,'hardware_order',o.id::text,'hardware_order_cancelled','Hardware order cancelled','office',p_actor,jsonb_build_object('order_id',o.id));
 return jsonb_build_object('id',o.id,'row_version',o.row_version,'order_state',o.order_state);
end $$;
do $$ declare f regprocedure; begin
 for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in ('hardware_order_immutable','hardware_order_state_guard','hardware_order_require_actor','hardware_order_create','hardware_order_cancel') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
 end loop;
end $$;

-- Every commit must contain a complete, financially consistent order and matching status/audit/CRM evidence.
create or replace function hardware_order_consistency() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare oid uuid; o hardware_orders%rowtype; n integer; gross bigint; tax bigint;
begin
 oid:=coalesce((to_jsonb(new)->>'order_id')::uuid,(to_jsonb(new)->>'id')::uuid);
 select * into o from hardware_orders where id=oid;
 select count(*),sum(gross_kobo),sum(tax_kobo) into n,gross,tax from hardware_order_lines where order_id=oid;
 if n not between 1 and 50 or gross is distinct from o.goods_total_kobo or tax is distinct from o.goods_tax_kobo
 or not exists(select 1 from hardware_order_private where order_id=oid)
 or (select count(*) from hardware_order_events where order_id=oid)<>o.row_version
 or not exists(select 1 from hardware_order_events where order_id=oid and row_version=1 and event_type='created' and actor=o.created_by)
 or (o.order_state='cancelled' and not exists(select 1 from hardware_order_events where order_id=oid and row_version=o.row_version and event_type='cancelled'))
 or exists(select 1 from hardware_order_events e where e.order_id=oid and (not exists(select 1 from audit_events a where a.target_type='hardware_order' and a.target_id=oid::text and a.action='hardware_order_'||e.event_type and a.actor_email=e.actor and (a.metadata->>'row_version')::integer=e.row_version)
 or not exists(select 1 from crm_activities a where a.related_type='hardware_order' and a.related_id=oid::text and a.activity_type='hardware_order_'||e.event_type and a.actor=e.actor and a.contact_id=o.contact_id)))
 or exists(select 1 from hardware_order_lines l join catalogue_variants v on v.id=l.variant_id where l.order_id=oid and (l.product_id<>v.product_id or l.sku<>v.sku or l.tax_kobo<>round(l.gross_kobo::numeric*l.vat_rate_bp/(10000+l.vat_rate_bp))::bigint)) then
 raise exception 'order_integrity_violation' using errcode='PT409'; end if;
 return null;
end $$;
revoke all on function hardware_order_consistency() from public,anon,authenticated;
grant execute on function hardware_order_consistency() to service_role;
do $$ declare t text; begin
 foreach t in array array['hardware_orders','hardware_order_lines','hardware_order_private','hardware_order_events'] loop
 execute format('drop trigger if exists order_consistency on %I',t);
 execute format('create constraint trigger order_consistency after insert or update on %I deferrable initially deferred for each row execute function hardware_order_consistency()',t);
 end loop;
end $$;
