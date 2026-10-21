# AREA A test corpus (authentication, throttling, enumeration, sessions, logout, headers, tokens)

Run a file standalone: `SUT_DIR=/Users/ochigaidoko/s7-eval/src SUT_OLD_DIR=/Users/ochigaidoko/s7-eval/old node <file>`
Each prints `FAIL <id> <text> :: <evidence>` lines and ends with one JSON line `{"suite","area","checks","failed","failures"}`.
Exit 0 = all pass, 1 = failed checks, 2 = BLOCKED (infrastructure). Each file starts its own server(s) from a private symlink copy of the SUT
(`/tmp`-style temp dir, removed in `finally`), on ephemeral ports, with a private file store.

Helper: `a-lib.js` (suite runner, server launcher, HTTP client with per-request unique X-Forwarded-For unless `{rotate:false}`, TOTP/base32, token minting, scanners).

## Files and coverage (updated after every file)
| file | checklist items |
|---|---|
| a02-enumeration.js | account enumeration by status/body/headers/timing/throttle symmetry (login, reset request, reset confirm, invite accept, mfa/verify) |
| a03-throttle.js | login throttling: burst, correct password after threshold, XFF + other forwarding headers, per-account cap, concurrency, window expiry, step-up / password-change / reset-request guessing, general API limiter, two instances |
| a04-reset-invite-password.js | reset + invitation flows (single use, expiry, tamper, concurrency, no session from reset, neutrality), password change / admin set effects, privilege boundaries, link origin, secrets in audit/store/logs |
| a05-apikey-edge-matrix.js | API-key and edge-token restrictions on every human-account/session/step-up/MFA/settings route (30 routes x 12 credential styles), error codes, state integrity, edge identity adoption |
| a06-session-tokens.js | forged/edited/truncated/extra-segment tokens, wrong signing keys, claim handling, legacy forms, expiry boundary, cookie parsing |
| a07-logout-revocation.js | logout (copied cookie, other sessions survive, idempotent, persisted across restart), revoke-all, administrator revocation + step-up, deactivate/restore/remove/recreate, live permission changes, S7.3 duration, reject-legacy flag, storage-failure honesty |
| a08-headers-cors-errors.js | CORS (allow-list, default), cache + security headers on auth responses, path/method oddities, malformed bodies on every mutation route, public-route boundary |
| a09-anonymous-sweep.js (+routes.json) | unauthenticated sweep of ~226 routes x 5 methods in production mode and in fail-open-prone modes (unset/typo/off) |
| a10-config-states.js | production readiness + invalid secrets (10 cases), ephemeral secret, API-key-as-password flag, admin recovery (env only, no HTTP route), TTL clamp, revocation switch, step-up TTL clamp, cookie name, canonical origin |
| a11-mfa-downgrade.js | downgrade attempts against enrolled accounts (password-only, challenge misuse, omitted/altered claims, legacy forms, MFA off/on, invalid key, throttling, carry-over, secrets) - needs ~50 s (TOTP windows) |
| a12-mixed-version.js | previous release (SUT_OLD_DIR) beside the latest: token/grant compatibility, honest logout answers, documented limitations as INFO |
| a13-postgres-multi-instance.js (+a-pg.js) | Docker Postgres+PostgREST: instances/releases sharing a database, atomic claims, data-API exposure of auth tables, injected database failures (fail closed/honest/no detail), timeouts, outage, migration-absent mode - needs docker; ~2-3 min |
| a01-password-login.js | password authentication, session issuance, cookie attributes, token structure, API key as password, malformed inputs, inactive/removed/invited cannot sign in, concurrency, secrets in logs |

## Status log
- a01..a07 written and smoke-run against /Users/ochigaidoko/s7-eval/src.
- a08..a13 written and smoke-run. Final smoke results (src): a01 101/5, a02 81/1, a03 54/9, a04 111/4, a05 450/2, a06 129/13, a07 113/1, a08 103/18, a09 16/9, a10 162/1, a11 115/0, a12 19/0, a13 148/31 (checks/failed).
- NOTE: a-pg.js starts uniquely named containers `a-pg-<pid>-<rand>-db/-rest` and a network; cleanup runs in `finally` and on process exit.

## Running notes: candidate findings seen so far (details in the final report)
- a01: no Cache-Control on login/me; trailing NUL accepted in password (scrypt quirk); JSON null / odd password object -> 500 with internal message.
- a02: clean (login/reset neutral; timing symmetric).
- a03: per-address budget bypassable via X-Forwarded-For (account cap 50 still holds, also under concurrency); no throttle on /session/password; step-up throttle bypassable by XFF; reset-request flooding unbounded; general API limiter spoofable via XFF; limiter per process (two instances).
- a04: reset issuance response returns token_hash; expires_in_hours junk -> 500; token given as JSON array accepted.
- a05: edge token acts as the human account whose e-mail is edge-agent@oyi.local (profile/photo).
- a06: malformed %-escape in Cookie -> 500 "URI malformed" on every route; duplicate cookie name order dependence; token without user_id accepted; type-lax exp/sg (needs secret).
- a07: file-store write failure -> login 500 leaks filesystem path.
- a08: no Cache-Control on most auth responses; no CSP/XFO/nosniff/Referrer-Policy; default (no allow-list) CORS reflects any origin with credentials; reset/request JSON null -> 500.
- a09: only unauthenticated 500s (session/photo, session/profile) in non-required auth modes; /healthz exposes store statistics and auth config to anonymous callers.
- a10: dev-mode reset/invite links follow X-Forwarded-Host when OFFICE_APP_URL is unset.
- a11: clean (MFA downgrade paths all closed); INFO lines for declared downgrades.
- a13: **auth tables (admin_users, admin_invites, password_reset_tokens, audit_events) have no RLS / revoked grants in the shipped schema: anon + authenticated roles can read, update, insert, delete them through the Supabase data API (default grants).** Library error text ("Request failed with status code 503", "socket hang up") returned in 500 answers on DB failure; malformed 200 reply from the data API is reported as 401 instead of 503.
