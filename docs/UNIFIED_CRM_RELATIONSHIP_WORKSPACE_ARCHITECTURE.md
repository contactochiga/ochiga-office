# Unified CRM Relationship Workspace — architecture

Branch `feature/unified-crm-relationship-workspace`, based on production `codex/office-extraction` @ `c91d51776e44b5885490ea6984f16b6913031adb` (permanent WhatsApp autonomy switch included). Not deployed.

## Principles
No new CRM, no new intelligence system, no new Meta sender. The workspace is a **read model** over records Office already owns, plus the existing governed manual-reply endpoint. Customer communications (`conversations`, `crm_activities`, `timeline_events`, WhatsApp status events, `office_documents`) are kept apart from staff-to-staff Messages (`staff_conversations`, `staff_messages`), which are never read.

## Components reused
`renderMessagesRoute` layout and CSS tokens (`.messages-page`, panes, bubbles, composer, avatars); CRM router (`renderCrmRoute`/`renderCrmDetail`), CRM tabs, list views, filters; `renderLeadDetail` (still reachable at `#/crm/leads/:id/record`); `promptAddNote`; existing APIs `GET /leads/:id/timeline`-class stores, `PATCH /leads/:id/channel-state/whatsapp` (takeover), `POST /admin/leads/:id/whatsapp/reply` (governed manual reply, `manage_takeover`, active takeover required, audited); autonomy status (`readWhatsAppAutonomySetting`/`describeWhatsAppAutonomyStatus`).

## Data contracts (no schema change, no migration)
| Source | Table | Used for |
|---|---|---|
| Public/agent/staff WhatsApp messages | `conversations` (role, channel, external_message_id, agent_name) | message entries; agent_name containing "@" = human staff reply |
| Inbound text when no conversation row exists (autonomy OFF) and form submissions | `crm_activities` (`whatsapp_message`, `website_intake_received`, notes; carries contact/organization/opportunity/lead ids) | message / form / activity entries |
| Lead timeline | `timeline_events` | system entries (lead created, takeover, etc.); mirror/technical events (`conversation`, `tool_event`, `lead_updated`, `oyi_core_whatsapp_turn`) are excluded; suppression fact shown inline once |
| Provider delivery truth | `inbound_events` where `event_type like 'status:%'` keyed by provider message id | outbound delivery state |
| Takeover | `lead_channel_states` | mode, owner, unread |
| Documents | `office_documents` (`related_type` lead/opportunity) | attachment entries (id/title/type/status only) |
| Opportunities | `crm_opportunities` | profile + explicit linking |

## Read model (`src/lead-agents/relationship-workspace.js`)
`buildThread` produces entries `{id, kind(message|form_submission|activity|system|attachment), direction, channel, sender, sender_type, origin(customer|ai|human|system|unknown), text, occurred_at, delivery{state,verified}, provider_message_id, opportunity_id, attachments, provenance{table,id}, merged_from}`.
* Ordering: `(occurred_at, kind rank, id)` — deterministic; stable ids `kind:table:uuid`.
* Dedup: a WhatsApp `crm_activities` row and a `conversations` row for the same message (same lead, same normalised text, ≤120 s apart, same direction) become ONE entry with `merged_from`; identical text hours apart is not merged. Meta retries are already prevented upstream by `whatsapp_inbound_claims` (tested: one entry).
* Delivery truth: outbound = `unverified` until a provider `status:` event for that message id exists (`sent`/`delivered`/`read`/`failed`); an Oyi draft or a refused reply is never shown as sent; a manual reply is recorded only when the provider accepted it.
* Opportunity association: only explicit (`opportunity_id` on the activity/document). Opportunity view shows linked entries only and reports `unlinked_count`; nothing is auto-assigned to every opportunity.
* Pagination: cursor `base64url(occurred_at|id)`, newest page first, `next_before`; inbox uses `limit/offset`. Per-lead sources are capped at 500 rows per call.
* Source vs channel: `leadSourceInfo` returns `original_source` and `delivery_channel` separately; a provider glyph exists only when the stored value maps to one (`whatsapp`, `linkedin`, `facebook`, `instagram`, `email`, Ochiga/Oyi website, widget); everything else is neutral `unknown/other`.
* Scopes (`leadIdsForScope`): contact, organization, opportunity map to leads through explicit ids or identical normalised e-mail/phone only — never fuzzy names.

## API contracts (new, read-only, permission `crm.read`)
`GET /api/lead-agents/admin/crm/relationships?q&filter=all|unread|mine&contact_id|organization_id|opportunity_id&limit&offset` → `{relationships[], total, has_more}` (name, preview, last activity, original source, channel, stage, qualification, owner, human owner/status, opportunity count, unread).
`GET /api/lead-agents/admin/crm/relationships/:leadId?before&limit&opportunity_id&q` → `{lead, source, thread{entries,total,has_more,next_before,unlinked_count}, opportunities, channel_state, communication{global_autonomous_responses,takeover_active,mode,whatsapp_reply{available,can_reply_permission,takeover_required}}, integrations}`. Documents only if the caller has `documents.generate`; never file URLs/share tokens (staff open them through the authenticated Documents workspace).
Narrow change to an existing endpoint: `POST /admin/leads/:id/whatsapp/reply` now (a) accepts `client_request_id` and refuses the same id twice within 5 minutes (409), and (b) writes the accepted message to `conversations` so it appears in the thread.
New store read helpers (file + Supabase): `listLatestConversationsForLeads`, `listLeadChannelStatesForLeads`, `listInboundStatusEventsByExternalIds`.

## UI structure (`public/office/office.js`, `index.html` CSS)
`renderRelationshipWorkspace` → left inbox (search, All/Awaiting reply/Mine, rows with source glyph, preview, stage, qualification, opportunity count, Human chip, unread dot, Load more), centre thread (header with source/channel chips, opportunity chips, day separators, bubbles, form cards, document cards, system notes, Load earlier, composer/lock + Take over / Release), right profile (Identity, Source, CRM, Opportunities, Communication, Operations, Files, Oyi, Channel connections, Add note, Open full record). Routes: `#/crm/leads/:id`, `contacts/:id`, `organizations/:id`, `opportunities/:id` open the workspace; `#/crm/leads/:id/record` keeps the classic record; list views unchanged. Responsive: ≤1100px profile becomes a toggled overlay, ≤860px single column with Back.

## Security
RLS/anon restrictions untouched; browser calls only authorized Office APIs; service role stays server-side; permission gate `crm.read` (403 for roles without it incl. scoped views); manual reply keeps `manage_takeover` + takeover + audit; no public file URLs; staff Messages isolated (tested); no new tables/policies.

## Channel support matrix
| Channel | Source identification | Messages in thread | Reply from workspace |
|---|---|---|---|
| WhatsApp | yes | yes (conversations + activities) | yes, governed (takeover + permission) |
| Ochiga website form | yes | yes (form card from intake activity) | no |
| Website widget / chat | yes | yes (conversations) | no |
| Email | label only if stored | **no inbound sync** (explicit "not connected") | no |
| LinkedIn / Facebook / Instagram | label only if stored | **not connected** | no |

## Known integration gaps
Original raw form payload is not stored separately (the intake activity summary and lead fields are shown); WhatsApp media download/storage not verified (explicit note in UI); no Oyi qualification evidence API in the workspace (shows the lead summary; full record has the rest — Backend contract needed if richer facts are wanted); linking an existing message to an opportunity needs a small write API (not built); automated multi-opportunity creation not implemented; inbox sorts in memory over `listLeads()` (fine at current scale, needs a server-side query beyond a few thousand leads); thread caps at 500 rows per source.
