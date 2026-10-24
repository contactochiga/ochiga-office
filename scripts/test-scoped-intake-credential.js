// GetOyi Phase 0: a scoped website credential can submit intake and nothing else; retried submissions are recognised for EVERY
// enquiry (not only a contact's first); full keys and staff behaviour are unchanged. Real server, temporary file store.
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const FULL_KEY = `full_${crypto.randomBytes(12).toString("hex")}`;
const SITE_KEY = `oyi_${crypto.randomBytes(24).toString("hex")}`;
const OTHER_SITE_KEY = `och_${crypto.randomBytes(24).toString("hex")}`;
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
let checks = 0;
const ok = (cond, msg, detail) => { checks += 1; assert.ok(cond, `${msg}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`); };

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

async function startServer(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-intake-"));
  const port = await freePort();
  const env = {
    PATH: process.env.PATH, HOME: dir, NODE_ENV: "test",
    LEAD_AGENTS_HOST: "127.0.0.1", LEAD_AGENTS_PORT: String(port), LEAD_AGENTS_STORE_PATH: path.join(dir, "store.json"), OFFICE_STORAGE_DIR: path.join(dir, "storage"),
    LEAD_AGENTS_AUTH_MODE: "required_api_key", LEAD_AGENTS_API_KEYS: FULL_KEY, LEAD_AGENTS_SESSION_SECRET: crypto.randomBytes(24).toString("hex"),
    OPENAI_API_KEY: "sk-fixture-not-real", OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
    LEAD_AGENTS_RATE_LIMIT_MAX_REQUESTS: "100000", LEAD_AGENTS_OFFICE_RATE_LIMIT_MAX_REQUESTS: "100000",
    ...extraEnv,
  };
  const proc = spawn(process.execPath, ["lead-agents-server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = []; proc.stdout.on("data", (d) => logs.push(String(d))); proc.stderr.on("data", (d) => logs.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i += 1) {
    const r = await fetch(url + "/healthz").catch(() => null);
    if (r) return { url, proc, logs, dir, stop: () => new Promise((res) => { proc.once("exit", res); proc.kill("SIGTERM"); }) };
    await new Promise((r2) => setTimeout(r2, 100));
  }
  throw new Error("server did not start: " + logs.join("").slice(-800));
}

async function call(base, method, p, { key, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (key) headers["x-api-key"] = key;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

const envelope = (idem, email, message = "Need an Oyi deployment") => ({
  request_id: `req-${crypto.randomUUID()}`, idempotency_key: idem, source_channel: "website", source_site: "oyi_website", source_page: "/contact",
  source_form: "oyi_general_enquiry", business_unit: "technology", inquiry_type: "oyi_general_enquiry",
  contact: { name: "Ada Test", email, phone: "" }, organization: { name: "Fixture Estate", location: "" }, payload: { message },
});

async function main() {
  const scoped = JSON.stringify([
    { client: "getoyi", key_sha256: sha(SITE_KEY), scopes: ["intake.submit"] },
    { client: "ochiga_website", key_sha256: sha(OTHER_SITE_KEY), scopes: ["intake.submit"] },
  ]);
  const srv = await startServer({ LEAD_AGENTS_SCOPED_API_KEYS: scoped });
  try {
    const base = srv.url;
    // ---- the scoped key submits intake
    const k1 = crypto.randomUUID();
    const first = await call(base, "POST", "/api/office/intake", { key: SITE_KEY, body: envelope(k1, "ada@example.com") });
    ok(first.status === 201, "scoped key: a new enquiry is filed (201)", first.status);
    ok(first.json && first.json.lead_id && first.json.duplicate === false, "…and the answer carries the lead id", first.json);
    ok(first.json && first.json.lead === undefined && first.json.crm === undefined && first.json.conversation_continuation === undefined, "…but never the stored Lead record or CRM internals", Object.keys(first.json || {}));
    ok(first.json.idempotency_key === `getoyi:${k1}`, "…and the key is namespaced to the client", first.json.idempotency_key);

    const retry = await call(base, "POST", "/api/office/intake", { key: SITE_KEY, body: envelope(k1, "ada@example.com") });
    ok(retry.status === 200 && retry.json.duplicate === true && retry.json.lead_id === first.json.lead_id, "a retried submission (same key) is recognised as a duplicate", retry.json);
    ok(retry.json.lead === undefined, "…and still returns no Lead record", Object.keys(retry.json || {}));

    // ---- the previously broken case: a SECOND enquiry from the same contact, retried
    const k2 = crypto.randomUUID();
    const second = await call(base, "POST", "/api/office/intake", { key: SITE_KEY, body: envelope(k2, "ada@example.com", "Second, different enquiry") });
    ok(second.status === 201 && second.json.lead_id === first.json.lead_id, "a second enquiry from the same contact folds into the same Lead (201)", second.json);
    const secondRetry = await call(base, "POST", "/api/office/intake", { key: SITE_KEY, body: envelope(k2, "ada@example.com", "Second, different enquiry") });
    ok(secondRetry.status === 200 && secondRetry.json.duplicate === true, "…and a RETRY of that second enquiry is now recognised (was filed twice before)", secondRetry.json);

    // ---- namespaces: the same raw key from another scoped client is a different submission
    const other = await call(base, "POST", "/api/office/intake", { key: OTHER_SITE_KEY, body: envelope(k1, "other@example.com") });
    ok(other.status === 201 && other.json.idempotency_key === `ochiga_website:${k1}`, "another scoped client's identical raw key does not collide", other.json);

    // ---- nothing else is reachable with the scoped key
    const denied = [
      ["GET", "/api/lead-agents/admin/leads"], ["GET", "/api/lead-agents/admin/users"], ["GET", "/api/lead-agents/admin/settings"],
      ["GET", "/api/lead-agents/admin/crm/opportunities"], ["POST", "/api/lead-agents/admin/crm/contacts"], ["GET", "/api/lead-agents/leads"],
      ["GET", "/api/office/intake"], ["POST", "/api/lead-agents/admin/documents/generate"], ["GET", "/api/lead-agents/admin/knowledge-pack"],
      ["POST", "/api/lead-agents/admin/communications/whatsapp/send"], ["POST", "/api/lead-agents/admin/recipients/resolve"],
    ];
    for (const [m, p] of denied) {
      const r = await call(base, m, p, { key: SITE_KEY, body: m === "POST" ? {} : undefined });
      ok(r.status === 401 || r.status === 403, `scoped key is refused on ${m} ${p}`, r.status);
    }

    // ---- unchanged behaviour for everyone else
    const bad = await call(base, "POST", "/api/office/intake", { key: "not-a-key", body: envelope(crypto.randomUUID(), "x@example.com") });
    ok(bad.status === 401, "an unknown key is refused (401)", bad.status);
    const none = await call(base, "POST", "/api/office/intake", { body: envelope(crypto.randomUUID(), "x@example.com") });
    ok(none.status === 401, "no key is refused (401)", none.status);
    const full = await call(base, "POST", "/api/office/intake", { key: FULL_KEY, body: envelope(crypto.randomUUID(), "full@example.com") });
    ok(full.status === 201 && full.json.lead && full.json.lead.id, "a full key still files intake with the existing full response", full.status);
    const fullRetry = await call(base, "POST", "/api/office/intake", { key: FULL_KEY, body: { ...envelope(full.json.idempotency_key, "full@example.com") } });
    ok(fullRetry.status === 200 && fullRetry.json.duplicate === true, "…and full-key retries are recognised as before", fullRetry.status);
    const users = await call(base, "GET", "/api/lead-agents/admin/users", { key: FULL_KEY });
    ok(users.status === 200, "a full key keeps its existing admin access (unchanged in this patch)", users.status);

    // ---- the store holds exactly what was submitted (no duplicate lead, one intake event per key)
    const store = JSON.parse(fs.readFileSync(path.join(srv.dir, "store.json"), "utf8"));
    const events = store.timeline_events.filter((e) => e.event_type === "office_intake_received");
    const perKey = events.reduce((m, e) => { const k = e.metadata && e.metadata.idempotency_key; m[k] = (m[k] || 0) + 1; return m; }, {});
    ok(Object.values(perKey).every((n) => n === 1), "every idempotency key produced exactly one intake event", perKey);
    ok(store.leads.filter((l) => l.email === "ada@example.com").length === 1, "one Lead for the repeat contact", store.leads.length);
  } finally {
    await srv.stop();
  }

  // ---- a malformed scoped configuration is ignored, never widened
  const srv2 = await startServer({ LEAD_AGENTS_SCOPED_API_KEYS: "{not json" });
  try {
    const r = await call(srv2.url, "POST", "/api/office/intake", { key: SITE_KEY, body: envelope(crypto.randomUUID(), "y@example.com") });
    ok(r.status === 401, "with a malformed scoped-key setting the website key is simply not accepted (401)", r.status);
  } finally { await srv2.stop(); }
  const srv3 = await startServer({ LEAD_AGENTS_SCOPED_API_KEYS: JSON.stringify([{ client: "getoyi", key_sha256: sha(SITE_KEY), scopes: ["admin", "crm.manage"] }]) });
  try {
    const r = await call(srv3.url, "GET", "/api/lead-agents/admin/leads", { key: SITE_KEY });
    ok(r.status === 401, "an entry naming unknown scopes is dropped (no scope can be invented through configuration)", r.status);
  } finally { await srv3.stop(); }

  console.log(`scoped intake credential: ${checks} checks passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
