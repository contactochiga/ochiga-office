# Products and ingestion V2 presentation refinement

Baseline: `be3aa7f`, branch `codex/intelligent-catalogue-ingestion-v2`. Local review only; no production migration, push, deployment, permission change or financial operation.

## Scope and CRM comparison

Only three frontend modules changed: `catalogue.mjs`, `ingestion.mjs` and `ingestion-taxonomy.mjs` under `public/office/catalogue/`. The Office shell, CRM, APIs, parser, checkpoints, permissions, database schema and commercial workflows are unchanged.

The authenticated production CRM header was inspected read-only. Its existing shared styles provide 12.5px tabs, 8px/4px tab padding, 16px right margins, a 2px active underline, a thin divider and 28px action buttons. Products now reuses these CRM classes. The redundant Products heading/subtitle is removed; the existing topbar identity remains. Large catalogue count cards become small inline status filters.

One compact Add product dropdown opens the original manual creation dialog or the original V1 import route. Both remain gated by `catalogue.write`; the existing V2 entry remains available from V1. Escape, arrow keys and outside-click dismissal were exercised. Global navigation and sidebar were not changed.

V2's primary tabs are Product category mapping, Brand mapping, Worksheet preview, Summary, in that order. Tab counts replace dashboard cards. Category/brand groups and worksheet roles use a list/detail split; full editable product review is available contextually below. Pending mapping selections survive tab changes and applying a mapping in the other tab. Existing confirmation, version checks and backend payloads remain authoritative. Applying mappings still clears draft selections and unsaved product edits, with visible notice.

Mobile uses one column with bounded group lists; tabs scroll horizontally without widening the page. No taxonomy, prices, inventory or approval states are inferred by the presentation.

## Extraction feedback

Reading file reflects the actual local file read. Mapping worksheets / Linking specifications is an explicitly indeterminate server-processing stage: the endpoint does not report individual stage progress. Preparing review follows the server response. Completion and retry states are visible; invalid files and expired sessions receive readable errors. Submission controls lock during requests. Draft processing retains its separate real checkpoint progress indicator.

The subtle spinner has a `prefers-reduced-motion: reduce` rule that removes animation. The rule was inspected in the rendered stylesheet; an operating-system reduced-motion preference was not toggled during this rehearsal. No invented percentage or timer-driven progress is shown.

## Validation evidence

- V2 suites: 92 assertion groups (HTTP 21, disposable PostgreSQL/PGlite 16, edges 10, multi-sheet 21, batch taxonomy 24).
- V1: 33 groups. Original residential/commercial HTTP preview: 25 groups, 12/12 and 15/15 candidates. Catalogue API: 104 groups.
- **254 targeted groups passed**, plus the complete `npm run validate:release` Office/CRM/Documents/storage/permissions regression command. Final release log ends `validate:release: release checks completed`.
- All three changed modules pass `node --check`; `git diff --check` passes.
- Real browser upload of the unchanged research workbook retained **50 products, 149 specifications, 250 image requirements, 50 QA records, zero unmatched rows and zero conflicts**.
- In a separate disposable local service, a category mapping and explicit unknown-OEM unassignment updated readiness to seven without creating workbook products. Pending category selection survived the brand operation. Repeated clicks produced one mapping operation.
- Double-clicked workbook extraction produced one preview. Invalid XLSX showed failure/retry. An expired synthetic session was rejected without mutation; signing in again allowed retry.
- One explicitly synthetic CSV record was selected and confirmed through the UI. Double-clicked draft creation produced one draft, one receipt and one import audit event. The draft reopened in the existing editor with no approved price, zero stock and never-published status. No owner workbook product was created.
- Manual Add product still opens its existing dialog; it was cancelled without creating a record. The original V1 and V2 navigation paths work.
- Desktop 1440×1000, tablet 820×1180 and mobile 390×844 were checked for Products and V2. Document width equalled viewport width at each size. Desktop/tablet retain split panels; mobile is single-column. Keyboard tab navigation was exercised.

Owner environment on port 4388 retains its two pre-existing synthetic drafts and no saved taxonomy mapping batches. Rehearsal writes occurred only in a disposable service on port 4389. The existing owner checkpoint remains available for their review; resolving its categories/brands still requires explicit decisions.

Test logs: `/tmp/products-ux-ingestion-tests.log`, `/tmp/products-ux-v1-tests.log`, `/tmp/products-ux-real-tests.log`, `/tmp/products-ux-catalogue-tests.log`, `/tmp/products-ux-release-final.log`. Expected authorization-denial logs inside passing negative tests are not failures. PGlite coverage is not a claim of new production database/load certification.

## Visual evidence and owner walkthrough

Screenshots are in `outputs/products-ux/` (local review artifacts, not deployed assets):

- `comparison.html`: side-by-side production CRM / local Products headers and desktop/mobile layouts.
- `products-desktop.png`, `products-tablet.png`, `products-mobile.png`.
- `ingestion-desktop.png`, `ingestion-tablet.png`, `ingestion-mobile.png`.
- `worksheet-desktop.png`, `brand-mobile.png`, `extraction-indeterminate.png`.

The indeterminate screenshot uses a six-second delay injected only into the disposable rehearsal server to make the actual pending state observable. This delay is not in application code. An earlier `extraction-error.png` is diagnostic evidence from before friendly error copy was refined, not a final visual reference.

1. Refresh `http://127.0.0.1:4388/office/#/catalogue` and inspect Add product → Add manually / Import products.
2. Open `http://127.0.0.1:4388/office/#/catalogue/ingestion`. The existing isolated account is signed in; if it expires, use local test login instructions in `outputs/product-import-local/login.json`, not production credentials.
3. Open the saved checkpoint or upload the workbook. Inspect the four tabs, grouped mapping controls and contextual product review.
4. Confirm mappings only when ready. Creating drafts remains a separate selection and confirmation; no bulk import is required for visual acceptance.

**GO for local owner acceptance.** Production release requires a separate decision. This refinement does not resolve outstanding taxonomy curation or approve any commercial information. No shell, payment, checkout, wallet, public Hardware or Claude worktree changes were made.

Rollback: revert this presentation commit and refresh the local browser. No database rollback is needed; stored previews, mappings, receipts and drafts remain intact.
