create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  name text,
  company text,
  role text,
  email text,
  phone text,
  whatsapp_phone text,
  primary_channel text,
  channel_last_seen_at timestamptz,
  source text not null,
  location text,
  unit_count integer,
  project_type text,
  status text,
  owner text,
  commercial_stage text,
  lost_reason text,
  score numeric,
  summary text,
  next_action text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table leads add column if not exists whatsapp_phone text;
alter table leads add column if not exists primary_channel text;
alter table leads add column if not exists channel_last_seen_at timestamptz;
alter table leads add column if not exists unit_count integer;
alter table leads add column if not exists project_type text;
alter table leads add column if not exists source_channel text;
alter table leads add column if not exists property_type text;
alter table leads add column if not exists city text;
alter table leads add column if not exists country text;
alter table leads add column if not exists property_size text;
alter table leads add column if not exists number_of_units integer;
alter table leads add column if not exists pain_points text;
alter table leads add column if not exists budget_range text;
alter table leads add column if not exists timeline text;
alter table leads add column if not exists decision_maker_status text;
alter table leads add column if not exists interest_package text;
alter table leads add column if not exists lead_score numeric;
alter table leads add column if not exists qualification_status text;
alter table leads add column if not exists stage text;
alter table leads add column if not exists next_action_at timestamptz;
alter table leads add column if not exists last_contact_at timestamptz;
alter table leads add column if not exists notes text;
alter table leads add column if not exists commercial_stage text;
alter table leads add column if not exists lost_reason text;
alter table leads add column if not exists business_unit text;
alter table leads add column if not exists inquiry_type text;
alter table leads add column if not exists source_site text;
alter table leads add column if not exists source_page text;
alter table leads add column if not exists source_form text;
alter table leads add column if not exists idempotency_key text;
alter table leads add column if not exists organization_id uuid;
alter table leads add column if not exists opportunity_id uuid;
alter table leads add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists leads_updated_at_idx on leads (updated_at desc);
create index if not exists leads_status_owner_idx on leads (status, owner);
create index if not exists leads_stage_idx on leads (stage, owner);
create unique index if not exists leads_idempotency_key_idx
on leads (idempotency_key)
where idempotency_key is not null;
create index if not exists leads_business_unit_idx on leads (business_unit, inquiry_type);

create table if not exists crm_organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_type text,
  website text,
  city text,
  country text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references crm_organizations(id) on delete set null,
  name text,
  email text,
  phone text,
  role text,
  source text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_opportunities (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references crm_contacts(id) on delete set null,
  organization_id uuid references crm_organizations(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  business_unit text not null default 'corporate',
  inquiry_type text not null default 'general_enquiry',
  pipeline text not null default 'corporate',
  stage text not null default 'intake_received',
  status text not null default 'open',
  owner text,
  source text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete set null,
  contact_id uuid references crm_contacts(id) on delete set null,
  organization_id uuid references crm_organizations(id) on delete set null,
  opportunity_id uuid references crm_opportunities(id) on delete set null,
  project_id text,
  portfolio_id text,
  support_case_id text,
  meeting_id text,
  related_type text,
  related_id text,
  activity_type text not null,
  title text,
  body text,
  source text,
  actor text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists crm_tasks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete set null,
  opportunity_id uuid references crm_opportunities(id) on delete set null,
  private_relationship_id text,
  partnership_relationship_id text,
  title text not null,
  status text not null default 'open',
  assignee text,
  due_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table crm_tasks add column if not exists private_relationship_id text;
alter table crm_tasks add column if not exists partnership_relationship_id text;
create index if not exists crm_tasks_private_relationship_idx on crm_tasks (private_relationship_id, status, due_at);
create index if not exists crm_tasks_partnership_relationship_idx on crm_tasks (partnership_relationship_id, status, due_at);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  agent_name text not null,
  message_role text not null,
  channel text not null default 'website',
  external_message_id text,
  parent_external_message_id text,
  content text not null,
  created_at timestamptz not null default now()
);

alter table conversations add column if not exists channel text not null default 'website';
alter table conversations add column if not exists external_message_id text;
alter table conversations add column if not exists parent_external_message_id text;

create index if not exists conversations_lead_id_created_at_idx
on conversations (lead_id, created_at);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists lead_channel_states (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  channel text not null,
  ai_paused boolean not null default false,
  human_owner text,
  human_status text not null default 'auto',
  takeover_started_at timestamptz,
  takeover_reason text,
  resume_mode text not null default 'manual_only',
  customer_service_window_expires_at timestamptz,
  last_external_message_id text,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lead_id, channel)
);

