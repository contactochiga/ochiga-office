# Ochiga / Oyi Tier 1 Production Foundation

Date: 2026-05-16

This document records the Tier 1 foundation layer added inside the current `oyi-edge-agent` repository without moving files into a monorepo and without changing the Vercel/Render deployment shape.

## Scope

Tier 1 covers shared infrastructure foundations only:

- Unified Auth
- Unified Permissions
- Unified Contracts
- Realtime Infrastructure
- Production Storage
- Audit/Event System

Tier 2 work is intentionally excluded: billing, invoice expansion, CRM expansion, advanced AI planner, and live digital twin bindings beyond foundation events.

## Files Inspected

Core backend and routing:

- `src/lead-agents/server.js`
- `src/lead-agents/auth.js`
- `src/lead-agents/config.js`
- `src/lead-agents/http.js`
- `src/lead-agents/rate-limit.js`
- `lead-agents-server.js`
- `agent.js`

Storage and persistence:

- `src/lead-agents/store-file.js`
- `src/lead-agents/store-supabase.js`
- `src/lead-agents/store-factory.js`
- `db/lead-agents-schema.sql`
- `data/lead-agents-store.json`
- `data/plan-studio-store.json`
- `data/lead-memory.json`

Office/system sync and app surfaces:

- `src/lead-agents/office-sync.js`
- `src/lead-agents/office-data.js`
- `src/lead-agents/digital-twin.js`
- `src/lead-agents/plan-studio.js`
- `public/dashboard/index.html`
- `public/dashboard/dashboard.js`
- `public/widget/index.html`
- `public/widget/oma-widget.js`
- `public/digital-twin/app.js`
- `public/plan-studio/app.js`

Auth, communication, events, and integrations:

- `src/lead-agents/email.js`
- `src/lead-agents/whatsapp.js`
- `src/lead-agents/webhooks.js`
- `src/lead-agents/runtime.js`
- `src/lead-agents/tools.js`
- `src/lead-agents/openai.js`
- `src/lead-agents/tracing.js`
- `src/lead-agents/lead-memory.js`

Tests and operations:

- `scripts/test-lead-agents.js`
- `scripts/apply-supabase-schema.js`
- `scripts/run-lead-agents-evals.js`
- `package.json`
- `render.yaml`
- `vercel.json`

## Changes Made

### Unified Auth

Existing Office auth was already implemented through signed HTTP-only session cookies, admin users, staff invites, password reset tokens, fallback API-key access, and password hashing.

This pass keeps those flows intact and connects auth to the shared permissions module.

Current auth flows identified:

- Office login: `POST /api/lead-agents/admin/session/login`
- Office logout: `POST /api/lead-agents/admin/session/logout`
- Session lookup: `GET /api/lead-agents/admin/session/me`
- Password change: `POST /api/lead-agents/admin/session/password`
- Staff invite accept: `POST /api/lead-agents/admin/session/invite/accept`
- Password reset request/confirm: admin reset routes under `/api/lead-agents/admin/session/reset/*` and `/api/lead-agents/admin/users/:id/reset`
- Staff account creation: `POST /api/lead-agents/admin/users`
- API key auth: `LEAD_AGENTS_API_KEYS` with `LEAD_AGENTS_AUTH_MODE`
- Public widget auth: currently unauthenticated public lead/agent intake
- Plan Studio and Digital Twin auth: currently mostly public/demo routes and marked for manual production review

### Unified Permissions

Added `src/lead-agents/permissions.js`.

The shared permission model supports both new dotted permissions and current legacy route permissions. This keeps old dashboard calls working while introducing production-ready permission keys.

Roles included:

- `super_admin`
- `ochiga_admin`
- `ochiga_staff`
- `estate_admin`
- `facility_manager`
- `security_operator`
- `maintenance_operator`
- `finance_operator`
- `resident`
- `guest`
- `ai_agent`

Legacy role aliases preserved:

- `admin` -> `super_admin`
- `founder` -> `super_admin`
- `operator` -> `ochiga_admin`
- `sales` -> `ochiga_staff`
- `viewer` -> `ochiga_staff`

Admin permission endpoint now exposes unified roles and canonical permission keys through `GET /api/lead-agents/admin/permissions`.

### Unified Contracts

Added `src/lead-agents/contracts.js`.

Reusable contract normalizers now exist for:

- users
- staff
- estates
- buildings
- homes
- devices
- cameras
- wallets
- support/maintenance tickets
- documents
- events
- audit logs

These are CommonJS contract helpers because the current project is CommonJS JavaScript, not TypeScript/Zod. They are intentionally simple and can later become TypeScript/Zod schemas when the wider platform is reorganized.

