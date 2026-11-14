-- Proposed after 20261113_meta_social_inbound.sql. No backfill from hashed identities.
begin;
alter table public.leads
  add column if not exists meta_social_asset_id text,
  add column if not exists meta_social_sender_id text,
  add column if not exists meta_social_last_inbound_at timestamptz,
  add column if not exists meta_social_opted_out boolean;
alter table public.whatsapp_manual_sends
  add column if not exists social_delivery_state text check (social_delivery_state in ('delivered', 'read'));
create unique index if not exists social_manual_send_unresolved_idx
  on public.whatsapp_manual_sends (lead_id, channel)
  where channel in ('facebook', 'instagram') and status in ('pending', 'outcome_unknown');
create unique index if not exists social_manual_send_receipt_idx
  on public.whatsapp_manual_sends (channel, recipient, provider_message_id)
  where channel in ('facebook', 'instagram') and provider_message_id is not null;

create or replace function public.office_record_meta_social_reply_target(
  p_channel text, p_sender_key text, p_event_key text, p_text text, p_occurred_at timestamptz,
  p_asset text, p_sender text, p_opted_out boolean
) returns text language plpgsql security invoker set search_path = '' as $$
declare
  outcome text;
begin
  if p_asset is null or p_asset !~ '^[0-9]{1,32}$' or p_sender is null
    or p_sender !~ '^[0-9]{1,32}$' or p_asset = p_sender or p_opted_out is null
  then raise exception 'invalid social target' using errcode = '22023'; end if;
  outcome := public.office_record_meta_social_message(p_channel, p_sender_key, p_event_key, p_text, p_occurred_at);
  if outcome = 'accepted' then
    update public.leads
    set meta_social_asset_id = p_asset, meta_social_sender_id = p_sender,
        meta_social_last_inbound_at = greatest(meta_social_last_inbound_at, p_occurred_at),
        meta_social_opted_out = coalesce(meta_social_opted_out, exists (
          select 1 from public.conversations c where c.lead_id = leads.id
            and c.channel = p_channel and c.message_role = 'user' and
            btrim(c.content) ~* '^(stop( all)?|unsubscribe|opt[ -]?out|cancel|end|quit|do not (contact|message)( me)?)[.!]?$'
        )) or p_opted_out
    where idempotency_key = p_sender_key
      and (meta_social_asset_id is null or (meta_social_asset_id = p_asset and meta_social_sender_id = p_sender));
    if not found then raise exception 'social target conflict' using errcode = '23505'; end if;
  end if;
  return outcome;
end;
$$;

create or replace function public.office_record_meta_social_receipt(
  p_channel text, p_binding text, p_mid text, p_state text
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_channel not in ('facebook', 'instagram') or p_state not in ('delivered', 'read')
    or p_channel is null or p_state is null then return false; end if;
  update public.whatsapp_manual_sends
    set social_delivery_state = case when social_delivery_state = 'read' then 'read' else p_state end
    where channel = p_channel and recipient = p_binding and provider_message_id = p_mid
      and status = 'provider_accepted';
  if found then return true; end if;
  return not exists (select 1 from public.whatsapp_manual_sends
    where channel = p_channel and recipient = p_binding and status = 'pending');
end;
$$;
revoke all on function public.office_record_meta_social_reply_target(text,text,text,text,timestamptz,text,text,boolean),
  public.office_record_meta_social_receipt(text,text,text,text) from public, anon, authenticated;
grant execute on function public.office_record_meta_social_reply_target(text,text,text,text,timestamptz,text,text,boolean),
  public.office_record_meta_social_receipt(text,text,text,text) to service_role;
commit;
