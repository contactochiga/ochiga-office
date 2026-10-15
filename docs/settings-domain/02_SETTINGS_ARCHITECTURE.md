# Settings Domain Audit, Part 2: Architecture

Builds on Part 1 evidence. Design principle: **Settings is a governed control plane that edits only what Office owns, and shows (never fabricates) what other systems own.**

## 1. Recommended information architecture

Route `#/settings` becomes a hub with a left sub-navigation (desktop) / section list (mobile). Existing `#/settings` URL and the `settings.manage` nav gate are preserved; sub-routes are `#/settings/<section>`.

| Section | Contents | Phase-1 reality |
|---|---|---|
| Overview | health roll-up, attention items, recent setting changes | new, read-only |
| Organization | company profile, branding/letterhead, locale/timezone/currency | letterhead exists; rest absent |
| People & Access | Team link, roles catalogue, permission scopes, session policy, MFA | team exists elsewhere; link, don't move |
| Intelligence | Oyi status, AI provider registry (OpenAI/Gemini/Claude), model/approval status, budgets | read-only status; no activation |
| Integrations | provider cards: Backend, Supabase, WhatsApp, Email, Maps, Social, App Store, Facility, Consumer, Twin | status exists; cards new |
| Communications | WhatsApp autonomy (existing), webhook signature, delivery outbox, visibility repair, templates | autonomy + outbox + repair exist as API |
| Automation | automation kill-switch, run limits, link to Automations | mostly absent |
| Buildings & IoT | Facility/Consumer/Edge/Tuya status, estate sync, **no device control** | read-only, links to Facility |
| CRM | stages, lead sources, assignment rules, duplicate policy | absent |
| Finance | currency, tax, invoice defaults | absent; Backend owns ledger |
| Security | secrets inventory (names/age, never values), RLS status, signature mode, rotation log | new, read-only |
| Infrastructure | Render/Supabase/queue/worker health, deploy version | read-only |
| Audit | filtered/exportable settings-change history | extends existing Audit |
| System Health | `/healthz`, outbox depth, dead letters, last sync | read-only |

Navigation rules: keep one Settings entry in ADMIN_NAV; sections the viewer cannot access are hidden, not disabled; deep links to hidden sections show the permission-denied state.

## 2. Ownership and permissions matrix

Principle: a setting lives where its enforcement lives. Office hosts a UI for Office-owned settings, and a *read-only mirror with deep link* for settings owned elsewhere.

| Domain | Owner (writes) | Office role | Read perm | Write perm | Notes |
|---|---|---|---|---|---|
| Letterhead/branding | Office | editor | `office.read` | `settings.manage` | |
| Company profile | Office | editor | `office.read` | `settings.manage` | new |
| Team/users/roles | Office | editor (`team.manage` super_admin only) | `staff.manage` | `team.manage` | role map stays code |
| Session/MFA/password policy | Office | editor | `settings.manage` | `settings.manage` + super_admin recommended | new, Phase later |
| WhatsApp autonomy | Office (authority enforced in Backend decision model) | editor | `integrations.read` | `integrations.manage` | **unchanged contract** |
| Webhook signature mode | Render env | mirror | `integrations.read` | none in UI | change only via deploy; UI shows state |
| Outbox/repair | Office | operator | `integrations.manage` | `integrations.manage` | admin-only already |
| Integration credentials | Render/Supabase env | mirror (names, presence, age) | `integrations.read` | **none** | secrets never writable in-browser (§4) |
| AI provider registry | Backend/Core + IQ-11F approvals | mirror | `audit.read` | none | activation requires separate IQ approval |
| Automations | Backend | client | existing | existing | |
| CRM defaults | Office | editor | `crm.read` | `crm.manage` | new |
| Buildings/IoT/devices | Facility/Consumer/Edge/Backend | mirror | `estates.read` | **none** | no device writes from Office |
| Finance | Backend | mirror | `financial.read` | none | |
| Audit | Office | viewer | `audit.read` | none (append-only) | |
| Infrastructure | Platform | mirror | `settings.manage` | none | |

Existing gap to fix: Settings page is gated `settings.manage` but its integration grid and autonomy panel call `integrations.read`, which `ochiga_staff` also holds. Phase 2 should make each section declare its own gate and the page gate become "any section visible".

## 3. Reusable component and Backend contract design

Components (vanilla JS in `public/office/office.js`, styled with existing tokens; no new framework):

- `settingsShell(sections)` — sub-nav, active state, mobile collapse.
- `settingSection({title, description, status, actions})`.
- `settingForm({fields, load, save, validate})` — dirty tracking, inline validation, Save/Discard, optimistic UI **off** (always show server-confirmed value, as the autonomy panel already does).
- `providerCard({key, name, state, lastChecked, owner, actions})` — state from a closed vocabulary (below).
- `statusIndicator(state)` — `connected | degraded | unreachable | not_configured | disabled | pending_approval | unqualified`.
- `secretField` — write-only/never-readable; shows `●●●● last updated <date> by <actor>`; no reveal control.
- `confirmDialog({title, impact, typeToConfirm?})` — required for autonomy ON, secret rotation, disable integration, role changes.
- `permissionGate(perm, child, fallback)` — hides or shows read-only fallback.
- `errorPanel`/`emptyState`/`skeletonPanel` — reuse existing helpers.
- `auditTrail(resource)` — last N changes for a setting.

Backend (Office) contract — one governed registry instead of ad-hoc routes:

