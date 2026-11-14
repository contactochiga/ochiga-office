-- Content → Posts & Comments: Facebook Page and Instagram posts with their public comments.
-- Comments belong to the post they were left on. They are never CRM leads, never linked to DM identities and never
-- permission to send a DM. Ingestion only: no Graph calls, replies or moderation in this migration.
-- Applied after the Track B DM migrations (see db/migration-order.txt); the security baseline then re-applies and the
-- verification gate runs, so every table below ends with RLS on and service_role-only access.
begin;

create table if not exists public.office_social_posts (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('facebook', 'instagram')),
  asset_id text not null check (asset_id ~ '^[0-9]{1,32}$'),
  provider_post_id text not null check (char_length(provider_post_id) between 1 and 200),
  -- Set when Office published the post (a later publishing slice); null for posts made directly on Facebook/Instagram.
  content_item_id text references public.office_content_items(id) on delete set null,
  origin text not null default 'external' check (origin in ('external', 'office')),
  media_kind text,
  first_seen_at timestamptz not null default now(),
  last_comment_at timestamptz,
  unique (channel, asset_id, provider_post_id)
);
create index if not exists office_social_posts_recent_idx on public.office_social_posts (last_comment_at desc nulls last);
create index if not exists office_social_posts_content_item_idx on public.office_social_posts (content_item_id) where content_item_id is not null;

create table if not exists public.office_social_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.office_social_posts(id) on delete cascade,
  channel text not null check (channel in ('facebook', 'instagram')),
  asset_id text not null,
  provider_comment_id text not null check (char_length(provider_comment_id) between 1 and 200),
  provider_parent_id text,
  author_provider_id text,
  author_label text,
  author_is_page boolean not null default false,
  body text check (body is null or char_length(body) <= 8000),
  visibility text not null default 'visible' check (visibility in ('visible', 'hidden')),
  deleted_at timestamptz,
  edited_at timestamptz,
  provider_created_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_event_at timestamptz not null,
  unique (channel, asset_id, provider_comment_id)
);
create index if not exists office_social_comments_post_idx on public.office_social_comments (post_id, provider_created_at);

create table if not exists public.office_social_comment_events (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.office_social_comments(id) on delete cascade,
  event_key text not null unique check (event_key ~ '^meta-comment:event:[0-9a-f]{64}$'),
  verb text not null check (verb in ('add', 'edited', 'remove', 'hide', 'unhide')),
  provider_time timestamptz not null,
  received_at timestamptz not null default now(),
  applied boolean not null
);

alter table public.office_social_posts enable row level security;
alter table public.office_social_comments enable row level security;
alter table public.office_social_comment_events enable row level security;
revoke all on public.office_social_posts, public.office_social_comments, public.office_social_comment_events from public, anon, authenticated;
grant select, insert, update, delete on public.office_social_posts, public.office_social_comments, public.office_social_comment_events to service_role;

-- One atomic, idempotent write per webhook event. Returns 'accepted', 'duplicate' (same event key) or 'stale'
-- (recorded, but older than the comment's current state, so not applied). Deletion is final; author deletion redacts
-- the stored text.
create or replace function public.office_record_social_comment_event(
  p_channel text, p_asset text, p_post text, p_comment text, p_parent text, p_verb text, p_event_key text,
  p_provider_time timestamptz, p_author text, p_author_label text, p_author_is_page boolean, p_body text
) returns text language plpgsql security invoker set search_path = '' as $$
declare
  v_post uuid;
  v_comment public.office_social_comments%rowtype;
  v_applied boolean;
begin
  if p_channel is null or p_channel not in ('facebook', 'instagram') or p_asset is null or p_asset !~ '^[0-9]{1,32}$'
    or p_post is null or char_length(p_post) not between 1 and 200 or p_comment is null or char_length(p_comment) not between 1 and 200
    or (p_parent is not null and char_length(p_parent) > 200)
    or p_verb is null or p_verb not in ('add', 'edited', 'remove', 'hide', 'unhide')
    or p_event_key is null or p_event_key !~ '^meta-comment:event:[0-9a-f]{64}$'
    or p_provider_time is null or not isfinite(p_provider_time) or p_provider_time > now() + interval '5 minutes'
    or (p_body is not null and char_length(p_body) > 8000) or p_author_is_page is null
  then raise exception 'invalid social comment event' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(160790, pg_catalog.hashtext(p_channel || ':' || p_asset || ':' || p_comment));
  if exists (select 1 from public.office_social_comment_events where event_key = p_event_key) then return 'duplicate'; end if;

  insert into public.office_social_posts (channel, asset_id, provider_post_id)
    values (p_channel, p_asset, p_post)
    on conflict (channel, asset_id, provider_post_id) do nothing;
  select id into v_post from public.office_social_posts where channel = p_channel and asset_id = p_asset and provider_post_id = p_post;

  select * into v_comment from public.office_social_comments where channel = p_channel and asset_id = p_asset and provider_comment_id = p_comment;
  if not found then
    insert into public.office_social_comments (post_id, channel, asset_id, provider_comment_id, provider_parent_id, author_provider_id,
        author_label, author_is_page, body, visibility, deleted_at, edited_at, provider_created_at, last_event_at)
      values (v_post, p_channel, p_asset, p_comment, p_parent, p_author, p_author_label, p_author_is_page,
        case when p_verb = 'remove' then null else p_body end,
        case when p_verb = 'hide' then 'hidden' else 'visible' end,
        case when p_verb = 'remove' then p_provider_time end,
        case when p_verb = 'edited' then p_provider_time end,
        case when p_verb = 'add' then p_provider_time end,
        p_provider_time)
      returning * into v_comment;
    v_applied := true;
  elsif v_comment.post_id <> v_post then
    raise exception 'social comment post conflict' using errcode = '23505';
  elsif v_comment.deleted_at is not null or p_provider_time < v_comment.last_event_at then
    v_applied := false;  -- deletion is final; older events never overwrite newer state
  else
    update public.office_social_comments set
        body = case when p_verb = 'remove' then null when p_verb in ('add', 'edited') and p_body is not null then p_body else body end,
        visibility = case when p_verb = 'hide' then 'hidden' when p_verb = 'unhide' then 'visible' else visibility end,
        deleted_at = case when p_verb = 'remove' then p_provider_time else deleted_at end,
        edited_at = case when p_verb = 'edited' then p_provider_time else edited_at end,
        provider_created_at = coalesce(provider_created_at, case when p_verb = 'add' then p_provider_time end),
        provider_parent_id = coalesce(provider_parent_id, p_parent),
        author_provider_id = coalesce(author_provider_id, p_author),
        author_label = coalesce(author_label, p_author_label),
        last_event_at = p_provider_time
      where id = v_comment.id;
    v_applied := true;
  end if;

  insert into public.office_social_comment_events (comment_id, event_key, verb, provider_time, applied)
    values (v_comment.id, p_event_key, p_verb, p_provider_time, v_applied);
  update public.office_social_posts set last_comment_at = greatest(last_comment_at, p_provider_time) where id = v_post;
  return case when v_applied then 'accepted' else 'stale' end;
end;
$$;
revoke all on function public.office_record_social_comment_event(text,text,text,text,text,text,text,timestamptz,text,text,boolean,text) from public, anon, authenticated;
grant execute on function public.office_record_social_comment_event(text,text,text,text,text,text,text,timestamptz,text,text,boolean,text) to service_role;

commit;
