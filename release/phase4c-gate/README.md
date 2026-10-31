# Stage 4C migration-aware gate

Run production-rollout-gates.sql read-only against the intended database; require every security and ordering check PASS and the expected migration stage. ABSENT accepts only the reviewed pre-4C shape; APPLIED accepts only the reviewed final shape. Partial installation and altered owners, grants, RLS, search paths, history guards or verifier bodies fail. Earlier Phase 0–4B checks are retained.

build-gate.py verifies pinned input SHA-256 hashes before regenerating the gate. Reviewed manifests are not auto-approved from a target database. Do not recapture a failing target to make it pass.

After explicit migration application and database scheduler installation, run scheduler-check.sql. It checks the exact job, owner, active schedule, preload, successful recent execution and overdue holds. Schema success alone is insufficient for release.

Local tests cover pre-migration, migrated, nine deliberate tamper cases, transactional migration rollback and actual scheduled expiry. This evidence is not a production preflight. See docs/commerce/STAGE4C.md for release order and evidence-preserving rollback.