```
GET  /api/lead-agents/admin/settings                      -> sections + per-setting descriptors (key, type, scope, owner, editable, state)
GET  /api/lead-agents/admin/settings/:key                 -> value (never secrets), metadata, last_changed_by/at, version
PUT  /api/lead-agents/admin/settings/:key                 -> { value, expected_version } ; 409 on stale
GET  /api/lead-agents/admin/settings/:key/history
GET  /api/lead-agents/admin/settings/integrations         -> provider cards (status only)
POST /api/lead-agents/admin/settings/integrations/:key/test -> bounded, read-only connectivity test
```
- Descriptors are code-defined (`settings-registry.js`): key, type, validator, default, scope, `read_permission`, `write_permission`, `owner`, `sensitive`, `requires_confirmation`, `audit_action`. Unknown keys rejected.
- Persistence: reuse `runtime_settings` (key/value/updated_by/updated_at) plus a `version` column and a `runtime_setting_history` table (append-only). Existing keys (`whatsapp_autonomous_responses_enabled`) keep their current routes as aliases — no behaviour change.
- Optimistic concurrency via `expected_version`. Writes return the *stored* value.
- Existing dedicated routes (autonomy, letterhead) remain the source of truth; the registry delegates to them, so there is no second path that could bypass their rules.

## 4. Security, audit and secret management

1. **Secrets stay in the environment.** Office must not accept API keys through the browser in Phase 1–3. The UI shows presence, last-rotated date (from a non-secret metadata record), and a documented rotation runbook (e.g. `docs/ROTATION_CHECKLIST.md`). If in-app rotation is later wanted, it requires an encrypted secret store (KMS/pgsodium), a write-only endpoint, and a fresh threat review — separate approval.
2. Responses never include secret values, partial values or hashes; sensitive descriptors serialize as `{configured:true, updated_at}`.
3. Every write: `appendAuditRecord` with action `settings.<key>.changed`, old/new (non-sensitive), actor, request id, status success/failure; failure also audited (pattern from autonomy route).
4. Fail closed: if persistence fails, return 503 and change nothing; UI shows stored value.
5. Dangerous toggles (autonomy ON, enforce→report, integration disable) require confirmation dialog plus server-side `confirm:true`, and are rate-limited.
6. Step-up: super_admin re-auth (password) for session policy and secret-adjacent actions.
7. Test endpoints are read-only probes, time-bounded, never send customer-facing messages or call paid inference.
8. Settings never relax RLS, signature enforcement or autonomy default: those invariants are asserted in tests and displayed on Security.
9. Audit view gains server-side filters (action prefix, actor, date) and CSV export gated `audit.read`; retention is policy text until a purge job is separately approved.

## 5. AI provider design (reuses IQ-11F, activates nothing)

- Provider entries OpenAI, Gemini (Google), Claude (Anthropic) render as `providerCard`s sourced from the **IQ-11F approvals/registry metadata** (id, adapter version, mode `offline_mock_only`, model: unselected, approval: pending, spend authorized: USD 0, data-processing review: pending).
- State vocabulary for these cards: `unqualified`, `pending_approval`, `shadow_approved` (future), `live` (future). Phase 1–3 can only display `unqualified/pending_approval`.
- No key field, no model dropdown that writes, no "Enable" button. A disabled "Request qualification" control can link to the IQ-11 approval runbook.
- Today's only live inference config is Backend/Office OpenAI env vars; the card for OpenAI reports "Env-configured (legacy path)" and never implies IQ-11F qualification.
- Provider-neutral registry remains Backend/Core-owned; Office reads a future `GET /office/intelligence/providers` (to be added in Backend under separate approval) instead of duplicating the registry.

## 6. IoT / Facility / Consumer / Edge

Office Buildings & IoT section is a mirror: counts, last sync, edge heartbeat freshness, Tuya sync status, deep links into Facility Administration. Device commands, scene execution, camera control and physical verification stay in Facility/Consumer/Edge and Backend `devices.control`. No Office route may call a device-control endpoint; add a test asserting that.

## 7. WhatsApp

Preserve `/admin/settings/whatsapp-autonomy` and its Backend-authority semantics. The Communications section adds: signature mode and counters (read-only), outbox depth/dead letters, repair dry-run results, display number, autonomy toggle (existing panel moved, not rewritten). Retry/replay can never enable autonomy (invariant from the outbox work); the Settings UI must not offer a path that changes this.

## 8. Navigation and responsive UX specification

- Desktop ≥1100px: existing 232px nav; Settings shows a second 220px sub-nav column, content max 880px.
- Tablet 860–1100px: sub-nav collapses to a horizontal scroll tab strip.
- Mobile <860px: single column; section list is the landing screen, each section a pushed view with back (pattern already used by Relationship Workspace thread view); sticky Save bar; touch targets ≥44px; no horizontal page scroll.
- States for every section: loading skeleton, empty, error with retry, permission-denied ("You don't have access to <section>"), stale-version conflict, save success inline.
- Keyboard: tab order follows visual order, focus ring uses `--red-bright`, dialogs trap focus, Esc closes, live region announces save results.
- Reduced motion honoured (existing `prefers-reduced-motion` rule).

## 9. Test and verification strategy (per setting)

Each registry entry ships with: unit test of validator/defaults; permission matrix test (every role × read/write); audit-record test; persistence round-trip on file store and real Supabase harness; and a behavioural test proving the change has its intended effect (e.g. autonomy off → no auto-reply, letterhead → new doc header). Real-environment verification steps are listed per row of the inventory ("How to verify").
