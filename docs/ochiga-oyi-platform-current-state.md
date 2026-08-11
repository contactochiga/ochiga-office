# Ochiga / Oyi Platform Current State

Last updated: 2026-05-16

## 1. System Identity

The platform is the **Ochiga Infrastructure Operating System**.

Ochiga is the company and infrastructure governance layer. Oyi is the product operating system family that runs estate, building, resident, device, AI, edge, digital twin, and plan workflows.

At full capacity, the system is best described as:

**An AI-backed infrastructure operating system for smart estates, buildings, residents, hardware devices, service operations, documents, digital twins, and connected city-scale environments.**

## 2. Product Layers

### Ochiga Office OS

Ochiga Office OS is the internal command center and operational mothership.

It supervises:

- Estate facilities connected to Oyi Facility OS.
- Smart buildings, homes, residents, devices, wallets, and support activity connected to Oyi Consumer OS.
- Edge agents and site-level infrastructure health.
- Staff, roles, permissions, and internal operations.
- CRM, AI agents, customer support, messages, notifications, documents, reports, and audit trails.
- Platform integrations such as Google Maps, Google OAuth, Meta/WhatsApp, LinkedIn, email, storage, and future infrastructure providers.

Current capabilities:

- Production Vercel deployment through `office.ochiga.com.ng`.
- Admin authentication and session handling.
- Role and permission-aware UI actions.
- Office overview dashboard with estate, building, hardware device, wallet, support, revenue, activity, AI insight, and quick-action surfaces.
- Estate facility supervision page.
- Smart building supervision page.
- Hardware device registry and status page.
- CRM and AI agent command center.
- Customer support page.
- Documents/work-presence module.
- Staff and roles management surface.
- Knowledge pack / trace explorer.
- Settings and integration health surface.
- Inbox and notification centers.
- Google Maps-enabled estate location rendering.
- Office SSE realtime stream.
- Tier 1 foundation modules for auth, permissions, contracts, realtime, storage, and audit.

### Oyi Facility OS

Oyi Facility OS is the estate and facility management product for estate operators, gated communities, property groups, and facility teams.

It manages:

- Estates.
- Buildings.
- Homes/units.
- Residents and occupants.
- Visitor access.
- Security operations.
- Cameras and AI camera supervision.
- Maintenance.
- Service charge and facility finance flows.
- Community communication.
- Support tickets.
- Estate-level reports.
- Package/plan entitlement logic for Starter, Professional, and Enterprise facility subscriptions.

Current capabilities:

- TypeScript frontend foundation is present and passes typecheck.
- Facility API calls use shared Oyi foundation headers and contract versioning.
- Auth/session integration has been aligned with the shared Tier 1 model.
- Facility data can be mirrored into Ochiga Office tables/contracts.

### Oyi Consumer OS

Oyi Consumer OS is the resident, homeowner, and smart building app experience.

It manages:

- Resident identity and sessions.
- Homes and rooms.
- Smart home/building devices.
- Wallets and balances.
- Visitors.
- Community posts and discussions.
- Support requests.
- Device control panels.
- AI console surfaces.
- Signal/realtime updates.

Current capabilities:

- Consumer frontend passes TypeScript checks after Tier 1 cleanup.
- Shared auth/session foundation is present.
- Shared API helper sends contract version metadata.
- Optional Capacitor integrations are typed safely.
- Community, AI console, remote panels, device busy states, preferences, keyboard, and signal stream type blockers have been cleaned.

### Oyi Edge Agent

Oyi Edge Agent is the local infrastructure bridge for site-level hardware and edge operations.

It connects:

- Estate hardware devices.
- Cameras.
- Local edge nodes.
- Site health and heartbeat signals.
- Digital twin/action sync surfaces.
- Office and backend realtime infrastructure.

Current capabilities:

- Edge discovery and sync routes are hardened with edge-token authentication.
- Edge heartbeat/discovery actions emit audit events.
- Edge events can feed Office and backend realtime channels.
- Edge routes are no longer treated as open public writes.

### Oyi Digital Twin

Oyi Digital Twin is the spatial and 3D representation layer for estates, buildings, devices, cameras, rooms, utilities, and operational state.

It is intended to support:

- Live 3D estate models.
- Object-level selection and state.
- Cameras, devices, access points, incidents, utilities, HVAC, and security overlays.
- Device action routing.
- Twin state updates.
- Office visualization and future AI command windows.

Current capabilities:

- Shared contracts include digital twin object/event/action concepts.
- Sensitive twin action/sync paths have Tier 1 route protection and permission checks.
- Realtime event naming includes `twin.state.updated`.

### Oyi Plan Studio

