# Settings S6.2 — Governed document locale: frozen contract

Frozen and committed **before** runtime changes. Baseline `e6442c4` (S6.1). Not merged, not deployed, no production migration, S7 not started.

## 1. Audit of date and number formatting (what is and is not a document-presentation consumer)
| Site | What it formats | Class | S6.2 |
|---|---|---|---|
| `office-document-templates.js` `today()` (4 call sites: letterhead, cover letter, memo, proposal) | the generation date, long form (`15 October 2026`) | **document presentation** | uses the effective locale |
| `server.js` `documentHtml` header line | the generation date, short form (`15/10/2026`) | **document presentation** | uses the effective locale |
| `server.js` `documentHtml` amount cells (`amount.toLocaleString("en-NG")`, two sites) | money amounts | currency/number presentation | **unchanged** (explicit exclusion) |
| `commercial.js` USD/NGN quotes | currency, FX constant | business calculation / currency | unchanged |
| `office-data.js` `NGN …` | currency | currency | unchanged |
| `scheduling.js` `Intl.DateTimeFormat("en-US", timeZone…)` | meeting times and timezone display | scheduling | unchanged |
| `created_at` and other stored timestamps (ISO-8601) | canonical timestamps | database | unchanged |
| Browser UI date helpers (`fmtDate`, `toLocale…(undefined)`) | staff UI | UI presentation, not documents | unchanged |
The letterhead document renderer (`renderLetterheadHtml`) prints no generation date; existing letterhead snapshots are untouched.

## 2. Setting
| Field | Value |
|---|---|
| key | `office_document_locale` |
| owner / scope / type | `office` / `global` / `enum` |
| mode / storage | `generic` (S3 registry) / `office_runtime_settings` (no other store) |
| supported values | `en-NG`, `en-GB`, `en-US` (exact, case-sensitive match) |
| default | `en-NG` |
| read / write permission | `office.read` / `settings.manage` |
| sensitive / requires_confirmation | no / no |
| audit_action | `office_document_locale_changed` |
| edit location | Settings → Organization, beneath Document brand name (`edit_section: "organization"`); Security registry shows it read-only with a link |

## 3. Validation
Server-authoritative enum: the value must be exactly one of the three codes. Anything else (`fr-FR`, `en-AU`, `en_NG`, `EN-NG`, `en`, empty, padded, non-strings, injection strings) is rejected with `400 invalid_value`. No free-text locale is ever accepted.

## 4. Versioning, persistence, audit (S3, unchanged)
Authenticated human administrator; `settings.manage`; `expected_version` required; atomic compare-and-set with history; `409 version_conflict` with the current value; the response is the server-confirmed stored value. Every attempt audits under `office_document_locale_changed` with actor, request ID, previous and new value, version, timestamp and outcome. Recent Activity gains "Document locale changed".

## 5. Document consumer behaviour
Newly generated documents format the **display date** with the effective locale: long form in the template documents, short form in the default document. Both go through one function (`formatDocumentDate`), which for `en-NG` reproduces today's output exactly. The effective locale is resolved once per generation request, together with the brand name. Existing document snapshots, shared links and the letterhead snapshots are never re-rendered. Canonical timestamps, scheduling timezone and meeting times, currency formatting, financial calculations and legal entity information are not touched.

## 6. Fallback behaviour
Stored valid value → source `stored`; no stored row → `en-NG`, source `default`; unreadable or invalid stored value → safe `en-NG`, source `fallback`, with a structured log line (reason only, never the value). Generation never fails and persistence is never faked.

## 7. Provenance on every new document
`metadata.document_locale` (the effective locale), `metadata.document_locale_source` (`stored` | `default` | `fallback`) and `metadata.document_locale_version` (setting version or null), alongside the S6.1 brand fields.

## 8. UI
Organization → "Document locale" card directly beneath "Company profile": current locale and version, a select limited to the three supported locales (taken from the registry entry), a live preview of today's date in short and long form for the selected locale, inline state, server-confirmed save, 409 panel with "Load current value", read-only presentation without write permission. No second editor in the Security registry.

## 9. Migration dependency
No database change. Saving requires the S3 migration `20261019_office_runtime_settings_versioning.sql` on the target database (not applied to production, not applied here). Without it a save returns `503` with nothing changed; document generation uses `en-NG`.

## 10. Exclusions and regression requirements
Out of scope: timezone, currency, meeting times, financial calculations, legal entities, letterhead contract, WhatsApp autonomy, Backend provider status, provider activation. Required: all three locales; unsupported-locale rejection; permissions; conflicts; concurrent writes; restart persistence; document round trips; existing-document preservation; fallback; metadata provenance; Organization browser UI and responsive layouts; S3 Postgres suite; S6.1 brand tests; S1–S5 browser suites; WhatsApp autonomy; letterhead; full Office regression; repository gates. The intermittent provider-browser test is investigated and reported separately.
