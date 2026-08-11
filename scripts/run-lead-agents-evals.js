const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { FileKnowledgeBase } = require("../src/lead-agents/knowledge-base");
const { FileLeadMemoryStore } = require("../src/lead-agents/lead-memory");
const { runMockChatScenario } = require("../src/lead-agents/testing");

async function main() {
  const root = process.cwd();
  const casesPath = path.join(root, "evals", "lead-agents", "cases.json");
  const evalCases = JSON.parse(await fs.readFile(casesPath, "utf8"));
  const knowledgeBase = new FileKnowledgeBase(path.join(root, "knowledge"));
  await knowledgeBase.init();

  const results = [];

  for (const testCase of evalCases) {
    if (testCase.expected.tool_name) {
      const run = await runMockChatScenario({
        agent: testCase.agent,
        message: testCase.message,
        profile: testCase.profile,
      });

      results.push({
        id: testCase.id,
        passed:
          run.result.lead.status === testCase.expected.lead_status &&
          run.result.lead.owner === testCase.expected.lead_owner &&
          run.result.tools.some((tool) => tool.name === testCase.expected.tool_name),
        details: {
          status: run.result.lead.status,
          owner: run.result.lead.owner,
          tools: run.result.tools.map((tool) => tool.name),
        },
      });
      continue;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lead-memory-eval-"));
    const memoryStore = new FileLeadMemoryStore(path.join(tempDir, "memory.json"));
    await memoryStore.init();
    const fakeLead = {
      id: testCase.id,
      name: testCase.profile.name,
      company: testCase.profile.company,
      role: testCase.profile.role,
      email: "",
      phone: "",
      source: "eval",
      location: testCase.profile.location,
      status: "new",
      owner: testCase.agent === "sales" ? "sales_agent" : "marketing_agent",
      summary: "",
      next_action: "",
    };
    const knowledge = knowledgeBase.search(testCase.message);
    const memory = await memoryStore.updateFromTurn({
      lead: fakeLead,
      userMessage: testCase.message,
      assistantMessage: "",
      toolCalls: [],
    });

    results.push({
      id: testCase.id,
      passed:
        knowledge.some((item) =>
          item.text.toLowerCase().includes(testCase.expected.knowledge_term)
        ) &&
        (memory.need_signals || []).includes(testCase.expected.memory_signal),
      details: {
        knowledge_hits: knowledge.map((item) => item.id),
        memory_signals: memory.need_signals || [],
      },
    });
  }

  const failed = results.filter((item) => !item.passed);
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
