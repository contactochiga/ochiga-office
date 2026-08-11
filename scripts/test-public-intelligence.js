const assert = require("assert/strict");
const {
  ALLOWED_CAPABILITIES,
  BLOCKED_OPERATIONAL_DOMAINS,
  CONTRACT_VERSION,
  buildOyiCoreCorporateRequest,
  buildPublicIntelligenceSession,
  createFormContinuationContext,
  createHumanHandoffTask,
  decideProactiveEngagement,
  detectBlockedPublicOperationalRequest,
  publicContextRef,
  routeBusinessContext,
  selectAgentRole,
} = require("../src/lead-agents/public-intelligence");
const { runMockChatScenario } = require("../src/lead-agents/testing");

async function main() {
  assert.equal(CONTRACT_VERSION, "corporate-intelligence.2026-08-11");

  const anonymous = buildPublicIntelligenceSession({
    source_site: "ochiga_website",
    source_page: "/technology",
    message: "What exactly does Oyi do?",
  });
  assert.equal(anonymous.anonymous, true);
  assert.equal(anonymous.business_unit, "technology");
  assert.equal(anonymous.active_agent_role, "oma");
  assert.equal(anonymous.runtime_agent, "marketing");
  assert.equal(anonymous.public_identity, "ochiga_intelligence");
  assert.equal(anonymous.oyi_core_authority, "ochiga-backend");
  assert.equal(anonymous.crm_source_of_truth, "ochiga-office");

  assert.equal(routeBusinessContext({ source_page: "/private", message: "I want membership" }).business_unit, "private");
  assert.equal(routeBusinessContext({ source_page: "/partnerships/landowners", message: "We have land for JV" }).business_unit, "development");
  assert.equal(routeBusinessContext({ source_page: "/partnerships/capital", message: "Capital partner" }).business_unit, "partnerships");
  assert.equal(routeBusinessContext({ source_page: "/contact", message: "General press enquiry" }).business_unit, "corporate");

  const sales = selectAgentRole({
    business_unit: "technology",
    inquiry_type: "oyi_deployment_request",
    message: "We manage four apartment buildings and want a deployment proposal.",
  });
  assert.equal(sales.agent_role, "osa");
  assert.equal(sales.runtime_agent, "sales");

  const salesSession = buildPublicIntelligenceSession({
    source_site: "ochiga_website",
    source_page: "/technology",
    message: "We manage four apartment buildings and want a deployment proposal.",
  });
  assert.equal(salesSession.active_agent_role, "osa");
  assert.equal(salesSession.runtime_agent, "sales");

  const oyiCoreRequest = buildOyiCoreCorporateRequest(salesSession, "Can this be installed?");
  assert.equal(oyiCoreRequest.surface, "public_corporate");
  assert.equal(oyiCoreRequest.agent_role, "osa");
  assert.deepEqual(oyiCoreRequest.capability_allowlist, ALLOWED_CAPABILITIES);
  assert.deepEqual(oyiCoreRequest.blocked_operational_domains, BLOCKED_OPERATIONAL_DOMAINS);

  const blocked = detectBlockedPublicOperationalRequest({ message: "Unlock my front door and show visitor codes." });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, "public_surface_operational_capability_blocked");
  assert.equal(detectBlockedPublicOperationalRequest({ message: "Can Oyi help an estate?" }).blocked, false);

  const continuation = createFormContinuationContext({
    request_id: "req-1",
    idempotency_key: "idem-1",
    business_unit: "private",
    inquiry_type: "membership_request",
  }, { id: "lead-1" });
  assert.match(continuation.public_context_ref, /^pubctx_[a-f0-9]{24}$/);
  assert.ok(!continuation.public_context_ref.includes("lead-1"));
  assert.equal(publicContextRef("idem-1|lead-1"), continuation.public_context_ref);

  const proactive = decideProactiveEngagement({
    source_page: "/technology",
    session_duration_ms: 120000,
    interaction_depth: 2,
  });
  assert.equal(proactive.eligible, true);
  assert.equal(decideProactiveEngagement({ previous_dismissal_at: new Date().toISOString() }).eligible, false);

  const handoff = createHumanHandoffTask({ session: salesSession, lead_id: "lead-1" });
  assert.equal(handoff.type, "human_handoff_requested");
  assert.equal(handoff.status, "task_created");
  assert.equal(handoff.metadata.agent_role, "osa");

  const textSession = buildPublicIntelligenceSession({ session_id: "session-1", conversation_thread_id: "thread-1", message: "hello" });
  const voiceSession = buildPublicIntelligenceSession({
    session_id: textSession.session_id,
    conversation_thread_id: textSession.conversation_thread_id,
    source_channel: "voice",
    mode: "voice_conversation",
    message: "hello",
  });
  assert.equal(voiceSession.session_id, textSession.session_id);
  assert.equal(voiceSession.conversation_thread_id, textSession.conversation_thread_id);
  assert.equal(voiceSession.voice_state, "ready");

  const { result } = await runMockChatScenario({
    agent: salesSession.runtime_agent,
    corporate_context: salesSession,
    message: "We manage a 240-unit estate and want a demo proposal.",
  });
  assert.equal(result.agent, "sales_agent");
  assert.ok(result.assistant_message);

  console.log("office public intelligence smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
