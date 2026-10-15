# Settings S3 — Governed Registry & Persistence: frozen contract

Status: **frozen before implementation** (committed ahead of runtime changes). Starting point: branch `feature/settings-s1-s2` @ `0cc912e4e2bcbb66e1fd5bd4a404290508eea0d6`. Nothing here is merged or deployed; production is not migrated.

## 1. Existing contracts that stay authoritative (not duplicated)
| Contract | Authority | S3 rule |
|---|---|---|
| WhatsApp autonomy | `GET/PUT /admin/settings/whatsapp-autonomy`; `office_runtime_settings` key `whatsapp_autonomous_responses_enabled`; `readWhatsAppAutonomySetting` (fail-closed); Backend/Office enforcement via `evaluateAutonomousWhatsAppPolicy` | Registry entry is **delegated**: readable through the registry, **not writable** through it (`405 use_dedicated_endpoint`). Default stays OFF. The existing route is unchanged except that it passes the request id to the store |
| Corporate Letterhead | `GET/PATCH /admin/letterhead-config`; `letterhead_config` table; audit `office_letterhead_config_updated` | Registry entry is **delegated** and read-only through the registry. No version/history (no column exists); reported as `version: null`, `history_supported: false` |
| Webhook signature mode | Render env `WHATSAPP_WEBHOOK_SIGNATURE_MODE`, `/healthz` | **mirror**, never writable |
| Signature counters | `whatsapp_webhook_signature_stats`, written by the webhook monitor | **system**, read-only |
| Outbox policy | `config.communicationOutbox` | **mirror** |
| Backend / Facility / Consumer / Edge | Their own systems; env bridge configuration | **mirror** (configuration-only booleans), never writable from Office |
| Audit | `appendAuditRecord` → `audit_events` | Reused for every attempt; no second audit store |
| Persistence | `office_runtime_settings` (file store: `runtime_settings`) | Extended in place (version column); no parallel table for values |

## 2. Registry schema (code-defined, `src/lead-agents/settings-registry.js`)
Descriptor fields: `key`, `label`, `description`, `type` (`boolean|string|integer|enum|object`), `default`, `scope` (`global`), `owner` (`office|backend|facility|consumer|edge|platform`), `mode` (`generic|delegated|mirror|system`), `read_permission`, `write_permission` (null unless `generic`), `validator(value) → {ok, value|error}`, `sensitive`, `requires_confirmation`, `audit_action`, `storage` (`runtime_settings|letterhead_config|environment|derived`), `delegated_route` (delegated only).
Invariants enforced at registry construction (throws on violation): unique keys; `generic` ⇒ `owner==="office"`, `storage==="runtime_settings"`, a `write_permission`, a validator and an `audit_action`; non-generic ⇒ no `write_permission`; `sensitive` values are never returned or stored in history in clear. Unknown keys are rejected everywhere (`404 unknown_setting`).
Production registry (this slice): autonomy (delegated), letterhead (delegated), webhook signature mode (mirror), signature stats (system), outbox policy (mirror), Backend/Facility/Consumer/Edge bridge configuration (mirrors). **No new writable production key is added**: no verified consumer exists for one, so enabling it would create a control without a contract. The generic write path is complete and tested through injected descriptors (`buildServer({ settingsRegistryExtras })`, a test seam) so the first real Office-owned key (S6) only needs a descriptor.

## 3. Ownership and permissions
Office writes only `owner==="office"` settings and only in `generic` mode. Everything else is read-only here. Read gate = the descriptor's `read_permission`; list endpoint requires `office.read` and filters entries by each `read_permission`. Write gate = `write_permission`. API-key (service) sessions have no actor identity and are refused for writes (`403 actor_identity_required`), even though `authorizePermission` lets API keys through.
| Key | Read | Write |
|---|---|---|
| whatsapp_autonomous_responses_enabled | integrations.read | via dedicated route: integrations.manage |
| office_letterhead_config | office.read | via dedicated route: settings.manage |
| whatsapp_webhook_signature_mode | integrations.read | none |
| whatsapp_webhook_signature_stats | integrations.manage | none |
| communication_outbox_settings | integrations.manage | none |
| mirror.backend / facility / consumer / edge | integrations.read | none |

