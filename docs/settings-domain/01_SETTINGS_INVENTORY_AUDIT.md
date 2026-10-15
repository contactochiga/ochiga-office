# Ochiga Office — Settings Domain Audit, Part 1: Evidence and Inventory

Status: audit only. No runtime code changed, nothing merged or deployed.
Audited: 2026-10-15. Office `codex/office-extraction` @ `35d3fe5`; Backend `main` @ `03e5090`; IQ-11F gateway (`oyi-intelligence-quality`, `codex/intelligence-quality-v1`); Facility `feature/facility-luna-twin-integration`; Consumer `codex/oyi-consumer-reference-slice3`.

Method: routes, permission keys, config and UI were read from source. A control is counted as **functional** only when a UI control, a server route, persistence and an audit record all exist. Anything else is labelled read-only, incomplete or absent.

Not verified (called out so the matrices are not over-read): Consumer in-app settings screens were not enumerated; there is no standalone Edge Agent repository on this machine, so Edge facts come only from Backend (`src/middleware/edgeToken.ts`, `edgeIdentityPolicy.ts`, env vars); Render/Supabase/Meta dashboards were not opened.

## 1. What exists today (ground truth)

### 1.1 Office Settings page (`renderSettingsView`, `public/office/office.js:10019`)
Nav entry `settings`, gated `settings.manage` (ADMIN_NAV, line 626). It shows exactly four things:

| Block | Gate in UI | Server contract | Real? |
|---|---|---|---|
| Integration status grid | none beyond page | `GET /admin/integrations` (`integrations.read`) | Read-only probes (Backend health, Website, Facility, Consumer, Twin, App Store readiness). Derived from env, never editable. |
| WhatsApp autonomy panel | `integrations.read` to see | `GET/PUT /admin/settings/whatsapp-autonomy` (`integrations.read` / `integrations.manage`) | **Functional.** Persisted in `runtime_settings`, audited, server-authoritative. |
| Sync buttons (facility/consumer/all) | `office.manage` | `POST /admin/office/sync` | Action, not a setting. |
| Corporate Letterhead form | `settings.manage` | `GET/PATCH /admin/letterhead-config` | **Functional**, audited (`office_letterhead_config_updated`); 503 when schema missing. |
| "Not yet owned by Office" note | — | — | States honestly that company profile, notification prefs, CRM defaults and session/security policy have no contract. |

Finding F-1: the page's own text confirms the owner's premise — it is an integration status page with two real controls.

### 1.2 Server-side configuration (all environment-only, none editable in-app)
`src/lead-agents/config.js` reads ~120 env vars. Groups: auth/session (`LEAD_AGENTS_SESSION_*`, login rate limit), storage (`OFFICE_STORAGE_*`, Supabase), Backend bridge (`OFFICE_BACKEND_*`, `OFFICE_EXPORT_API_KEY`, `OFFICE_SYNC_API_KEY`), Facility/Consumer/Twin bridges, WhatsApp (`WHATSAPP_*`, `META_*`), email (`RESEND_API_KEY`, `OFFICE_EMAIL_*`), OpenAI (`OPENAI_*`), maps (`GOOGLE_MAPS_API_KEY`, `MAPBOX_*`), social/ads (Facebook, Instagram, LinkedIn, Google Ads/Analytics), webhooks (founder/sales/demo), App Store Connect, public widget limits, CORS origins, communication outbox (`config.communicationOutbox`).
Only **two** values are runtime-editable today, both in `runtime_settings` (migration `20261014_office_runtime_settings.sql`, RLS on, service-role only): `whatsapp_autonomous_responses_enabled` (editable) and `whatsapp_webhook_signature_stats` (system-written counters).

