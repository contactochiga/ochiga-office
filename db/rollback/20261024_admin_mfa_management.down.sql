-- Rollback of S7.5.4 MFA management. NON-DESTRUCTIVE: functions are dropped; every credential, recovery code and account is kept.
-- The single "one pending-or-active TOTP" index of S7.5.1 can only be restored if no account has both, so any pending TOTP of an account that also has an active one is REVOKED first.
drop function if exists office_mfa_webauthn_record_use(uuid, uuid, bigint);   -- S7.5.5, if present
drop function if exists office_mfa_webauthn_version();
drop function if exists office_mfa_consume_recovery_code_revoking(uuid, text, text);
drop function if exists office_mfa_revoke_credential(uuid, uuid, text, text, boolean);
drop function if exists office_mfa_activate_credential(uuid, uuid, text, uuid, bigint, text[], text);
drop function if exists office_mfa_management_version();
update admin_mfa_credentials p set status = 'revoked', revoked_at = now(), revoked_by = 'rollback', revoked_reason = 'rollback_20261024'
 where p.type = 'totp' and p.status = 'pending' and exists (select 1 from admin_mfa_credentials a where a.admin_user_id = p.admin_user_id and a.type = 'totp' and a.status = 'active');
drop index if exists admin_mfa_one_pending_totp_per_user;
drop index if exists admin_mfa_one_active_totp_per_user;
do $$
begin   -- R10: the stricter pre-S7.5.4 index is restored only when current data satisfies it (an account mid-replacement has an active AND a pending TOTP); otherwise it is skipped, never an error
  if exists (select 1 from admin_mfa_credentials where type = 'totp' and status in ('pending', 'active') group by admin_user_id having count(*) > 1) then
    raise notice 'admin_mfa_one_totp_per_user not restored: an account has more than one pending/active TOTP';
  else
    create unique index if not exists admin_mfa_one_totp_per_user on admin_mfa_credentials (admin_user_id) where type = 'totp' and status in ('pending', 'active');
  end if;
end $$;
