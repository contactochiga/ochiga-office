# Settings S7.0 — Authentication security hardening: frozen contract

Frozen and committed **before** runtime changes. Baseline `b85988e`. Not merged, not deployed, no migration, no production secret changed, S7.1 not started.

## 0. Clean regression baseline (recorded before any change)
Full Office regression at `b85988e`: **61 of 61 scripts pass** (Postgres and cross-repo scripts run separately; the S3 Postgres suite passed at the previous slice and is re-run at the end). Repository gates pass.

## 1. Audit findings
### 1.1 Session-issuing routes (exhaustive)
`createAdminSessionToken`/`createSessionCookie` are called from exactly **two** routes: `POST /admin/session/login` and `POST /admin/session/invite/accept`. Password change and reset-confirm do **not** issue a session. Tokens are stateless HMAC-SHA256 values over `{email, role, user_id, permission_scopes, exp}`; every request is re-checked against the stored user (`enrichAuthContext`): inactive → 401, role and scopes are read live. Consumers of the secret: `createAdminSessionToken` and `readAdminSession` only.

### 1.2 Session-secret configuration (current)
`sessionSecret = LEAD_AGENTS_SESSION_SECRET || LEAD_AGENTS_API_KEYS || "lead-agents-dev-session-secret"`. If the dedicated secret is unset, sessions are signed with the shared API keys (so any API-key holder can mint a session for any role) or with a **hard-coded public string** (so anyone can). `render.yaml` declares the variable as dashboard-set (`sync: false`); whether production has it set is **not verifiable from the repository** and was not verified.

### 1.3 API-key-as-password fallback (current)
In `POST /admin/session/login`: when no account exists for the email **and** the supplied password equals a configured API key, login succeeds and the server **creates a persistent admin account** (`role = LEAD_AGENTS_ADMIN_ROLE`, default `admin`, password hash of the API key). Effect: possession of the shared API key mints a human administrator session and account for any email address. It is rate-limited but otherwise unrestricted. Documentation describes only the bootstrap-admin login; no document, UI or client describes API-key-as-password as a feature. Both login forms (Office, legacy dashboard) submit what the user types; no client sends an API key as a password.
**Dependence evidence.** Repository: no code, test, script, document or other repository calls login with an API key as the password. Production: **could not be established by me** (production data reads were not permitted in this session; one aggregate count query on `admin_users` ran before that restriction and showed a single account whose display name equals its email — consistent with the bootstrap admin alone, but only the tail of that output was seen, and a renamed fallback-created account would not show). The owner must run the read-only check in §3.3 before deploying.

### 1.4 Recovery today
`bootstrapAdminUser` creates the `LEAD_AGENTS_ADMIN_EMAIL` account only when it does not exist; an existing account is never reset or reactivated. Recovery from a lost or deactivated sole administrator therefore currently depends on (a) the email reset flow, (b) the API-key fallback (the insecure path being removed), or (c) editing the database. Removing (b) would leave a gap, so a secure replacement is part of this slice (§4).

## 2. Session secret requirement
- `config.sessionSecret` is resolved **only** from `LEAD_AGENTS_SESSION_SECRET`. It never falls back to `LEAD_AGENTS_API_KEYS` or to any hard-coded value, in any environment. Outside production, if it is unset, an **ephemeral random secret is generated per process** (sessions then do not survive a restart; a one-line warning says so).
- **Production validity** (`NODE_ENV=production`): the secret must be set, at least **32 characters**, not equal to any configured API key, edge token, Office bridge key or other shared secret held in configuration, and not a known placeholder. The checker returns only **problem codes** (`session_secret_missing`, `session_secret_too_short`, `session_secret_shared_with_api_key`, `session_secret_reused_bridge_secret`, `session_secret_placeholder`) — never a value, length-by-value or hint.
- **Safe readiness failure** (no crash loop, no secret leakage): `/healthz` answers **503** with `{ ok: false, ready: false, auth_config: { session_secret: "invalid", problems: [codes] } }` (and `200` with `auth_config.session_secret: "configured"` when valid), so Render's health check (`healthCheckPath: /healthz`) fails the deploy and the previous healthy instance keeps serving. While invalid, the server **issues no session** (login and invite-accept answer `503 auth_configuration_invalid`) and **accepts no session cookie**; API-key and public routes are unaffected.
- Existing valid sessions (same secret, same payload format) keep working; the seven-day lifetime and cookie flags are unchanged.

