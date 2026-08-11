const fs = require("fs/promises");
const path = require("path");

const AGENT_PACKS = {
  marketing: {
    agentName: "marketing_agent",
    displayName: "Ochiga Marketing Agent",
    folder: "marketing-agent",
  },
  sales: {
    agentName: "sales_agent",
    displayName: "Ochiga Sales Agent",
    folder: "sales-agent",
  },
};

async function loadPromptPack(promptPackRoot, key) {
  const pack = AGENT_PACKS[key];
  if (!pack) {
    throw new Error(`Unknown agent pack: ${key}`);
  }

  const folder = path.join(promptPackRoot, pack.folder);
  const [systemPrompt, scoringRubric, templates, tools] = await Promise.all([
    fs.readFile(path.join(folder, "SYSTEM_PROMPT.md"), "utf8"),
    fs.readFile(path.join(folder, "SCORING_RUBRIC.md"), "utf8"),
    fs.readFile(path.join(folder, "TEMPLATES.md"), "utf8"),
    fs.readFile(path.join(folder, "TOOLS.md"), "utf8"),
  ]);

  return {
    ...pack,
    systemPrompt,
    instructions: [
      systemPrompt.trim(),
      "",
      "Supporting files:",
      scoringRubric.trim(),
      "",
      templates.trim(),
      "",
      tools.trim(),
    ].join("\n"),
  };
}

module.exports = {
  AGENT_PACKS,
  loadPromptPack,
};
