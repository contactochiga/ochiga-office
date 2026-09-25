# Wave 8 — Slice 4 Prerequisite — Office Opportunity Outcome Authority Audit / Design Gate

Status: READ-ONLY AUDIT/DESIGN GATE. Uncommitted. No source, schema, or migration file was created or modified in either repository to produce this document.

Backend baseline: `5494725` (Wave 8 Slice 3). Office baseline: branch `communications/handoff-accept-production-fix`, HEAD `b4a3a8f`, 0 ahead/0 behind `origin`, working tree clean except the pre-existing untracked `supabase/` directory.

## 1/2. Repository state

Backend: `git rev-parse HEAD` = `5494725...` exactly as expected. Working tree: only the same protected pre-existing noise carried through this entire programme (`scripts/pilot-import.mjs`, `src/routes/me.routes.ts` modified; aider artifacts, prior audit docs, `LOCAL_TEST_` migrations untracked). Nothing touched.

Office: branch `communications/handoff-accept-production-fix`, HEAD `b4a3a8f`, tracking `origin/communications/handoff-accept-production-fix`, `0 ahead / 0 behind`. Untracked: one unrelated `supabase/` directory (pre-existing, noted in prior audits). Office is the commercial system of record throughout this audit — read-only.

## 3. crm_opportunities schema (reconstructed in full)

`db/lead-agents-schema.sql:107-122`:

