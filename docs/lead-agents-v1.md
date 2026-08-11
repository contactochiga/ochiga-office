# Ochiga Lead Agents V1

This v1 contains two agents:

- `Marketing Agent`: qualifies inbound leads, scores them, drafts first responses, and hands good leads to Sales.
- `Sales Agent`: asks the real project questions, explains Ochiga and Oyi, recommends the next step, and books a call or escalates to a human.

## Stack

- Frontend: website chat widget or internal dashboard
- Backend: Node.js/Express or Next.js API routes
- OpenAI runtime: Responses API
- Database/CRM: Supabase or existing backend
- Notifications: email, Telegram, or WhatsApp alert to founder or human team

## Runtime flow

1. User sends a message.
2. Backend sends the message, agent system prompt, transcript, and tool definitions to the Responses API.
3. Model decides whether to answer directly or call a tool.
4. Backend executes the tool.
5. Backend sends the tool result back to OpenAI.
6. Model produces the next message or triggers another tool.
7. Backend stores transcript entries and the latest lead summary.

## HTTP endpoints

- `GET /healthz`
- `GET /dashboard`
- `GET /dashboard.js`
- `GET /widget`
- `GET /widget.js`
- `POST /api/lead-agents/public/chat`
- `POST /api/lead-agents/admin/session/login`
- `POST /api/lead-agents/admin/session/logout`
- `GET /api/lead-agents/admin/session/me`
- `GET /webhooks/whatsapp`
- `POST /webhooks/whatsapp`
- `POST /api/lead-agents/chat`
- `GET /api/lead-agents/leads`
- `GET /api/lead-agents/leads/:leadId`
- `GET /api/lead-agents/leads/:leadId/conversations`
- `GET /api/lead-agents/leads/:leadId/demos`
- `GET /api/lead-agents/leads/:leadId/memory`
- `GET /api/lead-agents/leads/:leadId/timeline`
- `GET /api/lead-agents/leads/:leadId/channel-state/:channel`
- `PATCH /api/lead-agents/leads/:leadId/channel-state/:channel`
- `GET /api/lead-agents/admin/traces`
- `GET /api/lead-agents/admin/notifications`
- `GET /api/lead-agents/admin/reports/summary`
- `GET /api/lead-agents/admin/users`
- `POST /api/lead-agents/admin/users`

Example chat request:

```json
{
  "agent": "marketing",
  "source": "website_chat",
  "message": "We manage a 240-unit estate and need better gate access and monitoring.",
  "profile": {
    "name": "Ada",
    "company": "Greenview Estates",
    "role": "Operations Manager",
    "email": "ada@example.com",
    "location": "Lagos"
  }
}
```

Public widget embed:

```html
<script
  src="https://your-backend.example.com/widget.js"
  data-oma-widget="true"
  data-api-base="https://your-backend.example.com"
  data-title="Chat with Oma"
></script>
```

## Environment variables

- `OPENAI_API_KEY` required
- `OPENAI_MODEL` optional, default `gpt-5-mini`
- `LEAD_AGENTS_PORT` optional, default `8787`
- `LEAD_AGENTS_HOST` optional, default `0.0.0.0`
- `LEAD_AGENTS_REQUEST_TIMEOUT_MS` optional, default `120000`
- `LEAD_AGENTS_STORE_DRIVER` optional, `file` or `supabase`, default `file`
- `LEAD_AGENTS_STORE_PATH` optional, default `data/lead-agents-store.json`
- `SUPABASE_URL` required when `LEAD_AGENTS_STORE_DRIVER=supabase`
- `SUPABASE_PUBLISHABLE_KEY` optional for frontend clients or dashboards
- `SUPABASE_SERVICE_ROLE_KEY` required when `LEAD_AGENTS_STORE_DRIVER=supabase`
- `LEAD_AGENTS_DEFAULT_SOURCE` optional, default `website_chat`
- `LEAD_AGENTS_ALLOWED_ORIGINS` optional, comma-separated CORS allowlist
- `LEAD_AGENTS_AUTH_MODE` optional, `off`, `optional_api_key`, or `required_api_key`
- `LEAD_AGENTS_API_KEYS` optional, comma-separated API keys for backend access
- `LEAD_AGENTS_ADMIN_EMAIL` optional, used for dashboard login
- `LEAD_AGENTS_ADMIN_PASSWORD` optional, used for dashboard login
- `LEAD_AGENTS_ADMIN_ROLE` optional, default `admin`
- `LEAD_AGENTS_SESSION_SECRET` optional, used to sign dashboard session cookies
- `LEAD_AGENTS_SESSION_TTL_MS` optional, default 7 days
- `LEAD_AGENTS_RATE_LIMIT_WINDOW_MS` optional, default `60000`
- `LEAD_AGENTS_RATE_LIMIT_MAX_REQUESTS` optional, default `60`
- `LEAD_AGENTS_KNOWLEDGE_DIR` optional, default `knowledge/`
- `LEAD_AGENTS_TRACE_PATH` optional, default `data/lead-agent-traces.jsonl`
- `LEAD_AGENTS_MEMORY_PATH` optional, default `data/lead-memory.json`
- `FOUNDER_ALERT_WEBHOOK_URL` optional, webhook for escalations
- `FOUNDER_ALERT_WEBHOOK_SECRET` optional, shared secret for escalation webhook
- `SALES_ALERT_WEBHOOK_URL` optional, webhook for sales handoff alerts
- `SALES_ALERT_WEBHOOK_SECRET` optional, shared secret for sales alerts
- `DEMO_WEBHOOK_URL` optional, webhook for demo booking events
- `DEMO_WEBHOOK_SECRET` optional, shared secret for demo webhook
- `WHATSAPP_VERIFY_TOKEN` required for Meta webhook verification
- `WHATSAPP_ACCESS_TOKEN` required for WhatsApp Cloud API sends
- `WHATSAPP_PHONE_NUMBER_ID` required for WhatsApp Cloud API sends
- `WHATSAPP_BUSINESS_ACCOUNT_ID` optional for future account-scoped operations
- `WHATSAPP_API_VERSION` optional, default `v22.0`

