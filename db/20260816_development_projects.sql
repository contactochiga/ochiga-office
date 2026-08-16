-- Development Management (Ecosystem Standardization Programme 11).
-- Narrow scope deliberately: only the status/progress/core-metadata
-- fields that actually change as construction progresses, not the
-- hand-authored multi-chapter tour narrative on the public website,
-- which stays in code. Published to Sanity's new developmentProject
-- schema (Ochiga-website repo) using the same adapter pattern already
-- built for Content/Publishing.
create table if not exists office_development_projects (
  id text primary key,
  name text not null,
  slug text not null unique,
  type_line text,
  location text,
  status text,
  one_liner text,
  status_stages text[] not null default '{}'::text[],
  status_active_index integer not null default 0,
  sanity_document_id text,
  published boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists office_development_projects_slug_idx
on office_development_projects (slug);
