# Unified CRM Relationship Workspace — implementation summary

Branch: `feature/unified-crm-relationship-workspace` (base: production `c91d51776e44b5885490ea6984f16b6913031adb`). Production not touched; nothing merged or deployed. Design source: the owner's approved image `Ochiga CRM Lead Workspace.png` (three columns: Leads inbox / conversation with Website-form, WhatsApp, routing, note and file entries / Lead Details). Implemented with Office's own dark theme tokens so it looks native.

## Phases
* **A Audit** — reviewed `renderMessagesRoute`, list/thread/bubble/composer/details renderers, `renderLeadDetail`, intake (`office-intake.js`), stores, WhatsApp webhook paths, manual-reply endpoint, takeover (`lead_channel_states`), documents, permissions. Findings that shaped the design: with autonomy OFF the inbound text is stored in `crm_activities`/`inbound_events` only (no `conversations` row); `appendConversation` mirrors each message into `timeline_events` (would duplicate); the manual-reply endpoint did not record the sent message anywhere readable; status events carry no lead id (matched by provider message id).
* **B Read model** — `src/lead-agents/relationship-workspace.js`, two read endpoints, three store read helpers (file + Supabase).
* **C UI** — three-column workspace in `public/office/office.js` + CSS in `index.html`.
* **D Sources/forms** — provider glyphs only from stored values; website form submissions render as conversation cards with the actual submitted summary.
* **E Opportunities/documents** — explicit-link opportunity filter; documents as cards opened via Documents (no public URLs).
* **F Takeover/manual reply** — mode line (global autonomy + human/Oyi), Take over / Release takeover, governed reply composer, duplicate guard, honest delivery text.
* **G Responsive** — ≤1100 px profile overlay, ≤860 px single column with Back.
* **H Tests** — see test report.

## Behaviours worth knowing
* Opening a **lead** opens its workspace; opening a **contact/organization/opportunity** opens a workspace over the leads explicitly linked to it (opportunity opens with its filter active); if nothing is linked it falls back to the classic record. `#/crm/leads/:id/record` keeps the classic record; list views, filters, search and pipeline are untouched.
* Reply composer is enabled only when: lead has a WhatsApp number, caller holds `manage_takeover`, a human takeover is active, WhatsApp is configured. Otherwise a reason is shown (and a Take over button for permitted users). Global autonomy is displayed, never changed here.
* A sent reply is shown as "Accepted by provider — delivery not confirmed" until a real `status:` event arrives, then Delivered/Read/Failed. A refused or failed send leaves no message in the thread.
* Not implemented (stated, not faked): inbound email sync, LinkedIn/Facebook/Instagram messaging, WhatsApp media ingestion, message-to-opportunity linking UI, automatic opportunity creation, Oyi qualification evidence beyond the lead summary.

## Files
`src/lead-agents/relationship-workspace.js` (new), `server.js` (2 read routes + manual-reply guard/record), `store-file.js`, `store-supabase.js` (3 helpers), `public/office/office.js`, `public/office/index.html`, `scripts/test-relationship-workspace.js`, `scripts/test-relationship-workspace-browser.js`, `package.json` (`office:relationship-workspace:test`), docs + 3 screenshots in `docs/assets/`.


---
# Hardening revision (release readiness)
Three narrow engineering changes, no redesign:
1. **Durable manual-reply idempotency** — new additive table `whatsapp_manual_sends` (+ `conversations.correlation_id`), atomic claim per (lead, staff actor, client request id), exact-content binding, forged-actor refusal, fail-closed when the ledger is unreachable. The in-memory map was removed.
2. **Provider acceptance lifecycle and reconciliation** — `src/lead-agents/manual-whatsapp-send.js`: intent persisted before the provider call; pending / accepted / rejected / not-sent / unknown states; outcome update retried then surfaced; accepted-but-unrecorded repaired idempotently (no provider call); unknown outcomes never retried, only resolved by a governed, audited staff decision (`…/manual-sends/:id/resolve`). UI: honest wording, muted style for unconfirmed entries, two small buttons only on unresolved sends.
3. **Evidence-safe correlation** — `relationship-workspace.js` merges only on shared provider message id / correlation id / communication id / source-event id (same direction); look-alike records without evidence stay separate and are flagged uncertain; future inbound activities carry `provider_message_id`.
Unchanged: workspace design, autonomy switch and policy (`whatsapp-autonomy.js` has zero diff versus production; the setting is never read-modified), Backend contracts, Meta configuration.

New/changed files in this revision: `db/20261017_whatsapp_manual_sends.sql`, `db/rollback/20261017_whatsapp_manual_sends.down.sql`, `src/lead-agents/manual-whatsapp-send.js`, `relationship-workspace.js`, `server.js` (reply handler, resolve route, thread reconcile, `provider_message_id` in two activity writes), `store-file.js`, `store-supabase.js`, `public/office/office.js`, `public/office/index.html`, `scripts/test-whatsapp-manual-send-durability.js`, `scripts/test-relationship-workspace*.js`, `package.json`.
