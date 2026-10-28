# Intelligent Catalogue Ingestion V2 — local owner acceptance

Local implementation only. Owner acceptance: GO for controlled review. Production release: NO-GO pending the separate release gates below. No source-workbook products were created automatically. Only explicitly synthetic products were used in persistence tests.

## Baseline and isolation

Worktree: `/Users/ochigaidoko/getoyi-work/office-ingestion-v2`; branch `codex/intelligent-catalogue-ingestion-v2`. Starts at V1 production baseline `2304a3fdfdd80f8005266e7a986172f21fa1459b`, not the unfinished Phase 4 branch.

Read-only baseline checks found GitHub `codex/office-extraction`, Render live deployment `dep-dbgungq9lscs73955q3g`, and Vercel ready production deployment `dpl_2317bKWRE5G9tQkWWf62mc3WEv9C` on that baseline. No push, production migration, deployment, account change or production record mutation was performed. Payment worktrees, Docker environment, Paystack, wallets, checkout and S7 were not changed.

The existing local launcher refuses `.env` files, clears inherited service configuration and blocks non-loopback fetch/HTTP clients. It uses its own local storage and synthetic accounts; no production database credentials, external AI, notifications or public refresh endpoint are loaded. Port 4388 is separate from the V1 rehearsal on 4387.

## File-level audit and minimal extension

| Existing foundation | Reuse / extension |
|---|---|
| `product-import-extract.js` | Existing XLSX/CSV worker, all-sheet detection, source classifications and mapping validation retained. Opt-in V2 supports 1,000 candidates; V1 stays at 250. V2 merges variants only through an explicit source group identifier, avoiding accidental merging of separate products sharing names/models. |
| `catalogue-import.js` | Existing authentication, upload, Documents records, private source storage, source hash and owner/cost permission checks retained. Adds reviewed job and bounded execution endpoints. |
| `ingestion-evidence.js` (new) | Deterministic category/brand suggestions, structured specification attributes and cell-level provenance. No AI runtime or new taxonomy records. |
| `catalogue-ingestion.js` (new) | Exception groups, full-index duplicate checks, immutable reviewed manifests, create/skip/propose-update and resumable receipt-based progress. |
| `catalogue-store.js` | Same authoritative catalogue and create/version primitives. Adds atomic ingestion receipts and paged identity reads. Missing V2 schema fails closed for V2 without disabling V1 or manual creation. |
| `20261107_catalogue_ingestion_receipts.sql` (new, unapplied to production) | Additive receipt table, append-only protection, current-version identity index RPC and transactional wrapper around existing `catalogue_create_product`. No product, pricing, inventory, order or payment schema replacement. |
| `catalogue.mjs`, `import.mjs`, `ingestion.mjs` (new), `server.js` | Products-only navigation/asset extension. Shared editable worksheet/column mapping; existing V1 upload/save path and manual Add Product remain available. |

## Evidence rules

Category matching uses existing active records: normalized exact name/slug, reviewed aliases, deepest recognized path, and tightly limited contextual aliases. Shared taxonomy terms produce suggestions requiring confirmation. Electrical & Power Control remains ambiguous between two existing categories. Aliases are versioned code, not automatically learned or created.

Brand aliases resolve only to existing active brands. Model-family matches remain suggestions. Compatibility statements do not establish manufacturer identity; unconfirmed OEM/model placeholders do not become brands or duplicate identities. Incoming duplicate-model detection uses resolved brand identity across aliases. SKU conflicts, existing brand/model matches and incoming duplicates prevent blind creation. Name matches are review suggestions. Proposed updates are durable reviewed proposals linked to an existing product; they do **not** apply changes. Staff use the existing editor and approval workflow.

Specification parsing handles key/value text, explicit units, selected structured headers and unambiguous count/frequency fragments. Original source cells retain sheet, row, column, A1 coordinate, header and raw value. Ambiguous/qualified text is retained as labelled source attributes and flagged, not converted into asserted technical facts. Conflicting values remain in the evidence. The source file, extraction and reviewed manifest are private immutable storage objects; product import audit/receipt links lead back to that evidence. The existing product schema stores only its validated key/value/unit attributes.

Retail values and supplier costs remain restricted source references. The import creates no approved prices, costs, stock, compatibility certification, media downloads, approval or public release. Empty galleries are valid for draft creation. Unknown brands can remain unassigned after explicit exception review.

