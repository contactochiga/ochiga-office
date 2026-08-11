const assert = require("assert");
const {
  backendEventUrl,
  buildMaterialCrmEvent,
  materialEventTypeForLead,
  publishBackendMaterialEvent,
} = require("../src/lead-agents/backend-events");

async function main() {
  const lead = {
    id: "lead-123",
    company: "Greenview Estates",
    project_type: "oyi_deployment",
    status: "new",
    commercial_stage: "intake_received",
    owner: "sales_agent",
  };
  const envelope = {
    request_id: "req-1",
    idempotency_key: "idem-1",
    submitted_at: "2026-08-11T09:00:00.000Z",
    source_channel: "website",
    source_site: "ochiga.com.ng",
    source_page: "/technology",
    source_form: "oyi_deployment",
    business_unit: "technology",
    inquiry_type: "oyi_deployment",
    organization: { name: "Greenview Estates" },
  };

  assert.equal(materialEventTypeForLead(lead, envelope), "technology_deployment_requested");

  const event = buildMaterialCrmEvent({
    lead,
    envelope,
    timelineEvent: { id: "timeline-1", created_at: "2026-08-11T09:01:00.000Z" },
    requestId: "request-context-1",
  });
  assert.equal(event.event_type, "technology_deployment_requested");
  assert.equal(event.idempotency_key, "idem-1");
  assert.equal(event.subject.id, "lead-123");
  assert.equal(event.source.site, "ochiga.com.ng");
  assert.equal(event.crm.lead_id, "lead-123");

  assert.equal(backendEventUrl({
    officeBackendBaseUrl: "https://oyi-os.onrender.com/",
    officeBackendEventPath: "/office/events/material",
  }), "https://oyi-os.onrender.com/office/events/material");

  const disabled = await publishBackendMaterialEvent({ officeBackendEventsEnabled: false }, event);
  assert.equal(disabled.skipped, true);
  assert.equal(disabled.reason, "disabled");

  let captured = null;
  const sent = await publishBackendMaterialEvent({
    officeBackendEventsEnabled: true,
    officeBackendBaseUrl: "https://backend.example",
    officeBackendEventPath: "/office/events/material",
    officeBackendApiKey: "test-api-key",
    officeBackendBearerToken: "test-bearer",
    officeBackendEventTimeoutMs: 1234,
  }, event, {
    httpPost: async (url, payload, config) => {
      captured = { url, payload, config };
      return { status: 202, data: { ok: true } };
    },
  });

  assert.equal(sent.ok, true);
  assert.equal(captured.url, "https://backend.example/office/events/material");
  assert.equal(captured.payload.event_id, event.event_id);
  assert.equal(captured.config.timeout, 1234);
  assert.equal(captured.config.headers["x-office-api-key"], "test-api-key");
  assert.equal(captured.config.headers.authorization, "Bearer test-bearer");
  assert.equal(captured.config.headers["x-idempotency-key"], "idem-1");

  console.log("office backend material events smoke passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