Oyi Plan Studio is the plan upload, analysis, and design preparation surface.

It is intended to support:

- Estate plans.
- Building plans.
- Home/unit plans.
- 3D plan assets.
- Upload and analysis workflows.
- Future conversion into digital twin structures.

Current capabilities:

- Plan upload/analyze routes are included in Tier 1 route protection.
- Shared storage metadata supports plan uploads and generated files.
- Shared contracts include plan records.

### Oyi AI / Widget

Oyi AI is the communication and intelligence layer.

It includes:

- Public website widget.
- Internal Oyi command orb concept.
- AI communication center for leads, support, and internal command workflows.
- Voice, record, transcribe, chat, and future task execution flows.
- Oyi as the parent AI communication layer, with Oma, Osa, and future agents as child/specialized agents.

Current capabilities:

- Widget UI has chat, record, speak, file action surfaces, and Oyi branding.
- Transcription endpoint exists in the Office/Edge agent server surface.
- The Oyi orb/command screen is in active UI development.
- Public widget routes are classified separately from protected Office/Admin routes.

### Ochiga and Oyi Websites

The websites are public business, conversion, and education surfaces.

They are intended to:

- Explain Ochiga and Oyi products.
- Capture leads.
- Host the Oyi AI widget.
- Route prospects into CRM, demos, documents, contracts, and support.
- Present facility, consumer, office, smart estate, digital twin, and plan studio products.

Current capabilities:

- Website/widget lead and channel data can flow into Office CRM.
- Google, Meta, LinkedIn, WhatsApp, and email integrations are being wired through environment-driven settings.

## 3. Tier 1 Production Foundation

Tier 1 is the shared production foundation that makes the platform safe enough to expand.

### Unified Auth

Status: complete for foundation, still expandable per provider.

What exists:

- Shared Office auth module.
- Backend auth middleware and JWT-aware Socket.IO protection.
- Facility and Consumer shared auth/session helpers.
- Session identity can carry user, role, estate, home, and permissions context.
- Staff, resident, facility, office, widget, and edge identities are now modeled as part of the same platform direction.

### Unified Permissions

Status: complete for foundation, ongoing as new Tier 2 modules appear.

What exists:

- Shared permission model.
- Role/action-based permissions.
- Permission keys for estates, homes, devices, cameras, visitors, wallets, support, documents, twin, plan studio, staff, settings, and audit.
- Sensitive backend and Office routes now use permission checks where practical.
- Socket.IO room subscriptions are permission-protected.

Core roles:

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

### Unified Contracts

Status: complete for foundation.

What exists:

- Shared data contracts for users, staff, estates, buildings, homes, rooms, devices, cameras, wallets, visitors, maintenance tickets, support tickets, documents, plans, digital twin objects, edge agents, events, audit logs, and notifications.
- `X-Oyi-Contract-Version` is used for platform API interoperability.
- Office, backend, Facility, Consumer, Plan Studio, Digital Twin, Edge, and Oyi AI can converge on the same contract shape.

### Realtime Infrastructure

Status: complete for foundation.

What exists:

- Office SSE stream.
- Backend Socket.IO/control-plane hardening.
- Standardized event names.
- Event bridge support for device, visitor, wallet, support, estate, home, edge, office notification, audit, and twin state events.

Standard realtime events:

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

### Production Storage

Status: complete for foundation.

What exists:

- Office file metadata foundation.
- Backend platform file/storage metadata table and service.
- Metadata shape supports staff photos, resident photos, estate images, documents, generated PDFs, plan uploads, camera snapshots, device snapshots, and digital twin files.
- Storage is environment-driven rather than hardcoded to local paths.

### Audit/Event System

Status: complete for foundation.

What exists:

- Office audit event support.
- Backend audit event support.
- Success and failure audit coverage for sensitive actions.
- Permission denied and auth failed events.
- Audit records include actor, role, email where available, action, resource type, resource id, estate/home context, metadata, IP, user agent, timestamp, and status.

## 4. Business Model

The Facility OS monetization model currently uses three main tiers:

### Starter

For small gated communities.

- Setup fee: NGN 3,500,000.
- Monthly subscription: NGN 180,000/month.
- Up to 150 residential units.
- Up to 20 camera integrations.
- Basic device control.
- Service charge management.
- Visitor access control.
- Community messaging.
- Mobile app access.
- Email support.
- Monthly reports.

### Professional

For medium to large estates.

- Setup fee: NGN 8,000,000.
- Monthly subscription: NGN 450,000/month.
- Up to 500 residential units.
- Up to 100 camera integrations.
- Advanced device automation.
- Full facility management.
- Digital wallet integration.
- Advanced analytics dashboard.
- Priority support 24/7.
- Custom integrations.
- Weekly reports.
- API access.
- Role-based admin controls.
- Maintenance tracking.

