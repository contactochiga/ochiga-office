const { normalizeText } = require("./normalize-lead");
const { recommendPackage } = require("./commercial-ops");

const USD_TO_NGN = 1500;

const OYI_PRICING = {
  fx_assumption: "1 USD ≈ NGN 1,500. Confirm FX before client quote.",
  packages: [
    {
      name: "Oyi Core",
      assessment_usd: 500,
      deployment_usd: 3000,
      integration_from_usd: 1000,
      subscription_usd: 500,
      support_from_usd: 300,
      positioning: "Operational foundation for buildings moving away from WhatsApp, spreadsheets and paper logs.",
    },
    {
      name: "Oyi Operations",
      assessment_usd: 1000,
      deployment_usd: 7500,
      integration_from_usd: 3000,
      subscription_usd: 1250,
      support_from_usd: 750,
      positioning: "Service, utility, reporting and day-to-day management layer for active building operators.",
    },
    {
      name: "Oyi Infrastructure",
      assessment_usd: 2500,
      deployment_usd: 15000,
      integration_from_usd: 7500,
      subscription_usd: 3000,
      support_from_usd: 1500,
      positioning: "Camera, device, edge and physical infrastructure visibility for smart-building deployments.",
    },
    {
      name: "Oyi Command Center",
      assessment_usd: 7500,
      deployment_usd: 50000,
      integration_from_usd: 25000,
      subscription_usd: 8000,
      support_from_usd: null,
      positioning: "Multi-site command, portfolio operations and executive intelligence for enterprise and public-sector facilities.",
    },
  ],
};

function formatUsd(value) {
  if (value === null || value === undefined) return "Custom";
  return `$${Number(value).toLocaleString("en-US")}`;
}

function formatNairaFromUsd(value) {
  if (value === null || value === undefined) return "Custom";
  return `₦${Math.round(Number(value) * USD_TO_NGN).toLocaleString("en-NG")}`;
}

function extractUnitCount(text) {
  const value = String(text || "");
  const match = value.match(/(\d{1,5})\s*(unit|units|home|homes|building|buildings|apartment|apartments|room|rooms|tenant|tenants)/i);
  if (!match) return undefined;
  const units = Number(match[1]);
  return Number.isFinite(units) ? units : undefined;
}

function extractProjectType(text) {
  const value = String(text || "").toLowerCase();
  const pairs = [
    ["hotel", ["hotel", "resort", "serviced apartment"]],
    ["retail", ["mall", "retail", "plaza", "market"]],
    ["institution", ["campus", "school", "university", "hospital"]],
    ["government", ["government", "public", "authority", "ministry"]],
    ["industrial", ["warehouse", "factory", "industrial", "logistics"]],
    ["commercial building", ["office", "tower", "commercial"]],
    ["residential", ["estate", "residential", "apartment", "gated community"]],
    ["mixed-use building", ["mixed use", "mixed-use"]],
  ];
  for (const [label, keywords] of pairs) {
    if (keywords.some((keyword) => value.includes(keyword))) return label;
  }
  return "building";
}

function inferCommercialFacts(input) {
  const text = String(input || "");
  return {
    unit_count: extractUnitCount(text),
    project_type: extractProjectType(text),
  };
}

function selectPackage(input = {}) {
  const recommended = normalizeText(input.packageName || input.interest_package) || recommendPackage(input);
  return OYI_PRICING.packages.find((item) => item.name === recommended) || OYI_PRICING.packages[0];
}

