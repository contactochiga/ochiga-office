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
