# S7.5.4 — MFA enrollment and recovery management: frozen contract

Branch `feature/settings-s1-s2`, starting HEAD `2d995d9` (local = remote, clean worktree verified). Extends S7.5.1 (data), S7.5.2 (crypto), S7.5.3 (login challenge/verification) and the S7.0–S7.5.0 authentication system; **no second authentication system** is introduced. Out of scope: WebAuthn/passkeys (S7.5.5), the general step-up MFA leg for other purposes (S7.5.6), enforcement stages, administrator reset and owner reset (S7.5.7), UI, merging, deploying, production migration, S7.5.5. MFA stays off by default: every route below answers `503 mfa_unavailable` unless `LEAD_AGENTS_MFA=on` with a valid key configuration **and** the S7.5.4 schema.

## 1. Enrollment authorization
| Path | Who | Required proof |
|---|---|---|
| Voluntary enrollment, first factor | authenticated **human** session (never API key or edge token) | step-up grant, purpose `mfa_management`, password only (no factor exists yet) |
| Replace / remove a factor, regenerate recovery codes | same | step-up grant `mfa_management` carrying a **fresh second factor** (TOTP or recovery code) in addition to the password |
| Forced enrollment (a login challenge of purpose `enroll`, issued by a future enforcement stage; nothing issues one in this slice) | holder of that challenge | the **mailbox gate**: a one-time code e-mailed to the account address (8 digits derived from the challenge, valid with it, brute-force limited by the shared limiter and the persisted failure counter) exchanged for an `enroll_verified` token |
Every grant, challenge and token is bound to the account id, password fingerprint and session generation (and, for sessions/grants, the session itself); a password change, revocation or deactivation kills it. API keys/edge tokens get `403 actor_identity_required` on every MFA route. **No session is ever created from an enrollment challenge** (forced enrollment ends with "sign in again").

## 2. Credential lifecycle
`pending → active → revoked`. At most **one active and one pending** TOTP per account (additive migration replaces the S7.5.1 "one pending-or-active" index by two partial unique indexes). Begin creates a pending credential (encrypted with the credential id as authenticated metadata, 15-minute life; any earlier pending credential of the account is revoked first) and returns the secret **once** (Base32 + `otpauth` URI) in that response only; the secret is never retrievable again. Confirm verifies a code against the pending secret **without consuming it, then activates in one atomic database step** that also stores the code's step as used (the confirmation code cannot be replayed at login).