### Realtime Infrastructure

Added `src/lead-agents/realtime.js` and replaced the in-file ad hoc event bus with a shared realtime hub.

Realtime remains SSE-first because the project already used SSE and this avoids introducing WebSocket infrastructure before Tier 2.

Supported foundation event names include:

- `device.status.updated`
- `visitor.created`
- `support.ticket.created`
- `support.ticket.assigned`
- `wallet.funded`
- `estate.updated`
- `office.notification`
- `edge.heartbeat`
- `twin.state.updated`
- `audit.recorded`

Existing SSE endpoint remains:

- `GET /api/lead-agents/admin/events`

### Production Storage

Added `src/lead-agents/storage.js`.

Storage now goes through a shared abstraction instead of local ad hoc file writes in the server.

Supported purposes:

- `staff_photo`
- `resident_photo`
- `document`
- `generated_pdf`
- `plan_upload`
- `estate_image`
- `device_snapshot`
- `camera_snapshot`
- `digital_twin_file`

Existing storage route remains:

- `POST /api/lead-agents/admin/storage`
- `GET /api/lead-agents/admin/storage/:filename`

File metadata persistence added:

- File store: `office_files` collection
- Supabase: `office_files` table migration added

### Audit/Event System

Added `src/lead-agents/audit.js`.

Audit writes now normalize toward the Tier 1 audit shape while preserving existing store compatibility.

Audit metadata now captures:

- actor id
- actor email
- actor role
- action
- resource type
- resource id
- estate id when provided
- IP
- user agent
- status
- timestamp

Sensitive action coverage improved for:

- login/logout/password flows
- staff create/update/invite/photo/reset
- Office sync/import/geocode/storage/documents/assets
- Digital Twin device action
- Edge sync heartbeat
- Plan Studio upload
- Permission denied events

## New Modules / Files Created

- `src/lead-agents/permissions.js`
- `src/lead-agents/contracts.js`
- `src/lead-agents/realtime.js`
- `src/lead-agents/storage.js`
- `src/lead-agents/audit.js`
- `scripts/smoke-tier1-foundations.js`
- `docs/tier1-production-foundation.md`

## Existing Files Changed

- `src/lead-agents/auth.js`
- `src/lead-agents/config.js`
- `src/lead-agents/server.js`
- `src/lead-agents/store-file.js`
- `src/lead-agents/store-supabase.js`
- `db/lead-agents-schema.sql`
- `package.json`

## Environment Variables

Existing variables still apply. New/clarified Tier 1 variables:

- `OFFICE_STORAGE_DRIVER`: optional, defaults to `local`
- `OFFICE_STORAGE_DIR`: local file storage root, defaults to `data/office-storage`
- `LEAD_AGENTS_AUTH_MODE`: `off`, `optional_api_key`, or `required_api_key`
- `LEAD_AGENTS_API_KEYS`: comma-separated API keys for backend/admin automation
- `LEAD_AGENTS_SESSION_SECRET`: required for production-grade stable session signing
- `LEAD_AGENTS_SESSION_COOKIE_NAME`: optional cookie name override
- `LEAD_AGENTS_SESSION_TTL_MS`: optional session lifetime override

Recommended production setting:

- Set a strong `LEAD_AGENTS_SESSION_SECRET`; do not rely on default development fallback.

## Database Migrations Needed

Apply `db/lead-agents-schema.sql` to Supabase/production database.

New/updated database needs:

- `audit_events.resource_type`
- `audit_events.resource_id`
- `audit_events.estate_id`
- `audit_events.status`
- `audit_events.ip`
- `audit_events.user_agent`
- new `office_files` table

The Supabase storage metadata writer degrades safely if `office_files` is not present yet, but full production metadata requires applying the migration.

## Routes Still Needing Manual Review Before Full Production Lockdown

These routes are intentionally not aggressively locked down in this pass because doing so could break existing demo/deployed surfaces:

- `POST /api/digital-twin/device-action`
- `POST /api/digital-twin/edge-sync`
- Plan Studio write routes under `/api/plan-studio/*`
- Public widget `/api/lead-agents/public/chat`
- Public widget `/api/lead-agents/public/transcribe`
- WhatsApp webhook signature verification beyond verify-token handshake

Recommended next production review:

- Decide which routes require session auth, API-key auth, signed edge-agent token, or public rate-limited access.

## Verification

Commands run:

- `node --check` across `src` and `scripts`
- `npm test`
- `npm run lead-agents:test`
- `npm run tier1:smoke`

Result:

- All checks passed.

Note:

- The existing local process on port `8787` was an older running instance during verification, so its `/healthz` response did not show the new Tier 1 fields until restart/deploy.

