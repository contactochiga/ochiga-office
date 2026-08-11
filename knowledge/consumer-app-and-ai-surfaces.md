This file describes the current resident and consumer side of Oyi in the `Oyi-os-frontend` codebase.

What it is:
- the resident and consumer-facing Oyi app
- built in Next.js and prepared for Capacitor and iOS packaging
- combines resident operations, device control, estate activity, and AI-guided interaction

Primary app surfaces:
- home
- visitors
- wallet
- community
- maintenance
- rooms
- room detail
- devices
- estate
- invites
- settings
- auth

Implemented capabilities in code:
- resident auth flows
- email signup and login
- Google and Apple sign-in stubs
- estate-aware dashboard
- device live-state retrieval
- device discovery versus assigned-device views
- device commands
- visitor access creation
- visitor code, link, and QR generation
- visitor status tracking
- wallet fetch
- wallet funding initialization flow
- wallet debit hooks
- community posting
- comments and replies
- reactions and likes
- maintenance ticket creation and history
- notifications listing
- invite acceptance and decline
- room creation
- room AI profile updates
- room user assignment
- realtime estate and device subscriptions

AI interaction model:
- natural-language requests are routed to panel intents
- intents include home summary, room summary, light, AC, TV, door control, visitor access, CCTV, security, maintenance, wallet, utilities, rooms, community, and devices
- this means the AI layer is positioned as an action gateway into operational panels, not just a chat surface

Current maturity:
- broad feature surface
- strong resident UX coverage
- some flows remain backend-dependent or controlled-rollout
- funding is intentionally disabled in the UI at the moment
