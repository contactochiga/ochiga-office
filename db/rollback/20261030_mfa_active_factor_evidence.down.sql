-- Rollback of R9 factor evidence. NON-DESTRUCTIVE: the trigger and functions are removed; the column (mfa_active_count) is KEPT on purpose -- dropping it would discard evidence and a later
-- re-apply recomputes it anyway. While the trigger is absent the column goes stale, but nothing reads it once the capability probe (office_mfa_evidence_version) is gone: the application
-- falls back to reading the credential list alone (the pre-R9 behaviour) and /healthz reports mfa.evidence = unavailable.
drop trigger if exists admin_mfa_credentials_active_count on admin_mfa_credentials;
drop function if exists office_mfa_active_count_trigger();
drop function if exists office_mfa_sync_active_count(uuid);
drop function if exists office_mfa_evidence_version();
