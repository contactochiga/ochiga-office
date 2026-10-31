-- Catalogue follow-up (Solutions & Packages, SP1): Office-managed packages and services on the EXISTING catalogue workflow.
-- ADDITIVE and IDEMPOTENT. Requires 20261102, 20261103 and 20261105. Every existing row stays kind = 'product' and behaves exactly as before.
--
-- Model
--   * catalogue_products.kind: 'product' (default, every existing row) | 'package' | 'service'. Fixed at creation (a trigger refuses a
--     change). Packages and services use the same immutable versions, second-person review, internal publication, approved prices
--     (catalogue_price_changes on their variants), media, slugs, public listings and refresh as products. No new permission.
--   * A package version's content carries `package`:
--       solution_types   residential | hospitality | commercial | mixed-use | healthcare
--       scope            hardware (text), software_deployment (text; always consultation-led, never priced),
--                        installation ('quoted_separately' | 'included': an approved price includes installation ONLY when 'included'),
--                        installation_note
--       configuration    custom (bool: custom configurations by consultation), per_unit_label (e.g. "per door")
--       components[]     sku, role (required | optional | recommended), basis (fixed | per_unit), quantity, quantities {size sku: n},
--                        note, snapshot {product_version, price_kobo}: what the component was when the package version was saved
--     and its variants are the package SIZES, each with pricing 'fixed' (needs an approved price to go public) or 'consultation'
--     (never priced; shown as by consultation).
--   * catalogue_package_issues(product, version): the blocking problems of one package version (empty = sound). Every component must be a
--     variant of an internally published, non-archived product or service (never another package); a required component must be
--     active and not discontinued; a component that changed since the snapshot (new published version or price) makes the package
--     "needs re-review". It reads no cost table.
--   * Enforced in the database (also when the application is bypassed): a package cannot be submitted, approved or published internally
--     while it has issues; catalogue_public_requirements additionally refuses public release of a package with issues, of a fixed-price
--     size without an approved price, of a consultation size that carries a price, and of any service (services are package components,
--     never listed on their own). The product branch of catalogue_public_requirements is unchanged.
-- Security: same shape as 20261102/20261105 (SECURITY INVOKER functions with pinned search_path, EXECUTE service_role only).
do $$ begin
  if to_regprocedure('public.catalogue_refuse_change()') is null then raise exception 'apply 20261102_catalogue_foundation.sql first'; end if;
  if to_regprocedure('public.catalogue_public_release(uuid, integer, integer, text)') is null then raise exception 'apply 20261105_catalogue_public_release.sql first'; end if;
end $$;

alter table catalogue_products add column if not exists kind text not null default 'product';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'catalogue_products_kind_check' and conrelid = 'public.catalogue_products'::regclass) then
    alter table catalogue_products add constraint catalogue_products_kind_check check (kind in ('product', 'package', 'service'));
  end if;
end $$;
create index if not exists catalogue_products_kind_idx on catalogue_products (kind);

create or replace function catalogue_packages_schema_version() returns integer language sql stable set search_path = public, pg_temp as $f$ select 1 $f$;

create or replace function catalogue_kind_fixed() returns trigger language plpgsql set search_path = public, pg_temp as $f$
begin
  if new.kind is distinct from old.kind then raise exception 'kind_immutable' using errcode = 'PT409'; end if;
  return new;
end $f$;

-- creation of any kind; catalogue_create_product (kind 'product') is unchanged
create or replace function catalogue_create_item(p_kind text, p_slug text, p_category_id uuid, p_brand_id uuid, p_content jsonb, p_actor text)
returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare p catalogue_products%rowtype;
begin
  if p_kind not in ('product', 'package', 'service') then raise exception 'invalid_kind' using errcode = '22023'; end if;
  insert into catalogue_products (slug, category_id, brand_id, created_by, updated_by, kind) values (p_slug, p_category_id, p_brand_id, p_actor, p_actor, p_kind)
  returning * into p;
  insert into catalogue_product_versions (product_id, version, content, materiality, author) values (p.id, 1, p_content, 'initial', p_actor);
  perform catalogue_register_variants(p.id, p_content->'variants');
  return to_jsonb(p);
exception when unique_violation then
  if exists (select 1 from catalogue_products where slug = p_slug) then raise exception 'slug_taken' using errcode = 'PT409'; end if;
  raise;
end $f$;

