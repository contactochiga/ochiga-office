# Office redirect security patch (review only)

Base: production b256550. No Phase 4/5 or package functionality.

- Lockfile-only follow-redirects 1.16.1 → 1.16.2; Axios remains 1.20.0. Compatible with Axios's ^1.16.0 range.
- GHSA-mrwp-f3q8-3g9p: cross-realm custom sensitive-header handling. Real loopback redirect test covers both realms, sensitive/header retention and Axios.
- `scripts/validate-deployment-config.js` contained two obsolete assertions for unconditional production API rewrites. Production b256550 already replaced them with middleware. The validator now runs the existing 31-check production/preview routing test instead; the isolation fix is preserved.
- Vercel auto-deploy disabled only for the three named review/rollback branches. Production branch behaviour unchanged. No deployment is authorized by this PR.

## Security disposition

Fresh `npm audit --omit=dev` clears follow-redirects but reports FOUR High affected packages for ONE separate advisory: GHSA-mrhx-c7xc-m3w5, zod <4.6.6, via @vercel/functions → @vercel/oidc → @vercel/cli-config → zod@4.1.11. This chain exists in production b256550 (preview-isolation dependency) and was absent from the older SP branch's dependency graph. Not introduced by this patch and NOT waived. The CLI-config package pins zod; audit suggests downgrading @vercel/functions to 3.6.1. Do not do that blindly: it may undo runtime compatibility. Review a compatible upstream fix or narrowly tested zod override separately. Release remains blocked on remediation or explicitly reviewed security disposition.

The focused test uses synthetic loopback headers, never provider/production credentials. No production database or financial test is required for this dependency-only patch. Frozen commerce baselines are unchanged.

## Required evidence before merge

- Exact installed resolution: Axios 1.20.0 / follow-redirects 1.16.2.
- `node scripts/test-redirect-credentials.js`: 10/10.
- `npm run validate:release`: record final completed result in PR.
- Dependency audit finding above must remain explicit; this is not a zero-vulnerability release.

No merge or deployment without a separate decision. Roll back this patch to b256550 only before package schema/content rollout; package rollout defines a newer kind-aware rollback anchor.