## 3. API-key-as-password authentication
### 3.1 Default
**Disabled by default in every environment** (development, test, new deployments, and production unless explicitly enabled). Control: `LEAD_AGENTS_ALLOW_API_KEY_LOGIN`; only the exact value `true` enables the legacy behaviour. When disabled, an unknown email with an API-key password receives the same `401 unauthorized` as any wrong credential, no account is created, no cookie is set, and the attempt counts against the login limiter.
### 3.2 Transitional mode (only if the owner's check shows a real dependency)
When explicitly enabled the legacy behaviour is kept **but made visible**: every use is audited (`session_login_api_key_fallback`, actor email only, never the key), `/healthz` reports `auth_config.api_key_password_login: "enabled_deprecated"`, and the server logs a warning at startup. The flag is never set by this repository, `render.yaml` or tests' defaults, and a deployment-validation rule rejects it in `render.yaml`. Removal of the code path is a later slice.
### 3.3 Owner pre-deployment check (read-only, run by the owner)
```sql
-- accounts that look like fallback-created or bootstrap accounts (display name equals email)
select email, role, status, created_at, last_login_at from admin_users where lower(display_name) = lower(email);
-- sign-in volume by account for the last 60 days (does anyone sign in who is not a named team member?)
select actor_email, count(*) from audit_events where action in ('session_login','user.login') and created_at > now() - interval '60 days' group by 1 order by 2 desc;
```
Every account in the first result must be a deliberate administrator (the bootstrap admin, or someone to be re-issued a proper invite). If anyone relies on API-key login, deploy with the transitional flag and migrate them through Team invites first.

## 4. Administrative recovery (replacement for the removed bypass)
Explicit, deployment-owner-only, audited, off by default: when `LEAD_AGENTS_ADMIN_RECOVERY=true` **and** `LEAD_AGENTS_ADMIN_EMAIL`/`LEAD_AGENTS_ADMIN_PASSWORD` are set, startup resets that one account's password hash, reactivates it and ensures it holds `LEAD_AGENTS_ADMIN_ROLE`, writes an audit event (`admin_recovery_applied`, email only), logs a warning, and `/healthz` reports `auth_config.admin_recovery: "enabled"` so it cannot stay on unnoticed. It refuses to run (and logs the reason) if the recovery password is shorter than 12 characters. It is not reachable over HTTP, does not touch any other account, and requires the same access as editing the deployment's environment (which already controls the database key). Runbook: set the three variables, redeploy, sign in, change the password in Office, **remove the flag**, redeploy. The normal first-start bootstrap (create when absent) is unchanged.

## 5. Preserved behaviour
Seven-day session duration, the login limiter (10 attempts/15 min per IP+email, reset on success), Team permissions (`staff.manage` view, `team.manage` write), user deactivation (immediate 401), role/scope changes (live), invite/reset/change-password flows, cookie flags, WhatsApp autonomy, letterhead, document brand and locale, provider status, the S3 registry.

## 6. Tests required
Unauthorized login (wrong password, unknown email, inactive account, no enumeration difference); API-key fallback rejection (and the explicit transitional mode with its audit/health signals); administrator recovery (enabled, refused for a weak password, off by default); session signing (tamper, wrong secret, API-key-signed token, expiry); invalid production configuration (every problem code, 503 readiness, no secret in any response or log, no session issued or accepted); existing sessions remain valid; role/scope change and deactivation take effect; login limiter; full Office regression, authentication tests, S1–S6 acceptance, repository gates.

## 7. Exclusions
No password policy (S7.1), no session-length setting (S7.2), no revocation migration (S7.3), no MFA, no change to the login limiter's design, no production secret or environment change, no migration, no deployment.
