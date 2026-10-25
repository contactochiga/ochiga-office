-- Catalogue follow-up (Phase 2 stage 4): Office-controlled public release to the GetOyi Hardware catalogue, slug redirects, refresh status,
-- and signed product previews. ADDITIVE and IDEMPOTENT: new tables, triggers and functions; no existing table, row, grant or function is
-- changed (one new trigger on catalogue_products refuses a slug that is a redirect of another product). Requires 20261102 and 20261104.
--
-- Model
--   * Internal publication (catalogue_products.publication_status, Phase 1) is NOT public availability. A product is public only while
--     BOTH hold: its catalogue_public_listings row says 'public' AND the product is still internally 'published'. Internal unpublish or
--     archive therefore removes it from the public projection at once, without any further step.
--   * A release pins public_version = the product's internally published version at that moment; GetOyi shows exactly that approved
--     version until it is released again ("Update GetOyi") or withdrawn.
--   * catalogue_public_release refuses unless catalogue_public_requirements() is empty: internally published, the published version was
--     APPROVED by a second person (an override publication cannot go public), a gallery with exactly one cover, alt text on every image,
--     every image active with all four renditions, at least one active variant, and an approved (published) price on every active
--     variant of that version. Each release / withdrawal / slug change is one conditional statement on row_version (409 otherwise).
--   * catalogue_public_events and catalogue_slug_redirects are append-only; listings cannot be deleted.
--   * Refresh: every public change bumps refresh_seq; Office then asks GetOyi to revalidate and records the outcome against that exact
--     sequence number (a late answer to an older request never overwrites a newer state).
--   * catalogue_preview_grants: one row per signed preview link (product, version, staff, expiry <= 30 min). Only revocation can change
--     a grant; rows are never deleted.
-- Security: same shape as 20261102/20261104 (RLS on, no policy, nothing for PUBLIC/anon/authenticated, SECURITY INVOKER functions with
-- pinned search_path, EXECUTE service_role only, history without TRUNCATE; no function reads catalogue_variant_costs).
do $$ begin
  if to_regprocedure('public.catalogue_refuse_change()') is null then raise exception 'apply 20261102_catalogue_foundation.sql first'; end if;
  if to_regprocedure('public.catalogue_media_guard()') is null then raise exception 'apply 20261104_catalogue_media.sql first'; end if;
end $$;

create table if not exists catalogue_public_listings (
  product_id uuid primary key references catalogue_products(id) on delete restrict,
  status text not null check (status in ('public', 'withdrawn')),
  public_version integer not null check (public_version >= 1),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  row_version integer not null default 1 check (row_version >= 1),
  released_at timestamptz not null,
  released_by text not null check (length(released_by) between 1 and 320),
  withdrawn_at timestamptz,
  withdrawn_by text,
  withdrawn_reason text not null default '' check (length(withdrawn_reason) <= 500),
  refresh_seq integer not null default 1 check (refresh_seq >= 1),
  refresh_status text not null default 'pending' check (refresh_status in ('pending', 'succeeded', 'failed', 'not_configured')),
  refresh_attempts integer not null default 0 check (refresh_attempts >= 0),
  refresh_requested_at timestamptz not null default now(),
  refresh_completed_at timestamptz,
  refresh_error text not null default '' check (length(refresh_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'withdrawn') = (withdrawn_at is not null and withdrawn_by is not null))
);
create index if not exists catalogue_public_listings_status_idx on catalogue_public_listings (status);

