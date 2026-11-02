# Customer order access and notifications — local acceptance candidate

Additive to 5a46afb. Existing catalogue, guest checkout, approved delivery amounts, reservations and payment confirmation remain authoritative. No production mutation or financial provider call is part of these changes.

## Verified email access

`orders.customer.access` is a new dedicated server-to-server scope. It permits only POST request/verify/progress/history/revoke under `/api/public/orders/access/`. It cannot initialize payments, confirm them, refund or read staff/customer APIs. Use the same client identifier as the original checkout receipt; a different client is denied even with the correct proof.

OFF by default: `OFFICE_HARDWARE_CUSTOMER_ACCESS_ENABLED`, `OFFICE_HARDWARE_CUSTOMER_EMAIL_ENABLED`, GetOyi `HARDWARE_CUSTOMER_ACCESS_ENABLED`. Existing order-status and orders switches are still required. Provision a separate random 32+ character `OFFICE_HARDWARE_CUSTOMER_ACCESS_SECRET` through secure local configuration; no production secret was created. GetOyi uses a separate `OCHIGA_OFFICE_CUSTOMER_ACCESS_KEY`.

- Order reference + checkout email; exact full UUID preferred. Ambiguous short HW references never pick an arbitrary order.
- Eight-digit email code, ten-minute expiry, five attempts. Durable per-client/mailbox throttle: five requests/hour, including non-matches. Public proxy also enforces origin, CSRF and request-rate limits.
- Only HMAC proofs are persisted. Code is deterministically derived by the trusted email sender; no plaintext code or access token in the database or logs.
- Atomic single-use verification. Random 256-bit access token, SHA-256 at rest, client/order binding, 24-hour expiry, up to five active grants/order. Cancellation and financial-review events revoke prior grants; owner can verify again to inspect the final safe status.
- GetOyi returns the token only in a signed HttpOnly, SameSite=Strict cookie, Secure on HTTPS, scoped to `/api/hardware/checkout`. No grant in localStorage, HTML, redirect URL or JavaScript response.
- Read-only history includes at most the latest 50 orders belonging to that verified email and client. Order payment actions remain individually bound: a history entry is not a payment authorization.
- Existing checkout scope can resolve an order-bound grant to the original guest proof **inside Office**. Original payment/reservation/delivery flags, amounts, eligibility and consent remain required. Customer-access scope cannot perform these actions.

The existing safe progress projection excludes contacts, addresses beyond city/state, provider references, staff, tracking/private notes and visit details. Same-browser guest access remains supported. No permanent customer account or change to CRM contact identity matching is introduced.

## Durable email delivery

Reuse `sendOfficeEmail`/Resend and existing retry backoff. A purpose-specific durable email outbox is separate from the inbound WhatsApp evidence outbox, whose replay semantics must remain unchanged.

New immutable domain events enqueue messages transactionally: creation/cancellation, approved delivery charge, authoritative payment confirmation/failure/review, packing, dispatch, delivery, completion and optional installation lifecycle. No historical data backfill. No customer message is sent when the worker is OFF.

Claims use row locks/SKIP LOCKED, 90-second leases and compare-and-set completion. Stable per-message provider idempotency keys; same event cannot enqueue twice. Retry at most ten attempts and only within 23 hours of first dispatch. Resend retains keys for 24 hours: https://resend.com/docs/dashboard/emails/idempotency-keys . Lost responses resume the same message; changed-body conflicts, exhausted retries and ambiguous old sends enter `review`. `accepted` means provider acceptance, **not** verified mailbox delivery. Human review must not blindly resend an uncertain message.

`GETOYI_CUSTOMER_ORDER_ORIGIN` is a fixed HTTPS origin (loopback HTTP only for local tests). Emails contain the order ID and a static Find Order link, never a bearer link/payment credential. Installation messages do not claim an appointment. Runtime sender/configuration changes during retries can produce a provider conflict and require review; do not reset message IDs.

## Database / rollback

Apply the explicitly numbered manifest step only AFTER Phase5D and the accepted commerce migrations. Four private RLS tables, service-only invoker functions, pinned search paths, immutable envelopes/evidence. Run `customer-access-gate.sql` alongside all prior gates. Reapplication fails transactionally; do not replay a successful migration.

Rollback is **switches OFF + previous code**, preserving all challenges/grants/outbox/audit and financial data. Do not drop the new tables once evidence exists. Stop the sender, wait for any 15-second in-flight request, retain its lease and idempotency key, and reconcile provider acceptance before resuming. Retrying after the 23-hour deadline requires review, not resetting timestamps. A pre-commit migration failure rolls back atomically.

The unrelated mandatory Render rollback artifact gate remains unresolved. This local module does not satisfy or bypass it.

## Acceptance limits

Database/HTTP/concurrency and synthetic mail-adapter tests are automated; actual Resend mailbox receipt and real customer mail delivery are not demonstrated. No real Paystack journey is claimed. Production requires configured dedicated scope/secret, verified sender/domain, durable worker hosting, retention/abuse policy review and controlled company-inbox delivery evidence. History is bounded to 50; pagination is a later extension if required. A mailbox proof is not permission to disclose private delivery or financial records.
