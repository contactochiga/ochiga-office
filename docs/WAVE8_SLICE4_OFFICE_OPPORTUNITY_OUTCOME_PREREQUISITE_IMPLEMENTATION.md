# Wave 8 — Slice 4 Prerequisite Implementation — Office Opportunity Outcome Authority

Status: COMPLETE. Local commit only, not pushed, not deployed. Implements exactly the five-step plan from the prerequisite audit (`docs/WAVE8_SLICE4_OFFICE_OPPORTUNITY_OUTCOME_PREREQUISITE.md` §26).

## 1. The five-step audit plan (verbatim reference)

1. Migration: `proposals.opportunity_id` (nullable, additive).
2. Extend `FIELD_POLICY`/`STATUS_TRANSITIONS` with an `opportunities` entry, stage-graph shaped, terminal at `won`/`lost`.
3. Add `opportunities` to the governed PATCH mechanism, with a CAS `expected_stage` precondition as the one deliberate deviation from the existing pattern.
4. Wire proposal accept/decline to also transition the linked Opportunity, additive alongside the existing Lead-level write.
5. No new event journal, no new Backend route, no OMA/OSA change.

**What was actually built deviates from step 3 in one respect, disclosed here**: rather than wiring `opportunities` into the *existing* `updateOperationalRecord`/`sanitizePatch` PATCH mechanism (which has no CAS precondition at all — a real limitation of that shared code, confirmed in the prerequisite audit §11), a small, dedicated `transitionOpportunity()` function was built instead, reusing every other piece of the existing pattern (`createCorporateRecord` for activities, the same `store.client`/`store.state` dual-path convention, the same `text()`/`nowIso()`/`errorWithStatus()` helpers) but with its own CAS-conditioned write. This is not a second CRM mutation framework — it is the smallest change that could satisfy the task's own mandatory CAS requirement without weakening the existing mechanism for the 7 collections that don't need it.

## 2. Schema

### Migration filename

`db/20260925120000_proposals_opportunity_id.sql`

```sql
alter table proposals add column if not exists opportunity_id uuid references crm_opportunities(id) on delete set null;
create index if not exists proposals_opportunity_id_idx on proposals (opportunity_id);
```

Nullable, additive, `on delete set null` (matches every other FK convention already in `db/lead-agents-schema.sql`). **Not applied to any live Supabase project by this task** — proven correct against a real, throwaway Postgres database (§25 below); a human applies it during actual deployment, per this programme's own "local implementation only" discipline.

`crm_opportunities` itself received **zero schema changes** — its existing `stage text not null default 'intake_received'` / `status text not null default 'open'` columns, with no CHECK constraint, already accept every literal this slice's stage graph produces.

## 3/4/5. proposals schema before/after, and lifecycle/stage/status semantics

**Before**: `id, lead_id (not null), title, tier_name, unit_count, monthly_price, currency, status, body, metadata, created_at, updated_at`.
**After**: same, plus `opportunity_id uuid references crm_opportunities(id) on delete set null`.

**Opportunity lifecycle** (`OPPORTUNITY_STAGE_TRANSITIONS`, `src/lead-agents/office-operational-workflows.js`), reusing `PIPELINE_STAGES`' own real literal set (`commercial-ops.js`), with `intake_received` (the column's own real DB default) as the sole entry point so no existing/historical row is ever reclassified:

```
intake_received → contacted | qualified | discovery_scheduled | site_visit_scheduled | proposal_sent | lost
contacted       → qualified | discovery_scheduled | site_visit_scheduled | proposal_sent | lost
qualified       → discovery_scheduled | site_visit_scheduled | proposal_sent | negotiation | lost
discovery_scheduled → site_visit_scheduled | proposal_sent | negotiation | lost
site_visit_scheduled → proposal_sent | negotiation | lost
proposal_sent   → negotiation | commercial_approved | won | lost
negotiation     → commercial_approved | won | lost
commercial_approved → won | lost
won             → (terminal)
lost            → (terminal)
```

**stage vs status**: `stage` = commercial pipeline position (the graph above). `status` is derived, never independently settable: `statusForOpportunityStage(stage)` → `"closed_won"` for `won`, `"closed_lost"` for `lost`, `"open"` otherwise. This mirrors the existing Lead convention (both fields set together at every real transition) and eliminates the drift risk the task explicitly warned against (§20) — there is no code path where `stage` and `status` can disagree.

