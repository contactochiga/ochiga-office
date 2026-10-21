# S7 R5 — Database Security Verification (H1)

Evaluated runtime: `fbac5ad` (unchanged: no `src/`, `public/` or dependency diff). Frozen corpus (`scripts/final-cert/`) and docs 45–47 are byte-identical to `d489c45`/`f014db3`.
Evidence commits: `24d04c0`, `f5f823a`, `4af1794` (this change set), plus this document.

## Production exposure classification: **UNKNOWN — NO-GO retained**
No production database credentials or Supabase project access were available in this session (none in the environment; none were requested or used). Nothing was read from production, and nothing is inferred from the fixtures.
Repo evidence only: `db/lead-agents-schema.sql` enables RLS on 2 of its 56 tables and none of the credential tables; no migration in `db/` ever enabled it on `admin_users`, `admin_invites`, `password_reset_tokens` or `audit_events`, and none revokes their anon/authenticated privileges. So **production is exposed unless someone applied hardening outside the repo** (the Settings docs reference "RLS everywhere", which no repo file implements).
**Owner action:** run `scripts/sql/production-data-api-exposure-audit.sql` (read-only; catalog metadata only, never reads rows) in the production SQL editor. Sections 1–5 must return zero rows. If section 1 or 2 lists `admin_users`, treat it as a live incident: rotate the anon key, force password resets, review access logs.

## Reproduction (disposable Supabase Postgres 17 + PostgREST v14.12)
On the schema without the R5 migration, both `anon` and `authenticated`: read `admin_users` rows including a non-empty `password_hash` (full and column-only selects), read invite/reset-token/audit rows, get row counts, and could PATCH/INSERT/DELETE credential rows. Values were never recorded (counts/booleans only).

## Remediation (additive, idempotent, no row/hash/account change)
`db/20261027_data_api_lockdown.sql` — apply after the base schema and migrations through `20261026` (it refuses otherwise):
1. `admin_users`, `admin_invites`, `password_reset_tokens`, `audit_events`: enable RLS (no policy), revoke all (table and column level) from PUBLIC/anon/authenticated, keep service_role CRUD. Not FORCEd, so owner/direct-connection deployments are unaffected.
2. Remove residual anon/authenticated privileges on `office_runtime_settings`, `communication_delivery_outbox`, `whatsapp_inbound_claims`, `whatsapp_manual_sends`; revoke PUBLIC/anon/authenticated execute on trigger helpers `office_runtime_setting_history_immutable()` and `set_updated_at()`.
3. service_role least privilege: no DELETE/TRUNCATE on MFA credentials, no TRUNCATE on recovery codes/challenges, none of TRUNCATE/UPDATE/DELETE on the append-only setting history.
Rollback `db/rollback/20261027_data_api_lockdown.down.sql` is an intentional no-op (re-opening would recreate H1); manual re-open instructions are in the file. Order: apply to staging, run the audit SQL, then production in a maintenance window; the application needs no code change or restart (service_role/owner unaffected). Take a backup first as usual; nothing is destructive.

## Tests
- New `scripts/test-data-api-lockdown-postgres-r5.js` (in the `--postgres` suite): 62/62 — reproduction, denial for anon/authenticated/no-token/malformed-token (table, column, count, HEAD, write, embedding, RPC, catalog), service_role preserved (CRUD, functions), owner unaffected, data digests unchanged, idempotence, no-op rollback, plain Postgres 16, base-schema guard, audit SQL clean after / detecting before.
- Clean checkout at `4af1794`: gates check/lint/build/security:secrets/deployment:validate = 0; full 82/82; Postgres 12/12; frozen cert 4/4 (MFA, session, WhatsApp, Settings, Team included in the full suite).
- Frozen corpus re-run unmodified against the remediated schema (informational): c03 PostgREST boundary 17 → **0 failures**; c02 roles 75 → **2** (remaining: ROLE-210 other business tables lack RLS; ROLE-302 naming of a trigger helper); c01/c04/c05/c06/c08/a13 unchanged from doc 47 (unrelated findings H2–H4 etc.).
- Note: an earlier intermediate run had `security:secrets` fail because new file names contained "credential"; renamed. One transient browser CDP timeout in an earlier full run did not recur (82/82 afterwards).

## Remaining risks
- Production state unknown until the owner runs the audit and applies the migration.
- 52 other base-schema tables (CRM, conversations, documents, staff messages…) still lack RLS (ROLE-210); same exposure class for business PII. Recommended follow-up migration after the owner confirms production state; deliberately not bundled to keep this change minimal.
- Supabase default privileges still grant new public tables to anon/authenticated; future tables need RLS in the same migration.
- Open from doc 47: H2 deadlock, H3/H4 throttle bypasses, H5 `follow-redirects`, Medium items. S7 remains not certified.

## Recommendation: **NO-GO** for production until the audit result is known and the migration is applied and re-audited, and H2–H5 are remediated.
