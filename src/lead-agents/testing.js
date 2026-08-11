const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { createConfig } = require("./config");
const { FileLeadAgentsStore } = require("./store-file");
const { ToolExecutor } = require("./tools");
const { LeadAgentRuntime } = require("./runtime");
const { WebhookDispatcher } = require("./webhooks");

class MockOpenAIResponsesClient {
  constructor(script) {
    this.script = Array.isArray(script) ? [...script] : [];
  }

  async createResponse() {
    if (this.script.length === 0) {
      throw new Error("MockOpenAIResponsesClient script exhausted");
    }
    return this.script.shift();
  }
}

async function createTempStore() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lead-agents-test-"));
  const filePath = path.join(tempDir, "store.json");
  const store = new FileLeadAgentsStore(filePath);
  await store.init();
  return { store, filePath, tempDir };
}

async function runMockChatScenario(options = {}) {
  const config = {
    ...createConfig(),
    openaiApiKey: "test",
    storeDriver: "file",
    storePath: options.storePath,
    founderWebhookUrl: "",
    demoWebhookUrl: "",
  };

  const { store, filePath, tempDir } = await createTempStore();
  config.storePath = filePath;

  const mockClient = new MockOpenAIResponsesClient(
    options.script || [
      {
        output: [
          {
            type: "function_call",
            name: "update_lead_status",
            call_id: "call_1",
            arguments: JSON.stringify({
              status: "sales",
              owner: "sales_agent",
              score: 82,
              summary:
                "Lead: Ada | Company: Greenview Estates | Role: Operations Manager | Type: estate | Need: demo | Scale: 240 units | Fit: high | Route: sales_agent",
              next_action: "Sales follow-up for demo booking",
            }),
          },
        ],
      },
      {
        output_text:
          "Thanks. This looks relevant for our Sales team. I am handing this over so they can follow up on your request.",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Thanks. This looks relevant for our Sales team. I am handing this over so they can follow up on your request.",
              },
            ],
          },
        ],
      },
    ]
  );

  const webhooks = new WebhookDispatcher({ config });
  const toolExecutor = new ToolExecutor({
    store,
    config,
    log: () => {},
    webhooks,
  });
  const runtime = new LeadAgentRuntime({
    config,
    store,
    openaiClient: mockClient,
    toolExecutor,
    log: () => {},
  });

  const result = await runtime.runChat({
    agent: options.agent || "marketing",
    source: options.source || "website_chat",
    message:
      options.message ||
      "We manage a 240-unit estate and need better gate access and monitoring.",
    profile: {
      name: "Ada",
      company: "Greenview Estates",
      role: "Operations Manager",
      email: "ada@example.com",
      location: "Lagos",
      ...(options.profile || {}),
    },
  });

  return {
    result,
    store,
    filePath,
    tempDir,
  };
}

module.exports = {
  createTempStore,
  MockOpenAIResponsesClient,
  runMockChatScenario,
};
