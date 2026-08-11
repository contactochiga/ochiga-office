const { getSolutionFit } = require("./solution-fit");
const { buildCalendarLinks, parsePreferredSchedule } = require("./scheduling");

class ToolExecutor {
  constructor({ store, config, log, webhooks }) {
    this.store = store;
    this.config = config;
    this.log = log;
    this.webhooks = webhooks;
  }

  async execute(name, rawArgs, context) {
    switch (name) {
      case "create_lead":
        return this.createLead(rawArgs, context);
      case "update_lead_status":
        return this.updateLeadStatus(rawArgs, context);
      case "get_solution_fit":
        return this.getSolutionFit(rawArgs);
      case "schedule_demo":
        return this.scheduleDemo(rawArgs, context);
      case "notify_founder":
        return this.notifyFounder(rawArgs, context);
      default:
        throw new Error(`Unsupported tool: ${name}`);
    }
  }

  async createLead(args, context) {
    let lead;
    if (context.leadId && (await this.store.getLead(context.leadId))) {
      lead = await this.store.updateLead(context.leadId, {
        name: args.name,
        company: args.company,
        role: args.role,
        email: args.email,
        phone: args.phone,
        source: args.source || context.source || this.config.defaultLeadSource,
        location: args.location,
        summary: args.notes,
      });
    } else {
      lead = await this.store.createLead({
        ...args,
        source: args.source || context.source || this.config.defaultLeadSource,
        owner: context.agentName,
        status: "new",
      });
    }

    context.leadId = lead.id;
    return {
      ok: true,
      lead,
    };
  }

  async updateLeadStatus(args, context) {
    const leadId = args.lead_id || context.leadId;
    if (!leadId) {
      throw new Error("update_lead_status requires lead_id");
    }

    const updated = await this.store.updateLead(leadId, {
      status: args.status,
      owner: args.owner,
      score: args.score,
      summary: args.summary,
      next_action: args.next_action,
    });

    if (!updated) {
      throw new Error(`Lead not found: ${leadId}`);
    }

    context.leadId = leadId;

    let salesNotification = null;
    if (
      updated &&
      (updated.owner === "sales_agent" ||
        updated.status === "sales" ||
        updated.status === "booked")
    ) {
      const webhookResult = await this.webhooks.notifySales({
        lead_id: leadId,
        owner: updated.owner,
        status: updated.status,
        summary: updated.summary,
        next_action: updated.next_action,
      });
      salesNotification = await this.store.createNotification({
        lead_id: leadId,
        type: "sales_handoff",
        urgency: updated.status === "booked" ? "high" : "medium",
        reason: "Lead routed to sales",
        summary: updated.summary || updated.next_action || "Lead routed to sales.",
        delivered: webhookResult.delivered,
        channel: "sales_webhook",
        response_code: webhookResult.response_code,
        metadata: {
          owner: updated.owner,
          status: updated.status,
        },
      });
    }

    return {
      ok: true,
      lead: updated,
      notification: salesNotification,
    };
  }

  async getSolutionFit(args) {
    return {
      ok: true,
      solution_fit: getSolutionFit(args),
    };
  }

  async scheduleDemo(args, context) {
    const leadId = args.lead_id || context.leadId;
    if (!leadId) {
      throw new Error("schedule_demo requires lead_id");
    }

    const schedule = parsePreferredSchedule({
      text: args.preferred_time || "",
      timezoneHint: args.timezone || "",
    });
    const lead = await this.store.getLead(leadId);
    const calendarLinks = buildCalendarLinks({
      title: "Ochiga Discovery Demo",
      description: `Lead ${lead?.name || ""} ${lead?.company ? `(${lead.company})` : ""}`.trim(),
      location: lead?.location || "",
      startIso: schedule.scheduled_for,
      timezone: schedule.timezone,
    });

    const demo = await this.store.createDemo({
      lead_id: leadId,
      scheduled_for: schedule.scheduled_for,
      status: schedule.scheduled_for ? "requested" : args.preferred_time ? "requested" : "pending",
      notes: JSON.stringify({
        name: args.name || "",
        email: args.email || "",
        phone: args.phone || "",
        timezone: schedule.timezone || args.timezone || "unknown",
        preferred_time_text: args.preferred_time || "",
        display_time: schedule.display_text || "",
        calendar_links: calendarLinks,
      }),
    });

    const updatedLead = await this.store.updateLead(leadId, {
      status: "booked",
      owner: "sales_agent",
      next_action: schedule.scheduled_for
        ? `Confirm demo for ${schedule.display_text}`
        : args.preferred_time
        ? "Confirm requested demo time"
        : "Collect preferred time for demo",
    });

    const webhookResult = await this.webhooks.notifyDemo({
      lead_id: leadId,
      preferred_time: schedule.scheduled_for || args.preferred_time || null,
      timezone: schedule.timezone || args.timezone || "unknown",
      demo_id: demo.id,
      lead: updatedLead,
    });

    context.leadId = leadId;
    const notification = await this.store.createNotification({
      lead_id: leadId,
      type: "demo_requested",
      urgency: args.preferred_time ? "high" : "medium",
      reason: "Demo requested",
        summary: args.preferred_time
        ? `Demo requested for ${schedule.display_text || args.preferred_time}`
        : "Demo requested without preferred time.",
      delivered: webhookResult.delivered,
      channel: "demo_webhook",
      response_code: webhookResult.response_code,
      metadata: {
        demo_id: demo.id,
        preferred_time: schedule.scheduled_for || args.preferred_time || null,
        preferred_time_text: args.preferred_time || "",
        display_time: schedule.display_text || "",
        timezone: schedule.timezone || args.timezone || "unknown",
        calendar_links: calendarLinks,
      },
    });
    return {
      ok: true,
      demo,
      lead: updatedLead,
      schedule,
      calendar_links: calendarLinks,
      notification,
      webhook: webhookResult,
    };
  }

  async notifyFounder(args, context) {
    const payload = {
      lead_id: args.lead_id || context.leadId || null,
      urgency: args.urgency || "medium",
      reason: args.reason,
      summary: args.summary,
    };

    const webhookResult = await this.webhooks.notifyFounder(payload);

    const notification = await this.store.createNotification({
      ...payload,
      type: "founder_escalation",
      delivered: webhookResult.delivered,
      channel: "founder_webhook",
      response_code: webhookResult.response_code,
      metadata: {},
    });

    if (payload.lead_id) {
      await this.store.updateLead(payload.lead_id, {
        status: "escalated",
        owner: "human",
        next_action: payload.reason,
      });
    }

    return {
      ok: true,
      notification,
      delivered: webhookResult.delivered,
      webhook: webhookResult,
    };
  }
}

module.exports = {
  ToolExecutor,
};