```sql
create table if not exists crm_opportunities (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references crm_contacts(id) on delete set null,
  organization_id uuid references crm_organizations(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  business_unit text not null default 'corporate',
  inquiry_type text not null default 'general_enquiry',
  pipeline text not null default 'corporate',
  stage text not null default 'intake_received',
  status text not null default 'open',
  owner text,
  source text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

No `alter table crm_opportunities`, no `create index` beyond the primary key, and **no CHECK constraint on `stage` or `status`** anywhere in the schema file (grepped exhaustively — zero hits). Referenced by `crm_activities.opportunity_id`, `crm_tasks.opportunity_id`, `office_private_relationships`/`office_partnership_relationships.opportunity_id`, `office_handoffs.crm_opportunity_ref` (free text, not FK-constrained).

**Actual stage/status literals found in source** (none invented): the ONLY literal ever assigned to `crm_opportunities.stage`/`.status` anywhere in the codebase is the default itself — `stage: "intake_received"` (`office-intake.js:360`, `office-operating-system.js:117`) and `status` defaulting to `"active"` (`office-operating-system.js:81`, the shared `base` object every collection inherits) or `"open"` (the column's own DB default, never actually reached in practice since every real insert goes through `normalizeCorporateRecord`, which sets `status` to `"active"`). **No second stage/status literal for `crm_opportunities` exists in source at all** — confirming no code path has ever advanced it past creation.

## 4. Actual lifecycle literals across the codebase (not invented)

The REAL, live commercial-pipeline vocabulary in Office today is `PIPELINE_STAGES` (`commercial-ops.js:3-14`): `new, contacted, qualified, discovery_scheduled, site_visit_scheduled, proposal_sent, negotiation, commercial_approved, won, lost` — but this vocabulary is applied exclusively to **`leads.stage`/`leads.commercial_stage`**, never to `crm_opportunities.stage`. This is the central finding of this entire audit, reconfirmed from first principles below.

## 5. Mutation-path inventory (exhaustive)

Every real write site touching `crm_opportunities` found by direct source trace:

| Site | Mechanism | Effect |
|---|---|---|
| `office-intake.js:350` (`createCorporateRecord`, no existing id) | INSERT | Creates the opportunity ONCE, at public-form intake time, via `shouldCreateOpportunity()`. `stage: "intake_received"` (default), never anything else. |
| `office-operating-system.js:257-302` (`createCorporateRecord`, generic) | Technically capable of UPDATE (PATCH by id) IF called with an existing UUID `id` in the POST body | **Never invoked this way for opportunities anywhere in the codebase** — see below. |

Every OTHER "opportunity"-adjacent write site found resolves to the **`leads`** table, not `crm_opportunities`:

| Route/function | Table written | Fields | Evidence |
|---|---|---|---|
| `office-tool-governance.js::leadPatchForProposal` + `executeGovernedOfficeToolProposals` (`crm.qualify_opportunity`/`crm.create_opportunity` tool proposals) | `leads` (`store.updateLead`) | `commercial_stage`, `status`, `owner` | Code's own comment (lines 31-43) states explicitly: *"this proposal never creates an office_opportunities row. It only ever advances the EXISTING lead's own status/stage."* |
| `PATCH /api/lead-agents/leads/:id` | `leads` | free-form via `sparseLeadPatchFromBody` | `server.js:~4130` |
| `POST /api/lead-agents/leads/:id/qualify` | `leads` | `qualification.patch` | `server.js:~4165` |
| `POST /api/lead-agents/leads/:id/building-review` | `leads` (+ creates a `demos` row) | `stage`/`commercial_stage`: `discovery_scheduled`/`site_visit_scheduled`, `status: "booked"` | `server.js:~4220` |
| `POST /api/lead-agents/leads/:id/commercial-approval` | `leads` | `stage`/`commercial_stage`: `commercial_approved`/`negotiation`, `status` | `server.js:~4255` |
| `POST /api/lead-agents/leads/:id/proposals` (proposal create) | `leads` (+ creates a `proposals` row) | `commercial_stage`/`stage`/`status`: `won`/`lost`/`proposal_sent`, `lost_reason: "proposal_declined"` | `server.js:~4576-4599` |

**No route, background job, scheduler, or material-event handler anywhere in the Office codebase writes to `crm_opportunities.stage` or `.status` after creation.** `backend-events.js`/`oyi-core-gateway.js` (the Backend↔Office material-event bridge) were checked and only ever *read* opportunity data to build evidence payloads for Backend (`buildDevelopmentEvidence`) — never write to `crm_opportunities`.

## 6. Immutability — proven, not merely reconfirmed

Beyond re-checking "no PATCH route exists" (true — the only route matching `crm_opportunities` as a collection, `/api/lead-agents/admin/crm/(contacts|organizations|opportunities|activities|tasks)$`, supports GET/list and POST/create only, no `:id` suffix variant), this audit found the **definitive, code-level reason**: the SEPARATE, governed PATCH-by-id mechanism that DOES exist for seven other collections (`office-operational-workflows.js`'s `FIELD_POLICY` + `STATUS_TRANSITIONS`, backing `updateOperationalRecord`, used by real `PATCH /api/lead-agents/admin/crm/:collection/:id`-shaped routes at `server.js:5157`/`5353`) **explicitly excludes `opportunities`**:

```js
const FIELD_POLICY = Object.freeze({
  tasks: [...], support: [...], projects: [...], portfolio: [...],
  meetings: [...], private: [...], partnerships: [...], documents: [...],
  // "opportunities" is absent.
});
const STATUS_TRANSITIONS = Object.freeze({
  tasks: {...}, support: {...}, projects: {...}, portfolio: {...},
  meetings: {...}, private: {...}, partnerships: {...},
  // "opportunities" is absent here too.
});
```

`opportunities` DOES appear in `RELATED_TYPES`/`ACTIVITY_MANAGE_PERMISSIONS` — but only so other objects (tasks, activities, private/partnership relationships) can *reference* an opportunity by id and be permission-checked against it, never so the opportunity itself can be mutated.

A secondary, lower-level mechanism (`createCorporateRecord`, §5) is technically capable of an update-by-id for `opportunities` (it is in `UUID_PK_COLLECTIONS`) — but is proven, exhaustively, never to be invoked that way: `grep "admin/crm/opportunities"` across the entire frontend (`public/office/office.js`, 14,474 lines) returns zero matches (every hit is a read-only `#/crm/opportunities/:id` deep link or rail-card display), and no server-side caller anywhere constructs a POST to this route with an existing opportunity id.

**Verdict: `crm_opportunities.stage`/`.status` are immutable in practice, by the complete absence of any live caller — not by a schema constraint, but the absence is total and provable across every category of caller the task asked to check (routes, services, RPCs, background jobs, material-event handlers, proposal flows, handoff flows, meeting flows).**

## 7. Commercial evidence classification

