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
  listed in `OFFICE_META_SOCIAL_OPERATOR_IDS` can claim/release a social
  conversation, submit plain text or check the status of its own attempt.
  The list defaults empty and CRM management alone is insufficient. The request cannot specify
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

## Social ownership and dispatch fencing (local D2A)

- The CRM exposes explicit session-authenticated `takeover` and `release`
  operations for Facebook and Instagram. The authenticated session supplies
  both the immutable staff UUID and email; request bodies accept only an
  idempotency UUID. The server requires `manage_takeover` (`crm.manage`), the
  social operator UUID allowlist and an existing inbound conversation on the
  requested channel. The legacy social channel-state PATCH remains blocked.
- The ownership RPC serializes transitions on the lead/channel state row and
  stores request outcomes for duplicate recovery. Takeover sets `human_active`,
  assigns the session email, and pauses AI. Release clears ownership but keeps
  `ai_paused` unchanged. There is deliberately no resume-AI action in this
  feature.
- Dispatch locks the send, lead and ownership rows, then verifies the current
  owner equals the authenticated sender before writing `social_dispatch_at`.
  Release/claim checks the same ownership row and refuses while a fenced send
  is pending or outcome-unknown. Therefore release-before-fence makes dispatch
  fail owner validation; fence-before-release makes release wait and then
  refuse until provider outcome is resolved. Unknown attempts stay blocking.
- `social_ownership_revision` is incremented on each ownership transition.
  Request results are persisted in a private RLS-enabled table. Only the
  service role can call the transition and dispatch RPCs. Audit records capture
  the actor, channel, outcome and revision. The existing internal notification
  and CRM timeline are reused for successful non-replayed transitions; no new
  notification subsystem is introduced.

## D1 isolated rollout (not authorized by this change)

Deploy only after separate approval, with `OFFICE_META_SOCIAL_OUTBOUND_ENABLED=false` and
`OFFICE_META_SOCIAL_OUTBOUND_CHANNELS=` (empty). Preserve `OFFICE_META_SOCIAL_INBOUND_ENABLED=true`
and `OFFICE_META_SOCIAL_INBOUND_CHANNELS=facebook,instagram` in production. Do not change WhatsApp,
autonomy, Content or website intake. No new migration is introduced by D1.

| Stage | Exact configuration and acceptance |
| --- | --- |
| 1. Messenger only | In the approved pilot, set `OFFICE_META_SOCIAL_OUTBOUND_ENABLED=true`, `OFFICE_META_SOCIAL_OUTBOUND_CHANNELS=facebook`, `OFFICE_META_SOCIAL_OPERATOR_IDS` to the single approved Office staff UUID, and `OFFICE_META_SOCIAL_OUTBOUND_RECIPIENTS=facebook:<PAGE_ID>:<PAGE_SCOPED_SENDER_ID>` to the one approved test conversation. The recipient setting is exact-match and empty/malformed values permit nobody. Set `FACEBOOK_PAGE_ACCESS_TOKEN` through the secret manager and `META_SOCIAL_GRAPH_VERSION` to a currently supported, validated version. Keep Instagram absent from outbound channels and preserve existing inbound/Page/IG IDs and app/verify secrets. A separate eligible Meta app-role test account initiates a fresh DM. The approved operator sends one text reply, verifies its exact-ID delivery callback, confirms Instagram and all other recipients remain blocked, and checks reload does not resend. |
| 2. Instagram only | Keep the same master, operator and tested Graph settings; replace the outbound channel list with `instagram`, not both. Use the linked professional account and eligible Instagram app-role tester, separate from the business. Verify the Page-token grant covers Instagram. Check linked-Page URL and IGSID, exact-ID `messaging_seen` if approved for the pilot, and confirm Messenger sends are blocked but inbound still works. If Meta expands where messages can be delivered beyond app-role testers, use isolated test assets before any production send. |
| 3. Unified takeover and handback | Local D2A adds audited claim/release and atomic ownership checks at dispatch. Keep outbound off during staging setup. Use two approved staff accounts and verify conflicting claims, owner-only replies, dispatch/release races, duplicate requests and reload. Release does not resume AI. |
| 4. Supervised AI | Not implemented. Proposed default-OFF gate: `OFFICE_META_SOCIAL_SUPERVISED_DRAFTS_ENABLED=false` (not read by D1), plus the independently approved manual outbound channel. No new Meta send grant beyond the applicable channel. An approved Oyi Core draft is reviewed and explicitly sent by the allowlisted operator; an edited draft or changed recipient/owner must invalidate stale approval. No automatic sending and no WhatsApp autonomy change. |

