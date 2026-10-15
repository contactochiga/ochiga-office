# Settings S3 — Implementation report

Contract: `06_S3_REGISTRY_CONTRACT.md` (frozen and committed before the runtime change). Not merged, not deployed, production **not migrated**.

## What was built
- `src/lead-agents/settings-registry.js` — code-defined registry (descriptor invariants enforced at construction), validators, redaction helpers, entry serialisation.
- `src/lead-agents/settings-api.js` — `GET /admin/settings`, `GET|PUT /admin/settings/:key`, `GET /admin/settings/:key/history`.
- Store layer (file + Supabase): `writeRuntimeSetting` (atomic compare-and-set + history), `recordRuntimeSettingAttempt`, `listRuntimeSettingHistory`; `setRuntimeSetting` kept (now versioned, optional `{requestId, redact, history}`); `getRuntimeSetting` returns `version`.
- `db/20261019_office_runtime_settings_versioning.sql` + rollback — `office_runtime_settings.version`, `office_runtime_setting_history` (append-only, RLS on), functions `office_runtime_setting_write` / `office_runtime_setting_record_attempt` (service_role only).
- UI: Security → "Settings registry" card (S1–S2 components): governed list, history drill-down, and a server-confirmed editor that renders only for generic writable entries.
- Small related changes: the autonomy route passes its request id to the store (route contract unchanged); the webhook-signature monitor writes with `history:false`; the S2 activity allowlist also accepts the audit layer's normalised names `staff.created` and `user.invited` (a latent S2 gap: those events are stored under the normalised name).

## Production registry (9 entries) and the honest limit
Delegated (read here, written only via their own routes): WhatsApp autonomy, Corporate Letterhead. Mirrors: webhook signature mode, outbox policy, Backend / Facility / Consumer / Edge bridge configuration. System: signature counters. **No new writable production key** was added because none has a verified consumer; the generic write path is complete and exercised through injected descriptors (`buildServer({ settingsRegistryExtras })`). The first real Office-owned key only needs a descriptor.

## Deployment order (compatibility)
Code and migration may land in either order. Without the migration: autonomy keeps working through the legacy upsert, generic/conditional writes return `503 settings_versioning_unavailable`, history reports `supported:false`, and the store re-probes the functions at most once a minute (no restart needed after the migration). Verified against real PostgREST.

## Known limitations
- Letterhead has no version/history (no column; existing contract kept).
- `office_runtime_settings` versions of rows written by the legacy path before the migration read as 1.
- Legacy callers (autonomy) remain last-write-wins by design; they are versioned and recorded but not conflict-checked.
- Full-suite browser tests need a local Chrome; Docker-based tests need the Supabase/PostgREST/Postgres images (skipped, not failed, when absent).

## Verification (this slice)
| Suite | Result |
|---|---|
| `test-settings-registry.js` (registry invariants, role × permission matrix, validation, versioning/409, 8-way race, audit + history, persistence round-trip, delegated autonomy, no-secret scan) | PASS |
| `test-settings-registry-postgres.js` (Postgres 16: migration preserves rows, idempotent, 10-way concurrent writers/creators, append-only, rollback; Supabase Postgres 17 + PostgREST + real `SupabaseLeadAgentsStore`: code-before-migration, re-probe, 8-way race across two clients, anon/authenticated refused at REST and SQL) | PASS |
| `test-settings-registry-browser.js` (registry card, editor validation, 409 panel, confirmation, history, permission-aware editors, mobile) | PASS |
| `test-settings-domain-browser.js` (S1–S2 acceptance, 14 scenarios) | PASS |
| WhatsApp autonomy control and store-UI, letterhead (Team/Settings/Audit) regressions | PASS (store-UI mock updated to model a database without the S3 functions) |
| Full Office regression (52 scripts; Postgres/cross-repo scripts run separately) | 52/52 PASS |
| check, lint, build, secrets, deployment gates | PASS |
Blocked/not run: nothing blocked locally. Not exercised: a real production Supabase project (by instruction), and the cross-repo autonomy script (needs the Backend checkout).
