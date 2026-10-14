# Ochiga Office — post-P0 security verification (2026-10-14, ~21:00–21:30 UTC)

## Production identifiers
- Office `codex/office-extraction` = `a0bd54e9609461f84ce091287a33d519decc3c6e` (confirmed via GitHub). Backend `main` = `3a9956dc139746c592a10cc081d0de7c9a299989` (confirmed). Render service state was NOT readable (CLI token expired).
- Supabase `metbajilbqclwjfsxfps`: latest migration `20261014210318 ochiga_office_p0_access_hardening`.
- Backup archive `p0-20261014T205115Z.tar.enc` present; SHA-256 re-computed = `cadcdeec…7d16a` (matches). Passphrase untouched.

## Live database revalidation (read-only SQL as the CLI login role)
54 public tables, RLS disabled 0; anon/authenticated table privileges 0 (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER); column privileges 0; PUBLIC relation ACL entries 0; sequence privileges 0; functions executable by anon/authenticated 0; policies 0 (none appeared); views/matviews/foreign tables 0; SECURITY DEFINER functions 0; extensions in `public` 0; schema USAGE anon/authenticated/service_role/postgres = false/false/true/true; service_role full CRUD on 54/54.
Row counts now: leads 67, inbound_events 253, crm_activities 218, audit_events 915 (identical to the post-migration checkpoint).
Negative PostgREST tests (public anon key, GET limit 1 only, no writes): `admin_users`, `admin_invites`, `password_reset_tokens`, `audit_events`, `leads`, `crm_contacts`, `crm_organizations`, `crm_activities`, `inbound_events` => HTTP 401 `42501 permission denied for schema public`; OpenAPI root refused; unknown RPC 404. `authenticated` was tested at privilege-catalog level only (no authenticated JWT exists/was used).

## supabase_admin default ACLs — NOT CLOSED
`pg_default_acl` still has 24 `supabase_admin` entries in `public` (tables r, sequences S, functions f) granting anon/authenticated. Effect: objects `supabase_admin` creates later get those ACLs, but anon/authenticated have no schema USAGE, so the Data API cannot reach them (tested in the replica). The script `db/privileged/20261016_supabase_admin_default_privileges.sql` was inspected: three `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ... FROM anon, authenticated` statements (+ commented optional global PUBLIC-EXECUTE lines, deliberately not active). Replica-tested as `supabase_admin`: new tables become closed to anon, open to service_role. It affects only objects created by `supabase_admin` in `public` afterwards; no extension lives in `public`; Supabase-managed schemas are untouched. No privileged execution path exists here (`postgres`/CLI login role is not a member of `supabase_admin`; I will not impersonate it). **Not executed.** Support request to send: "Project metbajilbqclwjfsxfps: please run as supabase_admin: `alter default privileges for role supabase_admin in schema public revoke all on tables from anon, authenticated; ... on sequences ...; ... on functions ...;` then confirm `pg_default_acl` rows for supabase_admin/public no longer grant anon/authenticated. Do not change schema USAGE or other roles."

## Application health (what was actually exercised)
- office.ochiga.com.ng: HTTP 200 (static site). Oyi backend `https://oyi-os.onrender.com/health`: 200, `status ok`, runtime counters last seen 17:03 UTC.
- **Office API `https://ochiga-lead-agents.onrender.com` is DOWN: every path hangs, then HTTP 503 with `x-render-routing: hibernate-wake-error` (the free-plan service cannot wake).** Office code does no database work at startup (`SupabaseLeadAgentsStore.init()` is a no-op), the replica differential suite shows the code works on the hardened schema, and the last Office writes (17:39 UTC) predate the migration (21:03 UTC), so the migration is not the evidenced cause — but I cannot prove it without Render logs/dashboard. **Impact: while it is down, WhatsApp inbound, website intake and staff login to Office do not work.**
- NOT exercised (API down, no authorized test accounts/credentials available, no browser session): login, CRM pages, messages, documents, invitations, password reset, WhatsApp webhook, form intake. I do not claim they passed.
- Replica proof for service_role paths: 54/54 tables readable, Office suite identical before/after, 0 refused requests.

## Tests
Office on production code: `check`, `lint`, `build`, `security:secrets`, `deployment:validate` pass; all 39 `scripts/test-*.js` pass (file store); through PostgREST on the hardened replica 31/39 pass identically before/after (8 fail in both phases, written for the file store). Backend on release branch: `typecheck` + `build` pass; communication-runtime, goal-runtime, communication-automation-action, communications-layer, whatsapp-send-origin smokes pass; `communications-office-auth-compat` fails identically on `main` (needs `SUPABASE_URL` in the environment: environmental, pre-existing).

## Authentication audit (code/data level only)
Admin roster (masked): 1 super_admin, 4 active ochiga_admin, 2 removed; password-reset/invite tokens are stored as hashes (columns exist), no policies or anon access remain. No live login/reset/session-expiry test was possible (API down). No defect verified, so no code change made. No passwords reset, no sessions revoked.

## Verdicts
A. DATABASE SECURITY: **PARTIALLY SECURED — REMAINING ISSUES** (current exposure closed and verified; `supabase_admin` default ACLs open at ACL level; incident review incomplete).
B. APPLICATION OPERATIONS: **PRODUCTION REGRESSION FOUND / NOT FULLY VERIFIED** — Office API down (503 hibernate-wake-error); cause unproven.
E/C/D: see the other reports.
