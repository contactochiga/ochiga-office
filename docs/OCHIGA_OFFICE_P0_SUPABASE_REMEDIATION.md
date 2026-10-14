# Ochiga Office — P0 Supabase remediation plan and test evidence

Companion to `docs/OCHIGA_OFFICE_P0_SUPABASE_SECURITY_AUDIT.md`. **Nothing in this document has been applied to production.** The database is not secure until the migration below is applied and independently verified in production.

## 7. Proposed security migration
`db/20261016_ochiga_office_p0_access_hardening.sql` (name chosen after the latest existing migration `20260925120000_…` and after the WhatsApp releases' `20261014_…`/`20261015_…`, so it cannot collide; it is order-independent because it loops over whatever tables exist). One transaction; repeatable.
1. `REVOKE ALL` on all tables, sequences and functions in `public` from `anon` and `authenticated` (and functions from PUBLIC).
2. `ENABLE ROW LEVEL SECURITY` on every ordinary table in `public` (no policies: deny-by-default for any role that does not bypass RLS; `service_role` and `postgres` bypass).
3. `ALTER DEFAULT PRIVILEGES` (role `postgres`, schema `public`) so future tables/sequences/functions are not granted to anon/authenticated. The same for `supabase_admin` is attempted and reported if refused.
4. Built-in verification that aborts the transaction if any anon/authenticated privilege remains, any public table lacks RLS, or `service_role` lost access.
Unchanged: `service_role`, `postgres`, the `auth`/`storage`/`realtime` schemas, every row of business data. 54 tables are affected (all of them). Design choices: no permissive policies are created, because no legitimate anon/authenticated access exists; schema `public` USAGE is not revoked (it is also granted to PUBLIC; revoking that would touch every role and removes no data exposure). Read-only verification SQL: `db/verification/20261016_p0_access_hardening.verify.sql` (every query has its expected result in a comment).
**Narrowest emergency containment** (a strict subset, same effect on exposure, no RLS change): `revoke all on all tables in schema public from anon, authenticated;` inside a transaction — recommended only if the full migration must be delayed.

## 8. Test evidence (all run; none invented)
Environment: Docker, `public.ecr.aws/supabase/postgres:17.6.1.131` (production is PostgreSQL 17.6; roles, `BYPASSRLS` flags and default ACLs verified identical to production), real PostgREST v14.12, schema loaded from this repository's `db/*.sql` (resulting table set identical to production's 54, RLS enabled on the same four tables). `npm run office:p0-supabase-hardening:test` (`scripts/test-p0-supabase-hardening.js`) result: **PASS**.
- **PRE-migration:** 16/16 attacks succeed through PostgREST with seeded sentinel data: anon reads `admin_users.password_hash`, `password_reset_tokens`, `admin_invites`, `leads`, `staff_messages`; modifies an opportunity; deletes audit events; inserts a `super_admin`; inserts a staff profile; authenticated reads admin/leads/messages and deletes contacts; a "website visitor" inserts leads/contacts and deletes leads. Data changed (proved by count/checksum).
- **MIGRATE:** applied twice (idempotent); the four verification queries return their expected empty/zero results; default privileges for `postgres` no longer grant anon/authenticated.
- **POST-migration negative tests A–J:** all 16 attacks refused (401/403), no sentinel in any response, database counts and checksums unchanged; direct SQL as `anon` and `authenticated` (select admin_users, update role, delete audit, truncate leads, insert lead) all fail with SQLSTATE 42501; 0 tables readable by either role; a table created after the migration is not exposed to anon/authenticated but is available to `service_role`.
- **Positive tests K–W:** `service_role` reads all 54 tables and can write/delete. The Office test scripts were run through the real `SupabaseLeadAgentsStore` → PostgREST → database (service_role key) before and after the migration: **31 of 39 scripts pass and the per-script results are identical before and after** (0 regressions), with 1,903 service-role requests across 39 distinct tables and **0 refused** (no 401/403/42501). The passing set includes staff login and invitations, password-reset flow, staff messaging, CRM intake and updates, WhatsApp webhook handling, audit logging, communications bridge, documents and portfolio/facility paths. The 8 scripts that fail in both phases are written for the file store's internals or other services (`communications-convergence-slice2/3`, `communications-handoff`, `office-contract-hardening`, `office-handoff-accept-production-schema`, `office-operational-mutations`, `wave9-plan-core`, `whatsapp-hard-off-rollback`); they pass with the file store (39/39 in the normal run), so they say nothing about the hardening either way.
- **Emergency WhatsApp hard-OFF (Q):** this branch is based on production `codex/office-extraction` at `a0bd54e9609461f84ce091287a33d519decc3c6e` and changes no runtime code (`git diff` vs production: `src/lead-agents/testing.js` only, a test helper guarded by environment variables). `test-whatsapp-hard-off-rollback.js` passes in the normal run.
- Standard checks on the branch: `check` (105 files), `lint`, `build`, `security:secrets`, `deployment:validate` pass; all 39 file-store test scripts pass.
- Not covered by test: Facility/Consumer integrations (they do not use this database; Office reaches them over HTTP), Supabase Auth flows (unused), storage uploads (private bucket, service_role).

