const crypto = require("crypto");
const { normalizeEmail, normalizeText } = require("./normalize-lead");

const BUSINESS_UNITS = Object.freeze(["development", "technology", "private", "partnerships", "corporate"]);

// The crm_* Supabase tables use a native `uuid` primary key with a
// gen_random_uuid() default; the office_* tables use a plain `text`
// primary key with no default (the app must supply one). Collections
// here must match CORPORATE_COLLECTIONS keys backed by a crm_* table.
const UUID_PK_COLLECTIONS = new Set(["contacts", "organizations", "opportunities", "activities", "tasks"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_PATTERN.test(String(value || ""));
}

const CORPORATE_COLLECTIONS = Object.freeze({
  contacts: { state: "crm_contacts", table: "crm_contacts", permission: "crm.read", manage: "crm.manage" },
  organizations: { state: "crm_organizations", table: "crm_organizations", permission: "crm.read", manage: "crm.manage" },
  opportunities: { state: "crm_opportunities", table: "crm_opportunities", permission: "crm.read", manage: "crm.manage" },
  activities: { state: "crm_activities", table: "crm_activities", permission: "crm.read", manage: "crm.manage" },
  tasks: { state: "crm_tasks", table: "crm_tasks", permission: "tasks.read", manage: "tasks.manage" },
  projects: { state: "office_projects", table: "office_projects", permission: "projects.read", manage: "projects.manage" },
  portfolio: { state: "office_portfolio_entries", table: "office_portfolio_entries", permission: "portfolio.read", manage: "portfolio.manage" },
  support: { state: "office_support_cases", table: "office_support_cases", permission: "support.read", manage: "support.assign" },
  private: { state: "office_private_relationships", table: "office_private_relationships", permission: "private.read", manage: "private.manage" },
  partnerships: { state: "office_partnership_relationships", table: "office_partnership_relationships", permission: "partnerships.read", manage: "partnerships.manage" },
  meetings: { state: "office_meetings", table: "office_meetings", permission: "meetings.read", manage: "meetings.manage" },
});

function text(value, fallback = "") {
  return normalizeText(value) || fallback;
}

function recordOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function businessUnit(value) {
  const normalized = text(value, "corporate").toLowerCase();
  return BUSINESS_UNITS.includes(normalized) ? normalized : "corporate";
}

function collectionConfig(collection) {
  const config = CORPORATE_COLLECTIONS[String(collection || "").toLowerCase()];
  if (!config) {
    const error = new Error("unsupported_office_collection");
    error.statusCode = 404;
    throw error;
  }
  return config;
}

function ensureFileCollection(store, collection) {
  const config = collectionConfig(collection);
  if (store?.state && !Array.isArray(store.state[config.state])) {
    store.state[config.state] = [];
  }
  return config;
}

function normalizeCorporateRecord(collection, input = {}, context = {}) {
  const now = context.now || new Date().toISOString();
  const source = recordOf(input.source);
  const metadata = recordOf(input.metadata);
  const id = text(input.id) || `${collection}_${crypto.randomUUID()}`;
  const base = {
    id,
    business_unit: businessUnit(input.business_unit),
    status: text(input.status, collection === "tasks" ? "open" : "active"),
    owner: text(input.owner || context.actorEmail),
    metadata,
    created_at: text(input.created_at, now),
    updated_at: now,
  };

  if (collection === "contacts") {
    return {
      ...base,
      organization_id: text(input.organization_id) || null,
      name: text(input.name),
      email: normalizeEmail(input.email),
      phone: text(input.phone),
      role: text(input.role),
      source: text(input.source || source.source_site, "office"),
    };
  }
  if (collection === "organizations") {
    return {
      ...base,
      name: text(input.name || input.company, "Organization"),
      account_type: text(input.account_type || input.relationship_type, "prospect"),
      website: text(input.website),
      city: text(input.city),
      country: text(input.country),
    };
  }
  if (collection === "opportunities") {
    return {
      ...base,
      contact_id: text(input.contact_id) || null,
      organization_id: text(input.organization_id) || null,
      lead_id: text(input.lead_id) || null,
      inquiry_type: text(input.inquiry_type, "general_enquiry"),
      pipeline: text(input.pipeline, businessUnit(input.business_unit)),
      stage: text(input.stage, "intake_received"),
      source: text(input.source || source.source_site, "office"),
    };
  }
  if (collection === "activities") {
    return {
      ...base,
      lead_id: text(input.lead_id) || null,
      contact_id: text(input.contact_id) || null,
      organization_id: text(input.organization_id) || null,
      opportunity_id: text(input.opportunity_id) || null,
      project_id: text(input.project_id) || null,
      portfolio_id: text(input.portfolio_id) || null,
      support_case_id: text(input.support_case_id) || null,
      meeting_id: text(input.meeting_id) || null,
      related_type: text(input.related_type),
      related_id: text(input.related_id) || null,
      activity_type: text(input.activity_type, "note"),
      title: text(input.title, "Activity"),
      body: text(input.body || input.summary),
      source: text(input.source, "office"),
      actor: text(input.actor || context.actorEmail),
      occurred_at: text(input.occurred_at, now),
    };
  }
  if (collection === "tasks") {
    return {
      ...base,
      lead_id: text(input.lead_id) || null,
      opportunity_id: text(input.opportunity_id) || null,
      project_id: text(input.project_id) || null,
      portfolio_id: text(input.portfolio_id) || null,
      support_case_id: text(input.support_case_id) || null,
      private_relationship_id: text(input.private_relationship_id) || null,
      partnership_relationship_id: text(input.partnership_relationship_id) || null,
      title: text(input.title, "Office task"),
      description: text(input.description || input.body),
      priority: text(input.priority, "normal"),
      assignee: text(input.assignee || input.owner || context.actorEmail),
      due_at: text(input.due_at) || null,
      completed_at: text(input.completed_at) || null,
    };
  }
  if (collection === "projects") {
    return {
      ...base,
      name: text(input.name || input.project_name, "Ochiga project"),
      location: text(input.location),
      stage: text(input.stage, "prospective"),
      linked_opportunity_id: text(input.linked_opportunity_id || input.opportunity_id) || null,
      lead_id: text(input.lead_id) || null,
      organization_id: text(input.organization_id) || null,
      contact_id: text(input.contact_id) || null,
      portfolio_id: text(input.portfolio_id) || null,
      backend_building_id: text(input.backend_building_id) || null,
      oyi_deployment_status: text(input.oyi_deployment_status, "not_started"),
      milestones: Array.isArray(input.milestones) ? input.milestones : [],
    };
  }
  if (collection === "portfolio") {
    return {
      ...base,
      name: text(input.name, "Portfolio entry"),
      client_account: text(input.client_account || input.organization_name),
      location: text(input.location),
      relationship_type: text(input.relationship_type, "customer_building"),
      project_id: text(input.project_id) || null,
      backend_estate_id: text(input.backend_estate_id) || null,
      backend_building_id: text(input.backend_building_id) || null,
      facility_deep_link: text(input.facility_deep_link) || null,
      oyi_deployment_status: text(input.oyi_deployment_status, "unknown"),
      facility_os_status: text(input.facility_os_status, "unknown"),
      consumer_os_status: text(input.consumer_os_status, "unknown"),
      health_summary: text(input.health_summary),
      support_status: text(input.support_status, "normal"),
      major_escalations: Number(input.major_escalations || 0),
    };
  }
  if (collection === "support") {
    return {
      ...base,
      title: text(input.title, "Support case"),
      customer_contact_id: text(input.customer_contact_id || input.contact_id) || null,
      organization_id: text(input.organization_id) || null,
      portfolio_id: text(input.portfolio_id) || null,
      backend_incident_ref: text(input.backend_incident_ref) || null,
      product_area: text(input.product_area, "oyi"),
      category: text(input.category, "general"),
      priority: text(input.priority, "normal"),
      severity: text(input.severity, "medium"),
      assigned_staff: text(input.assigned_staff || input.owner || context.actorEmail),
      sla_target_at: text(input.sla_target_at) || null,
      resolution_notes: text(input.resolution_notes),
    };
  }
  if (collection === "private" || collection === "partnerships") {
    return {
      ...base,
      contact_id: text(input.contact_id) || null,
      organization_id: text(input.organization_id) || null,
      opportunity_id: text(input.opportunity_id) || null,
      relationship_type: text(input.relationship_type, collection === "private" ? "membership" : "strategic_partner"),
      relationship_manager: text(input.relationship_manager || input.owner || context.actorEmail),
      // Matches office-operational-workflows.js STATUS_TRANSITIONS'
      // entry states — "active" here would skip the governed
      // request/review/approve pipeline entirely (active only
      // transitions to inactive).
      review_status: text(input.review_status, collection === "private" ? "requested" : "new"),
      notes: text(input.notes),
    };
  }
  if (collection === "meetings") {
    return {
      ...base,
      title: text(input.title, "Office meeting"),
      scheduled_at: text(input.scheduled_at) || null,
      participants: Array.isArray(input.participants) ? input.participants : [],
      related_type: text(input.related_type),
      related_id: text(input.related_id) || null,
      notes: text(input.notes),
      outcome: text(input.outcome),
      follow_up_task_id: text(input.follow_up_task_id) || null,
    };
  }
  return base;
}

async function listCorporateRecords(store, collection) {
  const config = ensureFileCollection(store, collection);
  if (store?.state) {
    return [...store.state[config.state]].sort((a, b) =>
      String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || ""))
    );
  }
  if (store?.safeGet) {
    return store.safeGet(`/${config.table}?order=updated_at.desc`);
  }
  return [];
}

