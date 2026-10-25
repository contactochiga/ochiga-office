# Phase 3 security gate and controlled release package

Read-only gate: `production-rollout-gates.sql`. Never apply the migration merely to check this gate. Current production must report P3 ABSENT/GO; after separately authorized migration it must report P3 APPLIED/GO. PARTIAL or any failed baseline/order check stops the rollout.

The Phase 2 base is copied byte-for-byte (SHA-256 ffdf5628f13032b94fe9c5b0b29893bbc325d1f54a4c54734ac4f2216ae62e8d). The sole existing condition change is B6: three specifically named campaign tables are exempt from its generic write-right requirement only when the entire frozen Phase 3 metadata manifest matches. No Phase 0–2 row is removed or loosened otherwise. B14 verifies table/sequence owners, grants, column grants, RLS, constraints, triggers and exact transition/immutable-function definitions including ownership/execute/search_path. It rejects extra overloads and missing or changed named objects. P3 classification and dependency order are added. Exact metadata matching intentionally fails closed on unreviewed changes; never regenerate expectations from production to silence a failure.

The local migration additionally revokes inherited sequence privileges before granting USAGE/SELECT: without this, Supabase defaults leave service_role UPDATE/setval authority. No other product, price, media, Office UI or website behaviour changed.

## Reproduce locally

Requires Docker, the existing Supabase 17 test image and read-only production-shaped fixture helpers in S7_DIR (default `/Users/ochigaidoko/s7-work`). These helpers are read, never edited. The harness creates and cleans only its own disposable containers; no real credentials, remote database URLs or administrator cookies are accepted.

- `node release/phase3-gate/test-phase3-gate.cjs`: 69 checks including 37 tampered schemas, absent/applied states, legacy gate preservation, actual SQL role denial, separate actors, version conflict, self-approval and immutable-history protection. Local evidence is gitignored.
- `python3 release/phase3-gate/build-gate.py`: deterministic generator from hash-pinned Phase 2 base and frozen reviewed manifest. Output gate must match release hash.
- Existing `node scripts/test-catalogue-postgres.js`: 153 checks including authenticated API workflows and immediate authoritative withdrawal. Uses only disposable database/storage and synthetic credentials.
- Existing `node scripts/test-catalogue-merchandising.js`: 49 validation, scheduling, permission and projection checks in isolation.

`capture-reviewed-shape.cjs` is a review aid, not a production command. It only builds an isolated fixture from the pinned migration; it refuses to overwrite an existing manifest unless `--reviewed-regeneration` is explicitly provided. Any regenerated manifest requires independent comparison, new pinned hash and full tamper tests. It must never be used as an automatic gate-fix step.

## Verified recovery

Uncommitted migration transaction rollback returns P3 to ABSENT/GO. Once committed, roll back application code while retaining the additive schema, strict grants and immutable history; gate remains APPLIED/GO. Isolated reapplication preserved two versions and six events exactly. No destructive down migration is provided or authorized. Earlier Phase 2 down-migration evidence remains unchanged; never run it to undo Phase 3.

Full approval packet and evidence: `/Users/ochigaidoko/getoyi-commerce/phase3/gate/RELEASE-BLOCKERS.md`. Separate approvals are required for database, Office deployment, GetOyi deployment with public flag OFF, independent staff testing and public activation.
