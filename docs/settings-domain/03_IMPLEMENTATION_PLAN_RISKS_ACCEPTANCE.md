# Settings Domain Audit, Part 3: Slices, Risks, Acceptance

## 1. Implementation slices and dependencies

Each slice is independently deployable, behind the existing `settings.manage` gate, with no change to autonomy, signature mode, RLS or Meta credentials.

| Slice | Scope | Depends on | Backend/DB change | Risk |
|---|---|---|---|---|
| S0 | Approve this architecture; confirm section list and ownership matrix | — | none | — |
| S1 | Settings shell: sub-nav, Overview, responsive layout, permission-gated sections; move existing blocks (status grid, autonomy, sync, letterhead) unchanged | S0 | none | Low |
| S2 | Component library: `settingForm`, `providerCard`, `statusIndicator`, `secretField`, `confirmDialog`, `permissionGate`, `auditTrail`; unit + browser tests | S1 | none | Low |
| S3 | Settings registry + history: `settings-registry.js`, `runtime_settings.version`, `runtime_setting_history`, generic GET/PUT, audit, concurrency; delegates for autonomy & letterhead | S2 | Office migration (additive) | Medium |
| S4 | Integrations & Communications: provider cards from `/admin/integrations`, read-only test-connection, outbox diagnostics + reconcile UI (dry-run first), visibility-repair UI, signature-mode status | S3 | none beyond S3 | Medium |
| S5 | Intelligence: AI provider cards (OpenAI/Gemini/Claude) from IQ-11F approval metadata; **no activation** | S3 + Backend read endpoint (separate approval) | Backend: read-only `/office/intelligence/providers` | Medium |
| S6 | Organization: company profile, locale/timezone/currency; letterhead validation | S3 | registry keys | Low |
| S7 | People & Access: link to Team, roles catalogue view, session policy (TTL, login limits) with super_admin step-up; MFA design only | S3 | auth changes need own review | High |
| S8 | CRM settings: stages, lead sources, assignment rules, duplicate policy | S3 + CRM consumers read them | consumer code changes | Medium |
| S9 | Security, Infrastructure, System Health, Audit filters/export | S3 | audit query params | Low–Medium |
| S10 | Buildings & IoT mirror (Facility/Consumer/Edge/Tuya status) | Backend read models | Backend read-only | Low |
| S11 | Finance mirror | Backend financial summary | none | Low |

Recommended order: S1 → S2 → S3 → S4 → S9 → S6 → S5 → S8 → S10/S11 → S7.

## 2. Risks and blockers

| # | Risk / blocker | Impact | Mitigation |
|---|---|---|---|
| R1 | No Backend settings API; all Backend config env-only | Office cannot edit Backend settings | Mirror only; any Backend write is a separate Backend approval |
| R2 | Secrets in env, two OpenAI keys (Office and Backend) | Drift, inconsistent rotation | Document single rotation runbook; show last-rotated metadata; no in-browser secret entry |
| R3 | Render Free plan sleeps; Render API token unauthorized for tooling | Health/deploy data unavailable programmatically; background workers pause | Use `/healthz`; owner supplies deployment info; hosting not changed |
| R4 | Over-broad existing gates (`integrations.read` held by `ochiga_staff`) | Staff sees integration status and autonomy state | Per-section gates in S1 |
| R5 | Fake controls erode trust | Operator believes a toggle works | Rule: no control without route + persistence + audit + test; "Not owned" sections stay honest |
| R6 | IQ-11F is offline, USD 0 authorized, Gemini unqualified | Provider cards could imply capability | Closed state vocabulary, no enable action, copy states "not live" |
| R7 | Session/MFA changes can lock out admins | High | Dedicated slice, break-glass super_admin, staged rollout, rollback script |
| R8 | Settings consumed by other code (CRM stages) must be read consistently | Behaviour drift | Single `getSetting()` accessor with cache invalidation; tests per consumer |
| R9 | Migrations on production Supabase | Data/RLS risk | Same procedure as outbox: backup, restore test, additive only, RLS on, no anon grants |
| R10 | `runtime_settings` currently lacks version/history | Lost-update, no per-change history beyond audit | S3 migration adds version and history |
| R11 | Single large `office.js` (17.6k lines) | Merge friction | Add `public/office/settings/*.js` modules loaded lazily; follow existing asset build check |
| R12 | Facility already has its own Roles/Permissions/Integrations tabs | Duplication/confusion | Office Settings mirrors Facility status and links; no duplicated editors |
| R13 | Consumer settings not audited here | Possible gaps | Treat as out of scope; confirm in a follow-up if Office must surface them |
| R14 | No standalone Edge Agent repo found | Edge facts limited to Backend | Obtain Edge repo/runbook before S10 design is finalized |

## 3. Acceptance criteria

Global:
1. Every visible control has a route, persistence, permission gate, audit record and automated test; otherwise it is rendered as read-only status.
2. No secret value is returned by any settings endpoint or logged; verified by test scanning responses and logs.
3. `WHATSAPP_WEBHOOK_SIGNATURE_MODE=enforce`, `whatsapp_autonomous_responses_enabled=false` default, Supabase RLS (0 tables without RLS, no anon/authenticated access) and Render plan are unchanged by any slice; asserted in CI and checked after deploy.
4. Autonomy toggle behaviour and API contract are byte-compatible with today's.
5. Role × permission matrix test passes for every section; unauthorised users get 403 and no data.
6. Save failures leave stored values unchanged and display them.
7. Concurrent edits are detected (409) rather than overwritten.
8. Mobile (≤480px) and tablet layouts have no horizontal overflow; keyboard-only and screen-reader checks pass; reduced motion respected.
9. AI provider cards never offer activation, never send a request to a provider, and show USD 0 authorized spend until a separate approval exists.
10. Office exposes no device-control call (tested).
11. Full Office suite, lint, build, secrets scan and deployment validation pass; production health verified after each slice.

Per-slice acceptance:
- S1: existing four blocks behave identically (regression tests), sub-nav deep links work, hidden sections return the denied state.
- S3: registry rejects unknown keys and invalid values; history shows old/new/actor; autonomy/letterhead delegate with unchanged responses.
- S4: outbox diagnostics, dry-run reconcile and repair dry-run visible to `integrations.manage` only; no outbound message possible.
- S5: provider cards read from approved metadata only; activation absent.

## 4. Decisions requested from the owner

1. Approve the section list and the "mirror, don't own" rule for Backend/Facility/Consumer/Edge settings.
2. Confirm secrets remain environment-only (no in-browser secret entry).
3. Approve the S3 additive Office migration (`version` column, `runtime_setting_history`).
4. Approve a Backend read-only providers endpoint for S5, or defer it.
5. Confirm priority of S7 (session policy/MFA) relative to CRM settings (S8).
6. Provide the Edge Agent repository or runbook for S10.
