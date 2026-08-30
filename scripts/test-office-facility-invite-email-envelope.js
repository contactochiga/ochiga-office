const assert = require("node:assert/strict");
const http = require("node:http");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");

// Production incident: every Facility owner invitation (initial
// provisioning AND resend) has always failed with missing_recipient,
// because facilityOwnerInviteEmail(...) only builds email content
// (subject/text/html) -- like staffInviteEmail, it never sets `to` --
// and both call sites in server.js passed that return value straight
// through to sendOfficeEmail() with no `to` ever attached to the
// envelope. staffInviteEmail's caller has always explicitly built
// { to: invite.email, ...inviteMessage } before sending; the Facility
// owner-invite callers did not. This test proves the fix at the real
// network boundary: it intercepts only the actual outbound fetch() to
// Resend's API (never Office's own routes, and never the fake Backend,
// both of which are exercised for real through the genuine HTTP server)
// and asserts the exact persisted invited email arrives as the request
// body's `to` field -- not a mock of sendOfficeEmail itself.

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
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : {};
    calls.push({ method: req.method, url: req.url, body });

    if (req.url === "/office/facility/provision" && req.method === "POST") {
      if (!body.name || !body.admin_email) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "name_and_admin_email_required" }));
        return;
      }
      const estateId = body.name === "No Recipient Facility" ? "estate_no_email_1" : "estate_envelope_1";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        estate: { id: estateId, name: body.name },
        invite: { id: `invite_${estateId}`, expires_at: "2026-09-15T00:00:00.000Z" },
        activation_token: "raw-activation-token-envelope",
      }));
      return;
    }
    if (req.url === "/office/facility/estates/estate_envelope_1/owner-invite/resend" && req.method === "POST") {
      // Backend's own canonical invite row, returned in full on resend --
      // this is the persisted invited_email the fix must thread through.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        invite: { id: "invite_estate_envelope_1", invited_email: "owner@example.com", expires_at: "2026-09-20T00:00:00.000Z" },
        activation_token: "raw-rotated-token-envelope",
      }));
      return;
    }
    if (req.url === "/office/facility/estates/estate_no_email_1/owner-invite/resend" && req.method === "POST") {
      // Edge case: Backend's resend response with no invited_email at
      // all (e.g. a data anomaly) -- the recipient must be genuinely
      // absent, not fabricated, and sendOfficeEmail must refuse to send
      // rather than silently mis-addressing or crashing.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        invite: { id: "invite_estate_no_email_1", invited_email: null, expires_at: "2026-09-20T00:00:00.000Z" },
        activation_token: "raw-rotated-token-no-email",
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  return { server, calls };
}