## Tier 1 Production Foundation Status

Unified Auth: partial

- Existing Office auth is solid and now tied to shared permissions.
- Facility/Consumer resident auth is not in this repository yet, so it can only be prepared here, not fully completed.

Unified Permissions: partial

- Shared role/action permission model is implemented.
- Existing admin routes remain compatible.
- More route-level checks are still needed for public Digital Twin, Plan Studio, Edge, and external integration routes.

Unified Contracts: partial

- Shared JS contracts are implemented for core entities.
- Full completion needs adoption by Facility OS, Consumer OS, Edge Agent, Digital Twin, and Plan Studio callers.

Realtime Infrastructure: partial

- Shared SSE hub is implemented and wired to the existing Office event route.
- Full completion needs all upstream systems to publish standardized events into the hub.

Production Storage: partial

- Storage abstraction and metadata model are implemented.
- Full completion needs production object storage driver decision if local disk is not enough for Render/Vercel persistence.

Audit/Event System: partial

- Central audit normalizer is implemented and sensitive Office actions emit records.
- Full completion needs all public/system routes to be placed behind correct identity and audit envelopes.

Overall: Tier 1 foundation is now structurally in place, but not yet complete across the whole Ochiga/Oyi ecosystem because Facility OS, Consumer OS, and some public tool routes still need identity/token enforcement and standardized event publishing.

## Cross-System Unification Update

This pass extended the Tier 1 foundation beyond Office into the current backend, Facility frontend, and Consumer frontend without moving the projects into a monorepo.

Additional systems inspected:

- `/Users/ochigaidoko/Documents/Ochiga-backend`
- `/Users/ochigaidoko/Documents/facility-oyi`
- `/Users/ochigaidoko/Oyi-os-frontend`

Backend foundation additions:

- Added shared TypeScript foundation modules under `/Users/ochigaidoko/Documents/Ochiga-backend/src/core/foundation/`.
- Added unified permission roles, aliases, and dotted permission keys.
- Added reusable platform contracts for identity, estates, homes, devices, wallets, support tickets, and audit events.
- Added central audit event emitter that writes to `audit_events` when the table exists and fails safely when migrations are not applied yet.
- Connected JWT issue/hydration to `permission_scopes` and computed permissions.
- Added `requirePermission()` guards for sensitive estate, home, device, facility, and wallet routes.
- Expanded Office export payload with a shared contract version and broader users/rooms/visitors data.

Backend migrations added:

- `/Users/ochigaidoko/Documents/Ochiga-backend/migrations/2026-05-16-tier1-foundation-audit-events.sql`
- `/Users/ochigaidoko/Documents/Ochiga-backend/migrations/2026-05-16-tier1-foundation-permission-scopes.sql`

Facility frontend additions:

- Added `/Users/ochigaidoko/Documents/facility-oyi/lib/oyiFoundation.ts`.
- Updated Facility JWT decoding to derive permissions from token role/scopes.
- Added `X-Ochiga-Surface: facility` and `X-Oyi-Contract-Version` API headers.
- Fixed monetization usage state typing so Facility typecheck passes.

Consumer frontend additions:

- Added `/Users/ochigaidoko/Oyi-os-frontend/src/lib/oyiFoundation.ts`.
- Updated Consumer JWT decoding and session user shape to carry unified identity and permissions.
- Added `X-Ochiga-Surface: consumer` and `X-Oyi-Contract-Version` API headers.

Cross-system verification:

- Office/Edge Agent: `npm run tier1:smoke && npm test` passed.
- Backend: `npm run build` passed.
- Facility frontend: `npx tsc --noEmit --pretty false` passed.
- Consumer frontend: TypeScript still has pre-existing UI/mobile dependency/type errors unrelated to the Tier 1 identity changes. The new auth/session/foundation changes no longer show as blockers.

Cross-system Tier 1 status:

Unified Auth: partial

- Office auth, backend JWT auth, Facility token decoding, and Consumer token decoding now share the same identity/permission direction.
- Remaining work: enforce the same auth contract on every sensitive route and complete staff invite/photo/email flows across backend and UI.

Unified Permissions: partial

- Shared role and permission vocabulary now exists in Office, backend, Facility, and Consumer.
- Remaining work: apply `requirePermission()` to every sensitive route and hide/disable every protected UI action based on `hasPermission()`.

Unified Contracts: partial

- Office JS contracts and backend TypeScript contracts now exist.
- Remaining work: move more Facility/Consumer model calls onto the same contract version and add validation at API boundaries.

Realtime Infrastructure: partial

