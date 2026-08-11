const { execSync } = require("child_process");

const commands = [
  "npm run security:secrets",
  "npm run lint",
  "npm run check",
  "npm run build",
  "npm run deployment:validate",
  "npm run office:test",
  "npm run office:intake:test",
  "npm run office:backend-events:test",
];

for (const command of commands) {
  execSync(command, {
    stdio: "inherit",
  });
}

console.log("validate:release: release checks completed");
