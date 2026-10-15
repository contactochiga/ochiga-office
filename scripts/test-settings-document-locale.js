// Settings S6.2: office_document_locale — registry descriptor, the three supported locales, unsupported-value rejection, permissions, versioning, concurrency, restart
// persistence, audit/history, document-generation round trips (both date paths), preservation of existing documents, fallback, metadata provenance, and the things
// that must NOT change (amounts, scheduling, timestamps, brand). Real Office server, file store, fixtures only.
const assert = require("node:assert/strict");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { FileLeadAgentsStore } = require("../src/lead-agents/store-file");
const { hashPassword } = require("../src/lead-agents/auth");
const { LOCALE_KEY, SUPPORTED_LOCALES, validateLocale, formatDocumentDate, resolveDocumentLocale } = require("../src/lead-agents/document-locale");
const { BRAND_KEY } = require("../src/lead-agents/document-brand");
const { createSettingsRegistry } = require("../src/lead-agents/settings-registry");
const { parsePreferredSchedule } = require("../src/lead-agents/scheduling");

const limiter = (n) => new MemoryRateLimiter({ windowMs: 60000, maxRequests: n });
const listen = (s) => new Promise((res, rej) => { s.once("error", rej); s.listen(0, "127.0.0.1", () => res(s.address().port)); });
const SETTING = `/api/lead-agents/admin/settings/${LOCALE_KEY}`;

async function boot(store, config) {
  const server = buildServer({ config, store, rateLimiter: limiter(5000), publicRateLimiter: limiter(5000), officeRateLimiter: limiter(5000), loginRateLimiter: limiter(500), whatsappAdapter: { verifyWebhook: () => null, verifySignature: () => ({ ok: true }), extractEvents: () => [], isConfigured: () => true, sendTextMessage: async () => { throw new Error("no customer message"); }, sendTemplateMessage: async () => ({ delivered: false }), listApprovedTemplates: async () => [] }, openaiClient: {}, toolExecutor: new ToolExecutor({ store, config, log: () => {}, webhooks: new WebhookDispatcher({ config }) }) });
  const base = `http://127.0.0.1:${await listen(server)}`;
  const cookies = {};
  for (const k of ["super", "admin", "staff", "estate"]) { const r = await fetch(`${base}/api/lead-agents/admin/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${k}@ochiga.test`, password: "pass-12345-xyz" }) }); assert.equal(r.status, 200); cookies[k] = r.headers.get("set-cookie").split(";")[0]; }
  const call = async (who, method, path, body) => { const headers = { "content-type": "application/json", ...(who === "apikey" ? { "x-api-key": "svc-key" } : who ? { cookie: cookies[who] } : {}) }; const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ } return { status: r.status, json, text }; };
  return { server, base, call, close: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); } };
}
const genDoc = async (app, over = {}) => { const r = await app.call("super", "POST", "/api/lead-agents/admin/documents/generate", { title: "Locale Test", document_type: "proposal", recipient: "Client", body: "Hello", ...over }); assert.equal(r.status, 201, r.text.slice(0, 200)); const doc = r.json.document; const html = await fetch(doc.share_url.replace(/^https?:\/\/[^/]+/, app.base)).then((x) => x.text()); return { doc, html }; };
// the date may roll over midnight between generation and the assertion: accept today's or the neighbouring day's rendering
const expectDates = (loc, style, before, after) => [formatDocumentDate(before, loc, style), formatDocumentDate(after, loc, style)];
const hasDate = (html, candidates) => candidates.some((c) => html.includes(c));

