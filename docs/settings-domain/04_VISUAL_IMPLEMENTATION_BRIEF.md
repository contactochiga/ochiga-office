# Settings Domain Audit, Part 4: Visual Implementation Brief (3D-style review)

Design language is taken from the live Office stylesheet (`public/office/index.html`). Do not introduce new fonts, colour families or icon sets.

## Tokens (actual)
- Surfaces: `--black #050505`, `--charcoal #12120f`, `--graphite #1c1c19`; hairlines `--line` rgba(246,243,236,.10) / `--line-strong` .18.
- Text: `--warmwhite #f6f3ec` primary, `--grey-300 #d8d5cf` secondary, `--grey-500 #8c887f` tertiary.
- Brand/status: red `#b3241b` (muted `#8a1e17`, bright `#d3372c`), amber `#c9862b`, green `#3f8f5f`, info blue `#4f7fd1`, violet `#8467d6` (Messages accent), Oyi blue `#3b82f6`.
- Radius 3px/5px; spacing 4–40px scale; nav 232px, topbar 56px; system sans, SF Mono for ids; motion 120/220ms `cubic-bezier(.22,1,.36,1)`; icons 16×16 stroke 1.4 (`NAV_ICONS`, add `settings` sub-icons in same style).

## "3D-style" interpretation (within the existing language)
Depth comes from layered surfaces, not gradients or skeuomorphism:
- Level 0 page `--black`; Level 1 section panel `--charcoal` with 1px `--line`; Level 2 provider card `--graphite` with `--line-strong`; Level 3 dialog/popover on `--graphite` with a soft 0 12px 32px rgba(0,0,0,.55) shadow and a 1px top highlight `rgba(246,243,236,.08)`.
- Hover: raise one level (border to `--line-strong`, translateY(-1px), 120ms). Active: pressed back to level. Focus: 2px `--red-bright` ring, 2px offset.
- Status "lamps": 8px dot with 0 0 0 3px halo at 18% of the status colour (green connected, amber degraded, red unreachable, grey not configured, blue pending approval, violet unqualified).
- Reduced motion: no translate, no halo animation.

## Screens to review

1. **Settings hub (desktop 1440).** Left 232px app nav; second 220px sub-nav listing the 14 sections with 16px icons; content column ≤880px. Overview shows a 3-column grid of status tiles (Integrations, Communications, Security, Intelligence, Infrastructure, Audit) each with lamp, one-line state, link; below, "Needs attention" list (dead-letter count, unreachable integration) and "Recent setting changes" (5 rows).
2. **Integrations.** Grid of provider cards (min 280px): logo-free monogram tile, name, owner chip (Office / Backend / Facility), lamp + state text, last checked time, [Test connection] ghost button, [Details] link. Secret row shows `● configured · updated 12 Oct`. No reveal control.
3. **Communications → WhatsApp.** Existing autonomy panel moved intact: switch, "Autonomous replies: OFF (stored)" line, confirm dialog on enabling that states the consequence. Beside it: signature mode "Enforce" lock chip (read-only), outbox tiles (Pending / Delivered / Dead), [Reconcile (dry run)] button.
4. **Intelligence → AI providers.** Three equal cards: OpenAI, Google Gemini, Anthropic Claude. Each: state chip ("Not qualified"/"Pending approval"), "Model: not selected", "Authorized spend: USD 0", "Data-processing review: pending", disabled "Activate" replaced by explanatory text "Activation requires a separate qualification approval." OpenAI additionally notes "Legacy env-configured path".
5. **Organization → Letterhead.** Existing form plus live preview card (level 2) showing the letter header as it will render; inline validation (email/URL); sticky Save/Discard bar at the bottom of the panel.
6. **Confirm dialog.** Level 3, 480px max, title, impact paragraph, what will not change, [Cancel] ghost + [Confirm] primary red; typing the setting name required for autonomy ON and session-policy changes.
7. **Error / denied / empty.** Reuse existing `errorPanel`, add "No access to this section" panel with the permission key shown in mono.
8. **Mobile (390).** Section list as full-width rows with chevrons; section view pushed with back button; cards single-column; Save bar sticky above safe area; dialogs become bottom sheets (pattern: `oyi-camera-sheet`).
9. **Tablet (900).** Sub-nav becomes horizontally scrollable tab strip; cards 2-up.
10. **Audit tab.** Filter bar (actor, action prefix, date range), table reusing `renderDataTable`, row opens a right drawer with old/new values and request id.

## States matrix to render for each card/form
default · hover · focus · loading · saving · saved · validation error · server error · stale-version conflict · permission-denied · read-only mirror · not configured · degraded.

## Content rules
Plain operational language; never "AI-powered"; unavailable means "Unavailable", never an invented number; secrets never shown; every irreversible or customer-affecting toggle states its consequence.

## Review package for the 3D pass
Provide: Figma frames (or HTML mock under `docs/settings-domain/mock/`) for screens 1–10 at 1440/900/390; component sheet of `statusIndicator`, `providerCard`, `secretField`, `confirmDialog`; dark-only (no `prefers-color-scheme` or `data-theme` rules exist in `public/office/index.html`).