async function createCorporateRecord(store, collection, input = {}, context = {}) {
  const config = ensureFileCollection(store, collection);
  const record = normalizeCorporateRecord(collection, input, context);
  if (store?.state) {
    const index = store.state[config.state].findIndex((item) => item.id === record.id);
    if (index >= 0) store.state[config.state][index] = { ...store.state[config.state][index], ...record };
    else store.state[config.state].push(record);
    if (store.persist) await store.persist();
    return record;
  }
  if (store?.client) {
    // crm_* tables have a real uuid primary key with a DB-side default.
    // normalizeCorporateRecord always fills `id` (generating a prefixed
    // string like "contacts_<uuid>" when none was supplied) so the
    // file-store path always has one to key off of — but posting that
    // string id to a uuid column fails Postgres's type cast every time.
    // A record.id that already looks like a bare uuid only ever comes
    // from an existing DB row (e.g. upsertContactIdentity re-using
    // existing.id), so treat that as an update (PATCH by id) and
    // anything else as a new row whose id Postgres should generate.
    const uuidPk = UUID_PK_COLLECTIONS.has(String(collection || "").toLowerCase());
    const isExistingUuidRow = uuidPk && isUuid(record.id);
    const payload = uuidPk && !isExistingUuidRow ? { ...record, id: undefined } : record;
    try {
      const response = isExistingUuidRow
        ? await store.client.patch(`/${config.table}?id=eq.${encodeURIComponent(record.id)}`, payload, {
            headers: store.selectHeaders ? store.selectHeaders() : undefined,
          })
        : await store.client.post(`/${config.table}`, payload, {
            headers: store.selectHeaders ? store.selectHeaders() : undefined,
          });
      return response.data[0] || record;
    } catch (error) {
      const status = error?.response?.status;
      if (status === 400 || status === 404 || status === 406) {
        return {
          ...record,
          sync_status: "schema_pending",
          sync_warning: error?.response?.data?.message || "Office operating table is not available yet.",
        };
      }
      throw error;
    }
  }
  return record;
}

