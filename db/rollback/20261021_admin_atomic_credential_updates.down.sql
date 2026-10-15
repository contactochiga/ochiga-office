-- Rollback of S7.5.0 atomic credential updates: drops only the function. No data changes; the application falls back to the two-step path (which password binding keeps safe).
drop function if exists office_admin_update_revoking_sessions(uuid, text, text, timestamptz, text, boolean, timestamptz, text);
