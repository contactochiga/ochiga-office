# AREA B - MFA test corpus (independent author)

Run each file standalone: `SUT_DIR=<release dir> SUT_OLD_DIR=<previous release> node <file>` (or `./run.sh <file>` which sets the development defaults).
Every file starts its own server process(es) on free loopback ports from a private symlink copy of the release (the SUT is never written), uses a private temp data directory,
captures e-mail by pre-loading `lib/mail-preload.js` (redirects only `https://api.resend.com/*` fetches to a loopback endpoint; no SUT source is modified) and cleans up in `finally`.
Each file prints `FAIL <id> <text>` lines with evidence and ends with ONE JSON line `{"suite","area","checks","failed","failures"}`; exit 0 = no failed check, 1 = failed checks, 2 = blocked (infrastructure).

## Layout
- `lib/util.js`      base32, RFC 6238 TOTP, CBOR encoder, software WebAuthn authenticator (ES256, attestation none), step waiting helpers
- `lib/forge.js`     mint correctly signed challenge / session / step-up tokens from the test's own session secret (for expired / wrong purpose / stale-claim negatives)
- `lib/harness.js`   check registry, server management, HTTP client with cookie jar, mail capture, account + enrolment helpers
- `run.sh`           development runner

## Files and coverage map (status is updated after each file)
| file | coverage |
|---|---|
| test-b1-login-challenge.js | login challenge: no authority before completion, binding to account / purpose / password state / generation, expiry, forged and malformed tokens, enumeration, method downgrade, deactivation, deleted-and-recreated accounts, audit/log redaction |
| test-b2-totp.js | TOTP: positive control, window, replay (incl. older step, confirmation code), malformed codes, persisted lock (1 min / 15 min / 60 min; correct code refused while locked; lock not extended; XFF rotation), concurrency, session claims and forged sessions, audit/storage/log redaction |

| test-b3-recovery-codes.js | recovery codes: format, single use (+12-way concurrency), normalisation, other account, shared lock, abuse/malformed, session generation bump, e-mail notice, lost-device replacement, not a step-up factor, regeneration invalidating the old batch, never stored/logged in clear |
| test-b4-webauthn.js | WebAuthn: registration and assertion with a software authenticator: origin, RP id, signature, UV, UP, counter rollback/repeat/zero, challenge reuse and purpose isolation, other account's credential, duplicate, 10-key limit, revocation, lock sharing, concurrency |
| test-b5-factor-management.js | TOTP enrolment, replacement, removal, last-factor guard (role list), pending expiry, concurrency, cross-account, notifications (captured mail), forced enrolment through the mailbox gate, no session from an enrolment challenge, mailbox-code brute force |
| test-b6-stepup.js | step-up: purposes, eligibility, expiry/TTL cap, session + account binding, permission loss, password change, revocation, forged/edited grants, API key / edge token, second factor (TOTP, WebAuthn, session proof), recovery code refused, use-time gate on every consumer, lock, oracle, throttling |
| test-b7-reset-breakglass.js | administrator reset (every refusal, success effects, self, super-admin recoverability, audit, notice, re-enrolment) and break-glass (default off, misconfiguration, once per id across restarts, password preserved, no HTTP route, health) |
| test-b8-enforcement.js | governed enforcement setting: write governance, preflight per check, step-up/MFA gate, version conflicts, unchanged value, modes, privileged detection, grace before/after deadline (store timestamps moved while stopped), existing sessions, never downgraded, fail closed, legacy API-key login |
| test-b9-crosscutting.js | API key / edge token sweep over every MFA route, mass assignment, limiter budget, key misconfiguration/rotation (fail closed), secrets in health/errors, store failures during verification, previous-release behaviour |

## Notes
- Over-specific first-draft expectations corrected by the author BEFORE any result was reported (each is marked in the source): T6.2 (b2: 401 or 429 for losers of a replay race, 429 follows from the written 5-failure lock rule), F7.20 (b5: 401 or 409), S4.6.7 (b6: 431 counts as a refusal). All other failures are candidate findings and are left failing.
- Not exercisable here: multi-instance convergence of the 10 s policy cache (file store is per process), Postgres/PostgREST-specific atomic functions, exact-instant deadline boundary (tests use 13.9 / 14.1 days), real hardware authenticators.
- lib/smoke.js and lib/dbg.js are development scratch helpers, not part of the corpus.
