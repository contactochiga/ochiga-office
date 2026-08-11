# Ochiga Office

Ochiga Office is the corporate and commercial operating system for Ochiga.

It owns CRM intake, lead and opportunity workflows, Office dashboards, commercial knowledge, documents, OMA/OSA surfaces, and corporate intelligence surfaces. It does not own Oyi Edge local runtime responsibilities such as camera discovery, go2rtc configuration, heartbeat, outbox, or hardware execution.

## Runtime Ownership

- `lead-agents-server.js` starts the Office CRM/API server.
- `src/lead-agents/` contains CRM, lead-agent, Office workflow, communication, and Office sync behavior.
- `src/intelligence-core/` remains a transitional Office intelligence registry until those contracts are converged with Ochiga Backend/Oyi Core.
- `public/` contains Office dashboard, widget, plan-studio, and transitional digital-twin static assets.
- `db/lead-agents-schema.sql` contains additive CRM persistence definitions.

## Local Setup

1. Copy `.env.example` to `.env`.
2. Fill only the variables needed for local development.
3. Run `npm install`.
4. Run `npm run validate:release`.

Do not commit live credentials, local stores, traces, or generated outputs.

## Deployment Cutover

Run `npm run deployment:validate` before connecting Render/Vercel to this standalone repository. The operator checklist is in `docs/DEPLOYMENT_CUTOVER_PLAN.md`.

Production database schema application, credential rotation, website environment switching, and retirement of the old mixed deployment require explicit approval.

## Boundary

Office is the source of truth for corporate and commercial CRM state. Ochiga Backend remains the source of truth for operational/building/platform state. Integration happens through explicit intake, event, and projection contracts rather than shared source imports.
