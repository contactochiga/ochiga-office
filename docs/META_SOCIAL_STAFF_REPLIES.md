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

## Facebook customer-support eligibility and Meta approval

The production-safe default remains `pilot_allowlist`. If
`OFFICE_META_SOCIAL_OUTBOUND_RECIPIENT_POLICY` is absent or invalid, only the
existing exact `OFFICE_META_SOCIAL_OUTBOUND_RECIPIENTS` bindings are eligible.
The alternative `verified_inbound_support` policy is server configuration, not
a CRM toggle: it permits only a correctly bound Facebook lead whose recorded
source channel is Facebook. It does not permit Instagram, unsolicited targets,
cross-channel identity reuse, opt-outs, expired 24-hour windows, or a send
without the existing operator, ownership and atomic dispatch checks. Do not
select this policy in production until Meta access approval and a separate
operational approval are complete; the current pilot allowlist is unchanged.
To return to the existing pilot after any future rollout, unset the policy
while retaining the exact pilot bindings. For an immediate stop, disable
outbound; an already-dispatched request cannot be recalled.

### App Review checklist for `pages_messaging` Advanced Access

1. In the Ochiga Systems app, confirm the app is connected to the verified
   Ochiga business and review the current access level for `pages_messaging`.
   Standard access is limited to people with an applicable role; customer
   support for ordinary non-role Facebook users requires Advanced Access.
2. Complete Meta's current business verification, data-handling questions and
   any required Data Use Checkup. In App Review, request Advanced Access only
   for `pages_messaging` (and request other permissions only if the dashboard
   identifies a feature that actually requires them). Keep the Page token
   tied to the Ochiga Page and an authorizing person with the Page `MESSAGING`
   task.
3. Supply a reviewer-ready account and test conversation, plus a screen
   recording showing: an end-user starts a Messenger conversation; Office
   receives it under the Facebook channel; an authorized staff member takes
   ownership; staff sends one human-written reply; the resulting pending,
   Meta-accepted and exact-ID delivery states are visible; and staff releases
   ownership. Provide reviewer credentials and reproducible steps in Meta's
   secure review form, not in source code or logs.
4. Explain data minimization, channel-scoped identity, retention/deletion,
   staff access controls, opt-out handling, and that replies are human-authored
   and limited to the standard customer-care window. Do not describe marketing,
   bulk messaging, or autonomous replies as part of this use case.
5. After approval, verify the dashboard explicitly reports Advanced Access
   before any non-role customer is included. Keep the server policy at
   `pilot_allowlist` until a separately reviewed production change authorizes
   broader eligibility. App Review approval does not itself alter Office's
   allowlists or enable outbound.

### Safe App Review test procedure

- Use a dedicated reviewer/test Facebook account and a fresh inbound message
  to the Ochiga Page. Confirm the CRM identity is a Page-scoped sender bound to
  that Page, and the conversation is not opted out and remains within 24 hours.
- Sign in as an allowlisted Office operator, take over the conversation, send
  one short human-authored test reply, and record the ledger progression. A
  Meta API acceptance is not proof of delivery; verify a matching delivery
  receipt by exact provider message ID. Demonstrate duplicate submission does
  not call the provider twice and an uncertain outcome stays blocked from
  retry.
- Demonstrate the expired-window and opted-out cases are refused before the
  provider is called, and that another staff member cannot send while not the
  current owner. Release ownership at the end. Do not enable AI replies.
- The current implementation intentionally does not use the Human Agent
  exception: staff sends close at the standard 24-hour window. Meta documents
  a separate Human Agent permission for qualifying manual support outside
  that window (up to seven days); it requires its own App Dashboard request
  and must not be inferred from `pages_messaging` approval.

References: [Meta App Review](https://developers.facebook.com/docs/resp-plat-initiatives/app-review/introduction),
[data handling and business verification](https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/data-handling-questions/tutorial),
and [Page Send API](https://developers.facebook.com/docs/graph-api/reference/page/messages).

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
  ai_paused unchanged. Ordinary release is not AI handback.
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

### Local social autonomy candidate

- `OFFICE_META_SOCIAL_AI_CHANNELS` defaults empty. A listed channel still
  requires its existing inbound and outbound gates, recipient eligibility,
  a fresh signed inbound text event, and an explicit staff handback on that
  conversation. No WhatsApp flag controls this path. Keep this setting empty
  until separately approved; no production allowlists change.
- Apply `20261118_meta_social_autonomy.sql` after the takeover migration in
  an isolated database first. It preserves the four-argument staff fence and
  adds an AI form of the same fence that checks the captured ownership
  revision and the triggering inbound event. Takeover or pause wins before
  that fence. An already-dispatched request cannot be recalled; an unresolved
  outcome blocks new sends and handoffs. Pausing remains possible while an AI
  outcome is unresolved; ordinary ownership release still leaves AI paused.
- The same public Corporate Oyi Core call used by WhatsApp generates the
  answer. Tool proposals are not executed, handoff recommendations are not
  sent as automated text, and unavailable Core does not fall back to a local
  model. Both origins share the durable send ledger and receipt path.
  Generation is best-effort after the signed inbound event is committed;
  retrying the webhook never replays generation or a send.
- Office keeps the customer, staff, and accepted Oyi messages in one CRM
  thread. Before generation, Office reads the same lead/channel's durable
  customer and staff/assistant messages, orders and deduplicates them, and
  sends a typed `office_crm` transcript bound to the lead, channel, Oyi thread,
  and current inbound event. Core validates these bindings and places the
  transcript in canonical conversation context. If history is unreadable,
  mismatched, or exceeds 200 messages, generation is suppressed instead of
  using partial history. This coordinated contract is local-only and still
  needs release and integration verification; do not enable it in production.
  Staff notes and unrelated channels are never included.
- Instagram uses the existing Facebook Login model: Page access token,
  linked professional account, Page messaging task, and Instagram-scoped
  sender ID from signed inbound. The linked-Page send endpoint is distinct
  from the Instagram Login host and token model. Verify effective
  `instagram_basic`, `instagram_manage_messages`, applicable Page grants and
  App Review access before a separately approved live test. Existing inbound
  success is not proof of outbound eligibility. Keep per-message read state
  limited to exact-ID evidence; do not infer it from a watermark.

Meta references: [Messaging API overview and login-model changes](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/changelog/),
[linked Page conversations and permissions](https://developers.facebook.com/docs/graph-api/reference/page/conversations),
and [Page Send API](https://developers.facebook.com/docs/graph-api/reference/page/messages).

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
