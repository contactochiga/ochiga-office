# Ochiga and Oyi System Architecture Map

Updated: 2026-05-16

## One-System View

Ochiga is the company and infrastructure technology layer.
Oyi is the operating system family that runs the estate, building, facility, resident, device, agent, and command workflows.
Ochiga Office is the internal corporate command system that supervises the whole ecosystem.

At full capacity, the combined system should be referred to as:

**Ochiga Infrastructure Operating System**

Internally, the product family can be organized as:

- **Ochiga Office OS**: internal command, governance, agents, staff, CRM, support, documents, reporting, integrations, and oversight.
- **Oyi Facility OS**: estate and facility manager control plane.
- **Oyi Consumer OS**: resident, home, and smart-building app surface.
- **Oyi Edge Agent**: on-site hardware, camera, gateway, discovery, health, and edge connectivity runtime.
- **Oyi Digital Twin**: live 3D building/estate operational twin layer.
- **Oyi Plan Studio**: plan upload, parsing, analysis, and design-to-operations tooling.
- **Oyi AI / Oyi Widget**: AI communication and command interface across websites, Office, and external deployments.
- **Ochiga Website**: corporate infrastructure narrative and deployment intake.
- **Oyi Website**: product narrative for the Oyi infrastructure operating system.

## 1. Oyi Consumer OS

### What It Is

Oyi Consumer OS is the resident, occupant, and smart-building app layer. It is the user-facing side of the Oyi ecosystem for people living in or using connected estates, homes, apartments, buildings, or communities.

It is described in the existing knowledge base as the resident and consumer-facing app prepared for mobile packaging, including iOS-style deployment.

### Primary Users

- Residents
- Home occupants
- Apartment users
- Estate community members
- Invited guests
- Home admins
- Smart-building users

### Main Capabilities

- Resident authentication.
- Email signup and login.
- Google and Apple sign-in stubs.
- Estate-aware resident dashboard.
- Device live-state retrieval.
- Device discovery versus assigned-device views.
- Device command execution.
- Visitor access creation.
- Visitor code, link, and QR generation.
- Visitor status tracking.
- Wallet fetching.
- Wallet funding initialization flow.
- Wallet debit hooks.
- Community posting.
- Comments, replies, reactions, and likes.
- Maintenance ticket creation and history.
- Notifications listing.
- Invite acceptance and decline.
- Room creation.
- Room AI profile updates.
- Room user assignment.
- Realtime estate and device subscriptions.

### AI Role

The AI layer is intended to work as an action gateway, not just a chat interface. It should understand intents like:

- home summary
- room summary
- light control
- AC control
- TV control
- door control
- visitor access
- CCTV
- security
- maintenance
- wallet
- utilities
- rooms
- community
- devices

### Relationship To The Rest Of The System

Oyi Consumer OS sends real user/home/device/wallet/community/support data into Ochiga Office.
Ochiga Office supervises the system globally.
Oyi Facility manages the estate/facility side.
Oyi Edge Agent connects local hardware where needed.

### Current Production Readiness

Estimated production level: **60%**

Reason:
The app surface and many core workflows exist, but final backend dependency, payment activation, live device reliability, mobile packaging, permission hardening, and production observability still need completion.

## 2. Oyi Facility OS

### What It Is

Oyi Facility OS is the protected management dashboard for estates and facility operators. It is the control-plane side of Oyi for estate administrators, property managers, facility managers, and operational teams.

### Primary Users

- Estate administrators
- Facility managers
- Security teams
- Maintenance teams
- Property operators
- Estate finance/admin teams
- Multi-estate supervisors

### Main Capabilities

- Protected operator dashboard.
- Email/password login.
- OTP-gated signup.
- Site and estate creation.
- Estate membership bootstrap.
- Homes listing and creation.
- Rooms listing and creation.
- Home user invitations.
- Home membership role updates.
- Membership activation, disable, and removal.
- Device discovery through Tuya, SSDP, and ONVIF hooks.
- Device registration and attach hooks.
- Device command hooks.
- Visitor listing.
- Maintenance listing.
- Alerts and notifications.
- Plan-aware usage enforcement for homes and devices.
- Commercial onboarding draft persistence.

### Business Model Encoded