### 1.3 Other admin surfaces that are de facto settings
| Surface | Route(s) | Gate | State |
|---|---|---|---|
| Team / users | `GET/POST /admin/users`, `PATCH/DELETE /admin/users/:id`, invite, QR, `/admin/staff/capability-catalog`, `/admin/staff/:id` | `staff.manage` view, `team.manage` write (super_admin only) | Functional |
| Roles & permissions | `GET /admin/permissions` | `staff.manage` | **Read-only** catalogue of `ROLE_PERMISSIONS`; roles are code constants. Per-user `permission_scopes` is the only additive mechanism. |
| Audit | `GET /admin/audit` (last 200) | `audit.read` | Read-only; no filter/export/retention server-side |
| Traces / Intelligence | `/admin/traces`, `/admin/intelligence/*`, `/admin/ai/operations` | `audit.read` / `view_traces` | Read-only visibility (Backend-owned data) |
| Automations | `/admin/automations*` | CRM/ops perms | Functional; Backend `officeExport` owns storage |
| Notifications | `/admin/notifications*` | `notifications.*` | Inbox only; **no preference/subscription settings** |
| Documents | letterhead, folders, templates, storage-summary | `settings.manage`/`documents.manage` | Letterhead functional |
| Storage | `POST /admin/storage`, `/admin/storage/:id` | `storage.write` | Upload tool, driver is env-only |
| Maps | `GET /admin/maps/config`, `POST /admin/maps/geocode` | `estates.read`/`estates.write` | Config read-only; geocode is an action |
| Communications outbox | `/admin/communications/outbox*` | `integrations.manage` | Functional, no UI yet (API/console only) |
| Visibility repair | `/admin/whatsapp/inbound-visibility/repair` | `integrations.manage` | Functional, no UI (console only) |
| Founder alert | `POST /admin/notify-founder` | `escalate_founder` | Action |
| Session self-service | login/logout/me/password/photo/profile/reset | self | Functional (profile, password, photo) |

### 1.4 Backend (Ochiga-backend)
- No `settings`/`feature_flag`/`platform_settings` table or route exists. Backend configuration is **env-only** (245 env vars). `src/config/env.ts` validates only email/MQTT/Redis/Tuya.
- Office-facing contract is `routes/officeExport.ts` guarded by `requireOfficeExportKey` (shared API key). It exposes read models, automations/workflows CRUD, provisioning, `communications/webhook-event` (supports `replay:true`), intelligence read models. There is **no** settings write API for any Backend domain.
- AI provider config is env-only and OpenAI-shaped: `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_VISION_MODEL`, `OPENAI_TRANSCRIPTION_MODEL`, `OPENAI_SPEECH_MODEL`, `OPENAI_TTS_*` (`src/utils/ai.ts`, `communicationsMediaAdapters.ts`). `LANGUAGE_TEACHER_OPENAI_ENABLED` plus `language-teacher/providerRegistry.ts` is the only provider registry in runtime. Anthropic/Gemini appear nowhere in Backend runtime.
- Communications provider env: `TWILIO_*`, `SMS_PROVIDER_API_KEY`, `VOICE_PROVIDER_API_KEY`, `RESEND_API_KEY`, `EMAIL_DELIVERY_PROVIDER`, `MAIL_ENABLED`, push `APNS_*`, `FCM_SERVER_KEY`.
- IoT/Tuya: `TUYA_*`; `POST /integrations/tuya/sync` (`devices.read`); registry doc `docs/TUYA_REGISTRY_SYNC.md`.
- Edge: tokens/identities `OYI_EDGE_AGENT_TOKEN(S)`, `OYI_EDGE_AGENT_IDENTITIES`, `OYI_EDGE_ALLOW_LEGACY_TOKEN`; intervals `EDGE_*_INTERVAL_MS`; `requireEdgeToken` audits failures. Identities are env/config, not a managed registry.
- Backend roles/permissions: separate permission keys (`superAdmin.ts` uses `office.read`, `estates.write`, `staff.manage`, `audit.read`). Backend has its own audit log (`audit-logs`).

