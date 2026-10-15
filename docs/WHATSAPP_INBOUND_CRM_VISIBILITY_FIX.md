# WhatsApp inbound CRM visibility fix

Branch `fix/whatsapp-inbound-crm-visibility`, based on production `codex/office-extraction` @ `1e7b9526305c7b540d5910cec266b138afe6287e`. Not deployed.

## Confirmed root cause (production evidence + code audit)
The Unified Relationship Workspace shows an inbound WhatsApp message from a `conversations` row or, when none exists, from its `crm_activities` row (`whatsapp_message`). In `processWhatsAppMessageEvent()` the activity was written **only inside decision branches**: by `suppressAutonomousWhatsAppReply()` (reply suppressed) or at the very end after a reply was sent. Two early returns happened **before any activity was written**:
* **AI paused / human takeover** (`channelState.ai_paused` or `human_active|human_review`) → `return { paused: true }`;
* **a Backend goal owns the thread** (`forwardResult.goalActive`) → `return { deferred_to_goal: true }`.
(The "Oyi generation fails" and "autonomy OFF" branches did write an activity, but only after other work; an exception in the send left none.) Production confirms it: WhatsApp activities stop at 06:31 UTC on 2026-10-15; 62 inbound message events exist, **24 event rows (18 distinct provider message ids, 8 leads) have no CRM record** — the lead that is under human takeover accounts for the recent ones.

## Exact changes
1. **Canonical record on intake, before any reply decision** (`server.js`, `whatsapp-inbound-visibility.js`): right after `inbound_events` is written, `recordInboundActivity()` writes ONE `crm_activities` row carrying the provider message id, `source_event_id`, lead id, original Meta timestamp, direction, `provider: meta`, message type and request id. Idempotent: it first looks the record up by provider message id (Meta retries and stale-claim takeovers find it). The old late/decision-time activity writes were replaced by `annotateInboundActivity()`, which only merges `suppressed_reason` (`ai_paused`, `human_takeover_active`, `deferred_to_goal`, `autonomous_whatsapp_disabled`, …) / `ai_replied` into that same row — never a second record. Reply logic, autonomy policy, takeover, claims, Backend forwarding and the manual-reply code are untouched.
2. **Failures are observable and recoverable**: if the CRM record cannot be written the webhook result carries `crm_record_failed: true`, an error is logged (`whatsapp_webhook.crm_record_failed`), and a staff-visible timeline marker `whatsapp_crm_record_failed` is written. Intake is not blocked and nothing is re-sent (a retry cannot cause a send: claims make it a duplicate). The message stays safe in `inbound_events`.
3. **The conversation reads `inbound_events` directly** (`relationship-workspace.js`): inbound events are the authoritative record of what Meta delivered, so a message is visible regardless of its activity (suppressed, paused, taken over, goal-owned, failed generation, or failed write). Same provider message id ⇒ one entry (conversation row / activity / event merged, provenance kept). Duplicate delivery events of one message collapse. Two distinct customer messages (even identical text) stay two entries. A legacy activity (no provider id) is tied to its event only by a strict one-to-one match (same lead, identical text, ≤10 s, each activity used once); anything unmatched stays separate and flagged uncertain.
4. **Historical visibility repair** (below): `POST /api/lead-agents/admin/whatsapp/inbound-visibility/repair` (`manage_integrations`, audited, `dry_run` defaults to **true**).
5. **Stale UI**: independently demonstrated by a browser test (an open conversation did not show a new inbound message until navigation; the workspace had no refresh mechanism). Fixed minimally: every 15 s while the tab is visible the first inbox page is re-read (read-only); on change the inbox re-renders in place and, if the open lead has new activity, its thread reloads, **keeping the draft being typed and the scroll position**; it stops when the workspace leaves the screen.
6. Inbox ordering/time shown now use the later of the lead's activity clock and the last message, so the list is always in the order of the times it displays.

