-- Proposed only. Requires leads_idempotency_key_idx and conversations_correlation_id_uidx.
-- Use existing leads, conversations and channel state, with one atomic write.
begin;
create or replace function public.office_record_meta_social_message(
  p_channel text, p_sender_key text, p_event_key text, p_text text, p_occurred_at timestamptz
) returns text
language plpgsql security invoker set search_path = ''
as $$
declare
  v_lead uuid;
  v_existing_lead uuid;
  v_existing_channel text;
begin
  if p_channel is null or p_channel not in ('facebook', 'instagram')
    or p_sender_key is null or p_sender_key !~ '^meta-social:sender:[0-9a-f]{64}$'
    or p_event_key is null or p_event_key !~ '^meta-social:event:[0-9a-f]{64}$'
    or p_text is null or char_length(p_text) not between 1 and 4000
    or p_occurred_at is null or not isfinite(p_occurred_at)
    or p_occurred_at <= '1970-01-01'::timestamptz
    or p_occurred_at > now() + interval '5 minutes'
  then raise exception 'invalid social message' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(160783, pg_catalog.hashtext(p_event_key));
  perform pg_catalog.pg_advisory_xact_lock(160784, pg_catalog.hashtext(p_sender_key));
  select id into v_lead from public.leads
    where idempotency_key = p_sender_key;
  select lead_id, channel into v_existing_lead, v_existing_channel from public.conversations
    where correlation_id = p_event_key;
  if found then
    if v_existing_lead is distinct from v_lead or v_existing_channel is distinct from p_channel then
      raise exception 'social message identity conflict' using errcode = '23505';
    end if;
    return 'duplicate';
  end if;

  if v_lead is null then
    insert into public.leads (name, source, source_channel, primary_channel, status, idempotency_key)
    values (case p_channel when 'facebook' then 'Messenger contact' else 'Instagram contact' end,
      p_channel, p_channel, p_channel, 'new', p_sender_key)
    returning id into v_lead;
  end if;

  insert into public.conversations (lead_id, agent_name, message_role, channel, content, correlation_id, created_at)
  values (v_lead, 'meta_social', 'user', p_channel, p_text, p_event_key, p_occurred_at);
  insert into public.lead_channel_states (lead_id, channel, ai_paused, last_inbound_at)
  values (v_lead, p_channel, true, p_occurred_at)
  on conflict (lead_id, channel) do update
    set last_inbound_at = greatest(lead_channel_states.last_inbound_at, excluded.last_inbound_at);
  update public.leads
    set last_contact_at = greatest(last_contact_at, p_occurred_at),
        channel_last_seen_at = greatest(channel_last_seen_at, p_occurred_at)
    where id = v_lead;
  return 'accepted';
end;
$$;
revoke all on function public.office_record_meta_social_message(text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.office_record_meta_social_message(text, text, text, text, timestamptz)
  to service_role;
commit;
