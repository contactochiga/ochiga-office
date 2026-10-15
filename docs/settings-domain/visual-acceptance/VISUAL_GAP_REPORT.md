# Settings S1–S2 — Visual Gap Report (after correction slice)

Baseline: implementation `4e39efbb702c9e4e5f1088073b21b19d4d9549b9`; acceptance evidence `510e19ba57a15608a6bae605699b4efc56227ae9` (this slice started from that commit, clean tree, local = remote). Fixture data only, headless Chrome, real Office server.
Evidence: `GALLERY.html` (44 labelled captures plus the reference), `results.json`, `scripts/capture-settings-visual-acceptance.js` (re-runnable), and `scripts/test-settings-domain-browser.js` (`npm run office:settings:test`, 14 scenarios).

## Disposition of the eight findings
| # | Finding | Status | What changed / evidence |
|---|---|---|---|
| G1 | Tablet tab strip wrapped and clipped | **Fixed** | Tabs are single-line (max label height 20px at 1100 and 900); edge fades plus left/right scroll buttons appear only while sections are off-screen; the active tab is scrolled into view; focus scrolls items into view; all 14 sections reachable (test clicks the last one). `tabs-scrolled-*.png`, `overview-1100.png` |
| G2 | Recent Activity showed logins and raw ids | **Fixed** | Activity is an exact allowlist of audited configuration event types (autonomy, letterhead, team add/update/remove/restore/delete, invitations, password reset issued, routing profile, outbox and inbound-visibility operations). Logins, logouts, denials and sends are excluded; titles are plain language, no record ids; the full history, including logins, remains in Audit (test asserts both). Autonomy rows say what happened (e.g. "Set to OFF (previously the default, OFF)") |
| G3 | Digital Twin read "Reachable" | **Fixed** | Same-origin bindings now read "Available in-process · Check: In-process; no network probe made" and are not counted as reachable. A genuine network probe still reads "Reachable · HTTP 200" (Backend card). No new health claim introduced |
| G4 | Denied state was a bare line | **Fixed** | Titled region (`aria-labelledby`), explanation, required permission, "ask an administrator", "Back to Settings overview" (44px); focus moves to the heading. Not-found sections use the same panel. Server still returns 403 for the underlying API (asserted) |
| G5 | Mobile back link under 24px | **Fixed** | `‹ All settings` is a ≥44×44px target with left safe-area padding and the standard focus ring |
| G6 | Tile and selected-nav refinement | **Fixed** | Status-tile icons now sit beside their labels (asserted); selected navigation uses the existing red token gradient with the bright-red 3px rule and white text; no new colours. Tile labels wrap by whole words only and never overflow their tile (asserted at 1440/1100/900/768) |
| G7 | Autonomy button presentation | **Fixed (presentation only)** | Scoped CSS makes it an outlined 44px control (full width on phones). The component, its route, persistence and authorization are untouched; the existing autonomy source-guard test still passes; OFF → ON → OFF verified end to end. The panel's banner keeps its legacy inline colours (component not modified) |
| G8 | Floating Oyi orb overlaps content | **Documented, not modified** | See below |

### G8 — documented orb overlap
The orb is the shared `.oyi-control` (`position: fixed; right: 20px; bottom: 20px; z-index: 40`), draggable and minimisable by the user. It overlaps Settings content at every captured width (measured: nav items at 390/768, cards at 900/1100/1440; see `results.json → corrections.orb_overlap`). It is app-wide, not Settings-specific, and shared Oyi components were deliberately not changed. Recommended follow-up (separate slice): reserve bottom/right clearance in the shared shell or auto-minimise over dense views.

## Objective results
| Check | Result |
|---|---|
| Horizontal overflow, 30 view×width captures | None |
| Console/page errors | 0 |
| Permission gating (14 sections × super_admin / ochiga_admin / settings.manage-only user) | Sidebar equals the permission-derived expectation for all three; every hidden section's deep link is denied; no-`settings.manage` user gets the forbidden page |
| Keyboard | Real Tab reaches sidebar items (2px solid red focus ring, `:focus-visible` true); all 14 items tabbable; denied heading receives focus |
| Touch targets at 390px (landing, Organization, Communications, Integrations) | 0 interactive controls under 44px (was: inputs 40px, form and sync buttons 29px) |
| Contrast (alpha-aware) | Title 18.8, nav label 16.9, subtitle 11.7, note 4.8, nav sub/tag 5.3 — all ≥ 4.5:1 |
| Activity | 2 genuine rows from the real audit trail; 0 logins; 0 ids |
| Integration truth | Probe-backed = Reachable with HTTP status; same-origin = in-process; credentials only = "Configured, not verified"; dead Backend = Not reachable |
| WhatsApp autonomy (real UI → real server) | OFF → ON → OFF confirmed server-side; restored OFF |
| Letterhead | Dirty-gated save persisted |
| Customer messages / non-GET Backend calls | 0 / 0 |
| Repository gates | check, lint, build, secrets, deployment: PASS |
| Office regression | 49/49 scripts PASS (plus the store-level outbox test); the Postgres and cross-repo scripts are excluded because they need external services |

## Remaining notes (not blocking)
- At 1100px the five status tiles wrap 4 + 1 (the 5-across layout starts at 1300px).
- G8 orb overlap remains by instruction.
- The autonomy banner keeps its legacy hard-coded colours because the component is intentionally untouched.
- Test-harness note: Chrome's back/forward cache kept old pages' event streams open and exhausted its connection pool during the longer suite, so the test and capture launches now pass `--disable-features=BackForwardCache`. This affects test tooling only.

S1–S2 VISUAL ACCEPTANCE READY
