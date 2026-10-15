# Settings S4 — Integrations & Communications: implementation report

Contract: `08_S4_CONTRACT.md` (frozen and committed before runtime changes, `302cef5`). Baseline `685c70f` (S3). Not merged, not deployed. S5 not started. No database change.

## Delivered
- `src/lead-agents/settings-operations.js` + wiring in `server.js`:
  - `POST /admin/settings/integrations/:key/test` — allowlist `backend`, `facility`, `consumer`, `digital_twin`; body must be empty; one bounded GET built only from server configuration; overall timeout guard (default 3.5 s, cap 5 s); per-key minimum interval (429); truthful `kind` (`network_probe`, `in_process`, `not_configured`); no URL, header, key or upstream body returned or audited.
  - `POST /admin/settings/operations/outbox/reconcile-preview` and `/visibility/repair-preview` — dry run is a **literal `true` in server code**; the body may contain only `window_minutes`, `limit` and `dry_run:true`; anything else is a 400 and nothing runs. Responses are shaped server-side (counts plus ≤10 samples, identifiers shortened, no message text, phone numbers or full lead ids).
  - All three require a **person** with `integrations.manage`: API-key sessions are refused (`actor_identity_required`); unauthenticated 401; wrong method 405.
- UI (S1–S2 components): Integrations → "Test connection" on the Backend, Facility, Consumer and Digital Twin cards only; Communications → "Operations (dry run only)" card with two preview buttons, "Dry run — nothing was changed" labelling and a note that applying changes is available only through the administrator API. No control exists for real reconcile, recover, retry or repair.
- Audit: existing event types reused for previews (`communication.outbox.reconcile` with `dry_run`, `whatsapp.inbound_visibility.dry_run`, plus `via:"settings"`, `enforced_dry_run:true`); new `settings.integration_test`, `settings.operation_rejected`, `settings.operation_denied` for tests and refusals, each with actor and request id.
- Unchanged: the existing outbox and repair routes (still apply when explicitly asked, with their own authorization), WhatsApp autonomy, signature enforcement, Letterhead, S3 registry and versioning.

## Evidence
`s4-evidence/`: `settings-integrations-tests-{1440,390}.png`, `settings-communications-operations-{1440,390}.png`.

## Tests
| Suite | Result |
|---|---|
| `test-settings-operations.js` (unauthorized, forged bodies, unsafe keys incl. case/encoding/traversal/prototype names, timeout/500/refused, in-process twin, rate limit, 30 forged dry-run bodies, store-hash unchanged, nothing queued/sent/forwarded, audit, secret redaction, existing route unchanged) | PASS |
| `test-settings-operations-browser.js` (button allowlist, truthful results, dry-run previews, forged browser requests refused, permission-aware controls, 403 from server, mobile 44px/no overflow) | PASS |
| S1–S2 and S3 browser suites; S3 registry; autonomy and letterhead regressions | PASS (inside the full run) |
| S3 Postgres/PostgREST suite | PASS |
| Full Office regression (54 scripts; Postgres and cross-repo scripts run separately) | 54/54 PASS |
| check, lint, build, secrets, deployment gates | PASS |

## Remaining limitations
- Config-only integrations (email, maps, social, App Store, WhatsApp credentials) stay "Configured, not verified"; the website card has no test button (outside the approved allowlist).
- The Facility and Consumer probe reuses their existing authenticated export path, so a test performs that GET; it is rate-limited per key.
- Applying reconcile, recover, retry or repair remains administrator-API-only by decision.
- The first production-writable registry setting is deferred to S6.