- Office SSE hub exists and backend already has Socket.IO/control-plane infrastructure.
- Remaining work: bridge backend socket/control-plane events into Office-compatible event names for estates, homes, devices, support, wallets, edge health, and future digital twin state.

Production Storage: partial

- Office storage abstraction exists.
- Backend already has S3 service support.
- Remaining work: standardize storage metadata across staff photos, resident photos, PDFs, plans, estate images, snapshots, and twin files.

Audit/Event System: partial

- Office audit exists and backend `audit_events` migration/emitter now exist.
- Remaining work: add audit emission to every sensitive backend mutation: estate create/update, home create/update, device register/command, visitor create/manage, wallet funding/debit, support assignment, document generation, plan upload, and edge heartbeat.

## Tier 1 Production Hardening Pass 2

Date: 2026-05-16

This pass closes the highest-risk gaps discovered after the first Tier 1 foundation pass. It does not start Tier 2 work, does not redesign UI, does not move to a monorepo, and does not change the Vercel/Render deployment shape.

### Route Protection Matrix

Office / Edge Agent (`/Users/ochigaidoko/oyi-edge-agent`):

| Surface | Route / Pattern | Classification | Status |
| --- | --- | --- | --- |
| Health | `GET /healthz` | public | unchanged |
| Widget shell | `/widget`, `/widget.js` | public | unchanged |
| Widget chat | `POST /api/lead-agents/public/chat` | public_rate_limited | unchanged, rate limited |
| Widget transcribe | `POST /api/lead-agents/public/transcribe` | public_rate_limited | unchanged, rate limited and size limited |
| Dashboard shell | `/dashboard`, `/dashboard.js`, logo asset | public shell | unchanged; API data remains protected |
| Admin session | login/logout/me/reset confirm/invite accept | public/session transition | unchanged, internally validated |
| Admin APIs | `/api/lead-agents/admin/*` | session_required or api_key_required | protected by `enforceAuth()` and route permissions |
| Office storage | `POST /api/lead-agents/admin/storage` | permission_required | `storage.write` |
| Office file read | `GET /api/lead-agents/admin/storage/:filename` | permission_required | `storage.read` |
| Office documents | `POST /api/lead-agents/admin/documents/generate` | permission_required | `documents.generate` |
| Digital Twin page/model/scene | `/digital-twin`, model assets, `GET /api/digital-twin/scene` | public/read-only | unchanged |
| Digital Twin action | `POST /api/digital-twin/device-action` | permission_required / edge_token_required | now requires `twin.control` through session/API key/edge token |
| Digital Twin edge sync | `POST /api/digital-twin/edge-sync` | edge_token_required or permission_required | now requires edge token/API key/session with `devices.control` |
| Plan Studio page | `/plan-studio`, `/plan-studio/app.js` | public shell | unchanged |
| Plan Studio reads | `GET /api/plan-studio/projects`, `GET /api/plan-studio/project` | public read | unchanged for compatibility |
| Plan Studio uploads | `POST /api/plan-studio/projects` | permission_required | now requires `planstudio.write` |
| Plan Studio analyze/parse/geometry/discipline | `POST /api/plan-studio/*` | permission_required | now requires `planstudio.write` |
| Plan Studio agent Q&A | `POST /api/plan-studio/agent` | permission_required | now requires `planstudio.read` |
| WhatsApp webhook | `/webhooks/whatsapp` | public_provider_webhook | unchanged, verify token still required for handshake |

Backend (`/Users/ochigaidoko/Documents/Ochiga-backend`):

| Surface | Route / Pattern | Classification | Status |
| --- | --- | --- | --- |
| Auth | `/auth/signup`, `/auth/login`, OTP routes | public/session transition | existing validation retained |
| Office export | `/office/export` | api_key_required | existing export key retained |
| Facility estate/home/room/user routes | `/facility/*` | jwt_required + permission_required | permission guards applied in first pass |
| Facility devices | `/facility/devices/*` | jwt_required + permission_required | now guarded with `devices.read` / `devices.control` |
| Consumer devices | `/devices/*` | jwt_required + permission_required | guarded with `devices.read` / `devices.control` |
| Wallets | `/wallets/*` | jwt_required + permission_required | guarded with `wallets.read` / `wallets.manage`; Paystack webhook remains provider-public with signature verification |
| Visitors | `/visitors/*` | jwt_required + permission_required | now guarded with `visitors.create` / `visitors.manage` |
| Facility visitors | `/facility/visitors/*` | jwt_required + permission_required | now guarded with `visitors.manage` |
| Maintenance / support | `/maintenance`, `/facility/maintenance`, consumer maintenance route | jwt_required + permission_required | now guarded with `support.read` / `support.assign` |
| Community | `/community/*` | jwt_required + role_required | still role-guarded; permission-key conversion remains next cleanup |
| Cameras | `/cameras/*` | jwt_required + role_required | still role-guarded; permission-key conversion remains next cleanup |
| Messages | `/messages/*` | jwt_required | still auth-only; moderation routes need permission-key guard later |
| Edge discovery | `/edge-discovery/*` | currently mixed | needs edge-token hardening before Tier 2 |
| Socket.IO community live | socket events | socket_session_expected | still needs token validation at socket handshake before Tier 2 |