For Stages 1 and 2, roll back by setting `OFFICE_META_SOCIAL_OUTBOUND_ENABLED=false` and clearing
`OFFICE_META_SOCIAL_OUTBOUND_CHANNELS` and `OFFICE_META_SOCIAL_OUTBOUND_RECIPIENTS`. Let already-dispatched attempts and callbacks reconcile; never resend an UNKNOWN attempt or
delete history. Preserve inbound and verify the existing WhatsApp, Messenger and Instagram CRM paths. Stage 3 rollback
first disables social outbound; wait for all dispatched sends to resolve, then release ownership through the audited API.
Do not clear ownership records with direct SQL. The legacy PATCH stays blocked. Stage 4 rollback disables
drafts and revokes outstanding draft approvals, returning to manual-only. These switches apply when the new process
loads configuration; they cannot revoke a provider request already in flight. Do not roll back to pre-D1 code
while the old global outbound switch is true.

Confirm the token's app, Page, validity, expiry, allowed asset and scopes via Meta's read-only debugger and asset
metadata under separate approval, without printing credentials. For Messenger verify `pages_messaging` and
`pages_manage_metadata` with the applicable Page task; for Instagram also verify `instagram_basic` and
`instagram_manage_messages` and effective linked-Page access. Confirm accepted role assignments and App Review/Advanced
Access before any non-role rollout. No actual token or provider sends were exercised for D1. The documented
Facebook Login Send API is `graph.facebook.com/{version}/{PAGE_ID}/messages` with a PSID for Messenger
or IGSID for Instagram; the request fixtures pin v26.0, not live approval of a particular API version.

### Messenger-only pilot checklist

- Identify and approve a staging Facebook Page, a separate Meta app-role sender who can DM that Page,
  and the UUID of a staging Office staff account with `manage_takeover`. These are prerequisites,
  not values supplied by the release candidate. Do not reuse production threads, credentials, or accounts.
- Use a separate database and staging-only service-role key, session secret, Meta signing secret and
  verify token. Apply the inbound, staff-replies, dispatch-fence and social-takeover migrations in order;
  verify the ownership and dispatch RPCs exist before any sends. Keep
  staging disconnected from production Office, Backend, WhatsApp, email and AI. Use synthetic leads only.
- Verify that the staging Page token is for the expected app and Page, has `pages_messaging`, and was
  authorized by a user with the Page messaging task. Confirm `pages_manage_metadata` for subscription and
  validate the pinned Graph version before sending. Bind a staging-only HTTPS `/webhooks/meta-social`
  callback to the staging Page's `messages` and `message_deliveries` fields; do not repoint a production
  callback. If Meta setup cannot isolate that callback and test asset, stop.
- Keep social outbound off until isolation, signed callback and allowed operator are verified. The
  operator must claim the synthetic Messenger conversation in CRM; confirm `ai_paused=true` and owner
  identity comes from the session. After separate send approval, allow only `facebook`, confirm Instagram
  send is refused, reply once to the fresh test DM and check the ledger, reload and exact-ID receipt. Release
  ownership afterward and verify AI remains paused. Never use direct database writes to claim or release.
  If anything differs, disable outbound and preserve all ledger records.

## Existing staging schema and provider checks

1. Review `20261113_meta_social_inbound.sql` then
   `20261113_meta_social_staff_replies.sql` then
   `20261113_meta_social_dispatch_fence.sql` then
   `20261117_meta_social_takeover.sql` in that order, with the existing
   manual-send ledger migration already present. The proposal adds private
   reply-binding columns, a delivery column, two social-only indexes and
   service-role-only invoker functions. The takeover migration adds a revision,
   request-idempotency table, atomic transition RPC and ownership-aware dispatch
   fence replacement. Recheck Office table grants/RLS and
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