## Historical visibility recovery plan (separate approval; nothing was run)
The conversation view already shows every stored message (change 3), so history becomes visible immediately on deployment **without any write**. The repair back-fills the CRM activity records (for the activity feed, Overview and exports) and is optional but recommended.
* Measured today against production (local, read-only simulation with the same matching code; counts only): 62 inbound message events, 50 distinct provider ids (9 duplicate-delivery groups from before claims), 38 events already tied to a legacy activity by the strict match, **24 event rows / 18 distinct ids on 8 leads missing a CRM record** (2026-08-22: 6, 10-10: 3, 10-12: 4, 10-13: 3, 10-14: 2, 10-15: 6).
* Steps: (1) deploy; (2) `POST …/repair {}` → dry run lists what would be created; (3) review counts; (4) `POST …/repair {"dry_run": false}` creates only the missing activities (original provider id, timestamp, lead); (5) re-run → 0 missing. Safe because: events are never modified or deleted; every write is find-before-create on the provider id; nothing is ever sent; it is audited; a failure is counted and reported, not swallowed. Rollback is unnecessary (additive rows); if ever needed the created rows are identifiable (`metadata.recorded_by = inbound_webhook`, `request_id = visibility-repair`).

## Tests
`office:whatsapp-inbound-visibility:test` — 7 states (autonomy OFF; ON replies; ON with generation failure; AI paused; human takeover under ON and OFF; Backend goal owns the response): the message is stored, has exactly one CRM activity, appears once with the original provider id and timestamp, and no autonomous reply is sent where policy forbids; two distinct messages ⇒ two entries; retries ×3 and stale-claim takeover ⇒ still one; manual replies unchanged (governed, one outbound, 403 for staff without permission); a failing CRM write is flagged, marked, sends nothing and the message is still visible; recovery: legacy match, event-only recovery, identical messages not collapsed, dry run writes nothing, repair creates exactly the missing ones with original timestamps, is idempotent and audited, leaves events untouched and sends nothing. Store-level contract test (file store and the real Supabase store in the hardened replica). Browser: live refresh (new inbound message appears without reload, inbox preview updates, draft kept) plus all existing desktop/mobile tests. Negative control: the new suite fails on the unmodified production code.

## Test results (executed)
* Gates: `check` (119 files), `lint`, `build`, `security:secrets`, `deployment:validate` PASS. `office:whatsapp-inbound-visibility:test`, `office:whatsapp-autonomy:test`, `office:relationship-workspace:test` (API + durability + headless-Chrome desktop/mobile incl. the new live-refresh step; 3 consecutive stable browser runs) PASS. **Full Office suite 48/48.**
* Hardened-database run (real Supabase Postgres + PostgREST, P0 migration applied): the new store-level visibility test passes through the real `SupabaseLeadAgentsStore` (new PostgREST queries: `metadata->>provider_message_id` lookup, metadata merge, inbound-event listing); the Office suite gives **35/46 scripts identical before and after the migration, 4,977 service-role requests, 0 refused**. The 11 scripts failing in both phases inspect file-store internals (including the new server-level visibility test, the signature test and the browser test) and pass on the file store.
* Not tested: real Meta traffic (controlled adapter); production not touched.

## Deployment recommendation
**Recommend deploying** (frontend + server change; **no migration**, no Supabase/permission change, autonomy and signature mode untouched). Order: (1) approve a fast-forward of `codex/office-extraction` to this branch (clean fast-forward from production `1e7b9526…`); (2) verify the served `office.js` hash, `/healthz` (report mode still shown, autonomy OFF); (3) with the approved test number send one message while the lead is under takeover and confirm it appears in the open conversation within ~15 s and that a new `crm_activities` row carries its provider id; (4) run the repair dry run, review the 18 ids, and only after separate approval apply it. Rollback: push the previous SHA (`1e7b9526…`) as a new fast-forward commit; nothing to undo in the database (the repair is additive).

---
# Repair de-duplication revision (branch `fix/whatsapp-visibility-repair-dedup`)

The production dry run reported 24 raw rows / 18 provider ids and the owner stopped it correctly: the repair counted and wrote **event rows**, but Meta had delivered some messages several times before claim-first de-duplication existed, so one provider message can have several `inbound_events` rows.

