const { FileLeadAgentsStore } = require("./store-file");
const { SupabaseLeadAgentsStore } = require("./store-supabase");
const { socialOutboundChannelEnabled } = require("./meta-social-replies");

function createStore(config) {
  if (config.storeDriver !== "supabase" &&
      ["facebook", "instagram"].some((channel) => socialOutboundChannelEnabled(config, channel))) {
    throw new Error("Social outbound requires the Supabase dispatch fence");
  }
  if (config.storeDriver === "supabase") {
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for LEAD_AGENTS_STORE_DRIVER=supabase"
      );
    }

    return new SupabaseLeadAgentsStore({
      url: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
      requestTimeoutMs: config.requestTimeoutMs,
    });
  }

  return new FileLeadAgentsStore(config.storePath);
}

module.exports = {
  createStore,
};
