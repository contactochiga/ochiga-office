# S7.3 — Governed Session Duration Policy: frozen contract

Branch `feature/settings-s1-s2`, starting HEAD `b5a65aa` (local = remote, clean worktree verified). Builds on S3 (registry), S7.0–S7.2. Out of scope: S7.4, idle timeouts, server-side session revocation, per-role durations.

## 1. Audit of session issuance (current behaviour, seven days)

Duration today: `config.sessionTtlMs` = `LEAD_AGENTS_SESSION_TTL_MS`, default `604800000` (7 days). One value feeds both the signed token's `exp` (`createAdminSessionToken`: `Date.now() + sessionTtlMs`) and the cookie `Max-Age` (`createSessionCookie`: `floor(sessionTtlMs/1000)`, min 60 s). Sessions are stateless: the expiry lives inside the signed token, so an issued session never changes when configuration changes.

| # | Path | Issues a session? | Today |
|---|---|---|---|
| 1 | `POST /admin/session/login` | **yes** | token + cookie from `config.sessionTtlMs` |
| 2 | `POST /admin/session/invite/accept` | **yes** | token + cookie from `config.sessionTtlMs` |
| 3 | `POST /admin/session/reset/confirm` | **no** | updates the password, marks the token used, returns `{ok:true}` with no cookie (deliberate since S7.0: a reset proves email possession, the user then signs in) |
| – | password change, step-up, logout | no | – |

**Discrepancy with the S7.3 brief, resolved conservatively:** the brief lists reset confirmation as a session-issuing path. It is not, and making it one would weaken S7.0/S7.1 (an emailed link would become a direct login). S7.3 keeps it session-less and proves that (a) no cookie/token is issued by reset-confirm, and (b) the first login after a reset receives the configured duration. If the owner wants reset to sign the user in, that is a separate security decision.

## 2. Registry entry (S3, generic, Office-owned)

| field | value |
|---|---|
| key | `office_session_ttl_hours` |
| owner / scope / mode / storage | `office` / `global` / `generic` / `runtime_settings` |
| type | `integer` (JSON number, whole hours; strings, floats, booleans, `null`, `NaN`/`Infinity` rejected) |
| default | `168` |
| range | min `1`, max `720` inclusive |
| read_permission | `staff.manage` |
| write_permission | `team.manage` |
| audit_action | `office_session_ttl_hours_changed` |
| `requires_step_up` | `security_policy_write` (new descriptor field, generic settings only) |

## 3. Write enforcement (server-side, in `settings-api.js`, in this order)

1. Actor identity required — API-key callers carry none → `403 actor_identity_required` (unchanged S3 rule).
2. Known key / generic office-owned setting (unchanged).
3. `team.manage` (held only by `super_admin`) else `403 forbidden`.
4. **Step-up**: `verifyStepUpToken` with purpose `security_policy_write` against the live account. It requires a human session, `super_admin`, `team.manage`, the **same session** that earned the grant, the same administrator, unchanged password state, and an unexpired grant. Otherwise `403 step_up_required` `{reason, purpose}`; the attempt is recorded (reason only) and the stored value is untouched.
5. Body: `value`, integer `expected_version` required (unchanged).
6. Value validation: integer 1…720 else `400 invalid_value`.
7. Atomic compare-and-set; stale version → `409 version_conflict` with the current value/version; success returns the server-stored entry.

The step-up token is read from the `X-Step-Up-Token` header only, is never copied into the registry attempt log, the audit record or any response.

Reads (`staff.manage`) are unchanged and never require step-up. No other setting acquires a step-up requirement.

## 4. Effective duration at issuance

`resolveSessionTtl(store, config)` runs **at the moment a session is issued** (login, invite acceptance) and returns `{ ttlMs, hours, source, reason }`:

- stored row, valid integer 1…720 → `ttlMs = hours × 3 600 000`, source `stored`.
- no stored row → the environment duration (`config.sessionTtlMs`, default 7 days), source `default` when it equals the registry default else `environment`. No value is invented or written.
- store read fails, or the stored value is not a valid integer 1…720 (corrupted/tampered row) → the environment duration **capped at 720 h**, source `environment_fallback`, and a structured warning `session_ttl_fallback { reason: setting_unavailable | stored_value_invalid }` is logged (no value, no secrets). An invalid stored value can therefore never lengthen a session beyond 30 days, and never shortens it below the environment duration.

The same `ttlMs` produces both the token `exp` (`Date.now() + ttlMs`) and the cookie `Max-Age` (`floor(ttlMs/1000)`); they are computed from one resolved value in one place. Existing sessions keep the `exp` already signed into them; changing the setting affects only sessions issued afterwards. Step-up grants are unaffected except that they never outlive their session.

## 5. UI — Settings → People & Access

An **Access Policy** card (S1–S6 `st-card`/`stForm` components) shows: current duration (hours and days), effective source (Default / Stored / Environment / Fallback), version, allowed range, and a note that existing sessions keep their expiry. The editable control is rendered **only** for a `super_admin` whose entry reports `editable`; other roles with `staff.manage` see read-only values; others see nothing. Saving opens the S7.2 step-up dialog, then sends `PUT` with `expected_version` and the `X-Step-Up-Token`; the card shows the server-confirmed stored value. States: loading, validation error, step-up cancelled (nothing saved), step-up expired/refused (re-prompts), version conflict (shows the current value and offers to reload), server error. Responsive to 390 px.

## 6. Audit

Registry audit `office_session_ttl_hours_changed` records actor, request id, previous and new value, previous/new version, outcome (`success`, `conflict`, `denied`, `rejected`, `failed`) and timestamp; history rows via the existing S3 history endpoint. Step-up denials record reason categories only. No step-up token, password or hash is ever written.

## 7. Required tests

All session paths (login, invite, reset's no-session behaviour); token `exp` and cookie `Max-Age` agree; existing sessions keep their expiry after a change; bounds 1/720 accepted, 0/721/negative/float/string/null/NaN rejected; step-up missing/expired/wrong session/wrong purpose/wrong administrator/permission removed/API key; version conflicts and concurrent writers; restart persistence; fallbacks (store failure, no row, corrupted row including an excessive value); audit/history; redaction; browser UI at desktop and 390 px. Regression: S7.0/7.1/7.2, S1–S6, S3 Postgres, WhatsApp autonomy, Team permissions, full suite, repository gates.

## 8. Known limitations

- Shortening the duration does not shorten sessions already issued (stateless tokens, no revocation list); they expire at their original time. This is by contract.
- The environment duration remains the fallback and is not itself range-checked at its lower end.