-- Blocking issues of one package version: [{code, sku?}] (empty = sound). Not a package -> [].
create or replace function catalogue_package_issues(p_product_id uuid, p_version integer) returns jsonb language plpgsql stable set search_path = public, pg_temp as $f$
declare k text; c jsonb; pkg jsonb; comp jsonb; sizes text[]; issues jsonb := '[]'::jsonb; cv catalogue_variants%rowtype; owner catalogue_products%rowtype;
        q record; add_issue boolean;
begin
  select kind into k from catalogue_products where id = p_product_id;
  if k is null then raise exception 'product_not_found' using errcode = 'PT404'; end if;
  if k <> 'package' then return issues; end if;
  select content into c from catalogue_product_versions where product_id = p_product_id and version = p_version;
  if c is null then raise exception 'version_not_found' using errcode = 'PT404'; end if;
  pkg := c->'package';
  if pkg is null or jsonb_typeof(pkg) <> 'object' then return jsonb_build_array(jsonb_build_object('code', 'package_content_missing')); end if;
  select coalesce(array_agg(x->>'sku'), '{}') into sizes from jsonb_array_elements(coalesce(c->'variants', '[]'::jsonb)) x;
  if exists (select 1 from jsonb_array_elements(coalesce(c->'variants', '[]'::jsonb)) x where coalesce(x->>'pricing', '') not in ('fixed', 'consultation')) then
    issues := issues || jsonb_build_array(jsonb_build_object('code', 'size_pricing_invalid'));
  end if;
  if coalesce(pkg->'scope'->>'installation', '') not in ('quoted_separately', 'included') then
    issues := issues || jsonb_build_array(jsonb_build_object('code', 'installation_scope_invalid'));
  end if;
  if jsonb_typeof(pkg->'components') is distinct from 'array' then
    return issues || jsonb_build_array(jsonb_build_object('code', 'no_components'));
  end if;
  if jsonb_array_length(pkg->'components') = 0 then
    return issues || jsonb_build_array(jsonb_build_object('code', 'no_components'));
  end if;
  for comp in select * from jsonb_array_elements(pkg->'components') loop
    select * into cv from catalogue_variants where sku = comp->>'sku';
    if not found then issues := issues || jsonb_build_array(jsonb_build_object('code', 'component_unknown', 'sku', comp->>'sku')); continue; end if;
    select * into owner from catalogue_products where id = cv.product_id;
    if owner.kind = 'package' or owner.id = p_product_id then
      issues := issues || jsonb_build_array(jsonb_build_object('code', 'component_is_package', 'sku', cv.sku)); continue;
    end if;
    if owner.publication_status = 'archived' then
      issues := issues || jsonb_build_array(jsonb_build_object('code', 'component_archived', 'sku', cv.sku)); continue;
    end if;
    if owner.publication_status <> 'published' or owner.published_version is null then
      issues := issues || jsonb_build_array(jsonb_build_object('code', 'component_not_published', 'sku', cv.sku)); continue;
    end if;
    if not exists (select 1 from catalogue_product_versions v, jsonb_array_elements(coalesce(v.content->'variants', '[]'::jsonb)) x
                    where v.product_id = owner.id and v.version = owner.published_version and x->>'sku' = cv.sku) then
      issues := issues || jsonb_build_array(jsonb_build_object('code', 'component_not_in_published_version', 'sku', cv.sku)); continue;
    end if;
    if coalesce(comp->>'role', '') = 'required' and cv.status <> 'active' then
      issues := issues || jsonb_build_array(jsonb_build_object('code', 'component_inactive', 'sku', cv.sku));
    elsif coalesce(comp->>'role', '') = 'required' and cv.sourcing = 'discontinued' then
      issues := issues || jsonb_build_array(jsonb_build_object('code', 'component_discontinued', 'sku', cv.sku));
    end if;
    if (comp->'snapshot'->>'product_version') is distinct from owner.published_version::text
       or (comp->'snapshot'->>'price_kobo') is distinct from cv.price_ngn_kobo::text then
      issues := issues || jsonb_build_array(jsonb_build_object('code', 'component_changed', 'sku', cv.sku));
    end if;
    for q in select key from jsonb_each(coalesce(comp->'quantities', '{}'::jsonb)) loop
      if not (q.key = any(sizes)) then
        issues := issues || jsonb_build_array(jsonb_build_object('code', 'quantity_size_unknown', 'sku', cv.sku, 'size', q.key));
      end if;
    end loop;
  end loop;
  return issues;
end $f$;

