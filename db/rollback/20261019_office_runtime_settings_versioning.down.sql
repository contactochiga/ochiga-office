-- Rollback of Settings S3 versioning: existing keys/values in office_runtime_settings are untouched; version numbers and the history table are removed by design.
drop function if exists office_runtime_setting_record_attempt(text, text, text, text, text, jsonb, boolean);
drop function if exists office_runtime_setting_write(text, jsonb, text, integer, text, boolean, boolean);
drop trigger if exists office_runtime_setting_history_no_change on office_runtime_setting_history;
drop table if exists office_runtime_setting_history;
drop function if exists office_runtime_setting_history_immutable();
alter table office_runtime_settings drop constraint if exists office_runtime_settings_version_check;
alter table office_runtime_settings drop column if exists version;
