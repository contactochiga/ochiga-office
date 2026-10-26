# Stage 4C — atomic reservations (local candidate)

## Model and lifecycle
Office retains its existing catalogue_variants stock_on_hand/stock_reserved counters. New hardware_reservations (unique order), immutable reservation_lines, reservation_events and reservation_stock (legacy manual-reserved baseline only) reconcile against those counters. No separate inventory source is introduced.

A valid awaiting-confirmation order acquires a 15-minute held reservation atomically with checkout creation. held transitions once to released, expired or allocated. Expiry does not cancel the commercial order. Terminal holds cannot be renewed; a new checkout/order is required. Cancellation releases held quantities in the same transaction. Duplicate requests replay; conflicting keys/payloads fail.

A transaction-scoped PostgreSQL advisory lock (71404,4), deterministic row locks, stock constraints and deferred ledger/history checks serialize inventory changes. Multi-variant operations are all-or-none. Existing manual reservations are preserved. Direct counter/history tampering is rejected. This deliberately coarse lock requires throughput testing before high-volume release.

## Eligibility and payment boundary
Existing authoritative checkout validation checks publication, approved prices/version, confirmed in-stock variants, quantities and order state. Quote-only, supplier-sourced, withdrawn and unavailable items cannot hold physical stock. Browser prices are never authoritative.

Allocation consumes reserved and on-hand stock exactly once. The service-only hardware_reservation_payment_verified adapter always returns false in this stage. There is no payment endpoint or paid-state update. Allocation mechanics were exercised with a synthetic adapter inside a rolled-back transaction; this is not provider verification evidence. Stage 4D must bind durable server-verified payment evidence to order, hold, exact amount/currency, purpose/environment, confirmed delivery and current commercial eligibility. Late payments require explicit recovery/refund policy.

## Permissions
| Actor | Access |
|---|---|
| Guest integration | Existing scoped checkout only; owner-bound minimal receipt |
| Active staff | orders.read plus orders.create for hold; orders.read plus orders.cancel for release |
| Anonymous/authenticated Data API role | No reservation tables or functions |
| Service runtime | Transaction functions; immutable guards and ledger checks remain enforced |

No permissions or accounts are granted by this stage. No staff/browser allocation action exists. Existing customer privacy and CRM linkage remain unchanged.

## Migration and scheduler
Apply db/phase4c/20261026090615_hardware_reservations.sql explicitly AFTER accepted 20261108 Stage 4B migration. Its generated timestamp is earlier: never apply this directory by chronological filename sorting. Prior migration files are unchanged.

Run release/phase4c-gate/production-rollout-gates.sql before and after migration, then install db/phase4c/expiry-scheduler.sql and run scheduler-check.sql after the first scheduled tick. All gates must pass. pg_cron availability/preload and owner must be verified for a future release. No production setup was performed.

Database cron sweeps every minute, 500 holds per batch, independent of application uptime. Request paths also sweep. Deadlines are checked before allocation; the stock counter can conservatively lag expiry until cleanup. Monitor overdue holds and scheduler failures. OFFICE_HARDWARE_RESERVATIONS_ENABLED defaults OFF; Hardware and live payments remain OFF.

## Rollback
Before commit, migration transaction rollback restores the original schema (tested). After use, disable new checkout/holds and revert application commits, but RETAIN reservation schema, cancellation/expiry functions and cron until holds drain. Retain immutable financial/audit evidence permanently. Do not drop tables, revert stock counters manually or unschedule active holds. A destructive down migration is intentionally not supplied.

## Verification
npm run office:reservations:test uses disposable PostgreSQL/PostgREST/storage and synthetic credentials. TEST_CHECKOUT_WEB=true adds the real local GetOyi proxy. Tests cover races, duplicate requests, backend termination, restart, actual clock expiry with all Office processes stopped, manual adjustments, legacy counters, authorization, commercial eligibility, immutable history, migration rollback and schema tampering. No production calls are made.
