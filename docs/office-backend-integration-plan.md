# Ochiga Office Backend Integration Plan

Updated: 2026-07-02

## Goal

Ochiga Office OS should consume Ochiga backend as the canonical platform backend and intelligence owner wherever possible.

This repo should not become a second full platform backend.

## Canonical Ownership

### Ochiga backend should own

- Oyi Core intelligence
- execution history and operational reasoning
- canonical platform entities where already centralized
- cross-product runtime outputs
- long-term shared auth, runtime, and operational APIs

### Office repo should own for now

- Office-specific session UX and internal auth shell
- Office commercial workflows
- Office-specific documents, proposals, demos, and partner workflows
- Office sync/import/export adapters
- Office presentation layer and supervisory tooling

## Current Backend Links Already Present

Current Office config already supports:

- `OFFICE_BACKEND_BASE_URL`
- `OYI_BACKEND_BASE_URL`
- `OFFICE_BACKEND_API_KEY`
- `OFFICE_BACKEND_BEARER_TOKEN`
- `OFFICE_BACKEND_EVENTS_ENABLED`
- `OFFICE_BACKEND_EVENT_PATH`
- Facility and Consumer export credentials

Current Office runtime already probes or syncs:

- Facility
- Consumer
- backend AI operations endpoints
- digital twin endpoints

## Transitional Areas

### `src/intelligence-core/*`

This local intelligence directory is transitional. It should not grow into a parallel Oyi Core.

Use it only for:

- compatibility with current Office features
- safe bridging during backend cutover

Avoid:

- new runtime categories
- duplicated awareness/reasoning engines
- duplicated execution ledger logic
- duplicated recommendations/automation ownership

## Recommended Integration Model

### Office frontend

Consumes:

- Ochiga backend runtime and business APIs
- Office-specific BFF endpoints where Ochiga backend coverage is incomplete

### Office BFF in this repo

Acts as:

- session-aware Office façade
- CRM/commercial workflow service
- sync/orchestration adapter for Facility and Consumer data
- document/report/proposal service

### Edge

Publishes operational events toward:

- Ochiga backend for canonical ingestion
- Office for visibility only where required

### Office material CRM events

Office can now build a safe material CRM event envelope after canonical intake creates a durable CRM lead and timeline record.

The publisher is disabled by default and uses `OFFICE_BACKEND_EVENTS_ENABLED=false` unless a cutover explicitly enables it. When enabled, Office posts to `OFFICE_BACKEND_BASE_URL + OFFICE_BACKEND_EVENT_PATH` with idempotency headers and either `OFFICE_BACKEND_API_KEY` or `OFFICE_BACKEND_BEARER_TOKEN`.

Current event families include:

- `technology_deployment_requested`
- `development_enquiry_received`
- `membership_requested`
- `partnership_enquiry_received`
- `lead_created`

Office remains the CRM/commercial source of truth. Backend/Oyi Core should treat these as material event inputs for awareness and intelligence, not as a full CRM database replica.

## What Office Should Not Duplicate

Office should not duplicate:

- Oyi Core reasoning
- execution provenance
- recommendation runtime
- automation runtime
- canonical cross-product intelligence
- backend-owned operational event contracts

## Near-Term Integration Steps

1. Keep current Office BFF routes stable.
2. Mark local intelligence as transitional.
3. Continue syncing Facility and Consumer data into Office views.
4. Expand Ochiga backend APIs until Office can consume runtime outputs directly.
5. Reduce local intelligence ownership to adapters and presentation helpers only.
6. Approve and enable Office material CRM event publishing after Backend receiver validation.

## Static Dashboard Rebuild Notes

The current `/public/dashboard` shell is useful as an operational map of the product, but it still contains:

- dashboard-first information architecture
- older admin/dashboard wording
- desktop-first card density
- inconsistent command-center hierarchy

Future Office OS 2.0 rebuild should preserve the module coverage while replacing the shell with:

- a command-center header model
- operational strips
- registry-first modules
- consistent mobile shell
- shared Office primitives
