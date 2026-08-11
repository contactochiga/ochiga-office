const { normalizeEmail, normalizePhone, normalizeText } = require("./normalize-lead");

const PIPELINE_STAGES = Object.freeze([
  "new",
  "contacted",
  "qualified",
  "discovery_scheduled",
  "site_visit_scheduled",
  "proposal_sent",
  "negotiation",
  "commercial_approved",
  "won",
  "lost",
]);

const LEAD_SOURCES = Object.freeze([
  "website",
  "widget",
  "whatsapp",
  "linkedin",
  "meta",
  "facebook",
  "instagram",
  "google",
  "referral",
  "manual",
]);

const OYI_PACKAGES = Object.freeze([
  "Oyi Core",
  "Oyi Operations",
  "Oyi Infrastructure",
  "Oyi Command Center",
]);

const PARTNER_TYPES = Object.freeze([
  "referral",
  "deployment",
  "CCTV integrator",
  "fiber provider",
  "facility management company",
  "access control integrator",
  "smart building integrator",
  "strategic partner",
]);

const PARTNER_TIERS = Object.freeze(["founding", "bronze", "silver", "gold", "platinum"]);

function normalizeStage(value, fallback = "new") {
  const normalized = normalizeText(value).toLowerCase().replace(/[\s-]+/g, "_");
  return PIPELINE_STAGES.includes(normalized) ? normalized : fallback;
}

function normalizeSourceChannel(value, fallback = "manual") {
  const normalized = normalizeText(value).toLowerCase().replace(/[\s-]+/g, "_");
  return LEAD_SOURCES.includes(normalized) ? normalized : fallback;
}

function inferPropertyType(input = {}) {
  const text = [input.property_type, input.project_type, input.summary, input.notes, input.company]
    .map((item) => String(item || "").toLowerCase())
    .join(" ");
  if (/hotel|resort|serviced apartment/.test(text)) return "hotel";
  if (/mall|retail|plaza|market/.test(text)) return "retail";
  if (/campus|school|university|hospital|church|mosque/.test(text)) return "institution";
  if (/government|public|ministry|authority/.test(text)) return "government";
  if (/warehouse|factory|industrial|logistics/.test(text)) return "industrial";
  if (/office|tower|commercial/.test(text)) return "commercial building";
  if (/estate|residential|apartment|homes|villa/.test(text)) return "residential";
  return normalizeText(input.property_type || input.project_type) || "building";
}

function recommendPackage(input = {}) {
  const text = [input.pain_points, input.summary, input.notes, input.existing_infrastructure]
    .map((item) => String(item || "").toLowerCase())
    .join(" ");
  const size = Number(input.property_size || input.number_of_units || input.unit_count || 0);
  if (/multi[-\s]?site|portfolio|government|command center|executive|digital twin/.test(text) || size >= 1000) {
    return "Oyi Command Center";
  }
  if (/camera|cctv|dvr|nvr|access control|sensor|device|edge|automation|fiber|infrastructure/.test(text) || size >= 350) {
    return "Oyi Infrastructure";
  }
  if (/utility|service|wallet|payment|report|analytics|operations|maintenance/.test(text) || size >= 120) {
    return "Oyi Operations";
  }
  return "Oyi Core";
}

function scoreLead(input = {}) {
  let score = 0;
  if (normalizeText(input.company)) score += 10;
  if (normalizeText(input.email) || normalizeText(input.phone) || normalizeText(input.whatsapp_phone)) score += 10;
  if (normalizeText(input.property_type || input.project_type)) score += 10;
  if (normalizeText(input.location || input.city)) score += 8;
  if (Number(input.property_size || input.number_of_units || input.unit_count || 0) > 0) score += 12;
  if (normalizeText(input.pain_points || input.summary)) score += 15;
  if (normalizeText(input.budget_range)) score += 10;
  if (normalizeText(input.timeline)) score += 10;
  if (/owner|founder|ceo|director|manager|decision|admin/i.test(String(input.decision_maker_status || input.role || ""))) score += 10;
  if (/urgent|immediate|this month|now|proposal|quote|pricing|site visit|assessment|deployment/i.test(String(input.summary || input.next_action || ""))) score += 5;
  return Math.max(0, Math.min(100, score));
}

function qualificationStatus(score) {
  if (score >= 75) return "qualified";
  if (score >= 50) return "needs_discovery";
  if (score >= 25) return "nurture";
  return "unqualified";
}