create table if not exists catalogue_public_events (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references catalogue_products(id) on delete restrict,
  action text not null check (action in ('released', 'updated', 'withdrawn', 'slug_changed')),
  version integer,
  slug text not null,
  actor text not null check (length(actor) between 1 and 320),
  note text not null default '' check (length(note) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists catalogue_public_events_product_idx on catalogue_public_events (product_id, created_at);

create table if not exists catalogue_slug_redirects (
  old_slug text primary key check (old_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(old_slug) <= 80),
  product_id uuid not null references catalogue_products(id) on delete restrict,
  created_by text not null check (length(created_by) between 1 and 320),
  created_at timestamptz not null default now()
);

create table if not exists catalogue_preview_grants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references catalogue_products(id) on delete restrict,
  version integer not null check (version >= 1),
  staff text not null check (length(staff) between 1 and 320),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by text,
  check (expires_at > created_at and expires_at <= created_at + interval '30 minutes'),
  check ((revoked_at is null) = (revoked_by is null))
);
create index if not exists catalogue_preview_grants_product_idx on catalogue_preview_grants (product_id, expires_at);

-- public images are addressed by the rendition's content hash (no internal id leaves Office)
create index if not exists catalogue_media_derivatives_sha256_idx on catalogue_media_derivatives (sha256);

-- ---------------------------------------------------------------- integrity triggers
create or replace function catalogue_public_listing_guard() returns trigger language plpgsql set search_path = public, pg_temp as $f$
begin
  raise exception 'append_only: % on % is not allowed', tg_op, tg_table_name using errcode = '42501';
end $f$;

create or replace function catalogue_preview_grant_guard() returns trigger language plpgsql set search_path = public, pg_temp as $f$
begin
  if tg_op <> 'UPDATE' or old.revoked_at is not null or new.revoked_at is null
     or (new.id, new.product_id, new.version, new.staff, new.created_at, new.expires_at)
        is distinct from (old.id, old.product_id, old.version, old.staff, old.created_at, old.expires_at) then
    raise exception 'append_only: only revocation is allowed on %', tg_table_name using errcode = '42501';
  end if;
  return new;
end $f$;

-- a slug that redirects to one product can never be taken by another (it would hijack the old public URL)
create or replace function catalogue_slug_redirect_check() returns trigger language plpgsql set search_path = public, pg_temp as $f$
begin
  if exists (select 1 from catalogue_slug_redirects r where r.old_slug = new.slug and r.product_id <> new.id) then
    raise exception 'slug_taken' using errcode = 'PT409';
  end if;
  return new;
end $f$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_public_listings_no_delete' and tgrelid = 'public.catalogue_public_listings'::regclass) then
    create trigger catalogue_public_listings_no_delete before delete on catalogue_public_listings for each row execute function catalogue_public_listing_guard();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_public_listings_no_truncate' and tgrelid = 'public.catalogue_public_listings'::regclass) then
    create trigger catalogue_public_listings_no_truncate before truncate on catalogue_public_listings for each statement execute function catalogue_refuse_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_public_events_append_only' and tgrelid = 'public.catalogue_public_events'::regclass) then
    create trigger catalogue_public_events_append_only before update or delete on catalogue_public_events for each row execute function catalogue_refuse_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_public_events_no_truncate' and tgrelid = 'public.catalogue_public_events'::regclass) then
    create trigger catalogue_public_events_no_truncate before truncate on catalogue_public_events for each statement execute function catalogue_refuse_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_slug_redirects_append_only' and tgrelid = 'public.catalogue_slug_redirects'::regclass) then
    create trigger catalogue_slug_redirects_append_only before update or delete on catalogue_slug_redirects for each row execute function catalogue_refuse_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_slug_redirects_no_truncate' and tgrelid = 'public.catalogue_slug_redirects'::regclass) then
    create trigger catalogue_slug_redirects_no_truncate before truncate on catalogue_slug_redirects for each statement execute function catalogue_refuse_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_preview_grants_guarded' and tgrelid = 'public.catalogue_preview_grants'::regclass) then
    create trigger catalogue_preview_grants_guarded before update or delete on catalogue_preview_grants for each row execute function catalogue_preview_grant_guard();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_preview_grants_no_truncate' and tgrelid = 'public.catalogue_preview_grants'::regclass) then
    create trigger catalogue_preview_grants_no_truncate before truncate on catalogue_preview_grants for each statement execute function catalogue_refuse_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'catalogue_products_slug_redirect_check' and tgrelid = 'public.catalogue_products'::regclass) then
    create trigger catalogue_products_slug_redirect_check before insert or update of slug on catalogue_products for each row execute function catalogue_slug_redirect_check();
  end if;
end $$;

-- ---------------------------------------------------------------- functions
create or replace function catalogue_public_schema_version() returns integer language sql stable set search_path = public, pg_temp as $f$ select 1 $f$;

-- What still prevents public release of the product's internally published version ([] = releasable).
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

