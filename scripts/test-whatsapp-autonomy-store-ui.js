const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SupabaseLeadAgentsStore } = require("../src/lead-agents/store-supabase");
const { evaluateAutonomousWhatsAppPolicy, readWhatsAppAutonomySetting, WHATSAPP_AUTONOMY_SETTING_KEY } = require("../src/lead-agents/whatsapp-autonomy");

// Production (Supabase/PostgREST) store behaviour for the autonomy setting, with a recording fake HTTP client, plus static checks on the shipped Office UI and migration.
(async () => {
  const calls = [];
  const table = new Map();
  const store = new SupabaseLeadAgentsStore({ url: "https://example.supabase.co", serviceRoleKey: "k", requestTimeoutMs: 1000 });
  store.client = {
    get: async (url) => { calls.push(["GET", url]); const m = url.match(/office_runtime_settings\?key=eq\.([^&]+)/); if (m) { const r = table.get(decodeURIComponent(m[1])); return { data: r ? [r] : [] }; } return { data: [] }; },
    post: async (url, body, options) => { calls.push(["POST", url, body, options?.headers?.Prefer]); const row = { ...body }; table.set(body.key, row); return { data: [row] }; },
  };

  // missing row -> default OFF, known (not an error)
  const defaults = await readWhatsAppAutonomySetting(store);
  assert.deepEqual([defaults.known, defaults.enabled, defaults.source], [true, false, "default"]);
  assert.equal((await evaluateAutonomousWhatsAppPolicy(store)).allowed, false);

  // write: upsert on the key, merge-duplicates, returns previous and current
  const change = await store.setRuntimeSetting(WHATSAPP_AUTONOMY_SETTING_KEY, true, "admin@ochiga.local");
  assert.equal(change.previous, null); assert.equal(change.current.value, true); assert.equal(change.current.updated_by, "admin@ochiga.local");
  const post = calls.find((c) => c[0] === "POST");
  assert.match(post[1], /office_runtime_settings\?on_conflict=key/); assert.match(post[3], /merge-duplicates/);
  assert.equal((await evaluateAutonomousWhatsAppPolicy(store)).allowed, true);
  const second = await store.setRuntimeSetting(WHATSAPP_AUTONOMY_SETTING_KEY, false, "admin2@ochiga.local");
  assert.equal(second.previous.value, true, "the previous stored value is reported for the audit record");

  // reads are STRICT: transport errors, missing table (404/400) and malformed payloads are "unknown", never "false by default"
  for (const failure of [() => { const e = new Error("503"); e.response = { status: 503 }; throw e; }, () => { const e = new Error("relation does not exist"); e.response = { status: 404 }; throw e; }, () => { const e = new Error("bad"); e.response = { status: 400 }; throw e; }]) {
    store.client.get = async () => failure();
    const read = await readWhatsAppAutonomySetting(store);
    assert.equal(read.known, false); assert.equal(read.enabled, false);
    assert.equal((await evaluateAutonomousWhatsAppPolicy(store)).reason, "setting_unreadable");
  }
  store.client.get = async () => ({ data: "<html>gateway</html>" });
  assert.equal((await evaluateAutonomousWhatsAppPolicy(store)).allowed, false, "a malformed response never enables autonomy");
  store.client.get = async () => ({ data: [{ key: WHATSAPP_AUTONOMY_SETTING_KEY, value: "true" }] });
  assert.equal((await evaluateAutonomousWhatsAppPolicy(store)).allowed, false, "only the boolean true enables autonomy (a string does not)");
  // unconfirmed write is an error, not a success
  store.client.get = async () => ({ data: [] }); store.client.post = async () => ({ data: [] });
  await assert.rejects(() => store.setRuntimeSetting(WHATSAPP_AUTONOMY_SETTING_KEY, true, "a"), /write_unconfirmed/);
  // duplicate-inbound lookup
  store.client.get = async (url) => ({ data: /external_event_id=eq\.wamid\.1/.test(url) ? [{ id: 1 }] : [] });
  assert.equal(await store.hasInboundEvent({ channel: "whatsapp", eventType: "message", externalEventId: "wamid.1" }), true);
  assert.equal(await store.hasInboundEvent({ channel: "whatsapp", eventType: "message", externalEventId: "wamid.2" }), false);

  // atomic claim of an inbound message id: a unique-index conflict (409) is "duplicate", any other failure still throws
  store.client.post = async () => { const e = new Error("conflict"); e.response = { status: 409 }; throw e; };
  assert.deepEqual(await store.appendInboundEvent({ channel: "whatsapp", provider: "meta", event_type: "message", external_event_id: "wamid.1", payload: {} }), { duplicate: true });
  await assert.rejects(() => store.appendInboundEvent({ channel: "whatsapp", provider: "meta", event_type: "status:sent", external_event_id: "wamid.1", payload: {} }), /conflict/);
  store.client.post = async () => { const e = new Error("boom"); e.response = { status: 500 }; throw e; };
  await assert.rejects(() => store.appendInboundEvent({ channel: "whatsapp", provider: "meta", event_type: "message", external_event_id: "wamid.9", payload: {} }), /boom/);

  // migration + schema define the table and keep it out of anon access
  const migration = fs.readFileSync(path.join(__dirname, "..", "db", "20261014_office_runtime_settings.sql"), "utf8");
  assert.match(migration, /create table if not exists office_runtime_settings/); assert.match(migration, /enable row level security/);
  assert.match(migration, /inbound_events_message_once/); assert.match(migration, /raise notice/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "db", "lead-agents-schema.sql"), "utf8"), /create table if not exists office_runtime_settings/);

  // shipped Office UI
  const ui = fs.readFileSync(path.join(__dirname, "..", "public", "office", "office.js"), "utf8");
  assert.match(ui, /\/api\/lead-agents\/admin\/settings\/whatsapp-autonomy/, "the control talks to the real backend setting");
  assert.match(ui, /method: "PUT", body: \{ enabled \}/);
  for (const text of ["AUTONOMOUS RESPONSES ON", "AUTONOMOUS RESPONSES OFF", "TREATED AS OFF"]) assert.ok(ui.includes(text), `the state banner says: ${text}`);
  assert.match(ui, /Autonomous AI Responses/); assert.match(ui, /Official WhatsApp number/); assert.match(ui, /Last changed by \/ at/);
  assert.match(ui, /hasPermission\("integrations\.manage"\)/, "only administrators get the control");
  assert.match(ui, /status = result\.whatsapp_autonomy;[\s\S]*?draw\(\);/, "success renders the value the server returned");
  assert.match(ui, /Not saved —[\s\S]*The setting above is unchanged/, "a failed save never reports success and leaves the displayed state alone");
  assert.doesNotMatch(ui, /localStorage[^\n]*whatsapp_autonom/i, "the setting is never frontend-only state");
  assert.ok(ui.indexOf("await renderWhatsAppAutonomyPanel(outlet, token)") > ui.indexOf("async function renderSettingsView") && ui.indexOf("await renderWhatsAppAutonomyPanel(outlet, token)") < ui.indexOf("const syncSection", ui.indexOf("async function renderSettingsView")), "rendered inside Settings -> Integrations");
  console.log(JSON.stringify({ status: "PASS", suite: "whatsapp-autonomy-store-ui" }));
})().catch((error) => { console.error(error); process.exit(1); });
