# WhatsApp autonomy A1–A3 deployment report (2026-10-15)

## Conclusion
**DEPLOYED — AUTONOMOUS RESPONSES OFF**, with three acceptance checks that need the owner (listed under "Incomplete"). Render Free plan unchanged; no Meta, webhook, phone-number, Render env or billing changes; nothing enabled.

## Preflight (all passed)
Backup archive present, SHA-256 `cadcdeec8dd9469f8605c81e4e16c4ac754e71f8d1579c3128c0fb6bedc7d16a` matches. Pre-deployment SHAs: Office `codex/office-extraction` = `a0bd54e9609461f84ce091287a33d519decc3c6e`; Backend `main` = `3a9956dc139746c592a10cc081d0de7c9a299989`. Release candidates were clean fast-forwards (Office RC ahead 8 / behind 0; Backend ahead 2 / behind 0). P0 state: 54 tables, RLS off 0, anon/authenticated SELECT 0, anon schema USAGE denied, migration `20261014210318`. Autonomy tables absent beforehand. Pre-migration counts: WhatsApp message events 53, distinct provider ids 41, inbound_events 255, leads 68, audit_events 915. Settings default OFF: missing/malformed/unreadable setting is OFF (fail-closed; covered by `office:whatsapp-autonomy:test`, PASS). Rollback-safe Office build `a0bd54e9…` remains in Git history.
Render deployment IDs: NOT RECORDED (Render CLI unauthorized; I have no dashboard access). Deployment was verified by behavior instead (below).

## A1 — migrations (applied 2026-10-15 via the Supabase CLI, as role `postgres`, in the stated order)
1. `20261014_office_runtime_settings.sql`: `office_runtime_settings` created, owner `postgres`, RLS on, 0 policies, anon/authenticated no access, service_role SELECT/INSERT/UPDATE/DELETE. Rows: 0 (= effective default OFF).
2. `20261015_whatsapp_inbound_claims.sql`: `whatsapp_inbound_claims` created, same security properties; **41 historical provider ids seeded as completed claims** (matches the 41 distinct ids); 0 non-completed. Historical `inbound_events` untouched (255 before and after).
Post-state: 56 public tables, RLS off 0, anon/authenticated SELECT 0, leads 68, audit_events 915 (unchanged). Uniqueness of provider id is a primary key; concurrent claim behavior was proven by the branch tests and the earlier replica run. These two migrations were not recorded in `supabase_migrations` (applied with `db query`), note for tracking.

## A2 — Backend
Fast-forward `3a9956d..44afac3` pushed to `main`. Verified live: `https://oyi-os.onrender.com/version` returns `commit_sha 44afac3182a709de63642359a783709ae6a0f435`; `/health` OK, database healthy, queue (redis) healthy. Branch tests (earlier, same SHA): typecheck, build, whatsapp-send-origin, communication-runtime, goal-runtime, automation-action, communications-layer pass. Render deployment ID: not recorded.

## A3 — Office
Fast-forward `a0bd54e..c91d517` pushed to `codex/office-extraction` (no force). Verified live: process restarted (uptime reset ~06:05:47 UTC), `/healthz` 200 with `store_driver: supabase`, and the served `office.js` now hashes to the RC's file (`73f2be69…`, contains the WhatsApp autonomy settings UI) instead of the old build's (`3fb947c7…`). Unauthenticated API routes still return 401. Deployment ID: not recorded.

## Production security after rollout
RLS on all 56 public tables; anon/authenticated access none; anon schema USAGE denied; service_role operational; no new policies. P0 migration not touched.

## Evidence for the no-reply behavior
Before this deployment (hard-OFF build) a live inbound message at 2026-10-14 21:29 UTC created a lead and logged `whatsapp_autonomous_reply_suppressed` with no outbound. After this deployment no inbound message has arrived yet (latest inbound still 2026-10-14 21:29:12), so no new live evidence exists for the permanent build. Offline: all 42 Office scripts and both autonomy suites pass (global OFF blocks replies, GoalRuntime/automation/templates via the bridge, missing lead id, human takeover, duplicate deliveries, HMAC staff-confirmed sends, unreadable setting).

## Incomplete (not claimed)
- Settings UI in a browser (Office → Settings → Integrations → WhatsApp should show AUTONOMOUS RESPONSES OFF, admin-only control): needs an authenticated admin session; none available to me.
- Live WhatsApp acceptance (inbound -> CRM, no reply, duplicate-delivery claim row): needs an owner message from an approved test number. Expect afterward: one new `whatsapp_inbound_claims` row, a `whatsapp_autonomous_reply_suppressed` timeline event reason `autonomous_whatsapp_disabled`, no outbound.
- Staff-confirmed send through the HMAC path: needs an authorized staff session.
- Restart persistence of the setting: the setting is a database row; no row exists, default OFF.

## Limitations accepted
Render Free plan: sleeps after inactivity; a webhook arriving while asleep may be delayed or lost (accepted temporary limitation; upgrade remains recommended). Open security items unchanged: `supabase_admin` default ACLs, anonymous-access attribution (logs), admin review, token/hash exposure assessment, credential rotation decision, log retention.

## Rollback readiness
Code: Office back to `a0bd54e9…` (hard-OFF), Backend back to `3a9956dc…`, via a new non-force commit/revert or Render rollback; never to a pre-hard-OFF build. Data: leave the new tables in place (additive, empty of customer content beyond provider ids); do not restore anon/authenticated grants.
