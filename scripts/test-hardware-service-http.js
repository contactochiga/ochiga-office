"use strict";
// Phase 5C service-visit API boundary with a fake store and storage: flags, session, scopes per action, origin, input
// validation before the database, photo processing (metadata stripped), orphan cleanup and safe error mapping.
const assert = require("assert/strict"), http = require("http");
const sharp = require("sharp");
const { handleHardwareServiceRequest: handler } = require("../src/lead-agents/hardware-service-api");
const VISIT = "55555555-5555-4555-8555-555555555555";
let n = 0; const ok = (c, name) => { assert.ok(c, name); n++; console.log("PASS " + name); };
(async () => {
  let dbError = null; const calls = [], stored = new Map(), deleted = [], deletedFiles = [];
  const store = {
    client: {
      get: async (p) => { calls.push(["GET", p]); return { data: [] }; },
      post: async (p, body) => { calls.push(["POST", p, body]); if (dbError) { const e = new Error("db"); e.response = { data: dbError }; throw e; } return { data: { id: VISIT, state: "scheduled", service_address: { state: "Lagos", city: "Ikeja", address: "1 Street" } } }; },
    },
    createOfficeFile: async (raw) => ({ ...raw }),
    deleteOfficeFile: async (id) => { deletedFiles.push(id); return true; },
  };
  const storageService = {
    putBuffer: async (input) => { const filename = `${input.purpose}_x${stored.size}.webp`; stored.set(filename, input.buffer); return { id: filename.replace(".webp", ""), filename, storage_key: filename, purpose: input.purpose, resource_type: input.resource_type, resource_id: input.resource_id }; },
    deleteObject: async (f) => { deleted.push(f); stored.delete(f); return true; },
    getObject: async () => null,
  };
  const server = http.createServer(async (req, res) => {
    const scopes = (req.headers["x-test-scopes"] || "").split(",").filter(Boolean);
    const authContext = req.headers["x-test-auth"] === "key" ? { type: "api_key" } : { type: "session", role: "ochiga_staff", email: "Tech@Fixture.test", permissionScopes: scopes };
    if (!(await handler({ req, res, pathname: new URL(req.url, "http://x").pathname, authContext, store, storageService, config: { officeAppUrl: "https://office.example.invalid" } }))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/lead-agents/admin/hardware-service`;
  const SCHED = "commerce.orders.read,commerce.orders.service.schedule", PERF = "commerce.orders.read,commerce.orders.service.perform";
  const call = async (method, p, { scopes = SCHED, body, origin = "https://office.example.invalid", auth } = {}) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-test-scopes": scopes, ...(origin ? { origin } : {}), ...(auth ? { "x-test-auth": auth } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const slot = { technician: "Tech@Fixture.test", starts_at: "2026-11-02T10:00:00+01:00", ends_at: "2026-11-02T12:00:00+01:00" };
  try {
    process.env.OFFICE_HARDWARE_FULFILMENT_ENABLED = "true"; delete process.env.OFFICE_HARDWARE_SERVICE_ENABLED;
    ok((await call("GET", "/visits")).body.error === "service_disabled", "service flag off: 503");
    process.env.OFFICE_HARDWARE_SERVICE_ENABLED = "true"; delete process.env.OFFICE_HARDWARE_FULFILMENT_ENABLED;
    ok((await call("GET", "/visits")).body.error === "service_disabled", "fulfilment flag off also disables service visits");
    process.env.OFFICE_HARDWARE_FULFILMENT_ENABLED = "true";
    ok((await call("GET", "/visits", { auth: "key" })).body.error === "service_requires_staff_session", "API keys cannot use service visits");
    ok((await call("GET", "/visits", { scopes: "" })).status === 403, "reading needs commerce.orders.read");
    ok((await call("POST", `/visits/${VISIT}/schedule`, { scopes: PERF, body: { expected_row_version: 1, ...slot } })).status === 403, "scheduling needs service.schedule");
    ok((await call("POST", `/visits/${VISIT}/start`, { scopes: SCHED, body: { expected_row_version: 1 } })).status === 403, "performing needs service.perform");
    ok((await call("POST", `/technicians/${encodeURIComponent("a@b.test")}/hours`, { body: { expected_version: 0, windows: [], reason: "LOCAL reason" } })).status === 403, "working hours need service.configure");
    ok((await call("POST", `/visits/${VISIT}/schedule`, { body: { expected_row_version: 1, ...slot }, origin: "https://evil.example" })).body.error === "origin_not_allowed", "cross-origin write refused");
    ok((await call("POST", `/visits/${VISIT}/schedule`, { body: { expected_row_version: 0, ...slot } })).status === 400, "version 0 refused for an existing visit");
    ok((await call("POST", `/visits/${VISIT}/schedule`, { body: { expected_row_version: 1, ...slot, price_kobo: 5 } })).status === 400, "unknown fields refused");
    ok((await call("POST", `/visits/${VISIT}/schedule`, { body: { expected_row_version: 1, ...slot, starts_at: "2026-11-02 10:00" } })).body.error === "invalid_slot", "times must be ISO instants with an offset");
    ok((await call("POST", "/visits", { body: { kind: "inspection", service_address: { state: "Lagos", lat: 6.4 } } })).status === 400, "non-text address fields refused");
    calls.length = 0;
    await call("POST", `/visits/${VISIT}/schedule`, { body: { expected_row_version: 1, ...slot, note: " ok " } });
    const s = calls.find((c) => c[0] === "POST");
    ok(s[1] === "/rpc/hardware_service_schedule" && s[2].p_actor === "tech@fixture.test" && s[2].p_visit === VISIT && s[2].p_technician === "tech@fixture.test" && s[2].p_note === "ok", "schedule calls the database function with normalized actor and technician");
    const viewer = await call("GET", `/visits/${VISIT}`, { scopes: "commerce.orders.read" });
    ok(viewer.body.error === "visit_not_found", "unknown visit is not found");
    calls.length = 0;
    const created = await call("POST", "/visits", { body: { kind: "inspection", contact_id: VISIT, service_address: { country: "NG", state: " Lagos ", city: "Ikeja", address: "1 Street", landmark: "" } } });
    const c = calls.find((x) => x[0] === "POST");
    ok(created.status === 201 && c[2].p_address.state === "Lagos" && !("landmark" in c[2].p_address), "request trims the address and drops empty fields");
    // Photograph processing and orphan cleanup.
    const jpeg = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#369" } }).jpeg().withExif({ IFD0: { Copyright: "SECRET-SITE-MARKER" } }).toBuffer();
    const body = { expected_row_version: 3, kind: "installation_photo", data_url: "data:image/jpeg;base64," + jpeg.toString("base64") };
    ok((await call("POST", `/visits/${VISIT}/evidence`, { scopes: SCHED, body })).status === 403, "evidence upload needs service.perform");
    ok((await call("POST", `/visits/${VISIT}/evidence`, { scopes: PERF, body })).status === 201, "photograph accepted");
    const saved = [...stored.values()][0], meta = await sharp(saved).metadata();
    ok(meta.format === "webp" && !meta.exif && !saved.includes(Buffer.from("SECRET-SITE-MARKER")), "stored bytes are re-encoded WebP without EXIF");
    const putPurpose = [...stored.keys()][0];
    ok(putPurpose.startsWith("service_visit_photo_"), "stored with the service_visit_photo purpose");
    dbError = { code: "PT409", message: "duplicate_evidence" };
    const before = stored.size;
    const dup = await call("POST", `/visits/${VISIT}/evidence`, { scopes: PERF, body });
    ok(dup.status === 409 && dup.body.error === "duplicate_evidence" && stored.size === before && deleted.length === 1 && deletedFiles.length === 1, "refused registration removes the stored object and file record");
    ok((await call("POST", `/visits/${VISIT}/evidence`, { scopes: PERF, body: { ...body, kind: "selfie" } })).body.error === "invalid_evidence", "unknown evidence kind refused");
    dbError = { code: "XX000", message: "internal detail with secrets" };
    const hidden = await call("POST", `/visits/${VISIT}/start`, { scopes: PERF, body: { expected_row_version: 2 } });
    ok(hidden.status === 500 && hidden.body.error === "service_operation_failed" && !JSON.stringify(hidden.body).includes("secrets"), "unexpected database errors are not leaked");
    dbError = { code: "PGRST202", message: "x" };
    ok((await call("POST", `/visits/${VISIT}/start`, { scopes: PERF, body: { expected_row_version: 2 } })).body.error === "service_unavailable", "missing migration reported as unavailable");
    console.log(JSON.stringify({ suite: "hardware-service-http", passed: n }));
  } finally { server.close(); }
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
