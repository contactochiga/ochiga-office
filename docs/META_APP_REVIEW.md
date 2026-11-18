# Meta Integration and App Review Evidence

This document describes the existing Oyi Office integration and the administrator-facing Facebook Page connection added locally on `codex/office-meta-page-connection`. It does not imply that the local change is deployed, that Advanced Access has been granted, or that a permission is currently available to non-role users.

## Existing implementation inventory

| Area | Current state | Existing code |
|---|---|---|
| Facebook/Instagram inbound DMs | Live integration path; signature validation, configured asset binding, idempotency and CRM persistence are already implemented. | `src/lead-agents/meta-social-inbound.js`; `/webhooks/meta-social` in `src/lead-agents/server.js` |
| Messenger / Instagram manual replies | Shared channel-aware adapter and send ledger; existing pilot allowlists, takeover and send policy remain authoritative. | `src/lead-agents/meta-social-replies.js`; CRM routes in `src/lead-agents/server.js`; `src/lead-agents/manual-whatsapp-send.js` |
| Social AI and handback | Shared Oyi Core continuation exists; channel controls remain independent and production flags are not changed here. | `src/lead-agents/meta-social-autonomy.js`, `src/lead-agents/meta-social-replies.js` |
| Facebook OAuth and Page discovery | Previously missing. The new local flow uses the existing Meta app, server-side OAuth, `/me/permissions`, and `/me/accounts`. | `src/lead-agents/meta-page-connection.js`; `/api/lead-agents/admin/meta/*` in `src/lead-agents/server.js` |
| Page selection and token protection | Previously missing. New Page tokens are encrypted with AES-256-GCM and saved in the existing `office_runtime_settings` store. Tokens are never returned to the browser. | `src/lead-agents/meta-page-connection.js`; existing `getRuntimeSetting` / `setRuntimeSetting` in `src/lead-agents/store-supabase.js` and `store-file.js` |
| Page webhook status / repair | Previously not exposed. New code reads app-level and Page-level subscriptions; an explicit Page repair is allowed only when the callback and `messages` app subscription already match. App-level callback configuration is never changed by this feature. | `src/lead-agents/meta-page-connection.js`; `src/lead-agents/meta-social-inbound.js` |
| Instagram Page link | Existing integration uses the Facebook Login/Page-token model. The new connection screen reports the linked professional account only when the selected Page’s `instagram_business_account` matches the configured Instagram asset. | `src/lead-agents/meta-page-connection.js`; `src/lead-agents/config.js` |
| WhatsApp | Existing Cloud API adapter, inbound webhook, CRM history, takeover, AI switch, and send behavior are unchanged. This screen reports messaging configuration, not WABA management capability. | `src/lead-agents/whatsapp.js`, `src/lead-agents/whatsapp-autonomy.js`, WhatsApp webhook route in `src/lead-agents/server.js` |
| Content publishing and comments | Existing separate Content integrations; not the CRM messaging connection and not modified by this work. | `src/lead-agents/meta-social-posts.js`, `src/lead-agents/meta-social-moderation.js` |

## New Page connection contract

All connection and management routes require an authenticated Office session and `integrations.manage`; read-only state requires `integrations.read`. API keys cannot perform OAuth or mutate Page connections.