Current facility monetization package model:

- **Starter**
  - Setup: NGN 3,500,000
  - Monthly: NGN 180,000
  - Small gated communities.

- **Professional**
  - Setup: NGN 8,000,000
  - Monthly: NGN 450,000
  - Medium to large estates.

- **Enterprise**
  - Setup: NGN 15,000,000
  - Monthly: NGN 850,000
  - Premium estates and property groups.

### Relationship To The Rest Of The System

Oyi Facility OS is the estate operator source of truth.
It should sync estates, buildings, homes, devices, wallets, support cases, package plans, and usage state into Ochiga Office.
It connects operationally to Oyi Consumer OS, Oyi Edge Agent, Oyi Digital Twin, and Oyi AI.

### Current Production Readiness

Estimated production level: **65%**

Reason:
The operator UI and workflow coverage are strong, but billing persistence, invoicing, VAT, overages, payment rails, hardware imports, live estate sync into Office, and production-grade permission enforcement still need completion.

## 3. Ochiga Office OS

### What It Is

Ochiga Office OS is the internal corporate command center for the whole Ochiga business and product ecosystem.

It is not a public app. It is the internal mothership where Ochiga supervises products, estates, users, devices, staff, agents, commercial activity, support, documents, integrations, and operational governance.

### Current Location

Repository:

- `oyi-edge-agent`

Key files:

- `public/dashboard/index.html`
- `public/dashboard/dashboard.js`
- `src/lead-agents/server.js`
- `src/lead-agents/office-data.js`
- `src/lead-agents/office-sync.js`
- `src/lead-agents/store-supabase.js`
- `src/lead-agents/auth.js`

Production:

- `https://office.ochiga.com.ng`

Backend:

- `https://ochiga-lead-agents.onrender.com`

### Primary Users

- Ochiga owner/admin
- Super admins
- Operations staff
- Sales staff
- Support staff
- Finance/admin staff
- Technical staff
- Human supervisors
- AI agent supervisors

### Main Capabilities

- Office overview dashboard.
- Estate facility supervision.
- Smart building supervision.
- Hardware device supervision.
- CRM and agent command center.
- Customer support supervision.
- Document registry and generation foundation.
- Staff and role management.
- Knowledge pack and trace explorer.
- Settings and integration hub.
- Message inbox and conversation thread.
- Notifications and activity feed.
- Google Maps estate layer.
- Integration status view.
- Staff QR generation.
- Staff invite foundation.
- Password reset/change foundation.
- Permission model.
- Audit/event foundation.
- Office data contracts.
- Supabase/file storage drivers.
- Public/transcription route for Oyi voice.
- Public chat route for website/widget interactions.

### Office Data Contracts

Ochiga Office already has backend table contracts for:

- packages
- estates
- buildings
- homes
- devices
- wallets
- analytics
- documents
- support mappings

### Integrations Present

- Google Maps config.
- Google geocoding.
- WhatsApp Cloud API adapter.
- Meta environment readiness.
- LinkedIn environment readiness.
- Google Ads/Analytics readiness checks.
- Resend email provider foundation.
- Supabase store driver.
- Office facility sync service.
- Office consumer sync service.
- Server-sent event foundation.

### Relationship To The Rest Of The System

Ochiga Office OS is the central governance layer.
It should receive data from Oyi Facility OS, Oyi Consumer OS, Oyi Edge Agent, websites, CRM channels, support channels, documents, and agent interactions.
It is where role-based authority, supervision, reporting, and escalation should live.

### Current Production Readiness

Estimated production level: **70%**

Reason:
The Office UI, backend routes, data contracts, maps, integrations status, staff/auth, and Oyi command layer exist and are deployed. The remaining gap is real external data sync, verified provider integrations, hardened permissions, storage, sockets, and complete production workflows.

## 4. Oyi Edge Agent

### What It Is

Oyi Edge Agent is the site-level runtime for local infrastructure connectivity.
It is the edge daemon that can run near cameras, gateways, devices, or estate hardware to register itself, send health, discover local systems, and sync with the cloud.

### Current Capabilities

