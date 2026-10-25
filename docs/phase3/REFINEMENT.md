# Phase 3 final refinement — release review

Canonical local evidence and screenshots: `/Users/ochigaidoko/getoyi-commerce/phase3/refinement/`. Relative artifact paths below resolve there.

Date: 25 October 2026. Supersedes the defect/dependency disposition in `../review/RELEASE-READINESS.md`; retains its accepted evidence and photography provenance. Accepted GetOyi 8c93545 and Office 6519110 remain ancestors. All work is local. No production migration, push, deployment, permission change, public activation, live enquiry, checkout or Paystack change.

## Verdict

**GO for local implementation/release review. NO-GO for production release or public catalogue activation.** The identified quotation-context, scheduling and withdrawal-audit defects are corrected and tested. Mandatory independent staff approval/release/withdrawal, deployment-specific security/refresh gates and visual/content sign-off remain outstanding. Phase 2 private infrastructure acceptance remains intact.

## Exact visual comparison

Reference: `/Users/ochigaidoko/Downloads/getoyi_smart_home_hardware_store.png` (1672 × 941). Screenshots are synthetic, labelled demonstration content, using owner-approved Downloads photography. No fictional inventory/prices were inserted in production. Same-product photography must be verified for real content; the demonstration gallery intentionally combines source models and is not a real SKU claim.

| Element | Approved reference | Refined local result |
|---|---|---|
| Desktop hero | approximately 400px tall, below 71px header | 400px tall, below existing 73px header |
| Heading position | approximately x217/y178 | x217.36/y177.96 at 1672px |
| Category left edge | approximately x70 | x70.22 |
| Category cards | caption/description over dark lower overlay | supporting captions and refined dark overlays; 170px cards |
| Featured section | heading around y822; tabs with underline | heading approximately y819; Featured/New Arrivals keyboard tabs and blue underline |
| Story controls | centred group, small leading play/pause, edge arrows | group centre x836 at 1672px; leading 32px dynamic control, edge arrows retained |
| Tablet/mobile | responsive adaptation required | 820×1180 and 390×844 captures; no horizontal document overflow observed |

Remaining visual differences: original dark GetOyi navigation is deliberately preserved rather than replacing it with the mockup navigation. Supplied close-up hero tile is composed on the right with a wider desktop layout, but is not the mockup's wide room photograph; a suitable approved wide campaign image is still required for exact photographic fidelity. Three progress segments reflect three test campaigns rather than the mockup's five. Product cards use actual demonstration images rather than invented cut-outs. Synthetic copy differs deliberately. Best Sellers is omitted because no verified sales ranking exists. Service text avoids unsupported insured-delivery/partner claims. Mobile/tablet are responsive adaptations; no separate approved mobile mockup was supplied.

Screens: `screens/desktop.png`, `desktop-full.png`, `tablet.png`, `tablet-full.png`, `mobile.png`, `mobile-full.png`, and `quotation-context.png`. `comparison.html` pairs the locked reference with updated views.

## Changes and commercial correctness

- GetOyi hardware CSS: hero height/composition/spacing, category overlays/captions, content width and featured tabs. HardwareCatalogue uses the new accessible FeaturedProducts component and real Office-selected refs.
- StoryCarousel retains Ochiga HomeHeroCarousel/StoryCarousel elapsed-time progression, swipe, visibility and reduced-motion mechanics. Adds hover pause/resume, focus pause until explicit Play, and restrained live-region announcements. Ochiga website unchanged.
- ProductShowcase preserves gallery selection and adds native thumbnail-button semantics, keyboard option navigation and selected-SKU enquiry actions. ProductDetail supplies the canonical slug.
- Shared hardwareEnquiry validation passes product/SKU through the contact form. `/api/leads` verifies submitted context against a fresh Office published projection, rejects malformed/foreign SKU, appends canonical name/variant/availability to the customer's original message and retains customer/company context. No client-supplied price or stock is trusted.
- Office strict scheduling rejects invalid calendar dates, absent timezone, out-of-range clock/offset values and accepts valid leap dates with explicit offsets.
- Office withdrawal events/audit now identify withdrawn published version separately from current draft and previous published version; the history UI shows both. The unshipped draft merchandising migration was updated accordingly; production history is not rewritten.
- Existing campaign permissions, independent author/reviewer checks, publish-time eligibility, immutable history and optimistic version checks remain in place. Create/save, review, publish and withdrawal continue through existing authorized/audited endpoints. Scheduled content is projected only within its valid interval and while referenced products/images remain eligible.
- Routine merchandising remains data-driven; previous no-rebuild update/withdrawal evidence is retained. Fresh requests recalculate schedules. Already-open tabs have no withdrawal subscription; the existing product cache can retain data for up to five minutes if refresh fails. This is an explicit activation-gate timing decision, not a claim of instant removal.

