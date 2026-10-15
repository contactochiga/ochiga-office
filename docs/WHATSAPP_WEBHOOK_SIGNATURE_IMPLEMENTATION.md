# WhatsApp webhook signature enforcement — implementation

Branch `security/whatsapp-webhook-signature-enforcement` (base `6a9e5ef7947361042f39207666369a0359140e18`). Not merged, not deployed.

## Request order (POST /webhooks/whatsapp)
1. Read the **exact bytes** (`readRawBodyBuffer`, 1 MB cap as before).
2. Verify `X-Hub-Signature-256` with `verifySignature(buffer, header)` — HMAC-SHA256 under `META_APP_SECRET`, timing-safe, over the exact bytes, or (only if the body contains non-ASCII) over Meta's documented lower-case `\uXXXX`-escaped form.
3. Record the outcome in the evidence counters (below).
4. **Enforce** (default): refuse before anything is parsed — `503 webhook_not_configured` if no secret is configured (fail closed), `401 invalid_signature` if the header is missing/empty/malformed, `403 invalid_signature` on mismatch. A rejected request is never parsed, so it cannot create a lead, contact, inbound event, claim, conversation, timeline/activity record, call Backend/Oyi Core or cause an outbound message (all asserted by tests).
5. Only then `JSON.parse`, extract events, run CRM / claims / autonomy / Backend processing exactly as before.
The GET verification challenge is unchanged (valid token → echo, otherwise 403). Webhook URL, subscriptions, number and autonomy policy are untouched.

## Changes
* `src/lead-agents/whatsapp.js` — `verifySignature` rewritten (bytes, explicit reasons `app_secret_not_configured` / `missing_signature` / `malformed_signature` / `signature_mismatch`, reports which form matched); `escapeNonAscii`.
* `src/lead-agents/http.js` — `readRawBodyBuffer` (the existing `readRawBody` now delegates to it).
* `src/lead-agents/server.js` — handler order above; observation-only count/log of events addressed to a phone-number id other than the configured one (processing unchanged); `/healthz` now exposes `whatsapp_webhook: { signature_mode, app_secret_configured }` (booleans/mode only).
* `src/lead-agents/config.js` — `WHATSAPP_WEBHOOK_SIGNATURE_MODE`: `enforce` (default; any other value also means enforce) or `report`.
* `src/lead-agents/webhook-signature-stats.js` — counters-only evidence stored under runtime-settings key `whatsapp_webhook_signature_stats` (valid_raw, valid_escaped_unicode, missing_signature, malformed_signature, signature_mismatch, app_secret_not_configured, last valid/invalid timestamps and reason, phone-number-mismatch count). No secrets, signatures, bodies or phone numbers; writes batched to one per 10 s per process and never block a webhook.
* `scripts/verify-meta-webhook-signature.js` — offline helper: `compare` (two secrets, prints MATCH/MISMATCH only) and `sample` (captured body + header).
* `scripts/test-whatsapp-webhook-signature.js`, npm script `office:webhook-signature:test`.

## About `report` mode
`report` reproduces the legacy behaviour (failures logged at error level, counted, request still processed) and exists **only** as an explicit, temporary rollout aid so that enforcement can be proven against genuine Meta traffic before it can drop customer messages. It is off unless the environment variable is set to exactly `report`, is visible in `/healthz`, and must be removed after validation. It is not a fallback: nothing reverts to it automatically.

## Tests (`npm run office:webhook-signature:test`; real adapter and HMAC, fixture secret only)
A valid signature accepted + normal CRM intake; B missing, G empty, F four malformed shapes (no prefix, short, sha1, non-hex) → 401; C wrong signature, D tampered body, E wrong secret, I re-serialised JSON → 403; H no secret → 503 fail closed (even with a signature); I2 raw emoji body, Meta-escaped-unicode form, upper-case-escaped form refused, invalid-UTF-8 bytes hashed exactly; J/K GET challenge valid/invalid/missing token; L/M/N/O after 11 rejected variants the store snapshot (leads, contacts, inbound events, claims, conversations, timeline, activities, channel states) is byte-identical, the Backend stub received zero calls and the outbound spy zero sends; Q duplicate valid delivery → one lead / one stored message; R valid status events processed; S autonomy OFF → no outbound, suppression recorded, autonomy setting never written; T human takeover preserved; counters recorded and free of secrets/signatures/phone numbers; report mode explicit and visible; foreign phone-number id observed; helper prints MATCH/MISMATCH only. Negative control: the same suite fails against the unmodified production code (unsigned request → 200).
