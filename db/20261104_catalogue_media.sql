-- Catalogue follow-up (Phase 2 stage 3): product gallery media.
-- ADDITIVE and IDEMPOTENT: two new tables, triggers and functions; no existing table, row, grant or function is changed. Requires 20261102
-- and the bootstrap office_files table (uploads keep using the existing Office storage service and its office_files metadata).
--
-- Model
--   * catalogue_media: one uploaded image of one product. The original is a PRIVATE office_files object (never served); the row is
--     immutable except for one transition, active -> removed, and that only while NO product version references it.
--   * catalogue_media_derivatives: the processed, metadata-stripped WebP renditions (thumb / w480 / w960 / w1600), APPEND-ONLY.
--   * Product versions reference media by id inside content.media ([{media_id, cover, alt, caption, variant_skus}], array order = gallery
--     order). Versions are already append-only, so every historical version keeps resolving its images: referenced media can be neither
--     removed nor deleted, and office_files rows behind media are protected by ON DELETE RESTRICT.
--   * A BEFORE INSERT trigger on catalogue_product_versions checks every new version's gallery: at most 12 images, no duplicates, exactly
--     one cover when not empty, every image an ACTIVE media row of the SAME product (locked FOR SHARE, so a concurrent removal waits and
--     then fails, or the version insert fails), every variant association a SKU of that version.
-- Security: same shape as 20261102 (RLS on, no policy, nothing for PUBLIC/anon/authenticated, SECURITY INVOKER functions with pinned
-- search_path, EXECUTE service_role only, history without TRUNCATE).
do $$ begin
  if to_regprocedure('public.catalogue_refuse_change()') is null then raise exception 'apply 20261102_catalogue_foundation.sql first'; end if;
  if to_regclass('public.office_files') is null then raise exception 'office_files (db/lead-agents-schema.sql) is required'; end if;
end $$;

create table if not exists catalogue_media (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references catalogue_products(id) on delete restrict,
  office_file_id text not null unique references office_files(id) on delete restrict,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  format text not null check (format in ('jpeg', 'png', 'webp')),
  width integer not null check (width between 1 and 12000),
  height integer not null check (height between 1 and 12000),
  bytes integer not null check (bytes between 1 and 15728640),
  original_name text not null default '' check (length(original_name) <= 200),
  status text not null default 'active' check (status in ('active', 'removed')),
  uploaded_by text not null check (length(uploaded_by) between 1 and 320),
  created_at timestamptz not null default now(),
  removed_by text check (removed_by is null or length(removed_by) between 1 and 320),
  removed_at timestamptz,
  check ((status = 'removed') = (removed_at is not null and removed_by is not null))
);
-- the same bytes uploaded twice to one product resolve to the existing image (idempotent retry)
create unique index if not exists catalogue_media_product_sha_active_idx on catalogue_media (product_id, sha256) where status = 'active';
create index if not exists catalogue_media_product_idx on catalogue_media (product_id, created_at);

create table if not exists catalogue_media_derivatives (
  media_id uuid not null references catalogue_media(id) on delete restrict,
  kind text not null check (kind in ('thumb', 'w480', 'w960', 'w1600')),
  office_file_id text not null unique references office_files(id) on delete restrict,
  format text not null check (format = 'webp'),
  width integer not null check (width between 1 and 1600),
  height integer not null check (height between 1 and 1600),
  bytes integer not null check (bytes between 1 and 15728640),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (media_id, kind)
);

