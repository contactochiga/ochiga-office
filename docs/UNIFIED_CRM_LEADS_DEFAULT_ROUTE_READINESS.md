# CRM → Leads default route correction — readiness

Branch `feature/crm-leads-default-workspace`, based on production `codex/office-extraction` @ `83b717983b14de077c39a940ccae5319bd296930`. Not merged, not deployed.

## What changed (UI routing only; no database, autonomy, Backend or Meta change)
| Route | Behaviour |
|---|---|
| `#/crm/leads` | **Canonical workspace.** Opens the three-column Unified Relationship Workspace immediately. Selects the remembered lead if it is still valid (session memory), otherwise the most recently active lead; the URL is then replaced (not pushed) with `#/crm/leads/:id`. No leads → workspace with an empty state ("No leads yet", New Lead for permitted staff). |
| `#/crm/leads/:id` | Direct relationship deep link (unchanged). An unknown id shows a not-found message in the centre; the lead list stays usable; the URL is not rewritten and no other lead is silently substituted. |
| `#/crm/leads/table` | The legacy leads table (rows still open their workspace). Reachable from a small "Table view" link in the workspace header. |
| `#/crm/leads/:id/record` | Classic individual record (unchanged). |
| Contacts / Organizations / Opportunities | Unchanged (lists, and the scoped workspaces on record open). |
Navigation inside the workspace: clicking a lead navigates to `#/crm/leads/:id`; the route handler changes the selection **in place** (same page element, inbox scroll/search/filters preserved, no table, no full re-render). Back/Forward and refresh work because the URL always names the selection. CRM Overview's "View Leads"/"View all" and the sidebar/home links already pointed at `crm/leads`, so they now land in the workspace. Without `crm.read` the classic views remain.
Added with the route: the inbox keeps search, All / Awaiting reply / Mine, unread (awaiting-reply) dot, owner, qualification (coloured) and stage indicators, and now also stage and business-unit filters (server-side `stage` / `business_unit` params and `facets` on the existing read-only inbox endpoint). On phones the default route shows the lead list first; tapping a lead opens its conversation; Back returns to the list. New Lead + stays available on the workspace and table views.

## Tests
* Browser (headless Chrome, 3 consecutive passing runs): Overview "View Leads" → workspace in one navigation with the most recently active lead selected and named in the URL, three columns, no legacy table; Leads tab from another CRM section → workspace in one click and keeps a still-valid selection; owner/stage/qualification/source indicators and awaiting-reply dot; selecting another lead keeps the same DOM node (in-place); Back and Forward; refresh keeps the deep link; search narrows and clears; stage/business-unit filters populated and applied; "Table view" link and `#/crm/leads/table`; table row → workspace; `/record` classic; invalid id; Contacts/Organizations/Opportunities unchanged; empty database empty state; mobile default list-first, tap, Back, no horizontal overflow; earlier desktop/mobile/takeover/unknown-outcome/opportunity tests still pass.
* API: facets, `stage` and `business_unit` filters, recency ordering (the default selection).
* Gates and the full Office suite: see the final report in the hand-off message / `FULL` line below.
* Gates: `check` (113 files), `lint`, `build`, `security:secrets`, `deployment:validate`, `office:whatsapp-autonomy:test`, `office:relationship-workspace:test` all PASS. Full Office suite: **45/45 on the final run**. An earlier full run reported one failure (`test-wave9-authority-boundaries.js`); it passed 6/6 standalone on this branch and 6/6 on the base commit and the full suite then passed 45/45, so it is recorded as a transient failure under load, not a regression — noted rather than hidden.

## Known limitations
* "Awaiting reply" and "Mine" filter the loaded page (30 leads) rather than the whole set (pre-existing behaviour of the workspace inbox); search, stage and business-unit filters are applied server-side over everything.
* Clicking the Leads tab while a lead is open pushes one extra history entry (it resolves to the same lead); harmless.
* The legacy table's CSV export/"My records"/"Hide test" toolbar lives only on `#/crm/leads/table`.
* Authenticated production check not yet performed (needs a staff login or an owner walkthrough after deployment).

## Deployment readiness
**READY FOR CONTROLLED DEPLOYMENT.** Frontend/route change plus read-only query parameters: no migration, no Supabase change, no change to the autonomy setting or policy, manual-send ledger or Backend contracts. Deploy by fast-forwarding `codex/office-extraction` (Render auto-deploys); verify the served `office.js` hash, `/healthz`, one click CRM → Leads in a browser, and that autonomy is still OFF. Rollback: push the previous SHA `83b717983b14de077c39a940ccae5319bd296930` (never a pre-autonomy-switch build).
