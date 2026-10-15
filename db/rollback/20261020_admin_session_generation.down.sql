-- Rollback of Settings S7.4 session revocation. NON-DESTRUCTIVE BY DEFAULT: only the function is removed. The columns are KEPT on purpose.
-- Dropping session_generation resets every account to generation 0 and would RESURRECT every session that was revoked while it existed (tokens issued at generation 0).
-- To disable the feature, set LEAD_AGENTS_SESSION_REVOCATION=off in the Office environment instead of dropping schema.
drop function if exists office_revoke_admin_sessions(uuid, text, text);

-- OPTIONAL, non-production only, and only after every outstanding session has expired or the session secret has been rotated:
-- alter table admin_users drop constraint if exists admin_users_session_generation_check;
-- alter table admin_users drop column if exists sessions_revoked_by;
-- alter table admin_users drop column if exists sessions_revoked_at;
-- alter table admin_users drop column if exists session_generation;
