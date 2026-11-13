-- Rollback of db/20261113_whatsapp_sender_identities.sql -- NON-DESTRUCTIVE, TIERED. Nothing in this file changes data or schema.
--
-- Tier 0 (immediate): set OFFICE_WHATSAPP_SENDER_ID_CAPTURE_ENABLED=false and restart Office. Capture stops; recorded links and conflicts stay.
-- Tier 1 (application rollback): redeploy the previous Office build. The table and its rows are KEPT; the previous build never reads it. No SQL is needed.
-- Tier 2 (remove the table from use): ONLY with separate approval, run db/rollback/20261113_whatsapp_sender_identities.tier2_archive.sql, which RENAMES the
--   table to whatsapp_sender_identities_archive (no row is deleted). Re-applying the migration creates a new empty table; restoring is renaming back.
--
-- Read-only check to run before deciding (a single SELECT; safe on production):
select
  count(*) filter (where state = 'linked') as linked,
  count(*) filter (where state = 'conflict') as conflicts
from whatsapp_sender_identities;
