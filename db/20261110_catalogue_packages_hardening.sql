-- Catalogue follow-up (Solutions & Packages hardening; review of 242f45c, 2026-11-11). Replaces ONLY catalogue_package_issues; same
-- signature, SECURITY INVOKER, pinned search_path and service_role-only EXECUTE. Requires 20261109_catalogue_packages.sql.
--   * a component that is not a JSON object -> issue 'component_invalid' (was a raw error or a silent 'component_unknown');
--   * component quantities that are not a JSON object -> issue 'quantities_invalid' (jsonb_each raised a raw error);
--   * the unused variable add_issue is removed.
-- Both shapes are refused by the application's validation; this only matters when the application is bypassed. Every other rule and
-- issue code is unchanged. No table, row, trigger or privilege is changed. A follow-up file (not an edit of 20261109) because that
-- migration is recorded as installed in production.
do $$ begin
  if to_regprocedure('public.catalogue_package_issues(uuid, integer)') is null then raise exception 'apply 20261109_catalogue_packages.sql first'; end if;
end $$;

create or replace function catalogue_package_issues(p_product_id uuid, p_version integer) returns jsonb language plpgsql stable set search_path = public, pg_temp as $f$
declare k text; c jsonb; pkg jsonb; comp jsonb; sizes text[]; issues jsonb := '[]'::jsonb; cv catalogue_variants%rowtype; owner catalogue_products%rowtype;
        q record;
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
    -- malformed content (only possible when the application is bypassed) is an issue, never a raw error
    if jsonb_typeof(comp) is distinct from 'object' then
      issues := issues || jsonb_build_array(jsonb_build_object('code', 'component_invalid')); continue;
    end if;
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
    if jsonb_typeof(coalesce(comp->'quantities', '{}'::jsonb)) is distinct from 'object' then
      issues := issues || jsonb_build_array(jsonb_build_object('code', 'quantities_invalid', 'sku', cv.sku)); continue;
    end if;
    for q in select key from jsonb_each(coalesce(comp->'quantities', '{}'::jsonb)) loop
      if not (q.key = any(sizes)) then
        issues := issues || jsonb_build_array(jsonb_build_object('code', 'quantity_size_unknown', 'sku', cv.sku, 'size', q.key));
      end if;
    end loop;
  end loop;
  return issues;
end $f$;

do $$
begin
  revoke all on function catalogue_package_issues(uuid, integer) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function catalogue_package_issues(uuid, integer) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function catalogue_package_issues(uuid, integer) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function catalogue_package_issues(uuid, integer) to service_role; end if;
end $$;
