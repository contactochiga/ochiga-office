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
- **Office API `https://ochiga-lead-agents.onrender.com`: initially unresponsive** (requests hung, then HTTP 503 `x-render-routing: hibernate-wake-error` for ~5 minutes, 21:15–21:19 UTC; free-plan service waking). At ~21:30 UTC it answered `200` on `/healthz` with `uptime_ms` ~108,000 (i.e. it had just started) and live statistics read from the hardened database through service_role: leads 67, conversations 316, admin_users 7, audit_events 915, estates 25, documents 14, etc. This is direct evidence that the production app, on its freshly started process, reads the database after the P0 migration. Unauthenticated `/api/office/session`, `/api/office/leads`, `/api/leads` and an empty POST to the WhatsApp webhook path => 401 (auth enforced). Cause of the slow wake is not evidenced as migration-related (the app does no DB work at startup); this free-plan hibernation will recur: WhatsApp webhooks arriving while it sleeps risk delay/loss, consider a paid plan or keep-alive (not changed).
- NOT exercised (API down, no authorized test accounts/credentials available, no browser session): login, CRM pages, messages, documents, invitations, password reset, WhatsApp webhook, form intake. I do not claim they passed.
- Replica proof for service_role paths: 54/54 tables readable, Office suite identical before/after, 0 refused requests.

## Tests
Office on production code: `check`, `lint`, `build`, `security:secrets`, `deployment:validate` pass; all 39 `scripts/test-*.js` pass (file store); through PostgREST on the hardened replica 31/39 pass identically before/after (8 fail in both phases, written for the file store). Backend on release branch: `typecheck` + `build` pass; communication-runtime, goal-runtime, communication-automation-action, communications-layer, whatsapp-send-origin smokes pass; `communications-office-auth-compat` fails identically on `main` (needs `SUPABASE_URL` in the environment: environmental, pre-existing).

## Authentication audit (code/data level only)
Admin roster (masked): 1 super_admin, 4 active ochiga_admin, 2 removed; password-reset/invite tokens are stored as hashes (columns exist), no policies or anon access remain. No live login/reset/session-expiry test was possible (API down). No defect verified, so no code change made. No passwords reset, no sessions revoked.

## Verdicts
A. DATABASE SECURITY: **PARTIALLY SECURED — REMAINING ISSUES** (current exposure closed and verified; `supabase_admin` default ACLs open at ACL level; incident review incomplete).
B. APPLICATION OPERATIONS: **NOT FULLY VERIFIED** — Office API and Oyi healthy and reading the hardened DB, but authenticated browser workflows and the WhatsApp webhook were not exercised; no regression found.
E/C/D: see the other reports.
