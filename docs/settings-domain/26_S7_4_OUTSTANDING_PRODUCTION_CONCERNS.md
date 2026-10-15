# S7.4 — outstanding production concerns (documented separately from S7.5)

Branch `feature/settings-s1-s2`, reviewed at `5f0ee65` (local = remote, clean). Documentation only: no runtime change, migration, merge or deployment. These items are **not blockers for the MFA design**, but C2 and C5 must be resolved before MFA enforcement is switched on, and C4 before any production deployment of S7.0+.

## C1. Ordinary logout semantics
**Fact.** `POST /admin/session/logout` clears the browser cookie and audits `session_logout`; the signed token stays valid until `exp` (up to 30 days since S7.3). Demonstrated at S7.4 review (`logout → same cookie replayed: 200`) and recorded as a test (`logout alone only clears the browser cookie`).
**Why it matters.** A cookie copied before logout (malware, shared machine, proxy log) survives the user's deliberate sign-out; the only remedies are "sign out everywhere", a password change/reset, an admin revocation, or secret rotation.
**Options.** (a) Keep, and say so in the UI (current). (b) Make logout bump the generation: correct but signs the user out of every device, which users will not expect. (c) A per-session identifier `jti` in the token plus a small denylist table `admin_revoked_sessions(jti, admin_user_id, expires_at)` written **only on logout and single-session revocation** and pruned after `expires_at`; verification adds one indexed lookup (or rides on the user read). (d) Full server-side session table (also gives device lists).
**Recommendation.** (c): smallest mechanism that makes logout real without changing the generation model; additive migration; legacy tokens (no `jti`) cannot be single-revoked and keep today's behaviour until they expire. Needs an owner decision; schedule after S7.5.0 or as S7.6.

## C2. Password-update atomicity (confirmed gap)
**Fact.** S7.4 writes `bump generation → write password hash` as two operations (fail-safe order: a failed bump leaves the password unchanged). There is a window between them. Throwaway experiment (`updateAdminUser` stalled for the gap):
```
admin sets password: 200 | attacker (old password) signed in during the gap: true
attacker cookie AFTER the password change: 200 | old password still works: false | new password works: true
```
An attacker who already knows the old password — exactly the person a reset is meant to evict — and who signs in inside that window receives a token at the *new* generation that survives the change. The same ordering applies to reset-confirm, self change and admin set; for status changes the window is "deactivate/reactivate". The window is milliseconds on the file store and a PostgREST round trip (tens of ms) on Supabase, widened by retries/timeouts. The S7.4 tests did not cover it.
**Fixes (recommend both, the first without a migration).**
1. **Password fingerprint in the token.** Add claim `pf` = keyed fingerprint of the stored hash at issuance (same idea as step-up `pwf`); `enrichAuthContext` compares it with the live hash. Any change of the hash, in any order, ends every token issued from the old hash: no window, no migration, works on both stores. Self change still re-issues the current browser's cookie; legacy tokens (no `pf`) keep working until they expire or `LEAD_AGENTS_REJECT_LEGACY_SESSIONS`.
2. **Single atomic statement** `office_admin_set_password(user_id, hash, changed_at, actor)` that writes the hash and increments the generation together (and an equivalent for status), used when the migration exists; the two-step path remains as the fallback.
Also: **claim the reset token before using it** (mark `used` with a compare-and-set, then write the password) so a failure after the password write cannot leave a reusable token; today it is written afterwards.
**Required test (new):** a login with the old credential during the write window yields a token that is dead after the change.

## C3. Mixed-version revocation enforcement
**Fact (tested).** An instance running pre-S7.4 code does not check generations; it keeps accepting revoked tokens, issues tokens without `sg`, and password/status changes made on it bump nothing. An S7.4 instance refuses tokens that carry an old generation and, once the account's generation is above 0, refuses `sg`-less tokens (including those issued by an old instance). Tested in `test-session-revocation-s74.js` (rolling-deployment simulation).
**What is and is not guaranteed.** Revocation is effective **per instance running S7.4**; it is globally effective only when no pre-S7.4 instance can still receive requests. The revoke response says `scope: every_server_running_this_version`, the UI repeats it, and `/healthz` exposes `session_revocation.enforcement` per instance. Nothing aggregates across instances, so an operator must not infer global effect from a single health response.
**Procedure until a heartbeat exists.** (1) Apply the additive migration; (2) deploy code with a single swap (stop old before start new, or confirm in the Render dashboard that exactly the new revision is live); (3) confirm `/healthz` reports `enforcement: active` and `capability: available`; (4) optionally rotate `LEAD_AGENTS_SESSION_SECRET` at cutover (kills every old-format token, no database needed) or, after the swap, set `LEAD_AGENTS_REJECT_LEGACY_SESSIONS=true`; (5) only then treat sign-out/revocation as global. The same rule applies to every future enforcement feature, **MFA in particular**: an old instance would accept a password alone (see S7.5 §13).
**Possible improvement (not implemented).** New instances write a heartbeat row (`instance id, version, enforcement flags, seen_at`) to the runtime-settings store so a status endpoint can list recently active instances; it cannot detect old instances (they write nothing), so it only supports the manual procedure above.

## C4. API-key-as-password dependency audit (still open)
**Status.** Not established. Repository: no caller uses an API key as a password. Production: could not be verified in this environment (production reads are not permitted here); one earlier aggregate showed a single account whose display name equals its email, consistent with the bootstrap admin only, but incomplete. S7.0 therefore shipped the fallback **off by default** with a deliberate, audited transitional switch.
**Owner action before production deployment** (read-only SQL, run by the owner; also in `19_S7_0_AUTH_SECURITY_CONTRACT.md` §3.3):
```sql
select email, role, status, created_at, last_login_at from admin_users where lower(display_name) = lower(email);
select actor_email, count(*) from audit_events where action in ('session_login','user.login') and created_at > now() - interval '60 days' group by 1 order by 2 desc;
select count(*) from audit_events where action = 'session_login_api_key_fallback';   -- only exists once S7.0 has run
```
**Decision tree.** Every listed account is a deliberate administrator and nobody signs in who is not a named team member → deploy with the fallback off (no action). Someone relies on it → issue Team invites first, deploy with `LEAD_AGENTS_ALLOW_API_KEY_LOGIN=true` only as a transition, remove it afterwards. **Hard rule for S7.5:** the fallback mints an account and a session from a shared secret with no second factor, so it must be off before any MFA stage above "off" (S7.5 §12 makes `/healthz` and boot validation enforce it).

## C5. (New, found while reviewing S7.5) API keys can create and take over human administrator accounts
**Fact.** `authorizePermission` lets every `api_key` context pass every permission check. Throwaway experiment against the real server:
```
API key creates a super_admin: 201 | that account can sign in: true
API key sets the existing super_admin's password: 200 | attacker can sign in as them: true
API key at step-up: 403   (S7.2 refuses API keys)
```
S7.2/S7.3/S7.4 closed this for settings writes, step-up and revocation, but `POST /admin/users` and `PATCH /admin/users/:id` (role, status, password) still accept the shared API key. With passwords alone this is "API key = full takeover"; with MFA it means an API-key holder can plant a new `super_admin` and enroll their own authenticator, or reset a factor if MFA routes were ever reachable by key.
**Recommendation (decision D-1, before MFA enforcement):** deny API-key callers on every human-account mutation (`/admin/users*` POST/PATCH/remove/restore/permanent, invites, MFA routes), keeping read access if integrations need it; keep the key for machine routes. Requires an inventory of legitimate API-key users of those routes (none found in the repository).