### 1.5 IQ-11F provider-neutral gateway (`oyi-intelligence-quality`)
Document: `docs/INTELLIGENCE_QUALITY_V1_IQ11F_PROVIDER_NEUTRAL_GATEWAY.md`, code `scripts/iq11f-gateway/`.
- **Offline only.** `AdapterRegistry` registers reviewed adapters (OpenAI Responses, Anthropic Messages, Gemini generateContent) behind one interface (`id, version, mode, protocol, describe(), normalize()`); `describe()` is always `sendable:false`; no SDK, no network transport.
- Authorized spend USD 0; no model selected for Claude/Gemini; the Gemini profile is explicitly "unqualified"; cross-provider fallback is disabled by default; approvals file `artifacts/...iq11f-gateway-approvals.json` has every field null.
- It is **not in Backend runtime** and not a settings store. Its registry is ephemeral test state.
Consequence for Settings: Office can show provider entries and their *approval/qualification state* but must not offer an "activate" action. Activation is a Backend/Core decision outside this domain.

### 1.6 Facility and Consumer
- Facility (`facility-oyi`, route `facility-administration`) has nine tabs: Profile, Operators, Roles, Permissions, Audit, Automation, Integrations, Notifications, Security. Profile edits go through `settings.manage`. Security tab is an informational table (JWT, role, audit visibility); notification category preferences exist (security, visitors, maintenance, services, wallet, proximity, devices, automation, community, intelligence). This is the **owner of estate-level settings**.
- Consumer: resident-facing; settings are personal (profile, notifications, home members). Not enumerated in this audit; treat as out of Office scope.
- Device execution and physical verification are Facility/Consumer/Edge-owned (Backend device routes, `devices.control`). Office has no device write path and must not gain one.

## 2. Existing-settings inventory (Office-visible)

Legend — State: F functional, R read-only, I incomplete, A absent. Scope: G global, U per-user, T per-tenant/estate.

