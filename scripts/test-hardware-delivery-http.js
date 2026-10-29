"use strict";
// Phase 5B delivery API boundary with a fake store and storage: flags, session, scope, origin, input validation,
// proof processing (metadata stripped), orphan cleanup when registration is refused, and safe error mapping.
const assert = require("assert/strict"), http = require("http");
const sharp = require("sharp");
const { handleHardwareDeliveryRequest: handler } = require("../src/lead-agents/hardware-delivery-api");
const ORDER = "44444444-4444-4444-8444-444444444444";
let n = 0; const ok = (c, name) => { assert.ok(c, name); n++; console.log("PASS " + name); };
(async () => {
  let dbError = null; const calls = [], stored = new Map(), deleted = [], deletedFiles = [];
  const store = {
    client: {
      get: async (p) => { calls.push(["GET", p]); return { data: [] }; },
      post: async (p, body) => { calls.push(["POST", p, body]); if (dbError) { const e = new Error("db"); e.response = { data: dbError }; throw e; } return { data: { ok: true } }; },
    },
    createOfficeFile: async (raw) => ({ ...raw }),
    deleteOfficeFile: async (id) => { deletedFiles.push(id); return true; },
  };
  const storageService = {
    putBuffer: async (input) => { const filename = `${input.purpose}_x${stored.size}.webp`; stored.set(filename, input.buffer); return { id: filename.replace(".webp", ""), filename, storage_key: filename, purpose: input.purpose, resource_id: input.resource_id }; },
    deleteObject: async (f) => { deleted.push(f); stored.delete(f); return true; },
    getObject: async () => null,
  };
  const server = http.createServer(async (req, res) => {
    const scopes = (req.headers["x-test-scopes"] || "").split(",").filter(Boolean);
    const authContext = req.headers["x-test-auth"] === "key" ? { type: "api_key" } : { type: "session", role: "ochiga_staff", email: "Courier@Fixture.test", permissionScopes: scopes };
    if (!(await handler({ req, res, pathname: new URL(req.url, "http://x").pathname, authContext, store, storageService, config: { officeAppUrl: "https://office.example.invalid" } }))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/lead-agents/admin/hardware-delivery/${ORDER}`;
  const MANAGE = "commerce.orders.read,commerce.orders.delivery.manage";
  const call = async (method, p, { scopes = MANAGE, body, origin = "https://office.example.invalid", auth } = {}) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-test-scopes": scopes, ...(origin ? { origin } : {}), ...(auth ? { "x-test-auth": auth } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    process.env.OFFICE_HARDWARE_FULFILMENT_ENABLED = "true"; delete process.env.OFFICE_HARDWARE_DELIVERY_ENABLED;
    ok((await call("GET", "")).body.error === "delivery_disabled", "delivery flag off: 503");
    process.env.OFFICE_HARDWARE_DELIVERY_ENABLED = "true"; delete process.env.OFFICE_HARDWARE_FULFILMENT_ENABLED;
    ok((await call("GET", "")).body.error === "delivery_disabled", "fulfilment flag off also disables delivery");
    process.env.OFFICE_HARDWARE_FULFILMENT_ENABLED = "true";
    ok((await call("GET", "", { auth: "key" })).body.error === "delivery_requires_staff_session", "full API key cannot use delivery");
    ok((await call("POST", "/dispatch", { scopes: "commerce.orders.read", body: { expected_row_version: 1 } })).status === 403, "dispatch needs delivery.manage");
    ok((await call("POST", "/dispatch", { body: { expected_row_version: 1 }, origin: "https://evil.example" })).body.error === "origin_not_allowed", "cross-origin write refused");
    ok((await call("POST", "/dispatch", { body: { expected_row_version: -1 } })).status === 400, "negative version refused");
    ok((await call("POST", "/schedule", { body: { expected_row_version: 0, method: "own_fleet", payment_state: "paid" } })).status === 400, "unknown fields refused");
    ok((await call("POST", "/reschedule", { body: { expected_row_version: 1, scheduled_for: "tomorrow" } })).body.error === "invalid_delivery_date", "date format checked before the database");
    calls.length = 0;
    await call("POST", "/schedule", { body: { expected_row_version: 0, method: " own_fleet ", instructions: "Gate" } });
    const s = calls.find((c) => c[0] === "POST");
    ok(s[1] === "/rpc/hardware_delivery_schedule" && s[2].p_actor === "courier@fixture.test" && s[2].p_order === ORDER && s[2].p_details.method === "own_fleet", "schedule calls the database function with normalized actor and trimmed details");
    // Proof processing and orphan cleanup.
    const jpeg = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#963" } }).jpeg().withExif({ IFD0: { Copyright: "SECRET-LOCATION-MARKER" } }).toBuffer();
    const body = { expected_row_version: 2, kind: "photo", data_url: "data:image/jpeg;base64," + jpeg.toString("base64") };
    ok((await call("POST", "/proofs", { body })).status === 201, "proof accepted");
    const saved = [...stored.values()][0];
    const meta = await sharp(saved).metadata();
    ok(meta.format === "webp" && !meta.exif && !saved.includes(Buffer.from("SECRET-LOCATION-MARKER")), "stored bytes are re-encoded WebP without EXIF");
    dbError = { code: "PT409", message: "duplicate_proof" };
    const before = stored.size;
    const r = await call("POST", "/proofs", { body });
    ok(r.body.error === "duplicate_proof" && stored.size === before && deleted.length === 1 && deletedFiles.length === 1, "refused registration deletes the stored object and the file record");
    dbError = { code: "XX000", message: "secret sql detail" };
    const leak = await call("POST", "/dispatch", { body: { expected_row_version: 1 } });
    ok(leak.status === 500 && !JSON.stringify(leak.body).includes("secret"), "unexpected errors never leak detail");
    dbError = null;
    ok((await call("POST", "/proofs", { body: { ...body, data_url: "data:text/plain;base64,aGVsbG8=" } })).body.error === "invalid_proof", "non-image data URL refused before processing");
    ok((await call("POST", "/proofs", { body: { ...body, kind: "video" } })).body.error === "invalid_proof", "unknown proof kind refused");
    ok((await call("GET", "/proofs/not-a-uuid")).status === 404, "malformed proof id 404");
    ok((await call("GET", "/proofs/55555555-5555-4555-8555-555555555555", { scopes: "commerce.orders.read" })).status === 403, "proof view needs delivery.manage or customer.read");
    ok((await call("POST", "/teleport", { body: {} })).status === 404, "unknown action 404");
    console.log(JSON.stringify({ suite: "hardware-delivery-http", passed: n, failed: 0 }));
  } catch (e) { console.error("FAIL", e.message); process.exitCode = 1; } finally { server.close(); }
})();
