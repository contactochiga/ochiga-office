This file covers the edge runtime and internal commercial agent stack in `oyi-edge-agent`.

Edge runtime:
- described as the on-site edge daemon for Oyi Smart Estate OS
- built as the bridge between local infrastructure and cloud control

Current edge capabilities in code:
- agent registration
- heartbeat loop
- discovery push loop
- durable local outbox queue
- retry with exponential backoff
- queue replay after failure
- remote config pull
- /healthz endpoint
- structured logs
- graceful shutdown
- ONVIF camera payload building
- legacy compatibility mode

Operational significance:
- it is the start of Oyi's edge control plane
- it is designed for offline tolerance and resilient sync
- it is suitable as a basis for site-level runtime management

Current gaps:
- no full multi-device protocol layer yet
- no hardened secure identity or mTLS yet
- no true OTA or fleet management yet
- no full local broker or event bus yet

Internal commercial agent stack:
- Oma for marketing and qualification
- Osa for sales, discovery, and escalation
- website widget
- internal dashboard
- lead memory
- traces
- notifications
- reports
- WhatsApp adapter scaffolding
- markdown knowledge retrieval

This means Ochiga already has:
- product surfaces
- edge runtime
- commercial websites
- internal AI commercial operations
