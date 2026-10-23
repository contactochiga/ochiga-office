# S7 R11 — Production Database Evidence Reconciliation

Baseline: R10 final `06693c4`. Production project: Supabase `metbajilbqclwjfsxfps` ("Ochiga marketing and sales agent", PostgreSQL 17.6, London). Date of the production reads: 2026-10-23 (≈18:45–19:00 UTC).
Nothing was applied to production, merged, deployed, or MFA-enforced. This document supersedes the production-exposure assumptions of docs 48 (R5) and 53 (R10); the trusted-proxy conclusion of doc 53 is unchanged (UNKNOWN, hops stay 0).

## 0. How production was read, and what that touched (disclosure)

* **Method:** the project owner's already-signed-in Supabase CLI, `db query --linked` (Management API), running **SELECT-only catalog queries**. Every statement was wrapped by a local runner in `begin read only … rollback` and refused unless it started with `select`/`with`. Raw outputs are kept in `/Users/ochigaidoko/s7-prod-evidence/out`; a sanitised copy (no row estimates, no customer data) is committed in `docs/settings-domain/evidence/r11-production-catalog/`.
* **Read:** `pg_class`, `pg_attribute`, `pg_proc`, `pg_policy`, `pg_default_acl`, `pg_namespace`, `pg_roles`, `pg_indexes`, `pg_constraint`, `pg_trigger`, `pg_extension`, `information_schema.columns`, role-level aggregates of `pg_stat_statements` (role name, statement count, call count — **never query text**), the *DDL text* of the one hardening migration in `supabase_migrations.schema_migrations`, and **count-only** queries on four platform tables (`storage.buckets` 1, `storage.objects` 21, `auth.users` 0, `realtime.subscription` 0). **No row of any application table, no password hash, token, secret, key or customer record was selected.** Row-count figures used in this report are planner estimates from `pg_class` (all application tables are in the hundreds of rows or fewer; the largest is `audit_events`, ≈800).
* **Side effect of the tool, not of a query:** the Supabase CLI creates/refreshes a temporary login role `cli_login_postgres` (member of `postgres`; login enabled, but its password was valid for only 5 minutes — until 18:54 UTC — and has expired). It already appears in the `public` schema ACL, i.e. it existed when the hardening migration ran on 14 Oct. It is the owner's CLI mechanism; the owner may `drop role cli_login_postgres` at will. Its 27 statements are visible in `pg_stat_statements`.
* **Not readable from SQL (UNVERIFIED, owner step):** the PostgREST "Exposed schemas" setting, backups/PITR status, the code version running on Render, Edge Functions or other holders of the `service_role` key.

## 1. Reconciliation: the owner's evidence against R5–R10

| Owner statement / earlier assumption | Production measurement | Verdict |
|---|---|---|
| RLS on all 58 public tables | 58 of 58 ordinary tables `relrowsecurity = true`; 0 policies; 0 `FORCE` | **Confirmed** (deny-by-default, no policy) |
| No SELECT/DELETE/TRUNCATE for anon/authenticated | **No privilege of any kind** (7 table privileges × 2 roles × 58 tables = 0), no column-level grant, no sequence grant, no PUBLIC entry on any relation, and **no `USAGE` on schema `public`** for anon/authenticated/PUBLIC | **Confirmed and stronger** than stated |
| Views / SECURITY DEFINER | 0 views, 0 materialised views, 0 SECURITY DEFINER functions in `public`; `public` holds exactly one function (`set_updated_at()`, SECURITY INVOKER, `service_role` only) | **Confirmed** |
| R5: credential tables exposed to the Data API (finding H1) | Closed in production by `ochiga_office_p0_access_hardening` (version `20261014210318`, 2026-10-14 21:03 UTC); verbatim text stored in the evidence folder | **H1 is closed in production** (it remains a defect of the *repository bootstrap*, i.e. of any fresh environment) |
| R10: "50 of 65 public tables lack RLS, anon/authenticated hold every privilege" | That was the state of the **repository bootstrap on a disposable fixture**. Production has 58 tables (the repo chain also yields 58) and none lacks RLS | **Not true of production**; the R10 business-tables proposal is not needed there |
| R10: "Supabase default privileges grant anon/authenticated ALL on new tables" | Default ACL for objects created by `postgres` in `public` is `postgres`+`service_role` only (changed by the migration). Objects created by `supabase_admin` still name anon/authenticated (the migration warned it could not change them) — neutralised by the schema `USAGE` revoke | **Mitigated** for the role migrations run as |
| R10: "other Supabase consumers UNKNOWN" | `pg_stat_statements` since 2026-08-11: `service_role` 207k calls, PostgREST's `authenticator` 99k (internal), platform roles, `anon` **55** calls in 25 statements, `authenticated` 1. No Supabase Auth users, no realtime publication tables, no `pg_cron`/`pg_net`, no database webhooks, no storage policies. Backend, Facility and Consumer production live in **a different project** (`zcpgtdakqxyvjkmiibei`, `docs/WAVE9_MIGRATION_LEDGER.md` in the Backend repository); the marketing-site repository contains no Supabase client code | **No application uses the public roles on this project.** Remaining unknown: other holders of the service key |
| R10/c02 `ROLE-210` | cannot be reproduced against production; it was a fixture artifact | **Obsolete for production** |
| R10 chain tests | valid for fresh environments; they did not model the production hardening | **Extended** by the R11 rehearsal (§5) |

