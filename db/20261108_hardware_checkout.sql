-- LOCAL ONLY. Stage 4B non-payable guest requests. Apply after reviewed Stage 4A, transactionally.
create table hardware_checkout_receipts (
 client text not null, guest_hash text not null check(guest_hash ~ '^[0-9a-f]{64}$'),
 idempotency_key text not null, request_hash text not null,
 order_id uuid not null unique references hardware_orders(id) on delete restrict,
 created_at timestamptz not null default now(), primary key(client,guest_hash,idempotency_key)
);
alter table hardware_checkout_receipts enable row level security;
revoke all on hardware_checkout_receipts from public,anon,authenticated,service_role;
grant select,insert,update,delete on hardware_checkout_receipts to service_role;
create trigger checkout_receipts_immutable before update or delete on hardware_checkout_receipts for each row execute function hardware_order_immutable();
create trigger checkout_receipts_no_truncate before truncate on hardware_checkout_receipts for each statement execute function hardware_order_immutable();
create function hardware_checkout_quote(p_lines jsonb) returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare v catalogue_variants%rowtype; p catalogue_products%rowtype; item jsonb; content jsonb; lines jsonb:='[]'; line jsonb; pc uuid;
 q integer; pos integer:=0; gross bigint; tax bigint; total bigint:=0; taxes bigint:=0; result jsonb;
