# S7.5.9 — S7 authentication and MFA security certification: frozen protocol

**Evaluated commit:** `fc58ec47bcb107e0b7ade77fe2cd71e4694153a8` (branch `feature/settings-s1-s2`, local = remote, clean tree, verified before any test). All certification runs use a **separate clean checkout** of exactly that commit (`git worktree` at `/tmp/office-cert`); nothing is evaluated from a working tree that could contain uncommitted edits. **No runtime code is modified during certification.** A defect is recorded and a separate remediation slice recommended; the evaluated commit never moves. This document is committed before the first certification test runs.

## 1. Scope
The complete S7 authentication stack as shipped by S7.0–S7.5.8: password policy, password login, reset, invitation, session tokens and generations, session revocation, step-up grants (S7.2/S7.5.6), MFA (TOTP, WebAuthn, recovery codes), enrolment, management, enforcement, grace, administrator reset, break-glass, the MFA schema and functions, the browser interface, and the deployment guards. Out of scope: non-S7 Office features (except as regression), the Backend/Facility/Consumer repositories, and every production system (no production account, database, secret or host is touched).

## 2. Pass / fail criteria
A control **passes** only when an independently authored test, run against the evaluated commit, demonstrates the required behaviour **and** the same behaviour is observed in the complete regression run (not only in isolation). A control **fails** when any test shows the property violated. A control is **not verifiable here** when it needs production-owner access (listed in the readiness section; never marked passed). Certification verdict:
- **CERTIFIED — PRODUCTION REVIEW REQUIRED:** no open Critical or High finding in the S7 code; every certification test passes; the full regression passes with browser-suite timeouts sized to the suites; every item that needs production access is explicitly listed as an owner action.
- **CERTIFICATION FAILED — REMEDIATION REQUIRED:** any open Critical or High finding in the S7 code, any failing certification test (after the defect-in-test rule below), or a regression suite that fails in the complete run.
A High dependency advisory that is outside the S7 code is reported as a **production blocker** with a remediation recommendation; it does not by itself fail the certification of the S7 controls, but the report states it plainly.

## 3. Severity
| Level | Meaning |
|---|---|
| Critical | authentication or authorization bypass, credential or secret disclosure, takeover of another account, persistent privilege escalation |
| High | exploitable weakening of a control that protects accounts (replay, lock bypass, session that cannot be revoked by design intent, secret in logs) without a precondition outside the attacker's reach; or a High-rated dependency advisory reachable in the shipped code |
| Medium | information disclosure that aids an attack (e.g. account enumeration), a control that fails open in a rare operational condition, a gap in auditability |
| Low | hardening gaps, misleading UI text, performance of tests, operational inconvenience |
| Info | observations, known and documented limitations |