async function upsertContactIdentity(store, input = {}, context = {}) {
  const email = normalizeEmail(input.email);
  const contacts = await listCorporateRecords(store, "contacts");
  const existing = email ? contacts.find((contact) => normalizeEmail(contact.email) === email) : null;
  if (!existing) return createCorporateRecord(store, "contacts", input, context);
  return createCorporateRecord(store, "contacts", { ...existing, ...input, id: existing.id }, context);
}

async function buildOfficeHomeProjection(store, options = {}) {
  const includeRecentActivity = options.includeRecentActivity !== false;
  const [leads, proposals, notifications, tasks, activities, support, projects, portfolio, privateRows, partnershipRows] =
    await Promise.all([
      store.listLeads ? store.listLeads() : [],
      store.listProposals ? store.listProposals() : [],
      store.listNotifications ? store.listNotifications(200) : [],
      listCorporateRecords(store, "tasks"),
      includeRecentActivity ? listCorporateRecords(store, "activities") : [],
      listCorporateRecords(store, "support"),
      listCorporateRecords(store, "projects"),
      listCorporateRecords(store, "portfolio"),
      listCorporateRecords(store, "private"),
      listCorporateRecords(store, "partnerships"),
    ]);
  const openTasks = tasks.filter((task) => !["done", "completed", "cancelled"].includes(String(task.status || "").toLowerCase()));
  const openSupport = support.filter((item) => !["resolved", "closed", "cancelled"].includes(String(item.status || "").toLowerCase()));
  const proposalAwaiting = proposals.filter((item) => ["sent", "awaiting_response"].includes(String(item.status || "").toLowerCase()));
  const hotLeads = leads.filter((lead) => Number(lead.score || lead.lead_score || 0) >= 70 || /follow|proposal|demo|meeting/i.test(String(lead.next_action || "")));
  const recent_activity = activities
    .filter((activity) => activity && !/debug|trace|internal/i.test(String(activity.activity_type || "")))
    .sort((a, b) => String(b.occurred_at || b.created_at || b.updated_at || "").localeCompare(String(a.occurred_at || a.created_at || a.updated_at || "")))
    .slice(0, 12)
    .map((activity) => ({
      id: activity.id,
      activity_type: activity.activity_type || "note",
      actor: activity.actor || activity.owner || "",
      related_object_type: activity.related_type || (activity.support_case_id ? "support_case" : activity.portfolio_id ? "portfolio" : activity.project_id ? "project" : activity.meeting_id ? "meeting" : activity.opportunity_id ? "opportunity" : activity.organization_id ? "organization" : activity.contact_id ? "contact" : activity.lead_id ? "lead" : null),
      related_object_id: activity.related_id || activity.support_case_id || activity.portfolio_id || activity.project_id || activity.meeting_id || activity.opportunity_id || activity.organization_id || activity.contact_id || activity.lead_id || null,
      title: activity.title || "Activity",
      summary: activity.body || activity.title || "Office activity",
      body: activity.body || activity.title || "Office activity",
      business_unit: activity.business_unit || null,
      created_at: activity.occurred_at || activity.created_at || activity.updated_at || null,
      priority: activity.priority || null,
    }));
  const attention_items = [
    ...openTasks.slice(0, 5).map((task) => {
      const related = task.private_relationship_id
        ? { related_object_type: "private_relationship", related_object_id: task.private_relationship_id }
        : task.partnership_relationship_id
          ? { related_object_type: "partnership_relationship", related_object_id: task.partnership_relationship_id }
          : task.support_case_id
            ? { related_object_type: "support_case", related_object_id: task.support_case_id }
            : task.project_id
              ? { related_object_type: "project", related_object_id: task.project_id }
              : task.portfolio_id
                ? { related_object_type: "portfolio", related_object_id: task.portfolio_id }
                : task.opportunity_id
                  ? { related_object_type: "opportunity", related_object_id: task.opportunity_id }
                  : task.lead_id
                    ? { related_object_type: "lead", related_object_id: task.lead_id }
                    : {};
      return { type: "task", id: task.id, title: task.title, priority: task.priority || "normal", owner: task.assignee || task.owner || "", ...related };
    }),
    ...openSupport.slice(0, 5).map((item) => ({ type: "support_case", id: item.id, title: item.title, priority: item.priority || item.severity || "normal", owner: item.assigned_staff || item.owner || "" })),
    ...proposalAwaiting.slice(0, 5).map((proposal) => ({ type: "proposal", id: proposal.id, title: proposal.title, priority: "follow_up", owner: proposal.lead?.owner || "" })),
    ...hotLeads.slice(0, 5).map((lead) => ({ type: "lead", id: lead.id, title: lead.company || lead.name || "Lead", priority: "follow_up", owner: lead.owner || "" })),
  ];
  return {
    summary: {
      attention_count: attention_items.length,
      open_tasks: openTasks.length,
      open_support_cases: openSupport.length,
      proposals_awaiting_response: proposalAwaiting.length,
      active_projects: projects.filter((item) => !["closed", "completed"].includes(String(item.status || "").toLowerCase())).length,
      portfolio_entries: portfolio.length,
      private_queue: privateRows.filter((item) => /review|pending|requested/i.test(String(item.status || item.review_status || ""))).length,
      partnership_queue: partnershipRows.filter((item) => /review|pending|prospect/i.test(String(item.status || item.review_status || ""))).length,
    },
    attention_items,
    recent_activity,
    oyi_core: {
      authority: "ochiga-backend",
      expected_surface: "office_internal",
      office_supplies_facts: true,
    },
  };
}

function validateCommercialDocumentDraft(input = {}) {
  const hasApprovedPricing =
    Boolean(input.approved_price_ref) ||
    Boolean(input.approved_template_id) ||
    Array.isArray(input.approved_line_items);
  return {
    allowed_to_price: hasApprovedPricing,
    pricing_status: hasApprovedPricing ? "approved_truth_available" : "requires_staff_input",
    warnings: hasApprovedPricing
      ? []
      : ["Pricing, discounts, and commercial terms require approved Office truth or staff input."],
  };
}

module.exports = {
  BUSINESS_UNITS,
  CORPORATE_COLLECTIONS,
  buildOfficeHomeProjection,
  createCorporateRecord,
  listCorporateRecords,
  upsertContactIdentity,
  validateCommercialDocumentDraft,
};
