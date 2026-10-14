# WhatsApp autonomy — final readiness (2026-10-14)

## Hard-OFF
Production Office `a0bd54e9…` contains the static rule `WHATSAPP_AUTONOMY_HARD_OFF = true` (gates the inbound reply path and the bridge send route). Code-level verification passed earlier (`test-whatsapp-hard-off-rollback.js`). **Live verification is INCOMPLETE:** the Office API was waking from hibernation (503) and later healthy (200), but no authorized test number message was sent, Render logs unreadable. Oyi backend is up (200). Result: HARD-OFF VERIFICATION INCOMPLETE. Nothing was enabled, no Meta/webhook/phone settings touched.

## Permanent switch
- Release candidate: `release/whatsapp-autonomy-office-rc` @ `c91d51776e44b5885490ea6984f16b6913031adb` = the original switch branch (`5ab4d766…`) merged with production `a0bd54e9…` (one conflict file, `server.js`, resolved to the permanent switch; the static hard-OFF is superseded, default remains OFF and fail-closed; the obsolete rollback test was removed as in the original branch). It contains production (fast-forward from production). All 42 Office scripts pass, plus check/lint/build/secrets/deployment validation. Backend `release/whatsapp-autonomy-backend` `44afac31…` is 2 commits ahead of `main` `3a9956dc…` (no divergence); typecheck, build and relevant smokes pass.
- Migrations on the hardened schema (replica of the post-P0 database; applied twice): `office_runtime_settings` and `whatsapp_inbound_claims` both get RLS on; anon and authenticated have no privileges; service_role has SELECT/INSERT/UPDATE/DELETE (via default privileges for `postgres`); service_role insert/select/delete works; anon select is denied; 0 public tables without RLS afterwards. No unsafe grants.
- Behaviors covered by the branch's tests: global OFF, HMAC staff-confirmed attestation, human takeover, CRM persistence, duplicate-webhook claims, Settings control (`office:whatsapp-autonomy:test` passes).
- Deployment plan (NOT executed): (1) fix/confirm Office API is up; (2) apply the two migrations (additive); (3) push RC to `codex/office-extraction` after backing up; (4) deploy Backend release; (5) verify setting reads OFF, inbound persists, no reply; (6) only then consider ON via Settings with a test number.

Verdicts: C. HARD-OFF VERIFICATION INCOMPLETE. D. READY FOR CONTROLLED DEPLOYMENT (after the Office API outage is resolved and the migrations are approved).
