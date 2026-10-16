-- Rollback of R4 current-session revocation. NON-DESTRUCTIVE: only the functions are removed. The table and every revoked-session record are KEPT on purpose:
-- dropping them would silently bring back sessions that people logged out of. Tokens carrying `sid` then stop being checked by instances without the code path, so before rolling
-- code back set LEAD_AGENTS_SESSION_REVOCATION behaviour knowingly, or rotate the session secret to end every session.
drop function if exists office_is_session_revoked(text);
drop function if exists office_revoke_session(text, uuid, timestamptz);
drop function if exists office_session_revocation_version();
