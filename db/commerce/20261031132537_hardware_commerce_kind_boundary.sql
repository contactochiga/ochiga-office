-- LOCAL REVIEW ONLY. Apply AFTER Phase 4F, Phase 5D and catalogue packages.
-- Explicit manifest order is authoritative; never filename-sort these historical migrations.
-- Keep original financial history, privileges and hardware rules; exclude consultation items.
begin;

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
 if p.kind is distinct from 'product' then raise exception 'product_not_orderable' using errcode='PT409'; end if;
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

create or replace function hardware_checkout_quote(p_lines jsonb) returns jsonb language plpgsql set search_path=public,pg_temp as $$
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
 if p.kind is distinct from 'product' then raise exception 'product_not_orderable' using errcode='PT409'; end if;
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

revoke all on function hardware_order_create(text,text,jsonb), hardware_checkout_quote(jsonb) from public, anon, authenticated;
grant execute on function hardware_order_create(text,text,jsonb), hardware_checkout_quote(jsonb) to service_role;
commit;
