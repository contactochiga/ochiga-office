const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  ".git",
  ".vercel",
  "node_modules",
  "outputs",
]);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".env.lead-agents.example") {
      if (entry.name !== ".gitignore") {
        continue;
      }
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), files);
      continue;
    }
    if (entry.isFile() && /\.(c?js|mjs)$/.test(entry.name)) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

const files = walk(ROOT).sort();
if (files.length === 0) {
  throw new Error("No JavaScript files found for syntax validation.");
}

for (const file of files) {
  execFileSync(process.execPath, ["--check", file], {
    cwd: ROOT,
    stdio: "pipe",
  });
}

console.log(`check: validated ${files.length} JavaScript files`);