## Run

```bash
npm run lead-agents:start
```

## Production notes

- For local development, use the default `file` store.
- For production, prefer `LEAD_AGENTS_STORE_DRIVER=supabase`.
- Protect non-health endpoints with `LEAD_AGENTS_AUTH_MODE=required_api_key`.
- Put your reverse proxy in front of this service and preserve `X-Forwarded-For` for rate limiting.
- Use webhook adapters to send founder alerts and demo notifications into email, Telegram, WhatsApp, or your existing automation layer.
- A Render Blueprint is provided at [`render.yaml`](/Users/ochigaidoko/oyi-edge-agent/render.yaml).
- An environment template is provided at [`.env.lead-agents.example`](/Users/ochigaidoko/oyi-edge-agent/.env.lead-agents.example).

## Admin endpoints

- `POST /api/lead-agents/admin/leads`
- `PATCH /api/lead-agents/leads/:leadId`
- `POST /api/lead-agents/leads/:leadId/demos`
- `POST /api/lead-agents/admin/notify-founder`

These are intended for internal dashboards and operator workflows.

## Test harness

Run the mock-backed runtime harness with:

```bash
npm run lead-agents:test
```

This validates the lead lifecycle, tool execution, and transcript persistence without a live OpenAI call.

For the browser widget, open:

- `/widget` for the preview page
- `/widget.js` for the embeddable script

For the internal dashboard, open:

- `/dashboard`

Log in with an admin user stored in the backend. On startup, the service bootstraps one admin user from `LEAD_AGENTS_ADMIN_EMAIL`, `LEAD_AGENTS_ADMIN_PASSWORD`, and `LEAD_AGENTS_ADMIN_ROLE`. If those are not set yet, the backend still accepts any email plus a valid `LEAD_AGENTS_API_KEYS` value as the temporary password and creates a default admin user.

## V1.5+ foundation

- Tracing: request and tool traces are persisted in the store and exposed through `/api/lead-agents/admin/traces`
- Lead memory: per-lead memory is persisted in the store and exposed through `/api/lead-agents/leads/:leadId/memory`
- File-backed knowledge: Markdown files under `knowledge/` are retrieved into runtime context
- Eval pack: run `npm run lead-agents:eval`
- Reporting: source, stage, demo, escalation, and sales handoff metrics are exposed through `/api/lead-agents/admin/reports/summary`
- Notifications: founder escalations, sales handoffs, and demo alerts are stored in `notifications`
- CRM timeline: lead activity is aggregated into `timeline_events` and exposed through `/api/lead-agents/leads/:leadId/timeline`
- WhatsApp channel adapter: Meta webhook verification, inbound normalization, lead resolution by phone, per-channel AI pause state, and Cloud API outbound replies through `/webhooks/whatsapp`

## Agent packs

- [`Ochiga Marketing Agent`](/Users/ochigaidoko/oyi-edge-agent/prompt-packs/marketing-agent/prompt-pack.json)
- [`Ochiga Sales Agent`](/Users/ochigaidoko/oyi-edge-agent/prompt-packs/sales-agent/prompt-pack.json)

## Shared tools

Tool definitions for the Responses API are in:

- [`config/openai/lead-agent-tools.json`](/Users/ochigaidoko/oyi-edge-agent/config/openai/lead-agent-tools.json)

## Database

The minimal schema is in:

- [`db/lead-agents-schema.sql`](/Users/ochigaidoko/oyi-edge-agent/db/lead-agents-schema.sql)

Tables:

- `leads`
- `conversations`
- `demos`
- `lead_memories`
- `traces`
- `notifications`
- `admin_users`
- `timeline_events`
- `lead_channel_states`
- `inbound_events`

## Suggested routing

Marketing Agent to Sales:

- asks for pricing
- asks for demo or call
- clearly has a real project
- asks technical questions
- score is `70+`

Sales Agent to human:

- government or institutional buyer
- custom enterprise scope
- negotiation on price or contracts
- partnerships
- large multi-site estates
- procurement or legal questions

## Implementation notes

- Keep all outbound claims bounded by tool outputs or trusted internal context.
- Do not automate price negotiation, deployment promises, or strategic deal closure in v1.
- Always write the transcript and latest structured summary after each turn.
