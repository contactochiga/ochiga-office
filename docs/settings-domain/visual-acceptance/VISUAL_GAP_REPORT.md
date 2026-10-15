# Settings S1–S2 — Visual Gap Report

Commit under test: `4e39efbb702c9e4e5f1088073b21b19d4d9549b9` (`feature/settings-s1-s2`). Real Office server, fixture data only, headless Chrome. No runtime code was modified in this review.
Evidence: `GALLERY.html` (40 labelled screenshots + the reference), `results.json` (objective checks), `scripts/capture-settings-visual-acceptance.js` (reproducible, `node scripts/capture-settings-visual-acceptance.js`).

Captured: Overview, Intelligence, Integrations, Communications, Organization, Security at 1440 / 1100 / 900 / 768 / 390px; list landing at 900/768/390; permission-denied states (denied deep link at 1440/390, no-access page at 1440/390); limited-user overview; keyboard focus.

## Objective results
| Check | Result |
|---|---|
| Horizontal overflow, 30 view×width captures | None |
| Console/page errors | 0 |
| Permission gating, 14 sections × super_admin / ochiga_admin / limited (settings.manage only) | Sidebar equals permission-derived expectation for all three; every hidden section's deep link shows a denied state (people, intelligence, finance, audit for the limited user) |
| No `settings.manage` | Existing forbidden view, no Settings UI at 1440 and 390 |
| WhatsApp autonomy (real UI → real server) | OFF → ON → OFF confirmed server-side each step; restored to OFF |
| Letterhead (real UI → real server) | Dirty-gated save persisted (`Acceptance tagline`) |
| Customer messages sent / non-GET Backend calls during review | 0 / 0 |
| Landmarks | `nav[aria-label]`, `main`, one h1, one h2 per section, `aria-current="page"` on the active item |
| Labels / names / alt | 0 unlabeled inputs, 0 unnamed buttons, 0 images without alt |
| Keyboard | Real Tab key reaches sidebar items; focus ring 2px solid `rgb(211,55,44)`, `:focus-visible` true; all 14 items tabbable |
| Contrast (alpha-aware) | Title 18.8, nav label 16.9, card subtitle 11.7, field label 11.7, note 4.8, nav sub/tag 5.3 — all ≥ 4.5:1 |
| Reduced-motion rule | Present for tiles and actions |
| Fabricated data | None found: every tile/state/activity row traces to a probe, `/healthz` or the audit trail |

## Comparison with the reference (desktop Overview)
Matches: Settings header with icon tile; dedicated sidebar with search, icon + title + subtitle per item, red-highlighted active item with left rule; "Settings Overview" title; System Status card with five tiles; Quick Actions as four chevron cards; Recent Activity beside a secondary card; spacing rhythm, dark layered surfaces, existing Ochiga typography.

Intentional deviations (truthfulness, not defects): no "Operational" labels (states are Reachable / Configured, not verified / Not reachable); no "12 connected", `v1.0.0`, documentation or support links; "Related Areas" replaces Helpful Resources/Need Help; 14 approved domains instead of the image's labels (Data & Sync, Billing, Branding, Notifications have no contract); the topbar search, ⌘K and workspace chip belong to the app shell, not Settings.

## Gaps
| # | Severity | Gap | Evidence | Suggested correction |
|---|---|---|---|---|
| G1 | Medium | Tablet tab strip (860–1100px): labels wrap ("People & Access" onto three lines), strip is taller than needed, last tabs are clipped with no scroll cue | `overview-1100.png`, `overview-900.png` | `white-space: nowrap` on tab labels; scroll-fade/edge affordance |
| G2 | Medium | Recent Activity lists `User.Login` rows with raw record UUIDs; these are authentication events, not configuration changes. Real but misleading under "configuration changes"; the filter pattern matches `user` | `overview-1440.png` | Narrow the filter to settings/integration/role/permission/outbox/letterhead actions and exclude logins; show a short target instead of a UUID |
| G3 | Medium | Digital Twin card shows "Reachable · Health probe: active". For the same-origin twin this is an in-process check, not a network probe, so "Reachable" overstates what was verified | `integrations-1440.png`, `integrations-390.png` | Derive a distinct state (e.g. "Same-origin, in-process") and drop "Reachable" for same-origin entries |
| G4 | Low | Denied deep link is a plain dashed line with no heading, icon or route back | `denied-section-1440.png`, `denied-section-390.png` | Use a titled denied panel with a link to Overview |
| G5 | Low | Mobile "‹ All settings" link is under 24px tall (WCAG 2.2 target size) | `results.json` → `targets_under_24px` | Give it ≥44px height like the nav items |
| G6 | Low | Status tiles stack icon above text; reference places icon left of text. Active nav highlight is subtler than the reference's solid red. Activity rows use one generic icon where the reference uses per-source icons | `overview-1440.png` vs `00-reference.png` | Optional polish; per-source icons only where the source is real |
| G7 | Low | The preserved autonomy panel's "Turn ON" button is a pale full-width block on mobile and its banner uses legacy inline colours, unlike the rest of Settings. Behaviour is unchanged by design | `communications-768.png` | Style-only alignment, no contract change |
| G8 | Info | The app-wide floating Oyi orb overlaps the right edge of content at several widths (pre-existing, outside Settings) | `intelligence-1440.png`, `overview-900.png` | Track separately |

## Verdict
No fabricated activity, provider connections or health statuses were found, permission gating is correct, and the autonomy and letterhead controls work. G1–G3 are real defects (layout break at tablet, misleading activity feed, an overstated health state) and should be corrected before acceptance.

S1–S2 VISUAL CORRECTIONS REQUIRED
