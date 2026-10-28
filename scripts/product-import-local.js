"use strict";
// Standalone localhost rehearsal. Never reads .env or production credentials; no Docker or Phase 4 resources.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
for (const name of [".env", ".env.lead-agents.local"]) if (fs.existsSync(path.resolve(name))) throw new Error("Local import launcher refuses environment files. Use the clean import worktree.");
for (const name of Object.keys(process.env)) if (!["PATH", "HOME", "TMPDIR", "LANG", "TERM"].includes(name)) delete process.env[name];
process.env.NODE_ENV = "test";
const local = (hostname) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
const originalFetch = global.fetch;
global.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!local(url.hostname)) return Promise.reject(new Error("Local import environment blocks external requests"));
  return originalFetch(input, options);
};
for (const module of [require("node:http"), require("node:https")]) {
  const request = module.request;
  module.request = function(input, ...args) {
    const host = typeof input === "string" || input instanceof URL ? new URL(input).hostname : input.hostname || input.host || "localhost";
    if (!local(host)) throw new Error("Local import environment blocks external requests");
    return request.call(this, input, ...args);
  };
  module.get = function(...args) { const req = module.request(...args); req.end(); return req; };
}
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { FileLeadAgentsStore } = require("../src/lead-agents/store-file");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { hashPassword } = require("../src/lead-agents/auth");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");

async function startLocal({ directory, port = 0 } = {}) {
  const dir = directory || path.resolve("outputs/product-import-local");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Environment was cleared before loading the server; external I/O is blocked above.
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: [crypto.randomBytes(32).toString("hex")], sessionSecret: crypto.randomBytes(48).toString("hex"), officeStorageDriver: "local", officeStorageDir: path.join(dir, "storage"), officeBackendBaseUrl: "http://127.0.0.1:1", officeBackendApiKey: "local-disabled", openaiApiKey: "", supabaseUrl: "", supabaseServiceRoleKey: "", getoyiRevalidateUrl: "", getoyiRevalidateSecret: "" };
  const store = new FileLeadAgentsStore(path.join(dir, "store.json")); await store.init();
  const loginPath = path.join(dir, "login.json");
  const identities = fs.existsSync(loginPath) ? JSON.parse(fs.readFileSync(loginPath, "utf8")) : Object.fromEntries(["importer", "reader", "writer", "other"].map((name) => [name, { email: `${name}@import.test`, password: `Local-${crypto.randomBytes(10).toString("hex")}!` }]));
  fs.writeFileSync(loginPath, JSON.stringify(identities, null, 2), { mode: 0o600 });
  for (const [name, user] of Object.entries(identities)) await store.ensureAdminUser({ ...user, password_hash: hashPassword(user.password), role: "ochiga_staff", display_name: `Local ${name} (test only)`, status: "active", permission_scopes: name === "reader" ? [] : name === "writer" ? ["catalogue.write", "view_storage"] : ["catalogue.write", "catalogue.cost.read", "view_storage"] });
  const limiter = () => new MemoryRateLimiter({ windowMs: 60000, maxRequests: 10000 });
  const adapter = { isConfigured: () => false, verifyWebhook: () => null, verifySignature: () => ({ ok: false }), extractEvents: () => [], sendTextMessage: async () => ({ delivered: false }), sendTemplateMessage: async () => ({ delivered: false }), listApprovedTemplates: async () => [] };
  const server = buildServer({ config, store, rateLimiter: limiter(), publicRateLimiter: limiter(), officeRateLimiter: limiter(), loginRateLimiter: limiter(), whatsappAdapter: adapter, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { server, store, identities, dir, base: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
if (require.main === module) startLocal({ port: Number(process.argv[2] || 4387) }).then(({ base, dir }) => console.log(`Local product import ready: ${base}/office/#/catalogue\nTest login instructions: ${path.join(dir, "login.json")}\nNo production configuration loaded. No publication permissions granted.`)).catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { startLocal };
