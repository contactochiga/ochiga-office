-- Wave 8 Slice 4 prerequisite (Office Opportunity Outcome Authority).
-- proposals is currently lead_id-scoped only -- under the multi-opportunity
-- model (Wave 7 Slice 7) one lead can have several simultaneous
-- Opportunities, so a proposal's own accept/decline cannot today say
-- WHICH Opportunity it concerns. This is the one migration the
-- prerequisite audit (docs/WAVE8_SLICE4_OFFICE_OPPORTUNITY_OUTCOME_PREREQUISITE.md
-- section 13/19) found genuinely necessary -- crm_opportunities itself
-- needs no schema change, only this.
--
-- Nullable, additive, backward-compatible: every existing proposal row
-- gets NULL (no speculative backfill/guessed assignment -- a historical
-- proposal without provable Opportunity identity honestly stays
-- unlinked). lead_id is untouched.
alter table proposals add column if not exists opportunity_id uuid references crm_opportunities(id) on delete set null;
create index if not exists proposals_opportunity_id_idx on proposals (opportunity_id);
