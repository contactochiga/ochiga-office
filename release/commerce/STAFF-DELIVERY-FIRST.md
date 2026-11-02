# Staff-confirmed delivery before payment — local candidate

Owner decision: staff confirms delivery eligibility and charge before payment; installation remains a separate consultation.

## Minimal compatible implementation

`OFFICE_HARDWARE_STAFF_DELIVERY_FIRST=true` selects this policy. It defaults OFF and has not been enabled in production or the preserved Paystack receiver.

1. Existing checkout validates independently approved product/variant prices, current publication and stock. It creates an immutable order request and CRM references **without a stock hold** using the existing checkout function. This is not a stock guarantee or payable order.
2. In Office **Products → Orders & payments → Review delivery and charge**, staff deliberately opens the destination (existing customer-data/CRM permission and audit). An authorized delivery confirmer records the real serviceability evidence, total delivery charge and included VAT. Values are converted to integer kobo. No installation amount is assumed.
3. The customer returns to their order and refreshes payment status. The read-only quote returns the confirmed total and whether stock preparation is permitted. It creates no authorization, hold, payment record or notification.
4. **Confirm total and check stock** reuses the existing atomic reservation function. It revalidates current publication, independent price approval, immutable price/tax snapshots, sourcing and available quantities, then creates one 15-minute hold under the existing database lock.
5. Only a valid hold exposes **Accept total and continue to Paystack**. Existing execution flags, evidence/amount boundaries and provider budgets still apply. Preparation itself never invokes Backend/Paystack, allocates stock or marks an order paid.

Repeated preparation is idempotent and cannot extend the original hold. An expired/released hold or an existing payment authorization is refused. A stale price/withdrawn product requires an explicit new order review; this implementation does not silently replace an order, payment reference or uncertain financial attempt. Separate expiry processing retains the original history.

## Permissions and switches

- Guest routes: existing checkout-scoped key + order/client/guest binding; GetOyi retains origin, CSRF, rate-limit and feature gates.
- Prepare: Office orders, checkout, reservations and staff-delivery-first switches required. Payment initialization may remain disabled.
- Delivery confirmation: existing staff session and `commerce.orders.read` + `commerce.orders.delivery.confirm`; existing database actor validation. Destination read additionally requires `commerce.orders.customer.read` and `crm.read` and creates its existing audit event.
- Financial-operations service scope does not grant guest preparation or delivery authority. Refund/reconciliation processing remains independently disabled. No super-admin or self-approval override added.
- New SQL functions are invoker, pinned-search-path, service-only. No new tables, payment system, inventory database or permission grants.

## Migration and rollback

Apply only the explicitly hashed additive step 13 after Phase4F and step12. Run both commerce security gates plus the existing Phase0–5 gates. Reapplication does not change records; transaction rollback removes only the new function definitions. No historical migration was edited.

Rollback: stop new order submissions and payment preparations/initializations; retain both functions and all order, reservation and financial history. Default-OFF policy restores existing request behavior, but already-created delivery-first requests must remain available for forward recovery. Never pretend old UI can prepare unreserved orders. Keep the compatible read/status path and previously reviewed provider reconciliation path. No destructive down migration is required or authorized.

## Still required before customer launch

Cross-device verified customer access and durable Office acknowledgement/payment-invitation delivery remain engineering blockers. This change closes the stock-hold-during-staff-review defect; it does not claim the complete purchase/notification/delivery acceptance journey or authorize provider transactions. Old uncertain and stopped Paystack runs are untouched.
