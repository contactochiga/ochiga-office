# Unified CRM Relationship Workspace — test report

Executed 2026-10-15 on branch `feature/unified-crm-relationship-workspace`. Only results actually obtained are listed.

## Standard gates (all PASS)
`npm run check` (111 JS files), `lint`, `build` (18 assets), `security:secrets`, `deployment:validate`, `office:whatsapp-autonomy:test` (control + store/UI), `office:relationship-workspace:test`.

## Full Office suite (file store)
All 44 `scripts/test-*.js` pass (42 existing + 2 new), 0 failures. Hard-OFF/autonomy behaviour unchanged (the autonomy suite passes with the workspace code in place).

## Hardened-database run (real Supabase Postgres 17 + PostgREST, P0 migration applied, service_role only)
The differential harness from the security branch was run with the two autonomy migrations applied: 16/16 anonymous attacks refused after the migration, `service_role` reads all 56 tables; the Office suite via `SupabaseLeadAgentsStore` gives **34/42 scripts passing identically before and after the migration, 2,716 service-role requests, 42 tables touched, 0 requests refused**. Both new workspace test scripts are in the passing set in both phases, which validates the new Supabase queries (`in.(...)` lead filters, `status:` event lookups, latest-conversation helper) against real PostgREST. The 8 scripts that fail in both phases are the known file-store-only scripts, plus `test-whatsapp-autonomy-control.js` (inspects file-store internals, passes on the file store). The harness files were used from the security branch and were not added to this branch.

## Requested tests 1–17
| # | Requirement | Evidence |
|---|---|---|
| 1 | Lead opens workspace | API test + browser: `#/crm/leads/:id` renders 3 columns with the WhatsApp message |
| 2 | Contact history | API: contact scope returns only explicitly linked leads; unrelated contact → none; browser: contact route opens workspace |
| 3 | Organization permissions | API: org scope; role without `crm.read` → 403 on inbox, thread and scoped views; browser: org route opens workspace |
| 4 | Opportunity filtering | API + browser: technology opportunity shows only its evidence; development opportunity does not show it |
| 5 | Website forms render | API entry kind `form_submission` with actual submitted text; browser: form card shows submitted values |
| 6 | WhatsApp chronological | API: ordering asserted; deterministic tie-break in read model |
| 7 | Source icons real metadata | unit + API + browser: WhatsApp/website glyphs from stored source; unknown/other stays neutral; linkedin only if stored; source and channel separate |
| 8 | Duplicate provider events | API: Meta retry of the same provider id → one entry; activity+conversation twin merged to one (synthetic); identical text hours apart not merged |
| 9 | Undelivered replies not shown as sent | API: refused reply leaves no outbound entry; accepted reply shows `unverified` until a `status:delivered` event, then `delivered/verified`; browser shows "delivery not confirmed" |
| 10 | Staff Messages isolated | API: a real staff conversation + message created; its text never appears in inbox or any thread |
| 11 | Attachments need authorization | API: documents listed only with `documents.generate`; file_url/html_url/share_token never in any response; opened via `documents/:id` |
| 12 | Global WhatsApp OFF | API: `global_autonomous_responses: off`, mode `autonomous_off`, zero outbound sends, suppression fact shown inline once; browser shows OFF status |
| 13 | Human takeover | API + browser: takeover enables composer, mode `human`; release available |
| 14 | Manual reply permissions | API: staff role → 403 and `available:false`; no takeover → 409; super admin with takeover → sent; audit event recorded; duplicate `client_request_id` → 409, sent once |
| 15 | Multiple opportunities | API + browser: one contact/lead, two opportunities stay separate; `unlinked_count` reported |
| 16 | Historical navigation | Browser: `#/crm/leads` classic list and `#/crm/leads/:id/record` classic detail still render; existing CRM tests pass |
| 17 | Mobile | Browser (390×800 emulation): thread view, list hidden, Back control, no horizontal overflow; plus pagination test (120 messages, cursor pages without overlap) and thread search |

Browser test = headless Google Chrome over DevTools against the real server with fixture data only; no uncaught page errors asserted. Screenshots: `docs/assets/crm-workspace-desktop-whatsapp.png`, `…-desktop-form-opportunities.png`, `…-mobile-thread.png`.

## Defects found by testing and fixed
Duplicate entries from `appendConversation`'s timeline mirror; inbound text absent from `conversations` while autonomy is OFF (inbox preview/thread now fall back to the CRM activity); identical source/channel chips; unnamed WhatsApp leads showed "Unnamed lead"; composer clipped by viewport height; CSS block initially inserted before the Messages rules so its height rule lost; reply textarea collapsed.

## Not tested / limitations
Real Meta delivery receipts and live media; inbound email, LinkedIn, Facebook, Instagram (not connected); behaviour with thousands of leads (inbox sorts in memory); `authenticated`-role Supabase paths (none used); cross-browser beyond Chrome; the production deployment (not authorised).


