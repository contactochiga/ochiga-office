-- Tier 2 rollback of db/20261113_whatsapp_sender_identities.sql. Requires separate, explicit approval. Run Tier 0 (capture OFF) first.
-- Moves the table out of use WITHOUT deleting anything: it is renamed (rows, constraints, indexes and RLS travel with it). Fails rather than overwrite an
-- existing archive. To restore: drop the (new, empty) whatsapp_sender_identities if the migration was re-applied, then rename the archive back.
begin;
do $$ begin
  if to_regclass('public.whatsapp_sender_identities_archive') is not null then raise exception 'whatsapp_sender_identities_archive already exists; nothing changed'; end if;
  if to_regclass('public.whatsapp_sender_identities') is null then raise exception 'whatsapp_sender_identities does not exist; nothing changed'; end if;
end $$;
alter table whatsapp_sender_identities rename to whatsapp_sender_identities_archive;
alter index if exists uq_whatsapp_sender_identities_user rename to uq_whatsapp_sender_identities_archive_user;
alter index if exists uq_whatsapp_sender_identities_lead rename to uq_whatsapp_sender_identities_archive_lead;
alter index if exists whatsapp_sender_identities_conflicts_idx rename to whatsapp_sender_identities_archive_conflicts_idx;
-- index names are schema-wide: rename the primary-key and pair-key indexes too, so the migration can be re-applied next to the archive
alter index if exists whatsapp_sender_identities_pkey rename to whatsapp_sender_identities_archive_pkey;
alter index if exists whatsapp_sender_identities_pair_key rename to whatsapp_sender_identities_archive_pair_key;
commit;
