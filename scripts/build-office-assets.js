const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const requiredFiles = [
  "public/index.html",
  "public/assets/ochiga-logo.png",
  "public/dashboard/index.html",
  "public/dashboard/dashboard.js",
  "public/widget/index.html",
  "public/widget/oma-widget.js",
  "public/digital-twin/index.html",
  "public/digital-twin/app.js",
  "public/plan-studio/index.html",
  "public/plan-studio/app.js",
  "lead-agents-server.js",
  "render.yaml",
  "docs/office-os-2-architecture.md",
  "docs/office-edge-split-plan.md",
  "docs/office-backend-integration-plan.md",
  "docs/ROTATION_CHECKLIST.md",
];

const missing = requiredFiles.filter((relativePath) => {
  return !fs.existsSync(path.join(ROOT, relativePath));
});

if (missing.length > 0) {
  throw new Error(`Build validation failed. Missing files: ${missing.join(", ")}`);
}

const dashboardHtml = fs.readFileSync(path.join(ROOT, "public/dashboard/index.html"), "utf8");
const dashboardJs = fs.readFileSync(path.join(ROOT, "public/dashboard/dashboard.js"), "utf8");

if (!/Ochiga Office/.test(dashboardHtml)) {
  throw new Error("Build validation failed. Dashboard shell is missing Ochiga Office branding.");
}

if (!/OFFICE_MODULE_REGISTRY/.test(dashboardJs)) {
  throw new Error("Build validation failed. Dashboard runtime registry is missing.");
}

console.log(`build: validated ${requiredFiles.length} Office runtime assets`);
