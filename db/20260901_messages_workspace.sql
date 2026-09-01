-- Messages workspace (Office v2) — additive extension of the existing
-- Phase 5 staff-messaging model (staff_conversations/participants/
-- messages/reads/attachments, see 20260815_staff_messaging.sql). No
-- new parallel identity/messaging system: this only adds the per-
-- participant state (archive/mute/pin), reactions, and soft-delete
-- columns needed to reproduce the approved Messages UI on top of the
-- already-real, already-authorized conversation model.

-- Per-participant state — deliberately stored on the membership row
-- itself (not a new table) since it's always 1:1 with a participant,
-- and deliberately per-user (archiving/muting/pinning a conversation
-- must never affect what any other participant sees).
alter table staff_conversation_participants add column if not exists archived_at timestamptz;
alter table staff_conversation_participants add column if not exists muted_at timestamptz;
alter table staff_conversation_participants add column if not exists pinned_at timestamptz;

-- Soft-delete / tombstone for a sender's own message — never a hard
-- delete, so corporate communication history for every OTHER
-- participant is never destroyed by one person's action.
alter table staff_messages add column if not exists deleted_at timestamptz;
alter table staff_messages add column if not exists deleted_by text;

-- Real duration for voice-note attachments only (null for every other
-- attachment kind) — surfaced honestly in playback, never fabricated.
alter table staff_message_attachments add column if not exists duration_seconds integer;

create table if not exists staff_message_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references staff_messages(id) on delete cascade,
  staff_email text not null,
  emoji text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists staff_message_reactions_unique_idx
on staff_message_reactions (message_id, staff_email, emoji);

create index if not exists staff_message_reactions_message_idx
on staff_message_reactions (message_id);
