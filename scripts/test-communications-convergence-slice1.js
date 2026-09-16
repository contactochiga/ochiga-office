// Oyi Communications Convergence, Slice 1 -- Office-side coverage.
// Real functional test of buildMaterialCrmEvent()'s new
// communication_context block, plus structural (source-text) proof of
// the two Office-side wiring changes this slice depends on: the
// single-responder deferral in processWhatsAppEvent() and the human-
// takeover check in the WhatsApp send bridge route. Matches this repo's
// established convention (see test-oyi-interaction-repositioning.js,
// test-oyi-core-delegation.js) of source-text assertions for
// office.js/server.js wiring that has no clean module boundary to
// import live.
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { buildMaterialCrmEvent } = require("../src/lead-agents/backend-events");

const root = path.resolve(__dirname, "..");

async function main() {
  // A. communication_context: captured, conservative contactability.
  const lead = {
    id: "lead-1",
    status: "new",
    commercial_stage: "intake_received",
    owner: "marketing_agent",
    primary_channel: "whatsapp",
    phone: "+2348100000001",
    whatsapp_phone: "+2348100000001",
    email: "ada@example.com",
    project_type: "land_jv",
  };
  const event = buildMaterialCrmEvent({ lead, envelope: { business_unit: "development", source_site: "ochiga_website" }, timelineEvent: {}, requestId: "req-1" });
  assert.ok(event.communication_context, "communication_context must be present on every material event");
  assert.equal(event.communication_context.primary_channel, "whatsapp");
  assert.equal(event.communication_context.phone, "+2348100000001");
  assert.equal(event.communication_context.whatsapp_phone, "+2348100000001");
  assert.equal(event.communication_context.email, "ada@example.com");
  // The load-bearing conservative default: Office has no structured
  // consent/opt-out column (per the Slice 1 audit), so contactability
  // must NEVER be "allowed" just because contact fields are present.
  assert.equal(event.communication_context.contactability, "unknown", "contactability must default to unknown, never inferred as allowed from field presence");

  // B. A lead with no contact fields at all still gets an honest,
  // non-fabricated communication_context (all nulls), never omitted.
  const bareEvent = buildMaterialCrmEvent({ lead: { id: "lead-2", status: "new" }, envelope: {}, timelineEvent: {}, requestId: "req-2" });
  assert.equal(bareEvent.communication_context.primary_channel, null);
  assert.equal(bareEvent.communication_context.whatsapp_phone, null);
  assert.equal(bareEvent.communication_context.contactability, "unknown");

  console.log("A/B. buildMaterialCrmEvent communication_context — PASS");

  // C. Structural: processWhatsAppEvent defers to an active Goal
  // (goalActive) BEFORE calling Core/sending directly, and this check
  // runs strictly after the existing human-takeover pause check (never
  // reordered ahead of it -- takeover remains the first gate).
  const serverSource = fs.readFileSync(path.join(root, "src/lead-agents/server.js"), "utf8");
  const fnStart = serverSource.indexOf("async function processWhatsAppEvent(");
  assert.ok(fnStart > 0, "processWhatsAppEvent must exist");
  const fnEnd = serverSource.indexOf("\nasync function bootstrapAdminUser", fnStart);
  const fnBody = serverSource.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);

  const pauseCheckIdx = fnBody.indexOf("channelState.ai_paused");
  const goalActiveCheckIdx = fnBody.indexOf("forwardResult.goalActive");
  const coreCallIdx = fnBody.indexOf("callOyiCoreCorporateConversation");
  const sendCallIdx = fnBody.indexOf("adapter.sendTextMessage(");

  assert.ok(pauseCheckIdx > 0, "the existing human-takeover pause check must still exist");
  assert.ok(goalActiveCheckIdx > pauseCheckIdx, "the goal-active deferral check must run AFTER the takeover pause check, never bypassing it");
  assert.ok(goalActiveCheckIdx < coreCallIdx && goalActiveCheckIdx < sendCallIdx, "the goal-active deferral must return before Office's own direct Core call/send -- single-responder rule");

  console.log("C. processWhatsAppEvent single-responder ordering (takeover -> goal-active -> direct reply) — PASS");

  // D. Structural: the WhatsApp send bridge route enforces human
  // takeover BEFORE calling the real provider adapter, for ANY
  // Oyi-generated send reaching it (Office's own loop or Backend's
  // CommunicationRuntime/GoalRuntime, now that WhatsAppAdapter forwards
  // lead_id specifically so this check can run).
  const takeoverCheckIdx = serverSource.indexOf('leadIdForTakeoverCheck = String(body.lead_id || "").trim()');
  const providerSendIdx = serverSource.indexOf("whatsappAdapter.sendTemplateMessage({");
  assert.ok(takeoverCheckIdx > 0, "the send bridge must read body.lead_id for the takeover check");
  assert.ok(takeoverCheckIdx < providerSendIdx, "the takeover check must run before the real provider dispatch, blocking it rather than hiding the result in UI");
  assert.ok(serverSource.includes('failure_reason: "human_takeover_active"'), "a blocked send must report the real reason, not a generic failure");

  console.log("D. WhatsApp send bridge takeover enforcement ordering — PASS");

  console.log("office communications convergence slice 1 smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
