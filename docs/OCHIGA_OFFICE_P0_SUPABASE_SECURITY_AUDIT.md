# Ochiga Office — P0 Supabase security audit

Date 2026-10-14. Production project `metbajilbqclwjfsxfps` ("Ochiga marketing and sales agent"). All production access was read-only catalog/statistics SQL; no unauthorized-write test was run against production, no row content of sensitive tables was read or is reproduced here (masked identifiers only), and nothing was changed.

## 1. Executive summary
**Confirmed:** 50 of 54 `public` tables have row-level security disabled, the 4 others have it enabled with no policies, and the Data API roles `anon` and `authenticated` hold **all** table privileges (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER) on **all 54 tables** (Supabase default privileges, never revoked). PostgREST serves schema `public` by default, so anyone with the project's public anon key could read, change, delete or truncate customer, staff and credential data over HTTPS. This was reproduced end to end in a production-equivalent disposable database (16/16 anonymous or authenticated attacks succeeded, including reading password hashes and reset/invite token hashes and deleting audit events).
**Used:** the database's own statistics show the `anon` role has executed PostgREST statements against Office tables, including INSERT/UPDATE/DELETE and reads of `admin_users`. This is the only evidence in this audit that the exposure was exercised; it cannot be attributed (section 10). **Classification: POTENTIAL INCIDENT — INVESTIGATION REQUIRED.** A tested, additive fix is ready (section 7 of the remediation document); it has not been applied to production.

## 2. Confirmed production exposure
| Control | Finding |
|---|---|
| Tables / RLS | 54 ordinary tables in `public`; RLS off on 50; RLS on, 0 policies on `deployment_projects`, `facility_workspaces`, `onboarding_emails`, `partners`. `FORCE ROW LEVEL SECURITY` nowhere. 0 policies in the whole schema. Owner of all: `postgres` (BYPASSRLS). |
| Grants | `anon` and `authenticated`: ALL 7 privileges on all 54 tables (incl. TRUNCATE). `service_role`: SELECT/INSERT/UPDATE/DELETE on all 54 (BYPASSRLS). Schema `public`: USAGE to PUBLIC, anon, authenticated, service_role. |
| Default privileges | `postgres` and `supabase_admin` default ACLs grant anon/authenticated/service_role everything on future tables, sequences and functions in `public`. |
| Exposed API | PostgREST default (`public`); no `pgrst.*` role override. `pg_graphql` is not installed, so GraphQL does not add exposure. |
| Views / sequences / functions | 0 views, 0 sequences; 1 function (`set_updated_at`, trigger function) executable by anon/authenticated (harmless). |
| Storage | one bucket `office-media` (private, 21 objects); RLS on all `storage` tables, **no policies** ⇒ anon cannot read objects. |
| Supabase Auth | 0 users. Sign-ups may still be enabled (not readable from SQL): a self-registered user becomes role `authenticated`, which has the same table privileges as anon today. Dashboard check required. |
| Gateway effect | nothing in the database or repositories narrows the exposure; WAF/gateway configuration is not visible from SQL. |
Effective result: **50 tables fully readable/writable/deletable/truncatable by an anonymous caller; 4 protected only by RLS-deny.** Machine-readable per-table matrix (metadata only): `docs/security/p0-baseline-privilege-matrix.json`.

## 3. Affected-table inventory (54 tables)
- **T0 credentials / audit (4):** `admin_users` (password_hash, qr_credential), `admin_invites` (token_hash), `password_reset_tokens` (token_hash), `audit_events`.
- **T1 private staff communication (6):** `staff_conversations`, `staff_conversation_participants`, `staff_messages`, `staff_message_attachments`, `staff_message_reads`, `staff_message_reactions`.
- **T1 customer / CRM (15):** `leads`, `lead_memories`, `lead_channel_states`, `inbound_events`, `conversations`, `timeline_events`, `crm_contacts`, `crm_organizations`, `crm_opportunities`, `crm_activities`, `crm_tasks`, `demos`, `proposals`, `notifications`, `traces`.
- **T2 internal documents and relationships (11):** `office_documents`, `office_files`, `office_document_folders`, `office_letterhead_config`, `office_private_relationships`, `office_partnership_relationships`, `office_reports`, `office_meetings`, `office_handoffs`, `office_staff_profiles`, `office_staff_capabilities`.
- **T3 operational (18):** `deployment_projects`*, `facility_workspaces`*, `ochiga_workflow_links`, `office_analytics`, `office_buildings`, `office_content_items`, `office_development_projects`, `office_devices`, `office_estates`, `office_homes`, `office_packages`, `office_portfolio_entries`, `office_projects`, `office_support_cases`, `office_support_mappings`, `office_wallets`, `onboarding_emails`*, `partners`* (*RLS on, no policy).

## 4. Effective anonymous access assessment
Reachability is proven twice: (a) the disposable replica using the same Supabase Postgres image, the same roles and the same default ACLs, plus real PostgREST, where an anonymous token read `password_hash`, both token tables, leads, staff messages, patched an opportunity, deleted audit events and inserted a `super_admin`; (b) production's own `pg_stat_statements`, where PostgREST-shaped statements (`WITH pgrst_source AS (...)`) executed as role `anon` against production tables (section 10). No live anonymous request was sent to production.

