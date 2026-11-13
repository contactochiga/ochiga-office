-- Content → Posts & Comments, C3: hide/unhide moderation of public Facebook/Instagram comments, with an audited ledger.
-- Every staff request is claimed here before any Graph call; at most one action can be open per comment. An outcome is
-- 'confirmed' only after a trusted read-back shows the requested state; 'failed' means it definitely did not happen;
-- 'unknown' means it could not be verified yet (reconcile later). No deletion, no replies.
-- Applied after 20261115_meta_social_post_sync.sql; the security baseline then re-applies and the gate runs.
begin;

create table if not exists public.office_social_comment_actions (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.office_social_comments(id) on delete cascade,
  action text not null check (action in ('hide', 'unhide')),
  actor_user_id text not null check (char_length(actor_user_id) between 1 and 80),
  actor_email text not null check (char_length(actor_email) between 3 and 320),
  client_request_id text not null check (client_request_id ~ '^[A-Za-z0-9_-]{16,80}$'),
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  status text not null default 'pending' check (status in ('pending', 'dispatched', 'confirmed', 'failed', 'unknown')),
  dispatch_at timestamptz,
  provider_response_code integer,
  failure_reason text check (failure_reason is null or failure_reason ~ '^[a-z0-9_]{1,60}$'),
  resolved_by text check (resolved_by is null or resolved_by in ('readback', 'refusal', 'reconcile')),
  observed_visibility text check (observed_visibility is null or observed_visibility in ('visible', 'hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (comment_id, actor_user_id, client_request_id)
);
create unique index if not exists office_social_comment_actions_open_idx
  on public.office_social_comment_actions (comment_id) where status in ('pending', 'dispatched', 'unknown');
create index if not exists office_social_comment_actions_comment_idx on public.office_social_comment_actions (comment_id, created_at desc);

alter table public.office_social_comment_actions enable row level security;
revoke all on public.office_social_comment_actions from public, anon, authenticated;
grant select, insert, update, delete on public.office_social_comment_actions to service_role;

-- Claim a moderation request. Returns json {outcome, id, status, action}: 'claimed' (new row, nothing sent yet),
-- 'duplicate' (same staff + request id: the existing row, no second Graph call), 'request_reused' (same request id with
-- a different action), 'blocked' (another action is open on this comment), 'not_actionable' (missing, deleted or
-- Page-authored comment).
create or replace function public.office_claim_comment_moderation(
  p_comment uuid, p_action text, p_actor_id text, p_actor_email text, p_request text, p_reason text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_comment public.office_social_comments%rowtype;
  v_existing public.office_social_comment_actions%rowtype;
  v_new public.office_social_comment_actions%rowtype;
begin
  if p_comment is null or p_action is null or p_action not in ('hide', 'unhide') or p_actor_id is null or p_actor_email is null
    or p_request is null or p_request !~ '^[A-Za-z0-9_-]{16,80}$' or p_reason is null or char_length(btrim(p_reason)) not between 3 and 500
  then raise exception 'invalid moderation request' using errcode = '22023';
  end if;
  select * into v_comment from public.office_social_comments where id = p_comment for update;
  if not found or v_comment.deleted_at is not null or v_comment.author_is_page then
    return jsonb_build_object('outcome', 'not_actionable');
  end if;
  select * into v_existing from public.office_social_comment_actions
    where comment_id = p_comment and actor_user_id = p_actor_id and client_request_id = p_request;
  if found then
    return jsonb_build_object('outcome', case when v_existing.action = p_action then 'duplicate' else 'request_reused' end,
      'id', v_existing.id, 'status', v_existing.status, 'action', v_existing.action, 'failure_reason', v_existing.failure_reason);
  end if;
  if exists (select 1 from public.office_social_comment_actions where comment_id = p_comment and status in ('pending', 'dispatched', 'unknown')) then
    return jsonb_build_object('outcome', 'blocked');
  end if;
  insert into public.office_social_comment_actions (comment_id, action, actor_user_id, actor_email, client_request_id, reason)
    values (p_comment, p_action, p_actor_id, p_actor_email, p_request, btrim(p_reason))
    returning * into v_new;
  return jsonb_build_object('outcome', 'claimed', 'id', v_new.id, 'status', v_new.status, 'action', v_new.action);
end;
$$;

-- Mark the one-way dispatch before the Graph call. Returns false when the action is no longer pending.
create or replace function public.office_mark_comment_moderation_dispatched(p_id uuid) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  update public.office_social_comment_actions set status = 'dispatched', dispatch_at = now(), updated_at = now()
    where id = p_id and status = 'pending';
  return found;
end;
$$;

-- Settle an open action. 'confirmed' requires the observed visibility to equal the requested one and updates the comment;
-- 'failed' and 'unknown' never change the comment. Settled actions (confirmed/failed) are final.
create or replace function public.office_settle_comment_moderation(
  p_id uuid, p_status text, p_observed text, p_code integer, p_failure text, p_resolved_by text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_action public.office_social_comment_actions%rowtype;
begin
  if p_id is null or p_status not in ('confirmed', 'failed', 'unknown')
    or (p_observed is not null and p_observed not in ('visible', 'hidden'))
    or (p_failure is not null and p_failure !~ '^[a-z0-9_]{1,60}$')
    or (p_resolved_by is not null and p_resolved_by not in ('readback', 'refusal', 'reconcile'))
  then raise exception 'invalid moderation outcome' using errcode = '22023';
  end if;
  select * into v_action from public.office_social_comment_actions where id = p_id for update;
  if not found then raise exception 'moderation action not found' using errcode = 'P0002'; end if;
  if v_action.status not in ('pending', 'dispatched', 'unknown') then
    return jsonb_build_object('outcome', 'already_settled', 'status', v_action.status);
  end if;
  if p_status = 'confirmed' and p_observed is distinct from (case v_action.action when 'hide' then 'hidden' else 'visible' end) then
    raise exception 'confirmation requires the requested state to be observed' using errcode = '22023';
  end if;
  update public.office_social_comment_actions set status = p_status, provider_response_code = coalesce(p_code, provider_response_code),
      failure_reason = case when p_status = 'confirmed' then null else p_failure end, resolved_by = p_resolved_by,
      observed_visibility = p_observed, updated_at = now(), settled_at = case when p_status = 'unknown' then null else now() end
    where id = p_id;
  if p_status = 'confirmed' then
    update public.office_social_comments set visibility = p_observed, last_event_at = greatest(last_event_at, now())
      where id = v_action.comment_id and deleted_at is null;
  end if;
  return jsonb_build_object('outcome', 'settled', 'status', p_status);
end;
$$;

revoke all on function public.office_claim_comment_moderation(uuid,text,text,text,text,text),
  public.office_mark_comment_moderation_dispatched(uuid),
  public.office_settle_comment_moderation(uuid,text,text,integer,text,text) from public, anon, authenticated;
grant execute on function public.office_claim_comment_moderation(uuid,text,text,text,text,text),
  public.office_mark_comment_moderation_dispatched(uuid),
  public.office_settle_comment_moderation(uuid,text,text,integer,text,text) to service_role;

commit;
