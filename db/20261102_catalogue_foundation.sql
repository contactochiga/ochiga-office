-- Office-managed product catalogue, foundation (Phase 1: stages C1 data model, C2 product management, C3 prices and inventory).
-- ADDITIVE and IDEMPOTENT: new tables, triggers and functions only; no existing table, row, grant or function is changed.
-- Nothing here is public: there is no public API, view or anon/authenticated privilege (public projection = stage C6, later).
--
-- Integrity model
--   * Product content is versioned in catalogue_product_versions, which is APPEND-ONLY: a trigger refuses UPDATE, DELETE and TRUNCATE for
--     every role. Review decisions, price-change requests and decisions, inventory changes, cost records and publication events are
--     append-only the same way. The only mutable catalogue rows are products, variants, categories and brands, and every state change of
--     a product or variant is ONE conditional statement (... where id = $1 and row_version = $n and <expected state>) inside the
--     functions below, so concurrent approve/publish/edit calls cannot both win (D12).
--   * Separation of duties is enforced here, inside the same statement that changes the state: a version can only be approved (and a
--     request can only be decided) by someone who is not an author of any version in the change set (D2) / not the requester (D3).
--   * Price-change decisions are exactly-once by unique partial indexes (one approve-or-reject, one publish per change).
--   * Money is integer kobo (bigint); never floating point.
--
-- Security (keeps the R11 production gate baseline PASS without exceptions)
--   * RLS enabled with NO policy on every table; nothing for PUBLIC/anon/authenticated (tables, sequences, functions).
--   * The application uses service_role (PostgREST), which bypasses RLS; it keeps SELECT/INSERT/UPDATE/DELETE on every table (gate B6) and
--     loses TRUNCATE on the append-only tables; the append-only triggers refuse UPDATE/DELETE regardless of privilege.
--   * Every function is SECURITY INVOKER (runs with the caller's own rights; no SECURITY DEFINER, gate B5) with a pinned search_path, and
--     EXECUTE is granted to service_role only.
--   * catalogue_variant_costs (supplier and landed cost) is referenced by no function.
-- Order: any time after db/lead-agents-schema.sql. Independent of the S7 chain and of 20261101.

-- ---------------------------------------------------------------- suppliers (CORPORATE_COLLECTIONS shape: text id supplied by the app)
create table if not exists office_suppliers (
  id text primary key check (length(id) between 1 and 120),
  business_unit text not null default 'technology',
  status text not null default 'active' check (status in ('active', 'inactive')),
  owner text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  name text not null check (length(name) between 1 and 200),
  contact_name text not null default '',
  email text not null default '',
  phone text not null default '',
  country text not null default '',
  payment_terms text not null default '',
  notes text not null default '' check (length(notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- taxonomy
create table if not exists catalogue_categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  name text not null check (length(name) between 1 and 120),
  parent_id uuid references catalogue_categories(id) on delete restrict,
  sort integer not null default 0,
  status text not null default 'active' check (status in ('active', 'hidden')),
  row_version integer not null default 1 check (row_version >= 1),
  created_by text not null default '',
  updated_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists catalogue_brands (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  name text not null check (length(name) between 1 and 120),
  sort integer not null default 0,
  status text not null default 'active' check (status in ('active', 'hidden')),
  row_version integer not null default 1 check (row_version >= 1),
  created_by text not null default '',
  updated_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- products and immutable versions
-- workflow_status: the review state of the CURRENT (latest) version. publication_status: what the (future) public projection would serve.
create table if not exists catalogue_products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  category_id uuid not null references catalogue_categories(id) on delete restrict,
  brand_id uuid references catalogue_brands(id) on delete restrict,
  workflow_status text not null default 'draft' check (workflow_status in ('draft', 'in_review', 'changes_requested', 'approved')),
  publication_status text not null default 'never_published' check (publication_status in ('never_published', 'published', 'unpublished', 'archived')),
  row_version integer not null default 1 check (row_version >= 1),
  current_version integer not null default 1 check (current_version >= 1),
  review_version integer,
  approved_version integer,
  published_version integer,
  published_at timestamptz,
  first_published_at timestamptz,
  archived_at timestamptz,
  last_publish_error text check (last_publish_error is null or length(last_publish_error) <= 500),
  created_by text not null default '',
  updated_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (review_version is null or review_version <= current_version),
  check (approved_version is null or approved_version <= current_version),
  check (published_version is null or published_version <= current_version)
);
create index if not exists catalogue_products_status_idx on catalogue_products (workflow_status, publication_status, updated_at desc);

create table if not exists catalogue_product_versions (
  product_id uuid not null references catalogue_products(id) on delete restrict,
  version integer not null check (version >= 1),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  -- initial = saved before the first publication; material = every change after it (no minor/typo exception: release review 2026-10-25)
  materiality text not null check (materiality in ('initial', 'material')),
  author text not null check (length(author) between 1 and 320),
  created_at timestamptz not null default now(),
  primary key (product_id, version)
);

create table if not exists catalogue_reviews (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references catalogue_products(id) on delete restrict,
  version integer not null,
  decision text not null check (decision in ('submitted', 'approved', 'changes_requested', 'override')),
  actor text not null check (length(actor) between 1 and 320),
  note text not null default '' check (length(note) <= 2000),
  created_at timestamptz not null default now(),
  foreign key (product_id, version) references catalogue_product_versions(product_id, version) on delete restrict
);
create index if not exists catalogue_reviews_product_idx on catalogue_reviews (product_id, created_at);

create table if not exists catalogue_publication_events (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references catalogue_products(id) on delete restrict,
  version integer,
  action text not null check (action in ('published', 'published_override', 'unpublished', 'archived')),
  actor text not null check (length(actor) between 1 and 320),
  override boolean not null default false,
  override_reason text not null default '' check (length(override_reason) <= 2000),
  refresh_outcome text not null default 'not_applicable',
  error text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists catalogue_publication_events_product_idx on catalogue_publication_events (product_id, created_at);

-- ---------------------------------------------------------------- variants (operational authority for SKU, price and inventory)
create table if not exists catalogue_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references catalogue_products(id) on delete restrict,
  sku text not null unique check (sku ~ '^[A-Z0-9][A-Z0-9._-]{1,63}$'),
  status text not null default 'active' check (status in ('active', 'inactive')),
  -- the PUBLISHED selling price, VAT-inclusive (D7); null until a price change is approved and published
  price_ngn_kobo bigint check (price_ngn_kobo is null or price_ngn_kobo >= 0),
  vat_treatment text check (vat_treatment is null or vat_treatment in ('standard', 'exempt', 'zero_rated')),
  vat_rate_bp integer check (vat_rate_bp is null or vat_rate_bp between 0 and 10000),
  stock_on_hand integer not null default 0 check (stock_on_hand >= 0),
  stock_reserved integer not null default 0 check (stock_reserved >= 0),
  sourcing text not null default 'supplier_sourced' check (sourcing in ('in_stock', 'supplier_sourced', 'made_to_order', 'discontinued')),
  lead_time_days_min integer check (lead_time_days_min is null or lead_time_days_min >= 0),
  lead_time_days_max integer check (lead_time_days_max is null or lead_time_days_max >= 0),
  supplier_id text references office_suppliers(id) on delete restrict,
  row_version integer not null default 1 check (row_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (stock_reserved <= stock_on_hand),
  check (lead_time_days_min is null or lead_time_days_max is null or lead_time_days_min <= lead_time_days_max),
  check ((price_ngn_kobo is null) = (vat_treatment is null) and (vat_treatment is null) = (vat_rate_bp is null)),
  check (vat_treatment is null or (vat_treatment = 'standard') = (vat_rate_bp > 0))
);
create index if not exists catalogue_variants_product_idx on catalogue_variants (product_id);

create table if not exists catalogue_price_changes (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references catalogue_variants(id) on delete restrict,
  old_price_ngn_kobo bigint,
  old_vat_treatment text,
  old_vat_rate_bp integer,
  new_price_ngn_kobo bigint not null check (new_price_ngn_kobo >= 0),
  new_vat_treatment text not null check (new_vat_treatment in ('standard', 'exempt', 'zero_rated')),
  new_vat_rate_bp integer not null check (new_vat_rate_bp between 0 and 10000),
  requested_by text not null check (length(requested_by) between 1 and 320),
  note text not null default '' check (length(note) <= 2000),
  requested_at timestamptz not null default now(),
  check ((new_vat_treatment = 'standard') = (new_vat_rate_bp > 0))
);
create index if not exists catalogue_price_changes_variant_idx on catalogue_price_changes (variant_id, requested_at);

create table if not exists catalogue_price_decisions (
  id uuid primary key default gen_random_uuid(),
  price_change_id uuid not null references catalogue_price_changes(id) on delete restrict,
  decision text not null check (decision in ('approved', 'rejected', 'published')),
  actor text not null check (length(actor) between 1 and 320),
  note text not null default '' check (length(note) <= 2000),
  created_at timestamptz not null default now()
);
-- exactly one approve-or-reject and at most one publication per change
create unique index if not exists catalogue_price_decisions_decided_uq on catalogue_price_decisions (price_change_id) where decision in ('approved', 'rejected');
create unique index if not exists catalogue_price_decisions_published_uq on catalogue_price_decisions (price_change_id) where decision = 'published';

create table if not exists catalogue_inventory_changes (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references catalogue_variants(id) on delete restrict,
  field text not null check (field in ('stock_on_hand', 'stock_reserved', 'sourcing', 'lead_time_days_min', 'lead_time_days_max', 'status', 'supplier_id')),
  old_value text,
  new_value text,
  actor text not null check (length(actor) between 1 and 320),
  reason text not null default '' check (length(reason) <= 1000),
  created_at timestamptz not null default now()
);
create index if not exists catalogue_inventory_changes_variant_idx on catalogue_inventory_changes (variant_id, created_at);

-- internal only (catalogue.cost.read): never referenced by any function or view
create table if not exists catalogue_variant_costs (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references catalogue_variants(id) on delete restrict,
  supplier_id text references office_suppliers(id) on delete restrict,
  currency text not null default 'NGN' check (currency = 'NGN'),
  supplier_cost_kobo bigint not null check (supplier_cost_kobo >= 0),
  landed_cost_kobo bigint not null check (landed_cost_kobo >= supplier_cost_kobo),
  valid_from timestamptz not null default now(),
  recorded_by text not null check (length(recorded_by) between 1 and 320),
  note text not null default '' check (length(note) <= 1000),
  created_at timestamptz not null default now()
);
create index if not exists catalogue_variant_costs_variant_idx on catalogue_variant_costs (variant_id, valid_from desc);

-- ---------------------------------------------------------------- append-only enforcement (every role, including service_role and the owner)
create or replace function catalogue_refuse_change() returns trigger language plpgsql set search_path = public, pg_temp as $f$
begin
  raise exception 'append_only: % on % is not allowed', tg_op, tg_table_name using errcode = '42501';
end $f$;

do $$
declare t text;
begin
  foreach t in array array['catalogue_product_versions', 'catalogue_reviews', 'catalogue_publication_events', 'catalogue_price_changes',
                           'catalogue_price_decisions', 'catalogue_inventory_changes', 'catalogue_variant_costs'] loop
    if not exists (select 1 from pg_trigger where tgname = t || '_append_only' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger %I before update or delete on %I for each row execute function catalogue_refuse_change()', t || '_append_only', t);
    end if;
    if not exists (select 1 from pg_trigger where tgname = t || '_no_truncate' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger %I before truncate on %I for each statement execute function catalogue_refuse_change()', t || '_no_truncate', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- seed (D9): the six initial categories, editable in Office afterwards
insert into catalogue_categories (slug, name, sort, created_by, updated_by) values
  ('smart-home-automation', 'Smart Home & Automation', 10, 'migration', 'migration'),
  ('security-access-control', 'Security & Access Control', 20, 'migration', 'migration'),
  ('networking-connectivity', 'Networking & Connectivity', 30, 'migration', 'migration'),
  ('sensors-monitoring', 'Sensors & Monitoring', 40, 'migration', 'migration'),
  ('control-panels-gateways', 'Control Panels & Gateways', 50, 'migration', 'migration'),
  ('installation-accessories', 'Installation Accessories', 60, 'migration', 'migration')
on conflict (slug) do nothing;

-- ---------------------------------------------------------------- functions (SECURITY INVOKER; called by service_role through PostgREST /rpc)
create or replace function catalogue_schema_version() returns integer language sql stable set search_path = public, pg_temp as $f$ select 1 $f$;

-- raises 'state_changed' (HTTP 409 through PostgREST: SQLSTATE PT409) with the product's current state in DETAIL
create or replace function catalogue_state_changed(p_product_id uuid) returns void language plpgsql set search_path = public, pg_temp as $f$
declare cur jsonb;
begin
  select jsonb_build_object('id', id, 'row_version', row_version, 'workflow_status', workflow_status, 'publication_status', publication_status,
                            'current_version', current_version, 'published_version', published_version)
    into cur from catalogue_products where id = p_product_id;
  if cur is null then raise exception 'product_not_found' using errcode = 'PT404'; end if;
  raise exception 'state_changed' using errcode = 'PT409', detail = cur::text;
end $f$;

-- inserts the SKUs of a version that do not exist yet; a SKU already used by ANOTHER product is refused
create or replace function catalogue_register_variants(p_product_id uuid, p_variants jsonb) returns void language plpgsql set search_path = public, pg_temp as $f$
declare v jsonb; owner_id uuid;
begin
  for v in select * from jsonb_array_elements(coalesce(p_variants, '[]'::jsonb)) loop
    select product_id into owner_id from catalogue_variants where sku = v->>'sku';
    if owner_id is null then
      insert into catalogue_variants (product_id, sku) values (p_product_id, v->>'sku');
    elsif owner_id <> p_product_id then
      raise exception 'sku_taken' using errcode = 'PT409', detail = jsonb_build_object('sku', v->>'sku')::text;
    end if;
  end loop;
end $f$;

create or replace function catalogue_create_product(p_slug text, p_category_id uuid, p_brand_id uuid, p_content jsonb, p_actor text)
returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare p catalogue_products%rowtype;
begin
  insert into catalogue_products (slug, category_id, brand_id, created_by, updated_by) values (p_slug, p_category_id, p_brand_id, p_actor, p_actor)
  returning * into p;
  insert into catalogue_product_versions (product_id, version, content, materiality, author) values (p.id, 1, p_content, 'initial', p_actor);
  perform catalogue_register_variants(p.id, p_content->'variants');
  return to_jsonb(p);
exception when unique_violation then
  if exists (select 1 from catalogue_products where slug = p_slug) then raise exception 'slug_taken' using errcode = 'PT409'; end if;
  raise;
end $f$;

-- one edit = one new immutable version; supersedes any pending review/approval of earlier versions (workflow back to draft)
create or replace function catalogue_save_version(p_product_id uuid, p_expected_row_version integer, p_slug text, p_category_id uuid, p_brand_id uuid,
                                                  p_content jsonb, p_materiality text, p_actor text)
returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare p catalogue_products%rowtype;
begin
  -- no minor/typo exception: "initial" only before the first publication, "material" after it (every change is reviewed)
  if p_materiality not in ('initial', 'material') then raise exception 'invalid_materiality' using errcode = '22023'; end if;
  if p_materiality = 'initial' and exists (select 1 from catalogue_products where id = p_product_id and published_version is not null) then
    raise exception 'initial_not_allowed' using errcode = 'PT409';
  end if;
  if p_materiality = 'material' and exists (select 1 from catalogue_products where id = p_product_id and published_version is null) then
    raise exception 'material_not_allowed' using errcode = 'PT409';
  end if;
  update catalogue_products
     set row_version = row_version + 1, current_version = current_version + 1, workflow_status = 'draft', review_version = null, approved_version = null,
         slug = p_slug, category_id = p_category_id, brand_id = p_brand_id, updated_by = p_actor, updated_at = now()
   where id = p_product_id and row_version = p_expected_row_version and publication_status <> 'archived'
     and (slug = p_slug or first_published_at is null)
  returning * into p;
  if not found then
    if exists (select 1 from catalogue_products where id = p_product_id and row_version = p_expected_row_version and publication_status <> 'archived' and slug <> p_slug) then
      raise exception 'slug_locked' using errcode = 'PT409';
    end if;
    perform catalogue_state_changed(p_product_id);
  end if;
  insert into catalogue_product_versions (product_id, version, content, materiality, author) values (p.id, p.current_version, p_content, p_materiality, p_actor);
  perform catalogue_register_variants(p.id, p_content->'variants');
  return to_jsonb(p);
exception when unique_violation then
  if exists (select 1 from catalogue_products where slug = p_slug and id <> p_product_id) then raise exception 'slug_taken' using errcode = 'PT409'; end if;
  raise;
end $f$;

-- submit | approve | request_changes | publish | unpublish | archive, each ONE conditional update on the expected row_version.
-- publish takes the normal path (approved current version) or, only when p_override_reason is given (the caller has checked
-- catalogue.override and the super_admin role), the audited override path. There is no minor/typo path.
create or replace function catalogue_transition(p_product_id uuid, p_expected_row_version integer, p_action text, p_actor text, p_note text, p_override_reason text)
returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare p catalogue_products%rowtype; path text; reason text := coalesce(p_override_reason, '');
begin
  if p_action = 'submit' then
    update catalogue_products set workflow_status = 'in_review', review_version = current_version, row_version = row_version + 1, updated_by = p_actor, updated_at = now()
     where id = p_product_id and row_version = p_expected_row_version and workflow_status in ('draft', 'changes_requested') and publication_status <> 'archived'
    returning * into p;
    if not found then perform catalogue_state_changed(p_product_id); end if;
    insert into catalogue_reviews (product_id, version, decision, actor, note) values (p.id, p.review_version, 'submitted', p_actor, coalesce(p_note, ''));

  elsif p_action in ('approve', 'request_changes') then
    -- second person (D2): the reviewer is not an author of any version in the change set (after the published version, up to the reviewed one)
    if exists (select 1 from catalogue_products c join catalogue_product_versions v on v.product_id = c.id
                where c.id = p_product_id and c.row_version = p_expected_row_version and c.workflow_status = 'in_review'
                  and v.version > coalesce(c.published_version, 0) and v.version <= c.review_version and v.author = p_actor) then
      raise exception 'own_change' using errcode = 'PT403';
    end if;
    update catalogue_products
       set workflow_status = case when p_action = 'approve' then 'approved' else 'changes_requested' end,
           approved_version = case when p_action = 'approve' then review_version else null end,
           row_version = row_version + 1, updated_by = p_actor, updated_at = now()
     where id = p_product_id and row_version = p_expected_row_version and workflow_status = 'in_review' and review_version = current_version
       and not exists (select 1 from catalogue_product_versions v where v.product_id = catalogue_products.id and v.version > coalesce(catalogue_products.published_version, 0)
                         and v.version <= catalogue_products.review_version and v.author = p_actor)
    returning * into p;
    if not found then perform catalogue_state_changed(p_product_id); end if;
    insert into catalogue_reviews (product_id, version, decision, actor, note)
    values (p.id, p.review_version, case when p_action = 'approve' then 'approved' else 'changes_requested' end, p_actor, coalesce(p_note, ''));

  elsif p_action = 'publish' then
    if length(reason) > 0 and length(reason) < 20 then raise exception 'override_reason_too_short' using errcode = 'PT400'; end if;
    update catalogue_products c
       set publication_status = 'published', published_version = current_version, published_at = now(), first_published_at = coalesce(first_published_at, now()),
           workflow_status = 'approved', approved_version = current_version, review_version = null, last_publish_error = null,
           row_version = row_version + 1, updated_by = p_actor, updated_at = now()
     where id = p_product_id and row_version = p_expected_row_version and publication_status <> 'archived'
       and (   (workflow_status = 'approved' and approved_version = current_version and (published_version is distinct from current_version or publication_status <> 'published'))
            or (length(reason) >= 20 and (published_version is distinct from current_version or publication_status <> 'published')))
    returning * into p;
    if not found then
      if exists (select 1 from catalogue_products where id = p_product_id and row_version = p_expected_row_version and publication_status <> 'archived') then
        raise exception 'review_required' using errcode = 'PT409';
      end if;
      perform catalogue_state_changed(p_product_id);
    end if;
    -- which path was taken: an approval of this exact version, otherwise the audited override
    path := case
      when exists (select 1 from catalogue_reviews r where r.product_id = p.id and r.version = p.current_version and r.decision = 'approved') then 'published'
      else 'published_override' end;
    if path = 'published_override' then
      insert into catalogue_reviews (product_id, version, decision, actor, note) values (p.id, p.current_version, 'override', p_actor, reason);
    end if;
    insert into catalogue_publication_events (product_id, version, action, actor, override, override_reason)
    values (p.id, p.current_version, path, p_actor, path = 'published_override', case when path = 'published_override' then reason else '' end);

  elsif p_action = 'unpublish' then
    update catalogue_products set publication_status = 'unpublished', row_version = row_version + 1, updated_by = p_actor, updated_at = now()
     where id = p_product_id and row_version = p_expected_row_version and publication_status = 'published'
    returning * into p;
    if not found then perform catalogue_state_changed(p_product_id); end if;
    insert into catalogue_publication_events (product_id, version, action, actor) values (p.id, p.published_version, 'unpublished', p_actor);

  elsif p_action = 'archive' then
    update catalogue_products set publication_status = 'archived', archived_at = now(), row_version = row_version + 1, updated_by = p_actor, updated_at = now()
     where id = p_product_id and row_version = p_expected_row_version and publication_status <> 'archived'
    returning * into p;
    if not found then perform catalogue_state_changed(p_product_id); end if;
    insert into catalogue_publication_events (product_id, version, action, actor) values (p.id, p.published_version, 'archived', p_actor);

  else
    raise exception 'invalid_action' using errcode = 'PT400';
  end if;
  return to_jsonb(p);
end $f$;

-- prices (D3): request -> decision by a different approver (exactly once) -> publication (exactly once; refused if the price moved meanwhile)
create or replace function catalogue_request_price_change(p_variant_id uuid, p_new_price bigint, p_vat_treatment text, p_vat_rate_bp integer, p_actor text, p_note text)
returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare v catalogue_variants%rowtype; c catalogue_price_changes%rowtype;
begin
  select * into v from catalogue_variants where id = p_variant_id;
  if not found then raise exception 'variant_not_found' using errcode = 'PT404'; end if;
  insert into catalogue_price_changes (variant_id, old_price_ngn_kobo, old_vat_treatment, old_vat_rate_bp, new_price_ngn_kobo, new_vat_treatment, new_vat_rate_bp, requested_by, note)
  values (v.id, v.price_ngn_kobo, v.vat_treatment, v.vat_rate_bp, p_new_price, p_vat_treatment, p_vat_rate_bp, p_actor, coalesce(p_note, ''))
  returning * into c;
  return to_jsonb(c);
end $f$;

create or replace function catalogue_decide_price_change(p_change_id uuid, p_decision text, p_actor text, p_note text)
returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare c catalogue_price_changes%rowtype; d catalogue_price_decisions%rowtype;
begin
  if p_decision not in ('approved', 'rejected') then raise exception 'invalid_decision' using errcode = 'PT400'; end if;
  select * into c from catalogue_price_changes where id = p_change_id;
  if not found then raise exception 'price_change_not_found' using errcode = 'PT404'; end if;
  if c.requested_by = p_actor then raise exception 'own_request' using errcode = 'PT403'; end if;
  begin
    insert into catalogue_price_decisions (price_change_id, decision, actor, note) values (c.id, p_decision, p_actor, coalesce(p_note, '')) returning * into d;
  exception when unique_violation then
    raise exception 'already_decided' using errcode = 'PT409';
  end;
  return to_jsonb(d);
end $f$;

create or replace function catalogue_publish_price_change(p_change_id uuid, p_actor text)
returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare c catalogue_price_changes%rowtype; v catalogue_variants%rowtype;
begin
  select * into c from catalogue_price_changes where id = p_change_id;
  if not found then raise exception 'price_change_not_found' using errcode = 'PT404'; end if;
  if not exists (select 1 from catalogue_price_decisions where price_change_id = c.id and decision = 'approved') then
    raise exception 'not_approved' using errcode = 'PT409';
  end if;
  begin
    insert into catalogue_price_decisions (price_change_id, decision, actor) values (c.id, 'published', p_actor);
  exception when unique_violation then
    raise exception 'already_published' using errcode = 'PT409';
  end;
  -- conditional on the price the request was made against: a price published meanwhile makes this request stale
  update catalogue_variants
     set price_ngn_kobo = c.new_price_ngn_kobo, vat_treatment = c.new_vat_treatment, vat_rate_bp = c.new_vat_rate_bp, row_version = row_version + 1, updated_at = now()
   where id = c.variant_id
     and price_ngn_kobo is not distinct from c.old_price_ngn_kobo and vat_treatment is not distinct from c.old_vat_treatment and vat_rate_bp is not distinct from c.old_vat_rate_bp
  returning * into v;
  if not found then raise exception 'price_changed_since_request' using errcode = 'PT409'; end if;
  return to_jsonb(v);
end $f$;

-- inventory (D4): conditional on row_version; one inventory_changes row per changed field
create or replace function catalogue_update_inventory(p_variant_id uuid, p_expected_row_version integer, p_patch jsonb, p_actor text, p_reason text)
returns jsonb language plpgsql set search_path = public, pg_temp as $f$
declare o catalogue_variants%rowtype; v catalogue_variants%rowtype; f text;
begin
  select * into o from catalogue_variants where id = p_variant_id and row_version = p_expected_row_version for update;
  if not found then
    if not exists (select 1 from catalogue_variants where id = p_variant_id) then raise exception 'variant_not_found' using errcode = 'PT404'; end if;
    raise exception 'state_changed' using errcode = 'PT409', detail = (select jsonb_build_object('id', id, 'row_version', row_version) from catalogue_variants where id = p_variant_id)::text;
  end if;
  update catalogue_variants set
    stock_on_hand = case when p_patch ? 'stock_on_hand' then (p_patch->>'stock_on_hand')::integer else stock_on_hand end,
    stock_reserved = case when p_patch ? 'stock_reserved' then (p_patch->>'stock_reserved')::integer else stock_reserved end,
    sourcing = case when p_patch ? 'sourcing' then p_patch->>'sourcing' else sourcing end,
    lead_time_days_min = case when p_patch ? 'lead_time_days_min' then (p_patch->>'lead_time_days_min')::integer else lead_time_days_min end,
    lead_time_days_max = case when p_patch ? 'lead_time_days_max' then (p_patch->>'lead_time_days_max')::integer else lead_time_days_max end,
    status = case when p_patch ? 'status' then p_patch->>'status' else status end,
    supplier_id = case when p_patch ? 'supplier_id' then nullif(p_patch->>'supplier_id', '') else supplier_id end,
    row_version = row_version + 1, updated_at = now()
  where id = p_variant_id and row_version = p_expected_row_version
  returning * into v;
  foreach f in array array['stock_on_hand', 'stock_reserved', 'sourcing', 'lead_time_days_min', 'lead_time_days_max', 'status', 'supplier_id'] loop
    if (to_jsonb(o)->>f) is distinct from (to_jsonb(v)->>f) then
      insert into catalogue_inventory_changes (variant_id, field, old_value, new_value, actor, reason) values (v.id, f, to_jsonb(o)->>f, to_jsonb(v)->>f, p_actor, coalesce(p_reason, ''));
    end if;
  end loop;
  return to_jsonb(v);
end $f$;

-- ---------------------------------------------------------------- privileges
do $$
declare t text; f text;
begin
  foreach t in array array['office_suppliers', 'catalogue_categories', 'catalogue_brands', 'catalogue_products', 'catalogue_product_versions', 'catalogue_reviews',
                           'catalogue_publication_events', 'catalogue_variants', 'catalogue_price_changes', 'catalogue_price_decisions',
                           'catalogue_inventory_changes', 'catalogue_variant_costs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on %I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on %I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on %I from service_role', t);
      execute format('grant select, insert, update, delete on %I to service_role', t);
    end if;
  end loop;
  foreach f in array array['catalogue_refuse_change()', 'catalogue_schema_version()', 'catalogue_state_changed(uuid)', 'catalogue_register_variants(uuid, jsonb)',
                           'catalogue_create_product(text, uuid, uuid, jsonb, text)',
                           'catalogue_save_version(uuid, integer, text, uuid, uuid, jsonb, text, text)',
                           'catalogue_transition(uuid, integer, text, text, text, text)',
                           'catalogue_request_price_change(uuid, bigint, text, integer, text, text)',
                           'catalogue_decide_price_change(uuid, text, text, text)', 'catalogue_publish_price_change(uuid, text)',
                           'catalogue_update_inventory(uuid, integer, jsonb, text, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
