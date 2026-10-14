# Ochiga Office P0 Supabase security — release readiness

Project: Ochiga marketing and sales agent (`metbajilbqclwjfsxfps`). Nothing in production has been changed. **The database is NOT secured until the migration is applied and verified.**

## Classification
**BLOCKED — RECOVERY VERIFICATION REQUIRED** (with the incident indicators below noted; log review pending).

## 1–3. Exposure, grants/RLS, function/view exposure
All 54 `public` tables: `anon` and `authenticated` held full privileges (550 table-level grants, 55 column grants in the replica equivalent); RLS was off on 50, on without policies on 4. Production catalog (read-only): 0 PUBLIC relation grants, 0 column ACLs, 0 policies, 0 SECURITY DEFINER functions, 0 views/matviews/partitioned/foreign tables, 1 function. The replica reproduces 16/16 attacks (hash/token reads, writes, deletes, truncate) as anon/authenticated.

## 4. Default-privilege findings
Creators with CREATE on `public`: `postgres`, `supabase_admin`. `postgres` defaults are changed by the migration. `postgres` is not a member of `supabase_admin`, so `supabase_admin` defaults cannot be changed by the migration: remaining exposure = ACL entries on objects `supabase_admin` creates in `public` (tables, sequences, functions). Mitigated by revoking schema USAGE from anon/authenticated. Privileged action needed: run `db/privileged/20261016_supabase_admin_default_privileges.sql` as `supabase_admin` (Supabase support). Not certified closed. `service_role` access to future tables is preserved (tested for both creators).

## 5–6. Dependencies and changes
Office uses only the service_role key server-side; no browser Supabase client; other repos use other projects. 108,607 service_role calls vs 54 anon, 0 authenticated since 2026-08-11. Changes: migration `db/20261016_ochiga_office_p0_access_hardening.sql`, verification SQL, privileged script, emergency containment SQL, tests, reports, test-only `createTempStore` hook. No runtime application change.

## 7–8. Tests
`npm run office:p0-supabase-hardening:test`: PASS (attacks 16/16 pre, refused post; views/matviews/sequences/SECURITY DEFINER/column grants closed; rollback after forced failure; idempotent rerun; per-creator default ACL; 31/39 Office scripts identical pre/post via real PostgREST, 0 refused). `npm run office:p0-containment:test`: PASS. `check`, `lint`, `build`: pass. Failures: none new; 8 Office scripts fail identically before and after (file-store/other-service dependent).

## 9–10. Incident indicators and forensics
`pg_stat_statements` shows about 54 anon statements (lower bound: dealloc occurred): one sweep of about 23 operations with create-then-delete cleanup, single-row reads, `admin_users` reads not selecting `password_hash`, no surviving artifacts. All `admin_users.updated_at` values correlate with audit events; roster 1 super_admin + 4 active ochiga_admin + 2 removed. Not ruled out: reads of other data. Supabase API/Postgres logs and Render logs were not accessible (CLI tokens invalid), so the masked timeline and request-level evidence are NOT complete. Baseline preserved in `docs/security/p0-baseline-privilege-matrix.json`.

## 11. Recovery status
UNVERIFIED. `supabase backups list` rejects the CLI token; dashboard not accessible to me. Options: **A)** verify scheduled backup/PITR window in the Supabase dashboard (Database > Backups); **B)** take a controlled authorized export (`pg_dump` data+schema of `public`, stored privately, never printed); **C)** explicit written authorization to apply the narrowly scoped, reversible restriction without a verified backup. Not selected.

## 12–13. Containment and migration readiness
Containment SQL tested and available (limits in remediation doc §18); not applied; needs owner approval of that exact step. Full migration is replica-verified and ready except for the recovery prerequisite.

## 14–15. Release branch
`release/office-supabase-p0-security`, based on `origin/codex/office-extraction` (`a0bd54e9609461f84ce091287a33d519decc3c6e`, the production HEAD with WhatsApp hard-OFF). Pure fast-forward; contains only migration, verification, tests, docs and the test hook. SQL is independent of the WhatsApp autonomy switch (hard-OFF unchanged).

## 16. Exact production SQL (run only after approval)
```
cd <repo> && supabase link --project-ref metbajilbqclwjfsxfps
supabase db query --linked -f db/20261016_ochiga_office_p0_access_hardening.sql
supabase db query --linked -f db/verification/20261016_p0_access_hardening.verify.sql
```
Expected: verification queries 1,2,3,7 return 0 rows; 4 `missing_tables=0`; 8 anon=false, authenticated=false, service_role=true; 9 shows `supabase_admin` default_acl_still_grants=true (known residual). The migration prints a WARNING about `supabase_admin`.

## 17–18. App impact and verification checklist
Expected impact: none (service_role only). After applying: anon REST `GET /rest/v1/admin_users` => 401/403; Office login, intake, a CRM read and a staff message work; WhatsApp connected, inbound reaches CRM, autonomous replies remain OFF; row counts unchanged.

## 19. Blockers
1. Backup/PITR unverified (hard blocker). 2. Supabase and Render logs unavailable for the incident timeline. 3. `supabase_admin` default privileges need a privileged actor. 4. Owner approval for the production step.

## 20. Recommendation
Do option A now (dashboard) or B; then approve the migration. If a delay is expected and the exposure is judged active, choose C or the containment SQL explicitly. Export the Supabase API/Postgres logs and Render logs for the incident review. Rotation of admin credentials should be a coordinated, separate decision.
