-- Durable Office runtime settings (key/value). First key: whatsapp_autonomous_responses_enabled (boolean).
-- A missing row means the documented default (OFF). Changes are audited through audit_events by the application.
create table if not exists office_runtime_settings (
  key text primary key,
  value jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- Not exposed to anon/authenticated roles: the Office server accesses it with its service credentials only.
alter table office_runtime_settings enable row level security;

-- Inbound WhatsApp message de-duplication across server instances: one stored "message" event per provider message id.
-- Created only if no duplicates already exist (a duplicate-bearing table keeps working through the application-level check; the notice says so).
do $$
begin
  if exists (select 1 from inbound_events where event_type = 'message' and external_event_id is not null group by channel, event_type, external_event_id having count(*) > 1) then
    raise notice 'inbound_events_message_once not created: duplicate message ids already exist; clean them up and re-run';
  else
    create unique index if not exists inbound_events_message_once on inbound_events (channel, event_type, external_event_id) where event_type = 'message' and external_event_id is not null;
  end if;
end $$;
