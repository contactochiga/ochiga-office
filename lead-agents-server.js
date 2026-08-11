require("./src/lead-agents/server").start().catch((err) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "lead_agents_server.start_failed",
      error: err?.stack || err?.message || String(err),
    })
  );
  process.exit(1);
});
