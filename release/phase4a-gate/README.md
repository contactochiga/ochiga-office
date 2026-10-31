# Stage 4A release gate

Local candidate only. Read-only `production-rollout-gates.sql` preserves the frozen Phase 3 gate and adds the exact Stage 4A manifest check. No existing condition or grant exception is loosened. Wholly absent or exact installed schema is accepted; partial/tampered installation fails. Applied P4A requires P3 APPLIED.

Generator: `python3 release/phase4a-gate/build-gate.py`. Phase 3 base, order migration and manifest hashes are pinned in the generator. Do not regenerate the manifest from a live or tampered database. Any schema/function change requires review of the new expected shape, hash updates and full tests.

Run `npm run office:orders:test`. The isolated harness tests transaction rollback, absent/applied gates, RLS/grant/trigger/function/constraint tampering, actual authenticated HTTP flows and immutable financial/history records. Existing tests remain separately runnable.

Migration SHA256: `21b29e994f184efbb4b105617c0578b07ff85dab286484e07538d30925b27c62`.
Generated gate SHA256: `785ad0daaa478ea8e39279c97c2af0f8689d903db9b4f82f2a11a8794cbba40a`.

No production apply command is executed by this package. For a separately approved release: transaction + migration + post-gate GO before commit; stop on any mismatch. Roll back an uncommitted transaction, otherwise keep additive schema/data and roll back application/disable the order feature. Never remove immutable financial history as a rollback mechanism.

See `docs/commerce/STAGE4A.md` for permissions, endpoint contracts, reservation contract, remaining work and the retained public activation prerequisite.
