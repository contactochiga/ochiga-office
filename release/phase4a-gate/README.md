# Stage 4A release gate

Local candidate only. Read-only `production-rollout-gates.sql` preserves the frozen Phase 3 gate and adds the exact Stage 4A manifest check. No existing condition or grant exception is loosened. Wholly absent or exact installed schema is accepted; partial/tampered installation fails. Applied P4A requires P3 APPLIED.

Generator: `python3 release/phase4a-gate/build-gate.py`. Phase 3 base, order migration and manifest hashes are pinned in the generator. Do not regenerate the manifest from a live or tampered database. Any schema/function change requires review of the new expected shape, hash updates and full tests.

Run `npm run office:orders:test`. The isolated harness tests transaction rollback, absent/applied gates, RLS/grant/trigger/function/constraint tampering, actual authenticated HTTP flows and immutable financial/history records. Existing tests remain separately runnable.

Migration SHA256: `1bd14ac80de64e8b9ec0f768a41469dad0fecbbee25a360b5f6d4959af76e70b`.
Generated gate SHA256: `545f1854b8b40e705f2dae245ce8857cb26027d6ea0f0f1799493097ba7d9f8c`.

No production apply command is executed by this package. For a separately approved release: transaction + migration + post-gate GO before commit; stop on any mismatch. Roll back an uncommitted transaction, otherwise keep additive schema/data and roll back application/disable the order feature. Never remove immutable financial history as a rollback mechanism.

See `docs/commerce/STAGE4A.md` for permissions, endpoint contracts, reservation contract, remaining work and the retained public activation prerequisite.
