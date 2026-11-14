-- Proposed after 20261113_meta_social_staff_replies.sql.
begin;
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
    and table_name = 'whatsapp_manual_sends' and column_name = 'social_dispatch_at') then
    alter table public.whatsapp_manual_sends add column social_dispatch_at timestamptz;
    -- Pre-fence attempts are indistinguishable from attempts that reached Meta.
    update public.whatsapp_manual_sends set social_dispatch_at = created_at
    where channel in ('facebook', 'instagram') and status in ('pending', 'outcome_unknown');
  end if;
end;
$$;

create or replace function public.office_fence_meta_social_dispatch(
  p_send uuid, p_channel text, p_sender_key text
) returns text language plpgsql security invoker set search_path = '' as $$
declare
  intent public.whatsapp_manual_sends%rowtype;
  target public.leads%rowtype;
begin
  if p_channel is null or p_channel not in ('facebook', 'instagram') then return 'social_dispatch_claim_lost'; end if;
  select * into intent from public.whatsapp_manual_sends
    where id = p_send and channel = p_channel for update;
  if not found or intent.status <> 'pending' or intent.social_dispatch_at is not null
    then return 'social_dispatch_claim_lost'; end if;
  select * into target from public.leads where id = intent.lead_id for update;
  if not found or target.idempotency_key is distinct from p_sender_key
    or target.meta_social_asset_id is null or target.meta_social_sender_id is null
    or intent.recipient <> target.meta_social_asset_id || ':' || target.meta_social_sender_id
    then return 'social_recipient_unverified'; end if;
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
revoke all on function public.office_fence_meta_social_dispatch(uuid,text,text) from public, anon, authenticated;
grant execute on function public.office_fence_meta_social_dispatch(uuid,text,text) to service_role;

create table if not exists public.office_meta_social_pending_receipts (
  channel text not null check (channel in ('facebook', 'instagram')),
  binding text not null,
  provider_message_id text not null,
  state text not null check (state in ('delivered', 'read')),
  primary key (channel, binding, provider_message_id)
);
alter table public.office_meta_social_pending_receipts enable row level security;
revoke all on public.office_meta_social_pending_receipts from public, anon, authenticated;
grant select, insert, update, delete on public.office_meta_social_pending_receipts to service_role;

create or replace function public.office_accept_meta_social_send(
  p_send uuid, p_channel text, p_binding text, p_mid text, p_code integer
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  receipt_state text;
begin
  if p_channel is null or p_channel not in ('facebook', 'instagram') or p_binding is null
    or p_mid is null or length(p_mid) not between 1 and 512 or p_mid ~ '[^!-~]' or p_code is null or p_code not between 200 and 299
    then return false; end if;
  -- Both receipt and acceptance acquire this lock before reading/writing evidence.
  perform pg_catalog.pg_advisory_xact_lock(160785, pg_catalog.hashtext(p_channel || ':' || p_binding));
  select state into receipt_state from public.office_meta_social_pending_receipts
    where channel = p_channel and binding = p_binding and provider_message_id = p_mid;
  update public.whatsapp_manual_sends
    set status = 'provider_accepted', provider_message_id = p_mid, provider_response_code = p_code,
        failure_reason = null, updated_at = clock_timestamp(),
        social_delivery_state = case when social_delivery_state = 'read' then 'read'
          else coalesce(receipt_state, social_delivery_state) end
    where id = p_send and channel = p_channel and recipient = p_binding and social_dispatch_at is not null
      and ((status in ('pending', 'outcome_unknown') and provider_message_id is null)
        or (status = 'provider_accepted' and provider_message_id = p_mid));
  if not found then return false; end if;
  delete from public.office_meta_social_pending_receipts
    where channel = p_channel and binding = p_binding and provider_message_id = p_mid;
  return true;
end;
$$;
revoke all on function public.office_accept_meta_social_send(uuid,text,text,text,integer) from public, anon, authenticated;
grant execute on function public.office_accept_meta_social_send(uuid,text,text,text,integer) to service_role;

create or replace function public.office_record_meta_social_receipt(
  p_channel text, p_binding text, p_mid text, p_state text
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_channel is null or p_channel not in ('facebook', 'instagram')
    or p_state is null or p_state not in ('delivered', 'read') or p_binding is null
    or p_mid is null or length(p_mid) not between 1 and 512 or p_mid ~ '[^!-~]' then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(160785, pg_catalog.hashtext(p_channel || ':' || p_binding));
  update public.whatsapp_manual_sends
    set social_delivery_state = case when social_delivery_state = 'read' then 'read' else p_state end
    where channel = p_channel and recipient = p_binding and provider_message_id = p_mid
      and status = 'provider_accepted';
  if found then return true; end if;
  if exists (select 1 from public.whatsapp_manual_sends where channel = p_channel and recipient = p_binding
    and social_dispatch_at is not null and status in ('pending', 'outcome_unknown')) then
    insert into public.office_meta_social_pending_receipts as r (channel, binding, provider_message_id, state)
      values (p_channel, p_binding, p_mid, p_state)
      on conflict (channel, binding, provider_message_id)
      do update set state = case when r.state = 'read' then 'read' else excluded.state end;
  end if;
  return true;
end;
$$;
revoke all on function public.office_record_meta_social_receipt(text,text,text,text) from public, anon, authenticated;
grant execute on function public.office_record_meta_social_receipt(text,text,text,text) to service_role;
commit;
