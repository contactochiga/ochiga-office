# Ochiga / Oyi Infrastructure Operating System v1.0 Readiness Plan

Generated: 2026-05-19

## Scope

This document tracks the path from the current 58-62% readiness range to a production-grade v1.0 across:

- Ochiga Office OS
- Oyi Facility OS
- Oyi Consumer OS
- Oyi Edge Agent
- Oyi Digital Twin
- Oyi Plan Studio
- Oyi AI / Widget
- Backend / Tier 1 Foundations

The operating rule is: no random feature expansion. A module is complete only when it has route, dashboard, live data, permission visibility, backend enforcement, audit events, realtime where needed, storage metadata where needed, loading/error/empty states, responsive UI, verification, no dead buttons, no duplicate pages, and no broken routes.

## Current Repository Map

### Ochiga Office / Edge / AI repo

Path: `/Users/ochigaidoko/oyi-edge-agent`

Contains:

- Office dashboard: `public/dashboard/index.html`, `public/dashboard/dashboard.js`
- Oyi / Oma widget: `public/widget/oma-widget.js`
- Digital Twin static runtime: `public/digital-twin/*`
- Plan Studio static runtime: `public/plan-studio/*`
- Office/lead-agent backend: `src/lead-agents/*`
- Office Tier 1 smoke checks: `scripts/smoke-tier1-foundations.js`
- Tier 1 docs: `docs/tier1-production-foundation.md`

### Backend repo

Path: `/Users/ochigaidoko/Documents/Ochiga-backend`

Contains:

- Express backend: `src/app.ts`, `src/server.ts`
- Socket.IO security foundation: `src/socketAuth.ts`, `src/server.ts`
- Permission middleware: `src/middleware/auth.ts`, `src/middleware/roles.ts`
- Audit foundation: `src/core/foundation/audit.ts`, `src/middleware/audit.ts`
- Storage metadata foundation: `src/services/storageMetadataService.ts`
- Edge token middleware: `src/middleware/edgeToken.ts`
- Migrations: `migrations/2026-05-16-tier1-foundation-*.sql`

### Facility repo

Path: `/Users/ochigaidoko/Documents/facility-oyi`

Contains:

- Facility routes under `app/(protected)/*`
- Facility module registry: `lib/moduleRegistry.ts`
- Facility permissions: `lib/oyiFoundation.ts`
- Facility API clients: `services/*`
- Facility shell navigation: `components/shell/SidebarContent.tsx`

### Consumer repo

Path: `/Users/ochigaidoko/Oyi-os-frontend`

Contains:

- Consumer routes under `src/app/*`
- Consumer module registry: `src/lib/moduleRegistry.ts`
- Consumer permissions: `src/lib/oyiFoundation.ts`
- Consumer socket client: `src/services/socket.ts`
- Consumer realtime hooks: `src/hooks/useSignalStream.ts`, `src/hooks/useDeviceLiveState.ts`
- Consumer API services: `src/services/*`

## Current System State

### Backend / Tier 1 Foundations

Status: 72-78% production ready.

Working foundations observed:

- JWT auth middleware exists.
- `requirePermission()` exists in backend middleware.
- Socket.IO handshake is wired through `authenticateSocket`.
- Socket room subscription checks exist for estate, user, room, thread, and community-live flows.
- Edge token middleware exists and audits failed edge auth attempts.
- Central audit table migration exists.
- Platform storage metadata table migration exists.
- Permission scopes migration exists.
- Realtime signal emitter exists and normalizes core event names.

Main blockers:

- Some routes still contain controller-level `Not authenticated` checks without complete route-level permission conversion.
- Success audit coverage is not yet uniform for every mutation controller.
- Storage metadata helpers exist but must be connected to every non-Office upload path.
- Migration application status must be verified in Supabase/Render production.
- Route classification matrix needs to be maintained as a living source of truth.

### Ochiga Office OS

