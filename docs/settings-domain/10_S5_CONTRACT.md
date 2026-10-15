# Settings S5 — Intelligence Provider Management: frozen contract

Frozen before runtime changes. Baseline `6e292e7` (S4). Not merged, not deployed, S6 not started.

## 1. Audit findings (what is genuinely available)
| Question | Finding |
|---|---|
| Does a Backend provider-status endpoint exist? | **No.** `officeExport.ts` has no providers route on any Backend checkout (`oyi-wave11-backend`, `Ochiga-backend`, `oyi-intelligence-quality`). The IQ-11F gateway is offline test code under `scripts/iq11f-gateway/` in `oyi-intelligence-quality` and is not in Backend runtime. |
| Where do approval records live? | Static JSON/Markdown artifacts in the IQ branch: `…iq11f-gateway-approvals.json`, `…openai-shadow-authorization.json`, `…openai-shadow-access.json`. Not readable by Office at runtime. |
| Credentials/billing metadata | None verified. The 2026-10-14 access check recorded no credential in the checked scope, `billing_status`, `project_data_controls` and `model_access` all `NOT_VERIFIED`, 0 authenticated requests, 0 paid calls. |
| Office-side OpenAI | Office has its own environment-configured OpenAI key for the Office assistant (`config.openaiApiKey`, `config.openaiModel`). That is the legacy assistant path; it is **not** an Oyi Core qualification. Office has no Gemini or Claude configuration at all. |
| Record discrepancy to reconcile (not overwrite) | The gateway approvals file records `currently_authorized_spend_usd: 0` and `historical_proposed_budget_usd: 50`; the later OpenAI shadow authorization (2026-10-14, commit `ecc53e7`) records a **$50 maximum cumulative OpenAI API charge**, synthetic and shadow-only, with conditions unmet (verified credentials, funded project, exact model access, data-processing settings, tested durable budget enforcement, frozen corpus). The two are not contradictory in time but the gateway file was not updated. The S2 card text "Authorized spend: USD 0" for OpenAI was therefore stale and is removed. |
| IQ-11E | Qualification is shadow-only; a valid candidate never gains authority; deterministic Core keeps authority, hazards, confirmation and execution. Thresholds: overall ≥85 %, each worker ≥80 %, zero P0. No provider is qualified. |

## 2. Provider-state architecture
Single source of truth = the **Backend/IQ gateway**. Office holds no provider state of its own.
```
Backend governed approval records ──(future read-only)──▶ GET /office/intelligence/providers
                                                              │ (server bridge, existing auth)
Office  GET /admin/intelligence/providers  ◀── strict whitelist normaliser (no secrets, no inference)
                                                              │
Settings → Intelligence  (read-only cards; Unknown when not verified)
```
- Office route `GET /api/lead-agents/admin/intelligence/providers` (permission `audit.read`, same as Intelligence) calls the Backend path (`OFFICE_INTELLIGENCE_PROVIDERS_PATH`, default `/office/intelligence/providers`) through the existing intelligence bridge, with the existing timeout. 404 → `available:false, reason:"endpoint_not_available"`; other failures → `available:false` with the bridge reason. **No cached or invented provider state.**
- Normalisation (`intelligence-providers.js`): whitelist of fields; unknown enum values become `unknown`; numbers validated; strings truncated; any secret-shaped value or key (`api_key`, `authorization`, `sk-…`, `AIza…`, bearer tokens, long opaque strings) is dropped and counted in `redaction_applied`; credential *references* are reduced to a boolean.
- Office-side fact (the only locally verified provider fact): whether the Office assistant OpenAI configuration is present and its model name, shown in a separate row labelled "Office assistant (legacy path) — not an Oyi Core qualification". Gemini and Claude: "No Office configuration exists".
- Operating mode, adapter availability, approved model, qualification, data-processing review, last verified: shown only from Backend data, else **Unknown**.

## 3. Budget truth (four separate quantities, never merged)
Approved maximum · Verified available credits · Verified actual expenditure · Remaining authorized budget.
- Each is shown only when the Backend supplies a verified value with a currency; otherwise "Unknown" / "Not verified".
- Remaining authorized is **computed by Office only when both approved maximum and verified expenditure are known** (`max(0, approved − spent)`); a Backend-supplied remaining value is ignored. Never derived from credits, never from the approved ceiling alone.
- An approved ceiling is never presented as funding. The $50 OpenAI ceiling appears only if the Backend reports it, labelled "Approved maximum (not funded credit)". Anthropic and Gemini: no paid-call authorization is displayed unless the Backend records one; until then "Not authorized / Unknown".

## 4. Provider switch design (architecture only; no functional switch)
A future enable/disable control is gated by all of: (1) a Backend-owned activation contract; (2) a qualified provider **and** model; (3) an approved data-processing policy; (4) verified credentials; (5) budget enforcement; (6) current administrator authority; (7) audit logging; (8) explicit confirmation.
S5 ships the *interface architecture* only: a read-only "Activation readiness" checklist per provider (Met / Not met / Unknown, derived strictly from Backend state), a fixed "Activation is not available in Office in this release" state, and **no button, toggle or input** in any provider card. The server hard-codes `activation.available = false`; even a Backend that reports an activation contract does not enable anything in Office. Connected ≠ qualified; qualified ≠ activated.

## 4b. Backend request (separate approval)
`docs/settings-domain/11_BACKEND_PROVIDER_STATUS_CONTRACT_PROPOSAL.md`: the smallest read-only governed endpoint, for the Backend owner to approve and build. Office S5 works without it (shows Unknown) and lights up when it exists.

## 5. Security
No key entry or reveal; no secret in responses, logs or audit; no outbound request to OpenAI, Google or Anthropic; no paid inference; no cross-provider transfer; no model adoption; One-Core execution authority untouched. Office makes one GET to the Backend through the existing bridge.

## 6. UI
Intelligence section: data-source banner (available / unavailable with reason and generated time), three provider cards (S1–S2 `providerCard`, status indicator, permission gate) with: provider name, adapter availability, connection/configuration status, approved model, qualification status, operating mode, approved spending ceiling, verified credits, verified expenditure, remaining authorized budget, data-processing review, last verified, limitations; activation-readiness checklist; responsive at 1440/1100/900/768/390.

## 7. Acceptance
Permission boundaries; unknown states; credential redaction; approval-state and budget-state accuracy (including no remaining figure without verified spend); unavailable Backend; no activation controls; zero provider API calls; no cross-provider transfer; responsive layouts; S1–S4 regressions; full Office regression and repository gates; screenshots.
