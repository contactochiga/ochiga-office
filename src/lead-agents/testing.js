const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { FileLeadAgentsStore } = require("./store-file");

// Optional production-equivalent mode: when OFFICE_TEST_SUPABASE_URL and OFFICE_TEST_SUPABASE_SERVICE_ROLE_KEY are set (only by
// scripts/test-p0-supabase-hardening.js, against a disposable Supabase Postgres + PostgREST), tests run through the real SupabaseLeadAgentsStore
// with a service-role key instead of the file store. Never used in normal runs.
async function createTempStore() {
  if (process.env.OFFICE_TEST_SUPABASE_URL && process.env.OFFICE_TEST_SUPABASE_SERVICE_ROLE_KEY) {
    const { SupabaseLeadAgentsStore } = require("./store-supabase");
    const store = new SupabaseLeadAgentsStore({ url: process.env.OFFICE_TEST_SUPABASE_URL, serviceRoleKey: process.env.OFFICE_TEST_SUPABASE_SERVICE_ROLE_KEY, requestTimeoutMs: 15000 });
    await store.init();
    return { store, filePath: null, tempDir: null };
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lead-agents-test-"));
  const filePath = path.join(tempDir, "store.json");
  const store = new FileLeadAgentsStore(filePath);
  await store.init();
  return { store, filePath, tempDir };
}

module.exports = {
  createTempStore,
};
