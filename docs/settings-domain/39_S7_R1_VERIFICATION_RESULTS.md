# S7 remediation R1 — verification results

Final commit verified: `4c8c86ca9e02609d892c258ebeb00dd0430af16f` (clean checkout, complete run, 900 s per suite). Frozen baseline: `scripts/cert/*` and the S7.5.9 manifest/report are byte-identical to `6de41b0` (verified by manifest digests and an empty `git diff`).

| | Run 1 (`7e165ca`) | Run 2 (`4c8c86c`, final) |
|---|---|---|
| Gates (`check`, `lint`, `build`, `security:secrets`, `deployment:validate`) | 5/5 | 5/5 |
| Frozen certification suites, unchanged: auth-session 153, MFA lifecycle 213, database 239, browser 76 (681 checks) | 681/681 (previously 677/681) | 681/681 |
| Office regression (80 suites incl. S7.0–S7.5.8, Team permissions, WhatsApp autonomy, Settings S1–S6, new R1 suite) | 79/80 | **80/80** |
| Postgres / PostgREST suites | 10/10 | 10/10 |

**Failures recorded.** (1) During development: two S7.0 assertions encoded the defects (correct password succeeded under throttle; deactivated user answered 403): corrected with comments. (2) Run 1: `test-mfa-webauthn-s755.js` failed in the complete run, passing 3/3 alone: an intermittent **test** defect from S7.5.5 (it asserted that a 32-byte hash, decoded as text, contained no `@`; a random byte equals 0x40 in about 12% of runs). Fixed in `4c8c86c` to assert what was meant (32-byte handle that does not contain the e-mail); passed 6/6 alone and in the complete run 2.

**Certification findings.** F-1, F-2, F-3, F-4: closed (the four frozen assertions pass unchanged). Still open, unchanged by R1: F-5 logout denylist (Medium), F-6 mixed-version rollout (Info), F-7 browser-suite harness flake (Low; did not recur in run 2), the `axios` dependency advisory (High, production blocker), and the production-owner actions listed in the S7.5.9 report. New observations recorded in the R1 contract §5: per-address key still trusts the first `X-Forwarded-For` element (bounded by the per-account ceiling); limiter counters are per process (N instances ⇒ up to N× budget); synchronous scrypt blocks the event loop ~35 ms per hashed attempt.
