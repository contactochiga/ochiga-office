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

## Scope: business accounts within one portfolio

Meta scopes a BSUID to a business **portfolio**, but the webhook carries only the WhatsApp Business Account (WABA) ID. A portfolio can hold several WABAs. Within one portfolio, the same person has the **same** BSUID under every WABA; across portfolios, the same person has **different** BSUIDs.

Phase 1 scopes everything to the WABA. That means:
- **Duplicate links are allowed per WABA.** A person who writes to two WABAs of the same portfolio gets one link per WABA. If the same phone is used, both point at the same lead. No uniqueness rule is violated, because each WABA is its own scope.
- **No cross-WABA inference.** A link recorded under WABA A is never used for a message under WABA B, even though Meta says the BSUID would be identical within the portfolio. Office can't verify from the webhook that two WABAs share a portfolio. Treating them as linked would be an unverified assumption, so the design accepts a missed match (the existing behaviour) instead of risking a wrong one.
- **Different portfolios:** these have different BSUIDs, so nothing can collide.

Making links portfolio-wide would need the portfolio ID from configuration plus an explicit list of WABAs in it. That would be a separate, approved change.

## Trusted and conflicted identities (the rule for Phase 2)

Phase 1 never uses these records for matching or sending. **Any future use must follow this rule.**

A BSUID may identify a lead **only** when **all** of the following hold:
1. there is exactly one row with `state = 'linked'` for that (business account, BSUID), and it names that lead;
2. there is **no** row with `state = 'conflict'` for the same (business account, BSUID), for any lead;
3. the lead has no conflict row of its own in that business account (`lead_linked_to_other_user_id`);
4. the business account is the one Office is configured for (see the Asset Guard dependency below).

Anything else means the BSUID is **contested or unknown**: it must not route, match or send, and the message falls back to today's behaviour plus human review. Conflict rows are never promoted to links automatically. Only a reviewed, audited human action may resolve one; that tool is not built yet. Structurally, a conflict row can never satisfy rule 1: only `state = 'linked'` rows sit under the one-link unique indexes, and the `conflict` state carries a mandatory reason.

## Dependency: WhatsApp Asset Guard (separate Office work)

An app signature proves Meta sent the request to our app. It does not prove which business account the event belongs to. Phase 1 takes the business account from the webhook (`entry[].id`) and links BSUIDs to leads matched by phone, which is global. If the app were ever subscribed to another WABA, a signed event for that **foreign** WABA would record links for our leads under the foreign scope. The trusted rule above would never act on them, but they would pollute the data.

The WhatsApp Asset Guard (separate work) admits only events whose WABA ID and phone-number ID both match Office's configuration. **It must be released before identity capture is switched on.** It is not needed before applying the migration, nor before deploying this code with capture off, since nothing is recorded while capture is off.

## Release sequence (each step separately approved)

1. **Preflight.** Confirm the production Office build and branch head are the expected base. Then run this read-only catalogue preflight; it reads no customer rows and needs authorization before running on production:
   ```sql
   select to_regclass('public.leads') is not null as leads_exists,
          (select data_type from information_schema.columns where table_name = 'leads' and column_name = 'id') as leads_id_type,
          to_regclass('public.whatsapp_sender_identities') is null as table_absent,
          current_setting('server_version_num')::int >= 130000 as gen_random_uuid_builtin;
   ```
   Expected: `true`, `uuid`, `true`, `true`.
2. **Apply the migration.** It is additive. The current production Office build (`f823eaa`) ignores the new table; its own Postgres suites pass with the table present.
3. **Deploy Office with capture OFF.** `OFFICE_WHATSAPP_SENDER_ID_CAPTURE_ENABLED` stays `false`. Then verify:
   - health;
   - authentication and protected routes;
   - that WhatsApp intake, replies, opt-outs and the Backend forward behave as before;
   - that the status endpoint shows `capture_enabled: false` with zero counts.
4. **Release the WhatsApp Asset Guard** (its own approval and checks).
5. **Turn capture on** (separate approval). Monitor through the admin status endpoint, which returns counts only, and the log events. Neither exposes customer identifiers:
   - `whatsapp_sender_identity.conflict_recorded`;
   - `whatsapp_sender_identity.capture_failed`;
   - `whatsapp_sender_identity.unresolved`.

   Watch conflicts and failures. A steady flow of `not_linked_without_identity` with reason `missing_business_account` would point at the Asset Guard or envelope configuration.

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