Status: 68-74% production ready.

Working surfaces observed:

- Office Overview dashboard exists.
- Live Infrastructure View exists with Google Maps / infrastructure viewport direction.
- Estate Portfolio, Hardware Devices, CRM & Support, Documents & Plans, Infrastructure Intelligence, AI Operations, Knowledge & Audit, Platform Infrastructure, Administration all have dashboard/panel surfaces.
- Sidebar is module-based, not nested.
- Permission-aware sidebar visibility exists in `OFFICE_MODULE_REGISTRY`.
- Office audit, storage, integrations, maps, documents, staff, CRM, support, and AI panels are wired to available Office APIs.

Fix applied in this pass:

- CRM and AI module panels now re-render after live data refresh so they do not remain stale or blank after login/session restore.
- Administration tabs now stay inside the Administration module instead of jumping to other modules or opening placeholder modals.
- Administration now has internal sections for dashboard, staff, permissions, settings, integrations, accounts, and super-admin posture.

Main blockers:

- Office module top tabs still include some facet-only controls that need real section bodies or safe disabled states.
- AI Operations needs deeper live binding to audited Oyi tool execution once backend AI command routes are standardized.
- Live Infrastructure View needs deeper Digital Twin/Heat Map operational binding beyond current visual and map foundation.
- Office storage and document generation need production PDF/email finalization.

### Oyi Facility OS

Status: 62-68% production ready.

Working surfaces observed:

- Facility module registry exists and follows the new domain structure.
- Facility routes exist for overview, live infrastructure, estate structure, hardware devices, security/access, utilities, environment, traffic, maintenance, community, wallets, intelligence, administration.
- Facility services are connected to backend APIs for estates, homes, rooms, devices, cameras, visitors, maintenance, community, wallets, messages, notifications, super admin, service config.
- Facility sidebar visibility uses `visibleModules()`.
- Facility login/signup are backend-connected.

Main blockers:

- Pricing/service layers are still present in service operations and need to be hidden or scoped until all infrastructure systems are complete.
- Some module pages are still scaffold dashboards and need full live estate-scoped widgets.
- Facility login/signup network reliability must be verified against live Render CORS and deployed backend URLs.
- Utility modules need real power, water, network, and sensor endpoints fully replacing scaffold logic.
- Facility Digital Twin page needs live Twin binding rather than mostly aggregated operational panels.

### Oyi Consumer OS

Status: 60-66% production ready.

Working surfaces observed:

- Consumer module registry exists and is permission-aware.
- Consumer routes exist for home, rooms, devices, security, utilities, maintenance, visitors, community, wallet, reports, AI, account.
- Consumer auth service, socket client, permissions, realtime hooks, wallet, devices, visitors, community, maintenance services exist.
- Consumer TypeScript check currently passes.

Main blockers:

- Consumer modules need consistent loading/error/empty states across every route.
- Socket realtime subscriptions must be permission-filtered end-to-end by backend room policy.
- AI & Automation is intentionally a Tier 2 planner surface; for v1.0 it should stay permissioned, minimal, and audited.
- Some route/service duplication remains (`estateOpsService` overlaps with specific service files) and should be consolidated safely.
- Mobile responsiveness exists directionally, but tablet/iPad layouts need a formal route-by-route review.

### Oyi Edge Agent

Status: 48-56% production ready.

Working surfaces observed:

- Edge agent repo/runtime exists inside `oyi-edge-agent`.
- Backend has edge discovery and edge token security foundation.
- Camera/go2rtc config exists.
- Device/control concepts are present in backend and Facility services.

Main blockers:

- Offline queue, local persistence, retry strategy, and conflict handling need production hardening.
- Hardware adapters need verified provider-specific test flows.
- Edge heartbeat/discovery needs live production monitoring and audit review.
- Local command authorization must be tied to the unified permission/audit contract.

### Oyi Digital Twin

