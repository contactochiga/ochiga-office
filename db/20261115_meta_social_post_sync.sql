-- Content → Posts & Comments, C2: read-only snapshots of Facebook Page posts and Instagram media, synchronised by staff
-- request. Extends C1's office_social_posts (same unique post key, so comments and synced posts share one row).
-- Applied after 20261114_meta_social_posts_comments.sql; the security baseline then re-applies and the gate runs.
begin;

alter table public.office_social_posts
  add column if not exists caption text check (caption is null or char_length(caption) <= 8000),
  add column if not exists permalink_url text check (permalink_url is null or permalink_url ~ '^https://(www\.)?(facebook\.com|instagram\.com)/'),
  add column if not exists media_type text check (media_type is null or char_length(media_type) <= 40),
  add column if not exists media_preview_url text check (media_preview_url is null or media_preview_url ~ '^https://[a-z0-9.-]+\.(fbcdn\.net|cdninstagram\.com)/'),
  add column if not exists published_at timestamptz,
  add column if not exists provider_updated_at timestamptz,
  add column if not exists sync_status text not null default 'not_synced' check (sync_status in ('not_synced', 'synced', 'unavailable', 'restricted', 'error')),
  add column if not exists sync_error text check (sync_error is null or sync_error ~ '^[a-z0-9_]{1,60}$'),
  add column if not exists synced_at timestamptz,
  add column if not exists unavailable_since timestamptz;

-- One atomic write per lookup result. The post must belong to the configured asset (a Facebook post id is
-- "<page id>_<post id>"). A successful snapshot never replaces newer details; a failed lookup records its status and keeps
-- the last good details. Returns 'created' or 'updated'.
create or replace function public.office_upsert_social_post_snapshot(
  p_channel text, p_asset text, p_post text, p_status text, p_error text, p_caption text, p_permalink text,
  p_media_type text, p_preview text, p_published timestamptz, p_updated timestamptz
) returns text language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.office_social_posts%rowtype;
  v_created boolean := false;
begin
  if p_channel is null or p_channel not in ('facebook', 'instagram') or p_asset is null or p_asset !~ '^[0-9]{1,32}$'
    or p_post is null or p_post !~ '^[A-Za-z0-9_.:-]{1,200}$'
    or (p_channel = 'facebook' and left(p_post, char_length(p_asset) + 1) <> p_asset || '_')
    or p_status is null or p_status not in ('synced', 'unavailable', 'restricted', 'error')
    or (p_error is not null and p_error !~ '^[a-z0-9_]{1,60}$')
    or (p_published is not null and not isfinite(p_published)) or (p_updated is not null and not isfinite(p_updated))
  then raise exception 'invalid social post snapshot' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(160791, pg_catalog.hashtext(p_channel || ':' || p_asset || ':' || p_post));
  insert into public.office_social_posts (channel, asset_id, provider_post_id)
    values (p_channel, p_asset, p_post)
    on conflict (channel, asset_id, provider_post_id) do nothing
    returning true into v_created;
  select * into v_row from public.office_social_posts where channel = p_channel and asset_id = p_asset and provider_post_id = p_post for update;

  if p_status = 'synced' then
    update public.office_social_posts set
        caption = case when p_updated is null or v_row.provider_updated_at is null or p_updated >= v_row.provider_updated_at then p_caption else caption end,
        permalink_url = coalesce(p_permalink, permalink_url),
        media_type = coalesce(p_media_type, media_type),
        media_preview_url = case when p_updated is null or v_row.provider_updated_at is null or p_updated >= v_row.provider_updated_at then p_preview else media_preview_url end,
        published_at = coalesce(published_at, p_published),
        provider_updated_at = greatest(provider_updated_at, p_updated),
        sync_status = 'synced', sync_error = null, synced_at = now(), unavailable_since = null
      where id = v_row.id;
  else
    update public.office_social_posts set
        sync_status = p_status, sync_error = p_error, synced_at = now(),
        unavailable_since = case when p_status = 'unavailable' then coalesce(unavailable_since, now()) else unavailable_since end
      where id = v_row.id;
  end if;
  return case when coalesce(v_created, false) then 'created' else 'updated' end;
end;
$$;
revoke all on function public.office_upsert_social_post_snapshot(text,text,text,text,text,text,text,text,text,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.office_upsert_social_post_snapshot(text,text,text,text,text,text,text,text,text,timestamptz,timestamptz) to service_role;

commit;
