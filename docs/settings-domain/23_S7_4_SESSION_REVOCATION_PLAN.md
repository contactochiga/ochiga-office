# S7.4 — Session Revocation Architecture: plan for approval

Branch `feature/settings-s1-s2`, HEAD at review `c585716` (local = remote, clean worktree). **No runtime code, migration file or configuration was changed.** This document is the contract and migration strategy awaiting approval. Evidence scripts (`/tmp/diag1.js`, `/tmp/diag2.js`) were throwaway and are not in the repository.

## 1. Current session architecture (audited)

| Area | Fact |
|---|---|
| Token | `base64url(JSON{email, role, user_id, permission_scopes, exp}).HMAC-SHA256(sessionSecret)`; no id, no issued-at, no generation. Issued only by login and invite-accept (S7.3: `exp` from `resolveSessionTtl`, 1–720 h). |
| Verification | `readAdminSession` (signature, expiry) → `enforceAuth` → `enrichAuthContext`, which **re-reads the admin user on every request**: absent or `status != "active"` ⇒ 401; role/scopes are live. The only per-request state check is therefore `status`. |
| Logout | `POST /admin/session/logout` clears the browser cookie and writes an audit row. **The token itself stays valid until `exp`.** |
| User record | `admin_users` (id, email, password_hash, role, status, permission_scopes, last_login_at, password_changed_at, removed_at…). No session field. `sanitizeAdminUser` strips only `password_hash`. |
| Step-up (S7.2) | Grant bound to user id, session fingerprint (`sid`, hash of the session cookie token), purpose, and a password-hash fingerprint (`pwf`); every use re-checks live account state. Dies with the session only because `enrichAuthContext` rejects first. |
| Store | `updateAdminUser(id, patch)` exists in file and Supabase stores (PostgREST `PATCH`, no atomic increment). S3 already uses SQL functions (RPC) for atomic compare-and-set (`20261019_office_runtime_settings_versioning.sql`). |

### 1.1 Measured gaps (throwaway script against the real server)

```
1 fresh session: 200
2 after deactivation: 401
3 after reactivation (old cookie, never re-logged-in): 200      ← resurrection
4 logout: 200 -> same cookie replayed: 200                       ← logout does not revoke
5 after password change, old cookie replayed: 200                ← password change does not revoke
```
Also: `POST /admin/users/:id/restore` sets `status:"active"` directly, so remove → restore resurrects old cookies as well. Password reset confirmation does not revoke existing sessions either. A stolen cookie therefore survives logout, password reset, and a deactivate/reactivate cycle for up to 30 days.

## 2. Mechanism evaluation

### 2.1 `sessions_valid_after` (timestamp) — rejected as the validity rule
- Tokens carry no issued-at; legacy tokens cannot be dated (`exp − ttl` is unknowable since S7.3 made ttl variable).
- Millisecond ties: a token issued in the same millisecond as a revocation is ambiguous. Resolving ties either way is wrong (resurrect vs. reject-new-login).
- Clock skew: `iat` comes from the app clock, `valid_after` from the app or DB clock; with more than one app instance (or app ≠ DB clock) a freshly issued token can be older than the revocation or vice versa. A skew allowance reopens a revocation window.
- Concurrent issue/revoke has no total order beyond the clock.

### 2.2 Monotonic per-user `session_generation` — **recommended**
- `admin_users.session_generation integer not null default 0`. A token carries `sg` = the generation at issuance. Valid iff `sg === current generation` (equality, not `>=`, so a stale or forged higher value is also refused).
- Revocation = one atomic `session_generation = session_generation + 1`. No clocks, no precision, no skew. Total order is the row's own serialisation.
- **Concurrent issuance vs revocation:** issuance re-reads the generation immediately before signing. A revoke landing between that read and the signature yields a token with the old generation, which is refused on first use: **fail-closed** (the user is asked to sign in again; the stolen-session holder cannot benefit). A revoke that lands first yields a token with the new generation — a legitimate post-revocation login. There is no interleaving that produces a token valid across a revocation.
- **Cost:** zero extra reads; `enrichAuthContext` already loads the user row.
- Informational only: `sessions_revoked_at timestamptz`, `sessions_revoked_by text` for the Team view and audit. **They are never consulted for validity.**

### 2.3 Server-side session table — rejected for S7.4
Enables per-device listing/revocation, but needs a new table, a lookup and cleanup per request, a cookie format change, and a larger migration. Out of proportion for the requirement; can be layered later without breaking generations.

### 2.4 Global epoch variable — not needed
Rotating `LEAD_AGENTS_SESSION_SECRET` already invalidates every session and every step-up grant (the step-up key derives from it) with no code or database (§9).

