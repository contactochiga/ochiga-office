# CRM retained context access

This is a closure restriction on the existing `lead_memories` endpoint, not a new memory store or reasoning system.

- Only identified staff sessions with canonical `crm.read` may recall. Shared API keys, public sessions and dashboard permission alone are insufficient.
- The canonical lead must exist. Its `owner` must exactly equal the authenticated staff ID, or the staff must hold `crm.manage`. Agent labels and display names do not establish ownership.
- Organization/estate scope must match across actor, lead and memory. Current Office is a single-instance CRM: null scope is that instance, not a wildcard. Scoped records fail closed until authenticated scoped identity exists; no request body establishes scope. No cross-instance fetch occurs.
- Read-time retention is 30 days from valid, non-future `updated_at`. Unknown timestamps and expired records return null, never fabricated recall. This is retrieval expiry, not physical deletion.
- Only bounded business_unit, inquiry_type, project_type and property_type fields may be projected, explicitly staff-private/context-only with source and expiry. Transcripts, staff notes, contact details, prompts, tool results and arbitrary summaries never enter this projection or general memory.
- No production caller of the retained upsert methods was found after legacy agent retirement. They remain compatibility storage, not an active learning writer. A later writer needs separate authorized admission; this task does not activate one.
- Supersession uses the existing single lead record and timestamp. Deleted/nonexistent leads revoke recall even if an orphan legacy memory row remains. Physical purge remains existing CRM data administration, not a new retention job.
- Public chat already returns `lead_memory: null` and no staff-private CRM history. Public sessions cannot call this endpoint. General Oyi answers remain Core-owned; this endpoint supplies no new autonomous reasoning or action authority.

Proof: `node scripts/test-crm-memory-privacy.js`, public-session and authority-boundary HTTP suites. Compatibility change: a shared-key/dashboard-only consumer no longer receives raw legacy memory. No observed UI caller depends on those raw fields.