### Enterprise

For premium estates and property groups.

- Setup fee: NGN 15,000,000.
- Monthly subscription: NGN 850,000/month.
- Unlimited residential units.
- Unlimited camera integrations.
- AI-powered automation.
- Multi-estate management.
- White-label solutions.
- Dedicated account manager.
- On-site training and support.
- Custom development.
- Realtime analytics.
- Full API and webhook access.
- 99.9% SLA guarantee.
- Data migration assistance.
- Customized reporting.
- Advanced security features.

## 5. Integrations

Current or planned integrations include:

- Google Maps for estate location and infrastructure maps.
- Google OAuth for sign-in flows.
- Google Analytics / Ads for website and conversion intelligence.
- Meta App integrations.
- WhatsApp Cloud API.
- Facebook Messenger.
- Instagram business integrations.
- LinkedIn marketing and analytics.
- Email provider through Resend or configured provider.
- Twilio for communications where credentials are already available in backend environments.
- Future device providers such as Tuya, Alexa-compatible imports, camera systems, access control, utilities, and edge hardware providers.

## 6. Data Flow

High-level flow:

1. Estates, buildings, homes, devices, cameras, residents, wallets, visitors, support, community, and documents originate from Facility OS, Consumer OS, backend services, Edge Agent, and integrations.
2. Shared contracts normalize those records.
3. Unified auth and permissions decide who can read, write, control, or supervise each action.
4. Storage metadata records all production files.
5. Audit records every sensitive action.
6. Realtime events broadcast operational changes.
7. Ochiga Office OS supervises the full ecosystem.
8. Oyi AI can use permitted data to explain, route, open views, and eventually execute controlled actions.

## 7. Current Production Readiness

Approximate readiness by layer:

- Ochiga Office OS: 75% production foundation, 45% full operational product.
- Backend: 80% production foundation, 55% full platform operations.
- Oyi Facility OS: 65% production foundation, 45% full product maturity.
- Oyi Consumer OS: 65% production foundation, 45% full product maturity.
- Oyi Edge Agent: 60% production foundation, 35% live hardware maturity.
- Oyi Digital Twin: 40% production foundation, 20% live twin maturity.
- Oyi Plan Studio: 40% production foundation, 20% full product maturity.
- Oyi AI / Widget: 45% production foundation, 25% full agentic command maturity.
- Websites: 55% production foundation, 35% polished conversion maturity.

## 8. Tier 2 Direction

Tier 2 starts after Tier 1 foundation and focuses on operational product depth.

The first Tier 2 module is the **Ochiga Office Live Infrastructure View**.

Purpose:

- Replace the old static infrastructure health map with a live operational viewport.
- Combine Google Maps, Oyi Digital Twin, hybrid visualization, heat maps, overlays, layer controls, filters, estate health, and route-aware action buttons.
- React to realtime events from Office SSE and backend Socket.IO naming.
- Become the central infrastructure supervision canvas inside Ochiga Office OS.

Tier 2 must build on Tier 1 rules:

- No sensitive action without auth.
- No sensitive action without permission.
- No mutation without audit.
- No file without storage metadata.
- No realtime event without standardized naming.
- No UI module that cannot later connect to real backend contracts.

## 9. Remaining Production Work

Before full city-scale production, the platform still needs:

- Complete backend data source wiring for every Office page.
- Real provider verification for Meta, LinkedIn, Google Ads/Analytics, WhatsApp, email, Twilio, device providers, and camera providers.
- Applied Supabase migrations in all production environments.
- Real Mapbox support if dual map providers are required.
- Full staff invite, photo upload, and email onboarding flow.
- Full document generation pipeline for proposals, contracts, invoices, letters, PDFs, and email sending.
- Full camera stream provider integration.
- Full Oyi AI voice/chat command execution with safe permissions.
- Full Digital Twin renderer and object binding.
- Full Plan Studio upload/analyze/generate pipeline.
- Load testing, rate limits, monitoring, backups, incident response, and production observability.

## 10. Naming

Recommended platform naming:

- Company/system layer: **Ochiga Infrastructure OS**.
- Product family: **Oyi OS**.
- Internal command center: **Ochiga Office OS**.
- Estate product: **Oyi Facility OS**.
- Resident/home product: **Oyi Consumer OS**.
- Local infrastructure bridge: **Oyi Edge Agent**.
- AI layer: **Oyi AI**.
- Spatial layer: **Oyi Digital Twin**.
- Design/plan layer: **Oyi Plan Studio**.
