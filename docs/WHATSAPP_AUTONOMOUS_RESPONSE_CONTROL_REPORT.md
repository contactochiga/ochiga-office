# WhatsApp autonomous response control — implementation report

> **Superseded in part (production reconciliation):** duplicate protection no longer uses the guarded unique index `inbound_events_message_once`. Production `inbound_events` contains historical duplicate provider ids, so the guarded index would have been skipped. The final mechanism is the additive claims table `whatsapp_inbound_claims` (`db/20261015_whatsapp_inbound_claims.sql`); see `docs/WHATSAPP_AUTONOMY_PRODUCTION_RECONCILIATION.md`.


Branches (local, not pushed, not merged, not deployed; autonomous replies not enabled):
- `ochiga-office` `codex/whatsapp-autonomy-control` — contract `e44274b`, implementation `b8a11ee` (base `b071f23`).
- `Ochiga-backend` `codex/whatsapp-send-origin-contract` — `ef69ce6` (base `17e876d`): 6-line contract change, see "Backend dependency".

## What changed
- **Setting** `whatsapp_autonomous_responses_enabled`: table `office_runtime_settings` (migration `db/20261014_office_runtime_settings.sql`, also appended to `db/lead-agents-schema.sql`), file-store equivalent. Default OFF (no row). Reads are strict: a read error, missing table or non-boolean value is "unknown", treated as OFF everywhere. New module `src/lead-agents/whatsapp-autonomy.js`.
- **Enforcement** (read at call time, no cache): (1) Office inbound reply path — checked before generating a reply and again immediately before sending (together with a fresh takeover read); (2) Backend bridge `POST …/communications/whatsapp/send` — any request not declared `send_origin: "staff_confirmed"` is autonomous and refused when OFF/unreadable (`autonomous_whatsapp_disabled` / `autonomy_setting_unreadable`), including template sends; blocked sends are audited. No other autonomous sender exists in Office.
- **OFF behaviour:** webhook still verified/stored, lead + channel state + CRM activity (`ai_replied:false`) + timeline note created, event still forwarded to Backend; no reply is generated and none is queued, so nothing can replay when switched ON.
- **Manual path:** new `POST /api/lead-agents/admin/leads/:id/whatsapp/reply` (permission `crm.manage`, requires an active takeover, audited with operator); staff-confirmed bridge sends are unaffected by the switch.
- **Defects fixed:** inbound messages no longer reset `human_status` to `auto` (active human takeover survives); duplicate inbound message ids (Meta retries, concurrent deliveries) are acknowledged without a second reply.
- **API/UI:** `GET/PUT /api/lead-agents/admin/settings/whatsapp-autonomy` (read `integrations.read`, write `integrations.manage`; every change audited as `whatsapp_autonomy_setting_changed` with actor, time, old and new value; failed saves audited and return 503). Settings → Integrations → WhatsApp panel: ON/OFF toggle (admins only), display-only official number (new optional env `WHATSAPP_DISPLAY_NUMBER`; shows "not shown" if unset), effective status text, last changed by/at, saving/success/failure feedback; it always renders the value returned by the server, and a failed save leaves the display unchanged and says "Not saved".

## Evidence (requirement → test)
`npm run office:whatsapp-autonomy:test` (`scripts/test-whatsapp-autonomy-control.js`, real HTTP server + real file store + stubbed Meta adapter and stubbed Backend; `scripts/test-whatsapp-autonomy-store-ui.js`):
1 default OFF, lead/CRM kept, no outbound, no draft · 2/3 OFF blocks Office reply and autonomous/unlabelled/template bridge sends · 4 OFF allows staff-confirmed bridge send and the manual route (409 without takeover) · 5 ON permits replies, nothing replayed on switch-on · 6 per-lead `ai_paused` overrides ON · 7 takeover survives a new inbound message (a mutation check re-adding the old reset makes this test fail) · 8 survives restart (new store instance on the same file) · 9 eight concurrent inbound messages do not bypass OFF; switching OFF during generation blocks the send · 10 unreadable/malformed/missing-table setting fails closed; a failed save returns 503 and changes nothing · 11 duplicate delivery gets no second reply, no replay on ON · 12 audit records operator, old/new value, failures · plus non-admin cannot change the switch (403) and PostgREST store semantics (strict reads, upsert on key, string `"true"` does not enable).
Regression: `npm run check|lint|build|security:secrets|deployment:validate` pass; all 26 wired `office:*:test` scripts and the 8 unwired test scripts (communications convergence slices 1–4, recipient resolution, JV golden journey, handoff schema) pass. Backend: new `scripts/whatsapp-send-origin-smoke.mjs` passes; runtime, convergence slice 1/2 and automation-action smokes pass; `communications-office-auth-compat-smoke` hangs identically on `main` (pre-existing, unrelated).

## Backend dependency (required before relying on manual Oma sends)
`WhatsAppAdapter.send` now posts `send_origin = "staff_confirmed"` for conversation-sourced records (reached only after staff confirmation) and `"autonomous"` for goal/automation/task/workflow records. Until Backend with this change is deployed, Office treats every bridge send as autonomous: with the switch OFF, staff-confirmed Oma WhatsApp sends would also be blocked (safe default, but not what you want long term). Deploy Backend first or together.

## Limits and decisions to confirm
- Not exercised against a live Supabase or a browser: the production store is tested with a recording fake client; the UI with static source checks (repo has no DOM test tooling). Do a manual pass of the Settings panel after deploy.
- **Apply the migration before deploy.** If the table is absent the switch reads as unknown (OFF) and saving returns 503.
- **Behaviour change on deploy:** replies stop (default OFF) until an administrator enables the switch.
- With OFF, Oyi Core is not asked to draft a reply (chosen so Oyi's own thread never contains answers the customer did not receive). The inbound event is still forwarded to Backend. If you want Oyi to keep "thinking" while OFF, that is a one-line policy change.
- Old value in the audit is read-then-write (not a single atomic statement); concurrent admin changes could record a slightly stale old value, never a wrong current value.
- A retried delivery whose first attempt failed after the inbound event was stored is not re-answered (no replay by design).
- The manual-reply route has no staff UI composer yet; staff replying from WhatsApp itself is unaffected.
- Meta credentials, phone-number id, webhook subscription and deployment config are untouched.