| # | Setting | UI location | Backend owner | Read/Write contract | Persistence | Permission | Scope/default | Validation / secrets | State | How to verify | Home |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | WhatsApp autonomous responses | Settings → WhatsApp panel | Office server (decision enforced by Backend replay/pipeline + Office policy) | GET/PUT `/admin/settings/whatsapp-autonomy` | `runtime_settings.whatsapp_autonomous_responses_enabled` | read `integrations.read`, write `integrations.manage` | G, default **false** | boolean only; fail-closed; audited success+failure | **F** | Toggle, reload, confirm audit row, send inbound and see no autonomous reply | Office (authority stays in Backend decision model) |
| 2 | WhatsApp webhook signature mode | none | Office env | env `WHATSAPP_WEBHOOK_SIGNATURE_MODE` (anything other than `report` enforces); stats via `/healthz` | env + `runtime_settings` stats | none in UI | G, **enforce** | secret `META_APP_SECRET` env | R (health only) | unsigned POST→401, bad sig→403 | Office (env; display only) |
| 3 | Integration status | Settings grid | Office | GET `/admin/integrations` | derived | `integrations.read` | G | probes carry keys server-side only | R | compare to real service up/down | Office |
| 4 | Letterhead (logo, tagline, email, website, phone, address, social) | Settings form | Office | GET/PATCH `/admin/letterhead-config` | `letterhead_config` | `settings.manage` | G, defaults in code | strings trimmed; **no URL/email validation** | F (I: validation) | create doc, check header; existing docs unchanged | Office |
| 5 | Team members, roles, status, invite | Team | Office | `/admin/users*` | `admin_users` | `staff.manage`/`team.manage` | G | password hashing; roles from catalogue | F | create/invite/disable and log in | Office |
| 6 | Permission scopes per user | Team detail | Office | `PATCH /admin/users/:id` | `admin_users.permission_scopes` | `team.manage` | U | known keys only | F | grant key, user sees nav item | Office |
| 7 | Role→permission map | Team (view) | Office code | GET `/admin/permissions` | `permissions.js` constants | `staff.manage` | G | — | **R** (code only) | n/a | Office |
| 8 | Own profile / password / photo | Account menu | Office | `/admin/session/*` | `admin_users` | self (`auth.change_password`) | U | password rules (verify in Phase 2) | F | change and re-login | Office |
| 9 | Session TTL, cookie name, login rate limit | none | Office env | env | env | — | G | secret `LEAD_AGENTS_SESSION_SECRET` | R (env) | n/a | Office |
| 10 | Storage driver / bucket | none (upload tool only) | Office env | env `OFFICE_STORAGE_*` | env | `storage.write` for upload | G | service keys env | R | upload and read file | Office |
| 11 | Maps provider | none (config GET) | Office env | GET `/admin/maps/config` | env | `estates.read` | G | `GOOGLE_MAPS_API_KEY` server only; only public token exposed | R | geocode estate | Office |
| 12 | Backend bridge URL/keys | none | Office env | env `OFFICE_BACKEND_*` | env | — | G | **secret** | R (status via #3) | health probe | Office env (rotation via Render) |
| 13 | Facility/Consumer/Twin bridge | none | Office env | env | env | — | G | **secret** | R | probe #3 | Office env |
| 14 | OpenAI (Office assistant) | none | Office env | `OPENAI_*` | env | — | G | **secret** | R | Office chat works | Office env, but see §3 AI |
| 15 | Email provider | none | Office env | `RESEND_API_KEY`, `OFFICE_EMAIL_*` | env | — | G | **secret** | R | invite email delivered | Office env |
| 16 | Social/Ads/Analytics connectors | none | Office env | env | env | — | G | **secrets/tokens** | R, undisplayed | — | Office env |
| 17 | Founder/sales/demo webhooks | none | Office env | env | env | `escalate_founder` for action | G | webhook secrets | R | notify-founder test | Office env |
| 18 | Communication outbox (retry policy, dead letters) | none (API only) | Office | `/admin/communications/outbox*` | `communication_delivery_outbox`; policy in `config.communicationOutbox` | `integrations.manage` | G | bounded numerics | F (API) / A (UI) | reconcile dry-run, diagnostics | Office |
| 19 | Inbound visibility repair | none (console) | Office | `/admin/whatsapp/inbound-visibility/repair` | `whatsapp_inbound_claims` | `integrations.manage` | G | dry-run default | F (API) / A (UI) | dry-run counts | Office |
| 20 | Notifications | bell/inbox | Office | `/admin/notifications*` | `notifications` | `notifications.read` | U | — | F inbox / **A preferences** | — | Office |
| 21 | CRM assignment defaults, stages, lead source | none | Office | none | none | — | G | — | **A** | — | Office |
| 22 | Company/business profile | none | — | none | none | — | G | — | **A** (letterhead partially covers) | — | Office |
| 23 | Audit retention/export | Audit view | Office | GET only | `audit_events` | `audit.read` | G | — | R | — | Office |
| 24 | Automations enable/disable | Tasks → Automations | Backend (officeExport) | CRUD + test | Backend DB | CRM/ops perms | G | server validated | F | run test endpoint | Backend (Office is client) |
| 25 | Intelligence visibility | Intelligence | Backend | GET read models | Backend | `audit.read` | G | safe-field only | R by design | — | Backend |
| 26 | AI provider entries (OpenAI/Gemini/Claude) | none | Backend/Core + IQ-11F | none | env (OpenAI only), IQ-11F artifacts (offline) | — | G | **secret**; approvals null | **A** | — | **Not Office** (Office shows status only) |
| 27 | Tuya / IoT sync | Facility | Backend | `POST /integrations/tuya/sync` | Backend | `devices.read` | T | `TUYA_*` secrets | F (Backend) | device list refresh | Facility/Backend |
| 28 | Edge agent identities & intervals | none | Backend | env | env | — | T | tokens secret | R (env) | heartbeat appears | Edge/Backend |
| 29 | Twilio voice/SMS | none | Backend | env | env | — | G | `TWILIO_AUTH_TOKEN` secret | R | call test | Backend |
| 30 | Estate profile, facility notifications | Facility Administration | Facility+Backend | Facility routes | Backend | `settings.manage` (Facility role) | T | — | F (Facility) | — | Facility |
| 31 | Supabase / RLS / hosting plan | none | Platform | dashboards | — | — | — | — | out of band | RLS-off count = 0 | Platform ops |
| 32 | MFA, password policy, IP allow-list, session revoke | none | — | none | none | — | G/U | — | **A** | — | Office (future) |

## 3. System-wide integration inventory

| Integration | Owner of truth | Credential location | Office visibility today | Notes |
|---|---|---|---|---|
| Ochiga Backend (Oyi Core) | Backend | Office env `OFFICE_BACKEND_API_KEY`; Backend `OFFICE_EXPORT_API_KEY` | health probe | Shared key both sides; rotation needs paired change |
| Supabase (Office) | Office | service-role key in Render env | `store_driver` in `/healthz` | RLS everywhere; no UI |
| Supabase (Backend) | Backend | Backend env | none | |
| Meta WhatsApp Cloud | Office intake, Backend decisions | `WHATSAPP_ACCESS_TOKEN`, `META_APP_SECRET`, verify token | autonomy toggle only | Mode `enforce` |
| Resend (email) | Office / Backend | env | none | |
| OpenAI | Office env and Backend env (**two separate keys**) | env | none | Duplicated config, no shared registry |
| Anthropic / Gemini | none live | none | none | IQ-11F offline only |
| Google Maps / Mapbox | Office | env | read-only config | |
| Facebook / Instagram / LinkedIn / Google Ads & Analytics | Office | env tokens | none | Present in config, no UI |
| App Store Connect | Office | env | readiness in grid | |
| Sanity (website CMS) | Office | env | none | Development/Content publishing |
| Facility app | Facility + Backend | bridge keys | probe | |
| Consumer app | Consumer + Backend | bridge keys | probe | |
| Digital Twin | Twin / Backend | `OFFICE_DIGITAL_TWIN_*` | probe | |
| Tuya | Backend | `TUYA_*` | none in Office | |
| Twilio | Backend | `TWILIO_*` | none | |
| Edge Agents / MQTT / Redis | Backend / Edge | tokens, `MQTT_*`, `REDIS_URL` | none | |
| Push (APNs/FCM) | Backend | env | none | |
| Render | Platform | dashboard | uptime in `/healthz` | Free plan sleeps; Render API token unauthorized for tooling |
| Paystack | Backend | env | none | Finance |

## 4. Existing versus missing (summary)

| Domain | Functional | Read-only | Incomplete | Absent |
|---|---|---|---|---|
| Organization / branding | letterhead | — | letterhead validation | company profile, legal entity, timezone, locale, currency |
| People & access | users, invites, scopes, own profile | role map | session policy | MFA, password policy, session revoke, IP rules, custom roles |
| Intelligence | — | visibility pages | — | provider registry UI, model selection, budgets, approvals display |
| Integrations | WhatsApp autonomy | status grid, env connectors | — | per-provider cards, test-connection, secret rotation workflow |
| Automation | automations CRUD | — | — | global kill-switch, run limits |
| Communications | autonomy, outbox (API) | signature mode | outbox/repair UI | templates, quiet hours, channel routing, reply SLAs |
| Buildings & IoT | (Facility owns) | — | — | Office settings (intentionally none; show Facility status) |
| CRM | — | — | — | stages, assignment rules, lead sources, SLAs, duplicate policy |
| Finance | — | — | — | (Backend financial summary read-only) invoicing defaults, tax, currency |
| Security | RLS enforced | — | — | security overview, secrets inventory, rotation log |
| Infrastructure | — | health | — | status page, deploy info, worker/queue health in UI |
| Audit | read | 200 events | — | filter by date/actor server-side, export, retention |
| System health | `/healthz` | — | — | in-app health dashboard |
