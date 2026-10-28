-- LOCAL CANDIDATE ONLY. Additive receipts; no existing product/order/payment schema changes.
-- Production application requires separate release review. Reuses catalogue_create_product and audit_events.
begin;
create table if not exists catalogue_ingestion_receipts (
 actor text not null, source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
 candidate_key text not null check(length(candidate_key) between 1 and 80),
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 product_id uuid not null references catalogue_products(id) on delete restrict,
 review_file text not null check(review_file ~ '^catalogue_import_[a-z0-9_]+\.json$'),
 created_at timestamptz not null default now(), primary key(actor,source_sha256,candidate_key)
);
alter table catalogue_ingestion_receipts enable row level security;
do $$ begin
 if not exists(select 1 from pg_trigger where tgrelid='catalogue_ingestion_receipts'::regclass and tgname='catalogue_ingestion_receipts_append_only') then
 create trigger catalogue_ingestion_receipts_append_only before update or delete on catalogue_ingestion_receipts for each row execute function catalogue_refuse_change(); end if;
 if not exists(select 1 from pg_trigger where tgrelid='catalogue_ingestion_receipts'::regclass and tgname='catalogue_ingestion_receipts_no_truncate') then
 create trigger catalogue_ingestion_receipts_no_truncate before truncate on catalogue_ingestion_receipts for each statement execute function catalogue_refuse_change(); end if;
end $$;
create or replace function catalogue_ingestion_create(p_actor text,p_source text,p_candidate text,p_review text,p_slug text,p_category uuid,p_brand uuid,p_content jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare receipt catalogue_ingestion_receipts%rowtype; product jsonb; fingerprint text;
begin
 if p_actor is null or length(p_actor)<3 or p_source !~ '^[a-f0-9]{64}$' or p_candidate is null or length(p_candidate) not between 1 and 80 or p_review !~ '^catalogue_import_[a-z0-9_]+\.json$' then raise exception 'invalid_ingestion_request' using errcode='PT400'; end if;
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('slug',p_slug,'category',p_category,'brand',p_brand,'content',p_content)::text,'UTF8')),'hex');
 -- A transaction lock, not an application-memory lock. Survives concurrent workers and releases on crash.
 perform pg_advisory_xact_lock(hashtextextended(p_actor||':'||p_source||':'||p_candidate,0));
 select * into receipt from catalogue_ingestion_receipts where actor=p_actor and source_sha256=p_source and candidate_key=p_candidate;
 if found then
  if receipt.request_hash<>fingerprint then raise exception 'ingestion_receipt_mismatch' using errcode='PT409'; end if;
  return to_jsonb(receipt);
 end if;
 if not exists(select 1 from catalogue_categories where id=p_category and status='active') then raise exception 'category_not_found' using errcode='PT400'; end if;
 if p_brand is not null and not exists(select 1 from catalogue_brands where id=p_brand and status='active') then raise exception 'brand_not_found' using errcode='PT400'; end if;
 if coalesce(jsonb_array_length(p_content->'media'),0)>0 then raise exception 'invalid_import_draft' using errcode='PT400'; end if;
 product:=catalogue_create_product(p_slug,p_category,p_brand,p_content,p_actor);
 insert into catalogue_ingestion_receipts(actor,source_sha256,candidate_key,request_hash,product_id,review_file)
 values(p_actor,p_source,p_candidate,fingerprint,(product->>'id')::uuid,p_review) returning * into receipt;
 insert into audit_events(actor_email,action,target_type,target_id,metadata)
 values(p_actor,'catalogue_product_imported','catalogue_product',product->>'id',jsonb_build_object('version',1,'source_sha256',p_source,'candidate_key',p_candidate,'review_file',p_review,'pricing','unapproved_source_reference','ingestion_version',2));
 return to_jsonb(receipt);
end $$;
revoke all on catalogue_ingestion_receipts from public,anon,authenticated,service_role;
-- Match existing catalogue history permissions; triggers deny mutation even to owner/service_role.
grant select,insert,update,delete on catalogue_ingestion_receipts to service_role;
revoke all on function catalogue_ingestion_create(text,text,text,text,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function catalogue_ingestion_create(text,text,text,text,text,uuid,uuid,jsonb) to service_role;
create or replace function catalogue_ingestion_identity_page(p_offset integer)
returns setof jsonb language sql stable security invoker set search_path=public,pg_temp as $$
 select jsonb_build_object('id',p.id,'slug',p.slug,'brand_id',p.brand_id,'current_version',p.current_version,'name',v.content->>'name','model',v.content->>'model')
 from catalogue_products p join catalogue_product_versions v on v.product_id=p.id and v.version=p.current_version
 order by p.id offset greatest(0,least(p_offset,50000)) limit 200
$$;
revoke all on function catalogue_ingestion_identity_page(integer) from public,anon,authenticated;
grant execute on function catalogue_ingestion_identity_page(integer) to service_role;
commit;
