begin;
-- Rollback of 20261109_catalogue_packages.sql. Refuses while any package or service exists (their history would lose its meaning).
-- Restores catalogue_public_requirements exactly as shipped in 20261105.
do $$ begin
  if exists (select 1 from catalogue_products where kind <> 'product') then raise exception 'packages or services exist; archive is not enough, rollback refused'; end if;
end $$;
drop trigger if exists catalogue_products_package_guard on catalogue_products;
drop trigger if exists catalogue_products_kind_fixed on catalogue_products;
drop function if exists catalogue_package_guard();
drop function if exists catalogue_package_issues(uuid, integer);
drop function if exists catalogue_create_item(text, text, uuid, uuid, jsonb, text);
drop function if exists catalogue_kind_fixed();
drop function if exists catalogue_packages_schema_version();
drop index if exists catalogue_products_kind_idx;
alter table catalogue_products drop constraint if exists catalogue_products_kind_check;
alter table catalogue_products drop column if exists kind;
create or replace function catalogue_public_requirements(p_product_id uuid) returns jsonb language plpgsql stable set search_path = public, pg_temp as $f$
declare p catalogue_products%rowtype; v catalogue_product_versions%rowtype; issues text[] := '{}'; media jsonb; listed jsonb;
begin
  select * into p from catalogue_products where id = p_product_id;
  if not found then raise exception 'product_not_found' using errcode = 'PT404'; end if;
  if p.publication_status = 'archived' then return to_jsonb(array['archived']); end if;
  if p.publication_status <> 'published' or p.published_version is null then return to_jsonb(array['not_published_internally']); end if;
  select * into v from catalogue_product_versions where product_id = p.id and version = p.published_version;
  if not exists (select 1 from catalogue_reviews r where r.product_id = p.id and r.version = p.published_version and r.decision = 'approved') then
    issues := array_append(issues, 'version_not_approved');
  end if;
  media := coalesce(v.content->'media', '[]'::jsonb);
  if jsonb_typeof(media) <> 'array' or jsonb_array_length(media) = 0 then
    issues := array_append(issues, 'no_images');
  else
    if (select count(*) from jsonb_array_elements(media) e where (e->>'cover')::boolean) <> 1 then issues := array_append(issues, 'no_cover'); end if;
    if exists (select 1 from jsonb_array_elements(media) e where coalesce(btrim(e->>'alt'), '') = '') then issues := array_append(issues, 'alt_text_missing'); end if;
    if exists (select 1 from jsonb_array_elements(media) e
                where not exists (select 1 from catalogue_media m where m.id = (e->>'media_id')::uuid and m.product_id = p.id and m.status = 'active')
                   or (select count(*) from catalogue_media_derivatives d where d.media_id = (e->>'media_id')::uuid) <> 4) then
      issues := array_append(issues, 'media_unavailable');
    end if;
  end if;
  select coalesce(jsonb_agg(x->>'sku'), '[]'::jsonb) into listed from jsonb_array_elements(coalesce(v.content->'variants', '[]'::jsonb)) x;
  if not exists (select 1 from catalogue_variants cv where cv.product_id = p.id and cv.status = 'active' and listed @> to_jsonb(array[cv.sku])) then
    issues := array_append(issues, 'no_active_variant');
  elsif exists (select 1 from catalogue_variants cv where cv.product_id = p.id and cv.status = 'active' and listed @> to_jsonb(array[cv.sku])
                   and (cv.price_ngn_kobo is null or cv.vat_treatment is null)) then
    issues := array_append(issues, 'price_not_approved');
  end if;
  return to_jsonb(issues);
end $f$;
do $$ begin
  revoke all on function catalogue_public_requirements(uuid) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function catalogue_public_requirements(uuid) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function catalogue_public_requirements(uuid) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function catalogue_public_requirements(uuid) to service_role; end if;
end $$;

commit;
