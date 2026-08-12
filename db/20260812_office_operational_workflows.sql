-- Additive Office operational workflow hardening.
-- Do not apply to production without explicit migration approval.

alter table crm_activities add column if not exists project_id text;
alter table crm_activities add column if not exists portfolio_id text;
alter table crm_activities add column if not exists support_case_id text;
alter table crm_activities add column if not exists meeting_id text;
alter table crm_activities add column if not exists related_type text;
alter table crm_activities add column if not exists related_id text;
alter table office_support_cases add column if not exists resolved_at timestamptz;
alter table office_meetings add column if not exists completed_at timestamptz;
alter table office_meetings add column if not exists cancelled_at timestamptz;

create index if not exists crm_activities_related_object_idx on crm_activities (related_type, related_id, occurred_at desc);
create index if not exists crm_activities_project_idx on crm_activities (project_id, occurred_at desc);
create index if not exists crm_activities_portfolio_idx on crm_activities (portfolio_id, occurred_at desc);
create index if not exists crm_activities_support_case_idx on crm_activities (support_case_id, occurred_at desc);

create table if not exists office_handoffs (
  handoff_id text primary key,
  communications_session_id text,
  public_session_id text,
  oyi_thread_id text,
  business_unit text not null default 'corporate',
  requested_capability text not null default 'corporate.office_desk',
  media_mode text not null default 'chat',
  reason text,
  status text not null default 'requested',
  priority text not null default 'normal',
  assigned_staff_id text,
  crm_contact_ref text,
  crm_opportunity_ref text,
  safe_visitor_context jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists office_handoffs_status_idx on office_handoffs (status, business_unit, requested_capability, created_at);
