# Unified CRM Relationship Workspace — Step 3 deployment report (2026-10-15)

**Release status: DEPLOYED — PARTIALLY VERIFIED** (code live and verified by behaviour; authenticated production UI walkthrough, Render deployment id and a live manual send are outstanding for the reasons below). Autonomous WhatsApp responses remain OFF.

* Deployed SHA: `83b717983b14de077c39a940ccae5319bd296930` (non-force fast-forward of `codex/office-extraction` from `c91d51776e44b5885490ea6984f16b6913031adb`; preflight confirmed the feature was a clean fast-forward descendant).
* Render deployment id / LIVE flag: **not available** — the Render CLI/dashboard token is unauthorized in this environment. Evidence of the live deploy instead: the served `office.js` (Render service URL and office.ochiga.com.ng) changed from `73f2be69c0409fe7` to `bee0a10bc997ed9a` = the SHA-256 prefix of the branch file; `/healthz` returned 200 with an uptime reset (~19 s) at 07:35:56 UTC and `store_driver: supabase` with live counts (leads 68, audit 917).
* New routes are live and authenticated: relationship inbox/thread, manual reply and resolve routes return 401 without a session; `/api/lead-agents/leads` 401; the served bundle contains the workspace code.
* Supabase after deploy: 57 public tables, RLS-off 0, anon/authenticated SELECT 0, anon schema USAGE denied, `whatsapp_manual_sends` present and empty, customer records unchanged (leads 68, conversations 316, audit 917, inbound events 263).
* `whatsapp_autonomous_responses_enabled` = **false** (verified in the database before and after the deployment; no code path of this release writes it).
* Backend untouched (`44afac31…`); Meta credentials, webhook subscriptions and phone-number ids untouched.

## Verification that was performed
Production, unauthenticated/black-box: items above. Test environment on the deployed SHA (controlled adapters, no customers): manual-send durability suite PASS (8 provider calls total across all scenarios; 8 concurrent duplicates across 2 instances → 1 provider attempt; duplicates after restart refused; unknown outcome never retried; reconciliation makes no provider calls), relationship-workspace API suite PASS, headless-Chrome desktop+mobile suite PASS, autonomy suites PASS; earlier: full Office suite 45/45 and the hardened-database differential run.

## NOT verified / outstanding
1. **Authenticated production UI** (three-column layout, Leads/Contacts/Organizations/Opportunities, source indicators, documents, mobile) was **not exercised in production**: no staff credentials are available to me and I did not create or reset any account. The same code passes the headless-Chrome suite locally; production walkthrough needs a test staff login or an owner-run check.
2. **Live manual-send idempotency in production** not exercised: no authorised recipient confirmed; no production WhatsApp message was sent.
3. Render deployment id and LIVE status flag (see above); Render logs unreadable.

## Finding to act on (pre-existing, unchanged by this release)
`POST /webhooks/whatsapp` does not enforce Meta's `X-Hub-Signature-256` (documented in code since 2026-08-22: stale `META_APP_SECRET` suspected). An unsigned request returns 200, so anyone who knows the URL could inject fake inbound messages/leads. Recommended: confirm/regenerate the app secret, then enable enforcement (separate, approved change).

## Limitations (unchanged)
No real Meta traffic in tests; autonomous Oyi/bridge sends are not stored in Office tables and so are not in the thread; WhatsApp media, inbound email, LinkedIn/Facebook/Instagram not connected; reconciliation runs when a thread is opened; Render Free plan sleep risk; the file store is single-process.

## Rollback
Previous Office build with the permanent autonomy switch: `c91d51776e44b5885490ea6984f16b6913031adb` (push it back as a new non-force commit or use Render rollback). The new table/column are additive and ignored by the previous build; never roll back to a pre-autonomy-switch build; never restore anon/authenticated grants.
