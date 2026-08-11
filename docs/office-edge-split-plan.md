# Ochiga Office / Oyi Edge Split Plan

Updated: 2026-07-02

## Goal

Separate the hybrid repo into clearer product ownership without disrupting working camera, stream, discovery, or Office workflows.

This document is a boundary plan only. No files move in Phase 1.

## Future Edge Agent Ownership

These surfaces should remain Edge-owned and eventually live in a separate service or repository:

- `/agent.js`
- `/edge/camera/*`
- `/go2rtc.yaml`
- camera discovery and runtime scripts
- local outbox persistence
- stream health and recovery tooling
- hardware and protocol onboarding docs

## Future Office OS Ownership

These surfaces should remain Office-owned:

- `/public/dashboard/*`
- `/src/lead-agents/*`
- CRM workflows
- proposals and demos
- partners and deployments
- facility workspace aggregation
- documents and reports
- notifications and traces
- admin users and permissions
- platform integrations

## Edge Responsibilities

Edge Agent should own:

- site registration
- heartbeat
- discovery
- camera stream validation
- local buffering/outbox behavior
- local resilience during backend outages
- local hardware credentials and stream topology

## Office Responsibilities

Office OS should own:

- supervisory command center UX
- cross-product visibility
- CRM and commercial operations
- partner and deployment workflows
- audit and governance surfaces
- internal collaboration and notifications
- integration monitoring
- digital twin visibility and operational review

## Interfaces Between Office and Edge

Edge should publish:

- heartbeat status
- discovery outputs
- stream health
- runtime failures
- camera availability
- local recovery state

Office should consume those outputs as:

- operational visibility
- support and escalation context
- deployment readiness state
- platform alerts

Office should not directly own local device protocol logic.

## Import Isolation Direction

Phase 1 should avoid deep coupling increases.

Safe direction:

- keep edge scripts and Office services logically separated
- avoid new imports from Office UI into edge runtime files
- avoid expanding local Office intelligence into edge files
- keep edge camera docs and runtime scripts independently runnable

## Separation Triggers

A dedicated Edge repo/service becomes worthwhile when one or more of these are true:

- multiple sites require independent edge deployments
- camera/runtime release cadence diverges from Office cadence
- local protocol dependencies grow
- Office deployment risk from edge changes becomes material
- backend event contracts for edge are stable enough to externalize

## Phase 1 Recommendation

- keep one repo temporarily
- treat Edge as a bounded subsystem
- treat Office as the product shell and command center
- document boundaries now
- split deployment/runtime ownership later, after backend integration hardens
