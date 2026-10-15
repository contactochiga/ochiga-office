# Settings S5 — Intelligence Provider Management: implementation report

Contract `10_S5_CONTRACT.md` and Backend proposal `11_BACKEND_PROVIDER_STATUS_CONTRACT_PROPOSAL.md` were frozen first (`7d04ad6`). Baseline `6e292e7` (S4). Not merged, not deployed, S6 not started.

## Backend endpoint findings
No provider-status endpoint exists on any Backend checkout. The IQ-11F gateway is offline test code in `oyi-intelligence-quality`, and its approval records are static artifacts Office cannot read at runtime. Office therefore bridges to the **proposed** read-only endpoint (`GET /office/intelligence/providers`, path configurable) and shows every provider fact as Unknown while it is absent. The smallest governed contract is documented for separate Backend approval (doc 11). Nothing in the Backend was changed.

## Provider-state architecture
Backend/IQ gateway = single source of truth → Office `GET /admin/intelligence/providers` (permission `audit.read`, existing intelligence bridge and timeout) → strict whitelist normaliser (`intelligence-providers.js`) → read-only cards in Settings → Intelligence. Office holds no provider state. The only locally verified fact is the Office assistant's own OpenAI configuration (presence and model name), shown separately as "legacy path, not an Oyi Core qualification". The provider list is closed (OpenAI, Gemini, Claude); anything else the Backend reports is ignored.

## Budget truth
Four separate quantities: approved maximum (labelled "not funded credit"), verified credits, verified actual expenditure, remaining authorized. Remaining is computed by Office only from a verified expenditure and an approved maximum; a Backend-supplied remaining value is ignored; money without a currency, negative or non-numeric amounts are Unknown; overspend shows 0, never negative. Records reconciled, not overwritten: the gateway approvals file (`currently_authorized_spend_usd: 0`, written earlier) and the later OpenAI shadow authorization (`ecc53e7`: $50 maximum, synthetic and shadow-only, conditions unmet) are both kept; conflicts the Backend reports are displayed. The stale S2 card text "Authorized spend: USD 0" was removed. Gemini and Claude show no paid-call authorization unless the Backend records one.

## Provider switch (architecture only)
Read-only "Activation readiness" checklist (activation contract, qualified provider+model, data-processing approval, verified credentials, budget enforcement, administrator authority, audit logging, explicit confirmation) derived strictly from Backend state; the server hard-codes `activation.available = false`; no button, toggle or input exists in a provider card.

## Security
No key entry/reveal; secret-shaped values and credential fields are dropped (counted in `redaction_applied`); credential references reduce to a boolean; no paid inference; zero outbound requests to AI providers (asserted by hooking `http`/`https`); the only Backend traffic is one GET through the existing bridge key; no cross-provider transfer; One-Core authority untouched.

## Tests
| Suite | Result |
|---|---|
| `test-settings-intelligence-providers.js` (permissions, unavailable/404/500/refused/unconfigured, unknown states, approval and budget accuracy, redaction incl. logs and audit, activation never available, zero provider calls) | PASS |
| `test-settings-providers-browser.js` (unavailable, truthful, spend, qualified-but-not-activatable, permission, 1440/1100/900/768/390) | PASS |
| S1–S4 browser and server suites, S3 Postgres suite, autonomy/letterhead regressions, intelligence architecture guard | PASS |
| Full Office regression (56 scripts; Postgres/cross-repo run separately) | 55/56 on the full run; `test-wave9-authority-boundaries.js` failed once under full-suite load and passed 4/4 when re-run alone (unrelated to Settings; same intermittent behaviour seen earlier in this programme) |
| check, lint, build, secrets, deployment gates | PASS |

## Remaining approvals
Backend owner: approve and build the read-only provider-status endpoint (doc 11) and its governed record/reconciliation. Separate approvals still required for: provider credentials/billing verification, data-processing reviews, model selection, qualification, a Backend-owned activation contract and durable budget enforcement. None is part of S5.