-- ---------------------------------------------------------------- integrity triggers
create or replace function catalogue_media_guard() returns trigger language plpgsql set search_path = public, pg_temp as $f$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'append_only: % on % is not allowed', tg_op, tg_table_name using errcode = '42501';
  end if;
  if not (old.status = 'active' and new.status = 'removed'
          and (new.id, new.product_id, new.office_file_id, new.sha256, new.format, new.width, new.height, new.bytes, new.original_name, new.uploaded_by, new.created_at)
              is not distinct from (old.id, old.product_id, old.office_file_id, old.sha256, old.format, old.width, old.height, old.bytes, old.original_name, old.uploaded_by, old.created_at)) then
    raise exception 'append_only: only active -> removed is allowed on %', tg_table_name using errcode = '42501';
  end if;
  -- referenced by any version (draft, reviewed, published or historical): it stays
  if exists (select 1 from catalogue_product_versions v
              where v.product_id = old.product_id and v.content->'media' @> jsonb_build_array(jsonb_build_object('media_id', old.id::text))) then
    raise exception 'media_referenced' using errcode = 'PT409';
  end if;
  return new;
end $f$;

create or replace function catalogue_version_media_check() returns trigger language plpgsql set search_path = public, pg_temp as $f$
declare media jsonb := new.content->'media'; refs uuid[]; n integer; skus jsonb;
begin
  if media is null or media = 'null'::jsonb then return new; end if;
  if jsonb_typeof(media) <> 'array' then raise exception 'invalid_gallery' using errcode = 'PT400'; end if;
  if jsonb_array_length(media) = 0 then return new; end if;
  if jsonb_array_length(media) > 12 then raise exception 'gallery_too_large' using errcode = 'PT400'; end if;
  if exists (select 1 from jsonb_array_elements(media) e
              where jsonb_typeof(e) <> 'object' or coalesce(e->>'media_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 or jsonb_typeof(e->'cover') is distinct from 'boolean'
                 or (e ? 'variant_skus' and jsonb_typeof(e->'variant_skus') <> 'array')) then
    raise exception 'invalid_gallery' using errcode = 'PT400';
  end if;
  select array_agg((e->>'media_id')::uuid) into refs from jsonb_array_elements(media) e;
  if (select count(distinct r) from unnest(refs) r) <> cardinality(refs) then raise exception 'gallery_duplicate_image' using errcode = 'PT400'; end if;
  if (select count(*) from jsonb_array_elements(media) e where (e->>'cover')::boolean) <> 1 then
    raise exception 'gallery_cover_required' using errcode = 'PT400';
  end if;
  select coalesce(jsonb_agg(v->>'sku'), '[]'::jsonb) into skus from jsonb_array_elements(coalesce(new.content->'variants', '[]'::jsonb)) v;
  if exists (select 1 from jsonb_array_elements(media) e, jsonb_array_elements(coalesce(e->'variant_skus', '[]'::jsonb)) s
              where not skus @> jsonb_build_array(s)) then
    raise exception 'gallery_unknown_variant' using errcode = 'PT400';
  end if;
  -- lock the referenced rows so a concurrent removal either waits for this version (and is then refused) or wins first (and this fails)
  perform 1 from catalogue_media m where m.id = any(refs) and m.product_id = new.product_id and m.status = 'active' for share;
  get diagnostics n = row_count;
  if n <> cardinality(refs) then raise exception 'media_not_available' using errcode = 'PT409'; end if;
  return new;
end $f$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_media_guarded' and tgrelid = 'public.catalogue_media'::regclass) then
    create trigger catalogue_media_guarded before update or delete on catalogue_media for each row execute function catalogue_media_guard();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_media_no_truncate' and tgrelid = 'public.catalogue_media'::regclass) then
    create trigger catalogue_media_no_truncate before truncate on catalogue_media for each statement execute function catalogue_refuse_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_media_derivatives_append_only' and tgrelid = 'public.catalogue_media_derivatives'::regclass) then
    create trigger catalogue_media_derivatives_append_only before update or delete on catalogue_media_derivatives for each row execute function catalogue_refuse_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_media_derivatives_no_truncate' and tgrelid = 'public.catalogue_media_derivatives'::regclass) then
    create trigger catalogue_media_derivatives_no_truncate before truncate on catalogue_media_derivatives for each statement execute function catalogue_refuse_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_product_versions_media_check' and tgrelid = 'public.catalogue_product_versions'::regclass) then
    create trigger catalogue_product_versions_media_check before insert on catalogue_product_versions for each row execute function catalogue_version_media_check();
  end if;
end $$;

-- ---------------------------------------------------------------- functions
create or replace function catalogue_media_schema_version() returns integer language sql stable set search_path = public, pg_temp as $f$ select 1 $f$;

-- Registers one processed upload (original + derivatives, already stored privately) in one transaction. The same bytes uploaded again to
-- the same product return the existing image with "deduplicated": true (the caller then removes its own duplicate objects).
create or replace function catalogue_register_media(p_product_id uuid, p_office_file_id text, p_sha256 text, p_format text, p_width integer,
                                                    p_height integer, p_bytes integer, p_original_name text, p_derivatives jsonb, p_actor text)
returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare p catalogue_products%rowtype; m catalogue_media%rowtype; d jsonb;
begin
  select * into p from catalogue_products where id = p_product_id for share;
  if not found then raise exception 'product_not_found' using errcode = 'PT404'; end if;
  if p.publication_status = 'archived' then raise exception 'product_archived' using errcode = 'PT409'; end if;
  select * into m from catalogue_media where product_id = p_product_id and sha256 = p_sha256 and status = 'active';
  if found then
    return to_jsonb(m) || jsonb_build_object('deduplicated', true);
  end if;
  if (select count(*) from catalogue_media where product_id = p_product_id and status = 'active') >= 60 then
    raise exception 'media_limit' using errcode = 'PT409';
  end if;
  if jsonb_typeof(p_derivatives) <> 'array' or jsonb_array_length(p_derivatives) <> 4 then raise exception 'invalid_derivatives' using errcode = 'PT400'; end if;
  begin
    insert into catalogue_media (product_id, office_file_id, sha256, format, width, height, bytes, original_name, uploaded_by)
    values (p_product_id, p_office_file_id, p_sha256, p_format, p_width, p_height, p_bytes, left(coalesce(p_original_name, ''), 200), p_actor)
    returning * into m;
  exception when unique_violation then
    -- a concurrent upload of the same bytes won
    select * into m from catalogue_media where product_id = p_product_id and sha256 = p_sha256 and status = 'active';
    if not found then raise; end if;
    return to_jsonb(m) || jsonb_build_object('deduplicated', true);
  end;
  for d in select * from jsonb_array_elements(p_derivatives) loop
    insert into catalogue_media_derivatives (media_id, kind, office_file_id, format, width, height, bytes, sha256)
    values (m.id, d->>'kind', d->>'office_file_id', 'webp', (d->>'width')::integer, (d->>'height')::integer, (d->>'bytes')::integer, d->>'sha256');
  end loop;
  return to_jsonb(m) || jsonb_build_object('deduplicated', false);
end $f$;

-- Removes an image that no version references (the guard trigger refuses it otherwise, inside the same statement).
create or replace function catalogue_remove_media(p_media_id uuid, p_actor text) returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare m catalogue_media%rowtype;
begin
  update catalogue_media set status = 'removed', removed_by = p_actor, removed_at = now() where id = p_media_id and status = 'active' returning * into m;
  if not found then
    if exists (select 1 from catalogue_media where id = p_media_id) then raise exception 'media_already_removed' using errcode = 'PT409'; end if;
    raise exception 'media_not_found' using errcode = 'PT404';
  end if;
  return to_jsonb(m);
end $f$;

-- ---------------------------------------------------------------- privileges
do $$
declare t text; f text;
begin
  foreach t in array array['catalogue_media', 'catalogue_media_derivatives'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on %I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on %I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on %I from service_role', t);
      execute format('grant select, insert, update, delete on %I to service_role', t);
    end if;
  end loop;
  foreach f in array array['catalogue_media_guard()', 'catalogue_version_media_check()', 'catalogue_media_schema_version()',
                           'catalogue_register_media(uuid, text, text, text, integer, integer, integer, text, jsonb, text)',
                           'catalogue_remove_media(uuid, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
