-- Office-owned communication delivery OUTBOX: a durable queue of authenticated WhatsApp inbound events (messages and provider status callbacks) that must reach Oyi Backend.
-- It carries communication EVIDENCE only; deliveries after the first attempt (and all reconciled/historical ones) are sent with replay:true so they can never wake an Oyi goal or
-- cause a customer reply. One row per delivery_key (unique) prevents duplicate pending entries; a lease on (status, attempts) keeps concurrent workers from forwarding one entry twice.
-- Additive and non-destructive. Holds customer message text (needed to re-send): RLS on, no anon/authenticated access (the server uses the service role).
create table if not exists communication_delivery_outbox (
  id uuid primary key default gen_random_uuid(),
  delivery_key text not null unique,
  channel text not null default 'whatsapp',
  event_type text not null check (event_type in ('message', 'status')),
  provider_message_id text not null,
  status_value text,
  source_event_id uuid,
  lead_id uuid,
  payload jsonb not null,
  mode text not null default 'live' check (mode in ('live', 'replay')),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'dead')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  leased_by text,
  last_error text,
  last_http_status integer,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  dead_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists communication_delivery_outbox_due_idx on communication_delivery_outbox (next_attempt_at) where status = 'pending';
create index if not exists communication_delivery_outbox_provider_idx on communication_delivery_outbox (provider_message_id);
alter table communication_delivery_outbox enable row level security;