| Event | Classification | Why |
|---|---|---|
| Reply received | CHANNEL_ACTIVITY | Proves delivery/engagement only; drives `leads.commercial_stage` in some flows, never a stage transition proof on its own. |
| Qualification completed (`/leads/:id/qualify`) | WORKFLOW_PROGRESS | Human/agent judgment call, written to `leads`, not independently verifiable evidence of a business event. |
| Requested documents received | NOT_ENOUGH_EVIDENCE | No route/field for this was found anywhere in Office. |
| Demo/building-review scheduled | WORKFLOW_PROGRESS | Creates a `demos` row + advances `leads.stage`; no independent confirmation the demo will happen. |
| Demo/building-review completed | NOT_ENOUGH_EVIDENCE | **No route or field exists to mark a demo completed** (§14) — Office cannot currently prove this occurred. |
| Meeting scheduled | WORKFLOW_PROGRESS | `office_meetings.status: "scheduled"`, requires `scheduled_at` (enforced, `sanitizePatch`). |
| Meeting completed | COMMERCIAL_STAGE_EVIDENCE (for the meeting itself only) | `office_meetings` has a REAL governed status machine (`STATUS_TRANSITIONS.meetings`) with `completed_at` auto-stamped — genuine, provable evidence a meeting occurred, but **never propagates to any linked Opportunity**. |
| Proposal created/sent | WORKFLOW_PROGRESS | `proposals.status: "draft"/"sent"`, `leads.commercial_stage: "proposal_sent"`. |
| Proposal accepted | TERMINAL_COMMERCIAL_OUTCOME (currently misattributed — see §15) | `leads.commercial_stage: "won"`, `status: "closed"` — a real, meaningful business event, but written to the Lead, not any specific Opportunity. |
| Proposal declined | TERMINAL_COMMERCIAL_OUTCOME (currently misattributed) | `leads.commercial_stage: "lost"`, `lost_reason: "proposal_declined"` — same misattribution. |
| Negotiation | WORKFLOW_PROGRESS | `leads.stage: "negotiation"` (commercial-approval route, `approved: false` branch). |
| Won / Lost | TERMINAL_COMMERCIAL_OUTCOME (misattributed) | See §15 — real vocabulary exists, wrong identity layer. |
| Deferred | NOT_ENOUGH_EVIDENCE | No literal, route, or field for "deferred" was found anywhere. |
| Human handoff | WORKFLOW_PROGRESS | `office_handoffs.status`, `lead_id`-scoped (§13) — operational routing, not commercial outcome. |

## 8. Stage vs. status semantics

Office's own code treats `stage` and `status` as genuinely **different axes already**, not an accidental duplication: `stage` (e.g. `intake_received`, `qualified`, `proposal_sent`, `won`) is the **pipeline position** — where in the commercial journey the record sits; `status` (e.g. `open`/`active`/`closed`/`booked`/`approved`) is a **coarser operational state** — is this record currently being worked, or has it left active management. Both live on `leads` today and are set together at every transition (e.g. commercial-approval sets `stage: "commercial_approved"` AND `status: "approved"` simultaneously) — they are not ambiguous in practice, just currently applied only to `leads`, never `crm_opportunities`. Recommendation for Opportunity: keep the same two-axis split (`stage` = pipeline position, reusing `PIPELINE_STAGES` semantics; `status` = `open | closed_won | closed_lost`), mirroring the existing, working Lead convention rather than inventing new semantics.

## 9. Transition authority

