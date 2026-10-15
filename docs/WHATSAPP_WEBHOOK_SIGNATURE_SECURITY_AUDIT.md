# WhatsApp webhook signature — security audit (2026-10-15)

Baseline: `codex/office-extraction` @ `6a9e5ef7947361042f39207666369a0359140e18`, Render service `ochiga-lead-agents`. Read-only audit; no production configuration or credential was read, changed or printed.

## Finding 1 — enforcement is OFF in production (confirmed live)
`POST /webhooks/whatsapp` computed the signature check but only logged `whatsapp_webhook.signature_check_failed_not_enforced` and carried on (a deliberate 2026-08-22 workaround). **An unsigned request to production returned HTTP 200** (verified today with a harmless empty-entries payload; no event, lead or record was created). Anyone who knows the URL can therefore submit forged `messages` events: they would be stored, create or update CRM leads and contacts, create claims, be forwarded to the Backend/Oyi Core and (with autonomy ON) could trigger a customer reply. With autonomy OFF the impact is CRM pollution, Backend event injection and staff-facing deception, not outbound messages.
A negative-control run of the new test suite against the unmodified production code fails at the first unsigned case ("expected 401, got 200").

## Finding 2 — how the raw body was handled
* Body read: `readRawBody` concatenated the request chunks and **decoded them to a UTF-8 string**; the HMAC then re-encoded that string. For well-formed UTF-8 this round-trips to identical bytes, but any invalid UTF-8 sequence is replaced by U+FFFD, so the hashed bytes would differ from what Meta signed (a latent false mismatch). No middleware, proxy rule or JSON re-serialisation touched the body in this path (it is read directly from the socket; the HMAC was not computed over a re-serialised object).
* **JSON was parsed before authentication** (`readJsonBodyWithRaw`), i.e. unauthenticated input reached `JSON.parse` and, because failures were ignored, everything downstream.
* HMAC construction (SHA-256, key = app secret, `sha256=` prefix, hex) and the timing-safe comparison were correct. A missing secret returned `app_secret_not_configured` but was also ignored.

## Finding 3 — Meta's documented signing form
Meta's webhook documentation states the signature is computed over the payload with characters above U+007F written as lower-case `\uXXXX` escapes. A body that contains emoji or accented letters (common in customer messages) can therefore fail a comparison over the raw bytes even with the correct secret. Enforcing on raw bytes alone would have silently dropped such genuine messages. The fix accepts either form (exact bytes, or the documented escaped form); both are HMACs under the secret, so this widens nothing for an attacker.

## Finding 4 — root cause of the historical `signature_mismatch`: NOT conclusively established
The 2026-08-22 note records mismatches on genuine **status callbacks**. Status payloads are ASCII, so neither finding 2 nor 3 explains them. The remaining and most probable cause is a stale or wrong `META_APP_SECRET` in Render (or the secret of a different app/version); an intermediary altering the body is unlikely. This could **not** be verified: the Render dashboard/CLI token is unauthorized here and Render logs are unreadable. The configured value was never read.

## Finding 5 — evidence available about genuine traffic
Since 2026-08-22 production stored 56 inbound WhatsApp messages and 210 status events, so genuine Meta deliveries do arrive. The stored payloads do not retain `metadata.phone_number_id`, so I could not confirm from history that events are addressed to the official number `585884641275180` or whether they carried valid signatures. (New code counts such events going forward.)

## What cannot be established without the owner
1. Whether production `META_APP_SECRET` equals the secret of the Ochiga Systems app (ID 1283123133776348). A local offline comparison tool is provided (`scripts/verify-meta-webhook-signature.js compare`) that prints only MATCH/MISMATCH.
2. Whether genuine signed deliveries verify. The release records counters-only evidence (valid / escaped / missing / mismatch) so this can be proven from real traffic before enforcement is relied on.

## Other observations
The GET challenge uses `WHATSAPP_VERIFY_TOKEN` with an exact comparison (non-constant-time, low risk; unchanged). The access token and the app secret are distinct credentials; nothing here uses the access token for authentication of inbound requests.
