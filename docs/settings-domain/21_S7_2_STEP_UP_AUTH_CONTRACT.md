# S7.2 — Governed Step-Up Authentication: frozen contract

Branch `feature/settings-s1-s2`, starting HEAD `5cdf171` (local = remote, clean worktree verified). Builds on S7.0/S7.1. Out of scope: S7.3, any writable session-policy control, MFA, applying step-up to existing Office operations.

## 1. Audit of the existing architecture

- **Sessions** are stateless HMAC-SHA256 cookie tokens (`auth.js`). There is no server-side session id or revocation list; "revocation" today means: cookie cleared on logout, account deactivated (live re-read), password changed (cookie is *not* invalidated), or expiry (7 days).
- **Per-request** `enforceAuth` → `{type:"session", email, role, userId, permissions}` or `{type:"api_key", role:"admin"}`; `enrichAuthContext` re-reads the admin user and returns 401 if absent/inactive, with live `role`/scopes.
- **Permissions**: `hasPermission` canonicalises aliases; `api_key` contexts pass **every** permission check. `team.manage` is held only by `super_admin`; `ochiga_admin` explicitly lacks it.
- **Password verification**: scrypt via `verifyPassword`; failed logins are limited by `adminLoginRateLimiter` (10 / 15 min per IP+email, reset on success).
- **No re-authentication primitive exists.** Cookies cannot prove the human is present now.

## 2. Step-up endpoint

`POST /api/lead-agents/admin/session/step-up` body `{ password, purpose }`.

Checks, in order, each with a failure-reason category in the audit and a generic response:
1. Auth configuration valid (else 503 `auth_configuration_invalid`).
2. Caller is an authenticated **human session**. API-key callers get `403 step_up_session_required` (never accepted).
3. Live account `super_admin` **and** holds `team.manage` (else 403 `forbidden`).
4. `purpose` is in a fixed allow-list (S7.2 defines `security_policy_write`, reserved for S7.3) else 400 `invalid_purpose`.
5. Rate limit: the existing login limiter instance, key `step-up|<ip>|<email>`, 10 / 15 min, reset on success; exceeded → 429 `step_up_rate_limit_exceeded`.
6. `verifyPassword` against the live hash; mismatch → 401 `step_up_failed` (same body regardless of cause).

Success `200 { ok, step_up: { token, purpose, issued_at, expires_at, ttl_seconds } }`. The token appears only in this response and is never logged or audited.

`POST /api/lead-agents/admin/session/step-up/check` body `{ purpose }` with `X-Step-Up-Token`: non-mutating verification through the same middleware, used by the UI for expiry state. Returns `{ valid:true, purpose, expires_at }` or `403 step_up_required` with a reason category.

## 3. Token

Format `base64url(payload).hex(HMAC-SHA256)`; payload `{v:1, purpose, sub:<user id>, email, sid, pwf, iat, exp, jti}`.
- **Dedicated signing purpose**: key = `HMAC-SHA256(sessionSecret, "ochiga-office/step-up/v1")`, so a session cookie can never validate as a step-up token and vice versa, and the session secret itself is never the direct step-up key.
- **TTL**: default 5 minutes, configurable via `LEAD_AGENTS_STEP_UP_TTL_MS`, **hard-clamped to ≤ 10 minutes**, and never beyond the session's own expiry.
- **Bindings** — identity (`sub`+`email`), current session (`sid` = keyed fingerprint of the session cookie token), purpose, `iat`/`exp`, and password state (`pwf` = keyed fingerprint of the stored password hash, never the hash itself).
- **Verification re-reads live state** on every use: the account must be active and still `super_admin` with `team.manage`; the session fingerprint must equal the presented session; `pwf` must equal the current password's fingerprint.
- Therefore the token dies on: expiry; account deactivation (401 before it is read); permission/role removal; a password change/reset/admin reset (fingerprint mismatch); a different session (new login yields a new session token); another administrator; another purpose; any tampering or forgery; an invalid auth configuration.
- Carried only in the `X-Step-Up-Token` request header (never a cookie, so it cannot be CSRF-replayed) and never accepted from query strings.

## 4. Enforcement middleware (prepared, not activated)

`requireStepUp(purpose)` returns the verified context or sends `403 { error:"step_up_required", reason:<category>, purpose }`. Reason categories: `missing`, `invalid`, `expired`, `wrong_purpose`, `wrong_session`, `wrong_identity`, `password_changed`, `permission_removed`, `api_key_not_allowed`. It is applied to **no existing Office operation** and to no writable setting in S7.2; the only route that uses it is the non-mutating `/step-up/check`. S7.3 will attach it to security-policy writes.

## 5. Audit

Actions `step_up_verified` and `step_up_failed` record: actor (email/user id/role), request id, purpose, outcome, timestamp, and for failures a reason category (`invalid_password`, `rate_limited`, `forbidden`, `api_key_not_allowed`, `invalid_purpose`, `auth_config_invalid`). Never passwords, hashes, fingerprints or tokens. `/check` failures are not audited (high-frequency, non-mutating) but are categorised in the response.

## 6. UI

A reusable `stStepUpDialog({ purpose, title, body })` built on the existing S1–S6 `st-modal` pattern (focus trap, Esc/backdrop cancel, 44 px touch targets, `role="dialog"`): current-password field, loading, inline failure ("password incorrect", rate limit, not permitted), success. It resolves with `{ token, expiresAt }` or `null`. The password lives only in the input element: cleared and the element removed in a `finally`, never put in state, storage or logs. A small helper `stStepUpActive(purpose)` reports success/expiry from the in-memory token expiry only. No Settings control is wired to it yet; the existing Security section gains a read-only "Step-up confirmation" fact stating that it is available but not yet required for any setting.

## 7. Required tests

Correct / incorrect password; expired; wrong administrator; wrong session; wrong purpose; permission removed; deactivated; password change; forged and tampered tokens; session-cookie-as-step-up and step-up-as-cookie; API-key caller; rate limiting (and reset on success); redaction in responses/audit/logs; TTL clamp; no effect on unrelated operations; UI in headless Chrome (success, failure, expiry, password cleared). Regression: S7.1, S7.0, S1–S6, S3 Postgres, WhatsApp autonomy, Team permissions, full Office suite, repository gates.

## 8. Known limitations (stated up front)

- Sessions are stateless, so logout cannot revoke a still-held cookie; a step-up bound to it remains valid for at most its TTL. Server-side session revocation is not part of S7.2.
- Step-up proves possession of the password, not a second factor.
