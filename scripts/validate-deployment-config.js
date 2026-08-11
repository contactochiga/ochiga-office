const fs = require("node:fs");

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const pkg = readJson("package.json");
const render = fs.readFileSync("render.yaml", "utf8");
const vercel = fs.readFileSync("vercel.json", "utf8");
const server = fs.readFileSync("src/lead-agents/server.js", "utf8");
const envExample = fs.readFileSync(".env.example", "utf8");

assert(pkg.scripts["office:start"], "package.json must expose office:start for Office deployment");
assert(/startCommand:\s+npm run office:start/.test(render), "render.yaml must start the standalone Office runtime");
assert(/healthCheckPath:\s+\/healthz/.test(render), "render.yaml must keep the Office health check path");
assert(/LEAD_AGENTS_AUTH_MODE[\s\S]*value:\s+required_api_key/.test(render), "Office production auth must fail closed with required_api_key");
assert(/LEAD_AGENTS_API_KEYS[\s\S]*sync:\s+false/.test(render), "Office API keys must be configured as unsynced secrets");
assert(/SUPABASE_SERVICE_ROLE_KEY[\s\S]*sync:\s+false/.test(render), "Supabase service role must be an unsynced secret");
assert(/OPENAI_API_KEY[\s\S]*sync:\s+false/.test(render), "OpenAI key must be an unsynced secret");
assert(server.includes("/api/office/intake"), "Office intake API route must be registered");
assert(server.includes("/api/lead-agents/public/session"), "Public intelligence session API route must be registered");
assert(server.includes("callOyiCoreCorporateConversation"), "Public chat must delegate live intelligence to Oyi Core");
assert(render.includes("OFFICE_BACKEND_BASE_URL"), "Render must declare Backend base URL for Oyi Core delegation");
assert(/OFFICE_BACKEND_API_KEY[\s\S]*sync:\s+false/.test(render), "Backend API key must remain an unsynced Office secret");
assert(render.includes("OFFICE_BACKEND_CONVERSATION_PATH"), "Render must declare the Oyi Core corporate conversation path");
assert(envExample.includes("OFFICE_BACKEND_CONVERSATION_PATH=/office/conversation/corporate"), "Oyi Core conversation path must be documented");
assert(envExample.includes("OFFICE_BACKEND_EVENTS_ENABLED=false"), "Office material events must be disabled by default in .env.example");
assert(envExample.includes("OFFICE_BACKEND_EVENT_PATH=/office/events/material"), "Office material event path must be documented");
assert(envExample.includes("OFFICE_BACKEND_EVENT_MAX_ATTEMPTS=2"), "Office material event retry limit must be documented");
assert(vercel.includes("/api/lead-agents/:path*"), "Vercel compatibility rewrite for lead agents must remain");
assert(vercel.includes("/healthz"), "Vercel health rewrite must remain");

console.log("validate-deployment-config: PASS");
