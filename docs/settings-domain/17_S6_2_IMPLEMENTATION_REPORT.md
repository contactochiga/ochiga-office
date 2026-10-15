# Settings S6.2 — Governed document locale: implementation report

Contract `16_S6_2_CONTRACT.md` was frozen and committed first (`22851cc`, baseline `e6442c4`). Not merged, not deployed, no production migration, S7 not started.

## Delivered
- **Registry:** `office_document_locale` (`office`, `global`, `enum` `en-NG`/`en-GB`/`en-US`, default `en-NG`, generic, `runtime_settings`; read `office.read`, write `settings.manage`; audit action `office_document_locale_changed`; `edit_section: organization`). Exact, case-sensitive enum validation; the registry exposes the three choices to the UI.
- **Persistence:** the existing S3 API and table only (expected version, atomic compare-and-set, history, 409, server-confirmed value).
- **Consumer** (`src/lead-agents/document-locale.js`): one `formatDocumentDate(date, locale, style)` used by the two document-date sites: `today()` in the structural templates (long form, four call sites) and the `documentHtml` header (short form). For `en-NG` the output is byte-for-byte the previous output. Resolved once per generation request next to the S6.1 brand; unreadable or invalid stored value → `en-NG` with a safe log line (reason only, never the value).
- **Provenance on every new document:** `metadata.document_locale`, `document_locale_source` (`stored`/`default`/`fallback`), `document_locale_version`.
- **UI:** Organization → "Document locale" card beneath "Company profile": current locale and version, a select limited to the three supported locales, a live preview of today's date in short and long form, server-confirmed save, 409 panel with "Load current value", read-only presentation without write permission. Security registry shows it read-only with a link; Recent Activity lists "Document locale changed" (old → new). Refused or conflicting attempts in that feed are now worded "Not applied: …" instead of "… changed" (a wording defect found while testing).

## Audit of formatting sites (what was and was not changed)
Changed: the two document-date sites above. Not changed: money amounts in `documentHtml` (`en-NG` grouping, `NGN`), `commercial.js` and `office-data.js` currency, `scheduling.js` meeting-time display (`Intl` with time zones), stored ISO timestamps, the letterhead renderer (prints no generation date), and browser UI date helpers.

## Evidence and tests
`s6-2-evidence/`: preview, saved state, Security registry at 1440; Document locale at 390.
| Suite | Result |
|---|---|
| `test-settings-document-locale.js` (all three locales through both document paths, 11 unsupported values over HTTP and 21 in unit tests, permissions, 409, 8-way race, restart persistence, history/audit, existing documents byte-identical, fallback for invalid/unreadable values, metadata provenance, amounts/scheduling/timestamps/brand/letterhead/autonomy unchanged, brand and locale together) | PASS |
| `test-settings-locale-browser.js` (7 scenarios: placement, three choices, live preview, Save gating, save/reload/round trip, conflict, forged values, Security registry, activity, responsive) | PASS |
| S3 Postgres/PostgREST suite | PASS |
| Full Office regression (61 scripts incl. S6.1 brand, S1–S5 browser suites, autonomy, letterhead, S5 integration acceptance; Postgres/cross-repo run separately) | 61/61 PASS on the final run |
| Repository gates (check, lint, build, secrets, deployment) | PASS |
Provider-browser intermittent failure: `18_PROVIDERS_BROWSER_FLAKE_INVESTIGATION.md`.

## Known limitations
`en-NG` and `en-GB` format dates identically in both styles (Intl behaviour); the setting still records which was chosen. The preview uses the staff browser's ICU; documents use the server's. Only the generation date on documents is localised: numbers, currency, time zones and meeting times are deliberately untouched. Saving requires the S3 migration on the target database (not applied to production).
