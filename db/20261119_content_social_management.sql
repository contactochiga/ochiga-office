-- Social publishing, public comment replies and analytics for Oyi Content.
-- These ledgers are separate from DM/WhatsApp messaging. They are service-role only and default-off at the application layer.
begin;

alter table public.office_content_items
  add column if not exists social_content jsonb not null default '{}'::jsonb
    check (jsonb_typeof(social_content) = 'object');

create table if not exists public.office_social_publish_attempts (
  id uuid primary key default gen_random_uuid(),
  content_item_id text not null references public.office_content_items(id) on delete restrict,
  channel text not null check (channel in ('facebook','instagram')),
  asset_id text not null check (asset_id ~ '^[0-9]{1,32}$'),
  content_fingerprint text not null check (content_fingerprint ~ '^[0-9a-f]{64}$'),
  request_id text not null check (request_id ~ '^[A-Za-z0-9_-]{16,80}$'),
  actor_id text,
  actor_email text,
  status text not null check (status in ('scheduled','publishing','published','failed','unknown')),
  scheduled_at timestamptz,
  dispatch_token uuid,
  dispatched_at timestamptz,
  provider_dispatch_started_at timestamptz,
  recovery_authorized_at timestamptz,
  recovery_authorized_by text,
  provider_post_id text,
  provider_media_id text,
  permalink_url text check (permalink_url is null or permalink_url ~ '^https://(www\.)?(facebook\.com|instagram\.com)/'),
  failure_code text check (failure_code is null or failure_code ~ '^[a-z0-9_]{1,60}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, request_id)
);
alter table public.office_social_publish_attempts add column if not exists provider_dispatch_started_at timestamptz;
alter table public.office_social_publish_attempts add column if not exists recovery_authorized_at timestamptz;
alter table public.office_social_publish_attempts add column if not exists recovery_authorized_by text;
alter table public.office_social_publish_attempts add column if not exists provider_media_id text;
create index if not exists office_social_publish_due_idx on public.office_social_publish_attempts (scheduled_at) where status = 'scheduled';
create index if not exists office_social_publish_content_idx on public.office_social_publish_attempts (content_item_id, created_at desc);
create index if not exists office_social_publish_stale_idx on public.office_social_publish_attempts (coalesce(provider_dispatch_started_at, dispatched_at)) where status = 'publishing';

alter table public.office_social_posts add column if not exists provider_media_id text;

create table if not exists public.office_social_publish_events (
  id uuid primary key default gen_random_uuid(),
  publish_attempt_id uuid not null references public.office_social_publish_attempts(id) on delete restrict,
  event_type text not null check (event_type in ('provider_dispatch_started','stale_pre_dispatch_failed','stale_dispatch_unknown','manual_retry_authorized')),
  actor_id text,
  actor_email text,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists office_social_publish_events_attempt_idx on public.office_social_publish_events (publish_attempt_id, created_at);

create table if not exists public.office_social_comment_replies (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.office_social_comments(id) on delete restrict,
  channel text not null check (channel in ('facebook','instagram')),
  asset_id text not null check (asset_id ~ '^[0-9]{1,32}$'),
  request_id text not null check (request_id ~ '^[A-Za-z0-9_-]{16,80}$'),
  actor_id text not null,
  actor_email text not null,
  body text not null check (char_length(body) between 1 and 8000),
  status text not null check (status in ('publishing','published','failed','unknown')),
  dispatch_token uuid not null,
  provider_reply_id text,
  failure_code text check (failure_code is null or failure_code ~ '^[a-z0-9_]{1,60}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, request_id)
);
create index if not exists office_social_comment_replies_comment_idx on public.office_social_comment_replies (comment_id, created_at);

create table if not exists public.office_social_post_analytics (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.office_social_posts(id) on delete cascade,
  channel text not null check (channel in ('facebook','instagram')),
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object'),
  unavailable_metrics text[] not null default '{}'::text[],
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (isfinite(fetched_at))
);
create index if not exists office_social_post_analytics_latest_idx on public.office_social_post_analytics (post_id, fetched_at desc);

alter table public.office_social_publish_attempts enable row level security;
alter table public.office_social_comment_replies enable row level security;
alter table public.office_social_post_analytics enable row level security;
alter table public.office_social_publish_events enable row level security;
revoke all on public.office_social_publish_attempts, public.office_social_publish_events, public.office_social_comment_replies, public.office_social_post_analytics from public, anon, authenticated;
grant select, insert, update, delete on public.office_social_publish_attempts, public.office_social_publish_events, public.office_social_comment_replies, public.office_social_post_analytics to service_role;

-- Immediate publish or schedule. An open/published/unknown attempt for the same approved content/channel blocks a second provider request.
create or replace function public.office_start_social_publish(
  p_content_item_id text, p_channel text, p_asset_id text, p_content_fingerprint text,
  p_request_id text, p_actor_id text, p_actor_email text, p_scheduled_at timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_row public.office_social_publish_attempts%rowtype; v_token uuid;
begin
  if p_content_item_id is null or p_channel not in ('facebook','instagram') or p_asset_id !~ '^[0-9]{1,32}$'
    or p_content_fingerprint !~ '^[0-9a-f]{64}$' or p_request_id !~ '^[A-Za-z0-9_-]{16,80}$'
    or (p_scheduled_at is not null and (not isfinite(p_scheduled_at) or p_scheduled_at <= now()))
  then raise exception 'invalid social publish request' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(160810, pg_catalog.hashtext(p_content_item_id || ':' || p_channel));
  select * into v_row from public.office_social_publish_attempts where channel=p_channel and request_id=p_request_id for update;
  if found then
    if v_row.content_item_id<>p_content_item_id or v_row.asset_id<>p_asset_id or v_row.content_fingerprint<>p_content_fingerprint then
      raise exception 'social publish request id reused' using errcode = '22023';
    end if;
    return to_jsonb(v_row) || jsonb_build_object('duplicate', true);
  end if;
  select * into v_row from public.office_social_publish_attempts
    where content_item_id = p_content_item_id and channel = p_channel and content_fingerprint = p_content_fingerprint
      and status in ('scheduled','publishing','published','unknown')
      and not (status='unknown' and recovery_authorized_at is not null) order by created_at desc limit 1 for update;
  if found then return to_jsonb(v_row) || jsonb_build_object('duplicate', true); end if;
  v_token := case when p_scheduled_at is null then gen_random_uuid() else null end;
  insert into public.office_social_publish_attempts(content_item_id,channel,asset_id,content_fingerprint,request_id,actor_id,actor_email,status,scheduled_at,dispatch_token,dispatched_at)
    values (p_content_item_id,p_channel,p_asset_id,p_content_fingerprint,p_request_id,p_actor_id,p_actor_email,
      case when p_scheduled_at is null then 'publishing' else 'scheduled' end,p_scheduled_at,v_token,case when p_scheduled_at is null then now() end)
    returning * into v_row;
  return to_jsonb(v_row) || jsonb_build_object('duplicate', false);
end; $$;
revoke all on function public.office_start_social_publish(text,text,text,text,text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.office_start_social_publish(text,text,text,text,text,text,text,timestamptz) to service_role;

create or replace function public.office_claim_due_social_publishes(p_now timestamptz, p_limit integer default 20)
returns setof public.office_social_publish_attempts language plpgsql security invoker set search_path = '' as $$
begin
  if p_now is null or not isfinite(p_now) or p_limit not between 1 and 100 then raise exception 'invalid claim request' using errcode = '22023'; end if;
  return query with picked as (
    select id from public.office_social_publish_attempts where status = 'scheduled' and scheduled_at <= p_now
      order by scheduled_at, id limit p_limit for update skip locked
  ) update public.office_social_publish_attempts a set status='publishing', dispatch_token=gen_random_uuid(), dispatched_at=now(), updated_at=now()
    from picked where a.id=picked.id returning a.*;
end; $$;
revoke all on function public.office_claim_due_social_publishes(timestamptz,integer) from public, anon, authenticated;
grant execute on function public.office_claim_due_social_publishes(timestamptz,integer) to service_role;

create or replace function public.office_mark_social_publish_dispatch(p_id uuid,p_dispatch_token uuid,p_actor_id text,p_actor_email text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_row public.office_social_publish_attempts%rowtype;
begin
  update public.office_social_publish_attempts set provider_dispatch_started_at=now(),updated_at=now()
    where id=p_id and status='publishing' and dispatch_token=p_dispatch_token and provider_dispatch_started_at is null returning * into v_row;
  if not found then return false; end if;
  insert into public.office_social_publish_events(publish_attempt_id,event_type,actor_id,actor_email,details)
    values(v_row.id,'provider_dispatch_started',p_actor_id,p_actor_email,'{}'::jsonb);
  return true;
end; $$;
revoke all on function public.office_mark_social_publish_dispatch(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.office_mark_social_publish_dispatch(uuid,uuid,text,text) to service_role;

-- Expired attempts are never replayed. Before the provider boundary they are definitive failures;
-- after it, Meta may have accepted the post, so the only safe automatic result is UNKNOWN.
create or replace function public.office_recover_stale_social_publishes(p_before timestamptz,p_limit integer default 100)
returns setof public.office_social_publish_attempts language plpgsql security invoker set search_path = '' as $$
begin
  if p_before is null or not isfinite(p_before) or p_limit not between 1 and 500 then raise exception 'invalid recovery request' using errcode='22023'; end if;
  return query
  with picked as (
    select id from public.office_social_publish_attempts
    where status='publishing' and coalesce(provider_dispatch_started_at,dispatched_at) <= p_before
    order by coalesce(provider_dispatch_started_at,dispatched_at),id limit p_limit for update skip locked
  ), updated as (
    update public.office_social_publish_attempts a set
      status=case when a.provider_dispatch_started_at is null then 'failed' else 'unknown' end,
      failure_code=case when a.provider_dispatch_started_at is null then 'dispatch_not_started' else 'stale_dispatch_unknown' end,
      updated_at=now()
    from picked where a.id=picked.id returning a.*
  ), logged as (
    insert into public.office_social_publish_events(publish_attempt_id,event_type,details)
    select id,case when provider_dispatch_started_at is null then 'stale_pre_dispatch_failed' else 'stale_dispatch_unknown' end,
      jsonb_build_object('recovered_at',now(),'provider_dispatch_started',provider_dispatch_started_at is not null)
    from updated returning publish_attempt_id
  ) select updated.* from updated;
end; $$;
revoke all on function public.office_recover_stale_social_publishes(timestamptz,integer) from public, anon, authenticated;
grant execute on function public.office_recover_stale_social_publishes(timestamptz,integer) to service_role;

-- This is an explicit, audited staff decision, never called by a scheduler. It acknowledges that
-- the provider may already have created the post; it only permits a subsequent manual request.
create or replace function public.office_authorize_social_publish_retry(p_id uuid,p_actor_id text,p_actor_email text,p_acknowledge_uncertainty boolean)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_row public.office_social_publish_attempts%rowtype;
begin
  if p_actor_id is null or p_actor_email is null or p_acknowledge_uncertainty is distinct from true then raise exception 'uncertainty_acknowledgement_required' using errcode='22023'; end if;
  update public.office_social_publish_attempts set recovery_authorized_at=now(),recovery_authorized_by=p_actor_id,updated_at=now()
    where id=p_id and status='unknown' and recovery_authorized_at is null returning * into v_row;
  if not found then return false; end if;
  insert into public.office_social_publish_events(publish_attempt_id,event_type,actor_id,actor_email,details)
    values(v_row.id,'manual_retry_authorized',p_actor_id,p_actor_email,jsonb_build_object('acknowledged_possible_duplicate',true));
  return true;
end; $$;
revoke all on function public.office_authorize_social_publish_retry(uuid,text,text,boolean) from public, anon, authenticated;
grant execute on function public.office_authorize_social_publish_retry(uuid,text,text,boolean) to service_role;

drop function if exists public.office_settle_social_publish(uuid,uuid,text,text,text,text);
create or replace function public.office_settle_social_publish(p_id uuid, p_dispatch_token uuid, p_status text,
  p_provider_post_id text, p_provider_media_id text, p_permalink text, p_failure_code text) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare v_row public.office_social_publish_attempts%rowtype;
begin
  if p_status not in ('published','failed','unknown') or (p_status='published' and (p_provider_post_id is null or char_length(p_provider_post_id) not between 1 and 200))
    or (p_failure_code is not null and p_failure_code !~ '^[a-z0-9_]{1,60}$')
  then raise exception 'invalid social publish outcome' using errcode = '22023'; end if;
  update public.office_social_publish_attempts set status=p_status, provider_post_id=p_provider_post_id, provider_media_id=p_provider_media_id, permalink_url=p_permalink,
    failure_code=p_failure_code, updated_at=now()
    where id=p_id and status='publishing' and dispatch_token=p_dispatch_token returning * into v_row;
  if not found then return false; end if;
  if p_status='published' and v_row.provider_dispatch_started_at is null then raise exception 'provider_dispatch_not_started' using errcode='22023'; end if;
  if p_status='published' then
    insert into public.office_social_posts(channel,asset_id,provider_post_id,provider_media_id,content_item_id,origin,caption,media_type,permalink_url,published_at,sync_status,synced_at)
      select v_row.channel,v_row.asset_id,p_provider_post_id,p_provider_media_id,v_row.content_item_id,'office',
        nullif(i.social_content->v_row.channel->>'caption',''),i.social_content->v_row.channel->>'media_type',p_permalink,now(),'synced',now()
      from public.office_content_items i where i.id=v_row.content_item_id
      on conflict(channel,asset_id,provider_post_id) do update set content_item_id=excluded.content_item_id, origin='office',
        caption=coalesce(excluded.caption,office_social_posts.caption), media_type=coalesce(excluded.media_type,office_social_posts.media_type),
        permalink_url=coalesce(excluded.permalink_url,office_social_posts.permalink_url),
        provider_media_id=coalesce(excluded.provider_media_id,office_social_posts.provider_media_id),
        published_at=coalesce(office_social_posts.published_at,excluded.published_at);
  end if;
  return true;
end; $$;
revoke all on function public.office_settle_social_publish(uuid,uuid,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.office_settle_social_publish(uuid,uuid,text,text,text,text,text) to service_role;

create or replace function public.office_start_social_comment_reply(p_comment_id uuid,p_channel text,p_asset_id text,p_request_id text,
  p_actor_id text,p_actor_email text,p_body text) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_row public.office_social_comment_replies%rowtype; v_comment public.office_social_comments%rowtype;
begin
  if p_channel not in ('facebook','instagram') or p_asset_id !~ '^[0-9]{1,32}$' or p_request_id !~ '^[A-Za-z0-9_-]{16,80}$'
    or p_actor_id is null or p_actor_email is null or p_body is null or char_length(p_body) not between 1 and 8000
  then raise exception 'invalid social comment reply' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(160811, pg_catalog.hashtext(p_comment_id::text));
  select * into v_row from public.office_social_comment_replies where channel=p_channel and request_id=p_request_id;
  if found then
    if v_row.comment_id<>p_comment_id or v_row.asset_id<>p_asset_id or v_row.body<>p_body then
      raise exception 'social comment reply request id reused' using errcode = '22023';
    end if;
    return to_jsonb(v_row) || jsonb_build_object('duplicate', true);
  end if;
  select * into v_comment from public.office_social_comments where id=p_comment_id for update;
  if not found or v_comment.channel<>p_channel or v_comment.asset_id<>p_asset_id or v_comment.deleted_at is not null or v_comment.author_is_page then
    raise exception 'comment_not_actionable' using errcode = '22023'; end if;
  if exists(select 1 from public.office_social_comment_replies where comment_id=p_comment_id and status in ('publishing','published','unknown')) then
    return jsonb_build_object('duplicate',true,'status','blocked'); end if;
  insert into public.office_social_comment_replies(comment_id,channel,asset_id,request_id,actor_id,actor_email,body,status,dispatch_token)
    values(p_comment_id,p_channel,p_asset_id,p_request_id,p_actor_id,p_actor_email,p_body,'publishing',gen_random_uuid()) returning * into v_row;
  return to_jsonb(v_row) || jsonb_build_object('duplicate',false);
end; $$;
revoke all on function public.office_start_social_comment_reply(uuid,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.office_start_social_comment_reply(uuid,text,text,text,text,text,text) to service_role;

create or replace function public.office_settle_social_comment_reply(p_id uuid,p_dispatch_token uuid,p_status text,p_provider_reply_id text,p_failure_code text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_status not in ('published','failed','unknown') or (p_provider_reply_id is not null and char_length(p_provider_reply_id) not between 1 and 200)
    or (p_failure_code is not null and p_failure_code !~ '^[a-z0-9_]{1,60}$') then raise exception 'invalid reply outcome' using errcode='22023'; end if;
  update public.office_social_comment_replies set status=p_status, provider_reply_id=p_provider_reply_id, failure_code=p_failure_code, updated_at=now()
    where id=p_id and status='publishing' and dispatch_token=p_dispatch_token;
  return found;
end; $$;
revoke all on function public.office_settle_social_comment_reply(uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.office_settle_social_comment_reply(uuid,uuid,text,text,text) to service_role;

create or replace function public.office_upsert_social_post_analytics(p_post_id uuid,p_channel text,p_metrics jsonb,p_unavailable text[],p_fetched_at timestamptz)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_id uuid;
begin
  if p_channel not in ('facebook','instagram') or jsonb_typeof(p_metrics)<>'object' or p_unavailable is null or p_fetched_at is null or not isfinite(p_fetched_at)
  then raise exception 'invalid analytics snapshot' using errcode='22023'; end if;
  if not exists(select 1 from public.office_social_posts where id=p_post_id and channel=p_channel) then raise exception 'social_post_not_found' using errcode='22023'; end if;
  insert into public.office_social_post_analytics(post_id,channel,metrics,unavailable_metrics,fetched_at)
    values(p_post_id,p_channel,p_metrics,p_unavailable,p_fetched_at) returning id into v_id;
  return v_id;
end; $$;
revoke all on function public.office_upsert_social_post_analytics(uuid,text,jsonb,text[],timestamptz) from public, anon, authenticated;
grant execute on function public.office_upsert_social_post_analytics(uuid,text,jsonb,text[],timestamptz) to service_role;

commit;
