const { runMockChatScenario } = require("../src/lead-agents/testing");

async function main() {
  const { result, store } = await runMockChatScenario();
  const leads = await store.listLeads();

  if (!result.assistant_message) {
    throw new Error("Missing assistant message");
  }
  if (!Array.isArray(result.tools) || result.tools.length !== 1) {
    throw new Error("Expected one tool execution");
  }
  if (!leads[0] || leads[0].status !== "sales") {
    throw new Error("Expected lead status to be updated to sales");
  }
  if (Number(leads[0].score) !== 82) {
    throw new Error("Expected lead score to be updated to 82");
  }

  console.log(
    JSON.stringify({
      ok: true,
      lead_id: leads[0].id,
      status: leads[0].status,
      score: leads[0].score,
      assistant_message: result.assistant_message,
    })
  );
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
