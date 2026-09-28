// Office Intelligence Convergence, Wave 3C -- anti-regression guard.
// runtime.js (the local Office lead-agent LLM reasoning implementation)
// and its exclusively-owned helpers were retired after static
// caller/import/script tracing proved zero production callers. This test
// makes it hard to accidentally recreate a second Office intelligence
// brain: live CRM/lead and Plan Studio reasoning routes must keep
// delegating to Backend Oyi Core via oyi-core-gateway.js, and the retired
// files must not come back. Plan Studio's bounded image-geometry parser and
// the Office-local Digital Twin remain domain tools, not response authorities.
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(root, "src/lead-agents/server.js"), "utf8");

// --- Positive: every live CRM/lead conversation route delegates to Oyi Core.
assert.ok(
  /require\(["']\.\/oyi-core-gateway["']\)/.test(serverSource),
  "server.js must import the Oyi Core gateway"
);
assert.ok(
  serverSource.includes("callOyiCoreOfficeInternalConversation"),
  "the staff office-internal chat routes (/api/lead-agents/chat, /api/lead-agents/admin/office/intelligence/chat) must delegate to Oyi Core"
);
assert.ok(
  serverSource.includes("callOyiCoreCorporateConversation"),
  "the public corporate chat route must delegate to Oyi Core"
);
const planStudioAnswer = serverSource.match(/async function answerPlanStudioQuestion[\s\S]*?\n}\n\nasync function buildChannelOverview/);
assert.ok(planStudioAnswer, "Plan Studio agent response helper must remain identifiable for its Core-authority guard");
assert.ok(
  planStudioAnswer[0].includes("callOyiCoreOfficeInternalConversation"),
  "Plan Studio planning responses must delegate to the authenticated Oyi Core office-internal transport"
);
assert.ok(
  planStudioAnswer[0].includes('requested_capability: "office.plan_studio.review"'),
  "Plan Studio must request the registered Core plan-review capability"
);
assert.ok(
  planStudioAnswer[0].includes("plan_review_context"),
  "Plan Studio must pass the bounded Core plan-review evidence projection"
);
assert.ok(
  !planStudioAnswer[0].includes("openaiClient.createResponse"),
  "Plan Studio must not locally generate planning responses with a provider client"
);

// --- Negative: no local LLM reasoning runtime for CRM/lead intelligence.
assert.ok(
  !/require\(["']\.\/runtime["']\)/.test(serverSource),
  "server.js must not import a local Office lead-agent reasoning runtime"
);
assert.ok(
  !/LeadAgentRuntime/.test(serverSource),
  "server.js must not reference a local LeadAgentRuntime -- CRM/lead reasoning belongs to Oyi Core"
);

// --- Retired files must actually be gone, not just unreferenced. This is
// the structural half of the guard: it fails the instant someone adds
// these paths back, before anything even requires them again.
for (const retired of [
  "src/lead-agents/runtime.js",
  "src/lead-agents/prompt-packs.js",
  "src/lead-agents/lead-memory.js",
  "src/lead-agents/knowledge-base.js",
  "src/intelligence-core/index.js",
]) {
  assert.equal(
    fs.existsSync(path.join(root, retired)),
    false,
    `${retired} is retired (proven zero production callers, Wave 3C) and must not be recreated`
  );
}

// --- Scope check: the bounded geometry parser and Office-local Digital Twin
// remain domain tools. They are not permitted to become local answer engines.
assert.ok(
  fs.existsSync(path.join(root, "src/lead-agents/plan-studio.js")),
  "Plan Studio remains a separate, legitimate AI surface -- not retired by this guard"
);
assert.ok(
  fs.existsSync(path.join(root, "src/lead-agents/digital-twin.js")),
  "the Office-local Digital Twin remains ACTIVE -- not retired by this guard"
);

console.log(
  "office intelligence architecture guard: PASS (Office CRM/lead and Plan Studio responses delegate to Oyi Core; no local reasoning runtime)"
);
