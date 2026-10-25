# Phase 3 merchandising — local review

Paired GetOyi implementation: branch `codex/phase3-hardware`. This branch extends Products only. No production migration, deploy, push, permission grant or configuration change is authorized or performed. Public Hardware remains OFF.

## Changed areas

- `src/lead-agents/catalogue-merchandising.js`: strict content validation, published-product/gallery intersection, schedules, immutable campaign snapshots and file/SQL adapter. Missing merchandising schema fails without disabling core catalogue availability.
- `catalogue-api.js`: session-authenticated Products campaign read/edit/review/publish/withdraw; existing permission checks/audit/notifications. `catalogue-public-api.js`: scoped, no-store public merchandising projection.
- `public/office/catalogue/merchandising.mjs` and catalogue tab: campaign content, released-gallery image selection, product collections, order/duration/schedule and workflow/history. No Office shell change. Product gallery upload/review infrastructure is reused; standalone campaign uploads are not added.
- `db/20261106_catalogue_merchandising.sql`: DRAFT additive migration; singleton state, immutable versions/events, fixed-search-path invoker transition function, conditional row version and independent reviewer, RLS/explicit service grants and append-only update/delete/truncate guards. Tested only in disposable PostgreSQL. Production gate baseline must be reviewed for 3 additional tables and 1 transition function, including stricter history-table service privileges.
- Tests extend existing disposable DB regression and add 41 unit/isolated authenticated HTTP checks. Test accounts/keys exist only in temporary local stores.

## Evidence

151/151 disposable PostgreSQL/PostgREST regression checks, 41/41 merchandising checks, 104/104 existing catalogue HTTP checks, 8/8 public projection unit checks. Office lint and runtime asset build pass. GetOyi paired DOM editor harness adds 6 passing form/permissions/body-shape checks. The initial test caught missing TRUNCATE guards, corrected before the final 151-check pass.

Existing product integrity, immutable history and review/publishing permissions remain authoritative. Campaign publication never publishes a product; references must already be publicly released and available. Independent reviewer must not be an author of the current draft lineage. New draft edits retain the previous published snapshot. Projection rechecks current eligibility and schedule on every no-store request. External CTA URLs and arbitrary image sources are rejected.

## Release gates and recovery

NO-GO for production until schema/security gate review, dependency remediation in the paired website, approved-content visual sign-off, authorized staff editor verification and independently authorized product/campaign publish-withdraw checks. No permissions are granted by this migration. Do not run it against production merely to inspect it.

Recovery should disable campaign exposure/revert application code first while preserving all campaign state/history. Do not drop tables, truncate history or rewrite immutable versions. Any SQL rollback must be separately reviewed; no destructive down-migration is supplied. The existing flag-off Hardware fallback remains the public behavior.

The full screenshot comparison and implementation limitations are recorded in the paired website `docs/phase3/IMPLEMENTATION.md` and `/Users/ochigaidoko/getoyi-commerce/phase3/comparison.html`.