1. `POST /api/lead-agents/admin/meta/connect` creates a 10-minute, HMAC-signed state bound to the current user, sets an HttpOnly/SameSite=Lax callback cookie, and returns a Meta authorization URL.
2. `GET /api/lead-agents/admin/meta/oauth/callback` validates state, actor and expiry; exchanges the code server-side; checks granted permissions; and calls `GET /me/accounts?fields=id,name,access_token,tasks,instagram_business_account{id,username}`. No code or token is returned to the browser.
3. `GET /api/lead-agents/admin/meta/pages` returns only safe Page metadata for the current administrator. Page tokens in pending candidates are encrypted.
4. `POST /api/lead-agents/admin/meta/pages/select` accepts a Page ID only if it is in that administrator’s pending authorized list. It requires `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, a Page `MESSAGING` task, and a Page task allowed to manage subscription (`MANAGE`, `CREATE_CONTENT`, or `MODERATE`). If the configured Instagram asset matches the Page link, the Instagram messaging scopes must also be present. A Page different from the currently configured Page is refused rather than silently replacing the active asset.
5. The selected Page token is stored only as authenticated AES-256-GCM ciphertext in the existing runtime-settings row. On startup it is decrypted in memory only when the active Page ID matches. Missing/invalid encryption configuration never falls back to returning credentials or selecting another Page.
6. `GET /api/lead-agents/admin/meta/webhooks` performs explicit read-only Graph checks. `POST /api/lead-agents/admin/meta/webhooks/repair` requires administrator confirmation and only repairs the Page-level subscription after the existing app-level callback URL and `messages` field are verified. It subscribes only to fields already configured at app level.

No new database table or migration is required. Existing `office_runtime_settings` storage is reused.

### New environment requirements (not configured by this change)

- `META_OAUTH_REDIRECT_URI`: exact HTTPS URL ending `/api/lead-agents/admin/meta/oauth/callback`, registered in the existing Meta app.
- `OFFICE_META_TOKEN_ENCRYPTION_KEY`: independently managed 32-byte base64 key. Keep only in the Office server secret store. Back up/rotate using a planned ciphertext re-encryption procedure; changing it without re-encryption makes the saved OAuth connection unreadable.
- `META_SOCIAL_WEBHOOK_CALLBACK_URL`: exact existing callback URL used to compare app-level Webhooks configuration before allowing Page subscription repair.
- Existing `META_APP_ID`, `META_APP_SECRET`, and supported `META_SOCIAL_GRAPH_VERSION` remain server-only. This change does not create, rotate, or modify them.

The existing environment Page token remains untouched until an administrator explicitly selects the same configured Page in Office. Production activation/deployment and OAuth consent are separate approvals.

## Permission-to-functionality and App Review matrix

Meta may restrict unreviewed permissions to people with a role on the app or relevant business. Current app-role testing is not evidence of Advanced Access for customers generally. Meta says unapproved permissions are role-limited and App Review is not required only when an app is used exclusively by people with app roles; reviewers must be able to access and test each requested permission. See [Meta App Review introduction](https://developers.facebook.com/docs/resp-plat-initiatives/app-review/introduction).

| Permission | Actual Office use / API | Genuine need and truthful demonstration | Status / gap |
|---|---|---|---|
| `pages_show_list` | New OAuth workflow: `GET /me/accounts` with Page identity, tasks and linked Instagram metadata. | Needed to show the administrator Pages they manage and select the intended Page. Screencast: connect, consent, show the returned Page list and select the intended Page. | Implemented locally; requires Meta app configuration, OAuth redirect registration, role-user verification, then Advanced Access for non-role administrators. The `/{user-id}/accounts` reference documents `pages_show_list` and `pages_manage_metadata`. |
| `pages_manage_metadata` | New status/repair path: `GET` and guarded `POST /{page-id}/subscribed_apps`; existing webhook handler remains `/webhooks/meta-social`. | Needed for Page-level app subscription management. Screencast should show current Page subscription fields, then repair only if app-level callback and fields are already correct. | Implemented locally; requires OAuth grant, Page task and app-level Page Webhooks configuration. Page-level subscription is separate from the app-level callback. Meta explicitly says both app-level and Page-level fields must overlap; Instagram webhooks are configured in the app dashboard, not through this Page edge. |
| `pages_messaging` | Existing Facebook manual reply: `POST /{page-id}/messages`; inbound through Page Webhooks `messages`. | Needed for staff Messenger conversations/replies. Screencast: receive a real test message, open the CRM thread, take over, send a staff-authored reply, verify receipt/status. | Existing production pilot; preserve restricted recipients/operators. App Review/Advanced Access is still required for users outside eligible app roles. |
| `instagram_basic` | Existing Facebook Login/Page-token integration reads the linked professional account metadata (`instagram_business_account`) and identifies the connected account. | Needed for the existing Page-linked Instagram messaging integration. | Existing inbound integration; OAuth connection now reports verified link metadata. The connected account must be professional and linked to the selected Page. |
| `instagram_manage_messages` | Existing Instagram Direct CRM messaging and Page-token send path: `POST /{page-id}/messages` with Instagram-scoped recipient; inbound on the Instagram messaging webhook subscription. | Needed to access/respond to Instagram conversations. Screencast: real inbound DM then authorized staff reply in a role-eligible test context; show history and delivery receipt. | Inbound is already operational; outbound remains disabled/restricted per existing production controls. Meta App Review/Advanced Access and recipient eligibility are not granted by this local work. |
| `whatsapp_business_messaging` | Existing WhatsApp Cloud API: `POST /{phone-number-id}/messages` and inbound webhook. | Needed for WhatsApp message send/receive. Demonstrate existing WhatsApp workflow separately; do not use Page OAuth as evidence. | Existing operational integration; do not alter its token/settings. |
| `whatsapp_business_management` | No account-management operation was found in the Office adapter: it sends through the configured phone-number ID and does not manage WABA, phone numbers, templates, or assigned users. | Messaging alone does not demonstrate management permission. Meta’s WABA reference associates management permission with WABA/account operations. | Not ready to request on current functionality. Implement a genuine, justified WABA management use case and tests before requesting this permission; do not claim send/receive proves it. |

Permission/API references: [Pages a person can access](https://developers.facebook.com/docs/graph-api/reference/user/accounts/), [Page subscribed apps](https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps/), [Page conversations and messaging requirements](https://developers.facebook.com/docs/graph-api/reference/page/conversations), [Instagram API login-model changelog](https://developers.facebook.com/docs/instagram/platform/instagram-api/changelog/), and [WhatsApp Business Account reference](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/).

At the time of this audit, Meta’s Graph API version schedule lists `v26.0` released July 29, 2026, with expiration not yet set; the docs list `v27.0` as latest. Existing `v26.0` configuration is therefore still in the supported version window, subject to the app’s endpoint-specific access. See [Graph API version schedule](https://developers.facebook.com/docs/graph-api/changelog/versions/) and [platform versioning](https://developers.facebook.com/docs/graph-api/guides/versioning).

## App Review recording walkthroughs

Use only the Ochiga Page, linked @ochigaglobal professional account, authorized app-role test identities, and synthetic or explicitly approved test conversations. Hide browser developer tools, token screens, unrelated CRM data, and personal customer information. Never display the URL query while an OAuth code/state is present.

### `pages_show_list` and `pages_manage_metadata`

1. Sign in as an authorized Office administrator and open Settings → Meta accounts and messaging.
2. Click **Connect Facebook**, complete Meta consent, and show the Page picker populated from the authenticated administrator’s actual `me/accounts` response.
3. Select the Ochiga Page; show the Page name, ID and any matching linked Instagram account in Office.
4. Click **Check Page webhook** and show the verified Page fields plus whether the app-level callback matches. If Page-level fields are missing and repair is allowed, click **Repair Page subscription**, confirm, then recheck.
5. State clearly that the app-level callback is preconfigured in Meta Dashboard and Office only repairs the Page-level subscription; Instagram subscription remains in Meta Dashboard.

### `pages_messaging`

1. From a role-authorized Facebook test account, send a fresh message to the Ochiga Page.
2. Show the inbound message in the existing CRM thread, take ownership, and send a staff-written reply while the conversation is eligible.
3. Show the send ledger and provider receipt; distinguish provider acceptance from actual delivery.
4. Do not show or change the restricted production pilot allowlist.

### `instagram_basic` and `instagram_manage_messages`

1. Show the professional @ochigaglobal account linked to the Ochiga Page in the Meta account settings.
2. From an eligible role/test recipient, send a fresh Instagram DM.
3. Show the inbound CRM conversation, channel identity, authorized staff takeover, and manually authored reply only if the separate pilot is approved and enabled.
4. Show the resulting Office history and provider receipt without implying a delivery event where only acceptance exists.

### `whatsapp_business_messaging`

1. Demonstrate the already-operational WhatsApp inbound and outbound workflow in a separately approved WhatsApp test conversation.
2. Show the customer-service window/template policy, CRM history and send status.
3. Show that takeover and AI autonomy are governed by the existing WhatsApp switch.

### `whatsapp_business_management`

Do not submit a recording for this permission yet. Current Office code does not demonstrate WABA, phone-number, template, or assigned-user management. A separate product requirement and specific management API operation must exist first.

## Release and safety gates

- No migration; the existing runtime-settings table is reused.
- Configure the three new environment variables and exact Meta redirect URI only under separate approval. The encryption key must be backed up and kept stable.
- Before release, verify OAuth callback URI, HTTPS, app scopes, Pages task filtering, stored-token decrypt on restart, and app-level/Page-level webhook overlap.
- Keep Messenger/Instagram outbound flags, exact recipient allowlists, operator allowlists, and AI autonomy unchanged. Page OAuth does not turn on any send capability.
- Confirm WhatsApp signature enforcement, inbound processing, and Cloud API configuration remain unchanged.
- Rollback is code rollback only if no connection has been saved. If an OAuth connection is saved, reverting code does not erase or decrypt it; retain the environment encryption key and existing env token. Do not delete/rotate tokens during rollback. If the key is compromised, revoke through Meta and execute a separately reviewed reconnection/rotation plan.
- No production OAuth, Page subscription change, deployment, token mutation or send was performed as part of this local implementation.
