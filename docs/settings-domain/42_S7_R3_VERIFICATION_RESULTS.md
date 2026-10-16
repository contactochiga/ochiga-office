# S7 remediation R3 — browser test reliability: results

Baseline (frozen before implementation): `41_S7_R3_BROWSER_RELIABILITY_BASELINE.md` (`8f1a632`). Final verified commit: `3a80d13a1e8af8026472e1794381fecfb478122a` (clean checkout, `npm ci`, complete run with the new in-repo runner).

## 1. Root cause and correction (summary)
Suites sent `Page.navigate` for the next URL before the previous `about:blank` navigation had committed; a URL differing from the still-committed page only by its fragment is then a same-document navigation that is silently dropped when `about:blank` commits, and its CDP call never answers. Long-lived EventSource requests make the window wider. Fixed in `scripts/lib/browser-harness.js` (settled navigation/reload, fragment-only handling, marker-based commit detection, one counted bounded recovery, `BROWSER_HARNESS_STRICT=1` to fail on any recovery), isolated browsers on Chrome-chosen free ports (no fixed ports; the 9353 duplicate is gone), process-group shutdown that waits for helpers and removes profiles, and `scripts/run-all-tests.js` with explicit per-suite budgets (default 180 s, browser 300 s, MFA UI 900 s, Postgres and certification 900 s; `RUN_TIMEOUT_SCALE`). Test bodies and assertions are untouched (diff review: only port, launch, `send` and cleanup lines changed in the 14 adopting suites; `scripts/cert/cert-browser.js` was restored byte-for-byte because it belongs to the frozen corpus; the manifest digests match).

## 2. Stability validation (strict mode: any navigation recovery would have failed the run)
| Scenario | Baseline (before) | After |
|---|---|---|
| Idle host, `test-settings-domain-browser` | 10/12 pass (16.7 % failed) | **30/30**, 0 recoveries, max navigation 165 ms |
| Other 11 browser suites, idle | 66/66 | 36/36 (12 suites × 3 sequential rounds), 0 recoveries |
| Parallel: 7 concurrent browsers (6 suites + a second copy of settings-domain), 3 rounds | not possible (fixed ports) | **21/21**, 0 recoveries, max navigation 1100 ms under 7-way contention, 0 browser processes left |
| Constrained CPU: 8 busy loops on 8 cores | not measured | **19/19** (domain ×12, step-up ×4, relationship ×3), 0 recoveries, max 158 ms |
| Constrained memory: 9.6 GB resident hog on a 16 GB host | not measured | **13/13** (domain ×10, session-policy ×3), 0 recoveries, max 178 ms |
| Complete suite load (the full regression, below) | one domain failure in several complete runs | 81/81 |
Browser crashes: none observed. Open handles: every suite exited by itself within its budget. Cleanup: 0 leftover browser processes swept after every suite once the shutdown waited for the process group (one leftover helper was seen before that fix, in the harness's own test). The three failures seen during validation were not product or navigation failures: the harness's own test inherited the strict flag while deliberately provoking one recovery (fixed), counted here for completeness. `test-mfa-ui-browser-s758.js` now takes about 22 s instead of about 500 s with the same 19 journeys and assertions.

## 3. Complete regression on the clean checkout (true exit codes)
| | Result |
|---|---|
| Gates (`check`, `lint`, `build`, `security:secrets`, `deployment:validate`) | 5/5 |
| Frozen S7.5.9 certification suites (681 checks), unchanged | 4/4 |
| Office regression: S7.0–S7.5.8, R1, R2 verification, Team permissions, WhatsApp autonomy, Settings S1–S6, harness test (81 suites) | **81/81** (one deliberate recovery, in the harness test) |
| Postgres / PostgREST suites | **10/10** (after the fix in §4) |
| `npm audit` | 0 vulnerabilities |

## 4. Correction notice: earlier Postgres results were wrong
**What happened.** From S7.5.7 onward my Postgres loop recorded each suite's status with `echo "$(basename $f) exit=$?"`; `$?` was read after the command substitution, so every Postgres line said `exit=0` regardless of the real result. The "Postgres/PostgREST 10/10" statements in the reports for **S7.5.7, S7.5.8, S7.5.9 (certification report, regression table), R1 and R2** were therefore **not supported by their runs**. (The Office-suite loops, the gates and the certification-suite loops used direct exit codes and are not affected; the independent `cert-database` suite, which verifies database security, is not affected and passed.)
**What was actually true.** Bisected with real exit codes: the Postgres suites pass at `d0cd0ba` (S7.5.6) and four of them fail from S7.5.7 (`c0666f7`) onward: `test-mfa-login-postgres-s753`, `…-management-postgres-s754`, `…-webauthn-postgres-s755`, `…-stepup-postgres-s756`. Cause: since S7.5.7 sign-in reads the MFA enforcement setting and fails closed (`503`) when it cannot be read; those four test databases never created `office_runtime_settings` (an S3 table every real deployment has). It is a **fixture defect**, not a product regression: no product code changed. Fixed in R3 by applying `20261014_office_runtime_settings.sql` and `20261019_office_runtime_settings_versioning.sql` in those fixtures. The new runner reports true exit codes, which is how this surfaced.
**Operational note.** Because the enforcement read is fail-closed, an environment that has MFA on but lacks the S3 runtime-settings migrations cannot sign accounts in; they are already a prerequisite (S3), and the S7.5.7 preflight checks the machinery, not that table.

## 5. Remaining failures and open items
None in the regression. Unchanged and still open from earlier reports: F-5 logout denylist, F-6 mixed-version rollout, the R1 observations (per-process limiter, first `X-Forwarded-For` value, synchronous hashing) and the production-owner actions. The `test-settings-providers-browser` flake class of `18_PROVIDERS_BROWSER_FLAKE_INVESTIGATION.md` did not recur in 6 baseline + strict runs; the harness removes the unsettled-navigation race it shares.