drop trigger if exists lead_channel_states_set_updated_at on lead_channel_states;
create trigger lead_channel_states_set_updated_at
before update on lead_channel_states
for each row
execute function set_updated_at();

create table if not exists inbound_events (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  provider text not null,
  event_type text not null,
  lead_id uuid references leads(id) on delete set null,
  external_event_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists inbound_events_channel_created_at_idx
on inbound_events (channel, created_at desc);

create table if not exists demos (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  scheduled_for timestamptz,
  status text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists demos_lead_id_created_at_idx
on demos (lead_id, created_at desc);

create table if not exists proposals (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  title text not null,
  tier_name text,
  unit_count integer,
  monthly_price numeric,
  currency text not null default 'NGN',
  status text not null default 'draft',
  body text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists proposals_lead_id_created_at_idx
on proposals (lead_id, created_at desc);

drop trigger if exists proposals_set_updated_at on proposals;
create trigger proposals_set_updated_at
before update on proposals
for each row
execute function set_updated_at();

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists leads_set_updated_at on leads;
create trigger leads_set_updated_at
before update on leads
for each row
execute function set_updated_at();

create table if not exists lead_memories (
  lead_id uuid primary key references leads(id) on delete cascade,
  known_fields jsonb not null default '{}'::jsonb,
  need_signals text[] not null default '{}'::text[],
  open_questions text[] not null default '{}'::text[],
  keywords text[] not null default '{}'::text[],
  last_user_message text,
  last_agent_message text,
  last_status text,
  last_owner text,
  last_summary text,
  tool_calls text[] not null default '{}'::text[],
  updated_at timestamptz not null default now()
);

create table if not exists traces (
  id uuid primary key default gen_random_uuid(),
  trace_id text,
  lead_id uuid references leads(id) on delete cascade,
  type text not null,
  agent text,
  tool_name text,
  request_id text,
  source text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists traces_lead_id_created_at_idx
on traces (lead_id, created_at desc);

create index if not exists traces_trace_id_idx
on traces (trace_id);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete set null,
  type text not null default 'internal',
  urgency text,
  reason text,
  summary text,
  delivered boolean not null default false,
  channel text,
  response_code integer,
  status text not null default 'open',
  metadata jsonb not null default '{}'::jsonb,
  -- Recipient targeting (Phase 4, v2 audit): null recipient_email means
  -- a broadcast notification, visible to anyone with notifications.read
  -- — the same visibility every notification had before this column
  -- existed. A non-null recipient_email restricts it to that one staff
  -- member. read_at is per-notification-row, so a targeted notification
  -- is inherently per-recipient already; a future true broadcast
  -- per-user read state would need a join table, not needed yet since
  -- nothing requires broadcast rows to track read state individually.
  recipient_email text,
  read_at timestamptz,
  related_type text,
  related_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notifications_lead_id_created_at_idx
on notifications (lead_id, created_at desc);

create index if not exists notifications_status_idx
on notifications (status, type);

alter table notifications add column if not exists recipient_email text;
alter table notifications add column if not exists read_at timestamptz;
alter table notifications add column if not exists related_type text;
alter table notifications add column if not exists related_id text;

create index if not exists notifications_recipient_idx
on notifications (recipient_email, read_at, created_at desc);

drop trigger if exists notifications_set_updated_at on notifications;
create trigger notifications_set_updated_at
before update on notifications
for each row
execute function set_updated_at();

create table if not exists partners (
  id uuid primary key default gen_random_uuid(),
  partner_company text not null,
  partner_type text not null default 'referral',
  tier text not null default 'founding',
  contact_name text,
  contact_email text,
  contact_phone text,
  city text,
  country text,
  status text not null default 'prospect',
  certification_status text not null default 'not_started',
  leads_referred integer not null default 0,
  deployments_supported integer not null default 0,
  revenue_share_terms text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists partners_status_idx on partners (status, tier);

drop trigger if exists partners_set_updated_at on partners;
create trigger partners_set_updated_at
before update on partners
for each row
execute function set_updated_at();

create table if not exists deployment_projects (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete set null,
  customer_name text,
  property_name text,
  property_type text,
  location text,
  package_name text,
  status text not null default 'created',
  owner text,
  checklist jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deployment_projects_status_idx on deployment_projects (status, owner);
create index if not exists deployment_projects_lead_id_idx on deployment_projects (lead_id);

drop trigger if exists deployment_projects_set_updated_at on deployment_projects;
create trigger deployment_projects_set_updated_at
before update on deployment_projects
for each row
execute function set_updated_at();

create table if not exists facility_workspaces (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete set null,
  customer_organization text,
  estate_name text,
  facility_admin_email text,
  status text not null default 'pending_manual_provisioning',
  activation_link text,
  checklist jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists facility_workspaces_status_idx on facility_workspaces (status);
create index if not exists facility_workspaces_lead_id_idx on facility_workspaces (lead_id);

drop trigger if exists facility_workspaces_set_updated_at on facility_workspaces;
create trigger facility_workspaces_set_updated_at
before update on facility_workspaces
for each row
execute function set_updated_at();

create table if not exists onboarding_emails (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete set null,
  deployment_project_id uuid references deployment_projects(id) on delete set null,
  recipient_email text,
  subject text,
  body text,
  status text not null default 'draft',
  sent_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists onboarding_emails_status_idx on onboarding_emails (status);

drop trigger if exists onboarding_emails_set_updated_at on onboarding_emails;
create trigger onboarding_emails_set_updated_at
before update on onboarding_emails
for each row
execute function set_updated_at();

create table if not exists admin_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  role text not null default 'admin',
  status text not null default 'active',
  display_name text,
  -- Office Position (job title, e.g. "CEO", "Sales Director") is
  -- deliberately separate from `role` (system authorization tier). Kept
  -- free-text since positions are organizational, not an enum the
  -- backend needs to reason about.
  office_position text,
  passport_photo_url text,
  qr_credential text,
  permission_scopes text[] not null default '{}'::text[],
  last_login_at timestamptz,
  password_changed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table admin_users add column if not exists last_login_at timestamptz;
alter table admin_users add column if not exists password_changed_at timestamptz;
alter table admin_users add column if not exists passport_photo_url text;
alter table admin_users add column if not exists qr_credential text;
alter table admin_users add column if not exists permission_scopes text[] not null default '{}'::text[];
alter table admin_users add column if not exists office_position text;

drop trigger if exists admin_users_set_updated_at on admin_users;
create trigger admin_users_set_updated_at
before update on admin_users
for each row
execute function set_updated_at();

create table if not exists admin_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role text not null default 'viewer',
  display_name text,
  office_position text,
  token_hash text not null unique,
  status text not null default 'pending',
  invited_by text,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table admin_invites add column if not exists office_position text;

create index if not exists admin_invites_email_created_at_idx
on admin_invites (email, created_at desc);

drop trigger if exists admin_invites_set_updated_at on admin_invites;
create trigger admin_invites_set_updated_at
before update on admin_invites
for each row
execute function set_updated_at();

create table if not exists password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid references admin_users(id) on delete cascade,
  email text not null,
  token_hash text not null unique,
  status text not null default 'pending',
  requested_by text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists office_packages (
  id text primary key,
  name text not null,
  code text not null,
  status text not null default 'active',
  setup_fee numeric not null default 0,
  monthly_fee numeric not null default 0,
  estate_limit integer,
  building_limit integer,
  home_limit integer,
  device_limit integer,
  api_access boolean not null default false,
  support_tier text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists office_packages_set_updated_at on office_packages;
create trigger office_packages_set_updated_at
before update on office_packages
for each row
execute function set_updated_at();

create table if not exists office_estates (
  id text primary key,
  name text not null,
  package_id text references office_packages(id) on delete set null,
  status text not null default 'active',
  subscription_status text not null default 'live',
  location text,
  latitude numeric,
  longitude numeric,
  health_score numeric,
  buildings_count integer not null default 0,
  homes_count integer not null default 0,
  devices_count integer not null default 0,
  resident_count integer not null default 0,
  wallet_balance numeric not null default 0,
  monthly_recurring_revenue numeric not null default 0,
  support_open integer not null default 0,
  support_escalated integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table office_estates add column if not exists latitude numeric;
alter table office_estates add column if not exists longitude numeric;
alter table office_estates add column if not exists health_score numeric;
alter table office_estates add column if not exists metadata jsonb not null default '{}'::jsonb;

drop trigger if exists office_estates_set_updated_at on office_estates;
create trigger office_estates_set_updated_at
before update on office_estates
for each row
execute function set_updated_at();

create table if not exists office_buildings (
  id text primary key,
  estate_id text references office_estates(id) on delete cascade,
  name text not null,
  type text,
  status text not null default 'active',
  homes_count integer not null default 0,
  devices_count integer not null default 0,
  permitted_users integer not null default 0,
  live_cameras integer not null default 0,
  occupancy_pct numeric not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table office_buildings add column if not exists status text not null default 'active';
alter table office_buildings add column if not exists metadata jsonb not null default '{}'::jsonb;

drop trigger if exists office_buildings_set_updated_at on office_buildings;
create trigger office_buildings_set_updated_at
before update on office_buildings
for each row
execute function set_updated_at();

create table if not exists office_homes (
  id text primary key,
  estate_id text references office_estates(id) on delete cascade,
  building_id text references office_buildings(id) on delete cascade,
  name text not null,
  residents_count integer not null default 0,
  devices_count integer not null default 0,
  wallet_balance numeric not null default 0,
  automation_state text not null default 'standby',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists office_homes_set_updated_at on office_homes;
create trigger office_homes_set_updated_at
before update on office_homes
for each row
execute function set_updated_at();

create table if not exists office_devices (
  id text primary key,
  estate_id text references office_estates(id) on delete cascade,
  building_id text references office_buildings(id) on delete cascade,
  home_id text references office_homes(id) on delete set null,
  name text not null,
  category text not null,
  provider text,
  protocol text,
  status text not null default 'online',
  battery_level numeric,
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table office_devices add column if not exists provider text;
alter table office_devices add column if not exists battery_level numeric;
alter table office_devices add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists office_documents (
  id text primary key,
  title text not null,
  document_type text not null default 'document',
  status text not null default 'draft',
  owner text,
  related_type text,
  related_id text,
  amount numeric not null default 0,
  currency text not null default 'NGN',
  file_url text,
  html_url text,
  email_to text,
  share_token text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table office_documents add column if not exists share_token text;

drop trigger if exists office_documents_set_updated_at on office_documents;
create trigger office_documents_set_updated_at
before update on office_documents
for each row
execute function set_updated_at();

create index if not exists office_documents_type_status_idx
on office_documents (document_type, status, updated_at desc);

drop trigger if exists office_devices_set_updated_at on office_devices;
create trigger office_devices_set_updated_at
before update on office_devices
for each row
execute function set_updated_at();

create table if not exists office_wallets (
  id text primary key,
  scope_type text not null,
  scope_id text not null,
  label text not null,
  balance numeric not null default 0,
  currency text not null default 'NGN',
  pending_charges numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists office_wallets_set_updated_at on office_wallets;
create trigger office_wallets_set_updated_at
before update on office_wallets
for each row
execute function set_updated_at();

create table if not exists office_analytics (
  id text primary key,
  surface text not null,
  label text not null,
  period text not null default '24h',
  sessions integer not null default 0,
  unique_visitors integer not null default 0,
  conversions integer not null default 0,
  active_agent text,
  top_source text,
  top_location text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists office_analytics_set_updated_at on office_analytics;
create trigger office_analytics_set_updated_at
before update on office_analytics
for each row
execute function set_updated_at();

create table if not exists office_support_mappings (
  id text primary key,
  estate_id text references office_estates(id) on delete cascade,
  building_id text references office_buildings(id) on delete set null,
  home_id text references office_homes(id) on delete set null,
  title text not null,
  category text not null,
  channel text not null default 'office',
  priority text not null default 'medium',
  status text not null default 'open',
  assigned_team text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists office_support_mappings_set_updated_at on office_support_mappings;
create trigger office_support_mappings_set_updated_at
before update on office_support_mappings
for each row
execute function set_updated_at();

create index if not exists password_reset_tokens_email_created_at_idx
on password_reset_tokens (email, created_at desc);

drop trigger if exists password_reset_tokens_set_updated_at on password_reset_tokens;
create trigger password_reset_tokens_set_updated_at
before update on password_reset_tokens
for each row
execute function set_updated_at();

create table if not exists timeline_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  event_type text not null,
  actor text,
  title text,
  body text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists timeline_events_lead_id_created_at_idx
on timeline_events (lead_id, created_at desc);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references admin_users(id) on delete set null,
  actor_email text,
  actor_role text,
  action text not null,
  target_type text not null,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table audit_events add column if not exists resource_type text;
alter table audit_events add column if not exists resource_id text;
alter table audit_events add column if not exists estate_id text;
alter table audit_events add column if not exists status text not null default 'success';
alter table audit_events add column if not exists ip text;
alter table audit_events add column if not exists user_agent text;

create index if not exists audit_events_created_at_idx
on audit_events (created_at desc);

create table if not exists office_files (
  id text primary key,
  storage_driver text not null default 'local',
  storage_key text not null,
  filename text not null,
  mime_type text not null,
  size integer not null default 0,
  purpose text not null,
  resource_type text,
  resource_id text,
  url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists office_files_purpose_created_at_idx
on office_files (purpose, created_at desc);

-- Ochiga Office corporate operating system primitives.
-- Additive only: do not apply to production without migration approval.

create table if not exists office_projects (
  id text primary key,
  name text not null,
  location text,
  business_unit text not null default 'development',
  status text not null default 'active',
  stage text not null default 'prospective',
  owner text,
  linked_opportunity_id uuid references crm_opportunities(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  organization_id uuid references crm_organizations(id) on delete set null,
  contact_id uuid references crm_contacts(id) on delete set null,
  portfolio_id text,
  backend_building_id text,
  oyi_deployment_status text not null default 'not_started',
  milestones jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists office_portfolio_entries (
  id text primary key,
  name text not null,
  client_account text,
  location text,
  business_unit text not null default 'technology',
  relationship_type text not null default 'customer_building',
  status text not null default 'active',
  owner text,
  project_id text references office_projects(id) on delete set null,
  backend_estate_id text,
  backend_building_id text,
  facility_deep_link text,
  oyi_deployment_status text not null default 'unknown',
  facility_os_status text not null default 'unknown',
  consumer_os_status text not null default 'unknown',
  health_summary text,
  support_status text not null default 'normal',
  major_escalations integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists office_support_cases (
  id text primary key,
  title text not null,
  business_unit text not null default 'technology',
  status text not null default 'open',
  owner text,
  customer_contact_id uuid references crm_contacts(id) on delete set null,
  organization_id uuid references crm_organizations(id) on delete set null,
  portfolio_id text references office_portfolio_entries(id) on delete set null,
  backend_incident_ref text,
  product_area text not null default 'oyi',
  category text not null default 'general',
  priority text not null default 'normal',
  severity text not null default 'medium',
  assigned_staff text,
  sla_target_at timestamptz,
  resolution_notes text,
  resolved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists office_private_relationships (
  id text primary key,
  contact_id uuid references crm_contacts(id) on delete set null,
  organization_id uuid references crm_organizations(id) on delete set null,
  opportunity_id uuid references crm_opportunities(id) on delete set null,
  business_unit text not null default 'private',
  relationship_type text not null default 'membership',
  status text not null default 'active',
  owner text,
  relationship_manager text,
  review_status text not null default 'active',
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists office_partnership_relationships (
  id text primary key,
  contact_id uuid references crm_contacts(id) on delete set null,
  organization_id uuid references crm_organizations(id) on delete set null,
  opportunity_id uuid references crm_opportunities(id) on delete set null,
  business_unit text not null default 'partnerships',
  relationship_type text not null default 'strategic_partner',
  status text not null default 'active',
  owner text,
  relationship_manager text,
  review_status text not null default 'active',
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists office_meetings (
  id text primary key,
  title text not null,
  business_unit text not null default 'corporate',
  status text not null default 'active',
  owner text,
  scheduled_at timestamptz,
  participants jsonb not null default '[]'::jsonb,
  related_type text,
  related_id text,
  notes text,
  outcome text,
  follow_up_task_id uuid references crm_tasks(id) on delete set null,
  completed_at timestamptz,
  cancelled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table crm_tasks add column if not exists project_id text;
alter table crm_tasks add column if not exists portfolio_id text;
alter table crm_tasks add column if not exists support_case_id text;
alter table crm_tasks add column if not exists description text;
alter table crm_tasks add column if not exists priority text not null default 'normal';
alter table crm_tasks add column if not exists completed_at timestamptz;

create index if not exists office_projects_stage_idx on office_projects (status, stage);
create index if not exists office_portfolio_backend_building_idx on office_portfolio_entries (backend_building_id);
create index if not exists office_support_cases_status_idx on office_support_cases (status, priority, severity);
create index if not exists office_private_relationships_status_idx on office_private_relationships (status, review_status);
create index if not exists office_partnership_relationships_status_idx on office_partnership_relationships (status, relationship_type);
create index if not exists office_meetings_scheduled_at_idx on office_meetings (scheduled_at desc);

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

-- crm_contacts/crm_organizations/crm_activities/crm_tasks were missing
-- columns that office-operating-system.js's normalizeCorporateRecord()
-- has always sent for every CORPORATE_COLLECTIONS entry (business_unit,
-- status, owner, and for activities, updated_at) — every write to these
-- four tables against Supabase failed with PGRST204 "unknown column"
-- until these were added.
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

-- ---------------------------------------------------------------
-- Staff messaging (Phase 5, Office v2). Deliberately separate from
-- the CRM lead/visitor `conversations` table (AI agent <-> public
-- lead chat) and from `notifications` — this is staff-to-staff only,
-- identified by admin_users.email (no separate staff id FK needed
-- since email is already the unique identity admin_users/RBAC use
-- throughout this codebase).
-- ---------------------------------------------------------------
create table if not exists staff_conversations (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'direct', -- 'direct' | 'group'
  title text,
  created_by text not null,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists staff_conversation_participants (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references staff_conversations(id) on delete cascade,
  staff_email text not null,
  joined_at timestamptz not null default now()
);

create unique index if not exists staff_conversation_participants_unique_idx
on staff_conversation_participants (conversation_id, staff_email);

create index if not exists staff_conversation_participants_email_idx
on staff_conversation_participants (staff_email);

create table if not exists staff_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references staff_conversations(id) on delete cascade,
  sender_email text not null,
  body text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists staff_messages_conversation_created_at_idx
on staff_messages (conversation_id, created_at desc);

create table if not exists staff_message_reads (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references staff_messages(id) on delete cascade,
  staff_email text not null,
  read_at timestamptz not null default now()
);

create unique index if not exists staff_message_reads_unique_idx
on staff_message_reads (message_id, staff_email);

create table if not exists staff_message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references staff_messages(id) on delete cascade,
  file_id text, -- office_files.id, when uploaded through the shared storage service
  file_url text not null,
  filename text,
  mime_type text,
  size_bytes integer,
  created_at timestamptz not null default now()
);

create index if not exists staff_message_attachments_message_idx
on staff_message_attachments (message_id);

-- ---------------------------------------------------------------
-- Content / Publishing (Phase 8, Office v2). Sanity remains the
-- canonical public content source of truth (project ap1ku6sf, dataset
-- production, schema sanity/schemas/post.ts in Ochiga-website) — this
-- table holds ONLY Office's local editorial workflow/audit metadata
-- (draft -> review -> approve -> publish), never a second copy of
-- public content. sanity_document_id links back to the real Sanity
-- document once one exists.
-- ---------------------------------------------------------------
create table if not exists office_content_items (
  id text primary key,
  title text not null,
  slug text,
  excerpt text,
  category text,
  author text,
  tags text[] not null default '{}'::text[],
  body text not null default '',
  featured_image_url text,
  seo_title text,
  seo_description text,
  workflow_status text not null default 'draft', -- draft | in_review | approved | scheduled | published | unpublished
  scheduled_publish_at timestamptz,
  sanity_document_id text,
  sanity_live_url text,
  created_by text not null,
  reviewed_by text,
  approved_by text,
  published_by text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists office_content_items_status_idx
on office_content_items (workflow_status, updated_at desc);

create index if not exists office_content_items_scheduled_idx
on office_content_items (scheduled_publish_at) where scheduled_publish_at is not null;
