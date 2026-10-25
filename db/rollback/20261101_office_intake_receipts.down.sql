-- Rollback of 20261101_office_intake_receipts. NON-DESTRUCTIVE: only the functions are removed, so Office falls back to the Phase 0 behaviour
-- (retries recognised through the intake timeline; no atomic claim). The receipts table is KEPT: it is the record of which website
-- submissions were filed or still need their CRM write retried. No lead, CRM record or timeline event is touched.
-- OPTIONAL, only once every 'crm_failed' row has been reviewed:  drop table if exists office_intake_receipts;
drop function if exists office_intake_fail(text, integer, uuid, text);
drop function if exists office_intake_complete(text, integer, uuid);
drop function if exists office_intake_claim(text, text, text, text, integer);
drop function if exists office_intake_receipts_version();
