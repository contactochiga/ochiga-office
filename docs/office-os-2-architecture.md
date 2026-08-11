# Ochiga Office OS 2.0 Architecture

Updated: 2026-07-02

## Intent

This repository is currently a hybrid workspace that contains two product layers:

- **Ochiga Office OS**
- **Oyi Edge Agent**

Phase 1 does not split the repository yet. It establishes the architectural boundary so Office can continue evolving into the platform command center without breaking edge, camera, and agent operations that already run here.

## Product Roles

### Ochiga Office OS

Office OS is the command center for the Ochiga platform. It owns:

- internal desktop and mobile Office workspace surfaces
- CRM and commercial operations
- proposals, demos, partners, and deployments
- facility workspaces and cross-product oversight
- documents, reports, traces, notifications, and audit
- admin users, permissions, and governance workflows
- integrations and portfolio-level operations visibility

Office OS should supervise:

- Ochiga backend
- Oyi Facility OS
- Oyi Consumer OS
- Oyi Edge Agent
- Digital Twin
- AI operations and execution visibility

### Oyi Edge Agent

Edge Agent is the on-site runtime and hardware bridge. It owns:

- local runtime daemon entrypoints
- camera and stream adapters
- go2rtc and stream health
- hardware discovery
- site heartbeat and local outbox behavior
- local runtime recovery and failure isolation

## Current Repository Shape

### Office-owned surfaces in this repo

- `/public/dashboard/*`
- `/public/widget/*`
- `/public/digital-twin/*`
- `/public/plan-studio/*`
- `/src/lead-agents/*`
- `/db/lead-agents-schema.sql`
- Office-related docs, prompt packs, and commercial knowledge packs

### Edge-owned surfaces in this repo

- `/agent.js`
- `/edge/camera/*`
- `/scripts/check-camera-runtime-readiness.js`
- `/scripts/generate-go2rtc-config.js`
- `/scripts/setup-camera-edge.js`
- `/scripts/camera-ai-processor.js`
- `/go2rtc.yaml`
- local queue and stream-health behaviors under `/data` and camera docs

## Command-Center Direction

Office OS 2.0 should evolve toward this runtime and product shape:

```text
Ochiga Backend (canonical platform + Oyi Core)
        |
        +-- Office OS command center
        +-- Facility OS
        +-- Consumer OS
        +-- Edge Agent integrations
        +-- Digital Twin
```

Office should consume platform intelligence, not generate parallel intelligence kernels locally.

## Transitional Components

### `src/intelligence-core/*`

This local intelligence surface is transitional only.

It can remain as a compatibility adapter for current Office workflows, but it should not become a second long-term Oyi Core. Backend-owned Oyi Core remains the canonical intelligence owner.

### `src/lead-agents/*`

This folder remains the operational backend/BFF for Office in the short term because it owns:

- Office auth and session handling
- Office-specific commercial workflows
- Office document/proposal/demo workflows
- Office sync/import/export flows
- Office realtime and audit surfaces

Long term, it should either:

- remain as an Office-specific BFF over Ochiga backend, or
- be reduced to a thin Office service layer once Ochiga backend exposes all required Office APIs

## Static Dashboard Audit

### Pages to keep conceptually

- Overview / command center
- Facility supervision
- Device and infrastructure supervision
- CRM and AI operations
- Reports
- Settings / integrations
- Team / administration

### Pages or patterns to rebuild later

- first-generation dashboard grids and KPI-first blocks
- mixed “dashboard/admin” terminology
- desktop-first layout assumptions
- sections that bury operational registries behind overview cards
- duplicated summary surfaces across Office modules

### Missing Office OS 2.0 qualities

- unified mobile shell
- registry-first command-center structure
- consistent operational strips
- shared Office primitives instead of bespoke dashboard blocks
- cleaner separation between CRM workspace, platform oversight, and edge runtime views

## Phase 1 Outcome

After this stabilization phase:

- the repo validates consistently
- generated outputs are ignored
- Office branding can start moving toward Ochiga Office OS
- Edge runtime ownership is documented and protected
- Office runtime ownership is documented and protected
- backend integration direction is explicit
