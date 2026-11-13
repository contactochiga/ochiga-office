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
  The deployed send path requires Supabase; the file store is fixture-only
  for social outbound because it cannot coordinate multiple processes.
- Only a permitted staff session whose immutable user ID is explicitly
  listed in `OFFICE_META_SOCIAL_OPERATOR_IDS` can submit plain text or
  check the status of its own attempt. The list defaults empty and CRM
  management alone is insufficient. The request cannot specify
  an actor, recipient, asset, tag, template, or permission override.
- The target comes from the latest signed channel/asset/sender binding, not
  phone, email, or mutable CRM last-contact dates. The server rechecks the
  binding, 24-hour window, explicit CRM denial and sticky opt-out immediately
  before the provider call. Phase 1 hash-only leads require a new inbound
  event; on first binding, prior supported opt-out commands are checked too.
  Do not use the lane for outreach or rely on the command matcher to interpret
  arbitrary prose. There is no automatic re-opt-in.
- The existing ledger claims the request before sending. The same request
  never sends twice. A recognizable non-transient Graph OAuth/permission
  refusal (HTTP 400/401/403 and Graph code 10, 190 or 200) allows a new
  explicit attempt after review. Unrecognized HTTP responses (including
  429), no response, malformed success, or server failure are
  unknown and blocks new attempts on that lead/channel. A service-role-only
  database fence locks the claim and recipient policy rows, checks the binding,
  opt-out and window, and writes a one-way dispatch marker before the provider
  call. Reconciliation uses conditional writes: expired unfenced claims become
  not sent; expired fenced claims stay unknown. Staff cannot manually clear a
  fenced attempt as not sent or assert success without correlated evidence.
  Escalate unknown attempts for operator investigation; there is no resend
  override. Database retries never retry the provider call. A crash between
  committing the marker and making the request is conservatively unknown.
  Unresolved sends are queried separately from paginated conversation history.
- The browser stores only the attempt ID and a digest of its text, scoped to
  the signed-in operator, relationship and channel. Tabs share a browser
  lock for key creation. Reloads check the actor-scoped ledger before a new
  attempt is allowed; an unrecorded attempt can only reuse its original
  key and text. Clearing site data, switching browsers or changing the
  operator's ledger email can prevent recovery of a lost client attempt.
- Provider acceptance is not delivery. Signed Messenger delivery callbacks
  with exact message IDs and Instagram read callbacks with an exact message
  ID can advance the stored evidence for the same channel, asset and customer.
  Watermark-only callbacks and unsupported receipt shapes are deliberately
  not mapped onto individual sends. Early exact-ID receipts for a binding
  with a fenced pending/unknown send are retained in a restricted table.
  Only acceptance evidence from the original send worker with the exact
  recipient and provider message ID can resolve that attempt. Acceptance
  and receipt writes serialize on the same binding and preserve the higher
  delivery state. An unmatched receipt cannot prove acceptance on its own.
  Retention for unmatched receipts requires an operator policy before scale.

## Proposed staging migration and rollout

1. Review `20261113_meta_social_inbound.sql` then
   `20261113_meta_social_staff_replies.sql` then
   `20261113_meta_social_dispatch_fence.sql` in that order, with the existing
   manual-send ledger migration already present. The proposal adds private
   reply-binding columns, a delivery column, two social-only indexes and
   service-role-only invoker functions. Recheck Office table grants/RLS and
   the staging PostgREST contract before applying anything. The fence migration
   conservatively marks previously unresolved social sends as potentially
   dispatched. The scripts were exercised only in a disposable SQL fixture.
2. Reuse the Ochiga Systems app and the Facebook Login model. With isolated
   test assets, verify Page access token, messaging task, `pages_messaging`,
   `pages_manage_metadata`, and linked Instagram professional account with
   `instagram_basic` and `instagram_manage_messages`. Confirm review/access
   level for real users. Verify the app and asset subscriptions for messages,
   Messenger delivery, and Instagram seen events. Verify the configured
   Graph version and actual linked-Page Send API path and payload with Meta
   before rollout; this commit proves only sanitized fixtures. In particular,
   verify Messenger `page / messaging[].delivery.mids` and Instagram
   Facebook Login `instagram / messaging[].read.mid` (event subscription,
   asset ID, direction, and exact MID). Messenger read/delivery watermarks,
   Instagram watermark-only reads, and other delivery envelopes do not
   update individual messages. Verify the Page token and Instagram linkage
   before approving any outbound test.
3. In a separately approved staging release, deploy with outbound OFF.
   Confirm WhatsApp and AI OFF unchanged. Validate signed callbacks on the
   test assets, then separately authorize enabling outbound there. Validate
   text replies, receipts, permission and opt-out refusals, and an operator's
   outcome investigation without retries or manual clearance. No tags, bulk sends, attachments, comments or
   publishing are included.
4. Roll back by disabling social outbound first. If code must roll back,
   leave the additive SQL and history intact and keep social outbound off.
   Do not delete ledger rows or retry unknown sends. Inbound can be disabled
   independently if necessary; WhatsApp settings and callbacks stay unchanged.

References: [Meta Send API](https://developers.facebook.com/docs/graph-api/reference/page/messages),
[Messenger and linked Instagram permissions](https://www.postman.com/meta/messenger-platform-api/folder/22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a).