- Agent registration.
- Periodic heartbeat.
- Periodic discovery push.
- Durable local outbox queue.
- Exponential retry/backoff.
- Remote config pull.
- Health endpoint.
- Structured JSON logs.
- Graceful shutdown.
- Optional camera/ONVIF config.

### Relationship To The Rest Of The System

Oyi Edge Agent should connect physical infrastructure to the Oyi cloud and Ochiga Office.
It is the path for cameras, ONVIF, local device discovery, local telemetry, edge health, and site-level commands.

### Current Production Readiness

Estimated production level: **55%**

Reason:
The daemon foundation is clean, but full hardware protocol adapters, fleet management, OTA updates, camera streaming, secure provisioning, and production edge observability still need completion.

## 5. Oyi Digital Twin

### What It Is

Oyi Digital Twin is the 3D operational layer for estates, buildings, rooms, assets, cameras, controls, and device state.

The goal is not only a 3D render. The target is a live operational twin where operators can navigate a building or estate, inspect spaces, see device state, open equipment panels, view incidents, and trigger approved controls.

### Current Location

Key files:

- `public/digital-twin/index.html`
- `public/digital-twin/app.js`
- `public/digital-twin/model/scene-definition.json`
- `public/digital-twin/model/twin.glb`
- `src/lead-agents/digital-twin.js`

Routes:

- `/api/digital-twin/scene`
- `/api/digital-twin/device-action`
- `/api/digital-twin/edge-sync`

### Target Capabilities

- Navigable 3D building model.
- Exterior and interior visualization.
- Free camera movement.
- Clickable rooms, equipment, devices, doors, cameras, and zones.
- Live status overlays.
- Device control drawers.
- Event feed.
- Audit trail.
- Role-based command permission.
- CCTV/camera overlays.
- Lighting/access/HVAC/elevator/utility state.
- Maintenance and incident overlays.

### Relationship To The Rest Of The System

Digital Twin consumes data from Oyi Facility OS, Oyi Consumer OS, Oyi Edge Agent, device registry, camera systems, and Office permissions.
Ochiga Office should supervise and audit it.

### Current Production Readiness

Estimated production level: **40%**

Reason:
The visual and route foundation exists, but live device binding, production 3D model workflows, object picking, permissions, camera feeds, and real building system integrations are still early.

## 6. Oyi Plan Studio

### What It Is

Oyi Plan Studio is the design and plan-intelligence layer.
It is for uploading, parsing, analyzing, and converting estate/building/home plans into usable operational data.

### Current Location

Key files:

- `public/plan-studio/index.html`
- `public/plan-studio/app.js`
- `src/lead-agents/plan-studio.js`

Routes:

- `/api/plan-studio/projects`
- `/api/plan-studio/project`
- `/api/plan-studio/analyze`
- `/api/plan-studio/agent`
- `/api/plan-studio/discipline`
- `/api/plan-studio/parse`
- `/api/plan-studio/geometry`

### Target Capabilities

- Upload estate plans.
- Upload building plans.
- Upload home plans.
- Upload images, PDFs, CAD-like references, and 3D planning materials.
- Analyze plans.
- Extract geometry.
- Identify rooms/zones/assets.
- Prepare data for Digital Twin.
- Support AI design review.
- Support engineering/discipline review.
- Generate structured project records.

### Relationship To The Rest Of The System

Plan Studio should feed Oyi Digital Twin, Oyi Facility OS, Oyi Consumer OS, and Ochiga Office.
It is the bridge from design documents to operational infrastructure.

### Current Production Readiness

Estimated production level: **45%**

Reason:
The app and backend route foundation exist, but full file handling, advanced parsing, AI extraction, CAD/BIM import, geometry validation, storage, and production project workflows still need work.

## 7. Oyi AI / Widget

### What It Is

Oyi AI is the communication and command intelligence layer.
The widget is the distributable communication surface for websites and future external deployments.
The `/widget` command screen is the internal Oyi AI command shell.

### Current Location

Key files:

- `public/widget/index.html`
- `public/widget/oma-widget.js`

Routes:

- `/api/lead-agents/public/chat`
- `/api/lead-agents/public/transcribe`

### Current Capabilities

