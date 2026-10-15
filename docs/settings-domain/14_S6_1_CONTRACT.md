# Settings S6.1 — Organization document brand configuration: frozen contract

Frozen and committed **before** runtime changes. Baseline `e8e9f74`. Not merged, not deployed, no production migration, S6.2 not started. Implements the owner-approved S6 plan decisions 1–5 and 9 (locale, timezone, currency and letterhead validation are excluded).

## 1. Setting
| Field | Value |
|---|---|
| key | `office_document_brand_name` |
| owner / scope / type | `office` / `global` / `string` |
| mode / storage | `generic` (writable through the S3 registry) / `office_runtime_settings` (no other store) |
| read / write permission | `office.read` / `settings.manage` |
| default | the existing configured document brand name (`OFFICE_DOCUMENT_BRAND_NAME`), otherwise `OCHIGA OFFICE` |
| sensitive / requires_confirmation | no / no (decision 2: new documents only; no extra dialog) |
| audit_action | `office_document_brand_name_changed` |
| edit location | Settings → Organization (`edit_section: "organization"`); the Security registry card shows it read-only with a link |

## 2. Validation (server-authoritative; the UI repeats it only for immediate feedback)
Trimmed string, 1–60 characters. Allowed: Unicode letters, numbers, space, `&`, `.`, `,`, `'` (ASCII apostrophe), `(`, `)`, `-`. Rejected: control characters, angle brackets, quotes, slashes, semicolons and everything else outside the set. No secret value is introduced.

## 3. Governed persistence (S3, unchanged)
Authenticated human administrator (API keys are refused: `actor_identity_required`); `settings.manage`; `expected_version` required (0 = never saved); validator; atomic compare-and-set with history in one transaction; 409 `version_conflict` with the current value; the response returns the **server-confirmed stored value**. No new table, route, or settings store.

## 4. Operational consumer
Both existing document-generation paths in `POST /admin/documents/generate`: the structural templates (`renderDocumentFromTemplate`) and the default `documentHtml`. A small resolver (`src/lead-agents/document-brand.js`) reads the effective brand name **at generation time**:
- stored, valid value → used (source `stored`, with its version);
- no row → the environment default (source `default`);
- stored value unreadable or no longer valid → the environment fallback (source `environment_fallback`) with a safe structured log line (reason only, never the value) and the condition recorded on the document's metadata (`brand_name_source`, `brand_setting_version`). A fallback never fabricates a successful persistence and never fails document generation.
The brand name is **HTML-escaped at both insertion points**. `documentHtml` currently interpolates it unescaped (safe only while it came from the environment), so it gains escaping in this change; template output was already escaped.

## 5. Document rendering behaviour
Documents are stored as HTML snapshots when generated, so a change affects **new documents only**; existing snapshots, shared links and letterhead snapshots are untouched. Legal entity names, contract text and the letterhead master config are not modified.

## 6. Audit
Every attempt follows the S3 contract (`audit_events` plus the append-only history): actor, request ID, previous and new value, version, timestamp, outcome (`success`, `conflict`, `rejected`, `denied`, `failed`). The Recent Activity feed gains the event `office_document_brand_name_changed` ("Document brand name changed", old → new).

## 7. UI
Organization → "Company profile" card (S3 components): current value, editable field for users with `settings.manage`, live document-header preview, inline validation, save state, 409 handling with "Load current value", server-confirmed result. Read-only presentation for users without write permission. Security registry card: read-only row with a link to Organization, no second editor.

## 8. Migration dependency
No database change in S6.1. **Saving requires the S3 migration `20261019_office_runtime_settings_versioning.sql` on the target database.** It has not been applied to production and is not applied here. Without it a save returns `503 settings_versioning_unavailable` (nothing changes), reads and document generation fall back to the environment default, so code may ship before or after the migration.

## 9. Exclusions
Locale, timezone, currency, letterhead `PATCH` contract and validation, WhatsApp autonomy, Backend provider-status integration, AI-provider activation, any production database change.

## 10. Regression requirements
Registry descriptor; validation boundaries; permissions matrix; version conflicts; concurrent updates; restart persistence; audit history; document-generation round trip; HTML escaping (including a value that bypasses the validator); environment fallback; existing-document preservation; Organization browser UI incl. mobile; Security registry read-only presentation; S3 Postgres suite; S1–S5 browser acceptance; WhatsApp autonomy; letterhead; full Office regression; repository gates.