Measured facts that do **not** match any earlier document: the production catalog has **one index no repository migration records** (`admin_invites_admin_user_id_idx`) and **8 tables whose column order differs** from the bootstrap (`admin_invites, admin_users, conversations, leads, notifications, office_buildings, office_documents, office_estates` — production added those columns by `ALTER`). Names, types, nullability, defaults, constraints and triggers of all 783 columns / 131 constraints / 128 indexes are otherwise identical to the repository chain through `20261018`. The Supabase migration history holds only two entries (`20260521114108`, `20261014210318`): **repository migrations are applied by hand and leave no ledger**.

## 2. Remaining surface audit (production)

| Item | Result |
|---|---|
| Column-level grants (anon/authenticated/PUBLIC), all `public` columns | **0** |
| Default privileges | `postgres`/`public`: tables, sequences, functions → `postgres`, `service_role` only. `supabase_admin`/`public` and `graphql`, `graphql_public`, `storage` still name anon/authenticated (platform defaults). Only matters for objects created by those roles; none of Office's migrations are |
| Function execute | Nothing in `public` is executable by anon/authenticated. PostgreSQL still grants `EXECUTE` to PUBLIC on *new* functions by default (a schema-level default revoke cannot remove it); each S7 migration revokes explicitly, and the schema `USAGE` revoke is a second barrier (proved: every function the chain adds is `service_role`-only, R11-C05) |
| Exposed schemas | The PostgREST setting is **UNVERIFIED** (not in SQL). Reach was measured instead: `public` unreachable for anon/authenticated; `storage` — RLS on every table, 0 policies, one private bucket (`office-media`), anon has no row access; `realtime` — `messages` RLS on, `subscription` has 0 rows and a platform-default grant; `graphql_public.graphql()` callable by anon but `pg_graphql` is **not installed** and no relation is reachable; `extensions.pg_stat_statements*` readable through PUBLIC (platform default; by PostgreSQL design a non-privileged role sees only its own statements); `vault` not usable by anon/authenticated. **Owner step:** Dashboard → Settings → API → *Exposed schemas* should read `public` (and nothing else is needed by Office) |
| Roles | Only Supabase platform roles plus the CLI login role. `anon`/`authenticated` have `statement_timeout` 3 s / 8 s; `anon` retains the PostgreSQL default `TEMP` privilege (harmless) |
| Dependencies between migrations | Enforced by guards: `20261022`→needs `20261020`; `20261023`→`22`; `20261024`→`23`; `20261025`→`24`; `20261026`→`20`; `20261029`→`25`; `20261030`,`20261031`→`22`; `20261021`→`20261020` (its function reads/writes the generation columns; no guard); `20261019`,`20261028`→none beyond the base; `20261027`→base tables only (but see §3) |

