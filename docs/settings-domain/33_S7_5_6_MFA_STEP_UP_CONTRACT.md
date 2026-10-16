# S7.5.6 — MFA-protected step-up authentication: frozen contract

Branch `feature/settings-s1-s2`, starting HEAD `0f80ef5` (local = remote, clean verified). Extends the S7.2 step-up (`step-up.js`, `POST /session/step-up`) with a verified second factor for **all three** protected purposes. Reuses the S7.5.3 login verification, the S7.5.4 TOTP step-replay protection and the S7.5.5 WebAuthn assertion check unchanged. No new authentication system, no new route, no new migration, no new secret.

## 1. Protected purposes
`security_policy_write`, `session_revocation`, `mfa_management` (S7.2's closed list). A grant names exactly one purpose; verification compares it to the purpose the endpoint requires, so a grant for one never authorizes another. Eligibility is unchanged: `mfa_management` is open to any signed-in human for their own factors; the other two need `super_admin` + `team.manage`, re-checked from live account state on every use.

## 2. Factor requirements
| Account state | Requirement for a grant |
|---|---|
| MFA mode off (default), or no active factor | current password only (S7.2 behaviour, unchanged) |
| MFA mode on **and** an active factor | current password **and** a fresh verified second factor |
A fresh second factor is either (a) `mfa:{method:"totp", code}`, (b) `mfa:{method:"webauthn", challenge_id, response}` (single-use challenge from `/session/mfa/webauthn/step-up-options`), or (c) the current session's own sign-in MFA proof when it is at most 5 minutes old (proof timestamp is in the signed session token, not client supplied). **Recovery codes are not accepted** as a step-up factor (a recovery code is a sign-in recovery path only; accepting it here needs separate approval). Replay protection is the existing atomic TOTP-step compare-and-set and the single-use challenge plus WebAuthn counter compare-and-set. Wrong factor, wrong password, and "factor missing" give the same 401 body (no oracle). Failures count toward the persisted MFA lock (5→1 min, 10→15 min, 20→60 min); the lock is checked before the password.

## 3. Grant claims and session binding
`v, purpose, sub, email, sg` (session generation), `sid` (keyed current-session fingerprint), `pwf` (keyed password-state fingerprint), `iat, exp, jti`, and, when a second factor was verified, `mf:true` and `mfat` (epoch ms of that verification, never later than `iat`). Signed with the purpose-separated step-up key. Maximum lifetime 10 minutes and never beyond the session's own expiry. Rejected: forged or tampered, expired, wrong purpose, wrong administrator, other session, revoked session (generation), changed password, removed permission or deactivated account, API key or edge token.

## 4. Enforcement at use
Every consumer re-checks, in addition to S7.2 verification: when MFA mode is on and the account **currently** has an active factor, the grant must carry `mf:true` with a valid `mfat`; otherwise `403 step_up_required` with reason `mfa_required`. A password-only grant issued before enrollment therefore stops working the moment a factor exists (enrollment also bumps the session generation). If the factor state cannot be read, the use fails closed (`503`).

## 5. Authorization
A valid factor adds no permission: the role and `team.manage` checks of each endpoint still run on live state. API keys and edge tokens are refused at issuance and at use. MFA configuration unavailable (key missing/invalid) with an enrolled account: issuance fails closed (503), never falls back to password-only.

## 6. Recovery
Lost factor → the S7.5.3 recovery-code sign-in (which carries a fresh MFA proof for 5 minutes and revokes other sessions) → step-up through criterion (c). No other bypass; no administrator override in this slice.

## 7. Audit
`step_up_verified` / `step_up_failed` with `purpose`, `outcome`, `failure_reason` (`invalid_password`, `second_factor_required`, `invalid_second_factor`, `mfa_locked`, `api_key_not_allowed`, `forbidden`, `rate_limited`, `invalid_purpose`) and, on success, `second_factor` (`totp`|`webauthn`|`session_proof`|`none`). Use-time refusals are audited by the endpoint. Never recorded: passwords, codes, assertions, tokens, keys.

## 8. Compatibility
No schema change. Default (`LEAD_AGENTS_MFA` off): byte-for-byte S7.2 behaviour. Ordinary login is untouched. Mandatory MFA is not enabled by anything here. Clients that send no `mfa` object keep working for accounts without a factor. Mixed-version fleet: an older instance issues password-only grants, which a newer instance refuses for enrolled accounts (safe direction).

## 9. Required tests
Correct password+MFA (TOTP, WebAuthn, session proof) for each purpose; wrong password; wrong factor; expired/stale proof; replayed TOTP; replayed WebAuthn assertion; recovery code refused; wrong purpose; wrong session; wrong administrator; revoked session; changed password; removed permission; password-only grant after enrollment; database outage; key unavailable; API-key refusal; redaction; compatibility without MFA; real Postgres/PostgREST end to end.

## 10. Implementation notes (as built)
- `step-up.js`: grants carry `mf:true` + `mfat`; verification returns `mf`/`mfAt` only when `mfat` is a positive time not after `iat`; `grantSatisfiesMfa` is the single use-time rule.
- `server.js`: `POST /session/step-up` now applies the second-factor requirement to all three purposes (it previously did so for `mfa_management` only); an enrolled account with an unusable MFA configuration gets `503 mfa_unavailable` (no password-only fallback). `requireStepUp` (policy writes via `/session/step-up/check`) and the user-session-revocation endpoint re-check at use through `stepUpMfaGate` (fails closed with 503 if the factor state cannot be read). Responses add `mfa_verified` and `second_factor`.
- Defence in depth: since S7.5.3 a password-only *session* of an enrolled account is already ended by `enrichAuthContext`; the use-time gate covers the remaining case of a session with an MFA proof presenting a grant earned before the factor existed.
- Tests: `test-mfa-stepup-s756.js` (126 assertions, API) and `test-mfa-stepup-postgres-s756.js` (real Postgres 17 + PostgREST, two server instances).
- Known limitations: the sign-in proof (≤5 min) counts as the fresh factor, so a user who just signed in is not prompted again; recovery codes are intentionally not accepted (sign in with one, then step up through the proof); no UI changes; no administrator override for a locked-out account; `security_policy_write` has no consumer endpoint yet beyond `/session/step-up/check` (later slices attach to `requireStepUp`); mixed-version fleets are safe in one direction only (older instances may still issue password-only grants, which newer instances refuse for enrolled accounts).
