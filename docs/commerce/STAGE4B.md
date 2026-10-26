# Stage 4B — local guest order requests

## Scope and authority

GetOyi cart and guest input submit to Office's existing catalogue, CRM and Stage 4A ledger. These are non-payable order requests, not payment intents. Product totals are checked in integer NGN kobo. Inclusive VAT is rounded once per line. Delivery and payable totals remain NULL; no stock is reserved, no card is collected and no paid/fulfilled transition exists.

Migration `db/20261108_hardware_checkout.sql` follows the reviewed, still-local `20261107_hardware_orders.sql`. It adds an immutable receipt table and three SECURITY INVOKER functions with a pinned search path. Anonymous/authenticated Data API access is revoked. The service role follows Office's existing CRUD grant policy; receipt updates/deletes/truncation are rejected by immutable guards. No existing foundation function or resident-wallet table is replaced.

A quote locks products, variants and their public listing; requires the current public version, approved published product/variant and independently approved published matching price; rejects withdrawn, inactive, supplier-sourced, made-to-order, discontinued and insufficient-stock variants. Submission repeats these checks in its transaction and compares the authoritative quote hash. Browser totals, tax, stock, state and CRM IDs are not accepted.

A receipt is unique to integration client + server-derived guest hash + idempotency key. An advisory transaction lock serializes duplicate requests. Identical retries return the committed order before revalidation; altered payloads conflict. The order, private customer/delivery snapshot, immutable priced lines/options, CRM contact, opportunity, activity, Office audit and receipt commit together. Rejected transactions leave none of these partial records. Guest details are explicitly unverified: they create a new CRM contact for the order rather than overwriting an existing customer by an unverified email claim. Subsequent authenticated staff reconciliation can link duplicates under the existing CRM process.

## Permission / route matrix

| Actor | Allowed operations |
|---|---|
| Guest browser | Same-origin GetOyi quote, submit and own minimal receipt, with signed guest cookie and CSRF token |
| Dedicated server integration key | Exact POST `/api/commerce/checkout/quote`, `/submit`, `/status`, scope `commerce.checkout.submit` |
| Intake or catalogue-read key | No checkout access |
| Full key or staff session | No integration checkout route access; staff use existing order routes |
| Order staff | Existing Stage 4A order scopes; customer information still needs separate customer-read permission and audited access |
| Anonymous/authenticated database roles | No order or receipt access |

Integration actor `checkout:<client>` is an integration identity, not an impersonated staff reviewer. No account or production permission has been created. The guest hash and integration client are derived on trusted servers. Receipt responses contain no contact, address, CRM IDs, integration keys or request hashes.

## Configuration (names only, all production flags remain OFF)

Office requires BOTH `OFFICE_HARDWARE_ORDERS_ENABLED=true` and `OFFICE_HARDWARE_CHECKOUT_ENABLED=true`, durable Supabase storage, and a separately configured `LEAD_AGENTS_SCOPED_API_KEYS` entry with only `commerce.checkout.submit`.

GetOyi requires BOTH `HARDWARE_CATALOGUE_ENABLED=true` and `HARDWARE_CHECKOUT_ENABLED=true`, plus explicit `OCHIGA_OFFICE_CHECKOUT_URL`, `OCHIGA_OFFICE_CHECKOUT_KEY`, `HARDWARE_CHECKOUT_SESSION_SECRET` (at least 32 characters) and canonical `GETOYI_CHECKOUT_ORIGIN`. There is no fallback production checkout destination or reuse of intake/catalogue credentials. Local tests supply random synthetic credentials only, on loopback.

Guest cookies are signed, HttpOnly, SameSite=Strict, Secure on HTTPS, scoped to checkout API and expire in seven days. CSRF tokens expire in one hour, quote tokens in ten minutes and are bound to guest identity and cart contents. Contact/address and quote tokens are not persisted in browser storage or URLs. Cart storage contains product slug, SKU and quantity only; session storage retains an opaque submission key. Interrupted submissions can recover a minimal receipt by the same guest/key, without another order. Request bodies are bounded at 32 KiB, errors sanitized, redirects to upstream destinations disallowed, responses no-store/nosniff. The inherited process-local rate limiter is defense in depth, not a distributed abuse-control guarantee.

## Tests and release gate

`TEST_CHECKOUT=true TEST_CHECKOUT_WEB=true node scripts/test-hardware-orders-postgres.js` provisions disposable database/HTTP services, applies reviewed migrations, exercises Stage 4A plus Stage 4B and launches the sibling `oyi-phase4b` worktree against those services. No production URL is accepted by this workflow. `CHECKOUT_REHEARSAL=true` optionally creates a temporary, labelled fixture page for browser screenshots; it is removed afterward. All public flags in that process are local fixture overrides, never deployment changes.

`release/phase4b-gate/production-rollout-gates.sql` preserves every Phase 0–4A check and adds exact receipt/function schema checks and ordering. No security exception was widened. Applied/absent states and deliberately weakened RLS, grants, function mode and immutable triggers are tested. The generator pins baseline, migration and reviewed fixture manifest hashes. Never regenerate the reviewed manifest from a failing production schema.

## Rollback and remaining gates

Before a future authorized COMMIT, any migration/gate failure rolls back the transaction. After a future release, disable both checkout flags, restore previous code and retain all order, CRM, receipt and audit records. Do not DROP/TRUNCATE financial evidence. The schema is additive and earlier deployed code ignores it. No rollback modifies wallet accounting or reverses payment.

GO for local Stage 4C inventory-reservation engineering. NO-GO for production order enablement, live payments or public catalogue activation. Before payment: verified delivery serviceability/charges, atomic expiring reservations, dedicated server-verified payment records/webhook idempotency/reconciliation, privacy retention and operational fulfilment procedures, deployment bindings and distributed abuse controls must pass their release review. Stage 3's real independent production approval and release/withdrawal test remains mandatory before public activation. Local synthetic testing does not replace that gate.
