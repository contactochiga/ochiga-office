# Settings S1–S2 implementation notes

Branch `feature/settings-s1-s2` (not merged, not deployed). Code: `public/office/office.js` (Settings block, `st*` functions), styles in `public/office/index.html` (`.st-*`), test `scripts/test-settings-domain-browser.js` (`npm run office:settings:test`).

## Delivered
- Dedicated Settings shell: header, sidebar with search, content column (inside the existing app navigation), at `#/settings` and `#/settings/<section>`.
- All 14 approved domains, each gated by its own permission; hidden when not permitted; deep link shows a denied state naming the permission.
- Overview: five status tiles, quick actions, recent activity, related areas, all derived from live data.
- Reusable components: shell/sidebar, card, facts, provider card, status indicator, secret indicator (presence only), unavailable panel, permission gate, error-with-retry, confirm dialog (focus trap, Esc), form (dirty tracking, inline validation, server-confirmed save).
- Responsive: ≥1100 two columns, 860–1100 tab strip, <860 list landing with pushed section view and back link, 44px targets.

## Truthfulness rules enforced
- "Reachable"/"Not reachable" only from a real health probe; "Configured, not verified" for credentials only; never "Operational".
- Recent Activity is the real audit trail; no placeholders. Reference-image items with no verified source (12 connected, v1.0.0, documentation/support links, Billing, Branding, Notifications, Data & Sync domains) are intentionally not reproduced. The 14 approved domains are used instead of the image's labels.
- Unavailable sections (Automation, CRM, Finance) have no controls. AI provider cards (OpenAI, Gemini, Claude) are status-only, unqualified, USD 0 authorized.

## Contracts unchanged
WhatsApp autonomy (`GET/PUT /admin/settings/whatsapp-autonomy`, existing panel function), Letterhead (`GET/PATCH /admin/letterhead-config`, same payload), `/admin/integrations`, `/admin/office/sync`. No server or Backend change.

## Regression note
`test-whatsapp-autonomy-store-ui.js` asserted that the autonomy panel is called before the old Sync block in `renderSettingsView`. That placement assertion was updated to the new location (Communications, gated `integrations.read`); every behavioural assertion is unchanged.

## Known limits
Sidebar search covers domain names and keywords only. Letterhead URL fields are not validated beyond email format. Mobile landing hides the overview content (list first, by design).
