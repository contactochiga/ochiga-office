# Office forward commerce integration

Production baseline: a47551741f2c104acb2646ba5fa07290b21ac864 (Office #90).
Integrated commerce/refund source: 41edabb6172ce659815f8b9fa38b7dca666c5d4a.
Local review only. No deployment, production migration or financial authorization.

The merge preserves deployed catalogue/packages/public projection, CRM intake and dependency lockfile byte-for-byte. Server routing gains the existing scoped commerce/customer endpoints and default-OFF email worker. Existing payment-confirmation and financial-operations scopes remain separate; refund staff cannot independently confirm payment. New review-branch automatic Vercel deployment is disabled. CRM/WhatsApp/intake startup and requests remain enabled normally; no global maintenance change.

## Ordered database release

`migration-manifest.json` is the source of truth:16 reviewed hashes. Step 16 (`db/20261110_catalogue_packages_hardening.sql`) is a follow-up that replaces only `catalogue_package_issues` and requires step 1; it is not an edit of the installed step 1, and its rollback is `db/rollback/20261110_catalogue_packages_hardening.down.sql`. `forward-baseline.json` records a read-only2November check on Office project metbajilbqclwjfsxfps. Package step1 was already installed as20261102114627, catalogue_packages_20261109; the accepted package SQL hash remains unchanged. Order, financial-observation and customer-outbox tables are absent. Do NOT rerun package migration.

`python3 release/commerce/plan-forward-migrations.py release/commerce/forward-baseline.json` produces a NON-EXECUTABLE plan: skip step1,15 pending separately authorized steps. This planner does not access credentials, databases or provider APIs. An inventory is reviewed evidence, not an authentication mechanism; refresh it before release.

Remaining order: orders → checkout → reservations → verified payments → financial operations → quote eligibility → fulfilment → delivery → service visits → customer progress → product-kind boundary → staff delivery before payment → customer access/notifications → refund completion. Preserve the exact manifest order, prerequisite extensions (including btree_gist/expiry scheduler prerequisites) and database roles. Do not sort filenames or run a blanket db push.

Idempotent release procedure, requiring separate authorization:
1. Verify the exact Office project, fresh recovery backup, deployment baseline, missing tables/functions, source hashes and original schema/security gates. Verify installed migration registry plus post-state, not names alone. Pin the14 forward migration version identities once in the reviewed execution record; never collide with ingestion timestamps.
2. Freeze the release manifest. Under a single migration operator/advisory lock, re-read migration history before each step. If the exact reviewed step is committed and passes its post-state gate, SKIP. If hash/state is different, partial or unknown, STOP; do not rerun blindly.
3. Apply only the reviewed step in a transaction with its migration-history record, bounded lock/statement timeouts and required privilege checks. On interruption, reconnect read-only and establish whether that transaction committed before proceeding. Never infer failure from lost acknowledgement.
4. Run each historical exact-definition gate at the stage it describes, before later wrappers intentionally change definitions. Run kind-boundary gate at12, delivery-first at13, customer-access at14, refund/customer/delivery gates at15. Gates are not weakened to accept unknown bodies.
5. Keep commerce/public/payment/notification switchesOFF through deployment and initial smoke checks. No synthetic records migrate to production. Backend has a separate two-step manifest/database review; GetOyi has no DB migration here.

## Local validation and safety

Existing actual PostgreSQL harness now accepts TEST_BACKEND_ROOT so paired tests use the reviewed Backend rather than a historical sibling worktree. The independent TEST_FORWARD_MANIFEST_ONLY profile builds a disposable package baseline, applies14 steps in order and checks resume/checksum refusal; its private rehearsal receipt table is NOT a production schema proposal. Test environment contains synthetic data only, mocked provider, no production credentials or provider requests.

Evidence:709/709 integrated PostgreSQL catalogue/order/payment/financial/fulfilment/delivery/customer checks;27/27 ordered migration checks;12/12 planner checks. Focused Office routing, scopes, packages, CRM intake, WhatsApp signature and UI tests pass. 27/27 refund migration/ownership/notification/CRM/stock/recovery tests use a network-none clone of the accepted synthetic paid-order snapshot; historical file remains unchanged. Exact logs and final counts reside in getoyi-commerce/production-release/evidence/forward-integration-2026-11-02.

## Forward recovery

Retain a475517 application artifacts and installed schema as the ordinary pre-commerce Office fallback, with explicit current-environment comparison and retained-artifact eligibility checks before release. Do not downgrade to c95cc73. Once financial records/events exist, a475517 is not a complete financial worker: disable new checkout/initialization/refunds, retain durable evidence/outboxes and a reviewed commerce-capable reconciliation runtime. Recover forward without deleting records, resetting budgets or replacing current CRM data with an old whole-database snapshot. Refund down migration refuses after completion notifications exist. No down migration is part of normal application rollback.
