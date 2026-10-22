-- Rollback of R9 mailbox attempt budget. The counters are ephemeral (they expire with the enrolment challenge, at most 15 minutes), so dropping them loses no durable record. The application
-- then falls back to the account-level MFA failure lock and the shared limiter, and /healthz reports mfa.mailbox_attempts = unavailable.
drop function if exists office_mfa_mailbox_verified(uuid, text);
drop function if exists office_mfa_mailbox_attempt(uuid, text, timestamptz, integer);
drop function if exists office_mfa_mailbox_version();
drop table if exists admin_mfa_mailbox_attempts;