## 11–12. Production compatibility; credentials
Compatibility: see audit section 9. **Credential rotations:** no service_role rotation is indicated by the evidence (the exposure was of the anon role). Precaution to decide with the owner: because password hashes were readable during the window and logs to prove otherwise are unavailable, force a password reset for the 5 active admin accounts and revoke the 3 pending invitations (their reset tokens are all expired already). A coordinated service-role rotation is not recommended without evidence of misuse (`docs/ROTATION_CHECKLIST.md` describes the procedure if it is ever needed).

## 13. Recovery prerequisites
(1) Backup/PITR for `metbajilbqclwjfsxfps` is **still unverified** (the CLI cannot list backups; WAL archiving is active with 0 failures, which is consistent with, but not proof of, a restorable backup). Owner action: Dashboard → Database → Backups: confirm plan and latest restore point. (2) If no backup exists, the migration is still low-risk because it changes privileges and RLS flags only; the alternative is a decision by the owner to proceed on that basis or to take a manual export first. (3) Save the baseline: `docs/security/p0-baseline-privilege-matrix.json` (metadata) plus the generator below, run read-only immediately before applying, so the exact prior grants are on record:
`select format('grant %s on public.%I to %I;', privilege_type, table_name, grantee) from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated') order by 1;`

## 14. Production deployment sequence (each step needs your approval)
0. Export Supabase API/Postgres logs and Render request logs now (evidence; section 10 of the audit).
1. Owner confirms backup status (above) and signs off the plan.
2. Read-only: record grants/RLS (baseline), Render service revisions, and row counts of `admin_users`, `leads`, `lead_channel_states`, `inbound_events`, `crm_activities`.
3. Apply the migration (Supabase SQL editor or `supabase db query --linked -f db/20261016_ochiga_office_p0_access_hardening.sql`). It aborts by itself if verification fails.
4. Run the verification SQL; compare row counts with step 2 (must be identical, plus normal traffic).
5. Smoke tests against production: Office login, CRM list/open/edit a lead, staff messages, a document list, one WhatsApp test message from the designated number (lead appears, no reply: hard-OFF), a website-form submission. Watch Render logs and Supabase API logs for 401/403/`42501` for 15 minutes.
6. Independent check with the anon key, **count-only/HEAD requests** (no row data): `admin_users`, `leads`, `password_reset_tokens` must return 401/403/404.
7. Dashboard: disable Auth sign-ups if unused; review each admin account's role; apply the admin-password precaution if chosen.
8. Merge this branch (test helper + scripts + docs) through the normal release process; it contains no runtime change, so it needs no Render restart.
Do not combine with the WhatsApp release deployment.

## 15. Rollback / security recovery procedure
Do **not** roll back by re-granting `anon`/`authenticated` (that re-opens the exposure). If a legitimate path fails after the migration: (a) find the failing request (Render/PostgREST logs: 401/403/`42501`, table and verb); (b) confirm which key it uses; (c) if it is `service_role`, `grant select, insert, update, delete on public.<table> to service_role;` (it should never be needed); (d) if a genuine client needs anon/authenticated access, add a narrowly scoped **policy** for that table and verb plus the exact column-level `GRANT`, review it, and apply it as a separate migration; (e) keep RLS on. Full state restore (all grants as before) is only for a confirmed outage with no alternative and must be separately authorised; the grant list from the baseline generator is the record to restore from. Database recovery from backup is a separate, owner-driven procedure.

## 16. Outstanding blockers
Backup/PITR verification; log export and attribution of the anon traffic; owner confirmation whether the observed anon sweep was an authorised test; Auth sign-up status; Render access (CLI token expired) for post-deploy log review.

## 17. Exact changes requiring approval
1. Apply `db/20261016_ochiga_office_p0_access_hardening.sql` to production (or, if delayed, the one-line containment in section 7).
2. Optional admin credential precaution (forced resets; revoke pending invitations).
3. Dashboard change: disable unused Auth sign-ups.
4. Optional, if tables are ever created by `supabase_admin`: `alter default privileges for role supabase_admin in schema public revoke all on tables from anon, authenticated;` (and sequences/functions) executed as `supabase_admin`.
Classification: **POTENTIAL INCIDENT — INVESTIGATION REQUIRED** (remediation itself: ready for controlled security deployment once the backup decision and approval are given).
