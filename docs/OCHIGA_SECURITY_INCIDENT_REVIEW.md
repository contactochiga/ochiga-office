# Ochiga Office — security incident review (evidence available as of 2026-10-14)

Verdict: **POTENTIAL INCIDENT — FURTHER INVESTIGATION.** No breach is claimed and none is excluded.

## Sources
Available: Postgres `pg_stat_statements` (role-level counters, lower bounds), Office `audit_events` and `admin_users` (masked), catalog history. **Unavailable:** Supabase API-gateway/PostgREST/Postgres logs and Render logs (no valid dashboard/CLI token; the Supabase CLI session cannot read logs; Render CLI is unauthorized). Therefore timestamps of individual anonymous requests, source IPs, user agents and exact endpoints/methods are NOT established. Owner action: export Supabase Logs (API Gateway, PostgREST, Postgres; since 2026-08-01) and Render logs, or provide a log-capable token.

## Findings
1. Before 2026-10-14 21:03 UTC anon/authenticated had full privileges on all 54 tables, so any holder of the public anon key could read/write. `pg_stat_statements` recorded ~54 `anon` calls (lower bound; entries evicted) vs 108,607 `service_role` and 0 `authenticated`.
2. The anon activity resembles one scan: ~23 REST operations, create-then-delete cleanup, single-row reads on `crm_organizations`, `crm_contacts`, `crm_activities`, `admin_users` (not selecting `password_hash`). No surviving test artifacts were found. Attribution (authorized test vs outsider) is not established.
3. Admin roles (masked): `d626f5` super_admin (created 2026-04-10), `201dab`, `b03067`, `6354a4`, `b28cef` active ochiga_admin; `79d044`, `5bb1bf` removed 2026-09-01. Every `admin_users.updated_at` value falls within 2 minutes of an Office audit event (logins, photo/user updates, removals) by an authenticated actor; role/staff changes in `audit_events` were performed by `d626f5` (super_admin) or `b03067`, the last on 2026-09-17. No admin was created or elevated without an audit event. An anonymous write that preserved the same values would leave no trace, so absence of evidence is not proof. **Owner to confirm each of the five active accounts against the legitimate staff list.**
4. After the migration: no audit events after 2026-10-11 16:27 UTC; row counts unchanged since the post-migration checkpoint; pg_stat shows no new anon activity patterns beyond the historical counters (counters cannot be time-sliced). Post-migration anonymous requests now receive 401 42501.
5. Possible disclosure: anon could have read any table before the migration (password/token hashes, staff conversations, CRM data); no read log exists to prove or disprove. 

## Recommendation (not executed)
Obtain the logs above and re-run the timeline. Until the logs are reviewed, treat password hashes and invite/reset tokens as potentially exposed: plan a coordinated staff password rotation + pending-token invalidation (needs your approved communication plan). Evidence preserved: encrypted pre-migration backup, baseline privilege matrix, this review. Nothing was deleted or rewritten.
