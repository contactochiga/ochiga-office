# S7.5 — MFA architecture and recovery design (for approval)

Branch `feature/settings-s1-s2`, designed from verified HEAD `5f0ee65` (local = remote, clean worktree). **Design only**: no MFA code, runtime change, migration, merge, deployment or production action. Companion document: `26_S7_4_OUTSTANDING_PRODUCTION_CONCERNS.md` (C1–C5; C2 and C5 are preconditions for enforcement).

## 1. What must be preserved, and the authentication surface today

| Slice | Preserved property | MFA consequence |
|---|---|---|
| S7.0 | Dedicated session secret and readiness; API-key-as-password off by default; env-gated admin recovery; 7-day login limiter | MFA key gets the same readiness treatment; the fallback must be off before MFA (§12); recovery is extended, never widened |
| S7.1 | Server-enforced password policy | unchanged; MFA is an additional factor, never a substitute for a weak password |
| S7.2 | Password step-up, grants bound to identity, session, purpose, password state | step-up gains an MFA leg for MFA-protected purposes (§9) |
| S7.3 | Duration setting (1–720 h), cookie `Max-Age` = token `exp` | unchanged; MFA adds claims, not lifetime |
| S7.4 | `session_generation` revocation, `sg` claim, fail-closed verification | MFA changes bump the generation; the same verification function must enforce MFA state |

**Inventory of every place a credential is accepted or a session is issued** (an S7.4 test found `/session/me` verifying cookies on its own; MFA must not add a third copy of that mistake):
- Sessions issued by: `login`, `invite/accept`, self password change re-issue, `revoke-all keep_current`. Cookies verified by: `enforceAuth→enrichAuthContext` (all non-public routes) and `GET /admin/session/me` (own copy). Step-up grants verified by `verifyStepUpToken` (settings writes, revocation, `/step-up/check`).
- Non-session credentials: shared API keys (`authorizePermission` passes **every** permission), edge-agent tokens (`tryEdgeAuth`), the transitional API-key-as-password login, env bootstrap and env recovery, Backend bridge keys.
- Password-only operations: `reset/confirm` (issues no session), password change, admin password set.

**Requirement R0 (prerequisite, S7.5.0):** one `verifySession()` used by every route including `/session/me`, which will carry the generation, account-id, password-fingerprint (concerns C2) and MFA checks. An "auth surface inventory" test enumerates every handler that reads the cookie and fails when a new one appears outside that function.

## 2. Goals and threat model

Goals: a stolen or guessed password, or an intercepted reset email, must not yield a session for an enrolled account; losing a device must never permanently lock out an administrator; every recovery path is slower, more audited and more notified than the login it replaces; nothing in the legacy paths (§12) quietly bypasses the second factor.