## 3. Revocation semantics

Validity: `sg === effectiveGeneration(user)` where `effectiveGeneration` = the column value, or `0` if the column is absent/null. A token without `sg` (legacy) is treated as `sg = 0`.

| Trigger | Bumps generation? | Notes |
|---|---|---|
| Sign out everywhere (self) | yes | cookie cleared; optional `keep_current` re-issues a cookie for this browser |
| Admin revokes user | yes | super_admin + team.manage + step-up |
| Password reset confirmation | **yes, always** | before the password write (§7.3) |
| Admin sets another user's password (`PATCH /admin/users/:id`) | yes | |
| Self password change | yes, and **re-issue** this session's cookie | other devices signed out, current stays (needs approval, §11) |
| Deactivation, removal | yes | stops a later reactivation/restore from resurrecting cookies |
| Reactivation, restore | yes (defence in depth) | |
| Role / scope change | no | already live on every request; step-up grants die by the live permission check |
| Admin recovery (S7.0) | yes | recovery also resets password and reactivates |
| Invite accept, login | no | issue with the current generation |
| Logout (this browser) | **no** | remains cookie-clearing; single-token revocation needs a session table (§2.3) — documented limitation |

## 4. Legacy tokens and the migration boundary

- Tokens issued before the code deploy have no `sg`: treated as generation 0. They stay valid until **that user's** first revocation (the bump to 1 kills them) or their `exp`.
- Tokens issued by new code before the migration is applied carry `sg = 0` and meet column-absent ⇒ generation 0: identical behaviour, nothing breaks when the column appears.
- Hard cut-off, owner-controlled: `LEAD_AGENTS_REJECT_LEGACY_SESSIONS=true` refuses any token lacking `sg` (everyone re-signs-in once). Default `false` for rollout. Legacy tokens naturally expire within ≤ 7 days (pre-S7.3) or ≤ 30 days (S7.3-issued, up to the configured duration), so the flag only matters for emergencies or after the window.
- **Rollback hazard (important):** dropping the column resets all generations to 0 and **resurrects revoked sessions** whose token generation was 0. The down migration must therefore leave the column in place by default (§5.3); disabling is a code flag (`LEAD_AGENTS_SESSION_REVOCATION=off`), not a schema drop.

## 5. Additive migration design (NOT applied; proposed file `db/2026XXXX_admin_session_generation.sql`)

### 5.1 Up
```sql
alter table admin_users add column if not exists session_generation integer not null default 0;     -- constant default: no table rewrite on PG11+
alter table admin_users add column if not exists sessions_revoked_at timestamptz;
alter table admin_users add column if not exists sessions_revoked_by text;
alter table admin_users drop constraint if exists admin_users_session_generation_check;
alter table admin_users add constraint admin_users_session_generation_check check (session_generation >= 0);

-- Atomic, serialised by the row lock; returns the new generation. Service role only (same grant model as 20261019).
create or replace function office_revoke_admin_sessions(p_user_id uuid, p_actor text, p_reason text default null)
returns table (session_generation integer, sessions_revoked_at timestamptz) language sql as $f$
  update admin_users set session_generation = session_generation + 1, sessions_revoked_at = now(), sessions_revoked_by = left(coalesce(p_actor, ''), 200)
   where id = p_user_id returning session_generation, sessions_revoked_at;
$f$;
revoke all on function office_revoke_admin_sessions(uuid, text, text) from public;
-- then revoke from anon/authenticated exactly as 20261019 does, grant execute to service_role.
```
Existing users, roles, passwords, scopes and statuses are untouched: every row gets generation 0.

### 5.2 Compatibility
- Old code ignores the new columns (PostgREST `select=*` returns them harmlessly; `sanitizeAdminUser` must additionally strip `session_generation`/`sessions_revoked_*` from Team API output).
- New code before migration: reads absent ⇒ 0, issues `sg:0`; revocation endpoints return `503 session_revocation_unavailable` (store capability probe), nothing changes; the UI hides the controls.
- **Order: migration first, code second, flag last** (§10).

### 5.3 Down (`db/rollback/…down.sql`)
Default is **non-destructive**: drop the function only; keep the columns (comment explains the resurrection hazard). A clearly-labelled optional statement drops the columns for non-production use. The file store gets the same field with no migration.

## 6. Step-up (S7.2) preservation

- Add `sg` to the step-up payload; verification compares to the live generation; new reason category `session_revoked`.
- Because `enrichAuthContext` rejects a revoked session first (401), every grant bound to it already dies; the explicit `sg` check is defence in depth and covers any future caller that verifies a grant without session enrichment.
- New purpose **`session_revocation`** (allow-list becomes `[security_policy_write, session_revocation]`): a policy-write grant must not authorise revoking a user's sessions, and vice versa.
- Grants issued before a bump are rejected after it; grants are never re-bound.

