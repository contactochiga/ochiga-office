// Oyi Communication Actions Runtime -- generic recipient resolution.
//
// Office holds the authoritative CRM/staff data (Backend has no DB
// access here, same constraint that shapes every other Backend<->Office
// bridge in this system). This module is the search/match logic behind
// the POST /api/lead-agents/admin/recipients/resolve bridge route --
// Backend calls it with a name or role phrase pulled out of a
// conversation turn; this module is the ONLY place that touches
// admin_users/leads/crm_contacts for that purpose.
//
// NO PERSON NAMES ARE HARD-CODED ANYWHERE IN THIS FILE. Every match
// comes from querying the live directory/CRM tables at request time.
const { normalizeText } = require("./normalize-lead");

// Role-phrase detection is a small, generic keyword set describing JOB
// TITLE STRUCTURE (not people) -- "head of", "manager", "director",
// etc. are words that describe a position, never a specific person's
// name. This lets "the Head of Sales" route to office_position search
// instead of a name search, without hard-coding any actual title.
const ROLE_INDICATOR_WORDS = [
  "head of", "manager", "director", "officer", "lead", "chief",
  "coordinator", "supervisor", "administrator", "engineer", "architect",
  "operations", "sales", "support", "finance", "accountant", "assistant",
];

function looksLikeRolePhrase(query) {
  const q = String(query || "").toLowerCase();
  return ROLE_INDICATOR_WORDS.some((word) => q.includes(word));
}

function escapeIlike(value) {
  // PostgREST ilike pattern via query string -- escape characters that
  // would otherwise be interpreted as SQL LIKE wildcards or break the
  // filter syntax (comma/parenthesis are PostgREST operators).
  return String(value || "").replace(/[%_,()]/g, (c) => `\\${c}`).trim();
}

function availableChannels({ email, phone, whatsapp }) {
  const channels = [];
  if (email) channels.push("email");
  if (whatsapp) channels.push("whatsapp");
  if (phone) channels.push("sms");
  return channels;
}

function staffCandidate(row) {
  const email = row.email || null;
  return {
    recipient_id: `staff:${row.id}`,
    entity_type: "staff",
    entity_id: row.id,
    display_name: row.display_name || row.email || "Staff member",
    email,
    phone: null,
    whatsapp: null,
    organisation_id: null,
    organisation_name: "Ochiga",
    office_position: row.office_position || null,
    active: row.status !== "inactive" && row.status !== "disabled" && row.status !== "deactivated",
    source: "staff_directory",
    confidence: "high",
    confirmed: false,
    available_channels: availableChannels({ email, phone: null, whatsapp: null }),
  };
}

function leadCandidate(row) {
  const email = row.email || null;
  const phone = row.phone || null;
  const whatsapp = row.whatsapp_phone || null;
  return {
    recipient_id: `lead:${row.id}`,
    entity_type: "lead",
    entity_id: row.id,
    display_name: row.name || "Unnamed lead",
    email,
    phone,
    whatsapp,
    organisation_id: row.organization_id || null,
    organisation_name: row.company || null,
    active: true,
    source: "crm_lead",
    confidence: "high",
    confirmed: false,
    available_channels: availableChannels({ email, phone, whatsapp }),
  };
}

function contactCandidate(row, orgById) {
  const email = row.email || null;
  const phone = row.phone || null;
  const org = row.organization_id ? orgById.get(row.organization_id) : null;
  return {
    recipient_id: `contact:${row.id}`,
    entity_type: "contact",
    entity_id: row.id,
    display_name: row.name || "Unnamed contact",
    email,
    phone,
    whatsapp: null,
    organisation_id: row.organization_id || null,
    organisation_name: org?.name || null,
    active: true,
    source: "crm_contact",
    confidence: "high",
    confirmed: false,
    available_channels: availableChannels({ email, phone, whatsapp: null }),
  };
}

// Resolves a person/recipient from a name or role phrase against the
// authoritative directory/CRM tables. Never invents a candidate; a
// query that matches nothing returns status "not_found", not a guess.
async function resolveRecipient(store, { query, queryType }) {
  const raw = normalizeText(query);
  if (!raw) return { status: "not_found", candidates: [] };
  const pattern = `*${escapeIlike(raw)}*`;
  const wantsRole = queryType === "role" || (queryType !== "name" && looksLikeRolePhrase(raw));

  if (wantsRole) {
    const staffRows = await store.client
      .get(`/admin_users?office_position=ilike.${encodeURIComponent(pattern)}&status=eq.active&order=display_name.asc&limit=10`)
      .then((r) => r.data || []);
    if (staffRows.length) {
      const candidates = staffRows.map((row) => ({ ...staffCandidate(row), source: "role_resolution" }));
      return { status: candidates.length === 1 ? "resolved" : "ambiguous", candidates: candidates.slice(0, 5) };
    }
    // No role match -- fall through to a name search below (the phrase
    // may just happen to contain a role-shaped word while being someone's
    // actual name, e.g. a surname).
  }

  const [staffRows, leadRows, contactRows, orgRows] = await Promise.all([
    store.client.get(`/admin_users?display_name=ilike.${encodeURIComponent(pattern)}&order=display_name.asc&limit=10`).then((r) => r.data || []).catch(() => []),
    store.client.get(`/leads?name=ilike.${encodeURIComponent(pattern)}&order=updated_at.desc&limit=10`).then((r) => r.data || []).catch(() => []),
    store.client.get(`/crm_contacts?name=ilike.${encodeURIComponent(pattern)}&order=updated_at.desc&limit=10`).then((r) => r.data || []).catch(() => []),
    store.client.get(`/crm_organizations?select=id,name&limit=500`).then((r) => r.data || []).catch(() => []),
  ]);
  const orgById = new Map(orgRows.map((o) => [o.id, o]));

  const candidates = [
    ...staffRows.map(staffCandidate),
    ...leadRows.map(leadCandidate),
    ...contactRows.map((row) => contactCandidate(row, orgById)),
  ];

  if (candidates.length === 0) return { status: "not_found", candidates: [] };
  if (candidates.length === 1) return { status: "resolved", candidates };
  return { status: "ambiguous", candidates: candidates.slice(0, 6) };
}

// Resolves a SPECIFIC known entity (used when the conversation already
// has an active_lead_id/active_contact_id and just needs its current
// contact details refreshed, e.g. after "open the Daniel lead").
async function resolveRecipientByEntity(store, { entityType, entityId }) {
  if (!entityType || !entityId) return null;
  if (entityType === "lead") {
    const row = await store.client.get(`/leads?id=eq.${encodeURIComponent(entityId)}&limit=1`).then((r) => r.data?.[0] || null).catch(() => null);
    return row ? leadCandidate(row) : null;
  }
  if (entityType === "contact") {
    const [row, orgRows] = await Promise.all([
      store.client.get(`/crm_contacts?id=eq.${encodeURIComponent(entityId)}&limit=1`).then((r) => r.data?.[0] || null).catch(() => null),
      store.client.get(`/crm_organizations?select=id,name&limit=500`).then((r) => r.data || []).catch(() => []),
    ]);
    if (!row) return null;
    return contactCandidate(row, new Map(orgRows.map((o) => [o.id, o])));
  }
  if (entityType === "staff") {
    const row = await store.client.get(`/admin_users?id=eq.${encodeURIComponent(entityId)}&limit=1`).then((r) => r.data?.[0] || null).catch(() => null);
    return row ? staffCandidate(row) : null;
  }
  return null;
}

module.exports = {
  resolveRecipient,
  resolveRecipientByEntity,
  looksLikeRolePhrase,
};