- Full-screen Oyi command orb.
- Voice capture foundation.
- Recording and stop state.
- Transcription endpoint.
- Speech synthesis response.
- Thin dotted voice wave.
- Voice-reactive wave from mic input.
- Typed command input.
- Draggable floating command windows.
- Window commands for estates, cameras, devices, alerts, documents, support, CRM, digital twin, plan studio, and Office overview.
- Public chat integration.
- Embeddable website widget script.

### Target Capabilities

- True live voice conversation.
- Streaming audio response.
- Wake word reliability.
- Clap wake reliability.
- Tool-planning agent behavior.
- Dynamic command windows.
- Voice-controlled open/close/minimize.
- Full Office context by user role.
- Public website sales/support responder.
- Admin command layer for internal operators.

### Current Production Readiness

Estimated production level: **50%**

Reason:
The interface and command foundation exist, but true live voice, durable conversational state, tool planner, streaming speech, permission-aware command execution, and multi-surface deployment hardening still need completion.

## 8. Ochiga Website

### What It Is

Ochiga.com is the corporate website. It explains the company, the infrastructure thesis, deployment categories, governance, command center, digital twins, and serious infrastructure operations.

### Primary Role

- Brand authority.
- Corporate positioning.
- Infrastructure thesis.
- Enterprise/institutional credibility.
- Deployment intake.
- Investor/partner/customer explanation.

### Target Website Areas

- Home.
- Oyi.
- Infrastructure.
- Technology.
- Solutions.
- Architecture.
- Governance.
- Command Center.
- Deployments.
- Engage.
- Console.
- Twin.
- Papers.

### Relationship To The Rest Of The System

The Ochiga website is the public narrative surface.
It should feed leads into Oyi AI/Oma/Osa, CRM, and Ochiga Office.
It should not be a self-serve SaaS checkout experience. It should position Ochiga as a serious infrastructure partner.

### Current Production Readiness

Estimated production level: **50%**

Reason:
The narrative direction exists, but the website still needs premium redesign, sharper page hierarchy, better copy discipline, better conversion flow, and stronger visual system alignment.

## 9. Oyi Website

### What It Is

The Oyi website is the product website for Oyi as the infrastructure operating system.

### Primary Role

- Explain Oyi as the product/OS.
- Show estate, facility, resident, device, command, AI, and twin capabilities.
- Drive qualified demos/deployments.
- Feed leads into Oyi AI and Ochiga Office.

### Relationship To The Rest Of The System

The Oyi website is product-facing, while the Ochiga website is company-facing.
The Oyi website should send visitor activity, conversations, forms, and lead data into Ochiga Office CRM.

### Current Production Readiness

Estimated production level: **50%**

Reason:
The positioning exists, but the page needs cleanup, conversion alignment, stronger product architecture, and final widget/CRM integration.

## System Grouping

The cleanest grouping is:

### Public Layer

- Ochiga Website.
- Oyi Website.
- Oyi Widget.
- Deployment intake.
- Public knowledge/papers.

Purpose:
Attract, educate, qualify, and convert external users, customers, partners, and investors.

### Product Layer

- Oyi Facility OS.
- Oyi Consumer OS.
- Oyi Edge Agent.
- Oyi Digital Twin.
- Oyi Plan Studio.

Purpose:
Run the estate/building/facility/resident/device operations.

### Corporate Layer

- Ochiga Office OS.
- CRM and agents.
- Staff and roles.
- Permissions.
- Knowledge pack.
- Documents.
- Support supervision.
- Integrations.
- Audit and governance.

Purpose:
Operate Ochiga as a company and supervise every connected product/system.

### Intelligence Layer

- Oyi AI.
- Oma.
- Osa.
- Future specialized agents.
- Prompt packs.
- Knowledge base.
- Voice command layer.
- Tool execution.

Purpose:
Communicate, assist, qualify, explain, command, automate, and route work across the whole system.

### Data and Integration Layer

- Supabase tables.
- Office data contracts.
- Render backend.
- Vercel frontend.
- Google Maps.
- WhatsApp/Meta.
- LinkedIn.
- Google Ads/Analytics.
- Resend email.
- Future Mapbox/Tuya/Alexa/Twilio.

Purpose:
Move data, verify channels, store records, connect third parties, and support real-time operations.

## Recommended Repository Organization

Do not move files blindly yet. The current repo is already production-linked to Vercel and Render.

