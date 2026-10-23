-- Rollback of Settings S3 versioning. NON-DESTRUCTIVE (R10): only the write/attempt functions are removed, so Office reports versioning unavailable and refuses setting writes (fail closed).
-- The append-only HISTORY of policy changes (office_runtime_setting_history), its immutability trigger and function, and the version column/constraint are KEPT on purpose: that table is the
-- evidence of who changed MFA enforcement, session duration and the WhatsApp autonomy switch, and dropping it would erase it silently. Re-applying 20261019 is idempotent and resumes versioning.
-- OPTIONAL, non-production only, when the history is to be discarded deliberately:
--   drop trigger if exists office_runtime_setting_history_no_change on office_runtime_setting_history; drop table if exists office_runtime_setting_history; drop function if exists office_runtime_setting_history_immutable();
drop function if exists office_runtime_setting_record_attempt(text, text, text, text, text, jsonb, boolean);
drop function if exists office_runtime_setting_write(text, jsonb, text, integer, text, boolean, boolean);
