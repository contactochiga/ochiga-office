const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { FileLeadAgentsStore } = require("./store-file");

async function createTempStore() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lead-agents-test-"));
  const filePath = path.join(tempDir, "store.json");
  const store = new FileLeadAgentsStore(filePath);
  await store.init();
  return { store, filePath, tempDir };
}

module.exports = {
  createTempStore,
};
