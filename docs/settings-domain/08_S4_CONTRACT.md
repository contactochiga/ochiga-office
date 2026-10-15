# Settings S4 — Integrations & Communications: frozen contract

Frozen and committed **before** runtime changes. Baseline `685c70f` (S3). Not merged, not deployed. S5 not started.

## Approved decisions (owner)
1. Outbox and visibility-repair **diagnostics** are built into Settings (Office-owned).
2. **Dry-run only** in the browser. No browser control for real reconcile, recover, retry, replay or repair. Existing API routes and their authorization are preserved untouched.
3. Reuse the existing authenticated health probes for Backend, Facility and Consumer. A genuine network probe may report reachability; an in-process binding is identified as such.
4. Config-only integrations stay "Configured, not verified"; no test buttons.
5. No real WhatsApp send tests.
6. The first production-writable registry setting is deferred to S6.

## Scope
| Deliverable | Contract |
|---|---|
| Connection test | `POST /api/lead-agents/admin/settings/integrations/:key/test` |
| Outbox reconcile preview | `POST /api/lead-agents/admin/settings/operations/outbox/reconcile-preview` |
| Visibility repair preview | `POST /api/lead-agents/admin/settings/operations/visibility/repair-preview` |
| UI | Integrations: "Test connection" on probed cards. Communications: "Operations (dry run only)" card using S1–S2 components |
No database change. No new registry key. No change to the existing outbox/repair routes, WhatsApp autonomy, signature enforcement, Letterhead or S3 versioning.

## Authorization (all three endpoints)
Authenticated **person** with `integrations.manage` (server-checked; the UI hiding controls is cosmetic). API-key sessions pass `authorizePermission` but have no accountable actor, so they are refused (`403 actor_identity_required`). Unauthenticated → 401. Methods other than POST → 405.

## Connection test
- **Allowlist (exact):** `backend` (probe `/health`, `x-api-key`), `facility` and `consumer` (their existing export-path probe with the configured credentials), `digital_twin`. Anything else, including `website`, config-only services, path tricks, encoded or upper-case keys → `404 unknown_integration` (audited, no outbound call).
- **Nothing caller-controlled reaches the network.** The body must be empty; any field (`url`, `base_url`, `path`, `headers`, `timeout`, …) → `400 unexpected_fields`. The target and credentials come only from server configuration.
- **Bounded:** one GET; per-request timeout `config.settingsProbeTimeoutMs` (default 3500 ms, hard cap 5000 ms) plus an overall guard; response payload is discarded; per-key minimum interval 3 s (`429 too_soon`).
- **Truthful result:** `kind` = `network_probe` (reachable true/false with `http_status`, `latency_ms`, error category `timeout|connection_refused|dns_failure|http_<n>|request_failed`), `in_process` (same-origin digital twin: `available`, `reachable: null`, no network call), or `not_configured` (no call).
- **No secrets:** no URL, header, key or response body is returned or audited.
- **Audit:** `settings.integration_test` (resource `integration`, outcome, status, latency, request id, actor).

## Operations (dry run enforced on the server)
- Server code calls `reconcileOutbox(..., { dryRun: true })` and `repairInboundVisibility(..., { dryRun: true })` with a **literal** `true`; the value never comes from the request.
- Accepted body keys only: `window_minutes`, `limit` (clamped) and `dry_run` which, if present, must be `true`. `dry_run:false`, `dryRun`, `apply`, `mode`, `confirm`, `replay`, `force` or any other key → `400 dry_run_only` / `400 unexpected_fields`, nothing executed, attempt audited.
- Responses are shaped server-side: counts plus at most 10 sample rows with identifiers shortened to the last 8 characters; no message text, phone numbers or full lead ids. Always `dry_run: true, enforced: "server"`.
- Guaranteed no effect: no outbox row, activity, claim, lease, send or Backend call is created (tested with a write-guarded store and a Backend stub that counts requests).
- **Audit:** the existing event types are reused (`communication.outbox.reconcile` with `dry_run:true`, `whatsapp.inbound_visibility.dry_run`) with `via: "settings"`; rejected or denied attempts audit `settings.operation_rejected` / `settings.operation_denied`.

## UI
Integrations: "Test connection" button on the Backend, Facility, Consumer and Digital Twin cards for users with `integrations.manage`; result inline (kind, HTTP status, latency, time; in-process is labelled "In-process binding — no network probe"). Config-only and website cards have no button. Communications: "Operations (dry run only)" card with two preview buttons, results labelled "Dry run — nothing was changed", and a note that applying changes is available only through the administrator API. No control anywhere for real reconcile, recover, retry or repair.

## Acceptance
Unauthorized, forged-body, unsafe-key, timeout, dry-run-enforcement, audit and redaction tests pass; WhatsApp autonomy, signature enforcement, Letterhead, S3 registry/versioning and the S1–S2 acceptance suites stay green; full Office regression and repository gates pass; screenshots at 1440 and 390 px.
