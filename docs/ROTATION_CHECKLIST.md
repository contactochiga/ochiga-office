# Credential Rotation Checklist

This checklist intentionally lists credential names only. Do not paste live values into this file.

| Variable | Provider/System | Runtime | Automatic Rotation Safe? | Manual Action Required |
| --- | --- | --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI | Office lead agents | No | Create a replacement key, update Office hosting secret, deploy, then revoke old key after health verification. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase | Office CRM persistence | No | Rotate in Supabase, update Office hosting secret, verify CRM read/write smoke, then revoke old key. |
| `LEAD_AGENTS_API_KEYS` | Ochiga Office | Website/Office API auth | Potentially, with dual-key overlap | Add new key alongside old key, deploy callers, verify intake, then remove old key. |
| `LEAD_AGENTS_ADMIN_PASSWORD` | Ochiga Office | Office admin | Yes, after admin notice | Set new password hash/source secret and verify admin login. |
| `LEAD_AGENTS_SESSION_SECRET` | Ochiga Office | Office admin sessions | No | Replace secret during a planned window; existing sessions will be invalidated. |
| `RESEND_API_KEY` | Resend | Office email | No | Create replacement key, update Office secret, send test notification, revoke old key. |
| `FOUNDER_ALERT_WEBHOOK_SECRET` | Webhook receiver | Office alerts | No | Rotate receiver secret and Office secret together. |
| `DEMO_WEBHOOK_SECRET` | Webhook receiver | Office demo alerts | No | Rotate receiver secret and Office secret together. |
| `SALES_ALERT_WEBHOOK_SECRET` | Webhook receiver | Office sales alerts | No | Rotate receiver secret and Office secret together. |
| `WHATSAPP_VERIFY_TOKEN` | Meta WhatsApp | Office WhatsApp webhook | No | Update Meta app and Office secret together. |
| `WHATSAPP_ACCESS_TOKEN` | Meta WhatsApp | Office WhatsApp messaging | No | Generate replacement token, update Office secret, verify webhook/message flow, revoke old token. |
| `META_APP_SECRET` | Meta | Office social integrations | No | Rotate in Meta and update Office secrets during a planned window. |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | Meta/Facebook | Office social integrations | No | Generate replacement token and verify page integration. |
| `LINKEDIN_CLIENT_SECRET` | LinkedIn | Office OAuth/social | No | Rotate in LinkedIn app and update Office secret. |
| `LINKEDIN_ACCESS_TOKEN` | LinkedIn | Office social integrations | No | Refresh/regenerate and verify integration. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud | Office OAuth/analytics | No | Rotate in Google Cloud and update Office secret. |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads | Office marketing integrations | No | Rotate per Google Ads process and verify reporting. |
| `OFFICE_FACILITY_API_KEY` | Facility API | Office projections | No | Coordinate with Facility owner, update both sides, verify read-only export. |
| `OFFICE_FACILITY_BEARER_TOKEN` | Facility API | Office projections | No | Coordinate with Facility owner, update both sides, verify read-only export. |
| `OFFICE_CONSUMER_API_KEY` | Consumer API | Office projections | No | Coordinate with Consumer owner, update both sides, verify read-only export. |
| `OFFICE_CONSUMER_BEARER_TOKEN` | Consumer API | Office projections | No | Coordinate with Consumer owner, update both sides, verify read-only export. |
| `OFFICE_BACKEND_API_KEY` | Ochiga Backend | Office event/projection integration | No | Coordinate with Backend owner, update both sides, verify event/projection smoke. |
| `OFFICE_BACKEND_BEARER_TOKEN` | Ochiga Backend | Office event/projection integration | No | Coordinate with Backend owner, update both sides, verify event/projection smoke. |