---
# Hardening revision test results (2026-10-15)

## Gates — all PASS
`check` (113 JS files), `lint`, `build` (18 assets), `security:secrets`, `deployment:validate`, `office:whatsapp-autonomy:test` (control + store/UI), `office:relationship-workspace:test` (read-model API test + durability suite + headless-Chrome test). **Full Office suite: 45/45 scripts pass, 0 failures.**

## Targeted durability tests (`scripts/test-whatsapp-manual-send-durability.js`) — controlled adapter, no real customers
| Req | Scenario | Result |
|---|---|---|
| A | Duplicate request in one process | 409 `duplicate_request` with recorded state; provider called once |
| B | Duplicate after restart (new server + new store handle on the same data) | 409; no new provider call |
| C | 8 concurrent duplicates across 2 instances with a slow provider | exactly 1 winner, 7×409, **1 provider attempt** |
| D | Same id, altered content | 409 `request_id_reused`, no send |
| E | Provider accepted, persistence succeeds | ledger `provider_accepted`, conversation recorded once, thread shows one entry, delivery `unverified` (not delivered) |
| F | Accepted, conversation write fails | response `recorded:false`, ledger accepted/unrecorded, audit records it, shown once from the ledger, repaired exactly once by a healthy instance, no re-send |
| F2 | Accepted, outcome write fails | `state_recorded:false`, provider message id preserved in audit, row handled as unknown |
| G | Provider rejects (4xx) | 502, `provider_rejected`, shown as "not sent", same id never re-sent |
| H | Timeout and 5xx | 202 `outcome_unknown`; retry of same id answered from the record, **no second send** |
| I | Reconciliation | stale pending → unknown; staff resolution needs `manage_takeover` (403 otherwise), is audited, cannot be flipped, never sends; resolved-sent merges into one thread entry |
| J | No duplicate send during reconciliation | 4 parallel reconcile/thread reads on 2 instances: provider call count unchanged |
| DB | Ledger unavailable | 503 `send_state_unavailable`, provider never called |
| N | No takeover | 409 and no intent recorded |
| O/P | Global autonomy OFF (default, setting never written) | authorised manual send succeeds; autonomy setting row remains absent |
| Q | Unauthorised / unauthenticated / forged actor | 403 / 401 / 400; actor recorded is always the session |
Correlation (K, L, M) in `scripts/test-relationship-workspace.js`: exact provider id merges with provenance kept; one provider event stored twice → one entry; two identical customer messages with different provider ids stay distinct; similar text/time without evidence → two entries flagged `uncertain`; opposite directions never merge. R (staff Messages isolated) and S (opportunity associations) are asserted by the existing workspace tests and still pass.

## Hardened-database run (real Supabase Postgres 17 + PostgREST; P0 migration applied; all 16 anonymous attacks refused; service_role reads all 57 tables)
Office suite through `SupabaseLeadAgentsStore`: **35/43 scripts pass identically before and after the P0 migration, 3,244 service-role requests, 43 tables touched, 0 refused.** The durability suite is in the passing set, so concurrency, restart and instance sharing were validated against the real database with separate client instances (genuine unique-key arbitration), not only the file store. The 8 scripts failing in both phases are the known file-store-only scripts (incl. `test-whatsapp-autonomy-control.js`, which inspects file-store internals and passes on the file store).
Migration test on an already-hardened database (fresh Supabase Postgres, schema + all dated migrations + P0 hardening, then `20261017_whatsapp_manual_sends.sql` applied twice as `postgres`): table owner `postgres`, RLS on, `anon`/`authenticated` no privileges, `service_role` SELECT/INSERT/UPDATE/DELETE, 3 indexes created, 0 public tables without RLS, `anon` schema USAGE still denied, idempotent re-run.

## Browser verification (headless Chrome, fixtures only)
Desktop three-column layout; composer fully inside the viewport with a usable textarea; source/channel chips from stored metadata; manual reply shown as "Accepted by provider — delivery not confirmed"; pending ("Sending — not yet confirmed by WhatsApp"), unknown ("Outcome unknown … Do not resend") and rejected ("Not sent — WhatsApp refused it") indicators; staff resolution of an unknown send updates the ledger without sending; the accepted reply appears exactly once; two opportunities stay separate; contact/organization/opportunity routes open the workspace; classic record and list still work; mobile 390×800 shows the thread, Back returns to the inbox, no horizontal overflow; no uncaught page errors. New screenshot: `docs/assets/crm-workspace-desktop-unknown-outcome.png`.

## Limitations of the test evidence
No real Meta traffic (controlled adapter); real Meta timeouts/5xx behaviour is modelled, not observed; Render multi-instance behaviour is represented by two server instances sharing one database; production not touched.
