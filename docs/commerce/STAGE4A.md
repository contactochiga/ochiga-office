# Stage 4A — Office order foundation (local candidate)

Base: Office 2cb6c76. GetOyi f3285b0 and Backend are unchanged. No production migration/deployment, payment integration or public activation is authorized by this implementation.

## Implemented

`db/20261107_hardware_orders.sql` adds four durable tables: hardware_orders, hardware_order_lines, hardware_order_private and hardware_order_events. Product/variant IDs reuse the catalogue. Customer, organization and opportunity reference existing CRM rows; mismatched relationships are rejected. Product names/options and published versions are immutable line snapshots. Independent product approval and an independently approved/published matching price change are required. VAT-inclusive amounts stay integer NGN kobo. Tax is rounded once per gross line as `round(gross * rate_bp / (10000 + rate_bp))`; the total is the sum of line gross and line tax. Any later tax policy change requires a reviewed revision; do not rewrite historical lines.

Orders are staff-managed requests awaiting commercial confirmation. They are NOT checkout/payment intents. Supplier-sourced or insufficient stock is explicitly confirmation_required. Unapproved/unpriced, inactive, discontinued and internally unpublished products are refused. Stage 4A permits internally published but not publicly released products for staff operations; future guest checkout must additionally require public eligibility. No synthetic or private item can become guest-checkout eligible through this foundation.

Delivery is nationwide within NG subject to later confirmation. Country/state/city/address are required; unknown delivery charge and payable total are NULL, never zero. Installation requested is only an optional assessment request. No installation charge or fulfilment promise is inferred.

Creation takes an actor-bound idempotency key. The database hashes the complete JSONB request, obtains a transaction-scoped lock, returns the original order on identical retries and rejects changed payloads with 409. Customer snapshot, financial lines, initial status event, Office audit and linked CRM activity commit together. Cancellation uses expected row_version, records immutable history/audit/CRM activity and cannot update financial fields. An old create retry returns the original order identity even after price or status changes; read detail for current state.

Table history is guarded against UPDATE/DELETE/TRUNCATE. Header financial/customer references are immutable. Trusted service_role has the same SELECT/INSERT/UPDATE/DELETE grants as catalogue tables, with triggers/constraints enforcing mutation restrictions; anonymous/authenticated/PUBLIC have none. No SECURITY DEFINER is introduced. Raw database credentials remain a trusted application boundary, never guest/staff browser access. Ordinary staff cannot reach these tables through the Data API.

## States and Stage 4A limits

- order_state: awaiting_confirmation -> cancelled only.
- payment_state: not_started only; no route or schema transition to paid.
- fulfilment_state: unallocated only.
- reservation_state: not_reserved only.
- delivery_state: unconfirmed only.
- payable_total_kobo and delivery_total_kobo: NULL only.

Later stages need reviewed migrations for additional transitions, verified provider events and reservations. Persisted goods prices are verified at creation, not a permanent authorization to charge. This stage adds the staff API/data foundation, not an Office order UI, guest checkout or provider integration.

## Permission matrix

| Capability | Required permissions |
|---|---|
| List/order/line/status read, without customer/address or CRM IDs | commerce.orders.read |
| Create | commerce.orders.read + commerce.orders.create + crm.read |
| Read customer/address/CRM links | commerce.orders.read + commerce.orders.customer.read + crm.read |
| Cancel awaiting-confirmation order | commerce.orders.read + commerce.orders.cancel |
| Mark paid, reserve, fulfil, refund | No Stage 4A permission or route exists |

Super-admin inherits new permission keys through the existing role model. All other roles, including ochiga_admin, receive no order permission by default. No existing staff account is modified. Full/scoped API keys and unauthenticated requests cannot use staff order routes. SQL creation/cancellation independently recheck the active staff actor and action scope. The actor is derived from the authenticated session, never the body.

## Routes and enablement

Default OFF: `OFFICE_HARDWARE_ORDERS_ENABLED` must equal `true` in the isolated environment. Do not enable in production without release approval. No public or payment flag is changed. Durable Supabase storage is required; no file-store fallback.

