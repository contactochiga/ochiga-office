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
      if (req.url.startsWith("/office/conversation/speech")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, audio_data_url: "data:audio/wav;base64,UklGRg==", mime_type: "audio/wav" }));
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
    openaiClient: {
      createTranscription: async ({ buffer, mimeType }) => {
        assert.ok(buffer.length >= 900);
        assert.equal(mimeType, "audio/webm");
        return { text: "What tasks are overdue?" };
      },
    },
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

    // C. Streaming is additive and contains only safe operational stage
    // identifiers emitted at real gateway/runtime boundaries. The final
    // result remains the same canonical Backend response.
    const streamRes = await fetch(`${base}/api/lead-agents/admin/office/intelligence/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson", cookie },
      body: JSON.stringify({ message: "What tasks are overdue?", page_context: { page: "tasks" } }),
    });
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get("content-type") || "", /application\/x-ndjson/);
    const events = (await streamRes.text()).trim().split("\n").map((line) => JSON.parse(line));
    const stages = events.filter((event) => event.type === "stage").map((event) => event.stage);
    assert.deepEqual(stages, ["checking_tasks", "checking_deadlines", "preparing_summary", "completed"]);
    assert.ok(events.every((event, index) => event.type !== "stage" || event.sequence === index + 1));
    assert.equal(events.at(-1).type, "result");
    assert.equal(events.at(-1).data.oyi_core.message, "This building has 20 homes, 15 active, with 1 open escalation.");
    console.log("C. Runtime stages stream sequentially from real boundaries before the canonical result — PASS");

    const leadStreamRes = await fetch(`${base}/api/lead-agents/admin/office/intelligence/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson", cookie },
      body: JSON.stringify({ message: "Show me the leads that need attention today.", page_context: { page: "crm" } }),
    });
    const leadEvents = (await leadStreamRes.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(
      leadEvents.filter((event) => event.type === "stage").map((event) => event.stage),
      ["reviewing_leads", "preparing_summary", "completed"],
      "an explicit leads request must not emit unrelated task/meeting stages"
    );
    console.log("C2. Explicit CRM intent suppresses unrelated domain stages — PASS");

    const audioDataUrl = `data:audio/webm;base64,${Buffer.alloc(1000, 1).toString("base64")}`;
    const transcriptionRes = await fetch(`${base}/api/lead-agents/admin/office/intelligence/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ audio_data_url: audioDataUrl, mime_type: "audio/webm", file_name: "turn.webm", duration_ms: 1200 }),
    });
    assert.equal(transcriptionRes.status, 200);
    assert.equal((await transcriptionRes.json()).text, "What tasks are overdue?");
    const speechRes = await fetch(`${base}/api/lead-agents/admin/office/intelligence/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "Two tasks are overdue." }),
    });
    assert.equal(speechRes.status, 200);
    assert.match((await speechRes.json()).audio_data_url, /^data:audio\/wav/);
    console.log("C3. Authenticated transcription and turn-based speech legs remain operational — PASS");

    // D. Ochiga Backend unreachable -> honest 503, never a locally
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
    console.log("D. Ochiga Backend outage returns an honest 503, no silent fallback answer — PASS");
  } finally {
    await close(server);
  }

  console.log("office Oyi Internal contextual delegation smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