## 3. Is each migration 20261027–20261031 (and the rest of the chain) necessary on THIS database?

Method: each migration was applied to a fixture built from the **repository chain through `20261018` plus the verbatim production hardening migration**, and the fixture was first proven equal to the production catalog (R11-A10…A19, below).

| Migration | Production state today | Classification | Evidence / consequence of NOT applying |
|---|---|---|---|
| 20261014, 15, 17, 18 | Tables present, shape identical | **Already applied / redundant** | applying each changes nothing (shape, indexes, constraints, triggers, privileges byte-identical: R11-X-*) |
| 20261019 settings versioning | absent | **Necessary** (S1) | Settings reads work; **every governed setting write is refused with 503 `settings_versioning_unavailable`** (nothing written) |
| 20261020 session generation | absent | **Necessary** (S1) | no account-wide revocation: `revoke-all` answers 503; password change does **not** sign out other sessions |
| 20261021 atomic account update | absent | **Necessary** (S1) | credential change uses the older two-step path |
| 20261026 revoked sessions | absent | **Necessary** (S2) | ordinary logout only clears the cookie: a copied cookie stays valid until expiry |
| 20261028 shared rate limits | absent | **Necessary** if more than one instance or restart-proof throttling is wanted (S3) | counters stay per process (`/healthz` reports `scope: process`) |
| 20261022–25, 20261029–31 MFA data layer | absent | **Optional until MFA is scheduled** (S4); apply as one block | MFA is off by default; with it off nothing reads these objects (proved: S4 smoke). With `LEAD_AGENTS_MFA=on` `/healthz` is 503 until all of it exists |
| **20261027 data API lockdown** | the four credential tables, the settings table, the three queue tables and `set_updated_at()` already have exactly the state it asserts | **Redundant for everything it names today** — applying it to the production-shaped database changes **no** relation ACL, column ACL, RLS flag, function ACL, schema ACL or default ACL (R11-B02). **Partially applicable afterwards:** its last section narrows `service_role` on `office_runtime_setting_history` (no UPDATE/DELETE/TRUNCATE — the append-only evidence) and on the MFA credential tables (no DELETE/TRUNCATE). That only has effect **after** those tables exist, so it must run **after S1 and again after S4** (R11-B11/B12, S4-vs-S5 gate) | not applying it leaves `service_role` able to TRUNCATE the settings history and the MFA tables created later |
| 20261028 / 29 / 30 / 31 | see rows above | 28 = S3; 29, 30, 31 = part of S4 | — |

Net: **the repository's data-lockdown work (R5/R10) is already satisfied in production by a stronger, earlier measure; the pending work is the S7 *feature* schema, not exposure remediation.**

## 4. Risk to Office, Facility, Consumer and Backend

