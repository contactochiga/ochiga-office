# Solutions & Packages (SP1–SP3) — local engineering

Extends catalogue products with immutable `kind` (`product`, `service`, `package`). Component/configuration evidence is carried in the existing immutable product-version JSON; no second catalogue or order system.

## Workflow and boundaries

- Existing permissions: `catalogue.read`, `.write`, `.review`, `.publish`, `.price.approve`, `.cost.read`, `.cost.manage`, `inventory.manage`, `.public.publish`. No new role defaults.
- Components refer to internally published product/service SKUs. Saved versions snapshot component publication version and approved price. Drift requires save + independent re-review before updating the released package.
- Required/optional/recommended roles, fixed/per-unit quantities and per-size overrides. Package variants are sizes, priced through existing approval or explicitly consultation-led.
- Oyi deployment is consultation-led; installation is separately quoted unless explicitly included in the reviewed scope. No subscription or booking implementation.
- Public package projection contains only approved descriptions, scope, names, quantities, media, sizes and customer-facing availability. No supplier/cost/stock count or actor fields. The package version number is public for enquiry binding.
- Discontinued required components make package availability unavailable immediately. Optional components do not control package-wide availability. This is an enquiry readiness signal, not stock reservation or a commitment to deliver.
- Package image route `/api/public/catalogue/packages/media/<sha>.webp` serves only media referenced by a currently public package.
- Website package context is descriptive CRM evidence, not pricing/order authorization. It is retained on the lead, opportunity and intake timeline. Existing enquiry data without package context is unchanged.

## Migration and rollback

Apply existing catalogue migrations in order, then `db/20261109_catalogue_packages.sql`. The test checks all 36 catalogue functions: invoker security, pinned `public, pg_temp` search path and service-role-only execution; RLS remains closed to public roles.

- Apply/reapply tested on disposable PostgreSQL 17.6 plus PostgREST.
- `db/rollback/20261109_catalogue_packages.down.sql` is transactional. It is allowed only before ANY package or service exists; otherwise it refuses and preserves all history/guards. Archive is not deletion and does not permit rollback.
- After package data exists, prefer disabling website packages and restoring the preceding application build while retaining additive schema and history. Do not delete records to force rollback. Any later schema rollback requires a separately reviewed data-preserving plan.
- Reapply later catalogue migrations after an older foundation/public migration: the package migration intentionally extends public requirements.

## Verification

`node scripts/test-catalogue-packages-model.js`
`node scripts/test-catalogue-packages.js`
`node scripts/test-catalogue-packages-ui.mjs`
`node scripts/test-catalogue-postgres.js`
`node scripts/test-catalogue-browser.js`

Full commerce suites use disposable databases and mocked providers, never production or Paystack. Evidence and exact counts are recorded in the external Solutions & Packages implementation report.

## Synthetic review environment

`PACKAGE_STAGING_DIR=<private local directory> node scripts/test-catalogue-packages.js` runs the existing independent-author/reviewer workflow, retaining its synthetic file store for browser review. `PACKAGE_STAGING_RESUME=1` reopens the same records without re-running fixture creation. The generated `connection.json` is private (0600), outside the repository and must never be committed or displayed. Shut down only that harness to stop its server. No production `.env` is mounted.

The component picker follows catalogue pages up to the existing bounded 5,000-item limit and reports truncation. No component is silently invented. Technical compatibility beyond the approved SKU/version evidence still requires staff assessment.
