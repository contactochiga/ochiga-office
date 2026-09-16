const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();

function requireFile(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required file: ${relativePath}`);
  }
}

function requireText(relativePath, matcher, message) {
  const fullPath = path.join(ROOT, relativePath);
  const content = fs.readFileSync(fullPath, "utf8");
  if (!matcher.test(content)) {
    throw new Error(`${relativePath}: ${message}`);
  }
}

function forbidText(relativePath, matcher, message) {
  const fullPath = path.join(ROOT, relativePath);
  const content = fs.readFileSync(fullPath, "utf8");
  if (matcher.test(content)) {
    throw new Error(`${relativePath}: ${message}`);
  }
}

[
  "README.md",
  "lead-agents-server.js",
  "public/dashboard/index.html",
  "public/dashboard/dashboard.js",
  "src/lead-agents/server.js",
  "docs/office-os-2-architecture.md",
  "docs/office-edge-split-plan.md",
  "docs/office-backend-integration-plan.md",
].forEach(requireFile);

// Office Intelligence Convergence, Wave 3C -- these local lead-agent
// reasoning modules were retired (proven zero production callers). This
// guard makes it hard to accidentally recreate a second Office
// intelligence brain: the files must not come back, and the live CRM/lead
// conversation routes must keep delegating to Backend Oyi Core rather
// than reasoning locally. Plan Studio's own OpenAI usage and the
// Office-local Digital Twin are untouched by this guard -- neither is
// CRM/lead reasoning.
[
  "src/lead-agents/runtime.js",
  "src/lead-agents/prompt-packs.js",
  "src/lead-agents/lead-memory.js",
  "src/lead-agents/knowledge-base.js",
  "src/intelligence-core/index.js",
].forEach((relativePath) => {
  const fullPath = path.join(ROOT, relativePath);
  if (fs.existsSync(fullPath)) {
    throw new Error(`Office repository must not contain retired lead-agent intelligence runtime file: ${relativePath}`);
  }
});

[
  "agent.js",
  "go2rtc.yaml",
  "edge/camera/registry/local.camera-registry.json",
  "scripts/generate-go2rtc-config.js",
  "scripts/check-camera-runtime-readiness.js",
].forEach((relativePath) => {
  const fullPath = path.join(ROOT, relativePath);
  if (fs.existsSync(fullPath)) {
    throw new Error(`Office repository must not contain Edge runtime file: ${relativePath}`);
  }
});

requireText(
  ".gitignore",
  /^outputs\/$/m,
  "must ignore generated outputs/"
);
requireText(
  "README.md",
  /Office is the source of truth for corporate and commercial CRM state/,
  "must describe standalone Office ownership"
);
requireText(
  "public/dashboard/index.html",
  /Message Ochiga Office/,
  "must use Ochiga Office user-facing branding"
);

// Positive architecture guard replacing the old "transitional intelligence
// registry" marker: the live CRM/lead conversation routes must delegate
// to Backend Oyi Core through oyi-core-gateway.js, not reason locally.
requireText(
  "src/lead-agents/server.js",
  /callOyiCoreOfficeInternalConversation/,
  "the staff office-internal conversation routes must delegate to Oyi Core via oyi-core-gateway"
);
requireText(
  "src/lead-agents/server.js",
  /callOyiCoreCorporateConversation/,
  "the public corporate conversation route must delegate to Oyi Core via oyi-core-gateway"
);
forbidText(
  "src/lead-agents/server.js",
  /require\(["']\.\/runtime["']\)|LeadAgentRuntime/,
  "must not import a local Office lead-agent reasoning runtime -- CRM/lead intelligence belongs to Oyi Core, not a second Office brain"
);

console.log("lint: Office repository structure and release markers look good");