function buildLeadCommercialPatch(input = {}) {
  const score = Number.isFinite(Number(input.lead_score || input.score))
    ? Number(input.lead_score || input.score)
    : scoreLead(input);
  const status = qualificationStatus(score);
  const recommendedPackage = normalizeText(input.interest_package) || recommendPackage(input);
  return {
    property_type: inferPropertyType(input),
    source_channel: normalizeSourceChannel(input.source_channel || input.primary_channel || input.source, "manual"),
    city: normalizeText(input.city),
    country: normalizeText(input.country) || "Nigeria",
    property_size: normalizeText(input.property_size),
    number_of_units: input.number_of_units ?? input.unit_count ?? null,
    pain_points: normalizeText(input.pain_points || input.summary),
    budget_range: normalizeText(input.budget_range),
    timeline: normalizeText(input.timeline),
    decision_maker_status: normalizeText(input.decision_maker_status || input.role),
    interest_package: recommendedPackage,
    lead_score: score,
    score,
    qualification_status: normalizeText(input.qualification_status) || status,
    stage: normalizeStage(input.stage || (status === "qualified" ? "qualified" : "new")),
    next_action:
      normalizeText(input.next_action) ||
      (status === "qualified" ? "Schedule discovery call or building review" : "Collect missing qualification details"),
  };
}

function qualifyLead(lead = {}, context = {}) {
  const patch = buildLeadCommercialPatch({ ...lead, ...context });
  return {
    qualification_score: patch.lead_score,
    qualification_status: patch.qualification_status,
    recommended_package: patch.interest_package,
    recommended_next_action: patch.next_action,
    summary: `${patch.property_type || "Building"} opportunity for ${patch.interest_package}. ${patch.pain_points || lead.summary || "Operational needs require discovery."}`,
    objections_or_risks: [
      !patch.budget_range ? "Budget not confirmed" : "",
      !patch.timeline ? "Timeline not confirmed" : "",
      !patch.decision_maker_status ? "Decision maker not confirmed" : "",
    ].filter(Boolean),
    patch,
  };
}

function normalizePartner(input = {}) {
  return {
    partner_company: normalizeText(input.partner_company || input.company),
    partner_type: normalizeText(input.partner_type || input.type) || "referral",
    tier: normalizeText(input.tier).toLowerCase() || "founding",
    contact_name: normalizeText(input.contact_name || input.name),
    contact_email: normalizeEmail(input.contact_email || input.email),
    contact_phone: normalizePhone(input.contact_phone || input.phone),
    city: normalizeText(input.city),
    country: normalizeText(input.country) || "Nigeria",
    status: normalizeText(input.status) || "prospect",
    certification_status: normalizeText(input.certification_status) || "not_started",
    leads_referred: Number(input.leads_referred || 0),
    deployments_supported: Number(input.deployments_supported || 0),
    revenue_share_terms: normalizeText(input.revenue_share_terms),
    notes: normalizeText(input.notes),
  };
}

function buildDeploymentFromLead(lead = {}, input = {}) {
  return {
    lead_id: lead.id,
    customer_name: normalizeText(input.customer_name || lead.company || lead.name),
    property_name: normalizeText(input.property_name || lead.company || lead.project_type || lead.property_type),
    property_type: inferPropertyType({ ...lead, ...input }),
    location: normalizeText(input.location || lead.location),
    package_name: normalizeText(input.package_name || lead.interest_package) || recommendPackage(lead),
    status: normalizeText(input.status) || "created",
    owner: normalizeText(input.owner || lead.owner) || "sales_agent",
    checklist: input.checklist || {
      customer_organization: "pending",
      facility_workspace: "pending_manual_approval",
      facility_admin_invite: "pending",
      building_review: "pending",
      deployment_plan: "pending",
      onboarding_email: "pending",
    },
    notes: normalizeText(input.notes),
  };
}

module.exports = {
  LEAD_SOURCES,
  OYI_PACKAGES,
  PARTNER_TIERS,
  PARTNER_TYPES,
  PIPELINE_STAGES,
  buildDeploymentFromLead,
  buildLeadCommercialPatch,
  normalizePartner,
  normalizeSourceChannel,
  normalizeStage,
  qualifyLead,
  recommendPackage,
  scoreLead,
};
