# S7.5.9 — S7 authentication and MFA security certification: report

**Verdict: S7 MFA CERTIFICATION FAILED — REMEDIATION REQUIRED.**
Reasons (per the frozen protocol, `36_S7_5_9_CERTIFICATION_PROTOCOL.md` §2): one **open High** finding in S7 code (F-1: the login rate limiter does not throttle password guessing) and one regression suite that **failed in the complete run** (F-7, a browser-harness timeout). Everything else certified: 677 of 681 independent checks passed, every other suite passed, no Critical finding, no secret disclosure, no authentication bypass found.

| | |
|---|---|
| Evaluated runtime commit | `fc58ec47bcb107e0b7ade77fe2cd71e4694153a8` (branch `feature/settings-s1-s2`; local = remote, clean, verified before testing) |
| Protocol commit | `d65d893` (frozen before any certification test) |
| Corpus commit | `90666ea` = evaluated commit + documents + `scripts/cert/` only (`git diff fc58ec4..90666ea -- src public db package.json package-lock.json render.yaml` is empty). The official run used a clean checkout of this commit. All five corpus files matched the manifest digests at run time. **No test was changed after the freeze.** |
| Runtime code modified during certification | **none** |
| Production touched | **none** (disposable Docker databases, fixture accounts only) |

## 1. Independent test results (`scripts/cert/`, black-box, own TOTP/CBOR/WebAuthn)
| Suite | Checks | Failed | Covers |
|---|---|---|---|
| `cert-auth-session.js` | 153 | **4** | A1–A10 authentication, S1–S9 sessions, U1–U9 step-up |
| `cert-mfa-lifecycle.js` | 213 | 0 | M1–M10 management, V1–V10 adversarial (incl. 4 route inventories × API key / edge token) |
| `cert-database.js` | 239 | 0 | D1–D9 on plain Postgres 16 and Supabase Postgres 17 + PostgREST |
| `cert-browser.js` | 76 | 0 | B1–B8, five widths, keyboard only, accessibility tree |
| **Total** | **681** | **4** | |
The four failures are findings F-1 to F-4 below; they are properties the tests required and the system did not have.

## 2. Findings by severity
**F-1 — HIGH — The login rate limiter does not throttle password guessing (A9).** After the limit is exceeded, a wrong password is answered `429` but the **correct** password is answered `200` (the code resets the key when credentials are valid). Limited or not, an attacker can keep guessing at server speed and recognises success from the status code; the limiter only relabels failures. Reproduce: six wrong attempts for one account, then the right password → `200`. Impact: online brute force against password-only accounts (the default while MFA is off); with MFA on the guess still leads only to a challenge. Remediation: count and refuse **every** attempt while limited (uniform `429` regardless of correctness), key by account and by source address, add progressive delay and a per-account ceiling that cannot be used to lock the owner out for long (the S7.5.3 MFA lock is the model), and add a regression test.
**F-2 — MEDIUM — Account enumeration through inactive accounts (A2).** A wrong password for an inactive account answers `403 account_inactive`, any other account `401`. The status is checked before the password. Remediation: verify the password first and answer a generic `401` for an inactive account unless the password is correct.
**F-3 — MEDIUM — Account enumeration through timing (A2).** A wrong password for an existing e-mail takes ~35 ms (hash verification); an unknown e-mail ~0.6 ms (median ratio ~60×). Remediation: verify against a fixed dummy hash when the account does not exist.
**F-4 — LOW — Session token with extra trailing segments is accepted (S3).** `payload.signature.x` verifies (the reader ignores extra segments). No privilege results (the signature still covers the payload), but the step-up grant verifier rejects the same shape, so the two are inconsistent. Remediation: reject tokens that do not have exactly two segments.
**F-5 — MEDIUM — Logout does not invalidate a copied cookie (S4).** Known and documented (`26_S7_4_OUTSTANDING_PRODUCTION_CONCERNS.md` C1); users must use *Sign out everywhere* after suspected theft. Remediation: the C1 recommendation (per-session identifier plus a small denylist).
**F-6 — INFO — Mixed-version rollout (S9).** A server running with session revocation off (the behaviour of instances older than S7.4) still accepts a revoked cookie; revocation and MFA are only as strong as the oldest instance. Control: the fleet attestation (S7.5.7) and the rollout order in `25_…` §13.
**F-7 — LOW (test infrastructure; counted as a regression failure by protocol) — `test-settings-domain-browser.js` failed in the complete run** with `CDP call timed out: Page.navigate` (the documented headless-Chrome flake class, `18_PROVIDERS_BROWSER_FLAKE_INVESTIGATION.md`). It passed 3 of 3 when run alone afterwards (supplementary evidence only; not used to reclassify). Remediation: the navigate-retry used by other browser suites, and giving the new `test-mfa-ui-browser-s758.js` (about 8 minutes) a larger default limit or splitting it.
**F-8 — INFO — Recovery codes are normalised** (case, dash, spaces); a normalised variant consumes the code exactly once. Documented behaviour.
**Dependency — HIGH (outside S7 code; production blocker) — `axios` 1.19.0** (`npm audit --omit=dev`: one high-severity package, multiple advisories: prototype-pollution gadgets, header injection, ReDoS in data-URL and proxy parsing, redirect/SSRF behaviours, HTTP/2 adapter). Used by the Supabase store and every outbound client. A fix is available. Remediation: upgrade within a separate dependency slice with the S7 and integration suites rerun.
No Critical finding. No finding allowed authentication bypass, cross-account access, privilege escalation, challenge or session replay beyond the documented stateless-cookie limitation, or disclosure of a credential or key.