## Fix
`planInboundVisibilityRepair()` (pure, unit-tested) now:
1. groups rows by provider message id and picks ONE canonical row per id by a fixed order (earliest `created_at`, then smallest `id` — independent of input order);
2. treats a message as already represented when **any** of its rows has an activity by provider id or by the strict one-to-one legacy match (not row by row);
3. keeps the lead association of the rows; rows of one id naming **different leads** are reported as `conflicting_lead_groups` and are never created or merged; a row without a lead beside a row with one is not a conflict; an id whose rows have no lead at all is an `invalid_records` entry;
4. reports raw missing rows, unique missing messages, duplicate rows, invalid and conflicting groups, already-represented messages and `proposed_activities` (at most one per id); occurred_at is the original provider timestamp; duplicate row ids are kept as provenance in `metadata.duplicate_event_ids`.
`repairInboundVisibility()` claims each message id atomically (`whatsapp_inbound_claims`, key prefix `visibility-repair:`) before find-then-create, so concurrent runs — in one process or several — cannot both create a record; it never modifies/deletes events, never sends and never calls any reply, Oyi or Backend path. The audit event now records raw/unique/duplicate/invalid/conflict counts.

## Tests (`scripts/test-whatsapp-visibility-repair-dedup.js`, store API only — also runs on the real Supabase store)
Production-shaped fixture (18 distinct missing ids, 6 of them delivered twice = 24 rows; plus already-represented messages by id, by legacy match, and legacy match with a duplicate row) → dry run reports **24 / 18 / 6 / 0**, 18 proposals, represented messages excluded, original timestamp and lead kept, deterministic, writes nothing; canonical row independent of order (and tie-break by id); conflicting leads reported and skipped (the 18 proposals unaffected), partial-lead tolerated, no-lead invalid; apply creates exactly one activity per id with duplicate provenance, original events byte-for-byte unchanged and none deleted; repeat run creates nothing; **4 concurrent repairs create exactly one activity per id** (negative control: without the claim guard the same run creates 13 records for 10 messages); strict one-to-one legacy matching preserved (two identical messages, one legacy activity ⇒ one proposal).

## Corrected dry run on PRODUCTION data (local read-only computation with the same code; counts only; nothing was written)
| | |
|---|---|
| inbound message event rows | 63 (one more than when first counted: a test message arrived) |
| distinct provider message ids | 51 |
| already represented by a CRM activity | 34 messages |
| **raw missing event rows / unique missing messages / duplicate rows** | **21 / 17 / 4** |
| invalid records | 0 |
| **conflicting lead identities** | **1 message (excluded)** |
| **proposed new activities** | **16**, on 6 leads (2026-08-22: 2, 10-10: 3, 10-12: 2, 10-13: 1, 10-14: 2, 10-15: 6) |
Why this is not 24 / 18 / 6: the previous per-row counting included **one provider message delivered five times that already has a CRM record** (one of its rows matched a legacy activity, its other rows looked "missing"): applying the old logic would have created duplicate activities for it. Excluding it gives 17 unique missing; one of those is the conflicting identity below, so 16 are proposed.
**Conflict (needs your decision):** two provider message ids (one already represented, one missing) were each delivered twice within one second on 2026-10-13 and the two deliveries created **two different leads for the same phone number** (two pairs of duplicate leads). The repair will not choose a lead. Merging duplicate leads is a CRM data decision that is not authorised here; until then the conversation view still shows that missing message under each lead that stores it.

## Test results for the de-duplication revision
Gates PASS (`check` 120 files, `lint`, `build`, `security:secrets`, `deployment:validate`); visibility suites (server-level 7 states, store contract, **dedup**) PASS; autonomy and workspace suites incl. browser PASS; **full Office suite 49/49**. Hardened-database run: the dedup suite (including four concurrent repairs through the real claims table) and the store suite pass through the real `SupabaseLeadAgentsStore`; Office suite 36/47 identical before/after the P0 migration, 5,280 service-role requests, 0 refused (the 11 file-store-only scripts fail in both phases). Not executed: any production repair (no write was made to production).

## Exact approval needed to run the repair (after deployment of this branch)
1. Approve deploying this branch (fast-forward of `codex/office-extraction`; code only, no migration).
2. Re-run the dry run in the browser console (it will print the corrected numbers above, possibly +1 if a new message arrived) and confirm 16 proposals / 1 conflict.
3. Decide how to treat the conflicting identity (leave it, or authorise a separate CRM clean-up of the duplicate leads).
4. Approve `{"dry_run": false}`.
