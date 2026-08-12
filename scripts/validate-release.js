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
  "npm run office:public-intelligence:test",
  "npm run office:oyi-core-delegation:test",
  "npm run office:communications-handoff:test",
  "npm run office:operating-system:test",
];

for (const command of commands) {
  execSync(command, {
    stdio: "inherit",
  });
}

console.log("validate:release: release checks completed");
