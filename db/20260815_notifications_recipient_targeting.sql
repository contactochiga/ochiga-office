-- Recipient targeting for notifications (Phase 4, Office v2). Null
-- recipient_email = broadcast (unchanged visibility from before this
-- migration); a non-null recipient_email restricts the row to that one
-- staff member. related_type/related_id let the notification panel
-- deep-link, reusing the same pattern already used by crm_activities.
alter table notifications add column if not exists recipient_email text;
alter table notifications add column if not exists read_at timestamptz;
alter table notifications add column if not exists related_type text;
alter table notifications add column if not exists related_id text;

create index if not exists notifications_recipient_idx
on notifications (recipient_email, read_at, created_at desc);
