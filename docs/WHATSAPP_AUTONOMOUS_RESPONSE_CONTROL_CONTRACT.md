# WhatsApp autonomous response control — contract and audit (frozen before implementation)

Branch `codex/whatsapp-autonomy-control` (from `codex/wave10-office-core-planstudio` @ `b071f23`). Not merged, not deployed, autonomous replies not enabled.

## 1. Audit — every WhatsApp send path and takeover behaviour today
Office (`src/lead-agents`), the only holder of WhatsApp credentials:
| # | route | caller | autonomous? | current takeover check |
|---|---|---|---|---|
| A | `processWhatsAppEvent` → `adapter.sendTextMessage` (server.js ~1909) | Meta inbound webhook; reply text from Oyi Core | **yes** | `ai_paused` / `human_status ∈ {human_active, human_review}` — but see defect D1 |
| B | `POST /api/lead-agents/admin/communications/whatsapp/send` (server.js ~2556–2660) | Backend `CommunicationRuntime` `WhatsAppAdapter` via shared key (`x-office-api-key`) | **mixed** — carries Goal runtime, scheduled automation actions, and staff-confirmed Oma conversation sends; the payload has **no origin field** | `lead_id` takeover check only |
| C | `…/whatsapp/templates` | same bridge | read-only | n/a |
No other sender of `sendTextMessage` / `sendTemplateMessage` exists in Office. There is **no staff-session manual WhatsApp send route** in Office today; the only manual path is route B when Backend executes a staff-confirmed Oma action.

Backend (`Ochiga-backend`, audit only): `WhatsAppAdapter.send` posts to route B for every WhatsApp record. Origins in `CommunicationRecord.source`: `conversation` (Oma/Oyi chat; sends only after staff confirmation), `automation` (GoalRuntime `goalEvaluator` — `source_record_type: "goal"`, and `communicationActionBatchExecutionService` — `source_record_type: "automation"`; both `pre_authorized`), `task`, `workflow`.

Defects found:
- **D1** `processWhatsAppEvent` upserts `human_status: "auto"` on every inbound message, then reads the returned (already reset) state — an active human takeover is cleared by the customer's next message.
- **D2** no inbound de-duplication: a Meta webhook retry with the same message id would be processed (and answered) twice.
- **D3** route B cannot distinguish an autonomous send from a staff-confirmed one.

## 2. Setting
Key `whatsapp_autonomous_responses_enabled`, boolean, **default false**. Stored in table `office_runtime_settings(key text pk, value jsonb, updated_by text, updated_at timestamptz)` (migration `db/20261014_office_runtime_settings.sql`), and in the file store under `state.runtime_settings`. A missing row means false. A read error (network, schema, malformed value) is **not** false-by-default but "unknown", which every enforcement point treats as OFF (fail closed) and reports as `setting_unreadable`.
Changes: `PUT /api/lead-agents/admin/settings/whatsapp-autonomy` (session auth, permission `integrations.manage` — admin roles only), body `{enabled: boolean}`; audited through the existing audit log (`whatsapp_autonomy_setting_changed`: actor, timestamp, old, new). `GET` (permission `integrations.read`) returns `{enabled, effective, source, updated_by, updated_at, official_number (display only)}`.

## 3. Enforcement
Single decision function `evaluateAutonomousWhatsAppPolicy(store)` reading the store at call time (no cache, no process variable). Used:
1. Route A: once before generating a reply (skip the Oyi Core call when OFF) and **again immediately before** `sendTextMessage` (a toggle during generation cannot leak).
2. Route B: unless the request declares `send_origin: "staff_confirmed"`, the send is autonomous and is blocked when OFF or unreadable (`failure_reason: "autonomous_whatsapp_disabled"` / `"autonomy_setting_unreadable"`). A missing `send_origin` is treated as autonomous (fail closed). Backend contract change (minimal, separate branch): `WhatsAppAdapter.send` adds `send_origin = record.source === "conversation" ? "staff_confirmed" : "autonomous"`.
3. New governed manual path: `POST /api/lead-agents/admin/leads/:id/whatsapp/reply` (session auth, permission `crm.manage`, requires an active human takeover on that lead, audited). Independent of the switch.
OFF: inbound messages are still verified, stored, forwarded to Backend, create/update the lead, channel state and CRM activity; nothing is sent autonomously; suppressed replies are not generated and **never replayed** when switched ON (no queue exists). ON: eligible replies resume; `ai_paused` and human takeover still override; inbound de-duplication by message id prevents duplicate replies.
D1 fix: the inbound upsert no longer writes `human_status`; the stored status is preserved (new rows take the database default `auto`). D2 fix: duplicate inbound message ids are acknowledged without a second reply.

## 4. UI
Office → Settings → Integrations → WhatsApp: ON/OFF control, display-only official number (from configuration, not editable), effective status text, last changed by/at, explicit saving/success/failure feedback; the control renders only the value returned by the server and a failed save reverts and shows the error. Disabled for users without `integrations.manage`.

## 5. Out of scope / unchanged
Meta credentials, phone-number id, webhook subscription, deployment configuration, signature verification, templates endpoint behaviour.
