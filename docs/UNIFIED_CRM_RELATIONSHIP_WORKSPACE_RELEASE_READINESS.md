# Unified CRM Relationship Workspace — release readiness

## 1. Executive summary
The approved three-column workspace is unchanged. Three engineering gaps were closed: (1) manual WhatsApp replies are now idempotent through a durable, atomic database ledger instead of an in-memory map; (2) every manual send has a persisted intent and an honest lifecycle (pending / provider accepted / rejected / not sent / outcome unknown), with local reconciliation and an audited staff resolution for unknown outcomes — no automatic retransmission anywhere; (3) timeline deduplication now merges only on authoritative shared identifiers and keeps look-alike records separate (flagged uncertain). The permanent WhatsApp autonomy switch, its policy and Meta/Backend contracts are untouched (zero diff in `whatsapp-autonomy.js`); no deployment, migration or production mutation was performed.

## 2. Branch and commit
Branch `feature/unified-crm-relationship-workspace` — https://github.com/contactochiga/ochiga-office/tree/feature/unified-crm-relationship-workspace. Code commit: `bf33a5fb28404c26b0c053e71f8ce1c81929054b` (the final branch HEAD adds only this readiness document on top; the exact HEAD SHA is in the hand-off message). Production `codex/office-extraction` = `c91d51776e44b5885490ea6984f16b6913031adb` (unchanged); the feature branch is a clean fast-forward descendant of it.

## 3. Changed-file inventory (versus production, 20 files)
New: `db/20261017_whatsapp_manual_sends.sql`, `db/rollback/20261017_whatsapp_manual_sends.down.sql`, `src/lead-agents/manual-whatsapp-send.js`, `src/lead-agents/relationship-workspace.js`, `scripts/test-whatsapp-manual-send-durability.js`, `scripts/test-relationship-workspace.js`, `scripts/test-relationship-workspace-browser.js`, 4 screenshots in `docs/assets/`, 3 workspace docs (+ this one).
Modified: `src/lead-agents/server.js` (read routes, reply handler, resolve route, `provider_message_id` on two inbound activity writes), `store-file.js`, `store-supabase.js` (ledger methods, `correlation_id`, read helpers), `public/office/office.js`, `public/office/index.html`, `package.json` (test script). Not touched: autonomy policy/settings, Backend, Meta config, Supabase security.

## 4–8. Design (details in the Architecture document)
Idempotency: unique (lead, staff actor, client request id), atomic claim, content hash binding, fail-closed. Lifecycle: pending → accepted | rejected | not_sent | unknown; delivered/read only from provider status events (`verified`). Unknown outcomes: never retried; stale pending becomes unknown after 2 minutes; resolved only by audited `confirmed_sent`/`confirmed_not_sent`. Reconciliation: local repair only (idempotent conversation record via unique `correlation_id`), runs when a thread is read; no provider call. Correlation: shared provider id / correlation id / communication id / source-event id, same direction; otherwise separate and flagged.

## 9. Security and permissions
Manual send needs an authenticated session, `manage_takeover`, an active human takeover, a WhatsApp number and configured adapter; sender is always the session (a body naming another actor → 400). Global autonomy is displayed, not consulted for manual sends, never written. Resolution needs `manage_takeover` and is audited with the operator. No credentials exposed; no file URLs; staff Messages isolated; RLS/anon restrictions unchanged.

## 10. Database migration requirements
One additive migration, **not applied anywhere except disposable databases**: `db/20261017_whatsapp_manual_sends.sql` — table `whatsapp_manual_sends` (RLS on, no policies), 2 indexes, `conversations.correlation_id` + unique partial index. Verified on a hardened replica (applied twice as `postgres`): RLS on, anon/authenticated no access, service_role CRUD, 0 public tables without RLS. Apply it with the same `set role postgres` pattern used for the autonomy migrations so ownership and default privileges are correct. Rollback script included (use only while the table is empty).

## 11. Test results
All gates pass (check, lint, build, security:secrets, deployment:validate); both requested npm suites pass; **full Office suite 45/45**; durability scenarios A–J, DB-down, N, O, P, Q pass; correlation K–M pass; R/S/T pass; hardened-database differential run 35/43 identical before/after with 0 refused requests and the durability suite included (real PostgREST concurrency across separate clients). Details: Test Report.

## 12. Browser verification
Headless Chrome desktop and mobile: layout, composer visibility, source/channel chips, manual-reply state, pending/unknown/rejected indicators, accepted-vs-delivered wording, no duplicate bubble, opportunity filtering, document navigation, classic fallback — all verified (screenshots in docs/assets).

## 13. Remaining limitations
* No real Meta traffic was used; unknown-outcome handling is modelled with controlled adapters.
* Autonomous Oyi replies and bridge sends are performed by Backend and are not stored in Office tables, so they do not appear in the thread (needs a Backend→Office record contract; documented, not invented). WhatsApp media ingestion, inbound email and LinkedIn/Facebook/Instagram messaging remain not connected.
* An unknown outcome cannot be auto-resolved without provider evidence; staff must check WhatsApp. If the provider message id is unknown, delivery status cannot be matched.
* Reconciliation runs when a thread is read (no background worker); a send nobody opens stays pending/unknown until then.
* The file store is single-process by design; multi-instance guarantees rely on Supabase (production driver).
* Render Free plan sleep/restart risk is unchanged (accepted earlier); the durable ledger is what makes restarts safe for sends.

## 14. Deployment order (each step needs explicit approval; autonomy stays OFF)
1. Take a fresh logical backup of `conversations` and the schema (the earlier backup predates the P0 and autonomy migrations).
2. Apply `db/20261017_whatsapp_manual_sends.sql` to production as `postgres`; verify table, RLS, privileges, `correlation_id` column and index; confirm counts unchanged and anon access still denied.
3. Fast-forward `codex/office-extraction` to the feature HEAD (Render auto-deploys). Migration first: code deployed without the table would fail closed (503, no send), never unsafe.
4. Verify: `/healthz` 200; served `office.js` hash matches the branch; autonomy setting still absent/OFF; WhatsApp inbound still reaches the CRM; one controlled manual reply to an approved test number (accepted, recorded once, duplicate id refused); the unknown-outcome path is covered by tests, not exercised live.
## 15. Rollback
Code: fast-forward is reversible by pushing a revert/the previous SHA `c91d51776e44b5885490ea6984f16b6913031adb` (or Render rollback); the old build ignores the new table/column. Data: leave `whatsapp_manual_sends` and `conversations.correlation_id` in place (additive; they are the record of what customers were sent); the down script is only for an empty table. Never restore anon/authenticated grants; never revert to a pre-hard-OFF Office build.

## 16. Production readiness decision
**READY FOR CONTROLLED DEPLOYMENT** — conditional on explicit approval of the migration and the branch update, a fresh backup, and the post-deployment checks above.