## 4. API (existing Office conventions: `/api/lead-agents/admin/...`, JSON, `x-request-id`)
- `GET /admin/settings` → `{ settings: [descriptor+value+version+updated_by/at+editable+edit_via] }` (only entries the caller may read).
- `GET /admin/settings/:key` → `{ setting }` (404 unknown, 403 no read permission).
- `PUT /admin/settings/:key` body `{ value, expected_version, confirm?, reason? }` — order of checks: identity (403) → known key (404) → mode (delegated 405 with `route`; mirror/system 403 `read_only_setting`) → permission (403) → body shape (400) → `expected_version` integer ≥ 0 (400 `expected_version_required`) → validator (400 `invalid_value`) → `confirm===true` when `requires_confirmation` (400 `confirmation_required`) → atomic compare-and-set (409 `version_conflict` with the current stored value/version) → re-read → `200 { setting, changed }`. Persistence failure → `503 setting_not_saved`, nothing changed.
- `GET /admin/settings/:key/history?limit=` (≤200, default 50), newest first.
- Reserved legacy path `/admin/settings/whatsapp-autonomy` keeps matching first; registry keys use underscores and cannot collide.

## 5. Versioning
`version` = number of successful writes to the key. No row ⇒ `version: 0` (default value in use). Writes require `expected_version`; mismatch ⇒ 409. Existing rows become version 1 on migration (value, `updated_by`, `updated_at` untouched). Legacy writers (`setRuntimeSetting`, used by autonomy) keep last-write-wins semantics but still bump the version and record history. Atomicity: Postgres function `office_runtime_setting_write` performs compare-and-set and history insert in one transaction; the file store does it in one synchronous section.

## 6. Audit / history
Every attempt writes `audit_events` (`appendAuditRecord`, status success/failure, metadata: key, outcome, versions, request id, **non-secret** old/new values) and, where a key resolves, a history row: `setting_key, version, previous_value, new_value, actor, request_id, outcome (success|conflict|rejected|denied|failed), reason, created_at`. `sensitive` descriptors store and return `"[redacted]"` (and `{configured:true}` for values). History is append-only (trigger rejects UPDATE/DELETE). Unknown-key and identity failures are audited without a history row (no key to attach to).

## 7. Failure handling
Store/transport error → 503, value unchanged, failure audited. History write failure for legacy `setRuntimeSetting` callers must not block the autonomy change (logged); for generic writes history is atomic with the value. **Pre-migration compatibility:** if the version column / functions are absent the store falls back to today's behaviour for autonomy; generic writes return `503 settings_versioning_unavailable`; history returns `supported:false`. So code can be deployed before or after the migration.

## 8. Migration and rollback
`db/20261019_office_runtime_settings_versioning.sql` (additive, idempotent): `alter table office_runtime_settings add column if not exists version integer not null default 1`; `office_runtime_setting_history` (+ index, RLS on, append-only trigger); functions `office_runtime_setting_write` and `office_runtime_setting_record_attempt`; `revoke all` from `public/anon/authenticated`, `grant` to `service_role` (role-existence guarded so the file also loads on plain Postgres). Rollback `db/rollback/20261019_office_runtime_settings_versioning.down.sql`: drops functions, trigger, history table and the version column; existing keys and values are untouched (version numbers and history are lost by design). Tested on isolated Docker Postgres 16 and Supabase Postgres 17 + PostgREST fixtures, including a pre-existing row. **Production is not migrated in S3.**

## 9. Security constraints
No secret values in any response, history or log; no reveal controls; no AI-provider activation; no device execution; signature enforcement and the autonomy default untouched; no anonymous/authenticated database privileges on the new table or functions.

## 10. UI contract
Reuse S1–S2 components. A "Settings registry" card on Security lists entries (owner, mode, version, last change) with a history drill-down. A generic editor (`stRegistryEditor`) renders only for `mode: generic` entries the user may write; it shows loading, inline validation errors, permission denial, server-confirmed saved value and a 409 conflict panel (reload current value). No editor exists for delegated, mirror or system entries, and none exists in production data until a generic descriptor exists.
