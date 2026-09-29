const { hasPermission } = require("./permissions");
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
function deny() { throw Object.assign(new Error("crm_memory_access_denied"), { statusCode: 403 }); }
async function recallCrmMemory({ store, actor, leadId, now = Date.now() }) {
  // Shared API keys and public sessions are not identified staff principals.
  if (!actor?.userId || actor.type !== "session" || !hasPermission(actor, "crm.read")) deny();
  const lead = await store.getLead(leadId);
  if (!lead || lead.id !== leadId) deny();
  for (const key of ["organization_id", "estate_id"]) {
    if ((lead[key] || null) !== (actor[key] || null)) deny();
  }
  // Agent labels/display names are never staff ownership evidence.
  if (lead.owner !== actor.userId && !hasPermission(actor, "crm.manage")) deny();
  const memory = await store.getLeadMemory(leadId);
  if (!memory) return null;
  if (memory.lead_id !== leadId) deny();
  for (const key of ["organization_id", "estate_id"]) {
    if ((memory[key] || null) !== (lead[key] || null)) deny();
  }
  const observed = Date.parse(memory.updated_at);
  if (!Number.isFinite(observed) || observed > now || now - observed >= RETENTION_MS) return null;
  // Never expose transcripts, staff notes, contact details, tool outputs or prompts.
  const known_fields = {};
  for (const key of ["business_unit", "inquiry_type", "project_type", "property_type"]) {
    if (typeof memory.known_fields?.[key] === "string") known_fields[key] = memory.known_fields[key].slice(0, 120);
  }
  return { lead_id: leadId, known_fields, updated_at: memory.updated_at,
    expires_at: new Date(observed + RETENTION_MS).toISOString(),
    provenance: "office.lead_memories", classification: "staff_private", trust: "context_only" };
}
module.exports = { recallCrmMemory, RETENTION_MS };
