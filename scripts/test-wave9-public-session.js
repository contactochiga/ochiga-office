const assert = require("node:assert/strict");
const http = require("node:http");
const { publicRequestIdentity, issuePublicSession } = require("../src/lead-agents/public-session-authority");
const { buildServer } = require("../src/lead-agents/server");
const { createConfig } = require("../src/lead-agents/config");
const { createTempStore } = require("../src/lead-agents/testing");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const listen = s => new Promise(resolve => s.listen(0, "127.0.0.1", () => resolve(s.address().port)));
const close = s => new Promise(resolve => s.close(resolve));
async function main() {
  const config = { ...createConfig(), sessionSecret: "isolated-wave9-test-signing-secret", authMode: "required_api_key", apiKeys: ["test-key"], allowedOrigins: [] };
  const unsigned = publicRequestIdentity(config, { lead_id: "victim", thread_id: "victim-thread", profile: { owner: "admin", notes: "forged" } });
  assert.equal(unsigned.lead_id, null);
  assert.equal(unsigned.thread_id, null);
  assert.deepEqual(unsigned.profile, {});
  const token = issuePublicSession(config, { session_id: "session-a", conversation_thread_id: "thread-a" }, "lead-a", 1000);
  assert.equal(publicRequestIdentity(config, { session_token: token, lead_id: "victim" }, 2000).lead_id, "lead-a");
  assert.throws(() => publicRequestIdentity(config, { session_token: token + "bad" }, 2000), /invalid_public_session/);
  assert.throws(() => publicRequestIdentity(config, { session_token: token }, 8 * 86400000), /invalid_public_session/);
  let received;
  const core = http.createServer((req, res) => {
    let body = ""; req.on("data", chunk => body += chunk);
    req.on("end", () => { received = JSON.parse(body); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, canonical: true, answer: "Public answer", conversation_thread_id: "11111111-1111-4111-a111-111111111111", tool_proposals: [] })); });
  });
  config.officeBackendBaseUrl = `http://127.0.0.1:${await listen(core)}`;
  config.officeBackendApiKey = "test-core-key";
  const { store } = await createTempStore();
  const victim = await store.createLead({ email: "victim@example.invalid", phone: "123", notes: "PRIVATE_STAFF_NOTE", summary: "PRIVATE_SUMMARY", status: "qualified" });
  const before = await store.getLead(victim.id);
  const server = buildServer({ config, store, rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 100 }), whatsappAdapter: {}, openaiClient: {}, toolExecutor: {} });
  const port = await listen(server);
  const send = async body => {
    const response = await fetch(`http://127.0.0.1:${port}/api/lead-agents/public/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const first = await send({ message: "What is Oyi?", lead_id: victim.id, thread_id: "victim-thread", profile: { email: victim.email, phone: victim.phone, notes: "ATTACK" } });
    assert.equal(first.status, 200);
    assert.notEqual(first.data.lead.id, victim.id);
    assert.deepEqual(await store.getLead(victim.id), before);
    assert.doesNotMatch(JSON.stringify(first.data), /PRIVATE_|ATTACK/);
    assert.equal(received.crm_context.safe_summary, null);
    const second = await send({ message: "Explain more", session_token: first.data.public_intelligence.session.session_token, lead_id: victim.id });
    assert.equal(second.status, 200);
    assert.equal(second.data.lead.id, first.data.lead.id);
    assert.equal(received.conversation_thread_id, "11111111-1111-4111-a111-111111111111");
    const invalid = await send({ message: "Hello", session_token: "bad.token" });
    assert.equal(invalid.status, 401);
    console.log("PASS public session: forged CRM IDs/contact matching denied; signed continuity; tamper/expiry; no private CRM projection");
  } finally { await close(server); await close(core); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
