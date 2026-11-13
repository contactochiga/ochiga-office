# Meta social staff replies: local Phase 2

Office owns the signed Meta callback, staff identity and provider credentials.
The existing CRM composer, active staff session, `manage_takeover` permission,
audit, conversation table and manual-send ledger are reused. The historical
ledger table name is `whatsapp_manual_sends`; social entries are explicitly
channel-scoped. No Backend channel, goal, dispatch, or AI capability is added.
The canonical communication outbox is Office-to-Backend inbound evidence,
not a provider-send queue. Putting replies there would enable replay in a
path with no safe provider idempotency; it remains unchanged.

## Policy and evidence

- Both inbound and outbound switches must be explicitly enabled. Outbound is
  OFF by default. No credential is required or accessed for a disabled send.
- Only a permitted staff session can submit plain text. It cannot specify
  an actor, recipient, asset, tag, template, or permission override.
- The target comes from the latest signed channel/asset/sender binding, not
  phone, email, or mutable CRM last-contact dates. The server rechecks the
  binding, 24-hour window, explicit CRM denial and sticky opt-out immediately
  before the provider call. Phase 1 hash-only leads require a new inbound
  event; on first binding, prior supported opt-out commands are checked too.
  Do not use the lane for outreach or rely on the command matcher to interpret
  arbitrary prose. There is no automatic re-opt-in.
- The existing ledger claims the request before sending. The same request
  never sends twice. A known rejection (including 429) allows a new explicit
  attempt after review. No response, malformed success, or server failure is
  unknown and blocks new attempts on that lead/channel until a staff member
  verifies the provider inbox and records the outcome. Reconciliation does
  not send. Database retries never retry the provider call.
- Provider acceptance is not delivery. Signed Messenger delivery callbacks
  with exact message IDs and Instagram read callbacks with an exact message
  ID can advance the stored evidence for the same channel, asset and customer.
  Watermark-only callbacks are deliberately not mapped onto individual sends.
  A receipt arriving while its send is pending requests retry; unknown
  unrelated receipts do not create records. A staff-confirmed send without
  a provider ID remains unverified.

## Proposed staging migration and rollout

1. Review `20261113_meta_social_inbound.sql` then
   `20261113_meta_social_staff_replies.sql` in that order, with the existing
   manual-send ledger migration already present. The proposal adds private
   reply-binding columns, a delivery column, two social-only indexes and
   service-role-only invoker functions. Recheck Office table grants/RLS and
   the staging PostgREST contract before applying anything. Both scripts were
   exercised only in a disposable PostgreSQL fixture.
2. Reuse the Ochiga Systems app and the Facebook Login model. With isolated
   test assets, verify Page access token, messaging task, `pages_messaging`,
   `pages_manage_metadata`, and linked Instagram professional account with
   `instagram_basic` and `instagram_manage_messages`. Confirm review/access
   level for real users. Verify the app and asset subscriptions for messages,
   Messenger delivery, and Instagram seen events. Verify the configured
   Graph version and actual linked-Page Send API path and payload with Meta
   before rollout; this commit proves only the mocked contract.
3. In a separately approved staging release, deploy with outbound OFF.
   Confirm WhatsApp and AI OFF unchanged. Validate signed callbacks on the
   test assets, then separately authorize enabling outbound there. Validate
   text replies, receipts, permission and opt-out refusals, and an operator's
   outcome reconciliation. No tags, bulk sends, attachments, comments or
   publishing are included.
4. Roll back by disabling social outbound first. If code must roll back,
   leave the additive SQL and history intact and keep social outbound off.
   Do not delete ledger rows or retry unknown sends. Inbound can be disabled
   independently if necessary; WhatsApp settings and callbacks stay unchanged.

References: [Meta Send API](https://developers.facebook.com/docs/graph-api/reference/page/messages),
[Messenger and linked Instagram permissions](https://www.postman.com/meta/messenger-platform-api/folder/22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a).
