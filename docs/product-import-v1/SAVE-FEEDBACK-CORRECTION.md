# Product import save-feedback correction

28 October 2026 · isolated import worktree · no production release.

## Diagnosis before editing

The owner's local store was inspected read-only first. **Both the 1-Gang and 2-Gang switches had already been created successfully by the owner.** Each had one immutable version and one successful `catalogue_product_imported` audit event, linked to its reviewed source evidence. No retry or new real product creation was performed.

The unmodified UI was reproduced using a synthetic twelve-row workbook in a separate loopback-only Office instance. Selecting one candidate with an unmapped category, checking confirmation and clicking Save:

1. Executed the click handler.
2. Sent POST `/api/lead-agents/admin/catalogue/imports/:id/drafts`.
3. Received **HTTP 400 `invalid_catalogue_input`**, with `category_id must be a category id`.
4. Wrote the error only to the status block near the upload control. Its measured top was **−1179.94px** while the viewport was 720px high and the save button was visible.
5. Did not create a product and did not navigate away from the import URL.

The button's implicit type was `submit`, but it had **no form ancestor**. Unexpected form submission was not the reproduced cause. Explicit `type="button"` is now used defensively.

After choosing a valid category, the same synthetic route returned **HTTP 201**, saved the draft, and put success text above the visible area (measured top **−1463.44px**). The result link lived in the product card rather than beside Save. No reload was reproduced; the lack of visible feedback explains the apparent silent refresh, but is not evidence of an actual browser reload. The owner's exact historical clicks cannot be reconstructed from screenshots alone; the successful audits establish their persisted outcomes.

Two related issues were confirmed: the unmatched-category warning was not updated after category selection, and the sticky action panel could overlap product controls. Both are corrected within the import component.

## Changes

- Explicit non-submitting buttons and `preventDefault` on the save handler.
- A focused, live-announced feedback region beside Save for validation, loading, success and failure; successful product links appear there as well as in each row.
- Pre-submit checks for selected rows, confirmation, existing category, name, slug, SKU format/duplicates, variants and required specification fields. Row messages and `aria-invalid` identify the fields; the server remains authoritative for full validation and permissions.
- Category warnings clear when an existing category is chosen. The action panel stays in normal page flow so it does not cover fields/checkboxes.
- Loading text, `aria-busy`, disabled controls and the existing synchronous in-flight guard prevent repeated clicks while saving. Completed rows remain disabled afterward.
- Exact SKU matches in the authenticated preview now include existing product IDs, allowing links to saved products without relying on similar names.
- HTTP 401 explains sign-in/re-extraction; conflicts explain existing products and refresh; server/network/timeout or malformed-response failures explicitly warn that a draft may already exist. No automatic retry. Another save is blocked until re-extraction refreshes duplicate checks.
- Partial creation/audit failure retains known saved-product links and stops further saving. A 30-second client deadline reports uncertainty rather than assuming rollback.

Files: `public/office/catalogue/import.mjs`, `src/lead-agents/catalogue-import.js`, plus synthetic HTTP/browser-rehearsal helpers. Catalogue creation, validation, versioning, storage, approvals and manual Add Product remain the existing implementations.

## Browser and HTTP evidence

All mutation tests used synthetic records in disposable test stores, not the owner's real drafts.

| Case | Browser evidence | HTTP evidence |
| --- | --- | --- |
| Missing category | Original defect reproduced; corrected feedback visible beside Save, no request sent | 400 with validation details, no product |
| Missing SKU / name | Visible field-specific messages; no submission | 400 for each, no product |
| Valid single draft | Visible loading, success count and product link | 201; canonical draft, null selling price |
| Duplicate SKU | No submission; exact existing-product link | 409 `sku_taken`; one product remains |
| Double click | One POST and one draft; disabled “Saving drafts…” observed during delay | Concurrent requests create exactly one product |
| Server error | Visible uncertain-outcome warning; repeat Save locked | Injected 500, no test product created |
| Session expiration | Visible sign-in guidance; repeat Save locked | Real invalid-session authentication returns 401; browser response injected as 401 |
| Save and reopen | Saved-product link opens correct synthetic editor | GET returns saved content and draft state |

Server-error and delayed-response browser cases use explicit local fault injection, not production failures. The browser session-expiry case injects the response; the independent HTTP test exercises real invalid-cookie authentication. The browser harness records only route template, mode, HTTP status and error code—no cookies, credentials or source bodies.

Current automated runs: feedback HTTP **10/10**, existing import **33/33**, imported-draft persistence/edit/media **8/8**, actual workbook preview **25/25**, disposable PostgreSQL **10/10**, catalogue domain/permissions **56/56**. **142 checks passed**. Repository check/lint/build/whitespace passed. Existing manual creation is covered by the import regression. Browser evidence lives under ignored `outputs/import-feedback-local/`.

## Existing owner draft inventory (unchanged)

| Product | SKU | Version / workflow | Pricing / release |
| --- | --- | --- | --- |
| Tuya Smart Wi-Fi Wall Switch — 1 Gang | `OYI-SWH-WF-1G-001` | v1 / draft | Selling price null; never published |
| Tuya Smart Wi-Fi Wall Switch — 2 Gang | `OYI-SWH-WF-2G-001` | v1 / draft | Selling price null; never published |

1-Gang ID: `ab58f882-97f0-49bb-b028-a4271341add4`; import audit 28 October **12:30:03 Lagos**. 2-Gang ID: `1b8d8e5c-a97a-4b04-b0e7-faa70cc5bde3`; import audit **12:47:12 Lagos**. Both use Smart Home & Automation, have no assigned brand/model, have empty galleries and retain private source references. No authoritative supplier costs or public release events exist.

The 2-Gang draft currently contains specification unit `1`. That is persisted owner-reviewed input, not present in the original specification's unit field; review it in the existing draft if unintended. It was not changed by this fix.

## Owner retest

Local Products: `http://127.0.0.1:4387/office/#/catalogue`.
Import: `http://127.0.0.1:4387/office/#/catalogue/import`.

Refresh after the local service update and sign in again with the existing local importer if prompted. **Do not recreate either switch.** Open those existing drafts, or re-upload the residential workbook to verify duplicate warnings and links. Missing-category validation can be tested on another selected row without creating it, but do not confirm a valid new real product unless intentionally requested by the owner.

GO for local retest. Production deployment/publication remains outside scope. No push, deployment, payment initiation, wallet change, production mutation, Claude worktree or shared financial/Docker change was made. Rollback is reverting this correction; retain existing owner drafts, source evidence and audit records.
