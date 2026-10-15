-- Durable lifecycle + idempotency for MANUAL (staff) WhatsApp replies sent from the CRM relationship workspace.
-- The send intent is persisted BEFORE the provider is called; a unique key (lead, actor, client request id) makes concurrent/duplicate requests claim exactly once across
-- processes and restarts. There is no transaction spanning Meta and the database, so an outcome the server could not observe is stored as `outcome_unknown` and is only
-- ever resolved by evidence or by a governed staff decision -- never by an automatic resend.
-- Additive and non-destructive. Customer-facing text only; RLS on, no anon/authenticated access (server uses the service role).
create table if not exists whatsapp_manual_sends (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null,
  actor_email text not null,
  client_request_id text not null,
  channel text not null default 'whatsapp',
  recipient text not null,
  body text not null,
  body_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'provider_accepted', 'provider_rejected', 'outcome_unknown', 'not_sent')),
  provider_message_id text,
  provider_response_code integer,
  failure_reason text,
  conversation_id uuid,
  conversation_recorded_at timestamptz,
  resolved_by text,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lead_id, actor_email, client_request_id)
);
create index if not exists whatsapp_manual_sends_lead_created_idx on whatsapp_manual_sends (lead_id, created_at desc);
create index if not exists whatsapp_manual_sends_open_idx on whatsapp_manual_sends (status, created_at) where status in ('pending', 'outcome_unknown') or conversation_recorded_at is null;
alter table whatsapp_manual_sends enable row level security;

-- Correlation id for future conversation rows (the manual-send id), unique so a repeated local persistence attempt can never create a second row. Historical rows keep NULL.
alter table conversations add column if not exists correlation_id text;
create unique index if not exists conversations_correlation_id_uidx on conversations (correlation_id) where correlation_id is not null;