### Permissions Applied Summary

Office:

- `twin.control` added to Digital Twin device action.
- `devices.control` added to Digital Twin edge sync.
- `planstudio.write` added to Plan Studio project upload, parse, analyze, discipline, and geometry writes.
- `planstudio.read` added to Plan Studio agent Q&A.
- Existing Office permissions remain active for storage, documents, staff, audit, integrations, CRM, notifications, and Office data.

Backend:

- Facility device discovery/listing now requires `devices.read`.
- Facility device register/assign/command/location update now requires `devices.control`.
- Visitor creation/listing now requires `visitors.create` where resident-owned.
- Visitor verification, approval, entry, exit, analytics, facility timeline, report export, and lockdown now require `visitors.manage`.
- Maintenance creation/listing now requires `support.read`.
- Facility maintenance update now requires `support.assign`.
- Existing first-pass guards remain for estate/home/room/facility/wallet/device routes.

### Audit Coverage Summary

Office:

- Existing Office audit continues for login/logout/password/staff/storage/documents/import/sync/maps/office assets.
- Digital Twin device action emits `twin.device.action`.
- Digital Twin edge sync emits `edge.heartbeat`.
- Plan Studio upload emits `plan.uploaded`.
- Permission denials emit `permission.denied`.

Backend:

- `requireAuth()` now emits `auth.failed` for missing, invalid, expired, or malformed JWTs.
- `requirePermission()` now emits `permission.denied` for unauthenticated or unauthorized access.
- Device command request emits `device.command.requested`.
- Device command execution emits `device.command.executed`.
- Device registration emits `device.registered`.
- Device assignment emits `device.assigned`.
- Wallet funding initialization emits `wallet.funding.initialized`.
- Wallet debit emits `wallet.debited`.
- Audit records now include `actor_email` support in the backend contract and migration.

Remaining audit expansion:

- Estate/home/room mutation controllers still need explicit success audit events for every create/update/delete path.
- Visitor/support/community/message controllers need deeper success audit events beyond guard-level denial tracking.
- Staff invite/photo/password flows are audited in Office, but backend staff/admin equivalents should be audited if introduced.

### Realtime Event Bridge Summary

Office:

- Office SSE remains the stable admin-facing realtime channel.
- Office publishes standardized events for storage, notification, audit, edge heartbeat, and twin state updates.

Backend:

- Backend `emitSignal()` now bridges known control-plane signal types into standardized Socket.IO event names:
  - `device.status.updated`
  - `visitor.created`
  - `wallet.funded`
  - `support.ticket.created`
  - `support.ticket.assigned`
  - `estate.updated`
  - `home.updated`
  - `edge.heartbeat`
  - `office.notification`
  - `audit.recorded`
  - `twin.state.updated`
- Backend audit writes emit `audit.recorded` into the realtime bridge.

Remaining realtime work:

- Socket.IO handshake still needs token validation and role-aware room subscription checks.
- Office SSE and backend Socket.IO are standardized by event names, but not yet physically connected as one broker.

### Storage Metadata Summary

Office storage metadata standard already captures:

- `fileId` / `id`
- `ownerType`
- `ownerId`
- `estateId`
- `purpose`
- `filename`
- `mimeType`
- `size`
- `storageDriver`
- `storagePath` / `url`
- `createdBy`
- `createdAt`

Backend storage state:

- Backend already has S3 service support.
- Backend still needs a shared `files` / `storage_objects` metadata table equivalent to Office `office_files` for staff photos, resident photos, estate images, documents, generated PDFs, plan uploads, camera snapshots, device snapshots, and twin files.

### Contract Adoption Summary

- Office exports and Office APIs now expose `X-Oyi-Contract-Version` direction and shared contracts.
- Backend Office export includes `contract_version`.
- Backend auth tokens include `permission_scopes` and computed permissions.
- Facility API client sends `X-Ochiga-Surface: facility` and `X-Oyi-Contract-Version`.
- Consumer API client sends `X-Ochiga-Surface: consumer` and `X-Oyi-Contract-Version`.
- Facility and Consumer decode shared identity/permission contract from JWT.

Remaining contract work:

