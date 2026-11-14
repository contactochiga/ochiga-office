-- Social ownership is separate from WhatsApp's legacy PATCH path. Every claim,
-- release, and provider dispatch serializes on the same lead_channel_states row.
begin;

alter table public.lead_channel_states
  add column if not exists social_ownership_revision bigint not null default 0;

create table if not exists public.office_meta_social_ownership_requests (
  lead_id uuid not null references public.leads(id) on delete cascade,
  channel text not null check (channel in ('facebook', 'instagram')),
  request_id uuid not null,
  action text not null check (action in ('takeover', 'release')),
  actor_id uuid not null,
  actor_email text not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (lead_id, channel, request_id)
);
alter table public.office_meta_social_ownership_requests enable row level security;
revoke all on public.office_meta_social_ownership_requests from public, anon, authenticated;
grant select, insert, update, delete on public.office_meta_social_ownership_requests to service_role;

create or replace function public.office_transition_meta_social_ownership(
  p_lead uuid, p_channel text, p_action text, p_actor_id uuid, p_actor_email text, p_request_id uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  current_state public.lead_channel_states%rowtype;
  prior_request public.office_meta_social_ownership_requests%rowtype;
  outcome text;
  payload jsonb;
begin
  if p_lead is null or p_channel is null or p_channel not in ('facebook', 'instagram')
    or p_action is null or p_action not in ('takeover', 'release') or p_actor_id is null
    or p_actor_email is null or length(btrim(p_actor_email)) not between 3 and 320
    or p_request_id is null then
    raise exception 'invalid social ownership transition' using errcode = '22023';
  end if;

  -- Consistent serialization key with the ownership row; duplicate request IDs
  -- are additionally serialized so their recorded result is returned exactly.
  perform pg_catalog.pg_advisory_xact_lock(160786, pg_catalog.hashtext(p_lead::text || ':' || p_channel));
  if not exists (
    select 1 from public.leads l where l.id = p_lead
      and l.meta_social_asset_id ~ '^[0-9]{1,32}$'
      and l.meta_social_sender_id ~ '^[0-9]{1,32}$'
  ) or not exists (
    select 1 from public.conversations c where c.lead_id = p_lead
      and c.channel = p_channel and c.message_role = 'user'
  ) then
    return jsonb_build_object('outcome', 'social_conversation_not_found');
  end if;

  insert into public.lead_channel_states (lead_id, channel, human_status, resume_mode)
    values (p_lead, p_channel, 'auto', 'manual_only')
    on conflict (lead_id, channel) do nothing;
  select * into current_state from public.lead_channel_states
    where lead_id = p_lead and channel = p_channel for update;

  select * into prior_request from public.office_meta_social_ownership_requests
    where lead_id = p_lead and channel = p_channel and request_id = p_request_id;
  if found then
    if prior_request.action <> p_action or prior_request.actor_id <> p_actor_id
      or lower(prior_request.actor_email) <> lower(p_actor_email) then
      raise exception 'social ownership request identity conflict' using errcode = '23505';
    end if;
    return pg_catalog.jsonb_set(prior_request.result, '{replayed}', 'true'::jsonb, true);
  end if;

  if exists (
    select 1 from public.whatsapp_manual_sends s where s.lead_id = p_lead
      and s.channel = p_channel and s.social_dispatch_at is not null
      and s.status in ('pending', 'outcome_unknown')
  ) then
    outcome := 'send_outcome_unresolved';
  elsif p_action = 'takeover' then
    if current_state.human_status in ('human_active', 'human_review') then
      outcome := case when lower(coalesce(current_state.human_owner, '')) = lower(p_actor_email)
        then 'already_owned' else 'owned_by_another' end;
    else
      update public.lead_channel_states set human_status = 'human_active', human_owner = btrim(p_actor_email),
        ai_paused = true, takeover_started_at = clock_timestamp(), takeover_reason = 'social_staff_takeover',
        resume_mode = 'manual_only', social_ownership_revision = social_ownership_revision + 1
        where lead_id = p_lead and channel = p_channel returning * into current_state;
      outcome := 'taken_over';
    end if;
  else
    if current_state.human_status not in ('human_active', 'human_review') then
      outcome := 'not_owned';
    elsif lower(coalesce(current_state.human_owner, '')) <> lower(p_actor_email) then
      outcome := 'not_owner';
    else
      -- Deliberately preserve ai_paused: ownership release is not AI handback.
      update public.lead_channel_states set human_status = 'auto', human_owner = null,
        takeover_started_at = null, takeover_reason = 'social_staff_release',
        social_ownership_revision = social_ownership_revision + 1
        where lead_id = p_lead and channel = p_channel returning * into current_state;
      outcome := 'released';
    end if;
  end if;

  payload := jsonb_build_object('outcome', outcome, 'replayed', false, 'state', jsonb_build_object(
    'human_status', current_state.human_status, 'human_owner', current_state.human_owner,
    'ai_paused', current_state.ai_paused, 'takeover_started_at', current_state.takeover_started_at,
    'social_ownership_revision', current_state.social_ownership_revision
  ));
  insert into public.office_meta_social_ownership_requests
    (lead_id, channel, request_id, action, actor_id, actor_email, result)
    values (p_lead, p_channel, p_request_id, p_action, p_actor_id, lower(btrim(p_actor_email)), payload);
  return payload;
end;
$$;
revoke all on function public.office_transition_meta_social_ownership(uuid,text,text,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.office_transition_meta_social_ownership(uuid,text,text,uuid,text,uuid) to service_role;

-- Replace the original fence signature. A provider attempt must still belong
-- to the session owner at the exact database dispatch boundary.
drop function if exists public.office_fence_meta_social_dispatch(uuid, text, text);
create or replace function public.office_fence_meta_social_dispatch(
  p_send uuid, p_channel text, p_sender_key text, p_actor_email text
) returns text language plpgsql security invoker set search_path = '' as $$
declare
  intent public.whatsapp_manual_sends%rowtype;
  target public.leads%rowtype;
  owner_state public.lead_channel_states%rowtype;
begin
  if p_channel is null or p_channel not in ('facebook', 'instagram') or p_actor_email is null
    then return 'social_dispatch_claim_lost'; end if;
  select * into intent from public.whatsapp_manual_sends
    where id = p_send and channel = p_channel for update;
  if not found or intent.status <> 'pending' or intent.social_dispatch_at is not null
    then return 'social_dispatch_claim_lost'; end if;
  select * into target from public.leads where id = intent.lead_id for update;
  if not found or target.idempotency_key is distinct from p_sender_key
    or target.meta_social_asset_id is null or target.meta_social_sender_id is null
    or intent.recipient <> target.meta_social_asset_id || ':' || target.meta_social_sender_id
    then return 'social_recipient_unverified'; end if;
  select * into owner_state from public.lead_channel_states
    where lead_id = intent.lead_id and channel = p_channel for update;
  if not found or owner_state.human_status not in ('human_active', 'human_review')
    then return 'social_takeover_required'; end if;
  if lower(coalesce(owner_state.human_owner, '')) <> lower(btrim(p_actor_email))
    then return 'social_takeover_owner_required'; end if;
  if target.meta_social_opted_out is distinct from false or target.contactability_status = 'denied'
    then return 'social_opted_out'; end if;
  if target.meta_social_last_inbound_at is null or target.meta_social_last_inbound_at > clock_timestamp()
    or target.meta_social_last_inbound_at <= clock_timestamp() - interval '24 hours'
    then return 'social_window_closed'; end if;
  if intent.created_at <= clock_timestamp() - interval '2 minutes' then return 'social_claim_expired'; end if;
  update public.whatsapp_manual_sends set social_dispatch_at = clock_timestamp() where id = p_send;
  return 'acquired';
end;
$$;
revoke all on function public.office_fence_meta_social_dispatch(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.office_fence_meta_social_dispatch(uuid,text,text,text) to service_role;

commit;