Adversaries considered: phisher/credential-stuffer (password only); cookie thief (session only); attacker with password **and** mailbox; attacker with an API key; malicious or coerced administrator; deployment-environment access (assumed to own the system already, same as S7.0's recovery argument); database-read access (must not reveal usable factors).
Out of scope: SMS/voice/email OTP as a *factor* (rejected: SIM swap, mailbox reuse), push approval apps, passwordless/passkey-primary sign-in, device-trust cookies ("remember this device" — rejected for S7.5; it reintroduces a long-lived bearer that bypasses the factor).

## 3. Architecture overview

Login becomes two steps **without ever creating a half-authenticated session**:
1. `POST /admin/session/login` verifies email + password exactly as today (same 401 for every failure, same limiter). If the account needs MFA it answers `200 {mfa_required:true, challenge_token, methods}` (no cookie) — or `{mfa_enrollment_required:true, challenge_token}` when policy requires MFA and none is enrolled.
2. `POST /admin/session/mfa/verify` accepts the challenge plus a TOTP code, a WebAuthn assertion or a recovery code, then issues the session through the existing `issueSession` (S7.3 duration, S7.4 generation) with two new claims: `mf` (1 when MFA was verified) and `mft` (when). Cookie format, flags and signature scheme are unchanged.

The **challenge token** is signed with a key derived for this purpose only (`HMAC(sessionSecret, "ochiga-office/mfa-challenge/v1")`, as step-up does), lasts 5 minutes, and is bound to user id, password-hash fingerprint, current `session_generation` and purpose (`login` or `enroll`). It grants nothing by itself. A password change, reset, revocation or deactivation during the window kills it. Replay of a spent challenge is harmless (a valid second factor is still required, and TOTP/recovery use is single-use).

Because attempts cannot be counted in a stateless token, **failure counting is persisted per account** (§18).

## 4. Factors

### 4.1 TOTP (RFC 6238)
SHA-1, 6 digits, 30 s (maximum authenticator-app compatibility), 160-bit random secret (Base32, shown once, `otpauth://` URI with issuer "Ochiga Office" and the email as label), verification window ±1 step. **Replay protection:** each credential stores `totp_last_step`; acceptance is an atomic compare-and-set that only succeeds for a step strictly greater than the stored one, so a code (or a shoulder-surfed code) works once. Pending credentials are confirmed with a valid code before activation.

### 4.2 WebAuthn / passkeys (second factor, user verification required)
Registration and authentication ceremonies via a maintained server library (decision D-5: `@simplewebauthn/server`, MIT; hand-rolling CBOR/COSE/attestation is rejected). Attestation `none`; `userVerification: required`; resident keys allowed but not required; at most 10 credentials per account; `excludeCredentials` prevents duplicate registration. Server-side **single-use challenges** (32 random bytes, 5-minute expiry, consumed atomically) in a table. Verified: origin, RP ID hash, ceremony type, UP+UV flags, signature, and sign counter (reject if stored counter > 0 and the new one is not greater; synced passkeys report 0 and are accepted). RP ID and allowed origins are explicit configuration; **the RP ID is permanent** — credentials are bound to it, so the production domain must be fixed before anyone enrolls (D-4).

### 4.3 Recovery codes
10 single-use codes per batch, 10 characters of Crockford Base32 (50 bits each, shown as `XXXXX-XXXXX`), displayed **once** with a forced acknowledgement. Stored only as `HMAC-SHA256(pepper, normalised code)` (pepper derived from the MFA master key with HKDF label `recovery-code`; high-entropy codes make a slow KDF unnecessary and a keyed hash makes a stolen table useless). Consumption is an atomic `used_at is null → set` returning the row. Regenerating issues a new batch and invalidates the old one. Using a code: the sign-in succeeds, the **generation is bumped** (a lost-device signal ends every other session), the user is e-mailed, the remaining count is returned, and the UI pushes enrolment of a replacement factor.

## 5. Credential storage and security boundaries

- **TOTP secrets must be recoverable, so they are encrypted, not hashed:** AES-256-GCM, random 12-byte nonce, AAD = credential id ‖ user id ‖ key id, ciphertext + nonce + `key_id` stored in the row. Master key `LEAD_AGENTS_MFA_KEY` (32 random bytes, Base64) held in the deployment secret store (Render, `sync:false`), **never in the database** and **never derived from the session secret** — rotating the session secret is the S7.4 break-glass and must not brick MFA. `LEAD_AGENTS_MFA_KEY_ID` names the current key; `LEAD_AGENTS_MFA_KEYS_PREVIOUS` lists retired keys so rotation is a re-encrypt job, not an outage.
- A database read alone yields ciphertext, public keys and HMACs; an environment read alone yields no data. Both together are the "deployment environment access" case already treated as total compromise.
- WebAuthn stores only credential id, public key, counter, transports, AAGUID, backup flags — nothing secret.
- **Fail closed:** MFA enabled but key missing/short/invalid ⇒ `/healthz` 503 with `auth_config.mfa_key: invalid` (problem codes only, as for the session secret) and enrolled accounts cannot sign in; it never degrades to password-only.
- No secret, code, challenge, assertion or recovery code is ever logged or audited; audit stores ids, outcome categories and counts.
- All MFA tables: RLS on, no policies, no Data API privileges, service role only; mutations through SQL functions (§6.2), the S3/S7.4 pattern.

## 6. Schema (additive; nothing applied here)

### 6.1 Tables
```sql
-- admin_users additions (all nullable/defaulted: existing accounts unchanged)
alter table admin_users add column mfa_required_after timestamptz;     -- per-account grace deadline (set when enforcement is raised)
alter table admin_users add column mfa_failed_attempts integer not null default 0 check (mfa_failed_attempts >= 0);
alter table admin_users add column mfa_locked_until timestamptz;
alter table admin_users add column mfa_reset_at timestamptz;
alter table admin_users add column mfa_reset_by text;

create table admin_mfa_credentials (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references admin_users(id) on delete cascade,
  type text not null check (type in ('totp','webauthn')),
  label text not null,                                   -- user-chosen device name, never a secret
  status text not null default 'pending' check (status in ('pending','active','revoked')),
  secret_ciphertext text, secret_nonce text, secret_key_id text, totp_last_step bigint not null default 0,         -- totp
  webauthn_credential_id bytea unique, webauthn_public_key bytea, webauthn_sign_count bigint, webauthn_transports text[],
  webauthn_aaguid uuid, webauthn_backup_eligible boolean,                                                           -- webauthn
  created_at timestamptz not null default now(), activated_at timestamptz, last_used_at timestamptz,
  revoked_at timestamptz, revoked_by text, revoked_reason text,
  check ((type = 'totp' and secret_ciphertext is not null) or (type = 'webauthn' and webauthn_credential_id is not null))
);
create unique index on admin_mfa_credentials (admin_user_id) where type = 'totp' and status in ('pending','active');   -- one TOTP at a time

create table admin_mfa_recovery_codes (
  id uuid primary key default gen_random_uuid(), admin_user_id uuid not null references admin_users(id) on delete cascade,
  batch_id uuid not null, code_hmac text not null unique, created_at timestamptz not null default now(), used_at timestamptz
);
create table admin_mfa_challenges (        -- WebAuthn ceremonies only; single use
  id uuid primary key default gen_random_uuid(), admin_user_id uuid not null references admin_users(id) on delete cascade,
  purpose text not null check (purpose in ('webauthn_register','webauthn_authenticate')), challenge bytea not null,
  created_at timestamptz not null default now(), expires_at timestamptz not null, consumed_at timestamptz
);
```
`on delete cascade` plus the S7.4 account-id check means a deleted-and-recreated account cannot inherit a factor. **MFA state is derived** (`active` credential exists ⇒ enrolled); no denormalised flag can drift. Enforcement mode is a governed registry setting `office_mfa_enforcement` (enum `off|optional|privileged|all`, owner office, read `staff.manage`, write `team.manage` + step-up `security_policy_write`, S3 versioning and audit), not a column.

### 6.2 Atomic functions (service role only, pattern of `office_revoke_admin_sessions`)
`office_mfa_consume_totp_step(credential_id, step)` (compare-and-set, returns whether accepted); `office_mfa_consume_recovery_code(user_id, code_hmac)` (single-use claim); `office_mfa_record_failure(user_id)` (atomic increment + lock computation, returns lock state) and `office_mfa_clear_failures(user_id)`; `office_mfa_consume_challenge(id)`; `office_mfa_reset(user_id, actor)` (revoke credentials, delete codes, set reset fields, bump generation — one statement). File-store equivalents run in the single writer with the S7.4 rollback-on-persist-failure rule.

### 6.3 Rollback
Additive, non-destructive: the down migration drops functions and keeps tables/columns (dropping credentials silently downgrades protected accounts). The off switch is configuration (§13). Optional destructive drop statements are commented and non-production only.

## 7. Session claims and verification

Token adds `mf` (0/1; absent = 0) and `mft` (ms). `verifySession()` rules, in order: signature/expiry (existing) → account loaded and active (existing; 503 on store failure) → account id and `sg` (S7.4) → **password fingerprint `pf` (concern C2)** → **MFA policy**: if the account is *required* to have MFA (stage and role, §11) and the token has `mf != 1`, answer `401 mfa_required` (the client re-authenticates; no mass generation bump is needed when enforcement is raised) → grace handling (`mfa_required_after`): inside the grace window the session is accepted with a `mfa_grace_ends` hint in `/session/me`. Legacy tokens (no `mf`) count as `mf=0`, so raising enforcement retires them for protected accounts automatically.

## 8. Enrollment, replacement and removal

**First factor (voluntary, stages 1–3 before the deadline):** from People & Access with a live session → step-up (password) → begin (TOTP: secret + otpauth URI shown once, or WebAuthn options) → confirm with a code/assertion → credential becomes `active` → recovery codes generated and shown once → **generation bump and re-issue of this browser's cookie with `mf=1`** (every other session ends; an attacker holding only a stolen cookie cannot do this because step-up needs the password). E-mail notification "two-step verification was turned on".
**First factor (forced, `mfa_enrollment_required` challenge):** the user has proven only the password. To prevent *enrollment hijack* by someone who knows the password but not the mailbox, forced enrolment of an existing account first requires a **one-time code e-mailed to the account address** (10 minutes, single use, same hashing/claim pattern as reset tokens) — password **and** mailbox before a factor can be attached. Invited users already proved mailbox control via the invite link.
**Add another factor / replace a device:** requires step-up with **password + existing MFA** (purpose `mfa_management`); add the new factor first, then remove the old one; removal of the **last** active factor is refused while enforcement requires MFA for that account. Removal bumps the generation (sessions authenticated by the removed factor end). Replacing a lost-and-never-recoverable device is recovery (§10).
**Recovery codes:** viewing is impossible (shown once); regenerate = step-up (password + MFA), invalidates the old batch; no generation bump.

## 9. Effect on active sessions and step-up grants

| Event | Active sessions | Step-up grants |
|---|---|---|
| First factor enabled | all others end (bump); current browser re-issued with `mf=1` | all die (generation in grant) |
| Additional factor added | unchanged | unchanged |
| Factor removed | generation bump | die |
| Recovery code used at sign-in | generation bump (other sessions end) | die |
| Recovery codes regenerated | unchanged | unchanged |
| Admin MFA reset (target) | target's sessions end (bump) | target's grants die |
| Enforcement raised | accounts required to have MFA and holding `mf=0` tokens get `401 mfa_required` on next request | those grants are dead with the session |
| Password change/reset/admin set | S7.4 + `pf`: all sessions from the old hash end | die (`pwf`, `sg`) |
| Session revoked (S7.4) | ends | die |

**Step-up extension:** `POST /session/step-up` accepts `{password, purpose, mfa?}`. For purposes marked MFA-protected (`security_policy_write`, `session_revocation`, new `mfa_management`) the grant is issued only if the supplied factor verifies when the account has an active factor or its role is required to; the grant carries `mf:true` and `mft`, and `verifyStepUpToken` refuses a grant lacking `mf` for those purposes. Grants stay bound to identity, session fingerprint, purpose, generation and password state as in S7.2/S7.4, and keep the 10-minute ceiling. API keys remain refused everywhere.

## 10. Administrator recovery, device loss and break-glass

| Path | Who | Controls |
|---|---|---|
| R1 Recovery code | the user | single use, bump + e-mail + audit, replacement prompted |
| R2 Admin reset | another `super_admin` (`team.manage`) | step-up `mfa_management` **with MFA**; cannot target self; target must not be the last enrolled `super_admin` unless a second recovery path exists (preflight); clears factors and codes, bumps generation, e-mails the target, audits actor/target/reason, target must re-enrol at next sign-in (mail-code gated). Password untouched. |
| R3 Deployment-owner reset | whoever controls the environment | `LEAD_AGENTS_MFA_RECOVERY=true` + `LEAD_AGENTS_MFA_RECOVERY_EMAIL=<one address>`: at startup clears that account's factors and codes, sets `mfa_required_after = now`, bumps the generation, audits `mfa_recovery_applied` (email only), logs a warning and `/healthz` shows `auth_config.mfa_recovery: enabled` so it cannot linger; not reachable over HTTP; one account per deploy; removing the flag afterwards is part of the runbook. Password is **not** reset (use the S7.0 recovery for that). |
| R4 Database owner | owner | documented last-resort SQL (revoke credentials for one user), same effect as R3, audited manually |
| R5 Global downgrade | deployment owner | `LEAD_AGENTS_MFA=off`, a **declared security downgrade**: `/healthz` shows `mfa: off` with the count of accounts that have factors; used only when MFA infrastructure itself is broken |

Lockout protections: enforcement cannot be raised above `optional` unless **(a)** the acting `super_admin` has an active factor and has stored recovery codes, **(b)** at least two `super_admin` accounts are enrolled (or R3 is declared available in the runbook), and **(c)** the preflight endpoint reports how many active accounts would be blocked. Recovery never reveals whether a factor exists to anyone who cannot already pass step-up.

## 11. Staged enforcement

| Stage | Setting | Behaviour |
|---|---|---|
| 0 | `off` (default) or `LEAD_AGENTS_MFA=off` | no MFA UI, login unchanged (current behaviour) |
| 1 | `optional` | enrolment available, banners nudge, enrolled accounts **do** challenge at login (a factor is never ignored once enrolled) |
| 2 | `privileged` | roles holding `team.manage`, `settings.manage` or `staff.manage` (super_admin, ochiga_admin) must have MFA; each affected account gets `mfa_required_after = now + 14 days` (grace banner), then enrolment-gated sign-in |
| 3 | `all` | every human account; invited users enrol during first sign-in |

Each raise is a governed, audited, step-up-protected write (S7.3 pattern); lowering is immediate. Exit criteria for raising a stage: ≥ 95% of affected accounts enrolled, two enrolled `super_admin` accounts, R2/R3 rehearsed on staging, all instances reporting MFA enforcement support (§13), API-key fallback off (§12), concern C5 resolved.

## 12. Bypass analysis for legacy authentication paths

| Path | Risk | Design response |
|---|---|---|
| API-key-as-password fallback (`LEAD_AGENTS_ALLOW_API_KEY_LOGIN`) | mints an account and a session with no second factor | boot/`/healthz` validation fails (`mfa_enabled_with_api_key_login`) if MFA ≠ `off` and the fallback is on; transitional use ends before stage 1 |
| Shared API keys on human-account routes (**concern C5, verified**) | key creates a `super_admin`, sets an admin's password, then signs in or plants an authenticator | **D-1:** deny API keys on `/admin/users*` mutations, invites and every MFA route before stage 2; MFA routes refuse API keys regardless |
| Edge-agent tokens | machine credential; no human routes | inventory in S7.5.0 to confirm none reach human or MFA routes |
| Invite accept | issues a session at once | for MFA-required accounts it returns an enrollment challenge instead of a cookie |
| Password reset confirm | e-mail alone must not equal a factor | issues no session (unchanged), **does not touch MFA**; the next sign-in still challenges |
| Env admin recovery (S7.0) | resets password + reactivates | does not reset MFA; the recovered admin still needs a factor (R3 if lost) |
| `/admin/session/me` and any future cookie reader | divergent checks | R0: single `verifySession()` + inventory test |
| Existing cookies at stage change | `mf=0` sessions persist | `401 mfa_required` for required accounts, no waiting for expiry |
| Mixed-version fleet | old instances accept password-only | §13 |
| Step-up | password-only grant for MFA-protected purposes | §9: grant must carry `mf` |
| Owner SQL / Supabase console | outside the application | documented, audited manually |

## 13. Rollout, mixed versions and rollback

Order: **migration → code with MFA `off` → verify every instance (`/healthz auth_config.mfa: supported`, and the S7.4 procedure in concern C3) → configure keys/RP → stage 1 → enrol → stage 2 …**. An instance without MFA code would accept a password for an enrolled account; therefore enforcement stages are never raised while any older instance may serve traffic, and raising the stage should be preceded by a secret rotation or legacy-token rejection exactly as for revocation. Code rollback after enrolment re-opens that hole; before rolling code back, set the stage to `off` knowingly (R5) or accept password-only access for that period. Data rollback is non-destructive (§6.3). Feature rollback = lower the registry stage (instant) or `LEAD_AGENTS_MFA=off`.

## 14. Permissions

| Action | Who | Step-up |
|---|---|---|
| View own MFA status, add/remove own factors, regenerate own codes | authenticated human, own account | password (+MFA if enrolled) `mfa_management` |
| Reset another user's MFA (R2) | `super_admin` + `team.manage` | `mfa_management` with MFA |
| Read enforcement stage / preflight | `staff.manage` | none |
| Change enforcement stage | `super_admin` + `team.manage` | `security_policy_write` with MFA |
| Any MFA route | never an API key (403 `actor_identity_required`) | – |
No new permission keys.

## 15. API contracts (all under `/api/lead-agents/admin`)

| Route | Request → response |
|---|---|
| `POST /session/login` | unchanged on success without MFA; `200 {mfa_required, challenge_token, methods, webauthn_options?}` or `{mfa_enrollment_required, challenge_token, email_code_sent}`; no cookie in either; wrong credentials identical 401 |
| `POST /session/mfa/verify` | `{challenge_token, method:"totp"\|"webauthn"\|"recovery_code", code\|assertion}` → session cookie + `{admin, recovery_codes_remaining?}`; failures `401 mfa_failed` (never says which part), `429 mfa_locked {retry_after}`, `401 mfa_challenge_expired` |
| `POST /session/mfa/enroll/email-code` | forced enrolment only: confirm the mailed code → enrolment step token |
| `POST /session/mfa/enroll/totp/begin` · `/confirm` | begin → `{credential_id, otpauth_uri, secret_base32}` once; confirm `{credential_id, code}` → `{recovery_codes:[…10…]}` once, cookie re-issued |
| `POST /session/mfa/enroll/webauthn/options` · `/verify` | creation options with challenge id; verify attestation → credential (+ recovery codes if first) |
| `GET /session/mfa` | `{enforcement, enrolled, credentials:[{id,type,label,created,last_used}], recovery_codes_remaining, grace_ends}`; never secrets |
| `DELETE /session/mfa/credentials/:id` | step-up `mfa_management` → bump |
| `POST /session/mfa/recovery-codes/regenerate` | step-up → new batch once |
| `POST /users/:id/mfa/reset` | R2, step-up with MFA, `{reason}` → `{ok, generation}` |
| `GET /mfa/preflight` | counts of enrolled/unenrolled by role, lockout warnings |
| `POST /session/step-up` | adds optional `mfa` object (§9) |
Errors never expose which factor exists, codes, hashes or keys; `503 mfa_unavailable` when keys/RP/migration are missing.

## 16. UI flows (S1–S6 components: cards, `stForm`, `st-modal`, step-up dialog)

Login: password → "Enter the 6-digit code" with links "Use a security key" and "Use a recovery code" → success; lockout and expiry states; recovery-code success shows "N codes left". Forced enrolment: mailed code → choose method → TOTP (QR rendered **locally** from the otpauth URI with a vendored generator; the secret is never sent to a third party; manual key shown) or security key → confirm → recovery-codes screen (copy/download/print, "I have stored these" gate) → signed in. People & Access → **Two-step verification** card (factors with names/last used, add, remove with step-up, regenerate codes, codes remaining), admin "Reset two-step verification" action behind confirmation + step-up, **Enforcement policy** card (stage, preflight counts, step-up), grace/banner messaging, read-only for roles without `team.manage`. Responsive to 390 px; keyboard and screen-reader labelled; no secret persisted in DOM after confirmation.

## 17. Audit and notification

Audit (actor, target, request id, outcome, factor type, timestamp, failure category; never secrets): `mfa_challenge_issued`, `mfa_verified`, `mfa_failed`, `mfa_locked`, `mfa_enrolled`, `mfa_factor_added`, `mfa_factor_removed`, `mfa_recovery_code_used`, `mfa_recovery_codes_regenerated`, `mfa_reset_by_admin`, `mfa_recovery_applied`, `mfa_enforcement_changed`, `mfa_enrollment_email_code_sent`. Individual failed attempts are counted, not flooded into the audit store beyond lock events. E-mail (existing sender): factor enabled/removed, recovery code used, admin reset, new enrolment, R3 applied.

## 18. Abuse, takeover and lockout protections

- Persisted per-account failure counter with progressive lock (5 → 1 min, 10 → 15 min, 20 → 60 min, reset on success); locks are time-limited, never permanent, so an attacker cannot lock out an administrator for long, and the challenge is only reachable after the password.
- Existing per-IP/email login limiter keeps applying; constant-time comparisons; recovery-code space (50 bits) rate-limited by the same counter.
- Enrollment hijack (password + stolen session on an unenrolled account): step-up with password, mailbox-code gate for forced enrolment, notification e-mail, generation bump that ends the real user's other sessions (visible signal).
- Recovery abuse: R2/R3 notify the target, bump the generation, require stronger step-up (R2) or environment control (R3), and never touch the password; R1 consumes a code and notifies.
- Administrator lockout: preflight rules (§10), ≥ 2 enrolled super admins, recovery codes, R2, R3, R4, R5.
- Clock: TOTP window ±1 with NTP-synchronised hosts; replay by step counter.
- Mail-only reset can never complete MFA; SMS is not used anywhere.

## 19. Acceptance tests (required before implementation is accepted)

Unit/crypto: RFC 6238 vectors, window edges, replay refusal, Base32/QR URI, AES-GCM round trip + tamper + wrong AAD + key rotation, recovery-code hashing/normalisation/single use, WebAuthn verification matrix (origin, RP ID, flags, counter, replayed challenge). Login: password-only account unchanged at stage 0; enrolled account never gets a cookie from step 1; wrong code / expired / replayed challenge; lockout progression and recovery; unknown-user and wrong-password responses identical to today; limiter unchanged. Sessions: `mf` claims, stage raise retires `mf=0` cookies, legacy tokens, grace window, `/session/me` parity (inventory test), generation bumps per §9, grants die per §9. Step-up: MFA-protected purposes require `mf`, wrong purpose, API key, expired. Enrollment: forced mailbox-code gate, hijack attempts (cookie only, password only, password + cookie), last-factor removal refused, add-then-remove replacement. Recovery: R1–R5 each with audit and notification, R2 self-target and last-admin refusals, R3 off by default and one account only, lockout drills. Legacy: fallback + MFA boot failure, API key on human/MFA routes (after D-1), invite accept gating, reset-confirm leaves MFA intact, env recovery leaves MFA intact. Failure modes: key missing/invalid ⇒ 503 and no password-only fallback, database outage, restart persistence, migration absent, concurrent TOTP use (one winner), concurrent recovery-code use, concurrent enrol/revoke. Real-database suite (Postgres + PostgREST, as S3/S7.4) for the atomic functions. Mixed-version simulation (old instance accepts password only; documented, not "fixed"). Browser: login challenge, enrolment wizard, recovery-code screen, management card, admin reset, enforcement card at 1440/768/390. Regression: S7.0–S7.4, S1–S6, Team permissions, WhatsApp autonomy, full suite, repository gates.

## 20. Deployment dependencies

Secrets (Render, `sync:false`): `LEAD_AGENTS_MFA_KEY`, `LEAD_AGENTS_MFA_KEY_ID`, optional `LEAD_AGENTS_MFA_KEYS_PREVIOUS`; config: `LEAD_AGENTS_WEBAUTHN_RP_ID`, `LEAD_AGENTS_WEBAUTHN_ORIGINS`, `LEAD_AGENTS_MFA` (default `off`), recovery variables (transient). Deployment validator additionally rejects `LEAD_AGENTS_MFA_RECOVERY` in `render.yaml` and requires the keys to be declared unsynced. Key custody: the MFA key needs an offline backup separate from the database (loss = every TOTP unusable; recovery is R2/R3 re-enrolment). HTTPS and a stable public domain (WebAuthn secure context, permanent RP ID). Outbound e-mail (existing Resend) for notifications and the mailbox-code gate. Library dependency review and lockfile pin for the WebAuthn package; a vendored QR generator; Node version supporting `crypto` GCM/HKDF (already). NTP-synchronised hosts. Additive migration applied before code; capability probe like S7.4. Staging environment to rehearse R2/R3.

## 21. Implementation plan (not started) and decisions

S7.5.0 prerequisites: `verifySession()` unification + inventory test; password fingerprint `pf` (concern C2); atomic password+generation function; API-key restrictions (D-1). S7.5.1 schema, functions, stores, key/readiness validation. S7.5.2 crypto module (TOTP, codes, AES-GCM, challenge tokens). S7.5.3 login challenge flow and `mf` claims. S7.5.4 TOTP enrolment, recovery codes, management APIs. S7.5.5 WebAuthn. S7.5.6 step-up MFA leg. S7.5.7 enforcement stages, preflight, admin reset, R3, rollout checks. S7.5.8 UI. S7.5.9 tests, regressions, gates, delivery.

Decisions requested: **D-1** deny API keys on human-account mutations (required before stage 2). **D-2** mailbox-code gate for forced enrolment of existing accounts. **D-3** recovery-code use bumps the generation. **D-4** fix the production domain / RP ID before any enrolment. **D-5** adopt a vetted WebAuthn library. **D-6** TOTP SHA-1/6/30 s for compatibility. **D-7** grace period 14 days for stage 2. **D-8** `privileged` stage covers `team.manage`/`settings.manage`/`staff.manage` roles. **D-9** logout semantics (concern C1) decided separately. **D-10** `pf` claim and atomic password function (concern C2) as S7.5.0.

## 22. Blockers

None prevents approving this design. Items that gate **implementation or enforcement**, not the design: the owner's production dependency audit of the API-key fallback (C4), decision D-1 (C5), the production domain for D-4, and a place to hold the MFA key with an offline backup.