Status: 42-50% production ready.

Working surfaces observed:

- Static Digital Twin runtime exists under `public/digital-twin`.
- Twin model assets exist.
- Backend digital twin service file exists in Office repo.
- Backend emits `twin.state.updated` through realtime naming foundation.
- Facility has a digital-twin route.

Main blockers:

- Twin is not yet a fully live operational twin.
- Needs object identity mapping between estate/building/home/device/camera records and twin objects.
- Needs click/hover object actions with permission checks.
- Needs live device/camera/incident overlays.
- Needs audited actions for twin controls.

### Oyi Plan Studio

Status: 40-48% production ready.

Working surfaces observed:

- Static Plan Studio runtime exists under `public/plan-studio`.
- Office lead-agent backend has `src/lead-agents/plan-studio.js`.
- Backend Tier 1 permissions include `planstudio.read` and `planstudio.write` direction.

Main blockers:

- Upload/analyze/export pipeline needs backend production route enforcement.
- Plan records need shared contracts and storage metadata on every upload.
- AI extraction/analysis should remain Tier 2 until Tier 1 route/storage/audit is fully locked.
- Needs link into Digital Twin object generation pipeline.

### Oyi AI / Widget

Status: 50-58% production ready.

Working surfaces observed:

- Widget runtime exists.
- Oyi command/orb UI direction exists in Office dashboard and widget files.
- Office AI Operations dashboard exists.
- Lead-agent backend has OpenAI, tools, tracing, permissions, audit, realtime pieces.

Main blockers:

- Voice STT/TTS loop needs reliable browser + backend integration.
- AI command execution needs explicit permission checks before every tool call.
- Every AI action must emit audit events and realtime signals.
- Tool registry needs production schema and safe allowlist.
- AI must be command-layer, not chatbot-only.

## v1.0 Implementation Phases

### Phase 1: Foundation Lockdown

Goal: backend must enforce the same rules UI advertises.

Tasks:

- Finish route classification matrix: public, public_rate_limited, session_required, jwt_required, api_key_required, edge_token_required, admin_required, permission_required.
- Convert remaining auth-only/role-only sensitive routes to `requirePermission()`.
- Add success audit to all mutations not yet covered.
- Wire storage metadata service to every upload path.
- Confirm and apply Supabase migrations in production.
- Add endpoint-level smoke tests for protected mutations and denied access.

Exit criteria:

- Backend build passes.
- Protected routes reject unauthorized requests.
- Mutation routes emit audit success/failure records.
- Realtime room join requires authenticated JWT and correct permission.

### Phase 2: Office OS Completion

Goal: Office becomes the global command standard.

Tasks:

- Finish every Office module tab as either functional content, safe route, or permission-blocked state.
- Finalize CRM & Support as pure CRM/support with no AI agent duplication.
- Finalize AI Operations as AI-only command and execution module.
- Complete Administration section bodies and permission-visible actions.
- Complete Live Infrastructure View modes: Map, 3D Twin, Hybrid, Heat Map.
- Wire Office quick actions to production endpoints or safe command queue records.

Exit criteria:

- No blank modules.
- No duplicate CRM/AI pages.
- No dead Office buttons.
- Office smoke passes.

### Phase 3: Facility OS Completion

Goal: estate-scoped operations runtime.

Tasks:

- Remove/hide pricing layer until billing and services are explicitly production-ready.
- Ensure every Facility module uses live estate-scoped data.
- Replace utility scaffolds with real power, water, network, lighting, HVAC, sensor endpoints.
- Verify login/signup against live backend CORS.
- Finish Facility module dashboards with top tabs and no dead controls.

Exit criteria:

- Facility typecheck/build passes.
- Facility login/signup works live.
- Facility module routes load real estate-scoped data.

### Phase 4: Consumer OS Completion

Goal: mobile-first resident runtime.

Tasks:

