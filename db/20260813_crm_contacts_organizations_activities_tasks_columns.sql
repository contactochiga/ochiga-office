-- Additive fix: crm_contacts/crm_organizations/crm_activities/crm_tasks
-- were missing columns that office-operating-system.js's
-- normalizeCorporateRecord() has always sent for every
-- CORPORATE_COLLECTIONS entry (business_unit, status, owner, and for
-- activities, updated_at) — every write to these four tables against
-- Supabase failed with PGRST204 "unknown column" until these were added.
alter table crm_contacts add column if not exists business_unit text;
alter table crm_contacts add column if not exists status text not null default 'active';
alter table crm_contacts add column if not exists owner text;

alter table crm_organizations add column if not exists business_unit text;
alter table crm_organizations add column if not exists status text not null default 'active';
alter table crm_organizations add column if not exists owner text;

alter table crm_activities add column if not exists business_unit text;
alter table crm_activities add column if not exists status text not null default 'active';
alter table crm_activities add column if not exists owner text;
alter table crm_activities add column if not exists updated_at timestamptz not null default now();

alter table crm_tasks add column if not exists business_unit text;
alter table crm_tasks add column if not exists owner text;
