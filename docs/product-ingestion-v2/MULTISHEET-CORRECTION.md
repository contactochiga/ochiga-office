# V2 multi-sheet correction — local owner acceptance

Baseline: `f2cdf25` / `ef8bbd9`, isolated `codex/intelligent-catalogue-ingestion-v2` worktree. Date: 28 October 2026 (Africa/Lagos). No production changes, pushes, deployments, new migrations, payment changes or changes to other worktrees.

## Reproduced failure and cause

Unchanged source: `/Users/ochigaidoko/Downloads/GetOyi_Hardware_Catalogue_V2_Research_Master.xlsx`.
SHA-256: `09078b97783964fc184b2090807fcd9fdf7031de79f058511342ff62e0d5ede1`.

The pre-correction worker returned exactly 100 candidates:

| Worksheet | Source rows | Previous behaviour | Corrected role |
|---|---:|---|---|
| PRODUCTS_IMPORT_V2 | 50 | 50 candidates | Product master |
| SPECIFICATIONS | 149 | Rejected: no product-name column | Specifications |
| PHOTO_REQUIREMENTS | 250 | Rejected: no product-name column | Images / requirements |
| VERIFICATION_QUEUE | 50 | 50 additional candidates | Verification / QA |
| READ_ME | 21 metadata rows | Rejected as non-product | Instructions / metadata |

`inspectTables` only required a product-name column and SKU/category/description/model. It therefore accepted QA rows containing Product and SKU. `candidatesFromTables` converted every accepted sheet's rows into products. There was no supporting-sheet reconciliation. Duplicate detection then saw two copies of each SKU. Category path, Brand / manufacturer and Structured specifications JSON also lacked dedicated V2 mappings. The previously accepted flat 50-row import workbook did not exercise these research-workbook relationships.

## Correction

`ingestion-sheets.js` adds deterministic role classification from table structure: product master, specifications, pricing, inventory, images, QA, metadata and unknown. Names/SKUs alone never establish a master. Detailed master sheets may carry references; dedicated long-form specification/photo/QA structures become supporting sheets. Mixed or insufficient structures require explicit staff role selection or exclusion. Multiple genuine master sheets remain supported.

V1's classifier and 250-product behaviour are unchanged. The V2 adapter recognizes the research headers and structured JSON. Attribute # is an ordinal, not the attribute key; Specification evidence is provenance, not a fabricated technical attribute.

Supporting rows join by exact SKU, or by a unique, non-placeholder manufacturer/model pair if no SKU is present. Names alone do not establish a join. Conflicting supporting identities do not replace master names, categories, brands or models. Unknown/ambiguous joins and conflicting values block job preparation until explicitly resolved through worksheet mapping, with a target/exclusion and reason. A genuine collision between master products remains a conflict. QA references to a master SKU are not duplicate products.

Matching specification key/value/unit tuples from master JSON and the supporting sheet merge into one attribute with both sources. Conflicting values remain explicit exceptions. Raw source text, worksheet, row, column, A1 cell and evidence/status columns are retained in the private extraction/review evidence. No units or missing specifications are invented. Image rows remain requirements/references; they create no media objects, cover images or downloads. Pricing, supplier costs, stock and QA statuses remain unapproved source evidence. Cost permissions also cover supplier-cost attributes in unmatched long-form support rows.

The review UI now shows all roles, 50 candidates, linked specification/image/QA counts, unmatched rows, actual conflicts and per-product supporting evidence. Shared mapping lets staff select a role, map columns and resolve supporting rows. No new catalogue or product persistence system was introduced.

## Checkpoint handling

New extractions carry `sheet_processing_version: 1`; candidate keys use physical worksheet position and source row so excluding another sheet cannot renumber them. Existing immutable receipts and manifests are retained. Pre-correction previews can be inspected but cannot prepare a new job; pre-correction jobs cannot resume execution. They return `ingestion_reextract_required`. Re-upload the original workbook for a corrected preview. Existing unique SKU/slug and durable receipt protections remain in force; no budgets, records or history were reset.

## Acceptance evidence

Authenticated upload/extract and browser UI, using the unchanged original workbook:

- Exactly **50** master candidates; **0** duplicates caused by supporting references.
- Exactly **149** linked structured specification rows and **149** unique key/value/unit attributes, retaining master JSON and supporting-cell provenance.
- Exactly **250** image requirements (five per product); zero uploaded images.
- Exactly **50** linked QA records (one per product).
- **0** unmatched support rows and **0** cross-sheet conflicts.
- Applying the UI worksheet-role review preserves all counts. A synthetic unmatched-row browser test disabled save, required an explicit target/reason, and then linked one attribute without creating a product.
- All original source identities and category paths retained. The original workbook hash is unchanged.
- No drafts created from the research workbook. The owner environment still contains only the two pre-existing labelled synthetic browser-test drafts, two receipts and two import events.

The browser's Ready count remains **0** because its isolated category/brand registry still requires review for these source identities; Category / brand review is 50, Duplicate / conflict is 0 and Missing / specification review is 0. No taxonomy or commercial facts were silently invented to inflate readiness.

New `test-ingestion-multisheet.js`: **21/21** assertion groups passed. It covers the actual workbook via authenticated HTTP; multiple master sheets with all support roles; exact SKU and confirmed manufacturer/model joining; unknown roles; explicit role/exclusion/row resolutions; master identity and specification conflicts; source/cost permissions; old preview and old job refusal; unchanged source and zero product creation.

Existing regressions rerun:

- V2 extraction/1,000-row recovery: 21/21; disposable SQL: 16/16; edge cases: 10/10.
- V1 original 12- and 15-row workbook preview/mapping: 25/25; V1 import: 33/33.
- Catalogue authenticated API/permissions/approval suite: 104/104; save-feedback suite: 10/10.
- Full `npm run validate:release`: PASS, including Office/CRM/Documents/storage/permissions and build/security checks.

Total: **240 targeted assertion groups**, plus the release suite. Synthetic persistence regressions use separate disposable stores; the new multi-sheet acceptance suite creates no products. The 1,000-row regression observed 150 ms extraction and 380 MB whole-harness peak RSS locally; this is not a production resource guarantee.

Screenshot: `outputs/ingestion-v2/multisheet-corrected.jpg` (local evidence, not committed).

## Owner retest and verdict

**GO for another local owner browser test.** Open `http://127.0.0.1:4388/office/#/catalogue/ingestion`, refresh, and upload the unchanged research workbook again. Do not resume its old 100-candidate checkpoint. Confirm the 50 / 149 / 250 / 50 counts, inspect source details and resolve genuine taxonomy/brand exceptions before manually selecting any drafts. The prepared browser uses the isolated synthetic importer account; production credentials are not needed.

Production release remains **NO-GO** pending the existing separate V2 release review, owner acceptance, migration/security review, multi-connection PostgreSQL race tests and production-equivalent load checks. This correction adds no schema migration. No public activation, checkout or payment work is included.
