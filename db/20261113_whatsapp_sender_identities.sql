-- WhatsApp sender identity, Phase 1: associates Meta's business-scoped user ID (BSUID) with the lead that the EXISTING phone-based matching already chose.
-- Nothing here changes lead matching, replies, recipients, goals or opt-outs; leads and every phone field are untouched (a BSUID is never a phone number).
--   * scope: Meta documents a BSUID as "unique to each business portfolio-user pair" (not global). The portfolio id is not in the webhook, so uniqueness is
--     scoped to the WhatsApp Business Account id from the webhook (entry[].id), which belongs to exactly one portfolio -- never looser than Meta's scope.
--   * at most ONE linked lead per (business account, BSUID) and at most ONE linked BSUID per (business account, lead): two PARTIAL unique indexes, so writers use
--     a plain INSERT and treat 23505 as "someone else linked first" (ON CONFLICT cannot target a partial index: 42P10).
--   * a conflicting association is never merged, overwritten or reassigned: it is recorded as state 'conflict' (one row per business account + BSUID + lead,
--     enforced by a full unique constraint) for human review.
-- Additive: one new table. Existing tables, RLS, policies and grants are not changed. Rollback is non-destructive: db/rollback/20261113_whatsapp_sender_identities.down.sql.
-- Do not apply to production without migration approval.
do $$ begin
  if to_regclass('public.leads') is null then raise exception 'leads (db/lead-agents-schema.sql) is required'; end if;
end $$;

create table if not exists whatsapp_sender_identities (
  id uuid primary key default gen_random_uuid(),
  business_account_id text not null,                          -- Meta WhatsApp Business Account id (webhook entry[].id): the uniqueness scope
  business_scoped_user_id text not null,                      -- Meta BSUID, e.g. "US.13491208655302741918" (opaque; never normalized as a phone)
  lead_id uuid not null references leads(id) on delete cascade,
  state text not null,
  conflict_reason text,
  conflicting_lead_id uuid references leads(id) on delete set null,
  provider_message_id text,                                   -- the message that created this row (evidence)
  first_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_sender_identities_state_chk check (state in ('linked', 'conflict')),
  constraint whatsapp_sender_identities_conflict_chk check (
    (state = 'linked' and conflict_reason is null and conflicting_lead_id is null)
    -- "is not null" is required: a CHECK whose expression is NULL passes, and "NULL in (...)" is NULL
    or (state = 'conflict' and conflict_reason is not null and conflict_reason in ('user_id_linked_to_other_lead', 'lead_linked_to_other_user_id'))),
  constraint whatsapp_sender_identities_bsuid_format_chk check (business_scoped_user_id ~ '^[A-Z]{2}\.[A-Za-z0-9]{1,128}$'),
  constraint whatsapp_sender_identities_account_chk check (business_account_id ~ '^[0-9]{1,32}$'),
  constraint whatsapp_sender_identities_pair_key unique (business_account_id, business_scoped_user_id, lead_id)
);

create unique index if not exists uq_whatsapp_sender_identities_user on whatsapp_sender_identities (business_account_id, business_scoped_user_id) where state = 'linked';
create unique index if not exists uq_whatsapp_sender_identities_lead on whatsapp_sender_identities (business_account_id, lead_id) where state = 'linked';
create index if not exists whatsapp_sender_identities_conflicts_idx on whatsapp_sender_identities (created_at desc) where state = 'conflict';

-- server-only like every other Office table (a NEW table; nothing existing is changed)
alter table whatsapp_sender_identities enable row level security;