## Tests and evidence

| Test | Result |
|---|---|
| Office merchandising validation/authenticated HTTP | PASS: 49 checks (`evidence/merchandising.log`) |
| Disposable PostgreSQL/PostgREST security and workflow suite | PASS: 153 checks, 0 failed (`evidence/postgres.log`); includes independent review, immutable records, withdrawal version metadata and migration rollback/reapply only in disposable DB |
| Carousel DOM interactions | PASS: 19 checks (`evidence/carousel.log`), including exact remaining-time resume, swipe, visibility, reduced motion, hover/focus pause |
| Office campaign editor DOM harness | PASS: 6 checks (`evidence/merchandising-ui.log`) |
| Quotation HTTP → actual Office CRM-writing functions | PASS: 16 assertions; invalid/foreign SKU rejection, canonical selected variant and customer/company context, contact/opportunity/activity/timeline, retry suppression. Temporary file-backed store only; evidence in `crm-results.jsonl` and `intake-capture.jsonl` |
| Existing Office CRM intake suite | PASS: scenarios A–F (`evidence/office-crm.log`) |
| Browser | PASS: desktop/tablet/mobile rendering; featured keyboard tabs; native gallery buttons; option ArrowRight selects unavailable SKU; CTA and contact prefill preserve SKU; no errors in final tab log |
| GetOyi lint, TypeScript and production build | PASS after dependency and application changes |
| Office lint/build | PASS |
| Flag-OFF local route regression | PASS: Home, Facility, Experience, Core, Technology, Deployments, Hardware, Contact return 200; product detail/media return 404; Hardware contains no TEST data; shared image optimizer returns 200 |
| Existing category/search/filter/pagination/sort/merchandising refresh | Retained prior accepted browser evidence; no unnecessary repetition |
| Live email/proxy/production timing | Not repeated. Prior Phase 2 acceptance retained. Local email credentials absent and no external messages sent |

An initial editor-harness invocation omitted its required Office directory and stopped with an argument assertion; rerun with the correct path passed all six checks. This was a test invocation error, not a product failure.

## Dependency and accessibility disposition

GetOyi updated Next and matching eslint-config-next to 16.4.1, sharp resolved to 0.35.5, PostCSS override to 8.5.31, and compatible vulnerable transitive dependencies refreshed. Fresh GetOyi and Office audits both report **0 advisories** (`evidence/dependency-audit.json`, `office-dependency-audit.json`). The prior 13 affected entries are closed by version remediation, not waived. Audit absence is not a guarantee of vulnerability absence. Framework update remains a shared-runtime change and requires deployment smoke testing despite local route/image/CRM regression passes.

Gallery button semantics, keyboard option/tab navigation and carousel focus/hover behaviour are corrected. Reduced-motion tests pass. Full assistive-technology and physical-device certification was not performed; do not claim full WCAG conformance. Existing global navigation/assistant are outside this refinement scope.

## Outstanding release blockers and safe next actions

1. Owner review of updated screenshots, including acceptance/replacement of the close-up hero photograph and explicitly documented visual differences. Supply approved real campaign/product imagery and content; never publish synthetic fixtures.
2. Separate review of the draft campaign migration and updated production security-gate baseline for new tables/functions/privileges. No migration has been authorized or run in production.
3. Separately authorized independent staff product **and campaign** creation/review/approval/release/withdrawal tests, verifying actual permission boundaries and audit records. No grants or bypasses.
4. Validate deployed refresh, schedule boundaries, withdrawal/cache timing and fail-closed public routes, including the disposition of already-open pages. Keep HARDWARE_CATALOGUE_ENABLED OFF until all activation gates are signed off.
5. Review framework upgrade rollout/rollback and perform authorized deployment smoke tests. No live CRM submission is required merely to repeat accepted evidence; any additional live enquiry needs explicit authorization.

No production release or activation is implied by local test success.