- Add boundary validation to backend request bodies using the shared contracts or Zod-style schemas.
- Normalize all response payloads for devices, wallets, support tickets, documents, plans, digital twin objects, and edge agents.

### New Migrations Required

Backend migrations added:

- `/Users/ochigaidoko/Documents/Ochiga-backend/migrations/2026-05-16-tier1-foundation-audit-events.sql`
- `/Users/ochigaidoko/Documents/Ochiga-backend/migrations/2026-05-16-tier1-foundation-permission-scopes.sql`

Office migration update:

- Apply `/Users/ochigaidoko/oyi-edge-agent/db/lead-agents-schema.sql` to the Office Supabase database to create/update `audit_events` and `office_files`.

### Environment Variables Required

Office / Edge Agent:

- `LEAD_AGENTS_SESSION_SECRET`
- `LEAD_AGENTS_AUTH_MODE`
- `LEAD_AGENTS_API_KEYS`
- `OYI_EDGE_AGENT_TOKEN` or `OYI_EDGE_AGENT_TOKENS`
- `OFFICE_STORAGE_DRIVER`
- `OFFICE_STORAGE_DIR`
- Existing integration keys for OpenAI, Google Maps, Resend, Meta/WhatsApp, LinkedIn, Facility export, and Consumer export.

Backend:

- `APP_JWT_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PAYSTACK_SECRET_KEY`
- Existing provider credentials for Tuya, Twilio, Resend/email, Google, Meta/WhatsApp, and storage where enabled.

### Verification Results

Passed:

- Office/Edge: `node --check src/lead-agents/server.js`
- Office/Edge: `npm run tier1:smoke`
- Office/Edge: `npm test`
- Backend: `npm run build`
- Facility: `npx tsc --noEmit --pretty false`

Consumer typecheck status:

- `npx tsc --noEmit --pretty false` still fails on pre-existing UI/mobile issues unrelated to the Tier 1 foundation changes:
  - community page event/discussion type comparisons
  - missing `ChatMessage` exports in AI console types
  - missing `@capacitor/keyboard`
  - remote panel prop mismatches
  - `boolean | ""` device props
  - nullable socket checks in `useSignalStream`
  - missing `@capacitor/preferences`

### Final Tier 1 Production Hardening Status

Unified Auth: partial

- Stronger than before: Office protected routes, backend JWT auth, Facility/Consumer token decoding, and edge-token support for Office edge sync are now aligned.
- Blocker: backend Socket.IO handshake and edge discovery routes still need explicit token validation.

Unified Permissions: partial

- Stronger than before: high-risk Office, Facility device, visitor, wallet, maintenance, facility, and device routes now use permission checks.
- Blocker: community, camera, messages, moderation, and some estate/home success paths still use role-only or auth-only protection.

Unified Contracts: partial

- Stronger than before: shared identity/permission contract is active across Office, backend, Facility, and Consumer.
- Blocker: full request/response validation is not yet universal.

Realtime Infrastructure: partial

- Stronger than before: backend Socket.IO now emits standardized event names compatible with Office SSE naming.
- Blocker: Office SSE and backend Socket.IO are not yet connected to one production event broker, and socket subscriptions are not yet permission-scoped.

Production Storage: partial

- Stronger than before: Office storage metadata is standardized.
- Blocker: backend storage metadata table/service is still needed for non-Office uploads and files.

Audit/Event System: partial

- Stronger than before: auth failures, permission denials, device command/register/assign, wallet funding init/debit, Office write actions, Digital Twin, and Plan Studio actions emit audit events.
- Blocker: not every successful estate/home/room/visitor/support/community/document action emits its own audit event yet.

### Tier 2 Decision

Not ready for Tier 2.

Blockers before Tier 2:

1. Protect backend Socket.IO handshake and room subscriptions with JWT/permission checks.
2. Harden backend edge discovery routes with edge token authentication.
3. Convert remaining role-only/auth-only sensitive routes to `requirePermission()`.
4. Add success audit emission to all estate/home/room/visitor/support/community/document mutation controllers.
5. Add backend storage metadata service/table for all non-Office uploads.
6. Fix Consumer pre-existing TypeScript blockers so the full platform can typecheck cleanly.
7. Apply the new migrations to production Supabase databases.

## Final Tier 1 Lockdown Pass

Date: 2026-05-16

This pass closes the final Tier 1 blockers before Tier 2. No Tier 2 product work, billing, CRM expansion, AI planner expansion, invoice expansion, digital twin live binding, monorepo move, or UI redesign was performed.

Note on the requested Office `Live Infrastructure View`: the module description has been preserved as the first Tier 2-ready Office viewport direction, but it was not implemented in this lockdown pass because it is a major UI/module redesign and conflicts with the explicit Tier 1 instruction not to redesign UI before lockdown completion.