## 3. What passed (highlights, all independent)
Authentication: password policy at reset/invite, reset and invitation tokens single-use/expiring/tamper-proof, no session from reset, neutral reset answers, challenge only after the password, malformed bodies refused cleanly, TOTP window/replay, WebAuthn (origin, RP ID, signature, UV/UP, counter rollback, challenge reuse, cross-account), recovery code single use and lock, persisted MFA lock refuses even a correct code, invalid session secret and missing/wrong/unreadable MFA state never yield a weaker session.
Sessions: generation revocation (self, admin, password change, reset, recovery code, enrolment), password fingerprint (out-of-band hash change), edited/forged/truncated tokens refused, expiry, legacy tokens, deactivation/reactivation does not revive, deleted-and-recreated account does not inherit.
Step-up: purpose isolation, expiry and 10-minute clamp, session/account binding, permission loss, password change, revocation, API key and edge token refused, forged grants (edited purpose/expiry, stripped or added factor claim, `alg:none` style, wrong key) refused, recovery codes not accepted and not consumed.
Management and adversarial: enrolment, replacement, removal with last-factor guard, regeneration, forced enrolment with mailbox check, administrator reset (every refusal and the success effects), break-glass (off by default, once per id, password preserved, no HTTP route), enforcement (preflight, version conflicts, step-up), grace expiry, key limit; mass assignment cannot clear an MFA requirement, rewind a generation or reset a lock; no cross-account factor removal; no secret in any response or audit row; store faults produce `503` without internal detail.
Database: migration order refused out of order, idempotent; RLS on, **no policies**, no privileges for `anon`/`authenticated`/PUBLIC on any `admin_mfa_*` table or `office_*` function (enumerated from the catalog), also through the Data API with real JWTs; atomicity (activation, revocation, reset, recovery consumption) with full rollback on failure; races (24-way TOTP step, 30-way recovery code, 20-way challenge, 12-way counter, 20-way activation) each have one winner; progressive persisted lock; rollbacks keep every row and generation; no plaintext secret, code, key, password or private key in any column of any table; database outage fails closed with no session.
Browser: keyboard-only sign-in with the second factor at 1440/1100/900/768/390, focus enters the code field, wrong code announced (`role=alert`) and focus restored, 44 px targets and no overflow, accessibility tree names for the field, button, method group, dialogs and QR, focus trapped in dialogs and restored on Esc, recovery-code dialog cannot be dismissed unacknowledged, expired challenge and server-ended session handled.

