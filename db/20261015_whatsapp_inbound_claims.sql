-- Idempotency for inbound WhatsApp deliveries: one row per Meta provider message id, claimed (INSERT ... ON CONFLICT DO NOTHING) BEFORE a lead is created or a reply drafted.
-- Additive and non-destructive: existing inbound_events rows (including historical duplicate provider ids) are never modified or deleted; they are only read to seed claims
-- for message ids that were already processed, so a late Meta retry of an old message cannot trigger a second reply or a second lead.
create table if not exists whatsapp_inbound_claims (
  provider_message_id text primary key,
  channel text not null default 'whatsapp',
  status text not null default 'processing' check (status in ('processing', 'completed')),
  lead_id uuid,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  reply_sent_at timestamptz,
  request_id text
);
alter table whatsapp_inbound_claims enable row level security;

insert into whatsapp_inbound_claims (provider_message_id, channel, status, lead_id, claimed_at, completed_at, reply_sent_at)
select distinct on (external_event_id) external_event_id, channel, 'completed', lead_id, created_at, created_at, created_at
from inbound_events
where channel = 'whatsapp' and event_type = 'message' and external_event_id is not null and external_event_id <> ''
order by external_event_id, created_at asc
on conflict (provider_message_id) do nothing;
