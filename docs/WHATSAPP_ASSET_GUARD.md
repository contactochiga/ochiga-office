# WhatsApp webhook asset guard

An app signature authenticates the request, not the addressed business asset. The POST receiver only handles `whatsapp_business_account` / `messages` callbacks whose entry WABA ID and phone-number ID both match Office configuration. These rules apply equally to messages and statuses. The GET subscription challenge is unchanged.

## Behavior

- A missing or invalid signature is refused before payload parsing. The old report-only signature bypass is not supported.
- If either `WHATSAPP_BUSINESS_ACCOUNT_ID` or `WHATSAPP_PHONE_NUMBER_ID` is absent, authenticated callbacks receive 503. An empty value does not authorize any asset.
- Signed batches for unrelated objects, fields or assets are acknowledged; only authorized events reach claims, CRM, outbox and response logic. A missing provider asset ID is not inferred from a display number, sender or another entry in the batch.
- The asset guard logs counts only. The acceptance count means eligible for processing, not stored or delivered. Existing message deduplication and status outbox idempotency are unchanged.

## Release preflight (not performed by the local implementation)

1. Compare the running Office pair with WhatsApp Manager: WABA `531423816726977`, phone-number ID `585884641275180`. The IDs are not secrets. Do not change credentials, subscriptions or the live callback. Verify that both incoming message and status envelopes carry both IDs, using sanitized evidence or controlled test assets.
2. Release Office only. No Backend change or migration is required. Leave autonomous replies OFF and verify that valid messages and statuses still reach the existing Office and Backend paths after deployment. Watch the asset guard counters, especially missing or foreign IDs and 503 responses.
3. If legitimate traffic is refused, investigate the configuration and provider envelope before expanding any allowlist. Reverting to the previous Office build restores signature enforcement as configured but removes the asset guard; use only the known production baseline with autonomy OFF.