-- a package with issues cannot enter review, be approved or be published internally (also when the application is bypassed)
create or replace function catalogue_package_guard() returns trigger language plpgsql set search_path = public, pg_temp as $f$
declare issues jsonb;
begin
  if new.kind <> 'package' then return new; end if;
  if (new.workflow_status in ('in_review', 'approved') and new.workflow_status is distinct from old.workflow_status)
     or (new.published_version is not null and new.published_version is distinct from old.published_version) then
    issues := catalogue_package_issues(new.id, new.current_version);
    if jsonb_array_length(issues) > 0 then
      raise exception 'package_components_invalid' using errcode = 'PT409', detail = jsonb_build_object('issues', issues)::text;
    end if;
  end if;
  return new;
end $f$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_products_kind_fixed' and tgrelid = 'public.catalogue_products'::regclass) then
    create trigger catalogue_products_kind_fixed before update of kind on catalogue_products for each row execute function catalogue_kind_fixed();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_products_package_guard' and tgrelid = 'public.catalogue_products'::regclass) then
    create trigger catalogue_products_package_guard before update on catalogue_products for each row execute function catalogue_package_guard();
  end if;
end $$;

-- What still prevents public release ([] = releasable). Products: exactly as 20261105. Services: never on their own. Packages: the product
-- rules, except that only FIXED-price sizes need an approved price (a consultation size must carry none), plus the package's own issues.
create or replace function catalogue_public_requirements(p_product_id uuid) returns jsonb language plpgsql stable set search_path = public, pg_temp as $f$
declare p catalogue_products%rowtype; v catalogue_product_versions%rowtype; issues text[] := '{}'; media jsonb; listed jsonb; fixed jsonb; consult jsonb;
begin
  select * into p from catalogue_products where id = p_product_id;
  if not found then raise exception 'product_not_found' using errcode = 'PT404'; end if;
  if p.publication_status = 'archived' then return to_jsonb(array['archived']); end if;
  if p.kind = 'service' then return to_jsonb(array['service_not_listed']); end if;
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
  if p.kind = 'package' then
    select coalesce(jsonb_agg(x->>'sku'), '[]'::jsonb) into fixed from jsonb_array_elements(coalesce(v.content->'variants', '[]'::jsonb)) x where x->>'pricing' = 'fixed';
    select coalesce(jsonb_agg(x->>'sku'), '[]'::jsonb) into consult from jsonb_array_elements(coalesce(v.content->'variants', '[]'::jsonb)) x where x->>'pricing' = 'consultation';
    if not exists (select 1 from catalogue_variants cv where cv.product_id = p.id and cv.status = 'active' and listed @> to_jsonb(array[cv.sku])) then
      issues := array_append(issues, 'no_active_variant');
    elsif exists (select 1 from catalogue_variants cv where cv.product_id = p.id and cv.status = 'active' and fixed @> to_jsonb(array[cv.sku])
                     and (cv.price_ngn_kobo is null or cv.vat_treatment is null)) then
      issues := array_append(issues, 'price_not_approved');
    end if;
    if exists (select 1 from catalogue_variants cv where cv.product_id = p.id and consult @> to_jsonb(array[cv.sku]) and cv.price_ngn_kobo is not null) then
      issues := array_append(issues, 'consultation_size_priced');
    end if;
    if jsonb_array_length(catalogue_package_issues(p.id, p.published_version)) > 0 then
      issues := array_append(issues, 'package_components_invalid');
    end if;
    return to_jsonb(issues);
  end if;
  if not exists (select 1 from catalogue_variants cv where cv.product_id = p.id and cv.status = 'active' and listed @> to_jsonb(array[cv.sku])) then
    issues := array_append(issues, 'no_active_variant');
  elsif exists (select 1 from catalogue_variants cv where cv.product_id = p.id and cv.status = 'active' and listed @> to_jsonb(array[cv.sku])
                   and (cv.price_ngn_kobo is null or cv.vat_treatment is null)) then
    issues := array_append(issues, 'price_not_approved');
  end if;
  return to_jsonb(issues);
end $f$;

-- ---------------------------------------------------------------- privileges
do $$
declare f text;
begin
  foreach f in array array['catalogue_packages_schema_version()', 'catalogue_kind_fixed()', 'catalogue_create_item(text, text, uuid, uuid, jsonb, text)',
                           'catalogue_package_issues(uuid, integer)', 'catalogue_package_guard()', 'catalogue_public_requirements(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
