# WhatsApp autonomy control — production deployment report

Date: 2026-10-14. **Result: DEPLOYMENT BLOCKED — BACKUP VERIFICATION BLOCKED.**

Per the deployment instructions, the database recovery checkpoint had to be verified before anything in production changed. It could not be verified with the access available to me, so I stopped. **Nothing was changed:** no migration applied, no code pushed to `codex/office-extraction` or `main`, no Render action, no configuration, no data change. Autonomous responses were not touched (the new code is not deployed; production still runs the old Office build that replies automatically — see "Risk while blocked").

## 1. Production recovery verification — what was and was not established
Not established (blocking):
- The Supabase Management API backup listing (`supabase backups list`, project `metbajilbqclwjfsxfps`) failed locally with "Invalid access token format" — the stored CLI credential works for project/SQL calls but not for this command. I did not extract the stored token to call the API by hand.
- Therefore I could not read: plan tier, whether daily physical backups or Point-in-Time Recovery is enabled, the latest completed backup, or the earliest/latest restorable timestamp.
Supporting evidence only (read-only SQL, not proof of a usable checkpoint): `archive_mode = on`, `wal_level = logical`, `archive_command` = Supabase's `admin-mgr wal-push`; `pg_stat_archiver`: 1,685 WAL segments archived, **0 failures**, last archive 2026-10-14 17:05:39 UTC (≈15 min before the check; idle database). This is consistent with a backup/PITR mechanism being active but does not say a base backup exists, what the restore window is, or that it is restorable.
Render: the Render CLI token has expired (`render login` required), so I could not confirm that the previous deploy ids (Backend `dep-dav12l1srm7s73bij0t0`, Office `dep-db2epjnlk1mc73b5j8qg`) are still current or read the services' auto-deploy settings.

## 2. Pre-deployment baseline captured (read-only)
Git: Office production `codex/office-extraction` = `33c44c80e11adfc97fe59461e1c4977e2cb2611f`; approved release `5ab4d766b841ae079d85f57f8d103a5348c8d35b` is a clean fast-forward (7 commits ahead). Backend production `main` = `3a9956dc139746c592a10cc081d0de7c9a299989`; approved release `44afac3182a709de63642359a783709ae6a0f435` is a clean fast-forward (2 commits ahead, 2 files, +67 lines, only the WhatsApp adapter and its smoke test). Rollback-safe Office build `release/whatsapp-autonomy-office-rollback-safe` = `a0bd54e9609461f84ce091287a33d519decc3c6e` exists on GitHub.
Database (2026-10-14 17:22 UTC): `inbound_events` 252; WhatsApp `message` rows 51 with **39 distinct ids** (the earlier audit saw 47 / 36 — live traffic since; counts must be recomputed at migration time, as instructed); `leads` 67; `lead_channel_states` 15; `crm_activities` 218; `timeline_events` 839; `audit_events` 915. `office_runtime_settings` and `whatsapp_inbound_claims` do not exist yet. Migration history table `supabase_migrations.schema_migrations` has 1 row (the Office SQL has been applied outside the Supabase migration tool).

## 3. Urgent security finding (pre-existing, unrelated to this release, not changed)
In the production `public` schema, **50 of 54 tables have row-level security disabled and the `anon` role holds SELECT, INSERT, UPDATE and DELETE on them**, including `leads`, `inbound_events`, `conversations`, `crm_*`, `lead_channel_states`, `audit_events`, `staff_messages`, `admin_users`, `admin_invites`, `password_reset_tokens`. If the project's public `anon` key is reachable (it is designed to be embedded in clients), anyone holding it can read, alter and delete this data through the Supabase REST API. I did not change anything, because enabling RLS or revoking grants could break Office/Backend if either relies on the anon key. Recommended separate, urgent task: confirm both services use the service-role key only, then enable RLS and revoke anon grants on these tables. The new tables in this release enable RLS.

## 4. Risk while blocked
Until the release is deployed, production still runs the old Office build, which sends automatic WhatsApp replies and has the duplicate-delivery behaviour documented in the reconciliation report. If you want automatic replies stopped immediately, the only prepared option that does not depend on the database is deploying `release/whatsapp-autonomy-office-rollback-safe` (`a0bd54e…`): inbound messages keep entering the CRM and nothing is sent autonomously; staff-confirmed Oma WhatsApp sends are also blocked by that build. That is a deployment to the production branch and needs your decision; I have not done it.

## 5. Exactly what is needed to proceed (owner actions)
1. **Backup proof (any one):** In the Supabase dashboard → project *Ochiga marketing and sales agent* → Database → Backups, tell me (or screenshot) the plan tier and either (a) the *Point in Time* tab's restorable window with its latest restore point, or (b) *Scheduled backups* showing a completed backup within the last 24 hours. If neither exists (e.g. free tier), tell me, and decide between taking a manual export or explicitly accepting that the migrations are additive-only (new tables, no existing data modified) as the checkpoint.
   Alternatively give the CLI a valid personal access token (`! supabase login --token sbp_…`) so I can read the backup list myself.
2. **Render access:** run `! render login` so I can read the service settings, confirm the previous deploy ids, and watch deploys go LIVE. (Render redeploys when the production branch moves, so the fast-forward push is the deployment.)
3. If you accept an alternative checkpoint instead of a verified backup, say so explicitly, because the instructions require me not to substitute one myself.
Everything else is ready: both release SHAs are verified fast-forwards, migrations are tested on a disposable Postgres, and the rollback-safe build exists.

## 6. Final result
**DEPLOYMENT BLOCKED — BACKUP VERIFICATION BLOCKED.**
