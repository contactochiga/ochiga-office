# Stage 4E operations and release boundaries

Local candidate only. No deployment/migration or real provider action authorized. Public Hardware and live payments remain OFF.

## Permission matrix
|Actor|Required scope|Allowed operation|
|---|---|---|
|Staff reader|commerce.orders.read|Payment/exception/history view without customer payload|
|Refund requester|commerce.orders.read + commerce.orders.refund.request|Request full refund of the immutable verified amount|
|Independent approver|commerce.orders.read + commerce.orders.refund.approve|Approve another person's request, including when requester is super-admin|
|Reconciliation operator|commerce.orders.read + commerce.orders.reconcile|Append notes; never mark funds returned|
|Dedicated Backend key|commerce.payment.operations|Read approved requests and deliver immutable recovery observations only|
|Existing confirmation key|commerce.payment.confirm|Existing verified payment confirmation only|

No scopes were granted. Non-super-admin roles receive no automatic commercial scopes. Database and HTTP authorization both apply. Full refund only: partial refunds, disputes and ambiguous provider responses escalate; no automatic stock restock or dispute acceptance.

## Schema and audit
The new migration is additive after Stage4D. Financial observations have immutable provider event identity and payload hash. Altered replay conflicts. Refund requests and independent decisions are immutable and audited in existing hardware_payment_history/audit_events, with targeted existing Office notifications. Original paid/refund-required facts and stock allocation remain intact. Guest quote adds only a safe refund-state label; no staff reason or provider identifier is returned.

The Products workspace gains an Orders & payments tab using existing Office styles and controls. It shows the latest observation and immutable history. A reconciliation note cannot clear a dispute, change payment state or certify funds returned. Dispute resolution remains a manual, separately governed operation; no automatic dispute-close override exists.

## Local migration and rollback
1. Verify Stage4A–4D baseline and hash manifests; use disposable DB for rehearsal.
2. Apply Office Stage4E and Backend Stage4E each in its own transaction. Do not run against production under this authorization.
3. Run baseline security gates before migration and Stage4E exact schema gate afterward. The latter pins all hardware relations/functions, ownership, grants, RLS, constraints, triggers and search paths; candidate manifests require release review.
4. Deploying is NOT authorized. Later rollout needs independent approval, isolated provider validation, dependency disposition and production compatibility review.
5. Pre-use rollback scripts refuse to erase any Stage4E records. Once financial events exist, retain the schema/history, disable new refund initiation and roll forward with a reviewed recovery worker. Do not roll back to software that strands initiated refunds. Drain/retain the outbox and provider references.

Production Phase3 independent approval/release/withdrawal verification remains a separate mandatory public-activation gate. No Stage4E result satisfies it.
