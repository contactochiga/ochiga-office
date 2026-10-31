# SP1–SP3 production-baseline integration — DRAFT, NO DEPLOYMENT

Accepted source: 242f45cc3fb15d3b5cbcc203f2464cfbf2160acc, preserved unchanged.
Production base: b256550; dependency-patch prerequisite: codex/office-redirects-security.

## Integration

Only the single accepted SP commit is ported. The catalogue tab and server asset-route contexts were resolved by adding the Packages tab/dispatch and packages.mjs GET route only. No Orders & payments/Fulfilment tabs, financial scopes, payment/checkout/fulfilment modules or their migrations are included. Production fail-closed Vercel API middleware remains unchanged.

Kind-aware containment also rejects package/service/unknown kinds from hardware slug redirects and the generic hardware image route. Packages use their own projection/media routes. The existing independent feature switch on GetOyi stays OFF. No role defaults or approval bypass changed.

## Rollback anchor

Supported pre-SP rollback commit: **ba0e0d6**, branch `codex/sp-office-rollback` (contains 30f2900 security patch). This does not add package creation/UI; it understands enough of the future kind field to reject non-products from all old hardware routes and product previews. Its real HTTP boundary tests pass 16/16. Enable `OFFICE_CATALOGUE_ROLLBACK_READ_ONLY=true` when invoking this rollback to freeze catalogue mutations even for super-admin; retain both website switches OFF. See PACKAGE-ROLLBACK.md. Never use b256550 after package data exists.

The same 16-check boundary suite passes on the integrated SP candidate. No production runtime or schema was changed during this proof.

## Migration

Only `db/20261109_catalogue_packages.sql` is added (SHA-256 308fb5bc066384c46f838884710ae425ece546a168344a63038de2f3f372007d). Its existing foundation/pricing/media/public/merchandising/ingestion prerequisites are production catalogue infrastructure; it does not need Phase 4/5 commerce.

Rollback hash: ee82daebe08fd8bce2107bed99c0c1e669612fbc5b9494c610192bb7380efc31. Down migration is allowed only before ANY package/service exists. Afterwards preserve schema/history, freeze writes and use the compatible application rollback. No fixture/data transfer is included.

The isolated PostgreSQL suite verifies schema apply/reapply, privilege/RLS/search paths, 36 catalogue functions, immutable history, multi-connection race/idempotency, ordinary product behaviour, package review/release and guarded rollback. Exact completed counts belong in the PR evidence; interrupted runs are never passes.

## Release blockers and order

- Separate inherited zod advisory remains open (see REDIRECT-SECURITY-PATCH.md); no waiver.
- Human engineering review and fresh production read-only schema/baseline gate required.
- Gate A legal, retention, final visual and hosting approval remain open. PR #4 stays at 34f0859.
- Real offering images, exact compatibility, deployment/installation scope, independent prices and production publish/withdrawal acceptance remain separate.

Order after separate authorization: dependency patch → capture/build the kind-aware rollback anchor → apply ONLY package migration with pre/post gates → deploy integrated Office → approve/deploy GetOyi PR #4 with catalogue OFF → deploy SP4 with both switches OFF → authenticated manual/product/gallery/preview/CRM smoke. No new live enquiry without authorization. Public catalogue and package activation are separate later decisions. Render auto-deploys its production branch; merging/pushing that branch is a deployment action.

Review branches disable Vercel Git auto-deploy; Render previews are off and its deployment branch is untouched. Do not manually deploy draft commits.
