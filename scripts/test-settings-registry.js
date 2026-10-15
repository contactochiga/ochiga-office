// Settings S3: registry, governed API, validation, versioning/conflicts, audit and history, persistence round-trip, role x permission matrix, security.
// Runs the real Office server on the file store (fixture data only). The Postgres/PostgREST side is covered by test-settings-registry-supabase.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { FileLeadAgentsStore } = require("../src/lead-agents/store-file");
const { hashPassword } = require("../src/lead-agents/auth");
const { createSettingsRegistry, defineSetting, validators, publicValue, historyValue } = require("../src/lead-agents/settings-registry");

const SECRET_A = "bridge-secret-sentinel-AAA", SECRET_B = "facility-secret-sentinel-BBB", SECRET_C = "edge-token-sentinel-CCC";
const limiter = (n) => new MemoryRateLimiter({ windowMs: 60000, maxRequests: n });
const listen = (s) => new Promise((res, rej) => { s.once("error", rej); s.listen(0, "127.0.0.1", () => res(s.address().port)); });

// generic descriptors injected through the test seam (production ships none yet)
const EXTRAS = [
  { key: "office.test_threshold", label: "Test threshold", type: "integer", default: 10, owner: "office", mode: "generic", storage: "runtime_settings", read_permission: "office.read", write_permission: "settings.manage", validator: validators.integer({ min: 1, max: 100 }), audit_action: "office_test_threshold_changed" },
  { key: "office.test_banner", label: "Test banner", type: "string", default: "", owner: "office", mode: "generic", storage: "runtime_settings", read_permission: "settings.manage", write_permission: "settings.manage", validator: validators.string({ max: 40 }), requires_confirmation: true, audit_action: "office_test_banner_changed" },
  { key: "office.test_mode", label: "Test mode", type: "enum", choices: ["standard", "strict"], default: "standard", owner: "office", mode: "generic", storage: "runtime_settings", read_permission: "office.read", write_permission: "team.manage", validator: validators.enum(["standard", "strict"]), audit_action: "office_test_mode_changed" },
  { key: "backend.test_owned", label: "Backend-owned mirror", type: "object", default: {}, owner: "backend", mode: "mirror", storage: "environment", read_permission: "office.read", read: async () => ({ value: { v: 1 }, version: null, updated_by: null, updated_at: null, source: "environment", history_supported: false }) },
  { key: "mirror.secret_probe", label: "Sensitive mirror", type: "object", default: {}, owner: "platform", mode: "mirror", sensitive: true, storage: "environment", read_permission: "office.read", read: async () => ({ value: "very-secret-value-DDD", version: null, updated_by: null, updated_at: null, source: "environment", history_supported: false }) },
];

