# Office redirect security patch (review only)

Base: production b256550. No Phase 4/5 or package functionality.

- Lockfile-only follow-redirects 1.16.1 → 1.16.2; Axios remains 1.20.0. Compatible with Axios's ^1.16.0 range.
- GHSA-mrwp-f3q8-3g9p: cross-realm custom sensitive-header handling. Real loopback redirect test covers both realms, sensitive/header retention and Axios.
- `scripts/validate-deployment-config.js` contained two obsolete assertions for unconditional production API rewrites. Production b256550 already replaced them with middleware. The validator now runs the existing 30-check production/preview routing test instead; the isolation fix is preserved.
- Vercel auto-deploy disabled only for the three named review/rollback branches. Production branch behaviour unchanged. No deployment is authorized by this PR.

## Security disposition

GHSA-mrhx-c7xc-m3w5 affects zod <4.6.6 through @vercel/functions@3.10.4 → @vercel/oidc@4.0.4 → @vercel/cli-config@0.3.4 → zod@4.1.11. The advisory concerns excessive collection-validation error accumulation and memory exhaustion. Reference: https://github.com/advisories/GHSA-mrhx-c7xc-m3w5.

Office uses the functions package's `rewrite` export, not its OIDC credential flow. The rewrite require-cache probe loads zero Zod/OIDC/cli-config modules. CLI-config's relevant schemas validate local configuration/authentication files, not Office request bodies; no remotely reachable vulnerable collection parser was demonstrated. This is a reachability assessment, not a waiver.

The narrow fix overrides only @vercel/cli-config's Zod to exact 4.6.6. The latest cli-config 0.3.5 still pins 4.1.11, so a parent upgrade would not fix the advisory. All other resolved dependencies remain unchanged, including @vercel/functions 3.10.4, Axios 1.20.0 and follow-redirects 1.16.2. No major-version upgrade or downgrade. Remove the override only after a verified upstream fixed dependency is available.

## Focused validation (2026-10-31)

- Full `npm audit --json`: ZERO advisories, including development dependencies.
- `test-vercel-config-compatibility.js`: 19/19 — actual cli-config config/auth parsing, file round trips, invalid types, BOM, passthrough and bounded-heap oversized-collection rejection. Synthetic temporary files only; no real credentials.
- Redirect header safety: 10/10; API routing: 30/30.
- Deployment validation and Office asset build: PASS.
- Existing full release and SP PostgreSQL results are reused; no SQL, application permissions or financial source changed by this patch.

The tests never read provider credentials or production databases. No resident-wallet or Phase 4/5 changes. Review branches retain disabled Vercel auto-deployment; no deployment is authorized.

No merge or deployment without a separate decision. Roll back this patch to b256550 only before package schema/content rollout; package rollout defines a newer kind-aware rollback anchor.
