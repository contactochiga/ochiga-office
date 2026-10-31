# Stage4D Office authority and payment confirmation

Base0951e53. Local only; public Hardware, checkout and live payments remain OFF. No production grants or credentials were changed.

## Additive model
hardware_payment_delivery holds immutable staff-confirmed serviceability evidence, gross delivery charge and included delivery tax. hardware_payment_authorizations binds one order to its reservation, verified payable total, NGN currency, test environment and deterministic hardware-only reference. hardware_payment_confirmations stores immutable exact provider evidence and paid/refund_required outcome. hardware_payment_history and audit_events record commercial authorization/confirmation; CRM activity links the existing contact/opportunity.

Existing product/variant/price/tax snapshots remain unchanged. Delivery totals project once from the confirmed record; payment projection requires durable confirmation. Deferred consistency guards bind the projection, authorization, reservation, immutable history and audit. Reservation and payment revisions do not rewrite earlier order financial/status events.

## Permissions and endpoints
- Staff session with commerce.orders.read + commerce.orders.delivery.confirm: POST /api/lead-agents/admin/hardware-orders/:id/delivery; same-origin guard and active-staff SQL check. Gross/tax are integer kobo; evidence is mandatory. No new account/grant is created. Existing independent product/price approval remains required.
- Existing commerce.checkout.submit integration: owner-bound payment-quote and payment-start actions. Guest identity remains hashed and scoped to the original checkout receipt. Customer must accept the exact confirmed total. Installation remains a separate assessment; no charge is invented.
- New commerce.payment.confirm integration: ONLY POST /api/commerce/payments/confirm. Cannot read orders, submit checkout, change catalogue or grant privileges. Only a dedicated trusted Backend credential may submit provider evidence. Trusted service credentials remain inside server boundaries.
- Anonymous/authenticated Data API users: no payment table/function grants. Service runtime is trusted; evidence tables have SELECT/INSERT only and immutable triggers.

## Switches and transport
OFFICE_HARDWARE_PAYMENTS_ENABLED defaults OFF for delivery authorization/new initialization. OFFICE_HARDWARE_PAYMENT_PROCESSING_ENABLED defaults OFF and is independent for recovery. HARDWARE_PAYMENT_BACKEND_URL requires HTTPS and HARDWARE_PAYMENT_BACKEND_KEY is direction-specific. None was provisioned. Office sends only authorized order/payment facts and the customer's payment email to Backend; no card details are collected.

Backend proof must match reference, exact amount, NGN, test environment, hardware purpose, authorization hash, order and reservation. Confirmation is serialized with the reservation inventory lock. Expiry/cancellation/withdrawal/price ineligibility produces refund_required and never allocates stock. A deadline crossing during allocation rolls back confirmation for safe retry. Duplicate confirmations return the existing outcome; a distinct second provider transaction requires reconciliation.

## Migration/gate/rollback
Apply db/phase4d/20261026094828_hardware_payment_confirmation.sql explicitly AFTER accepted Stage4C, not by filename date sorting. Execute transactionally after approval. Prior migrations are unchanged. release/phase4d-gate/production-rollout-gates.sql retains Phase0–4C checks and accepts only exact reviewed Stage4D shapes. The only added general-grant exceptions are the four named immutable payment tables, conditional on the whole reviewed payment schema matching. Never broaden this exception to a prefix.

Pre/post migration and deliberate tamper tests run in disposable PostgreSQL. The existing reservation cron remains necessary. Supabase CLI advisor was not certified for this stage; the earlier disposable non-TLS connection incompatibility remains a documented tool limitation. The custom exact-shape gate is not a claim of production preflight.

Rollback disables new payment/checkout creation first. Keep Stage4D confirmation ingress, database functions, reservation expiry and Backend reconciliation for in-flight or late provider payments. Preserve financial/audit records. Revert full code only before any provider attempt exists, or after a separately reviewed disposition of all possible payments. No destructive down migration.

## Remaining gates
Mock-only test-domain integration; no real Paystack test/live transaction. Separate production schema, credential, merchant, scheduler and dependency reviews required. Stage4E must cover operational refunds, reconciliation tools, pending-age policy and recovery runbooks. Phase3 independent production approval/release/withdrawal remains mandatory for public activation.