### Files Changed

Office / Edge Agent:

- `src/lead-agents/config.js`
- `src/lead-agents/server.js`
- Existing first-pass Tier 1 files remain changed: auth, permissions, contracts, realtime, storage, audit, schema, smoke script, and foundation documentation.

Backend:

- `src/server.ts`
- `src/socketAuth.ts`
- `src/middleware/audit.ts`
- `src/middleware/auth.ts`
- `src/middleware/edgeToken.ts`
- `src/realtime/emitSignal.ts`
- `src/core/foundation/audit.ts`
- `src/core/foundation/contracts.ts`
- `src/routes/edgeDiscovery.ts`
- `src/routes/cameras.ts`
- `src/routes/community.ts`
- `src/routes/messages.ts`
- `src/routes/rooms.ts`
- `src/routes/facility.routes.ts`
- `src/routes/facilityDevices.routes.ts`
- `src/routes/facilityMaintenanceRoutes.ts`
- `src/routes/facilityVisitorsRoutes.ts`
- `src/routes/maintenance.routes.ts`
- `src/routes/consumerMaintenanceRoutes.ts`
- `src/routes/visitors.ts`
- `src/routes/homeUsers.routes.ts`
- `src/routes/invites.routes.ts`
- `src/routes/residents.ts`
- `src/routes/services.ts`
- `src/routes/signals.ts`
- `src/routes/deviceGeo.ts`
- `src/routes/geo.ts`
- `src/routes/notifications.ts`
- `src/routes/push.ts`
- `src/routes/superAdmin.ts`
- `src/controllers/deviceCommandController.ts`
- `src/controllers/deviceRegistryController.ts`
- `src/controllers/walletController.ts`
- `src/services/storageMetadataService.ts`
- `migrations/2026-05-16-tier1-foundation-audit-events.sql`
- `migrations/2026-05-16-tier1-foundation-permission-scopes.sql`
- `migrations/2026-05-16-tier1-foundation-platform-files.sql`

Consumer:

- `src/app/community/page.tsx`
- `src/app/components/ai-console/types.ts`
- `src/app/components/ai-console/logic/panelDecision.ts`
- `src/app/components/remotes/CommunityPanel.tsx`
- `src/app/components/remotes/SensorsPanel.tsx`
- `src/app/devices/DevicesClient.tsx`
- `src/hooks/useSignalStream.ts`
- `src/types/capacitor-optional.d.ts`
- Existing first-pass auth/session/API contract files remain changed.

### Socket.IO Security Summary

- Socket.IO now requires JWT authentication during handshake via `io.use(authenticateSocket)`.
- Socket context now carries authenticated user identity, role, estate id, home id, permission scopes, and computed permissions.
- Unauthorized socket handshakes emit `auth.failed` audit events.
- Room subscriptions now enforce permissions:
  - `subscribe:estate` -> `estates.read`, with estate scoping unless `office.read` is present.
  - `subscribe:user` -> own user only unless `staff.manage` is present.
  - `subscribe:room` -> `homes.read`.
  - `subscribe:thread` -> `support.read`.
- Community live socket events now check `community.read` or `community.write` before joining, signaling, chatting, hosting, guesting, or stopping live sessions.
- Denied socket actions emit `permission.denied` audit events and return `error:permission` to the socket.

### Edge Route Hardening Summary

- Added `requireEdgeToken()` middleware.
- Edge discovery push now requires `OYI_EDGE_AGENT_TOKEN` or one of `OYI_EDGE_AGENT_TOKENS`.
- Missing or invalid edge tokens return `401` and emit `auth.failed`.
- Successful discovery pushes emit `edge.discovery.received` with site id, agent id, and device count.
- Facility reads for discovered devices now require JWT plus `devices.read`.

### Permission Conversion Summary

Converted high-risk remaining routes from role-only/auth-only to `requirePermission()`:

- Cameras: `cameras.view` for view/read paths, `devices.control` for bind/profile action paths.
- Community: `community.write` for post/media/live/comment/reaction mutations.
- Messages: `community.read` for reads, `community.write` for sends/uploads/reports, `support.assign` for moderation.
- Rooms: `homes.read` and `homes.write`.
- Facility estate/home/room/user routes: already guarded, now with audit wrappers where mutating.
- Visitors and facility visitors: `visitors.create` and `visitors.manage`.
- Maintenance/support: `support.read` and `support.assign`.
- Services/wallet-like operations: `settings.manage`, `wallets.read`, `wallets.manage`.
- Signals/device command aliases: `devices.control`.
- Geo/device geo: `estates.read`, `estates.write`, `devices.read`, `devices.control`, `visitors.manage`.
- Notifications/push: `notifications.read`.
- Super admin: converted from role guard to permission guards across office, audit, estate, home, device, wallet, and staff operations.

