# Real-workbook import correction

28 October 2026 · `codex/intelligent-product-import-v1` · isolated import worktree.

**GO for another local manual upload/review. No production release approval.**

## Reproduced root cause

Before changing the parser, the original commercial workbook returned HTTP 422 `no_product_rows_detected` through the authenticated Office upload route. The XLSX decoder successfully read all three worksheets. Detection failed afterward: the narrow header dictionary did not recognize `Proposed listing title` as the required product-name field, nor the provisional SKU/subcategory/model/qualified specification headings. Therefore its valid product table was rejected. The endpoint discarded sheet diagnostics and the UI displayed only the generic error.

The original residential workbook also yielded zero candidates against the original extractor. It uses `Office Product Title`, `Internal SKU (proposed)`, `Category / Subcategory` and `Key specifications to verify`. This was the same detection defect, not a damaged workbook or first-sheet-only decoder.

## Correction

- Expanded normalized aliases for both original formats, including every requested commercial header. All worksheets are inspected; header candidates are scanned within the first 30 rows per sheet. Repeated page headers are excluded from candidates.
- Product names, SKUs, categories, separate manufacturer/model fields, specifications and row-addressed source notes survive extraction. Unrecognized columns are retained as source references rather than silently becoming technical claims.
- Residential `Brand / confirmed model` values contain qualifications such as OEM model TBD. Preserve the complete original text and warn for review; do not guess separate confirmed manufacturer/model values. The original workbook is never edited.
- `Public retail ₦`, retail benchmarks and even columns labelled approved/published price remain unapproved retail references. `Dealer landed cost ₦` and `Dealer quote ₦` remain restricted, unapproved supplier-cost references. Protected financial classifications cannot be changed into specifications through mapping.
- Ambiguous or unrecognized tables now return a reviewable preview with detected worksheets, header rows, headings and rejection reasons. Staff can explicitly choose worksheets/header rows and map fields. Draft creation is blocked while mapping is unresolved.
- Remapping rereads the hash-checked original private source, creates a new immutable preview linked to its predecessor and emits an audit event. Existing Documents, storage, catalogue validation, permission enforcement and creation paths are reused. Source ownership and supplier-cost permissions are rechecked.
- On narrow screens the draft confirmation panel stays in document flow so it does not cover candidate counts and fields.

## Original-file acceptance

| Original workbook | Product sheet | Authenticated upload HTTP | Browser file chooser |
| --- | --- | --- | --- |
| `getoyi_12_hardware_sourcing_catalogue.xlsx` | `12 SKU candidates` | 201, **12/12** | **12/12** |
| `GetOyi_Commercial_Facility_Hardware_15_Products.xlsx` | `Commercial Facility 15` | 201, **15/15** | **15/15** |

All three worksheets in each workbook were diagnosed. Photo-acquisition/checklist and sourcing-guide sheets were correctly excluded from product counts. Source-page URLs remain references, not downloaded gallery images. Missing images, absent/unverified supplier costs, unmatched taxonomy and unapproved prices are flagged.

Original SHA-256 digests, unchanged after tests:

- Residential: `20e5da2b6efc68ea8671fdaf51d805110a70997d8f94f843db13028a914f2544`
- Commercial: `87d254cd287dda7d30dfc1a80f8eb774353c64afdec4ceffe817804ae7ea2fb1`

No original workbook or source product values are committed. Runtime evidence is under ignored `outputs/import-correction/`.

## Current validation

| Check | Result |
| --- | --- |
| Actual-workbook and preview HTTP regressions | **25/25 PASS** |
| Existing extraction/security regressions, extraction-only mode | **12/12 PASS** |
| Existing pure catalogue model/permission matrix | **56/56 PASS** |
| Repository check / lint / build / diff whitespace | **PASS** |
| Browser original residential and commercial uploads | **PASS**, automatic extraction through normal UI |
| Browser commercial remapping | **PASS**, remains 15 candidates |
| Browser ambiguous-header recovery | **PASS**, review resolves one synthetic candidate; save hidden while ambiguous |
| Manual Add Product entry point | **PASS**, original form opens; cancelled without saving |

HTTP tests compare every candidate's identity, specification and source-reference text to the original cells. They verify protected price classification, uploader isolation, cost permission on unrecognized tables, invalid mapping rejection, original-preview preservation, excluded ambiguity and an unchanged catalogue before/after the entire test. Both the user instance and separate browser rehearsal instance retain zero products, zero product versions and zero import-creation audit events.

No `/drafts` request was made by the new HTTP suite; no browser confirmation/save was performed. Older creation/PostgreSQL/approval tests in REVIEW.md are prior evidence, **not rerun or claimed as current workbook creation acceptance**. The user's own draft-creation acceptance remains pending.

Repeat preview-only checks:

```sh
node scripts/test-product-import-real-preview.js
node scripts/test-product-import.js --extract-only
node scripts/test-catalogue-model.js
```

The real-workbook test accepts residential and commercial absolute paths as its first and second arguments. Defaults are the supplied Downloads paths. It uses a disposable local Office server and never creates products.

## Manual retest and limits

Local URL: `http://127.0.0.1:4387/office/#/catalogue/import`. Refresh after the corrected server restart; sign in again with the existing local importer if prompted. Local credentials remain in ignored `outputs/product-import-local/login.json` / `LOGIN.md`.

Upload each original XLSX unchanged. Expect 12 and 15 candidates respectively. Review category selections, original manufacturer/model references, specifications, SKUs and pricing warnings. Choose existing categories/brands where unmatched; nothing is invented. Only the user should select candidates and explicitly confirm draft creation.

V1 remains deterministic tabular extraction, not arbitrary document interpretation. It inspects all supported worksheets but limits header discovery to the first 30 rows, retains existing resource limits and does not merge photo-checklist sheets into galleries. Combined manufacturer/model references need human interpretation. No migration or new dependency was required. No payment, production, Claude worktree or S7 changes were made.

Rollback: revert this correction commit locally while retaining private source/preview/audit evidence. Stop only the import localhost processes. No database migration rollback is needed.
