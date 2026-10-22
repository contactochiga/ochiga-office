# S7 R6 — Authentication and Recovery Security (H2, H3, H4)

Baseline `7ce99c8` (R5). Runtime evidence commits: `2b72b79`, `666a6ef` (+ this document). Clean-checkout evidence under `s7-official-results/r6`, `r6b`. Nothing was merged, deployed, migrated in production, or MFA-enforced.

## Root causes and bounded fixes
**H2 — deadlock (recovery code vs activation/reset).** `office_mfa_consume_recovery_code_revoking` updated the recovery-code row first, then `admin_users`. Activation, reset, factor revocation and code regeneration lock `admin_users` first, then delete code rows. Opposite order => SQLSTATE 40P01. Fix: the consumer now takes `admin_users ... FOR NO KEY UPDATE` first (one lock order everywhere). Same single statement semantics: valid code consumed AND generation bumped atomically; invalid/used/foreign code => no row, no change; concurrent use of one code => exactly one winner. Delivered as `db/20261029_mfa_lock_order.sql` (+ non-destructive rollback restoring the old definition) and the same definition in `20261024` so re-applying that older file cannot reinstate the deadlock.

**H3 — client-supplied X-Forwarded-For was the rate-limit identity.** `src/lead-agents/client-address.js` is now the only reader of the header. `LEAD_AGENTS_TRUSTED_PROXY_HOPS` = number of proxies *we operate* (default 0 = header ignored, TCP peer used; invalid value => 0 and reported). With N hops the N-th entry from the right is used; short chains, garbage and free text fall back to the peer address; ports/IPv6/mapped forms normalised. Rate limiter, login keys and audit records use `req.clientAddress`. Counters for login (address and per-account failure), step-up, MFA login, enrolment and reset are now `SharedRateLimiter`: Postgres-backed (`db/20261028_shared_rate_limits.sql`, atomic upsert, RLS on, service_role only, keys are HMAC digests, no e-mail/address stored) so all instances share one budget. Without the migration or with the file store the scope is **per-process and `/healthz` says so** (`rate_limit.scope`). A store failure is fail-closed (503), never "allow". The public widget/office limiters remain per-process (out of scope).

**H4 — `/session/password` unthrottled.** Now bounded by (a) address+account budget and (b) a per-account wrong-password budget shared with step-up (default 10 per 15 min, failures only, cleared by success). Answers stay generic: 401 for wrong, 429 once spent (also for the correct password), no account data in refusals.

## Tests (all new, no frozen file changed)
- `scripts/test-auth-boundary-r6.js` (38): address resolution unit cases, forged/rotating headers with and without a trusted hop, `/session/password` and step-up bounds, audit not recording forged addresses, `/healthz` scope.
- `scripts/test-recovery-lock-postgres-r6.js` (34): reproduces H2 on the pre-fix function, then 4 race scenarios x 12 rounds with 0 deadlocks, exactly-once generation bump, single use under 12-way race, privileges retained, rollback/re-apply.
- `scripts/test-shared-rate-limit-postgres-r6.js` (33): two instances share one budget, 40-way concurrent burst => exactly 10 pass, expiry, namespaces, digest-only storage, anon/authenticated denied, fail-closed with gateway down, rollback.
- Existing tests updated with comments where they encoded the removed behaviour: R1 F1 (now models one trusted proxy hop), S7.2 line 173 (password prompt shares the per-account budget).

## Regression (clean checkout; final `666a6ef` unless noted)
Gates check/lint/build/security:secrets/deployment:validate = 0; full suite 83/83; Postgres suites 14/14 (includes R5 and the two R6 suites); frozen S7.5.9 cert 4/4; `npm audit` still 1 high (H5).
Frozen final-certification corpus re-run unmodified (first-contact counts in doc 47 → now): c04 3→**0**, c06 2→**0**, c03 17→**0**, c02 75→2, a13 31→8, a03 9→**2**, b9 1→**0**; unchanged: a01 5, a04 4, a05 2, a06 13, a07 1, a08 18, a09 9, a10 1, c01 8, c05 8, c08 2, b1 2, b5 1, b6 2, b8 1. Not re-run: area D (browser; no UI change) — D5a's spoofed-header check is therefore unverified this round.
**Failures that got worse or remain because of this change — disclosed, expectations not relaxed:**
- A03-044 (correct step-up password "from another address" must work) and A03-081 (instance B throttled by A): the corpus assumes forwarded headers create distinct clients, which is the trust H3 removes; A03-081 additionally needs the Postgres profile (the file-store profile is per-process by design; the Postgres profile is proven by c06 X-803/804 and R6L-302).
- A02 1→7 (A02-020, 040, 041-x4): the harness sends hundreds of requests from one address with rotating forged headers; with the header ignored they share one budget, so the limiter answers 429 and timing parity/reset-parity checks see throttled responses. Not an enumeration oracle (existing and unknown e-mails are counted identically by key), but the checks fail as written. A02-046-1 (null body => 500) is unchanged Medium.
- c01 MIG-207/527 appeared transiently in the first R6 run (re-applying `20261024` reinstated the old consumer); fixed as described and back to the original 8.
A deployment-shaped rerun of the corpus with proxies configured would need a corpus revision by independent authors; I did not modify it.

## Operational dependencies
1. Apply `20261028` and `20261029` (after R5's `20261027`) to staging then production; until `20261028` is applied counters are per-process, visible in `/healthz`.
2. Set `LEAD_AGENTS_TRUSTED_PROXY_HOPS` after verifying how many proxies append to X-Forwarded-For (Render is not assumed). Left at 0, all clients behind a proxy share the proxy's address: the per-address budget then becomes effectively per-account, so one account can be throttled by anyone but other accounts cannot. 0 is safe against spoofing, not optimal for multi-user fairness.
3. No code change is needed to roll back migrations; counters are ephemeral.

## Remaining certification blockers
H5 `follow-redirects` 1.16.0 (high advisory, unfixed here, separate). H1 production state still UNKNOWN (R5). Medium and others from doc 47 untouched: mailbox-code persisted failure counter (F7.30), token claim validation (A06), CORS/500 detail/no-store headers (A08, c05, c08), reset pending-token cap, edge-token identity adoption, step-up body parity, UI items (area D), remaining RLS on 52 business tables (c02 ROLE-210). S7 is not certified; recertification needs a fresh independent corpus that models trusted-proxy deployments.