## 5. Application database dependencies (traced from code, not from variable names)
| Consumer | Project it uses | Key / role | Side | Access | Breaks if anon/authenticated are revoked and RLS enabled? |
|---|---|---|---|---|---|
| Office server `ochiga-lead-agents` (`src/lead-agents/store-supabase.js`, `storage.js`; `render.yaml`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) | this project | **service_role only**; no anon key anywhere in the repo (grep of `src`, `scripts`, `public`, config) | server-side | all tables above, REST `/rest/v1` and `/storage/v1` | **No** (service_role bypasses RLS and keeps its privileges) |
| Office browser code (`public/office`, `public/dashboard`) | none | calls Office HTTP API with a session cookie; contains no Supabase client | client | none | No |
| Website forms, Facility-OS dashboards | none directly | Website posts to Office `POST /api/office/intake`; Website uses Sanity for content | server | none | No |
| WhatsApp ingestion (Meta webhook → Office → store) | this project | service_role via Office | server | `leads`, `inbound_events`, `lead_channel_states`, `conversations`, `timeline_events`, `crm_*` | No |
| Oyi Backend (`Ochiga-backend`, `main`) | **a different project** (`zcpgtd…`, "Oyi estate & smart home") | its own service_role | server | none of this project's tables (only talks to Office over HTTP) | No |
| Facility OS (`facility-oyi`) | the other project (`zcpgtd…`) | anon key of that other project | client | not this project | No |
| Consumer OS / Edge Agent / Oyi site | no reference to this project in any repository | — | — | — | No |
| Supabase Auth, Realtime, Edge Functions | none used (0 auth users; no functions in the repos) | — | — | — | No |
I decoded every hard-coded Supabase key found in the local repositories (role and project ref only): none belongs to this project. Statistics corroborate it: since 2026-08-11 `service_role` made 108,607 calls (267 distinct statements), `anon` 54, `authenticated` 0.

## 6. Backend and frontend key usage
Backend: no use of this project. Frontend: none. Keys that exist for this project: the service_role key (Render secret, `sync:false`) and the project's anon key (not used by any application I could find). No credential was printed or recorded.

## 7–8. Proposed migration and tests
See `docs/OCHIGA_OFFICE_P0_SUPABASE_REMEDIATION.md`.

## 9. Production compatibility assessment
The fix touches only the privileges of `anon`/`authenticated`, RLS flags and default privileges. Every consumer found uses `service_role`, which is neither revoked nor subject to RLS. The only observed `anon` traffic is probing. Risk of breaking a legitimate path is therefore low but not zero where a consumer exists outside what I can see (an unknown client holding this project's anon key, e.g. a hosted environment variable on another Render/Vercel service). Mitigation in the plan: apply, watch PostgREST for 401/403/42501 for 15 minutes, and use the recovery procedure (re-grant narrowly) if a legitimate consumer appears.

## 10. Incident investigation
Available evidence: database statistics and data (read-only).
- `pg_stat_statements` (stats since 2026-08-11; `dealloc=2` means some entries were evicted, so counts are lower bounds): role `anon` ran **24 distinct statements, 54 calls, 45 rows returned in total**. Excluding session wrappers (`set_config`, `COMMIT`), they are ~23 PostgREST data operations, each executed **once**: SELECT (usually one row) on `leads`, `admin_users`, `crm_contacts`, `crm_organizations`, `crm_opportunities`, `crm_activities`, `crm_tasks`, `timeline_events`, `office_handoffs`, `office_private_relationships`, `office_partnership_relationships`, `office_projects`; **INSERT** into `crm_organizations`, `crm_contacts`, `crm_activities`; **UPDATE** `crm_contacts.phone` and `admin_users.role`; **DELETE** from `crm_organizations` and `crm_activities`. The `admin_users` reads selected only non-secret columns (id, email, role, status, display_name, permission_scopes, created_at, last_login_at); none selected `password_hash`. `authenticated`: no statements.
- Shape: one pass over many tables with create-then-delete clean-up and single-row reads — characteristic of a deliberate security test or scanner, not of bulk exfiltration. **Not attributable** (no source IP, no timestamp, no key identity in the database).
- Residue check: no surviving rows with test markers in `crm_*`; the newest organization/contact rows (2026-10-14 17:03 UTC) have `owner = ochiga_website` and a matching `website_intake_received` activity, i.e. the normal intake path.
- `admin_users`: 7 rows (1 super_admin, 4 active ochiga_admin, 2 removed). Every `updated_at` is explained by an audit event within 2 minutes (logins, photo update, admin edits, removals). The anon `UPDATE ... SET role` hit one row; no unexplained change is visible, but a change later overwritten by a legitimate update cannot be excluded. **Owner action: review the role of each admin account.**
- `audit_events`: 915 rows, 0 deletes recorded; but anon could have written/deleted them, so absence of anomalies is weak evidence.
- Not available to me: Supabase API gateway / PostgREST / Postgres logs (the CLI credential cannot read them), Render request logs (Render CLI token expired). **These are required to date and attribute the anon traffic and to detect reads by other callers.** Retention is limited (typically 1–7 days depending on plan): export them immediately (Dashboard → Logs → API/Edge logs, filter `role = anon` or path `/rest/v1/admin_users`, `/password_reset_tokens`, `/admin_invites`, `/leads`).
I am **not** claiming that no breach occurred.

## 11. Known security limitations
- Production recovery checkpoint still unverified (same blocker as the WhatsApp release): see remediation document.
- Sign-ups for Supabase Auth must be checked/disabled in the dashboard; the fix removes the privileges they would carry, but unused sign-up should be off.
- `supabase_admin` default privileges cannot be changed by the `postgres` role; tables created by `supabase_admin` (not by Office's tooling) would still get anon grants. Optional statement provided.
- Schema `public` USAGE remains granted to PUBLIC (Postgres default); with no table privileges it exposes no data.
- Password hashes may have been readable for the whole exposure window; whether they were read is unknown. See credential rotations in the remediation document.
- Page-level protection of the Office API itself (API-key/session auth) was not re-audited here.
