# AREA C corpus: database, service-role boundaries, multi-instance, mixed-version, failures

Independent first-contact security tests for the Ochiga Office authentication/MFA system, written from the contract
(`docs/settings-domain/19..35`), the generic requirements checklist and general security principles. No SUT module is imported:
the server is started as a child process (through a private symlink directory, so the SUT is never written) and driven over HTTP;
databases are disposable Docker containers (plain Postgres 16, Supabase Postgres 17 + PostgREST v14.12).

## Running
Each file is standalone: `node <file>` (needs Docker, Node >= 22). Locate the SUT with `SUT_DIR` (default: three directories up) and the
previous release with `SUT_OLD_DIR`. Convenience wrapper while developing: `./run.sh <file>` (sets both to /Users/ochigaidoko/s7-eval/{src,old}, 590 s limit).
Output: one `FAIL <id> text :: evidence` line per failed check, `INFO ...` lines for documented limitations, and ONE final JSON line
`{"suite","area","checks","failed","failures"}`. Exit 0 = all checks pass, 1 = failed checks, 2 = infrastructure problem (`BLOCKED: reason`).

## Libraries (no tests)
- `lib.js`      harness (Suite), Docker stack (DbStack: plain16 / supabase17 + PostgREST), psql sessions (one process = one connection), advisory-lock barrier for true
                parallel connections, controllable HTTP fault proxy (also plays the Supabase gateway), AppServer launcher, HTTP client, RFC 6238 TOTP / RFC 4648 base32 /
                JWT / scrypt written here, account seeding and MFA enrolment drivers.
- `dbtools.js`  catalog digest, table digests, rich fixture data, list of authentication tables and functions.

## Files and coverage map
(updated after every file)
| file | area | checklist items |
|---|---|---|
| c01-migrations-plain16.js | plain Postgres 16 | migration ordering guards, idempotence (whole-set, single-file, out-of-order), additive behaviour on existing accounts, table constraints, cascade / deleted-and-recreated accounts, rollback scripts (non-destructive, repeatable, re-appliable), privilege defaults after rollback |
| c02-roles-privileges.js | Supabase PG17 | RLS on every authentication table, anon/authenticated/PUBLIC privileges from the catalog, SET ROLE probes, function EXECUTE grants, service-role boundary |
| c03-postgrest-boundary.js | PG17 + PostgREST | Data API with signed JWTs for anon / authenticated / service_role: table reads and writes, /rpc calls (cached plans), token forgery, request shapes |
| c04-atomicity-replay.js | PG17 + PostgREST + app | single use under 16-25 parallel connections (TOTP step, recovery code incl. revoking form, challenge, WebAuthn counter, credential activation/replacement/limit/last-factor, session generation, session digest, administrator reset, MFA failure counter, setting compare-and-set + history chain); fault-injection rollback of every multi-step function; deadlock hunt (consume vs activate / revoke / reset / regenerate, plus a deterministic interleaving); the same single-use rules through the real server (TOTP replay, recovery replay, enrolment race, logout, revoke-all, setting write, administrator reset) |
| c05-database-failure.js | real app + fault proxy | gateway down / reset / hang / 500 with leaked connection strings / HTML 502 / garbage: sign-in, MFA verify, authenticated requests, logged-out cookie, step-up, logout (honesty), no internal detail, bounded time, recovery without restart, code not burned; selective lying dependencies (revocation list, factor list, step consumption, recovery function, revoke write, account table, audit write, settings, capability probe); slow database; paused Postgres |
| c06-two-instances.js | 2-4 real app instances | logout / revoke-all / password change / deactivation / administrator revoke honoured across instances, restart persistence, TOTP + recovery + enrolment races across instances, MFA lock shared, settings (stale version, race, session duration, step-up grant purpose), administrator reset, enforcement-policy cache, login throttle shared across instances |
| c07-mixed-version.js | previous + current release | logout across releases (limitations as Info), account-wide revocation / password change / deactivation across releases, MFA replay / recovery race / lock across releases, settings race; database one migration behind, online application of the migration, rollback of the migration under a running release (fail closed) |
| c08-redaction.js | real app + full DB scan | real flows, then every column of every table, every audit row, every response, every log (app, Postgres, PostgREST) searched for passwords, keys, TOTP secrets (3 encodings), recovery codes, cookies, session ids, grants, challenges, invitation token, and for their unsalted hashes; one-time secrets returned only once; no echo of submitted values; audit field names |

Helpers added for c04-c08: `appfix.js` (stack + proxies + app instances + account fixtures), `par.js` (parallel-connection barrier with clean per-worker output).
