function text(value) {
  return String(value ?? "").trim();
}

function recordOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function ownerForAgentRole(role) {
  return text(role).toLowerCase() === "osa" ? "sales_agent" : "marketing_agent";
}

function proposalList(value) {
  return Array.isArray(value) ? value.filter((proposal) => proposal && typeof proposal === "object") : [];
}

function leadPatchForProposal(proposal, session) {
  const params = recordOf(proposal.parameters);
  const owner = ownerForAgentRole(session.active_agent_role);
  const base = {
    owner,
    source: text(session.source && session.source.source_site) || "website_chat",
    primary_channel: text(session.source && session.source.source_channel) || "website",
    project_type: text(params.inquiry_type || session.inquiry_type),
    commercial_stage: text(params.stage || session.lead_stage || "interested"),
    summary: text(params.summary),
    next_action: text(proposal.reason || params.next_action),
    last_contact_at: new Date().toISOString(),
  };

  if (proposal.tool === "crm.create_opportunity") {
    return {
      ...base,
      owner: "sales_agent",
      status: "qualified",
      commercial_stage: text(params.stage || "opportunity_introduced"),
      next_action: text(params.next_action || "Review Oyi Core opportunity signal and qualify next step."),
    };
  }

  if (proposal.tool === "office.request_handoff") {
    return {
      ...base,
      owner: "sales_agent",
      status: "handoff_requested",
      commercial_stage: text(params.stage || "human_handoff_requested"),
      next_action: text(params.next_action || "Assign a human Office owner for this public intelligence session."),
    };
  }

  return base;
}

async function appendToolTimeline({ store, lead, proposal, result, session, requestId }) {
  if (!store?.appendTimelineEvent || !lead?.id) return null;
  return store.appendTimelineEvent({
    lead_id: lead.id,
    event_type: result.ok ? "oyi_core_tool_proposal_applied" : "oyi_core_tool_proposal_rejected",
    actor: ownerForAgentRole(session.active_agent_role),
    title: result.ok ? "Oyi Core tool proposal applied" : "Oyi Core tool proposal rejected",
    body: text(proposal.reason) || text(result.reason) || "Corporate public intelligence tool proposal processed.",
    metadata: {
      request_id: text(requestId),
      tool: text(proposal.tool),
      proposal_id: text(proposal.proposal_id),
      business_unit: text(session.business_unit),
      agent_role: text(session.active_agent_role),
      result_status: result.status,
      reason: text(result.reason),
    },
  });
}

async function executeGovernedOfficeToolProposals({ proposals, store, lead, session, requestId } = {}) {
  const allowedTools = new Set([
    "crm.create_or_update_lead",
    "crm.create_opportunity",
    "office.request_handoff",
  ]);
  const safeSession = recordOf(session);
  let currentLead = lead || null;
  const results = [];

  for (const proposal of proposalList(proposals)) {
    const tool = text(proposal.tool);
    if (!allowedTools.has(tool)) {
      const result = {
        ok: false,
        status: "rejected",
        proposal_id: text(proposal.proposal_id),
        tool,
        reason: "office_tool_not_allowed_for_public_surface",
      };
      results.push(result);
      await appendToolTimeline({ store, lead: currentLead, proposal, result, session: safeSession, requestId });
      continue;
    }

    if (!currentLead?.id) {
      const result = {
        ok: false,
        status: "rejected",
        proposal_id: text(proposal.proposal_id),
        tool,
        reason: "crm_lead_required_before_tool_execution",
      };
      results.push(result);
      continue;
    }

    const patch = leadPatchForProposal(proposal, safeSession);
    const updated = await store.updateLead(currentLead.id, patch);
    currentLead = updated || currentLead;
    const result = {
      ok: Boolean(updated),
      status: updated ? "applied" : "failed",
      proposal_id: text(proposal.proposal_id),
      tool,
      lead_id: currentLead.id,
      reason: updated ? "" : "lead_update_failed",
    };
    results.push(result);
    await appendToolTimeline({ store, lead: currentLead, proposal, result, session: safeSession, requestId });
  }

  return {
    lead: currentLead,
    results,
  };
}

module.exports = {
  executeGovernedOfficeToolProposals,
  leadPatchForProposal,
};
