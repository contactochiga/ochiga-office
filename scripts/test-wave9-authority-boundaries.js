const assert = require("node:assert/strict");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { createTempStore } = require("../src/lead-agents/testing");
const { buildOyiCoreOfficeInternalRequest } = require("../src/lead-agents/oyi-core-gateway");
const { createAdminSessionToken } = require("../src/lead-agents/auth");

async function main() {
  const { store } = await createTempStore();
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["wave9-isolated-test"], allowedOrigins: [], officeBackendBaseUrl: "" };
  const request = await buildOyiCoreOfficeInternalRequest({
    authContext: { userId: "actual-staff", email: "staff@example.invalid", role: "viewer", permissions: [] },
    message: "hello", store, config,
    body: { staff: { staff_id: "victim", email: "admin@example.invalid", role: "super_admin", permissions: ["*"] } },
  });
  assert.deepEqual(request.staff, { staff_id: "actual-staff", email: "staff@example.invalid", role: "viewer", permissions: [] });
  const noActor = await buildOyiCoreOfficeInternalRequest({ body: { staff: { role: "super_admin", permissions: ["*"] } }, message: "hello", store, config });
  assert.equal(noActor.staff.staff_id, "");
  assert.deepEqual(noActor.staff.permissions, []);
  const server = buildServer({ config, store, rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 100 }), whatsappAdapter: {}, openaiClient: {}, toolExecutor: {} });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const path of ["/api/plan-studio/projects", "/api/plan-studio/project?id=private-project", "/api/lead-agents/leads/private-lead/memory"]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
      assert.equal(response.status, 401, path);
      assert.doesNotMatch(await response.text(), /image_data_url/);
    }
    store.getLead = async id => ({ id, owner: "actual-staff" });
    store.getAdminUserByEmail = async email => ({ id: email.split("@")[0], email, role: "ochiga_staff", status: "active", permission_scopes: [] });
    store.getLeadMemory = async id => ({ lead_id: id, updated_at: new Date().toISOString(), known_fields: { project_type: "residential", email: "private@example.invalid" }, last_summary: "staff-private-note" });
    for (const [id, status] of [["actual-staff", 200], ["other-staff", 403]]) {
      const token = createAdminSessionToken({ id, email: `${id}@example.invalid`, role: "ochiga_staff" }, config);
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/lead-agents/leads/private-lead/memory`, { headers: { cookie: `${config.sessionCookieName}=${token}` } });
      assert.equal(response.status, status);
      const body = await response.text();
      assert.doesNotMatch(body, /private@example.invalid|staff-private-note/);
      if (status === 200) assert.match(body, /residential/);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log("PASS Wave 9: staff spoofing rejected; unauthenticated plan metadata/media and CRM memory denied");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
