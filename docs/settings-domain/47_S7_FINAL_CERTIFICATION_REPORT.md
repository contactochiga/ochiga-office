# S7 Final Independent Security Certification — Report

**Verdict: S7 INDEPENDENT SECURITY CERTIFICATION FAILED — REMEDIATION REQUIRED**

- Runtime commit under test: `fbac5ad1f90b2aa3a5ae867c1f7d2b3ca0098d9e` (no runtime, migration, dependency or production-config change in this task).
- Protocol: doc 45 (`72444a2`). Corpus: 70 files, SHA-256 manifest in doc 46 (`d489c45`), frozen before the official run. Official run on a clean checkout at `d489c45` with `npm ci`.
- Authors were independent fresh agents, given no earlier certification utterances, remediation tests or answers. No production accounts or credentials were used.
- Disclosures: (1) macOS purged `/tmp` mid-task, destroying author staging; the corpus was re-commissioned under a durable path before freezing. Committed work was unaffected. (2) An earlier Postgres runner recorded false exit codes (fixed in R3, doc 42); this run used the corrected runner and direct exit codes.

## First-contact corpus results (frozen corpus, official run)
Passing files: a11, a12, b2, b3, b4, b7, c07, d2, d4, d6a, d7b, d7c. All other files had failing checks (counts in `s7-official-results/corpus-*.out`):
A: a01 5, a02 1, a03 9, a04 4, a05 2, a06 13, a07 1, a08 18, a09 9, a10 1, a13 31. B: b1 2, b5 1, b6 2, b8 1, b9 1. C: c01 8, c02 75, c03 17, c04 3, c05 8, c06 2, c08 2. D: d1 4, d3 26, d5a 3, d5b 10, d6b 1, d6c 3, d7a 1, d8 6.
**d5c**: first run BLOCKED (exceeded 9-minute budget under load; counted as blocked, not passed). Serial re-run with `SUT_DIR` set (my first re-run omitted it and failed to locate the server; that was my invocation error): 117 checks, 15 failed (same UI classes as d5b). Both logs kept.

## Adjudication caveat
Failures were adjudicated by class, not check by check; no failing check was relaxed or reclassified as a test defect. Classes below are what the evidence supports; individual low-value checks (cache headers, overflow) may merit a per-check pass during remediation.

## Findings
**High (unresolved)**
- H1. Bootstrap schema (`db/lead-agents-schema.sql`) creates `admin_users` and related tables without RLS/privilege restriction. In the disposable PostgREST fixture, `anon` and `authenticated` read `admin_users` including `password_hash` (c03 API-101/102/103; c02 75 and a13 31 failures). Production hardening is out-of-repo, so production exposure is unverified: owner must confirm. Would be Critical if production matches the fixture.
- H2. Deadlock between recovery-code consumption and credential activation / administrator reset (c04 DL-001/004/010; Postgres 40P01). Legitimate recovery or reset can fail, so users can be locked out.
- H3. Throttle bypass by forged/rotating `X-Forwarded-For`: login per-address budget (A03-023/025), step-up password guessing (A03-041, d5a.116), mailbox-code guessing (F7.30), reset issuance (A03-051/052, 60 pending tokens), B9 Z3.2.
- H4. `/session/password` current-password guessing is unthrottled (A03-040).
- H5. Dependency `follow-redirects` 1.16.0: two high advisories (`npm audit`).

**Medium**: session-token claim validation gaps — string/object `exp` accepted, token without user-id claim accepted (A06); MFA downgrade/handling of malformed factor lists; edge-token can edit a human account sharing its identity (A05-320); CORS reflection and 500 responses with internal detail (A08, c05); credential-bearing responses not `no-store` (A01-021, c08 RED-324/325); sign-in with failed audit write returns half-state 200 (A07-137); attacker-controlled link origin outside production (A10-123); enforcement change audit lacks old/new level (B8 N3.3); step-up answer oracle (B6 S7.2); orphaned credential rows after permanent deletion (B1 LC8.3); per-process limiter not shared across instances (c06 X-803; documented limitation); migration bootstrap issues (c01 MIG-001 etc.).

**Low / UI**: session-end UI does not return to sign-in with a visible reason, dialogs left open over sign-in (d5b, d5c); touch targets under 44 px at 768 (d1); horizontal overflow at 390 (d6b, d6c, d7a); focus return in dialogs (d8); enrolment/step-up messaging (d3).

No confirmed authentication bypass, cross-account credential exposure via the application, or replay/revocation bypass was demonstrated by the passing a07/a11/b-series within the contract, but H1 and H3/H4 prevent certification.

## Regression (clean checkout `d489c45`, corrected runner)
- Gates: check, lint, build, security:secrets, deployment:validate — all exit 0.
- `npm audit`: 1 high (follow-redirects) — fails the zero-high criterion.
- `--cert` (frozen S7.5.9): 3/4; `cert-browser` failed once under concurrent load (waitFor timeout, exit 2), then passed 3/3 serial re-runs. Recorded as a load-sensitive flake, original failure retained.
- Full suite 82/82; Postgres suites 11/11.
- Browser journeys at 1440/1100/900/768/390 were run by area D (see findings).

## Known limitations
Class-level adjudication; d5c blocked on first run; per-process limiter; Postgres fixtures are disposable and may differ from production grants.

## Production-readiness blockers / owner actions
Verify production RLS/grants on `admin_users` and all credential tables (H1); remediate H2–H5; fix Medium items; then recertify with a fresh corpus. Do not enable MFA enforcement meanwhile.

## Evidence commits
`72444a2` (protocol), `d489c45` (corpus + manifest), this report. Raw logs: `/Users/ochigaidoko/s7-official-results/`.
