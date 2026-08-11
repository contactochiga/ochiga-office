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
      office_support_mappings: [],
      office_files: [],
      partners: [],
      deployment_projects: [],
      facility_workspaces: [],
      onboarding_emails: [],
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
        office_support_mappings: Array.isArray(parsed.office_support_mappings)
          ? parsed.office_support_mappings
          : [],
        office_files: Array.isArray(parsed.office_files) ? parsed.office_files : [],
        partners: Array.isArray(parsed.partners) ? parsed.partners : [],
        deployment_projects: Array.isArray(parsed.deployment_projects) ? parsed.deployment_projects : [],
        facility_workspaces: Array.isArray(parsed.facility_workspaces) ? parsed.facility_workspaces : [],
        onboarding_emails: Array.isArray(parsed.onboarding_emails) ? parsed.onboarding_emails : [],
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
      customer_organization: input.customer_organization || lead?.company || lead?.name || "",
      estate_name: input.estate_name || input.property_name || lead?.company || "",
      facility_admin_email: input.facility_admin_email || lead?.email || "",
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
        return true;
      })
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);
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
      email: normalizeEmail(input.email),
      role: input.role || "viewer",
      display_name: input.display_name || "",
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
      metadata: input.metadata || {},
      created_at: input.created_at || nowIso,
      updated_at: nowIso,
    };
    this.state.office_documents.push(document);
    await this.persist();
    return document;
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
