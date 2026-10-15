# Backend provider-status read contract — proposal for separate Backend approval

Status: **proposal only. Nothing in the Backend is changed by Office S5.** Office works without it (every provider fact reads Unknown).

## Endpoint
`GET /office/intelligence/providers` in `src/routes/officeExport.ts`, guarded by `requireOfficeExportKey` like its siblings (`/intelligence/capabilities`, `/summary`, …). Read-only, idempotent, no request body.

## Hard rules
1. Reads a **governed approval record** (the IQ-11F gateway approvals plus per-provider authorizations and verification results). It never calls a provider, never retrieves a model, never reads billing APIs on demand.
2. Returns **no secret**: no key, token, header, credential value or secret-shaped string. A credential reference may be reported only as `reference_recorded: true|false`.
3. Unknown is explicit: `null` or `"unknown"`. Never default a missing value to `0`, `false` or `"approved"`.
4. `verified_*` fields (credits, spend, credentials, model access) may be populated **only** by an authenticated reconciliation procedure with a recorded timestamp and source; an approved ceiling is never copied into a verified field.
5. Contradictions between records are surfaced under `provenance[].conflicts`, never silently resolved. Known case today: the gateway approvals record says `currently_authorized_spend_usd: 0` (written before the OpenAI authorization) while the OpenAI shadow authorization (`ecc53e7`, 2026-10-14) records a **$50 maximum cumulative OpenAI charge, synthetic and shadow-only, conditions unmet**.
6. Cannot activate anything. No write route is part of this proposal. Activation would be a separate Backend-owned contract (see Office S5 contract §4).

## Response (schema_version 1)
```json
{
  "ok": true, "schema_version": 1, "generated_at": "ISO-8601",
  "gateway": {
    "status": "offline_design_only | shadow | live | unknown",
    "live_transport_implemented": false, "paid_inference_enabled": false,
    "cross_provider_fallback": "disabled | enabled | unknown",
    "approved_cross_provider_transfers": [],
    "source_record": { "id": "string", "version": 1, "recorded_at": "ISO-8601" }
  },
  "providers": [{
    "id": "openai | gemini | anthropic",
    "adapter": { "registered": true, "version": "string|null", "protocol": "responses | messages | generateContent-compatibility-profile | null", "mode": "offline_mock_only | shadow | live | null" },
    "credentials": { "status": "not_provisioned | provisioned_unverified | verified | unknown", "verified_at": "ISO|null", "reference_recorded": false },
    "model": { "approved_model": "string|null", "candidates": ["string"], "status": "none_selected | candidate | approved | unknown" },
    "qualification": { "status": "not_started | preparation | in_progress | qualified | failed | unknown", "scope": "string|null", "evidence_ref": "string|null", "verified_at": "ISO|null" },
    "operating_mode": "off | offline_mock_only | shadow | live | unknown",
    "budget": {
      "currency": "USD",
      "approved_maximum": "number|null", "approval_ref": "string|null", "approved_at": "ISO|null",
      "verified_credits": "number|null", "credits_verified_at": "ISO|null",
      "verified_spend": "number|null", "spend_verified_at": "ISO|null",
      "enforcement": { "status": "none | designed | tested | verified | unknown" }
    },
    "data_processing": { "status": "not_reviewed | pending | approved | rejected | unknown", "reviewed_at": "ISO|null", "approval_ref": "string|null" },
    "activation": { "contract_available": false, "activated": false },
    "last_verified_at": "ISO|null",
    "limitations": ["string"]
  }],
  "provenance": [{ "group": "budget", "source_record": "string", "recorded_at": "ISO", "conflicts": ["string"] }]
}
```
Office computes *remaining authorized budget* itself, only when `approved_maximum` and `verified_spend` are both present.

## Initial values the Backend would truthfully report from today's records
OpenAI: adapter registered (offline), mode `offline_mock_only`, credentials `unknown` (access check: none in checked scope), model `candidate` (two historical snapshots, none approved), qualification `preparation`, budget `approved_maximum: 50` (ref `ecc53e7`), `verified_credits: null`, `verified_spend: null`, enforcement `designed`, data processing `not_reviewed`, conflict note as above. Gemini and Anthropic: adapter registered (offline), credentials `not_provisioned`/`unknown`, model `none_selected`, qualification `not_started`, `approved_maximum: null`, data processing `not_reviewed`.

## Out of scope / needs its own approval
Any write or activation route; reconciliation jobs that read provider billing; storing credentials; a live gateway transport; budget ledger enforcement.
