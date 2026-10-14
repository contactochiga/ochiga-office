-- Rollback: removes only the runtime-settings table. NOTE: Office code that includes the autonomy switch treats a missing table as OFF (fail closed).
drop table if exists office_runtime_settings;
