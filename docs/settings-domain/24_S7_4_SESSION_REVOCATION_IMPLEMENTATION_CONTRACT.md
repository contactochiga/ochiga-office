# S7.4 — Governed Session Revocation: frozen implementation contract

Branch `feature/settings-s1-s2`, starting HEAD `9d3f16c` (local = remote verified). Implements the approved architecture in `23_S7_4_SESSION_REVOCATION_PLAN.md`. The seven open decisions in §11 of that plan are resolved as its recommendations, which the implementation brief adopts explicitly (password-change revocation, legacy-token mechanism, `session_revocation` purpose, reactivation protection, 503 mapping). Out of scope: S7.5, per-device session tables, single-token logout revocation, applying the migration to production.

## 1. Session generation

- `admin_users.session_generation integer not null default 0` (check `>= 0`), plus informational `sessions_revoked_at`, `sessions_revoked_by`. Validity **never** uses the timestamps.
- Revocation is one atomic increment: Postgres function `office_revoke_admin_sessions(p_user_id, p_actor, p_reason)` (service role only); the file store increments synchronously inside its single writer.
- `effectiveGeneration(user)` = the column when it is a non-negative integer, else `0`.
- A token is valid iff `token.sg === effectiveGeneration(user)` **and** the token's `user_id` equals the live account id. The id check is what stops a deleted-then-recreated account (same email, new id) from inheriting old session validity; it is applied even when the generation matches.
- Issuance re-reads the account immediately before signing. A revoke landing in between yields a token that is refused on first use (fail-closed).
- Feature switch `LEAD_AGENTS_SESSION_REVOCATION` (default on; `off` disables generation checks, issuance claim and the revocation routes without touching the schema — this is the rollback lever).

## 2. Token compatibility

Payload adds `sg` (integer). Cookie format, signature, `exp`, 7-day/S7.3 duration and cookie flags are unchanged. A token without `sg` is **legacy** and is treated as generation 0.

## 3. Legacy-token transition

- Default: legacy tokens stay valid while the user's generation is 0, and die on that user's first revocation.
- `LEAD_AGENTS_REJECT_LEGACY_SESSIONS=true` rejects every token lacking `sg` (401 `session_revoked`, reason category `legacy_session` in logs). `/healthz` reports `session_revocation.legacy_tokens: "accepted" | "rejected"`.
- Tokens issued by new code before the migration carry `sg:0` and read an absent column as 0, so nothing changes when the column appears.

## 4. Password-change behaviour

| Flow | Behaviour |
|---|---|
| Reset confirmation | bump first, then write the password; no session issued (unchanged) |
| Admin sets a user's password | bump first, then write |
| Self-service change | bump first, write the password, then **re-issue a cookie for this browser at the new generation** (S7.3 duration); every other session is signed out |
| Deactivate / remove / reactivate / restore | bump on every status change |
| Admin recovery (S7.0) | bump, with the password reset and reactivation |
| Role / scope change | no bump (already live per request) |

If the capability is unavailable (switch off, migration absent) these flows **proceed** and audit `skipped`; if the capability is available but the bump fails the flow **fails closed** (503, password unchanged).

## 5. Revocation routes

- `POST /admin/session/revoke-all {keep_current?}` — the authenticated account owner, human session; no step-up. Clears the cookie, or re-issues one when `keep_current` is true.
- `POST /admin/users/:id/revoke-sessions {reason?}` — human session, `team.manage`, S7.2 grant with **purpose `session_revocation`**. Order: session type → permission → step-up → target (404) → not self (400 `use_self_revocation`) → capability → bump.
- API-key callers: `403 actor_identity_required` on both. Responses carry generation numbers and a timestamp, never a token or hash.

## 6. Step-up

`STEP_UP_PURPOSES = [security_policy_write, session_revocation]`; a grant verifies only for the purpose it was issued for. Payload adds `sg`; verification compares it with the live generation (`session_revoked`). A revoked session is also rejected earlier by `enrichAuthContext`, so its grants die either way.