## 4. Test corpus (frozen)
**Existing implementation tests** (`scripts/test-*.js`, authored with the implementation) are run unchanged and reported separately as *implementation evidence*; they are **not** certification evidence on their own.
**Independently authored certification tests** live under `scripts/cert/` and are written by black-box over HTTP against the real server and real Postgres/PostgREST, with their own RFC 6238 TOTP, base32, CBOR and software WebAuthn authenticator (no import of `mfa-crypto`, `mfa-webauthn`, or the implementation's test authenticator). They may import only the server entry (`buildServer`), configuration and store factories to boot the system, and the password hasher to seed accounts.
| File | Covers |
|---|---|
| `scripts/cert/cert-auth-session.js` | §5 authentication, §6 session, §7 step-up |
| `scripts/cert/cert-mfa-lifecycle.js` | §8 MFA management and §11 adversarial review |
| `scripts/cert/cert-database.js` | §9 database security (disposable Postgres 16, Supabase Postgres 17 + PostgREST) |
| `scripts/cert/cert-browser.js` | §10 browser acceptance (real Chrome, virtual authenticator, five widths) |
After authoring, the files' SHA-256 digests are recorded in `docs/settings-domain/36_S7_5_9_CORPUS_MANIFEST.md` and committed **before the first execution**. A test may be changed after that only for a defect in the test itself (wrong selector, wrong expectation about documented behaviour), and each change is listed in the report with the reason; a change that makes a failing control pass is never allowed.

## 5. Required checks — authentication
A1 password login success and failure bodies; A2 unknown vs known vs inactive account responses (enumeration), including timing class; A3 password reset request neutrality, token single use and expiry, reset does not issue a session and does not touch MFA; A4 invitation accept token rules; A5 login challenge issued only after the correct password and carries no authority; A6 TOTP verification (window, wrong, replay, format); A7 WebAuthn verification (origin, RP, signature, counter, challenge single use); A8 recovery code (single use, other account, normalisation, generation bump); A9 rate limiting on login and MFA verify, persisted MFA lock; A10 configuration failures (invalid session secret, missing or wrong MFA key, MFA off flips) never yield a weaker session.
## 6. Session
S1 session generation revocation (self, admin, password change, reset); S2 password fingerprint; S3 copied and tampered cookies (signature, payload edit, other account's cookie); S4 logout behaviour (documented semantics); S5 deactivation and reactivation; S6 deleted and recreated account with the same e-mail; S7 expiry; S8 legacy tokens without generation or fingerprint; S9 mixed-version behaviour (token issued by older logic; configuration flags).
## 7. Step-up
U1 password-only step-up (MFA off or no factor); U2 MFA-protected step-up (TOTP, WebAuthn, session proof, recovery code refused); U3 purpose isolation; U4 expiry (≤10 min); U5 session binding; U6 permission removal; U7 password change; U8 API-key and edge-token refusal; U9 forged and tampered grants.
## 8. MFA management
M1 enrolment; M2 replacement; M3 removal and last-factor guard; M4 regeneration; M5 forced enrolment and mailbox verification; M6 administrator reset; M7 break-glass; M8 enforcement change (preflight, step-up, version); M9 grace expiry; M10 WebAuthn registration limits and duplicates.
## 9. Database
D1 migration order guards; D2 RLS on and no policies, anon/authenticated denied for every `office_*` function and `admin_mfa_*` table; D3 service-role-only grants, nothing to PUBLIC; D4 atomicity (activation, revocation, recovery consumption, reset, counter CAS); D5 concurrency (races across connections); D6 replay protection (TOTP step, challenge, recovery code, counter); D7 rollback scripts non-destructive; D8 failure isolation and fail-closed on outage; D9 credential redaction (no plaintext secret, code or key in any table, audit row or REST response).
## 10. Browser
B1 five viewports 1440/1100/900/768/390; B2 keyboard-only sign-in with the second factor; B3 focus management and trapping; B4 touch targets; B5 accessibility tree names and roles; B6 challenge expiry; B7 error recovery; B8 session termination by the server.
## 11. Adversarial
V1 authentication bypass attempts (skip the challenge, forged challenge, challenge of another account, downgrade of method, mfa verify without password); V2 privilege escalation (self-promotion, scope grants, policy and reset by non-super-admin, grant of another purpose); V3 cross-account access (other account's credential id, step-up token, enrolment token, recovery codes); V4 credential disclosure (responses, audit, logs, errors); V5 challenge replay; V6 session replay; V7 recovery abuse; V8 unauthorised policy changes; V9 API-key and edge-token abuse on every MFA, step-up, reset and settings route; V10 unsafe fallbacks (store outage, key outage, partial failure). No test is run against production accounts, hosts or data.
## 12. Regression
The complete Office regression (every `scripts/test-*.js` except the Postgres and cross-repo suites, with a 900 s limit per suite) is run once, in one pass, on the evaluated commit in the clean checkout, followed by every Postgres/PostgREST suite, the gates (`check`, `lint`, `build`, `security:secrets`, `deployment:validate`) and `npm audit`. A suite that fails in the complete run is a failure even if it passes alone.
## 13. Production readiness
Items verifiable from the repository are verified and cited; items that need production-owner access are listed as owner actions and are never reported as passed: API-key fallback dependency, historical audit rows, WebAuthn RP ID decision, MFA key custody and backup, backup and rollback rehearsal, mixed-version fleet inventory, administrator recovery rehearsal.
## 14. Deliverables
`docs/settings-domain/37_S7_5_9_CERTIFICATION_REPORT.md` (results, findings by severity, outstanding vulnerabilities, production blockers, remediation), the corpus manifest, and the committed `scripts/cert/` tests.
