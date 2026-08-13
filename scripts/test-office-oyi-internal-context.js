const assert = require("node:assert/strict");
const http = require("node:http");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");

// Verifies the live Office -> Ochiga Backend -> Oyi Core delegation path
// for the office_internal surface (the Oyi panel staff use inside
// Office): page_context and the selected object's safe crm_context/
// portfolio_context/support_context reach Ochiga Backend intact, the
// canonical response is passed straight back with no local Office
// OpenAI "second brain", and an unreachable backend produces an honest
// 503 rather than a silent fallback answer.

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

function startFakeOchigaBackend() {
  let lastRequest = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      lastRequest = {
        url: req.url,
        headers: req.headers,
        body: body ? JSON.parse(body) : {},
      };
      if (req.url.startsWith("/office/conversation/internal")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          message: "This building has 20 homes, 15 active, with 1 open escalation.",
          conversation_thread_id: "oyi-thread-office-1",
          business_domain: "portfolio",
          attention_signal: "normal",
          tool_proposals: [],
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  return { server, getLastRequest: () => lastRequest };
}

async function main() {
  const { server: fakeBackend, getLastRequest } = startFakeOchigaBackend();
  const backendPort = await listen(fakeBackend);

  const config = {
    ...createConfig(),
    authMode: "required_api_key",
    apiKeys: ["oyi-internal-test-key"],
    allowedOrigins: [],
    officeBackendBaseUrl: `http://127.0.0.1:${backendPort}`,
    officeBackendApiKey: "office-internal-projection-key",
    officeBackendInternalConversationPath: "/office/conversation/internal",
  };
  const { store } = await createTempStore();
  await store.ensureAdminUser({
    email: "super@ochiga.local",
    password_hash: hashPassword("super-pass-123"),
    role: "super_admin",
    display_name: "Super Test",
    status: "active",
  });

  const webhooks = new WebhookDispatcher({ config });
  const toolExecutor = new ToolExecutor({ store, config, log: () => {}, webhooks });
  const server = buildServer({
    config,
    store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 100 }),
    publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 100 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 300 }),
    loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 50 }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] },
    openaiClient: {},
    toolExecutor,
  });

  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  try {
    const loginRes = await fetch(`${base}/api/lead-agents/admin/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "super@ochiga.local", password: "super-pass-123" }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get("set-cookie").split(";")[0];

    // A. A Portfolio-context message reaches Ochiga Backend with
    // page_context, portfolio_context (the safe aggregate summary), and
    // the x-office-api-key credential header — and the canonical answer
    // comes straight back.
    const chatRes = await fetch(`${base}/api/lead-agents/admin/office/intelligence/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        message: "How is this building doing operationally?",
        page_context: { page: "portfolio", selected_type: "portfolio", selected_id: "port_1" },
        portfolio_context: {
          portfolio_ref: "port_1",
          backend_building_ref: "building_1",
          safe_summary: "Block A · Customer Building. Operational: 20 homes (15 active), 6 devices (5 online), 0 major open escalations.",
        },
      }),
    });
    assert.equal(chatRes.status, 200);
    const chatBody = await chatRes.json();
    assert.equal(chatBody.oyi_core.message, "This building has 20 homes, 15 active, with 1 open escalation.");
    console.log("A. Office Internal chat returns Ochiga Backend's canonical response verbatim — PASS");

    const sent = getLastRequest();
    assert.equal(sent.url, "/office/conversation/internal");
    assert.equal(sent.headers["x-office-api-key"], "office-internal-projection-key");
    assert.equal(sent.body.page_context.page, "portfolio");
    assert.equal(sent.body.page_context.selected_type, "portfolio");
    assert.equal(sent.body.page_context.selected_id, "port_1");
    assert.equal(sent.body.portfolio_context.portfolio_ref, "port_1");
    assert.ok(sent.body.portfolio_context.safe_summary.includes("15 active"));
    assert.equal(sent.body.portfolio_context.safe_summary.includes("wallet"), false, "safe_summary must never carry raw Facility fields");
    console.log("B. Ochiga Backend receives page_context + portfolio_context intact, with the correct credential header — PASS");

    // C. Ochiga Backend unreachable -> honest 503, never a locally
    // generated fallback answer.
    await close(fakeBackend);
    const outageRes = await fetch(`${base}/api/lead-agents/admin/office/intelligence/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message: "How is this building doing?", page_context: { page: "portfolio" } }),
    });
    assert.equal(outageRes.status, 503);
    const outageBody = await outageRes.json();
    assert.equal(outageBody.error, "oyi_core_unavailable");
    assert.ok(!("message" in outageBody) || outageBody.message.includes("unavailable"), "must not silently substitute a generated answer");
    console.log("C. Ochiga Backend outage returns an honest 503, no silent fallback answer — PASS");
  } finally {
    await close(server);
  }

  console.log("office Oyi Internal contextual delegation smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