## 7. Database failure handling

Store errors while loading the account for a session request map to `503 session_verification_unavailable` (no error text, never fail-open, token alone is never trusted). Revocation writes that fail change nothing and return `503 session_revocation_unavailable`. Migration-absent mode: revocation routes return that same 503, the UI hides the controls, issuance and checks keep working at generation 0.

## 8. Administrator recovery and break-glass

S7.0 recovery additionally revokes the recovered account's sessions. Further levers, in reach order: rotate `LEAD_AGENTS_SESSION_SECRET` (all sessions and grants, no database), owner SQL bump, `LEAD_AGENTS_REJECT_LEGACY_SESSIONS`. Revoking the only `super_admin` only forces re-sign-in; recovery mode restores a lost password. No new bypass.

## 9. Rollback and deployment requirements

Order: **migration → code → switch/flags**. Rolling-deployment honesty: instances running pre-S7.4 code do not check generations and keep accepting revoked tokens until replaced. The revoke responses and the UI therefore state that sign-out takes effect on every server running this version, `/healthz` exposes `session_revocation.enforcement`, and **global revocation must not be claimed until every instance reports enforcement active** (or the session secret is rotated). Rollback: set `LEAD_AGENTS_SESSION_REVOCATION=off`; the down migration drops only the function and **keeps the columns** (dropping them would reset generations and resurrect revoked sessions). Production application of the migration is out of scope.

## 10. Prerequisites in this slice

1. Environment session duration clamped to `[1 h, 720 h]` at config load (invalid/zero/empty ⇒ 168 h), reported as `session_ttl: ok|defaulted|clamped` in `/healthz`, with a startup warning; the S7.3 fallback also gets the 1 h floor.
2. People & Access role catalogue counts canonical permissions only (display; authorization untouched).
3. `test-wave9-authority-boundaries` stub timestamp made deterministic (test-only).

## 11. Audit

`sessions_revoked_self`, `sessions_revoked_by_admin`, `sessions_revoked_password_reset|password_change|admin_password_set|status_change|admin_recovery`, `sessions_revocation_skipped`, `session_revocation_denied`: actor, target user id, request id, outcome, generation before→after, timestamp, failure reason category. Never passwords, tokens, grants, secrets. Rejections of revoked cookies are logged as counters, not audited per request.

## 12. Required tests

Copied cookies; logout vs revocation; password change/reset/admin set; deactivate→reactivate and remove→restore; deleted→recreated accounts; concurrent issuance/revocation and generation monotonicity (Postgres); legacy tokens with and without the reject flag; wrong/expired step-up purposes; API-key callers; database outage; restart persistence; migration rollback and reapply; recovery; rolling-deployment simulation (pre-S7.4 instance accepts a revoked token, S7.4 instance refuses); UI. Regressions: S7.0–S7.3, S1–S6, S3 Postgres, Team permissions, WhatsApp, full suite, gates.

## 13. Implementation notes (added after build; behaviour above is unchanged)

- **A second verification site was found and closed:** `GET /admin/session/me` reads the cookie itself (it is public for the login screen) and previously checked only `status`. It now applies the same generation, account-id and store-failure rules (found by the copied-cookie test, not by review).
- **Password hash leak closed:** the self-service password-change success body returned the raw user row including `password_hash` to the account owner; it now returns `sanitizeAdminUser`.
- **File-store race fixed during the build:** the first increment returned the post-await value, so 12 simultaneous revocations reported one generation; it now returns its own generation, rolls back only its own increment when the disk write fails, and the burst test asserts 12 distinct consecutive values.
- Existing S7.1/S7.2 tests changed on purpose: an admin-set password or a self password change now ends the target's old sessions (the old cookie answers 401 rather than 403/`password_changed`), and a step-up grant cannot be carried onto the re-issued session (`session_revoked`).
- Prerequisites delivered: environment duration clamp (`session_ttl` in `/healthz`), canonical permission count in the role catalogue, and the authority-boundaries stub timestamp.
