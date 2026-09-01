const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { normalizeEmail, normalizeLeadInput, normalizeLeadPatch, normalizeText } = require("./normalize-lead");
const { buildDeploymentFromLead, normalizePartner } = require("./commercial-ops");
const { buildOfficeSnapshot, createOfficeSeedData } = require("./office-data");

class FileLeadAgentsStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.state = {
      leads: [],
      conversations: [],
      demos: [],
      proposals: [],
      notifications: [],
      traces: [],
      lead_memories: [],
      admin_users: [],
      admin_invites: [],
      password_reset_tokens: [],
      audit_events: [],
      timeline_events: [],
      crm_contacts: [],
      crm_organizations: [],
      crm_opportunities: [],
      crm_activities: [],
      crm_tasks: [],
      office_projects: [],
      office_portfolio_entries: [],
      office_support_cases: [],
      office_private_relationships: [],
      office_partnership_relationships: [],
      office_meetings: [],
      lead_channel_states: [],
      inbound_events: [],
      office_packages: [],
      office_estates: [],
      office_buildings: [],
      office_homes: [],
      office_devices: [],
      office_wallets: [],
      office_analytics: [],
      office_documents: [],
      office_document_folders: [],
      office_support_mappings: [],
      office_handoffs: [],
      office_files: [],
      partners: [],
      deployment_projects: [],
      facility_workspaces: [],
      onboarding_emails: [],
      staff_conversations: [],
      staff_conversation_participants: [],
      staff_messages: [],
      staff_message_reads: [],
      staff_message_attachments: [],
      office_content_items: [],
      office_reports: [],
      office_development_projects: [],
      // Oyi Runtime Contract, Domain 3 (Task) — durable link between an
      // Office-owned record (lead/proposal/demo/deployment) and the
      // ochiga_workflows row it was projected into on Backend. Office
      // remains the source of truth for the record itself; this is
      // purely a reference so the bridge is idempotent (don't create a
      // second workflow for the same record) and reversible (stop
      // writing here and the bridge is fully disabled, nothing else
      // changes). See src/lead-agents/workflow-bridge.js.
      ochiga_workflow_links: [],
    };
    this.pendingWrite = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = {
        leads: Array.isArray(parsed.leads) ? parsed.leads : [],
        conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
        demos: Array.isArray(parsed.demos) ? parsed.demos : [],
        proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
        notifications: Array.isArray(parsed.notifications) ? parsed.notifications : [],
        traces: Array.isArray(parsed.traces) ? parsed.traces : [],
        lead_memories: Array.isArray(parsed.lead_memories) ? parsed.lead_memories : [],
        admin_users: Array.isArray(parsed.admin_users) ? parsed.admin_users : [],
        admin_invites: Array.isArray(parsed.admin_invites) ? parsed.admin_invites : [],
        password_reset_tokens: Array.isArray(parsed.password_reset_tokens)
          ? parsed.password_reset_tokens
          : [],
        audit_events: Array.isArray(parsed.audit_events) ? parsed.audit_events : [],
        timeline_events: Array.isArray(parsed.timeline_events) ? parsed.timeline_events : [],
        crm_contacts: Array.isArray(parsed.crm_contacts) ? parsed.crm_contacts : [],
        crm_organizations: Array.isArray(parsed.crm_organizations) ? parsed.crm_organizations : [],
        crm_opportunities: Array.isArray(parsed.crm_opportunities) ? parsed.crm_opportunities : [],
        crm_activities: Array.isArray(parsed.crm_activities) ? parsed.crm_activities : [],
        crm_tasks: Array.isArray(parsed.crm_tasks) ? parsed.crm_tasks : [],
        office_projects: Array.isArray(parsed.office_projects) ? parsed.office_projects : [],
        office_portfolio_entries: Array.isArray(parsed.office_portfolio_entries) ? parsed.office_portfolio_entries : [],
        office_support_cases: Array.isArray(parsed.office_support_cases) ? parsed.office_support_cases : [],
        office_private_relationships: Array.isArray(parsed.office_private_relationships) ? parsed.office_private_relationships : [],
        office_partnership_relationships: Array.isArray(parsed.office_partnership_relationships) ? parsed.office_partnership_relationships : [],
        office_meetings: Array.isArray(parsed.office_meetings) ? parsed.office_meetings : [],
        lead_channel_states: Array.isArray(parsed.lead_channel_states)
          ? parsed.lead_channel_states
          : [],
        inbound_events: Array.isArray(parsed.inbound_events) ? parsed.inbound_events : [],
        office_packages: Array.isArray(parsed.office_packages) ? parsed.office_packages : [],
        office_estates: Array.isArray(parsed.office_estates) ? parsed.office_estates : [],
        office_buildings: Array.isArray(parsed.office_buildings) ? parsed.office_buildings : [],
        office_homes: Array.isArray(parsed.office_homes) ? parsed.office_homes : [],
        office_devices: Array.isArray(parsed.office_devices) ? parsed.office_devices : [],
        office_wallets: Array.isArray(parsed.office_wallets) ? parsed.office_wallets : [],
        office_analytics: Array.isArray(parsed.office_analytics) ? parsed.office_analytics : [],
        office_documents: Array.isArray(parsed.office_documents) ? parsed.office_documents : [],
        office_document_folders: Array.isArray(parsed.office_document_folders) ? parsed.office_document_folders : [],
        office_support_mappings: Array.isArray(parsed.office_support_mappings)
          ? parsed.office_support_mappings
          : [],
        office_handoffs: Array.isArray(parsed.office_handoffs) ? parsed.office_handoffs : [],
        office_files: Array.isArray(parsed.office_files) ? parsed.office_files : [],
        partners: Array.isArray(parsed.partners) ? parsed.partners : [],
        deployment_projects: Array.isArray(parsed.deployment_projects) ? parsed.deployment_projects : [],
        facility_workspaces: Array.isArray(parsed.facility_workspaces) ? parsed.facility_workspaces : [],
        onboarding_emails: Array.isArray(parsed.onboarding_emails) ? parsed.onboarding_emails : [],
        staff_conversations: Array.isArray(parsed.staff_conversations) ? parsed.staff_conversations : [],
        staff_conversation_participants: Array.isArray(parsed.staff_conversation_participants) ? parsed.staff_conversation_participants : [],
        staff_messages: Array.isArray(parsed.staff_messages) ? parsed.staff_messages : [],
        staff_message_reads: Array.isArray(parsed.staff_message_reads) ? parsed.staff_message_reads : [],
        staff_message_attachments: Array.isArray(parsed.staff_message_attachments) ? parsed.staff_message_attachments : [],
        office_content_items: Array.isArray(parsed.office_content_items) ? parsed.office_content_items : [],
        office_reports: Array.isArray(parsed.office_reports) ? parsed.office_reports : [],
        office_development_projects: Array.isArray(parsed.office_development_projects) ? parsed.office_development_projects : [],
        ochiga_workflow_links: Array.isArray(parsed.ochiga_workflow_links) ? parsed.ochiga_workflow_links : [],
      };
      if (await this.ensureOfficeSeedData()) {
        await this.persist();
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
      await this.ensureOfficeSeedData();
      await this.persist();
    }
  }

  persist() {
    this.pendingWrite = this.pendingWrite.then(() =>
      fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2))
    );
    return this.pendingWrite;
  }

  nowIso() {
    return new Date().toISOString();
  }

  async ensureOfficeSeedData() {
    const hasOfficeData =
      this.state.office_packages.length ||
      this.state.office_estates.length ||
      this.state.office_buildings.length ||
      this.state.office_homes.length ||
      this.state.office_devices.length ||
      this.state.office_wallets.length ||
      this.state.office_analytics.length ||
      this.state.office_documents.length ||
      this.state.office_support_mappings.length;
    if (hasOfficeData) {
      return false;
    }
    const seed = createOfficeSeedData(this.nowIso());
    this.state.office_packages = seed.packages;
    this.state.office_estates = seed.estates;
    this.state.office_buildings = seed.buildings;
    this.state.office_homes = seed.homes;
    this.state.office_devices = seed.devices;
    this.state.office_wallets = seed.wallets;
    this.state.office_analytics = seed.analytics;
    this.state.office_documents = seed.documents || [];
    this.state.office_support_mappings = seed.support_mappings;
    return true;
  }

  withDefaults(input) {
    return {
      name: input.name || "",
      company: input.company || "",
      role: input.role || "",
      email: input.email || "",
      phone: input.phone || "",
      whatsapp_phone: input.whatsapp_phone || "",
      primary_channel: input.primary_channel || "",
      channel_last_seen_at: input.channel_last_seen_at || "",
      source: input.source || "",
      source_channel: input.source_channel || input.primary_channel || input.source || "",
      business_unit: input.business_unit || null,
      inquiry_type: input.inquiry_type || null,
      location: input.location || "",
      city: input.city || "",
      country: input.country || "",
      unit_count:
        input.unit_count === undefined || input.unit_count === null || input.unit_count === ""
          ? null
          : Number(input.unit_count),
      project_type: input.project_type || "",
      property_type: input.property_type || input.project_type || "",
      property_size: input.property_size || "",
      number_of_units:
        input.number_of_units === undefined || input.number_of_units === null || input.number_of_units === ""
          ? null
          : Number(input.number_of_units),
      pain_points: input.pain_points || "",
      budget_range: input.budget_range || "",
      timeline: input.timeline || "",
      decision_maker_status: input.decision_maker_status || "",
      interest_package: input.interest_package || "",
      lead_score: Number.isFinite(Number(input.lead_score)) ? Number(input.lead_score) : Number(input.score || 0),
      qualification_status: input.qualification_status || "",
      stage: input.stage || input.commercial_stage || input.status || "new",
      status: input.status || "new",
      owner: input.owner || "marketing_agent",
      commercial_stage: input.commercial_stage || "",
      lost_reason: input.lost_reason || "",
      score: Number.isFinite(Number(input.score)) ? Number(input.score) : 0,
      summary: input.summary || "",
      next_action: input.next_action || "",
      next_action_at: input.next_action_at || null,
      last_contact_at: input.last_contact_at || null,
      notes: input.notes || "",
    };
  }

  async appendTimelineEvent(input) {
    const event = {
      id: crypto.randomUUID(),
      lead_id: input.lead_id,
      event_type: input.event_type,
      actor: input.actor || "",
      title: input.title || "",
      body: input.body || "",
      metadata: input.metadata || {},
      created_at: this.nowIso(),
    };
    this.state.timeline_events.push(event);
    await this.persist();
    return event;
  }

  async createLead(input) {
    const normalized = this.withDefaults(normalizeLeadInput(input, input.source));
    const lead = {
      id: crypto.randomUUID(),
      ...normalized,
      created_at: this.nowIso(),
      updated_at: this.nowIso(),
    };

    this.state.leads.push(lead);
    await this.appendTimelineEvent({
      lead_id: lead.id,
      event_type: "lead_created",
      actor: lead.owner,
      title: "Lead created",
      body: lead.summary || "New lead record created.",
      metadata: {
        source: lead.source,
        primary_channel: lead.primary_channel,
      },
    });
    await this.persist();
    return lead;
  }

  async updateLead(leadId, patch) {
    const index = this.state.leads.findIndex((lead) => lead.id === leadId);
    if (index === -1) {
      return null;
    }

    const current = this.state.leads[index];
    const normalizedPatch = normalizeLeadPatch(patch);
    const updated = {
      ...current,
      ...Object.fromEntries(
        Object.entries(normalizedPatch).filter(([, value]) => value !== undefined)
      ),
      updated_at: this.nowIso(),
    };

    this.state.leads[index] = updated;
    await this.appendTimelineEvent({
      lead_id: leadId,
      event_type: "lead_updated",
      actor: normalizedPatch.owner || current.owner || "",
      title: "Lead updated",
      body: normalizeText(normalizedPatch.summary) || normalizeText(normalizedPatch.next_action) || "Lead fields updated.",
      metadata: normalizedPatch,
    });
    await this.persist();
    return updated;
  }

  async getLead(leadId) {
    return this.state.leads.find((lead) => lead.id === leadId) || null;
  }

  async findLeadByPhone(phone) {
    const normalized = normalizeText(phone);
    if (!normalized) return null;
    return (
      this.state.leads.find(
        (lead) => lead.phone === normalized || lead.whatsapp_phone === normalized
      ) || null
    );
  }

  async findLeadByEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    return this.state.leads.find((lead) => normalizeEmail(lead.email) === normalized) || null;
  }

  async listLeads() {
    return [...this.state.leads].sort((a, b) =>
      String(b.updated_at).localeCompare(String(a.updated_at))
    );
  }

  async appendConversation(input) {
    const item = {
      id: crypto.randomUUID(),
      lead_id: input.lead_id,
      agent_name: input.agent_name,
      message_role: input.message_role,
      channel: input.channel || "website",
      external_message_id: input.external_message_id || "",
      parent_external_message_id: input.parent_external_message_id || "",
      content: input.content,
      created_at: this.nowIso(),
    };

    this.state.conversations.push(item);
    await this.appendTimelineEvent({
      lead_id: input.lead_id,
      event_type: input.message_role === "tool" ? "tool_event" : "conversation",
      actor: input.agent_name,
      title: input.message_role === "tool" ? "Tool activity" : `${input.message_role} message`,
      body: input.content,
      metadata: {
        message_role: input.message_role,
        channel: input.channel || "website",
        external_message_id: input.external_message_id || "",
      },
    });
    await this.persist();
    return item;
  }

  async listConversationsForLead(leadId, limit = 50) {
    return this.state.conversations
      .filter((item) => item.lead_id === leadId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .slice(-limit);
  }

  async createDemo(input) {
    const demo = {
      id: crypto.randomUUID(),
      lead_id: input.lead_id,
      scheduled_for: input.scheduled_for || null,
      status: input.status || "pending",
      notes: input.notes || "",
      created_at: this.nowIso(),
    };

    this.state.demos.push(demo);
    await this.appendTimelineEvent({
      lead_id: input.lead_id,
      event_type: "building_review_scheduled",
      actor: "system",
      title: "Building review scheduled",
      body: demo.notes || "Building review record created.",
      metadata: demo,
    });
    await this.persist();
    return demo;
  }

  // Oyi Runtime Contract, Domain 3 (Task) — see the ochiga_workflow_links
  // comment in the constructor above.
  async getWorkflowLink(recordType, recordId) {
    return (
      this.state.ochiga_workflow_links.find(
        (link) => link.record_type === recordType && link.record_id === recordId
      ) || null
    );
  }

  async saveWorkflowLink(recordType, recordId, workflowId) {
    const existing = await this.getWorkflowLink(recordType, recordId);
    if (existing) return existing;
    const link = {
      id: crypto.randomUUID(),
      record_type: recordType,
      record_id: recordId,
      workflow_id: workflowId,
      created_at: this.nowIso(),
    };
    this.state.ochiga_workflow_links.push(link);
    await this.persist();
    return link;
  }

  async listDemosForLead(leadId) {
    return this.state.demos
      .filter((item) => item.lead_id === leadId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async listDemos() {
    return this.state.demos
      .map((demo) => ({
        ...demo,
        lead: this.state.leads.find((lead) => lead.id === demo.lead_id) || null,
      }))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async createProposal(input) {
    const proposal = {
      id: crypto.randomUUID(),
      lead_id: input.lead_id,
      title: input.title || "Proposal",
      tier_name: input.tier_name || "",
      unit_count:
        input.unit_count === undefined || input.unit_count === null ? null : Number(input.unit_count),
      monthly_price:
        input.monthly_price === undefined || input.monthly_price === null
          ? null
          : Number(input.monthly_price),
      currency: input.currency || "NGN",
      status: input.status || "draft",
      body: input.body || "",
      metadata: input.metadata || {},
      created_at: this.nowIso(),
      updated_at: this.nowIso(),
    };
    this.state.proposals.push(proposal);
    await this.appendTimelineEvent({
      lead_id: input.lead_id,
      event_type: "proposal_created",
      actor: input.actor || "system",
      title: "Proposal created",
      body: proposal.title,
      metadata: proposal,
    });
    await this.persist();
    return proposal;
  }

  async listProposalsForLead(leadId) {
    return this.state.proposals
      .filter((item) => item.lead_id === leadId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async listProposals() {
    return this.state.proposals
      .map((proposal) => ({
        ...proposal,
        lead: this.state.leads.find((lead) => lead.id === proposal.lead_id) || null,
      }))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async getProposal(proposalId) {
    return this.state.proposals.find((item) => item.id === proposalId) || null;
  }

  async updateProposal(proposalId, patch) {
    const index = this.state.proposals.findIndex((item) => item.id === proposalId);
    if (index === -1) return null;
    this.state.proposals[index] = {
      ...this.state.proposals[index],
      ...patch,
      updated_at: this.nowIso(),
    };
    await this.persist();
    return this.state.proposals[index];
  }

  async qualifyLead(leadId, qualification) {
    const updated = await this.updateLead(leadId, {
      ...qualification.patch,
      summary: qualification.summary,
      next_action: qualification.recommended_next_action,
      owner: qualification.qualification_status === "qualified" ? "sales_agent" : undefined,
    });
    if (!updated) return null;
    await this.appendTimelineEvent({
      lead_id: leadId,
      event_type: "lead_qualified",
      actor: "oma",
      title: "Lead qualified",
      body: qualification.summary,
      metadata: qualification,
    });
    return updated;
  }

  async listPartners() {
    return [...(this.state.partners || [])].sort((a, b) =>
      String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at))
    );
  }

  async createPartner(input) {
    const partner = {
      id: crypto.randomUUID(),
      ...normalizePartner(input),
      created_at: this.nowIso(),
      updated_at: this.nowIso(),
    };
    this.state.partners.push(partner);
    await this.persist();
    return partner;
  }

  async listDeploymentProjects() {
    return [...(this.state.deployment_projects || [])].sort((a, b) =>
      String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at))
    );
  }

  async createDeploymentProject(input) {
    const lead = input.lead_id ? await this.getLead(input.lead_id) : null;
    const project = {
      id: crypto.randomUUID(),
      ...buildDeploymentFromLead(lead || {}, input),
      created_at: this.nowIso(),
      updated_at: this.nowIso(),
    };
    this.state.deployment_projects.push(project);
    if (project.lead_id) {
      await this.appendTimelineEvent({
        lead_id: project.lead_id,
        event_type: "deployment_project_created",
        actor: input.actor || "office",
        title: "Deployment project created",
        body: project.property_name || project.customer_name || "Deployment project created.",
        metadata: project,
      });
    }
    await this.persist();
    return project;
  }

  async createFacilityWorkspace(input) {
    const lead = input.lead_id ? await this.getLead(input.lead_id) : null;
    const workspace = {
      id: crypto.randomUUID(),
      lead_id: input.lead_id || null,
      portfolio_id: input.portfolio_id || null,
      customer_organization: input.customer_organization || lead?.company || lead?.name || "",
      estate_name: input.estate_name || input.property_name || lead?.company || "",
      facility_admin_email: input.facility_admin_email || lead?.email || "",
      facility_admin_full_name: input.facility_admin_full_name || "",
      facility_admin_phone: input.facility_admin_phone || "",
      status: "pending_manual_provisioning",
      activation_link: input.activation_link || "",
      checklist: {
        customer_organization: "ready_to_create",
        estate_or_building_record: "ready_to_create",
        facility_admin_invite: input.facility_admin_email || lead?.email ? "ready_to_send" : "needs_email",
        deployment_project: "ready_to_link",
        onboarding_email: "ready_to_send",
      },
      notes: input.notes || "Manual approval required before provisioning live Facility workspace.",
      created_at: this.nowIso(),
      updated_at: this.nowIso(),
    };
    this.state.facility_workspaces.push(workspace);
    if (workspace.lead_id) {
      await this.updateLead(workspace.lead_id, {
        stage: "commercial_approved",
        commercial_stage: "commercial_approved",
        next_action: "Create or approve Facility workspace",
      });
      await this.appendTimelineEvent({
        lead_id: workspace.lead_id,
        event_type: "facility_workspace_prepared",
        actor: input.actor || "office",
        title: "Facility workspace prepared",
        body: "Manual provisioning checklist created.",
        metadata: workspace,
      });
    }
    await this.persist();
    return workspace;
  }

  async listFacilityWorkspaces() {
    return [...(this.state.facility_workspaces || [])].sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at))
    );
  }

  // Office->Facility provisioning lifecycle -- Portfolio detail needs the
  // linked workspace's status/checklist/activation state alongside the
  // live Backend projection (requirement #14's resend/revoke/status UI).
  async listFacilityWorkspacesByPortfolioIds(portfolioIds) {
    const ids = new Set((portfolioIds || []).map((id) => String(id)));
    return (this.state.facility_workspaces || []).filter((w) => w.portfolio_id && ids.has(String(w.portfolio_id)));
  }

  async updateFacilityWorkspace(workspaceId, patch) {
    const workspace = this.state.facility_workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return null;
    Object.assign(workspace, patch, { updated_at: this.nowIso() });
    await this.persist();
    return workspace;
  }

  // Governed Portfolio delete -- removes Office's own bookkeeping row for
  // an abandoned/failed provisioning attempt. Never called until Backend
  // has already confirmed (or the attempt never reached Backend at all)
  // that no real Facility operational state exists.
  async deleteFacilityWorkspace(workspaceId) {
    const index = this.state.facility_workspaces.findIndex((item) => item.id === workspaceId);
    if (index < 0) return false;
    this.state.facility_workspaces.splice(index, 1);
    await this.persist();
    return true;
  }

  async getLeadChannelState(leadId, channel) {
    return (
      this.state.lead_channel_states.find(
        (item) => item.lead_id === leadId && item.channel === channel
      ) || null
    );
  }

  async upsertLeadChannelState(leadId, channel, patch) {
    const index = this.state.lead_channel_states.findIndex(
      (item) => item.lead_id === leadId && item.channel === channel
    );
    const value = {
      id:
        index === -1
          ? crypto.randomUUID()
          : this.state.lead_channel_states[index].id,
      lead_id: leadId,
      channel,
      ai_paused: patch.ai_paused ?? (index === -1 ? false : this.state.lead_channel_states[index].ai_paused),
      human_owner: patch.human_owner ?? (index === -1 ? "" : this.state.lead_channel_states[index].human_owner),
      human_status: patch.human_status || (index === -1 ? "auto" : this.state.lead_channel_states[index].human_status),
      takeover_started_at:
        patch.takeover_started_at ?? (index === -1 ? null : this.state.lead_channel_states[index].takeover_started_at),
      takeover_reason:
        patch.takeover_reason ?? (index === -1 ? "" : this.state.lead_channel_states[index].takeover_reason),
      resume_mode: patch.resume_mode || (index === -1 ? "manual_only" : this.state.lead_channel_states[index].resume_mode),
      customer_service_window_expires_at:
        patch.customer_service_window_expires_at ??
        (index === -1
          ? null
          : this.state.lead_channel_states[index].customer_service_window_expires_at),
      last_external_message_id:
        patch.last_external_message_id ??
        (index === -1 ? "" : this.state.lead_channel_states[index].last_external_message_id),
      last_inbound_at:
        patch.last_inbound_at ?? (index === -1 ? null : this.state.lead_channel_states[index].last_inbound_at),
      last_outbound_at:
        patch.last_outbound_at ?? (index === -1 ? null : this.state.lead_channel_states[index].last_outbound_at),
      created_at: index === -1 ? this.nowIso() : this.state.lead_channel_states[index].created_at,
      updated_at: this.nowIso(),
    };
    if (index === -1) {
      this.state.lead_channel_states.push(value);
    } else {
      this.state.lead_channel_states[index] = value;
    }
    await this.persist();
    return value;
  }

  async appendInboundEvent(input) {
    const event = {
      id: crypto.randomUUID(),
      channel: input.channel,
      provider: input.provider,
      event_type: input.event_type,
      lead_id: input.lead_id || null,
      external_event_id: input.external_event_id || "",
      payload: input.payload || {},
      created_at: this.nowIso(),
    };
    this.state.inbound_events.push(event);
    await this.persist();
    return event;
  }

  async createNotification(input) {
    const notification = {
      id: crypto.randomUUID(),
      lead_id: input.lead_id || null,
      type: input.type || "internal",
      urgency: input.urgency || "medium",
      reason: input.reason || "",
      summary: input.summary || "",
      delivered: Boolean(input.delivered),
      channel: input.channel || "internal",
      response_code: input.response_code || null,
      status: input.status || "open",
      metadata: input.metadata || {},
      recipient_email: input.recipient_email || null,
      read_at: null,
      related_type: input.related_type || null,
      related_id: input.related_id || null,
      created_at: this.nowIso(),
      updated_at: this.nowIso(),
    };

    this.state.notifications.push(notification);
    if (notification.lead_id) {
      await this.appendTimelineEvent({
        lead_id: notification.lead_id,
        event_type: "notification",
        actor: notification.channel,
        title: notification.type,
        body: notification.summary || notification.reason,
        metadata: notification.metadata,
      });
    }
    await this.persist();
    return notification;
  }

  async listNotifications(limit = 100, filter = {}) {
    return this.state.notifications
      .filter((item) => {
        if (filter.status && item.status !== filter.status) return false;
        if (filter.type && item.type !== filter.type) return false;
        if (filter.lead_id && item.lead_id !== filter.lead_id) return false;
        // forRecipient: rows targeted at this person, plus every
        // broadcast row (recipient_email null) — never someone else's.
        if (filter.forRecipient && item.recipient_email && item.recipient_email !== filter.forRecipient) return false;
        if (filter.unreadOnly && item.read_at) return false;
        return true;
      })
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);
  }

  async getNotificationById(notificationId) {
    return this.state.notifications.find((item) => item.id === notificationId) || null;
  }

  async updateNotification(notificationId, patch) {
    const index = this.state.notifications.findIndex((item) => item.id === notificationId);
    if (index === -1) return null;
    const updated = {
      ...this.state.notifications[index],
      ...patch,
      updated_at: this.nowIso(),
    };
    this.state.notifications[index] = updated;
    await this.persist();
    return updated;
  }

  // ---------------------------------------------------------------
  // Staff messaging (Phase 5) — staff-to-staff only, keyed by email
  // like the rest of admin_users/RBAC. Deliberately separate from the
  // CRM `conversations` table (AI agent <-> public lead chat).
  // ---------------------------------------------------------------
  async createStaffConversation({ type, title, createdBy, participantEmails }) {
    const conversation = {
      id: crypto.randomUUID(),
      type: type === "group" ? "group" : "direct",
      title: title || null,
      created_by: createdBy,
      last_message_at: null,
      created_at: this.nowIso(),
      updated_at: this.nowIso(),
    };
    this.state.staff_conversations.push(conversation);
    const emails = Array.from(new Set([...(participantEmails || []), createdBy].map((e) => normalizeEmail(e)).filter(Boolean)));
    emails.forEach((email) => {
      this.state.staff_conversation_participants.push({
        id: crypto.randomUUID(),
        conversation_id: conversation.id,
        staff_email: email,
        joined_at: this.nowIso(),
      });
    });
    await this.persist();
    return conversation;
  }

  async listStaffConversationParticipants(conversationId) {
    return this.state.staff_conversation_participants.filter((item) => item.conversation_id === conversationId);
  }

  async isStaffConversationParticipant(conversationId, email) {
    const normalized = normalizeEmail(email);
    return this.state.staff_conversation_participants.some((item) => item.conversation_id === conversationId && item.staff_email === normalized);
  }

  async findDirectStaffConversation(emailA, emailB) {
    const a = normalizeEmail(emailA);
    const b = normalizeEmail(emailB);
    const direct = this.state.staff_conversations.filter((item) => item.type === "direct");
    for (const conversation of direct) {
      const participants = this.state.staff_conversation_participants.filter((item) => item.conversation_id === conversation.id).map((item) => item.staff_email);
      if (participants.length === 2 && participants.includes(a) && participants.includes(b)) return conversation;
    }
    return null;
  }

  async listStaffConversationsForStaff(email) {
    const normalized = normalizeEmail(email);
    const conversationIds = new Set(
      this.state.staff_conversation_participants.filter((item) => item.staff_email === normalized).map((item) => item.conversation_id)
    );
    return this.state.staff_conversations
      .filter((item) => conversationIds.has(item.id))
      .sort((a, b) => String(b.last_message_at || b.created_at).localeCompare(String(a.last_message_at || a.created_at)));
  }

  async getStaffConversationById(conversationId) {
    return this.state.staff_conversations.find((item) => item.id === conversationId) || null;
  }

  async createStaffMessage({ conversationId, senderEmail, body, attachments }) {
    const message = {
      id: crypto.randomUUID(),
      conversation_id: conversationId,
      sender_email: normalizeEmail(senderEmail),
      body: body || "",
      created_at: this.nowIso(),
    };
    this.state.staff_messages.push(message);
    const conversation = this.state.staff_conversations.find((item) => item.id === conversationId);
    if (conversation) {
      conversation.last_message_at = message.created_at;
      conversation.updated_at = message.created_at;
    }
    const attachmentRows = (attachments || []).map((att) => ({
      id: crypto.randomUUID(),
      message_id: message.id,
      file_id: att.file_id || null,
      file_url: att.file_url,
      filename: att.filename || null,
      mime_type: att.mime_type || null,
      size_bytes: att.size_bytes || null,
      created_at: message.created_at,
    }));
    this.state.staff_message_attachments.push(...attachmentRows);
    // The sender has implicitly seen their own message.
    this.state.staff_message_reads.push({
      id: crypto.randomUUID(),
      message_id: message.id,
      staff_email: message.sender_email,
      read_at: message.created_at,
    });
    await this.persist();
    return { ...message, attachments: attachmentRows };
  }

  async listStaffMessages(conversationId, limit = 200) {
    const messages = this.state.staff_messages
      .filter((item) => item.conversation_id === conversationId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .slice(-limit);
    return messages.map((message) => ({
      ...message,
      attachments: this.state.staff_message_attachments.filter((att) => att.message_id === message.id),
    }));
  }

  async markStaffMessagesRead(conversationId, email) {
    const normalized = normalizeEmail(email);
    const messages = this.state.staff_messages.filter((item) => item.conversation_id === conversationId);
    const now = this.nowIso();
    let created = 0;
    messages.forEach((message) => {
      const alreadyRead = this.state.staff_message_reads.some((r) => r.message_id === message.id && r.staff_email === normalized);
      if (!alreadyRead) {
        this.state.staff_message_reads.push({ id: crypto.randomUUID(), message_id: message.id, staff_email: normalized, read_at: now });
        created += 1;
      }
    });
    if (created) await this.persist();
    return created;
  }

  async countUnreadStaffMessages(conversationId, email) {
    const normalized = normalizeEmail(email);
    const messages = this.state.staff_messages.filter((item) => item.conversation_id === conversationId && item.sender_email !== normalized);
    return messages.filter((message) => !this.state.staff_message_reads.some((r) => r.message_id === message.id && r.staff_email === normalized)).length;
  }

  // ---------------------------------------------------------------
  // Content / Publishing (Phase 8) — Office's local editorial workflow
  // record. Sanity holds the real content; this is workflow/audit
  // metadata plus a text working copy so drafts survive even if Sanity
  // is unreachable when a writer is working.
  // ---------------------------------------------------------------
  async createContentItem(input) {
    const item = {
      id: crypto.randomUUID(),
      title: input.title || "Untitled",
      slug: input.slug || "",
      excerpt: input.excerpt || "",
      category: input.category || "",
      author: input.author || "",
      tags: Array.isArray(input.tags) ? input.tags : [],
      body: input.body || "",
      featured_image_url: input.featured_image_url || "",
      seo_title: input.seo_title || "",
      seo_description: input.seo_description || "",
      workflow_status: "draft",
      scheduled_publish_at: null,
      sanity_document_id: null,
      sanity_live_url: null,
      created_by: input.created_by || "office",
      reviewed_by: null,
      approved_by: null,
      published_by: null,
      metadata: input.metadata || {},
      created_at: this.nowIso(),
      updated_at: this.nowIso(),
    };
    this.state.office_content_items.push(item);
    await this.persist();
    return item;
  }

  async listContentItems(filter = {}) {
    return this.state.office_content_items
      .filter((item) => !filter.status || item.workflow_status === filter.status)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  async getContentItemById(id) {
    return this.state.office_content_items.find((item) => item.id === id) || null;
  }

  async updateContentItem(id, patch) {
    const index = this.state.office_content_items.findIndex((item) => item.id === id);
    if (index === -1) return null;
    this.state.office_content_items[index] = {
      ...this.state.office_content_items[index],
      ...patch,
      updated_at: this.nowIso(),
    };
    await this.persist();
    return this.state.office_content_items[index];
  }

  async listScheduledContentDue(now) {
    return this.state.office_content_items.filter(
      (item) => item.workflow_status === "scheduled" && item.scheduled_publish_at && new Date(item.scheduled_publish_at).getTime() <= now.getTime()
    );
  }

  async createOfficeReport(input) {
    const report = {
      id: crypto.randomUUID(),
      title: input.title || "Untitled Report",
      body: input.body || "",
      related_type: input.related_type || "",
      related_id: input.related_id || "",
      author: input.author || "office",
      status: "submitted",
      reviewer: null,
      decision_note: null,
      decided_at: null,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      created_at: this.nowIso(),
      updated_at: this.nowIso(),
    };
    this.state.office_reports.push(report);
    await this.persist();
    return report;
  }

  async listOfficeReports(filter = {}) {
    return this.state.office_reports
      .filter((r) => !filter.status || r.status === filter.status)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  async getOfficeReportById(id) {
    return this.state.office_reports.find((r) => r.id === id) || null;
  }

  async updateOfficeReport(id, patch) {
    const index = this.state.office_reports.findIndex((r) => r.id === id);
    if (index === -1) return null;
    this.state.office_reports[index] = {
      ...this.state.office_reports[index],
      ...patch,
      updated_at: this.nowIso(),
    };
    await this.persist();
    return this.state.office_reports[index];
  }

  async createDevelopmentProject(input) {
    const project = {
      id: crypto.randomUUID(),
      name: input.name || "Untitled Project",
      slug: input.slug || "",
      type_line: input.type_line || "",
      location: input.location || "",
      status: input.status || "",
      one_liner: input.one_liner || "",
      status_stages: Array.isArray(input.status_stages) ? input.status_stages : [],
      status_active_index: Number.isFinite(input.status_active_index) ? input.status_active_index : 0,
      display_order: Number.isFinite(input.display_order) ? input.display_order : 0,
      cover_image_url: input.cover_image_url || null,
      cover_image_alt: input.cover_image_alt || null,
      sanity_document_id: null,
      published: false,
      created_by: input.created_by || "office",
      created_at: this.nowIso(),
      updated_at: this.nowIso(),
    };
    this.state.office_development_projects.push(project);
    await this.persist();
    return project;
  }

  async listDevelopmentProjects() {
    return [...this.state.office_development_projects].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getDevelopmentProjectById(id) {
    return this.state.office_development_projects.find((p) => p.id === id) || null;
  }

  async updateDevelopmentProject(id, patch) {
    const index = this.state.office_development_projects.findIndex((p) => p.id === id);
    if (index === -1) return null;
    this.state.office_development_projects[index] = {
      ...this.state.office_development_projects[index],
      ...patch,
      updated_at: this.nowIso(),
    };
    await this.persist();
    return this.state.office_development_projects[index];
  }

  async appendTrace(input) {
    const trace = {
      id: crypto.randomUUID(),
      trace_id: input.trace_id || "",
      lead_id: input.lead_id || null,
      type: input.type,
      agent: input.agent || "",
      tool_name: input.tool_name || "",
      request_id: input.request_id || "",
      source: input.source || "",
      payload: input.payload || {},
      created_at: this.nowIso(),
    };
    this.state.traces.push(trace);
    if (trace.lead_id) {
      await this.appendTimelineEvent({
        lead_id: trace.lead_id,
        event_type: "trace",
        actor: trace.agent || "system",
        title: trace.type,
        body: trace.tool_name || "",
        metadata: trace.payload,
      });
    }
    await this.persist();
    return trace;
  }

  async listTraces(limit = 200, filter = {}) {
    return this.state.traces
      .filter((item) => {
        if (filter.lead_id && item.lead_id !== filter.lead_id) return false;
        if (filter.trace_id && item.trace_id !== filter.trace_id) return false;
        return true;
      })
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);
  }

  async getLeadMemory(leadId) {
    return this.state.lead_memories.find((item) => item.lead_id === leadId) || null;
  }

  async upsertLeadMemory(leadId, memory) {
    const index = this.state.lead_memories.findIndex((item) => item.lead_id === leadId);
    const value = {
      lead_id: leadId,
      known_fields: memory.known_fields || {},
      need_signals: memory.need_signals || [],
      open_questions: memory.open_questions || [],
      keywords: memory.keywords || [],
      last_user_message: memory.last_user_message || "",
      last_agent_message: memory.last_agent_message || "",
      last_status: memory.last_status || "",
      last_owner: memory.last_owner || "",
      last_summary: memory.last_summary || "",
      tool_calls: memory.tool_calls || [],
      updated_at: this.nowIso(),
    };

    if (index === -1) {
      this.state.lead_memories.push(value);
    } else {
      this.state.lead_memories[index] = value;
    }
    await this.persist();
    return value;
  }

  async listTimelineForLead(leadId, limit = 200) {
    return this.state.timeline_events
      .filter((item) => item.lead_id === leadId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .slice(-limit);
  }

  async ensureAdminUser(input) {
    const email = normalizeEmail(input.email);
    const index = this.state.admin_users.findIndex((item) => item.email === email);
    if (index === -1) {
      const adminUser = {
        id: crypto.randomUUID(),
        email,
        password_hash: input.password_hash,
        role: input.role || "admin",
        status: input.status || "active",
        display_name: input.display_name || "",
        office_position: input.office_position || "",
        phone: input.phone || "",
        passport_photo_url: input.passport_photo_url || "",
        qr_credential: input.qr_credential || "",
        permission_scopes: Array.isArray(input.permission_scopes) ? input.permission_scopes : [],
        last_login_at: input.last_login_at || null,
        password_changed_at: input.password_changed_at || null,
        created_at: this.nowIso(),
        updated_at: this.nowIso(),
      };
      this.state.admin_users.push(adminUser);
      await this.persist();
      return adminUser;
    }
    return this.state.admin_users[index];
  }

  async getAdminUserByEmail(email) {
    const normalizedEmail = normalizeEmail(email);
    return this.state.admin_users.find((item) => item.email === normalizedEmail) || null;
  }

  async getAdminUserById(userId) {
    return this.state.admin_users.find((item) => item.id === userId) || null;
  }

  async listAdminUsers() {
    return [...this.state.admin_users].sort((a, b) => a.email.localeCompare(b.email));
  }

  async updateAdminUser(userId, patch) {
    const index = this.state.admin_users.findIndex((item) => item.id === userId);
    if (index === -1) {
      return null;
    }
    this.state.admin_users[index] = {
      ...this.state.admin_users[index],
      ...patch,
      updated_at: this.nowIso(),
    };
    await this.persist();
    return this.state.admin_users[index];
  }

  async createAdminInvite(input) {
    const invite = {
      id: crypto.randomUUID(),
      admin_user_id: input.admin_user_id || null,
      email: normalizeEmail(input.email),
      role: input.role || "viewer",
      display_name: input.display_name || "",
      office_position: input.office_position || "",
      phone: input.phone || "",
      token_hash: input.token_hash,
      status: input.status || "pending",
      invited_by: input.invited_by || "",
      expires_at: input.expires_at,
      accepted_at: input.accepted_at || null,
      created_at: this.nowIso(),
      updated_at: this.nowIso(),
    };
    this.state.admin_invites.push(invite);
    await this.persist();
    return invite;
  }

  async getAdminInviteByTokenHash(tokenHash) {
    return this.state.admin_invites.find((item) => item.token_hash === tokenHash) || null;
  }

  async updateAdminInvite(inviteId, patch) {
    const index = this.state.admin_invites.findIndex((item) => item.id === inviteId);
    if (index === -1) return null;
    this.state.admin_invites[index] = {
      ...this.state.admin_invites[index],
      ...patch,
      updated_at: this.nowIso(),
    };
    await this.persist();
    return this.state.admin_invites[index];
  }

  async listAdminInvites() {
    return [...this.state.admin_invites].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async createPasswordResetToken(input) {
    const token = {
      id: crypto.randomUUID(),
      admin_user_id: input.admin_user_id || null,
      email: normalizeEmail(input.email),
      token_hash: input.token_hash,
      status: input.status || "pending",
      requested_by: input.requested_by || "",
      expires_at: input.expires_at,
      used_at: input.used_at || null,
      created_at: this.nowIso(),
      updated_at: this.nowIso(),
    };
    this.state.password_reset_tokens.push(token);
    await this.persist();
    return token;
  }

  async getPasswordResetTokenByHash(tokenHash) {
    return this.state.password_reset_tokens.find((item) => item.token_hash === tokenHash) || null;
  }

  async updatePasswordResetToken(tokenId, patch) {
    const index = this.state.password_reset_tokens.findIndex((item) => item.id === tokenId);
    if (index === -1) return null;
    this.state.password_reset_tokens[index] = {
      ...this.state.password_reset_tokens[index],
      ...patch,
      updated_at: this.nowIso(),
    };
    await this.persist();
    return this.state.password_reset_tokens[index];
  }

  async appendAuditEvent(input) {
    const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
    const event = {
      id: crypto.randomUUID(),
      actor_user_id: input.actor_user_id || null,
      actor_id: input.actor_user_id || null,
      actor_email: input.actor_email || "",
      actor_role: input.actor_role || "",
      action: input.action,
      target_type: input.target_type,
      target_id: input.target_id || "",
      resource_type: input.resource_type || input.target_type,
      resource_id: input.resource_id || input.target_id || "",
      estate_id: input.estate_id || metadata.estate_id || null,
      status: input.status || metadata.status || "success",
      ip: input.ip || metadata.ip || "",
      user_agent: input.user_agent || metadata.user_agent || "",
      metadata,
      created_at: this.nowIso(),
    };
    this.state.audit_events.push(event);
    await this.persist();
    return event;
  }

  async listAuditEvents(limit = 200) {
    return [...this.state.audit_events]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);
  }

  async listOfficePackages() {
    return [...this.state.office_packages].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async listOfficeEstates() {
    return [...this.state.office_estates].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async listOfficeBuildings() {
    return [...this.state.office_buildings].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async listOfficeHomes() {
    return [...this.state.office_homes].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async listOfficeDevices() {
    return [...this.state.office_devices].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async listOfficeWallets() {
    return [...this.state.office_wallets].sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }

  async listOfficeAnalytics() {
    return [...this.state.office_analytics].sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }

  async listOfficeSupportMappings() {
    return [...this.state.office_support_mappings].sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || ""))
    );
  }

  async listOfficeDocuments() {
    return [...this.state.office_documents].sort((a, b) =>
      String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || ""))
    );
  }

  async getOfficeDocumentById(id) {
    return this.state.office_documents.find((doc) => doc.id === id) || null;
  }

  async createOfficeFile(input) {
    const file = {
      id: input.id,
      storage_driver: input.storage_driver || "local",
      storage_key: input.storage_key || input.filename || "",
      filename: input.filename || "",
      mime_type: input.mime_type || "application/octet-stream",
      size: Number(input.size || 0),
      purpose: input.purpose || "document",
      resource_type: input.resource_type || "",
      resource_id: input.resource_id || "",
      url: input.url || "",
      metadata: input.metadata || {},
      created_at: input.created_at || this.nowIso(),
    };
    this.state.office_files.push(file);
    await this.persist();
    return file;
  }

  async listOfficeFiles(limit = 200) {
    return [...(this.state.office_files || [])]
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
      .slice(0, limit);
  }

  async updateOfficeAsset(kind, id, patch) {
    const map = {
      estate: "office_estates",
      building: "office_buildings",
      device: "office_devices",
    };
    const stateKey = map[String(kind || "").toLowerCase()];
    if (!stateKey || !id) return null;
    const index = this.state[stateKey].findIndex((item) => String(item.id) === String(id));
    if (index === -1) return null;
    this.state[stateKey][index] = {
      ...this.state[stateKey][index],
      ...patch,
      metadata: {
        ...(this.state[stateKey][index].metadata || {}),
        ...(patch.metadata || {}),
      },
      updated_at: this.nowIso(),
    };
    await this.persist();
    return this.state[stateKey][index];
  }

  async createOfficeDocument(input) {
    const nowIso = this.nowIso();
    const document = {
      id: input.id || crypto.randomUUID(),
      title: input.title,
      document_type: input.document_type || input.type || "document",
      status: input.status || "draft",
      owner: input.owner || "",
      related_type: input.related_type || "",
      related_id: input.related_id || "",
      amount: Number(input.amount || input.value || 0),
      currency: input.currency || "NGN",
      file_url: input.file_url || "",
      html_url: input.html_url || "",
      email_to: input.email_to || "",
      share_token: input.share_token || "",
      folder_id: input.folder_id || null,
      body: input.body || null,
      metadata: input.metadata || {},
      created_at: input.created_at || nowIso,
      updated_at: nowIso,
    };
    this.state.office_documents.push(document);
    await this.persist();
    return document;
  }

  async deleteOfficeDocument(id) {
    const index = this.state.office_documents.findIndex((doc) => doc.id === id);
    if (index === -1) return false;
    this.state.office_documents.splice(index, 1);
    await this.persist();
    return true;
  }

  async deleteOfficeFile(id) {
    const index = this.state.office_files.findIndex((file) => file.id === id);
    if (index === -1) return false;
    this.state.office_files.splice(index, 1);
    await this.persist();
    return true;
  }

  async listOfficeFilesByResource(resourceType, resourceId) {
    return this.state.office_files.filter((f) => f.resource_type === resourceType && f.resource_id === resourceId);
  }

  async listOfficeFilesByResourceType(resourceType) {
    return this.state.office_files.filter((f) => f.resource_type === resourceType).map((f) => ({ size: f.size }));
  }

  async listOfficeDocumentFolders() {
    return [...this.state.office_document_folders].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  }

  async createOfficeDocumentFolder(input) {
    const nowIso = this.nowIso();
    const folder = {
      id: input.id || crypto.randomUUID(),
      name: input.name,
      created_by: input.created_by || "",
      created_at: nowIso,
      updated_at: nowIso,
    };
    this.state.office_document_folders.push(folder);
    await this.persist();
    return folder;
  }

  async getOfficeDocumentFolderById(id) {
    return this.state.office_document_folders.find((folder) => folder.id === id) || null;
  }

  async renameOfficeDocumentFolder(id, name) {
    const folder = this.state.office_document_folders.find((f) => f.id === id);
    if (!folder) return null;
    folder.name = name;
    folder.updated_at = this.nowIso();
    await this.persist();
    return folder;
  }

  async deleteOfficeDocumentFolder(id) {
    const index = this.state.office_document_folders.findIndex((folder) => folder.id === id);
    if (index === -1) return false;
    this.state.office_document_folders.splice(index, 1);
    await this.persist();
    return true;
  }

  async upsertOfficeCollections(input) {
    const collections = input || {};
    const collectionMap = {
      packages: "office_packages",
      estates: "office_estates",
      buildings: "office_buildings",
      homes: "office_homes",
      devices: "office_devices",
      wallets: "office_wallets",
      analytics: "office_analytics",
      documents: "office_documents",
      support_mappings: "office_support_mappings",
    };

    Object.entries(collectionMap).forEach(([key, stateKey]) => {
      const rows = Array.isArray(collections[key]) ? collections[key] : null;
      if (!rows) return;
      const existing = Array.isArray(this.state[stateKey]) ? this.state[stateKey] : [];
      const merged = new Map(existing.map((item) => [String(item.id), item]));
      rows.forEach((row) => {
        if (!row || !row.id) return;
        merged.set(String(row.id), {
          ...(merged.get(String(row.id)) || {}),
          ...row,
          updated_at: row.updated_at || this.nowIso(),
        });
      });
      this.state[stateKey] = Array.from(merged.values());
    });

    await this.persist();
    return this.getOfficeSnapshot();
  }

  async getOfficeSnapshot() {
    const [report, leads, notifications, adminUsers, audit, traces] = await Promise.all([
      this.getReportingSummary(),
      this.listLeads(),
      this.listNotifications(500),
      this.listAdminUsers(),
      this.listAuditEvents(200),
      this.listTraces(200),
    ]);
    return buildOfficeSnapshot({
      packages: this.state.office_packages,
      estates: this.state.office_estates,
      buildings: this.state.office_buildings,
      homes: this.state.office_homes,
      devices: this.state.office_devices,
      wallets: this.state.office_wallets,
      analytics: this.state.office_analytics,
      documents: this.state.office_documents,
      support_mappings: this.state.office_support_mappings,
      leads,
      report,
      notifications,
      adminUsers,
      audit,
      traces,
    });
  }

  async getReportingSummary() {
    const leads = await this.listLeads();
    const demos = this.state.demos;
    const notifications = this.state.notifications;
    const totalLeads = leads.length || 1;
    const salesReady = leads.filter((lead) => ["sales", "booked", "closed"].includes(lead.status)).length;
    const scoredLeads = leads.filter((lead) => Number.isFinite(Number(lead.score)) && Number(lead.score) > 0);
    const hotLeads = leads.filter((lead) => Number(lead.score || 0) >= 70).length;
    const upcomingDemos = demos
      .filter((demo) => demo.scheduled_for)
      .sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)))
      .slice(0, 5);

    return {
      totals: {
        leads: leads.length,
        demos: demos.length,
        escalations: notifications.filter((item) => item.type === "founder_escalation").length,
        sales_handoff_conversion_pct: Math.round((salesReady / totalLeads) * 100),
        hot_leads: hotLeads,
        average_score: scoredLeads.length
          ? Math.round(
              scoredLeads.reduce((sum, lead) => sum + Number(lead.score || 0), 0) /
                scoredLeads.length
            )
          : 0,
      },
      by_source: leads.reduce((acc, lead) => {
        const key = lead.source || "unknown";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      by_status: leads.reduce((acc, lead) => {
        const key = lead.status || "new";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      by_owner: leads.reduce((acc, lead) => {
        const key = lead.owner || "unassigned";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      by_commercial_stage: leads.reduce((acc, lead) => {
        const key = lead.stage || lead.commercial_stage || "unassigned";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      demos_booked: demos.filter((demo) => ["requested", "pending", "confirmed"].includes(demo.status)).length,
      demos_confirmed: demos.filter((demo) => demo.status === "confirmed").length,
      upcoming_demos: upcomingDemos,
      proposals_total: this.state.proposals.length,
      proposals_sent: this.state.proposals.filter((item) => ["sent", "accepted"].includes(item.status)).length,
      deals_won: leads.filter((lead) => (lead.stage || lead.commercial_stage) === "won").length,
      deals_lost: leads.filter((lead) => (lead.stage || lead.commercial_stage) === "lost").length,
    };
  }

  async stats() {
    return {
      leads: this.state.leads.length,
      conversations: this.state.conversations.length,
      demos: this.state.demos.length,
      proposals: this.state.proposals.length,
      notifications: this.state.notifications.length,
      traces: this.state.traces.length,
      admin_users: this.state.admin_users.length,
      audit_events: this.state.audit_events.length,
      estates: this.state.office_estates.length,
      packages: this.state.office_packages.length,
      buildings: this.state.office_buildings.length,
      homes: this.state.office_homes.length,
      devices: this.state.office_devices.length,
      wallets: this.state.office_wallets.length,
      analytics: this.state.office_analytics.length,
      support_mappings: this.state.office_support_mappings.length,
    };
  }
}

module.exports = {
  FileLeadAgentsStore,
};