async function main() {
  // ---- registry unit tests ----
  const reg = createSettingsRegistry({ config: {}, extras: EXTRAS });
  assert.ok(reg.get("whatsapp_autonomous_responses_enabled") && reg.get("office_letterhead_config"), "existing contracts are registered");
  assert.equal(reg.get("nope"), null, "unknown keys are not in the registry");
  const bad = (d, re) => assert.throws(() => defineSetting({ label: "x", type: "boolean", default: false, owner: "office", mode: "generic", storage: "runtime_settings", read_permission: "office.read", write_permission: "settings.manage", validator: validators.boolean(), audit_action: "a", key: "office.x", ...d }), re);
  bad({ owner: "backend" }, /owned by office/); bad({ owner: "facility" }, /owned by office/); bad({ owner: "consumer" }, /owned by office/); bad({ owner: "edge" }, /owned by office/);
  bad({ validator: undefined }, /validator/); bad({ audit_action: undefined }, /audit_action/); bad({ default: undefined }, /default/); bad({ write_permission: null }, /write_permission/);
  bad({ sensitive: true }, /secrets are never stored/); bad({ storage: "environment" }, /runtime_settings storage/); bad({ key: "Bad Key" }, /invalid key/); bad({ mode: "mirror", write_permission: "settings.manage" }, /only generic/);
  assert.throws(() => createSettingsRegistry({ config: {}, extras: [EXTRAS[0], EXTRAS[0]] }), /duplicate key/);
  assert.deepEqual(publicValue({ sensitive: true }, "abc"), { configured: true }); assert.deepEqual(publicValue({ sensitive: true }, ""), { configured: false }); assert.equal(historyValue({ sensitive: true }, "abc"), "[redacted]");
  assert.deepEqual(validators.integer({ min: 1, max: 5 })(6), { ok: false, error: "must_be_between_1_and_5" }); assert.equal(validators.integer()(1.5).ok, false); assert.equal(validators.boolean()("true").ok, false);
  console.log("1. Registry: invariants (ownership, validator, audit, no secrets), unknown keys, value redaction helpers — PASS");

  // ---- server ----
  const { store, filePath } = await createTempStore();
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["svc-key"], allowedOrigins: [], officeBackendBaseUrl: "http://127.0.0.1:1", officeBackendApiKey: SECRET_A, officeFacilityBaseUrl: "http://127.0.0.1:1", officeFacilityApiKey: SECRET_B, edgeAgentTokens: [SECRET_C] };
  const roles = { super: "super_admin", admin: "ochiga_admin", staff: "ochiga_staff", estate: "estate_admin", finance: "finance_operator" };
  for (const [k, role] of Object.entries(roles)) await store.ensureAdminUser({ email: `${k}@ochiga.test`, password_hash: hashPassword("pass-12345-xyz"), role, display_name: k, status: "active" });
  await store.ensureAdminUser({ email: "scoped@ochiga.test", password_hash: hashPassword("pass-12345-xyz"), role: "ochiga_staff", display_name: "scoped", status: "active", permission_scopes: ["settings.manage"] });
  const server = buildServer({ config, store, rateLimiter: limiter(5000), publicRateLimiter: limiter(5000), officeRateLimiter: limiter(5000), loginRateLimiter: limiter(500), whatsappAdapter: { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: () => [], isConfigured: () => true, sendTextMessage: async () => { throw new Error("must never send"); }, sendTemplateMessage: async () => ({ delivered: false }), listApprovedTemplates: async () => [] }, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }), settingsRegistryExtras: EXTRAS });
  const base = `http://127.0.0.1:${await listen(server)}`;
  const cookies = {};
  for (const k of [...Object.keys(roles), "scoped"]) { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${k}@ochiga.test`, password: "pass-12345-xyz" }) }); assert.equal(r.status, 200); cookies[k] = r.headers.get("set-cookie").split(";")[0]; }
  const call = async (who, method, path, body, extra = {}) => { const headers = { "content-type": "application/json", ...(who === "apikey" ? { "x-api-key": "svc-key" } : who ? { cookie: cookies[who] } : {}), ...extra }; const r = await fetch(`${base}/api/lead-agents/admin/settings${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text, requestId: r.headers.get("x-request-id") }; };
  const auditRows = async (key) => (await store.listAuditEvents(500)).filter((e) => e.target_id === key);

  // ---- unauthenticated ----
  assert.equal((await call(null, "GET", "")).status, 401, "unauthenticated list refused"); assert.equal((await call(null, "PUT", "/office.test_threshold", { value: 5, expected_version: 0 })).status, 401, "unauthenticated write refused");
  // ---- default / list ----
  const list = await call("super", "GET", "");
  assert.equal(list.status, 200); const keys = list.json.settings.map((s) => s.key);
  for (const k of ["whatsapp_autonomous_responses_enabled", "office_letterhead_config", "whatsapp_webhook_signature_mode", "whatsapp_webhook_signature_stats", "communication_outbox_settings", "mirror.backend.bridge", "mirror.facility.bridge", "mirror.consumer.bridge", "mirror.edge.agents", ...EXTRAS.map((e) => e.key)]) assert.ok(keys.includes(k), `registry lists ${k}`);
  const autonomy = list.json.settings.find((s) => s.key === "whatsapp_autonomous_responses_enabled");
  assert.equal(autonomy.value, false, "autonomy default OFF is unchanged"); assert.equal(autonomy.version, 0, "never saved = version 0"); assert.equal(autonomy.mode, "delegated"); assert.equal(autonomy.editable, false, "not writable through the registry"); assert.equal(autonomy.edit_via.path, "/api/lead-agents/admin/settings/whatsapp-autonomy");
  assert.equal(list.json.settings.find((s) => s.key === "mirror.edge.agents").value.agent_tokens_configured, 1, "edge mirror reports a count only");
  console.log("2. List: all registered keys, autonomy default OFF/version 0 and delegated — PASS");

  // ---- role x permission matrix ----
  const readable = { super: keys.length, admin: keys.length };
  const matrix = {};
  for (const who of Object.keys(cookies)) { const r = await call(who, "GET", ""); matrix[who] = { status: r.status, keys: r.status === 200 ? r.json.settings.map((s) => s.key).sort() : [] }; }
  assert.equal(matrix.super.keys.length, readable.super, "super_admin reads every entry"); assert.equal(matrix.admin.keys.length, readable.admin, "ochiga_admin reads every entry");
  assert.ok(!matrix.staff.keys.includes("communication_outbox_settings") && !matrix.staff.keys.includes("whatsapp_webhook_signature_stats"), "ochiga_staff does not see admin-only entries"); assert.ok(matrix.staff.keys.includes("mirror.backend.bridge") && matrix.staff.keys.includes("office.test_threshold"), "ochiga_staff sees the entries its permissions allow");
  assert.ok(!matrix.staff.keys.includes("office.test_banner"), "settings.manage-gated entry hidden from staff"); assert.ok(matrix.scoped.keys.includes("office.test_banner"), "a settings.manage scope reveals it");
  assert.equal(matrix.estate.status, 403, "estate_admin has no office.read -> refused"); assert.equal(matrix.finance.status, 403, "finance_operator has no office.read -> refused");
  const writeMatrix = {};
  for (const who of Object.keys(cookies)) { const r = await call(who, "PUT", "/office.test_threshold", { value: 11, expected_version: (await call("super", "GET", "/office.test_threshold")).json.setting.version }); writeMatrix[who] = r.status; }
  assert.deepEqual({ super: writeMatrix.super, admin: writeMatrix.admin, scoped: writeMatrix.scoped, staff: writeMatrix.staff, estate: writeMatrix.estate, finance: writeMatrix.finance }, { super: 200, admin: 200, scoped: 200, staff: 403, estate: 403, finance: 403 }, "write permission follows write_permission (settings.manage) for each role");
  const modeWrite = {};
  for (const who of ["super", "admin", "scoped"]) modeWrite[who] = (await call(who, "PUT", "/office.test_mode", { value: "strict", expected_version: (await call("super", "GET", "/office.test_mode")).json.setting.version })).status;
  assert.deepEqual(modeWrite, { super: 200, admin: 403, scoped: 403 }, "team.manage (super_admin only) gates a stricter key: ochiga_admin and a settings.manage scope are refused");
  console.log("3. Role × permission matrix (5 roles + scoped user) for list, per-key read and write — PASS");

  // ---- validation ----
  const v = async (body, expectStatus, expectError, who = "super", key = "office.test_threshold") => { const r = await call(who, "PUT", `/${key}`, body); assert.equal(r.status, expectStatus, `${JSON.stringify(body)} -> ${r.status} ${r.text.slice(0, 120)}`); if (expectError) assert.equal(r.json.error, expectError); return r; };
  const cur = () => call("super", "GET", "/office.test_threshold").then((r) => r.json.setting);
  let c = await cur();
  await v({ value: "abc", expected_version: c.version }, 400, "invalid_value"); await v({ value: 0, expected_version: c.version }, 400, "invalid_value"); await v({ value: 101, expected_version: c.version }, 400, "invalid_value"); await v({ value: 5.5, expected_version: c.version }, 400, "invalid_value"); await v({ value: null, expected_version: c.version }, 400, "invalid_value");
  await v({ expected_version: c.version }, 400, "value_required"); await v({ value: 5 }, 400, "expected_version_required"); await v({ value: 5, expected_version: -1 }, 400, "expected_version_required"); await v({ value: 5, expected_version: "1" }, 400, "expected_version_required");
  await v("not json {", 400, "invalid_json"); await v([1, 2], 400, "value_required");
  assert.equal((await cur()).version, c.version, "no rejected write changed the stored version"); assert.equal((await cur()).value, c.value, "or the value");
  await v({ value: 5, expected_version: 0 }, 404, "unknown_setting", "super", "office.does_not_exist");
  const ro = await call("super", "PUT", "/backend.test_owned", { value: { v: 2 }, expected_version: 0 }); assert.equal(ro.status, 403); assert.equal(ro.json.error, "read_only_setting"); assert.equal(ro.json.owner, "backend", "Backend-owned settings stay read-only mirrors");
  for (const k of ["mirror.backend.bridge", "mirror.facility.bridge", "mirror.consumer.bridge", "mirror.edge.agents", "whatsapp_webhook_signature_mode", "communication_outbox_settings", "whatsapp_webhook_signature_stats"]) { const r = await call("super", "PUT", `/${k}`, { value: {}, expected_version: 0 }); assert.equal(r.status, 403, `${k} is read-only`); assert.equal(r.json.error, "read_only_setting"); }
  const del = await call("super", "PUT", "/whatsapp_autonomous_responses_enabled", { value: true, expected_version: 0, confirm: true }); assert.equal(del.status, 405); assert.equal(del.json.error, "use_dedicated_endpoint"); assert.equal(del.json.route, "/api/lead-agents/admin/settings/whatsapp-autonomy");
  const del2 = await call("super", "PUT", "/office_letterhead_config", { value: { tagline: "x" }, expected_version: 0 }); assert.equal(del2.status, 405, "letterhead cannot be written through the registry");
  assert.equal((await call("super", "GET", "/whatsapp_autonomous_responses_enabled")).json.setting.value, false, "the delegated autonomy value did not change"); assert.equal((await store.getLetterheadConfig())?.tagline || "", "", "letterhead untouched");
  const ident = await call("apikey", "PUT", "/office.test_threshold", { value: 5, expected_version: (await cur()).version }); assert.equal(ident.status, 403); assert.equal(ident.json.error, "actor_identity_required", "an API key has permission but no accountable actor");
  assert.equal((await call("apikey", "GET", "/office.test_threshold")).status, 200, "API keys may read");
  const noConfirm = await v({ value: "hello", expected_version: 0 }, 400, "confirmation_required", "super", "office.test_banner"); void noConfirm;
  assert.equal((await call("super", "GET", "/office.test_banner")).json.setting.version, 0, "an unconfirmed change was not applied");
  assert.equal((await call("super", "PUT", "/office.test_banner", { value: "x".repeat(41), expected_version: 0, confirm: true })).status, 400, "length validated");
  assert.equal((await call("super", "PUT", "/office.test_banner", { value: " launch ", expected_version: 0, confirm: true })).json.setting.value, "launch", "the stored, trimmed value is what is returned");
  console.log("4. Validation: value, expected_version, JSON shape, unknown key, ownership, delegated, read-only, actor identity, confirmation — PASS");

  // ---- versioning / conflicts / persistence ----
  c = await cur(); const v0 = c.version;
  const ok1 = await call("super", "PUT", "/office.test_threshold", { value: 20, expected_version: v0, reason: "tune" }); assert.equal(ok1.status, 200); assert.equal(ok1.json.setting.value, 20); assert.equal(ok1.json.setting.version, v0 + 1); assert.equal(ok1.json.changed, true); assert.equal(ok1.json.setting.updated_by, "super@ochiga.test");
  const stale = await call("admin", "PUT", "/office.test_threshold", { value: 30, expected_version: v0 }); assert.equal(stale.status, 409); assert.equal(stale.json.error, "version_conflict"); assert.equal(stale.json.current.version, v0 + 1); assert.equal(stale.json.current.value, 20, "409 carries the current stored value");
  assert.equal((await cur()).value, 20, "a conflicting write changed nothing");
  const same = await call("super", "PUT", "/office.test_threshold", { value: 20, expected_version: v0 + 1 }); assert.equal(same.status, 200); assert.equal(same.json.changed, false, "an identical value is reported as unchanged"); assert.equal(same.json.setting.version, v0 + 2, "but still advances the version (it is a recorded save)");
  const baseV = (await cur()).version;
  const race = await Promise.all(Array.from({ length: 8 }, (_, i) => call(i % 2 ? "super" : "admin", "PUT", "/office.test_threshold", { value: 40 + i, expected_version: baseV })));
  assert.equal(race.filter((r) => r.status === 200).length, 1, "of 8 concurrent writers with the same expected_version exactly one wins"); assert.equal(race.filter((r) => r.status === 409).length, 7); const afterRace = await cur(); assert.equal(afterRace.version, baseV + 1, "the version advanced exactly once");
  const created = await call("super", "PUT", "/office.test_mode", { value: "standard", expected_version: 5 }); assert.equal(created.status, 409, "expected_version must match even for the first save (0 = never saved)");
  // persistence round trip: a fresh store instance on the same file sees value, version and history
  const reopened = new FileLeadAgentsStore(filePath); await reopened.init();
  const row = await reopened.getRuntimeSetting("office.test_threshold"); assert.equal(row.value, afterRace.value); assert.equal(row.version, afterRace.version);
  const hist = await reopened.listRuntimeSettingHistory("office.test_threshold", { limit: 200 }); assert.ok(hist.rows.some((h) => h.outcome === "success") && hist.rows.some((h) => h.outcome === "conflict"), "history survived the restart");
  console.log("5. Versioning: server-confirmed value, 409 with current value, 8-way race has one winner, restart round-trip — PASS");

  // ---- history + audit ----
  const h = await call("super", "GET", "/office.test_threshold/history"); assert.equal(h.status, 200); assert.equal(h.json.supported, true);
  const outcomes = h.json.history.map((r) => r.outcome); for (const o of ["success", "conflict", "rejected", "denied"]) assert.ok(outcomes.includes(o), `history records ${o} attempts`);
  const okRow = h.json.history.find((r) => r.outcome === "success" && r.version === v0 + 1); assert.equal(okRow.previous_value, c.value); assert.equal(okRow.actor, "super@ochiga.test"); assert.equal(okRow.request_id, ok1.requestId, "history carries the request id"); assert.ok(okRow.created_at && okRow.version === v0 + 1);
  assert.ok(h.json.history.every((r, i, a) => i === 0 || String(a[i - 1].created_at) >= String(r.created_at)), "newest first");
  assert.equal((await call("super", "GET", "/office.test_threshold/history?limit=2")).json.history.length, 2, "limit honoured");
  assert.equal((await call("staff", "GET", "/office.test_banner/history")).status, 403, "history follows the read permission"); assert.equal((await call("super", "GET", "/nope/history")).status, 404);
  const rows = await auditRows("office.test_threshold"); const stat = (s) => rows.filter((r) => r.metadata.status === s);
  assert.ok(stat("success").length >= 3 && stat("failure").length >= 5, "audit records both successful and failed attempts");
  const auditOk = rows.find((r) => r.metadata.request_id === ok1.requestId); assert.equal(auditOk.action, "office_test_threshold_changed"); assert.equal(auditOk.actor_email, "super@ochiga.test"); assert.equal(auditOk.metadata.old_value, c.value); assert.equal(auditOk.metadata.new_value, 20); assert.equal(auditOk.metadata.version, v0 + 1); assert.equal(auditOk.metadata.outcome, "success");
  assert.ok(rows.some((r) => r.metadata.outcome === "conflict" && r.metadata.status === "failure"), "conflicts are audited"); assert.ok(rows.some((r) => r.metadata.outcome === "denied"), "permission denials are audited");
  assert.ok((await auditRows("office.does_not_exist")).some((r) => r.action === "settings.write_rejected"), "unknown-key attempts are audited without a history row");
  assert.ok((await auditRows("office.test_threshold")).every((r) => r.metadata.request_id), "every audit row carries the request id");
  console.log("6. History and audit: success, conflict, rejected and denied attempts with actor, request id, versions — PASS");

  // ---- delegated autonomy through its own route: unchanged contract, now versioned + history ----
  const put = (enabled) => fetch(`${base}/api/lead-agents/admin/settings/whatsapp-autonomy`, { method: "PUT", headers: { "content-type": "application/json", cookie: cookies.super }, body: JSON.stringify({ enabled }) });
  const on = await put(true); assert.equal(on.status, 200); const onJson = await on.json(); assert.equal(onJson.whatsapp_autonomy.enabled, true);
  const view = (await call("super", "GET", "/whatsapp_autonomous_responses_enabled")).json.setting; assert.equal(view.value, true); assert.equal(view.version, 1); assert.equal(view.updated_by, "super@ochiga.test");
  assert.equal((await put(false)).status, 200); const view2 = (await call("super", "GET", "/whatsapp_autonomous_responses_enabled")).json.setting; assert.equal(view2.value, false); assert.equal(view2.version, 2);
  const ah = (await call("super", "GET", "/whatsapp_autonomous_responses_enabled/history")).json.history; assert.deepEqual(ah.map((r) => [r.version, r.new_value, r.outcome]), [[2, false, "success"], [1, true, "success"]]); assert.ok(ah.every((r) => r.request_id && r.actor === "super@ochiga.test"), "autonomy history has actor and request id");
  assert.equal((await fetch(`${base}/api/lead-agents/admin/settings/whatsapp-autonomy`, { method: "PUT", headers: { "content-type": "application/json", cookie: cookies.staff }, body: JSON.stringify({ enabled: true }) })).status, 403, "the autonomy route still requires integrations.manage");
  assert.equal((await fetch(`${base}/api/lead-agents/admin/settings/whatsapp-autonomy`, { method: "PUT", headers: { "content-type": "application/json", cookie: cookies.super }, body: JSON.stringify({ enabled: "yes" }) })).status, 400, "and still rejects non-boolean values");
  await store.setRuntimeSetting("whatsapp_webhook_signature_stats", { counts: { valid_raw: 1 } }, "webhook-signature-monitor", { history: false });
  assert.equal((await store.listRuntimeSettingHistory("whatsapp_webhook_signature_stats")).rows.length, 0, "high-frequency system counters do not write history");
  assert.equal((await call("staff", "GET", "/whatsapp_webhook_signature_stats")).status, 403, "counters are admin-only");
  console.log("7. Delegated autonomy: existing route/permission/validation unchanged; now versioned with history; system counters opt out — PASS");

  // ---- security: no secret anywhere ----
  const everything = [list.text, (await call("super", "GET", "")).text, (await call("super", "GET", "/mirror.backend.bridge")).text, (await call("super", "GET", "/mirror.secret_probe")).text, (await call("super", "GET", "/communication_outbox_settings")).text, h.text, JSON.stringify(await store.listAuditEvents(500))].join("\n");
  for (const s of [SECRET_A, SECRET_B, SECRET_C, "very-secret-value-DDD", "svc-key"]) assert.ok(!everything.includes(s), `secret sentinel ${s} never appears in responses, history or audit`);
  assert.deepEqual((await call("super", "GET", "/mirror.secret_probe")).json.setting.value, { configured: true }, "a sensitive value is reduced to configured/not configured");
  assert.equal((await call("super", "GET", "/whatsapp_webhook_signature_mode")).json.setting.value.mode, "enforce", "signature enforcement is reported, never changed");
  assert.equal((await call("super", "GET", "/mirror.backend.bridge")).json.setting.value.configured, true); assert.equal((await call("super", "GET", "/mirror.backend.bridge")).json.setting.value.verification, "configuration_only");
  // store-level redaction in history
  await store.writeRuntimeSetting("office.redact_probe", "top-secret-EEE", "tester", { expectedVersion: 0, redact: true }); const rh = await store.listRuntimeSettingHistory("office.redact_probe"); assert.equal(rh.rows[0].new_value, "[redacted]", "redacted history never holds the value");
  assert.ok(!fs.readFileSync(filePath, "utf8").includes("very-secret-value-DDD"), "mirror values are not persisted anywhere");
  console.log("8. Security: no secret in any response/history/audit, sensitive values reduced to configured, signature mode reported not changed — PASS");

  server.closeAllConnections?.(); await new Promise((r) => server.close(r));
  console.log(JSON.stringify({ status: "PASS", suite: "settings-registry" }));
}
main().catch((error) => { console.error(error); process.exit(1); });
