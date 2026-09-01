const { execSync } = require("child_process");

const commands = [
  "npm run security:secrets",
  "npm run lint",
  "npm run check",
  "npm run build",
  "npm run deployment:validate",
  "npm run office:test",
  "npm run office:intake:test",
  "npm run office:crm-intake:test",
  "npm run office:backend-events:test",
  "npm run office:public-intelligence:test",
  "npm run office:oyi-core-delegation:test",
  "npm run office:communications-handoff:test",
  "npm run office:contract-hardening:test",
  "npm run office:rate-limit:test",
  "npm run office:operational-mutations:test",
  "npm run office:operating-system:test",
  "npm run office:team-settings-audit:test",
  "npm run office:portfolio-projection:test",
  "npm run office:facility-provisioning:test",
  "npm run office:normalize-lead-timestamps:test",
  "npm run office:oyi-internal-context:test",
  "npm run office:oyi-interaction:test",
  "npm run office:dialog-submit-guard:test",
  "npm run office:facility-invite-email-envelope:test",
  "npm run office:documents-workspace:test",
  "npm run office:team-lifecycle-meetings-trash:test",
];

for (const command of commands) {
  execSync(command, {
    stdio: "inherit",
  });
}

console.log("validate:release: release checks completed");
