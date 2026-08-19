// Oyi Runtime Contract, Domain 3 (Task) — additive projection of the
// 4 genuine overlapping Office commercial workflow types into
// Backend's ochiga_workflows, fulfilling the already-declared
// "office-backend-intelligence-events" platform boundary contract
// (Ochiga-backend's src/contracts/platformBoundaries.ts). Office
// remains the sole source of truth for the underlying lead/proposal/
// demo/deployment record — this module only ever notifies Backend
// that a real commercial fact happened, for cross-agent operational
// visibility (Facility's operator queue and Consumer's dashboard
// already read ochiga_workflows).
//
// Rollback: set OFFICE_WORKFLOW_BRIDGE_ENABLED=false. No code change,
// no data cleanup required — nothing else in Office depends on this
// having run.
const { callOyiCoreCreateWorkflow, callOyiCoreTransitionWorkflow } = require("./oyi-core-gateway");

// Matches Backend's OFFICE_ALLOWED_WORKFLOW_TYPES (officeExport.ts) —
// customer_onboarding deliberately excluded (see docs/architecture/
// OYI_RUNTIME_DOMAIN_MODEL.md on the Backend repo: no Office event
// exists that's genuinely distinct from deployment_required).
const WORKFLOW_TYPE_AGENTS = {
  customer_converted: { origin_agent: "oma", responsible_agent: "osa" },
  proposal_accepted: { origin_agent: "oma", responsible_agent: "osa" },
  meeting_requested: { origin_agent: "oma", responsible_agent: "osa" },
  deployment_required: { origin_agent: "osa", responsible_agent: "facility" },
};

// Best-effort, non-blocking, idempotent per (recordType, recordId).
// Never throws — every call site treats this as fire-and-forget.
async function bridgeWorkflow({ config, store, workflowType, recordType, recordId, title, summary, sourceRef }) {
  if (!config.officeWorkflowBridgeEnabled) return { ok: false, skipped: true, reason: "disabled" };
  const agents = WORKFLOW_TYPE_AGENTS[workflowType];
  if (!agents) return { ok: false, skipped: true, reason: "unsupported_workflow_type" };
  try {
    const existing = await store.getWorkflowLink(recordType, recordId);
    if (existing) return { ok: true, skipped: true, reason: "already_linked", workflow_id: existing.workflow_id };

    const result = await callOyiCoreCreateWorkflow(config, {
      workflow_type: workflowType,
      title,
      summary,
      origin_agent: agents.origin_agent,
      responsible_agent: agents.responsible_agent,
      source_event_id: `${recordType}:${recordId}`,
      source_ref: sourceRef || `${recordType}:${recordId}`,
    });
    if (!result.ok || !result.workflow) return result;

    await store.saveWorkflowLink(recordType, recordId, result.workflow.workflow_id);
    return result;
  } catch (error) {
    return { ok: false, reason: "bridge_exception", error: error && error.message ? error.message : String(error) };
  }
}

// Transitions the linked workflow, if one exists — a no-op (not an
// error) when the record was never bridged (bridge disabled at the
// time, or an unsupported type).
async function transitionLinkedWorkflow({ config, store, recordType, recordId, status, summary }) {
  if (!config.officeWorkflowBridgeEnabled) return { ok: false, skipped: true, reason: "disabled" };
  try {
    const link = await store.getWorkflowLink(recordType, recordId);
    if (!link) return { ok: false, skipped: true, reason: "not_linked" };
    return await callOyiCoreTransitionWorkflow(config, link.workflow_id, { status, summary });
  } catch (error) {
    return { ok: false, reason: "bridge_exception", error: error && error.message ? error.message : String(error) };
  }
}

module.exports = { bridgeWorkflow, transitionLinkedWorkflow, WORKFLOW_TYPE_AGENTS };