create or replace function catalogue_public_release(p_product_id uuid, p_expected_product_row_version integer, p_expected_listing_row_version integer, p_actor text)
returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare p catalogue_products%rowtype; l catalogue_public_listings%rowtype; issues jsonb; action text;
begin
  -- held until commit: a concurrent edit / unpublish / archive waits for this release (and is then judged on its own row_version)
  select * into p from catalogue_products where id = p_product_id for share;
  if not found then raise exception 'product_not_found' using errcode = 'PT404'; end if;
  if p.row_version <> p_expected_product_row_version then perform catalogue_state_changed(p_product_id); end if;
  issues := catalogue_public_requirements(p_product_id);
  if jsonb_array_length(issues) > 0 then raise exception 'public_requirements_not_met' using errcode = 'PT409', detail = jsonb_build_object('issues', issues)::text; end if;
  select * into l from catalogue_public_listings where product_id = p_product_id for update;
  if not found then
    if coalesce(p_expected_listing_row_version, 0) <> 0 then raise exception 'public_state_changed' using errcode = 'PT409', detail = '{"row_version":0}'; end if;
    insert into catalogue_public_listings (product_id, status, public_version, slug, released_at, released_by)
    values (p.id, 'public', p.published_version, p.slug, now(), p_actor) returning * into l;
    action := 'released';
  else
    if l.row_version <> p_expected_listing_row_version then
      raise exception 'public_state_changed' using errcode = 'PT409', detail = jsonb_build_object('row_version', l.row_version, 'status', l.status, 'public_version', l.public_version)::text;
    end if;
    if l.status = 'public' and l.public_version = p.published_version and l.slug = p.slug then raise exception 'already_public' using errcode = 'PT409'; end if;
    action := case when l.status = 'public' then 'updated' else 'released' end;
    update catalogue_public_listings set status = 'public', public_version = p.published_version, slug = p.slug, row_version = row_version + 1,
           released_at = now(), released_by = p_actor, withdrawn_at = null, withdrawn_by = null, withdrawn_reason = '',
           refresh_seq = refresh_seq + 1, refresh_status = 'pending', refresh_attempts = 0, refresh_requested_at = now(), refresh_completed_at = null, refresh_error = '', updated_at = now()
     where product_id = p.id and row_version = p_expected_listing_row_version returning * into l;
  end if;
  insert into catalogue_public_events (product_id, action, version, slug, actor) values (p.id, action, p.published_version, p.slug, p_actor);
  return to_jsonb(l);
end $f$;

create or replace function catalogue_public_withdraw(p_product_id uuid, p_expected_listing_row_version integer, p_actor text, p_reason text)
returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare l catalogue_public_listings%rowtype;
begin
  update catalogue_public_listings set status = 'withdrawn', withdrawn_at = now(), withdrawn_by = p_actor, withdrawn_reason = left(coalesce(p_reason, ''), 500),
         row_version = row_version + 1, refresh_seq = refresh_seq + 1, refresh_status = 'pending', refresh_attempts = 0, refresh_requested_at = now(),
         refresh_completed_at = null, refresh_error = '', updated_at = now()
   where product_id = p_product_id and row_version = p_expected_listing_row_version and status = 'public' returning * into l;
  if not found then
    select * into l from catalogue_public_listings where product_id = p_product_id;
    if not found then raise exception 'not_public' using errcode = 'PT409'; end if;
    raise exception 'public_state_changed' using errcode = 'PT409', detail = jsonb_build_object('row_version', l.row_version, 'status', l.status, 'public_version', l.public_version)::text;
  end if;
  insert into catalogue_public_events (product_id, action, version, slug, actor, note) values (l.product_id, 'withdrawn', l.public_version, l.slug, p_actor, left(coalesce(p_reason, ''), 500));
  return to_jsonb(l);
end $f$;

-- Changes the slug of a product that has been published (the draft editor handles never-published slugs). The old slug becomes a
-- permanent redirect to this product; an existing public listing follows the new slug.
create or replace function catalogue_change_slug(p_product_id uuid, p_expected_row_version integer, p_new_slug text, p_actor text)
returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare p catalogue_products%rowtype; v_old text;
begin
  if p_new_slug is null or p_new_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_new_slug) > 80 then raise exception 'invalid_slug' using errcode = 'PT400'; end if;
  select * into p from catalogue_products where id = p_product_id;
  if not found then raise exception 'product_not_found' using errcode = 'PT404'; end if;
  if p.first_published_at is null then raise exception 'slug_change_not_needed' using errcode = 'PT400'; end if;
  if p.publication_status = 'archived' then raise exception 'product_archived' using errcode = 'PT409'; end if;
  if p.slug = p_new_slug then raise exception 'slug_unchanged' using errcode = 'PT400'; end if;
  if exists (select 1 from catalogue_products where slug = p_new_slug and id <> p_product_id) then raise exception 'slug_taken' using errcode = 'PT409'; end if;
  v_old := p.slug;
  update catalogue_products set slug = p_new_slug, row_version = row_version + 1, updated_by = p_actor, updated_at = now()
   where id = p_product_id and row_version = p_expected_row_version returning * into p;
  if not found then perform catalogue_state_changed(p_product_id); end if;
  insert into catalogue_slug_redirects (old_slug, product_id, created_by) values (v_old, p_product_id, p_actor) on conflict (old_slug) do nothing;
  update catalogue_public_listings set slug = p_new_slug, refresh_seq = refresh_seq + 1, refresh_status = 'pending', refresh_attempts = 0,
         refresh_requested_at = now(), refresh_completed_at = null, refresh_error = '', updated_at = now()
   where product_id = p_product_id;
  insert into catalogue_public_events (product_id, action, version, slug, actor, note) values (p_product_id, 'slug_changed', p.published_version, p_new_slug, p_actor, 'from ' || v_old);
  return to_jsonb(p);
