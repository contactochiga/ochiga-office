# Settings S6.1 — Organization document brand configuration: implementation report

Contract `14_S6_1_CONTRACT.md` was frozen and committed first (`6c5d8fa`, baseline `e8e9f74`). Not merged, not deployed, no production migration, S6.2 not started.

## Delivered
- **Registry descriptor** `office_document_brand_name` (`office`, `global`, `string`, generic, `runtime_settings`; read `office.read`, write `settings.manage`; default = configured `OFFICE_DOCUMENT_BRAND_NAME` else `OCHIGA OFFICE`; not sensitive; no confirmation; audit action `office_document_brand_name_changed`; `edit_section: organization`). Validator in `src/lead-agents/document-brand.js` (trimmed, 1–60, Unicode letters/numbers, space and `& . , ' ( ) -`; control characters, angle brackets, quotes and everything else rejected).
- **Governed persistence:** the existing S3 API and `office_runtime_settings` only (expected version, atomic compare-and-set, history, 409, server-confirmed value). No new store, route or table.
- **Document consumer:** `POST /admin/documents/generate` resolves the effective brand once per request (`resolveDocumentBrandName`) and passes it to both paths (`renderDocumentFromTemplate` and `documentHtml`). Stored valid value → `stored`; no row → `default`; unreadable or no-longer-valid value → environment fallback with a safe log line (reason only) and `brand_name_source` / `brand_setting_version` recorded on the document's metadata. Generation never fails and persistence is never faked.
- **Escaping:** `documentHtml` previously interpolated the brand unescaped; it now uses the existing `escapeHtmlText`. Template output was already escaped.
- **UI:** Organization → "Company profile" card above the Letterhead (current value, version, editor for `settings.manage`, live document-header preview that escapes what it shows, inline validation that disables Save, save state, 409 panel with "Load current value", server-confirmed result). Security registry: read-only "Editable in Organization" row with a link and history drill-down, no second editor. Recent Activity: "Document brand name changed" with old → new.
- Unchanged: letterhead `PATCH` contract (a scheme-less website is still accepted), WhatsApp autonomy, Backend provider-status integration, provider activation, locale/timezone/currency.

## Migration dependency
No database change here. Saving requires the S3 migration `20261019_office_runtime_settings_versioning.sql` on the target database; it is **not applied to production**. Without it: a save returns `503 setting_not_saved`/versioning unavailable (verified against real PostgREST before the migration), reads and document generation use the environment default.

## Evidence and tests
`s6-1-evidence/`: Organization (invalid input, saved) and Security registry at 1440, Organization at 390.
| Suite | Result |
|---|---|
| `test-settings-document-brand.js` (descriptor, validation boundaries, permissions, versions, 8-way race, restart persistence, audit/history, round trip, escaping incl. validator bypass and hostile environment value, environment fallback, existing snapshots byte-identical, letterhead and autonomy unchanged) | PASS |
| `test-settings-organization-browser.js` (7 scenarios incl. conflict, forged request, Security registry, activity, mobile) | PASS |
| `test-settings-registry-postgres.js` incl. brand key on real Postgres/PostgREST (pre-migration behaviour, governed save, conflict, 6-way race, consumer reads stored value) | PASS |
| Full Office regression (59 scripts; Postgres/cross-repo run separately), repository gates | PASS on the final run except one intermittent browser-suite failure (below); gates PASS |

## Intermittent failures and what they were
- First full run after the UI work: `test-settings-domain-browser` and `test-settings-registry-browser` failed. **Real defects of mine**, fixed: (1) the shared editor's new live validation cleared server-side error text on refresh (regression, fixed so it only clears its own message); (2) two pre-existing test selectors became ambiguous once a second editor/preview sat on the Organization page (`.st-form-status`, `.st-preview`), now scoped to the letterhead form.
- Second full run: `test-settings-providers-browser` failed once (`timeout waiting for: route settings/intelligence`). Re-run alone it passed 7 of 9 runs; the failures happened only while stale headless Chrome processes from earlier runs were still alive or during a full-suite pass (CPU contention with its 8 s per-step wait). It passed 6/6 after cleaning the stale processes; its wait is now 15 s. Classified as an infrastructure/timing flake in the test, not a product defect. `test-wave9-authority-boundaries.js` (flaky under load earlier in this programme) passed in this run.

## Remaining limitations
Applies to new documents only (existing snapshots and shared links keep their header). Everything in the document header other than the brand name (legal entity, contract text, letterhead) is unchanged. Locale, timezone and currency remain out of scope (S6.2+).
