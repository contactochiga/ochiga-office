const { execFileSync } = require("node:child_process");

const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean);

const forbidden = trackedFiles.filter((file) => {
  const lower = file.toLowerCase();
  if (lower.endsWith("scripts/check-secrets.js")) return false;
  if (lower.endsWith(".example") || lower.endsWith(".sample") || lower.includes("rotation_checklist")) return false;
  return /(^|\/)\.env(\.|$)|secret|credential|private-key|service-account/.test(lower);
});

if (forbidden.length > 0) {
  console.error("Refusing release: tracked secret-like files detected:");
  for (const file of forbidden) console.error(`- ${file}`);
  process.exit(1);
}

console.log("check-secrets: PASS");
