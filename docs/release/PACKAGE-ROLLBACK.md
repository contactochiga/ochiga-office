# Package rollback containment

The pre-package compatibility commit in this branch is the ONLY supported pre-SP Office rollback target once the package schema is installed. It contains the production baseline, redirect patch and kind-aware hardware boundary, not the package UI or financial functionality.

Before rolling back: keep both GetOyi public switches OFF, freeze catalogue writes with OFFICE_CATALOGUE_ROLLBACK_READ_ONLY=true, and confirm no background staff/import mutation is underway. The flag denies POST/PATCH/DELETE even to super-admin after authentication. Existing hardware reads remain available. Maintain the schema and immutable data.

The compatibility build filters package/service/unknown kinds out of hardware list, category counts, details, slug redirects, media and private product previews. Missing kind is accepted only for older genuine product rows. Never roll back to b256550, 4cfd830 or a dependency-only build once package records exist: those binaries do not understand kinds. Capture the compatibility commit/image before package rollout and require the 16-check HTTP containment test on it before authorization.

Database rollback remains conditional: the reviewed down migration refuses if ANY package/service exists, including archived records. Do not delete records to force rollback. Public withdrawal and any write needed before freezing must be separately authorized; this preparation performs none.

After restoring the compatibility build, test scoped hardware responses and denied package media, confirm public GetOyi package routes are disabled, and retain the write freeze until restoring an approved SP-capable build or a reviewed data-preserving recovery. Old deployment IDs are historical evidence, not approved post-package rollback targets.
