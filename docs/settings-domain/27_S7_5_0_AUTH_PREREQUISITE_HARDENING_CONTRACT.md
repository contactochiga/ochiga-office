# S7.5.0 — Authentication prerequisite hardening: frozen contract

Branch `feature/settings-s1-s2`, starting HEAD `64ef60e` (local = remote, clean worktree verified). Implements the S7.5.0 prerequisites of `25_S7_5_MFA_ARCHITECTURE_AND_RECOVERY_DESIGN.md` §21 and concerns C2/C5 of `26_S7_4_OUTSTANDING_PRODUCTION_CONCERNS.md`. Decisions D-1 and D-10 are adopted as written. **Out of scope:** any MFA enrollment/enforcement code (S7.5.1+), merging, deploying, applying migrations to production, S7.5.1.

## 1. Unified session verification (R0)
- **One cookie reader:** `auth.js authenticateSessionCookie(req, config)` is the only function that calls `readAdminSession`. `enforceAuth` (every protected route) and `GET /admin/session/me` both use it.
- **One live-state check:** `enrichAuthContext` (account loaded and active, 503 on store failure, account id, password binding, generation, legacy policy) is applied to both. `/session/me` no longer has its own copy.
- **Inventory test:** source scan failing if `readAdminSession(` is called anywhere except inside `authenticateSessionCookie`, if `server.js` reads the cookie itself, or if the `/session/me` handler stops calling `enrichAuthContext`; plus a behavioural parity matrix run against both entry points (revoked, replaced account, password changed, store down, deactivated, legacy rejected).

## 2. Password-state binding (`pf`)
- Session tokens gain `pf` = `HMAC(HMAC(sessionSecret,"ochiga-office/session-pf/v1"), passwordHash)` truncated to 128 bits (never the hash).
- `pf` is computed from the hash the **credentials were verified against** (login: the row read for verification; invite accept and password change: the new hash). It is **not** re-read at signing, so a password changed between verification and signing yields a token that is dead on first use.
- `enrichAuthContext` compares `pf` with the live hash: mismatch ⇒ `401 session_revoked` (reason category `password_changed`). Tokens without `pf` (legacy) follow the existing legacy policy (`LEAD_AGENTS_REJECT_LEGACY_SESSIONS`). The check is part of the revocation feature switch (`LEAD_AGENTS_SESSION_REVOCATION=off` disables it with the rest).
- This closes the demonstrated gap: an attacker who signs in with the old password during the bump→write window now holds a token that dies the moment the hash changes.

## 3. Atomic password / status updates with session revocation
- New store operation `updateAdminUserRevokingSessions(userId, patch, {actor})`, patch restricted to `password_hash`, `password_changed_at`, `status`, `removed_at`, `removed_by`. It applies the patch **and** increments `session_generation` (and `sessions_revoked_at/by`) in **one** step: a single Postgres statement (function `office_admin_update_revoking_sessions`, additive migration `db/20261021_admin_atomic_credential_updates.sql`, service role only) and one synchronous mutation with persist-rollback in the file store.
- Capability `supportsAtomicCredentialUpdate()` (probe with a nil id, as S7.4). Where unavailable (migration absent, switch off) the S7.4 two-step path remains, now safe because of `pf`; the response of any flow never claims atomicity it did not get.
- Used by: reset confirmation, self password change, administrator password set, deactivate/reactivate/remove/restore, administrator recovery. Non-credential edits in the same PATCH (name, role, scopes, phone…) are applied by the ordinary update afterwards.
- **Single-use tokens are claimed before use:** reset tokens and invites are claimed with a compare-and-set (`pending → used`) **before** the password is written; if the password write then fails the claim is released best-effort and the failure is reported. Two simultaneous confirmations can no longer both succeed.
- Audit shapes of S7.4 are kept (`sessions_revoked_*`), with `atomic: true|false` recorded.

## 4. Human-account API-key restrictions (D-1)
- `api_key` and `edge_token` callers receive `403 actor_identity_required` (audit `human_account_change_denied`, reason `api_key_not_allowed`, route category only) on every route that creates, changes, invites, removes, restores, deletes, resets or re-photographs a **human administrator account**: `POST /admin/users`, `PATCH /admin/users/:id`, `…/photo`, `…/remove`, `…/restore`, `DELETE …/permanent`, `POST /admin/users/invite`, administrator-issued reset links, and any other writer of `admin_users`, `admin_invites` or `password_reset_tokens` found by the route audit (§6).
- Unchanged: reads (`GET /admin/users`, permissions, invites list) stay available to API keys for existing integrations; machine routes keep using the key; self-service routes already require a session identity.
- Human sessions with the permission keep working exactly as before (positive controls tested). Legitimate recovery is **not** through HTTP and is preserved: env bootstrap, env recovery (S7.0), owner SQL, and the email reset flow (public, token-gated).

## 5. Compatibility and rollout
Additive migration second in order: `20261020` (generation) → `20261021` (atomic function) → code. Code before migration: two-step fallback, `pf` still protects. Legacy tokens: accepted until the owner enables rejection. Old instances in a mixed fleet ignore `pf` and the atomic path (concern C3 procedure applies). Rollback: switch off, or drop only the new function (the down file keeps data).

## 6. Route audit (completed before coding; kept in the final report)
Every `store.updateAdminUser/ensureAdminUser/deleteAdminUser/createAdminInvite/updateAdminInvite/createPasswordResetToken/updatePasswordResetToken` call site in `server.js` was classified: self-service (session identity), token-gated public flow, administrator route (human only, D-1), env bootstrap/recovery (not HTTP). Any call site added later without a classification must fail the inventory test.

## 7. Required tests
Demonstrated failures reproduced and now refused: old-password login during the write window; API key creating a `super_admin`; API key setting an administrator's password; `/session/me` bypassing checks. Positive controls: super_admin session creates/updates/resets/removes users; recovery paths; reset and invite flows; ordinary password change keeps the current browser signed in. Parity matrix, inventory scan, atomic operation (single mutation, rollback, 50-way concurrency, real Postgres + PostgREST), claim races, fallback path, restart persistence. Regressions: S7.0–S7.4, S1–S6, Team permissions, WhatsApp, full suite, repository gates.

## 8. Implementation notes (added after build; the frozen behaviour above is unchanged)
- **Process note:** the first code edits (session reader, `pf`) were made before this contract was committed; nothing was committed ahead of it.
- **Audit hash leak found and fixed:** the pre-fix `PATCH /admin/users/:id` wrote the whole patch to audit metadata, so an administrator-set password stored its **scrypt hash** in `audit_events` (reproduced on the previous code). The route now records `password_set: true`, and `appendAuditRecord` redacts credential-bearing keys (`password`, `password_hash`, `new_password`, `current_password`, `token`, `step_up_token`, `secret`, `session_secret`, `authorization`, `cookie`) at the boundary. **Existing production audit rows are not rewritten by this slice** (see the outstanding decisions).
- **Negative control:** with the password-fingerprint comparison disabled the new tests fail (parity matrix, race tests), proving they exercise the fix.
- **Existing tests changed on purpose:** S7.2 (a hash changed behind the application's back now ends the session, 401, before the grant is read; the grant's own binding is checked by direct verification), S7.4 (failure injection moved to the atomic operation, plus the two-step fallback), S7.1 unchanged.
- **Inventory frozen in `test-auth-prereq-s750.js`:** `updateAdminUser` 11 call sites, `ensureAdminUser` 5, `updateAdminInvite` 1 (each classified in the test), 8 guarded human-account routes.
