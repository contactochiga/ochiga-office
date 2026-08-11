const assert = require("assert/strict");
const fs = require("fs");
const {
  buildPublicIntelligenceSession,
  detectBlockedPublicOperationalRequest,
} = require("../src/lead-agents/public-intelligence");
const {
  buildOyiCoreCorporateConversationRequest,
  callOyiCoreCorporateConversation,
  oyiCoreConversationUrl,
} = require("../src/lead-agents/oyi-core-gateway");
const { executeGovernedOfficeToolProposals } = require("../src/lead-agents/office-tool-governance");
const { createTempStore } = require("../src/lead-agents/testing");

function publicChatRouteSource() {
  const source = fs.readFileSync("src/lead-agents/server.js", "utf8");
  const start = source.indexOf('if (pathname === "/api/lead-agents/public/chat")');
  const end = source.indexOf('if (pathname === "/api/lead-agents/public/transcribe")');
  assert.ok(start > 0 && end > start, "public chat route segment must be discoverable");
  return source.slice(start, end);
}

async function main() {
  const route = publicChatRouteSource();
  assert.ok(route.includes("callOyiCoreCorporateConversation"), "public chat must call the Oyi Core gateway");
  assert.ok(!route.includes("runtime.runChat"), "public chat must not use Office LeadAgentRuntime reasoning");
  assert.ok(!route.includes("publicFallbackReply"), "public chat must not use independent fallback answers");
  assert.ok(route.includes("oyi_core_unavailable"), "public chat must expose controlled Oyi Core unavailability");

  assert.equal(
    oyiCoreConversationUrl({
      officeBackendBaseUrl: "https://oyi-os.onrender.com/",
      officeBackendConversationPath: "/office/conversation/corporate",
    }),
    "https://oyi-os.onrender.com/office/conversation/corporate"
  );

  const session = buildPublicIntelligenceSession({
    session_id: "public-session-1",
    conversation_thread_id: "oyi-thread-1",
    source_site: "ochiga_website",
    source_page: "/technology",
    message: "We manage six buildings and want Oyi deployment.",
  });
  const request = buildOyiCoreCorporateConversationRequest({
    session,
    message: "We manage six buildings and want Oyi deployment.",
    lead: { id: "lead-1", summary: "Six buildings interested in Oyi.", status: "new" },
    body: { profile: { email: "ada@example.com" } },
    requestId: "req-1",
  });
  assert.equal(request.public_session_id, "public-session-1");
  assert.equal(request.conversation_thread_id, "oyi-thread-1");
  assert.equal(request.public_identity, "ochiga_intelligence");
  assert.equal(request.agent_role, "osa");
  assert.equal(request.business_unit, "technology");
  assert.equal(request.visitor_state, "known");
  assert.equal(request.crm_context.lead_ref, "lead-1");
  assert.ok(!JSON.stringify(request).includes("another-person"));

  const voiceSession = buildPublicIntelligenceSession({
    session_id: session.session_id,
    conversation_thread_id: session.conversation_thread_id,
    source_channel: "voice",
    mode: "voice_conversation",
    message: "Can Oyi support my estate?",
  });
  const voiceRequest = buildOyiCoreCorporateConversationRequest({
    session: voiceSession,
    message: "Can Oyi support my estate?",
    lead: { id: "lead-1" },
    requestId: "req-voice",
  });
  assert.equal(voiceRequest.public_session_id, request.public_session_id);
  assert.equal(voiceRequest.conversation_thread_id, request.conversation_thread_id);
  assert.equal(voiceRequest.engagement_mode, "voice_conversation");

  let posted = null;
  const ok = await callOyiCoreCorporateConversation(
    {
      officeBackendBaseUrl: "https://backend.example",
      officeBackendConversationPath: "/office/conversation/corporate",
      officeBackendApiKey: "test-key",
      officeBackendEventTimeoutMs: 1111,
    },
    request,
    {
      httpPost: async (url, payload, config) => {
        posted = { url, payload, config };
        return {
          status: 200,
          data: {
            ok: true,
            canonical: true,
            answer: "Oyi supports existing estates through a governed deployment path.",
            conversation_thread_id: "oyi-thread-1",
            recommended_internal_role: "osa",
            tool_proposals: [],
          },
        };
      },
    }
  );
  assert.equal(ok.ok, true);
  assert.equal(posted.url, "https://backend.example/office/conversation/corporate");
  assert.equal(posted.config.headers["x-office-api-key"], "test-key");
  assert.equal(posted.config.headers["x-public-session-id"], "public-session-1");

  const unavailable = await callOyiCoreCorporateConversation(
    { officeBackendBaseUrl: "" },
    request
  );
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.unavailable, true);
  assert.equal(unavailable.reason, "not_configured");

  const { store } = await createTempStore();
  const lead = await store.createLead({
    name: "Ada",
    email: "ada@example.com",
    source: "website_chat",
    owner: "marketing_agent",
    status: "new",
    summary: "Technology enquiry.",
  });
  const governed = await executeGovernedOfficeToolProposals({
    store,
    lead,
    session,
    requestId: "req-1",
    proposals: [
      {
        proposal_id: "proposal-1",
        tool: "crm.create_opportunity",
        reason: "Visitor manages six buildings and asked for a deployment proposal.",
        parameters: {
          stage: "opportunity_introduced",
          inquiry_type: "oyi_deployment_request",
        },
      },
      {
        proposal_id: "proposal-2",
        tool: "devices.unlock_door",
        reason: "Should be rejected.",
      },
    ],
  });
  assert.equal(governed.results.length, 2);
  assert.equal(governed.results[0].status, "applied");
  assert.equal(governed.results[1].status, "rejected");
  assert.equal(governed.results[1].reason, "office_tool_not_allowed_for_public_surface");
  const updatedLead = await store.getLead(lead.id);
  assert.equal(updatedLead.owner, "sales_agent");
  assert.equal(updatedLead.commercial_stage, "opportunity_introduced");
  const timeline = await store.listTimelineForLead(lead.id);
  assert.ok(timeline.some((event) => event.event_type === "oyi_core_tool_proposal_applied"));

  assert.equal(detectBlockedPublicOperationalRequest({ message: "Unlock my front door." }).blocked, true);
  assert.equal(detectBlockedPublicOperationalRequest({ message: "What does Oyi do?" }).blocked, false);

  console.log("office Oyi Core delegation smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