begin
 if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 1 and 50 then raise exception 'invalid_order_lines' using errcode='PT400'; end if;
 -- Lock products before variants, matching catalogue edit order; requests use stable ID ordering.
 perform cp.id from catalogue_products cp where cp.id in
 (select cv.product_id from catalogue_variants cv join jsonb_array_elements(p_lines) x on cv.id::text=x->>'variant_id') order by cp.id for share;
 for item in select value from jsonb_array_elements(p_lines) order by value->>'variant_id' loop
 if jsonb_typeof(item) is distinct from 'object' or item-array['variant_id','quantity']<>'{}'::jsonb
 or jsonb_typeof(item->'quantity') is distinct from 'number' or (item->>'quantity') !~ '^[0-9]{1,4}$' then raise exception 'invalid_order_lines' using errcode='PT400'; end if;
 q:=(item->>'quantity')::integer; if q not between 1 and 1000 then raise exception 'invalid_quantity' using errcode='PT400'; end if;
 begin select * into v from catalogue_variants where id=(item->>'variant_id')::uuid for share;
 exception when invalid_text_representation then raise exception 'invalid_variant' using errcode='PT400'; end;
 if v.id is null or v.status<>'active' or v.sourcing='discontinued' then raise exception 'variant_unavailable' using errcode='PT409'; end if;
 if exists(select 1 from jsonb_array_elements(lines) x where x->>'variant_id'=v.id::text) then raise exception 'duplicate_variant' using errcode='PT400'; end if;
 select * into p from catalogue_products where id=v.product_id for share;
 perform 1 from catalogue_public_listings where product_id=p.id and status='public' and public_version=p.published_version for share;
 if not found then raise exception 'product_unavailable' using errcode='PT409'; end if;
 if v.sourcing<>'in_stock' or v.stock_on_hand-v.stock_reserved<q then raise exception 'stock_unavailable' using errcode='PT409'; end if;
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

 result:=jsonb_build_object('lines',lines,'goods_total_kobo',total,'goods_tax_kobo',taxes,'delivery_total_kobo',null,'payable_total_kobo',null,'payment_eligible',false);
 return result||jsonb_build_object('quote_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end $$;
create function hardware_checkout_submit(p_client text,p_guest_hash text,p_key text,p_request jsonb,p_quote_hash text) returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare r hardware_checkout_receipts%rowtype; h text; actor text; quote jsonb; customer jsonb; d jsonb; cid uuid; opid uuid; oid uuid;
begin
 if p_client is null or p_client !~ '^[a-zA-Z0-9_-]{1,80}$' or p_guest_hash is null or p_guest_hash !~ '^[0-9a-f]{64}$' or p_key is null or p_key !~ '^[A-Za-z0-9_-]{16,128}$'
 or jsonb_typeof(p_request) is distinct from 'object' or p_request-array['customer','delivery','installation_requested','lines']<>'{}' then raise exception 'invalid_checkout' using errcode='PT400'; end if;
 h:=encode(sha256(convert_to(p_request::text,'UTF8')),'hex'); actor:='checkout:'||p_client;
 perform pg_advisory_xact_lock(hashtextextended(p_client||':'||p_guest_hash||':'||p_key,0));
 select * into r from hardware_checkout_receipts where client=p_client and guest_hash=p_guest_hash and idempotency_key=p_key;
 if found then
 if r.request_hash<>h then raise exception 'idempotency_conflict' using errcode='PT409'; end if;
 return jsonb_build_object('id',r.order_id,'replayed',true,'payment_eligible',false); end if;
 customer:=p_request->'customer'; d:=p_request->'delivery';
 if jsonb_typeof(customer) is distinct from 'object' or customer-array['name','email','phone']<>'{}'
 or exists(select 1 from jsonb_each(customer) x where jsonb_typeof(x.value)<>'string')
 or coalesce(length(trim(customer->>'name')),0) not between 2 and 160
 or coalesce(customer->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(customer->>'email')>254
 or coalesce(customer->>'phone','') !~ '^[+0-9 ()-]{7,30}$' then raise exception 'invalid_customer' using errcode='PT400'; end if;
 if jsonb_typeof(d) is distinct from 'object' or d-array['country','state','city','address','postcode']<>'{}' or d->>'country' is distinct from 'NG'
 or coalesce(d->>'state','')<>all(array['Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue','Borno','Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','FCT','Gombe','Imo','Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi','Kwara','Lagos','Nasarawa','Niger','Ogun','Ondo','Osun','Oyo','Plateau','Rivers','Sokoto','Taraba','Yobe','Zamfara'])
 or exists(select 1 from jsonb_each(d) x where jsonb_typeof(x.value)<>'string' or length(x.value#>>'{}')>500)
 or coalesce(length(trim(d->>'city')),0) not between 1 and 120 or coalesce(length(trim(d->>'address')),0) not between 5 and 500
 or jsonb_typeof(p_request->'installation_requested') is distinct from 'boolean' then raise exception 'delivery_restricted' using errcode='PT400'; end if;
 quote:=hardware_checkout_quote(p_request->'lines');
 if p_quote_hash is distinct from quote->>'quote_hash' then raise exception 'price_changed' using errcode='PT409'; end if;
 -- Unverified guest contact details never merge into or overwrite an existing CRM customer by email.
 insert into crm_contacts(name,email,phone,source,metadata) values(trim(customer->>'name'),lower(trim(customer->>'email')),trim(customer->>'phone'),'getoyi_checkout',jsonb_build_object('identity_verified',false)) returning id into cid;
 insert into crm_opportunities(contact_id,business_unit,inquiry_type,pipeline,source,metadata) values(cid,'getoyi','hardware_order','corporate','getoyi_checkout',jsonb_build_object('payment_eligible',false,'installation_requested',p_request->'installation_requested')) returning id into opid;
 insert into hardware_orders(contact_id,opportunity_id,created_by,idempotency_key,request_hash,goods_total_kobo,goods_tax_kobo,installation_requested)
 values(cid,opid,actor,encode(sha256(convert_to(p_guest_hash||':'||p_key,'UTF8')),'hex'),h,(quote->>'goods_total_kobo')::bigint,(quote->>'goods_tax_kobo')::bigint,(p_request->>'installation_requested')::boolean) returning id into oid;
 insert into hardware_order_private values(oid,customer,d);
 insert into hardware_order_lines select oid,x.* from jsonb_to_recordset(quote->'lines') as x(position integer,product_id uuid,product_version integer,variant_id uuid,variant_row_version integer,price_change_id uuid,sku text,product_name text,variant_name text,variant_options jsonb,quantity integer,unit_price_kobo bigint,vat_treatment text,vat_rate_bp integer,gross_kobo bigint,tax_kobo bigint,sourcing text,availability_at_creation text);
 insert into hardware_order_events(order_id,event_type,row_version,actor,metadata) values(oid,'created',1,actor,jsonb_build_object('payment_eligible',false,'source','getoyi_checkout'));
 insert into audit_events(actor_email,action,target_type,target_id,metadata) values(actor,'hardware_order_created','hardware_order',oid::text,jsonb_build_object('row_version',1,'payment_eligible',false,'source','getoyi_checkout'));
 insert into crm_activities(contact_id,opportunity_id,related_type,related_id,activity_type,title,source,actor,metadata) values(cid,opid,'hardware_order',oid::text,'hardware_order_created','Hardware order awaiting confirmation','getoyi_checkout',actor,jsonb_build_object('order_id',oid,'payment_eligible',false));
 insert into hardware_checkout_receipts(client,guest_hash,idempotency_key,request_hash,order_id) values(p_client,p_guest_hash,p_key,h,oid);
 return jsonb_build_object('id',oid,'replayed',false,'payment_eligible',false);
end $$;
create function hardware_checkout_get(p_client text,p_guest_hash text,p_id uuid) returns jsonb language sql set search_path=public,pg_temp as $$
 select jsonb_build_object('id',o.id,'order_state',o.order_state,'payment_eligible',false,'goods_total_kobo',o.goods_total_kobo,'goods_tax_kobo',o.goods_tax_kobo,'delivery_total_kobo',o.delivery_total_kobo,'payable_total_kobo',o.payable_total_kobo)
 from hardware_orders o join hardware_checkout_receipts r on r.order_id=o.id where o.id=p_id and r.client=p_client and r.guest_hash=p_guest_hash
$$;
do $$ declare f regprocedure; begin
 for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname like 'hardware_checkout_%' loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f); execute format('grant execute on function %s to service_role',f);
 end loop;
end $$;
