-- Rollback of S7.5.4 MFA management. NON-DESTRUCTIVE: functions are dropped; every credential, recovery code and account is kept.
-- The single "one pending-or-active TOTP" index of S7.5.1 can only be restored if no account has both, so any pending TOTP of an account that also has an active one is REVOKED first.
drop function if exists office_mfa_consume_recovery_code_revoking(uuid, text, text);
drop function if exists office_mfa_revoke_credential(uuid, uuid, text, text, boolean);
drop function if exists office_mfa_activate_credential(uuid, uuid, text, uuid, bigint, text[], text);
drop function if exists office_mfa_management_version();
update admin_mfa_credentials p set status = 'revoked', revoked_at = now(), revoked_by = 'rollback', revoked_reason = 'rollback_20261024'
 where p.type = 'totp' and p.status = 'pending' and exists (select 1 from admin_mfa_credentials a where a.admin_user_id = p.admin_user_id and a.type = 'totp' and a.status = 'active');
drop index if exists admin_mfa_one_pending_totp_per_user;
drop index if exists admin_mfa_one_active_totp_per_user;
create unique index if not exists admin_mfa_one_totp_per_user on admin_mfa_credentials (admin_user_id) where type = 'totp' and status in ('pending', 'active');
