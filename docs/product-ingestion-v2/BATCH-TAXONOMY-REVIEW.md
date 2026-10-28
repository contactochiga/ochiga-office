# V2 batch taxonomy and brand resolution — local acceptance

Date: 28 October 2026. Implementation: `4cca21f` on `codex/intelligent-catalogue-ingestion-v2`, based on `59582a9`. Local worktree: `/Users/ochigaidoko/getoyi-work/office-ingestion-v2`.

## Registry audit and cause

A `BEGIN READ ONLY` query against the Office database (`metbajilbqclwjfsxfps`) returned six active canonical categories and **zero brands**. The isolated local seed has the same six category names/slugs, with different local IDs:

- Smart Home & Automation
- Security & Access Control
- Networking & Connectivity
- Sensors & Monitoring
- Control Panels & Gateways
- Installation Accessories

V2 previously had no persisted staff mapping decisions and treated any nonempty, unmatched manufacturer as a blocking taxonomy exception. Thus an empty brand registry kept all 50 products in review even where categories already matched. The worksheet reconciliation was correct.

The unchanged research workbook SHA-256 remains `09078b97783964fc184b2090807fcd9fdf7031de79f058511342ff62e0d5ede1`.

## Actual mapping counts

| Measure | Result |
|---|---:|
| Unique products | 50 |
| Distinct category paths | 25 |
| Automatically matched category paths | 18 |
| Products covered by those paths | 32 |
| Category groups requiring confirmation | 7 |
| Products covered by unresolved category groups | 18 |
| Manufacturer source labels | 21 |
| Unconfirmed OEM group | 1 group / 12 products |
| Other manufacturer labels | 20 labels / 38 products |
| Canonical manufacturer identities represented by those labels | 19 (TP-Link and TP-Link Omada share TP-Link) |
| Initial unresolved groups with the actual empty brand registry | 28 |

These are source/registry facts, not newly approved production taxonomy.

The seven category exceptions are Smart Switches & Lighting (5), Smart Plugs & Relays (2), Smart Locks & Access (1), Hubs & IR Controllers (1), Home Security Cameras (1), Automation & Controls under Building Infrastructure (4), and Electrical & Power Control (4). The industrial automation path no longer inherits the residential automation alias. Specific leaf terms inform suggestions; staff confirm ambiguous assignments.

## Small compatible extension

- Full normalized canonical category hierarchy matching and explained suggestions.
- Batch review of recurring source values, including source collection/category-path context. Generic source labels in different collections have separate decisions.
- One explicit confirmation can save up to 100 reviewed mappings; the UI shows at most 50 unresolved and 50 resolved groups at a time. Existing candidate pages remain bounded to 25.
- Reviewed aliases use the existing durable `audit_events` append mechanism. Decisions are scoped to the authenticated staff account, not silently made organization-wide aliases. Future uploads by that account reuse them. This correction adds no table, database migration, general AI runtime or product store.
- Revision checks reject stale/replayed batches. Concurrent conflicting decisions retain both audit heads and remain unresolved until a new explicit decision supersedes them. Inactive/missing canonical targets fail closed. Failed history reads do not fall back to guessed mappings.
- Unknown OEMs and compatibility statements cannot acquire a brand via batch mappings or edited V2 job payloads. Staff may explicitly keep a manufacturer unassigned with an explanation; the source name remains preserved.
- Category assignment remains required. Once unmatched manufacturers are explicitly reviewed, missing images, unapproved pricing/costs and supplier information remain nonblocking draft warnings. Specification, identity and required-field conflicts still block readiness.
- The existing Categories & brands UI/API handles new taxonomy. Its existing `catalogue.publish` requirement is unchanged; importer permission does not confer taxonomy creation or publication permission. No permissions were added to the owner-testing account.
- Mapping changes clear draft selections and unsaved per-product edits, with an explanation in the panel. Immutable source files, cell provenance and reviewed job manifests are retained. New job manifests snapshot the category/brand matching evidence.

Files: `ingestion-taxonomy.js` and `.mjs` implement the mapping decision layer and batch panel; `catalogue-ingestion.js`, `catalogue-import.js`, `catalogue-store.js`, `ingestion-evidence.js` and `ingestion.mjs` connect it to existing workflows; `server.js` adds only the new GET-only catalogue static module route; `test-ingestion-taxonomy.js` and `package.json` register regression coverage.

## Rehearsal evidence

All write tests used disposable local stores with synthetic staff identities. No production writes, migrations, grants, pushes or deployments occurred.