end $f$;

-- Starts a new refresh round (retry); returns the sequence number the outcome must be recorded against.
create or replace function catalogue_public_request_refresh(p_product_id uuid) returns integer language plpgsql set search_path = public, pg_temp as $f$
declare seq integer;
begin
  update catalogue_public_listings set refresh_seq = refresh_seq + 1, refresh_status = 'pending', refresh_requested_at = now(), refresh_completed_at = null, refresh_error = '', updated_at = now()
   where product_id = p_product_id returning refresh_seq into seq;
  if seq is null then raise exception 'not_public' using errcode = 'PT409'; end if;
  return seq;
end $f$;

-- Records a refresh outcome for one round; false when a newer round has started meanwhile (the stale answer is ignored).
create or replace function catalogue_public_record_refresh(p_product_id uuid, p_seq integer, p_outcome text, p_error text) returns boolean language plpgsql set search_path = public, pg_temp as $f$
begin
  if p_outcome not in ('succeeded', 'failed', 'not_configured') then raise exception 'invalid_outcome' using errcode = 'PT400'; end if;
  update catalogue_public_listings set refresh_status = p_outcome, refresh_attempts = refresh_attempts + 1, refresh_completed_at = now(), refresh_error = left(coalesce(p_error, ''), 500), updated_at = now()
   where product_id = p_product_id and refresh_seq = p_seq;
  return found;
end $f$;

create or replace function catalogue_create_preview_grant(p_product_id uuid, p_staff text, p_ttl_seconds integer) returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare p catalogue_products%rowtype; g catalogue_preview_grants%rowtype;
begin
  if p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 1800 then raise exception 'invalid_ttl' using errcode = 'PT400'; end if;
  select * into p from catalogue_products where id = p_product_id;
  if not found then raise exception 'product_not_found' using errcode = 'PT404'; end if;
  if p.publication_status = 'archived' then raise exception 'product_archived' using errcode = 'PT409'; end if;
  insert into catalogue_preview_grants (product_id, version, staff, expires_at) values (p.id, p.current_version, p_staff, now() + make_interval(secs => p_ttl_seconds)) returning * into g;
  return to_jsonb(g);
end $f$;

create or replace function catalogue_revoke_preview_grants(p_product_id uuid, p_actor text) returns integer language plpgsql set search_path = public, pg_temp as $f$
declare n integer;
begin
  update catalogue_preview_grants set revoked_at = now(), revoked_by = p_actor where product_id = p_product_id and revoked_at is null and expires_at > now();
  get diagnostics n = row_count;
  return n;
end $f$;

-- ---------------------------------------------------------------- privileges
do $$
declare t text; f text;
begin
  foreach t in array array['catalogue_public_listings', 'catalogue_public_events', 'catalogue_slug_redirects', 'catalogue_preview_grants'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on %I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on %I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on %I from service_role', t);
      execute format('grant select, insert, update, delete on %I to service_role', t);
    end if;
  end loop;
  foreach f in array array['catalogue_public_listing_guard()', 'catalogue_preview_grant_guard()', 'catalogue_slug_redirect_check()', 'catalogue_public_schema_version()',
                           'catalogue_public_requirements(uuid)', 'catalogue_public_release(uuid, integer, integer, text)',
                           'catalogue_public_withdraw(uuid, integer, text, text)', 'catalogue_change_slug(uuid, integer, text, text)',
                           'catalogue_public_request_refresh(uuid)', 'catalogue_public_record_refresh(uuid, integer, text, text)',
                           'catalogue_create_preview_grant(uuid, text, integer)', 'catalogue_revoke_preview_grants(uuid, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
