# Intelligent Product Import V1 — local engineering review

Update: actual residential/commercial workbook extraction was subsequently corrected and verified at 12/12 and 15/15. See [REAL-WORKBOOK-CORRECTION.md](REAL-WORKBOOK-CORRECTION.md) for current evidence and manual retest instructions. The original validation and pending-workbook statements below describe the initial feature review, not the corrected acceptance result.

Date: 28 October 2026. Branch: `codex/intelligent-product-import-v1`.
Worktree: `/Users/ochigaidoko/getoyi-work/office-product-import`.
Baseline: reviewed Phase 3 Office `2cb6c76`. This branch deliberately excludes the separate Phase 4 financial work.

**GO for local user review. NO-GO for production release or declaring the real Residential Smart Home workbook accepted until its manual test is complete.**

## Architecture audit and reuse

| Existing file/path | Reused responsibility |
| --- | --- |
| `src/lead-agents/catalogue.js` | Staff-session permission enforcement, canonical content validation, variant/SKU shape, incomplete-gallery drafts |
| `src/lead-agents/catalogue-store.js` | Existing file-store/Supabase catalogue, `catalogue_create_product` RPC; one new exact-SKU lookup method per adapter |
| `db/20261102_catalogue_foundation.sql` and reviewed follow-ups | Draft/product/variant creation, integer-kobo pricing, immutable version 1, uniqueness, second-person review, publication controls; unchanged |
| `src/lead-agents/storage.js` | Existing local/private Supabase storage driver and `putBuffer`/`getObject`; unchanged |
| `store-file.js`, `store-supabase.js` | Existing `office_files` and Documents registry methods; unchanged |
| `src/lead-agents/audit.js` | Existing audit records; source hash, document ID, row addresses, version and reviewed-file reference, no supplier amounts |
| `public/office/catalogue/catalogue.mjs` | Existing Products route, UI tokens, session API, manual creation dialog and product editor |
| `src/lead-agents/server.js` | Narrow static import-module route and private-file protection added; shell/navigation unchanged |

No new product database, migration, general-purpose AI runtime, Oyi Core extension, document editor, gallery pipeline or price workflow was added.

## Feature files

- `product-import-extract.js`: isolated worker adapter for XLSX/CSV to source-addressed tables, then normalized candidates. This table interface is the extension point for future PDF/Word adapters. V1 is deterministic header-based extraction, not a general document reasoning system.
- `catalogue-import.js`: upload/preview/private evidence/draft-selection API under the existing catalogue handler.
- `public/office/catalogue/import.mjs`: file selection, automatic extraction, detected mapping, candidate selection, editable names/descriptions/category/brand/model/specification rows and variant/SKU/options rows, source references, duplicate warnings and explicit draft confirmation.
- `scripts/product-import-local.js`: loopback-only standalone manual test environment, separate persistent file store and synthetic identities, no production environment files, blocked non-loopback HTTP/fetch.
- `scripts/test-product-import.js`: extraction and real authenticated Office HTTP tests.
- `scripts/test-product-import-postgres.js`: separate disposable PGlite PostgreSQL applying the reviewed catalogue migrations and exercising the authoritative creation/approval/immutability boundary. It does not use Docker or the Phase 4 services.

## API and permissions

| Action | Required authorization | Effects |
| --- | --- | --- |
| POST `/catalogue/imports?name=...` | Staff session, `catalogue.read`, `catalogue.write`; `catalogue.cost.read` if supplier data detected | Private source and extracted evidence stored; safe Documents index and preview audit. No catalogue products created |
| GET `/catalogue/imports/:id` | Same permissions, original uploader only; cost permission rechecked | Rebuild preview with current exact-SKU matches; no catalogue writes |
| POST `/catalogue/imports/:id/drafts` | Same authorization plus `confirm_drafts_only: true`, nonempty selected candidate IDs | Revalidate every selected draft and taxonomy; persist reviewed evidence; invoke existing create-product operation and audit each outcome |

No new grants. Importer has no review, price-approval, inventory, publish or public-publish powers. Even a privileged caller cannot request those actions through this import endpoint.

Source, extracted candidate and reviewed-payload objects use the existing storage service with the `catalogue_import_` prefix. Generic Storage reads and document-share reads reject this prefix. Documents holds a safe index only: title, owner, source digest and candidate count; no source rows, supplier amounts, file share URL or public token. Private preview is bound to its uploading staff identity. Files containing supplier information require cost-read permission rather than silently discarding or leaking that information.

Source prices retain their original labels/text as **unapproved references**. Numeric conversion to NGN kobo occurs only with explicit NGN/₦ identification. A range or unspecified currency is not guessed. Supplier costs are retained as restricted source evidence, not inserted into authoritative cost records. Every imported variant starts with null selling price/VAT, zero physical stock and the existing catalogue's default sourcing state. No image URL is fetched; galleries remain empty and can be completed through existing media tools.

## Validation evidence

| Suite | Result |
| --- | --- |
| Import extraction and authenticated HTTP | **33/33 PASS** |
| Disposable embedded PostgreSQL | **10/10 PASS** |
| Existing catalogue model | **56/56 PASS** |
| Existing full catalogue HTTP/media/public-preview/approval suite | **104/104 PASS** |
| Existing catalogue browser suite | **PASS**, including manual creation and mobile gallery |
| Existing Documents Workspace suite | **PASS**, sections A–M |
| Repository check, lint, build, diff whitespace checks | **PASS** |
| npm production dependency audit | **0 reported vulnerabilities** at review time |

