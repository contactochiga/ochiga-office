# Product Import V1 — Stage 2 owner acceptance preparation

28 October 2026 (Africa/Lagos). Extraction correction: `8f38583`.

**GO for the owner to create two local drafts. Actual two-product persistence/editing acceptance is pending those manual saves. No production release approval.**

The owner has accepted both original workbooks after two manual runs each: 12/12 residential and 15/15 commercial candidates. This stage does not reopen extraction acceptance.

## Owner environment and prepared rows

URL: `http://127.0.0.1:4387/office/#/catalogue/import`

Existing account: `importer@import.test`. The existing local password/instructions remain in ignored `outputs/product-import-local/LOGIN.md` and `login.json`. No credential or permission changes were made. The running launcher uses only its local file store and storage directory, clears inherited integration configuration, refuses environment files, and blocks non-loopback HTTP/fetch. No shared Docker environment or Phase 4 worktree is used.

Two browser tabs are prepared, one for each workbook. The owner had all twelve residential rows selected and had received `category_id must be a category id`; the catalogue remained empty. Preparation cleared the bulk selection and confirmation, refreshed the residential preview, and selected only the following existing taxonomy values in the editable fields. No candidate checkbox or final confirmation is checked in either prepared tab.

| Workbook | Row / proposed draft | SKU | Prepared category | Model / brand handling |
| --- | --- | --- | --- | --- |
| Residential | `12 SKU candidates`, row 2: Tuya Smart Wi-Fi Wall Switch — 1 Gang | `OYI-SWH-WF-1G-001` | Smart Home & Automation | Model left blank because the source says OEM model TBD; complete original combined reference retained |
| Commercial | `Commercial Facility 15`, row 2: 4MP ColorVu Turret IP Camera | `OG-CF-CAM-001` | Security & Access Control | `DS-2CD2347G1-LU` retained; Hikvision retained as manufacturer source |

The local brand registry is empty. Do not claim these drafts have canonical brand assignments: `brand_id` will be null, and source manufacturer/combined-model information remains in private import evidence. Existing taxonomy creation requires `catalogue.publish`; no such permission was granted. A matching canonical brand can be assigned later through the existing workflow by an authorized taxonomy manager. This does not prevent draft creation or justify inventing a brand/model.

## Minimum owner actions

1. In the residential tab, review the first product and its prepared category. Select only that product; verify **1 selected**. Tick the draft-only confirmation, then click **Create selected drafts** once.
2. Repeat for the first commercial product in its separate tab. Verify **1 selected** before confirming. Do not use Select all.
3. Open each created draft, verify the overview/specifications/SKU, and make one harmless local edit such as a short description. Save a new draft version, then reopen it to check persistence. Do not submit for review or publish.
4. On one draft, use the existing media gallery's **Add images** control to choose a suitable JPEG, PNG or WebP. Add an alt description and save the draft gallery. An incomplete gallery is allowed on a draft. Use a modest test image, at least 200px on each side; image rights and product relevance still need owner review.
5. Report that both drafts and the edit/image save are complete. Read-only follow-up will compare records, immutable versions, image references, null selling prices, absent supplier-cost records and audit/source links. Re-uploading the same workbook should show the saved SKU as a duplicate; do not confirm another import of it.

Prepared field selections are browser state, so avoid refreshing these tabs before saving. If refreshed, upload again and choose the categories above. Existing Add Product Manually remains available from Products.

## Current automated evidence

All test writes below use explicitly synthetic products and disposable temporary stores/databases, never the owner's port 4387 catalogue or original workbook products.

| Suite | Result |
| --- | --- |
| Existing import HTTP/extraction/creation/duplicates/manual-creation regression | 33/33 PASS |
| Existing disposable PostgreSQL draft/immutability/approval/public-access regression | 10/10 PASS |
| New synthetic imported-draft persistence/edit/gallery/restart regression | 8/8 PASS |
| Existing catalogue domain and permission matrix | 56/56 PASS |
| Existing image processing and gallery rules | 25/25 PASS |
| Existing media failure/cleanup regression | 8/8 PASS |
| Repository check, lint, build, whitespace | PASS |

Total: **140 checks passed**, plus repository validations. The new test creates one synthetic imported draft through the existing authenticated API, checks exact normalized content, private reviewed evidence and audit links, appends an edit without altering version 1, uploads and saves a generated image through the existing media path, checks authenticated WebP/nosniff/private caching, verifies duplicate rejection, and restarts the local service to compare persisted state. No public release is performed by it. Benchmarks and supplier references remain evidence only; selling prices stay null and authoritative costs stay empty.

Current owner-store read-only snapshot: **0 products, 0 product versions, 0 price changes, 0 supplier-cost records, 0 publication events, 0 product-import creation audit events**. Uploaded private preview documents/audits exist, as expected. No payment initiation, production request, push, deployment or financial-code change was made. Production activation flags were not accessed or changed.

Source references are stored privately in the original extraction and reviewed import evidence, linked by the import audit event; they are not copied into approved pricing or publicly exposed as product claims. The general product editor does not yet contain a dedicated import-provenance panel. Read-only follow-up can inspect these existing evidence links.

Run the new isolated regression with `node scripts/test-product-import-stage2.js`. This is a test-only addition; application implementation remains at the accepted correction. No restart of the owner's instance is required.
