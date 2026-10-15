# Workspace deployment Steps 1–2 — backup and migration report (2026-10-15)

Authorised: Step 1 (fresh encrypted backup + restore verification) and Step 2 (apply `db/20261017_whatsapp_manual_sends.sql`). Not done: Step 3 (Office feature branch is NOT merged or deployed; production Office is still `c91d51776e44b5885490ea6984f16b6913031adb`).

## Step 1 — backup (status: BACKUP CREATED — RESTORE VERIFIED)
* Project `metbajilbqclwjfsxfps` (linked project ref confirmed before every action). Taken ~07:27–07:29 UTC via `supabase db dump` (schema incl. grants/RLS/functions/indexes; data in COPY format; role settings) plus per-table count / RLS / content-hash baseline and default-ACL/privilege metadata.
* Storage: `~/Ochiga-private-backups/p1-20261015T072702Z.tar.enc`, outside Git, 0700/0600, AES-256-CBC + PBKDF2 (600k), passphrase only in the macOS Keychain (item `ochiga-backup-p1-20261015T072702Z`). Size 2,589,728 bytes. SHA-256 `9e2916b18e319213d1ee0df466ddb1cc635f55fa03a5e3219a69fbae61fa127e`. Decrypt round-trip verified against pre-encryption checksums; all plaintext and the disposable restore container were removed.
* Restore test (isolated Supabase Postgres 17.6.1.131): roles 0 errors; schema 2 benign errors (references to the CLI's temporary login role and a platform role absent in the test container); data errors only in platform-managed `auth`/`storage` tables (same as the previous backup). **Reconciliation: 56/56 public tables, 4,195 rows, RLS flags and per-table content hashes identical to production at backup time**; 1 function, 119 indexes, 0 policies, service_role DELETE on 56/56 restored.
* Limits (unchanged): logical backup, not PITR; `auth`/`storage` objects and storage-bucket files not included; production restore not rehearsed. Includes the autonomy setting row written by a super admin at 06:26–06:27 UTC (value false).

## Step 2 — migration (status: APPLIED AND VERIFIED)
Applied to `metbajilbqclwjfsxfps` as role `postgres` (`set role postgres` + the unchanged file, sha256 prefix `f0dd7971…`). Preflight: table and column absent, 56 tables, RLS-off 0.
Independent verification (catalog queries + service_role/anon/authenticated probes inside rolled-back transactions):
* `whatsapp_manual_sends`: owner `postgres`; RLS on; 0 policies; ACL `postgres` + `service_role` only (no `anon`, no `authenticated`, no PUBLIC); 19 columns as designed.
* Constraints: primary key; **UNIQUE (lead_id, actor_email, client_request_id)**; status CHECK (pending / provider_accepted / provider_rejected / outcome_unknown / not_sent).
* Indexes: lead+created_at, open-state partial index, unique key index, primary key; `conversations.correlation_id` (text, nullable, 0 non-null rows) with unique partial index `conversations_correlation_id_uidx`.
* Service role: insert OK; second claim with the same key inserts 0 rows (`ON CONFLICT DO NOTHING`) and a plain duplicate is blocked by the unique key; update OK; CHECK enforced; delete OK — all rolled back, table has 0 rows.
* anon and authenticated: `42501 permission denied for schema public` (SQL) and HTTP 401 `42501` through the REST API for the new table, `conversations` and `office_runtime_settings`.
* Global: 57 public tables, RLS-off 0, anon/authenticated privileges 0, PUBLIC ACL entries 0, 0 policies, anon/authenticated schema USAGE denied, service_role USAGE and CRUD on 57/57.
* Data preserved: leads 68, conversations 316, audit events 917 identical immediately before and after the migration (inbound events/claims/activities rose only through live WhatsApp traffic, e.g. owner tests, not the migration). `whatsapp_manual_sends` is empty.
* **Autonomy remains OFF**: `whatsapp_autonomous_responses_enabled = false` (saved by a super admin through Settings at 06:26 and 06:27 UTC; not touched by this work).
* Production health afterwards: Office `/healthz` 200, Backend `/version` 44afac31…; Office code unchanged.

## Readiness for Step 3
Ready, subject to your explicit approval of Step 3: fast-forward `codex/office-extraction` from `c91d51776e44b5885490ea6984f16b6913031adb` to the feature branch (HEAD `c68f8ba10aeb4f78f4cfe4171e29783cc0bcf2ac` before this report commit). The migration is in place first, as planned, so the new code will find its ledger. Post-deploy checks as listed in the release-readiness report (healthz, served `office.js` hash, autonomy still OFF, one controlled reply to an approved test number).