* **Facility / Consumer / Backend databases:** unaffected — they live in another Supabase project. The Office project's only measured application consumer is the Office server (service role). Office reaches those systems over HTTP gateways, which no migration here touches.
* **Office server — schema changes:** all migrations are additive. Locks are brief (`ALTER TABLE … ADD COLUMN` with defaults on `admin_users`, ≈6 rows, and `office_runtime_settings`, 2 rows; PostgreSQL 17 adds such columns without rewriting). PostgREST reloads its schema cache by itself (the production database has the `pgrst_ddl_watch` event triggers).
* **Proven compatibility (R11 rehearsal, real server, real PostgREST, production-shaped database):** (a) S7 code works at every stage S0…S5 (sign-in, session, reads of RLS-protected tables, settings, password change, logout); (b) the **older WhatsApp-release code (`5ab4d76`, the likely deployed code)** keeps working before, **during** (running process) and after the whole pending chain, so *migrations first* is safe for it; (c) a migration that lands under a running S7 process is picked up within a minute without a restart (`20261028`: R11-E02); (d) staff sessions open before S1 stay valid through S1 and S2 (R11-G01/G02); (e) the full staged rollback, newest first, runs clean, loses no account/history/credential row, leaves only `set_updated_at()` and the kept append-only trigger function, keeps every baseline protection, and the application still works (R11-H).
* **Behaviour changes staff will notice (intended):** after S1 a password change or `revoke-all` signs the other browsers out; after S2 logout kills a copied cookie. **Residual:** a session opened *before* S2 carries no per-session id, so a copied cookie from it cannot be revoked one by one; it ends at expiry, at `revoke-all`/password change, or when the session secret is rotated (R11-G04/G05). If that matters, rotate the session secret once after S2 (signs everyone out once).
* **Information exposure introduced by the schema (low):** both the older release and S7 sanitise staff objects by removing only `password_hash`, so after S1/S4 the staff list API (`view_users`) also returns `session_generation`, `sessions_revoked_at/by`, and `mfa_active_count/failed_attempts/locked_until/required_after/reset_at/reset_by`. None is secret-bearing (checked every stage: R11-*-11; `qr_credential` is an ID-badge payload that is already returned today and is accepted by no authentication path). Recommended follow-up (not done here, to avoid changing contract behaviour): switch `sanitizeAdminUser` to an allow-list.
* **Operational:** no migration ledger exists (§1); the repo references a privileged script `db/privileged/20261016_supabase_admin_default_privileges.sql` (in the hardening migration's warning text) that is **not in the repository** — closing the `supabase_admin` default ACLs is therefore undone; low risk because schema `USAGE` is revoked.

## 5. Evidence produced (all in the repository)

* `scripts/test-production-rehearsal-postgres-r11.js` — disposable Supabase-flavoured Postgres 17 + PostgREST only. Sections: **A** production-shaped fixture equals the measured production catalog (tables, 783 columns, 128 indexes, 131 constraints, triggers, functions, default ACLs, schema ACL, empty Data API exposure) and the bootstrap re-run changes no privilege; **B** `20261027` is a byte-identical no-op on that state, and must follow the tables it narrows; **C** the full pending chain in numeric order, twice, leaves the Data API closed; **D** the staged rollout S0…S5 with the real application at each stage and the same final catalog and privileges as numeric order; **E** a migration landing under a running process, plus a **negative control** (granting anon access is detected by the exposure query, the Data API and the gate script, and revoking restores it); **F** an interrupted stage is reported PARTIAL/NO-GO, and the four migrations production already carries are no-ops; **G** sessions opened during the rollout; **H** full reverse rollback and re-apply; **I** the older release against the migrated schema.
* `scripts/sql/production-rollout-gates.sql` — one read-only statement for the owner. Run on production today (`rollout_gates_2026-10-23.json`): **10 of 10 baseline rows PASS; S1, S2, S3, S4 ABSENT; S5 NOT_APPLICABLE; ORDER rows PASS; VERDICT GO.** The same script returns the expected statuses at every fixture stage, NO-GO on a partial stage and NO-GO when the baseline is broken (negative control).
* `docs/settings-domain/evidence/r11-production-catalog/` — sanitised production catalog, the verbatim hardening migration, gate output.
* Regression on the final commit — see §7.

## 6. Production-specific rollout recommendation

**Decision for the DATABASE (owner-applied, nothing applied by this task):** **CONDITIONAL GO** for S1 → S2 → S3 → S5; **DEFER S4** until MFA is scheduled; **the S7 application deployment remains NO-GO** for the reasons carried from R10 (trusted-proxy chain UNKNOWN, area-D interface findings, recertification needed) — the database stages are independent of it because the currently deployed code is proven compatible with them.

**GO conditions — every one must be true before the first statement, and re-checked before each stage:**
1. `scripts/sql/production-rollout-gates.sql` returns **VERDICT = GO** (or GO-WITH-REVIEW only for the documented FOLLOW-UP S5 row) and the stage rows are exactly what the next stage expects.
2. A restorable backup / point-in-time-recovery marker exists **(owner to confirm — not readable by this task)**.
3. Low-traffic window; one person applies one file at a time in the Supabase SQL editor (runs as `postgres`, as in the rehearsal) and posts the gate output after each.
4. For S1–S3 the Render service runs the WhatsApp release tested here (`5ab4d76`) or later, including the S7 code (all proven); **confirm the deployed commit** — an older release was not tested. No code deploy is required first.
5. `LEAD_AGENTS_TRUSTED_PROXY_HOPS` is untouched (0); `LEAD_AGENTS_MFA` is off; no secret is changed.
6. Owner has checked Settings → API → *Exposed schemas* (`public` only).

**Order and what each stage is:**
| Stage | Files (in this order) | After it, `/healthz` and gate show | Rollback (non-destructive) |
|---|---|---|---|
| S1 | `20261019`, `20261020`, `20261021` | `session_revocation.capability = available`; gate S1 APPLIED; verdict GO-WITH-REVIEW (FOLLOW-UP S5 pending) | `db/rollback/…21`, `…20`, `…19` — drop functions only; columns and history are kept; set `LEAD_AGENTS_SESSION_REVOCATION=off` to disable the feature |
| S2 | `20261026` | durable logout for sessions opened afterwards | `…26` drops the 3 functions, keeps the revoked-session table |
| S3 | `20261028` | `rate_limit.scope = shared` | `…28` drops the ephemeral counters; instances fall back to per-process |
| S5 | `20261027` (whole file) | gate S5 APPLIED, FOLLOW-UP PASS, VERDICT GO | intentionally a no-op (re-opening is a manual, knowing act) |
| S4 (later) | `20261022, 23, 24, 25, 29, 30, 31` as one block, **then `20261027` again** | gate S4 APPLIED | reverse order `31…22` (all provided) |

**STOP conditions:** any BASELINE row FAIL; any stage PARTIAL; a migration error (run the matching rollback, re-run the gate); sign-in failures after a stage; PostgREST errors in the Supabase logs. Never apply a later migration "to fix" an earlier partial one — roll back, then re-run.

**After S2, optional:** rotate the session secret once if copied pre-S2 cookies are a concern (signs every staff member out once).

## 7. Regression on the final commit

Run on the working tree that became the final commit (only this document changed afterwards); evidence in `/Users/ochigaidoko/s7-prod-evidence/runs/final`.

| Check | Result |
|---|---|
| `check`, `lint`, `build`, `security:secrets`, `deployment:validate` | all exit 0 |
| `npm audit` | 0 vulnerabilities |
| Full Office suite (`run-all-tests.js`) | **86/86** (196 s) |
| Postgres/PostgREST suites (`--postgres`) | **17/17** (490 s), including the new rehearsal (152 s) and the R10 chain test |
| New rehearsal alone | **131/131** checks, 0 failed |
| Certification group (`--cert`) | first run **3/4**: `cert-browser.js` timed out on a UI wait (`waitFor`) immediately after the heavy Postgres run — the intermittent-under-load signature recorded in R10, **not** caused by this change (no application code changed in R11). Isolated runs 2/2 passed; full re-run **4/4** (26 s). Reported, not hidden |

Infrastructure notes: the first rehearsal drafts failed because the test pointed the application at PostgREST directly instead of through the `/rest/v1` gateway the application expects (test bug, fixed; no product defect), and PostgREST's schema cache had not been reloaded after the fixture was built (also fixed). Docker, the Supabase 17 and PostgREST images were available throughout. The frozen certification corpus and its manifest were not touched.

## 8. Unresolved / UNKNOWN

* Backup/PITR availability; the PostgREST *Exposed schemas* value; the code version actually running on Render (assumed ≈ `5ab4d76`; both it and the S7 code are proven compatible); other holders of the `service_role` key (usage statistics cannot distinguish them from the Office server).
* The unrecorded production index `admin_invites_admin_user_id_idx` (harmless; a foreign-key index) and the absence of a migration ledger.
* The missing `db/privileged/20261016_supabase_admin_default_privileges.sql`.
* Not part of this task and unchanged from doc 53: trusted-proxy chain (UNKNOWN, hops 0), area-D interface findings, c01 `MIG-411`/`MIG-527`, c02 `ROLE-302`, recertification by a fresh independent corpus, MFA enforcement (not enabled).