Base `/api/lead-agents/admin/hardware-orders`:
- GET: 50 orders maximum, offset 0..10000; excludes customer/address, actor, idempotency key and request hash.
- POST: `{idempotency_key, order:{contact_id, organization_id?, opportunity_id?, delivery:{country:"NG",state,city,address,postcode?}, installation_requested?, lines:[{variant_id,quantity}]}}`. No price, tax, paid flag or provider data accepted. Returns identity and replay marker only; 201 new / 200 identical replay.
- GET `/:id`: public-to-staff order fields, immutable lines and status history; `payment_eligible:false`.
- GET `/:id?customer=true`: separate permission plus audited private read; PII never copied into generic audit metadata.
- POST `/:id/cancel`: `{expected_row_version}`; identical cancellation retries return the original result; 409 on incompatible state/version.

Responses are private/no-store and nosniff. Writes require exact canonical Office origin (OFFICE_APP_URL via existing config); local tests use their loopback origin. Staff browser requests cannot use arbitrary Origin or missing Origin for mutations. Errors expose stable codes, not SQL, request bodies or PII. Existing server authentication, scope allowlists and rate limits are reused; existing intake/catalogue routes are unchanged.

## Reservation contract — design only, not implemented

Stage 4C must accept a trusted order ID, commercial revision, bounded quantity lines, expiry and idempotency key. In one transaction: lock eligible published products/variants in stable product/variant order; revalidate public eligibility, independent approved prices/tax, delivery confirmation and quote expiry; allocate all lines or none; insert unique order-line reservation rows; increment stock_reserved exactly once; bind the resulting reservation IDs and commercial snapshot to an expiring checkout intent. Supplier-sourced/quote-only/unconfirmed stock must fail immediate reservation/payment, not silently fall back.

Reservation states: held -> consumed OR released/expired, never both. Retry with same semantic request returns same allocation; conflicting reuse returns 409. Release/expiry atomically restores reserved quantities once. Successful server-verified payment consumes a valid reservation; late payment after expiry enters an explicit recovery/refund exception, never oversells. In-stock is a snapshot, not a reservation. Stage 4A never changes stock_reserved.

Stage 4B may build cart/guest input against isolated fixtures, but payment remains blocked until 4C and 4D pass. Delivery and installation require independent confirmed terms. Recheck all financial facts immediately before provider initialization; browser prices and redirects remain untrusted.

## Gate, tests and rollback

`release/phase4a-gate/production-rollout-gates.sql` is read-only, adds B15 and P4A/order checks to the frozen Phase 3 gate. All Phase 0–3 conditions remain unchanged; no permission exceptions are added. Frozen shape includes owners, grants, columns, constraints, triggers, RLS, function bodies and search paths. The generator pins the Phase 3 gate, migration and manifest hashes. Never regenerate expectations from production/tampered metadata to pass a failing gate.

Run `npm run office:orders:test` with Docker's existing disposable Supabase/PostgREST images. The harness never accepts a production URL. Existing `scripts/test-catalogue-postgres.js` intentionally excludes the new order migration from its catalogue-only fixture (it previously applied unknown future migrations before catalogue prerequisites); the separate order harness applies it after Phase 3. Gate tests exercise absent/applied states and deliberate tampering; regression runs preserve catalogue/CRM behaviour.

Apply the candidate migration only after independent release approval and a preflight GO, inside a transaction with post-migration gate before COMMIT. An error rolls back new schema atomically. After commitment, rollback means disable the order feature and restore prior Office code while retaining tables, immutable order history and CRM/audit evidence. No DROP/TRUNCATE down migration is provided. The additive schema is compatible with the older application. Do not delete audit/financial records or reverse payments as code rollback.

Privacy retention/redaction/export procedures, a staff order UI, confirmed quotes/delivery, atomic reservations, guest access, provider attempts/inbox/outbox and fulfilment/refund operations remain later work. No marketing or customer notifications are sent by this stage; existing CRM gets internal activity only.

Phase 3 prerequisite remains: independent real production product/price/campaign approvals and release/withdrawal verification before separate public activation approval. Isolated Stage 4A success does not waive it. HARDWARE_CATALOGUE_ENABLED and live payments remain OFF.