async function main() {
  const { server: fakeBackend, calls: backendCalls } = startFakeOchigaBackend();
  const backendPort = await listen(fakeBackend);

  const config = {
    ...createConfig(),
    authMode: "required_api_key",
    apiKeys: ["envelope-test-key"],
    allowedOrigins: [],
    officeBackendBaseUrl: `http://127.0.0.1:${backendPort}`,
    officeBackendApiKey: "backend-envelope-test-key",
    // Deliberately distinct from facilityAppUrl below -- proves the
    // activation link generation must not fall back to this field.
    // officeFacilityBaseUrl is Office->Backend's own "facility export"
    // API surface, a completely different, unrelated origin that only
    // happens to share the word "facility" (production incident: the
    // activation email sent owners to this host instead).
    officeFacilityBaseUrl: "https://wrong-host-office-to-backend-export-api.example",
    facilityAppUrl: "https://facility.example.oyi",
    // Deliberately real-provider-shaped, unlike the plain provisioning
    // test -- this test exists specifically to prove the send envelope
    // reaches Resend's request correctly, so the provider path must
    // actually be attempted, not short-circuited by "not configured".
    officeEmailProvider: "resend",
    resendApiKey: "test-resend-key-not-real",
  };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super Test", status: "active" });

  const webhooks = new WebhookDispatcher({ config });
  const toolExecutor = new ToolExecutor({ store, config, log: () => {}, webhooks });
  const server = buildServer({
    config,
    store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 200 }),
    publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 200 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 300 }),
    loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 50 }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] },
    openaiClient: {},
    toolExecutor,
  });

  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  // Selective interception -- only the real outbound call to Resend's
  // API is captured/faked. Every other fetch() (including this test's
  // own calls into the local Office server below) passes through to the
  // real global fetch untouched.
  const originalFetch = global.fetch;
  const resendCalls = [];
  global.fetch = async (url, options) => {
    if (String(url).startsWith("https://api.resend.com")) {
      const requestBody = JSON.parse(options?.body || "{}");
      resendCalls.push({ url: String(url), headers: options?.headers || {}, body: requestBody });
      return { ok: true, json: async () => ({ id: "fake-resend-message-id" }) };
    }
    return originalFetch(url, options);
  };

  async function login(email, password) {
    const res = await fetch(`${base}/api/lead-agents/admin/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 200, `login must succeed for ${email}`);
    return res.headers.get("set-cookie").split(";")[0];
  }

  try {
    const cookie = await login("super@ochiga.local", "super-pass-123");

    // A. Initial provisioning with a valid persisted invited email:
    // sendOfficeEmail must actually reach Resend, and Resend's request
    // body's `to` must be exactly that persisted email -- not undefined,
    // not empty, not a different field name.
    const portfolioRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Envelope Test Facility" }),
    });
    const portfolioId = (await portfolioRes.json()).record.id;

    const provisionRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio/${portfolioId}/provision-facility`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ estate_name: "Envelope Test Facility", facility_admin_email: "owner@example.com" }),
    });
    assert.equal(provisionRes.status, 201);
    const provisionBody = await provisionRes.json();
    assert.equal(resendCalls.length, 1, "provisioning with a valid recipient must actually call Resend, not skip it");
    assert.equal(resendCalls[0].body.to, "owner@example.com", "sendOfficeEmail must receive the exact persisted invited email as its recipient");
    assert.equal(provisionBody.provisioning.ok, true);
    assert.equal(provisionBody.workspace.status, "invitation_sent", "a real, accepted send must produce the delivered status, not invitation_undelivered");
    assert.equal(provisionBody.workspace.checklist.onboarding_email, "sent");
    // Production incident: the activation link previously pointed at
    // officeFacilityBaseUrl (Office->Backend's own facility-export API
    // surface), sending owners to a raw API host with no matching route.
    // It must be built from facilityAppUrl (the real facility-oyi
    // frontend) instead, and the token must survive URL construction
    // intact (exact match, not truncated/mangled by encoding).
    assert.equal(
      provisionBody.workspace.activation_link,
      "https://facility.example.oyi/facility-invite?token=raw-activation-token-envelope",
      "the activation link must point at facilityAppUrl, never officeFacilityBaseUrl, with the token surviving URL construction exactly"
    );
    console.log("A. Provisioning threads the persisted invited email into the real send envelope, Resend accepts, status is honestly delivered — PASS");

    // B. Resend Invite on the same record: the second call site must
    // also thread the recipient through -- this time sourced from
    // Backend's own resend response (invite.invited_email), proving both
    // call sites are fixed independently, not just one.
    const resendInviteRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio/${portfolioId}/facility-invite/resend`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
    });
    assert.equal(resendInviteRes.status, 200);
    const resendInviteBody = await resendInviteRes.json();
    assert.equal(resendCalls.length, 2, "Resend Invite must also actually call Resend");
    assert.equal(resendCalls[1].body.to, "owner@example.com", "the resend call site must thread Backend's persisted invited_email into the recipient, matching the original");
    assert.equal(resendInviteBody.email_delivered, true);
    const afterResendList = await (await fetch(`${base}/api/lead-agents/admin/office/portfolio`, { headers: { cookie } })).json();
    const afterResendWorkspace = afterResendList.collection.find((p) => p.id === portfolioId).facility_workspace;
    assert.equal(
      afterResendWorkspace.activation_link,
      "https://facility.example.oyi/facility-invite?token=raw-rotated-token-envelope",
      "the resend call site's activation link must also use facilityAppUrl with the rotated token intact"
    );
    console.log("B. Resend Invite also threads the persisted invited email into the real send envelope — PASS");

    // C. A genuinely absent recipient (Backend's resend response with no
    // invited_email) must fail truthfully as missing_recipient -- never
    // silently succeed, never send a malformed request to the provider.
    const noEmailPortfolioRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "No Recipient Facility" }),
    });
    const noEmailPortfolioId = (await noEmailPortfolioRes.json()).record.id;
    // Provisioning itself still requires a valid email (existing route
    // validation) -- the anomaly being tested is specifically Backend's
    // resend response omitting invited_email, not a bypass of intake
    // validation.
    await fetch(`${base}/api/lead-agents/admin/office/portfolio/${noEmailPortfolioId}/provision-facility`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ estate_name: "No Recipient Facility", facility_admin_email: "placeholder@example.com" }),
    });
    const resendCallsBeforeAnomaly = resendCalls.length;
    const noEmailResendRes = await fetch(`${base}/api/lead-agents/admin/office/portfolio/${noEmailPortfolioId}/facility-invite/resend`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
    });
    assert.equal(noEmailResendRes.status, 200, "a missing recipient is a delivery-truthfulness failure, not an HTTP error");
    const noEmailResendBody = await noEmailResendRes.json();
    assert.equal(noEmailResendBody.email_delivered, false);
    assert.equal(noEmailResendBody.email_delivery_reason, "missing_recipient", "the real, specific sendOfficeEmail reason must surface, not a generic failure");
    assert.equal(resendCalls.length, resendCallsBeforeAnomaly, "sendOfficeEmail must refuse to call Resend at all when the recipient is genuinely absent, not send a malformed request");
    console.log("C. A genuinely absent recipient fails truthfully as missing_recipient, no malformed request sent — PASS");
  } finally {
    global.fetch = originalFetch;
    await close(server);
    await close(fakeBackend);
  }

  console.log("office Facility owner-invite email envelope smoke passed");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