## Bounded persistence and authorization

- XLSX/CSV: 5 MB compressed, 24 MB expanded workbook limit, 12 sheets, 2,000 source rows, 100 columns, 1,000 V2 candidates. Existing worker: 128 MB, 15 seconds, two active parses.
- Review: 25 products per page; complete duplicate index in pages of 200, explicit 50,000-product cap. Selection persists across pages in memory. Job review payload is bounded to 2 MB.
- Save: explicit staff confirmation creates a private immutable manifest. Each HTTP run handles at most ten drafts. Pause completes the current batch. Reload only reads progress; execution resumes only by staff action. Unsaved field edits are not a checkpoint; reviewed manifests are.
- Receipt key: actor + original file SHA-256 + source candidate key. A payload hash rejects changed retries. Database transaction lock + existing unique SKU/slug constraints protect replay and races. Draft, receipt and import audit commit together. Lost responses stop execution; authoritative receipts recover progress without blindly recreating products. Different manifests claiming an existing receipt surface a conflict.
- Original references, reviewed decisions, failures and saved product IDs remain auditable. Browser local storage contains opaque checkpoint references only, not workbook contents or supplier costs.
- Local file-store queue is test-only, single-process. Production relies on PostgreSQL transactions/advisory locks, never an application-memory lock.

| Operation | Required boundary |
|---|---|
| Upload/extract, mapping, review, create job/run | Existing authenticated `catalogue.write` permission |
| Open source/preview/job | Same owner; cross-owner access denied |
| Cost-bearing workbook/preview/job | Existing `catalogue.cost.read`, including reload |
| Draft creation | Existing catalogue validation, active category/optional brand, unique SKU/slug and versioning |
| Approve price/product, publish, inventory changes | Not offered by V2; existing independent permissions and approval rules unchanged |
| Direct receipt/index SQL functions | `service_role` only, SECURITY INVOKER, pinned `public,pg_temp` search path; no PUBLIC/anon/authenticated execute |
| Receipt table | RLS/no public policies; existing history-style service grants; UPDATE/DELETE/TRUNCATE rejected by append-only triggers, including owner |

## Actual workbook findings

Source: `/Users/ochigaidoko/Downloads/GetOyi_50_Products_Office_Import_Only.xlsx`.
SHA-256: `5c638fa4072be739a02a2d6a10012ba71cf76ad166230539808981115e176f69`.

- **50/50 candidates** via the same authenticated upload/extract API and browser interface.
- **46 category assignments**, **4 explicit category-choice exceptions**, all referencing existing categories.
- **141 specification attributes**, with source evidence on all 50 products. All 50 include at least one qualified/unstructured specification requiring review. This is not a claim of 141 independently verified technical facts.
- Empty starting brand registry: no brands silently inserted. Source manufacturer/model values preserved; unresolved identities stay reviewable. Populated synthetic brand-registry tests verify aliases and model matching separately.
- All 50 have commercial-verification exceptions. Missing images/supplier information are flagged. No false duplicate caused by shared “Unconfirmed OEM”/“Model pending” placeholders.
- File hash unchanged. No source products created. The 12- and 15-product original formats still pass their V1 extraction/mapping regressions.

## Validation evidence

`npm run office:ingestion:test`: HTTP/extraction/restart suite (21), disposable PGlite SQL integrity suite (16), edge/authorization/mapping suite (10). Each assertion group passed. Includes 1,000 synthetic drafts, concurrent local requests, replay, lost-response recovery, explicit stopped-attempt audits, owner/cost denials, incoming/model duplicates, immutable proposals, missing optional migration and manual creation.

Existing targeted suites passed: V1 import (33), actual workbooks (25), save feedback (10), Stage 2 persistence (8), catalogue model (56), catalogue HTTP (104), media (25), media failures (8). Additional public-projection/signature suite (8) and V1 embedded PostgreSQL regression (10) passed. This is 334 targeted assertion groups in total, in addition to the release suite. `npm run validate:release` passed: lint, repository/security/build/deployment checks plus Office, CRM/intake, permissions, Documents/storage, operational workflows and Messages regressions. `npm audit` reported zero advisories.

Measured synthetic 1,000-row CSV extraction: 142 ms; peak whole-process RSS during the full file-store persistence harness: 409 MB in the latest run (earlier run: 147 ms / 397 MB). Synthetic 1,000-row XLSX extraction: 127 ms, 21,199-byte input. These are local fixture observations, not production SLA/capacity guarantees; later repeated run metrics are in the saved test evidence.

