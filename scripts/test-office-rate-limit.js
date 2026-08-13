const assert = require("node:assert/strict");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function postPublicSession(base, message) {
  return fetch(`${base}/api/lead-agents/public/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, source: "rate-limit-test" }),
  });
}

async function main() {
  process.env.LEAD_AGENTS_API_KEYS = "alpha-key; beta-key\n gamma-key";
  const baseConfig = createConfig();
  const config = {
    ...baseConfig,
    authMode: "required_api_key",
    apiKeys: baseConfig.apiKeys,
    allowedOrigins: [],
    publicWidgetMaxMessageChars: 1800,
  };
  assert.deepEqual(config.apiKeys, ["alpha-key", "beta-key", "gamma-key"]);

  const { store } = await createTempStore();
  const webhooks = new WebhookDispatcher({ config });
  const toolExecutor = new ToolExecutor({ store, config, log: () => {}, webhooks });
  const server = buildServer({
    config,
    store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 5 }),
    publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 2 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 80 }),
    loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 10 }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] },
    openaiClient: {},
    toolExecutor,
  });

  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await postPublicSession(base, "hello")).status, 201);
    assert.equal((await postPublicSession(base, "hello again")).status, 201);
    assert.equal(
      (await postPublicSession(base, "limited")).status,
      429,
      "public widget limiter must still protect anonymous routes"
    );

    for (let i = 0; i < 25; i += 1) {
      const response = await fetch(`${base}/api/lead-agents/admin/crm/contacts`, {
        headers: { "x-office-api-key": "beta-key" },
      });
      assert.equal(
        response.status,
        200,
        `authenticated Office burst request ${i + 1} should not hit public/general limit`
      );
      assert.notEqual(response.headers.get("x-ratelimit-remaining"), null);
    }

    const intake = await fetch(`${base}/api/office/intake`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-office-api-key": "gamma-key",
      },
      body: JSON.stringify({
        request_id: "rate-limit-intake-1",
        idempotency_key: "rate-limit-intake-1",
        source_channel: "website",
        source_site: "ochiga_website",
        source_page: "/contact",
        source_form: "general_contact",
        business_unit: "corporate",
        inquiry_type: "general_contact",
        contact: { name: "Rate Limit Test", email: "rate-limit@example.com", phone: "" },
        organization: { name: "", location: "" },
        payload: { message: "Testing Office intake API key alias." },
        consent: { marketing_followup: true },
      }),
    });
    assert.equal(intake.status, 201, "Office intake must accept the explicit x-office-api-key alias and create a new record");
  } finally {
    await close(server);
  }

  console.log("office rate-limit and intake auth smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
