# WhatsApp sender identity, Phase 1

Status: local implementation, **disabled by default** (`OFFICE_WHATSAPP_SENDER_ID_CAPTURE_ENABLED=false`).

## Why

Meta now identifies WhatsApp users by a business-scoped user ID (BSUID). Meta's "Business-scoped user IDs" documentation says:
- **Fields:** the BSUID arrives in `messages[].from_user_id` and `contacts[].user_id`.
- **Format:** an ISO 3166 alpha-2 country code, a period, then up to 128 alphanumeric characters, for example `US.13491208655302741918`.
- **Uniqueness:** "unique to each business portfolio-user pair". It is not global.
- **Changes:** it is regenerated if the user changes phone number.
- **When the phone is left out:** a user's phone (`from`, `wa_id`) is omitted only when the user has a username, the business hasn't exchanged messages with them in 30 days, and they aren't in the business's contacts.

Phase 1 records the BSUID next to the lead the existing phone-based matching already chose, while phones are still being sent. When a phone later goes missing, the association already exists for Phase 2 to use.

## What Phase 1 does, and does not do

- **Does:**
  - reads the BSUID from the documented fields only, preferring `from_user_id` and falling back to this sender's `contacts[]` entry; if the two disagree, nothing is used;
  - when the message also carries the sender's phone, links the BSUID to the lead the phone matched;
  - records conflicts for human review;
  - refuses a BSUID-shaped `from` or status `recipient_id` as a phone number, so an ID can never become a digit string that matches another customer.
- **Does not:**
  - change which lead a message belongs to, the reply decision, the recipient, goal wake-ups, opt-outs or the Office → Backend payload (it carries no new field);
  - link a BSUID-only message (no phone). Those are counted and handled exactly as before, so they can never block the correct link later;
  - use parent BSUIDs (`US.ENT.…`);
  - send anything to a BSUID. Identifier-only messaging is Phase 2.

## Storage (`db/20261113_whatsapp_sender_identities.sql`)

The migration adds one new table, `whatsapp_sender_identities`. No existing table, RLS setting, policy or grant changes.

- **Scope:** `business_account_id`, the WhatsApp Business Account ID from the webhook's `entry[].id`. A business account belongs to one portfolio, so this is never looser than Meta's portfolio scope.
- **One link per sender:** at most one linked lead per (business account, BSUID). This is a partial unique index.
- **One sender per lead:** at most one linked BSUID per (business account, lead). This is a partial unique index.
- **Concurrency:** writers use a plain insert and re-read on 23505, so concurrent messages produce exactly one link.
- **Conflicts:** one row per (business account, BSUID, lead), as a full unique constraint. `state = 'conflict'` with a reason:
  - `user_id_linked_to_other_lead`, with `conflicting_lead_id` naming the other lead;
  - `lead_linked_to_other_user_id`.

  Nothing is merged, overwritten or reassigned. The lead's timeline gets one note, "WhatsApp identity needs review", which contains no BSUID.
- **Format checks:** the BSUID must match `^[A-Z]{2}\.[A-Za-z0-9]{1,128}$` (so never a phone or a parent ID), and the business account must be numeric.
- **Deleting a lead** removes its identity rows and clears references to it.
- **Access:** RLS is on and there are no policies, so the table is server-only.

## Rollback: non-destructive

| Tier | Action | Effect on data |
|---|---|---|
| 0 | Capture switch off and restart | None; capture stops |
| 1 | Redeploy the previous Office build | None; the table is kept and unread |
| 2 | **Separately approved:** `db/rollback/20261113_whatsapp_sender_identities.tier2_archive.sql` | Renames the table to `whatsapp_sender_identities_archive`. **No row is deleted.** It refuses to overwrite an existing archive. Restoring means renaming back (tested). |

`db/rollback/20261113_whatsapp_sender_identities.down.sql` changes nothing. It documents the tiers and holds a read-only check.

## Admin status

`GET /api/lead-agents/admin/whatsapp-identity/status` requires `manage_integrations` and is read-only. It returns:
- whether capture is on;
- linked and conflict counts, with conflicts by reason;
- capture health since the process started.

It returns no BSUIDs, phone numbers, leads or message IDs.

## Deployment order

The commercial Backend does not change in Phase 1, because the Office → Backend payload is unchanged.
1. Deploy Office (switch off).
2. Apply the migration.
3. Turn the switch on.

Each step needs approval. The steps are independent of the WhatsApp media queue.
