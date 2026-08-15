-- Staff messaging (Phase 5, Office v2). Deliberately separate from the
-- CRM lead/visitor `conversations` table (AI agent <-> public lead
-- chat) and from `notifications` — this is staff-to-staff only,
-- identified by admin_users.email.
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
  file_id text,
  file_url text not null,
  filename text,
  mime_type text,
  size_bytes integer,
  created_at timestamptz not null default now()
);

create index if not exists staff_message_attachments_message_idx
on staff_message_attachments (message_id);
