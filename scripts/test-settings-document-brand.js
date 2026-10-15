// Settings S6.1: office_document_brand_name — registry descriptor, validation boundaries, permissions, versioning, concurrency, restart persistence, audit/history,
// the two document-generation paths (round trip, HTML escaping, environment fallback, preservation of existing documents). Real Office server, file store, fixtures only.
const assert = require("node:assert/strict");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { FileLeadAgentsStore } = require("../src/lead-agents/store-file");
const { hashPassword } = require("../src/lead-agents/auth");
const { validateBrandName, resolveDocumentBrandName, BRAND_KEY, BRAND_MAX } = require("../src/lead-agents/document-brand");
const { createSettingsRegistry } = require("../src/lead-agents/settings-registry");

const limiter = (n) => new MemoryRateLimiter({ windowMs: 60000, maxRequests: n });
const listen = (s) => new Promise((res, rej) => { s.once("error", rej); s.listen(0, "127.0.0.1", () => res(s.address().port)); });
const SETTING = `/api/lead-agents/admin/settings/${BRAND_KEY}`;

async function boot(store, config, logs) {
  const server = buildServer({ config, store, rateLimiter: limiter(5000), publicRateLimiter: limiter(5000), officeRateLimiter: limiter(5000), loginRateLimiter: limiter(500), whatsappAdapter: { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: () => [], isConfigured: () => true, sendTextMessage: async () => { throw new Error("no customer message"); }, sendTemplateMessage: async () => ({ delivered: false }), listApprovedTemplates: async () => [] }, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const base = `http://127.0.0.1:${await listen(server)}`;
  const cookies = {};
  for (const k of ["super", "admin", "staff", "estate"]) { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${k}@ochiga.test`, password: "pass-12345-xyz" }) }); assert.equal(r.status, 200); cookies[k] = r.headers.get("set-cookie").split(";")[0]; }
  const call = async (who, method, path, body, raw = false) => { const headers = { "content-type": "application/json", ...(who === "apikey" ? { "x-api-key": "svc-key" } : who ? { cookie: cookies[who] } : {}) }; const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ } return { status: r.status, json, text }; };
  return { server, base, call, close: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); } };
}
const genDoc = async (app, who, over = {}) => { const r = await app.call(who, "POST", "/api/lead-agents/admin/documents/generate", { title: "Brand Test", document_type: "proposal", recipient: "Client", body: "Hello", ...over }); assert.equal(r.status, 201, r.text.slice(0, 200)); const doc = r.json.document; const html = await fetch(doc.share_url.replace(/^https?:\/\/[^/]+/, app.base)).then((x) => x.text()); return { doc, html }; };

async function main() {
  // ---- 1. validation boundaries (unit) ----
  const ok = (v, expect) => { const r = validateBrandName(v); assert.equal(r.ok, true, `accepts ${JSON.stringify(v)}`); assert.equal(r.value, expect === undefined ? v : expect); };
  const bad = (v, error) => { const r = validateBrandName(v); assert.equal(r.ok, false, `rejects ${String(JSON.stringify(v)).slice(0, 40)}`); if (error) assert.equal(r.error, error, `value ${JSON.stringify(v)} gave ${r.error}`); };
  ok("A"); ok("x".repeat(BRAND_MAX)); ok("Ochiga & Sons (Nigeria), Ltd."); ok("O'Brien-Smith"); ok("Réseau Œuvre 2026"); ok("  Ochiga Office  ", "Ochiga Office"); ok("研究所 123"); ok("A.B. C-D, E (F) & G's");
  bad("", "must_be_at_least_1_characters"); bad("   ", "must_be_at_least_1_characters"); bad("x".repeat(BRAND_MAX + 1), "must_be_at_most_60_characters"); bad(" " + "x".repeat(BRAND_MAX + 1) + " ", "must_be_at_most_60_characters");
  for (const v of ["<b>x</b>", "a<b", "a>b", "x\u0000y", "tab\tx", "new\nline", "cr\rx", 'say "hi"', "a/b", "a\\b", "a;b", "a:b", "a`b", "a=b", "a%b", "a#b", "a@b", "a!b", "a*b", "a+b", "a_b", "a|b", "a{b}", "a[b]", "’", "a​b", "a‮b", "😀", "javascript:alert(1)", "&lt;", "&#60;", " ", "x\u007fy"]) { bad(v); assert.ok(["invalid_characters", "must_be_at_least_1_characters"].includes(validateBrandName(v).error)); }
  bad("\u2028"); bad("\u00a0\u3000");
  for (const v of [null, undefined, 5, true, [], {}, ["a"], { a: 1 }]) bad(v, "must_be_string");
  console.log("1. Validation boundaries: 1–60 trimmed; allowed set accepted incl. unicode; angle brackets, quotes, control/zero-width/bidi characters, entities and non-strings rejected — PASS");

  // ---- server ----
  const { store, filePath } = await createTempStore();
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["svc-key"], allowedOrigins: [], officeDocumentBrandName: "OCHIGA OFFICE" };
  for (const [k, role] of Object.entries({ super: "super_admin", admin: "ochiga_admin", staff: "ochiga_staff", estate: "estate_admin" })) await store.ensureAdminUser({ email: `${k}@ochiga.test`, password_hash: hashPassword("pass-12345-xyz"), role, display_name: k, status: "active" });
  const logs = []; const origWrite = process.stdout.write.bind(process.stdout); process.stdout.write = (c, ...r) => { logs.push(String(c)); return origWrite(c, ...r); };
  let app = await boot(store, config, logs);

  // ---- 2. registry descriptor ----
  const d = (await app.call("super", "GET", SETTING)).json.setting;
  assert.deepEqual([d.key, d.owner, d.scope, d.type, d.mode, d.storage, d.read_permission, d.write_permission, d.sensitive, d.requires_confirmation, createSettingsRegistry({ config }).get(BRAND_KEY).audit_action, d.edit_section], [BRAND_KEY, "office", "global", "string", "generic", "runtime_settings", "office.read", "settings.manage", false, false, "office_document_brand_name_changed", "organization"]);
  assert.deepEqual([d.value, d.default, d.version, d.source, d.editable, d.history_supported], ["OCHIGA OFFICE", "OCHIGA OFFICE", 0, "default", true, true], "default = the configured environment brand name; never saved = version 0");
  assert.equal(createSettingsRegistry({ config: { officeDocumentBrandName: "" } }).get(BRAND_KEY).default, "OCHIGA OFFICE", "with no configured value the default is OCHIGA OFFICE"); assert.equal(createSettingsRegistry({ config: { officeDocumentBrandName: "Acme" } }).get(BRAND_KEY).default, "Acme", "an existing configured value is the default");
  assert.ok((await app.call("super", "GET", "/api/lead-agents/admin/settings")).json.settings.some((s) => s.key === BRAND_KEY), "listed in the registry"); assert.equal((await app.call("super", "GET", SETTING)).json.setting.sensitive, false);
  console.log("2. Registry descriptor: owner/scope/type/permissions/audit action, default from configuration or OCHIGA OFFICE, not sensitive, not confirmation-gated — PASS");

  // ---- 3. permissions ----
  assert.equal((await app.call(null, "GET", SETTING)).status, 401); assert.equal((await app.call(null, "PUT", SETTING, { value: "X", expected_version: 0 })).status, 401);
  assert.equal((await app.call("estate", "GET", SETTING)).status, 403, "no office.read -> cannot read"); const sv = await app.call("staff", "GET", SETTING); assert.equal(sv.status, 200); assert.equal(sv.json.setting.editable, false, "office.read can read but is not offered an edit");
  assert.equal((await app.call("staff", "PUT", SETTING, { value: "Staff Try", expected_version: 0 })).status, 403, "ochiga_staff has no settings.manage"); assert.equal((await app.call("estate", "PUT", SETTING, { value: "Estate Try", expected_version: 0 })).status, 403);
  const ak = await app.call("apikey", "PUT", SETTING, { value: "Key Try", expected_version: 0 }); assert.equal(ak.status, 403); assert.equal(ak.json.error, "actor_identity_required", "an API key carries no accountable person");
  assert.equal((await app.call("super", "GET", SETTING)).json.setting.version, 0, "no refused write changed anything");
  // validation over HTTP + required version
  for (const body of [{ value: "<b>x</b>", expected_version: 0 }, { value: "", expected_version: 0 }, { value: "x".repeat(61), expected_version: 0 }, { value: 5, expected_version: 0 }]) { const r = await app.call("super", "PUT", SETTING, body); assert.equal(r.status, 400); assert.equal(r.json.error, "invalid_value"); }
  assert.equal((await app.call("super", "PUT", SETTING, { value: "Ok Name" })).json.error, "expected_version_required"); assert.equal((await app.call("super", "GET", SETTING)).json.setting.version, 0);
  console.log("3. Permissions and refusals: 401, 403 (no office.read, no settings.manage, API key), 400 invalid values and missing version, nothing changed — PASS");

  // ---- 4. document round trip BEFORE any change; existing snapshot ----
  const before = await genDoc(app, "super"); assert.match(before.html, /OCHIGA OFFICE/); assert.equal(before.doc.metadata.brand_name_source, "default"); assert.equal(before.doc.metadata.brand_setting_version, null);
  const beforeTpl = await genDoc(app, "super", { template_id: "memo" }); assert.match(beforeTpl.html, /class="brandbar">OCHIGA OFFICE</, "template path uses the default");

  // ---- 5. governed write, server-confirmed value, versions, audit ----
  const NEW = "Ochiga & Sons (Nigeria), Ltd.";
  const w1 = await app.call("super", "PUT", SETTING, { value: `  ${NEW}  `, expected_version: 0, reason: "rebrand" }); assert.equal(w1.status, 200);
  assert.deepEqual([w1.json.setting.value, w1.json.setting.version, w1.json.setting.updated_by, w1.json.changed, w1.json.setting.source], [NEW, 1, "super@ochiga.test", true, "stored"], "the response is the server-confirmed, trimmed stored value");
  const stale = await app.call("admin", "PUT", SETTING, { value: "Stale Edit", expected_version: 0 }); assert.equal(stale.status, 409); assert.equal(stale.json.error, "version_conflict"); assert.deepEqual([stale.json.current.value, stale.json.current.version], [NEW, 1]);
  const w2 = await app.call("admin", "PUT", SETTING, { value: "Ochiga Group", expected_version: 1 }); assert.equal(w2.status, 200); assert.equal(w2.json.setting.version, 2, "an ochiga_admin (settings.manage) may write");
  const race = await Promise.all(Array.from({ length: 8 }, (_, i) => app.call(i % 2 ? "super" : "admin", "PUT", SETTING, { value: `Racer ${i}`, expected_version: 2 })));
  assert.equal(race.filter((r) => r.status === 200).length, 1, "8 concurrent writers: exactly one wins"); assert.equal(race.filter((r) => r.status === 409).length, 7); const afterRace = (await app.call("super", "GET", SETTING)).json.setting; assert.equal(afterRace.version, 3); assert.match(afterRace.value, /^Racer \d$/);
  const w4 = await app.call("super", "PUT", SETTING, { value: NEW, expected_version: 3 }); assert.equal(w4.status, 200); assert.equal(w4.json.setting.version, 4);
  const hist = (await app.call("super", "GET", `${SETTING}/history`)).json; assert.equal(hist.supported, true);
  const outcomes = hist.history.map((h) => h.outcome); for (const o of ["success", "conflict", "rejected", "denied"]) assert.ok(outcomes.includes(o), `history records ${o}`);
  const succ = hist.history.filter((h) => h.outcome === "success").sort((a, b) => a.version - b.version); assert.deepEqual(succ.map((h) => h.version), [1, 2, 3, 4]); assert.deepEqual([succ[0].previous_value, succ[0].new_value, succ[0].actor, succ[0].request_id !== null], [null, NEW, "super@ochiga.test", true]); assert.equal(succ[1].previous_value, NEW);
  const audit = (await store.listAuditEvents(1000)).filter((e) => e.target_id === BRAND_KEY && e.action === "office_document_brand_name_changed");
  const aOk = audit.find((e) => e.metadata.version === 1); assert.deepEqual([aOk.metadata.status, aOk.metadata.outcome, aOk.actor_email, aOk.metadata.old_value, aOk.metadata.new_value, aOk.metadata.reason, !!aOk.metadata.request_id, !!aOk.created_at], ["success", "success", "super@ochiga.test", null, NEW, "rebrand", true, true], "audit: actor, request id, previous/new value, version, timestamp, outcome");
  assert.ok(audit.some((e) => e.metadata.outcome === "conflict" && e.metadata.status === "failure") && audit.some((e) => e.metadata.outcome === "denied") && audit.some((e) => e.metadata.outcome === "rejected"), "failed attempts are audited too");
  console.log("4-5. Governed write: trimmed server-confirmed value, 409, 8-way race one winner, history and audit with actor/request id/old/new/version/outcome — PASS");

  // ---- 6. documents: new brand, escaping, existing snapshots preserved ----
  const afterDoc = await genDoc(app, "super"); assert.ok(afterDoc.html.includes(`<div class="brand">Ochiga &amp; Sons (Nigeria), Ltd.</div>`), "default path: brand HTML-escaped"); assert.ok(!afterDoc.html.includes(`>Ochiga & Sons`), "no raw ampersand in the markup"); assert.deepEqual([afterDoc.doc.metadata.brand_name_source, afterDoc.doc.metadata.brand_setting_version], ["stored", 4]);
  const afterTpl = await genDoc(app, "super", { template_id: "memo" }); assert.ok(afterTpl.html.includes(`class="brandbar">Ochiga &amp; Sons (Nigeria), Ltd.</div>`), "template path: brand HTML-escaped"); assert.equal(afterTpl.doc.metadata.brand_name_source, "stored");
  const stillOld = await fetch(before.doc.share_url.replace(/^https?:\/\/[^/]+/, app.base)).then((r) => r.text()); assert.equal(stillOld, before.html, "an existing document snapshot is byte-identical after the change"); assert.match(stillOld, /OCHIGA OFFICE/);
  assert.equal(await fetch(beforeTpl.doc.share_url.replace(/^https?:\/\/[^/]+/, app.base)).then((r) => r.text()), beforeTpl.html, "and so is an existing template document");
  console.log("6. Both document paths use the stored brand (escaped); existing snapshots unchanged — PASS");

  // ---- 7. escaping defence in depth ----
  const EVIL = `<img src=x onerror=alert(1)>"&`;
  await store.writeRuntimeSetting(BRAND_KEY, EVIL, "bypass-test", { expectedVersion: 4 }); // a value that bypassed the validator (direct store write)
  const ev = await genDoc(app, "super"); assert.ok(!ev.html.includes("<img src=x"), "a stored value outside the allowed set is never rendered"); assert.match(ev.html, /<div class="brand">OCHIGA OFFICE<\/div>/); assert.equal(ev.doc.metadata.brand_name_source, "environment_fallback");
  const evTpl = await genDoc(app, "super", { template_id: "memo" }); assert.ok(!evTpl.html.includes("<img src=x") && /brandbar">OCHIGA OFFICE</.test(evTpl.html));
  assert.ok(logs.join("").includes("document_brand.fallback") && logs.join("").includes("stored_value_invalid"), "the fallback condition is logged with its reason"); assert.ok(!logs.join("").includes("onerror=alert"), "the offending value is never logged");
  await app.close(); // a hostile ENVIRONMENT value, no stored row: escaped at both insertion points
  const { store: s2 } = await createTempStore(); for (const [k, role] of Object.entries({ super: "super_admin", admin: "ochiga_admin", staff: "ochiga_staff", estate: "estate_admin" })) await s2.ensureAdminUser({ email: `${k}@ochiga.test`, password_hash: hashPassword("pass-12345-xyz"), role, display_name: k, status: "active" });
  const app2 = await boot(s2, { ...config, officeDocumentBrandName: `<script>alert("x")</script> & Co` }, logs);
  const envDoc = await genDoc(app2, "super"); assert.ok(!envDoc.html.includes("<script>alert") && envDoc.html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co"), "documentHtml escapes even an environment-supplied brand name (previously unescaped)");
  const envTpl = await genDoc(app2, "super", { template_id: "memo" }); assert.ok(!envTpl.html.includes("<script>alert") && envTpl.html.includes("&lt;script&gt;"), "templates too"); await app2.close();
  console.log("7. HTML escaping: validator-bypassing stored value falls back and is never rendered or logged; hostile environment value escaped at both insertion points — PASS");

  // ---- 8. restart persistence + environment fallback on read failure ----
  app = await boot(store, config, logs);
  const reopened = new FileLeadAgentsStore(filePath); await reopened.init();
  await reopened.writeRuntimeSetting(BRAND_KEY, NEW, "restore", { expectedVersion: 5 }); // valid value again (version 6)
  await app.close(); app = await boot(reopened, config, logs);
  const persisted = (await app.call("super", "GET", SETTING)).json.setting; assert.deepEqual([persisted.value, persisted.version], [NEW, 6], "value and version survive a restart");
  const pd = await genDoc(app, "super"); assert.ok(pd.html.includes("Ochiga &amp; Sons (Nigeria), Ltd.") && pd.doc.metadata.brand_name_source === "stored", "a restarted server renders the stored brand");
  const realGet = reopened.getRuntimeSetting.bind(reopened); reopened.getRuntimeSetting = async (k) => { if (k === BRAND_KEY) { const e = new Error("db down"); e.code = "ECONNRESET"; throw e; } return realGet(k); };
  const fb = await genDoc(app, "super"); assert.ok(/<div class="brand">OCHIGA OFFICE<\/div>/.test(fb.html), "unreadable setting -> the environment fallback; the document is still generated"); assert.deepEqual([fb.doc.metadata.brand_name_source, fb.doc.metadata.brand_setting_version], ["environment_fallback", null]);
  assert.ok(/document_brand\.fallback[^\n]*setting_unreadable/.test(logs.join("")), "fallback logged safely (reason only)");
  reopened.getRuntimeSetting = realGet;
  const realWrite = reopened.writeRuntimeSetting.bind(reopened); reopened.writeRuntimeSetting = async () => { throw new Error("db down"); };
  const nw = await app.call("super", "PUT", SETTING, { value: "Never Saved", expected_version: 6 }); assert.equal(nw.status, 503); assert.equal(nw.json.error, "setting_not_saved"); reopened.writeRuntimeSetting = realWrite;
  assert.equal((await app.call("super", "GET", SETTING)).json.setting.value, NEW, "a failed save is reported as failed and the stored value is unchanged (no fabricated persistence)");
  const direct = await resolveDocumentBrandName({ getRuntimeSetting: async () => ({ value: NEW, version: 9 }) }, config); assert.deepEqual([direct.source, direct.version], ["stored", 9]); assert.equal((await resolveDocumentBrandName({ getRuntimeSetting: async () => null }, { officeDocumentBrandName: "" })).name, "OCHIGA OFFICE");
  console.log("8. Restart persistence; unreadable setting -> environment fallback recorded on the document; failed save -> 503, value unchanged — PASS");

  // ---- 9. unrelated contracts untouched ----
  const lh = await app.call("super", "PATCH", "/api/lead-agents/admin/letterhead-config", { tagline: "S6.1 check", website: "www.ochiga.com.ng" }); assert.equal(lh.status, 200); assert.equal(lh.json.config.website, "www.ochiga.com.ng", "letterhead PATCH contract unchanged (scheme-less website still accepted)");
  const on = await app.call("super", "PUT", "/api/lead-agents/admin/settings/whatsapp-autonomy", { enabled: true }); assert.equal(on.status, 200); assert.equal(on.json.whatsapp_autonomy.enabled, true); assert.equal((await app.call("super", "PUT", "/api/lead-agents/admin/settings/whatsapp-autonomy", { enabled: false })).json.whatsapp_autonomy.enabled, false);
  assert.equal((await app.call("super", "PUT", `/api/lead-agents/admin/settings/whatsapp_autonomous_responses_enabled`, { value: true, expected_version: 0, confirm: true })).status, 405, "autonomy still cannot be written through the registry");
  process.stdout.write = origWrite;
  console.log("9. Letterhead PATCH and WhatsApp autonomy contracts unchanged — PASS");
  await app.close();
  console.log(JSON.stringify({ status: "PASS", suite: "settings-document-brand" }));
}
main().catch((error) => { console.error(error); process.exit(1); });
