# WhatsApp webhook signature enforcement — release readiness

## Decision: **BLOCKED — META SECRET VERIFICATION REQUIRED**
The code is implemented and tested. It must not be put live in its default (enforcing) form until it is proven that production `META_APP_SECRET` is the secret of the Ochiga Systems app and that genuine Meta deliveries verify: the secret could not be compared (Render and Meta credentials are not accessible from here and are never to be exposed) and no genuine signed delivery could be inspected. Enforcing against a wrong secret would reject every real customer message (Meta retries failed deliveries for a limited time, but enquiries would be delayed or lost).

## Branch
`security/whatsapp-webhook-signature-enforcement` — https://github.com/contactochiga/ochiga-office/tree/security/whatsapp-webhook-signature-enforcement. Based on production `6a9e5ef7947361042f39207666369a0359140e18` (clean fast-forward). The exact commit SHA is in the hand-off message (this document is part of that commit).

## Summary of audit and fix
Root cause, status quo and fix are in the Audit and Implementation documents. In short: production accepts unsigned webhooks (confirmed live: unsigned POST → 200); the body was decoded to a string before hashing and parsed before authentication; Meta's escaped-unicode signing form was not handled; the historical mismatches on ASCII status callbacks most probably come from a stale/incorrect secret (unverified). The fix authenticates the exact bytes first, fails closed without a secret, refuses with 401/403/503 before any parsing or storage, accepts Meta's documented escaped form, and records counters-only evidence.

## Test results (all executed)
* New suite `npm run office:webhook-signature:test`: PASS — valid accepted; 11 unauthenticated variants refused with zero side effects (no lead/contact/event/claim/conversation/timeline/activity, no Backend call, no outbound); no secret → 503; raw/escaped/invalid-UTF-8 handling; GET challenge; duplicates, status events, autonomy OFF, human takeover; evidence counters; helper tool. The same suite **fails against the unmodified production code** (negative control).
* Gates: `check` (116 files), `lint`, `build`, `security:secrets`, `deployment:validate` PASS. `office:whatsapp-autonomy:test`, `office:relationship-workspace:test` (incl. headless-Chrome desktop/mobile, CRM Leads three-column default, manual-send durability) PASS. **Full Office suite 46/46.**
* Supabase compatibility: no schema or permission change; the evidence counters use the existing runtime-settings table/store method (service role, RLS unchanged). Not re-run against the hardened replica (the new suite inspects file-store internals); the store call is the same one the autonomy switch already uses in production.
* Not tested: real Meta traffic (fixture secret only).

## Credential changes that may be required (owner)
Only if the comparison reports MISMATCH: set Render `META_APP_SECRET` to the current value of the Ochiga Systems app secret (Meta dashboard → App settings → Basic). No regeneration is needed or recommended unless the secret is lost or suspected exposed (separate approval). The access token is a different credential and is not involved.

## Safe deployment order (needs owner approval at each credential/branch step)
**Option A — prove first (recommended):**
1. Owner runs the offline comparison on their own machine: set `META_SECRET_A` (Render value) and `META_SECRET_B` (Meta dashboard value) in the shell, run `node scripts/verify-meta-webhook-signature.js compare`; expect `MATCH`. If MISMATCH, correct the Render secret first.
2. In Render, set `WHATSAPP_WEBHOOK_SIGNATURE_MODE=report` (explicit, temporary). **Do this before the code is deployed**, otherwise the deploy enforces immediately.
3. Fast-forward `codex/office-extraction` to this branch (Render auto-deploys). Confirm `/healthz` shows `whatsapp_webhook: {signature_mode: "report", app_secret_configured: true}`, WhatsApp intake still works, autonomy still OFF.
4. Generate genuine signed traffic: Meta dashboard → WhatsApp → Configuration → webhook "Test", plus a real message from an approved test number. Read the evidence (read-only SQL on the runtime setting `whatsapp_webhook_signature_stats`): `valid_raw` or `valid_escaped_unicode` ≥ 1 and **zero** `signature_mismatch` across genuine traffic (including at least one status event and one message with an emoji).
5. Remove `WHATSAPP_WEBHOOK_SIGNATURE_MODE` (back to the default `enforce`). Verify `/healthz` shows `enforce`; an unsigned POST returns 401; a genuine message still reaches the CRM; autonomy OFF; the CRM Leads workspace loads.
**Option B — direct:** if step 1 returns MATCH and a captured genuine delivery passes `verify-meta-webhook-signature.js sample`, deploy with the default enforcement and run the step-5 checks immediately.

## Rollback
Instant, no code change: set `WHATSAPP_WEBHOOK_SIGNATURE_MODE=report` in Render (service restarts; legacy behaviour; stays visible in `/healthz`) and investigate. Or push the previous SHA `6a9e5ef7947361042f39207666369a0359140e18` (which keeps the autonomy switch, the manual-send ledger and the workspace). Never roll back to a build that predates the autonomy switch. Rolling back reopens the forged-webhook exposure, so treat it as temporary.

## Remaining risks
Unverified secret/genuine-signature status (the blocker); `report` mode, while set, accepts unauthenticated events; phone-number-id mismatches are observed but not blocked (a follow-up could block foreign phone-number ids once the official id is confirmed in config); the GET challenge compares the verify token with a non-constant-time equality (low risk); the evidence counters are best-effort (batched, may undercount under crashes).

## Exact approval needed before deployment
1. Owner confirmation that the secrets compare as MATCH (or authorisation to correct Render's `META_APP_SECRET`).
2. Authorisation to set `WHATSAPP_WEBHOOK_SIGNATURE_MODE=report` in Render **before** deploying (Option A), then to remove it after the evidence is clean.
3. Authorisation to fast-forward `codex/office-extraction` to this branch.