async function main() {
  // ---- 1. unit: validation and formatting ----
  for (const l of SUPPORTED_LOCALES) assert.deepEqual(validateLocale(l), { ok: true, value: l });
  for (const v of ["fr-FR", "en-AU", "en_NG", "EN-NG", "en-ng", "en", "", " en-NG", "en-NG ", "en-NG;q=1", 'en-US"><script>', "en-US\n", null, undefined, 5, true, [], ["en-NG"], {}, { locale: "en-US" }]) assert.equal(validateLocale(v).ok, false, `rejects ${String(JSON.stringify(v))}`);
  const d = new Date("2026-10-15T12:00:00Z");
  assert.equal(formatDocumentDate(d, "en-NG", "short"), d.toLocaleDateString("en-NG"), "en-NG short is exactly the pre-S6.2 output"); assert.equal(formatDocumentDate(d, "en-NG", "long"), d.toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" }), "en-NG long is exactly the pre-S6.2 output");
  assert.deepEqual([formatDocumentDate(d, "en-US", "short"), formatDocumentDate(d, "en-US", "long")], ["10/15/2026", "October 15, 2026"]); assert.deepEqual([formatDocumentDate(d, "en-GB", "short"), formatDocumentDate(d, "en-GB", "long")], ["15/10/2026", "15 October 2026"]);
  assert.equal(formatDocumentDate(d, "fr-FR", "long"), formatDocumentDate(d, "en-NG", "long"), "an unsupported locale never reaches Intl: it degrades to en-NG"); assert.equal(formatDocumentDate(d, undefined, "short"), formatDocumentDate(d, "en-NG", "short"));
  console.log("1. Locale validation (exact enum) and formatting (en-NG identical to the previous output; en-GB/en-US differ; unsupported degrades to en-NG) — PASS");

  // ---- server ----
  const { store, filePath } = await createTempStore();
  const config = { ...createConfig(), authMode: "required_api_key", apiKeys: ["svc-key"], allowedOrigins: [], officeDocumentBrandName: "OCHIGA OFFICE" };
  for (const [k, role] of Object.entries({ super: "super_admin", admin: "ochiga_admin", staff: "ochiga_staff", estate: "estate_admin" })) await store.ensureAdminUser({ email: `${k}@ochiga.test`, password_hash: hashPassword("pass-12345-xyz"), role, display_name: k, status: "active" });
  const logs = []; const origWrite = process.stdout.write.bind(process.stdout); process.stdout.write = (c, ...r) => { logs.push(String(c)); return origWrite(c, ...r); };
  let app = await boot(store, config);

  // ---- 2. descriptor ----
  const reg = createSettingsRegistry({ config }).get(LOCALE_KEY);
  const e = (await app.call("super", "GET", SETTING)).json.setting;
  assert.deepEqual([e.key, e.owner, e.scope, e.type, e.mode, e.storage, e.read_permission, e.write_permission, e.sensitive, e.requires_confirmation, reg.audit_action, e.edit_section], [LOCALE_KEY, "office", "global", "enum", "generic", "runtime_settings", "office.read", "settings.manage", false, false, "office_document_locale_changed", "organization"]);
  assert.deepEqual([e.value, e.default, e.version, e.source, e.editable, e.choices], ["en-NG", "en-NG", 0, "default", true, ["en-NG", "en-GB", "en-US"]], "default en-NG, never saved = version 0, exactly the three supported choices");
  assert.ok((await app.call("super", "GET", "/api/lead-agents/admin/settings")).json.settings.some((s) => s.key === LOCALE_KEY));
  console.log("2. Registry descriptor: office/global/enum, permissions, audit action, default en-NG, exactly three choices — PASS");

  // ---- 3. permissions and refusals ----
  assert.equal((await app.call(null, "PUT", SETTING, { value: "en-US", expected_version: 0 })).status, 401); assert.equal((await app.call("estate", "GET", SETTING)).status, 403, "no office.read"); assert.equal((await app.call("staff", "GET", SETTING)).json.setting.editable, false, "office.read reads, no edit offered");
  assert.equal((await app.call("staff", "PUT", SETTING, { value: "en-US", expected_version: 0 })).status, 403); assert.equal((await app.call("estate", "PUT", SETTING, { value: "en-US", expected_version: 0 })).status, 403);
  const ak = await app.call("apikey", "PUT", SETTING, { value: "en-US", expected_version: 0 }); assert.equal(ak.status, 403); assert.equal(ak.json.error, "actor_identity_required");
  for (const bad of ["fr-FR", "en-AU", "EN-US", "en_US", "en", "", "en-US ", null, 5, ["en-US"], 'en-US"><script>']) { const r = await app.call("super", "PUT", SETTING, { value: bad, expected_version: 0 }); assert.equal(r.status, 400, `rejects ${JSON.stringify(bad)}`); assert.equal(r.json.error, "invalid_value"); }
  assert.equal((await app.call("super", "PUT", SETTING, { value: "en-US" })).json.error, "expected_version_required"); assert.equal((await app.call("super", "GET", SETTING)).json.setting.version, 0, "no refused write changed anything");
  console.log("3. Permissions (401/403/API key) and unsupported-locale rejection (11 values) over HTTP; nothing changed — PASS");

  // ---- 4. document baseline (en-NG default) ----
  const t0 = new Date(); const base1 = await genDoc(app); const base1tpl = await genDoc(app, { template_id: "memo" }); const t1 = new Date();
  assert.ok(hasDate(base1.html, expectDates("en-NG", "short", t0, t1)), "default document, en-NG short date"); assert.ok(hasDate(base1tpl.html, expectDates("en-NG", "long", t0, t1)), "template document, en-NG long date");
  assert.deepEqual([base1.doc.metadata.document_locale, base1.doc.metadata.document_locale_source, base1.doc.metadata.document_locale_version], ["en-NG", "default", null], "provenance: default, no version");

  // ---- 5. all three locales: write, server-confirmed value, document round trips ----
  let version = 0; const docs = {};
  for (const loc of ["en-US", "en-GB", "en-NG"]) {
    const w = await app.call("super", "PUT", SETTING, { value: loc, expected_version: version, reason: `to ${loc}` }); assert.equal(w.status, 200); version += 1;
    assert.deepEqual([w.json.setting.value, w.json.setting.version, w.json.setting.source, w.json.changed, w.json.setting.updated_by], [loc, version, "stored", true, "super@ochiga.test"], "server-confirmed value and version");
    const a = new Date(); const dflt = await genDoc(app, { amount: 1234567 }); const tpl = await genDoc(app, { template_id: "cover_letter" }); const b = new Date(); docs[loc] = { dflt, tpl };
    assert.ok(hasDate(dflt.html, expectDates(loc, "short", a, b)), `${loc}: default document uses the short ${loc} date`); assert.ok(hasDate(tpl.html, expectDates(loc, "long", a, b)), `${loc}: template document uses the long ${loc} date`);
    assert.deepEqual([dflt.doc.metadata.document_locale, dflt.doc.metadata.document_locale_source, dflt.doc.metadata.document_locale_version], [loc, "stored", version], `${loc}: provenance recorded`); assert.equal(tpl.doc.metadata.document_locale, loc);
    assert.ok(dflt.html.includes("NGN 1,234,567"), `${loc}: money formatting is unchanged (en-NG grouping, NGN)`);
  }
  assert.ok(hasDate(docs["en-US"].tpl.html, expectDates("en-US", "long", new Date(Date.now() - 5000), new Date())) && !docs["en-US"].tpl.html.includes(formatDocumentDate(new Date(), "en-NG", "long")), "en-US really renders 'October 15, 2026' style, not the en-NG style");
  const stillOld = await fetch(base1.doc.share_url.replace(/^https?:\/\/[^/]+/, app.base)).then((r) => r.text()); assert.equal(stillOld, base1.html, "an existing document is byte-identical after the locale changed"); assert.equal(await fetch(base1tpl.doc.share_url.replace(/^https?:\/\/[^/]+/, app.base)).then((r) => r.text()), base1tpl.html);
  for (const loc of ["en-US", "en-GB"]) assert.equal(await fetch(docs[loc].dflt.doc.share_url.replace(/^https?:\/\/[^/]+/, app.base)).then((r) => r.text()), docs[loc].dflt.html, `a ${loc} document is not re-rendered later`);
  console.log("4-5. All three locales round-trip through both document paths with the right date style; metadata provenance; money unchanged; existing documents byte-identical — PASS");

  // ---- 6. things that must not change ----
  assert.match(base1.doc.created_at || "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "canonical timestamps stay ISO-8601"); await app.call("super", "PUT", SETTING, { value: "en-US", expected_version: version }); version += 1;
  const usDoc = await genDoc(app); assert.match(usDoc.doc.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/, "ISO-8601 UTC timestamp regardless of locale"); assert.ok(Math.abs(Date.parse(usDoc.doc.created_at) - Date.now()) < 60_000, "and it is the real creation time");
  const sched = (loc) => JSON.stringify(parsePreferredSchedule({ text: "Tuesday 14:30 Lagos", timezoneHint: "Africa/Lagos", now: new Date("2026-10-15T09:00:00Z") })); assert.equal(sched("en-NG"), sched("en-US"), "scheduling parse and meeting-time display do not depend on the document locale");
  assert.ok(usDoc.html.includes("OCHIGA OFFICE"), "brand unaffected by the locale"); await app.call("super", "PUT", `/api/lead-agents/admin/settings/${BRAND_KEY}`, { value: "Ochiga Group (S6.2)", expected_version: 0 });
  const both = await genDoc(app, { template_id: "memo" }); assert.ok(both.html.includes("Ochiga Group (S6.2)") && both.html.includes("October") && /October \d{1,2}, \d{4}/.test(both.html), "brand (S6.1) and locale (S6.2) apply together"); assert.deepEqual([both.doc.metadata.brand_name_source, both.doc.metadata.document_locale_source], ["stored", "stored"]);
  const lh = await app.call("super", "PATCH", "/api/lead-agents/admin/letterhead-config", { tagline: "S6.2", website: "www.ochiga.com.ng" }); assert.equal(lh.status, 200, "letterhead PATCH contract unchanged");
  const on = await app.call("super", "PUT", "/api/lead-agents/admin/settings/whatsapp-autonomy", { enabled: true }); assert.equal(on.json.whatsapp_autonomy.enabled, true); await app.call("super", "PUT", "/api/lead-agents/admin/settings/whatsapp-autonomy", { enabled: false });
  console.log("6. Timestamps, scheduling, brand, letterhead and autonomy unaffected; brand and locale apply together — PASS");

  // ---- 7. conflicts, concurrency, history, audit ----
  const stale = await app.call("admin", "PUT", SETTING, { value: "en-GB", expected_version: 1 }); assert.equal(stale.status, 409); assert.equal(stale.json.error, "version_conflict"); assert.deepEqual([stale.json.current.value, stale.json.current.version], ["en-US", version]);
  const race = await Promise.all(Array.from({ length: 8 }, (_, i) => app.call(i % 2 ? "super" : "admin", "PUT", SETTING, { value: SUPPORTED_LOCALES[i % 3], expected_version: version }))); assert.equal(race.filter((r) => r.status === 200).length, 1, "8 concurrent writers: one winner"); assert.equal(race.filter((r) => r.status === 409).length, 7); version += 1;
  const cur = (await app.call("super", "GET", SETTING)).json.setting; assert.equal(cur.version, version);
  const hist = (await app.call("super", "GET", `${SETTING}/history`)).json; assert.equal(hist.supported, true); for (const o of ["success", "conflict", "rejected", "denied"]) assert.ok(hist.history.map((h) => h.outcome).includes(o), `history records ${o}`);
  const first = hist.history.filter((h) => h.outcome === "success").sort((a, b) => a.version - b.version)[0]; assert.deepEqual([first.version, first.previous_value, first.new_value, first.actor, first.request_id !== null], [1, null, "en-US", "super@ochiga.test", true]);
  const audit = (await store.listAuditEvents(2000)).filter((x) => x.target_id === LOCALE_KEY && x.action === "office_document_locale_changed"); const a1 = audit.find((x) => x.metadata.version === 1);
  assert.deepEqual([a1.metadata.status, a1.metadata.outcome, a1.actor_email, a1.metadata.old_value, a1.metadata.new_value, a1.metadata.reason, !!a1.metadata.request_id, !!a1.created_at], ["success", "success", "super@ochiga.test", null, "en-US", "to en-US", true, true]);
  assert.ok(audit.some((x) => x.metadata.outcome === "conflict") && audit.some((x) => x.metadata.outcome === "denied") && audit.some((x) => x.metadata.outcome === "rejected"), "failed attempts are audited");
  console.log("7. 409, 8-way race one winner, history and audit (actor, request id, old/new, version, outcome) under office_document_locale_changed — PASS");

  // ---- 8. restart persistence ----
  await app.close(); const reopened = new FileLeadAgentsStore(filePath); await reopened.init(); app = await boot(reopened, config);
  const p = (await app.call("super", "GET", SETTING)).json.setting; assert.deepEqual([p.value, p.version], [cur.value, version], "value and version survive a restart"); const pd = await genDoc(app, { template_id: "memo" }); assert.deepEqual([pd.doc.metadata.document_locale, pd.doc.metadata.document_locale_source, pd.doc.metadata.document_locale_version], [cur.value, "stored", version]);
  // ---- 9. fallback ----
  await reopened.writeRuntimeSetting(LOCALE_KEY, "fr-FR", "bypass-test", { expectedVersion: version }); version += 1;
  const inv = await genDoc(app, { template_id: "memo" }); assert.ok(hasDate(inv.html, expectDates("en-NG", "long", new Date(Date.now() - 5000), new Date())), "an invalid stored value renders en-NG"); assert.deepEqual([inv.doc.metadata.document_locale, inv.doc.metadata.document_locale_source], ["en-NG", "fallback"]);
  assert.ok(logs.join("").includes("document_locale.fallback") && logs.join("").includes("stored_value_invalid") && !logs.join("").includes("fr-FR"), "fallback logged with its reason, never the offending value");
  await reopened.writeRuntimeSetting(LOCALE_KEY, "en-GB", "restore", { expectedVersion: version }); version += 1;
  const realGet = reopened.getRuntimeSetting.bind(reopened); reopened.getRuntimeSetting = async (k) => { if (k === LOCALE_KEY) { const err = new Error("db down"); err.code = "ECONNRESET"; throw err; } return realGet(k); };
  const unread = await genDoc(app); assert.deepEqual([unread.doc.metadata.document_locale, unread.doc.metadata.document_locale_source, unread.doc.metadata.document_locale_version], ["en-NG", "fallback", null], "unreadable setting -> en-NG, recorded as fallback; the document is still generated"); assert.ok(/document_locale\.fallback[^\n]*setting_unreadable/.test(logs.join(""))); reopened.getRuntimeSetting = realGet;
  const realWrite = reopened.writeRuntimeSetting.bind(reopened); reopened.writeRuntimeSetting = async () => { throw new Error("db down"); }; const nw = await app.call("super", "PUT", SETTING, { value: "en-US", expected_version: version }); assert.equal(nw.status, 503); assert.equal(nw.json.error, "setting_not_saved"); reopened.writeRuntimeSetting = realWrite; assert.equal((await app.call("super", "GET", SETTING)).json.setting.value, "en-GB", "a failed save is reported as failed; the stored value is unchanged");
  assert.deepEqual(await resolveDocumentLocale({ getRuntimeSetting: async () => ({ value: "en-US", version: 7 }) }), { locale: "en-US", source: "stored", version: 7, reason: null }); assert.equal((await resolveDocumentLocale({ getRuntimeSetting: async () => null })).source, "default");
  process.stdout.write = origWrite;
  console.log("8-9. Restart persistence; invalid or unreadable setting -> en-NG fallback recorded in metadata and logged safely; failed save -> 503, unchanged — PASS");
  await app.close();
  console.log(JSON.stringify({ status: "PASS", suite: "settings-document-locale" }));
}
main().catch((error) => { console.error(error); process.exit(1); });