1. Original workbook uploaded through the actual authenticated HTTP route and browser file chooser.
2. With the actual six-category/empty-brand baseline, a reviewed batch of seven category mappings plus 21 explicit manufacturer-unassignment decisions yielded **50 ready, zero taxonomy exceptions**, with all 50 commercial verification warnings retained. This is a permitted draft-only disposition, not manufacturer approval.
3. Browser validation rejected submission without explicit mapping confirmation. Two group decisions made seven products ready (five switches and two already-category-matched sensors sharing the 12-product OEM group). Resolving the remaining groups reached 50 ready without opening individual product editors.
4. A separate disposable API exercise used a synthetic authorized publisher to establish 19 canonical manufacturer records through the existing audited brand API. The existing importer was denied that operation. Explicitly mapping 20 manufacturer labels yielded 38 assigned brands and 12 unassigned OEM products. Existing unassignment decisions were not silently overridden by the new registry records. Fresh imports without those prior decisions matched canonical names and the TP-Link alias normally.
5. Both approaches preserved **149 structured attributes, 250 image requirements, 50 QA records, zero unmatched supporting rows, zero conflicts**, and identical source-cell/supporting evidence.
6. New mapping tests and browser exercises created **zero products and zero product versions**. Separate pre-existing persistence regression suites create only synthetic disposable drafts.
7. Existing owner environment still contains only its two prior synthetic drafts (`synthetic-v2-browser-one`, `synthetic-v2-browser-two`), both never published. Its mapping history remains empty for owner review. The disposable browser service on 4389 was stopped; the owner service on 4388 remains running.

Screenshot: `outputs/ingestion-v2/batch-taxonomy-ready.jpg` shows the disposable rehearsal at 50 ready / zero taxonomy exceptions. It is evidence, not the owner's unsaved review state.

## Validation

- New authenticated taxonomy suite: **24 assertion groups**, including source owner/session/scope checks, reviewed-only mappings, missing/inactive targets, stale replay, service restart, canonical brand creation permissions, unknown-OEM denial, context separation and real concurrent HTTP conflict resolution.
- Existing V2 suites: **68 groups** (21 ingestion HTTP, 16 disposable PostgreSQL, 10 edge, 21 multi-sheet).
- V1 import: **33 groups**.
- Actual residential/commercial preview HTTP: **25 groups**, 12/12 and 15/15, no catalogue changes.
- Catalogue API: **104 groups**, including governance, permissions, manual creation and storage persistence.
- Total targeted groups: **254**, plus `validate:release` (Office/CRM/Documents/storage/permissions/build-related regressions), which passed.
- Syntax checks and `git diff --check` passed. The 1,000-row regression remains part of the V2 suite; local measurements are not a Render capacity guarantee. The PostgreSQL suite uses PGlite; genuine multi-connection production-equivalent SQL contention remains a separate release gate.

## Owner walkthrough and verdict

**GO for local owner browser acceptance.** Open `http://127.0.0.1:4388/office/#/catalogue/ingestion`. The isolated test account is already signed in and the existing 50-product checkpoint is reopened. Refresh if needed; its local login instructions remain in `outputs/product-import-local/login.json` (do not use production credentials).

1. Inspect the 25 category paths / 21 manufacturer labels in Batch category & manufacturer review.
2. Choose a canonical category once per unresolved group. For unconfirmed OEM, choose Keep unassigned and enter a reason. Known manufacturers can be explicitly left unassigned for draft work or established by an already-authorized taxonomy manager via Categories & brands.
3. Confirm the mappings, then Apply selected batch mappings. Ready counts update; reviewed decisions persist for this account. No product creation occurs here.
4. Review Ready for drafts and the still-visible commercial warnings. Draft creation remains a separate owner selection and confirmation. Do not import all 50 merely to test mappings.

Production release remains **NO-GO** pending separate owner acceptance and V2 release/migration/security/load review. Account-local mappings are intentional; a centrally governed shared alias registry is not introduced. The actual brand registry still needs authorized curation if drafts should receive canonical brands instead of reviewed unassigned identities. Broad categories remain broad; more specific categories require the existing governed API and staff judgment.

Rollback: reverting implementation `4cca21f` removes the batch extension; existing source files, audit decisions, drafts and receipts remain intact. No schema rollback is needed for this correction. The previously proposed V2 receipt migration is unchanged and was not applied to production. Pricing approvals, inventory, publication, Hardware activation, Paystack, wallets, checkout and Claude's worktrees are untouched.
