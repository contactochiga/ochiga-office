-- Content / Publishing (Phase 8, Office v2). Sanity remains the
-- canonical public content source of truth — this table holds ONLY
-- Office's local editorial workflow/audit metadata.
create table if not exists office_content_items (
  id text primary key,
  title text not null,
  slug text,
  excerpt text,
  category text,
  author text,
  tags text[] not null default '{}'::text[],
  body text not null default '',
  featured_image_url text,
  seo_title text,
  seo_description text,
  workflow_status text not null default 'draft',
  scheduled_publish_at timestamptz,
  sanity_document_id text,
  sanity_live_url text,
  created_by text not null,
  reviewed_by text,
  approved_by text,
  published_by text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists office_content_items_status_idx
on office_content_items (workflow_status, updated_at desc);

create index if not exists office_content_items_scheduled_idx
on office_content_items (scheduled_publish_at) where scheduled_publish_at is not null;
