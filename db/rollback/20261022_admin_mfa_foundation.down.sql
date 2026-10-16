-- Rollback of S7.5.1 MFA data foundation. NON-DESTRUCTIVE BY DEFAULT: only the functions are removed. Tables, columns and every row are KEPT on purpose:
-- dropping credentials or recovery codes would silently downgrade protected accounts. The feature itself is switched off with LEAD_AGENTS_MFA=off (the default).
drop function if exists office_mfa_prune_challenges(interval);
drop function if exists office_mfa_reset(uuid, text);
drop function if exists office_mfa_clear_failures(uuid);
drop function if exists office_mfa_record_failure(uuid);
drop function if exists office_mfa_consume_challenge(uuid, uuid, text);
drop function if exists office_mfa_create_challenge(uuid, text, text, integer);
drop function if exists office_mfa_replace_recovery_codes(uuid, uuid, text[]);
drop function if exists office_mfa_replace_recovery_codes(uuid, uuid, text[], text);   -- the S7.5.3 form, if 20261023 was applied
drop function if exists office_mfa_consume_recovery_code(uuid, text);
drop function if exists office_mfa_consume_totp_step(uuid, bigint);
drop function if exists office_mfa_schema_version();

-- OPTIONAL, non-production only, and only when no account depends on MFA (this deletes every credential, recovery code and lock state):
-- drop table if exists admin_mfa_challenges;
-- drop table if exists admin_mfa_recovery_codes;
-- drop table if exists admin_mfa_credentials;
-- alter table admin_users drop column if exists mfa_reset_by, drop column if exists mfa_reset_at, drop column if exists mfa_locked_until, drop column if exists mfa_failed_attempts, drop column if exists mfa_required_after;
