// Intake receipts (file store, real server): simultaneous identical submissions are filed once; a key re-used for other content is refused;
// every outcome answers a scoped caller with the minimum; recovery codes are redeemable only by a signed-in staff member, are verified, and
// file at most once. The Postgres/PostgREST behaviour (atomic claim, interrupted CRM writes) is in test-intake-receipts-postgres.js.
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
const OTHER_KEY = `och_${crypto.randomBytes(24).toString("hex")}`;
const ADMIN = { email: "admin@fixture.test", password: `Adm!${crypto.randomBytes(8).toString("hex")}Aa1` };
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
let checks = 0;
const ok = (cond, msg, detail) => { checks += 1; assert.ok(cond, `${msg}${detail !== undefined ? " :: " + JSON.stringify(detail).slice(0, 600) : ""}`); };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-receipts-"));
  const port = await freePort();
  const env = {
    PATH: process.env.PATH, HOME: dir, NODE_ENV: "test",
    LEAD_AGENTS_HOST: "127.0.0.1", LEAD_AGENTS_PORT: String(port), LEAD_AGENTS_STORE_PATH: path.join(dir, "store.json"), OFFICE_STORAGE_DIR: path.join(dir, "storage"),
    LEAD_AGENTS_AUTH_MODE: "required_api_key", LEAD_AGENTS_API_KEYS: FULL_KEY, LEAD_AGENTS_SESSION_SECRET: crypto.randomBytes(24).toString("hex"),
    LEAD_AGENTS_SCOPED_API_KEYS: JSON.stringify([{ client: "getoyi", key_sha256: sha(SITE_KEY), scopes: ["intake.submit"] }, { client: "ochiga_website", key_sha256: sha(OTHER_KEY), scopes: ["intake.submit"] }]),
    LEAD_AGENTS_ADMIN_EMAIL: ADMIN.email, LEAD_AGENTS_ADMIN_PASSWORD: ADMIN.password, LEAD_AGENTS_ADMIN_ROLE: "super_admin",
    OPENAI_API_KEY: "sk-fixture-not-real", OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
    LEAD_AGENTS_RATE_LIMIT_MAX_REQUESTS: "100000", LEAD_AGENTS_OFFICE_RATE_LIMIT_MAX_REQUESTS: "100000", LEAD_AGENTS_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "1000",
  };
  const proc = spawn(process.execPath, ["lead-agents-server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = []; proc.stdout.on("data", (d) => logs.push(String(d))); proc.stderr.on("data", (d) => logs.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i += 1) {
    if (await fetch(url + "/healthz").catch(() => null)) return { url, dir, logs, stop: () => new Promise((r) => { proc.once("exit", r); proc.kill("SIGTERM"); }) };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start: " + logs.join("").slice(-800));
}

async function call(base, method, p, { key, body, cookie, form, accept, origin } = {}) {
  const headers = {};
  // a browser always sends Origin on a form POST; tests send the page's own origin unless they test the refusal
  if (method === "POST" && p.includes("/intake/recover") && origin !== null) headers.origin = origin || base;
  if (key) headers["x-api-key"] = key;
  if (cookie) headers.cookie = cookie;
  if (accept) headers.accept = accept;
  let payload;
  if (form !== undefined) { headers["content-type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(base + p, { method, headers, body: payload, redirect: "manual" });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text, setCookie: r.headers.getSetCookie ? r.headers.getSetCookie() : [] };
}

const envelope = (idem, email, message = "Need an Oyi deployment") => ({
  request_id: `req-${crypto.randomUUID()}`, idempotency_key: idem, source_channel: "website", source_site: "oyi_website", source_page: "/deployments",
  source_form: "oyi_deployment_request", business_unit: "technology", inquiry_type: "oyi_deployment_request",
  contact: { name: "Ada Test", email, phone: "" }, organization: { name: "Fixture Estate", location: "Lekki" }, payload: { message },
});

function recoveryCode(siteKey, env, issuedAt = new Date().toISOString()) {
  const body = Buffer.from(JSON.stringify({ envelope: env, issued_at: issuedAt })).toString("base64url");
  const sig = crypto.createHmac("sha256", sha(siteKey)).update(`v1.${body}`).digest("base64url");
  return `v1.${body}.${sig}`;
}

const ALLOWED_SCOPED_KEYS = new Set(["ok", "duplicate", "request_id", "idempotency_key", "lead_id", "crm_synced", "retryable", "error"]);
const minimalOnly = (json) => json && Object.keys(json).every((k) => ALLOWED_SCOPED_KEYS.has(k));

async function main() {
  const srv = await startServer();
  try {
    const base = srv.url;
    const state = () => JSON.parse(fs.readFileSync(path.join(srv.dir, "store.json"), "utf8"));

    // ---- simultaneous identical submissions
    const K = crypto.randomUUID();
    const same = envelope(K, "burst@example.com");
    const burst = await Promise.all(Array.from({ length: 12 }, () => call(base, "POST", "/api/office/intake", { key: SITE_KEY, body: { ...same, request_id: `req-${crypto.randomUUID()}` } })));
    const statuses = burst.map((r) => r.status);
    ok(statuses.filter((s) => s === 201).length === 1, "12 simultaneous identical submissions: exactly ONE is filed (201)", statuses);
    ok(statuses.every((s) => s === 201 || s === 200 || s === 409), "…the others answer duplicate (200) or in-progress (409, retryable)", statuses);
    ok(burst.filter((r) => r.status === 409).every((r) => r.json.error === "intake_in_progress" && r.json.retryable === true), "…in-progress answers say retryable", burst.filter((r) => r.status === 409).map((r) => r.json));
    ok(burst.every((r) => minimalOnly(r.json)), "…and every answer to the scoped caller is minimal", burst.map((r) => Object.keys(r.json || {})));
    let s1 = state();
    const key = `getoyi:${K}`;
    ok(s1.leads.filter((l) => l.email === "burst@example.com").length === 1, "…one Lead", s1.leads.length);
    ok(s1.timeline_events.filter((e) => e.event_type === "office_intake_received" && e.metadata.idempotency_key === key).length === 1, "…one intake timeline event");
    const burstLead = s1.leads.find((l) => l.email === "burst@example.com");
    ok((s1.crm_activities || []).filter((a) => a.lead_id === burstLead.id && a.activity_type === "website_intake_received").length === 1, "…one CRM activity", (s1.crm_activities || []).length);
    ok((s1.crm_opportunities || []).filter((a) => a.lead_id === burstLead.id).length === 1, "…one opportunity", (s1.crm_opportunities || []).length);
    ok(s1.office_intake_receipts[key] && s1.office_intake_receipts[key].status === "completed" && s1.office_intake_receipts[key].attempts === 1, "…and the receipt is completed after one attempt", s1.office_intake_receipts[key]);
    const after = await call(base, "POST", "/api/office/intake", { key: SITE_KEY, body: same });
    ok(after.status === 200 && after.json.duplicate === true, "a later retry is a duplicate", after.json);

    // ---- key re-used for different content
    const reuse = await call(base, "POST", "/api/office/intake", { key: SITE_KEY, body: envelope(K, "burst@example.com", "A DIFFERENT message under the same key") });
    ok(reuse.status === 409 && reuse.json.error === "idempotency_key_reused" && reuse.json.retryable === false, "the same key with different content is refused (409, not retryable), never merged", reuse.json);
    ok(minimalOnly(reuse.json), "…minimal answer", Object.keys(reuse.json || {}));

    // ---- reserved namespaces and oversized keys
    const reserved = await call(base, "POST", "/api/office/intake", { key: FULL_KEY, body: envelope(`getoyi:${K}`, "burst@example.com") });
    ok(reserved.status === 400 && reserved.json.error === "idempotency_key_reserved", "a full-key caller cannot use a website's key namespace (no collision or probing)", reserved.json);
    const longKey = `long-${"x".repeat(400)}`;
    const long1 = await call(base, "POST", "/api/office/intake", { key: FULL_KEY, body: envelope(longKey, "long@example.com") });
    const long2 = await call(base, "POST", "/api/office/intake", { key: FULL_KEY, body: envelope(longKey, "long@example.com") });
    ok(long1.status === 201 && long2.status === 200 && long2.json.duplicate === true, "a caller key longer than the receipt column is filed once and recognised on retry (hashed receipt key)", [long1.status, long2.status]);

    // ---- full keys keep their existing response shape
    const full = await call(base, "POST", "/api/office/intake", { key: FULL_KEY, body: envelope(crypto.randomUUID(), "full@example.com") });
    ok(full.status === 201 && full.json.lead && full.json.crm && full.json.crm.activity_id && full.json.conversation_continuation, "full-key callers still get the full response (lead, crm ids, continuation)", Object.keys(full.json || {}));

    // ---- recovery codes
    const login = await call(base, "POST", "/api/lead-agents/admin/session/login", { body: { email: ADMIN.email, password: ADMIN.password } });
    const cookie = (login.setCookie.find((c) => /^lead_agents_admin=/.test(c)) || "").split(";")[0];
    ok(login.status === 200 && cookie, "staff sign-in for the recovery tests", login.status);
    const R = crypto.randomUUID();
    const lost = envelope(R, "lost@example.com", "Submitted while Office was down");
    const code = recoveryCode(SITE_KEY, lost);
    const landing = await call(base, "GET", "/api/lead-agents/admin/intake/recover", { cookie });
    ok(landing.status === 200 && /location\.hash/.test(landing.text) && /name="action" value="preview"/.test(landing.text), "the link's landing page reads the code from the URL fragment (never sent to a server) into a preview POST", landing.status);
    const view = await call(base, "POST", "/api/lead-agents/admin/intake/recover", { cookie, form: { action: "preview", code } });
    ok(view.status === 200 && /File this website enquiry in Office\?/.test(view.text) && /lost@example\.com/.test(view.text) && /name="action" value="file"/.test(view.text), "a staff member sees what the code will file, with a confirm button", view.status);
    ok(state().leads.every((l) => l.email !== "lost@example.com"), "…and viewing alone files nothing");
    const filed = await call(base, "POST", "/api/lead-agents/admin/intake/recover", { cookie, form: { action: "file", code } });
    ok(filed.status === 200 && /The enquiry is now in Office\./.test(filed.text), "confirming files the enquiry", filed.text.slice(0, 200));
    const again = await call(base, "POST", "/api/lead-agents/admin/intake/recover", { cookie, form: { action: "file", code } });
    ok(/already in Office/.test(again.text), "redeeming the same code again files nothing new");
    const viaSite = await call(base, "POST", "/api/office/intake", { key: SITE_KEY, body: lost });
    ok(viaSite.status === 200 && viaSite.json.duplicate === true, "…and the website's own late retry of that submission is a duplicate (same namespace)", viaSite.json);
    const s2 = state();
    ok(s2.leads.filter((l) => l.email === "lost@example.com").length === 1 && s2.timeline_events.filter((e) => e.metadata && e.metadata.idempotency_key === `getoyi:${R}`).length === 1, "…one Lead and one intake event in total");
    ok((s2.audit_events || []).some((a) => a.action === "intake_recovered"), "recovery is audited");

    const forged = recoveryCode(`not-the-site-key-${crypto.randomBytes(8).toString("hex")}`, envelope(crypto.randomUUID(), "forged@example.com"));
    const f = await call(base, "POST", "/api/lead-agents/admin/intake/recover", { cookie, form: { action: "file", code: forged } });
    ok(f.status === 400 && /cannot be used/.test(f.text) && state().leads.every((l) => l.email !== "forged@example.com"), "a code not signed by a known website is refused and files nothing", f.status);
    const tampered = code.replace(/\.([A-Za-z0-9_-]+)\./, (m, b) => `.${b.slice(0, -2)}AA.`);
    ok((await call(base, "POST", "/api/lead-agents/admin/intake/recover", { cookie, form: { action: "file", code: tampered } })).status === 400, "a tampered code is refused");
    const old = recoveryCode(SITE_KEY, envelope(crypto.randomUUID(), "old@example.com"), new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString());
    ok(/older than 30 days/.test((await call(base, "POST", "/api/lead-agents/admin/intake/recover", { cookie, form: { action: "file", code: old } })).text), "a code older than 30 days is refused");
    const otherCode = recoveryCode(OTHER_KEY, envelope(R, "lost@example.com", "Submitted while Office was down"));
    await call(base, "POST", "/api/lead-agents/admin/intake/recover", { cookie, form: { action: "file", code: otherCode } });
    ok(state().office_intake_receipts[`ochiga_website:${R}`], "a code from another website is filed in THAT website's namespace");

    // credentials that must not redeem codes
    const byFull = await call(base, "POST", "/api/lead-agents/admin/intake/recover", { key: FULL_KEY, form: { action: "file", code } });
    ok(byFull.status === 403, "a full API key cannot redeem a recovery code (staff session only)", byFull.status);
    const bySite = await call(base, "POST", "/api/lead-agents/admin/intake/recover", { key: SITE_KEY, form: { action: "file", code } });
    ok(bySite.status === 403, "the website's scoped key cannot redeem one either", bySite.status);
    const anon = await call(base, "POST", "/api/lead-agents/admin/intake/recover", { form: { action: "file", code } });
    const crossSite = await call(base, "POST", "/api/lead-agents/admin/intake/recover", { cookie, origin: "https://www.ochiga.com.ng", form: { action: "file", code: recoveryCode(SITE_KEY, envelope(crypto.randomUUID(), "csrf@example.com")) } });
    ok(crossSite.status === 403 && state().leads.every((l) => l.email !== "csrf@example.com"), "a recovery POST from another origin (e.g. a sibling site sharing the cookie domain) is refused and files nothing", crossSite.status);
    const noOrigin = await call(base, "POST", "/api/lead-agents/admin/intake/recover", { cookie, origin: null, form: { action: "file", code: recoveryCode(SITE_KEY, envelope(crypto.randomUUID(), "noorigin@example.com")) } });
    ok(noOrigin.status === 403, "…and one without an Origin header too", noOrigin.status);
    const forwarded = await fetch(base + "/api/lead-agents/admin/intake/recover", { method: "POST", headers: { cookie, origin: "https://office.ochiga.com.ng", "x-forwarded-host": "office.ochiga.com.ng", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action: "preview", code }).toString() });
    ok(forwarded.status === 200, "…while the Office front end's own origin (forwarded host through the Vercel proxy) is accepted", forwarded.status);
    const previewFiles = await call(base, "POST", "/api/lead-agents/admin/intake/recover", { cookie, form: { action: "preview", code: recoveryCode(SITE_KEY, envelope(crypto.randomUUID(), "preview-only@example.com")) } });
    ok(previewFiles.status === 200 && state().leads.every((l) => l.email !== "preview-only@example.com"), "previewing a code files nothing");
    ok(anon.status === 401, "no credential: 401", anon.status);

    // nothing secret in the server log
    const logText = srv.logs.join("");
    ok(![FULL_KEY, SITE_KEY, OTHER_KEY, ADMIN.password, sha(SITE_KEY)].some((secret) => logText.includes(secret)), "no key, key digest or password appears in the server log");
  } finally {
    await srv.stop();
  }
  console.log(`intake receipts (file store): ${checks} checks passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
