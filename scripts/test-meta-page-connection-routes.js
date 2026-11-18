"use strict";

const assert = require("node:assert/strict");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");

const limiter = () => new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 });

async function main() {
  const { store, tempDir } = await createTempStore();
  await store.ensureAdminUser({ email: "meta-admin@synthetic.invalid", password_hash: hashPassword("synthetic-pass-123"), role: "super_admin", display_name: "Synthetic Admin", status: "active" });
  await store.ensureAdminUser({ email: "meta-viewer@synthetic.invalid", password_hash: hashPassword("synthetic-pass-456"), role: "viewer", display_name: "Synthetic Viewer", status: "active" });
  const config = {
    ...createConfig(), environment: "test", authMode: "required_api_key", apiKeys: ["synthetic-api-key"],
    sessionSecret: "synthetic-session-secret-long-enough-000000000000", metaAppId: "app-123", metaAppSecret: "never-log-this",
    metaSocialGraphVersion: "v26.0", metaOAuthRedirectUri: "http://localhost/api/lead-agents/admin/meta/oauth/callback",
    metaSocialWebhookCallbackUrl: "https://office.example.test/webhooks/meta-social", metaTokenEncryptionKey: Buffer.alloc(32, 5).toString("base64"),
    officeAppUrl: "http://localhost", officeBackendBaseUrl: "", communicationOutboxWorker: false,
  };
  const server = buildServer({ config, store, rateLimiter: limiter(), publicRateLimiter: limiter(), officeRateLimiter: limiter(), loginRateLimiter: limiter(), whatsappAdapter: { isConfigured: () => false }, openaiClient: {}, toolExecutor: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password) => {
    const response = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const admin = await login("meta-admin@synthetic.invalid", "synthetic-pass-123");
  const viewer = await login("meta-viewer@synthetic.invalid", "synthetic-pass-456");
  const request = (path, cookie, init = {}) => fetch(`${base}/api/lead-agents/admin/meta/${path}`, { ...init, headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json", ...(init.headers || {}) } });
  try {
    assert.equal((await request("status")).status, 401, "Meta status requires an authenticated session");
    const status = await (await request("status", admin)).json();
    assert.equal(status.meta.facebook.status, "not_connected");
    assert.equal(status.meta.instagram.status, "not_connected");
    assert.equal(status.whatsapp.management_api, "not_verified_by_this_screen");
    assert.equal(JSON.stringify(status).includes("never-log-this"), false);

    const connect = await request("connect", viewer, { method: "POST", body: "{}" });
    assert.equal(connect.status, 403, "ordinary viewer cannot start OAuth");
    const apiKeyConnect = await request("connect", "", { method: "POST", body: "{}", headers: { "x-api-key": "synthetic-api-key" } });
    assert.equal(apiKeyConnect.status, 403, "API keys cannot initiate an administrator OAuth flow");

    const start = await request("connect", admin, { method: "POST", body: "{}" });
    assert.equal(start.status, 200);
    const data = await start.json();
    const url = new URL(data.authorization_url);
    assert.equal(url.origin, "https://www.facebook.com");
    assert.equal(url.searchParams.get("client_id"), "app-123");
    assert.ok(start.headers.get("set-cookie").includes("HttpOnly"));
    assert.equal(data.authorization_url.includes("never-log-this"), false);

    const invalidCallback = await fetch(`${base}/api/lead-agents/admin/meta/oauth/callback?code=synthetic&state=bad`, { headers: { cookie: admin }, redirect: "manual" });
    assert.equal(invalidCallback.status, 303);
    assert.match(invalidCallback.headers.get("location"), /meta_oauth=state_invalid/);
    assert.match(invalidCallback.headers.get("set-cookie"), /Max-Age=0/);

    const pages = await (await request("pages", admin)).json();
    assert.deepEqual(pages.pages, []);
    console.log("Meta Page connection route tests passed: authenticated admin-only OAuth, legacy credentials are not verification, API keys blocked, state-failure redirect and safe responses.");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    require("node:fs").rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
