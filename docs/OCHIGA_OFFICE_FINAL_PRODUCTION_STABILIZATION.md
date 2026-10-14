# Ochiga Office — final production stabilization (2026-10-14, ~21:45 UTC)

Nothing was deployed, purchased, migrated or enabled in this pass. Only read-only checks, replica tests and docs.

## 1. Architecture
Website/WhatsApp (Meta webhook) -> Office API (Render `ochiga-lead-agents`, Node, service_role only) -> Supabase `metbajilbqclwjfsxfps` (54 public tables). Office -> Oyi Backend (Render `Oyi-os`) for intelligence; Backend -> Office communication bridge for WhatsApp sends (HMAC staff attestation).
## 2. Live SHAs (rechecked)
Office `codex/office-extraction` = `a0bd54e9609461f84ce091287a33d519decc3c6e`; Backend `main` = `3a9956dc139746c592a10cc081d0de7c9a299989`. Both unchanged. Render deployment IDs: not readable (Render CLI unauthorized). Health: Office `/healthz` 200 (2.6 s), Oyi `/health` 200.
## 3. Render reliability
`render.yaml` declares `plan: free`; the actual dashboard plan could not be read (no valid Render token). Evidence of free-plan behavior: 503 `x-render-routing: hibernate-wake-error` for ~5 minutes around 21:15–21:19 UTC, then recovery with `uptime_ms` ~108 s. Free web services spin down after 15 minutes idle and use a 750 instance-hour monthly pool. Restart history, memory/CPU and webhook failure logs were not available. Meta retries failed webhooks for a limited time, so a sleeping instance risks delayed or lost inbound messages.
## 4. Recommendation
**Starter instance, $7/month** (0.5 vCPU, 512 MB RAM, always on; Render pricing page, searched 2026-10-14, to be re-confirmed at purchase). Upgrading an existing service in place keeps its URL, env vars, database and Meta configuration (no new service); a brief restart is expected (typically a minute or two) — confirm in the dashboard. Rollback: downgrade back to Free in the dashboard. A keep-alive ping is not equivalent. **Exact approval needed: "Upgrade `ochiga-lead-agents` (srv-d7adj6ogjchc73fnqkj0) to Starter at $7/month."** Not purchased.
## 5. Authenticated CRM verification — NOT PERFORMED
No authorized staff credentials or browser session are available to me, so login, session, roles, CRM pages, messages, documents, notifications, invitations, password reset and Backend connectivity were not exercised through the UI. What IS evidenced: Office `/healthz` returns live counts read through service_role from the hardened database; unauthenticated API routes return 401; all 39 Office test scripts pass; through real PostgREST on the hardened replica 31/39 pass identically before/after (8 fail in both, file-store-only); Oyi runtime healthy. Blocker: need a test staff account (or an owner-run walkthrough).
## 6. Supabase security (live re-query)
54 tables, RLS off 0, anon/authenticated SELECT 0, anon schema USAGE denied, migration `20261014210318` present, backup checksum still matches. **VERIFIED CURRENT ACCESS CONTROLS**; `supabase_admin` default ACLs (24 entries) still open to ACL cleanup.
## 7. WhatsApp hard-OFF — live evidence after the P0 migration
At 21:29 UTC a WhatsApp inbound message (test) created a lead, persisted in `inbound_events` and the CRM timeline, and the timeline recorded `whatsapp_autonomous_reply_suppressed` with reason `hard_off_rollback_build`; no outbound reply, template or send appears in any table created after 21:28. A `status:delivered` event followed (a delivery receipt for an earlier message; no new outbound recorded). This shows ingestion works on the hardened database and OFF is enforced. Strictly: customer-side receipt of no reply was not observed by me, and Backend event forwarding was not independently traced. Verdict: **HARD-OFF VERIFIED (database/code evidence), with the above caveats.** Current counts: leads 68, inbound_events 255.
## 8–10. Permanent switch / migrations / dedup
RC `release/whatsapp-autonomy-office-rc` @ `c91d51776e44b5885490ea6984f16b6913031adb` = switch branch + production (contains `a0bd54e9…`; default OFF; fail-closed). Backend `release/whatsapp-autonomy-backend` @ `44afac3182a709de63642359a783709ae6a0f435`, 2 commits ahead of main, no divergence. Tests: Office check/lint/build/secrets/deployment validate pass; `office:whatsapp-autonomy:test` PASS (control + store/UI; covers global OFF, fail-closed unreadable setting, audit, HMAC attestation, takeover, claims); 42/42 scripts pass. Backend typecheck, build, whatsapp-send-origin, communication-runtime, goal-runtime, automation-action, communications-layer smokes pass; `communications-office-auth-compat` fails identically on main (needs `SUPABASE_URL`; environmental, historical).
Migrations replica-tested on the hardened schema (twice): both tables get RLS; anon/authenticated none; service_role CRUD. Current production data: 53 WhatsApp message events, 41 distinct provider ids would be seeded as claims (9 historical duplicate ids preserved untouched; 0 messages lack an id). `office_runtime_settings` and `whatsapp_inbound_claims` do not yet exist in production. HMAC contract (recipient, content, communication id, timestamp freshness, forged labels rejected) is covered by the branch tests; the shared secret is reused between Office and Backend — future hardening: separate signing keys.
## 11. Known limitations
Render plan/logs unreadable; no authenticated UI test; Backend forwarding of the 21:29 event untraced; autonomy migrations not applied; Supabase/Render log timelines missing.
## 12. Safe deployment order (needs approval; autonomy stays OFF)
1 verify backup + baseline (done today) -> 2 [A1] apply both autonomy migrations -> 3 verify tables/RLS/service_role -> 4 [A2] fast-forward Backend `main` to `44afac31…` (auto-deploys Oyi-os) -> confirm health -> 5 [A3] fast-forward Office `codex/office-extraction` to the RC `c91d5177…` (auto-deploys; first perform [A0] Starter upgrade so the restart happens once) -> health -> 6 confirm setting reads OFF, inbound persists with no reply, Settings UI shows OFF, audit trail -> 7 leave OFF.
## 13. Rollback
Migrations are additive (down scripts exist in the branch; tables unused by the old build). Code: roll Office back only to `a0bd54e9…` (hard-OFF), never to a pre-hard-OFF build; Backend back to `3a9956dc…`. Do not restore anon/authenticated grants.
## 14. Open security tasks (unchanged, not resolved)
A `supabase_admin` default privileges (needs Supabase support/privileged role); B anonymous-request attribution (needs Supabase/Render logs); C admin account confirmation against the staff list; D password/token exposure assessment; E credential rotation decision; F log retention/monitoring.
## 15. Approvals needed
A0 Starter upgrade ($7/mo). A1 apply the two autonomy migrations to production. A2 Backend `main` fast-forward. A3 Office `codex/office-extraction` fast-forward. Plus: a staff test account, Render/Supabase log access, and an approved WhatsApp test number for the post-deploy check.

## Conclusions
- RENDER RELIABILITY: **UPGRADE RECOMMENDED**
- OFFICE CRM: **PARTIALLY VERIFIED**
- DATABASE SECURITY: **VERIFIED CURRENT ACCESS CONTROLS** (remediation items A–F remain open)
- WHATSAPP: **HARD-OFF VERIFIED** (with caveats above)
- PERMANENT SWITCH: **READY FOR CONTROLLED DEPLOYMENT**