Import tests cover twelve explicitly synthetic XLSX candidates; names/SKUs/source row addresses; CSV quoting and multiline descriptions; delimiter selection; explicit NGN arithmetic; unspecified currency; ignored formula caches; grouped variants; corrupted/oversized/active workbooks and expanded ZIP limits; no products during preview; missing supplier/media warnings; uploader isolation; generic storage denial; cost permissions; malformed/missing confirmation; duplicates within the selection and the catalogue; retry/concurrent submissions; authoritative draft/version/audit records; null prices and unchanged stock/costs; manual creation and denied publication; external-network denial.

The embedded PostgreSQL test exercises the existing SQL migrations/RPCs directly, including rollback of a duplicate-SKU insertion, immutable-version rejection, self-approval rejection and anonymous/authenticated role denial. It is not a live Supabase/PostgREST deployment test. File-store HTTP tests and PostgreSQL RPC tests are separate layers of evidence.

Browser rehearsal on a separate disposable instance at port 4388:

1. Opened Products with both manual creation and Import Products visible.
2. Chose synthetic XLSX through the real file chooser; automatic extraction returned twelve candidates.
3. Edited the first product name and selected only that candidate.
4. Verified Save refuses until the explicit confirmation checkbox is checked.
5. Saved one draft; inspected the local persisted version, null price and import audit event.
6. Re-uploaded the synthetic workbook and verified the existing SKU warning.
7. Verified the review at desktop and 390px width; document scroll width was 390px (no horizontal overflow).

Screenshots: `outputs/import-review/desktop-preview.jpg` and `mobile-preview.jpg` (synthetic data; uncommitted evidence).

## User walkthrough and pending acceptance

The user's actual Residential Smart Home workbook has **not** been read, uploaded or imported by automation. Its twelve-product acceptance result is pending the user's manual test.

The user instance is separate at `http://127.0.0.1:4387/office/#/catalogue`, initially with zero products and zero imports. Its synthetic importer is `importer@import.test`; password is stored only in ignored `outputs/product-import-local/login.json`. The browser is opened for the user. No production session or credentials are required.

1. Click **Import products** alongside **Add product manually**.
2. Choose the XLSX on the Mac. Extraction begins automatically; it creates no products.
3. Confirm the candidate count, source sheet/row and field mappings. Review names, categories, SKUs, specifications, source prices and missing-data warnings.
4. Correct fields and resolve duplicate/missing SKUs or unmatched categories. Existing categories/brands are used; new ones are not invented.
5. Select only the candidates to create, tick the explicit draft-only confirmation, then click **Create selected drafts**.
6. Open each resulting draft in the existing product editor. Prices still require their existing workflow; images can be added later; no approval or public release occurs.

If the workbook is not recognized as twelve products, stop at preview and report its detected mapping/count. Do not treat the synthetic fixture result as acceptance of that workbook.

## Known V1 limits and release requirements

- XLSX and UTF-8 CSV only; header aliases detect tabular catalogues. PDF, Word, OCR, arbitrary narrative layouts, macros, embedded object interpretation and remote image downloads are not supported.
- At most 5 MB compressed input, 24 MB expanded XLSX, 2,000 total rows, 100 columns, 12 sheets and 250 candidates; 15-second worker timeout, two simultaneous parser workers, 128 MB worker JS heap limit.
- Formulas/cached formula results are ignored and reported. Numeric SKUs warn about lost leading-zero formatting. Blank/missing values are never invented. Long specification values may need staff splitting to meet the existing catalogue's 400-character per-value limit.
- Variants group by an explicit product/group ID or exact product name/model within one sheet. Ambiguous grouping must be reviewed.
- Price references and supplier details remain in private evidence, not authoritative pricing/cost tables. Unmatched manufacturer names remain source references until mapped to an existing brand.
- Exact SKU lookups cover the catalogue. Possible name/model matches are exact normalized suggestions over the latest 500 products, not fuzzy global deduplication.
- Individual products are created atomically by the existing catalogue RPC. Bulk creation is not one transaction. A failure returns explicit per-row results and stops further processing. Unique SKUs/slugs prevent blind duplicate retries; there is no cross-batch overwrite/update mode.
- Reviewed evidence is persisted before creation. An audit failure after a product commit is surfaced as `draft_created_audit_failed` with the product ID; stop for investigation instead of retrying. This follows the existing create/audit boundary rather than introducing a second transaction system.
- Uploaded evidence persists in existing private storage for traceability. V1 has no import-history UI, retention scheduler or automatic source cleanup. Do not remove referenced evidence during review. Re-uploading refreshes duplicate detection; GET preview exists for a known source ID.
- Rehearsal uses local file storage and disposable PostgreSQL, not live Supabase Storage, Vercel request proxy or Render resource timing. Those require a separate release review.
- Integrate this additive feature onto the then-current Office release branch after review; do not deploy the older branch baseline over Phase 4 work.

## Rollback and cleanup

No schema migration or production rollback is needed. Revert the feature commit to remove the import UI/routes while preserving existing product records and their normal catalogue history. Retain private source/review objects and Documents/audit references. Never delete imported products to roll back the UI.

Stop only this feature's localhost Node process(es). Runtime and synthetic browser data live exclusively under this worktree's ignored `outputs/` and temporary test directories. After user review, archive those files or remove only the explicitly disposable test directories. Do not touch any Phase 4 worktree, Docker container/network, ledger, credentials, database or S7 resource.

Run again: `npm run office:import:test`; start manual review: `npm run office:import:local` from the clean import worktree. The launcher refuses local environment files and strips inherited integration configuration before loading Office.