### Audit Coverage Summary

Added reusable `auditOnSuccess()` middleware for successful route mutations and added direct audit events in controllers/middleware.

Coverage now includes:

- `auth.failed`
- `permission.denied`
- `estate.created`
- `estate.updated`
- `home.created`
- `home.updated`
- `room.created`
- `room.updated`
- `visitor.created`
- `visitor.updated`
- `visitor.approved`
- `visitor.entry.logged`
- `visitor.exit.logged`
- `support.ticket.created`
- `support.ticket.assigned`
- `community.post.created`
- `community.post.updated`
- `community.post.deleted`
- `message.sent`
- `message.moderated`
- `camera.viewed`
- `camera.action.requested`
- `device.registered`
- `device.assigned`
- `device.command.requested`
- `device.command.executed`
- `wallet.funding.initialized`
- `wallet.debited`
- `edge.discovery.received`
- Existing Office coverage for `document.generated`, storage upload, staff create/update/invite/photo/reset, plan upload, twin device action, edge heartbeat, and Office sync/import remains active.

Audit payload now supports:

- actor id
- actor email
- actor role
- action
- resource type
- resource id
- estate id
- home id
- status
- metadata
- IP
- user agent
- timestamp

### Backend Storage Metadata Summary

Added backend storage metadata foundation:

- `src/services/storageMetadataService.ts`
- `migrations/2026-05-16-tier1-foundation-platform-files.sql`

The metadata table is `platform_files` and supports:

- `id`
- `file_id`
- `owner_type`
- `owner_id`
- `estate_id`
- `home_id`
- `purpose`
- `filename`
- `mime_type`
- `size`
- `storage_driver`
- `storage_path`
- `public_url`
- `created_by`
- `created_at`
- `metadata`

Supported purposes:

- `staff_photo`
- `resident_photo`
- `estate_image`
- `document`
- `generated_pdf`
- `plan_upload`
- `camera_snapshot`
- `device_snapshot`
- `digital_twin_file`

### Consumer TypeScript Fix Summary

Fixed the Consumer typecheck blockers without product behavior changes:

- Widened community post type handling to include `event` safely.
- Added missing `ChatMessage` export to AI console types.
- Corrected AI panel type import path.
- Added optional Capacitor module declarations for `@capacitor/keyboard` and `@capacitor/preferences`.
- Fixed remote panel prop typing for Community and Sensors panels.
- Converted `boolean | ""` busy flags to explicit booleans.
- Guarded nullable socket from `getSocket()` before use in `useSignalStream()`.

### Migration List And Commands

Office database:

```bash
cd /Users/ochigaidoko/oyi-edge-agent
# Apply db/lead-agents-schema.sql to the Office Supabase SQL editor or via your existing migration runner.
# This contains Office audit_events and office_files updates.
```

Backend database:

```bash
cd /Users/ochigaidoko/Documents/Ochiga-backend
# Apply these SQL files to the backend Supabase SQL editor or migration runner:
# migrations/2026-05-16-tier1-foundation-audit-events.sql
# migrations/2026-05-16-tier1-foundation-permission-scopes.sql
# migrations/2026-05-16-tier1-foundation-platform-files.sql
```

Required production env additions:

```bash
OYI_EDGE_AGENT_TOKEN=replace-with-single-edge-token
# or
OYI_EDGE_AGENT_TOKENS=token-one,token-two
```

Existing required envs remain:

- `LEAD_AGENTS_SESSION_SECRET`
- `LEAD_AGENTS_AUTH_MODE`
- `LEAD_AGENTS_API_KEYS`
- `APP_JWT_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### Verification Results

Passed:

- Office/Edge: `npm run tier1:smoke`
- Office/Edge: `npm test`
- Backend: `npm run build`
- Facility: `npx tsc --noEmit --pretty false`
- Consumer: `npx tsc --noEmit --pretty false`

### Final Tier 1 Decision

READY FOR TIER 2

Production deployment gate before live use:

- Apply the Office and backend Supabase migrations listed above.
- Set `OYI_EDGE_AGENT_TOKEN` or `OYI_EDGE_AGENT_TOKENS` in Render/backend env and any matching edge-agent runtime.
- Restart backend services after env/migration changes.

The requested Ochiga Office `Live Infrastructure View` should be treated as the first Tier 2 UI/platform module because it is a major operational viewport redesign and should now build on the locked Tier 1 foundations.