- Confirm each module route is permission-visible and responsive.
- Normalize loading/error/empty states.
- Consolidate duplicate service clients.
- Ensure wallet, visitors, community, devices, rooms, maintenance use live backend data.
- Verify socket subscription with JWT and backend permission filtering.

Exit criteria:

- Consumer typecheck/build passes.
- Mobile routes are navigable.
- Resident-level permissions hide Office/Facility controls.

### Phase 5: Edge Agent Runtime

Goal: offline-capable hardware execution layer.

Tasks:

- Add persistent local queue.
- Add retry and conflict handling.
- Verify edge discovery + heartbeat with token auth.
- Standardize device command requested/executed audit flow.
- Verify camera stream health and snapshot metadata.

Exit criteria:

- Edge can reconnect after outage.
- Device command logs are auditable.
- Edge health is visible in Office/Facility.

### Phase 6: Digital Twin Live Binding

Goal: operational twin, not decorative 3D.

Tasks:

- Map twin objects to estate/building/home/device/camera records.
- Add object selection and hover state.
- Overlay live devices/cameras/incidents.
- Audit twin controls.
- Emit/consume `twin.state.updated`.

Exit criteria:

- Twin reflects live infrastructure state.
- Clicking twin objects opens correct records.
- Controls require permissions.

### Phase 7: Plan Studio Pipeline

Goal: operational plan ingestion and structured output.

Tasks:

- Production upload route with storage metadata.
- Plan records and contracts.
- Safe analysis queue.
- Link extracted objects to Digital Twin pipeline.
- Permission + audit enforcement.

Exit criteria:

- Upload/analyze/export is permissioned and audited.
- Plan files are stored with metadata.

### Phase 8: Oyi AI Command Layer

Goal: AI can operate the system safely.

Tasks:

- Reliable voice loop.
- Tool registry allowlist.
- Permission check before every tool call.
- Audit every AI decision and action.
- Window/canvas orchestration tied to real module routes.

Exit criteria:

- AI can answer and act only within permission scope.
- AI actions are auditable.
- AI opens real system modules, not fake windows.

### Phase 9: Production Hardening

Goal: v1.0 operational confidence.

Tasks:

- Central health endpoints.
- Render/Vercel environment validation.
- Error tracking and structured logs.
- Rate limiting on public/widget/auth routes.
- Backup and migration procedure.
- Final smoke suite across Office, Backend, Facility, Consumer.

Exit criteria:

- Clean builds/typechecks.
- Production deploys are repeatable.
- Health, audit, realtime, storage, auth are observable.

## Immediate Next Blockers

1. Commit and deploy current Office module refresh/admin fix.
2. Apply/verify backend migrations in production Supabase:
   - `migrations/2026-05-16-tier1-foundation-audit-events.sql`
   - `migrations/2026-05-16-tier1-foundation-permission-scopes.sql`
   - `migrations/2026-05-16-tier1-foundation-platform-files.sql`
3. Complete backend route matrix and finish permission/audit gaps.
4. Hide Facility pricing layer and verify live login/signup after backend CORS deployment.
5. Finish Office CRM/AI/Admin no-dead-UI pass.
6. Begin live binding work for Digital Twin only after Phase 1 is fully locked.

## Current Readiness Estimate

- Backend / Tier 1 Foundations: 75%
- Ochiga Office OS: 72%
- Oyi Facility OS: 65%
- Oyi Consumer OS: 64%
- Oyi Edge Agent: 52%
- Oyi Digital Twin: 46%
- Oyi Plan Studio: 44%
- Oyi AI / Widget: 55%

Overall ecosystem readiness: 62%.

## Tier 2 Decision

Not ready for Tier 2 yet.

Tier 2 should begin only after Phase 1 and Phase 2 are closed, because Digital Twin live binding, advanced AI planning, billing/invoices, and deeper CRM expansion depend on the same auth, permission, audit, storage, realtime, and module routing foundations.