## 4. Regression (complete run in the clean checkout of the corpus commit; no suite classified by isolated passes)
| | Result |
|---|---|
| Gates (`check`, `lint`, `build`, `security:secrets`, `deployment:validate`) | 5 / 5 pass |
| Complete Office regression (79 suites, 900 s limit each) | **78 pass, 1 fail** (F-7) |
| Postgres / PostgREST suites | 10 / 10 pass |
| Included in the 79: S7.0–S7.5.8 suites (API and browser), Team permissions, WhatsApp autonomy, Settings S1–S6 | all pass except F-7 (a Settings S6-era browser suite) |
| `npm audit --omit=dev` | 1 high (axios) |

## 5. Production readiness
**Verified from the repository / disposable systems:** migration order, idempotence and non-destructive rollback (D1, D7); service-role-only operations and RLS (D2, D3); fleet-attestation control and simulated mixed-version behaviour (F-6); MFA key, session secret and secrets never reach responses, logs, audit, tables (V4, D9); WebAuthn cannot be enabled in production without an explicit RP ID and approval (guard tests; `render.yaml` carries none, verified by the deployment gate); the API-key password sign-in is refused alongside MFA (configuration check) and is not enabled by `render.yaml`; break-glass and administrator reset logic.
**Requires production-owner access (not verifiable here, NOT marked passed):**
1. **Production API-key fallback dependency** — run the audit SQL in `19_S7_0_AUTH_SECURITY_CONTRACT.md` §3.3 / `26_…` C4 before any enforcement.
2. **Historical password-hash audit exposure** — the code no longer records hashes (verified), but rows written before S7.5.0 may still hold them; scrub them (`27_…` describes the pattern).
3. **Permanent WebAuthn RP ID** — a decision; nothing enrolls security keys until set and approved.
4. **MFA key custody and backup** — generate, store in the deployment secret store, keep an offline backup, rehearse rotation (`LEAD_AGENTS_MFA_KEYS_PREVIOUS`).
5. **Axios** — upgrade (see dependency finding).
6. **Applied migrations on the real database** — confirm `20261020`–`20261025` are present in order.
7. **Mixed-version inventory** — confirm no older instance serves traffic; then set `LEAD_AGENTS_MFA_FLEET_ATTESTED`.
8. **Administrator recovery rehearsal** — rehearse reset and break-glass on staging; keep a second enrolled super administrator.
9. **Backup and rollback** — take a verified backup before applying migrations; the rollbacks are non-destructive but a restore drill is an owner action.
**Production blockers:** F-1 (High) must be remediated before any production MFA enforcement or reliance on password-only accounts; axios must be upgraded; items 1, 2, 4 and 7 must be completed by the owner before enforcement is raised.

## 6. Recommended remediation (separate slices; this certification changes no code)
1. **S7.6-A (security):** F-1, F-2, F-3, F-4 together — one login-hardening slice with regression tests that are the certification checks A2/A9/S3 (they already exist in `scripts/cert/cert-auth-session.js` and will pass when fixed).
2. **Dependency slice:** upgrade `axios`; rerun S7, WhatsApp, Backend/Facility/Consumer bridge suites.
3. **Test infrastructure:** harden the browser-suite navigation retry (F-7); size timeouts for the MFA browser suite.
4. **Optional:** C1 logout denylist (F-5).
5. **Recertify:** rerun `scripts/cert/*` and the complete regression on the remediation commit; expected result is a certification pass if no new finding appears.

## 7. Exact commits
`d65d893` protocol · `90666ea` corpus and manifest · (this report commit follows). Evaluated runtime commit throughout: `fc58ec47bcb107e0b7ade77fe2cd71e4694153a8`.
