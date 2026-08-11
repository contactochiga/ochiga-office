# Office OS Commercial Operations

## Current Command Center Flow

Lead arrives → OMA qualifies → Lead is stored → OSA generates proposal → Building Review is scheduled → Commercial approval is recorded → Deployment project is created → Facility workspace checklist is prepared.

## Minimum Monday Views

- Leads Board via `/api/lead-agents/admin/commercial/pipeline`
- Lead Detail via existing dashboard detail rail
- Proposal Draft via lead proposal action
- Building Review via lead building-review action
- Commercial Approval via lead commercial-approval action
- Partner tracking via `/api/lead-agents/admin/partners`
- Deployment tracking via `/api/lead-agents/admin/deployments`
- Facility workspace preparation via lead provisioning action

## Safety

Facility workspace creation is manual-preparation only in Phase 1. It creates a checklist and deployment record but does not send passwords or silently create live customer access without approval.

## Remaining Work

- Add a full kanban board UI for pipeline stages.
- Add partner management screen.
- Add deployment checklist screen.
- Connect approved Facility provisioning to backend invite/activation flow.
- Add email sending for onboarding once templates and sender are production-verified.