## 3. Atomic database operations (migration `20261024_admin_mfa_management.sql`, service role only)
- `office_mfa_activate_credential`: lock the account; revoke the credential being replaced (must be the account's active TOTP) **before** activating the pending one (must be pending, same account); optionally store the first recovery-code batch; record the used step; **bump `session_generation`** — all in one transaction; any failed precondition rolls back everything.
- `office_mfa_revoke_credential`: revoke a pending/active credential; if it was the last active factor and the caller asks to keep one, refuse and roll back; when no active factor remains delete the account's unused recovery codes; bump the generation when an active factor was removed.
- `office_mfa_consume_recovery_code_revoking`: consume one recovery code **and** bump the generation in one statement (see §7).
- `office_mfa_management_version()`: capability probe. Rollback is non-destructive (functions dropped, data kept; pending TOTPs revoked so the old single-credential index can be restored).
File store: the same state machines with persist-rollback.

## 4. Recovery codes
Ten codes of 50 bits, `XXXXX-XXXXX`, generated from secure randomness when the **first** factor activates (same transaction as activation) and on regeneration; shown **once** in that response; stored only as keyed hashes with the key id. Regeneration (step-up with a fresh factor) replaces the unused batch atomically (`office_mfa_replace_recovery_codes`), requires an active factor, and does not change the session generation. Codes never enter logs, audit records or notification e-mails.

## 5. Factor management
`GET /session/mfa` (status; sanitised factors, remaining codes, MFA mode/required flag), `POST /session/mfa/enroll/totp/begin|confirm` (first factor or replacement), `POST /session/mfa/credentials/:id/remove`, `POST /session/mfa/recovery-codes/regenerate`. "Add a factor": a second TOTP is refused (duplicate); further factor types arrive with S7.5.5. **Last-factor guard:** removal of the last active factor is refused when MFA is *required* for the account. Enforcement itself does not exist yet, so the guard reads a seam, `LEAD_AGENTS_MFA_REQUIRED_ROLES` (comma list, default empty = nobody), that affects **only** this refusal and nothing at sign-in.

## 6. Session invalidation
| Event | Other sessions | This browser | Step-up grants |
|---|---|---|---|
| first factor activated | end (generation bump) | re-issued with `mf=1` | die |
| factor replaced | end | re-issued with `mf=1` | die |
| factor removed | end | re-issued (`mf=1` if a factor remains, otherwise password-only) | die |
| recovery codes regenerated | unchanged | unchanged | unchanged |
| recovery code used at sign-in | end (atomic with consumption) | new session | die |
| forced enrollment completed | end | none (sign in again) | die |

## 7. Recovery-code transaction safety (S7.5.3 gap)
S7.5.3 consumed the code and bumped the generation in two steps; a failure between them burned the code with no session and no explanation. S7.5.4 uses `office_mfa_consume_recovery_code_revoking`: consumption and revocation succeed or fail **together**, exactly one concurrent caller wins, and the audit record `mfa_recovery_code_used` is written **before** the session is issued. If issuing the session then fails (database outage), the response is `503`, the code is spent **and the account owner is told** (audit + notification), and every other session is already ended — a consistent, explained state, not a partial one. Before the migration the previous two-step path remains (documented, tested).

## 8. Notifications (existing infrastructure: `sendOfficeEmail`)
Events: `enrolled`, `factor_replaced`, `factor_removed`, `recovery_codes_regenerated`, `recovery_code_used`, and the mailbox gate code itself. Plain-language, no secrets (no codes, secrets, tokens, hashes), generic wording. Delivery never blocks or fails the operation. The truthful outcome is recorded in an audit event `mfa_notification` (`event`, `delivery`, request id): `sent`, `not_configured` (provider absent), `no_recipient`, or `failed` (provider error, message only as a category).

## 9. Audit
`mfa_enrollment_started`, `mfa_enrolled`, `mfa_factor_replaced`, `mfa_factor_removed`, `mfa_recovery_codes_regenerated`, `mfa_enrollment_failed` (wrong code, expired, duplicate), `mfa_management_denied` (reason categories: `api_key_not_allowed`, `step_up_required`, `mfa_unavailable`, `last_factor`), `mfa_notification`: actor, target, request id, outcome, timestamps; never secrets, codes or tokens.

## 10. Failure behaviour and rollback
Any store/crypto/database fault ⇒ 503 and **no state change reported as success** (atomic operations; begin leaves at most a pending credential that expires and is superseded). Rollback: `LEAD_AGENTS_MFA=off` (routes unavailable; enrolled accounts then sign in password-only — the declared S7.5.3 downgrade), or the non-destructive down migration. Mixed fleets: instances without this code do not expose the routes.

## 11. Required tests
Unauthorized and API-key/edge-token refusal; pending-credential replay and wrong/expired/duplicate confirmation; atomic activation under concurrent confirms; first-enrollment codes (once, hashed, key id); regeneration (atomic replacement, old batch dead, step-up with fresh factor); concurrent recovery-code use and the atomic consume+revoke (failure injection after consumption); factor replacement, removal, last-factor guard, session invalidation and re-issue; password change mid-enrollment; forced enrollment with the mailbox gate (wrong code, expiry, replay, no session); step-up MFA leg for `mfa_management`; notifications (sent, not configured, provider failure, content has no secrets, status recorded truthfully); database outages; redaction across responses, audit, logs and e-mails; account recovery (lost device → recovery code → replace); migration idempotence/rollback on disposable databases and the full flow through PostgREST. Regressions: S7.0–S7.5.3, Postgres suites, Team permissions, WhatsApp autonomy, full suite, gates.
