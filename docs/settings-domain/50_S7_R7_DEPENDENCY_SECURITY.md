# S7 R7 — Dependency Security Remediation (H5)

Baseline: R6 `e9d92e1`. Change commit: `2ec16f7`. Clean-checkout evidence: `s7-official-results/r7`. No production, migration, MFA, merge or deploy action.

## Finding and ownership
`npm audit` (before): 1 high — `follow-redirects` 1.16.0 (GHSA-q3jh-wrc6-jgq8: array-form headers bypass cross-origin credential stripping; GHSA-8r9p-f939-6h3c: `sensitiveHeaders` regex escaping can expose credential headers). Single path: `ochiga-office → axios@1.20.0 → follow-redirects@^1.16.0` (transitive; the repo does not depend on it directly). Exposure: outbound HTTP via axios (Supabase store client, bridges) following redirects.

## Change (lockfile only)
`axios@1.20.0` already allows `follow-redirects ^1.16.0`, and 1.16.1 is the newest published patch, so `npm update follow-redirects --package-lock-only` suffices:
`package-lock.json`: follow-redirects 1.16.0 → **1.16.1** (version, resolved URL, integrity; 3 lines). `package.json` unchanged; axios unchanged (1.20.0); no other package moved. `npm ls --all` shows exactly one copy (1.16.1) under axios. Compatibility: patch release within the declared range, engines `node >=4`; no API change.

## Results (clean checkout, `npm ci`)
- `npm audit`: **0 vulnerabilities** (was 1 high).
- Gates check/lint/build/security:secrets/deployment:validate: all exit 0.
- Full Office regression 83/83 (includes Supabase store, bridge, WhatsApp, Settings, Team, auth/MFA/session suites); PostgreSQL/PostgREST suites 14/14; frozen S7.5.9 cert 4/4.
- Frozen final-certification corpus (A, B, C) re-run unmodified: **identical failure counts to R6** — no new failure, no fix attributable to this change (a01 5, a02 7, a03 2, a04 4, a05 2, a06 13, a07 1, a08 18, a09 9, a10 1, a13 8; b1 2, b5 1, b6 2, b8 1; c01 8, c02 2, c05 8, c08 2; all others 0). Existing failures preserved; no expectation changed. Area D not re-run (no UI or auth change).
- Authentication behaviour is unchanged (no source file touched).
- Note: the helper script's per-file `exit=` column is unreliable (it reads `$?` after a command substitution — the defect disclosed in doc 42); the suite JSON counts above are authoritative.

## Remaining advisories / risks
None open in `npm audit`. Risk: a future axios or transitive change re-pins an older range; the lockfile pins 1.16.1 until then. Dependabot-style monitoring is an owner decision.

## Carried over, separately (not addressed by R7)
**R6 proxy/corpus adjudication** (doc 49): A03-044 and A03-081 assume forged forwarded headers define distinct clients (A03-081 also needs the Postgres profile, proven by c06); A02 failures (020/040/041-x4) come from the harness sending all traffic from one address once `X-Forwarded-For` is untrusted; area D (browser) not re-run after R6; `LEAD_AGENTS_TRUSTED_PROXY_HOPS` must be set by the owner after verifying the real proxy chain, and migrations `20261027`–`20261029` must be applied (staging first). Recertification needs a fresh independent corpus modelling trusted-proxy deployments.
**Production database audit** (doc 48): production exposure of `admin_users`/`password_hash` is still **UNKNOWN**; the owner must run `scripts/sql/production-data-api-exposure-audit.sql` read-only and apply `20261027`. 52 business tables still lack RLS (ROLE-210).
**Other open findings** from doc 47 (Medium/Low: token claim validation, CORS/500 detail/no-store, mailbox-code persisted counter, reset pending-token cap, UI items). S7 remains not certified; production recommendation stays NO-GO until the production audit result is known.
