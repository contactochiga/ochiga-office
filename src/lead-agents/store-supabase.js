const axios = require("axios");
const crypto = require("crypto");
const { normalizeEmail, normalizeLeadInput, normalizeLeadPatch, normalizeText } = require("./normalize-lead");
const { buildDeploymentFromLead, normalizePartner } = require("./commercial-ops");
const { buildOfficeSnapshot, createOfficeSeedData } = require("./office-data");

class SupabaseLeadAgentsStore {
  constructor({ url, serviceRoleKey, requestTimeoutMs }) {
    this.url = String(url || "").replace(/\/$/, "");
    this.requestTimeoutMs = requestTimeoutMs;
    this.client = axios.create({
      baseURL: `${this.url}/rest/v1`,
      timeout: requestTimeoutMs,
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
      },
    });
  }

  async init() {}

  selectHeaders() {
    return {
      Prefer: "return=representation",
    };
  }

  async safeGet(pathname) {
    try {
      const response = await this.client.get(pathname);
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      const status = error?.response?.status;
      if (status === 400 || status === 404 || status === 406) {
        return [];
      }
      throw error;
    }
  }

  async upsertRows(tableName, rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return [];
    }
    const response = await this.client.post(`/${tableName}`, rows, {
      headers: {
        ...this.selectHeaders(),
        Prefer: "resolution=merge-duplicates,return=representation",
      },
    });
    return Array.isArray(response.data) ? response.data : [];
  }

  normalizeLead(row) {
    if (!row) return null;
    return {
      ...row,
      name: row.name || "",
      company: row.company || "",
      role: row.role || "",
      email: row.email || "",
      phone: row.phone || "",
      whatsapp_phone: row.whatsapp_phone || "",
      primary_channel: row.primary_channel || "",
      channel_last_seen_at: row.channel_last_seen_at || "",
      location: row.location || "",
      unit_count:
        row.unit_count === undefined || row.unit_count === null ? null : Number(row.unit_count),
      project_type: row.project_type || "",
      property_type: row.property_type || row.project_type || "",
      source_channel: row.source_channel || row.primary_channel || row.source || "",
      business_unit: row.business_unit ?? null,
      inquiry_type: row.inquiry_type ?? null,
      city: row.city || "",
      country: row.country || "",
      property_size: row.property_size || "",
      number_of_units:
        row.number_of_units === undefined || row.number_of_units === null ? null : Number(row.number_of_units),
      pain_points: row.pain_points || "",
      budget_range: row.budget_range || "",
      timeline: row.timeline || "",
      decision_maker_status: row.decision_maker_status || "",
      interest_package: row.interest_package || "",
      lead_score: row.lead_score === undefined || row.lead_score === null ? Number(row.score || 0) : Number(row.lead_score),
      qualification_status: row.qualification_status || "",
      stage: row.stage || row.commercial_stage || row.status || "new",
      next_action_at: row.next_action_at || null,
      last_contact_at: row.last_contact_at || null,
      notes: row.notes || "",
      summary: row.summary || "",
      next_action: row.next_action || "",
      commercial_stage: row.commercial_stage || "",
      lost_reason: row.lost_reason || "",
    };
  }

  async appendTimelineEvent(input) {
    const response = await this.client.post(
      "/timeline_events",
      {
        lead_id: input.lead_id,
        event_type: input.event_type,
        actor: input.actor || "",
        title: input.title || "",
        body: input.body || "",
        metadata: input.metadata || {},
      },
      {
        headers: this.selectHeaders(),
      }
    );
    return response.data[0];
  }

  async createLead(input) {
    const payload = {
      ...normalizeLeadInput(input, input.source),
      score: Number.isFinite(Number(input.score)) ? Number(input.score) : 0,
      status: normalizeText(input.status) || "new",
      owner: normalizeText(input.owner) || "marketing_agent",
    };

    const response = await this.client.post("/leads", payload, {
      headers: this.selectHeaders(),
    });
    const lead = this.normalizeLead(response.data[0]);
    await this.appendTimelineEvent({
      lead_id: lead.id,
      event_type: "lead_created",
      actor: lead.owner,
      title: "Lead created",
      body: lead.summary || "New lead record created.",
      metadata: {
        source: lead.source,
        primary_channel: lead.primary_channel || "",
      },
    });
    return lead;
  }

  async updateLead(leadId, patch) {
    const payload = Object.fromEntries(
      Object.entries(normalizeLeadPatch(patch)).filter(([, value]) => value !== undefined)
    );

    const response = await this.client.patch(`/leads?id=eq.${leadId}`, payload, {
      headers: this.selectHeaders(),
    });

    const lead = this.normalizeLead(response.data[0] || null);
    if (lead) {
      await this.appendTimelineEvent({
        lead_id: leadId,
        event_type: "lead_updated",
        actor: payload.owner || lead.owner || "",
        title: "Lead updated",
        body: payload.summary || payload.next_action || "Lead fields updated.",
        metadata: payload,
      });
    }
    return lead;
  }

  async getLead(leadId) {
    const response = await this.client.get(`/leads?id=eq.${leadId}&limit=1`);
    return this.normalizeLead(response.data[0] || null);
  }

  async findLeadByPhone(phone) {
    const normalized = normalizeText(phone);
    if (!normalized) return null;
    const response = await this.client.get(
      `/leads?or=(phone.eq.${encodeURIComponent(normalized)},whatsapp_phone.eq.${encodeURIComponent(normalized)})&limit=1`
    );
    return this.normalizeLead(response.data[0] || null);
  }

  async findLeadByEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const response = await this.client.get(
      `/leads?email=eq.${encodeURIComponent(normalized)}&limit=1`
    );
    return this.normalizeLead(response.data[0] || null);
  }

  async listLeads() {
    const response = await this.client.get("/leads?order=updated_at.desc");
    return response.data.map((row) => this.normalizeLead(row));
  }

  async appendConversation(input) {
    const response = await this.client.post(
      "/conversations",
      {
        lead_id: input.lead_id,
        agent_name: input.agent_name,
        message_role: input.message_role,
        channel: input.channel || "website",
        external_message_id: input.external_message_id || null,
        parent_external_message_id: input.parent_external_message_id || null,
        content: input.content,
      },
      {
        headers: this.selectHeaders(),
      }
    );
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
    return response.data[0];
  }

  async listConversationsForLead(leadId, limit = 50) {
    const response = await this.client.get(
      `/conversations?lead_id=eq.${leadId}&order=created_at.asc&limit=${limit}`
    );
    return response.data;
  }

  async createDemo(input) {
    const response = await this.client.post(
      "/demos",
      {
        lead_id: input.lead_id,
        scheduled_for: input.scheduled_for || null,
        status: input.status || "pending",
        notes: input.notes || "",
      },
      {
        headers: this.selectHeaders(),
      }
    );
    await this.appendTimelineEvent({
      lead_id: input.lead_id,
      event_type: "building_review_scheduled",
      actor: "system",
      title: "Building review scheduled",
      body: input.notes || "Building review record created.",
      metadata: response.data[0],
    });
    return response.data[0];
  }

  // Oyi Runtime Contract, Domain 3 (Task) — durable link between an
  // Office-owned record and the ochiga_workflows row it was projected
  // into on Backend. See db/lead-agents-schema.sql for the table and
  // src/lead-agents/workflow-bridge.js for the caller.
  async getWorkflowLink(recordType, recordId) {
    const response = await this.client.get(
      `/ochiga_workflow_links?record_type=eq.${encodeURIComponent(recordType)}&record_id=eq.${encodeURIComponent(recordId)}&limit=1`,
      { headers: this.selectHeaders() }
    );
    return response.data?.[0] || null;
  }

  async saveWorkflowLink(recordType, recordId, workflowId) {
    const existing = await this.getWorkflowLink(recordType, recordId);
    if (existing) return existing;
    const response = await this.client.post(
      "/ochiga_workflow_links",
      { record_type: recordType, record_id: recordId, workflow_id: workflowId },
      { headers: this.selectHeaders() }
    );
    return response.data[0];
  }

  async listDemosForLead(leadId) {
    const response = await this.client.get(
      `/demos?lead_id=eq.${leadId}&order=created_at.desc`
    );
    return response.data;
  }

  async listDemos() {
    const [demos, leads] = await Promise.all([
      this.client.get("/demos?order=created_at.desc"),
      this.listLeads(),
    ]);
    return demos.data.map((demo) => ({
      ...demo,
      lead: leads.find((lead) => lead.id === demo.lead_id) || null,
    }));
  }

  async createProposal(input) {
    const response = await this.client.post(
      "/proposals",
      {
        lead_id: input.lead_id,
        title: input.title,
        tier_name: input.tier_name || "",
        unit_count: input.unit_count === undefined ? null : input.unit_count,
        monthly_price: input.monthly_price === undefined ? null : input.monthly_price,
        currency: input.currency || "NGN",
        status: input.status || "draft",
        body: input.body,
        metadata: input.metadata || {},
      },
      {
        headers: this.selectHeaders(),
      }
    );
    const proposal = response.data[0];
    await this.appendTimelineEvent({
      lead_id: input.lead_id,
      event_type: "proposal_created",
      actor: input.actor || "system",
      title: "Proposal created",
      body: proposal.title,
      metadata: proposal,
    });
    return proposal;
  }

  async listProposalsForLead(leadId) {
    const response = await this.client.get(`/proposals?lead_id=eq.${leadId}&order=created_at.desc`);
    return response.data;
  }

  async listProposals() {
    const [proposals, leads] = await Promise.all([
      this.client.get("/proposals?order=created_at.desc"),
      this.listLeads(),
    ]);
    return proposals.data.map((proposal) => ({
      ...proposal,
      lead: leads.find((lead) => lead.id === proposal.lead_id) || null,
    }));
  }

  async getProposal(proposalId) {
    const response = await this.client.get(`/proposals?id=eq.${proposalId}&limit=1`);
    return response.data[0] || null;
  }

  async updateProposal(proposalId, patch) {
    const response = await this.client.patch(`/proposals?id=eq.${proposalId}`, patch, {
      headers: this.selectHeaders(),
    });
    return response.data[0] || null;
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
    return this.safeGet("/partners?order=updated_at.desc");
  }

  async createPartner(input) {
    const response = await this.client.post("/partners", normalizePartner(input), {
      headers: this.selectHeaders(),
    });
    return response.data[0];
  }

  async listDeploymentProjects() {
    return this.safeGet("/deployment_projects?order=updated_at.desc");
  }

  async createDeploymentProject(input) {
    const lead = input.lead_id ? await this.getLead(input.lead_id) : null;
    const response = await this.client.post(
      "/deployment_projects",
      buildDeploymentFromLead(lead || {}, input),
      { headers: this.selectHeaders() }
    );
    const project = response.data[0];
    if (project?.lead_id) {
      await this.appendTimelineEvent({
        lead_id: project.lead_id,
        event_type: "deployment_project_created",
        actor: input.actor || "office",
        title: "Deployment project created",
        body: project.property_name || project.customer_name || "Deployment project created.",
        metadata: project,
      });
    }
    return project;
  }

  async createFacilityWorkspace(input) {
    const lead = input.lead_id ? await this.getLead(input.lead_id) : null;
    const payload = {
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
    };
    const response = await this.client.post("/facility_workspaces", payload, {
      headers: this.selectHeaders(),
    });
    const workspace = response.data[0];
    if (workspace?.lead_id) {
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
    return workspace;
  }

  async listFacilityWorkspaces() {
    return this.safeGet("/facility_workspaces?order=created_at.desc");
  }

  // Office->Facility provisioning lifecycle -- Portfolio detail needs the
  // linked workspace's status/checklist/activation state alongside the
  // live Backend projection (requirement #14's resend/revoke/status UI).
  async listFacilityWorkspacesByPortfolioIds(portfolioIds) {
    const ids = (portfolioIds || []).map((id) => String(id)).filter(Boolean);
    if (!ids.length) return [];
    const inList = ids.map((id) => `"${id}"`).join(",");
    return this.safeGet(`/facility_workspaces?portfolio_id=in.(${inList})`);
  }

  async updateFacilityWorkspace(workspaceId, patch) {
    const payload = Object.fromEntries(
      Object.entries(patch || {}).filter(([, value]) => value !== undefined)
    );
    const response = await this.client.patch(`/facility_workspaces?id=eq.${workspaceId}`, payload, {
      headers: this.selectHeaders(),
    });
    return response.data[0] || null;
  }

  // Governed Portfolio delete -- removes Office's own bookkeeping row for
  // an abandoned/failed provisioning attempt. Never called until Backend
  // has already confirmed (or the attempt never reached Backend at all)
  // that no real Facility operational state exists.
  async deleteFacilityWorkspace(workspaceId) {
    await this.client.delete(`/facility_workspaces?id=eq.${workspaceId}`);
    return true;
  }

  async getLeadChannelState(leadId, channel) {
    const response = await this.client.get(
      `/lead_channel_states?lead_id=eq.${leadId}&channel=eq.${channel}&limit=1`
    );
    return response.data[0] || null;
  }

  async upsertLeadChannelState(leadId, channel, patch) {
    // lead_channel_states has a unique(lead_id, channel) constraint, not
    // a plain primary-key-only shape -- PostgREST's merge-duplicates
    // upsert needs an explicit on_conflict target to resolve against
    // that constraint; without it, a second write for the same
    // lead+channel hits the unique constraint as a genuine INSERT
    // conflict (409) instead of being merged. Real production bug found
    // via a live inbound WhatsApp message (the first write per lead+
    // channel succeeded silently; a second one always 409'd, breaking
    // channel-state tracking and the AI reply that runs after it).
    const response = await this.client.post(
      "/lead_channel_states?on_conflict=lead_id,channel",
      {
        lead_id: leadId,
        channel,
        ...patch,
      },
      {
        headers: {
          ...this.selectHeaders(),
          Prefer: "resolution=merge-duplicates,return=representation",
        },
      }
    );
    return response.data[0];
  }

  async appendInboundEvent(input) {
    const response = await this.client.post(
      "/inbound_events",
      {
        channel: input.channel,
        provider: input.provider,
        event_type: input.event_type,
        lead_id: input.lead_id || null,
        external_event_id: input.external_event_id || null,
        payload: input.payload || {},
      },
      {
        headers: this.selectHeaders(),
      }
    );
    return response.data[0];
  }

  async createNotification(input) {
    const response = await this.client.post(
      "/notifications",
      {
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
        related_type: input.related_type || null,
        related_id: input.related_id || null,
      },
      {
        headers: this.selectHeaders(),
      }
    );
    const notification = response.data[0];
    if (notification.lead_id) {
      await this.appendTimelineEvent({
        lead_id: notification.lead_id,
        event_type: "notification",
        actor: notification.channel || "",
        title: notification.type || "notification",
        body: notification.summary || notification.reason || "",
        metadata: notification.metadata || {},
      });
    }
    return notification;
  }

  async listNotifications(limit = 100, filter = {}) {
    const query = new URLSearchParams();
    query.set("order", "created_at.desc");
    query.set("limit", String(limit));
    if (filter.status) query.set("status", `eq.${filter.status}`);
    if (filter.type) query.set("type", `eq.${filter.type}`);
    if (filter.lead_id) query.set("lead_id", `eq.${filter.lead_id}`);
    // Rows targeted at this person, plus every broadcast row
    // (recipient_email null) — never someone else's.
    if (filter.forRecipient) {
      query.set("or", `(recipient_email.eq.${filter.forRecipient},recipient_email.is.null)`);
    }
    if (filter.unreadOnly) query.set("read_at", "is.null");
    const response = await this.client.get(`/notifications?${query.toString()}`);
    return response.data;
  }

  async getNotificationById(notificationId) {
    const response = await this.client.get(`/notifications?id=eq.${notificationId}&limit=1`);
    return response.data[0] || null;
  }

  async updateNotification(notificationId, patch) {
    const response = await this.client.patch(
      `/notifications?id=eq.${notificationId}`,
      patch,
      {
        headers: this.selectHeaders(),
      }
    );
    return response.data[0] || null;
  }

  // ---------------------------------------------------------------
  // Staff messaging (Phase 5) — see store-file.js for the shape
  // rationale; this mirrors it against PostgREST.
  // ---------------------------------------------------------------
  async createStaffConversation({ type, title, createdBy, participantEmails }) {
    const response = await this.client.post(
      "/staff_conversations",
      { type: type === "group" ? "group" : "direct", title: title || null, created_by: createdBy },
      { headers: this.selectHeaders() }
    );
    const conversation = response.data[0];
    const emails = Array.from(new Set([...(participantEmails || []), createdBy].map((e) => normalizeEmail(e)).filter(Boolean)));
    if (emails.length) {
      await this.client.post(
        "/staff_conversation_participants",
        emails.map((email) => ({ conversation_id: conversation.id, staff_email: email })),
        { headers: this.selectHeaders() }
      );
    }
    return conversation;
  }

  async listStaffConversationParticipants(conversationId) {
    const response = await this.client.get(`/staff_conversation_participants?conversation_id=eq.${conversationId}`);
    return response.data;
  }

  async isStaffConversationParticipant(conversationId, email) {
    const response = await this.client.get(
      `/staff_conversation_participants?conversation_id=eq.${conversationId}&staff_email=eq.${encodeURIComponent(normalizeEmail(email))}&limit=1`
    );
    return response.data.length > 0;
  }

  async findDirectStaffConversation(emailA, emailB) {
    const a = normalizeEmail(emailA);
    const b = normalizeEmail(emailB);
    const aRows = await this.client.get(`/staff_conversation_participants?staff_email=eq.${encodeURIComponent(a)}&select=conversation_id`);
    const candidateIds = aRows.data.map((row) => row.conversation_id);
    if (!candidateIds.length) return null;
    const bRows = await this.client.get(
      `/staff_conversation_participants?staff_email=eq.${encodeURIComponent(b)}&conversation_id=in.(${candidateIds.join(",")})&select=conversation_id`
    );
    for (const row of bRows.data) {
      const conversation = await this.getStaffConversationById(row.conversation_id);
      if (conversation && conversation.type === "direct") return conversation;
    }
    return null;
  }

  async listStaffConversationsForStaff(email) {
    const rows = await this.client.get(
      `/staff_conversation_participants?staff_email=eq.${encodeURIComponent(normalizeEmail(email))}&select=conversation_id`
    );
    const ids = rows.data.map((row) => row.conversation_id);
    if (!ids.length) return [];
    const response = await this.client.get(`/staff_conversations?id=in.(${ids.join(",")})&order=updated_at.desc`);
    return response.data;
  }

  async getStaffConversationById(conversationId) {
    const response = await this.client.get(`/staff_conversations?id=eq.${conversationId}&limit=1`);
    return response.data[0] || null;
  }

  async createStaffMessage({ conversationId, senderEmail, body, attachments }) {
    const response = await this.client.post(
      "/staff_messages",
      { conversation_id: conversationId, sender_email: normalizeEmail(senderEmail), body: body || "" },
      { headers: this.selectHeaders() }
    );
    const message = response.data[0];
    await this.client.patch(
      `/staff_conversations?id=eq.${conversationId}`,
      { last_message_at: message.created_at, updated_at: message.created_at },
      { headers: this.selectHeaders() }
    );
    let attachmentRows = [];
    if ((attachments || []).length) {
      const attResponse = await this.client.post(
        "/staff_message_attachments",
        attachments.map((att) => ({
          message_id: message.id,
          file_id: att.file_id || null,
          file_url: att.file_url,
          filename: att.filename || null,
          mime_type: att.mime_type || null,
          size_bytes: att.size_bytes || null,
          duration_seconds: att.duration_seconds || null,
        })),
        { headers: this.selectHeaders() }
      );
      attachmentRows = attResponse.data;
    }
    await this.client.post(
      "/staff_message_reads",
      { message_id: message.id, staff_email: message.sender_email },
      { headers: this.selectHeaders() }
    );
    return { ...message, attachments: attachmentRows };
  }

  async listStaffMessages(conversationId, limit = 200) {
    const response = await this.client.get(
      `/staff_messages?conversation_id=eq.${conversationId}&order=created_at.asc&limit=${limit}`
    );
    const messages = response.data;
    if (!messages.length) return [];
    const ids = messages.map((m) => m.id);
    const [attachmentsResponse, reactions, readsResponse] = await Promise.all([
      this.client.get(`/staff_message_attachments?message_id=in.(${ids.join(",")})`),
      this.listStaffMessageReactions(ids),
      this.client.get(`/staff_message_reads?message_id=in.(${ids.join(",")})&select=message_id,staff_email`),
    ]);
    return messages.map((message) => ({
      ...message,
      attachments: attachmentsResponse.data.filter((att) => att.message_id === message.id),
      reactions: reactions.filter((r) => r.message_id === message.id),
      // Real per-recipient read receipts (Part 6/18 — "delivery/read
      // state where genuinely supported") — who besides the sender has
      // actually read this specific message, never a fabricated tick.
      read_by: readsResponse.data.filter((r) => r.message_id === message.id).map((r) => r.staff_email),
    }));
  }

  async markStaffMessagesRead(conversationId, email) {
    const normalized = normalizeEmail(email);
    const messagesResponse = await this.client.get(`/staff_messages?conversation_id=eq.${conversationId}&select=id`);
    const ids = messagesResponse.data.map((m) => m.id);
    if (!ids.length) return 0;
    const readResponse = await this.client.get(
      `/staff_message_reads?staff_email=eq.${encodeURIComponent(normalized)}&message_id=in.(${ids.join(",")})&select=message_id`
    );
    const alreadyRead = new Set(readResponse.data.map((r) => r.message_id));
    const toInsert = ids.filter((id) => !alreadyRead.has(id)).map((id) => ({ message_id: id, staff_email: normalized }));
    if (!toInsert.length) return 0;
    await this.client.post("/staff_message_reads", toInsert, { headers: this.selectHeaders() });
    return toInsert.length;
  }

  async countUnreadStaffMessages(conversationId, email) {
    const normalized = normalizeEmail(email);
    const messagesResponse = await this.client.get(
      `/staff_messages?conversation_id=eq.${conversationId}&sender_email=neq.${encodeURIComponent(normalized)}&select=id`
    );
    const ids = messagesResponse.data.map((m) => m.id);
    if (!ids.length) return 0;
    const readResponse = await this.client.get(
      `/staff_message_reads?staff_email=eq.${encodeURIComponent(normalized)}&message_id=in.(${ids.join(",")})&select=message_id`
    );
    const readIds = new Set(readResponse.data.map((r) => r.message_id));
    return ids.filter((id) => !readIds.has(id)).length;
  }

  // ---------------------------------------------------------------
  // Messages workspace additions (additive to Phase 5 staff messaging
  // above) — group management, per-participant archive/mute/pin,
  // reactions, soft-delete, search.
  // ---------------------------------------------------------------
  async updateStaffConversation(conversationId, patch) {
    const response = await this.client.patch(`/staff_conversations?id=eq.${conversationId}`, patch, { headers: this.selectHeaders() });
    return response.data[0] || null;
  }

  async addStaffConversationParticipants(conversationId, emails) {
    const existing = await this.listStaffConversationParticipants(conversationId);
    const existingEmails = new Set(existing.map((p) => p.staff_email));
    const toInsert = Array.from(new Set(emails.map(normalizeEmail).filter(Boolean))).filter((e) => !existingEmails.has(e));
    if (!toInsert.length) return [];
    const response = await this.client.post(
      "/staff_conversation_participants",
      toInsert.map((email) => ({ conversation_id: conversationId, staff_email: email })),
      { headers: this.selectHeaders() }
    );
    return response.data;
  }

  async removeStaffConversationParticipant(conversationId, email) {
    await this.client.delete(
      `/staff_conversation_participants?conversation_id=eq.${conversationId}&staff_email=eq.${encodeURIComponent(normalizeEmail(email))}`
    );
    return true;
  }

  async setStaffConversationParticipantState(conversationId, email, patch) {
    const response = await this.client.patch(
      `/staff_conversation_participants?conversation_id=eq.${conversationId}&staff_email=eq.${encodeURIComponent(normalizeEmail(email))}`,
      patch,
      { headers: this.selectHeaders() }
    );
    return response.data[0] || null;
  }

  async toggleStaffMessageReaction(messageId, email, emoji) {
    const normalized = normalizeEmail(email);
    const existingResponse = await this.client.get(
      `/staff_message_reactions?message_id=eq.${messageId}&staff_email=eq.${encodeURIComponent(normalized)}&emoji=eq.${encodeURIComponent(emoji)}&limit=1`
    );
    if (existingResponse.data.length) {
      await this.client.delete(
        `/staff_message_reactions?message_id=eq.${messageId}&staff_email=eq.${encodeURIComponent(normalized)}&emoji=eq.${encodeURIComponent(emoji)}`
      );
      return { action: "removed", emoji };
    }
    const response = await this.client.post(
      "/staff_message_reactions",
      { message_id: messageId, staff_email: normalized, emoji },
      { headers: this.selectHeaders() }
    );
    return { action: "added", reaction: response.data[0] };
  }

  async listStaffMessageReactions(messageIds) {
    if (!messageIds.length) return [];
    const response = await this.client.get(`/staff_message_reactions?message_id=in.(${messageIds.join(",")})`);
    return response.data;
  }

  async getStaffMessageById(messageId) {
    const response = await this.client.get(`/staff_messages?id=eq.${messageId}&limit=1`);
    return response.data[0] || null;
  }

  async softDeleteStaffMessage(messageId, deletedBy) {
    const response = await this.client.patch(
      `/staff_messages?id=eq.${messageId}`,
      { deleted_at: new Date().toISOString(), deleted_by: normalizeEmail(deletedBy) },
      { headers: this.selectHeaders() }
    );
    return response.data[0] || null;
  }

  async searchStaffMessages(conversationIds, query, limit = 40) {
    if (!conversationIds.length || !query) return [];
    const escaped = query.replace(/[%_]/g, (m) => `\\${m}`);
    const response = await this.client.get(
      `/staff_messages?conversation_id=in.(${conversationIds.join(",")})&deleted_at=is.null&body=ilike.*${encodeURIComponent(escaped)}*&order=created_at.desc&limit=${limit}`
    );
    return response.data;
  }

  // ---------------------------------------------------------------
  // Content / Publishing (Phase 8) — see store-file.js for rationale.
  // ---------------------------------------------------------------
  async createContentItem(input) {
    const response = await this.client.post(
      "/office_content_items",
      {
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
        created_by: input.created_by || "office",
        metadata: input.metadata || {},
      },
      { headers: this.selectHeaders() }
    );
    return response.data[0];
  }

  async listContentItems(filter = {}) {
    const query = new URLSearchParams();
    query.set("order", "updated_at.desc");
    if (filter.status) query.set("workflow_status", `eq.${filter.status}`);
    const response = await this.client.get(`/office_content_items?${query.toString()}`);
    return response.data;
  }

  async getContentItemById(id) {
    const response = await this.client.get(`/office_content_items?id=eq.${encodeURIComponent(id)}&limit=1`);
    return response.data[0] || null;
  }

  async updateContentItem(id, patch) {
    const response = await this.client.patch(`/office_content_items?id=eq.${encodeURIComponent(id)}`, patch, {
      headers: this.selectHeaders(),
    });
    return response.data[0] || null;
  }

  async listScheduledContentDue(now) {
    const response = await this.client.get(
      `/office_content_items?workflow_status=eq.scheduled&scheduled_publish_at=lte.${now.toISOString()}`
    );
    return response.data;
  }

  async createDevelopmentProject(input) {
    const response = await this.client.post(
      "/office_development_projects",
      {
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
        published: false,
        created_by: input.created_by || "office",
      },
      { headers: this.selectHeaders() }
    );
    return response.data[0];
  }

  async listDevelopmentProjects() {
    const response = await this.client.get("/office_development_projects?order=name.asc");
    return response.data;
  }

  async getDevelopmentProjectById(id) {
    const response = await this.client.get(`/office_development_projects?id=eq.${encodeURIComponent(id)}&limit=1`);
    return response.data[0] || null;
  }

  async updateDevelopmentProject(id, patch) {
    const response = await this.client.patch(`/office_development_projects?id=eq.${encodeURIComponent(id)}`, patch, {
      headers: this.selectHeaders(),
    });
    return response.data[0] || null;
  }

  async createOfficeReport(input) {
    const response = await this.client.post(
      "/office_reports",
      {
        id: crypto.randomUUID(),
        title: input.title || "Untitled Report",
        body: input.body || "",
        related_type: input.related_type || "",
        related_id: input.related_id || "",
        author: input.author || "office",
        status: "submitted",
        attachments: Array.isArray(input.attachments) ? input.attachments : [],
      },
      { headers: this.selectHeaders() }
    );
    return response.data[0];
  }

  async listOfficeReports(filter = {}) {
    const query = new URLSearchParams();
    query.set("order", "updated_at.desc");
    if (filter.status) query.set("status", `eq.${filter.status}`);
    const response = await this.client.get(`/office_reports?${query.toString()}`);
    return response.data;
  }

  async getOfficeReportById(id) {
    const response = await this.client.get(`/office_reports?id=eq.${encodeURIComponent(id)}&limit=1`);
    return response.data[0] || null;
  }

  async updateOfficeReport(id, patch) {
    const response = await this.client.patch(`/office_reports?id=eq.${encodeURIComponent(id)}`, patch, {
      headers: this.selectHeaders(),
    });
    return response.data[0] || null;
  }

  async appendTrace(input) {
    const response = await this.client.post(
      "/traces",
      {
        trace_id: input.trace_id || "",
        lead_id: input.lead_id || null,
        type: input.type,
        agent: input.agent || "",
        tool_name: input.tool_name || "",
        request_id: input.request_id || "",
        source: input.source || "",
        payload: input.payload || {},
      },
      {
        headers: this.selectHeaders(),
      }
    );
    const trace = response.data[0];
    if (trace.lead_id) {
      await this.appendTimelineEvent({
        lead_id: trace.lead_id,
        event_type: "trace",
        actor: trace.agent || "system",
        title: trace.type,
        body: trace.tool_name || "",
        metadata: trace.payload || {},
      });
    }
    return trace;
  }

  async listTraces(limit = 200, filter = {}) {
    const query = new URLSearchParams();
    query.set("order", "created_at.desc");
    query.set("limit", String(limit));
    if (filter.lead_id) query.set("lead_id", `eq.${filter.lead_id}`);
    if (filter.trace_id) query.set("trace_id", `eq.${filter.trace_id}`);
    const response = await this.client.get(`/traces?${query.toString()}`);
    return response.data;
  }

  async getLeadMemory(leadId) {
    const response = await this.client.get(`/lead_memories?lead_id=eq.${leadId}&limit=1`);
    return response.data[0] || null;
  }

  async upsertLeadMemory(leadId, memory) {
    const payload = {
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
    };
    const response = await this.client.post("/lead_memories", payload, {
      headers: {
        ...this.selectHeaders(),
        Prefer: "resolution=merge-duplicates,return=representation",
      },
    });
    return response.data[0];
  }

  async listTimelineForLead(leadId, limit = 200) {
    const response = await this.client.get(
      `/timeline_events?lead_id=eq.${leadId}&order=created_at.asc&limit=${limit}`
    );
    return response.data;
  }

  async ensureAdminUser(input) {
    const existing = await this.getAdminUserByEmail(input.email);
    if (existing) {
      return existing;
    }
    const response = await this.client.post(
      "/admin_users",
      {
        email: normalizeEmail(input.email),
        password_hash: input.password_hash,
        role: input.role || "admin",
        status: input.status || "active",
        display_name: input.display_name || "",
        office_position: input.office_position || "",
        phone: input.phone || "",
        passport_photo_url: input.passport_photo_url || "",
        qr_credential: input.qr_credential || "",
        permission_scopes: Array.isArray(input.permission_scopes) ? input.permission_scopes : [],
      },
      {
        headers: this.selectHeaders(),
      }
    );
    return response.data[0];
  }

  async getAdminUserById(userId) {
    const response = await this.client.get(`/admin_users?id=eq.${userId}&limit=1`);
    return response.data[0] || null;
  }

  async getAdminUserByEmail(email) {
    const response = await this.client.get(
      `/admin_users?email=eq.${encodeURIComponent(normalizeEmail(email))}&limit=1`
    );
    return response.data[0] || null;
  }

  async listAdminUsers() {
    const response = await this.client.get("/admin_users?order=email.asc");
    return response.data;
  }

  // Oyi Communications Convergence, Slice 3 -- the operational-routing
  // profile for chooseStaffForHandoff(), genuinely separate from
  // admin_users (authentication/authorization). Keyed on email, matching
  // every other cross-cutting staff concern in this codebase.
  async listStaffProfiles() {
    const response = await this.client.get("/office_staff_profiles?order=staff_email.asc");
    return response.data;
  }

  async getStaffProfile(email) {
    const response = await this.client.get(
      `/office_staff_profiles?staff_email=eq.${encodeURIComponent(normalizeEmail(email))}&limit=1`
    );
    return response.data[0] || null;
  }

  async upsertStaffProfile(email, patch = {}) {
    const response = await this.client.post(
      "/office_staff_profiles?on_conflict=staff_email",
      {
        staff_email: normalizeEmail(email),
        ...(patch.business_unit !== undefined ? { business_unit: patch.business_unit } : {}),
        ...(patch.availability !== undefined ? { availability: patch.availability } : {}),
        ...(patch.routing_priority !== undefined ? { routing_priority: patch.routing_priority } : {}),
        updated_at: new Date().toISOString(),
      },
      { headers: { ...this.selectHeaders(), Prefer: "resolution=merge-duplicates,return=representation" } }
    );
    return response.data[0];
  }

  async listStaffCapabilitiesAll() {
    const response = await this.client.get("/office_staff_capabilities?order=staff_email.asc");
    return response.data;
  }

  async listStaffCapabilities(email) {
    const response = await this.client.get(
      `/office_staff_capabilities?staff_email=eq.${encodeURIComponent(normalizeEmail(email))}`
    );
    return response.data;
  }

  async upsertStaffCapability(email, { capability, specialty } = {}) {
    const response = await this.client.post(
      "/office_staff_capabilities?on_conflict=staff_email,capability",
      {
        staff_email: normalizeEmail(email),
        capability: String(capability || "").trim().toLowerCase(),
        specialty: String(specialty || "").trim(),
      },
      { headers: { ...this.selectHeaders(), Prefer: "resolution=merge-duplicates,return=representation" } }
    );
    return response.data[0];
  }

  async deleteStaffCapability(email, capability) {
    await this.client.delete(
      `/office_staff_capabilities?staff_email=eq.${encodeURIComponent(normalizeEmail(email))}&capability=eq.${encodeURIComponent(String(capability || "").trim().toLowerCase())}`
    );
    return true;
  }

  async updateAdminUser(userId, patch) {
    const response = await this.client.patch(`/admin_users?id=eq.${userId}`, patch, {
      headers: this.selectHeaders(),
    });
    return response.data[0] || null;
  }

  // Real physical delete -- safe in this schema because no business
  // table (documents/meetings/tasks/CRM/audit_events.actor_email) FKs
  // to admin_users.id; they all store the durable email string
  // directly. admin_invites/password_reset_tokens cascade (correct --
  // auth-lifecycle rows tied 1:1 to the account); audit_events.actor_user_id
  // (its one real FK, on delete set null) nulls out while actor_email
  // keeps historical attribution intact.
  async deleteAdminUser(userId) {
    await this.client.delete(`/admin_users?id=eq.${userId}`, { headers: this.selectHeaders() });
    return true;
  }

  async createAdminInvite(input) {
    const response = await this.client.post(
      "/admin_invites",
      {
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
      },
      {
        headers: this.selectHeaders(),
      }
    );
    return response.data[0];
  }

  async getAdminInviteByTokenHash(tokenHash) {
    const response = await this.client.get(`/admin_invites?token_hash=eq.${encodeURIComponent(tokenHash)}&limit=1`);
    return response.data[0] || null;
  }

  async updateAdminInvite(inviteId, patch) {
    const response = await this.client.patch(`/admin_invites?id=eq.${inviteId}`, patch, {
      headers: this.selectHeaders(),
    });
    return response.data[0] || null;
  }

  async listAdminInvites() {
    const response = await this.client.get("/admin_invites?order=created_at.desc");
    return response.data;
  }

  async createPasswordResetToken(input) {
    const response = await this.client.post(
      "/password_reset_tokens",
      {
        admin_user_id: input.admin_user_id || null,
        email: normalizeEmail(input.email),
        token_hash: input.token_hash,
        status: input.status || "pending",
        requested_by: input.requested_by || "",
        expires_at: input.expires_at,
        used_at: input.used_at || null,
      },
      {
        headers: this.selectHeaders(),
      }
    );
    return response.data[0];
  }

  async getPasswordResetTokenByHash(tokenHash) {
    const response = await this.client.get(
      `/password_reset_tokens?token_hash=eq.${encodeURIComponent(tokenHash)}&limit=1`
    );
    return response.data[0] || null;
  }

  async updatePasswordResetToken(tokenId, patch) {
    const response = await this.client.patch(`/password_reset_tokens?id=eq.${tokenId}`, patch, {
      headers: this.selectHeaders(),
    });
    return response.data[0] || null;
  }

  async appendAuditEvent(input) {
    const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
    const response = await this.client.post(
      "/audit_events",
      {
        actor_user_id: input.actor_user_id || null,
        actor_email: input.actor_email || "",
        actor_role: input.actor_role || "",
        action: input.action,
        target_type: input.target_type,
        target_id: input.target_id || "",
        metadata: {
          ...metadata,
          resource_type: input.resource_type || input.target_type || "",
          resource_id: input.resource_id || input.target_id || "",
          estate_id: input.estate_id || metadata.estate_id || null,
          status: input.status || metadata.status || "success",
          ip: input.ip || metadata.ip || "",
          user_agent: input.user_agent || metadata.user_agent || "",
        },
      },
      {
        headers: this.selectHeaders(),
      }
    );
    return response.data[0];
  }

  async listAuditEvents(limit = 200) {
    const response = await this.client.get(`/audit_events?order=created_at.desc&limit=${limit}`);
    return response.data;
  }

  async listOfficePackages() {
    return this.safeGet("/office_packages?order=name.asc");
  }

  async listOfficeEstates() {
    return this.safeGet("/office_estates?order=name.asc");
  }

  async listOfficeBuildings() {
    return this.safeGet("/office_buildings?order=name.asc");
  }

  async listOfficeHomes() {
    return this.safeGet("/office_homes?order=name.asc");
  }

  async listOfficeDevices() {
    return this.safeGet("/office_devices?order=name.asc");
  }

  async listOfficeWallets() {
    return this.safeGet("/office_wallets?order=label.asc");
  }

  async listOfficeAnalytics() {
    return this.safeGet("/office_analytics?order=label.asc");
  }

  async listOfficeSupportMappings() {
    return this.safeGet("/office_support_mappings?order=updated_at.desc");
  }

  async listOfficeDocuments() {
    return this.safeGet("/office_documents?order=updated_at.desc");
  }

  async getOfficeDocumentById(id) {
    const response = await this.client.get(`/office_documents?id=eq.${encodeURIComponent(id)}&limit=1`);
    return response.data[0] || null;
  }

  async createOfficeFile(input) {
    try {
      const response = await this.client.post(
        "/office_files",
        {
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
        },
        {
          headers: this.selectHeaders(),
        }
      );
      return response.data[0] || input;
    } catch (error) {
      const status = error?.response?.status;
      if (status === 400 || status === 404) {
        return input;
      }
      throw error;
    }
  }

  async listOfficeFiles(limit = 200) {
    return this.safeGet(`/office_files?order=created_at.desc&limit=${limit}`);
  }

  async updateOfficeAsset(kind, id, patch) {
    const tableMap = {
      estate: "office_estates",
      building: "office_buildings",
      device: "office_devices",
    };
    const table = tableMap[String(kind || "").toLowerCase()];
    if (!table || !id) return null;
    const response = await this.client.patch(`/${table}?id=eq.${encodeURIComponent(id)}`, patch, {
      headers: this.selectHeaders(),
    });
    return response.data[0] || null;
  }

  async createOfficeDocument(input) {
    const document = {
      id: input.id,
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
    };
    try {
      const response = await this.client.post("/office_documents", document, {
        headers: this.selectHeaders(),
      });
      return response.data[0] || document;
    } catch (error) {
      const status = error?.response?.status;
      if (status === 400 || status === 404 || status === 406) {
        return {
          ...document,
          sync_status: "schema_pending",
          sync_warning:
            error?.response?.data?.message ||
            error?.response?.data?.hint ||
            "office_documents schema is not available yet.",
        };
      }
      throw error;
    }
  }

  async deleteOfficeDocument(id) {
    await this.client.delete(`/office_documents?id=eq.${encodeURIComponent(id)}`, {
      headers: this.selectHeaders(),
    });
    return true;
  }

  async deleteOfficeFile(id) {
    await this.client.delete(`/office_files?id=eq.${encodeURIComponent(id)}`, {
      headers: this.selectHeaders(),
    });
    return true;
  }

  async listOfficeFilesByResource(resourceType, resourceId) {
    return this.safeGet(
      `/office_files?resource_type=eq.${encodeURIComponent(resourceType)}&resource_id=eq.${encodeURIComponent(resourceId)}`
    );
  }

  async listOfficeFilesByResourceType(resourceType) {
    return this.safeGet(`/office_files?resource_type=eq.${encodeURIComponent(resourceType)}&select=size`);
  }

  // Documents Workspace -- folders are a lightweight organizational
  // entity, deliberately not routed through the generic corporate-record
  // framework (CORPORATE_COLLECTIONS assumes a business-record shape
  // with owner/business_unit/status that a folder doesn't have).
  async listOfficeDocumentFolders() {
    return this.safeGet("/office_document_folders?order=name.asc");
  }

  async createOfficeDocumentFolder(input) {
    const folder = {
      id: input.id,
      name: input.name,
      created_by: input.created_by || "",
    };
    try {
      const response = await this.client.post("/office_document_folders", folder, {
        headers: this.selectHeaders(),
      });
      return response.data[0] || folder;
    } catch (error) {
      const status = error?.response?.status;
      if (status === 400 || status === 404 || status === 406) {
        return {
          ...folder,
          sync_status: "schema_pending",
          sync_warning:
            error?.response?.data?.message ||
            error?.response?.data?.hint ||
            "office_document_folders schema is not available yet.",
        };
      }
      throw error;
    }
  }

  async getOfficeDocumentFolderById(id) {
    const response = await this.client.get(`/office_document_folders?id=eq.${encodeURIComponent(id)}&limit=1`);
    return response.data[0] || null;
  }

  async renameOfficeDocumentFolder(id, name) {
    const response = await this.client.patch(
      `/office_document_folders?id=eq.${encodeURIComponent(id)}`,
      { name },
      { headers: this.selectHeaders() }
    );
    return response.data?.[0] || null;
  }

  async deleteOfficeDocumentFolder(id) {
    await this.client.delete(`/office_document_folders?id=eq.${encodeURIComponent(id)}`, {
      headers: this.selectHeaders(),
    });
    return true;
  }

  // Corporate Letterhead master config -- one row, id 'default'. Never
  // joined at document-render time; only read when creating a new
  // Letterhead document (to snapshot) or by the Settings admin editor.
  async getLetterheadConfig() {
    try {
      const response = await this.client.get("/office_letterhead_config?id=eq.default&limit=1");
      return response.data[0] || null;
    } catch (error) {
      const status = error?.response?.status;
      if (status === 400 || status === 404 || status === 406) return null;
      throw error;
    }
  }

  async upsertLetterheadConfig(patch) {
    const payload = { id: "default", ...patch };
    try {
      const response = await this.client.post("/office_letterhead_config", payload, {
        headers: { ...this.selectHeaders(), Prefer: "return=representation,resolution=merge-duplicates" },
      });
      return response.data[0] || payload;
    } catch (error) {
      const status = error?.response?.status;
      if (status === 400 || status === 404 || status === 406) {
        return {
          ...payload,
          sync_status: "schema_pending",
          sync_warning:
            error?.response?.data?.message ||
            error?.response?.data?.hint ||
            "office_letterhead_config schema is not available yet.",
        };
      }
      throw error;
    }
  }

  async upsertOfficeCollections(input) {
    const collections = input || {};
    await this.upsertRows("office_packages", collections.packages);
    await this.upsertRows("office_estates", collections.estates);
    await this.upsertRows("office_buildings", collections.buildings);
    await this.upsertRows("office_homes", collections.homes);
    await this.upsertRows("office_devices", collections.devices);
    await this.upsertRows("office_wallets", collections.wallets);
    await this.upsertRows("office_analytics", collections.analytics);
    await this.upsertRows("office_documents", collections.documents);
    await this.upsertRows("office_support_mappings", collections.support_mappings);
    return this.getOfficeSnapshot();
  }

  async getOfficeSnapshot() {
    const [packages, estates, buildings, homes, devices, wallets, analytics, documents, supportMappings] =
      await Promise.all([
        this.listOfficePackages(),
        this.listOfficeEstates(),
        this.listOfficeBuildings(),
        this.listOfficeHomes(),
        this.listOfficeDevices(),
        this.listOfficeWallets(),
        this.listOfficeAnalytics(),
        this.listOfficeDocuments(),
        this.listOfficeSupportMappings(),
      ]);

    const officeCollections =
      packages.length ||
      estates.length ||
      buildings.length ||
      homes.length ||
      devices.length ||
      wallets.length ||
      analytics.length ||
      documents.length ||
      supportMappings.length
        ? {
            packages,
            estates,
            buildings,
            homes,
            devices,
            wallets,
            analytics,
            documents,
            support_mappings: supportMappings,
          }
        : createOfficeSeedData();

    const [report, leads, notifications, adminUsers, audit, traces] = await Promise.all([
      this.getReportingSummary(),
      this.listLeads(),
      this.listNotifications(500),
      this.listAdminUsers(),
      this.listAuditEvents(200),
      this.listTraces(200),
    ]);

    return buildOfficeSnapshot({
      ...officeCollections,
      leads,
      report,
      notifications,
      adminUsers,
      audit,
      traces,
    });
  }

  async getReportingSummary() {
    const [leads, demos, notifications, proposals] = await Promise.all([
      this.listLeads(),
      this.client.get("/demos?select=id,status,scheduled_for"),
      this.client.get("/notifications?select=id,type"),
      this.client.get("/proposals?select=id,status"),
    ]);
    const totalLeads = leads.length || 1;
    const salesReady = leads.filter((lead) => ["sales", "booked", "closed"].includes(lead.status)).length;
    const scoredLeads = leads.filter((lead) => Number.isFinite(Number(lead.score)) && Number(lead.score) > 0);
    const hotLeads = leads.filter((lead) => Number(lead.score || 0) >= 70).length;
    const upcomingDemos = demos.data
      .filter((demo) => demo.scheduled_for)
      .sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)))
      .slice(0, 5);

    return {
      totals: {
        leads: leads.length,
        demos: demos.data.length,
        escalations: notifications.data.filter((item) => item.type === "founder_escalation").length,
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
      demos_booked: demos.data.filter((demo) => ["requested", "pending", "confirmed"].includes(demo.status)).length,
      demos_confirmed: demos.data.filter((demo) => demo.status === "confirmed").length,
      upcoming_demos: upcomingDemos,
      proposals_total: proposals.data.length,
      proposals_sent: proposals.data.filter((item) => ["sent", "accepted"].includes(item.status)).length,
      deals_won: leads.filter((lead) => (lead.stage || lead.commercial_stage) === "won").length,
      deals_lost: leads.filter((lead) => (lead.stage || lead.commercial_stage) === "lost").length,
    };
  }

  async stats() {
    const [
      leads,
      conversations,
      demos,
      proposals,
      notifications,
      traces,
      adminUsers,
      auditEvents,
      estates,
      packages,
      buildings,
      homes,
      devices,
      wallets,
      analytics,
      documents,
      supportMappings,
    ] = await Promise.all([
      this.client.get("/leads?select=id"),
      this.client.get("/conversations?select=id"),
      this.client.get("/demos?select=id"),
      this.client.get("/proposals?select=id"),
      this.client.get("/notifications?select=id"),
      this.client.get("/traces?select=id"),
      this.client.get("/admin_users?select=id"),
      this.client.get("/audit_events?select=id"),
      this.safeGet("/office_estates?select=id"),
      this.safeGet("/office_packages?select=id"),
      this.safeGet("/office_buildings?select=id"),
      this.safeGet("/office_homes?select=id"),
      this.safeGet("/office_devices?select=id"),
      this.safeGet("/office_wallets?select=id"),
      this.safeGet("/office_analytics?select=id"),
      this.safeGet("/office_documents?select=id"),
      this.safeGet("/office_support_mappings?select=id"),
    ]);

    return {
      leads: leads.data.length,
      conversations: conversations.data.length,
      demos: demos.data.length,
      proposals: proposals.data.length,
      notifications: notifications.data.length,
      traces: traces.data.length,
      admin_users: adminUsers.data.length,
      audit_events: auditEvents.data.length,
      estates: estates.length,
      packages: packages.length,
      buildings: buildings.length,
      homes: homes.length,
      devices: devices.length,
      wallets: wallets.length,
      analytics: analytics.length,
      documents: documents.length,
      support_mappings: supportMappings.length,
    };
  }
}

module.exports = {
  SupabaseLeadAgentsStore,
};
