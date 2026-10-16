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
assert(/key:\s+LEAD_AGENTS_SESSION_SECRET\s*\n\s+sync:\s+false/.test(render), "render.yaml must declare LEAD_AGENTS_SESSION_SECRET as a dashboard-set secret (sync: false)");
assert(!/LEAD_AGENTS_ALLOW_API_KEY_LOGIN/.test(render), "render.yaml must not enable the deprecated API-key password sign-in");
assert(!/LEAD_AGENTS_ADMIN_RECOVERY/.test(render), "render.yaml must not enable administrator recovery (set it only transiently in the dashboard)");
assert(!/key:\s+LEAD_AGENTS_MFA\s*\n\s+value:\s+["']?on/i.test(render), "render.yaml must not switch MFA on (S7.5.1 only validates key configuration; enabling is a later, deliberate step)");
assert(!/key:\s+LEAD_AGENTS_MFA_(KEY|KEYS_PREVIOUS)\s*\n\s+value:/.test(render), "render.yaml must never carry a value for the MFA encryption key (set it in the Render dashboard only)");
assert(!/^\s*LEAD_AGENTS_MFA_(KEY|KEYS_PREVIOUS)=\S/m.test(envExample), ".env.example must not contain an MFA key value");
assert(!/LEAD_AGENTS_WEBAUTHN/.test(render), "render.yaml must not carry a WebAuthn RP ID, origin or approval (the permanent domain is set by the owner in the dashboard only, after approval)");
assert(!/^\s*LEAD_AGENTS_WEBAUTHN_(RP_ID|ORIGINS|RP_APPROVED)=\S/m.test(envExample), ".env.example must not contain a WebAuthn RP ID, origin or approval value");
assert(!/LEAD_AGENTS_MFA_(RECOVERY|FLEET_ATTESTED)/.test(render), "render.yaml must not enable MFA break-glass recovery or attest the fleet (S7.5.7: the owner sets these transiently in the dashboard, never in the repository)");
assert(!/^\s*LEAD_AGENTS_MFA_(RECOVERY(_EMAIL|_ID|_APPROVED)?|FLEET_ATTESTED)=\S/m.test(envExample), ".env.example must not contain a break-glass, attestation or approval value");
assert(/LEAD_AGENTS_AUTH_MODE[\s\S]*value:\s+required_api_key/.test(render), "Office production auth must fail closed with required_api_key");
assert(/LEAD_AGENTS_API_KEYS[\s\S]*sync:\s+false/.test(render), "Office API keys must be configured as unsynced secrets");
assert(/SUPABASE_SERVICE_ROLE_KEY[\s\S]*sync:\s+false/.test(render), "Supabase service role must be an unsynced secret");
assert(/OPENAI_API_KEY[\s\S]*sync:\s+false/.test(render), "OpenAI key must be an unsynced secret");
assert(server.includes("/api/office/intake"), "Office intake API route must be registered");
assert(server.includes("/api/lead-agents/public/session"), "Public intelligence session API route must be registered");
assert(server.includes("callOyiCoreCorporateConversation"), "Public chat must delegate live intelligence to Oyi Core");
assert(server.includes("/api/lead-agents/admin/office/home"), "Office Home attention API route must be registered");
assert(server.includes("callOyiCoreOfficeInternalConversation"), "Authenticated Office intelligence must delegate to Oyi Core");
assert(server.includes('pathname === "/" || pathname === "/office"'), "Dedicated Office deployment must serve the new Office shell at root and /office");
assert(render.includes("OFFICE_BACKEND_BASE_URL"), "Render must declare Backend base URL for Oyi Core delegation");
assert(/OFFICE_BACKEND_API_KEY[\s\S]*sync:\s+false/.test(render), "Backend API key must remain an unsynced Office secret");
assert(render.includes("OFFICE_BACKEND_CONVERSATION_PATH"), "Render must declare the Oyi Core corporate conversation path");
assert(render.includes("OFFICE_BACKEND_INTERNAL_CONVERSATION_PATH"), "Render must declare the Oyi Core Office Internal conversation path");
assert(envExample.includes("OFFICE_BACKEND_CONVERSATION_PATH=/office/conversation/corporate"), "Oyi Core conversation path must be documented");
assert(envExample.includes("OFFICE_BACKEND_INTERNAL_CONVERSATION_PATH=/office/conversation/internal"), "Office Internal Oyi Core path must be documented");
assert(envExample.includes("OFFICE_BACKEND_EVENTS_ENABLED=false"), "Office material events must be disabled by default in .env.example");
assert(envExample.includes("OFFICE_BACKEND_EVENT_PATH=/office/events/material"), "Office material event path must be documented");
assert(envExample.includes("OFFICE_BACKEND_EVENT_MAX_ATTEMPTS=2"), "Office material event retry limit must be documented");
assert(vercel.includes("/api/lead-agents/:path*"), "Vercel compatibility rewrite for lead agents must remain");
assert(vercel.includes("/healthz"), "Vercel health rewrite must remain");
assert(vercel.includes('"destination": "/office/"'), "Vercel compatibility root must open the new Office shell");

console.log("validate-deployment-config: PASS");