No actor currently has the ability to advance `crm_opportunities.stage`/`.status` — the question is moot until §17's minimal contract exists. When built, per this audit's own findings and the task's explicit invariant ("commercial truth must remain Office-owned"): **human staff via an explicit Office UI action, and Office's own deterministic material-event/intake logic (mirroring `office-intake.js`'s existing `shouldCreateOpportunity()` pattern) should be the only two producers.** OMA/OSA propose (via the existing governed tool-proposal path); they must never call a hypothetical Opportunity-transition function directly without staff/deterministic-event gating — matching §22's principle and the fact that `crm.qualify_opportunity`'s own code comment already documents this exact boundary for the Lead-level equivalent.

## 10. Transition evidence requirements

Every automatic transition must cite a concrete Office event id (a `proposals.id`, `office_meetings.id`, or `demos.id`), never a bare inference from channel activity. Precedent: `activityForMutation()` (`office-operational-workflows.js:337-366`) already generates a `${collection}_status_changed` activity automatically on every governed PATCH for the seven collections that have one — the same infrastructure would apply to `opportunities` for free once wired in (see §18/§19).

## 11. CAS / idempotency / concurrency requirements

The EXISTING `updateOperationalRecord` pattern (used by meetings/projects/etc. today) has a real, disclosed weakness worth carrying forward as a lesson, not blindly copying: `assertTransition()` validates the transition against `STATUS_TRANSITIONS` using a `current` record read moments earlier, but `persistCorporateRecord()`'s actual write (`PATCH .../table?id=eq.<id>`, `office-operational-workflows.js:295-312`) has **no `WHERE status = expected` precondition** — two concurrent requests reading the same `current.status` could both pass `assertTransition` and the second write would silently overwrite the first (last-write-wins), exactly the Wave 6 lesson this task explicitly asked to apply. **Recommendation for Opportunity specifically** (since Backend's Slice 4 evaluator will treat a stage transition as factual evidence, unlike the lower-stakes internal collections): add a genuine CAS precondition — `PATCH .../crm_opportunities?id=eq.<id>&stage=eq.<expectedStage>` — and treat a zero-row response as a conflict to surface to the caller, rather than reusing the existing collections' weaker pattern unmodified.

## 12. Multi-opportunity proof (Slice 7 invariant reconfirmed)