## 7. Permissions, API and errors

| Action | Route | Who | Step-up |
|---|---|---|---|
| Sign out everywhere | `POST /admin/session/revoke-all` `{ keep_current?: boolean }` | the authenticated account owner (human session) | none (it can only reduce the caller's own access) |
| Revoke another user | `POST /admin/users/:id/revoke-sessions` `{ reason? }` | `super_admin` + `team.manage` | **required**, purpose `session_revocation` |

- API-key callers are refused on both (`403 actor_identity_required`); the admin route rejects `:id` equal to the caller (`400 use_self_revocation`) and unknown ids (`404 user_not_found`).
- Idempotent: each call is one bump; the response is `{ ok, user_id, session_generation, revoked_at }` (never a token or hash).
- Errors: `401 session_revoked` (a revoked or stale-generation cookie), `403 step_up_required {reason}`, `403 forbidden`, `503 session_revocation_unavailable` (migration absent / store error, nothing changed), `503 session_verification_unavailable` (below).
- **Write order (fail-safe):** for password flows bump first, then write the password. If the bump succeeds and the password write fails, sessions are lost but the reset token stays unused — harmless. The reverse order could leave stolen sessions alive.

## 8. Audit

New actions, all with actor, request id, target user id, resulting generation, outcome, timestamp, and never a token/password/hash: `sessions_revoked_self`, `sessions_revoked_by_admin` (+ `reason`), `sessions_revoked_password_reset`, `sessions_revoked_status_change`, `sessions_revoked_password_change`, `sessions_revoked_admin_recovery`. Failed attempts: `session_revocation_denied` with a reason category. Rejections of revoked cookies are **counted in logs, not audited per request** (a stolen-cookie replay would otherwise flood the audit store).

## 9. Failure behaviour and break-glass

- **Database outage:** today a store error in `enrichAuthContext` surfaces as a generic 500 with the raw error message. Proposed: map it to `503 session_verification_unavailable` with no detail; never fail open, never trust the token alone.
- **Revocation write fails:** nothing is reported as revoked; user sees an error; retry is safe.
- **Break-glass, in order of reach:** (a) S7.0 recovery mode additionally bumps the generation of the recovered account (DB required); (b) **rotate `LEAD_AGENTS_SESSION_SECRET`** — instantly invalidates all sessions and all step-up grants, no database needed; (c) owner SQL: `update admin_users set session_generation = session_generation + 1 where email = '…'` (or all rows); (d) `LEAD_AGENTS_REJECT_LEGACY_SESSIONS=true`.
- **Administrator lockout:** revoking a user (even the only `super_admin`) only forces a fresh sign-in; the password still works. If the password is also lost, recovery mode (a) restores access. No bypass is added; recovery stays env-gated, audited, and unreachable over HTTP.

## 10. Production rollout risks

| Risk | Mitigation |
|---|---|
| Rolling deploy: old instances don't check generation | revoked tokens still work on an old instance for the overlap window; deploy as a single swap, or accept a minutes-long window; a bump is re-applied by the next request on new code |
| Code before migration | revocation endpoints 503, no behaviour change otherwise; migration is a prerequisite checklist item |
| Rollback drops the column | down migration keeps columns; disable via flag |
| First revoke logs the user out of every device (including legacy-token sessions) | by design; communicated in the UI |
| Self-service sign-out-everywhere as a nuisance by a cookie thief | the victim signs in again with the password; password change + sign-out-everywhere evict the thief |
| PostgREST cannot increment atomically | RPC function; file store is single-writer |
| Team API leaks the generation | strip in `sanitizeAdminUser` |

## 11. Decisions requested

1. Generation (recommended) vs a session table. 2. Self password change: revoke other sessions and re-issue the current one (recommended) vs require re-login. 3. Legacy tokens: keep valid until first revocation with an owner flag (recommended). 4. New purpose `session_revocation`. 5. Bump on reactivation/restore as well as deactivation. 6. Apply the migration to production only after approval (not done here). 7. Map store failures to `503 session_verification_unavailable`.

## 12. Acceptance tests (required before S7.4 is accepted)

Concurrency: 50 parallel bumps return 50 distinct, strictly increasing generations (Postgres suite, as S3); issue-vs-revoke interleavings (revoke between read and sign ⇒ token invalid; revoke before ⇒ valid) via an instrumented store; parallel login + revoke never leaves a valid pre-revoke token. Copied cookies: a cookie copied before sign-out-everywhere fails afterwards (also after password reset, after deactivate→reactivate, after remove→restore). Legacy tokens: no-`sg` token valid at generation 0, dead after a bump, refused with the flag. Role changes: still live; step-up grants die on demotion. Password changes: reset, admin set, self change (current session survives via re-issue, others die). Deactivated users. Database outages: store throws ⇒ 503, never 200; revocation write failure changes nothing; migration-absent mode. Restart persistence: generation survives a restart (file store re-open; Postgres suite). Administrator lockout: sole `super_admin` self-revokes, signs in again, recovery bumps and works. API-key callers refused on both routes. Step-up: grants bound to a revoked session fail; wrong purpose refused. S7.0–S7.3 regressions, S1–S6, S3 Postgres, WhatsApp, Team permissions, full suite, gates.

## 13. Exact implementation plan (after approval)

1. **S7.4.0 prerequisites** (independent, small): clamp the S7.3 environment duration (§14.1); fix the permission-count display (§14.2).
2. **S7.4.1 data layer:** migration + rollback files; `store.revokeAdminSessions(userId, {actor, reason})` and `store.supportsSessionRevocation()` in file and Supabase stores; strip new fields in `sanitizeAdminUser`; Postgres test for atomic monotonic bumps.
3. **S7.4.2 tokens and enforcement:** `sg` claim at issuance (re-read before sign); `readAdminSession` exposes it; `enrichAuthContext` compares; `LEAD_AGENTS_REJECT_LEGACY_SESSIONS`; 401 `session_revoked`; 503 mapping; step-up `sg` + purpose.
4. **S7.4.3 routes:** self and admin revocation routes with audit.
5. **S7.4.4 triggers:** reset-confirm, admin password set, self password change (+ re-issue), status transitions, recovery.
6. **S7.4.5 UI:** "Sign out everywhere" in the account menu; per-user "Sign out all sessions" in Team behind the step-up dialog; hidden when the capability probe fails.
7. **S7.4.6 tests, regressions, gates, delivery report.**

## 14. Investigations requested

### 14.1 S7.3 environment fallback lower bound
Measured with `LEAD_AGENTS_SESSION_TTL_MS` and no stored setting:

| env value | effective | cookie Max-Age | verdict |
|---|---|---|---|
| `0`, `-5`, empty | 168 h (resolver replaces it) | 604800 | ok |
| `1` | **1 ms** | 60 s | token dead on arrival; token and cookie disagree |
| `1000` | **1 s** | 60 s | disagree |
| `59999` | 60 s | 60 s | agree, but absurdly short |
| `3600000` … `2592000000` | 1 h … 720 h | agree | ok |
| `99999999999` | **27 778 h (3.2 years)**, source `environment` | agree | **no upper cap** |

Causes: the 720 h cap exists only on the *fallback* branch; the environment duration is otherwise unvalidated at both ends, and `Math.max(60, …)` in the cookie hides short values. Production sets no `LEAD_AGENTS_SESSION_TTL_MS` in `render.yaml`, so current production is unaffected (168 h), but the dashboard can set it. **Recommendation (S7.4.0):** clamp the environment duration to `[1 h, 720 h]` at config load (invalid ⇒ 168 h), report `session_ttl_clamped` in `/healthz` `auth_config` and a startup warning, and add the lower bound to the fallback branch. No authorization change.

### 14.2 "99 of 56" in the role catalogue
Display-only. The card shows `p.roles[r].length` over `p.scopes.length`. `/admin/permissions` returns `roles` expanded with legacy alias spellings (`view_estates`, `manage_buildings`, … 43 of them), so `super_admin` shows 56 canonical + 43 legacy spellings = 99, against a denominator of 56 canonical keys. `PERMISSION_KEYS` has 56 unique entries; authorization itself uses `permissionsForRole`/`canonicalPermission` and is unaffected. **Fix (S7.4.0, UI only):** count only entries that are in `p.scopes`. Not changed here.

### 14.3 `test-wave9-authority-boundaries` (unresolved, preserved)
Reproduced: **3 of 6 parallel runs failed, 0 of 3 sequential**. Failure: `assert.match(body, /residential/)` receives `{"memory":null}`. Root cause (a test race, not an authorization defect): `recallCrmMemory` captures `now = Date.now()` on entry; the test's `getLeadMemory` stub builds `updated_at = new Date().toISOString()` **after** that, and the function rejects `observed > now` as a future timestamp. Under load a millisecond tick separates the two. Proposed test-only fix: stub a past timestamp (`Date.now() - 1000`). **Deliberately not applied**; recorded as an unresolved regression issue as instructed.
