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

[
  "README.md",
  "lead-agents-server.js",
  "public/dashboard/index.html",
  "public/dashboard/dashboard.js",
  "src/intelligence-core/index.js",
  "src/lead-agents/server.js",
  "docs/office-os-2-architecture.md",
  "docs/office-edge-split-plan.md",
  "docs/office-backend-integration-plan.md",
].forEach(requireFile);

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
  "src/intelligence-core/index.js",
  /Transitional Office intelligence registry\./,
  "must clearly mark local intelligence as transitional"
);
requireText(
  "public/dashboard/index.html",
  /Message Ochiga Office/,
  "must use Ochiga Office user-facing branding"
);

console.log("lint: Office repository structure and release markers look good");