`crm_opportunities.lead_id` is a plain FK, not unique — multiple opportunity rows can and do share one `lead_id` (this is the entire point of Wave 7 Slice 7's own multi-opportunity work). No transition mechanism exists today, so there is nothing to reprove operationally yet — but the schema itself imposes no barrier: any future `transitionOpportunity()` keyed by `opportunityId` (not `leadId`) would naturally satisfy "a transition for Opportunity A must never alter Opportunity B," since it would target one specific `id=eq.<opportunityId>` row.

## 13. Proposal collision

`proposals` table (`db/lead-agents-schema.sql:246-259`) columns: `id, lead_id, title, tier_name, unit_count, monthly_price, currency, status, body, metadata, created_at, updated_at` — **no `opportunity_id` column exists, confirmed exhaustively** (grepped the full schema file). **This means proposal accept/decline cannot today be trustworthy Opportunity outcome evidence when a lead has more than one open Opportunity** — Office has no way to know which specific Opportunity a given proposal concerns. **Exact prerequisite**: add `opportunity_id uuid references crm_opportunities(id) on delete set null` to `proposals` (additive, nullable — proposals created before multi-opportunity identity existed simply have `null`) before proposal outcome can safely drive Opportunity-level (not just Lead-level) transitions.

## 14. Handoff collision

`office_handoffs` (`db/lead-agents-schema.sql:1081-1109`) has both `crm_opportunity_ref text` (a free-text reference field, not FK-constrained, populated only as a display/lineage hint) and `lead_id uuid` (added later, per its own migration comment, specifically for dedup — `office_handoffs_lead_idx on office_handoffs (lead_id, status)`). Handoff dedup is confirmed `lead_id`-scoped. Since handoffs never write to `crm_opportunities` at all (§5), this collision affects only **operational ownership routing** (who is assigned to handle a session) — it has zero bearing on commercial outcome truth, and the two concerns are already correctly separate in the schema (kept separate here too, per the task's own instruction).

## 15. Demo/meeting evidence

`demos` (`db/lead-agents-schema.sql:234-241`): `id, lead_id, scheduled_for, status, notes` — `status` is set once at creation (`"confirmed"` or `"pending"`, or an explicit caller-supplied value) and **never updated again anywhere in the codebase** — grepped for any `updateDemo` function or a demos PATCH route: none exists. Office genuinely cannot prove a demo was completed, cancelled, or no-show today. This is not treated as an outcome authority anywhere.

`office_meetings` (governed by `FIELD_POLICY.meetings`/`STATUS_TRANSITIONS.meetings`) is a **real, positive counter-example**: `scheduled → completed/cancelled` is enforced, `completed_at`/`cancelled_at` are auto-stamped server-side (`sanitizePatch`, lines 206-213), and a `scheduled_at` precondition is enforced before a meeting can even be marked scheduled. This is genuine, durable, provable evidence a meeting occurred — but meetings link to an Opportunity only loosely via `related_type`/`related_id` (optional, never required), and completing a meeting never propagates any signal to the linked Opportunity today.

## 16. Won/lost behavior

Confirmed exactly as Slice 0 found, now traced to exact code (§5/§7): proposal accept/decline (`server.js:~4576-4599`) writes `commercial_stage: "won"|"lost"`, `status: "closed"|"lost"`, `lost_reason: "proposal_declined"` **onto the Lead**, never the Opportunity, never the Proposal itself (the `proposals` row only stores its own `status: "accepted"|"declined"`, no separate won/lost field). Under the multi-opportunity model this is genuinely unsafe as Opportunity-level evidence — a Lead-level `commercial_stage: "won"` cannot say WHICH of several simultaneous Opportunities for that lead actually won, exactly the ambiguity Slice 0 flagged.

## 17. Fabricated conversions stat — reconfirmed

`office-data.js:352,365,378`: three literal, hardcoded `conversions: 34` / `conversions: 22` / `conversions: 14` values feed directly into `totalConversions` (a `.reduce()` sum, `office-data.js:514`), which is then displayed on the Home dashboard as `{label: "Conversions", value: totalConversions}` and a derived "Conversion rate" percentage (`office-data.js:649,750,757`). **Classification: OUTCOME-AUTHORITY RISK, not merely hygiene** — this number has the visual/structural shape of a real commercial-outcome metric and sits directly adjacent to genuine analytics (session counts, active agents) in the same dashboard payload, making it easy for a future evaluator (human or automated) to mistake it for real signal. **It must never be used as evidence by any Backend evaluator, and should be flagged to Office's own maintainers as a pre-existing, independent data-integrity issue** — unrelated to Wave 8, not fixed here per this task's own scope boundary.

## 18. Proposed minimum Opportunity transition contract (design only, not implemented)

Derived from Office's own existing, proven conventions (`FIELD_POLICY`/`STATUS_TRANSITIONS`/`updateOperationalRecord`/`activityForMutation`) rather than the task's own illustrative Salesforce-flavored shape:

```js
// Extend office-operational-workflows.js's own existing pattern:
FIELD_POLICY.opportunities = ["stage", "status", "owner", "business_unit", "metadata"];
STATUS_TRANSITIONS.opportunities is NOT status-graph-shaped like the others --
propose a PARALLEL stage graph (opportunities' meaningful axis is `stage`,
not `status`, unlike every existing collection): reuse PIPELINE_STAGES'
own literal ordering as the allowed-transition graph, e.g.
  intake_received -> [qualified, lost]
  qualified -> [discovery_scheduled, site_visit_scheduled, proposal_sent, negotiation, lost]
  ... (mirrors PIPELINE_STAGES exactly, terminal at won/lost)
status becomes derived (open until stage in {won, lost}, then closed_won/closed_lost) --
never dual-write two independent free-text fields as this audit's own
§8 recommendation.
```

Real HTTP shape (mirrors the existing `PATCH /api/lead-agents/admin/crm/:collection/:id` route already serving meetings/projects/etc., extended to accept `opportunities`):

```
PATCH /api/lead-agents/admin/crm/opportunities/:id
Body: { stage, expected_stage, evidence_type, evidence_id, actor_note }
```

Required properties, all satisfied by this design: **Office-owned** (server-side route, `crm.manage` permission, no Backend write path — §20). **CAS-safe** (§11's `expected_stage` precondition, a genuine improvement over the existing pattern, not a blind copy). **Idempotent** (a retry with the same `expected_stage` that no longer matches current state fails closed, never double-applies). **Evidence-backed** (§10 — `evidence_type`/`evidence_id` required for any automatic transition; a human staff action via the UI may omit it, matching `office_meetings`' own human-vs-automatic distinction). **Auditable** (reuses `activityForMutation` → `crm_activities`, already `opportunity_id`-scoped — §19). **Multi-opportunity-safe** (§12 — keyed by `opportunityId`, never `leadId`). **Terminal-state-safe** (won/lost have no outgoing edges in the proposed graph, matching every existing `STATUS_TRANSITIONS` entry's own terminal-state convention).

## 19. Migration requirement

**Not required for `crm_opportunities` itself** — the existing `stage`/`status` text columns, with no CHECK constraint, already accept any value the transition contract's own code-level graph (§18) would produce; no new column is needed on this table. **One additive migration IS required, but on `proposals`, not `crm_opportunities`**: `proposals.opportunity_id uuid references crm_opportunities(id) on delete set null` (§13) — nullable, backward-compatible with every existing proposal row, needed before proposal-outcome evidence can safely drive Opportunity-scoped (not just Lead-scoped) transitions under the multi-opportunity model. This is disclosed here, not created — awaiting explicit authorization per the task's own instruction.

## 20. History/audit requirement

No dedicated Opportunity transition-history table is needed. `crm_activities` already has a real, populated `opportunity_id` FK column (`db/lead-agents-schema.sql:129`) and the existing `activityForMutation()`/`createRelatedActivity` infrastructure already generates a `${collection}_status_changed` activity automatically on every governed patch for every collection that has one today — extending `FIELD_POLICY`/`STATUS_TRANSITIONS` to include `opportunities` (§18) would give Opportunity transition history "for free" through this exact, already-proven mechanism, satisfying the task's own preference for reusing existing activity/event history over inventing a second event journal.

## 21. Backend consumption contract (Core reads, never writes)

Backend should consume, never mutate, Opportunity truth. The clean read surface Office would need to expose (via a real, read-only route or the existing material-event evidence-building pattern `backend-events.js` already uses): opportunity `id`, `lead_id` (for cross-reference to existing Decision/Goal lineage that currently keys off `lead_id`/`opportunity_id` per Wave 7 Slice 7), current `stage`/`status`, the evidence reference (`evidence_type`/`evidence_id`) behind the CURRENT stage, `updated_at`, and a derived terminal-outcome classification (`won | lost | open`). No second CRM should ever exist in Backend — this mirrors exactly the read-only posture `corporatePublicConversationPolicy.ts`/`officeMaterialEventAdapter.ts` already maintain toward Office today.

## 22. Wave 8 Slice 4 evaluator requirements (documented, not implemented)

The future Commercial Outcome Evaluator (Backend-side, mirroring `deviceOutcomeEvaluator.ts`'s own proven shape from Wave 8 Slice 1) will need, once Office's transition authority exists: Opportunity id, the Decision/Goal lineage that targeted it (already resolvable via `officeMaterialEventAdapter.ts`'s existing `opportunity_id` wiring, Wave 7 Slice 7), the previous and current stage, the evidence reference behind the current stage, the observation timestamp (`updated_at`), and a commercial-outcome classification (`achieved | not_achieved | unverified`, mirroring Wave 8 Slice 3's own `GoalOutcomeState` taxonomy for consistency). Not implemented here.

## 23. OMA/OSA future principle (documented, not implemented; agents untouched)

OMA/OSA may propose or perform commercial activities (send a proposal, schedule a demo, request a handoff) through Office's own existing governed tool-proposal path (`office-tool-governance.js`, unchanged by this audit). **Office's Opportunity transition authority (§18, once built) determines factual commercial progression — never the agent's own claim.** Core's future outcome evaluator (§22) consumes Office's own recorded stage/evidence, exactly as Wave 8 Slice 1's device evaluator consumes Wave 6's own canonical state rather than trusting a dispatch's own "ok" flag. **Agents do not self-declare sales success** — this principle is already implicitly honored today (no agent-authored field currently claims a won/lost outcome; the Lead-level `commercial_stage: "won"` is set by a deterministic, human-triggered proposal-accept route, never by OMA/OSA directly) and must remain true once Opportunity-level transitions exist.

## 24. End-to-end scenarios (A–H)

| # | Scenario | What Office currently records | What it can prove | What it cannot prove | What §18's contract would need to do |
|---|---|---|---|---|---|
| A | JV enquiry → qualification | `leads.commercial_stage` advances via `/qualify` or tool proposal | A human/agent judged the lead qualified | Nothing about the specific Opportunity (Lead-scoped only) | Require `evidenceType: "qualification"` + a real evidence id before advancing `crm_opportunities.stage` to `qualified` |
| B | Documents requested → received | Nothing — no route/field exists | Nothing | Whether documents were ever requested or received | Would need a new evidence source (out of this audit's scope to invent) |
| C | Proposal sent → no reply | `proposals.status: "sent"`, `leads.commercial_stage: "proposal_sent"` | A proposal was sent | Whether the Opportunity progressed at all | Stage stays `proposal_sent`; no automatic advance without a reply-derived event |
| D | Proposal accepted | `leads.commercial_stage: "won"`, `status: "closed"` (§16) | A proposal tied to this LEAD was accepted | WHICH Opportunity, if the lead has more than one (§13) | Requires `proposals.opportunity_id` (§13/§19) before this can safely drive `crm_opportunities.stage: "won"` |
| E | Proposal declined | `leads.commercial_stage: "lost"`, `lost_reason: "proposal_declined"` | Same as D | Same as D | Same prerequisite as D |
| F | Meeting scheduled → completed | `office_meetings.status` fully governed, `completed_at` real (§15) | The meeting itself occurred | Any effect on a linked Opportunity — none propagates today | The evaluator would need to READ the meeting's own `related_id` when it equals an opportunity, not assume Office writes it automatically |
| G | Same contact, two opportunities, only one progresses | Both rows independently exist (`lead_id` shared, no unique constraint) — proven safe by schema | Nothing progresses either today (§6) | N/A until §18 exists | `transitionOpportunity` keyed by `opportunityId` naturally isolates A from B (§12) |
| H | Human takeover | `office_handoffs.status`/`lead_id`-scoped dedup (§14) | Operational ownership changed | Nothing about commercial outcome (correctly kept separate, §14) | No change needed — already correctly out of scope |

## 25. Verdict

**C — OPPORTUNITY MODEL ITSELF IS INSUFFICIENT, in the specific sense that no live transition authority exists at all** (not that the `crm_opportunities` table's own columns are wrongly typed or need new ones — they don't, §19). The task's own verdict options frame "the model" as "does Office currently have a trustworthy way to advance and prove Opportunity stage" — it does not, by total absence (§6), not by a narrow implementation gap alone. This is a **design/migration gate return**, per §18's explicit instruction: propose the smallest additive change (done, §18/§19) and **wait for authorization** rather than building it.

Note for calibration: this is closer to option B in spirit (the schema itself is nearly sufficient; only `proposals.opportunity_id` needs a genuine migration, and the transition mechanism is "narrow implementation," reusing 100% existing patterns) than a from-scratch redesign would suggest — but because zero transition authority exists today (not even a partial/buggy one), and one additive migration is genuinely required before proposal-driven transitions can be trusted, this audit returns **C** rather than softening to B, honoring the task's own "do not hedge" instruction.

## 26. Exact prerequisite implementation (for a future, separately-authorized task)

1. Migration: `alter table proposals add column if not exists opportunity_id uuid references crm_opportunities(id) on delete set null;` (nullable, additive, zero impact on existing rows).
2. Extend `FIELD_POLICY`/`STATUS_TRANSITIONS` in `office-operational-workflows.js` with an `opportunities` entry per §18's stage-graph design (mirroring `PIPELINE_STAGES`' own literal ordering, terminal at `won`/`lost`).
3. Add `opportunities` to the existing generic PATCH-by-id route (`server.js:~5157`/`5353`'s collection-matching regex), with the CAS `expected_stage` precondition (§11) as the one deliberate deviation from the existing pattern.
4. Wire proposal accept/decline (`server.js:~4576-4599`) to ALSO transition the linked `crm_opportunities` row (via `proposals.opportunity_id`, once §1 exists) alongside its existing Lead-level write — additive, does not remove the Lead-level behavior other code may still depend on.
5. No new event journal, no new Backend route, no OMA/OSA change.

## 27. Whether Wave 8 Slice 4 may begin immediately

**No.** Slice 4 (Commercial Outcome Evaluator) remains blocked on this prerequisite (§26) being implemented and authorized in Office first. This audit's own stop condition applies: prove the Opportunity authority, then stop — no Commercial Outcome Evaluator code, no OMA/OSA change, no Wave 9 work was performed.