function buildProposal({ unitCount, projectType, leadName, company, packageName, painPoints, timeline }) {
  const selected = selectPackage({
    packageName,
    interest_package: packageName,
    project_type: projectType,
    unit_count: unitCount,
    pain_points: painPoints,
  });
  const propertyLabel = normalizeText(projectType) || "modern building";
  const client = normalizeText(company || leadName) || "Client";
  const body = [
    `# ${selected.name} Proposal for ${client}`,
    "",
    "## Executive Summary",
    "Oyi by Ochiga is the Operating System for Modern Buildings. It connects occupants, operators, infrastructure, services and intelligence into one operational platform.",
    "",
    "## Client Overview",
    `- Property type: ${propertyLabel}`,
    unitCount ? `- Known scale: ${unitCount} units / spaces / occupants` : "- Known scale: to be confirmed during Building Review",
    painPoints ? `- Primary pain points: ${painPoints}` : "- Primary pain points: to be confirmed during discovery",
    "",
    "## Current Challenges",
    "- Disconnected communication, service, security, utility and operational workflows.",
    "- Limited cross-system visibility for managers and occupants.",
    "- Manual follow-up around visitors, maintenance, services and infrastructure state.",
    "",
    "## Recommended Oyi Package",
    selected.name,
    selected.positioning,
    "",
    "## Assessment / Site Review",
    "Ochiga should begin with a Building Review or Site Visit to confirm operational scope, user structure, infrastructure readiness, integration risk and deployment timeline.",
    "",
    "## Deployment Scope",
    "- Consumer OS",
    "- Facility OS",
    "- Building / estate / unit setup",
    "- Occupant and facility team onboarding",
    "- Visitors, maintenance, community, wallet, services and notifications where included",
    "",
    "## Integration Scope",
    "- Cameras, devices, access control, utilities, fiber and edge runtime are quoted after compatibility and site readiness review.",
    "",
    "## Intelligence Scope",
    "- Awareness summaries, operational timelines, predictions, workflows and executive visibility are activated from real connected data only.",
    "",
    "## Subscription / Support",
    `- Monthly subscription anchor: ${formatUsd(selected.subscription_usd)} / ${formatNairaFromUsd(selected.subscription_usd)}`,
    `- Support retainer: from ${formatUsd(selected.support_from_usd)} / ${formatNairaFromUsd(selected.support_from_usd)} where applicable`,
    "",
    "## Timeline",
    timeline || "Assessment and deployment timeline to be confirmed after Building Review.",
    "",
    "## Commercial Estimate",
    `- Assessment: ${formatUsd(selected.assessment_usd)} / ${formatNairaFromUsd(selected.assessment_usd)}`,
    `- Deployment: ${formatUsd(selected.deployment_usd)} / ${formatNairaFromUsd(selected.deployment_usd)}`,
    `- Integration: from ${formatUsd(selected.integration_from_usd)} / ${formatNairaFromUsd(selected.integration_from_usd)}`,
    `- Subscription: ${formatUsd(selected.subscription_usd)} / ${formatNairaFromUsd(selected.subscription_usd)} monthly`,
    "- Hardware: quoted separately",
    "",
    "## Next Steps",
    "1. Confirm decision-maker and site contact.",
    "2. Schedule Building Review / Site Visit.",
    "3. Finalize deployment scope and commercial approval.",
    "4. Create Facility workspace and onboarding plan after approval.",
  ].join("\n");

  return {
    tier_name: selected.name,
    unit_count: unitCount ? Number(unitCount) : null,
    monthly_price: selected.subscription_usd,
    currency: "USD",
    coverage_units: null,
    project_type: propertyLabel,
    title: `${selected.name} proposal for ${client}`,
    body,
    metadata: {
      positioning: "Oyi by Ochiga — The Operating System For Modern Buildings",
      commercial_model: ["Assessment", "Deployment", "Integration", "Intelligence", "Subscription"],
      pricing: OYI_PRICING,
      ngn_equivalent_monthly: selected.subscription_usd ? Number(selected.subscription_usd) * USD_TO_NGN : null,
    },
  };
}

module.exports = {
  OYI_PRICING,
  buildProposal,
  extractProjectType,
  extractUnitCount,
  formatNaira: formatNairaFromUsd,
  formatNairaFromUsd,
  formatUsd,
  inferCommercialFacts,
  selectPackage,
  selectTier: selectPackage,
};
