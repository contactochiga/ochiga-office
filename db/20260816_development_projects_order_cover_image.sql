-- Development Management (Programme 11) follow-up: adds the two
-- fields the Office-side editor was still missing — display order for
-- the public listing page, and a cover image, both synced onward to
-- Sanity's developmentProject schema (order, coverImage).
alter table office_development_projects
  add column if not exists display_order integer not null default 0,
  add column if not exists cover_image_url text,
  add column if not exists cover_image_alt text;
