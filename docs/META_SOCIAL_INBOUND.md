# Meta social inbound: local Track B

## Boundary

Office owns the Meta callback and staff CRM. `GET/POST /webhooks/meta-social` is independent of `/webhooks/whatsapp`, and is disabled unless `OFFICE_META_SOCIAL_INBOUND_ENABLED=true`. It shares Office's HTTP body limits and uses the existing Meta app secret with mandatory raw-byte HMAC. Configure a distinct `META_SOCIAL_VERIFY_TOKEN` and explicit `FACEBOOK_PAGE_ID` and/or `INSTAGRAM_BUSINESS_ACCOUNT_ID`. The app verifies the challenge via GET and signs POST deliveries; no Graph access token is needed by the receiver itself. A supported channel with no valid configured ID fails closed and is retryable.

Only incoming text from a `page` or `instagram` envelope reaches storage. The entry ID and recipient ID must both match the configured asset. Echoes, self events, unsupported events and media-only events are ignored. There are no media downloads, receipts, historical imports, outbound replies, or AI calls. Text accompanying an attachment can be retained without the attachment. No WhatsApp route, forwarding logic, or autonomy setting is changed.

## CRM and persistence

The existing `leads`, `conversations`, `lead_channel_states`, and permission-checked relationship inbox are reused. A deterministic sender key scopes one lead to the channel, receiving business asset and sender. It does not infer a phone number, email, contact match, or marketing permission. Initial leads get a generic channel label. No automatic cross-channel contact merge is attempted. The deduplication key scopes the Meta message ID to channel and business asset; it uses the existing unique conversation correlation key. A failed write gives a batch-level 503 so a retry does not lose accepted siblings. Logs and webhook responses contain aggregate counts, not identifiers or message content.

`db/20261113_meta_social_inbound.sql` is a proposed service-role-only, security-invoker RPC over the existing tables. It adds no tables, columns or grants to customer roles. It expects the existing unique lead idempotency and conversation correlation indexes. It serializes matching writes and commits lead, message and state together. The file driver is for single-process local testing; the deployed driver needs the RPC. The proposed SQL is exercised only against an ephemeral in-memory PostgreSQL fixture.

The Backend's `/office/communications/webhook-event`, outbox event normalization, communication types, SQL channel constraints and goal routing are not yet social-aware. Do not repurpose the WhatsApp outbox or bridge for these events. Office's existing CRM is the only message store in this slice. A later, separately reviewed Backend integration may extend the canonical contracts and existing outbox for non-sending evidence. No Backend changes are required for this inbound slice.

## Access and staged release

1. Review the local diff and test evidence. Confirm actual Office Render baseline and preview triggers before any push. No production release is part of this work.
2. Reuse Ochiga Systems. Confirm the Page and linked professional Instagram account, and obtain the actual Graph Instagram account ID through Facebook Login. For Messenger, validate `pages_messaging`, `pages_manage_metadata` and the Page messaging task; for Instagram validate `instagram_basic`, `instagram_manage_messages`, the applicable Page grants, and the linked Page messaging task. Verify access level and grants for each asset; obtain Advanced Access/App Review where required for non-role users. No app, subscription or token change has been made.
3. In separately approved staging, verify schema indexes and service-role-only RPC execution, and apply the proposed SQL only after approval. Deploy disabled, then verify the existing Office and WhatsApp smoke paths. Configure isolated test assets with a distinct callback for the Page and Instagram `messages` fields and verify both app-level and asset subscriptions. Do not overwrite the WhatsApp callback.
4. In an authorized test-asset pilot, confirm the exact webhook envelope, signature, scoped matching, cross-channel isolation, durable retry and CRM visibility. Verify the observed IDs match configured IDs. Keep AI OFF. Stop on unexpected IDs or retries; disable the social receiver to roll back without removing records or changing WhatsApp.
5. Staff replies need a separate send adapter, approved Page credentials, messaging-window enforcement, takeover policy, durable intent and receipt correlation. Comments, moderation, engagement, publishing and scheduling remain separate deliverables. The existing Content/Sanity workflow stays unchanged.

References: [Meta Messenger Platform](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api), [linked Page and Instagram permissions](https://www.postman.com/meta/messenger-platform-api/folder/22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a).
