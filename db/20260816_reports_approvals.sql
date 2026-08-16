-- Reports + Approvals (Ochiga Ecosystem Standardization, Programme 9).
-- Comments/history reuse the existing crm_activities timeline via
-- related_type "report" — no second audit/history engine.
create table if not exists office_reports (
  id text primary key,
  title text not null,
  body text not null default '',
  related_type text,
  related_id text,
  author text not null,
  status text not null default 'submitted', -- submitted | approved | rejected
  reviewer text,
  decision_note text,
  decided_at timestamptz,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists office_reports_status_idx
on office_reports (status, updated_at desc);

create index if not exists office_reports_related_idx
on office_reports (related_type, related_id);