Recommended future structure if this becomes a monorepo:

```text
ochiga-platform/
  apps/
    office/
    oyi-facility/
    oyi-consumer/
    ochiga-website/
    oyi-website/
    digital-twin/
    plan-studio/
  services/
    lead-agents-api/
    edge-agent/
    office-sync/
    integrations/
  packages/
    ui/
    auth/
    permissions/
    office-data-contracts/
    ai-agents/
    maps/
    documents/
    realtime/
  knowledge/
    company/
    product/
    sales/
    support/
    technical/
  infra/
    vercel/
    render/
    supabase/
    cloudflare/
```

Current practical approach:

- Keep `oyi-edge-agent` as Ochiga Office + Oyi AI + edge/backend runtime for now.
- Sync data from external Oyi Facility and Oyi Consumer repos instead of merging immediately.
- Create shared contracts before moving into a monorepo.
- Only migrate repos after production routing, envs, and deployment ownership are stable.

## Production Readiness Summary

| System | Current Production Level |
| --- | ---: |
| Ochiga Office OS | 70% |
| Oyi Facility OS | 65% |
| Oyi Consumer OS | 60% |
| Oyi Edge Agent | 55% |
| Oyi AI / Widget | 50% |
| Ochiga Website | 50% |
| Oyi Website | 50% |
| Oyi Plan Studio | 45% |
| Oyi Digital Twin | 40% |

Overall combined platform readiness: **55-60%**

This means the system is no longer conceptual. The main architecture, UI surfaces, backend routes, data contracts, and deployment pipeline exist. The remaining work is mainly production hardening, real integrations, data sync, permissions, storage, voice reliability, and cross-system automation.

## What Remains For 100% Capacity

### Critical Production Work

- Wire real Oyi Facility data sync into Office tables.
- Wire real Oyi Consumer smart-building/home/device sync into Office tables.
- Verify all channel integrations with live API checks.
- Complete WhatsApp, Instagram, Facebook Messenger, LinkedIn, Google Ads, and Google Analytics runtime validation.
- Finish fine-grained permissions across every UI and API action.
- Add durable production storage for uploads, documents, plans, staff photos, and generated PDFs.
- Complete staff invite, email, password reset, and profile-photo flows.
- Finish document generation, PDF export, invoice, proposal, contract, and email sending.
- Harden Oyi voice into true conversational voice mode.
- Add real-time sockets/SSE updates across Office.
- Complete estate marker drilldowns and estate action modals.
- Complete smart building registry and home drilldowns.
- Complete device action menus, reset history, assignment, import, and camera preview.
- Complete customer support ticket creation, assignment, SLA, escalation, and communication.
- Clean every remaining dashboard page into the same design language.
- Add end-to-end tests, API tests, browser smoke tests, and deployment health checks.
- Harden security, CORS, sessions, audit logs, rate limits, and secrets.

### Strategic Product Work

- Define final naming and product hierarchy.
- Decide monorepo versus connected multi-repo architecture.
- Create shared data contracts package.
- Create shared UI/design system.
- Create shared permission model.
- Create shared agent/tool registry.
- Create a formal deployment/onboarding process for estates.
- Create a formal integration onboarding process for devices and channels.
- Create a formal commercial workflow from website lead to Office CRM to Oyi Facility deployment.

## Full-Capacity Definition

At full capacity, Ochiga Infrastructure Operating System should be able to:

- Onboard estates.
- Onboard buildings.
- Onboard residents.
- Connect devices.
- Connect cameras.
- Manage access.
- Manage visitors.
- Manage wallets and service flows.
- Manage community interactions.
- Manage maintenance.
- Manage support.
- Manage documents and contracts.
- Manage CRM and leads.
- Manage staff and permissions.
- Manage agents and knowledge.
- Monitor real-time activities.
- Open maps, cameras, devices, support, CRM, estate details, documents, and digital twin windows through Oyi AI.
- Generate proposals, invoices, contracts, reports, and operational summaries.
- Show estate and infrastructure health across locations.
- Route incidents and escalations.
- Enforce permissions and audit every sensitive action.
- Connect public websites, product apps, edge hardware, and corporate operations into one intelligence-backed operating system.
