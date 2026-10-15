# S7.1 — Governed Password Security Policy: frozen contract

Branch `feature/settings-s1-s2`, starting HEAD `33da35e` (local = remote, verified). Builds on S7.0 (`19_S7_0_AUTH_SECURITY_CONTRACT.md`). Out of scope: S7.2, MFA, lockout changes, password expiry, forced resets.

## 1. Audit — every place a password hash is written (`src/lead-agents/server.js`)

| # | Boundary | Route / site | Authorization | Existing validation | S7.1 |
|---|---|---|---|---|---|
| 1 | Administrator account creation | `POST /api/lead-agents/admin/users` | `manage_users` | presence only | **enforce policy** |
| 2 | Invitation acceptance | `POST /api/lead-agents/admin/session/invite/accept` | invite token (single use, expiring) | presence only | **enforce policy** (after token validity) |
| 3 | Self-service change | `POST /api/lead-agents/admin/session/password` | session + `change_password` + current password | presence only | **enforce policy** on `new_password`, after current password verified |
| 4 | Reset confirmation | `POST /api/lead-agents/admin/session/reset/confirm` | reset token (single use, 24 h) | presence only | **enforce policy** (after token validity) |
| 5 | Admin sets another user's password | `PATCH /api/lead-agents/admin/users/:id` with `password` | `manage_users` | none | **enforce policy** (a fifth boundary, found by audit) |
| 6 | Administrator recovery (S7.0) | `applyAdminRecovery` at startup | deployment owner env | length ≥ 12 | **enforce full policy** (stricter than before; env-only, no HTTP) |
| 7 | Legacy API-key fallback account mint | login route, `ensureAdminUser(hashPassword(body.password))` | disabled by default (S7.0); transitional flag only | n/a (password is an API key) | **exempt, documented**: the "password" is a deployment secret, the mode is deprecated and flag-gated |
| 8 | Invite staff placeholder | `POST /admin/invites` hashes a random opaque token | `manage_users` | n/a | none: the value is never a usable password |
| 9 | Env bootstrap (non-recovery) | `bootstrapAdminUser` → `ensureAdminUser` | deployment owner env | none | **exempt, documented**: owner-supplied env, create-only; flagged as risk |

No other writer of `password_hash` exists in `src/` (grep verified). Reset *request* is already non-enumerating (same response for unknown, inactive and active emails) and is unchanged.

## 2. Policy (fixed in code; no setting)

- Length counted in Unicode code points: **12 ≤ n ≤ 128**.
- Passphrases, spaces and any Unicode letters/symbols/emoji allowed. **No** composition rules (no upper/special/number requirement).
- Rejected: non-string, empty, all-whitespace, any control character (`\p{Cc}`, includes NUL/CR/LF/TAB), unpaired surrogates.
- Not normalised or trimmed: the exact submitted string is hashed, identical to how login verifies it.
- Compromised-password check is **local only**: an in-repo list of common passwords plus structural patterns (single character repeated, short unit repeated, sequential digit/letter runs, common word + digits/symbols suffix, keyboard rows). Passwords never leave the process; no external service.
- Existing passwords are untouched: login does not apply the policy; no forced reset; no schema change.

## 3. Error contract

`400 { "error": "password_policy_violation", "code": <code>, "message": <generic text>, "policy": {"min_length":12,"max_length":128} }`

Codes: `password_required`, `password_too_short`, `password_too_long`, `password_blank`, `password_invalid_characters`, `password_too_common`. Responses and audit entries never contain the password, a hash, a prefix, or the matched list entry. Audit records for rejected attempts are not written with password material.

## 4. Order of checks (enumeration and authorization)

- Change: authorization → current password (401 on mismatch, unchanged) → policy.
- Invite accept / reset confirm: auth-config → token validity (generic `invalid_or_expired_*`) → policy. An invalid token never reveals policy results. Reset confirm's `404 user_not_found` (valid token, missing user) becomes the generic `400 invalid_or_expired_reset`.
- Admin create/patch: permission → policy.
- Reset request, login errors, rate limiting: unchanged.

## 5. Preserved (S7.0 and earlier)

Dedicated session secret and production readiness; API-key login off by default; recovery safeguards; 7-day session; login limiter; Team roles/scopes; immediate deactivation. Password change/reset still do not issue sessions.

## 6. Required tests

Length boundaries (11/12/128/129, code points not UTF-16 units); Unicode passphrases; control characters; blank; common list and patterns; every route in §1 (accept/reject); old passwords still log in; unauthorized change (no session, wrong current password, missing permission); invite and reset happy and token-failure paths; enumeration (reset request, reset confirm); redaction (response + audit + logs); session behaviour; recovery with weak password; deactivation/role revocation.
