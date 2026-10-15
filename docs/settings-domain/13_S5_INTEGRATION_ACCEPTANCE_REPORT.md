# S5 end-to-end integration acceptance report

Heads verified clean and equal to their remotes before work: Office `feature/settings-s1-s2` **803d6b6**, Backend `feature/s5-provider-status-contract` **9330879**. Local-only: nothing merged, deployed, or changed in production; S6 not started.

## How the two branches were run together
`scripts/test-s5-integration-acceptance.js` (this repo) starts the **Backend** as its own process through `scripts/s5-integration-harness.mjs` (Backend repo): the real compiled Office export router, so `GET /office/intelligence/providers` is the genuine production route behind the genuine `requireOfficeExportKey`. A variant path uses the *same* handler factory and guard with scenario ledgers and clocks (stale, empty, conflicting, verified, hostile) so those situations can be shown end to end without editing the production ledger. The **real Office server** (file store) talks to it through the real authenticated bridge, and headless Chrome drives the real Settings → Intelligence UI. Request logs and an outbound-connection hook on both processes prove what crossed the wire.

## Results (9 scenarios, all PASS)
1. **Real route, real ledger.** Each card fact equals the Backend's field for field (Office-computed remaining excepted). OpenAI: `USD 50 approved maximum, not funded credit`; credits and expenditure *Not verified*; remaining *Unknown*; qualification *Preparation (not qualified)*; two candidate snapshots, *None approved*; credentials *Unknown*; enforcement *Designed, not enforced*; data processing *Not reviewed*; last verified 14 Oct (the observation time). Gemini and Claude: *No paid-call authorization recorded*, *None selected*, *Not started*. The gateway line (offline design only, paid inference disabled, fallback disabled, no cross-provider transfers) and the **0-vs-50 record conflict** (both record ids) are displayed.
2. **Stale records.** The observation older than its 168-hour validity is flagged first on the card; credentials revert to Unknown; the approval ceiling is unaffected.
3. **Conflicting approvals.** Two disagreeing Gemini authorizations make the ceiling *Unknown, conflicting approval records* (not 20, not 35, not "none"); simultaneous `in_progress`/`qualified` for Claude is *State unknown*, never qualified; both records are named.
4. **Missing / unavailable.** Empty ledger (every provider "No approval record exists"), endpoint absent (404), bridge key rejected (401), Backend unreachable, Backend unconfigured: every state Unknown, no figure invented.
5. **Verified fresh observation.** Ceiling 50, credits 120, spend 7.50, remaining 42.50 shown as four separate quantities; verified credentials do not make the provider qualified or activatable.
6. **Credential redaction.** A hostile ledger (secrets in limitations/conditions, an unlisted provider, extra `api_key`/`authorization` fields) is refused or stripped by the Backend, and none of five sentinel secrets (including the bridge key and the Office assistant key) reaches Office's API response or the page; the unlisted provider's name and its 999 ceiling never appear.
7. **Access.** Office: 401 unauthenticated, 403 without `audit.read`, 200 administrator, 405 for POST/PUT/DELETE; browser shows the denied panel and no provider data. Backend: 401 without or with a wrong credential; the Office bridge credential works.
8. **Responsive.** 1440 / 1100 / 900 / 768 / 390: no horizontal overflow, facts intact.
9. **Must-stay-unavailable.** No input, button, link, select, switch or password field in any provider card or anywhere in the Intelligence section; activation, paid inference and cross-provider fallback stated unavailable; the Backend received **only GET** requests (provider-status paths plus the existing Integrations `GET /health` probe); **zero non-loopback connections** from either process; no AI-provider host contacted.

## Findings from integration, fixed in Office
| # | Finding | Fix |
|---|---|---|
| F1 | An unresolved conflict between approval records showed "No paid-call authorization recorded" (a claim of absence) | Ceiling now reads *Unknown · conflicting approval records* |
| F2 | A provider with no budget record at all (empty ledger) also showed that sentence | It is shown only when the Backend has budget evidence (`<provider>.budget` provenance); otherwise *Unknown · no budget record exists* |
| F3 | A 401/403 from the Backend was reported as the generic "no provider status" | Classified as *refused the request*; Backend error text is never echoed (404 → endpoint absent, 5xx → Backend error) |
| F4 | Record-conflict sentences were truncated at 200 characters | Conflict text keeps up to 400 characters |
| F5 | "Verified verified 15 Oct" duplicated wording | Now "Verified as of 15 Oct, …" |
Test-harness note: an early run showed the Backend control-plane card as "Not reachable (HTTP 404)" because the harness had no `/health`; the real Backend serves it, so the harness now answers it.

## `office-export-auth-compat` timeout: classification
**Existing test-lifecycle defect, not an integration issue.** The smoke prints `PASS` and then never exits. It calls the middleware directly (no server, no `close()`/`process.exit`) but imports `officeExport.ts`, which transitively opens Redis clients; `process._getActiveHandles()` after the PASS shows two idle sockets to port 6379 on **both** `origin/main` and the S5 branch. With `bullmq`/`ioredis` stubbed (as sibling smokes such as `office-intelligence-capabilities-smoke.mjs` already do) it exits in about 1 s on both. Identical behaviour on baseline and branch; the endpoint added by S5 is not involved. `communications-office-auth-compat-smoke` shows the same symptom (prints PASS, then runs until the 40 s alarm) on both `origin/main` and the branch; I classified it by that behaviour only (the generic Redis stub does not make it pass, so its exact open handle was not isolated). No fix was applied (out of scope); a one-line stub or explicit `process.exit(0)` in the smoke would resolve it.

## Three historical Backend smoke failures — preserved, not concealed
Identical failure, same line, on a clean `origin/main` checkout and on the S5 branch, with the local fixture and a valid fixture service-role key:
- `office-intelligence-memory-learning-smoke` — assertion at line 175 (`memBefore.complete` expected true, got false) before any S5 code is reached.
- `intelligence-trace-live-smoke` — `TypeError: Cannot read properties of null (reading 'name')` at line 130 (`dev.data.name`): the smoke's seeded `devices` row is absent from the current fixture database.
- `intelligence-visibility-final-audit-smoke` — the same `null.name` failure at line 121.
These depend on fixture rows/state, were not touched, and are listed as pre-existing. Not fixed here.

## Regression results
Office: full suite 57 scripts (Postgres and cross-repo scripts run separately) — all pass except `test-wave9-authority-boundaries.js`, which failed once under full-suite load and passes when run alone (it has done the same earlier in this programme; unrelated to Settings). S3 Postgres/PostgREST suite PASS. Repository gates (check, lint, build, secrets, deployment) PASS. Backend: `tsc` clean, build passes; 15 Office/intelligence smokes pass (provider status, capabilities, workers, overview, knowledge, goals/decisions/actions, automations bridge, internal surface, authority, fabric phase 1 and 2, target evidence, trace projection contract, corporate intelligence contract, platform boundary). The batch also reports `office-export-auth-compat` and `communications-office-auth-compat` as timeouts (the lifecycle defect above, PASS printed) and the three historical failures unchanged.

## Remaining limitations
Backend ledger governance (who adds records, review rules), credential/billing reconciliation, data-processing reviews, model selection, qualification, a Backend-owned activation contract and durable budget enforcement remain separate approvals. The acceptance harness serves the real router but is not the full Backend application (no database, no Redis).