## 6. Transition authority

`transitionOpportunity(store, { opportunityId, expectedStage, targetStage, evidenceType, evidenceId }, { actorEmail })` — `office-operational-workflows.js`. Office-owned (server-side only, no Backend write path exists or was created). The one and only place `crm_opportunities.stage`/`.status` can be written from application code (`grep -rn "crm_opportunities" src/lead-agents/*.js` after this change shows exactly this function's own two write branches plus the original creation site in `office-operating-system.js` — no other writer exists).

Wired into three existing Lead-scoped routes, **additively, never replacing the existing Lead-level write**:
- `POST /api/lead-agents/leads/:id/qualify` — when `body.opportunity_id` is explicit and the qualification outcome is `"qualified"`.
- `POST /api/lead-agents/leads/:id/commercial-approval` — when `body.opportunity_id` is explicit.
- `POST /api/lead-agents/leads/:id/proposals` — when the proposal itself carries an explicit `opportunity_id` (persisted at creation) and its status is `sent`/`accepted`/`declined`.

All three calls go through `safeTransitionOpportunity()`, a thin wrapper that catches any rejection (e.g. an invalid stage transition) and returns it inside the response's own `opportunity_transition` field rather than failing the underlying Lead-level request — per the task's own explicit instruction (§14) that the legacy Lead flow must keep working unchanged regardless of the Opportunity side's own state.

## 7. CAS

Mandatory, real. The write against a real Postgres-backed store (`store.client` branch) is:

```js
store.client.patch(
  `/crm_opportunities?id=eq.${opportunityId}&stage=eq.${currentStage}`,
  { stage: targetStage, status: statusForOpportunityStage(targetStage), updated_at: nowIso() },
  ...
);
```

The `stage=eq.<currentStage>` clause is the actual database-level precondition — a concurrent, contradictory UPDATE targeting the same precondition necessarily loses (zero rows matched) once the first one commits; Postgres's own row-level locking and MVCC make this atomic, not an application-level race. Proven directly with two genuinely simultaneous raw SQL UPDATEs against a real database (§26). The file-store path (`store.state`) mirrors the same check (re-reads `list[index].stage` immediately before mutating) for local/dev parity, though true concurrency isn't meaningful in that single-threaded path.

## 8. Idempotency

`findExistingOpportunityTransitionActivity()` scans `crm_activities` for an existing `activity_type: "opportunity_stage_changed"` row matching `related_id` + `evidence_type` + `evidence_id` + `target_stage`; if found, the call returns that activity as a no-op (`applied: false, reason: "idempotent_replay"`) rather than writing again. Stable evidence identity is available and used everywhere a real persisted entity backs the event: `proposal.id` (proposal accept/decline/sent) is a genuine, stable identifier reused across retries. For qualification/commercial-approval (routes with no persisted "event" record of their own), the HTTP request's own `ctx.requestId` is used — **a disclosed, narrower guarantee**: it makes a literal retry of the same request idempotent, but does not (and does not claim to) collapse two genuinely separate qualification calls for the same lead/opportunity over time. This is the honest limit of what the existing schema can stably identify without adding a new table, per the task's own "if the existing schema cannot guarantee this, STOP and report the exact limitation" instruction (§8) — reported here, not hidden, rather than inventing a stronger guarantee.

## 9. Evidence contract

Every transition requires non-empty `evidenceType` + `evidenceId` — enforced structurally (`transitionOpportunity` throws `transition_evidence_required` otherwise, no code path can skip this). Real evidence types wired in this slice: `qualification_completed`, `commercial_approval`, `proposal_sent`, `proposal_accepted`, `proposal_declined`. Message delivery, generic replies, and sentiment alone are never used anywhere as evidence — confirmed by inspection: no caller of `transitionOpportunity` anywhere references `InboundReplyOutcome`, sentiment, or delivery status.

## 10. Activity/audit behavior

Every **applied** transition creates exactly one `crm_activities` row (`activity_type: "opportunity_stage_changed"`, `related_type: "opportunity"`, `related_id`/`opportunity_id` set, `metadata: {previous_stage, target_stage, evidence_type, evidence_id}`) via the same `createCorporateRecord(store, "activities", ...)` primitive every other collection's own activity trail already uses — no second transition-history platform. A conflict (`concurrent_transition_conflict`, `stale_expected_stage`, `terminal_stage_protected`) creates **zero** activities. An idempotent retry creates **zero** duplicate activities (returns the original). Proven directly (§24).

## 11/12. Proposal creation and acceptance

Creation (`POST /leads/:id/proposals`): `body.opportunity_id`, when present, is validated against a real row (`findOpportunityRecord`) before being persisted on `store.createProposal()` — a 404 otherwise. Never inferred from `leadId`. `NULL` when absent, honestly.

Acceptance: when `proposal.opportunity_id` is set and `body.status === "accepted"`, `transitionOpportunity` is called with `targetStage: "won"`, `evidenceType: "proposal_accepted"`, `evidenceId: proposal.id` — through the one canonical authority, never a direct `crm_opportunities` write from route code (confirmed: the proposal route itself contains no `crm_opportunities` reference outside this one `transitionOpportunity` call).

## 13. Proposal decline

`targetStage: "lost"`, `evidenceType: "proposal_declined"`. This mirrors the audited, **already-existing** Lead-level judgment (`lost_reason: "proposal_declined"`, `commercial_stage: "lost"`, set unconditionally on decline by the same route today) — not an invented new semantic. No "declined but pursuit continues" state exists anywhere in the current schema/code (no re-proposal workflow, no partial-decline field), so there was no established, different business semantic to preserve instead.

## 14. Lead compatibility

Zero lines removed from any existing Lead-level write in `qualify`, `commercial-approval`, or `proposals`. Confirmed via `git diff` — every edit in these three routes is a pure addition after the existing logic, gated by `safeTransitionOpportunity`'s own catch-and-report behavior so an Opportunity-side rejection can never break the Lead flow. Proven directly: the existing `test-office-jv-opportunity-evidence.js` and `test-office-crm-intake.js` suites, which exercise these exact routes with no `opportunity_id` supplied, pass unchanged.

## 15. Multi-opportunity proof

Proven directly (`test-office-opportunity-outcome-authority.js`): one lead, two Opportunities, two proposals (each with its own distinct `opportunity_id`). Accepting Proposal A transitions Opportunity A to `won`; Opportunity B is asserted **byte-for-byte unchanged** (`stage: "proposal_sent"`, `status: "open"`) immediately after. No lead-level ambiguity was involved in producing this result — the transition is keyed by `opportunityId` alone.

## 16/17. Qualification and commercial approval

Both routes: Opportunity transition fires **only** when `body.opportunity_id` is explicitly supplied by the caller (never resolved by scanning "this lead's opportunities"). When absent, behavior is byte-identical to before this slice — proven by the unchanged existing test suites. Commercial approval targeting `"commercial_approved"` genuinely requires the Opportunity to already be at `proposal_sent` or `negotiation` (real graph edges) — a premature call is honestly rejected via `safeTransitionOpportunity`, never silently accepted.

## 18. Meeting/site-visit behavior

**Not wired in this slice.** `office_meetings` has a real, governed completion state (`STATUS_TRANSITIONS.meetings`, `completed_at` auto-stamped) — genuine evidence a meeting occurred — but no code path in this slice connects a completed meeting to an Opportunity transition, because no meeting-to-Opportunity linkage is enforced anywhere (`related_type`/`related_id` are optional and not Opportunity-specific). Wiring this honestly would require first establishing that linkage as a real, provable relationship — out of this narrow prerequisite's scope, disclosed here as a remaining gap rather than invented.

## 19. Terminal-state protection

`OPPORTUNITY_STAGE_TRANSITIONS.won` and `.lost` are both `[]` — zero outgoing edges. `transitionOpportunity` checks this before anything else after the idempotency check: `if (!allowedTargets.length) return { applied: false, reason: "terminal_stage_protected" }`. Proven directly: a delayed/stale transition attempt against an Opportunity already at `won` is rejected, and the record is asserted unchanged afterward (§24). No reopen mechanism was built — existing Office semantics provide no precedent for one, so per the task's own instruction ("otherwise fail closed"), failing closed is the only behavior implemented.

## 20. Status drift protection

Already covered in §5 — `status` is always derived from `stage` inside the same write, never settable independently through this authority.

## 21. Human authority

No public/client-facing route was added or modified. All three wiring points (`qualify`, `commercial-approval`, `proposals`) remain gated by their existing `authorizePermission` calls (`manage_leads`/`manage_commercial`), unchanged. OMA/OSA were not touched — `office-tool-governance.js` (the one real agent-facing mutation path) was read but not modified; it continues to write only to `leads`, never to `crm_opportunities`, confirmed unchanged by `git diff`.

## 22. Backend boundary

**Zero Backend files touched** — confirmed via `git status --short` in `/Users/ochigaidoko/Documents/Ochiga-backend` before and after this task, HEAD unchanged at `5494725`. No new Backend route was created. Backend's own existing `opportunity_id` wiring (Wave 7 Slice 7) already references Opportunity identity by id — it requires no change to eventually read this new, real stage/status once a future, separately-authorized Slice 4 evaluator is built.

## 23. Conversions-stat disposition

`office-data.js`'s hardcoded `conversions: 34/22/14` literals were **left untouched** — removing/relabeling them is not part of the audited five-step plan (§1), and the task's own instruction is explicit ("otherwise leave source untouched but explicitly classify it as non-authoritative"). Classification: **OUTCOME-AUTHORITY RISK** (per the prerequisite audit §17), reconfirmed. Nothing in this slice's new code reads or references `office-data.js` in any way — `grep -rn "office-data" src/lead-agents/office-operational-workflows.js` returns nothing — so this fabricated figure cannot reach Core through any path built here.

## 24. Multi-opportunity proof, idempotency, activity, terminal-state proof (functional)

`scripts/test-office-opportunity-outcome-authority.js`, file-store-backed, 8/8 checks passing:
1. A fresh opportunity defaults to `intake_received`, unmodified.
2. A transition without evidence is rejected.
3. A valid, evidence-backed transition applies and creates exactly one activity.
4. The same evidence retried is idempotent — zero duplicate activity.
5. A stale `expected_stage` is rejected — no mutation, no activity.
6. `won`/`lost` are terminal — a delayed event can never reopen or regress them.
7. Proposal creation persists the explicit `opportunity_id`, never inferred, never shared.
8. Accepting Proposal A changes only Opportunity A; Opportunity B (same lead) is untouched.

## 25/26. Real-Postgres migration and concurrency proof

`scripts/test-office-opportunity-outcome-authority-sql.js`, real Postgres (the shared local Supabase Postgres container already running for the Backend repository's own SQL smokes — a fresh, isolated throwaway database created and dropped for this test only, no Backend or Office production data touched), 8/8 checks passing:
1. The migration applies cleanly on top of existing data.
2. The migration is idempotent — re-applying is a no-op, not an error.
3. A historical proposal (predating the migration) has `NULL opportunity_id` — no speculative backfill.
4. A new proposal can reference a real Opportunity.
5. An invalid Opportunity FK is genuinely rejected by the real constraint.
6. The index exists in the catalog (a 2-row throwaway table's own planner correctly prefers a sequential scan at that tiny scale — existence in `pg_indexes`, not the planner's cost choice, is what this proves).
7. **Two genuinely simultaneous, contradictory `UPDATE ... WHERE stage=eq.<X>` statements (the exact CAS shape `transitionOpportunity` issues) racing the same precondition — exactly one wins, proven via `Promise.all` on two real, concurrent `psql` invocations.**
8. A third, later attempt against the now-stale original expected stage is correctly rejected.

## 27. Proposal proof

Covered in §24 items 7-8 (multi-opportunity isolation is exactly the proposal-linkage proof: two proposals, two opportunities, acceptance of one never touches the other).

## 28. Office regression

`npm run check`, `npm run lint`, `npm run build`, and the existing `office:intake:test`, `office:crm-intake:test`, `office:contract-hardening:test`, `office:operational-mutations:test`, `office:operating-system:test`, and `scripts/test-office-jv-opportunity-evidence.js` suites — **all passed unchanged**, alongside the two new test suites. 11/11 steps in the regression battery.

## 29. Backend regression

Not run — Backend was not modified (§22), and the prerequisite audit's own instruction was "DO NOT MODIFY BACKEND." Backend HEAD reconfirmed unchanged at `5494725` before and after this task.

## 30. Performance

`findOpportunityRecord` is a bounded, PK-indexed lookup (`id=eq.<id>&limit=1` for the real-Postgres path, a direct array `.find()` for the file-store path) — deliberately built as a NEW function rather than reusing `findCorporateRecord` (which, for any collection other than `leads`/`proposals`/`documents`/`reports`, fetches the entire table and filters in JS). `transitionOpportunity` performs a fixed number of round-trips regardless of table size: one read (idempotency check via the existing `activities` list — bounded by the same convention every other collection's activity list already uses), one conditional write, one activity insert. No scan-by-lead anywhere — every call site is keyed by an explicit `opportunityId`.

## 31. Security

No new route was added; all wiring reuses the three existing routes' own pre-existing `authorizePermission` gates (`manage_leads`, `manage_commercial`). `transitionOpportunity` itself is a server-side function, not a route — it has no independent authorization surface to audit; its only callers are the three permission-gated routes above. No public/client-facing mutation path was created.

## 32. Files changed

- `db/20260925120000_proposals_opportunity_id.sql` (new) — the one migration.
- `src/lead-agents/office-operational-workflows.js` — `OPPORTUNITY_STAGE_TRANSITIONS`, `statusForOpportunityStage`, `findOpportunityRecord`, `findExistingOpportunityTransitionActivity`, `transitionOpportunity`, plus a documentation-only `FIELD_POLICY.opportunities` entry and new exports.
- `src/lead-agents/store-supabase.js`, `src/lead-agents/store-file.js` — `createProposal` persists `opportunity_id` (explicit only).
- `src/lead-agents/server.js` — `safeTransitionOpportunity` helper; wiring into the qualify, commercial-approval, and proposal-creation routes.
- `scripts/test-office-opportunity-outcome-authority.js`, `scripts/test-office-opportunity-outcome-authority-sql.js` (new tests).
- `package.json` — two new script entries.
- `docs/WAVE8_SLICE4_OFFICE_OPPORTUNITY_OUTCOME_PREREQUISITE_IMPLEMENTATION.md` (this file).

## 33. Migrations

One: `db/20260925120000_proposals_opportunity_id.sql`. Not applied to any live Supabase project by this task.

## 34/35. Tests/results, environment failures

`npm run check`/`lint`/`build`: clean. New functional test: 8/8. New real-Postgres test: 8/8. Full regression battery: 11/11. No environment failures encountered.

## 36. Newly discovered gaps

1. Meeting/site-visit completion is not wired to Opportunity transitions (§18) — a real gap, disclosed rather than filled, since no provable meeting→Opportunity linkage exists yet to build on honestly.
2. Qualification/commercial-approval idempotency is request-scoped, not entity-scoped (§8) — disclosed, not a schema addition.
3. The fabricated Conversions dashboard stat remains untouched (§23), per explicit instruction — still worth a dedicated fix outside Wave 8's scope.
4. No route exists yet for a human to directly drive an Opportunity transition outside these three existing Lead-scoped flows — intentionally out of scope; commercial truth changes remain anchored to real business events (qualification, approval, proposal outcome), not a free-form admin PATCH.

## 37. Whether Opportunity Outcome Authority is ESTABLISHED

**Yes.** `crm_opportunities.stage`/`.status` are no longer permanently frozen at `intake_received`/`open` — a real, Office-owned, CAS-safe, idempotent, evidence-backed, auditable, multi-opportunity-safe, terminal-state-safe transition authority now exists and is wired into three real business events, proven against both a functional file-store harness and a real Postgres instance under genuine concurrency.

## 38. Whether Wave 8 Slice 4 (Commercial Outcome Evaluator) may now begin

Only after separate, explicit authorization for that slice specifically — this task's own stop condition (and the original prerequisite audit's own instruction) is to establish and prove the Opportunity authority, then stop. No Commercial Outcome Evaluator code was written; no Backend file was touched; OMA/OSA were not modified; Wave 8 Slice 5 was not started.