PGlite exercises actual SQL, migration replay, immutable histories, role denials, pinned function configuration and rollback on injected audit failure. **It serializes queries and does not establish multi-connection PostgreSQL contention behaviour.** The local HTTP concurrency tests likewise do not replace a production-shaped Postgres/PostgREST race test.

Browser rehearsal: original 50-row preview; 25-row pagination and group counts; synthetic ambiguous-header remapping with financial columns locked; safe page selection and clear; two separate synthetic drafts with visible completion links, checkpoint reload and canonical editor reopening. Original workbook products were not saved by automation. Screenshots are in `outputs/ingestion-v2/` (local only).

## Owner walkthrough

1. Open `http://127.0.0.1:4388/office/#/catalogue/ingestion`. A synthetic importer session is prepared. If sign-in is needed, use `importer@import.test` with the importer password in the local, ignored `outputs/product-import-local/login.json`; never use production credentials.
2. Choose the original 50-product XLSX and click **Extract & review**. Expect 50 total. Inspect the exception groups; they overlap and are not additive totals.
3. Expand **Edit fields, variants and attributes**. Review category explanation, manufacturer/model, individual specifications and **Original cells, references and parsing evidence**. For unfamiliar formats, use the shared worksheet/column-mapping panel without changing the workbook.
4. Select a small subset; use **Select this page for review** or **Select all ready records** only where appropriate. Review exceptions before marking them reviewed. Unknown category must be resolved to an existing active category; an unconfirmed brand can remain empty.
5. Choose **Create draft**, **Skip**, or **Propose update** against a detected existing product. Confirm drafts only and save. Progress and canonical product links appear. No prices or stock are approved.
6. To test recovery, pause after a batch, refresh, choose **Open last checkpoint**, inspect results, then explicitly resume. After a failure, inspect the checkpoint first; do not start a replacement job blindly.
7. Reopen a created draft in the existing editor, verify fields, and use the existing media gallery manually. Re-uploading the same source should reveal duplicate/conflict records; it must not overwrite products.
8. Products → Add product manually and the V1 import link remain available.

To start after a local restart: `node scripts/product-import-local.js 4388` from this isolated worktree. Stop only that process to tear down the local UI; retain its ignored output folder if owner evidence/checkpoints are still needed. Synthetic test suites use separate temporary directories and close their servers/databases.

## Migration, rollback and release gates

Candidate migration: `db/20261107_catalogue_ingestion_receipts.sql`.
SHA-256: `3ebd09127b9261573f19669ba44ee6e6f06ee18cccad303266e2f33e5df149f8`.
It was applied only inside disposable test databases. No production migration was run.

Rollback is application-first: disable/revert the V2 route and server extension to the V1 baseline; retain receipts, products, manifests and audit evidence. Revoke the new execution function if needed; do not drop used receipts or delete imported products/history. Disposable SQL tests show revoking execution preserves receipt/history data. Any future production rollback must be reviewed with the release's exact baseline and backups.

Remaining gates before production:

1. Owner accepts real-workbook review and manually selected draft creation/editing.
2. Separately authorize the additive migration and code release; recheck deployed baseline/ancestry and migration hash, existing schemas, ownership/grants/RLS and rollback backups.
3. Run multi-connection disposable PostgreSQL/PostgREST tests for simultaneous same-job/different-job saves, failure between draft/audit/receipt, and process interruption. Preserve append-only records and SKU uniqueness.
4. Measure 500/1,000-row ingestion and concurrent parser/load behaviour on production-equivalent resource limits; the local 409 MB harness is not Render Free certification. Validate worst-case bounded workbook handling and request timeouts. Tune within existing safety limits if needed.
5. Extend the reviewed production security gate for the narrowly named receipt table/functions; do not weaken previous catalogue/history checks.
6. Recheck live V1/manual/catalogue/CRM/media regressions after any separately authorized rollout. No automatic taxonomy creation, public activation or financial integration is part of this release.

Known limits: no PDF/Word extraction yet (shared evidence interface is extensible); no automatic internet lookup or supplier verification; no generated missing facts; no automatic application of update proposals; user-driven resumable batches rather than a background worker; no cross-user access to private import checkpoints. Qualified specifications and absent brand registries still require review.
