# Stage 4E local engineering report

Status: local mocked-provider regression PASS. Phase4 production release, public Hardware and live payments/refunds NO-GO.

## Implemented
- Durable provider observations and Office delivery queue with immutable event hashes and replay-conflict rejection.
- Recovery checks pending/overdue, provider failures/timeouts, evidence mismatch, Office persistence retry, late/cancelled order payment, disputes/reversals; existing Stage4D verified confirmation remains the sole allocation authority.
- Full-refund request + separate approval, including super-admin self-approval denial. Database leases serialize provider initiation; intent commits before POST. Unknown outcomes recover through provider lookup without repeating initiation. Pending/processed, failed, partial and uncertain outcomes retain immutable evidence; no automatic restock.
- Products-local Orders & payments workspace, scoped actions, reconciliation notes, targeted existing Office notifications. Notes never certify funds returned. Guest status labels distinguish provider processing from arrival at the bank.
- Compatible dependency lock updates: axios, follow-redirects, body-parser, proxy-addr, engine.io. No wallet financial source change.

## Evidence
- Complete disposable PostgreSQL/PostgREST order/checkout/reservation/payment/recovery suite: 272/272 PASS, including actual expiry waits, concurrent independent SQL connections, rollback/reapply and 10 Stage4E schema tamper cases.
- Backend payment suite: 18 validation, 9 real HTTP wallet-boundary and 6 signed HTTP webhook assertions PASS.
- Wallet regression smoke: 23 PASS. Backend release-closure smoke: 55 PASS. These are bounded targeted suites, not a claim that every repository script ran.
- Office catalogue API/model/public, CRM intake, scoped credentials and order boundary suites PASS; 8 new real HTTP financial checks + 7 authorization/storage assertions; 6 Office DOM checks PASS.
- GetOyi checkout unit/cart DOM/payment suites PASS; updated payment UI 11 assertions; lint and production build PASS. Build and tests remain local.
- Migration manifests and rollback hashes verified. Exact schema gates include ownership, execution grants, RLS, function definitions/search paths, constraints and immutable triggers. Baseline Stage4A–4D gates run before Stage4E; Stage4E manifests are new review candidates, not approved production gates.

## Limitations and release blockers
1. No real Paystack calls were made. User confirms no dedicated test setup exists; wallet production credentials/webhook must not be reused. See PROVIDER-ISOLATION.md for names, routes and approval requirements.
2. Current callback allowlist targets production GetOyi only: isolated callback support must be explicitly reviewed before provider rehearsal. No production callback tested.
3. Paystack transaction-dispute endpoint documentation has an object response; ambiguous/no-dispute contracts fail closed. Actual provider refund/search/dispute contracts, webhook delivery/retry, merchant balance/refund behavior and real network timing remain unverified. Mocked evidence does not close these gates.
4. Dependency audit improved from 1 Critical/9 High/3 Moderate to 0 Critical/5 High/3 Moderate. Remaining AWS/UUID, discovery/IP and Zod findings are not waived. Major-version upgrades were assessed as requiring separate compatibility work, not applied blindly.
5. Full refunds only. Partial/failed/disputed payments escalate. No automated acceptance/closure of disputes, manual assertion of funds returned or automatic inventory restock. Historical dispute observations conservatively block approval pending governed resolution; that resolution workflow is not implemented.
6. Financial list currently displays the latest observation and history, with a 100-order limit; broader operational pagination/search and explicit dispute resolution are follow-up operations work before scale. No new standalone finance system.
7. Hosted Supabase advisors were not run against production. Local exact-schema and adversarial database tests passed; hosted/performance advisor review remains a release preflight.
8. Recovery scheduler and operational monitoring still require deployment review. No jobs/configuration were provisioned. Production Phase3 independent approval/release/withdrawal test remains mandatory before public activation.

## Migration/rollback
Apply Office and Backend Stage4E migrations only after the accepted Stage4D baseline, each transactionally and only with separate release approval. Hashes are in each repository's release/phase4e/hashes.json. Pre-use down migrations tested and retain Stage4D. Rollback refuses when Stage4E facts exist: keep schema/history, disable new initiation and retain/drain recovery. Do not revert to a worker that strands in-flight refunds. No production migration was performed.

## Verdict
- Continued local engineering review: GO with explicit limitations above.
- Real provider test execution: BLOCKED pending approved isolated configuration and callback support.
- Phase4 production release / public activation / live payments: NO-GO.
