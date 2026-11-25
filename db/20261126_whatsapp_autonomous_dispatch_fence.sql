begin;

-- An autonomous WhatsApp reply is authorized once per provider inbound message.
-- The durable marker is committed before HTTP to Meta; after it exists, a retry
-- must not reclaim the inbound claim, even if the process died mid-request.
alter table public.whatsapp_inbound_claims
  add column if not exists autonomous_dispatch_at timestamptz,
  add column if not exists autonomous_dispatch_revision bigint,
  add column if not exists autonomous_dispatch_state text
    check (autonomous_dispatch_state in ('authorized', 'accepted', 'unknown', 'not_sent'));

create or replace function public.office_authorize_whatsapp_autonomous_dispatch(
  p_provider_message_id text,
  p_lead_id uuid,
  p_expected_state_updated_at timestamptz
) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  inbound public.whatsapp_inbound_claims%rowtype;
  owner_state public.lead_channel_states%rowtype;
  autonomy jsonb;
begin
  select * into inbound from public.whatsapp_inbound_claims
    where provider_message_id = p_provider_message_id and channel = 'whatsapp' for update;
  if not found or inbound.lead_id is distinct from p_lead_id
     or inbound.status <> 'processing' or inbound.reply_sent_at is not null
     or inbound.autonomous_dispatch_at is not null then
    return 'whatsapp_dispatch_claim_unavailable';
  end if;

  select * into owner_state from public.lead_channel_states
    where lead_id = p_lead_id and channel = 'whatsapp' for update;
  if not found or owner_state.updated_at is distinct from p_expected_state_updated_at then
    return 'whatsapp_ownership_changed';
  end if;
  if owner_state.ai_paused is distinct from false
     or owner_state.human_status in ('human_active', 'human_review') then
    return 'whatsapp_takeover_active';
  end if;

  select value into autonomy from public.office_runtime_settings
    where key = 'whatsapp_autonomous_responses_enabled' for share;
  if not found or jsonb_typeof(autonomy) <> 'boolean' or autonomy <> 'true'::jsonb then
    return 'autonomous_whatsapp_disabled';
  end if;

  update public.whatsapp_inbound_claims
    set autonomous_dispatch_at = clock_timestamp(),
        autonomous_dispatch_revision = coalesce(owner_state.social_ownership_revision, 0),
        autonomous_dispatch_state = 'authorized'
    where provider_message_id = p_provider_message_id;
  return 'authorized';
end;
$$;
revoke all on function public.office_authorize_whatsapp_autonomous_dispatch(text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.office_authorize_whatsapp_autonomous_dispatch(text, uuid, timestamptz) to service_role;

create or replace function public.office_settle_whatsapp_autonomous_dispatch(
  p_provider_message_id text,
  p_state text
) returns text
language plpgsql security invoker set search_path = '' as $$
declare current_state text;
begin
  if p_state not in ('accepted', 'unknown', 'not_sent') then return 'invalid_state'; end if;
  update public.whatsapp_inbound_claims
    set autonomous_dispatch_state = p_state,
        reply_sent_at = case when p_state = 'accepted' then clock_timestamp() else reply_sent_at end
    where provider_message_id = p_provider_message_id
      and channel = 'whatsapp'
      and autonomous_dispatch_state = 'authorized';
  if found then return 'settled'; end if;
  select autonomous_dispatch_state into current_state from public.whatsapp_inbound_claims
    where provider_message_id = p_provider_message_id and channel = 'whatsapp';
  if current_state = p_state then return 'already_settled'; end if;
  return 'dispatch_not_authorized';
end;
$$;
revoke all on function public.office_settle_whatsapp_autonomous_dispatch(text, text) from public, anon, authenticated;
grant execute on function public.office_settle_whatsapp_autonomous_dispatch(text, text) to service_role;

commit;
