function normalizeText(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (["unknown", "n/a", "na", "none", "null", "undefined"].includes(text.toLowerCase())) {
    return "";
  }
  return text.replace(/\s+/g, " ");
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizePhone(value) {
  return normalizeText(value).replace(/[^\d+\-() ]/g, "");
}

function normalizeScore(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const score = Number(value);
  if (!Number.isFinite(score)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function normalizeSource(value, fallback) {
  const normalized = normalizeText(value);
  return normalized || normalizeText(fallback);
}

function normalizeLeadInput(input, fallbackSource) {
  return {
    name: normalizeText(input.name),
    company: normalizeText(input.company),
    role: normalizeText(input.role),
    email: normalizeEmail(input.email),
    phone: normalizePhone(input.phone),
    whatsapp_phone: normalizePhone(input.whatsapp_phone),
    primary_channel: normalizeText(input.primary_channel),
    source_channel: normalizeText(input.source_channel),
    source: normalizeSource(input.source, fallbackSource),
    location: normalizeText(input.location),
    city: normalizeText(input.city),
    country: normalizeText(input.country),
    unit_count:
      input.unit_count === undefined || input.unit_count === null || input.unit_count === ""
        ? undefined
        : Math.max(0, Math.round(Number(input.unit_count) || 0)),
    project_type: normalizeText(input.project_type),
    property_type: normalizeText(input.property_type),
    property_size: normalizeText(input.property_size),
    number_of_units:
      input.number_of_units === undefined || input.number_of_units === null || input.number_of_units === ""
        ? undefined
        : Math.max(0, Math.round(Number(input.number_of_units) || 0)),
    pain_points: normalizeText(input.pain_points),
    budget_range: normalizeText(input.budget_range),
    timeline: normalizeText(input.timeline),
    decision_maker_status: normalizeText(input.decision_maker_status),
    interest_package: normalizeText(input.interest_package),
    lead_score: normalizeScore(input.lead_score),
    qualification_status: normalizeText(input.qualification_status),
    stage: normalizeText(input.stage),
    status: normalizeText(input.status),
    owner: normalizeText(input.owner),
    commercial_stage: normalizeText(input.commercial_stage),
    lost_reason: normalizeText(input.lost_reason),
    score: normalizeScore(input.score),
    summary: normalizeText(input.summary),
    next_action: normalizeText(input.next_action),
    next_action_at: normalizeText(input.next_action_at),
    last_contact_at: normalizeText(input.last_contact_at),
    notes: normalizeText(input.notes),
  };
}

function normalizeLeadPatch(patch) {
  const normalized = normalizeLeadInput(patch, "");
  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== undefined)
  );
}

module.exports = {
  normalizeEmail,
  normalizeLeadInput,
  normalizeLeadPatch,
  normalizePhone,
  normalizeScore,
  normalizeSource,
  normalizeText,
};
